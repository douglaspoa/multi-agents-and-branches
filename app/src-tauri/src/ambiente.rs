//! "Subir ambiente" (spec-canvas-workspace, F1) — o lugar da tela branca da prévia.
//!
//! A lógica (detectar como ligar, porta da worktree, esperar responder, erro humano) mora no motor
//! (`src/env-up.ts` → `cardume env …`). Aqui só: subir o SUPERVISOR (`cardume env up`) num grupo de processo próprio,
//! repassar o progresso dele (1 JSON por linha) como EVENTO `env-progress` pra tela — nada de polling —, e garantir que
//! nenhum processo sobra: parar = derruba o grupo do supervisor E o do site (o pid do site chega no progresso), sair do
//! app = mata todos, e no boot uma varredura mata o que ficou de uma instância que caiu (pids registrados com a hora
//! de início — um pid reaproveitado pelo sistema não é morto por engano).
//! Todos os comandos são ASSÍNCRONOS (nenhum trava a janela).

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use super::{checks_path_env, cli_path, detach_new_group, home_dir_s, node_cmd, output_timeout, pid_alive, procsig, repo_of, signal_group, task_worktree, web_log, AppState};

/// O que a tela precisa saber do ambiente de uma demanda (atualizado pelos eventos do supervisor). Puro (testado).
#[derive(Default, Clone, Debug, PartialEq)]
pub struct EnvView {
    pub running: bool,
    pub steps: Vec<String>,
    pub ready: bool,
    pub url: Option<String>,
    pub fail: Option<Value>,
    pub exited: bool,
    pub site_pid: Option<i32>,
    pub label: Option<String>,
}
impl EnvView {
    pub fn to_json(&self) -> Value {
        json!({ "running": self.running, "steps": self.steps, "ready": self.ready, "url": self.url, "fail": self.fail, "exited": self.exited, "label": self.label })
    }
}

/// Uma linha do supervisor → evento (só objetos JSON com "ev"; aviso do node e afins são ignorados).
pub fn parse_line(line: &str) -> Option<Value> {
    let l = line.trim();
    if !l.starts_with('{') { return None; }
    let v: Value = serde_json::from_str(l).ok()?;
    v.get("ev").and_then(|e| e.as_str())?;
    Some(v)
}

/// Aplica um evento no estado (puro).
pub fn apply_event(view: &mut EnvView, v: &Value) {
    match v.get("ev").and_then(|e| e.as_str()).unwrap_or("") {
        "step" => {
            if let Some(s) = v.get("step").and_then(|s| s.as_str()) {
                if !view.steps.iter().any(|x| x == s) { view.steps.push(s.to_string()); }
            }
            if let Some(l) = v.get("label").and_then(|s| s.as_str()) { view.label = Some(l.chars().take(200).collect()); }
            if let Some(u) = v.get("url").and_then(|s| s.as_str()) { view.url = Some(u.to_string()); }
        }
        "child" => { view.site_pid = v.get("pid").and_then(|p| p.as_i64()).map(|p| p as i32).filter(|p| *p > 1); }
        "ready" => { view.ready = true; view.url = v.get("url").and_then(|s| s.as_str()).map(String::from).or(view.url.take()); view.fail = None; }
        "fail" => { view.fail = Some(v.clone()); view.ready = false; }
        "exit" => { view.ready = false; view.exited = true; view.fail = Some(v.clone()); }
        _ => {}
    }
}

struct EnvProc {
    child: Child,
    pid: i32,
    view: EnvView,
}
static ENVS: OnceLock<Mutex<HashMap<String, EnvProc>>> = OnceLock::new();
fn envs() -> &'static Mutex<HashMap<String, EnvProc>> { ENVS.get_or_init(|| Mutex::new(HashMap::new())) }

// ---------- registro de pids (varredura no boot) ----------
fn reg_path() -> PathBuf { PathBuf::from(home_dir_s()).join(".constellation").join("env-pids.json") }
/// Hora de início do processo (como o `ps` mostra) — junto do pid, identifica o processo de verdade.
fn proc_start(pid: i32) -> Option<String> {
    if cfg!(windows) { return None; }
    let o = Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}
