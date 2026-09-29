use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// Sinais usados pra controlar a árvore de processos do agente (pausar/retomar/
/// matar). No Unix são os SIGxxx reais entregues ao GRUPO. No Windows não existe
/// grupo de processo POSIX nem pause/resume nativo pra árvore arbitrária — CONT/
/// STOP viram no-op e TERM/KILL derrubam a árvore inteira via `taskkill /T /F`.
mod memoria;
mod mesa;
#[cfg(test)]
mod snapshot_perf;

mod procsig {
    #[cfg(unix)]
    pub const KILL: i32 = libc::SIGKILL;
    #[cfg(unix)]
    pub const TERM: i32 = libc::SIGTERM;
    #[cfg(unix)]
    pub const CONT: i32 = libc::SIGCONT;
    #[cfg(unix)]
    pub const STOP: i32 = libc::SIGSTOP;
    #[cfg(windows)]
    pub const KILL: i32 = 9;
    #[cfg(windows)]
    pub const TERM: i32 = 15;
    #[cfg(windows)]
    pub const CONT: i32 = 18;
    #[cfg(windows)]
    pub const STOP: i32 = 19;
}

/// Mata UM processo pelo pid (não o grupo — usado quando o processo não foi
/// spawnado como líder de grupo próprio).
#[cfg(unix)]
fn kill_pid(pid: i32, sig: i32) {
    unsafe { libc::kill(pid, sig); }
}
#[cfg(windows)]
fn kill_pid(pid: i32, _sig: i32) {
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// PID ainda vivo? (Unix: kill(pid, 0); Windows: procura o PID na tasklist.)
#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}
#[cfg(windows)]
fn pid_alive(pid: i32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
        .unwrap_or(false)
}

/// Deixa o processo pronto pra virar líder de um grupo próprio, ANTES do spawn
/// (Unix: setsid via pre_exec; Windows: flag de criação equivalente).
#[cfg(unix)]
fn detach_new_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}
#[cfg(windows)]
fn detach_new_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Repo explícito (quando a tela está PRESA a um projeto — ex.: plano do orquestrador
/// criado num repo enquanto o usuário troca o projeto ativo na barra lateral) ou o ativo.
fn repo_or(state: &State<AppState>, repo: Option<String>) -> Result<PathBuf, String> {
    if let Some(r) = repo {
        let r = r.trim().to_string();
        if !r.is_empty() {
            let p = PathBuf::from(&r);
            if p.is_dir() { return Ok(p); }
        }
    }
    repo_of(state)
}
fn repo_of(state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .db
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()))
        .ok_or_else(|| "repo não definido".to_string())
}

/// Caminho do motor bundlado (engine/cli.mjs), resolvido UMA vez no setup do
/// Tauri via `resource_dir()` — funciona no .app do macOS e no .deb/.AppImage do
/// Linux, onde o layout de recursos é diferente e não dá pra deduzir do exe.
static ENGINE_RESOURCE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Motor: CARDUME_CLI (dev — TS ao vivo) → recurso bundlado (resource_dir) →
/// heurística pelo exe (.app do macOS) → src/cli.ts do repo aberto (último recurso).
fn cli_path(repo: &PathBuf) -> String {
    if let Ok(p) = std::env::var("CARDUME_CLI") {
        if !p.is_empty() && std::path::Path::new(&p).is_file() {
            return p;
        }
    }
    if let Some(Some(p)) = ENGINE_RESOURCE.get() {
        if p.is_file() {
            return p.display().to_string();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        // Contents/MacOS/Starfork → Contents/Resources/engine/cli.mjs
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            let bundled = contents.join("Resources").join("engine").join("cli.mjs");
            if bundled.is_file() {
                return bundled.display().to_string();
            }
        }
    }
    repo.join("src").join("cli.ts").display().to_string()
}

/// Node: CARDUME_NODE → homebrew/local → a versão mais nova do nvm → PATH.
fn node_bin() -> String {
    if let Ok(n) = std::env::var("CARDUME_NODE") {
        if !n.is_empty() && std::path::Path::new(&n).is_file() {
            return n;
        }
    }
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if std::path::Path::new(p).is_file() {
            return p.to_string();
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let nvm = std::path::PathBuf::from(home).join(".nvm").join("versions").join("node");
        if let Ok(rd) = std::fs::read_dir(&nvm) {
            let mut vers: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            vers.sort(); // lexicográfico basta pra escolher determinístico; preflight valida >=22.6
            if let Some(latest) = vers.last() {
                let n = latest.join("bin").join("node");
                if n.is_file() {
                    return n.display().to_string();
                }
            }
        }
    }
    // último recurso: resolve pelo PATH (Linux via pacote, ou node no PATH do usuário)
    if let Ok(o) = Command::new("which").arg("node").output() {
        if o.status.success() {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).is_file() {
                return path;
            }
        }
    }
    "node".to_string()
}

/// Acha o `gh` sem depender do PATH (LaunchServices pode lançar com PATH mínimo).
/// E8 (bug #16): abre URL/arquivo/pasta no app padrão DO SISTEMA. Antes era `xdg-open` fora do Mac —
/// no Windows todo link externo, artefato e o login pelo Google falhavam.
/// macOS `open` · Windows `rundll32 url.dll,FileProtocolHandler` (aceita URL com `&`, que o `cmd /c start`
/// quebraria) · Linux `xdg-open`.
fn os_open(target: &std::ffi::OsStr) -> std::io::Result<std::process::Child> {
    if cfg!(target_os = "macos") {
        Command::new("open").arg(target).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("rundll32").arg("url.dll,FileProtocolHandler").arg(target).spawn()
    } else {
        Command::new("xdg-open").arg(target).spawn()
    }
}
/// Mostra o arquivo selecionado no gerenciador de arquivos (Finder `open -R` · Explorer `/select,`);
/// no Linux abre a pasta que o contém.
fn os_reveal(path: &std::path::Path) -> std::io::Result<std::process::Child> {
    if cfg!(target_os = "macos") {
        Command::new("open").arg("-R").arg(path).spawn()
    } else if cfg!(target_os = "windows") {
        let mut arg = std::ffi::OsString::from("/select,");
        arg.push(path.as_os_str());
        Command::new("explorer").arg(arg).spawn()
    } else {
        Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn()
    }
}

fn gh_bin() -> String {
    if let Ok(g) = std::env::var("CARDUME_GH") {
        if !g.is_empty() {
            return g;
        }
    }
    for cand in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        if std::path::Path::new(cand).exists() {
            return cand.to_string();
        }
    }
    "gh".to_string()
}

/// Command do claude SEM a API key do ambiente: aqui quem paga e SEMPRE a
/// assinatura (login claude.ai) - key setada cobraria por token e desliga connectors.
fn claude_cmd(bin: &str) -> Command {
    let mut c = Command::new(bin);
    c.env_remove("ANTHROPIC_API_KEY").env_remove("ANTHROPIC_AUTH_TOKEN");
    c
}
fn claude_bin() -> String {
    if let Ok(c) = std::env::var("CARDUME_CLAUDE") {
        if !c.is_empty() {
            return c;
        }
    }
    // Ao lado do node configurado PRIMEIRO (instalação dev/nvm — é o claude
    // que o dono realmente usa e atualiza); depois os locais padrão pra apps
    // lançados pelo Finder com PATH mínimo (instalador nativo → homebrew).
    if let Ok(node) = std::env::var("CARDUME_NODE") {
        if let Some(dir) = std::path::Path::new(&node).parent() {
            let cand = dir.join("claude");
            if cand.exists() {
                return cand.display().to_string();
            }
        }
    }
    // ao lado do node que o app RESOLVEU (nvm incluso): com nvm, `npm i -g`
    // instala o claude exatamente nessa pasta — era o furo que deixava o
    // Ambiente dizendo "não encontrado" com o claude instalado
    {
        let nb = node_bin();
        if nb != "node" {
            if let Some(dir) = std::path::Path::new(&nb).parent() {
                let cand = dir.join("claude");
                if cand.is_file() {
                    return cand.display().to_string();
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        for rel in [".local/bin/claude", ".claude/local/claude"] {
            let cand = home.join(rel);
            if cand.is_file() {
                return cand.display().to_string();
            }
        }
        // qualquer versão do nvm (o claude pode estar numa versão mais antiga
        // de node do que a que o app escolheu) — mais novas primeiro
        let nvm = home.join(".nvm").join("versions").join("node");
        if let Ok(rd) = std::fs::read_dir(&nvm) {
            let mut vs: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            vs.sort();
            for v in vs.iter().rev() {
                let cand = v.join("bin").join("claude");
                if cand.is_file() {
                    return cand.display().to_string();
                }
            }
        }
    }
    for p in ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] {
        if std::path::Path::new(p).is_file() {
            return p.to_string();
        }
    }
    "claude".to_string()
}

/// `--model <id>` pros chats no claude — só id seguro (mesma regra do set_task_model); vazio/inválido = padrão da assinatura.
fn push_model(args: &mut Vec<String>, model: &Option<String>) {
    if let Some(m) = model.as_deref().map(str::trim) {
        if !m.is_empty() && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]".contains(c)) {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
    }
}

fn push_opt(args: &mut Vec<String>, flag: &str, val: &Option<String>) {
    if let Some(v) = val {
        if !v.is_empty() {
            args.push(flag.to_string());
            args.push(v.clone());
        }
    }
}

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use tauri::State;

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Caminho do state.sqlite atual (um repo por vez, por enquanto).
#[derive(Default)]
struct AppState {
    db: Mutex<Option<PathBuf>>,
    /// PID (= líder do grupo de processos) de cada tarefa em execução, por id.
    /// Permite pausar/retomar/abortar a árvore inteira do agente (node + claude).
    procs: Arc<Mutex<HashMap<String, i32>>>,
}

impl AppState {
    fn from_env() -> Self {
        // Restaura o ÚLTIMO projeto ativo (topo da lista persistida); só cai no
        // CARDUME_REPO quando ainda não há projetos abertos. Assim reiniciar o
        // app não joga o usuário de volta pro projeto do env.
        let db = read_project_list()
            .iter()
            .map(|p| PathBuf::from(p).join(".cardume").join("state.sqlite"))
            .find(|db| db.exists())
            .or_else(|| {
                std::env::var("CARDUME_REPO")
                    .ok()
                    .map(|r| PathBuf::from(r).join(".cardume").join("state.sqlite"))
            });
        if let Some(d) = &db {
            ensure_app_schema(d);
        }
        AppState { db: Mutex::new(db), procs: Arc::new(Mutex::new(HashMap::new())) }
    }
}

/// Slug ascii SEM limite (idempotente sob o slugify() do TS): minúsculas,
/// acentos PT→ascii, runs não-alfanuméricos viram '-', apara pontas.
fn slug_raw(input: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in input.trim().chars() {
        let c = ch.to_ascii_lowercase();
        let mapped: Option<char> = match c {
            'a'..='z' | '0'..='9' => Some(c),
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => Some('a'),
            'ç' => Some('c'),
            'è' | 'é' | 'ê' | 'ë' => Some('e'),
            'ì' | 'í' | 'î' | 'ï' => Some('i'),
            'ñ' => Some('n'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' => Some('o'),
            'ù' | 'ú' | 'û' | 'ü' => Some('u'),
            _ => None,
        };
        match mapped {
            Some(m) => {
                out.push(m);
                prev_dash = false;
            }
            None => {
                if !prev_dash && !out.is_empty() {
                    out.push('-');
                    prev_dash = true;
                }
            }
        }
    }
    out.trim_matches('-').to_string()
}

/// Slug limitado pra id/branch. Se o título não couber, quem chama deve
/// preferir REFAZER o nome via IA (ai_branch_name) — este corte em fronteira
/// de palavra é o fallback offline.
fn slug_id(input: &str) -> String {
    let full = slug_raw(input);
    let mut s = if full.len() > 48 {
        let mut cut = full[..48].to_string();
        if let Some(i) = cut.rfind('-') {
            if i > 0 {
                cut.truncate(i);
            }
        }
        cut
    } else {
        full
    };
    while s.ends_with('-') {
        s.pop();
    }
    if s.is_empty() { "tarefa".to_string() } else { s }
}

/// Nome de branch REFEITO pela IA quando o título não cabe no slug (48).
/// Haiku resume o título num kebab-case curto; timeout curto e best-effort —
/// falhou/offline → None e o chamador usa o corte em fronteira de palavra.
fn ai_branch_name(title: &str) -> Option<String> {
    let prompt = format!(
        "Resuma este título de tarefa num NOME DE BRANCH curto: kebab-case, só ascii minúsculo e hifens, 3 a 5 palavras, máximo 40 caracteres, capturando a essência. Responda SOMENTE o nome, sem aspas.\n\nTítulo: {title}"
    );
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(["-p", &prompt, "--model", "claude-haiku-4-5-20251001"]);
    let out = output_timeout(cmd, 20).ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let name = slug_id(s.trim().trim_matches('"'));
    // sanidade: nome curto real, não eco do título nem vazio
    if name.len() >= 8 && name.len() <= 48 && name != "tarefa" { Some(name) } else { None }
}

#[cfg(all(test, unix))]
mod stoppable_tests {
    use super::*;
    static TEST_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
    #[test]
    fn output_stoppable_para_e_devolve_marcador() {
        let h = std::thread::spawn(|| {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 20"]);
            output_stoppable(c, 30, &TEST_PID, "TEST_STOPPED")
        });
        let t0 = std::time::Instant::now();
        while TEST_PID.load(std::sync::atomic::Ordering::SeqCst) == 0 && t0.elapsed().as_secs() < 5 { std::thread::sleep(std::time::Duration::from_millis(20)); }
        assert!(stop_slot(&TEST_PID));
        let r = h.join().unwrap();
        assert_eq!(r.err().as_deref(), Some("TEST_STOPPED"));
        assert!(t0.elapsed().as_secs() < 10);
        assert!(!stop_slot(&TEST_PID)); // nada rodando → false
    }
    #[test]
    fn output_stoppable_ok_quando_termina() {
        static P2: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
        let mut c = Command::new("sh");
        c.args(["-c", "echo oi"]);
        let o = output_stoppable(c, 10, &P2, "X").unwrap();
        assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "oi");
        assert_eq!(P2.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}

#[cfg(test)]
mod quick_project_tests {
    use super::{project_slug, unique_child};
    #[test]
    fn nome_livre_com_sufixo() {
        let tmp = std::env::temp_dir().join(format!("starfork-quick-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(unique_child(&tmp, "app"), "app");
        std::fs::create_dir_all(tmp.join("app")).unwrap();
        assert_eq!(unique_child(&tmp, "app"), "app-2");
        std::fs::create_dir_all(tmp.join("app-2")).unwrap();
        assert_eq!(unique_child(&tmp, "app"), "app-3");
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(project_slug("  App de Aulas "), "app-de-aulas");
        assert_eq!(project_slug("Painel Finanças — Ação"), "painel-financas-acao");
    }
}

#[cfg(test)]
mod push_model_tests {
    use super::push_model;
    #[test]
    fn modelo_escolhido_vira_flag_so_quando_valido() {
        let mut a = vec![];
        push_model(&mut a, &Some(" claude-opus-5-5 ".into()));
        assert_eq!(a, vec!["--model".to_string(), "claude-opus-5-5".to_string()]);
        for bad in [None, Some(String::new()), Some("  ".into()), Some("opus; rm -rf /".into())] {
            let mut b: Vec<String> = vec![];
            push_model(&mut b, &bad);
            assert!(b.is_empty(), "{bad:?}");
        }
    }
}

#[cfg(test)]
mod slug_tests {
    use super::slug_id;
    #[test]
    fn corta_em_fronteira_de_palavra() {
        assert_eq!(slug_id("Campos bloqueados seguem aparecendo na conversa"), "campos-bloqueados-seguem-aparecendo-na-conversa");
        assert_eq!(slug_id("Erro na tela de admin de cadastro de usuários"), "erro-na-tela-de-admin-de-cadastro-de-usuarios");
        assert_eq!(slug_id("Refatoração do cockpit — do atual à visão por papel"), "refatoracao-do-cockpit-do-atual-a-visao-por");
        // palavra única maior que o limite: corta duro em 48
        assert_eq!(slug_id("supercalifragilisticexpialidocioussupercalifragilistic").len(), 48);
        // idempotente: slug do slug é ele mesmo
        let s = slug_id("Corrigir quebra de layout nos chips de filtros");
        assert_eq!(slug_id(&s), s);
    }
}

/// Roda um comando com TETO de tempo; mata o processo se estourar. Evita que a
/// UI trave quando a rede cai (gh/claude podem pendurar) ou que processos se
/// acumulem. Best-effort — em caso de timeout retorna Err e o processo é morto.
/// Lê a saída de `claude -p --output-format json`. O claude devolve erro de
/// duas formas: exit≠0 com mensagem no stderr, OU exit 1 com stderr VAZIO e o
/// erro dentro do JSON do stdout (`is_error:true`, texto em `result`) — é o
/// caso de login expirado (401 OAuth), rate limit, etc. Só ler o stderr
/// deixava o chat com um "⚠" sem texto nenhum.
fn claude_json(out: &std::process::Output) -> Result<serde_json::Value, String> {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let parsed: Option<serde_json::Value> = serde_json::from_str(stdout.trim()).ok();
    if let Some(v) = &parsed {
        if v["is_error"].as_bool().unwrap_or(false) {
            let msg = v["result"].as_str().unwrap_or("").trim().to_string();
            return Err(claude_friendly_error(&msg));
        }
    }
    if !out.status.success() {
        if !stderr.is_empty() {
            return Err(claude_friendly_error(&stderr));
        }
        let snippet: String = stdout.trim().chars().take(200).collect();
        return Err(format!(
            "claude saiu com código {} sem mensagem{}",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            if snippet.is_empty() { String::new() } else { format!(": {snippet}") }
        ));
    }
    parsed.ok_or_else(|| {
        let snippet: String = stdout.trim().chars().take(200).collect();
        format!("resposta inesperada do claude (não é JSON): {snippet}")
    })
}

/// Traduz os erros mais comuns do claude headless pra uma ação concreta.
fn claude_friendly_error(msg: &str) -> String {
    let l = msg.to_lowercase();
    if l.contains("oauth") || l.contains("authenticate") || l.contains("401") || l.contains("not logged in") || l.contains("invalid api key") {
        return format!("Login do Claude Code expirou — abra um terminal, rode `claude` e digite /login (ou `claude auth login`), depois tente de novo aqui.\n\n({msg})");
    }
    if l.contains("rate limit") || l.contains("429") || l.contains("usage limit") || l.contains("overloaded") {
        return format!("O Claude está sem cota/limite no momento — espere um pouco e tente de novo.\n\n({msg})");
    }
    if l.contains("no conversation found") || (l.contains("session") && l.contains("not found")) {
        return format!("A sessão da conversa expirou no Claude — clique em '+ novo' pra recomeçar.\n\n({msg})");
    }
    msg.to_string()
}

#[cfg(test)]
mod budget_spec_tests {
    use super::*;
    #[test]
    fn snapshot_carries_budget_keys_only() {
        let sp = serde_json::json!({"kind":"build","budgetUsd":7.5,"budgetHit":{"cap":5,"mode":"paused"},"deliverables":[]});
        let b = task_budget_spec(&sp).expect("tem teto");
        assert_eq!(b["budgetUsd"], 7.5);
        assert_eq!(b["budgetHit"]["mode"], "paused");
        assert!(b.get("kind").is_none());
        assert!(task_budget_spec(&serde_json::json!({"kind":"build"})).is_none());
        assert!(task_budget_spec(&serde_json::json!({"budgetHit":null})).is_none());
    }
}

#[cfg(test)]
mod claude_json_tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    fn out(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        #[cfg(unix)]
        let status = std::process::ExitStatus::from_raw(code << 8);
        #[cfg(windows)]
        let status = std::process::ExitStatus::from_raw(code as u32);
        std::process::Output { status, stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec() }
    }
    #[test]
    fn login_expirado_vira_mensagem_clara() {
        // saída REAL do `claude -p --output-format json` com o OAuth vencido: exit 1, stderr vazio
        let o = out(1, r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.","session_id":"x"}"#, "");
        let e = claude_json(&o).unwrap_err();
        assert!(e.starts_with("Login do Claude Code expirou"), "{e}");
        assert!(e.contains("401 OAuth"), "{e}");
    }
    #[test]
    fn stderr_continua_valendo() {
        let e = claude_json(&out(1, "", "boom")).unwrap_err();
        assert_eq!(e, "boom");
    }
    #[test]
    fn exit_sem_nada_nao_fica_vazio() {
        let e = claude_json(&out(1, "", "")).unwrap_err();
        assert!(e.contains("código 1"), "{e}");
    }
    #[test]
    fn sucesso_passa_o_json() {
        let v = claude_json(&out(0, r#"{"result":"oi","session_id":"s1"}"#, "")).unwrap();
        assert_eq!(v["result"], "oi");
    }
}

#[cfg(test)]
mod artifact_tests {
    use super::*;
    #[test]
    fn nome_citado_pelo_agente_normaliza() {
        assert_eq!(artifact_norm_name("./.cardume/artifacts/print.png", "t1"), "print.png");
        assert_eq!(artifact_norm_name(".cardume/artifacts/t1/entregaveis/r.pdf", "t1"), "entregaveis/r.pdf");
        assert_eq!(artifact_norm_name("t1/x.md", "t1"), "x.md");
        assert_eq!(artifact_norm_name("entregaveis/r.pdf", "t1"), "entregaveis/r.pdf");
        assert_eq!(artifact_norm_name("t10/x.md", "t1"), "t10/x.md");
    }
    #[test]
    fn nome_com_subpasta_vale_mas_escape_nao() {
        assert!(artifact_name_ok("relatorio.pdf"));
        assert!(artifact_name_ok("entregaveis/relatorio.pdf"));
        assert!(!artifact_name_ok("../x.pdf"));
        assert!(!artifact_name_ok("a/../x.pdf"));
        assert!(!artifact_name_ok("/etc/passwd"));
        assert!(!artifact_name_ok("a\\b.pdf"));
        assert!(!artifact_name_ok(""));
    }
    #[test]
    fn varredura_acha_pdf_em_subpasta_e_achata_pasta_da_tarefa() {
        let tmp = std::env::temp_dir().join(format!("cardume-art-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("entregaveis")).unwrap();
        std::fs::create_dir_all(tmp.join("minha-tarefa")).unwrap();
        std::fs::write(tmp.join("proof.md"), "x").unwrap();
        std::fs::write(tmp.join("entregaveis/relatorio.pdf"), "%PDF").unwrap();
        std::fs::write(tmp.join("minha-tarefa/diagnostico.pdf"), "%PDF").unwrap();
        std::fs::write(tmp.join(".DS_Store"), "").unwrap();
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_artifacts_dir(&tmp, "minha-tarefa", &mut out, &mut seen);
        let mut names: Vec<String> = out.iter().map(|a| a.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["diagnostico.pdf", "entregaveis/relatorio.pdf", "proof.md"]);
        assert_eq!(out.iter().find(|a| a.name == "entregaveis/relatorio.pdf").unwrap().kind, "pdf");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

fn output_timeout(mut cmd: Command, secs: u64) -> Result<std::process::Output, String> {
    use std::sync::mpsc;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id() as i32;
    let (tx, rx) = mpsc::channel::<()>();
    let watch = std::thread::spawn(move || {
        // se o processo não avisar que terminou dentro do tempo, mata.
        if rx.recv_timeout(std::time::Duration::from_secs(secs)).is_err() {
            kill_pid(pid, procsig::KILL);
        }
    });
    let out = child.wait_with_output();
    let _ = tx.send(()); // terminou a tempo → cancela o watchdog
    let _ = watch.join();
    match out {
        Ok(o) if o.status.success() || o.status.code().is_some() => Ok(o),
        Ok(_) => Err(format!("comando expirou após {secs}s (rede indisponível?)")),
        Err(e) => Err(e.to_string()),
    }
}

/// Igual ao output_timeout, mas PARÁVEL: o processo nasce num grupo próprio
/// (detach_new_group) e o pid fica em `slot` pra um comando *_stop derrubar o grupo
/// inteiro (signal_group). Parado pelo usuário → Err(`stopped`); estourou o tempo →
/// Err("comando expirou…"). Mesmo padrão do issue_chat/ISSUE_CHAT_PID.
fn output_stoppable(mut cmd: Command, secs: u64, slot: &'static std::sync::atomic::AtomicI32, stopped: &str) -> Result<std::process::Output, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    detach_new_group(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    let pid = child.id() as i32;
    slot.store(pid, Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let timed_out = std::sync::Arc::new(AtomicBool::new(false));
    let timed_out2 = timed_out.clone();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(secs)).is_err() { timed_out2.store(true, Ordering::SeqCst); signal_group(pid, procsig::KILL); }
    });
    let out = child.wait_with_output();
    let _ = tx.send(());
    let _ = watch.join();
    // só zera se ainda for o MEU pid (outra chamada pode ter começado)
    let _ = slot.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    let out = out.map_err(|e| e.to_string())?;
    if out.status.code().is_none() {
        return Err(if timed_out.load(Ordering::SeqCst) { format!("comando expirou após {secs}s (rede indisponível?)") } else { stopped.to_string() });
    }
    Ok(out)
}
fn stop_slot(slot: &std::sync::atomic::AtomicI32) -> bool {
    let pid = slot.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 { signal_group(pid, procsig::KILL); true } else { false }
}

/// Envia um sinal ao GRUPO de processos — atinge node + claude.
/// Unix: pid negativo (grupo criado via setsid em detach_new_group).
/// Windows: sem grupo POSIX — CONT/STOP não têm equivalente (no-op); TERM/KILL
/// derrubam a árvore inteira via `taskkill /T /F`.
#[cfg(unix)]
fn signal_group(pid: i32, sig: i32) {
    unsafe {
        libc::kill(-pid, sig);
    }
}
#[cfg(windows)]
fn signal_group(pid: i32, sig: i32) {
    if sig == procsig::TERM || sig == procsig::KILL {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

/// MODO PROTEGIDO — regras de NEGAÇÃO do Claude Code (`--disallowedTools`), que valem
/// MESMO em `--permission-mode bypassPermissions` (as regras de deny são avaliadas antes
/// do modo). ESPELHO de src/engine/protect.ts (denyRules) — o teste TS confere a lista.
const PROTECT_DENY: [&str; 50] = [
    "Read(**/.env)",
    "Edit(**/.env)",
    "Read(**/.env.local)",
    "Edit(**/.env.local)",
    "Read(**/.env.*.local)",
    "Edit(**/.env.*.local)",
    "Read(**/.env.development*)",
    "Edit(**/.env.development*)",
    "Read(**/.env.production*)",
    "Edit(**/.env.production*)",
    "Read(**/.env.staging*)",
    "Edit(**/.env.staging*)",
    "Read(**/.env.test*)",
    "Edit(**/.env.test*)",
    "Read(**/*.pem)",
    "Edit(**/*.pem)",
    "Read(**/*.key)",
    "Edit(**/*.key)",
    "Read(**/id_rsa*)",
    "Edit(**/id_rsa*)",
    "Read(**/id_ed25519*)",
    "Edit(**/id_ed25519*)",
    "Read(~/.ssh/**)",
    "Edit(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Edit(~/.aws/**)",
    "Read(**/.ssh/**)",
    "Edit(**/.ssh/**)",
    "Read(**/.aws/**)",
    "Edit(**/.aws/**)",
    "Bash(rm -rf /)",
    "Bash(rm -rf / *)",
    "Bash(rm -rf ~)",
    "Bash(rm -rf ~/)",
    "Bash(rm -rf ~/*)",
    "Bash(rm -rf $HOME*)",
    "Bash(git push --force*)",
    "Bash(git push -f*)",
    "Bash(git push * --force*)",
    "Bash(git push * -f)",
    "Bash(git push * -f *)",
    "Bash(curl * | sh*)",
    "Bash(curl * | bash*)",
    "Bash(wget * | sh*)",
    "Bash(wget * | bash*)",
    "Bash(sudo *)",
    "Bash(cat *.env)",
    "Bash(cat *.env.local)",
    "Bash(cat *.pem)",
    "Bash(cat *id_rsa*)",
];
/// Projeto "Protegido" (padrão) ou "Livre" — Preferências do projeto grava
/// `protect:<caminho do repo>` = "0" em ~/.constellation/settings.json pra desligar.
fn protect_on(repo: &std::path::Path) -> bool {
    setting_get(&format!("protect:{}", repo.display())).map(|v| v.trim() != "0").unwrap_or(true)
}
/// Args a pôr ANTES de `--permission-mode` (a flag é variádica: outra flag encerra a lista).
fn protect_args(on: bool) -> Vec<String> {
    if !on { return vec![]; }
    let mut v = vec!["--disallowedTools".to_string()];
    v.extend(PROTECT_DENY.iter().map(|s| s.to_string()));
    v
}
#[cfg(test)]
mod protect_tests {
    use super::*;
    #[test]
    fn livre_nao_passa_nada() { assert!(protect_args(false).is_empty()); }
    #[test]
    fn protegido_bloqueia_segredos_e_destrutivos() {
        let a = protect_args(true);
        assert_eq!(a[0], "--disallowedTools");
        assert_eq!(a.len(), 1 + PROTECT_DENY.len());
        for must in ["Read(**/.env)", "Edit(**/.env)", "Read(**/*.pem)", "Bash(rm -rf /)", "Bash(git push --force*)", "Bash(sudo *)"] {
            assert!(a.iter().any(|x| x == must), "{must}");
        }
        assert!(a[1..].iter().all(|r| !r.starts_with('-') && !r.contains(',')));
    }
}

/// Spawna um processo de tarefa em um NOVO grupo (setsid) e o registra por id,
/// pra podermos pausar/abortar a árvore inteira. Uma thread limpa o registro
/// quando o processo termina naturalmente (evita PID reciclado no mapa).
fn spawn_tracked(state: &State<AppState>, task_id: &str, mut cmd: Command) -> Result<(), String> {
    // O APP é quem notifica (plugin Tauri, atribuído ao Starfork — clicar
    // abre o app). As do motor via osascript saem como "Editor de Script" e o
    // clique abre ele; caladas aqui. No CLI puro (sem app) elas continuam.
    cmd.env("CARDUME_NOTIFY", "0");
    // intervalo (min) pra retomar sozinho quando bate o limite de uso da IA
    if let Some(m) = setting_get("limitRetryMin") { cmd.env("CARDUME_LIMIT_RETRY_MIN", m); }
    // modo protegido do PROJETO (padrão ligado) → o motor passa as regras de negação ao claude
    let protect = repo_of(state).map(|r| protect_on(&r)).unwrap_or(true);
    cmd.env("CARDUME_PROTECT", if protect { "1" } else { "0" });
    // novo grupo/sessão: o node vira líder e o claude herda o grupo
    detach_new_group(&mut cmd);
    // stdout/stderr ficam como o CHAMADOR configurou (ex.: new_task redireciona
    // pra .cardume/logs); quem não configura herda… nada: os callers setam null.
    let child = cmd
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("falha ao iniciar processo: {e}"))?;
    let pid = child.id() as i32;
    if let Ok(mut m) = state.procs.lock() {
        m.insert(task_id.to_string(), pid);
    }
    let procs = state.procs.clone();
    let tid = task_id.to_string();
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        if let Ok(mut m) = procs.lock() {
            if m.get(&tid) == Some(&pid) {
                m.remove(&tid);
            }
        }
    });
    Ok(())
}

/// Grava o status de uma tarefa direto no DB (usado por pausar/abortar, já que o
/// orquestrador está congelado/morto e não vai gravar sozinho).
fn set_task_status(state: &State<AppState>, task_id: &str, status: &str) -> Result<(), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    conn.execute("UPDATE task SET status=?1 WHERE id=?2", params![status, task_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// chaves do teto de custo que o front precisa ver no snapshot (None quando a tarefa não tem nenhuma)
fn task_budget_spec(spec: &serde_json::Value) -> Option<serde_json::Value> {
    let mut m = serde_json::Map::new();
    for k in ["budgetUsd", "budgetHit"] {
        if let Some(v) = spec.get(k).filter(|v| !v.is_null()) { m.insert(k.to_string(), v.clone()); }
    }
    if m.is_empty() { None } else { Some(serde_json::Value::Object(m)) }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    title: String,
    objective: String,
    status: String,
    agent: String,
    stage: String,
    roles: serde_json::Value,
    branch: String,
    worktree: String,
    base: String,
    engine: String,
    model: Option<String>,
    created_at: i64,
    sort_order: Option<i64>,
    deliverables: serde_json::Value,
    requirements: serde_json::Value,
    refs: serde_json::Value,
    kind: String,
    pr_url: Option<String>,
    issue_url: Option<String>,
    flag: Option<String>,
    auto_pr: Option<String>,
    linked_to: Option<String>,
    /// Plano do orquestrador que criou esta tarefa ({id,title,phase}) e de quem ela depende.
    orchestration: Option<serde_json::Value>,
    /// Campos de tarefa SOB ÉPICO (epicId, verify, covers, after, wave, risk, hitl, boundaries)
    /// tal como estão no spec — None numa tarefa comum. O front espalha isso de volta na nuvem.
    epic: Option<serde_json::Value>,
    depends_on: Vec<String>,
    /// Só as chaves do TETO de custo do spec (budgetUsd, budgetHit) — o front (53-teto-protecao) lê
    /// `t.spec`; sem isto a pausa acontecia mas a pergunta "continuar/parar" nunca aparecia.
    spec: Option<serde_json::Value>,
    /// Um turno do MOTOR está rodando agora (lock busy_pid vivo) — pode ser um
    /// turno de fundo (verificar provas, rework) mesmo com status 'review'.
    busy: bool,
    /// Pedidos (mensagens, entregáveis, rework) esperando na FILA do motor (work_queue 'queued').
    /// Com `busy` false e isto > 0 = fila parada: o front avisa em vez de a mensagem "sumir".
    queued: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Review {
    task_id: String,
    summary: String,
    functions: serde_json::Value,
    files: serde_json::Value,
    how_to_test: String,
    by_agent: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: i64,
    task_id: String,
    agent: String,
    ts: i64,
    #[serde(rename = "type")]
    kind: String,
    text: String,
    ok: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Claim {
    id: i64,
    task_id: String,
    agent: String,
    path: String,
    mode: String,
    yielded_to: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Diff {
    task_id: String,
    files: i64,
    additions: i64,
    deletions: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Pending {
    id: i64,
    task_id: String,
    agent: String,
    kind: String,
    prompt: String,
    options: serde_json::Value,
    created_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Cost {
    task_id: String,
    agent: String,
    role: Option<String>,
    usd: f64,
    in_tok: i64,
    out_tok: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    repo: Option<String>,
    /// false = pasta aberta sem repositório git (sem branch/PR/worktree até criar um)
    git: bool,
    /// false = repositório só local (sem remote): "abrir PR" vira "publicar no GitHub" (E4)
    remote: bool,
    tasks: Vec<Task>,
    events: Vec<Event>,
    claims: Vec<Claim>,
    diffs: Vec<Diff>,
    reviews: Vec<Review>,
    pending: Vec<Pending>,
    costs: Vec<Cost>,
}

/// Garante que o state.sqlite tenha as colunas/tabelas que o app CONSULTA
/// (o app abre read-only e não migra; quem migra é o CLI node). Sem isso, um
/// DB antigo quebra o snapshot inteiro e a UI fica vazia. Best-effort.
fn ensure_app_schema(db: &PathBuf) {
    if !db.exists() {
        return;
    }
    if let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_WRITE) {
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
        for stmt in [
            "ALTER TABLE task ADD COLUMN stage TEXT NOT NULL DEFAULT 'builder'",
            "ALTER TABLE task ADD COLUMN roles_json TEXT NOT NULL DEFAULT '[]'",
            "ALTER TABLE task ADD COLUMN session_id TEXT",
            "ALTER TABLE task ADD COLUMN sort_order INTEGER",
            "ALTER TABLE task ADD COLUMN done_roles INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE task ADD COLUMN flag TEXT",
        ] {
            let _ = conn.execute(stmt, []);
        }
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL)",
            [],
        );
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS instruction (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, applied_at INTEGER)",
            [],
        );
        // rascunho do Planner (1 linha) — sobrevive a fechar/crashar o app
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS planner_draft (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
            [],
        );
    }
}

fn open(path: &PathBuf) -> Result<Connection, String> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("abrindo {}: {}", path.display(), e))?;
    let _ = c.busy_timeout(std::time::Duration::from_millis(8000));
    Ok(c)
}

#[tauri::command(async)]
fn set_repo(state: State<AppState>, repo: String) -> Result<String, String> {
    let db = PathBuf::from(&repo).join(".cardume").join("state.sqlite");
    if !db.exists() {
        return Err(format!("sem state.sqlite em {} — rode `cardume init`", db.display()));
    }
    ensure_app_schema(&db);
    *state.db.lock().unwrap_or_else(|e| e.into_inner()) = Some(db.clone());
    Ok(repo)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    hash: String,
    parents: Vec<String>,
    refs: String,
    author: String,
    ts: i64,
    subject: String,
}

/// Lê o grafo de commits do repo (git log --all) para desenhar as branches.
#[tauri::command(async)]
fn graph(state: State<AppState>) -> Result<Vec<Commit>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let repo = db
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()))
        .ok_or("repo não definido")?;
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "log",
            "--all",
            "--date-order",
            "--max-count",
            "300",
            "--pretty=format:%H\x1f%P\x1f%D\x1f%an\x1f%at\x1f%s",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\u{1f}').collect();
        if f.len() < 6 {
            continue;
        }
        commits.push(Commit {
            hash: f[0].to_string(),
            parents: if f[1].is_empty() {
                vec![]
            } else {
                f[1].split(' ').map(|s| s.to_string()).collect()
            },
            refs: f[2].to_string(),
            author: f[3].to_string(),
            ts: f[4].parse().unwrap_or(0),
            subject: f[5].to_string(),
        });
    }
    Ok(commits)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitDetail {
    hash: String,
    author: String,
    date: String,
    subject: String,
    body: String,
    files: Vec<serde_json::Value>,
    diff: String,
    task_id: Option<String>,
}

/// Resumo técnico de um commit: mensagem (o quê + porquê) + arquivos alterados.
#[tauri::command(async)]
fn commit_detail(state: State<AppState>, hash: String) -> Result<CommitDetail, String> {
    let repo = repo_of(&state)?;
    let meta = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "show",
            "-s",
            "--date=short",
            "--format=%H\u{1f}%an\u{1f}%ad\u{1f}%s\u{1f}%b",
            &hash,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&meta.stdout);
    let f: Vec<&str> = text.trim_end().splitn(5, '\u{1f}').collect();
    if f.len() < 4 {
        return Err("commit não encontrado".into());
    }
    let stat = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["diff-tree", "--no-commit-id", "--numstat", "-r", &hash])
        .output()
        .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&stat.stdout).lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() >= 3 {
            files.push(serde_json::json!({
                "path": p[2],
                "add": p[0].parse::<i64>().unwrap_or(0),
                "del": p[1].parse::<i64>().unwrap_or(0),
            }));
        }
    }
    let patch = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "--no-color", "--format=", "-p", "--unified=3", &hash])
        .output()
        .map_err(|e| e.to_string())?;
    let diff = String::from_utf8_lossy(&patch.stdout).trim_start().to_string();

    // A qual tarefa o commit pertence: branch agent/<id> que o contém, ou "(agent/<id>)" no assunto.
    let branches = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "--contains", &hash, "--format=%(refname:short)"])
        .output()
        .map_err(|e| e.to_string())?;
    let mut task_id: Option<String> = String::from_utf8_lossy(&branches.stdout)
        .lines()
        .find_map(|b| b.trim().strip_prefix("agent/").map(|s| s.to_string()));
    if task_id.is_none() {
        let subj = f.get(3).unwrap_or(&"");
        if let Some(pos) = subj.find("agent/") {
            let id: String = subj[pos + 6..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !id.is_empty() {
                task_id = Some(id);
            }
        }
    }

    Ok(CommitDetail {
        hash: f[0].to_string(),
        author: f.get(1).unwrap_or(&"").to_string(),
        date: f.get(2).unwrap_or(&"").to_string(),
        subject: f.get(3).unwrap_or(&"").to_string(),
        body: f.get(4).unwrap_or(&"").trim().to_string(),
        files,
        diff,
        task_id,
    })
}

/// Lê apenas o cache do resumo por IA (não gera). Retorna null se ainda não existe.
#[tauri::command(async)]
fn commit_summary_cached(state: State<AppState>, hash: String) -> Result<Option<String>, String> {
    let dbpath = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&dbpath, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS commit_summary(hash TEXT PRIMARY KEY, summary TEXT, created_at INTEGER)",
        [],
    );
    Ok(conn
        .query_row("SELECT summary FROM commit_summary WHERE hash=?1", params![&hash], |r| r.get::<_, String>(0))
        .ok())
}

/// Resumo técnico do commit escrito pela IA (Claude) — explica o quê e o porquê.
/// Cacheado por hash em commit_summary (gera uma vez; depois é instantâneo).
#[tauri::command]
async fn ai_commit_summary(state: State<'_, AppState>, hash: String) -> Result<String, String> {
    let dbpath = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let repo = dbpath
        .parent()
        .and_then(|d| d.parent())
        .map(|r| r.to_path_buf())
        .ok_or("repo inválido")?;

    let conn = Connection::open_with_flags(&dbpath, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    conn.execute(
        "CREATE TABLE IF NOT EXISTS commit_summary(hash TEXT PRIMARY KEY, summary TEXT, created_at INTEGER)",
        [],
    )
    .map_err(|e| e.to_string())?;
    if let Ok(s) = conn.query_row("SELECT summary FROM commit_summary WHERE hash=?1", params![&hash], |r| r.get::<_, String>(0)) {
        return Ok(s);
    }

    let git = |args: &[&str]| {
        Command::new("git").arg("-C").arg(&repo).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    };
    let msg = git(&["show", "-s", "--format=%s%n%b", &hash]).map_err(|e| e.to_string())?.trim().to_string();
    let mut diff = git(&["show", "--no-color", "--format=", "-p", &hash]).map_err(|e| e.to_string())?;
    if diff.len() > 8000 {
        diff.truncate(8000);
        diff.push_str("\n…(diff truncado)");
    }

    // contexto da tarefa (objetivo + entregáveis), quando o commit é de um agente
    let branches = git(&["branch", "--contains", &hash, "--format=%(refname:short)"]).map_err(|e| e.to_string())?;
    let task_id = branches
        .lines()
        .find_map(|b| b.trim().strip_prefix("agent/").map(|s| s.to_string()))
        .or_else(|| {
            msg.find("agent/").map(|p| {
                msg[p + 6..].chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect::<String>()
            }).filter(|x| !x.is_empty())
        });
    let mut ctx = String::new();
    if let Some(tid) = &task_id {
        if let Ok((obj, spec)) = conn.query_row("SELECT objective, spec_json FROM task WHERE id=?1", params![tid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            ctx.push_str(&format!("Objetivo da tarefa: {obj}\n"));
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&spec) {
                if let Some(dels) = v.get("deliverables").and_then(|d| d.as_array()) {
                    let list: Vec<String> = dels.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                    if !list.is_empty() {
                        ctx.push_str(&format!("Entregáveis pedidos: {}\n", list.join("; ")));
                    }
                }
            }
        }
    }

    let prompt = format!(
        "Você é um revisor de código sênior. Em 2 a 4 frases, explique de forma TÉCNICA e direta O QUE foi feito neste commit e POR QUE (a intenção/como se conecta ao objetivo). NÃO liste arquivos nem número de linhas — foque na mudança e no propósito. Responda em português.\n\n{ctx}Mensagem do commit: {msg}\n\nDiff:\n{diff}"
    );
    let claude = claude_bin();
    let mut cmd = claude_cmd(&claude);
    cmd.args(["-p", &prompt]).current_dir(&repo);
    let out = output_timeout(cmd, 60)?;
    if !out.status.success() {
        return Err(format!("claude falhou: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let summary = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if summary.is_empty() {
        return Err("resposta vazia do claude".into());
    }
    let _ = conn.execute("INSERT OR REPLACE INTO commit_summary(hash,summary,created_at) VALUES(?1,?2,?3)", params![&hash, &summary, now_ms()]);
    Ok(summary)
}

/// Commits de uma tarefa (base..branch) — para vincular commits à tarefa.
#[tauri::command(async)]
fn task_commits(state: State<AppState>, task_id: String) -> Result<Vec<serde_json::Value>, String> {
    let dbpath = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let repo = dbpath.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()).ok_or("repo inválido")?;
    let conn = open(&dbpath)?;
    // tarefa fora do state.sqlite do projeto ATIVO (apagada, de outro projeto, só na nuvem): não há
    // commits a listar — vazio, não "Query returned no rows" (era o erro recorrente em app_errors)
    let (branch, base): (String, String) = match conn
        .query_row("SELECT branch, base FROM task WHERE id=?1", params![task_id], |r| Ok((r.get(0)?, r.get(1)?)))
    {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mb = merge_base_ref(&repo, &base, &branch);
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "log",
            &format!("{mb}..{branch}"),
            "--format=%H\u{1f}%s\u{1f}%an\u{1f}%ad",
            "--date=short",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(vec![]); // branch pode ter sido removida (tarefa mergeada)
    }
    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split('\u{1f}').collect();
        if f.len() >= 2 {
            commits.push(serde_json::json!({
                "hash": f[0], "subject": f[1],
                "author": f.get(2).unwrap_or(&""), "date": f.get(3).unwrap_or(&""),
            }));
        }
    }
    Ok(commits)
}

/// Resolve o repo do projeto ativo (parent do .cardume/state.sqlite).
fn active_repo(state: &State<AppState>) -> Result<PathBuf, String> {
    let dbpath = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    dbpath.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()).ok_or_else(|| "repo inválido".to_string())
}

/// Métricas de coordenação (conflitos, colisões, reworks) — baseline do "caos".
/// Mesmo JSON do `cardume metrics --json` (Store.coordinationMetrics no núcleo TS), mas feito AQUI
/// com 3 COUNTs read-only: antes spawnava `node cli.mjs metrics` a cada 20s (e a cada 2s quando
/// falhava), abrindo o Store com migrate() no MESMO sqlite em que os agentes escrevem.
#[tauri::command(async)]
fn coordination_metrics(state: State<AppState>) -> Result<String, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0) };
    let mut by_status = serde_json::Map::new();
    let mut total: i64 = 0;
    if let Ok(mut st) = conn.prepare("SELECT status, COUNT(*) FROM task GROUP BY status") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
            for (k, n) in rows.flatten() {
                total += n;
                by_status.insert(k, serde_json::json!(n));
            }
        }
    }
    let conflict = by_status.get("conflict").and_then(|v| v.as_i64()).unwrap_or(0);
    let m = serde_json::json!({
        "totalTasks": total,
        "byStatus": by_status,
        "conflictTasks": conflict,
        "collisionEvents": count("SELECT COUNT(*) FROM event WHERE type = 'collision'"),
        "reworkCount": count("SELECT COUNT(*) FROM work_queue WHERE kind = 'rework'"),
    });
    Ok(m.to_string())
}

/// Checa sobreposição de escopo de uma demanda nova contra tarefas ativas.
/// `owns` = padrões separados por vírgula (ex.: "src/auth/**,src/api/*.ts").
/// Proxy do CLI `cardume overlap --owns <...> --json`. Retorna JSON de ScopeOverlap[].
#[tauri::command(async)]
fn overlap_check(state: State<AppState>, owns: String) -> Result<String, String> {
    let repo = active_repo(&state)?;
    let out = Command::new(node_bin())
        .args([
            "--disable-warning=ExperimentalWarning".to_string(),
            cli_path(&repo),
            "overlap".to_string(),
            "--owns".to_string(),
            owns,
            "--repo".to_string(),
            repo.display().to_string(),
            "--json".to_string(),
        ])
        .current_dir(&repo)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------- lista de projetos (switcher multi-projeto) ----------
fn projects_file() -> PathBuf {
    let home = home_dir_s();
    PathBuf::from(home).join(".cardume").join("projects.json")
}
fn read_project_list() -> Vec<String> {
    std::fs::read_to_string(projects_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}
fn write_project_list(list: &[String]) {
    let f = projects_file();
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(&f, s);
    }
}
fn active_repo_of(state: &State<AppState>) -> Option<String> {
    state
        .db
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|r| r.display().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    path: String,
    name: String,
    active: bool,
}

#[tauri::command(async)]
fn list_projects(state: State<AppState>) -> Vec<Project> {
    let mut list = read_project_list();
    let active = active_repo_of(&state);
    // garante que o repo ativo (ex.: aberto via CARDUME_REPO no boot) esteja na lista
    if let Some(a) = &active {
        if !list.iter().any(|p| p == a) {
            list.insert(0, a.clone());
            write_project_list(&list);
        }
    }
    list.iter()
        .map(|p| Project {
            name: PathBuf::from(p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone()),
            active: active.as_deref() == Some(p.as_str()),
            path: p.clone(),
        })
        .collect()
}

/// Abre um projeto: valida git, inicializa o workspace do Starfork se preciso,
/// torna-o o projeto ativo e adiciona ao topo da lista.
#[tauri::command(async)]
fn open_project(state: State<AppState>, path: String) -> Result<String, String> {
    open_project_at(&state, &path)
}

/// Cache do "é git?" por pasta (30s): o snapshot perguntava a cada 1s = fork+exec de
/// `git rev-parse` por segundo. git_init_repo limpa; o TTL cobre `git init` feito fora do app.
fn git_cache() -> &'static Mutex<HashMap<String, (bool, std::time::Instant)>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, (bool, std::time::Instant)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn repo_is_git_cached(path: &str) -> bool {
    if let Some((v, at)) = git_cache().lock().unwrap_or_else(|e| e.into_inner()).get(path).copied() {
        if at.elapsed() < std::time::Duration::from_secs(30) {
            return v;
        }
    }
    let v = repo_is_git(path);
    git_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_string(), (v, std::time::Instant::now()));
    v
}

/// E4 (bug #5): o repositório tem remote? Projeto criado só local (gitGate / "Começar") não tem — e o push
/// falhava com "Could not read from remote", que a tela lia como "sem internet". Cache de 30s (o snapshot é 1/s);
/// publish_github limpa.
fn remote_cache() -> &'static Mutex<HashMap<String, (bool, std::time::Instant)>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, (bool, std::time::Instant)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn repo_has_remote(path: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("remote")
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}
fn repo_has_remote_cached(path: &str) -> bool {
    if let Some((v, at)) = remote_cache().lock().unwrap_or_else(|e| e.into_inner()).get(path).copied() {
        if at.elapsed() < std::time::Duration::from_secs(30) {
            return v;
        }
    }
    let v = repo_has_remote(path);
    remote_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_string(), (v, std::time::Instant::now()));
    v
}

/// E4: publica o projeto ATIVO (repositório só local) no GitHub — `gh repo create --source --push`,
/// o mesmo caminho do "novo projeto". O nome do repositório é o da pasta.
#[tauri::command(async)]
fn publish_github(state: State<AppState>, private: bool, owner: String) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let rs = repo.display().to_string();
    if !repo_is_git(&rs) {
        return Err("esta pasta ainda não é um repositório git".into());
    }
    remote_cache().lock().unwrap_or_else(|e| e.into_inner()).remove(&rs);
    if repo_has_remote(&rs) {
        return Ok("o projeto já está no GitHub".into());
    }
    let slug = project_slug(repo.file_name().and_then(|n| n.to_str()).unwrap_or("projeto"));
    let slug = if slug.is_empty() { "projeto".to_string() } else { slug };
    let full = if owner.trim().is_empty() { slug } else { format!("{}/{}", owner.trim(), slug) };
    let mut c = Command::new(gh_bin());
    c.args(["repo", "create", &full, if private { "--private" } else { "--public" }, "--source", &rs, "--remote", "origin", "--push"]);
    c.current_dir(&repo);
    let out = output_timeout(c, 180)?;
    remote_cache().lock().unwrap_or_else(|e| e.into_inner()).remove(&rs);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("gh repo create: {}", if err.is_empty() { "sem detalhe do gh".to_string() } else { err }));
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if url.is_empty() { format!("publicado como {full}") } else { url })
}

/// A pasta é um repositório git? (pasta simples abre, mas sem branch/PR/worktree)
fn repo_is_git(path: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Cria o repositório git numa pasta aberta sem git: `git init -b main`, garante
/// `.cardume/` no .gitignore e faz o 1º commit (com identidade de fallback se o
/// git local não tiver user.name/email). Depois disso tudo funciona como sempre.
#[tauri::command(async)]
fn git_init_repo(state: State<AppState>) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let rs = repo.display().to_string();
    git_cache().lock().unwrap_or_else(|e| e.into_inner()).remove(&rs);
    if repo_is_git(&rs) { return Ok("já é um repositório git".into()); }
    let out = Command::new("git").args(["init", "-q", "-b", "main"]).arg(&repo).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        // git antigo sem -b: init simples + renomeia
        let o2 = Command::new("git").args(["init", "-q"]).arg(&repo).output().map_err(|e| e.to_string())?;
        if !o2.status.success() { return Err(format!("git init falhou: {}", String::from_utf8_lossy(&o2.stderr))); }
        let _ = Command::new("git").arg("-C").arg(&repo).args(["symbolic-ref", "HEAD", "refs/heads/main"]).output();
    }
    // .gitignore com .cardume/ (workspace do app nunca entra no repo)
    let gi = repo.join(".gitignore");
    let cur = std::fs::read_to_string(&gi).unwrap_or_default();
    if !cur.lines().any(|l| l.trim() == ".cardume/" || l.trim() == ".cardume") {
        let prefix = if cur.is_empty() || cur.ends_with('\n') { cur.clone() } else { format!("{cur}\n") };
        std::fs::write(&gi, format!("{prefix}.cardume/\n")).map_err(|e| e.to_string())?;
    }
    let _ = Command::new("git").arg("-C").arg(&repo).args(["add", "-A"]).output();
    // identidade: usa a do git; sem ela, fallback só neste commit (não grava config)
    let has_ident = Command::new("git").arg("-C").arg(&repo).args(["config", "user.email"]).output().map(|o| o.status.success() && !o.stdout.is_empty()).unwrap_or(false);
    let mut c = Command::new("git");
    c.arg("-C").arg(&repo);
    if !has_ident { c.args(["-c", "user.name=Starfork", "-c", "user.email=starfork@local"]); }
    let out = c.args(["commit", "-q", "-m", "chore: início do repositório (Starfork)"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if !err.contains("nothing to commit") { return Err(format!("commit inicial falhou: {err}")); }
    }
    Ok("repositório criado na branch main".into())
}

fn open_project_at(state: &AppState, path: &str) -> Result<String, String> {
    let repo = PathBuf::from(path);
    let is_git = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    // pasta SEM git abre normalmente (só navegar/conversar); as ações que precisam de
    // branch ficam escondidas e o app oferece "criar repositório" (git_init_repo).
    let db = repo.join(".cardume").join("state.sqlite");
    if !db.exists() {
        let mut args: Vec<String> = vec![
            "--disable-warning=ExperimentalWarning".into(),
            cli_path(&repo),
            "init".into(),
            "--repo".into(),
            repo.display().to_string(),
        ];
        if !is_git { args.push("--no-git".into()); } // por último: o parser do CLI consome o próximo arg como valor
        let out = Command::new(node_bin())
            .args(&args)
            .current_dir(&repo)
            .output()
            .map_err(|e| format!("falha ao inicializar o workspace: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "cardume init falhou: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    if !db.exists() {
        return Err("workspace do Starfork não pôde ser criado".to_string());
    }
    ensure_app_schema(&db);
    *state.db.lock().unwrap_or_else(|e| e.into_inner()) = Some(db);
    let mut list = read_project_list();
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    write_project_list(&list);
    Ok(path.to_string())
}

/// Cria um projeto DO ZERO: pasta nova dentro de `parent`, `git init` na main,
/// README + .gitignore + 1º commit e, se pedido, o repositório no GitHub via
/// `gh repo create` (na conta ativa do gh — trocável em Configurações → GitHub).
#[tauri::command(async)]
fn create_project(
    state: State<AppState>,
    parent: String,
    name: String,
    github: bool,
    private: bool,
    owner: String,
) -> Result<String, String> {
    create_project_in(&state, parent, name, github, private, owner)
}

/// Pasta padrão dos projetos criados pelo "Começar" da tela vazia: ~/Documents/Starfork
fn starfork_projects_dir() -> PathBuf {
    PathBuf::from(home_dir_s()).join("Documents").join("Starfork")
}

/// Nome livre dentro de `parent`: `slug`, senão `slug-2`, `slug-3`…
fn unique_child(parent: &std::path::Path, slug: &str) -> String {
    if !parent.join(slug).exists() { return slug.to_string(); }
    let mut n = 2;
    loop {
        let c = format!("{slug}-{n}");
        if !parent.join(&c).exists() { return c; }
        n += 1;
    }
}

/// letra acentuada → letra base (sem crate de Unicode: cobre o português e o espanhol)
fn fold_accent(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        _ => c,
    }
}

fn project_slug(name: &str) -> String {
    let raw: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(fold_accent)
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' })
        .collect();
    // sem "--" repetido nem hífen nas pontas
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c == '-' && out.ends_with('-') { continue; }
        out.push(c);
    }
    out.trim_matches('-').to_string()
}

/// git instalado e funcionando? (no Mac sem as ferramentas de linha de comando, o /usr/bin/git existe mas falha)
fn git_available() -> bool {
    Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}
const GIT_MISSING_MSG: &str = "O git não está instalado neste computador (o Starfork usa o git por baixo pra guardar cada versão do seu trabalho).\n\nNo Mac: abra o app Terminal, cole  xcode-select --install  e aperte Enter; aceite a instalação. No Windows/Linux: instale pelo site git-scm.com.\n\nDepois clique em Começar de novo.";

/// Onde o "Começar" vai criar a pasta (sem criar nada): ~/Documents/Starfork/<nome livre>
#[tauri::command(async)]
fn quick_project_target(name: String) -> Result<String, String> {
    let slug = project_slug(&name);
    if slug.is_empty() { return Err("dê um nome ao projeto".into()); }
    let dir = starfork_projects_dir();
    Ok(dir.join(unique_child(&dir, &slug)).display().to_string())
}

/// "Começar sem portões": cria ~/Documents/Starfork/<nome> (com sufixo -2… se já existir),
/// git init + 1º commit, SEM GitHub e sem gh — e abre como projeto ativo.
#[tauri::command(async)]
fn quick_create_project(state: State<AppState>, name: String) -> Result<String, String> {
    if !git_available() { return Err(GIT_MISSING_MSG.into()); }
    let slug = project_slug(&name);
    if slug.is_empty() { return Err("dê um nome ao projeto".into()); }
    let dir = starfork_projects_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("não consegui criar a pasta {}: {e}", dir.display()))?;
    let free = unique_child(&dir, &slug);
    create_project_in(&state, dir.display().to_string(), free, false, true, String::new())
}

fn create_project_in(
    state: &AppState,
    parent: String,
    name: String,
    github: bool,
    private: bool,
    owner: String,
) -> Result<String, String> {
    // BUG-22: acentos viram a letra base ("Painel Finanças" → painel-financas, não painel-finan-as)
    let slug = project_slug(&name);
    if slug.is_empty() {
        return Err("dê um nome ao projeto".into());
    }
    let parent_p = PathBuf::from(&parent);
    if !parent_p.is_dir() {
        return Err(format!("pasta não existe: {parent}"));
    }
    let repo = parent_p.join(&slug);
    let run = |args: &[&str]| -> Result<String, String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .map_err(|e| format!("git: {e}"))?;
        if !out.status.success() {
            return Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };
    // BUG-10: a pasta já existe? Se é um repositório git (ex.: tentativa anterior em que só o GitHub falhou),
    // REAPROVEITA em vez de travar em "já existe"; pasta com outras coisas e sem git continua recusada.
    let reuse = repo.exists() && repo_is_git(&repo.display().to_string());
    if repo.exists() && !reuse {
        let empty = std::fs::read_dir(&repo).map(|mut d| d.next().is_none()).unwrap_or(false);
        if !empty {
            return Err(format!("já existe uma pasta {} em {} (e ela não é um projeto git). Escolha outro nome ou use \"abrir existente…\".", slug, parent));
        }
    }
    if !reuse {
        std::fs::create_dir_all(&repo).map_err(|e| format!("não consegui criar a pasta: {e}"))?;
        run(&["init", "-b", "main"])?;
        std::fs::write(repo.join("README.md"), format!("# {}\n\nProjeto criado pelo Starfork.\n", name.trim()))
            .map_err(|e| e.to_string())?;
        std::fs::write(repo.join(".gitignore"), ".DS_Store\nnode_modules/\n.env\n.cardume/\n").map_err(|e| e.to_string())?;
        run(&["add", "-A"])?;
        // BUG-22: autor do 1º commit = a identidade do git do usuário; o "Starfork <starfork@local>" só quando não há nenhuma
        let has_ident = run(&["config", "user.email"]).map(|o| !o.trim().is_empty()).unwrap_or(false);
        if has_ident {
            run(&["commit", "-q", "-m", "chore: projeto criado pelo Starfork"])?;
        } else {
            run(&["-c", "user.name=Starfork", "-c", "user.email=starfork@local", "commit", "-q", "-m", "chore: projeto criado pelo Starfork"])?;
        }
    }
    let has_origin = run(&["remote", "get-url", "origin"]).is_ok();
    if github && !has_origin {
        let full = if owner.trim().is_empty() { slug.clone() } else { format!("{}/{}", owner.trim(), slug) };
        let mut c = Command::new(gh_bin());
        c.args(["repo", "create", &full, if private { "--private" } else { "--public" }, "--source", &repo.display().to_string(), "--remote", "origin", "--push"]);
        c.current_dir(&repo);
        let fail = match output_timeout(c, 120) {
            Ok(out) if out.status.success() => None,
            Ok(out) => Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
            Err(e) => Some(e),
        };
        if let Some(err) = fail {
            // prefixo GH_FAIL::<pasta>:: → a tela oferece "abrir mesmo assim sem GitHub" (a pasta e o git já existem)
            return Err(format!(
                "GH_FAIL::{}::A pasta e o git foram criados em {}, mas o GitHub recusou criar o repositório.\n\nMotivo: {}\n\nConfira a conta do GitHub em Configurações → GitHub e tente de novo (a pasta é reaproveitada), ou abra o projeto agora só no seu computador.",
                repo.display(),
                repo.display(),
                if err.is_empty() { "sem detalhe do gh".to_string() } else { err }
            ));
        }
    }
    open_project_at(state, &repo.display().to_string())
}

// ---------- contas do GitHub (gh auth) ----------
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GhAccount {
    user: String,
    active: bool,
    protocol: String,
}

/// Contas logadas no `gh` (pode haver várias; a ATIVA é a que abre PR e faz push).
#[tauri::command(async)]
fn gh_accounts() -> Result<Vec<GhAccount>, String> {
    let mut c = Command::new(gh_bin());
    c.args(["auth", "status"]);
    let out = output_timeout(c, 10)?;
    let text = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    let mut list: Vec<GhAccount> = vec![];
    for line in text.lines() {
        let l = line.trim();
        if let Some(i) = l.find(" account ") {
            if l.contains("Logged in to") {
                let rest = &l[i + 9..];
                let user = rest.split_whitespace().next().unwrap_or("").to_string();
                if !user.is_empty() {
                    list.push(GhAccount { user, active: false, protocol: "https".into() });
                }
            }
        } else if l.starts_with("- Active account:") {
            if let Some(last) = list.last_mut() { last.active = l.ends_with("true"); }
        } else if l.starts_with("- Git operations protocol:") {
            if let Some(last) = list.last_mut() { last.protocol = l.rsplit(' ').next().unwrap_or("https").to_string(); }
        }
    }
    if list.is_empty() && !out.status.success() {
        return Err("gh sem login — adicione uma conta".into());
    }
    Ok(list)
}

/// Torna outra conta a ativa (PRs e push passam a usar ela — git via credencial do gh).
#[tauri::command(async)]
fn gh_switch_account(user: String) -> Result<String, String> {
    let mut c = Command::new(gh_bin());
    c.args(["auth", "switch", "-h", "github.com", "-u", &user]);
    let out = output_timeout(c, 15)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut g = Command::new(gh_bin());
    g.args(["auth", "setup-git", "-h", "github.com"]);
    let _ = output_timeout(g, 15);
    Ok(user)
}

struct GhLogin {
    log: String,
    done: bool,
    ok: bool,
}
static GH_LOGIN: Mutex<Option<GhLogin>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhLoginStart { code: String, url: String }

/// Começa `gh auth login` por navegador: devolve o código de uso único e a URL
/// (github.com/login/device). O processo segue em background até o usuário
/// autorizar; `gh_login_status` acompanha. Nenhum token passa pelo app.
#[tauri::command(async)]
fn gh_login_start() -> Result<GhLoginStart, String> {
    *GH_LOGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(GhLogin { log: String::new(), done: false, ok: false });
    let mut child = Command::new(gh_bin())
        .args(["auth", "login", "-h", "github.com", "-p", "https", "-w", "--skip-ssh-key"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        use std::io::Write;
        let _ = si.write_all(b"\n\n");
    }
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    fn pump<R: std::io::Read + Send + 'static>(r: Option<R>) {
        if let Some(mut r) = r {
            std::thread::spawn(move || {
                let mut buf = [0u8; 512];
                loop {
                    match r.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let s = String::from_utf8_lossy(&buf[..n]).to_string();
                            if let Some(g) = GH_LOGIN.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { g.log.push_str(&s); }
                        }
                    }
                }
            });
        }
    }
    pump(stderr);
    pump(stdout);
    std::thread::spawn(move || {
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        if let Some(g) = GH_LOGIN.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { g.done = true; g.ok = ok; }
        if ok {
            let mut g = Command::new(gh_bin());
            g.args(["auth", "setup-git", "-h", "github.com"]);
            let _ = output_timeout(g, 15);
        }
    });
    // espera o código aparecer (XXXX-XXXX)
    for _ in 0..80 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let (log, done) = {
            let g = GH_LOGIN.lock().unwrap_or_else(|e| e.into_inner());
            g.as_ref().map(|x| (x.log.clone(), x.done)).unwrap_or_default()
        };
        if let Some(code) = log.split(|c: char| c.is_whitespace()).find(|t| t.len() == 9 && t.as_bytes()[4] == b'-' && t.chars().filter(|c| *c != '-').all(|c| c.is_ascii_alphanumeric() && !c.is_ascii_lowercase())) {
            return Ok(GhLoginStart { code: code.to_string(), url: "https://github.com/login/device".into() });
        }
        if done {
            return Err(format!("gh encerrou antes de gerar o código:\n{}", log.trim()));
        }
    }
    Err("gh não respondeu com o código (rede?)".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhLoginStatus { done: bool, ok: bool, log: String }

#[tauri::command(async)]
fn gh_login_status() -> GhLoginStatus {
    let g = GH_LOGIN.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(x) => GhLoginStatus { done: x.done, ok: x.ok, log: x.log.clone() },
        None => GhLoginStatus { done: true, ok: false, log: String::new() },
    }
}

/// Donos possíveis pro repositório novo: o usuário ativo + organizações dele.
#[tauri::command(async)]
fn gh_owners() -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut c = Command::new(gh_bin());
    c.args(["api", "user", "--jq", ".login"]);
    if let Ok(o) = output_timeout(c, 15) {
        let u = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !u.is_empty() { out.push(u); }
    }
    let mut c2 = Command::new(gh_bin());
    c2.args(["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    if let Ok(o) = output_timeout(c2, 20) {
        for l in String::from_utf8_lossy(&o.stdout).lines() {
            let l = l.trim();
            if !l.is_empty() && !out.contains(&l.to_string()) { out.push(l.to_string()); }
        }
    }
    out
}

/// Troca o projeto ativo para um já existente na lista.
#[tauri::command(async)]
fn switch_project(state: State<AppState>, path: String) -> Result<String, String> {
    let db = PathBuf::from(&path).join(".cardume").join("state.sqlite");
    if !db.exists() {
        return Err(format!("sem workspace do Starfork em {path}"));
    }
    ensure_app_schema(&db);
    *state.db.lock().unwrap_or_else(|e| e.into_inner()) = Some(db);
    // move pro topo: o topo da lista é o "último projeto ativo" restaurado no boot
    let mut list = read_project_list();
    list.retain(|p| p != &path);
    list.insert(0, path.clone());
    write_project_list(&list);
    Ok(path)
}

/// Remove um projeto da lista (não apaga nada do repo em disco).
#[tauri::command(async)]
fn remove_project(state: State<AppState>, path: String) -> Vec<String> {
    let mut list = read_project_list();
    list.retain(|p| p != &path);
    write_project_list(&list);
    // BUG-20: tirar o projeto ATIVO da lista também o fecha — vai pro próximo da lista (ou pro estado vazio).
    // Antes ele seguia aberto e o list_projects o devolvia pra lista no refresh seguinte.
    if active_repo_of(&state).as_deref() == Some(path.as_str()) {
        let next = list.iter().map(|p| PathBuf::from(p).join(".cardume").join("state.sqlite")).find(|db| db.exists());
        if let Some(db) = &next { ensure_app_schema(db); }
        *state.db.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }
    list
}

/// Abre a pasta de um projeto DA LISTA no Finder/Explorer (o open_url só aceita http/https — BUG-15).
#[tauri::command(async)]
fn reveal_project(path: String) -> Result<(), String> {
    // só pastas que já são projetos conhecidos: o webview não pode mandar abrir um caminho qualquer
    if !read_project_list().iter().any(|p| p == &path) {
        return Err("esse projeto não está na lista".into());
    }
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("a pasta não existe mais: {path}"));
    }
    os_open(dir.as_os_str()).map_err(|e| format!("não consegui abrir a pasta: {e}"))?;
    Ok(())
}

// ---------- artefatos da tarefa (docs/provas produzidos pelo agente) ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    name: String,
    kind: String, // "doc" | "image" | "file"
    size: u64,
    /// mtime em ms — pra ordenar por data de criação na UI.
    created: i64,
}

fn artifact_kind(name: &str) -> &'static str {
    let l = name.to_lowercase();
    if l.ends_with(".md") || l.ends_with(".markdown") || l.ends_with(".txt") {
        "doc"
    } else if l.ends_with(".png") || l.ends_with(".jpg") || l.ends_with(".jpeg") || l.ends_with(".gif") || l.ends_with(".webp") || l.ends_with(".svg") {
        "image"
    } else if l.ends_with(".pdf") {
        "pdf"
    } else {
        "file"
    }
}

/// Nome de artefato válido: caminho RELATIVO dentro de .cardume/artifacts/
/// (pode ter subpasta — o agente costuma salvar em `entregaveis/x.pdf` ou
/// `<task-id>/x.pdf`), sem `..`, sem barra invertida e sem começar por `/`.
fn artifact_name_ok(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && !n.contains('\\')
        && !n.starts_with('/')
        && n.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Varre `.cardume/artifacts` RECURSIVAMENTE (até 4 níveis). O nome do artefato
/// é o caminho relativo (`entregaveis/relatorio.pdf`). Uma subpasta com o
/// próprio id da tarefa (`<task-id>/x.pdf`, erro comum do agente — e é assim
/// que o coletor copia pro repo) é achatada pra `x.pdf`, igual ao que já era
/// listado antes. Era aqui que o PDF "não ia pra aba Entregas": a varredura
/// só olhava o primeiro nível.
fn scan_artifacts_dir(dir: &std::path::Path, task_id: &str, out: &mut Vec<Artifact>, seen: &mut std::collections::HashSet<String>) {
    fn walk(dir: &std::path::Path, prefix: &str, depth: u8, task_id: &str, out: &mut Vec<Artifact>, seen: &mut std::collections::HashSet<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let fname = e.file_name().to_string_lossy().to_string();
            if fname.starts_with('.') { continue; }
            if p.is_dir() {
                if depth >= 4 { continue; }
                // subpasta com o id da tarefa → achata (mesmos nomes de antes)
                let np = if prefix.is_empty() && fname == task_id { String::new() } else { format!("{prefix}{fname}/") };
                walk(&p, &np, depth + 1, task_id, out, seen);
            } else if p.is_file() {
                let name = format!("{prefix}{fname}");
                if !seen.insert(name.clone()) { continue; } // já visto (worktree tem prioridade)
                let meta = e.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let created = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                out.push(Artifact { kind: artifact_kind(&name).to_string(), name, size, created });
            }
        }
    }
    walk(dir, "", 0, task_id, out, seen);
}

#[tauri::command(async)]
fn list_artifacts(state: State<AppState>, task_id: String) -> Result<Vec<Artifact>, String> {
    let repo = repo_of(&state)?;
    let mut out: Vec<Artifact> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 1) AO VIVO na worktree (aparece antes de a tarefa fechar o turno)
    // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
    let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(db) = db_path_now {
        if let Ok(conn) = open(&db) {
            if let Ok(wt) = conn.query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get::<_, String>(0)) {
                if !wt.is_empty() {
                    scan_artifacts_dir(&PathBuf::from(&wt).join(".cardume").join("artifacts"), &task_id, &mut out, &mut seen);
                }
            }
        }
    }
    // 2) coletados no repo principal (persistem após merge/remoção da worktree)
    scan_artifacts_dir(&repo.join(".cardume").join("artifacts").join(&task_id), &task_id, &mut out, &mut seen);
    // mais recentes primeiro (data de criação/modificação)
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactContent {
    kind: String,
    text: Option<String>,
    data_url: Option<String>,
}

#[tauri::command(async)]
fn read_artifact(state: State<AppState>, task_id: String, name: String) -> Result<ArtifactContent, String> {
    // evidência que é arquivo do PRÓPRIO repo (ex.: "tests/login.test.ts"): só LEITURA, da worktree
    let path = match artifact_path(&state, &task_id, &name) {
        Ok(p) => p,
        Err(e) => {
            let rel = name.trim().trim_start_matches("./");
            match task_worktree(&state, &task_id) {
                Ok(wt) if artifact_name_ok(rel) && wt.join(rel).is_file() => wt.join(rel),
                _ => return Err(e),
            }
        }
    };
    let kind = artifact_kind(&name);
    if kind == "image" {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let l = name.to_lowercase();
        let mime = if l.ends_with(".png") {
            "image/png"
        } else if l.ends_with(".jpg") || l.ends_with(".jpeg") {
            "image/jpeg"
        } else if l.ends_with(".gif") {
            "image/gif"
        } else if l.ends_with(".webp") {
            "image/webp"
        } else if l.ends_with(".svg") {
            "image/svg+xml"
        } else {
            "application/octet-stream"
        };
        Ok(ArtifactContent {
            kind: "image".to_string(),
            text: None,
            data_url: Some(format!("data:{};base64,{}", mime, base64_encode(&bytes))),
        })
    } else if kind == "pdf" {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(ArtifactContent {
            kind: "pdf".to_string(),
            text: None,
            data_url: Some(format!("data:application/pdf;base64,{}", base64_encode(&bytes))),
        })
    } else {
        // doc/txt são texto; binário desconhecido cai pra data_url (não estoura)
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(ArtifactContent { kind: if kind == "doc" { "doc".into() } else { "file".into() }, text: Some(text), data_url: None }),
            Err(_) => {
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                Ok(ArtifactContent { kind: "file".into(), text: None, data_url: Some(format!("data:application/octet-stream;base64,{}", base64_encode(&bytes))) })
            }
        }
    }
}

/// base64 padrão (sem depender de crate externa).
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// "Carimbo" barato do estado: caminho do DB + (mtime, tamanho) do state.sqlite e do -wal.
/// Qualquer escrita do motor muda o -wal (ou o arquivo principal no checkpoint). O poll de 1s
/// do front (33-switcher) só pede o snapshot inteiro (~0,5 MB de JSON) quando o carimbo muda
/// (ou a cada poucos segundos, pelo que não mora no DB: pid vivo, cache multi-projeto).
#[tauri::command(async)]
fn snapshot_stamp(state: State<AppState>) -> String {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(p) = path else { return "none".into() };
    let st = |f: &std::path::Path| -> String {
        std::fs::metadata(f)
            .map(|m| {
                let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                format!("{t}:{}", m.len())
            })
            .unwrap_or_else(|_| "-".into())
    };
    let mut wal = p.clone().into_os_string();
    wal.push("-wal");
    format!("{}|{}|{}", p.display(), st(&p), st(std::path::Path::new(&wal)))
}

#[tauri::command(async)]
fn snapshot(state: State<AppState>) -> Result<Snapshot, String> {
    let __t0 = std::time::Instant::now();
    let r = snapshot_inner(state);
    let ms = __t0.elapsed().as_millis();
    if ms > 1000 { web_log(format!("[rust] snapshot interno {ms}ms")); }
    r
}
fn snapshot_inner(state: State<AppState>) -> Result<Snapshot, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    snapshot_or_cached(path)
}
/// Último snapshot BOM por banco. Com o state.sqlite travado (checkpoint/recuperação do WAL depois de
/// um processo morto, CLI fechando…), o snapshot esperava o busy_timeout inteiro (8s) = o mesmo prazo
/// do front → "snapshot demorou >8s" e a tela parava justo depois de enviar mensagem. Agora a leitura
/// desiste em SNAP_BUSY_MS e devolve o último estado bom (até 60s de idade); o próximo poll pega o novo.
const SNAP_BUSY_MS: u64 = 2500;
fn snap_cache() -> &'static Mutex<HashMap<PathBuf, (std::time::Instant, Snapshot)>> {
    static C: std::sync::OnceLock<Mutex<HashMap<PathBuf, (std::time::Instant, Snapshot)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn snapshot_or_cached(path: Option<PathBuf>) -> Result<Snapshot, String> {
    let Some(p) = path.clone() else { return snapshot_at(None) };
    match snapshot_at(path) {
        Ok(s) => {
            snap_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(p, (std::time::Instant::now(), s.clone()));
            Ok(s)
        }
        Err(e) => {
            let hit = snap_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&p)
                .filter(|(at, _)| at.elapsed() < std::time::Duration::from_secs(60))
                .map(|(_, s)| s.clone());
            match hit {
                Some(s) => {
                    web_log(format!("[rust] snapshot ocupado ({e}) — devolvi o último estado bom"));
                    Ok(s)
                }
                None => Err(e),
            }
        }
    }
}
/// O snapshot a partir do caminho do state.sqlite (sem State — dá pra medir/testar direto num banco).
fn snapshot_at(path: Option<PathBuf>) -> Result<Snapshot, String> {
    let path = match path {
        Some(p) => p,
        None => {
            return Ok(Snapshot {
                repo: None,
                git: true,
                remote: true,
                tasks: vec![],
                events: vec![],
                claims: vec![],
                diffs: vec![],
                reviews: vec![],
                pending: vec![],
                costs: vec![],
            })
        }
    };
    let conn = open(&path)?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(SNAP_BUSY_MS));

    // busy_pid pode não existir em DB de motor antigo (migração é do motor; aqui é read-only).
    // Coluna não some: "tem" fica em cache pra sempre por DB; "não tem" é reconferido a cada 30s.
    let has_busy: bool = {
        static HB: std::sync::OnceLock<Mutex<HashMap<PathBuf, (bool, std::time::Instant)>>> = std::sync::OnceLock::new();
        let hb = HB.get_or_init(|| Mutex::new(HashMap::new()));
        let hit = hb.lock().unwrap_or_else(|e| e.into_inner()).get(&path).copied();
        match hit {
            Some((true, _)) => true,
            Some((false, at)) if at.elapsed() < std::time::Duration::from_secs(30) => false,
            _ => {
                let v = conn
                    .query_row("SELECT COUNT(*) FROM pragma_table_info('task') WHERE name='busy_pid'", [], |r| r.get::<_, i64>(0))
                    .map(|n| n > 0)
                    .unwrap_or(false);
                hb.lock().unwrap_or_else(|e| e.into_inner()).insert(path.clone(), (v, std::time::Instant::now()));
                v
            }
        }
    };
    let tasks = conn
        .prepare(&format!(
            "SELECT id,title,objective,status,agent,stage,roles_json,branch,worktree,base,engine,model,created_at,spec_json,sort_order,flag,{} \
             FROM task ORDER BY created_at",
            if has_busy { "busy_pid" } else { "NULL" }
        ))
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            let roles_json: String = r.get(6)?;
            let spec_json: String = r.get(13)?;
            let spec: serde_json::Value = serde_json::from_str(&spec_json).unwrap_or_default();
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                objective: r.get(2)?,
                status: r.get(3)?,
                agent: r.get(4)?,
                stage: r.get(5)?,
                roles: serde_json::from_str(&roles_json).unwrap_or(serde_json::Value::Array(vec![])),
                branch: r.get(7)?,
                worktree: r.get(8)?,
                base: r.get(9)?,
                engine: r.get(10)?,
                model: r.get(11)?,
                created_at: r.get(12)?,
                sort_order: r.get(14)?,
                deliverables: spec.get("deliverables").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                requirements: spec.get("requirements").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                refs: spec.get("refs").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                kind: spec.get("kind").and_then(|v| v.as_str()).unwrap_or("build").to_string(),
                pr_url: spec.get("prUrl").and_then(|v| v.as_str()).map(|s| s.to_string()),
                issue_url: spec.get("issueUrl").and_then(|v| v.as_str()).map(|s| s.to_string()),
                flag: r.get::<_, Option<String>>(15).unwrap_or(None),
                auto_pr: spec.get("autoPr").and_then(|v| v.as_str()).map(|s| s.to_string()),
                linked_to: spec.get("linkedTo").and_then(|v| v.as_str()).map(|s| s.to_string()),
                orchestration: spec.get("orchestration").filter(|v| v.is_object()).cloned(),
                epic: {
                    let mut m = serde_json::Map::new();
                    for k in ["epicId", "verify", "covers", "after", "wave", "risk", "hitl", "boundaries", "epicDoneWhen", "epicChecks"] {
                        if let Some(v) = spec.get(k).filter(|v| !v.is_null()) { m.insert(k.to_string(), v.clone()); }
                    }
                    if m.is_empty() { None } else { Some(serde_json::Value::Object(m)) }
                },
                depends_on: spec.get("dependsOn").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(),
                spec: task_budget_spec(&spec),
                busy: r
                    .get::<_, Option<i64>>(16)
                    .unwrap_or(None)
                    .map(|pid| pid_alive(pid as i32))
                    .unwrap_or(false),
                queued: 0,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;
    // fila do motor por tarefa (índice wq_task). Banco antigo sem work_queue: fica 0.
    let mut tasks = tasks;
    if let Ok(mut st) = conn.prepare("SELECT task_id, COUNT(*) FROM work_queue WHERE status='queued' GROUP BY task_id") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
            let q: HashMap<String, i64> = rows.filter_map(|x| x.ok()).collect();
            for t in tasks.iter_mut() {
                if let Some(n) = q.get(&t.id) { t.queued = *n; }
            }
        }
    }

    // Limita o payload: só os eventos mais recentes (evita serializar todo o
    // histórico a cada poll). 1200 cobre o uso real (com textos agora longos) e limita o
    // crescimento ilimitado do snapshot.
    let events = conn
        .prepare("SELECT id,task_id,agent,ts,\"type\",substr(text,1,500) AS text,ok FROM (SELECT id,task_id,agent,ts,\"type\",text,ok FROM event ORDER BY id DESC LIMIT 1200) ORDER BY id")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Event {
                id: r.get(0)?,
                task_id: r.get(1)?,
                agent: r.get(2)?,
                ts: r.get(3)?,
                kind: r.get(4)?,
                text: r.get(5)?,
                ok: r.get(6)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    let claims = conn
        .prepare("SELECT id,task_id,agent,path,mode,yielded_to FROM claim ORDER BY created_at")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Claim {
                id: r.get(0)?,
                task_id: r.get(1)?,
                agent: r.get(2)?,
                path: r.get(3)?,
                mode: r.get(4)?,
                yielded_to: r.get(5)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    let diffs = conn
        .prepare("SELECT task_id,files,additions,deletions FROM diffstat")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Diff {
                task_id: r.get(0)?,
                files: r.get(1)?,
                additions: r.get(2)?,
                deletions: r.get(3)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    // SÓ o que a tela usa (summary + como testar, cortados). functions_json/files_json chegam a 700 KB por
    // revisão (4.851 funções numa só) e a tela nunca lê — iam INTEIROS a cada 1s: ~3,5 MB de JSON por poll no
    // logcomex-ai-v2, a página parseando isso sem parar = app travando e snapshot > 8s.
    let reviews = conn
        .prepare("SELECT task_id,substr(summary,1,2000),substr(how_to_test,1,4000),by_agent FROM review")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Review {
                task_id: r.get(0)?,
                summary: r.get(1)?,
                functions: serde_json::Value::Array(vec![]),
                files: serde_json::Value::Array(vec![]),
                how_to_test: r.get(2)?,
                by_agent: r.get(3)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    let pending = conn
        .prepare("SELECT id,task_id,agent,kind,prompt,options,created_at FROM pending WHERE status='open' ORDER BY id")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            let opt: Option<String> = r.get(5)?;
            Ok(Pending {
                id: r.get(0)?,
                task_id: r.get(1)?,
                agent: r.get(2)?,
                kind: r.get(3)?,
                prompt: r.get(4)?,
                options: opt
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(serde_json::Value::Null),
                created_at: r.get(6)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    let costs = conn
        .prepare("SELECT task_id, agent, role, SUM(usd), SUM(in_tok), SUM(out_tok) FROM cost GROUP BY task_id, agent, role")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Cost {
                task_id: r.get(0)?,
                agent: r.get(1)?,
                role: r.get(2)?,
                usd: r.get(3)?,
                in_tok: r.get(4)?,
                out_tok: r.get(5)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    let repo = path
        .parent()
        .and_then(|d| d.parent())
        .map(|r| r.display().to_string());

    let git = repo.as_deref().map(repo_is_git_cached).unwrap_or(true);
    let remote = git && repo.as_deref().map(repo_has_remote_cached).unwrap_or(true);
    Ok(Snapshot { repo, git, remote, tasks, events, claims, diffs, reviews, pending, costs })
}

/// Grava a resposta do humano a uma pergunta pendente (write-path do app).
#[tauri::command(async)]
fn resolve_pending(state: State<AppState>, id: i64, answer: String) -> Result<(), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    conn.execute(
        "UPDATE pending SET status='answered', answer=?1, resolved_at=?2 WHERE id=?3",
        params![answer, now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pede um AJUSTE (rework) sobre um commit/etapa de uma tarefa já concluída:
/// enfileira o feedback e dispara `cardume rework <taskId>` (aplica via --resume).
#[tauri::command(async)]
fn rework_task(state: State<AppState>, task_id: String, text: String) -> Result<(), String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("feedback vazio".to_string());
    }
    // enfileira o feedback como instrução (reutiliza o mesmo mecanismo)
    add_instruction(state.clone(), task_id.clone(), text.clone())?;
    let repo = repo_of(&state)?;
    let mut cmd = Command::new(node_bin());
    cmd.args([
        "--disable-warning=ExperimentalWarning",
        &cli_path(&repo),
        "rework",
        &task_id,
        "--repo",
        &repo.display().to_string(),
    ])
    .current_dir(&repo);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&state, &task_id, cmd)?;
    Ok(())
}

/// Re-roda a tarefa do ZERO: mata o processo se estiver rodando, reseta a
/// worktree pro estado da base (descarta o trabalho parcial, preserva .cardume),
/// limpa os registros (eventos/claims/review/pendências/custo/diff) e re-executa
/// o time inteiro. Usado quando uma execução deu ruim (ex.: timeout sem implementar).
#[tauri::command(async)]
fn rerun_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let repo = repo_of(&state)?;
    // 1) encerra o processo atual, se houver
    if let Some(p) = live_task_pid(&state, &task_id) {
        signal_group(p, procsig::CONT);
        signal_group(p, procsig::TERM);
        // espera morrer (o motor novo recusa rodar com o lock busy_pid de um processo vivo)
        for _ in 0..20 { if !pid_alive(p) { break; } std::thread::sleep(std::time::Duration::from_millis(100)); }
        if pid_alive(p) { signal_group(p, procsig::KILL); std::thread::sleep(std::time::Duration::from_millis(200)); }
        if let Ok(mut m) = state.procs.lock() { m.remove(&task_id); }
    }
    // 2) worktree + base
    let (wt, base) = task_wt_base(&state, &task_id)?;
    // 3) reseta a worktree pro estado da base (clean -fd NÃO remove ignorados → .cardume fica)
    let _ = Command::new("git").arg("-C").arg(&wt).args(["reset", "--hard", &base]).output();
    let _ = Command::new("git").arg("-C").arg(&wt).args(["clean", "-fd"]).output();
    // 4) reseta os registros da tarefa (fresh run, preserva a task e o spec)
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    let _ = conn.execute("UPDATE task SET done_roles=0, status='queued', session_id=NULL, busy_pid=NULL WHERE id=?1", params![task_id]);
    for tbl in ["event", "claim", "review", "pending", "cost", "diffstat"] {
        let _ = conn.execute(&format!("DELETE FROM {tbl} WHERE task_id=?1"), params![task_id]);
    }
    // 5) re-executa o time
    let mut cmd = Command::new(node_bin());
    cmd.args([
        "--disable-warning=ExperimentalWarning",
        &cli_path(&repo),
        "start",
        &task_id,
        "--repo",
        &repo.display().to_string(),
    ])
    .current_dir(&repo);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&state, &task_id, cmd)?;
    Ok(())
}

/// Pede um ENTREGÁVEL sob demanda numa tarefa já pronta: doc de arquitetura,
/// testes comprovando, ou prova (prints). Roda um agente que lê o código e
/// produz o artefato — sem reimplementar. kind: "doc" | "tests" | "proof".
#[tauri::command(async)]
fn deliver_artifact(state: State<AppState>, task_id: String, kind: String) -> Result<(), String> {
    let repo = repo_of(&state)?;
    let k = if kind == "tests" || kind == "proof" || kind == "all" { kind } else { "doc".to_string() };
    let mut cmd = Command::new(node_bin());
    cmd.args([
        "--disable-warning=ExperimentalWarning",
        &cli_path(&repo),
        "deliver",
        &task_id,
        "--kind",
        &k,
        "--repo",
        &repo.display().to_string(),
    ])
    .current_dir(&repo);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&state, &task_id, cmd)?;
    Ok(())
}

/// Conversa com o agente numa tarefa pronta: retoma a sessão (--resume) por um
/// turno pra corrigir/entregar o que faltou (ex.: "teste na UI real e me dê os prints").
#[tauri::command(async)]
fn talk_task(state: State<AppState>, task_id: String, message: String, as_req: Option<bool>, agent: Option<String>) -> Result<(), String> {
    let repo = repo_of(&state)?;
    let m = message.trim().to_string();
    if m.is_empty() {
        return Err("mensagem vazia".to_string());
    }
    let mut cmd = Command::new(node_bin());
    cmd.args([
        "--disable-warning=ExperimentalWarning",
        &cli_path(&repo),
        "talk",
        &task_id,
        "--msg",
        &m,
        "--repo",
        &repo.display().to_string(),
    ]);
    if as_req.unwrap_or(false) {
        cmd.arg("--as-req");
    }
    if let Some(a) = agent {
        if !a.is_empty() {
            cmd.arg("--agent");
            cmd.arg(&a);
        }
    }
    cmd.current_dir(&repo);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&state, &task_id, cmd)?;
    Ok(())
}

/// Enfileira uma instrução do humano no meio da execução — o orquestrador a
/// aplica (via --resume) ao fim do turno atual do agente.
#[tauri::command(async)]
fn add_instruction(state: State<AppState>, task_id: String, text: String) -> Result<(), String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("instrução vazia".to_string());
    }
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    conn.execute(
        "CREATE TABLE IF NOT EXISTS instruction (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, applied_at INTEGER)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO instruction (task_id, text, status, created_at) VALUES (?1, ?2, 'open', ?3)",
        params![task_id, t, now],
    )
    .map_err(|e| e.to_string())?;
    // registra no log da tarefa
    conn.execute(
        "INSERT INTO event (task_id, agent, role, ts, type, text, ok) VALUES (?1, 'você', NULL, ?2, 'note', ?3, 1)",
        params![task_id, now, format!("instrução enviada: {t}")],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Catálogo de agentes/workflows (cardume.config.json) para o modal de nova tarefa.
#[tauri::command(async)]
fn config(state: State<AppState>) -> Result<serde_json::Value, String> {
    let repo = repo_of(&state)?;
    let repo_cfg = match std::fs::read_to_string(repo.join("cardume.config.json")) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string())?,
        Err(_) => serde_json::json!({ "agents": [], "workflows": [] }),
    };
    Ok(merge_global_catalog(repo_cfg))
}

/// Catálogo global do usuário (~/.cardume/agents.json) — agentes/workflows
/// disponíveis em TODO projeto. O config do repo tem precedência por id.
fn merge_global_catalog(mut cfg: serde_json::Value) -> serde_json::Value {
    let home = home_dir_s();
    let gpath = PathBuf::from(home).join(".cardume").join("agents.json");
    let global: serde_json::Value = std::fs::read_to_string(&gpath)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({ "agents": [], "workflows": [] }));
    for key in ["agents", "workflows"] {
        let have: std::collections::HashSet<String> = cfg
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
            .unwrap_or_default();
        let extra: Vec<serde_json::Value> = global
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter(|x| x.get("id").and_then(|i| i.as_str()).map(|id| !have.contains(id)).unwrap_or(false)).cloned().collect())
            .unwrap_or_default();
        if !extra.is_empty() {
            let arr = cfg.get_mut(key).and_then(|v| v.as_array_mut());
            if let Some(a) = arr {
                a.extend(extra);
            } else {
                cfg[key] = serde_json::Value::Array(extra);
            }
        }
    }
    cfg
}

/// Salva o catálogo (agentes + workflows) editado na UI em cardume.config.json.
#[tauri::command(async)]
fn save_config(state: State<AppState>, config: serde_json::Value) -> Result<(), String> {
    let repo = repo_of(&state)?;
    let s = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(repo.join("cardume.config.json"), s + "\n").map_err(|e| e.to_string())?;
    Ok(())
}

/// Cria e dispara uma tarefa (detached) — roda o núcleo em background; o SQLite
/// é atualizado ao vivo. Tarefas paralelas se coordenam pelo mesmo state.sqlite.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn new_task(
    state: State<AppState>,
    title: String,
    workflow: Option<String>,
    agents: Option<String>,
    engine: String,
    approval: String,
    owns: Option<String>,
    off: Option<String>,
    objective: Option<String>,
    deliverables: Option<Vec<String>>,
    requirements: Option<Vec<String>>,
    doc: Option<String>,
    proof: Option<bool>,
    start: Option<bool>,
    plan_approval: Option<String>,
    refs: Option<Vec<String>>,
    branch_type: Option<String>,
    issue: Option<String>,
    issue_url: Option<String>,
    base: Option<String>,
    tests: Option<bool>,
    auto_pr: Option<String>,
    pr_base: Option<String>,
    linked_to: Option<String>,
    model: Option<String>,
    models: Option<String>,
    light: Option<bool>,
    // tarefa SOB ÉPICO (estilo BMAD) — todos opcionais; cartão antigo não manda nenhum.
    // Tipados como Value de propósito: o front espalha `ct.spec` inteiro no payload, e um
    // `wave:"2"` ou `after:[0,1]` de um spec editado à mão NÃO pode derrubar o invoke inteiro.
    epic_id: Option<String>,
    verify: Option<String>,
    covers: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
    wave: Option<serde_json::Value>,
    boundaries: Option<serde_json::Value>,
    risk: Option<String>,
    hitl: Option<serde_json::Value>,
    epic_done_when: Option<serde_json::Value>,
) -> Result<String, String> {
    // tolerante: lista de strings (números viram texto), wave numérica ou "2", hitl true/"true"
    let strs = |v: &Option<serde_json::Value>| -> Vec<String> {
        v.as_ref().and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| match x {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        }).filter(|s| !s.trim().is_empty()).collect()).unwrap_or_default()
    };
    let (covers, after, boundaries, done_when) = (strs(&covers), strs(&after), strs(&boundaries), strs(&epic_done_when));
    let wave: u32 = match &wave { Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0) as u32, Some(serde_json::Value::String(s)) => s.trim().parse().unwrap_or(0), _ => 0 };
    let hitl = matches!(&hitl, Some(serde_json::Value::Bool(true))) || matches!(&hitl, Some(serde_json::Value::String(s)) if s == "true");
    let repo = repo_of(&state)?;
    if !repo_is_git(&repo.display().to_string()) {
        return Err("esta pasta não tem repositório git — cada demanda roda numa branch própria. Crie o repositório (botão \"criar repositório\" na barra lateral) e tente de novo.".into());
    }
    // id determinado no Rust (idempotente sob o slugify do CLI) pra já rastrear
    // o processo desta tarefa e permitir pausar/abortar.
    // Se o id já existe (ex.: entrega criada a partir de um design com o MESMO
    // título), sufixa -2, -3… — senão o INSERT do CLI falha silenciosamente.
    // Título que NÃO CABE no slug → a IA REFAZ o nome (decisão do Douglas:
    // nada de nome truncado); sem IA/offline, cai no corte em fronteira.
    let mut id = if slug_raw(&title).len() > 48 {
        ai_branch_name(&title).unwrap_or_else(|| slug_id(&title))
    } else {
        slug_id(&title)
    };
    {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = db {
            // READ_WRITE: com WAL, abrir read-only falha (não pode criar o -shm)
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(4000));
                let base = id.clone();
                let mut n = 1;
                while conn
                    .query_row("SELECT 1 FROM task WHERE id=?1", params![id], |_| Ok(()))
                    .is_ok()
                {
                    n += 1;
                    // o CLI re-slugifica o id e TRUNCA em 48 — o sufixo precisa
                    // caber, senão é cortado e o id volta a ser o duplicado.
                    let sfx = format!("-{n}");
                    let keep = 48usize.saturating_sub(sfx.len());
                    let mut b = base[..base.len().min(keep)].to_string();
                    while b.ends_with('-') {
                        b.pop();
                    }
                    id = format!("{b}{sfx}");
                }
            }
        }
    }
    let mut args = vec![
        "--disable-warning=ExperimentalWarning".to_string(),
        cli_path(&repo),
        "new".to_string(),
        "--id".to_string(),
        id.clone(),
        "--repo".to_string(),
        repo.display().to_string(),
        "--title".to_string(),
        title,
        "--engine".to_string(),
        engine,
        "--approve".to_string(),
        approval,
    ];
    push_opt(&mut args, "--workflow", &workflow);
    push_opt(&mut args, "--agents", &agents);
    push_opt(&mut args, "--owns", &owns);
    push_opt(&mut args, "--off", &off);
    push_opt(&mut args, "--objective", &objective);
    if let Some(ds) = &deliverables {
        for d in ds.iter().filter(|x| !x.is_empty()) {
            args.push("--deliverable".to_string());
            args.push(d.clone());
        }
    }
    if let Some(rs) = &requirements {
        // um flag por requisito: o join por vírgula quebrava "a, b e c" em três requisitos
        for r in rs.iter().filter(|x| !x.trim().is_empty()) {
            args.push("--requirement".to_string());
            args.push(r.clone());
        }
    }
    if let Some(d) = &doc {
        if !d.is_empty() {
            args.push("--artifact-doc".to_string());
            args.push(d.clone());
        }
    }
    if proof.unwrap_or(false) {
        args.push("--artifact-proof".to_string());
    }
    if start == Some(false) {
        args.push("--no-start".to_string());
    }
    if plan_approval.as_deref() == Some("review") {
        args.push("--plan-approval".to_string());
        args.push("review".to_string());
    }
    if let Some(rs) = &refs {
        for r in rs.iter().filter(|x| !x.is_empty()) {
            args.push("--ref".to_string());
            args.push(r.clone());
        }
    }
    push_opt(&mut args, "--branch-type", &branch_type);
    push_opt(&mut args, "--issue", &issue);
    push_opt(&mut args, "--issue-url", &issue_url);
    push_opt(&mut args, "--base", &base);
    push_opt(&mut args, "--model", &model);
    push_opt(&mut args, "--models", &models);
    if tests.unwrap_or(false) {
        args.push("--artifact-tests".to_string());
    }
    push_opt(&mut args, "--auto-pr", &auto_pr);
    push_opt(&mut args, "--pr-base", &pr_base);
    push_opt(&mut args, "--linked-to", &linked_to);
    if light.unwrap_or(false) { args.push("--light".to_string()); }
    // campos de épico → flags do CLI (um flag por item nas listas, como --requirement)
    push_opt(&mut args, "--epic-id", &epic_id);
    push_opt(&mut args, "--verify", &verify);
    for (flag, xs) in [("--cover", &covers), ("--after", &after), ("--boundary", &boundaries), ("--done-when", &done_when)] {
        for x in xs { args.push(flag.to_string()); args.push(x.clone()); }
    }
    if wave > 0 { args.push("--wave".to_string()); args.push(wave.to_string()); }
    push_opt(&mut args, "--risk", &risk);
    if hitl { args.push("--hitl".to_string()); }

    let mut cmd = Command::new(node_bin());
    cmd.args(&args).current_dir(&repo);
    // saída do CLI vai pra um log — criação nunca mais falha em SILÊNCIO
    let log_dir = repo.join(".cardume").join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join(format!("new-{id}.log"));
    if let (Ok(o), Ok(e)) = (std::fs::File::create(&log_path), std::fs::File::create(log_dir.join(format!("new-{id}.err.log")))) {
        cmd.stdout(Stdio::from(o)).stderr(Stdio::from(e));
    }
    // rastreia só quando a tarefa realmente vai rodar (rascunho não tem processo)
    if start == Some(false) {
        cmd.stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("falha ao criar rascunho: {e}"))?;
    } else {
        spawn_tracked(&state, &id, cmd)?;
    }
    // confere que a tarefa NASCEU (o CLI é destacado): sem linha no banco em
    // ~6s, devolve o erro real do log em vez de fingir sucesso.
    {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = db {
            let mut born = false;
            for _ in 0..12 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
                    if conn.query_row("SELECT 1 FROM task WHERE id=?1", params![id], |_| Ok(())).is_ok() {
                        born = true;
                        break;
                    }
                }
            }
            if !born {
                let err = std::fs::read_to_string(log_dir.join(format!("new-{id}.err.log"))).unwrap_or_default();
                let out = std::fs::read_to_string(&log_path).unwrap_or_default();
                let tail: String = format!("{out}\n{err}").lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
                return Err(format!("a tarefa não foi criada — saída do CLI:\n{}", if tail.trim().is_empty() { "(log vazio — veja .cardume/logs)".to_string() } else { tail }));
            }
        }
    }
    Ok(id)
}

/// Remote origin do repo aberto, normalizado (ex.: github.com/org/repo) —
/// identifica o "projeto" no time da nuvem, independente de https/ssh/alias.
#[tauri::command(async)]
fn repo_remote(state: State<AppState>) -> Result<String, String> {
    remote_of_path(&repo_of(&state)?)
}

/// Mesma identidade, pra QUALQUER projeto da lista local (painel de Issues: conectar vários).
#[tauri::command(async)]
fn repo_remote_of(path: String) -> Result<String, String> {
    remote_of_path(&PathBuf::from(path))
}

/// Identidade atual + a forma ANTIGA desta máquina (antes da normalização do alias de ssh):
/// o front lê a nuvem pelas duas (`in.(remote,legacy)`) e grava sempre na `remote`.
/// `path` vazio = projeto aberto. `legacy` == `remote` quando não houve mudança.
#[tauri::command(async)]
fn repo_remote_ids(state: State<AppState>, path: Option<String>) -> Result<serde_json::Value, String> {
    let repo = match path.filter(|p| !p.trim().is_empty()) { Some(p) => PathBuf::from(p), None => repo_of(&state)? };
    let remote = remote_of_path(&repo)?;
    let legacy = remote_of_path_legacy(&repo).unwrap_or_else(|_| remote.clone());
    Ok(serde_json::json!({ "remote": remote, "legacy": legacy }))
}

/// Identidade do projeto: remote do github.com (direto, com usuário/token, `www.`, alias de ssh)
/// vira SEMPRE `github.com/owner/repo`; outros hosts mantêm a forma antiga.
fn remote_of_path(repo: &PathBuf) -> Result<String, String> {
    match origin_url(repo) {
        Ok(raw) => Ok(remote_identity_from_url(&raw, &ssh_resolve_hostname_cached)),
        Err(_) => Ok(local_identity(repo)),
    }
}

/// A identidade de antes (host do jeito que estava no remote, alias incluso) — só pra achar
/// linhas/chaves gravadas por versões antigas.
fn remote_of_path_legacy(repo: &PathBuf) -> Result<String, String> {
    match origin_url(repo) {
        Ok(raw) => Ok(legacy_identity_from_url(&raw)),
        Err(_) => Ok(local_identity(repo)),
    }
}

fn local_identity(repo: &PathBuf) -> String {
    // sem remote: usa o nome da pasta como identidade local
    format!("local/{}", repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
}

fn remote_identity_from_url(raw: &str, resolve: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(r) = parse_git_remote(raw) {
        if remote_is_github(&r, resolve) { return format!("github.com/{}/{}", r.owner, r.name); }
    }
    legacy_identity_from_url(raw)
}

fn legacy_identity_from_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches(".git").to_string();
    if let Some(rest) = s.strip_prefix("git@") {
        s = rest.replacen(':', "/", 1);
    } else {
        for p in ["https://", "http://", "ssh://git@", "ssh://"] {
            if let Some(rest) = s.strip_prefix(p) { s = rest.to_string(); break; }
        }
    }
    s
}

/// `ssh -G` custa um processo (até 3s): a identidade é pedida a cada tick, então guarda por host.
fn ssh_resolve_hostname_cached(alias: &str) -> Option<String> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, Option<String>>>> = std::sync::OnceLock::new();
    let c = C.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = c.lock().unwrap_or_else(|e| e.into_inner()).get(alias) { return v.clone(); }
    let v = ssh_resolve_hostname(alias);
    c.lock().unwrap_or_else(|e| e.into_inner()).insert(alias.to_string(), v.clone());
    v
}

/// Remote git decomposto. `ssh` = forma scp (`git@host:o/r`) ou `ssh://` — só aí o host pode ser
/// um ALIAS do ~/.ssh/config (ex.: `github.com-work`, `github-market4u`) que aponta pro github.com.
#[derive(Debug, Clone, PartialEq)]
struct GitRemote { host: String, owner: String, name: String, ssh: bool }

/// Aceita `git@host:owner/repo(.git)`, `host:owner/repo`, `ssh://git@host[:porta]/owner/repo`,
/// `https://[user[:token]@][www.]github.com/owner/repo(.git)`. Caminho local → None.
fn parse_git_remote(raw: &str) -> Option<GitRemote> {
    let s = raw.trim();
    if s.is_empty() { return None; }
    let (authority, path, ssh) = if let Some((scheme, rest)) = s.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if scheme == "file" { return None; }
        let (auth, path) = rest.split_once('/').unwrap_or((rest, ""));
        (auth.to_string(), path.to_string(), scheme.contains("ssh") || scheme == "git")
    } else {
        // forma scp: [user@]host:caminho — o ':' tem que vir antes de qualquer '/'
        let colon = s.find(':')?;
        if s.find('/').is_some_and(|sl| sl < colon) { return None; }
        (s[..colon].to_string(), s[colon + 1..].to_string(), true)
    };
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if host.is_empty() { return None; }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    let segs: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if segs.len() < 2 { return None; }
    let name = segs[segs.len() - 1].to_string();
    let owner = segs[..segs.len() - 1].join("/");
    Some(GitRemote { host, owner, name, ssh })
}

/// `ssh -G <alias>` só IMPRIME a config resolvida (não conecta): devolve o `hostname` real.
fn ssh_resolve_hostname(alias: &str) -> Option<String> {
    if alias.starts_with('-') { return None; }
    let mut c = Command::new("ssh");
    c.args(["-G", alias]);
    let o = output_timeout(c, 3).ok()?;
    if !o.status.success() { return None; }
    String::from_utf8_lossy(&o.stdout).lines()
        .find_map(|l| l.strip_prefix("hostname ").map(|h| h.trim().to_ascii_lowercase()))
}

fn is_github_dot_com(h: &str) -> bool { h == "github.com" || h == "ssh.github.com" }

/// O host do remote é o github.com? Direto, via alias do ssh (resolver injetável nos testes) ou,
/// sem ssh disponível, pela heurística de alias (`github.com-work`, `github-market4u`, `github`).
/// `github.empresa.com` (Enterprise) NÃO conta: tem ponto e não é github.com.
fn remote_is_github(r: &GitRemote, resolve: &dyn Fn(&str) -> Option<String>) -> bool {
    if is_github_dot_com(&r.host) { return true; }
    if !r.ssh { return false; }
    if let Some(real) = resolve(&r.host) {
        if is_github_dot_com(&real) { return true; }
        if real != r.host { return false; } // alias que aponta pra OUTRO host
    }
    r.host.starts_with("github.com") || (r.host.starts_with("github") && !r.host.contains('.'))
}

/// `owner/repo` do github.com a partir da URL do remote + se o host é alias (≠ "github.com"),
/// caso em que os comandos do gh devem receber `--repo owner/repo` explícito.
fn github_slug_from_url(raw: &str, resolve: &dyn Fn(&str) -> Option<String>) -> Result<(String, bool), String> {
    let r = parse_git_remote(raw).ok_or("não reconheci a URL do remote origin")?;
    if !remote_is_github(&r, resolve) {
        return Err(format!("criar PR pelo navegador só vale pra repos do github.com (o remote aponta pra {})", r.host));
    }
    Ok((format!("{}/{}", r.owner, r.name), r.host != "github.com"))
}

fn origin_url(repo: &PathBuf) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(repo)
        .args(["config", "--get", "remote.origin.url"]).output().map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() { return Err("sem remote origin".into()); }
    Ok(raw)
}

fn github_slug_of(repo: &PathBuf) -> Result<(String, bool), String> {
    github_slug_from_url(&origin_url(repo)?, &ssh_resolve_hostname)
}

/// `--repo owner/repo` quando o origin usa alias de ssh (o gh pode não mapear o alias pro github.com).
fn gh_repo_args(repo: &PathBuf) -> Vec<String> {
    match github_slug_of(repo) {
        Ok((slug, true)) => vec!["--repo".into(), slug],
        _ => vec![],
    }
}

#[cfg(test)]
mod git_remote_tests {
    use super::*;
    fn none(_: &str) -> Option<String> { None }
    fn slug(u: &str) -> Result<(String, bool), String> { github_slug_from_url(u, &none) }
    #[test]
    fn parse_formas_comuns() {
        let r = parse_git_remote("git@github.com:market4u-ti/sap-integration-service.git").unwrap();
        assert_eq!((r.host.as_str(), r.owner.as_str(), r.name.as_str(), r.ssh), ("github.com", "market4u-ti", "sap-integration-service", true));
        let r = parse_git_remote("ssh://git@ssh.github.com:443/o/r.git").unwrap();
        assert_eq!((r.host.as_str(), r.owner.as_str(), r.name.as_str()), ("ssh.github.com", "o", "r"));
        let r = parse_git_remote("https://paulo:ghp_x@www.GitHub.com/o/r.git/").unwrap();
        assert_eq!((r.host.as_str(), r.owner.as_str(), r.name.as_str(), r.ssh), ("github.com", "o", "r", false));
        let r = parse_git_remote("https://gitlab.com/g/sub/proj").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str()), ("g/sub", "proj"));
        assert!(parse_git_remote("/Users/x/repo").is_none());
        assert!(parse_git_remote("./x/y:z").is_none());
        assert!(parse_git_remote("file:///tmp/r.git").is_none());
        assert!(parse_git_remote("").is_none());
    }
    #[test]
    fn github_direto_https_e_ssh() {
        assert_eq!(slug("git@github.com:o/r.git").unwrap(), ("o/r".to_string(), false));
        assert_eq!(slug("https://github.com/o/r").unwrap(), ("o/r".to_string(), false));
        assert_eq!(slug("https://u@github.com/o/r.git").unwrap(), ("o/r".to_string(), false));
        assert_eq!(slug("ssh://git@ssh.github.com:443/o/r.git").unwrap(), ("o/r".to_string(), true));
    }
    #[test]
    fn alias_de_ssh_pela_heuristica() {
        assert_eq!(slug("git@github.com-work:market4u-ti/sap-integration-service.git").unwrap(), ("market4u-ti/sap-integration-service".to_string(), true));
        assert_eq!(slug("git@github-market4u:o/r.git").unwrap(), ("o/r".to_string(), true));
        // Enterprise e outros hosts não viram github.com
        assert!(slug("git@github.empresa.com:o/r.git").is_err());
        assert!(slug("https://gitlab.com/o/r").is_err());
        // alias https não existe: host estranho em https não é github
        assert!(slug("https://github-work/o/r").is_err());
    }
    #[test]
    fn alias_resolvido_pelo_ssh_config() {
        let gh = |h: &str| if h == "trabalho" { Some("github.com".to_string()) } else { Some(h.to_string()) };
        assert_eq!(github_slug_from_url("git@trabalho:o/r.git", &gh).unwrap(), ("o/r".to_string(), true));
        // alias "github-x" que o ssh resolve pra OUTRO host (gitlab): não é github
        let gl = |_: &str| Some("gitlab.com".to_string());
        assert!(github_slug_from_url("git@github-x:o/r.git", &gl).is_err());
        // https nunca consulta o ssh
        let panic = |_: &str| -> Option<String> { panic!("não devia chamar ssh") };
        assert!(github_slug_from_url("https://meu-host/o/r", &panic).is_err());
        assert!(github_slug_from_url("https://github.com/o/r", &panic).is_ok());
    }
    #[test]
    fn identidade_normalizada_do_github() {
        let id = |u: &str| remote_identity_from_url(u, &none);
        assert_eq!(id("git@github.com-work:org/repo.git"), "github.com/org/repo");
        assert_eq!(id("git@github-market4u:org/repo.git"), "github.com/org/repo");
        assert_eq!(id("git@github.com:org/repo.git"), "github.com/org/repo");
        assert_eq!(id("https://paulo:ghp_x@github.com/org/repo.git"), "github.com/org/repo");
        assert_eq!(id("https://u@github.com/org/repo"), "github.com/org/repo");
        assert_eq!(id("https://www.GitHub.com/org/repo.git"), "github.com/org/repo");
        assert_eq!(id("ssh://git@ssh.github.com:443/org/repo.git"), "github.com/org/repo");
        assert_eq!(id("https://github.com/org/repo/"), "github.com/org/repo");
        // alias resolvido pelo ~/.ssh/config
        let gh = |h: &str| if h == "trabalho" { Some("github.com".to_string()) } else { None };
        assert_eq!(remote_identity_from_url("git@trabalho:org/repo.git", &gh), "github.com/org/repo");
    }
    #[test]
    fn identidade_fora_do_github_nao_muda() {
        let id = |u: &str| remote_identity_from_url(u, &none);
        for u in ["https://gitlab.com/g/sub/proj.git", "git@gitlab.com:g/proj.git", "git@github.empresa.com:o/r.git",
                  "ssh://git@bitbucket.org/o/r.git", "/Users/x/repo", "https://github-work/o/r"] {
            assert_eq!(id(u), legacy_identity_from_url(u), "{u}");
        }
        assert_eq!(id("https://gitlab.com/g/sub/proj.git"), "gitlab.com/g/sub/proj");
    }
    #[test]
    fn identidade_legada_preservada() {
        assert_eq!(legacy_identity_from_url("git@github.com-work:org/repo.git"), "github.com-work/org/repo");
        assert_eq!(legacy_identity_from_url("https://u@github.com/org/repo.git"), "u@github.com/org/repo");
        assert_eq!(legacy_identity_from_url("git@github.com:org/repo.git"), "github.com/org/repo");
    }
    #[test]
    fn erro_de_host_nao_vaza_credencial() {
        let e = slug("https://user:segredo@gitlab.com/o/r").unwrap_err();
        assert!(!e.contains("segredo") && e.contains("gitlab.com"));
    }
}

/// Reordena as tarefas no Fluxo: grava sort_order = posição na lista recebida.
#[tauri::command(async)]
fn reorder_tasks(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE task SET sort_order=?1 WHERE id=?2", params![i as i64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Inicia uma tarefa em rascunho (roda a equipe). Detached, como new_task.
#[tauri::command(async)]
fn start_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    // duplo clique em ▶ / "aprovar plano" subia DOIS times na mesma worktree
    // (olha o lock do turno, não o processo: um node terminando de fechar não deve travar o ▶)
    if busy_task_pid(&state, &task_id).is_some() {
        return Err("essa tarefa já está rodando".into());
    }
    let repo = repo_of(&state)?;
    let mut cmd = Command::new(node_bin());
    cmd.args([
        "--disable-warning=ExperimentalWarning",
        &cli_path(&repo),
        "start",
        &task_id,
        "--repo",
        &repo.display().to_string(),
    ])
    .current_dir(&repo);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&state, &task_id, cmd)?;
    Ok(())
}

/// Revisa um PR por link/número — SEM criar branch. Roda `review-pr` (detached,
/// rastreado como as demais tarefas: aparece na trilha/Kanban, com pausar/abortar).
#[tauri::command(async)]
fn review_pr(state: State<AppState>, pr_url: String, agents: Option<String>) -> Result<(), String> {
    let repo = repo_of(&state)?;
    // id amigável: pr-<número> quando dá pra extrair; senão, slug do link.
    let num: Option<String> = pr_url
        .rsplit(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string());
    let id = match &num {
        Some(n) => format!("pr-{n}"),
        None => slug_id(&format!("pr {pr_url}")),
    };
    let mut args = vec![
        "--disable-warning=ExperimentalWarning".to_string(),
        cli_path(&repo),
        "review-pr".to_string(),
        "--id".to_string(),
        id.clone(),
        "--pr".to_string(),
        pr_url,
        "--repo".to_string(),
        repo.display().to_string(),
    ];
    push_opt(&mut args, "--agents", &agents);
    let mut cmd = Command::new(node_bin());
    cmd.args(&args).current_dir(&repo);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&state, &id, cmd)?;
    Ok(())
}

/// Marca a tarefa como 'blocked' | 'closed' (ou limpa com "" / null). Estado do
/// usuário, ortogonal ao status do agente — usado pra filtrar/arquivar no Fluxo.
#[tauri::command(async)]
fn set_task_flag(state: State<AppState>, task_id: String, flag: Option<String>) -> Result<(), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    let _ = conn.execute("ALTER TABLE task ADD COLUMN flag TEXT", []); // idempotente
    let f = flag.filter(|s| s == "blocked" || s == "closed");
    conn.execute("UPDATE task SET flag=?1 WHERE id=?2", params![f, task_id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Momento do build (mtime do executável) — carimbo no rodapé pra saber qual
/// versão está rodando (evita depurar tela de build antiga).
#[tauri::command(async)]
fn build_info() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}

/// Marca o STATUS da tarefa manualmente (ex.: PR mergeado direto no GitHub →
/// "marcar como mergeada"; erro resolvido à mão → "voltar pra review").
/// Whitelist de estados seguros; merged também libera claims/pendências.
#[tauri::command(async)]
fn mark_task_status(state: State<AppState>, task_id: String, status: String) -> Result<(), String> {
    if !["review", "merged", "draft", "running", "cancelled"].contains(&status.as_str()) {
        return Err(format!("status inválido: {status}"));
    }
    // cancelar = parar o agente se estiver rodando (como abortar, mas com rótulo próprio)
    if status == "cancelled" {
        let pid = { state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied() };
        if let Some(p) = pid {
            signal_group(p, procsig::CONT); // destrava se pausado
            signal_group(p, procsig::TERM);
            let procs = state.procs.clone();
            let tid = task_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                signal_group(p, procsig::KILL);
                if let Ok(mut m) = procs.lock() {
                    if m.get(&tid) == Some(&p) { m.remove(&tid); }
                }
            });
        }
    }
    set_task_status(&state, &task_id, &status)?;
    if status == "merged" || status == "cancelled" {
        // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
        let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = db_path_now {
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
                let _ = conn.execute("DELETE FROM claim WHERE task_id=?1", params![task_id]);
                let _ = conn.execute("DELETE FROM pending WHERE task_id=?1", params![task_id]);
                // mergeada: a worktree já não serve — cancelada fica (dá pra retomar/inspecionar; a limpeza manual tira)
                if status == "merged" { if let Ok(repo) = repo_of(&state) { preview_kill(&state.procs, &task_id); remove_task_worktree(&repo, &conn, &task_id); } }
            }
        }
    }
    Ok(())
}

// ---------- rascunho do Planner (persistência no banco) ----------
/// Salva/atualiza o rascunho do Planner (1 linha). Chamado a cada rodada da
/// conversa, pra sobreviver a fechar/crashar o app.
#[tauri::command(async)]
fn save_draft(state: State<AppState>, json: String) -> Result<(), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    let _ = conn.execute("CREATE TABLE IF NOT EXISTS planner_draft (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, updated_at INTEGER NOT NULL)", []);
    conn.execute(
        "INSERT INTO planner_draft(id,json,updated_at) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET json=?1, updated_at=?2",
        params![json, now_ms()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
/// Lê o rascunho salvo (ou None).
#[tauri::command(async)]
fn load_draft(state: State<AppState>) -> Result<Option<String>, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    let r = conn.query_row("SELECT json FROM planner_draft WHERE id=1", [], |row| row.get::<_, String>(0));
    match r { Ok(s) => Ok(Some(s)), Err(_) => Ok(None) }
}
/// Descarta o rascunho (após criar a tarefa ou o usuário começar do zero).
#[tauri::command(async)]
fn clear_draft(state: State<AppState>) -> Result<(), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
        let _ = conn.execute("DELETE FROM planner_draft WHERE id=1", []);
    }
    Ok(())
}

/// Eventos COMPLETOS de uma tarefa (texto inteiro), incremental via since_id —
/// alimenta a conversa do workspace sem inflar o snapshot de 1s.
#[tauri::command(async)]
fn task_events(state: State<AppState>, task_id: String, since_id: Option<i64>) -> Result<Vec<Event>, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    let since = since_id.unwrap_or(0);
    let rows = conn
        .prepare("SELECT id,task_id,agent,ts,\"type\",text,ok FROM event WHERE task_id=?1 AND id>?2 ORDER BY id LIMIT 2000")
        .map_err(|e| e.to_string())?
        .query_map(params![task_id, since], |r| {
            Ok(Event { id: r.get(0)?, task_id: r.get(1)?, agent: r.get(2)?, ts: r.get(3)?, kind: r.get(4)?, text: r.get(5)?, ok: r.get(6)? })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ---------- controles por execução (pausar / retomar / abortar) ----------

/// PID VIVO do processo da tarefa: o mapa `procs` (spawn desta sessão do app) ou, depois
/// de reiniciar o app (o mapa zera, mas o motor segue vivo via setsid), o lock `busy_pid`
/// do banco. Usado por iniciar/pausar/retomar/parar/abortar — antes só o parar tinha o fallback.
fn live_task_pid(state: &State<AppState>, task_id: &str) -> Option<i32> {
    let from_map = { state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(task_id).copied() };
    if let Some(p) = from_map { if pid_alive(p) { return Some(p); } }
    busy_task_pid(state, task_id)
}
/// Só o LOCK do motor (task.busy_pid, gravado enquanto um turno roda e limpo ao fim):
/// é o que diz "tem um time trabalhando nesta worktree agora".
fn busy_task_pid(state: &State<AppState>, task_id: &str) -> Option<i32> {
    let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone(); // trava solta já aqui
    let path = db_path_now?;
    let conn = open(&path).ok()?;
    let bp: Option<i64> = conn
        .query_row("SELECT busy_pid FROM task WHERE id = ?1", params![task_id], |r| r.get::<_, Option<i64>>(0))
        .ok()
        .flatten();
    let bp = bp? as i32;
    if bp > 0 && pid_alive(bp) { Some(bp) } else { None }
}

/// Congela a árvore de processos do agente (SIGSTOP no grupo) e marca 'paused'.
#[tauri::command(async)]
fn pause_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let pid = live_task_pid(&state, &task_id);
    match pid {
        Some(p) => {
            signal_group(p, procsig::STOP);
            set_task_status(&state, &task_id, "paused")
        }
        None => Err("tarefa não está em execução".to_string()),
    }
}

/// Retoma a árvore congelada (SIGCONT) e volta pra 'running' — o orquestrador
/// segue e atualiza o status conforme avança nas etapas.
#[tauri::command(async)]
fn resume_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let pid = live_task_pid(&state, &task_id);
    match pid {
        Some(p) => {
            signal_group(p, procsig::CONT);
            set_task_status(&state, &task_id, "running")
        }
        None => Err("tarefa não está pausada".to_string()),
    }
}

/// PARA o turno atual do agente (ex.: no chat, pra intervir) sem "abortar" a
/// tarefa: mata o processo em execução e volta o status pra 'review', deixando a
/// worktree e os registros como estão — aí o humano manda uma nova mensagem.
#[tauri::command(async)]
fn stop_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    // App reiniciado perde o mapa de processos, mas o turno do MOTOR continua
    // vivo (setsid) — live_task_pid cai no lock busy_pid do banco.
    let pid = live_task_pid(&state, &task_id);
    if let Some(p) = pid {
        // ESPERA o turno morrer (≤ ~1,6s) antes de voltar: o "■ parar e enviar" do chat chama
        // talk_task logo em seguida, e o motor novo via o busy_pid do processo AINDA VIVO → a
        // mensagem ia pra fila de um turno que morria no SIGKILL sem drenar = presa pra sempre.
        // Roda numa thread do runtime (comando async), não na da janela.
        stop_and_wait(p, 1000);
        if let Ok(mut m) = state.procs.lock() {
            if m.get(&task_id) == Some(&p) {
                m.remove(&task_id);
            }
        }
    }
    // volta pra review (não 'aborted') pra poder continuar conversando
    set_task_status(&state, &task_id, "review")?;
    Ok(())
}

/// CONT + TERM no grupo, espera até `grace_ms` o processo sair; senão KILL e mais um respiro curto.
/// Devolve se o processo morreu.
fn stop_and_wait(p: i32, grace_ms: u64) -> bool {
    signal_group(p, procsig::CONT);
    signal_group(p, procsig::TERM);
    let step = std::time::Duration::from_millis(50);
    let t0 = std::time::Instant::now();
    while t0.elapsed() < std::time::Duration::from_millis(grace_ms) {
        if !pid_alive(p) { return true; }
        std::thread::sleep(step);
    }
    signal_group(p, procsig::KILL);
    let t1 = std::time::Instant::now();
    while t1.elapsed() < std::time::Duration::from_millis(600) {
        if !pid_alive(p) { return true; }
        std::thread::sleep(step);
    }
    !pid_alive(p)
}

/// Aborta a tarefa: mata a árvore de processos (SIGCONT p/ destravar + SIGTERM,
/// e SIGKILL após um respiro), marca 'aborted' e libera os claims de arquivo
/// pra não travar outros agentes. A worktree é preservada pra inspeção.
#[tauri::command(async)]
fn abort_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let pid = live_task_pid(&state, &task_id);
    if let Some(p) = pid {
        signal_group(p, procsig::CONT); // caso esteja pausado, destrava pra poder morrer
        signal_group(p, procsig::TERM);
        let procs = state.procs.clone();
        let tid = task_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            signal_group(p, procsig::KILL);
            if let Ok(mut m) = procs.lock() {
                if m.get(&tid) == Some(&p) {
                    m.remove(&tid);
                }
            }
        });
    }
    set_task_status(&state, &task_id, "aborted")?;
    // libera claims de arquivo + perguntas pendentes desta tarefa (best-effort)
    // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
    let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(path) = db_path_now {
        if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
            let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
            let _ = conn.execute("DELETE FROM claim WHERE task_id=?1", params![task_id]);
            let _ = conn.execute("DELETE FROM pending WHERE task_id=?1", params![task_id]);
        }
    }
    Ok(())
}

// ---------- assistente de IA para montar a spec da tarefa ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChat {
    text: String,
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyTask {
    id: String,
    title: String,
    status: String,
    branch: String,
    edits: i64,
    cmds: i64,
    asks: i64,
    usd: f64,
    tok: i64,
    notes: Vec<String>,
}

/// Digest do DIA: o que cada tarefa produziu na janela [from_ms, to_ms) —
/// base da visão de daily do dev.
#[tauri::command(async)]
fn daily_digest(state: State<AppState>, from_ms: i64, to_ms: i64) -> Result<Vec<DailyTask>, String> {
    let dbpath = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&dbpath)?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.status, t.branch,
               SUM(CASE WHEN e.type IN ('edit','write') THEN 1 ELSE 0 END),
               SUM(CASE WHEN e.type='bash' THEN 1 ELSE 0 END),
               SUM(CASE WHEN e.text LIKE 'perguntou ao humano%' OR e.text LIKE '❓%' THEN 1 ELSE 0 END)
             FROM event e JOIN task t ON t.id=e.task_id
             WHERE e.ts>=?1 AND e.ts<?2
             GROUP BY t.id ORDER BY MAX(e.ts) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from_ms, to_ms], |r| {
            Ok(DailyTask {
                id: r.get(0)?, title: r.get(1)?, status: r.get(2)?, branch: r.get(3)?,
                edits: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                cmds: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                asks: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                usd: 0.0, tok: 0, notes: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect::<Vec<_>>();
    let mut out = Vec::new();
    for mut t in rows {
        if let Ok((u, k)) = conn.query_row(
            "SELECT COALESCE(SUM(usd),0), COALESCE(SUM(in_tok+out_tok),0) FROM cost WHERE task_id=?1 AND created_at>=?2 AND created_at<?3",
            params![t.id, from_ms, to_ms],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?)),
        ) {
            t.usd = u;
            t.tok = k;
        }
        // marcos do dia: status/notes relevantes (curtos, sem stream)
        if let Ok(mut ns) = conn.prepare(
            "SELECT text FROM event WHERE task_id=?1 AND ts>=?2 AND ts<?3 AND type IN ('status','note') AND text NOT LIKE '⏳%' AND text NOT LIKE 'Na fila (%' AND text NOT LIKE 'Limite de uso%' AND text NOT LIKE '▶%' ORDER BY id",
        ) {
            if let Ok(it) = ns.query_map(params![t.id, from_ms, to_ms], |r| r.get::<_, String>(0)) {
                let mut v: Vec<String> = it.flatten().map(|s| s.chars().take(160).collect()).collect();
                if v.len() > 6 {
                    let tail = v.split_off(v.len() - 3);
                    v.truncate(3);
                    v.extend(tail);
                }
                t.notes = v;
            }
        }
        out.push(t);
    }
    Ok(out)
}

/// Resumo do dia em bullets, pronto pra colar na daily (Haiku).
#[tauri::command(async)]
fn ai_daily(text: String) -> Result<String, String> {
    let ctx: String = text.chars().take(6000).collect();
    let prompt = format!(
        "Você escreve o update de DAILY de um dev, em português, a partir do log abaixo (tarefas tocadas, commits, marcos, custo). Formato: bullets curtos '- ' agrupados em 'Feito:' e 'Em andamento:' (e 'Bloqueios:' só se houver pergunta pendente). Direto, específico, sem enfeite, sem custo/token. Máx 8 bullets.\n\n{ctx}"
    );
    let out = claude_cmd(&claude_bin())
        .args(["-p", &prompt, "--model", "claude-haiku-4-5-20251001"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// RELATÓRIO técnico do dia (markdown completo): o quê, por quê, arquitetura, como validar.
#[tauri::command(async)]
fn ai_daily_report(text: String, date: String) -> Result<String, String> {
    let ctx: String = text.chars().take(14000).collect();
    let prompt = format!(
        "Você escreve um RELATÓRIO EXECUTIVO do dia de engenharia PARA A DIRETORIA, em português (pt-BR), tom profissional e objetivo — foco em RESULTADO e IMPACTO no produto/negócio, não na mecânica interna. Saída SOMENTE em Markdown bem formatado, começando com `# Relatório do dia — {date}`.\n\n\
         Estrutura:\n\
         1) RESUMO EXECUTIVO (2 a 4 frases): o que avançou no produto hoje e o valor pro usuário/negócio.\n\
         2) Uma seção `## <tema da entrega>` por frente relevante (AGRUPE entregas relacionadas num tema só), cada uma com:\n\
         - **Entrega:** o que passou a funcionar ou melhorou, em termos de PRODUTO (não de código).\n\
         - **Impacto:** por que importa pro usuário/negócio.\n\
         - **Nota técnica:** só se houve mudança de arquitetura relevante — descreva em linguagem acessível (1-2 frases). OMITA a linha inteira se não houver.\n\
         3) Se houver riscos ou pontos que precisam de decisão de NEGÓCIO, uma seção final `## Pontos de atenção` (profissional, sem jargão de processo).\n\n\
         PROIBIDO mencionar (não cite NADA disso): nomes de branch, hashes de commit, caminhos de arquivo internos (.cardume etc.), status internos de execução (timeout, erro de pipeline, rework, 'em review', 'merged'), perguntas feitas ao time durante a execução, custos/tokens, e a frase 'não especificado no log'. Se um dado não estiver claro, simplesmente NÃO comente — NUNCA escreva que faltou informação. Escreva com confiança e clareza, como um líder de produto reportando à diretoria.\n\n{ctx}"
    );
    let out = claude_cmd(&claude_bin())
        .args(["-p", &prompt, "--model", "claude-sonnet-5"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Relatório por DEMANDA (o que foi feito e por quê) ou por PERÍODO (várias entregas),
/// escrito pela IA a partir dos fatos que o app já guarda (spec, provas, commits, PR).
#[tauri::command(async)]
fn ai_task_report(text: String, kind: String, label: String) -> Result<String, String> {
    let ctx: String = text.chars().take(16000).collect();
    let prompt = if kind == "periodo" {
        format!(
            "Você escreve um RELATÓRIO DE ENTREGAS do período para a liderança, em português (pt-BR), tom profissional e objetivo — foco em RESULTADO e IMPACTO no produto/negócio. Saída SOMENTE em Markdown bem formatado, começando com `# Relatório de entregas — {label}`.\n\n\
             Estrutura: 1) RESUMO EXECUTIVO (2 a 4 frases). 2) Uma seção `## <nome da demanda>` por entrega, cada uma com **Entrega:** (o que passou a funcionar, em termos de produto), **Por quê:** (motivação/contexto), **Validação:** (o que foi comprovado — testes, prints, revisão) e, só quando houver decisão técnica relevante, **Nota técnica:** em linguagem acessível. 3) `## Pontos de atenção` só se houver pendências ou riscos.\n\n\
             PROIBIDO citar hashes de commit, caminhos internos (.cardume etc.), status internos de execução, custos/tokens ou a frase 'não especificado'. Se um dado não estiver claro, não comente. Escreva com confiança, como um líder de produto.\n\n{ctx}"
        )
    } else {
        format!(
            "Você escreve o RELATÓRIO DE UMA ENTREGA de engenharia, em português (pt-BR), para o time e a liderança lerem: claro, objetivo, sem jargão de processo. Saída SOMENTE em Markdown bem formatado, começando com `# {label}`.\n\n\
             Estrutura obrigatória:\n\
             `## Resumo` — 2 a 3 frases: o que foi entregue e o valor pro usuário/negócio.\n\
             `## O que foi feito` — lista do que passou a funcionar ou mudou, em termos de PRODUTO; cite o PR quando houver (número e link).\n\
             `## Por quê` — o contexto e a motivação da demanda (use o objetivo e os requisitos).\n\
             `## Como foi feito` — as decisões técnicas relevantes em linguagem acessível (arquitetura, integrações, trade-offs). Sem caminhos internos nem hashes.\n\
             `## Validação` — o que foi comprovado: requisitos provados (com a evidência citada pelo nome do arquivo de prova/teste), testes rodados, revisão e como testar.\n\
             `## Pendências` — SÓ se houver requisitos não provados, comentários abertos no PR ou próximos passos; senão omita a seção.\n\n\
             PROIBIDO: hashes de commit, caminhos internos (.cardume etc.), status internos de execução (timeout, rework, 'em review'), custos/tokens, e frases como 'não informado'. Se um dado faltar, não comente.\n\n{ctx}"
        )
    };
    let out = claude_cmd(&claude_bin())
        .args(["-p", &prompt, "--model", "claude-sonnet-5"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Grava um artefato GERADO PELO APP (ex.: relatório da entrega) na pasta coletada
/// do repo (.cardume/artifacts/<task-id>/) — aparece na lista de artefatos e persiste após o merge.
#[tauri::command(async)]
fn write_artifact(state: State<AppState>, task_id: String, name: String, content: String) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.trim().is_empty() {
        return Err("nome de artefato inválido".into());
    }
    let repo = repo_of(&state)?;
    let dir = repo.join(".cardume").join("artifacts").join(&task_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(name.trim());
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// Troca o modelo (versão do Claude, id do gateway…) de uma demanda JÁ criada: atualiza
/// task.model, roles_json e o spec_json (é dele que o motor lê o modelo de cada papel).
/// Vale a partir do PRÓXIMO turno (talk/rework/retomada) — o turno em andamento termina no modelo atual.
#[tauri::command(async)]
fn set_task_model(state: State<AppState>, task_id: String, model: String) -> Result<(), String> {
    let m = model.trim().to_string();
    if m.len() > 80 || m.chars().any(|c| !(c.is_ascii_alphanumeric() || "-_.:/".contains(c))) {
        return Err("id de modelo inválido".into());
    }
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open(&db).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    let (roles_json, spec_json): (String, String) = conn
        .query_row("SELECT roles_json, spec_json FROM task WHERE id=?1", params![task_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let set_model = |v: &mut serde_json::Value| {
        if let Some(o) = v.as_object_mut() {
            if m.is_empty() { o.remove("model"); } else { o.insert("model".into(), serde_json::Value::String(m.clone())); }
        }
    };
    let mut roles: serde_json::Value = serde_json::from_str(&roles_json).unwrap_or(serde_json::Value::Array(vec![]));
    if let Some(arr) = roles.as_array_mut() { for r in arr.iter_mut() { set_model(r); } }
    let mut spec: serde_json::Value = serde_json::from_str(&spec_json).unwrap_or(serde_json::json!({}));
    set_model(&mut spec);
    if let Some(arr) = spec.get_mut("roles").and_then(|r| r.as_array_mut()) { for r in arr.iter_mut() { set_model(r); } }
    let model_col: Option<String> = if m.is_empty() { None } else { Some(m.clone()) };
    conn.execute(
        "UPDATE task SET model=?1, roles_json=?2, spec_json=?3 WHERE id=?4",
        params![model_col, roles.to_string(), spec.to_string(), task_id],
    ).map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "INSERT INTO event (task_id, agent, ts, type, text, ok) VALUES (?1, 'Sistema', ?2, 'note', ?3, 1)",
        params![task_id, now_ms(), format!("modelo trocado para {} — vale a partir do próximo turno", if m.is_empty() { "o padrão da assinatura".to_string() } else { m.clone() })],
    );
    Ok(())
}

// ---------- Orquestrador: um agente lê o problema inteiro e abre uma tarefa por fase ----------

/// Pede ao orquestrador (claude headless, só leitura no repo) um PLANO em JSON:
/// fases com objetivos verificáveis, dependências e autonomia. Nada é criado aqui.
#[tauri::command(async)]
fn ai_orchestrate(state: State<AppState>, briefing: String, model: Option<String>) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let sys = "Você é o ORQUESTRADOR do Starfork. O usuário descreve um problema inteiro; você o quebra em FASES e cada fase vira uma tarefa real com branch e worktree próprias, executada por um subagente. Você NUNCA escreve código — só planeja. Pode explorar o repositório (Read, Grep, Glob) antes de responder pra citar arquivos, serviços e testes REAIS. Responda SOMENTE com um bloco de código ```json no formato {\"title\":\"nome curto do plano\",\"summary\":\"1-2 frases explicando o plano\",\"phases\":[{\"key\":\"n1\",\"name\":\"nome curto da fase\",\"kind\":\"invest|design|build|review\",\"agent\":\"Investigador|Designer|Coder|Revisor\",\"objective\":\"o que essa fase entrega, em 1-3 frases\",\"objectives\":[\"critério verificável 1\",\"critério 2\"],\"autonomy\":\"ask|free\",\"dependsOn\":[\"n0\"]}]}. Regras: 2 a 6 fases; keys n1..n6; kind invest = investigação sem mexer em código (gera INVESTIGATION.md com evidência), design = proposta/desenho (DESIGN.md), build = implementação com testes e prova, review = revisar e provar a implementação de outra fase. INTEGRAÇÃO: sempre que houver 2 ou mais fases build, a ÚLTIMA fase do plano deve ser uma review que dependa de TODAS as fases build — ela recebe uma branch criada a partir da main com o merge de todas as branches de build, testa tudo junto (suite + UI real) e é dela que sai o Pull Request final; as fases build NÃO abrem PR próprio. Com uma única fase build, a review final é opcional. Cada fase tem 2 a 5 objetivos VERIFICÁVEIS (algo que dá pra provar com print, teste ou arquivo). dependsOn lista as fases que precisam PROVAR o resultado antes desta começar; fases sem dependência rodam em paralelo — use paralelismo quando os escopos são disjuntos. autonomy \"ask\" quando a fase toma decisão que é do usuário (ex.: escolher a correção), \"free\" quando pode seguir sozinha. Nada de texto fora do bloco json.";
    // memória do projeto (índice + notas relevantes ao briefing): o orquestrador não começa do zero
    let sys = memoria::with_memory(sys, &repo, &briefing);
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        briefing,
        "--output-format".to_string(),
        "json".to_string(),
        "--append-system-prompt".to_string(),
        sys,
        "--allowedTools".to_string(),
        "Read,Grep,Glob".to_string(),
    ];
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(m);
    }
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    let out = output_timeout(cmd, 300)?;
    let v = claude_json(&out)?;
    Ok(v["result"].as_str().unwrap_or("").to_string())
}

fn orch_dir(repo: &PathBuf) -> PathBuf {
    let d = repo.join(".cardume").join("orchestrations");
    let _ = std::fs::create_dir_all(&d);
    d
}
fn orch_ok_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Salva/atualiza o plano (JSON inteiro) em .cardume/orchestrations/<id>.json
#[tauri::command(async)]
fn orch_save(state: State<AppState>, id: String, data: serde_json::Value, repo: Option<String>) -> Result<(), String> {
    if !orch_ok_id(&id) { return Err("id inválido".into()); }
    let repo = repo_or(&state, repo)?;
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(orch_dir(&repo).join(format!("{id}.json")), s).map_err(|e| e.to_string())
}

/// Planos de TODOS os projetos conhecidos (ativo primeiro). Cada plano sai com `repo`
/// preenchido (o dele, ou a pasta de onde foi lido) — o plano é preso ao repo, então
/// trocar o projeto ativo não pode "sumir" com ele da Central.
#[tauri::command(async)]
fn orch_list(state: State<AppState>) -> Vec<serde_json::Value> {
    let active = repo_of(&state).ok();
    let mut repos: Vec<PathBuf> = vec![];
    if let Some(a) = &active { repos.push(a.clone()); }
    for p in read_project_list() {
        let pb = PathBuf::from(&p);
        if !repos.contains(&pb) && pb.is_dir() { repos.push(pb); }
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<serde_json::Value> = vec![];
    for repo in repos {
        // só o ativo cria a pasta; nos outros apenas lê (sem efeito colateral)
        let dir = if Some(&repo) == active.as_ref() { orch_dir(&repo) } else { repo.join(".cardume").join("orchestrations") };
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if !p.extension().map(|x| x == "json").unwrap_or(false) { continue; }
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
            let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&txt) else { continue };
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if id.is_empty() || !seen.insert(id) { continue; }
            if v.get("repo").and_then(|x| x.as_str()).map(|x| x.trim().is_empty()).unwrap_or(true) {
                v["repo"] = serde_json::Value::String(repo.display().to_string());
            }
            out.push(v);
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v.get("createdAt").and_then(|x| x.as_i64()).unwrap_or(0)));
    out
}

#[tauri::command(async)]
fn orch_delete(state: State<AppState>, id: String, repo: Option<String>) -> Result<(), String> {
    if !orch_ok_id(&id) { return Err("id inválido".into()); }
    let repo = repo_or(&state, repo)?;
    let p = orch_dir(&repo).join(format!("{id}.json"));
    if p.exists() { std::fs::remove_file(p).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Funde chaves no spec_json da tarefa (ex.: orchestration, dependsOn) e,
/// se vier `base`, troca a branch base da worktree (fase que parte da anterior).
#[tauri::command(async)]
fn patch_task_spec(state: State<AppState>, task_id: String, patch: serde_json::Value, base: Option<String>) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open(&db).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
    let spec_json: String = conn
        .query_row("SELECT spec_json FROM task WHERE id=?1", params![task_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut spec: serde_json::Value = serde_json::from_str(&spec_json).unwrap_or(serde_json::json!({}));
    if let (Some(o), Some(p)) = (spec.as_object_mut(), patch.as_object()) {
        for (k, v) in p { o.insert(k.clone(), v.clone()); }
    }
    if let Some(b) = &base {
        if let Some(o) = spec.as_object_mut() { o.insert("base".into(), serde_json::Value::String(b.clone())); }
        conn.execute("UPDATE task SET base=?1 WHERE id=?2", params![b, task_id]).map_err(|e| e.to_string())?;
    }
    conn.execute("UPDATE task SET spec_json=?1 WHERE id=?2", params![spec.to_string(), task_id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fase de INTEGRAÇÃO do orquestrador (a revisão final): a worktree nasce da base
/// (main) e aqui recebe o merge de TODAS as branches das fases de build — assim o
/// revisor testa tudo junto e o PR sai desta branch, com os merges. Cada merge é
/// `--no-ff` (fica visível no histórico). Conflito NÃO aborta: fica na worktree e
/// o agente resolve (a resposta lista o que conflitou).
#[tauri::command(async)]
fn orch_integrate(state: State<AppState>, task_id: String, branches: Vec<String>) -> Result<serde_json::Value, String> {
    let (wt, base) = task_wt_base(&state, &task_id)?;
    if !wt.is_dir() { return Err("worktree da fase de integração não existe".into()); }
    let wts = wt.display().to_string();
    // alinha com a ponta da base antes (só se a worktree ainda não tem nada próprio)
    let ahead = Command::new("git").args(["-C", &wts, "rev-list", "--count", &format!("{base}..HEAD")]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i64>().unwrap_or(1)).unwrap_or(1);
    if ahead == 0 && !base.is_empty() {
        let _ = Command::new("git").args(["-C", &wts, "reset", "--hard", &base]).output();
    }
    let mut merged: Vec<String> = vec![];
    let mut conflicts: Vec<String> = vec![];
    let mut skipped: Vec<String> = vec![];
    for b in branches.iter().filter(|b| !b.trim().is_empty()) {
        // já contida? (re-execução / branch vazia)
        let contained = Command::new("git").args(["-C", &wts, "merge-base", "--is-ancestor", b, "HEAD"]).output()
            .map(|o| o.status.success()).unwrap_or(false);
        if contained { skipped.push(b.clone()); continue; }
        let out = Command::new("git").args(["-C", &wts, "merge", "--no-ff", "--no-edit", "-m", &format!("merge: integra {b} (orquestrador)"), b]).output().map_err(|e| e.to_string())?;
        if out.status.success() { merged.push(b.clone()); continue; }
        let unmerged = Command::new("git").args(["-C", &wts, "diff", "--name-only", "--diff-filter=U"]).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if unmerged.is_empty() {
            // falhou por outro motivo (branch inexistente etc.) — segue com as outras
            skipped.push(format!("{b} ({})", String::from_utf8_lossy(&out.stderr).trim().lines().next().unwrap_or("falha")));
            let _ = Command::new("git").args(["-C", &wts, "merge", "--abort"]).output();
            continue;
        }
        conflicts.push(format!("{b}: {}", unmerged.replace('\n', ", ")));
        break; // o agente resolve este conflito e faz os merges restantes
    }
    let remaining: Vec<String> = branches.iter().filter(|b| !merged.contains(b) && !skipped.iter().any(|s| s.starts_with(b.as_str())) && !conflicts.iter().any(|c| c.starts_with(&format!("{b}:")))).cloned().collect();
    Ok(serde_json::json!({ "merged": merged, "conflicts": conflicts, "skipped": skipped, "remaining": remaining }))
}

/// Antes de uma fase dependente começar: alinha a worktree (ainda sem commits
/// próprios) com a ponta atual da branch base — a fase anterior commitou depois
/// que a worktree foi criada. Best-effort; nunca descarta trabalho da própria fase.
#[tauri::command(async)]
fn orch_sync_base(state: State<AppState>, task_id: String) -> Result<String, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = Connection::open(&db).map_err(|e| e.to_string())?;
    let (wt, base): (String, String) = conn
        .query_row("SELECT worktree, base FROM task WHERE id=?1", params![task_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    if wt.is_empty() || base.is_empty() || !PathBuf::from(&wt).is_dir() { return Ok("sem worktree".into()); }
    let ahead = Command::new("git").args(["-C", &wt, "rev-list", "--count", &format!("{base}..HEAD")]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i64>().unwrap_or(1)).unwrap_or(1);
    if ahead > 0 { return Ok(format!("worktree já tem {ahead} commit(s) próprios — mantida")); }
    let dirty = Command::new("git").args(["-C", &wt, "status", "--porcelain"]).output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty()).unwrap_or(true);
    if dirty { return Ok("worktree com alterações locais — mantida".into()); }
    let out = Command::new("git").args(["-C", &wt, "reset", "--hard", &base]).output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    Ok(format!("worktree alinhada com {base}"))
}

/// Google Chrome (ou similar) pra gerar PDF via headless.
fn chrome_bin() -> Option<String> {
    // caminhos absolutos conhecidos (macOS .app + instalações comuns de Linux)
    for p in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ] {
        if std::path::Path::new(p).is_file() { return Some(p.to_string()); }
    }
    // no Linux o binário costuma vir por pacote/symlink — resolve pelo PATH
    for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] {
        if let Ok(o) = Command::new("which").arg(name).output() {
            if o.status.success() {
                let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !path.is_empty() && std::path::Path::new(&path).is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Salva um documento (.md) em ~/Documents/Constellation/ e revela no Finder.
#[tauri::command(async)]
fn save_doc(name: String, content: String) -> Result<String, String> {
    let dir = PathBuf::from(home_dir_s()).join("Documents").join("Constellation");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '-'|'_'|'.'|' ') { c } else { '-' }).collect();
    let p = dir.join(safe.trim());
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    let _ = os_reveal(&p);
    Ok(p.display().to_string())
}

/// Gera um PDF a partir de HTML (headless Chrome), salva em ~/Documents/Constellation/ e abre.
#[tauri::command(async)]
fn html_to_pdf(html: String, name: String) -> Result<String, String> {
    let chrome = chrome_bin().ok_or("Google Chrome não encontrado — instale o Chrome pra gerar PDF")?;
    let dir = PathBuf::from(home_dir_s()).join("Documents").join("Constellation");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '-'|'_'|'.') { c } else { '-' }).collect();
    let html_path = dir.join(format!("{safe}.html"));
    let pdf_path = dir.join(format!("{safe}.pdf"));
    std::fs::write(&html_path, &html).map_err(|e| e.to_string())?;
    let out = Command::new(&chrome)
        .args([
            "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--no-sandbox",
            &format!("--print-to-pdf={}", pdf_path.display()),
            &format!("file://{}", html_path.display()),
        ])
        .output()
        .map_err(|e| format!("falha ao rodar o Chrome: {e}"))?;
    if !pdf_path.is_file() {
        return Err(format!("Chrome não gerou o PDF: {}", String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()));
    }
    let _ = std::fs::remove_file(&html_path);
    let _ = os_open(pdf_path.as_os_str()); // abre no leitor de PDF padrão (Preview no Mac)
    Ok(pdf_path.display().to_string())
}

/// Desdobra um trabalho grande em sub-tarefas (JSON) — pro fluxo de épico.
#[tauri::command(async)]
fn ai_decompose(state: State<AppState>, text: String, guide: Option<String>) -> Result<String, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("sem contexto pra desdobrar".to_string());
    }
    let ctx: String = t.chars().take(6000).collect();
    // guia: SPEC.md do repo vence; senão o template da org/produto vindo do app
    let guide = repo_of(&state).ok()
        .and_then(|r| std::fs::read_to_string(PathBuf::from(r).join(".cardume").join("SPEC.md")).ok())
        .map(|s| s.chars().take(1500).collect::<String>())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| guide.filter(|s| !s.trim().is_empty()).map(|s| s.chars().take(1500).collect()))
        .map(|s| format!("\n\nGUIA DE SPEC DESTE TIME (siga ao escrever requisitos):\n{s}"))
        .unwrap_or_default();
    let prompt = format!(
        "Você é um tech lead quebrando um trabalho grande num ÉPICO com tarefas que AGENTES DE IA executarão (cada uma vira branch + worktree própria; tarefas sem dependência entre si rodam AO MESMO TEMPO). Com base no contexto, monte o envelope do épico e de 3 a 7 tarefas. Responda SOMENTE um objeto JSON válido, sem markdown, neste formato: {{\"epic\":\"nome curto do épico\",\"outcome\":\"1 frase: pra quem, o que muda e qual sinal mostra que funcionou\",\"requirements\":[{{\"id\":\"R1\",\"text\":\"requisito do épico, uma linha\"}}],\"doneWhen\":[\"checagem que uma PESSOA roda sem abrir nenhuma tarefa (3 a 6; cada uma falha hoje)\"],\"boundaries\":[\"o que NÃO muda com este épico\"],\"tasks\":[{{\"title\":\"verbo + objeto (máx 60 chars)\",\"objective\":\"2-4 frases: o que fazer, onde, e qual o entregável\",\"verify\":\"1 linha: como se prova que ESTA tarefa entregou\",\"covers\":[\"R1\"],\"after\":[],\"risk\":\"medium\",\"hitl\":false,\"boundaries\":[\"comportamento que ESTA tarefa não pode mudar\"],\"requirements\":[\"critério verificável (2 a 4, frases completas que alguém marca ✓/✗ testando)\"],\"owns\":\"pastas/arquivos que ela reivindica, separados por vírgula (deduza do contexto; vazio se não der)\"}}]}}. `after` são os ÍNDICES (0-based, na ordem de tasks) das irmãs que precisam estar PRONTAS antes desta; [] = pode começar já. `risk` é low, medium ou high; `hitl` true quando parte precisa de uma PESSOA. REGRAS: organize por VALOR pro usuário, nunca por camada técnica; a primeira tarefa é o TRACER BULLET; cada tarefa é STANDALONE (funciona sem as posteriores); nenhuma depende de posterior; `after` só com pré-requisitos REAIS e, como única exceção, pra serializar quem mexe nos MESMOS arquivos — tarefas sem `after` entre si têm `owns` DISJUNTOS (nunca o mesmo arquivo); cada `covers` cita ids de requirements e, juntas, as tarefas cobrem todos. NÃO devolva `wave`.{guide}\n\nCONTEXTO:\n{ctx}"
    );
    let out = claude_cmd(&claude_bin())
        .args(["-p", &prompt])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Gera um título curto de tarefa a partir da descrição (Haiku — rápido/barato).
#[tauri::command(async)]
fn ai_title(text: String) -> Result<String, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("escreva a descrição primeiro".to_string());
    }
    let desc: String = t.chars().take(1500).collect();
    let prompt = format!(
        "Gere um TÍTULO curto (máximo 60 caracteres) em português para uma tarefa de desenvolvimento, no estilo de issue: verbo no infinitivo + objeto específico (ex.: \"Adicionar autocomplete nos filtros da home\"). Responda SOMENTE o título — sem aspas, sem ponto final, sem explicação.\n\nDescrição da tarefa:\n{desc}"
    );
    let out = claude_cmd(&claude_bin())
        .args(["-p", &prompt, "--model", "claude-haiku-4-5-20251001"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let title = s.trim().trim_matches('"').trim().chars().take(80).collect::<String>();
    if title.is_empty() {
        return Err("não veio título — tente de novo".to_string());
    }
    Ok(title)
}

/// Uma linha em português do que a IA está fazendo (tool_use do stream-json) — vai pro chat do planner.
fn tool_line(name: &str, input: &serde_json::Value) -> String {
    let n = name.to_ascii_lowercase();
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let short = |t: String, max: usize| -> String { let t = t.replace('\n', " "); if t.chars().count() > max { format!("{}…", t.chars().take(max).collect::<String>()) } else { t } };
    let rel = |p: String| -> String { p.rsplit('/').take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/") };
    if n == "read" { format!("lendo {}", rel(s("file_path"))) }
    else if n == "grep" { let pat = short(s("pattern"), 60); let path = s("path"); if path.is_empty() { format!("procurando \"{pat}\"") } else { format!("procurando \"{pat}\" em {}", rel(path)) } }
    else if n == "glob" { format!("listando {}", short(s("pattern"), 60)) }
    else if n == "ls" { format!("listando {}", rel(s("path"))) }
    else if n == "bash" { format!("rodando {}", short(s("command"), 90)) }
    else if n.contains("task") { format!("subagente: {}", short(s("description"), 80)) }
    else if n.contains("webfetch") || n.contains("websearch") { format!("consultando {}", short(if s("url").is_empty() { s("query") } else { s("url") }, 80)) }
    else { short(name.to_string(), 40) }
}

static PLANNER_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// PARA a resposta em andamento do planner ("montar conversando"): mata o grupo do claude.
#[tauri::command(async)]
fn ai_chat_stop() -> bool {
    let pid = PLANNER_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 { signal_group(pid, procsig::KILL); true } else { false }
}

/// Planner conversando. Roda o claude em stream-json e, a cada tool_use, emite `planner-activity`
/// ({ line }) pro chat mostrar o que a IA está fazendo; `ai_chat_stop` derruba o processo (PLANNER_STOPPED).
#[tauri::command(async)]
fn ai_chat(app: tauri::AppHandle, state: State<AppState>, prompt: String, session_id: Option<String>, model: Option<String>) -> Result<AiChat, String> {
    let repo = repo_of(&state)?;
    let sys = "Você é o PLANNER do Starfork: monta a ESPECIFICAÇÃO de uma tarefa conversando com o Douglas, em português, de forma ANALÍTICA e INVESTIGATIVA, UMA pergunta por vez e AFIADA, fechando só o que ainda falta — e chegando no PROBLEMA REAL, não só no que ele pediu. INVESTIGUE o código de verdade (Read/Grep/Glob/LS, git log/show/diff) ANTES de perguntar o óbvio: NADA de chutar; cite arquivo:linha quando ajudar e prefira DESCOBRIR lendo a perguntar o que dá pra ver no código. Mas investigue com PARCIMÔNIA: poucas leituras DIRECIONADAS (nunca varredura exaustiva do repo), e se a mensagem for SAUDAÇÃO/conversa fiada ou você ainda NÃO tiver um problema concreto pra apurar, responda DIRETO e rápido SEM usar ferramentas — só investigue quando já houver um problema/tarefa concreto. Vá atrás da CAUSA, não do sintoma: se o Douglas já traz uma solução, entenda antes o PROBLEMA por trás (o que acontece, o que deveria acontecer, por que importa) e desafie suposições com gentileza. Faça POUCAS perguntas, porém afiadas — só o que muda a solução. MÉTODO por tipo de tarefa: (a) BUG/FIX — levante os passos pra REPRODUZIR, o esperado vs o obtido e desde quando; leia o código suspeito e proponha a CAUSA-RAIZ (não o remendo); os requirements devem incluir um TESTE que falha hoje e passa depois + um guard contra regressão. (b) FEATURE — use Jobs-to-be-Done: QUEM é o usuário, qual a TAREFA/resultado que ele quer, e COMO saberemos que resolveu; requirements são critérios de aceite VERIFICÁVEIS (Dado/Quando/Então) cobrindo estados vazio/carregando/erro e casos de borda. (c) REFACTOR/CHORE/DESIGN — qual a DOR concreta e o ALVO, e como PROVAR que o comportamento não mudou (antes/depois). Responda SEMPRE E SOMENTE com um bloco de código ```json contendo as chaves {\"say\":\"\",\"chips\":[],\"patch\":{},\"asking\":\"\",\"done\":false} (e OPCIONALMENTE \"plan\") — nada fora do bloco. Regras: `say` é sua próxima fala curta e objetiva (a pergunta que falta, ou uma confirmação de que pode criar). `chips` são 0 a 4 respostas rápidas sugeridas pra essa pergunta (strings curtas). `patch` contém SÓ os campos que ficaram claros nesta rodada — chaves possíveis: title (string), objective (string), deliverables (array de strings), requirements (array de strings), owns (array de caminhos), off (array de caminhos), engine (string), autonomy (string curta, ex.: \"clarifications: ask\"), artifacts (array com qualquer combinação de \"doc\", \"proof\", \"tests\"); NÃO invente, deixe de fora o que não sabe. `asking` é o nome do campo que você está perguntando AGORA (um de: title, objective, deliverables, requirements, owns, off, autonomy, engine, artifacts) ou \"\". `done` só vira true quando title, objective e deliverables estiverem fechados E o usuário confirmar que pode criar. Se ainda não houver objetivo, comece perguntando o objetivo. Antes de fechar, SEMPRE pergunte quais ENTREGÁVEIS DE COMPROVAÇÃO o usuário quer — documento de arquitetura (doc), prints de prova (proof) e/ou testes (tests) — e grave a escolha em patch.artifacts. Se o usuário não souber um critério, sugira `autonomy: clarifications: ask`. TAMANHO DO PEDIDO — decida assim que o pedido ficar concreto e ABRA o `say` com o rótulo do caminho e o motivo em 1 frase — 'Tarefa única: …', 'Épico pequeno: …' ou 'Inception: …' (ex.: 'Tarefa única: uma frente só, tudo em src/cart.') — na rodada em que decide E de novo na rodada em que devolver `plan`: (1) TAREFA ÚNICA — uma frente, um escopo de arquivos, cabe numa sessão de um agente: fluxo normal, sem `plan`. (2) ÉPICO PEQUENO — 2 a 6 frentes independentes que podem virar entregas separadas rodando EM PARALELO (ex.: 'cadastro por e-mail, login social e recuperação de senha' — fatias de VALOR, cada uma atravessando front, backend e dados): NÃO tente fechar uma tarefa só — proponha um ÉPICO retornando a chave `plan`. (3) INCEPTION COMPLETA — mais de 6 frentes, ou incerteza alta sobre escopo/arquitetura: NÃO devolva `plan` ainda; no `say` liste as frentes (título + resultado em 1 linha) em ordem sugerida e pergunte por qual começar (as 4 primeiras também em `chips`); a frente escolhida vira um ÉPICO PEQUENO na rodada seguinte; as outras ficam só na conversa (o usuário abre outro épico depois) — NÃO as coloque em `patch`. Na dúvida entre (1) e (2), prefira (1): menos épico, não mais. O usuário SEMPRE pode mandar trocar ('vira épico', 'faz tarefa única', 'quebra mais fino') — obedeça sem discutir e diga que trocou. Formato do `plan` = {\"epic\":\"nome curto do épico\",\"outcome\":\"1 frase: pra quem, o que muda e qual sinal mostra que funcionou\",\"requirements\":[{\"id\":\"R1\",\"text\":\"requisito do épico, uma linha\"}],\"doneWhen\":[\"checagem que uma PESSOA roda sem abrir nenhuma tarefa (3 a 6; cada uma falha hoje)\"],\"boundaries\":[\"o que NÃO muda com este épico\"],\"tasks\":[{\"title\":\"\",\"objective\":\"\",\"verify\":\"1 linha: como se prova que ESTA tarefa entregou\",\"covers\":[\"R1\"],\"after\":[],\"risk\":\"medium\",\"hitl\":false,\"boundaries\":[\"comportamento que ESTA tarefa não pode mudar\"],\"requirements\":[\"critério verificável\"],\"owns\":\"caminho(s) que essa tarefa mexe\"}]} com 2 a 6 tarefas. `after` são os ÍNDICES (0-based, na ordem de `tasks`) das irmãs que precisam estar PRONTAS antes desta; [] = pode começar já (ex.: a 3ª tarefa com `after`:[0,1] espera as duas primeiras). `risk` é exatamente low, medium ou high; `hitl` é true quando parte da tarefa precisa de uma PESSOA (login, chave, aprovação, dado que só ela tem); `boundaries` lista comportamentos que a tarefa NÃO pode alterar ([] se não houver). REGRAS DO ÉPICO: organize por VALOR pro usuário, nunca por camada técnica ('banco', 'API', 'front' não são tarefas — cada tarefa atravessa as camadas que precisa); a primeira tarefa é o TRACER BULLET (o caminho mais fino atravessando todas as camadas, provando que elas se conectam); cada tarefa é STANDALONE: funciona e é testável sem as posteriores, e cria só as tabelas/modelos que ELA precisa (nada de 'setup do banco' ou 'criar todos os modelos'); nenhuma tarefa depende de tarefa posterior; `after` marca pré-requisitos REAIS e, como única exceção, serializa frentes que mexem nos MESMOS arquivos (ou elas viram UMA tarefa) — tarefas sem `after` entre si rodam ao mesmo tempo e por isso têm `owns` DISJUNTOS (nunca o mesmo arquivo); cada `covers` cita ids de `requirements` e, juntas, as tarefas cobrem todos; `verify` é UMA linha que alguém além de quem codou consegue checar. NÃO devolva `wave`: a onda é calculada de `after`. Ao propor `plan`, use `say` pra explicar o plano em 1-2 frases, deixe `done`:false e NÃO preencha os campos de tarefa única em patch — espere o usuário aprovar o plano na tela. Nada de texto fora do bloco json.";
    let sys = memoria::with_memory(sys, &repo, &prompt); // cérebro do projeto: o planner não começa do zero
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--append-system-prompt".to_string(),
        sys,
        // read-only: o planner INVESTIGA o código (lê/grep/git) mas NÃO edita nada.
        "--allowedTools".to_string(),
        "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(git grep:*)".to_string(),
    ];
    // bypass NÃO respeita o --allowedTools acima (só as regras de NEGAÇÃO valem) → modo protegido
    args.extend(protect_args(protect_on(&repo)));
    // sem isto o harness NEGA ler prints anexados fora do repo (Desktop etc.)
    args.push("--permission-mode".to_string());
    args.push("bypassPermissions".to_string());
    if let Some(sid) = &session_id {
        if !sid.is_empty() {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }
    }
    push_model(&mut args, &model); // IA padrão do usuário (Configurações) — antes o planner ignorava
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    // grupo próprio (detach_new_group, dentro do helper): o "parar" derruba o claude E o que ele tiver aberto
    run_claude_stream(&app, cmd, &PLANNER_PID, "PLANNER_STOPPED", 600, "planner-activity")
}

/// Roda o `claude -p --output-format stream-json` e, enquanto ele trabalha, emite cada ferramenta usada
/// ("lendo X", "procurando Y") no evento `event` — a tela mostra o que a IA está fazendo em vez de só
/// "pensando…". `slot` guarda o pid pro botão parar; parar → Err(stop_marker). Usado pelo planner e pelo chat do projeto.
fn run_claude_stream(app: &tauri::AppHandle, mut cmd: Command, slot: &std::sync::atomic::AtomicI32, stop_marker: &str, timeout_secs: u64, event: &str) -> Result<AiChat, String> {
    use std::io::BufRead;
    use tauri::Emitter;
    detach_new_group(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    let pid = child.id() as i32;
    slot.store(pid, std::sync::atomic::Ordering::SeqCst);
    // watchdog: investigar o código leva tempo, mas não pra sempre — com "parar" na tela, 10 min é o teto
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let timed_out2 = timed_out.clone();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)).is_err() { timed_out2.store(true, std::sync::atomic::Ordering::SeqCst); signal_group(pid, procsig::KILL); }
    });
    // lê o stream linha a linha: tool_use → evento pro chat; result → resposta final
    let stdout = child.stdout.take().ok_or("sem stdout do claude")?;
    let stderr = child.stderr.take();
    let app2 = app.clone();
    let event = event.to_string();
    let reader = std::thread::spawn(move || -> (String, String, String, bool) {
        let mut result = String::new(); let mut sid = String::new(); let mut last_text = String::new(); let mut is_error = false;
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
            match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "assistant" => {
                    if let Some(parts) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                        for p in parts {
                            if p.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                                let inp = p.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                let _ = app2.emit(&event, serde_json::json!({ "line": tool_line(name, &inp) }));
                            } else if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                                if let Some(t) = p.get("text").and_then(|t| t.as_str()) { last_text = t.to_string(); }
                            }
                        }
                    }
                }
                "result" => {
                    result = v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string();
                    sid = v.get("session_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
                    is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) || v.get("subtype").and_then(|t| t.as_str()).map(|t| t.starts_with("error")).unwrap_or(false);
                }
                _ => {}
            }
        }
        (result, sid, last_text, is_error)
    });
    let err_txt = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr { for l in std::io::BufReader::new(e).lines().map_while(Result::ok) { s.push_str(&l); s.push('\n'); } }
        s
    });
    let status = child.wait();
    let _ = tx.send(());
    let _ = watch.join();
    let _ = slot.compare_exchange(pid, 0, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst);
    let (result, sid, last_text, is_error) = reader.join().unwrap_or_default();
    let err_txt = err_txt.join().unwrap_or_default();
    let status = status.map_err(|e| e.to_string())?;
    if status.code().is_none() {
        return Err(if timed_out.load(std::sync::atomic::Ordering::SeqCst) { format!("comando expirou após {timeout_secs}s (a IA não terminou de investigar)") } else { stop_marker.to_string() });
    }
    // mesmo tratamento do claude_json antigo: is_error (login expirado, limite de uso…) vira erro AMIGÁVEL, não fala do bot
    if is_error {
        let msg = if result.trim().is_empty() { err_txt.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n") } else { result.clone() };
        return Err(claude_friendly_error(msg.trim()));
    }
    if !status.success() && result.is_empty() {
        let tail: String = err_txt.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if tail.trim().is_empty() { format!("claude saiu com código {}", status.code().unwrap_or(-1)) } else { tail });
    }
    // `result` vazio (ex.: erro de API no fim) → fica com o último texto do assistente, se houver
    Ok(AiChat { text: if result.is_empty() { last_text } else { result }, session_id: sid })
}

/// Conversa com o ORQUESTRADOR sobre o projeto e o plano montado: lê o repo de verdade
/// (só leitura) e, enquanto o plano NÃO foi aprovado, pode devolver o plano ajustado
/// (`plan.phases`) — a UI troca o grafo na hora. Sessão retomada a cada mensagem.
#[tauri::command(async)]
fn ai_orchestrate_chat(state: State<AppState>, prompt: String, session_id: Option<String>, model: Option<String>, plan: String, repo: Option<String>) -> Result<AiChat, String> {
    // a sessão do claude vive por PASTA (cwd): a conversa tem que rodar sempre no repo do plano,
    // senão trocar o projeto ativo no meio dela dava "No conversation found".
    let repo = repo_or(&state, repo)?;
    let locked = plan.contains("\"status\":\"running\"") || plan.contains("\"status\":\"done\"");
    let sys = format!(concat!(
        "Você é o ORQUESTRADOR do Starfork conversando com o dev em português sobre o PROJETO aberto e o PLANO que você propôs. ",
        "Pode e DEVE ler o código de verdade (Read/Grep/Glob, git log/show/diff) antes de afirmar qualquer coisa — nada de chutar. Você NÃO edita arquivos nem roda comandos que alterem estado. ",
        "Seja direto e específico (arquivos/linhas quando útil). ",
        "Responda SEMPRE com um bloco ```json com as chaves {{\"say\":\"sua resposta em markdown curto\"}}{}. Nada de texto fora do bloco.\n\nPLANO ATUAL (JSON):\n{}"),
        if locked {
            " — este plano JÁ FOI APROVADO e está rodando: as fases viraram tarefas e NÃO podem mais ser trocadas por aqui; responda dúvidas, explique decisões e sugira o que o dev pode fazer (ex.: adicionar um subagente pelo botão '+ subagente')".to_string()
        } else {
            concat!(" e, SOMENTE se o dev pedir uma mudança no plano (juntar/dividir/renomear fases, mudar objetivos, dependências, autonomia, ordem), inclua também \"plan\":{{\"phases\":[...]}} com a LISTA COMPLETA de fases já ajustada, no mesmo formato do plano atual ",
                    "({{key,name,kind:invest|design|build|review,agent,objective,objectives:[criterios verificaveis],autonomy:ask|free,dependsOn:[keys]}}). Mantenha as keys das fases que não mudaram. Não inclua \"plan\" quando for só resposta").to_string()
        },
        plan
    );
    let sys = memoria::with_memory(&sys, &repo, &prompt); // cérebro do projeto
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "json".to_string(),
        "--append-system-prompt".to_string(),
        sys,
        "--allowedTools".to_string(),
        "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*)".to_string(),
    ];
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(m);
    }
    if let Some(sid) = &session_id {
        if !sid.is_empty() {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }
    }
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    let out = output_stoppable(cmd, 300, &ORQ_CHAT_PID, "ORQ_CHAT_STOPPED")?;
    let v = claude_json(&out)?;
    Ok(AiChat {
        text: v["result"].as_str().unwrap_or("").to_string(),
        session_id: v["session_id"].as_str().unwrap_or("").to_string(),
    })
}

/// Publica a release (zip portátil + latest.json) no canal do time usando a
/// SESSÃO logada do app — nada de senha em env. Só funciona na instalação dev
/// (CARDUME_CLI aponta pro fonte, onde vive o dist/).
#[tauri::command(async)]
fn publish_release(url: String, anon: String, token: String, notes: Option<String>) -> Result<String, String> {
    let cli = std::env::var("CARDUME_CLI").map_err(|_| "só a instalação de desenvolvimento publica releases")?;
    // CARDUME_CLI → .../src/cli.ts → raiz do produto
    let root = PathBuf::from(&cli).parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()).ok_or("CARDUME_CLI inesperado")?;
    let zip = root.join("dist").join("Starfork-portable.zip");
    let bin = root.join("dist").join("Starfork-portable.app").join("Contents").join("MacOS").join("Starfork");
    if !zip.exists() { return Err(format!("rode scripts/package-app.sh antes — sem {}", zip.display())); }
    let mtime_ms = |p: &PathBuf| -> Option<i64> {
        std::fs::metadata(p).and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
    };
    let build_ms = mtime_ms(&bin).ok_or("binário do portable não encontrado")?;
    // GUARD: se o app DEV (deploy-local) é bem mais novo que o portable, o pacote
    // está DEFASADO — publicar mandaria um build velho pros colegas. Barra.
    let dev_bin = root.join("dist").join("Starfork.app").join("Contents").join("MacOS").join("Starfork");
    let old_dev_bin = root.join("dist").join("Constellation.app").join("Contents").join("MacOS").join("Constellation");
    if let Some(dev_ms) = mtime_ms(&dev_bin).or_else(|| mtime_ms(&old_dev_bin)) {
        // 30min de folga: ignora o skew de reempacotar+redeploy na mesma sessão,
        // mas pega o caso real (portable de dias atrás, esquecido).
        if dev_ms > build_ms + 1_800_000 {
            return Err("o pacote portable está DEFASADO (seu build atual é bem mais novo) — rode `scripts/package-app.sh` pra reempacotar com o código de agora ANTES de publicar, senão os colegas recebem uma versão antiga.".to_string());
        }
    }
    let size = std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    // 1) zip — primeiro com o nome novo e, em seguida, com o antigo (Constellation-portable.zip):
    // clientes de antes do rename (ou links velhos) continuam achando o release.
    // Só o Starfork-portable.zip pode falhar a publicação; o alias antigo é best-effort.
    let mut warn = String::new();
    for name in ["Starfork-portable.zip", "Constellation-portable.zip"] {
        let mut c1 = Command::new("curl");
        c1.args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
            "-H", &format!("apikey: {anon}"), "-H", &format!("Authorization: Bearer {token}"),
            "-H", "x-upsert: true", "-H", "Content-Type: application/zip",
            "--data-binary"]).arg(format!("@{}", zip.display()))
            .arg(format!("{url}/storage/v1/object/releases/{name}"));
        let r1 = output_timeout(c1, 300)?;
        let code1 = String::from_utf8_lossy(&r1.stdout).trim().to_string();
        if code1 != "200" {
            if name == "Starfork-portable.zip" { return Err(format!("upload do {name} falhou (HTTP {code1}) — você é o owner do canal?")); }
            warn = format!(" · aviso: alias {name} não subiu (HTTP {code1})");
        }
    }
    // 2) latest.json
    let d = build_ms / 1000;
    let version = {
        let out = Command::new("date").args(["-r", &d.to_string(), "+%d/%m %H:%M"]).output().map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let meta = serde_json::json!({
        "buildMs": build_ms, "version": version, "file": "Starfork-portable.zip",
        "size": size, "notes": notes.unwrap_or_else(|| "Melhorias e correções.".into()),
        "publishedAt": chrono_iso_now(),
    });
    let tmp = std::env::temp_dir().join("constellation-latest.json");
    std::fs::write(&tmp, meta.to_string()).map_err(|e| e.to_string())?;
    let mut c2 = Command::new("curl");
    c2.args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
        "-H", &format!("apikey: {anon}"), "-H", &format!("Authorization: Bearer {token}"),
        "-H", "x-upsert: true", "-H", "Content-Type: application/json",
        "--data-binary"]).arg(format!("@{}", tmp.display()))
        .arg(format!("{url}/storage/v1/object/releases/latest.json"));
    let r2 = output_timeout(c2, 60)?;
    let code2 = String::from_utf8_lossy(&r2.stdout).trim().to_string();
    if code2 != "200" { return Err(format!("latest.json falhou (HTTP {code2})")); }
    Ok(format!("release {version} publicada ({:.1} MB) — os apps do time recebem o aviso de atualizar em até ~2 min{warn}", size as f64 / 1048576.0))
}
fn chrono_iso_now() -> String {
    let out = Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output().ok();
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// Memória do repo (.cardume) que SEGUE a conta do usuário — o JS sincroniza
/// com user_repo_docs na nuvem (mais novo vence, dos dois lados).
const REPO_DOCS: [&str; 5] = ["RUNBOOK.md", "HISTORY.md", "SPEC.md", "PREFS.md", "policy.json"];
#[tauri::command(async)]
fn repo_docs(state: State<AppState>) -> Result<serde_json::Value, String> {
    let repo = repo_of(&state)?;
    let name = PathBuf::from(&repo).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut docs = serde_json::Map::new();
    for d in REPO_DOCS {
        let p = PathBuf::from(&repo).join(".cardume").join(d);
        if let Ok(c) = std::fs::read_to_string(&p) {
            let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|x| x.as_millis() as i64).unwrap_or(0);
            docs.insert(d.into(), serde_json::json!({ "content": c, "mtimeMs": mtime }));
        }
    }
    Ok(serde_json::json!({ "repo": name, "path": repo, "docs": docs }))
}
#[tauri::command(async)]
fn repo_doc_write(state: State<AppState>, doc: String, content: String) -> Result<(), String> {
    if !REPO_DOCS.contains(&doc.as_str()) { return Err("doc desconhecido".into()); }
    let repo = repo_of(&state)?;
    let dir = PathBuf::from(&repo).join(".cardume");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&doc), content).map_err(|e| e.to_string())
}

/// Chaves de modelo da CONTA → cache local que os motores leem (env por task).
/// O arquivo nunca entra em repo; a nuvem (user_secrets, RLS) é a fonte.
/// Lê uma chave do ~/.constellation/llm.env (cofre de segredos da conta).
fn llm_env_get(key: &str) -> Option<String> {
    let content = std::fs::read_to_string(llm_env_path()).ok()?;
    for line in content.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix(key) {
            if let Some(v) = rest.strip_prefix('=') {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Resolve o caminho de um artefato (coletado no repo, ou AO VIVO na worktree).
/// Nome como o AGENTE cita (evidência do requirements.json, link no chat): "./.cardume/artifacts/x.png",
/// ".cardume/artifacts/<task>/x.png" → "x.png". Era a origem do "artefato não encontrado" ao clicar na prova.
fn artifact_norm_name(name: &str, task_id: &str) -> String {
    let mut n = name.trim().trim_start_matches("./");
    n = n.strip_prefix(".cardume/artifacts/").unwrap_or(n);
    if !task_id.is_empty() {
        if let Some(rest) = n.strip_prefix(task_id).and_then(|r| r.strip_prefix('/')) { n = rest; }
    }
    n.to_string()
}

fn artifact_path(state: &State<AppState>, task_id: &str, name: &str) -> Result<PathBuf, String> {
    let cited = name.trim().to_string();
    let norm = artifact_norm_name(name, task_id);
    let name = norm.as_str();
    if !artifact_name_ok(name) {
        return Err("nome de artefato inválido".into());
    }
    // worktree AO VIVO primeiro (é a versão mais nova), depois a cópia coletada
    // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
    let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(db) = db_path_now {
        if let Ok(conn) = open(&db) {
            if let Ok(wt) = conn.query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get::<_, String>(0)) {
                if !wt.is_empty() {
                    let art = PathBuf::from(&wt).join(".cardume").join("artifacts");
                    for wp in [art.join(name), art.join(task_id).join(name)] {
                        if wp.is_file() { return Ok(wp); }
                    }
                }
            }
        }
    }
    let repo = repo_of(state)?;
    let col = repo.join(".cardume").join("artifacts").join(task_id);
    // <task>/<task>/x: o agente escreveu em .cardume/artifacts/<task>/ na worktree
    // e o coletor copiou a subpasta inteira — a lista achata, aqui resolve.
    for p in [col.join(name), col.join(task_id).join(name)] {
        if p.is_file() { return Ok(p); }
    }
    Err(format!("artefato não encontrado: {cited} (ainda não foi gerado ou já foi removido)"))
}

/// Envia um artefato pro Slack (files.getUploadURLExternal → PUT → completeUploadExternal).
/// Token: SLACK_BOT_TOKEN do cofre da conta (scopes files:write + chat:write).
#[tauri::command(async)]
fn slack_send_artifact(state: State<AppState>, task_id: String, name: String, channel: String, comment: Option<String>) -> Result<String, String> {
    let token = llm_env_get("SLACK_BOT_TOKEN").ok_or("configure SLACK_BOT_TOKEN em Conta → Chaves de modelo (bot do Slack com files:write)")?;
    let path = artifact_path(&state, &task_id, &name)?;
    // nome pode ter subpasta (entregaveis/x.pdf) — no Slack vai só o arquivo
    let name = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or(name);
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    // 1) pede a URL de upload
    let mut c1 = Command::new("curl");
    c1.args(["-s", "-G", "https://slack.com/api/files.getUploadURLExternal",
        "-H", &format!("Authorization: Bearer {token}"),
        "--data-urlencode", &format!("filename={name}"),
        "--data-urlencode", &format!("length={len}")]);
    let o1 = output_timeout(c1, 30)?;
    let j1: serde_json::Value = serde_json::from_slice(&o1.stdout).map_err(|e| format!("slack step1: {e}"))?;
    if !j1["ok"].as_bool().unwrap_or(false) {
        return Err(format!("slack: {}", j1["error"].as_str().unwrap_or("getUploadURL falhou")));
    }
    let upload_url = j1["upload_url"].as_str().ok_or("sem upload_url")?.to_string();
    let file_id = j1["file_id"].as_str().ok_or("sem file_id")?.to_string();
    // 2) sobe os bytes
    let mut c2 = Command::new("curl");
    c2.args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
        &upload_url, "-F"]).arg(format!("file=@{}", path.display()));
    let o2 = output_timeout(c2, 120)?;
    let code = String::from_utf8_lossy(&o2.stdout);
    if code.trim() != "200" {
        return Err(format!("upload pro Slack falhou (HTTP {})", code.trim()));
    }
    // 3) completa (posta no canal, com comentário opcional)
    let files = serde_json::json!([{ "id": file_id, "title": name }]);
    let mut c3 = Command::new("curl");
    c3.args(["-s", "-X", "POST", "https://slack.com/api/files.completeUploadExternal",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "--data-urlencode", &format!("files={files}"),
        "--data-urlencode", &format!("channel_id={channel}")]);
    if let Some(cm) = comment.filter(|s| !s.trim().is_empty()) {
        c3.args(["--data-urlencode", &format!("initial_comment={cm}")]);
    }
    let o3 = output_timeout(c3, 30)?;
    let j3: serde_json::Value = serde_json::from_slice(&o3.stdout).map_err(|e| format!("slack step3: {e}"))?;
    if !j3["ok"].as_bool().unwrap_or(false) {
        return Err(format!("slack: {}", j3["error"].as_str().unwrap_or("completeUpload falhou")));
    }
    Ok(format!("“{name}” enviado pro Slack ✓"))
}

fn llm_env_path() -> PathBuf {
    PathBuf::from(home_dir_s()).join(".constellation").join("llm.env")
}
#[tauri::command(async)]
fn read_llm_env() -> Result<String, String> {
    Ok(std::fs::read_to_string(llm_env_path()).unwrap_or_default())
}
#[tauri::command(async)]
fn write_llm_env(content: String) -> Result<(), String> {
    let p = llm_env_path();
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// ROUTE AI: testa a conexão com o gateway alternativo (OpenAI-compatible) usando
/// a config do cofre. Prova chave + endpoint + modelo respondendo de verdade, sem
/// depender do shim (que vive no processo do motor). Não expõe a chave.
#[tauri::command(async)]
fn route_ai_ping() -> Result<String, String> {
    let key = llm_env_get("ALT_AI_KEY")
        .or_else(|| llm_env_get("LGCX_API_KEY"))
        .ok_or("configure a chave do gateway (ALT_AI_KEY ou LGCX_API_KEY) em Chaves de modelo")?;
    let base = llm_env_get("ALT_AI_BASE_URL").unwrap_or_else(|| "https://llm.logcomex.ai/v1".into());
    let base = base.trim_end_matches('/').to_string();
    let model = llm_env_get("ALT_AI_MODEL").unwrap_or_else(|| "logcomex-v2".into());
    let payload = serde_json::json!({
        "model": model, "max_tokens": 32, "stream": false,
        "messages": [{ "role": "user", "content": "responda apenas: ok" }]
    })
    .to_string();
    let mut c = Command::new("curl");
    c.args([
        "-s", "-m", "30", "-X", "POST", &format!("{base}/chat/completions"),
        "-H", &format!("Authorization: Bearer {key}"),
        "-H", "Content-Type: application/json", "-d", &payload,
    ]);
    let out = output_timeout(c, 35)?;
    let body = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| format!("resposta inesperada do gateway: {}", body.chars().take(160).collect::<String>()))?;
    if let Some(msg) = v["choices"][0]["message"]["content"].as_str() {
        Ok(format!("{} respondeu: “{}”", model, msg.trim().chars().take(60).collect::<String>()))
    } else if let Some(err) = v["error"]["message"].as_str().or_else(|| v["detail"].as_str()) {
        Err(format!("gateway recusou: {err}"))
    } else {
        Err(format!("sem resposta do gateway ({})", body.chars().take(120).collect::<String>()))
    }
}

/// SKILLS do Claude Code: lê o frontmatter (name/description) de um SKILL.md.
fn parse_skill_md(path: &std::path::Path) -> Option<(String, String)> {
    let txt = std::fs::read_to_string(path).ok()?;
    let (mut name, mut desc) = (String::new(), String::new());
    let mut in_fm = false;
    let mut collecting_desc = false; // description em bloco YAML (> ou |) → junta linhas indentadas
    for line in txt.lines() {
        let t = line.trim();
        if t == "---" {
            if !in_fm { in_fm = true; continue; } else { break; }
        }
        if !in_fm { continue; }
        if collecting_desc {
            // continuação do bloco: linha indentada e não-vazia
            if !t.is_empty() && line.starts_with(char::is_whitespace) {
                if !desc.is_empty() { desc.push(' '); }
                desc.push_str(t);
                continue;
            }
            collecting_desc = false; // fim do bloco
        }
        if let Some(v) = t.strip_prefix("name:") {
            name = v.trim().trim_matches('"').to_string();
        } else if let Some(v) = t.strip_prefix("description:") {
            let v = v.trim();
            if v.is_empty() || v == ">" || v == "|" || v == ">-" || v == "|-" || v == ">+" || v == "|+" {
                collecting_desc = true;
                desc.clear();
            } else {
                desc = v.trim_matches('"').to_string();
            }
        }
    }
    if name.is_empty() {
        name = path.parent()?.file_name()?.to_string_lossy().to_string();
    }
    Some((name, desc))
}

fn scan_skills_dir(dir: &std::path::Path, source: &str, out: &mut Vec<(String, String, String)>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let md = e.path().join("SKILL.md");
            if md.is_file() {
                if let Some((n, d)) = parse_skill_md(&md) { out.push((n, d, source.to_string())); }
            }
        }
    }
}

fn skills_json_path(state: &State<AppState>) -> Result<PathBuf, String> {
    Ok(repo_of(state)?.join(".cardume").join("skills.json"))
}

fn issue_json_path(state: &State<AppState>) -> Result<PathBuf, String> {
    Ok(repo_of(state)?.join(".cardume").join("issue.json"))
}

/// Grava a config de "criar issue ao abrir demanda" do repo (espelho local do que o time
/// compartilha na nuvem; o app mantém sincronizado). O motor lê em Orchestrator.issueContext.
#[tauri::command(async)]
fn set_issue_config(state: State<AppState>, config: serde_json::Value) -> Result<(), String> {
    let p = issue_json_path(&state)?;
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Painel de Issues: conexão genérica com um tracker (conector declarativo) =====
fn constellation_home() -> PathBuf {
    PathBuf::from(home_dir_s()).join(".constellation")
}

/// Cache local do painel de issues do time (a nuvem — issue_trackers — é a fonte;
/// sem nuvem, vale só nesta máquina). Nunca contém o VALOR de chaves.
#[tauri::command(async)]
fn tracker_local_get() -> Result<serde_json::Value, String> {
    let txt = std::fs::read_to_string(constellation_home().join("issue-tracker.json")).unwrap_or_else(|_| "null".into());
    Ok(serde_json::from_str(&txt).unwrap_or(serde_json::Value::Null))
}

#[tauri::command(async)]
fn tracker_local_set(config: serde_json::Value) -> Result<(), String> {
    let d = constellation_home();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    std::fs::write(d.join("issue-tracker.json"), serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn tracker_binds_path() -> PathBuf { constellation_home().join("tracker-secrets.json") }

fn url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(|c| c == '/' || c == '?' || c == '#').next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if host.is_empty() { None } else { Some(host.to_lowercase()) }
}

/// Vincula uma chave do cofre a UM host. O conector é compartilhado pelo time —
/// sem este vínculo LOCAL, um conector adulterado poderia mandar a chave de
/// alguém pra outro servidor. Só o humano desta máquina cria o vínculo (no painel).
#[tauri::command(async)]
fn tracker_bind_secret(name: String, host: String) -> Result<(), String> {
    let p = tracker_binds_path();
    let mut m: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&p).ok()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    m.insert(name, serde_json::Value::String(host.to_lowercase()));
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Quais chaves (só NOMES) existem no cofre local e a que host cada uma está vinculada.
#[tauri::command(async)]
fn tracker_secret_status(names: Vec<String>) -> serde_json::Value {
    let binds: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(tracker_binds_path()).ok()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut out = serde_json::Map::new();
    for n in names {
        out.insert(n.clone(), serde_json::json!({ "present": llm_env_get(&n).is_some(), "host": binds.get(&n).cloned().unwrap_or(serde_json::Value::Null) }));
    }
    serde_json::Value::Object(out)
}

/// Troca {{secret.NOME}} pelo valor do cofre — só se NOME estiver vinculado ao host do request.
fn tracker_fill_secrets(text: &str, host: &str) -> Result<String, String> {
    let binds: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(tracker_binds_path()).ok()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("{{secret.") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 9..];
        let j = after.find("}}").ok_or("placeholder {{secret.…}} mal formado")?;
        let name = after[..j].trim();
        let bound = binds.get(name).and_then(|v| v.as_str()).unwrap_or("");
        if bound != host {
            return Err(format!("SECRET_UNBOUND:{name}:{host}"));
        }
        let val = llm_env_get(name).ok_or(format!("SECRET_MISSING:{name}"))?;
        out.push_str(&val);
        rest = &after[j + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

fn curl_cfg_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t")
}

/// Executa UMA chamada HTTP do conector. A chave entra aqui (nunca no webview) e
/// vai pro curl por stdin (--config -), então não aparece em `ps`.
#[tauri::command(async)]
fn tracker_http(method: String, url: String, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let host = url_host(&url).ok_or("URL inválida")?;
    let local = host == "localhost" || host == "127.0.0.1";
    if !url.starts_with("https://") && !local { return Err("o tracker precisa ser https".into()); }
    let m = method.to_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&m.as_str()) { return Err("método inválido".into()); }
    let mut cfg = format!("url = \"{}\"\nrequest = \"{}\"\n", curl_cfg_quote(&tracker_fill_secrets(&url, &host)?), m);
    for (k, v) in headers.unwrap_or_default() {
        cfg.push_str(&format!("header = \"{}: {}\"\n", curl_cfg_quote(&k), curl_cfg_quote(&tracker_fill_secrets(&v, &host)?)));
    }
    if let Some(b) = body {
        cfg.push_str(&format!("data-binary = \"{}\"\n", curl_cfg_quote(&tracker_fill_secrets(&b, &host)?)));
    }
    // GET é idempotente: repete 1x em falha transitória (DNS/VPN trocando, conexão caindo).
    // Escrita (POST/PUT/PATCH/DELETE) nunca repete — criaria issue/comentário em dobro.
    // --compressed: as listas de issues vinham a 100 KB+ (comprimidas cabem folgadas em 30 s).
    // Teto DURO: conexão 10 s, chamada 30 s e a repetição só cabe dentro dos mesmos 30 s
    // (--retry-max-time) — antes 60 s + retry podiam somar minutos com a rede caindo (curl 28).
    let mut args: Vec<&str> = vec!["-sS", "--compressed", "--connect-timeout", "10", "--max-time", "30", "-w", "\n%{http_code}", "--config", "-"];
    if m == "GET" { args.extend(["--retry", "1", "--retry-delay", "2", "--retry-max-time", "30", "--retry-all-errors"]); }
    let mut child = Command::new("curl")
        .args(&args)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("falha ao rodar curl: {e}"))?;
    child.stdin.take().ok_or("sem stdin")?.write_all(cfg.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("rede: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let txt = String::from_utf8_lossy(&out.stdout).to_string();
    let (resp, code) = txt.rsplit_once('\n').unwrap_or((txt.as_str(), "0"));
    Ok(serde_json::json!({ "status": code.trim().parse::<u16>().unwrap_or(0), "body": resp }))
}

/// Lê a DOCUMENTAÇÃO do tracker (texto colado e/ou arquivo — PDF/MD) e devolve o
/// CONECTOR declarativo (JSON) que o painel executa. Nunca inclui valor de chave.
#[tauri::command(async)]
fn tracker_ai_build(docs: String, files: Option<Vec<String>>) -> Result<String, String> {
    let docs: String = docs.chars().take(60000).collect();
    let files: Vec<String> = files.unwrap_or_default().into_iter().filter(|f| !f.trim().is_empty()).collect();
    if docs.trim().is_empty() && files.is_empty() { return Err("cole a documentação ou escolha um arquivo".into()); }
    let mut prompt = String::from(TRACKER_AI_PROMPT);
    if !files.is_empty() { prompt.push_str(&format!("\n\nLEIA também estes arquivos de documentação (use a tool Read em CADA um; eles se complementam — junte tudo num conector só):\n{}", files.join("\n"))); }
    if !docs.trim().is_empty() { prompt.push_str(&format!("\n\nDOCUMENTAÇÃO:\n{docs}")); }
    let mut c = claude_cmd(&claude_bin());
    c.args(["-p", &prompt]);
    // sem repo aqui: sempre protegido (só lê a documentação que você escolheu)
    if !files.is_empty() { c.arg("--allowedTools").arg("Read").args(protect_args(true)).args(["--permission-mode", "bypassPermissions"]); }
    let out = c.stdin(Stdio::null()).output().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// "Nova issue" conversando (uma ou várias): roda no repo do PROJETO escolhido, PESQUISA o
/// código (só leitura) pra fechar as arestas de cada issue e devolve os rascunhos em JSON.
/// Sessão retomada a cada mensagem (mesmo padrão do planner / ai_orchestrate_chat).
#[tauri::command(async)]
fn issue_chat(state: State<AppState>, prompt: String, session_id: Option<String>, repo: Option<String>, model: Option<String>, context: String) -> Result<AiChat, String> {
    let repo = repo_or(&state, repo)?;
    let sys = format!("{}\n\nCONTEXTO DO PAINEL (JSON):\n{}", ISSUE_CHAT_PROMPT, context);
    let sys = memoria::with_memory(&sys, &repo, &prompt); // cérebro do projeto
    let mut args: Vec<String> = vec![
        "-p".to_string(), prompt,
        "--output-format".to_string(), "json".to_string(),
        "--append-system-prompt".to_string(), sys,
        "--allowedTools".to_string(),
        "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(git grep:*)".to_string(),
    ];
    args.extend(protect_args(protect_on(&repo))); // bypass ignora o allowedTools; negação vale
    args.push("--permission-mode".to_string());
    args.push("bypassPermissions".to_string());
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) { args.push("--model".to_string()); args.push(m); }
    if let Some(sid) = &session_id { if !sid.is_empty() { args.push("--resume".to_string()); args.push(sid.clone()); } }
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(&args).current_dir(&repo);
    detach_new_group(&mut cmd); // grupo próprio: o "parar" derruba o claude E o que ele tiver aberto
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    let pid = child.id() as i32;
    ISSUE_CHAT_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(600)).is_err() { signal_group(pid, procsig::KILL); }
    });
    let out = child.wait_with_output();
    let _ = tx.send(());
    let _ = watch.join();
    // só zera se ainda for o MEU pid (outra chamada pode ter começado)
    let _ = ISSUE_CHAT_PID.compare_exchange(pid, 0, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst);
    let out = out.map_err(|e| e.to_string())?;
    if out.status.code().is_none() { return Err("ISSUE_CHAT_STOPPED".into()); }
    let v = claude_json(&out)?;
    Ok(AiChat { text: v["result"].as_str().unwrap_or("").to_string(), session_id: v["session_id"].as_str().unwrap_or("").to_string() })
}

static ISSUE_CHAT_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// PARA a pesquisa em andamento da aba "Nova issue" (mata o grupo do claude).
#[tauri::command(async)]
fn issue_chat_stop() -> bool {
    let pid = ISSUE_CHAT_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 { signal_group(pid, procsig::KILL); true } else { false }
}

const ISSUE_CHAT_PROMPT: &str = r#"Você monta ISSUES pro painel do time conversando com o dev, em português, no projeto aberto nesta pasta. O dev manda UMA ideia ou uma LISTA (várias linhas = várias issues). Seu trabalho é FECHAR AS ARESTAS de cada uma antes de criar: PESQUISE o código de verdade (Read/Grep/Glob/LS, git log/show/grep) — onde isso mora, o que já existe, o que está faltando, qual a causa provável — com PARCIMÔNIA (poucas leituras direcionadas por issue, nunca varredura do repo). Você NÃO edita nada.
Para cada issue produza: title (verbo no infinitivo + objeto específico, máx 80 chars), description (2-5 frases: o problema/pedido, ONDE no código — cite arquivo:linha quando achar — e a abordagem provável), requirements (2-5 critérios de aceite VERIFICÁVEIS), goal (critério de pronto em 1 frase), assignee (SÓ se o dev disser quem é o responsável; use o nome/e-mail exatamente como ele disse ou como aparece em `people` do contexto; senão ""), priority (só se o dev disser; use um dos valores de `priorities` do contexto), type (um dos `types` do contexto — ex.: bug quando for defeito; "" se o painel não tiver tipos), open (perguntas que SÓ o dev sabe responder e que mudam o escopo; [] se fechou).
Não invente: o que o código não responde vira pergunta em `open`. Pergunte POUCO e agrupado — no `say`, faça no máximo 1-3 perguntas por rodada, as que mais mudam o escopo, dizendo de qual issue é cada uma. Se a lista tiver itens duplicados ou que já existem no painel (veja `existing` no contexto), avise no `say` e marque `"skip": true` neles.
TAMANHO DA LISTA (diga no `say`, na 1ª frase, qual caminho tomou): se as linhas forem 3 ou mais FRENTES de UMA MESMA entrega (mesmo resultado pro usuário — ex.: cadastro, login social e recuperação de senha), proponha agrupar num ÉPICO: devolva a chave opcional `epic` = {"title":"nome curto","outcome":"1 frase: pra quem, o que muda e o sinal de que funcionou","doneWhen":["3 a 6 checagens que uma PESSOA roda sem abrir nenhuma issue"]} e abra o `say` com "Épico: <título> — …"; a ordem das issues é a ordem de build (a primeira é o caminho mais fino que atravessa tudo). Bugs soltos, itens sem relação entre si ou lista curta NÃO ganham `epic` (mande `"epic":null`) e o `say` abre com "Issues soltas: …". Na dúvida, sem épico. `epic` é ESTADO COMPLETO como `issues`: enquanto o agrupamento valer, repita o objeto inteiro em TODA rodada (perguntas, respostas e lotes); só mande `"epic":null` quando decidir desagrupar. O dev pode mandar "vira épico" ou "sem épico" — obedeça e diga que trocou. Se o contexto trouxer `epicSupport:false`, ainda proponha o `epic` quando fizer sentido: o app cita o épico no corpo das issues.
Responda SEMPRE E SOMENTE com um bloco ```json: {"say":"sua fala curta em markdown","chips":["0 a 4 respostas rápidas"],"epic":null,"issues":[{"title":"","description":"","requirements":[""],"goal":"","assignee":"","priority":"","type":"","open":[""],"skip":false}],"done":false}. `issues` traz SEMPRE a lista COMPLETA e atualizada (não só o que mudou), na ordem do dev — EXCETO quando a mensagem vier marcada com [LOTE k/n]: aí devolva em `issues` SÓ as issues daquele lote (o app junta) e guarde as perguntas menos importantes em `open` em vez de encher o `say`. Lista grande = pesquisa mais enxuta por item (1-2 buscas direcionadas cada). `done` só vira true quando nenhuma issue tem `open` pendente E o dev confirmar que pode criar. Se a mensagem for saudação ou ainda não houver nada concreto, responda direto sem usar ferramentas e com "issues":[]. JSON ESTRITAMENTE VÁLIDO: dentro das strings use \\n pra quebra de linha, escape aspas, e NUNCA coloque cercas ``` dentro de `say`/`description` (pra citar caminho, label ou trecho use `crase simples`). Nada de texto fora do bloco json."#;

const TRACKER_AI_PROMPT: &str = r#"Você configura a conexão do Starfork com um painel/tracker de issues a partir da DOCUMENTAÇÃO da API dele. Responda SOMENTE um JSON válido (sem markdown, sem comentários) neste formato:
{
 "name": "nome curto do painel",
 "baseUrl": "https://…",
 "headers": {"x-api-key": "{{secret.NOME_DA_CHAVE}}"},
 "secrets": [{"name": "NOME_DA_CHAVE", "hint": "onde o humano acha essa chave"}],
 "vars": [{"name": "team", "label": "Time", "value": "valor padrão da doc, se houver", "perUser": false}, {"name": "email", "label": "Seu e-mail no tracker", "value": "", "perUser": true}],
 "ops": {
  "list": {"method": "GET", "path": "/…", "query": {"team": "{{team}}", "limit": "{{limit}}", "offset": "{{offset}}"}, "body": null, "itemsPath": "caminho.ate.o.array", "totalPath": "total ou null", "pageSize": 100},
  "create": {"method": "POST", "path": "/…", "body": {"title": "{{title}}", "description": "{{description}}"}, "resultPath": "objeto da issue criada ou vazio"},
  "updateStatus": {"method": "POST", "path": "/…", "body": {"code": "{{code}}", "status": "{{status}}", "block_reason": "{{reason}}"}},
  "assign": {"method": "POST", "path": "/…", "body": {"code": "{{code}}", "assignee_email": "{{assignee}}"}},
  "comments": null,
  "addComment": null,
  "addChild": {"method": "POST", "path": "/…/{{parent}}/…", "body": {"child": "{{child}}"}},
  "addBlockedBy": {"method": "POST", "path": "/…/{{code}}/…", "body": {"blocker": "{{blocker}}"}}
 },
 "fields": {"id": "id", "code": "code", "title": "title", "description": "description", "status": "status", "assignee": "campo com o ID de quem está com a issue ou null", "assigneeName": "campo com o NOME do responsável (ex.: assignee_name) ou null", "assigneeEmail": "campo com o e-mail do responsável ou null", "createdBy": "campo com o nome/e-mail de quem criou ou null", "priority": "priority ou null", "tags": "tags ou null", "createdAt": "created_at", "updatedAt": "updated_at", "url": "campo com link web ou null", "commentCount": "campo ou null"},
 "urlTemplate": "https://…/{{code}} se a doc der um link web por issue, senão vazio",
 "statuses": [{"id": "valor exato na API", "label": "rótulo em português", "kind": "todo|doing|blocked|done"}],
 "assigneeFormat": "email|id|name — o que a API espera em {{assignee}}",
 "priorities": ["valores aceitos em {{priority}}, na ordem da mais alta pra mais baixa; [] se a doc não listar"],
 "types": ["valores aceitos em {{type}} (ex.: task, bug); [] se não houver"],
 "notes": "1-3 frases: o que NÃO deu pra mapear (ex.: API não expõe comentários)"
}
Regras: (1) NUNCA escreva o valor real de uma chave, mesmo que apareça na doc — só {{secret.NOME}} (NOME em MAIÚSCULAS_COM_UNDERSCORE, use o nome que a doc usa). (2) Placeholders disponíveis: os "vars" que você declarar, e por operação — create: {{title}} {{description}} {{goal}} {{assignee}} {{priority}} {{type}} {{parent}} {{blockedBy}} (use {{assignee}}/{{priority}}/{{type}} no body do create SÓ se a doc aceitar responsável/prioridade/tipo na criação; {{parent}} = código/id da issue-mãe e {{blockedBy}} = códigos das issues que bloqueiam, separados por vírgula — SÓ se a API aceitar pai/bloqueio na criação; campo vazio é omitido do envio); addChild (vincular uma issue como FILHA de outra quando a hierarquia é uma chamada à parte — ex.: sub-issues, parent link; senão null): {{parent}} {{parentId}} {{child}} {{childId}}; addBlockedBy (marcar que UMA issue é bloqueada por outra, quando é chamada à parte; senão null): {{code}} {{id}} {{blocker}} {{blockerId}}; updateStatus: {{code}} {{id}} {{status}} {{reason}} ({{reason}} = motivo do bloqueio, só se a doc tiver); assign (trocar o responsável de UMA issue — só se a doc permitir; senão null): {{code}} {{id}} {{assignee}}; comments/addComment: {{code}} {{id}} {{text}}; list: {{limit}} {{offset}} {{page}}. Em path/query/body. (3) "ops.comments" (listar comentários de UMA issue: itemsPath + "fields":{"author","text","createdAt"}) e "ops.addComment" só se a doc tiver; senão null. (4) statuses na ORDEM do fluxo; kind: todo=não iniciada, doing=em andamento, blocked=bloqueada, done=concluída. (5) vars perUser=true para o que muda por pessoa (e-mail, usuário). (6) Não invente endpoint: o que a doc não cobre fica null. (7) "types": liste os valores exatos que a API aceita; se houver um tipo pra ÉPICO, o nome dele precisa conter "epic", "épico" ou "initiative" (o app reconhece pelo nome e publica a issue-mãe com ele; as filhas vão com o tipo que contém "story", "task" ou "tarefa"; sem match, vai sem tipo)."#;

/// Lista as skills disponíveis (pessoais em ~/.claude/skills + do projeto em
/// <repo>/.claude/skills), marcando quais estão ATIVAS pra este repo.
#[tauri::command(async)]
fn list_skills(state: State<AppState>) -> Result<serde_json::Value, String> {
    let home = home_dir_s();
    let mut items: Vec<(String, String, String)> = Vec::new();
    scan_skills_dir(&PathBuf::from(&home).join(".claude").join("skills"), "pessoal", &mut items);
    if let Ok(repo) = repo_of(&state) {
        scan_skills_dir(&repo.join(".claude").join("skills"), "projeto", &mut items);
    }
    // nomes ativos (do <repo>/.cardume/skills.json)
    let mut active: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(p) = skills_json_path(&state) {
        if let Ok(txt) = std::fs::read_to_string(&p) {
            if let Ok(serde_json::Value::Array(a)) = serde_json::from_str::<serde_json::Value>(&txt) {
                for it in a { if let Some(n) = it.get("name").and_then(|x| x.as_str()) { active.insert(n.to_string()); } }
            }
        }
    }
    items.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    let arr: Vec<serde_json::Value> = items.into_iter().map(|(n, d, s)| {
        let is_active = active.contains(&n);
        serde_json::json!({ "name": n, "description": d, "source": s, "active": is_active })
    }).collect();
    Ok(serde_json::json!(arr))
}

/// Grava as skills ativas do repo (o motor injeta no contexto do agente).
#[tauri::command(async)]
fn set_active_skills(state: State<AppState>, skills: serde_json::Value) -> Result<(), String> {
    let p = skills_json_path(&state)?;
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&skills).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

/// Anda a árvore procurando pastas que contêm SKILL.md (cada uma é uma skill).
fn walk_skills(dir: &std::path::Path, depth: usize, out: &mut Vec<(String, String, PathBuf)>) {
    if depth > 4 { return; }
    let md = dir.join("SKILL.md");
    if md.is_file() {
        if let Some((n, d)) = parse_skill_md(&md) { out.push((n, d, dir.to_path_buf())); }
        return; // uma skill não contém outra
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() { continue; }
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with('.') || name == "node_modules" || name == "target" { continue; }
            walk_skills(&p, depth + 1, out);
        }
    }
}

fn skill_name_ok(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
fn skills_root() -> PathBuf {
    PathBuf::from(home_dir_s()).join(".claude").join("skills")
}

/// Cria uma skill nova na biblioteca pessoal (~/.claude/skills/<nome>/SKILL.md).
#[tauri::command(async)]
fn create_skill(name: String, description: String, body: String) -> Result<String, String> {
    let n = name.trim().to_lowercase().replace(' ', "-");
    if !skill_name_ok(&n) { return Err("nome inválido — use letras, números e hífen".into()); }
    let dir = skills_root().join(&n);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let desc = description.trim().replace('\n', " ");
    let content = format!("---\nname: {n}\ndescription: {desc}\n---\n\n{}\n", body.trim());
    std::fs::write(dir.join("SKILL.md"), content).map_err(|e| e.to_string())?;
    Ok(n)
}

/// Importa uma skill colando o conteúdo do SKILL.md (o nome sai do frontmatter).
#[tauri::command(async)]
fn import_skill_md(content: String) -> Result<String, String> {
    let tmp = std::env::temp_dir().join("cardume-import-skill.md");
    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    let name = parse_skill_md(&tmp).map(|(n, _)| n).ok_or("SKILL.md inválido (sem frontmatter name)")?;
    let _ = std::fs::remove_file(&tmp);
    let n = name.trim().to_lowercase().replace(' ', "-");
    if !skill_name_ok(&n) { return Err("nome (frontmatter) inválido".into()); }
    let dir = skills_root().join(&n);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), &content).map_err(|e| e.to_string())?;
    Ok(n)
}

/// Clona um repo git e (a) sem `picks` → lista as skills achadas (dry-run);
/// (b) com `picks` → copia as escolhidas pra ~/.claude/skills/. Muitas skills
/// são distribuídas como repo (às vezes vários SKILL.md no mesmo repo).
#[tauri::command(async)]
fn git_skills(url: String, branch: Option<String>, subpath: Option<String>, picks: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git@")) {
        return Err("URL inválida (use https:// ou git@)".into());
    }
    let tmp = std::env::temp_dir().join(format!("cardume-skillrepo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let mut c = Command::new("git");
    c.args(["clone", "--depth", "1"]);
    if let Some(b) = branch.as_ref().filter(|s| !s.trim().is_empty()) { c.args(["-b", b.trim()]); }
    c.arg(&url).arg(&tmp);
    let out = output_timeout(c, 120)?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("git clone falhou: {}", String::from_utf8_lossy(&out.stderr).chars().take(220).collect::<String>()));
    }
    let base = match subpath.as_ref().filter(|s| !s.trim().is_empty()) {
        Some(sp) => tmp.join(sp.trim().trim_matches('/')),
        None => tmp.clone(),
    };
    // procura SKILL.md recursivamente (repos guardam em skills/<nome>/, document-skills/<nome>/, etc.)
    let mut found: Vec<(String, String, PathBuf)> = Vec::new();
    walk_skills(&base, 0, &mut found);
    let result = if let Some(ps) = picks.filter(|v| !v.is_empty()) {
        let root = skills_root();
        std::fs::create_dir_all(&root).ok();
        let mut done: Vec<String> = Vec::new();
        for (n, _d, dir) in &found {
            if !ps.contains(n) { continue; }
            let dst = root.join(n);
            let _ = std::fs::remove_dir_all(&dst);
            let mut cp = Command::new("cp");
            cp.arg("-R").arg(dir).arg(&dst);
            if output_timeout(cp, 60).map(|o| o.status.success()).unwrap_or(false) {
                let _ = std::fs::write(dst.join(".git-origin"), &url); // pra oferecer "atualizar" depois
                done.push(n.clone());
            }
        }
        serde_json::json!({ "imported": done })
    } else {
        serde_json::json!({ "found": found.iter().map(|(n, d, _)| serde_json::json!({"name": n, "description": d})).collect::<Vec<_>>() })
    };
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(result)
}

/// Preferências do app (não-segredos) em ~/.constellation/settings.json.
fn settings_path() -> PathBuf {
    PathBuf::from(home_dir_s()).join(".constellation").join("settings.json")
}
fn setting_get(key: &str) -> Option<String> {
    let content = std::fs::read_to_string(settings_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    match v.get(key)? {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}
#[tauri::command(async)]
fn read_settings() -> Result<String, String> {
    Ok(std::fs::read_to_string(settings_path()).unwrap_or_else(|_| "{}".into()))
}
#[tauri::command(async)]
fn write_setting(key: String, value: String) -> Result<(), String> {
    let p = settings_path();
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let mut v: serde_json::Value = std::fs::read_to_string(&p).ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !v.is_object() { v = serde_json::json!({}); }
    if let Some(obj) = v.as_object_mut() { obj.insert(key, serde_json::Value::String(value)); }
    std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())).map_err(|e| e.to_string())?;
    Ok(())
}

/// Baixa um anexo do celular (Storage task-refs) pra .cardume/refs da worktree
/// da tarefa — o agente recebe o caminho e ABRE a imagem.
#[tauri::command(async)]
fn fetch_task_ref(state: State<AppState>, task_id: String, url: String, anon: String, token: String, path: String) -> Result<String, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("sem projeto aberto")?;
    let conn = open(&db)?;
    let wt: String = conn
        .query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let base = path.rsplit('/').next().unwrap_or("anexo.jpg").to_string();
    if base.contains("..") { return Err("nome inválido".into()); }
    let dir = PathBuf::from(&wt).join(".cardume").join("refs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&base);
    let mut c = Command::new("curl");
    c.args(["-fsS", "-o"]).arg(&dest)
        .arg(format!("{url}/storage/v1/object/task-refs/{path}"))
        .args(["-H", &format!("apikey: {anon}"), "-H", &format!("Authorization: Bearer {token}")]);
    let out = output_timeout(c, 60)?;
    if !out.status.success() {
        return Err(format!("download falhou: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(format!(".cardume/refs/{base}"))
}

/// Política de obrigatoriedade DO REPO (.cardume/policy.json) — a "Definition of
/// Done" que o formulário e o motor respeitam. Sem arquivo → defaults sensatos.
/// Campos: minRequirements, proofRequired, testsRequired, docRequired, costWarn.
#[tauri::command(async)]
fn read_policy(state: State<AppState>) -> serde_json::Value {
    // devolve SÓ o que o REPO define — o JS monta a cadeia completa:
    // padrão do produto < política da ORG (nuvem) < .cardume do repo
    let mut repo_pol = serde_json::json!({});
    let mut guide = serde_json::Value::Null;
    if let Ok(repo) = repo_of(&state) {
        if let Ok(txt) = std::fs::read_to_string(PathBuf::from(&repo).join(".cardume").join("policy.json")) {
            if let Ok(user) = serde_json::from_str::<serde_json::Value>(&txt) {
                if user.is_object() { repo_pol = user; }
            }
        }
        if let Ok(g) = std::fs::read_to_string(PathBuf::from(&repo).join(".cardume").join("SPEC.md")) {
            guide = serde_json::json!(g.chars().take(1800).collect::<String>());
        }
    }
    serde_json::json!({ "repoPolicy": repo_pol, "repoGuide": guide })
}

/// Completa a SPEC da Nova demanda numa tacada só (sem conversa): pega o que o
/// humano já digitou e devolve título/objetivo/entregáveis/requisitos BEM
/// FORMADOS. Substitui o assistente lateral (frágil demais).
#[tauri::command(async)]
fn ai_spec(state: State<AppState>, title: String, objective: String, kind: String, guide: Option<String>) -> Result<serde_json::Value, String> {
    let repo = repo_of(&state)?;
    let draft = format!("Título (do humano, pode estar vazio): {title}\nDescrição/objetivo (do humano, pode estar vazio): {objective}\nTipo: {kind}");
    if title.trim().is_empty() && objective.trim().is_empty() {
        return Err("escreva pelo menos o título ou uma descrição — a IA completa o resto".into());
    }
    // guia de spec: .cardume/SPEC.md do repo vence; sem ele, vale o guia passado
    // pelo app (template da ORG ou o padrão do produto) — a IA sempre tem um norte
    let spec_guide = std::fs::read_to_string(PathBuf::from(&repo).join(".cardume").join("SPEC.md"))
        .map(|s| s.chars().take(3000).collect::<String>())
        .ok().filter(|s| !s.trim().is_empty())
        .or_else(|| guide.filter(|s| !s.trim().is_empty()).map(|s| s.chars().take(3000).collect()))
        .unwrap_or_default();
    let guide_block = if spec_guide.trim().is_empty() { String::new() } else {
        format!("\n\nGUIA DE SPEC DESTE REPO (regras do time — siga à risca; requisitos padrão daqui entram SEMPRE que se aplicarem):\n{spec_guide}\n")
    };
    // orientação ESPECÍFICA por categoria de issue — "gerar com IA" adapta ao tipo
    let kind_hint = match kind.as_str() {
        "fix" => "CATEGORIA: CORREÇÃO DE BUG. objective descreve o comportamento errado observado, onde acontece e o esperado. deliverables: a correção em si + prova (teste que falha antes e passa depois, ou print). requirements: critérios de que o bug sumiu (ex.: 'o export com +10k linhas conclui sem erro') e que nada regrediu.",
        "design" => "CATEGORIA: DESIGN/UX. objective descreve a tela/fluxo a desenhar, o público e as restrições. deliverables: o(s) artefato(s) de design (mockup navegável, especificação de estados, tokens). requirements: cobre estados vazio/carregando/erro, responsivo e acessibilidade — cada um verificável no artefato entregue. NÃO gere código.",
        "invest" => "CATEGORIA: INVESTIGAÇÃO. objective descreve o SINTOMA, onde/como reproduzir e desde quando; NÃO proponha solução. deliverables: um documento de investigação (causa-raiz com evidência) — 1 item só. requirements: 2 a 4 perguntas objetivas que a investigação PRECISA responder (ex.: 'qual query dobra a contagem no filtro hoje?').",
        "review" => "CATEGORIA: REVIEW. objective descreve o que revisar e o critério. deliverables: o parecer de review. requirements: os pontos que o review deve cobrir.",
        _ => "CATEGORIA: ENTREGA/FEATURE. deliverables são COISAS entregues (tela X, endpoint Y, doc Z), substantivos. requirements são critérios de aceite verificáveis.",
    };
    let prompt = format!(
        "Você monta a especificação de uma tarefa de engenharia a partir do rascunho do humano. Responda SOMENTE um objeto JSON (sem cerca de código, sem texto fora) com EXATAMENTE estas chaves:\n\
         {{\"title\": string, \"objective\": string, \"deliverables\": [string], \"requirements\": [string]}}\n\n\
         {kind_hint}\n\n\
         REGRAS DE QUALIDADE (obrigatórias):\n\
         - title: máx 70 caracteres, começa com verbo no infinitivo, específico.\n\
         - objective: 2 a 4 frases COMPLETAS em pt-BR — o que fazer, onde e por quê. Não copie o rascunho cru; escreva limpo.\n\
         - deliverables: itens que são COISAS entregues (substantivos), conforme a categoria acima.\n\
         - requirements: critérios VERIFICÁVEIS, cada um uma FRASE COMPLETA e independente (alguém consegue marcar ✓/✗ testando). PROIBIDO: fragmentos soltos, itens duplicando entregáveis, itens vagos tipo 'funcionar bem', itens com mais de uma exigência (quebre em dois).\n\
         - Tudo em pt-BR. NÃO invente escopo que o humano não pediu — complete e organize o que ele quis dizer.{guide_block}\n\
         Rascunho:\n{draft}"
    );
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(["-p", &prompt, "--model", "claude-haiku-4-5-20251001"]).current_dir(&repo);
    let out = output_timeout(cmd, 60)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    // parse robusto: do primeiro '{' ao último '}' (tolera lixo em volta)
    let s = raw.find('{').and_then(|a| raw.rfind('}').map(|b| &raw[a..=b])).ok_or("resposta sem JSON")?;
    let v: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("JSON inválido da IA: {e}"))?;
    // sanidade: requisitos têm que ser frases (>= 15 chars), senão descarta o item
    let clean = |arr: &serde_json::Value, min: usize| -> Vec<String> {
        arr.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| s.len() >= min && s.len() <= 200).collect()).unwrap_or_default()
    };
    Ok(serde_json::json!({
        "title": v["title"].as_str().unwrap_or("").trim(),
        "objective": v["objective"].as_str().unwrap_or("").trim(),
        "deliverables": clean(&v["deliverables"], 6),
        "requirements": clean(&v["requirements"], 15),
    }))
}

// ---------- APNs: push REAL pro iPhone (app fechado) ----------
// JWT ES256 assinado com a key .p8 da conta Apple (openssl faz a assinatura;
// aqui só convertemos DER→JOSE). Token cacheado por ~40min como a Apple pede.
fn b64url(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 { out.push(T[(n >> 6) as usize & 63] as char); }
        if chunk.len() > 2 { out.push(T[n as usize & 63] as char); }
    }
    out
}
fn der_to_jose(der: &[u8]) -> Option<[u8; 64]> {
    // SEQUENCE { INTEGER r, INTEGER s } → r||s com 32 bytes cada
    let mut i = 2usize; // 0x30 len
    if der.first() != Some(&0x30) { return None; }
    if der[1] & 0x80 != 0 { i = 2 + (der[1] & 0x7f) as usize; }
    let mut out = [0u8; 64];
    for half in 0..2 {
        if der.get(i) != Some(&0x02) { return None; }
        let l = *der.get(i + 1)? as usize;
        let mut v = &der[i + 2..i + 2 + l];
        while v.len() > 32 && v[0] == 0 { v = &v[1..]; }
        if v.len() > 32 { return None; }
        out[half * 32 + (32 - v.len())..half * 32 + 32].copy_from_slice(v);
        i += 2 + l;
    }
    Some(out)
}
static APNS_JWT: std::sync::OnceLock<std::sync::Mutex<(String, std::time::Instant)>> = std::sync::OnceLock::new();
fn apns_jwt() -> Result<String, String> {
    let cell = APNS_JWT.get_or_init(|| std::sync::Mutex::new((String::new(), std::time::Instant::now() - std::time::Duration::from_secs(3600))));
    let mut g = cell.lock().unwrap_or_else(|e| e.into_inner());
    if !g.0.is_empty() && g.1.elapsed().as_secs() < 2400 {
        return Ok(g.0.clone());
    }
    let home = home_dir_s();
    let key = std::env::var("CONSTELLATION_APNS_KEY").unwrap_or(format!("{home}/.constellation/AuthKey_AC5R9Y7ZYS.p8"));
    let kid = std::env::var("CONSTELLATION_APNS_KID").unwrap_or("AC5R9Y7ZYS".into());
    let team = std::env::var("CONSTELLATION_APNS_TEAM").unwrap_or("SUB6889LA9".into());
    if !PathBuf::from(&key).exists() {
        return Err(format!("key APNs não encontrada em {key}"));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let head = b64url(format!("{{\"alg\":\"ES256\",\"kid\":\"{kid}\"}}").as_bytes());
    let claims = b64url(format!("{{\"iss\":\"{team}\",\"iat\":{now}}}").as_bytes());
    let input = format!("{head}.{claims}");
    let tmp = std::env::temp_dir().join("apns-signing-input");
    std::fs::write(&tmp, &input).map_err(|e| e.to_string())?;
    let out = Command::new("openssl")
        .args(["dgst", "-sha256", "-sign", &key])
        .arg(&tmp)
        .output()
        .map_err(|e| format!("openssl: {e}"))?;
    if !out.status.success() {
        return Err(format!("assinatura APNs falhou: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let jose = der_to_jose(&out.stdout).ok_or("assinatura DER inesperada")?;
    let jwt = format!("{input}.{}", b64url(&jose));
    *g = (jwt.clone(), std::time::Instant::now());
    Ok(jwt)
}

/// Manda um push APNs pro device (sandbox por padrão; CONSTELLATION_APNS_PROD=1 → produção).
#[tauri::command(async)]
fn apns_push(token: String, title: String, body: String, category: Option<String>, task_id: Option<String>, question_id: Option<String>) -> Result<String, String> {
    let jwt = apns_jwt()?;
    let host = if std::env::var("CONSTELLATION_APNS_PROD").ok().as_deref() == Some("1") { "api.push.apple.com" } else { "api.sandbox.push.apple.com" };
    let payload = serde_json::json!({
        "aps": {
            "alert": { "title": title, "body": body },
            "sound": "default",
            "category": category.unwrap_or_default(),
            "thread-id": task_id.clone().unwrap_or_default(),
        },
        "taskId": task_id.unwrap_or_default(),
        "questionId": question_id.unwrap_or_default(),
    });
    let mut cmd = Command::new("curl");
    cmd.args([
        "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--http2", "-X", "POST",
        "-H", &format!("authorization: bearer {jwt}"),
        "-H", "apns-topic: dev.constellation.mobile",
        "-H", "apns-push-type: alert",
        "-H", "apns-priority: 10",
        "-d", &payload.to_string(),
        &format!("https://{host}/3/device/{token}"),
    ]);
    let out = output_timeout(cmd, 20)?;
    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if code == "200" { Ok(code) } else { Err(format!("APNs respondeu {code}")) }
}

/// Instalação de DESENVOLVIMENTO (CARDUME_CLI apontando pro fonte)? O updater
/// se esconde nela — atualizar por cima destruiria o ambiente do Douglas.
#[tauri::command(async)]
fn is_dev_install() -> bool {
    std::env::var("CARDUME_CLI").map(|v| !v.is_empty()).unwrap_or(false)
}

/// Destino do update: instala no lugar, exceto o rename único Constellation.app →
/// Starfork.app (quando o zip traz Starfork.app e esse irmão ainda não existe).
/// Bundle id igual → dados e permissões seguem.
fn update_dest(cur_app: &std::path::Path, new_app: &std::path::Path) -> PathBuf {
    let name = |p: &std::path::Path| p.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
    let sib = cur_app.with_file_name("Starfork.app");
    if name(cur_app).as_deref() == Some("Constellation.app")
        && name(new_app).as_deref() == Some("Starfork.app")
        && !sib.exists()
    {
        return sib;
    }
    cur_app.to_path_buf()
}

/// Auto-update estilo Claude: baixa o zip (URL assinada), troca o .app em
/// disco e relança. curl/ditto não aplicam quarantine → abre sem Gatekeeper.
#[tauri::command(async)]
fn apply_update(url: String) -> Result<(), String> {
    // E8: o pacote do canal é um .app zipado (ditto/cp -R) — só serve no Mac
    if !cfg!(target_os = "macos") {
        return Err("a atualização automática só existe no Mac por enquanto — baixe a versão nova em starfork.com.br".to_string());
    }
    if !url.starts_with("https://") {
        return Err("url inválida".to_string());
    }
    let tmp = std::env::temp_dir().join("constellation-update");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let zip = tmp.join("update.zip");
    let dl = Command::new("curl").args(["-fsSL", "-o"]).arg(&zip).arg(&url).output().map_err(|e| e.to_string())?;
    if !dl.status.success() {
        return Err(format!("download falhou: {}", String::from_utf8_lossy(&dl.stderr)));
    }
    let ux = Command::new("ditto").args(["-xk"]).arg(&zip).arg(&tmp).output().map_err(|e| e.to_string())?;
    if !ux.status.success() {
        return Err(format!("descompactação falhou: {}", String::from_utf8_lossy(&ux.stderr)));
    }
    // acha o .app extraído
    let new_app = std::fs::read_dir(&tmp).map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
        .ok_or("zip sem .app dentro")?;
    // bundle atual: Contents/MacOS/exe → sobe 3
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cur_app = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .ok_or("não achei o bundle atual")?.to_path_buf();
    if cur_app.extension().map(|x| x != "app").unwrap_or(true) {
        return Err("instalação não-bundle — atualize manualmente".to_string());
    }
    let dest = update_dest(&cur_app, &new_app);
    let backup = cur_app.with_extension("app.old");
    let _ = std::fs::remove_dir_all(&backup);
    std::fs::rename(&cur_app, &backup).map_err(|e| format!("não consegui mover o app atual: {e}"))?;
    let cp = Command::new("cp").arg("-R").arg(&new_app).arg(&dest).output().map_err(|e| e.to_string())?;
    if !cp.status.success() {
        if dest != cur_app { let _ = std::fs::remove_dir_all(&dest); }
        let _ = std::fs::rename(&backup, &cur_app); // rollback
        return Err(format!("cópia falhou: {}", String::from_utf8_lossy(&cp.stderr)));
    }
    let _ = std::fs::remove_dir_all(&backup);
    let _ = std::fs::remove_dir_all(&tmp);
    if dest != cur_app {
        // caminho novo: registra no LaunchServices (best-effort, igual ao deploy-local.sh)
        let _ = Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
            .arg("-f").arg(&dest).output();
    }
    // relança a versão nova e sai
    let _ = Command::new("open").arg("-n").arg(&dest).spawn();
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(600));
        std::process::exit(0);
    });
    Ok(())
}

static PROJECT_CHAT_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static ORQ_CHAT_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// PARA a resposta em andamento do Chat do projeto (mata o grupo do claude → PROJECT_CHAT_STOPPED).
#[tauri::command(async)]
fn project_chat_stop() -> Result<bool, String> { Ok(stop_slot(&PROJECT_CHAT_PID)) }

/// PARA a resposta em andamento da conversa com o orquestrador (→ ORQ_CHAT_STOPPED).
#[tauri::command(async)]
fn orq_chat_stop() -> Result<bool, String> { Ok(stop_slot(&ORQ_CHAT_PID)) }

/// Chat do PROJETO: conversa livre sobre o repo (arquitetura, dúvidas, ideias)
/// com leitura REAL do código — sem tarefa e sem editar nada. A conversa pode
/// virar tarefa depois (a UI pede a spec pro mesmo session).
#[tauri::command(async)]
fn project_chat(app: tauri::AppHandle, state: State<AppState>, prompt: String, session_id: Option<String>, model: Option<String>) -> Result<AiChat, String> {
    let repo = repo_of(&state)?;
    let sys = "Você é o copiloto do PROJETO aberto no Starfork, conversando com o dev em português. Pode e DEVE ler o código de verdade (Read/Grep/Glob, git log/show/diff) antes de afirmar qualquer coisa — nada de chutar pela memória. Você NÃO edita arquivos nem roda comandos que alterem estado: é conversa + leitura. Seja direto e específico (arquivos/linhas quando útil). Se o assunto virar trabalho concreto, diga que dá pra transformar a conversa numa tarefa pelo botão 'virar tarefa'.";
    let sys = memoria::with_memory(sys, &repo, &prompt); // cérebro do projeto: o chat não começa do zero
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--append-system-prompt".to_string(),
        sys.to_string(),
        "--allowedTools".to_string(),
        "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*)".to_string(),
    ];
    if let Some(sid) = &session_id {
        if !sid.is_empty() {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }
    }
    push_model(&mut args, &model); // IA padrão do usuário (Configurações) — antes o chat do projeto ignorava
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    // stream: cada leitura/busca vira uma linha "o que a IA está fazendo" na tela (antes: só "lendo o projeto…"
    // por minutos, parecia travado)
    run_claude_stream(&app, cmd, &PROJECT_CHAT_PID, "PROJECT_CHAT_STOPPED", 600, "project-chat-activity")
}

// ---------- revisão de arquivos da tarefa (abrir/editar/salvar) ----------
/// Tarefa que não está no state.sqlite do projeto ATIVO (apagada, de outro projeto, só na nuvem).
/// Estado legítimo: listas (arquivos/commits) devolvem vazio; o resto usa esta frase (o front não reporta).
const TASK_GONE: &str = "esta tarefa não está neste projeto (foi apagada ou pertence a outro projeto)";
/// Worktree já removida (merge/limpeza). Mandar mensagem na tarefa a recria (ensureTaskWorktree).
const WT_GONE: &str = "a cópia de trabalho desta tarefa não existe mais (já foi limpa) — mande uma mensagem na conversa da tarefa pra retomá-la e ela é recriada";
fn task_query_err(e: rusqlite::Error) -> String {
    if matches!(e, rusqlite::Error::QueryReturnedNoRows) { TASK_GONE.to_string() } else { e.to_string() }
}
fn task_wt_base(state: &State<AppState>, task_id: &str) -> Result<(PathBuf, String), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    conn.query_row("SELECT worktree, base FROM task WHERE id=?1", params![task_id], |r| {
        Ok((PathBuf::from(r.get::<_, String>(0)?), r.get::<_, String>(1)?))
    })
    .map_err(task_query_err)
}
/// Ponto de comparação REAL da tarefa: merge-base entre a base e o HEAD da
/// worktree, preferindo origin/<base>. Sem isso, se o agente mergear
/// origin/main na branch (ou a main local estiver defasada), o diff contra a
/// base local mostra TODOS os arquivos do merge como se fossem da tarefa.
fn merge_base_ref(dir: &PathBuf, base: &str, tip: &str) -> String {
    let clean = base.trim_start_matches("origin/");
    // Ponto de bifurcação da branch. PREFERE origin/<base>: é a referência estável.
    //  - tarefa EM ANDAMENTO (branch ainda não mergeada): merge-base = o fork real,
    //    então o diff mostra só o que a tarefa mexeu, mesmo que o main tenha avançado.
    //  - tarefa JÁ MERGEADA (HEAD == origin/base): merge-base = HEAD → diff rastreado
    //    vazio (correto: nada pendente; o trabalho novo aparece como untracked em task_files).
    // NUNCA cai no <base> LOCAL quando o origin resolve: a main local costuma estar
    // defasada e arrasta dezenas de arquivos do avanço do main como se fossem da tarefa.
    for cand in [format!("origin/{clean}"), clean.to_string()] {
        if let Ok(o) = Command::new("git").arg("-C").arg(dir).args(["merge-base", &cand, tip]).output() {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !s.is_empty() { return s; }
            }
        }
    }
    base.to_string()
}
fn task_diff_base(wt: &PathBuf, base: &str) -> String {
    merge_base_ref(wt, base, "HEAD")
}

fn safe_rel(path: &str) -> Result<(), String> {
    if path.starts_with('/') || path.contains("..") {
        return Err("caminho inválido".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskFile {
    path: String,
    add: i64,
    del: i64,
}

/// Arquivos alterados pela tarefa (git diff base...HEAD na worktree).
#[tauri::command(async)]
fn task_files(state: State<AppState>, task_id: String) -> Result<Vec<TaskFile>, String> {
    // tarefa de outro projeto/apagada ou worktree já limpa (merge): nada a listar — vazio, sem erro
    let (wt, base) = match task_wt_base(&state, &task_id) {
        Ok(v) => v,
        Err(e) if e == TASK_GONE => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    if !wt.is_dir() { return Ok(vec![]); }
    // diff da ÁRVORE DE TRABALHO vs base (inclui alterações NÃO-commitadas) —
    // assim os arquivos aparecem ao vivo enquanto o agente edita, antes do commit.
    let base = task_diff_base(&wt, &base);
    let out = Command::new("git")
        .arg("-C").arg(&wt)
        .args(["diff", "--numstat", &base])
        .output()
        .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() >= 3 {
            seen.insert(p[2].to_string());
            files.push(TaskFile { add: p[0].parse().unwrap_or(0), del: p[1].parse().unwrap_or(0), path: p[2].to_string() });
        }
    }
    // Arquivos NOVOS ainda não commitados (untracked) — para tarefas de design/criação
    // o deliverable é justamente o arquivo novo, e `git diff` NÃO lista untracked.
    // Sem isto, a árvore fica vazia mesmo com o agente tendo criado arquivos.
    if let Ok(o) = Command::new("git").arg("-C").arg(&wt)
        .args(["ls-files", "--others", "--exclude-standard"]).output() {
        for rel in String::from_utf8_lossy(&o.stdout).lines() {
            let rel = rel.trim();
            if rel.is_empty() || seen.contains(rel) { continue; }
            // conta linhas como adições (arquivo de texto); binário conta 0.
            let add = std::fs::read(wt.join(rel)).ok()
                .filter(|b| !b.contains(&0))
                .map(|b| b.iter().filter(|&&c| c == b'\n').count() as i64
                        + if b.last().map(|&c| c != b'\n').unwrap_or(false) { 1 } else { 0 })
                .unwrap_or(0);
            seen.insert(rel.to_string());
            files.push(TaskFile { add, del: 0, path: rel.to_string() });
        }
    }
    // Artefatos da worktree: .cardume/ é git-excluded e NUNCA aparece no diff —
    // sem isso, tarefa de design (que só escreve artefatos) mostra árvore vazia.
    // Só arquivos de texto editáveis (imagem abre pela aba Entregas).
    fn walk_artifacts(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<TaskFile>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk_artifacts(&p, root, out);
                } else {
                    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
                    if ["html", "htm", "md", "txt", "json", "csv", "svg", "yaml", "yml"].contains(&ext.as_str()) {
                        if let Ok(rel) = p.strip_prefix(root) {
                            out.push(TaskFile { add: 0, del: 0, path: format!(".cardume/artifacts/{}", rel.to_string_lossy()) });
                        }
                    }
                }
            }
        }
    }
    let art_dir = wt.join(".cardume").join("artifacts");
    if art_dir.is_dir() {
        walk_artifacts(&art_dir, &art_dir, &mut files);
    }
    // Anexos/referências da tarefa (mockup do design, specs) — também editáveis.
    let refs_dir = wt.join(".cardume").join("refs");
    if refs_dir.is_dir() {
        let before = files.len();
        walk_artifacts(&refs_dir, &refs_dir, &mut files);
        for f in files.iter_mut().skip(before) {
            f.path = f.path.replace(".cardume/artifacts/", ".cardume/refs/");
        }
    }
    Ok(files)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContent {
    content: String,
    added_lines: Vec<i64>,
}

/// Conteúdo atual do arquivo na worktree + as linhas ADICIONADAS pela tarefa
/// (pra destacar no revisor).
#[tauri::command(async)]
fn read_file(state: State<AppState>, task_id: String, path: String) -> Result<FileContent, String> {
    safe_rel(&path)?;
    let (wt, base) = task_wt_base(&state, &task_id)?;
    if !wt.is_dir() {
        // worktree limpa (tarefa mergeada/encerrada): mostra a versão da branch (ou da base) no repo
        let repo = active_repo(&state)?;
        let branch: String = open(&state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?)?
            .query_row("SELECT branch FROM task WHERE id=?1", params![task_id], |r| r.get(0))
            .unwrap_or_default();
        let clean = base.trim_start_matches("origin/").to_string();
        for rev in [branch, format!("origin/{clean}"), clean] {
            if rev.is_empty() { continue; }
            if let Ok(o) = Command::new("git").arg("-C").arg(&repo).args(["show", &format!("{rev}:{path}")]).output() {
                if o.status.success() {
                    return Ok(FileContent { content: String::from_utf8_lossy(&o.stdout).to_string(), added_lines: vec![] });
                }
            }
        }
        return Err(WT_GONE.into());
    }
    let content = std::fs::read_to_string(wt.join(&path)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { format!("o arquivo {path} não existe mais nesta cópia da tarefa (foi apagado ou renomeado)") } else { e.to_string() }
    })?;
    // linhas novas (do diff unified=0): parse dos hunks @@ -a,b +c,d @@
    let mut added: Vec<i64> = Vec::new();
    let base = task_diff_base(&wt, &base);
    if let Ok(out) = Command::new("git").arg("-C").arg(&wt).args(["diff", "--unified=0", &base, "--", &path]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("@@") {
                // formato: @@ -a,b +c,d @@
                if let Some(plus) = rest.split('+').nth(1) {
                    let seg = plus.split('@').next().unwrap_or("").trim();
                    let mut it = seg.split(',');
                    let start: i64 = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                    let count: i64 = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(1);
                    for l in start..start + count.max(if count == 0 { 0 } else { count }) {
                        if count > 0 {
                            added.push(l);
                        }
                    }
                }
            }
        }
    }
    Ok(FileContent { content, added_lines: added })
}

/// Corpo do PR escrito pela IA (Haiku) a partir do que REALMENTE aconteceu na
/// tarefa: spec + diário do agente + diff real. Best-effort — falhou/offline →
/// Err e o front usa o corpo padrão.
#[tauri::command(async)]
fn pr_body_ai(state: State<AppState>, task_id: String) -> Result<String, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("sem projeto aberto")?;
    let conn = open(&db)?;
    let spec_str: String = conn
        .query_row("SELECT spec_json FROM task WHERE id=?1", params![task_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let spec: serde_json::Value = serde_json::from_str(&spec_str).map_err(|e| e.to_string())?;
    let (wtp, base_branch) = task_wt_base(&state, &task_id)?;
    let join = |k: &str| spec[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    // diário: últimas falas RELEVANTES do agente (o que foi feito de verdade)
    let mut notes: Vec<String> = vec![];
    if let Ok(mut st) = conn.prepare(
        "SELECT substr(text,1,400) FROM event WHERE task_id=?1 AND type IN ('note','done') AND length(text)>40 AND text NOT LIKE '💬%' AND text NOT LIKE 'Você:%' AND text NOT LIKE '❓%' AND text NOT LIKE 'perguntou%' AND text NOT LIKE 'humano%' AND text NOT LIKE 'requisito adicionado%' ORDER BY id DESC LIMIT 12",
    ) {
        if let Ok(rows) = st.query_map(params![task_id], |r| r.get::<_, String>(0)) {
            notes = rows.flatten().collect();
            notes.reverse();
        }
    }
    // diff real (stat) contra a base da worktree
    let base = task_diff_base(&wtp, &base_branch);
    let stat = Command::new("git").arg("-C").arg(&wtp).args(["diff", "--stat", &base])
        .output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().rev().take(25).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    let prompt = format!(
        "Escreva o corpo de um Pull Request em MARKDOWN pt-BR, e SÓ o markdown (sem cercas, sem preâmbulo). Seções exatas:\n\
         ## O quê — 2 a 4 frases sobre o que esta entrega FAZ para o usuário/sistema (NÃO copie o pedido cru; escreva como release note).\n\
         ## O que foi feito — 3 a 7 bullets concretos do trabalho realizado (baseie no diário e no diff).\n\
         ## Como testar — 3 a 5 passos PRÁTICOS e específicos (comando de rodar a suíte UMA vez + passos manuais na UI/API com o caminho da tela). NUNCA liste arquivos de teste um a um.\n\n\
         Título: {}\nPedido original: {}\nEntregáveis:\n{}\nRequisitos:\n{}\n\nDiário do agente (mais antigo → mais novo):\n{}\n\nDiff (git --stat, fim):\n{}",
        spec["title"].as_str().unwrap_or(""),
        spec["objective"].as_str().unwrap_or("").chars().take(700).collect::<String>(),
        join("deliverables"),
        join("requirements"),
        notes.join("\n---\n").chars().take(4000).collect::<String>(),
        stat.chars().take(1500).collect::<String>(),
    );
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(["-p", &prompt, "--model", "claude-haiku-4-5-20251001"]);
    let out = output_timeout(cmd, 75)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let body = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if body.len() < 80 || !body.contains("## ") {
        return Err("corpo gerado inválido".to_string());
    }
    Ok(format!("{body}\n\n_Aberto pelo Starfork._"))
}

/// Diff unificado de UM arquivo da tarefa (tela de Revisão do redesign):
/// git diff base -- path na worktree, com contexto de 3 linhas.
#[tauri::command(async)]
fn file_diff(state: State<AppState>, task_id: String, path: String) -> Result<String, String> {
    safe_rel(&path)?;
    let (wt, base) = task_wt_base(&state, &task_id)?;
    let base = task_diff_base(&wt, &base);
    let out = Command::new("git")
        .arg("-C").arg(&wt)
        .args(["diff", "--unified=3", &base, "--", &path])
        .output()
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    // arquivo NOVO (untracked) não aparece no diff → mostra o conteúdo como adição
    if text.trim().is_empty() {
        if let Ok(content) = std::fs::read_to_string(wt.join(&path)) {
            text = content.lines().map(|l| format!("+{l}\n")).collect();
        }
    }
    Ok(text.chars().take(200_000).collect())
}

/// "Por que este arquivo": explicação REAL do que mudou neste arquivo (funções, libs, por quê),
/// gerada pela IA a partir do diff — em vez de repetir o objetivo da tarefa. Cache por
/// (tarefa, arquivo, hash do diff) em .cardume/why/, então cada versão do diff paga uma vez.
#[tauri::command(async)]
fn ai_file_why(state: State<AppState>, task_id: String, path: String) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    safe_rel(&path)?;
    let repo = repo_of(&state)?;
    let (wt, base) = task_wt_base(&state, &task_id)?;
    let base = task_diff_base(&wt, &base);
    let out = Command::new("git").arg("-C").arg(&wt).args(["diff", "--unified=3", &base, "--", &path]).output().map_err(|e| e.to_string())?;
    let mut diff = String::from_utf8_lossy(&out.stdout).to_string();
    if diff.trim().is_empty() {
        if let Ok(content) = std::fs::read_to_string(wt.join(&path)) { diff = content.lines().map(|l| format!("+{l}\n")).collect(); }
    }
    if diff.trim().is_empty() { return Ok(String::new()); }
    let (objective, title): (String, String) = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
        let conn = open(&db)?;
        conn.query_row("SELECT objective, title FROM task WHERE id=?1", params![task_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?
    };
    // o bloco de contexto do orquestrador não é "objetivo" — fica fora do prompt e da tela
    let objective = objective.split("[PLANO DO ORQUESTRADOR").next().unwrap_or("").trim().to_string();
    let mut hp = std::collections::hash_map::DefaultHasher::new(); path.hash(&mut hp);
    let mut hd = std::collections::hash_map::DefaultHasher::new(); diff.hash(&mut hd);
    let key = format!("{:016x}-{:016x}", hp.finish(), hd.finish());
    let dir = repo.join(".cardume").join("why").join(&task_id);
    let _ = std::fs::create_dir_all(&dir);
    let cache = dir.join(format!("{key}.md"));
    if let Ok(md) = std::fs::read_to_string(&cache) { if !md.trim().is_empty() { return Ok(md); } }
    let diff_cut: String = diff.chars().take(60_000).collect();
    let prompt = format!(
        "Você explica, para o dono do produto, O QUE FOI FEITO NESTE ARQUIVO e POR QUÊ, a partir do diff abaixo. Responda em português, SOMENTE em Markdown curto, sem título, com esta estrutura:\n\
         **O que mudou** — 3 a 7 bullets concretos: cada função/classe/método criado ou alterado (pelo nome), o que cada um faz, bibliotecas/módulos novos usados, mudanças de assinatura/comportamento.\n\
         **Por quê** — 1 a 2 frases ligando as mudanças ao objetivo da tarefa.\n\
         **Atenção** — (só se houver) riscos, TODOs ou pontos que merecem revisão.\n\
         PROIBIDO repetir o objetivo da tarefa, falar do 'plano' ou generalizar ('foram feitas melhorias'). Cite nomes reais do diff.\n\n\
         Tarefa: {title}\nObjetivo: {objective}\nArquivo: {path}\n\nDIFF:\n```\n{diff_cut}\n```",
    );
    let out = claude_cmd(&claude_bin())
        .args(["-p", &prompt, "--model", "claude-sonnet-5"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    let md = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let _ = std::fs::write(&cache, &md);
    Ok(md)
}

/// Apaga a explicação em cache de um arquivo (botão ↻ "gerar de novo").
#[tauri::command(async)]
fn ai_file_why_reset(state: State<AppState>, task_id: String, path: String) -> Result<(), String> {
    use std::hash::{Hash, Hasher};
    safe_rel(&path)?;
    let repo = repo_of(&state)?;
    let mut hp = std::collections::hash_map::DefaultHasher::new(); path.hash(&mut hp);
    let prefix = format!("{:016x}-", hp.finish());
    if let Ok(rd) = std::fs::read_dir(repo.join(".cardume").join("why").join(&task_id)) {
        for e in rd.flatten() { if e.file_name().to_string_lossy().starts_with(&prefix) { let _ = std::fs::remove_file(e.path()); } }
    }
    Ok(())
}

/// Renomeia a branch de uma tarefa existente (git branch -m) + atualiza o DB.
#[tauri::command(async)]
fn rename_branch(state: State<AppState>, task_id: String, name: String) -> Result<String, String> {
    let clean: String = name.trim().replace(' ', "-").chars().filter(|c| c.is_ascii_alphanumeric() || "/_.-".contains(*c)).collect();
    if clean.is_empty() || clean.contains("..") || clean.starts_with('/') || clean.ends_with('/') {
        return Err("nome de branch inválido".to_string());
    }
    let (wt, _base) = task_wt_base(&state, &task_id)?;
    let out = Command::new("git").arg("-C").arg(&wt).args(["branch", "-m", &clean]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("git branch -m: {}", String::from_utf8_lossy(&out.stderr)));
    }
    // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
    let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(path) = db_path_now {
        if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
            let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
            let _ = conn.execute("UPDATE task SET branch=?1 WHERE id=?2", params![clean, task_id]);
        }
    }
    Ok(clean)
}

/// Salva o arquivo editado na worktree.
#[tauri::command(async)]
fn write_file(state: State<AppState>, task_id: String, path: String, content: String) -> Result<(), String> {
    safe_rel(&path)?;
    let (wt, _base) = task_wt_base(&state, &task_id)?;
    let full = wt.join(&path);
    if let Some(dir) = full.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&full, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre um documento de referência (.cardume/refs/) — imagem/PDF como dataURL,
/// md/txt como texto.
#[tauri::command(async)]
fn read_ref(state: State<AppState>, task_id: String, name: String) -> Result<ArtifactContent, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("nome inválido".to_string());
    }
    let (wt, _base) = task_wt_base(&state, &task_id)?;
    let path = wt.join(".cardume").join("refs").join(&name);
    if !path.is_file() {
        return Err("referência não encontrada".to_string());
    }
    let l = name.to_lowercase();
    let img = ["png", "jpg", "jpeg", "gif", "webp", "svg"].iter().any(|e| l.ends_with(&format!(".{e}")));
    if img || l.ends_with(".pdf") {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let mime = if l.ends_with(".pdf") {
            "application/pdf"
        } else if l.ends_with(".png") {
            "image/png"
        } else if l.ends_with(".jpg") || l.ends_with(".jpeg") {
            "image/jpeg"
        } else if l.ends_with(".gif") {
            "image/gif"
        } else if l.ends_with(".webp") {
            "image/webp"
        } else if l.ends_with(".svg") {
            "image/svg+xml"
        } else {
            "application/octet-stream"
        };
        Ok(ArtifactContent {
            kind: if l.ends_with(".pdf") { "pdf".to_string() } else { "image".to_string() },
            text: None,
            data_url: Some(format!("data:{};base64,{}", mime, base64_encode(&bytes))),
        })
    } else {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(ArtifactContent { kind: "doc".to_string(), text: Some(text), data_url: None })
    }
}

// ---------- integração com Pull Requests (GitHub via gh) ----------
fn task_branch(state: &State<AppState>, task_id: &str) -> Result<String, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    conn.query_row("SELECT branch FROM task WHERE id=?1", params![task_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())
}
/// Head que realmente tem PR: a branch atual — ou, se ela foi RENOMEADA depois
/// do push (ex.: agent/... → feat/FND-853-...), o nome remoto antigo, que
/// sobrevive no upstream. (Sem isso, PR aberto "some" da UI após o rename.)
fn pr_head(state: &State<AppState>, task_id: &str) -> Result<(PathBuf, String), String> {
    let repo = repo_of(state)?;
    let branch = task_branch(state, task_id)?;
    let mut cands = vec![branch.clone()];
    if let Ok(o) = Command::new("git")
        .arg("-C").arg(&repo)
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{branch}@{{upstream}}")])
        .output()
    {
        if o.status.success() {
            let up = String::from_utf8_lossy(&o.stdout).trim().trim_start_matches("origin/").to_string();
            if !up.is_empty() && up != branch {
                cands.push(up);
            }
        }
    }
    let ra = gh_repo_args(&repo);
    for c in &cands {
        let mut v = Command::new(gh_bin());
        v.args(["pr", "view", c, "--json", "number"]).args(&ra).current_dir(&repo);
        if let Ok(o) = output_timeout(v, 10) {
            if o.status.success() {
                return Ok((repo, c.clone()));
            }
        }
    }
    Ok((repo, branch))
}

fn repo_slug(repo: &PathBuf) -> Result<String, String> {
    // origin via alias de ssh: o slug vem do próprio remote (o gh pode não resolver o alias)
    if let Ok((slug, true)) = github_slug_of(repo) {
        return Ok(slug);
    }
    let mut cmd = Command::new(gh_bin());
    cmd.args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).current_dir(repo);
    let out = output_timeout(cmd, 10)?;
    if !out.status.success() {
        return Err("sem repositório GitHub (gh)".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvCheck {
    name: String,
    ok: bool,
    detail: String,
    fix: String,
}

/// Preflight do ambiente: tudo que o app precisa pra rodar tarefas, com o
/// comando de correção pronto — mata a classe "cliquei e nada" pra novatos.
#[tauri::command(async)]
fn env_check() -> Vec<EnvCheck> {
    let mut out = Vec::new();
    let ver = |bin: &str, args: &[&str]| -> Option<String> {
        let mut c = Command::new(bin);
        c.args(args);
        output_timeout(c, 8).ok().filter(|o| o.status.success()).map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines().next().unwrap_or("").trim().to_string()
        })
    };
    // node >= 22.6
    let nb = node_bin();
    match ver(&nb, &["--version"]) {
        Some(v) => {
            let okv = v.trim_start_matches('v').split('.').next().and_then(|m| m.parse::<u32>().ok()).map(|m| m >= 22).unwrap_or(false);
            out.push(EnvCheck { name: "Node.js (≥22.6)".into(), ok: okv, detail: format!("{v} · {nb}"), fix: if okv { String::new() } else { "brew install node".into() } });
        }
        None => out.push(EnvCheck { name: "Node.js (≥22.6)".into(), ok: false, detail: "não encontrado".into(), fix: "brew install node".into() }),
    }
    // motor
    let cli = cli_path(&PathBuf::from(home_dir_s()));
    let cli_ok = std::path::Path::new(&cli).is_file();
    out.push(EnvCheck { name: "Motor do Starfork".into(), ok: cli_ok, detail: cli.clone(), fix: if cli_ok { String::new() } else { "reinstale o app (o motor vai dentro dele)".into() } });
    // git
    match ver("git", &["--version"]) {
        Some(v) => out.push(EnvCheck { name: "Git".into(), ok: true, detail: v, fix: String::new() }),
        None => out.push(EnvCheck { name: "Git".into(), ok: false, detail: "não encontrado".into(), fix: "xcode-select --install".into() }),
    }
    // claude CLI
    let cb = claude_bin();
    match ver(&cb, &["--version"]) {
        Some(v) => out.push(EnvCheck { name: "Claude Code".into(), ok: true, detail: format!("{v} · {cb} — se a 1ª tarefa falhar por login, rode `claude` uma vez"), fix: String::new() }),
        None => out.push(EnvCheck { name: "Claude Code".into(), ok: false, detail: "não encontrado".into(), fix: "npm install -g @anthropic-ai/claude-code && claude".into() }),
    }
    // gh autenticado
    let gb = gh_bin();
    let mut ghc = Command::new(&gb);
    ghc.args(["auth", "status"]);
    match output_timeout(ghc, 8) {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stderr).to_string() + &String::from_utf8_lossy(&o.stdout);
            let acct = s.lines().find(|l| l.contains("account")).unwrap_or("autenticado").trim().to_string();
            out.push(EnvCheck { name: "GitHub CLI (gh)".into(), ok: true, detail: acct, fix: String::new() });
        }
        Ok(_) => out.push(EnvCheck { name: "GitHub CLI (gh)".into(), ok: false, detail: "instalado mas SEM login".into(), fix: "gh auth login".into() }),
        Err(_) => out.push(EnvCheck { name: "GitHub CLI (gh)".into(), ok: false, detail: "não encontrado".into(), fix: "brew install gh && gh auth login".into() }),
    }
    // opcional: túnel do preview pro celular. Sem ele o app funciona 100% —
    // só o botão de abrir o preview no celular fica indisponível.
    let cf = ["/opt/homebrew/bin/cloudflared", "/opt/homebrew/opt/cloudflared/bin/cloudflared", "/usr/local/bin/cloudflared"]
        .iter()
        .any(|p| std::path::Path::new(p).is_file());
    out.push(EnvCheck {
        name: "Túnel do preview (opcional)".into(),
        ok: cf,
        detail: if cf { "cloudflared instalado — botão do celular disponível".into() } else { "sem cloudflared — o botão do celular no preview fica desativado (resto funciona normal)".into() },
        fix: if cf { String::new() } else { "brew install cloudflared".into() },
    });
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactRaw {
    b64: String,
    mime: String,
    size: u64,
}

/// Bytes de um artefato (base64) — pro upload de provas pro time (Storage).
#[tauri::command(async)]
fn read_artifact_raw(state: State<AppState>, task_id: String, name: String) -> Result<ArtifactRaw, String> {
    let path = artifact_path(&state, &task_id, &name)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let l = name.to_lowercase();
    let mime = if l.ends_with(".png") { "image/png" }
        else if l.ends_with(".jpg") || l.ends_with(".jpeg") { "image/jpeg" }
        else if l.ends_with(".webp") { "image/webp" }
        else if l.ends_with(".gif") { "image/gif" }
        else if l.ends_with(".html") || l.ends_with(".htm") { "text/html" }
        else if l.ends_with(".md") { "text/markdown" }
        else if l.ends_with(".json") { "application/json" }
        else if l.ends_with(".pdf") { "application/pdf" }
        else if l.ends_with(".txt") || l.ends_with(".log") { "text/plain" }
        else { "application/octet-stream" };
    let b64 = base64_encode(&bytes);
    Ok(ArtifactRaw { b64, mime: mime.to_string(), size: bytes.len() as u64 })
}

/// Commita o que estiver solto na worktree e faz push da branch (atualiza o PR).
#[tauri::command(async)]
fn push_task(state: State<AppState>, task_id: String) -> Result<String, String> {
    let (wt, _base) = task_wt_base(&state, &task_id)?;
    let _ = Command::new("git").arg("-C").arg(&wt).args(["add", "-A"]).output();
    let st = Command::new("git").arg("-C").arg(&wt).args(["status", "--porcelain"]).output().map_err(|e| e.to_string())?;
    let mut committed = false;
    if !String::from_utf8_lossy(&st.stdout).trim().is_empty() {
        let c = Command::new("git").arg("-C").arg(&wt).args(["commit", "-m", "ajustes via Starfork"]).output().map_err(|e| e.to_string())?;
        if !c.status.success() {
            return Err(format!("commit falhou: {}", String::from_utf8_lossy(&c.stderr)));
        }
        committed = true;
    }
    let br = Command::new("git").arg("-C").arg(&wt).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().map_err(|e| e.to_string())?;
    let branch = String::from_utf8_lossy(&br.stdout).trim().to_string();
    let p = Command::new("git").arg("-C").arg(&wt).args(["push", "-u", "origin", &branch]).output().map_err(|e| e.to_string())?;
    if !p.status.success() {
        return Err(format!("push falhou: {}", String::from_utf8_lossy(&p.stderr)));
    }
    Ok(format!("{}push da {} feito ✓", if committed { "commit + " } else { "" }, branch))
}

/// Abre um artefato da tarefa no app padrão do sistema (ex.: mockup.html no navegador).
#[tauri::command(async)]
fn open_artifact(state: State<AppState>, task_id: String, name: String) -> Result<(), String> {
    let path = artifact_path(&state, &task_id, &name)?;
    os_open(path.as_os_str()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Revela o artefato no gerenciador de arquivos (Finder no macOS), selecionando-o.
#[tauri::command(async)]
fn reveal_artifact(state: State<AppState>, task_id: String, name: String) -> Result<String, String> {
    let path = artifact_path(&state, &task_id, &name)?;
    os_reveal(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Abre uma URL no navegador do sistema (o WKWebView não abre target=_blank).
#[tauri::command(async)]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("url inválida".to_string());
    }
    os_open(std::ffi::OsStr::new(&url)).map_err(|e| format!("falha ao abrir o link: {e}"))?;
    Ok(())
}

/// Login OAuth (Google): abre a URL de autorização no navegador e espera o
/// callback num servidor local (127.0.0.1:8788). Devolve a query string do
/// callback (ex.: "code=...&..."). Fluxo PKCE — o code é trocado por sessão no JS.
#[tauri::command(async)]
fn oauth_wait_callback(authorize_url: String) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    if !authorize_url.starts_with("https://") && !authorize_url.starts_with("http://") {
        return Err("url de autorização inválida".into());
    }
    let listener = TcpListener::bind("127.0.0.1:8788")
        .map_err(|e| format!("porta 8788 ocupada — feche outra tentativa de login e tente de novo ({e})"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    // abre o navegador na tela de login do Google (via Supabase)
    let _ = os_open(std::ffi::OsStr::new(&authorize_url));
    // espera o callback (teto de 3 min)
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let path = first.split_whitespace().nth(1).unwrap_or("");
                let query = path.split('?').nth(1).unwrap_or("").to_string();
                let body = "<!doctype html><html><head><meta charset=utf-8><title>Login</title><style>body{font:16px -apple-system,system-ui,sans-serif;background:#0e1113;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0}</style></head><body><div style=\"text-align:center\"><div style=\"font-size:44px;color:#16a34a;line-height:1\">✓</div><h2 style=\"margin:14px 0 4px\">Login concluído</h2><p style=\"color:#94a3b8;margin:0\">Pode fechar esta aba e voltar pro Starfork.</p></div></body></html>";
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes(),
                );
                let _ = stream.flush();
                return Ok(query);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    return Err("o login expirou (3 min sem retorno) — tente de novo".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            Err(e) => return Err(format!("erro no servidor de login: {e}")),
        }
    }
}

/// Branches candidatas a BASE do PR (remotas, sem as agent/*).
#[tauri::command(async)]
fn list_branches(state: State<AppState>) -> Result<Vec<String>, String> {
    let repo = repo_of(&state)?;
    let out = Command::new("git")
        .arg("-C").arg(&repo)
        .args(["branch", "-r", "--format", "%(refname:short)"])
        .output()
        .map_err(|e| e.to_string())?;
    let mut set: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let b = line.trim();
        if b.is_empty() || b.contains("HEAD") {
            continue;
        }
        let name = b.strip_prefix("origin/").unwrap_or(b).to_string();
        if !name.starts_with("agent/") && !set.contains(&name) {
            set.push(name);
        }
    }
    if !set.iter().any(|b| b == "main") {
        set.insert(0, "main".to_string());
    }
    Ok(set)
}

/// URL pra criar o PR no NAVEGADOR (a branch já foi empurrada). Fallback quando o
/// `gh` do dev não enxerga o repo (sem convite/SSO) mas o navegador dele SIM.
#[tauri::command(async)]
fn pr_compare_url(state: State<AppState>, task_id: String, base: String) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let (path, _) = github_slug_of(&repo)?;
    let branch = task_branch(&state, &task_id)?;
    let b = if base.trim().is_empty() { "main" } else { base.trim() };
    Ok(format!("https://github.com/{path}/compare/{b}...{branch}?expand=1"))
}
/// Abre um PR: faz push da branch da tarefa e cria o PR (base escolhida).
#[tauri::command(async)]
fn open_pr(state: State<AppState>, task_id: String, base: String, title: String, body: String) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let branch = task_branch(&state, &task_id)?;
    // já existe PR (na branch atual OU no nome antigo pós-rename)? devolve ele
    let ra = gh_repo_args(&repo);
    if let Ok((r2, head)) = pr_head(&state, &task_id) {
        let mut v = Command::new(gh_bin());
        v.args(["pr", "view", &head, "--json", "url", "-q", ".url"]).args(&ra).current_dir(&r2);
        if let Ok(o) = output_timeout(v, 10) {
            if o.status.success() {
                let u = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !u.is_empty() {
                    return Ok(u);
                }
            }
        }
    }
    let push = Command::new("git")
        .arg("-C").arg(&repo)
        .args(["push", "-u", "origin", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !push.status.success() {
        return Err(format!("git push falhou: {}", String::from_utf8_lossy(&push.stderr)));
    }
    let out = Command::new(gh_bin())
        .args(["pr", "create", "--head", &branch, "--base", &base, "--title", &title, "--body", &body])
        .args(&ra)
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("gh indisponível: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if err.contains("already exists") {
            let u = Command::new(gh_bin()).args(["pr", "view", &branch, "--json", "url", "-q", ".url"]).args(&ra).current_dir(&repo).output().map_err(|e| e.to_string())?;
            if u.status.success() {
                return Ok(String::from_utf8_lossy(&u.stdout).trim().to_string());
            }
        }
        if let Some(r) = gh_no_repo_access(&err) {
            // GH_NO_ACCESS: → a tela cai sozinha pro PR no navegador (a branch já foi enviada)
            return Err(format!("GH_NO_ACCESS: o gh logado não enxerga {r} — o push funcionou (o git usa outra credencial). Para o app gerenciar o PR, rode `gh auth login` com a conta que tem acesso; se a org usa SSO, `gh auth refresh -h github.com -s repo` e autorize."));
        }
        return Err(format!("gh pr create: {err}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PrComment {
    path: Option<String>,
    line: Option<i64>,
    author: String,
    body: String,
    is_bot: bool,
    /// id do comentário (review inline OU conversa — este parseado da url #issuecomment-N)
    id: Option<i64>,
    /// este comentário é uma RESPOSTA a outro (thread)
    in_reply_to: Option<i64>,
    /// endereçado: thread → a última palavra começa com "✔" OU é uma RESPOSTA sua (conta do gh);
    /// conversa → um comentário POSTERIOR "✔ …" (seu/do bot, ou que cita este) fechou o assunto.
    /// Autoria sozinha nunca conta: quem revisa o próprio PR (agente commitando com a sua conta) tem os
    /// próprios comentários como pendência de verdade.
    answered: bool,
    /// thread de review marcada como resolvida no GitHub
    resolved: bool,
    /// o código comentado mudou depois (GitHub marca a thread como desatualizada)
    outdated: bool,
    /// id (node) da thread de review — resolver via GraphQL (resolveReviewThread)
    thread_id: Option<String>,
    /// autor do último comentário da thread
    last_author: String,
    /// link direto do comentário no GitHub
    url: String,
    created_at: String,
}
/// Resumo de review (APPROVED/CHANGES_REQUESTED/COMMENTED) com texto — o corpo do review.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrReview {
    id: String,
    author: String,
    body: String,
    state: String,
    submitted_at: String,
    is_bot: bool,
    url: String,
    /// o mesmo autor deu um review decisivo DEPOIS (aprovou/pediu mudanças de novo/foi dispensado):
    /// este não vale mais — um "pediu mudanças" antigo não volta pro rework
    superseded: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrInfo {
    exists: bool,
    number: i64,
    url: String,
    state: String,
    decision: String,
    mergeable: String,
    body: String,
    comments: Vec<PrComment>,
    reviews: Vec<PrReview>,
    is_draft: bool,
    merge_state_status: String,
    base_ref_name: String,
    checks_total: i64,
    checks_fail: i64,
    checks_pending: i64,
    /// login da conta do gh (quem "respondeu" as threads)
    gh_user: String,
}

fn pr_is_bot(a: &str) -> bool {
    let l = a.to_lowercase();
    l.contains("coderabbit") || l.contains("[bot]")
}

/// "Respondido" (thread de review) = a última palavra começa com ✔ (padrão das respostas do agente) OU é
/// uma RESPOSTA da sua conta. Um comentário sozinho seu NÃO está respondido: quando o agente usa a sua
/// conta e você revisa o PR dele, o seu próprio comentário é pendência (antes nascia "tratado").
fn pr_thread_answered(n_comments: usize, last_author: &str, last_body: &str, me: &str) -> bool {
    last_body.trim_start().starts_with('✔') || (n_comments > 1 && !me.is_empty() && last_author.eq_ignore_ascii_case(me))
}

/// Conversa do PR (issue comments, lista plana e cronológica): um comentário está respondido quando um
/// comentário POSTERIOR começa com "✔" E cita este (link, #id ou @autor) — o agente é instruído a colar o link. O próprio "✔ …" é resposta, não pendência. Autoria sozinha não conta.
fn pr_mark_conv_answered(conv: &mut [PrComment], me: &str) {
    let n = conv.len();
    let mut marks = vec![false; n];
    for i in 0..n {
        let c = &conv[i];
        if c.body.trim_start().starts_with('✔') {
            marks[i] = true;
            continue;
        }
        let later = |j: usize| -> bool {
            let (a, b) = (&conv[i].created_at, &conv[j].created_at);
            if !a.is_empty() && !b.is_empty() && a != b { b > a } else { j > i }
        };
        let id_tx = c.id.map(|x| x.to_string());
        let mention = format!("@{}", c.author).to_lowercase();
        marks[i] = (0..n).any(|j| {
            if j == i || !later(j) {
                return false;
            }
            let r = &conv[j];
            if !r.body.trim_start().starts_with('✔') {
                return false;
            }
            let low = r.body.to_lowercase();
            let cites = (!c.url.is_empty() && r.body.contains(&c.url))
                || id_tx.as_ref().map(|t| r.body.contains(t.as_str())).unwrap_or(false)
                || (!c.author.is_empty() && low.contains(&mention));
            // precisa CITAR este comentário: um "✔" genérico não fecha os comentários de outras pessoas
            cites
        });
    }
    for (c, m) in conv.iter_mut().zip(marks) {
        c.answered = m;
    }
}

/// reviews do `gh pr view --json reviews` → resumos com texto; marca como `superseded` o review que o mesmo
/// autor já substituiu por outro decisivo (APPROVED / CHANGES_REQUESTED / DISMISSED) depois.
fn pr_parse_reviews(arr: &serde_json::Value, url: &str) -> Vec<PrReview> {
    let mut out = vec![];
    let Some(rs) = arr.as_array() else { return out };
    let login = |r: &serde_json::Value| r["author"]["login"].as_str().unwrap_or("").to_string();
    for (i, r) in rs.iter().enumerate() {
        let body = r["body"].as_str().unwrap_or("").to_string();
        if body.trim().is_empty() {
            continue;
        }
        let author = login(r);
        let at = r["submittedAt"].as_str().unwrap_or("").to_string();
        let superseded = rs.iter().enumerate().any(|(j, o)| {
            if j == i || !login(o).eq_ignore_ascii_case(&author) {
                return false;
            }
            let decisive = matches!(o["state"].as_str().unwrap_or(""), "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED");
            let oat = o["submittedAt"].as_str().unwrap_or("");
            let after = if !at.is_empty() && !oat.is_empty() && oat != at { oat > at.as_str() } else { j > i };
            decisive && after
        });
        out.push(PrReview {
            id: r["id"].as_str().unwrap_or("").to_string(),
            is_bot: pr_is_bot(&author),
            author,
            body,
            state: r["state"].as_str().unwrap_or("").to_string(),
            submitted_at: at,
            url: url.to_string(),
            superseded,
        });
    }
    out
}

/// chave do comentário igual à da UI (prCmtKey no 21-pull-request.js): id numérico, senão autor:início do texto
fn pr_cmt_key(c: &PrComment) -> String {
    match c.id {
        Some(id) => id.to_string(),
        None => format!("{}:{}", c.author, c.body.chars().take(40).collect::<String>()),
    }
}

/// gh pr view falhou porque NÃO HÁ PR (ou o repo não tem GitHub) — isso é "sem PR", não erro de rede.
fn gh_says_no_pr(stderr: &str) -> bool {
    let l = stderr.to_lowercase();
    l.contains("no pull requests found")
        || l.contains("no open pull requests")
        || l.contains("could not find pull request")
        || l.contains("none of the git remotes")
        || l.contains("no git remotes")
        || l.contains("not a git repository")
}

/// "GraphQL: Could not resolve to a Repository with the name 'org/repo'" = a conta logada no gh NÃO
/// enxerga o repo (outra conta, sem convite, SSO não autorizado). Não é rede nem "sem PR": devolve o repo.
fn gh_no_repo_access(stderr: &str) -> Option<String> {
    let i = stderr.find("Could not resolve to a Repository")?;
    let rest = &stderr[i..];
    let name = rest.split('\'').nth(1).unwrap_or("").trim();
    Some(if name.is_empty() { "este repositório".to_string() } else { name.to_string() })
}

/// statusCheckRollup → (total, falhando, pendentes). CheckRun usa status/conclusion; StatusContext usa state.
fn pr_checks_summary(rollup: &serde_json::Value) -> (i64, i64, i64) {
    let (mut tot, mut fail, mut pend) = (0i64, 0i64, 0i64);
    if let Some(arr) = rollup.as_array() {
        for c in arr {
            tot += 1;
            let is_ctx = c["__typename"].as_str() == Some("StatusContext") || (c.get("state").is_some() && c.get("status").is_none());
            if is_ctx {
                match c["state"].as_str().unwrap_or("") {
                    "FAILURE" | "ERROR" => fail += 1,
                    "PENDING" | "EXPECTED" => pend += 1,
                    _ => {}
                }
            } else {
                let status = c["status"].as_str().unwrap_or("");
                if !status.is_empty() && status != "COMPLETED" {
                    pend += 1;
                } else {
                    match c["conclusion"].as_str().unwrap_or("") {
                        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => fail += 1,
                        _ => {}
                    }
                }
            }
        }
    }
    (tot, fail, pend)
}

/// Resposta do GraphQL reviewThreads → comentários achatados (raiz + respostas com in_reply_to).
fn pr_parse_review_threads(v: &serde_json::Value, me: &str) -> Vec<PrComment> {
    let mut out = vec![];
    let threads = &v["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"];
    let Some(ths) = threads.as_array() else { return out };
    for th in ths {
        let Some(cs) = th["comments"]["nodes"].as_array() else { continue };
        if cs.is_empty() {
            continue;
        }
        let login = |c: &serde_json::Value| c["author"]["login"].as_str().unwrap_or("").to_string();
        let last = cs.last().unwrap();
        let last_author = login(last);
        let answered = pr_thread_answered(cs.len(), &last_author, last["body"].as_str().unwrap_or(""), me);
        let resolved = th["isResolved"].as_bool().unwrap_or(false);
        let outdated = th["isOutdated"].as_bool().unwrap_or(false);
        let thread_id = th["id"].as_str().map(|s| s.to_string());
        let root_id = cs[0]["databaseId"].as_i64();
        for (i, c) in cs.iter().enumerate() {
            let body = c["body"].as_str().unwrap_or("").to_string();
            if body.trim().is_empty() {
                continue;
            }
            let author = login(c);
            out.push(PrComment {
                path: c["path"].as_str().map(|s| s.to_string()),
                line: c["line"].as_i64().or_else(|| c["originalLine"].as_i64()),
                is_bot: pr_is_bot(&author),
                author,
                body,
                id: c["databaseId"].as_i64(),
                // resposta aponta pra raiz (-1 se a raiz veio sem id: continua sendo "resposta", não vira card)
                in_reply_to: if i == 0 { None } else { Some(root_id.unwrap_or(-1)) },
                answered,
                resolved,
                outdated,
                thread_id: thread_id.clone(),
                last_author: last_author.clone(),
                url: c["url"].as_str().unwrap_or("").to_string(),
                created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    out
}

/// Login da conta do gh (cache de 10 min — a conta pode ser trocada no app).
fn gh_user_login(repo: &PathBuf) -> String {
    static CACHE: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);
    if let Some((u, at)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < std::time::Duration::from_secs(600) {
            return u.clone();
        }
    }
    let mut c = Command::new(gh_bin());
    c.args(["api", "user", "-q", ".login"]).current_dir(repo);
    match output_timeout(c, 10) {
        Ok(o) if o.status.success() => {
            let u = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !u.is_empty() {
                *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((u.clone(), std::time::Instant::now()));
            }
            u
        }
        _ => String::new(),
    }
}

/// Status do PR da tarefa: estado, decisão (aprovado/mudanças), checks, reviews e comentários
/// (conversa + threads inline com resolvido/desatualizado — inclui CodeRabbit e pessoas).
/// Falha de rede/gh vira ERRO (a UI diz "não consegui falar com o GitHub"); só "não há PR" vira exists:false.
#[tauri::command(async)]
fn pr_status(state: State<AppState>, task_id: String) -> Result<PrInfo, String> {
    let (repo, branch) = pr_head(&state, &task_id)?;
    let empty = PrInfo {
        exists: false, number: 0, url: String::new(), state: String::new(), decision: String::new(), mergeable: String::new(), body: String::new(),
        comments: vec![], reviews: vec![], is_draft: false, merge_state_status: String::new(), base_ref_name: String::new(),
        checks_total: 0, checks_fail: 0, checks_pending: 0, gh_user: String::new(),
    };
    let mut vcmd = Command::new(gh_bin());
    vcmd.args(["pr", "view", &branch, "--json", "number,url,state,reviewDecision,mergeable,body,comments,reviews,statusCheckRollup,isDraft,mergeStateStatus,baseRefName"]).args(gh_repo_args(&repo)).current_dir(&repo);
    let view = output_timeout(vcmd, 12).map_err(|e| format!("sem resposta do GitHub (gh): {e}"))?;
    if !view.status.success() {
        let err = String::from_utf8_lossy(&view.stderr).to_string();
        if gh_says_no_pr(&err) {
            return Ok(empty);
        }
        if let Some(r) = gh_no_repo_access(&err) {
            return Err(format!("GH_NO_ACCESS: a conta logada no gh não tem acesso a {r} — rode `gh auth switch` (ou `gh auth login`) com a conta que enxerga esse repositório; se a org usa SSO, `gh auth refresh -h github.com -s repo` e autorize"));
        }
        return Err(format!("gh pr view falhou: {}", err.trim()));
    }
    let v: serde_json::Value = serde_json::from_slice(&view.stdout).map_err(|e| e.to_string())?;
    let number = v["number"].as_i64().unwrap_or(0);
    let is_bot = pr_is_bot;
    let mut me = String::new();
    let mut comments: Vec<PrComment> = vec![];
    // threads inline via GraphQL: traz resolvido/desatualizado (o REST não tem) + o login da conta (viewer)
    let slug = if number > 0 { repo_slug(&repo).ok() } else { None };
    let mut got_threads = false;
    if let Some(slug) = slug.as_ref() {
        if let Some((owner, name)) = slug.split_once('/') {
            let q = "query($owner:String!,$name:String!,$num:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$num){reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:50){nodes{databaseId author{login} body path line originalLine createdAt url}}}}}}}";
            let mut gcmd = Command::new(gh_bin());
            gcmd.args(["api", "graphql", "-f", &format!("query={q}"), "-f", &format!("owner={owner}"), "-f", &format!("name={name}"), "-F", &format!("num={number}")]).current_dir(&repo);
            if let Ok(o) = output_timeout(gcmd, 15) {
                if o.status.success() {
                    if let Ok(gv) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                        if gv["data"]["repository"]["pullRequest"].is_object() {
                            me = gv["data"]["viewer"]["login"].as_str().unwrap_or("").to_string();
                            comments.extend(pr_parse_review_threads(&gv, &me));
                            got_threads = true;
                        }
                    }
                }
            }
        }
    }
    if me.is_empty() {
        me = gh_user_login(&repo);
    }
    // conversa do PR (issue comments)
    let mut conv: Vec<PrComment> = vec![];
    if let Some(arr) = v["comments"].as_array() {
        for c in arr {
            let author = c["author"]["login"].as_str().unwrap_or("").to_string();
            let body = c["body"].as_str().unwrap_or("").to_string();
            if body.trim().is_empty() {
                continue;
            }
            let url = c["url"].as_str().unwrap_or("").to_string();
            // id numérico sai da url (#issuecomment-N) — o "id" do gh aqui é node id
            let id = url.rsplit_once("#issuecomment-").and_then(|(_, n)| n.parse::<i64>().ok());
            let bot = is_bot(&author);
            conv.push(PrComment {
                // "respondido" é decidido abaixo (pr_mark_conv_answered): autoria sozinha não conta
                // minimizado no GitHub (resolvido/desatualizado/spam) não é mais pendência
                resolved: c["isMinimized"].as_bool().unwrap_or(false),
                last_author: author.clone(),
                created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
                author, body, is_bot: bot, id, url,
                ..Default::default()
            });
        }
    }
    pr_mark_conv_answered(&mut conv, &me);
    comments.splice(0..0, conv);
    // fallback: GraphQL falhou → REST antigo (sem resolvido/desatualizado; "respondido" = tem resposta)
    if !got_threads && number > 0 {
        if let Some(slug) = slug.as_ref() {
            let mut acmd = Command::new(gh_bin());
            acmd.args(["api", &format!("repos/{}/pulls/{}/comments", slug, number), "--paginate"]).current_dir(&repo);
            if let Ok(o) = output_timeout(acmd, 15) {
                if o.status.success() {
                    if let Ok(arr) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                        if let Some(a) = arr.as_array() {
                            let mut rest: Vec<PrComment> = vec![];
                            for c in a {
                                let author = c["user"]["login"].as_str().unwrap_or("").to_string();
                                let body = c["body"].as_str().unwrap_or("").to_string();
                                if body.trim().is_empty() {
                                    continue;
                                }
                                let path = c["path"].as_str().map(|s| s.to_string());
                                let line = c["line"].as_i64().or_else(|| c["original_line"].as_i64());
                                let bot = is_bot(&author);
                                rest.push(PrComment {
                                    path, line, is_bot: bot, id: c["id"].as_i64(), in_reply_to: c["in_reply_to_id"].as_i64(),
                                    last_author: author.clone(), author, body,
                                    url: c["html_url"].as_str().unwrap_or("").to_string(),
                                    created_at: c["created_at"].as_str().unwrap_or("").to_string(),
                                    ..Default::default()
                                });
                            }
                            // marca como RESPONDIDO todo comentário cuja thread tem resposta
                            let replied: std::collections::HashSet<i64> = rest.iter().filter_map(|c| c.in_reply_to).collect();
                            for c in rest.iter_mut() {
                                if let Some(cid) = c.id {
                                    if replied.contains(&cid) {
                                        c.answered = true;
                                    }
                                }
                            }
                            comments.extend(rest);
                        }
                    }
                }
            }
        }
    }
    let url = v["url"].as_str().unwrap_or("").to_string();
    // resumos de review com texto (o "request changes" com explicação não aparecia em lugar nenhum)
    let reviews: Vec<PrReview> = pr_parse_reviews(&v["reviews"], &url);
    let (checks_total, checks_fail, checks_pending) = pr_checks_summary(&v["statusCheckRollup"]);
    // PERSISTE o PR na tarefa (spec.prUrl): sem isso o link só existia "ao
    // vivo" via gh — snapshot/sync do time ficavam com pr_url nulo pra sempre.
    if !url.is_empty() {
        // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
        let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = db_path_now {
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(4000));
                if let Ok(spec_str) = conn.query_row("SELECT spec_json FROM task WHERE id=?1", params![task_id], |r| r.get::<_, String>(0)) {
                    if let Ok(mut spec) = serde_json::from_str::<serde_json::Value>(&spec_str) {
                        if spec["prUrl"].as_str() != Some(url.as_str()) {
                            spec["prUrl"] = serde_json::json!(url);
                            spec["prNumber"] = serde_json::json!(number);
                            let _ = conn.execute("UPDATE task SET spec_json=?1 WHERE id=?2", params![spec.to_string(), task_id]);
                        }
                    }
                }
            }
        }
    }
    let pr_state = v["state"].as_str().unwrap_or("").to_string();
    // Auto-sync: PR MERGEADO (inclusive fechado/mergeado no GitHub, fora do app)
    // → a tarefa vira 'merged'. Sem isto ela fica presa em 'review' pra sempre
    // depois de um merge externo. Não sobrescreve estado já terminal.
    if pr_state == "MERGED" {
        // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
        let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = db_path_now {
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(4000));
                let flipped = conn.execute(
                    "UPDATE task SET status='merged' WHERE id=?1 AND status NOT IN ('merged','done')",
                    params![task_id],
                ).unwrap_or(0);
                // worktree mergeada não serve mais — libera o disco na hora
                if flipped > 0 { if let Ok(repo) = repo_of(&state) { preview_kill(&state.procs, &task_id); remove_task_worktree(&repo, &conn, &task_id); } }
            }
        }
    }
    Ok(PrInfo {
        exists: true,
        number,
        url,
        state: pr_state,
        decision: v["reviewDecision"].as_str().unwrap_or("").to_string(),
        mergeable: v["mergeable"].as_str().unwrap_or("").to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        comments,
        reviews,
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        merge_state_status: v["mergeStateStatus"].as_str().unwrap_or("").to_string(),
        base_ref_name: v["baseRefName"].as_str().unwrap_or("").to_string(),
        checks_total,
        checks_fail,
        checks_pending,
        gh_user: me,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoCheck {
    name: String,
    ok: bool,
    detail: String,
}

// ---------- Gate de verificação: checagens do projeto (testes, lint, tipos, build) ----------
// O projeto declara as checagens em <repo>/.cardume/checks.json (Preferências do projeto →
// "Checagens antes de aprovar"). Sem arquivo, vale o que for DETECTADO na cópia da tarefa
// (package.json, Cargo.toml, pytest, go.mod). Cada checagem roda NA WORKTREE da tarefa, num
// grupo de processo próprio (detach_new_group) com tempo-limite (signal_group mata a árvore),
// e devolve exit code, duração e as últimas ~200 linhas do log — não um .txt que o agente escreveu.

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CheckDef {
    id: String,
    label: String,
    cmd: String,
    #[serde(default)]
    on: bool,
    /// de onde veio: "package.json", "Cargo.toml", "pytest", "go.mod" ou "custom"
    #[serde(default)]
    source: String,
}

/// Checagens que dá pra deduzir dos arquivos do projeto. `on` = ligada por padrão
/// (build fica desligado: costuma ser lento e o typecheck já pega o grosso).
fn detect_checks_in(dir: &Path) -> Vec<CheckDef> {
    let mut out: Vec<CheckDef> = vec![];
    let def = |id: &str, label: &str, cmd: String, on: bool, source: &str| CheckDef { id: id.into(), label: label.into(), cmd, on, source: source.into() };
    if let Ok(txt) = std::fs::read_to_string(dir.join("package.json")) {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&txt) {
            let pm = if dir.join("pnpm-lock.yaml").is_file() { "pnpm" }
                else if dir.join("yarn.lock").is_file() { "yarn" }
                else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() { "bun" }
                else { "npm" };
            let run = |s: &str| match pm {
                "pnpm" => format!("pnpm run {s}"),
                "yarn" => format!("yarn {s}"),
                "bun" => format!("bun run {s}"),
                _ => format!("npm run {s} --silent"),
            };
            let scripts = &j["scripts"];
            let has = |s: &str| scripts[s].as_str().map(|v| !v.trim().is_empty()).unwrap_or(false);
            if has("lint") { out.push(def("npm:lint", "Linter", run("lint"), true, "package.json")); }
            if let Some(tc) = ["typecheck", "type-check", "check-types", "tsc"].iter().find(|s| has(s)) {
                out.push(def("npm:typecheck", "Tipos (typecheck)", run(tc), true, "package.json"));
            }
            // o "test" que o `npm init` cria ("no test specified && exit 1") não é teste
            if has("test") && !scripts["test"].as_str().unwrap_or("").contains("no test specified") {
                out.push(def("npm:test", "Testes", run("test"), true, "package.json"));
            }
            if has("build") { out.push(def("npm:build", "Build", run("build"), false, "package.json")); }
        }
    }
    if dir.join("Cargo.toml").is_file() {
        out.push(def("cargo:test", "Testes (Rust)", "cargo test".into(), true, "Cargo.toml"));
    }
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap_or_default();
    let pytest = dir.join("pytest.ini").is_file()
        || dir.join("conftest.py").is_file()
        || read("pyproject.toml").contains("pytest")
        || read("setup.cfg").contains("[tool:pytest]")
        || read("tox.ini").contains("[pytest]");
    if pytest {
        let py = if cfg!(windows) { "python" } else { "python3" };
        out.push(def("py:pytest", "Testes (Python)", format!("{py} -m pytest -q"), true, "pytest"));
    }
    if dir.join("go.mod").is_file() {
        out.push(def("go:test", "Testes (Go)", "go test ./...".into(), true, "go.mod"));
    }
    out
}

/// Detectadas + configuração do projeto → lista final (com `on` resolvido).
/// cfg = { "enabled": { "<id>": bool }, "custom": [{ id?, label, cmd, on? }], "timeoutMin": n }
fn effective_checks(detected: &[CheckDef], cfg: &serde_json::Value) -> Vec<CheckDef> {
    let mut out: Vec<CheckDef> = detected
        .iter()
        .map(|d| CheckDef { on: cfg["enabled"][&d.id].as_bool().unwrap_or(d.on), ..d.clone() })
        .collect();
    if let Some(arr) = cfg["custom"].as_array() {
        for (i, c) in arr.iter().enumerate() {
            let cmd = c["cmd"].as_str().unwrap_or("").trim().to_string();
            if cmd.is_empty() { continue; }
            let id = c["id"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or_else(|| format!("custom:{i}"));
            let label = c["label"].as_str().map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(&cmd).to_string();
            out.push(CheckDef { id, label, cmd, on: c["on"].as_bool().unwrap_or(true), source: "custom".into() });
        }
    }
    out
}

fn checks_cfg_path(repo: &Path) -> PathBuf { repo.join(".cardume").join("checks.json") }
fn read_checks_cfg(repo: &Path) -> serde_json::Value {
    std::fs::read_to_string(checks_cfg_path(repo))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}
fn checks_timeout_secs(cfg: &serde_json::Value) -> u64 {
    cfg["timeoutMin"].as_u64().filter(|m| *m >= 1 && *m <= 120).unwrap_or(10) * 60
}

/// Últimas N linhas do log, sem cores ANSI e com cada linha limitada — memória
/// constante mesmo com teste que cospe megabytes.
struct LineTail {
    max_lines: usize,
    max_cols: usize,
    lines: std::collections::VecDeque<String>,
    total: usize,
}
impl LineTail {
    fn new(max_lines: usize, max_cols: usize) -> Self { LineTail { max_lines, max_cols, lines: Default::default(), total: 0 } }
    fn push(&mut self, raw: &str) {
        let mut s = strip_ansi(raw.trim_end_matches(['\r', '\n']));
        if s.chars().count() > self.max_cols {
            s = s.chars().take(self.max_cols).collect::<String>() + "…";
        }
        self.total += 1;
        self.lines.push_back(s);
        while self.lines.len() > self.max_lines { self.lines.pop_front(); }
    }
    fn text(&self) -> String {
        let cut = self.total.saturating_sub(self.lines.len());
        let head = if cut > 0 { format!("… ({cut} linhas antes cortadas)\n") } else { String::new() };
        head + &self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() { it.next(); if ('@'..='~').contains(&n) { break; } }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// FNV-1a 64 (estável entre versões do app — vai pro cache do front).
fn fnv64(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts { for b in p.iter() { h ^= *b as u64; h = h.wrapping_mul(0x0100_0000_01b3); } }
    h
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TaskFingerprint {
    fingerprint: String,
    head: String,
    dirty: bool,
}
/// "Versão" do código da tarefa: HEAD + (se houver) hash das mudanças não commitadas.
/// Mudou → as checagens anteriores ficam desatualizadas. `.cardume/` fica de fora
/// (relatório/prints do agente não invalidam teste).
fn wt_fingerprint(wt: &Path) -> Result<TaskFingerprint, String> {
    let git = |args: &[&str]| -> Result<Vec<u8>, String> {
        let o = Command::new("git").arg("-C").arg(wt).args(args).output().map_err(|e| e.to_string())?;
        if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).trim().to_string()); }
        Ok(o.stdout)
    };
    let head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"])?).trim().to_string();
    let st = git(&["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).cardume"])?;
    let dirty = !st.iter().all(|b| b.is_ascii_whitespace());
    let short: String = head.chars().take(12).collect();
    if !dirty {
        return Ok(TaskFingerprint { fingerprint: short, head, dirty });
    }
    let diff = git(&["diff", "HEAD", "--", ".", ":(exclude).cardume"]).unwrap_or_default();
    // untracked: o diff não mostra o conteúdo — tamanho + mtime bastam pra perceber a mudança
    let mut extra = String::new();
    for line in String::from_utf8_lossy(&st).lines() {
        if let Some(p) = line.strip_prefix("?? ") {
            if let Ok(m) = std::fs::metadata(wt.join(p.trim_matches('"'))) {
                let mt = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
                extra.push_str(&format!("{p}:{}:{mt}\n", m.len()));
            }
        }
    }
    let h = fnv64(&[&st, &diff, extra.as_bytes()]);
    Ok(TaskFingerprint { fingerprint: format!("{short}+{h:016x}"), head, dirty })
}

fn task_worktree(state: &State<AppState>, task_id: &str) -> Result<PathBuf, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("sem projeto aberto")?;
    let conn = open(&db)?;
    let wt: String = conn
        .query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get(0))
        .map_err(task_query_err)?;
    let p = PathBuf::from(&wt);
    if wt.is_empty() || !p.is_dir() {
        return Err(WT_GONE.into());
    }
    Ok(p)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    id: String,
    label: String,
    cmd: String,
    ok: bool,
    exit_code: Option<i32>,
    duration_ms: u64,
    timed_out: bool,
    stopped: bool,
    log: String,
}

/// pid do grupo da checagem em andamento por tarefa (pra "parar") + tarefas canceladas.
static CHECK_PIDS: std::sync::OnceLock<Mutex<HashMap<String, i32>>> = std::sync::OnceLock::new();
static CHECK_STOPS: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
fn check_pids() -> &'static Mutex<HashMap<String, i32>> { CHECK_PIDS.get_or_init(|| Mutex::new(HashMap::new())) }
fn check_stops() -> &'static Mutex<std::collections::HashSet<String>> { CHECK_STOPS.get_or_init(|| Mutex::new(Default::default())) }

/// PATH pras checagens: app aberto pelo Finder tem PATH mínimo — junta o node
/// resolvido (nvm incluso), Homebrew, cargo e go.
fn checks_path_env() -> String {
    let mut dirs: Vec<String> = vec![];
    if let Some(d) = Path::new(&node_bin()).parent() { dirs.push(d.display().to_string()); }
    let home = home_opt().unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin"] { dirs.push(d.into()); }
    if !home.is_empty() {
        dirs.push(format!("{home}/.cargo/bin"));
        dirs.push(format!("{home}/go/bin"));
        dirs.push(format!("{home}/.local/bin"));
    }
    let sep = if cfg!(windows) { ";" } else { ":" };
    let cur = std::env::var("PATH").unwrap_or_default();
    format!("{}{sep}{cur}", dirs.join(sep))
}

/// Roda UMA checagem no diretório, num grupo próprio; tempo-limite → mata a árvore.
fn run_one_check(task_id: &str, dir: &Path, def: &CheckDef, secs: u64) -> CheckResult {
    use std::io::BufRead;
    let started = std::time::Instant::now();
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(format!("{} 2>&1", def.cmd));
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(format!("exec 2>&1\n{}", def.cmd));
        c
    };
    // CI=1: vitest/jest/etc. rodam uma vez (sem modo watch); sem cor no log
    cmd.current_dir(dir).env("PATH", checks_path_env()).env("CI", "1").env("FORCE_COLOR", "0").env("NO_COLOR", "1");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    detach_new_group(&mut cmd);
    let fail = |msg: String, started: std::time::Instant| CheckResult {
        id: def.id.clone(), label: def.label.clone(), cmd: def.cmd.clone(), ok: false, exit_code: None,
        duration_ms: started.elapsed().as_millis() as u64, timed_out: false, stopped: false, log: msg,
    };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("não consegui rodar o comando: {e}"), started),
    };
    let pid = child.id() as i32;
    check_pids().lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.to_string(), pid);
    let tail = Arc::new(Mutex::new(LineTail::new(200, 400)));
    if let Some(out) = child.stdout.take() {
        let t2 = tail.clone();
        // a thread pode ficar presa se um neto escapar do grupo e segurar o pipe — por isso
        // NÃO é joinada: o resultado lê o que já chegou.
        std::thread::spawn(move || {
            let mut r = std::io::BufReader::new(out);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match r.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => t2.lock().unwrap_or_else(|e| e.into_inner()).push(&String::from_utf8_lossy(&buf)),
                }
            }
        });
    }
    let deadline = started + std::time::Duration::from_secs(secs);
    let (mut timed_out, mut stopped) = (false, false);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if check_stops().lock().unwrap_or_else(|e| e.into_inner()).contains(task_id) {
            stopped = true;
            signal_group(pid, procsig::KILL);
            break child.wait().ok();
        }
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            signal_group(pid, procsig::KILL);
            break child.wait().ok();
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    };
    // sobras em segundo plano (servidor de teste etc.) morrem junto com o grupo
    signal_group(pid, procsig::KILL);
    check_pids().lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
    std::thread::sleep(std::time::Duration::from_millis(150)); // últimas linhas do pipe
    let mut log = tail.lock().unwrap_or_else(|e| e.into_inner()).text();
    if timed_out { log.push_str(&format!("\n⏱ passou de {} min — a checagem foi interrompida", secs / 60)); }
    if stopped { log.push_str("\n■ interrompida por você"); }
    let exit_code = status.and_then(|s| s.code());
    CheckResult {
        id: def.id.clone(), label: def.label.clone(), cmd: def.cmd.clone(),
        ok: !timed_out && !stopped && exit_code == Some(0),
        exit_code, duration_ms: started.elapsed().as_millis() as u64, timed_out, stopped, log,
    }
}

/// Roda as checagens LIGADAS na worktree, em ordem; `on_step(i, Some(res))` depois de cada uma.
fn run_checks_in(task_id: &str, wt: &Path, defs: &[CheckDef], secs: u64, mut on_step: impl FnMut(&CheckDef, Option<&CheckResult>)) -> Vec<CheckResult> {
    check_stops().lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
    let mut out = vec![];
    for d in defs.iter().filter(|d| d.on) {
        if check_stops().lock().unwrap_or_else(|e| e.into_inner()).contains(task_id) { break; }
        on_step(d, None);
        let r = run_one_check(task_id, wt, d, secs);
        on_step(d, Some(&r));
        out.push(r);
    }
    check_stops().lock().unwrap_or_else(|e| e.into_inner()).remove(task_id);
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksConfig {
    detected: Vec<CheckDef>,
    effective: Vec<CheckDef>,
    cfg: serde_json::Value,
    file: String,
    dir: String,
}
/// Checagens do projeto: detectadas (na cópia da tarefa, se `task_id`; senão no repo)
/// + a configuração salva. O front mostra/edita; `run_checks` usa a mesma conta.
#[tauri::command(async)]
fn checks_config(state: State<AppState>, task_id: Option<String>) -> Result<ChecksConfig, String> {
    let repo = repo_of(&state)?;
    let dir = task_id.as_deref().filter(|s| !s.is_empty()).and_then(|t| task_worktree(&state, t).ok()).unwrap_or_else(|| repo.clone());
    let cfg = read_checks_cfg(&repo);
    let detected = detect_checks_in(&dir);
    let effective = effective_checks(&detected, &cfg);
    Ok(ChecksConfig { detected, effective, cfg, file: checks_cfg_path(&repo).display().to_string(), dir: dir.display().to_string() })
}

#[tauri::command(async)]
fn checks_save(state: State<AppState>, cfg: serde_json::Value) -> Result<String, String> {
    if !cfg.is_object() { return Err("configuração inválida".into()); }
    let repo = repo_of(&state)?;
    let p = checks_cfg_path(&repo);
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

#[tauri::command(async)]
fn task_fingerprint(state: State<AppState>, task_id: String) -> Result<TaskFingerprint, String> {
    wt_fingerprint(&task_worktree(&state, &task_id)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksRun {
    fingerprint: String,
    head: String,
    dirty: bool,
    at: i64,
    results: Vec<CheckResult>,
}
/// Roda as checagens ligadas do projeto na worktree da tarefa. Progresso sai no
/// evento `checks-progress` ({ taskId, id, label, phase: "start"|"done", result }).
#[tauri::command(async)]
fn run_checks(app: tauri::AppHandle, state: State<AppState>, task_id: String) -> Result<ChecksRun, String> {
    use tauri::Emitter;
    let repo = repo_of(&state)?;
    let wt = task_worktree(&state, &task_id)?;
    if check_pids().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&task_id) {
        return Err("as checagens desta tarefa já estão rodando".into());
    }
    let cfg = read_checks_cfg(&repo);
    let defs = effective_checks(&detect_checks_in(&wt), &cfg);
    let fp = wt_fingerprint(&wt)?; // ANTES de rodar: é esta versão que foi verificada
    let tid = task_id.clone();
    let results = run_checks_in(&task_id, &wt, &defs, checks_timeout_secs(&cfg), |d, r| {
        let _ = app.emit("checks-progress", serde_json::json!({ "taskId": tid, "id": d.id, "label": d.label, "phase": if r.is_some() { "done" } else { "start" }, "result": r }));
    });
    Ok(ChecksRun { fingerprint: fp.fingerprint, head: fp.head, dirty: fp.dirty, at: now_ms(), results })
}

#[tauri::command(async)]
fn run_checks_stop(task_id: String) -> bool {
    check_stops().lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.clone());
    let pid = check_pids().lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied();
    if let Some(p) = pid { signal_group(p, procsig::KILL); true } else { false }
}

/// "Aprovar mesmo assim": registra o motivo no projeto (.cardume/checks-overrides.jsonl).
#[tauri::command(async)]
fn checks_override_log(state: State<AppState>, task_id: String, reason: String, fingerprint: String, failing: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let repo = repo_of(&state)?;
    let p = repo.join(".cardume").join("checks-overrides.jsonl");
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let line = serde_json::json!({ "at": now_ms(), "taskId": task_id, "reason": reason, "fingerprint": fingerprint, "failing": failing });
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Checagens pré-PR (modal "Preparando o PR" antigo e aprovação pelo celular): agora usa
/// as MESMAS checagens do projeto (detectadas + .cardume/checks.json). Sem nenhuma → lista vazia.
#[tauri::command(async)]
fn repo_checks(state: State<AppState>, task_id: String) -> Result<Vec<RepoCheck>, String> {
    let repo = repo_of(&state)?;
    let wt = task_worktree(&state, &task_id)?;
    let cfg = read_checks_cfg(&repo);
    let defs = effective_checks(&detect_checks_in(&wt), &cfg);
    let res = run_checks_in(&task_id, &wt, &defs, checks_timeout_secs(&cfg), |_, _| {});
    Ok(res
        .into_iter()
        .map(|r| {
            let detail = if r.ok { "passou".to_string() } else {
                let lines: Vec<&str> = r.log.lines().collect();
                let tail = lines[lines.len().saturating_sub(8)..].join("\n");
                if tail.contains("os error 2") || tail.contains("not found") && r.exit_code == Some(127) {
                    format!("comando não encontrado nesta máquina ({}) — verifique o Ambiente", r.cmd)
                } else { tail.chars().take(600).collect() }
            };
            RepoCheck { name: r.label, ok: r.ok, detail }
        })
        .collect())
}

// ---------- Entrega sem código: salvar os entregáveis numa pasta do usuário ----------
/// Pasta do usuário em qualquer SO — a mesma que o motor enxerga (Node os.homedir()): no Windows
/// USERPROFILE primeiro; no macOS/Linux HOME. Antes, 11 lugares liam só o HOME: no Windows o cofre
/// (llm.env), settings.json, skills e o catálogo global caíam numa pasta RELATIVA ao diretório atual.
fn home_dir_s() -> String {
    home_opt().unwrap_or_else(|| {
        // nunca em silêncio: sem pasta do usuário, cofre/configurações iriam pra pasta atual
        eprintln!("[starfork] pasta do usuário não encontrada (HOME/USERPROFILE vazios) — usando a pasta atual");
        ".".into()
    })
}
fn home_opt() -> Option<String> {
    home_from(std::env::var("HOME").ok(), std::env::var("USERPROFILE").ok(), cfg!(windows))
}
fn home_from(home: Option<String>, profile: Option<String>, windows: bool) -> Option<String> {
    let home = home.filter(|h| !h.trim().is_empty());
    let profile = profile.filter(|p| !p.trim().is_empty());
    if windows { profile.or(home) } else { home.or(profile) }
}
/// Pasta padrão das entregas: ~/Documents/Starfork/Entregas
#[tauri::command(async)]
fn deliverables_default_dir() -> String {
    PathBuf::from(home_dir_s()).join("Documents").join("Starfork").join("Entregas").display().to_string()
}
/// Um nome de pasta seguro (sem barra, dois-pontos, ..; no máx. 80 caracteres).
fn safe_dir_component(s: &str) -> String {
    let c: String = s.chars().map(|ch| if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() { ' ' } else { ch }).collect();
    let c = c.split_whitespace().collect::<Vec<_>>().join(" ");
    let c = c.trim_matches('.').trim().chars().take(80).collect::<String>();
    if c.is_empty() { "entrega".into() } else { c }
}
/// Caminho livre: "x.pdf" já existe → "x (2).pdf".
fn free_path(p: PathBuf) -> PathBuf {
    if !p.exists() { return p; }
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for i in 2..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() { return c; }
    }
    p
}
/// Copia os artefatos da tarefa pra <base>/<sub…>/ (sub = "projeto/2026-09-27 título",
/// cada parte higienizada). Devolve a pasta final.
#[tauri::command(async)]
fn save_deliverables(state: State<AppState>, task_id: String, names: Vec<String>, base: Option<String>, sub: String) -> Result<String, String> {
    let base = base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()).unwrap_or_else(deliverables_default_dir);
    let base = if let Some(rest) = base.strip_prefix("~/") { PathBuf::from(home_dir_s()).join(rest) } else { PathBuf::from(&base) };
    if !base.is_absolute() { return Err("escolha uma pasta com o caminho completo".into()); }
    let mut dest = base;
    for part in sub.split('/').filter(|p| !p.trim().is_empty()) { dest.push(safe_dir_component(part)); }
    std::fs::create_dir_all(&dest).map_err(|e| format!("não consegui criar a pasta {}: {e}", dest.display()))?;
    let mut n = 0;
    for name in names.iter().filter(|n| n.as_str() != "requirements.json") {
        let src = artifact_path(&state, &task_id, name)?;
        let fname = Path::new(name).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| "arquivo".into());
        std::fs::copy(&src, free_path(dest.join(fname))).map_err(|e| format!("falhou copiar {name}: {e}"))?;
        n += 1;
    }
    if n == 0 { return Err("nenhum entregável pra salvar".into()); }
    Ok(dest.display().to_string())
}
/// Abre uma pasta no Finder/gerenciador de arquivos.
#[tauri::command(async)]
fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() { return Err("pasta não encontrada".into()); }
    os_open(p.as_os_str()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod checks_tests {
    use super::*;
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-checks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn detecta_scripts_do_package_json_e_ignora_test_placeholder() {
        let d = tmp("pkg");
        std::fs::write(d.join("package.json"), r#"{"scripts":{"lint":"eslint .","typecheck":"tsc --noEmit","test":"echo \"Error: no test specified\" && exit 1","build":"vite build"}}"#).unwrap();
        let c = detect_checks_in(&d);
        let ids: Vec<&str> = c.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, vec!["npm:lint", "npm:typecheck", "npm:build"]);
        assert_eq!(c[0].cmd, "npm run lint --silent");
        assert!(!c[2].on, "build desligado por padrão");
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).unwrap();
        let c = detect_checks_in(&d);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].cmd, "pnpm run test");
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn detecta_cargo_pytest_e_go() {
        let d = tmp("multi");
        std::fs::write(d.join("Cargo.toml"), "[package]\nname='x'").unwrap();
        std::fs::write(d.join("pyproject.toml"), "[tool.pytest.ini_options]\n").unwrap();
        std::fs::write(d.join("go.mod"), "module x").unwrap();
        let ids: Vec<String> = detect_checks_in(&d).into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec!["cargo:test", "py:pytest", "go:test"]);
        let vazio = tmp("vazio");
        assert!(detect_checks_in(&vazio).is_empty());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&vazio);
    }
    #[test]
    fn config_liga_desliga_e_soma_comandos_proprios() {
        let det = vec![
            CheckDef { id: "npm:lint".into(), label: "Linter".into(), cmd: "npm run lint".into(), on: true, source: "package.json".into() },
            CheckDef { id: "npm:build".into(), label: "Build".into(), cmd: "npm run build".into(), on: false, source: "package.json".into() },
        ];
        let cfg = serde_json::json!({ "enabled": { "npm:lint": false, "npm:build": true }, "custom": [ { "label": "E2E", "cmd": "npx playwright test" }, { "cmd": "  " } ] });
        let e = effective_checks(&det, &cfg);
        assert_eq!(e.len(), 3);
        assert!(!e[0].on && e[1].on);
        assert_eq!((e[2].id.as_str(), e[2].label.as_str(), e[2].on, e[2].source.as_str()), ("custom:0", "E2E", true, "custom"));
        assert_eq!(checks_timeout_secs(&cfg), 600);
        assert_eq!(checks_timeout_secs(&serde_json::json!({ "timeoutMin": 3 })), 180);
    }
    #[test]
    fn log_guarda_so_as_ultimas_linhas_sem_cor_e_cortadas() {
        let mut t = LineTail::new(200, 10);
        for i in 0..250 { t.push(&format!("linha {i}\n")); }
        let s = t.text();
        assert!(s.starts_with("… (50 linhas antes cortadas)"));
        assert!(s.ends_with("linha 249"));
        assert_eq!(s.lines().count(), 201);
        let mut t = LineTail::new(5, 10);
        t.push("\u{1b}[31mFALHOU\u{1b}[0m um teste bem comprido");
        assert_eq!(t.text(), "FALHOU um …");
    }
    #[cfg(unix)]
    #[test]
    fn roda_checagem_com_exit_code_e_mata_no_tempo_limite() {
        let d = tmp("run");
        let ok = CheckDef { id: "a".into(), label: "A".into(), cmd: "echo oi; echo erro >&2; exit 0".into(), on: true, source: "custom".into() };
        let r = run_one_check("t-test-a", &d, &ok, 30);
        assert!(r.ok);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.log.contains("oi") && r.log.contains("erro"), "stderr vai junto no log: {}", r.log);
        let bad = CheckDef { cmd: "echo quebrou; exit 3".into(), ..ok.clone() };
        let r = run_one_check("t-test-b", &d, &bad, 30);
        assert!(!r.ok);
        assert_eq!(r.exit_code, Some(3));
        let slow = CheckDef { cmd: "sleep 30".into(), ..ok.clone() };
        let t0 = std::time::Instant::now();
        let r = run_one_check("t-test-c", &d, &slow, 1);
        assert!(r.timed_out && !r.ok);
        assert!(t0.elapsed().as_secs() < 10);
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn nome_de_pasta_seguro() {
        assert_eq!(safe_dir_component("Relatório: agosto/2026?"), "Relatório agosto 2026");
        assert_eq!(safe_dir_component(".."), "entrega");
        assert_eq!(safe_dir_component("  "), "entrega");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjTaskLite {
    id: String,
    title: String,
    status: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjOverview {
    path: String,
    name: String,
    active: i64,
    review: i64,
    tasks: Vec<ProjTaskLite>,
}

/// Visão de TODOS os projetos salvos (sidebar por projeto do redesign):
/// conta sessões ativas/review lendo o state.sqlite de cada repo. Best-effort.
#[tauri::command(async)]
fn projects_overview() -> Vec<ProjOverview> {
    read_project_list()
        .iter()
        .map(|p| {
            let name = PathBuf::from(p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            let db = PathBuf::from(p).join(".cardume").join("state.sqlite");
            let mut active = 0i64;
            let mut review = 0i64;
            let mut tasks: Vec<ProjTaskLite> = vec![];
            if let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
                if let Ok(mut st) = conn.prepare(
                    "SELECT id,title,status FROM task WHERE (flag IS NULL OR flag!='closed') AND status IN ('running','thinking','queued','plan-review','error','conflict','review','delivered') ORDER BY rowid DESC LIMIT 8",
                ) {
                    if let Ok(rows) = st.query_map([], |r| {
                        Ok(ProjTaskLite { id: r.get(0)?, title: r.get(1)?, status: r.get(2)? })
                    }) {
                        for t in rows.flatten() {
                            if t.status == "review" || t.status == "delivered" { review += 1 } else { active += 1 }
                            tasks.push(t);
                        }
                    }
                }
            }
            ProjOverview { path: p.clone(), name, active, review, tasks }
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AllTask {
    id: String,
    title: String,
    status: String,
    stage: String,
    agent: String,
    flag: Option<String>,
    engine: String,
    created_at: i64,
    sort_order: Option<i64>,
    repo: String,
    proj: String,
}

/// Tarefas de TODOS os projetos salvos (board integrado). Lê o state.sqlite de
/// cada repo em read-only, best-effort — um projeto ilegível é só pulado.
#[tauri::command(async)]
fn list_all_tasks() -> Vec<AllTask> {
    let mut out: Vec<AllTask> = Vec::new();
    for p in read_project_list() {
        let name = PathBuf::from(&p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
        let db = PathBuf::from(&p).join(".cardume").join("state.sqlite");
        let conn = match Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
        let mut st = match conn.prepare("SELECT id,title,status,stage,agent,flag,engine,created_at,sort_order FROM task ORDER BY created_at") {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rows = st.query_map([], |r| {
            Ok(AllTask {
                id: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                stage: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                agent: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                flag: r.get::<_, Option<String>>(5)?.filter(|s| !s.is_empty()),
                engine: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                created_at: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                sort_order: r.get::<_, Option<i64>>(8)?,
                repo: p.clone(),
                proj: name.clone(),
            })
        });
        if let Ok(rows) = rows {
            for t in rows.flatten() { out.push(t); }
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneTask {
    id: String,
    title: String,
    objective: String,
    status: String,
    flag: Option<String>,
    branch: String,
    kind: String,
    pr_url: Option<String>,
    summary: Option<String>,
    docs: Vec<String>,
    created_at: i64,
    finished_at: i64,
    repo: String,
    proj: String,
}

/// Tarefas JÁ FEITAS de todos os projetos (entregues/mergeadas/finalizadas) — alimenta o
/// "/" da Nova demanda pra referenciar trabalho anterior. `finished_at` = último evento.
/// Best-effort como o list_all_tasks: projeto ilegível é pulado.
#[tauri::command(async)]
fn list_done_tasks() -> Vec<DoneTask> {
    let clip = |s: String, n: usize| if s.chars().count() > n { s.chars().take(n).collect::<String>() + "…" } else { s };
    let mut out: Vec<DoneTask> = Vec::new();
    for p in read_project_list() {
        let name = PathBuf::from(&p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
        let db = PathBuf::from(&p).join(".cardume").join("state.sqlite");
        let conn = match Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
        let sql = "SELECT t.id,t.title,t.objective,t.status,t.flag,t.branch,t.spec_json,t.created_at, \
                   (SELECT MAX(e.ts) FROM event e WHERE e.task_id=t.id), \
                   (SELECT r.summary FROM review r WHERE r.task_id=t.id) \
                   FROM task t WHERE (t.status IN ('merged','done','review') OR t.flag='closed') \
                   AND t.status NOT IN ('cancelled','aborted')";
        let mut st = match conn.prepare(sql) { Ok(s) => s, Err(_) => continue };
        let rows = st.query_map([], |r| {
            let spec: serde_json::Value = serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default();
            let created: i64 = r.get::<_, Option<i64>>(7)?.unwrap_or(0);
            Ok(DoneTask {
                id: r.get(0)?,
                title: r.get(1)?,
                objective: clip(r.get::<_, Option<String>>(2)?.unwrap_or_default(), 1200),
                status: r.get(3)?,
                flag: r.get::<_, Option<String>>(4)?.filter(|s| !s.is_empty()),
                branch: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                kind: spec.get("kind").and_then(|v| v.as_str()).unwrap_or("build").to_string(),
                pr_url: spec.get("prUrl").and_then(|v| v.as_str()).map(|s| s.to_string()),
                summary: r.get::<_, Option<String>>(9)?.map(|s| clip(s, 800)),
                docs: vec![],
                created_at: created,
                finished_at: r.get::<_, Option<i64>>(8)?.unwrap_or(created),
                repo: p.clone(),
                proj: name.clone(),
            })
        });
        if let Ok(rows) = rows {
            for mut t in rows.flatten() {
                // docs da entrega (ARCHITECTURE/DESIGN/INVESTIGATION…) viram anexo da tarefa nova
                let dir = PathBuf::from(&p).join(".cardume").join("artifacts").join(&t.id);
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    let mut md: Vec<String> = rd.flatten().map(|e| e.path())
                        .filter(|x| x.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false))
                        .map(|x| x.to_string_lossy().to_string()).collect();
                    md.sort();
                    md.truncate(4);
                    t.docs = md;
                }
                out.push(t);
            }
        }
    }
    out.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
    out
}

// ---------- higiene do .cardume: aprendizados ficam, entregáveis são opcionais, o resto é lixo ----------
// O que mora em <repo>/.cardume/:
//   aprendizados/estado  MEMORY.md HISTORY.md RUNBOOK.md SPEC.md PREFS.md policy.json skills.json
//                        issue.json orchestrations/ state.sqlite      → NUNCA são apagados aqui
//   entregáveis          artifacts/<tarefa>/                          → limpeza opcional (tarefas finalizadas)
//   worktrees            worktrees/<tarefa>/ reviews/<pr>/            → removidas ao mergear; as de
//                        tarefas finalizadas (merged/cancelled/aborted) e as órfãs são lixo
//   temporários          logs/ why/ tmp/                              → lixo
const CARDUME_KEEP: [&str; 11] = ["MEMORY.md", "HISTORY.md", "RUNBOOK.md", "SPEC.md", "PREFS.md", "AMBIENTE.md", "policy.json", "skills.json", "issue.json", "setup.sh", "orchestrations"];
const TASK_FINISHED: [&str; 3] = ["merged", "cancelled", "aborted"];

/// Tamanho de uma pasta (não segue symlinks — node_modules de worktree tem vários).
fn dir_size(p: &Path) -> u64 {
    let md = match std::fs::symlink_metadata(p) { Ok(m) => m, Err(_) => return 0 };
    if md.file_type().is_symlink() { return 0; }
    if md.is_file() { return md.len(); }
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.file_type().is_symlink() { continue; }
                total += if m.is_dir() { dir_size(&e.path()) } else { m.len() };
            }
        }
    }
    total
}

/// Remove a worktree de uma tarefa do disco e do registro do git. Só aceita
/// caminhos DENTRO de <repo>/.cardume/ (worktrees/ ou reviews/) — nunca o repo.
fn remove_worktree_dir(repo: &Path, wt: &Path) -> bool {
    let base = repo.join(".cardume");
    if !(wt.starts_with(base.join("worktrees")) || wt.starts_with(base.join("reviews"))) || wt == repo {
        return false;
    }
    let _ = Command::new("git").arg("-C").arg(repo).args(["worktree", "remove", "--force", "--force"]).arg(wt).output();
    if wt.exists() { let _ = std::fs::remove_dir_all(wt); }
    let _ = Command::new("git").arg("-C").arg(repo).args(["worktree", "prune"]).output();
    !wt.exists()
}

/// Worktree da tarefa → fora. Chamado quando a tarefa vira `merged` por
/// qualquer caminho (merge pelo app, merge externo detectado, marcação manual).
fn remove_task_worktree(repo: &Path, conn: &Connection, task_id: &str) {
    if let Ok(wt) = conn.query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get::<_, String>(0)) {
        if !wt.is_empty() { remove_worktree_dir(repo, &PathBuf::from(wt)); }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageItem { id: String, title: String, status: String, path: String, bytes: u64, stale: bool }

fn task_rows(state: &State<AppState>) -> Result<Vec<(String, String, String, String)>, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    let mut st = conn.prepare("SELECT id, title, status, worktree FROM task").map_err(|e| e.to_string())?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// Raio-x do .cardume do projeto ativo: quanto ocupa cada categoria e o que
/// pode ir embora sem perder nada (worktrees/entregáveis de tarefa finalizada,
/// órfãos, temporários).
#[tauri::command(async)]
fn workspace_usage(state: State<AppState>) -> Result<serde_json::Value, String> {
    let repo = repo_of(&state)?;
    let d = repo.join(".cardume");
    let tasks = task_rows(&state)?;
    let by_wt: std::collections::HashMap<String, &(String, String, String, String)> = tasks.iter().map(|t| (t.3.clone(), t)).collect();
    let by_id: std::collections::HashMap<String, &(String, String, String, String)> = tasks.iter().map(|t| (t.0.clone(), t)).collect();
    let finished = |s: &str| TASK_FINISHED.contains(&s);

    // aprendizados + estado (sempre mantidos)
    let mut keep: u64 = CARDUME_KEEP.iter().map(|n| dir_size(&d.join(n))).sum();
    for n in ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "cardume.db"] { keep += dir_size(&d.join(n)); }

    // worktrees + reviews
    let mut wts: Vec<UsageItem> = Vec::new();
    for sub in ["worktrees", "reviews"] {
        if let Ok(rd) = std::fs::read_dir(d.join(sub)) {
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_dir() { continue; }
                let key = p.display().to_string();
                let bytes = dir_size(&p);
                match by_wt.get(&key) {
                    Some(t) => wts.push(UsageItem { id: t.0.clone(), title: t.1.clone(), status: t.2.clone(), path: key, bytes, stale: finished(&t.2) }),
                    None => wts.push(UsageItem { id: String::new(), title: p.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(), status: "órfã".into(), path: key, bytes, stale: true }),
                }
            }
        }
    }
    // entregáveis
    let mut arts: Vec<UsageItem> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(d.join("artifacts")) {
        for e in rd.flatten() {
            let p = e.path();
            let bytes = dir_size(&p);
            let name = p.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            match by_id.get(&name) {
                Some(t) => arts.push(UsageItem { id: t.0.clone(), title: t.1.clone(), status: t.2.clone(), path: p.display().to_string(), bytes, stale: finished(&t.2) }),
                None => arts.push(UsageItem { id: String::new(), title: name, status: "órfão".into(), path: p.display().to_string(), bytes, stale: true }),
            }
        }
    }
    // temporários
    let temp: u64 = ["logs", "why", "tmp"].iter().map(|n| dir_size(&d.join(n))).sum();
    let attachments = dir_size(&d.join("attachments"));

    let sum = |v: &Vec<UsageItem>, only_stale: bool| v.iter().filter(|i| !only_stale || i.stale).map(|i| i.bytes).sum::<u64>();
    let cnt = |v: &Vec<UsageItem>, only_stale: bool| v.iter().filter(|i| !only_stale || i.stale).count();
    let total = keep + temp + attachments + sum(&wts, false) + sum(&arts, false);
    Ok(serde_json::json!({
        "dir": d.display().to_string(),
        "total": total,
        "keep": keep,
        "temp": temp,
        "attachments": attachments,
        "worktrees": { "bytes": sum(&wts, false), "count": cnt(&wts, false), "staleBytes": sum(&wts, true), "staleCount": cnt(&wts, true), "items": wts },
        "artifacts": { "bytes": sum(&arts, false), "count": cnt(&arts, false), "staleBytes": sum(&arts, true), "staleCount": cnt(&arts, true), "items": arts },
    }))
}

/// Limpeza do .cardume: `worktrees` = worktrees/reviews de tarefa finalizada ou
/// órfãs; `temp` = logs (com >2h), why/, tmp/; `artifacts` = entregáveis de
/// tarefa finalizada ou órfãos. Aprendizados e estado NUNCA são tocados.
#[tauri::command(async)]
fn workspace_clean(state: State<AppState>, worktrees: bool, temp: bool, artifacts: bool) -> Result<serde_json::Value, String> {
    let repo = repo_of(&state)?;
    let d = repo.join(".cardume");
    let usage = workspace_usage(state)?;
    let mut freed: u64 = 0;
    let mut removed: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    let items = |k: &str| -> Vec<serde_json::Value> { usage[k]["items"].as_array().cloned().unwrap_or_default() };
    if worktrees {
        for it in items("worktrees") {
            if !it["stale"].as_bool().unwrap_or(false) { continue; }
            let p = PathBuf::from(it["path"].as_str().unwrap_or(""));
            if p.as_os_str().is_empty() { continue; }
            let b = it["bytes"].as_u64().unwrap_or(0);
            if remove_worktree_dir(&repo, &p) { freed += b; removed += 1; } else { errors.push(format!("worktree {}", p.display())); }
        }
    }
    if artifacts {
        for it in items("artifacts") {
            if !it["stale"].as_bool().unwrap_or(false) { continue; }
            let p = PathBuf::from(it["path"].as_str().unwrap_or(""));
            if !p.starts_with(d.join("artifacts")) || p == d.join("artifacts") { continue; }
            let b = it["bytes"].as_u64().unwrap_or(0);
            match std::fs::remove_dir_all(&p) { Ok(_) => { freed += b; removed += 1; } Err(e) => errors.push(format!("{}: {e}", p.display())) }
        }
    }
    if temp {
        for n in ["why", "tmp"] {
            let p = d.join(n);
            if p.is_dir() { let b = dir_size(&p); if std::fs::remove_dir_all(&p).is_ok() { freed += b; removed += 1; } }
        }
        // logs: só os parados há mais de 2h (uma tarefa rodando ainda escreve no dela)
        if let Ok(rd) = std::fs::read_dir(d.join("logs")) {
            let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600);
            for e in rd.flatten() {
                let p = e.path();
                let old = e.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
                if !old { continue; }
                let b = dir_size(&p);
                let ok = if p.is_dir() { std::fs::remove_dir_all(&p).is_ok() } else { std::fs::remove_file(&p).is_ok() };
                if ok { freed += b; removed += 1; }
            }
        }
    }
    Ok(serde_json::json!({ "freed": freed, "removed": removed, "errors": errors }))
}

/// O merge do PR aconteceu? Sucesso do `gh pr merge`, OU falha com o PR já MERGED no GitHub
/// (a falha foi só na limpeza da branch local).
fn pr_merge_landed(gh_ok: bool, state_after: Option<&str>) -> bool {
    gh_ok || state_after.map(|s| s.trim().eq_ignore_ascii_case("MERGED")).unwrap_or(false)
}

/// Mergeia o PR (gh) e marca a tarefa como merged localmente.
#[tauri::command(async)]
fn merge_pr(state: State<AppState>, task_id: String, method: String) -> Result<String, String> {
    let (repo, branch) = pr_head(&state, &task_id)?;
    let m = match method.as_str() { "squash" => "--squash", "rebase" => "--rebase", _ => "--merge" };
    let mut c = Command::new(gh_bin());
    c.args(["pr", "merge", &branch, m, "--delete-branch"]).args(gh_repo_args(&repo)).current_dir(&repo);
    // teto: sem ele uma rede pendurada deixava o botão "mergeando…" pra sempre
    let res = output_timeout(c, 120);
    let gh_ok = matches!(&res, Ok(o) if o.status.success());
    let mut cleanup_branch = false;
    if !gh_ok {
        // o `--delete-branch` tenta apagar a branch LOCAL — presa na worktree da tarefa, o gh falha DEPOIS
        // de mergear no GitHub; e um teto estourado pode ter chegado ao GitHub também. Confere o estado real.
        let mut v = Command::new(gh_bin());
        v.args(["pr", "view", &branch, "--json", "state", "--jq", ".state"]).args(gh_repo_args(&repo)).current_dir(&repo);
        let state_after = output_timeout(v, 20).ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).to_string());
        if !pr_merge_landed(false, state_after.as_deref()) {
            return Err(match res { Ok(o) => String::from_utf8_lossy(&o.stderr).to_string(), Err(e) => e });
        }
        cleanup_branch = true; // o gh não terminou a limpeza: fazemos depois de tirar a worktree
    }
    // marca merged localmente + remove a worktree
    // trava solta ANTES do bloco: guarda temporária num `if let` vive até o fim do bloco (deadlock se o bloco chama repo_of)
    let db_path_now = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(path) = db_path_now {
        if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
            let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
            preview_kill(&state.procs, &task_id);
            remove_task_worktree(&repo, &conn, &task_id);
            let _ = conn.execute("UPDATE task SET status='merged' WHERE id=?1", params![task_id]);
        }
    }
    if cleanup_branch {
        // best-effort: branch local (liberada agora que a worktree saiu) e a remota, se ainda existir
        let _ = Command::new("git").arg("-C").arg(&repo).args(["worktree", "prune"]).output();
        let _ = Command::new("git").arg("-C").arg(&repo).args(["branch", "-D", &branch]).output();
        let mut ls = Command::new("git");
        ls.arg("-C").arg(&repo).args(["ls-remote", "--heads", "origin", &branch]).env("GIT_TERMINAL_PROMPT", "0");
        if output_timeout(ls, 20).map(|o| !o.stdout.is_empty()).unwrap_or(false) {
            let mut del = Command::new("git");
            del.arg("-C").arg(&repo).args(["push", "origin", "--delete", &branch]).env("GIT_TERMINAL_PROMPT", "0");
            let _ = output_timeout(del, 30);
        }
    }
    Ok("PR mergeado".to_string())
}

/// "Pediu mudanças" que ainda vale: o review mais recente do autor (não substituído), não ignorado na UI,
/// e só enquanto a decisão do PR continua CHANGES_REQUESTED (aprovado depois → nada a reenviar).
fn pr_open_review_asks<'a>(info: &'a PrInfo, ign: &std::collections::HashSet<String>) -> Vec<&'a PrReview> {
    if info.decision != "CHANGES_REQUESTED" {
        return vec![];
    }
    info.reviews
        .iter()
        .enumerate()
        .filter(|(i, r)| r.state == "CHANGES_REQUESTED" && !r.superseded && !ign.contains(&if r.id.is_empty() { format!("idx:{i}") } else { r.id.clone() }))
        .map(|(_, r)| r)
        .collect()
}

/// Coleta os comentários do PR e manda o agente endereçá-los (rework via --resume).
#[tauri::command(async)]
fn rework_from_pr(state: State<AppState>, task_id: String, ignored: Option<Vec<String>>) -> Result<(), String> {
    let info = pr_status(state.clone(), task_id.clone())?;
    // o que a UI ignorou (localStorage prIgn:*) NÃO vai pro agente — mesma conta do botão "corrigir N em aberto"
    let ign: std::collections::HashSet<String> = ignored.unwrap_or_default().into_iter().collect();
    let asks = pr_open_review_asks(&info, &ign);
    if !info.exists || (info.comments.is_empty() && asks.is_empty()) {
        return Err("nenhum comentário de review pra endereçar".to_string());
    }
    let repo = repo_of(&state)?;
    let slug = repo_slug(&repo).unwrap_or_default();
    // só o que ainda NÃO foi endereçado: nem resposta de thread, nem respondido, resolvido, desatualizado ou ignorado
    let open: Vec<&PrComment> = info.comments.iter().filter(|c| !c.answered && !c.resolved && !c.outdated && c.in_reply_to.is_none() && !ign.contains(&pr_cmt_key(c))).collect();
    if open.is_empty() && asks.is_empty() {
        return Err("todos os comentários já têm resposta — nada a endereçar".to_string());
    }
    let mut text = format!("Endereça os comentários de review do PR #{} (aplique as correções pedidas):\n", info.number);
    for c in &open {
        let loc = match (&c.path, c.line) {
            (Some(p), Some(l)) => format!("{p}:{l}"),
            (Some(p), None) => p.clone(),
            _ => "(conversa)".to_string(),
        };
        let snippet: String = c.body.replace('\n', " ").chars().take(300).collect();
        // comentário inline (tem path) responde via …/replies; conversa do PR responde com gh pr comment
        match (c.id, c.path.is_some()) {
            (Some(id), true) => text.push_str(&format!("- [comment_id={id}] [{}] {loc}: {snippet}\n", c.author)),
            _ => text.push_str(&format!("- [conversa] [{}] {}: {snippet}\n", c.author, c.url)),
        }
    }
    for r in &asks {
        let snippet: String = r.body.replace('\n', " ").chars().take(500).collect();
        text.push_str(&format!("- [review · pediu mudanças] [{}]: {snippet}\n", r.author));
    }
    text.push_str(&format!(
        "\nDEPOIS de aplicar TODAS as correções, FECHE O CICLO (obrigatório):\n\
         1. Commit: git add -A && git commit -m \"fix: endereça comentários do PR #{num}\"\n\
         2. Push: git push (o PR atualiza sozinho)\n\
         3. RESPONDA cada comentário inline no GitHub, um a um, dizendo O QUE mudou (ou por que não mudou):\n\
            gh api repos/{slug}/pulls/{num}/comments/<comment_id>/replies -f body=\"✔ <o que foi feito>\"\n\
         4. Pros itens de (conversa), responda UM comentário por item, citando o link dele: gh pr comment {num} --body \"✔ <link do comentário> <o que foi feito>\"\n\
         Sem commit + push + respostas o rework NÃO está completo.\n",
        num = info.number,
        slug = slug,
    ));
    // enfileira como instrução e dispara o rework
    add_instruction(state, task_id.clone(), text)?;
    Command::new(node_bin())
        .args(["--disable-warning=ExperimentalWarning", &cli_path(&repo), "rework", &task_id, "--repo", &repo.display().to_string()])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("falha ao iniciar rework: {e}"))?;
    Ok(())
}

/// Marca uma thread de review como RESOLVIDA no GitHub (GraphQL resolveReviewThread).
#[tauri::command(async)]
fn pr_resolve_thread(state: State<AppState>, thread_id: String) -> Result<(), String> {
    let tid = thread_id.trim();
    if tid.is_empty() || tid.len() > 200 || !tid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '=') {
        return Err("id de thread inválido".to_string());
    }
    let repo = repo_of(&state)?;
    let q = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
    let mut c = Command::new(gh_bin());
    c.args(["api", "graphql", "-f", &format!("query={q}"), "-f", &format!("id={tid}")]).current_dir(&repo);
    let o = output_timeout(c, 15).map_err(|e| format!("sem resposta do GitHub (gh): {e}"))?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
        return Err(if err.is_empty() { "gh api graphql falhou".to_string() } else { err });
    }
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap_or(serde_json::Value::Null);
    if let Some(errs) = v["errors"].as_array() {
        if !errs.is_empty() {
            return Err(errs.iter().filter_map(|e| e["message"].as_str()).collect::<Vec<_>>().join("; "));
        }
    }
    if v["data"]["resolveReviewThread"]["thread"]["isResolved"].as_bool() != Some(true) {
        return Err("o GitHub não confirmou a resolução da thread".to_string());
    }
    Ok(())
}

/// E4 — resolução de conflito assistida por IA: dispara o agente pra mergear a
/// base e resolver os conflitos na worktree (turno longo → spawn sem bloquear a UI).
#[tauri::command(async)]
fn resolve_conflict(state: State<AppState>, task_id: String) -> Result<(), String> {
    let repo = repo_of(&state)?;
    Command::new(node_bin())
        .args(["--disable-warning=ExperimentalWarning", &cli_path(&repo), "resolve-conflict", &task_id, "--repo", &repo.display().to_string()])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("falha ao iniciar a resolução de conflito: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn merge_task(state: State<AppState>, task_id: String) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let out = Command::new(node_bin())
        .args([
            "--disable-warning=ExperimentalWarning",
            &cli_path(&repo),
            "merge",
            &task_id,
            "--repo",
            &repo.display().to_string(),
        ])
        .current_dir(&repo)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("merge concluído".to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// Abre o seletor de pasta nativo do macOS e devolve o caminho escolhido.
/// async: roda fora da thread principal (senão o diálogo bloqueante congela a UI).
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.display().to_string())
}

/// Abre um seletor de arquivos .md e devolve [{filename, content}] pra criar agentes.
/// Seletor nativo de múltiplos arquivos de referência (PDF, md, imagens…).
#[tauri::command]
async fn pick_ref_files(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Documentos", &["pdf", "md", "markdown", "txt", "png", "jpg", "jpeg", "gif", "webp", "svg"])
        .pick_files(move |p| {
            let _ = tx.send(p);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten();
    let mut out = Vec::new();
    if let Some(paths) = picked {
        for p in paths {
            if let Ok(pb) = p.into_path() {
                out.push(pb.display().to_string());
            }
        }
    }
    out
}

/// Anexo IMPORTADO pro chat: o arquivo é copiado pra dentro do projeto
/// (.cardume/refs da worktree quando há tarefa; .cardume/attachments do repo
/// nos chats sem tarefa), o texto vem inteiro pra entrar na mensagem e a
/// imagem vem como dataURL pra miniatura. Antes só o CAMINHO ia pro chat.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    name: String,
    path: String,
    rel: String,
    kind: String,
    size: u64,
    text: Option<String>,
    truncated: bool,
    data_url: Option<String>,
}

/// Pasta de destino dos anexos: .cardume/refs da worktree (com tarefa) ou
/// .cardume/attachments do repo (chats sem tarefa).
fn attachment_dir(state: &State<AppState>, task_id: Option<&str>) -> Result<(PathBuf, String), String> {
    match task_id.filter(|s| !s.is_empty()) {
        Some(tid) => {
            let (wt, _) = task_wt_base(state, tid)?;
            Ok((wt.join(".cardume").join("refs"), ".cardume/refs".to_string()))
        }
        None => Ok((repo_of(state)?.join(".cardume").join("attachments"), ".cardume/attachments".to_string())),
    }
}

/// Nome seguro e sem colisão dentro da pasta (slug do stem + extensão original).
fn attachment_name(dir: &PathBuf, base: &str) -> String {
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (base[..i].to_string(), base[i..].to_lowercase()),
        _ => (base.to_string(), String::new()),
    };
    let mut safe = slug_raw(&stem);
    if safe.is_empty() {
        safe = "anexo".into();
    }
    let mut name = format!("{safe}{ext}");
    let mut n = 1;
    while dir.join(&name).exists() {
        n += 1;
        name = format!("{safe}-{n}{ext}");
    }
    name
}

/// Descreve um anexo já gravado em `dest`: tipo, tamanho, texto integral
/// (texto até 60k chars) e dataURL (imagem até 6 MB, pra miniatura).
fn describe_attachment(dest: &PathBuf, name: String, rel: String) -> Result<Attachment, String> {
    let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    let ext_l = name.rsplit('.').next().map(|e| e.to_lowercase()).filter(|e| e != &name.to_lowercase()).unwrap_or_default();
    let kind = if ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&ext_l.as_str()) {
        "image"
    } else if ext_l == "pdf" {
        "pdf"
    } else if ["md", "markdown", "txt", "json", "yaml", "yml", "csv", "ts", "tsx", "js", "mjs", "py", "rs", "sql", "html", "css", "sh", "toml", "log", "xml", "env", "ini", "conf"].contains(&ext_l.as_str()) {
        "text"
    } else {
        "file"
    };
    let mut text = None;
    let mut truncated = false;
    let mut data_url = None;
    if kind == "text" && size <= 2_000_000 {
        if let Ok(s) = std::fs::read_to_string(dest) {
            const MAX: usize = 60_000;
            if s.chars().count() > MAX {
                text = Some(s.chars().take(MAX).collect());
                truncated = true;
            } else {
                text = Some(s);
            }
        }
    }
    if kind == "image" && size <= 6_000_000 {
        let bytes = std::fs::read(dest).map_err(|e| e.to_string())?;
        let mime = match ext_l.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/svg+xml",
        };
        data_url = Some(format!("data:{mime};base64,{}", base64_encode(&bytes)));
    }
    Ok(Attachment { rel, path: dest.display().to_string(), name, kind: kind.to_string(), size, text, truncated, data_url })
}

/// Anexo a partir de um ARQUIVO do disco (botão "anexar").
#[tauri::command(async)]
fn import_attachment(state: State<AppState>, path: String, task_id: Option<String>) -> Result<Attachment, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("arquivo não encontrado: {path}"));
    }
    let (dir, rel_dir) = attachment_dir(&state, task_id.as_deref())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "anexo".into());
    let name = attachment_name(&dir, &base);
    let dest = dir.join(&name);
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    describe_attachment(&dest, name.clone(), format!("{rel_dir}/{name}"))
}

/// Grava um arquivo de REFERÊNCIA gerado pelo app (ex.: EPIC.md compilado) com o nome exato, numa pasta
/// própria em .cardume/tmp/refs/ (ignorada pelo git), e devolve o caminho absoluto pra ir em `refs` do new_task.
/// Diferente dos anexos, o nome não é slugificado — o prompt cita ".cardume/refs/EPIC.md" literalmente.
#[tauri::command(async)]
fn write_ref_file(state: State<AppState>, name: String, text: String) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    if safe.is_empty() || safe.starts_with('.') { return Err("nome de referência inválido".into()); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dir = repo.join(".cardume").join("tmp").join("refs").join(stamp.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&safe);
    std::fs::write(&dest, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(dest.display().to_string())
}

/// Anexo a partir de BYTES (Ctrl+V de um print, arrastar um arquivo pro chat) —
/// o webview não tem o caminho, manda o conteúdo em base64.
#[tauri::command(async)]
fn import_attachment_data(state: State<AppState>, name: String, data_b64: String, task_id: Option<String>) -> Result<Attachment, String> {
    let bytes = base64_decode(&data_b64).ok_or("base64 inválido")?;
    if bytes.is_empty() {
        return Err("anexo vazio".into());
    }
    if bytes.len() > 25_000_000 {
        return Err("anexo maior que 25 MB".into());
    }
    let (dir, rel_dir) = attachment_dir(&state, task_id.as_deref())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = if name.trim().is_empty() { "anexo".to_string() } else { name.trim().to_string() };
    let name = attachment_name(&dir, &base);
    let dest = dir.join(&name);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    describe_attachment(&dest, name.clone(), format!("{rel_dir}/{name}"))
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        let mut n: u32 = 0;
        let mut pad = 0;
        for (i, &c) in chunk.iter().enumerate() {
            if c == b'=' {
                pad += 1;
                n <<= 6;
            } else {
                n = (n << 6) | val(c)?;
            }
            let _ = i;
        }
        for _ in chunk.len()..4 {
            n <<= 6;
            pad += 1;
        }
        let b = n.to_be_bytes();
        out.push(b[1]);
        if pad < 2 {
            out.push(b[2]);
        }
        if pad < 1 {
            out.push(b[3]);
        }
    }
    Some(out)
}

#[tauri::command]
async fn import_agent_files(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_files(move |p| {
            let _ = tx.send(p);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten();
    let mut out = Vec::new();
    if let Some(paths) = picked {
        for p in paths {
            if let Ok(pb) = p.into_path() {
                if let Ok(content) = std::fs::read_to_string(&pb) {
                    let name = pb
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    out.push(serde_json::json!({ "filename": name, "content": content }));
                }
            }
        }
    }
    out
}

#[tauri::command(async)]
fn remove_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let repo = repo_of(&state)?;
    preview_kill(&state.procs, &task_id); // o preview que o app subiu não fica órfão
    Command::new(node_bin())
        .args([
            "--disable-warning=ExperimentalWarning",
            &cli_path(&repo),
            "rm",
            &task_id,
            "--repo",
            &repo.display().to_string(),
        ])
        .current_dir(&repo)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Caminho do log do webview: no Mac fica /tmp/constellation-web.log (scripts e o time leem ali);
/// no Windows/Linux, a pasta temporária do sistema (E10 — o /tmp fixo não existe no Windows).
fn web_log_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/tmp/constellation-web.log")
    } else {
        std::env::temp_dir().join("constellation-web.log")
    }
}
/// Espelha o console do webview no log acima — sem isso,
/// erro de JS nos ticks é invisível e vira caça às cegas.
#[tauri::command(async)]
fn web_log(line: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(web_log_path()) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{ts} {}", line.chars().take(600).collect::<String>());
    }
}

/// Notificação NATIVA com clique útil. O plugin (notify-rust) cai no bundle do
/// Editor de Script quando não registra o app — clicar abria o editor. Aqui:
/// mac-notification-sys com o bundle do Starfork + resposta do clique →
/// evento "notif-open" pro front abrir a tarefa certa.
#[tauri::command(async)]
fn notify_native(app: tauri::AppHandle, title: String, body: String, task_id: Option<String>) {
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || {
        use mac_notification_sys::{Notification, NotificationResponse};
        let sent = Notification::default()
            .title(&title)
            .message(&body)
            .sound("Ping")
            .send();
        if let Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) = sent {
            use tauri::{Emitter, Manager};
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let _ = app.emit("notif-open", task_id.unwrap_or_default());
        }
    });
    // Linux/Windows: sem resposta de clique nativa — envia pelo tauri-plugin-notification
    // (já registrado). Perde só o "clicar abre a tarefa", não a notificação.
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = task_id;
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
}

// ===================== PREVIEW: "o app caiu → subir de novo" =====================
// O agente sobe o servidor de preview DENTRO do grupo de processos dele — quando o turno
// acaba, o motor mata o grupo e o link anunciado ('PREVIEW: http://127.0.0.1:PORTA/…')
// morre junto. Aqui o app (1) sabe se o preview está no ar (preview_alive), (2) sabe COMO
// subir (preview_info: .cardume/preview.json gravado pelo agente, ou um palpite pelo
// package.json/manage.py) e (3) sobe num grupo PRÓPRIO, que sobrevive ao fim do turno
// (preview_start/preview_stop/preview_log_tail). Só roda com clique explícito do humano.

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewInfo {
    cmd: String,
    cwd: String,
    url: Option<String>,
    env: HashMap<String, String>,
    guessed: bool,
}

/// Saída de um preview que o app subiu e que JÁ terminou (task_id → código), pra UI
/// distinguir "subindo" de "morreu no caminho".
static PREVIEW_EXITS: std::sync::OnceLock<Mutex<HashMap<String, Option<i32>>>> = std::sync::OnceLock::new();
fn preview_exits() -> &'static Mutex<HashMap<String, Option<i32>>> { PREVIEW_EXITS.get_or_init(|| Mutex::new(HashMap::new())) }

/// host:porta de uma URL de preview — SÓ loopback (127.0.0.1 / localhost / [::1]) e http(s).
/// Qualquer outro host é recusado: o app nunca sonda/abre máquina de terceiros por aqui.
fn preview_host_port(url: &str) -> Result<(String, u16), String> {
    let u = url.trim();
    let (rest, def_port) = if let Some(r) = u.strip_prefix("http://") { (r, 80u16) }
        else if let Some(r) = u.strip_prefix("https://") { (r, 443u16) }
        else { return Err("preview precisa ser http(s)".into()) };
    let auth = rest.split(|c| c == '/' || c == '?' || c == '#').next().unwrap_or("");
    if auth.is_empty() || auth.contains('@') { return Err("url de preview inválida".into()); }
    let (host, port) = if let Some(r) = auth.strip_prefix('[') {
        let end = r.find(']').ok_or("url de preview inválida")?;
        let h = &r[..end];
        let tail = &r[end + 1..];
        let p = if let Some(p) = tail.strip_prefix(':') { p.parse::<u16>().map_err(|_| "porta inválida")? } else if tail.is_empty() { def_port } else { return Err("url de preview inválida".into()) };
        (h.to_string(), p)
    } else {
        match auth.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "porta inválida")?),
            None => (auth.to_string(), def_port),
        }
    };
    let h = host.to_ascii_lowercase();
    if !matches!(h.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err("só dá pra checar preview local (127.0.0.1 / localhost)".into());
    }
    if port == 0 { return Err("porta inválida".into()); }
    Ok((h, port))
}

/// TCP connect com teto curto. `localhost` tenta 127.0.0.1 e ::1 (Node 17+ às vezes só escuta no ::1).
fn preview_alive_url(url: &str, timeout_ms: u64) -> Result<bool, String> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    let (host, port) = preview_host_port(url)?;
    let ips: Vec<IpAddr> = match host.as_str() {
        "127.0.0.1" => vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        "::1" => vec![IpAddr::V6(Ipv6Addr::LOCALHOST)],
        _ => vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)],
    };
    let to = std::time::Duration::from_millis(timeout_ms);
    Ok(ips.into_iter().any(|ip| TcpStream::connect_timeout(&SocketAddr::new(ip, port), to).is_ok()))
}

/// Lê .cardume/preview.json da worktree (gravado pelo agente quando sobe o servidor).
fn preview_read_json(wt: &Path) -> Option<PreviewInfo> {
    let raw = std::fs::read_to_string(wt.join(".cardume").join("preview.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let cmd = v.get("cmd").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    let cwd = v.get("cwd").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| ".".into());
    let url = v.get("url").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| preview_host_port(s).is_ok());
    let mut env = HashMap::new();
    if let Some(o) = v.get("env").and_then(|x| x.as_object()) {
        for (k, val) in o {
            // PATH do projeto não substitui o do app (senão some o node/npm) — o resto passa
            if k.eq_ignore_ascii_case("PATH") || k.is_empty() { continue; }
            let s = match val { serde_json::Value::String(s) => s.clone(), serde_json::Value::Null => continue, other => other.to_string() };
            env.insert(k.clone(), s);
        }
    }
    Some(PreviewInfo { cmd, cwd, url, env, guessed: false })
}

/// Palpite quando o agente não gravou o preview.json (tarefas antigas): scripts do
/// package.json (dev → start, com o gerenciador do lockfile), vite/next soltos, Django
/// (manage.py) e FastAPI óbvio (main.py com FastAPI()). Procura na raiz e em pastas
/// de front comuns.
fn preview_guess(wt: &Path) -> Option<PreviewInfo> {
    let dirs = [".", "frontend", "web", "app", "client", "ui"];
    for d in dirs {
        let dir = if d == "." { wt.to_path_buf() } else { wt.join(d) };
        let pj = dir.join("package.json");
        let Ok(raw) = std::fs::read_to_string(&pj) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let has = |f: &str| dir.join(f).is_file() || wt.join(f).is_file();
        let pm = if has("pnpm-lock.yaml") { "pnpm" } else if has("yarn.lock") { "yarn" } else if has("bun.lockb") || has("bun.lock") { "bun" } else { "npm" };
        let scripts = v.get("scripts").and_then(|s| s.as_object());
        let script = |n: &str| scripts.and_then(|s| s.get(n)).and_then(|x| x.as_str()).is_some();
        let cmd = if script("dev") {
            match pm { "npm" => "npm run dev".to_string(), "bun" => "bun run dev".to_string(), p => format!("{p} dev") }
        } else if script("start") {
            match pm { "bun" => "bun run start".to_string(), p => format!("{p} start") }
        } else {
            let dep = |n: &str| ["dependencies", "devDependencies"].iter().any(|k| v.get(k).and_then(|o| o.get(n)).is_some());
            if dep("vite") { "npx vite".to_string() } else if dep("next") { "npx next dev".to_string() } else { continue }
        };
        return Some(PreviewInfo { cmd, cwd: d.to_string(), url: None, env: HashMap::new(), guessed: true });
    }
    let py = if cfg!(windows) { "python" } else { "python3" };
    if wt.join("manage.py").is_file() {
        return Some(PreviewInfo { cmd: format!("{py} manage.py runserver 127.0.0.1:8000"), cwd: ".".into(), url: None, env: HashMap::new(), guessed: true });
    }
    for (file, module) in [("main.py", "main:app"), ("app/main.py", "app.main:app")] {
        if let Ok(src) = std::fs::read_to_string(wt.join(file)) {
            if src.contains("FastAPI(") {
                return Some(PreviewInfo { cmd: format!("{py} -m uvicorn {module} --host 127.0.0.1 --port 8000"), cwd: ".".into(), url: None, env: HashMap::new(), guessed: true });
            }
        }
    }
    None
}

/// preview.json → senão palpite. A URL anunciada no chat (se houver) completa o palpite.
fn preview_info_for(wt: &Path, url: Option<String>) -> Option<PreviewInfo> {
    let announced = url.filter(|u| preview_host_port(u).is_ok());
    if let Some(mut i) = preview_read_json(wt) {
        if i.url.is_none() { i.url = announced; }
        return Some(i);
    }
    preview_guess(wt).map(|mut i| { i.url = announced; i })
}

/// Pasta de trabalho do preview DENTRO da worktree (sem '..', sem caminho absoluto fora dela).
fn preview_cwd(wt: &Path, cwd: &str) -> Result<PathBuf, String> {
    let rel = Path::new(cwd.trim());
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_) | std::path::Component::RootDir)) {
        return Err(format!("pasta do preview fora da tarefa: {cwd}"));
    }
    let p = if cwd.trim().is_empty() || cwd.trim() == "." { wt.to_path_buf() } else { wt.join(rel) };
    if !p.is_dir() { return Err(format!("a pasta do preview não existe: {cwd}")); }
    Ok(p)
}

fn preview_log_path(wt: &Path) -> PathBuf { wt.join(".cardume").join("logs").join("preview.log") }

/// Mata o preview rastreado da tarefa (se houver). true = havia um.
fn preview_kill(procs: &Arc<Mutex<HashMap<String, i32>>>, task_id: &str) -> bool {
    let pid = procs.lock().ok().and_then(|mut m| m.remove(&format!("preview:{task_id}")));
    if let Some(p) = pid {
        signal_group(p, procsig::TERM);
        std::thread::sleep(std::time::Duration::from_millis(300));
        if pid_alive(p) { signal_group(p, procsig::KILL); }
        true
    } else { false }
}

/// Sobe o preview num grupo PRÓPRIO (não morre com o turno do agente); stdout+stderr no
/// .cardume/logs/preview.log (zerado a cada subida). Devolve o pid do líder do grupo.
fn preview_spawn(procs: &Arc<Mutex<HashMap<String, i32>>>, task_id: &str, wt: &Path, info: &PreviewInfo) -> Result<i32, String> {
    use std::io::Write;
    preview_kill(procs, task_id);
    let dir = preview_cwd(wt, &info.cwd)?;
    let logp = preview_log_path(wt);
    if let Some(d) = logp.parent() { std::fs::create_dir_all(d).map_err(|e| format!("não criei a pasta de log: {e}"))?; }
    let mut log = std::fs::File::create(&logp).map_err(|e| format!("não abri o log do preview: {e}"))?;
    let _ = writeln!(log, "$ {}   (em {})", info.cmd, if info.cwd.is_empty() { "." } else { &info.cwd });
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&info.cmd);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&info.cmd);
        c
    };
    // PATH do app (node/nvm/homebrew) + binários locais do projeto (.venv, node_modules/.bin)
    let sep = if cfg!(windows) { ";" } else { ":" };
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let mut local: Vec<String> = vec![];
    for base in [dir.clone(), wt.to_path_buf()] {
        for sub in [base.join("node_modules").join(".bin"), base.join(".venv").join(bin)] {
            if sub.is_dir() { let s = sub.display().to_string(); if !local.contains(&s) { local.push(s); } }
        }
    }
    let path = if local.is_empty() { checks_path_env() } else { format!("{}{sep}{}", local.join(sep), checks_path_env()) };
    cmd.current_dir(&dir).env("PATH", path).env("BROWSER", "none").env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    for (k, v) in &info.env { cmd.env(k, v); }
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err));
    detach_new_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("não consegui rodar o comando do preview: {e}"))?;
    let pid = child.id() as i32;
    if let Ok(mut m) = procs.lock() { m.insert(format!("preview:{task_id}"), pid); }
    if let Ok(mut m) = preview_exits().lock() { m.remove(task_id); }
    let (procs2, tid) = (procs.clone(), task_id.to_string());
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        // só limpa se ainda é ESTE processo (uma nova subida pode já ter trocado o pid)
        let mine = procs2.lock().ok().map(|mut m| {
            let k = format!("preview:{tid}");
            if m.get(&k) == Some(&pid) { m.remove(&k); true } else { false }
        }).unwrap_or(false);
        if mine { if let Ok(mut m) = preview_exits().lock() { m.insert(tid, code); } }
    });
    Ok(pid)
}

/// Últimas `n` linhas do log do preview.
fn preview_tail(wt: &Path, n: usize) -> String {
    let raw = std::fs::read(preview_log_path(wt)).unwrap_or_default();
    let s = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = s.lines().collect();
    let from = lines.len().saturating_sub(n);
    lines[from..].iter().map(|l| l.chars().take(400).collect::<String>()).collect::<Vec<_>>().join("\n")
}

/// O preview está no ar? Só loopback; TCP connect com ~800ms de teto.
#[tauri::command(async)]
fn preview_alive(url: String) -> Result<bool, String> {
    preview_alive_url(&url, 800)
}

/// Como subir o preview desta tarefa: .cardume/preview.json (do agente) ou palpite
/// (`guessed: true`). `url` = a última anunciada no chat, completa o palpite. null = não sei.
#[tauri::command(async)]
fn preview_info(state: State<AppState>, task_id: String, url: Option<String>) -> Result<Option<PreviewInfo>, String> {
    let wt = match task_worktree(&state, &task_id) { Ok(w) => w, Err(_) => return Ok(None) };
    Ok(preview_info_for(&wt, url))
}

/// Sobe o preview (clique do humano). Retorna rápido; a UI checa preview_alive até subir.
#[tauri::command(async)]
fn preview_start(state: State<AppState>, task_id: String, url: Option<String>) -> Result<PreviewInfo, String> {
    let wt = task_worktree(&state, &task_id)?;
    let info = preview_info_for(&wt, url).ok_or("não sei como subir este app — peça pro agente subir e gravar .cardume/preview.json")?;
    preview_spawn(&state.procs, &task_id, &wt, &info)?;
    web_log(format!("[preview] {task_id}: subindo `{}` em {}", info.cmd, info.cwd));
    Ok(info)
}

/// Derruba o preview que o app subiu (se houver).
#[tauri::command(async)]
fn preview_stop(state: State<AppState>, task_id: String) -> Result<bool, String> {
    Ok(preview_kill(&state.procs, &task_id))
}

/// Final do log + estado do processo que o app subiu: {log, running, exited, exitCode}.
#[tauri::command(async)]
fn preview_log_tail(state: State<AppState>, task_id: String) -> Result<serde_json::Value, String> {
    let wt = task_worktree(&state, &task_id)?;
    let pid = state.procs.lock().ok().and_then(|m| m.get(&format!("preview:{task_id}")).copied());
    let running = pid.map(pid_alive).unwrap_or(false);
    let exit = preview_exits().lock().ok().and_then(|m| m.get(&task_id).copied());
    Ok(serde_json::json!({ "log": preview_tail(&wt, 60), "running": running, "exited": exit.is_some(), "exitCode": exit.flatten() }))
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-pv-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn host_validation_only_loopback() {
        assert_eq!(preview_host_port("http://127.0.0.1:5173/x?y=1").unwrap(), ("127.0.0.1".into(), 5173));
        assert_eq!(preview_host_port("http://localhost:3000").unwrap(), ("localhost".into(), 3000));
        assert_eq!(preview_host_port("http://[::1]:8080/").unwrap(), ("::1".into(), 8080));
        assert_eq!(preview_host_port("https://127.0.0.1/").unwrap(), ("127.0.0.1".into(), 443));
        assert_eq!(preview_host_port("http://LOCALHOST:1/").unwrap().1, 1);
        for bad in ["http://example.com:80/", "http://10.0.0.2:3000", "http://127.0.0.1.evil.com:80/", "http://evil@127.0.0.1:80/",
                    "ftp://127.0.0.1:21", "file:///etc/passwd", "http://0.0.0.0:3000", "http://127.0.0.1:0/", "http://127.0.0.1:abc", "http://[::2]:80/", ""] {
            assert!(preview_host_port(bad).is_err(), "devia recusar {bad}");
            assert!(preview_alive_url(bad, 50).is_err());
        }
    }
    #[test]
    fn guess_from_package_json_and_python() {
        let d = tmp("guess");
        assert!(preview_guess(&d).is_none());
        std::fs::write(d.join("package.json"), r#"{"scripts":{"start":"node s.js","dev":"vite"}}"#).unwrap();
        assert_eq!(preview_guess(&d).unwrap().cmd, "npm run dev");
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(preview_guess(&d).unwrap().cmd, "pnpm dev");
        std::fs::remove_file(d.join("pnpm-lock.yaml")).unwrap();
        std::fs::write(d.join("package.json"), r#"{"scripts":{"start":"node s.js"}}"#).unwrap();
        std::fs::write(d.join("yarn.lock"), "").unwrap();
        assert_eq!(preview_guess(&d).unwrap().cmd, "yarn start");
        std::fs::write(d.join("package.json"), r#"{"devDependencies":{"vite":"5"}}"#).unwrap();
        assert_eq!(preview_guess(&d).unwrap().cmd, "npx vite");
        // front numa subpasta
        let d2 = tmp("guess2");
        std::fs::create_dir_all(d2.join("frontend")).unwrap();
        std::fs::write(d2.join("frontend/package.json"), r#"{"scripts":{"dev":"next dev"}}"#).unwrap();
        let g = preview_guess(&d2).unwrap();
        assert_eq!((g.cmd.as_str(), g.cwd.as_str(), g.guessed), ("npm run dev", "frontend", true));
        // python
        let d3 = tmp("guess3");
        std::fs::write(d3.join("manage.py"), "").unwrap();
        assert!(preview_guess(&d3).unwrap().cmd.contains("manage.py runserver"));
        let d4 = tmp("guess4");
        std::fs::write(d4.join("main.py"), "app = FastAPI()\n").unwrap();
        assert!(preview_guess(&d4).unwrap().cmd.contains("uvicorn main:app"));
        for x in [d, d2, d3, d4] { let _ = std::fs::remove_dir_all(x); }
    }
    #[test]
    fn json_wins_over_guess_and_cwd_is_confined() {
        let d = tmp("json");
        std::fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        std::fs::write(d.join(".cardume/preview.json"), r#"{"cmd":"npm run dev -- --port 5190","cwd":".","url":"http://127.0.0.1:5190/x","env":{"A":"1","PATH":"/nope","N":2}}"#).unwrap();
        let i = preview_info_for(&d, Some("http://127.0.0.1:9/".into())).unwrap();
        assert_eq!(i.cmd, "npm run dev -- --port 5190");
        assert_eq!(i.url.as_deref(), Some("http://127.0.0.1:5190/x"));
        assert!(!i.guessed);
        assert_eq!(i.env.get("A").map(|s| s.as_str()), Some("1"));
        assert_eq!(i.env.get("N").map(|s| s.as_str()), Some("2"));
        assert!(!i.env.contains_key("PATH"));
        // url de outro host no json é ignorada; a anunciada completa
        std::fs::write(d.join(".cardume/preview.json"), r#"{"cmd":"x","url":"http://evil.com/"}"#).unwrap();
        assert_eq!(preview_info_for(&d, Some("http://127.0.0.1:9/".into())).unwrap().url.as_deref(), Some("http://127.0.0.1:9/"));
        assert!(preview_cwd(&d, "../").is_err());
        assert!(preview_cwd(&d, "/etc").is_err());
        assert!(preview_cwd(&d, "nao-existe").is_err());
        assert_eq!(preview_cwd(&d, ".").unwrap(), d);
        let _ = std::fs::remove_dir_all(d);
    }
    /// Teste FUNCIONAL de verdade: sobe um http.server (python) via preview.json, espera
    /// ficar no ar, confere o log e derruba — nada fica rodando.
    #[test]
    fn real_start_alive_stop() {
        if Command::new("python3").arg("--version").output().is_err() { eprintln!("sem python3 — pulando"); return; }
        let d = tmp("real");
        let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
        let url = format!("http://127.0.0.1:{port}/");
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        std::fs::create_dir_all(d.join("site")).unwrap();
        std::fs::write(d.join("site/index.html"), "ola").unwrap();
        std::fs::write(d.join(".cardume/preview.json"), format!(r#"{{"cmd":"python3 -m http.server {port} --bind 127.0.0.1","cwd":"site","url":"{url}"}}"#)).unwrap();
        assert_eq!(preview_alive_url(&url, 300), Ok(false));
        let procs: Arc<Mutex<HashMap<String, i32>>> = Arc::new(Mutex::new(HashMap::new()));
        let info = preview_info_for(&d, None).unwrap();
        let pid = preview_spawn(&procs, "t1", &d, &info).unwrap();
        let mut up = false;
        for _ in 0..50 { if preview_alive_url(&url, 300) == Ok(true) { up = true; break; } std::thread::sleep(std::time::Duration::from_millis(200)); }
        assert!(up, "o http.server não subiu; log:\n{}", preview_tail(&d, 60));
        assert!(pid_alive(pid));
        assert!(preview_tail(&d, 60).contains("python3 -m http.server"));
        // nova subida mata a anterior (um preview por tarefa)
        assert!(preview_kill(&procs, "t1"));
        let mut down = false;
        for _ in 0..25 { if preview_alive_url(&url, 200) == Ok(false) { down = true; break; } std::thread::sleep(std::time::Duration::from_millis(200)); }
        assert!(down, "o preview não caiu depois do stop");
        assert!(!preview_kill(&procs, "t1"));
        // comando que morre na hora → exit registrado (a UI mostra "falhou" + log)
        std::fs::write(d.join(".cardume/preview.json"), r#"{"cmd":"echo quebrou; exit 3"}"#).unwrap();
        let info2 = preview_info_for(&d, None).unwrap();
        preview_spawn(&procs, "t2", &d, &info2).unwrap();
        let mut code = None;
        for _ in 0..25 { if let Some(c) = preview_exits().lock().unwrap().get("t2").copied() { code = Some(c); break; } std::thread::sleep(std::time::Duration::from_millis(100)); }
        assert_eq!(code, Some(Some(3)));
        assert!(preview_tail(&d, 60).contains("quebrou"));
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Túnel TLS do preview local pro CELULAR (cloudflared quick tunnel): URL
/// https aleatória e impossível de adivinhar, criptografia fim a fim da
/// Cloudflare. O processo fica rastreado como "tunnel:<task>" (parar mata).
#[tauri::command(async)]
fn tunnel_start(state: State<AppState>, task_id: String, url: String) -> Result<String, String> {
    let bin = ["/opt/homebrew/bin/cloudflared", "/opt/homebrew/opt/cloudflared/bin/cloudflared", "/usr/local/bin/cloudflared"]
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "cloudflared".to_string());
    // um túnel por tarefa: derruba o anterior se existir
    {
        let key = format!("tunnel:{task_id}");
        if let Ok(mut m) = state.procs.lock() {
            if let Some(old) = m.remove(&key) {
                signal_group(old, procsig::TERM);
            }
        }
    }
    // O --url do cloudflared precisa ser a ORIGEM (scheme://host:porta) — com
    // caminho ele registra mas não roteia (530). O caminho/subpágina volta na
    // URL pública pelo chamador. E o Host reescrito pro host local faz o Vite
    // (e afins) aceitarem a requisição sem nenhuma config no projeto.
    let rest = url.trim_start_matches("http://").trim_start_matches("https://");
    let host_header = rest.split('/').next().unwrap_or("127.0.0.1").to_string();
    let scheme = if url.starts_with("https://") { "https" } else { "http" };
    let origin = format!("{scheme}://{host_header}");
    let mut cmd = Command::new(&bin);
    // http2: o transporte QUIC dá 530 intermitente em algumas redes
    cmd.args(["tunnel", "--no-autoupdate", "--protocol", "http2", "--http-host-header", &host_header, "--url", &origin]);
    detach_new_group(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cloudflared não encontrado ({e}). Instale com: brew install cloudflared"))?;
    let pid = child.id() as i32;
    // cloudflared loga a URL pública no stderr — lê até achar (teto ~25s)
    let stderr = child.stderr.take().ok_or("sem stderr do cloudflared")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(m) = line.split_whitespace().find(|w| w.contains(".trycloudflare.com")) {
                let _ = tx.send(m.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ':' && c != '/' && c != '.' && c != '-').to_string());
            }
            if line.contains("ERR") {
                web_log(format!("[tunnel] {}", line.chars().take(200).collect::<String>()));
            }
        }
    });
    let public = match rx.recv_timeout(std::time::Duration::from_secs(25)) {
        Ok(p) => p,
        Err(_) => {
            signal_group(pid, procsig::KILL);
            return Err("o túnel não respondeu em 25s (rede?) — tente de novo".to_string());
        }
    };
    // HEALTH-CHECK: só entrega túnel que RESPONDE (DNS + conector prontos).
    // 530/000 são estados transitórios — insiste até ~90s; persiste = mata.
    let mut healthy = false;
    for _ in 0..18 {
        if let Ok(o) = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "--max-time", "8", "-w", "%{http_code}", &public])
            .output()
        {
            let code = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if code != "000" && code != "530" && code != "502" {
                healthy = true;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
    if !healthy {
        signal_group(pid, procsig::KILL);
        return Err("túnel criado mas não ficou acessível (530) — tente de novo".to_string());
    }
    if let Ok(mut m) = state.procs.lock() {
        m.insert(format!("tunnel:{task_id}"), pid);
    }
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(public)
}

/// Derruba o túnel da tarefa (se houver).
#[tauri::command(async)]
fn tunnel_stop(state: State<AppState>, task_id: String) -> Result<(), String> {
    if let Ok(mut m) = state.procs.lock() {
        if let Some(pid) = m.remove(&format!("tunnel:{task_id}")) {
            signal_group(pid, procsig::TERM);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // registra o bundle nas notificações UMA vez (senão a lib cai no Editor de Script)
    #[cfg(target_os = "macos")]
    let _ = mac_notification_sys::set_application("dev.constellation.app");
    web_log("[rust] app iniciou".to_string());
    // RUNTIME PRÓPRIO COM FOLGA: o padrão do Tauri tem 1 thread por núcleo (10 aqui) e os comandos
    // `#[tauri::command(async)]` síncronos rodam DIRETO nessas threads. Comandos que esperam algo externo
    // (IA, OAuth, processos) ocupavam as 10 e o snapshot nem executava — sonda registrou "runtime SATURADO:
    // tarefa não rodou em 60s" logo após os "snapshot demorou >8s" (24/09). 64 threads = sem fila.
    {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(64)
            .thread_name("constellation-rt")
            .enable_all()
            .build()
            .expect("runtime do app");
        tauri::async_runtime::set(rt.handle().clone());
        std::mem::forget(rt); // vive o app inteiro
    }
    // DIAGNÓSTICO: a cada 2s agenda uma tarefa vazia no runtime e mede quanto ela espera pra rodar.
    // Espera alta = threads do runtime todas ocupadas por comandos bloqueantes (o snapshot fica na fila).
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let t0 = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        tauri::async_runtime::spawn(async move { let _ = tx.send(()); });
        if rx.recv_timeout(std::time::Duration::from_secs(60)).is_err() { web_log("[rust] runtime SATURADO: tarefa não rodou em 60s".to_string()); continue; }
        let ms = t0.elapsed().as_millis();
        if ms > 500 { web_log(format!("[rust] runtime ocupado: tarefa esperou {ms}ms pra rodar")); }
    });
    // túneis órfãos de instâncias anteriores (setsid sobrevive ao app): limpa
    let _ = Command::new("pkill").args(["-f", "cloudflared tunnel --no-autoupdate"]).output();
    // Mac acordado enquanto o app estiver aberto: este Mac é quem atende os
    // pedidos do iPhone (task 'requested' ficava em "aguardando mac" com o Mac
    // em repouso). -i segura só o idle sleep; -w amarra à vida do processo —
    // fechou o app, o caffeinate morre junto. Tampa fechada dorme mesmo assim.
    let _ = Command::new("caffeinate").args(["-i", "-w", &std::process::id().to_string()]).spawn();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // resolve o motor bundlado pelo resolvedor de recursos do Tauri
            // (Contents/Resources no macOS; /usr/lib/<app> no .deb/.AppImage)
            use tauri::Manager;
            if let Ok(dir) = app.path().resource_dir() {
                let cand = dir.join("engine").join("cli.mjs");
                let _ = ENGINE_RESOURCE.set(cand.is_file().then_some(cand));
            }
            Ok(())
        })
        .manage(AppState::from_env())
        .invoke_handler(tauri::generate_handler![
            set_repo,
            memoria::memory_list,
            memoria::memory_read,
            memoria::memory_write,
            memoria::memory_delete,
            memoria::memory_move,
            memoria::memory_graph,
            memoria::memory_set_mode,
            memoria::memory_open_obsidian,
            mesa::mesa_ask,
            mesa::mesa_stop,
            mesa::mesa_resume,
            mesa::mesa_save,
            mesa::mesa_read,
            mesa::mesa_list,
            preview_alive,
            preview_info,
            preview_start,
            preview_stop,
            preview_log_tail,
            workspace_usage,
            workspace_clean,
            coordination_metrics,
            overlap_check,
            resolve_conflict,
            list_projects,
            projects_overview,
            repo_checks,
            checks_config,
            checks_save,
            task_fingerprint,
            run_checks,
            run_checks_stop,
            checks_override_log,
            deliverables_default_dir,
            save_deliverables,
            open_folder,
            file_diff,
            pr_body_ai,
            ai_spec,
            apns_push,
            read_policy,
            publish_release,
            repo_docs,
            repo_doc_write,
            read_llm_env,
            write_llm_env,
            route_ai_ping,
            list_skills,
            set_active_skills,
            set_issue_config,
            repo_remote_of,
            repo_remote_ids,
            tracker_local_get,
            tracker_local_set,
            tracker_bind_secret,
            tracker_secret_status,
            tracker_http,
            tracker_ai_build,
            issue_chat,
            issue_chat_stop,
            project_chat_stop,
            orq_chat_stop,
            create_skill,
            import_skill_md,
            git_skills,
            list_all_tasks,
            list_done_tasks,
            read_settings,
            write_setting,
            fetch_task_ref,
            slack_send_artifact,
            open_project,
            git_init_repo,
            create_project,
            quick_project_target,
            quick_create_project,
            reveal_project,
            ai_orchestrate,
            ai_orchestrate_chat,
            ai_file_why,
            ai_file_why_reset,
            orch_save,
            orch_list,
            orch_delete,
            patch_task_spec,
            orch_sync_base,
            orch_integrate,
            gh_accounts,
            gh_switch_account,
            gh_login_start,
            gh_login_status,
            gh_owners,
            switch_project,
            remove_project,
            snapshot,
            snapshot_stamp,
            task_events,
            build_info,
            graph,
            resolve_pending,
            add_instruction,
            rework_task,
            config,
            new_task,
            start_task,
            rerun_task,
            deliver_artifact,
            talk_task,
            review_pr,
            save_draft,
            load_draft,
            clear_draft,
            set_task_flag,
            mark_task_status,
            pause_task,
            resume_task,
            abort_task,
            stop_task,
            reorder_tasks,
            repo_remote,
            ai_chat,
            ai_chat_stop,
            ai_title,
            project_chat,
            is_dev_install,
            apply_update,
            notify_native,
            web_log,
            tunnel_start,
            tunnel_stop,
            open_url,
            publish_github,
            oauth_wait_callback,
            open_artifact,
            reveal_artifact,
            push_task,
            env_check,
            read_artifact_raw,
            ai_decompose,
            daily_digest,
            ai_daily,
            ai_daily_report,
            save_doc,
            html_to_pdf,
            task_files,
            read_file,
            write_file,
            rename_branch,
            read_ref,
            list_branches,
            open_pr,
            pr_compare_url,
            pr_status,
            pr_resolve_thread,
            merge_pr,
            rework_from_pr,
            merge_task,
            remove_task,
            pick_folder,
            pick_ref_files,
            import_attachment,
            import_attachment_data,
            write_ref_file,
            ai_task_report,
            set_task_model,
            write_artifact,
            save_config,
            import_agent_files,
            commit_detail,
            ai_commit_summary,
            commit_summary_cached,
            task_commits,
            list_artifacts,
            read_artifact
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Starfork")
        .run(|_app, event| {
            // app fechando → nenhum túnel fica exposto pra trás
            if let tauri::RunEvent::Exit = event {
                mesa::mesa_kill_all(); // personas da mesa rodam em grupo destacado: não sobrevivem ao app
                let _ = Command::new("pkill").args(["-f", "cloudflared tunnel --no-autoupdate"]).output();
            }
        });
}

#[cfg(test)]
mod cardume_hygiene_tests {
    use super::*;
    fn sh(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git");
        String::from_utf8_lossy(&o.stdout).to_string()
    }
    #[test]
    fn update_dest_rename_only_constellation_to_starfork() {
        let tmp = std::env::temp_dir().join(format!("cardume-upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let new_sf = PathBuf::from("/x/Starfork.app");
        // Constellation → Starfork
        let cur = tmp.join("Constellation.app");
        assert_eq!(update_dest(&cur, &new_sf), tmp.join("Starfork.app"));
        // mesmo nome → no lugar
        let cur_sf = tmp.join("Starfork.app");
        assert_eq!(update_dest(&cur_sf, &new_sf), cur_sf);
        // nome customizado → no lugar
        let custom = tmp.join("MyApp.app");
        assert_eq!(update_dest(&custom, &new_sf), custom);
        // irmão Starfork.app já existe → no lugar
        std::fs::create_dir_all(tmp.join("Starfork.app")).unwrap();
        assert_eq!(update_dest(&cur, &new_sf), cur);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn remove_worktree_dir_only_inside_cardume() {
        let tmp = std::env::temp_dir().join(format!("cardume-hyg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        sh(&tmp, &["init", "-q", "-b", "main"]);
        sh(&tmp, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
        let wt = tmp.join(".cardume").join("worktrees").join("t1");
        sh(&tmp, &["worktree", "add", "-q", "-b", "t1", wt.to_str().unwrap()]);
        std::fs::write(wt.join("sujeira.txt"), "x").unwrap(); // worktree suja: --force cobre
        std::fs::create_dir_all(wt.join(".cardume").join("tmp")).unwrap();
        assert!(wt.exists());
        assert!(dir_size(&wt) > 0);
        // guardas: nunca o repo, nunca fora de .cardume/{worktrees,reviews}
        assert!(!remove_worktree_dir(&tmp, &tmp));
        assert!(!remove_worktree_dir(&tmp, &tmp.join("src")));
        assert!(!remove_worktree_dir(&tmp, &tmp.join(".cardume").join("artifacts")));
        assert!(tmp.exists());
        // remoção real: some do disco e do registro do git
        assert!(remove_worktree_dir(&tmp, &wt));
        assert!(!wt.exists());
        assert_eq!(sh(&tmp, &["worktree", "list"]).lines().count(), 1);
        // órfã (pasta sem registro no git) também sai
        let orphan = tmp.join(".cardume").join("worktrees").join("orfa");
        std::fs::create_dir_all(orphan.join("node_modules")).unwrap();
        std::fs::write(orphan.join("node_modules").join("a.js"), "1").unwrap();
        assert!(remove_worktree_dir(&tmp, &orphan));
        assert!(!orphan.exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod pr_status_tests {
    use super::*;
    #[test]
    fn gh_sem_acesso_ao_repo_devolve_o_nome() {
        let e = "GraphQL: Could not resolve to a Repository with the name 'market4u-ti/loja'. (repository)";
        assert_eq!(gh_no_repo_access(e).as_deref(), Some("market4u-ti/loja"));
        assert_eq!(gh_no_repo_access("no pull requests found"), None);
    }
    #[test]
    fn review_threads_flatten_and_mark_answered_resolved() {
        let v = serde_json::json!({"data":{"viewer":{"login":"eu"},"repository":{"pullRequest":{"reviewThreads":{"nodes":[
            {"id":"PRRT_1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
                {"databaseId":10,"author":{"login":"coderabbitai[bot]"},"body":"troque X","path":"a.rs","line":3,"originalLine":3,"createdAt":"t","url":"u10"},
                {"databaseId":11,"author":{"login":"EU"},"body":"feito","path":"a.rs","line":null,"originalLine":3,"createdAt":"t","url":"u11"}]}},
            {"id":"PRRT_2","isResolved":true,"isOutdated":true,"comments":{"nodes":[
                {"databaseId":20,"author":{"login":"ana"},"body":"e isso?","path":"b.rs","line":null,"originalLine":7,"createdAt":"t","url":"u20"}]}},
            {"id":"PRRT_3","isResolved":false,"isOutdated":false,"comments":{"nodes":[
                {"databaseId":30,"author":{"login":"ana"},"body":"ok?","path":"c.rs","line":1,"originalLine":1,"createdAt":"t","url":"u30"},
                {"databaseId":31,"author":{"login":"bot"},"body":"✔ ajustado","path":"c.rs","line":1,"originalLine":1,"createdAt":"t","url":"u31"}]}},
            {"id":"PRRT_4","isResolved":false,"isOutdated":false,"comments":{"nodes":[
                {"databaseId":40,"author":{"login":"ana"},"body":"pendente","path":"d.rs","line":2,"originalLine":2,"createdAt":"t","url":"u40"}]}}
        ]}}}}});
        let cs = pr_parse_review_threads(&v, "eu");
        assert_eq!(cs.len(), 6);
        let root = |id: i64| cs.iter().find(|c| c.id == Some(id)).unwrap();
        assert!(root(10).answered && root(10).is_bot && root(10).in_reply_to.is_none());
        assert_eq!(root(11).in_reply_to, Some(10));
        assert_eq!(root(11).line, Some(3)); // line nulo cai no originalLine
        assert!(root(20).resolved && root(20).outdated && !root(20).answered);
        assert!(root(30).answered); // última começa com ✔
        assert!(!root(40).answered && !root(40).resolved);
        assert_eq!(root(40).thread_id.as_deref(), Some("PRRT_4"));
        assert_eq!(root(40).url, "u40");
    }
    #[test]
    fn own_lone_comment_is_not_answered() {
        // agente commitando com a SUA conta e você revisando o PR dele: seu comentário sozinho é pendência
        let v = serde_json::json!({"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
            {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
                {"databaseId":50,"author":{"login":"eu"},"body":"renomeie isto","path":"x.rs","line":1,"createdAt":"t","url":"u50"}]}},
            {"id":"T2","isResolved":false,"isOutdated":false,"comments":{"nodes":[
                {"databaseId":60,"author":{"login":"eu"},"body":"e aqui?","path":"y.rs","line":2,"createdAt":"t","url":"u60"},
                {"databaseId":61,"author":{"login":"eu"},"body":"ajustei","path":"y.rs","line":2,"createdAt":"t","url":"u61"}]}}
        ]}}}}});
        let cs = pr_parse_review_threads(&v, "eu");
        let root = |id: i64| cs.iter().find(|c| c.id == Some(id)).unwrap();
        assert!(!root(50).answered, "comentário solitário do próprio usuário não pode nascer respondido");
        assert!(root(60).answered, "resposta da sua conta na thread fecha");
        assert!(pr_thread_answered(1, "ana", "✔ feito", "eu"));
        assert!(!pr_thread_answered(1, "eu", "pendente", "eu"));
    }
    fn conv(id: i64, author: &str, body: &str, at: &str) -> PrComment {
        PrComment { id: Some(id), author: author.into(), body: body.into(), created_at: at.into(), is_bot: pr_is_bot(author),
            url: format!("https://github.com/o/r/pull/1#issuecomment-{id}"), ..Default::default() }
    }
    #[test]
    fn conversation_answered_only_by_later_check_comment() {
        let mut cs = vec![
            conv(1, "eu", "faltou o teste", "2026-01-01T10:00:00Z"),
            conv(2, "ana", "e a doc?", "2026-01-01T10:05:00Z"),
            conv(3, "eu", "✔ https://github.com/o/r/pull/1#issuecomment-1 adicionei o teste", "2026-01-01T11:00:00Z"),
            conv(4, "ana", "mais uma coisa", "2026-01-01T12:00:00Z"),
            conv(5, "bia", "✔ @ana doc feita", "2026-01-01T09:00:00Z"), // ANTES do comentário da ana: não fecha
        ];
        pr_mark_conv_answered(&mut cs, "eu");
        assert!(cs[0].answered, "✔ posterior que cita o link fecha");
        assert!(!cs[1].answered, "✔ que cita OUTRO comentário não fecha este (o da ana segue aberto)");
        assert!(cs[2].answered, "o próprio ✔ não é pendência");
        assert!(!cs[3].answered, "sem ✔ depois → aberto");
        let mut solo = vec![conv(7, "eu", "meu comentário", "2026-01-01T10:00:00Z")];
        pr_mark_conv_answered(&mut solo, "eu");
        assert!(!solo[0].answered, "autoria sozinha não marca respondido");
        // ✔ de terceiro só fecha se citar o comentário
        let mut cit = vec![conv(8, "ana", "x", "2026-01-01T10:00:00Z"), conv(9, "bia", "✔ @ana resolvido", "2026-01-01T11:00:00Z"),
            conv(10, "caio", "y", "2026-01-01T10:30:00Z")];
        pr_mark_conv_answered(&mut cit, "eu");
        assert!(cit[0].answered && !cit[2].answered);
    }
    #[test]
    fn reviews_superseded_and_open_asks() {
        let r = serde_json::json!([
            {"id":"R1","author":{"login":"ana"},"body":"mude X","state":"CHANGES_REQUESTED","submittedAt":"2026-01-01T10:00:00Z"},
            {"id":"R2","author":{"login":"ana"},"body":"","state":"APPROVED","submittedAt":"2026-01-02T10:00:00Z"},
            {"id":"R3","author":{"login":"bia"},"body":"mude Y","state":"CHANGES_REQUESTED","submittedAt":"2026-01-01T10:00:00Z"},
            {"id":"R4","author":{"login":"bia"},"body":"obs","state":"COMMENTED","submittedAt":"2026-01-03T10:00:00Z"},
            {"id":"R5","author":{"login":"caio"},"body":"ok","state":"APPROVED","submittedAt":"2026-01-01T10:00:00Z"}
        ]);
        let rs = pr_parse_reviews(&r, "u");
        assert_eq!(rs.len(), 4); // R2 sem texto fica de fora
        let get = |id: &str| rs.iter().find(|x| x.id == id).unwrap();
        assert!(get("R1").superseded, "aprovou depois → pedido antigo não vale");
        assert!(!get("R3").superseded, "COMMENTED depois não derruba o pedido de mudanças");
        let mk = |decision: &str| PrInfo {
            exists: true, number: 1, url: "u".into(), state: "OPEN".into(), decision: decision.into(), mergeable: String::new(), body: String::new(),
            comments: vec![], reviews: rs.clone(), is_draft: false, merge_state_status: String::new(), base_ref_name: String::new(),
            checks_total: 0, checks_fail: 0, checks_pending: 0, gh_user: String::new(),
        };
        let none = std::collections::HashSet::new();
        let info = mk("CHANGES_REQUESTED");
        let asks: Vec<&str> = pr_open_review_asks(&info, &none).iter().map(|r| r.id.as_str()).collect();
        assert_eq!(asks, vec!["R3"]);
        let ign: std::collections::HashSet<String> = ["R3".to_string()].into_iter().collect();
        assert!(pr_open_review_asks(&info, &ign).is_empty(), "ignorado na UI não vai pro agente");
        assert!(pr_open_review_asks(&mk("APPROVED"), &none).is_empty(), "PR aprovado → nada a reenviar");
        let c = PrComment { id: None, author: "ana".into(), body: "abc".into(), ..Default::default() };
        assert_eq!(pr_cmt_key(&c), "ana:abc");
    }
    #[test]
    fn checks_summary_counts_fail_and_pending() {
        let r = serde_json::json!([
            {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
            {"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"},
            {"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""},
            {"__typename":"StatusContext","state":"PENDING"},
            {"__typename":"StatusContext","state":"ERROR"}
        ]);
        assert_eq!(pr_checks_summary(&r), (5, 2, 2));
        assert_eq!(pr_checks_summary(&serde_json::Value::Null), (0, 0, 0));
    }
    #[test]
    fn no_pr_vs_network_error() {
        assert!(gh_says_no_pr("no pull requests found for branch \"x\""));
        assert!(gh_says_no_pr("none of the git remotes configured for this repository point to a known GitHub host"));
        assert!(!gh_says_no_pr("error connecting to api.github.com"));
        assert!(!gh_says_no_pr("HTTP 502: Bad Gateway"));
    }
}

#[cfg(test)]
mod motor_r7_tests {
    use super::{home_from, pr_merge_landed};

    #[test]
    fn pasta_do_usuario_no_windows_usa_userprofile() {
        // macOS/Linux: HOME; sem HOME, USERPROFILE
        assert_eq!(home_from(Some("/Users/ana".into()), Some("C:\\Users\\x".into()), false).as_deref(), Some("/Users/ana"));
        assert_eq!(home_from(None, Some("C:\\Users\\ana".into()), false).as_deref(), Some("C:\\Users\\ana"));
        // Windows: USERPROFILE primeiro (igual ao os.homedir() do Node — um HOME do Git Bash não desvia o cofre)
        assert_eq!(home_from(Some("/c/Users/ana".into()), Some("C:\\Users\\ana".into()), true).as_deref(), Some("C:\\Users\\ana"));
        assert_eq!(home_from(Some("/c/Users/ana".into()), None, true).as_deref(), Some("/c/Users/ana"));
        // vazio não conta; sem nenhum → None (quem chama registra o aviso)
        assert_eq!(home_from(Some("".into()), Some("C:\\Users\\ana".into()), false).as_deref(), Some("C:\\Users\\ana"));
        assert_eq!(home_from(None, None, false), None);
    }

    #[test]
    fn merge_do_pr_vale_quando_o_github_ja_mergeou() {
        assert!(pr_merge_landed(true, None));
        // gh falhou só ao apagar a branch local (presa na worktree) — o PR está MERGED
        assert!(pr_merge_landed(false, Some("MERGED\n")));
        assert!(!pr_merge_landed(false, Some("OPEN")));
        assert!(!pr_merge_landed(false, None));
    }
}
