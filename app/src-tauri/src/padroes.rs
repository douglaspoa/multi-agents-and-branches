//! PADRÕES DO TIME (redesenho "Semana", mesa-semana-app §1–§3): os dados das abas Skills e Memória que o app ainda
//! não tinha num lugar só.
//!  - Skills: o catálogo de TODOS os projetos deste computador (pessoais + as de cada repo), com onde cada uma está
//!    ligada e "quando" ela entra sozinha (só quando pedir · sempre em tarefas de UI · de código · todas), e o
//!    histórico de quem ligou/desligou (com nome). O `.cardume/skills.json` continua sendo o que o motor lê.
//!  - Memória: arquivar (nunca apaga — a nota sai do contexto e fica em `_arquivadas/`), histórico de cada correção
//!    (`_historico/`) e o "usada em" (gravado pelo motor em `_uso.json`). Pastas/arquivos com "_" na frente são
//!    ignorados pela lista de notas e pelo contexto dos agentes (memoria.rs e src/memory.ts).
//! Tudo async (nada de I/O na thread da janela).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;

use super::memoria::{brain_root, note_path, parse_note, valid_name};
use super::{home_dir_s, now_ms, parse_skill_md, repo_or, AppState};

// ---------------------------------------------------------------- skills

const QUANDO: [&str; 3] = ["UI", "codigo", "todas"];
const HIST_KEEP: usize = 200;

fn skills_json(repo: &Path) -> PathBuf { repo.join(".cardume").join("skills.json") }
fn skills_hist(repo: &Path) -> PathBuf { repo.join(".cardume").join("skills-hist.json") }

fn read_arr(p: &Path) -> Vec<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

/// "quando" aceito (UI | codigo | todas); o resto = só quando pedir.
pub fn quando_norm(q: Option<&str>) -> Option<String> {
    let k = q.unwrap_or("").trim();
    let k = if k.eq_ignore_ascii_case("código") || k.eq_ignore_ascii_case("codigo") { "codigo" } else if k.eq_ignore_ascii_case("ui") { "UI" } else if k.eq_ignore_ascii_case("todas") { "todas" } else { "" };
    QUANDO.contains(&k).then(|| k.to_string())
}

/// skills.json novo depois de ligar/desligar UMA skill (puro). Preserva os outros campos da entrada (dono `agente`,
/// descrição) e a ordem das outras; `quando` vazio tira o campo.
pub fn skills_set(list: Vec<Value>, name: &str, description: &str, on: bool, quando: Option<String>) -> Vec<Value> {
    let mut out: Vec<Value> = list.into_iter().filter(|x| x.is_object()).collect();
    let at = out.iter().position(|x| x["name"].as_str() == Some(name));
    if !on {
        if let Some(i) = at { out.remove(i); }
        return out;
    }
    let mut e = at.map(|i| out[i].clone()).unwrap_or_else(|| json!({ "name": name, "description": description }));
    if e["description"].as_str().map(str::is_empty).unwrap_or(true) && !description.is_empty() { e["description"] = json!(description); }
    match quando { Some(q) => { e["quando"] = json!(q); } None => { if let Some(o) = e.as_object_mut() { o.remove("quando"); } } }
    match at { Some(i) => out[i] = e, None => out.push(e) }
    out
}

/// Dono de uma skill do repositório: quem mexeu por último no SKILL.md (git). Fora do git = None.
fn git_author(repo: &Path, rel: &str) -> Option<String> {
    let mut c = std::process::Command::new("git");
    c.args(["-C"]).arg(repo).args(["log", "-1", "--format=%an", "--", rel]);
    let o = c.output().ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (o.status.success() && !s.is_empty()).then_some(s)
}

fn mtime(p: &Path) -> i64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// (nome, descrição, pasta) de cada SKILL.md direto em `dir/<pasta>/`.
fn scan(dir: &Path) -> Vec<(String, String, PathBuf)> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let md = e.path().join("SKILL.md");
            if md.is_file() { if let Some((n, d)) = parse_skill_md(&md) { out.push((n, d, e.path())); } }
        }
    }
    out
}

