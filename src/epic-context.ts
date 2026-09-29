// CONTEXTO VIVO DO ÉPICO — o motor não fala com a nuvem, mas as irmãs de um épico quase sempre só existem
// lá (cartões do time). O APP (que tem a sessão) grava `.cardume/epic-context/<epicId>.json` com o épico e
// as irmãs (ids da nuvem e locais, títulos, status, requisitos) e o mantém fresco. Aqui:
//  - todo turno (fresco ou retomado) regenera o .cardume/refs/EPIC.md e a cópia do "pronto quando" no
//    TASK.yaml a partir desse arquivo (prepEpicTurn) — tarefa criada antes continua com ids certos;
//  - a tool epic_tasks / `cardume epic tasks` lista as irmãs;
//  - o alvo do edit_task/edit_epic é RESOLVIDO aqui (id da nuvem, id local ou título) e alvo desconhecido é
//    recusado na hora, listando as irmãs válidas — nada entra na fila "pra quando sincronizar" às cegas;
//  - arquivo ausente/velho → pede refresh (`refresh-request`, o app observa) e espera alguns segundos.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { TaskRow, TaskSpec } from "./types.ts";
import { slugify } from "./types.ts";
import { taskToYaml } from "./util/yaml.ts";

export const CONTEXT_STALE_MS = 15 * 60 * 1000;

export interface EpicSibling {
  cloudId: string;
  localId?: string | null;
  title: string;
  status: string;
  requirements?: string[];
  owner?: string | null;
  /** a tarefa roda (ou rodou) NESTA máquina — existe no banco local */
  machineLocal?: boolean;
}
export interface EpicContext {
  epicId: string;
  title: string;
  description?: string;
  outcome?: string;
  requirements?: { id: string; text: string }[];
  doneWhen?: { id: string; text: string; checked?: boolean }[];
  siblings: EpicSibling[];
  updatedAt: string;
  projectId?: string;
}
/** Uma tarefa do épico como o agente vê: `id` é o que ele passa pro edit_task. */
export interface EpicTaskItem {
  id: string;
  cloudId?: string;
  localId?: string;
  title: string;
  status: string;
  requirements: string[];
  owner?: string | null;
  here: boolean;
}

