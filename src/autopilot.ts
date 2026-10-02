// PILOTO AUTOMÁTICO — da ideia ao app pronto, sem humano, num projeto LOCAL (git sem remoto).
// `cardume autopilot --idea "…" --dir <pasta>`: cria a pasta (git init + 1º commit), planeja um ÉPICO local
// (onda 0 = esqueleto do app; tarefas com "pronto quando", requisitos verificáveis e dependências), roda as
// tarefas sozinho (política autônoma: o ask_human responde na hora — src/mcp/server.ts), passa cada entrega
// pelo GATE de provas (Orchestrator.verifyProofs), refaz com os motivos até N tentativas, faz merge LOCAL na
// main, segue pras desbloqueadas, roda a verificação final do épico e escreve AUTOPILOT.md.
// Estado em .cardume/autopilot/state.json (o app lê pra mostrar o progresso); rodar de novo na mesma pasta
// CONTINUA do estado; o arquivo .cardume/autopilot/STOP para entre passos; o teto de custo para com relatório.
// NUNCA: remoto, push, PR; perguntar ao humano; apagar trabalho de tarefa que falhou (fica na branch dela).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, engineKind, pidAlive } from "./orchestrator.ts";
import { GitService } from "./git.ts";
import { aiOnce, engineOf } from "./ai-once.ts";
import { extractJson } from "./memory.ts";
import { renderEpicMd, writeEpicContext, type EpicContext, type EpicTaskItem } from "./epic-context.ts";
import { run } from "./util/run.ts";
import { notify } from "./util/notify.ts";
import { slugify, type TaskSpec } from "./types.ts";

export type ApPlatform = "web" | "ios" | "android" | "mobile";
export const AP_PLATFORMS: ApPlatform[] = ["web", "ios", "android", "mobile"];
/** Limites do piloto — os MESMOS nas três camadas: aqui (motor), app/src-tauri/src/autopilot.rs
 * (AP_MAX_PARALLEL/AP_MAX_ATTEMPTS) e app/src/js/56-piloto.js (PILOTO_MAX_PAR/PILOTO_MAX_ATT). */
export const AP_MAX_PARALLEL = 4;
export const AP_MAX_ATTEMPTS = 5;
/** Fases em que o piloto terminou (o processo saiu ou vai sair). */
export const AP_END_PHASES: ApPhase[] = ["done", "stopped", "budget", "failed"];
export type ApPhase = "starting" | "creating" | "planning" | "building" | "final" | "report" | "done" | "stopped" | "budget" | "failed";
export type ApStage = "pending" | "running" | "verify" | "merge" | "merged" | "blocked";

export interface ApPlanTask {
  id: string;
  title: string;
  objective: string;
  requirements: string[];
  verify: string;
  covers: string[];
  after: string[];
  owns: string[];
  wave: number;
}
export interface ApEpic {
  epicId: string;
  title: string;
  outcome: string;
  requirements: { id: string; text: string }[];
  doneWhen: { id: string; text: string }[];
  boundaries: string[];
  tasks: ApPlanTask[];
}
export interface ApTaskState {
  id: string;
  title: string;
  after: string[];
  wave: number;
  final?: boolean;
  stage: ApStage;
  attempts: number;
  /** motivos da última reprovação (ou do bloqueio) */
  reasons: string[];
  /** ajuste pendente pro próximo rework (motivos da prova/conflito). Fica gravado ATÉ o rework rodar — uma queda
   * no meio não faz o piloto re-verificar a entrega velha. */
  rework?: string;
  /** o ajuste já foi entregue ao agente (addInstruction) — retomada não duplica a instrução */
  reworkSent?: boolean;
  triedResolver?: boolean;
  history: { attempt: number; ok: boolean; reasons: string[]; at: number }[];
  startedAt?: number;
  endedAt?: number;
}
export interface ApEvent { at: number; text: string; taskId?: string; ok?: boolean }
export interface ApState {
  version: 1;
  idea: string;
  name: string;
  platform: ApPlatform;
  engine: string;
  model?: string;
  parallel: number;
  attempts: number;
  budgetUsd: number;
  dir: string;
  epicId: string;
  epicTitle: string;
  phase: ApPhase;
  /** última fase de TRABALHO alcançada (não muda nas fases de fim) — a aba mostra onde parou/falhou */
  lastPhase?: ApPhase;
  /** processo que está rodando o piloto agora (0 = ninguém) */
  pid: number;
  runs: number;
  startedAt: number;
  /** início DESTA rodada (o pid é dela): pid vivo que nasceu depois disto é pid reciclado */
  runStartedAt?: number;
  updatedAt: number;
  finishedAt?: number;
  stopReason?: string;
  /** custo total: tarefas + planejamento */
  costUsd: number;
  /** custo da chamada de planejamento (IA auxiliar) — entra no costUsd e no teto */
  planCostUsd?: number;
  tasks: ApTaskState[];
  events: ApEvent[];
}
export interface AutopilotOptions {
  idea?: string;
  dir: string;
  name?: string;
  platform?: ApPlatform;
  engine?: string;
  model?: string;
  parallel?: number;
  attempts?: number;
  budgetUsd?: number;
  /** plano pronto (JSON no formato do planejador) — pula a IA de planejamento */
  planFile?: string;
  log?: (line: string) => void;
}
export interface AutopilotHooks {
  /** chamado a cada gravação do estado (testes usam pra pedir "parar" num ponto exato) */
  onSave?: (s: ApState) => void;
}

export const apDir = (dir: string) => join(dir, ".cardume", "autopilot");
export const stateFile = (dir: string) => join(apDir(dir), "state.json");
export const epicFile = (dir: string) => join(apDir(dir), "epic.json");
export const epicMdFile = (dir: string) => join(apDir(dir), "EPIC.md");
export const stopFile = (dir: string) => join(apDir(dir), "STOP");
/** trava exclusiva (O_EXCL) de quem está rodando o piloto nesta pasta: {pid, at} */
export const lockFile = (dir: string) => join(apDir(dir), "lock");
/** marcador do app (Rust autopilot_start/resume) entre o spawn e o CLI pegar a trava — o CLI apaga ao pegar */
export const startingFile = (dir: string) => join(apDir(dir), "starting");
/** assunto do 1º commit do piloto (pasta só com ele = retomável) */
export const FIRST_COMMIT_MSG = "chore: projeto criado pelo piloto automático do Starfork";
const MAX_EVENTS = 400;
const FINAL_ID = "verificacao-final";

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function readState(dir: string): ApState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(resolve(dir)), "utf8")) as ApState;
    return s && s.version === 1 && Array.isArray(s.tasks) ? s : null;
  } catch {
    return null;
  }
}
export function readEpic(dir: string): ApEpic | null {
  try {
    const e = JSON.parse(readFileSync(epicFile(resolve(dir)), "utf8")) as ApEpic;
    return e && Array.isArray(e.tasks) ? e : null;
  } catch {
    return null;
  }
}
/** Pede pra parar: o piloto termina o passo atual e para (relatório "parado"). */
export function requestStop(dir: string): void {
  writeAtomic(stopFile(resolve(dir)), new Date().toISOString() + "\n");
}

