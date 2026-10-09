// MODO TERMINAL — cada tarefa roda o CLI OFICIAL (`claude` / `codex` / …) num terminal de verdade dentro do app
// (PTY em app/src-tauri/src/pty.rs). O Starfork continua dono da tarefa, dos requisitos, das provas, do gate e
// do custo — mas NÃO raspa a tela: tudo o que é estruturado vem de canais que o próprio CLI oferece:
//
//   hooks do Claude Code (.claude/settings.local.json da worktree, MESCLADO com o que já existir)
//     SessionStart → id da sessão (pra `claude --resume`)        UserPromptSubmit → "Você: …" + ocupado
//     PreToolUse   → feed (lendo/editando/rodando…)               PostToolUse      → falha de ferramenta
//     Stop         → livre + FIM DE TURNO (commit, diff, gate)    Notification     → "esperando você"
//     SessionEnd   → sessão encerrada
//   statusLine     → custo ACUMULADO da sessão (cost.total_cost_usd) → delta vira linha de custo da tarefa
//   MCP do Starfork (.cardume/mcp.json, o MESMO do `claude -p`) → ask_human, requisitos, provas, done-when
//   Codex: hooks via `-c hooks.*` (SessionStart/UserPromptSubmit/Pre/PostToolUse), `notify` = fim de turno,
//          MCP via `-c mcp_servers.cardume.*`. Sem statusLine → sem custo em US$ (ver CODEX_LIMITS).
//   DeepSeek: o MESMO `claude` com a API Anthropic-compatível da DeepSeek (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL no
//          env, nunca no argv — ver deepseekClaudeEnv). O custo da statusLine sairia com preço de Claude: não é gravado.
//   TERMINAL INTEGRADO (src/terminal-integrado.ts): tools suggest_replies/task_status/set_status/open_pr/create_task/
//          list_skills/use_skill no MCP, /starfork-* em .claude/commands (Claude) e o bloco INTEGRADO_RULE no prompt.
//
//   SHELL (macOS/Linux): o PTY é o shell de login da pessoa na worktree; a IA (claude/codex/deepseek/gemini/opencode)
//          sobe nele por `starfork ia <ia>` (shim em .cardume/term/bin) — ver "preparo do terminal" abaixo.
//          Gemini: MCP via GEMINI_CLI_SYSTEM_SETTINGS_PATH (arquivo nosso); OpenCode: OPENCODE_CONFIG (arquivo nosso).
//
// Os hooks chamam o motor empacotado: `<node> cli.mjs hook <Evento> --starfork-task <id> --repo <repo>`.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ClaudeEngine, claudeEnv, mapTool, resolveClaude, adjustRuleOf } from "./engine/claude.ts";
import { buildPrompt as codexPrompt, loadLlmEnv } from "./engine/codex.ts";
import { DSH_FAST_MODEL, DSH_KEY_MSG, dshKey, dshModelFor, isDshLabel } from "./engine/dsh.ts";
import { INTEGRADO_CLAUDE_CMDS, INTEGRADO_RULE, shellInstructions, suggestedSinceUser, suggestFromText, writeInstructionsSection, writeStarforkCommands } from "./terminal-integrado.ts";
import { resolveToolCached, toolPath } from "./engine/bin-resolve.ts";
import { protectArgs, protectEnabled } from "./engine/protect.ts";
import { engineKind, Orchestrator, deliverPrompt, readCostCapSetting } from "./orchestrator.ts";
import { capCheck, capPauseText, effectiveCap, MAX_REVIEW_ROUNDS } from "./lifecycle.ts";
import { Store } from "./store.ts";
import { taskToYaml } from "./util/yaml.ts";
import type { AgentStatus, TaskSpec } from "./types.ts";

export type TermMode = "terminal" | "auto";
/** Tarefa antiga (sem o campo) = automático: nada muda pra quem já rodava. */
export const termModeOf = (spec: { termMode?: string } | null | undefined): TermMode => (spec?.termMode === "terminal" ? "terminal" : "auto");
/** Tem terminal? macOS/Linux: qualquer motor com IA de terminal (o PTY é o shell da pessoa e ela escolhe a IA —
 * `starfork ia`), MENOS gateway/logcomex (sem CLI: virariam Claude em silêncio) e vazio/mock; Windows (a IA direto no
 * PTY): Claude, Codex e o DeepSeek DENTRO do `claude`. Mesma regra do Rust (term.rs › wants_terminal_on). */
export const terminalCapable = (engine: string | undefined, platform: string = process.platform): boolean => {
  const n = String(engine ?? "").trim().toLowerCase();
  if (!n || n === "mock" || n.startsWith("gateway") || n.startsWith("logcomex")) return false;
  return platform === "win32" ? ["claude", "codex", "deepseek"].includes(engineKind(n)) : true;
};

/** API Anthropic-compatível da DeepSeek (api-docs.deepseek.com › Claude Code, conferido em 04/10/2026). */
export const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
/**
 * Env do `claude` falando com a DeepSeek: modelo principal = o escolhido na tarefa (vazio/alias do Claude → o capaz,
 * deepseek-v4-pro), auxiliar/subagente = deepseek-flash. `[1m]` = janela de 1M que a doc oficial usa. A chave vai
 * SÓ no env (ANTHROPIC_AUTH_TOKEN), nunca no argv; sem tráfego não essencial pra Anthropic.
 */
export function deepseekClaudeEnv(model: string | undefined, key: string): Record<string, string> {
  if (!String(key ?? "").trim()) throw new Error(DSH_KEY_MSG);
  const main = dshModelFor(model, "capaz");
  const big = /\[1m\]$/i.test(main) ? main : `${main}[1m]`;
  return {
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_URL,
    ANTHROPIC_AUTH_TOKEN: key.trim(),
    ANTHROPIC_MODEL: big,
    ANTHROPIC_DEFAULT_OPUS_MODEL: big,
    ANTHROPIC_DEFAULT_SONNET_MODEL: big,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DSH_FAST_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: DSH_FAST_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: DSH_FAST_MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    STARFORK_ENGINE: "deepseek",
  };
}
/** Sessão de terminal de motor não-Claude no `claude` (DeepSeek): a statusLine NÃO grava custo (preço seria de Claude). */
export const skipStatuslineCost = (env: NodeJS.ProcessEnv = process.env) => env.STARFORK_ENGINE === "deepseek";

/** O que o Codex NÃO entrega no terminal (documentado no PR e mostrado no feed ao iniciar). */
export const CODEX_LIMITS = [
  "sem custo em US$: o Codex não tem statusLine — o custo da tarefa fica em 0 (tokens só no histórico do próprio Codex)",
  "sem Notification: o pedido de permissão aparece só no terminal, não vira aviso no feed",
  "fim de turno vem do `notify` (agent-turn-complete) — sem SessionEnd quando o processo morre de fora",
];

/** Marca dos comandos do Starfork nos hooks/statusLine — a fusão troca só os nossos e preserva o resto. */
export const HOOK_MARK = "--starfork-task";
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification", "SessionEnd"] as const;
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;
/** Prazo do hook Stop (o fim de turno roda dentro dele — commit, diff, provas, gate). O PR sai depois, destacado. */
export const STOP_HOOK_TIMEOUT_S = 240;
/** Hooks que só alimentam o feed rodam em segundo plano (não seguram a ferramenta); os que mudam estado são síncronos. */
const ASYNC_HOOKS = new Set(["PreToolUse", "PostToolUse", "Notification"]);
/** Pergunta nativa do Claude Code (várias perguntas, opções com descrição, multiSelect, "outra resposta"). */
export const AUQ_TOOL = "AskUserQuestion";
/** O hook espera a pessoa (como o ask_human). Passou disso, o Claude Code cai no picker dele no próprio terminal. */
export const AUQ_TIMEOUT_S = 24 * 3600;
/** Resposta especial: "quero responder no terminal" → o hook sai sem decisão e o picker do CLI aparece no TTY. */
export const AUQ_IN_TERMINAL = "(responder no terminal)";
export const KICKOFF = "Comece: leia .cardume/TASK.yaml e execute a tarefa seguindo as instruções do Starfork (no seu system prompt).";

const shq = (s: string) => (process.platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
/** `<node> [flags] <cli>` — o MESMO motor que o app usa (process.execPath + o script em execução). */
export function engineBase(): string[] {
  const flags = process.execArgv.filter((a) => a === "--experimental-sqlite");
  return [process.execPath, ...flags, "--disable-warning=ExperimentalWarning", process.argv[1]];
}
export function hookArgv(base: string[], event: string, taskId: string, repo: string): string[] {
  return taskId === CODEX_ENV_TASK ? [...base, "hook", event, HOOK_MARK, CODEX_ENV_TASK] : [...base, "hook", event, HOOK_MARK, taskId, "--repo", repo];
}
/** Hook "genérico": a tarefa e o banco vêm do ambiente do CLI (CARDUME_TASK / CARDUME_DB). */
export const CODEX_ENV_TASK = "env";
/** Resolve (tarefa, repo) do hook: explícitos, ou do ambiente quando o comando é o genérico. */
export function hookTarget(taskArg: string, repoArg: string, env: NodeJS.ProcessEnv = process.env): { taskId: string; repo: string; db: string } {
  if (taskArg === CODEX_ENV_TASK || !taskArg) {
    const db = env.CARDUME_DB || "";
    return { taskId: env.CARDUME_TASK || "", repo: db ? dirname(dirname(db)) : repoArg, db };
  }
  return { taskId: taskArg, repo: repoArg, db: env.CARDUME_DB || dbOf(repoArg) };
}
export const shellCmd = (argv: string[]) => argv.map(shq).join(" ");
export const isStarforkCmd = (cmd: unknown) => typeof cmd === "string" && cmd.includes(HOOK_MARK);

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string; [k: string]: unknown }[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; statusLine?: { type?: string; command?: string; [k: string]: unknown }; [k: string]: unknown };

/**
 * Funde os hooks/statusLine do Starfork num settings.local.json JÁ EXISTENTE sem apagar nada da pessoa:
 * tira só os comandos marcados (rodada anterior) e acrescenta os novos. statusLine de outra pessoa NÃO é
 * sobrescrito em silêncio: o nosso o ENCADEIA (devolvido em `prevStatusLine` pra o comando rodar depois).
 */
export function mergeClaudeSettings(existing: Settings | null | undefined, base: string[], taskId: string, repo: string): { settings: Settings; prevStatusLine: string | null } {
  const out: Settings = existing && typeof existing === "object" ? JSON.parse(JSON.stringify(existing)) : {};
  const hooks: Record<string, HookGroup[]> = out.hooks && typeof out.hooks === "object" ? out.hooks : {};
  for (const ev of Object.keys(hooks)) {
    const groups = (Array.isArray(hooks[ev]) ? hooks[ev] : [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isStarforkCmd(h.command)) }))
      .filter((g) => (g.hooks ?? []).length > 0);
    if (groups.length) hooks[ev] = groups; else delete hooks[ev];
  }
  for (const ev of CLAUDE_HOOK_EVENTS) {
    // Stop: o fim de turno (commit/diff/gate) roda DENTRO do hook — o Claude Code só puxa o próximo pedido da fila dele
    // depois (veto do Rafa na mesa: commit/gate nunca no meio do turno seguinte)
    const h: { type: string; command: string; timeout: number; async?: boolean } = { type: "command", command: shellCmd(hookArgv(base, ev, taskId, repo)), timeout: ev === "Stop" ? STOP_HOOK_TIMEOUT_S : 30 };
    if (ASYNC_HOOKS.has(ev)) h.async = true;
    (hooks[ev] = hooks[ev] ?? []).push(ev === "PreToolUse" || ev === "PostToolUse" ? { matcher: "*", hooks: [h] } : { hooks: [h] });
  }
  // pergunta do agente (AskUserQuestion): hook SÍNCRONO que segura a ferramenta até a pessoa responder na folha do
  // app e devolve allow + updatedInput.answers (o Claude Code aceita como resposta do usuário — sem tecla no PTY)
  hooks.PreToolUse.push({ matcher: AUQ_TOOL, hooks: [{ type: "command", command: shellCmd(hookArgv(base, AUQ_TOOL, taskId, repo)), timeout: AUQ_TIMEOUT_S }] });
  out.hooks = hooks;
  let prev: string | null = null;
  const sl = out.statusLine;
  if (sl && typeof sl.command === "string" && sl.command.trim() && !isStarforkCmd(sl.command)) prev = sl.command;
  out.statusLine = { type: "command", command: shellCmd([...base, "statusline", HOOK_MARK, taskId, "--repo", repo]), padding: 0 };
  return { settings: out, prevStatusLine: prev };
}

