//! Prévia + modo design (spec-navegador-design): um proxy local POR TAREFA (processo `node cli browser-proxy`,
//! src/browser-proxy.ts) e o print nativo do WKWebView pro recorte do elemento / "tirar print".
//!
//! Por que o proxy é do motor (Node) e não daqui: o Rust só tem tokio cru — faltaria HTTP/1.1 na mão, TLS pra
//! prévia remota e gzip/br. O app já embarca e roda o mesmo cli.mjs. Este módulo só cuida do processo:
//! - stdin em pipe = cordão umbilical (o app morreu → o pipe fecha → o proxy sai sozinho);
//! - um por tarefa; trocar de origem reinicia; `close`/`kill_all` derrubam.
//!
//! Print: `takeSnapshotWithConfiguration` do WKWebView da janela principal com `rect` em pontos (= px CSS do app,
//! que não usa zoom). Captura o que está NA TELA, inclusive o iframe de outra origem. Fora do macOS: erro humano.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub port: u16,
    /// origem do proxy (http://127.0.0.1:PORTA) — é o src do iframe
    pub origin: String,
    /// origem alvo que o proxy serve
    pub target: String,
}

struct ProxyProc {
    child: Child,
    info: BrowserInfo,
}

fn registry() -> &'static Mutex<HashMap<String, ProxyProc>> {
    static R: OnceLock<Mutex<HashMap<String, ProxyProc>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_local_host(h: &str) -> bool {
    let h = h.trim_start_matches('[').trim_end_matches(']').to_lowercase();
    h == "localhost" || h == "::1" || h == "0.0.0.0" || h.starts_with("127.") || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".test")
}

/// URL digitada → origem alvo (`http(s)://host[:porta]`). Mesmas regras do `normalizeTarget` do motor:
/// só http/https; sem esquema, local vira http e o resto https; sem usuário/senha. Puro (testado).
pub fn target_origin(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() { return Err("digite um endereço".into()); }
    let lower = s.to_lowercase();
    let has_scheme = lower.find("://").map(|i| lower[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))).unwrap_or(false);
    let (scheme, rest) = if has_scheme {
        let i = lower.find("://").unwrap();
        (lower[..i].to_string(), &s[i + 3..])
    } else {
        // "javascript:…", "data:…", "file:…" sem // também têm esquema — e não são host:porta
        if let Some(i) = lower.find(':') {
            let after = &lower[i + 1..];
            let port_like = after.chars().take_while(|c| c.is_ascii_digit()).count() > 0;
            if !port_like { return Err("só endereços http(s) abrem na prévia".into()); }
        }
        let host = lower.split(['/', ':', '?', '#']).next().unwrap_or("");
        (if is_local_host(host) { "http".into() } else { "https".into() }, s)
    };
    if scheme != "http" && scheme != "https" { return Err("só endereços http(s) abrem na prévia".into()); }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') { return Err("endereço com usuário/senha não é aceito — tire a parte antes do @".into()); }
    let (host, port) = if authority.starts_with('[') {
        match authority.find(']') {
            Some(i) => (&authority[..=i], authority[i + 1..].strip_prefix(':')),
            None => return Err("endereço inválido".into()),
        }
    } else {
        match authority.rsplit_once(':') { Some((h, p)) => (h, Some(p)), None => (authority, None) }
    };
    let host = host.to_lowercase();
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || "<>\"'\\".contains(c)) { return Err("endereço sem servidor".into()); }
    let port = match port {
        Some(p) if !p.is_empty() => Some(p.parse::<u16>().map_err(|_| "porta inválida".to_string())?),
        _ => None,
    };
    let default = if scheme == "https" { 443 } else { 80 };
    Ok(match port { Some(p) if p != default => format!("{scheme}://{host}:{p}"), _ => format!("{scheme}://{host}") })
}

/// 1ª linha do proxy: `{"port":N,"origin":…,"target":…}` ou `{"error":…}`. Puro (testado).
pub fn parse_ready_line(line: &str) -> Result<BrowserInfo, String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| format!("o proxy da prévia respondeu algo estranho: {}", line.chars().take(160).collect::<String>()))?;
    if let Some(e) = v.get("error").and_then(|x| x.as_str()) { return Err(e.to_string()); }
    let port = v.get("port").and_then(|x| x.as_u64()).filter(|p| *p > 0 && *p <= 65535).ok_or("o proxy da prévia não disse a porta")? as u16;
    let target = v.get("target").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(BrowserInfo { port, origin: format!("http://127.0.0.1:{port}"), target })
}

