//! VERSÕES DE AGENTE E DE SKILL (decisão da mesa 03/10 — P11). Espelho de `src/agent-versions.ts`:
//! mesmo formato de arquivo, paridade conferida pelo fixture `tests/fixtures/ciclo-golden/versoes.json`.
//!
//! - Agente: `.cardume/agentes/<id>/versoes.json` = { agentId, current, versions:[últimas 5] }. Sem arquivo = v1.
//! - Skill: `.cardume/aprendizado/historico/<nome>/v<N>.md` = os BYTES do SKILL.md da versão N (últimas 5) +
//!   `index.json`. "Voltar pro jeito antigo" restaura byte a byte a anterior e vira versão nova; sem anterior,
//!   ARQUIVA (move o SKILL.md pro histórico — nunca apaga).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const KEEP_VERSIONS: i64 = 5;

/// id de agente seguro pra pasta (≡ `agentKey` do TS).
pub fn agent_key(id: &str) -> String {
    let f = crate::memoria::fold(id);
    let mut out = String::new();
    let mut dash = false;
    for c in f.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() { out.push(c); dash = false; }
        else if !dash && !out.is_empty() { out.push('-'); dash = true; }
    }
    let t: String = out.trim_matches('-').chars().take(60).collect();
    t.trim_end_matches('-').to_string()
}

fn atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = PathBuf::from(format!("{}.{}.tmp", p.display(), std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}
fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok())
}

// ---------------------------------------------------------------- agente

pub fn agent_versions_file(cardume: &Path, agent_id: &str) -> PathBuf {
    cardume.join("agentes").join(agent_key(agent_id)).join("versoes.json")
}
pub fn read_agent_versions(cardume: &Path, agent_id: &str) -> Value {
    if let Some(j) = read_json(&agent_versions_file(cardume, agent_id)) {
        if j["current"].as_i64().unwrap_or(0) >= 1 && j["versions"].is_array() {
            return json!({ "agentId": agent_key(agent_id), "current": j["current"], "versions": j["versions"] });
        }
    }
    json!({ "agentId": agent_key(agent_id), "current": 1, "versions": [] })
}
pub fn agent_version(cardume: &Path, agent_id: &str) -> i64 {
    if agent_key(agent_id).is_empty() { return 1; }
    read_agent_versions(cardume, agent_id)["current"].as_i64().unwrap_or(1)
}
/// Próxima versão do agente (mudança ACEITA pela pessoa). `extra` leva persona/before quando a mudança é de persona.
pub fn bump_agent(cardume: &Path, agent_id: &str, at: i64, change: &str, what: &str, persona: Option<&str>, before: Option<&str>) -> Result<i64, String> {
    let cur = read_agent_versions(cardume, agent_id);
    let v = cur["current"].as_i64().unwrap_or(1) + 1;
    let mut entry = json!({ "v": v, "at": at, "change": change, "what": what });
    if let Some(p) = persona { entry["persona"] = json!(p); }
    if let Some(b) = before { entry["before"] = json!(b); }
    let mut list: Vec<Value> = cur["versions"].as_array().cloned().unwrap_or_default();
    list.push(entry);
    let skip = list.len().saturating_sub(KEEP_VERSIONS as usize);
    let list: Vec<Value> = list.into_iter().skip(skip).collect();
    let out = json!({ "agentId": agent_key(agent_id), "current": v, "versions": list });
    atomic(&agent_versions_file(cardume, agent_id), serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?.as_bytes())?;
    Ok(v)
}

// ---------------------------------------------------------------- skill

