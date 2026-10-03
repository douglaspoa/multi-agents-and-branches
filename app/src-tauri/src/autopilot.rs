//! PILOTO AUTOMÁTICO (spec-piloto-automatico) — o núcleo é o motor TS (`cardume autopilot`, src/autopilot.ts).
//! O app só: escolhe a pasta nova (~/Documents/Starfork/<nome>), dispara o CLI DESANEXADO (grupo próprio, log em
//! <pasta>/.cardume/logs/autopilot.log), lê o progresso de <pasta>/.cardume/autopilot/state.json, pede pra parar
//! (arquivo STOP, respeitado entre passos) e retoma (roda o CLI de novo na mesma pasta). Nada de remoto/push/PR.
//! Um piloto por pasta: o CLI pega a trava `.cardume/autopilot/lock` ({pid, at}, O_EXCL); entre o spawn e a trava o
//! app deixa o marcador `.cardume/autopilot/starting` — enquanto um dos dois vale, iniciar/continuar é recusado.
use super::{detach_new_group, engine_cli_path, cli_path, node_cmd, now_ms, pid_alive, project_slug, repo_of, setting_get, starfork_projects_dir, unique_child, AppState};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

pub(crate) const PLATFORMS: [&str; 4] = ["web", "ios", "android", "mobile"];
/// Limites — os MESMOS nas três camadas: aqui, src/autopilot.ts (AP_MAX_PARALLEL/AP_MAX_ATTEMPTS) e
/// app/src/js/56-piloto.js (PILOTO_MAX_PAR/PILOTO_MAX_ATT).
pub(crate) const AP_MAX_PARALLEL: u32 = 4;
pub(crate) const AP_MAX_ATTEMPTS: u32 = 5;
/// Fases em que o piloto terminou (≡ AP_END_PHASES do TS).
const END_PHASES: [&str; 4] = ["done", "stopped", "budget", "failed"];
/// Marcador "starting" vale no máximo isto (o CLI apaga ao pegar a trava; o colhedor apaga quando o filho sai).
const STARTING_TTL_MS: i64 = 60_000;
/// Bytes lidos do fim do log (o log cresce sem limite numa rodada longa).
const LOG_TAIL_BYTES: u64 = 16 * 1024;

/// Argumentos do `cardume autopilot` (sem o node). PURA — testada abaixo. `idea` vazia = retomada.
#[allow(clippy::too_many_arguments)]
pub(crate) fn autopilot_cli_args(cli: &str, dir: &Path, idea: &str, platform: &str, name: &str, engine: &str, model: &str, parallel: Option<u32>, attempts: Option<u32>, budget_usd: Option<f64>, plan: Option<&Path>) -> Vec<String> {
    let mut a: Vec<String> = vec!["--disable-warning=ExperimentalWarning".into(), cli.into(), "autopilot".into(), "--dir".into(), dir.display().to_string()];
    let mut opt = |k: &str, v: &str| { if !v.trim().is_empty() { a.push(k.into()); a.push(v.trim().into()); } };
    opt("--idea", idea);
    if PLATFORMS.contains(&platform) { opt("--platform", platform); }
    opt("--name", name);
    opt("--engine", engine);
    opt("--model", model);
    if let Some(p) = parallel.filter(|p| *p > 0) { opt("--parallel", &p.min(AP_MAX_PARALLEL).to_string()); }
    if let Some(n) = attempts.filter(|n| *n > 0) { opt("--attempts", &n.min(AP_MAX_ATTEMPTS).to_string()); }
    if let Some(b) = budget_usd.filter(|b| b.is_finite() && *b >= 0.0) { opt("--budget-usd", &format!("{b}")); }
    if let Some(p) = plan { opt("--plan", &p.display().to_string()); }
    a
}
/// Plano pronto (a aba Ideia manda o épico decidido com a mesa): gravado em `.cardume/autopilot/plan-ideia.json`
/// (fora do que o git vê — o `.cardume/` é ignorado e o piloto aceita a pasta só com ele).
pub(crate) fn plan_path(dir: &Path) -> PathBuf { ap_dir(dir).join("plan-ideia.json") }

