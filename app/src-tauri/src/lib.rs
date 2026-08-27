use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

fn repo_of(state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .db
        .lock()
        .unwrap()
        .clone()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()))
        .ok_or_else(|| "repo não definido".to_string())
}

fn cli_path(repo: &PathBuf) -> String {
    std::env::var("CARDUME_CLI").unwrap_or_else(|_| repo.join("src").join("cli.ts").display().to_string())
}

fn node_bin() -> String {
    std::env::var("CARDUME_NODE").unwrap_or_else(|_| "node".to_string())
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
        AppState { db: Mutex::new(db) }
    }
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
    deliverables: serde_json::Value,
    requirements: serde_json::Value,
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
    *state.db.lock().unwrap() = Some(db.clone());
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
#[tauri::command]
fn graph(state: State<AppState>) -> Result<Vec<Commit>, String> {
    let db = state.db.lock().unwrap().clone();
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
#[tauri::command]
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
#[tauri::command]
fn commit_summary_cached(state: State<AppState>, hash: String) -> Result<Option<String>, String> {
    let dbpath = state.db.lock().unwrap().clone().ok_or("repo não definido")?;
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
    let dbpath = state.db.lock().unwrap().clone().ok_or("repo não definido")?;
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
    let claude = std::env::var("CARDUME_CLAUDE").unwrap_or_else(|_| "claude".to_string());
    let out = Command::new(&claude)
        .args(["-p", &prompt])
        .stdin(Stdio::null())
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("falha ao rodar claude: {e}"))?;
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
#[tauri::command]
fn task_commits(state: State<AppState>, task_id: String) -> Result<Vec<serde_json::Value>, String> {
    let dbpath = state.db.lock().unwrap().clone().ok_or("repo não definido")?;
    let repo = dbpath.parent().and_then(|d| d.parent()).map(|r| r.to_path_buf()).ok_or("repo inválido")?;
    let conn = open(&dbpath)?;
    let (branch, base): (String, String) = conn
        .query_row("SELECT branch, base FROM task WHERE id=?1", params![task_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "log",
            &format!("{base}..{branch}"),
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

#[tauri::command]
fn current_repo(state: State<AppState>) -> Option<String> {
    state
        .db
        .lock()
        .unwrap()
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
        .unwrap()
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

#[tauri::command]
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
    *state.db.lock().unwrap() = Some(db);
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
    *state.db.lock().unwrap() = Some(db);
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

#[tauri::command]
fn list_artifacts(state: State<AppState>, task_id: String) -> Result<Vec<Artifact>, String> {
    let repo = repo_of(&state)?;
    let dir = repo.join(".cardume").join("artifacts").join(&task_id);
    let mut out: Vec<Artifact> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() {
                let name = e.file_name().to_string_lossy().to_string();
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(Artifact { kind: artifact_kind(&name).to_string(), name, size });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactContent {
    kind: String,
    text: Option<String>,
    data_url: Option<String>,
}

#[tauri::command]
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

#[tauri::command]
fn snapshot(state: State<AppState>) -> Result<Snapshot, String> {
    let path = state.db.lock().unwrap().clone();
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

    let tasks = conn
        .prepare(
            "SELECT id,title,objective,status,agent,stage,roles_json,branch,worktree,base,engine,model,created_at,spec_json \
             FROM task ORDER BY created_at",
        )
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
                deliverables: spec.get("deliverables").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                requirements: spec.get("requirements").cloned().unwrap_or(serde_json::Value::Array(vec![])),
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    // Limita o payload: só os eventos mais recentes (evita serializar todo o
    // histórico a cada poll). 5000 é folgado para o uso real e bloqueia o
    // crescimento ilimitado do snapshot.
    let events = conn
        .prepare("SELECT id,task_id,agent,ts,\"type\",text,ok FROM (SELECT id,task_id,agent,ts,\"type\",text,ok FROM event ORDER BY id DESC LIMIT 5000) ORDER BY id")
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
#[tauri::command]
fn resolve_pending(state: State<AppState>, id: i64, answer: String) -> Result<(), String> {
    let path = state.db.lock().unwrap().clone().ok_or("repo não definido")?;
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
    Command::new(node_bin())
        .args([
            "--disable-warning=ExperimentalWarning",
            &cli_path(&repo),
            "rework",
            &task_id,
            "--repo",
            &repo.display().to_string(),
        ])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("falha ao iniciar rework: {e}"))?;
    Ok(())
}

/// Enfileira uma instrução do humano no meio da execução — o orquestrador a
/// aplica (via --resume) ao fim do turno atual do agente.
#[tauri::command]
fn add_instruction(state: State<AppState>, task_id: String, text: String) -> Result<(), String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("instrução vazia".to_string());
    }
    let path = state.db.lock().unwrap().clone().ok_or("repo não definido")?;
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
#[tauri::command]
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
#[tauri::command]
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
) -> Result<(), String> {
    let repo = repo_of(&state)?;
    let mut args = vec![
        "--disable-warning=ExperimentalWarning".to_string(),
        cli_path(&repo),
        "new".to_string(),
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

    Command::new(node_bin())
        .args(&args)
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("falha ao iniciar tarefa: {e}"))?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::from_env())
        .invoke_handler(tauri::generate_handler![
            set_repo,
            current_repo,
            list_projects,
            open_project,
            switch_project,
            remove_project,
            snapshot,
            graph,
            resolve_pending,
            add_instruction,
            rework_task,
            config,
            new_task,
            merge_task,
            remove_task,
            pick_folder,
            save_config,
            import_agent_files,
            commit_detail,
            ai_commit_summary,
            commit_summary_cached,
            task_commits,
            list_artifacts,
            read_artifact
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Cardume");
}
