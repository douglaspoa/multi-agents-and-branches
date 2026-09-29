// Edições de SPEC feitas por um agente (a ideia muda conforme se programa):
//  - tarefa: objetivo, título, requisitos, entregáveis, escopo (owns/off) de uma tarefa do MESMO projeto
//    (irmã do épico, rascunho, ou a própria). NUNCA inicia/retoma/conversa com o agente dela: grava no
//    banco + TASK.yaml; se ela está rodando, a mudança vira uma instrução que o agente recebe no PRÓXIMO
//    turno (fila de instruções — não interrompe).
//  - épico: descrição, outcome, requisitos, "pronto quando". O épico mora na NUVEM e o motor não tem sessão:
//    a edição vai pra .cardume/agent-edits/epic-<id>.jsonl e o APP (que tem a sessão) aplica via PATCH em
//    epics.spec, idempotente pelo id da edição (fica em spec.history). O que dá pra aplicar aqui (a cópia do
//    "pronto quando" nas tarefas locais do épico) é aplicado direto.
//  - cartão da nuvem que não existe neste banco (irmã ainda no backlog do time): mesma fila de arquivo,
//    card-<id>.jsonl; o app aplica em tasks.spec.
// Todo edit deixa RASTRO: quem (agente + tarefa), quando, o quê (antes → depois) e o porquê (note).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  trail: 10, // edições guardadas no spec da tarefa (vão no snapshot do app)
};

/** Tarefa fechada: a spec não muda mais (a entrega já foi julgada). */
export const CLOSED_ST = new Set(["merged", "done"]);
/** Status em que um turno do agente pode estar rodando agora. */
const LIVE_ST = new Set(["running", "queued", "thinking"]);

export interface EditAuthor {
  agent: string;
  taskId?: string;
  taskTitle?: string;
}
export interface TaskEditInput {
  title?: string;
  objective?: string;
  reqAdd?: string[];
  /** posições 1-based na lista ATUAL de requisitos */
  reqRemove?: number[];
  deliverables?: string[]; // substitui a lista
  delivAdd?: string[];
  owns?: string[]; // substitui
  off?: string[]; // substitui
  note?: string;
}
export interface EpicEditInput {
  description?: string;
  outcome?: string;
  doneWhenAdd?: string[];
  /** ids ("D3") do "pronto quando" */
  doneWhenRemove?: string[];
  reqAdd?: string[];
  note?: string;
}
export interface FieldChange {
  field: "title" | "objective" | "requirements" | "deliverables" | "owns" | "off";
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
  undone?: { at: string; by: string };
}
export type EditResult =
  | { ok: true; mode: "applied" | "queued" | "pending" | "unchanged"; id?: string; message: string }
  | { ok: false; message: string };

const FIELD_PT: Record<FieldChange["field"], string> = {
  title: "o título",
  objective: "o objetivo",
  requirements: "os requisitos",
  deliverables: "os entregáveis",
  owns: "o escopo (owns)",
  off: "as áreas proibidas (off)",
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const cleanList = (a: unknown) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []);
const norm = (s: string) => clean(s).toLowerCase();
const short = (v: string | string[], n = 90) => {
  const s = Array.isArray(v) ? (v.length ? v.join("; ") : "(vazio)") : v || "(vazio)";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

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
    ["entregável", i.deliverables, EDIT_LIMITS.item],
    ["entregável", i.delivAdd, EDIT_LIMITS.item],
    ["owns", i.owns, EDIT_LIMITS.path],
    ["off", i.off, EDIT_LIMITS.path],
    ["motivo", i.note, EDIT_LIMITS.note],
  ]);
}

