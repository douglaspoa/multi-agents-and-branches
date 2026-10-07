//! MESA DE PERSONAS (party mode) no app: personas independentes discutem um tema do
//! projeto em rodadas (posição → debate e voto) e a aba Mesa (app/src/js/38-mesa.js)
//! apura os votos. Aqui mora só o que precisa de processo/disco:
//!   - `mesa_ask`: UMA chamada isolada ao claude (persona = system prompt próprio +
//!     cérebro do projeto via `with_memory` + resumo do repositório), parável por mesa;
//!   - `mesa_save`/`mesa_list`/`mesa_read`: a mesa inteira em `.cardume/mesas/<id>.json`
//!     (só local — a nuvem só recebe a DECISÃO aprovada, como nota do cérebro, pelo JS);
//!   - `mesa_stop`: derruba todas as personas em andamento daquela mesa.
//! Todo acesso a arquivo é TRAVADO em `.cardume/mesas/` (id validado, sem separador).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

use super::{ai_once, claude_bin, claude_cmd, claude_json, detach_new_group, memoria, procsig, protect_args, protect_on, repo_or, signal_group, AppState};

/// Resposta máxima de uma persona (s). Uma persona só lê e opina — 5 min é folga.
const ASK_SECS: u64 = 300;
pub const STOPPED: &str = "MESA_STOPPED";

// ---------------------------------------------------------------------------
// caminho travado
// ---------------------------------------------------------------------------

/// id de mesa (ou "personas"): ascii, sem ponto/barra — nunca escapa da pasta.
pub fn ok_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
pub fn mesas_dir(repo: &Path) -> PathBuf { repo.join(".cardume").join("mesas") }
/// Caminho do arquivo da mesa — Err se o id não é válido.
pub fn mesa_path(repo: &Path, id: &str) -> Result<PathBuf, String> {
    if !ok_id(id) { return Err("id de mesa inválido".into()); }
    Ok(mesas_dir(repo).join(format!("{id}.json")))
}

// ---------------------------------------------------------------------------
// resumo do repositório (vai no system prompt de toda persona)
// ---------------------------------------------------------------------------

