//! PEDIDOS DE ÉPICO do motor (src/epic-requests.ts): `<repo>/.cardume/epic-requests/<id>.json` = criar épico /
//! vincular / desvincular tarefas existentes. O épico é do time (nuvem) e o motor não tem sessão: o front
//! (49-epico-pedidos.js) executa com a sessão dele e grava `<id>.result.json`, que o CLI/MCP espera e mostra.
//! `epics.json` = lista dos épicos do time pro `cardume epic list` (o front atualiza com o app aberto e logado).
use std::path::Path;

/// Id aceito no nome do arquivo (uuid): nada de caminho.
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

const WEEK_MS: u128 = 7 * 24 * 3600 * 1000;

fn mtime_ms(p: &Path) -> u128 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

/// Pedidos SEM resultado, mais antigos primeiro (até 50). Linha ilegível/id inválido fica de fora; pedido já
/// respondido há mais de 7 dias sai da pasta (com o resultado) — a fila não cresce pra sempre.
pub fn read_pending(dir: &Path) -> Vec<serde_json::Value> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut out: Vec<(String, serde_json::Value)> = vec![];
    for p in rd.filter_map(|e| e.ok().map(|e| e.path())) {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if !name.ends_with(".json") || name.ends_with(".result.json") || name == "epics.json" { continue; }
        let id = name.trim_end_matches(".json");
        if !safe_id(id) { continue; }
        let res = dir.join(format!("{id}.result.json"));
        if res.exists() {
            if now.saturating_sub(mtime_ms(&res)) > WEEK_MS { let _ = std::fs::remove_file(&res); let _ = std::fs::remove_file(&p); }
            continue;
        }
        let Some(v) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
        if v.get("id").and_then(|x| x.as_str()) != Some(id) { continue; }
        let at = v.get("at").and_then(|x| x.as_str()).unwrap_or("").to_string();
        out.push((at, v));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().take(50).map(|(_, v)| v).collect()
}

/// Grava o RESULTADO (atômico). O JSON precisa ser do mesmo pedido, com ok/status/message — e o pedido tem que existir.
pub fn write_result(dir: &Path, id: &str, json: &str) -> Result<(), String> {
    if !safe_id(id) { return Err("id de pedido inválido".into()); }
    if !dir.join(format!("{id}.json")).is_file() { return Err("pedido não existe".into()); }
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "resultado não é JSON".to_string())?;
    if v.get("id").and_then(|x| x.as_str()) != Some(id) { return Err("resultado de outro pedido".into()); }
    if v.get("ok").and_then(|x| x.as_bool()).is_none() || v.get("message").and_then(|x| x.as_str()).is_none() {
        return Err("resultado sem ok/message".into());
    }
    let f = dir.join(format!("{id}.result.json"));
    let tmp = dir.join(format!("{id}.result.json.tmp"));
    std::fs::write(&tmp, v.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

/// Lista dos épicos do time (`{"at":…, "epics":[{id,name,status,tasks}]}`), atômica.
pub fn write_epics(dir: &Path, json: &str) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "lista de épicos não é JSON".to_string())?;
    if !v.get("epics").map(|e| e.is_array()).unwrap_or(false) { return Err("lista de épicos sem `epics`".into()); }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("epics.json.tmp");
    std::fs::write(&tmp, v.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("epics.json")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pendentes_resultado_atomico_e_validacao() {
        let dir = std::env::temp_dir().join(format!("sf-epreq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.json"), r#"{"id":"b","kind":"link","at":"2026-10-08T10:00:02Z","tasks":[]}"#).unwrap();
        std::fs::write(dir.join("a.json"), r#"{"id":"a","kind":"create","at":"2026-10-08T10:00:01Z","tasks":[]}"#).unwrap();
        std::fs::write(dir.join("lixo.json"), "{parcial").unwrap();
        std::fs::write(dir.join("outro.json"), r#"{"id":"x"}"#).unwrap();
        std::fs::write(dir.join("epics.json"), r#"{"epics":[]}"#).unwrap();
        let p = read_pending(&dir);
        assert_eq!(p.iter().map(|v| v["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["a", "b"], "mais antigo primeiro; ilegível/id trocado fora");
        assert!(write_result(&dir, "../a", r#"{"id":"../a","ok":true,"message":"x"}"#).is_err());
        assert!(write_result(&dir, "zz", r#"{"id":"zz","ok":true,"message":"x"}"#).is_err(), "pedido inexistente");
        assert!(write_result(&dir, "a", r#"{"id":"b","ok":true,"message":"x"}"#).is_err(), "resultado de outro pedido");
        assert!(write_result(&dir, "a", r#"{"id":"a","message":"x"}"#).is_err(), "sem ok");
        write_result(&dir, "a", r#"{"id":"a","ok":false,"status":"refused","message":"sem login"}"#).unwrap();
        assert!(!dir.join("a.result.json.tmp").exists());
        let p = read_pending(&dir);
        assert_eq!(p.len(), 1, "respondido sai da fila");
        assert_eq!(p[0]["id"], "b");
        assert!(write_epics(&dir, r#"{"at":"x"}"#).is_err());
        write_epics(&dir, r#"{"at":"x","epics":[{"id":"e","name":"E"}]}"#).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
