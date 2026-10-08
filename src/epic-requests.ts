// PEDIDOS DE ÉPICO — criar um épico e vincular/desvincular tarefas JÁ EXISTENTES pelo terminal (CLI `cardume epic
// new|link|unlink`, `starfork epico …`, tools MCP create_epic / link_tasks_to_epic / unlink_tasks_from_epic).
// O épico é do TIME (nuvem) e o motor não tem sessão: aqui só se grava o PEDIDO em `.cardume/epic-requests/<id>.json`.
// O APP (app/src/js/49-epico-pedidos.js) executa com a sessão dele — cria o épico, troca o epic_id do cartão, atualiza
// o epicId da spec local (CLI `epic apply-link`, que chama applyLocalLink) — e escreve `<id>.result.json`. Quem pediu
// espera alguns segundos pelo resultado:
//  - veio → mostra (criado/vinculado, ou RECUSADO com o motivo — ex.: sem login/time);
//  - não veio (app fechado / outro projeto aberto) → diz que ficou PENDENTE, sem fingir que criou;
//    `cardume epic status` mostra o desfecho depois.
// Vincular NUNCA recria, reinicia nem conversa com a tarefa: muda a spec (epicId + "pronto quando"), o TASK.yaml e,
// se ela está rodando, deixa um recado pro PRÓXIMO turno.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";
import { looksSecret } from "./memory.ts";
import { roleBlock, taskIsLive, type EditAuthor } from "./agent-edits.ts";
import { contextDir, prepEpicTurn, readEpicContext, resolveTaskTarget, type EpicTaskItem } from "./epic-context.ts";
import { taskToYaml } from "./util/yaml.ts";

export const EPIC_REQ_LIMITS = { title: 140, text: 2000, item: 300, items: 30, tasks: 30 };
/** Espera padrão pelo app (o tick dele roda a cada ~3s). */
export const EPIC_REQ_WAIT_MS = 12_000;

export type EpicReqKind = "create" | "link" | "unlink";
export interface NewEpicInput { title: string; description?: string; outcome?: string; doneWhen?: string[] }
/** Tarefa alvo, já resolvida no motor: id local e/ou id do cartão da nuvem. */
export interface EpicReqTask { ref: string; localId?: string; cloudId?: string; title: string }
export interface EpicRequest {
  id: string;
  key: string;
  kind: EpicReqKind;
  at: string;
  by: EditAuthor;
  epic?: NewEpicInput;
  /** épico alvo do link: id (uuid) OU título (o app resolve entre os épicos do time) */
  epicId?: string;
  epicTitle?: string;
  tasks: EpicReqTask[];
}
export interface EpicReqResult {
  id: string;
  ok: boolean;
  status: "done" | "partial" | "refused";
  message: string;
  epicId?: string;
  epicTitle?: string;
  linked?: { ref: string; title: string; localId?: string; cloudId?: string; mode?: string }[];
  failed?: { ref: string; title?: string; why: string }[];
  at?: string;
}
export interface EpicFlowResult {
  ok: boolean;
  status: "done" | "partial" | "refused" | "pending" | "invalid";
  requestId?: string;
  epicId?: string;
  epicTitle?: string;
  linked: NonNullable<EpicReqResult["linked"]>;
  failed: NonNullable<EpicReqResult["failed"]>;
  message: string;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const fold = (s: string) => clean(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown) => UUID.test(String(s ?? ""));
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const requestsDir = (cardumeDir: string) => join(cardumeDir, "epic-requests");
const reqFile = (cardumeDir: string, id: string) => join(requestsDir(cardumeDir), `${id}.json`);
const resFile = (cardumeDir: string, id: string) => join(requestsDir(cardumeDir), `${id}.result.json`);

/** PURA: valida o épico novo. Devolve a recusa (pt-BR) ou null. */
export function validateNewEpic(i: NewEpicInput): string | null {
  const title = clean(i?.title);
  if (!title) return "diga o TÍTULO do épico (ex.: cardume epic new \"Arquitetura do user_cases\")";
  if (title.length > EPIC_REQ_LIMITS.title) return `título longo demais (máx. ${EPIC_REQ_LIMITS.title} caracteres)`;
  for (const [label, v] of [["descrição", i.description], ["outcome", i.outcome]] as const) {
    if (v !== undefined && typeof v !== "string") return `${label} precisa ser texto`;
    if (clean(v).length > EPIC_REQ_LIMITS.text) return `${label} longa demais (máx. ${EPIC_REQ_LIMITS.text} caracteres)`;
  }
  const dw = i.doneWhen ?? [];
  if (!Array.isArray(dw) || dw.some((x) => typeof x !== "string")) return "\"pronto quando\" precisa ser uma lista de textos";
  if (dw.length > EPIC_REQ_LIMITS.items) return `"pronto quando": no máximo ${EPIC_REQ_LIMITS.items} itens`;
  if (dw.some((x) => clean(x).length > EPIC_REQ_LIMITS.item)) return `item do "pronto quando" longo demais (máx. ${EPIC_REQ_LIMITS.item} caracteres)`;
  if ([title, i.description, i.outcome, ...dw].some((x) => x && looksSecret(String(x)))) return "o texto parece conter um segredo — não gravo isso no épico";
  return null;
}

function specOf(raw: string): TaskSpec | null {
  try { const s = JSON.parse(raw); return s && typeof s === "object" && !Array.isArray(s) ? (s as TaskSpec) : null; } catch { return null; }
}

/** Todas as tarefas que dá pra apontar daqui: as locais + as irmãs de todos os épicos com contexto gravado. */
export function linkableTasks(store: Store, cardumeDir: string): EpicTaskItem[] {
  const out: EpicTaskItem[] = store.listTasks().map((t) => ({ id: t.id, localId: t.id, title: t.title, status: t.status, requirements: [], here: true }));
  const seen = new Set(out.map((x) => x.id));
  const dir = contextDir(cardumeDir);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const ctx = readEpicContext(cardumeDir, f.slice(0, -5))?.ctx;
      for (const s of ctx?.siblings ?? []) {
        const lid = s.localId && !String(s.localId).startsWith("card-") ? String(s.localId) : undefined;
        if (lid && seen.has(lid)) { const x = out.find((o) => o.id === lid); if (x && !x.cloudId) x.cloudId = s.cloudId; continue; }
        if (seen.has(s.cloudId)) continue;
        seen.add(s.cloudId);
        out.push({ id: s.cloudId, cloudId: s.cloudId, localId: lid, title: s.title, status: s.status, requirements: [], here: false });
      }
    }
  }
  return out;
}