pub fn skill_hist_dir(cardume: &Path, name: &str) -> PathBuf {
    cardume.join("aprendizado").join("historico").join(name)
}
pub fn read_skill_history(cardume: &Path, name: &str) -> Option<Value> {
    let j = read_json(&skill_hist_dir(cardume, name).join("index.json"))?;
    if !j["versions"].is_array() { return None; }
    Some(json!({ "name": name, "current": j["current"].as_i64().unwrap_or(0), "archived": j["archived"].as_bool().unwrap_or(false), "versions": j["versions"] }))
}
#[allow(dead_code)] // paridade com `skillVersion` do TS (a ficha lê o histórico inteiro)
pub fn skill_version(cardume: &Path, name: &str) -> i64 {
    read_skill_history(cardume, name).and_then(|h| h["current"].as_i64()).filter(|v| *v >= 1).unwrap_or(1)
}
fn prune(dir: &Path, current: i64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if let Some(num) = n.strip_prefix('v').and_then(|x| x.strip_suffix(".md")).and_then(|x| x.parse::<i64>().ok()) {
            if num <= current - KEEP_VERSIONS { let _ = std::fs::remove_file(e.path()); }
        }
    }
}
fn save_hist(cardume: &Path, h: &Value) -> Result<(), String> {
    let name = h["name"].as_str().unwrap_or("");
    let list: Vec<Value> = h["versions"].as_array().cloned().unwrap_or_default();
    let skip = list.len().saturating_sub(KEEP_VERSIONS as usize);
    let out = json!({ "name": name, "current": h["current"], "archived": h["archived"], "versions": list.into_iter().skip(skip).collect::<Vec<_>>() });
    let dir = skill_hist_dir(cardume, name);
    atomic(&dir.join("index.json"), serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?.as_bytes())?;
    prune(&dir, h["current"].as_i64().unwrap_or(0));
    Ok(())
}
fn ventry(v: i64, at: i64, action: &str, reason: &str, task_id: &str, agente: &str) -> Value {
    json!({ "v": v, "at": at, "action": action, "reason": reason, "taskId": task_id, "agente": agente })
}

/// Grava `content` como o SKILL.md de `skills_root/<name>/` criando a próxima versão (≡ `writeSkillVersion`).
pub fn write_skill_version(cardume: &Path, skills_root: &Path, name: &str, content: &[u8], at: i64, action: &str, reason: &str, task_id: &str, agente: &str) -> Result<i64, String> {
    let md = skills_root.join(name).join("SKILL.md");
    let dir = skill_hist_dir(cardume, name);
    let mut h = match read_skill_history(cardume, name) {
        Some(h) => h,
        None => {
            let mut h = json!({ "name": name, "current": 0, "archived": false, "versions": [] });
            if md.is_file() {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                std::fs::write(dir.join("v1.md"), std::fs::read(&md).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                h["current"] = json!(1);
                h["versions"].as_array_mut().unwrap().push(ventry(1, at, "legado", "", "", ""));
            }
            h
        }
    };
    let v = h["current"].as_i64().unwrap_or(0) + 1;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    atomic(&md, content)?;
    std::fs::write(dir.join(format!("v{v}.md")), content).map_err(|e| e.to_string())?;
    h["current"] = json!(v);
    h["archived"] = json!(false);
    h["versions"].as_array_mut().ok_or("histórico inválido")?.push(ventry(v, at, action, reason, task_id, agente));
    save_hist(cardume, &h)?;
    Ok(v)
}

/// "Voltar pro jeito antigo" (≡ `revertSkill` do TS). Devolve { name, action, from, to, restored, agente }.
pub fn revert_skill(cardume: &Path, skills_root: &Path, name: &str, reason: &str, at: i64) -> Result<Value, String> {
    let mut h = read_skill_history(cardume, name).ok_or("essa skill não tem versão pra voltar")?;
    let cur = h["current"].as_i64().unwrap_or(0);
    if cur < 1 || h["archived"].as_bool().unwrap_or(false) { return Err("essa skill não tem versão pra voltar".into()); }
    let dir = skill_hist_dir(cardume, name);
    let md = skills_root.join(name).join("SKILL.md");
    let agente = h["versions"].as_array().and_then(|l| l.iter().find(|x| x["v"].as_i64() == Some(cur))).and_then(|x| x["agente"].as_str()).unwrap_or("").to_string();
    let prev = dir.join(format!("v{}.md", cur - 1));
    let to = cur + 1;
    let reason = reason.trim();
    if cur > 1 && prev.is_file() {
        let bytes = std::fs::read(&prev).map_err(|e| e.to_string())?;
        atomic(&md, &bytes)?;
        std::fs::write(dir.join(format!("v{to}.md")), &bytes).map_err(|e| e.to_string())?;
        h["current"] = json!(to);
        h["versions"].as_array_mut().unwrap().push(ventry(to, at, "voltar", reason, "", &agente));
        save_hist(cardume, &h)?;
        return Ok(json!({ "name": name, "action": "restaurada", "from": cur, "to": to, "restored": cur - 1, "agente": agente }));
    }
    if md.is_file() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::rename(&md, dir.join("arquivada.md")).map_err(|e| e.to_string())?;
    }
    h["current"] = json!(to);
    h["archived"] = json!(true);
    h["versions"].as_array_mut().unwrap().push(ventry(to, at, "arquivar", reason, "", &agente));
    save_hist(cardume, &h)?;
    Ok(json!({ "name": name, "action": "arquivada", "from": cur, "to": to, "restored": Value::Null, "agente": agente }))
}


