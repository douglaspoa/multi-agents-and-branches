use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

fn repo_of(state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .db
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()))
        .ok_or_else(|| "repo não definido".to_string())
}

/// Motor: CARDUME_CLI (dev — TS ao vivo) → bundle dentro do app
/// (Resources/engine/cli.mjs) → src/cli.ts do repo aberto (último recurso).
fn cli_path(repo: &PathBuf) -> String {
    if let Ok(p) = std::env::var("CARDUME_CLI") {
        if !p.is_empty() && std::path::Path::new(&p).is_file() {
            return p;
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
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
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
    "node".to_string()
}

/// Acha o binário do `claude` sem depender do PATH (que pode estar stale via
/// LSEnvironment): CARDUME_CLAUDE → ao lado do node → "claude" no PATH.
/// Acha o `gh` sem depender do PATH (LaunchServices pode lançar com PATH mínimo).
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
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        for rel in [".local/bin/claude", ".claude/local/claude"] {
            let cand = home.join(rel);
            if cand.is_file() {
                return cand.display().to_string();
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
    flag: Option<String>,
    auto_pr: Option<String>,
    linked_to: Option<String>,
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
    let repo = PathBuf::from(&path);
    let is_git = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_git {
        return Err(format!("{} não é um repositório git", path));
    }
    let db = repo.join(".cardume").join("state.sqlite");
    if !db.exists() {
        let out = Command::new(node_bin())
            .args([
                "--disable-warning=ExperimentalWarning",
                &cli_path(&repo),
                "init",
                "--repo",
                &repo.display().to_string(),
            ])
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
    list.retain(|p| p != &path);
    list.insert(0, path.clone());
    write_project_list(&list);
    Ok(path)
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
    } else {
        "file"
    }
}

#[tauri::command(async)]
fn list_artifacts(state: State<AppState>, task_id: String) -> Result<Vec<Artifact>, String> {
    let repo = repo_of(&state)?;
    let dir = repo.join(".cardume").join("artifacts").join(&task_id);
    let mut out: Vec<Artifact> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() {
                let name = e.file_name().to_string_lossy().to_string();
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
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("nome de artefato inválido".to_string());
    }
    let repo = repo_of(&state)?;
    let path = repo.join(".cardume").join("artifacts").join(&task_id).join(&name);
    if !path.is_file() {
        return Err("artefato não encontrado".to_string());
    }
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
    } else {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(ArtifactContent {
            kind: if kind == "doc" { "doc".to_string() } else { "file".to_string() },
            text: Some(text),
            data_url: None,
        })
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
                flag: r.get::<_, Option<String>>(15).unwrap_or(None),
                auto_pr: spec.get("autoPr").and_then(|v| v.as_str()).map(|s| s.to_string()),
                linked_to: spec.get("linkedTo").and_then(|v| v.as_str()).map(|s| s.to_string()),
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

    Ok(Snapshot { repo, tasks, events, claims, diffs, reviews, pending, costs })
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
    base: Option<String>,
    tests: Option<bool>,
    auto_pr: Option<String>,
    pr_base: Option<String>,
    linked_to: Option<String>,
    model: Option<String>,
    models: Option<String>,
) -> Result<String, String> {
    let repo = repo_of(&state)?;
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
        let joined: Vec<String> = rs.iter().filter(|x| !x.is_empty()).cloned().collect();
        if !joined.is_empty() {
            args.push("--requirements".to_string());
            args.push(joined.join(","));
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
    push_opt(&mut args, "--base", &base);
    push_opt(&mut args, "--model", &model);
    push_opt(&mut args, "--models", &models);
    if tests.unwrap_or(false) {
        args.push("--artifact-tests".to_string());
    }
    push_opt(&mut args, "--auto-pr", &auto_pr);
    push_opt(&mut args, "--pr-base", &pr_base);
    push_opt(&mut args, "--linked-to", &linked_to);

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
    let repo = repo_of(&state)?;
    let out = Command::new("git")
        .arg("-C").arg(&repo)
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
    if !["review", "merged", "draft"].contains(&status.as_str()) {
        return Err(format!("status inválido: {status}"));
    }
    set_task_status(&state, &task_id, &status)?;
    if status == "merged" {
        if let Some(path) = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            if let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
                let _ = conn.execute("DELETE FROM claim WHERE task_id=?1", params![task_id]);
                let _ = conn.execute("DELETE FROM pending WHERE task_id=?1", params![task_id]);
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

/// Desdobra um trabalho grande em sub-tarefas (JSON) — pro fluxo de épico.
#[tauri::command(async)]
fn ai_decompose(text: String) -> Result<String, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("sem contexto pra desdobrar".to_string());
    }
    let ctx: String = t.chars().take(6000).collect();
    let prompt = format!(
        "Você é um tech lead quebrando um trabalho grande em tarefas EXECUTÁVEIS e independentes (cada uma vira uma branch própria tocada por um agente). Com base no contexto abaixo, proponha de 3 a 7 tarefas, em ordem de dependência. Responda SOMENTE um JSON array válido, sem markdown: [{{\"title\":\"verbo + objeto (máx 60 chars)\",\"objective\":\"2-4 frases: o que fazer, onde, critério de pronto\"}}]\n\nCONTEXTO:\n{ctx}"
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
    let sys = "Você é o PLANNER do Constellation: monta a ESPECIFICAÇÃO de uma tarefa conversando com o Douglas, em português, UMA pergunta por vez, fechando só o que ainda falta. Responda SEMPRE E SOMENTE com um bloco de código ```json contendo exatamente as chaves {\"say\":\"\",\"chips\":[],\"patch\":{},\"asking\":\"\",\"done\":false} — nada fora do bloco. Regras: `say` é sua próxima fala curta e objetiva (a pergunta que falta, ou uma confirmação de que pode criar). `chips` são 0 a 4 respostas rápidas sugeridas pra essa pergunta (strings curtas). `patch` contém SÓ os campos que ficaram claros nesta rodada — chaves possíveis: title (string), objective (string), deliverables (array de strings), requirements (array de strings), owns (array de caminhos), off (array de caminhos), engine (string), autonomy (string curta, ex.: \"clarifications: ask\"), artifacts (array com qualquer combinação de \"doc\", \"proof\", \"tests\"); NÃO invente, deixe de fora o que não sabe. `asking` é o nome do campo que você está perguntando AGORA (um de: title, objective, deliverables, requirements, owns, off, autonomy, engine, artifacts) ou \"\". `done` só vira true quando title, objective e deliverables estiverem fechados E o usuário confirmar que pode criar. Se ainda não houver objetivo, comece perguntando o objetivo. Antes de fechar, SEMPRE pergunte quais ENTREGÁVEIS DE COMPROVAÇÃO o usuário quer — documento de arquitetura (doc), prints de prova (proof) e/ou testes (tests) — e grave a escolha em patch.artifacts. Se o usuário não souber um critério, sugira `autonomy: clarifications: ask`. Nada de texto fora do bloco json.";
    let claude = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "json".to_string(),
        "--append-system-prompt".to_string(),
        sys.to_string(),
    ];
    if let Some(sid) = &session_id {
        if !sid.is_empty() {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }
    }
    let mut cmd = claude_cmd(&claude);
    cmd.args(&args).current_dir(&repo);
    let out = output_timeout(cmd, 90)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(AiChat {
        text: v["result"].as_str().unwrap_or("").to_string(),
        session_id: v["session_id"].as_str().unwrap_or("").to_string(),
    })
}

/// Política de obrigatoriedade DO REPO (.cardume/policy.json) — a "Definition of
/// Done" que o formulário e o motor respeitam. Sem arquivo → defaults sensatos.
/// Campos: minRequirements, proofRequired, testsRequired, docRequired, costWarn.
#[tauri::command]
fn read_policy(state: State<AppState>) -> serde_json::Value {
    let mut pol = serde_json::json!({
        "minRequirements": 1,
        "proofRequired": true,
        "testsRequired": true,
        "docRequired": false,
        "costWarn": 25
    });
    if let Ok(repo) = repo_of(&state) {
        if let Ok(txt) = std::fs::read_to_string(PathBuf::from(&repo).join(".cardume").join("policy.json")) {
            if let Ok(user) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let (Some(base), Some(over)) = (pol.as_object_mut(), user.as_object()) {
                    for (k, v) in over { base.insert(k.clone(), v.clone()); }
                }
            }
        }
        // guia de spec do repo — o wizard mostra pro humano o mesmo texto que a IA segue
        if let Ok(g) = std::fs::read_to_string(PathBuf::from(&repo).join(".cardume").join("SPEC.md")) {
            pol["specGuide"] = serde_json::json!(g.chars().take(1800).collect::<String>());
        }
    }
    pol
}

/// Completa a SPEC da Nova demanda numa tacada só (sem conversa): pega o que o
/// humano já digitou e devolve título/objetivo/entregáveis/requisitos BEM
/// FORMADOS. Substitui o assistente lateral (frágil demais).
#[tauri::command(async)]
fn ai_spec(state: State<AppState>, title: String, objective: String, kind: String) -> Result<serde_json::Value, String> {
    let repo = repo_of(&state)?;
    let draft = format!("Título (do humano, pode estar vazio): {title}\nDescrição/objetivo (do humano, pode estar vazio): {objective}\nTipo: {kind}");
    if title.trim().is_empty() && objective.trim().is_empty() {
        return Err("escreva pelo menos o título ou uma descrição — a IA completa o resto".into());
    }
    // guia de spec DO REPO (.cardume/SPEC.md): vocabulário do domínio, o que toda
    // demanda deste projeto precisa conter — a IA obedece ao time, não ao genérico
    let spec_guide = std::fs::read_to_string(PathBuf::from(&repo).join(".cardume").join("SPEC.md"))
        .map(|s| s.chars().take(3000).collect::<String>())
        .unwrap_or_default();
    let guide_block = if spec_guide.trim().is_empty() { String::new() } else {
        format!("\n\nGUIA DE SPEC DESTE REPO (regras do time — siga à risca; requisitos padrão daqui entram SEMPRE que se aplicarem):\n{spec_guide}\n")
    };
    let prompt = format!(
        "Você monta a especificação de uma tarefa de engenharia a partir do rascunho do humano. Responda SOMENTE um objeto JSON (sem cerca de código, sem texto fora) com EXATAMENTE estas chaves:\n\
         {{\"title\": string, \"objective\": string, \"deliverables\": [string], \"requirements\": [string]}}\n\n\
         REGRAS DE QUALIDADE (obrigatórias):\n\
         - title: máx 70 caracteres, começa com verbo no infinitivo, específico.\n\
         - objective: 2 a 4 frases COMPLETAS em pt-BR — o que fazer, onde e por quê. Não copie o rascunho cru; escreva limpo.\n\
         - deliverables: 2 a 4 itens — COISAS entregues (tela X, endpoint Y, doc Z), substantivos, sem verbos de processo.\n\
         - requirements: 3 a 6 critérios de aceite VERIFICÁVEIS, cada um uma FRASE COMPLETA e independente (alguém consegue marcar ✓/✗ testando). PROIBIDO: fragmentos soltos, itens duplicando entregáveis, itens vagos tipo 'funcionar bem', itens com mais de uma exigência (quebre em dois).\n\
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
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
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
    for cand in [format!("origin/{clean}"), clean.to_string()] {
        if let Ok(o) = Command::new("git").arg("-C").arg(dir).args(["merge-base", &cand, tip]).output() {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
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
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() >= 3 {
            files.push(TaskFile { add: p[0].parse().unwrap_or(0), del: p[1].parse().unwrap_or(0), path: p[2].to_string() });
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
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("nome de artefato inválido".to_string());
    }
    let repo = repo_of(&state)?;
    let path = repo.join(".cardume").join("artifacts").join(&task_id).join(&name);
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
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("nome de artefato inválido".to_string());
    }
    let repo = repo_of(&state)?;
    let path = repo.join(".cardume").join("artifacts").join(&task_id).join(&name);
    if !path.is_file() {
        return Err("artefato não encontrado".to_string());
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener).arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
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
    Ok(PrInfo {
        exists: true,
        number,
        url,
        state: v["state"].as_str().unwrap_or("").to_string(),
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
                    let mut c = Command::new("npm");
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
                        Err(e) => out.push(RepoCheck { name: label.to_string(), ok: false, detail: e }),
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
            if let Ok(wt) = conn.query_row("SELECT worktree FROM task WHERE id=?1", params![task_id], |r| r.get::<_, String>(0)) {
                let _ = Command::new("git").arg("-C").arg(&repo).args(["worktree", "remove", "--force", &wt]).output();
            }
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
    let _ = mac_notification_sys::set_application("dev.constellation.app");
    web_log("[rust] app iniciou".to_string());
    // túneis órfãos de instâncias anteriores (setsid sobrevive ao app): limpa
    let _ = Command::new("pkill").args(["-f", "cloudflared tunnel --no-autoupdate"]).output();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::from_env())
        .invoke_handler(tauri::generate_handler![
            set_repo,
            current_repo,
            list_projects,
            projects_overview,
            repo_checks,
            file_diff,
            pr_body_ai,
            ai_spec,
            apns_push,
            read_policy,
            open_project,
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
            open_artifact,
            push_task,
            env_check,
            read_artifact_raw,
            ai_decompose,
            daily_digest,
            ai_daily,
            task_files,
            read_file,
            write_file,
            rename_branch,
            read_ref,
            list_branches,
            open_pr,
            pr_status,
            merge_pr,
            rework_from_pr,
            merge_task,
            remove_task,
            pick_folder,
            pick_ref_files,
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
