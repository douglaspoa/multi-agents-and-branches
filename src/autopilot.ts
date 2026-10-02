// PILOTO AUTOMÁTICO — da ideia ao app pronto, sem humano, num projeto LOCAL (git sem remoto).
// `cardume autopilot --idea "…" --dir <pasta>`: cria a pasta (git init + 1º commit), planeja um ÉPICO local
// (onda 0 = esqueleto do app; tarefas com "pronto quando", requisitos verificáveis e dependências), roda as
// tarefas sozinho (política autônoma: o ask_human responde na hora — src/mcp/server.ts), passa cada entrega
// pelo GATE de provas (Orchestrator.verifyProofs), refaz com os motivos até N tentativas, faz merge LOCAL na
// main, segue pras desbloqueadas, roda a verificação final do épico e escreve AUTOPILOT.md.
// Estado em .cardume/autopilot/state.json (o app lê pra mostrar o progresso); rodar de novo na mesma pasta
// CONTINUA do estado; o arquivo .cardume/autopilot/STOP para entre passos; o teto de custo para com relatório.
// NUNCA: remoto, push, PR; perguntar ao humano; apagar trabalho de tarefa que falhou (fica na branch dela).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, engineKind, pidAlive } from "./orchestrator.ts";
import { GitService } from "./git.ts";
import { aiOnce } from "./ai-once.ts";
import { extractJson } from "./memory.ts";
import { renderEpicMd, writeEpicContext, type EpicContext, type EpicTaskItem } from "./epic-context.ts";
import { run } from "./util/run.ts";
import { notify } from "./util/notify.ts";
import { slugify, type TaskSpec } from "./types.ts";

export type ApPlatform = "web" | "ios" | "android" | "mobile";
export const AP_PLATFORMS: ApPlatform[] = ["web", "ios", "android", "mobile"];
export type ApPhase = "creating" | "planning" | "building" | "final" | "report" | "done" | "stopped" | "budget" | "failed";
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
  /** ajuste pendente pro próximo rework (motivos da prova/conflito) */
  rework?: string;
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
  /** processo que está rodando o piloto agora (0 = ninguém) */
  pid: number;
  runs: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  stopReason?: string;
  costUsd: number;
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
    const base = slugify(String(t.title ?? "") || "tarefa");
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
    epicId: "piloto-" + slugify(title).slice(0, 40),
    title,
    outcome: String(r.outcome ?? "").trim() || idea.trim().slice(0, 200),
    requirements: reqs,
    doneWhen: dw.map((text, i) => ({ id: `D${i + 1}`, text })),
    boundaries: strs(r.boundaries).slice(0, 6),
    tasks,
  };
}

