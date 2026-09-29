// Edições de SPEC feitas por um agente (a ideia muda conforme se programa):
//  - tarefa: objetivo, título, requisitos, entregáveis, escopo (owns/off) de uma tarefa do MESMO projeto
//    (irmã do épico, rascunho, ou a própria). NUNCA inicia/retoma/conversa com o agente dela: grava no
//    banco + TASK.yaml; se ela está rodando, a mudança vira uma instrução que o agente recebe no PRÓXIMO
//    turno (fila de instruções — não interrompe).
//  - épico: descrição, outcome, requisitos, "pronto quando". O épico mora na NUVEM e o motor não tem sessão:
//    a edição vai pra .cardume/agent-edits/epic-<id>.jsonl e o APP (que tem a sessão) aplica via PATCH em
//    epics.spec, idempotente pelo id da edição. A cópia local do "pronto quando" é aplicada direto e depois
//    sincronizada com a da nuvem (syncEpicDoneWhen, chamado pelo app).
//  - cartão da nuvem que não existe neste banco (irmã ainda no backlog do time): mesma fila, card-<id>.jsonl.
// REGRA DE PRODUTO: acrescentar/reescrever vale na hora; REMOVER requisito ou item do "pronto quando" e
// ESTREITAR owns/off vira PROPOSTA que o humano aprova ou recusa (o agente não derruba o requisito que está
// falhando). Só planner/builder editam (o revisor julga a spec, não a reescreve).
// Todo edit deixa RASTRO: quem (agente + tarefa), quando, o quê (antes → depois) e o porquê (note).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { TaskRow, TaskSpec } from "./types.ts";
import { taskToYaml } from "./util/yaml.ts";
import { looksSecret } from "./memory.ts";

export const EDIT_LIMITS = {
  title: 140,
  objective: 2000,
  item: 300, // requisito, entregável, item do "pronto quando"
  items: 30, // máximo de itens numa lista
  path: 200,
  note: 300,
  description: 2000,
  trail: 10, // edições mostradas (vão resumidas no snapshot do app)
  ids: 300, // ids já aplicados (idempotência) — separado do rastro, não é despejado junto
  proposals: 20,
};

/** Tarefa fechada: a spec não muda mais (a entrega já foi julgada). */
export const CLOSED_ST = new Set(["merged", "done"]);
/** Status em que um turno do agente pode estar rodando agora. */
const LIVE_ST = new Set(["running", "queued", "thinking"]);
/** Papéis de agente que podem mudar spec. Sem papel = humano/app (CLI). */
export const EDIT_ROLES = new Set(["planner", "builder"]);

export interface EditAuthor {
  agent: string;
  taskId?: string;
  taskTitle?: string;
  /** papel do agente (MCP: CARDUME_ROLE). Vazio = humano/app. */
  role?: string;
}
export interface TaskEditInput {
  title?: string;
  objective?: string;
  reqAdd?: string[];
  /** TEXTO dos requisitos a remover (chave estável, nunca posição) — vira proposta */
  reqRemove?: string[];
  deliverables?: string[]; // substitui a lista
  delivAdd?: string[];
  owns?: string[]; // lista desejada: o que entra aplica; o que sai vira proposta
  off?: string[];
  note?: string;
}
export interface EpicEditInput {
  description?: string;
  outcome?: string;
  doneWhenAdd?: string[];
  /** ids ("D3") do "pronto quando" — vira proposta (o app mostra aprovar/recusar) */
  doneWhenRemove?: string[];
  reqAdd?: string[];
  note?: string;
}
export type Field = "title" | "objective" | "requirements" | "deliverables" | "owns" | "off" | "epicDoneWhen";
export interface FieldChange {
  field: Field;
  before: string | string[];
  after: string | string[];
}
/** Uma edição guardada em spec.agentEdits da tarefa editada (o app mostra antes/depois e oferece desfazer). */
export interface AgentEditRecord {
  id: string;
  at: string;
  by: string;
  byTask?: string;
  byTitle?: string;
  changes: FieldChange[];
  note?: string;
  delivered: "direct" | "queued" | "self";
  /** instrução enfileirada pro agente da tarefa (desfazer a cancela se ainda não foi entregue) */
  instructionId?: number;
  approvedBy?: string;
  undone?: { at: string; by: string };
}
/** Remoção proposta por um agente: só vale quando o humano aprova. */
export interface AgentProposal {
  id: string;
  at: string;
  by: string;
  byTask?: string;
  byTitle?: string;
  remove: { requirements?: string[]; owns?: string[]; off?: string[] };
  note?: string;
  status: "open" | "approved" | "rejected";
  decided?: { at: string; by: string; msg?: string };
}
export type EditMode = "applied" | "queued" | "proposed" | "pending" | "unchanged";
export type EditResult =
  | { ok: true; mode: EditMode; id?: string; proposalId?: string; message: string }
  | { ok: false; message: string };