fn ap_dir(dir: &Path) -> PathBuf { dir.join(".cardume").join("autopilot") }
pub(crate) fn state_path(dir: &Path) -> PathBuf { ap_dir(dir).join("state.json") }
fn lock_path(dir: &Path) -> PathBuf { ap_dir(dir).join("lock") }
fn starting_path(dir: &Path) -> PathBuf { ap_dir(dir).join("starting") }
fn log_path(dir: &Path) -> PathBuf { dir.join(".cardume").join("logs").join("autopilot.log") }

/// Últimas `n` linhas do log do piloto (o que o CLI imprimiu) — lê só os últimos ~16 KB.
pub(crate) fn log_tail(dir: &Path, n: usize) -> String {
    let Ok(mut f) = std::fs::File::open(log_path(dir)) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(LOG_TAIL_BYTES);
    if f.seek(SeekFrom::Start(from)).is_err() { return String::new(); }
    let mut buf = Vec::new();
    let _ = f.take(LOG_TAIL_BYTES).read_to_end(&mut buf);
    let t = String::from_utf8_lossy(&buf);
    // começou no meio do arquivo: a 1ª linha está cortada — fora
    let t: &str = if from > 0 { t.split_once('\n').map(|x| x.1).unwrap_or("") } else { &t };
    let lines: Vec<&str> = t.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Início do processo em ms (epoch) via `ps -o etime=` ([[dd-]hh:]mm:ss) — None quando não dá pra saber.
#[cfg(unix)]
fn process_start_ms(pid: i32) -> Option<i64> {
    let out = std::process::Command::new("ps").args(["-o", "etime=", "-p", &pid.to_string()]).env("LC_ALL", "C").output().ok()?;
    let secs = parse_etime(String::from_utf8_lossy(&out.stdout).trim())?;
    Some(now_ms() - secs * 1000)
}
#[cfg(not(unix))]
fn process_start_ms(_pid: i32) -> Option<i64> { None }

/// "[[dd-]hh:]mm:ss" → segundos. PURA.
pub(crate) fn parse_etime(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() { return None; }
    let (days, rest) = match s.split_once('-') { Some((d, r)) => (d.parse::<i64>().ok()?, r), None => (0, s) };
    let parts: Vec<i64> = rest.split(':').map(|x| x.parse::<i64>().ok()).collect::<Option<Vec<_>>>()?;
    let (h, m, sec) = match parts.as_slice() { [m, s] => (0, *m, *s), [h, m, s] => (*h, *m, *s), _ => return None };
    Some(days * 86_400 + h * 3600 + m * 60 + sec)
}

/// Vivo E é o MESMO processo: um pid que nasceu depois de `since` (+ folga de 2 s) é pid reciclado (≡ pidAlive do TS).
pub(crate) fn pid_alive_since(pid: i32, since: i64) -> bool {
    if pid <= 0 || !pid_alive(pid) { return false; }
    if since > 0 {
        if let Some(started) = process_start_ms(pid) { if started > since + 2000 { return false; } }
    }
    true
}

/// Trava do CLI valendo? `{pid, at}` com o dono vivo e nascido antes da trava; vazia e recém-criada também vale.
fn lock_held(dir: &Path) -> Option<i32> {
    let p = lock_path(dir);
    let raw = std::fs::read_to_string(&p).ok()?;
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => {
            let pid = v.get("pid").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            let at = v.get("at").and_then(|x| x.as_i64()).unwrap_or(0);
            if pid_alive_since(pid, at) { Some(pid) } else { None }
        }
        Err(_) => {
            let fresh = std::fs::metadata(&p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map(|e| e.as_millis() < 5000).unwrap_or(false);
            if fresh { Some(0) } else { None }
        }
    }
}
/// Marcador "starting" do app (ms no conteúdo) ainda vale?
fn starting_fresh(dir: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(starting_path(dir)) else { return false };
    let at = raw.trim().parse::<i64>().unwrap_or(0);
    at > 0 && now_ms() - at < STARTING_TTL_MS
}
/// Algum piloto rodando (ou começando) nesta pasta? Some(mensagem humana) = recusa iniciar/continuar.
pub(crate) fn busy(dir: &Path) -> Option<String> {
    if let Some(pid) = lock_held(dir) {
        return Some(if pid > 0 { format!("o piloto já está rodando nesta pasta (processo {pid})") } else { "o piloto já está rodando nesta pasta".into() });
    }
    if starting_fresh(dir) { return Some("o piloto já está começando nesta pasta — espere alguns segundos".into()); }
    None
}

/// Estado do piloto + se o processo está vivo + fim do log. PURA no disco (sem State) — testada abaixo.
pub(crate) fn read_status(dir: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(state_path(dir)).map_err(|_| "nenhum piloto automático nesta pasta".to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("estado do piloto ilegível: {e}"))?;
    let pid = v.get("pid").and_then(|p| p.as_i64()).unwrap_or(0) as i32;
    // o pid é DESTA rodada: nascido depois do início dela = reciclado (não fica "rodando" pra sempre)
    let since = v.get("runStartedAt").or_else(|| v.get("startedAt")).and_then(|x| x.as_i64()).unwrap_or(0);
    let alive = pid > 0 && pid_alive_since(pid, since);
    if let Some(o) = v.as_object_mut() {
        o.insert("alive".into(), serde_json::Value::Bool(alive));
        o.insert("starting".into(), serde_json::Value::Bool(starting_fresh(dir)));
        o.insert("stopRequested".into(), serde_json::Value::Bool(ap_dir(dir).join("STOP").is_file()));
        o.insert("hasReport".into(), serde_json::Value::Bool(dir.join("AUTOPILOT.md").is_file()));
        o.insert("logTail".into(), serde_json::Value::String(log_tail(dir, 12)));
    }
    Ok(v)
}

/// Marca "começando" (o CLI apaga ao pegar a trava).
fn mark_starting(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(ap_dir(dir)).map_err(|e| format!("não consegui criar a pasta do projeto: {e}"))?;
    std::fs::write(starting_path(dir), now_ms().to_string()).map_err(|e| e.to_string())
}

/// Dispara o CLI desanexado (grupo próprio, sem stdin), com a saída no log da pasta. Uma thread colhe o filho,
/// apaga o marcador "starting" e liga o `exited` devolvido (o wait_state usa pra saber que o CLI já morreu).
fn spawn_cli(dir: &Path, args: Vec<String>) -> Result<Arc<AtomicBool>, String> {
    std::fs::create_dir_all(dir.join(".cardume").join("logs")).map_err(|e| format!("não consegui criar a pasta do projeto: {e}"))?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(log_path(dir)).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = node_cmd();
    cmd.args(&args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err));
    // o app mostra o progresso na aba; notificação por osascript sairia como "Editor de Script"
    cmd.env("CARDUME_NOTIFY", "0");
    cmd.env("CARDUME_PROTECT", "1");
    if let Some(m) = setting_get("limitRetryMin") { cmd.env("CARDUME_LIMIT_RETRY_MIN", m); }
    detach_new_group(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => { let _ = std::fs::remove_file(starting_path(dir)); return Err(format!("falha ao iniciar o piloto: {e}")); }
    };
    let exited = Arc::new(AtomicBool::new(false));
    let (flag, marker) = (exited.clone(), starting_path(dir));
    std::thread::spawn(move || { let _ = child.wait(); let _ = std::fs::remove_file(&marker); flag.store(true, Ordering::SeqCst); });
    Ok(exited)
}

