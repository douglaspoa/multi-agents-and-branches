// DETECTOR DE LOOP (aprovado pelo dono em 07/10; regra revista na revisão adversarial): a IA RE-TENTANDO a mesma coisa
// sem mudar nada gasta tokens sem avançar. Regra DETERMINÍSTICA e CONSERVADORA — falso alarme é pior que loop perdido:
//
//   • "em loop" = a MESMA falha (ferramenta + comando/arquivo normalizado + erro normalizado) LOOP_FAIL_N (3) vezes SEM
//     nenhuma mudança de arquivo bem-sucedida no meio (Edit/Write/MultiEdit/apply_patch com conteúdo novo, ou comando
//     que grava: sed -i, >, mv, git checkout…) e sem um sucesso da mesma ação no meio. "corrige → testa → corrige →
//     testa" NUNCA dispara.
//   • não contam: código 1 de grep/rg/test/[ ]/diff/cmp/git diff --quiet (não é falha); espera/polling (sleep, watch,
//     gh run watch, gh pr checks, curl em laço, TaskOutput…); ferramentas de navegador; ferramentas do próprio Starfork.
//   • subagentes têm janela própria (agent_id do hook do Claude Code; parent_tool_use_id no stream).
//   • o aviso some: sucesso da mesma ferramenta no mesmo alvo; fim do turno sem que o último resultado daquela ação seja
//     a mesma falha; mensagem da pessoa; parar/interromper (o app apaga a linha em stop_task/abort_task); dispensar.
//
// Normalização (o mesmo erro com linha/hora diferentes = mesma assinatura) SÓ tira: cores ANSI, arquivo:linha:coluna,
// caminhos temporários, datas/horários, durações (12ms, 1.5s), hashes hex (7+, com dígito e letra) e UUIDs. Números
// soltos ficam ("3 failed" ≠ "5 failed", porta 5432 ≠ 5433).
//
// Estado e aviso moram SÓ na tabela loop_state do state.sqlite (fora do spec: nada de corrida com patch_task_spec) —
// o snapshot do app lê o aviso dali (lib.rs loop_warns). Um evento 'loop' por episódio vai pro feed.
import type { Store } from "./store.ts";
import { withBusyRetry } from "./store.ts";

export const LOOP_FAIL_N = 3;
const HIST_MAX = 40;

/** Uma tentativa. `key` = identidade COMPLETA da entrada; `label` = comando/arquivo; `change` = mudou arquivo;
 * `agent` = janela (subagente). */
export interface ToolAttempt { tool: string; label: string; key: string; ok: boolean; error?: string; change?: boolean; agent?: string }
interface HistItem { k: string; l: string; f?: string; /** falha superada por sucesso da mesma ação */ r?: 1; /** mudança de arquivo */ c?: 1 }
interface Win { hist: HistItem[]; fired?: { sig: string; l: string } | null }
/** O aviso (snapshot → front `t.loop`) e o texto do evento 'loop'. */
export interface LoopInfo { kind: "erro"; n: number; what: string; text: string; sig: string; at: number; agent?: string }
export interface LoopState { w: Record<string, Win>; warn?: LoopInfo | null }
export interface LoopStep { state: LoopState; fire?: LoopInfo; clear?: boolean }

