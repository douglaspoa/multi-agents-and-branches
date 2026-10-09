//! Relatório de entregas do período (aba Entregas › "Gerar relatório", 72/73 no front) → arquivos LOCAIS.
//! Nada sobe pra nuvem: o app monta o HTML autocontido (CSS inline, provas como data:, sem script) e aqui:
//!   - `relatorio_salvar` grava o HTML (ou o Markdown) onde a pessoa escolher (diálogo de salvar, padrão Downloads);
//!   - `relatorio_pdf` renderiza o MESMO HTML num WKWebView fora da tela (macOS), pede `createPDF` (uma página alta)
//!     e corta em páginas A4 com margem pelo CoreGraphics; depois pergunta onde salvar;
//!   - `relatorio_mostrar` revela no Finder só um arquivo que estes comandos gravaram nesta sessão.
//! Tudo async: o WKWebView vive na thread principal (run_on_main_thread em passos curtos), a espera é no tokio e o
//! corte das páginas roda em spawn_blocking — a janela nunca congela.
//! Paginação: o HTML que vira PDF (só ele) ganha um script que empurra cada bloco `.rl-keep` que cruzaria a borda da
//! página pra começar na seguinte e avisa a altura final pelo título (`sf-pdf:<altura>`).
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// largura do layout do documento (px CSS) — A4 a 96 dpi
pub const LARGURA: f64 = 794.0;
/// A4 em pontos e a margem de cada página
pub const A4_W: f64 = 595.0;
pub const A4_H: f64 = 842.0;
pub const MARGEM: f64 = 36.0;
const MAX_PAGINAS: usize = 120;

/// px CSS → pt da página (o conteúdo de LARGURA px cabe na largura útil do A4)
pub fn escala() -> f64 { (A4_W - 2.0 * MARGEM) / LARGURA }
/// altura útil de uma página, em px CSS do layout
pub fn altura_pagina() -> f64 { (A4_H - 2.0 * MARGEM) / escala() }
/// quantas páginas A4 um documento desta altura (px CSS) ocupa
pub fn paginas(altura: f64) -> usize {
    if !(altura.is_finite()) || altura <= 0.0 { return 0; }
    ((altura - 0.5) / altura_pagina()).floor() as usize + 1
}

/// Script SÓ do HTML que vira PDF (o arquivo salvo continua sem script). Empurra com um espaçador ANTES do bloco
/// (margin-top no 1º filho colapsava com a margem da seção e o empurrão ficava curto).
pub fn script_paginacao() -> String {
    let h = altura_pagina();
    format!(r#"<script>(function(){{var H={h:.3};function go(){{
var els=[].slice.call(document.querySelectorAll('.rl-keep'));
for(var i=0;i<els.length;i++){{var e=els[i];var r=e.getBoundingClientRect();var top=r.top+window.scrollY;
var need=r.height+(e.classList.contains('rl-kn')?96:0);if(need>=H-24)continue;
var p0=Math.floor(top/H),p1=Math.floor((top+need-1)/H);
if(p1>p0){{var sp=document.createElement('div');sp.style.height=((p1*H-top)+14)+'px';e.parentNode.insertBefore(sp,e);}}}}
document.title='sf-pdf:'+Math.ceil(document.documentElement.scrollHeight);}}
if(document.readyState==='complete')setTimeout(go,40);else window.addEventListener('load',function(){{setTimeout(go,40);}});}})();</script>"#)
}

/// HTML do relatório + script de paginação (antes do </body>; sem </body>, no fim)
pub fn html_pdf(html: &str) -> String {
    let s = script_paginacao();
    match html.rfind("</body>") {
        Some(i) => format!("{}{}{}", &html[..i], s, &html[i..]),
        None => format!("{html}{s}"),
    }
}

