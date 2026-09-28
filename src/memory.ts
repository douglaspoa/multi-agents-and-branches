import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CÉREBRO DO PROJETO — memória contínua em notas markdown ligadas por [[links]]
 * (compatível com Obsidian). Núcleo único usado pelo motor: formato de nota,
 * parser de frontmatter/links, índice, busca por relevância, escrita com dedup,
 * semeadura/colheita da worktree e migração do antigo .cardume/MEMORY.md.
 *
 * Dois cérebros (D1):
 *  - LOCAL: .cardume/memoria/*.md — só nesta máquina;
 *  - TIME:  .cardume/memoria/time/*.md — espelho da nuvem (tabela brain_notes),
 *           sincronizado pelo app (mais recente vence).
 * Os agentes LEEM os dois (salvo o modo "só local"); as memórias novas vão pro
 * destino escolhido em .cardume/memoria.json ({ "mode": "time" | "local" | "so-local" }).
 *
 * Formato, relevância, contexto, filtro de segredo e migração são ESPELHADOS em
 * app/src-tauri/src/memoria.rs (chats do app). O fixture tests/fixtures/memoria-golden/
 * é conferido pelos dois lados (node --test e cargo test): mudou aqui, mude lá.
 */

export const NOTE_TYPES = ["decisão", "regra", "gotcha", "contexto", "pessoa", "glossário"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export type Scope = "local" | "time";
export type BrainMode = "time" | "local" | "so-local";
export type Origem = "agente" | "pessoa";
export type FmValue = string | string[];

export interface Note {
  slug: string;
  title: string;
  type: NoteType;
  tags: string[];
  updated: string;
  by: string;
  origem: Origem;
  /** último a mexer quando não foi o autor (o `by` é sempre o autor original) */
  atualizadaPor: string;
  /** chaves de frontmatter que o app não conhece (aliases, cssclasses do Obsidian…) — preservadas */
  extra: Record<string, FmValue>;
  body: string;
  links: string[];
  scope: Scope;
  mtimeMs: number;
}

export interface NoteInput {
  title: string;
  type?: string;
  tags?: string[];
  body: string;
  by: string;
  origem?: Origem;
  scope?: Scope;
}

export interface WriteResult {
  slug: string;
  scope: Scope;
  /** "secret" = descartada por parecer conter segredo (nada gravado) */
  action: "created" | "updated" | "unchanged" | "secret";
}

/** Teto do contexto injetado: índice + notas completas (nunca o cérebro inteiro). Em caracteres. */
export const INDEX_CAP = 2500;
export const NOTES_CAP = 6000;
/** Teto do corpo de uma nota que cresce por anexos repetidos. */
export const MAX_BODY = 3000;

const KNOWN_KEYS = new Set(["title", "type", "tags", "updated", "by", "origem", "atualizada_por"]);

// ---------------------------------------------------------------------------
// texto (contagem por CARACTERE — igual ao Rust, que conta chars)
// ---------------------------------------------------------------------------

export const clen = (s: string): number => Array.from(s).length;
export const cslice = (s: string, n: number): string => Array.from(s).slice(0, Math.max(0, n)).join("");

export function fold(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** FNV-1a 32 bits sobre os bytes UTF-8 (mesmo hash no Rust). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function slugify(s: string): string {
  const out = fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  if (out) return out;
  const t = String(s ?? "").trim();
  return t ? `nota-${fnv1a(t)}` : "nota"; // título só com escrita não latina: não colapsa tudo em "nota"
}

export function normType(t: unknown): NoteType {
  const f = fold(String(t ?? "")).trim();
  const hit = NOTE_TYPES.find((x) => fold(x) === f);
  if (hit) return hit;
  if (/^decis/.test(f)) return "decisão";
  if (/^glos/.test(f)) return "glossário";
  return "contexto";
}

const STOP = new Set(
  ("a o e de da do das dos em no na nos nas um uma uns umas que se por para pra pro com sem ao aos as os " +
    "mais menos muito pouco como quando onde qual quais isso isto esse essa este esta aqui ali nao sim ja " +
    "tem ter ser estar foi era sao vai vou the and for with from this that you are was were not but all " +
    "tarefa fazer faz feito deve precisa quero preciso sobre entre depois antes ainda tambem so sempre nunca")
    .split(" "),
);

/** Termos significativos (sem acento, minúsculos, ≥3 letras, sem stopwords). */
export function terms(s: string): string[] {
  const out = new Set<string>();
  for (const w of fold(s).split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w)) out.add(w);
  return [...out];
}

function wordMatch(word: string, t: string): boolean {
  if (word === t) return true;
  if (t.length >= 5 && word.startsWith(t)) return true;
  if (word.length >= 5 && t.startsWith(word)) return true;
  return false;
}

/**
 * Sobreposição de palavras (0..1) entre dois textos — base do dedup. Os [[links]] não contam
 * (citar uma nota não faz duas notas serem a mesma) e o denominador é o MAIOR dos dois.
 */
export function similarity(a: string, b: string): number {
  const strip = (s: string) => String(s ?? "").replace(/\[\[[^\]]*\]\]/g, " ");
  const wa = terms(strip(a));
  const wb = new Set(terms(strip(b)));
  if (!wa.length || !wb.size) return 0;
  const hit = wa.filter((w) => wb.has(w)).length;
  return hit / Math.max(wa.length, wb.size);
}