pub fn reg_load(p: &Path) -> Vec<Value> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok()).unwrap_or_default()
}
pub fn reg_save(p: &Path, list: &[Value]) {
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    let _ = std::fs::write(p, serde_json::to_string(list).unwrap_or_else(|_| "[]".into()));
}
static REG_LOCK: Mutex<()> = Mutex::new(());
fn reg_add(task: &str, pid: i32) {
    let _g = REG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = reg_path();
    let mut l = reg_load(&p);
    l.push(json!({ "task": task, "pid": pid, "start": proc_start(pid) }));
    reg_save(&p, &l);
}
fn reg_drop_task(task: &str) {
    let _g = REG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = reg_path();
    let l: Vec<Value> = reg_load(&p).into_iter().filter(|v| v.get("task").and_then(|t| t.as_str()) != Some(task)).collect();
    reg_save(&p, &l);
}
/// O que matar na varredura: pid vivo E com a MESMA hora de início registrada (pid reaproveitado não). Puro sobre
/// as funções passadas (testado).
pub fn sweep_targets(list: &[Value], alive: &dyn Fn(i32) -> bool, start_of: &dyn Fn(i32) -> Option<String>) -> Vec<i32> {
    list.iter().filter_map(|v| {
        let pid = v.get("pid").and_then(|p| p.as_i64())? as i32;
        if pid <= 1 || !alive(pid) { return None; }
        let want = v.get("start").and_then(|s| s.as_str())?;
        (start_of(pid).as_deref() == Some(want)).then_some(pid)
    }).collect()
}
/// Boot do app: mata o que uma instância anterior (que caiu) deixou rodando.
pub fn sweep_boot() {
    if cfg!(windows) { return; }
    let p = reg_path();
    let list = { let _g = REG_LOCK.lock().unwrap_or_else(|e| e.into_inner()); reg_load(&p) };
    if list.is_empty() { return; }
    let pids = sweep_targets(&list, &pid_alive, &proc_start);
    for pid in &pids { signal_group(*pid, procsig::KILL); }
    if !pids.is_empty() { web_log(format!("[ambiente] varredura do boot: {} processo(s) órfão(s) derrubado(s)", pids.len())); }
    let _g = REG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    reg_save(&p, &[]);
}