/// Espera o piloto ficar PRONTO pra abrir: state.json + o banco do projeto (.cardume/state.sqlite).
/// - o CLI morreu antes disso → Err com o fim do log (ou o motivo gravado no estado "failed");
/// - estourou o tempo com o CLI vivo → Ok(Some(aviso)): a aba de progresso abre e segue lendo (não convida a
///   começar um 2º piloto). PURA no disco + `exited` — testada abaixo.
pub(crate) fn wait_state(dir: &Path, timeout_ms: u64, exited: &dyn Fn() -> bool) -> Result<Option<String>, String> {
    let until = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if let Ok(raw) = std::fs::read_to_string(state_path(dir)) {
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
            let phase = v.get("phase").and_then(|p| p.as_str()).unwrap_or("");
            if phase == "failed" {
                return Err(format!("o piloto não começou: {}", v.get("stopReason").and_then(|r| r.as_str()).unwrap_or("erro inesperado")));
            }
            if dir.join(".cardume").join("state.sqlite").is_file() || END_PHASES.contains(&phase) { return Ok(None); }
        }
        if exited() {
            // pode ter gravado o estado no último instante
            if state_path(dir).is_file() && dir.join(".cardume").join("state.sqlite").is_file() { return Ok(None); }
            let tail = log_tail(dir, 12);
            return Err(format!("o piloto não começou — saída do motor:\n{}", if tail.trim().is_empty() { "(log vazio)".into() } else { tail }));
        }
        if std::time::Instant::now() >= until { break; }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Ok(Some("o piloto ainda está preparando o projeto — acompanhe na aba de progresso (não comece outro)".into()))
}