// ---------------------------------------------------------------------------
// segredos: nunca vão pra memória (espelhado em memoria.rs::looks_secret)
// ---------------------------------------------------------------------------

const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  // linha de .env com NOME de credencial (NODE_ENV=production e afins não contam)
  /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH)[A-Z0-9_]*[ \t]*=[ \t]*["']?[^\s"']{8,}/m,
  /\b(api[_-]?key|secret|token|password|senha|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export function looksSecret(s: string): boolean {
  return SECRET_RES.some((re) => re.test(String(s ?? "")));
}

// ---------------------------------------------------------------------------
// formato da nota
// ---------------------------------------------------------------------------

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Frontmatter YAML simples (chave: valor, listas [a, b] ou "- item"). */
export function parseFrontmatter(text: string): { data: Record<string, FmValue>; body: string } {
  const src = String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const data: Record<string, FmValue> = {};
  if (!src.startsWith("---\n")) return { data, body: src };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { data, body: src };
  const head = src.slice(4, end);
  let body = src.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  let lastKey = "";
  for (const line of head.split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && lastKey) {
      const cur = data[lastKey];
      data[lastKey] = [...(Array.isArray(cur) ? cur : cur ? [cur] : []), unquote(item[1])];
      continue;
    }
    const m = line.match(/^([A-Za-zÀ-ú_][\wÀ-ú-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    lastKey = m[1];
    const v = m[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      data[lastKey] = v.slice(1, -1).split(",").map((x) => unquote(x)).filter(Boolean);
    } else {
      data[lastKey] = unquote(v);
    }
  }
  return { data, body };
}

/** Alvos dos [[links]] do corpo (em slug; aceita [[alvo|apelido]] e [[alvo#seção]]). */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(body ?? "")))) out.add(slugify(m[1]));
  return [...out];
}

export function parseNote(text: string, slug: string, scope: Scope = "local", mtimeMs = 0): Note {
  const { data, body } = parseFrontmatter(text);
  const str = (k: string) => (Array.isArray(data[k]) ? (data[k] as string[]).join(", ") : String(data[k] ?? "")).trim();
  const tagsRaw = data.tags;
  const tags = (Array.isArray(tagsRaw) ? tagsRaw : tagsRaw ? String(tagsRaw).split(/[,\s]+/) : [])
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);
  const firstHeading = body.match(/^#\s+(.+)$/m)?.[1];
  const extra: Record<string, FmValue> = {};
  for (const [k, v] of Object.entries(data)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  return {
    slug,
    title: str("title") || firstHeading || slug,
    type: normType(str("type")),
    tags,
    updated: str("updated"),
    by: str("by"),
    origem: str("origem") === "agente" ? "agente" : "pessoa",
    atualizadaPor: str("atualizada_por"),
    extra,
    body: body.trim(),
    links: extractLinks(body),
    scope,
    mtimeMs,
  };
}

export function yamlStr(s: string): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return /^[\wÀ-ſ][\wÀ-ſ .,()/·-]*$/.test(t) && !/:\s|\s#/.test(t) ? t : JSON.stringify(t);
}