/**
 * Resolve as tarefas pedidas (id local, id do cartão ou título). Desconhecida/ambígua → recusa listando as válidas.
 * Uuid que ninguém aqui conhece passa como cartão da nuvem (o app confere se é do mesmo projeto).
 */
export function resolveTaskRefs(store: Store, cardumeDir: string, refs: string[]): { ok: true; tasks: EpicReqTask[] } | { ok: false; message: string } {
  const qs = [...new Set(refs.map(clean).filter(Boolean))];
  if (!qs.length) return { ok: false, message: "diga QUAIS tarefas (id ou título). Tarefas deste projeto:\n" + listText(linkableTasks(store, cardumeDir)) };
  if (qs.length > EPIC_REQ_LIMITS.tasks) return { ok: false, message: `no máximo ${EPIC_REQ_LIMITS.tasks} tarefas por pedido` };
  const items = linkableTasks(store, cardumeDir);
  const out: EpicReqTask[] = [];
  for (const q of qs) {
    const r = resolveTaskTarget(q, items);
    if (r.ok) {
      const x = r.item;
      if (!out.some((o) => (o.localId && o.localId === x.localId) || (o.cloudId && o.cloudId === x.cloudId)))
        out.push({ ref: q, title: x.title, ...(x.here ? { localId: x.localId ?? x.id } : x.localId ? { localId: x.localId } : {}), ...(x.cloudId ? { cloudId: x.cloudId } : {}) });
      continue;
    }
    if (isUuid(q)) { out.push({ ref: q, cloudId: q, title: "" }); continue; }
    return { ok: false, message: r.message.replace("neste épico", "neste projeto").replace("Tarefas do épico", "Tarefas deste projeto") };
  }
  return { ok: true, tasks: out };
}
function listText(items: { id: string; title: string; here?: boolean }[]): string {
  return items.length ? items.slice(0, 40).map((x) => `${x.id} — ${x.title}${x.here === false ? " (cartão do time)" : ""}`).join("\n") : "(nenhuma tarefa neste projeto)";
}

