//! RESOLVEDOR ÚNICO de CLIs instaladas pelo usuário (codex, dsh, node) — o MESMO algoritmo de
//! src/engine/bin-resolve.ts; os dois lados passam pelo fixture tests/fixtures/bin-resolve/cases.json.
//!
//! Aberto pelo Finder/Dock o app herda PATH mínimo. Antes o codex era procurado só ao lado dos nodes conhecidos
//! + Homebrew (Rust) e ao lado do node do motor + Homebrew (TS): no Mac do Roberto (02/10) o motor (TS) não achou o
//! codex que estava no nvm de OUTRA versão de node → `spawn codex ENOENT` com o codex instalado e o Ambiente "ok".
//!
//! Ordem: override (CARDUME_<NOME>) → PATH → ao lado do node em uso → nvm (mais nova primeiro), fnm, volta, asdf,
//! mise → prefixo do npm (~/.npmrc, ~/.npm-global, ~/.npm-packages) → Homebrew, /usr/local/bin, ~/.local/bin,
//! pnpm, bun, ~/bin → CLI dentro de Codex.app/ChatGPT.app → LENTO: `$SHELL -lic 'command -v X'` (timeout, cache)
//! e `npm prefix -g`.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default)]
pub(crate) struct Ctx {
    pub home: PathBuf,
    pub path: std::ffi::OsString,
    pub node_dirs: Vec<PathBuf>,
    /// prefixo das pastas absolutas do sistema ("" em produção; pasta fake nos testes)
    pub root: PathBuf,
    pub override_bin: Option<PathBuf>,
    pub shell: Option<PathBuf>,
    pub shell_timeout: Duration,
    /// shell de login / npm prefix -g podem rodar?
    pub slow: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Resolution {
    pub bin: Option<String>,
    pub via: String,
    pub searched: Vec<String>,
}

fn is_file(p: &Path) -> bool { p.is_file() }

/// "v22.3.0" → (22,3,0) — ordena por número ("v9" < "v22").
pub(crate) fn ver_key(s: &str) -> (i64, i64, i64) {
    let digits: Vec<i64> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|x| !x.is_empty())
        .take(3)
        .map(|x| x.parse().unwrap_or(0))
        .collect();
    if digits.is_empty() { return (-1, 0, 0); }
    (digits[0], *digits.get(1).unwrap_or(&0), *digits.get(2).unwrap_or(&0))
}
pub(crate) fn newest_first(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| ver_key(b).cmp(&ver_key(a)).then_with(|| b.cmp(a)));
    names
}
fn ls_dirs(p: &Path) -> Vec<String> {
    std::fs::read_dir(p)
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default()
}

fn npmrc_prefix(home: &Path) -> Option<PathBuf> {
    let txt = std::fs::read_to_string(home.join(".npmrc")).ok()?;
    let h = home.display().to_string();
    for line in txt.lines() {
        let l = line.trim();
        let Some(rest) = l.strip_prefix("prefix") else { continue };
        let Some(v) = rest.trim_start().strip_prefix('=') else { continue };
        let mut v = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if v == "~" || v.starts_with("~/") { v = format!("{h}{}", &v[1..]); }
        v = v.replace("${HOME}", &h).replace("$HOME", &h);
        if !v.is_empty() { return Some(PathBuf::from(v)); }
    }
    None
}

/// Pastas a procurar, em ordem, com rótulo (só disco — rápido).
pub(crate) fn candidate_dirs(name: &str, c: &Ctx) -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = vec![];
    let mut add = |d: PathBuf, l: &'static str| { if !d.as_os_str().is_empty() && !out.iter().any(|(x, _)| *x == d) { out.push((d, l)); } };
    let sys = |p: &str| if c.root.as_os_str().is_empty() { PathBuf::from(p) } else { c.root.join(p.trim_start_matches('/')) };
    let h = |p: &str| c.home.join(p);
    for d in std::env::split_paths(&c.path) { add(d, "PATH"); }
    for d in &c.node_dirs { add(d.clone(), "ao lado do node em uso"); }
    let nvm = h(".nvm/versions/node");
    for v in newest_first(ls_dirs(&nvm)) { add(nvm.join(v).join("bin"), "nvm"); }
    for base in [h(".local/share/fnm/node-versions"), h(".fnm/node-versions"), h("Library/Application Support/fnm/node-versions")] {
        for v in newest_first(ls_dirs(&base)) { add(base.join(v).join("installation/bin"), "fnm"); }
    }
    add(h(".volta/bin"), "volta");
    add(h(".asdf/shims"), "asdf");
    let asdf = h(".asdf/installs/nodejs");
    for v in newest_first(ls_dirs(&asdf)) { add(asdf.join(v).join("bin"), "asdf"); }
    add(h(".local/share/mise/shims"), "mise");
    let mise = h(".local/share/mise/installs/node");
    for v in newest_first(ls_dirs(&mise)) { add(mise.join(v).join("bin"), "mise"); }
    if let Some(p) = npmrc_prefix(&c.home) { add(p.join("bin"), "npm prefix (~/.npmrc)"); }
    add(h(".npm-global/bin"), "npm global");
    add(h(".npm-packages/bin"), "npm global");
    add(sys("/opt/homebrew/bin"), "Homebrew");
    add(sys("/usr/local/bin"), "Homebrew/usr/local");
    add(h(".local/bin"), "~/.local/bin");
    add(h("Library/pnpm"), "pnpm");
    add(h(".local/share/pnpm"), "pnpm");
    add(h(".bun/bin"), "bun");
    add(h("bin"), "~/bin");
    if name == "codex" {
        for apps in [sys("/Applications"), h("Applications")] {
            add(apps.join("Codex.app/Contents/Resources"), "app Codex");
            add(apps.join("ChatGPT.app/Contents/Resources"), "app ChatGPT");
        }
    }
    out
}