fn cut(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

/// Nome da pasta, descrição do package.json, itens da raiz e o começo do README.
/// Serve pra projeto de software e pra pasta de documentos (não assume código).
pub fn repo_summary(repo: &Path) -> String {
    let name = repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut out = format!("## O projeto\nPasta: {name}\n");
    if let Ok(pk) = std::fs::read_to_string(repo.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pk) {
            let d = v["description"].as_str().unwrap_or("").trim();
            if !d.is_empty() { out.push_str(&format!("Descrição (package.json): {}\n", cut(d, 300))); }
        }
    }
    let mut items: Vec<String> = std::fs::read_dir(repo)
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') || n == "node_modules" || n == "target" || n == "dist" { return None; }
            let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(if dir { format!("{n}/") } else { n })
        }).collect())
        .unwrap_or_default();
    items.sort();
    if !items.is_empty() {
        let more = items.len().saturating_sub(40);
        items.truncate(40);
        out.push_str(&format!("Na raiz: {}{}\n", items.join(", "), if more > 0 { format!(" (+{more})") } else { String::new() }));
    }
    for r in ["README.md", "readme.md", "README.MD", "Readme.md", "README.txt", "README"] {
        if let Ok(t) = std::fs::read_to_string(repo.join(r)) {
            let t = t.trim();
            if !t.is_empty() { out.push_str(&format!("\n### Começo do {r}\n{}\n", cut(t, 1800))); }
            break;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// processos: várias personas em paralelo por mesa, todas paráveis
// ---------------------------------------------------------------------------

pub(crate) type Killed = Arc<AtomicBool>;
fn pids() -> &'static Mutex<HashMap<String, Vec<(i32, Killed)>>> {
    static P: OnceLock<Mutex<HashMap<String, Vec<(i32, Killed)>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
/// Mesas paradas pelo usuário: chamada que ainda NÃO spawnou é recusada (senão rodava até 300 s
/// depois do "parar"). `mesa_resume` limpa ao continuar/argumentar.
fn stopped() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}
pub(crate) fn is_stopped(id: &str) -> bool { stopped().lock().unwrap_or_else(|e| e.into_inner()).contains(id) }
fn pid_del(id: &str, pid: i32) {
    let mut m = pids().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = m.get_mut(id) { v.retain(|(p, _)| *p != pid); if v.is_empty() { m.remove(id); } }
}
fn kill_list(list: &[(i32, Killed)]) { for (p, k) in list { k.store(true, Ordering::SeqCst); signal_group(*p, procsig::KILL); } }
/// Registra um processo de fora (a pesquisa da aba Ideia, que lê o stream linha a linha) sob o id: o `stop_id` o
/// derruba como derruba as personas. Devolve a marca "parado pelo usuário" desse pid.
pub(crate) fn track(id: &str, pid: i32) -> Killed {
    let killed: Killed = Arc::new(AtomicBool::new(false));
    pids().lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().push((pid, killed.clone()));
    if is_stopped(id) { kill_list(&[(pid, killed.clone())]); } // o "parar" chegou entre o spawn e o registro
    killed
}
pub(crate) fn untrack(id: &str, pid: i32) { pid_del(id, pid) }

/// Roda o claude num grupo próprio, com teto de tempo, registrado sob o id da mesa. `input` vai
/// pelo stdin (o prompt não cabe na linha de comando do Windows, 32K). Parado/estourado é
/// decidido por flags explícitas — no Windows o taskkill devolve código 1, não "sem código".
pub(crate) fn run_stoppable(mut cmd: std::process::Command, secs: u64, id: &str, input: Option<String>) -> Result<std::process::Output, String> {
    if is_stopped(id) { return Err(STOPPED.to_string()); }
    detach_new_group(&mut cmd);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("falha ao rodar claude: {e}"))?;
    let pid = child.id() as i32;
    let killed: Killed = Arc::new(AtomicBool::new(false));
    pids().lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().push((pid, killed.clone()));
    // o "parar" pode ter chegado entre a checagem e o registro do pid
    if is_stopped(id) { kill_list(&[(pid, killed.clone())]); }
    let writer = match (input, child.stdin.take()) {
        (Some(t), Some(mut w)) => Some(std::thread::spawn(move || { use std::io::Write; let _ = w.write_all(t.as_bytes()); })),
        _ => None,
    };
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let timed_out = Arc::new(AtomicBool::new(false));
    let t2 = timed_out.clone();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(std::time::Duration::from_secs(secs)).is_err() { t2.store(true, Ordering::SeqCst); signal_group(pid, procsig::KILL); }
    });
    let out = child.wait_with_output();
    let _ = tx.send(());
    let _ = watch.join();
    if let Some(w) = writer { let _ = w.join(); }
    pid_del(id, pid);
    if timed_out.load(Ordering::SeqCst) { return Err(format!("a persona demorou mais de {secs}s e foi interrompida")); }
    if killed.load(Ordering::SeqCst) { return Err(STOPPED.to_string()); }
    out.map_err(|e| e.to_string())
}

/// Custo do wrapper JSON do claude (também quando a chamada deu erro — ele cobra igual).
pub(crate) fn cost_of(out: &std::process::Output) -> f64 {
    serde_json::from_slice::<serde_json::Value>(String::from_utf8_lossy(&out.stdout).trim().as_bytes())
        .ok()
        .and_then(|v| v["total_cost_usd"].as_f64().or_else(|| v["cost_usd"].as_f64()))
        .unwrap_or(0.0)
}

