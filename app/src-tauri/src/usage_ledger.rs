//! LIVRO-RAZÃO DE USO DE IA (aba "Uso"): toda chamada de IA do app (Rust) e do motor (TS, src/usage-ledger.ts) grava
//! UMA linha em ~/.constellation/usage/usage.sqlite → `ai_usage(at, source, project, task_id, role, engine, model,
//! in_tok, out_tok, usd, usd_estimated, ms, ok)`. Local (nunca vai pra nuvem), WAL + busy_timeout, gravação
//! MELHOR-ESFORÇO: falhou → a chamada da IA segue igual (só um aviso no stderr).
//!
//! Custo: o Claude informa (`total_cost_usd`; em sessão retomada o total é ACUMULADO → grava a diferença, guardada em
//! `claude_session_total`); Codex/DeepSeek/gateway = tokens × tabela ÚNICA (src/usage-prices.json), `usd_estimated=1`.
//! Esquema e normalização com golden compartilhado com o TS: tests/fixtures/usage-golden/.
//!
//! Consulta agregada (`usage_report`, `usage_task_detail`) também aqui: lê o livro + a tabela `cost` dos projetos
//! (histórico de tarefas anterior ao livro) SEM contar duas vezes — o motor grava a linha do livro com o MESMO
//! `at` do `cost.created_at`, e a linha do `cost` com par (task_id, created_at) já no livro é pulada.
use super::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Origens fixas (o nome na tela vem do front). Qualquer outra vira "outros".
pub(crate) const SOURCES: [&str; 12] = [
    "tarefa", "nova-tarefa", "personas", "chat-projeto", "chat-issues", "orquestrador", "retro", "previsao",
    "titulo-branch", "commit-pr", "relatorios", "outros",
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
";

/// Tabela única de preço estimado (a mesma que o motor TS importa).
const PRICES_JSON: &str = include_str!("../../../src/usage-prices.json");
fn prices() -> &'static Value {
    static P: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    P.get_or_init(|| serde_json::from_str(PRICES_JSON).unwrap_or_else(|_| json!({ "perMillion": {}, "fallback": 10 })))
}
/// US$ por milhão de tokens (entrada+saída) do motor/modelo.
pub(crate) fn price_per_m(engine: &str, model: &str) -> f64 {
    let p = prices();
    if let Some(r) = p["models"][model.trim()].as_f64() { return r; }
    p["perMillion"][engine].as_f64().or_else(|| p["fallback"].as_f64()).unwrap_or(10.0)
}
pub(crate) fn estimate_usd(engine: &str, model: &str, in_tok: i64, out_tok: i64) -> f64 {
    round7((in_tok.max(0) + out_tok.max(0)) as f64 * price_per_m(engine, model) / 1e6)
}
fn round7(x: f64) -> f64 { (x * 1e7).round() / 1e7 }

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

/// Uma chamada a gravar. `usd` = custo informado (Claude de uma vez/tarefa); `claude_session` + `claude_total` = total
/// ACUMULADO da sessão do Claude (chats retomados) → grava a diferença.
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
    pub out_tok: i64,
    pub usd: f64,
    pub ms: i64,
    pub ok: bool,
    pub claude_session: Option<String>,
    pub claude_total: f64,
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

pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    if let Some(d) = path.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let c = Connection::open(path).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_millis(2000)).map_err(|e| e.to_string())?;
    let _ = c.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()));
    c.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(c)
}

