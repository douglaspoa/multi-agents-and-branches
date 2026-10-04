//! Driver de e2e REAL do modo terminal (fora do app): o MESMO caminho do term.rs — `cli term-prep` monta o
//! comando, o pty.rs spawna o CLI oficial — e uma lista de passos manda texto/Esc/mede CPU, conferindo o estado
//! que os hooks gravam no state.sqlite. Ignorado no `cargo test` normal (gasta créditos). Rodar:
//!
//!   E2E_REPO=<repo> E2E_TASK=<id> E2E_CLI=<src/cli.ts> E2E_STEPS='wait_idle:240;send:oi;wait_idle:120;cpu:10' \
//!     cargo test --lib pty_e2e -- --ignored --nocapture
//!
//! Passos (separados por `;;` ou `;`): wait_idle:S · wait_busy:S · send:TEXTO · enqueue:TEXTO · esc · keys:TEXTO (\r \x1b aceitos)
//! · sleep:S · cpu:S · screen · kill · resize:CxR
use crate::pty::{PtyManager, PtySink, SpawnSpec, SCROLL_CAP};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Sink { n: Mutex<usize>, bytes: Mutex<usize> }
impl PtySink for Sink {
    fn data(&self, _t: &str, c: &str) { *self.n.lock().unwrap() += 1; *self.bytes.lock().unwrap() += c.len(); }
    fn exit(&self, t: &str, _pid: u32, code: Option<u32>) { eprintln!("[e2e] {t} saiu: {code:?}"); }
}

fn strip_ansi(s: &str) -> String {
    let re = regex::Regex::new(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHM]").unwrap();
    re.replace_all(s, "").replace('\r', "")
}
fn busy(db: &PathBuf, task: &str) -> Option<i64> {
    let c = Connection::open(db).ok()?;
    let _ = c.busy_timeout(Duration::from_millis(3000));
    c.query_row("SELECT busy FROM term_session WHERE task_id=?1", params![task], |r| r.get(0)).ok()
}
fn done_count(db: &PathBuf, task: &str) -> i64 {
    Connection::open(db).ok().and_then(|c| c.query_row("SELECT COUNT(*) FROM event WHERE task_id=?1 AND type='done'", params![task], |r| r.get(0)).ok()).unwrap_or(0)
}
/// %CPU somado do grupo do processo (ps), média de amostras a cada 1 s.
fn cpu_group(pid: u32, secs: u64) -> (f64, f64) {
    let mut samples = vec![];
    for _ in 0..secs {
        std::thread::sleep(Duration::from_secs(1));
        let out = std::process::Command::new("ps").args(["-A", "-o", "pgid=,%cpu="]).output().unwrap();
        let s: f64 = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| {
            let mut it = l.split_whitespace();
            let g: u32 = it.next()?.parse().ok()?;
            let c: f64 = it.next()?.replace(',', ".").parse().ok()?;
            (g == pid).then_some(c)
        }).sum();
        samples.push(s);
    }
    let avg = samples.iter().sum::<f64>() / samples.len().max(1) as f64;
    (avg, samples.iter().cloned().fold(0.0, f64::max))
}

/// Segundos de CPU (usuário+sistema) gastos por ESTE processo até agora.
fn self_cpu_s() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru); }
    let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
    t(ru.ru_utime) + t(ru.ru_stime)
}

