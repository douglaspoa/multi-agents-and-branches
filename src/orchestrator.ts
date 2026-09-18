import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordinationBus } from "./bus.ts";
import { GitService } from "./git.ts";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";
import { buildReview } from "./review.ts";
import { ghBin, run } from "./util/run.ts";
import { notify } from "./util/notify.ts";
import { taskToYaml } from "./util/yaml.ts";
import { MockEngine } from "./engine/mock.ts";
import { ClaudeEngine } from "./engine/claude.ts";
import { CodexEngine } from "./engine/codex.ts";
import { readAltConfig } from "./engine/altProxy.ts";
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
    // tolera rótulos/variações ("Claude · Opus 4.8", "CLAUDE"): o mock só entra quando pedido de fato —
    // uma tarefa real cair no MockEngine por um nome fora da lista "concluía" com código de mentira.
    const n = String(name ?? "").trim().toLowerCase();
    const kind = n === "mock" ? "mock"
      : n.startsWith("codex") ? "codex"
      : (n.startsWith("gateway") || n.startsWith("logcomex")) ? (n.startsWith("gateway") ? "gateway" : "logcomex")
      : n.startsWith("claude") ? "claude"
      : (n === "" ? "mock" : "claude");
    if (kind !== n) console.warn(`[engine] "${name}" interpretado como ${kind}`);
    name = kind;
    if (name === "claude") return new ClaudeEngine({ model, approval });
    if (name === "codex") return new CodexEngine({ model });
    if (name === "gateway" || name === "logcomex") {
      // gateway OpenAI-compatível da EMPRESA (URL/chave/modelos vêm do cofre da conta — Configurações → Gateway).
      // "logcomex" é o nome antigo: sem config, cai nos padrões da Logcomex pra não quebrar tarefas existentes.
      const alt = readAltConfig();
      return new CodexEngine({
        model: model || (alt?.model || "logcomex-v2"),
        provider: alt
          ? { id: "gateway", name: alt.label, baseUrl: alt.baseUrl, envKey: alt.keyVar }
          : { id: "logcomex", name: "Logcomex AI", baseUrl: "https://llm.logcomex.ai/v1", envKey: "LGCX_API_KEY" },
      });
    }
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
    // base ATUALIZADA: fetch + origin/<base> quando existir (main fresca sempre)
    const baseRef = await this.git.freshBaseRef(base);
    await this.git.worktreeAdd(worktree, branch, baseRef);

    const taskDir = join(worktree, ".cardume");
    await mkdir(taskDir, { recursive: true });

    // Semeia o ambiente: o `git worktree add` NÃO traz o que o git ignora
    // (.env, node_modules, .venv) — e sem isso o agente não consegue RODAR o
    // projeto e queima a sessão redescobrindo o óbvio a cada tarefa.
    const seeded = await this.seedWorktreeEnv(worktree);
    if (seeded.length) {
      await writeFile(
        join(taskDir, "AMBIENTE.md"),
        `# Ambiente desta worktree (semeado do repo principal)\n\n` +
          seeded.map((s) => `- ${s}`).join("\n") +
          `\n\nOs itens "(link)" apontam pro repo principal: NÃO rode instalações destrutivas` +
          ` (npm ci, rm -rf node_modules, pip sync) neles — se precisar de dependência nova,` +
          ` instale de forma aditiva (npm install pkg / pip install pkg).\n`,
        "utf8",
      );
    }

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

    this.bus.policy = spec.autonomy.busPolicy ?? "first-claim-wins";
    for (const path of spec.scope.owns) {
      this.bus.claim(spec.id, spec.agent, path, "write");
    }

    return this.store.getTask(spec.id)!;
  }

  /**
   * Copia os `.env*` do repo principal (até 3 níveis, fora de dirs de build),
   * linka os diretórios de dependências (node_modules/.venv — venv Python tem
   * caminhos absolutos, copiar não funciona; node_modules é pesado demais) e
   * roda `.cardume/setup.sh` do repo se o projeto tiver necessidades próprias.
   * Retorna a lista do que foi semeado. Nunca derruba a criação da tarefa.
   */
  private async seedWorktreeEnv(worktree: string): Promise<string[]> {
    const seeded: string[] = [];
    const skip = new Set(["node_modules", ".git", ".venv", "venv", ".cardume", ".constellation", "dist", "build", "__pycache__", ".next", "target"]);
    const scan = async (rel: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(join(this.ws.repo, rel || "."), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (depth < 3 && !skip.has(e.name)) await scan(r, depth + 1); continue; }
        if (!/^\.env(\..+)?$/.test(e.name) || e.name === ".env.example") continue;
        try {
          await stat(join(worktree, r));           // já veio pelo git (rastreado)? não mexe
        } catch {
          try { await cp(join(this.ws.repo, r), join(worktree, r)); seeded.push(r); } catch { /* dir não existe na worktree */ }
        }
      }
    };
    await scan("", 0);
    // conhecimento acumulado: RUNBOOK (como subir o ambiente — editável, volta
    // pro repo no fim do turno) e HISTORY (índice de tarefas passadas — grep).
    for (const doc of ["RUNBOOK.md", "HISTORY.md", "SPEC.md", "PREFS.md"]) {
      try {
        await cp(join(this.ws.dir, doc), join(worktree, ".cardume", doc));
        seeded.push(`.cardume/${doc}`);
      } catch { /* ainda não existe no projeto */ }
    }
    for (const d of ["node_modules", ".venv", "venv", "frontend/node_modules", "backend/node_modules", "backend/.venv", "backend/venv"]) {
      try {
        if (!(await stat(join(this.ws.repo, d))).isDirectory()) continue;
        await symlink(join(this.ws.repo, d), join(worktree, d));
        seeded.push(`${d} (link → repo principal)`);
      } catch { /* não existe no repo, ou a worktree já tem */ }
    }
    try {
      const hook = join(this.ws.dir, "setup.sh");
      await stat(hook);
      await run("bash", [hook], { cwd: worktree, env: { ...process.env, CARDUME_MAIN_REPO: this.ws.repo } });
      seeded.push(".cardume/setup.sh executado");
    } catch { /* sem hook, ou hook falhou — os envs/links acima já valem */ }
    return seeded;
  }

  // ---------------------------------------------------------------------------
  // MEMÓRIA DO PROJETO: decisões e correções do humano que valem pra SEMPRE
  // (.cardume/MEMORY.md na raiz do repo). Entra no contexto de TODO turno de
  // TODO agente — e cresce sozinha: cada mensagem de chat do humano passa por
  // um destilador (Haiku) que extrai regras duradouras e as anexa (com dedup).
  // ---------------------------------------------------------------------------
  private memoryFile(): string {
    return join(this.ws.dir, "MEMORY.md");
  }

  projectMemory(): string {
    let out = "";
    try {
      const txt = readFileSync(this.memoryFile(), "utf8").trim();
      if (txt) out += `## MEMÓRIA DO PROJETO — decisões do humano que você DEVE obedecer (aprendidas em tarefas anteriores)\n${txt.slice(0, 6000)}\n\n`;
    } catch { /* sem memória ainda */ }
    try {
      const rb = readFileSync(join(this.ws.dir, "RUNBOOK.md"), "utf8").trim();
      if (rb) out += `## RUNBOOK — como SUBIR O AMBIENTE deste projeto (validado em tarefas anteriores; siga ANTES de redescobrir qualquer coisa)\n${rb.slice(0, 4000)}\n\n`;
    } catch { /* sem runbook ainda */ }
    return out;
  }

  /**
   * Ensina o agente que ELE PODE criar novas demandas/épicos — via o CLI oficial
   * `cardume new`, com o node e o caminho do CLI que ESTE processo já está usando.
   * Sem isso, agentes ficam "chutando" que existe um comando ou tentam mexer no
   * state.sqlite cru (arriscado). Injetado no system-prompt de todo agente.
   */
  selfServe(): string {
    const node = process.execPath;
    const cli = process.argv[1] || "";
    const repo = this.ws.repo;
    return (
      `\n\n## Criar novas demandas / épicos — VOCÊ PODE (não mexa no state.sqlite na mão, não invente CLI)\n` +
      `Se o humano pedir pra criar tarefas, issues, demandas ou um épico, use o comando OFICIAL abaixo (roda de qualquer pasta; o \`--repo\` é o que importa):\n\n` +
      `\`\`\`bash\n` +
      `"${node}" "${cli}" new --repo "${repo}" \\\n` +
      `  --title "título curto" --objective "o que precisa e por quê" \\\n` +
      `  --requirements "critério verificável 1, critério 2" \\\n` +
      `  --owns "caminho/que/mexe, outro/caminho" --engine claude --no-start\n` +
      `\`\`\`\n\n` +
      `- \`--no-start\` cria como RASCUNHO (não dispara agente nenhum) — é o PADRÃO SEGURO. Crie assim e avise o humano; ele inicia quando quiser. Só tire o \`--no-start\` se ele pediu explicitamente pra "já sair rodando".\n` +
      `- ÉPICO = várias tarefas da mesma frente: crie a primeira, pegue o id que o comando imprime e nas seguintes passe \`--linked-to <id>\` pra amarrar. Dê \`--owns\` DISJUNTOS entre elas (escopos que não se sobrepõem) pra poderem rodar em paralelo sem colisão.\n` +
      `- Flags úteis: \`--deliverable "..."\` (repita p/ vários), \`--artifact-doc\`, \`--artifact-proof\`, \`--artifact-tests\`, \`--off "caminhos proibidos"\`, \`--branch-type feat|fix|docs\`.\n` +
      `- Cada tarefa criada aparece no app na hora. Ao terminar, liste pro humano os ids/títulos que você criou.\n`
    );
  }

  /**
   * Skills que o humano ATIVOU pra este repo (.cardume/skills.json, escolhidas
   * no painel de Skills do app). O agente já tem acesso às skills do Claude Code;
   * aqui a gente DIZ quais usar, pra ele invocá-las (tool Skill / /nome) quando o
   * gatilho da descrição bater — em vez de resolver do próprio jeito.
   */
  skillsContext(): string {
    try {
      const raw = readFileSync(join(this.ws.dir, "skills.json"), "utf8");
      const arr = JSON.parse(raw);
      const list = (Array.isArray(arr) ? arr : []).filter((s: any) => s && s.name);
      if (!list.length) return "";
      let out =
        `\n\n## SKILLS ATIVADAS PRA ESTE PROJETO — o humano escolheu; USE quando o gatilho bater\n` +
        `Quando a situação corresponder à descrição de uma skill abaixo, INVOQUE-A (tool Skill, ou \`/nome\`) ANTES de resolver do seu jeito — elas carregam o processo/estilo que o time espera:\n`;
      for (const s of list) out += `- **${s.name}**: ${String(s.description || "").replace(/\s+/g, " ").slice(0, 320)}\n`;
      return out;
    } catch {
      return "";
    }
  }

  /**
   * HISTÓRICO DE TAREFAS: índice pesquisável do que já foi feito no projeto
   * (.cardume/HISTORY.md). Agentes fazem grep nele antes de investigar do zero
   * — issue parecida pode já ter sido resolvida, com branch e arquivos citados.
   */
  private appendHistory(taskId: string): void {
    try {
      const t = this.store.getTask(taskId);
      if (!t) return;
      const spec = JSON.parse(t.spec_json) as TaskSpec;
      const done = this.store
        .eventsForTask(taskId)
        .filter((e) => e.type === "done" || (e.type === "note" && /concluí|pronta|finaliz/i.test(e.text)))
        .pop();
      const resumo = (done?.text || spec.objective || "").replace(/\s+/g, " ").slice(0, 220);
      const d = new Date();
      const line = `- ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} · **${spec.title}** (${t.branch}) — ${resumo}\n`;
      const file = join(this.ws.dir, "HISTORY.md");
      let cur = "";
      try { cur = readFileSync(file, "utf8"); } catch { /* primeiro registro */ }
      if (cur.includes(`(${t.branch})`)) return; // já registrada
      if (!cur) cur = "# Histórico de tarefas — grep aqui antes de investigar do zero\n\n";
      writeFileSync(file, cur + line, "utf8");
    } catch { /* histórico é best-effort */ }
  }

  /** Destila uma mensagem do humano em regra duradoura e anexa à memória. */
  private async learnFromMessage(message: string): Promise<void> {
    const msg = message.trim();
    if (msg.length < 12) return;
    try {
      const prompt =
        `Mensagem de um dev pro agente de IA durante uma tarefa:\n"""${msg.slice(0, 800)}"""\n\n` +
        `Se ela contém uma REGRA/PREFERÊNCIA DURADOURA de trabalho (vale pra tarefas futuras — ex.: como testar, onde ficam credenciais, convenção de git/PR, decisão de produto), responda SÓ a regra em UMA linha imperativa e geral, EM PORTUGUÊS (sem mencionar a tarefa específica). Se for só um pedido pontual desta tarefa, responda exatamente: SKIP`;
      const claude = process.env.CARDUME_CLAUDE || "claude";
      const { stdout } = await run(claude, ["-p", prompt, "--model", "claude-haiku-4-5-20251001"]);
      const rule = stdout.trim().split("\n").pop()?.trim() ?? "";
      if (!rule || /^skip\b/i.test(rule) || rule.length < 10 || rule.length > 300) return;
      // dedup ingênuo: não anexa se já existe linha muito parecida
      let cur = "";
      try { cur = readFileSync(this.memoryFile(), "utf8"); } catch { /* primeira regra */ }
      const norm = (s: string) => s.toLowerCase().replace(/[^a-zà-ú0-9]+/g, " ").trim();
      const nrule = norm(rule);
      const words = new Set(nrule.split(" "));
      for (const line of cur.split("\n")) {
        const nl = norm(line.replace(/^[-*]\s*/, ""));
        if (!nl) continue;
        const lw = nl.split(" ");
        const overlap = lw.filter((w) => words.has(w)).length;
        if (overlap >= Math.min(words.size, lw.length) * 0.75) return; // já sabemos disso
      }
      const stamp = new Date().toISOString().slice(0, 10);
      appendFileSync(this.memoryFile(), `${cur && !cur.endsWith("\n") ? "\n" : ""}- ${rule} _(aprendido ${stamp})_\n`);
    } catch {
      /* aprender é melhor-esforço — nunca quebra o turno */
    }
  }

  // ---------------------------------------------------------------------------
  // FILA DE TRABALHO: uma tarefa roda UM turno por vez. Pedidos feitos enquanto
  // o agente está ocupado (falar, revisar PR, entregáveis) NÃO se perdem nem
  // atropelam o turno atual — entram na fila (com aviso no chat) e rodam
  // automaticamente quando o turno terminar. O "lock" é o busy_pid no banco,
  // validado com kill(pid, 0) — processo morto não segura fila.
  // ---------------------------------------------------------------------------

  /** true se OUTRO processo vivo está rodando um turno desta tarefa. */
  private taskBusy(taskId: string): boolean {
    const pid = this.store.busyPid(taskId);
    if (!pid || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // PID morto — lock obsoleto
    }
  }

  /** O erro indica sessão que ESTOUROU o limite de tokens/contexto? */
  private static tokenDeath(text: string): boolean {
    return /context (low|limit|window)|prompt is too long|too long for.*context|exceeds.*context|conversation (is )?too long|out of (context|tokens)|maximum context|token limit|low on context/i.test(text || "");
  }

  /** Morte por INATIVIDADE (watchdog 30min) ou SINAL (SIGTERM=143, SIGKILL=137, SIGINT=130)?
   * São mortes onde CONTINUAR da worktree faz sentido — o trabalho parcial está lá. */
  private static idleOrSignalDeath(text: string): boolean {
    return /inatividade de \d+ ?min|agente encerrad|c[óo]digo (143|137|130|null)|sigterm|sigkill|sigint/i.test(text || "");
  }

  /** Deu pra tentar seguir automaticamente (token/inatividade/sinal)? NÃO cobre erro
   * de config (ex.: "falha ao iniciar claude") que só se repetiria. */
  /** Queda de REDE/socket no meio do turno (API Error: socket closed, ECONNRESET, fetch failed…):
   * o trabalho parcial está na worktree — continuar faz sentido, igual à inatividade. */
  private static networkDeath(text: string): boolean {
    return /socket connection was closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network error|other side closed|Connection error/i.test(text || "");
  }
  private static retriableDeath(text: string): boolean {
    return Orchestrator.tokenDeath(text) || Orchestrator.idleOrSignalDeath(text) || Orchestrator.networkDeath(text);
  }

  /** requirements.json (worktree ou pasta coletada do repo) existe e TODOS os requisitos estão "done"?
   * É a régua do "provou" — vale pra não marcar como erro uma sessão que caiu DEPOIS de entregar. */
  private async proofsComplete(taskId: string, worktree: string): Promise<boolean> {
    for (const p of [join(worktree, ".cardume", "artifacts", "requirements.json"), join(this.ws.repo, ".cardume", "artifacts", taskId, "requirements.json")]) {
      try {
        const raw = JSON.parse(await readFile(p, "utf8"));
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.list) ? raw.list : []);
        if (list.length && list.every((x: { status?: string }) => x && x.status === "done")) return true;
      } catch { /* sem arquivo aqui */ }
    }
    return false;
  }

  /**
   * GATE MECÂNICO da entrega — não confia só no auto-relato do agente:
   *  1) todo requisito precisa estar "done" (ou "deferred", decidido pelo humano);
   *  2) todo requisito "done" precisa ter EVIDÊNCIA que EXISTE no disco;
   *  3) se a tarefa pediu testes e há comando de teste no repo, os testes RODAM
   *     de verdade e precisam passar.
   * Retorna { ok, reasons } — `reasons` descreve o que reprovou.
   */
  private async verifyProofs(taskId: string, task: TaskRow, spec: TaskSpec): Promise<{ ok: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const artDir = join(task.worktree, ".cardume", "artifacts");
    let list: Array<{ req?: string; status?: string; evidence?: string[] }> = [];
    let found = false;
    for (const p of [join(artDir, "requirements.json"), join(this.ws.repo, ".cardume", "artifacts", taskId, "requirements.json")]) {
      try {
        const raw = JSON.parse(await readFile(p, "utf8"));
        list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.list) ? raw.list : []);
        found = true;
        if (list.length) break;
      } catch { /* sem arquivo aqui */ }
    }
    if (!found || list.length === 0) {
      if ((spec.requirements ?? []).length) reasons.push("sem requirements.json comprovando os requisitos");
      return { ok: reasons.length === 0, reasons };
    }
    for (const r of list) {
      const label = String(r.req ?? "requisito").slice(0, 70);
      if (r.status === "deferred") continue; // o humano decidiu adiar/dispensar
      if (r.status !== "done") { reasons.push(`requisito não provado (${r.status ?? "?"}): ${label}`); continue; }
      const ev = Array.isArray(r.evidence) ? r.evidence : [];
      const hasReal = ev.some((e) => {
        const name = String(e).replace(/^\.?\/?(\.cardume\/artifacts\/)?/, "");
        return existsSync(join(artDir, name)) || existsSync(String(e));
      });
      if (!hasReal) reasons.push(`requisito "done" sem evidência real no disco: ${label}`);
    }
    const wantsTests = spec.autonomy?.runTests === true || (spec.artifacts ?? []).some((a) => a.kind === "tests");
    if (wantsTests) {
      const t = await this.runRepoTests(task.worktree);
      if (t.ran && !t.passed) reasons.push(`os testes falharam: ${t.detail}`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** Roda o teste do repo NA WORKTREE, se houver `scripts.test` real. Timeout 180s. */
  private async runRepoTests(worktree: string): Promise<{ ran: boolean; passed: boolean; detail: string }> {
    try {
      const pkg = JSON.parse(await readFile(join(worktree, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const testCmd = pkg.scripts?.test ?? "";
      if (!testCmd || /no test specified/i.test(testCmd)) return { ran: false, passed: true, detail: "sem comando de teste" };
      await run("npm", ["test", "--silent"], { cwd: worktree, timeout: 180000 });
      return { ran: true, passed: true, detail: "npm test passou" };
    } catch (err) {
      const e = err as Error & { killed?: boolean; stderr?: string };
      if (e.killed) return { ran: true, passed: false, detail: "npm test estourou o tempo (180s)" };
      return { ran: true, passed: false, detail: String(e.stderr || e.message || "").slice(0, 160) };
    }
  }

  /** O erro é o LIMITE DE USO/RATE da conta (não o contexto)? Esses resetam com o
   * tempo — a saída é ESPERAR e retomar, não recomeçar na hora. */
  private static usageLimitDeath(text: string): boolean {
    return /session limit|usage limit|hit your .{0,24}limit|rate[ _-]?limit|too many requests|\b429\b|quota|resets? (at|\d)|limit reached|upgrade to increase|please try again later/i.test(text || "");
  }

  /** Instrução pra RETOMAR uma tarefa que morreu — o parcial está na worktree. */
  private static continuePrompt(kind: "token" | "idle" | "limit"): string {
    const cause = kind === "token"
      ? "A sessão anterior ESTOUROU O LIMITE DE TOKENS e foi encerrada."
      : kind === "limit"
      ? "A sessão anterior parou porque o LIMITE DE USO da IA foi atingido; ele já resetou e dá pra continuar."
      : "A sessão anterior foi ENCERRADA por inatividade (ficou minutos sem emitir saída). Se você estava rodando algo demorado e silencioso, vá REPORTANDO progresso (uma linha a cada passo) pra não ser encerrado de novo; NÃO fique em loops de espera silenciosa.";
    return cause + " O trabalho já feito está NESTA worktree: confira git status, git diff, .cardume/PLAN.md e .cardume/artifacts. Leia .cardume/TASK.yaml e CONTINUE de onde parou até finalizar TODOS os requisitos — não recomece do zero.";
  }

  private queueLabel(kind: string, payload: Record<string, unknown>): string {
    if (kind === "talk") return `mensagem — "${String(payload.message ?? "").slice(0, 80)}"`;
    if (kind === "deliver") return `gerar ${payload.kind === "all" ? "todos os entregáveis" : `entregável (${payload.kind})`}`;
    if (kind === "rework") return "revisar/endereçar comentários do PR (rework)";
    return kind;
  }

  /**
   * Executa `fn` segurando o lock da tarefa; se o agente já está ocupado,
   * ENFILEIRA o pedido (evento visível no chat) em vez de rodar por cima.
   */
  private async withTaskLock(taskId: string, kind: string, payload: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
    if (this.taskBusy(taskId)) {
      this.store.queueAdd(taskId, kind, payload);
      const pos = this.store.queueCount(taskId);
      this.store.addEvent(
        taskId,
        "Sistema",
        "note",
        `⏳ pedido NA FILA (${pos}º): ${this.queueLabel(kind, payload)} — o agente está no meio de um turno; executo automaticamente assim que ele terminar.`,
        true,
      );
      return;
    }
    this.store.setBusyPid(taskId, process.pid);
    try {
      await fn();
    } finally {
      this.store.setBusyPid(taskId, null);
      await this.drainQueue(taskId);
    }
  }

  /** Roda os pedidos enfileirados, em ordem, até esvaziar (ou outro processo assumir). */
  private async drainQueue(taskId: string): Promise<void> {
    for (;;) {
      if (this.taskBusy(taskId)) return; // outro processo pegou o lock — ele drena
      const item = this.store.queueNext(taskId);
      if (!item) return;
      this.store.queueDone(item.id);
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(item.payload || "{}"); } catch { /* payload corrompido — segue vazio */ }
      this.store.addEvent(taskId, "Sistema", "note", `▶ executando pedido da fila: ${this.queueLabel(item.kind, p)}`, true);
      this.store.setBusyPid(taskId, process.pid);
      try {
        if (item.kind === "talk") await this.talkToAgentInner(taskId, String(p.message ?? ""), !!p.asReq, p.agent ? String(p.agent) : undefined);
        else if (item.kind === "deliver") await this.deliverArtifactInner(taskId, (p.kind as "doc" | "tests" | "proof" | "all") ?? "all");
        else if (item.kind === "rework") await this.reworkTaskInner(taskId);
      } catch (err) {
        this.store.addEvent(taskId, "Sistema", "error", `pedido da fila falhou: ${(err as Error).message}`, false);
      } finally {
        this.store.setBusyPid(taskId, null);
      }
    }
  }

  /** Roda a equipe da tarefa: cada papel em sequência, na mesma worktree. */
  async runTask(taskId: string): Promise<void> {
    this.store.setBusyPid(taskId, process.pid);
    try {
      await this.runTaskInner(taskId);
    } finally {
      this.store.setBusyPid(taskId, null);
      await this.drainQueue(taskId);
    }
  }

  private async runTaskInner(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    this.bus.policy = spec.autonomy.busPolicy ?? "first-claim-wins";
    const roles = spec.roles.length ? spec.roles : [{ role: "builder" as Role, name: spec.agent, engine: spec.engine }];
    const startIdx = task.done_roles ?? 0; // retoma de onde parou (ex.: após aprovar o plano)

    for (let i = startIdx; i < roles.length; i++) {
      const r = roles[i];
      this.store.setStage(taskId, r.role);
      this.store.setStatus(taskId, this.statusFor(r.role));
      const engine = this.engineFor(r.engine, r.model, spec.autonomy.approval);
      const persona = r.persona ? `## Seu perfil (${r.name} · ${r.role})\n${r.persona}\n\n` : "";
      const ctx = persona + this.projectMemory() + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext();
      let sessionId = "";
      let roleFailed = false; // erro/timeout no papel → NÃO avança pro próximo

      // Morte recuperável NÃO mata a tarefa — recomeça uma sessão NOVA continuando
      // da worktree. Token/inatividade: até 2 tentativas na hora. Limite de USO da
      // IA: ESPERA o intervalo configurado (CARDUME_LIMIT_RETRY_MIN, padrão 60min)
      // e retoma, repetindo até destravar (cap generoso).
      const MAX_TRIES = 3;
      const MAX_LIMIT_WAITS = 24;
      const rawLimit = parseInt(process.env.CARDUME_LIMIT_RETRY_MIN || "60", 10);
      const LIMIT_ENABLED = Number.isFinite(rawLimit) && rawLimit > 0; // 0 = desligado
      const LIMIT_MIN = Math.max(5, LIMIT_ENABLED ? rawLimit : 60);
      let deathKind: "token" | "idle" | "limit" = "idle";
      let hardTry = 0, limitWait = 0, attemptNo = 0;
      let usingAlt = false; // ROUTE AI: já roteamos esta tarefa pra IA alternativa?
      while (true) {
        roleFailed = false;
        let deathText = "";
        const input = {
          cwd: task.worktree,
          spec,
          systemContext: ctx,
          role: r.role,
          agentName: r.name,
          dbFile: this.ws.dbFile,
          forceAlt: usingAlt,
          ...(attemptNo > 0 ? { promptOverride: Orchestrator.continuePrompt(deathKind) } : {}),
        };
        try {
          for await (const ev of engine.run(input)) {
            if (ev.type === "session") {
              sessionId = ev.text;
              this.store.setSession(taskId, sessionId);
              continue;
            }
            if (ev.type === "claim" && ev.path) {
              this.bus.claim(taskId, r.name, ev.path, ev.mode ?? "write");
              continue;
            }
            if (ev.type === "error") { roleFailed = true; deathText = ev.text; }
            if (ev.type === "done" && ev.ok === false) deathText = ev.text;
            this.store.addEvent(taskId, r.name, ev.type, ev.text, ev.ok, r.role);
            if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
              this.store.addCost(taskId, r.name, r.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
            }
            if (ev.status) this.store.setStatus(taskId, ev.status as AgentStatus);
          }
        } catch (err) {
          const msg = (err as Error).message;
          if (Orchestrator.usageLimitDeath(msg) || Orchestrator.retriableDeath(msg)) {
            deathText = msg;
            roleFailed = true;
          } else {
            this.store.addEvent(taskId, r.name, "error", msg, false, r.role);
            this.store.setStatus(taskId, "error");
            notify("Cardume", "Tarefa falhou — veja o log", task.title);
            return;
          }
        }
        // ROUTE AI: Claude bateu limite e o fallback está ligado → em vez de esperar,
        // roteia esta tarefa pra IA alternativa NA HORA e retoma continuando da worktree.
        if (deathText && Orchestrator.usageLimitDeath(deathText) && !usingAlt) {
          const altCfg = readAltConfig();
          if (altCfg && altCfg.fallback) {
            usingAlt = true;
            deathKind = "limit";
            this.store.addEvent(taskId, "Sistema", "note", `🔀 Claude bateu o limite de uso — roteando esta tarefa para a ${altCfg.label} (${altCfg.model}) automaticamente e retomando agora.`, true);
            this.store.setStatus(taskId, this.statusFor(r.role));
            sessionId = ""; attemptNo++;
            continue;
          }
        }
        // LIMITE DE USO DA IA: espera o intervalo e retoma (não gasta o orçamento de hard-tries)
        if (deathText && LIMIT_ENABLED && Orchestrator.usageLimitDeath(deathText) && limitWait < MAX_LIMIT_WAITS) {
          limitWait++;
          deathKind = "limit";
          const at = new Date(Date.now() + LIMIT_MIN * 60000);
          const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
          this.store.addEvent(taskId, "Sistema", "note", `⏳ limite de uso da IA atingido — vou RETOMAR automaticamente em ${LIMIT_MIN}min (~${hhmm}). Tentativa ${limitWait}/${MAX_LIMIT_WAITS}.`, true);
          this.store.setStatus(taskId, "queued");
          await new Promise((res) => setTimeout(res, LIMIT_MIN * 60000));
          this.store.addEvent(taskId, "Sistema", "note", "▶️ intervalo cumprido — retomando de onde parou…", true);
          this.store.setStatus(taskId, this.statusFor(r.role));
          sessionId = ""; attemptNo++;
          continue;
        }
        // TOKEN/INATIVIDADE: recomeça na hora, orçamento limitado
        if (deathText && Orchestrator.retriableDeath(deathText) && hardTry < MAX_TRIES - 1) {
          hardTry++;
          deathKind = Orchestrator.tokenDeath(deathText) ? "token" : "idle";
          const why = deathKind === "token" ? "estourou o limite de tokens" : (Orchestrator.networkDeath(deathText) ? "caiu a conexão com a API" : "foi encerrada por inatividade");
          this.store.addEvent(taskId, "Sistema", "note", `🔄 a sessão ${why} — retomando AUTOMATICAMENTE (tentativa ${hardTry + 1}/${MAX_TRIES}), continuando do que já está na worktree.`, true);
          this.store.setStatus(taskId, this.statusFor(r.role));
          sessionId = ""; attemptNo++;
          continue;
        }
        break;
      }

      // Sessão caiu DEPOIS de entregar (requirements.json completo)? Então não é falha: segue o fluxo.
      if (roleFailed && await this.proofsComplete(taskId, task.worktree)) {
        roleFailed = false;
        this.store.addEvent(taskId, "Sistema", "note", "a sessão caiu no fim, mas a entrega já estava completa (requirements.json com todos os requisitos provados) — seguindo como concluída", true);
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
    this.appendHistory(taskId);      // memória de issues: entra no índice pesquisável
    this.harvestRunbook(task.worktree); // aprendizado de ambiente volta pro repo
    await this.maybeOpenPr(taskId, task, spec);
  }

  /**
   * PR ao concluir, conforme escolhido na criação (spec.autoPr):
   * - "auto": abre o PR sozinho — mas SÓ se não houver requisito pendente
   *   (requirements.json sem "blocked"); com pendência, avisa e NÃO abre.
   * - "ask" (padrão): notifica perguntando se quer abrir (a aba PR fica pronta).
   * - "no": não faz nada.
   */
  private async maybeOpenPr(taskId: string, task: TaskRow, spec: TaskSpec): Promise<void> {
    const mode = spec.autoPr ?? "ask";
    if (mode === "no") return;
    if (mode === "ask") {
      notify("Constellation", "Pronta — quer abrir o PR? (aba PR da tarefa)", task.title);
      return;
    }
    // mode === "auto": GATE MECÂNICO antes de abrir (evidência existe + testes passam)
    const gate = await this.verifyProofs(taskId, task, spec);
    if (!gate.ok) {
      const why = gate.reasons.slice(0, 3).join(" · ");
      this.store.addEvent(taskId, spec.agent, "note", `PR NÃO aberto (gate de verificação): ${why}`, false);
      notify("Constellation", "PR não aberto — verificação falhou", task.title);
      return;
    }
    const base = spec.prBase?.trim() || (await this.git.defaultBase()).replace(/^origin\//, "");
    try {
      await run("git", ["-C", task.worktree, "push", "-u", "origin", task.branch]);
      const body =
        `## O quê\n${spec.objective || spec.title}\n\n` +
        ((spec.deliverables ?? []).length ? `## Entregáveis\n${(spec.deliverables ?? []).map((d) => "- " + d).join("\n")}\n\n` : "") +
        `_Aberto automaticamente pelo Constellation (sem pendências nos requisitos)._`;
      const { stdout } = await run(ghBin(), ["pr", "create", "--base", base, "--head", task.branch, "--title", spec.title, "--body", body], { cwd: task.worktree });
      const url = stdout.trim().split("\n").pop() ?? "";
      this.store.addEvent(taskId, spec.agent, "note", `PR aberto automaticamente: ${url}`, true);
      notify("Constellation", "PR aberto ✓", task.title);
    } catch (err) {
      this.store.addEvent(taskId, spec.agent, "note", `falha ao abrir o PR automaticamente: ${(err as Error).message?.slice(0, 140)}`, false);
    }
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
      const { stdout } = await run(ghBin(), ["pr", "view", pr, "--json", "number,title,url,baseRefName"], { cwd: repo });
      meta = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`não consegui ler o PR (${pr}). Confirme o link/número e o gh autenticado.\n${(e as Error).message}`);
    }
    let diff = "";
    try {
      diff = (await run(ghBin(), ["pr", "diff", pr], { cwd: repo })).stdout;
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
      const ctx = persona + this.projectMemory() + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext();
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
  /**
   * Copia os artefatos da worktree pro workspace. Se um artefato de mesmo nome
   * JÁ existe com conteúdo diferente, salva como VERSÃO nova (nome-v2.ext,
   * -v3…) em vez de sobrescrever — o histórico fica visível na UI.
   */
  /**
   * O agente pode ATUALIZAR o .cardume/RUNBOOK.md na worktree quando validar
   * passos novos de boot do ambiente — aqui o aprendizado volta pro repo
   * principal (vale pra TODAS as tarefas futuras). Só copia se cresceu.
   */
  private harvestRunbook(worktree: string): void {
    try {
      const wt = readFileSync(join(worktree, ".cardume", "RUNBOOK.md"), "utf8");
      let main = "";
      try { main = readFileSync(join(this.ws.dir, "RUNBOOK.md"), "utf8"); } catch { /* ainda não existe */ }
      if (wt.trim() && wt.trim() !== main.trim() && wt.length >= main.length * 0.8) {
        writeFileSync(join(this.ws.dir, "RUNBOOK.md"), wt, "utf8");
      }
    } catch { /* worktree sem runbook — nada a colher */ }
  }

  private async collectArtifacts(taskId: string, worktree: string, agent: string): Promise<void> {
    const src = join(worktree, ".cardume", "artifacts");
    try {
      const files = await readdir(src);
      if (!files.length) return;
      const dst = join(this.ws.dir, "artifacts", taskId);
      await mkdir(dst, { recursive: true });
      let added = 0;
      for (const f of files) {
        try {
          const s = join(src, f);
          const st = await stat(s);
          if (st.isDirectory()) {
            await cp(s, join(dst, f), { recursive: true });
            added++;
            continue;
          }
          const buf = await readFile(s);
          let target: string | null = join(dst, f);
          try {
            const old = await readFile(target);
            if (Buffer.compare(old, buf) === 0) continue; // idêntico → já coletado
            // difere → procura o próximo slot de versão (ou detecta duplicata)
            const dot = f.lastIndexOf(".");
            const stem = dot > 0 ? f.slice(0, dot) : f;
            const ext = dot > 0 ? f.slice(dot) : "";
            let n = 2;
            for (;;) {
              const cand = join(dst, `${stem}-v${n}${ext}`);
              try {
                const ex = await readFile(cand);
                if (Buffer.compare(ex, buf) === 0) { target = null; break; } // versão já existe
                n++;
              } catch {
                target = cand; // slot livre
                break;
              }
            }
            if (target === null) continue;
          } catch {
            /* destino ainda não existe → grava direto */
          }
          await writeFile(target, buf);
          added++;
        } catch {
          /* ignora arquivo problemático */
        }
      }
      if (added) this.store.addEvent(taskId, agent, "note", `${added} artefato(s) anexado(s) à tarefa`, true);
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
  async deliverArtifact(taskId: string, kind: "doc" | "tests" | "proof" | "all"): Promise<void> {
    await this.withTaskLock(taskId, "deliver", { kind }, () => this.deliverArtifactInner(taskId, kind));
  }

  private async deliverArtifactInner(taskId: string, kind: "doc" | "tests" | "proof" | "all"): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    if (task.status === "merged") throw new Error("tarefa mergeada — a worktree foi removida; não dá pra gerar entregável");
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const roles = spec.roles || [];
    const pref = kind === "doc" ? ["docs", "builder"] : ["builder", "tester"];
    const role =
      roles.find((r) => pref.includes(r.role) && r.engine === "claude") ||
      roles.find((r) => r.engine === "claude") ||
      ({ role: "builder", name: spec.agent, engine: "claude", model: spec.model } as (typeof roles)[number]);

    const DOC = "MAPA DE ARQUITETURA em `.cardume/artifacts/ARCHITECTURE.md` (Markdown, pode usar mermaid), com 3 seções: 1) Intenção — o quê e por quê; 2) Arquitetura — componentes/arquivos criados e o fluxo de dados; 3) Resultado esperado & como validar. Conciso e visual.";
    const TESTS = "TESTES REAIS na branch desta worktree — PROIBIDO testar num script isolado ou num front mockado que nao reflete o ambiente real. Faca: 1) suba o ambiente LOCAL de verdade nesta branch (as envs reais existem — procure `.env`, `code-refuge-relay/supabase`, docker-compose); 2) escreva e RODE os testes na suite real do projeto (unittest/pytest/vitest — a que o repo usa), exercitando a funcionalidade contra o ambiente que subiu; 3) salve a comprovacao em `.cardume/artifacts/tests.md` com os comandos e a SAIDA real (quantos passaram/falharam). Se algo nao subir/rodar, escreva EXATAMENTE o que travou (comando, erro literal) e PERGUNTE ao humano (mcp__cardume__ask_human) — nao improvise mock.";
    const PROOF = "PROVA na UI REAL com o AMBIENTE REAL — prints de verdade. PROIBIDO usar dados mockados ou entregar so um script: o ambiente e as credenciais EXISTEM e funcionam. Faca: 1) rode a aplicacao localmente com as ENVS reais (ache e use o que precisa — ex.: `.env`, `code-refuge-relay/supabase`, docker-compose); 2) exercite a funcionalidade na tela e capture screenshots REAIS em `.cardume/artifacts/proof.png` (proof-1.png, proof-2.png…). Se voce NAO conseguir rodar ALGO (faltou uma env, um comando falhou, um servico nao subiu), NAO improvise mock nem script: escreva em `.cardume/artifacts/proof.md` EXATAMENTE o que travou (o comando exato, o erro literal, o que faltou) e PERGUNTE ao humano (mcp__cardume__ask_human) o que precisa pra destravar — ele tem o env e sabe que funciona, entao vai te ajudar a rodar. Sem print real da UI o humano nao consegue validar a entrega — a prova e obrigatoria, entao persista (perguntando quando travar) ate conseguir o print real.";
    const head = "Esta tarefa JÁ FOI implementada nesta worktree. NÃO reimplemente nada além do necessário pra testar. ";
    const PROMPTS: Record<string, string> = {
      doc: head + "Produza o " + DOC,
      tests: head + TESTS,
      proof: head + PROOF,
      all: head + "Produza TRÊS entregáveis em `.cardume/artifacts/`:\n1) " + DOC + "\n2) " + TESTS + "\n3) " + PROOF + "\nGere os três.",
    };
    const label =
      kind === "doc" ? "documento de arquitetura"
      : kind === "tests" ? "testes de comprovação"
      : kind === "proof" ? "prova (prints/evidência)"
      : "entregáveis (doc + testes + prova)";
    const engine = this.engineFor(role.engine, role.model, "ask");
    const ctx = (role.persona ? `## Seu perfil (${role.name})\n${role.persona}\n\n` : "") + this.projectMemory() + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext();
    const prev = task.status;
    this.store.setStatus(taskId, "thinking");
    this.store.setStage(taskId, role.role);
    this.store.addEvent(taskId, role.name, "status", `gerando ${label}…`, true, role.role);
    let failed = false;
    try {
      for await (const ev of engine.run({ cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: this.ws.dbFile, promptOverride: PROMPTS[kind] })) {
        if (ev.type === "session") { this.store.setSession(taskId, ev.text); continue; }
        if (ev.type === "claim") continue;
        if (ev.type === "error") failed = true;
        this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role);
        if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
          this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
        }
      }
    } catch (err) {
      failed = true;
      this.store.addEvent(taskId, role.name, "error", (err as Error).message, false, role.role);
    }
    await this.collectArtifacts(taskId, task.worktree, role.name);
    this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
    if (failed) {
      this.store.addEvent(taskId, role.name, "note", `não consegui gerar ${label} — veja o erro acima e tente de novo`, false, role.role);
    } else {
      this.store.addEvent(taskId, role.name, "note", `${label} pronto — veja em Artefatos`, true, role.role);
      notify("Constellation", `${label} pronto ✓`, task.title);
    }
  }

  /**
   * CONVERSAR com o agente numa tarefa já pronta: manda uma mensagem e RETOMA a
   * sessão do agente (--resume) por UM turno, então ele lembra o que fez e
   * corrige/entrega o que faltou. Leve (um agente, um turno) — diferente do
   * rework, que re-roda o time inteiro. Coleta artefatos ao fim.
   */
  async talkToAgent(taskId: string, message: string, asReq = false, agentName?: string): Promise<void> {
    await this.withTaskLock(taskId, "talk", { message, asReq, agent: agentName }, () => this.talkToAgentInner(taskId, message, asReq, agentName));
  }

  private async talkToAgentInner(taskId: string, message: string, asReq = false, agentName?: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    // mergeada NÃO impede conversar se a worktree ainda existe (o merge nem sempre
    // remove) — só barra quando a worktree sumiu de verdade.
    if (task.status === "merged" && !existsSync(task.worktree)) {
      throw new Error("tarefa mergeada e a worktree já foi removida — abra uma correção linkada pra continuar.");
    }
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    // pedido novo vira REQUISITO da tarefa (checklist cresce e cobra evidência)
    if (asReq && message.trim()) {
      spec.requirements = [...(spec.requirements ?? []), message.trim()];
      this.store.updateSpec(taskId, JSON.stringify(spec));
      try { await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree pode não existir */ }
      this.store.addEvent(taskId, "Você", "note", `requisito adicionado: ${message.trim().slice(0, 100)}`, true);
    }
    const roles = spec.roles || [];
    // interlocutor: o agente escolhido no chat (/) ou o padrão (1º claude)
    const deflt = roles.find((r) => r.engine === "claude");
    const picked = agentName ? roles.find((r) => r.name === agentName && r.engine === "claude") : undefined;
    const role =
      picked || deflt ||
      ({ role: "builder", name: spec.agent, engine: "claude", model: spec.model } as (typeof roles)[number]);
    // sessão pertence ao último agente que falou — trocar de agente = turno
    // FRESCO com a persona dele (senão ele "vira" o outro agente da sessão).
    const switching = !!picked && !!deflt && picked.name !== deflt.name;
    const engine = this.engineFor(role.engine, role.model, "ask");
    const ctx = (role.persona ? `## Seu perfil (${role.name})\n${role.persona}\n\n` : "") + this.projectMemory() + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext();
    const prev = task.status;
    const sid = switching ? "" : (task.session_id || "");
    this.store.addEvent(taskId, "Você", "note", `💬 ${message}`, true);
    this.store.setStatus(taskId, "thinking");
    let failed = false;
    try {
      const chatRule =
        "\n\n[CONVERSA CONTÍNUA — NÃO FINALIZE SOZINHO] (1) Precisando de QUALQUER resposta/decisão minha, chame mcp__cardume__ask_human (com options quando fizer sentido) e AGUARDE — a conversa segue no MESMO turno; NUNCA finalize com pergunta em texto. (2) Ao CONCLUIR o pedido, também NÃO finalize: chame ask_human dizendo o que fez e perguntando se quero mais algum ajuste (ex.: options ['Está ótimo, pode finalizar','Quero ajustar algo']) e AGUARDE. (3) Só finalize de verdade quando eu mandar (ex.: 'pode finalizar') ou quando o sistema avisar que estou inativo — aí encerre com um resumo educado. (4) PEDIDO NOVO = REGISTRO OBRIGATÓRIO: se a minha mensagem pedir algo que ainda NÃO fazia parte da tarefa (não é correção/ajuste do que você já fez), registre PRIMEIRO com mcp__cardume__add_requirement (critério curto e verificável — ele entra na checklist X/Y que eu acompanho) e, sendo uma entrega nova, TAMBÉM com mcp__cardume__add_deliverable; só então implemente. 'Entender' o pedido sem registrar NÃO vale — pedido registrado só na conversa não conta na checklist.";
      const base = { cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: this.ws.dbFile, askTimeoutMin: 20 };
      const input = sid
        ? { ...base, resume: { sessionId: sid, instruction: message + chatRule } }
        : { ...base, promptOverride: `Você é ${role.name} (papel: ${role.role}) nesta tarefa, que JÁ FOI implementada nesta worktree. Atenda ao pedido do humano (não recomece do zero): ${message}${chatRule}` };
      let deathText = "";
      for await (const ev of engine.run(input)) {
        if (ev.type === "session") { this.store.setSession(taskId, ev.text); continue; }
        if (ev.type === "claim") continue;
        if (ev.type === "error") { failed = true; deathText = ev.text; }
        if (ev.type === "done" && ev.ok === false) deathText = ev.text;
        this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role);
        if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
          this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok);
        }
      }
      // sessão do chat estourou os tokens → recomeça SOZINHO com sessão nova
      // (sid vazio na re-entrada → caminho fresco; sem risco de loop)
      if (sid && deathText && Orchestrator.retriableDeath(deathText)) {
        const why = Orchestrator.tokenDeath(deathText) ? "estourou o limite de tokens" : (Orchestrator.networkDeath(deathText) ? "caiu a conexão com a API" : "foi encerrada por inatividade");
        this.store.setSession(taskId, "");
        this.store.addEvent(taskId, "Sistema", "note", `🔄 a sessão do chat ${why} — recomeçando AUTOMATICAMENTE com uma sessão nova (o agente relê o estado da worktree).`, true);
        this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
        return this.talkToAgentInner(taskId, message, false, agentName);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (sid && Orchestrator.retriableDeath(msg)) {
        const why = Orchestrator.tokenDeath(msg) ? "estourou o limite de tokens" : (Orchestrator.networkDeath(msg) ? "caiu a conexão com a API" : "foi encerrada por inatividade");
        this.store.setSession(taskId, "");
        this.store.addEvent(taskId, "Sistema", "note", `🔄 a sessão do chat ${why} — recomeçando AUTOMATICAMENTE com uma sessão nova.`, true);
        this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
        return this.talkToAgentInner(taskId, message, false, agentName);
      }
      failed = true;
      this.store.addEvent(taskId, role.name, "error", msg, false, role.role);
    }
    if (!failed) {
      await this.collectArtifacts(taskId, task.worktree, role.name);
      // AJUSTE VIRA COMMIT: sem isso o chat termina e a branch/commits ficam
      // defasados (mudança solta na worktree, invisível no Fluxo e no PR).
      if (spec.kind !== "review") {
        try {
          if (await this.git.commitAll(task.worktree, `ajuste: ${message.slice(0, 60)}`)) {
            const d = await this.git.diffStat(task.worktree, task.base);
            this.store.setDiff(taskId, d.files, d.add, d.del);
            this.store.addEvent(taskId, role.name, "note", "ajustes commitados na branch ✓ (use commit & push no editor pra atualizar o PR)", true, role.role);
          }
        } catch { /* worktree sem git ou nada a commitar */ }
      }
    }
    let next: AgentStatus = prev === "thinking" ? "review" : prev;
    if (!failed && ["error", "aborted", "conflict"].includes(prev) && await this.proofsComplete(taskId, task.worktree)) {
      next = "review";
      this.store.addEvent(taskId, "Sistema", "note", "entrega completa depois do erro (requirements.json com todos os requisitos provados) — status corrigido para pronta pra revisar", true);
    }
    this.store.setStatus(taskId, next);
    if (failed) this.store.addEvent(taskId, role.name, "note", `não consegui rodar — veja o erro acima`, false, role.role);
    else notify("Constellation", `${role.name} respondeu`, task.title);
    // aprende com a mensagem do humano (fire-and-forget — não atrasa o turno)
    if (!asReq) void this.learnFromMessage(message);
  }

  /**
   * REWORK: aplica um ajuste pedido pelo humano (sobre um commit/etapa) numa
   * tarefa já concluída (review/error), continuando a sessão do agente via
   * --resume na worktree existente, recommitando e refazendo o review.
   */
  async reworkTask(taskId: string): Promise<void> {
    await this.withTaskLock(taskId, "rework", {}, () => this.reworkTaskInner(taskId));
  }

  private async reworkTaskInner(taskId: string): Promise<void> {
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
    await this.runTaskInner(taskId); // Inner: o lock/fila já é do chamador
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