export function validateEpicEdit(i: EpicEditInput): string | null {
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

/** PURA: aplica a edição na spec. Devolve a spec nova e SÓ as mudanças reais (mesmo valor = sem mudança). */
export function applyTaskEdit(spec: TaskSpec, i: TaskEditInput): { spec: TaskSpec; changes: FieldChange[] } {
  const s: TaskSpec = JSON.parse(JSON.stringify(spec));
  s.scope ??= { owns: [], offLimits: [] };
  const changes: FieldChange[] = [];
  const setStr = (field: "title" | "objective", v?: string) => {
    if (v === undefined) return;
    const nv = clean(v), before = String(s[field] ?? "");
    if (nv && nv !== before) { changes.push({ field, before, after: nv }); s[field] = nv; }
  };
  const setList = (field: FieldChange["field"], before: string[], after: string[], put: (x: string[]) => void) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({ field, before: [...before], after: [...after] });
    put(after);
  };
  setStr("title", i.title);
  setStr("objective", i.objective);
  if (i.reqAdd?.length || i.reqRemove?.length) {
    const before = [...(s.requirements ?? [])];
    const drop = new Set((i.reqRemove ?? []).map((n) => Number(n) - 1));
    const kept = before.filter((_, k) => !drop.has(k));
    for (const r of cleanList(i.reqAdd)) if (!kept.some((x) => norm(x) === norm(r))) kept.push(r);
    setList("requirements", before, kept, (x) => { s.requirements = x; });
  }
  if (i.deliverables !== undefined || i.delivAdd?.length) {
    const before = [...(s.deliverables ?? [])];
    const next = i.deliverables !== undefined ? cleanList(i.deliverables) : [...before];
    for (const d of cleanList(i.delivAdd)) if (!next.some((x) => norm(x) === norm(d))) next.push(d);
    setList("deliverables", before, next, (x) => { s.deliverables = x; });
  }
  if (i.owns !== undefined) setList("owns", [...(s.scope.owns ?? [])], cleanList(i.owns), (x) => { s.scope.owns = x; });
  if (i.off !== undefined) setList("off", [...(s.scope.offLimits ?? [])], cleanList(i.off), (x) => { s.scope.offLimits = x; });
  return { spec: s, changes };
}

/** PURA: frase curta do que mudou ("o objetivo: A → B; os requisitos: +1 −0"). */
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

