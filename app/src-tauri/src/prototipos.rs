//! PROTÓTIPOS (Opção A aprovada pelo dono em 27/10): telas rascunhadas em HTML/CSS + colagem + comentários.
//! Mora em `<repo>/.cardume/prototipos/<id>/` (fora do git, como o resto de .cardume):
//!   prototipo.json   — o protótipo inteiro (modelo comum às duas frentes: screens, els, pins, history)
//!   assets/<nome>    — imagens coladas (prints, recortes)
//!   versions/v<N>.json — a versão anterior, gravada quando chega uma versão maior (desfazer / antes-depois)
//! "Transformar em demanda" copia a pasta (sem `versions/`) pro worktree da tarefa em `docs/prototipos/<slug>/`, junto com
//! um `<tela>.html` de cada tela pra abrir no navegador/GitHub. Tudo async (nada de I/O na thread da janela).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;

use super::{base64_decode, base64_encode, now_ms, repo_or, task_wt_base, AppState};

/// Teto de uma imagem colada (um print grande de tela retina cabe com folga).
const ASSET_MAX: usize = 15 * 1024 * 1024;
/// Miniatura da lista: só manda o HTML da 1ª tela se for pequeno (a lista não pode pesar).
const THUMB_MAX: usize = 200 * 1024;

pub fn protos_root(repo: &Path) -> PathBuf { repo.join(".cardume").join("prototipos") }

/// id aceito: letras, números, "-" e "_" (o front gera `p-<ts36>`); nunca "." nem barra — vira nome de pasta.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn proto_dir(repo: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("protótipo inválido".into()); }
    Ok(protos_root(repo).join(id))
}

/// nome de arquivo de imagem seguro: só o último pedaço, caracteres simples, extensão de imagem conhecida.
pub fn asset_name_ok(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base.len() > 96 || base.starts_with('.') { return None; }
    if !base.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') { return None; }
    let ext = base.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&ext.as_str()).then(|| base.to_string())
}

/// "assets/<nome>" válido → o nome; qualquer outra coisa (subir pasta, absoluto) → None.
pub fn asset_rel_ok(path: &str) -> Option<String> {
    let rest = path.strip_prefix("assets/")?;
    if rest.contains('/') || rest.contains('\\') { return None; }
    asset_name_ok(rest).filter(|n| n == rest)
}

fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn write_atomic(file: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(d) = file.parent() { std::fs::create_dir_all(d).map_err(|e| format!("não criei a pasta do protótipo: {e}"))?; }
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("não salvei o protótipo: {e}"))?;
    std::fs::rename(&tmp, file).map_err(|e| format!("não salvei o protótipo: {e}"))
}

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object())
}

/// comentários abertos = alfinete com texto e não resolvido (rascunho vazio não conta)
pub fn open_pins(p: &Value) -> usize {
    p["pins"].as_array().map(|a| a.iter().filter(|x| !x["resolved"].as_bool().unwrap_or(false) && !x["text"].as_str().unwrap_or("").trim().is_empty()).count()).unwrap_or(0)
}

/// a linha da lista (puro): o que a página Protótipos mostra de cada um, sem carregar tudo.
pub fn summary(p: &Value) -> Value {
    let thumb = p["screens"].as_array().and_then(|a| a.first()).filter(|s| s["html"].as_str().map(|h| h.len() + s["css"].as_str().unwrap_or("").len() <= THUMB_MAX).unwrap_or(false))
        .map(|s| json!({ "id": s["id"], "w": s["w"], "h": s["h"], "html": s["html"], "css": s["css"] }));
    json!({
        "id": p["id"], "title": p["title"].as_str().unwrap_or("Sem título"), "updatedAt": p["updatedAt"].as_i64().unwrap_or(0),
        "createdBy": p["createdBy"], "version": p["version"].as_i64().unwrap_or(1), "source": p["source"], "taskId": p["taskId"],
        "openPins": open_pins(p), "screens": p["screens"].as_array().map(|a| a.len()).unwrap_or(0), "thumb": thumb,
    })
}

/// lista do repo, a mais recente primeiro (data de modificação). Pasta sem prototipo.json legível é pulada.
pub fn list_in(repo: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(protos_root(repo)).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir() && valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_json(&e.path().join("prototipo.json")).map(|mut v| { if !v["id"].is_string() { v["id"] = json!(e.file_name().to_string_lossy()); } summary(&v) }))
        .collect();
    out.sort_by(|a, b| b["updatedAt"].as_i64().unwrap_or(0).cmp(&a["updatedAt"].as_i64().unwrap_or(0)));
    out
}