// ---------------------------------------------------------------- trava (um piloto por pasta)

export interface ApLock { pid: number; at: number }
export function readLock(dir: string): ApLock | null {
  try {
    const o = JSON.parse(readFileSync(lockFile(resolve(dir)), "utf8")) as ApLock;
    return o && Number(o.pid) > 0 ? { pid: Number(o.pid), at: Number(o.at) || 0 } : null;
  } catch {
    return null;
  }
}
/** A trava está VALENDO? Dono vivo e nascido antes da trava (pid reciclado não segura). Trava recém-criada e
 * ainda vazia (o dono está escrevendo) também vale por alguns segundos. */
export function lockHeld(dir: string): ApLock | null {
  const l = readLock(dir);
  if (l) return pidAlive(l.pid, l.at || null) ? l : null;
  try {
    if (Date.now() - statSync(lockFile(resolve(dir))).mtimeMs < 5000) return { pid: 0, at: 0 };
  } catch { /* sem trava */ }
  return null;
}
/**
 * Pega a trava EXCLUSIVA (O_EXCL) do piloto nesta pasta; devolve quem a solta. Trava obsoleta (dono morto ou pid
 * reciclado) é tomada. Dois pilotos na mesma pasta → o segundo recebe erro (inclusive no mesmo processo).
 */