export const contextDir = (cardumeDir: string) => join(cardumeDir, "epic-context");
const ctxFile = (cardumeDir: string, epicId: string) => join(contextDir(cardumeDir), `${epicId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/** Lê o contexto do épico. null = não existe/ilegível. `age` em ms desde updatedAt. */
export function readEpicContext(cardumeDir: string, epicId: string, now = Date.now()): { ctx: EpicContext; age: number } | null {
  const f = ctxFile(cardumeDir, epicId);
  if (!epicId || !existsSync(f)) return null;
  try {
    const ctx = JSON.parse(readFileSync(f, "utf8")) as EpicContext;
    if (!ctx || ctx.epicId !== epicId || !Array.isArray(ctx.siblings)) return null;
    const t = Date.parse(ctx.updatedAt);
    return { ctx, age: Number.isFinite(t) ? now - t : Infinity };
  } catch { return null; }
}

/** Escrita atômica (tmp + rename) — usado nos testes (o app escreve pelo Rust, do mesmo jeito). */
export function writeEpicContext(cardumeDir: string, ctx: EpicContext): void {
  const dir = contextDir(cardumeDir);
  mkdirSync(dir, { recursive: true });
  const f = ctxFile(cardumeDir, ctx.epicId), tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(ctx), "utf8");
  renameSync(tmp, f);
}

/** Pede ao app um contexto fresco (ele observa o arquivo a cada poucos segundos). Junta pedidos. */
export function requestRefresh(cardumeDir: string, epicIds: string[]): void {
  const dir = contextDir(cardumeDir);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "refresh-request");
  let prev: string[] = [];
  try { prev = (JSON.parse(readFileSync(f, "utf8")).epicIds as string[]) ?? []; } catch { /* sem pedido */ }
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify({ epicIds: [...new Set([...prev, ...epicIds.filter(Boolean)])], at: new Date().toISOString() }), "utf8");
  renameSync(tmp, f);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Contexto fresco pra responder AGORA: se falta ou está velho, pede refresh e espera até `timeoutMs` por um
 * arquivo mais novo que o pedido. Devolve o melhor que tiver (pode ser o velho) + um aviso.
 */
export async function ensureFreshContext(cardumeDir: string, epicId: string, timeoutMs = 5000): Promise<{ ctx: EpicContext | null; warn?: string }> {
  const cur = readEpicContext(cardumeDir, epicId);
  if (cur && cur.age < CONTEXT_STALE_MS) return { ctx: cur.ctx };
  const asked = Date.now();
  requestRefresh(cardumeDir, [epicId]);
  while (Date.now() - asked < timeoutMs) {
    await sleep(200);
    const n = readEpicContext(cardumeDir, epicId);
    if (n && Date.parse(n.ctx.updatedAt) >= asked - 1000) return { ctx: n.ctx };
  }
  return cur
    ? { ctx: cur.ctx, warn: `a lista das irmãs é de ${Math.round(cur.age / 60000)} min atrás (pedi ao app pra atualizar; ele precisa estar aberto e logado)` }
    : { ctx: null, warn: "o app ainda não mandou a lista das irmãs do épico (pedi pra atualizar — o Starfork precisa estar aberto e logado na nuvem). Tente de novo em instantes." };
}

function specOf(t: TaskRow): TaskSpec | null {
  try { return JSON.parse(t.spec_json) as TaskSpec; } catch { return null; }
}

/** Tarefas do épico: irmãs do contexto (nuvem) + as locais deste banco. `id` = o que o agente deve passar. */
export function listEpicTasks(store: Store, ctx: EpicContext | null, epicId: string): EpicTaskItem[] {
  const local = store.listTasks().filter((t) => specOf(t)?.epicId === epicId);
  const byLocal = new Map(local.map((t) => [t.id, t]));
  const out: EpicTaskItem[] = [];
  const seen = new Set<string>();
  for (const s of ctx?.siblings ?? []) {
    const lt = s.localId ? byLocal.get(s.localId) : undefined;
    out.push({
      id: lt ? lt.id : s.cloudId, cloudId: s.cloudId, localId: s.localId && !String(s.localId).startsWith("card-") ? s.localId : undefined,
      title: s.title, status: lt ? lt.status : s.status, requirements: lt ? specOf(lt)?.requirements ?? [] : s.requirements ?? [],
      owner: s.owner ?? null, here: !!lt,
    });
    if (lt) seen.add(lt.id);
  }
  for (const t of local) {
    if (seen.has(t.id)) continue;
    out.push({ id: t.id, localId: t.id, title: t.title, status: t.status, requirements: specOf(t)?.requirements ?? [], here: true });
  }
  return out;
}

const fold = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export function tasksListText(items: { id: string; title: string }[]): string {
  return items.length ? items.map((x) => `${x.id} — ${x.title}`).join("\n") : "(nenhuma tarefa conhecida neste épico)";
}

/**
 * PURA: resolve o alvo do edit_task. Id exato (nuvem ou local) → ok. Título (sem caixa/acento) igual e
 * único → ok; senão prefixo/slug único → ok. Ambíguo ou nada → recusa listando as irmãs (id — título).
 */
export function resolveTaskTarget(query: string, items: EpicTaskItem[]): { ok: true; item: EpicTaskItem } | { ok: false; message: string } {
  const q = String(query ?? "").trim();
  if (!q) return { ok: false, message: "diga QUAL tarefa editar (id ou título). Tarefas do épico:\n" + tasksListText(items) };
  const byId = items.find((x) => x.id === q || x.cloudId === q || x.localId === q);
  if (byId) return { ok: true, item: byId };
  const fq = fold(q), sq = slugify(q);
  const tiers: ((x: EpicTaskItem) => boolean)[] = [
    (x) => fold(x.title) === fq,
    (x) => !!sq && slugify(x.title) === sq,
    (x) => fq.length >= 4 && fold(x.title).startsWith(fq),
    (x) => sq.length >= 6 && (slugify(x.title).startsWith(sq) || sq.startsWith(slugify(x.title))),
  ];
  for (const tier of tiers) {
    const hit = items.filter(tier);
    if (hit.length === 1) return { ok: true, item: hit[0] };
    if (hit.length > 1) return { ok: false, message: `"${q}" bate com mais de uma tarefa — use o id:\n` + tasksListText(hit) };
  }
  return { ok: false, message: `não achei a tarefa "${q}" neste épico. Tarefas válidas (id — título):\n` + tasksListText(items) };
}

/** Épicos conhecidos deste projeto: os das tarefas locais + os que têm contexto gravado. */
export function knownEpics(store: Store, cardumeDir: string): { id: string; title: string }[] {
  const ids = new Set(store.listTasks().map((t) => specOf(t)?.epicId).filter(Boolean) as string[]);
  const dir = contextDir(cardumeDir);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
  return [...ids].map((id) => ({ id, title: readEpicContext(cardumeDir, id)?.ctx.title ?? "" }));
}

/** PURA: resolve o épico do edit_epic — vazio = o da tarefa atual; id exato; ou título único. */
export function resolveEpicTarget(query: string | undefined, epics: { id: string; title: string }[], current?: string): { ok: true; id: string } | { ok: false; message: string } {
  const q = String(query ?? "").trim();
  const list = () => epics.map((e) => `${e.id} — ${e.title || "(sem nome)"}`).join("\n") || "(nenhum)";
  if (!q) return current ? { ok: true, id: current } : { ok: false, message: "esta tarefa não é de um épico — diga qual épico editar:\n" + list() };
  if (epics.some((e) => e.id === q)) return { ok: true, id: q };
  const hit = epics.filter((e) => e.title && fold(e.title) === fold(q));
  if (hit.length === 1) return { ok: true, id: hit[0].id };
  return { ok: false, message: `${hit.length > 1 ? "mais de um épico com esse nome" : `não achei o épico "${q}" neste projeto`}. Épicos válidos (id — título):\n` + list() };
}

/** PURA: EPIC.md com as irmãs e os ids em destaque (o agente passa esses ids pro edit_task). */
export function renderEpicMd(ctx: EpicContext, items: EpicTaskItem[], forTaskId?: string): string {
  const cut = (s: string, n: number) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
  const L = [
    `# Épico: ${cut(ctx.title, 90)}`, "",
    `<!-- Gerado pelo Starfork a cada turno a partir do épico do time (atualizado ${ctx.updatedAt}). -->`, "",
    `**id do épico:** \`${ctx.epicId}\` — a ideia mudou? mcp__cardume__edit_epic (épico) / mcp__cardume__edit_task (irmãs: pelo id abaixo OU pelo título). mcp__cardume__epic_tasks lista as irmãs ao vivo. Nenhum agente é acionado.`, "",
  ];
  if (ctx.outcome || ctx.description) { L.push("## Objetivo", cut(ctx.outcome || ctx.description || "", 400)); if (ctx.outcome && ctx.description) L.push(cut(ctx.description, 300)); L.push(""); }
  if (ctx.requirements?.length) { L.push("## Requisitos do épico"); ctx.requirements.slice(0, 12).forEach((r) => L.push(`- ${r.id}: ${cut(r.text, 200)}`)); L.push(""); }
  if (ctx.doneWhen?.length) { L.push("## Pronto quando (o épico só fecha com tudo marcado)"); ctx.doneWhen.slice(0, 12).forEach((d) => L.push(`- [${d.checked ? "x" : " "}] ${d.id}: ${cut(d.text, 200)}`)); L.push(""); }
  if (items.length) {
    L.push("## Tarefas do épico (id — título)", "As irmãs rodam em paralelo — fique no seu escopo. Pra mudar a spec de uma irmã, passe o **id** (ou o título) pro edit_task.", "");
    for (const x of items.slice(0, 20)) {
      const me = !!forTaskId && x.id === forTaskId;
      L.push(`- **\`${x.id}\`** — ${me ? "**ESTA → **" : ""}${cut(x.title, 90)} · ${x.status}${x.here ? " · neste computador" : ""}${x.owner ? " · com " + cut(x.owner, 30) : ""}`);
      if (!me && x.requirements.length) L.push(`  - requisitos: ${x.requirements.slice(0, 6).map((r) => cut(r, 80)).join(" | ")}`);
    }
    L.push("");
  }
  return L.join("\n");
}

