//! CURADOR SEM IA (F4 · P13 da decisão da mesa de 03/10): o passo "Curar e voltar" do ciclo Hermes.
//! Aqui só a parte de ARQUIVO/BANCO — quem decide o que sugerir é a função pura `curSuggest` do app (62-curador.js,
//! testada em node): o Rust entrega os itens (skills aprendidas ativas + notas dos agentes), o USO (eventos `papel` dos
//! últimos N dias — a lista "skills ativas: a@v3 · nyx@v4 · …" que o motor grava no início de cada papel) e guarda o
//! resultado do dia em `.cardume/aprendizado/curador.json` (no máximo 1 rodada por dia, sem laço nem timer).
//! Arquivar = mover pro histórico (nunca apagar) e restaurar volta byte a byte; item com agente dono = versão nova dele.

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;

use super::{repo_or, AppState};
use crate::{agent_versions, learn};

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
pub fn state_path(repo: &Path) -> PathBuf {
    repo.join(".cardume").join("aprendizado").join("curador.json")
}
fn skills_root(repo: &Path) -> PathBuf { repo.join(".claude").join("skills") }

/// Linha `description:` do frontmatter (aspas tiradas) — pra religar a skill restaurada no skills.json.
pub fn fm_description(text: &str) -> String {
    let src = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Some(fm) = src.strip_prefix("---\n").and_then(|rest| rest.find("\n---").map(|i| rest[..i].to_string())) else { return String::new() };
    fm.lines().find_map(|l| l.strip_prefix("description:").map(|v| v.trim().trim_matches('"').trim_matches('\'').to_string())).unwrap_or_default()
}

fn skills_json(repo: &Path) -> Vec<Value> {
    std::fs::read_to_string(repo.join(".cardume").join("skills.json")).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

/// Itens que o curador olha: skills APRENDIDAS ativas (skills.json + SKILL.md com `origem: aprendida` — skill do usuário
/// fica fora) e notas ATIVAS da memória de cada agente. `at` = quando a versão atual entrou (aceite).
pub fn items(repo: &Path) -> Vec<Value> {
    let cd = repo.join(".cardume");
    let mut out = vec![];
    for x in skills_json(repo) {
        let name = x["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() { continue; }
        let md = skills_root(repo).join(&name).join("SKILL.md");
        let Ok(txt) = std::fs::read_to_string(&md) else { continue };
        if !learn::skill_meta(&txt).0 { continue; }
        let hist = agent_versions::read_skill_history(&cd, &name);
        let at = hist.as_ref().and_then(|h| {
            let cur = h["current"].as_i64().unwrap_or(0);
            h["versions"].as_array().and_then(|a| a.iter().find(|v| v["v"].as_i64() == Some(cur)).and_then(|v| v["at"].as_i64()))
        }).or_else(|| std::fs::metadata(&md).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)).unwrap_or(0);
        let owner = agent_versions::agent_key(x["agente"].as_str().unwrap_or(""));
        let owner = if owner.is_empty() { learn::skill_owner(&txt) } else { owner };
        let desc = x["description"].as_str().map(String::from).unwrap_or_else(|| fm_description(&txt));
        out.push(json!({ "kind": "skill", "key": name, "owner": owner, "title": name, "desc": desc, "text": format!("{desc}\n{}", learn::skill_body(&txt)), "at": at }));
    }
    if let Ok(rd) = std::fs::read_dir(cd.join("agentes")) {
        let mut ids: Vec<String> = rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        ids.sort();
        for id in ids {
            for n in agent_versions::read_agent_memory(&cd, &id) {
                if !n["forgottenAt"].is_null() { continue; }
                let title = n["title"].as_str().unwrap_or("").to_string();
                out.push(json!({ "kind": "nota", "key": n["id"], "owner": id, "title": title, "text": format!("{title}\n{}", n["body"].as_str().unwrap_or("")), "at": n["restoredAt"].as_i64().or(n["at"].as_i64()).unwrap_or(0) }));
            }
        }
    }
    out
}

/// O que está no histórico e pode voltar: skills arquivadas (índice com `archived`) e notas esquecidas/arquivadas.
pub fn archived(repo: &Path) -> Vec<Value> {
    let cd = repo.join(".cardume");
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(cd.join("aprendizado").join("historico")) {
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for name in names {
            let Some(h) = agent_versions::read_skill_history(&cd, &name) else { continue };
            if !h["archived"].as_bool().unwrap_or(false) { continue; }
            let vs = h["versions"].as_array().cloned().unwrap_or_default();
            let last = vs.last().cloned().unwrap_or(Value::Null);
            let owner = vs.iter().rev().find_map(|x| x["agente"].as_str().filter(|s| !s.is_empty()).map(String::from)).unwrap_or_default();
            out.push(json!({ "kind": "skill", "key": name, "owner": owner, "title": name, "at": last["at"], "reason": last["reason"] }));
        }
    }
    if let Ok(rd) = std::fs::read_dir(cd.join("agentes")) {
        let mut ids: Vec<String> = rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        ids.sort();
        for id in ids {
            let mem = agent_versions::read_agent_memory(&cd, &id);
            let mut seen: Vec<Value> = vec![];
            for n in mem.iter().rev() {
                if n["forgottenAt"].is_null() { continue; }
                // mesma nota reaceita depois (mesmo id ativo): a versão esquecida não volta; esquecida 2× = 1 linha (a última)
                if mem.iter().any(|m| m["id"] == n["id"] && m["forgottenAt"].is_null()) || seen.contains(&n["id"]) { continue; }
                seen.push(n["id"].clone());
                out.push(json!({ "kind": "nota", "key": n["id"], "owner": id, "title": n["title"], "at": n["forgottenAt"], "reason": n["forgetReason"], "archived": n["archived"].as_bool().unwrap_or(false) }));
            }
        }
    }
    out
}

/// Uso: os textos DISTINTOS dos eventos `papel` desde `since` (ms), com o agente e o último horário. Sem banco/coluna = [].
pub fn usage(repo: &Path, since: i64) -> Vec<Value> {
    let db = repo.join(".cardume").join("state.sqlite");
    if !db.exists() { return vec![]; }
    let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(3000));
    let Ok(mut st) = conn.prepare("SELECT COALESCE(agent_id, ''), text, MAX(ts) FROM event WHERE type = 'papel' AND ts >= ?1 GROUP BY agent_id, text") else { return vec![] };
    let rows = st.query_map([since], |r| Ok(json!({ "agentId": r.get::<_, String>(0)?, "text": r.get::<_, String>(1)?, "ts": r.get::<_, i64>(2)? })));
    match rows { Ok(r) => r.flatten().collect(), Err(_) => vec![] }
}

