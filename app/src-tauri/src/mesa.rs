//! MESA DE PERSONAS (party mode) no app: personas independentes discutem um tema do
//! projeto em rodadas (posição → debate e voto) e a aba Mesa (app/src/js/38-mesa.js)
//! apura os votos. Aqui mora só o que precisa de processo/disco:
//!   - `mesa_ask`: UMA chamada isolada ao claude (persona = system prompt próprio +
//!     cérebro do projeto via `with_memory` + resumo do repositório), parável por mesa;
//!   - `mesa_save`/`mesa_list`/`mesa_read`: a mesa inteira em `.cardume/mesas/<id>.json`
//!     (só local — a nuvem só recebe a DECISÃO aprovada, como nota do cérebro, pelo JS);
//!   - `mesa_stop`: derruba todas as personas em andamento daquela mesa.
//! Todo acesso a arquivo é TRAVADO em `.cardume/mesas/` (id validado, sem separador).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use tauri::State;

use super::{claude_bin, claude_cmd, claude_json, detach_new_group, memoria, procsig, protect_args, protect_on, repo_or, signal_group, AppState};

/// Resposta máxima de uma persona (s). Uma persona só lê e opina — 5 min é folga.
const ASK_SECS: u64 = 300;
pub const STOPPED: &str = "MESA_STOPPED";

// ---------------------------------------------------------------------------
// caminho travado
// ---------------------------------------------------------------------------

/// id de mesa (ou "personas"): ascii, sem ponto/barra — nunca escapa da pasta.
pub fn ok_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
pub fn mesas_dir(repo: &Path) -> PathBuf { repo.join(".cardume").join("mesas") }
/// Caminho do arquivo da mesa — Err se o id não é válido.
pub fn mesa_path(repo: &Path, id: &str) -> Result<PathBuf, String> {
    if !ok_id(id) { return Err("id de mesa inválido".into()); }
    Ok(mesas_dir(repo).join(format!("{id}.json")))
}

// ---------------------------------------------------------------------------
// resumo do repositório (vai no system prompt de toda persona)
// ---------------------------------------------------------------------------