/** Barra de status GLOBAL da pessoa (~/.claude/settings.json) — encadeada quando a worktree não tem a dela. */
function globalStatusLine(): string | null {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Settings;
    const c = s?.statusLine?.command;
    return typeof c === "string" && c.trim() && !isStarforkCmd(c) ? c : null;
  } catch { return null; }
}

const termDir = (worktree: string) => join(worktree, ".cardume", "term");
function writeJsonAtomic(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Escreve .claude/settings.local.json (fusão) e garante que ele NÃO entra no commit da tarefa. */
export function writeClaudeSettings(worktree: string, base: string[], taskId: string, repo: string): string {
  const path = join(worktree, ".claude", "settings.local.json");
  let existing: Settings | null = null;
  try { existing = JSON.parse(readFileSync(path, "utf8")); } catch { /* não existe ou ilegível → começa do zero (ilegível vira backup) */
    if (existsSync(path)) try { renameSync(path, path + ".starfork-bak"); } catch { /* segue */ }
  }
  const { settings, prevStatusLine } = mergeClaudeSettings(existing, base, taskId, repo);
  writeJsonAtomic(path, settings);
  const state = readTermState(worktree);
  state.prevStatusLine = prevStatusLine ?? state.prevStatusLine ?? globalStatusLine();
  writeTermState(worktree, state);
  excludeFromGit(worktree, [".claude/settings.local.json"]);
  return path;
}

/** .git/info/exclude da worktree (o comum do repo): o arquivo local não vai pro diff/commit da tarefa. */
export function excludeFromGit(worktree: string, paths: string[]): void {
  try {
    const gitPath = join(worktree, ".git");
    let common = gitPath;
    if (existsSync(gitPath) && statSync(gitPath).isFile()) {
      const m = readFileSync(gitPath, "utf8").match(/gitdir:\s*(.+)/);
      if (m) {
        const wtGit = m[1].trim();
        const c = join(wtGit, "commondir");
        common = existsSync(c) ? join(wtGit, readFileSync(c, "utf8").trim()) : wtGit;
      }
    }
    const ex = join(common, "info", "exclude");
    mkdirSync(dirname(ex), { recursive: true });
    const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
    const add = paths.filter((p) => !cur.split("\n").includes(p));
    if (add.length) writeFileSync(ex, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n", "utf8");
  } catch { /* sem git: nada a excluir */ }
}

interface TermState {
  prevStatusLine?: string | null;
  lastTurnEnd?: number;
  /** terminal integrado no shell: a última IA aberta, a sessão de cada FAMÍLIA (claude/codex) e quando cada IA rodou */
  lastAi?: TermAi;
  sessions?: Record<string, string>;
  started?: Record<string, number>;
  /** a próxima `starfork ia` abre sessão NOVA continuando da worktree (assumiu um turno de fundo de planner/revisor) */
  continueNext?: boolean;
}
function readTermState(worktree: string): TermState { try { return JSON.parse(readFileSync(join(termDir(worktree), "state.json"), "utf8")); } catch { return {}; } }
function writeTermState(worktree: string, s: TermState): void { try { writeJsonAtomic(join(termDir(worktree), "state.json"), s); } catch { /* best-effort */ } }

// ======================= hooks → feed/estado (PURO — testado em terminal.test.ts) =======================
export interface FeedEvent { agent?: "Você" | "Sistema"; type: string; text: string; ok?: boolean }
export interface HookEffect {
  events: FeedEvent[];
  busy?: boolean;
  /** a IA está num menu/permissão/pergunta (true) ou saiu dele (false) — o app não cola pedido num menu */
  waiting?: boolean;
  /** ExitPlanMode: a IA terminou o PLANO e espera a aprovação no terminal (Cadeado 1) */
  planReady?: boolean;
  sessionId?: string;
  status?: AgentStatus;
  turnEnd?: boolean;
  ended?: boolean;
  claim?: { path: string; mode: "read" | "write" };
}

const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** Bloco de anexos ([ANEXOS]…[/ANEXOS]) não precisa ir inteiro pro feed. */
const userText = (p: string) => p.replace(/\n*\[ANEXOS\][\s\S]*?\[\/ANEXOS\]/g, (m) => ` [${(m.match(/^\d+\./gm) ?? []).length || 1} anexo(s)]`);

/** Motivo do SessionEnd do Claude Code em pt-BR (o código cru — "other", "prompt_input_exit" — não vai pro feed). */
export const END_REASON_PT: Record<string, string> = { clear: "conversa limpa (/clear)", logout: "você saiu da conta do Claude", prompt_input_exit: "você saiu do terminal", other: "a sessão terminou", bypass_permissions_disabled: "o modo sem confirmação foi desligado" };
/** Evento de hook (Claude Code ou Codex — mesmo formato) → o que muda no feed e no estado da tarefa. */
export function mapHook(event: string, p: Record<string, any>): HookEffect {
  switch (event) {
    case "SessionStart":
      return {
        events: [{ agent: "Sistema", type: "status", text: p.source === "resume" ? "terminal: sessão retomada" : p.source === "clear" ? "terminal: conversa limpa (/clear)" : p.source === "compact" ? "terminal: contexto compactado" : "terminal: sessão iniciada", ok: true }],
        sessionId: typeof p.session_id === "string" && p.session_id ? p.session_id : undefined,
      };
    case "UserPromptSubmit": {
      const prompt = String(p.prompt ?? "").trim();
      return { events: prompt ? [{ agent: "Você", type: "note", text: `Você: ${clip(userText(prompt), 4000)}`, ok: true }] : [], busy: true, waiting: false, status: "running", sessionId: p.session_id || undefined };
    }
    case "PreToolUse": {
      // Cadeado 1 no terminal: o plano ficou pronto — o menu nativo do Claude Code pede a aprovação ali mesmo
      if (String(p.tool_name ?? "") === "ExitPlanMode") return { events: [{ agent: "Sistema", type: "note", text: PLAN_READY_NOTE, ok: false }], waiting: true, planReady: true };
      // ferramenta rodando = sessão OCUPADA (corrige um "livre" marcado por engano — ex.: Esc que só fechou um menu)
      const ev = mapTool(String(p.tool_name ?? ""), p.tool_input ?? {});
      if (ev.type === "claim" && ev.path) return { events: [], claim: { path: ev.path, mode: ev.mode ?? "write" }, busy: true };
      // Codex: apply_patch/shell trazem o comando/patch em formatos próprios
      if (/apply_patch/i.test(String(p.tool_name))) return { events: [{ type: "edit", text: clip(patchFiles(p.tool_input), 300) || "editando arquivos", ok: true }], busy: true };
      return { events: ev.text ? [{ type: ev.type, text: clip(ev.text, 300), ok: ev.ok }] : [], busy: true };
    }
    case "PostToolUse": {
      const r = p.tool_response;
      const failed = r && typeof r === "object" && (r.is_error === true || r.success === false || (typeof r.error === "string" && r.error));
      return { events: failed ? [{ type: "note", text: `${p.tool_name ?? "ferramenta"} falhou: ${clip(typeof r.error === "string" ? r.error : r.stderr ?? "", 200)}`, ok: false }] : [] };
    }
    case "Notification": {
      const msg = clip(p.message ?? "", 300);
      if (!msg) return { events: [] };
      const waiting = /permission|permiss|waiting for your input|aguardando/i.test(msg) || p.notification_type === "permission_prompt" || p.notification_type === "idle_prompt";
      // menu ABERTO de verdade (colar ali escolheria uma opção): só permissão/elicitação — o idle_prompt (~60 s parado
      // no prompt) não é menu, senão a fila do app nunca soltava (Téo na mesa)
      const menu = waitingMenu(p.notification_type, msg);
      return { events: [{ agent: "Sistema", type: "note", text: waiting ? `⏸ esperando você no terminal: ${msg}` : `terminal: ${msg}`, ok: !waiting }], ...(menu ? { waiting: true } : {}) };
    }
    case "Stop":
    case "codex-notify": {
      const last = clip(p.last_assistant_message ?? p["last-assistant-message"] ?? "", 2000);
      return { events: [{ type: "done", text: last || "turno concluído", ok: true }], busy: false, waiting: false, turnEnd: true, sessionId: p.session_id || p["thread-id"] || undefined };
    }
    case "SessionEnd":
      return { events: [{ agent: "Sistema", type: "status", text: `terminal: ${END_REASON_PT[String(p.reason ?? "")] ?? "a sessão terminou"}`, ok: true }], busy: false, ended: true };
    default:
      return { events: [] };
  }
}
function patchFiles(inp: unknown): string {
  const t = typeof inp === "string" ? inp : String((inp as { input?: unknown; patch?: unknown })?.input ?? (inp as { patch?: unknown })?.patch ?? "");
  return [...t.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim()).join(", ");
}

/** Última fala do agente no transcript (quando o Stop não traz `last_assistant_message`). Lê só a cauda. */
export function lastAssistantText(transcriptPath: string | undefined): string {
  if (!transcriptPath) return "";
  try {
    const st = statSync(transcriptPath);
    const fd = openSync(transcriptPath, "r");
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const l of lines) {
      if (!l.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(l);
        const content = o?.message?.content;
        if (o?.type === "assistant" && Array.isArray(content)) {
          const t = content.filter((c: { type?: string }) => c?.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n").trim();
          if (t) return t;
        }
      } catch { /* linha partida no começo da cauda */ }
    }
  } catch { /* sem transcript */ }
  return "";
}

/** Nota do feed/barra quando o plano fica pronto no terminal (a Bia: o menu do Claude vem em inglês). */
export const PLAN_READY_NOTE = "precisa de você · a IA fez um plano · aprove no terminal (Enter) ou peça mudança";
/** PURA: a notificação é um MENU aberto (permissão/elicitação)? `idle_prompt` não é. */
export function waitingMenu(type: unknown, msg: unknown): boolean {
  const t = String(type ?? "");
  if (t) return t === "permission_prompt" || t === "elicitation" || t === "elicitation_dialog";
  return /needs your permission|permission to use|precisa da sua permissão/i.test(String(msg ?? ""));
}
/** Aplica o efeito no banco da tarefa. Devolve o efeito (o chamador dispara o fim de turno). */
export function applyHook(store: Store, taskId: string, eff: HookEffect): void {
  const task = store.getTask(taskId);
  if (!task) return;
  let spec: TaskSpec | null = null;
  try { spec = JSON.parse(task.spec_json); } catch { /* spec ilegível: feed segue com o nome do agente */ }
  // quem fala no terminal agora: o revisor (troca de papel) ou quem constrói
  const role = (spec?.termRole?.role === "reviewer" ? spec?.roles?.find((r) => r.role === "reviewer") : undefined) ?? spec?.roles?.find((r) => r.role === "builder") ?? spec?.roles?.[0];
  const agent = role?.name || task.agent;
  if (eff.sessionId) store.termSetSession(taskId, eff.sessionId);
  // turno novo, fim de turno ou sessão fechada: nenhum hook espera mais a pergunta (Esc no TTY mata o hook)
  if (eff.turnEnd || eff.ended || eff.status === "running") store.closeAuqQuestions(taskId);
  if (eff.busy !== undefined) store.termSetBusy(taskId, eff.busy);
  if (eff.waiting !== undefined) store.termSetWaiting(taskId, eff.waiting);
  // PreToolUse (qualquer ferramenta que não o plano) = a IA saiu do menu e voltou a trabalhar
  else if (eff.busy === true) store.termSetWaiting(taskId, false);
  // saiu do menu do plano (aprovou → ferramenta rodando; pediu mudança → turno novo): o "precisa de você" do plano cai
  if (!eff.planReady && (eff.busy === true || eff.status === "running") && (spec as { needsYou?: { kind?: string } } | null)?.needsYou?.kind === "plano") {
    store.patchSpec(taskId, { needsYou: null });
    if (task.status === "needs-you") store.setStatus(taskId, "running");
  }
  if (eff.planReady && !["merged", "done", "aborted"].includes(task.status)) {
    store.patchSpec(taskId, { needsYou: { kind: "plano", text: PLAN_READY_NOTE, at: Date.now() } });
    store.setStatus(taskId, "needs-you");
  }
  if (eff.status && !["merged", "done", "aborted"].includes(task.status)) store.setStatus(taskId, eff.status);
  if (eff.status === "running") store.setStage(taskId, role?.role ?? "builder");
  if (eff.claim) {
    try { store.addClaim(taskId, agent, eff.claim.path, eff.claim.mode); } catch { /* claim é melhor-esforço */ }
  }
  for (const e of eff.events) store.addEvent(taskId, e.agent ?? agent, e.type, e.text, e.ok, e.agent ? undefined : role?.role, e.agent ? undefined : role?.agentId);
}

// ======================= pergunta do agente (AskUserQuestion) — PURO, testado em terminal.test.ts =======================
export interface AuqQuestion { question: string; header?: string; options?: { label?: string; description?: string }[]; multiSelect?: boolean }
export interface AuqRow { key: string; prompt: string; options: string[]; meta: { src: "auq"; group: string; idx: number; n: number; header: string; desc: string[]; multi: boolean } }
/** tool_input do AskUserQuestion → uma linha de `pending` por pergunta (opções = rótulos: celular e quadro já entendem). */
export function auqRows(input: unknown, group: string): AuqRow[] {
  const qs = Array.isArray((input as { questions?: unknown })?.questions) ? ((input as { questions: AuqQuestion[] }).questions) : [];
  const valid = qs.filter((q) => q && typeof q.question === "string" && q.question.trim());
  return valid.map((q, idx) => {
    const opts = (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === "string" && o.label.trim());
    return {
      key: q.question, // a chave do `answers` é o texto EXATO da pergunta (o Claude casa por ele)
      prompt: q.question.trim(),
      options: opts.map((o) => String(o.label).trim()),
      meta: { src: "auq", group, idx, n: valid.length, header: clip(q.header ?? "", 40), desc: opts.map((o) => clip(o.description ?? "", 200)), multi: !!q.multiSelect },
    };
  });
}
/**
 * Respostas gravadas (uma por pergunta, na ordem) → o que o hook devolve ao Claude Code.
 *  - null: ainda falta alguma; "terminal": a pessoa pediu pra responder no TTY (sai sem decisão);
 *  - senão { answers }: pergunta → resposta ("" = pulada, fica de fora — o Claude vê "sem resposta").
 */
export function auqCollect(questions: string[], answers: (string | null | undefined)[]): null | "terminal" | { answers: Record<string, string> } {
  if (answers.length < questions.length || answers.some((a) => a === null || a === undefined)) return null;
  if (answers.some((a) => a === AUQ_IN_TERMINAL)) return "terminal";
  const out: Record<string, string> = {};
  // "(sem resposta …)" = fechada pelo app/turno — vale como pulada (não vira texto de resposta)
  questions.forEach((q, i) => { const a = String(answers[i] ?? "").trim(); if (a && !/^\(sem resposta/.test(a)) out[q] = a; });
  return { answers: out };
}
/** JSON do PreToolUse que responde a pergunta: allow + o MESMO input com `answers` (verificado no Claude Code 2.1). */
export function auqHookOutput(input: Record<string, unknown>, answers: Record<string, string>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "respondido no Starfork", updatedInput: { ...input, answers } } });
}

