//! "Publicar release pro time": quem pode publicar, o que pode ir e em que ordem sobe.
//!
//! Instalação DEV = env CARDUME_CLI (rodando do fonte) OU a marca
//! `Contents/Resources/dev-source.json` que o scripts/deploy-local.sh grava no .app antes
//! de assinar (o app aberto pelo Finder não recebe env nenhuma). O portable dos colegas
//! nunca carrega a marca (package-app.sh remove).
//!
//! Regras da release (todas antes de subir qualquer byte):
//! • dist/Starfork-portable.json (do package-app.sh) diz o commit do pacote, e o tamanho do zip bate;
//! • pacote sem alteração não commitada;
//! • pacote do MESMO commit do build que está rodando (o que o dono testou);
//! • commit contido na origin/main (git fetch + merge-base --is-ancestor): build local de
//!   main + branch não mergeada NÃO vai pro time.
//! Upload: zip (x-upsert) → confere o tamanho REMOTO → alias antigo → latest.json por último.
//! Nunca apaga nada no bucket: se algo falha no meio, o latest.json antigo segue valendo.

use std::path::{Path, PathBuf};
use std::process::Command;

pub const MARK_FILE: &str = "dev-source.json";
pub const PORTABLE_META: &str = "Starfork-portable.json";
pub const ZIP_NAME: &str = "Starfork-portable.zip";
const ALIAS_ZIP: &str = "Constellation-portable.zip";

#[derive(Debug, Clone, PartialEq)]
pub struct DevSource {
    /// raiz do fonte (onde vive o dist/)
    pub root: PathBuf,
    /// commit do build instalado (marca); None = rodando do fonte (CARDUME_CLI) → HEAD do root
    pub commit: Option<String>,
    pub branch: Option<String>,
    /// o build instalado saiu de um checkout com alterações não commitadas
    pub dirty: bool,
}

/// Contents/MacOS/Starfork → Contents/Resources/dev-source.json
pub fn mark_path_for_exe(exe: &Path) -> Option<PathBuf> {
    exe.parent()?.parent().map(|c| c.join("Resources").join(MARK_FILE))
}

pub fn read_mark(p: &Path) -> Option<DevSource> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    let root = v["source"].as_str().filter(|s| !s.is_empty())?;
    let s = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    // a marca só vale com o fonte NESTA máquina: um .app marcado que vazou pra um colega
    // (pacote de um checkout antigo, sem o strip) não pode esconder o auto-update dele
    let root = PathBuf::from(root);
    if !root.is_dir() { return None; }
    Some(DevSource { root, commit: s("commit"), branch: s("branch"), dirty: v["dirty"].as_bool().unwrap_or(false) })
}

/// CARDUME_CLI (…/src/cli.ts → raiz) manda; senão a marca do bundle.
pub fn dev_source_from(env_cli: Option<String>, mark: Option<&Path>) -> Option<DevSource> {
    if let Some(cli) = env_cli.filter(|v| !v.is_empty()) {
        // env definida = dev, sempre (como antes); raiz = …/src/cli.ts → ../..
        let root = PathBuf::from(&cli).parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()).unwrap_or_default();
        return Some(DevSource { root, commit: None, branch: None, dirty: false });
    }
    mark.and_then(read_mark)
}

pub fn dev_source() -> Option<DevSource> {
    let exe = std::env::current_exe().ok();
    let mark = exe.as_deref().and_then(mark_path_for_exe);
    dev_source_from(std::env::var("CARDUME_CLI").ok(), mark.as_deref())
}

#[derive(Debug, Clone)]
pub struct Package {
    pub zip: PathBuf,
    pub size: u64,
    pub build_ms: i64,
    pub commit: String,
    pub branch: String,
}

fn short(c: &str) -> &str { &c[..c.len().min(8)] }
/// sha do git (hex): o que vem dos JSONs vira argumento do git — nunca opção ("-x") nem lixo
fn is_sha(c: &str) -> bool { c.len() >= 7 && c.len() <= 64 && c.chars().all(|ch| ch.is_ascii_hexdigit()) }