fn tilde(p: &Path, home: &Path) -> String {
    let s = p.display().to_string();
    let h = home.display().to_string();
    if !h.is_empty() && s.starts_with(&h) { format!("~{}", &s[h.len()..]) } else { s }
}

/// Saída do `$SHELL -lic 'command -v X'` → caminho (ignora lixo do .zshrc, alias e função).
pub(crate) fn parse_shell_lookup(out: &str, is_f: impl Fn(&Path) -> bool) -> Option<String> {
    out.lines().rev().map(str::trim).filter(|l| !l.is_empty()).find(|l| Path::new(l).is_absolute() && is_f(Path::new(l))).map(String::from)
}

/// (achou?, quando) por shell+nome: positivo vale pro processo, negativo por 60s.
static SHELL_CACHE: Mutex<Vec<(String, Option<String>, Instant)>> = Mutex::new(Vec::new());
static RES_CACHE: Mutex<Vec<(String, Resolution, Instant)>> = Mutex::new(Vec::new());
pub(crate) fn clear_cache() {
    SHELL_CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
    RES_CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

pub(crate) fn shell_lookup(name: &str, shell: &Path, timeout: Duration, home: &Path) -> Option<String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || !shell.is_file() { return None; }
    let key = format!("{}\0{name}", shell.display());
    if let Some((_, b, at)) = SHELL_CACHE.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _, _)| *k == key).cloned() {
        if b.is_some() || at.elapsed() < Duration::from_secs(60) { return b; }
    }
    let mut cmd = Command::new(shell);
    cmd.args(["-lic", &format!("command -v {name}")]).env("HOME", home).env("TERM", "dumb");
    let b = run_timeout(cmd, timeout).and_then(|s| parse_shell_lookup(&s, is_file));
    let mut c = SHELL_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    c.retain(|(k, _, _)| *k != key);
    c.push((key, b.clone(), Instant::now()));
    b
}

/// stdout do comando com timeout (estourou → mata). stdin/stderr nulos: um .zshrc interativo não prende nada.
fn run_timeout(mut cmd: Command, timeout: Duration) -> Option<String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // o shell e os filhos dele num grupo próprio: o kill no timeout leva todos
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut out, &mut s); s });
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                #[cfg(unix)]
                unsafe_kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}