/**
 * `hook AskUserQuestion --starfork-task <id>`: grava as perguntas como `pending` (folha do app, celular, "esperando
 * você" na barra lateral), espera as respostas e devolve allow + answers. Morto no meio (Esc no TTY) → fecha as linhas.
 */
export async function askHookCli(taskArg: string, repoArg: string): Promise<number> {
  let store: Store | null = null;
  let ids: number[] = [];
  const closeOpen = () => { try { if (store && ids.length) store.db.prepare(`UPDATE pending SET status='answered', answer=?, resolved_at=? WHERE status='open' AND id IN (${ids.map(() => "?").join(",")})`).run("(sem resposta — a pergunta foi fechada no terminal)", Date.now(), ...ids); } catch { /* banco fechado */ } };
  const bye = () => { closeOpen(); try { store?.close(); } catch { /* já fechado */ } process.exit(0); };
  process.once("SIGTERM", bye); process.once("SIGINT", bye); process.once("SIGHUP", bye);
  try {
    const { taskId, db } = hookTarget(taskArg, repoArg);
    if (!taskId || !db) return 0;
    let p: Record<string, any> = {};
    try { p = JSON.parse(readStdin() || "{}"); } catch { return 0; }
    const input = (p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {}) as Record<string, unknown>;
    const rows = auqRows(input, String(p.tool_use_id || `auq-${Date.now()}`));
    if (!rows.length) return 0; // nada pra perguntar: o CLI segue o fluxo dele
    store = new Store(db);
    const task = store.getTask(taskId);
    if (!task) return 0;
    let agent = task.agent;
    try { const sp = JSON.parse(task.spec_json) as TaskSpec; agent = (sp.roles?.find((r) => r.role === "builder") ?? sp.roles?.[0])?.name || agent; } catch { /* spec ilegível */ }
    // todas as perguntas de uma vez (transação): a folha nunca vê um grupo pela metade
    store.db.exec("BEGIN IMMEDIATE");
    try { ids = rows.map((r) => store!.addPending(taskId, agent, "question", r.prompt, r.options, r.meta)); store.db.exec("COMMIT"); }
    catch (e) { try { store.db.exec("ROLLBACK"); } catch { /* já encerrada */ } throw e; }
    store.addEvent(taskId, agent, "note", `perguntou ao humano: ${rows.map((r) => r.prompt).join(" · ")}`, undefined);
    if (process.env.CARDUME_NOTIFY !== "0") { try { const { notify } = await import("./util/notify.ts"); notify("Starfork", rows[0].prompt, `${agent} precisa de você`); } catch { /* sem notificação */ } }
    for (;;) {
      const cur = ids.map((id) => store!.getPending(id));
      // tarefa apagada/linhas removidas: ninguém vai responder — solta o CLI (o picker dele aparece no TTY)
      if (cur.some((r) => !r)) return 0;
      const got = cur.map((r) => (r!.status === "answered" ? (r!.answer ?? "") : null));
      const res = auqCollect(rows.map((r) => r.key), got);
      if (res === "terminal") { store.addEvent(taskId, "Sistema", "note", "pergunta: você escolheu responder no terminal", true); return 0; }
      if (res) {
        const txt = Object.entries(res.answers).map(([q, a]) => `${q} → ${a}`).join(" · ") || "(todas puladas)";
        store.addEvent(taskId, "Você", "note", `respondeu: ${clip(txt, 600)}`, true);
        process.stdout.write(auqHookOutput(input, res.answers) + "\n");
        return 0;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    process.stderr.write(`starfork hook ${AUQ_TOOL}: ${(e as Error)?.message ?? e}\n`);
    closeOpen();
    return 0;
  } finally {
    try { store?.close(); } catch { /* já fechado */ }
    store = null;
  }
}

// ======================= custo pela statusLine =======================
/**
 * A statusLine recebe o JSON da sessão (cost.total_cost_usd = ACUMULADO da sessão, já restaurado no --resume).
 * Grava o DELTA desde a última leitura como custo da tarefa — numa transação (várias barras podem rodar juntas).
 * Base = session_cost (a MESMA tabela do `claude -p --resume`): trocar de modo não conta duas vezes.
 */
export function recordStatuslineCost(store: Store, taskId: string, j: Record<string, any>): number {
  const sid = typeof j?.session_id === "string" ? j.session_id : "";
  const total = Number(j?.cost?.total_cost_usd);
  if (!sid || !Number.isFinite(total) || total <= 0) return 0;
  const task = store.getTask(taskId);
  if (!task) return 0;
  let delta = 0;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const row = store.db.prepare("SELECT total FROM session_cost WHERE session_id = ?").get(sid) as { total?: number } | undefined;
    const prev = typeof row?.total === "number" ? row.total : 0;
    if (total > prev + 1e-7) {
      delta = total - prev;
      store.db.prepare("INSERT INTO session_cost (session_id, total, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET total=excluded.total, updated_at=excluded.updated_at").run(sid, total, Date.now());
    }
    store.db.exec("COMMIT");
  } catch (e) {
    try { store.db.exec("ROLLBACK"); } catch { /* já encerrada */ }
    throw e;
  }
  if (delta > 0) {
    let spec: TaskSpec | null = null;
    try { spec = JSON.parse(task.spec_json); } catch { /* sem spec */ }
    const role = spec?.roles?.find((r) => r.role === "builder") ?? spec?.roles?.[0];
    const model = typeof j?.model?.id === "string" ? j.model.id : role?.model;
    store.addCost(taskId, role?.name || task.agent, role?.role ?? "builder", delta, 0, 0, 0, "claude", model, 0, role?.agentId);
  }
  return delta;
}

/** Linha da barra: a barra da pessoa (encadeada, mesmo stdin) ou modelo + custo da tarefa. */
export function statuslineText(j: Record<string, any>, taskUsd: number): string {
  const model = String(j?.model?.display_name ?? "Claude");
  return `${model} · Starfork: US$ ${taskUsd.toFixed(2)} nesta tarefa`;
}

/** O transcript da sessão existe em <config>/projects/<pasta>/<id>.jsonl? (é o que o `--resume` precisa) */
export function claudeTranscriptExists(sessionId: string, configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude")): boolean {
  if (!/^[\w-]{8,80}$/.test(sessionId)) return false;
  try {
    const root = join(configDir, "projects");
    return readdirSync(root).some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
  } catch { return false; }
}

// ======================= preparo do terminal (o app spawna o que voltar daqui) =======================
//
// TERMINAL INTEGRADO NO SHELL (macOS/Linux): o PTY é o SHELL de login da pessoa na worktree, cujo 1º comando sobe a
// IA (`starfork ia <ia>`): termina a IA → o prompt do shell volta (dá pra rodar outra IA, git, testes…). O `starfork`
// é um sh em <worktree>/.cardume/term/bin (no PATH do shell) que pede ao motor o LANÇAMENTO (`starfork ia-prep`:
// hooks/MCP/instruções/env da IA escolhida, impresso como script) e o roda NO PRÓPRIO sh, com o TTY herdado — sem
// node no meio: Ctrl+C chega na IA (o `trap ':' INT` só segura o sh) e o fim dela grava term_session.cli = ''.
// Windows segue no caminho antigo (a IA direto no PTY).

/** IAs que o terminal sabe abrir. DeepSeek = o `claude` falando com a API Anthropic-compatível da DeepSeek. */
export const TERM_AIS = ["claude", "codex", "deepseek", "gemini", "opencode"] as const;
export type TermAi = (typeof TERM_AIS)[number];
export const isTermAi = (x: unknown): x is TermAi => (TERM_AIS as readonly string[]).includes(String(x));
export const AI_LABEL: Record<TermAi, string> = { claude: "Claude Code", codex: "Codex", deepseek: "DeepSeek (no Claude Code)", gemini: "Gemini CLI", opencode: "OpenCode" };
const AI_BIN: Record<TermAi, string> = { claude: "claude", codex: "codex", deepseek: "claude", gemini: "gemini", opencode: "opencode" };
/** Comando de instalação oficial (npm) — vai na mensagem de "não instalado". */
export const AI_INSTALL: Record<TermAi, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  deepseek: "npm i -g @anthropic-ai/claude-code   (o DeepSeek roda dentro do Claude Code; a chave fica em Sua IA)",
  gemini: "npm i -g @google/gemini-cli",
  opencode: "npm i -g opencode-ai   (ou: curl -fsSL https://opencode.ai/install | bash)",
};
/** IA com hooks de turno (ocupado/livre, fim de turno). Gemini/OpenCode: sem hooks — o app entrega na hora. */
export const aiHasHooks = (ai: string) => ai === "claude" || ai === "codex" || ai === "deepseek";
/** Família de sessão: DeepSeek usa o transcript do `claude` (mesmo CLI) — retomar entre os dois vale. */
const aiFamily = (ai: string) => (ai === "deepseek" ? "claude" : ai);