fn git(root: &Path, args: &[&str], secs: u64) -> Result<std::process::Output, String> {
    let mut c = Command::new("git");
    // app aberto pelo Finder não tem terminal: credencial faltando = erro rápido, nunca prompt preso
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    c.arg("-C").arg(root).args(args);
    crate::output_timeout(c, secs)
}

fn mtime_ms(p: &Path) -> Option<i64> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Todas as regras locais + a da main (com git fetch da origin/main).
pub fn preflight(src: &DevSource) -> Result<Package, String> {
    let root = &src.root;
    if !root.is_dir() {
        return Err(format!("não achei o fonte do Starfork em {} — rode scripts/deploy-local.sh de novo a partir do checkout do repositório.", root.display()));
    }
    let dist = root.join("dist");
    let zip = dist.join(ZIP_NAME);
    if !zip.exists() {
        return Err(format!("não há pacote pra publicar ({}) — rode scripts/package-app.sh a partir da main e publique de novo.", zip.display()));
    }
    let meta: serde_json::Value = std::fs::read_to_string(dist.join(PORTABLE_META)).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("o pacote não diz de qual commit foi gerado (falta dist/Starfork-portable.json) — rode scripts/package-app.sh de novo pra reempacotar.")?;
    let commit = meta["commit"].as_str().unwrap_or("").to_string();
    let branch = meta["branch"].as_str().unwrap_or("?").to_string();
    if !is_sha(&commit) {
        return Err("dist/Starfork-portable.json sem commit válido — rode scripts/package-app.sh de novo pra reempacotar.".into());
    }
    let size = std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    if meta["zipBytes"].as_u64() != Some(size) {
        return Err("o dist/Starfork-portable.zip não é o que o scripts/package-app.sh gerou (tamanho diferente) — rode scripts/package-app.sh de novo.".into());
    }
    if meta["dirty"].as_bool().unwrap_or(true) {
        return Err(format!("o pacote foi gerado com alterações não commitadas (branch {branch}) — commite e faça merge na main (ou descarte), rode scripts/package-app.sh e publique de novo."));
    }
    // o pacote tem que ser do MESMO commit do app que está rodando (o que foi testado)
    let running = match &src.commit {
        Some(c) => c.clone(),
        None => {
            let o = git(root, &["rev-parse", "HEAD"], 20)?;
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
    };
    if src.dirty {
        return Err("o app que você está rodando foi compilado com alterações não commitadas — commite e faça merge na main, rode scripts/deploy-local.sh e scripts/package-app.sh a partir da main e publique de novo.".into());
    }
    if !is_sha(&running) {
        return Err("não consegui ler o commit do app que você está rodando — rode scripts/deploy-local.sh de novo e publique de novo.".into());
    }
    if running != commit {
        return Err(format!(
            "o pacote é do commit {} (branch {branch}), mas o app que você está rodando é do commit {}{} — rode scripts/deploy-local.sh e scripts/package-app.sh no mesmo checkout (da main) e publique de novo.",
            short(&commit), short(&running),
            src.branch.as_deref().map(|b| format!(" (branch {b})")).unwrap_or_default()
        ));
    }
    // GUARD antigo (mantido): app DEV bem mais novo que o portable = pacote esquecido.
    let bin = dist.join("Starfork-portable.app").join("Contents").join("MacOS").join("Starfork");
    let build_ms = mtime_ms(&bin).ok_or("binário do portable não encontrado (dist/Starfork-portable.app) — rode scripts/package-app.sh de novo.")?;
    let dev_bin = dist.join("Starfork.app").join("Contents").join("MacOS").join("Starfork");
    let old_dev_bin = dist.join("Constellation.app").join("Contents").join("MacOS").join("Constellation");
    if let Some(dev_ms) = mtime_ms(&dev_bin).or_else(|| mtime_ms(&old_dev_bin)) {
        // 30min de folga: ignora o skew de reempacotar+redeploy na mesma sessão
        if dev_ms > build_ms + 1_800_000 {
            return Err("o pacote portable está DEFASADO (seu build atual é bem mais novo) — rode scripts/package-app.sh pra reempacotar com o código de agora ANTES de publicar, senão os colegas recebem uma versão antiga.".into());
        }
    }
    // só sai da main
    let f = git(root, &["fetch", "-q", "origin", "main"], 90)?;
    if !f.status.success() {
        return Err(format!("não consegui atualizar a origin/main pra conferir o commit ({}) — confira a rede/credenciais do git e publique de novo.",
            String::from_utf8_lossy(&f.stderr).trim()));
    }
    let a = git(root, &["merge-base", "--is-ancestor", &commit, "origin/main"], 20)?;
    match a.status.code() {
        Some(0) => {}
        Some(1) => return Err(format!(
            "este build tem commits fora da main (branch {branch}, commit {}) — a release do time só sai da main. Faça merge na main, rode scripts/deploy-local.sh e scripts/package-app.sh a partir da main e publique de novo.",
            short(&commit))),
        _ => return Err(format!(
            "não consegui conferir se o commit {} está na main ({}) — faça merge na main, reempacote com scripts/package-app.sh e publique de novo.",
            short(&commit), String::from_utf8_lossy(&a.stderr).trim())),
    }
    Ok(Package { zip, size, build_ms, commit, branch })
}

fn curl_post(url: &str, anon: &str, token: &str, ctype: &str, file: &Path, secs: u64) -> Result<String, String> {
    let mut c = Command::new("curl");
    c.args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
        "-H", &format!("apikey: {anon}"), "-H", &format!("Authorization: Bearer {token}"),
        "-H", "x-upsert: true", "-H", &format!("Content-Type: {ctype}"),
        "--data-binary"]).arg(format!("@{}", file.display())).arg(url);
    let r = crate::output_timeout(c, secs)?;
    Ok(String::from_utf8_lossy(&r.stdout).trim().to_string())
}

