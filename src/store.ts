import { DatabaseSync } from "node:sqlite";
import type {
  AgentStatus,
  ClaimMode,
  ClaimRow,
  DiffRow,
  EventRow,
  Review,
  TaskRow,
  TaskSpec,
} from "./types.ts";

/**
 * Persistência do Cardume — um arquivo SQLite por repo (<repo>/.cardume/state.sqlite).
 * É o "DB que o app lê": os agentes gravam eventos aqui (via hooks/MCP no produto
 * final; direto pelo orquestrador na Fase 0) e a UI só observa este arquivo.
 */
export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Tarefas paralelas rodam em processos separados escrevendo no mesmo DB:
    // espera o lock (até 8s) em vez de falhar com "database is locked".
    this.db.exec("PRAGMA busy_timeout = 8000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        agent TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'builder',
        roles_json TEXT NOT NULL DEFAULT '[]',
        branch TEXT NOT NULL,
        worktree TEXT NOT NULL,
        base TEXT NOT NULL,
        engine TEXT NOT NULL,
        model TEXT,
        spec_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        role TEXT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        ok INTEGER
      );
      CREATE TABLE IF NOT EXISTS claim (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        path TEXT NOT NULL,
        mode TEXT NOT NULL,
        yielded_to TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diffstat (
        task_id TEXT PRIMARY KEY,
        files INTEGER NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review (
        task_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        functions_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        how_to_test TEXT NOT NULL,
        by_agent TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commit_summary (
        hash TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,          -- 'question'
        prompt TEXT NOT NULL,
        options TEXT,                -- JSON array de opções, ou null
        status TEXT NOT NULL DEFAULT 'open',  -- open | answered
        answer TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS instruction (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',  -- open | applied
        created_at INTEGER NOT NULL,
        applied_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cost (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        role TEXT,
        usd REAL NOT NULL,
        in_tok INTEGER NOT NULL,
        out_tok INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // migração leve para workspaces antigos (ignora se a coluna já existe)
    for (const stmt of [
      "ALTER TABLE task ADD COLUMN stage TEXT NOT NULL DEFAULT 'builder'",
      "ALTER TABLE task ADD COLUMN roles_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE task ADD COLUMN session_id TEXT",
      "ALTER TABLE task ADD COLUMN sort_order INTEGER",
      "ALTER TABLE task ADD COLUMN done_roles INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE event ADD COLUMN role TEXT",
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        /* coluna já existe */
      }
    }
  }

  createTask(spec: TaskSpec, branch: string, worktree: string, base: string): void {
    this.db
      .prepare(
        `INSERT INTO task (id, title, objective, status, agent, stage, roles_json, branch, worktree, base, engine, model, spec_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        spec.id,
        spec.title,
        spec.objective,
        "queued",
        spec.agent,
        spec.roles[0]?.role ?? "builder",
        JSON.stringify(spec.roles),
        branch,
        worktree,
        base,
        spec.engine,
        spec.model ?? null,
        JSON.stringify(spec),
        Date.now()
      );
  }

  setStatus(taskId: string, status: AgentStatus): void {
    this.db.prepare(`UPDATE task SET status = ? WHERE id = ?`).run(status, taskId);
  }

  setStage(taskId: string, stage: string): void {
    this.db.prepare(`UPDATE task SET stage = ? WHERE id = ?`).run(stage, taskId);
  }

  setDoneRoles(taskId: string, n: number): void {
    this.db.prepare(`UPDATE task SET done_roles = ? WHERE id = ?`).run(n, taskId);
  }

  addEvent(taskId: string, agent: string, type: string, text: string, ok?: boolean, role?: string): number {
    const res = this.db
      .prepare(`INSERT INTO event (task_id, agent, role, ts, type, text, ok) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, agent, role ?? null, Date.now(), type, text, ok === undefined ? null : ok ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  addReview(taskId: string, r: Review): void {
    this.db
      .prepare(
        `INSERT INTO review (task_id, summary, functions_json, files_json, how_to_test, by_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET summary=excluded.summary, functions_json=excluded.functions_json,
           files_json=excluded.files_json, how_to_test=excluded.how_to_test, by_agent=excluded.by_agent, created_at=excluded.created_at`
      )
      .run(
        taskId,
        r.summary,
        JSON.stringify(r.functions),
        JSON.stringify(r.files),
        r.howToTest,
        r.byAgent,
        Date.now()
      );
  }

  getReview(taskId: string): Review | undefined {
    const row = this.db.prepare(`SELECT * FROM review WHERE task_id = ?`).get(taskId) as
      | { summary: string; functions_json: string; files_json: string; how_to_test: string; by_agent: string }
      | undefined;
    if (!row) return undefined;
    return {
      summary: row.summary,
      functions: JSON.parse(row.functions_json),
      files: JSON.parse(row.files_json),
      howToTest: row.how_to_test,
      byAgent: row.by_agent,
    };
  }

  addClaim(taskId: string, agent: string, path: string, mode: ClaimMode, yieldedTo?: string): void {
    this.db
      .prepare(
        `INSERT INTO claim (task_id, agent, path, mode, yielded_to, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(taskId, agent, path, mode, yieldedTo ?? null, Date.now());
  }

  claimsForPath(path: string): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claim WHERE path = ? ORDER BY created_at`).all(path) as ClaimRow[];
  }

  claimsForTask(taskId: string): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claim WHERE task_id = ? ORDER BY created_at`).all(taskId) as ClaimRow[];
  }

  allClaims(): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claim ORDER BY created_at`).all() as ClaimRow[];
  }

  /** Libera os claims de uma tarefa (ela terminou de editar). */
  releaseClaims(taskId: string): void {
    this.db.prepare(`DELETE FROM claim WHERE task_id = ?`).run(taskId);
  }

  setDiff(taskId: string, files: number, add: number, del: number): void {
    this.db
      .prepare(
        `INSERT INTO diffstat (task_id, files, additions, deletions, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET files=excluded.files, additions=excluded.additions, deletions=excluded.deletions, updated_at=excluded.updated_at`
      )
      .run(taskId, files, add, del, Date.now());
  }

  getDiff(taskId: string): DiffRow | undefined {
    return this.db.prepare(`SELECT * FROM diffstat WHERE task_id = ?`).get(taskId) as DiffRow | undefined;
  }

  listTasks(): TaskRow[] {
    return this.db.prepare(`SELECT * FROM task ORDER BY created_at`).all() as TaskRow[];
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM task WHERE id = ?`).get(taskId) as TaskRow | undefined;
  }

  eventsForTask(taskId: string, afterId = 0): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM event WHERE task_id = ? AND id > ? ORDER BY id`)
      .all(taskId, afterId) as EventRow[];
  }

  recentEvents(limit = 8): EventRow[] {
    return this.db.prepare(`SELECT * FROM event ORDER BY id DESC LIMIT ?`).all(limit) as EventRow[];
  }

  deleteTask(taskId: string): void {
    this.db.prepare(`DELETE FROM event WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM claim WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM diffstat WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM review WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM pending WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM instruction WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM cost WHERE task_id = ?`).run(taskId);
    this.db.prepare(`DELETE FROM task WHERE id = ?`).run(taskId);
  }

  // ---------- resumo de commit (gerado pela IA) ----------
  addCommitSummary(hash: string, summary: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO commit_summary (hash, summary, created_at) VALUES (?, ?, ?)`)
      .run(hash, summary, Date.now());
  }

  hasCommitSummary(hash: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM commit_summary WHERE hash = ?`).get(hash);
  }

  // ---------- pending (perguntas do agente para o humano) ----------
  addPending(taskId: string, agent: string, kind: string, prompt: string, options?: string[]): number {
    const res = this.db
      .prepare(`INSERT INTO pending (task_id, agent, kind, prompt, options, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`)
      .run(taskId, agent, kind, prompt, options ? JSON.stringify(options) : null, Date.now());
    return Number(res.lastInsertRowid);
  }

  getPending(id: number): { id: number; status: string; answer: string | null } | undefined {
    return this.db.prepare(`SELECT id, status, answer FROM pending WHERE id = ?`).get(id) as
      | { id: number; status: string; answer: string | null }
      | undefined;
  }

  answerPending(id: number, answer: string): void {
    this.db
      .prepare(`UPDATE pending SET status = 'answered', answer = ?, resolved_at = ? WHERE id = ?`)
      .run(answer, Date.now(), id);
  }

  // ---------- sessão do agente (para --resume) ----------
  setSession(taskId: string, sessionId: string): void {
    this.db.prepare(`UPDATE task SET session_id = ? WHERE id = ?`).run(sessionId, taskId);
  }

  // ---------- instruções do humano no meio da execução ----------
  addInstruction(taskId: string, text: string): number {
    const res = this.db
      .prepare(`INSERT INTO instruction (task_id, text, status, created_at) VALUES (?, ?, 'open', ?)`)
      .run(taskId, text, Date.now());
    return Number(res.lastInsertRowid);
  }

  openInstructions(taskId: string): { id: number; text: string }[] {
    return this.db
      .prepare(`SELECT id, text FROM instruction WHERE task_id = ? AND status = 'open' ORDER BY id`)
      .all(taskId) as { id: number; text: string }[];
  }

  markInstructionApplied(id: number): void {
    this.db.prepare(`UPDATE instruction SET status = 'applied', applied_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  // ---------- custo/tokens por turno de agente ----------
  addCost(taskId: string, agent: string, role: string | undefined, usd: number, inTok: number, outTok: number): void {
    this.db
      .prepare(`INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, agent, role ?? null, usd, inTok, outTok, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