// ---------------------------------------------------------------- P9: memória do agente e arquivar

/// `.cardume/agentes/<id>/lembra.json` = { items:[{ id, kind:"nota", title, body, at, v, taskId, forgottenAt? }] }
/// (≡ `agentMemoryFile`/`readAgentMemory` do TS). Só o app escreve.
pub fn agent_memory_file(cardume: &Path, agent_id: &str) -> PathBuf {
    cardume.join("agentes").join(agent_key(agent_id)).join("lembra.json")
}
pub fn read_agent_memory(cardume: &Path, agent_id: &str) -> Vec<Value> {
    if agent_key(agent_id).is_empty() { return vec![]; }
    read_json(&agent_memory_file(cardume, agent_id)).and_then(|j| j["items"].as_array().cloned()).unwrap_or_default()
}
fn save_agent_memory(cardume: &Path, agent_id: &str, items: Vec<Value>) -> Result<(), String> {
    let out = json!({ "agentId": agent_key(agent_id), "items": items });
    atomic(&agent_memory_file(cardume, agent_id), serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?.as_bytes())
}
/// Guarda uma nota aceita "pra X". Mesmo id de novo = não duplica (aceitar duas vezes não cria duas lembranças).
pub fn add_agent_note(cardume: &Path, agent_id: &str, item: Value) -> Result<(), String> {
    let mut items = read_agent_memory(cardume, agent_id);
    if items.iter().any(|x| x["id"] == item["id"] && x["forgottenAt"].is_null()) { return Ok(()); }
    items.push(item);
    save_agent_memory(cardume, agent_id, items)
}
/// "Esquecer" uma nota: marca `forgottenAt` + motivo (nunca apaga). Devolve o título.
pub fn forget_agent_note(cardume: &Path, agent_id: &str, note_id: &str, reason: &str, at: i64) -> Result<String, String> {
    let mut items = read_agent_memory(cardume, agent_id);
    let it = items.iter_mut().find(|x| x["id"].as_str() == Some(note_id) && x["forgottenAt"].is_null()).ok_or("esse agente não lembra mais disso")?;
    it["forgottenAt"] = json!(at);
    it["forgetReason"] = json!(reason.trim());
    let t = it["title"].as_str().unwrap_or("").to_string();
    save_agent_memory(cardume, agent_id, items)?;
    Ok(t)
}