#[test]
#[ignore]
fn pty_e2e() {
    let repo = PathBuf::from(std::env::var("E2E_REPO").expect("E2E_REPO"));
    let task = std::env::var("E2E_TASK").expect("E2E_TASK");
    let cli = std::env::var("E2E_CLI").expect("E2E_CLI");
    let steps = std::env::var("E2E_STEPS").unwrap_or_default();
    let db = repo.join(".cardume").join("state.sqlite");
    let mut prep = std::process::Command::new("node");
    prep.args(["--disable-warning=ExperimentalWarning", &cli, "term-prep", &task, "--repo"]).arg(&repo).current_dir(&repo);
    if std::env::var("E2E_RESUME").is_ok() { prep.arg("--resume"); }
    if let Ok(m) = std::env::var("E2E_MSG") { prep.args(["--msg", &m]); }
    let out = prep.output().unwrap();
    let so = String::from_utf8_lossy(&out.stdout);
    let line = so.lines().rev().find(|l| l.starts_with('{')).unwrap_or_else(|| panic!("prep: {}", String::from_utf8_lossy(&out.stderr)));
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    assert!(v.get("error").is_none(), "{v}");
    let list = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_else(Vec::new);
    let env = v["env"].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_str().unwrap_or("").to_string())).collect();
    let sink = Arc::new(Sink { n: Mutex::new(0), bytes: Mutex::new(0) });
    let m = Arc::new(PtyManager::new(sink.clone(), None));
    let t0 = Instant::now();
    let s = m.spawn(&task, SpawnSpec {
        program: v["program"].as_str().unwrap().into(), args: list("args"), cwd: PathBuf::from(v["cwd"].as_str().unwrap()), env, env_remove: list("envRemove"),
        cols: 120, rows: 34, log_path: Some(repo.join(".cardume").join("term").join(format!("{task}.log"))), scroll_cap: SCROLL_CAP, engine: v["engine"].as_str().unwrap_or("").into(),
    }).unwrap();
    s.attach();
    let resumed = v["resumed"].as_bool().unwrap_or(false);
    {
        let c = Connection::open(&db).unwrap();
        let _ = c.busy_timeout(Duration::from_millis(3000));
        let b = if resumed && std::env::var("E2E_MSG").is_err() { 0 } else { 1 };
        c.execute("INSERT INTO term_session (task_id, pid, engine, busy, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 0) ON CONFLICT(task_id) DO UPDATE SET pid=excluded.pid, busy=excluded.busy", params![task, s.pid as i64, v["engine"].as_str(), b]).unwrap();
    }
    eprintln!("[e2e] pid {} · {} · resumed={resumed}", s.pid, v["engine"]);
    let probe: Arc<dyn Fn() -> Option<bool> + Send + Sync> = { let (db, t) = (db.clone(), task.clone()); Arc::new(move || busy(&db, &t).map(|b| b == 0)) };
    let unesc = |x: &str| x.replace("\\r", "\r").replace("\\x1b", "\x1b").replace("\\n", "\n");
    let sep = if steps.contains(";;") { ";;" } else { ";" };
    for step in steps.split(sep).map(str::trim).filter(|x| !x.is_empty()) {
        let (cmd, arg) = step.split_once(':').unwrap_or((step, ""));
        let ts = t0.elapsed().as_secs_f32();
        match cmd {
            "wait_idle" => {
                let base = done_count(&db, &task);
                let lim = Duration::from_secs(arg.parse().unwrap_or(120));
                let w = Instant::now();
                while w.elapsed() < lim && !(busy(&db, &task) == Some(0) && done_count(&db, &task) > base) && s.alive() { std::thread::sleep(Duration::from_millis(250)); }
                eprintln!("[e2e {ts:.1}s] wait_idle → busy={:?} done+{} em {:.1}s", busy(&db, &task), done_count(&db, &task) - base, w.elapsed().as_secs_f32());
            }
            "wait_busy" => {
                let w = Instant::now();
                let lim = Duration::from_secs(arg.parse().unwrap_or(30));
                while w.elapsed() < lim && busy(&db, &task) != Some(1) { std::thread::sleep(Duration::from_millis(100)); }
                eprintln!("[e2e {ts:.1}s] wait_busy → busy={:?} em {:.1}s", busy(&db, &task), w.elapsed().as_secs_f32());
            }
            "send" => { m.send_text(&task, &unesc(arg)).unwrap(); eprintln!("[e2e {ts:.1}s] send {arg:?}"); }
            "enqueue" => { let n = m.enqueue(&task, unesc(arg), probe.clone()).unwrap(); eprintln!("[e2e {ts:.1}s] enqueue ({n}º) {arg:?}"); }
            "esc" => { m.interrupt(&task).unwrap(); eprintln!("[e2e {ts:.1}s] esc"); }
            "keys" => { s.write_bytes(unesc(arg).as_bytes()).unwrap(); eprintln!("[e2e {ts:.1}s] keys {arg:?}"); }
            "sleep" => std::thread::sleep(Duration::from_secs_f32(arg.parse().unwrap_or(1.0))),
            "resize" => { let (c, r) = arg.split_once('x').unwrap(); s.resize(c.parse().unwrap(), r.parse().unwrap()).unwrap(); }
            "cpu" => {
                let secs: u64 = arg.parse().unwrap_or(10);
                let self0 = self_cpu_s(); let w0 = Instant::now();
                let (a, mx) = cpu_group(s.pid, secs);
                let app = 100.0 * (self_cpu_s() - self0) / w0.elapsed().as_secs_f64();
                eprintln!("[e2e {ts:.1}s] CPU — CLI (grupo): média {a:.2}% · pico {mx:.1}% | lado do app (PTY+lotes, este processo): {app:.2}% | eventos de saída até aqui: {} ({} bytes)", sink.n.lock().unwrap(), sink.bytes.lock().unwrap());
            }
            "screen" => { let t = strip_ansi(&s.snapshot()); let tail: String = t.chars().rev().take(2500).collect::<Vec<_>>().into_iter().rev().collect(); eprintln!("[e2e {ts:.1}s] ---- tela (fim) ----\n{tail}\n---- fim da tela ----"); }
            "trust" => {
                // diálogos de primeira vez: "confiar nesta pasta" (Claude: ↓+Enter; Codex: Enter) e "Hooks need
                // review" do Codex (2 = confiar em todos). Sai quando a sessão começa a trabalhar.
                let w = Instant::now();
                let mut handled = std::collections::HashSet::new();
                while w.elapsed() < Duration::from_secs(arg.parse().unwrap_or(10)) {
                    let t = strip_ansi(&s.snapshot()).replace(' ', "");
                    let tail: String = t.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
                    if tail.contains("Itrustthisfolder") && handled.insert("claude-trust") { s.write_bytes(b"\x1b[B").unwrap(); std::thread::sleep(Duration::from_millis(400)); s.write_bytes(b"\r").unwrap(); eprintln!("[e2e] confiou na pasta (claude)"); }
                    if tail.contains("Doyoutrustthecontents") && handled.insert("codex-trust") { s.write_bytes(b"\r").unwrap(); eprintln!("[e2e] confiou na pasta (codex)"); }
                    if tail.contains("Hooksneedreview") && handled.insert("codex-hooks") { s.write_bytes(b"\x1b[B").unwrap(); std::thread::sleep(Duration::from_millis(300)); s.write_bytes(b"\r").unwrap(); eprintln!("[e2e] confiou nos hooks (codex)"); }
                    if busy(&db, &task) == Some(1) && handled.len() > 0 && w.elapsed() > Duration::from_secs(3) { break; }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
            "busy" => eprintln!("[e2e {ts:.1}s] busy={:?}", busy(&db, &task)),
            "kill" => { eprintln!("[e2e {ts:.1}s] kill → {}", m.kill(&task)); }
            _ => eprintln!("[e2e] passo desconhecido: {step}"),
        }
    }
    s.persist();
    if s.alive() && std::env::var("E2E_KEEP").is_err() { m.kill(&task); }
    eprintln!("[e2e] fim em {:.1}s", t0.elapsed().as_secs_f32());
}

/// TERMINAL INTEGRADO NO SHELL — e2e REAL com uma IA FALSA (não gasta crédito): `cli term-prep` monta o shell de
/// login, o pty.rs spawna, o 1º comando (`starfork ia claude`) sobe a IA falsa (CARDUME_AI_BIN_claude) e se confere:
/// a IA tem o TTY (grupo em primeiro plano), o texto digitado chega nela, Ctrl+C chega nela (e NÃO mata o shell),
/// term_session.cli = claude → '' ao sair, a decisão de rota (fila → shell no prompt), a linha que o app digita no
/// shell (`starfork ia … --resume --msg-file …`) sobe a IA de novo com a mensagem, e `starfork status` no shell.
///
///   SF_E2E_REPO=<repo> SF_E2E_TASK=<id> SF_E2E_CLI=<src/cli.ts> SF_E2E_FAKE=<ia falsa> \
///     cargo test --lib shell_e2e -- --ignored --nocapture
#[test]
#[ignore]
fn shell_e2e() {
    use crate::term::{foreground_comm, recommended_of, route_action, shell_at_prompt, shell_launch_line, shim_path, RouteAction, NEXT_MSG_REL};
    let repo = PathBuf::from(std::env::var("SF_E2E_REPO").expect("SF_E2E_REPO"));
    let task = std::env::var("SF_E2E_TASK").expect("SF_E2E_TASK");
    let cli = std::env::var("SF_E2E_CLI").expect("SF_E2E_CLI");
    let fake = std::env::var("SF_E2E_FAKE").expect("SF_E2E_FAKE");
    let db = repo.join(".cardume").join("state.sqlite");
    let out = std::process::Command::new("node").args(["--disable-warning=ExperimentalWarning", &cli, "term-prep", &task, "--resume", "--msg", "primeira mensagem", "--repo"]).arg(&repo).current_dir(&repo).output().unwrap();
    let so = String::from_utf8_lossy(&out.stdout);
    let line = so.lines().rev().find(|l| l.starts_with('{')).unwrap_or_else(|| panic!("prep: {}", String::from_utf8_lossy(&out.stderr)));
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    assert!(v.get("error").is_none(), "{v}");
    assert_eq!(v["shell"].as_bool(), Some(true), "macOS/Linux: o PTY é o shell");
    let list = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_else(Vec::new);
    let mut env: Vec<(String, String)> = v["env"].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_str().unwrap_or("").to_string())).collect();
    env.push(("CARDUME_AI_BIN_claude".into(), fake.clone()));
    env.push(("CARDUME_NOTIFY".into(), "0".into()));
    let m = Arc::new(PtyManager::new(Arc::new(Sink { n: Mutex::new(0), bytes: Mutex::new(0) }), None));
    let s = m.spawn(&task, SpawnSpec {
        program: v["program"].as_str().unwrap().into(), args: list("args"), cwd: PathBuf::from(v["cwd"].as_str().unwrap()), env, env_remove: list("envRemove"),
        cols: 120, rows: 34, log_path: None, scroll_cap: SCROLL_CAP, engine: v["engine"].as_str().unwrap_or("").into(),
    }).unwrap();
    s.attach();
    let screen = || strip_ansi(&s.snapshot());
    let wait = |needle: &str, secs: u64| { let w = Instant::now(); while w.elapsed() < Duration::from_secs(secs) { if screen().matches(needle).count() > 0 { return true; } std::thread::sleep(Duration::from_millis(50)); } false };
    let count = |needle: &str| screen().matches(needle).count();
    let wait_n = |needle: &str, n: usize, secs: u64| { let w = Instant::now(); while w.elapsed() < Duration::from_secs(secs) { if count(needle) >= n { return true; } std::thread::sleep(Duration::from_millis(50)); } false };
    let cli_now = || Connection::open(&db).ok().and_then(|c| c.query_row("SELECT cli FROM term_session WHERE task_id=?1", params![task], |r| r.get::<_, Option<String>>(0)).ok().flatten()).unwrap_or_default();
    let tail = || { let t = screen(); t.chars().rev().take(3000).collect::<Vec<_>>().into_iter().rev().collect::<String>() };

    assert!(wait("FAKE-AI ", 40), "a IA falsa subiu no 1º comando do shell:\n{}", tail());
    assert!(screen().contains("TTY=sim"), "a IA é o grupo em PRIMEIRO PLANO do terminal:\n{}", tail());
    assert!(screen().contains("LAST=primeira mensagem"), "a mensagem do app chegou como 1ª mensagem (por arquivo):\n{}", tail());
    assert_eq!(cli_now(), "claude", "term_session.cli = a IA rodando");
    assert_eq!(route_action(true, true, &cli_now()), RouteAction::Queue, "IA com hooks rodando: pedido do app vai pra fila");
    s.write_bytes(b"ola\r").unwrap();
    assert!(wait("FAKE-ECO:ola", 10), "texto digitado chega na IA:\n{}", tail());
    s.write_bytes(b"\x03").unwrap();
    assert!(wait("FAKE-GOT-INT", 10), "Ctrl+C chega na IA:\n{}", tail());
    s.write_bytes(b"segue\r").unwrap();
    assert!(wait("FAKE-ECO:segue", 10), "depois do Ctrl+C a IA (e o shell) seguem vivos:\n{}", tail());
    s.write_bytes(b"sair\r").unwrap();
    let w = Instant::now();
    while w.elapsed() < Duration::from_secs(20) && !cli_now().is_empty() { std::thread::sleep(Duration::from_millis(100)); }
    assert_eq!(cli_now(), "", "a IA saiu → `_ia-exit` gravou cli = ''");
    assert!(s.alive(), "o shell continua vivo depois da IA");
    assert_eq!(route_action(true, true, ""), RouteAction::ShellLaunch, "shell no prompt: o app digita o comando que sobe a IA");
    // o MESMO que term.rs › shell_launch faz: mensagem por arquivo + a linha recomendada digitada no prompt
    let spec: serde_json::Value = Connection::open(&db).unwrap().query_row("SELECT spec_json FROM task WHERE id=?1", params![task], |r| r.get::<_, String>(0)).map(|t| serde_json::from_str(&t).unwrap()).unwrap();
    let rec = recommended_of(&spec);
    assert_eq!(rec.command, v["recommended"]["command"].as_str().unwrap(), "Rust e TS recomendam a MESMA linha");
    std::thread::sleep(Duration::from_millis(800)); // o prompt do shell voltar
    assert_eq!(shell_at_prompt(foreground_comm(s.pid).as_deref()), Ok(()), "o shell está no prompt (primeiro plano = shell): {:?}", foreground_comm(s.pid));
    std::fs::write(PathBuf::from(v["cwd"].as_str().unwrap()).join(NEXT_MSG_REL), "segunda mensagem").unwrap();
    s.write_bytes(shell_launch_line(&rec, &shim_path(&PathBuf::from(v["cwd"].as_str().unwrap())), true).as_bytes()).unwrap();
    assert!(wait_n("FAKE-AI ", 2, 40), "a linha digitada no prompt sobe a IA de novo:\n{}", tail());
    assert!(wait("LAST=segunda mensagem", 5), "com a mensagem do arquivo:\n{}", tail());
    s.write_bytes(b"sair\r").unwrap();
    let w = Instant::now();
    while w.elapsed() < Duration::from_secs(20) && !cli_now().is_empty() { std::thread::sleep(Duration::from_millis(100)); }
    std::thread::sleep(Duration::from_millis(800));
    // um comando qualquer em primeiro plano no shell (cli = ''): o app NÃO pode digitar nele
    s.write_bytes(b"sleep 30\r").unwrap();
    std::thread::sleep(Duration::from_millis(700));
    assert!(shell_at_prompt(foreground_comm(s.pid).as_deref()).is_err(), "`sleep` em primeiro plano: não é o prompt ({:?})", foreground_comm(s.pid));
    s.write_bytes(b"\x03").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(shell_at_prompt(foreground_comm(s.pid).as_deref()), Ok(()), "Ctrl+C: de volta ao prompt");
    s.write_bytes(b"starfork status\r").unwrap();
    assert!(wait("Falta para ENTREGUE", 40), "`starfork status` funciona no shell:\n{}", tail());
    s.write_bytes(b"exit\r").unwrap();
    let w = Instant::now();
    while w.elapsed() < Duration::from_secs(10) && s.alive() { std::thread::sleep(Duration::from_millis(100)); }
    assert!(!s.alive(), "`exit` no shell fecha o terminal");
    eprintln!("[shell_e2e] ok — tela final:\n{}", tail());
}

