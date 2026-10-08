//! Cola do MODO TERMINAL com o app: comandos Tauri sobre o pty.rs e o roteamento das entradas do app
//! (conversa, "pedir prova", "pedir ajuste", mira/Prévia, follow-up do celular) pra sessão do terminal.
//!
//! Quem MONTA o comando é o motor (`cli.mjs term-prep`, src/terminal.ts — prompt, hooks, MCP, PATH); aqui só
//! se spawna o que ele devolve. Estado ocupado/livre vem dos hooks (tabela term_session no state.sqlite).
//!
//! TERMINAL INTEGRADO NO SHELL (macOS/Linux): o PTY é o shell de login da pessoa na worktree e a IA sobe DENTRO dele
//! (`starfork ia <ia>`). `term_session.cli` diz qual IA está rodando ('' = shell no prompt): mensagem do app com IA
//! rodando entra na fila de sempre; com o shell no prompt vira `starfork ia … --resume --msg-file …` digitado nele.
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
    fn exit(&self, task_id: &str, pid: u32, code: Option<u32>) {
        // troca de IA (term_switch_ai) já reabriu o terminal: o fim do processo VELHO não mexe no estado do novo —
        // em memória (sessão nova registrada com outro pid) e no banco (UPDATE … WHERE pid = o que saiu, atômico)
        let replaced = mgr().and_then(|m| m.get(task_id)).map(|s| s.pid != pid).unwrap_or(false);
        if replaced { return; }
        shells().lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
        let db = dbs().lock().unwrap_or_else(|e| e.into_inner()).get(task_id).cloned();
        let reaped = reaped().lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
        if let Some(c) = db.and_then(|d| open_rw(&d).ok()) { record_exit_with(&c, task_id, pid, if reaped { REAPED_NOTE } else { exit_note(code) }); }
        let _ = self.app.emit("term-exit", serde_json::json!({ "taskId": task_id, "code": code }));
    }
}