async function planEpic(o: { idea: string; platform: ApPlatform; engine: string; planFile?: string; dir: string }): Promise<ApEpic> {
  let raw: unknown;
  if (o.planFile) raw = JSON.parse(readFileSync(o.planFile, "utf8"));
  else if (engineKind(o.engine) === "mock") raw = mockPlan(o.idea, o.platform);
  else {
    const out = await aiOnce(planPrompt(o.idea, o.platform), { tier: "capaz", timeout: 600_000, usage: { source: "nova-tarefa", project: o.dir } });
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

/** Pasta nova (ou vazia) → git init na main, README + .gitignore + 1º commit. NUNCA cria remoto. */
export async function createProject(dir: string, name: string): Promise<void> {
  if (existsSync(dir)) {
    const left = readdirSync(dir).filter((f) => f !== ".cardume" && f !== ".DS_Store");
    if (left.length) throw new Error(`a pasta ${dir} já existe e não está vazia — o piloto automático só cria projeto em pasta nova (ou continua um piloto que já começou nela)`);
  }
  mkdirSync(dir, { recursive: true });
  try {
    await run("git", ["init", "-q", "-b", "main", dir]);
  } catch {
    await run("git", ["init", "-q", dir]);
    await git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  }
  // identidade LOCAL (do repo) quando o git não tem uma — os commits das worktrees e os merges precisam dela
  let email = "";
  try { email = (await git(dir, "config", "user.email")).stdout.trim(); } catch { /* sem identidade */ }
  if (!email) {
    await git(dir, "config", "user.name", "Starfork Piloto");
    await git(dir, "config", "user.email", "piloto@starfork.local");
  }
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nProjeto criado pelo piloto automático do Starfork.\n`, "utf8");
  writeFileSync(join(dir, ".gitignore"), ".DS_Store\nnode_modules/\n.env\n.cardume/\n", "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "chore: projeto criado pelo piloto automático do Starfork");
}

// ---------------------------------------------------------------- relatório

const fmtUsd = (n: number) => `US$ ${n.toFixed(2)}`;
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
const STAGE_PT: Record<ApStage, string> = { pending: "na fila", running: "rodando", verify: "verificando", merge: "mergeando", merged: "mergeada ✓", blocked: "bloqueada ✕" };
export const PHASE_PT: Record<ApPhase, string> = {
  creating: "criando o projeto", planning: "planejando o épico", building: "construindo", final: "verificação final",
  report: "escrevendo o relatório", done: "concluído", stopped: "parado", budget: "parou por custo", failed: "falhou",
};

function readJson(p: string): unknown { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

/** Relatório AUTOPILOT.md: ideia, épico, linha do tempo, tarefas (status/tentativas/provas), suposições, custo e como rodar. */
export function renderReport(s: ApState, epic: ApEpic | null, extra: { costs: Map<string, number>; questions: string[] }): string {
  const L: string[] = [];
  const result = s.phase === "done"
    ? (s.tasks.every((t) => t.stage === "merged") ? "✓ app pronto — todas as tarefas e a verificação final passaram" : "concluído com pendências — veja as tarefas bloqueadas")
    : s.phase === "budget" ? `parou por custo — o teto de ${fmtUsd(s.budgetUsd)} foi atingido (${fmtUsd(s.costUsd)})`
    : s.phase === "stopped" ? "parado a pedido — rode de novo na mesma pasta pra continuar"
    : s.phase === "failed" ? `falhou: ${s.stopReason ?? "erro inesperado"}` : PHASE_PT[s.phase];
  L.push(`# Piloto automático — ${epic?.title ?? s.epicTitle ?? s.name}`, "");
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
    const reqs = readJson(join(s.dir, ".cardume", "artifacts", t.id, "requirements.json"));
    const list = Array.isArray(reqs) ? (reqs as { req?: string; status?: string; evidence?: string[] }[]) : [];
    if (list.length) {
      L.push("Provas:");
      for (const r of list) {
        const ev = (r.evidence ?? []).map((e) => `[${String(e).split("/").pop()}](.cardume/artifacts/${t.id}/${String(e).replace(/^\.?\/?(\.cardume\/artifacts\/)?/, "")})`).join(", ");
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
      const txt = readFileSync(join(s.dir, ".cardume", "artifacts", t.id, "ASSUMPTIONS.md"), "utf8").trim();
      if (txt) { L.push(`**${t.title}**`, "", txt, ""); any = true; }
    } catch { /* sem suposições nesta tarefa */ }
  }
  for (const q of extra.questions) { L.push(`- ${q}`); any = true; }
  if (!any) L.push("_(nenhuma registrada)_");
  L.push("");
  L.push("## Custo", "", `Total das tarefas: **${fmtUsd(s.costUsd)}**${s.budgetUsd > 0 ? ` (teto: ${fmtUsd(s.budgetUsd)})` : ""}. O planejamento também aparece na aba Uso (origem "Nova tarefa"). Em plano de assinatura o valor é o equivalente em API.`, "");
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

export async function runAutopilot(o: AutopilotOptions, hooks: AutopilotHooks = {}): Promise<ApState> {
  const dir = resolve(o.dir);
  const log = o.log ?? ((l: string) => console.log(l));
  const prev = readState(dir);
  if (prev && prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) throw new Error(`o piloto já está rodando nesta pasta (processo ${prev.pid})`);
  const idea = (o.idea ?? prev?.idea ?? "").trim();
  if (!idea) throw new Error('falta a ideia: use --idea "…"');
  const platform: ApPlatform = (AP_PLATFORMS.includes(o.platform as ApPlatform) ? o.platform : prev?.platform ?? "web") as ApPlatform;
  const name = (o.name ?? prev?.name ?? "").trim() || idea.split(/\s+/).slice(0, 5).join(" ");
  const now = Date.now();
  const s: ApState = prev ?? {
    version: 1, idea, name, platform, engine: o.engine ?? "claude", model: o.model, parallel: 2, attempts: 2, budgetUsd: 0, dir,
    epicId: "", epicTitle: "", phase: "creating", pid: process.pid, runs: 0, startedAt: now, updatedAt: now, costUsd: 0, tasks: [], events: [],
  };
  // numa retomada, só o que foi passado de novo muda (teto, tentativas, paralelo, IA)
  if (o.engine) s.engine = o.engine;
  if (o.model) s.model = o.model;
  if (o.parallel && o.parallel > 0) s.parallel = Math.min(8, Math.floor(o.parallel));
  if (o.attempts && o.attempts > 0) s.attempts = Math.min(10, Math.floor(o.attempts));
  if (o.budgetUsd !== undefined && o.budgetUsd >= 0) s.budgetUsd = o.budgetUsd;
  s.dir = dir;
  s.pid = process.pid;
  s.runs++;
  delete s.stopReason;
  delete s.finishedAt;

  if (!prev) await createProject(dir, name);
  if (await new GitService(dir).hasRemote("origin")) throw new Error("este projeto tem um remoto (origin) — o piloto automático só roda em projeto LOCAL, sem remoto");
  try { rmSync(stopFile(dir), { force: true }); } catch { /* sem pedido de parada */ }

  const restore = { ap: process.env.CARDUME_AUTOPILOT, nt: process.env.CARDUME_NOTIFY };
  process.env.CARDUME_AUTOPILOT = "1"; // ask_human automático + regra de autonomia (bus) + mock que prova
  process.env.CARDUME_NOTIFY = "0"; // nada de "pronta pra review" a cada tarefa — o aviso é um só, no fim
  const orch = new Orchestrator(dir); // cria .cardume/state.sqlite ANTES do state.json (o app abre o projeto ao ver o estado)
  const gitLock = new Mutex();

  const ev = (text: string, taskId?: string, ok?: boolean) => {
    s.events.push({ at: Date.now(), text, taskId, ...(ok === undefined ? {} : { ok }) });
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    log(/^[✓✕↻▶⇢⚠·]/.test(text) ? text : `${ok === false ? "✕" : "·"} ${text}`);
  };
  const costs = () => {
    const m = new Map<string, number>();
    try { for (const c of orch.store.costByTask()) m.set(c.taskId, c.usd); } catch { /* banco ocupado: fica o último */ }
    return m;
  };
  const save = () => {
    const m = costs();
    if (m.size) s.costUsd = [...m.values()].reduce((a, b) => a + b, 0);
    s.updatedAt = Date.now();
    writeAtomic(stateFile(dir), JSON.stringify(s, null, 2));
    try { hooks.onSave?.(s); } catch { /* hook de teste */ }
  };
  const halt = (): "stopped" | "budget" | null => {
    if (existsSync(stopFile(dir))) return "stopped";
    if (s.budgetUsd > 0) {
      const m = costs();
      const total = [...m.values()].reduce((a, b) => a + b, 0);
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
      branchType: "feat", autoPr: "no", budgetUsd: 0,
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
          orch.store.addInstruction(t.id, t.rework);
          ev(`↻ refazendo "${t.title}" (tentativa ${t.attempts}/${s.attempts}): ${t.rework.split("\n")[0].slice(0, 160)}`, t.id);
          delete t.rework; save();
          try { await orch.reworkTask(t.id); } catch (e) { ev(`rework de "${t.title}" falhou: ${(e as Error).message}`, t.id, false); }
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
          t.attempts++; t.stage = "running"; t.triedResolver = false;
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
      s.phase = "planning"; ev(`planejando o épico (${s.platform}) com ${s.engine}…`); save();
      epic = await planEpic({ idea, platform, engine: s.engine, planFile: o.planFile, dir });
      writeAtomic(epicFile(dir), JSON.stringify(epic, null, 2));
      s.epicId = epic.epicId; s.epicTitle = epic.title;
      s.tasks = epic.tasks.map((t) => ({ id: t.id, title: t.title, after: t.after, wave: t.wave, stage: "pending", attempts: 0, reasons: [], history: [] }));
      ev(`épico "${epic.title}": ${epic.tasks.length} tarefas em ${1 + Math.max(...epic.tasks.map((t) => t.wave))} onda(s)`);
    } else if (!s.tasks.length) {
      s.tasks = epic.tasks.map((t) => ({ id: t.id, title: t.title, after: t.after, wave: t.wave, stage: "pending", attempts: 0, reasons: [], history: [] }));
    } else if (prev) {
      ev(`retomando o piloto (rodada ${s.runs}) — ${s.tasks.filter((t) => t.stage === "merged").length}/${s.tasks.length} tarefas já na main`);
    }
    s.phase = "building"; save();
    outcome = await schedule();
    // VERIFICAÇÃO FINAL: com tudo assentado (mergeado ou bloqueado), prova o "pronto quando" no app da main
    if (outcome === "ok") {
      const merged = s.tasks.filter((t) => !t.final && t.stage === "merged").map((t) => t.id);
      if (merged.length && !s.tasks.some((t) => t.final)) {
        s.tasks.push({ id: FINAL_ID, title: "Verificação final do épico", after: merged, wave: 1 + Math.max(0, ...s.tasks.map((t) => t.wave)), final: true, stage: "pending", attempts: 0, reasons: [], history: [] });
      }
      if (s.tasks.some((t) => t.final && t.stage !== "merged" && t.stage !== "blocked")) {
        s.phase = "final"; ev('verificação final: provando cada item do "pronto quando" no app da main'); save();
        outcome = await schedule();
      }
    }
    s.phase = outcome === "ok" ? "report" : s.phase;
  } catch (e) {
    s.phase = "failed"; s.stopReason = (e as Error).message;
    ev(`o piloto falhou: ${s.stopReason}`, undefined, false);
  }

  // RELATÓRIO (sempre — inclusive parado/teto/falha) + commit LOCAL na main
  try {
    if (s.phase !== "failed") s.phase = outcome === "stopped" ? "stopped" : outcome === "budget" ? "budget" : "done";
    if (s.phase === "stopped") { s.stopReason = "parado a pedido"; ev("parado a pedido — rode de novo na mesma pasta pra continuar"); }
    if (s.phase === "budget") { s.stopReason = `teto de custo atingido (${fmtUsd(s.costUsd)} ≥ ${fmtUsd(s.budgetUsd)})`; ev(`parou por custo: ${fmtUsd(s.costUsd)} ≥ teto ${fmtUsd(s.budgetUsd)}`, undefined, false); }
    if (s.phase === "done") ev(s.tasks.every((t) => t.stage === "merged") ? "✓ app pronto — relatório em AUTOPILOT.md" : "concluído com pendências — relatório em AUTOPILOT.md", undefined, s.tasks.every((t) => t.stage === "merged"));
    s.finishedAt = Date.now();
    save();
    const questions = s.tasks.flatMap((t) => {
      try { return orch.store.eventsForTask(t.id).filter((e) => /^perguntou \(piloto automático/.test(e.text)).map((e) => `${t.title}: ${e.text.replace(/^perguntou \(piloto automático, sem humano\):\s*/, "")} → a IA decidiu sozinha`); } catch { return []; }
    });
    writeFileSync(join(dir, "AUTOPILOT.md"), renderReport(s, epic, { costs: costs(), questions }), "utf8");
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
    if (restore.ap === undefined) delete process.env.CARDUME_AUTOPILOT; else process.env.CARDUME_AUTOPILOT = restore.ap;
    if (restore.nt === undefined) delete process.env.CARDUME_NOTIFY; else process.env.CARDUME_NOTIFY = restore.nt;
  }
  notify("Starfork — piloto automático", s.phase === "done" ? "Terminou — veja o AUTOPILOT.md" : PHASE_PT[s.phase], s.epicTitle || s.name);
  return s;
}