/// Recusa de "Continuar": piloto rodando/começando, ou parado no TETO com um teto que já foi gasto. PURA no disco.
pub(crate) fn resume_check(dir: &Path, budget_usd: Option<f64>) -> Result<(), String> {
    let st = read_status(dir)?;
    if st.get("alive").and_then(|a| a.as_bool()).unwrap_or(false) { return Err("o piloto já está rodando".into()); }
    if let Some(msg) = busy(dir) { return Err(msg); }
    if st.get("phase").and_then(|p| p.as_str()) == Some("budget") {
        let cap = budget_usd.filter(|b| b.is_finite() && *b >= 0.0).unwrap_or_else(|| st.get("budgetUsd").and_then(|b| b.as_f64()).unwrap_or(0.0));
        let spent = st.get("costUsd").and_then(|c| c.as_f64()).unwrap_or(0.0);
        if cap > 0.0 && cap <= spent {
            return Err(format!("o teto de US$ {cap:.2} já foi gasto (US$ {spent:.2}) — aumente o teto ou use 0 pra seguir sem teto"));
        }
    }
    Ok(())
}

fn engine_cli(state: &State<AppState>) -> Result<String, String> {
    engine_cli_path()
        .or_else(|| repo_of(state).ok().map(|r| cli_path(&r)))
        .ok_or_else(|| "não achei o motor do Starfork (engine/cli.mjs) — reinstale o app".to_string())
}

/// Nome da pasta do projeto a partir do nome/ideia: nunca vazio (só símbolos → "app").
pub(crate) fn dir_slug(label: &str) -> String {
    let s: String = project_slug(label).chars().take(48).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "app".into() } else { s }
}

/// Um "Construir sozinho" por vez: duplo clique não dispara dois pilotos (cada um numa pasta nova).
static STARTING: AtomicBool = AtomicBool::new(false);
struct StartGuard;
impl Drop for StartGuard { fn drop(&mut self) { STARTING.store(false, Ordering::SeqCst); } }