/// Fim do processo `pid` no banco: livre, sem pid/IA, "rodando" → revisão, nota no feed. SÓ se a sessão gravada
/// ainda é a desse pid (outra já aberta no lugar = nada muda). Devolve se gravou.
pub fn record_exit(c: &Connection, task_id: &str, pid: u32, code: Option<u32>) -> bool { record_exit_with(c, task_id, pid, exit_note(code)) }
pub fn record_exit_with(c: &Connection, task_id: &str, pid: u32, note: &str) -> bool {
    ensure_cli_col(c);
    let n = c.execute("UPDATE term_session SET busy=0, pid=NULL, cli='', updated_at=?3 WHERE task_id=?1 AND pid=?2", params![task_id, pid as i64, now_ms()]).unwrap_or(0);
    if n == 0 { return false; }
    let _ = c.execute("UPDATE task SET busy_pid=NULL WHERE id=?1 AND busy_pid=?2", params![task_id, pid as i64]);
    // processo saiu no meio de um turno (crash, /exit com trabalho rodando): não fica "rodando" pra sempre
    let _ = c.execute("UPDATE task SET status='review' WHERE id=?1 AND status IN ('running','thinking')", params![task_id]);
    let _ = c.execute(
        "INSERT INTO event (task_id, agent, ts, type, text, ok) VALUES (?1, 'Sistema', ?2, 'status', ?3, 1)",
        params![task_id, now_ms(), note],
    );
    true
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
    // terminal parado fora da tela é encerrado (Ajustes › termIdleMin); reabrir a tarefa retoma sozinho
    std::thread::Builder::new().name("term-reaper".into()).spawn(|| loop { std::thread::sleep(REAP_EVERY); reap_tick(); }).ok();
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
/// A tarefa nova roda no terminal? Pedido explícito (terminal|auto) vence; sem pedido, o padrão. Claude Code sempre;
/// os outros motores só quando a pessoa ESCOLHEU terminal (o padrão novo é do Claude). macOS/Linux: qualquer motor
/// com IA de terminal (o terminal é o shell da pessoa e ela escolhe a IA — `starfork ia`); Windows (a IA direto no PTY):
/// só Codex e DeepSeek (dentro do `claude`). Gateway/logcomex/vazio seguem no automático nos dois.
pub fn wants_terminal(explicit: Option<&str>, default: &str, chosen: bool, engine: &str) -> bool {
    wants_terminal_on(explicit, default, chosen, engine, cfg!(windows))
}
pub fn wants_terminal_on(explicit: Option<&str>, default: &str, chosen: bool, engine: &str, windows: bool) -> bool {
    let e = engine.trim().to_lowercase();
    let mode = explicit.filter(|m| *m == "terminal" || *m == "auto").unwrap_or(default);
    if mode != "terminal" { return false; }
    if e.contains("claude") { return true; }
    // gateway/logcomex não têm CLI (virariam Claude em silêncio); vazio/mock = sem IA — mesma regra do TS (terminalCapable)
    if e.is_empty() || e == "mock" || e.starts_with("gateway") || e.starts_with("logcomex") { return false; }
    let capable = !windows || e == "codex" || dsh_engine(&e);
    capable && (explicit == Some("terminal") || chosen)
}
/// IAs que o terminal sabe abrir (a mesma lista do TS: TERM_AIS em src/terminal.ts).
pub const TERM_AIS: [&str; 5] = ["claude", "codex", "deepseek", "gemini", "opencode"];
/// IA "natural" do motor da tarefa — mesma regra do TS (aiOfEngine).
pub fn ai_of_engine(engine: &str) -> &'static str {
    let e = engine.trim().to_lowercase();
    if e.starts_with("gemini") { "gemini" } else if e.starts_with("opencode") { "opencode" } else if e.starts_with("codex") { "codex" } else if dsh_engine(&e) { "deepseek" } else { "claude" }
}
/// IA com hooks de turno (ocupado/livre). Gemini/OpenCode não têm: o app entrega o texto na hora (o CLI guarda).
pub fn ai_has_hooks(ai: &str) -> bool { matches!(ai, "claude" | "codex" | "deepseek") }
/// O lançamento RECOMENDADO (IA + modelo que a criação da tarefa decidiu, ou o escolhido no app) e a linha do shell.
#[derive(Serialize, Default, Debug, Clone, PartialEq)]
pub struct Recommended { pub ai: String, pub model: String, pub command: String }
/// Palavra de shell sem aspas quando não precisa (mesma regra do shArg do TS).
fn sh_arg(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:@/+=-".contains(c)) { s.to_string() } else { format!("'{}'", s.replace('\'', "'\\''")) }
}
/// PURA (espelho do recommendedLaunch do TS): spec.termAi/termModel → senão a IA do motor do construtor + o modelo do papel.
pub fn recommended_of(spec: &serde_json::Value) -> Recommended {
    let st = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let roles = spec.get("roles").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let role = roles.iter().find(|r| r.get("role").and_then(|x| x.as_str()) == Some("builder")).or(roles.first());
    let engine = role.map(|r| st(r.get("engine"))).filter(|e| !e.is_empty()).unwrap_or_else(|| st(spec.get("engine")));
    let natural = ai_of_engine(&engine);
    let term_ai = st(spec.get("termAi"));
    let ai = if TERM_AIS.contains(&term_ai.as_str()) { term_ai.clone() } else { natural.to_string() };
    let term_model = st(spec.get("termModel"));
    let model = if term_ai == ai && !term_model.is_empty() { term_model }
        else if natural == ai { role.map(|r| st(r.get("model"))).filter(|m| !m.is_empty()).unwrap_or_else(|| st(spec.get("model"))) }
        else { String::new() };
    let command = format!("starfork ia {ai}{}", if model.is_empty() { String::new() } else { format!(" --modelo {}", sh_arg(&model)) });
    Recommended { ai, model, command }
}
/// Rótulo do DeepSeek — mesma regra do TS (isDshLabel): "deepseek…" ou "dsh" como palavra ("dsh-flash", "dsh:x").
pub fn dsh_engine(engine: &str) -> bool {
    let e = engine.trim().to_lowercase();
    e.starts_with("deepseek") || (e.starts_with("dsh") && !e[3..].chars().next().map(|c| c.is_alphanumeric() || c == '_').unwrap_or(false))
}
/// Livre? (hook Stop gravou busy=0). None = sem linha (sessão ainda subindo).
fn idle_probe(db: PathBuf, task_id: String) -> Arc<dyn Fn() -> Option<bool> + Send + Sync> {
    Arc::new(move || {
        let c = open_rw(&db).ok()?;
        c.query_row("SELECT busy FROM term_session WHERE task_id=?1", params![task_id], |r| r.get::<_, i64>(0)).ok().map(|b| b == 0)
    })
}
/// Tarefas cujo PTY vivo é o SHELL (terminal integrado) — não a IA direto (Windows / motor antigo).
static SHELLS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
fn shells() -> &'static Mutex<std::collections::HashSet<String>> { SHELLS.get_or_init(|| Mutex::new(Default::default())) }
fn is_shell(task_id: &str) -> bool { shells().lock().unwrap_or_else(|e| e.into_inner()).contains(task_id) }
/// IA rodando no shell agora ('' = shell no prompt; sem coluna/linha = '').
fn cli_of(db: &Path, task_id: &str) -> String {
    open_rw(db).ok().and_then(|c| c.query_row("SELECT cli FROM term_session WHERE task_id=?1", params![task_id], |r| r.get::<_, Option<String>>(0)).ok().flatten()).unwrap_or_default()
}
/// Banco de antes do terminal integrado: a coluna `cli` não existe (o motor também cria; aqui é só garantia).
fn ensure_cli_col(c: &Connection) {
    let _ = c.execute(
        "CREATE TABLE IF NOT EXISTS term_session (task_id TEXT PRIMARY KEY, pid INTEGER, engine TEXT, busy INTEGER NOT NULL DEFAULT 0, session_id TEXT, started_at INTEGER, updated_at INTEGER, cli TEXT)", [],
    );
    let _ = c.execute("ALTER TABLE term_session ADD COLUMN cli TEXT", []);
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
    open_task_q(repo, db, task_id, cols, rows, resume, message, false)
}
/// `quiet`: o app retomando SOZINHO ao abrir a tarefa — a IA só abre e espera (sem kickoff, sem mudar status, sem
/// gastar); o 1º envio da pessoa passa pelos portões de sempre. Com mensagem, o quieto não vale.
pub fn open_task_q(repo: &Path, db: &Path, task_id: &str, cols: u16, rows: u16, resume: bool, message: Option<&str>, quiet: bool) -> Result<Arc<pty::PtySession>, String> {
    let m = mgr().ok_or("terminal indisponível")?;
    if let Some(s) = m.live(task_id) { let _ = s.resize(cols, rows); return Ok(s); }
    let mut a = vec!["term-prep".to_string(), task_id.to_string()];
    if resume { a.push("--resume".into()); }
    if quiet && message.map(|m| m.trim().is_empty()).unwrap_or(true) { a.push("--quiet".into()); }
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
    {
        let mut sh = shells().lock().unwrap_or_else(|e| e.into_inner());
        if v.get("shell").and_then(|x| x.as_bool()).unwrap_or(false) { sh.insert(task_id.to_string()); } else { sh.remove(task_id); }
    }
    launched_set(task_id, &s("engine"), &s("model"));
    if let Ok(c) = open_rw(db) {
        ensure_cli_col(&c);
        // nasce OCUPADO quando já leva um pedido (o 1º UserPromptSubmit confirma; sem pedido, nasce livre). O motor diz
        // (`busy`: IA sem hooks nunca nasce ocupada — ninguém marcaria livre depois); motor antigo: a regra de sempre
        let resumed = v.get("resumed").and_then(|x| x.as_bool()).unwrap_or(false);
        let busy = match v.get("busy").and_then(|x| x.as_bool()) { Some(b) => b as i64, None => if resumed && message.is_none() { 0 } else { 1 } };
        // a IA sobe no 1º comando do shell: já conta como rodando (mensagem que chega antes vai pra fila, não pro prompt)
        let _ = c.execute(
            "INSERT INTO term_session (task_id, pid, engine, busy, started_at, updated_at, cli) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?3) \
             ON CONFLICT(task_id) DO UPDATE SET pid=excluded.pid, engine=excluded.engine, busy=excluded.busy, started_at=excluded.started_at, updated_at=excluded.updated_at, cli=excluded.cli",
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
    let v = engine_json(&repo, &a)?;
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if text.trim().is_empty() { return Err("nada pra mandar ao terminal".into()); }
    let m = mgr().ok_or("terminal indisponível")?;
    let live = m.live(task_id).is_some();
    let cli = if live { cli_of(&db, task_id) } else { String::new() };
    match route_action(live, is_shell(task_id), &cli) {
        RouteAction::Open => {}
        RouteAction::Direct => {
            // Gemini/OpenCode: sem hook de ocupado/livre — entrega já (o CLI guarda o que chega no meio do turno)
            let tid = task_id.to_string();
            std::thread::spawn(move || { if let Some(m) = mgr() { let _ = m.send_text(&tid, &text); } });
            return Ok(());
        }
        RouteAction::ShellLaunch => {
            // shell no prompt: a mensagem vai por ARQUIVO e o shell ganha a linha que sobe a IA da tarefa com ela
            let wt = v.get("worktree").and_then(|x| x.as_str()).filter(|w| !w.is_empty()).map(PathBuf::from).ok_or("worktree da tarefa não encontrada")?;
            let rec = spec_of(&db, task_id).map(|s| recommended_of(&s)).unwrap_or_default();
            return shell_launch(&db, task_id, &wt, &rec, Some(&text));
        }
        RouteAction::Queue => {}
    }
    if live {
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
/// O que fazer com um pedido do app pro terminal da tarefa.
#[derive(Debug, PartialEq)]
pub enum RouteAction { Open, Queue, Direct, ShellLaunch }
/// PURA: sem PTY → abre (retomando, com a mensagem); IA com hooks rodando → fila (entrega quando livre); IA sem hooks
/// (gemini/opencode) → na hora; shell no PROMPT (terminal integrado, cli '') → digita `starfork ia … --msg-file …`;
/// PTY que é a própria IA (Windows / motor antigo) → fila, como sempre.
pub fn route_action(live: bool, shell: bool, cli: &str) -> RouteAction {
    if !live { return RouteAction::Open; }
    if !cli.is_empty() { return if ai_has_hooks(cli) { RouteAction::Queue } else { RouteAction::Direct }; }
    if shell { RouteAction::ShellLaunch } else { RouteAction::Queue }
}
/// Linha que o app digita no shell no prompt pra subir a IA recomendada (retomando; com a mensagem por arquivo).
pub const NEXT_MSG_REL: &str = ".cardume/term/next-msg.txt";
/// O `starfork` da worktree (caminho ABSOLUTO: o rc da pessoa pode tirar .cardume/term/bin do PATH).
pub fn shim_path(worktree: &Path) -> PathBuf { worktree.join(".cardume").join("term").join("bin").join("starfork") }
pub fn shell_launch_line(rec: &Recommended, shim: &Path, with_msg: bool) -> String {
    let sh = shim.display().to_string();
    let args = rec.command.strip_prefix("starfork").unwrap_or(&rec.command);
    // Ctrl+E Ctrl+U antes: vai pro fim e limpa o que estiver meio digitado no prompt
    format!("\x05\x15'{}'{} --resume{}\r", sh.replace('\'', "'\\''"), args, if with_msg { format!(" --msg-file {NEXT_MSG_REL}") } else { String::new() })
}
/// Programas do grupo em PRIMEIRO PLANO no terminal (unix: os processos com pgid = `tpgid` do líder do PTY — o grupo
/// inteiro: um `sh script` com um `vim` dentro tem o líder "sh"). None = não deu pra saber.
pub fn foreground_comm(leader: u32) -> Option<Vec<String>> {
    if cfg!(windows) { return None; }
    let ps = |args: &[&str]| std::process::Command::new("ps").args(args).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string());
    let tp: i64 = ps(&["-o", "tpgid=", "-p", &leader.to_string()])?.trim().parse().ok().filter(|n: &i64| *n > 0)?;
    let all = ps(&["-A", "-o", "pgid=,comm="])?;
    let v: Vec<String> = all.lines().filter_map(|l| { let l = l.trim_start(); let (g, c) = l.split_once(char::is_whitespace)?; (g.trim().parse::<i64>().ok()? == tp).then(|| c.trim().to_string()) }).collect();
    (!v.is_empty()).then_some(v)
}
/// PURA: dá pra digitar no shell? Só se TODO o grupo em primeiro plano é shell (está no prompt). Outro programa
/// (vim, npm test, um `claude` aberto na mão) receberia a linha como texto. Sem como saber (None) → segue.
pub fn shell_at_prompt(fg: Option<&[String]>) -> Result<(), String> {
    let Some(list) = fg else { return Ok(()) };
    let is_shell = |c: &String| { let n = c.trim().rsplit('/').next().unwrap_or("").trim_start_matches('-'); ["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh"].contains(&n) };
    if list.iter().all(is_shell) { Ok(()) } else { Err("o terminal está rodando outro comando — termine ele (Ctrl+C) ou feche e reabra".into()) }
}
/// Shell no prompt → grava a mensagem (se houver) e digita a linha que sobe a IA. Já marca a IA como rodando (o
/// `starfork ia` confirma; se falhar, ele mesmo volta pra '') — um 2º pedido no meio vai pra fila, não pro prompt.
fn shell_launch(db: &Path, task_id: &str, worktree: &Path, rec: &Recommended, msg: Option<&str>) -> Result<(), String> {
    let s = mgr().and_then(|m| m.live(task_id)).ok_or("o terminal desta tarefa não está aberto")?;
    shell_at_prompt(foreground_comm(s.pid).as_deref())?;
    if let Some(t) = msg {
        let p = worktree.join(NEXT_MSG_REL);
        if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
        std::fs::write(&p, t).map_err(|e| format!("não consegui gravar a mensagem pro terminal: {e}"))?;
    }
    if let Ok(c) = open_rw(db) {
        ensure_cli_col(&c);
        let busy = if ai_has_hooks(&rec.ai) && msg.is_some() { 1 } else { 0 };
        let _ = c.execute("UPDATE term_session SET cli=?2, busy=?3, updated_at=?4 WHERE task_id=?1", params![task_id, rec.ai, busy, now_ms()]);
    }
    launched_set(task_id, &rec.ai, &rec.model);
    s.write_bytes(shell_launch_line(rec, &shim_path(worktree), msg.is_some()).as_bytes())
}
/// IA + modelo que o APP mandou abrir por último em cada terminal (troca pra mesma IA/modelo = nada a fazer).
static LAUNCHED: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
fn launched_set(task_id: &str, ai: &str, model: &str) {
    LAUNCHED.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.to_string(), (ai.to_string(), model.to_string()));
}
fn launched_get(task_id: &str) -> Option<(String, String)> {
    LAUNCHED.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner()).get(task_id).cloned()
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
/// Tarefa DeepSeek em modo terminal cai no `is_term` (a sessão é do `claude` com a API da DeepSeek); DeepSeek
/// headless (dsh) nunca vira terminal sozinha — a sessão do dsh não se retoma no `claude`.
pub fn talk_decision(t: &TaskRow, is_term: bool, live: bool, default: &str) -> Result<bool, String> {
    if is_term || live { return Ok(true); }
    if !talk_in_terminal(false, &t.engine, default, headless_busy(t)) { return Ok(false); }
    // integrada sem pasta: o motor RECRIA no mesmo caminho pra conversar (term-prep › ensureTaskWorktree conversation)
    // — só não dá sem caminho gravado (aí o erro do motor diria o mesmo, mais tarde)
    if worktree_gone_after_merge(&t.status, &t.worktree) && t.worktree.trim().is_empty() { return Err(WT_GONE.to_string()); }
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
/// Integrada sem pasta E sem caminho gravado: não há onde recriar — o caminho é uma tarefa nova de ajuste.
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

// ============================ terminal parado: encerrar o que ninguém olha ============================
/// Nota no feed quando o app encerra um terminal parado.
pub const REAPED_NOTE: &str = "terminal parado encerrado (ninguém olhava) — reabre sozinho quando você voltar à tarefa";
const REAP_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// Padrão de Ajustes › termIdleMin (minutos; 0 = nunca encerra).
pub const IDLE_MIN_DEFAULT: f64 = 15.0;
/// Teto de terminais vivos FORA DA TELA: passou, os parados mais antigos (≥ 1 min sem ninguém olhar) saem antes do prazo.
pub const LIVE_CAP: usize = 8;
static REAPED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
fn reaped() -> &'static Mutex<std::collections::HashSet<String>> { REAPED.get_or_init(|| Mutex::new(Default::default())) }
/// Minutos de Ajustes → ms (lixo = padrão; ≤ 0 = desligado → 0).
pub fn idle_ms_of(setting: Option<&str>) -> i64 {
    let m = setting.and_then(|v| v.trim().trim_matches('"').parse::<f64>().ok()).filter(|v| v.is_finite()).unwrap_or(IDLE_MIN_DEFAULT);
    if m <= 0.0 { 0 } else { (m * 60_000.0) as i64 }
}
/// Retrato de um terminal pro encerramento (tudo que a regra pura precisa).
#[derive(Clone, Debug, Default)]
pub struct ReapIn {
    pub watchers: usize,
    /// ms epoch desde quando ninguém olha (0 = alguém olhando)
    pub unseen_since: i64,
    pub last_out: i64,
    /// a IA está num turno (hook) — nunca encerra
    pub busy: bool,
    pub queued: usize,
    /// nada além do shell/da IA parada em 1º plano (um `npm run dev`, um vim… = não está parado)
    pub fg_idle: bool,
    /// IA sem hooks de ocupado (gemini/opencode): só a saída diz se trabalha — exige silêncio do prazo inteiro
    pub no_hooks: bool,
}
/// PURA: este terminal pode ser encerrado agora? `min_unseen` = há quanto tempo (ms) ninguém olha, no mínimo.
pub fn reap_ok(r: &ReapIn, now: i64, min_unseen: i64) -> bool {
    if r.watchers > 0 || r.unseen_since <= 0 || r.busy || r.queued > 0 || !r.fg_idle { return false; }
    let quiet_ms = if r.no_hooks { min_unseen } else { min_unseen.min(60_000) };
    now - r.unseen_since >= min_unseen && now - r.last_out >= quiet_ms
}
/// PURA: quem encerrar. Parado há `idle_ms` sai; e, se ainda sobrarem mais de `cap` vivos, os parados mais antigos (≥ 1 min).
pub fn reap_pick(list: &[(String, ReapIn)], now: i64, idle_ms: i64, cap: usize) -> Vec<String> {
    if idle_ms <= 0 { return vec![]; }
    let mut out: Vec<String> = list.iter().filter(|(_, r)| reap_ok(r, now, idle_ms)).map(|(id, _)| id.clone()).collect();
    let left = list.len() - out.len();
    if left > cap {
        let mut extra: Vec<&(String, ReapIn)> = list.iter().filter(|(id, r)| !out.contains(id) && reap_ok(r, now, 60_000.min(idle_ms))).collect();
        extra.sort_by_key(|(_, r)| r.unseen_since);
        out.extend(extra.into_iter().take(left - cap).map(|(id, _)| id.clone()));
    }
    out
}
fn reap_in(s: &pty::PtySession) -> ReapIn {
    let db = dbs().lock().unwrap_or_else(|e| e.into_inner()).get(&s.task_id).cloned();
    reap_in_with(s, db.as_deref(), is_shell(&s.task_id))
}
/// O retrato do encerramento a partir da sessão, do banco dela e se o PTY é o shell (testável fora do app).
pub fn reap_in_with(s: &pty::PtySession, db: Option<&Path>, shell: bool) -> ReapIn {
    let (unseen_since, last_out) = s.idle_marks();
    let (busy, cli) = db.and_then(|d| open_rw(d).ok()).and_then(|c| {
        c.query_row("SELECT busy, cli FROM term_session WHERE task_id=?1", params![s.task_id], |r| Ok((r.get::<_, i64>(0)? == 1, r.get::<_, Option<String>>(1)?.unwrap_or_default()))).ok()
    }).unwrap_or((false, String::new()));
    // shell no prompt: só se TODO o 1º plano é shell; IA rodando no shell (ou o PTY = a IA): quem diz é o hook
    let fg_idle = if shell && cli.is_empty() { shell_at_prompt(foreground_comm(s.pid).as_deref()).is_ok() } else { true };
    let at_prompt = shell && cli.is_empty();
    let ai = if cli.is_empty() { s.engine.clone() } else { cli };
    ReapIn { watchers: s.watchers(), unseen_since, last_out, busy, queued: s.queue_len(), fg_idle, no_hooks: !at_prompt && !ai_has_hooks(&ai) }
}
fn reap_tick() {
    let Some(m) = mgr() else { return };
    let idle_ms = idle_ms_of(setting_get("termIdleMin").as_deref());
    if idle_ms <= 0 { return; }
    let list: Vec<(String, ReapIn)> = m.list().into_iter().filter(|s| s.alive()).map(|s| (s.task_id.clone(), reap_in(&s))).collect();
    for id in reap_pick(&list, pty::now_ms(), idle_ms, LIVE_CAP) {
        // a pessoa abriu a tarefa entre o retrato e agora: fica
        if m.get(&id).map(|s| s.watchers() > 0).unwrap_or(true) { continue; }
        reaped().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone());
        web_log(format!("[term] {id}: terminal parado fora da tela — encerrado (termIdleMin)"));
        if !m.kill(&id) { reaped().lock().unwrap_or_else(|e| e.into_inner()).remove(&id); }
    }
}

// ============================ comandos Tauri ============================
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    alive: bool, data: String, cols: u16, rows: u16, engine: String, busy: bool, queued: usize, session_id: Option<String>,
    /// IA rodando DENTRO do shell agora: claude|codex|deepseek|gemini|opencode; '' = shell no prompt (ou sem terminal)
    cli: String,
    /// o PTY vivo é o shell da pessoa (terminal integrado); false = a IA direto (Windows) ou sem terminal
    shell: bool,
    /// lançamento recomendado da tarefa (IA + modelo da criação, ou o escolhido no app) + a linha exata do shell
    recommended: Recommended,
}

fn info(state: &State<AppState>, task_id: &str, data: String) -> TermInfo {
    let m = mgr();
    let s = m.as_ref().and_then(|m| m.live(task_id));
    let (cols, rows) = s.as_ref().map(|s| s.size()).unwrap_or_else(|| last_size(task_id));
    let (busy, sid) = db_of(state).ok().and_then(|db| open_rw(&db).ok()).and_then(|c| {
        c.query_row("SELECT busy, session_id FROM term_session WHERE task_id=?1", params![task_id], |r| Ok((r.get::<_, i64>(0)? == 1, r.get::<_, Option<String>>(1)?))).ok()
    }).unwrap_or((false, None));
    let db = db_of(state).ok();
    let alive = s.is_some();
    let cli = if alive { db.as_ref().map(|d| cli_of(d, task_id)).unwrap_or_default() } else { String::new() };
    let recommended = db.as_ref().and_then(|d| spec_of(d, task_id)).map(|sp| recommended_of(&sp)).unwrap_or_default();
    TermInfo { alive, data, cols, rows, engine: s.map(|s| s.engine.clone()).unwrap_or_default(), busy, queued: m.map(|m| m.queued(task_id)).unwrap_or(0), session_id: sid,
        cli, shell: alive && is_shell(task_id), recommended }
}

/// Abre o terminal (novo ou retomando a sessão gravada) e já devolve o histórico pra pintar.
#[tauri::command(async)]
pub fn term_open(state: State<AppState>, task_id: String, cols: u16, rows: u16, resume: Option<bool>, quiet: Option<bool>) -> Result<TermInfo, String> {
    let repo = repo_of(&state)?;
    let db = db_of(&state)?;
    remember_size(&task_id, cols, rows);
    let s = open_task_q(&repo, &db, &task_id, cols, rows, resume.unwrap_or(true), None, quiet.unwrap_or(false))?;
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

/// O que fazer ao pedir uma IA pro terminal (troca pelo seletor / "rodar o recomendado").
#[derive(Debug, PartialEq)]
pub enum LaunchAction { Open, Type, Restart, Nothing }
/// PURA: sem terminal → abre (o shell já sobe a IA gravada); a MESMA IA + modelo já rodando → nada; shell no prompt
/// → digita o comando; outra IA rodando (ou PTY que é a própria IA) → reinicia o terminal com a nova (retomando a
/// sessão DELA). `running` = IA+modelo que o app abriu por último (o cli do banco confirma a IA).
pub fn launch_action(live: bool, shell: bool, cli: &str, running: Option<(&str, &str)>, want: (&str, &str)) -> LaunchAction {
    if !live { return LaunchAction::Open; }
    if !cli.is_empty() && cli == want.0 && running == Some(want) { return LaunchAction::Nothing; }
    if shell && cli.is_empty() { LaunchAction::Type } else { LaunchAction::Restart }
}
fn run_launch(state: &State<AppState>, task_id: &str) -> Result<TermInfo, String> {
    let repo = repo_of(state)?;
    let db = db_of(state)?;
    let m = mgr().ok_or("terminal indisponível")?;
    let live = m.live(task_id).is_some();
    let rec = spec_of(&db, task_id).map(|s| recommended_of(&s)).ok_or("tarefa não encontrada")?;
    let running = launched_get(task_id);
    let (cols, rows) = last_size(task_id);
    match launch_action(live, is_shell(task_id), &cli_of(&db, task_id), running.as_ref().map(|(a, b)| (a.as_str(), b.as_str())), (&rec.ai, &rec.model)) {
        LaunchAction::Nothing => {}
        LaunchAction::Type => {
            let wt: String = open_rw(&db)?.query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get(0)).map_err(|e| e.to_string())?;
            shell_launch(&db, task_id, Path::new(&wt), &rec, None)?;
        }
        LaunchAction::Restart => {
            // o que estava na fila vai junto: a 1ª vira a 1ª mensagem da IA nova, o resto volta pra fila
            let mut queued = m.take_queue(task_id).into_iter();
            if !m.kill(task_id) { return Err("não consegui fechar o terminal".into()); }
            let first = queued.next();
            open_task(&repo, &db, task_id, cols, rows, true, first.as_deref())?;
            for q in queued { let _ = m.enqueue(task_id, q, idle_probe(db.clone(), task_id.to_string())); }
        }
        LaunchAction::Open => { open_task(&repo, &db, task_id, cols, rows, true, None)?; }
    }
    let data = m.get(task_id).map(|s| s.attach()).unwrap_or_default();
    Ok(info(state, task_id, data))
}
/// Seletor de IA do terminal (não-dev clica, dev digita `starfork ia …` — o MESMO caminho): grava a IA/modelo no spec
/// (spec.termAi/termModel — reabrir lembra) e sobe ela: shell no prompt → digita `starfork ia <ia> --resume`; IA
/// rodando → reinicia o terminal com a nova (retomando a sessão dela, se houver). `model` vazio = o da tarefa/da IA.
#[tauri::command(async)]
pub fn term_switch_ai(state: State<AppState>, task_id: String, ai: String, model: Option<String>) -> Result<TermInfo, String> {
    let ai = ai.trim().to_lowercase();
    if !TERM_AIS.contains(&ai.as_str()) { return Err(format!("IA desconhecida: {ai} (use {})", TERM_AIS.join(", "))); }
    let repo = repo_of(&state)?;
    let mut a = vec!["term-ai".to_string(), task_id.clone(), "--ai".into(), ai];
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) { a.push("--model".into()); a.push(m.trim().to_string()); }
    engine_json(&repo, &a)?;
    run_launch(&state, &task_id)
}
/// "Rodar o recomendado": a IA + modelo que a tarefa decidiu (TermInfo.recommended) — digitado no shell no prompt, ou
/// reiniciando o terminal se outra IA estiver rodando.
#[tauri::command(async)]
pub fn term_run_recommended(state: State<AppState>, task_id: String) -> Result<TermInfo, String> { run_launch(&state, &task_id) }