#[cfg(unix)]
fn unsafe_kill_group(pid: u32) {
    // sem libc direto (Windows): `kill -9 -<pgid>` mata o grupo inteiro (o sleep/zsh filho junto)
    let _ = Command::new("/bin/kill").args(["-9", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn npm_prefix_g(c: &Ctx) -> Option<PathBuf> {
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    for d in c.node_dirs.iter().cloned().chain(std::env::split_paths(&c.path)) {
        let bin = d.join(npm);
        if !bin.is_file() { continue; }
        let mut cmd = Command::new(&bin);
        let mut p = vec![d.clone()];
        p.extend(std::env::split_paths(&c.path));
        if let Ok(j) = std::env::join_paths(p) { cmd.env("PATH", j); }
        cmd.args(["prefix", "-g"]);
        if let Some(s) = run_timeout(cmd, Duration::from_secs(4)) {
            let l = s.lines().last().unwrap_or("").trim().to_string();
            if Path::new(&l).is_absolute() { return Some(PathBuf::from(l)); }
        }
    }
    None
}

/// O algoritmo, PURO sobre o ctx.
pub(crate) fn resolve_in(name: &str, c: &Ctx) -> Resolution {
    let mut searched: Vec<String> = vec![];
    let exe = format!("{name}.exe");
    let names: Vec<&str> = if cfg!(windows) { vec![exe.as_str(), name] } else { vec![name] };
    if let Some(o) = &c.override_bin {
        searched.push(format!("CARDUME_{}={}", name.to_uppercase(), o.display()));
        if o.is_file() { return Resolution { bin: Some(o.display().to_string()), via: "variável de ambiente".into(), searched }; }
    }
    let cands = candidate_dirs(name, c);
    for (i, (d, l)) in cands.iter().enumerate() {
        for n in &names {
            let p = d.join(n);
            if p.is_file() {
                searched.extend(cands[..i].iter().map(|(x, _)| tilde(x, &c.home)));
                return Resolution { bin: Some(p.display().to_string()), via: (*l).into(), searched };
            }
        }
    }
    searched.extend(cands.iter().map(|(x, _)| tilde(x, &c.home)));
    if c.slow {
        if let Some(sh) = &c.shell {
            searched.push(format!("shell de login ({} -lic 'command -v {name}')", sh.display()));
            if let Some(b) = shell_lookup(name, sh, c.shell_timeout, &c.home) {
                return Resolution { bin: Some(b), via: "login shell".into(), searched };
            }
        }
        let pre = npm_prefix_g(c);
        searched.push(match &pre { Some(p) => format!("npm prefix -g ({}/bin)", tilde(p, &c.home)), None => "npm prefix -g".into() });
        if let Some(p) = pre {
            for n in &names {
                let b = p.join("bin").join(n);
                if b.is_file() { return Resolution { bin: Some(b.display().to_string()), via: "npm prefix -g".into(), searched }; }
            }
        }
    }
    Resolution { bin: None, via: String::new(), searched }
}

/// Contexto REAL. `node` = o node que o app escolheu (node_bin) — entra como "ao lado do node em uso".
pub(crate) fn live_ctx(name: &str, node: Option<String>) -> Ctx {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    let mut node_dirs: Vec<PathBuf> = vec![];
    if let Ok(n) = std::env::var("CARDUME_NODE") {
        if let Some(d) = Path::new(&n).parent().filter(|_| Path::new(&n).is_file()) { node_dirs.push(d.to_path_buf()); }
    }
    if let Some(n) = node {
        if let Some(d) = Path::new(&n).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !node_dirs.iter().any(|x| x == d) { node_dirs.push(d.to_path_buf()); }
        }
    }
    let shell = std::env::var_os("SHELL").map(PathBuf::from).or_else(|| {
        if cfg!(target_os = "macos") { Some(PathBuf::from("/bin/zsh")) } else if cfg!(windows) { None } else { Some(PathBuf::from("/bin/bash")) }
    });
    Ctx {
        home,
        path: std::env::var_os("PATH").unwrap_or_default(),
        node_dirs,
        root: PathBuf::new(),
        override_bin: std::env::var(format!("CARDUME_{}", name.to_uppercase())).ok().filter(|s| !s.is_empty()).map(PathBuf::from),
        shell,
        shell_timeout: Duration::from_secs(3),
        slow: true,
    }
}

/// Resolução com cache (30s achou / 60s não achou — o caminho lento não roda a cada chamada).
fn cache_key(name: &str) -> String {
    let ov = std::env::var(format!("CARDUME_{}", name.to_uppercase())).unwrap_or_default();
    format!("{name}\0{ov}\0{}", std::env::var("HOME").unwrap_or_default())
}
pub(crate) fn resolve_cached(name: &str, node: impl FnOnce() -> Option<String>) -> Resolution {
    // a chave leva o override (CARDUME_<NOME>) e o HOME: trocar qualquer um (testes, "verificar de novo") procura de novo
    let key = cache_key(name);
    if let Some((_, r, at)) = RES_CACHE.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _, _)| *k == key).cloned() {
        let fresh = at.elapsed() < Duration::from_secs(if r.bin.is_some() { 30 } else { 60 });
        let still = r.bin.as_deref().map_or(true, |b| Path::new(b).is_file());
        if fresh && still { return r; }
    }
    let r = resolve_in(name, &live_ctx(name, node()));
    let mut c = RES_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    c.retain(|(k, _, _)| *k != key);
    c.push((key, r.clone(), Instant::now()));
    r
}

/// Caminho JÁ resolvido (cache), sem procurar de novo — barato o bastante pra cada spawn do motor.
pub(crate) fn peek(name: &str) -> Option<String> {
    let key = cache_key(name);
    RES_CACHE.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _, _)| *k == key).and_then(|(_, r, _)| r.bin.clone()).filter(|b| Path::new(b).is_file())
}