const FIELD_PT: Record<Field, string> = {
  title: "o título",
  objective: "o objetivo",
  requirements: "os requisitos",
  deliverables: "os entregáveis",
  owns: "o escopo (owns)",
  off: "as áreas proibidas (off)",
  epicDoneWhen: "o \"pronto quando\" do épico",
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const cleanList = (a: unknown) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []);
const norm = (s: string) => clean(s).toLowerCase();
const short = (v: string | string[], n = 90) => {
  const s = Array.isArray(v) ? (v.length ? v.join("; ") : "(vazio)") : v || "(vazio)";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const isStrArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Papel pode editar spec? Devolve a recusa (pt-BR) ou null. */
export function roleBlock(by: EditAuthor): string | null {
  if (!by.role || EDIT_ROLES.has(by.role)) return null;
  return by.role === "reviewer"
    ? "o papel revisor não muda spec — ele julga a entrega contra a spec. Registre a divergência no parecer."
    : `o papel ${by.role} não muda spec — só planner/builder`;
}

/** Valida FORMATO de uma edição vinda de fora (--patch do app, linha da fila). Erro pt-BR ou null. */
export function checkTaskShape(i: unknown): string | null {
  if (!i || typeof i !== "object" || Array.isArray(i)) return "edição inválida (esperava um objeto)";
  const o = i as Record<string, unknown>;
  for (const k of ["title", "objective", "note"]) if (o[k] !== undefined && typeof o[k] !== "string") return `${k} precisa ser texto`;
  for (const k of ["reqAdd", "reqRemove", "deliverables", "delivAdd", "owns", "off"]) if (o[k] !== undefined && !isStrArr(o[k])) return `${k} precisa ser uma lista de textos`;
  return null;
}
export function checkEpicShape(i: unknown): string | null {
  if (!i || typeof i !== "object" || Array.isArray(i)) return "edição inválida (esperava um objeto)";
  const o = i as Record<string, unknown>;
  for (const k of ["description", "outcome", "note"]) if (o[k] !== undefined && typeof o[k] !== "string") return `${k} precisa ser texto`;
  for (const k of ["doneWhenAdd", "doneWhenRemove", "reqAdd"]) if (o[k] !== undefined && !isStrArr(o[k])) return `${k} precisa ser uma lista de textos`;
  return null;
}

/** Valida textos: tamanho e segredo. Devolve a mensagem de erro (pt-BR) ou null. */
function checkTexts(pairs: [string, unknown, number][]): string | null {
  for (const [label, v, max] of pairs) {
    const vals = Array.isArray(v) ? v : v === undefined ? [] : [v];
    if (Array.isArray(v) && v.length > EDIT_LIMITS.items) return `${label}: no máximo ${EDIT_LIMITS.items} itens`;
    for (const x of vals) {
      const s = clean(x);
      if (s.length > max) return `${label} longo demais (máx. ${max} caracteres)`;
      if (looksSecret(s)) return `${label} parece conter um segredo (chave/token/senha) — não gravo isso na spec`;
    }
  }
  return null;
}

export function validateTaskEdit(i: TaskEditInput): string | null {
  const shape = checkTaskShape(i);
  if (shape) return shape;
  const has =
    i.title !== undefined || i.objective !== undefined || i.reqAdd?.length || i.reqRemove?.length ||
    i.deliverables !== undefined || i.delivAdd?.length || i.owns !== undefined || i.off !== undefined;
  if (!has) return "nada a mudar — passe ao menos um campo (objetivo, título, requisitos, entregáveis, owns/off)";
  if (i.title !== undefined && !clean(i.title)) return "título vazio";
  if (i.objective !== undefined && !clean(i.objective)) return "objetivo vazio";
  if (!clean(i.note)) return "diga o PORQUÊ da mudança (note/--note) — fica no rastro que o humano lê";
  return checkTexts([
    ["título", i.title, EDIT_LIMITS.title],
    ["objetivo", i.objective, EDIT_LIMITS.objective],
    ["requisito", i.reqAdd, EDIT_LIMITS.item],
    ["requisito", i.reqRemove, EDIT_LIMITS.item],
    ["entregável", i.deliverables, EDIT_LIMITS.item],
    ["entregável", i.delivAdd, EDIT_LIMITS.item],
    ["owns", i.owns, EDIT_LIMITS.path],
    ["off", i.off, EDIT_LIMITS.path],
    ["motivo", i.note, EDIT_LIMITS.note],
  ]);
}

export function validateEpicEdit(i: EpicEditInput): string | null {
  const shape = checkEpicShape(i);
  if (shape) return shape;
  const has = i.description !== undefined || i.outcome !== undefined || i.doneWhenAdd?.length || i.doneWhenRemove?.length || i.reqAdd?.length;
  if (!has) return "nada a mudar — passe ao menos um campo (descrição, outcome, pronto quando, requisitos)";
  if (!clean(i.note)) return "diga o PORQUÊ da mudança (note/--note) — fica no histórico do épico";
  for (const id of i.doneWhenRemove ?? []) if (!/^D\d+$/i.test(clean(id))) return `id inválido no "pronto quando": ${id} (use D1, D2…)`;
  return checkTexts([
    ["descrição", i.description, EDIT_LIMITS.description],
    ["outcome", i.outcome, EDIT_LIMITS.description],
    ["pronto quando", i.doneWhenAdd, EDIT_LIMITS.item],
    ["requisito", i.reqAdd, EDIT_LIMITS.item],
    ["motivo", i.note, EDIT_LIMITS.note],
  ]);
}

/**
 * PURA: aplica a edição na spec. Acrescentar/reescrever entra em `changes`; remoções (requisitos por TEXTO,
 * itens que saem de owns/off) voltam em `remove` pra virar proposta — nunca são aplicadas aqui.
 */
export function applyTaskEdit(spec: TaskSpec, i: TaskEditInput): { spec: TaskSpec; changes: FieldChange[]; remove: AgentProposal["remove"] } {
  const s: TaskSpec = JSON.parse(JSON.stringify(spec));
  s.scope ??= { owns: [], offLimits: [] };
  const changes: FieldChange[] = [];
  const remove: AgentProposal["remove"] = {};
  const setStr = (field: "title" | "objective", v?: string) => {
    if (v === undefined) return;
    const nv = clean(v), before = String(s[field] ?? "");
    if (nv && nv !== before) { changes.push({ field, before, after: nv }); s[field] = nv; }
  };
  const setList = (field: Field, before: string[], after: string[], put: (x: string[]) => void) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({ field, before: [...before], after: [...after] });
    put(after);
  };
  setStr("title", i.title);
  setStr("objective", i.objective);
  const reqs = [...(s.requirements ?? [])];
  if (i.reqAdd?.length) {
    const next = [...reqs];
    for (const r of cleanList(i.reqAdd)) if (!next.some((x) => norm(x) === norm(r))) next.push(r);
    setList("requirements", reqs, next, (x) => { s.requirements = x; });
  }
  if (i.reqRemove?.length) {
    const hit = reqs.filter((r) => cleanList(i.reqRemove).some((x) => norm(x) === norm(r)));
    if (hit.length) remove.requirements = hit;
  }
  if (i.deliverables !== undefined || i.delivAdd?.length) {
    const before = [...(s.deliverables ?? [])];
    const next = i.deliverables !== undefined ? cleanList(i.deliverables) : [...before];
    for (const d of cleanList(i.delivAdd)) if (!next.some((x) => norm(x) === norm(d))) next.push(d);
    setList("deliverables", before, next, (x) => { s.deliverables = x; });
  }
  const scopeList = (field: "owns" | "off", want: string[] | undefined, cur: string[], put: (x: string[]) => void) => {
    if (want === undefined) return;
    const w = cleanList(want);
    const add = w.filter((x) => !cur.includes(x)), out = cur.filter((x) => !w.includes(x));
    if (add.length) setList(field, cur, [...cur, ...add], put); // ampliar vale na hora
    if (out.length) remove[field] = out; // estreitar é proposta
  };
  scopeList("owns", i.owns, [...(s.scope.owns ?? [])], (x) => { s.scope.owns = x; });
  scopeList("off", i.off, [...(s.scope.offLimits ?? [])], (x) => { s.scope.offLimits = x; });
  return { spec: s, changes, remove };
}