#[cfg(test)]
mod modo_padrao_tests {
    use super::{ai_of_engine, launch_action, record_exit, recommended_of, route_action, shell_at_prompt, shell_launch_line, shim_path, wants_terminal_on, LaunchAction, Recommended, RouteAction};
    use std::path::Path;
    use super::{dsh_engine, exit_note, history_for, mode_default, talk_decision, talk_in_terminal, wants_terminal, worktree_gone_after_merge, TaskRow, WT_GONE};
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
        assert_eq!(talk_decision(&row("merged", None, "/nao/existe"), false, false, "terminal"), Ok(true), "integrada sem pasta: recria no mesmo caminho pra conversar");
        assert_eq!(talk_decision(&row("merged", None, ""), false, false, "terminal"), Err(WT_GONE.to_string()), "sem caminho gravado: não há onde recriar");
        assert_eq!(talk_decision(&row("merged", None, "/nao/existe"), false, false, "auto"), Ok(false), "Automático escolhido: segue o chat headless");
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
        c.execute("UPDATE task SET status='merged', worktree='/nao/existe/mais'", []).unwrap();
        let m = history_for(&db, &repo, Some(&cfg), "t1", None, false, "terminal").unwrap();
        assert!(m.merged && !m.worktree_exists && m.resumes, "integrada sem pasta: o compositor retoma (a pasta é recriada pra conversar)");
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
    fn deepseek_no_terminal() {
        assert!(dsh_engine("deepseek") && dsh_engine("DeepSeek · V4 Pro") && dsh_engine("dsh") && dsh_engine("dsh-flash") && dsh_engine("dsh:x"));
        assert!(!dsh_engine("dshx") && !dsh_engine("claude") && !dsh_engine(""));
        let mut r = row("review", None, "/");
        r.engine = "deepseek".into();
        assert_eq!(talk_decision(&r, true, false, "terminal"), Ok(true), "DeepSeek em modo terminal: compositor vai pro PTY");
        assert_eq!(talk_decision(&r, false, true, "auto"), Ok(true), "PTY vivo vence");
        assert_eq!(talk_decision(&r, false, false, "terminal"), Ok(false), "DeepSeek headless (dsh) não retoma no claude");
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
        assert!(!wants_terminal(None, "terminal", false, "deepseek"), "DeepSeek: padrão segue automático");
        assert!(wants_terminal(Some("terminal"), "auto", false, "deepseek"), "DeepSeek escolhido no terminal (dentro do claude)");
        assert!(wants_terminal(None, "terminal", true, "deepseek-v4-pro"));
        assert!(wants_terminal(Some("terminal"), "terminal", false, "dsh-flash"));
        assert!(!wants_terminal(Some("auto"), "terminal", true, "deepseek"), "pedido explícito vence");
        assert!(!wants_terminal_on(Some("terminal"), "terminal", true, "gateway", true), "Windows: gateway sem CLI segue no automático");
        assert!(!wants_terminal_on(Some("terminal"), "terminal", true, "gateway", false), "shell: gateway não vira Claude em silêncio");
        assert!(!wants_terminal_on(Some("terminal"), "terminal", true, "logcomex", false));
        assert!(wants_terminal_on(Some("terminal"), "terminal", true, "gemini", false), "shell: a pessoa escolhe a IA");
        assert!(!wants_terminal_on(Some("terminal"), "terminal", true, "gemini", true), "Windows: a IA direto, sem gemini");
        assert!(!wants_terminal_on(None, "terminal", false, "gateway", false), "sem escolher terminal: só o Claude é padrão");
        assert!(!wants_terminal_on(Some("terminal"), "terminal", true, "", false) && !wants_terminal_on(Some("terminal"), "terminal", true, "mock", false));
        assert!(!wants_terminal(Some("auto"), "terminal", false, "claude"), "pedido explícito vence");
        assert!(!wants_terminal(None, "auto", false, "claude"));
    }
    #[test]
    fn rota_no_shell_integrado() {
        assert_eq!(route_action(false, true, ""), RouteAction::Open, "sem PTY: abre retomando, com a mensagem");
        assert_eq!(route_action(true, true, "claude"), RouteAction::Queue, "IA com hooks rodando: fila (entrega quando livre)");
        assert_eq!(route_action(true, true, "codex"), RouteAction::Queue);
        assert_eq!(route_action(true, true, "deepseek"), RouteAction::Queue);
        assert_eq!(route_action(true, true, "gemini"), RouteAction::Direct, "sem hooks: entrega na hora");
        assert_eq!(route_action(true, true, "opencode"), RouteAction::Direct);
        assert_eq!(route_action(true, true, ""), RouteAction::ShellLaunch, "shell no prompt: NÃO digita a mensagem no shell cru");
        assert_eq!(route_action(true, false, ""), RouteAction::Queue, "PTY = a própria IA (Windows / motor antigo): como sempre");
        let rec = Recommended { ai: "claude".into(), model: "sonnet".into(), command: "starfork ia claude --modelo sonnet".into() };
        let shim = shim_path(Path::new("/r/it's wt"));
        assert_eq!(shell_launch_line(&rec, &shim, true), "\x05\x15'/r/it'\\''s wt/.cardume/term/bin/starfork' ia claude --modelo sonnet --resume --msg-file .cardume/term/next-msg.txt\r", "caminho ABSOLUTO do shim, com aspas");
        assert_eq!(shell_launch_line(&rec, Path::new("/w/s"), false), "\x05\x15'/w/s' ia claude --modelo sonnet --resume\r");
        let want = ("claude", "sonnet");
        assert_eq!(launch_action(false, false, "", None, want), LaunchAction::Open);
        assert_eq!(launch_action(true, true, "", Some(("claude", "sonnet")), want), LaunchAction::Type, "shell no prompt: digita o comando");
        assert_eq!(launch_action(true, true, "claude", Some(("claude", "sonnet")), want), LaunchAction::Nothing, "a mesma IA + modelo já rodando: nada");
        assert_eq!(launch_action(true, true, "claude", Some(("claude", "opus")), want), LaunchAction::Restart, "mesma IA, outro modelo: reinicia");
        assert_eq!(launch_action(true, true, "codex", Some(("claude", "sonnet")), want), LaunchAction::Restart, "outra IA rodando (digitada na mão): reinicia");
        assert_eq!(launch_action(true, false, "", None, want), LaunchAction::Restart, "PTY que é a IA: reinicia");
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(shell_at_prompt(Some(&v(&["-zsh"]))), Ok(()));
        assert_eq!(shell_at_prompt(Some(&v(&["/bin/bash"]))), Ok(()));
        assert_eq!(shell_at_prompt(Some(&v(&["fish"]))), Ok(()));
        assert_eq!(shell_at_prompt(None), Ok(()), "sem como saber: segue");
        let err = Err("o terminal está rodando outro comando — termine ele (Ctrl+C) ou feche e reabra".to_string());
        for busy in [&["vim"][..], &["node"], &["/usr/local/bin/claude"], &["npm"], &["sh", "/x/claude"]] {
            assert_eq!(shell_at_prompt(Some(&v(busy))), err, "{busy:?}");
        }
    }
    #[test]
    fn recomendado_igual_ao_ts() {
        // os MESMOS casos do teste do TS (src/terminal-integrado.test.ts › "recomendado")
        let j = |v: &str| serde_json::from_str::<serde_json::Value>(v).unwrap();
        let base = r#"{"engine":"claude","roles":[{"role":"builder","name":"Vega","engine":"claude","model":"sonnet"}]"#;
        let r = recommended_of(&j(&format!("{base}}}")));
        assert_eq!((r.ai.as_str(), r.model.as_str(), r.command.as_str()), ("claude", "sonnet", "starfork ia claude --modelo sonnet"));
        assert_eq!(recommended_of(&j(&format!(r#"{base},"termAi":"gemini"}}"#))).command, "starfork ia gemini", "modelo do Claude não vai pro Gemini");
        assert_eq!(recommended_of(&j(&format!(r#"{base},"termAi":"gemini","termModel":"gemini-2.5-flash"}}"#))).command, "starfork ia gemini --modelo gemini-2.5-flash");
        assert_eq!(recommended_of(&j(&format!(r#"{base},"termAi":"claude"}}"#))).model, "sonnet");
        assert_eq!(recommended_of(&j(&format!(r#"{base},"termAi":"nada"}}"#))).ai, "claude");
        assert_eq!(recommended_of(&j(r#"{"roles":[{"role":"builder","engine":"claude","model":"claude opus 4"}]}"#)).command, "starfork ia claude --modelo 'claude opus 4'");
        assert_eq!(recommended_of(&j(r#"{"engine":"codex","roles":[{"role":"builder","engine":"codex"}]}"#)).command, "starfork ia codex");
        assert_eq!(recommended_of(&j(r#"{"engine":"deepseek","roles":[{"role":"planner","engine":"claude"},{"role":"builder","engine":"deepseek","model":"deepseek-flash"}]}"#)).command, "starfork ia deepseek --modelo deepseek-flash", "o construtor manda");
        assert_eq!(recommended_of(&j(r#"{"engine":"claude","model":"haiku"}"#)).command, "starfork ia claude --modelo haiku", "sem papéis: o motor/modelo da tarefa");
        assert_eq!(ai_of_engine("DeepSeek · V4 Pro"), "deepseek");
        assert_eq!(ai_of_engine("dsh-flash"), "deepseek");
        assert_eq!(ai_of_engine("gateway"), "claude");
        assert_eq!(ai_of_engine("opus"), "claude");
        assert_eq!(ai_of_engine("gemini-2.5"), "gemini");
    }
    #[test]
    fn fim_do_processo_velho_nao_mexe_na_sessao_nova() {
        use rusqlite::Connection;
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE task (id TEXT, status TEXT, busy_pid INTEGER); CREATE TABLE event (task_id TEXT, agent TEXT, ts INTEGER, type TEXT, text TEXT, ok INTEGER); \
            CREATE TABLE term_session (task_id TEXT PRIMARY KEY, pid INTEGER, engine TEXT, busy INTEGER NOT NULL DEFAULT 0, session_id TEXT, started_at INTEGER, updated_at INTEGER, cli TEXT);").unwrap();
        c.execute("INSERT INTO task VALUES ('t','running',200)", []).unwrap();
        // a troca de IA já gravou a sessão NOVA (pid 200, gemini, ocupada)
        c.execute("INSERT INTO term_session (task_id, pid, busy, cli) VALUES ('t',200,1,'gemini')", []).unwrap();
        assert!(!record_exit(&c, "t", 100, Some(0)), "o pid 100 (velho) saiu depois: não mexe");
        let row = |c: &Connection| c.query_row("SELECT s.pid, s.busy, s.cli, t.status, t.busy_pid, (SELECT COUNT(*) FROM event) FROM term_session s, task t", [], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, i64>(5)?))).unwrap();
        assert_eq!(row(&c), (Some(200), 1, "gemini".into(), "running".into(), Some(200), 0));
        assert!(record_exit(&c, "t", 200, Some(0)), "a sessão atual saiu: grava");
        assert_eq!(row(&c), (None, 0, "".into(), "review".into(), None, 1));
    }
}

#[cfg(test)]
mod terminal_parado_tests {
    use super::{idle_ms_of, reap_ok, reap_pick, ReapIn, IDLE_MIN_DEFAULT};
    const MIN: i64 = 60_000;
    fn parado(desde: i64) -> ReapIn { ReapIn { unseen_since: desde, last_out: desde, fg_idle: true, ..Default::default() } }

    #[test]
    fn prazo_de_ajustes_em_minutos_padrao_15_zero_desliga() {
        assert_eq!(idle_ms_of(None), (IDLE_MIN_DEFAULT * 60_000.0) as i64);
        assert_eq!(idle_ms_of(Some("15")), 15 * MIN);
        assert_eq!(idle_ms_of(Some("\"5\"")), 5 * MIN, "valor gravado como texto JSON");
        assert_eq!(idle_ms_of(Some("0")), 0, "0 = nunca encerra");
        assert_eq!(idle_ms_of(Some("-3")), 0);
        assert_eq!(idle_ms_of(Some("lixo")), 15 * MIN, "lixo = padrão");
    }

    #[test]
    fn so_encerra_o_que_ninguem_olha_parado_livre_sem_fila_e_sem_programa_em_primeiro_plano() {
        let now = 100 * MIN;
        assert!(reap_ok(&parado(now - 16 * MIN), now, 15 * MIN), "fora da tela há 16 min, parado");
        assert!(!reap_ok(&parado(now - 14 * MIN), now, 15 * MIN), "ainda dentro do prazo");
        assert!(!reap_ok(&ReapIn { watchers: 1, ..parado(now - 30 * MIN) }, now, 15 * MIN), "alguém olhando");
        assert!(!reap_ok(&ReapIn { unseen_since: 0, ..parado(now - 30 * MIN) }, now, 15 * MIN), "0 = olhando");
        assert!(!reap_ok(&ReapIn { busy: true, ..parado(now - 30 * MIN) }, now, 15 * MIN), "turno em curso nunca");
        assert!(!reap_ok(&ReapIn { queued: 1, ..parado(now - 30 * MIN) }, now, 15 * MIN), "mensagem na fila");
        assert!(!reap_ok(&ReapIn { fg_idle: false, ..parado(now - 30 * MIN) }, now, 15 * MIN), "npm run dev/vim no shell");
        assert!(!reap_ok(&ReapIn { last_out: now - 10_000, ..parado(now - 30 * MIN) }, now, 15 * MIN), "falou há 10 s");
        assert!(reap_ok(&ReapIn { last_out: now - 2 * MIN, ..parado(now - 30 * MIN) }, now, 15 * MIN), "IA com hooks: 1 min de silêncio basta");
        assert!(!reap_ok(&ReapIn { no_hooks: true, last_out: now - 2 * MIN, ..parado(now - 30 * MIN) }, now, 15 * MIN), "sem hooks: silêncio do prazo inteiro");
    }

    #[test]
    fn escolhe_os_vencidos_e_acima_do_teto_os_parados_mais_antigos() {
        let now = 100 * MIN;
        let l = |v: Vec<(&str, ReapIn)>| v.into_iter().map(|(a, b)| (a.to_string(), b)).collect::<Vec<_>>();
        let list = l(vec![("velha", parado(now - 20 * MIN)), ("nova", parado(now - 2 * MIN)), ("vista", ReapIn { watchers: 1, ..parado(0) })]);
        assert_eq!(reap_pick(&list, now, 15 * MIN, 8), vec!["velha"]);
        assert!(reap_pick(&list, now, 0, 8).is_empty(), "desligado");
        // 4 vivos com teto 2: a vencida sai, e ainda sobram 3 → sai a parada mais antiga (≥ 1 min); a vista nunca
        let list = l(vec![("a", parado(now - 20 * MIN)), ("b", parado(now - 5 * MIN)), ("c", parado(now - 3 * MIN)), ("vista", ReapIn { watchers: 1, ..parado(0) })]);
        assert_eq!(reap_pick(&list, now, 15 * MIN, 2), vec!["a", "b"]);
        let list = l(vec![("x", parado(now - 30_000)), ("y", parado(now - 20_000)), ("z", parado(now - 10_000))]);
        assert!(reap_pick(&list, now, 15 * MIN, 1).is_empty(), "acima do teto mas ninguém parado há 1 min: fica");
    }
}