fn cut(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

/// Nome da pasta, descrição do package.json, itens da raiz e o começo do README.
/// Serve pra projeto de software e pra pasta de documentos (não assume código).
pub fn repo_summary(repo: &Path) -> String {
    let name = repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut out = format!("## O projeto\nPasta: {name}\n");
    if let Ok(pk) = std::fs::read_to_string(repo.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pk) {
            let d = v["description"].as_str().unwrap_or("").trim();
            if !d.is_empty() { out.push_str(&format!("Descrição (package.json): {}\n", cut(d, 300))); }
        }
    }
    let mut items: Vec<String> = std::fs::read_dir(repo)
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') || n == "node_modules" || n == "target" || n == "dist" { return None; }
            let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(if dir { format!("{n}/") } else { n })
        }).collect())
        .unwrap_or_default();
    items.sort();
    if !items.is_empty() {
        let more = items.len().saturating_sub(40);
        items.truncate(40);
        out.push_str(&format!("Na raiz: {}{}\n", items.join(", "), if more > 0 { format!(" (+{more})") } else { String::new() }));
    }
    for r in ["README.md", "readme.md", "README.MD", "Readme.md", "README.txt", "README"] {
        if let Ok(t) = std::fs::read_to_string(repo.join(r)) {
            let t = t.trim();
            if !t.is_empty() { out.push_str(&format!("\n### Começo do {r}\n{}\n", cut(t, 1800))); }
            break;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// processos: várias personas em paralelo por mesa, todas paráveis
// ---------------------------------------------------------------------------

fn pids() -> &'static Mutex<HashMap<String, Vec<i32>>> {
    static P: OnceLock<Mutex<HashMap<String, Vec<i32>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
fn pid_add(id: &str, pid: i32) { pids().lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().push(pid); }
fn pid_del(id: &str, pid: i32) {
    let mut m = pids().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = m.get_mut(id) { v.retain(|p| *p != pid); if v.is_empty() { m.remove(id); } }
}

/// Roda o claude num grupo próprio, com teto de tempo, registrado sob o id da mesa.
fn run_stoppable(mut cmd: std::process::Command, secs: u64, id: &str) -> Result<std::process::Output, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    detach_new_group(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    let pid = child.id() as i32;
    pid_add(id, pid);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let timed_out = std::sync::Arc::new(AtomicBool::new(false));
    let t2 = timed_out.clone();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(secs)).is_err() { t2.store(true, Ordering::SeqCst); signal_group(pid, procsig::KILL); }
    });
    let out = child.wait_with_output();
    let _ = tx.send(());
    let _ = watch.join();
    pid_del(id, pid);
    let out = out.map_err(|e| e.to_string())?;
    if out.status.code().is_none() {
        return Err(if timed_out.load(Ordering::SeqCst) { format!("a persona demorou mais de {secs}s e foi interrompida") } else { STOPPED.to_string() });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// comandos (todos async: nada de processo ou disco na thread da janela)
// ---------------------------------------------------------------------------

/// UMA persona responde UMA vez, isolada (não vê as outras além do que vier no prompt).
/// `json`: a resposta tem que ser só o bloco JSON pedido. Devolve `{ text, costUsd }`.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn mesa_ask(
    state: State<AppState>, repo: Option<String>, id: String, persona_sys: String, prompt: String,
    model: Option<String>, json: Option<bool>,
) -> Result<serde_json::Value, String> {
    if !ok_id(&id) { return Err("id de mesa inválido".into()); }
    let repo = repo_or(&state, repo)?;
    let mut sys = format!(
        "{}\n\nVocê pode ler arquivos do projeto (Read, Grep, Glob) se precisar confirmar algo, mas NÃO edita nada e responde em português do Brasil.\n\n{}",
        persona_sys.trim(), repo_summary(&repo)
    );
    if json.unwrap_or(false) { sys.push_str("\n\nFORMATO: responda SOMENTE com o bloco ```json pedido — nada de texto fora dele."); }
    let query: String = prompt.chars().take(1200).collect();
    let sys = memoria::with_memory(&sys, &repo, &query);
    let mut args: Vec<String> = vec![
        "-p".into(), prompt,
        "--output-format".into(), "json".into(),
        "--append-system-prompt".into(), sys,
        "--allowedTools".into(), "Read,Grep,Glob".into(),
    ];
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) { args.push("--model".into()); args.push(m); }
    args.extend(protect_args(protect_on(&repo))); // por último: a flag é variádica
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(&args).current_dir(&repo);
    let out = run_stoppable(cmd, ASK_SECS, &id)?;
    let v = claude_json(&out)?;
    let cost = v["total_cost_usd"].as_f64().or_else(|| v["cost_usd"].as_f64()).unwrap_or(0.0);
    Ok(serde_json::json!({ "text": v["result"].as_str().unwrap_or(""), "costUsd": cost }))
}

/// Para TODAS as personas em andamento desta mesa. true = havia alguma rodando.
#[tauri::command(async)]
pub fn mesa_stop(id: String) -> Result<bool, String> {
    let list = pids().lock().unwrap_or_else(|e| e.into_inner()).remove(&id).unwrap_or_default();
    for p in &list { signal_group(*p, procsig::KILL); }
    Ok(!list.is_empty())
}