/** PURA: frase curta do que mudou ("o objetivo: A → B; os requisitos: + x"). */
export function changesSummary(changes: FieldChange[]): string {
  return changes
    .map((c) => {
      if (Array.isArray(c.before) && Array.isArray(c.after)) {
        const b = c.before, a = c.after;
        const add = a.filter((x) => !b.includes(x)), rem = b.filter((x) => !a.includes(x));
        const parts = [...add.map((x) => `+ ${short(x, 70)}`), ...rem.map((x) => `− ${short(x, 70)}`)];
        return `${FIELD_PT[c.field]}: ${parts.join("; ") || "reordenados"}`;
      }
      return `${FIELD_PT[c.field]}: "${short(c.before, 60)}" → "${short(c.after, 90)}"`;
    })
    .join(" · ");
}
export function removeSummary(r: AgentProposal["remove"]): string {
  return [
    ...(r.requirements ?? []).map((x) => `requisito "${short(x, 70)}"`),
    ...(r.owns ?? []).map((x) => `owns ${x}`),
    ...(r.off ?? []).map((x) => `off ${x}`),
  ].join("; ");
}

function writeYaml(task: TaskRow, spec: TaskSpec): void {
  // só reescreve se a worktree existe (rascunho/rodando/em revisão); mergeada já não tem worktree
  const dir = join(task.worktree, ".cardume");
  if (!task.worktree || !existsSync(dir)) return;
  try { writeFileSync(join(dir, "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree sumiu */ }
}

function pidLive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/** A tarefa tem um turno do agente rodando agora? (status ativo OU lock de turno vivo) */
export function taskIsLive(store: Store, t: TaskRow): boolean {
  return LIVE_ST.has(t.status) || pidLive(store.busyPid(t.id));
}

function authorLabel(by: EditAuthor): string {
  return by.taskTitle || by.taskId ? `${by.agent} (tarefa ${by.taskTitle || by.taskId})` : by.agent;
}

/** Spec da tarefa; null = JSON ilegível (recusa em vez de gravar por cima de uma spec que não entendemos). */
function specOf(t: TaskRow): TaskSpec | null {
  try {
    const s = JSON.parse(t.spec_json);
    return s && typeof s === "object" && !Array.isArray(s) ? (s as TaskSpec) : null;
  } catch { return null; }
}

/** Grava spec + colunas + TASK.yaml e o id na lista de idempotência. */
function saveSpec(store: Store, t: TaskRow, s: TaskSpec): void {
  store.updateSpec(t.id, JSON.stringify(s));
  store.setTitleObjective(t.id, s.title, s.objective);
  writeYaml(t, s);
}
function rememberId(s: TaskSpec, id: string): void {
  s.agentEditIds = [...(s.agentEditIds ?? []).filter((x) => x !== id), id].slice(-EDIT_LIMITS.ids);
}

/** Pasta da fila de edições que o app aplica na nuvem. */
export function editsDir(cardumeDir: string): string {
  return join(cardumeDir, "agent-edits");
}

/** Chave de conteúdo: o mesmo pedido repetido (agente re-tentou) não vira duas linhas. */
function contentKey(obj: unknown): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(obj)) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export interface PendingEdit {
  id: string;
  key: string;
  kind: "epic" | "card";
  target: string;
  epicId?: string;
  at: string;
  by: EditAuthor;
  epic?: EpicEditInput;
  task?: TaskEditInput;
  note?: string;
}

/** Trava exclusiva (arquivo .lock criado com O_EXCL) em volta de ler-checar-gravar a fila. */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, ".lock");
  const t0 = Date.now();
  for (;;) {
    try { closeSync(openSync(lock, "wx")); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { unlinkSync(lock); continue; } } catch { continue; } // trava órfã
      if (Date.now() - t0 > 5_000) throw new Error("fila de edições ocupada — tente de novo");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* já saiu */ } }
}