fn read_state(repo: &Path) -> Value {
    std::fs::read_to_string(state_path(repo)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or(Value::Null)
}
fn write_state(repo: &Path, v: &Value) -> Result<(), String> {
    let p = state_path(repo);
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = p.with_extension(format!("json.{}.{nanos}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Arquiva um item (o humano confirmou). skill: tira do skills.json e MOVE o SKILL.md pro histórico; nota: marca
/// arquivada (o motor já não injeta). Com dono = versão nova do agente ("arquivar").
pub fn archive(repo: &Path, kind: &str, key: &str, owner: &str, reason: &str) -> Result<Value, String> {
    let cd = repo.join(".cardume");
    let ag = agent_versions::agent_key(owner);
    let at = now_ms();
    if kind != "skill" && kind != "nota" { return Err("tipo de aprendizado desconhecido".into()); }
    let what = if kind == "skill" {
        let n = learn::skill_name(key);
        if n.is_empty() { return Err("skill sem nome".into()); }
        let md = skills_root(repo).join(&n).join("SKILL.md");
        let txt = std::fs::read_to_string(&md).map_err(|_| "essa skill não está mais ativa".to_string())?;
        if !learn::skill_meta(&txt).0 { return Err("só dá pra arquivar skill aprendida — as suas skills ficam como estão".into()); }
        // o dono é o do SKILL.md; sem linha `agente:` vale o do skills.json (o mesmo que `items()` mostrou)
        let entry = skills_json(repo).into_iter().find(|x| x["name"].as_str() == Some(n.as_str())).unwrap_or(Value::Null);
        let owner = { let o = learn::skill_owner(&txt); if o.is_empty() { agent_versions::agent_key(entry["agente"].as_str().unwrap_or("")) } else { o } };
        if owner != ag { return Err("essa skill não é desse agente".into()); }
        learn::disable_skill(repo, &n)?;
        if let Err(e) = agent_versions::archive_skill(&cd, &skills_root(repo), &n, reason, at, &ag) {
            // desfaz: a skill volta a valer (nunca fica "nem ativa nem arquivada")
            let desc = entry["description"].as_str().map(String::from).unwrap_or_else(|| fm_description(&txt));
            let _ = learn::enable_skill_as(repo, &n, &desc, &owner);
            return Err(e);
        }
        format!("arquivou a skill {n}")
    } else {
        if ag.is_empty() { return Err("nota sem agente dono — não dá pra arquivar por aqui".into()); }
        format!("arquivou: {}", agent_versions::archive_agent_note(&cd, &ag, key, reason, at)?)
    };
    let v = if ag.is_empty() { Value::Null } else { json!(agent_versions::bump_agent(&cd, &ag, at, "arquivar", &what, None, None)?) };
    Ok(json!({ "kind": kind, "key": key, "agente": ag, "agentVersion": v }))
}

/// Restaura o que foi arquivado/esquecido: volta byte a byte e vira versão nova ("restaurar"). skill volta pro skills.json com o dono.
pub fn restore(repo: &Path, kind: &str, key: &str, owner: &str) -> Result<Value, String> {
    let cd = repo.join(".cardume");
    let at = now_ms();
    if kind != "skill" && kind != "nota" { return Err("tipo de aprendizado desconhecido".into()); }
    let (ag, what) = if kind == "skill" {
        let n = learn::skill_name(key);
        if n.is_empty() { return Err("skill sem nome".into()); }
        let r = agent_versions::restore_skill(&cd, &skills_root(repo), &n, at)?;
        let txt = std::fs::read_to_string(skills_root(repo).join(&n).join("SKILL.md")).unwrap_or_default();
        let ag = { let o = learn::skill_owner(&txt); if o.is_empty() { agent_versions::agent_key(r["agente"].as_str().unwrap_or("")) } else { o } };
        if let Err(e) = learn::enable_skill_as(repo, &n, &fm_description(&txt), &ag) {
            // desfaz: volta pro arquivo (nunca fica SKILL.md solto fora do skills.json)
            let _ = agent_versions::archive_skill(&cd, &skills_root(repo), &n, "restaurar falhou", at, &ag);
            return Err(e);
        }
        (ag, format!("restaurou a skill {n}"))
    } else {
        let ag = agent_versions::agent_key(owner);
        if ag.is_empty() { return Err("nota sem agente dono".into()); }
        (ag.clone(), format!("restaurou: {}", agent_versions::restore_agent_note(&cd, &ag, key, at)?))
    };
    let v = if ag.is_empty() { Value::Null } else { json!(agent_versions::bump_agent(&cd, &ag, at, "restaurar", &what, None, None)?) };
    Ok(json!({ "kind": kind, "key": key, "agente": ag, "agentVersion": v }))
}

/// O resultado guardado (`{ at, suggestions, dismissed }`) — barato: só lê um arquivo. O app decide se está vencido (≥ 24 h).
#[tauri::command(async)]
pub fn curator_state(state: State<AppState>, repo: Option<String>) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    Ok(read_state(&repo))
}
/// Entradas de uma rodada nova: itens, uso dos últimos `days` dias (padrão 30) e o que está arquivado. Só quando a rodada venceu.
#[tauri::command(async)]
pub fn curator_inputs(state: State<AppState>, repo: Option<String>, days: Option<i64>) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    let now = now_ms();
    let since = now - days.unwrap_or(30).clamp(1, 365) * DAY_MS;
    Ok(json!({ "now": now, "since": since, "items": items(&repo), "usage": usage(&repo, since), "archived": archived(&repo) }))
}
/// Só o que está arquivado (pra lista "arquivados" com restaurar) — lido ao abrir, sem banco.
#[tauri::command(async)]
pub fn curator_archived(state: State<AppState>, repo: Option<String>) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    Ok(json!(archived(&repo)))
}
#[tauri::command(async)]
pub fn curator_save(state: State<AppState>, repo: Option<String>, data: Value) -> Result<(), String> {
    let repo = repo_or(&state, repo)?;
    if !data.is_object() { return Err("estado do curador inválido".into()); }
    write_state(&repo, &data)
}
#[tauri::command(async)]
pub fn curator_archive(state: State<AppState>, repo: Option<String>, kind: String, key: String, owner: Option<String>, reason: Option<String>) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    archive(&repo, &kind, &key, owner.as_deref().unwrap_or(""), reason.as_deref().unwrap_or(""))
}
#[tauri::command(async)]
pub fn curator_restore(state: State<AppState>, repo: Option<String>, kind: String, key: String, owner: Option<String>) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    restore(&repo, &kind, &key, owner.as_deref().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-curador-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        d
    }
    fn learned(repo: &Path, name: &str, owner: &str, body: &str) {
        let root = skills_root(repo);
        agent_versions::write_skill_version(&repo.join(".cardume"), &root, name, learn::skill_md_as(name, "desc de teste", &[], body, owner).as_bytes(), 1000, "criar", "", "t1", owner).unwrap();
        learn::enable_skill_as(repo, name, "desc de teste", owner).unwrap();
    }

    #[test]
    fn itens_so_aprendidas_e_notas_ativas() {
        let r = repo("itens");
        learned(&r, "menor-diff", "nyx", "Mude o mínimo.");
        // skill do usuário ligada no skills.json: fora do curador
        std::fs::create_dir_all(skills_root(&r).join("minha")).unwrap();
        std::fs::write(skills_root(&r).join("minha").join("SKILL.md"), "---\nname: minha\ndescription: x\n---\n\ncorpo\n").unwrap();
        learn::enable_skill_as(&r, "minha", "x", "").unwrap();
        let cd = r.join(".cardume");
        agent_versions::add_agent_note(&cd, "lumen", json!({ "id": "n1", "kind": "nota", "title": "Citar fonte", "body": "com link", "at": 5, "v": 2, "taskId": "t" })).unwrap();
        agent_versions::add_agent_note(&cd, "lumen", json!({ "id": "n2", "kind": "nota", "title": "Velha", "body": "x", "at": 6, "v": 3, "taskId": "t" })).unwrap();
        agent_versions::forget_agent_note(&cd, "lumen", "n2", "", 7).unwrap();
        let it = items(&r);
        assert_eq!(it.len(), 2, "{it:?}");
        assert_eq!(it[0]["key"], "menor-diff");
        assert_eq!(it[0]["owner"], "nyx");
        assert_eq!(it[0]["at"], 1000);
        assert!(it[0]["text"].as_str().unwrap().contains("Mude o mínimo."));
        assert_eq!(it[1]["key"], "n1");
        assert_eq!(it[1]["owner"], "lumen");
        assert_eq!(archived(&r).len(), 1, "a esquecida aparece pra restaurar");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn arquivar_e_restaurar_skill_volta_byte_a_byte_com_dono_e_versao() {
        let r = repo("skill");
        learned(&r, "menor-diff", "nyx", "Mude o mínimo.");
        let md = skills_root(&r).join("menor-diff").join("SKILL.md");
        let before = std::fs::read(&md).unwrap();
        assert!(archive(&r, "skill", "menor-diff", "lumen", "x").unwrap_err().contains("não é desse agente"));
        let a = archive(&r, "skill", "menor-diff", "nyx", "sem uso há 30 dias").unwrap();
        assert_eq!(a["agentVersion"], 2);
        assert!(!md.exists(), "saiu das próximas tarefas");
        assert!(skills_json(&r).iter().all(|x| x["name"] != "menor-diff"), "fora do skills.json");
        assert!(items(&r).is_empty());
        let arq = archived(&r);
        assert_eq!(arq.len(), 1);
        assert_eq!(arq[0]["owner"], "nyx");
        assert_eq!(arq[0]["reason"], "sem uso há 30 dias");
        let b = restore(&r, "skill", "menor-diff", "").unwrap();
        assert_eq!(b["agente"], "nyx");
        assert_eq!(b["agentVersion"], 3);
        assert_eq!(std::fs::read(&md).unwrap(), before, "byte a byte");
        let sj = skills_json(&r);
        let hit = sj.iter().find(|x| x["name"] == "menor-diff").unwrap();
        assert_eq!(hit["agente"], "nyx");
        assert_eq!(hit["description"], "desc de teste");
        assert!(archived(&r).is_empty());
        let vs = agent_versions::read_agent_versions(&r.join(".cardume"), "nyx");
        let ch: Vec<&str> = vs["versions"].as_array().unwrap().iter().map(|x| x["change"].as_str().unwrap()).collect();
        assert_eq!(ch, vec!["arquivar", "restaurar"]);
        assert!(restore(&r, "skill", "menor-diff", "").unwrap_err().contains("não está arquivada"));
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn dono_so_no_skills_json_tipo_invalido_e_nota_esquecida_duas_vezes() {
        let r = repo("borda");
        // SKILL.md aprendido SEM linha agente, dono só no skills.json: arquivar pelo dono funciona
        std::fs::create_dir_all(skills_root(&r).join("velha")).unwrap();
        std::fs::write(skills_root(&r).join("velha").join("SKILL.md"), learn::skill_md("velha", "d", &[], "corpo")).unwrap();
        learn::enable_skill_as(&r, "velha", "d", "nyx").unwrap();
        assert_eq!(items(&r)[0]["owner"], "nyx");
        archive(&r, "skill", "velha", "nyx", "").unwrap();
        assert!(archive(&r, "outro", "x", "nyx", "").unwrap_err().contains("tipo"));
        assert!(restore(&r, "outro", "x", "nyx").unwrap_err().contains("tipo"));
        assert!(archive(&r, "skill", "!!!", "", "").unwrap_err().contains("sem nome"));
        let cd = r.join(".cardume");
        for at in [5, 9] {
            agent_versions::add_agent_note(&cd, "lumen", json!({ "id": "n1", "kind": "nota", "title": "T", "body": "b", "at": at, "v": 2, "taskId": "t" })).unwrap();
            agent_versions::forget_agent_note(&cd, "lumen", "n1", "", at + 1).unwrap();
        }
        let notes: Vec<Value> = archived(&r).into_iter().filter(|x| x["kind"] == "nota").collect();
        assert_eq!(notes.len(), 1, "esquecida 2× = uma linha só");
        assert_eq!(notes[0]["at"], 10, "a última");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn skill_do_usuario_nunca_e_arquivada() {
        let r = repo("user");
        std::fs::create_dir_all(skills_root(&r).join("minha")).unwrap();
        std::fs::write(skills_root(&r).join("minha").join("SKILL.md"), "---\nname: minha\n---\n\ncorpo\n").unwrap();
        assert!(archive(&r, "skill", "minha", "", "").unwrap_err().contains("só dá pra arquivar skill aprendida"));
        assert!(skills_root(&r).join("minha").join("SKILL.md").exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn arquivar_e_restaurar_nota_do_agente() {
        let r = repo("nota");
        let cd = r.join(".cardume");
        agent_versions::add_agent_note(&cd, "lumen", json!({ "id": "n1", "kind": "nota", "title": "Citar fonte", "body": "com link", "at": 5, "v": 2, "taskId": "t" })).unwrap();
        assert!(archive(&r, "nota", "n1", "", "x").is_err(), "sem dono = erro em palavra");
        archive(&r, "nota", "n1", "lumen", "parecida com «Fonte sempre»").unwrap();
        assert!(items(&r).is_empty());
        let arq = archived(&r);
        assert_eq!(arq[0]["archived"], true);
        restore(&r, "nota", "n1", "lumen").unwrap();
        assert_eq!(items(&r).len(), 1);
        assert!(archived(&r).is_empty());
        assert_eq!(agent_versions::agent_version(&cd, "lumen"), 3);
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn uso_le_os_papeis_da_janela_e_estado_do_dia() {
        let r = repo("uso");
        assert!(usage(&r, 0).is_empty(), "sem banco = sem uso, nunca erro");
        let c = Connection::open(r.join(".cardume").join("state.sqlite")).unwrap();
        c.execute_batch("CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, agent TEXT, role TEXT, ts INTEGER, type TEXT, text TEXT, ok INTEGER, agent_id TEXT);
            INSERT INTO event (task_id,agent,ts,type,text,agent_id) VALUES ('t1','Nyx',100,'papel','skills ativas: a@v1 · nyx@v2 · claude','nyx');
            INSERT INTO event (task_id,agent,ts,type,text,agent_id) VALUES ('t2','Nyx',300,'papel','skills ativas: a@v1 · nyx@v2 · claude','nyx');
            INSERT INTO event (task_id,agent,ts,type,text,agent_id) VALUES ('t2','Nyx',50,'papel','skills ativas: velha@v1 · nyx@v1 · claude','nyx');
            INSERT INTO event (task_id,agent,ts,type,text,agent_id) VALUES ('t2','Nyx',400,'note','x','nyx');").unwrap();
        drop(c);
        let u = usage(&r, 80);
        assert_eq!(u.len(), 1, "distintos, só da janela, só papel");
        assert_eq!(u[0]["ts"], 300);
        assert_eq!(read_state(&r), Value::Null);
        write_state(&r, &json!({ "at": 1, "suggestions": [] })).unwrap();
        assert_eq!(read_state(&r)["at"], 1);
        let _ = std::fs::remove_dir_all(&r);
    }
}