pub fn save_to(repo: &Path, id: &str, data: &serde_json::Value) -> Result<(), String> {
    let p = mesa_path(repo, id)?;
    std::fs::create_dir_all(mesas_dir(repo)).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    // grava num temporário e renomeia: fechar o app no meio não deixa JSON pela metade
    let tmp = mesas_dir(repo).join(format!(".{id}.json.tmp"));
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Salva a mesa (ou `personas`, as personas geradas do projeto) em .cardume/mesas/<id>.json.
#[tauri::command(async)]
pub fn mesa_save(state: State<AppState>, repo: Option<String>, id: String, data: serde_json::Value) -> Result<(), String> {
    let repo = repo_or(&state, repo)?;
    save_to(&repo, &id, &data)
}

/// Lê uma mesa (ou `personas`). Arquivo ausente → null.
#[tauri::command(async)]
pub fn mesa_read(state: State<AppState>, repo: Option<String>, id: String) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    let p = mesa_path(&repo, &id)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("mesa corrompida ({id}): {e}")),
        Err(_) => Ok(serde_json::Value::Null),
    }
}

pub fn list_in(repo: &Path) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = std::fs::read_dir(mesas_dir(repo))
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let id = n.strip_suffix(".json")?.to_string();
            if !ok_id(&id) || id == "personas" { return None; }
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            Some(serde_json::json!({
                "id": id, "tema": v["tema"], "status": v["status"], "createdAt": v["createdAt"], "updatedAt": v["updatedAt"],
                "costUsd": v["costUsd"], "personas": v["personas"].as_array().map(|a| a.len()).unwrap_or(0),
                "rounds": v["rounds"].as_array().map(|a| a.len()).unwrap_or(0),
            }))
        }).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b["updatedAt"].as_i64().unwrap_or(0).cmp(&a["updatedAt"].as_i64().unwrap_or(0)));
    out
}

/// Resumo das mesas deste projeto, mais recente primeiro.
#[tauri::command(async)]
pub fn mesa_list(state: State<AppState>, repo: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let repo = repo_or(&state, repo)?;
    Ok(list_in(&repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cardume-mesa-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn id_travado_na_pasta() {
        assert!(ok_id("m-20260928-ab12"));
        assert!(ok_id("personas"));
        for bad in ["", "../x", "a/b", "a\\b", "x.json", "..", "a b", &"x".repeat(81)] { assert!(!ok_id(bad), "{bad}"); }
        let r = Path::new("/tmp/repo");
        assert_eq!(mesa_path(r, "m1").unwrap(), PathBuf::from("/tmp/repo/.cardume/mesas/m1.json"));
        assert!(mesa_path(r, "../../etc/passwd").is_err());
    }
    #[test]
    fn salva_lista_e_le() {
        let d = tmp("io");
        save_to(&d, "m1", &serde_json::json!({"tema":"a","updatedAt":1,"personas":[1,2],"rounds":[1]})).unwrap();
        save_to(&d, "m2", &serde_json::json!({"tema":"b","updatedAt":5,"personas":[],"rounds":[]})).unwrap();
        save_to(&d, "personas", &serde_json::json!({"personas":[]})).unwrap();
        assert!(save_to(&d, "../fora", &serde_json::json!({})).is_err());
        let l = list_in(&d);
        assert_eq!(l.len(), 2, "personas.json não é mesa");
        assert_eq!(l[0]["id"], "m2");
        assert_eq!(l[1]["personas"], 2);
        assert!(!mesas_dir(&d).join(".m1.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn resumo_do_repo() {
        let d = tmp("sum");
        std::fs::write(d.join("README.md"), "# Agenda do pilates\nApp de agendamento.").unwrap();
        std::fs::write(d.join("package.json"), r#"{"description":"agendamento"}"#).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        std::fs::write(d.join(".env"), "SEGREDO=1").unwrap();
        let s = repo_summary(&d);
        assert!(s.contains("Agenda do pilates"), "{s}");
        assert!(s.contains("Descrição (package.json): agendamento"), "{s}");
        assert!(s.contains("src/"), "{s}");
        assert!(!s.contains("node_modules") && !s.contains(".env") && !s.contains("SEGREDO"), "{s}");
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn parar_sem_nada_rodando() {
        assert!(!mesa_stop("nao-existe".into()).unwrap());
    }
}
