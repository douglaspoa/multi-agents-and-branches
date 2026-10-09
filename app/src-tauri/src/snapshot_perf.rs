//! TRAVAMENTO AO ENVIAR MENSAGEM (28/09): o snapshot roda a cada ~1s e logo depois de todo envio.
//! Medição reprodutível num banco com volume de projeto grande (centenas de tarefas, dezenas de
//! milhares de eventos, revisões gordas). `SNAP_BENCH_DB=<state.sqlite>` mede um banco real e
//! `SNAP_DUMP=<arquivo>` grava o JSON (pro harness do front).
use super::*;

pub(crate) fn big_db(tag: &str, tasks: usize, events: usize) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("snapperf-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".cardume")).unwrap();
    let db = dir.join(".cardume").join("state.sqlite");
    let c = Connection::open(&db).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL, agent TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'builder', roles_json TEXT NOT NULL DEFAULT '[]', branch TEXT NOT NULL, worktree TEXT NOT NULL, base TEXT NOT NULL, engine TEXT NOT NULL, model TEXT, spec_json TEXT NOT NULL, created_at INTEGER NOT NULL, session_id TEXT, sort_order INTEGER, done_roles INTEGER NOT NULL DEFAULT 0, busy_pid INTEGER, flag TEXT);
         CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, ts INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, ok INTEGER);
         CREATE TABLE claim (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL, yielded_to TEXT, created_at INTEGER NOT NULL);
         CREATE TABLE diffstat (task_id TEXT PRIMARY KEY, files INTEGER NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE review (task_id TEXT PRIMARY KEY, summary TEXT NOT NULL, functions_json TEXT NOT NULL, files_json TEXT NOT NULL, how_to_test TEXT NOT NULL, by_agent TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, options TEXT, status TEXT NOT NULL DEFAULT 'open', answer TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
         CREATE TABLE work_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, done_at INTEGER);
         CREATE TABLE cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL);
         CREATE INDEX ev_task ON event(task_id, id);
         BEGIN;",
    )
    .unwrap();
    let reqs: Vec<String> = (0..40).map(|i| format!("requisito {i} com texto razoavelmente longo {}", "x".repeat(150))).collect();
    let spec = serde_json::json!({ "kind": "build", "deliverables": ["doc", "tests"], "requirements": reqs }).to_string();
    for i in 0..tasks {
        let tid = format!("t{i}");
        let busy: Option<i64> = if i % 7 == 0 { Some(999_999) } else { None };
        c.execute(
            "INSERT INTO task (id,title,objective,status,agent,branch,worktree,base,engine,spec_json,created_at,busy_pid) VALUES (?1,?2,?3,?4,'Coder','b','/nao/existe','main','claude',?5,?6,?7)",
            params![tid, format!("Tarefa {i}"), "objetivo ".repeat(40), if i % 7 == 0 { "running" } else { "review" }, spec, i as i64, busy],
        )
        .unwrap();
        let funcs = format!("[{}{{}}]", "{\"n\":\"fn\"},".repeat(if i % 20 == 0 { 40_000 } else { 50 }));
        c.execute("INSERT INTO review VALUES (?1,?2,?3,'[]',?4,'Coder',1)", params![tid, "resumo ".repeat(600), funcs, "passo ".repeat(900)]).unwrap();
        c.execute("INSERT INTO diffstat VALUES (?1,3,10,2,1)", params![tid]).unwrap();
        for k in 0..10 {
            c.execute("INSERT INTO claim (task_id,agent,path,mode,created_at) VALUES (?1,'Coder',?2,'exclusive',1)", params![tid, format!("src/f{k}.ts")]).unwrap();
            c.execute("INSERT INTO cost (task_id,agent,role,usd,in_tok,out_tok,created_at) VALUES (?1,'Coder','builder',0.5,1000,200,1)", params![tid]).unwrap();
        }
        c.execute("INSERT INTO pending (task_id,agent,kind,prompt,created_at) VALUES (?1,'Coder','question','ok?',1)", params![tid]).unwrap();
        if i % 5 == 0 {
            c.execute("INSERT INTO work_queue (task_id,kind,payload,created_at) VALUES (?1,'talk','{}',1)", params![tid]).unwrap();
        }
    }
    for e in 0..events {
        let txt = if e % 50 == 0 { "saida longa de ferramenta ".repeat(800) } else { format!("evento {e} {}", "y".repeat(120)) };
        c.execute("INSERT INTO event (task_id,agent,ts,type,text,ok) VALUES (?1,'Coder',?2,'bash',?3,1)", params![format!("t{}", e % tasks), e as i64, txt]).unwrap();
    }
    c.execute_batch("COMMIT;").unwrap();
    db
}

fn time_it(db: &PathBuf, runs: usize) -> (u128, usize) {
    let mut best = u128::MAX;
    let mut size = 0;
    for _ in 0..runs {
        let t0 = std::time::Instant::now();
        let s = snapshot_at(Some(db.clone())).unwrap();
        let js = serde_json::to_string(&s).unwrap(); // o IPC serializa — entra na conta
        best = best.min(t0.elapsed().as_millis());
        size = js.len();
    }
    (best, size)
}

#[test]
fn snapshot_grande_fica_rapido() {
    let db = big_db("grande", 400, 60_000);
    let (ms, bytes) = time_it(&db, 3);
    eprintln!("[snapshot] 400 tarefas / 60k eventos: {ms}ms, {} KB de JSON", bytes / 1024);
    assert!(ms < 1500, "snapshot levou {ms}ms");
    // eventos no snapshot têm teto (os 1200 últimos, texto cortado em 500)
    let s = snapshot_at(Some(db.clone())).unwrap();
    assert_eq!(s.events.len(), 1200);
    assert!(s.events.iter().all(|e| e.text.chars().count() <= 500));
    // fila do motor por tarefa chega no snapshot (t0, t5, t10… têm 1 pedido)
    assert_eq!(s.tasks.iter().find(|t| t.id == "t5").unwrap().queued, 1);
    assert_eq!(s.tasks.iter().find(|t| t.id == "t1").unwrap().queued, 0);
    let _ = std::fs::remove_dir_all(db.parent().unwrap().parent().unwrap());
}

