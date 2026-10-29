//! QUADRO AO VIVO (aprovado pelo dono em 29/10): a IA desenha na tela enquanto explica; a pessoa risca por cima.
//! Mora em `<repo>/.cardume/quadros/<id>/` (fora do git, como o resto de .cardume):
//!   quadro.json   — o quadro inteiro (title, prompt, taskId, steps, mine (traços da pessoa), bg, changes, history)
//!   assets/<nome> — o print de fundo (revisar layout) e os PNGs exportados
//! "Salvar como artefato" grava `quadro-<slug>-<n>.svg/.png` na pasta de artefatos da tarefa (a mesma que a lista de
//! artefatos lê: `.cardume/artifacts/` da worktree; sem worktree, a cópia coletada do repo). Tudo async.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;

use super::prototipos::{asset_name_ok, asset_rel_ok, mime_of, read_json, slug_of, valid_id, write_atomic};
use super::{base64_decode, base64_encode, now_ms, repo_or, task_wt_base, AppState};

/// Teto de uma imagem (print de fundo / PNG exportado).
const ASSET_MAX: usize = 15 * 1024 * 1024;
/// Teto do SVG exportado (texto): os traços são poucos KB, mas o print de fundo vai dentro (data URL, até 15 MB → ~20 MB).
const SVG_MAX: usize = 24 * 1024 * 1024;

pub fn quadros_root(repo: &Path) -> PathBuf { repo.join(".cardume").join("quadros") }

fn quadro_dir(repo: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("quadro inválido".into()); }
    Ok(quadros_root(repo).join(id))
}

/// a linha da lista (puro): o que o menu "Abrir quadro salvo" mostra, sem carregar os passos.
pub fn summary(q: &Value) -> Value {
    json!({
        "id": q["id"], "title": q["title"].as_str().unwrap_or("Quadro sem título"), "updatedAt": q["updatedAt"].as_i64().unwrap_or(0),
        "taskId": q["taskId"], "steps": q["steps"].as_array().map(|a| a.len()).unwrap_or(0),
        "asks": q["history"].as_array().map(|a| a.len()).unwrap_or(0), "bg": q["bg"].is_string(),
    })
}

/// lista do repo, o mais recente primeiro. Pasta sem quadro.json legível é pulada.
pub fn list_in(repo: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(quadros_root(repo)).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir() && valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_json(&e.path().join("quadro.json")).map(|mut v| { if !v["id"].is_string() { v["id"] = json!(e.file_name().to_string_lossy()); } summary(&v) }))
        .collect();
    out.sort_by(|a, b| b["updatedAt"].as_i64().unwrap_or(0).cmp(&a["updatedAt"].as_i64().unwrap_or(0)));
    out
}

pub fn read_in(repo: &Path, id: &str) -> Result<Value, String> {
    read_json(&quadro_dir(repo, id)?.join("quadro.json")).ok_or_else(|| "esse quadro não existe mais (ou o arquivo está quebrado)".into())
}

/// grava o quadro (autosave). O id do arquivo é sempre o da pasta; `updatedAt` é o relógio daqui; `createdAt` fica.
pub fn write_in(repo: &Path, id: &str, mut q: Value, now: i64) -> Result<Value, String> {
    if !q.is_object() { return Err("quadro inválido".into()); }
    let file = quadro_dir(repo, id)?.join("quadro.json");
    let old = read_json(&file);
    q["id"] = json!(id);
    q["updatedAt"] = json!(now);
    if !q["createdAt"].is_i64() { q["createdAt"] = old.as_ref().and_then(|o| o["createdAt"].as_i64()).map(|c| json!(c)).unwrap_or(json!(now)); }
    let body = serde_json::to_vec_pretty(&q).map_err(|e| e.to_string())?;
    write_atomic(&file, &body)?;
    Ok(json!({ "updatedAt": now }))
}

fn decode_b64(b64: &str) -> Result<Vec<u8>, String> {
    let raw = b64.split_once(";base64,").map(|(_, r)| r).unwrap_or(b64);
    let bytes = base64_decode(raw.trim()).ok_or("a imagem veio corrompida")?;
    if bytes.is_empty() { return Err("imagem vazia".into()); }
    if bytes.len() > ASSET_MAX { return Err("imagem grande demais (máx. 15 MB)".into()); }
    Ok(bytes)
}

/// imagem (fundo colado, PNG exportado) → `assets/<nome>`. Aceita base64 puro ou data URL. Devolve o caminho relativo.
pub fn asset_put_in(repo: &Path, id: &str, name: &str, b64: &str) -> Result<String, String> {
    let nm = asset_name_ok(name).ok_or("nome de imagem inválido (png, jpg, gif, webp ou svg)")?;
    let bytes = decode_b64(b64)?;
    let dir = quadro_dir(repo, id)?;
    if !dir.join("quadro.json").exists() { return Err("esse quadro ainda não foi salvo".into()); }
    write_atomic(&dir.join("assets").join(&nm), &bytes)?;
    Ok(format!("assets/{nm}"))
}

