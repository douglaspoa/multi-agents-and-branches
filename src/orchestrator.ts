import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CoordinationBus } from "./bus.ts";
import { globsOverlap } from "./glob.ts";
import { GitService } from "./git.ts";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";
import { buildReview } from "./review.ts";
import { ghBin, netEnv, netTimeoutMs, run, sleep } from "./util/run.ts";
import { notify } from "./util/notify.ts";
import { taskToYaml } from "./util/yaml.ts";
import { prepEpicTurn } from "./epic-context.ts";
import { detectMobileProject, isMobileProject, mobileCleanup, mobileProofGaps, mobileTurnRelease, realDeps, UI_FILE_RE, type MobileDeps } from "./mobile.ts";
import { Brain, extractJson, harvestWorktree, readManifest, seedWorktree, writeManifest, type Note, type NoteInput } from "./memory.ts";
import { execFileSync } from "node:child_process";
import { appendPending, applySkill, itemText, learnedSkills, ownedSkillNames, parseRetro, PERSONA_MAX_CHARS, PERSONA_MIN_N, parseSkillMd, readLearnSettings, readPending, rejectReason, retroOwner, retroPrompt, roleLearningContext, skillsDir, type OwnedSkill, type PendingItem, type SkillEntry, type TeamMember } from "./learn.ts";
import { homedir, userInfo } from "node:os";
import { MockEngine } from "./engine/mock.ts";
import { ClaudeEngine } from "./engine/claude.ts";
import { aiOnce, engineOf, readAiPrefs, type AiTier } from "./ai-once.ts";
import { DshEngine, isDshLabel } from "./engine/dsh.ts";
import { CodexEngine } from "./engine/codex.ts";
import { readAltConfig } from "./engine/altProxy.ts";
import type { AgentEngine } from "./engine/types.ts";
import { activeAgentMemory, activeSkills, agentVersion } from "./agent-versions.ts";
import { agentIdOf, capCheck, capPauseText, effectiveCap, fmtUsdBr, FLOW_BY_KIND, MAX_REVIEW_ROUNDS, parseVerdict, producerIndex, reviewDecision, reviewerIsSame, roundText, rosterLine, SAME_REVIEWER_WARNING, taskKindOf, upsertRoleRun, verdictInstructions, starforkReport, type NeedsYou, type ReportData, type ReviewRound, type RoleRun, type Verdict } from "./lifecycle.ts";
import { ensureHandoff, handoffRule, hasHandoff, HANDOFF_REL, readHandoff } from "./handoff.ts";
import { loadConfig } from "./config.ts";
import { oldVerdict, saveSample, type SampleResult } from "./amostra.ts";
import { recordUsage } from "./usage-ledger.ts";
import { ASK_STYLE } from "./ask-style.ts";
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

/**
 * Nome do anexo em .cardume/refs/. Mesmo nome de 2 origens (ex.: ARCHITECTURE.md de 2 tarefas
 * referenciadas) → prefixa a pasta. Aceita "/" e "\": no Windows o split só por "/" devolvia o CAMINHO
 * INTEIRO como nome ("C:\Users\…\spec.pdf") e a cópia pra refs/ falhava calada — o agente ficava sem a spec.
 */
export function refName(src: string, taken: string[]): string {
  const clean = (x: string) => x.replace(/[:*?"<>|]/g, "").trim(); // "C:" de drive não vira "C:-spec.pdf"
  const parts = src.split(/[\\/]/).map(clean).filter(Boolean);
  const base = parts.pop() || "ref";
  let name = base;
  // colide → prefixa a pasta; ainda colide (ou sem pasta) → -2, -3… até ficar livre
  if (taken.includes(name) && parts.length) name = `${parts.pop()}-${base}`;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; taken.includes(name); n++) name = `${stem}-${n}${ext}`;
  return name;
}

/** O dono do lock ainda está vivo? kill 0 (EPERM = existe, de outro usuário) e, com `since` (quando o lock
 * foi pego), um processo que NASCEU depois do lock é um PID reciclado — lock obsoleto. PID morto não segura lock. */
export function pidAlive(pid: number, since: number | null = null): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EPERM") return false;
  }
  if (since) {
    const started = processStartMs(pid);
    if (started !== null && started > since + 2000) return false; // folga: relógio/arredondamento do ps
  }
  return true;
}

/** Início do processo (ms) via `ps -o lstart=` — null quando não dá pra saber (Windows, ps ausente). */
export function processStartMs(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Gerúndio do papel pra frase da pausa ("antes de Nyx revisar"). */
const ROLE_GERUND: Record<string, string> = { planner: "planejar", builder: "construir", reviewer: "revisar", tester: "testar", designer: "desenhar", docs: "escrever", investigator: "investigar" };

/** Teto padrão de Configurações (`costCap` em ~/.constellation/settings.json, espelhado pelo app). */
export function readCostCapSetting(): number {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".constellation", "settings.json"), "utf8"));
    const n = Number(raw?.costCap);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/** Instruções que AGENTES gravam ao editar a spec de outra tarefa (src/agent-edits.ts) — não são correção do humano. */
const AGENT_INSTRUCTION = /\b(ATUALIZOU a spec desta tarefa|APROVOU remover da spec|RECUSOU sua proposta|DESFEZ uma edição anterior da spec)\b/;