/** Épicos do time que o app deixou listados (`epics.json`, atualizado com o app aberto e logado). */
export function teamEpicsList(cardumeDir: string): { id: string; name: string; status?: string; tasks?: number }[] {
  try {
    const v = JSON.parse(readFileSync(join(requestsDir(cardumeDir), "epics.json"), "utf8"));
    return Array.isArray(v?.epics) ? v.epics.filter((e: { id?: unknown }) => typeof e?.id === "string") : [];
  } catch { return []; }
}
export function teamEpicsAt(cardumeDir: string): string | null {
  try { return String(JSON.parse(readFileSync(join(requestsDir(cardumeDir), "epics.json"), "utf8")).at ?? "") || null; } catch { return null; }
}

/**
 * Épico alvo do link: vazio = o desta tarefa; id (uuid); título igual (sem caixa/acento) a um épico conhecido
 * (das tarefas locais, dos contextos ou da lista do time). Título que ninguém aqui conhece vai pro app resolver.
 */
export function resolveEpicRef(query: string | undefined, known: { id: string; title: string }[], current?: string): { ok: true; epicId?: string; epicTitle?: string } | { ok: false; message: string } {
  const q = clean(query);
  if (!q) return current ? { ok: true, epicId: current } : { ok: false, message: "diga a QUAL épico vincular (id ou nome) — veja os épicos do time com: cardume epic list" };
  if (isUuid(q)) return { ok: true, epicId: q };
  const hit = known.filter((e) => e.title && fold(e.title) === fold(q));
  const ids = [...new Set(hit.map((e) => e.id))];
  if (ids.length === 1) return { ok: true, epicId: ids[0], epicTitle: hit[0].title };
  if (ids.length > 1) return { ok: false, message: `mais de um épico chamado "${q}" — use o id:\n` + hit.map((e) => `${e.id} — ${e.title}`).join("\n") };
  if (q.length > EPIC_REQ_LIMITS.title) return { ok: false, message: "nome de épico longo demais" };
  return { ok: true, epicTitle: q };
}

function contentKey(obj: unknown): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(obj)) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Grava o pedido (atômico). O mesmo pedido ainda pendente não vira dois (agente re-tentou). */
export function writeRequest(cardumeDir: string, r: Omit<EpicRequest, "id" | "key" | "at">): { id: string; dup: boolean } {
  const dir = requestsDir(cardumeDir);
  mkdirSync(dir, { recursive: true });
  const key = contentKey({ k: r.kind, e: r.epic, i: r.epicId, t: r.epicTitle, x: r.tasks.map((t) => t.localId ?? t.cloudId), b: r.by.taskId ?? r.by.agent });
  for (const p of pendingRequests(cardumeDir)) if (p.key === key) return { id: p.id, dup: true };
  const row: EpicRequest = { id: randomUUID(), key, at: new Date().toISOString(), ...r };
  const f = reqFile(cardumeDir, row.id), tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(row), "utf8");
  renameSync(tmp, f);
  return { id: row.id, dup: false };
}

export function readRequest(cardumeDir: string, id: string): EpicRequest | null {
  if (!SAFE_ID.test(id)) return null;
  try { return JSON.parse(readFileSync(reqFile(cardumeDir, id), "utf8")) as EpicRequest; } catch { return null; }
}
export function readResult(cardumeDir: string, id: string): EpicReqResult | null {
  if (!SAFE_ID.test(id)) return null;
  try { const v = JSON.parse(readFileSync(resFile(cardumeDir, id), "utf8")); return v && v.id === id ? (v as EpicReqResult) : null; } catch { return null; }
}
/** Pedidos sem resultado ainda, mais antigos primeiro. */
export function pendingRequests(cardumeDir: string): EpicRequest[] {
  return listRequests(cardumeDir, 200).filter((x) => !x.result).map((x) => x.req).reverse();
}
/** Pedidos (mais recentes primeiro) com o resultado, quando já há. */
export function listRequests(cardumeDir: string, limit = 10): { req: EpicRequest; result: EpicReqResult | null }[] {
  const dir = requestsDir(cardumeDir);
  if (!existsSync(dir)) return [];
  const out: { req: EpicRequest; result: EpicReqResult | null }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".result.json") || f === "epics.json") continue;
    const req = readRequest(cardumeDir, f.slice(0, -5));
    if (req?.id) out.push({ req, result: readResult(cardumeDir, req.id) });
  }
  return out.sort((a, b) => String(b.req.at).localeCompare(String(a.req.at))).slice(0, limit);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitResult(cardumeDir: string, id: string, timeoutMs: number): Promise<EpicReqResult | null> {
  const t0 = Date.now();
  for (;;) {
    const r = readResult(cardumeDir, id);
    if (r || Date.now() - t0 >= timeoutMs) return r;
    await sleep(250);
  }
}

