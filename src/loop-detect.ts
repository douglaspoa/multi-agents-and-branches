// DETECTOR DE LOOP (aprovado pelo dono em 07/10): a IA repetindo o MESMO erro (mesmo comando/edição falhando com
// a mesma mensagem) gasta tokens sem avançar. Regra DETERMINÍSTICA — nenhum modelo novo:
//
//   • "em loop" = a MESMA assinatura de falha (ferramenta + comando/arquivo normalizado + erro normalizado) aparece
//     LOOP_FAIL_N (3) vezes nas últimas LOOP_WINDOW (10) tentativas, SEM um sucesso da mesma ação no meio;
//   • "loop sem erro" = a MESMA ação idêntica (ferramenta + entrada inteira) LOOP_SAME_N (4) vezes seguidas, todas
//     com sucesso (falhas ficam com a regra de cima: erros diferentes não são loop);
//   • zera quando a ação passa (sucesso do mesmo comando/arquivo) ou a pessoa intervém (mensagem, parar).
//
// Normalização (o mesmo erro com número de linha diferente = mesma assinatura): sem cores ANSI, números de
// linha/coluna, caminhos temporários, timestamps, durações, hashes/ids, números soltos.
//
// Fontes das tentativas: hooks do Claude Code (PostToolUse / PostToolUseFailure) e do Codex (PostToolUse) no modo
// terminal (src/terminal.ts → hookCli), e o stream do motor no modo automático (engine/claude.ts e codex.ts →
// RunInput.onAttempt → orchestrator). O estado mora na tabela loop_state do state.sqlite (sobrevive a reinício do
// app e funciona entre os processos de hook); o aviso ativo mora em spec.loop (o snapshot já leva pro front).
import type { Store } from "./store.ts";
import { withBusyRetry } from "./store.ts";

export const LOOP_WINDOW = 10;
export const LOOP_FAIL_N = 3;
export const LOOP_SAME_N = 4;

/** Uma tentativa de ferramenta. `key` = identidade COMPLETA (ação idêntica); `label` = comando/arquivo (a "ação"). */
export interface ToolAttempt { tool: string; label: string; key: string; ok: boolean; error?: string }
interface HistItem { k: string; l: string; f?: string; /** falha já superada por um sucesso da mesma ação */ r?: 1 }
export interface LoopEpisode { kind: "erro" | "repete"; sig: string; l: string; k?: string }
export interface LoopState { hist: HistItem[]; fired?: LoopEpisode | null }
/** O aviso que vai pro spec (spec.loop) e pro evento 'loop'. */
export interface LoopInfo { kind: "erro" | "repete"; n: number; what: string; text: string; sig: string; at: number }
export interface LoopStep { state: LoopState; fire?: LoopInfo; clear?: boolean }