/// título do webview → altura final do documento (quando o script terminou)
pub fn altura_pronta(titulo: &str) -> Option<f64> {
    let v: f64 = titulo.strip_prefix("sf-pdf:")?.trim().parse().ok()?;
    (v.is_finite() && v > 0.0).then_some(v)
}

/// nome seguro do arquivo: "relatorio-entregas-<período>.<ext>" (só letras, números e '-')
pub fn nome_arquivo(nome: &str, ext: &str) -> String {
    let base: String = nome.trim().chars()
        .flat_map(|c| if c.is_alphanumeric() { c.to_lowercase().collect::<Vec<_>>() } else { vec!['-'] })
        .collect::<String>().split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let base = if base.is_empty() { "relatorio-entregas".to_string() } else { base.chars().take(80).collect() };
    format!("{base}.{ext}")
}

// ---- arquivos gravados nesta sessão (o "mostrar no Finder" só revela estes) ----
fn gravados() -> &'static Mutex<HashSet<String>> {
    static G: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    G.get_or_init(|| Mutex::new(HashSet::new()))
}
pub fn foi_gravado(p: &str) -> bool { gravados().lock().map(|g| g.contains(p)).unwrap_or(false) }

fn downloads() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let d = PathBuf::from(home).join("Downloads");
    if d.is_dir() { d } else { std::env::temp_dir() }
}

/// diálogo de salvar nativo (padrão Downloads + nome sugerido) sem prender a janela; None = a pessoa cancelou
async fn pedir_destino(app: &tauri::AppHandle, nome: &str, ext: &str) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let filtro = match ext { "pdf" => "PDF", "md" => "Markdown", _ => "Página HTML" };
    app.dialog().file()
        .set_directory(downloads())
        .set_file_name(nome_arquivo(nome, ext))
        .add_filter(filtro, &[ext])
        .save_file(move |p| { let _ = tx.send(p); });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await.ok().flatten()
        .and_then(|p| p.into_path().ok())
}

fn gravar(p: &PathBuf, bytes: &[u8]) -> Result<String, String> {
    std::fs::write(p, bytes).map_err(|e| format!("não consegui gravar o arquivo: {e}"))?;
    let s = p.display().to_string();
    if let Ok(mut g) = gravados().lock() { g.insert(s.clone()); }
    Ok(s)
}

/// Salva o relatório como HTML autocontido ou Markdown. Devolve o caminho, ou None se a pessoa cancelou.
#[tauri::command]
pub async fn relatorio_salvar(app: tauri::AppHandle, nome: String, ext: String, conteudo: String) -> Result<Option<String>, String> {
    let ext = match ext.as_str() { "md" => "md", "html" => "html", _ => return Err("formato desconhecido".into()) };
    if conteudo.len() > 60 * 1024 * 1024 { return Err("o relatório ficou grande demais pra salvar".into()); }
    let Some(p) = pedir_destino(&app, &nome, ext).await else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || gravar(&p, conteudo.as_bytes()))
        .await.map_err(|e| e.to_string())?.map(Some)
}

/// Gera o PDF do relatório (WKWebView fora da tela → createPDF → páginas A4) e salva onde a pessoa escolher.
#[tauri::command]
pub async fn relatorio_pdf(app: tauri::AppHandle, nome: String, html: String) -> Result<Option<String>, String> {
    if html.len() > 60 * 1024 * 1024 { return Err("o relatório ficou grande demais pra virar PDF".into()); }
    // primeiro o destino (cancelou = não gasta nada), depois o PDF
    let Some(p) = pedir_destino(&app, &nome, "pdf").await else { return Ok(None) };
    let pdf = gerar_pdf(&app, html).await?;
    tauri::async_runtime::spawn_blocking(move || gravar(&p, &pdf))
        .await.map_err(|e| e.to_string())?.map(Some)
}