/// Terminal integrado com a IA REAL (gasta crédito — só manual): SF_E2E_REPO/SF_E2E_TASK/SF_E2E_CLI + SF_E2E_AI
/// (claude|codex). O shell sobe a IA da tarefa com a 1ª mensagem; ela tem que usar o comando `starfork sugerir`
/// (integração universal) — o evento `suggest` aparece no banco — e, ao sair, o shell volta (cli = '').
#[test]
#[ignore]
fn shell_ia_real_e2e() {
    let repo = PathBuf::from(std::env::var("SF_E2E_REPO").expect("SF_E2E_REPO"));
    let task = std::env::var("SF_E2E_TASK").expect("SF_E2E_TASK");
    let cli = std::env::var("SF_E2E_CLI").expect("SF_E2E_CLI");
    let ai = std::env::var("SF_E2E_AI").unwrap_or_else(|_| "claude".into());
    let db = repo.join(".cardume").join("state.sqlite");
    let start_id: i64 = Connection::open(&db).ok().and_then(|c| c.query_row("SELECT COALESCE(MAX(id),0) FROM event", [], |r| r.get(0)).ok()).unwrap_or(0);
    let msg = "Teste do Starfork: NÃO mexa em arquivo nenhum. Rode no shell exatamente: starfork sugerir \"pode seguir\" \"pare aqui\" — depois responda só PRONTO.";
    let out = std::process::Command::new("node").args(["--disable-warning=ExperimentalWarning", &cli, "term-prep", &task, "--ai", &ai, "--msg", msg, "--repo"]).arg(&repo).current_dir(&repo).output().unwrap();
    let so = String::from_utf8_lossy(&out.stdout);
    let line = so.lines().rev().find(|l| l.starts_with('{')).unwrap_or_else(|| panic!("prep: {}", String::from_utf8_lossy(&out.stderr)));
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    assert!(v.get("error").is_none(), "{v}");
    let list = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_else(Vec::new);
    let env: Vec<(String, String)> = v["env"].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_str().unwrap_or("").to_string())).chain([("CARDUME_NOTIFY".to_string(), "0".to_string())]).collect();
    let m = Arc::new(PtyManager::new(Arc::new(Sink { n: Mutex::new(0), bytes: Mutex::new(0) }), None));
    let s = m.spawn(&task, SpawnSpec {
        program: v["program"].as_str().unwrap().into(), args: list("args"), cwd: PathBuf::from(v["cwd"].as_str().unwrap()), env, env_remove: list("envRemove"),
        cols: 120, rows: 34, log_path: None, scroll_cap: SCROLL_CAP, engine: v["engine"].as_str().unwrap_or("").into(),
    }).unwrap();
    s.attach();
    let q = |sql: &str| Connection::open(&db).ok().and_then(|c| { let _ = c.busy_timeout(Duration::from_millis(3000)); c.query_row(sql, params![task], |r| r.get::<_, Option<String>>(0)).ok().flatten() }).unwrap_or_default();
    let tail = || { let t = strip_ansi(&s.snapshot()); t.chars().rev().take(2500).collect::<Vec<_>>().into_iter().rev().collect::<String>() };
    let w = Instant::now();
    while w.elapsed() < Duration::from_secs(240) && q("SELECT text FROM event WHERE task_id=?1 AND type='suggest' AND id > START ORDER BY id DESC LIMIT 1".replace("START", &start_id.to_string()).as_str()).is_empty() {
        // o Codex/Claude podem pedir confiança na pasta: Enter aceita o padrão
        // pasta nova: o Claude Code pergunta se confia (padrão = "No, exit") → seta pra baixo + Enter = "Yes"
        let t = tail();
        if t.replace(' ', "").contains("trustthecontentsofthisdirectory") && t.contains("Press enter") && !t.contains("PRONTO") { s.write_bytes(b"\r").unwrap(); std::thread::sleep(Duration::from_secs(3)); }
        else if t.replace(' ', "").contains("trustthisfolder") && !t.contains("PRONTO") { s.write_bytes(b"\x1b[B").unwrap(); std::thread::sleep(Duration::from_millis(400)); s.write_bytes(b"\r").unwrap(); std::thread::sleep(Duration::from_secs(3)); }
        std::thread::sleep(Duration::from_millis(500));
    }
    let sug = q(&"SELECT text FROM event WHERE task_id=?1 AND type='suggest' AND id > START ORDER BY id DESC LIMIT 1".replace("START", &start_id.to_string()));
    assert!(sug.contains("pode seguir"), "a IA real usou `starfork sugerir` → evento suggest:\n{}", tail());
    assert_eq!(q("SELECT cli FROM term_session WHERE task_id=?1"), ai, "cli = a IA rodando");
    eprintln!("[ia-real] suggest = {sug}");
    eprintln!("[ia-real] eventos: {}", Connection::open(&db).unwrap().prepare("SELECT agent||' · '||type||' · '||substr(text,1,90) FROM event WHERE task_id=?1 ORDER BY id").unwrap().query_map(params![task], |r| r.get::<_, String>(0)).unwrap().filter_map(|x| x.ok()).collect::<Vec<_>>().join("\n  "));
    std::thread::sleep(Duration::from_secs(8));
    s.write_bytes(if ai == "codex" { b"\x03\x03" as &[u8] } else { b"/exit\r" }).unwrap();
    let w = Instant::now();
    while w.elapsed() < Duration::from_secs(30) && !q("SELECT cli FROM term_session WHERE task_id=?1").is_empty() { std::thread::sleep(Duration::from_millis(200)); }
    assert_eq!(q("SELECT cli FROM term_session WHERE task_id=?1"), "", "a IA saiu → shell de volta:\n{}", tail());
    assert!(s.alive(), "o shell segue vivo");
    s.write_bytes(b"starfork status\r").unwrap();
    std::thread::sleep(Duration::from_secs(6));
    assert!(tail().contains("t1") || tail().to_lowercase().contains("requisito"), "`starfork status` no shell:\n{}", tail());
    eprintln!("[ia-real] ok — tela final:\n{}", tail());
    m.kill(&task);
}
