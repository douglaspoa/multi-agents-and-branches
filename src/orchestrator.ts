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
    const base = await this.git.currentBranch();

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
   * REWORK: aplica um ajuste pedido pelo humano (sobre um commit/etapa) numa
   * tarefa já concluída (review/error), continuando a sessão do agente via
   * --resume na worktree existente, recommitando e refazendo o review.
   */
  async reworkTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    if (task.status === "merged") throw new Error("tarefa já mergeada — a worktree foi removida, não dá pra refazer");
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const lead = (spec.roles.find((r) => r.role === "builder") ?? spec.roles[0]) as AgentRole;
    if (lead.engine !== "claude") throw new Error("rework só funciona com agentes Claude");

    this.store.setStatus(taskId, "running");
    this.store.setStage(taskId, lead.role);
    const persona = lead.persona ? `## Seu perfil (${lead.name} · ${lead.role})\n${lead.persona}\n\n` : "";
    const ctx = persona + this.bus.buildContext(spec);

    await this.applyInstructions(taskId, task.worktree, spec, lead, ctx, task.session_id ?? "");

    try {
      await this.git.commitAll(task.worktree, `cardume(rework): ${task.title}`);
      const d = await this.git.diffStat(task.worktree, task.base);
      this.store.setDiff(taskId, d.files, d.add, d.del);
      const diff = await this.git.diffText(task.worktree, task.base);
      this.store.addReview(taskId, buildReview(diff, lead.name));
      const head = await this.git.headHash(task.worktree);
      if (!this.store.hasCommitSummary(head) && process.env.CARDUME_AUTOSUMMARY !== "0") {
        await this.summarizeCommit(taskId, head, task.worktree, spec);
      }
    } catch (err) {
      this.store.addEvent(taskId, lead.name, "note", `falha ao finalizar rework: ${(err as Error).message}`, false);
    }
    await this.collectArtifacts(taskId, task.worktree, spec.agent);
    this.store.releaseClaims(taskId);
    this.store.setStatus(taskId, "review");
    notify("Constellation", "Ajuste aplicado — pronto para review", task.title);
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