/// "Construir sozinho": pasta NOVA em ~/Documents/Starfork (ou `parent`), dispara o piloto e devolve
/// `{dir, warning?}` (o front abre o projeto e a aba de progresso).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn autopilot_start(state: State<AppState>, idea: String, platform: String, name: Option<String>, parent: Option<String>, engine: Option<String>, model: Option<String>, parallel: Option<u32>, attempts: Option<u32>, budget_usd: Option<f64>, plan: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let idea = idea.trim().to_string();
    if idea.is_empty() { return Err("escreva a ideia do app".into()); }
    if !PLATFORMS.contains(&platform.as_str()) { return Err(format!("plataforma inválida: {platform}")); }
    if STARTING.swap(true, Ordering::SeqCst) { return Err("um piloto já está começando — espere ele abrir".into()); }
    let _guard = StartGuard;
    let name = name.unwrap_or_default().trim().to_string();
    let label = if name.is_empty() { idea.split_whitespace().take(5).collect::<Vec<_>>().join(" ") } else { name.clone() };
    let slug = dir_slug(&label);
    let parent = parent.filter(|p| !p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(starfork_projects_dir);
    std::fs::create_dir_all(&parent).map_err(|e| format!("não consegui criar a pasta {}: {e}", parent.display()))?;
    let dir = parent.join(unique_child(&parent, &slug));
    let cli = engine_cli(&state)?;
    let plan = plan.filter(|p| p.is_object());
    let pf = plan.as_ref().map(|_| plan_path(&dir));
    let args = autopilot_cli_args(&cli, &dir, &idea, &platform, &label, engine.as_deref().unwrap_or("claude"), model.as_deref().unwrap_or(""), parallel, attempts, budget_usd, pf.as_deref());
    mark_starting(&dir)?;
    // o projeto do piloto já entra na lista como da conta logada (o registerProject do CLI mantém o dono)
    super::register_opened_project(&dir.display().to_string());
    if let (Some(p), Some(f)) = (&plan, &pf) { std::fs::write(f, p.to_string()).map_err(|e| format!("não consegui gravar o plano do piloto: {e}"))?; }
    let exited = spawn_cli(&dir, args)?;
    let warning = wait_state(&dir, 20_000, &|| exited.load(Ordering::SeqCst))?;
    Ok(serde_json::json!({ "dir": dir.display().to_string(), "warning": warning }))
}

/// Progresso pra aba: o state.json + vivo/parado + fim do log.
#[tauri::command(async)]
pub(crate) fn autopilot_status(dir: String) -> Result<serde_json::Value, String> {
    read_status(&PathBuf::from(dir))
}

/// Parar: o piloto termina o passo atual e para (relatório "parado").
#[tauri::command(async)]
pub(crate) fn autopilot_stop(dir: String) -> Result<(), String> {
    let d = PathBuf::from(dir);
    if !state_path(&d).is_file() { return Err("nenhum piloto automático nesta pasta".into()); }
    std::fs::write(ap_dir(&d).join("STOP"), "app\n").map_err(|e| e.to_string())
}

/// Continuar (depois de parar, do teto ou de uma falha): roda o CLI de novo na MESMA pasta — ele segue do state.json.
/// Parado no teto: `budget_usd` = o teto novo (0 = sem teto).
#[tauri::command(async)]
pub(crate) fn autopilot_resume(state: State<AppState>, dir: String, budget_usd: Option<f64>) -> Result<(), String> {
    let d = PathBuf::from(&dir);
    resume_check(&d, budget_usd)?;
    let cli = engine_cli(&state)?;
    let args = autopilot_cli_args(&cli, &d, "", "", "", "", "", None, None, budget_usd, None);
    mark_starting(&d)?;
    spawn_cli(&d, args).map(|_| ())
}