/** Ids já tratados pelo app (ledger applied.jsonl). */
export function ledgerIds(cardumeDir: string): Set<string> {
  const f = join(editsDir(cardumeDir), "applied.jsonl");
  const out = new Set<string>();
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, "utf8").split("\n")) { try { const o = JSON.parse(l); if (o?.id) out.add(String(o.id)); } catch { /* */ } }
  return out;
}

/** Grava a edição na fila de arquivo. Dedup SÓ contra linhas ainda pendentes (já tratada = pedido novo). */
export function appendPending(cardumeDir: string, e: Omit<PendingEdit, "id" | "key" | "at">): { id: string; dup: boolean } {
  const dir = editsDir(cardumeDir);
  mkdirSync(dir, { recursive: true });
  const safe = e.target.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const file = join(dir, `${e.kind}-${safe}.jsonl`);
  const key = contentKey({ k: e.kind, t: e.target, b: e.by.taskId ?? e.by.agent, x: e.epic ?? e.task });
  return withLock(dir, () => {
    if (existsSync(file)) {
      const done = ledgerIds(cardumeDir);
      for (const l of readFileSync(file, "utf8").split("\n")) {
        try { const o = JSON.parse(l) as PendingEdit; if (o.key === key && !done.has(o.id)) return { id: o.id, dup: true }; } catch { /* linha parcial */ }
      }
    }
    const row: PendingEdit = { id: randomUUID(), key, at: new Date().toISOString(), ...e };
    appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return { id: row.id, dup: false };
  });
}

/** Recado pro agente da tarefa no PRÓXIMO turno (só se ele está rodando; parado lê o TASK.yaml ao voltar). */
function tellIfLive(store: Store, t: TaskRow, text: string): number | undefined {
  return taskIsLive(store, t) ? store.addInstruction(t.id, text) : undefined;
}

/**
 * Edita a spec de uma tarefa do projeto SEM rodar o agente dela.
 * `epicId` = épico de quem pede (tarefa fora deste banco só vira pendência se o autor está num épico).
 * `editId` = id vindo da fila do app (idempotência: aplicado uma vez só).
 */
