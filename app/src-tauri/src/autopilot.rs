//! PILOTO AUTOMÁTICO (spec-piloto-automatico) — o núcleo é o motor TS (`cardume autopilot`, src/autopilot.ts).
//! O app só: escolhe a pasta nova (~/Documents/Starfork/<nome>), dispara o CLI DESANEXADO (grupo próprio, log em
//! <pasta>/.cardume/logs/autopilot.log), lê o progresso de <pasta>/.cardume/autopilot/state.json, pede pra parar
//! (arquivo STOP, respeitado entre passos) e retoma (roda o CLI de novo na mesma pasta). Nada de remoto/push/PR.
use super::{detach_new_group, engine_cli_path, cli_path, node_cmd, pid_alive, project_slug, repo_of, setting_get, starfork_projects_dir, unique_child, AppState};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::State;

pub(crate) const PLATFORMS: [&str; 4] = ["web", "ios", "android", "mobile"];

/// Argumentos do `cardume autopilot` (sem o node). PURA — testada abaixo. `idea` vazia = retomada.
#[allow(clippy::too_many_arguments)]
pub(crate) fn autopilot_cli_args(cli: &str, dir: &Path, idea: &str, platform: &str, name: &str, engine: &str, model: &str, parallel: Option<u32>, attempts: Option<u32>, budget_usd: Option<f64>) -> Vec<String> {
    let mut a: Vec<String> = vec!["--disable-warning=ExperimentalWarning".into(), cli.into(), "autopilot".into(), "--dir".into(), dir.display().to_string()];
    let mut opt = |k: &str, v: &str| { if !v.trim().is_empty() { a.push(k.into()); a.push(v.trim().into()); } };
    opt("--idea", idea);
    if PLATFORMS.contains(&platform) { opt("--platform", platform); }
    opt("--name", name);
    opt("--engine", engine);
    opt("--model", model);
    if let Some(p) = parallel.filter(|p| *p > 0) { opt("--parallel", &p.min(8).to_string()); }
    if let Some(n) = attempts.filter(|n| *n > 0) { opt("--attempts", &n.min(10).to_string()); }
    if let Some(b) = budget_usd.filter(|b| b.is_finite() && *b >= 0.0) { opt("--budget-usd", &format!("{b}")); }
    a
}

pub(crate) fn state_path(dir: &Path) -> PathBuf { dir.join(".cardume").join("autopilot").join("state.json") }
fn log_path(dir: &Path) -> PathBuf { dir.join(".cardume").join("logs").join("autopilot.log") }

