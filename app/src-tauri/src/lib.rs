use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

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
        // Contents/MacOS/Constellation → Contents/Resources/engine/cli.mjs
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

/// Acha o binário do `claude` sem depender do PATH (que pode estar stale via
/// LSEnvironment): CARDUME_CLAUDE → ao lado do node → "claude" no PATH.
/// Acha o `gh` sem depender do PATH (LaunchServices pode lançar com PATH mínimo).
/// npm ao lado do node resolvido (nvm incluso) — app aberto pelo Finder tem
/// PATH mínimo e um `npm` seco dá "No such file or directory" (Mac do Paulo).
fn npm_cmd() -> Command {
    let nb = node_bin();
    let dir = std::path::Path::new(&nb).parent().map(|p| p.to_path_buf());
    let npm = dir.as_ref().map(|d| d.join("npm")).filter(|p| p.is_file())
        .map(|p| p.display().to_string())
        .or_else(|| ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"].iter().find(|p| std::path::Path::new(p).is_file()).map(|s| s.to_string()))
        .unwrap_or_else(|| "npm".into());
    let mut c = Command::new(npm);
    // scripts do npm precisam achar o node no PATH
    if let Some(d) = dir {
        let path = std::env::var("PATH").unwrap_or_default();
        c.env("PATH", format!("{}:{}", d.display(), path));
    }
    c
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
mod claude_json_tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    fn out(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec() }
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
            unsafe { libc::kill(pid, libc::SIGKILL); }
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

/// Envia um sinal ao GRUPO de processos (pid negativo) — atinge node + claude.
fn signal_group(pid: i32, sig: i32) {
    unsafe {
        libc::kill(-pid, sig);
    }
}

/// Spawna um processo de tarefa em um NOVO grupo (setsid) e o registra por id,
/// pra podermos pausar/abortar a árvore inteira. Uma thread limpa o registro
/// quando o processo termina naturalmente (evita PID reciclado no mapa).
fn spawn_tracked(state: &State<AppState>, task_id: &str, mut cmd: Command) -> Result<(), String> {
    // O APP é quem notifica (plugin Tauri, atribuído ao Constellation — clicar
    // abre o app). As do motor via osascript saem como "Editor de Script" e o
    // clique abre ele; caladas aqui. No CLI puro (sem app) elas continuam.
    cmd.env("CARDUME_NOTIFY", "0");
    // intervalo (min) pra retomar sozinho quando bate o limite de uso da IA
    if let Some(m) = setting_get("limitRetryMin") { cmd.env("CARDUME_LIMIT_RETRY_MIN", m); }
    unsafe {
        cmd.pre_exec(|| {
            // novo grupo/sessão: o node vira líder e o claude herda o grupo
            libc::setsid();
            Ok(())
        });
    }
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

#[derive(Serialize)]
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
    depends_on: Vec<String>,
    /// Um turno do MOTOR está rodando agora (lock busy_pid vivo) — pode ser um
    /// turno de fundo (verificar provas, rework) mesmo com status 'review'.
    busy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Review {
    task_id: String,
    summary: String,
    functions: serde_json::Value,
    files: serde_json::Value,
    how_to_test: String,
    by_agent: String,
}

#[derive(Serialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    id: i64,
    task_id: String,
    agent: String,
    path: String,
    mode: String,
    yielded_to: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diff {
    task_id: String,
    files: i64,
    additions: i64,
    deletions: i64,
}

#[derive(Serialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cost {
    task_id: String,
    agent: String,
    role: Option<String>,
    usd: f64,
    in_tok: i64,
    out_tok: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    repo: Option<String>,
    /// false = pasta aberta sem repositório git (sem branch/PR/worktree até criar um)
    git: bool,
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

#[tauri::command]
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
    let (branch, base): (String, String) = conn
        .query_row("SELECT branch, base FROM task WHERE id=?1", params![task_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
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

#[tauri::command(async)]
fn current_repo(state: State<AppState>) -> Option<String> {
    state
        .db
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|r| r.display().to_string()))
}

/// Resolve o repo do projeto ativo (parent do .cardume/state.sqlite).
fn active_repo(state: &State<AppState>) -> Result<PathBuf, String> {
    let dbpath = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    dbpath.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()).ok_or_else(|| "repo inválido".to_string())
}

/// Métricas de coordenação (conflitos, colisões, reworks) — baseline do "caos".
/// Proxy do CLI `cardume metrics --json`: a lógica mora no núcleo TS (fonte única).
#[tauri::command(async)]
fn coordination_metrics(state: State<AppState>) -> Result<String, String> {
    let repo = active_repo(&state)?;
    let out = Command::new(node_bin())
        .args([
            "--disable-warning=ExperimentalWarning".to_string(),
            cli_path(&repo),
            "metrics".to_string(),
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
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
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

/// Abre um projeto: valida git, inicializa o workspace Cardume se preciso,
/// torna-o o projeto ativo e adiciona ao topo da lista.
#[tauri::command]
fn open_project(state: State<AppState>, path: String) -> Result<String, String> {
    open_project_at(&state, &path)
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
    if !has_ident { c.args(["-c", "user.name=Constellation", "-c", "user.email=constellation@local"]); }
    let out = c.args(["commit", "-q", "-m", "chore: início do repositório (Constellation)"]).output().map_err(|e| e.to_string())?;
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
        return Err("workspace Cardume não pôde ser criado".to_string());
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
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        return Err("dê um nome ao projeto".into());
    }
    let parent_p = PathBuf::from(&parent);
    if !parent_p.is_dir() {
        return Err(format!("pasta não existe: {parent}"));
    }
    let repo = parent_p.join(&slug);
    if repo.exists() {
        return Err(format!("já existe uma pasta {} em {}", slug, parent));
    }
    std::fs::create_dir_all(&repo).map_err(|e| format!("não consegui criar a pasta: {e}"))?;
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
    run(&["init", "-b", "main"])?;
    std::fs::write(repo.join("README.md"), format!("# {}

Projeto criado pelo Constellation.
", name.trim()))
        .map_err(|e| e.to_string())?;
    std::fs::write(repo.join(".gitignore"), ".DS_Store
node_modules/
.env
.cardume/
").map_err(|e| e.to_string())?;
    run(&["add", "-A"])?;
    run(&["-c", "user.name=Constellation", "-c", "user.email=constellation@local", "commit", "-q", "-m", "chore: projeto criado pelo Constellation"])
        .or_else(|_| run(&["commit", "-q", "-m", "chore: projeto criado pelo Constellation"]))?;
    if github {
        let full = if owner.trim().is_empty() { slug.clone() } else { format!("{}/{}", owner.trim(), slug) };
        let mut c = Command::new(gh_bin());
        c.args(["repo", "create", &full, if private { "--private" } else { "--public" }, "--source", &repo.display().to_string(), "--remote", "origin", "--push"]);
        c.current_dir(&repo);
        let out = output_timeout(c, 120)?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "pasta e git criados em {}, mas o GitHub falhou: {}\n\nConfira a conta ativa do gh em Configurações → GitHub.",
                repo.display(),
                err
            ));
        }
    }
    open_project_at(&state, &repo.display().to_string())
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
#[tauri::command]
fn switch_project(state: State<AppState>, path: String) -> Result<String, String> {
    let db = PathBuf::from(&path).join(".cardume").join("state.sqlite");
    if !db.exists() {
        return Err(format!("sem workspace Cardume em {path}"));
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
#[tauri::command]
fn remove_project(path: String) -> Vec<String> {
    let mut list = read_project_list();
    list.retain(|p| p != &path);
    write_project_list(&list);
    list
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
    if let Some(db) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
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
    let path = artifact_path(&state, &task_id, &name)?;
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

#[tauri::command(async)]
fn snapshot(state: State<AppState>) -> Result<Snapshot, String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let path = match path {
        Some(p) => p,
        None => {
            return Ok(Snapshot {
                repo: None,
                git: true,
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

    // busy_pid pode não existir em DB de motor antigo (migração é do motor; aqui é read-only)
    let has_busy: bool = conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('task') WHERE name='busy_pid'", [], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false);
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
                depends_on: spec.get("dependsOn").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(),
                busy: r
                    .get::<_, Option<i64>>(16)
                    .unwrap_or(None)
                    .map(|pid| unsafe { libc::kill(pid as i32, 0) } == 0)
                    .unwrap_or(false),
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

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

    let reviews = conn
        .prepare("SELECT task_id,summary,functions_json,files_json,how_to_test,by_agent FROM review")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            let fj: String = r.get(2)?;
            let flj: String = r.get(3)?;
            Ok(Review {
                task_id: r.get(0)?,
                summary: r.get(1)?,
                functions: serde_json::from_str(&fj).unwrap_or(serde_json::Value::Array(vec![])),
                files: serde_json::from_str(&flj).unwrap_or(serde_json::Value::Array(vec![])),
                how_to_test: r.get(4)?,
                by_agent: r.get(5)?,
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

    let git = repo.as_deref().map(repo_is_git).unwrap_or(true);
    Ok(Snapshot { repo, git, tasks, events, claims, diffs, reviews, pending, costs })
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
#[tauri::command]
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
#[tauri::command]
fn rerun_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let repo = repo_of(&state)?;
    // 1) encerra o processo atual, se houver
    if let Some(p) = { state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied() } {
        signal_group(p, libc::SIGCONT);
        signal_group(p, libc::SIGTERM);
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
    let _ = conn.execute("UPDATE task SET done_roles=0, status='queued', session_id=NULL WHERE id=?1", params![task_id]);
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
#[tauri::command]
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
#[tauri::command]
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
    let home = std::env::var("HOME").unwrap_or_default();
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
#[tauri::command]
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
) -> Result<String, String> {
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
/// identifica o "projeto" no time da nuvem, independente de https/ssh.
#[tauri::command(async)]
fn repo_remote(state: State<AppState>) -> Result<String, String> {
    remote_of_path(&repo_of(&state)?)
}

/// Mesma identidade, pra QUALQUER projeto da lista local (painel de Issues: conectar vários).
#[tauri::command(async)]
fn repo_remote_of(path: String) -> Result<String, String> {
    remote_of_path(&PathBuf::from(path))
}

fn remote_of_path(repo: &PathBuf) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C").arg(repo)
        .args(["config", "--get", "remote.origin.url"])
        .output()
        .map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        // sem remote: usa o nome da pasta como identidade local
        return Ok(format!("local/{}", repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()));
    }
    let mut s = raw.trim_end_matches(".git").to_string();
    if let Some(rest) = s.strip_prefix("git@") {
        s = rest.replacen(':', "/", 1);
    } else {
        for p in ["https://", "http://", "ssh://git@", "ssh://"] {
            if let Some(rest) = s.strip_prefix(p) { s = rest.to_string(); break; }
        }
    }
    Ok(s)
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
#[tauri::command]
fn start_task(state: State<AppState>, task_id: String) -> Result<(), String> {
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
fn mark_task_status(state: State<AppState>, task_id: String, status: String) -> Result<(), String> {
    if !["review", "merged", "draft", "running", "cancelled"].contains(&status.as_str()) {
        return Err(format!("status inválido: {status}"));
    }
    // cancelar = parar o agente se estiver rodando (como abortar, mas com rótulo próprio)
    if status == "cancelled" {
        let pid = { state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied() };
        if let Some(p) = pid {
            signal_group(p, libc::SIGCONT); // destrava se pausado
            signal_group(p, libc::SIGTERM);
            let procs = state.procs.clone();
            let tid = task_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                signal_group(p, libc::SIGKILL);
                if let Ok(mut m) = procs.lock() {
                    if m.get(&tid) == Some(&p) { m.remove(&tid); }
                }
            });
        }
    }
    set_task_status(&state, &task_id, &status)?;
    if status == "merged" || status == "cancelled" {
        if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
                let _ = conn.execute("DELETE FROM claim WHERE task_id=?1", params![task_id]);
                let _ = conn.execute("DELETE FROM pending WHERE task_id=?1", params![task_id]);
                // mergeada: a worktree já não serve — cancelada fica (dá pra retomar/inspecionar; a limpeza manual tira)
                if status == "merged" { if let Ok(repo) = repo_of(&state) { remove_task_worktree(&repo, &conn, &task_id); } }
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

/// Congela a árvore de processos do agente (SIGSTOP no grupo) e marca 'paused'.
#[tauri::command]
fn pause_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let pid = state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied();
    match pid {
        Some(p) => {
            signal_group(p, libc::SIGSTOP);
            set_task_status(&state, &task_id, "paused")
        }
        None => Err("tarefa não está em execução".to_string()),
    }
}

/// Retoma a árvore congelada (SIGCONT) e volta pra 'running' — o orquestrador
/// segue e atualiza o status conforme avança nas etapas.
#[tauri::command]
fn resume_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let pid = state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied();
    match pid {
        Some(p) => {
            signal_group(p, libc::SIGCONT);
            set_task_status(&state, &task_id, "running")
        }
        None => Err("tarefa não está pausada".to_string()),
    }
}

/// PARA o turno atual do agente (ex.: no chat, pra intervir) sem "abortar" a
/// tarefa: mata o processo em execução e volta o status pra 'review', deixando a
/// worktree e os registros como estão — aí o humano manda uma nova mensagem.
#[tauri::command]
fn stop_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let mut pid = { state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied() };
    // App reiniciado perde o mapa de processos, mas o turno do MOTOR continua
    // vivo (setsid) — fallback: o lock busy_pid do banco diz quem matar.
    if pid.is_none() {
        if let Ok(db) = state.db.lock() {
            if let Some(path) = db.clone() {
                if let Ok(conn) = open(&path) {
                    if let Ok(Some(bp)) = conn
                        .query_row("SELECT busy_pid FROM task WHERE id = ?1", params![task_id], |r| {
                            r.get::<_, Option<i64>>(0)
                        })
                    {
                        let bp = bp as i32;
                        if unsafe { libc::kill(bp, 0) } == 0 {
                            pid = Some(bp);
                        }
                    }
                }
            }
        }
    }
    if let Some(p) = pid {
        signal_group(p, libc::SIGCONT);
        signal_group(p, libc::SIGTERM);
        let procs = state.procs.clone();
        let tid = task_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            signal_group(p, libc::SIGKILL);
            if let Ok(mut m) = procs.lock() {
                if m.get(&tid) == Some(&p) {
                    m.remove(&tid);
                }
            }
        });
    }
    // volta pra review (não 'aborted') pra poder continuar conversando
    set_task_status(&state, &task_id, "review")?;
    Ok(())
}

/// Aborta a tarefa: mata a árvore de processos (SIGCONT p/ destravar + SIGTERM,
/// e SIGKILL após um respiro), marca 'aborted' e libera os claims de arquivo
/// pra não travar outros agentes. A worktree é preservada pra inspeção.
#[tauri::command]
fn abort_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let pid = { state.procs.lock().unwrap_or_else(|e| e.into_inner()).get(&task_id).copied() };
    if let Some(p) = pid {
        signal_group(p, libc::SIGCONT); // caso esteja pausado, destrava pra poder morrer
        signal_group(p, libc::SIGTERM);
        let procs = state.procs.clone();
        let tid = task_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            signal_group(p, libc::SIGKILL);
            if let Ok(mut m) = procs.lock() {
                if m.get(&tid) == Some(&p) {
                    m.remove(&tid);
                }
            }
        });
    }
    set_task_status(&state, &task_id, "aborted")?;
    // libera claims de arquivo + perguntas pendentes desta tarefa (best-effort)
    if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
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
            "SELECT text FROM event WHERE task_id=?1 AND ts>=?2 AND ts<?3 AND type IN ('status','note') AND text NOT LIKE '⏳%' AND text NOT LIKE '▶%' ORDER BY id",
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
    let sys = "Você é o ORQUESTRADOR do Constellation. O usuário descreve um problema inteiro; você o quebra em FASES e cada fase vira uma tarefa real com branch e worktree próprias, executada por um subagente. Você NUNCA escreve código — só planeja. Pode explorar o repositório (Read, Grep, Glob) antes de responder pra citar arquivos, serviços e testes REAIS. Responda SOMENTE com um bloco de código ```json no formato {\"title\":\"nome curto do plano\",\"summary\":\"1-2 frases explicando o plano\",\"phases\":[{\"key\":\"n1\",\"name\":\"nome curto da fase\",\"kind\":\"invest|design|build|review\",\"agent\":\"Investigador|Designer|Coder|Revisor\",\"objective\":\"o que essa fase entrega, em 1-3 frases\",\"objectives\":[\"critério verificável 1\",\"critério 2\"],\"autonomy\":\"ask|free\",\"dependsOn\":[\"n0\"]}]}. Regras: 2 a 6 fases; keys n1..n6; kind invest = investigação sem mexer em código (gera INVESTIGATION.md com evidência), design = proposta/desenho (DESIGN.md), build = implementação com testes e prova, review = revisar e provar a implementação de outra fase. INTEGRAÇÃO: sempre que houver 2 ou mais fases build, a ÚLTIMA fase do plano deve ser uma review que dependa de TODAS as fases build — ela recebe uma branch criada a partir da main com o merge de todas as branches de build, testa tudo junto (suite + UI real) e é dela que sai o Pull Request final; as fases build NÃO abrem PR próprio. Com uma única fase build, a review final é opcional. Cada fase tem 2 a 5 objetivos VERIFICÁVEIS (algo que dá pra provar com print, teste ou arquivo). dependsOn lista as fases que precisam PROVAR o resultado antes desta começar; fases sem dependência rodam em paralelo — use paralelismo quando os escopos são disjuntos. autonomy \"ask\" quando a fase toma decisão que é do usuário (ex.: escolher a correção), \"free\" quando pode seguir sozinha. Nada de texto fora do bloco json.";
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        briefing,
        "--output-format".to_string(),
        "json".to_string(),
        "--append-system-prompt".to_string(),
        sys.to_string(),
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
#[tauri::command]
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

#[tauri::command]
fn orch_delete(state: State<AppState>, id: String, repo: Option<String>) -> Result<(), String> {
    if !orch_ok_id(&id) { return Err("id inválido".into()); }
    let repo = repo_or(&state, repo)?;
    let p = orch_dir(&repo).join(format!("{id}.json"));
    if p.exists() { std::fs::remove_file(p).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Funde chaves no spec_json da tarefa (ex.: orchestration, dependsOn) e,
/// se vier `base`, troca a branch base da worktree (fase que parte da anterior).
#[tauri::command]
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
#[tauri::command]
fn save_doc(name: String, content: String) -> Result<String, String> {
    let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Documents").join("Constellation");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '-'|'_'|'.'|' ') { c } else { '-' }).collect();
    let p = dir.join(safe.trim());
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(not(target_os = "macos"))]
    let _ = Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    Ok(p.display().to_string())
}

/// Gera um PDF a partir de HTML (headless Chrome), salva em ~/Documents/Constellation/ e abre.
#[tauri::command(async)]
fn html_to_pdf(html: String, name: String) -> Result<String, String> {
    let chrome = chrome_bin().ok_or("Google Chrome não encontrado — instale o Chrome pra gerar PDF")?;
    let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Documents").join("Constellation");
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
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&pdf_path).spawn(); // abre no Preview
    #[cfg(not(target_os = "macos"))]
    let _ = Command::new("xdg-open").arg(&pdf_path).spawn(); // abre no leitor de PDF padrão
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
        "Você é um tech lead quebrando um trabalho grande em tarefas que AGENTES DE IA executarão EM PARALELO (cada uma vira branch + worktree própria; tarefas da mesma onda rodam AO MESMO TEMPO). Com base no contexto, proponha de 3 a 7 tarefas organizadas em ONDAS:\n\
         - wave 1 = tarefas SEM dependência entre si, que podem começar juntas AGORA;\n\
         - wave 2+ = dependem de ondas anteriores;\n\
         - dentro da MESMA onda, os escopos de arquivos (owns) têm que ser DISJUNTOS — duas tarefas da mesma onda NUNCA tocam a mesma pasta/arquivo (senão dá conflito de merge);\n\
         - cada tarefa tem o SEU entregável separado e requisitos VERIFICÁVEIS próprios (2 a 4, frases completas que alguém marca ✓/✗ testando).\n\
         Responda SOMENTE um JSON array válido, sem markdown:\n\
         [{{\"title\":\"verbo + objeto (máx 60 chars)\",\"objective\":\"2-4 frases: o que fazer, onde, e qual o entregável desta tarefa\",\"requirements\":[\"critério verificável\"],\"owns\":\"pastas/arquivos que ela reivindica, separados por vírgula (deduza do contexto; vazio se não der)\",\"wave\":1}}]{guide}\n\nCONTEXTO:\n{ctx}"
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

#[tauri::command(async)]
fn ai_chat(state: State<AppState>, prompt: String, session_id: Option<String>) -> Result<AiChat, String> {
    let repo = repo_of(&state)?;
    let sys = "Você é o PLANNER do Constellation: monta a ESPECIFICAÇÃO de uma tarefa conversando com o Douglas, em português, de forma ANALÍTICA e INVESTIGATIVA, UMA pergunta por vez e AFIADA, fechando só o que ainda falta — e chegando no PROBLEMA REAL, não só no que ele pediu. INVESTIGUE o código de verdade (Read/Grep/Glob/LS, git log/show/diff) ANTES de perguntar o óbvio: NADA de chutar; cite arquivo:linha quando ajudar e prefira DESCOBRIR lendo a perguntar o que dá pra ver no código. Mas investigue com PARCIMÔNIA: poucas leituras DIRECIONADAS (nunca varredura exaustiva do repo), e se a mensagem for SAUDAÇÃO/conversa fiada ou você ainda NÃO tiver um problema concreto pra apurar, responda DIRETO e rápido SEM usar ferramentas — só investigue quando já houver um problema/tarefa concreto. Vá atrás da CAUSA, não do sintoma: se o Douglas já traz uma solução, entenda antes o PROBLEMA por trás (o que acontece, o que deveria acontecer, por que importa) e desafie suposições com gentileza. Faça POUCAS perguntas, porém afiadas — só o que muda a solução. MÉTODO por tipo de tarefa: (a) BUG/FIX — levante os passos pra REPRODUZIR, o esperado vs o obtido e desde quando; leia o código suspeito e proponha a CAUSA-RAIZ (não o remendo); os requirements devem incluir um TESTE que falha hoje e passa depois + um guard contra regressão. (b) FEATURE — use Jobs-to-be-Done: QUEM é o usuário, qual a TAREFA/resultado que ele quer, e COMO saberemos que resolveu; requirements são critérios de aceite VERIFICÁVEIS (Dado/Quando/Então) cobrindo estados vazio/carregando/erro e casos de borda. (c) REFACTOR/CHORE/DESIGN — qual a DOR concreta e o ALVO, e como PROVAR que o comportamento não mudou (antes/depois). Responda SEMPRE E SOMENTE com um bloco de código ```json contendo as chaves {\"say\":\"\",\"chips\":[],\"patch\":{},\"asking\":\"\",\"done\":false} (e OPCIONALMENTE \"plan\") — nada fora do bloco. Regras: `say` é sua próxima fala curta e objetiva (a pergunta que falta, ou uma confirmação de que pode criar). `chips` são 0 a 4 respostas rápidas sugeridas pra essa pergunta (strings curtas). `patch` contém SÓ os campos que ficaram claros nesta rodada — chaves possíveis: title (string), objective (string), deliverables (array de strings), requirements (array de strings), owns (array de caminhos), off (array de caminhos), engine (string), autonomy (string curta, ex.: \"clarifications: ask\"), artifacts (array com qualquer combinação de \"doc\", \"proof\", \"tests\"); NÃO invente, deixe de fora o que não sabe. `asking` é o nome do campo que você está perguntando AGORA (um de: title, objective, deliverables, requirements, owns, off, autonomy, engine, artifacts) ou \"\". `done` só vira true quando title, objective e deliverables estiverem fechados E o usuário confirmar que pode criar. Se ainda não houver objetivo, comece perguntando o objetivo. Antes de fechar, SEMPRE pergunte quais ENTREGÁVEIS DE COMPROVAÇÃO o usuário quer — documento de arquitetura (doc), prints de prova (proof) e/ou testes (tests) — e grave a escolha em patch.artifacts. Se o usuário não souber um critério, sugira `autonomy: clarifications: ask`. ÉPICO: quando o pedido do usuário for GRANDE e envolver VÁRIAS FRENTES independentes que podem virar entregas separadas rodando EM PARALELO (ex.: 'refaz a tela de login, o backend de auth e a doc'), NÃO tente fechar uma tarefa só — proponha um ÉPICO retornando a chave `plan` = {\"epic\":\"nome curto do épico\",\"tasks\":[{\"title\":\"\",\"objective\":\"\",\"requirements\":[\"critério verificável\"],\"owns\":\"caminho(s) que essa tarefa mexe\",\"wave\":1}]} com 2 a 6 tarefas. `wave` agrupa o que roda junto: tarefas da MESMA onda têm escopos DISJUNTOS (owns não se sobrepõem) e rodam ao mesmo tempo; ondas maiores dependem das anteriores. Ao propor `plan`, use `say` pra explicar o plano em 1-2 frases, deixe `done`:false e NÃO preencha os campos de tarefa única em patch — espere o usuário aprovar o plano na tela. Se o pedido for pequeno (uma frente só), siga o fluxo normal de tarefa única sem `plan`. Nada de texto fora do bloco json.";
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "json".to_string(),
        "--append-system-prompt".to_string(),
        sys.to_string(),
        // read-only: o planner INVESTIGA o código (lê/grep/git) mas NÃO edita nada.
        "--allowedTools".to_string(),
        "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(git grep:*)".to_string(),
        // sem isto o harness NEGA ler prints anexados fora do repo (Desktop etc.)
        // — o planner precisa VER o print pra extrair o contexto.
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
    ];
    if let Some(sid) = &session_id {
        if !sid.is_empty() {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }
    }
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    let out = output_timeout(cmd, 150)?; // investigar o código leva um pouco mais
    let v = claude_json(&out)?;
    Ok(AiChat {
        text: v["result"].as_str().unwrap_or("").to_string(),
        session_id: v["session_id"].as_str().unwrap_or("").to_string(),
    })
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
        "Você é o ORQUESTRADOR do Constellation conversando com o dev em português sobre o PROJETO aberto e o PLANO que você propôs. ",
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
    let out = output_timeout(cmd, 300)?;
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
    let zip = root.join("dist").join("Constellation-portable.zip");
    let bin = root.join("dist").join("Constellation-portable.app").join("Contents").join("MacOS").join("Constellation");
    if !zip.exists() { return Err(format!("rode scripts/package-app.sh antes — sem {}", zip.display())); }
    let mtime_ms = |p: &PathBuf| -> Option<i64> {
        std::fs::metadata(p).and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
    };
    let build_ms = mtime_ms(&bin).ok_or("binário do portable não encontrado")?;
    // GUARD: se o app DEV (deploy-local) é bem mais novo que o portable, o pacote
    // está DEFASADO — publicar mandaria um build velho pros colegas. Barra.
    let dev_bin = root.join("dist").join("Constellation.app").join("Contents").join("MacOS").join("Constellation");
    if let Some(dev_ms) = mtime_ms(&dev_bin) {
        // 30min de folga: ignora o skew de reempacotar+redeploy na mesma sessão,
        // mas pega o caso real (portable de dias atrás, esquecido).
        if dev_ms > build_ms + 1_800_000 {
            return Err("o pacote portable está DEFASADO (seu build atual é bem mais novo) — rode `scripts/package-app.sh` pra reempacotar com o código de agora ANTES de publicar, senão os colegas recebem uma versão antiga.".to_string());
        }
    }
    let size = std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    // 1) zip
    let mut c1 = Command::new("curl");
    c1.args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
        "-H", &format!("apikey: {anon}"), "-H", &format!("Authorization: Bearer {token}"),
        "-H", "x-upsert: true", "-H", "Content-Type: application/zip",
        "--data-binary"]).arg(format!("@{}", zip.display()))
        .arg(format!("{url}/storage/v1/object/releases/Constellation-portable.zip"));
    let r1 = output_timeout(c1, 300)?;
    let code1 = String::from_utf8_lossy(&r1.stdout).trim().to_string();
    if code1 != "200" { return Err(format!("upload do zip falhou (HTTP {code1}) — você é o owner do canal?")); }
    // 2) latest.json
    let d = build_ms / 1000;
    let version = {
        let out = Command::new("date").args(["-r", &d.to_string(), "+%d/%m %H:%M"]).output().map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let meta = serde_json::json!({
        "buildMs": build_ms, "version": version, "file": "Constellation-portable.zip",
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
    Ok(format!("release {version} publicada ({:.1} MB) — os apps do time mostram ⬆ atualizar no próximo boot ou em até 6h", size as f64 / 1048576.0))
}
fn chrono_iso_now() -> String {
    let out = Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output().ok();
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// Memória do repo (.cardume) que SEGUE a conta do usuário — o JS sincroniza
/// com user_repo_docs na nuvem (mais novo vence, dos dois lados).
const REPO_DOCS: [&str; 5] = ["RUNBOOK.md", "HISTORY.md", "SPEC.md", "PREFS.md", "policy.json"];
#[tauri::command]
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
#[tauri::command]
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
fn artifact_path(state: &State<AppState>, task_id: &str, name: &str) -> Result<PathBuf, String> {
    if !artifact_name_ok(name) {
        return Err("nome de artefato inválido".into());
    }
    let name = name.trim();
    // worktree AO VIVO primeiro (é a versão mais nova), depois a cópia coletada
    if let Some(db) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
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
    Err("artefato não encontrado".into())
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
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".constellation").join("llm.env")
}
#[tauri::command]
fn read_llm_env() -> Result<String, String> {
    Ok(std::fs::read_to_string(llm_env_path()).unwrap_or_default())
}
#[tauri::command]
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

/// Config de "criar issue ao abrir demanda" deste repo (espelho local do que o
/// time compartilha na nuvem). O motor lê esse arquivo em Orchestrator.issueContext.
#[tauri::command]
fn get_issue_config(state: State<AppState>) -> Result<serde_json::Value, String> {
    let p = issue_json_path(&state)?;
    let txt = std::fs::read_to_string(&p)
        .unwrap_or_else(|_| "{\"enabled\":false,\"instructions\":\"\",\"titleTemplate\":\"\",\"bodyTemplate\":\"\"}".into());
    Ok(serde_json::from_str(&txt).unwrap_or_else(|_| serde_json::json!({ "enabled": false, "instructions": "", "titleTemplate": "", "bodyTemplate": "" })))
}

/// Grava a config de issue do repo (o app mantém isto sincronizado com a nuvem).
#[tauri::command]
fn set_issue_config(state: State<AppState>, config: serde_json::Value) -> Result<(), String> {
    let p = issue_json_path(&state)?;
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Painel de Issues: conexão genérica com um tracker (conector declarativo) =====
fn constellation_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".constellation")
}

/// Cache local do painel de issues do time (a nuvem — issue_trackers — é a fonte;
/// sem nuvem, vale só nesta máquina). Nunca contém o VALOR de chaves.
#[tauri::command]
fn tracker_local_get() -> Result<serde_json::Value, String> {
    let txt = std::fs::read_to_string(constellation_home().join("issue-tracker.json")).unwrap_or_else(|_| "null".into());
    Ok(serde_json::from_str(&txt).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
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
#[tauri::command]
fn tracker_bind_secret(name: String, host: String) -> Result<(), String> {
    let p = tracker_binds_path();
    let mut m: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&p).ok()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    m.insert(name, serde_json::Value::String(host.to_lowercase()));
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(&p, serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Quais chaves (só NOMES) existem no cofre local e a que host cada uma está vinculada.
#[tauri::command]
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
    let mut child = Command::new("curl")
        .args(["-sS", "--max-time", "30", "-w", "\n%{http_code}", "--config", "-"])
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
    if !files.is_empty() { c.args(["--allowedTools", "Read", "--permission-mode", "bypassPermissions"]); }
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
    let mut args: Vec<String> = vec![
        "-p".to_string(), prompt,
        "--output-format".to_string(), "json".to_string(),
        "--append-system-prompt".to_string(), sys,
        "--allowedTools".to_string(),
        "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(git grep:*)".to_string(),
        "--permission-mode".to_string(), "bypassPermissions".to_string(),
    ];
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) { args.push("--model".to_string()); args.push(m); }
    if let Some(sid) = &session_id { if !sid.is_empty() { args.push("--resume".to_string()); args.push(sid.clone()); } }
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(&args).current_dir(&repo);
    cmd.process_group(0); // grupo próprio: o "parar" derruba o claude E o que ele tiver aberto
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    let pid = child.id() as i32;
    ISSUE_CHAT_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(600)).is_err() { signal_group(pid, libc::SIGKILL); }
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
#[tauri::command]
fn issue_chat_stop() -> bool {
    let pid = ISSUE_CHAT_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 { signal_group(pid, libc::SIGKILL); true } else { false }
}

const ISSUE_CHAT_PROMPT: &str = r#"Você monta ISSUES pro painel do time conversando com o dev, em português, no projeto aberto nesta pasta. O dev manda UMA ideia ou uma LISTA (várias linhas = várias issues). Seu trabalho é FECHAR AS ARESTAS de cada uma antes de criar: PESQUISE o código de verdade (Read/Grep/Glob/LS, git log/show/grep) — onde isso mora, o que já existe, o que está faltando, qual a causa provável — com PARCIMÔNIA (poucas leituras direcionadas por issue, nunca varredura do repo). Você NÃO edita nada.
Para cada issue produza: title (verbo no infinitivo + objeto específico, máx 80 chars), description (2-5 frases: o problema/pedido, ONDE no código — cite arquivo:linha quando achar — e a abordagem provável), requirements (2-5 critérios de aceite VERIFICÁVEIS), goal (critério de pronto em 1 frase), assignee (SÓ se o dev disser quem é o responsável; use o nome/e-mail exatamente como ele disse ou como aparece em `people` do contexto; senão ""), priority (só se o dev disser; use um dos valores de `priorities` do contexto), type (um dos `types` do contexto — ex.: bug quando for defeito; "" se o painel não tiver tipos), open (perguntas que SÓ o dev sabe responder e que mudam o escopo; [] se fechou).
Não invente: o que o código não responde vira pergunta em `open`. Pergunte POUCO e agrupado — no `say`, faça no máximo 1-3 perguntas por rodada, as que mais mudam o escopo, dizendo de qual issue é cada uma. Se a lista tiver itens duplicados ou que já existem no painel (veja `existing` no contexto), avise no `say` e marque `"skip": true` neles.
Responda SEMPRE E SOMENTE com um bloco ```json: {"say":"sua fala curta em markdown","chips":["0 a 4 respostas rápidas"],"issues":[{"title":"","description":"","requirements":[""],"goal":"","assignee":"","priority":"","type":"","open":[""],"skip":false}],"done":false}. `issues` traz SEMPRE a lista COMPLETA e atualizada (não só o que mudou), na ordem do dev — EXCETO quando a mensagem vier marcada com [LOTE k/n]: aí devolva em `issues` SÓ as issues daquele lote (o app junta) e guarde as perguntas menos importantes em `open` em vez de encher o `say`. Lista grande = pesquisa mais enxuta por item (1-2 buscas direcionadas cada). `done` só vira true quando nenhuma issue tem `open` pendente E o dev confirmar que pode criar. Se a mensagem for saudação ou ainda não houver nada concreto, responda direto sem usar ferramentas e com "issues":[]. JSON ESTRITAMENTE VÁLIDO: dentro das strings use \\n pra quebra de linha, escape aspas, e NUNCA coloque cercas ``` dentro de `say`/`description` (pra citar caminho, label ou trecho use `crase simples`). Nada de texto fora do bloco json."#;

const TRACKER_AI_PROMPT: &str = r#"Você configura a conexão do Constellation com um painel/tracker de issues a partir da DOCUMENTAÇÃO da API dele. Responda SOMENTE um JSON válido (sem markdown, sem comentários) neste formato:
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
  "addComment": null
 },
 "fields": {"id": "id", "code": "code", "title": "title", "description": "description", "status": "status", "assignee": "campo com o ID de quem está com a issue ou null", "assigneeName": "campo com o NOME do responsável (ex.: assignee_name) ou null", "assigneeEmail": "campo com o e-mail do responsável ou null", "createdBy": "campo com o nome/e-mail de quem criou ou null", "priority": "priority ou null", "tags": "tags ou null", "createdAt": "created_at", "updatedAt": "updated_at", "url": "campo com link web ou null", "commentCount": "campo ou null"},
 "urlTemplate": "https://…/{{code}} se a doc der um link web por issue, senão vazio",
 "statuses": [{"id": "valor exato na API", "label": "rótulo em português", "kind": "todo|doing|blocked|done"}],
 "assigneeFormat": "email|id|name — o que a API espera em {{assignee}}",
 "priorities": ["valores aceitos em {{priority}}, na ordem da mais alta pra mais baixa; [] se a doc não listar"],
 "types": ["valores aceitos em {{type}} (ex.: task, bug); [] se não houver"],
 "notes": "1-3 frases: o que NÃO deu pra mapear (ex.: API não expõe comentários)"
}
Regras: (1) NUNCA escreva o valor real de uma chave, mesmo que apareça na doc — só {{secret.NOME}} (NOME em MAIÚSCULAS_COM_UNDERSCORE, use o nome que a doc usa). (2) Placeholders disponíveis: os "vars" que você declarar, e por operação — create: {{title}} {{description}} {{goal}} {{assignee}} {{priority}} {{type}} (use {{assignee}}/{{priority}}/{{type}} no body do create SÓ se a doc aceitar responsável/prioridade/tipo na criação; campo vazio é omitido do envio); updateStatus: {{code}} {{id}} {{status}} {{reason}} ({{reason}} = motivo do bloqueio, só se a doc tiver); assign (trocar o responsável de UMA issue — só se a doc permitir; senão null): {{code}} {{id}} {{assignee}}; comments/addComment: {{code}} {{id}} {{text}}; list: {{limit}} {{offset}} {{page}}. Em path/query/body. (3) "ops.comments" (listar comentários de UMA issue: itemsPath + "fields":{"author","text","createdAt"}) e "ops.addComment" só se a doc tiver; senão null. (4) statuses na ORDEM do fluxo; kind: todo=não iniciada, doing=em andamento, blocked=bloqueada, done=concluída. (5) vars perUser=true para o que muda por pessoa (e-mail, usuário). (6) Não invente endpoint: o que a doc não cobre fica null."#;

/// Lista as skills disponíveis (pessoais em ~/.claude/skills + do projeto em
/// <repo>/.claude/skills), marcando quais estão ATIVAS pra este repo.
#[tauri::command]
fn list_skills(state: State<AppState>) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").unwrap_or_default();
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

/// Skills ATIVAS pra este repo (array de {name, description}).
#[tauri::command]
fn get_active_skills(state: State<AppState>) -> Result<serde_json::Value, String> {
    let p = skills_json_path(&state)?;
    let txt = std::fs::read_to_string(&p).unwrap_or_else(|_| "[]".into());
    Ok(serde_json::from_str(&txt).unwrap_or_else(|_| serde_json::json!([])))
}

/// Grava as skills ativas do repo (o motor injeta no contexto do agente).
#[tauri::command]
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
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude").join("skills")
}

/// Cria uma skill nova na biblioteca pessoal (~/.claude/skills/<nome>/SKILL.md).
#[tauri::command]
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
#[tauri::command]
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
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".constellation").join("settings.json")
}
fn setting_get(key: &str) -> Option<String> {
    let content = std::fs::read_to_string(settings_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    match v.get(key)? {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}
#[tauri::command]
fn read_settings() -> Result<String, String> {
    Ok(std::fs::read_to_string(settings_path()).unwrap_or_else(|_| "{}".into()))
}
#[tauri::command]
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
#[tauri::command]
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
    let home = std::env::var("HOME").unwrap_or_default();
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
#[tauri::command]
fn is_dev_install() -> bool {
    std::env::var("CARDUME_CLI").map(|v| !v.is_empty()).unwrap_or(false)
}

/// Auto-update estilo Claude: baixa o zip (URL assinada), troca o .app em
/// disco e relança. curl/ditto não aplicam quarantine → abre sem Gatekeeper.
#[tauri::command(async)]
fn apply_update(url: String) -> Result<(), String> {
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
    let backup = cur_app.with_extension("app.old");
    let _ = std::fs::remove_dir_all(&backup);
    std::fs::rename(&cur_app, &backup).map_err(|e| format!("não consegui mover o app atual: {e}"))?;
    let cp = Command::new("cp").arg("-R").arg(&new_app).arg(&cur_app).output().map_err(|e| e.to_string())?;
    if !cp.status.success() {
        let _ = std::fs::rename(&backup, &cur_app); // rollback
        return Err(format!("cópia falhou: {}", String::from_utf8_lossy(&cp.stderr)));
    }
    let _ = std::fs::remove_dir_all(&backup);
    let _ = std::fs::remove_dir_all(&tmp);
    // relança a versão nova e sai
    let _ = Command::new("open").arg("-n").arg(&cur_app).spawn();
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(600));
        std::process::exit(0);
    });
    Ok(())
}

/// Chat do PROJETO: conversa livre sobre o repo (arquitetura, dúvidas, ideias)
/// com leitura REAL do código — sem tarefa e sem editar nada. A conversa pode
/// virar tarefa depois (a UI pede a spec pro mesmo session).
#[tauri::command(async)]
fn project_chat(state: State<AppState>, prompt: String, session_id: Option<String>) -> Result<AiChat, String> {
    let repo = repo_of(&state)?;
    let sys = "Você é o copiloto do PROJETO aberto no Constellation, conversando com o dev em português. Pode e DEVE ler o código de verdade (Read/Grep/Glob, git log/show/diff) antes de afirmar qualquer coisa — nada de chutar pela memória. Você NÃO edita arquivos nem roda comandos que alterem estado: é conversa + leitura. Seja direto e específico (arquivos/linhas quando útil). Se o assunto virar trabalho concreto, diga que dá pra transformar a conversa numa tarefa pelo botão 'virar tarefa'.";
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "json".to_string(),
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
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    let out = output_timeout(cmd, 240)?;
    let v = claude_json(&out)?;
    Ok(AiChat {
        text: v["result"].as_str().unwrap_or("").to_string(),
        session_id: v["session_id"].as_str().unwrap_or("").to_string(),
    })
}

// ---------- revisão de arquivos da tarefa (abrir/editar/salvar) ----------
fn task_wt_base(state: &State<AppState>, task_id: &str) -> Result<(PathBuf, String), String> {
    let path = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("repo não definido")?;
    let conn = open(&path)?;
    conn.query_row("SELECT worktree, base FROM task WHERE id=?1", params![task_id], |r| {
        Ok((PathBuf::from(r.get::<_, String>(0)?), r.get::<_, String>(1)?))
    })
    .map_err(|e| e.to_string())
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
    let (wt, base) = task_wt_base(&state, &task_id)?;
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
    let content = std::fs::read_to_string(wt.join(&path)).map_err(|e| e.to_string())?;
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
        "SELECT substr(text,1,400) FROM event WHERE task_id=?1 AND type IN ('note','done') AND length(text)>40 AND text NOT LIKE '💬%' AND text NOT LIKE '❓%' AND text NOT LIKE 'perguntou%' AND text NOT LIKE 'humano%' AND text NOT LIKE 'requisito adicionado%' ORDER BY id DESC LIMIT 12",
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
    Ok(format!("{body}\n\n_Aberto pelo Constellation._"))
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
#[tauri::command]
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
#[tauri::command]
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
    if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
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
    for c in &cands {
        let mut v = Command::new(gh_bin());
        v.args(["pr", "view", c, "--json", "number"]).current_dir(&repo);
        if let Ok(o) = output_timeout(v, 10) {
            if o.status.success() {
                return Ok((repo, c.clone()));
            }
        }
    }
    Ok((repo, branch))
}

fn repo_slug(repo: &PathBuf) -> Result<String, String> {
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
    let cli = cli_path(&std::env::var("HOME").map(PathBuf::from).unwrap_or_default());
    let cli_ok = std::path::Path::new(&cli).is_file();
    out.push(EnvCheck { name: "Motor do Constellation".into(), ok: cli_ok, detail: cli.clone(), fix: if cli_ok { String::new() } else { "reinstale o app (o motor vai dentro dele)".into() } });
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
    // opcional: túnel do preview pro celular (📱). Sem ele o app funciona 100% —
    // só o botão de abrir o preview no celular fica indisponível.
    let cf = ["/opt/homebrew/bin/cloudflared", "/opt/homebrew/opt/cloudflared/bin/cloudflared", "/usr/local/bin/cloudflared"]
        .iter()
        .any(|p| std::path::Path::new(p).is_file());
    out.push(EnvCheck {
        name: "Túnel do preview (opcional)".into(),
        ok: cf,
        detail: if cf { "cloudflared instalado — botão 📱 celular disponível".into() } else { "sem cloudflared — o botão '📱 celular' do preview fica desativado (resto funciona normal)".into() },
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
        let c = Command::new("git").arg("-C").arg(&wt).args(["commit", "-m", "ajustes via Constellation"]).output().map_err(|e| e.to_string())?;
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
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener).arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Revela o artefato no gerenciador de arquivos (Finder no macOS), selecionando-o.
#[tauri::command]
fn reveal_artifact(state: State<AppState>, task_id: String, name: String) -> Result<String, String> {
    let path = artifact_path(&state, &task_id, &name)?;
    if cfg!(target_os = "macos") {
        Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    } else {
        // fallback: abre a pasta que contém o arquivo
        let dir = path.parent().unwrap_or(&path);
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Abre uma URL no navegador do sistema (o WKWebView não abre target=_blank).
#[tauri::command(async)]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("url inválida".to_string());
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener)
        .arg(&url)
        .spawn()
        .map_err(|e| format!("falha ao abrir o link: {e}"))?;
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
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = Command::new(opener).arg(&authorize_url).spawn();
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
                let body = "<!doctype html><html><head><meta charset=utf-8><title>Login</title><style>body{font:16px -apple-system,system-ui,sans-serif;background:#0e1113;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0}</style></head><body><div style=\"text-align:center\"><div style=\"font-size:44px;color:#16a34a;line-height:1\">✓</div><h2 style=\"margin:14px 0 4px\">Login concluído</h2><p style=\"color:#94a3b8;margin:0\">Pode fechar esta aba e voltar pro Constellation.</p></div></body></html>";
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
#[tauri::command]
fn pr_compare_url(state: State<AppState>, task_id: String, base: String) -> Result<String, String> {
    let repo = repo_of(&state)?;
    let out = Command::new("git").arg("-C").arg(&repo)
        .args(["config", "--get", "remote.origin.url"]).output().map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() { return Err("sem remote origin".into()); }
    let mut s = raw.trim_end_matches(".git").to_string();
    if let Some(rest) = s.strip_prefix("git@") { s = rest.replacen(':', "/", 1); }
    else { for p in ["https://", "http://", "ssh://git@", "ssh://"] { if let Some(rest) = s.strip_prefix(p) { s = rest.to_string(); break; } } }
    let path = s.strip_prefix("github.com/").ok_or("criar PR pelo navegador só vale pra repos do github.com")?;
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
    if let Ok((r2, head)) = pr_head(&state, &task_id) {
        let mut v = Command::new(gh_bin());
        v.args(["pr", "view", &head, "--json", "url", "-q", ".url"]).current_dir(&r2);
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
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("gh indisponível: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if err.contains("already exists") {
            let u = Command::new(gh_bin()).args(["pr", "view", &branch, "--json", "url", "-q", ".url"]).current_dir(&repo).output().map_err(|e| e.to_string())?;
            if u.status.success() {
                return Ok(String::from_utf8_lossy(&u.stdout).trim().to_string());
            }
        }
        if err.contains("Could not resolve to a Repository") {
            return Err(format!(
                "gh pr create: {err}\n\nSua conta do gh NÃO enxerga este repositório (o push funcionou porque o git usa outra credencial). Causas comuns:\n1) você ainda não foi convidado pra organização dona do repo — peça o convite;\n2) o token do gh não tem SSO autorizado pra org — rode `gh auth refresh -h github.com -s repo` e autorize o SSO quando o navegador abrir."
            ));
        }
        return Err(format!("gh pr create: {err}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrComment {
    path: Option<String>,
    line: Option<i64>,
    author: String,
    body: String,
    is_bot: bool,
    /// id do review comment (inline) — permite responder via gh api …/replies
    id: Option<i64>,
    /// este comentário é uma RESPOSTA a outro (thread)
    in_reply_to: Option<i64>,
    /// já tem resposta na thread (endereçado)
    answered: bool,
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
}

/// Status do PR da tarefa: estado, decisão (aprovado/mudanças) e comentários
/// (conversa + inline por arquivo — inclui CodeRabbit e pessoas).
#[tauri::command(async)]
fn pr_status(state: State<AppState>, task_id: String) -> Result<PrInfo, String> {
    let (repo, branch) = pr_head(&state, &task_id)?;
    let empty = PrInfo { exists: false, number: 0, url: String::new(), state: String::new(), decision: String::new(), mergeable: String::new(), body: String::new(), comments: vec![] };
    let mut vcmd = Command::new(gh_bin());
    vcmd.args(["pr", "view", &branch, "--json", "number,url,state,reviewDecision,mergeable,body,comments"]).current_dir(&repo);
    // rede caída / gh pendurado → devolve "sem PR" em vez de travar/errar a UI
    let view = match output_timeout(vcmd, 12) {
        Ok(o) => o,
        Err(_) => return Ok(empty),
    };
    if !view.status.success() {
        return Ok(empty);
    }
    let v: serde_json::Value = serde_json::from_slice(&view.stdout).map_err(|e| e.to_string())?;
    let number = v["number"].as_i64().unwrap_or(0);
    let is_bot = |a: &str| { let l = a.to_lowercase(); l.contains("coderabbit") || l.contains("[bot]") };
    let mut comments: Vec<PrComment> = vec![];
    if let Some(arr) = v["comments"].as_array() {
        for c in arr {
            let author = c["author"]["login"].as_str().unwrap_or("").to_string();
            let body = c["body"].as_str().unwrap_or("").to_string();
            if body.trim().is_empty() {
                continue;
            }
            let bot = is_bot(&author);
            comments.push(PrComment { path: None, line: None, author, body, is_bot: bot, id: None, in_reply_to: None, answered: false });
        }
    }
    if number > 0 {
        if let Ok(slug) = repo_slug(&repo) {
            let mut acmd = Command::new(gh_bin());
            acmd.args(["api", &format!("repos/{}/pulls/{}/comments", slug, number), "--paginate"]).current_dir(&repo);
            if let Ok(o) = output_timeout(acmd, 15) {
                if o.status.success() {
                    if let Ok(arr) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                        if let Some(a) = arr.as_array() {
                            for c in a {
                                let author = c["user"]["login"].as_str().unwrap_or("").to_string();
                                let body = c["body"].as_str().unwrap_or("").to_string();
                                if body.trim().is_empty() {
                                    continue;
                                }
                                let path = c["path"].as_str().map(|s| s.to_string());
                                let line = c["line"].as_i64().or_else(|| c["original_line"].as_i64());
                                let bot = is_bot(&author);
                                comments.push(PrComment { path, line, author, body, is_bot: bot, id: c["id"].as_i64(), in_reply_to: c["in_reply_to_id"].as_i64(), answered: false });
                            }
                        }
                    }
                }
            }
        }
    }
    // marca como RESPONDIDO todo comentário cuja thread tem resposta
    let replied: std::collections::HashSet<i64> = comments.iter().filter_map(|c| c.in_reply_to).collect();
    for c in comments.iter_mut() {
        if let Some(cid) = c.id {
            if replied.contains(&cid) {
                c.answered = true;
            }
        }
    }
    let url = v["url"].as_str().unwrap_or("").to_string();
    // PERSISTE o PR na tarefa (spec.prUrl): sem isso o link só existia "ao
    // vivo" via gh — snapshot/sync do time ficavam com pr_url nulo pra sempre.
    if !url.is_empty() {
        if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
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
        if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(4000));
                let flipped = conn.execute(
                    "UPDATE task SET status='merged' WHERE id=?1 AND status NOT IN ('merged','done')",
                    params![task_id],
                ).unwrap_or(0);
                // worktree mergeada não serve mais — libera o disco na hora
                if flipped > 0 { if let Ok(repo) = repo_of(&state) { remove_task_worktree(&repo, &conn, &task_id); } }
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
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoCheck {
    name: String,
    ok: bool,
    detail: String,
}

/// Checagens pré-PR na worktree da tarefa (modal "Preparando o PR"):
/// roda lint/test do package.json quando existem. Sem scripts → lista vazia.
#[tauri::command(async)]
fn repo_checks(state: State<AppState>, task_id: String) -> Result<Vec<RepoCheck>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("sem projeto aberto")?;
    let conn = open(&db)?;
    let wt: String = conn
        .query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut out: Vec<RepoCheck> = vec![];
    let pkg = PathBuf::from(&wt).join("package.json");
    if let Ok(txt) = std::fs::read_to_string(&pkg) {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&txt) {
            for (script, label) in [("lint", "Linter"), ("test", "Testes")] {
                if j["scripts"][script].as_str().is_some() {
                    let mut c = npm_cmd();
                    c.args(["run", script, "--silent"]).current_dir(&wt);
                    match output_timeout(c, 300) {
                        Ok(o) => {
                            let ok = o.status.success();
                            let tail = |b: &[u8]| -> String {
                                let s = String::from_utf8_lossy(b);
                                s.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
                            };
                            out.push(RepoCheck {
                                name: label.to_string(),
                                ok,
                                detail: if ok { "passou".into() } else { tail(&o.stderr).chars().take(500).collect() },
                            });
                        }
                        Err(e) => out.push(RepoCheck {
                            name: label.to_string(),
                            ok: false,
                            detail: if e.contains("os error 2") { "npm não encontrado nesta máquina — instale o Node (brew install node) e verifique o Ambiente".into() } else { e },
                        }),
                    }
                }
            }
        }
    }
    Ok(out)
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

/// Mergeia o PR (gh) e marca a tarefa como merged localmente.
#[tauri::command(async)]
fn merge_pr(state: State<AppState>, task_id: String, method: String) -> Result<String, String> {
    let (repo, branch) = pr_head(&state, &task_id)?;
    let m = match method.as_str() { "squash" => "--squash", "rebase" => "--rebase", _ => "--merge" };
    let out = Command::new(gh_bin())
        .args(["pr", "merge", &branch, m, "--delete-branch"])
        .current_dir(&repo)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    // marca merged localmente + remove a worktree
    if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
            let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
            remove_task_worktree(&repo, &conn, &task_id);
            let _ = conn.execute("UPDATE task SET status='merged' WHERE id=?1", params![task_id]);
        }
    }
    Ok("PR mergeado".to_string())
}

/// Coleta os comentários do PR e manda o agente endereçá-los (rework via --resume).
#[tauri::command(async)]
fn rework_from_pr(state: State<AppState>, task_id: String) -> Result<(), String> {
    let info = pr_status(state.clone(), task_id.clone())?;
    if !info.exists || info.comments.is_empty() {
        return Err("nenhum comentário de review pra endereçar".to_string());
    }
    let repo = repo_of(&state)?;
    let slug = repo_slug(&repo).unwrap_or_default();
    // só o que ainda NÃO foi endereçado (nem é resposta de thread)
    let open: Vec<&PrComment> = info.comments.iter().filter(|c| !c.answered && c.in_reply_to.is_none()).collect();
    if open.is_empty() {
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
        match c.id {
            Some(id) => text.push_str(&format!("- [comment_id={id}] [{}] {loc}: {snippet}\n", c.author)),
            None => text.push_str(&format!("- [conversa] [{}]: {snippet}\n", c.author)),
        }
    }
    text.push_str(&format!(
        "\nDEPOIS de aplicar TODAS as correções, FECHE O CICLO (obrigatório):\n\
         1. Commit: git add -A && git commit -m \"fix: endereça comentários do PR #{num}\"\n\
         2. Push: git push (o PR atualiza sozinho)\n\
         3. RESPONDA cada comentário inline no GitHub, um a um, dizendo O QUE mudou (ou por que não mudou):\n\
            gh api repos/{slug}/pulls/{num}/comments/<comment_id>/replies -f body=\"✔ <o que foi feito>\"\n\
         4. Pros itens de (conversa), responda com: gh pr comment {num} --body \"...\"\n\
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

#[tauri::command]
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

#[tauri::command]
fn remove_task(state: State<AppState>, task_id: String) -> Result<(), String> {
    let repo = repo_of(&state)?;
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

/// Espelha o console do webview em /tmp/constellation-web.log — sem isso,
/// erro de JS nos ticks é invisível e vira caça às cegas.
#[tauri::command]
fn web_log(line: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/constellation-web.log") {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{ts} {}", line.chars().take(600).collect::<String>());
    }
}

/// Notificação NATIVA com clique útil. O plugin (notify-rust) cai no bundle do
/// Editor de Script quando não registra o app — clicar abria o editor. Aqui:
/// mac-notification-sys com o bundle do Constellation + resposta do clique →
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
                signal_group(old, libc::SIGTERM);
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
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
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
            signal_group(pid, libc::SIGKILL);
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
        signal_group(pid, libc::SIGKILL);
        return Err("túnel criado mas não ficou acessível (530) — tente de novo".to_string());
    }
    if let Ok(mut m) = state.procs.lock() {
        m.insert(format!("tunnel:{task_id}"), pid);
    }
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(public)
}

/// Derruba o túnel da tarefa (se houver).
#[tauri::command]
fn tunnel_stop(state: State<AppState>, task_id: String) -> Result<(), String> {
    if let Ok(mut m) = state.procs.lock() {
        if let Some(pid) = m.remove(&format!("tunnel:{task_id}")) {
            signal_group(pid, libc::SIGTERM);
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
            workspace_usage,
            workspace_clean,
            current_repo,
            coordination_metrics,
            overlap_check,
            resolve_conflict,
            list_projects,
            projects_overview,
            repo_checks,
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
            get_active_skills,
            set_active_skills,
            get_issue_config,
            set_issue_config,
            repo_remote_of,
            tracker_local_get,
            tracker_local_set,
            tracker_bind_secret,
            tracker_secret_status,
            tracker_http,
            tracker_ai_build,
            issue_chat,
            issue_chat_stop,
            create_skill,
            import_skill_md,
            git_skills,
            list_all_tasks,
            read_settings,
            write_setting,
            fetch_task_ref,
            slack_send_artifact,
            open_project,
            git_init_repo,
            create_project,
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
            ai_title,
            project_chat,
            is_dev_install,
            apply_update,
            notify_native,
            web_log,
            tunnel_start,
            tunnel_stop,
            open_url,
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
            merge_pr,
            rework_from_pr,
            merge_task,
            remove_task,
            pick_folder,
            pick_ref_files,
            import_attachment,
            import_attachment_data,
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
        .expect("erro ao iniciar o Cardume")
        .run(|_app, event| {
            // app fechando → nenhum túnel fica exposto pra trás
            if let tauri::RunEvent::Exit = event {
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
