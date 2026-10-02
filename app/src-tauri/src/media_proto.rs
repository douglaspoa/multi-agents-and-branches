//! Protocolo `sfart://` — serve VÍDEOS (e imagens) dos artefatos de uma tarefa direto do disco, sem base64.
//!
//! O front monta a URL com `convertFileSrc("<taskId>/<nome>", "sfart")` (macOS/Linux: `sfart://localhost/…`;
//! Windows: `http://sfart.localhost/…`) e põe num `<video controls preload="metadata">`. O WebKit pede o vídeo
//! em PEDAÇOS (cabeçalho Range) — respondemos 206 com no máximo `CHUNK_MAX` bytes por vez, então um mp4 grande
//! não é lido inteiro nem trava a UI.
//!
//! ESCOPO: só nomes de artefato válidos (sem `..`, sem caminho absoluto, sem barra invertida, sem byte de controle)
//! de mídia (vídeo/imagem), resolvidos pelo MESMO `artifact_path` dos comandos — e o arquivo CANÔNICO (symlinks
//! resolvidos) tem que ficar dentro da pasta de artefatos CANÔNICA da tarefa (worktree ou cópia coletada no repo).
//! Qualquer outra coisa → 403/404. Sem cabeçalho CORS: só a própria janela do app usa.
//!
//! HTTP: com Range válido → 206 (pedaço ≤ CHUNK_MAX); Range fora do arquivo → 416; sem Range (ou Range mal
//! formado, que é ignorado como manda a RFC 9110) → 200 com o arquivo inteiro e `Accept-Ranges: bytes`.

/// Pedaço máximo por resposta (Range aberto "bytes=0-" não lê o arquivo todo).
pub const CHUNK_MAX: u64 = 2 * 1024 * 1024;

/// Tipo de mídia servível pelo protocolo; None = fora do escopo.
pub fn media_mime(name: &str) -> Option<&'static str> {
    let l = name.to_lowercase();
    let ext = l.rsplit('.').next().unwrap_or("");
    Some(match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

pub fn is_video(name: &str) -> bool {
    media_mime(name).map(|m| m.starts_with("video/")).unwrap_or(false)
}

/// Decodifica %XX (UTF-8). Sequência inválida ou byte de controle (%00, %0A…) → None.
pub fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    if out.iter().any(|b| *b < 0x20 || *b == 0x7f) {
        return None;
    }
    String::from_utf8(out).ok()
}

/// Caminho da URL ("/<taskId>/<nome…>", inteiro ou por partes codificado) → (taskId, nome do artefato).
/// Recusa o que sair do escopo: id estranho, `..`, absoluto, barra invertida, extensão que não é mídia.
pub fn parse_target(url_path: &str) -> Option<(String, String)> {
    let dec = pct_decode(url_path.trim_start_matches('/'))?;
    let (task, name) = dec.split_once('/')?;
    if task.is_empty() || !task.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') || task.starts_with('.') {
        return None;
    }
    let n = name.trim();
    let ok = !n.is_empty()
        && !n.contains('\\')
        && !n.starts_with('/')
        && n.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    if !ok || media_mime(n).is_none() {
        return None;
    }
    Some((task.to_string(), n.to_string()))
}

/// Cabeçalho Range ("bytes=a-b", "bytes=a-", "bytes=-n") → (início, fim inclusivo), já cortado em CHUNK_MAX.
/// Ok(None) = sem Range ou Range MAL FORMADO (ignorado → resposta inteira); Err = fora do arquivo (416).
pub fn parse_range(h: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(h) = h else { return Ok(None) };
    let Some(spec) = h.trim().strip_prefix("bytes=") else { return Ok(None) };
    if spec.contains(',') { return Ok(None); } // vários intervalos: não suportado → inteiro
    let Some((a, b)) = spec.trim().split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    let num = |x: &str| -> Option<u64> { if x.is_empty() || !x.bytes().all(|c| c.is_ascii_digit()) { None } else { x.parse().ok() } };
    let (start, mut end) = if a.is_empty() {
        let Some(n) = num(b) else { return Ok(None) };
        if n == 0 || len == 0 { return Err(()); }
        (len.saturating_sub(n), len - 1)
    } else {
        let Some(s) = num(a) else { return Ok(None) };
        let e = if b.is_empty() { u64::MAX } else { match num(b) { Some(e) => e, None => return Ok(None) } };
        if e < s { return Ok(None); } // "bytes=5-2": inválido → ignora
        if s >= len { return Err(()); }
        (s, e.min(len - 1))
    };
    if end - start + 1 > CHUNK_MAX {
        end = start + CHUNK_MAX - 1;
    }
    Ok(Some((start, end)))
}