pub fn read_in(repo: &Path, id: &str) -> Result<Value, String> {
    read_json(&proto_dir(repo, id)?.join("prototipo.json")).ok_or_else(|| "esse protótipo não existe mais (ou o arquivo está quebrado)".into())
}

/// grava o protótipo. Chegou versão MAIOR que a do disco: a do disco vira `versions/v<N>.json` antes (nunca se perde).
/// O id do arquivo é sempre o da pasta e `updatedAt` é o relógio daqui. Devolve { version, updatedAt }.
pub fn write_in(repo: &Path, id: &str, mut p: Value, now: i64) -> Result<Value, String> {
    if !p.is_object() { return Err("protótipo inválido".into()); }
    let dir = proto_dir(repo, id)?;
    let file = dir.join("prototipo.json");
    let new_v = p["version"].as_i64().unwrap_or(1).max(1);
    let old = read_json(&file);
    if let Some(old) = &old {
        let old_v = old["version"].as_i64().unwrap_or(1);
        if new_v > old_v {
            let body = serde_json::to_vec_pretty(old).map_err(|e| e.to_string())?;
            write_atomic(&dir.join("versions").join(format!("v{old_v}.json")), &body)?;
        }
    }
    p["id"] = json!(id);
    p["version"] = json!(new_v);
    p["updatedAt"] = json!(now);
    if !p["createdAt"].is_i64() { p["createdAt"] = old.as_ref().and_then(|o| o["createdAt"].as_i64()).map(|c| json!(c)).unwrap_or(json!(now)); }
    let body = serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?;
    write_atomic(&file, &body)?;
    Ok(json!({ "version": new_v, "updatedAt": now }))
}

/// imagem colada → `assets/<nome>`. Aceita base64 puro ou data URL inteiro.
pub fn asset_put_in(repo: &Path, id: &str, name: &str, b64: &str) -> Result<String, String> {
    let nm = asset_name_ok(name).ok_or("nome de imagem inválido (png, jpg, gif, webp ou svg)")?;
    let raw = b64.split_once(";base64,").map(|(_, r)| r).unwrap_or(b64);
    let bytes = base64_decode(raw).ok_or("a imagem veio corrompida")?;
    if bytes.is_empty() { return Err("imagem vazia".into()); }
    if bytes.len() > ASSET_MAX { return Err("imagem grande demais (máx. 15 MB)".into()); }
    let dir = proto_dir(repo, id)?;
    if !dir.join("prototipo.json").exists() { return Err("esse protótipo não existe mais".into()); }
    write_atomic(&dir.join("assets").join(&nm), &bytes)?;
    Ok(format!("assets/{nm}"))
}

pub fn asset_url_in(repo: &Path, id: &str, path: &str) -> Result<String, String> {
    let nm = asset_rel_ok(path).ok_or("imagem inválida")?;
    let f = proto_dir(repo, id)?.join("assets").join(&nm);
    let bytes = std::fs::read(&f).map_err(|_| "a imagem sumiu da pasta do protótipo".to_string())?;
    Ok(format!("data:{};base64,{}", mime_of(&nm), base64_encode(&bytes)))
}

/// nome de pasta legível a partir do título: minúsculas sem acento, "-" entre palavras; vazio → o id.
pub fn slug_of(title: &str, id: &str) -> String {
    let map = |c: char| -> char {
        match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            'ñ' | 'Ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c.to_ascii_lowercase(),
            _ => '-',
        }
    };
    let s: String = title.chars().map(map).collect();
    let s = s.split('-').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("-");
    let s: String = s.chars().take(48).collect();
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { id.to_string() } else { s }
}

fn esc_html(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }

/// HTML sozinho de uma tela (pra abrir no navegador ou ver no GitHub): o CSS da tela + o HTML dela, no tamanho certo.
pub fn screen_page(title: &str, s: &Value) -> String {
    let w = s["w"].as_i64().unwrap_or(1280);
    format!(
        "<!doctype html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width={w}\">\n<title>{} · {}</title>\n<style>\n{}\n</style>\n</head>\n<body>\n{}\n</body>\n</html>\n",
        esc_html(title), esc_html(s["name"].as_str().unwrap_or("Tela")), s["css"].as_str().unwrap_or("").replace("</style", "<\\/style"), s["html"].as_str().unwrap_or("")
    )
}

