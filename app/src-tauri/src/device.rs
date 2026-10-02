//! Painel DISPOSITIVO (spec-dispositivo-no-app): o Simulador iOS / emulador Android da tarefa ao vivo no app.
//!
//! O Rust NÃO transporta quadro nenhum: só sobe o espelho (`cardume mobile mirror`, um servidor HTTP local do motor
//! com token) e devolve a URL — o front lê o vídeo direto dele. Tudo aqui é comando ASSÍNCRONO (nada de travar a
//! janela): `device_cli` roda `mobile info|up|down` com uma lista FECHADA de subcomandos/flags, e
//! `device_mirror_start` lê só a 1ª linha do espelho (porta/token). O espelho morre junto com o app: o stdin dele é
//! um pipe nosso (fechou → ele sai) e, sem ninguém olhando por 60 s, ele sai sozinho.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use super::{cli_path, node_cmd, output_timeout, repo_of, task_worktree, AppState};

/// Subcomandos que o painel pode pedir (o resto do `cardume mobile` é do agente).
const ALLOWED: &[&str] = &["info", "up", "down"];
/// Flags com valor aceitas (o valor passa por `safe_val`).
const VALUE_FLAGS: &[&str] = &["platform", "device", "runtime", "avd"];

/// Valor seguro pra flag: plataforma fechada; ids de aparelho/AVD só com [A-Za-z0-9._-] (sem espaço, sem `--`).
fn safe_val(flag: &str, v: &str) -> bool {
    match flag {
        "platform" => v == "ios" || v == "android",
        _ => !v.is_empty() && v.len() <= 160 && !v.starts_with('-') && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'),
    }
}

/// Argumentos do `cardume mobile …` a partir do que o front mandou — puro, testável. Sempre `--viewer true`
/// (comando da PESSOA: no Android não segura a trava do emulador; ver mobile.ts).
pub fn device_args(sub: &str, flags: &[(String, String)], task_id: &str, wt: &str) -> Result<Vec<String>, String> {
    if !ALLOWED.contains(&sub) {
        return Err(format!("subcomando não permitido: {sub}"));
    }
    let mut out = vec!["mobile".to_string(), sub.to_string()];
    for (k, v) in flags {
        if !VALUE_FLAGS.contains(&k.as_str()) {
            return Err(format!("flag não permitida: {k}"));
        }
        if !safe_val(k, v) {
            return Err(format!("valor inválido pra --{k}"));
        }
        out.push(format!("--{k}"));
        out.push(v.clone());
    }
    if sub == "up" && !flags.iter().any(|(k, _)| k == "platform") {
        return Err("diga a plataforma (ios ou android)".into());
    }
    out.extend(["--task".into(), task_id.to_string(), "--wt".into(), wt.to_string(), "--viewer".into(), "true".into()]);
    Ok(out)
}

/// Tempo-limite por subcomando: ligar pode levar minutos (criar simulador, boot do AVD).
pub fn device_timeout(sub: &str) -> u64 {
    match sub {
        "up" => 420,
        "down" => 120,
        _ => 45,
    }
}

/// Saída do CLI → resultado: sucesso devolve a última linha JSON (info) ou o texto; erro devolve a linha "✕ …" + correção.
pub fn device_result(code: Option<i32>, stdout: &str) -> Result<String, String> {
    let text = stdout.lines().filter(|l| !l.contains("ExperimentalWarning") && !l.contains("--trace-warnings")).collect::<Vec<_>>().join("\n");
    if code == Some(0) {
        return Ok(text.trim().to_string());
    }
    let err = text.lines().skip_while(|l| !l.starts_with('✕')).collect::<Vec<_>>().join("\n");
    Err(if err.trim().is_empty() { text.trim().chars().take(400).collect() } else { err.trim().to_string() })
}