/// Tamanho do objeto no bucket, com a sessão: HEAD no objeto; se não vier
/// Content-Length, o /object/info (JSON com size).
pub fn remote_size(url: &str, anon: &str, token: &str, name: &str) -> Option<u64> {
    let auth = [format!("apikey: {anon}"), format!("Authorization: Bearer {token}")];
    let mut h = Command::new("curl");
    h.args(["-s", "-I", "-H", &auth[0], "-H", &auth[1]])
        .arg(format!("{url}/storage/v1/object/releases/{name}"));
    if let Ok(o) = crate::output_timeout(h, 60) {
        let txt = String::from_utf8_lossy(&o.stdout).to_string();
        let ok = txt.lines().next().map(|l| l.split_whitespace().nth(1) == Some("200")).unwrap_or(false);
        if ok {
            let len = txt.lines().filter_map(|l| {
                let (k, v) = l.split_once(':')?;
                if k.trim().eq_ignore_ascii_case("content-length") { v.trim().parse::<u64>().ok() } else { None }
            }).last();
            if len.is_some() { return len; }
        }
    }
    let mut g = Command::new("curl");
    g.args(["-s", "-H", &auth[0], "-H", &auth[1]])
        .arg(format!("{url}/storage/v1/object/info/releases/{name}"));
    let o = crate::output_timeout(g, 60).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
    v["size"].as_u64().or_else(|| v["metadata"]["size"].as_u64()).or_else(|| v["metadata"]["contentLength"].as_u64())
}

