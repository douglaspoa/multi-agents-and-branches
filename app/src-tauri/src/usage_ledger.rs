//! LIVRO-RAZÃO DE USO DE IA (aba "Uso"): toda chamada de IA do app (Rust) e do motor (TS, src/usage-ledger.ts) grava
//! UMA linha em ~/.constellation/usage/usage.sqlite → `ai_usage(at, source, project, task_id, role, engine, model,
//! in_tok, out_tok, usd, usd_estimated, ms, ok, cached_tok)`. Local (nunca vai pra nuvem), WAL, gravação
//! MELHOR-ESFORÇO e barata: conexão aberta UMA vez por processo (DDL/migração/limpeza só aí), busy_timeout curto e,
//! se o banco estiver ocupado, a linha é descartada — a chamada da IA segue igual (só um aviso no stderr).
//!
//! Custo: o Claude informa (`total_cost_usd`; em sessão retomada o total é ACUMULADO → grava a diferença, com a base
//! da sessão guardada em `claude_session_total` ou, na primeira vez, lida do transcript ANTES do turno —
//! `session_cost_baseline`, porte do motor TS); Codex/DeepSeek/gateway = tokens × tabela ÚNICA (src/usage-prices.json,
//! entrada nova / entrada em cache / saída), `usd_estimated=1`. Golden com o TS: tests/fixtures/usage-golden/.
//!
//! Consulta agregada (`usage_report`, `usage_task_detail`) também aqui: lê o livro + a tabela `cost` dos projetos
//! (histórico de tarefas anterior ao livro) SEM contar duas vezes — o motor grava a linha do livro com o MESMO
//! `at` do `cost.created_at`; cada linha do livro "consome" UMA linha do `cost` com o mesmo (projeto, tarefa, at).
use super::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Origens fixas (o nome na tela vem do front). Qualquer outra vira "outros". `teste` = "testar" do painel Sua IA
/// (testes de conexão — fora do total principal).
pub(crate) const SOURCES: [&str; 13] = [
    "tarefa", "nova-tarefa", "personas", "chat-projeto", "chat-issues", "orquestrador", "retro", "previsao",
    "titulo-branch", "commit-pr", "relatorios", "teste", "outros",
];

/// Esquema — IGUAL ao tests/fixtures/usage-golden/schema.sql e ao USAGE_SCHEMA do TS (testes conferem).
pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS ai_usage (
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
";
/// Migração de banco criado antes de `cached_tok` (o mesmo texto no TS). Erro "duplicate column" = já migrado.
pub(crate) const MIGRATION: &str = "ALTER TABLE ai_usage ADD COLUMN cached_tok INTEGER NOT NULL DEFAULT 0";
const DAY_MS: i64 = 86_400_000;
/// Retenção (a limpeza roda no máximo 1×/dia, marcada em usage_meta.last_prune).
pub(crate) const KEEP_USAGE_DAYS: i64 = 400;
pub(crate) const KEEP_SESSION_DAYS: i64 = 30;

// ---------- preço estimado ----------

const PRICES_JSON: &str = include_str!("../../../src/usage-prices.json");
fn prices() -> &'static Value {
    static P: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    P.get_or_init(|| serde_json::from_str(PRICES_JSON).unwrap_or_else(|_| json!({})))
}
/// US$ por milhão: (entrada nova, entrada em cache, saída).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rate { pub inp: f64, pub cached: f64, pub out: f64 }
fn rate_of(v: &Value) -> Option<Rate> {
    Some(Rate { inp: v["in"].as_f64()?, cached: v["cached_in"].as_f64()?, out: v["out"].as_f64()? })
}
/// Modelo (chave exata ou MAIOR prefixo) → motor → fallback.
pub(crate) fn price_of(engine: &str, model: &str) -> Rate {
    let p = prices();
    let m = model.trim().to_ascii_lowercase();
    if !m.is_empty() {
        if let Some(obj) = p["models"].as_object() {
            let best = obj.iter().filter(|(k, _)| m.starts_with(k.as_str())).max_by_key(|(k, _)| k.len());
            if let Some(r) = best.and_then(|(_, v)| rate_of(v)) { return r; }
        }
    }
    rate_of(&p["engines"][engine]).or_else(|| rate_of(&p["fallback"])).unwrap_or(Rate { inp: 3.0, cached: 0.3, out: 15.0 })
}
/// Custo estimado: `in_tok` = entrada TOTAL (inclui a lida do cache), `cached_tok` = a parte do cache.
pub(crate) fn estimate_usd(engine: &str, model: &str, in_tok: i64, cached_tok: i64, out_tok: i64) -> f64 {
    let r = price_of(engine, model);
    let cached = cached_tok.clamp(0, in_tok.max(0));
    let fresh = in_tok.max(0) - cached;
    round_usd((fresh as f64 * r.inp + cached as f64 * r.cached + out_tok.max(0) as f64 * r.out) / 1e6)
}
fn round_usd(x: f64) -> f64 { (x * 1e10).round() / 1e10 } // 1e-10: estimativas de poucos tokens não viram zero

/// Origem conhecida ou "outros".
pub(crate) fn norm_source(s: &str) -> &'static str {
    let s = s.trim();
    SOURCES.iter().find(|x| **x == s).copied().unwrap_or("outros")
}
/// Rótulo de motor → id (claude | codex | deepseek | gateway); desconhecido → minúsculo cru (ex.: "mock") ou "outro".
pub(crate) fn norm_engine(e: &str) -> String {
    match ai_once::AiEngine::parse(e) {
        Some(x) => x.id().to_string(),
        None => { let t = e.trim().to_ascii_lowercase(); if t.is_empty() { "outro".into() } else { t } }
    }
}
/// Caminho do projeto normalizado (realpath; sem barra no fim) — o mesmo nos dois gravadores e no relatório.
pub(crate) fn norm_project(p: &str) -> String {
    let t = p.trim();
    if t.is_empty() { return String::new(); }
    if let Ok(c) = std::fs::canonicalize(t) { return c.display().to_string(); }
    let s = t.trim_end_matches(['/', '\\']);
    if s.is_empty() { t[..1].to_string() } else { s.to_string() }
}

/// Uma chamada a gravar. `usd` = custo informado; `claude_session` + `claude_total` = total ACUMULADO da sessão do
/// Claude → grava a diferença; `claude_baseline` = total da sessão ANTES do turno (lido do transcript), usado quando o
/// livro ainda não conhece a sessão (sessão começada antes do livro).
#[derive(Clone, Debug, Default)]
pub(crate) struct Entry {
    pub at: i64,
    pub source: String,
    pub project: Option<String>,
    pub task_id: Option<String>,
    pub role: Option<String>,
    pub engine: String,
    pub model: Option<String>,
    pub in_tok: i64,
    pub cached_tok: i64,
    pub out_tok: i64,
    pub usd: f64,
    pub ms: i64,
    pub ok: bool,
    pub claude_session: Option<String>,
    pub claude_total: f64,
    pub claude_baseline: Option<f64>,
}
impl Entry {
    pub(crate) fn new(source: &str, engine: &str) -> Entry {
        Entry { at: now_ms(), source: source.into(), engine: engine.into(), ok: true, ..Default::default() }
    }
}