/// "Procurei em:" pra mensagem de não encontrado.
pub(crate) fn searched_list(r: &Resolution) -> String {
    r.searched.iter().take(40).map(|s| format!("  • {s}")).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/bin-resolve/cases.json");
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn fixture_compartilhado_com_o_ts() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        let fx = fixture();
        for c in fx["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let base = std::env::temp_dir().join(format!("binres-rs-{}-{}", std::process::id(), name.len() * 7919 + name.bytes().map(|b| b as usize).sum::<usize>()));
            let _ = std::fs::remove_dir_all(&base);
            let home = base.join("home");
            let root = base.join("root");
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&root).unwrap();
            let map = |p: &str| if let Some(r) = p.strip_prefix("~/") { home.join(r) } else { root.join(p.trim_start_matches('/')) };
            let put = |p: &str, body: &str, exec: bool| {
                let f = map(p);
                std::fs::create_dir_all(f.parent().unwrap()).unwrap();
                std::fs::write(&f, body).unwrap();
                #[cfg(unix)]
                if exec { std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap(); }
            };
            for f in c["files"].as_array().unwrap() { put(f.as_str().unwrap(), "#!/bin/sh\necho fake\n", true); }
            if let Some(m) = c["contents"].as_object() { for (k, v) in m { put(k, v.as_str().unwrap(), false); } }
            let path: Vec<PathBuf> = c["path"].as_array().unwrap().iter().map(|d| map(d.as_str().unwrap())).collect();
            for d in &path { std::fs::create_dir_all(d).unwrap(); }
            let shell = match &c["shell"] {
                serde_json::Value::String(s) if s == "hang" => {
                    let sh = base.join("fake-shell");
                    std::fs::write(&sh, "#!/bin/sh\nsleep 20\n").unwrap();
                    Some(sh)
                }
                serde_json::Value::Object(o) => {
                    let sh = base.join("fake-shell");
                    let lines: Vec<String> = o["print"].as_array().unwrap().iter().map(|l| {
                        let l = l.as_str().unwrap();
                        let l = if l.starts_with("~/") { map(l).display().to_string() } else { l.to_string() };
                        format!("echo '{l}'")
                    }).collect();
                    std::fs::write(&sh, format!("#!/bin/sh\n{}\n", lines.join("\n"))).unwrap();
                    Some(sh)
                }
                _ => None,
            };
            #[cfg(unix)]
            if let Some(sh) = &shell { std::fs::set_permissions(sh, std::fs::Permissions::from_mode(0o755)).unwrap(); }
            clear_cache();
            let ctx = Ctx {
                home: home.clone(),
                path: std::env::join_paths(&path).unwrap(),
                node_dirs: c["node"].as_str().map(|n| vec![map(n)]).unwrap_or_default(),
                root: root.clone(),
                override_bin: c["override"].as_str().map(map),
                shell,
                shell_timeout: Duration::from_millis(1500),
                slow: true,
            };
            let t0 = Instant::now();
            let r = resolve_in("codex", &ctx);
            let want = c["expect"].as_str().map(|e| map(e).display().to_string());
            assert_eq!(r.bin, want, "caso: {name}");
            for s in c["searched"].as_array().cloned().unwrap_or_default() {
                let s = s.as_str().unwrap();
                assert!(r.searched.iter().any(|x| x.contains(s)), "caso {name}: procurou em {s}? {:?}", r.searched);
            }
            if c["shell"].as_str() == Some("hang") { assert!(t0.elapsed() < Duration::from_secs(6), "timeout do shell segurou"); }
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    #[test]
    fn versoes_por_numero() {
        let v = newest_first(vec!["v9.0.0".into(), "v22.3.0".into(), "v18.20.1".into(), "v22.14.0".into()]);
        assert_eq!(v, vec!["v22.14.0", "v22.3.0", "v18.20.1", "v9.0.0"]);
    }

    #[test]
    fn saida_do_shell_de_login() {
        let ok = |p: &Path| p == Path::new("/x/bin/codex");
        assert_eq!(parse_shell_lookup("Bem-vindo!\nalias codex='npx codex'\n/nao/existe/codex\n/x/bin/codex\n", ok).as_deref(), Some("/x/bin/codex"));
        assert_eq!(parse_shell_lookup("codex: aliased to npx codex\n", ok), None);
    }

    /// PATH mínimo de verdade (Finder): acha o codex desta máquina se houver um.
    #[test]
    fn path_minimo_acha_o_codex_real() {
        let Ok(o) = Command::new("/bin/sh").args(["-lc", "command -v codex"]).output() else { return };
        if String::from_utf8_lossy(&o.stdout).trim().is_empty() { return; }
        let mut c = live_ctx("codex", None);
        c.path = "/usr/bin:/bin:/usr/sbin:/sbin".into();
        c.override_bin = None;
        let r = resolve_in("codex", &c);
        assert!(r.bin.is_some(), "achou com PATH mínimo: {:?}", r.searched);
    }
}