/** Teto das chamadas AUXILIARES ao claude (resumo de commit, destiladores) — CARDUME_AUX_TIMEOUT_MS. */
export function auxTimeoutMs(): number {
  const n = Number(process.env.CARDUME_AUX_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}
/** Teto do .cardume/setup.sh do projeto (CARDUME_SETUP_TIMEOUT_MS, padrão 10 min). */
export function setupTimeoutMs(): number {
  const n = Number(process.env.CARDUME_SETUP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
}
/** Motivo legível de um merge que falhou SEM conflito (o git explica em inglês, em várias linhas). */
export function mergeFailReason(text: string): string {
  const t = String(text || "");
  if (/local changes .* would be overwritten|commit your changes or stash them/i.test(t)) return "há mudanças não commitadas no repositório principal que o merge sobrescreveria — commite ou guarde (stash) e tente de novo";
  if (/untracked working tree files would be overwritten/i.test(t)) return "há arquivos não rastreados no repositório principal que o merge sobrescreveria — mova ou apague e tente de novo";
  if (/not something we can merge|unknown revision/i.test(t)) return "a branch da tarefa não existe mais no repositório";
  if (/you have not concluded your merge|MERGE_HEAD exists/i.test(t)) return "já existe um merge em andamento no repositório principal — conclua ou aborte (git merge --abort) antes";
  const line = t.split("\n").map((l) => l.trim()).filter((l) => l && !/^Command failed/i.test(l)).pop() ?? "";
  return line.replace(/^(error|fatal):\s*/i, "").slice(0, 200) || "o git recusou o merge";
}

/** URL do PR na saída do gh (sucesso ou "already exists"): a ÚLTIMA .../pull/N citada. */
export function prUrlFrom(text: string): string {
  const all = String(text || "").match(/https?:\/\/\S+\/pull\/\d+/g);
  return all ? all[all.length - 1] : "";
}

/**
 * Motor de um papel a partir do rótulo salvo. Tolera variações ("Claude · Opus 4.8", "CLAUDE"):
 * o mock só entra quando pedido de fato — uma tarefa real cair no MockEngine por um nome fora
 * da lista "concluía" com código de mentira.
 */
export function engineKind(name: string | undefined): "mock" | "codex" | "gateway" | "logcomex" | "deepseek" | "claude" {
  const n = String(name ?? "").trim().toLowerCase();
  return n === "mock" ? "mock"
    : n.startsWith("codex") ? "codex"
    : isDshLabel(n) ? "deepseek"
    : n.startsWith("gateway") ? "gateway"
    : n.startsWith("logcomex") ? "logcomex"
    : n.startsWith("claude") ? "claude"
    // rótulo desconhecido: a IA PADRÃO do usuário — antes caía no Claude fixo (quem só tem Codex ficava sem nada)
    : (n === "" ? "mock" : defaultEngine());
}

/**
 * IA PADRÃO do usuário (`aiEngine` em ~/.constellation/settings.json, espelhado pelo app). Só vale pra
 * tarefa/papel SEM motor registrado — uma tarefa com motor usa SEMPRE o dela. Sem config → claude (legado).
 */
export function defaultEngine(): "claude" | "codex" | "gateway" | "deepseek" {
  return engineOf(readAiPrefs().engine) ?? "claude";
}

/**
 * MOTOR GRUDADO NA TAREFA: preenche o motor que falta (spec antiga, card do time, papel sem `engine`) com a
 * IA padrão do usuário. Devolve true se mudou algo — quem chama grava o spec, e daí em diante TODO turno
 * (conversa, rework, retomada, entregável, conflito) usa esse motor; nunca troca sozinho pro Claude.
 */
export function stickEngines(spec: TaskSpec): boolean {
  let changed = false;
  const blank = (e: unknown) => !String(e ?? "").trim();
  if (blank(spec.engine)) { spec.engine = defaultEngine(); changed = true; }
  for (const r of spec.roles ?? []) {
    if (blank(r.engine)) { r.engine = spec.engine; if (!r.model && spec.model) r.model = spec.model; changed = true; }
  }
  return changed;
}

/** Motores SEM a ferramenta ask_human do Starfork (não há MCP no codex/gateway): pergunta vai em texto. */
const noAskTool = (engine: string | undefined) => ["codex", "gateway", "logcomex"].includes(engineKind(engine));
/** Papel capaz de conversar/retomar sessão (qualquer motor real — Claude, Codex, gateway). */
const canTalk = (engine: string | undefined) => engineKind(engine) !== "mock";

/**
 * Ambiente do `gh` agindo como a conta do GitHub DESTE repositório (a mesma regra do app, gh_contas.rs): o
 * `.git/config` guarda `credential.https://github.com.username` quando o app escolheu a conta; aí o token dela vai
 * só no GH_TOKEN do filho (nunca no disco/log). Sem conta gravada (ou gh sem ela) → a conta ativa, como antes.
 */
export function ghEnvFor(repo: string): NodeJS.ProcessEnv {
  const env = netEnv();
  try {
    const acc = execFileSync("git", ["-C", repo, "config", "--get", "credential.https://github.com.username"], { encoding: "utf8", timeout: 5000 }).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(acc)) return env;
    const clean = { ...env }; delete clean.GH_TOKEN; delete clean.GITHUB_TOKEN;
    const tok = execFileSync(ghBin(), ["auth", "token", "-h", "github.com", "-u", acc], { encoding: "utf8", timeout: 10_000, env: clean, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (tok && !/\s/.test(tok)) return { ...clean, GH_TOKEN: tok };
  } catch { /* sem conta gravada / gh sem essa conta: segue com a ativa */ }
  return env;
}

/** sha do commit do merge de um PR (gh pr view). Offline/sem gh/não mergeado → "". */
export async function prMergeCommit(prUrl: string, repo: string): Promise<string> {
  try {
    const { stdout } = await run(ghBin(), ["pr", "view", prUrl, "--json", "mergeCommit", "-q", ".mergeCommit.oid"], { cwd: repo, env: ghEnvFor(repo), timeout: 15_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : "";
  } catch { return ""; }
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
    const n = String(name ?? "").trim().toLowerCase();
    const kind = engineKind(name);
    if (kind !== n) console.warn(`[engine] "${name}" interpretado como ${kind}`);
    name = kind;
    if (name === "claude") return new ClaudeEngine({ model, approval });
    if (name === "codex") return new CodexEngine({ model });
    // DeepSeek Harness (beta): open source, só a DEEPSEEK_API_KEY da conta
    if (name === "deepseek") return new DshEngine({ model });
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

    // A pasta do Starfork nunca deve entrar no repo do usuário.
    await this.git.ensureExcluded([".cardume/", ".constellation/"]);
    // base ATUALIZADA: fetch + origin/<base> quando existir (main fresca sempre)
    const baseRef = await this.git.freshBaseRef(base);
    await this.git.worktreeAdd(worktree, branch, baseRef);

    const taskDir = join(worktree, ".cardume");
    await mkdir(taskDir, { recursive: true });

    // Semeia o ambiente: o `git worktree add` NÃO traz o que o git ignora
    // (.env, node_modules, .venv) — e sem isso o agente não consegue RODAR o
    // projeto e queima a sessão redescobrindo o óbvio a cada tarefa.
    const seeded = await this.seedWorktreeEnv(worktree, spec.light === true);
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
          const name = refName(src, names);
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
  private async seedWorktreeEnv(worktree: string, light = false): Promise<string[]> {
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
    // CÉREBRO do projeto (notas .md): cópia de leitura na worktree + manifesto (hash de cada
    // nota semeada) — o agente faz grep e pode criar/atualizar notas; harvestBrain leva de volta
    // SÓ o que ele mudou desde a semeadura.
    try {
      const n = Object.keys(seedWorktree(this.brain(), worktree)).length;
      if (n) seeded.push(`.cardume/memoria/ (cérebro do projeto, ${n} nota(s))`);
    } catch { /* memória nunca derruba a criação da tarefa */ }
    // FAIXA LEVE: mudança pequena não vale o custo de linkar deps + rodar setup.sh
    // (o VoC aponta: "não vale a pena pra uma correção que a IA faz em 10min").
    if (!light) {
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
        try {
          await run("bash", [hook], { cwd: worktree, env: { ...process.env, CARDUME_MAIN_REPO: this.ws.repo }, timeout: setupTimeoutMs() });
          seeded.push(".cardume/setup.sh executado");
        } catch (err) {
          // antes: sem teto (um setup.sh que sobe servidor ou espera input travava a CRIAÇÃO da tarefa pra
          // sempre) e a falha sumia calada — agora o agente lê no AMBIENTE.md que o setup não completou
          const e = err as Error & { killed?: boolean; stderr?: string };
          const why = e.killed ? `passou de ${Math.round(setupTimeoutMs() / 1000)}s e foi interrompido` : String(e.stderr || e.message || "").trim().split("\n").pop()?.slice(0, 160);
          seeded.push(`.cardume/setup.sh NÃO completou (${why}) — confira o ambiente antes de rodar o projeto`);
        }
      } catch { /* sem hook — os envs/links acima já valem */ }
    } else {
      seeded.push("faixa leve (deps não linkadas)");
    }
    return seeded;
  }

  // ---------------------------------------------------------------------------
  // MEMÓRIA DO PROJETO = CÉREBRO (src/memory.ts): notas .md ligadas por [[links]]
  // em .cardume/memoria/ (local) e .cardume/memoria/time/ (espelho do time).
  // Entra no contexto de TODO turno como índice + notas relevantes à tarefa (com
  // teto) e cresce sozinha: correções do humano no chat e aprendizados do fim da
  // tarefa viram notas (com dedup, links e rastro de quem gravou).
  // ---------------------------------------------------------------------------
  brain(): Brain {
    return new Brain(this.ws.dir);
  }

  projectMemory(spec?: TaskSpec, extra = ""): string {
    let out = "";
    try {
      const q = spec ? [spec.title, spec.objective, ...(spec.requirements ?? []), ...(spec.scope?.owns ?? []), extra].join(" ") : extra;
      const ctx = this.brain().context(q);
      if (ctx) out += ctx.trimEnd() + "\n\n";
    } catch { /* memória nunca derruba o turno */ }
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
    // mesma flag do motor (node sem node:sqlite estável precisa de --experimental-sqlite)
    const node = `"${process.execPath}"` + (process.execArgv.includes("--experimental-sqlite") ? " --experimental-sqlite" : "");
    const cli = process.argv[1] || "";
    const repo = this.ws.repo;
    return (
      `\n\n## Criar novas demandas / épicos — VOCÊ PODE (não mexa no state.sqlite na mão, não invente CLI)\n` +
      `Se o humano pedir pra criar tarefas, issues, demandas ou um épico, use o comando OFICIAL abaixo (roda de qualquer pasta; o \`--repo\` é o que importa):\n\n` +
      `\`\`\`bash\n` +
      `${node} "${cli}" new --repo "${repo}" \\\n` +
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
  skillsContext(role?: { agentId?: string; name?: string }): string {
    // P9: skill/nota com DONO vai só pro papel dono (todos os motores recebem este mesmo bloco; o terminal também)
    try {
      let list: SkillEntry[] = [];
      try { const arr = JSON.parse(readFileSync(join(this.ws.dir, "skills.json"), "utf8")); if (Array.isArray(arr)) list = arr; } catch { /* sem skills.json */ }
      const agentId = agentIdOf(role as AgentRole | undefined);
      const owned: OwnedSkill[] = [];
      for (const name of ownedSkillNames(list, agentId)) {
        try {
          const s = parseSkillMd(readFileSync(join(skillsDir(this.ws.repo), name, "SKILL.md"), "utf8"));
          owned.push({ name, description: s.description, body: s.body });
        } catch { /* skill arquivada/sumiu: fica de fora */ }
      }
      return roleLearningContext({ skills: list, owned, notes: activeAgentMemory(this.ws.dir, agentId), agentName: role?.name });
    } catch {
      return "";
    }
  }


  /**
   * Issue do tracker desta demanda (.cardume/issue.json — config compartilhada por
   * projeto+time, espelhada da nuvem pelo app). Dois casos:
   *  - já existe issueUrl (humano colou na Nova demanda) → só REFERENCIAR, não recriar;
   *  - projeto tem "criar issue ao abrir demanda" ligado e ainda não há issueUrl →
   *    o agente CRIA a issue seguindo as instruções do projeto e registra via set_issue.
   */
  /**
   * Tarefa SOB ÉPICO: o que ela prova (verify), o "pronto quando" do épico e a tool que o REVISOR usa pra
   * marcar um item provado. O contexto compilado do épico (goal, irmãs, decisões) é do épico 2 — aqui é só o
   * mínimo pra o revisor saber julgar e o builder não inventar escopo.
   */
  /** Início de todo turno de tarefa de épico: EPIC.md + "pronto quando" frescos do contexto que o app grava. */
  private prepEpic(spec: TaskSpec, cwd: string): void {
    try { prepEpicTurn({ store: this.store, cardumeDir: this.ws.dir, spec, cwd }); } catch { /* best-effort: o turno segue */ }
  }

  epicContext(spec: TaskSpec): string {
    if (!spec.epicId) return "";
    const dw = (spec.epicDoneWhen ?? []).filter(Boolean);
    const checked = new Set((spec.epicChecks ?? []).map((c) => c.id));
    let out = `\n\n## ESTA TAREFA É PARTE DE UM ÉPICO\n`;
    if ((spec.refs ?? []).some((r) => /^EPIC\.md$/i.test(r))) out += `LEIA PRIMEIRO .cardume/refs/EPIC.md: é o contexto compilado do épico (objetivo, requisitos, pronto quando, tarefas irmãs e o que cada uma prova). Não releia as irmãs: o arquivo já traz o que importa.\n`;
    out += `As outras tarefas do épico rodam EM PARALELO em branches próprias: fique no seu escopo (owns) e não toque no das irmãs; o que precisar delas, assuma pela interface descrita, não implemente por elas.\n`;
    if (spec.verify) out += `O que ESTA tarefa tem que provar: ${spec.verify}\n`;
    if (spec.covers?.length) out += `Requisitos do épico que ela cobre: ${spec.covers.join(", ")}\n`;
    if (spec.boundaries?.length) out += `NÃO muda: ${spec.boundaries.join("; ")}\n`;
    if (dw.length) {
      out += `"Pronto quando" do épico (o épico só fecha com tudo marcado):\n` + dw.map((d) => `- ${checked.has(String(d).split(":")[0].trim().toUpperCase()) ? "[x]" : "[ ]"} ${d}`).join("\n") + "\n";
      out += `PAPEL REVISOR: ao terminar a revisão, se a sua evidência PROVA um desses itens (teste rodado, tela vista, comando executado), chame mcp__cardume__check_done_when({ id: "D<n>", evidence }) — um chamado por item, só com prova real. Builder e outros papéis NÃO chamam essa tool.\n`;
    }
    return out;
  }

  issueContext(spec: TaskSpec): string {
    if (spec.issueUrl) {
      return `\n\n## ISSUE DESTA DEMANDA (já criada) — ${spec.issueUrl}\n` +
        `Esta demanda JÁ tem uma issue no tracker. NÃO crie outra. Referencie-a nos commits e no PR (ex.: "closes ${spec.issueUrl}") e trate-a como fonte do escopo.\n`;
    }
    if (spec.issueCode) {
      // o painel de Issues do app já criou/vinculou a issue (trackers sem URL web: só o código)
      return `\n\n## ISSUE DESTA DEMANDA (já criada) — ${spec.issueCode}\n` +
        `Esta demanda JÁ tem a issue ${spec.issueCode} no painel do time. NÃO crie outra nem mude o status dela (o app sincroniza). Cite ${spec.issueCode} nos commits e no PR.\n`;
    }
    try {
      const raw = readFileSync(join(this.ws.dir, "issue.json"), "utf8");
      const cfg = JSON.parse(raw);
      const instr = String(cfg?.instructions || "").trim();
      if (!cfg?.enabled || !instr) return "";
      const titleTpl = String(cfg?.titleTemplate || "").trim();
      const bodyTpl = String(cfg?.bodyTemplate || "").trim();
      let out =
        `\n\n## CRIAR ISSUE ANTES DE COMEÇAR — regra deste projeto (compartilhada com o time)\n` +
        `Este projeto exige abrir uma issue no tracker ANTES do trabalho principal. Faça isto como PRIMEIRO passo:\n` +
        `1) Crie a issue seguindo EXATAMENTE estas instruções do projeto:\n${instr}\n` +
        `2) Título: ${titleTpl || "derive do título/objetivo do TASK.yaml"}. Corpo: ${bodyTpl || "objetivo + requisitos do TASK.yaml, em Markdown"}.\n` +
        `3) Assim que tiver a URL, chame mcp__cardume__set_issue({ url }) pra registrar o link (o time vê a issue por ali) — e só então prossiga.\n` +
        `Se a criação falhar (credencial/endpoint), NÃO invente link: chame mcp__cardume__ask_human explicando o erro literal e aguarde.\n`;
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

  /** Nome de quem fala com os agentes nesta máquina (rastro das notas). */
  private humanName(): string {
    if (this._human) return this._human;
    let n = (process.env.CARDUME_USER_NAME || "").trim();
    if (!n) {
      try {
        n = execFileSync("git", ["-C", this.ws.repo, "config", "user.name"], { encoding: "utf8", timeout: 3000 }).trim();
      } catch { /* sem git config */ }
    }
    if (!n) { try { n = userInfo().username; } catch { /* sem usuário */ } }
    this._human = n || "você";
    return this._human;
  }
  private _human = "";

  /** Títulos das notas existentes (pra o destilador ligar e não duplicar). */
  private brainCatalog(): string {
    try {
      return this.brain().list(true).slice(0, 80).map((n: Note) => `- ${n.slug}: ${n.title} (${n.type})`).join("\n");
    } catch { return ""; }
  }

  /** Roda a IA auxiliar (destiladores, retro) na IA padrão do usuário (src/ai-once.ts). Padrão: nível
   * rápido (Haiku no Claude). `claudeModel` só vale no Claude; Codex/gateway usam o nível. "" em qualquer falha. */
  private async aux(prompt: string, tier: AiTier = "rapido", claudeModel = "claude-haiku-4-5-20251001", timeout = auxTimeoutMs(), taskId?: string, onCost?: (usd: number) => void): Promise<string> {
    try {
      // teto: sem ele uma IA pendurada deixava o processo do motor vivo pra sempre (fire-and-forget)
      // livro de uso: retro e aprendizados do chat contam como "retro"
      return await aiOnce(prompt, { tier, claudeModel, timeout, usage: { source: "retro", project: this.ws.repo, taskId }, onCost });
    } catch { return ""; }
  }

  private noteFromJson(o: any, by: string): NoteInput | null {
    if (!o || typeof o !== "object") return null;
    const title = String(o.title ?? "").trim();
    const body = String(o.body ?? "").trim();
    if (title.length < 4 || body.length < 8 || title.length > 140 || body.length > 2000) return null;
    return {
      title,
      type: String(o.type ?? "contexto"),
      tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : [],
      body,
      by,
      origem: "agente",
    };
  }

  /**
   * Destila uma mensagem do humano no chat em NOTA duradoura (regra/decisão…) do
   * cérebro: cria ou atualiza (dedup) com [[links]] pras notas que já existem.
   * Fire-and-forget: nunca quebra o turno.
   */
  private async learnFromMessage(message: string, taskTitle = "", taskId?: string): Promise<void> {
    const msg = message.trim();
    if (msg.length < 12) return;
    try {
      const catalog = this.brainCatalog();
      const prompt =
        `Mensagem de um dev pro agente de IA durante uma tarefa:\n"""${msg.slice(0, 800)}"""\n\n` +
        `Notas que já existem no cérebro do projeto (slug: título):\n${catalog || "(nenhuma)"}\n\n` +
        `Se a mensagem contém uma REGRA/PREFERÊNCIA/DECISÃO DURADOURA de trabalho (vale pra tarefas futuras — ex.: como testar, ferramenta a usar, convenção de git/PR, decisão de produto), ` +
        `responda SÓ um JSON {"title":"título curto e geral","type":"regra|decisão|gotcha|contexto|glossário|pessoa","tags":["tema"],"body":"1-3 frases em português, imperativas e gerais (sem citar a tarefa), com [[slug]] pras notas existentes relacionadas e/ou [[tema]] pro assunto (ex.: [[ferramentas]])"}. ` +
        `Se já existe nota sobre o MESMO assunto, use exatamente o título dela. NUNCA inclua segredos, chaves, senhas ou valores de .env. ` +
        `Se for só um pedido pontual desta tarefa, responda exatamente: SKIP`;
      const out = await this.aux(prompt, undefined, undefined, undefined, taskId);
      if (!out || /^skip\b/i.test(out.split("\n").pop()?.trim() ?? "")) return;
      const who = this.humanName();
      const note = this.noteFromJson(extractJson(out), `destilador · correção de ${who}${taskTitle ? ` no chat da tarefa "${taskTitle.slice(0, 60)}"` : ""}`);
      if (note && this.brain().write(note)?.action === "secret") this.noteSecretDropped(taskId, "uma correção do chat");
    } catch {
      /* aprender é melhor-esforço — nunca quebra o turno */
    }
  }

  /**
   * FIM DA TAREFA — RETRO (aprendizado contínuo): relê o que aconteceu (correções do humano,
   * retrabalho, review, eventos) e propõe NOTAS (fatos) e SKILLS aprendidas (procedimentos).
   * learnMode "sugerir" (padrão) → fila .cardume/aprendizado/pendentes.json (o humano aceita na
   * aba Memória); "auto" → aplica direto; "desligado" → nenhuma chamada de IA.
   * Fire-and-forget: nunca quebra a tarefa.
   */
  private async retroTask(taskId: string): Promise<void> {
    try {
      const { mode, model } = readLearnSettings();
      if (mode === "desligado") return;
      const t = this.store.getTask(taskId);
      if (!t) return;
      const spec = JSON.parse(t.spec_json) as TaskSpec;
      const all = this.store.eventsForTask(taskId);
      // correções do humano, em ordem: mensagens do chat ("Você: …", gravadas como "Você"/nome dele) +
      // instruções de ajuste não canceladas (as geradas por agentes editando a spec ficam de fora).
      // Eventos do sistema ("requisito adicionado: …", "instrução enviada: …") NÃO contam.
      const me = this.humanName();
      const chat = all
        .filter((e) => e.type === "note" && (e.agent === "Você" || e.agent === me) && /^Você:\s*/.test(String(e.text)))
        .map((e) => ({ at: Number(e.ts) || 0, text: String(e.text).replace(/^Você:\s*/, "") }));
      const instr = this.store.instructionsFor(taskId).filter((i) => !AGENT_INSTRUCTION.test(i.text)).map((i) => ({ at: i.created_at, text: i.text }));
      const seen = new Set<string>();
      const corrections = [...chat, ...instr]
        .sort((a, b) => a.at - b.at)
        .map((c) => c.text.trim())
        .filter((x) => x && !seen.has(x) && !!seen.add(x))
        .slice(-20); // as mais recentes
      // rodadas de retrabalho = o que o reworkTaskInner registra (o work_queue só existe com a tarefa ocupada)
      const reworks = all.filter((e) => e.type === "note" && /^rework: aplicando ajuste/.test(String(e.text))).length;
      const events = all
        .filter((e) => (e.type === "done" || e.type === "note") && e.agent !== "Você" && e.agent !== "Sistema")
        .slice(-25)
        .map((e) => `- ${e.agent}: ${String(e.text).replace(/\s+/g, " ").slice(0, 300)}`);
      if (!events.length && !corrections.length) return;
      // P6: a retro roda DENTRO do teto — com a tarefa já em 80% dele, é pulada e avisa em palavra
      if (!spec.autopilot) {
        const cap = effectiveCap(spec.budgetUsd, readCostCapSetting());
        const spent = this.store.taskSpend(taskId);
        if (capCheck(spent, cap) === "pausa") {
          this.store.addEvent(taskId, "Sistema", "retro", `retro pulada: a tarefa já usou ${fmtUsdBr(spent)} de ${fmtUsdBr(cap)} do teto — nada foi aprendido desta vez`, false);
          return;
        }
      }
      const learned = learnedSkills(this.ws.repo);
      // P9: a equipe (com id estável) e o que a revisão devolveu — com quem produziu — pra retro dar DONO a cada item
      const team: TeamMember[] = [];
      for (const r of Array.isArray(spec.roles) ? spec.roles : []) {
        const id = agentIdOf(r);
        if (id && !team.some((m) => m.agentId === id)) team.push({ agentId: id, name: r.name, role: r.role });
      }
      const roles = Array.isArray(spec.roles) ? spec.roles : [];
      // quem produziu o que ESTA rodada revisou (o revisor da rodada, pelo id ou nome; senão o 1º revisor)
      const producerOf = (x: ReviewRound) => {
        let ri = roles.findIndex((r) => r.role === "reviewer" && ((x.agentId && agentIdOf(r) === x.agentId) || r.name === x.reviewer));
        if (ri < 0) ri = roles.findIndex((r) => r.role === "reviewer");
        return ri >= 0 ? roles[producerIndex(roles, ri)] : undefined;
      };
      const reviewAsks = (Array.isArray(spec.reviewRounds) ? spec.reviewRounds : [])
        .filter((x) => x.verdict === "muda")
        .flatMap((x) => { const p = producerOf(x); return (x.items ?? []).map((it) => `${x.reviewer || "o revisor"} pediu a ${p?.name ?? "quem construiu"} (${agentIdOf(p) || "?"}): ${it}`); });
      // F5: persona sugerida reaberta com a trava da Júlia — só pra quem tem a P12 madura (n ≥ 10 tarefas no portão na
      // versão ATUAL) e está no catálogo do projeto (a persona mora no cardume.config.json)
      // só o catálogo DO REPO (cardume.config.json): é lá que o aceite grava a persona (agente global/padrão não entra)
      const catalog = (() => { try { const j = JSON.parse(readFileSync(join(this.ws.repo, "cardume.config.json"), "utf8")); return Array.isArray(j?.agents) ? j.agents as { id: string; persona?: string }[] : []; } catch { return []; } })();
      const personaAgents = team.map((m) => {
        const a = catalog.find((x) => x.id === m.agentId);
        if (!a) return null;
        const n = this.store.agentVersionGateCount(m.agentId, agentVersion(this.ws.dir, m.agentId));
        // persona longa demais pro prompt: não sugere (reescrever a partir de um corte apagaria o resto)
        if (String(a.persona ?? "").length > PERSONA_MAX_CHARS) return null;
        return n >= PERSONA_MIN_N ? { agentId: m.agentId, name: m.name, n, persona: String(a.persona ?? "") } : null;
      }).filter((x): x is { agentId: string; name: string; n: number; persona: string } => !!x);
      const out = await this.aux(retroPrompt({
        title: spec.title,
        objective: String(spec.objective ?? ""),
        requirements: Array.isArray(spec.requirements) ? spec.requirements.map(String) : [],
        corrections,
        reworks,
        reviewSummary: this.store.getReview(taskId)?.summary ?? "",
        events,
        brainCatalog: this.brainCatalog(),
        learnedSkills: learned,
        alreadySuggested: readPending(this.ws.dir).filter((p) => p.taskId === taskId).map((p) => p.nota ? `nota: ${p.nota.title}` : p.persona ? `persona de ${p.agente ?? ""}` : `skill: ${p.skill?.nome ?? ""}`),
        team,
        reviewAsks,
        personaAgents,
      }), "capaz", model, Math.max(auxTimeoutMs(), 180_000), taskId, (usd) => {
        // o gasto da retro conta no teto e no custo por papel (agente "retro"); o livro de uso o aiOnce já gravou
        if (usd > 0) { try { this.store.addCostLocal(taskId, "retro", "retro", usd, 0, 0, 0, "retro"); } catch { /* sem store */ } }
      }); // retroModel vale só no Claude (Codex/gateway: nível capaz); ~10k chars: teto próprio
      if (!out) { this.store.addEvent(taskId, "Sistema", "retro", "retro: a IA não respondeu — nada foi aprendido desta vez", false); return; }
      const { notas, skills, personas } = parseRetro(out);
      const learnedNames = new Set(learned.map((s) => s.name));
      const items: Omit<PendingItem, "id" | "createdAt">[] = [];
      const base = { taskId, taskTitle: String(spec.title ?? "").slice(0, 140) };
      // P9: dono validado contra a equipe (fora dela = "projeto"); a v1 só tem nota e skill — nada de persona/modelo
      const owner = (dono: string | undefined) => {
        const o = retroOwner(dono, team);
        return o ? { agente: o.agente, papel: o.papel, agenteNome: o.nome } : {};
      };
      for (const { dono, ...n } of notas) items.push({ ...base, kind: "nota", nota: n, ...owner(dono) });
      // "atualizar" só vale pra skill APRENDIDA que existe; o resto vira "criar" (colisão → nome-2 ao aplicar)
      for (const { dono, ...s } of skills) items.push({ ...base, kind: "skill", skill: { ...s, acao: s.acao === "atualizar" && learnedNames.has(s.nome) ? "atualizar" : "criar" }, ...owner(dono) });
      // persona: dono OBRIGATÓRIO e elegível (a retro não inventa agente nem fura a trava); `antes` = a persona de agora
      for (const { dono, ...p } of personas) {
        const o = retroOwner(dono, team);
        const el = o ? personaAgents.find((x) => x.agentId === o.agente) : undefined;
        if (!o || !el || p.texto.trim() === el.persona.trim()) continue;
        items.push({ ...base, kind: "persona", persona: { ...p, antes: el.persona }, agente: o.agente, papel: o.papel, agenteNome: o.nome });
      }
      const ok = items.filter((it) => {
        const why = rejectReason(itemText(it));
        if (!why) return true;
        const what = it.nota ? `a nota proposta "${it.nota.title.slice(0, 60)}"` : it.persona ? `a persona proposta pra ${it.agenteNome ?? it.agente}` : `a skill proposta "${it.skill!.nome}"`;
        if (why === "segredo") this.noteSecretDropped(taskId, `${what} da retro`);
        else this.learnDropped(taskId, `aprendizado: descartei ${what} da retro — parecia conter instruções pro agente (injeção); nada foi gravado`);
        return false;
      });
      if (!ok.length) { this.store.addEvent(taskId, "Sistema", "retro", "retro: nada novo pra aprender desta tarefa", true); return; }
      if (mode === "sugerir") {
        const added = appendPending(this.ws.dir, ok);
        this.store.addEvent(taskId, "Sistema", "retro", added.length ? `retro: ${added.length} aprendizado${added.length === 1 ? "" : "s"} pra você revisar` : "retro: nada novo pra aprender desta tarefa", true);
        if (added.length) this.learnDropped(taskId, `aprendizado: ${added.length} sugest${added.length === 1 ? "ão" : "ões"} da retro pra revisar — na etapa Retro desta tarefa, na ficha do agente (Meu time) ou na Memória`);
        return;
      }
      // modo automático: aplica direto o que iria pra fila — MENOS o que tem agente dono (K3: o `auto` nunca muda
      // agente; esses itens vão pra fila e só entram com o aceite item a item)
      const held = ok.filter((it) => !!it.agente);
      const brain = this.brain();
      const by = `agente · retro da tarefa "${String(spec.title).slice(0, 60)}" (${taskId})`;
      const done: string[] = [];
      for (const it of ok.filter((x) => !x.agente)) {
        try {
          if (it.nota) {
            const r = brain.write({ ...it.nota, by, origem: "agente" });
            if (r?.action === "secret") this.noteSecretDropped(taskId, "um aprendizado da retro");
            else if (r) done.push(`nota "${it.nota.title.slice(0, 60)}"`);
          } else if (it.skill) {
            const r = applySkill(this.ws.repo, this.ws.dir, it.skill, taskId);
            done.push(`skill ${r.name} (${r.action === "updated" ? "atualizada" : "nova"})`);
          }
        } catch { /* um item ruim não derruba os outros */ }
      }
      if (done.length) this.learnDropped(taskId, `aprendizado automático: ${done.join(", ")}`);
      if (held.length) {
        const added = appendPending(this.ws.dir, held);
        if (added.length) this.learnDropped(taskId, `aprendizado: ${added.length} item(ns) de agente ficaram pra você aceitar (o automático não muda agente)`);
      }
      this.store.addEvent(taskId, "Sistema", "retro", `retro: ${done.length + held.length} aprendizado(s)`, true);
    } catch { /* melhor-esforço — nunca quebra a tarefa */ }
  }

  /** Aviso do aprendizado no chat da tarefa (e no log do motor). */
  private learnDropped(taskId: string, msg: string): void {
    console.warn(`[aprendizado] ${msg}`);
    try { this.store.addEvent(taskId, "Sistema", "note", msg, false); } catch { /* sem store */ }
  }

  /** Nota descartada por parecer segredo: avisa no chat da tarefa (nunca some calada). */
  private noteSecretDropped(taskId: string | undefined, what: string): void {
    const msg = `memória: descartei ${what} — parecia conter segredo (chave/senha/.env); nada foi gravado no cérebro`;
    console.warn(`[memória] ${msg}`);
    if (taskId) { try { this.store.addEvent(taskId, "Sistema", "note", msg, false); } catch { /* sem store */ } }
  }

  /**
   * O agente pode CRIAR/ATUALIZAR notas em .cardume/memoria/ na worktree — aqui volta pro
   * cérebro do repo principal SÓ o que mudou desde a semeadura (manifesto), com rastro da
   * tarefa. Nunca apaga nem ressuscita nota apagada; se o humano editou depois, ele vence.
   */
  private harvestBrain(worktree: string, taskId: string, taskTitle: string): void {
    try {
      const r = harvestWorktree(this.ws.dir, worktree, readManifest(worktree), `agente · tarefa "${taskTitle.slice(0, 60)}" (${taskId})`);
      writeManifest(worktree, r.manifest);
      for (const k of r.secrets) this.noteSecretDropped(taskId, `a nota ${k}.md`);
    } catch { /* colher memória é melhor-esforço */ }
  }

  // ---------------------------------------------------------------------------
  // FILA DE TRABALHO: uma tarefa roda UM turno por vez. Pedidos feitos enquanto
  // o agente está ocupado (falar, revisar PR, entregáveis) NÃO se perdem nem
  // atropelam o turno atual — entram na fila (com aviso no chat) e rodam
  // automaticamente quando o turno terminar. O "lock" é o busy_pid no banco,
  // validado com kill(pid, 0) — processo morto não segura fila.
  // ---------------------------------------------------------------------------


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
  static networkDeath(text: string): boolean {
    // + ENOTFOUND (DNS caiu no meio) e a frase humana do Codex ("Caiu a conexão do Codex…")
    return /socket connection was closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network error|other side closed|Connection error|stream disconnected|error sending request|caiu a conex[aã]o do codex/i.test(text || "");
  }
  /** `--resume <id>` sem a sessão no disco (Claude guarda por pasta; histórico apagado/outra máquina). */
  static sessionMissing(text: string): boolean {
    // + mensagens do Codex (`codex exec resume <id>` sem a sessão: outra máquina, id de outro motor…)
    return /no conversation found|session (id )?.{0,60}not found|could not find session|no saved session found|thread not found|no rollout found|resume failed/i.test(text || "");
  }
  /** Nota do pipeline parado: diz O MOTIVO (a 1ª parte do erro, já humana) e a saída — antes era só
   * "não concluiu (timeout/erro)" e quem lia (caso do Roberto, 02/10) não sabia o que fazer. */
  static stoppedNote(role: string, deathText: string): string {
    const why = String(deathText || "").split(/\n\s*\n/)[0].trim().slice(0, 500).replace(/[\s.]+$/, "");
    const next = /rodar de novo|mande (a|uma) mensagem/i.test(why) ? "" : ` Depois de resolver, clique em "rodar de novo" ou mande uma mensagem pra ele seguir de onde parou.`;
    return `pipeline parado: o papel ${role} não concluiu — ${why || "o agente encerrou com erro sem detalhes (veja o log acima)"}.${next}`;
  }
  static retriableDeath(text: string): boolean {
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
  async verifyProofs(taskId: string, task: TaskRow, spec: TaskSpec, opts: { runTests?: boolean } = {}): Promise<{ ok: boolean; reasons: string[] }> {
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
      const hasReal = ev.some((e) => evidenceExists(artDir, task.worktree, String(e)));
      if (!hasReal) reasons.push(`requisito "done" sem evidência real no disco: ${label}`);
    }
    // PROVA MOBILE: em app iOS/Android, requisito visual (ou a tarefa que mexeu em tela) precisa de print/vídeo real
    try {
      if (isMobileProject(detectMobileProject(task.worktree))) {
        const uiChanged = (await this.changedFiles(task.worktree, task.base)).some((f) => UI_FILE_RE.test(f));
        reasons.push(...mobileProofGaps(list as never, uiChanged, (e) => evidenceExists(artDir, task.worktree, e)));
      }
    } catch { /* sem detecção/diff: fica só a regra geral */ }
    const wantsTests = spec.autonomy?.runTests === true || (spec.artifacts ?? []).some((a) => a.kind === "tests");
    // runTests:false = consulta SEM efeito colateral (task_status no terminal): não roda a suíte (até 180s)
    if (wantsTests && opts.runTests !== false) {
      const t = await this.runRepoTests(task.worktree);
      if (t.ran && !t.passed) reasons.push(`os testes falharam: ${t.detail}`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** Arquivos mudados na branch (commits desde a base + o que está solto). Falhou → [] (regra leniente). */
  private async changedFiles(worktree: string, base: string): Promise<string[]> {
    const out = new Set<string>();
    try { for (const l of (await run("git", ["-C", worktree, "diff", "--name-only", `${base}...HEAD`])).stdout.split("\n")) if (l.trim()) out.add(l.trim()); } catch { /* base sumiu */ }
    try { for (const l of (await run("git", ["-C", worktree, "status", "--porcelain"])).stdout.split("\n")) if (l.trim()) out.add(l.slice(3).trim()); } catch { /* sem git */ }
    return [...out];
  }

  /** Roda o teste do repo NA WORKTREE, se houver `scripts.test` real. Timeout 180s. */
  private async runRepoTests(worktree: string): Promise<{ ran: boolean; passed: boolean; detail: string }> {
    // SÓ a falta do package.json (projeto não-node, ou ainda vazio) = sem comando de teste. package.json
    // ilegível/quebrado continua REPROVANDO, como antes (o projeto não roda).
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ran: false, passed: true, detail: "sem package.json" };
      return { ran: true, passed: false, detail: `package.json inválido: ${String((err as Error)?.message ?? err).slice(0, 140)}` };
    }
    try {
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

  /**
   * SEQUENTIAL-LOCK honrado: se a política é sequential-lock e o escopo desta
   * tarefa colide com o de outra que está EDITANDO agora (running/thinking) e é
   * MAIS VELHA, espera ela liberar antes de começar — assim as duas rodam em
   * sequência em vez de brigar no merge. Regra "mais novo espera o mais velho"
   * evita deadlock (duas tarefas não ficam esperando uma à outra).
   */
  private async waitForScopeClear(taskId: string, spec: TaskSpec): Promise<void> {
    if (this.bus.policy !== "sequential-lock") return;
    const mine = (spec.scope?.owns ?? []).map((s) => s.trim()).filter(Boolean);
    if (!mine.length) return;
    const myCreated = this.store.getTask(taskId)?.created_at ?? Date.now();
    const blockers = () =>
      this.store.listTasks().filter((t) => {
        if (t.id === taskId) return false;
        if (!["running", "thinking"].includes(t.status)) return false; // só quem edita AGORA
        if ((t.created_at ?? 0) >= myCreated) return false; // mais novo espera o mais velho
        let owns: string[] = [];
        try { owns = (JSON.parse(t.spec_json) as TaskSpec).scope?.owns ?? []; } catch { /* ignora */ }
        return mine.some((m) => owns.some((o) => globsOverlap(m, o)));
      });
    const deadline = Date.now() + 30 * 60_000; // teto de 30min esperando
    let announced = false;
    while (Date.now() < deadline) {
      const b = blockers();
      if (!b.length) break;
      if (!announced) {
        announced = true;
        this.store.addEvent(taskId, spec.agent, "blocked", `sequential-lock: aguardando ${b.map((x) => x.id).join(", ")} liberar o escopo`, false);
      }
      await sleep(3000);
    }
    if (announced) this.store.addEvent(taskId, spec.agent, "note", "escopo liberado — seguindo", true);
  }

  /** O erro é o LIMITE DE USO/RATE da conta (não o contexto)? Esses resetam com o
   * tempo — a saída é ESPERAR e retomar, não recomeçar na hora. */
  static usageLimitDeath(text: string): boolean {
    return /session limit|usage limit|hit your .{0,24}limit|rate[ _-]?limit|too many requests|\b429\b|quota|resets? (at|\d)|limit reached|upgrade to increase|please try again later/i.test(text || "");
  }

  /** Regra da conversa pros motores COM ask_human (Claude, DeepSeek): pergunta e espera no mesmo turno. */
  private static readonly CHAT_RULE_ASK =
    "\n\n[CONVERSA CONTÍNUA — NÃO FINALIZE SOZINHO] (1) Precisando de QUALQUER resposta/decisão minha, chame mcp__cardume__ask_human (com options quando fizer sentido) e AGUARDE — a conversa segue no MESMO turno; NUNCA finalize com pergunta em texto. (2) Ao CONCLUIR o pedido, também NÃO finalize: chame ask_human dizendo o que fez e perguntando se quero mais algum ajuste (ex.: options ['Está ótimo, pode finalizar','Quero ajustar algo']) e AGUARDE. (3) Só finalize de verdade quando eu mandar (ex.: 'pode finalizar') ou quando o sistema avisar que estou inativo — aí encerre com um resumo educado. (4) PEDIDO NOVO = REGISTRO OBRIGATÓRIO: se a minha mensagem pedir algo que ainda NÃO fazia parte da tarefa (não é correção/ajuste do que você já fez), registre PRIMEIRO com mcp__cardume__add_requirement (critério curto e verificável — ele entra na checklist X/Y que eu acompanho) e, sendo uma entrega nova, TAMBÉM com mcp__cardume__add_deliverable; só então implemente. 'Entender' o pedido sem registrar NÃO vale — pedido registrado só na conversa não conta na checklist." + ASK_STYLE;
  /** Regra da conversa pros motores SEM ask_human (Codex/gateway): mandar o agente "chamar ask_human e AGUARDAR"
   * sem ter a ferramenta o deixava preso esperando (sleep/loop) até o watchdog de inatividade matar o turno. */
  private static readonly CHAT_RULE_TEXT =
    "\n\n[CONVERSA CONTÍNUA] Neste motor NÃO existe a ferramenta ask_human. (1) Precisando de uma resposta/decisão minha, termine a resposta com a PERGUNTA em texto (objetiva; numere as opções quando fizer sentido) e finalize o turno — eu respondo aqui na conversa e você continua desta mesma sessão. NUNCA fique esperando resposta (sleep, loop, polling). (2) Ao CONCLUIR o pedido, diga em poucas linhas o que fez e pergunte se quero mais algum ajuste. (3) PEDIDO NOVO (algo que não fazia parte da tarefa): diga explicitamente no fim que é um requisito novo, pra eu registrar. Ao perguntar: o contexto em até 3–5 tópicos curtos e, por último, a pergunta em UMA frase curta terminando em '?', com as opções numeradas (rótulo curto — descrição de 1 linha).";

  /** Interlocutor quando a tarefa não tem papel que converse: o motor DA TAREFA (ou a IA padrão do usuário). Nunca o Claude fixo. */
  private static fallbackRole(spec: TaskSpec): TaskSpec["roles"][number] {
    const own = canTalk(spec.engine);
    return { role: "builder", name: spec.agent, engine: own ? spec.engine : defaultEngine(), model: own ? spec.model : (readAiPrefs().model || undefined) } as TaskSpec["roles"][number];
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
  /** Tenta pegar o lock do turno (atômico entre processos — ver Store.tryLockBusy). */
  private tryLock(taskId: string): boolean {
    return this.store.tryLockBusy(taskId, process.pid, pidAlive);
  }

  /** Fim do turno: solta o lock e fecha pergunta que ficou aberta (o processo que esperava a resposta acabou). */
  private releaseTurn(taskId: string): void {
    try {
      if (this.store.closeOpenQuestions(taskId) > 0) {
        this.store.addEvent(taskId, "Sistema", "note", "A pergunta ficou sem resposta e o turno terminou — se ainda quiser responder, mande na conversa: o agente retoma de onde parou.", true);
      }
    } catch { /* banco antigo: segue */ }
    this.store.setBusyPid(taskId, null);
  }

  private async withTaskLock(taskId: string, kind: string, payload: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
    if (!this.tryLock(taskId)) {
      this.store.queueAdd(taskId, kind, payload);
      const pos = this.store.queueCount(taskId);
      // o turno pode ter ACABADO entre a checagem e o enfileiramento (ele já drenou a fila vazia):
      // lock livre agora → FICA com ele e roda a fila daqui (inclui este pedido), sem soltar no meio
      if (this.tryLock(taskId)) {
        this.expireOrphanQueue(taskId);
        try {
          await this.drainLocked(taskId);
        } finally {
          this.releaseTurn(taskId);
          await this.drainQueue(taskId);
          await this.mobileTurnEnd(taskId);
        }
        return;
      }
      this.store.addEvent(
        taskId,
        "Sistema",
        "note",
        `Na fila (${pos}º): ${this.queueLabel(kind, payload)} — o agente está no meio de um turno; executo automaticamente assim que ele terminar.`,
        true,
      );
      return;
    }
    this.expireOrphanQueue(taskId);
    try {
      await fn();
    } finally {
      this.releaseTurn(taskId);
      await this.drainQueue(taskId);
      await this.mobileTurnEnd(taskId);
    }
  }

  /** Pedidos "na fila" são drenados pelo processo que segurava o turno — se ele foi MORTO (■ parar,
   * SIGKILL, app fechado), eles ficavam 'queued' pra sempre: no logcomex-ai-v2 havia 3 mensagens
   * presas desde 01/09 ("esta demorando demais"…) numa tarefa já em 'review'. Aqui, ao pegar o
   * lock: órfãos RECENTES seguem e rodam depois deste turno (drainQueue); os ANTIGOS (> 30 min)
   * são descartados com aviso visível — rodar hoje um "tá demorando" de dias atrás é pior. */
  private expireOrphanQueue(taskId: string, maxAgeMs = 30 * 60_000): void {
    try {
      const n = this.store.queueExpire(taskId, Date.now() - maxAgeMs);
      if (n > 0) {
        this.store.addEvent(taskId, "Sistema", "note", `Fila limpa: ${n === 1 ? "1 pedido antigo descartado" : `${n} pedidos antigos descartados`} — o turno que ia executá-los foi encerrado antes. Se ainda precisar, mande de novo.`, true);
      }
    } catch { /* banco antigo sem work_queue: nada a limpar */ }
  }

  /** Roda os pedidos enfileirados, em ordem, até esvaziar (ou outro processo assumir). */
  private async drainQueue(taskId: string): Promise<void> {
    for (;;) {
      if (!this.store.queueNext(taskId)) return;
      if (!this.tryLock(taskId)) return; // outro processo pegou o lock — ele drena
      try {
        await this.drainLocked(taskId);
      } finally {
        this.releaseTurn(taskId);
      }
    }
  }

  /** Esvazia a fila JÁ segurando o lock (não solta entre um pedido e outro). */
  private async drainLocked(taskId: string): Promise<void> {
    for (;;) {
      const item = this.store.queueNext(taskId);
      if (!item) return;
      if (!this.store.queueDone(item.id)) continue; // outro processo já tomou este pedido
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(item.payload || "{}"); } catch { /* payload corrompido — segue vazio */ }
      this.store.addEvent(taskId, "Sistema", "note", `▶ executando pedido da fila: ${this.queueLabel(item.kind, p)}`, true);
      try {
        if (item.kind === "talk") await this.talkToAgentInner(taskId, String(p.message ?? ""), !!p.asReq, p.agent ? String(p.agent) : undefined);
        else if (item.kind === "deliver") await this.deliverArtifactInner(taskId, (p.kind as "doc" | "tests" | "proof" | "all") ?? "all");
        else if (item.kind === "rework") await this.reworkTaskInner(taskId);
      } catch (err) {
        this.store.addEvent(taskId, "Sistema", "error", `pedido da fila falhou: ${(err as Error).message}`, false);
      }
    }
  }

  /** Roda a equipe da tarefa: cada papel em sequência, na mesma worktree. */
  async runTask(taskId: string): Promise<void> {
    // Duplo "iniciar" (ou iniciar enquanto um turno roda) subia DOIS times na mesma
    // worktree. Outro processo vivo com o lock → recusa, sem mexer no lock dele.
    if (!this.tryLock(taskId)) {
      this.store.addEvent(taskId, "Sistema", "note", "essa tarefa já está rodando — pedido de iniciar ignorado", true);
      return;
    }
    this.expireOrphanQueue(taskId);
    try {
      await this.runTaskInner(taskId);
    } finally {
      this.releaseTurn(taskId);
      await this.drainQueue(taskId);
      await this.mobileTurnEnd(taskId);
    }
  }

  /**
   * P6 (veto da Carla): o teto vale pra TODA tarefa. Gasto ≥ 80% do teto → a tarefa para em "precisa de você"
   * ANTES da próxima etapa (budgetHit + needsYou; o processo termina, nada fica congelado). Liberar mais é da
   * pessoa, com valor e motivo (app: 53-teto-protecao / 60-ciclo) — e retoma daqui (done_roles = i).
   * Tarefa do piloto automático: quem decide é o piloto (o teto dela já é o que sobra do teto dele).
   */
  private capGate(taskId: string, i: number, next: string): boolean {
    const spec = this.freshSpec(taskId);
    if (!spec || spec.autopilot) return false;
    const cap = effectiveCap(spec.budgetUsd, readCostCapSetting());
    const spent = this.store.taskSpend(taskId);
    if (capCheck(spent, cap) === "ok") return false;
    const at = Date.now();
    const text = capPauseText(spent, cap, next);
    this.store.patchSpec(taskId, {
      budgetUsd: cap, // grava o teto que valeu (tarefa sem teto próprio herdou o padrão)
      budgetHit: { usd: Math.round(spent * 10000) / 10000, cap, at, mode: "etapa" },
      needsYou: { kind: "teto", text, at, roleIdx: i } satisfies NeedsYou,
    });
    this.store.setDoneRoles(taskId, i);
    this.store.setStatus(taskId, "needs-you");
    this.store.addEvent(taskId, "Sistema", "note", text, false);
    notify("Starfork", "Precisa de você — a tarefa chegou a 80% do teto", spec.title);
    return true;
  }

  /** Texto do veredito: o .cardume/VEREDITO.md da rodada; sem ele, o que o revisor disse no fim do turno. */
  private async verdictText(taskId: string, worktree: string, reviewer: string, evStart: number): Promise<string> {
    try {
      const f = await readFile(join(worktree, ".cardume", "VEREDITO.md"), "utf8");
      if (f.trim()) return f;
    } catch { /* o revisor não escreveu o arquivo */ }
    return this.store.eventsForTask(taskId, evStart).filter((e) => e.agent === reviewer && (e.type === "done" || e.type === "note" || e.type === "think")).map((e) => e.text).slice(-6).join("\n");
  }

  /** K2: garante o HANDOFF.md do papel que terminou (o dele, ou um escrito daqui com o que ele relatou) e avisa em palavra. */
  private baton(taskId: string, worktree: string, seq: number, from: AgentRole, to: AgentRole | undefined, evStart: number, verdict?: Verdict, received?: string | null): void {
    try {
      const said = this.store.eventsForTask(taskId, evStart).filter((e) => e.agent === from.name && (e.type === "done" || e.type === "note") && e.text && !/^custo do turno/.test(e.text)).map((e) => e.text);
      const r = ensureHandoff(worktree, seq, { from, to, did: said.slice(-3).join("\n"), verdict }, received);
      this.store.addEvent(taskId, "Sistema", "bastao", `bastão: ${from.name} → ${to ? to.name : "fim"} (${HANDOFF_REL}${r.wrote ? ", escrito pelo Starfork com o que o papel relatou" : ""})`, true, from.role, from.agentId);
    } catch { /* o bastão nunca derruba a tarefa */ }
  }

  /** Spec como está no BANCO agora (o app pode ter gravado teto/liberação enquanto o turno rodava). */
  private freshSpec(taskId: string): TaskSpec | undefined {
    try { return JSON.parse(this.store.getTask(taskId)?.spec_json ?? "") as TaskSpec; } catch { return undefined; }
  }

  /** P10: grava o evento "skills ativas: … · agente@vN · motor" do papel e guarda em spec.roleRuns (Relatório do PR). */
  private recordRoleRun(taskId: string, spec: TaskSpec, r: AgentRole): RoleRun {
    const run: RoleRun = {
      role: r.role, agentId: agentIdOf(r) || undefined, name: r.name,
      version: agentVersion(this.ws.dir, agentIdOf(r)), engine: engineKind(r.engine), model: r.model || undefined,
      skills: activeSkills(this.ws.dir, agentIdOf(r)), at: Date.now(),
    };
    try {
      this.store.addEvent(taskId, r.name, "papel", rosterLine(run), true, r.role, r.agentId);
      const cur = this.freshSpec(taskId) ?? spec;
      spec.roleRuns = upsertRoleRun(cur.roleRuns, run);
      this.store.patchSpec(taskId, { roleRuns: spec.roleRuns });
    } catch { /* medição nunca derruba o papel */ }
    return run;
  }

  /** Provas mobile (src/mobile.ts): deps injetáveis — os testes trocam home/simctl/adb por falsos. */
  mobileDeps: MobileDeps = realDeps();

  /** Fim do turno (e da fila): só SOLTA a trava do emulador Android desta tarefa (outra tarefa pode usar). O
   * simulador iOS dedicado continua de pé pra próxima rodada — ele só é apagado no fim da TAREFA (merge/remoção)
   * ou pela varredura do doctor. Não pega nem mexe na trava de turno da tarefa (não atrapalha a fila). */
  private async mobileTurnEnd(taskId: string): Promise<void> {
    mobileTurnRelease(taskId, this.mobileDeps);
  }

  /** Fim da TAREFA: apaga o simulador e libera/desliga o emulador que ela subiu. Nunca lança. */
  private async mobileTaskEnd(taskId: string, worktree: string): Promise<void> {
    await mobileCleanup(taskId, worktree, this.mobileDeps).catch(() => []);
  }

  /** Qualquer exceção que ESCAPE do pipeline (banco ocupado além do retry, spec corrompido, git) deixava
   * a tarefa em "rodando"/"pensando" pra sempre — sem processo nenhum, o card girando e o "iniciar"
   * bloqueado. Agora ela vai pra "erro" com o motivo no chat (dá pra retomar) e o erro segue pra cima. */
  private async runTaskInner(taskId: string): Promise<void> {
    try {
      await this.runTaskPipeline(taskId);
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      try {
        const t = this.store.getTask(taskId);
        if (t) {
          this.store.addEvent(taskId, "Sistema", "error", `a execução parou por um erro inesperado: ${msg.slice(0, 300)}`, false);
          // só tira do estado "em andamento" — conflito/bloqueado/aguardando/plano/review ficam como estão
          if (["running", "thinking", "queued"].includes(t.status)) this.store.setStatus(taskId, "error");
        }
      } catch { /* banco indisponível: o erro original é o que importa */ }
      throw err;
    }
  }

  private async runTaskPipeline(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    if (stickEngines(spec)) this.store.updateSpec(taskId, JSON.stringify(spec));
    this.bus.policy = spec.autonomy.busPolicy ?? "first-claim-wins";
    await this.waitForScopeClear(taskId, spec); // sequential-lock: espera o escopo liberar antes de editar
    const roles = spec.roles.length ? spec.roles : [{ role: "builder" as Role, name: spec.agent, engine: spec.engine, model: spec.model }];
    let startIdx = task.done_roles ?? 0; // retoma de onde parou (ex.: após aprovar o plano)
    // P3: a pessoa pediu "mais uma rodada" depois da 3ª rodada/veredito ilegível → volta pro builder com o último "muda"
    if (spec.reviewExtra) {
      const ri = roles.findIndex((x) => x.role === "reviewer");
      const pi = ri >= 0 ? producerIndex(roles, ri) : -1;
      const last = [...(spec.reviewRounds ?? [])].reverse().find((x) => x.verdict === "muda");
      if (pi >= 0) {
        startIdx = pi;
        if (last) spec.adjustment = `A revisão ${last.round} (${last.reviewer}) pediu — você liberou mais uma rodada:\n${last.items.map((x) => `- ${x}`).join("\n")}`;
      }
      spec.reviewExtra = undefined;
      this.store.patchSpec(taskId, { reviewExtra: undefined, adjustment: spec.adjustment });
      try { await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree pode ter mudado */ }
    }
    const kind = taskKindOf(spec);
    let batonSeq = 0;

    for (let i = startIdx; i < roles.length; i++) {
      const r = roles[i];
      // P6: teto SEMPRE ligado — a 80% para ANTES de começar a etapa (rodadas de revisão passam por aqui também)
      if (this.capGate(taskId, i, `${r.name} ${ROLE_GERUND[r.role] ?? "trabalhar"}`)) return;
      this.store.setStage(taskId, r.role);
      this.store.setStatus(taskId, this.statusFor(r.role));
      const engine = this.engineFor(r.engine, r.model, spec.autonomy.approval);
      const persona = r.persona ? `## Seu perfil (${r.name} · ${r.role})\n${r.persona}\n\n` : "";
      this.prepEpic(spec, task.worktree);
      // P3: rodada de revisão com veredito (VEREDITO.md velho sai antes — nunca vale um veredito de outra rodada)
      const round = r.role === "reviewer" ? (this.freshSpec(taskId)?.reviewRounds?.length ?? 0) + 1 : 0;
      let reviewCtx = "";
      if (r.role === "reviewer") {
        try { await rm(join(task.worktree, ".cardume", "VEREDITO.md"), { force: true }); } catch { /* sem arquivo */ }
        const lens = FLOW_BY_KIND[kind].find((x) => x.role === "reviewer")?.lens ?? "codigo";
        reviewCtx = verdictInstructions(lens, round);
        const pi = producerIndex(roles, i);
        if (pi >= 0 && reviewerIsSame(roles[pi], r)) this.store.addEvent(taskId, "Sistema", "note", `${SAME_REVIEWER_WARNING} (${r.name} e ${roles[pi].name} no mesmo motor e modelo)`, false);
      }
      // K2: bastão por arquivo — quem chega lê o HANDOFF.md; quem sai escreve o seu
      const ctx = persona + this.projectMemory(spec) + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext(r) + this.issueContext(spec) + this.epicContext(spec) + reviewCtx + handoffRule(i > 0 && hasHandoff(task.worktree));
      const evStart = this.store.lastEventId(taskId);
      const batonIn = readHandoff(task.worktree); // o bastão que este papel recebe (devolver igual = não escreveu o seu)
      // P10: UM evento por papel (antes do laço de retry — tentar de novo não duplica) com o que vai rodar:
      // skills ativas@versão · agente@versão · motor. Alimenta a medição por versão e o Relatório do PR.
      this.recordRoleRun(taskId, spec, r);
      let sessionId = "";
      let roleFailed = false; // erro/timeout no papel → NÃO avança pro próximo
      let lastDeath = ""; // motivo da última morte do papel (vai na nota do "pipeline parado")

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
        lastDeath = "";
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
            this.store.addEvent(taskId, r.name, ev.type, ev.text, ev.ok, r.role, r.agentId);
            if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
              this.store.addCost(taskId, r.name, r.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok, ev.cost.ms ?? 0, r.engine, r.model, ev.cost.cachedTok ?? 0, r.agentId);
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
            notify("Starfork", "Tarefa falhou — veja o log", task.title);
            return;
          }
        }
        // ROUTE AI: Claude bateu limite e o fallback está ligado → em vez de esperar,
        // roteia esta tarefa pra IA alternativa NA HORA e retoma continuando da worktree.
        // (só o motor CLAUDE tem Route AI — tarefa Codex/gateway/DeepSeek nunca é desviada de motor)
        if (deathText && Orchestrator.usageLimitDeath(deathText) && !usingAlt && engineKind(r.engine) === "claude") {
          const altCfg = readAltConfig();
          if (altCfg && altCfg.fallback) {
            usingAlt = true;
            deathKind = "limit";
            this.store.addEvent(taskId, "Sistema", "note", `Claude bateu o limite de uso — roteando esta tarefa para a ${altCfg.label} (${altCfg.model}) automaticamente e retomando agora.`, true);
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
          this.store.addEvent(taskId, "Sistema", "note", `Limite de uso da IA atingido — vou RETOMAR automaticamente em ${LIMIT_MIN}min (~${hhmm}). Tentativa ${limitWait}/${MAX_LIMIT_WAITS}.`, true);
          this.store.setStatus(taskId, "queued");
          await new Promise((res) => setTimeout(res, LIMIT_MIN * 60000));
          this.store.addEvent(taskId, "Sistema", "note", "▶ intervalo cumprido — retomando de onde parou…", true);
          this.store.setStatus(taskId, this.statusFor(r.role));
          sessionId = ""; attemptNo++;
          continue;
        }
        // TOKEN/INATIVIDADE: recomeça na hora, orçamento limitado
        if (deathText && Orchestrator.retriableDeath(deathText) && hardTry < MAX_TRIES - 1) {
          hardTry++;
          deathKind = Orchestrator.tokenDeath(deathText) ? "token" : "idle";
          const why = deathKind === "token" ? "estourou o limite de tokens" : (Orchestrator.networkDeath(deathText) ? "caiu a conexão com a API" : "foi encerrada por inatividade");
          this.store.addEvent(taskId, "Sistema", "note", `A sessão ${why} — retomando AUTOMATICAMENTE (tentativa ${hardTry + 1}/${MAX_TRIES}), continuando do que já está na worktree.`, true);
          this.store.setStatus(taskId, this.statusFor(r.role));
          sessionId = ""; attemptNo++;
          continue;
        }
        lastDeath = deathText;
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
          Orchestrator.stoppedNote(r.role, lastDeath),
          false,
          r.role,
        );
        notify("Starfork", `${r.name} não concluiu — veja o log`, task.title);
        return;
      }

      // Instruções que o humano enviou durante o turno → aplica agora (resume).
      sessionId = await this.applyInstructions(taskId, task.worktree, spec, r, ctx, sessionId);

      // Commita o que sobrou solto (o agente pode ter commitado sozinho) e
      // sempre recalcula o diff da branch vs base — assim o diff aparece mesmo
      // quando foi o próprio agente que fez o commit.
      if (r.role !== "reviewer") {
        try {
          await this.git.commitAll(task.worktree, `starfork(${r.role}): ${task.title}`);
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

      // P3: veredito do revisor + rodadas. "muda" volta pro builder (rodada 2, dentro do teto); 3ª rodada ou
      // veredito ilegível param em "precisa de você" — NUNCA vira "aprova" por omissão.
      let verdict: Verdict | undefined;
      if (r.role === "reviewer") {
        verdict = parseVerdict(await this.verdictText(taskId, task.worktree, r.name, evStart));
        const rec: ReviewRound = { round, verdict: verdict.kind, items: verdict.items, at: Date.now(), reviewer: r.name, agentId: r.agentId, engine: engineKind(r.engine), model: r.model };
        const rounds = [...(this.freshSpec(taskId)?.reviewRounds ?? []), rec];
        spec.reviewRounds = rounds;
        this.store.patchSpec(taskId, { reviewRounds: rounds });
        this.store.addEvent(taskId, r.name, "veredito", roundText(rec) + (verdict.items.length ? `\n${verdict.items.map((x) => `- ${x}`).join("\n")}` : ""), verdict.kind === "aprova", r.role, r.agentId);
        const decision = reviewDecision(round, verdict);
        const pi = producerIndex(roles, i);
        if (decision === "refaz" && pi >= 0) {
          spec.adjustment = `A revisão ${round} (${r.name}) pediu estas mudanças:\n${verdict.items.map((x) => `- ${x}`).join("\n")}`;
          this.store.patchSpec(taskId, { adjustment: spec.adjustment });
          try { await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree pode ter mudado */ }
          this.baton(taskId, task.worktree, ++batonSeq, r, roles[pi], evStart, verdict, batonIn);
          this.store.addEvent(taskId, "Sistema", "note", `${r.name} pediu mudanças — voltando pra ${roles[pi].name} (rodada ${round + 1} de ${MAX_REVIEW_ROUNDS}, conta no teto)`, true);
          this.store.setDoneRoles(taskId, pi);
          i = pi - 1; // o laço soma 1: o builder roda de novo
          continue;
        }
        if (decision !== "segue") {
          const why = decision === "precisa-veredito"
            ? `${r.name} terminou a revisão ${round} sem um veredito legível (aprova ou muda). Decida: seguir pra prova, mais uma rodada ou parar.`
            : pi < 0
              ? `${r.name} pediu mudanças, mas não há builder nesta equipe pra refazer. Decida: seguir pra prova, mais uma rodada ou parar.`
              : `${r.name} pediu mudanças de novo na rodada ${round} de ${MAX_REVIEW_ROUNDS}. Uma 3ª rodada só com você: seguir pra prova, mais uma rodada ou parar.`;
          this.baton(taskId, task.worktree, ++batonSeq, r, roles[i + 1], evStart, verdict, batonIn);
          this.store.patchSpec(taskId, { needsYou: { kind: decision === "precisa-veredito" ? "veredito" : "rodadas", text: why, at: Date.now(), roleIdx: i + 1 } satisfies NeedsYou });
          this.store.setDoneRoles(taskId, i + 1);
          this.store.setStatus(taskId, "needs-you");
          this.store.addEvent(taskId, "Sistema", "note", why, false);
          notify("Starfork", "Precisa de você — a revisão não fechou", task.title);
          return;
        }
      }
      // K2: o papel terminou — guarda do bastão (HANDOFF.md existe e não está vazio) antes de passar pro próximo
      if (i < roles.length - 1) this.baton(taskId, task.worktree, ++batonSeq, r, roles[i + 1], evStart, verdict, batonIn);

      this.store.setDoneRoles(taskId, i + 1);

      // Se o agente de issues criou uma issue (ex.: FND-853), renomeia a branch
      // pra convenção <tipo>/<CÓDIGO>-<slug> (ex.: agent/... → feat/FND-853-...).
      if (r.role === "planner") await this.maybeRenameBranchFromIssue(taskId, task, spec);

      // GATE do plano: se acabou o planner e o humano quer aprovar antes,
      // pausa aqui. A UI mostra o plano (editável) e o botão "aprovar e continuar".
      if (r.role === "planner" && spec.autonomy.planApproval === "review" && i < roles.length - 1) {
        this.store.setStatus(taskId, "plan-review");
        this.store.addEvent(taskId, r.name, "note", "plano pronto — aguardando sua aprovação para continuar", true);
        notify("Starfork", "Plano pronto para sua aprovação", task.title);
        return;
      }
    }

    await this.collectArtifacts(taskId, task.worktree, spec.agent);

    this.store.releaseClaims(taskId); // terminou de editar → libera os caminhos
    this.store.setStatus(taskId, "review");
    const usesAi = spec.roles.some((x) => canTalk(x.engine)) || canTalk(spec.engine);
    if (usesAi) notify("Starfork", "Pronta para review ✓", task.title);
    this.appendHistory(taskId);      // memória de issues: entra no índice pesquisável
    this.harvestRunbook(task.worktree); // aprendizado de ambiente volta pro repo
    this.harvestBrain(task.worktree, taskId, task.title); // notas que o agente escreveu → cérebro
    void this.retroTask(taskId);     // retro: notas + skills aprendidas (fila ou auto, fire-and-forget)
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
      notify("Starfork", "Pronta — quer abrir o PR? (aba PR da tarefa)", task.title);
      return;
    }
    // mode === "auto": GATE MECÂNICO antes de abrir (evidência existe + testes passam)
    await this.openPr(taskId, { auto: true, task, spec });
  }

  /**
   * ABRE O PR desta tarefa (o mesmo caminho do PR automático e da tool open_pr do terminal integrado):
   *  0) PR já aberto (spec.prUrl) → "atualizar": commita o solto, push e devolve a URL dele (sem gate, sem gh);
   *  1) GATE (verifyProofs) — reprovou e não é rascunho → NÃO abre e devolve os motivos;
   *  2) commita o que ficou solto, `git push -u origin <branch>`, `gh pr create` (--draft se pedido);
   *  3) PR já aberto pra branch → a URL vem do erro do gh; grava spec.prUrl/prNumber (como o app faz no pr_status).
   * `auto` = chamado pelo fim do pipeline (textos/notificações de sempre). Nunca lança: erro vem em `error`.
   */
  async openPr(taskId: string, o: { draft?: boolean; title?: string; body?: string; auto?: boolean; task?: TaskRow; spec?: TaskSpec } = {}): Promise<{ ok: boolean; url?: string; reasons?: string[]; error?: string }> {
    const task = o.task ?? this.store.getTask(taskId);
    if (!task) return { ok: false, error: `tarefa ${taskId} não encontrada` };
    const spec = o.spec ?? this.freshSpec(taskId) ?? (JSON.parse(task.spec_json) as TaskSpec);
    const role = spec.roles?.find((r) => r.role === "builder") ?? spec.roles?.[0];
    const agent = o.auto ? spec.agent : role?.name || spec.agent;
    if (["merged", "aborted"].includes(task.status)) return { ok: false, error: `a tarefa já está ${task.status === "merged" ? "integrada" : "cancelada"} — não há PR a abrir` };
    if (spec.kind === "review") return { ok: false, error: "esta tarefa é uma revisão de PR — não tem branch própria pra abrir PR" };
    const commitLoose = async () => {
      try {
        if (await this.git.commitAll(task.worktree, `starfork(pr): ${task.title}`)) {
          this.store.addEvent(taskId, agent, "note", "mudanças soltas commitadas antes do PR ✓", true);
          const d = await this.git.diffStat(task.worktree, task.base);
          this.store.setDiff(taskId, d.files, d.add, d.del);
        }
      } catch { /* sem nada a commitar / hook recusou: o push leva o que já está commitado */ }
    };
    if (spec.prUrl && !o.auto) {
      // PR já aberto: "atualizar" = commit + push (o PR se atualiza sozinho) — o gate vale na hora de ABRIR
      try {
        await commitLoose();
        await run("git", ["-C", task.worktree, "push", "-u", "origin", task.branch], { env: netEnv(), timeout: netTimeoutMs() });
        this.store.addEvent(taskId, agent, "note", `PR atualizado (push): ${spec.prUrl}`, true);
        return { ok: true, url: spec.prUrl };
      } catch (err) {
        const msg = String((err as { stderr?: string }).stderr || (err as Error).message || err).trim().slice(0, 300);
        this.store.addEvent(taskId, agent, "note", `falha ao atualizar o PR: ${msg.slice(0, 140)}`, false);
        return { ok: false, error: msg };
      }
    }
    if (!o.draft) {
      const gate = await this.verifyProofs(taskId, task, spec);
      if (!gate.ok) {
        const why = gate.reasons.slice(0, 3).join(" · ");
        this.store.addEvent(taskId, agent, "note", `PR NÃO aberto (gate de verificação): ${why}`, false);
        if (o.auto) notify("Starfork", "PR não aberto — verificação falhou", task.title);
        return { ok: false, reasons: gate.reasons };
      }
    }
    const base = spec.prBase?.trim() || (await this.git.defaultBase()).replace(/^origin\//, "");
    try {
      await commitLoose();
      await run("git", ["-C", task.worktree, "push", "-u", "origin", task.branch], { env: netEnv(), timeout: netTimeoutMs() });
      const title = String(o.title ?? "").trim() || spec.title;
      const head = String(o.body ?? "").trim()
        ? `${String(o.body).trim()}\n\n`
        : `## O quê\n${spec.objective || spec.title}\n\n` +
          ((spec.deliverables ?? []).length ? `## Entregáveis\n${(spec.deliverables ?? []).map((d) => "- " + d).join("\n")}\n\n` : "");
      const body = head + (await this.reportFor(taskId, task)) + "\n" +
        (o.auto ? `_Aberto automaticamente pelo Starfork (sem pendências nos requisitos)._` : o.draft ? `_Rascunho aberto pelo agente no terminal do Starfork._` : `_Aberto pelo agente no terminal do Starfork (requisitos provados)._`);
      // --draft no FIM: o gh falso dos testes lê a branch pela posição ($6)
      const args = ["pr", "create", "--base", base, "--head", task.branch, "--title", title, "--body", body, ...(o.draft ? ["--draft"] : [])];
      let url = "";
      try {
        const { stdout } = await run(ghBin(), args, { cwd: task.worktree, env: ghEnvFor(this.ws.repo), timeout: netTimeoutMs() });
        const last = stdout.trim().split("\n").pop()?.trim() ?? "";
        url = prUrlFrom(stdout) || (/^https?:\/\//.test(last) ? last : "");
      } catch (e) {
        // PR já aberto pra esta branch (retry, ou o humano abriu antes): o gh FALHA mas cita a URL —
        // antes virava "falha ao abrir o PR" com o PR existindo
        url = /already exists/i.test(String((e as { stderr?: string }).stderr ?? "")) ? prUrlFrom(String((e as { stderr?: string }).stderr)) : "";
        if (!url) throw e;
      }
      if (!url) throw new Error("gh não devolveu a URL do PR");
      const n = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
      try { this.store.patchSpec(taskId, { prUrl: url, ...(n ? { prNumber: n } : {}) }); } catch { /* banco ocupado: o app grava no próximo pr_status */ }
      this.store.addEvent(taskId, agent, "note", o.auto ? `PR aberto automaticamente: ${url}` : `${o.draft ? "PR rascunho aberto" : "PR aberto"}: ${url}`, true);
      notify("Starfork", "PR aberto ✓", task.title);
      return { ok: true, url };
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr || (err as Error).message || err).trim().slice(0, 300);
      this.store.addEvent(taskId, agent, "note", `falha ao abrir o PR${o.auto ? " automaticamente" : ""}: ${msg.slice(0, 140)}`, false);
      return { ok: false, error: msg };
    }
  }

  /** Relatório Starfork do PR (requisitos × provas, motivos, custo por papel, liberações, rodadas e versão por papel). */
  async reportFor(taskId: string, task?: TaskRow): Promise<string> {
    const t = task ?? this.store.getTask(taskId);
    if (!t) return "";
    const spec = this.freshSpec(taskId) ?? (JSON.parse(t.spec_json) as TaskSpec);
    const artDir = join(t.worktree, ".cardume", "artifacts");
    let list: Array<{ req?: string; status?: string; evidence?: string[] }> = [];
    for (const p of [join(artDir, "requirements.json"), join(this.ws.repo, ".cardume", "artifacts", taskId, "requirements.json")]) {
      try { const raw = JSON.parse(await readFile(p, "utf8")); list = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : []; if (list.length) break; } catch { /* sem arquivo */ }
    }
    const requirements: ReportData["requirements"] = list.map((r) => {
      const ev = (Array.isArray(r.evidence) ? r.evidence : []).map(String);
      const proven = r.status === "done" && ev.some((e) => evidenceExists(artDir, t.worktree, e));
      return { text: String(r.req ?? "requisito"), status: r.status === "deferred" ? "adiado" : proven ? "provado" : "sem prova", evidence: proven ? ev.filter((e) => evidenceExists(artDir, t.worktree, e)) : [] };
    });
    const costByRole = (this.store.db.prepare(`SELECT COALESCE(role, '') AS role, agent AS name, SUM(usd) AS usd FROM cost WHERE task_id = ? GROUP BY role, agent ORDER BY MIN(id)`).all(taskId) as { role: string; name: string; usd: number }[]).map((c) => ({ role: c.role, name: c.name, usd: Number(c.usd) || 0 }));
    return starforkReport({
      requirements, costByRole, totalUsd: this.store.taskSpend(taskId),
      // piloto com `--budget-usd 0`: sem teto por escolha explícita (compatibilidade) — o relatório diz isso, não inventa um teto
      capUsd: spec.autopilot && !(Number(spec.budgetUsd) > 0) ? 0 : effectiveCap(spec.budgetUsd, readCostCapSetting()),
      reviewOverride: spec.reviewOverride?.reason, releases: spec.budgetReleases ?? [], rounds: spec.reviewRounds ?? [], runs: spec.roleRuns ?? [],
      orgPolicy: spec.orgPolicy?.rules,
    });
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

    const roles = spec.roles.length ? spec.roles : [{ role: "reviewer" as Role, name: spec.agent, engine: spec.engine, model: spec.model }];
    for (let i = 0; i < roles.length; i++) {
      const r = roles[i];
      this.store.setStage(spec.id, r.role);
      this.store.setStatus(spec.id, "running");
      const engine = this.engineFor(r.engine, r.model, spec.autonomy.approval);
      const persona = r.persona ? `## Seu perfil (${r.name} · ${r.role})\n${r.persona}\n\n` : "";
      const ctx = persona + this.projectMemory(spec) + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext(r) + this.issueContext(spec) + this.epicContext(spec);
      try {
        for await (const ev of engine.run({ cwd: dir, spec, systemContext: ctx, role: r.role, agentName: r.name, dbFile: this.ws.dbFile })) {
          if (ev.type === "session") { this.store.setSession(spec.id, ev.text); continue; }
          if (ev.type === "claim") continue; // sem repo pra reivindicar num review de PR
          this.store.addEvent(spec.id, r.name, ev.type, ev.text, ev.ok, r.role, r.agentId);
          if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
            this.store.addCost(spec.id, r.name, r.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok, ev.cost.ms ?? 0, r.engine, r.model, ev.cost.cachedTok ?? 0, r.agentId);
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
    notify("Starfork", "Review do PR pronto ✓", spec.title);
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
    role: { role: Role; agentId?: string; name: string; engine: string; model?: string; persona?: string },
    ctx: string,
    sessionId: string
  ): Promise<string> {
    if (!canTalk(role.engine)) return sessionId; // mock não continua sessão
    let guard = 0;
    while (guard++ < 20) {
      const open = this.store.openInstructions(taskId);
      if (!open.length) break;
      this.store.addEvent(taskId, role.name, "note", `aplicando ${open.length} instrução(ões) enviada(s) por você`, true, role.role);
      this.store.setStatus(taskId, "running");
      this.prepEpic(spec, worktree);
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
          skillsRule: this.skillsContext(role), // resume não reenvia system prompt → skills por turno
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
          this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role, role.agentId);
          if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
            this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok, ev.cost.ms ?? 0, role.engine, role.model, ev.cost.cachedTok ?? 0, role.agentId);
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
    if (stickEngines(spec)) this.store.updateSpec(taskId, JSON.stringify(spec));
    const roles = spec.roles || [];
    const pref = kind === "doc" ? ["docs", "builder"] : ["builder", "tester"];
    const role =
      roles.find((r) => pref.includes(r.role) && canTalk(r.engine)) ||
      roles.find((r) => canTalk(r.engine)) ||
      Orchestrator.fallbackRole(spec);

    const label =
      kind === "doc" ? "documento de arquitetura"
      : kind === "tests" ? "testes de comprovação"
      : kind === "proof" ? "prova (prints/evidência)"
      : "entregáveis (doc + testes + prova)";
    const engine = this.engineFor(role.engine, role.model, "ask");
    this.prepEpic(spec, task.worktree);
    const ctx = (role.persona ? `## Seu perfil (${role.name})\n${role.persona}\n\n` : "") + this.projectMemory(spec) + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext(role) + this.issueContext(spec) + this.epicContext(spec);
    const prev = task.status;
    this.store.setStatus(taskId, "thinking");
    this.store.setStage(taskId, role.role);
    this.store.addEvent(taskId, role.name, "status", `gerando ${label}…`, true, role.role);
    let failed = false;
    try {
      for await (const ev of engine.run({ cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: this.ws.dbFile, promptOverride: deliverPrompt(kind) })) {
        if (ev.type === "session") { this.store.setSession(taskId, ev.text); continue; }
        if (ev.type === "claim") continue;
        if (ev.type === "error") failed = true;
        this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role, role.agentId);
        if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
          this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok, ev.cost.ms ?? 0, role.engine, role.model, ev.cost.cachedTok ?? 0, role.agentId);
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
      notify("Starfork", `${label} pronto ✓`, task.title);
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

  /**
   * E4 — resolução de conflito ASSISTIDA: o agente retoma a própria sessão e
   * mergeia a base resolvendo os conflitos NA WORKTREE (sem push). O humano
   * revisa o resultado e mergeia. Reusa o talk (uma rodada focada), então o
   * agente já tem todo o contexto da tarefa.
   */
  async resolveConflict(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    if (task.status === "merged") throw new Error("tarefa já mergeada — nada a resolver");
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const base = (spec.base && spec.base.trim() ? spec.base.trim() : await this.git.defaultBase()).replace(/^origin\//, "");
    // projeto LOCAL sem remoto (ex.: piloto automático): a base é a branch local, nada de fetch
    const remote = await this.git.hasRemote("origin");
    const msg =
      `RESOLVER CONFLITO DE MERGE com a base "${base}", aqui na sua worktree:\n` +
      (remote
        ? `1) git fetch origin ${base}\n` + `2) git merge origin/${base}  (vai conflitar)\n`
        : `1) (projeto local, sem remoto — não faça fetch)\n` + `2) git merge ${base}  (vai conflitar)\n`) +
      `3) resolva CADA conflito preservando a INTENÇÃO desta tarefa E as mudanças da base — não descarte um lado sem motivo;\n` +
      `4) git add -A && git commit  (sem --no-verify);\n` +
      `5) NÃO faça push nem abra PR — o humano revisa e mergeia.\n` +
      `No fim, confirme com "git status" limpo e resuma numa linha o que reconciliou.`;
    this.store.addEvent(taskId, spec.agent, "note", `resolução de conflito com IA iniciada (base ${base})`, true);
    await this.talkToAgent(taskId, msg, false);
  }

  private async talkToAgentInner(taskId: string, message: string, asReq = false, agentName?: string): Promise<void> {
    // a conversa SEMPRE pode ser retomada: worktree removida (merge, "liberar
    // espaço", cancelada…) é RECRIADA no mesmo caminho antes do turno.
    const recreated = await this.ensureTaskWorktree(taskId);
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    if (stickEngines(spec)) this.store.updateSpec(taskId, JSON.stringify(spec));
    // pedido novo vira REQUISITO da tarefa (checklist cresce e cobra evidência)
    if (asReq && message.trim()) {
      spec.requirements = [...(spec.requirements ?? []), message.trim()];
      this.store.updateSpec(taskId, JSON.stringify(spec));
      try { await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree pode não existir */ }
      this.store.addEvent(taskId, "Você", "note", `requisito adicionado: ${message.trim().slice(0, 100)}`, true);
    }
    const roles = spec.roles || [];
    // interlocutor: o agente escolhido no chat (/) ou o padrão (1º claude)
    // motor/modelo SÃO os da tarefa: antes só papéis "claude" conversavam e uma tarefa Codex/gateway
    // caía num builder Claude genérico (o "segue no Claude sempre").
    const deflt = roles.find((r) => canTalk(r.engine));
    const picked = agentName ? roles.find((r) => r.name === agentName && canTalk(r.engine)) : undefined;
    const role = picked || deflt || Orchestrator.fallbackRole(spec);
    // sessão pertence ao último agente que falou — trocar de agente = turno
    // FRESCO com a persona dele (senão ele "vira" o outro agente da sessão).
    const switching = !!picked && !!deflt && picked.name !== deflt.name;
    const engine = this.engineFor(role.engine, role.model, "ask");
    this.prepEpic(spec, task.worktree);
    const ctx = (role.persona ? `## Seu perfil (${role.name})\n${role.persona}\n\n` : "") + this.projectMemory(spec, message) + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext(role) + this.issueContext(spec) + this.epicContext(spec);
    // recriada → ao fim do turno volta pra "pronta pra revisar" (não pro limbo mergeada-sem-worktree)
    const prev: AgentStatus = recreated && ["merged", "done", "aborted", "cancelled", "error"].includes(task.status) ? "review" : task.status;
    const sid = switching ? "" : (task.session_id || "");
    this.store.addEvent(taskId, "Você", "note", `Você: ${message}`, true);
    // integrada/concluída que volta a conversar NÃO vira 'thinking' (o busy_pid já sinaliza o turno): o "parar" mata
    // o processo antes do fim do turno restaurar o status, e a tarefa caía pra 'review' (saía de Concluídas)
    if (!(prev === task.status && ["merged", "done", "aborted"].includes(task.status))) this.store.setStatus(taskId, "thinking");
    let failed = false;
    try {
      const chatRule = noAskTool(role.engine) ? Orchestrator.CHAT_RULE_TEXT : Orchestrator.CHAT_RULE_ASK;
      const base = { cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: this.ws.dbFile, askTimeoutMin: 20, skillsRule: this.skillsContext(role) };
      const input = sid
        ? { ...base, resume: { sessionId: sid, instruction: message + chatRule } }
        : { ...base, promptOverride: `Você é ${role.name} (papel: ${role.role}) nesta tarefa, que JÁ FOI implementada nesta worktree. Atenda ao pedido do humano (não recomece do zero): ${message}${this.historyDigest(taskId)}${chatRule}` };
      let deathText = "";
      for await (const ev of engine.run(input)) {
        if (ev.type === "session") { this.store.setSession(taskId, ev.text); continue; }
        if (ev.type === "claim") continue;
        if (ev.type === "error") { failed = true; deathText = ev.text; }
        if (ev.type === "done" && ev.ok === false) deathText = ev.text;
        this.store.addEvent(taskId, role.name, ev.type, ev.text, ev.ok, role.role, role.agentId);
        if (ev.cost && (ev.cost.usd > 0 || ev.cost.inTok > 0 || ev.cost.outTok > 0)) {
          this.store.addCost(taskId, role.name, role.role, ev.cost.usd, ev.cost.inTok, ev.cost.outTok, ev.cost.ms ?? 0, role.engine, role.model, ev.cost.cachedTok ?? 0, role.agentId);
        }
      }
      // sessão não existe mais (histórico do Claude apagado/outra máquina) →
      // sessão NOVA semeada com o histórico da conversa (historyDigest)
      if (sid && deathText && Orchestrator.sessionMissing(deathText)) {
        this.store.setSession(taskId, "");
        this.store.addEvent(taskId, "Sistema", "note", "A sessão anterior do agente não foi encontrada — continuando numa sessão nova com o resumo da conversa.", true);
        this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
        return this.talkToAgentInner(taskId, message, false, agentName);
      }
      // sessão do chat estourou os tokens → recomeça SOZINHO com sessão nova
      // (sid vazio na re-entrada → caminho fresco; sem risco de loop)
      if (sid && deathText && Orchestrator.retriableDeath(deathText)) {
        const why = Orchestrator.tokenDeath(deathText) ? "estourou o limite de tokens" : (Orchestrator.networkDeath(deathText) ? "caiu a conexão com a API" : "foi encerrada por inatividade");
        this.store.setSession(taskId, "");
        this.store.addEvent(taskId, "Sistema", "note", `A sessão do chat ${why} — recomeçando AUTOMATICAMENTE com uma sessão nova (o agente relê o estado da worktree).`, true);
        this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
        return this.talkToAgentInner(taskId, message, false, agentName);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (sid && Orchestrator.sessionMissing(msg)) {
        this.store.setSession(taskId, "");
        this.store.addEvent(taskId, "Sistema", "note", "A sessão anterior do agente não foi encontrada — continuando numa sessão nova com o resumo da conversa.", true);
        this.store.setStatus(taskId, prev === "thinking" ? "review" : prev);
        return this.talkToAgentInner(taskId, message, false, agentName);
      }
      if (sid && Orchestrator.retriableDeath(msg)) {
        const why = Orchestrator.tokenDeath(msg) ? "estourou o limite de tokens" : (Orchestrator.networkDeath(msg) ? "caiu a conexão com a API" : "foi encerrada por inatividade");
        this.store.setSession(taskId, "");
        this.store.addEvent(taskId, "Sistema", "note", `A sessão do chat ${why} — recomeçando AUTOMATICAMENTE com uma sessão nova.`, true);
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
    else notify("Starfork", `${role.name} respondeu`, task.title);
    // notas que o agente escreveu neste turno → cérebro do projeto
    this.harvestBrain(task.worktree, taskId, task.title);
    // aprende com a mensagem do humano (fire-and-forget — não atrasa o turno)
    if (!asReq) void this.learnFromMessage(message, task.title, taskId);
  }

  /**
   * Garante que a worktree da tarefa EXISTE — se foi removida (merge, "liberar
   * espaço", cancelada/abortada limpa), RECRIA no MESMO caminho (a sessão do
   * Claude é guardada por pasta → `--resume` continua valendo), re-semeia o
   * ambiente e o TASK.yaml. Mergeada → branch NOVA da base (<branch>-cont) e o
   * PR antigo vai pro histórico (spec.prHistory) — o próximo push abre PR novo.
   * Retorna true se recriou.
   */
  /**
   * `conversation`: tarefa INTEGRADA reaberta só pra CONVERSAR no terminal (perguntar sobre o que foi feito): recria a
   * pasta no MESMO caminho (o `claude --resume` acha o transcript pela pasta) a partir da branch da tarefa (local ou
   * origin) ou, sem ela, do commit do merge / da base, SEM trocar branch nem arquivar o PR — a tarefa segue integrada.
   */
  async ensureTaskWorktree(taskId: string, o: { conversation?: boolean } = {}): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const wt = task.worktree;
    if (spec.kind === "review") {
      // review de PR: pasta simples (sem git) — só garante que existe
      if (existsSync(wt)) return false;
      await mkdir(join(wt, ".cardume"), { recursive: true });
      await writeFile(join(wt, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      this.store.addEvent(taskId, "Sistema", "note", "Recriei a pasta de trabalho desta revisão — a conversa continua.", true);
      return true;
    }
    if (existsSync(join(wt, ".git"))) return false;
    if (existsSync(wt)) {
      // sobra sem git (ex.: só .cardume/ ficou) — só apaga dentro de .cardume/worktrees
      const root = this.ws.worktrees + "/";
      if (!wt.startsWith(root)) throw new Error(`a pasta de trabalho da tarefa (${wt}) existe mas não é uma cópia git — remova-a e tente de novo.`);
      await rm(wt, { recursive: true, force: true });
    }
    const merged = task.status === "merged";
    const base = task.base || (spec.base && spec.base.trim()) || (await this.git.defaultBase());
    await this.git.ensureExcluded([".cardume/", ".constellation/"]);
    if (merged && o.conversation) {
      let r: { from: string };
      try {
        r = await this.git.recreateForConversation(wt, { branch: task.branch, base, commit: spec.prMergeCommit || (spec.prUrl ? await prMergeCommit(spec.prUrl, this.ws.repo) : "") });
      } catch (err) {
        throw new Error(`não consegui reabrir a pasta desta tarefa integrada (${String((err as { stderr?: string }).stderr || (err as Error).message).trim().split("\n").pop()}) — pra mexer de novo, abra uma tarefa de ajuste`);
      }
      await mkdir(join(wt, ".cardume"), { recursive: true });
      try { await this.seedWorktreeEnv(wt, spec.light === true); } catch { /* best-effort */ }
      await writeFile(join(wt, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      // provas coletadas no repo (.cardume/artifacts/<id>) voltam pra pasta: a conversa pode citar
      try { const src = join(this.ws.repo, ".cardume", "artifacts", taskId); if (existsSync(src)) await cp(src, join(wt, ".cardume", "artifacts"), { recursive: true, force: false }); } catch { /* sem provas */ }
      this.store.addEvent(taskId, "Sistema", "note", `tarefa integrada reaberta pra conversa — a pasta foi recriada a partir de ${r.from}`, true);
      return true;
    }
    let r: { branch: string; from: string; reused: boolean };
    try {
      r = await this.git.recreateWorktree(wt, { branch: task.branch, base, merged });
    } catch (err) {
      throw new Error(`não consegui recriar a cópia de trabalho desta tarefa: ${(err as Error).message}`);
    }
    await mkdir(join(wt, ".cardume"), { recursive: true });
    try { await this.seedWorktreeEnv(wt, spec.light === true); } catch { /* best-effort */ }
    if (merged && spec.prUrl) {
      spec.prHistory = [...(spec.prHistory ?? []).filter((u) => u !== spec.prUrl), spec.prUrl];
      delete spec.prUrl;
      this.store.updateSpec(taskId, JSON.stringify(spec));
    }
    await writeFile(join(wt, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
    if (r.branch !== task.branch) this.store.setBranch(taskId, r.branch);
    const from = r.reused ? `branch ${r.branch}` : r.from;
    this.store.addEvent(taskId, "Sistema", "note", `Recriei a cópia de trabalho desta tarefa a partir de ${from} — a conversa continua.`, true);
    if (merged) {
      this.store.addEvent(taskId, "Sistema", "note", `A tarefa já tinha sido mergeada: os novos ajustes vão na branch ${r.branch} (vira um PR novo quando você fizer commit & push; o PR anterior fica no histórico).`, true);
    } else if (!r.reused) {
      this.store.addEvent(taskId, "Sistema", "note", `A branch ${task.branch} não existia mais (nem local nem no origin) — a cópia nasceu de ${r.from}; o que não tinha sido enviado se perdeu.`, false);
    }
    return true;
  }

  /** Resumo curto da conversa (últimas mensagens) pra semear uma sessão NOVA do agente. */
  private historyDigest(taskId: string): string {
    try {
      const evs = this.store.eventsForTask(taskId).filter((e) => (e.type === "think" || e.type === "done" || (e.type === "note" && e.agent === "Você")) && e.text && e.text.trim());
      if (!evs.length) return "";
      const lines: string[] = [];
      let size = 0;
      for (let i = evs.length - 1; i >= 0 && lines.length < 24; i--) {
        const who = evs[i].agent === "Você" ? "" : `${evs[i].agent}: `;
        const l = (who + evs[i].text.replace(/\s+/g, " ").trim()).slice(0, 400);
        if (size + l.length > 5000) break;
        lines.unshift(`- ${l}`);
        size += l.length;
      }
      return `\n\n[HISTÓRICO DA CONVERSA — sessão anterior não disponível; use como contexto, confira o estado real com git log/git status]\n${lines.join("\n")}`;
    } catch {
      return "";
    }
  }

  /**
   * F5 · P15 — TESTAR NUMA AMOSTRA (só o revisor). Reexecuta SÓ a revisão, com a persona e as skills ATUAIS do agente,
   * numa worktree descartável (detached) no último commit da branch de uma tarefa passada. Nada grava na tarefa antiga:
   * o motor roda com um banco próprio da amostra (sem evento, sem `cost`, sem prova); o gasto vai pro livro de uso.
   * Para se passar do teto. O resultado (veredito de antes × de agora) fica em .cardume/aprendizado/amostras.json.
   */
  async sampleReview(taskId: string, agentId: string, capUsd: number): Promise<SampleResult> {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("essa tarefa não existe mais neste projeto");
    if (!(capUsd > 0)) throw new Error("a amostra precisa de um teto");
    const agent = loadConfig(this.ws.repo).agents.find((a) => a.id === agentId);
    if (!agent) throw new Error("esse agente não está no catálogo do projeto");
    if (agent.role !== "reviewer") throw new Error("por enquanto a amostra é só pro revisor");
    const spec0 = JSON.parse(t.spec_json) as TaskSpec;
    const old = oldVerdict(spec0, this.store.eventsForTask(taskId), agentId);
    const ref = (await this.git.refExists(t.branch)) ? t.branch : (await this.git.refExists(`origin/${t.branch}`)) ? `origin/${t.branch}` : "";
    if (!ref) throw new Error("a branch dessa tarefa não existe mais (apagada depois do merge) — escolha outra tarefa");
    const stamp = Date.now();
    const dir = join(this.ws.dir, "amostras", `${taskId}-${stamp}`);
    await mkdir(join(this.ws.dir, "amostras"), { recursive: true });
    let usd = 0, stopped = false, inTok = 0, outTok = 0, ms = 0, text = "", failed = "";
    const said: string[] = []; // sem VEREDITO.md, vale o que o revisor disse no fim (≡ verdictText do fluxo normal)
    const role: AgentRole = { role: "reviewer", agentId: agent.id, name: agent.name, engine: agent.engine, model: agent.model, persona: agent.persona };
    try {
      await run("git", ["-C", this.ws.repo, "worktree", "add", "--detach", dir, ref]);
      // o mesmo ambiente de uma tarefa (.env, dependências): sem isso a revisão não roda os testes e a comparação
      // mediria a máquina, não a versão do agente
      await this.seedWorktreeEnv(dir);
      // o motor lê o TASK.yaml da worktree (.cardume não vai pro git) — a spec da tarefa com outro id: nada volta pra ela
      const spec: TaskSpec = {
        ...spec0, id: `amostra-${taskId}-${stamp}`.slice(0, 80), roles: [role], reviewRounds: [], adjustment: undefined, autoPr: "no",
        artifacts: undefined, // sem regras de prova/teste da entrega (elas mandam perguntar ao humano — aqui ninguém responde)
        deliverables: Array.isArray(spec0.deliverables) ? spec0.deliverables : [], requirements: Array.isArray(spec0.requirements) ? spec0.requirements : [],
        scope: { owns: spec0.scope?.owns ?? [], offLimits: spec0.scope?.offLimits ?? [] },
        autonomy: { ...(spec0.autonomy ?? {}), clarifications: "auto", commit: "at-end", runTests: true, approval: "auto" },
      };
      await mkdir(join(dir, ".cardume"), { recursive: true });
      await writeFile(join(dir, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      const sampleDb = join(dir, ".cardume", "amostra.sqlite");
      new Store(sampleDb).close();
      const lens = FLOW_BY_KIND[taskKindOf(spec0)].find((x) => x.role === "reviewer")?.lens ?? "codigo";
      const persona = agent.persona ? `## Seu perfil (${agent.name} · reviewer)\n${agent.persona}\n\n` : "";
      const ctx = persona + this.projectMemory(spec) + this.skillsContext(role) + verdictInstructions(lens, 1);
      const engine = this.engineFor(agent.engine, agent.model, "auto");
      // askTimeoutMin: uma pergunta ao humano não fica esperando pra sempre (ninguém lê o banco da amostra)
      for await (const ev of engine.run({ cwd: dir, spec, systemContext: ctx, role: "reviewer", agentName: agent.name, dbFile: sampleDb, askTimeoutMin: 1 })) {
        if (ev.type === "error" || (ev.type === "done" && ev.ok === false)) failed = String(ev.text ?? "").split("\n")[0].slice(0, 200) || "o motor parou com erro";
        if ((ev.type === "done" || ev.type === "note" || ev.type === "think") && ev.text && !/^custo do turno/.test(ev.text)) said.push(ev.text);
        if (ev.cost) { usd += Number(ev.cost.usd) || 0; inTok += ev.cost.inTok || 0; outTok += ev.cost.outTok || 0; ms += ev.cost.ms ?? 0; }
        if (usd > capUsd) { stopped = true; break; } // teto: para (o motor encerra o processo ao sair do laço)
      }
      try { text = await readFile(join(dir, ".cardume", "VEREDITO.md"), "utf8"); } catch { /* o revisor não escreveu */ }
      if (!text.trim()) text = said.slice(-6).join("\n");
    } finally {
      if (usd > 0 || inTok > 0) recordUsage({ source: "outros", project: this.ws.repo, taskId, role: "amostra", engine: engineKind(agent.engine), model: agent.model, inTok, outTok, usd, ms });
      // a cópia descartável sai SEMPRE (inclusive se o motor quebrar no meio)
      try { await this.git.worktreeRemove(dir); } catch { try { await rm(dir, { recursive: true, force: true }); await run("git", ["-C", this.ws.repo, "worktree", "prune"]); } catch { /* sobra varrida no próximo prune */ } }
    }
    // motor que quebrou (login, limite, queda) NÃO vira veredito — senão "veredito mudou" seria falso
    if (failed && !stopped) throw new Error(`a revisão da amostra não terminou: ${failed}`);
    const v = stopped && !text.trim() ? { kind: "ilegivel" as const, items: [] } : parseVerdict(text);
    const res: SampleResult = {
      at: Date.now(), agentId, agentName: agent.name, taskId, title: t.title,
      old, now: { v: agentVersion(this.ws.dir, agentId), kind: v.kind, items: v.items }, usd: Math.round(usd * 10000) / 10000, capUsd, stopped,
    };
    saveSample(this.ws.dir, res);
    return res;
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
    // ajuste pedido pela PESSOA abre um ciclo novo de revisão (as 2 rodadas valem de novo)
    this.store.patchSpec(taskId, { reviewRounds: [], needsYou: null });

    // Re-roda o pipeline do começo: planner re-planeja com o ajuste, builder aplica,
    // reviewer re-revisa, docs re-atualiza. O stepper anda por todas as etapas.
    this.store.setDoneRoles(taskId, 0);
    this.store.setStatus(taskId, "running");
    await this.runTaskInner(taskId); // Inner: o lock/fila já é do chamador
    notify("Starfork", "Ajuste aplicado (time inteiro) — pronto para review", task.title);
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

  /** Gera (na IA padrão — src/ai-once.ts) e guarda o resumo técnico de um commit — o quê + porquê. */
  private async summarizeCommit(taskId: string, hash: string, worktree: string, spec: TaskSpec): Promise<void> {
    try {
      const diff = (await run("git", ["-C", worktree, "show", "--no-color", "--format=", "-p", hash])).stdout.slice(0, 8000);
      const dels = spec.deliverables?.length ? `Entregáveis pedidos: ${spec.deliverables.join("; ")}\n` : "";
      const prompt =
        `Você é um revisor de código sênior. Em 2 a 4 frases, explique de forma TÉCNICA e direta O QUE foi feito neste commit e POR QUE (a intenção/como se conecta ao objetivo). NÃO liste arquivos nem número de linhas — foque na mudança e no propósito. Responda em português.\n\n` +
        `Objetivo da tarefa: ${spec.objective}\n${dels}\nDiff:\n${diff}`;
      // teto: o resumo roda DENTRO do pipeline (com o lock da tarefa) — um claude pendurado aqui
      // deixava a tarefa "rodando" pra sempre depois do builder já ter terminado
      const s = (await aiOnce(prompt, { tier: "capaz", cwd: worktree, timeout: auxTimeoutMs(), usage: { source: "commit-pr", project: this.ws.repo, taskId } })).trim();
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
    // merge do HUMANO já em andamento no repo principal: recusa ANTES — nunca abortar um merge que não
    // foi a gente que começou (o abort jogaria fora a resolução dele)
    if (await this.git.mergeInProgress()) {
      const why = mergeFailReason("MERGE_HEAD exists");
      this.store.addEvent(taskId, task.agent, "error", `não deu pra mergear: ${why}`, false);
      throw new Error(`não deu pra mergear em ${task.base}: ${why}`);
    }
    // o tamanho da tarefa fica o do MOMENTO da integração (depois do merge o ponto de bifurcação vira o próprio HEAD)
    try {
      const d = await this.git.diffStat(task.worktree, task.base);
      if (d.files > 0) this.store.setDiff(taskId, d.files, d.add, d.del);
    } catch { /* worktree já sem git: fica o último número */ }
    try {
      await this.git.mergeBranch(task.branch, `starfork: merge ${task.title} (${task.branch})`);
    } catch (err) {
      // Só é CONFLITO se o git parou com arquivos em conflito. Antes QUALQUER falha (mudança local não
      // commitada no repo principal, base não está em check-out, branch sumiu) virava "conflict" — a
      // tarefa ia pra "em conflito" e o humano/IA tentava resolver um conflito que não existia.
      const e = err as Error & { stderr?: string; stdout?: string };
      // só a SAÍDA do git: e.message repete a linha de comando (o -m com o título da tarefa, que pode ter "conflict")
      const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      if (await this.git.hasUnmerged() || /CONFLICT|Automatic merge failed/i.test(text)) {
        await this.git.abortMerge();
        this.store.setStatus(taskId, "conflict");
        this.store.addEvent(taskId, task.agent, "error", `merge conflitou com ${task.base} — resolva manualmente`, false);
        throw new Error(`conflito ao mergear em ${task.base}. O merge foi abortado e a branch preservada — resolva o conflito e tente de novo.`);
      }
      const why = mergeFailReason(text);
      this.store.addEvent(taskId, task.agent, "error", `não deu pra mergear: ${why}`, false);
      throw new Error(`não deu pra mergear em ${task.base}: ${why}`);
    }
    try {
      await this.git.worktreeRemove(task.worktree);
    } catch {
      /* ok */
    }
    await this.git.branchDelete(task.branch);
    this.store.releaseClaims(taskId);
    this.store.setStatus(taskId, "merged");
    await this.mobileTaskEnd(taskId, task.worktree);
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
    await this.mobileTaskEnd(taskId, task.worktree);
    this.store.deleteTask(taskId);
  }

  // ================= MODO TERMINAL (src/terminal.ts) =================
  // A tarefa roda o CLI OFICIAL num PTY do app; o motor não tem o processo. O que o pipeline fazia ao
  // fim de cada papel acontece aqui, disparado pelo hook Stop (fim do turno) — mesma régua de entrega.

  /** Papel, contexto (barramento, memória, skills, épico) e a spec — o mesmo que um papel do pipeline recebe. */
  terminalContext(taskId: string): { task: TaskRow; spec: TaskSpec; role: AgentRole; ctx: string } {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    if (stickEngines(spec)) this.store.updateSpec(taskId, JSON.stringify(spec));
    this.bus.policy = spec.autonomy.busPolicy ?? "first-claim-wins";
    const roles = spec.roles?.length ? spec.roles : [{ role: "builder" as Role, name: spec.agent, engine: spec.engine, model: spec.model }];
    // um terminal = uma sessão: conversa com quem CONSTRÓI (o planner/reviewer do pipeline viram pedidos na conversa)
    const role = roles.find((r) => r.role === "builder") ?? roles.find((r) => canTalk(r.engine)) ?? roles[0];
    this.prepEpic(spec, task.worktree);
    const persona = role.persona ? `## Seu perfil (${role.name} · ${role.role})\n${role.persona}\n\n` : "";
    const ctx = persona + this.projectMemory(spec) + this.bus.buildContext(spec) + this.selfServe() + this.skillsContext(role) + this.issueContext(spec) + this.epicContext(spec);
    return { task, spec, role, ctx };
  }

  /**
   * FIM DE TURNO no terminal (hook Stop / notify do Codex): commita o que ficou solto, recalcula o diff,
   * coleta artefatos, roda o GATE (verifyProofs) e leva a tarefa pra "review". Se um turno novo começou
   * no meio (sessão ocupada de novo), não mexe no status. Devolve o resultado do gate.
   */
  async terminalTurnEnd(taskId: string, isBusy: () => boolean = () => false): Promise<{ ok: boolean; reasons: string[] } | null> {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const spec = JSON.parse(task.spec_json) as TaskSpec;
    const role = spec.roles?.find((r) => r.role === "builder") ?? spec.roles?.[0];
    const agent = role?.name || spec.agent;
    // tarefa INTEGRADA reaberta só pra conversa: nada de commit, gate, status ou PR — o turno foi só pergunta/resposta
    if (task.status === "merged") return null;
    await this.collectArtifacts(taskId, task.worktree, agent).catch(() => {});
    if (spec.kind !== "review") {
      try {
        if (await this.git.commitAll(task.worktree, `starfork(terminal): ${task.title}`)) {
          this.store.addEvent(taskId, agent, "note", "mudanças do turno commitadas na branch ✓", true, role?.role);
        }
        const d = await this.git.diffStat(task.worktree, task.base);
        this.store.setDiff(taskId, d.files, d.add, d.del);
      } catch (err) {
        this.store.addEvent(taskId, agent, "note", `falha ao commitar o turno: ${(err as Error).message}`, false, role?.role);
      }
    }
    const gate = await this.verifyProofs(taskId, task, spec).catch((e) => ({ ok: false, reasons: [String((e as Error)?.message ?? e)] }));
    this.store.addEvent(taskId, "Sistema", "note", gate.ok ? "gate de verificação: ok — requisitos provados com evidência" : `gate de verificação: pendente — ${gate.reasons.slice(0, 3).join(" · ")}`, gate.ok);
    if (isBusy()) return gate; // a pessoa já mandou outra coisa: o turno novo manda no status
    const cur = this.store.getTask(taskId);
    const wasReview = cur?.status === "review";
    if (cur && ["running", "thinking", "queued", "draft", "review", "error"].includes(cur.status)) {
      this.store.releaseClaims(taskId);
      this.store.setStatus(taskId, "review");
    }
    this.harvestBrain(task.worktree, taskId, task.title);
    if (!wasReview) {
      notify("Starfork", "Turno concluído no terminal — pronta pra revisar", task.title);
      this.appendHistory(taskId);
      this.harvestRunbook(task.worktree);
      if (gate.ok) await this.maybeOpenPr(taskId, task, spec);
    }
    return gate;
  }

  close(): void {
    this.store.close();
  }
}

/** Pedido de ENTREGÁVEL sob demanda ("pedir prova/doc/testes") — o mesmo texto no modo automático e no terminal. */
export function deliverPrompt(kind: "doc" | "tests" | "proof" | "all"): string {
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
  return PROMPTS[kind] ?? PROMPTS.all;
}

/** Evidência citada no requirements.json existe no disco como ARQUIVO comum, DENTRO da pasta de artefatos ou da
 * worktree? Aceita "x.png", "./x.png", ".cardume/artifacts/x.png" (antes o "." de ".cardume" era comido e a prova
 * citada assim reprovava) e caminho do repo relativo à worktree ("tests/login.test.ts"). Recusa ".", "..",
 * pastas, absolutos fora dessas pastas e symlink que aponta pra fora. */
export function evidenceExists(artDir: string, worktree: string, e: string): boolean {
  const raw = String(e ?? "").trim();
  if (!raw || raw === "." || raw === "..") return false;
  const real = (p: string) => { try { return realpathSync(p); } catch { return ""; } };
  const roots = [real(artDir), real(worktree)].filter(Boolean);
  const inside = (p: string) => roots.some((r) => { const rel = relative(r, p); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); });
  const name = raw.replace(/^(\.\/)?(\.cardume\/artifacts\/)?/, "");
  const cands = isAbsolute(raw) ? [raw] : [join(artDir, name), join(worktree, raw)];
  return cands.some((p) => {
    const r = real(p);
    if (!r || !inside(r)) return false;
    try { return statSync(r).isFile(); } catch { return false; }
  });
}