/// "mostrar no Finder" — só um arquivo que relatorio_salvar/relatorio_pdf gravaram nesta sessão
#[tauri::command]
pub fn relatorio_mostrar(path: String) -> Result<(), String> {
    if !foi_gravado(&path) { return Err("esse arquivo não foi salvo por aqui".into()); }
    let p = PathBuf::from(&path);
    if !p.is_file() { return Err("o arquivo não está mais lá".into()); }
    let r = if cfg!(target_os = "macos") { std::process::Command::new("open").arg("-R").arg(&p).spawn() }
        else if cfg!(target_os = "windows") { explorer_select(&p) }
        else { std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn() };
    r.map(|_| ()).map_err(|e| format!("não consegui abrir a pasta: {e}"))
}

/// Explorer com "/select,<caminho>" — raw_arg (o Rust poria aspas no argumento inteiro e o caminho com espaço quebrava)
#[cfg(target_os = "windows")]
fn explorer_select(p: &std::path::Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", p.display())).spawn()
}
#[cfg(not(target_os = "windows"))]
fn explorer_select(p: &std::path::Path) -> std::io::Result<std::process::Child> { std::process::Command::new("open").arg("-R").arg(p).spawn() }

#[cfg(target_os = "macos")]
fn prox_id() -> u64 { static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1); N.fetch_add(1, std::sync::atomic::Ordering::Relaxed) }

/// roda `f` na thread principal e espera a resposta (sem bloquear quem chamou)
#[cfg(target_os = "macos")]
async fn na_principal<T: Send + 'static>(app: &tauri::AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = tx.send(f()); }).map_err(|e| format!("não consegui falar com a janela: {e}"))?;
    tokio::time::timeout(Duration::from_secs(10), rx).await
        .map_err(|_| "a janela não respondeu".to_string())?
        .map_err(|_| "a janela não respondeu".to_string())
}

#[cfg(target_os = "macos")]
pub async fn gerar_pdf(app: &tauri::AppHandle, html: String) -> Result<Vec<u8>, String> {
    let id = prox_id();
    let doc = html_pdf(&html);
    let r = async {
        na_principal(app, move || mac::criar(id, &doc)).await??;
        // espera o documento montar e paginar (até 25 s — imagens grandes em data: demoram)
        let mut alt = None;
        for _ in 0..250 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Some(h) = altura_pronta(&na_principal(app, move || mac::titulo(id)).await?) { alt = Some(h); break; }
        }
        let h = alt.ok_or("o relatório demorou demais pra montar")?;
        if paginas(h) > MAX_PAGINAS { return Err(format!("o relatório passou de {MAX_PAGINAS} páginas — escolha um período menor")); }
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
        let tx = std::sync::Mutex::new(Some(tx));
        na_principal(app, move || mac::pdf(id, h, Box::new(move |r| { if let Some(t) = tx.lock().ok().and_then(|mut g| g.take()) { let _ = t.send(r); } }))).await?;
        let alto = tokio::time::timeout(Duration::from_secs(30), rx).await
            .map_err(|_| "o PDF demorou demais".to_string())?
            .map_err(|_| "o PDF foi cancelado".to_string())??;
        tauri::async_runtime::spawn_blocking(move || paginar(&alto)).await.map_err(|e| e.to_string())?
    }.await;
    // SEMPRE fecha (também quando criar estourou o tempo e rodou depois): sem WKWebView preso em VIEWS
    let _ = app.run_on_main_thread(move || mac::fechar(id));
    r
}

#[cfg(not(target_os = "macos"))]
pub async fn gerar_pdf(_app: &tauri::AppHandle, _html: String) -> Result<Vec<u8>, String> {
    Err("o PDF por enquanto só sai no macOS — use \"Salvar como HTML\" e imprima pelo navegador".into())
}

