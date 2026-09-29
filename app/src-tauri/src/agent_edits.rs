//! Fila de EDIÇÕES DE SPEC feitas por agentes que o motor não consegue aplicar sozinho (o épico e os
//! cartões do time moram na nuvem; o motor não tem sessão). O motor grava em
//! `<repo>/.cardume/agent-edits/<epic|card>-<id>.jsonl` (src/agent-edits.ts); o app lê as pendentes,
//! aplica pela sessão dele (epicPatch / PATCH em tasks.spec) e anota o desfecho em `applied.jsonl`.
//! Idempotente dos dois lados: o arquivo não repete a mesma edição, e o id aplicado não volta.
use std::collections::HashSet;
use std::path::Path;

pub const APPLIED: &str = "applied.jsonl";

/// PURA: ids já tratados (aplicados, recusados ou descartados) do ledger.
pub fn applied_ids(ledger: &str) -> HashSet<String> {
    ledger
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .collect()
}

/// PURA: linhas pendentes de um arquivo de fila (JSON por linha; linha quebrada é ignorada).
pub fn pending_from(text: &str, done: &HashSet<String>) -> Vec<serde_json::Value> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| v.get("id").and_then(|x| x.as_str()).map(|id| !done.contains(id)).unwrap_or(false))
        .collect()
}

/// Todas as edições pendentes da pasta (limite pra não inflar a resposta).
pub fn read_pending(dir: &Path) -> Vec<serde_json::Value> {
    let done = applied_ids(&std::fs::read_to_string(dir.join(APPLIED)).unwrap_or_default());
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    let mut files: Vec<_> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            n.ends_with(".jsonl") && n != APPLIED && (n.starts_with("epic-") || n.starts_with("card-"))
        })
        .collect();
    files.sort();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        out.extend(pending_from(&text, &done));
        if out.len() >= 50 {
            out.truncate(50);
            break;
        }
    }
    out
}

/// Anota o desfecho de uma edição no ledger (append; ler de novo já não devolve o id).
pub fn mark_done(dir: &Path, id: &str, outcome: &str, msg: &str) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let line = serde_json::json!({
        "id": id,
        "outcome": outcome,
        "msg": msg.chars().take(300).collect::<String>(),
        "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0),
    });
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(APPLIED)).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pendentes_ignoram_aplicadas_e_linhas_quebradas() {
        let done = applied_ids("{\"id\":\"a\",\"outcome\":\"applied\"}\nlixo\n");
        let v = pending_from("{\"id\":\"a\",\"kind\":\"epic\"}\n{\"id\":\"b\",\"kind\":\"epic\"}\n{parcial\n{\"kind\":\"sem-id\"}\n", &done);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["id"], "b");
    }

    #[test]
    fn marcar_feito_tira_da_fila_e_e_idempotente() {
        let dir = std::env::temp_dir().join(format!("sf-edits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("epic-e1.jsonl"), "{\"id\":\"x1\",\"kind\":\"epic\"}\n{\"id\":\"x2\",\"kind\":\"epic\"}\n").unwrap();
        std::fs::write(dir.join("outro.jsonl"), "{\"id\":\"zz\"}\n").unwrap(); // fora do padrão: ignorado
        assert_eq!(read_pending(&dir).len(), 2);
        mark_done(&dir, "x1", "applied", "ok").unwrap();
        mark_done(&dir, "x1", "applied", "ok").unwrap();
        let p = read_pending(&dir);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0]["id"], "x2");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