/// Banco TRAVADO (outra conexão com trava exclusiva): antes o snapshot esperava o busy_timeout
/// inteiro (8s = o prazo do front → "snapshot demorou >8s"). Agora desiste em ~2,5s e devolve o
/// último estado bom; sem estado anterior, erra rápido (o front tenta de novo no próximo tick).
#[test]
fn snapshot_com_banco_travado_nao_prende_a_tela() {
    let db = big_db("travado", 20, 500);
    let first = snapshot_or_cached(Some(db.clone())).expect("primeiro snapshot");
    let hold = Connection::open(&db).unwrap();
    hold.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO event (task_id,agent,ts,type,text,ok) VALUES ('t1','x',1,'note','trava',1);").unwrap();
    let t0 = std::time::Instant::now();
    let s = snapshot_or_cached(Some(db.clone())).expect("com cache devolve o último estado bom");
    let ms = t0.elapsed().as_millis();
    eprintln!("[snapshot] banco travado: respondeu em {ms}ms (cache)");
    assert!(ms < 4000, "snapshot preso {ms}ms com o banco travado");
    assert_eq!(s.tasks.len(), first.tasks.len());
    // outro banco, sem cache: erro rápido, não 8s
    let other = big_db("travado2", 3, 10);
    let _ = snapshot_or_cached(Some(other.clone())).unwrap();
    snap_cache().lock().unwrap().clear();
    let hold2 = Connection::open(&other).unwrap();
    hold2.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO event (task_id,agent,ts,type,text,ok) VALUES ('t1','x',1,'note','trava',1);").unwrap();
    let t1 = std::time::Instant::now();
    assert!(snapshot_or_cached(Some(other.clone())).is_err());
    assert!(t1.elapsed().as_millis() < 4000);
    drop(hold);
    drop(hold2);
    let _ = std::fs::remove_dir_all(db.parent().unwrap().parent().unwrap());
    let _ = std::fs::remove_dir_all(other.parent().unwrap().parent().unwrap());
}

/// "■ parar e enviar": o stop só volta quando o turno MORREU — senão o talk seguinte via o busy_pid
/// ainda vivo e a mensagem ia pra fila de um processo que morria sem drenar.
#[cfg(unix)]
#[test]
fn stop_espera_o_turno_morrer() {
    fn spawn(script: &str) -> i32 {
        let mut c = Command::new("sh");
        c.args(["-c", script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        detach_new_group(&mut c);
        let mut child = c.spawn().unwrap();
        let pid = child.id() as i32;
        std::thread::spawn(move || { let _ = child.wait(); }); // como o spawn_tracked: reapa o filho
        std::thread::sleep(std::time::Duration::from_millis(150));
        pid
    }
    // obedece o TERM
    let p = spawn("sleep 30");
    let t0 = std::time::Instant::now();
    assert!(stop_and_wait(p, 1000));
    assert!(t0.elapsed().as_millis() < 900, "TERM deveria bastar");
    // ignora o TERM → KILL depois da carência, ainda assim volta morto e dentro do prazo
    let p = spawn("trap '' TERM; while true; do sleep 1; done");
    let t0 = std::time::Instant::now();
    assert!(stop_and_wait(p, 400));
    let ms = t0.elapsed().as_millis();
    assert!((400..2000).contains(&ms), "{ms}ms");
    assert!(!pid_alive(p));
}

#[test]
fn snapshot_banco_real() {
    let Ok(p) = std::env::var("SNAP_BENCH_DB") else { return };
    let db = PathBuf::from(p);
    let (ms, bytes) = time_it(&db, 3);
    eprintln!("[snapshot] {}: {ms}ms, {} KB de JSON", db.display(), bytes / 1024);
    if let Ok(out) = std::env::var("SNAP_DUMP") {
        std::fs::write(out, serde_json::to_string(&snapshot_at(Some(db)).unwrap()).unwrap()).unwrap();
    }
}

/// ASSUMIR no terminal: a escada de sinais para o turno de FUNDO — o que sai no SIGINT volta rápido; o que ignora
/// SIGINT e SIGTERM ainda morre no SIGKILL (grupo inteiro: o filho que o motor subiu vai junto).
#[cfg(unix)]
#[test]
fn assumir_para_o_turno_de_fundo_em_escada() {
    fn spawn(script: &str) -> i32 {
        let mut c = Command::new("sh");
        c.args(["-c", script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        detach_new_group(&mut c);
        let mut child = c.spawn().unwrap();
        let pid = child.id() as i32;
        std::thread::spawn(move || { let _ = child.wait(); });
        std::thread::sleep(std::time::Duration::from_millis(150));
        pid
    }
    let p = spawn("sleep 30");
    let t0 = std::time::Instant::now();
    assert!(stop_ladder(p), "sai no SIGINT");
    assert!(t0.elapsed().as_millis() < 2500, "SIGINT basta: {}ms", t0.elapsed().as_millis());
    let p = spawn("trap '' INT TERM; sleep 60 & wait");
    let t0 = std::time::Instant::now();
    assert!(stop_ladder(p), "ignora INT e TERM: ainda assim morre (KILL no grupo)");
    let ms = t0.elapsed().as_millis();
    assert!((7500..11000).contains(&ms), "esperou INT 3 s + TERM 5 s antes do KILL: {ms}ms");
    assert!(!pid_alive(p));
}