const KIND_PT: Record<EpicReqKind, string> = { create: "criar o épico", link: "vincular ao épico", unlink: "desvincular do épico" };
/** PURA: resultado (ou ausência dele) → resposta do CLI/MCP. */
export function flowFromResult(req: { id: string; kind: EpicReqKind; dup?: boolean }, res: EpicReqResult | null, waitedMs: number): EpicFlowResult {
  if (!res) {
    return {
      ok: true, status: "pending", requestId: req.id, linked: [], failed: [],
      message: `pedido registrado (${req.id}) pra ${KIND_PT[req.kind]}${req.dup ? " — o mesmo pedido já estava na fila" : ""}, mas o Starfork não respondeu em ${Math.round(waitedMs / 1000)}s: NADA foi ${req.kind === "create" ? "criado" : "alterado"} ainda. ` +
        `O app precisa estar ABERTO neste projeto e logado no time — ele executa o pedido assim que abrir. Confira depois com: cardume epic status ${req.id} (ou a tool epic_request_status).`,
    };
  }
  return {
    ok: res.ok, status: res.status, requestId: req.id, epicId: res.epicId, epicTitle: res.epicTitle,
    linked: res.linked ?? [], failed: res.failed ?? [], message: res.message,
  };
}

/** Texto pt-BR do resultado (CLI sem --json e tools MCP). */
export function flowText(r: EpicFlowResult): string {
  const L = [r.message];
  if (r.epicId) L.push(`épico: ${r.epicTitle ? `"${r.epicTitle}" ` : ""}(id ${r.epicId})`);
  for (const x of r.linked) L.push(`  ✓ ${x.title || x.ref}${x.localId ? ` · ${x.localId}` : ""}${x.mode === "unchanged" ? " (já estava assim)" : ""}`);
  for (const x of r.failed) L.push(`  ✕ ${x.title || x.ref}: ${x.why}`);
  if (r.requestId && r.status !== "pending") L.push(`(pedido ${r.requestId})`);
  return L.join("\n");
}

/** O fluxo inteiro (CLI e MCP): valida, resolve, grava o pedido e espera o app. */
export async function epicRequestFlow(opts: {
  store: Store; cardumeDir: string; kind: EpicReqKind; by: EditAuthor;
  epic?: NewEpicInput; epicRef?: string; taskRefs?: string[]; waitMs?: number;
}): Promise<EpicFlowResult> {
  const { store, cardumeDir, kind, by } = opts;
  const bad = (message: string): EpicFlowResult => ({ ok: false, status: "invalid", linked: [], failed: [], message });
  const rb = roleBlock(by);
  if (rb) return bad(rb.replace("muda spec", "cria nem vincula épico"));
  let tasks: EpicReqTask[] = [];
  const refs = (opts.taskRefs ?? []).flatMap((x) => String(x).split(",")).map(clean).filter(Boolean);
  if (kind !== "create" || refs.length) {
    const r = resolveTaskRefs(store, cardumeDir, refs);
    if (!r.ok) return bad(r.message);
    tasks = r.tasks;
  }
  let epic: NewEpicInput | undefined, epicId: string | undefined, epicTitle: string | undefined;
  if (kind === "create") {
    const e = opts.epic ?? { title: "" };
    const v = validateNewEpic(e);
    if (v) return bad(v);
    epic = { title: clean(e.title), ...(clean(e.description) ? { description: clean(e.description) } : {}), ...(clean(e.outcome) ? { outcome: clean(e.outcome) } : {}),
      ...(e.doneWhen?.map(clean).filter(Boolean).length ? { doneWhen: e.doneWhen.map(clean).filter(Boolean) } : {}) };
  } else if (kind === "link") {
    const me = by.taskId ? store.getTask(by.taskId) : undefined;
    const known = [
      ...store.listTasks().map((t) => specOf(t.spec_json)?.epicId).filter(Boolean).map((id) => ({ id: id as string, title: readEpicContext(cardumeDir, id as string)?.ctx.title ?? "" })),
      ...teamEpicsList(cardumeDir).map((e) => ({ id: e.id, title: e.name })),
    ];
    const e = resolveEpicRef(opts.epicRef, known, me ? specOf(me.spec_json)?.epicId : undefined);
    if (!e.ok) return bad(e.message);
    epicId = e.epicId; epicTitle = e.epicTitle;
  }
  const w = writeRequest(cardumeDir, { kind, by, epic, epicId, epicTitle, tasks });
  if (by.taskId && !w.dup && store.getTask(by.taskId)) store.addEvent(by.taskId, by.agent, "note", `pediu ao app: ${KIND_PT[kind]}${epic ? ` "${epic.title}"` : epicTitle ? ` "${epicTitle}"` : ""}${tasks.length ? ` (${tasks.length} tarefa(s))` : ""} · pedido ${w.id}`, true);
  const waitMs = Math.max(0, opts.waitMs ?? EPIC_REQ_WAIT_MS);
  const res = waitMs ? await waitResult(cardumeDir, w.id, waitMs) : readResult(cardumeDir, w.id);
  return flowFromResult({ id: w.id, kind, dup: w.dup }, res, waitMs);
}

