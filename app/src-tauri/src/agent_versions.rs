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
#[allow(dead_code)] // usada pela ficha do agente (F3); paridade com `skillVersion` do TS
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

    #[test]
    fn voltar_sem_historico_e_erro_em_palavra() {
        let d = std::env::temp_dir().join(format!("sf-versoes-x-{}", std::process::id()));
        let e = revert_skill(&d.join(".cardume"), &d.join("s"), "nada", "x", 1).unwrap_err();
        assert!(e.contains("não tem versão"));
        assert_eq!(agent_version(&d.join(".cardume"), "nyx"), 1);
    }
}