/// Abre o AUTOPILOT.md no app padrão do sistema.
#[tauri::command(async)]
pub(crate) fn autopilot_open_report(dir: String) -> Result<(), String> {
    let f = PathBuf::from(dir).join("AUTOPILOT.md");
    if !f.is_file() { return Err("o relatório ainda não foi escrito".into()); }
    super::os_open(f.as_os_str()).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_do_cli_novos_e_retomada() {
        let d = PathBuf::from("/tmp/x/pou");
        let a = autopilot_cli_args("/e/cli.mjs", &d, " recriar o Pou ", "mobile", "Pou", "claude", "", Some(3), Some(2), Some(5.5), None);
        assert_eq!(a, ["--disable-warning=ExperimentalWarning", "/e/cli.mjs", "autopilot", "--dir", "/tmp/x/pou", "--idea", "recriar o Pou", "--platform", "mobile", "--name", "Pou", "--engine", "claude", "--parallel", "3", "--attempts", "2", "--budget-usd", "5.5"]);
        // retomada: só a pasta (e o teto, se mudou); plataforma inválida não vai
        let r = autopilot_cli_args("/e/cli.mjs", &d, "", "desktop", "", "", "", None, Some(0), None, None);
        assert_eq!(r, ["--disable-warning=ExperimentalWarning", "/e/cli.mjs", "autopilot", "--dir", "/tmp/x/pou"]);
        assert!(autopilot_cli_args("c", &d, "x", "web", "", "", "", Some(99), None, None, None).windows(2).any(|w| w[0] == "--parallel" && w[1] == "4"));
        assert!(autopilot_cli_args("c", &d, "x", "web", "", "", "", None, Some(99), None, None).windows(2).any(|w| w[0] == "--attempts" && w[1] == "5"));
        // plano pronto (aba Ideia): --plan aponta pro arquivo dentro de .cardume/autopilot
        let pf = plan_path(&d);
        assert_eq!(pf, PathBuf::from("/tmp/x/pou/.cardume/autopilot/plan-ideia.json"));
        let p = autopilot_cli_args("c", &d, "skincare", "mobile", "", "claude", "", None, None, None, Some(&pf));
        assert!(p.windows(2).any(|w| w[0] == "--plan" && w[1] == "/tmp/x/pou/.cardume/autopilot/plan-ideia.json"));
    }

    #[test]
    fn status_le_o_estado_e_o_log() {
        let d = std::env::temp_dir().join(format!("starfork-piloto-rs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(read_status(&d).is_err());
        std::fs::create_dir_all(d.join(".cardume/autopilot")).unwrap();
        std::fs::create_dir_all(d.join(".cardume/logs")).unwrap();
        std::fs::write(state_path(&d), r#"{"version":1,"phase":"building","pid":0,"tasks":[]}"#).unwrap();
        std::fs::write(d.join(".cardume/logs/autopilot.log"), "a\nb\nc\n").unwrap();
        let v = read_status(&d).unwrap();
        assert_eq!(v["phase"], "building");
        assert_eq!(v["alive"], false);
        assert_eq!(v["stopRequested"], false);
        assert_eq!(v["logTail"], "a\nb\nc");
        autopilot_stop(d.display().to_string()).unwrap();
        assert_eq!(read_status(&d).unwrap()["stopRequested"], true);
        let _ = std::fs::remove_dir_all(&d);
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("starfork-piloto-rs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cardume/autopilot")).unwrap();
        std::fs::create_dir_all(d.join(".cardume/logs")).unwrap();
        d
    }

    #[test]
    fn log_tail_le_so_o_fim() {
        let d = tmp("log");
        assert_eq!(log_tail(&d, 5), "");
        // ~40 KB: só os últimos 16 KB são lidos, sem a linha cortada do começo
        let big: String = (0..4000).map(|i| format!("linha {i:05} xxxxx\n")).collect();
        std::fs::write(log_path(&d), &big).unwrap();
        assert_eq!(log_tail(&d, 2), "linha 03998 xxxxx\nlinha 03999 xxxxx");
        let t = log_tail(&d, 100_000);
        assert!(t.len() as u64 <= LOG_TAIL_BYTES);
        assert!(t.lines().all(|l| l.starts_with("linha ") && l.len() == 17), "nenhuma linha pela metade");
        std::fs::write(log_path(&d), "a\nb\n").unwrap();
        assert_eq!(log_tail(&d, 12), "a\nb");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn trava_e_marcador_recusam_continuar() {
        let d = tmp("lock");
        std::fs::write(state_path(&d), r#"{"version":1,"phase":"stopped","pid":0,"tasks":[]}"#).unwrap();
        assert_eq!(busy(&d), None);
        assert!(resume_check(&d, None).is_ok());
        // trava de um processo VIVO (este) pega depois que ele nasceu → recusa
        let me = std::process::id() as i32;
        std::fs::write(lock_path(&d), format!(r#"{{"pid":{me},"at":{}}}"#, now_ms())).unwrap();
        assert!(busy(&d).unwrap().contains("já está rodando"));
        assert!(resume_check(&d, None).unwrap_err().contains("já está rodando"));
        // pid morto, ou pid reciclado (nasceu DEPOIS da trava) → trava obsoleta
        std::fs::write(lock_path(&d), r#"{"pid":4194303,"at":1}"#).unwrap();
        assert_eq!(busy(&d), None);
        if process_start_ms(me).is_some() {
            std::fs::write(lock_path(&d), format!(r#"{{"pid":{me},"at":1000}}"#)).unwrap();
            assert_eq!(busy(&d), None, "pid reciclado não segura a trava");
        }
        std::fs::remove_file(lock_path(&d)).unwrap();
        // marcador "starting" fresco (duplo clique) → recusa; velho → não
        std::fs::write(starting_path(&d), now_ms().to_string()).unwrap();
        assert!(resume_check(&d, None).unwrap_err().contains("começando"));
        std::fs::write(starting_path(&d), (now_ms() - STARTING_TTL_MS - 1).to_string()).unwrap();
        assert!(resume_check(&d, None).is_ok());
        // parado no TETO: teto já gasto é recusado; maior ou 0 (= sem teto) passa
        std::fs::write(state_path(&d), r#"{"version":1,"phase":"budget","pid":0,"budgetUsd":1,"costUsd":1.2,"tasks":[]}"#).unwrap();
        assert!(resume_check(&d, None).unwrap_err().contains("aumente o teto"));
        assert!(resume_check(&d, Some(1.1)).is_err());
        assert!(resume_check(&d, Some(2.0)).is_ok());
        assert!(resume_check(&d, Some(0.0)).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn vivo_considera_o_inicio_da_rodada() {
        let d = tmp("pid");
        let me = std::process::id();
        std::fs::write(state_path(&d), format!(r#"{{"version":1,"phase":"building","pid":{me},"runStartedAt":{},"tasks":[]}}"#, now_ms() + 60_000)).unwrap();
        assert_eq!(read_status(&d).unwrap()["alive"], true);
        if process_start_ms(me as i32).is_some() {
            std::fs::write(state_path(&d), format!(r#"{{"version":1,"phase":"building","pid":{me},"runStartedAt":1000,"tasks":[]}}"#)).unwrap();
            assert_eq!(read_status(&d).unwrap()["alive"], false, "pid reciclado não fica 'rodando' pra sempre");
        }
        assert_eq!(parse_etime("01:02"), Some(62));
        assert_eq!(parse_etime("1-02:03:04"), Some(86_400 + 7384));
        assert_eq!(parse_etime(""), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn wait_state_saida_cedo_tempo_e_pronto() {
        let d = tmp("wait");
        // o CLI morreu antes de gravar o estado → erro com o fim do log
        std::fs::write(log_path(&d), "· começando\n✕ falta a ideia: use --idea\n").unwrap();
        let e = wait_state(&d, 5_000, &|| true).unwrap_err();
        assert!(e.contains("falta a ideia"), "{e}");
        // estado "failed" gravado → o motivo
        std::fs::write(state_path(&d), r#"{"version":1,"phase":"failed","stopReason":"sem git","pid":0,"tasks":[]}"#).unwrap();
        assert!(wait_state(&d, 5_000, &|| true).unwrap_err().contains("sem git"));
        // vivo e ainda preparando (sem o banco) → aviso, não erro
        std::fs::write(state_path(&d), r#"{"version":1,"phase":"creating","pid":0,"tasks":[]}"#).unwrap();
        let w = wait_state(&d, 0, &|| false).unwrap();
        assert!(w.unwrap().contains("aba de progresso"));
        // pronto: estado + banco
        std::fs::write(d.join(".cardume/state.sqlite"), "").unwrap();
        assert_eq!(wait_state(&d, 0, &|| false).unwrap(), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pasta_nunca_sem_nome() {
        assert_eq!(dir_slug("!!!"), "app");
        assert_eq!(dir_slug("Recriar o Pou"), "recriar-o-pou");
    }
}
