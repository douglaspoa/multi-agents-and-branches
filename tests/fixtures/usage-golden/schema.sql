CREATE TABLE IF NOT EXISTS ai_usage (
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
