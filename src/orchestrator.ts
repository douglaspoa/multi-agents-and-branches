import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoordinationBus } from "./bus.ts";
import { GitService } from "./git.ts";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";
import { buildReview } from "./review.ts";
import { run } from "./util/run.ts";
import { notify } from "./util/notify.ts";
import { taskToYaml } from "./util/yaml.ts";
import { MockEngine } from "./engine/mock.ts";
import { ClaudeEngine } from "./engine/claude.ts";
import type { AgentEngine } from "./engine/types.ts";
import type { AgentRole, AgentStatus, Role, TaskRow, TaskSpec } from "./types.ts";

/**
 * O "maestro": cria a worktree, escreve o TASK.yaml, reivindica o escopo e roda
 * a EQUIPE da tarefa (planner → builder → reviewer) em sequência na mesma
 * worktree, persistindo cada evento no SQLite. Ao final, monta o review humano
 * a partir do diff real.
 */
/** Nome da branch pela convenção: <tipo>/<CÓDIGO->-<slug>. Sem tipo → agent/ (retrocompat). */
export function branchName(spec: TaskSpec): string {
  const type = (spec.branchType || "agent").replace(/[^a-z0-9]/gi, "").toLowerCase() || "agent";
  const code = spec.issueCode ? spec.issueCode.trim().toUpperCase().replace(/\s+/g, "-") + "-" : "";
  return `${type}/${code}${spec.id}`;
}

export class Orchestrator {
  ws: Workspace;
  git: GitService;
  store: Store;
  bus: CoordinationBus;

  constructor(repo: string) {
    this.ws = new Workspace(repo);
    this.ws.ensure();
    this.git = new GitService(repo);
    this.store = new Store(this.ws.dbFile);
    this.bus = new CoordinationBus(this.store);
  }

  private engineFor(name: string, model: string | undefined, approval: TaskSpec["autonomy"]["approval"]): AgentEngine {
    if (name === "claude") return new ClaudeEngine({ model, approval });
    return new MockEngine();
  }

  private statusFor(role: Role): AgentStatus {
    if (role === "planner" || role === "investigator") return "thinking";
    if (role === "reviewer") return "review";
    return "running";
  }

  async createTask(spec: TaskSpec, refSources: string[] = []): Promise<TaskRow> {
    // Garante a equipe (retrocompat: 1 builder).
    if (!spec.roles || spec.roles.length === 0) {
      spec.roles = [{ role: "builder", name: spec.agent, engine: spec.engine, model: spec.model }];
    }

    const branch = branchName(spec);
    const worktree = this.ws.worktreePath(spec.id);
    // Novas tarefas nascem da main (default do repo), não da branch em check-out
    // — a não ser que uma base explícita seja passada em spec.base.
    const base = spec.base && spec.base.trim() ? spec.base.trim() : await this.git.defaultBase();

    // A pasta do Constellation nunca deve entrar no repo do usuário.
    await this.git.ensureExcluded([".cardume/", ".constellation/"]);
    await this.git.worktreeAdd(worktree, branch, base);

    const taskDir = join(worktree, ".cardume");
    await mkdir(taskDir, { recursive: true });

    // Copia os documentos de referência anexados para .cardume/refs/.
    if (refSources.length) {
      const refDir = join(taskDir, "refs");
      await mkdir(refDir, { recursive: true });
      const names: string[] = [];
      for (const src of refSources) {
        try {
          const name = src.split("/").pop() || "ref";
          await cp(src, join(refDir, name), { recursive: true });
          names.push(name);
        } catch { /* ignora arquivo inacessível */ }
      }
      spec.refs = names;
    }
    await writeFile(join(taskDir, "TASK.yaml"), taskToYaml(spec), "utf8");

    this.store.createTask(spec, branch, worktree, base);
    this.store.addEvent(spec.id, spec.agent, "status", `worktree criada em ${branch}`, true);

    for (const path of spec.scope.owns) {
      this.bus.claim(spec.id, spec.agent, path, "write");
    }

    return this.store.getTask(spec.id)!;
  }

  /** Roda a equipe da tarefa: cada papel em sequência, na mesma worktree. */
  async runTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const roles = spec.roles.length ? spec.roles : [{ role: "builder" as Role, name: spec.agent, engine: spec.engine }];
    const startIdx = task.done_roles ?? 0; // retoma de onde parou (ex.: após aprovar o plano)

