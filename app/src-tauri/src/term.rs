//! Cola do MODO TERMINAL com o app: comandos Tauri sobre o pty.rs e o roteamento das entradas do app
//! (conversa, "pedir prova", "pedir ajuste", mira/Prévia, follow-up do celular) pra sessão do terminal.
//!
//! Quem MONTA o comando é o motor (`cli.mjs term-prep`, src/terminal.ts — prompt, hooks, MCP, PATH); aqui só
//! se spawna o que ele devolve. Estado ocupado/livre vem dos hooks (tabela term_session no state.sqlite).
use crate::pty::{self, PidRegistry, PtyManager, PtySink, SpawnSpec};
use crate::{cli_path, node_cmd, repo_of, setting_get, web_log, AppState};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, State};

static PTY: OnceLock<Arc<PtyManager>> = OnceLock::new();
/// banco de cada sessão (o app troca de projeto; a sessão continua gravando no banco DELA)
static DBS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
fn dbs() -> &'static Mutex<HashMap<String, PathBuf>> { DBS.get_or_init(|| Mutex::new(HashMap::new())) }

struct TauriSink { app: tauri::AppHandle }
impl PtySink for TauriSink {
    fn data(&self, task_id: &str, chunk: &str) {
        let _ = self.app.emit("term-data", serde_json::json!({ "taskId": task_id, "data": chunk }));
    }
    fn exit(&self, task_id: &str, code: Option<u32>) {
        let db = dbs().lock().unwrap_or_else(|e| e.into_inner()).get(task_id).cloned();
        if let Some(db) = db {
            if let Ok(c) = open_rw(&db) {
                let pid: Option<i64> = c.query_row("SELECT pid FROM term_session WHERE task_id=?1", params![task_id], |r| r.get(0)).ok().flatten();
                let _ = c.execute("UPDATE term_session SET busy=0, pid=NULL, updated_at=?2 WHERE task_id=?1", params![task_id, now_ms()]);
                if let Some(p) = pid { let _ = c.execute("UPDATE task SET busy_pid=NULL WHERE id=?1 AND busy_pid=?2", params![task_id, p]); }
                // processo saiu no meio de um turno (crash, /exit com trabalho rodando): não fica "rodando" pra sempre
                let _ = c.execute("UPDATE task SET status='review' WHERE id=?1 AND status IN ('running','thinking')", params![task_id]);
                let _ = c.execute(
                    "INSERT INTO event (task_id, agent, ts, type, text, ok) VALUES (?1, 'Sistema', ?2, 'status', ?3, 1)",
                    params![task_id, now_ms(), format!("terminal fechado{}", code.map(|c| format!(" (código {c})")).unwrap_or_default())],
                );
            }
        }
        let _ = self.app.emit("term-exit", serde_json::json!({ "taskId": task_id, "code": code }));
    }
}

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
fn open_rw(db: &Path) -> Result<Connection, String> {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
    let _ = c.busy_timeout(std::time::Duration::from_millis(4000));
    Ok(c)
}
fn registry() -> Option<PidRegistry> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PidRegistry { path: PathBuf::from(home).join(".constellation").join("term-pids.json") })
}

/// No setup do app: cria o gerenciador e VARRE o que uma execução anterior (que caiu) deixou vivo.
pub fn init(app: tauri::AppHandle) {
    let m = Arc::new(PtyManager::new(Arc::new(TauriSink { app }), registry()));
    let _ = PTY.set(m.clone());
    std::thread::spawn(move || {
        if let Some(r) = &m.registry {
            let n = r.sweep(pty::looks_like_agent);
            if n > 0 { web_log(format!("[term] varredura no boot: {n} terminal(is) órfão(s) encerrado(s)")); }
        }
    });
}
pub fn mgr() -> Option<Arc<PtyManager>> { PTY.get().cloned() }
/// Fim do app: todos os terminais morrem (grupo inteiro) e o histórico fica gravado.
pub fn kill_all() { if let Some(m) = mgr() { m.kill_all(); } }
/// Fim da tarefa (merge, remover, abortar, rodar de novo): mata o terminal dela.
pub fn kill_task(task_id: &str) { if let Some(m) = mgr() { m.kill(task_id); } }

