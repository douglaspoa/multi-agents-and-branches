//! NAVEGADOR de verdade (pivot 2 — decisão do dono): site externo (YouTube, documentação…) numa aba "Navegador" é um
//! WKWebView FILHO da janela (multiwebview do Tauri, feature `unstable`), posicionado exatamente sobre o painel —
//! como o navegador do Claude Desktop. Num `<iframe>` o YouTube recusava (erro 153: origem `tauri://` sem Referer) e
//! muitos sites mandam `X-Frame-Options`/`frame-ancestors`.
//!
//! Isolamento (o site é de fora):
//!  - rótulo `sfweb-<id>`: a capability do app vale SÓ pro webview "main" (`capabilities/default.json` → `webviews`),
//!    então este webview não tem permissão nenhuma — e a origem é remota (o Tauri nega IPC de origem remota sem
//!    `remote.urls`, que o app não declara);
//!  - navegação presa a http(s) (`tauri://`, `file:`, `javascript:`… são recusados);
//!  - armazenamento ISOLADO e efêmero (`incognito`): cookies do site não se misturam com os do app;
//!  - janela nova (`target=_blank`/`window.open`) abre na MESMA aba (nada de janela solta).
//! Tudo assíncrono; a posição vem do front (ResizeObserver no painel) — nada de polling aqui.

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Url};

pub const LABEL_PREFIX: &str = "sfweb-";
/// User-Agent de Safari: sites que olham o UA (YouTube, docs) servem a versão completa
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/// Rótulo do webview filho: `sfweb-` + [a-z0-9]{1,40}. Nunca "main" nem outro rótulo do app. Puro (testado).
pub fn label_ok(l: &str) -> bool {
    l.len() > LABEL_PREFIX.len() && l.len() <= LABEL_PREFIX.len() + 40 && l.starts_with(LABEL_PREFIX)
        && l[LABEL_PREFIX.len()..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}
/// Endereço que a aba pode abrir: só http(s), com host, sem usuário/senha embutidos, ≤ 4096. Puro (testado).
pub fn url_ok(s: &str) -> Result<Url, String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 4096 { return Err("endereço inválido".into()); }
    let u = Url::parse(s).map_err(|_| "endereço inválido".to_string())?;
    if !matches!(u.scheme(), "http" | "https") { return Err("só endereços http(s) abrem no Navegador".into()); }
    if u.host_str().map_or(true, |h| h.is_empty()) { return Err("endereço sem site".into()); }
    if !u.username().is_empty() || u.password().is_some() { return Err("endereço com usuário/senha não abre aqui".into()); }
    Ok(u)
}
/// Pra onde o site pode navegar dentro da aba: http(s) e about:blank. Nada de tauri://, file:, data:, javascript:.
pub fn nav_allowed(u: &Url) -> bool { matches!(u.scheme(), "http" | "https") || u.as_str() == "about:blank" }

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }
/// Retângulo do painel (px CSS = pontos da janela) → limites do webview dentro da janela: números sãos, preso à
/// janela, arredondado; pequeno demais (< 40×40) = não mostra. Puro (testado).
pub fn bounds(r: &Rect, win_w: f64, win_h: f64) -> Option<Rect> {
    if ![r.x, r.y, r.w, r.h, win_w, win_h].iter().all(|v| v.is_finite()) || win_w <= 0.0 || win_h <= 0.0 { return None; }
    let x = r.x.max(0.0).min(win_w);
    let y = r.y.max(0.0).min(win_h);
    let w = (r.x + r.w).min(win_w) - x;
    let h = (r.y + r.h).min(win_h) - y;
    if w < 40.0 || h < 40.0 { return None; }
    Some(Rect { x: x.round(), y: y.round(), w: w.round(), h: h.round() })
}

fn main_window(app: &AppHandle) -> Result<tauri::Window, String> {
    app.get_webview("main").map(|w| w.window()).ok_or_else(|| "janela principal não encontrada".to_string())
}
fn win_size(win: &tauri::Window) -> (f64, f64) {
    let k = win.scale_factor().unwrap_or(1.0);
    win.inner_size().map(|s| (s.width as f64 / k, s.height as f64 / k)).unwrap_or((0.0, 0.0))
}
fn child(app: &AppHandle, label: &str) -> Option<tauri::Webview> { if label_ok(label) { app.get_webview(label) } else { None } }
fn place(wv: &tauri::Webview, b: Rect) -> Result<(), String> {
    wv.set_position(tauri::LogicalPosition::new(b.x, b.y)).map_err(|e| e.to_string())?;
    wv.set_size(tauri::LogicalSize::new(b.w, b.h)).map_err(|e| e.to_string())
}
fn nav_event(app: &AppHandle, label: &str, url: &str, loading: Option<bool>, title: Option<String>) {
    let _ = app.emit_to("main", "web-nav", json!({ "label": label, "url": url, "loading": loading, "title": title }));
}