/** Papel que conversa no terminal (o mesmo do terminalContext): o construtor. */
const talkRole = (spec: TaskSpec) => spec.roles?.find((r) => r.role === "builder") ?? spec.roles?.[0];
/** IA "natural" do motor da tarefa: codex/deepseek/gemini/opencode pelo rótulo; o resto (claude, gateway, "opus"…) =
 * claude. Mesma regra do Rust (term.rs › ai_of_engine) — o comando recomendado sai igual nos dois. */
export function aiOfEngine(engine: string | undefined): TermAi {
  const n = String(engine ?? "").trim().toLowerCase();
  return n.startsWith("gemini") ? "gemini" : n.startsWith("opencode") ? "opencode" : n.startsWith("codex") ? "codex" : isDshLabel(n) ? "deepseek" : "claude";
}
/** IA do terminal: a escolhida no app (spec.termAi) ou a do motor da tarefa. */
export function termAiOf(spec: Pick<TaskSpec, "termAi" | "engine" | "roles">, role = talkRole(spec as TaskSpec)): TermAi {
  return isTermAi(spec.termAi) ? spec.termAi : aiOfEngine(role?.engine || spec.engine);
}
/**
 * Modelo pra IA `ai`: o escolhido junto no app (termModel) → o do PAPEL da tarefa (o que a criação decidiu — às vezes
 * um mais leve) quando a IA é a do motor dela → vazio (o padrão da própria IA; modelo do Claude não serve pro Gemini).
 */
export function termModelOf(spec: Pick<TaskSpec, "termAi" | "termModel" | "engine" | "model" | "roles">, role = talkRole(spec as TaskSpec), ai: TermAi = termAiOf(spec, role)): string {
  if (spec.termAi === ai && String(spec.termModel ?? "").trim()) return String(spec.termModel).trim();
  return aiOfEngine(role?.engine || spec.engine) === ai ? String(role?.model || spec.model || "").trim() : "";
}
/** Palavra de shell: sem aspas quando não precisa (o comando recomendado fica legível pra quem vai digitar). */
export const shArg = (s: string) => (/^[\w.:@/+=-]+$/.test(s) ? s : shqp(s));
/** Aspas POSIX (o shell do terminal integrado nunca é o cmd do Windows). */
export const shqp = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export interface Recommended { ai: TermAi; model: string; command: string }
/** O lançamento RECOMENDADO da tarefa (IA + modelo que a criação decidiu) e a linha exata pro shell. */
export function recommendedLaunch(spec: TaskSpec, role = talkRole(spec)): Recommended {
  const ai = termAiOf(spec, role);
  const model = termModelOf(spec, role, ai);
  return { ai, model, command: `starfork ia ${ai}${model ? ` --modelo ${shArg(model)}` : ""}` };
}

export interface LaunchSpec {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envRemove: string[];
  /** IA que o terminal abre (rótulo pro pty.rs / term_session.engine) */
  engine: TermAi;
  resumed: boolean;
  sessionId: string | null;
  /** modelo com que a IA abre ('' = o padrão dela) — o app compara na troca de IA (mesma IA+modelo = nada a fazer) */
  model?: string;
  /** true = o PTY é o SHELL da pessoa (que sobe a IA no 1º comando); false = a IA direto no PTY (Windows) */
  shell?: boolean;
  /** nasce ocupado? (IA com hooks levando um pedido/kickoff — o 1º UserPromptSubmit confirma) */
  busy?: boolean;
  recommended?: Recommended;
}
/**
 * Variáveis que NÃO podem chegar ao CLI do terminal: marcadores de "sessão filha" de outro Claude Code (app
 * aberto de dentro de um terminal com claude rodando — com CLAUDE_CODE_CHILD_SESSION o transcript NÃO é gravado
 * e o `--resume` falha com "No conversation found") e chaves de API (quem paga é a assinatura, como no -p).
 * CLAUDE_CONFIG_DIR fica: é a config da pessoa.
 */
export function envToRemove(env: NodeJS.ProcessEnv = process.env): string[] {
  const fixed = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  const markers = Object.keys(env).filter((k) => /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/.test(k));
  return [...new Set([...fixed, ...markers])];
}