/// Catálogo das skills de todos os projetos pedidos (+ as pessoais): uma linha por skill com, por projeto, se está
/// ligada e "quando". Mais recentes (SKILL.md modificado) primeiro. `hist` = quem ligou/desligou, de todos os projetos.
#[tauri::command(async)]
pub fn skills_catalog(state: State<AppState>, repos: Option<Vec<String>>) -> Result<Value, String> {
    let mut list: Vec<PathBuf> = repos.unwrap_or_default().into_iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
    if let Ok(cur) = repo_or(&state, None) { if !list.contains(&cur) { list.insert(0, cur); } }
    let personal = PathBuf::from(home_dir_s()).join(".claude").join("skills");
    let mut items: Vec<Value> = vec![];
    for (n, d, dir) in scan(&personal) {
        let origin = std::fs::read_to_string(dir.join(".git-origin")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        items.push(json!({ "name": n, "description": d, "source": if origin.is_some() { "comunidade" } else { "pessoal" }, "origin": origin, "repo": null, "owner": null, "mtimeMs": mtime(&dir.join("SKILL.md")) }));
    }
    for r in &list {
        for (n, d, dir) in scan(&r.join(".claude").join("skills")) {
            let rel = dir.strip_prefix(r).map(|p| p.join("SKILL.md").to_string_lossy().to_string()).unwrap_or_default();
            items.push(json!({ "name": n, "description": d, "source": "projeto", "origin": null, "repo": r.display().to_string(), "owner": git_author(r, &rel), "mtimeMs": mtime(&dir.join("SKILL.md")) }));
        }
    }
    // ligada/quando por projeto + versão (a maior entre os projetos com histórico)
    let on: Vec<(String, Vec<Value>)> = list.iter().map(|r| (r.display().to_string(), read_arr(&skills_json(r)))).collect();
    for it in items.iter_mut() {
        let name = it["name"].as_str().unwrap_or("").to_string();
        let mut m = serde_json::Map::new();
        for (r, arr) in &on {
            if let Some(e) = arr.iter().find(|x| x["name"].as_str() == Some(&name)) {
                m.insert(r.clone(), json!({ "on": true, "quando": quando_norm(e["quando"].as_str()), "agente": e["agente"] }));
            }
        }
        it["on"] = Value::Object(m);
        let v = list.iter().map(|r| super::agent_versions::skill_version(&r.join(".cardume"), &name)).max().unwrap_or(1);
        it["version"] = json!(v);
    }
    items.sort_by(|a, b| b["mtimeMs"].as_i64().cmp(&a["mtimeMs"].as_i64()));
    let mut hist: Vec<Value> = list.iter().flat_map(|r| read_arr(&skills_hist(r))).collect();
    hist.sort_by(|a, b| b["at"].as_i64().cmp(&a["at"].as_i64()));
    hist.truncate(60);
    Ok(json!({ "skills": items, "hist": hist, "repos": list.iter().map(|r| r.display().to_string()).collect::<Vec<_>>() }))
}

/// Liga/desliga uma skill num projeto (e "quando" ela entra sozinha). `by` = o NOME de quem mexeu (vai pro histórico).
#[tauri::command(async)]
pub fn skill_set_on(repo: String, name: String, description: Option<String>, on: bool, quando: Option<String>, by: Option<String>) -> Result<Value, String> {
    let r = PathBuf::from(repo.trim());
    if !r.is_dir() { return Err("esse projeto não está mais neste computador".into()); }
    let n = name.trim();
    if n.is_empty() || n.len() > 80 || n.contains('/') || n.contains('\\') { return Err("nome de skill inválido".into()); }
    let p = skills_json(&r);
    let before = read_arr(&p);
    let was = before.iter().find(|x| x["name"].as_str() == Some(n)).cloned();
    let q = quando_norm(quando.as_deref());
    let next = skills_set(before, n, description.as_deref().unwrap_or(""), on, q.clone());
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let action = match (&was, on) {
        (None, true) => "ligou",
        (Some(_), false) => "desligou",
        (Some(w), true) if quando_norm(w["quando"].as_str()) != q => "mudou quando usar",
        _ => "",
    };
    if !action.is_empty() {
        let hp = skills_hist(&r);
        let mut h = read_arr(&hp);
        h.insert(0, json!({ "at": now_ms(), "by": by.unwrap_or_default().chars().take(80).collect::<String>(), "action": action, "skill": n, "quando": q, "repo": r.display().to_string() }));
        h.truncate(HIST_KEEP);
        let _ = std::fs::write(&hp, serde_json::to_string_pretty(&h).unwrap_or_default());
    }
    Ok(json!({ "on": on, "quando": q, "action": action }))
}

// ---------------------------------------------------------------- memória

fn scope_ok(scope: &str) -> Result<(), String> { if scope == "local" || scope == "time" { Ok(()) } else { Err("escopo inválido (use local ou time)".into()) } }
fn arch_dir(repo: &Path, scope: &str) -> PathBuf { brain_root(repo).join("_arquivadas").join(scope) }
fn hist_dir(repo: &Path, scope: &str, slug: &str) -> PathBuf { brain_root(repo).join("_historico").join(scope).join(slug) }

/// Nome livre numa pasta (slug, slug-2, slug-3…).
fn free_name(dir: &Path, base: &str) -> Result<String, String> {
    let mut name = base.to_string();
    let mut i: u32 = 2;
    while std::fs::symlink_metadata(dir.join(format!("{name}.md"))).is_ok() {
        name = format!("{base}-{i}");
        i = i.checked_add(1).ok_or("nomes esgotados")?;
    }
    Ok(name)
}

pub fn archive_note(repo: &Path, scope: &str, slug: &str) -> Result<Value, String> {
    scope_ok(scope)?;
    let src = note_path(repo, scope, slug, false)?;
    if !src.is_file() { return Err("nota não encontrada".into()); }
    let dir = arch_dir(repo, scope);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = valid_name(slug).unwrap_or_else(|_| super::memoria::slugify(slug));
    let name = free_name(&dir, &base)?;
    std::fs::rename(&src, dir.join(format!("{name}.md"))).map_err(|e| e.to_string())?;
    Ok(json!({ "scope": scope, "slug": name }))
}

pub fn restore_note(repo: &Path, scope: &str, slug: &str) -> Result<Value, String> {
    scope_ok(scope)?;
    let base = valid_name(slug)?;
    let src = arch_dir(repo, scope).join(format!("{base}.md"));
    if !src.is_file() { return Err("nota arquivada não encontrada".into()); }
    let dir = if scope == "time" { brain_root(repo).join("time") } else { brain_root(repo) };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = free_name(&dir, &base)?;
    let dst = note_path(repo, scope, &name, true)?;
    // regrava (mtime = agora): no time, a nota restaurada é MAIS NOVA que a lápide do arquivamento e revive pra todos
    let t = std::fs::read(&src).map_err(|e| e.to_string())?;
    std::fs::write(&dst, t).map_err(|e| e.to_string())?;
    std::fs::remove_file(&src).map_err(|e| e.to_string())?;
    Ok(json!({ "scope": scope, "slug": name }))
}

pub fn archived_notes(repo: &Path) -> Vec<Value> {
    let mut out = vec![];
    for scope in ["local", "time"] {
        let Ok(rd) = std::fs::read_dir(arch_dir(repo, scope)) else { continue };
        for e in rd.flatten() {
            let f = e.file_name().to_string_lossy().to_string();
            let Some(slug) = f.strip_suffix(".md") else { continue };
            if f.starts_with('.') { continue; }
            let Ok(t) = std::fs::read_to_string(e.path()) else { continue };
            let at = mtime(&e.path());
            let mut n = serde_json::to_value(parse_note(&t, slug, scope, at)).unwrap_or(Value::Null);
            n["body"] = json!(t);
            n["archivedAt"] = json!(at);
            out.push(n);
        }
    }
    out.sort_by(|a, b| b["archivedAt"].as_i64().cmp(&a["archivedAt"].as_i64()));
    out
}

/// Guarda o conteúdo ATUAL da nota antes de uma correção (as 20 últimas por nota).
pub fn snapshot_note(repo: &Path, scope: &str, slug: &str, by: &str) -> Result<Value, String> {
    scope_ok(scope)?;
    let src = note_path(repo, scope, slug, false)?;
    let t = std::fs::read_to_string(&src).map_err(|_| "nota não encontrada".to_string())?;
    let name = valid_name(slug).unwrap_or_else(|_| super::memoria::slugify(slug));
    let dir = hist_dir(repo, scope, &name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let at = now_ms();
    std::fs::write(dir.join(format!("{at}.md")), &t).map_err(|e| e.to_string())?;
    let _ = std::fs::write(dir.join(format!("{at}.by")), by.chars().take(80).collect::<String>());
    let mut v: Vec<i64> = std::fs::read_dir(&dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md").and_then(|x| x.parse().ok())).collect()).unwrap_or_default();
    v.sort_unstable_by(|a, b| b.cmp(a));
    for old in v.into_iter().skip(20) { let _ = std::fs::remove_file(dir.join(format!("{old}.md"))); let _ = std::fs::remove_file(dir.join(format!("{old}.by"))); }
    Ok(json!({ "at": at }))
}

pub fn note_history(repo: &Path, scope: &str, slug: &str) -> Vec<Value> {
    if scope_ok(scope).is_err() { return vec![]; }
    let name = valid_name(slug).unwrap_or_else(|_| super::memoria::slugify(slug));
    let dir = hist_dir(repo, scope, &name);
    let mut v: Vec<i64> = std::fs::read_dir(&dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md").and_then(|x| x.parse().ok())).collect()).unwrap_or_default();
    v.sort_unstable_by(|a, b| b.cmp(a));
    v.into_iter().take(20).map(|at| json!({
        "at": at,
        "by": std::fs::read_to_string(dir.join(format!("{at}.by"))).unwrap_or_default(),
        "content": std::fs::read_to_string(dir.join(format!("{at}.md"))).unwrap_or_default(),
    })).collect()
}

#[tauri::command(async)]
pub fn memory_archive(state: State<AppState>, repo: Option<String>, scope: String, slug: String) -> Result<Value, String> {
    archive_note(&repo_or(&state, repo)?, &scope, &slug)
}
#[tauri::command(async)]
pub fn memory_unarchive(state: State<AppState>, repo: Option<String>, scope: String, slug: String) -> Result<Value, String> {
    restore_note(&repo_or(&state, repo)?, &scope, &slug)
}
#[tauri::command(async)]
pub fn memory_archived(state: State<AppState>, repo: Option<String>) -> Result<Value, String> {
    Ok(Value::Array(archived_notes(&repo_or(&state, repo)?)))
}
#[tauri::command(async)]
pub fn memory_snapshot(state: State<AppState>, repo: Option<String>, scope: String, slug: String, by: Option<String>) -> Result<Value, String> {
    snapshot_note(&repo_or(&state, repo)?, &scope, &slug, by.as_deref().unwrap_or(""))
}
#[tauri::command(async)]
pub fn memory_history(state: State<AppState>, repo: Option<String>, scope: String, slug: String) -> Result<Value, String> {
    Ok(Value::Array(note_history(&repo_or(&state, repo)?, &scope, &slug)))
}
/// "usada em": { "escopo:slug": [{ task, at }] } gravado pelo motor (src/memory.ts: recordUse).
#[tauri::command(async)]
pub fn memory_usage(state: State<AppState>, repo: Option<String>) -> Result<Value, String> {
    let r = repo_or(&state, repo)?;
    Ok(std::fs::read_to_string(brain_root(&r).join("_uso.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or_else(|| json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-padroes-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cardume").join("memoria").join("time")).unwrap();
        d
    }

    #[test]
    fn ligar_preserva_dono_e_quando_some_ao_voltar_pra_so_quando_pedir() {
        let l = vec![json!({ "name": "a", "description": "x", "agente": "nyx" }), json!({ "name": "b" })];
        let l = skills_set(l, "a", "", true, Some("UI".into()));
        assert_eq!(l[0]["agente"], "nyx");
        assert_eq!(l[0]["quando"], "UI");
        let l = skills_set(l, "a", "", true, None);
        assert!(l[0].get("quando").is_none());
        let l = skills_set(l, "c", "nova", true, None);
        assert_eq!(l.len(), 3);
        assert_eq!(l[2]["description"], "nova");
        let l = skills_set(l, "b", "", false, None);
        assert_eq!(l.iter().map(|x| x["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["a", "c"]);
    }

    #[test]
    fn quando_aceita_so_os_tres() {
        assert_eq!(quando_norm(Some("ui")).as_deref(), Some("UI"));
        assert_eq!(quando_norm(Some("Código")).as_deref(), Some("codigo"));
        assert_eq!(quando_norm(Some("todas")).as_deref(), Some("todas"));
        assert_eq!(quando_norm(Some("sempre")), None);
        assert_eq!(quando_norm(None), None);
    }

    #[test]
    fn arquivar_tira_da_lista_e_restaurar_devolve_sem_apagar() {
        let r = tmp("arq");
        let note = "---\ntitle: Frete grátis\ntype: regra\ntags: []\nupdated: 2026-10-11\nby: Ana\norigem: pessoa\n---\nA partir de R$ 199.\n";
        std::fs::write(r.join(".cardume/memoria/time/frete.md"), note).unwrap();
        assert_eq!(super::super::memoria::list_notes(&r, true).len(), 1);
        archive_note(&r, "time", "frete").unwrap();
        assert!(super::super::memoria::list_notes(&r, true).is_empty(), "arquivada não entra na lista nem no contexto");
        let a = archived_notes(&r);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["title"], "Frete grátis");
        restore_note(&r, "time", "frete").unwrap();
        assert_eq!(super::super::memoria::list_notes(&r, true).len(), 1);
        assert!(archived_notes(&r).is_empty());
        assert!(archive_note(&r, "time", "../fora").is_err());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn historico_guarda_a_versao_anterior_com_quem_corrigiu() {
        let r = tmp("hist");
        std::fs::write(r.join(".cardume/memoria/frete.md"), "---\ntitle: Frete\n---\nR$ 150\n").unwrap();
        snapshot_note(&r, "local", "frete", "Bruno").unwrap();
        let h = note_history(&r, "local", "frete");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0]["by"], "Bruno");
        assert!(h[0]["content"].as_str().unwrap().contains("R$ 150"));
        assert!(super::super::memoria::list_notes(&r, true).len() == 1, "o histórico não vira nota");
        let _ = std::fs::remove_dir_all(&r);
    }
}