fn db_of(state: &State<AppState>) -> Result<PathBuf, String> {
    state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| "repo não definido".to_string())
}
fn spec_of(db: &Path, task_id: &str) -> Option<serde_json::Value> {
    let c = open_rw(db).ok()?;
    let s: String = c.query_row("SELECT spec_json FROM task WHERE id=?1", params![task_id], |r| r.get(0)).ok()?;
    serde_json::from_str(&s).ok()
}
/// A tarefa está em MODO TERMINAL? (fixo no spec; tarefa antiga = automático)
pub fn is_terminal(state: &State<AppState>, task_id: &str) -> bool {
    db_of(state).ok().and_then(|db| spec_of(&db, task_id)).map(|s| s.get("termMode").and_then(|v| v.as_str()) == Some("terminal")).unwrap_or(false)
}
/// Modo padrão das tarefas novas (Configurações → "modo das tarefas"): automático até o layout do terminal
/// ser escolhido e validado no app instalado (03/10); terminal só quando a pessoa liga (beta).
pub fn default_mode() -> &'static str {
    if setting_get("taskMode").as_deref() == Some("terminal") { "terminal" } else { "auto" }
}
/// Livre? (hook Stop gravou busy=0). None = sem linha (sessão ainda subindo).
fn idle_probe(db: PathBuf, task_id: String) -> Arc<dyn Fn() -> Option<bool> + Send + Sync> {
    Arc::new(move || {
        let c = open_rw(&db).ok()?;
        c.query_row("SELECT busy FROM term_session WHERE task_id=?1", params![task_id], |r| r.get::<_, i64>(0)).ok().map(|b| b == 0)
    })
}
fn log_path(repo: &Path, task_id: &str) -> PathBuf { repo.join(".cardume").join("term").join(format!("{task_id}.log")) }

/// Roda o motor e devolve o JSON da última linha do stdout (term-prep / term-msg).
fn engine_json(repo: &Path, args: &[String]) -> Result<serde_json::Value, String> {
    let mut cmd = node_cmd();
    cmd.arg("--disable-warning=ExperimentalWarning").arg(cli_path(&repo.to_path_buf())).args(args).arg("--repo").arg(repo);
    cmd.current_dir(repo).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("CARDUME_NOTIFY", "0");
    let protect = crate::protect_on(repo);
    cmd.env("CARDUME_PROTECT", if protect { "1" } else { "0" });
    let out = crate::output_timeout(cmd, 60).map_err(|e| format!("motor não respondeu: {e}"))?;
    let so = String::from_utf8_lossy(&out.stdout);
    let line = so.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or_else(|| {
        let se = String::from_utf8_lossy(&out.stderr);
        format!("motor sem resposta: {}", se.lines().rev().take(4).collect::<Vec<_>>().join(" | "))
    })?;
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if let Some(e) = v.get("error").and_then(|e| e.as_str()) { return Err(e.to_string()); }
    Ok(v)
}