const toml = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(toml).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(",")}}`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
};

/** `which` sem shell: o 1º executável com esse nome no PATH. */
function whichIn(name: string, path = process.env.PATH ?? ""): string | null {
  for (const d of path.split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    const p = join(d, name);
    try { if (statSync(p).isFile()) return p; } catch { /* não está aqui */ }
  }
  return null;
}
/**
 * Binário da IA: CARDUME_AI_BIN_<ia> (override — testes e instalação fora do padrão) → a resolução de sempre
 * (claude: resolveClaude; codex/gemini/opencode: PATH, nvm, login shell…). null = não instalado.
 */
export function resolveAiBin(ai: TermAi, env: NodeJS.ProcessEnv = process.env): string | null {
  const ov = env[`CARDUME_AI_BIN_${ai}`]?.trim() || (ai === "deepseek" ? env.CARDUME_AI_BIN_claude?.trim() : "");
  if (ov) return ov;
  if (ai === "claude" || ai === "deepseek") {
    const b = resolveClaude();
    if (b.includes("/") || b.includes("\\")) return existsSync(b) ? b : null;
    return whichIn(b);
  }
  return resolveToolCached(AI_BIN[ai]).bin;
}
/** "Não instalado" em pt-BR, com o comando de instalação. */
export const aiMissingMsg = (ai: TermAi) => `${AI_LABEL[ai]} não está instalado neste computador (procurei \`${AI_BIN[ai]}\`). Instale com:\n  ${AI_INSTALL[ai]}\ne rode de novo: starfork ia ${ai}`;
export class AiMissingError extends Error {}

/** Estado do terminal POR IA (.cardume/term/state.json): sessão de cada família e quem rodou por último. */
function sessionFor(ai: TermAi, st: TermState, cur: string, engineAi: TermAi): string {
  const fam = aiFamily(ai);
  if (st.lastAi) return aiFamily(st.lastAi) === fam ? cur || st.sessions?.[fam] || "" : st.sessions?.[fam] ?? "";
  // terminal de antes da troca de IA: a sessão gravada é da IA do motor da tarefa
  return aiFamily(engineAi) === fam ? cur : "";
}
/** Grava a sessão que estava valendo pra IA anterior (antes de trocar / ao sair). */
function snapshotSession(st: TermState, cur: string | null | undefined): void {
  if (st.lastAi && cur) (st.sessions ??= {})[aiFamily(st.lastAi)] = cur;
}

export interface AiLaunch { ai: TermAi; program: string; args: string[]; env: Record<string, string>; envRemove: string[]; resumed: boolean; sessionId: string | null; cwd: string; busy: boolean }
/**
 * Monta o lançamento da IA `ai` pra tarefa: grava hooks/statusLine/MCP/instruções na worktree, deixa a tarefa
 * "rodando" com o modo FIXO (spec.termMode = "terminal") e devolve programa/args/env.
 *  - resume: retoma a sessão gravada DESSA IA (`claude --resume <id>` / `codex resume <id>` / `gemini --resume latest`
 *    / `opencode --continue`); sem sessão → nova.
 *  - message: 1ª mensagem (ex.: follow-up mandado com a IA fechada).   - model: vazio = termModelOf.
 */
export function aiLaunch(orch: Orchestrator, taskId: string, ai: TermAi, opts: { resume?: boolean; message?: string; model?: string; quiet?: boolean; continueNote?: boolean; papel?: "revisor" | "construtor"; round?: number } = {}): AiLaunch {
  // QUIETO (o app retoma sozinho ao abrir a tarefa — 08/10): a IA só ABRE e espera; nada de 1ª mensagem/kickoff
  // (não gasta nada até a pessoa mandar), status/etapa intocados e sem notas de "abrindo" no feed
  const quiet = !!opts.quiet;
  // troca de PAPEL no terminal (revisor automático): o revisor entra com a persona, a lente e a regra do VEREDITO.md
  const reviewer = opts.papel === "revisor";
  const round = Math.max(1, Number(opts.round) || 1);
  const { task, spec, role, ctx } = orch.terminalContext(taskId, reviewer ? { role: "reviewer", round } : {});
  const model = String(opts.model ?? (reviewer ? (aiOfEngine(role.engine) === ai ? role.model ?? "" : "") : termModelOf(spec, role, ai))).trim();
  // DeepSeek: a chave é conferida ANTES de mexer em qualquer coisa (erro claro em vez de um `claude` sem login)
  const dsEnv = ai === "deepseek" ? deepseekClaudeEnv(model || undefined, dshKey()) : null;
  if (!existsSync(task.worktree)) throw new Error(task.status === "merged" ? "a worktree desta tarefa foi apagada ao integrar — pra mexer de novo, abra uma tarefa nova de ajuste" : "a worktree desta tarefa não existe mais");
  const bin = resolveAiBin(ai);
  if (!bin) throw new AiMissingError(aiMissingMsg(ai));
  if (spec.termMode !== "terminal") { spec.termMode = "terminal"; orch.store.patchSpec(taskId, { termMode: "terminal" }); }
  const repo = orch.ws.repo;
  const base = engineBase();
  const st = readTermState(task.worktree);
  const cur = task.session_id || orch.store.termGet(taskId)?.session_id || "";
  let sid = opts.resume && aiHasHooks(ai) ? sessionFor(ai, st, cur, aiOfEngine(role.engine || spec.engine)) : "";
  // a volta pro CONSTRUTOR retoma a sessão DELE (a do revisor nunca); o revisor abre sempre numa sessão nova
  if (opts.papel === "construtor" && spec.termBuilderSid && aiHasHooks(ai)) sid = spec.termBuilderSid;
  if (reviewer) sid = "";
  // gemini/opencode não têm id de sessão pra nós: retomam "a última desta pasta" — só se já rodaram aqui
  const resumeLast = !!opts.resume && !aiHasHooks(ai) && !!st.started?.[ai];
  // assumiu um turno de fundo de planner/revisor: sessão NOVA que continua do que está na worktree
  let lostSession = !!opts.continueNote;
  if (lostSession) sid = "";
  // sessão sem transcript (apagado, outra máquina, gravação desligada): `claude --resume` sairia na hora com
  // "No conversation found" — abre sessão NOVA que continua da worktree
  if (sid && aiFamily(ai) === "claude" && !claudeTranscriptExists(sid)) {
    orch.store.addEvent(taskId, "Sistema", "note", "A sessão anterior do terminal não foi encontrada — abrindo uma sessão nova que continua do que está na worktree.", true);
    sid = "";
    lostSession = true;
  }
  const input = { cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: orch.ws.dbFile, askTimeoutMin: 0 };
  // o MESMO preparo do `claude -p` (prompt + .cardume/mcp.json); as outras IAs reaproveitam o mcp.json escrito aqui
  const claude = new ClaudeEngine({ model: role.model, approval: spec.autonomy?.approval ?? "ask" });
  const { prompt, mcpConfigPath, protectOn } = claude.prepareTurn(input);
  let mcp: { command?: string; args?: string[]; env?: Record<string, string> } = {};
  try { mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8")).mcpServers.cardume; } catch { /* sem MCP: os `starfork …` do shell seguem valendo */ }
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CARDUME_DB: orch.ws.dbFile,
    CARDUME_TASK: taskId,
    CARDUME_AGENT: role.name,
    CARDUME_ROLE: role.role,
    STARFORK_TERMINAL: "1",
  };
  // quem fala agora (a faixa do app e o feed usam): revisor guarda a sessão do construtor; construtor limpa a marca
  if (!quiet || opts.papel) {
    if (reviewer) {
      const builderName = (spec.roles ?? []).find((r) => r.role === "builder")?.name || spec.agent;
      try { rmSync(join(task.worktree, ".cardume", "VEREDITO.md"), { force: true }); } catch { /* sem veredito velho */ }
      orch.store.patchSpec(taskId, { termRole: { role: "reviewer", name: role.name, builder: builderName, round, max: MAX_REVIEW_ROUNDS }, ...(spec.termRole?.role === "reviewer" ? {} : { termBuilderSid: cur || null }) });
    } else if (spec.termRole) orch.store.patchSpec(taskId, { termRole: null, ...(opts.papel === "construtor" ? { termBuilderSid: null } : {}) });
  }
  const CONTINUE = "A sessão anterior deste terminal se perdeu. O trabalho já feito está NESTA worktree: confira git status, git diff e .cardume/artifacts, releia .cardume/TASK.yaml e continue de onde parou.";
  const first = quiet ? "" : [lostSession ? CONTINUE : "", (opts.message ?? "").trim()].filter(Boolean).join("\n\n");
  // quieto com a sessão perdida: o aviso vai nas INSTRUÇÕES (system prompt / developer) — a IA sabe de onde continuar
  // quando a pessoa mandar algo, sem gastar nada agora
  const quietNote = quiet && lostSession ? `\n\n## Sessão nova\n${CONTINUE}` : "";
  let args: string[] = [];
  let envRemove = envToRemove();
  // integrada: modo conversa (nada de kickoff "execute a tarefa", nada de status mudando)
  const merged = task.status === "merged";
  const mergedNote = merged ? mergedRule(lastPr(spec)) : "";
  const rules = shellInstructions() + (merged ? `\n${mergedNote}` : "");
  // .cardume/term/AGENTS.starfork.md: as instruções do terminal SEMPRE num arquivo nosso (fora do git) — a IA que
  // aceita arquivo de instruções aponta pra ele; AGENTS.md/GEMINI.md da raiz só se forem nossos (nunca o rastreado)
  const ownRules = join(termDir(task.worktree), "AGENTS.starfork.md");
  try { mkdirSync(dirname(ownRules), { recursive: true }); writeFileSync(ownRules, rules, "utf8"); } catch { /* segue com a 1ª mensagem */ }
  let kicked = false;
  const genericKick = () => merged || quiet ? "" : codexPrompt(input) + (planApprovalOn(spec) ? `\n\n${PLAN_FIRST_RULE}` : "") + "\n\nNeste terminal você TEM as ferramentas do Starfork (mcp cardume) e os comandos `starfork …` no shell: use ask_human (ou `starfork perguntar`) para dúvidas e add_requirement (ou `starfork requisito`) para pedidos novos.\n\n" + INTEGRADO_RULE;
  if (ai === "claude" || ai === "deepseek") {
    // a pasta foi criada pelo Starfork a partir do repo da pessoa: sem o "Is this a project you trust?" (padrão = sair)
    trustClaudeProject(task.worktree, repo);
    writeClaudeSettings(task.worktree, base, taskId, repo);
    // /starfork-* do terminal integrado (só os nossos; arquivo de mesmo nome da pessoa fica) — fora do commit
    try { const c = writeStarforkCommands(task.worktree); excludeFromGit(task.worktree, c.written); } catch { /* sem comandos: as tools seguem */ }
    if (sid) args.push("--resume", sid);
    // as regras do Starfork vão no SYSTEM PROMPT (reenviado a cada abertura, inclusive no --resume): a conversa
    // no terminal começa limpa, com um pedido curto — e não com 10 KB de regra na 1ª mensagem
    args.push("--append-system-prompt", `${ctx}\n\n## Instruções do Starfork para esta tarefa\n${prompt}\n\n${INTEGRADO_RULE}${INTEGRADO_CLAUDE_CMDS}${INTEGRADO_SHELL}${mergedNote ? `\n${mergedNote}` : ""}${quietNote}`);
    const kick = first || (sid || merged || quiet ? "" : reviewer ? reviewKick(round) : KICKOFF);
    // rodada de CONSTRUÇÃO: o kickoff de uma tarefa nova ou a volta do revisor com mudanças (no fim dela, o revisor)
    if (kick === KICKOFF || (opts.papel === "construtor" && first)) orch.store.patchSpec(taskId, { termBuild: true });
    // Cadeado 1 (aprovar o plano) no terminal: SÓ no kickoff de uma tarefa nova, em plan mode — o ExitPlanMode nativo é
    // o cadeado (vira "precisa de você"); no --resume nunca (senão o cadeado reabriria a cada abertura)
    const planGate = kick === KICKOFF && planApprovalOn(spec);
    args.push("--mcp-config", mcpConfigPath, ...protectArgs(protectOn), "--permission-mode", planGate ? "plan" : "bypassPermissions");
    // DeepSeek: o modelo vai no env (ANTHROPIC_MODEL) — `--model deepseek-…` seria validado como id do Claude
    if (model && !dsEnv) args.push("--model", model);
    if (kick) args.push(kick);
    kicked = !!kick;
    const ce = claudeEnv();
    env.PATH = ce.PATH ?? process.env.PATH ?? "";
    if (dsEnv) {
      Object.assign(env, dsEnv);
      // o pty.rs remove ANTES de aplicar o env, mas a lista não pode nem sugerir que a chave some
      envRemove = envRemove.filter((k) => !(k in dsEnv));
      orch.store.addEvent(taskId, "Sistema", "note", `terminal DeepSeek (${dsEnv.ANTHROPIC_MODEL.replace(/\[1m\]$/, "")}) dentro do Claude Code — o custo em US$ da barra não é gravado (seria preço de Claude)`, true);
    }
  } else if (ai === "codex") {
    args = sid ? ["resume", sid] : [];
    args.push("-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"');
    if (mcp.command) {
      args.push("-c", `mcp_servers.cardume.command=${toml(mcp.command)}`, "-c", `mcp_servers.cardume.args=${toml(mcp.args ?? [])}`, "-c", `mcp_servers.cardume.env=${toml(mcp.env ?? {})}`);
    }
    // sem o "Do you trust the contents of this directory?": confiança SÓ nesta sessão (-c; o ~/.codex/config.toml
    // da pessoa não muda). Conferido no codex 0.153: a chave com aspas (projects."<p>".trust_level) não pega — a
    // tabela inteira sim; ela só vale pra esta sessão, que roda nesta pasta
    args.push("-c", codexTrustArg(task.worktree, repo));
    // instruções do terminal como mensagem de "developer" (config do Codex) — valem também no `codex resume`
    args.push("-c", `developer_instructions=${toml(rules + quietNote)}`);
    // comandos IGUAIS em toda tarefa (tarefa/banco vêm do env CARDUME_TASK/CARDUME_DB): o Codex pede pra pessoa
    // revisar/confiar em hook NOVO ou ALTERADO — com o id da tarefa no comando seria um "Hooks need review" por
    // tarefa; assim é UMA vez (por instalação do motor)
    args.push("-c", `notify=${toml(hookArgv(base, "codex-notify", CODEX_ENV_TASK, ""))}`);
    for (const ev of CODEX_HOOK_EVENTS) {
      args.push("-c", `hooks.${ev}=${toml([{ hooks: [{ type: "command", command: shellCmd(hookArgv(base, ev, CODEX_ENV_TASK, "")), timeout: 30 }] }])}`);
    }
    if (model) args.push("-m", model);
    const kick = first || (sid ? "" : reviewer ? reviewKick(round) : genericKick());
    if ((!sid && !reviewer && kick && !first) || (opts.papel === "construtor" && first)) orch.store.patchSpec(taskId, { termBuild: true });
    if (kick) args.push(kick);
    kicked = !!kick;
    Object.assign(env, loadLlmEnv());
    env.PATH = toolPath(bin, process.env.PATH);
    try { if (writeInstructionsSection(task.worktree, "AGENTS.md", rules)) excludeFromGit(task.worktree, ["AGENTS.md"]); } catch { /* developer_instructions já leva */ }
    orch.store.addEvent(taskId, "Sistema", "note", `terminal Codex — limites: ${CODEX_LIMITS.join("; ")}`, true);
  } else if (ai === "gemini") {
    // MCP pelo arquivo de settings de SISTEMA apontado no env (GEMINI_CLI_SYSTEM_SETTINGS_PATH): não toca no
    // .gemini/settings.json do repo; o de sistema que a pessoa já tenha entra mesclado
    const path = join(termDir(task.worktree), "gemini-settings.json");
    writeJsonAtomic(path, geminiSettings(readJson(geminiSystemSettingsPath()), mcp));
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path;
    const inFile = (() => { try { const ok = writeInstructionsSection(task.worktree, "GEMINI.md", rules); if (ok) excludeFromGit(task.worktree, ["GEMINI.md"]); return ok; } catch { return false; } })();
    env.PATH = toolPath(bin, process.env.PATH);
    // flags conferidas no --help da versão INSTALADA (o Gemini CLI muda rápido: 0.1.x não tem -i nem --resume)
    const help = cliHelp(bin, env.PATH);
    const canResume = resumeLast && help.includes("--resume");
    args.push("--yolo");
    if (model) args.push("--model", model);
    if (canResume) args.push("--resume", "latest");
    // GEMINI.md da pessoa (rastreado) intocado → as regras vão na 1ª mensagem
    const kick = quiet ? "" : [canResume ? "" : genericKick(), inFile || canResume ? "" : rules, first].filter(Boolean).join("\n\n");
    if (kick && help.includes("--prompt-interactive")) args.push("--prompt-interactive", kick);
    else if (kick) orch.store.addEvent(taskId, "Sistema", "note", `Gemini CLI antigo (sem --prompt-interactive): abri sem a 1ª mensagem do Starfork — atualize com ${AI_INSTALL.gemini}`, false);
  } else {
    // OpenCode: config PRÓPRIA no OPENCODE_CONFIG (mescla com a global e a do projeto, sem tocar no opencode.json do repo)
    const path = join(termDir(task.worktree), "opencode.json");
    writeJsonAtomic(path, opencodeConfig(mcp, ownRules));
    env.OPENCODE_CONFIG = path;
    try { if (writeInstructionsSection(task.worktree, "AGENTS.md", rules)) excludeFromGit(task.worktree, ["AGENTS.md"]); } catch { /* o instructions do config já leva */ }
    if (model) args.push("--model", model);
    if (resumeLast) args.push("--continue");
    const kick = [resumeLast ? "" : genericKick(), first].filter(Boolean).join("\n\n");
    if (kick) args.push("--prompt", kick);
    env.PATH = toolPath(bin, process.env.PATH);
  }
  // integrada NUNCA sai de integrada (abrir o terminal pra perguntar não é voltar a construir)
  if (!quiet && !merged && !["done", "aborted"].includes(task.status)) { orch.store.setStage(taskId, role.role); orch.store.setStatus(taskId, "running"); }
  if (!quiet) orch.store.addEvent(taskId, "Sistema", "status", `${sid || resumeLast ? `abrindo o terminal (${ai}) e retomando a sessão` : `abrindo o terminal (${ai})`}${merged ? " — tarefa integrada: só conversa" : ""}`, true);
  const busy = aiHasHooks(ai) && kicked;
  return { ai, program: bin, args, env, envRemove, resumed: !!(sid || resumeLast), sessionId: sid || null, cwd: task.worktree, busy };
}

/** 1ª mensagem do REVISOR no terminal (a regra do veredito vai no system prompt — verdictInstructions). */
export const reviewKick = (round: number) => `Revise o trabalho desta tarefa (rodada ${round} de ${MAX_REVIEW_ROUNDS}): leia .cardume/TASK.yaml, o diff da branch (git diff da base até HEAD) e as provas em .cardume/artifacts. NÃO altere código. No fim, escreva o veredito em .cardume/VEREDITO.md como pedem as instruções do Starfork (no seu system prompt).`;
/** A tarefa pede aprovação do plano antes de construir (Cadeado 1)? */
export const planApprovalOn = (spec: TaskSpec) => spec?.autonomy?.planApproval === "review";
/** Kickoff das IAs sem plan mode nativo quando a tarefa pede aprovação do plano. */
export const PLAN_FIRST_RULE = "APROVAÇÃO DO PLANO: antes de mudar qualquer arquivo, apresente o PLANO (passos, arquivos, riscos) e PARE pedindo aprovação ao humano (suggest_replies com \"pode seguir\" / \"mudar o plano\"). Só construa depois do ok.";
/**
 * PORTÃO DO TETO no terminal (a mesma régua do pipeline — Orchestrator.capGate): gasto ≥ 80% do teto → a tarefa vai
 * pra "precisa de você" com a pergunta do teto (budgetHit mode "etapa": liberar → ▶ abre o terminal de novo) e o
 * pedido NÃO sobe. Piloto automático: quem decide é o piloto.
 */
export function termCapGate(orch: Orchestrator, taskId: string, next: string): void {
  const t = orch.store.getTask(taskId);
  if (!t) return;
  let spec: TaskSpec;
  try { spec = JSON.parse(t.spec_json) as TaskSpec; } catch { return; }
  if (spec.autopilot) return;
  const cap = effectiveCap(spec.budgetUsd, readCostCapSetting());
  const spent = orch.store.taskSpend(taskId);
  if (capCheck(spent, cap) === "ok") return;
  const at = Date.now();
  const text = capPauseText(spent, cap, next);
  orch.store.patchSpec(taskId, { budgetUsd: cap, budgetHit: { usd: Math.round(spent * 10000) / 10000, cap, at, mode: "etapa" }, needsYou: { kind: "teto", text, at } });
  if (!["merged", "done", "aborted"].includes(t.status)) orch.store.setStatus(taskId, "needs-you");
  orch.store.addEvent(taskId, "Sistema", "note", text, false);
  throw new Error(`teto de custo: ${text}`);
}

/** Caminho e o real (macOS: /tmp → /private/tmp) — a IA compara pelo real, a pessoa vê o outro. */
const bothPaths = (p: string) => { let r = p; try { r = realpathSync(p); } catch { /* não existe */ } return [...new Set([p, r])]; };
/** Config do Claude Code com as pastas confiadas: $CLAUDE_CONFIG_DIR/.claude.json ou ~/.claude.json. */
export const claudeJsonPath = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR?.trim() ? join(env.CLAUDE_CONFIG_DIR.trim(), ".claude.json") : join(env.HOME?.trim() || homedir(), ".claude.json");
/**
 * Marca a worktree da tarefa como confiada no Claude Code (projects[<pasta>].hasTrustDialogAccepted = true; conferido
 * no ~/.claude.json do Claude Code 2.1). Só pasta nossa (<repo>/.cardume/worktrees/…), arquivo existente (não cria),
 * gravação atômica preservando o resto; qualquer erro = segue (o diálogo aparece, como antes). Devolve se gravou.
 */
export function trustClaudeProject(worktree: string, repo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    // pastas do Starfork: worktrees das tarefas e as pastas de revisão de PR (.cardume/reviews)
    const roots = ["worktrees", "reviews"].map((d) => join(repo, ".cardume", d) + "/");
    if (!roots.some((root) => worktree.startsWith(root))) return false;
    const p = claudeJsonPath(env);
    if (!existsSync(p)) return false;
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    if (!cfg || typeof cfg !== "object") return false;
    const projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : (cfg.projects = {});
    let changed = false;
    for (const k of bothPaths(worktree)) {
      const cur = projects[k] && typeof projects[k] === "object" ? projects[k] : (projects[k] = {});
      if (cur.hasTrustDialogAccepted !== true) { cur.hasTrustDialogAccepted = true; changed = true; }
    }
    if (!changed) return false;
    const tmp = `${p}.starfork-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: statSync(p).mode & 0o777 });
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}
/** `-c projects={…}` do Codex: a worktree e a raiz do repo (o Codex aplica a confiança à raiz do git) como trusted. */
export function codexTrustArg(worktree: string, repo: string): string {
  const t: Record<string, { trust_level: string }> = {};
  for (const k of [...bothPaths(worktree), ...bothPaths(repo)]) t[k] = { trust_level: "trusted" };
  return `projects=${toml(t)}`;
}

/** `<ia> --help` (stdout+stderr) pra conferir flag que muda entre versões. Falhou = "" (usa só o básico). */
function cliHelp(bin: string, path: string | undefined): string {
  try {
    const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: path ?? process.env.PATH ?? "", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  } catch { return ""; }
}

/** Tarefa JÁ INTEGRADA reaberta no terminal: só conversa (perguntas sobre o que foi feito) — mudança vira tarefa de ajuste. */
export function mergedRule(prUrl?: string): string {
  return `## Tarefa já integrada — modo conversa\n` +
    `Esta tarefa JÁ FOI INTEGRADA${prUrl ? ` (PR ${prUrl})` : ""}. Responda perguntas sobre o que foi feito usando o histórico, o diff (git log/diff contra a base) e .cardume/artifacts. ` +
    `NÃO altere código aqui; se o humano pedir mudança, crie uma tarefa de ajuste com \`starfork tarefa "Ajuste: …"\` (rascunho, mesmo épico) e diga isso a ele.\n` +
    `Termine TODA resposta chamando \`starfork sugerir\` (ou suggest_replies) com 2–4 próximas perguntas/ações curtas (ex.: "o que mudou no X?", "mostra os testes", "abrir ajuste").\n`;
}
const lastPr = (spec: TaskSpec) => spec.prUrl || spec.prHistory?.[spec.prHistory.length - 1];

/** Linha extra do system prompt do Claude: os `starfork …` do shell (fallback quando o MCP cai). */
const INTEGRADO_SHELL = "- No shell deste terminal também há o comando `starfork` (status, sugerir, etapa, pr, tarefa, skill…) — `starfork ajuda` lista.\n";

const readJson = (p: string | null): Record<string, unknown> | null => { if (!p) return null; try { const v = JSON.parse(readFileSync(p, "utf8")); return v && typeof v === "object" ? v : null; } catch { return null; } };
/** Onde o Gemini CLI procura o settings de SISTEMA (o env da pessoa vence). */
export function geminiSystemSettingsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GEMINI_CLI_SYSTEM_SETTINGS_PATH?.trim()) return env.GEMINI_CLI_SYSTEM_SETTINGS_PATH.trim();
  return process.platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json" : process.platform === "win32" ? "C:\\ProgramData\\gemini-cli\\settings.json" : "/etc/gemini-cli/settings.json";
}
/** settings do Gemini: o de sistema da pessoa + mcpServers.cardume (trust = sem confirmar cada ferramenta nossa). */
export function geminiSettings(existing: Record<string, unknown> | null, mcp: { command?: string; args?: string[]; env?: Record<string, string> }): Record<string, unknown> {
  const out: Record<string, unknown> = existing ? JSON.parse(JSON.stringify(existing)) : {};
  if (mcp.command) {
    const servers = (out.mcpServers && typeof out.mcpServers === "object" ? out.mcpServers : {}) as Record<string, unknown>;
    servers.cardume = { command: mcp.command, args: mcp.args ?? [], env: mcp.env ?? {}, trust: true, description: "Starfork — tarefa, provas, PR" };
    out.mcpServers = servers;
  }
  // Gemini CLI novo: "confiar nesta pasta?" (security.folderTrust) — a pasta é do Starfork; desligado só nesta sessão
  const sec = (out.security && typeof out.security === "object" ? out.security : {}) as Record<string, unknown>;
  sec.folderTrust = { ...(sec.folderTrust && typeof sec.folderTrust === "object" ? sec.folderTrust : {}), enabled: false };
  out.security = sec;
  return out;
}
/** opencode.json do terminal: MCP local (command = argv inteiro) + as instruções do Starfork + sem pedir permissão. */
export function opencodeConfig(mcp: { command?: string; args?: string[]; env?: Record<string, string> }, rulesFile: string): Record<string, unknown> {
  const out: Record<string, unknown> = { $schema: "https://opencode.ai/config.json", instructions: [rulesFile], permission: { edit: "allow", bash: "allow", webfetch: "allow" } };
  if (mcp.command) out.mcp = { cardume: { type: "local", command: [mcp.command, ...(mcp.args ?? [])], environment: mcp.env ?? {}, enabled: true, timeout: 15000 } };
  return out;
}