/// 1ª linha do espelho → (porta, token). `{"error": …}` vira o erro; texto solto ("✕ …") também.
pub fn parse_mirror_line(line: &str) -> Result<(u16, String), String> {
    let l = line.trim();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else {
        return Err(if l.is_empty() { "o espelho não respondeu".into() } else { l.chars().take(300).collect() });
    };
    if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
        return Err(e.to_string());
    }
    let port = v.get("port").and_then(|x| x.as_u64()).filter(|p| *p > 0 && *p < 65536).ok_or("o espelho não informou a porta")? as u16;
    let token = v.get("token").and_then(|x| x.as_str()).filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_hexdigit())).ok_or("o espelho não informou o token")?;
    Ok((port, token.to_string()))
}

struct Mirror {
    child: Child,
    port: u16,
    token: String,
}
/// UM espelho por (tarefa, plataforma).
static MIRRORS: std::sync::OnceLock<Mutex<HashMap<String, Mirror>>> = std::sync::OnceLock::new();
fn mirrors() -> &'static Mutex<HashMap<String, Mirror>> {
    MIRRORS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInfo {
    url: String,
    token: String,
    platform: String,
}

fn wt_of(state: &State<AppState>, task_id: &str) -> Result<PathBuf, String> {
    task_worktree(state, task_id)
}

/// `mobile info|up|down` do painel (assíncrono; lista fechada).
#[tauri::command(async)]
pub fn device_cli(state: State<AppState>, task_id: String, sub: String, flags: Vec<(String, String)>) -> Result<String, String> {
    let wt = wt_of(&state, &task_id)?;
    let args = device_args(&sub, &flags, &task_id, &wt.display().to_string())?;
    let repo = repo_of(&state).unwrap_or_else(|_| wt.clone());
    let mut c = node_cmd();
    c.arg("--disable-warning=ExperimentalWarning").arg(cli_path(&repo)).args(&args).current_dir(&wt);
    let o = output_timeout(c, device_timeout(&sub))?;
    device_result(o.status.code(), &String::from_utf8_lossy(&o.stdout))
}

/// Sobe (ou reaproveita) o espelho da tarefa e devolve a URL local + token.
#[tauri::command(async)]
pub fn device_mirror_start(state: State<AppState>, task_id: String, platform: String) -> Result<MirrorInfo, String> {
    if platform != "ios" && platform != "android" {
        return Err("plataforma inválida".into());
    }
    let key = format!("{task_id}|{platform}");
    {
        let mut m = mirrors().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cur) = m.get_mut(&key) {
            if matches!(cur.child.try_wait(), Ok(None)) {
                return Ok(MirrorInfo { url: format!("http://127.0.0.1:{}", cur.port), token: cur.token.clone(), platform });
            }
            m.remove(&key); // saiu sozinho (ocioso) → sobe outro
        }
    }
    let wt = wt_of(&state, &task_id)?;
    let repo = repo_of(&state).unwrap_or_else(|_| wt.clone());
    let mut c = node_cmd();
    c.arg("--disable-warning=ExperimentalWarning")
        .arg(cli_path(&repo))
        .args(["mobile", "mirror", "--platform", &platform, "--task", &task_id, "--wt", &wt.display().to_string(), "--viewer", "true"])
        .current_dir(&wt)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = c.spawn().map_err(|e| format!("não consegui abrir o espelho: {e}"))?;
    let stdout = child.stdout.take().ok_or("sem saída do espelho")?;
    // 1ª linha numa thread com prazo (compilar o sfsim no 1º uso leva alguns segundos)
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut rd = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match rd.read_line(&mut line) {
                Ok(0) | Err(_) => { let _ = tx.send(String::new()); return; }
                Ok(_) if line.trim_start().starts_with('{') || line.starts_with('✕') => break,
                Ok(_) => continue, // aviso do node etc.
            }
        }
        let _ = tx.send(line.clone());
        // continua lendo (descartando) pra o pipe nunca encher
        let mut sink = [0u8; 4096];
        while matches!(rd.read(&mut sink), Ok(n) if n > 0) {}
    });
    let first = rx.recv_timeout(Duration::from_secs(150)).unwrap_or_default();
    match parse_mirror_line(&first) {
        Ok((port, token)) => {
            mirrors().lock().unwrap_or_else(|e| e.into_inner()).insert(key, Mirror { child, port, token: token.clone() });
            Ok(MirrorInfo { url: format!("http://127.0.0.1:{port}"), token, platform })
        }
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(e)
        }
    }
}