/// Corta o PDF de UMA página alta (createPDF) em páginas A4 com margem. Roda em qualquer thread.
#[cfg(target_os = "macos")]
pub fn paginar(alto: &[u8]) -> Result<Vec<u8>, String> {
    use objc2_core_foundation::{CFData, CFMutableData, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGContext, CGDataConsumer, CGDataProvider, CGPDFBox, CGPDFContextBeginPage, CGPDFContextClose, CGPDFContextCreate, CGPDFContextEndPage, CGPDFDocument, CGPDFPage};
    let data = CFData::from_bytes(alto);
    let prov = CGDataProvider::with_cf_data(Some(&data)).ok_or("PDF ilegível")?;
    let doc = CGPDFDocument::with_provider(Some(&prov)).ok_or("PDF ilegível")?;
    if CGPDFDocument::number_of_pages(Some(&doc)) < 1 { return Err("PDF vazio".into()); }
    let page = CGPDFDocument::page(Some(&doc), 1).ok_or("PDF sem página")?;
    let mb = CGPDFPage::box_rect(Some(&page), CGPDFBox::MediaBox);
    let (w0, h0) = (mb.size.width, mb.size.height);
    if !(w0 > 10.0 && h0 > 10.0) { return Err("PDF sem tamanho".into()); }
    let s = (A4_W - 2.0 * MARGEM) / w0;          // pt da página por unidade do PDF alto
    let ph = (A4_H - 2.0 * MARGEM) / s;          // altura útil de uma página em unidades do PDF alto
    let n = ((h0 - 0.5) / ph).floor() as usize + 1;
    if n > MAX_PAGINAS { return Err(format!("o relatório passou de {MAX_PAGINAS} páginas — escolha um período menor")); }
    let out = CFMutableData::new(None, 0).ok_or("sem memória pro PDF")?;
    let cons = CGDataConsumer::with_cf_data(Some(&out)).ok_or("sem memória pro PDF")?;
    let media = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(A4_W, A4_H));
    let ctx = unsafe { CGPDFContextCreate(Some(&cons), &media, None) }.ok_or("não consegui criar o PDF")?;
    for i in 0..n {
        unsafe { CGPDFContextBeginPage(Some(&ctx), None) };
        CGContext::save_g_state(Some(&ctx));
        CGContext::clip_to_rect(Some(&ctx), CGRect::new(CGPoint::new(MARGEM, MARGEM), CGSize::new(A4_W - 2.0 * MARGEM, A4_H - 2.0 * MARGEM)));
        CGContext::translate_ctm(Some(&ctx), MARGEM, MARGEM);
        CGContext::scale_ctm(Some(&ctx), s, s);
        // a fatia i (de cima pra baixo) do PDF alto, que tem a origem embaixo
        CGContext::translate_ctm(Some(&ctx), -mb.origin.x, -(mb.origin.y + h0 - (i as f64 + 1.0) * ph));
        CGContext::draw_pdf_page(Some(&ctx), Some(&page));
        CGContext::restore_g_state(Some(&ctx));
        CGPDFContextEndPage(Some(&ctx));
    }
    CGPDFContextClose(Some(&ctx));
    drop(ctx); drop(cons);
    Ok(out.to_vec())
}