/// Derruba supervisor + site (TERM, e KILL se não saírem). Bloqueia até ~1,5 s — chamado fora da thread da tela.
fn kill_proc(mut e: EnvProc) {
    drop(e.child.stdin.take()); // stdin fechado → o supervisor derruba o site sozinho
    let site = e.view.site_pid;
    if let Some(s) = site { signal_group(s, procsig::TERM); }
    signal_group(e.pid, procsig::TERM);
    for _ in 0..15 {
        if matches!(e.child.try_wait(), Ok(Some(_))) && site.map_or(true, |s| !pid_alive(s)) { break; }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(s) = site { if pid_alive(s) { signal_group(s, procsig::KILL); } }
    if matches!(e.child.try_wait(), Ok(None)) { signal_group(e.pid, procsig::KILL); }
    let _ = e.child.wait();
}

/// Sai do app: ninguém fica pra trás.
pub fn kill_all() {
    let all: Vec<(String, EnvProc)> = envs().lock().unwrap_or_else(|e| e.into_inner()).drain().collect();
    for (t, e) in all { kill_proc(e); reg_drop_task(&t); }
}

fn wt_of(state: &State<AppState>, task_id: &str) -> Result<PathBuf, String> { task_worktree(state, task_id) }
fn cli_for(state: &State<AppState>, wt: &Path) -> String { cli_path(&repo_of(state).unwrap_or_else(|_| wt.to_path_buf())) }

/// Como ligar o projeto desta demanda (o painel decide: "Subir ambiente", "Ver a página funcionando" ou nada).
#[tauri::command(async)]
pub fn env_detect(state: State<AppState>, task_id: String) -> Result<Value, String> {
    let wt = wt_of(&state, &task_id)?;
    let mut c = node_cmd();
    c.arg("--disable-warning=ExperimentalWarning").arg(cli_for(&state, &wt)).args(["env", "detect", "--wt", &wt.display().to_string()]).current_dir(&wt);
    let o = output_timeout(c, 20)?;
    let out = String::from_utf8_lossy(&o.stdout);
    out.lines().rev().find_map(|l| { let l = l.trim(); if l.starts_with('{') { serde_json::from_str::<Value>(l).ok() } else { None } })
        .ok_or_else(|| "não consegui ver como ligar este projeto".to_string())
}

/// Sobe o ambiente (ou devolve o que já está subindo/no ar). O progresso chega pelo evento `env-progress`.
#[tauri::command(async)]
pub fn env_up(app: AppHandle, state: State<AppState>, task_id: String) -> Result<Value, String> {
    {
        let mut m = envs().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cur) = m.get_mut(&task_id) {
            if matches!(cur.child.try_wait(), Ok(None)) { return Ok(cur.view.to_json()); }
            m.remove(&task_id); // terminou: sobe de novo
        }
    }
    let wt = wt_of(&state, &task_id)?;
    let mut c = node_cmd();
    c.arg("--disable-warning=ExperimentalWarning").arg(cli_for(&state, &wt))
        .args(["env", "up", "--wt", &wt.display().to_string(), "--task", &task_id])
        .current_dir(&wt).env("PATH", checks_path_env()).env_remove("CARDUME_ROLE")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    detach_new_group(&mut c);
    let mut child = c.spawn().map_err(|e| format!("não consegui ligar o ambiente: {e}"))?;
    let pid = child.id() as i32;
    let stdout = child.stdout.take().ok_or("sem saída do ambiente")?;
    reg_add(&task_id, pid);
    let view = EnvView { running: true, ..Default::default() };
    envs().lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.clone(), EnvProc { child, pid, view: view.clone() });
    web_log(format!("[ambiente] {task_id}: subindo (supervisor {pid})"));
    let tid = task_id.clone();
    std::thread::spawn(move || {
        let rd = BufReader::new(stdout);
        for line in rd.lines() {
            let Ok(line) = line else { break };
            let Some(v) = parse_line(&line) else { continue };
            let mut site_new = None;
            {
                let mut m = envs().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(e) = m.get_mut(&tid) {
                    if e.pid != pid { break; } // outra subida tomou o lugar
                    let before = e.view.site_pid;
                    apply_event(&mut e.view, &v);
                    if e.view.site_pid != before { site_new = e.view.site_pid; }
                }
            }
            if let Some(s) = site_new { reg_add(&tid, s); }
            let mut payload = v.clone();
            if let Some(o) = payload.as_object_mut() { o.insert("taskId".into(), json!(tid)); }
            let _ = app.emit("env-progress", payload);
        }
        // supervisor saiu (parado, caiu, falhou): marca e avisa — o painel volta pro botão
        // (a trava sai ANTES do wait: esperar processo segurando o mapa travaria os outros comandos)
        let taken = {
            let mut m = envs().lock().unwrap_or_else(|e| e.into_inner());
            if m.get(&tid).map(|e| e.pid == pid).unwrap_or(false) { m.remove(&tid) } else { None }
        };
        if let Some(mut e) = taken {
            let _ = e.child.wait();
            if let Some(s) = e.view.site_pid { if pid_alive(s) { signal_group(s, procsig::KILL); } }
            reg_drop_task(&tid);
            let _ = app.emit("env-progress", json!({ "taskId": tid, "ev": "end" }));
        }
    });
    Ok(view.to_json())
}

/// Para o ambiente da demanda (botão "parar", demanda terminou, aba fechada). true = havia um.
#[tauri::command(async)]
pub fn env_down(task_id: String) -> Result<bool, String> {
    let e = envs().lock().unwrap_or_else(|e| e.into_inner()).remove(&task_id);
    match e {
        Some(e) => { kill_proc(e); reg_drop_task(&task_id); web_log(format!("[ambiente] {task_id}: parado")); Ok(true) }
        None => Ok(false),
    }
}

/// Estado atual (pra remontar o painel) + o fim do log técnico SÓ quando pedido ("ver detalhes").
#[tauri::command(async)]
pub fn env_status(state: State<AppState>, task_id: String, log: Option<bool>) -> Result<Value, String> {
    let mut v = {
        let mut m = envs().lock().unwrap_or_else(|e| e.into_inner());
        match m.get_mut(&task_id) {
            Some(e) => { let live = matches!(e.child.try_wait(), Ok(None)); let mut j = e.view.to_json(); j["running"] = json!(live); j }
            None => EnvView::default().to_json(),
        }
    };
    if log.unwrap_or(false) {
        if let Ok(wt) = wt_of(&state, &task_id) { v["log"] = json!(log_tail(&wt.join(".cardume").join("logs").join("env.log"), 120)); }
    }
    Ok(v)
}

