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
                    params![task_id, now_ms(), exit_note(code)],
                );
            }
        }
        let _ = self.app.emit("term-exit", serde_json::json!({ "taskId": task_id, "code": code }));
    }
}

/// Nota de fim do processo em pt-BR (sem o código cru — o detalhe fica no log do terminal).
pub fn exit_note(code: Option<u32>) -> &'static str {
    match code { Some(0) => "terminal fechado", Some(_) => "o terminal fechou com erro", None => "terminal fechado pelo app" }
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
/// Modo padrão das tarefas novas (Configurações → "modo das tarefas"). Layout A aprovado (03/10): o TERMINAL é o
/// padrão pro Claude Code. `taskModeSet=2` = a pessoa escolheu na tela nova (vale o que ela escolheu); sem isso, um
/// "auto" gravado é da tela antiga (onde "Automático" era só o padrão salvo junto) e não conta como escolha.
pub fn default_mode() -> &'static str { mode_default(setting_get("taskMode").as_deref(), setting_get("taskModeSet").as_deref()) }
pub fn mode_default(task_mode: Option<&str>, set: Option<&str>) -> &'static str {
    if set == Some("2") && task_mode == Some("auto") { "auto" } else { "terminal" }
}
/// A tarefa nova roda no terminal? Pedido explícito (terminal|auto) vence; sem pedido, o padrão. Terminal exige CLI
/// interativo oficial: Claude Code sempre; Codex só quando a pessoa ESCOLHEU terminal (o padrão novo é do Claude);
/// DeepSeek/gateway seguem no automático.
pub fn wants_terminal(explicit: Option<&str>, default: &str, chosen: bool, engine: &str) -> bool {
    let e = engine.to_lowercase();
    let mode = explicit.filter(|m| *m == "terminal" || *m == "auto").unwrap_or(default);
    if mode != "terminal" { return false; }
    if e.contains("claude") { return true; }
    e == "codex" && (explicit == Some("terminal") || chosen)
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

/// O compositor de uma tarefa SEM terminal aberto vai pro terminal? (aba Terminal em toda tarefa Claude Code)
/// - já é de modo terminal → sim;
/// - Claude Code, padrão "terminal" e NENHUM turno headless rodando agora → sim (retoma a sessão no PTY);
/// - turno headless em curso (claude -p) → não: a mensagem entra na fila dele, como antes;
/// - padrão "Automático" escolhido na tela nova, ou motor sem CLI interativo → não.
pub fn talk_in_terminal(is_term: bool, engine: &str, default: &str, headless_busy: bool) -> bool {
    if is_term { return true; }
    default == "terminal" && !headless_busy && claude_engine(engine)
}
/// O motor da tarefa é o Claude Code? Mesma regra do front (aiEngineOf): rótulo vazio = mock; codex/deepseek/dsh/
/// gateway/logcomex são outros; qualquer outro rótulo ("claude", "Claude · Opus", "opus") é Claude.
pub fn claude_engine(engine: &str) -> bool {
    let e = engine.trim().to_lowercase();
    !(e.is_empty() || e == "mock" || ["codex", "deepseek", "dsh", "gateway", "logcomex"].iter().any(|p| e.starts_with(p)))
}
pub struct TaskRow { pub engine: String, pub status: String, pub worktree: String, pub busy_pid: Option<i64>, pub session_id: Option<String>, pub term_sid: Option<String> }
fn task_row(db: &Path, task_id: &str) -> Option<TaskRow> {
    let c = open_rw(db).ok()?;
    let mut r = c.query_row("SELECT engine, status, worktree, busy_pid, session_id FROM task WHERE id=?1", params![task_id], |r| Ok(TaskRow {
        engine: r.get::<_, Option<String>>(0)?.unwrap_or_default(), status: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        worktree: r.get::<_, Option<String>>(2)?.unwrap_or_default(), busy_pid: r.get(3)?, session_id: r.get(4)?, term_sid: None,
    })).ok()?;
    r.term_sid = c.query_row("SELECT session_id FROM term_session WHERE task_id=?1", params![task_id], |r| r.get::<_, Option<String>>(0)).ok().flatten();
    Some(r)
}
/// Um turno headless (claude -p) é dono da sessão agora? Processo registrado OU estado de turno em curso/na fila —
/// nos dois casos abrir `claude --resume` em paralelo poria dois escritores no mesmo transcript.
fn headless_busy(t: &TaskRow) -> bool { t.busy_pid.is_some() || ["running", "thinking", "queued"].contains(&t.status.as_str()) }
/// PURA: o compositor desta tarefa (sem terminal aberto) retoma a sessão no PTY? Err = não dá pra mandar.
pub fn talk_decision(t: &TaskRow, is_term: bool, live: bool, default: &str) -> Result<bool, String> {
    if is_term || live { return Ok(true); }
    if !talk_in_terminal(false, &t.engine, default, headless_busy(t)) { return Ok(false); }
    if worktree_gone_after_merge(&t.status, &t.worktree) { return Err(WT_GONE.to_string()); }
    Ok(true)
}
/// Mensagem do compositor numa tarefa Claude parada: vai pro terminal (retomando a sessão)? Erro = não dá pra mandar.
pub fn should_talk_in_terminal(state: &State<AppState>, task_id: &str) -> Result<bool, String> {
    let is_term = is_terminal(state, task_id);
    let live = mgr().and_then(|m| m.live(task_id)).is_some();
    if is_term || live { return Ok(true); }
    let db = db_of(state)?;
    let Some(t) = task_row(&db, task_id) else { return Ok(false) };
    talk_decision(&t, false, false, default_mode())
}
/// A worktree foi apagada ao integrar: não há onde retomar — o caminho é uma tarefa nova de ajuste.
pub const WT_GONE: &str = "a worktree desta tarefa foi apagada ao integrar — pra mexer de novo, abra uma tarefa nova de ajuste";
fn worktree_gone_after_merge(status: &str, worktree: &str) -> bool { status == "merged" && (worktree.is_empty() || !Path::new(worktree).is_dir()) }

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistInfo {
    /// transcript | log | none
    source: String,
    items: Vec<crate::term_hist::HistItem>,
    /// bytes crus do terminal (fonte "log": Codex, ou sessão sem transcript)
    raw: String,
    session_id: Option<String>,
    worktree: String,
    worktree_exists: bool,
    merged: bool,
    alive: bool,
    /// mandar pelo compositor RETOMA a sessão no terminal (a mesma decisão do talk_task — o front mostra a dica certa)
    resumes: bool,
    /// o transcript passou do teto e só a parte final foi lida
    clipped: bool,
    /// carimbo do arquivo lido ("tamanho:mtime") — igual ao `since` pedido = nada mudou (items vazio)
    stamp: String,
    unchanged: bool,
}
fn stamp_of(p: &Path) -> String {
    std::fs::metadata(p).map(|m| format!("{}:{}", m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0))).unwrap_or_default()
}
/// Teto de leitura do transcript (prints em base64 inflam o arquivo): lê só o FIM e descarta a 1ª linha partida.
pub const HIST_READ_CAP: u64 = 24 * 1024 * 1024;
fn read_tail(p: &Path, cap: u64) -> Result<(String, bool), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).map_err(|e| format!("não consegui ler o histórico da sessão: {e}"))?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let clipped = len > cap;
    if clipped { f.seek(SeekFrom::Start(len - cap)).map_err(|e| e.to_string())?; }
    let mut b = Vec::new();
    f.read_to_end(&mut b).map_err(|e| format!("não consegui ler o histórico da sessão: {e}"))?;
    let mut s = String::from_utf8_lossy(&b).into_owned();
    if clipped { if let Some(i) = s.find('\n') { s.drain(..=i); } }
    Ok((s, clipped))
}
/// O histórico de uma tarefa (testável: banco, repo e config do Claude entram por parâmetro).
pub fn history_for(db: &Path, repo: &Path, cfg: Option<&Path>, task_id: &str, since: Option<&str>, live: bool, default: &str) -> Result<HistInfo, String> {
    let t = task_row(db, task_id).ok_or("tarefa não encontrada")?;
    let is_term = spec_of(db, task_id).map(|s| s.get("termMode").and_then(|v| v.as_str()) == Some("terminal")).unwrap_or(false);
    let mut h = HistInfo { worktree_exists: !t.worktree.is_empty() && Path::new(&t.worktree).is_dir(), merged: t.status == "merged", worktree: t.worktree.clone(), alive: live,
        resumes: talk_decision(&t, is_term, live, default) == Ok(true), ..Default::default() };
    // mesma precedência do term-prep (src/terminal.ts): a sessão da tarefa, depois a do terminal
    let sid = t.session_id.clone().filter(|s| !s.is_empty()).or(t.term_sid.clone().filter(|s| !s.is_empty()));
    h.session_id = sid.clone();
    let tr = sid.as_deref().and_then(|s| cfg.and_then(|d| crate::term_hist::find_transcript(d, &t.worktree, s)));
    if let Some(p) = tr {
        h.source = "transcript".into();
        h.stamp = stamp_of(&p);
        if since == Some(h.stamp.as_str()) { h.unchanged = true; return Ok(h); }
        let (text, clipped) = read_tail(&p, HIST_READ_CAP)?;
        h.clipped = clipped;
        h.items = crate::term_hist::parse_transcript(&text, &t.worktree);
        return Ok(h);
    }
    let lp = log_path(repo, task_id);
    if lp.is_file() {
        h.source = "log".into();
        h.stamp = stamp_of(&lp);
        if since == Some(h.stamp.as_str()) { h.unchanged = true; return Ok(h); }
        h.raw = pty::read_log(&lp);
        return Ok(h);
    }
    h.source = "none".into();
    Ok(h)
}
/// Histórico da sessão pra tarefa SEM terminal vivo: transcript do Claude Code → log do PTY → nada (o front cai
/// nos eventos do state.sqlite). `since` = carimbo da última leitura: arquivo igual não é relido (poll barato).
#[tauri::command(async)]
pub fn term_history(state: State<AppState>, task_id: String, since: Option<String>) -> Result<HistInfo, String> {
    let db = db_of(&state)?;
    let repo = repo_of(&state)?;
    let cfg = crate::term_hist::claude_config_dir();
    let live = mgr().and_then(|m| m.live(&task_id)).is_some();
    history_for(&db, &repo, cfg.as_deref(), &task_id, since.as_deref(), live, default_mode())
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
        // sem terminal vivo o front pinta o histórico da sessão (term_history) — não relê o log à toa
        None => Ok(info(&state, &task_id, String::new())),
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

#[cfg(test)]
mod modo_padrao_tests {
    use super::{exit_note, history_for, mode_default, talk_decision, talk_in_terminal, wants_terminal, worktree_gone_after_merge, TaskRow, WT_GONE};
    fn row(status: &str, busy: Option<i64>, wt: &str) -> TaskRow { TaskRow { engine: "claude".into(), status: status.into(), worktree: wt.into(), busy_pid: busy, session_id: None, term_sid: None } }
    #[test]
    fn nota_de_fim_sem_codigo_cru() {
        assert_eq!(exit_note(Some(0)), "terminal fechado");
        assert_eq!(exit_note(Some(143)), "o terminal fechou com erro");
        assert_eq!(exit_note(None), "terminal fechado pelo app");
    }
    #[test]
    fn decisao_do_compositor_por_linha_da_tarefa() {
        assert_eq!(talk_decision(&row("review", None, "/"), false, false, "terminal"), Ok(true), "parada: retoma no PTY");
        assert_eq!(talk_decision(&row("running", Some(9), "/"), false, false, "terminal"), Ok(false), "headless rodando: fila dele");
        assert_eq!(talk_decision(&row("running", None, "/"), false, false, "terminal"), Ok(false), "turno em curso sem pid registrado ainda");
        assert_eq!(talk_decision(&row("queued", None, "/"), false, false, "terminal"), Ok(false), "na fila do headless");
        assert_eq!(talk_decision(&row("paused", Some(9), "/"), false, false, "terminal"), Ok(false), "pausada = processo congelado vivo");
        assert_eq!(talk_decision(&row("review", None, "/"), false, false, "auto"), Ok(false), "Automático escolhido");
        assert_eq!(talk_decision(&row("merged", None, "/nao/existe"), false, false, "terminal"), Err(WT_GONE.to_string()));
        assert_eq!(talk_decision(&row("merged", None, "/nao/existe"), false, true, "terminal"), Ok(true), "PTY vivo vence");
        assert_eq!(talk_decision(&row("running", Some(9), "/"), true, false, "auto"), Ok(true), "modo terminal sempre");
    }
    #[test]
    fn historico_transcript_carimbo_log_e_nada() {
        use rusqlite::{params, Connection};
        let d = std::env::temp_dir().join(format!("sf-histfor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (repo, cfg, wt) = (d.join("repo"), d.join("cfg"), d.join("repo").join("wt"));
        std::fs::create_dir_all(&wt).unwrap();
        let db = d.join("state.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE task (id TEXT, engine TEXT, status TEXT, worktree TEXT, busy_pid INTEGER, session_id TEXT, spec_json TEXT); CREATE TABLE term_session (task_id TEXT, session_id TEXT);").unwrap();
        c.execute("INSERT INTO task VALUES ('t1','claude','review',?1,NULL,'sess-a','{}')", params![wt.display().to_string()]).unwrap();
        c.execute("INSERT INTO term_session VALUES ('t1','sess-b')", []).unwrap();
        let pd = cfg.join("projects").join(crate::term_hist::encode_cwd(&wt.display().to_string()));
        std::fs::create_dir_all(&pd).unwrap();
        std::fs::write(pd.join("sess-a.jsonl"), r#"{"type":"assistant","message":{"content":[{"type":"text","text":"da sessão A"}]}}"#).unwrap();
        std::fs::write(pd.join("sess-b.jsonl"), r#"{"type":"assistant","message":{"content":[{"type":"text","text":"da sessão B"}]}}"#).unwrap();
        let h = history_for(&db, &repo, Some(&cfg), "t1", None, false, "terminal").unwrap();
        assert_eq!((h.source.as_str(), h.items.len(), h.items[0].text.as_str(), h.resumes, h.worktree_exists), ("transcript", 1, "da sessão A", true, true), "mesma sessão que o term-prep retoma");
        let again = history_for(&db, &repo, Some(&cfg), "t1", Some(&h.stamp), false, "terminal").unwrap();
        assert!(again.unchanged && again.items.is_empty(), "arquivo igual não é relido");
        std::fs::remove_file(pd.join("sess-a.jsonl")).unwrap();
        std::fs::remove_file(pd.join("sess-b.jsonl")).unwrap();
        std::fs::create_dir_all(repo.join(".cardume").join("term")).unwrap();
        std::fs::write(repo.join(".cardume").join("term").join("t1.log"), "LOG CRU").unwrap();
        let l = history_for(&db, &repo, Some(&cfg), "t1", None, false, "auto").unwrap();
        assert_eq!((l.source.as_str(), l.raw.as_str(), l.resumes), ("log", "LOG CRU", false));
        std::fs::remove_file(repo.join(".cardume").join("term").join("t1.log")).unwrap();
        assert_eq!(history_for(&db, &repo, Some(&cfg), "t1", None, false, "terminal").unwrap().source, "none");
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn compositor_de_tarefa_parada_vai_pro_terminal() {
        assert!(talk_in_terminal(true, "deepseek", "auto", true), "já é terminal");
        assert!(talk_in_terminal(false, "claude", "terminal", false), "Claude parado retoma no PTY");
        assert!(talk_in_terminal(false, "Claude · Opus", "terminal", false));
        assert!(!talk_in_terminal(false, "claude", "terminal", true), "turno headless rodando: fila dele");
        assert!(!talk_in_terminal(false, "claude", "auto", false), "Automático escolhido");
        assert!(talk_in_terminal(false, "opus", "terminal", false), "rótulo só com o modelo = Claude (igual ao aiEngineOf)");
        assert!(!talk_in_terminal(false, "", "terminal", false), "sem motor = mock");
        assert!(!talk_in_terminal(false, "codex", "terminal", false));
        assert!(!talk_in_terminal(false, "deepseek", "terminal", false));
        assert!(worktree_gone_after_merge("merged", "/nao/existe/mesmo"));
        assert!(worktree_gone_after_merge("merged", ""));
        assert!(!worktree_gone_after_merge("review", "/nao/existe/mesmo"), "não mergeada: o motor recria");
        assert!(!worktree_gone_after_merge("merged", "/"));
    }
    #[test]
    fn terminal_e_o_padrao_do_claude() {
        assert_eq!(mode_default(None, None), "terminal", "sem setting = terminal");
        assert_eq!(mode_default(Some("auto"), None), "terminal", "auto da tela antiga não é escolha");
        assert_eq!(mode_default(Some("auto"), Some("2")), "auto", "escolheu automático na tela nova");
        assert_eq!(mode_default(Some("terminal"), Some("2")), "terminal");
        assert!(wants_terminal(None, "terminal", false, "claude"));
        assert!(!wants_terminal(None, "terminal", false, "codex"), "codex só se escolher terminal");
        assert!(wants_terminal(None, "terminal", true, "codex"));
        assert!(wants_terminal(Some("terminal"), "auto", false, "codex"));
        assert!(!wants_terminal(None, "terminal", false, "deepseek"), "sem CLI interativo = automático");
        assert!(!wants_terminal(Some("terminal"), "terminal", true, "gateway"));
        assert!(!wants_terminal(Some("auto"), "terminal", false, "claude"), "pedido explícito vence");
        assert!(!wants_terminal(None, "auto", false, "claude"));
    }
}