// ---------------------------------------------------------------- normalização (PURA)
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s: string) => String(s ?? "").replace(ANSI, "");
const TMP_PATH = /(?:\/private)?\/(?:var\/folders|tmp|var\/tmp)\/[^\s'"`:)]*/g;

/** Comando/arquivo comparável: sem ANSI, espaços colapsados, wrapper de shell (`bash -lc '…'`) tirado, temp → <tmp>. */
export function normLabel(s: string): string {
  let t = stripAnsi(s).trim();
  const m = t.match(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/) || t.match(/^(?:\/\S*\/)?(?:ba|z)?sh -l?c (.*)$/);
  if (m) t = m[m.length - 1];
  return t.replace(TMP_PATH, "<tmp>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Linha que melhor diz o erro (a 1ª com cara de erro; senão a 1ª não vazia), sem ANSI, cortada. */
export function errorLine(err: string): string {
  const lines = stripAnsi(err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(exit code:?\s*-?\d+|process exited with code \d+|wall time:|output:?$|command failed with exit code)/i.test(l));
  const hit = lines.find((l) => /error|cannot|can't|could not|failed|fail:|not found|no such|denied|exception|fatal|undefined|expected|missing|invalid|unexpected|refused|timed? ?out|✗|✘/i.test(l));
  return (hit ?? lines[0] ?? "").replace(/\s+/g, " ").slice(0, 200);
}

/** Mensagem de erro comparável — só o que muda a cada tentativa sem mudar o erro (ver o topo). */
export function normError(err: string): string {
  return errorLine(err)
    .replace(TMP_PATH, "<tmp>")
    .replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/g, "<ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?:0x)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/(\.[a-z][a-z0-9]*)(:\d+)(:\d+)?\b/gi, "$1:N")
    .replace(/(\.[a-z][a-z0-9]*)\(\d+,\d+\)/gi, "$1(N)")
    .replace(/(["'],? line) \d+/gi, "$1 N")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "<dur>")
    .trim();
}

// ---------------------------------------------------------------- o que conta (PURO)
/** Ferramentas do próprio Starfork/coordenação: não contam e mantêm a nota de sempre no feed. */
const SKIP_TOOL = /^(mcp__cardume__|mcp__starfork__)|^(AskUserQuestion|TodoWrite|ExitPlanMode|Task|Agent)$/;
/** Espera/polling e navegador: não contam e a falha delas não vira nota "falhou" no feed. */
const POLL_TOOL = /^(TaskOutput|BashOutput|KillShell|KillBash|write_stdin|Monitor|Sleep|Wait)$/i;
const BROWSER_TOOL = /browser|playwright|puppeteer|chrome|screenshot|computer/i;
const POLL_CMD = /(^|[;&|(]\s*|\b(?:then|do)\s+)(sleep|watch|wait)\b|\bgh\s+(run\s+(watch|view)|pr\s+checks)\b|\b(while|until)\b[\s\S]*\bdo\b|\bfor\b[\s\S]*\bdo\b[\s\S]*\b(curl|wget|gh)\b/;
const EDIT_TOOL = /^(edit|multiedit|write|notebookedit|str_replace\w*|create_file|apply_patch|patch)$/i;
/** Comando que GRAVA (vale como "mudou alguma coisa"): na dúvida, conta como mudança — evita alarme. */
const WRITE_CMD = /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|(^|[^>&0-9])>{1,2}\s*(?!&|\/dev\/null)\S|\btee\b|\b(mv|cp|rm|touch|mkdir|patch|ln)\s|\bgit\s+(apply|checkout|switch|restore|reset|stash|mv|rm|am|cherry-pick|merge|rebase|pull|revert)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|uninstall|remove)\b|\bpip3?\s+install\b|\bcargo\s+(add|update)\b|\bgo\s+get\b/;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const cmdOf = (inp: any): string => (Array.isArray(inp?.command) ? inp.command.join(" ") : str(inp?.command ?? inp?.cmd ?? ""));
const fileOf = (inp: any): string => str(inp?.file_path ?? inp?.path ?? inp?.notebook_path ?? inp?.filename ?? "");
const isShell = (tool: string) => /^(bash|shell|exec_command|local_shell|container\.exec)$/i.test(tool) || /(^|_)shell$/i.test(tool);
function patchFiles(inp: unknown): string {
  const t = typeof inp === "string" ? inp : str((inp as any)?.input ?? (inp as any)?.patch ?? (inp as any)?.command ?? "");
  return [...t.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim()).join(", ");
}
/** JSON com as chaves ordenadas em TODOS os níveis (o replacer de array do JSON.stringify perdia os aninhados). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson((v as any)[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
/** Código de saída que aparece no texto do erro ("Exit code 1", "Exit code: 1", "exited with code 1"). */
export function exitCodeOf(err: string): number | null {
  const m = String(err ?? "").match(/(?:exit(?:ed with)? code|process exited with code)\s*:?\s*(-?\d+)/i);
  return m ? +m[1] : null;
}
/** Código 1 de quem usa o 1 pra dizer "não achei / diferente" (grep, rg, test, [, diff, cmp, git diff --quiet). */
export function benignExit(cmd: string, code: number | null): boolean {
  if (code !== 1) return false;
  return normLabel(cmd).split(/&&|\|\||;|\|/).some((seg) => {
    const w = seg.trim().replace(/^(!\s*)?((\w+=\S*|sudo|command|time)\s+)*/, "");
    if (/^(grep|egrep|fgrep|rg|ag|ack|test|\[\[?|diff|cmp)(\s|$)/.test(w)) return true;
    return /^git\s+diff\b/.test(w) && /--(quiet|exit-code)\b/.test(w);
  });
}
/** Não conta pro detector (e a falha não vira nota no feed): espera, polling, navegador, código 1 inofensivo. */
export function quietTool(tool: string, inp: any, err?: string, code?: number | null): boolean {
  if (POLL_TOOL.test(tool) || BROWSER_TOOL.test(tool)) return true;
  if (isShell(tool)) {
    const c = cmdOf(inp);
    if (POLL_CMD.test(c)) return true;
    if (benignExit(c, code ?? exitCodeOf(err ?? ""))) return true;
  }
  return false;
}
/** Ferramenta + entrada → { label, key, change } — null quando não conta. */
export function describeTool(tool: string, inp: any): { label: string; key: string; change: boolean } | null {
  if (!tool || SKIP_TOOL.test(tool) || POLL_TOOL.test(tool) || BROWSER_TOOL.test(tool)) return null;
  if (isShell(tool)) { const c = cmdOf(inp); if (!c || POLL_CMD.test(c)) return null; return { label: c, key: c, change: WRITE_CMD.test(c) }; }
  if (/apply_patch/i.test(tool)) { const fl = patchFiles(inp); return { label: fl || "arquivos", key: stableJson(inp), change: true }; }
  const file = fileOf(inp);
  return { label: file || str(inp?.pattern ?? inp?.url ?? inp?.query ?? "") || tool, key: stableJson(inp), change: EDIT_TOOL.test(tool) };
}

// ---------------------------------------------------------------- a regra (PURA)
export function emptyLoopState(): LoopState { return { w: {}, warn: null }; }

const toolPt = (tool: string) => {
  const n = tool.toLowerCase();
  if (isShell(tool)) return "";
  if (/edit|str_replace|apply_patch|patch|notebook/.test(n)) return "editar";
  if (/write|create/.test(n)) return "gravar";
  if (/read|view|cat/.test(n)) return "ler";
  if (/grep|glob|search|find/.test(n)) return "buscar";
  return tool;
};
/** "`npm test`" ou "editar `src/a.ts`" — a ação como a pessoa reconhece. */
export function actionPt(a: Pick<ToolAttempt, "tool" | "label">): string {
  const v = toolPt(a.tool), l = a.label.length > 90 ? a.label.slice(0, 89) + "…" : a.label;
  return v ? `${v} \`${l || a.tool}\`` : `\`${l || a.tool}\``;
}
const copyState = (s: LoopState | null | undefined): LoopState => {
  const w: Record<string, Win> = {};
  for (const [k, v] of Object.entries(s?.w ?? {})) w[k] = { hist: [...(v?.hist ?? [])], fired: v?.fired ?? null };
  return { w, warn: s?.warn ?? null };
};

/** Um passo: a tentativa entra na janela do agente; devolve se ACABOU de entrar em loop (uma vez por episódio) ou se o aviso saiu. */
export function loopStep(prev: LoopState | null | undefined, a: ToolAttempt, now = Date.now()): LoopStep {
  const st = copyState(prev);
  const wk = a.agent || "main";
  const win = (st.w[wk] = st.w[wk] ?? { hist: [], fired: null });
  const l = `${a.tool}\u0001${normLabel(a.label)}`;
  const k = `${a.tool}\u0001${normLabel(a.key || a.label)}`;
  let clear = false;
  if (a.ok) {
    // sucesso da MESMA ferramenta no mesmo alvo: as falhas dela saem da conta e o aviso daquela ação some
    win.hist = win.hist.map((h) => (h.l === l && h.f && !h.r ? { ...h, r: 1 as const } : h));
    if (win.fired && win.fired.l === l) {
      if (st.warn && st.warn.sig === win.fired.sig && (st.warn.agent || "main") === wk) { st.warn = null; clear = true; }
      win.fired = null;
    }
    // mudança de arquivo com conteúdo NOVO (a mesma gravação idêntica de novo não conta) = a IA mudou alguma coisa
    const isNew = a.change && !win.hist.some((h) => h.c && h.k === k);
    win.hist.push(isNew ? { k, l, c: 1 } : { k, l });
  } else {
    const f = `${l}\u0001${normError(a.error ?? "")}`;
    win.hist.push({ k, l, f });
    let n = 0;
    for (let i = win.hist.length - 1; i >= 0; i--) { const h = win.hist[i]; if (h.c) break; if (h.f === f && !h.r) n++; }
    if (n >= LOOP_FAIL_N && win.fired?.sig !== f) {
      win.fired = { sig: f, l };
      const what = `${actionPt(a)} falhou ${n}× com: ${errorLine(a.error ?? "") || "o mesmo erro"}`;
      const info: LoopInfo = { kind: "erro", n, what, text: `A IA está repetindo o mesmo erro (${n}×): ${what}`, sig: f, at: now, ...(a.agent ? { agent: a.agent } : {}) };
      st.warn = info;
      if (win.hist.length > HIST_MAX) win.hist = win.hist.slice(-HIST_MAX);
      return { state: st, fire: info };
    }
  }
  if (win.hist.length > HIST_MAX) win.hist = win.hist.slice(-HIST_MAX);
  return { state: st, clear };
}

/** Fim do turno: episódio cuja ação NÃO terminou na mesma falha sai (o aviso nunca fica preso). */
export function loopTurnEndStep(prev: LoopState | null | undefined): LoopStep {
  const st = copyState(prev);
  let clear = false;
  for (const [wk, win] of Object.entries(st.w)) {
    if (!win.fired) continue;
    const last = [...win.hist].reverse().find((h) => h.l === win.fired!.l);
    if (last && last.f === win.fired.sig && !last.r) continue;
    if (st.warn && st.warn.sig === win.fired.sig && (st.warn.agent || "main") === wk) { st.warn = null; clear = true; }
    win.fired = null;
  }
  if (st.warn && !Object.values(st.w).some((w) => w.fired?.sig === st.warn!.sig)) { st.warn = null; clear = true; }
  return { state: st, clear };
}

// ---------------------------------------------------------------- de onde vêm as tentativas (PURO)
/** Saída de comando do Codex ("Exit code: 1\nWall time…\nOutput:\n…" ou objeto) → falhou? com qual erro e código? */
function codexResult(r: unknown): { ok: boolean; error?: string; code?: number | null } {
  if (r && typeof r === "object") {
    const o = r as Record<string, any>;
    const code = o.exit_code ?? o.exitCode ?? o.metadata?.exit_code;
    const out = str(o.stderr || o.output || o.aggregated_output || o.formatted_output || o.error || "");
    if (typeof code === "number") return code === 0 ? { ok: true } : { ok: false, error: out, code };
    if (o.is_error === true || o.success === false || (typeof o.error === "string" && o.error)) return { ok: false, error: out || str(o.error), code: exitCodeOf(out) };
    return { ok: true };
  }
  const s = str(r);
  const c = exitCodeOf(s);
  if (c !== null) return c === 0 ? { ok: true } : { ok: false, error: s, code: c };
  return { ok: true }; // sem como saber: conta como sucesso (nunca acusa loop no escuro)
}

/** Hook do terminal (Claude Code ou Codex) → tentativa, ou null quando o evento não conta. */
export function attemptFromHook(event: string, p: Record<string, any>): ToolAttempt | null {
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return null;
  const tool = String(p.tool_name ?? "");
  const inp = p.tool_input ?? {};
  const d = describeTool(tool, inp);
  if (!d) return null;
  const agent = typeof p.agent_id === "string" && p.agent_id ? { agent: p.agent_id } : {};
  if (event === "PostToolUseFailure") {
    if (p.is_interrupt === true) return null; // Esc da pessoa não é erro da IA
    const err = str(p.error ?? "");
    if (quietTool(tool, inp, err)) return null;
    return { tool, ...d, ok: false, error: err, ...agent };
  }
  const r = p.tool_response;
  let res: { ok: boolean; error?: string; code?: number | null };
  if (r && typeof r === "object" && (r.is_error === true || r.success === false || (typeof r.error === "string" && r.error))) {
    const err = str(typeof r.error === "string" ? r.error : r.stderr ?? "");
    res = { ok: false, error: err, code: exitCodeOf(err) };
  } else res = isShell(tool) ? codexResult(r) : { ok: true };
  if (!res.ok && quietTool(tool, inp, res.error, res.code)) return null;
  return { tool, ...d, ok: res.ok, ...(res.ok ? {} : { error: res.error ?? "" }), ...agent };
}

/** stream-json do Claude Code (modo automático): tool_use guardado por id → tool_result vira tentativa. */
export function claudeAttempts(line: string, pending: Map<string, { name: string; input: unknown }>): ToolAttempt[] {
  if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return [];
  let o: any;
  try { o = JSON.parse(line); } catch { return []; }
  const content = o?.message?.content;
  if (!Array.isArray(content)) return [];
  const agent = typeof o.parent_tool_use_id === "string" && o.parent_tool_use_id ? { agent: o.parent_tool_use_id } : {};
  const out: ToolAttempt[] = [];
  for (const c of content) {
    if (c?.type === "tool_use" && c.id) { pending.set(String(c.id), { name: String(c.name ?? ""), input: c.input ?? {} }); if (pending.size > 200) pending.delete(pending.keys().next().value as string); }
    else if (c?.type === "tool_result" && c.tool_use_id) {
      const u = pending.get(String(c.tool_use_id)); pending.delete(String(c.tool_use_id));
      if (!u) continue;
      const d = describeTool(u.name, u.input);
      if (!d) continue;
      const txt = Array.isArray(c.content) ? c.content.map((x: any) => (x?.type === "text" ? str(x.text) : "")).join("\n") : str(c.content);
      if (c.is_error === true && (/interrupted by user|user (rejected|doesn't want)/i.test(txt) || quietTool(u.name, u.input, txt))) continue;
      out.push({ tool: u.name, ...d, ok: c.is_error !== true, ...(c.is_error === true ? { error: txt } : {}), ...agent });
    }
  }
  return out;
}

/** `codex exec --json` (modo automático): comando concluído (item.completed) vira tentativa pelo exit_code. */
export function codexAttempt(line: string): ToolAttempt | null {
  if (!line.includes("item.completed")) return null;
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  const it = o?.item;
  if (o?.type !== "item.completed" || !it) return null;
  const ty = String(it.type ?? "");
  if (/command/.test(ty)) {
    const inp = { command: it.command };
    const d = describeTool("shell", inp);
    if (!d) return null;
    const code = typeof it.exit_code === "number" ? it.exit_code : null;
    const failed = (code !== null && code !== 0) || it.status === "failed";
    const err = str(it.aggregated_output ?? it.output ?? "");
    if (failed && quietTool("shell", inp, err, code)) return null;
    return { tool: "shell", ...d, ok: !failed, ...(failed ? { error: err } : {}) };
  }
  if (/file_change|patch/.test(ty)) {
    const files = Array.isArray(it.changes) ? it.changes.map((c: any) => str(c?.path)).filter(Boolean).join(", ") : "arquivos";
    const failed = it.status === "failed";
    return { tool: "apply_patch", label: files, key: stableJson(it.changes ?? files), change: true, ok: !failed, ...(failed ? { error: str(it.error ?? it.message ?? "a edição não aplicou") } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------- estado por tarefa (state.sqlite, tabela loop_state)
/** Transação curta. `quick` (caminho do hook — o do Codex é síncrono): UMA tentativa com espera ≤150 ms e desiste em
 * silêncio; fora do hook, as tentativas de sempre. Nunca lança. */
function tx<T>(store: Store, quick: boolean, fn: () => T): T | null {
  const db = store.db;
  try {
    if (quick) db.exec("PRAGMA busy_timeout = 150");
    const run = () => {
      db.exec("BEGIN IMMEDIATE");
      try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* já encerrada */ } throw e; }
    };
    return quick ? run() : withBusyRetry(run);
  } catch { return null; } finally { if (quick) try { db.exec("PRAGMA busy_timeout = 8000"); } catch { /* fechado */ } }
}
function readState(store: Store, taskId: string): LoopState | null {
  const row = store.db.prepare("SELECT json FROM loop_state WHERE task_id = ?").get(taskId) as { json: string } | undefined;
  try { const s = row ? JSON.parse(row.json) : null; return s && typeof s === "object" && s.w ? s : null; } catch { return null; }
}
function writeState(store: Store, taskId: string, s: LoopState, now: number): void {
  store.db.prepare("INSERT INTO loop_state (task_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(taskId, JSON.stringify(s), now);
}
export interface LoopOpts { quick?: boolean; now?: number }

/** Registra uma tentativa da tarefa; ao entrar em loop grava o aviso e o evento 'loop' (uma vez por episódio). */
export function loopTrack(store: Store, taskId: string, a: ToolAttempt | null, o: LoopOpts = {}): LoopInfo | null {
  if (!a || !taskId) return null;
  const now = o.now ?? Date.now();
  return tx(store, !!o.quick, () => {
    const s = loopStep(readState(store, taskId), a, now);
    writeState(store, taskId, s.state, now);
    if (s.fire) store.addEvent(taskId, "Sistema", "loop", s.fire.text, false);
    return s.fire ?? null;
  });
}
/** Fim do turno (Stop/notify no terminal; fim do engine.run no automático). */
export function loopTurnEnd(store: Store, taskId: string, o: LoopOpts = {}): void {
  const now = o.now ?? Date.now();
  tx(store, !!o.quick, () => {
    const cur = readState(store, taskId);
    if (!cur) return;
    const s = loopTurnEndStep(cur);
    if (s.clear) writeState(store, taskId, s.state, now);
  });
}
/** A pessoa interveio (mensagem nova, instrução): a janela zera e o aviso some. (Parar/interromper: o app apaga a
 * mesma linha em stop_task/abort_task — lib.rs loop_clear_row.) */
export function loopReset(store: Store, taskId: string, o: LoopOpts = {}): void {
  tx(store, !!o.quick, () => { store.db.prepare("DELETE FROM loop_state WHERE task_id = ?").run(taskId); });
}