/// Abre (ou reposiciona e mostra) o navegador da aba. `rect` = área do painel em px CSS.
#[tauri::command(async)]
pub fn web_open(app: AppHandle, label: String, url: String, rect: Rect) -> Result<(), String> {
    if !label_ok(&label) { return Err("aba inválida".into()); }
    let u = url_ok(&url)?;
    let win = main_window(&app)?;
    let (ww, wh) = win_size(&win);
    let b = bounds(&rect, ww, wh);
    if let Some(wv) = child(&app, &label) {
        if let Some(b) = b { place(&wv, b)?; let _ = wv.show(); } else { let _ = wv.hide(); }
        return Ok(());
    }
    let b0 = b.unwrap_or(Rect { x: 0.0, y: 0.0, w: 40.0, h: 40.0 });
    let (a1, a2, a3, l1, l2, l3) = (app.clone(), app.clone(), app.clone(), label.clone(), label.clone(), label.clone());
    let builder = tauri::WebviewBuilder::new(&label, tauri::WebviewUrl::External(u))
        .incognito(true)
        .user_agent(UA)
        .devtools(cfg!(debug_assertions))
        .on_navigation(|u| nav_allowed(u))
        .on_page_load(move |_wv, p| {
            let loading = matches!(p.event(), tauri::webview::PageLoadEvent::Started);
            nav_event(&a1, &l1, p.url().as_str(), Some(loading), None);
        })
        .on_document_title_changed(move |wv, title| {
            // navegação "por dentro" (YouTube troca de vídeo sem recarregar) também muda o título: endereço atualizado
            let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
            nav_event(&a2, &l2, &url, None, Some(title.chars().take(200).collect()));
        })
        .on_new_window(move |url, _features| {
            // _blank / window.open: abre na mesma aba (sem janela solta, sem fugir do isolamento)
            if nav_allowed(&url) { if let Some(wv) = a3.get_webview(&l3) { let _ = wv.navigate(url); } }
            tauri::webview::NewWindowResponse::Deny
        });
    let wv = win.add_child(builder, tauri::LogicalPosition::new(b0.x, b0.y), tauri::LogicalSize::new(b0.w, b0.h)).map_err(|e| format!("não consegui abrir o navegador: {e}"))?;
    if b.is_none() { let _ = wv.hide(); }
    super::web_log(format!("[navegador] {label}: aberto"));
    Ok(())
}

/// Reposiciona/redimensiona (painel mudou de tamanho/lugar). Sem retângulo válido = esconde.
#[tauri::command(async)]
pub fn web_bounds(app: AppHandle, label: String, rect: Rect) -> Result<(), String> {
    let Some(wv) = child(&app, &label) else { return Ok(()) };
    let win = main_window(&app)?;
    let (ww, wh) = win_size(&win);
    match bounds(&rect, ww, wh) { Some(b) => place(&wv, b), None => wv.hide().map_err(|e| e.to_string()) }
}

/// Mostra/esconde (aba de fundo, menu do app por cima, arrastando aba). Esconder PAUSA o que estiver tocando.
#[tauri::command(async)]
pub fn web_show(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    let Some(wv) = child(&app, &label) else { return Ok(()) };
    if visible { wv.show().map_err(|e| e.to_string()) } else {
        let _ = wv.eval("try{document.querySelectorAll('video,audio').forEach(m=>{try{m.pause()}catch(_){}})}catch(_){}");
        wv.hide().map_err(|e| e.to_string())
    }
}

/// Voltar / avançar / recarregar / ir pra um endereço (barra da aba).
#[tauri::command(async)]
pub fn web_nav(app: AppHandle, label: String, action: String, url: Option<String>) -> Result<(), String> {
    let Some(wv) = child(&app, &label) else { return Err("o navegador desta aba não está aberto".into()) };
    match action.as_str() {
        "back" => wv.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => wv.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => wv.reload().map_err(|e| e.to_string()),
        "go" => { let u = url_ok(url.as_deref().unwrap_or(""))?; wv.navigate(u).map_err(|e| e.to_string()) }
        _ => Err("ação inválida".into()),
    }
}