export function editTask(opts: {
  store: Store;
  cardumeDir: string;
  targetId: string;
  input: TaskEditInput;
  by: EditAuthor;
  epicId?: string;
  editId?: string;
}): EditResult {
  const { store, cardumeDir, input, by } = opts;
  const targetId = clean(opts.targetId);
  if (!targetId) return { ok: false, message: "diga QUAL tarefa editar (id)" };
  const rb = roleBlock(by);
  if (rb) return { ok: false, message: rb };
  const bad = validateTaskEdit(input);
  if (bad) return { ok: false, message: bad };
  const note = clean(input.note);
  const t = store.getTask(targetId);
  if (!t) {
    // irmã que ainda está no backlog do time (só na nuvem): fila pro app aplicar no cartão
    if (!opts.epicId) return { ok: false, message: `tarefa ${targetId} não encontrada neste projeto` };
    const { id, dup } = appendPending(cardumeDir, { kind: "card", target: targetId, epicId: opts.epicId, by, task: { ...input, note } });
    if (by.taskId && !dup) store.addEvent(by.taskId, by.agent, "note", `tarefa atualizada (cartão ${targetId}, aplicação pelo app): ${note}`, true);
    return {
      ok: true, mode: "pending", id,
      message: dup
        ? `essa mesma edição já estava registrada (${id}) — o app aplica no cartão do time`
        : `edição registrada (${id}): a tarefa ${targetId} não está neste computador, então o app aplica no cartão do time assim que sincronizar. O agente dela NÃO foi acionado. Remoções viram proposta pro humano.`,
    };
  }
  if (CLOSED_ST.has(t.status)) {
    return { ok: false, message: `a tarefa "${t.title}" já está ${t.status === "merged" ? "mergeada" : "concluída"} — a spec dela não muda mais. Se a ideia mudou, proponha uma tarefa nova ao humano.` };
  }
  const spec = specOf(t);
  if (!spec) return { ok: false, message: `a spec da tarefa "${t.title}" está ilegível — não gravo por cima; peça ao humano pra conferir` };
  if (opts.editId && (spec.agentEditIds ?? []).includes(opts.editId)) return { ok: true, mode: "unchanged", id: opts.editId, message: "essa edição já tinha sido aplicada" };
  const { spec: next, changes, remove } = applyTaskEdit(spec, input);
  const hasRemove = !!(remove.requirements?.length || remove.owns?.length || remove.off?.length);
  if (!changes.length && !hasRemove) {
    if (opts.editId) { rememberId(next, opts.editId); store.updateSpec(t.id, JSON.stringify(next)); }
    return { ok: true, mode: "unchanged", message: `nada mudou — a tarefa "${t.title}" já estava assim` };
  }
  const self = !!by.taskId && by.taskId === t.id;
  const live = !self && taskIsLive(store, t);
  const recId = opts.editId ?? randomUUID();
  const msgs: string[] = [];
  let mode: EditMode = "proposed";
  if (changes.length) {
    const what = changesSummary(changes);
    const instructionId = live
      ? store.addInstruction(t.id, `${authorLabel(by)} ATUALIZOU a spec desta tarefa (sem parar o seu trabalho): ${what}. Motivo: ${note}. O .cardume/TASK.yaml já está atualizado — releia e ajuste o que estiver fazendo; não desfaça a mudança.`)
      : undefined;
    const rec: AgentEditRecord = {
      id: recId, at: new Date().toISOString(), by: by.agent, byTask: by.taskId, byTitle: by.taskTitle,
      changes, note, delivered: self ? "self" : live ? "queued" : "direct", instructionId,
    };
    next.agentEdits = [...(spec.agentEdits ?? []), rec].slice(-EDIT_LIMITS.trail);
    const tail = live ? " (vai pro agente dela no próximo turno, sem interromper)" : "";
    store.addEvent(t.id, by.agent, "spec-edit", `${self ? by.agent : authorLabel(by)} atualizou ${self ? "a própria spec" : "esta tarefa"}: ${what} — motivo: ${note}${tail} · edição ${rec.id}`, true);
    if (by.taskId && !self) store.addEvent(by.taskId, by.agent, "note", `tarefa atualizada ("${next.title}"): ${what}`, true);
    mode = live ? "queued" : "applied";
    msgs.push(`tarefa "${next.title}" atualizada (${what}).` + (live ? " Ela está rodando: a mudança chega ao agente dela no PRÓXIMO turno, sem interromper." : self ? "" : " O agente dela NÃO foi acionado."));
  }
  let proposalId: string | undefined;
  if (hasRemove) {
    const p: AgentProposal = { id: changes.length ? randomUUID() : recId, at: new Date().toISOString(), by: by.agent, byTask: by.taskId, byTitle: by.taskTitle, remove, note, status: "open" };
    proposalId = p.id;
    next.agentProposals = [...(spec.agentProposals ?? []).filter((x) => x.status === "open" || x.id !== p.id), p].slice(-EDIT_LIMITS.proposals);
    store.addEvent(t.id, by.agent, "spec-proposal", `${self ? by.agent : authorLabel(by)} propõe remover ${self ? "da própria spec" : "desta tarefa"}: ${removeSummary(remove)} — motivo: ${note} · proposta ${p.id}`, true);
    msgs.push(`remoção virou PROPOSTA pro humano (${removeSummary(remove)}) — só vale se ele aprovar; até lá, siga cumprindo esses itens.`);
  }
  if (opts.editId) rememberId(next, opts.editId);
  saveSpec(store, t, next);
  return { ok: true, mode, id: changes.length ? recId : undefined, proposalId, message: msgs.join(" ") };
}