/// Teto de UMA chamada (`--max-budget-usd`): a tela divide o que sobra do teto da sessão (mesa/ideia) entre as chamadas
/// em voo e manda a parte de cada uma. Arredonda pra BAIXO no centavo (nunca passa da reserva). PURA.
pub(crate) fn budget_args(budget_usd: Option<f64>) -> Vec<String> {
    match budget_usd.filter(|b| b.is_finite() && *b > 0.0).map(|b| (b * 100.0 + 1e-9).floor() / 100.0).filter(|b| *b > 0.0) {
        Some(b) => vec!["--max-budget-usd".into(), format!("{b:.2}")],
        None => vec![],
    }
}
/// O claude parou no teto da chamada (`subtype: error_max_budget_usd`). PURA.
pub(crate) fn hit_budget(stdout: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(String::from_utf8_lossy(stdout).trim().as_bytes())
        .ok()
        .map(|v| v["subtype"].as_str().unwrap_or("").contains("budget"))
        .unwrap_or(false)
}
/// Marca do "parou no teto desta chamada" — a tela devolve a persona pra fila e mostra o aviso de teto.
pub const BUDGET: &str = "MESA_BUDGET";
/// Resposta de UMA chamada ao claude: texto, erro que cobrou, ou o teto da chamada batido (MESA_BUDGET).
/// O CLI confere o teto DEPOIS de cada mensagem: a fala é cobrada inteira. Se ela veio com texto, o texto é
/// aproveitado (descartar e re-enfileirar pagaria 2×) e `budgetHit` só avisa que passou da reserva.
pub(crate) fn ask_reply(out: &std::process::Output, budget_usd: Option<f64>) -> Result<serde_json::Value, String> {
    let cost = cost_of(out);
    if hit_budget(&out.stdout) {
        let text = serde_json::from_slice::<serde_json::Value>(String::from_utf8_lossy(&out.stdout).trim().as_bytes())
            .ok().and_then(|v| v["result"].as_str().map(|s| s.trim().to_string())).unwrap_or_default();
        if !text.is_empty() { return Ok(serde_json::json!({ "text": text, "costUsd": cost, "budgetHit": true })); }
        let b = budget_usd.unwrap_or(0.0);
        return Ok(serde_json::json!({ "error": format!("{BUDGET}: a fala parou no teto desta chamada (US$ {b:.2}) — aumente o teto da sessão pra continuar"), "costUsd": cost, "budgetHit": true }));
    }
    match claude_json(out) {
        Ok(v) => Ok(serde_json::json!({ "text": v["result"].as_str().unwrap_or(""), "costUsd": cost })),
        Err(e) if cost > 0.0 => Ok(serde_json::json!({ "error": e, "costUsd": cost })),
        Err(e) => Err(e),
    }
}

/// Repo EXPLÍCITO que não existe mais = erro (cair no projeto ativo gravaria a mesa no projeto errado).
fn mesa_repo(state: &State<AppState>, repo: Option<String>) -> Result<PathBuf, String> {
    if let Some(r) = repo.as_ref().map(|r| r.trim()).filter(|r| !r.is_empty()) {
        if !Path::new(r).is_dir() { return Err("projeto da mesa não encontrado".into()); }
    }
    repo_or(state, repo)
}

/// Teto do system prompt (cérebro + README podem crescer sem limite).
pub const SYS_CAP: usize = 12000;
pub fn cap_sys(sys: String) -> String {
    if sys.chars().count() <= SYS_CAP { return sys; }
    let t: String = sys.chars().take(SYS_CAP).collect();
    format!("{t}\n\n(contexto do projeto cortado aqui por tamanho)")
}

// ---------------------------------------------------------------------------
// comandos (todos async: nada de processo ou disco na thread da janela)
// ---------------------------------------------------------------------------

/// UMA persona responde UMA vez, isolada (não vê as outras além do que vier no prompt).
/// `json`: a resposta tem que ser só o bloco JSON pedido. Devolve `{ text, costUsd }`, ou
/// `{ error, costUsd }` quando o claude respondeu com erro mas cobrou.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn mesa_ask(
    state: State<AppState>, repo: Option<String>, id: String, persona_sys: String, prompt: String,
    model: Option<String>, json: Option<bool>, budget_usd: Option<f64>,
) -> Result<serde_json::Value, String> {
    if !ok_id(&id) { return Err("id de mesa inválido".into()); }
    let repo = mesa_repo(&state, repo)?;
    let mut sys = format!(
        "{}\n\nVocê pode ler arquivos do projeto (Read, Grep, Glob) se precisar confirmar algo, mas NÃO edita nada e responde em português do Brasil.\n\n{}",
        persona_sys.trim(), repo_summary(&repo)
    );
    if json.unwrap_or(false) { sys.push_str("\n\nFORMATO: responda SOMENTE com o bloco ```json pedido — nada de texto fora dele."); }
    let query: String = prompt.chars().take(1200).collect();
    let sys = cap_sys(memoria::with_memory(&sys, &repo, &query));
    let eng = ai_once::chat_engine()?;
    if eng != ai_once::AiEngine::Claude { return ask_other(eng, &id, &sys, &prompt, &repo); }
    // prompt pelo stdin (`claude -p` sem prompt posicional lê o stdin)
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(), "json".into(),
        "--append-system-prompt".into(), sys,
        "--allowedTools".into(), "Read,Grep,Glob".into(),
    ];
    let model = model.filter(|m| !m.trim().is_empty());
    if let Some(m) = model.clone() { args.push("--model".into()); args.push(m); }
    args.extend(budget_args(budget_usd)); // teto DESTA chamada (parte do teto da mesa reservada pela tela)
    args.extend(protect_args(protect_on(&repo))); // por último: a flag é variádica
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(&args).current_dir(&repo);
    let started = std::time::Instant::now();
    let out = run_stoppable(cmd, ASK_SECS, &id, Some(prompt))?;
    crate::usage_ledger::record_claude_output(&crate::usage_ledger::Tag::new("personas", &repo, &model, &None), &out, started); // livro de uso
    ask_reply(&out, budget_usd)
}