/// Grava num banco ESPECÍFICO e devolve (usd, usd_estimated) gravados.
pub(crate) fn record_in(path: &Path, e: &Entry) -> Result<(f64, bool), String> {
    let mut c = open(path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let engine = norm_engine(&e.engine);
    let model = e.model.clone().unwrap_or_default();
    let mut usd = e.usd.max(0.0);
    let sid = e.claude_session.as_deref().map(str::trim).unwrap_or("");
    if engine == "claude" && !sid.is_empty() && e.claude_total > 0.0 {
        let prev: Option<f64> = tx.query_row("SELECT total FROM claude_session_total WHERE session_id = ?1", [sid], |r| r.get(0)).ok();
        usd = match prev { Some(p) if e.claude_total >= p => round7(e.claude_total - p), _ => e.claude_total };
        tx.execute(
            "INSERT INTO claude_session_total (session_id, total, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET total = excluded.total, updated_at = excluded.updated_at",
            params![sid, e.claude_total, e.at],
        ).map_err(|e| e.to_string())?;
    }
    let reported = usd > 0.0 || (engine == "claude" && !sid.is_empty() && e.claude_total > 0.0);
    let estimated = !reported && (e.in_tok > 0 || e.out_tok > 0);
    if estimated { usd = estimate_usd(&engine, &model, e.in_tok, e.out_tok); }
    tx.execute(
        "INSERT INTO ai_usage (at, source, project, task_id, role, engine, model, in_tok, out_tok, usd, usd_estimated, ms, ok) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            e.at, norm_source(&e.source), e.project.as_deref().filter(|s| !s.is_empty()), e.task_id.as_deref().filter(|s| !s.is_empty()),
            e.role.as_deref().filter(|s| !s.is_empty()), engine, Some(model.as_str()).filter(|s| !s.is_empty()),
            e.in_tok.max(0), e.out_tok.max(0), usd, estimated as i64, e.ms.max(0), e.ok as i64
        ],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((usd, estimated))
}

/// Grava no livro do usuário — MELHOR-ESFORÇO: nunca devolve erro nem entra em pânico pra quem chamou.
/// Em `cargo test` só grava com CARDUME_USAGE_DB definido (nada de sujar o livro de verdade).
pub(crate) fn record(e: Entry) {
    if cfg!(test) && std::env::var("CARDUME_USAGE_DB").map(|s| s.trim().is_empty()).unwrap_or(true) { return; }
    let r = std::panic::catch_unwind(|| record_in(&db_path(), &e));
    match r {
        Ok(Err(err)) => eprintln!("[starfork] livro de uso: não gravei ({err})"),
        Err(_) => eprintln!("[starfork] livro de uso: falha inesperada ao gravar"),
        _ => {}
    }
}

/// Tokens e custo do JSON de resultado do Claude (`--output-format json` ou o `result` do stream-json):
/// (entrada incl. cache, saída, total_cost_usd, session_id). Mesma soma do motor TS (claude.ts).
pub(crate) fn claude_numbers(v: &Value) -> (i64, i64, f64, String) {
    let u = &v["usage"];
    let n = |k: &str| u[k].as_i64().unwrap_or(0);
    let tin = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    let usd = v["total_cost_usd"].as_f64().or_else(|| v["cost_usd"].as_f64()).unwrap_or(0.0);
    (tin, n("output_tokens"), usd, v["session_id"].as_str().unwrap_or("").to_string())
}

/// Linha de um chat/persona do Claude a partir do JSON de resultado (o total da sessão vira diferença).
pub(crate) fn claude_entry(source: &str, project: Option<&Path>, model: Option<&str>, v: &Value, ms: i64, ok: bool) -> Entry {
    let (tin, tout, total, sid) = claude_numbers(v);
    Entry {
        project: project.map(|p| p.display().to_string()),
        model: model.map(String::from).filter(|m| !m.trim().is_empty()),
        in_tok: tin, out_tok: tout, ms, ok,
        claude_session: Some(sid).filter(|s| !s.is_empty()),
        claude_total: total,
        ..Entry::new(source, "claude")
    }
}
/// Mesma coisa a partir da saída CRUA do `claude -p --output-format json` (vale também quando deu erro — ele cobra).
pub(crate) fn record_claude_output(source: &str, project: Option<&Path>, model: Option<&str>, out: &std::process::Output, started: std::time::Instant) {
    let Ok(v) = serde_json::from_slice::<Value>(String::from_utf8_lossy(&out.stdout).trim().as_bytes()) else { return };
    let ok = out.status.success() && !v["is_error"].as_bool().unwrap_or(false);
    record(claude_entry(source, project, model, &v, started.elapsed().as_millis() as i64, ok));
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
    pub out_tok: i64,
    pub usd: f64,
    pub estimated: bool,
    pub ms: i64,
    pub ok: bool,
    pub legacy: bool,
}

/// Linhas do livro desde `since` (opcional: só um projeto / só uma tarefa).
pub(crate) fn ledger_rows(path: &Path, since: i64, project: Option<&str>, task: Option<&str>) -> Result<Vec<Row>, String> {
    if !path.exists() { return Ok(vec![]); }
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let _ = c.busy_timeout(std::time::Duration::from_millis(2000));
    let mut st = c.prepare(
        "SELECT at, source, project, task_id, role, engine, model, in_tok, out_tok, usd, usd_estimated, ms, ok FROM ai_usage
         WHERE at >= ?1 AND (?2 IS NULL OR project = ?2) AND (?3 IS NULL OR task_id = ?3) ORDER BY at",
    ).map_err(|e| e.to_string())?;
    let rows = st.query_map(params![since, project, task], |r| Ok(Row {
        at: r.get(0)?, source: r.get(1)?, project: r.get(2)?, task_id: r.get(3)?, role: r.get(4)?, engine: r.get(5)?, model: r.get(6)?,
        in_tok: r.get(7)?, out_tok: r.get(8)?, usd: r.get(9)?, estimated: r.get::<_, i64>(10)? != 0, ms: r.get(11)?, ok: r.get::<_, i64>(12)? != 0,
        legacy: false,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Pares (task_id, at) das tarefas que já estão no livro — o histórico `cost` com o mesmo par é pulado.
fn ledger_task_keys(rows: &[Row]) -> HashSet<(String, i64)> {
    rows.iter().filter(|r| r.source == "tarefa").filter_map(|r| r.task_id.clone().map(|t| (t, r.at))).collect()
}

/// Histórico da tabela `cost` de UM projeto (tarefas), sem as linhas que o livro já tem. Banco antigo sem `ms` = 0.
/// Devolve também os títulos das tarefas.
pub(crate) fn legacy_rows(repo: &str, since: i64, task: Option<&str>, skip: &HashSet<(String, i64)>, default_engine: &str) -> (Vec<Row>, HashMap<String, String>) {
    let db = PathBuf::from(repo).join(".cardume").join("state.sqlite");
    let mut titles = HashMap::new();
    if !db.exists() { return (vec![], titles); }
    let Ok(c) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return (vec![], titles) };
    let _ = c.busy_timeout(std::time::Duration::from_millis(1500));
    let out: Vec<Row>;
    if let Ok(mut st) = c.prepare("SELECT id, title FROM task") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default()))) {
            for (id, t) in rows.flatten() { titles.insert(id, t); }
        }
    }
    let q = |ms: &str| -> rusqlite::Result<Vec<Row>> {
        let sql = format!(
            "SELECT c.task_id, c.agent, c.role, c.usd, c.in_tok, c.out_tok, {ms}, c.created_at, t.engine, t.roles_json, t.model
             FROM cost c LEFT JOIN task t ON t.id = c.task_id WHERE c.created_at >= ?1 AND (?2 IS NULL OR c.task_id = ?2)"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map(params![since, task], |r| {
            let task_id: String = r.get(0)?;
            let agent: String = r.get::<_, Option<String>>(1)?.unwrap_or_default();
            let role: Option<String> = r.get(2)?;
            let eng_raw = cost_engine_of(&agent, role.as_deref(), &r.get::<_, Option<String>>(9)?.unwrap_or_default(), &r.get::<_, Option<String>>(8)?.unwrap_or_default(), default_engine);
            Ok((task_id, agent, role, r.get::<_, f64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, Option<i64>>(6)?.unwrap_or(0), r.get::<_, i64>(7)?, eng_raw, r.get::<_, Option<String>>(10).ok().flatten()))
        })?;
        let mut v = vec![];
        for x in rows {
            let (task_id, agent, role, usd, tin, tout, ms, at, eng_raw, model) = x?;
            if skip.contains(&(task_id.clone(), at)) { continue; }
            let engine = norm_engine(&eng_raw);
            let estimated = usd <= 0.0 && (tin > 0 || tout > 0);
            let usd = if estimated { estimate_usd(&engine, model.as_deref().unwrap_or(""), tin, tout) } else { usd };
            v.push(Row {
                at, source: "tarefa".into(), project: Some(repo.to_string()), task_id: Some(task_id),
                role: Some(if agent.is_empty() { role.unwrap_or_default() } else { agent }).filter(|s| !s.is_empty()),
                engine, model: model.filter(|m| !m.trim().is_empty()), in_tok: tin, out_tok: tout, usd, estimated, ms, ok: true, legacy: true,
            });
        }
        Ok(v)
    };
    out = match q("c.ms") {
        Ok(v) => v,
        // banco antigo sem a coluna `ms`: soma sem o tempo
        Err(e) if e.to_string().contains("no such column") => q("0").unwrap_or_default(),
        Err(_) => vec![],
    };
    (out, titles)
}
fn cost_engine_of(agent: &str, role: Option<&str>, roles_json: &str, task_engine: &str, default_engine: &str) -> String {
    plan_usage::cost_engine(agent, role, roles_json, task_engine, default_engine)
}

