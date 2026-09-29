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
    let mut pruned = false;
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        let p = pending_from(&text, &done);
        // arquivo com TUDO já tratado: sai da pasta (a fila não cresce pra sempre)
        if p.is_empty() && !text.trim().is_empty() && std::fs::remove_file(&f).is_ok() {
            pruned = true;
            continue;
        }
        if out.len() < 200 { out.extend(p); }
    }
    out.truncate(200);
    if pruned { compact_ledger(dir); }
    out
}

/// Ledger só guarda ids que ainda aparecem em algum arquivo da fila (os outros já não servem pra nada).
fn compact_ledger(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut live: HashSet<String> = HashSet::new();
    for p in rd.filter_map(|e| e.ok().map(|e| e.path())) {
        let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if !n.ends_with(".jsonl") || n == APPLIED { continue; }
        for l in std::fs::read_to_string(&p).unwrap_or_default().lines() {
            if let Some(id) = serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string())) { live.insert(id); }
        }
    }
    let ledger = std::fs::read_to_string(dir.join(APPLIED)).unwrap_or_default();
    let kept: Vec<&str> = ledger.lines().filter(|l| {
        serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|id| live.contains(id))).unwrap_or(false)
    }).collect();
    let _ = std::fs::write(dir.join(APPLIED), if kept.is_empty() { String::new() } else { kept.join("\n") + "\n" });
}

/// PURA: o que o snapshot leva de cada edição/proposta — só quem, quando e quais campos (o antes/depois
/// completo vem sob demanda por `task_agent_edit`, pra não inflar o snapshot que o app lê a cada poll).
pub fn compact_edits(spec: &serde_json::Value) -> Option<serde_json::Value> {
    let edits = spec.get("agentEdits").and_then(|v| v.as_array())?;
    Some(serde_json::Value::Array(edits.iter().map(|e| {
        let fields: Vec<serde_json::Value> = e.get("changes").and_then(|c| c.as_array()).map(|c| c.iter().filter_map(|x| x.get("field").cloned()).collect()).unwrap_or_default();
        let mut m = serde_json::Map::new();
        for k in ["id", "at", "by", "byTask", "byTitle", "delivered", "approvedBy", "undone"] {
            if let Some(v) = e.get(k).filter(|v| !v.is_null()) { m.insert(k.into(), v.clone()); }
        }
        if let Some(n) = e.get("note").and_then(|v| v.as_str()) { m.insert("note".into(), serde_json::Value::String(n.chars().take(160).collect())); }
        m.insert("fields".into(), serde_json::Value::Array(fields));
        serde_json::Value::Object(m)
    }).collect()))
}

/// PURA: resposta JSON do CLI `task edit --json` → Ok(json inteiro, com `mode`) | Err(mensagem pt-BR).
pub fn parse_cli_edit(stdout: &str, stderr: &str) -> Result<String, String> {
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("").trim();
    let v: serde_json::Value = serde_json::from_str(line).map_err(|_| {
        let se = stderr.trim();
        if se.is_empty() { format!("resposta inesperada do motor: {}", stdout.trim().chars().take(200).collect::<String>()) } else { se.lines().last().unwrap_or(se).to_string() }
    })?;
    if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) { Ok(v.to_string()) } else {
        Err(v.get("message").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).unwrap_or("o motor recusou a edição").to_string())
    }
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
        // tudo tratado → o arquivo sai da pasta e o ledger é compactado
        mark_done(&dir, "x2", "refused", "não").unwrap();
        assert!(read_pending(&dir).is_empty());
        assert!(!dir.join("epic-e1.jsonl").exists());
        assert_eq!(std::fs::read_to_string(dir.join(APPLIED)).unwrap().trim(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resumo_das_edicoes_leva_so_campos_e_quem() {
        let sp = serde_json::json!({"agentEdits":[{"id":"e1","by":"Orion","at":"t","note":"n","changes":[{"field":"objective","before":"A".repeat(3000),"after":"B"}]}]});
        let c = compact_edits(&sp).unwrap();
        assert_eq!(c[0]["id"], "e1");
        assert_eq!(c[0]["fields"][0], "objective");
        assert!(c[0].get("changes").is_none(), "antes/depois vem sob demanda");
        assert!(compact_edits(&serde_json::json!({})).is_none());
    }

    #[test]
    fn resposta_do_cli_vira_ok_ou_erro_legivel() {
        let ok = parse_cli_edit("log qualquer\n{\"ok\":true,\"mode\":\"unchanged\",\"message\":\"nada mudou\"}\n", "");
        assert!(ok.unwrap().contains("\"mode\":\"unchanged\""));
        assert_eq!(parse_cli_edit("{\"ok\":false,\"message\":\"a tarefa já está mergeada\"}", "").unwrap_err(), "a tarefa já está mergeada");
        assert_eq!(parse_cli_edit("", "Error: boom\n  at x\nfalhou feio").unwrap_err(), "falhou feio");
        assert!(parse_cli_edit("lixo", "").unwrap_err().starts_with("resposta inesperada do motor"));
    }
}