/// copia o protótipo pra `<wt>/docs/prototipos/<slug>/` (prototipo.json + assets/ + <tela>.html). Devolve a pasta.
pub fn export_in(repo: &Path, id: &str, wt: &Path) -> Result<PathBuf, String> {
    let p = read_in(repo, id)?;
    let slug = slug_of(p["title"].as_str().unwrap_or(""), id);
    let dest = wt.join("docs").join("prototipos").join(&slug);
    std::fs::create_dir_all(&dest).map_err(|e| format!("não criei {}: {e}", dest.display()))?;
    let body = serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?;
    write_atomic(&dest.join("prototipo.json"), &body)?;
    let src_assets = proto_dir(repo, id)?.join("assets");
    if src_assets.is_dir() {
        let da = dest.join("assets");
        std::fs::create_dir_all(&da).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(&src_assets).map_err(|e| e.to_string())?.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if asset_name_ok(&n).as_deref() == Some(n.as_str()) && e.path().is_file() {
                std::fs::copy(e.path(), da.join(&n)).map_err(|e| format!("não copiei {n}: {e}"))?;
            }
        }
    }
    for s in p["screens"].as_array().into_iter().flatten() {
        let sid = s["id"].as_str().unwrap_or("");
        if valid_id(sid) { write_atomic(&dest.join(format!("{sid}.html")), screen_page(p["title"].as_str().unwrap_or(""), s).as_bytes())?; }
    }
    Ok(dest)
}

// ---------------------------------------------------------------- comandos