/// ~/.constellation/usage/usage.sqlite (CARDUME_USAGE_DB sobrepõe — testes).
pub(crate) fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("CARDUME_USAGE_DB") { if !p.trim().is_empty() { return PathBuf::from(p); } }
    PathBuf::from(home_dir_s()).join(".constellation").join("usage").join("usage.sqlite")
}

/// Abre o livro: WAL, busy_timeout CURTO (≤200 ms — quem grava está no caminho quente), esquema, migração e a limpeza
/// diária. Só roda uma vez por processo (a conexão fica em cache em `with_conn`).
pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    if let Some(d) = path.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let c = Connection::open(path).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_millis(200)).map_err(|e| e.to_string())?;
    let _ = c.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()));
    c.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    if let Err(e) = c.execute(MIGRATION, []) { if !e.to_string().contains("duplicate column") { return Err(e.to_string()); } }
    prune(&c, now_ms());
    Ok(c)
}
/// Apaga o que passou da retenção — no máximo uma vez por dia (melhor-esforço).
pub(crate) fn prune(c: &Connection, now: i64) {
    let last: i64 = c.query_row("SELECT v FROM usage_meta WHERE k = 'last_prune'", [], |r| r.get(0)).unwrap_or(0);
    if now - last < DAY_MS { return; }
    let _ = c.execute("DELETE FROM ai_usage WHERE at < ?1", [now - KEEP_USAGE_DAYS * DAY_MS]);
    let _ = c.execute("DELETE FROM claude_session_total WHERE updated_at < ?1", [now - KEEP_SESSION_DAYS * DAY_MS]);
    let _ = c.execute("INSERT INTO usage_meta (k, v) VALUES ('last_prune', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [now]);
}

/// Conexão do processo (por caminho). Erro → a conexão é descartada (reabre na próxima).
fn with_conn<T>(path: &Path, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
    static CONN: Mutex<Option<(PathBuf, Connection)>> = Mutex::new(None);
    let mut g = CONN.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map(|(p, _)| p != path).unwrap_or(true) { *g = None; *g = Some((path.to_path_buf(), open(path)?)); }
    let r = f(&mut g.as_mut().expect("aberta acima").1);
    if r.is_err() { *g = None; }
    r
}

/// Grava num banco ESPECÍFICO e devolve (usd, usd_estimated) gravados. Leitura+escrita da base da sessão numa
/// transação IMMEDIATE (dois processos não calculam a mesma diferença).
pub(crate) fn record_in(path: &Path, e: &Entry) -> Result<(f64, bool), String> {
    with_conn(path, |c| {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let engine = norm_engine(&e.engine);
        let model = e.model.clone().unwrap_or_default();
        let mut usd = e.usd.max(0.0);
        let sid = e.claude_session.as_deref().map(str::trim).unwrap_or("");
        let from_session = engine == "claude" && !sid.is_empty() && e.claude_total > 0.0;
        if from_session {
            let prev: Option<f64> = tx.query_row("SELECT total FROM claude_session_total WHERE session_id = ?1", [sid], |r| r.get(0)).ok();
            let base = prev.or(e.claude_baseline).unwrap_or(0.0);
            usd = if e.claude_total >= base { round_usd(e.claude_total - base) } else { e.claude_total };
            tx.execute(
                "INSERT INTO claude_session_total (session_id, total, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET total = excluded.total, updated_at = excluded.updated_at",
                params![sid, e.claude_total, e.at],
            ).map_err(|e| e.to_string())?;
        }
        let estimated = !(usd > 0.0 || from_session) && (e.in_tok > 0 || e.out_tok > 0);
        if estimated { usd = estimate_usd(&engine, &model, e.in_tok, e.cached_tok, e.out_tok); }
        let project = e.project.as_deref().map(norm_project).filter(|s| !s.is_empty());
        tx.execute(
            "INSERT INTO ai_usage (at, source, project, task_id, role, engine, model, in_tok, out_tok, usd, usd_estimated, ms, ok, cached_tok) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                e.at, norm_source(&e.source), project, e.task_id.as_deref().filter(|s| !s.is_empty()),
                e.role.as_deref().filter(|s| !s.is_empty()), engine, Some(model.as_str()).filter(|s| !s.is_empty()),
                e.in_tok.max(0), e.out_tok.max(0), usd, estimated as i64, e.ms.max(0), e.ok as i64, e.cached_tok.clamp(0, e.in_tok.max(0))
            ],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((usd, estimated))
    })
}

/// Grava no livro do usuário — MELHOR-ESFORÇO: nunca devolve erro nem entra em pânico pra quem chamou; banco ocupado
/// além de 200 ms = linha descartada. Em `cargo test` só grava com CARDUME_USAGE_DB definido.
pub(crate) fn record(e: Entry) {
    if cfg!(test) && std::env::var("CARDUME_USAGE_DB").map(|s| s.trim().is_empty()).unwrap_or(true) { return; }
    let r = std::panic::catch_unwind(|| record_in(&db_path(), &e));
    match r {
        Ok(Err(err)) => eprintln!("[starfork] livro de uso: linha descartada ({err})"),
        Err(_) => eprintln!("[starfork] livro de uso: falha inesperada ao gravar"),
        _ => {}
    }
}

// ---------- Claude ----------

/// Envelope `--output-format json` do Claude: a ÚLTIMA linha que começa com `{` e é o objeto de resultado
/// (`type: "result"`, `result` ou `is_error`). Avisos antes dele (ou texto solto) não contam.
pub(crate) fn claude_envelope(stdout: &str) -> Option<Value> {
    stdout.lines().rev().map(str::trim).filter(|l| l.starts_with('{')).find_map(|l| {
        let v: Value = serde_json::from_str(l).ok()?;
        (v.is_object() && (v["type"] == "result" || v.get("result").is_some() || v.get("is_error").is_some())).then_some(v)
    })
}

/// Modelo de verdade do turno: o de maior custo em `modelUsage` (o Claude também usa um modelo pequeno por baixo).
pub(crate) fn claude_model_of(v: &Value) -> Option<String> {
    v["modelUsage"].as_object()?.iter()
        .max_by(|a, b| a.1["costUSD"].as_f64().unwrap_or(0.0).partial_cmp(&b.1["costUSD"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(k, _)| k.clone())
}

/// Tokens e custo do JSON de resultado do Claude: (entrada TOTAL incl. cache, lida do cache, saída, total_cost_usd,
/// session_id). Mesma soma do motor TS (claude.ts).
pub(crate) fn claude_numbers(v: &Value) -> (i64, i64, i64, f64, String) {
    let u = &v["usage"];
    let n = |k: &str| u[k].as_i64().unwrap_or(0);
    let tin = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    let usd = v["total_cost_usd"].as_f64().or_else(|| v["cost_usd"].as_f64()).unwrap_or(0.0);
    (tin, n("cache_read_input_tokens"), n("output_tokens"), usd, v["session_id"].as_str().unwrap_or("").to_string())
}

/// Custo ACUMULADO de uma sessão do Claude Code ANTES do turno (última linha `cost-state` do transcript
/// <config>/projects/<pasta>/<sessão>.jsonl) — porte do `sessionCostBaseline` do motor TS. 0 quando não achar.
pub(crate) fn session_cost_baseline_in(claude_dir: &Path, sid: &str) -> f64 {
    use std::io::{Read, Seek, SeekFrom};
    if !(8..=80).contains(&sid.len()) || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return 0.0; }
    let Ok(dirs) = std::fs::read_dir(claude_dir.join("projects")) else { return 0.0 };
    for d in dirs.flatten() {
        let f = d.path().join(format!("{sid}.jsonl"));
        let Ok(mut file) = std::fs::File::open(&f) else { continue };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let len = size.min(4 * 1024 * 1024);
        let _ = file.seek(SeekFrom::Start(size - len));
        let mut buf = Vec::with_capacity(len as usize);
        let _ = file.take(len).read_to_end(&mut buf);
        for line in String::from_utf8_lossy(&buf).lines().rev() {
            if !line.contains("\"cost-state\"") { continue; }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if v["type"] == "cost-state" { if let Some(t) = v["totalCostUSD"].as_f64().filter(|t| *t >= 0.0) { return t; } }
            }
        }
        return 0.0;
    }
    0.0
}
/// Base da sessão a retomar (None = conversa nova). Chamar ANTES de rodar o turno.
pub(crate) fn session_baseline(session_id: Option<&str>) -> Option<f64> {
    let sid = session_id.map(str::trim).filter(|s| !s.is_empty() && !s.contains(':'))?;
    Some(session_cost_baseline_in(&plan_usage::claude_config_dir(), sid))
}

/// Linha de um chat/persona do Claude a partir do JSON de resultado (o total da sessão vira diferença). Modelo: o
/// `--model` pedido, senão o de `modelUsage`.
pub(crate) fn claude_entry(source: &str, project: Option<&Path>, model: Option<&str>, baseline: Option<f64>, v: &Value, ms: i64, ok: bool) -> Entry {
    let (tin, cached, tout, total, sid) = claude_numbers(v);
    Entry {
        project: project.map(|p| p.display().to_string()),
        model: model.map(String::from).filter(|m| !m.trim().is_empty()).or_else(|| claude_model_of(v)),
        in_tok: tin, cached_tok: cached, out_tok: tout, ms, ok,
        claude_session: Some(sid).filter(|s| !s.is_empty()),
        claude_total: total,
        claude_baseline: baseline,
        ..Entry::new(source, "claude")
    }
}
/// Mesma coisa a partir da saída CRUA do `claude -p --output-format json` (vale também quando deu erro — ele cobra).
pub(crate) fn claude_output_entry(source: &str, project: Option<&Path>, model: Option<&str>, baseline: Option<f64>, out: &std::process::Output, ms: i64) -> Option<Entry> {
    let v = claude_envelope(&String::from_utf8_lossy(&out.stdout))?;
    let ok = out.status.success() && !v["is_error"].as_bool().unwrap_or(false);
    Some(claude_entry(source, project, model, baseline, &v, ms, ok))
}
pub(crate) fn record_claude_output(tag: &Tag, out: &std::process::Output, started: std::time::Instant) {
    if let Some(e) = claude_output_entry(tag.source, Some(tag.project), tag.model.as_deref(), tag.baseline, out, started.elapsed().as_millis() as i64) { record(e); }
}
/// Etiqueta de uma chamada do Claude num chat: origem, projeto, `--model` pedido e a base da sessão retomada — lida do
/// transcript AQUI, antes do turno rodar (depois dele o transcript já tem o total novo).
pub(crate) struct Tag<'a> { pub source: &'a str, pub project: &'a Path, pub model: Option<String>, pub baseline: Option<f64> }
impl<'a> Tag<'a> {
    pub(crate) fn new(source: &'a str, project: &'a Path, model: &Option<String>, session_id: &Option<String>) -> Tag<'a> {
        Tag { source, project, model: model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(String::from), baseline: session_baseline(session_id.as_deref()) }
    }
}