/**
 * Início de TODO turno de uma tarefa de épico: com contexto do app, regenera .cardume/refs/EPIC.md e a cópia
 * do "pronto quando" (TASK.yaml + spec). Sem contexto, deixa o que existe. Contexto ausente/velho → pede
 * refresh (fica fresco pro próximo turno). Muta `spec` (quem chamou usa a versão nova no prompt).
 */
export function prepEpicTurn(opts: { store: Store; cardumeDir: string; spec: TaskSpec; cwd: string }): boolean {
  const { store, cardumeDir, spec, cwd } = opts;
  if (!spec.epicId) return false;
  const r = readEpicContext(cardumeDir, spec.epicId);
  if (!r || r.age >= CONTEXT_STALE_MS) { try { requestRefresh(cardumeDir, [spec.epicId]); } catch { /* sem pasta */ } }
  if (!r) return false;
  const items = listEpicTasks(store, r.ctx, spec.epicId);
  const refs = join(cwd, ".cardume", "refs");
  try { mkdirSync(refs, { recursive: true }); writeFileSync(join(refs, "EPIC.md"), renderEpicMd(r.ctx, items, spec.id), "utf8"); } catch { return false; }
  let changed = false;
  if (!(spec.refs ?? []).some((x) => /^EPIC\.md$/i.test(x))) { spec.refs = [...(spec.refs ?? []), "EPIC.md"]; changed = true; }
  const dw = (r.ctx.doneWhen ?? []).map((d) => `${d.id}: ${d.text}`);
  if (dw.length && JSON.stringify(dw) !== JSON.stringify(spec.epicDoneWhen ?? [])) {
    spec.epicDoneWhen = dw;
    const mx = dw.reduce((m, d) => Math.max(m, Number(/^D(\d+)/.exec(d)?.[1] ?? 0)), 0);
    spec.epicDoneWhenSeq = Math.max(spec.epicDoneWhenSeq ?? 0, mx);
    changed = true;
  }
  if (changed) {
    try { store.updateSpec(spec.id, JSON.stringify(spec)); } catch { /* tarefa de review sem linha */ }
    try { writeFileSync(join(cwd, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8"); } catch { /* worktree sumiu */ }
  }
  return true;
}

/**
 * Alvo do edit_task: id exato de tarefa LOCAL vale direto; senão resolve contra as tarefas do épico (contexto do
 * app + locais), pedindo contexto fresco quando falta/está velho. `cloud` = alvo só na nuvem (vai pra fila do app).
 */
export async function resolveEditTarget(opts: { store: Store; cardumeDir: string; query: string; epicId?: string; timeoutMs?: number }): Promise<
  { ok: true; id: string; cloud: boolean; warn?: string } | { ok: false; message: string }
> {
  const { store, cardumeDir, epicId } = opts;
  const q = String(opts.query ?? "").trim();
  if (q && store.getTask(q)) return { ok: true, id: q, cloud: false };
  if (!epicId) {
    // tarefa fora de épico: só as locais deste projeto (por id ou título)
    const items: EpicTaskItem[] = store.listTasks().map((t) => ({ id: t.id, localId: t.id, title: t.title, status: t.status, requirements: [], here: true }));
    const r = resolveTaskTarget(q, items);
    return r.ok ? { ok: true, id: r.item.id, cloud: false } : r;
  }
  let cur = readEpicContext(cardumeDir, epicId);
  let warn: string | undefined;
  const first = resolveTaskTarget(q, listEpicTasks(store, cur?.ctx ?? null, epicId));
  if (first.ok && (first.item.here || (cur && cur.age < CONTEXT_STALE_MS))) return { ok: true, id: first.item.id, cloud: !first.item.here };
  if (!cur || cur.age >= CONTEXT_STALE_MS) {
    const f = await ensureFreshContext(cardumeDir, epicId, opts.timeoutMs ?? 5000);
    warn = f.warn;
    cur = f.ctx ? { ctx: f.ctx, age: 0 } : null;
  }
  const r = resolveTaskTarget(q, listEpicTasks(store, cur?.ctx ?? null, epicId));
  if (!r.ok) return { ok: false, message: r.message + (warn ? `\n(aviso: ${warn})` : "") };
  return { ok: true, id: r.item.id, cloud: !r.item.here, warn };
}

/** Texto do epic_tasks / `cardume epic tasks`. */
export function epicTasksText(ctx: EpicContext | null, items: EpicTaskItem[], epicId: string, warn?: string): string {
  const L = [`Épico ${ctx?.title ? `"${ctx.title}" ` : ""}(id ${epicId}) — tarefas (passe o id OU o título pro edit_task):`];
  if (warn) L.push(`aviso: ${warn}`);
  for (const x of items) {
    L.push(`- ${x.id} — ${x.title} · ${x.status} · ${x.here ? "neste computador" : "só na nuvem (cartão do time)"}${x.owner ? " · com " + x.owner : ""}`);
    if (x.requirements.length) L.push(`    requisitos: ${x.requirements.slice(0, 10).join(" | ")}`);
  }
  if (!items.length) L.push("(nenhuma tarefa conhecida — o app precisa estar aberto e logado pra mandar as irmãs)");
  return L.join("\n");
}