type Serializable = Pick<Note, "title" | "type" | "tags" | "updated" | "by" | "origem" | "body"> & Partial<Pick<Note, "atualizadaPor" | "extra">>;

export function serializeNote(n: Serializable): string {
  const list = (v: string[]) => `[${v.map((t) => yamlStr(t)).join(", ")}]`;
  let extra = "";
  for (const [k, v] of Object.entries(n.extra ?? {})) extra += `${k}: ${Array.isArray(v) ? list(v) : yamlStr(v)}\n`;
  return (
    `---\n` +
    `title: ${yamlStr(n.title)}\n` +
    `type: ${n.type}\n` +
    `tags: ${list(n.tags)}\n` +
    `updated: ${n.updated}\n` +
    `by: ${yamlStr(n.by)}\n` +
    `origem: ${n.origem}\n` +
    (n.atualizadaPor ? `atualizada_por: ${yamlStr(n.atualizadaPor)}\n` : "") +
    extra +
    `---\n` +
    `${n.body.trim()}\n`
  );
}

/** Data LOCAL (AAAA-MM-DD) — o Rust usa a mesma (localtime). */
export function today(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 1ª linha útil do corpo: tira "# " (títulos) OU "- "/"* " (itens), nessa ordem; ≤110 chars. */
export function summaryOf(n: Pick<Note, "title" | "body">): string {
  const line = n.body
    .split("\n")
    .map((l) => l.replace(/^#+\s*|^[-*]\s+/, "").trim())
    .find((l) => l && l !== n.title) ?? "";
  return cslice(line.replace(/\s+/g, " "), 110);
}

// ---------------------------------------------------------------------------
// relevância: regras sempre + termos da tarefa + 1 salto de links
// ---------------------------------------------------------------------------

export function scoreNote(n: Note, q: string[]): number {
  if (!q.length) return 0;
  const tw = terms(n.title + " " + n.slug.replace(/-/g, " "));
  const tg = terms(n.tags.join(" "));
  const bw = fold(n.body).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  let s = 0;
  for (const t of q) {
    if (tw.some((w) => wordMatch(w, t))) s += 3;
    if (tg.some((w) => wordMatch(w, t))) s += 3;
    let c = 0;
    for (const w of bw) if (wordMatch(w, t) && ++c >= 3) break;
    s += c;
  }
  return s;
}

const TYPE_ORDER: Record<NoteType, number> = { regra: 0, decisão: 1, gotcha: 2, contexto: 3, glossário: 4, pessoa: 5 };

/**
 * Notas completas em ordem de prioridade (o corte de tamanho é do chamador):
 * 1) TODAS as regras (as que batem com a tarefa primeiro) — regra nunca sai por falta de espaço
 *    pra uma nota menos importante; 2) as 8 mais relevantes; 3) o que elas citam (1 salto).
 */
export function relevantNotes(notes: Note[], query: string): Note[] {
  const q = terms(query);
  const byslug = new Map<string, Note>();
  for (const n of notes) if (!byslug.has(n.slug)) byslug.set(n.slug, n);
  const all = notes.map((n) => ({ n, s: scoreNote(n, q) }));
  const bySc = (a: { n: Note; s: number }, b: { n: Note; s: number }) => b.s - a.s || b.n.mtimeMs - a.n.mtimeMs;
  const rules = all.filter((x) => x.n.type === "regra").sort(bySc);
  const scored = all.filter((x) => x.s > 0).sort(bySc).slice(0, 8);
  const out: Note[] = [];
  const seen = new Set<Note>();
  const push = (n?: Note) => { if (n && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const { n } of rules) push(n);
  for (const { n } of scored) push(n);
  for (const { n } of scored) for (const l of n.links) push(byslug.get(l));
  return out;
}

export function buildIndex(notes: Note[], cap = INDEX_CAP): string {
  const sorted = [...notes].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || b.mtimeMs - a.mtimeMs);
  let out = "";
  let used = 0;
  let shown = 0;
  for (const n of sorted) {
    const sum = summaryOf(n);
    const line = `- [[${n.slug}]] · ${n.type}${n.scope === "time" ? " · time" : ""} · ${n.title}${sum ? ` — ${sum}` : ""}\n`;
    const l = clen(line);
    if (used + l > cap) break;
    out += line;
    used += l;
    shown++;
  }
  if (shown < sorted.length) out += `- … mais ${sorted.length - shown} nota(s): grep -ril "termo" .cardume/memoria/\n`;
  return out;
}

/** Bloco de contexto pro agente: índice + notas relevantes (com teto). "" se o cérebro está vazio. */
export function buildContext(notes: Note[], query: string, caps = { index: INDEX_CAP, notes: NOTES_CAP }): string {
  if (!notes.length) return "";
  let out =
    `## MEMÓRIA DO PROJETO — cérebro de notas (.cardume/memoria/, as do time em .cardume/memoria/time/). ` +
    `Regras e decisões daqui são do humano/time: OBEDEÇA. Pra achar mais: grep -ril "termo" .cardume/memoria/\n` +
    `### Índice\n${buildIndex(notes, caps.index)}`;
  let budget = caps.notes;
  let body = "";
  for (const n of relevantNotes(notes, query)) {
    if (budget <= 0) break;
    const block = `#### ${n.title} (${n.type} · ${n.scope}${n.updated ? ` · ${n.updated}` : ""})\n${n.body}\n\n`;
    const l = clen(block);
    if (l > budget) {
      if (budget > 400 && !body) {
        body += cslice(block, budget - 20) + "…\n\n";
        budget = 0; // cortou: acabou o espaço
      }
      continue;
    }
    body += block;
    budget -= l;
  }
  if (body) out += `### Notas relevantes pra agora\n${body}`;
  return out + "\n";
}

// ---------------------------------------------------------------------------
// o cérebro em disco
// ---------------------------------------------------------------------------

function isPlainNote(dir: string, f: string): boolean {
  if (!f.endsWith(".md") || f.startsWith(".") || f.startsWith("_")) return false;
  try { return lstatSync(join(dir, f)).isFile(); } catch { return false; } // symlink: fora
}

export class Brain {
  readonly cardumeDir: string;
  constructor(cardumeDir: string) {
    this.cardumeDir = cardumeDir;
  }

  get root(): string { return join(this.cardumeDir, "memoria"); }
  get teamDir(): string { return join(this.root, "time"); }
  dirOf(scope: Scope): string { return scope === "time" ? this.teamDir : this.root; }

  /** Onde as memórias novas vão (e se os agentes ignoram o time). */
  mode(): BrainMode {
    try {
      const m = JSON.parse(readFileSync(join(this.cardumeDir, "memoria.json"), "utf8"))?.mode;
      if (m === "time" || m === "local" || m === "so-local") return m;
    } catch { /* sem escolha explícita */ }
    return existsSync(this.teamDir) ? "time" : "local";
  }

  targetScope(): Scope {
    return this.mode() === "time" ? "time" : "local";
  }

  private readDir(scope: Scope): Note[] {
    const dir = this.dirOf(scope);
    let names: string[] = [];
    try { names = readdirSync(dir).sort(); } catch { return []; }
    const out: Note[] = [];
    for (const f of names) {
      if (!isPlainNote(dir, f)) continue;
      const p = join(dir, f);
      try {
        out.push(parseNote(readFileSync(p, "utf8"), f.slice(0, -3), scope, statSync(p).mtimeMs));
      } catch { /* arquivo sumiu no meio */ }
    }
    return out;
  }

  /** Todas as notas que os agentes enxergam (o modo "só local" esconde as do time). */
  list(includeTeam = this.mode() !== "so-local"): Note[] {
    this.migrateLegacy();
    return [...this.readDir("local"), ...(includeTeam ? this.readDir("time") : [])];
  }

  context(query: string): string {
    try {
      return buildContext(this.list(), query);
    } catch {
      return ""; // falha de memória nunca derruba o turno
    }
  }

  private findDuplicate(input: NoteInput, notes: Note[]): Note | undefined {
    const slug = slugify(input.title);
    const same = notes.find((n) => n.slug === slug);
    if (same) return same;
    const probe = `${input.title} ${input.body}`;
    let best: Note | undefined;
    let bestSim = 0;
    for (const n of notes) {
      const s = Math.max(similarity(input.title, n.title), similarity(probe, `${n.title} ${n.body}`));
      if (s > bestSim) { bestSim = s; best = n; }
    }
    return bestSim >= 0.75 ? best : undefined;
  }

  /**
   * Cria ou atualiza (dedup) uma nota. Nunca apaga. Segredo → { action: "secret" } (nada gravado).
   * Atualizar nota existente MANTÉM o autor (by/origem/tipo) e registra `atualizada_por` + data —
   * uma nota de pessoa não vira "nova do agente" porque um agente anexou algo nela.
   * `replace`: o agente editou a nota inteira (harvest da worktree) → o corpo novo vale.
   * `newSlug`: nome de arquivo preferido se a nota for NOVA (o agente já escolheu o nome).
   */
  write(input: NoteInput, opts: { slug?: string; replace?: boolean; newSlug?: string } = {}): WriteResult | null {
    const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    const body = String(input.body ?? "").trim();
    if (!title || !body) return null;
    if (looksSecret(title) || looksSecret(body)) return { slug: "", scope: input.scope ?? this.targetScope(), action: "secret" };
    // só-local: o cérebro do time não é casado nem alterado
    const all = this.list(this.mode() !== "so-local");
    const existing = opts.slug
      ? all.find((n) => n.slug === opts.slug && (!input.scope || n.scope === input.scope)) ?? all.find((n) => n.slug === opts.slug)
      : this.findDuplicate({ ...input, title, body }, all);
    const stamp = today();
    const tags = [...new Set((input.tags ?? []).map((t) => slugify(t)).filter((t) => t !== "nota"))];
    if (existing) {
      let newBody = existing.body;
      if (opts.replace) newBody = body;
      else if (!fold(existing.body).includes(fold(body)) && similarity(body, existing.body) < 0.75) {
        const joined = `${existing.body}\n\n${body}`;
        if (clen(joined) <= MAX_BODY) newBody = joined; // nota cheia: não cresce mais por anexo
      }
      const newTags = [...new Set([...existing.tags, ...tags])];
      const newTitle = opts.replace ? title : existing.title;
      const newType = opts.replace && input.type ? normType(input.type) : existing.type;
      if (newBody === existing.body && newTitle === existing.title && newType === existing.type && newTags.length === existing.tags.length) {
        return { slug: existing.slug, scope: existing.scope, action: "unchanged" };
      }
      const keepAuthor = !!existing.by;
      this.save(existing.scope, existing.slug, serializeNote({
        title: newTitle,
        type: newType,
        tags: newTags,
        updated: stamp,
        by: keepAuthor ? existing.by : input.by,
        origem: keepAuthor ? existing.origem : input.origem ?? "pessoa",
        atualizadaPor: keepAuthor && existing.by !== input.by ? input.by : existing.atualizadaPor,
        extra: existing.extra,
        body: newBody,
      }));
      return { slug: existing.slug, scope: existing.scope, action: "updated" };
    }
    const scope = input.scope ?? this.targetScope();
    let slug = opts.slug || (opts.newSlug ? slugify(opts.newSlug) : slugify(title));
    const taken = new Set([...this.list(true)].filter((n) => n.scope === scope).map((n) => n.slug));
    if (taken.has(slug)) { let i = 2; while (taken.has(`${slug}-${i}`)) i++; slug = `${slug}-${i}`; }
    this.save(scope, slug, serializeNote({ title, type: normType(input.type), tags, updated: stamp, by: input.by, origem: input.origem ?? "pessoa", body }));
    return { slug, scope, action: "created" };
  }

  private save(scope: Scope, slug: string, content: string): void {
    const dir = this.dirOf(scope);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), content, "utf8");
  }

  /**
   * Migra o .cardume/MEMORY.md antigo pra notas (uma por regra). Linha que não
   * parseia vira nota "contexto". O arquivo antigo é RENOMEADO (MEMORY.md.migrado),
   * nunca apagado. Devolve quantas notas gerou (0 = nada a migrar).
   */
  migrateLegacy(): number {
    const legacy = join(this.cardumeDir, "MEMORY.md");
    let txt: string;
    try { txt = readFileSync(legacy, "utf8"); } catch { return 0; }
    const items = parseLegacyMemory(txt);
    let n = 0;
    for (const it of items) {
      const dir = this.dirOf("local");
      mkdirSync(dir, { recursive: true });
      let slug = slugify(it.title);
      while (existsSync(join(dir, `${slug}.md`))) {
        const cur = parseNote(readFileSync(join(dir, `${slug}.md`), "utf8"), slug);
        if (fold(cur.body) === fold(it.body)) break; // mesma nota (migração repetida)
        const m = slug.match(/^(.*)-(\d+)$/);
        slug = m ? `${m[1]}-${Number(m[2]) + 1}` : `${slug}-2`;
      }
      writeFileSync(
        join(dir, `${slug}.md`),
        serializeNote({ title: it.title, type: it.type, tags: ["migrado"], updated: it.date || today(), by: "migrado do MEMORY.md", origem: "pessoa", body: it.body }),
        "utf8",
      );
      n++;
    }
    try { renameSync(legacy, legacy + ".migrado"); } catch { /* outro processo já migrou */ }
    return n;
  }
}

// ---------------------------------------------------------------------------
// worktree: semear (cópia de leitura + manifesto) e colher (só o que o agente mudou)
// ---------------------------------------------------------------------------

/** "local/<slug>" | "time/<slug>" → sha1 do conteúdo no momento da semeadura. */
export type Manifest = Record<string, string>;
export const MANIFEST_FILE = "memoria-manifest.json";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const wtDir = (worktree: string, scope: Scope) =>
  scope === "time" ? join(worktree, ".cardume", "memoria", "time") : join(worktree, ".cardume", "memoria");

/**
 * Copia as notas pra worktree (só .md comuns: sem symlink, sem .obsidian/, sem time/ no modo
 * só-local) e grava o manifesto (hash de cada nota semeada) em .cardume/memoria-manifest.json.
 */
export function seedWorktree(brain: Brain, worktree: string): Manifest {
  const manifest: Manifest = {};
  brain.migrateLegacy();
  const scopes: Scope[] = brain.mode() === "so-local" ? ["local"] : ["local", "time"];
  for (const scope of scopes) {
    const src = brain.dirOf(scope);
    let names: string[] = [];
    try { names = readdirSync(src).sort(); } catch { continue; }
    for (const f of names) {
      if (!isPlainNote(src, f)) continue;
      try {
        const txt = readFileSync(join(src, f), "utf8");
        mkdirSync(wtDir(worktree, scope), { recursive: true });
        cpSync(join(src, f), join(wtDir(worktree, scope), f));
        manifest[`${scope}/${f.slice(0, -3)}`] = sha1(txt);
      } catch { /* nota ilegível: fica de fora */ }
    }
  }
  try {
    mkdirSync(join(worktree, ".cardume"), { recursive: true });
    writeFileSync(join(worktree, ".cardume", MANIFEST_FILE), JSON.stringify(manifest), "utf8");
  } catch { /* sem manifesto a colheita trata tudo como novo — ainda nunca apaga */ }
  return manifest;
}

export function readManifest(worktree: string): Manifest {
  try { return JSON.parse(readFileSync(join(worktree, ".cardume", MANIFEST_FILE), "utf8")) || {}; } catch { return {}; }
}

export interface HarvestResult { written: WriteResult[]; secrets: string[]; manifest: Manifest }

/**
 * Leva pro cérebro SÓ as notas que o agente criou ou mudou desde a semeadura (hash ≠ manifesto).
 * Nunca ressuscita nota apagada/movida no cérebro principal, nunca sobrescreve uma nota que o
 * humano editou depois (arquivo principal mais novo) e descarta segredo. Depois de gravar, a cópia
 * da worktree passa a ser a versão gravada e o manifesto é atualizado: a próxima colheita é no-op.
 */
export function harvestWorktree(cardumeDir: string, worktree: string, manifest: Manifest, by: string): HarvestResult {
  const brain = new Brain(cardumeDir);
  const out: HarvestResult = { written: [], secrets: [], manifest: { ...manifest } };
  const m = out.manifest;
  for (const scope of ["local", "time"] as Scope[]) {
    const wdir = wtDir(worktree, scope);
    let names: string[] = [];
    try { names = readdirSync(wdir).sort(); } catch { continue; }
    for (const f of names) {
      if (!isPlainNote(wdir, f)) continue;
      const slug = f.slice(0, -3);
      const key = `${scope}/${slug}`;
      const wp = join(wdir, f);
      try {
        const wtxt = readFileSync(wp, "utf8");
        const h = sha1(wtxt);
        if (m[key] === h) continue; // o agente não mexeu
        const mp = join(brain.dirOf(scope), f);
        const mainExists = existsSync(mp);
        if (key in m && !mainExists) { m[key] = h; continue; } // apagada/movida no principal: não ressuscita
        if (mainExists && statSync(mp).mtimeMs > statSync(wp).mtimeMs) { m[key] = h; continue; } // humano editou depois
        const n = parseNote(wtxt, slug, scope);
        const r = brain.write(
          { title: n.title, type: n.type, tags: n.tags, body: n.body, by, origem: "agente", scope: mainExists || scope === "time" ? scope : undefined },
          { slug: mainExists ? slug : undefined, replace: mainExists, newSlug: slug },
        );
        if (!r) { m[key] = h; continue; }
        if (r.action === "secret") { out.secrets.push(key); m[key] = h; continue; }
        out.written.push(r);
        // a worktree passa a ter a versão gravada (mesmo nome/escopo)
        const target = join(wtDir(worktree, r.scope), `${r.slug}.md`);
        const saved = readFileSync(join(brain.dirOf(r.scope), `${r.slug}.md`), "utf8");
        mkdirSync(wtDir(worktree, r.scope), { recursive: true });
        writeFileSync(target, saved, "utf8");
        m[`${r.scope}/${r.slug}`] = sha1(saved);
        if (target !== wp) { rmSync(wp, { force: true }); delete m[key]; } // só a cópia da worktree
      } catch { /* uma nota ruim não para as outras */ }
    }
  }
  return out;
}

export function writeManifest(worktree: string, manifest: Manifest): void {
  try { writeFileSync(join(worktree, ".cardume", MANIFEST_FILE), JSON.stringify(manifest), "utf8"); } catch { /* melhor-esforço */ }
}

// ---------------------------------------------------------------------------
// MEMORY.md antigo
// ---------------------------------------------------------------------------

export interface LegacyItem { title: string; type: NoteType; body: string; date: string }

/** "- regra _(aprendido 2026-09-01)_" → regra; blocos de texto solto → contexto. */
export function parseLegacyMemory(txt: string): LegacyItem[] {
  const out: LegacyItem[] = [];
  let loose: string[] = [];
  const flush = () => {
    const body = loose.join("\n").trim();
    loose = [];
    if (!body) return;
    const title = cslice(body.replace(/^#+\s*/, "").split("\n")[0].replace(/[*_`]/g, "").trim(), 70) || "Contexto do projeto";
    out.push({ title, type: "contexto", body, date: "" });
  };
  for (const raw of String(txt ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const m = line.match(/^[-*]\s+(.+?)\s*(?:_\(aprendido\s+(\d{4}-\d{2}-\d{2})\)_)?\s*$/);
    if (m && clen(m[1]) >= 3) {
      flush();
      const rule = m[1].trim();
      out.push({ title: titleFrom(rule), type: "regra", body: rule, date: m[2] ?? "" });
      continue;
    }
    if (!line) { flush(); continue; }
    loose.push(raw);
  }
  flush();
  return out;
}

export function titleFrom(s: string): string {
  const t = s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  if (clen(t) <= 70) return t.replace(/[.;:]$/, "");
  const cut = Array.from(t).slice(0, 70);
  const sp = cut.lastIndexOf(" ");
  return cut.slice(0, sp > 30 ? sp : 70).join("").replace(/[,.;:]$/, "") + "…";
}

/** Extrai o primeiro JSON ({…} ou […]) de uma resposta de LLM. */
export function extractJson(s: string): unknown {
  const txt = String(s ?? "");
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fence ? fence[1] : txt;
  const start = cand.search(/[[{]/);
  if (start < 0) return null;
  const open = cand[start];
  const close = open === "{" ? "}" : "]";
  const end = cand.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(cand.slice(start, end + 1)); } catch { return null; }
}