/// Sobe o proxy (`cmd` já é o node com as flags + o cli + `browser-proxy --target …`) e espera a porta (10 s).
fn spawn_proxy(mut cmd: Command) -> Result<ProxyProc, String> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("não consegui rodar o proxy da prévia (node): {e}"))?;
    let out = child.stdout.take().ok_or("sem saída do proxy")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut r = BufReader::new(out);
        let mut line = String::new();
        // pula aviso que não é JSON (ExperimentalWarning etc.); a 1ª linha com { é a resposta
        while r.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
            if line.trim_start().starts_with('{') { let _ = tx.send(line.clone()); break; }
            line.clear();
        }
        // segue drenando o stdout (o proxy não escreve mais, mas um pipe cheio travaria o processo)
        let mut sink = String::new();
        while r.read_line(&mut sink).map(|n| n > 0).unwrap_or(false) { sink.clear(); }
    });
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(line) => match parse_ready_line(&line) {
            Ok(info) => Ok(ProxyProc { child, info }),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); Err(e) }
        },
        Err(_) => { let _ = child.kill(); let _ = child.wait(); Err("o proxy da prévia não subiu em 10 s".into()) }
    }
}

fn kill(mut p: ProxyProc) {
    drop(p.child.stdin.take()); // fecha o cordão: o proxy sai sozinho
    let _ = p.child.kill();
    std::thread::spawn(move || { let _ = p.child.wait(); });
}

/// Abre (ou reaproveita) o proxy da tarefa pra origem de `url`. `make` monta o comando do node pra uma origem.
pub fn open(task_id: &str, url: &str, make: impl Fn(&str) -> Command) -> Result<BrowserInfo, String> {
    let origin = target_origin(url)?;
    {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = reg.get_mut(task_id) {
            let alive = matches!(p.child.try_wait(), Ok(None));
            if alive && p.info.target == origin { return Ok(p.info.clone()); }
        }
        if let Some(old) = reg.remove(task_id) { kill(old); }
    }
    // sobe FORA da trava (até 10 s): outras tarefas não esperam esta
    let p = spawn_proxy(make(&origin))?;
    let info = p.info.clone();
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = reg.insert(task_id.to_string(), p) { kill(old); }
    Ok(info)
}

/// Derruba o proxy da tarefa. true = havia um.
pub fn close(task_id: &str) -> bool {
    let p = registry().lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
    match p { Some(p) => { kill(p); true } None => false }
}

/// App saindo: nenhum proxy fica pra trás.
pub fn kill_all() {
    let all: Vec<ProxyProc> = registry().lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, p)| p).collect();
    for p in all { kill(p); }
}

/// Próximo `browser-<n>.png` livre na pasta de artefatos (n = maior existente + 1). Puro sobre o disco (testado).
pub fn next_artifact_name(dir: &Path) -> String {
    let mut max = 0u32;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(num) = n.strip_prefix("browser-").and_then(|r| r.strip_suffix(".png")).and_then(|r| r.parse::<u32>().ok()) {
                max = max.max(num);
            }
        }
    }
    format!("browser-{}.png", max + 1)
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct SnapRect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

/// Retângulo válido pro print: positivo, finito, ≥ 2×2 e ≤ 8000 (protege o WKWebView de pedido absurdo).
pub fn snap_rect_ok(r: &SnapRect) -> Result<SnapRect, String> {
    let ok = [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite());
    if !ok || r.w < 2.0 || r.h < 2.0 || r.w > 8000.0 || r.h > 8000.0 || r.x < 0.0 || r.y < 0.0 { return Err("área do print inválida (o elemento está fora da tela?)".into()); }
    Ok(SnapRect { x: r.x.round(), y: r.y.round(), w: r.w.round(), h: r.h.round() })
}

