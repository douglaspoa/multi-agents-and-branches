// MODO TERMINAL — cada tarefa roda o CLI OFICIAL (`claude` / `codex`) num terminal de verdade dentro do app
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
//
// Os hooks chamam o motor empacotado: `<node> cli.mjs hook <Evento> --starfork-task <id> --repo <repo>`.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeEngine, claudeEnv, mapTool, resolveClaude, adjustRuleOf } from "./engine/claude.ts";
import { buildPrompt as codexPrompt, loadLlmEnv } from "./engine/codex.ts";
import { codexResolution, toolPath } from "./engine/bin-resolve.ts";
import { protectArgs, protectEnabled } from "./engine/protect.ts";
import { engineKind, Orchestrator, deliverPrompt } from "./orchestrator.ts";
import { Store } from "./store.ts";
import { taskToYaml } from "./util/yaml.ts";
import type { AgentStatus, TaskSpec } from "./types.ts";

export type TermMode = "terminal" | "auto";
/** Tarefa antiga (sem o campo) = automático: nada muda pra quem já rodava. */
export const termModeOf = (spec: { termMode?: string } | null | undefined): TermMode => (spec?.termMode === "terminal" ? "terminal" : "auto");
/** Só Claude e Codex têm CLI interativo oficial; DeepSeek/gateway seguem no automático. */
export const terminalCapable = (engine: string | undefined): boolean => ["claude", "codex"].includes(engineKind(engine));

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
    const h: { type: string; command: string; timeout: number; async?: boolean } = { type: "command", command: shellCmd(hookArgv(base, ev, taskId, repo)), timeout: 30 };
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

interface TermState { prevStatusLine?: string | null; lastTurnEnd?: number }
function readTermState(worktree: string): TermState { try { return JSON.parse(readFileSync(join(termDir(worktree), "state.json"), "utf8")); } catch { return {}; } }
function writeTermState(worktree: string, s: TermState): void { try { writeJsonAtomic(join(termDir(worktree), "state.json"), s); } catch { /* best-effort */ } }