/// A persona num motor que NÃO é o Claude (Codex/DeepSeek/gateway, ai_once::chat_turn): sem sessão, só-leitura,
/// parável pela mesa como o claude. Custo US$ 0 (como nas tarefas), com os tokens e o motor — o teto da mesa vira
/// teto por tokens na tela.
pub(crate) fn ask_other(eng: ai_once::AiEngine, id: &str, sys: &str, prompt: &str, repo: &Path) -> Result<serde_json::Value, String> {
    ask_other_as("personas", eng, id, sys, prompt, repo)
}
/// `ask_other` com a origem do livro de uso (a aba Ideia grava como "ideia").
pub(crate) fn ask_other_as(source: &str, eng: ai_once::AiEngine, id: &str, sys: &str, prompt: &str, repo: &Path) -> Result<serde_json::Value, String> {
    if is_stopped(id) { return Err(STOPPED.to_string()); }
    let killed: Killed = Arc::new(AtomicBool::new(false));
    let on_start = |pid: i32| {
        pids().lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().push((pid, killed.clone()));
        if is_stopped(id) { kill_list(&[(pid, killed.clone())]); } // o "parar" chegou entre a checagem e o registro
    };
    let on_end = |pid: i32| pid_del(id, pid);
    let stopped = |_pid: i32| killed.load(Ordering::SeqCst);
    let cancelled = || is_stopped(id);
    let t = ai_once::ChatTurn { sys, prompt, session_id: None, cwd: repo, secs: ASK_SECS, web: false };
    let h = ai_once::ChatHooks { activity: &|_| {}, on_start: &on_start, on_end: &on_end, stopped: &stopped, cancelled: &cancelled, stop_marker: STOPPED };
    let started = std::time::Instant::now();
    let r = ai_once::chat_turn(eng, &t, &h);
    ai_once::record_chat(source, eng, repo, &r, started); // livro de uso: tokens + US$ estimado
    let out = r?;
    // US$ 0 (o motor não informa preço) + tokens: a tela aplica o TETO POR TOKENS (38-mesa.js, MESA_TOK_USD: entrada/cache/saída)
    Ok(serde_json::json!({ "text": out.text, "costUsd": 0.0, "inTok": out.in_tok, "outTok": out.out_tok, "cachedTok": out.cached_tok, "engine": eng.id() }))
}

/// Para TODAS as personas desta mesa — as que estão rodando e as que ainda iam começar.
pub fn stop_id(id: &str) -> bool {
    stopped().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string());
    let list = pids().lock().unwrap_or_else(|e| e.into_inner()).remove(id).unwrap_or_default();
    kill_list(&list);
    !list.is_empty()
}
#[tauri::command(async)]
pub fn mesa_stop(id: String) -> Result<bool, String> { Ok(stop_id(&id)) }

/// Libera a mesa pra rodar de novo depois de um "parar" (Continuar / argumentar).
#[tauri::command(async)]
pub fn mesa_resume(id: String) -> Result<(), String> {
    stopped().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    Ok(())
}