/// Últimas `n` linhas do log (linhas cortadas em 400 caracteres).
pub fn log_tail(p: &Path, n: usize) -> String {
    let raw = std::fs::read(p).unwrap_or_default();
    let s = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(n)..].iter().map(|l| l.chars().take(400).collect::<String>()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linhas_do_supervisor() {
        assert!(parse_line("(node:1) ExperimentalWarning: x").is_none());
        assert!(parse_line("{\"sem\":\"ev\"}").is_none());
        assert!(parse_line("{quebrado").is_none());
        assert_eq!(parse_line(" {\"ev\":\"ready\",\"url\":\"http://127.0.0.1:4100/\"} ").unwrap()["ev"], "ready");
    }

    #[test]
    fn estado_segue_os_eventos() {
        let mut v = EnvView { running: true, ..Default::default() };
        for l in [
            r#"{"ev":"step","step":"detect","label":"npm run dev"}"#,
            r#"{"ev":"step","step":"install"}"#,
            r#"{"ev":"step","step":"start","port":4100}"#,
            r#"{"ev":"child","pid":4321}"#,
            r#"{"ev":"step","step":"wait","url":"http://127.0.0.1:4100/"}"#,
            r#"{"ev":"step","step":"wait","url":"http://127.0.0.1:4100/"}"#,
        ] { apply_event(&mut v, &parse_line(l).unwrap()); }
        assert_eq!(v.steps, vec!["detect", "install", "start", "wait"], "passo repetido não duplica");
        assert_eq!(v.site_pid, Some(4321));
        assert!(!v.ready);
        apply_event(&mut v, &parse_line(r#"{"ev":"ready","url":"http://127.0.0.1:4111/"}"#).unwrap());
        assert!(v.ready); assert_eq!(v.url.as_deref(), Some("http://127.0.0.1:4111/"));
        apply_event(&mut v, &parse_line(r#"{"ev":"exit","code":1,"msg":"O site parou."}"#).unwrap());
        assert!(!v.ready && v.exited);
        assert_eq!(v.fail.as_ref().unwrap()["msg"], "O site parou.");
        let mut f = EnvView::default();
        apply_event(&mut f, &parse_line(r#"{"ev":"child","pid":1}"#).unwrap());
        assert_eq!(f.site_pid, None, "pid 1 nunca é alvo");
        assert_eq!(f.to_json()["running"], false);
    }

    #[test]
    fn varredura_so_mata_o_mesmo_processo() {
        let list = vec![
            json!({ "task": "a", "pid": 100, "start": "Thu Oct  2 10:00:00 2026" }),
            json!({ "task": "a", "pid": 101, "start": "Thu Oct  2 10:00:01 2026" }), // pid reaproveitado (hora diferente)
            json!({ "task": "b", "pid": 102, "start": "Thu Oct  2 10:00:02 2026" }), // já morreu
            json!({ "task": "c", "pid": 103 }),                                       // sem hora: não arrisca
            json!({ "task": "d", "pid": 1, "start": "x" }),
        ];
        let alive = |p: i32| p != 102;
        let start = |p: i32| match p { 100 => Some("Thu Oct  2 10:00:00 2026".to_string()), 101 => Some("Fri Oct  3 09:00:00 2026".to_string()), 103 => Some("y".into()), 1 => Some("x".into()), _ => None };
        assert_eq!(sweep_targets(&list, &alive, &start), vec![100]);
    }

    #[test]
    fn registro_e_fim_do_log() {
        let d = std::env::temp_dir().join(format!("sf-amb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("sub").join("env-pids.json");
        assert!(reg_load(&p).is_empty(), "sem arquivo = lista vazia");
        reg_save(&p, &[json!({ "task": "t", "pid": 5 })]);
        assert_eq!(reg_load(&p).len(), 1);
        std::fs::write(&p, "lixo").unwrap();
        assert!(reg_load(&p).is_empty(), "arquivo estragado não derruba o boot");
        let lg = d.join("env.log");
        std::fs::write(&lg, (1..=200).map(|i| format!("linha {i}")).collect::<Vec<_>>().join("\n")).unwrap();
        let t = log_tail(&lg, 3);
        assert_eq!(t, "linha 198\nlinha 199\nlinha 200");
        assert_eq!(log_tail(&d.join("nao-existe.log"), 5), "");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Ciclo de vida REAL do grupo de processos (sem o app): um "supervisor" falso em grupo próprio com um filho —
    /// kill_proc derruba os dois (nenhum órfão).
    #[cfg(unix)]
    #[test]
    fn parar_derruba_o_grupo_inteiro() {
        let mut c = Command::new("sh");
        c.args(["-c", r#"sleep 30 & printf '{"ev":"child","pid":%s}\n' $!; wait"#]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        detach_new_group(&mut c);
        let mut child = c.spawn().unwrap();
        let pid = child.id() as i32;
        let mut rd = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        rd.read_line(&mut line).unwrap();
        let mut view = EnvView { running: true, ..Default::default() };
        apply_event(&mut view, &parse_line(&line).unwrap());
        let site = view.site_pid.expect("pid do filho");
        assert!(pid_alive(site));
        kill_proc(EnvProc { child, pid, view });
        std::thread::sleep(Duration::from_millis(200));
        assert!(!pid_alive(site), "o filho (site) morreu junto");
        assert!(!pid_alive(pid), "o supervisor morreu");
    }
}

/// Autoteste do CANVAS no app de verdade (SÓ em build de depuração; nunca no app instalado):
/// `STARFORK_CANVAS_SELFTEST="<roteiro.js>|<saida-prefixo>|<segundos,…>"` → roda o roteiro na janela (abre o projeto,
/// arruma as colunas, sobe o ambiente) e tira prints NATIVOS da janela inteira nos instantes pedidos
/// (`<prefixo>-<s>s.png`). Usado pra medir CPU ociosa com 3 colunas e provar o iframe externo no WKWebView.
#[cfg(debug_assertions)]
pub fn selftest_from_env(app: &AppHandle) {
    let Ok(spec) = std::env::var("STARFORK_CANVAS_SELFTEST") else { return };
    let mut it = spec.split('|');
    let script = it.next().unwrap_or("").to_string();
    let out = it.next().map(String::from).filter(|s| !s.is_empty());
    let marks: Vec<u64> = it.next().unwrap_or("40").split(',').filter_map(|s| s.trim().parse().ok()).collect();
    let Ok(js) = std::fs::read_to_string(&script) else { eprintln!("[canvas selftest] roteiro não encontrado: {script}"); return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        tokio::time::sleep(Duration::from_secs(6)).await;
        // janela num lugar conhecido (o print de tela inteira — com os Navegadores, que são webviews à parte — usa isso)
        if let Some(win) = app.get_webview("main").map(|wv| wv.window()) { let _ = win.set_position(tauri::LogicalPosition::new(0.0, 30.0)); let _ = win.set_size(tauri::LogicalSize::new(1440.0, 860.0)); let _ = win.set_focus(); }
        if let Some(w) = app.get_webview("main") { let _ = w.eval(&js); }
        // STARFORK_CANVAS_PLAY=<s> / STARFORK_CANVAS_PAUSE=<s>: depois de <s> segundos dá play (mudo) / pausa os vídeos
        // dos Navegadores abertos (medição de CPU com o YouTube parado; print com ele tocando)
        for (var, js) in [("STARFORK_CANVAS_PLAY", "try{const v=document.querySelector('video'); if(v){ v.muted=true; v.play(); }}catch(_){}"), ("STARFORK_CANVAS_PAUSE", "try{document.querySelectorAll('video').forEach(v=>v.pause())}catch(_){}")] {
            if let Some(secs) = std::env::var(var).ok().and_then(|v| v.parse::<u64>().ok()) {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                    for (label, wv) in app2.webviews() { if label.starts_with(super::navexterno::LABEL_PREFIX) { let _ = wv.eval(js); } }
                    eprintln!("[canvas selftest] {var} nos navegadores");
                });
            }
        }
        let Some(out) = out else { return };
        let mut waited = 0u64;
        for m in marks {
            if m > waited { tokio::time::sleep(Duration::from_secs(m - waited)).await; waited = m; }
            let Some(w) = app.get_webview("main").map(|wv| wv.window()) else { return };
            let (Ok(sz), Ok(k)) = (w.inner_size(), w.scale_factor()) else { continue };
            let r = super::navegador::SnapRect { x: 0.0, y: 0.0, w: sz.width as f64 / k, h: sz.height as f64 / k };
            match super::navegador::snapshot(&app, r).await {
                Ok(png) => { let p = format!("{out}-{m}s.png"); let _ = std::fs::write(&p, &png); eprintln!("[canvas selftest] print {p}"); }
                Err(e) => eprintln!("[canvas selftest] print falhou: {e}"),
            }
        }
    });
}
#[cfg(not(debug_assertions))]
pub fn selftest_from_env(_app: &AppHandle) {}