/// Últimas `n` linhas do log do piloto (o que o CLI imprimiu).
pub(crate) fn log_tail(dir: &Path, n: usize) -> String {
    let t = std::fs::read_to_string(log_path(dir)).unwrap_or_default();
    let lines: Vec<&str> = t.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Estado do piloto + se o processo está vivo + fim do log. PURA no disco (sem State) — testada abaixo.
pub(crate) fn read_status(dir: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(state_path(dir)).map_err(|_| "nenhum piloto automático nesta pasta".to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("estado do piloto ilegível: {e}"))?;
    let pid = v.get("pid").and_then(|p| p.as_i64()).unwrap_or(0) as i32;
    let alive = pid > 0 && pid_alive(pid);
    if let Some(o) = v.as_object_mut() {
        o.insert("alive".into(), serde_json::Value::Bool(alive));
        o.insert("stopRequested".into(), serde_json::Value::Bool(dir.join(".cardume").join("autopilot").join("STOP").is_file()));
        o.insert("hasReport".into(), serde_json::Value::Bool(dir.join("AUTOPILOT.md").is_file()));
        o.insert("logTail".into(), serde_json::Value::String(log_tail(dir, 12)));
    }
    Ok(v)
}

/// Dispara o CLI desanexado (grupo próprio, sem stdin), com a saída no log da pasta. Uma thread colhe o filho.
fn spawn_cli(dir: &Path, args: Vec<String>) -> Result<(), String> {
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
    let mut child = cmd.spawn().map_err(|e| format!("falha ao iniciar o piloto: {e}"))?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

/// Espera o state.json nascer (o CLI cria o projeto e o banco antes). Morreu sem estado → erro com o log.
fn wait_state(dir: &Path, secs: u64) -> Result<(), String> {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < until {
        if state_path(dir).is_file() { return Ok(()); }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let tail = log_tail(dir, 12);
    Err(format!("o piloto não começou — saída do motor:\n{}", if tail.trim().is_empty() { "(log vazio)".into() } else { tail }))
}

fn engine_cli(state: &State<AppState>) -> Result<String, String> {
    engine_cli_path()
        .or_else(|| repo_of(state).ok().map(|r| cli_path(&r)))
        .ok_or_else(|| "não achei o motor do Starfork (engine/cli.mjs) — reinstale o app".to_string())
}

/// "Construir sozinho": pasta NOVA em ~/Documents/Starfork (ou `parent`), dispara o piloto e devolve a pasta
/// (o front abre o projeto e a aba de progresso).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn autopilot_start(state: State<AppState>, idea: String, platform: String, name: Option<String>, parent: Option<String>, engine: Option<String>, model: Option<String>, parallel: Option<u32>, attempts: Option<u32>, budget_usd: Option<f64>) -> Result<String, String> {
    let idea = idea.trim().to_string();
    if idea.is_empty() { return Err("escreva a ideia do app".into()); }
    if !PLATFORMS.contains(&platform.as_str()) { return Err(format!("plataforma inválida: {platform}")); }
    let name = name.unwrap_or_default().trim().to_string();
    let label = if name.is_empty() { idea.split_whitespace().take(5).collect::<Vec<_>>().join(" ") } else { name.clone() };
    let slug = project_slug(&label);
    let slug = if slug.is_empty() { "app".to_string() } else { slug.chars().take(48).collect::<String>().trim_matches('-').to_string() };
    let parent = parent.filter(|p| !p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(starfork_projects_dir);
    std::fs::create_dir_all(&parent).map_err(|e| format!("não consegui criar a pasta {}: {e}", parent.display()))?;
    let dir = parent.join(unique_child(&parent, &slug));
    let cli = engine_cli(&state)?;
    let args = autopilot_cli_args(&cli, &dir, &idea, &platform, &label, engine.as_deref().unwrap_or("claude"), model.as_deref().unwrap_or(""), parallel, attempts, budget_usd);
    spawn_cli(&dir, args)?;
    wait_state(&dir, 20)?;
    Ok(dir.display().to_string())
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
    let f = d.join(".cardume").join("autopilot").join("STOP");
    std::fs::write(&f, "app\n").map_err(|e| e.to_string())
}

/// Continuar (depois de parar, do teto ou de uma falha): roda o CLI de novo na MESMA pasta — ele segue do state.json.
#[tauri::command(async)]
pub(crate) fn autopilot_resume(state: State<AppState>, dir: String, budget_usd: Option<f64>) -> Result<(), String> {
    let d = PathBuf::from(&dir);
    let st = read_status(&d)?;
    if st.get("alive").and_then(|a| a.as_bool()).unwrap_or(false) { return Err("o piloto já está rodando".into()); }
    let cli = engine_cli(&state)?;
    let args = autopilot_cli_args(&cli, &d, "", "", "", "", "", None, None, budget_usd);
    spawn_cli(&d, args)
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
        let a = autopilot_cli_args("/e/cli.mjs", &d, " recriar o Pou ", "mobile", "Pou", "claude", "", Some(3), Some(2), Some(5.5));
        assert_eq!(a, ["--disable-warning=ExperimentalWarning", "/e/cli.mjs", "autopilot", "--dir", "/tmp/x/pou", "--idea", "recriar o Pou", "--platform", "mobile", "--name", "Pou", "--engine", "claude", "--parallel", "3", "--attempts", "2", "--budget-usd", "5.5"]);
        // retomada: só a pasta (e o teto, se mudou); plataforma inválida não vai
        let r = autopilot_cli_args("/e/cli.mjs", &d, "", "desktop", "", "", "", None, Some(0), None);
        assert_eq!(r, ["--disable-warning=ExperimentalWarning", "/e/cli.mjs", "autopilot", "--dir", "/tmp/x/pou"]);
        assert!(autopilot_cli_args("c", &d, "x", "web", "", "", "", Some(99), None, None).windows(2).any(|w| w[0] == "--parallel" && w[1] == "8"));
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
}