pub fn asset_url_in(repo: &Path, id: &str, path: &str) -> Result<String, String> {
    let nm = asset_rel_ok(path).ok_or("imagem inválida")?;
    let f = quadro_dir(repo, id)?.join("assets").join(&nm);
    let bytes = std::fs::read(&f).map_err(|_| "a imagem sumiu da pasta do quadro".to_string())?;
    Ok(format!("data:{};base64,{}", mime_of(&nm), base64_encode(&bytes)))
}

/// Próximo número livre de `quadro-<slug>-<n>.(svg|png)` na pasta (os dois arquivos andam juntos). Puro sobre o disco.
pub fn next_export_base(dir: &Path, slug: &str) -> String {
    let pre = format!("quadro-{slug}-");
    let mut max = 0u32;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        let stem = n.strip_suffix(".svg").or_else(|| n.strip_suffix(".png"));
        if let Some(num) = stem.and_then(|s| s.strip_prefix(&pre)).and_then(|r| r.parse::<u32>().ok()) { max = max.max(num); }
    }
    format!("{pre}{}", max + 1)
}

/// SVG aceitável pra gravar: começa com <svg, sem <script>, sem on*= e sem href externo. O front monta o SVG a partir dos
/// passos já saneados; isto é a última barreira (o arquivo vira artefato que se abre no navegador).
pub fn svg_ok(svg: &str) -> bool {
    let l = svg.trim_start().to_ascii_lowercase();
    if !l.starts_with("<svg") && !l.starts_with("<?xml") { return false; }
    if svg.len() > SVG_MAX { return false; }
    let bad = ["<script", "javascript:", "<foreignobject", "<iframe", "href=\"http", "href='http"];
    if bad.iter().any(|b| l.contains(b)) { return false; }
    // atributo de evento (onload=, onclick=…) DENTRO de uma tag (texto do desenho pode ter "online = ok")
    !l.split('<').skip(1).any(|seg| {
        let tag = seg.split('>').next().unwrap_or("");
        tag.split(|c: char| c.is_whitespace() || c == '/').skip(1).any(|a| {
            let a = a.trim();
            a.starts_with("on") && a[2..].chars().take_while(|c| c.is_ascii_alphabetic()).count() > 0 && {
                let n = 2 + a[2..].chars().take_while(|c| c.is_ascii_alphabetic()).count();
                a[n..].trim_start().starts_with('=') || a[n..].is_empty() && tag.contains('=')
            }
        })
    })
}

/// grava SVG + PNG do quadro na pasta de artefatos `dir`. Devolve { svg, png } (nomes) — aparecem na lista da tarefa.
pub fn export_to(dir: &Path, title: &str, id: &str, svg: &str, png_b64: &str) -> Result<Value, String> {
    if !svg_ok(svg) { return Err("o desenho exportado veio inválido".into()); }
    let png = decode_b64(png_b64)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("não criei a pasta de artefatos: {e}"))?;
    let base = next_export_base(dir, &slug_of(title, id));
    write_atomic(&dir.join(format!("{base}.svg")), svg.as_bytes())?;
    write_atomic(&dir.join(format!("{base}.png")), &png)?;
    Ok(json!({ "svg": format!("{base}.svg"), "png": format!("{base}.png") }))
}

// ---------------------------------------------------------------- comandos