/** O humano decide uma proposta de remoção (aprovar aplica como edição normal, desfazível). */
export function decideProposal(opts: { store: Store; targetId: string; proposalId: string; approve: boolean; by: EditAuthor; msg?: string }): EditResult {
  const { store, by } = opts;
  const t = store.getTask(clean(opts.targetId));
  if (!t) return { ok: false, message: `tarefa ${opts.targetId} não encontrada` };
  const spec = specOf(t);
  if (!spec) return { ok: false, message: "spec ilegível" };
  const p = (spec.agentProposals ?? []).find((x) => x.id === opts.proposalId);
  if (!p) return { ok: false, message: "proposta não encontrada nesta tarefa" };
  if (p.status !== "open") return { ok: true, mode: "unchanged", message: `essa proposta já foi ${p.status === "approved" ? "aprovada" : "recusada"}` };
  const now = new Date().toISOString();
  const s: TaskSpec = JSON.parse(JSON.stringify(spec));
  const setP = (status: AgentProposal["status"], msg?: string) => {
    s.agentProposals = (s.agentProposals ?? []).map((x) => (x.id === p.id ? { ...x, status, decided: { at: now, by: by.agent, msg } } : x));
  };
  if (!opts.approve || CLOSED_ST.has(t.status)) {
    const why = CLOSED_ST.has(t.status) ? "a tarefa já foi concluída" : clean(opts.msg) || undefined;
    setP("rejected", why);
    saveSpec(store, t, s);
    store.addEvent(t.id, by.agent, "note", `proposta recusada: remover ${removeSummary(p.remove)}${why ? " — " + why : ""}`, true);
    if (p.byTask && p.byTask !== t.id) { const a = store.getTask(p.byTask); if (a) { store.addEvent(a.id, by.agent, "note", `sua proposta pra "${t.title}" foi recusada: ${removeSummary(p.remove)}`, true); tellIfLive(store, a, `${by.agent} RECUSOU sua proposta de remover ${removeSummary(p.remove)} da tarefa "${t.title}". Siga cumprindo esses itens.`); } }
    return { ok: true, mode: "applied", message: "proposta recusada" };
  }
  s.scope ??= { owns: [], offLimits: [] };
  const changes: FieldChange[] = [];
  const drop = (field: Field, cur: string[], out: string[] | undefined, put: (x: string[]) => void) => {
    if (!out?.length) return;
    const after = cur.filter((x) => !out.some((o) => norm(o) === norm(x)));
    if (after.length !== cur.length) { changes.push({ field, before: [...cur], after }); put(after); }
  };
  drop("requirements", [...(s.requirements ?? [])], p.remove.requirements, (x) => { s.requirements = x; });
  drop("owns", [...(s.scope.owns ?? [])], p.remove.owns, (x) => { s.scope.owns = x; });
  drop("off", [...(s.scope.offLimits ?? [])], p.remove.off, (x) => { s.scope.offLimits = x; });
  if (!changes.length) {
    setP("rejected", "os itens já não existem");
    saveSpec(store, t, s);
    return { ok: true, mode: "unchanged", message: "nada a remover — os itens já não existem" };
  }
  const what = changesSummary(changes);
  const instructionId = tellIfLive(store, t, `${by.agent} APROVOU remover da spec: ${what}. O .cardume/TASK.yaml já está atualizado — releia.`);
  const rec: AgentEditRecord = { id: randomUUID(), at: now, by: p.by, byTask: p.byTask, byTitle: p.byTitle, changes, note: p.note, delivered: instructionId ? "queued" : "direct", instructionId, approvedBy: by.agent };
  s.agentEdits = [...(s.agentEdits ?? []), rec].slice(-EDIT_LIMITS.trail);
  setP("approved");
  saveSpec(store, t, s);
  store.addEvent(t.id, by.agent, "spec-edit", `${by.agent} aprovou a proposta de ${p.by}: ${what} — motivo: ${p.note ?? ""} · edição ${rec.id}`, true);
  return { ok: true, mode: "applied", id: rec.id, message: `proposta aprovada (${what})` };
}