/// PNG do pedaço da janela principal (macOS). Roda o snapshot na thread principal e espera até 8 s.
#[cfg(target_os = "macos")]
pub async fn snapshot(app: &tauri::AppHandle, r: SnapRect) -> Result<Vec<u8>, String> {
    use std::sync::Arc;
    use tauri::Manager;
    let r = snap_rect_ok(&r)?;
    let win = app.get_webview_window("main").ok_or("janela principal não encontrada")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx2 = tx.clone();
    win.with_webview(move |pw| {
        let wk = pw.inner();
        let tx3 = tx2.clone();
        let res = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe { mac::take(wk, r, tx3) }));
        if res.is_err() { mac::send(&tx2, Err("o macOS recusou o print da prévia".into())); }
    }).map_err(|e| format!("não consegui pedir o print: {e}"))?;
    match tokio::time::timeout(Duration::from_secs(8), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => Err("o print foi cancelado".into()),
        Err(_) => Err("o print demorou demais".into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn snapshot(_app: &tauri::AppHandle, r: SnapRect) -> Result<Vec<u8>, String> {
    snap_rect_ok(&r)?;
    Err("o print da prévia por enquanto só funciona no macOS — o resto (seletor, HTML, estilos) vai normalmente".into())
}

/// Autoteste do print nativo (só com a variável de ambiente; nunca no uso normal):
/// `STARFORK_NAV_SELFTEST="<url do proxy>|<saida.png>"` → põe um iframe da URL por cima da janela, espera carregar,
/// tira o print daquele pedaço pelo MESMO caminho do app (snapshot) e grava o PNG; depois fecha o app.
/// Prova no WKWebView real: iframe http dentro do app + recorte nativo de conteúdo de outra origem.
pub fn selftest_from_env(app: &tauri::AppHandle) {
    let Ok(spec) = std::env::var("STARFORK_NAV_SELFTEST") else { return };
    let Some((url, out)) = spec.split_once('|').map(|(a, b)| (a.to_string(), b.to_string())) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        tokio::time::sleep(Duration::from_secs(4)).await;
        if let Some(w) = app.get_webview_window("main") {
            let js = format!("(()=>{{const f=document.createElement('iframe');f.src={};f.style.cssText='position:fixed;left:40px;top:60px;width:420px;height:320px;border:0;z-index:2147483647;background:#fff';f.setAttribute('sandbox','allow-scripts allow-same-origin');document.body.appendChild(f);}})()", serde_json::to_string(&url).unwrap_or_default());
            let _ = w.eval(&js);
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
        let r = snapshot(&app, SnapRect { x: 40.0, y: 60.0, w: 420.0, h: 320.0 }).await;
        match r {
            Ok(png) => { let _ = std::fs::write(&out, &png); eprintln!("[navegador selftest] ok {} bytes → {out}", png.len()); }
            Err(e) => eprintln!("[navegador selftest] falhou: {e}"),
        }
        app.exit(0);
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use super::SnapRect;
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::{Arc, Mutex};

    pub type Tx = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>>>>;

    pub fn send(tx: &Tx, v: Result<Vec<u8>, String>) {
        if let Some(s) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = s.send(v); }
    }

    fn png_of(img: *mut NSImage) -> Result<Vec<u8>, String> {
        let img: &NSImage = unsafe { img.as_ref() }.ok_or("print vazio")?;
        let tiff = img.TIFFRepresentation().ok_or("print sem imagem")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("não consegui ler o print")?;
        let props = NSDictionary::new();
        let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }.ok_or("não consegui gerar o PNG")?;
        Ok(png.to_vec())
    }

    /// SAFETY: chamado na thread principal (with_webview) com o ponteiro do WKWebView vivo da janela.
    pub unsafe fn take(wk: *mut std::ffi::c_void, r: SnapRect, tx: Tx) {
        let Some(mtm) = MainThreadMarker::new() else { send(&tx, Err("print fora da thread principal".into())); return };
        let Some(wv) = (wk as *const WKWebView).as_ref() else { send(&tx, Err("webview indisponível".into())); return };
        let cfg = WKSnapshotConfiguration::new(mtm);
        cfg.setRect(NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h)));
        cfg.setAfterScreenUpdates(true);
        let tx2 = tx.clone();
        let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
            let res = if img.is_null() {
                let why = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "sem imagem".into());
                Err(format!("o print falhou: {why}"))
            } else { png_of(img) };
            send(&tx2, res);
        });
        wv.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &block);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origem_alvo_so_http_s_e_normalizada() {
        assert_eq!(target_origin("localhost:5173").unwrap(), "http://localhost:5173");
        assert_eq!(target_origin("127.0.0.1:3000/login?x=1").unwrap(), "http://127.0.0.1:3000");
        assert_eq!(target_origin("meusite.com.br/x").unwrap(), "https://meusite.com.br");
        assert_eq!(target_origin("HTTP://App.Localhost:80/").unwrap(), "http://app.localhost");
        assert_eq!(target_origin("https://x.com:443").unwrap(), "https://x.com");
        assert_eq!(target_origin("http://[::1]:8080/a").unwrap(), "http://[::1]:8080");
        for bad in ["", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,oi", "ftp://x.com", "http://u:s@x.com", "http://x.com:99999", "http:///semhost"] {
            assert!(target_origin(bad).is_err(), "devia recusar {bad:?}");
        }
    }

    #[test]
    fn linha_de_pronto_do_proxy() {
        let i = parse_ready_line("{\"port\":51234,\"origin\":\"http://127.0.0.1:51234\",\"target\":\"http://localhost:5173\"}\n").unwrap();
        assert_eq!(i, BrowserInfo { port: 51234, origin: "http://127.0.0.1:51234".into(), target: "http://localhost:5173".into() });
        assert_eq!(parse_ready_line("{\"error\":\"só endereços http(s) abrem na prévia\"}").unwrap_err(), "só endereços http(s) abrem na prévia");
        assert!(parse_ready_line("{\"port\":0}").is_err());
        assert!(parse_ready_line("lixo").is_err());
    }

    #[test]
    fn nome_do_print_sequencial() {
        let d = std::env::temp_dir().join(format!("sf-nav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(next_artifact_name(&d), "browser-1.png", "pasta ainda não existe");
        std::fs::create_dir_all(&d).unwrap();
        for f in ["browser-1.png", "browser-7.png", "browser-x.png", "mobile-ios-9.png", "browser-3.jpg"] { std::fs::write(d.join(f), b"x").unwrap(); }
        assert_eq!(next_artifact_name(&d), "browser-8.png");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retangulo_do_print() {
        assert!(snap_rect_ok(&SnapRect { x: 10.4, y: 20.6, w: 100.0, h: 30.0 }).is_ok());
        assert_eq!(snap_rect_ok(&SnapRect { x: 10.4, y: 20.6, w: 100.2, h: 30.0 }).unwrap().x, 10.0);
        for r in [SnapRect { x: 0.0, y: 0.0, w: 1.0, h: 10.0 }, SnapRect { x: -5.0, y: 0.0, w: 10.0, h: 10.0 }, SnapRect { x: 0.0, y: 0.0, w: f64::NAN, h: 10.0 }, SnapRect { x: 0.0, y: 0.0, w: 9000.0, h: 10.0 }] {
            assert!(snap_rect_ok(&r).is_err());
        }
    }

    /// Ponta a ponta: o MESMO comando que o app monta (node + src/cli.ts browser-proxy) sobe, responde com o script
    /// injetado, só escuta em 127.0.0.1 e morre no close.
    #[test]
    fn proxy_real_sobe_injeta_e_morre() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        let cli = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts");
        if !cli.is_file() || Command::new("node").arg("--version").output().is_err() { eprintln!("sem node/src: pulei"); return; }
        // upstream falso: responde um HTML fixo a cada conexão
        let up = TcpListener::bind("127.0.0.1:0").unwrap();
        let up_port = up.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in up.incoming().flatten() {
                let mut s = s; let mut buf = [0u8; 4096]; let _ = s.read(&mut buf);
                let body = "<html><head><title>x</title></head><body>oi</body></html>";
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Frame-Options: DENY\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            }
        });
        let cli_s = cli.display().to_string();
        let info = open("t-nav-test", &format!("127.0.0.1:{up_port}"), |origin| {
            let mut c = Command::new("node");
            c.args(["--disable-warning=ExperimentalWarning", &cli_s, "browser-proxy", "--target", origin]);
            c
        }).expect("proxy subiu");
        assert_eq!(info.target, format!("http://127.0.0.1:{up_port}"));
        // reaproveita o mesmo proxy pra mesma origem
        let again = open("t-nav-test", &format!("http://127.0.0.1:{up_port}/outra"), |_| panic!("não devia subir outro")).unwrap();
        assert_eq!(again.port, info.port);
        let mut s = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        write!(s, "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", info.port).unwrap();
        let mut resp = String::new(); s.read_to_string(&mut resp).unwrap();
        assert!(resp.contains("data-starfork-picker"), "script injetado: {resp}");
        assert!(!resp.to_lowercase().contains("x-frame-options"), "XFO removido");
        assert!(close("t-nav-test"));
        assert!(!close("t-nav-test"));
        std::thread::sleep(Duration::from_millis(400));
        assert!(TcpStream::connect(("127.0.0.1", info.port)).is_err(), "proxy morto depois do close");
    }
}
