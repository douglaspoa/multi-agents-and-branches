//! Servidores órfãos de worktree + saúde da Prévia (03/10).
//!
//! O caso real: a tarefa foi integrada, a worktree `.cardume/worktrees/<id>` foi apagada, mas o `vite` que o agente
//! (ou o app) subiu nela continuou vivo — respondendo 404 em tudo — e a Prévia mostrava uma tela BRANCA, sem aviso.
//! Regra única aqui: processo cuja pasta de trabalho (cwd) está DENTRO de uma worktree do Starfork
//!  - que vai ser removida → morre antes (remove_worktree_dir chama `kill_in_dir`);
//!  - que já não existe → é órfão: a varredura do boot (`sweep_boot`) derruba.
//! O `lsof` lista o cwd de todos os processos do usuário (~0,3 s) e guarda o caminho mesmo depois da pasta apagada.
//! A Prévia, antes de mostrar um endereço local, pergunta `preview_health`: pasta da tarefa existe? o servidor
//! responde algo que não seja 404/conexão recusada? Senão a tela diz o que houve (nunca branco).

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::{pid_alive, procsig, web_log};

/// Saída de `lsof -d cwd -Fpn` → [(pid, cwd)]. Puro (testado).
pub fn parse_lsof_cwd(out: &str) -> Vec<(i32, PathBuf)> {
    let mut v = Vec::new();
    let mut pid: Option<i32> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix('p') { pid = p.trim().parse().ok(); continue; }
        if let Some(n) = line.strip_prefix('n') { if let Some(p) = pid { if n.starts_with('/') { v.push((p, PathBuf::from(n.trim_end()))); } } }
    }
    v
}

/// Pids com cwd dentro de `dir` (o próprio dir ou abaixo dele). Puro (testado).
pub fn procs_in_dir(list: &[(i32, PathBuf)], dir: &Path, me: i32) -> Vec<i32> {
    let mut v: Vec<i32> = list.iter().filter(|(p, c)| *p > 1 && *p != me && c.starts_with(dir)).map(|(p, _)| *p).collect();
    v.sort_unstable(); v.dedup(); v
}

/// Raiz da worktree do Starfork que contém `cwd` (`…/.cardume/worktrees/<id>` ou `…/.cardume/reviews/<id>`). Puro.
pub fn worktree_root_of(cwd: &Path) -> Option<PathBuf> {
    let comps: Vec<_> = cwd.components().collect();
    for i in 0..comps.len().saturating_sub(2) {
        if comps[i].as_os_str() == ".cardume" && matches!(comps[i + 1].as_os_str().to_str(), Some("worktrees") | Some("reviews")) {
            let mut root = PathBuf::new();
            for c in &comps[..=i + 2] { root.push(c.as_os_str()); }
            return Some(root);
        }
    }
    None
}

/// Órfãos: cwd numa worktree do Starfork cuja raiz NÃO existe mais. Puro sobre `exists` (testado).
pub fn orphan_procs(list: &[(i32, PathBuf)], exists: &dyn Fn(&Path) -> bool, me: i32) -> Vec<(i32, PathBuf)> {
    let mut v: Vec<(i32, PathBuf)> = list.iter().filter(|(p, _)| *p > 1 && *p != me)
        .filter_map(|(p, c)| worktree_root_of(c).filter(|r| !exists(r)).map(|r| (*p, r))).collect();
    v.sort_by_key(|x| x.0); v.dedup_by_key(|x| x.0); v
}