/// zip → confere tamanho remoto → alias (best-effort) → latest.json. Nunca apaga antes.
pub fn upload(url: &str, anon: &str, token: &str, pkg: &Package, notes: Option<String>) -> Result<String, String> {
    let obj = |n: &str| format!("{url}/storage/v1/object/releases/{n}");
    let code = curl_post(&obj(ZIP_NAME), anon, token, "application/zip", &pkg.zip, 300)?;
    if code != "200" {
        return Err(format!("o upload do {ZIP_NAME} falhou (HTTP {code}) — confira se você é o owner do canal e publique de novo. O aviso de versão do time não foi trocado."));
    }
    match remote_size(url, anon, token, ZIP_NAME) {
        Some(r) if r == pkg.size => {}
        Some(r) => return Err(format!("o zip no canal não confere ({r} de {} bytes) — o latest.json NÃO foi trocado, então o time não recebe o aviso de atualizar. Publique de novo.", pkg.size)),
        None => return Err("não consegui conferir o zip no canal depois do upload — o latest.json NÃO foi trocado, então o time não recebe o aviso de atualizar. Publique de novo.".into()),
    }
    let mut warn = String::new();
    match curl_post(&obj(ALIAS_ZIP), anon, token, "application/zip", &pkg.zip, 300) {
        Ok(c) if c == "200" => {}
        Ok(c) => warn = format!(" · aviso: alias {ALIAS_ZIP} não subiu (HTTP {c})"),
        Err(e) => warn = format!(" · aviso: alias {ALIAS_ZIP} não subiu ({e})"),
    }
    let version = {
        let out = Command::new("date").args(["-r", &(pkg.build_ms / 1000).to_string(), "+%d/%m %H:%M"]).output().map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let meta = serde_json::json!({
        "buildMs": pkg.build_ms, "version": version, "file": ZIP_NAME,
        "size": pkg.size, "commit": pkg.commit,
        "notes": notes.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Melhorias e correções.".into()),
        "publishedAt": crate::chrono_iso_now(),
    });
    let tmp = std::env::temp_dir().join(format!("starfork-latest-{}.json", std::process::id()));
    std::fs::write(&tmp, meta.to_string()).map_err(|e| e.to_string())?;
    let code2 = curl_post(&obj("latest.json"), anon, token, "application/json", &tmp, 60);
    let _ = std::fs::remove_file(&tmp);
    let code2 = code2?;
    if code2 != "200" {
        return Err(format!("o zip subiu, mas o latest.json falhou (HTTP {code2}) — o time ainda não foi avisado; publique de novo."));
    }
    Ok(format!("release {version} publicada ({} @ {}, {:.1} MB) — os apps do time recebem o aviso de atualizar em até ~2 min{warn}",
        pkg.branch, short(&pkg.commit), pkg.size as f64 / 1048576.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::{Arc, Mutex};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-release-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn g(d: &Path, a: &[&str]) -> String {
        let o = Command::new("git").arg("-C").arg(d).args(["-c", "user.email=a@b", "-c", "user.name=a"]).args(a).output().unwrap();
        assert!(o.status.success(), "{a:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    #[test]
    fn instalacao_dev_pela_env_ou_pela_marca() {
        let d = tmp("mark");
        // env manda: …/src/cli.ts → raiz
        let s = dev_source_from(Some("/x/fonte/src/cli.ts".into()), None).unwrap();
        assert_eq!(s.root, PathBuf::from("/x/fonte"));
        assert_eq!(s.commit, None);
        // sem env, sem marca (colega) → não é dev
        assert_eq!(dev_source_from(None, Some(&d.join(MARK_FILE))), None);
        assert_eq!(dev_source_from(Some(String::new()), None), None, "env vazia não conta");
        // marca do deploy-local
        let app = d.join("Starfork.app/Contents");
        std::fs::create_dir_all(app.join("MacOS")).unwrap();
        std::fs::create_dir_all(app.join("Resources")).unwrap();
        let fonte = d.join("fonte");
        std::fs::create_dir_all(&fonte).unwrap();
        std::fs::write(app.join("Resources").join(MARK_FILE), serde_json::json!({
            "commit": "abc1234", "branch": "main", "dirty": true, "source": fonte }).to_string()).unwrap();
        let mp = mark_path_for_exe(&app.join("MacOS/Starfork")).unwrap();
        let s = dev_source_from(None, Some(&mp)).unwrap();
        assert_eq!(s.root, fonte);
        assert_eq!(s.commit.as_deref(), Some("abc1234"));
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(s.dirty);
        // marca que vazou pra outra máquina (fonte não existe aqui) → não é dev: o updater do colega segue vivo
        std::fs::write(&mp, r#"{"commit":"abc1234","source":"/Users/outro/fonte-que-nao-existe"}"#).unwrap();
        assert_eq!(dev_source_from(None, Some(&mp)), None);
        // env sem pastas acima (CARDUME_CLI=cli.ts) continua sendo dev, como antes
        assert!(dev_source_from(Some("cli.ts".into()), None).is_some());
        // env tem precedência sobre a marca
        assert_eq!(dev_source_from(Some("/y/src/cli.ts".into()), Some(&mp)).unwrap().root, PathBuf::from("/y"));
        // marca quebrada/sem source → não é dev
        std::fs::write(&mp, "{").unwrap();
        assert_eq!(dev_source_from(None, Some(&mp)), None);
        std::fs::write(&mp, r#"{"commit":"a"}"#).unwrap();
        assert_eq!(dev_source_from(None, Some(&mp)), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// repo com origin (bare) cuja main tem 1 commit; branch `feat/x` com 1 commit fora da main.
    struct Repo { d: PathBuf, root: PathBuf, main: String, feat: String }
    fn repo(tag: &str) -> Repo {
        let d = tmp(tag);
        let origin = d.join("origin.git");
        g(&d, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        let root = d.join("fonte");
        std::fs::create_dir_all(&root).unwrap();
        g(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        g(&root, &["add", "."]);
        g(&root, &["commit", "-q", "-m", "base"]);
        g(&root, &["remote", "add", "origin", origin.to_str().unwrap()]);
        g(&root, &["push", "-q", "origin", "main"]);
        let main = g(&root, &["rev-parse", "HEAD"]);
        g(&root, &["checkout", "-q", "-b", "feat/x"]);
        g(&root, &["commit", "-q", "--allow-empty", "-m", "fora da main"]);
        let feat = g(&root, &["rev-parse", "HEAD"]);
        g(&root, &["checkout", "-q", "main"]);
        Repo { d, root, main, feat }
    }
    fn pacote(root: &Path, commit: &str, branch: &str, dirty: bool, bytes_delta: i64) {
        let dist = root.join("dist");
        std::fs::create_dir_all(dist.join("Starfork-portable.app/Contents/MacOS")).unwrap();
        std::fs::write(dist.join("Starfork-portable.app/Contents/MacOS/Starfork"), "bin").unwrap();
        std::fs::write(dist.join(ZIP_NAME), b"PK-zip-de-teste").unwrap();
        let n = 15i64 + bytes_delta;
        std::fs::write(dist.join(PORTABLE_META), serde_json::json!({
            "commit": commit, "branch": branch, "dirty": dirty, "zipBytes": n }).to_string()).unwrap();
    }
    fn src(root: &Path, commit: &str) -> DevSource {
        DevSource { root: root.to_path_buf(), commit: Some(commit.to_string()), branch: Some("main".into()), dirty: false }
    }

    #[test]
    fn regras_da_release() {
        let r = repo("rules");
        // sem pacote
        let e = preflight(&src(&r.root, &r.main)).unwrap_err();
        assert!(e.contains("rode scripts/package-app.sh"), "{e}");
        // pacote sem o .json do commit
        pacote(&r.root, &r.main, "main", false, 0);
        std::fs::remove_file(r.root.join("dist").join(PORTABLE_META)).unwrap();
        let e = preflight(&src(&r.root, &r.main)).unwrap_err();
        assert!(e.contains("Starfork-portable.json") && e.contains("package-app.sh"), "{e}");
        // zip trocado depois do package-app
        pacote(&r.root, &r.main, "main", false, 3);
        let e = preflight(&src(&r.root, &r.main)).unwrap_err();
        assert!(e.contains("tamanho diferente"), "{e}");
        // árvore suja no empacotamento
        pacote(&r.root, &r.main, "main", true, 0);
        let e = preflight(&src(&r.root, &r.main)).unwrap_err();
        assert!(e.contains("não commitadas"), "{e}");
        // pacote de OUTRO commit que o app rodando
        pacote(&r.root, &r.main, "main", false, 0);
        let e = preflight(&src(&r.root, &r.feat)).unwrap_err();
        assert!(e.contains("mesmo checkout") && e.contains(&r.main[..8]), "{e}");
        // build de branch não mergeada (ex.: local/main-com-conselheiro) → nunca vai pro time
        pacote(&r.root, &r.feat, "feat/x", false, 0);
        let e = preflight(&src(&r.root, &r.feat)).unwrap_err();
        assert!(e.contains("fora da main (branch feat/x") && e.contains("Faça merge na main"), "{e}");
        // app rodando compilado de árvore suja → o que vai pro time não é o que foi testado
        pacote(&r.root, &r.main, "main", false, 0);
        let mut sujo = src(&r.root, &r.main);
        sujo.dirty = true;
        assert!(preflight(&sujo).unwrap_err().contains("alterações não commitadas"));
        // commit do JSON nunca vira opção do git
        pacote(&r.root, "--output=/tmp/x", "main", false, 0);
        assert!(preflight(&src(&r.root, &r.main)).unwrap_err().contains("sem commit válido"));
        // da main → ok (com fetch na origin local)
        pacote(&r.root, &r.main, "main", false, 0);
        let p = preflight(&src(&r.root, &r.main)).unwrap();
        assert_eq!(p.commit, r.main);
        assert_eq!(p.size, 15);
        // CARDUME_CLI (sem commit na marca) → compara com o HEAD do fonte
        let viaenv = DevSource { root: r.root.clone(), commit: None, branch: None, dirty: false };
        assert!(preflight(&viaenv).is_ok());
        g(&r.root, &["checkout", "-q", "feat/x"]);
        assert!(preflight(&viaenv).unwrap_err().contains("mesmo checkout"));
        // pacote defasado (guard antigo mantido)
        g(&r.root, &["checkout", "-q", "main"]);
        let devbin = r.root.join("dist/Starfork.app/Contents/MacOS");
        std::fs::create_dir_all(&devbin).unwrap();
        std::fs::write(devbin.join("Starfork"), "x").unwrap();
        let velho = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        std::fs::File::options().write(true).open(r.root.join("dist/Starfork-portable.app/Contents/MacOS/Starfork")).unwrap().set_modified(velho).unwrap();
        assert!(preflight(&src(&r.root, &r.main)).unwrap_err().contains("DEFASADO"));
        // fonte sumiu
        let e = preflight(&src(&r.d.join("nao-existe"), &r.main)).unwrap_err();
        assert!(e.contains("deploy-local.sh"), "{e}");
        let _ = std::fs::remove_dir_all(&r.d);
    }

    /// Servidor HTTP falso do storage: registra método+caminho e responde HEAD com `head_len`.
    fn servidor(head_len: Option<u64>, n: usize) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        servidor_cfg(head_len, None, true, n)
    }
    /// `info`: tamanho devolvido pelo /object/info (None = 404); `latest_ok=false` = latest.json responde 500.
    fn servidor_cfg(head_len: Option<u64>, info: Option<u64>, latest_ok: bool, n: usize) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let lg = log.clone();
        let h = std::thread::spawn(move || {
            for s in l.incoming().take(n) {
                let mut s = s.unwrap();
                let mut rd = BufReader::new(s.try_clone().unwrap());
                let mut first = String::new();
                rd.read_line(&mut first).unwrap();
                let (mut len, mut expect) = (0usize, false);
                loop {
                    let mut line = String::new();
                    rd.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() { break; }
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") { len = v.trim().parse().unwrap(); }
                    if lower.starts_with("expect:") { expect = true; }
                }
                if expect { s.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap(); }
                let mut body = vec![0u8; len];
                rd.read_exact(&mut body).unwrap();
                let mut p = first.split_whitespace();
                let (m, path) = (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string());
                let extra = if path.ends_with("latest.json") { format!(" {}", String::from_utf8_lossy(&body)) } else { String::new() };
                lg.lock().unwrap().push(format!("{m} {path}{extra}"));
                let resp = if m == "HEAD" {
                    match head_len {
                        Some(n) => format!("HTTP/1.1 200 OK\r\nContent-Length: {n}\r\nConnection: close\r\n\r\n"),
                        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                    }
                } else if m == "GET" {
                    match info {
                        Some(n) => { let b = format!("{{\"name\":\"x\",\"size\":{n}}}"); format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len()) }
                        None => { let b = "{\"error\":\"not_found\"}"; format!("HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len()) }
                    }
                } else if !latest_ok && path.ends_with("latest.json") {
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into()
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into()
                };
                s.write_all(resp.as_bytes()).unwrap();
            }
        });
        (url, log, h)
    }
    fn pkg(d: &Path) -> Package {
        let zip = d.join(ZIP_NAME);
        std::fs::write(&zip, vec![7u8; 4096]).unwrap();
        Package { zip, size: 4096, build_ms: 1_760_000_000_000, commit: "c0ffee1234567890".into(), branch: "main".into() }
    }

    #[test]
    fn upload_sobe_zip_confere_e_so_depois_troca_o_latest() {
        let d = tmp("up-ok");
        let (url, log, h) = servidor(Some(4096), 4);
        let msg = upload(&url, "anon", "tok", &pkg(&d), Some("notas".into())).unwrap();
        h.join().unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log.len(), 4, "{log:?}");
        assert_eq!(log[0], "POST /storage/v1/object/releases/Starfork-portable.zip");
        assert_eq!(log[1], "HEAD /storage/v1/object/releases/Starfork-portable.zip");
        assert_eq!(log[2], "POST /storage/v1/object/releases/Constellation-portable.zip");
        assert!(log[3].starts_with("POST /storage/v1/object/releases/latest.json"), "latest por último: {log:?}");
        assert!(log[3].contains("\"commit\":\"c0ffee1234567890\"") && log[3].contains("\"size\":4096"), "{}", log[3]);
        assert!(!log.iter().any(|l| l.starts_with("DELETE")), "nunca apaga");
        assert!(msg.contains("publicada") && msg.contains("c0ffee12"), "{msg}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn zip_remoto_incompleto_nao_troca_o_latest() {
        let d = tmp("up-bad");
        let (url, log, h) = servidor(Some(1000), 2);
        let e = upload(&url, "anon", "tok", &pkg(&d), None).unwrap_err();
        h.join().unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log.len(), 2, "{log:?}");
        assert!(!log.iter().any(|l| l.contains("latest.json")), "{log:?}");
        assert!(e.contains("1000 de 4096") && e.contains("latest.json NÃO foi trocado"), "{e}");
        // sem como conferir (HEAD 404 e /info 404) → também não troca
        let (url, log, h) = servidor(None, 3);
        let e = upload(&url, "anon", "tok", &pkg(&d), None).unwrap_err();
        h.join().unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log[2], "GET /storage/v1/object/info/releases/Starfork-portable.zip");
        assert!(!log.iter().any(|l| l.contains("latest.json")), "{log:?}");
        assert!(e.contains("não consegui conferir"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sem_content_length_confere_pelo_info_e_latest_que_falha_avisa() {
        let d = tmp("up-info");
        // HEAD 404 → /object/info com o tamanho certo → segue e publica
        let (url, log, h) = servidor_cfg(None, Some(4096), true, 5);
        upload(&url, "anon", "tok", &pkg(&d), None).unwrap();
        h.join().unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log[2], "GET /storage/v1/object/info/releases/Starfork-portable.zip");
        assert!(log[4].starts_with("POST /storage/v1/object/releases/latest.json"), "{log:?}");
        // latest.json falha → erro que diz que o aviso não saiu
        let (url, _log, h) = servidor_cfg(Some(4096), None, false, 4);
        let e = upload(&url, "anon", "tok", &pkg(&d), None).unwrap_err();
        h.join().unwrap();
        assert!(e.contains("latest.json falhou (HTTP 500)") && e.contains("publique de novo"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