// ---------------------------------------------------------------------------
// consulta (aba Uso)
// ---------------------------------------------------------------------------

/// Uma linha já normalizada (do livro ou do histórico `cost`).
#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub at: i64,
    pub source: String,
    pub project: Option<String>,
    pub task_id: Option<String>,
    pub role: Option<String>,
    pub engine: String,
    pub model: Option<String>,
    pub in_tok: i64,
    pub cached_tok: i64,
    pub out_tok: i64,
    pub usd: f64,
    pub estimated: bool,
    pub ms: i64,
    pub ok: bool,
    pub legacy: bool,
}

/// Colunas de uma tabela (vazio = tabela não existe).
fn columns(c: &Connection, table: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(mut st) = c.prepare(&format!("PRAGMA table_info({table})")) {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(1)) { out.extend(rows.flatten()); }
    }
    out
}

/// Linhas do livro desde `since` (opcional: só um projeto / só uma tarefa).
pub(crate) fn ledger_rows(path: &Path, since: i64, project: Option<&str>, task: Option<&str>) -> Result<Vec<Row>, String> {
    if !path.exists() { return Ok(vec![]); }
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let _ = c.busy_timeout(std::time::Duration::from_millis(2000));
    let cached = if columns(&c, "ai_usage").contains("cached_tok") { "cached_tok" } else { "0" };
    let mut st = c.prepare(&format!(
        "SELECT at, source, project, task_id, role, engine, model, in_tok, out_tok, usd, usd_estimated, ms, ok, {cached} FROM ai_usage
         WHERE at >= ?1 AND (?2 IS NULL OR project = ?2) AND (?3 IS NULL OR task_id = ?3) ORDER BY at",
    )).map_err(|e| e.to_string())?;
    let rows = st.query_map(params![since, project, task], |r| Ok(Row {
        at: r.get(0)?, source: r.get(1)?, project: r.get(2)?, task_id: r.get(3)?, role: r.get(4)?, engine: r.get(5)?, model: r.get(6)?,
        in_tok: r.get(7)?, out_tok: r.get(8)?, usd: r.get(9)?, estimated: r.get::<_, i64>(10)? != 0, ms: r.get(11)?, ok: r.get::<_, i64>(12)? != 0,
        cached_tok: r.get(13)?, legacy: false,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Quantas linhas do livro existem por (projeto, tarefa, at) — cada uma "consome" UMA linha do `cost`.
pub(crate) type SkipCounts = HashMap<(String, String, i64), usize>;
fn ledger_task_keys(rows: &[Row]) -> SkipCounts {
    let mut m = SkipCounts::new();
    for r in rows.iter().filter(|r| r.source == "tarefa") {
        if let Some(t) = &r.task_id { *m.entry((r.project.clone().unwrap_or_default(), t.clone(), r.at)).or_default() += 1; }
    }
    m
}

/// Histórico da tabela `cost` de UM projeto (tarefas), sem as linhas que o livro já tem. Bancos antigos: as colunas
/// são sondadas (PRAGMA table_info) e as que faltam (`ms`, `task.model`/`roles_json`/`engine`, até a tabela `task`)
/// entram como NULL — o histórico nunca some calado. Devolve também os títulos das tarefas.
pub(crate) fn legacy_rows(repo: &str, since: i64, task: Option<&str>, skip: &mut SkipCounts, default_engine: &str) -> (Vec<Row>, HashMap<String, String>) {
    let db = PathBuf::from(repo).join(".cardume").join("state.sqlite");
    let mut titles = HashMap::new();
    if !db.exists() { return (vec![], titles); }
    let Ok(c) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return (vec![], titles) };
    let _ = c.busy_timeout(std::time::Duration::from_millis(1500));
    let (cc, tc) = (columns(&c, "cost"), columns(&c, "task"));
    if !["task_id", "usd", "in_tok", "out_tok", "created_at"].iter().all(|k| cc.contains(*k)) { return (vec![], titles); }
    if tc.contains("id") && tc.contains("title") {
        if let Ok(mut st) = c.prepare("SELECT id, title FROM task") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default()))) {
                for (id, t) in rows.flatten() { titles.insert(id, t); }
            }
        }
    }
    let col = |set: &HashSet<String>, alias: &str, name: &str| if set.contains(name) { format!("{alias}.{name}") } else { "NULL".to_string() };
    let join = tc.contains("id");
    let tcol = |name: &str| if join { col(&tc, "t", name) } else { "NULL".to_string() };
    let sql = format!(
        "SELECT c.task_id, {}, {}, c.usd, c.in_tok, c.out_tok, {}, c.created_at, {}, {}, {} FROM cost c {} WHERE c.created_at >= ?1 AND (?2 IS NULL OR c.task_id = ?2)",
        col(&cc, "c", "agent"), col(&cc, "c", "role"), col(&cc, "c", "ms"), tcol("engine"), tcol("roles_json"), tcol("model"),
        if join { "LEFT JOIN task t ON t.id = c.task_id" } else { "" },
    );
    let repo_n = norm_project(repo);
    let mut out = vec![];
    let Ok(mut st) = c.prepare(&sql) else { return (out, titles) };
    let Ok(rows) = st.query_map(params![since, task], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, Option<String>>(2)?,
        r.get::<_, Option<f64>>(3)?.unwrap_or(0.0), r.get::<_, Option<i64>>(4)?.unwrap_or(0), r.get::<_, Option<i64>>(5)?.unwrap_or(0),
        r.get::<_, Option<i64>>(6)?.unwrap_or(0), r.get::<_, i64>(7)?, r.get::<_, Option<String>>(8)?.unwrap_or_default(),
        r.get::<_, Option<String>>(9)?.unwrap_or_default(), r.get::<_, Option<String>>(10)?,
    ))) else { return (out, titles) };
    for (task_id, agent, role, usd, tin, tout, ms, at, t_eng, roles, model) in rows.flatten() {
        if let Some(n) = skip.get_mut(&(repo_n.clone(), task_id.clone(), at)).filter(|n| **n > 0) { *n -= 1; continue; }
        let engine = norm_engine(&plan_usage::cost_engine(&agent, role.as_deref(), &roles, &t_eng, default_engine));
        let estimated = usd <= 0.0 && (tin > 0 || tout > 0);
        let usd = if estimated { estimate_usd(&engine, model.as_deref().unwrap_or(""), tin, 0, tout) } else { usd };
        out.push(Row {
            at, source: "tarefa".into(), project: Some(repo_n.clone()), task_id: Some(task_id),
            role: Some(if agent.is_empty() { role.unwrap_or_default() } else { agent }).filter(|s| !s.is_empty()),
            engine, model: model.filter(|m| !m.trim().is_empty()), in_tok: tin, cached_tok: 0, out_tok: tout, usd, estimated, ms, ok: true, legacy: true,
        });
    }
    (out, titles)
}

