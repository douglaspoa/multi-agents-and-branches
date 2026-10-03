//! BOLETIM DO AGENTE (F3 · P8 da mesa de 03/10): UMA query agregada (`agent_stats.sql`) devolve uma linha por
//! (agente, tarefa) — custo dele, retrabalhos, vereditos "muda", rodadas de revisão, status e PR. As regras de
//! exibição (n à vista, "ainda conhecendo" abaixo de 10, % só com n ≥ 10) ficam na função pura `agStatsView` do app.
//! Assíncrono (comando `async`), calculado só ao abrir a aba — nada de laço nem timer.

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;

use super::{repo_or, AppState};
use crate::{agent_versions, learn};

pub const AGENT_STATS_SQL: &str = include_str!("agent_stats.sql");

/// As linhas do boletim (todas as do agente, ou de todos com `agent = None`).
pub fn stats_rows(conn: &Connection, agent: Option<&str>) -> Result<Vec<Value>, String> {
    let mut st = conn.prepare_cached(AGENT_STATS_SQL).map_err(|e| e.to_string())?;
    let rows = st
        .query_map([agent], |r| {
            Ok(json!({
                "agentId": r.get::<_, String>(0)?,
                "taskId": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "status": r.get::<_, String>(3)?,
                "createdAt": r.get::<_, i64>(4)?,
                "role": r.get::<_, String>(5)?,
                "usd": r.get::<_, f64>(6)?,
                "reworks": r.get::<_, i64>(7)?,
                "muda": r.get::<_, i64>(8)?,
                "rounds": r.get::<_, i64>(9)?,
                "kind": r.get::<_, Option<String>>(10)?,
                "prUrl": r.get::<_, Option<String>>(11)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Banco sem as colunas/tabelas novas (projeto que nunca rodou depois da F0) = boletim vazio, nunca erro na tela.
pub fn stats_in(repo: &Path, agent: Option<&str>) -> Result<Value, String> {
    let db = repo.join(".cardume").join("state.sqlite");
    if !db.exists() { return Ok(json!({ "rows": [], "ms": 0, "lembra": lembra_counts(repo) })); }
    let t0 = std::time::Instant::now();
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(3000));
    let rows = match stats_rows(&conn, agent) {
        Ok(r) => r,
        Err(e) if e.contains("no such column") || e.contains("no such table") => vec![],
        Err(e) => return Err(e),
    };
    Ok(json!({ "rows": rows, "ms": t0.elapsed().as_millis() as u64, "lembra": lembra_counts(repo) }))
}

/// "lembra N coisas" de cada agente: notas ativas da memória dele + skills com ele de dono no skills.json.
pub fn lembra_counts(repo: &Path) -> Value {
    let cd = repo.join(".cardume");
    let mut out = serde_json::Map::new();
    let mut add = |id: &str, n: i64| { if id.is_empty() || n == 0 { return; } let e = out.entry(id.to_string()).or_insert(json!(0)); *e = json!(e.as_i64().unwrap_or(0) + n); };
    if let Ok(rd) = std::fs::read_dir(cd.join("agentes")) {
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            let n = agent_versions::read_agent_memory(&cd, &id).iter().filter(|x| x["forgottenAt"].is_null()).count() as i64;
            add(&id, n);
        }
    }
    let arr: Vec<Value> = std::fs::read_to_string(cd.join("skills.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    for x in arr { add(&agent_versions::agent_key(x["agente"].as_str().unwrap_or("")), 1); }
    Value::Object(out)
}

#[tauri::command(async)]
pub fn agent_stats(state: State<AppState>, repo: Option<String>, agent_id: Option<String>) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    let a = agent_id.filter(|x| !x.trim().is_empty());
    stats_in(&repo, a.as_deref())
}

/// O resto da ficha (fora do banco): versões do agente e o que ele lembra. Lido ao abrir a ficha.
#[tauri::command(async)]
pub fn agent_card(state: State<AppState>, repo: Option<String>, agent_id: String) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    let cd = repo.join(".cardume");
    Ok(json!({
        "versions": agent_versions::read_agent_versions(&cd, &agent_id),
        "learnings": learn::learnings(&repo, &agent_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Banco com o schema do motor (src/store.ts) + `n` tarefas: 3 agentes por tarefa, ~30 eventos e 3 custos cada.
    pub fn seed(db: &Path, n: usize) {
        let c = Connection::open(db).unwrap();
        c.execute_batch(
            "CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL, agent TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'builder', roles_json TEXT NOT NULL DEFAULT '[]', branch TEXT NOT NULL, worktree TEXT NOT NULL, base TEXT NOT NULL, engine TEXT NOT NULL, model TEXT, spec_json TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, ts INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, ok INTEGER, agent_id TEXT);
             CREATE TABLE cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0, agent_id TEXT);
             CREATE INDEX ev_task ON event(task_id, id); CREATE INDEX cost_task ON cost(task_id);
             CREATE INDEX cost_agent ON cost(agent_id); CREATE INDEX ev_agent ON event(agent_id, type);",
        ).unwrap();
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..n {
            let id = format!("t{i}");
            let st = ["review", "merged", "running", "error", "done"][i % 5];
            tx.execute("INSERT INTO task (id,title,objective,status,agent,branch,worktree,base,engine,spec_json,created_at) VALUES (?1,?2,'o',?3,'Íris','b','w','main','claude',?4,?5)",
                rusqlite::params![id, format!("Tarefa {i}"), st, if i == 7 { "{quebrado".to_string() } else { format!("{{\"taskKind\":\"codigo\"{}}}", if i % 3 == 0 { ",\"prUrl\":\"https://x/pull/1\"" } else { "" }) }, i as i64]).unwrap();
            for (ag, nm, role) in [("vega", "Vega", "planner"), ("iris", "Íris", "builder"), ("nyx", "Nyx", "reviewer")] {
                tx.execute("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?1,?2,?3,1,'papel','skills ativas: — · x@v1 · claude',1,?4)", rusqlite::params![id, nm, role, ag]).unwrap();
                for k in 0..8 { tx.execute("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?1,?2,?3,?4,'note','trabalhando',1,?5)", rusqlite::params![id, nm, role, k, ag]).unwrap(); }
                tx.execute("INSERT INTO cost (task_id,agent,role,usd,in_tok,out_tok,created_at,agent_id) VALUES (?1,?2,?3,0.1,1,1,1,?4)", rusqlite::params![id, nm, role, ag]).unwrap();
            }
            if i % 4 == 0 { tx.execute("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?1,'Nyx','reviewer',2,'veredito','rodada 1: muda',0,'nyx')", rusqlite::params![id]).unwrap(); }
            tx.execute("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?1,'Nyx','reviewer',3,'veredito','rodada 2: aprova',1,'nyx')", rusqlite::params![id]).unwrap();
            if i % 6 == 0 { tx.execute("INSERT INTO event (task_id,agent,ts,type,text,ok) VALUES (?1,'Íris',4,'note','rework: aplicando ajuste pelo time inteiro — \"x\"',1)", rusqlite::params![id]).unwrap(); }
            // linha antiga, sem agent_id: não entra em ficha nenhuma
            tx.execute("INSERT INTO cost (task_id,agent,role,usd,in_tok,out_tok,created_at) VALUES (?1,'Íris','builder',9,1,1,1)", rusqlite::params![id]).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn agent_stats_500_tarefas_abaixo_de_150ms_numa_query() {
        let d = std::env::temp_dir().join(format!("sf-agstats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        seed(&d.join(".cardume").join("state.sqlite"), 500);
        let t0 = std::time::Instant::now();
        let all = stats_in(&d, None).unwrap();
        let ms_all = t0.elapsed().as_millis();
        let t1 = std::time::Instant::now();
        let nyx = stats_in(&d, Some("nyx")).unwrap();
        let ms_one = t1.elapsed().as_millis();
        eprintln!("agent_stats: todos {ms_all} ms ({} linhas) · nyx {ms_one} ms", all["rows"].as_array().unwrap().len());
        assert!(ms_all < 150 && ms_one < 150, "agent_stats lento: todos {ms_all} ms, um {ms_one} ms");
        assert_eq!(all["rows"].as_array().unwrap().len(), 1500);
        let rows = nyx["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 500);
        let r0 = rows.iter().find(|r| r["taskId"] == "t0").unwrap();
        assert_eq!(r0["rounds"], 2);
        assert_eq!(r0["muda"], 1);
        assert_eq!(r0["reworks"], 1);
        assert!((r0["usd"].as_f64().unwrap() - 0.1).abs() < 1e-9, "custo sem agent_id não entra");
        assert_eq!(r0["prUrl"], "https://x/pull/1");
        let r7 = rows.iter().find(|r| r["taskId"] == "t7").unwrap();
        assert!(r7["kind"].is_null(), "spec quebrado não derruba a query");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sem_banco_ou_sem_coluna_e_boletim_vazio() {
        let d = std::env::temp_dir().join(format!("sf-agstats-x-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        assert_eq!(stats_in(&d, Some("nyx")).unwrap()["rows"], json!([]));
        // "lembra N coisas": nota ativa + skill com dono (a esquecida não conta)
        let cd = d.join(".cardume");
        agent_versions::add_agent_note(&cd, "nyx", json!({ "id": "a", "kind": "nota", "title": "t", "body": "b", "at": 1, "v": 2, "taskId": "x" })).unwrap();
        agent_versions::add_agent_note(&cd, "nyx", json!({ "id": "b", "kind": "nota", "title": "t2", "body": "b", "at": 1, "v": 3, "taskId": "x" })).unwrap();
        agent_versions::forget_agent_note(&cd, "nyx", "b", "", 2).unwrap();
        std::fs::write(cd.join("skills.json"), r#"[{"name":"x","agente":"nyx"},{"name":"y"}]"#).unwrap();
        assert_eq!(lembra_counts(&d), json!({ "nyx": 2 }));
        let c = Connection::open(d.join(".cardume").join("state.sqlite")).unwrap();
        c.execute_batch("CREATE TABLE task (id TEXT, title TEXT, status TEXT, created_at INTEGER, spec_json TEXT); CREATE TABLE event (id INTEGER, task_id TEXT, type TEXT, text TEXT, ok INTEGER, role TEXT); CREATE TABLE cost (task_id TEXT, usd REAL, role TEXT);").unwrap();
        drop(c);
        assert_eq!(stats_in(&d, None).unwrap()["rows"], json!([]));
        let _ = std::fs::remove_dir_all(&d);
    }
}