// ---- o shell ----
export const TERM_BIN_REL = ".cardume/term/bin";
export const NEXT_MSG_REL = ".cardume/term/next-msg.txt";
/** O `starfork` do shell: pede o lançamento ao motor e roda a IA NESTE sh (TTY herdado; Ctrl+C vai pra IA). */
export function shimScript(base: string[]): string {
  const b = base.map(shqp).join(" ");
  return "#!/bin/sh\n" +
    "# Starfork — o comando `starfork` do terminal integrado (regravado a cada abertura do terminal; não edite).\n" +
    "# `starfork ia <ia>`: o motor imprime o lançamento (env, MCP, hooks, instruções) e ESTE sh o executa com o TTY\n" +
    "# herdado — Ctrl+C chega na IA (o trap só impede o sh de morrer junto) e, quando ela sai, o prompt do shell volta.\n" +
    'if [ "$1" = ia ]; then\n' +
    "  shift\n" +
    // o ia-prep morreu antes de limpar (crash do node): o `_ia-exit --falha` solta cli/ocupado
    `  __sf_launch=$(${b} starfork ia-prep "$@") || { ${b} starfork _ia-exit "$1" --falha >/dev/null 2>&1; exit 1; }\n` +
    "  trap ':' INT\n" +
    '  eval "$__sf_launch"\n' +
    "  exit $?\n" +
    "fi\n" +
    `exec ${b} starfork "$@"\n`;
}
/** Grava <worktree>/.cardume/term/bin/starfork (executável) e devolve a pasta (vai na frente do PATH do shell). */
export function writeShim(worktree: string, base: string[]): string {
  const dir = join(worktree, TERM_BIN_REL);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "starfork");
  const body = shimScript(base);
  let cur = "";
  try { cur = readFileSync(p, "utf8"); } catch { /* novo */ }
  if (cur !== body) writeFileSync(p, body, "utf8");
  chmodSync(p, 0o755);
  excludeFromGit(worktree, [".cardume/term/"]);
  return dir;
}
/** Shell de login da pessoa: $SHELL (se for um shell conhecido e existir) → /bin/zsh → /bin/bash. */
export function userShell(env: NodeJS.ProcessEnv = process.env): string {
  const s = String(env.SHELL ?? "").trim();
  if (s.startsWith("/") && /\/(zsh|bash|fish|ksh|sh|dash)$/.test(s) && existsSync(s)) return s;
  return existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
}
/**
 * Linha do `-c` do shell: sobe a IA e, quando ela sai, abre o shell interativo de login na worktree. SEM `exec` de
 * propósito, e o `; :` no fim impede o zsh de dar exec sozinho no último comando: o líder do PTY fica com esta linha
 * (o caminho do shim) — é por ela que a varredura do boot (pty.rs › looks_like_agent) reconhece um terminal órfão;
 * `exit` no shell de dentro fecha os dois.
 */
