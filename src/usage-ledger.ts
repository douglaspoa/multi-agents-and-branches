import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import PRICES from "./usage-prices.json" with { type: "json" };
import { isDshLabel } from "./engine/dsh.ts";

/**
 * LIVRO-RAZÃO DE USO DE IA — lado do motor (tarefas, retro/aprendizados, resumo de commit). O MESMO arquivo e o MESMO
 * esquema do app (app/src-tauri/src/usage_ledger.rs): ~/.constellation/usage/usage.sqlite → `ai_usage`. Golden
 * compartilhado: tests/fixtures/usage-golden/ (esquema + normalização). Gravação MELHOR-ESFORÇO: qualquer falha é
 * engolida — a chamada de IA nunca quebra por causa do livro. Nada vai pra nuvem.
 */
export const USAGE_SOURCES = [
  "tarefa", "nova-tarefa", "personas", "chat-projeto", "chat-issues", "orquestrador", "retro", "previsao",
  "titulo-branch", "commit-pr", "relatorios", "outros",
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
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at);
CREATE INDEX IF NOT EXISTS ai_usage_task ON ai_usage(task_id);
CREATE INDEX IF NOT EXISTS ai_usage_source ON ai_usage(source);
CREATE TABLE IF NOT EXISTS claude_session_total (
  session_id TEXT PRIMARY KEY,
  total REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const P = PRICES as { perMillion: Record<string, number>; models?: Record<string, number>; fallback?: number };
/** US$ por milhão de tokens (entrada+saída) — tabela ÚNICA src/usage-prices.json. */
export function pricePerM(engine: string, model = ""): number {
  const m = P.models?.[model.trim()];
  if (typeof m === "number") return m;
  const e = P.perMillion?.[engine];
  return typeof e === "number" ? e : typeof P.fallback === "number" ? P.fallback : 10;
}
const round7 = (x: number) => Math.round(x * 1e7) / 1e7;
export function estimateUsd(engine: string, model: string, inTok: number, outTok: number): number {
  return round7((Math.max(0, inTok) + Math.max(0, outTok)) * pricePerM(engine, model) / 1e6);
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

export interface UsageEntry {
  at?: number;
  source: string;
  project?: string;
  taskId?: string;
  role?: string;
  engine: string;
  model?: string;
  inTok?: number;
  outTok?: number;
  /** custo INFORMADO (Claude); 0 com tokens → estimado pela tabela */
  usd?: number;
  ms?: number;
  ok?: boolean;
  /** sessão do Claude retomada: total ACUMULADO → grava a diferença */
  claudeSession?: string;
  claudeTotal?: number;
}

/** ~/.constellation/usage/usage.sqlite (CARDUME_USAGE_DB sobrepõe — testes). */
export function usageDbPath(): string {
  const o = String(process.env.CARDUME_USAGE_DB ?? "").trim();
  return o || join(homedir(), ".constellation", "usage", "usage.sqlite");
}

/** Grava num banco específico e devolve o que foi gravado (usd/estimado). Lança em erro (o `recordUsage` engole). */
export function recordUsageIn(file: string, e: UsageEntry): { usd: number; estimated: boolean } {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    try { db.exec("PRAGMA journal_mode = WAL;"); } catch { /* outro processo segurando: segue no modo atual */ }
    db.exec(USAGE_SCHEMA);
    const at = e.at ?? Date.now();
    const engine = normEngine(e.engine);
    const model = String(e.model ?? "").trim();
    const inTok = Math.max(0, Math.round(Number(e.inTok) || 0));
    const outTok = Math.max(0, Math.round(Number(e.outTok) || 0));
    let usd = Math.max(0, Number(e.usd) || 0);
    const sid = String(e.claudeSession ?? "").trim();
    const total = Number(e.claudeTotal) || 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const fromSession = engine === "claude" && !!sid && total > 0;
      if (fromSession) {
        const prev = db.prepare("SELECT total FROM claude_session_total WHERE session_id = ?").get(sid) as { total: number } | undefined;
        usd = prev && total >= prev.total ? round7(total - prev.total) : total;
        db.prepare("INSERT INTO claude_session_total (session_id, total, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET total = excluded.total, updated_at = excluded.updated_at").run(sid, total, at);
      }
      const reported = usd > 0 || fromSession;
      const estimated = !reported && (inTok > 0 || outTok > 0);
      if (estimated) usd = estimateUsd(engine, model, inTok, outTok);
      db.prepare(
        "INSERT INTO ai_usage (at, source, project, task_id, role, engine, model, in_tok, out_tok, usd, usd_estimated, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        at, normSource(e.source), e.project || null, e.taskId || null, e.role || null, engine, model || null,
        inTok, outTok, usd, estimated ? 1 : 0, Math.max(0, Math.round(Number(e.ms) || 0)), e.ok === false ? 0 : 1,
      );
      db.exec("COMMIT");
      return { usd, estimated };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* já desfeito */ }
      throw err;
    }
  } finally {
    db.close();
  }
}

/** Grava no livro do usuário — MELHOR-ESFORÇO, nunca lança. Nos testes (`node --test`) só grava com CARDUME_USAGE_DB. */
export function recordUsage(e: UsageEntry): void {
  if (process.env.NODE_TEST_CONTEXT && !String(process.env.CARDUME_USAGE_DB ?? "").trim()) return;
  try {
    recordUsageIn(usageDbPath(), e);
  } catch (err) {
    try { process.stderr.write(`[starfork] livro de uso: não gravei (${(err as Error).message})\n`); } catch { /* sem stderr */ }
  }
}

/** Tokens/custo/sessão do JSON de resultado do Claude (`--output-format json`) — mesma soma do claude.ts. */
export function claudeNumbers(o: any): { inTok: number; outTok: number; usd: number; sessionId: string } {
  const u = o?.usage ?? {};
  const n = (k: string) => Number(u[k]) || 0;
  return {
    inTok: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
    outTok: n("output_tokens"),
    usd: typeof o?.total_cost_usd === "number" ? o.total_cost_usd : typeof o?.cost_usd === "number" ? o.cost_usd : 0,
    sessionId: String(o?.session_id ?? ""),
  };
}
