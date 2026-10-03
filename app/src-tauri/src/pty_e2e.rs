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
    fn exit(&self, t: &str, code: Option<u32>) { eprintln!("[e2e] {t} saiu: {code:?}"); }
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
            "cpu" => { let (a, mx) = cpu_group(s.pid, arg.parse().unwrap_or(10)); eprintln!("[e2e {ts:.1}s] CPU do grupo do CLI: média {a:.2}% · pico {mx:.1}% · eventos de saída até aqui: {} ({} bytes)", sink.n.lock().unwrap(), sink.bytes.lock().unwrap()); }
            "screen" => { let t = strip_ansi(&s.snapshot()); let tail: String = t.chars().rev().take(2500).collect::<Vec<_>>().into_iter().rev().collect(); eprintln!("[e2e {ts:.1}s] ---- tela (fim) ----\n{tail}\n---- fim da tela ----"); }
            "trust" => {
                // diálogo "confiar nesta pasta" (worktree nova, repo nunca aberto no Claude Code): ↓ + Enter
                let w = Instant::now();
                while w.elapsed() < Duration::from_secs(arg.parse().unwrap_or(10)) {
                    let t = strip_ansi(&s.snapshot()).replace(' ', "");
                    if t.contains("Itrustthisfolder") { s.write_bytes(b"\x1b[B").unwrap(); std::thread::sleep(Duration::from_millis(400)); s.write_bytes(b"\r").unwrap(); eprintln!("[e2e {ts:.1}s] confiou na pasta"); break; }
                    if busy(&db, &task) == Some(1) && done_count(&db, &task) >= 0 && t.contains("bypass") { break; }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            "kill" => { eprintln!("[e2e {ts:.1}s] kill → {}", m.kill(&task)); }
            _ => eprintln!("[e2e] passo desconhecido: {step}"),
        }
    }
    s.persist();
    if s.alive() && std::env::var("E2E_KEEP").is_err() { m.kill(&task); }
    eprintln!("[e2e] fim em {:.1}s", t0.elapsed().as_secs_f32());
}