export function acquireLock(dir: string): () => void {
  mkdirSync(apDir(dir), { recursive: true });
  for (let i = 0; i < 3; i++) {
    let fd: number;
    try {
      fd = openSync(lockFile(dir), "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = lockHeld(dir);
      if (held) throw new Error(`o piloto já está rodando nesta pasta${held.pid ? ` (processo ${held.pid})` : ""}`);
      rmSync(lockFile(dir), { force: true }); // obsoleta: toma
      continue;
    }
    const me: ApLock = { pid: process.pid, at: Date.now() };
    try { writeSync(fd, JSON.stringify(me)); } finally { closeSync(fd); }
    return () => {
      const cur = readLock(dir);
      if (cur && cur.pid === me.pid && cur.at === me.at) rmSync(lockFile(dir), { force: true });
    };
  }
  throw new Error("não consegui pegar a trava do piloto nesta pasta — tente de novo");
}

// ---------------------------------------------------------------- planejamento

const PLATFORM_STACK: Record<ApPlatform, string> = {
  web: "app WEB que roda localmente no navegador (escolha a stack MAIS SIMPLES que entrega a ideia — ex.: Vite + TypeScript, ou HTML/CSS/JS puro para jogos simples)",
  ios: "app iOS que roda no Simulador do Xcode (SwiftUI com projeto Xcode, ou Expo/React Native se for mais simples)",
  android: "app Android que roda no emulador (Kotlin + Gradle, ou Expo/React Native se for mais simples)",
  mobile: "app MOBILE multiplataforma com Expo (React Native) que roda no Simulador iOS e no emulador Android",
};

/** Comando `cardume` deste processo (node + CLI) — pro agente chamar `cardume mobile …`. */
function cardumeCmd(): string {
  const node = `"${process.execPath}"` + (process.execArgv.includes("--experimental-sqlite") ? " --experimental-sqlite" : "");
  const cli = process.argv[1] && /cli\.(ts|mjs|js)$/.test(process.argv[1]) ? process.argv[1] : fileURLToPath(new URL("./cli.ts", import.meta.url));
  return `${node} "${cli}"`;
}

/** Requisito de PROVA da plataforma (vai no esqueleto e na verificação final). */
export function platformProofReq(platform: ApPlatform): string {
  if (platform === "web") return "Prova web: o app roda localmente e há um print REAL da tela no navegador salvo em .cardume/artifacts/ e citado no requirements.json";
  const plat = platform === "android" ? "android" : "ios";
  return `Prova mobile: print e vídeo REAIS do app rodando no ${platform === "android" ? "emulador Android" : "Simulador iOS"}${platform === "mobile" ? " (e no emulador Android, se houver)" : ""}, gerados com \`cardume mobile up --platform ${plat}\`, \`shot\` e \`rec start|stop\`, salvos em .cardume/artifacts/ e citados no requirements.json (sem simulador nesta máquina → requisito "blocked" com o motivo exato)`;
}

/** Instrução extra no objetivo de toda tarefa (como provar nesta plataforma). */
export function platformHint(platform: ApPlatform): string {
  if (platform === "web") return " Prove o que for visual com print REAL do navegador (suba o app local e capture a tela).";
  return ` Prove o que for visual no simulador/emulador com o comando do Starfork: ${cardumeCmd()} mobile up --platform ${platform === "android" ? "android" : "ios"} · … mobile shot <nome> · … mobile rec start / rec stop · … mobile down (prints e vídeos vão pra .cardume/artifacts/).`;
}

export function planPrompt(idea: string, platform: ApPlatform): string {
  return (
    "Você é um tech lead planejando um APP DO ZERO que agentes de IA vão construir SOZINHOS, sem nenhum humano pra responder perguntas, " +
    "num repositório git LOCAL vazio (só README.md e .gitignore). Cada tarefa vira branch + worktree própria; tarefas sem dependência entre si rodam AO MESMO TEMPO; " +
    "cada entrega só entra na main se PROVAR seus requisitos (print, teste ou saída de comando).\n" +
    `PLATAFORMA: ${PLATFORM_STACK[platform]}.\n` +
    "Responda SOMENTE um objeto JSON válido, sem markdown, neste formato: " +
    '{"epic":"nome curto do app","outcome":"1 frase: o que a pessoa consegue fazer no app pronto","requirements":[{"id":"R1","text":"requisito do app, uma linha"}],' +
    '"doneWhen":["checagem que uma PESSOA roda no app pronto, sem abrir nenhuma tarefa (3 a 6)"],"boundaries":["o que fica FORA (ex.: login, servidor pago)"],' +
    '"tasks":[{"title":"verbo + objeto (máx 60 chars)","objective":"2-4 frases: o que fazer, onde e o entregável","verify":"1 linha: como se prova que ESTA tarefa entregou",' +
    '"covers":["R1"],"after":[],"requirements":["critério verificável no app rodando (2 a 4)"],"owns":"pastas/arquivos que ela mexe, separados por vírgula"}]}. ' +
    "REGRAS: (1) tasks[0] é SEMPRE o ESQUELETO (onda 0): criar o projeto do app na raiz do repositório com a stack escolhida, um README.md com os comandos EXATOS pra instalar e rodar, " +
    "rodar de verdade e provar a tela inicial; after=[] e owns=\"**\". (2) Todas as outras tarefas vêm depois do esqueleto (`after` contém 0). " +
    "(3) `after` são os ÍNDICES (0-based) das tarefas que precisam estar PRONTAS antes; nenhuma depende de uma posterior. (4) Organize por VALOR pro usuário (uma funcionalidade inteira por tarefa), nunca por camada técnica. " +
    "(5) Tarefas que podem rodar juntas têm `owns` DISJUNTOS; se duas mexem nos MESMOS arquivos, serialize com `after`. (6) De 3 a 7 tarefas no total. " +
    "(7) Tudo roda LOCAL e offline: nada de contas, chaves de API, serviços pagos, login externo nem publicação em loja. " +
    "(8) Cada requisito é provável no app rodando; juntas, as tarefas cobrem todos os requirements do épico (covers). NÃO devolva `wave`.\n\n" +
    `IDEIA:\n${idea.slice(0, 4000)}`
  );
}

/** Plano FIXO do motor mock (sem IA): esqueleto + 2 funcionalidades depois dele. */
export function mockPlan(idea: string, platform: ApPlatform): unknown {
  const short = idea.trim().split(/\s+/).slice(0, 6).join(" ");
  return {
    epic: short || "App",
    outcome: `A pessoa usa o app: ${idea.trim().slice(0, 120)}`,
    requirements: [{ id: "R1", text: "O app abre e mostra a tela inicial" }, { id: "R2", text: "A funcionalidade principal funciona" }],
    doneWhen: ["Abrir o app mostra a tela inicial", "Usar a funcionalidade principal funciona do começo ao fim"],
    boundaries: ["sem login", "sem servidor externo"],
    tasks: [
      { title: "Criar o esqueleto do app", objective: `Criar o projeto (${platform}) e a tela inicial.`, verify: "o app roda e mostra a tela inicial", covers: ["R1"], after: [], requirements: ["O app roda e mostra a tela inicial"], owns: "src/esqueleto/**" },
      { title: "Funcionalidade principal", objective: "Implementar a funcionalidade principal.", verify: "a funcionalidade funciona", covers: ["R2"], after: [0], requirements: ["A funcionalidade principal funciona"], owns: "src/principal/**" },
      { title: "Tela de ajustes", objective: "Implementar a tela de ajustes.", verify: "os ajustes são salvos", covers: ["R2"], after: [0], requirements: ["Os ajustes são salvos"], owns: "src/ajustes/**" },
    ],
  };
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];

/**
 * PURA: plano cru (da IA, do mock ou de --plan) → épico local consistente. Ids únicos (slug do título), `after`
 * em ids (só pra tarefas ANTERIORES — sem ciclo), todo mundo depois do esqueleto, onda derivada, requisito de
 * prova da plataforma no esqueleto, "pronto quando" com ids D1…
 */
export function normalizePlan(raw: unknown, idea: string, platform: ApPlatform): ApEpic {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = (Array.isArray(r.tasks) ? r.tasks : []).filter((t) => t && typeof t === "object").slice(0, 8) as Record<string, unknown>[];
  if (!list.length) throw new Error("o plano veio sem tarefas");
  const ids: string[] = [];
  for (const t of list) {
    const base = slugify(String(t.title ?? "")) || "tarefa"; // título só com símbolos → "tarefa", "tarefa-2"…
    let id = base;
    for (let n = 2; ids.includes(id) || id === FINAL_ID; n++) id = `${base}-${n}`;
    ids.push(id);
  }
  const titleIdx = (x: string) => list.findIndex((t) => slugify(String(t.title ?? "")) === slugify(x));
  const tasks: ApPlanTask[] = list.map((t, i) => {
    let after: string[] = [];
    for (const a of Array.isArray(t.after) ? t.after : []) {
      const n = typeof a === "number" ? a : /^\d+$/.test(String(a).trim()) ? Number(a) : ids.indexOf(String(a)) >= 0 ? ids.indexOf(String(a)) : titleIdx(String(a));
      if (Number.isInteger(n) && n >= 0 && n < i && !after.includes(ids[n])) after.push(ids[n]);
    }
    if (i > 0 && !after.length) after = [ids[0]]; // ninguém roda antes do esqueleto existir
    if (i === 0) after = [];
    const title = String(t.title ?? "").trim().slice(0, 80) || `Tarefa ${i + 1}`;
    const verify = String(t.verify ?? "").trim();
    let requirements = strs(t.requirements).slice(0, 6);
    if (!requirements.length) requirements = [verify || title];
    if (i === 0) {
      if (!requirements.some((x) => /readme/i.test(x))) requirements.push("README.md na raiz explica como instalar e rodar o app, com os comandos exatos");
      requirements.push(platformProofReq(platform));
    }
    const owns = i === 0 ? (strs(t.owns).length ? strs(t.owns) : ["**"]) : strs(t.owns);
    return { id: ids[i], title, objective: String(t.objective ?? "").trim() || title, requirements, verify: verify || requirements[0], covers: strs(t.covers), after, owns, wave: 0 };
  });
  const wave = new Map<string, number>();
  for (const t of tasks) { t.wave = t.after.length ? 1 + Math.max(...t.after.map((a) => wave.get(a) ?? 0)) : 0; wave.set(t.id, t.wave); }
  const reqs = (Array.isArray(r.requirements) ? r.requirements : []).map((x, i) => {
    const o = x as { id?: unknown; text?: unknown };
    return { id: String(o?.id ?? `R${i + 1}`).trim() || `R${i + 1}`, text: String(o?.text ?? x ?? "").trim() };
  }).filter((x) => x.text && x.text !== "[object Object]");
  let dw = strs(r.doneWhen).slice(0, 8);
  if (!dw.length) dw = ["Abrir o app mostra a tela inicial", `Dá pra usar o app pra: ${idea.trim().slice(0, 100)}`];
  const title = String(r.epic ?? "").trim().slice(0, 90) || idea.trim().slice(0, 60) || "App";
  return {
    epicId: "piloto-" + (slugify(title).slice(0, 40).replace(/-+$/, "") || "tarefa"),
    title,
    outcome: String(r.outcome ?? "").trim() || idea.trim().slice(0, 200),
    requirements: reqs,
    doneWhen: dw.map((text, i) => ({ id: `D${i + 1}`, text })),
    boundaries: strs(r.boundaries).slice(0, 6),
    tasks,
  };
}

/** Planeja com a IA DO PILOTO (motor/modelo escolhidos — não a IA auxiliar padrão); custo vai pro livro de uso
 * como "autopilot" e volta por `onCost` pra entrar no teto. */
async function planEpic(o: { idea: string; platform: ApPlatform; engine: string; model?: string; planFile?: string; dir: string; onCost?: (usd: number) => void }): Promise<ApEpic> {
  let raw: unknown;
  if (o.planFile) raw = JSON.parse(readFileSync(o.planFile, "utf8"));
  else if (engineKind(o.engine) === "mock") raw = mockPlan(o.idea, o.platform);
  else {
    const out = await aiOnce(planPrompt(o.idea, o.platform), {
      tier: "capaz", timeout: 600_000, engine: o.engine, model: o.model,
      claudeModel: engineOf(o.engine) === "claude" ? o.model || undefined : undefined,
      usage: { source: "autopilot", project: o.dir }, onCost: o.onCost,
    });
    raw = extractJson(out);
    if (!raw) throw new Error("a IA não devolveu um plano em JSON — tente de novo");
  }
  return normalizePlan(raw, o.idea, o.platform);
}

// ---------------------------------------------------------------- agendador (puro)

/** Dependências que bloquearam: a tarefa vira "blocked" (com o motivo) quando alguma dependência foi bloqueada. */
export function propagateBlocked(tasks: ApTaskState[]): string[] {
  const changed: string[] = [];
  for (let loop = true; loop;) {
    loop = false;
    for (const t of tasks) {
      if (t.stage !== "pending") continue;
      const dead = t.after.find((a) => tasks.find((x) => x.id === a)?.stage === "blocked");
      if (dead) {
        t.stage = "blocked";
        t.reasons = [`depende de "${tasks.find((x) => x.id === dead)?.title ?? dead}", que ficou bloqueada`];
        changed.push(t.id);
        loop = true;
      }
    }
  }
  return changed;
}
/** Tarefas que podem andar agora: ainda não terminaram e todas as dependências já estão MERGEADAS na main. */
export function runnable(tasks: ApTaskState[]): ApTaskState[] {
  const merged = new Set(tasks.filter((t) => t.stage === "merged").map((t) => t.id));
  return tasks
    .filter((t) => t.stage !== "merged" && t.stage !== "blocked" && t.after.every((a) => merged.has(a)))
    .sort((a, b) => a.wave - b.wave);
}

// ---------------------------------------------------------------- projeto

async function git(dir: string, ...args: string[]) {
  return run("git", ["-C", dir, ...args]);
}

async function hasHead(dir: string): Promise<boolean> {
  try { await git(dir, "rev-parse", "--verify", "-q", "HEAD"); return true; } catch { return false; }
}
/** Dá pra (re)começar o piloto nesta pasta? Inexistente, vazia (fora .cardume/.DS_Store) ou só com o esqueleto
 * do PRÓPRIO piloto (git + README + .gitignore, no máximo o 1º commit dele — criação interrompida). */
export async function canStartIn(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  const left = readdirSync(dir).filter((f) => f !== ".cardume" && f !== ".DS_Store");
  if (!left.length) return true;
  if (!left.includes(".git") || !left.every((f) => [".git", "README.md", ".gitignore"].includes(f))) return false;
  if (!(await hasHead(dir))) return true; // git init feito, commit não
  try {
    const subjects = (await git(dir, "log", "--format=%s", "-n", "2", "HEAD")).stdout.trim().split("\n");
    return subjects.length === 1 && subjects[0] === FIRST_COMMIT_MSG;
  } catch {
    return false;
  }
}
const NOT_EMPTY = (dir: string) => `a pasta ${dir} já existe e não está vazia — o piloto automático só cria projeto em pasta nova (ou continua um piloto que já começou nela)`;

/** Pasta nova (ou vazia) → git init na main, README + .gitignore + 1º commit. NUNCA cria remoto. Idempotente:
 * retoma uma criação interrompida (git sem commit, ou só o 1º commit do piloto). */
/** Põe o projeto no topo da lista do app (~/.cardume/projects.json, a mesma do "Abrir projeto"),
 *  pra quem roda o piloto pela CLI achar o projeto no Starfork. Best-effort. */
export function registerProject(dir: string, home = homedir()): void {
  try {
    const f = join(home, ".cardume", "projects.json");
    let list: string[] = [];
    try { const v = JSON.parse(readFileSync(f, "utf8")); if (Array.isArray(v)) list = v.filter((x) => typeof x === "string"); } catch { /* sem lista ainda */ }
    const abs = resolve(dir);
    writeFileSync(f, JSON.stringify([abs, ...list.filter((p) => p !== abs)], null, 2));
  } catch { /* lista é conveniência — nunca derruba o piloto */ }
}

export async function createProject(dir: string, name: string): Promise<void> {
  if (!(await canStartIn(dir))) throw new Error(NOT_EMPTY(dir));
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    try {
      await run("git", ["init", "-q", "-b", "main", dir]);
    } catch {
      await run("git", ["init", "-q", dir]);
      await git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    }
  }
  // identidade LOCAL (do repo) quando o git não tem uma — os commits das worktrees e os merges precisam dela
  let email = "";
  try { email = (await git(dir, "config", "user.email")).stdout.trim(); } catch { /* sem identidade */ }
  if (!email) {
    await git(dir, "config", "user.name", "Starfork Piloto");
    await git(dir, "config", "user.email", "piloto@starfork.local");
  }
  if (await hasHead(dir)) return; // o 1º commit já existe (retomada)
  if (!existsSync(join(dir, "README.md"))) writeFileSync(join(dir, "README.md"), `# ${name}\n\nProjeto criado pelo piloto automático do Starfork.\n`, "utf8");
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), ".DS_Store\nnode_modules/\n.env\n.cardume/\n", "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", FIRST_COMMIT_MSG);
}