/** `cardume epic status` / tool epic_request_status. */
export function requestStatusText(cardumeDir: string, id?: string): { ok: boolean; text: string; rows: { request: EpicRequest; result: EpicReqResult | null }[] } {
  const q = clean(id);
  const rows = q ? (() => { const r = readRequest(cardumeDir, q); return r ? [{ req: r, result: readResult(cardumeDir, q) }] : []; })() : listRequests(cardumeDir, 10);
  if (!rows.length) return { ok: !q, text: q ? `não achei o pedido ${q}` : "nenhum pedido de épico feito daqui", rows: [] };
  const L = rows.map(({ req, result }) => {
    const what = `${KIND_PT[req.kind]}${req.epic ? ` "${req.epic.title}"` : req.epicTitle ? ` "${req.epicTitle}"` : req.epicId ? ` ${req.epicId}` : ""}${req.tasks.length ? ` · ${req.tasks.map((t) => t.title || t.ref).join(", ")}` : ""}`;
    if (!result) return `- ${req.id} · PENDENTE (o app ainda não executou — precisa estar aberto neste projeto e logado) · ${what}`;
    const f = flowFromResult({ id: req.id, kind: req.kind }, result, 0);
    return `- ${req.id} · ${result.status === "done" ? "FEITO" : result.status === "partial" ? "FEITO EM PARTE" : "RECUSADO"} · ${what}\n  ${flowText(f).replace(/\n/g, "\n  ")}`;
  });
  return { ok: true, text: L.join("\n"), rows: rows.map((r) => ({ request: r.req, result: r.result })) };
}

/** `cardume epic list` / tool list_epics. */
export function epicsListText(cardumeDir: string): string {
  const list = teamEpicsList(cardumeDir);
  const at = teamEpicsAt(cardumeDir);
  if (!list.length) return "ainda não tenho a lista dos épicos do time — ela chega quando o Starfork está aberto neste projeto e logado no time. Dá pra vincular pelo nome mesmo assim (o app procura).";
  return `Épicos do time (atualizado ${at ?? "?"}):\n` + list.map((e) => `- ${e.id} — ${e.name}${e.status ? ` · ${e.status}` : ""}${typeof e.tasks === "number" ? ` · ${e.tasks} tarefa(s)` : ""}`).join("\n");
}

/**
 * O app confirmou na nuvem → a tarefa LOCAL passa a ser (ou deixa de ser) do épico: spec.epicId, cópia do
 * "pronto quando", TASK.yaml e EPIC.md (se a worktree existe). Status, worktree e sessão ficam intactos.
 */