// ======================= hooks → feed/estado (PURO — testado em terminal.test.ts) =======================
export interface FeedEvent { agent?: "Você" | "Sistema"; type: string; text: string; ok?: boolean }
export interface HookEffect {
  events: FeedEvent[];
  busy?: boolean;
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
      return { events: prompt ? [{ agent: "Você", type: "note", text: `Você: ${clip(userText(prompt), 4000)}`, ok: true }] : [], busy: true, status: "running", sessionId: p.session_id || undefined };
    }
    case "PreToolUse": {
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
      return { events: [{ agent: "Sistema", type: "note", text: waiting ? `⏸ esperando você no terminal: ${msg}` : `terminal: ${msg}`, ok: !waiting }] };
    }
    case "Stop":
    case "codex-notify": {
      const last = clip(p.last_assistant_message ?? p["last-assistant-message"] ?? "", 2000);
      return { events: [{ type: "done", text: last || "turno concluído", ok: true }], busy: false, turnEnd: true, sessionId: p.session_id || p["thread-id"] || undefined };
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

/** Aplica o efeito no banco da tarefa. Devolve o efeito (o chamador dispara o fim de turno). */
export function applyHook(store: Store, taskId: string, eff: HookEffect): void {
  const task = store.getTask(taskId);
  if (!task) return;
  let spec: TaskSpec | null = null;
  try { spec = JSON.parse(task.spec_json); } catch { /* spec ilegível: feed segue com o nome do agente */ }
  const role = spec?.roles?.find((r) => r.role === "builder") ?? spec?.roles?.[0];
  const agent = role?.name || task.agent;
  if (eff.sessionId) store.termSetSession(taskId, eff.sessionId);
  // turno novo, fim de turno ou sessão fechada: nenhum hook espera mais a pergunta (Esc no TTY mata o hook)
  if (eff.turnEnd || eff.ended || eff.status === "running") store.closeAuqQuestions(taskId);
  if (eff.busy !== undefined) store.termSetBusy(taskId, eff.busy);
  if (eff.status && !["merged", "aborted"].includes(task.status)) store.setStatus(taskId, eff.status);
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
export interface LaunchSpec {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envRemove: string[];
  engine: "claude" | "codex";
  resumed: boolean;
  sessionId: string | null;
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

/**
 * Monta o comando do terminal da tarefa: grava hooks/statusLine/MCP na worktree, deixa a tarefa "rodando"
 * com o modo FIXO (spec.termMode = "terminal") e devolve programa/args/env pro PTY.
 *  - resume: retoma a sessão gravada (`claude --resume <id>` / `codex resume <id>`); sem sessão → nova.
 *  - message: 1ª mensagem (ex.: follow-up mandado com o terminal fechado).
 */
export function termPrep(orch: Orchestrator, taskId: string, opts: { resume?: boolean; message?: string } = {}): LaunchSpec {
  const { task, spec, role, ctx } = orch.terminalContext(taskId);
  const kind = engineKind(role.engine || spec.engine);
  if (kind !== "claude" && kind !== "codex") throw new Error(`o motor "${role.engine || spec.engine}" não tem terminal — use o modo automático`);
  if (!existsSync(task.worktree)) throw new Error(task.status === "merged" ? "a worktree desta tarefa foi apagada ao integrar — pra mexer de novo, abra uma tarefa nova de ajuste" : "a worktree desta tarefa não existe mais");
  if (spec.termMode !== "terminal") { spec.termMode = "terminal"; orch.store.updateSpec(taskId, JSON.stringify(spec)); }
  const repo = orch.ws.repo;
  const base = engineBase();
  let sid = opts.resume ? (task.session_id || orch.store.termGet(taskId)?.session_id || "") : "";
  let lostSession = false;
  // sessão sem transcript (apagado, outra máquina, gravação desligada): `claude --resume` sairia na hora com
  // "No conversation found" — abre sessão NOVA que continua da worktree
  if (sid && engineKind(role.engine || spec.engine) === "claude" && !claudeTranscriptExists(sid)) {
    orch.store.addEvent(taskId, "Sistema", "note", "A sessão anterior do terminal não foi encontrada — abrindo uma sessão nova que continua do que está na worktree.", true);
    sid = "";
    lostSession = true;
  }
  const input = { cwd: task.worktree, spec, systemContext: ctx, role: role.role, agentName: role.name, dbFile: orch.ws.dbFile, askTimeoutMin: 0 };
  // o MESMO preparo do `claude -p` (prompt + .cardume/mcp.json); o Codex reaproveita o mcp.json escrito aqui
  const claude = new ClaudeEngine({ model: role.model, approval: spec.autonomy?.approval ?? "ask" });
  const { prompt, mcpConfigPath, protectOn } = claude.prepareTurn(input);
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CARDUME_DB: orch.ws.dbFile,
    CARDUME_TASK: taskId,
    CARDUME_AGENT: role.name,
    CARDUME_ROLE: role.role,
    STARFORK_TERMINAL: "1",
  };
  const CONTINUE = "A sessão anterior deste terminal se perdeu. O trabalho já feito está NESTA worktree: confira git status, git diff e .cardume/artifacts, releia .cardume/TASK.yaml e continue de onde parou.";
  const first = [lostSession ? CONTINUE : "", (opts.message ?? "").trim()].filter(Boolean).join("\n\n");
  let program: string, args: string[];
  if (kind === "claude") {
    writeClaudeSettings(task.worktree, base, taskId, repo);
    program = resolveClaude();
    args = [];
    if (sid) args.push("--resume", sid);
    // as regras do Starfork vão no SYSTEM PROMPT (reenviado a cada abertura, inclusive no --resume): a conversa
    // no terminal começa limpa, com um pedido curto — e não com 10 KB de regra na 1ª mensagem
    args.push("--append-system-prompt", `${ctx}\n\n## Instruções do Starfork para esta tarefa\n${prompt}`);
    args.push("--mcp-config", mcpConfigPath, ...protectArgs(protectOn), "--permission-mode", "bypassPermissions");
    if (role.model) args.push("--model", role.model);
    const kick = first || (sid ? "" : KICKOFF);
    if (kick) args.push(kick);
    const ce = claudeEnv();
    env.PATH = ce.PATH ?? process.env.PATH ?? "";
  } else {
    const res = codexResolution();
    program = res.bin ?? "codex";
    let mcp: { command?: string; args?: string[]; env?: Record<string, string> } = {};
    try { mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8")).mcpServers.cardume; } catch { /* sem MCP: segue sem ask_human */ }
    args = sid ? ["resume", sid] : [];
    args.push("-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"');
    if (mcp.command) {
      args.push("-c", `mcp_servers.cardume.command=${toml(mcp.command)}`, "-c", `mcp_servers.cardume.args=${toml(mcp.args ?? [])}`, "-c", `mcp_servers.cardume.env=${toml(mcp.env ?? {})}`);
    }
    // comandos IGUAIS em toda tarefa (tarefa/banco vêm do env CARDUME_TASK/CARDUME_DB): o Codex pede pra pessoa
    // revisar/confiar em hook NOVO ou ALTERADO — com o id da tarefa no comando seria um "Hooks need review" por
    // tarefa; assim é UMA vez (por instalação do motor)
    args.push("-c", `notify=${toml(hookArgv(base, "codex-notify", CODEX_ENV_TASK, ""))}`);
    for (const ev of CODEX_HOOK_EVENTS) {
      args.push("-c", `hooks.${ev}=${toml([{ hooks: [{ type: "command", command: shellCmd(hookArgv(base, ev, CODEX_ENV_TASK, "")), timeout: 30 }] }])}`);
    }
    if (role.model) args.push("-m", role.model);
    const kick = first || (sid ? "" : codexPrompt(input) + "\n\nNeste terminal você TEM as ferramentas do Starfork (mcp cardume): use ask_human para dúvidas e add_requirement para pedidos novos.");
    if (kick) args.push(kick);
    Object.assign(env, loadLlmEnv());
    env.PATH = toolPath(program, process.env.PATH);
    orch.store.addEvent(taskId, "Sistema", "note", `terminal Codex — limites: ${CODEX_LIMITS.join("; ")}`, true);
  }
  orch.store.setStage(taskId, role.role);
  orch.store.setStatus(taskId, "running");
  orch.store.addEvent(taskId, "Sistema", "status", sid ? `abrindo o terminal (${kind}) e retomando a sessão` : `abrindo o terminal (${kind})`, true);
  return { program, args, cwd: task.worktree, env, envRemove: envToRemove(), engine: kind, resumed: !!sid, sessionId: sid || null };
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
  if (kind === "deliver") {
    const k = (["doc", "tests", "proof", "all"].includes(String(o.deliver)) ? o.deliver : "all") as "doc" | "tests" | "proof" | "all";
    return deliverPrompt(k);
  }
  if (kind === "rework") {
    const open = orch.store.openInstructions(taskId);
    const adjustment = [...open.map((i) => i.text.trim()), msg].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("\n");
    for (const i of open) orch.store.markInstructionApplied(i.id);
    if (adjustment) { spec.adjustment = adjustment; await writeSpec(); }
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
export function hookCli(event: string, taskArg: string, repoArg: string, argvPayload?: string): number {
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
      if (event === "Stop" && eff.events[0]?.text === "turno concluído") {
        const t = lastAssistantText(p.transcript_path);
        if (t) eff.events[0].text = clip(t, 2000);
      }
      const wasBusy = (store.termGet(taskId)?.busy ?? 0) === 1;
      applyHook(store, taskId, eff);
      // fim de turno: no Stop/notify sempre; no SessionEnd só se a sessão caiu NO MEIO de um turno (senão o
      // fim de turno já rodou no Stop e o gate apareceria duas vezes)
      if (eff.turnEnd || (eff.ended && wasBusy)) spawnTurnEnd(taskId, repo);
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
export async function turnEndCli(repo: string, taskId: string): Promise<void> {
  const orch = new Orchestrator(repo);
  const task = orch.store.getTask(taskId);
  if (!task) { orch.close(); return; }
  const lock = join(termDir(task.worktree), "turn-end.lock");
  try {
    mkdirSync(dirname(lock), { recursive: true });
    try { if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { force: true }); } catch { /* sem trava */ }
    let fd: number;
    try { fd = openSync(lock, "wx"); } catch { orch.close(); return; } // outro fim de turno em curso
    closeSync(fd);
    try {
      await orch.terminalTurnEnd(taskId, () => (orch.store.termGet(taskId)?.busy ?? 0) === 1);
      const st = readTermState(task.worktree); st.lastTurnEnd = Date.now(); writeTermState(task.worktree, st);
    } finally { rmSync(lock, { force: true }); }
  } finally { orch.close(); }
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
      recordStatuslineCost(store, taskId, j);
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