// ---------------------------------------------------------------- relatório

const fmtUsd = (n: number) => `US$ ${n.toFixed(2)}`;
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
export const STAGE_PT: Record<ApStage, string> = { pending: "na fila", running: "rodando", verify: "verificando", merge: "mergeando", merged: "mergeada ✓", blocked: "bloqueada ✕" };
export const PHASE_PT: Record<ApPhase, string> = {
  starting: "começando", creating: "criando o projeto", planning: "planejando o épico", building: "construindo", final: "verificação final",
  report: "escrevendo o relatório", done: "concluído", stopped: "parado", budget: "parou por custo", failed: "falhou",
};

function readJson(p: string | null): unknown { if (!p) return null; try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

/**
 * Onde está a versão MAIS NOVA de um artefato da tarefa (`requirements.json`, `ASSUMPTIONS.md`…). O agente escreve
 * em `.cardume/artifacts/<arquivo>` NA WORKTREE dele; ao fim de cada turno o orquestrador (collectArtifacts) copia
 * pra `<repo>/.cardume/artifacts/<taskId>/` — e quando o arquivo MUDOU entre tentativas a cópia nova vira
 * `<nome>-v2.<ext>`, `-v3`… A worktree some depois do merge, então: worktree (se ainda existe) → maior versão coletada.
 */
export function latestArtifact(repo: string, taskId: string, name: string, worktree?: string | null): string | null {
  if (worktree) {
    const w = join(worktree, ".cardume", "artifacts", name);
    if (existsSync(w)) return w;
  }
  const dir = join(repo, ".cardume", "artifacts", taskId);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  let best: { n: number; f: string } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (f === name) { if (!best) best = { n: 1, f }; continue; }
      if (f.startsWith(stem + "-v") && f.endsWith(ext)) {
        const n = Number(f.slice(stem.length + 2, f.length - ext.length));
        if (Number.isInteger(n) && n > 1 && (!best || n > best.n)) best = { n, f };
      }
    }
  } catch { /* nada coletado */ }
  return best ? join(dir, best.f) : null;
}