/// Início do período: "hoje" (ou `since` do front = meia-noite local), "7d", "30d". Desconhecido → 7 d.
pub(crate) fn period_since(period: &str, now: i64, since: Option<i64>) -> i64 {
    const DAY: i64 = 86_400_000;
    match period {
        "hoje" => since.filter(|s| *s > 0 && *s <= now).unwrap_or(now - DAY),
        "30d" => now - 30 * DAY,
        _ => now - 7 * DAY,
    }
}

fn proj_name(p: &str) -> String {
    Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

#[derive(Default, Clone)]
struct Agg { usd: f64, usd_est: f64, in_tok: i64, out_tok: i64, calls: i64, ms: i64 }
impl Agg {
    fn add(&mut self, r: &Row) {
        self.usd += r.usd;
        if r.estimated { self.usd_est += r.usd; }
        self.in_tok += r.in_tok; self.out_tok += r.out_tok; self.calls += 1; self.ms += r.ms;
    }
    fn json(&self) -> Value {
        json!({ "usd": round7(self.usd), "usdEstimated": round7(self.usd_est), "usdReported": round7(self.usd - self.usd_est),
                "inTok": self.in_tok, "outTok": self.out_tok, "calls": self.calls, "ms": self.ms })
    }
}
fn ranked(m: HashMap<String, Agg>, key: &str) -> Vec<Value> {
    let mut v: Vec<(String, Agg)> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.usd.partial_cmp(&a.1.usd).unwrap_or(std::cmp::Ordering::Equal).then(b.1.calls.cmp(&a.1.calls)).then(a.0.cmp(&b.0)));
    v.into_iter().map(|(k, a)| { let mut j = a.json(); j[key] = json!(k); j }).collect()
}