#[tauri::command(async)]
pub fn proto_list(state: State<AppState>, repo: Option<String>) -> Result<Value, String> {
    Ok(Value::Array(list_in(&repo_or(&state, repo)?)))
}
#[tauri::command(async)]
pub fn proto_read(state: State<AppState>, repo: Option<String>, id: String) -> Result<Value, String> {
    read_in(&repo_or(&state, repo)?, &id)
}
#[tauri::command(async)]
pub fn proto_write(state: State<AppState>, repo: Option<String>, id: String, json: Value) -> Result<Value, String> {
    write_in(&repo_or(&state, repo)?, &id, json, now_ms())
}
#[tauri::command(async)]
pub fn proto_asset_put(state: State<AppState>, repo: Option<String>, id: String, name: String, base64: String) -> Result<String, String> {
    asset_put_in(&repo_or(&state, repo)?, &id, &name, &base64)
}
#[tauri::command(async)]
pub fn proto_asset_url(state: State<AppState>, repo: Option<String>, id: String, path: String) -> Result<String, String> {
    asset_url_in(&repo_or(&state, repo)?, &id, &path)
}
#[tauri::command(async)]
pub fn proto_delete(state: State<AppState>, repo: Option<String>, id: String) -> Result<(), String> {
    let dir = proto_dir(&repo_or(&state, repo)?, &id)?;
    if !dir.exists() { return Ok(()); }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("não apaguei o protótipo: {e}"))
}
#[tauri::command(async)]
pub fn proto_export_to_task(state: State<AppState>, repo: Option<String>, id: String, task_id: String) -> Result<String, String> {
    let repo = repo_or(&state, repo)?;
    let (wt, _) = task_wt_base(&state, &task_id)?;
    if wt.as_os_str().is_empty() || !wt.is_dir() { return Err("a tarefa ainda não tem pasta de trabalho (worktree) — o protótipo vai quando ela começar".into()); }
    export_in(&repo, &id, &wt).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-proto-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn sample(v: i64) -> Value {
        json!({ "id": "p-abc", "title": "Checkout com cupom", "version": v, "createdBy": "Ana", "source": "branco", "taskId": null,
            "screens": [ { "id": "desk", "name": "Desktop · 1280", "w": 1280, "h": 840, "html": "<div data-blk=\"pagar\">Pagar</div>", "css": "body{margin:0}" },
                         { "id": "cel", "name": "Celular · 390", "w": 390, "h": 844, "html": "", "css": "" } ],
            "els": [], "history": [],
            "pins": [ { "id": 1, "n": 1, "text": "botão some", "resolved": false }, { "id": 2, "n": 2, "text": "ok", "resolved": true }, { "id": 3, "n": 3, "text": "  ", "resolved": false } ] })
    }

    #[test]
    fn ids_e_nomes_seguros() {
        assert!(valid_id("p-lx2k9a"));
        assert!(!valid_id("../x") && !valid_id("") && !valid_id("a/b") && !valid_id("p.x"));
        assert_eq!(asset_name_ok("img-1.PNG").as_deref(), Some("img-1.PNG"));
        assert_eq!(asset_name_ok("/tmp/../print.png").as_deref(), Some("print.png"));
        assert!(asset_name_ok("x.exe").is_none() && asset_name_ok(".png").is_none() && asset_name_ok("a b.png").is_none());
        assert_eq!(asset_rel_ok("assets/a.png").as_deref(), Some("a.png"));
        assert!(asset_rel_ok("assets/../prototipo.json").is_none() && asset_rel_ok("/etc/a.png").is_none() && asset_rel_ok("assets/x/a.png").is_none());
    }

    #[test]
    fn grava_le_lista_e_guarda_versao_anterior() {
        let repo = tmp("rw");
        assert!(list_in(&repo).is_empty());
        let r = write_in(&repo, "p-abc", sample(1), 1000).unwrap();
        assert_eq!(r["version"], 1);
        // mesma versão: sobrescreve, sem versions/
        write_in(&repo, "p-abc", sample(1), 1500).unwrap();
        assert!(!protos_root(&repo).join("p-abc/versions").exists());
        // versão maior: a anterior vira versions/v1.json
        let mut p2 = sample(2); p2["title"] = json!("Checkout v2");
        write_in(&repo, "p-abc", p2, 2000).unwrap();
        let v1 = read_json(&protos_root(&repo).join("p-abc/versions/v1.json")).unwrap();
        assert_eq!(v1["title"], "Checkout com cupom");
        let now = read_in(&repo, "p-abc").unwrap();
        assert_eq!(now["version"], 2);
        assert_eq!(now["updatedAt"], 2000);
        assert_eq!(now["createdAt"], 1000, "criação não muda ao regravar");
        // um segundo protótipo mais novo vem primeiro na lista
        let mut q = sample(1); q["title"] = json!("Página de produto");
        write_in(&repo, "p-def", q, 3000).unwrap();
        std::fs::create_dir_all(protos_root(&repo).join("quebrado")).unwrap(); // pasta sem json: pulada
        let l = list_in(&repo);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["id"], "p-def");
        assert_eq!(l[1]["openPins"], 1);
        assert_eq!(l[1]["thumb"]["id"], "desk");
        assert!(read_in(&repo, "p-nao").is_err());
        assert!(write_in(&repo, "../fora", sample(1), 1).is_err());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn imagem_vai_e_volta() {
        let repo = tmp("asset");
        assert!(asset_put_in(&repo, "p-abc", "a.png", "aGVsbG8=").is_err(), "sem protótipo não grava");
        write_in(&repo, "p-abc", sample(1), 1).unwrap();
        let rel = asset_put_in(&repo, "p-abc", "a.png", "data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(rel, "assets/a.png");
        assert_eq!(std::fs::read(protos_root(&repo).join("p-abc/assets/a.png")).unwrap(), b"hello");
        assert_eq!(asset_url_in(&repo, "p-abc", "assets/a.png").unwrap(), "data:image/png;base64,aGVsbG8=");
        assert!(asset_url_in(&repo, "p-abc", "assets/../prototipo.json").is_err());
        assert!(asset_put_in(&repo, "p-abc", "a.sh", "aGVsbG8=").is_err());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn slug_e_pagina_da_tela() {
        assert_eq!(slug_of("Checkout com cupom!", "p-1"), "checkout-com-cupom");
        assert_eq!(slug_of("Ação rápida · Página", "p-1"), "acao-rapida-pagina");
        assert_eq!(slug_of("  ", "p-1"), "p-1");
        let h = screen_page("Loja <web>", &json!({ "name": "Desktop", "w": 1280, "html": "<b>oi</b>", "css": "b{color:red}</style><script>" }));
        assert!(h.contains("<title>Loja &lt;web&gt; · Desktop</title>"));
        assert!(h.contains("<b>oi</b>") && h.contains("width=1280"));
        assert!(!h.contains("</style><script>"), "o CSS não fecha o <style>");
    }

    #[test]
    fn exporta_pra_pasta_da_tarefa() {
        let repo = tmp("exp");
        let wt = tmp("exp-wt");
        write_in(&repo, "p-abc", sample(2), 1).unwrap();
        asset_put_in(&repo, "p-abc", "print.png", "aGVsbG8=").unwrap();
        let mut p3 = sample(3); p3["title"] = json!("Checkout com cupom");
        write_in(&repo, "p-abc", p3, 2).unwrap(); // gera versions/v2.json — que NÃO vai junto
        let dest = export_in(&repo, "p-abc", &wt).unwrap();
        assert_eq!(dest, wt.join("docs/prototipos/checkout-com-cupom"));
        assert!(dest.join("prototipo.json").exists() && dest.join("assets/print.png").exists());
        assert!(dest.join("desk.html").exists() && dest.join("cel.html").exists());
        assert!(!dest.join("versions").exists());
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&wt);
    }
}