function specOf(t: TaskRow): TaskSpec {
  try { return JSON.parse(t.spec_json) as TaskSpec; } catch { return {} as TaskSpec; }
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

/** Grava a edição na fila de arquivo (idempotente pela chave de conteúdo). Devolve o id (novo ou o existente). */
export function appendPending(cardumeDir: string, e: Omit<PendingEdit, "id" | "key" | "at">): { id: string; dup: boolean } {
  const dir = editsDir(cardumeDir);
  mkdirSync(dir, { recursive: true });
  const safe = e.target.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const file = join(dir, `${e.kind}-${safe}.jsonl`);
  const key = contentKey({ k: e.kind, t: e.target, b: e.by.taskId ?? e.by.agent, x: e.epic ?? e.task });
  if (existsSync(file)) {
    for (const l of readFileSync(file, "utf8").split("\n")) {
      try { const o = JSON.parse(l) as PendingEdit; if (o.key === key) return { id: o.id, dup: true }; } catch { /* linha parcial */ }
    }
  }
  const row: PendingEdit = { id: randomUUID(), key, at: new Date().toISOString(), ...e };
  appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  return { id: row.id, dup: false };
}

/**
 * Edita a spec de uma tarefa do projeto SEM rodar o agente dela.
 * `epicId` = épico de quem pede (tarefa fora deste banco só vira pendência se o autor está num épico).
 */
export function editTask(opts: {
  store: Store;
  cardumeDir: string;
  targetId: string;
  input: TaskEditInput;
  by: EditAuthor;
  epicId?: string;
}): EditResult {
  const { store, cardumeDir, input, by } = opts;
  const targetId = clean(opts.targetId);
  if (!targetId) return { ok: false, message: "diga QUAL tarefa editar (id)" };
  const bad = validateTaskEdit(input);
  if (bad) return { ok: false, message: bad };
  const note = clean(input.note);
  const t = store.getTask(targetId);
  if (!t) {
    // irmã que ainda está no backlog do time (só na nuvem): fila pro app aplicar no cartão
    if (!opts.epicId) return { ok: false, message: `tarefa ${targetId} não encontrada neste projeto` };
    const { id, dup } = appendPending(cardumeDir, { kind: "card", target: targetId, epicId: opts.epicId, by, task: { ...input, note } });
    if (by.taskId) store.addEvent(by.taskId, by.agent, "note", `tarefa atualizada (cartão ${targetId}, aplicação pelo app): ${note}`, true);
    return {
      ok: true, mode: "pending", id,
      message: dup
        ? `essa mesma edição já estava registrada (${id}) — o app aplica no cartão do time`
        : `edição registrada (${id}): a tarefa ${targetId} não está neste computador, então o app aplica no cartão do time assim que sincronizar. O agente dela NÃO foi acionado.`,
    };
  }
  if (CLOSED_ST.has(t.status)) {
    return { ok: false, message: `a tarefa "${t.title}" já está ${t.status === "merged" ? "mergeada" : "concluída"} — a spec dela não muda mais. Se a ideia mudou, proponha uma tarefa nova ao humano.` };
  }
  const spec = specOf(t);
  const { spec: next, changes } = applyTaskEdit(spec, input);
  if (!changes.length) return { ok: true, mode: "unchanged", message: `nada mudou — a tarefa "${t.title}" já estava assim` };
  const self = !!by.taskId && by.taskId === t.id;
  const live = !self && taskIsLive(store, t);
  const rec: AgentEditRecord = {
    id: randomUUID(), at: new Date().toISOString(), by: by.agent, byTask: by.taskId, byTitle: by.taskTitle,
    changes, note, delivered: self ? "self" : live ? "queued" : "direct",
  };
  next.agentEdits = [...(spec.agentEdits ?? []), rec].slice(-EDIT_LIMITS.trail);
  store.updateSpec(t.id, JSON.stringify(next));
  store.setTitleObjective(t.id, next.title, next.objective);
  writeYaml(t, next);
  const what = changesSummary(changes);
  const tail = live ? " (vai pro agente dela no próximo turno, sem interromper)" : "";
  store.addEvent(t.id, by.agent, "spec-edit", `${self ? by.agent : authorLabel(by)} atualizou ${self ? "a própria spec" : "esta tarefa"}: ${what} — motivo: ${note}${tail} · edição ${rec.id}`, true);
  if (live) {
    store.addInstruction(
      t.id,
      `${authorLabel(by)} ATUALIZOU a spec desta tarefa (sem parar o seu trabalho): ${what}. Motivo: ${note}. ` +
        `O .cardume/TASK.yaml já está atualizado — releia e ajuste o que estiver fazendo; não desfaça a mudança.`
    );
  }
  if (by.taskId && !self) store.addEvent(by.taskId, by.agent, "note", `tarefa atualizada ("${next.title}"): ${what}`, true);
  return {
    ok: true, mode: live ? "queued" : "applied", id: rec.id,
    message: `tarefa "${next.title}" atualizada (${what}).` +
      (live ? " Ela está rodando: a mudança chega ao agente dela no PRÓXIMO turno, sem interromper." : self ? "" : " O agente dela NÃO foi acionado — ele lê a spec nova quando rodar."),
  };
}

/** Desfaz uma edição (o app chama via CLI). Só restaura o campo que ainda está como a edição deixou. */
export function undoTaskEdit(opts: { store: Store; targetId: string; editId: string; by: EditAuthor }): EditResult {
  const { store, by } = opts;
  const t = store.getTask(clean(opts.targetId));
  if (!t) return { ok: false, message: `tarefa ${opts.targetId} não encontrada` };
  if (CLOSED_ST.has(t.status)) return { ok: false, message: `a tarefa "${t.title}" já foi ${t.status === "merged" ? "mergeada" : "concluída"} — não dá mais pra desfazer` };
  const spec = specOf(t);
  const rec = (spec.agentEdits ?? []).find((r) => r.id === opts.editId);
  if (!rec) return { ok: false, message: "edição não encontrada nesta tarefa" };
  if (rec.undone) return { ok: true, mode: "unchanged", message: "essa edição já foi desfeita" };
  const cur = (f: FieldChange["field"]): string | string[] =>
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
  store.updateSpec(t.id, JSON.stringify(s));
  store.setTitleObjective(t.id, s.title, s.objective);
  writeYaml(t, s);
  const back = rec.changes.map((c) => ({ ...c, before: c.after, after: c.before }));
  const what = changesSummary(back);
  store.addEvent(t.id, by.agent, "note", `${by.agent} desfez a edição de ${rec.by}: ${what}`, true);
  if (taskIsLive(store, t)) store.addInstruction(t.id, `${by.agent} DESFEZ uma edição anterior da spec: ${what}. O .cardume/TASK.yaml já voltou — releia.`);
  return { ok: true, mode: "applied", id: rec.id, message: `edição desfeita (${what})` };
}

/** Lista local "Dn: texto" do "pronto quando" → próximo id livre. */
function nextDoneId(list: string[]): number {
  return list.reduce((m, d) => Math.max(m, Number(/^D(\d+)/i.exec(String(d))?.[1] ?? 0)), 0) + 1;
}

/**
 * Edita o ÉPICO. Guarda-corpo: só o épico da tarefa de quem pede, ou um épico que alguma tarefa deste
 * projeto carrega. Grava a pendência pro app e aplica aqui a cópia local do "pronto quando".
 */
export function editEpic(opts: { store: Store; cardumeDir: string; epicId: string; input: EpicEditInput; by: EditAuthor }): EditResult {
  const { store, cardumeDir, input, by } = opts;
  const epicId = clean(opts.epicId);
  if (!epicId) return { ok: false, message: "diga QUAL épico editar (id — está em epic.id no TASK.yaml)" };
  const bad = validateEpicEdit(input);
  if (bad) return { ok: false, message: bad };
  const local = store.listTasks().filter((t) => specOf(t).epicId === epicId);
  const author = by.taskId ? store.getTask(by.taskId) : undefined;
  if (!local.length && !(author && specOf(author).epicId === epicId)) {
    return { ok: false, message: `o épico ${epicId} não é deste projeto (nenhuma tarefa daqui pertence a ele)` };
  }
  const note = clean(input.note);
  const ops: EpicEditInput = {
    ...(input.description !== undefined ? { description: clean(input.description) } : {}),
    ...(input.outcome !== undefined ? { outcome: clean(input.outcome) } : {}),
    ...(input.doneWhenAdd?.length ? { doneWhenAdd: cleanList(input.doneWhenAdd) } : {}),
    ...(input.doneWhenRemove?.length ? { doneWhenRemove: input.doneWhenRemove.map((x) => clean(x).toUpperCase()) } : {}),
    ...(input.reqAdd?.length ? { reqAdd: cleanList(input.reqAdd) } : {}),
    note,
  };
  // cópia LOCAL do "pronto quando" (epicDoneWhen no TASK.yaml de cada tarefa do épico) — o revisor lê dali
  const touched: string[] = [];
  if (ops.doneWhenAdd?.length || ops.doneWhenRemove?.length) {
    for (const t of local) {
      if (CLOSED_ST.has(t.status)) continue;
      const s = specOf(t);
      const before = [...(s.epicDoneWhen ?? [])];
      if (!before.length && !ops.doneWhenAdd?.length) continue;
      const rm = new Set(ops.doneWhenRemove ?? []);
      const after = before.filter((d) => !rm.has(String(d).split(":")[0].trim().toUpperCase()));
      let n = nextDoneId(before);
      for (const txt of ops.doneWhenAdd ?? []) if (!after.some((d) => norm(d.replace(/^D\d+:\s*/i, "")) === norm(txt))) after.push(`D${n++}: ${txt}`);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      s.epicDoneWhen = after;
      store.updateSpec(t.id, JSON.stringify(s));
      writeYaml(t, s);
      touched.push(t.id);
      if (t.id !== by.taskId) {
        store.addEvent(t.id, by.agent, "spec-edit", `${authorLabel(by)} atualizou o "pronto quando" do épico: ${after.join("; ") || "(vazio)"} — motivo: ${note}`, true);
        if (taskIsLive(store, t)) store.addInstruction(t.id, `${authorLabel(by)} atualizou o "pronto quando" do épico (epic.done_when no TASK.yaml): ${after.join("; ")}. Motivo: ${note}. Releia o TASK.yaml.`);
      }
    }
  }
  const { id, dup } = appendPending(cardumeDir, { kind: "epic", target: epicId, epicId, by, epic: ops, note });
  const parts = [
    ops.description !== undefined ? "descrição" : "",
    ops.outcome !== undefined ? "outcome" : "",
    ops.doneWhenAdd?.length ? `+${ops.doneWhenAdd.length} no pronto quando` : "",
    ops.doneWhenRemove?.length ? `−${ops.doneWhenRemove.join(",")} do pronto quando` : "",
    ops.reqAdd?.length ? `+${ops.reqAdd.length} requisito(s)` : "",
  ].filter(Boolean).join(", ");
  if (by.taskId && !dup) store.addEvent(by.taskId, by.agent, "note", `épico atualizado (${parts}): ${note}`, true);
  return {
    ok: true, mode: "pending", id,
    message: (dup ? `essa edição do épico já estava registrada (${id}). ` : `edição do épico registrada (${id}: ${parts}). `) +
      "O app aplica no épico do time (fica no histórico dele com o seu motivo)." +
      (touched.length ? ` O "pronto quando" já foi atualizado no TASK.yaml de ${touched.length} tarefa(s) deste computador.` : ""),
  };
}