/// Arquiva uma skill (esquecer): o SKILL.md é MOVIDO pro histórico (`arquivada.md`) e vira versão "arquivar".
/// Sem histórico ainda: os bytes atuais viram a v1 antes (dá pra recuperar).
pub fn archive_skill(cardume: &Path, skills_root: &Path, name: &str, reason: &str, at: i64, agente: &str) -> Result<Value, String> {
    let md = skills_root.join(name).join("SKILL.md");
    if !md.is_file() { return Err("essa skill não está mais ativa".into()); }
    let dir = skill_hist_dir(cardume, name);
    let mut h = match read_skill_history(cardume, name) {
        Some(h) => h,
        None => {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("v1.md"), std::fs::read(&md).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            json!({ "name": name, "current": 1, "archived": false, "versions": [ventry(1, at, "legado", "", "", agente)] })
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let to = h["current"].as_i64().unwrap_or(0) + 1;
    // nome por versão: arquivar de novo (skill recriada com o mesmo nome) nunca sobrescreve o arquivo anterior
    std::fs::rename(&md, dir.join(format!("arquivada-v{to}.md"))).map_err(|e| e.to_string())?;
    h["current"] = json!(to);
    h["archived"] = json!(true);
    h["versions"].as_array_mut().ok_or("histórico inválido")?.push(ventry(to, at, "arquivar", reason.trim(), "", agente));
    save_hist(cardume, &h)?;
    Ok(json!({ "name": name, "action": "arquivada", "to": to }))
}

/// "Restaurar" uma skill arquivada (F4 · P13, ≡ `restoreSkill` do TS): o arquivo guardado no histórico volta BYTE A BYTE
/// pro `SKILL.md` (move de volta — os bytes ficam também em `v<N>.md`) e vira versão nova "restaurar". Devolve
/// { name, action:"restaurada", to, agente } — o dono é o da última versão que tinha dono (quem chama religa no skills.json).
pub fn restore_skill(cardume: &Path, skills_root: &Path, name: &str, at: i64) -> Result<Value, String> {
    let mut h = read_skill_history(cardume, name).ok_or("essa skill não tem histórico pra restaurar")?;
    if !h["archived"].as_bool().unwrap_or(false) { return Err("essa skill não está arquivada".into()); }
    let md = skills_root.join(name).join("SKILL.md");
    if md.exists() { return Err("já existe uma skill ativa com esse nome — arquive ou renomeie ela antes".into()); }
    let dir = skill_hist_dir(cardume, name);
    let cur = h["current"].as_i64().unwrap_or(0);
    let src = [dir.join(format!("arquivada-v{cur}.md")), dir.join("arquivada.md")].into_iter().find(|p| p.is_file())
        .ok_or("não achei o texto arquivado dessa skill no histórico")?;
    let bytes = std::fs::read(&src).map_err(|e| e.to_string())?;
    let to = cur + 1;
    let agente = h["versions"].as_array().and_then(|a| a.iter().rev().find_map(|x| x["agente"].as_str().filter(|s| !s.is_empty()).map(String::from))).unwrap_or_default();
    // os bytes vão pro histórico ANTES de mover: se o move falhar, nada some
    std::fs::write(dir.join(format!("v{to}.md")), &bytes).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(md.parent().unwrap_or(skills_root)).map_err(|e| e.to_string())?;
    std::fs::rename(&src, &md).map_err(|e| e.to_string())?;
    h["current"] = json!(to);
    h["archived"] = json!(false);
    h["versions"].as_array_mut().ok_or("histórico inválido")?.push(ventry(to, at, "restaurar", "", "", &agente));
    save_hist(cardume, &h)?;
    Ok(json!({ "name": name, "action": "restaurada", "to": to, "agente": agente }))
}

/// Arquivar uma nota do agente (curador, F4): igual ao "esquecer" (não vai mais pro prompt — o motor já pula
/// `forgottenAt`), marcada `archived` pra aparecer em "arquivados" com "restaurar". Nunca apaga. Devolve o título.
pub fn archive_agent_note(cardume: &Path, agent_id: &str, note_id: &str, reason: &str, at: i64) -> Result<String, String> {
    let mut items = read_agent_memory(cardume, agent_id);
    let it = items.iter_mut().find(|x| x["id"].as_str() == Some(note_id) && x["forgottenAt"].is_null()).ok_or("esse agente não lembra mais disso")?;
    it["forgottenAt"] = json!(at);
    it["forgetReason"] = json!(reason.trim());
    it["archived"] = json!(true);
    let t = it["title"].as_str().unwrap_or("").to_string();
    save_agent_memory(cardume, agent_id, items)?;
    Ok(t)
}
/// "Restaurar" uma nota esquecida/arquivada: volta a valer (tira `forgottenAt`), guardando quando voltou. Devolve o título.
pub fn restore_agent_note(cardume: &Path, agent_id: &str, note_id: &str, at: i64) -> Result<String, String> {
    let mut items = read_agent_memory(cardume, agent_id);
    if items.iter().any(|x| x["id"].as_str() == Some(note_id) && x["forgottenAt"].is_null()) { return Err("essa nota já está valendo".into()); }
    let it = items.iter_mut().rev().find(|x| x["id"].as_str() == Some(note_id)).ok_or("não achei essa nota no histórico do agente")?;
    if let Some(o) = it.as_object_mut() { o.remove("forgottenAt"); o.remove("forgetReason"); o.remove("archived"); o.insert("restoredAt".into(), json!(at)); }
    let t = it["title"].as_str().unwrap_or("").to_string();
    save_agent_memory(cardume, agent_id, items)?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gold() -> Value {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/ciclo-golden/versoes.json");
        serde_json::from_str(&std::fs::read_to_string(p).expect("fixture")).expect("json")
    }
    fn files(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n != "index.json").collect()).unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn versoes_golden_paridade_com_ts() {
        let d = std::env::temp_dir().join(format!("sf-versoes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let cd = d.join(".cardume");
        let root = d.join(".claude").join("skills");
        for st in gold()["steps"].as_array().unwrap() {
            let op = st["op"].as_str().unwrap();
            let name = st["name"].as_str().unwrap_or("");
            let at = st["at"].as_i64().unwrap_or(0);
            match op {
                "write" => {
                    let v = write_skill_version(&cd, &root, name, st["content"].as_str().unwrap().as_bytes(), at, st["action"].as_str().unwrap(), "", "", st["agente"].as_str().unwrap_or("")).unwrap();
                    assert_eq!(json!(v), st["result"], "{op} {name}");
                }
                "legacy" => {
                    std::fs::create_dir_all(root.join(name)).unwrap();
                    std::fs::write(root.join(name).join("SKILL.md"), st["content"].as_str().unwrap()).unwrap();
                }
                "revert" => {
                    let r = revert_skill(&cd, &root, name, st["reason"].as_str().unwrap(), at).unwrap();
                    assert_eq!(r, st["result"], "{op} {name}");
                }
                "agent" => {
                    let v = bump_agent(&cd, st["agentId"].as_str().unwrap(), at, st["change"].as_str().unwrap(), st["what"].as_str().unwrap(), st["persona"].as_str(), st["before"].as_str()).unwrap();
                    assert_eq!(json!(v), st["result"]);
                    assert_eq!(read_agent_versions(&cd, st["agentId"].as_str().unwrap()), st["expect"]["agent"]);
                }
                _ => panic!("op {op}"),
            }
            if !name.is_empty() {
                let md = root.join(name).join("SKILL.md");
                let got = std::fs::read(&md).ok();
                match st["expect"]["skill"].as_str() {
                    Some(s) => assert_eq!(got.as_deref(), Some(s.as_bytes()), "byte a byte: {op} {name}"),
                    None => assert!(got.is_none(), "{op} {name}: sem SKILL.md"),
                }
                assert_eq!(read_skill_history(&cd, name).unwrap_or(Value::Null), st["expect"]["history"], "{op} {name}");
                let want: Vec<String> = st["expect"]["files"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
                assert_eq!(files(&skill_hist_dir(&cd, name)), want, "{op} {name}");
            }
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// F4 · P13: o MESMO roteiro de arquivar/restaurar do TS (`tests/fixtures/ciclo-golden/curador.json`).
    #[test]
    fn curador_golden_paridade_com_ts() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/ciclo-golden/curador.json");
        let g: Value = serde_json::from_str(&std::fs::read_to_string(p).expect("fixture")).expect("json");
        let d = std::env::temp_dir().join(format!("sf-curgold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let cd = d.join(".cardume");
        let root = d.join(".claude").join("skills");
        for st in g["steps"].as_array().unwrap() {
            let op = st["op"].as_str().unwrap();
            let name = st["name"].as_str().unwrap_or("");
            let at = st["at"].as_i64().unwrap_or(0);
            match op {
                "write" => { let v = write_skill_version(&cd, &root, name, st["content"].as_str().unwrap().as_bytes(), at, st["action"].as_str().unwrap(), "", "", st["agente"].as_str().unwrap_or("")).unwrap(); assert_eq!(json!(v), st["result"]); }
                "archive" => { let r = archive_skill(&cd, &root, name, st["reason"].as_str().unwrap_or(""), at, st["agente"].as_str().unwrap_or("")).unwrap(); assert_eq!(r, st["result"], "{op}"); }
                "restore" => match restore_skill(&cd, &root, name, at) { Ok(r) => assert_eq!(r, st["result"], "{op}"), Err(_) => assert_eq!(st["result"], json!({ "error": true }), "{op}") },
                "legacy" => { std::fs::create_dir_all(root.join(name)).unwrap(); std::fs::write(root.join(name).join("SKILL.md"), st["content"].as_str().unwrap()).unwrap(); }
                _ => panic!("op {op}"),
            }
            let got = std::fs::read(root.join(name).join("SKILL.md")).ok();
            match st["expect"]["skill"].as_str() {
                Some(s) => assert_eq!(got.as_deref(), Some(s.as_bytes()), "byte a byte: {op}"),
                None => assert!(got.is_none(), "{op}: sem SKILL.md"),
            }
            assert_eq!(read_skill_history(&cd, name).unwrap_or(Value::Null), st["expect"]["history"], "{op}");
            let want: Vec<String> = st["expect"]["files"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            assert_eq!(files(&skill_hist_dir(&cd, name)), want, "{op}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn nota_arquivada_volta_com_restaurar() {
        let d = std::env::temp_dir().join(format!("sf-curnota-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let cd = d.join(".cardume");
        add_agent_note(&cd, "nyx", json!({ "id": "a", "kind": "nota", "title": "Citar fonte", "body": "b", "at": 1, "v": 2, "taskId": "x" })).unwrap();
        assert_eq!(archive_agent_note(&cd, "nyx", "a", "sem uso há 30 dias", 5).unwrap(), "Citar fonte");
        let m = read_agent_memory(&cd, "nyx");
        assert_eq!(m.len(), 1, "arquivar nunca apaga");
        assert_eq!(m[0]["archived"], true);
        assert_eq!(m[0]["forgottenAt"], 5);
        assert!(archive_agent_note(&cd, "nyx", "a", "", 6).is_err(), "arquivar 2× é erro em palavra");
        assert_eq!(restore_agent_note(&cd, "nyx", "a", 7).unwrap(), "Citar fonte");
        let m = read_agent_memory(&cd, "nyx");
        assert!(m[0]["forgottenAt"].is_null() && m[0]["archived"].is_null());
        assert_eq!(m[0]["restoredAt"], 7);
        assert_eq!(m[0]["body"], "b", "o texto volta igual");
        assert!(restore_agent_note(&cd, "nyx", "a", 8).unwrap_err().contains("já está valendo"));
        assert!(restore_agent_note(&cd, "nyx", "zz", 8).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn voltar_sem_historico_e_erro_em_palavra() {
        let d = std::env::temp_dir().join(format!("sf-versoes-x-{}", std::process::id()));
        let e = revert_skill(&d.join(".cardume"), &d.join("s"), "nada", "x", 1).unwrap_err();
        assert!(e.contains("não tem versão"));
        assert_eq!(agent_version(&d.join(".cardume"), "nyx"), 1);
    }
}