#[tauri::command(async)]
pub fn quadro_list(state: State<AppState>, repo: Option<String>) -> Result<Value, String> {
    Ok(Value::Array(list_in(&repo_or(&state, repo)?)))
}
#[tauri::command(async)]
pub fn quadro_read(state: State<AppState>, repo: Option<String>, id: String) -> Result<Value, String> {
    read_in(&repo_or(&state, repo)?, &id)
}
#[tauri::command(async)]
pub fn quadro_write(state: State<AppState>, repo: Option<String>, id: String, json: Value) -> Result<Value, String> {
    write_in(&repo_or(&state, repo)?, &id, json, now_ms())
}
#[tauri::command(async)]
pub fn quadro_asset_put(state: State<AppState>, repo: Option<String>, id: String, name: String, base64: String) -> Result<String, String> {
    asset_put_in(&repo_or(&state, repo)?, &id, &name, &base64)
}
#[tauri::command(async)]
pub fn quadro_asset_url(state: State<AppState>, repo: Option<String>, id: String, path: String) -> Result<String, String> {
    asset_url_in(&repo_or(&state, repo)?, &id, &path)
}
/// "Salvar como artefato": worktree da tarefa (ao vivo) ou, sem ela, a cópia coletada no repo (`.cardume/artifacts/<task>/`).
#[tauri::command(async)]
pub fn quadro_export(state: State<AppState>, repo: Option<String>, id: String, task_id: String, svg: String, png: String) -> Result<Value, String> {
    let repo = repo_or(&state, repo)?;
    if !valid_id(&task_id) { return Err("tarefa inválida".into()); }
    let q = read_in(&repo, &id)?;
    let wt = task_wt_base(&state, &task_id).ok().map(|(w, _)| w).filter(|w| !w.as_os_str().is_empty() && w.is_dir());
    let dir = match wt {
        Some(w) => w.join(".cardume").join("artifacts"),
        None => repo.join(".cardume").join("artifacts").join(&task_id),
    };
    export_to(&dir, q["title"].as_str().unwrap_or(""), &id, &svg, &png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-quadro-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn grava_le_lista_e_mantem_criacao() {
        let r = tmp("rw");
        assert!(write_in(&r, "../fora", json!({}), 1).is_err(), "id vira nome de pasta: nada de subir");
        let q = json!({ "title": "Checkout da loja-web", "taskId": "t1", "steps": [{ "say": "oi" }, { "dot": [10, 10] }], "history": [{ "q": "por quê?" }] });
        write_in(&r, "q-abc", q.clone(), 100).unwrap();
        write_in(&r, "q-abc", q, 200).unwrap();
        let back = read_in(&r, "q-abc").unwrap();
        assert_eq!(back["createdAt"], 100);
        assert_eq!(back["updatedAt"], 200);
        assert_eq!(back["id"], "q-abc");
        let l = list_in(&r);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["steps"], 2);
        assert_eq!(l[0]["asks"], 1);
        assert_eq!(l[0]["taskId"], "t1");
        assert!(read_in(&r, "q-nao").is_err());
        let _ = std::fs::remove_dir_all(r);
    }

    #[test]
    fn fundo_vai_e_volta_so_com_nome_seguro() {
        let r = tmp("asset");
        assert!(asset_put_in(&r, "q-1", "fundo.png", PNG).is_err(), "quadro ainda não salvo");
        write_in(&r, "q-1", json!({ "title": "x" }), 1).unwrap();
        assert!(asset_put_in(&r, "q-1", "../../x.png", PNG).is_ok_and(|p| p == "assets/x.png"), "só o último pedaço do nome");
        assert!(asset_put_in(&r, "q-1", "fundo.exe", PNG).is_err());
        let rel = asset_put_in(&r, "q-1", "fundo.png", &format!("data:image/png;base64,{PNG}")).unwrap();
        assert_eq!(rel, "assets/fundo.png");
        assert!(asset_url_in(&r, "q-1", &rel).unwrap().starts_with("data:image/png;base64,"));
        assert!(asset_url_in(&r, "q-1", "assets/../quadro.json").is_err());
        let _ = std::fs::remove_dir_all(r);
    }

    #[test]
    fn svg_seguro_e_exporta_com_numero_livre() {
        assert!(svg_ok("<svg viewBox=\"0 0 1000 600\"><path d=\"M0 0\"/></svg>"));
        assert!(!svg_ok("<svg><script>alert(1)</script></svg>"));
        assert!(!svg_ok("<svg onload=\"x()\"></svg>"));
        assert!(!svg_ok("<svg><image href=\"https://fora/x.png\"/></svg>"));
        assert!(!svg_ok("<html>x</html>"));
        assert!(svg_ok("<svg><text>status online = ok</text></svg>"), "texto do desenho não é atributo de evento");
        assert!(!svg_ok("<svg><g onclick = \"x()\"></g></svg>"));
        let d = tmp("exp");
        let a = export_to(&d, "Por que apareceu o PR", "q-1", "<svg></svg>", PNG).unwrap();
        assert_eq!(a["svg"], "quadro-por-que-apareceu-o-pr-1.svg");
        assert_eq!(a["png"], "quadro-por-que-apareceu-o-pr-1.png");
        let b = export_to(&d, "Por que apareceu o PR", "q-1", "<svg></svg>", PNG).unwrap();
        assert_eq!(b["png"], "quadro-por-que-apareceu-o-pr-2.png", "não sobrescreve o anterior");
        assert!(d.join("quadro-por-que-apareceu-o-pr-2.svg").is_file());
        assert!(export_to(&d, "x", "q-1", "<svg><script/></svg>", PNG).is_err());
        let _ = std::fs::remove_dir_all(d);
    }
}
