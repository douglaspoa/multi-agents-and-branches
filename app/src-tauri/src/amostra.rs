//! TESTAR NUMA AMOSTRA (F5 · P15 da mesa de 03/10/2026) — só o revisor, local (vale no Grátis).
//! O motor (`cardume sample-review`) reexecuta SÓ a revisão da versão atual do agente numa cópia descartável de uma
//! tarefa passada e grava o veredito novo ao lado do antigo em `.cardume/aprendizado/amostras.json`. Aqui: o comando
//! assíncrono que espera o motor (a janela nunca congela) e a leitura das amostras guardadas pra ficha.

use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::State;

use super::{cli_path, node_cmd, repo_or, AppState};

/// Uma amostra por vez por projeto (dois cliques não pagam duas revisões).
static RUNNING: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Prazo duro de uma amostra (uma revisão só; o motor também tem os próprios limites).
const SAMPLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25 * 60);

pub fn samples_path(repo: &Path) -> std::path::PathBuf {
    repo.join(".cardume").join("aprendizado").join("amostras.json")
}

/// Amostras guardadas de um agente (mais recentes primeiro). Arquivo ausente/corrompido = nenhuma.
pub fn samples_of(repo: &Path, agent_id: &str) -> Vec<Value> {
    let arr: Vec<Value> = std::fs::read_to_string(samples_path(repo)).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let mut out: Vec<Value> = arr.into_iter().filter(|x| x["agentId"].as_str() == Some(agent_id)).collect();
    out.sort_by(|a, b| b["at"].as_i64().unwrap_or(0).cmp(&a["at"].as_i64().unwrap_or(0)));
    out
}

/// A última linha JSON da saída do motor (o resto é log).
pub fn last_json(stdout: &str) -> Option<Value> {
    stdout.lines().rev().map(str::trim).filter(|l| l.starts_with('{')).find_map(|l| serde_json::from_str::<Value>(l).ok())
}

#[tauri::command(async)]
pub fn agent_samples(state: State<AppState>, repo: Option<String>, agent_id: String) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    Ok(Value::Array(samples_of(&repo, &agent_id)))
}

#[tauri::command(async)]
pub fn agent_sample_review(state: State<AppState>, repo: Option<String>, task_id: String, agent_id: String, cap_usd: f64) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    if !(cap_usd.is_finite() && cap_usd > 0.0) { return Err("a amostra precisa de um teto".into()); }
    let key = repo.display().to_string();
    {
        let mut r = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if r.contains(&key) { return Err("já tem uma amostra rodando neste projeto — espere ela terminar".into()); }
        r.push(key.clone());
    }
    // saída em arquivo (nada de pipe cheio travando o filho) e prazo DURO: uma amostra que não volta em
    // SAMPLE_TIMEOUT é morta — o projeto nunca fica preso em "já tem uma amostra rodando"
    let dir = repo.join(".cardume").join("aprendizado");
    let _ = std::fs::create_dir_all(&dir);
    let (fo, fe) = (dir.join(format!("amostra-{}.out", std::process::id())), dir.join(format!("amostra-{}.err", std::process::id())));
    let out = (|| -> Result<(String, String), String> {
        let mut cmd = node_cmd();
        cmd.args([
            "--disable-warning=ExperimentalWarning".to_string(), cli_path(&repo), "sample-review".to_string(), task_id.clone(),
            "--agent".to_string(), agent_id.clone(), "--cap".to_string(), format!("{cap_usd}"),
            "--repo".to_string(), repo.display().to_string(), "--json".to_string(),
        ])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::from(std::fs::File::create(&fo).map_err(|e| e.to_string())?))
        .stderr(Stdio::from(std::fs::File::create(&fe).map_err(|e| e.to_string())?));
        let mut child = cmd.spawn().map_err(|e| format!("não consegui rodar o motor: {e}"))?;
        let t0 = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if t0.elapsed() > SAMPLE_TIMEOUT => {
                    let _ = child.kill(); let _ = child.wait();
                    return Err(format!("a amostra passou de {} minutos e foi parada — nada mudou na tarefa original", SAMPLE_TIMEOUT.as_secs() / 60));
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(500)),
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok((std::fs::read_to_string(&fo).unwrap_or_default(), std::fs::read_to_string(&fe).unwrap_or_default()))
    })();
    RUNNING.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| k != &key);
    let _ = std::fs::remove_file(&fo); let _ = std::fs::remove_file(&fe);
    let (stdout, err) = out?;
    if let Some(j) = last_json(&stdout) {
        if let Some(e) = j.get("error").and_then(|e| e.as_str()) { return Err(e.to_string()); }
        return Ok(j);
    }
    let line = err.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("o motor não devolveu o resultado da amostra");
    Err(line.trim_start_matches("✕ ").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amostras_do_agente_mais_recentes_primeiro_e_arquivo_ruim_vira_nada() {
        let repo = std::env::temp_dir().join(format!("sf-amostra-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(repo.join(".cardume").join("aprendizado")).unwrap();
        assert!(samples_of(&repo, "nyx").is_empty());
        std::fs::write(samples_path(&repo), "{ruim").unwrap();
        assert!(samples_of(&repo, "nyx").is_empty());
        std::fs::write(samples_path(&repo), r#"[{"agentId":"nyx","at":1},{"agentId":"iris","at":5},{"agentId":"nyx","at":3}]"#).unwrap();
        let l = samples_of(&repo, "nyx");
        assert_eq!(l.iter().map(|x| x["at"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, 1]);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn ultima_linha_json_da_saida() {
        assert_eq!(last_json("→ criando\n{\"ok\":1}\nlog\n{\"ok\":2}\n").unwrap()["ok"], 2);
        assert!(last_json("nada aqui").is_none());
    }
}