fn lsof_cwds() -> Vec<(i32, PathBuf)> {
    if cfg!(windows) { return vec![]; }
    let uid = unsafe_uid();
    let mut c = Command::new("lsof");
    c.args(["-w", "-a", "-d", "cwd", "-Fpn"]);
    if let Some(u) = uid { c.args(["-u", &u]); }
    match c.output() { Ok(o) => parse_lsof_cwd(&String::from_utf8_lossy(&o.stdout)), Err(_) => vec![] }
}
fn unsafe_uid() -> Option<String> {
    let o = Command::new("id").arg("-u").output().ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// TERM, espera um pouco, KILL em quem ficou. Só o PROCESSO (não o grupo: o grupo pode ser o do terminal da pessoa).
fn kill_pids(pids: &[i32]) {
    if pids.is_empty() { return; }
    #[cfg(unix)]
    for p in pids { unsafe { libc::kill(*p, procsig::TERM); } }
    for _ in 0..10 {
        if pids.iter().all(|p| !pid_alive(*p)) { break; }
        std::thread::sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    for p in pids { if pid_alive(*p) { unsafe { libc::kill(*p, procsig::KILL); } } }
}

/// Antes de apagar uma worktree: quem roda dentro dela (dev server, prévia, agente solto) morre junto.
pub fn kill_in_dir(dir: &Path) -> usize {
    if cfg!(windows) { return 0; }
    // o lsof dá o caminho REAL (/private/var/… no Mac); a worktree pode vir por um link (/var/…, /tmp/…)
    let list = lsof_cwds(); let me = std::process::id() as i32;
    let mut pids = procs_in_dir(&list, dir, me);
    if let Ok(real) = dir.canonicalize() { if real != dir { pids.extend(procs_in_dir(&list, &real, me)); pids.sort_unstable(); pids.dedup(); } }
    kill_pids(&pids);
    if !pids.is_empty() { web_log(format!("[órfãos] {} processo(s) rodando em {} derrubado(s) antes de remover a pasta", pids.len(), dir.display())); }
    pids.len()
}

/// Boot do app (thread própria): derruba servidores de prévia cuja worktree já foi apagada.
pub fn sweep_boot() {
    if cfg!(windows) { return; }
    let list = orphan_procs(&lsof_cwds(), &|p: &Path| p.exists(), std::process::id() as i32);
    if list.is_empty() { return; }
    let pids: Vec<i32> = list.iter().map(|x| x.0).collect();
    kill_pids(&pids);
    web_log(format!("[órfãos] varredura do boot: {} processo(s) de worktree apagada derrubado(s): {}", pids.len(),
        list.iter().map(|(p, r)| format!("{p}@{}", r.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())).collect::<Vec<_>>().join(", ")));
}

// ---------- saúde da Prévia ----------
/// Código HTTP de um GET (só loopback). None = recusou/sem resposta. Bloqueia até ~`ms` ms.
pub fn http_status(host: &str, port: u16, path: &str, ms: u64) -> Option<u16> {
    let ips: Vec<IpAddr> = match host {
        "127.0.0.1" => vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        "::1" => vec![IpAddr::V6(Ipv6Addr::LOCALHOST)],
        _ => vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)],
    };
    let to = Duration::from_millis(ms);
    for ip in ips {
        let Ok(mut s) = TcpStream::connect_timeout(&SocketAddr::new(ip, port), to) else { continue };
        let _ = s.set_read_timeout(Some(to)); let _ = s.set_write_timeout(Some(to));
        let p = if path.is_empty() { "/" } else { path };
        if s.write_all(format!("GET {p} HTTP/1.0\r\nHost: {host}:{port}\r\nAccept: text/html\r\nConnection: close\r\n\r\n").as_bytes()).is_err() { continue; }
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).unwrap_or(0);
        return parse_status_line(&String::from_utf8_lossy(&buf[..n])).or(Some(0)); // conectou mas não falou HTTP: 0 (vivo)
    }
    None
}
/// "HTTP/1.1 404 Not Found" → 404. Puro (testado).
pub fn parse_status_line(s: &str) -> Option<u16> {
    let l = s.lines().next()?; let mut it = l.split_whitespace();
    if !it.next()?.starts_with("HTTP/") { return None; }
    it.next()?.parse().ok()
}
/// Caminho+busca da URL (sem host). Puro.
pub fn url_path(url: &str) -> String {
    let rest = url.split_once("://").map(|x| x.1).unwrap_or(url);
    match rest.find('/') { Some(i) => rest[i..].split('#').next().unwrap_or("/").to_string(), None => "/".into() }
}
/// Veredito da Prévia (puro, testado):
///  - "gone": a pasta da tarefa foi removida e o servidor não serve nada (recusou ou 404 em tudo) — tarefa integrada/limpa;
///  - "down": o servidor parou (recusou) ou responde 404 em tudo (cwd apagado, build quebrado);
///  - "ok": responde alguma coisa (inclusive 404 só na rota pedida — a página de erro do próprio app aparece).
pub fn verdict(wt_gone: bool, status: Option<u16>, root_status: Option<u16>) -> &'static str {
    let dead = match status { None => true, Some(404) => matches!(root_status, None | Some(404)), _ => false };
    if !dead { return "ok"; }
    if wt_gone { "gone" } else { "down" }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lsof_e_processos_na_pasta() {
        let out = "p100\nfcwd\nn/Users/a/proj/.cardume/worktrees/header-abas\np101\nfcwd\nn/Users/a/proj/.cardume/worktrees/header-abas/web\np102\nfcwd\nn/Users/a/proj\np7\nfcwd\nn/\n";
        let l = parse_lsof_cwd(out);
        assert_eq!(l.len(), 4);
        let dir = Path::new("/Users/a/proj/.cardume/worktrees/header-abas");
        assert_eq!(procs_in_dir(&l, dir, 999), vec![100, 101]);
        assert_eq!(procs_in_dir(&l, dir, 100), vec![101], "o próprio app nunca");
        // prefixo de NOME não conta: header-abas-2 não é header-abas
        let l2 = parse_lsof_cwd("p5\nfcwd\nn/Users/a/proj/.cardume/worktrees/header-abas-2\n");
        assert!(procs_in_dir(&l2, dir, 1).is_empty());
    }
    #[test]
    fn orfaos_so_de_worktree_apagada() {
        let l = parse_lsof_cwd("p200\nn/r/.cardume/worktrees/viva/web\np201\nn/r/.cardume/worktrees/morta\np202\nn/r/.cardume/reviews/pr-9/x\np203\nn/r/src\np204\nn/r/.cardume/logs\n");
        let exists = |p: &Path| p == Path::new("/r/.cardume/worktrees/viva");
        let o = orphan_procs(&l, &exists, 1);
        assert_eq!(o.iter().map(|x| x.0).collect::<Vec<_>>(), vec![201, 202]);
        assert_eq!(o[0].1, PathBuf::from("/r/.cardume/worktrees/morta"));
        assert_eq!(worktree_root_of(Path::new("/r/.cardume/worktrees")), None, "a pasta das worktrees em si não é worktree");
    }
    #[test]
    fn veredito_da_previa() {
        assert_eq!(parse_status_line("HTTP/1.1 404 Not Found\r\n"), Some(404));
        assert_eq!(parse_status_line("SSH-2.0"), None);
        assert_eq!(url_path("http://127.0.0.1:5241/u/painel?x=1#a"), "/u/painel?x=1");
        assert_eq!(url_path("http://localhost:3000"), "/");
        // o caso real: worktree apagada + vite vivo respondendo 404 em tudo
        assert_eq!(verdict(true, Some(404), Some(404)), "gone");
        assert_eq!(verdict(true, None, None), "gone");
        assert_eq!(verdict(false, None, None), "down");
        assert_eq!(verdict(false, Some(404), Some(404)), "down");
        assert_eq!(verdict(false, Some(404), Some(200)), "ok", "404 só na rota: a página de erro do app aparece");
        assert_eq!(verdict(false, Some(200), None), "ok");
        assert_eq!(verdict(true, Some(200), None), "ok", "alguém serve (ex.: a prévia da main) — mostra");
    }
    #[test]
    fn http_status_de_verdade() {
        use std::net::TcpListener;
        let l = TcpListener::bind("127.0.0.1:0").unwrap(); let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || { for s in l.incoming().take(1) { let mut s = s.unwrap(); let mut b = [0u8; 256]; let _ = s.read(&mut b); let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); } });
        assert_eq!(http_status("127.0.0.1", port, "/u", 1500), Some(404));
        let free = { let l = TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
        assert_eq!(http_status("127.0.0.1", free, "/", 300), None, "porta fechada = recusou");
    }
    #[test]
    fn mata_quem_roda_na_pasta() {
        if cfg!(windows) { return; }
        let d = std::env::temp_dir().join(format!("sf-orfaos-{}", std::process::id())).join(".cardume").join("worktrees").join("t1");
        std::fs::create_dir_all(&d).unwrap();
        let mut ch = Command::new("sleep").arg("30").current_dir(&d).spawn().unwrap();
        // sob carga (cargo test em paralelo) o exec do sleep pode demorar: tenta por até ~3 s
        let mut n = 0;
        for _ in 0..15 { std::thread::sleep(Duration::from_millis(200)); n = kill_in_dir(&d); if n >= 1 { break; } }
        assert!(n >= 1);
        let st = ch.wait().unwrap();
        assert!(!st.success(), "o sleep morreu antes dos 30 s");
        let _ = std::fs::remove_dir_all(d.parent().unwrap().parent().unwrap().parent().unwrap());
    }
}