/// Agrega as linhas (livro + histórico) no relatório da aba.
pub(crate) fn build_report(period: &str, since: i64, rows: &[Row], titles: &HashMap<(String, String), String>) -> Value {
    let mut total = Agg::default();
    let (mut by_src, mut by_eng, mut by_proj): (HashMap<String, Agg>, HashMap<String, Agg>, HashMap<String, Agg>) = Default::default();
    let mut by_task: HashMap<(String, String), (Agg, bool)> = HashMap::new();
    for r in rows {
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
    let mut tasks: Vec<((String, String), (Agg, bool))> = by_task.into_iter().collect();
    tasks.sort_by(|a, b| b.1 .0.usd.partial_cmp(&a.1 .0.usd).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let tasks: Vec<Value> = tasks.into_iter().take(300).map(|((p, t), (a, legacy))| {
        let mut j = a.json();
        j["taskId"] = json!(t);
        j["project"] = json!(p);
        j["projectName"] = json!(if p.is_empty() { String::new() } else { proj_name(&p) });
        j["title"] = json!(titles.get(&(p.clone(), t.clone())).cloned().unwrap_or_default());
        j["legacy"] = json!(legacy);
        j
    }).collect();
    json!({
        "period": period, "since": since,
        "totals": total.json(),
        "bySource": ranked(by_src, "source"),
        "byEngine": ranked(by_eng, "engine"),
        "byProject": projects,
        "tasks": tasks,
    })
}

/// Projetos considerados: o filtro, ou todos os salvos + os que aparecem no livro.
fn report_rows(ledger: &Path, repos: &[String], since: i64, project: Option<&str>, task: Option<&str>, default_engine: &str)
    -> Result<(Vec<Row>, HashMap<(String, String), String>), String> {
    let mut rows = ledger_rows(ledger, since, project, task)?;
    let skip = ledger_task_keys(&rows);
    let mut all_repos: Vec<String> = match project { Some(p) => vec![p.to_string()], None => repos.to_vec() };
    for r in &rows { if let Some(p) = &r.project { if !all_repos.contains(p) && project.is_none() && r.source == "tarefa" { all_repos.push(p.clone()); } } }
    let mut titles = HashMap::new();
    for repo in &all_repos {
        let (legacy, t) = legacy_rows(repo, since, task, &skip, default_engine);
        rows.extend(legacy);
        for (id, title) in t { titles.insert((repo.clone(), id), title); }
    }
    Ok((rows, titles))
}

pub(crate) fn report_in(ledger: &Path, repos: &[String], period: &str, since: i64, project: Option<&str>, default_engine: &str) -> Result<Value, String> {
    let (rows, titles) = report_rows(ledger, repos, since, project, None, default_engine)?;
    Ok(build_report(period, since, &rows, &titles))
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
        "at": r.at, "role": r.role, "engine": r.engine, "model": r.model, "inTok": r.in_tok, "outTok": r.out_tok,
        "usd": round7(r.usd), "estimated": r.estimated, "ms": r.ms, "ok": r.ok, "legacy": r.legacy,
    })).collect();
    let proj = rows.iter().find_map(|r| r.project.clone()).or_else(|| project.map(String::from)).unwrap_or_default();
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
        let d = std::env::temp_dir().join(format!("sf-usage-{tag}-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn golden(name: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/usage-golden").join(name)).unwrap()
    }

    #[test]
    fn esquema_igual_ao_golden() {
        assert_eq!(SCHEMA.trim(), golden("schema.sql").trim());
    }

    #[test]
    fn origens_fixas() {
        assert_eq!(norm_source("titulo-branch"), "titulo-branch");
        assert_eq!(norm_source("xyz"), "outros");
        assert_eq!(norm_engine("Codex (gpt-5)"), "codex");
        assert_eq!(norm_engine("dsh-flash"), "deepseek");
        assert_eq!(norm_engine("mock"), "mock");
    }

    #[test]
    fn tabela_de_preco_unica() {
        let p: Value = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/usage-prices.json")).unwrap()).unwrap();
        assert_eq!(price_per_m("codex", ""), p["perMillion"]["codex"].as_f64().unwrap());
        assert_eq!(price_per_m("deepseek", "x"), 2.0);
        assert_eq!(price_per_m("desconhecido", ""), p["fallback"].as_f64().unwrap());
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
                out_tok: x["out_tok"].as_i64().unwrap(),
                usd: x["usd"].as_f64().unwrap(),
                claude_session: x["claude_session"].as_str().map(String::from).filter(|s| !s.is_empty()),
                claude_total: x["claude_total"].as_f64().unwrap_or(0.0),
                ok: true,
                ..Default::default()
            };
            record_in(&db, &e).unwrap();
        }
        let rows = ledger_rows(&db, 0, None, None).unwrap();
        for (r, case) in rows.iter().zip(g["cases"].as_array().unwrap()) {
            let o = &case["out"];
            assert_eq!(r.source, o["source"].as_str().unwrap());
            assert_eq!(r.engine, o["engine"].as_str().unwrap());
            assert!((r.usd - o["usd"].as_f64().unwrap()).abs() < 1e-9, "{} vs {}", r.usd, o["usd"]);
            assert_eq!(r.estimated, o["usd_estimated"].as_i64().unwrap() == 1);
        }
        assert_eq!(rows.len(), g["cases"].as_array().unwrap().len());
    }

    #[test]
    fn custo_do_json_do_claude() {
        let v: Value = serde_json::from_str(r#"{"type":"result","result":"oi","session_id":"s9","total_cost_usd":0.042,"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":50}}"#).unwrap();
        assert_eq!(claude_numbers(&v), (1110, 50, 0.042, "s9".to_string()));
        let d = tmp("cj");
        let db = d.join("u.sqlite");
        let e = claude_entry("nova-tarefa", Some(Path::new("/x/proj")), None, &v, 12, true);
        assert_eq!(record_in(&db, &e).unwrap(), (0.042, false));
        // mesma sessão retomada, total acumulado 0.05 → só a diferença
        let v2: Value = serde_json::from_str(r#"{"session_id":"s9","total_cost_usd":0.05,"usage":{"input_tokens":1,"output_tokens":1}}"#).unwrap();
        let (usd, est) = record_in(&db, &claude_entry("nova-tarefa", None, None, &v2, 1, true)).unwrap();
        assert!((usd - 0.008).abs() < 1e-9 && !est);
    }

    #[test]
    fn livro_indisponivel_nao_quebra() {
        // caminho impossível (arquivo no lugar da pasta): record_in dá erro, record() engole
        let d = tmp("bad");
        std::fs::write(d.join("arquivo"), "x").unwrap();
        let bad = d.join("arquivo").join("usage.sqlite");
        assert!(record_in(&bad, &Entry::new("titulo-branch", "claude")).is_err());
        let _lock = crate::ai_once::TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = crate::ai_once::tests::EnvGuard::set(&[("CARDUME_USAGE_DB", bad.display().to_string().as_str())]);
        record(Entry::new("titulo-branch", "claude")); // não entra em pânico
        // banco corrompido: a consulta devolve erro (a aba mostra a frase humana)
        let corrupt = d.join("c.sqlite");
        std::fs::write(&corrupt, "isto não é sqlite").unwrap();
        assert!(ledger_rows(&corrupt, 0, None, None).is_err());
        assert!(human_err("x".into()).starts_with("Não consegui ler o registro de uso"));
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
        // histórico antigo (só no cost): t1 claude US$ 1; t2 codex sem custo (estimado)
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t1','Coder','builder',1.0,100,10,5000,300)", []).unwrap();
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t2','Coder','builder',0,500000,500000,5100,0)", []).unwrap();
        // turno NOVO: gravado no cost E no livro com o mesmo at → conta uma vez só
        c.execute("INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at, ms) VALUES ('t1','Revisor','reviewer',0.5,50,5,6000,200)", []).unwrap();
        record_in(&db, &Entry { at: 6000, project: Some(repo.clone()), task_id: Some("t1".into()), role: Some("Revisor".into()), in_tok: 50, out_tok: 5, usd: 0.5, ms: 200, ..Entry::new("tarefa", "claude") }).unwrap();
        // planner (nova-tarefa) e mesa com codex
        record_in(&db, &Entry { at: 6100, project: Some(repo.clone()), usd: 0.2, in_tok: 10, out_tok: 10, ..Entry::new("nova-tarefa", "claude") }).unwrap();
        record_in(&db, &Entry { at: 6200, project: Some(repo.clone()), in_tok: 1000, out_tok: 1000, ..Entry::new("personas", "codex") }).unwrap();
        let r = report_in(&db, &[repo.clone()], "7d", 0, None, "claude").unwrap();
        // 1.0 + 10.0 (1M tokens codex estimado) + 0.5 + 0.2 + 0.02
        assert!((r["totals"]["usd"].as_f64().unwrap() - 11.72).abs() < 1e-6, "{}", r["totals"]);
        assert_eq!(r["totals"]["calls"], 5);
        assert!((r["totals"]["usdEstimated"].as_f64().unwrap() - 10.02).abs() < 1e-6);
        let src: Vec<&str> = r["bySource"].as_array().unwrap().iter().map(|s| s["source"].as_str().unwrap()).collect();
        assert_eq!(src, vec!["tarefa", "nova-tarefa", "personas"]);
        let eng: Vec<&str> = r["byEngine"].as_array().unwrap().iter().map(|s| s["engine"].as_str().unwrap()).collect();
        assert_eq!(eng, vec!["codex", "claude"]);
        assert_eq!(r["byProject"][0]["name"], "proj-a");
        let tasks = r["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["taskId"], "t2"); // ordenada por gasto
        assert_eq!(tasks[1]["taskId"], "t1");
        assert_eq!(tasks[1]["title"], "Filtro por data");
        assert!((tasks[1]["usd"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(tasks[1]["calls"], 2);
        // período: só o que veio depois de 6050
        let r2 = report_in(&db, &[repo.clone()], "hoje", 6050, None, "claude").unwrap();
        assert_eq!(r2["totals"]["calls"], 2);
        assert_eq!(r2["tasks"].as_array().unwrap().len(), 0);
        // filtro por projeto inexistente: vazio
        let r3 = report_in(&db, &[repo.clone()], "7d", 0, Some("/nao/existe"), "claude").unwrap();
        assert_eq!(r3["totals"]["calls"], 0);
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
        assert_eq!(keys(&r), keys(gr).into_iter().filter(|k| k != "_doc").collect::<Vec<_>>());
        assert_eq!(keys(&r["totals"]), keys(&gr["totals"]));
        for k in ["bySource", "byEngine", "byProject", "tasks"] { assert_eq!(keys(&r[k][0]), keys(&gr[k][0]), "{k}"); }
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
}