/** Desfaz uma edição (o app chama via CLI). Só restaura o campo que ainda está como a edição deixou. */
export function undoTaskEdit(opts: { store: Store; targetId: string; editId: string; by: EditAuthor }): EditResult {
  const { store, by } = opts;
  const t = store.getTask(clean(opts.targetId));
  if (!t) return { ok: false, message: `tarefa ${opts.targetId} não encontrada` };
  if (CLOSED_ST.has(t.status)) return { ok: false, message: `a tarefa "${t.title}" já foi ${t.status === "merged" ? "mergeada" : "concluída"} — não dá mais pra desfazer` };
  const spec = specOf(t);
  if (!spec) return { ok: false, message: "spec ilegível" };
  const rec = (spec.agentEdits ?? []).find((r) => r.id === opts.editId);
  if (!rec) return { ok: false, message: "edição não encontrada nesta tarefa" };
  if (rec.undone) return { ok: true, mode: "unchanged", message: "essa edição já foi desfeita" };
  const cur = (f: Field): string | string[] =>
    f === "owns" ? spec.scope?.owns ?? [] : f === "off" ? spec.scope?.offLimits ?? [] : f === "title" || f === "objective" ? String(spec[f] ?? "") : [...((spec[f] as string[]) ?? [])];
  const moved = rec.changes.filter((c) => JSON.stringify(cur(c.field)) !== JSON.stringify(c.after));
  if (moved.length) return { ok: false, message: `${moved.map((c) => FIELD_PT[c.field]).join(", ")} mudou de novo depois dessa edição — desfaça à mão` };
  const s: TaskSpec = JSON.parse(JSON.stringify(spec));
  s.scope ??= { owns: [], offLimits: [] };
  for (const c of rec.changes) {
    if (c.field === "owns") s.scope.owns = c.before as string[];
    else if (c.field === "off") s.scope.offLimits = c.before as string[];
    else if (c.field === "title" || c.field === "objective") s[c.field] = c.before as string;
    else s[c.field] = c.before as string[];
  }
  s.agentEdits = (s.agentEdits ?? []).map((r) => (r.id === rec.id ? { ...r, undone: { at: new Date().toISOString(), by: by.agent } } : r));
  saveSpec(store, t, s);
  const back = rec.changes.map((c) => ({ ...c, before: c.after, after: c.before }));
  const what = changesSummary(back);
  store.addEvent(t.id, by.agent, "note", `${by.agent} desfez a edição de ${rec.by}: ${what}`, true);
  // o recado da edição ainda não foi entregue? cancela (senão o agente recebe uma mudança que não vale mais)
  const cancelled = rec.instructionId ? store.cancelInstruction(rec.instructionId) : false;
  if (!cancelled && taskIsLive(store, t)) store.addInstruction(t.id, `${by.agent} DESFEZ uma edição anterior da spec: ${what}. O .cardume/TASK.yaml já voltou — releia.`);
  return { ok: true, mode: "applied", id: rec.id, message: `edição desfeita (${what})` };
}

/** Maior Dn de uma lista "Dn: texto" / {id:"Dn"}. */
function maxDone(list: unknown[]): number {
  return list.reduce<number>((m, d) => Math.max(m, Number(/^D(\d+)/i.exec(typeof d === "string" ? d : String((d as { id?: string })?.id ?? ""))?.[1] ?? 0)), 0);
}
/**
 * Próximo id do "pronto quando": max+1 sobre a lista ORIGINAL e o maior id já visto (`seq`), então um id
 * removido nunca volta. Mesma regra do app (47-edicoes-agente: aeNextDoneId).
 */
export function nextDoneId(list: unknown[], seq = 0): number {
  return Math.max(maxDone(list), seq || 0) + 1;
}

/**
 * Edita o ÉPICO. Guarda-corpo: só o épico da tarefa de quem pede, ou um épico que alguma tarefa deste
 * projeto carrega. Grava a pendência pro app e aplica aqui a cópia local do "pronto quando" (só acréscimos;
 * remoção é proposta que o app mostra).
 */
export function editEpic(opts: { store: Store; cardumeDir: string; epicId: string; input: EpicEditInput; by: EditAuthor }): EditResult {
  const { store, cardumeDir, input, by } = opts;
  const epicId = clean(opts.epicId);
  if (!epicId) return { ok: false, message: "diga QUAL épico editar (id — está em epic.id no TASK.yaml)" };
  const rb = roleBlock(by);
  if (rb) return { ok: false, message: rb };
  const bad = validateEpicEdit(input);
  if (bad) return { ok: false, message: bad };
  const local = store.listTasks().filter((t) => specOf(t)?.epicId === epicId);
  if (!local.length) return { ok: false, message: `o épico ${epicId} não é deste projeto (nenhuma tarefa daqui pertence a ele)` };
  const note = clean(input.note);
  const ops: EpicEditInput = {
    ...(input.description !== undefined ? { description: clean(input.description) } : {}),
    ...(input.outcome !== undefined ? { outcome: clean(input.outcome) } : {}),
    ...(input.doneWhenAdd?.length ? { doneWhenAdd: cleanList(input.doneWhenAdd) } : {}),
    ...(input.doneWhenRemove?.length ? { doneWhenRemove: input.doneWhenRemove.map((x) => clean(x).toUpperCase()) } : {}),
    ...(input.reqAdd?.length ? { reqAdd: cleanList(input.reqAdd) } : {}),
    note,
  };
  const { id, dup } = appendPending(cardumeDir, { kind: "epic", target: epicId, epicId, by, epic: ops, note });
  // cópia LOCAL do "pronto quando" (epicDoneWhen no TASK.yaml de cada tarefa do épico) — o revisor lê dali
  let touched = 0;
  if (ops.doneWhenAdd?.length && !dup) {
    for (const t of local) {
      if (CLOSED_ST.has(t.status)) continue;
      const s = specOf(t);
      if (!s) continue;
      const before = [...(s.epicDoneWhen ?? [])];
      const after = [...before];
      let n = nextDoneId(before, s.epicDoneWhenSeq);
      for (const txt of ops.doneWhenAdd) if (!after.some((d) => norm(d.replace(/^D\d+:\s*/i, "")) === norm(txt))) after.push(`D${n++}: ${txt}`);
      if (after.length === before.length) continue;
      touched++;
      setLocalDoneWhen(store, t, s, after, n - 1, by, note, id);
    }
  }
  const parts = [
    ops.description !== undefined ? "descrição" : "",
    ops.outcome !== undefined ? "outcome" : "",
    ops.doneWhenAdd?.length ? `+${ops.doneWhenAdd.length} no pronto quando` : "",
    ops.reqAdd?.length ? `+${ops.reqAdd.length} requisito(s)` : "",
    ops.doneWhenRemove?.length ? `proposta de remover ${ops.doneWhenRemove.join(",")} do pronto quando` : "",
  ].filter(Boolean).join(", ");
  if (by.taskId && !dup) store.addEvent(by.taskId, by.agent, "note", `épico atualizado (${parts}): ${note}`, true);
  return {
    ok: true, mode: ops.doneWhenRemove?.length && Object.keys(ops).length === 2 ? "proposed" : "pending", id,
    message: (dup ? `essa edição do épico já estava registrada (${id}). ` : `edição do épico registrada (${id}: ${parts}). `) +
      "O app aplica no épico do time (fica no histórico dele com o seu motivo)." +
      (ops.doneWhenRemove?.length ? " A remoção do \"pronto quando\" é uma PROPOSTA: só vale quando quem cuida do épico aprovar — até lá, o item continua valendo." : "") +
      (touched ? ` O "pronto quando" já foi atualizado no TASK.yaml de ${touched} tarefa(s) deste computador.` : ""),
  };
}