export function applyLocalLink(opts: { store: Store; cardumeDir: string; taskId: string; epicId: string | null; epicTitle?: string; doneWhen?: string[]; seq?: number; by: EditAuthor }): { ok: true; mode: "applied" | "unchanged"; message: string } | { ok: false; message: string } {
  const { store, cardumeDir, by } = opts;
  const t = store.getTask(clean(opts.taskId));
  if (!t) return { ok: false, message: `tarefa ${opts.taskId} não encontrada neste projeto` };
  const spec = specOf(t.spec_json);
  if (!spec) return { ok: false, message: `a spec da tarefa "${t.title}" está ilegível — não gravo por cima` };
  const epicId = opts.epicId ? clean(opts.epicId) : null;
  if (epicId && !SAFE_ID.test(epicId)) return { ok: false, message: "id de épico inválido" };
  const name = clean(opts.epicTitle) || epicId || "";
  const wtCardume = t.worktree ? join(t.worktree, ".cardume") : "";
  const hasWt = !!wtCardume && existsSync(wtCardume);
  const save = (s: TaskSpec) => {
    store.updateSpec(t.id, JSON.stringify(s));
    if (hasWt) try { writeFileSync(join(wtCardume, "TASK.yaml"), taskToYaml(s), "utf8"); } catch { /* worktree sumiu */ }
  };
  const tell = (text: string) => { if (taskIsLive(store, t)) store.addInstruction(t.id, text); };
  if (!epicId) {
    if (!spec.epicId) return { ok: true, mode: "unchanged", message: `a tarefa "${t.title}" já não era de nenhum épico` };
    const old = spec.epicId;
    delete spec.epicId; delete spec.epicDoneWhen; delete spec.epicDoneWhenSeq; delete spec.epicChecks;
    spec.refs = (spec.refs ?? []).filter((r) => !/^EPIC\.md$/i.test(r));
    save(spec);
    if (hasWt) try { unlinkSync(join(wtCardume, "refs", "EPIC.md")); } catch { /* não tinha */ }
    store.addEvent(t.id, by.agent, "note", `tirada do épico ${old} por ${by.agent} (a tarefa continua como estava)`, true);
    tell(`${by.agent} TIROU esta tarefa do épico (${old}). Ela segue igual — o bloco epic saiu do .cardume/TASK.yaml; ignore o EPIC.md antigo.`);
    return { ok: true, mode: "applied", message: `"${t.title}" saiu do épico` };
  }
  const dw = (opts.doneWhen ?? []).map(clean).filter(Boolean);
  if (spec.epicId === epicId && JSON.stringify(spec.epicDoneWhen ?? []) === JSON.stringify(dw)) return { ok: true, mode: "unchanged", message: `"${t.title}" já era deste épico` };
  const moved = spec.epicId && spec.epicId !== epicId ? spec.epicId : null;
  if (spec.epicId !== epicId) { delete spec.epicChecks; spec.refs = (spec.refs ?? []).filter((r) => !/^EPIC\.md$/i.test(r)); }
  spec.epicId = epicId;
  if (dw.length) spec.epicDoneWhen = dw; else delete spec.epicDoneWhen;
  const mx = dw.reduce((m, d) => Math.max(m, Number(/^D(\d+)/i.exec(d)?.[1] ?? 0)), 0);
  if (mx || opts.seq) spec.epicDoneWhenSeq = Math.max(opts.seq ?? 0, mx); else delete spec.epicDoneWhenSeq;
  save(spec);
  if (hasWt) {
    if (moved) try { unlinkSync(join(wtCardume, "refs", "EPIC.md")); } catch { /* não tinha */ }
    try { prepEpicTurn({ store, cardumeDir, spec, cwd: t.worktree }); } catch { /* contexto chega no próximo turno */ }
  }
  store.addEvent(t.id, by.agent, "note", `${moved ? "movida pro" : "vinculada ao"} épico "${name}" por ${by.agent} — a tarefa continua como estava (nada foi recriado nem reiniciado)`, true);
  tell(`Esta tarefa agora faz parte do épico "${name}" (id ${epicId})${moved ? `, e saiu do épico ${moved}` : ""}. Nada foi reiniciado: siga o seu trabalho. O bloco epic do .cardume/TASK.yaml já está atualizado e o .cardume/refs/EPIC.md traz o épico e as irmãs.`);
  return { ok: true, mode: "applied", message: `"${t.title}" ${moved ? "movida pro" : "vinculada ao"} épico "${name}"` };
}