export function shellLine(shim: string, shell: string, o: { ai: TermAi; model?: string; resume?: boolean; quiet?: boolean; msgFile?: string }): string {
  return `${shqp(shim)} ia ${o.ai}${o.model ? ` --modelo ${shArg(o.model)}` : ""}${o.resume ? " --resume" : ""}${o.quiet ? " --quieto" : ""}${o.msgFile ? ` --msg-file ${shqp(o.msgFile)}` : ""}; ${shqp(shell)} -l -i; :`;
}

/**
 * Monta o terminal da tarefa. macOS/Linux: o SHELL da pessoa na worktree subindo `starfork ia <ia>` (a escolhida no
 * app ou a do motor, com o modelo da tarefa); Windows (ou `direct`): a IA direto no PTY, como antes.
 *  - resume: retoma a sessão gravada; message: 1ª mensagem (vai por arquivo — nada de texto do humano no argv do shell);
 *  - ai/model: troca de IA pelo app (term_switch_ai) — senão termAiOf/termModelOf.
 */
export function termPrep(orch: Orchestrator, taskId: string, opts: { resume?: boolean; quiet?: boolean; message?: string; ai?: string; model?: string; direct?: boolean; newSession?: boolean } = {}): LaunchSpec {
  // quieto + mensagem não combinam: a mensagem é um pedido explícito (vai e gasta, pelos portões de sempre)
  const quiet = !!opts.quiet && !(opts.message ?? "").trim();
  const task = orch.store.getTask(taskId);
  if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
  const spec = JSON.parse(task.spec_json) as TaskSpec;
  // portão do TETO: abrir pra TRABALHAR (kickoff ou mensagem) passa por ele; abrir quieto (só olhar) não gasta nada
  if (!quiet) termCapGate(orch, taskId, "abrir o terminal");
  // assumiu um turno de fundo de planner/revisor: a sessão gravada não é de quem conversa — sessão nova (veto Rafa/Júlia)
  if (opts.newSession) opts = { ...opts, resume: false };
  const role = talkRole(spec);
  const ai = isTermAi(opts.ai) ? opts.ai : termAiOf(spec, role);
  const model = String(opts.model ?? termModelOf(spec, role, ai)).trim();
  const recommended = recommendedLaunch(spec, role);
  if (opts.direct || process.platform === "win32") {
    const L = aiLaunch(orch, taskId, ai, { resume: opts.resume, message: opts.message, model, quiet, continueNote: !!opts.newSession });
    return { program: L.program, args: L.args, cwd: L.cwd, env: L.env, envRemove: L.envRemove, engine: ai, resumed: L.resumed, sessionId: L.sessionId, model, shell: false, busy: L.busy, recommended };
  }
  // DeepSeek sem chave: erro claro ANTES de abrir o PTY (a matriz da spec)
  if (ai === "deepseek") deepseekClaudeEnv(model || undefined, dshKey());
  if (!existsSync(task.worktree)) throw new Error(task.status === "merged" ? "a worktree desta tarefa foi apagada ao integrar — pra mexer de novo, abra uma tarefa nova de ajuste" : "a worktree desta tarefa não existe mais");
  if (spec.termMode !== "terminal") { spec.termMode = "terminal"; orch.store.patchSpec(taskId, { termMode: "terminal" }); }
  const binDir = writeShim(task.worktree, engineBase());
  if (opts.newSession) { const st0 = readTermState(task.worktree); st0.continueNext = true; writeTermState(task.worktree, st0); }
  const msg = (opts.message ?? "").trim();
  if (msg) writeFileSync(join(task.worktree, NEXT_MSG_REL), msg, "utf8");
  const shell = userShell();
  const st = readTermState(task.worktree);
  const cur = task.session_id || orch.store.termGet(taskId)?.session_id || "";
  const sid = opts.resume && aiHasHooks(ai) ? sessionFor(ai, st, cur, aiOfEngine(role?.engine || spec.engine)) : "";
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CARDUME_DB: orch.ws.dbFile,
    CARDUME_TASK: taskId,
    CARDUME_AGENT: role?.name || spec.agent,
    CARDUME_ROLE: role?.role ?? "builder",
    STARFORK_TERMINAL: "1",
    STARFORK_SHELL: "1",
    // bash do macOS avisa "o shell padrão agora é o zsh" a cada abertura
    BASH_SILENCE_DEPRECATION_WARNING: "1",
    PATH: [binDir, ...(claudeEnv().PATH ?? process.env.PATH ?? "").split(":").filter((d) => d && d !== binDir)].join(":"),
  };
  if (!quiet) orch.store.addEvent(taskId, "Sistema", "status", `abrindo o terminal (shell ${shell.split("/").pop()} → ${AI_LABEL[ai]}${model ? ` · ${model}` : ""})`, true);
  return {
    program: shell,
    args: ["-l", "-i", "-c", shellLine(join(binDir, "starfork"), shell, { ai, model, resume: opts.resume, quiet, msgFile: msg ? NEXT_MSG_REL : undefined })],
    cwd: task.worktree,
    env,
    envRemove: envToRemove(),
    engine: ai,
    resumed: !!sid,
    sessionId: sid || null,
    model,
    shell: true,
    busy: aiHasHooks(ai) && !!(msg || (!quiet && !sid && task.status !== "merged")),
    recommended,
  };
}

/** Script que o `starfork ia` roda no sh dele: cd na worktree, env da IA (chave da DeepSeek SÓ aqui, nunca no
 * argv), a IA no TTY e, quando ela sai, `_ia-exit` (term_session.cli = ''). */
export function launchScript(L: AiLaunch, base: string[]): string {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const unset = L.envRemove.filter((k) => name.test(k) && !(k in L.env));
  const out = [`cd ${shqp(L.cwd)} || exit 1`];
  if (unset.length) out.push(`unset ${unset.join(" ")}`);
  for (const [k, v] of Object.entries(L.env)) if (name.test(k)) out.push(`export ${k}=${shqp(v)}`);
  out.push([L.program, ...L.args].map(shqp).join(" "));
  out.push("__sf_rc=$?");
  // a IA saiu (fim normal, troca de papel, sinal): o TTY volta são — modo de linha, colagem e cursor (Téo na mesa)
  out.push("stty sane 2>/dev/null; printf '\\033[?2004l\\033[?25h' 2>/dev/null");
  out.push(`${base.map(shqp).join(" ")} starfork _ia-exit ${L.ai} >/dev/null 2>&1`);
  out.push("exit $__sf_rc");
  return out.join("\n") + "\n";
}

/** `starfork ia-prep <ia>` (dentro do shell): prepara a IA, grava que ela está rodando e imprime o script. */
export function iaPrep(orch: Orchestrator, taskId: string, ai: TermAi, o: { resume?: boolean; quiet?: boolean; msgFile?: string; model?: string; papel?: string; round?: number }): { script: string; launch: AiLaunch } {
  let message = "";
  let msgPath = "";
  try {
    const task = orch.store.getTask(taskId);
    if (!task) throw new Error(`tarefa ${taskId} não encontrada (CARDUME_TASK)`);
    if (o.msgFile) {
      // SÓ o arquivo de mensagem do terminal (é lido e APAGADO): relativo = à worktree (a pessoa pode ter dado cd)
      msgPath = join(task.worktree, NEXT_MSG_REL);
      if (resolve(task.worktree, o.msgFile) !== msgPath) { msgPath = ""; throw new Error(`--msg-file só aceita ${NEXT_MSG_REL}`); }
      try { message = readFileSync(msgPath, "utf8"); rmSync(msgPath, { force: true }); } catch { /* sem arquivo: abre sem mensagem */ }
    }
    const st0 = readTermState(task.worktree);
    snapshotSession(st0, orch.store.termGet(taskId)?.session_id);
    const continueNote = !!st0.continueNext;
    delete st0.continueNext;
    writeTermState(task.worktree, st0);
    const papel = o.papel === "revisor" || o.papel === "construtor" ? o.papel : undefined;
    // troca de papel (revisor automático) gasta: passa pelo portão do teto nas DUAS direções (Júlia na mesa)
    if (papel && !(o.quiet && !message.trim() && papel === "construtor")) termCapGate(orch, taskId, papel === "revisor" ? "revisar" : "voltar pra construção");
    const launch = aiLaunch(orch, taskId, ai, { resume: o.resume, message, model: o.model, quiet: !!o.quiet && !message.trim(), continueNote, papel, round: o.round });
    // relê: o aiLaunch grava a barra de status da pessoa (prevStatusLine) no mesmo arquivo
    const st = readTermState(task.worktree);
    st.lastAi = ai;
    (st.started ??= {})[ai] = Date.now();
    writeTermState(task.worktree, st);
    orch.store.termSetCli(taskId, ai);
    orch.store.termSetBusy(taskId, launch.busy);
    return { script: launchScript(launch, engineBase()), launch };
  } catch (e) {
    try { orch.store.termSetCli(taskId, ""); orch.store.termSetBusy(taskId, false); } catch { /* banco fora: o shim chama _ia-exit --falha */ }
    // mensagem que não foi entregue volta pro arquivo (a próxima `starfork ia` leva)
    if (message && msgPath) try { writeFileSync(msgPath, message, "utf8"); } catch { /* perdida: o feed tem o texto */ }
    throw e;
  }
}
/** `starfork _ia-exit <ia>`: a IA saiu e o shell voltou ao prompt. */
export function iaExit(store: Store, taskId: string, ai: string, o: { failed?: boolean } = {}): void {
  const task = store.getTask(taskId);
  if (!task) return;
  // --falha: a IA nem subiu (ia-prep caiu) — só solta o estado, sem "encerrado" no feed
  if (o.failed) { store.termSetCli(taskId, ""); store.termSetBusy(taskId, false); return; }
  const st = readTermState(task.worktree);
  st.lastAi = isTermAi(ai) ? ai : st.lastAi;
  snapshotSession(st, store.termGet(taskId)?.session_id);
  writeTermState(task.worktree, st);
  store.termSetCli(taskId, "");
  store.termSetBusy(taskId, false);
  // saiu no meio de um turno (Ctrl+C duplo, crash): não fica "rodando" pra sempre (mesma regra do fim do PTY)
  store.db.prepare(`UPDATE task SET status='review' WHERE id=? AND status IN ('running','thinking')`).run(taskId);
  store.addEvent(taskId, "Sistema", "status", `${AI_LABEL[ai as TermAi] ?? ai} encerrado — o terminal segue no shell (\`starfork ia …\` ou uma mensagem pelo app abre de novo)`, true);
}