// ---------------------------------------------------------------- normalização (PURA)
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s: string) => String(s ?? "").replace(ANSI, "");
const TMP_PATH = /(?:\/private)?\/(?:var\/folders|tmp|var\/tmp)\/[^\s'"`:)]*/g;

/** Comando/arquivo comparável: sem ANSI, espaços colapsados, wrapper de shell (`bash -lc '…'`) tirado, temp → <tmp>. */
export function normLabel(s: string): string {
  let t = stripAnsi(s).trim();
  const m = t.match(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (m) t = m[2];
  return t.replace(TMP_PATH, "<tmp>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Linha que melhor diz o erro (a 1ª com cara de erro; senão a 1ª não vazia), sem ANSI, cortada. */
export function errorLine(err: string): string {
  const lines = stripAnsi(err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(exit code:?\s*-?\d+|process exited with code \d+|wall time:|output:?$|command failed with exit code)/i.test(l));
  const hit = lines.find((l) => /error|cannot|can't|could not|failed|fail:|not found|no such|denied|exception|fatal|undefined|expected|missing|invalid|unexpected|refused|timed? ?out|✗|✘/i.test(l));
  return (hit ?? lines[0] ?? "").replace(/\s+/g, " ").slice(0, 200);
}

/** Mensagem de erro comparável: o mesmo erro com linha/hora/caminho temporário diferentes = a mesma string. */
export function normError(err: string): string {
  return errorLine(err)
    .replace(TMP_PATH, "<tmp>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|segundos|m|min)\b/gi, "<dur>")
    .replace(/(:\d+)+(?=[\s)\],]|$)/g, ":N")
    .replace(/\b(line|linha|ln|col|column|coluna)\s*\d+/gi, "$1 N")
    .replace(/\d+/g, "N")
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------- a regra (PURA)
export function emptyLoopState(): LoopState { return { hist: [], fired: null }; }

const toolPt = (tool: string) => {
  const n = tool.toLowerCase();
  if (/bash|shell|exec|command/.test(n)) return "";
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

/** Um passo: a tentativa nova entra na janela; devolve se ACABOU de entrar em loop (uma vez por episódio) ou se o aviso zerou. */
export function loopStep(prev: LoopState | null | undefined, a: ToolAttempt, now = Date.now()): LoopStep {
  const st: LoopState = { hist: [...(prev?.hist ?? [])], fired: prev?.fired ?? null };
  const l = `${a.tool}\u0001${normLabel(a.label)}`;
  const k = `${a.tool}\u0001${normLabel(a.key || a.label)}`;
  let clear = false;
  if (a.ok) {
    // sucesso da MESMA ação: as falhas dela saem da janela (o "sucesso no meio zera")
    st.hist = st.hist.map((h) => (h.l === l && h.f && !h.r ? { ...h, r: 1 as const } : h));
    if (st.fired?.kind === "erro" && st.fired.l === l) { st.fired = null; clear = true; }
  }
  const f = a.ok ? undefined : `${l}\u0001${normError(a.error ?? "")}`;
  st.hist.push(f ? { k, l, f } : { k, l });
  if (st.hist.length > LOOP_WINDOW) st.hist = st.hist.slice(-LOOP_WINDOW);
  // "loop sem erro" acabou: a IA fez OUTRA coisa
  if (st.fired?.kind === "repete" && st.fired.k !== k) { st.fired = null; clear = true; }

  if (f) {
    const n = st.hist.filter((h) => h.f === f && !h.r).length;
    if (n >= LOOP_FAIL_N && st.fired?.sig !== f) {
      st.fired = { kind: "erro", sig: f, l };
      const what = `${actionPt(a)} falhou ${n}× com: ${errorLine(a.error ?? "") || "o mesmo erro"}`;
      return { state: st, clear: false, fire: { kind: "erro", n, what, text: `A IA está repetindo o mesmo erro (${n}×): ${what}`, sig: f, at: now } };
    }
  }
  const tail = st.hist.slice(-LOOP_SAME_N);
  const same = `rep\u0001${k}`;
  if (tail.length === LOOP_SAME_N && tail.every((h) => h.k === k && !h.f) && st.fired?.sig !== same && st.fired?.kind !== "erro") {
    st.fired = { kind: "repete", sig: same, l, k };
    const what = `${actionPt(a)} ${LOOP_SAME_N}× seguidas, sem mudar nada no meio`;
    return { state: st, clear: false, fire: { kind: "repete", n: LOOP_SAME_N, what, text: `A IA está repetindo a mesma ação (${LOOP_SAME_N}×): ${what}`, sig: same, at: now } };
  }
  return { state: st, clear };
}

// ---------------------------------------------------------------- de onde vêm as tentativas (PURO)
/** Ferramentas do próprio Starfork/coordenação não contam (perguntar, plano, reivindicar…). */
const SKIP_TOOL = /^(mcp__cardume__|mcp__starfork__)|^(AskUserQuestion|TodoWrite|ExitPlanMode|Task|Agent)$/;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const cmdOf = (inp: any): string => (Array.isArray(inp?.command) ? inp.command.join(" ") : str(inp?.command ?? inp?.cmd ?? ""));
const fileOf = (inp: any): string => str(inp?.file_path ?? inp?.path ?? inp?.notebook_path ?? inp?.filename ?? "");
function patchFiles(inp: unknown): string {
  const t = typeof inp === "string" ? inp : str((inp as any)?.input ?? (inp as any)?.patch ?? (inp as any)?.command ?? "");
  return [...t.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim()).join(", ");
}
/** Ferramenta + entrada → { label, key } (comando/arquivo; identidade = a entrada inteira, ordenada). */
export function describeTool(tool: string, inp: any): { label: string; key: string } | null {
  if (!tool || SKIP_TOOL.test(tool)) return null;
  const n = tool.toLowerCase();
  const stable = (o: unknown) => { try { return JSON.stringify(o, Object.keys(o && typeof o === "object" ? o : {}).sort()); } catch { return str(o); } };
  if (/bash|shell|exec_command|local_shell/.test(n)) { const c = cmdOf(inp); return c ? { label: c, key: c } : null; }
  if (/apply_patch/.test(n)) { const fl = patchFiles(inp); return { label: fl || "arquivos", key: str(inp?.input ?? inp?.patch ?? inp?.command ?? inp) }; }
  const file = fileOf(inp);
  const label = file || str(inp?.pattern ?? inp?.url ?? inp?.query ?? "") || tool;
  return { label, key: stable(inp) };
}

/** Saída de comando do Codex ("Exit code: 1\nWall time…\nOutput:\n…" ou objeto) → falhou? com qual erro? */
function codexResult(r: unknown): { ok: boolean; error?: string } {
  if (r && typeof r === "object") {
    const o = r as Record<string, any>;
    const code = o.exit_code ?? o.exitCode ?? o.metadata?.exit_code;
    const out = str(o.stderr || o.output || o.aggregated_output || o.formatted_output || o.error || "");
    if (o.is_error === true || o.success === false || (typeof o.error === "string" && o.error)) return { ok: false, error: out || str(o.error) };
    if (typeof code === "number") return code === 0 ? { ok: true } : { ok: false, error: out };
    return { ok: true };
  }
  const s = str(r);
  const m = s.match(/(?:^|\n)\s*(?:Exit code:|Process exited with code)\s*(-?\d+)/i);
  if (m) return +m[1] === 0 ? { ok: true } : { ok: false, error: s };
  return { ok: true }; // sem como saber: conta como sucesso (nunca acusa loop no escuro)
}

/** Hook do terminal (Claude Code ou Codex) → tentativa, ou null quando o evento não é resultado de ferramenta. */
export function attemptFromHook(event: string, p: Record<string, any>): ToolAttempt | null {
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return null;
  const tool = String(p.tool_name ?? "");
  const d = describeTool(tool, p.tool_input ?? {});
  if (!d) return null;
  if (event === "PostToolUseFailure") {
    if (p.is_interrupt === true) return null; // Esc da pessoa não é erro da IA
    return { tool, ...d, ok: false, error: str(p.error ?? "") };
  }
  const r = p.tool_response;
  if (r && typeof r === "object" && (r.is_error === true || r.success === false || (typeof r.error === "string" && r.error)))
    return { tool, ...d, ok: false, error: str(typeof r.error === "string" ? r.error : r.stderr ?? "") };
  if (/bash|shell|exec/i.test(tool)) return { tool, ...d, ...codexResult(r) };
  return { tool, ...d, ok: true };
}

/** stream-json do Claude Code (modo automático): tool_use guardado por id → tool_result vira tentativa. */
export function claudeAttempts(line: string, pending: Map<string, { name: string; input: unknown }>): ToolAttempt[] {
  if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return [];
  let o: any;
  try { o = JSON.parse(line); } catch { return []; }
  const content = o?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolAttempt[] = [];
  for (const c of content) {
    if (c?.type === "tool_use" && c.id) { pending.set(String(c.id), { name: String(c.name ?? ""), input: c.input ?? {} }); if (pending.size > 200) pending.delete(pending.keys().next().value as string); }
    else if (c?.type === "tool_result" && c.tool_use_id) {
      const u = pending.get(String(c.tool_use_id)); pending.delete(String(c.tool_use_id));
      if (!u) continue;
      const d = describeTool(u.name, u.input);
      if (!d) continue;
      const txt = Array.isArray(c.content) ? c.content.map((x: any) => (x?.type === "text" ? str(x.text) : "")).join("\n") : str(c.content);
      if (c.is_error === true && /interrupted by user|user (rejected|doesn't want)/i.test(txt)) continue;
      out.push({ tool: u.name, ...d, ok: c.is_error !== true, ...(c.is_error === true ? { error: txt } : {}) });
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
    const d = describeTool("shell", { command: it.command });
    if (!d) return null;
    const code = it.exit_code;
    const failed = (typeof code === "number" && code !== 0) || it.status === "failed";
    return { tool: "shell", ...d, ok: !failed, ...(failed ? { error: str(it.aggregated_output ?? it.output ?? "") } : {}) };
  }
  if (/file_change|patch/.test(ty) && it.status === "failed") {
    const files = Array.isArray(it.changes) ? it.changes.map((c: any) => str(c?.path)).filter(Boolean).join(", ") : "arquivos";
    return { tool: "apply_patch", label: files, key: files, ok: false, error: str(it.error ?? it.message ?? "a edição não aplicou") };
  }
  return null;
}

// ---------------------------------------------------------------- estado por tarefa (state.sqlite)
/** Ajustes › Como as tarefas rodam › "Pausar a tarefa quando a IA repetir o mesmo erro" — quem pausa é o app
 * (60/10-core: o mesmo stop_task do Parar), que vê o aviso no snapshot; o motor só detecta e avisa. */
function ensureTable(store: Store): void {
  store.db.exec("CREATE TABLE IF NOT EXISTS loop_state (task_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
}

/** Registra uma tentativa da tarefa: grava o estado e, ao entrar em loop, o evento 'loop' (uma vez) + spec.loop. */
export function loopTrack(store: Store, taskId: string, a: ToolAttempt | null, now = Date.now()): LoopInfo | null {
  if (!a || !taskId) return null;
  try {
    ensureTable(store);
    const r = withBusyRetry(() => {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const row = store.db.prepare("SELECT json FROM loop_state WHERE task_id = ?").get(taskId) as { json: string } | undefined;
        let prev: LoopState | null = null;
        try { prev = row ? JSON.parse(row.json) : null; } catch { /* estado ilegível: recomeça */ }
        const s = loopStep(prev, a, now);
        store.db.prepare("INSERT INTO loop_state (task_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(taskId, JSON.stringify(s.state), now);
        store.db.exec("COMMIT");
        return s;
      } catch (e) {
        try { store.db.exec("ROLLBACK"); } catch { /* já encerrada */ }
        throw e;
      }
    });
    if (r.fire) {
      store.addEvent(taskId, "Sistema", "loop", r.fire.text, false);
      store.patchSpec(taskId, { loop: r.fire });
      return r.fire;
    }
    if (r.clear) store.patchSpec(taskId, { loop: undefined });
  } catch { /* o detector nunca derruba o hook nem o turno */ }
  return null;
}

/** A pessoa interveio (mensagem nova, parar): a janela zera e o aviso some. */
export function loopReset(store: Store, taskId: string): void {
  try {
    ensureTable(store);
    store.db.prepare("DELETE FROM loop_state WHERE task_id = ?").run(taskId);
    const t = store.getTask(taskId);
    if (t && /"loop"\s*:/.test(t.spec_json)) store.patchSpec(taskId, { loop: undefined });
  } catch { /* melhor-esforço */ }
}