    for (let i = startIdx; i < roles.length; i++) {
      const r = roles[i];
      this.store.setStage(taskId, r.role);
      this.store.setStatus(taskId, this.statusFor(r.role));
      const engine = this.engineFor(r.engine, r.model, spec.autonomy.approval);
      const persona = r.persona ? `## Seu perfil (${r.name} · ${r.role})\n${r.persona}\n\n` : "";
      const ctx = persona + this.bus.buildContext(spec);
      let sessionId = "";
      let roleFailed = false; // erro/timeout no papel → NÃO avança pro próximo

      try {
        for await (const ev of engine.run({
          cwd: task.worktree,
          spec,
          systemContext: ctx,
          role: r.role,
          agentName: r.name,
          dbFile: this.ws.dbFile,
        })) {
          if (ev.type === "session") {
            sessionId = ev.text;
            this.store.setSession(taskId, sessionId);
            continue;
          }
          if (ev.type === "claim" && ev.path) {
            this.bus.claim(taskId, r.name, ev.path, ev.mode ?? "write");
            continue;
          }
          if (ev.type === "error") roleFailed = true;
          this.store.addEvent(taskId, r.name, ev.type, ev.text, ev.ok, r.role);
          if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
            this.store.addCost(taskId, r.name, r.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
          }
          if (ev.status) this.store.setStatus(taskId, ev.status as AgentStatus);
        }
      } catch (err) {
        this.store.addEvent(taskId, r.name, "error", (err as Error).message, false, r.role);
        this.store.setStatus(taskId, "error");
        notify("Cardume", "Tarefa falhou — veja o log", task.title);
        return;
      }

      // Se o papel FALHOU (timeout/erro), PARA aqui — não avança pro próximo
      // (antes o pipeline seguia pro review mesmo sem o builder ter implementado).
      if (roleFailed) {
        this.store.setStatus(taskId, "error");
        this.store.addEvent(
          taskId,
          r.name,
          "note",
          `pipeline parado: o papel ${r.role} não concluiu (timeout/erro). Reveja e mande "pedir ajuste"/rework pra continuar.`,
          false,
          r.role,
        );
        notify("Constellation", `${r.name} não concluiu — veja o log`, task.title);
        return;
      }

      // Instruções que o humano enviou durante o turno → aplica agora (resume).
      sessionId = await this.applyInstructions(taskId, task.worktree, spec, r, ctx, sessionId);

      // Commita o que sobrou solto (o agente pode ter commitado sozinho) e
      // sempre recalcula o diff da branch vs base — assim o diff aparece mesmo
      // quando foi o próprio agente que fez o commit.
      if (r.role !== "reviewer") {
        try {
          await this.git.commitAll(task.worktree, `cardume(${r.role}): ${task.title}`);
          const d = await this.git.diffStat(task.worktree, task.base);
          this.store.setDiff(taskId, d.files, d.add, d.del);
          // Tarefas via Claude já geram o resumo do commit no fluxo (fica em cache).
          const usesClaude = spec.roles.some((x) => x.engine === "claude") || spec.engine === "claude";
          if (usesClaude && process.env.CARDUME_AUTOSUMMARY !== "0") {
            const head = await this.git.headHash(task.worktree);
            if (!this.store.hasCommitSummary(head)) await this.summarizeCommit(taskId, head, task.worktree, spec);
          }
        } catch (err) {
          this.store.addEvent(taskId, r.name, "note", `falha ao finalizar: ${(err as Error).message}`, false, r.role);
        }
      }

      // O reviewer monta o review FATUAL a partir do diff real.
      if (r.role === "reviewer") {
        try {
          const diff = await this.git.diffText(task.worktree, task.base);
          const review = buildReview(diff, r.name);
          this.store.addReview(taskId, review);
          this.store.addEvent(taskId, r.name, "note", `review pronto: ${review.summary}`, true, "reviewer");
        } catch (err) {
          this.store.addEvent(taskId, r.name, "note", `falha no review: ${(err as Error).message}`, false, r.role);
        }
      }

      this.store.setDoneRoles(taskId, i + 1);

      // Se o agente de issues criou uma issue (ex.: FND-853), renomeia a branch
      // pra convenção <tipo>/<CÓDIGO>-<slug> (ex.: agent/... → feat/FND-853-...).
      if (r.role === "planner") await this.maybeRenameBranchFromIssue(taskId, task, spec);

      // GATE do plano: se acabou o planner e o humano quer aprovar antes,
      // pausa aqui. A UI mostra o plano (editável) e o botão "aprovar e continuar".
      if (r.role === "planner" && spec.autonomy.planApproval === "review" && i < roles.length - 1) {
        this.store.setStatus(taskId, "plan-review");
        this.store.addEvent(taskId, r.name, "note", "plano pronto — aguardando sua aprovação para continuar", true);
        notify("Constellation", "Plano pronto para sua aprovação", task.title);
        return;
      }
    }