/// App fechando: nenhuma persona fica rodando (os grupos são destacados do app).
pub fn mesa_kill_all() {
    let all: Vec<(i32, Killed)> = pids().lock().unwrap_or_else(|e| e.into_inner()).drain().flat_map(|(_, v)| v).collect();
    kill_list(&all);
}

pub fn save_to(repo: &Path, id: &str, data: &serde_json::Value) -> Result<(), String> {
    let p = mesa_path(repo, id)?;
    std::fs::create_dir_all(mesas_dir(repo)).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    // grava num temporário e renomeia: fechar o app no meio não deixa JSON pela metade
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = mesas_dir(repo).join(format!(".{id}.{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
}

/// Salva a mesa (ou `personas`, as personas geradas do projeto) em .cardume/mesas/<id>.json.
#[tauri::command(async)]
pub fn mesa_save(state: State<AppState>, repo: Option<String>, id: String, data: serde_json::Value) -> Result<(), String> {
    let repo = mesa_repo(&state, repo)?;
    save_to(&repo, &id, &data)
}

/// Lê uma mesa (ou `personas`). Arquivo ausente → null.
#[tauri::command(async)]
pub fn mesa_read(state: State<AppState>, repo: Option<String>, id: String) -> Result<serde_json::Value, String> {
    let repo = mesa_repo(&state, repo)?;
    read_from(&repo, &id)
}
pub fn read_from(repo: &Path, id: &str) -> Result<serde_json::Value, String> {
    let p = mesa_path(repo, id)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("mesa corrompida ({id}): {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(format!("não consegui ler a mesa ({id}): {e}")),
    }
}

pub fn list_in(repo: &Path) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = std::fs::read_dir(mesas_dir(repo))
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let id = n.strip_suffix(".json")?.to_string();
            if !ok_id(&id) || id == "personas" { return None; }
            let v: serde_json::Value = match std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()) {
                Some(v) => v,
                None => return Some(serde_json::json!({ "id": id, "status": "corrompida", "tema": format!("(arquivo {n} ilegível)"), "personas": 0, "rounds": 0 })),
            };
            Some(serde_json::json!({
                "id": id, "tema": v["tema"], "status": v["status"], "createdAt": v["createdAt"], "updatedAt": v["updatedAt"],
                "costUsd": v["costUsd"], "personas": v["personas"].as_array().map(|a| a.len()).unwrap_or(0),
                "rounds": v["rounds"].as_array().map(|a| a.len()).unwrap_or(0),
            }))
        }).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b["updatedAt"].as_i64().unwrap_or(0).cmp(&a["updatedAt"].as_i64().unwrap_or(0)));
    out
}

/// Apaga o arquivo de UMA mesa (a tela usa pra mesa ilegível). `personas` não se apaga por aqui.
pub fn delete_in(repo: &Path, id: &str) -> Result<(), String> {
    if id == "personas" { return Err("id de mesa inválido".into()); }
    let p = mesa_path(repo, id)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("não consegui apagar a mesa ({id}): {e}")),
    }
}
#[tauri::command(async)]
pub fn mesa_delete(state: State<AppState>, repo: Option<String>, id: String) -> Result<(), String> {
    let repo = mesa_repo(&state, repo)?;
    delete_in(&repo, &id)
}