/// Derruba o(s) espelho(s) da tarefa (fechar o painel / trocar de plataforma / desligar o aparelho).
#[tauri::command(async)]
pub fn device_mirror_stop(task_id: String, platform: Option<String>) -> usize {
    let mut m = mirrors().lock().unwrap_or_else(|e| e.into_inner());
    let keys: Vec<String> = m.keys().filter(|k| k.starts_with(&format!("{task_id}|")) && platform.as_ref().map_or(true, |p| k.ends_with(&format!("|{p}")))).cloned().collect();
    for k in &keys {
        if let Some(mut mi) = m.remove(k) {
            drop(mi.child.stdin.take()); // stdin fechado → o espelho sai limpo (para a captura)
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                if matches!(mi.child.try_wait(), Ok(None)) { let _ = mi.child.kill(); }
                let _ = mi.child.wait();
            });
        }
    }
    keys.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn f(k: &str, v: &str) -> (String, String) { (k.to_string(), v.to_string()) }

    #[test]
    fn args_lista_fechada_e_viewer_sempre() {
        let a = device_args("up", &[f("platform", "ios"), f("device", "com.apple.CoreSimulator.SimDeviceType.iPhone-17")], "t1", "/wt").unwrap();
        assert_eq!(a[..2], ["mobile".to_string(), "up".to_string()]);
        assert!(a.windows(2).any(|w| w[0] == "--viewer" && w[1] == "true"), "comando da pessoa: nunca segura a trava");
        assert!(a.windows(2).any(|w| w[0] == "--task" && w[1] == "t1"));
        assert!(device_args("shot", &[], "t1", "/wt").is_err(), "subcomando fora da lista");
        assert!(device_args("info", &[f("owner", "1")], "t1", "/wt").is_err(), "flag fora da lista");
        assert!(device_args("up", &[f("platform", "windows")], "t1", "/wt").is_err());
        assert!(device_args("up", &[f("platform", "android"), f("avd", "--wait")], "t1", "/wt").is_err(), "valor parecendo flag");
        assert!(device_args("up", &[f("platform", "android"), f("avd", "a b")], "t1", "/wt").is_err(), "espaço no valor");
        assert!(device_args("up", &[], "t1", "/wt").is_err(), "up sem plataforma");
        assert!(device_args("down", &[], "t1", "/wt").is_ok(), "down sem plataforma = tudo");
        assert!(device_args("info", &[], "t1", "/wt").is_ok());
    }

    #[test]
    fn primeira_linha_do_espelho() {
        assert_eq!(parse_mirror_line(r#"{"port":52753,"token":"eb89ab","plat":"ios"}"#).unwrap(), (52753, "eb89ab".to_string()));
        assert_eq!(parse_mirror_line(r#"{"error":"o simulador iOS desta tarefa está desligado"}"#).unwrap_err(), "o simulador iOS desta tarefa está desligado");
        assert!(parse_mirror_line("✕ não sei de qual tarefa").unwrap_err().starts_with('✕'));
        assert!(parse_mirror_line("").is_err());
        assert!(parse_mirror_line(r#"{"port":0,"token":"ab"}"#).is_err());
        assert!(parse_mirror_line(r#"{"port":80,"token":"x y"}"#).is_err(), "token só hex");
    }

    #[test]
    fn resultado_do_cli() {
        assert_eq!(device_result(Some(0), "(node) ExperimentalWarning: x\n{\"mobile\":true}\n").unwrap(), "{\"mobile\":true}");
        assert_eq!(device_result(Some(1), "… subindo\n✕ O AVD \"x\" não existe.\n  como resolver: crie\n").unwrap_err(), "✕ O AVD \"x\" não existe.\n  como resolver: crie");
        assert_eq!(device_timeout("up"), 420);
        assert_eq!(device_timeout("info"), 45);
    }
}