/** Relatório AUTOPILOT.md: ideia, épico, linha do tempo, tarefas (status/tentativas/provas), suposições, custo e como rodar. */
export function renderReport(s: ApState, epic: ApEpic | null, extra: { costs: Map<string, number>; questions: string[]; worktrees?: Map<string, string> }): string {
  const L: string[] = [];
  const result = s.phase === "done"
    ? (s.tasks.every((t) => t.stage === "merged") ? "✓ app pronto — todas as tarefas e a verificação final passaram" : "concluído com pendências — veja as tarefas bloqueadas")
    : s.phase === "budget" ? `parou por custo — o teto de ${fmtUsd(s.budgetUsd)} foi atingido (${fmtUsd(s.costUsd)})`
    : s.phase === "stopped" ? "parado a pedido — rode de novo na mesma pasta pra continuar"
    : s.phase === "failed" ? `falhou: ${s.stopReason ?? "erro inesperado"}` : PHASE_PT[s.phase];
  L.push(`# Piloto automático — ${epic?.title || s.epicTitle || s.name || "app"}`, "");
  L.push(`**Resultado:** ${result}`, "");
  L.push(`- Plataforma: ${s.platform} · IA: ${s.engine}${s.model ? " (" + s.model + ")" : ""} · paralelo: ${s.parallel} · tentativas por tarefa: ${s.attempts}`);
  L.push(`- Início: ${when(s.startedAt)}${s.finishedAt ? ` · fim: ${when(s.finishedAt)}` : ""} · rodadas do piloto: ${s.runs}`, "");
  L.push("## Ideia", "", s.idea, "");
  if (epic) {
    L.push("## Épico", "", `**${epic.title}** — ${epic.outcome}`, "");
    if (epic.requirements.length) { L.push("Requisitos:"); epic.requirements.forEach((r) => L.push(`- ${r.id}: ${r.text}`)); L.push(""); }
    const fin = s.tasks.find((t) => t.final);
    L.push("Pronto quando:");
    epic.doneWhen.forEach((d) => L.push(`- [${fin?.stage === "merged" ? "x" : " "}] ${d.id}: ${d.text}`));
    L.push("");
    if (epic.boundaries.length) { L.push("Fora do escopo: " + epic.boundaries.join("; "), ""); }
  }
  L.push("## Tarefas", "", "| Tarefa | Onda | Status | Tentativas | Custo |", "|---|---|---|---|---|");
  for (const t of s.tasks) L.push(`| ${t.title}${t.final ? " (verificação final)" : ""} | ${t.final ? "final" : t.wave} | ${STAGE_PT[t.stage]} | ${t.attempts} | ${fmtUsd(extra.costs.get(t.id) ?? 0)} |`);
  L.push("");
  for (const t of s.tasks) {
    L.push(`### ${t.title}`, "");
    if (t.stage === "blocked") L.push(`Bloqueada: ${t.reasons.join(" · ") || "sem motivo registrado"}. O trabalho dela continua na branch da tarefa (nada foi apagado).`, "");
    const reqs = readJson(latestArtifact(s.dir, t.id, "requirements.json", extra.worktrees?.get(t.id)));
    const list = (Array.isArray(reqs) ? reqs : reqs && Array.isArray((reqs as { list?: unknown }).list) ? (reqs as { list: unknown[] }).list : []) as { req?: string; status?: string; evidence?: string[] }[];
    if (list.length) {
      L.push("Provas:");
      for (const r of list) {
        const ev = (r.evidence ?? []).map((e) => `[${String(e).split("/").pop()}](.cardume/artifacts/${t.id}/${evidenceRel(e)})`).join(", ");
        L.push(`- ${r.status === "done" ? "✓" : "✕"} ${r.req ?? "requisito"}${ev ? " — " + ev : ""}`);
      }
      L.push("");
    }
    for (const h of t.history.filter((x) => !x.ok)) L.push(`- tentativa ${h.attempt} reprovada: ${h.reasons.slice(0, 3).join(" · ")}`);
    if (t.history.some((x) => !x.ok)) L.push("");
  }
  L.push("## Suposições (a IA decidiu sozinha)", "");
  let any = false;
  for (const t of s.tasks) {
    try {
      const f = latestArtifact(s.dir, t.id, "ASSUMPTIONS.md", extra.worktrees?.get(t.id));
      const txt = f ? readFileSync(f, "utf8").trim() : "";
      if (txt) { L.push(`**${t.title}**`, "", txt, ""); any = true; }
    } catch { /* sem suposições nesta tarefa */ }
  }
  for (const q of extra.questions) { L.push(`- ${q}`); any = true; }
  if (!any) L.push("_(nenhuma registrada)_");
  L.push("");
  L.push("## Custo", "", `Total: **${fmtUsd(s.costUsd)}**${s.planCostUsd ? ` (planejamento: ${fmtUsd(s.planCostUsd)})` : ""}${s.budgetUsd > 0 ? ` · teto: ${fmtUsd(s.budgetUsd)}` : ""}. Na aba Uso aparece com a origem "Piloto automático" (planejamento) e "Tarefas". Em plano de assinatura o valor é o equivalente em API.`, "");
  L.push("## Como rodar o app", "");
  let readme = "";
  try { readme = readFileSync(join(s.dir, "README.md"), "utf8"); } catch { /* sem README */ }
  const sec = /^##+\s*(como rodar|rodando|executar|how to run|run|uso|getting started)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(readme);
  L.push(sec ? sec[2].trim() : "Veja o README.md na raiz do projeto.", "");
  L.push("## Linha do tempo", "");
  for (const e of s.events.slice(-120)) L.push(`- \`${when(e.at)}\` ${e.ok === false ? "✕ " : ""}${e.text}`);
  L.push("", "_Gerado pelo piloto automático do Starfork. Projeto local: sem remoto, sem push, sem PR._", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- o piloto

class Mutex {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => {});
    return r;
  }
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Caminho da evidência relativo à pasta coletada da tarefa ("./x", ".cardume/artifacts/x" → "x"). */
export function evidenceRel(e: unknown): string {
  return String(e).replace(/^(\.\/)?(\.cardume\/artifacts\/)?/, "");
}

export async function runAutopilot(o: AutopilotOptions, hooks: AutopilotHooks = {}): Promise<ApState> {
  const dir = resolve(o.dir);
  const log = o.log ?? ((l: string) => console.log(l));
  const prev = readState(dir);
  const idea = (o.idea ?? prev?.idea ?? "").trim();
  if (!idea) throw new Error('falta a ideia: use --idea "…"');
  // pasta com conteúdo que não é de um piloto: recusa ANTES de criar qualquer coisa nela
  if (!prev && !(await canStartIn(dir))) throw new Error(NOT_EMPTY(dir));
  // retomar depois do teto com um teto que já foi gasto só pararia de novo na hora: exige subir (ou 0 = sem teto)
  if (prev?.phase === "budget") {
    const cap = o.budgetUsd !== undefined && o.budgetUsd >= 0 ? o.budgetUsd : prev.budgetUsd;
    if (cap > 0 && cap <= (prev.costUsd || 0)) {
      throw new Error(`o teto de ${fmtUsd(cap)} já foi gasto (${fmtUsd(prev.costUsd || 0)}) — pra continuar, aumente o teto (--budget-usd) ou use 0 pra seguir sem teto`);
    }
  }
  // UM piloto por pasta: trava exclusiva ANTES de mexer em qualquer coisa (inclusive criar o projeto)
  const release = acquireLock(dir);
  try { rmSync(startingFile(dir), { force: true }); } catch { /* o app não marcou */ }
  try {
    return await pilot(dir, prev, idea, o, hooks, log);
  } finally {
    release();
  }
}

async function pilot(dir: string, prev: ApState | null, idea: string, o: AutopilotOptions, hooks: AutopilotHooks, log: (l: string) => void): Promise<ApState> {
  const platform: ApPlatform = (AP_PLATFORMS.includes(o.platform as ApPlatform) ? o.platform : prev?.platform ?? "web") as ApPlatform;
  const name = (o.name ?? prev?.name ?? "").trim() || idea.split(/\s+/).slice(0, 5).join(" ");
  const now = Date.now();
  const s: ApState = prev ?? {
    version: 1, idea, name, platform, engine: o.engine ?? "claude", model: o.model, parallel: 2, attempts: 2, budgetUsd: 0, dir,
    epicId: "", epicTitle: "", phase: "starting", lastPhase: "starting", pid: process.pid, runs: 0, startedAt: now, updatedAt: now, costUsd: 0, tasks: [], events: [],
  };
  const setPhase = (p: ApPhase) => { s.phase = p; if (!AP_END_PHASES.includes(p)) s.lastPhase = p; };
  // numa retomada, só o que foi passado de novo muda (teto, tentativas, paralelo, IA)
  if (o.engine) s.engine = o.engine;
  if (o.model) s.model = o.model;
  if (o.parallel && o.parallel > 0) s.parallel = Math.min(AP_MAX_PARALLEL, Math.max(1, Math.floor(o.parallel)));
  if (o.attempts && o.attempts > 0) s.attempts = Math.min(AP_MAX_ATTEMPTS, Math.max(1, Math.floor(o.attempts)));
  if (o.budgetUsd !== undefined && o.budgetUsd >= 0) s.budgetUsd = o.budgetUsd;
  s.dir = dir;
  s.pid = process.pid;
  s.runStartedAt = now;
  s.runs++;
  delete s.stopReason;
  delete s.finishedAt;
  // retomada de um fim (parado/teto/falha): enquanto roda, a fase volta pra onde o trabalho estava
  if (AP_END_PHASES.includes(s.phase)) setPhase(s.lastPhase && !AP_END_PHASES.includes(s.lastPhase) ? s.lastPhase : "building");
  // estado mínimo ANTES do git init: criação interrompida aparece na aba e é retomável (rodar de novo)
  const saveRaw = () => { s.updatedAt = Date.now(); writeAtomic(stateFile(dir), JSON.stringify(s, null, 2)); };
  saveRaw();

  const restore = { ap: process.env.CARDUME_AUTOPILOT, nt: process.env.CARDUME_NOTIFY };
  const restoreEnv = () => {
    if (restore.ap === undefined) delete process.env.CARDUME_AUTOPILOT; else process.env.CARDUME_AUTOPILOT = restore.ap;
    if (restore.nt === undefined) delete process.env.CARDUME_NOTIFY; else process.env.CARDUME_NOTIFY = restore.nt;
  };
  let orch: Orchestrator;
  try {
    if (!prev || !(await hasHead(dir))) { setPhase("creating"); saveRaw(); await createProject(dir, name); }
    // node --test (NODE_TEST_CONTEXT) não suja a lista real de projetos da pessoa
    if (!process.env.NODE_TEST_CONTEXT) registerProject(dir);
    if (await new GitService(dir).hasRemote("origin")) throw new Error("este projeto tem um remoto (origin) — o piloto automático só roda em projeto LOCAL, sem remoto");
    try { rmSync(stopFile(dir), { force: true }); } catch { /* sem pedido de parada */ }
    process.env.CARDUME_AUTOPILOT = "1"; // ask_human automático + regra de autonomia (bus) + mock que prova
    process.env.CARDUME_NOTIFY = "0"; // nada de "pronta pra review" a cada tarefa — o aviso é um só, no fim
    orch = new Orchestrator(dir); // .cardume/state.sqlite: o app só abre o projeto quando ele existe (Rust wait_state)
  } catch (e) {
    restoreEnv();
    setPhase("failed"); s.stopReason = (e as Error).message; s.pid = 0; s.finishedAt = Date.now();
    s.events.push({ at: Date.now(), text: `o piloto falhou ao preparar o projeto: ${s.stopReason}`, ok: false });
    try { saveRaw(); } catch { /* sem disco */ }
    throw e;
  }
  const gitLock = new Mutex();

  const ev = (text: string, taskId?: string, ok?: boolean) => {
    s.events.push({ at: Date.now(), text, taskId, ...(ok === undefined ? {} : { ok }) });
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    log(/^[✓✕↻▶⇢⚠·]/.test(text) ? text : `${ok === false ? "✕" : "·"} ${text}`);
  };
  /** custo por tarefa (tabela `cost` do projeto); null = banco ocupado agora (fica o último total) */
  const costs = (): Map<string, number> | null => {
    try {
      const m = new Map<string, number>();
      for (const c of orch.store.costByTask()) m.set(c.taskId, c.usd);
      return m;
    } catch { return null; }
  };
  /** total = tarefas + planejamento */
  const totalOf = (m: Map<string, number>) => round4([...m.values()].reduce((a, b) => a + b, 0) + (s.planCostUsd ?? 0));
  const save = () => {
    const m = costs();
    if (m) s.costUsd = totalOf(m);
    s.updatedAt = Date.now();
    writeAtomic(stateFile(dir), JSON.stringify(s, null, 2));
    try { hooks.onSave?.(s); } catch { /* hook de teste */ }
  };
  const halt = (): "stopped" | "budget" | null => {
    if (existsSync(stopFile(dir))) return "stopped";
    if (s.budgetUsd > 0) {
      const m = costs();
      const total = m ? totalOf(m) : s.costUsd;
      if (total >= s.budgetUsd) { s.costUsd = total; return "budget"; }
    }
    return null;
  };
  let epic: ApEpic | null = readEpic(dir);
  const epicCtx = () => {
    if (!epic) return;
    const items: EpicTaskItem[] = s.tasks.map((t) => ({ id: t.id, localId: t.id, title: t.title, status: STAGE_PT[t.stage], requirements: epic!.tasks.find((x) => x.id === t.id)?.requirements ?? [], here: true }));
    const ctx: EpicContext = {
      epicId: epic.epicId, title: epic.title, description: s.idea, outcome: epic.outcome, requirements: epic.requirements,
      doneWhen: epic.doneWhen.map((d) => ({ ...d, checked: s.tasks.some((t) => t.final && t.stage === "merged") })),
      siblings: s.tasks.map((t) => ({ cloudId: t.id, localId: t.id, title: t.title, status: STAGE_PT[t.stage], requirements: items.find((i) => i.id === t.id)?.requirements, machineLocal: true })),
      updatedAt: new Date().toISOString(),
    };
    // contexto vivo do épico (o mesmo arquivo que o app grava pros épicos da nuvem) — EPIC.md fresco a cada turno
    try { writeEpicContext(orch.ws.dir, ctx); writeAtomic(epicMdFile(dir), renderEpicMd(ctx, items)); } catch { /* best-effort */ }
  };

  const specFor = (t: ApTaskState, idx: number): TaskSpec => {
    const p = epic!.tasks.find((x) => x.id === t.id);
    const finalReqs = [...epic!.doneWhen.map((d) => `${d.id}: ${d.text}`), platformProofReq(s.platform)];
    const objective = t.final
      ? `VERIFICAÇÃO FINAL DO ÉPICO "${epic!.title}": rode o app a partir desta branch (igual à main, com tudo que foi mergeado) seguindo o README.md e PROVE cada item do "pronto quando" com evidência real. Pode corrigir pequenos problemas que impeçam a prova; não implemente funcionalidades novas.` + platformHint(s.platform)
      : (p?.objective ?? t.title) + platformHint(s.platform);
    const agent = `Piloto ${idx + 1}`;
    return {
      id: t.id, title: t.title, agent, objective,
      deliverables: [t.title], requirements: t.final ? finalReqs : p?.requirements ?? [t.title],
      // teto da TAREFA = o que sobra do teto do piloto (0 = sem teto). O custo entra no banco no fim de cada turno;
      // o app não pausa tarefa de piloto (53-teto-protecao: `autopilot`) — quem decide é o piloto, entre passos.
      branchType: "feat", autoPr: "no", budgetUsd: s.budgetUsd > 0 ? Math.max(0.01, Math.round((s.budgetUsd - s.costUsd) * 100) / 100) : 0, autopilot: true,
      epicId: epic!.epicId, verify: t.final ? 'todos os itens do "pronto quando" provados no app rodando' : p?.verify, covers: p?.covers?.length ? p.covers : undefined,
      after: t.after.length ? t.after : undefined, wave: t.final ? undefined : t.wave + 1, boundaries: epic!.boundaries.length ? epic!.boundaries : undefined,
      scope: { owns: t.final ? [] : p?.owns ?? [], offLimits: [] },
      autonomy: { clarifications: "auto", commit: "at-end", runTests: true, approval: "auto", planApproval: "auto" },
      engine: s.engine, model: s.model,
      roles: [{ role: "builder", name: agent, engine: s.engine, model: s.model }],
    };
  };

  /** Uma tarefa, passo a passo (criar → rodar → verificar → mergear | refazer | bloquear). Para entre passos. */
  const drive = async (t: ApTaskState): Promise<void> => {
    const idx = s.tasks.indexOf(t);
    for (;;) {
      if (halt()) return;
      if (t.stage === "pending") {
        if (!orch.store.getTask(t.id)) await gitLock.run(() => orch.createTask(specFor(t, idx), existsSync(epicMdFile(dir)) ? [epicMdFile(dir)] : []));
        t.stage = "running"; t.attempts = Math.max(1, t.attempts); t.startedAt = Date.now();
        ev(`▶ ${t.title}${t.final ? "" : ` (onda ${t.wave})`} — tentativa ${t.attempts}/${s.attempts}`, t.id);
        save();
        continue;
      }
      if (t.stage === "running") {
        const row = orch.store.getTask(t.id);
        if (t.rework) {
          // o ajuste fica gravado ATÉ o rework rodar: uma queda no meio refaz (não re-verifica a entrega velha)
          if (!t.reworkSent) {
            orch.store.addInstruction(t.id, t.rework);
            t.reworkSent = true;
            ev(`↻ refazendo "${t.title}" (tentativa ${t.attempts}/${s.attempts}): ${t.rework.split("\n")[0].slice(0, 160)}`, t.id);
          } else ev(`↻ retomando o rework de "${t.title}" (tentativa ${t.attempts}/${s.attempts})`, t.id);
          save();
          try { await orch.reworkTask(t.id); } catch (e) { ev(`rework de "${t.title}" falhou: ${(e as Error).message}`, t.id, false); }
          delete t.rework; delete t.reworkSent;
        } else if (row && row.status === "review") {
          /* retomada: o turno já tinha terminado — só verifica */
        } else {
          try { await orch.runTask(t.id); } catch (e) { ev(`"${t.title}" parou com erro: ${(e as Error).message}`, t.id, false); }
        }
        t.stage = "verify"; save();
        continue;
      }
      if (t.stage === "verify") {
        const row = orch.store.getTask(t.id);
        if (!row) { t.stage = "pending"; continue; }
        let gate: { ok: boolean; reasons: string[] };
        if (row.status === "error") gate = { ok: false, reasons: ["o agente não concluiu o turno (erro) — veja o log da tarefa e termine o que faltou"] };
        else {
          try { gate = await orch.verifyProofs(t.id, row, JSON.parse(row.spec_json) as TaskSpec); }
          catch (e) { gate = { ok: false, reasons: [`a verificação falhou: ${(e as Error).message}`] }; }
        }
        t.history.push({ attempt: t.attempts, ok: gate.ok, reasons: gate.reasons, at: Date.now() });
        if (gate.ok) {
          t.reasons = []; t.stage = "merge";
          ev(`✓ provas de "${t.title}" conferidas`, t.id, true);
        } else if (t.attempts >= s.attempts) {
          t.stage = "blocked"; t.reasons = gate.reasons; t.endedAt = Date.now();
          ev(`✕ "${t.title}" bloqueada depois de ${t.attempts} tentativa(s): ${gate.reasons.slice(0, 2).join(" · ")}`, t.id, false);
        } else {
          t.attempts++; t.reasons = gate.reasons; t.stage = "running";
          t.reworkSent = false;
          t.rework = `A VERIFICAÇÃO AUTOMÁTICA do piloto reprovou a entrega (tentativa ${t.attempts - 1}). Corrija e PROVE de novo (requirements.json com evidência real no disco):\n- ` + gate.reasons.join("\n- ");
          ev(`✕ provas de "${t.title}" reprovadas: ${gate.reasons.slice(0, 2).join(" · ")}`, t.id, false);
        }
        save();
        if (t.stage === "blocked") return;
        continue;
      }
      if (t.stage === "merge") {
        if (orch.store.getTask(t.id)?.status === "merged") { t.stage = "merged"; t.endedAt = Date.now(); save(); return; }
        const r = await gitLock.run(async () => {
          try { await orch.mergeTask(t.id); return { ok: true, conflict: false, msg: "" }; }
          catch (e) { return { ok: false, conflict: orch.store.getTask(t.id)?.status === "conflict", msg: (e as Error).message }; }
        });
        if (r.ok) {
          t.stage = "merged"; t.endedAt = Date.now();
          ev(`⇢ "${t.title}" mergeada na main`, t.id, true);
          save();
          return;
        }
        if (r.conflict && !t.triedResolver && engineKind(s.engine) !== "mock") {
          // conflito: primeiro o resolvedor que já existe (o agente integra a main na branch dele)
          t.triedResolver = true;
          ev(`⚠ conflito ao mergear "${t.title}" — pedindo pro agente resolver`, t.id, false);
          save();
          try { await orch.resolveConflict(t.id); } catch (e) { ev(`resolvedor falhou: ${(e as Error).message}`, t.id, false); }
          continue; // tenta o merge de novo
        }
        if (r.conflict && t.attempts < s.attempts) {
          t.attempts++; t.stage = "running"; t.triedResolver = false; t.reworkSent = false;
          t.reasons = [`conflito ao mergear na main: ${r.msg}`];
          t.rework = `O MERGE NA MAIN CONFLITOU. Integre a main na sua branch (git merge main — projeto local, sem remoto), resolva cada conflito preservando o que já está na main E o objetivo desta tarefa, commite e prove de novo.`;
          ev(`⚠ conflito ao mergear "${t.title}" — refazendo com o conflito (tentativa ${t.attempts}/${s.attempts})`, t.id, false);
          save();
          continue;
        }
        t.stage = "blocked"; t.reasons = [r.conflict ? `conflito ao mergear na main que não foi resolvido: ${r.msg}` : `merge na main falhou: ${r.msg}`]; t.endedAt = Date.now();
        ev(`✕ "${t.title}" bloqueada no merge: ${t.reasons[0]}`, t.id, false);
        save();
        return;
      }
      return; // merged / blocked
    }
  };

  /** Roda o que dá (paralelo até s.parallel) até não sobrar nada pronto pra andar; para entre passos. */
  const schedule = async (): Promise<"ok" | "stopped" | "budget"> => {
    const running = new Map<string, Promise<void>>();
    for (;;) {
      for (const id of propagateBlocked(s.tasks)) ev(`✕ "${s.tasks.find((t) => t.id === id)!.title}" bloqueada: ${s.tasks.find((t) => t.id === id)!.reasons[0]}`, id, false);
      epicCtx();
      save();
      const h = halt();
      if (!h) {
        for (const t of runnable(s.tasks)) {
          if (running.size >= s.parallel) break;
          if (running.has(t.id)) continue;
          running.set(t.id, drive(t).catch((e) => {
            t.stage = "blocked"; t.reasons = [`erro inesperado: ${(e as Error).message}`]; ev(`✕ "${t.title}": ${(e as Error).message}`, t.id, false);
          }).finally(() => { running.delete(t.id); }));
        }
      }
      if (!running.size) return h ?? "ok";
      await Promise.race(running.values());
    }
  };

  let outcome: "ok" | "stopped" | "budget" = "ok";
  try {
    save();
    if (!epic) {
      setPhase("planning"); ev(`planejando o épico (${s.platform}) com ${s.engine}${s.model ? ` (${s.model})` : ""}…`); save();
      epic = await planEpic({
        idea, platform: s.platform, engine: s.engine, model: s.model, planFile: o.planFile, dir,
        onCost: (usd) => { s.planCostUsd = round4((s.planCostUsd ?? 0) + (usd > 0 ? usd : 0)); },
      });
      writeAtomic(epicFile(dir), JSON.stringify(epic, null, 2));
      s.epicId = epic.epicId; s.epicTitle = epic.title;
      s.tasks = epic.tasks.map((t) => ({ id: t.id, title: t.title, after: t.after, wave: t.wave, stage: "pending", attempts: 0, reasons: [], history: [] }));
      ev(`épico "${epic.title}": ${epic.tasks.length} tarefas em ${1 + Math.max(...epic.tasks.map((t) => t.wave))} onda(s)`);
    } else if (!s.tasks.length) {
      s.tasks = epic.tasks.map((t) => ({ id: t.id, title: t.title, after: t.after, wave: t.wave, stage: "pending", attempts: 0, reasons: [], history: [] }));
    } else if (prev) {
      ev(`retomando o piloto (rodada ${s.runs}) — ${s.tasks.filter((t) => t.stage === "merged").length}/${s.tasks.length} tarefas já na main`);
    }
    setPhase("building"); save();
    outcome = await schedule();
    // VERIFICAÇÃO FINAL: com tudo assentado (mergeado ou bloqueado), prova o "pronto quando" no app da main
    if (outcome === "ok") {
      const merged = s.tasks.filter((t) => !t.final && t.stage === "merged").map((t) => t.id);
      if (merged.length && !s.tasks.some((t) => t.final)) {
        s.tasks.push({ id: FINAL_ID, title: "Verificação final do épico", after: merged, wave: 1 + Math.max(0, ...s.tasks.map((t) => t.wave)), final: true, stage: "pending", attempts: 0, reasons: [], history: [] });
      }
      if (s.tasks.some((t) => t.final && t.stage !== "merged" && t.stage !== "blocked")) {
        setPhase("final"); ev('verificação final: provando cada item do "pronto quando" no app da main'); save();
        outcome = await schedule();
      }
    }
    if (outcome === "ok") setPhase("report");
  } catch (e) {
    setPhase("failed"); s.stopReason = (e as Error).message;
    ev(`o piloto falhou: ${s.stopReason}`, undefined, false);
  }

  // RELATÓRIO (sempre — inclusive parado/teto/falha) + commit LOCAL na main
  try {
    if (s.phase !== "failed") setPhase(outcome === "stopped" ? "stopped" : outcome === "budget" ? "budget" : "done");
    if (s.phase === "stopped") { s.stopReason = "parado a pedido"; ev("parado a pedido — rode de novo na mesma pasta pra continuar"); }
    if (s.phase === "budget") { s.stopReason = `teto de custo atingido (${fmtUsd(s.costUsd)} ≥ ${fmtUsd(s.budgetUsd)})`; ev(`parou por custo: ${fmtUsd(s.costUsd)} ≥ teto ${fmtUsd(s.budgetUsd)}`, undefined, false); }
    if (s.phase === "done") ev(s.tasks.every((t) => t.stage === "merged") ? "✓ app pronto — relatório em AUTOPILOT.md" : "concluído com pendências — relatório em AUTOPILOT.md", undefined, s.tasks.every((t) => t.stage === "merged"));
    s.finishedAt = Date.now();
    save();
    const questions = s.tasks.flatMap((t) => {
      try { return orch.store.eventsForTask(t.id).filter((e) => /^perguntou \(piloto automático/.test(e.text)).map((e) => `${t.title}: ${e.text.replace(/^perguntou \(piloto automático, sem humano\):\s*/, "")} → a IA decidiu sozinha`); } catch { return []; }
    });
    const worktrees = new Map<string, string>();
    for (const t of s.tasks) { try { const w = orch.store.getTask(t.id)?.worktree; if (w) worktrees.set(t.id, w); } catch { /* sem tarefa */ } }
    writeFileSync(join(dir, "AUTOPILOT.md"), renderReport(s, epic, { costs: costs() ?? new Map(), questions, worktrees }), "utf8");
    await gitLock.run(async () => {
      try {
        await git(dir, "add", "AUTOPILOT.md");
        await git(dir, "commit", "-q", "-m", `docs: relatório do piloto automático (${PHASE_PT[s.phase]})`);
      } catch { /* nada mudou no relatório */ }
    });
  } catch (e) {
    ev(`não consegui escrever o relatório: ${(e as Error).message}`, undefined, false);
  } finally {
    s.pid = 0;
    save();
    orch.close();
    restoreEnv();
  }
  notify("Starfork — piloto automático", s.phase === "done" ? "Terminou — veja o AUTOPILOT.md" : PHASE_PT[s.phase], s.epicTitle || s.name);
  return s;
}