/// Abre (ou devolve) o terminal da tarefa. Pode demorar (o motor monta o contexto) — chame fora da UI.
pub fn open_task(repo: &Path, db: &Path, task_id: &str, cols: u16, rows: u16, resume: bool, message: Option<&str>) -> Result<Arc<pty::PtySession>, String> {
    let m = mgr().ok_or("terminal indisponível")?;
    if let Some(s) = m.live(task_id) { let _ = s.resize(cols, rows); return Ok(s); }
    let mut a = vec!["term-prep".to_string(), task_id.to_string()];
    if resume { a.push("--resume".into()); }
    if let Some(msg) = message.filter(|m| !m.trim().is_empty()) { a.push("--msg".into()); a.push(msg.to_string()); }
    let v = engine_json(repo, &a)?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let list = |k: &str| v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_else(Vec::<String>::new);
    let env: Vec<(String, String)> = v.get("env").and_then(|e| e.as_object()).map(|o| o.iter().filter_map(|(k, x)| x.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default();
    let spec = SpawnSpec {
        program: s("program"), args: list("args"), cwd: PathBuf::from(s("cwd")), env, env_remove: list("envRemove"),
        cols, rows, log_path: Some(log_path(repo, task_id)), scroll_cap: pty::SCROLL_CAP, engine: s("engine"),
    };
    dbs().lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.to_string(), db.to_path_buf());
    let sess = m.spawn(task_id, spec)?;
    if let Ok(c) = open_rw(db) {
        let _ = c.execute(
            "CREATE TABLE IF NOT EXISTS term_session (task_id TEXT PRIMARY KEY, pid INTEGER, engine TEXT, busy INTEGER NOT NULL DEFAULT 0, session_id TEXT, started_at INTEGER, updated_at INTEGER)", [],
        );
        // nasce OCUPADO quando já leva um pedido (o 1º UserPromptSubmit confirma; sem pedido, nasce livre)
        let resumed = v.get("resumed").and_then(|x| x.as_bool()).unwrap_or(false);
        let busy = if resumed && message.is_none() { 0 } else { 1 };
        let _ = c.execute(
            "INSERT INTO term_session (task_id, pid, engine, busy, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
             ON CONFLICT(task_id) DO UPDATE SET pid=excluded.pid, engine=excluded.engine, busy=excluded.busy, started_at=excluded.started_at, updated_at=excluded.updated_at",
            params![task_id, sess.pid as i64, sess.engine, busy, now_ms()],
        );
        if busy == 1 { let _ = c.execute("UPDATE task SET busy_pid=?2, busy_since=?3 WHERE id=?1", params![task_id, sess.pid as i64, now_ms()]); }
    }
    Ok(sess)
}

/// Pedido do app → terminal da tarefa. Sessão viva: entra na FILA (entrega quando o Stop disser que está
/// livre). Sem sessão: abre retomando a sessão gravada, já com o pedido como 1ª mensagem.
/// `kind`: talk | deliver | rework | continue.
pub fn route(state: &State<AppState>, task_id: &str, kind: &str, msg: &str, as_req: bool, deliver: Option<&str>) -> Result<(), String> {
    let repo = repo_of(state)?;
    let db = db_of(state)?;
    let mut a = vec!["term-msg".to_string(), task_id.to_string(), "--kind".into(), kind.to_string()];
    if !msg.trim().is_empty() { a.push("--msg".into()); a.push(msg.to_string()); }
    if as_req { a.push("--as-req".into()); }
    if let Some(d) = deliver { a.push("--deliver".into()); a.push(d.to_string()); }
    let text = engine_json(&repo, &a)?.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if text.trim().is_empty() { return Err("nada pra mandar ao terminal".into()); }
    let m = mgr().ok_or("terminal indisponível")?;
    if m.live(task_id).is_some() {
        let n = m.enqueue(task_id, text, idle_probe(db.clone(), task_id.to_string()))?;
        if n > 1 || idle_probe(db.clone(), task_id.to_string())() == Some(false) {
            if let Ok(c) = open_rw(&db) {
                let _ = c.execute("INSERT INTO event (task_id, agent, ts, type, text, ok) VALUES (?1, 'Sistema', ?2, 'note', ?3, 1)",
                    params![task_id, now_ms(), format!("Na fila ({n}º): o terminal está no meio de um turno — entrego assim que ele terminar.")]);
            }
        }
        return Ok(());
    }
    let (cols, rows) = last_size(task_id);
    open_task(&repo, &db, task_id, cols, rows, true, Some(&text)).map(|_| ())
}
/// "■ parar" no modo terminal = Esc no CLI (interrompe o turno, a sessão segue aberta).
pub fn interrupt(state: &State<AppState>, task_id: &str) -> Result<(), String> {
    let m = mgr().ok_or("terminal indisponível")?;
    m.interrupt(task_id)?;
    // o Claude Code não dispara Stop ao interromper: o estado livre é marcado aqui
    mark_idle(state, task_id, Some("turno interrompido (Esc no terminal)"));
    Ok(())
}

static SIZES: OnceLock<Mutex<HashMap<String, (u16, u16)>>> = OnceLock::new();
fn last_size(task_id: &str) -> (u16, u16) {
    SIZES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner()).get(task_id).copied().unwrap_or((120, 34))
}
fn remember_size(task_id: &str, cols: u16, rows: u16) {
    SIZES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.to_string(), (cols, rows));
}

// ============================ comandos Tauri ============================
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo { alive: bool, data: String, cols: u16, rows: u16, engine: String, busy: bool, queued: usize, session_id: Option<String> }

fn info(state: &State<AppState>, task_id: &str, data: String) -> TermInfo {
    let m = mgr();
    let s = m.as_ref().and_then(|m| m.live(task_id));
    let (cols, rows) = s.as_ref().map(|s| s.size()).unwrap_or_else(|| last_size(task_id));
    let (busy, sid) = db_of(state).ok().and_then(|db| open_rw(&db).ok()).and_then(|c| {
        c.query_row("SELECT busy, session_id FROM term_session WHERE task_id=?1", params![task_id], |r| Ok((r.get::<_, i64>(0)? == 1, r.get::<_, Option<String>>(1)?))).ok()
    }).unwrap_or((false, None));
    TermInfo { alive: s.is_some(), data, cols, rows, engine: s.map(|s| s.engine.clone()).unwrap_or_default(), busy, queued: m.map(|m| m.queued(task_id)).unwrap_or(0), session_id: sid }
}