    await this.collectArtifacts(taskId, task.worktree, spec.agent);

    this.store.releaseClaims(taskId); // terminou de editar → libera os caminhos
    this.store.setStatus(taskId, "review");
    const usesClaude = spec.roles.some((x) => x.engine === "claude") || spec.engine === "claude";
    if (usesClaude) notify("Cardume", "Pronta para review ✓", task.title);
  }

  /**
   * REVIEW DE PR: revisa um Pull Request por link/número, SEM criar branch nem
   * worktree. Busca o diff via `gh pr diff`, roda o(s) revisor(es) numa pasta
   * isolada (.cardume/reviews/<id>/) e monta o review factual do diff do PR.
   * Reaproveita toda a máquina de streaming/custo/pause-abort das tarefas.
   */
  async reviewPr(spec: TaskSpec, pr: string): Promise<void> {
    const repo = this.git.repo;
    let meta: { number?: number; title?: string; url?: string; baseRefName?: string } = {};
    try {
      const { stdout } = await run("gh", ["pr", "view", pr, "--json", "number,title,url,baseRefName"], { cwd: repo });
      meta = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`não consegui ler o PR (${pr}). Confirme o link/número e o gh autenticado.\n${(e as Error).message}`);
    }
    let diff = "";
    try {
      diff = (await run("gh", ["pr", "diff", pr], { cwd: repo })).stdout;
    } catch (e) {
      throw new Error(`gh pr diff falhou: ${(e as Error).message}`);
    }
    if (!diff.trim()) throw new Error("o PR não tem diff (vazio?).");

    const number = meta.number ?? 0;
    const base = meta.baseRefName || "main";
    // pasta de trabalho isolada — nada de branch/worktree do git
    const dir = join(repo, ".cardume", "reviews", spec.id);
    await mkdir(join(dir, ".cardume"), { recursive: true });
    await this.git.ensureExcluded([".cardume/", ".constellation/"]);
    await writeFile(join(dir, "DIFF.patch"), diff, "utf8");

    spec.kind = "review";
    spec.prUrl = meta.url || pr;
    spec.prNumber = number || undefined;
    spec.title = spec.title || (number ? `Review PR #${number}` : "Review de PR") + (meta.title ? ` — ${meta.title}` : "");
    spec.objective = spec.objective || `Revisar ${number ? `o PR #${number}` : "o PR"}: ${meta.title ?? spec.prUrl}`;
    await writeFile(join(dir, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");

    const branch = number ? `PR #${number}` : "PR";
    this.store.createTask(spec, branch, dir, base);
    const lines = diff.split("\n").length;
    this.store.addEvent(spec.id, spec.agent, "status", `review do ${branch} — ${lines} linhas de diff`, true);

    const roles = spec.roles.length ? spec.roles : [{ role: "reviewer" as Role, name: spec.agent, engine: spec.engine }];
    for (let i = 0; i < roles.length; i++) {
      const r = roles[i];
      this.store.setStage(spec.id, r.role);
      this.store.setStatus(spec.id, "running");
      const engine = this.engineFor(r.engine, r.model, spec.autonomy.approval);
      const persona = r.persona ? `## Seu perfil (${r.name} · ${r.role})\n${r.persona}\n\n` : "";
      const ctx = persona + this.bus.buildContext(spec);
      try {
        for await (const ev of engine.run({ cwd: dir, spec, systemContext: ctx, role: r.role, agentName: r.name, dbFile: this.ws.dbFile })) {
          if (ev.type === "session") { this.store.setSession(spec.id, ev.text); continue; }
          if (ev.type === "claim") continue; // sem repo pra reivindicar num review de PR
          this.store.addEvent(spec.id, r.name, ev.type, ev.text, ev.ok, r.role);
          if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
            this.store.addCost(spec.id, r.name, r.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
          }
        }
      } catch (err) {
        this.store.addEvent(spec.id, r.name, "error", (err as Error).message, false, r.role);
        this.store.setStatus(spec.id, "error");
        return;
      }
      this.store.setDoneRoles(spec.id, i + 1);
    }

    // review FATUAL a partir do diff do PR (mesma função das tarefas normais)
    try {
      const review = buildReview(diff, spec.agent);
      this.store.addReview(spec.id, review);
      this.store.addEvent(spec.id, spec.agent, "note", `review pronto: ${review.summary}`, true, "reviewer");
    } catch (err) {
      this.store.addEvent(spec.id, spec.agent, "note", `falha no review factual: ${(err as Error).message}`, false, "reviewer");
    }
    this.store.setStatus(spec.id, "review");
    notify("Constellation", "Review do PR pronto ✓", spec.title);
  }

  /**
   * Aplica instruções que o humano enfileirou durante o turno do agente,
   * continuando a MESMA sessão do Claude (--resume) quando possível.
   * Retorna o sessionId (pode mudar a cada turno).
   */
  private async applyInstructions(
    taskId: string,
    worktree: string,
    spec: TaskSpec,
    role: { role: Role; name: string; engine: string; model?: string; persona?: string },
    ctx: string,
    sessionId: string
  ): Promise<string> {
    if (role.engine !== "claude") return sessionId; // mock não continua sessão
    let guard = 0;
    while (guard++ < 20) {
      const open = this.store.openInstructions(taskId);
      if (!open.length) break;
      this.store.addEvent(taskId, role.name, "note", `aplicando ${open.length} instrução(ões) enviada(s) por você`, true, role.role);
      this.store.setStatus(taskId, "running");
      const engine = this.engineFor(role.engine, role.model, spec.autonomy.approval);
      const instruction =
        `O humano enviou instruções adicionais no meio da execução — talvez tenha lembrado de algo. ` +
        `Incorpore-as agora, continuando de onde parou:\n${open.map((i) => `- ${i.text}`).join("\n")}`;
      try {
        for await (const ev of engine.run({
          cwd: worktree,
          spec,
          systemContext: ctx,
          role: role.role,
          agentName: role.name,
          dbFile: this.ws.dbFile,
          resume: { sessionId, instruction },
        })) {
          if (ev.type === "session") {
            sessionId = ev.text;
            this.store.setSession(taskId, sessionId);
            continue;
          }
          if (ev.type === "claim" && ev.path) {
            this.bus.claim(taskId, role.name, ev.path, ev.mode ?? "write");
            continue;
          }
          this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role);
          if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
            this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
          }
          if (ev.status) this.store.setStatus(taskId, ev.status as AgentStatus);
        }
      } catch (err) {
        this.store.addEvent(taskId, role.name, "error", `falha ao aplicar instrução: ${(err as Error).message}`, false, role.role);
      }
      for (const i of open) this.store.markInstructionApplied(i.id);
    }
    return sessionId;
  }

  /**
   * Copia os artefatos gerados na worktree (.cardume/artifacts/) para um lugar
   * estável (<repo>/.cardume/artifacts/<taskId>/) — sobrevive ao merge/remoção
   * da worktree e é de onde o app lê pra exibir.
   */
  private async collectArtifacts(taskId: string, worktree: string, agent: string): Promise<void> {
    const src = join(worktree, ".cardume", "artifacts");
    try {
      const files = await readdir(src);
      if (!files.length) return;
      const dst = join(this.ws.dir, "artifacts", taskId);
      await mkdir(dst, { recursive: true });
      for (const f of files) {
        await cp(join(src, f), join(dst, f), { recursive: true });
      }
      this.store.addEvent(taskId, agent, "note", `${files.length} artefato(s) anexado(s) à tarefa`, true);
    } catch {
      /* nenhum artefato produzido */
    }
  }

  /**
   * ENTREGÁVEL SOB DEMANDA: depois que a tarefa está pronta, o humano pede um
   * artefato específico (doc de arquitetura / testes comprovando / prova em
   * prints). Roda UM agente num turno fresco que LÊ o código já implementado e
   * produz o arquivo em .cardume/artifacts/ — sem reimplementar nada.
   */
  async deliverArtifact(taskId: string, kind: "doc" | "tests" | "proof"): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    if (task.status === "merged") throw new Error("tarefa mergeada — a worktree foi removida; não dá pra gerar entregável");
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const roles = spec.roles || [];
    const pref = kind === "doc" ? ["docs", "builder"] : ["tester", "builder"];
    const role =
      roles.find((r) => pref.includes(r.role) && r.engine === "claude") ||
      roles.find((r) => r.engine === "claude") ||
      ({ role: "builder", name: spec.agent, engine: "claude", model: spec.model } as (typeof roles)[number]);

    const PROMPTS: Record<string, string> = {
      doc: "Esta tarefa JÁ FOI implementada nesta worktree. NÃO reimplemente nada. Leia o código e o diff e produza o MAPA DE ARQUITETURA em `.cardume/artifacts/ARCHITECTURE.md` (Markdown, pode usar mermaid), com 3 seções: 1) Intenção — o quê e por quê; 2) Arquitetura — componentes/arquivos criados e o fluxo de dados entre eles; 3) Resultado esperado & como validar. Conciso e visual, pro humano entender a entrega sem ler o código.",
      tests: "Esta tarefa JÁ FOI implementada nesta worktree. Escreva e RODE testes cobrindo a funcionalidade principal e os casos de borda. Salve a comprovação em `.cardume/artifacts/tests.md`: o(s) comando(s) executado(s) e a SAÍDA real (quantos passaram/falharam). Se algo falhar, aponte a causa. Não altere a lógica de produção além do necessário pra testar.",
      proof: "Esta tarefa JÁ FOI implementada nesta worktree. COMPROVE que funciona. Se for algo visual/web, capture screenshots e salve em `.cardume/artifacts/proof.png` (ou proof-1.png, proof-2.png…). Caso contrário, salve `.cardume/artifacts/proof.md` com a evidência: comandos executados, saída, antes/depois. NÃO reimplemente nada.",
    };
    const label = kind === "doc" ? "documento de arquitetura" : kind === "tests" ? "testes de comprovação" : "prova (prints/evidência)";
    const engine = this.engineFor(role.engine, role.model, "auto");
    const ctx = (role.persona ? `## Seu perfil (${role.name})\n${role.persona}\n\n` : "") + this.bus.buildContext(spec);
    const prev = task.status;
    this.store.setStatus(taskId, "thinking");
    this.store.setStage(taskId, role.role);
    this.store.addEvent(taskId, role.name, "status", `gerando ${label}…`, true, role.role);
    try {
      for await (const ev of engine.run({ cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: this.ws.dbFile, promptOverride: PROMPTS[kind] })) {
        if (ev.type === "session") { this.store.setSession(taskId, ev.text); continue; }
        if (ev.type === "claim") continue;
        this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role);
        if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
          this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
        }
      }
    } catch (err) {
      this.store.addEvent(taskId, role.name, "error", (err as Error).message, false, role.role);
    }
    await this.collectArtifacts(taskId, task.worktree, role.name);
    this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
    this.store.addEvent(taskId, role.name, "note", `${label} pronto — veja em Artefatos`, true, role.role);
    notify("Constellation", `${label} pronto ✓`, task.title);
  }

  /**
   * REWORK: aplica um ajuste pedido pelo humano (sobre um commit/etapa) numa
   * tarefa já concluída (review/error), continuando a sessão do agente via
   * --resume na worktree existente, recommitando e refazendo o review.
   */
  async reworkTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    if (task.status === "merged") throw new Error("tarefa já mergeada — a worktree foi removida, não dá pra refazer");
    const spec = JSON.parse(task.spec_json) as TaskSpec;

    // Junta os ajustes que o humano pediu e injeta no spec — TODOS os papéis vão
    // vê-lo. O ajuste passa pelo TIME INTEIRO (planejar → codar → revisar → docs),
    // incorporando sobre o trabalho que já existe na worktree.
    const open = this.store.openInstructions(taskId);
    const adjustment = open.map((i) => i.text.trim()).filter(Boolean).join("\n");
    if (adjustment) spec.adjustment = adjustment;
    for (const i of open) this.store.markInstructionApplied(i.id);

    // Persiste o spec (DB + TASK.yaml) pra o agente ler o ajuste.
    this.store.updateSpec(taskId, JSON.stringify(spec));
    try {
      await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
    } catch { /* worktree pode ter mudado */ }

    this.store.addEvent(taskId, spec.agent, "note", `rework: aplicando ajuste pelo time inteiro — "${adjustment.slice(0, 80)}"`, true);

    // Re-roda o pipeline do começo: planner re-planeja com o ajuste, builder aplica,
    // reviewer re-revisa, docs re-atualiza. O stepper anda por todas as etapas.
    this.store.setDoneRoles(taskId, 0);
    this.store.setStatus(taskId, "running");
    await this.runTask(taskId);
    notify("Constellation", "Ajuste aplicado (time inteiro) — pronto para review", task.title);
  }

  /** Detecta um código de issue (FND-853, ABC-12…) nos eventos e renomeia a branch. */
  private async maybeRenameBranchFromIssue(taskId: string, task: TaskRow, spec: TaskSpec): Promise<void> {
    const text = this.store.eventsForTask(taskId).map((e) => e.text).join("  ");
    const m = text.match(/\b([A-Z]{2,10}-\d+)\b/);
    if (!m) return;
    const code = m[1].toUpperCase();
    const cur = this.store.getTask(taskId)?.branch ?? task.branch;
    if (cur.includes(code)) return;
    const type = spec.branchType && spec.branchType !== "agent" ? spec.branchType : "feat";
    const newBranch = `${type}/${code}-${spec.id}`;
    try {
      await this.git.renameBranch(task.worktree, newBranch);
      this.store.setBranch(taskId, newBranch);
      task.branch = newBranch;
      this.store.addEvent(taskId, spec.agent, "note", `branch renomeada → ${newBranch} (issue ${code})`, true);
    } catch (err) {
      this.store.addEvent(taskId, spec.agent, "note", `não deu pra renomear a branch: ${(err as Error).message}`, false);
    }
  }

  /** Gera (via Claude) e guarda o resumo técnico de um commit — o quê + porquê. */
  private async summarizeCommit(taskId: string, hash: string, worktree: string, spec: TaskSpec): Promise<void> {
    try {
      const diff = (await run("git", ["-C", worktree, "show", "--no-color", "--format=", "-p", hash])).stdout.slice(0, 8000);
      const dels = spec.deliverables?.length ? `Entregáveis pedidos: ${spec.deliverables.join("; ")}\n` : "";
      const prompt =
        `Você é um revisor de código sênior. Em 2 a 4 frases, explique de forma TÉCNICA e direta O QUE foi feito neste commit e POR QUE (a intenção/como se conecta ao objetivo). NÃO liste arquivos nem número de linhas — foque na mudança e no propósito. Responda em português.\n\n` +
        `Objetivo da tarefa: ${spec.objective}\n${dels}\nDiff:\n${diff}`;
      const claude = process.env.CARDUME_CLAUDE || "claude";
      const { stdout } = await run(claude, ["-p", prompt], { cwd: worktree });
      const s = stdout.trim();
      if (s) {
        this.store.addCommitSummary(hash, s);
        this.store.addEvent(taskId, spec.agent, "note", "resumo técnico do commit gerado", true);
      }
    } catch (err) {
      this.store.addEvent(taskId, spec.agent, "note", `resumo IA do commit falhou: ${(err as Error).message}`, false);
    }
  }

  /** Faz merge da branch da tarefa na base, remove a worktree/branch e marca 'merged'. */
  async mergeTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    try {
      await this.git.mergeBranch(task.branch, `cardume: merge ${task.title} (${task.branch})`);
    } catch (err) {
      await this.git.abortMerge();
      this.store.setStatus(taskId, "conflict");
      this.store.addEvent(taskId, task.agent, "error", `merge conflitou com ${task.base} — resolva manualmente`, false);
      throw new Error(`conflito ao mergear em ${task.base}. O merge foi abortado e a branch preservada — resolva o conflito e tente de novo.`);
    }
    try {
      await this.git.worktreeRemove(task.worktree);
    } catch {
      /* ok */
    }
    await this.git.branchDelete(task.branch);
    this.store.releaseClaims(taskId);
    this.store.setStatus(taskId, "merged");
    this.store.addEvent(taskId, task.agent, "note", `merge na ${task.base} concluído`, true);
  }

  async removeTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;
    try {
      await this.git.worktreeRemove(task.worktree);
    } catch {
      /* worktree pode já ter sido removida */
    }
    await this.git.branchDelete(task.branch);
    await rm(join(this.ws.dir, "artifacts", taskId), { recursive: true, force: true }).catch(() => {});
    this.store.deleteTask(taskId);
  }

  close(): void {
    this.store.close();
  }
}
