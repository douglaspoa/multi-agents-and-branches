//! Contexto VIVO do épico que o app grava pro motor (src/epic-context.ts): `<repo>/.cardume/epic-context/<epicId>.json`
//! com o épico e as irmãs (ids da nuvem/locais, títulos, status, requisitos). O motor regenera o EPIC.md a cada turno
//! a partir dele e resolve o alvo do edit_task. Quando falta/está velho, o motor grava `refresh-request` e o app
//! (tick de poucos segundos) atualiza.
use std::path::Path;

/// Id aceito no nome do arquivo (uuid da nuvem): nada de caminho.
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Escrita ATÔMICA (tmp + rename) do contexto; o JSON tem que ser do mesmo épico.
pub fn write_context(dir: &Path, epic_id: &str, json: &str) -> Result<(), String> {
    if !safe_id(epic_id) { return Err("id de épico inválido".into()); }
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "contexto do épico não é JSON".to_string())?;
    if v.get("epicId").and_then(|x| x.as_str()) != Some(epic_id) { return Err("contexto de outro épico".into()); }
    if !v.get("siblings").map(|s| s.is_array()).unwrap_or(false) { return Err("contexto sem a lista de irmãs".into()); }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let f = dir.join(format!("{epic_id}.json"));
    let tmp = dir.join(format!("{epic_id}.json.tmp"));
    std::fs::write(&tmp, v.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

/// Pedidos de refresh do motor: lê e APAGA o arquivo (cada pedido é atendido uma vez). Ids inválidos saem.
pub fn take_requests(dir: &Path) -> Vec<String> {
    let f = dir.join("refresh-request");
    let Ok(text) = std::fs::read_to_string(&f) else { return vec![] };
    let _ = std::fs::remove_file(&f);
    serde_json::from_str::<serde_json::Value>(&text).ok()
        .and_then(|v| v.get("epicIds").and_then(|a| a.as_array()).cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).filter(|s| safe_id(s)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grava_atomico_e_recusa_o_que_nao_e_do_epico() {
        let dir = std::env::temp_dir().join(format!("sf-epctx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ok = r#"{"epicId":"e1","title":"T","siblings":[],"updatedAt":"x"}"#;
        write_context(&dir, "e1", ok).unwrap();
        assert!(dir.join("e1.json").is_file());
        assert!(!dir.join("e1.json.tmp").exists());
        assert!(write_context(&dir, "../x", ok).is_err());
        assert!(write_context(&dir, "e2", ok).is_err(), "JSON de outro épico");
        assert!(write_context(&dir, "e1", r#"{"epicId":"e1"}"#).is_err());
        std::fs::write(dir.join("refresh-request"), r#"{"epicIds":["e1","../mal",""]}"#).unwrap();
        assert_eq!(take_requests(&dir), vec!["e1".to_string()]);
        assert!(take_requests(&dir).is_empty(), "pedido atendido uma vez");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