/// Fecha (aba fechada / tirada da tela / congelada pelo teto de páginas vivas).
#[tauri::command(async)]
pub fn web_close(app: AppHandle, label: String) -> Result<bool, String> {
    match child(&app, &label) { Some(wv) => { wv.close().map_err(|e| e.to_string())?; Ok(true) } None => Ok(false) }
}

/// Print do que o navegador da aba está mostrando (o WKWebView filho inteiro).
pub async fn snapshot(app: &AppHandle, label: &str) -> Result<Vec<u8>, String> {
    let wv = child(app, label).ok_or("o navegador desta aba não está aberto")?;
    let s = wv.size().map_err(|e| e.to_string())?;
    let k = wv.window().scale_factor().unwrap_or(1.0);
    super::navegador::snapshot_of(&wv, super::navegador::SnapRect { x: 0.0, y: 0.0, w: s.width as f64 / k, h: s.height as f64 / k }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotulo_so_dos_navegadores() {
        assert!(label_ok("sfweb-abc123"));
        for bad in ["main", "sfweb-", "sfweb-ABC", "sfweb-a_b", "sfweb-a.b", "xsfweb-a", "sfweb-a/../main", &("sfweb-".to_string() + &"a".repeat(41))] {
            assert!(!label_ok(bad), "{bad}");
        }
    }

    #[test]
    fn endereco_so_http_https() {
        assert_eq!(url_ok(" https://www.youtube.com/watch?v=aqz-KE-bpKQ ").unwrap().host_str(), Some("www.youtube.com"));
        assert!(url_ok("http://127.0.0.1:4100/").is_ok());
        for bad in ["", "javascript:alert(1)", "file:///etc/passwd", "tauri://localhost/index.html", "data:text/html,x", "https://u:p@x.com", "about:blank", "https://", "ftp://x.com"] {
            assert!(url_ok(bad).is_err(), "{bad}");
        }
        assert!(url_ok(&("https://x.com/".to_string() + &"a".repeat(5000))).is_err(), "endereço gigante");
        let ok = |s: &str| nav_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://m.youtube.com/watch?v=1")); assert!(ok("about:blank"));
        assert!(!ok("tauri://localhost/")); assert!(!ok("file:///Users")); assert!(!ok("javascript:alert(1)")); assert!(!ok("about:srcdoc"));
    }

    #[test]
    fn retangulo_preso_na_janela() {
        let r = |x, y, w, h| Rect { x, y, w, h };
        assert_eq!(bounds(&r(250.4, 96.6, 600.2, 700.0), 1440.0, 900.0), Some(r(250.0, 97.0, 600.0, 700.0)));
        assert_eq!(bounds(&r(1000.0, 100.0, 800.0, 900.0), 1440.0, 900.0), Some(r(1000.0, 100.0, 440.0, 800.0)), "corta no fim da janela");
        assert_eq!(bounds(&r(-30.0, -10.0, 300.0, 300.0), 1440.0, 900.0), Some(r(0.0, 0.0, 270.0, 290.0)), "não sai pra fora");
        assert_eq!(bounds(&r(10.0, 10.0, 30.0, 300.0), 1440.0, 900.0), None, "estreito demais: esconde");
        assert_eq!(bounds(&r(1430.0, 10.0, 300.0, 300.0), 1440.0, 900.0), None, "fora da janela");
        assert_eq!(bounds(&r(f64::NAN, 0.0, 300.0, 300.0), 1440.0, 900.0), None);
        assert_eq!(bounds(&r(0.0, 0.0, 300.0, 300.0), 0.0, 900.0), None, "janela sem tamanho");
    }

    #[test]
    fn capability_nao_alcanca_o_navegador() {
        // as permissões do app valem só pro webview "main"; nenhum rótulo sfweb-* (nem padrão com curinga) aparece
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities/default.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["webviews"], json!(["main"]), "capability presa ao webview main");
        assert!(v.get("windows").is_none(), "por janela, o filho herdaria as permissões da janela main");
        assert!(v.get("remote").is_none(), "nenhuma origem remota com acesso à ponte");
        assert!(!raw.contains("sfweb") && !raw.contains('*'), "nada que case com o rótulo do navegador");
    }
}
