import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import PRICES from "./usage-prices.json" with { type: "json" };
import { isDshLabel } from "./engine/dsh.ts";

/**
 * LIVRO-RAZÃO DE USO DE IA — lado do motor (tarefas, retro/aprendizados, resumo de commit). O MESMO arquivo e o MESMO
 * esquema do app (app/src-tauri/src/usage_ledger.rs): ~/.constellation/usage/usage.sqlite → `ai_usage`. Golden
 * compartilhado: tests/fixtures/usage-golden/ (esquema + normalização). Gravação MELHOR-ESFORÇO e barata (está no laço
 * de eventos do agente): conexão aberta UMA vez por processo (esquema/migração/limpeza só aí), busy_timeout de 200 ms e,
 * se o banco estiver ocupado, a linha é descartada. Nada vai pra nuvem.
 */
export const USAGE_SOURCES = [
  "tarefa", "nova-tarefa", "personas", "chat-projeto", "chat-issues", "orquestrador", "retro", "previsao",
  "titulo-branch", "commit-pr", "relatorios", "teste", "autopilot", "ideia", "outros",
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** Esquema — IGUAL ao tests/fixtures/usage-golden/schema.sql e ao SCHEMA do Rust. */
export const USAGE_SCHEMA = `CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  project TEXT,
  task_id TEXT,
  role TEXT,
  engine TEXT NOT NULL,
  model TEXT,
  in_tok INTEGER NOT NULL DEFAULT 0,
  out_tok INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  usd_estimated INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  cached_tok INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at);
CREATE INDEX IF NOT EXISTS ai_usage_task ON ai_usage(task_id);
CREATE INDEX IF NOT EXISTS ai_usage_source ON ai_usage(source);
CREATE TABLE IF NOT EXISTS claude_session_total (
  session_id TEXT PRIMARY KEY,
  total REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
`;
/** Migração de banco criado antes de `cached_tok` (o mesmo texto no Rust). */
export const USAGE_MIGRATION = "ALTER TABLE ai_usage ADD COLUMN cached_tok INTEGER NOT NULL DEFAULT 0";
const DAY_MS = 86_400_000;
export const KEEP_USAGE_DAYS = 400;
export const KEEP_SESSION_DAYS = 30;

// ---------- preço estimado (tabela única src/usage-prices.json) ----------
export interface Rate { in: number; cached_in: number; out: number }
const P = PRICES as unknown as { engines?: Record<string, Rate>; models?: Record<string, Rate>; fallback?: Rate };
const isRate = (r: any): r is Rate => !!r && typeof r.in === "number" && typeof r.cached_in === "number" && typeof r.out === "number";
/** Modelo (chave exata ou MAIOR prefixo) → motor → fallback. */
export function priceOf(engine: string, model = ""): Rate {
  const m = String(model ?? "").trim().toLowerCase();
  if (m) {
    const best = Object.keys(P.models ?? {}).filter((k) => m.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (best && isRate(P.models![best])) return P.models![best];
  }
  const e = P.engines?.[engine];
  if (isRate(e)) return e;
  return isRate(P.fallback) ? P.fallback : { in: 3, cached_in: 0.3, out: 15 };
}
const roundUsd = (x: number) => Math.round(x * 1e10) / 1e10;
/** `inTok` = entrada TOTAL (inclui a lida do cache), `cachedTok` = a parte do cache. */
export function estimateUsd(engine: string, model: string, inTok: number, cachedTok: number, outTok: number): number {
  const r = priceOf(engine, model);
  const input = Math.max(0, inTok);
  const cached = Math.min(Math.max(0, cachedTok), input);
  return roundUsd(((input - cached) * r.in + cached * r.cached_in + Math.max(0, outTok) * r.out) / 1e6);
}
export function normSource(s: string): UsageSource {
  const t = String(s ?? "").trim();
  return (USAGE_SOURCES as readonly string[]).includes(t) ? (t as UsageSource) : "outros";
}
/** Rótulo de motor → id (claude | codex | deepseek | gateway); desconhecido → minúsculo cru (ex.: "mock") ou "outro". */
export function normEngine(e: string): string {
  // mesma regra do engineOf (ai-once.ts) e do AiEngine::parse (Rust) — sem importar o ai-once (ele importa este arquivo)
  const t = String(e ?? "").trim().toLowerCase();
  if (t.startsWith("codex")) return "codex";
  if (isDshLabel(t)) return "deepseek";
  if (t.startsWith("gateway") || t.startsWith("logcomex")) return "gateway";
  if (t.startsWith("claude")) return "claude";
  return t || "outro";
}
/** Caminho do projeto normalizado (realpath; sem barra no fim) — o mesmo do Rust (norm_project). */
export function normProject(p: string | undefined): string {
  const t = String(p ?? "").trim();
  if (!t) return "";
  try { return realpathSync(t); } catch { /* não existe: só tira a barra */ }
  const s = t.replace(/[\\/]+$/, "");
  return s || t.slice(0, 1);
}

export interface UsageEntry {
  at?: number;
  source: string;
  project?: string;
  taskId?: string;
  role?: string;
  engine: string;
  model?: string;
  /** entrada TOTAL (inclui a lida do cache) */
  inTok?: number;
  /** parte da entrada lida do cache */
  cachedTok?: number;
  outTok?: number;
  /** custo INFORMADO (Claude); 0 com tokens → estimado pela tabela */
  usd?: number;
  ms?: number;
  ok?: boolean;
  /** sessão do Claude retomada: total ACUMULADO → grava a diferença */
  claudeSession?: string;
  claudeTotal?: number;
  /** total da sessão ANTES do turno (transcript) — vale quando o livro ainda não conhece a sessão */
  claudeBaseline?: number;
}

/** ~/.constellation/usage/usage.sqlite (CARDUME_USAGE_DB sobrepõe — testes). */
export function usageDbPath(): string {
  const o = String(process.env.CARDUME_USAGE_DB ?? "").trim();
  return o || join(homedir(), ".constellation", "usage", "usage.sqlite");
}

/** Apaga o que passou da retenção — no máximo uma vez por dia (marcado em usage_meta.last_prune). */
export function pruneUsage(db: DatabaseSync, now = Date.now()): void {
  try {
    const last = Number((db.prepare("SELECT v FROM usage_meta WHERE k = 'last_prune'").get() as { v?: number } | undefined)?.v ?? 0);
    if (now - last < DAY_MS) return;
    db.prepare("DELETE FROM ai_usage WHERE at < ?").run(now - KEEP_USAGE_DAYS * DAY_MS);
    db.prepare("DELETE FROM claude_session_total WHERE updated_at < ?").run(now - KEEP_SESSION_DAYS * DAY_MS);
    db.prepare("INSERT INTO usage_meta (k, v) VALUES ('last_prune', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(now);
  } catch { /* limpeza é melhor-esforço */ }
}

/** Conexão do processo (por arquivo): esquema, migração e limpeza só na abertura. */
const conns = new Map<string, DatabaseSync>();
function conn(file: string): DatabaseSync {
  const hit = conns.get(file);
  if (hit) return hit;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 200;");
    try { db.exec("PRAGMA journal_mode = WAL;"); } catch { /* outro processo segurando: segue no modo atual */ }
    db.exec(USAGE_SCHEMA);
    try { db.exec(USAGE_MIGRATION); } catch (e) { if (!/duplicate column/i.test(String((e as Error).message))) throw e; }
    pruneUsage(db);
  } catch (e) {
    try { db.close(); } catch { /* já fechado */ }
    throw e;
  }
  conns.set(file, db);
  return db;
}
/** Fecha as conexões em cache (testes que apagam a pasta). */
export function closeUsageDbs(): void {
  for (const db of conns.values()) { try { db.close(); } catch { /* já fechado */ } }
  conns.clear();
}

/** Grava num banco específico e devolve o que foi gravado (usd/estimado). Lança em erro (o `recordUsage` engole). */
export function recordUsageIn(file: string, e: UsageEntry): { usd: number; estimated: boolean } {
  const db = conn(file);
  const at = e.at ?? Date.now();
  const engine = normEngine(e.engine);
  const model = String(e.model ?? "").trim();
  const inTok = Math.max(0, Math.round(Number(e.inTok) || 0));
  const cachedTok = Math.min(inTok, Math.max(0, Math.round(Number(e.cachedTok) || 0)));
  const outTok = Math.max(0, Math.round(Number(e.outTok) || 0));
  let usd = Math.max(0, Number(e.usd) || 0);
  const sid = String(e.claudeSession ?? "").trim();
  const total = Number(e.claudeTotal) || 0;
  const fromSession = engine === "claude" && !!sid && total > 0;
  const insert = () => {
    const estimated = !(usd > 0 || fromSession) && (inTok > 0 || outTok > 0);
    if (estimated) usd = estimateUsd(engine, model, inTok, cachedTok, outTok);
    db.prepare(
      "INSERT INTO ai_usage (at, source, project, task_id, role, engine, model, in_tok, out_tok, usd, usd_estimated, ms, ok, cached_tok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      at, normSource(e.source), normProject(e.project) || null, e.taskId || null, e.role || null, engine, model || null,
      inTok, outTok, usd, estimated ? 1 : 0, Math.max(0, Math.round(Number(e.ms) || 0)), e.ok === false ? 0 : 1, cachedTok,
    );
    return { usd, estimated };
  };
  try {
    if (!fromSession) return insert(); // uma instrução só: sem transação explícita
    db.exec("BEGIN IMMEDIATE");
    try {
      const prev = db.prepare("SELECT total FROM claude_session_total WHERE session_id = ?").get(sid) as { total: number } | undefined;
      const base = prev ? prev.total : Number(e.claudeBaseline) || 0;
      usd = total >= base ? roundUsd(total - base) : total;
      db.prepare("INSERT INTO claude_session_total (session_id, total, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET total = excluded.total, updated_at = excluded.updated_at").run(sid, total, at);
      const r = insert();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* já desfeito */ }
      throw err;
    }
  } catch (err) {
    // ocupado/corrompido: descarta a linha e reabre na próxima
    try { db.close(); } catch { /* já fechado */ }
    conns.delete(file);
    throw err;
  }
}

/** Grava no livro do usuário — MELHOR-ESFORÇO, nunca lança (banco ocupado além de 200 ms = linha descartada).
 * Nos testes (`node --test`) só grava com CARDUME_USAGE_DB. */
export function recordUsage(e: UsageEntry): { usd: number; estimated: boolean } | null {
  if (process.env.NODE_TEST_CONTEXT && !String(process.env.CARDUME_USAGE_DB ?? "").trim()) return null;
  try {
    return recordUsageIn(usageDbPath(), e);
  } catch (err) {
    try { process.stderr.write(`[starfork] livro de uso: linha descartada (${(err as Error).message})\n`); } catch { /* sem stderr */ }
    return null;
  }
}

// ---------- Claude ----------

/** Envelope `--output-format json`: a ÚLTIMA linha que começa com `{` e é o objeto de resultado (≡ Rust claude_envelope). */
export function claudeEnvelope(stdout: string): any | undefined {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).reverse();
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object" && !Array.isArray(o) && (o.type === "result" || ("result" in o && "is_error" in o))) return o;
    } catch { /* linha que não é JSON */ }
  }
  return undefined;
}
/** Modelo de verdade do turno: o de maior custo em `modelUsage`. */
export function claudeModelOf(o: any): string | undefined {
  const mu = o?.modelUsage;
  if (!mu || typeof mu !== "object") return undefined;
  return Object.keys(mu).sort((a, b) => (Number(mu[b]?.costUSD) || 0) - (Number(mu[a]?.costUSD) || 0))[0];
}
/** Tokens/custo/sessão do JSON de resultado do Claude — mesma soma do claude.ts (entrada TOTAL e a parte do cache). */
export function claudeNumbers(o: any): { inTok: number; cachedTok: number; outTok: number; usd: number; sessionId: string } {
  const u = o?.usage ?? {};
  const n = (k: string) => Number(u[k]) || 0;
  return {
    inTok: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
    cachedTok: n("cache_read_input_tokens"),
    outTok: n("output_tokens"),
    usd: typeof o?.total_cost_usd === "number" ? o.total_cost_usd : typeof o?.cost_usd === "number" ? o.cost_usd : 0,
    sessionId: String(o?.session_id ?? ""),
  };
}

/** Custo ACUMULADO de uma sessão ANTES do turno (última `cost-state` do transcript) — ≡ sessionCostBaseline (claude.ts)
 * e Rust session_cost_baseline_in; aqui com a pasta do Claude explícita (testes). */
export function sessionCostBaselineIn(claudeDir: string, sessionId: string): number {
  if (!/^[\w-]{8,80}$/.test(sessionId)) return 0;
  try {
    const root = join(claudeDir, "projects");
    for (const d of readdirSync(root)) {
      const f = join(root, d, `${sessionId}.jsonl`);
      if (!existsSync(f)) continue;
      const fd = openSync(f, "r");
      let text = "";
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, 4 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        text = buf.toString("utf8");
      } finally { closeSync(fd); }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"cost-state"')) continue;
        try {
          const o = JSON.parse(lines[i]);
          if (o?.type === "cost-state" && typeof o.totalCostUSD === "number" && o.totalCostUSD >= 0) return o.totalCostUSD;
        } catch { /* linha truncada */ }
      }
      return 0;
    }
  } catch { /* sem pasta do claude */ }
  return 0;
}