/// Partes que tocam o WKWebView: SEMPRE na thread principal. O webview fica guardado por id enquanto o PDF sai.
#[cfg(target_os = "macos")]
pub mod mac {
    use super::LARGURA;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadOnly;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{MainThreadMarker, NSData, NSError, NSString};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView, WKWebViewConfiguration};
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! { static VIEWS: RefCell<HashMap<u64, Retained<WKWebView>>> = RefCell::new(HashMap::new()); }

    pub type Pronto = Box<dyn FnOnce(Result<Vec<u8>, String>) + 'static>;

    fn mtm() -> Result<MainThreadMarker, String> { MainThreadMarker::new().ok_or_else(|| "fora da thread principal".to_string()) }
    fn com<T>(id: u64, f: impl FnOnce(&WKWebView) -> T) -> Option<T> { VIEWS.with(|v| v.borrow().get(&id).map(|w| f(w))) }

    /// cria o webview fora da tela (sem janela) e carrega o HTML
    pub fn criar(id: u64, html: &str) -> Result<(), String> {
        let mtm = mtm()?;
        let res = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
            let cfg = WKWebViewConfiguration::new(mtm);
            let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(LARGURA, 1200.0));
            let wv = WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &cfg);
            let _ = wv.loadHTMLString_baseURL(&NSString::from_str(html), None);
            wv
        }));
        let wv = res.map_err(|_| "o macOS recusou montar o relatório".to_string())?;
        VIEWS.with(|v| { v.borrow_mut().insert(id, wv); });
        Ok(())
    }
    /// título atual (o script de paginação escreve "sf-pdf:<altura>" quando termina)
    pub fn titulo(id: u64) -> String {
        com(id, |w| unsafe { w.title() }.map(|t| t.to_string()).unwrap_or_default()).unwrap_or_default()
    }
    /// createPDF do documento inteiro (altura `h` px CSS) — `pronto` é chamado na thread principal
    pub fn pdf(id: u64, h: f64, pronto: Pronto) {
        let cell = std::rc::Rc::new(RefCell::new(Some(pronto)));
        let fim = { let c = cell.clone(); move |r: Result<Vec<u8>, String>| { if let Some(f) = c.borrow_mut().take() { f(r); } } };
        let Ok(mtm) = mtm() else { fim(Err("fora da thread principal".into())); return };
        let fim2 = fim.clone();
        let ok = com(id, move |w| {
            let res = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
                w.setFrame(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(LARGURA, h)));
                let cfg = WKPDFConfiguration::new(mtm);
                cfg.setRect(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(LARGURA, h)));
                let f = fim2.clone();
                let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                    let r = match data.as_ref() {
                        Some(d) if d.length() > 0 => Ok(d.to_vec()),
                        _ => Err(format!("o PDF falhou: {}", err.as_ref().map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "sem dados".into()))),
                    };
                    f(r);
                });
                w.createPDFWithConfiguration_completionHandler(Some(&cfg), &block);
            }));
            if res.is_err() { fim2(Err("o macOS recusou gerar o PDF".into())); }
        });
        if ok.is_none() { fim(Err("o relatório não está mais aberto".into())); }
    }
    pub fn fechar(id: u64) { VIEWS.with(|v| { v.borrow_mut().remove(&id); }); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pagina_a4_com_margem_em_px_do_layout() {
        assert!((escala() - 523.0 / 794.0).abs() < 1e-9);
        assert!((altura_pagina() - 770.0 * 794.0 / 523.0).abs() < 1e-6);
        assert_eq!(paginas(0.0), 0);
        assert_eq!(paginas(10.0), 1);
        assert_eq!(paginas(altura_pagina()), 1);
        assert_eq!(paginas(altura_pagina() + 1.0), 2);
        assert_eq!(paginas(f64::NAN), 0);
    }

    #[test]
    fn script_so_no_html_do_pdf_e_altura_pelo_titulo() {
        let h = html_pdf("<html><body><p>oi</p></body></html>");
        assert!(h.contains("<p>oi</p><script>") && h.ends_with("</body></html>"));
        assert!(html_pdf("<p>x</p>").starts_with("<p>x</p><script>"));
        assert!(script_paginacao().contains("rl-keep") && script_paginacao().contains("sf-pdf:"));
        assert_eq!(altura_pronta("sf-pdf:1234"), Some(1234.0));
        assert_eq!(altura_pronta("Relatório"), None);
        assert_eq!(altura_pronta("sf-pdf:0"), None);
        assert_eq!(altura_pronta("sf-pdf:abc"), None);
    }

    #[test]
    fn nome_do_arquivo_seguro() {
        assert_eq!(nome_arquivo("relatorio-entregas-Últimos 7 dias", "pdf"), "relatorio-entregas-últimos-7-dias.pdf");
        assert_eq!(nome_arquivo("../../etc/passwd", "html"), "etc-passwd.html");
        assert_eq!(nome_arquivo("", "md"), "relatorio-entregas.md");
    }

    #[test]
    fn mostrar_so_o_que_foi_gravado_aqui() {
        assert!(relatorio_mostrar("/etc/hosts".into()).is_err());
        let d = std::env::temp_dir().join(format!("sf-rel-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("r.html");
        let s = gravar(&p, b"<p>ok</p>").unwrap();
        assert!(foi_gravado(&s));
        assert_eq!(std::fs::read(&p).unwrap(), b"<p>ok</p>");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// corta um PDF alto de verdade (CoreGraphics) em páginas A4: o número de páginas bate com a altura e cada página
    /// mostra a SUA fatia, na ordem (faixas de cor por altura no PDF alto; o centro de cada página A4 é conferido)
    #[cfg(target_os = "macos")]
    #[test]
    fn paginar_pdf_alto_em_a4() {
        use objc2_core_foundation::{CFData, CFMutableData, CGPoint, CGRect, CGSize};
        use objc2_core_graphics::{CGBitmapContextCreate, CGColorSpace, CGContext, CGDataConsumer, CGDataProvider, CGPDFContextBeginPage, CGPDFContextClose, CGPDFContextCreate, CGPDFContextEndPage, CGPDFDocument};
        let ph = altura_pagina();
        let alto = ph * 2.5;
        let cores = [0.2, 0.5, 0.8]; // vermelho de cada faixa, de CIMA pra baixo
        let out = CFMutableData::new(None, 0).unwrap();
        let cons = CGDataConsumer::with_cf_data(Some(&out)).unwrap();
        let media = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(LARGURA, alto));
        let ctx = unsafe { CGPDFContextCreate(Some(&cons), &media, None) }.unwrap();
        unsafe { CGPDFContextBeginPage(Some(&ctx), None) };
        for (k, r) in cores.iter().enumerate() {
            CGContext::set_rgb_fill_color(Some(&ctx), *r, 0.0, 0.0, 1.0);
            let y0 = (alto - (k as f64 + 1.0) * ph).max(0.0);
            CGContext::fill_rect(Some(&ctx), CGRect::new(CGPoint::new(0.0, y0), CGSize::new(LARGURA, alto - k as f64 * ph - y0)));
        }
        CGPDFContextEndPage(Some(&ctx)); CGPDFContextClose(Some(&ctx));
        drop(ctx); drop(cons);
        let pdf = paginar(&out.to_vec()).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        let d = CFData::from_bytes(&pdf);
        let doc = CGPDFDocument::with_provider(CGDataProvider::with_cf_data(Some(&d)).as_deref()).unwrap();
        assert_eq!(CGPDFDocument::number_of_pages(Some(&doc)), 3);
        // cada página A4 renderizada em 1/10: o pixel a 30% do topo tem o vermelho da faixa i
        let (w, h) = (60usize, 85usize);
        let cs = CGColorSpace::new_device_rgb().unwrap();
        for i in 0..3 {
            let mut buf = vec![0u8; w * h * 4];
            let bm = unsafe { CGBitmapContextCreate(buf.as_mut_ptr().cast(), w, h, 8, w * 4, Some(&cs), 1) }.unwrap();
            CGContext::scale_ctm(Some(&bm), w as f64 / A4_W, h as f64 / A4_H);
            let pg = CGPDFDocument::page(Some(&doc), i + 1).unwrap();
            CGContext::draw_pdf_page(Some(&bm), Some(&pg));
            drop(bm);
            let c = &buf[((h * 3 / 10) * w + w / 2) * 4..][..4]; // 30% do topo: dentro da fatia (a 3ª só tem meia faixa)
            let r = c[0] as f64 / 255.0;
            assert!((r - cores[i]).abs() < 0.06, "página {} com vermelho {r:.2}, esperado {}", i + 1, cores[i]);
        }
        assert!(paginar(b"isso nao e pdf").is_err());
    }
}