/// Resumo das mesas deste projeto, mais recente primeiro.
#[tauri::command(async)]
pub fn mesa_list(state: State<AppState>, repo: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let repo = mesa_repo(&state, repo)?;
    Ok(list_in(&repo))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teto_por_chamada_vira_max_budget_e_nunca_arredonda_pra_cima() {
        assert_eq!(budget_args(Some(0.166)), ["--max-budget-usd", "0.16"], "arredonda pra baixo: a soma das reservas não passa do teto");
        assert_eq!(budget_args(Some(0.5)), ["--max-budget-usd", "0.50"]);
        assert!(budget_args(None).is_empty());
        assert!(budget_args(Some(0.0)).is_empty() && budget_args(Some(-1.0)).is_empty() && budget_args(Some(f64::NAN)).is_empty() && budget_args(Some(0.004)).is_empty());
    }

    #[test]
    fn teto_da_chamada_batido_vira_mesa_budget_com_o_custo() {
        #[cfg(unix)]
        let ok = || { use std::os::unix::process::ExitStatusExt; std::process::ExitStatus::from_raw(0) };
        #[cfg(windows)]
        let ok = || { use std::os::windows::process::ExitStatusExt; std::process::ExitStatus::from_raw(0) };
        let out = |s: &str| std::process::Output { status: ok(), stdout: s.as_bytes().to_vec(), stderr: vec![] };
        let hit = ask_reply(&out(r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.17}"#), Some(0.16)).unwrap();
        assert!(hit["error"].as_str().unwrap().starts_with(BUDGET));
        assert_eq!(hit["costUsd"].as_f64(), Some(0.17));
        assert_eq!(hit["budgetHit"].as_bool(), Some(true));
        // passou da reserva mas a fala veio inteira: aproveita o texto e conta o custo (nada de pagar 2×)
        let paga = ask_reply(&out(r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"minha posição","total_cost_usd":0.4}"#), Some(0.16)).unwrap();
        assert_eq!(paga["text"].as_str(), Some("minha posição"));
        assert_eq!(paga["costUsd"].as_f64(), Some(0.4));
        assert!(paga.get("error").is_none());
        let fine = ask_reply(&out(r#"{"type":"result","subtype":"success","is_error":false,"result":"oi","total_cost_usd":0.1}"#), Some(0.16)).unwrap();
        assert_eq!(fine["text"].as_str(), Some("oi"));
        assert!(fine.get("error").is_none());
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cardume-mesa-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn id_travado_na_pasta() {
        assert!(ok_id("m-20260928-ab12"));
        assert!(ok_id("personas"));
        for bad in ["", "../x", "a/b", "a\\b", "x.json", "..", "a b", &"x".repeat(81)] { assert!(!ok_id(bad), "{bad}"); }
        let r = Path::new("/tmp/repo");
        assert_eq!(mesa_path(r, "m1").unwrap(), PathBuf::from("/tmp/repo/.cardume/mesas/m1.json"));
        assert!(mesa_path(r, "../../etc/passwd").is_err());
    }
    #[test]
    fn salva_lista_e_le() {
        let d = tmp("io");
        save_to(&d, "m1", &serde_json::json!({"tema":"a","updatedAt":1,"personas":[1,2],"rounds":[1]})).unwrap();
        save_to(&d, "m2", &serde_json::json!({"tema":"b","updatedAt":5,"personas":[],"rounds":[]})).unwrap();
        save_to(&d, "personas", &serde_json::json!({"personas":[]})).unwrap();
        assert!(save_to(&d, "../fora", &serde_json::json!({})).is_err());
        let l = list_in(&d);
        assert!(delete_in(&d, "../fora").is_err());
        assert!(delete_in(&d, "personas").is_err());
        assert_eq!(l.len(), 2, "personas.json não é mesa");
        assert_eq!(l[0]["id"], "m2");
        assert_eq!(l[1]["personas"], 2);
        assert!(!mesas_dir(&d).join(".m1.json.tmp").exists());
        delete_in(&d, "m1").unwrap();
        assert_eq!(list_in(&d).len(), 1);
        delete_in(&d, "m1").unwrap(); // já apagada: ok (idempotente)
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn resumo_do_repo() {
        let d = tmp("sum");
        std::fs::write(d.join("README.md"), "# Agenda do pilates\nApp de agendamento.").unwrap();
        std::fs::write(d.join("package.json"), r#"{"description":"agendamento"}"#).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        std::fs::write(d.join(".env"), "SEGREDO=1").unwrap();
        let s = repo_summary(&d);
        assert!(s.contains("Agenda do pilates"), "{s}");
        assert!(s.contains("Descrição (package.json): agendamento"), "{s}");
        assert!(s.contains("src/"), "{s}");
        assert!(!s.contains("node_modules") && !s.contains(".env") && !s.contains("SEGREDO"), "{s}");
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn parar_sem_nada_rodando() {
        assert!(!stop_id("nao-existe-x"));
        mesa_resume("nao-existe-x".into()).unwrap();
    }
    #[test]
    fn corrompida_aparece_e_ausente_e_null() {
        let d = tmp("corr");
        std::fs::create_dir_all(mesas_dir(&d)).unwrap();
        std::fs::write(mesas_dir(&d).join("m9.json"), "{ quebrado").unwrap();
        let l = list_in(&d);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["status"], "corrompida");
        assert!(read_from(&d, "m9").is_err());
        assert!(read_from(&d, "nao-tem").unwrap().is_null());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn system_prompt_com_teto() {
        let s = cap_sys("x".repeat(SYS_CAP + 500));
        assert!(s.chars().count() < SYS_CAP + 100 && s.ends_with("por tamanho)"));
        assert_eq!(cap_sys("curto".into()), "curto");
    }
    #[cfg(unix)]
    fn sleep30() -> std::process::Command { let mut c = std::process::Command::new("sleep"); c.arg("30"); c }
    #[cfg(unix)]
    #[test]
    fn parar_derruba_quem_esta_rodando() {
        let id = "t-stop-run";
        let h = std::thread::spawn(move || run_stoppable(sleep30(), 60, id, None));
        let t0 = std::time::Instant::now();
        let mut hit = false;
        while t0.elapsed().as_secs() < 5 && !pids().lock().unwrap().contains_key(id) { std::thread::sleep(std::time::Duration::from_millis(20)); }
        if stop_id(id) { hit = true; }
        assert!(hit, "tinha processo rodando");
        assert_eq!(h.join().unwrap().unwrap_err(), STOPPED);
        assert!(t0.elapsed().as_secs() < 10);
        mesa_resume(id.into()).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn estourar_o_tempo_nao_e_parar() {
        let e = run_stoppable(sleep30(), 1, "t-timeout", None).unwrap_err();
        assert!(e.contains("demorou mais de 1s"), "{e}");
    }
    #[cfg(unix)]
    #[test]
    fn parado_antes_de_comecar_recusa() {
        let id = "t-stop-before";
        stop_id(id);
        assert_eq!(run_stoppable(sleep30(), 60, id, None).unwrap_err(), STOPPED);
        mesa_resume(id.into()).unwrap();
        let out = run_stoppable(std::process::Command::new("cat"), 10, id, Some("oi pelo stdin".into())).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "oi pelo stdin");
    }
    /// Persona fora do Claude (Codex falso): o "parar" da mesa derruba; rodada normal devolve US$ 0 + tokens + motor.
    #[cfg(unix)]
    #[test]
    fn persona_fora_do_claude_para_e_informa_tokens() {
        use crate::ai_once::tests::{fake_codex_chat, tmpdir};
        let d = tmpdir("mesa-other");
        let ok_bin = fake_codex_chat(&d, "");
        let _l = crate::ai_once::TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmpdir("mesa-other-home");
        let _g = crate::ai_once::tests::EnvGuard::set(&[("HOME", home.display().to_string().as_str()), ("CARDUME_CODEX", ok_bin.as_str())]);
        let v = ask_other(ai_once::AiEngine::Codex, "t-other-ok", "persona", "opine", &d).unwrap();
        assert_eq!((v["costUsd"].as_f64(), v["inTok"].as_u64(), v["outTok"].as_u64(), v["engine"].as_str()), (Some(0.0), Some(120), Some(30), Some("codex")));
        // travando: stop_id derruba e devolve MESA_STOPPED
        let d2 = tmpdir("mesa-other-sleep");
        let sleep_bin = fake_codex_chat(&d2, "sleep");
        std::env::set_var("CARDUME_CODEX", &sleep_bin);
        let id = "t-other-stop";
        let t0 = std::time::Instant::now();
        let r = std::thread::scope(|sc| {
            let h = sc.spawn(|| ask_other(ai_once::AiEngine::Codex, id, "persona", "opine", &d2));
            while t0.elapsed().as_secs() < 5 && !pids().lock().unwrap().contains_key(id) { std::thread::sleep(std::time::Duration::from_millis(20)); }
            assert!(stop_id(id), "tinha persona rodando");
            h.join().unwrap()
        });
        assert_eq!(r.unwrap_err(), STOPPED);
        assert!(t0.elapsed().as_secs() < 10);
        // parada antes de começar: nem abre processo
        assert_eq!(ask_other(ai_once::AiEngine::Codex, id, "p", "q", &d2).unwrap_err(), STOPPED);
        mesa_resume(id.into()).unwrap();
        for p in [&d, &d2, &home] { let _ = std::fs::remove_dir_all(p); }
    }
}