/// Abre o terminal (novo ou retomando a sessão gravada) e já devolve o histórico pra pintar.
#[tauri::command(async)]
pub fn term_open(state: State<AppState>, task_id: String, cols: u16, rows: u16, resume: Option<bool>) -> Result<TermInfo, String> {
    let repo = repo_of(&state)?;
    let db = db_of(&state)?;
    remember_size(&task_id, cols, rows);
    let s = open_task(&repo, &db, &task_id, cols, rows, resume.unwrap_or(true), None)?;
    let data = s.attach();
    Ok(info(&state, &task_id, data))
}
/// A aba ficou visível: liga os eventos e devolve o histórico (vivo ou o gravado em disco).
#[tauri::command(async)]
pub fn term_attach(state: State<AppState>, task_id: String) -> Result<TermInfo, String> {
    match mgr().and_then(|m| m.get(&task_id)) {
        Some(s) => { let d = s.attach(); Ok(info(&state, &task_id, d)) }
        None => { let repo = repo_of(&state)?; Ok(info(&state, &task_id, pty::read_log(&log_path(&repo, &task_id)))) }
    }
}
/// A aba sumiu da tela: a sessão segue viva, só para de mandar eventos.
#[tauri::command(async)]
pub fn term_detach(task_id: String) -> Result<(), String> {
    if let Some(s) = mgr().and_then(|m| m.get(&task_id)) { s.detach(); }
    Ok(())
}
/// Tecla/colagem digitada DIRETO no terminal (xterm onData).
#[tauri::command(async)]
pub fn term_write(state: State<AppState>, task_id: String, data: String) -> Result<(), String> {
    mgr().and_then(|m| m.live(&task_id)).ok_or("o terminal desta tarefa não está aberto")?.write_bytes(data.as_bytes())?;
    // Esc digitado no terminal interrompe o turno e o Claude Code NÃO dispara o Stop: marca livre (o próximo
    // PreToolUse volta pra ocupado se o Esc só tinha fechado um menu)
    if data == "\x1b" { mark_idle(&state, &task_id, None); }
    Ok(())
}
fn mark_idle(state: &State<AppState>, task_id: &str, note: Option<&str>) {
    if let Ok(db) = db_of(state) { if let Ok(c) = open_rw(&db) {
        let _ = c.execute("UPDATE term_session SET busy=0, updated_at=?2 WHERE task_id=?1", params![task_id, now_ms()]);
        let _ = c.execute("UPDATE task SET busy_pid=NULL WHERE id=?1", params![task_id]);
        if let Some(n) = note { let _ = c.execute("INSERT INTO event (task_id, agent, ts, type, text, ok) VALUES (?1, 'Sistema', ?2, 'note', ?3, 1)", params![task_id, now_ms(), n]); }
    } }
}
#[tauri::command(async)]
pub fn term_resize(task_id: String, cols: u16, rows: u16) -> Result<(), String> {
    remember_size(&task_id, cols, rows);
    match mgr().and_then(|m| m.live(&task_id)) { Some(s) => s.resize(cols, rows), None => Ok(()) }
}
/// Composer → terminal. mode: "queue" (padrão: entrega quando livre) | "interrupt" (Esc e manda).
#[tauri::command(async)]
pub fn term_send(state: State<AppState>, task_id: String, text: String, mode: Option<String>, as_req: Option<bool>) -> Result<(), String> {
    if mode.as_deref() == Some("interrupt") && mgr().and_then(|m| m.live(&task_id)).is_some() {
        interrupt(&state, &task_id)?;
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    route(&state, &task_id, "talk", &text, as_req.unwrap_or(false), None)
}
#[tauri::command(async)]
pub fn term_interrupt(state: State<AppState>, task_id: String) -> Result<(), String> { interrupt(&state, &task_id) }
#[tauri::command(async)]
pub fn term_kill(task_id: String) -> Result<(), String> { kill_task(&task_id); Ok(()) }
#[tauri::command(async)]
pub fn term_status(state: State<AppState>, task_id: String) -> Result<TermInfo, String> { Ok(info(&state, &task_id, String::new())) }