/// O arquivo CANÔNICO (symlinks resolvidos) está dentro de alguma das pastas permitidas (também canônicas)?
pub fn within(file: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    let Ok(f) = std::fs::canonicalize(file) else { return false };
    if !f.is_file() { return false; }
    roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| f.starts_with(&r) && f != r)
}

/// Pedido inteiro (puro, testável): caminho da URL + Range + como achar o arquivo e as pastas permitidas.
pub fn serve(url_path: &str, range: Option<&str>, locate: impl FnOnce(&str, &str) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>)>) -> (u16, Vec<(&'static str, String)>, Vec<u8>) {
    let forbidden = || (403u16, vec![("Content-Type", "text/plain".to_string())], b"fora do escopo".to_vec());
    let Some((task, name)) = parse_target(url_path) else { return forbidden() };
    let Some((file, roots)) = locate(&task, &name) else { return respond(None, &name, range) };
    if !within(&file, &roots) { return forbidden(); }
    respond(Some(&file), &name, range)
}

/// Lê [start, end] do arquivo (só esse pedaço).
pub fn read_slice(path: &std::path::Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; (end - start + 1) as usize];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Resposta HTTP pro pedido (status, cabeçalhos, corpo) — pura dado o arquivo resolvido (testável sem Tauri).
pub fn respond(path: Option<&std::path::Path>, name: &str, range: Option<&str>) -> (u16, Vec<(&'static str, String)>, Vec<u8>) {
    let Some(path) = path else { return (404, vec![("Content-Type", "text/plain".into())], b"artefato nao encontrado".to_vec()) };
    let mime = media_mime(name).unwrap_or("application/octet-stream");
    let len = match std::fs::metadata(path) { Ok(m) => m.len(), Err(_) => return (404, vec![], vec![]) };
    let base = vec![("Content-Type", mime.to_string()), ("Accept-Ranges", "bytes".to_string()), ("Cache-Control", "no-cache".to_string())];
    match parse_range(range, len) {
        Err(()) => {
            let mut h = base;
            h.push(("Content-Range", format!("bytes */{len}")));
            (416, h, vec![])
        }
        Ok(Some((s, e))) => match read_slice(path, s, e) {
            Ok(body) => {
                let mut h = base;
                h.push(("Content-Range", format!("bytes {s}-{e}/{len}")));
                h.push(("Content-Length", body.len().to_string()));
                (206, h, body)
            }
            Err(_) => (500, vec![], vec![]),
        },
        Ok(None) => match std::fs::read(path) {
            // sem Range (ou mal formado): 200 com o arquivo INTEIRO (RFC) — o <video> do WebKit sempre pede por Range
            Ok(body) => {
                let mut h = base;
                h.push(("Content-Length", body.len().to_string()));
                (200, h, body)
            }
            Err(_) => (500, vec![], vec![]),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escopo_so_midia_dentro_dos_artefatos() {
        assert_eq!(parse_target("/t-1/mobile-ios-1.mp4"), Some(("t-1".into(), "mobile-ios-1.mp4".into())));
        // convertFileSrc codifica o caminho inteiro (a barra vira %2F)
        assert_eq!(parse_target("/t-1%2Fprints%2Fmobile%20ios.mov"), Some(("t-1".into(), "prints/mobile ios.mov".into())));
        assert_eq!(parse_target("/t1/proof.png").map(|x| x.1), Some("proof.png".into()));
        for bad in [
            "/t1/../../etc/passwd.mp4", "/t1%2F..%2F..%2Fsegredo.mp4", "/t1//abs.mp4", "/t1/a\\b.mp4", "/../x/a.mp4",
            "/t1/notas.md", "/t1/.env", "/t1/requirements.json", "/t1", "/", "/t1/%ZZ.mp4", "/.t/a.mp4",
            "/t1/a%00.mp4", "/t1/a%0A.mp4",
        ] {
            assert_eq!(parse_target(bad), None, "{bad} devia ser recusado");
        }
    }

    #[test]
    fn pct_decode_multibyte_e_controle() {
        assert_eq!(pct_decode("v%C3%ADdeo%201.mp4").as_deref(), Some("vídeo 1.mp4"));
        assert_eq!(pct_decode("a%00b"), None, "NUL recusado");
        assert_eq!(pct_decode("a%1Fb"), None);
        assert_eq!(pct_decode("%C3"), None, "UTF-8 incompleto");
        assert_eq!(pct_decode("%4"), None, "% truncado");
    }

    #[test]
    fn serve_403_404_e_symlink_pra_fora() {
        let base = std::env::temp_dir().join(format!("sfart-serve-{}", std::process::id()));
        let art = base.join("wt/.cardume/artifacts");
        let fora = base.join("fora");
        std::fs::create_dir_all(&art).unwrap();
        std::fs::create_dir_all(&fora).unwrap();
        std::fs::write(art.join("ok.mp4"), b"0123").unwrap();
        std::fs::write(fora.join("segredo.mp4"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(fora.join("segredo.mp4"), art.join("link.mp4")).unwrap();
        let roots = vec![art.clone()];
        let loc = |n: &str| Some((art.join(n), roots.clone()));
        assert_eq!(serve("/t1/../x.mp4", None, |_, n| loc(n)).0, 403, "fora do escopo pela URL");
        assert_eq!(serve("/t1/notas.md", None, |_, n| loc(n)).0, 403, "não é mídia");
        assert_eq!(serve("/t1/sumiu.mp4", None, |_, _| None).0, 404);
        let (st, _, body) = serve("/t1/ok.mp4", None, |_, n| loc(n));
        assert_eq!((st, body), (200, b"0123".to_vec()));
        assert_eq!(serve("/t1/ok.mp4", Some("bytes=1-2"), |_, n| loc(n)).0, 206);
        #[cfg(unix)]
        assert_eq!(serve("/t1/link.mp4", None, |_, n| loc(n)).0, 403, "symlink pra fora dos artefatos");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn mime_e_video() {
        assert_eq!(media_mime("A.MP4"), Some("video/mp4"));
        assert_eq!(media_mime("x.mov"), Some("video/quicktime"));
        assert_eq!(media_mime("x.webm"), Some("video/webm"));
        assert_eq!(media_mime("x.pdf"), None);
        assert!(is_video("mobile-android-2.mp4") && !is_video("mobile-ios-1.png"));
    }

    #[test]
    fn range_em_pedacos() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=0-1"), 100), Ok(Some((0, 1))));
        assert_eq!(parse_range(Some("bytes=10-"), 100), Ok(Some((10, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=50-500"), 100), Ok(Some((50, 99))));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Err(()), "fora do arquivo → 416");
        let big = 50 * 1024 * 1024;
        assert_eq!(parse_range(Some("bytes=0-"), big), Ok(Some((0, CHUNK_MAX - 1))), "Range aberto não lê o arquivo todo");
        // mal formado: IGNORADO (resposta inteira), nunca 416
        for bad in ["items=0-1", "bytes=abc", "bytes=5-2", "bytes=-", "bytes=1-2,4-5", "bytes=+1-2", "bytes=-x"] {
            assert_eq!(parse_range(Some(bad), 100), Ok(None), "{bad}");
        }
    }

    #[test]
    fn resposta_206_com_o_pedaco_certo() {
        let dir = std::env::temp_dir().join(format!("sfart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("v.mp4");
        std::fs::write(&f, b"0123456789").unwrap();
        let (st, h, body) = respond(Some(&f), "v.mp4", Some("bytes=2-5"));
        assert_eq!(st, 206);
        assert_eq!(body, b"2345");
        assert!(h.iter().any(|(k, v)| *k == "Content-Range" && v == "bytes 2-5/10"));
        assert!(h.iter().any(|(k, v)| *k == "Content-Type" && v == "video/mp4"));
        let (st, h, body) = respond(Some(&f), "v.mp4", None);
        assert_eq!((st, body.len()), (200, 10), "sem Range: 200 com o arquivo inteiro");
        assert!(h.iter().any(|(k, v)| *k == "Accept-Ranges" && v == "bytes"));
        assert!(!h.iter().any(|(k, _)| k.starts_with("Access-Control")), "sem CORS");
        assert_eq!(respond(Some(&f), "v.mp4", Some("bytes=zz")).0, 200, "Range mal formado é ignorado");
        assert_eq!(respond(Some(&f), "v.mp4", Some("bytes=20-")).0, 416);
        assert_eq!(respond(None, "v.mp4", None).0, 404);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