/// Início do período: "hoje" (ou `since` do front = meia-noite local), "7d", "30d". Desconhecido → 7 d.
pub(crate) fn period_since(period: &str, now: i64, since: Option<i64>) -> i64 {
    match period {
        "hoje" => since.filter(|s| *s > 0 && *s <= now).unwrap_or(now - DAY_MS),
        "30d" => now - 30 * DAY_MS,
        _ => now - 7 * DAY_MS,
    }
}

fn proj_name(p: &str) -> String {
    Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

#[derive(Default, Clone)]
struct Agg { usd: f64, usd_est: f64, in_tok: i64, cached_tok: i64, out_tok: i64, calls: i64, ms: i64 }
impl Agg {
    fn add(&mut self, r: &Row) {
        self.usd += r.usd;
        if r.estimated { self.usd_est += r.usd; }
        self.in_tok += r.in_tok; self.cached_tok += r.cached_tok; self.out_tok += r.out_tok; self.calls += 1; self.ms += r.ms;
    }
    fn json(&self) -> Value {
        json!({ "usd": round_usd(self.usd), "usdEstimated": round_usd(self.usd_est), "usdReported": round_usd(self.usd - self.usd_est),
                "inTok": self.in_tok, "cachedTok": self.cached_tok, "outTok": self.out_tok, "calls": self.calls, "ms": self.ms })
    }
}
fn ranked(m: HashMap<String, Agg>, key: &str) -> Vec<Value> {
    let mut v: Vec<(String, Agg)> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.usd.partial_cmp(&a.1.usd).unwrap_or(std::cmp::Ordering::Equal).then(b.1.calls.cmp(&a.1.calls)).then(a.0.cmp(&b.0)));
    v.into_iter().map(|(k, a)| { let mut j = a.json(); j[key] = json!(k); j }).collect()
}
/// Teto da lista de tarefas no relatório (o total vem em `tasksTotal`).
pub(crate) const TASKS_MAX: usize = 300;