/** Troca a cópia local do "pronto quando" de UMA tarefa, com rastro desfazível e recado se ela roda. */
function setLocalDoneWhen(store: Store, t: TaskRow, s: TaskSpec, after: string[], seq: number, by: EditAuthor, note: string, editId?: string): void {
  const before = [...(s.epicDoneWhen ?? [])];
  const next: TaskSpec = JSON.parse(JSON.stringify(s));
  next.epicDoneWhen = after;
  next.epicDoneWhenSeq = Math.max(s.epicDoneWhenSeq ?? 0, maxDone(before), maxDone(after), seq || 0);
  const self = by.taskId === t.id;
  const instructionId = self ? undefined : tellIfLive(store, t, `${authorLabel(by)} atualizou o "pronto quando" do épico (epic.done_when no TASK.yaml): ${after.join("; ") || "(vazio)"}. Motivo: ${note}. Releia o TASK.yaml.`);
  const rec: AgentEditRecord = {
    id: randomUUID(), at: new Date().toISOString(), by: by.agent, byTask: by.taskId, byTitle: by.taskTitle,
    changes: [{ field: "epicDoneWhen", before, after }], note, delivered: self ? "self" : instructionId ? "queued" : "direct", instructionId,
  };
  next.agentEdits = [...(s.agentEdits ?? []), rec].slice(-EDIT_LIMITS.trail);
  if (editId) rememberId(next, editId);
  saveSpec(store, t, next);
  store.addEvent(t.id, by.agent, "spec-edit", `${authorLabel(by)} atualizou o "pronto quando" do épico: ${changesSummary(rec.changes)} — motivo: ${note} · edição ${rec.id}`, true);
}

/**
 * O app manda a lista OFICIAL do "pronto quando" (da nuvem, depois de aplicar/aprovar/desfazer) e as cópias
 * locais das tarefas abertas do épico passam a ser ela. Idempotente: lista igual = nada acontece.
 */
export function syncEpicDoneWhen(opts: { store: Store; epicId: string; doneWhen: unknown; seq?: number; by: EditAuthor; note?: string }): EditResult {
  const { store, by } = opts;
  if (!isStrArr(opts.doneWhen)) return { ok: false, message: "doneWhen precisa ser uma lista de textos" };
  const list = (opts.doneWhen as string[]).map(clean).filter(Boolean);
  const bad = checkTexts([["pronto quando", list, EDIT_LIMITS.item + 8]]);
  if (bad) return { ok: false, message: bad };
  let n = 0;
  for (const t of store.listTasks()) {
    const s = specOf(t);
    if (!s || s.epicId !== clean(opts.epicId) || CLOSED_ST.has(t.status)) continue;
    if (JSON.stringify(s.epicDoneWhen ?? []) === JSON.stringify(list)) continue;
    setLocalDoneWhen(store, t, s, list, opts.seq ?? 0, by, clean(opts.note) || "sincronizado com o épico do time");
    n++;
  }
  return { ok: true, mode: n ? "applied" : "unchanged", message: n ? `"pronto quando" sincronizado em ${n} tarefa(s)` : "nada mudou" };
}

/** Detalhe COMPLETO de uma edição/proposta (o snapshot leva só o resumo; o app busca antes/depois sob demanda). */
export function editDetail(store: Store, taskId: string, id: string): AgentEditRecord | AgentProposal | null {
  const t = store.getTask(taskId);
  const s = t ? specOf(t) : null;
  if (!s) return null;
  return (s.agentEdits ?? []).find((r) => r.id === id) ?? (s.agentProposals ?? []).find((p) => p.id === id) ?? null;
}