/** `term-ai <id> --ai x [--model m]`: grava a IA (e o modelo) do terminal no spec — reabrir lembra. */
export function setTermAi(orch: Orchestrator, taskId: string, ai: string, model?: string): Recommended {
  if (!isTermAi(ai)) throw new Error(`IA desconhecida: ${ai} (use ${TERM_AIS.join(" | ")})`);
  const task = orch.store.getTask(taskId);
  if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
  const spec = JSON.parse(task.spec_json) as TaskSpec;
  spec.termAi = ai;
  const m = String(model ?? "").trim();
  if (m) spec.termModel = m; else delete spec.termModel;
  orch.store.updateSpec(taskId, JSON.stringify(spec));
  return recommendedLaunch(spec);
}

/**
 * Texto a mandar pro terminal pra cada pedido do app (conversa, "pedir prova", "pedir ajuste", "continuar").
 * Faz os mesmos efeitos colaterais do modo automático (requisito novo, ajuste no TASK.yaml) e devolve o texto.
 */
export async function termMessage(orch: Orchestrator, taskId: string, kind: string, o: { msg?: string; asReq?: boolean; deliver?: string }): Promise<string> {
  const task = orch.store.getTask(taskId);
  if (!task) throw new Error(`tarefa ${taskId} não encontrada`);
  const spec = JSON.parse(task.spec_json) as TaskSpec;
  const msg = String(o.msg ?? "").trim();
  const writeSpec = async () => {
    orch.store.updateSpec(taskId, JSON.stringify(spec));
    try { writeFileSync(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree some */ }
  };
  if (kind === "kickoff") {
    // ▶ com o terminal aberto só pra olhar: o kickoff vai nele — pelo portão do teto, como abrir pra trabalhar
    termCapGate(orch, taskId, "começar a tarefa");
    orch.store.patchSpec(taskId, { termBuild: true });
    return KICKOFF;
  }
  if (kind === "deliver") {
    const k = (["doc", "tests", "proof", "all"].includes(String(o.deliver)) ? o.deliver : "all") as "doc" | "tests" | "proof" | "all";
    return deliverPrompt(k);
  }
  if (kind === "rework") {
    const open = orch.store.openInstructions(taskId);
    const adjustment = [...open.map((i) => i.text.trim()), msg].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("\n");
    for (const i of open) orch.store.markInstructionApplied(i.id);
    if (adjustment) { spec.adjustment = adjustment; await writeSpec(); }
    // "pedir ajuste" é rodada de CONSTRUÇÃO: no fim dela o revisor (se houver e estiver ligado) entra
    orch.store.patchSpec(taskId, { termBuild: true });
    return adjustRuleOf(spec).trim() || msg;
  }
  if (!msg) throw new Error("mensagem vazia");
  if (o.asReq) {
    spec.requirements = [...(spec.requirements ?? []), msg];
    await writeSpec();
    orch.store.addEvent(taskId, "Você", "note", `requisito adicionado: ${msg.slice(0, 100)}`, true);
    return `${msg}\n\n(Isto virou um REQUISITO novo da tarefa — já está no .cardume/TASK.yaml; inclua no requirements.json com evidência.)`;
  }
  return msg;
}

// ======================= entrada do CLI (`cli.mjs hook|statusline|turn-end|term-prep|term-msg`) =======================
const readStdin = (): string => { try { return readFileSync(0, "utf8"); } catch { return ""; } };
const dbOf = (repo: string) => join(repo, ".cardume", "state.sqlite");

/** `hook <Evento> --starfork-task <id> --repo <repo>` — nunca quebra o CLI: erro vai pro stderr, saída 0. */
/** Fim de turno que o hook Stop pediu pra rodar EM LINHA (o `cli hook Stop` espera ele antes de devolver ao Claude Code). */
let inlineTurnEnd: { taskId: string; repo: string } | null = null;
export function takeInlineTurnEnd(): { taskId: string; repo: string } | null { const t = inlineTurnEnd; inlineTurnEnd = null; return t; }
export function hookCli(event: string, taskArg: string, repoArg: string, argvPayload?: string, o: { inline?: boolean } = {}): number {
  try {
    const { taskId, repo, db } = hookTarget(taskArg, repoArg);
    if (!taskId || !db) return 0;
    const raw = event === "codex-notify" ? (argvPayload ?? "") : readStdin();
    let p: Record<string, any> = {};
    try { p = raw ? JSON.parse(raw) : {}; } catch { /* payload não-JSON */ }
    if (event === "codex-notify" && p.type && p.type !== "agent-turn-complete") return 0;
    const store = new Store(db);
    try {
      const eff = mapHook(event, p);
      // fala INTEIRA (o feed guarda o começo; as opções ficam no fim)
      let full = String(p.last_assistant_message ?? p["last-assistant-message"] ?? "");
      if (event === "Stop" && eff.events[0]?.text === "turno concluído") {
        const t = lastAssistantText(p.transcript_path);
        if (t) { eff.events[0].text = clip(t, 2000); full = t; }
      }
      const wasBusy = (store.termGet(taskId)?.busy ?? 0) === 1;
      applyHook(store, taskId, eff);
      // chips de reserva: o agente não chamou suggest_replies, mas a fala termina com opções claras
      if (eff.turnEnd && full) {
        try {
          if (!suggestedSinceUser(store.eventsForTask(taskId))) {
            const opts = suggestFromText(full);
            if (opts) {
              let agent = store.getTask(taskId)?.agent ?? "agente", role: string | undefined;
              try { const sp = JSON.parse(store.getTask(taskId)!.spec_json) as TaskSpec; const r = sp.roles?.find((x) => x.role === "builder") ?? sp.roles?.[0]; agent = r?.name || agent; role = r?.role; } catch { /* spec ilegível */ }
              store.addEvent(taskId, agent, "suggest", JSON.stringify(opts), true, role);
            }
          }
        } catch { /* chips são extra */ }
      }
      // fim de turno: no Stop/notify sempre; no SessionEnd só se a sessão caiu NO MEIO de um turno (senão o
      // fim de turno já rodou no Stop e o gate apareceria duas vezes)
      if (eff.turnEnd || (eff.ended && wasBusy)) {
        if (o.inline && event === "Stop") inlineTurnEnd = { taskId, repo };
        else spawnTurnEnd(taskId, repo);
      }
    } finally { store.close(); }
  } catch (e) {
    process.stderr.write(`starfork hook ${event}: ${(e as Error)?.message ?? e}\n`);
  }
  return 0;
}

/** Fim de turno roda DESTACADO (commit, testes do gate…): o hook volta na hora e não segura o CLI. */
function spawnTurnEnd(taskId: string, repo: string): void {
  try {
    const c = spawn(process.execPath, [...process.execArgv.filter((a) => a === "--experimental-sqlite"), "--disable-warning=ExperimentalWarning", process.argv[1], "turn-end", taskId, "--repo", repo], { cwd: repo, detached: true, stdio: "ignore", env: process.env });
    c.unref();
  } catch { /* sem fim de turno: o próximo Stop refaz */ }
}

/** `turn-end <id>`: uma por vez por tarefa (trava em arquivo; trava velha de 10 min é descartada). */
export async function turnEndCli(repo: string, taskId: string, o: { inline?: boolean } = {}): Promise<void> {
  const orch = new Orchestrator(repo);
  const task = orch.store.getTask(taskId);
  if (!task) { orch.close(); return; }
  const lock = join(termDir(task.worktree), "turn-end.lock");
  let openPr = false;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    try { if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { force: true }); } catch { /* sem trava */ }
    let fd: number | null = null;
    // em linha (hook Stop): ESPERA o outro fim de turno terminar (trava por tarefa) — o deste turno não pode se perder
    const until = Date.now() + (o.inline ? (STOP_HOOK_TIMEOUT_S - 30) * 1000 : 0);
    for (;;) {
      try { fd = openSync(lock, "wx"); break; } catch { /* em curso */ }
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (fd === null) { orch.close(); return; } // outro fim de turno em curso
    closeSync(fd);
    try {
      const r = await orch.terminalTurnEnd(taskId, () => (orch.store.termGet(taskId)?.busy ?? 0) === 1, { deferPr: !!o.inline });
      openPr = !!r?.openPr;
      const st = readTermState(task.worktree); st.lastTurnEnd = Date.now(); writeTermState(task.worktree, st);
    } finally { rmSync(lock, { force: true }); }
  } finally { orch.close(); }
  // o PR (push + gh) sai DESTACADO: o hook devolve o controle ao Claude Code com o estado já consistente
  if (openPr) spawnDetached(["turn-end", taskId, "--so-pr", "--repo", repo], repo);
}
function spawnDetached(args: string[], cwd: string): void {
  try {
    const c = spawn(process.execPath, [...process.execArgv.filter((a) => a === "--experimental-sqlite"), "--disable-warning=ExperimentalWarning", process.argv[1], ...args], { cwd, detached: true, stdio: "ignore", env: process.env });
    c.unref();
  } catch { /* sem PR automático: o botão Abrir PR segue valendo */ }
}

/** `statusline --starfork-task <id>`: grava o custo e imprime a barra (a da pessoa, se houver, encadeada). */
export function statuslineCli(taskId: string, repo: string): number {
  const raw = readStdin();
  let j: Record<string, any> = {};
  try { j = JSON.parse(raw); } catch { /* sem JSON */ }
  let usd = 0;
  let worktree = "";
  try {
    const store = new Store(process.env.CARDUME_DB || dbOf(repo));
    try {
      // DeepSeek dentro do `claude`: o total_cost_usd vem com preço de Claude — não vira custo da tarefa
      if (!skipStatuslineCost()) recordStatuslineCost(store, taskId, j);
      worktree = store.getTask(taskId)?.worktree ?? "";
      usd = Number((store.db.prepare("SELECT COALESCE(SUM(usd),0) AS u FROM cost WHERE task_id = ?").get(taskId) as { u?: number })?.u ?? 0);
    } finally { store.close(); }
  } catch (e) { process.stderr.write(`starfork statusline: ${(e as Error)?.message ?? e}\n`); }
  const prev = worktree ? readTermState(worktree).prevStatusLine : null;
  if (prev) {
    try {
      const r = process.platform === "win32" ? spawnSync("bash", ["-c", prev], { input: raw, encoding: "utf8", timeout: 2000, windowsHide: true }) : spawnSync(prev, { shell: true, input: raw, encoding: "utf8", timeout: 2000 });
      if (r.stdout) { process.stdout.write(String(r.stdout).replace(/\n+$/, "") + ` · US$ ${usd.toFixed(2)} nesta tarefa\n`); return 0; }
    } catch { /* barra da pessoa quebrou: cai na nossa */ }
  }
  process.stdout.write(statuslineText(j, usd) + "\n");
  return 0;
}