/// Agrega as linhas (livro + histórico) no relatório da aba. Testes de conexão (`teste`) ficam FORA do total
/// principal, somados à parte em `tests`.
pub(crate) fn build_report(period: &str, since: i64, rows: &[Row], titles: &HashMap<(String, String), String>, projects_known: &[String]) -> Value {
    let (mut total, mut tests) = (Agg::default(), Agg::default());
    let (mut by_src, mut by_eng, mut by_proj): (HashMap<String, Agg>, HashMap<String, Agg>, HashMap<String, Agg>) = Default::default();
    let mut by_task: HashMap<(String, String), (Agg, bool)> = HashMap::new();
    for r in rows {
        if r.source == "teste" { tests.add(r); continue; }
        total.add(r);
        by_src.entry(r.source.clone()).or_default().add(r);
        by_eng.entry(r.engine.clone()).or_default().add(r);
        by_proj.entry(r.project.clone().unwrap_or_default()).or_default().add(r);
        if let Some(t) = r.task_id.as_ref().filter(|_| r.source == "tarefa") {
            let e = by_task.entry((r.project.clone().unwrap_or_default(), t.clone())).or_default();
            e.0.add(r);
            e.1 |= r.legacy;
        }
    }
    let projects: Vec<Value> = ranked(by_proj, "project").into_iter().map(|mut j| {
        let p = j["project"].as_str().unwrap_or("").to_string();
        j["name"] = json!(if p.is_empty() { String::new() } else { proj_name(&p) });
        j
    }).collect();
    let tasks_total = by_task.len();
    let mut tasks: Vec<((String, String), (Agg, bool))> = by_task.into_iter().collect();
    tasks.sort_by(|a, b| b.1 .0.usd.partial_cmp(&a.1 .0.usd).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let tasks: Vec<Value> = tasks.into_iter().take(TASKS_MAX).map(|((p, t), (a, legacy))| {
        let mut j = a.json();
        j["taskId"] = json!(t);
        j["project"] = json!(p);
        j["projectName"] = json!(if p.is_empty() { String::new() } else { proj_name(&p) });
        j["title"] = json!(titles.get(&(p.clone(), t.clone())).cloned().unwrap_or_default());
        j["legacy"] = json!(legacy);
        j
    }).collect();
    // todos os projetos conhecidos (filtro da aba), não só os que gastaram no período
    let mut known: Vec<String> = projects_known.iter().map(|p| norm_project(p)).filter(|p| !p.is_empty()).collect();
    for r in rows { if let Some(p) = &r.project { if !known.contains(p) { known.push(p.clone()); } } }
    known.sort_by_key(|p| proj_name(p).to_lowercase());
    known.dedup();
    let projects_all: Vec<Value> = known.iter().map(|p| json!({ "project": p, "name": proj_name(p) })).collect();
    json!({
        "period": period, "since": since,
        "totals": total.json(),
        "tests": tests.json(),
        "bySource": ranked(by_src, "source"),
        "byEngine": ranked(by_eng, "engine"),
        "byProject": projects,
        "projects": projects_all,
        "tasks": tasks,
        "tasksTotal": tasks_total,
    })
}

/// Projetos considerados: o filtro, ou todos os salvos + os que aparecem no livro.
fn report_rows(ledger: &Path, repos: &[String], since: i64, project: Option<&str>, task: Option<&str>, default_engine: &str)
    -> Result<(Vec<Row>, HashMap<(String, String), String>), String> {
    let project = project.map(norm_project);
    let mut rows = ledger_rows(ledger, since, project.as_deref(), task)?;
    let mut skip = ledger_task_keys(&rows);
    let mut all_repos: Vec<String> = match &project { Some(p) => vec![p.clone()], None => repos.iter().map(|r| norm_project(r)).collect() };
    for r in &rows { if let Some(p) = &r.project { if !all_repos.contains(p) && project.is_none() && r.source == "tarefa" { all_repos.push(p.clone()); } } }
    let mut titles = HashMap::new();
    for repo in &all_repos {
        let (legacy, t) = legacy_rows(repo, since, task, &mut skip, default_engine);
        rows.extend(legacy);
        for (id, title) in t { titles.insert((repo.clone(), id), title); }
    }
    Ok((rows, titles))
}

pub(crate) fn report_in(ledger: &Path, repos: &[String], period: &str, since: i64, project: Option<&str>, default_engine: &str) -> Result<Value, String> {
    let (rows, titles) = report_rows(ledger, repos, since, project, None, default_engine)?;
    Ok(build_report(period, since, &rows, &titles, repos))
}

/// Detalhe de UMA tarefa (todo o histórico): por etapa/agente e por rodada.
pub(crate) fn task_detail_in(ledger: &Path, repos: &[String], task_id: &str, project: Option<&str>, default_engine: &str) -> Result<Value, String> {
    let (mut rows, titles) = report_rows(ledger, repos, 0, project, Some(task_id), default_engine)?;
    rows.retain(|r| r.source == "tarefa");
    rows.sort_by_key(|r| r.at);
    let mut total = Agg::default();
    let mut by_role: HashMap<String, (Agg, HashSet<String>)> = HashMap::new();
    for r in &rows {
        total.add(r);
        let e = by_role.entry(r.role.clone().unwrap_or_else(|| "agente".into())).or_default();
        e.0.add(r);
        e.1.insert(r.engine.clone());
    }
    let mut roles: Vec<(String, (Agg, HashSet<String>))> = by_role.into_iter().collect();
    roles.sort_by(|a, b| b.1 .0.usd.partial_cmp(&a.1 .0.usd).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let roles: Vec<Value> = roles.into_iter().map(|(role, (a, engs))| {
        let mut j = a.json();
        let mut e: Vec<String> = engs.into_iter().collect();
        e.sort();
        j["role"] = json!(role);
        j["engines"] = json!(e);
        j
    }).collect();
    let rounds: Vec<Value> = rows.iter().map(|r| json!({
        "at": r.at, "role": r.role, "engine": r.engine, "model": r.model, "inTok": r.in_tok, "cachedTok": r.cached_tok, "outTok": r.out_tok,
        "usd": round_usd(r.usd), "estimated": r.estimated, "ms": r.ms, "ok": r.ok, "legacy": r.legacy,
    })).collect();
    let proj = rows.iter().find_map(|r| r.project.clone()).or_else(|| project.map(norm_project)).unwrap_or_default();
    Ok(json!({
        "taskId": task_id,
        "project": proj,
        "title": titles.get(&(proj.clone(), task_id.to_string())).cloned().unwrap_or_default(),
        "totals": total.json(),
        "byRole": roles,
        "rounds": rounds,
    }))
}

/// Erro humano da aba quando o livro não abre (travado/corrompido) — a IA segue funcionando.
fn human_err(e: String) -> String {
    format!("Não consegui ler o registro de uso (~/.constellation/usage/usage.sqlite) — as chamadas de IA seguem normais, só a contagem ficou indisponível agora. Detalhe: {e}")
}

/// Relatório da aba Uso. Async: nada de disco na thread da janela.
#[tauri::command(async)]
pub(crate) fn usage_report(period: String, project: Option<String>, since: Option<i64>) -> Result<Value, String> {
    let now = now_ms();
    let from = period_since(&period, now, since);
    let project = project.filter(|p| !p.trim().is_empty());
    report_in(&db_path(), &read_project_list(), &period, from, project.as_deref(), &ai_once::pref_engine()).map_err(human_err)
}

/// Detalhe de uma tarefa (etapas/agentes e rodadas).
#[tauri::command(async)]
pub(crate) fn usage_task_detail(task_id: String, project: Option<String>) -> Result<Value, String> {
    let project = project.filter(|p| !p.trim().is_empty());
    task_detail_in(&db_path(), &read_project_list(), &task_id, project.as_deref(), &ai_once::pref_engine()).map_err(human_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("sf-usage-{tag}-{}-{}-{}", std::process::id(), now_ms(), SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }
    fn golden(name: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/usage-golden").join(name)).unwrap()
    }
    #[cfg(unix)]
    fn out(code: i32, stdout: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: stdout.as_bytes().to_vec(), stderr: vec![] }
    }

    #[test]
    fn esquema_igual_ao_golden() {
        assert_eq!(format!("{SCHEMA}-- migração (banco de antes de cached_tok):\n{MIGRATION}").trim(), golden("schema.sql").trim());
    }

    #[test]
    fn banco_antigo_sem_cached_tok_migra_e_continua_lendo() {
        let d = tmp("mig");
        let db = d.join("u.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, project TEXT, task_id TEXT, role TEXT, engine TEXT NOT NULL, model TEXT, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, usd_estimated INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1);
            INSERT INTO ai_usage (at, source, engine, usd) VALUES (strftime('%s','now') * 1000, 'retro', 'claude', 0.5);").unwrap();
        drop(c);
        assert_eq!(ledger_rows(&db, 0, None, None).unwrap()[0].cached_tok, 0, "leitura de banco antigo sem a coluna");
        record_in(&db, &Entry { in_tok: 10, cached_tok: 4, ..Entry::new("retro", "codex") }).unwrap();
        let rows = ledger_rows(&db, 0, None, None).unwrap();
        assert_eq!((rows.len(), rows[1].cached_tok), (2, 4));
    }

    #[test]
    fn origens_fixas() {
        assert_eq!(norm_source("titulo-branch"), "titulo-branch");
        assert_eq!(norm_source("teste"), "teste");
        assert_eq!(norm_source("xyz"), "outros");
        assert_eq!(norm_engine("Codex (gpt-5)"), "codex");
        assert_eq!(norm_engine("dsh-flash"), "deepseek");
        assert_eq!(norm_engine("mock"), "mock");
    }

    #[test]
    fn preco_separado_entrada_cache_saida() {
        let p: Value = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/usage-prices.json")).unwrap()).unwrap();
        let r = |v: &Value| Rate { inp: v["in"].as_f64().unwrap(), cached: v["cached_in"].as_f64().unwrap(), out: v["out"].as_f64().unwrap() };
        assert_eq!(price_of("codex", ""), r(&p["engines"]["codex"]));
        assert_eq!(price_of("claude", "claude-haiku-4-5-20251001"), r(&p["models"]["claude-haiku"]), "maior prefixo do modelo");
        assert_eq!(price_of("codex", "gpt-5-mini"), r(&p["models"]["gpt-5-mini"]), "gpt-5-mini vence gpt-5");
        assert_eq!(price_of("desconhecido", ""), r(&p["fallback"]));
        // 1 M de entrada, 900 mil dela do cache, 100 mil de saída no codex: 0,1·1,25 + 0,9·0,125 + 0,1·10
        assert!((estimate_usd("codex", "", 1_000_000, 900_000, 100_000) - 1.2375).abs() < 1e-9);
        // cache maior que a entrada não gera custo negativo
        assert!((estimate_usd("codex", "", 10, 50, 0) - 10.0 * 0.125 / 1e6).abs() < 1e-12);
    }

    #[test]
    fn normalizacao_igual_ao_golden_ts() {
        let d = tmp("golden");
        let db = d.join("usage.sqlite");
        let g: Value = serde_json::from_str(&golden("normalize.json")).unwrap();
        for (i, case) in g["cases"].as_array().unwrap().iter().enumerate() {
            let x = &case["in"];
            let e = Entry {
                at: 1000 + i as i64,
                source: x["source"].as_str().unwrap().into(),
                engine: x["engine"].as_str().unwrap().into(),
                model: x["model"].as_str().map(String::from),
                in_tok: x["in_tok"].as_i64().unwrap(),
                cached_tok: x["cached_tok"].as_i64().unwrap(),
                out_tok: x["out_tok"].as_i64().unwrap(),
                usd: x["usd"].as_f64().unwrap(),
                claude_session: x["claude_session"].as_str().map(String::from).filter(|s| !s.is_empty()),
                claude_total: x["claude_total"].as_f64().unwrap_or(0.0),
                claude_baseline: x["claude_baseline"].as_f64(),
                ok: true,
                ..Default::default()
            };
            record_in(&db, &e).unwrap();
        }
        let rows = ledger_rows(&db, 0, None, None).unwrap();
        assert_eq!(rows.len(), g["cases"].as_array().unwrap().len());
        for (i, (r, case)) in rows.iter().zip(g["cases"].as_array().unwrap()).enumerate() {
            let o = &case["out"];
            assert_eq!(r.source, o["source"].as_str().unwrap(), "caso {i}");
            assert_eq!(r.engine, o["engine"].as_str().unwrap(), "caso {i}");
            assert!((r.usd - o["usd"].as_f64().unwrap()).abs() < 1e-9, "caso {i}: {} vs {}", r.usd, o["usd"]);
            assert_eq!(r.estimated, o["usd_estimated"].as_i64().unwrap() == 1, "caso {i}");
            assert_eq!(r.cached_tok, o["cached_tok"].as_i64().unwrap(), "caso {i}");
        }
    }

    #[test]
    fn custo_do_json_do_claude_e_modelo_do_model_usage() {
        let v: Value = serde_json::from_str(r#"{"type":"result","result":"oi","session_id":"s9","total_cost_usd":0.042,"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":50},"modelUsage":{"claude-haiku-4-5":{"costUSD":0.001},"claude-sonnet-5":{"costUSD":0.041}}}"#).unwrap();
        assert_eq!(claude_numbers(&v), (1110, 1000, 50, 0.042, "s9".to_string()));
        let d = tmp("cj");
        let db = d.join("u.sqlite");
        let e = claude_entry("nova-tarefa", Some(&d), None, None, &v, 12, true);
        assert_eq!(e.model.as_deref(), Some("claude-sonnet-5"), "modelo de maior custo do modelUsage");
        assert_eq!(claude_entry("nova-tarefa", None, Some("opus"), None, &v, 1, true).model.as_deref(), Some("opus"), "--model pedido vence");
        assert_eq!(record_in(&db, &e).unwrap(), (0.042, false));
        // mesma sessão retomada, total acumulado 0.05 → só a diferença
        let v2: Value = serde_json::from_str(r#"{"session_id":"s9","total_cost_usd":0.05,"usage":{"input_tokens":1,"output_tokens":1}}"#).unwrap();
        let (usd, est) = record_in(&db, &claude_entry("nova-tarefa", None, None, None, &v2, 1, true)).unwrap();
        assert!((usd - 0.008).abs() < 1e-9 && !est);
    }

    #[test]
    fn sessao_antiga_usa_a_base_do_transcript() {
        let d = tmp("base");
        let proj = d.join("projects").join("-x-proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("sess-antiga-1234.jsonl"), "{\"type\":\"user\"}\n{\"type\":\"cost-state\",\"totalCostUSD\":1.5}\n{\"type\":\"assistant\"}\n{\"type\":\"cost-state\",\"totalCostUSD\":2.25}\n{\"type\":\"cost-sta").unwrap();
        assert_eq!(session_cost_baseline_in(&d, "sess-antiga-1234"), 2.25, "última cost-state válida");
        assert_eq!(session_cost_baseline_in(&d, "nao-existe-9999"), 0.0);
        assert_eq!(session_cost_baseline_in(&d, "../../etc"), 0.0, "id inválido");
        assert_eq!(session_baseline(None), None);
        assert_eq!(session_baseline(Some("codex:abc")), None, "sessão de outro motor");
        let db = d.join("u.sqlite");
        let v: Value = serde_json::from_str(r#"{"session_id":"sess-antiga-1234","total_cost_usd":2.4}"#).unwrap();
        let (usd, _) = record_in(&db, &claude_entry("chat-projeto", None, None, Some(2.25), &v, 1, true)).unwrap();
        assert!((usd - 0.15).abs() < 1e-9, "primeira vez no livro: total − base do transcript, não o acumulado inteiro ({usd})");
    }

    #[cfg(unix)]
    #[test]
    fn record_claude_output_sucesso_e_erro() {
        let ok = out(0, "aviso solto\n{\"type\":\"result\",\"is_error\":false,\"result\":\"x\",\"session_id\":\"s-ok\",\"total_cost_usd\":0.01,\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}\n");
        let e = claude_output_entry("orquestrador", Some(Path::new("/x/p/")), Some("claude-sonnet-5"), None, &ok, 9).unwrap();
        assert_eq!((e.source.as_str(), e.engine.as_str(), e.ok, e.in_tok, e.out_tok, e.claude_total, e.model.as_deref()), ("orquestrador", "claude", true, 3, 1, 0.01, Some("claude-sonnet-5")));
        let err = out(1, r#"{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401","session_id":"s-err","total_cost_usd":0.002}"#);
        let e = claude_output_entry("chat-issues", None, None, None, &err, 1).unwrap();
        assert!(!e.ok, "erro dentro do JSON conta, marcado como falha");
        assert_eq!(e.claude_total, 0.002);
        assert!(claude_output_entry("x", None, None, None, &out(1, "sem json"), 1).is_none());
    }

    #[test]
    fn livro_indisponivel_nao_quebra() {
        let d = tmp("bad");
        std::fs::write(d.join("arquivo"), "x").unwrap();
        let bad = d.join("arquivo").join("usage.sqlite");
        assert!(record_in(&bad, &Entry::new("titulo-branch", "claude")).is_err());
        let _lock = crate::ai_once::TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = crate::ai_once::tests::EnvGuard::set(&[("CARDUME_USAGE_DB", bad.display().to_string().as_str())]);
        record(Entry::new("titulo-branch", "claude")); // não entra em pânico
        let corrupt = d.join("c.sqlite");
        std::fs::write(&corrupt, "isto não é sqlite").unwrap();
        assert!(ledger_rows(&corrupt, 0, None, None).is_err());
        assert!(human_err("x".into()).starts_with("Não consegui ler o registro de uso"));
    }

    #[test]
    fn retencao_uma_vez_por_dia() {
        let d = tmp("prune");
        let c = open(&d.join("u.sqlite")).unwrap();
        let now = 1_000 * DAY_MS;
        c.execute("INSERT INTO ai_usage (at, source, engine) VALUES (?1, 'retro', 'claude'), (?2, 'retro', 'claude')", [now - 401 * DAY_MS, now - 10 * DAY_MS]).unwrap();
        c.execute("INSERT INTO claude_session_total (session_id, total, updated_at) VALUES ('a', 1, ?1), ('b', 1, ?2)", [now - 31 * DAY_MS, now - DAY_MS]).unwrap();
        c.execute("DELETE FROM usage_meta", []).unwrap();
        prune(&c, now);
        let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!((n("SELECT COUNT(*) FROM ai_usage"), n("SELECT COUNT(*) FROM claude_session_total")), (1, 1));
        // dentro do mesmo dia não roda de novo
        c.execute("INSERT INTO ai_usage (at, source, engine) VALUES (?1, 'retro', 'claude')", [now - 500 * DAY_MS]).unwrap();
        prune(&c, now + DAY_MS / 2);
        assert_eq!(n("SELECT COUNT(*) FROM ai_usage"), 2);
        prune(&c, now + DAY_MS);
        assert_eq!(n("SELECT COUNT(*) FROM ai_usage"), 1);
    }

    /// Projeto com state.sqlite (tabela task + cost como o motor cria).
    fn fake_repo(d: &Path, name: &str) -> String {
        let repo = d.join(name);
        std::fs::create_dir_all(repo.join(".cardume")).unwrap();
        let c = Connection::open(repo.join(".cardume/state.sqlite")).unwrap();
        c.execute_batch("CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT, engine TEXT, model TEXT, roles_json TEXT NOT NULL DEFAULT '[]');
            CREATE TABLE cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0);").unwrap();
        repo.display().to_string()
    }

    #[test]
    fn relatorio_agrega_e_nao_duplica_historico() {
        let d = tmp("rep");
        let db = d.join("usage.sqlite");
        let repo = fake_repo(&d, "proj-a");
        let c = Connection::open(PathBuf::from(&repo).join(".cardume/state.sqlite")).unwrap();
        c.execute("INSERT INTO task (id, title, engine, roles_json) VALUES ('t1','Filtro por data','claude','[]'), ('t2','Tarefa codex','codex','[]')", []).unwrap();
        // histórico antigo (só no cost): t1 claude US$ 1; t2 codex sem custo (estimado: 1 M entrada + 1 M saída)
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t1','Coder','builder',1.0,100,10,5000,300)", []).unwrap();
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t2','Coder','builder',0,1000000,1000000,5100,0)", []).unwrap();
        // turno NOVO: gravado no cost E no livro com o mesmo at → conta uma vez só (projeto com barra no fim: normaliza)
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t1','Revisor','reviewer',0.5,50,5,6000,200)", []).unwrap();
        record_in(&db, &Entry { at: 6000, project: Some(format!("{repo}/")), task_id: Some("t1".into()), role: Some("Revisor".into()), in_tok: 50, out_tok: 5, usd: 0.5, ms: 200, ..Entry::new("tarefa", "claude") }).unwrap();
        record_in(&db, &Entry { at: 6100, project: Some(repo.clone()), usd: 0.2, in_tok: 10, out_tok: 10, ..Entry::new("nova-tarefa", "claude") }).unwrap();
        record_in(&db, &Entry { at: 6200, project: Some(repo.clone()), in_tok: 1000, out_tok: 1000, ..Entry::new("personas", "codex") }).unwrap();
        // teste de conexão: fora do total
        record_in(&db, &Entry { at: 6300, usd: 0.3, ..Entry::new("teste", "claude") }).unwrap();
        let other = d.join("sem-uso");
        std::fs::create_dir_all(&other).unwrap();
        let r = report_in(&db, &[format!("{repo}/"), other.display().to_string()], "7d", 0, None, "claude").unwrap();
        let codex_t2 = 1.25 + 10.0;
        let personas = (1000.0 * 1.25 + 1000.0 * 10.0) / 1e6;
        let want = 1.0 + codex_t2 + 0.5 + 0.2 + personas;
        assert!((r["totals"]["usd"].as_f64().unwrap() - want).abs() < 1e-6, "{}", r["totals"]);
        assert_eq!(r["totals"]["calls"], 5);
        assert!((r["totals"]["usdEstimated"].as_f64().unwrap() - (codex_t2 + personas)).abs() < 1e-6);
        assert_eq!((r["tests"]["calls"].as_i64(), r["tests"]["usd"].as_f64()), (Some(1), Some(0.3)));
        let src: Vec<&str> = r["bySource"].as_array().unwrap().iter().map(|s| s["source"].as_str().unwrap()).collect();
        assert_eq!(src, vec!["tarefa", "nova-tarefa", "personas"]);
        let eng: Vec<&str> = r["byEngine"].as_array().unwrap().iter().map(|s| s["engine"].as_str().unwrap()).collect();
        assert_eq!(eng, vec!["codex", "claude"]);
        assert_eq!(r["byProject"].as_array().unwrap().len(), 1);
        assert_eq!(r["byProject"][0]["name"], "proj-a");
        let names: Vec<&str> = r["projects"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["proj-a", "sem-uso"], "todos os projetos conhecidos, mesmo sem gasto");
        let tasks = r["tasks"].as_array().unwrap();
        assert_eq!((tasks.len(), r["tasksTotal"].as_u64()), (2, Some(2)));
        assert_eq!(tasks[0]["taskId"], "t2");
        assert_eq!(tasks[1]["title"], "Filtro por data");
        assert!((tasks[1]["usd"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(tasks[1]["calls"], 2);
        let r2 = report_in(&db, &[repo.clone()], "hoje", 6050, None, "claude").unwrap();
        assert_eq!(r2["totals"]["calls"], 2);
        let r3 = report_in(&db, &[repo.clone()], "7d", 0, Some("/nao/existe"), "claude").unwrap();
        assert_eq!(r3["totals"]["calls"], 0);
        // filtro com barra no fim acha o mesmo projeto
        let r4 = report_in(&db, &[repo.clone()], "7d", 0, Some(&format!("{repo}/")), "claude").unwrap();
        assert_eq!(r4["totals"]["calls"], 5);
    }

    #[test]
    fn duas_linhas_de_cost_iguais_so_uma_no_livro_conta_as_duas() {
        let d = tmp("dup");
        let db = d.join("usage.sqlite");
        let repo = fake_repo(&d, "proj-d");
        let c = Connection::open(PathBuf::from(&repo).join(".cardume/state.sqlite")).unwrap();
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at) VALUES ('t1','A','builder',0.1,1,1,7000), ('t1','B','reviewer',0.2,1,1,7000)", []).unwrap();
        record_in(&db, &Entry { at: 7000, project: Some(repo.clone()), task_id: Some("t1".into()), role: Some("A".into()), usd: 0.1, ..Entry::new("tarefa", "claude") }).unwrap();
        let r = report_in(&db, &[repo], "7d", 0, None, "claude").unwrap();
        assert_eq!(r["totals"]["calls"], 2, "uma do livro + a outra do histórico");
        assert!((r["totals"]["usd"].as_f64().unwrap() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn historico_de_banco_antigo_sem_colunas_nao_some() {
        let d = tmp("old");
        let repo = d.join("proj-velho");
        std::fs::create_dir_all(repo.join(".cardume")).unwrap();
        let c = Connection::open(repo.join(".cardume/state.sqlite")).unwrap();
        // task sem model/roles_json/engine; cost sem ms nem role
        c.execute_batch("CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL);
            INSERT INTO task VALUES ('t1', 'Antiga');
            INSERT INTO cost (task_id, agent, usd, in_tok, out_tok, created_at) VALUES ('t1', 'Coder', 0.7, 10, 1, 100);").unwrap();
        let r = report_in(&d.join("nao-existe.sqlite"), &[repo.display().to_string()], "7d", 0, None, "claude").unwrap();
        assert_eq!(r["tasks"][0]["title"], "Antiga");
        assert!((r["totals"]["usd"].as_f64().unwrap() - 0.7).abs() < 1e-9);
        // sem a tabela task: ainda lê o cost
        let repo2 = d.join("proj-sem-task");
        std::fs::create_dir_all(repo2.join(".cardume")).unwrap();
        Connection::open(repo2.join(".cardume/state.sqlite")).unwrap().execute_batch("CREATE TABLE cost (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, agent TEXT NOT NULL, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL);
            INSERT INTO cost (task_id, agent, usd, in_tok, out_tok, created_at) VALUES ('t9', 'X', 0.4, 1, 1, 100);").unwrap();
        let r = report_in(&d.join("nao-existe.sqlite"), &[repo2.display().to_string()], "7d", 0, None, "claude").unwrap();
        assert_eq!(r["totals"]["calls"], 1);
    }

    #[test]
    fn detalhe_da_tarefa_por_agente_e_rodada() {
        let d = tmp("det");
        let db = d.join("usage.sqlite");
        let repo = fake_repo(&d, "proj-b");
        let c = Connection::open(PathBuf::from(&repo).join(".cardume/state.sqlite")).unwrap();
        c.execute("INSERT INTO task (id, title, engine, roles_json) VALUES ('t1','Uma tarefa','claude','[]')", []).unwrap();
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t1','Coder','builder',0.3,100,10,1000,50)", []).unwrap();
        record_in(&db, &Entry { at: 2000, project: Some(repo.clone()), task_id: Some("t1".into()), role: Some("Revisor".into()), usd: 0.1, in_tok: 5, out_tok: 5, ms: 20, ..Entry::new("tarefa", "claude") }).unwrap();
        record_in(&db, &Entry { at: 3000, project: Some(repo.clone()), task_id: Some("t1".into()), role: Some("Coder".into()), usd: 0.2, in_tok: 5, out_tok: 5, ms: 30, ..Entry::new("tarefa", "claude") }).unwrap();
        let r = task_detail_in(&db, &[repo.clone()], "t1", None, "claude").unwrap();
        assert_eq!(r["title"], "Uma tarefa");
        assert_eq!(r["rounds"].as_array().unwrap().len(), 3);
        assert_eq!(r["rounds"][0]["legacy"], true);
        assert_eq!(r["byRole"][0]["role"], "Coder");
        assert!((r["byRole"][0]["usd"].as_f64().unwrap() - 0.5).abs() < 1e-9);
        assert_eq!(r["byRole"][0]["calls"], 2);
        assert!((r["totals"]["usd"].as_f64().unwrap() - 0.6).abs() < 1e-9);
    }

    /// As chaves que a aba Uso lê (golden report.json) são as que o Rust devolve.
    #[test]
    fn formato_do_relatorio_igual_ao_golden_do_front() {
        let g: Value = serde_json::from_str(&golden("report.json")).unwrap();
        let keys = |v: &Value| -> Vec<String> { let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect(); k.sort(); k };
        let d = tmp("fmt");
        let db = d.join("usage.sqlite");
        let repo = fake_repo(&d, "proj-f");
        record_in(&db, &Entry { at: 10, project: Some(repo.clone()), task_id: Some("t1".into()), role: Some("Coder".into()), model: Some("m".into()), usd: 0.1, in_tok: 1, out_tok: 1, ..Entry::new("tarefa", "claude") }).unwrap();
        let r = report_in(&db, &[repo.clone()], "7d", 0, None, "claude").unwrap();
        let gr = &g["report"];
        assert_eq!(keys(&r), keys(gr));
        assert_eq!(keys(&r["totals"]), keys(&gr["totals"]));
        assert_eq!(keys(&r["tests"]), keys(&gr["tests"]));
        for k in ["bySource", "byEngine", "byProject", "projects", "tasks"] { assert_eq!(keys(&r[k][0]), keys(&gr[k][0]), "{k}"); }
        let t = task_detail_in(&db, &[repo], "t1", None, "claude").unwrap();
        let gd = &g["detail"];
        assert_eq!(keys(&t), keys(gd));
        assert_eq!(keys(&t["byRole"][0]), keys(&gd["byRole"][0]));
        assert_eq!(keys(&t["rounds"][0]), keys(&gd["rounds"][0]));
    }

    #[test]
    fn periodo() {
        assert_eq!(period_since("7d", 10 * 86_400_000, None), 3 * 86_400_000);
        assert_eq!(period_since("30d", 40 * 86_400_000, None), 10 * 86_400_000);
        assert_eq!(period_since("hoje", 100_000_000, Some(90_000_000)), 90_000_000);
        assert_eq!(period_since("hoje", 100_000_000, Some(200_000_000)), 100_000_000 - 86_400_000);
    }

    #[test]
    fn projeto_normalizado() {
        let d = tmp("np");
        assert_eq!(norm_project(&format!("{}/", d.display())), d.display().to_string());
        assert_eq!(norm_project("/nao/existe/"), "/nao/existe");
        assert_eq!(norm_project(""), "");
    }
}
