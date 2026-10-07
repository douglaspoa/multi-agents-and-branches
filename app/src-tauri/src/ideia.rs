//! COMEÇAR POR UMA IDEIA (spec-ideia-mesa-pesquisa) — a aba "Ideia: <título>" (app/src/js/59-ideia.js).
//! Funciona SEM projeto aberto: a ideia mora em `~/.constellation/ideias/<id>.json` (conversa, relatório, decisão).
//! Aqui só o que precisa de processo/disco:
//!   - `ideia_save`/`ideia_read`/`ideia_list`/`ideia_delete`: o arquivo da ideia (id validado, sem separador);
//!   - `ideia_ask`: UMA persona responde UMA vez, SEM ferramentas (não há projeto pra ler);
//!   - `ideia_research_mode`/`ideia_research`: a PESQUISA. Padrão = ferramentas de web NATIVAS do motor (Claude:
//!     WebSearch/WebFetch; Codex: `web_search="live"`; DeepSeek Harness: busca/leitura do perfil headless). O gateway
//!     não navega: com a "pesquisa ampliada" (Agent Reach) instalada, o app coleta fontes públicas e o gateway escreve
//!     o relatório só com elas; sem ela, a tela explica. Progresso por EVENTO (`ideia-activity`), nada de polling;
//!     parável (mesmo registro de processos da mesa: `mesa_stop`/`mesa_resume` com `<id>-r`);
//!   - Agent Reach (`reach_*`): add-on OPCIONAL, versão FIXA, instalado num venv isolado em
//!     `~/.constellation/tools/agent-reach` por uv (ou python3 -m venv + pip) — NUNCA pelo install.md remoto, nunca
//!     `agent-reach install/configure/setup`. Só canais públicos sem configuração; os de cookie/login ficam desligados;
//!   - `ideia_commit_doc`: grava `docs/<arquivo>.md` no projeto criado e commita só ele.
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use super::{ai_once, claude_bin, claude_cmd, home_dir_s, mesa, push_model, tool_line, usage_ledger};

/// Resposta de uma persona (s): só opina, sem ferramentas.
const ASK_SECS: u64 = 300;
/// Uma rodada de pesquisa (s): busca + leitura de páginas leva minutos, não horas.
const RESEARCH_SECS: u64 = 900;
/// Reformatar o relatório (sessão retomada, sem ferramentas).
const FIX_SECS: u64 = 240;

// ---------------------------------------------------------------------------
// pasta das ideias
// ---------------------------------------------------------------------------

/// `~/.constellation/ideias` (CARDUME_IDEIAS_DIR só pra testes).
pub fn ideias_dir() -> PathBuf {
    std::env::var("CARDUME_IDEIAS_DIR").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home_dir_s()).join(".constellation").join("ideias"))
}
/// Caminho do arquivo da ideia — Err se o id não é seguro (mesma regra das mesas).
pub fn ideia_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !mesa::ok_id(id) || id.ends_with("-r") { return Err("id de ideia inválido".into()); }
    Ok(dir.join(format!("{id}.json")))
}
pub fn save_in(dir: &Path, id: &str, data: &serde_json::Value) -> Result<(), String> {
    let p = ideia_path(dir, id)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("não consegui criar a pasta das ideias: {e}"))?;
    let s = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(".{id}.{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
}
pub fn read_in(dir: &Path, id: &str) -> Result<serde_json::Value, String> {
    let p = ideia_path(dir, id)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("o arquivo da ideia ({id}) está ilegível: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(format!("não consegui ler a ideia ({id}): {e}")),
    }
}
/// Resumo das ideias, mais recente primeiro (o arquivo ilegível aparece como tal — não some calado).
pub fn list_in(dir: &Path) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let id = n.strip_suffix(".json")?.to_string();
            if ideia_path(dir, &id).is_err() { return None; }
            let v: serde_json::Value = match std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()) {
                Some(v) => v,
                None => return Some(serde_json::json!({ "id": id, "titulo": format!("(arquivo {n} ilegível)"), "corrompida": true, "updatedAt": 0 })),
            };
            Some(serde_json::json!({
                "id": id, "titulo": v["titulo"], "createdAt": v["createdAt"], "updatedAt": v["updatedAt"], "costUsd": v["costUsd"], "tokUsd": v["tokUsd"],
                "turnos": v["turns"].as_array().map(|a| a.len()).unwrap_or(0),
                "pesquisa": v["report"]["status"], "decisao": v["decision"]["status"], "projeto": v["project"]["dir"],
            }))
        }).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b["updatedAt"].as_i64().unwrap_or(0).cmp(&a["updatedAt"].as_i64().unwrap_or(0)));
    out
}
pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    let p = ideia_path(dir, id)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("não consegui apagar a ideia ({id}): {e}")),
    }
}

#[tauri::command(async)]
pub fn ideia_save(id: String, data: serde_json::Value) -> Result<(), String> { save_in(&ideias_dir(), &id, &data) }
#[tauri::command(async)]
pub fn ideia_read(id: String) -> Result<serde_json::Value, String> { read_in(&ideias_dir(), &id) }
#[tauri::command(async)]
pub fn ideia_list() -> Result<Vec<serde_json::Value>, String> { Ok(list_in(&ideias_dir())) }
#[tauri::command(async)]
pub fn ideia_delete(id: String) -> Result<(), String> { delete_in(&ideias_dir(), &id) }

// ---------------------------------------------------------------------------
// uma persona (sem ferramentas)
// ---------------------------------------------------------------------------

/// Argumentos do claude pra UMA fala de persona: JSON, sem NENHUMA ferramenta (`--tools ""`), prompt pelo STDIN. PURA.
pub(crate) fn persona_args(sys: &str, model: &Option<String>) -> Vec<String> {
    let mut a: Vec<String> = vec!["-p".into(), "--output-format".into(), "json".into(), "--append-system-prompt".into(), sys.into(), "--tools".into(), String::new()];
    push_model(&mut a, model);
    a
}

/// UMA persona responde UMA vez sobre a ideia. `{ text, costUsd }` (Claude) ou `{ text, costUsd:0, inTok, outTok,
/// cachedTok, engine }` (outros motores — a tela estima pelo token, como na mesa); `{ error, costUsd }` se cobrou e falhou.
#[tauri::command(async)]
pub fn ideia_ask(id: String, persona_sys: String, prompt: String, model: Option<String>, json: Option<bool>, budget_usd: Option<f64>) -> Result<serde_json::Value, String> {
    if ideia_path(Path::new("."), &id).is_err() { return Err("id de ideia inválido".into()); }
    let dir = ideias_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut sys = format!("{}\n\nResponda em português do Brasil, sem ferramentas: você não tem acesso à internet nem a arquivos nesta fala. Não invente números nem fatos de mercado — quando não souber, diga que é preciso pesquisar.", persona_sys.trim());
    if json.unwrap_or(false) { sys.push_str("\n\nFORMATO: responda SOMENTE com o bloco ```json pedido — nada de texto fora dele."); }
    let sys = mesa::cap_sys(sys);
    let eng = ai_once::chat_engine()?;
    if eng != ai_once::AiEngine::Claude { return mesa::ask_other_as("ideia", eng, &id, &sys, &prompt, &dir); }
    let model = model.filter(|m| !m.trim().is_empty());
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(persona_args(&sys, &model)).args(mesa::budget_args(budget_usd)).current_dir(&dir); // teto DESTA fala (parte do teto da ideia)
    let started = Instant::now();
    let out = mesa::run_stoppable(cmd, ASK_SECS, &id, Some(prompt))?;
    usage_ledger::record_claude_output(&usage_ledger::Tag::new("ideia", &dir, &model, &None), &out, started);
    mesa::ask_reply(&out, budget_usd)
}

// ---------------------------------------------------------------------------
// pesquisa: qual caminho em cada motor
// ---------------------------------------------------------------------------

pub(crate) const NO_WEB_MSG: &str = "A pesquisa precisa de uma IA com busca na web: Claude, Codex ou DeepSeek. O gateway da empresa não navega — escolha outra IA em Ajustes › Motores e chaves, ou instale a pesquisa ampliada (Agent Reach) em Ajustes › Verificação pra pesquisar com ele mesmo assim.";

/// Caminho da pesquisa por motor. PURA — testada. "native" = ferramentas de web do próprio motor; "reach" = o app
/// coleta fontes públicas com o Agent Reach e o motor (sem ferramentas) escreve; "none" = não dá.
pub(crate) fn research_mode(eng: ai_once::AiEngine, reach_installed: bool) -> &'static str {
    match eng {
        ai_once::AiEngine::Claude | ai_once::AiEngine::Codex | ai_once::AiEngine::Deepseek => "native",
        ai_once::AiEngine::Gateway => if reach_installed { "reach" } else { "none" },
    }
}
/// O que cada motor usa pra navegar (texto da tela). PURA.
pub(crate) fn research_tools(eng: ai_once::AiEngine, mode: &str) -> &'static str {
    match (eng, mode) {
        (ai_once::AiEngine::Claude, _) => "busca e leitura de páginas do Claude Code (WebSearch, WebFetch)",
        (ai_once::AiEngine::Codex, _) => "busca na web do Codex",
        (ai_once::AiEngine::Deepseek, _) => "busca e leitura de páginas do DeepSeek Harness",
        (ai_once::AiEngine::Gateway, "reach") => "pesquisa ampliada (Agent Reach): Hacker News, GitHub e YouTube públicos",
        _ => "",
    }
}

#[tauri::command(async)]
pub fn ideia_research_mode() -> Result<serde_json::Value, String> {
    let eng = ai_once::chat_engine()?;
    let st = reach_status_of(&reach_dir());
    let installed = st["installed"].as_bool().unwrap_or(false);
    let mode = research_mode(eng, installed);
    Ok(serde_json::json!({
        "engine": eng.id(), "mode": mode, "tools": research_tools(eng, mode),
        "reach": st, "msg": if mode == "none" { NO_WEB_MSG } else { "" },
    }))
}

// ---------------------------------------------------------------------------
// pesquisa: o stream do Claude
// ---------------------------------------------------------------------------

/// Ferramentas da pesquisa no Claude: SÓ a web nativa (WebSearch, WebFetch). Nada de Bash — nem com o Agent Reach: uma
/// página lida poderia injetar `yt-dlp --cookies-from-browser`/`--exec` ou `curl -o`. O Agent Reach entra pelo app,
/// com argumentos FIXOS (`reach_collect`), e o material vai no prompt.
pub(crate) const RESEARCH_TOOLS_CLAUDE: &str = "WebSearch,WebFetch";
/// Argumentos do claude na rodada de pesquisa (stream-json, prompt pelo STDIN). `fix` = só reformatar o JSON (sessão
/// retomada, SEM ferramentas). PURA — testada.
#[cfg(test)]
pub(crate) fn research_args(sys: &str, model: &Option<String>, budget_usd: Option<f64>, resume: Option<&str>, fix: bool) -> Vec<String> {
    research_args_with(sys, model, budget_usd, resume, if fix { "" } else { RESEARCH_TOOLS_CLAUDE })
}
/// O mesmo, com as ferramentas EXPLÍCITAS ("" = nenhuma) — a Fábrica usa leitura de código (Read/Grep/Glob) no projeto.
/// Nunca Bash. PURA — testada.
/// As ÚNICAS ferramentas que uma rodada de pesquisa/leitura pode ter.
pub(crate) const RESEARCH_ALLOWED: [&str; 5] = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];
/// Leituras negadas quando há Read (regras de permissão do Claude Code).
pub(crate) const SECRET_READS: [&str; 7] = ["Read(.env*)", "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)", "Read(**/.ssh/**)", "Read(**/secrets/**)"];
pub(crate) fn research_args_with(sys: &str, model: &Option<String>, budget_usd: Option<f64>, resume: Option<&str>, tools: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["-p".into(), "--output-format".into(), "stream-json".into(), "--verbose".into(), "--append-system-prompt".into(), sys.into()];
    // LISTA DE PERMITIDAS (nunca Write/Edit/Bash/NotebookEdit): o que não está aqui some, com ou sem argumento
    let tools: String = tools.split(',').map(str::trim).filter(|t| RESEARCH_ALLOWED.contains(t)).collect::<Vec<_>>().join(",");
    if tools.is_empty() {
        a.extend(["--tools".to_string(), String::new()]);
    } else {
        let read = tools.contains("Read");
        a.extend(["--tools".to_string(), tools.clone(), "--allowedTools".to_string(), tools]);
        // leitura de código: segredos ficam de fora mesmo que um texto injetado peça
        if read { a.extend(["--disallowedTools".to_string(), SECRET_READS.join(",")]); }
    }
    if let Some(b) = budget_usd.filter(|b| b.is_finite() && *b > 0.0) { a.push("--max-budget-usd".into()); a.push(format!("{b:.2}")); }
    if let Some(s) = resume.filter(|s| !s.trim().is_empty()) { a.push("--resume".into()); a.push(s.trim().into()); }
    push_model(&mut a, model);
    a
}

/// Evento de uma linha do stream do Claude na pesquisa.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StreamEv {
    /// linha de atividade ("consultando …") + a URL quando é leitura de página
    Tool(String, Option<String>),
    /// texto final, sessão, erro?, a linha inteira (custo/tokens pro livro)
    Result(String, String, bool, serde_json::Value),
}
/// Uma linha do `claude -p --output-format stream-json` → eventos. PURA — testada.
pub(crate) fn stream_events(line: &str) -> Vec<StreamEv> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return vec![] };
    match v["type"].as_str().unwrap_or("") {
        "assistant" => v.pointer("/message/content").and_then(|c| c.as_array()).map(|parts| parts.iter().filter_map(|p| {
            if p["type"].as_str() != Some("tool_use") { return None; }
            let name = p["name"].as_str().unwrap_or("tool");
            let inp = p.get("input").cloned().unwrap_or(serde_json::Value::Null);
            let url = inp["url"].as_str().filter(|u| u.starts_with("http")).map(String::from);
            Some(StreamEv::Tool(tool_line(name, &inp), url))
        }).collect()).unwrap_or_default(),
        "result" => {
            let err = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().is_some_and(|t| t.starts_with("error"));
            vec![StreamEv::Result(v["result"].as_str().unwrap_or("").to_string(), v["session_id"].as_str().unwrap_or("").to_string(), err, v.clone())]
        }
        _ => vec![],
    }
}

/// Mensagem do fim de uma pesquisa do Claude com erro (teto, limite). PURA.
pub(crate) fn claude_result_error(v: &serde_json::Value, budget_usd: Option<f64>) -> String {
    let sub = v["subtype"].as_str().unwrap_or("");
    if sub.contains("budget") {
        return format!("a pesquisa bateu no teto de US$ {:.2} antes de terminar — aumente o teto e pesquise de novo", budget_usd.unwrap_or(0.0));
    }
    if sub.contains("max_turns") { return "a pesquisa usou o máximo de passos sem terminar — tente de novo com uma ideia mais específica".into(); }
    let r = v["result"].as_str().unwrap_or("").trim();
    if r.is_empty() { "a IA terminou a pesquisa com erro — tente de novo".into() } else { r.chars().take(400).collect() }
}

/// Ganchos de "parar" pela chave da pesquisa (`<id>-r`), no mesmo registro de processos da mesa.
pub(crate) struct Keyed<'a> { key: &'a str, killed: RefCell<Option<mesa::Killed>> }
impl<'a> Keyed<'a> {
    pub(crate) fn new(key: &'a str) -> Self { Keyed { key, killed: RefCell::new(None) } }
    fn on_start(&self, pid: i32) { *self.killed.borrow_mut() = Some(mesa::track(self.key, pid)); }
    fn on_end(&self, pid: i32) { mesa::untrack(self.key, pid) }
    fn stopped(&self) -> bool { self.killed.borrow().as_ref().is_some_and(|k| k.load(Ordering::SeqCst)) }
    fn cancelled(&self) -> bool { mesa::is_stopped(self.key) }
}

fn emit_line(app: &AppHandle, id: &str, line: &str, url: Option<&str>) {
    let _ = app.emit("ideia-activity", serde_json::json!({ "id": id, "line": line, "url": url }));
}

/// Onde e com quê roda uma rodada: a Ideia = pasta das ideias + web; a Fábrica (fabrica.rs) = o projeto + leitura de
/// código, ou rodada sem ferramentas. `source` = etiqueta no livro de uso.
/// `reach` = junta o material da pesquisa ampliada (Agent Reach) no prompt quando instalada — a Ideia sempre; a Fábrica
/// só no gateway (com web nativa o material genérico atrapalhava: "use SÓ estas fontes" com vídeos fora do foco).
pub(crate) struct Run<'a> { pub source: &'a str, pub cwd: &'a Path, pub tools: &'a str, pub secs: u64, pub reach: bool }

#[allow(clippy::too_many_arguments)]
pub(crate) fn research_claude(emit: &dyn Fn(&str, Option<&str>), key: &str, sys: &str, prompt: &str, model: &Option<String>, budget_usd: Option<f64>, resume: Option<&str>, fix: bool) -> Result<serde_json::Value, String> {
    let dir = ideias_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let run = Run { source: "ideia", cwd: &dir, tools: if fix { "" } else { RESEARCH_TOOLS_CLAUDE }, secs: if fix { FIX_SECS } else { RESEARCH_SECS }, reach: true };
    research_claude_in(emit, key, sys, prompt, model, budget_usd, resume, &run)
}
/// A rodada do Claude com o `Run` dado (pasta, ferramentas, tempo). Sem ferramentas = sem pesquisa ampliada.
#[allow(clippy::too_many_arguments)]
pub(crate) fn research_claude_in(emit: &dyn Fn(&str, Option<&str>), key: &str, sys: &str, prompt: &str, model: &Option<String>, budget_usd: Option<f64>, resume: Option<&str>, run: &Run) -> Result<serde_json::Value, String> {
    let (dir, fix) = (run.cwd, run.tools.trim().is_empty());
    let k = Keyed::new(key);
    let prompt = &with_reach(prompt, fix || !run.reach || !run.tools.contains("WebSearch"), emit, &k)?;
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(research_args_with(sys, model, budget_usd, resume, run.tools)).current_dir(dir);
    let (on_start, on_end, stopped, cancelled) = (|p: i32| k.on_start(p), |p: i32| k.on_end(p), |_p: i32| k.stopped(), || k.cancelled());
    let h = ai_once::ChatHooks { activity: &|_| {}, on_start: &on_start, on_end: &on_end, stopped: &stopped, cancelled: &cancelled, stop_marker: mesa::STOPPED };
    let started = Instant::now();
    let mut fin: Option<(String, String, bool, serde_json::Value)> = None;
    let r = ai_once::run_proc(cmd, Some(prompt), run.secs, &h, &mut |line| {
        for ev in stream_events(line) {
            match ev {
                StreamEv::Tool(l, u) => emit(&l, u.as_deref()),
                StreamEv::Result(t, s, e, v) => fin = Some((t, s, e, v)),
            }
        }
    });
    if let Some((_, _, err, v)) = &fin {
        usage_ledger::record(usage_ledger::claude_entry(run.source, Some(dir), model.as_deref(), None, v, started.elapsed().as_millis() as i64, !err));
    }
    match r {
        Err(ai_once::ProcErr::Stopped) => return Err(mesa::STOPPED.into()),
        Err(ai_once::ProcErr::Timeout) => return Err(format!("a pesquisa passou de {} min e foi interrompida", (run.secs / 60).max(1))),
        Err(ai_once::ProcErr::Crash) => return Err("o Claude Code foi encerrado no meio da pesquisa — tente de novo".into()),
        Err(ai_once::ProcErr::Spawn(e)) => return Err(format!("não consegui rodar o Claude Code: {e}")),
        Ok(_) => {}
    }
    let Some((text, sid, err, v)) = fin else { return Err("o Claude Code terminou sem resposta — tente de novo".into()) };
    let cost = v["total_cost_usd"].as_f64().unwrap_or(0.0);
    if err { return Ok(serde_json::json!({ "error": claude_result_error(&v, budget_usd), "costUsd": cost, "sessionId": sid })); }
    Ok(serde_json::json!({ "text": text, "sessionId": sid, "costUsd": cost, "engine": "claude" }))
}

/// Codex/DeepSeek: a mesma rodada de chat com a web ligada (`web: true`); gateway: o material coletado vai no prompt.
#[allow(clippy::too_many_arguments)]
fn research_other(emit: &dyn Fn(&str, Option<&str>), eng: ai_once::AiEngine, key: &str, sys: &str, prompt: &str, resume: Option<&str>, fix: bool) -> Result<serde_json::Value, String> {
    let dir = ideias_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let run = Run { source: "ideia", cwd: &dir, tools: if fix { "" } else { RESEARCH_TOOLS_CLAUDE }, secs: if fix { FIX_SECS } else { RESEARCH_SECS }, reach: true };
    research_other_in(emit, eng, key, sys, prompt, resume, &run)
}
/// Codex/DeepSeek/gateway com o `Run` dado: web ligada quando o Run pede busca; a pasta é lida SÓ-LEITURA.
#[allow(clippy::too_many_arguments)]
pub(crate) fn research_other_in(emit: &dyn Fn(&str, Option<&str>), eng: ai_once::AiEngine, key: &str, sys: &str, prompt: &str, resume: Option<&str>, run: &Run) -> Result<serde_json::Value, String> {
    let (dir, fix) = (run.cwd, !run.tools.contains("WebSearch"));
    let k = Keyed::new(key);
    let (on_start, on_end, stopped, cancelled) = (|p: i32| k.on_start(p), |p: i32| k.on_end(p), |_p: i32| k.stopped(), || k.cancelled());
    // "consultando https://…" (leitura de página no DeepSeek) conta como página lida
    let act = |l: String| { let u = url_in(&l); emit(&l, u.as_deref()); };
    let h = ai_once::ChatHooks { activity: &act, on_start: &on_start, on_end: &on_end, stopped: &stopped, cancelled: &cancelled, stop_marker: mesa::STOPPED };
    if eng == ai_once::AiEngine::Gateway && !fix && !reach_installed(&reach_dir()) { return Err(NO_WEB_MSG.into()); }
    let full = with_reach(prompt, fix || !run.reach, emit, &k)?;
    if eng == ai_once::AiEngine::Gateway && !fix && !full.contains(REACH_MARK) {
        return Err("a pesquisa ampliada não achou nenhuma fonte pública pra essa ideia — tente outras palavras ou outra IA".into());
    }
    // gateway não tem sessão: a correção leva a resposta anterior no próprio prompt (o front manda)
    let resume = if eng == ai_once::AiEngine::Gateway { None } else { resume };
    let t = ai_once::ChatTurn { sys, prompt: &full, session_id: resume, cwd: dir, secs: run.secs, web: !fix };
    let started = Instant::now();
    let r = ai_once::chat_turn(eng, &t, &h);
    ai_once::record_chat(run.source, eng, dir, &r, started);
    let out = r?;
    Ok(serde_json::json!({ "text": out.text, "sessionId": out.session_id, "costUsd": 0.0, "inTok": out.in_tok, "outTok": out.out_tok, "cachedTok": out.cached_tok, "engine": eng.id() }))
}

/// Com a pesquisa ampliada instalada (e fora da correção), coleta as fontes públicas com argumentos FIXOS e põe no
/// prompt — vale pra todo motor. Sem ela, o prompt segue igual.
fn with_reach(prompt: &str, fix: bool, emit: &dyn Fn(&str, Option<&str>), k: &Keyed) -> Result<String, String> {
    let rd = reach_dir();
    if fix || !reach_installed(&rd) { return Ok(prompt.to_string()); }
    let srcs = reach_collect(&query_of(prompt), &rd, &|l| emit(l, None), k);
    if k.cancelled() { return Err(mesa::STOPPED.into()); }
    for s in &srcs { emit(&format!("fonte: {}", s.titulo), Some(&s.url)); }
    Ok(if srcs.is_empty() { prompt.to_string() } else { format!("{prompt}{}", reach_material(&srcs)) })
}
/// A primeira URL de uma linha de atividade. PURA.
pub(crate) fn url_in(line: &str) -> Option<String> {
    let i = line.find("http://").or_else(|| line.find("https://"))?;
    let u: String = line[i..].chars().take_while(|c| !c.is_whitespace() && *c != '…').collect();
    if u.len() > 10 { Some(u) } else { None }
}

/// Uma rodada de PESQUISA (ou, com `fix`, a correção do JSON do relatório na MESMA sessão, sem ferramentas). O
/// progresso sai no evento `ideia-activity` ({ id, line, url }); parar = `mesa_stop` com `<id>-r`.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn ideia_research(app: AppHandle, id: String, sys: String, prompt: String, model: Option<String>, budget_usd: Option<f64>, session_id: Option<String>, fix: Option<bool>) -> Result<serde_json::Value, String> {
    if ideia_path(Path::new("."), &id).is_err() { return Err("id de ideia inválido".into()); }
    let key = format!("{id}-r");
    let fix = fix.unwrap_or(false);
    let eng = ai_once::chat_engine()?;
    let model = model.filter(|m| !m.trim().is_empty());
    let resume = session_id.as_deref().filter(|s| !s.trim().is_empty());
    let emit = |l: &str, u: Option<&str>| emit_line(&app, &id, l, u);
    if eng == ai_once::AiEngine::Claude {
        let sid = match resume { Some(s) => ai_once::sid_resume(eng, Some(s))?, None => None };
        return research_claude(&emit, &key, &sys, &prompt, &model, budget_usd, sid.as_deref(), fix);
    }
    if !fix && research_mode(eng, reach_installed(&reach_dir())) == "none" { return Err(NO_WEB_MSG.into()); }
    research_other(&emit, eng, &key, &sys, &prompt, resume, fix)
}

// ---------------------------------------------------------------------------
// pesquisa ampliada (Agent Reach) — instalação, doctor e a coleta pro gateway
// ---------------------------------------------------------------------------

/// Versão FIXA do Agent Reach (MIT) — a tag v1.5.0 resolvida pro commit: um push novo no repositório não muda o que
/// instalamos.
pub(crate) const REACH_VERSION: &str = "1.5.0";
pub(crate) const REACH_COMMIT: &str = "f65526cbaaad3879473acc1ba6dbefd195caf2be";
pub(crate) const REACH_REPO: &str = "https://github.com/Panniantong/Agent-Reach";
/// Canais PÚBLICOS, sem configuração, que a pesquisa usa.
pub(crate) const REACH_PUBLIC: [&str; 6] = ["web", "youtube", "rss", "github", "v2ex", "exa_search"];
/// Canais de cookie/login: NUNCA configurados nem usados (violam os termos dos sites e arriscam banir a conta).
pub(crate) const REACH_COOKIE: [&str; 8] = ["twitter", "reddit", "xiaohongshu", "facebook", "instagram", "linkedin", "boss", "xueqiu"];
/// Subcomandos do agent-reach que o Starfork NUNCA roda (instalam dependências do sistema, extraem cookies do
/// navegador ou seguem instruções remotas).
pub(crate) const REACH_NEVER: [&str; 5] = ["install", "configure", "setup", "skill", "transcribe"];

pub(crate) fn reach_dir() -> PathBuf {
    std::env::var("CARDUME_REACH_DIR").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home_dir_s()).join(".constellation").join("tools").join("agent-reach"))
}
pub(crate) fn venv_bin_dir(dir: &Path) -> PathBuf { if cfg!(windows) { dir.join("venv").join("Scripts") } else { dir.join("venv").join("bin") } }
fn exe(name: &str) -> String { if cfg!(windows) { format!("{name}.exe") } else { name.to_string() } }
pub(crate) fn reach_bin(dir: &Path) -> PathBuf { venv_bin_dir(dir).join(exe("agent-reach")) }
pub(crate) fn reach_installed(dir: &Path) -> bool { reach_bin(dir).is_file() }
/// Pacote pro pip/uv: o repositório no commit fixo.
pub(crate) fn reach_spec() -> String { format!("agent-reach @ git+{REACH_REPO}@{REACH_COMMIT}") }
fn path_with(bin: &Path) -> std::ffi::OsString {
    let mut dirs = vec![bin.to_path_buf()];
    if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Quem instala: o `uv` (traz o próprio Python 3.12 — o do macOS é 3.9) ou um python3 ≥ 3.10.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Installer { Uv(String), Python(String) }
/// Passos da instalação (cada um um comando, sem shell). PURA — testada (e nenhum passo roda `agent-reach`).
pub(crate) fn reach_install_plan(inst: &Installer, dir: &Path) -> Vec<Vec<String>> {
    let venv = dir.join("venv").display().to_string();
    let py = venv_bin_dir(dir).join(exe("python")).display().to_string();
    match inst {
        Installer::Uv(uv) => vec![
            vec![uv.clone(), "venv".into(), venv, "--python".into(), "3.12".into(), "--quiet".into()],
            vec![uv.clone(), "pip".into(), "install".into(), "--quiet".into(), "--python".into(), py, reach_spec()],
        ],
        Installer::Python(p) => vec![
            vec![p.clone(), "-m".into(), "venv".into(), venv],
            vec![py, "-m".into(), "pip".into(), "install".into(), "--quiet".into(), "--disable-pip-version-check".into(), reach_spec()],
        ],
    }
}
/// O doctor: `agent-reach doctor --json` do venv, com o venv na frente do PATH (o yt-dlp dele). PURA.
pub(crate) fn reach_doctor_args() -> Vec<String> { vec!["doctor".into(), "--json".into()] }

fn which(name: &str) -> Option<String> {
    let p = std::env::var_os("PATH")?;
    std::env::split_paths(&p).map(|d| d.join(exe(name))).find(|f| f.is_file()).map(|f| f.display().to_string())
}
fn python_ok(py: &str) -> bool {
    Command::new(py).args(["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]).output().map(|o| o.status.success()).unwrap_or(false)
}
/// uv (CARDUME_UV, PATH, ~/.local/bin, ~/.cargo/bin) ou python3 ≥ 3.10 (CARDUME_PYTHON, PATH).
pub(crate) fn find_installer() -> Option<Installer> {
    let env = |k: &str| std::env::var(k).ok().filter(|s| !s.trim().is_empty());
    let home = PathBuf::from(home_dir_s());
    let uv = env("CARDUME_UV").or_else(|| which("uv")).or_else(|| {
        [home.join(".local/bin").join(exe("uv")), home.join(".cargo/bin").join(exe("uv"))].into_iter().find(|f| f.is_file()).map(|f| f.display().to_string())
    });
    if let Some(u) = uv.filter(|u| Path::new(u).is_file()) { return Some(Installer::Uv(u)); }
    let py = env("CARDUME_PYTHON").or_else(|| which("python3")).or_else(|| which("python"))?;
    if python_ok(&py) { Some(Installer::Python(py)) } else { None }
}

fn reach_meta(dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(dir.join("starfork.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
pub(crate) fn reach_status_of(dir: &Path) -> serde_json::Value {
    let m = reach_meta(dir);
    serde_json::json!({
        "installed": reach_installed(dir), "dir": dir.display().to_string(), "pinned": REACH_VERSION,
        "version": m["version"], "installedAt": m["installedAt"],
    })
}

/// Saída do doctor → canais com o uso NO STARFORK. Cookie/login = "bloqueado" SEMPRE (mesmo que o doctor diga ok,
/// ex.: a pessoa configurou fora do app). PURA — testada.
pub(crate) fn reach_parse_doctor(raw: &str) -> Result<Vec<serde_json::Value>, String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|_| "o doctor do Agent Reach não devolveu JSON".to_string())?;
    let obj = v.as_object().ok_or("o doctor do Agent Reach devolveu um formato inesperado")?;
    let name = |id: &str| match id {
        "web" => "Páginas da web (Jina Reader)", "youtube" => "YouTube (legendas e busca)", "rss" => "RSS/Atom", "github" => "GitHub público",
        "v2ex" => "V2EX", "exa_search" => "Busca Exa (MCP)", "twitter" => "Twitter/X", "reddit" => "Reddit", "xiaohongshu" => "Xiaohongshu",
        "facebook" => "Facebook", "instagram" => "Instagram", "linkedin" => "LinkedIn", "boss" => "Boss Zhipin", "xueqiu" => "Xueqiu",
        "bilibili" => "Bilibili", "xiaoyuzhou" => "Xiaoyuzhou (podcast)", _ => "",
    };
    let mut out: Vec<serde_json::Value> = obj.iter().map(|(id, c)| {
        let status = c["status"].as_str().unwrap_or("off");
        let uso = if REACH_COOKIE.contains(&id.as_str()) { "bloqueado" }
            else if REACH_PUBLIC.contains(&id.as_str()) { if status == "ok" { "ativo" } else { "indisponivel" } }
            else { "fora" };
        let nota = match uso {
            "bloqueado" => "login/cookies — o Starfork não configura nem usa".to_string(),
            "fora" => "fora da pesquisa do Starfork".to_string(),
            "indisponivel" if id == "exa_search" => "precisa do mcporter (npm) — não instalado pelo Starfork".to_string(),
            "indisponivel" => "não respondeu nesta máquina agora".to_string(),
            _ => "ok".to_string(),
        };
        let n = name(id);
        serde_json::json!({ "id": id, "nome": if n.is_empty() { id.as_str() } else { n }, "status": status, "uso": uso, "nota": nota })
    }).collect();
    let rank = |u: &str| match u { "ativo" => 0, "indisponivel" => 1, "fora" => 2, _ => 3 };
    out.sort_by_key(|c| rank(c["uso"].as_str().unwrap_or("")));
    Ok(out)
}

fn run_logged(app: Option<&AppHandle>, argv: &[String], secs: u64) -> Result<(), String> {
    if let Some(a) = app { let _ = a.emit("reach-progress", serde_json::json!({ "line": format!("rodando {}", argv.iter().map(|x| if x.contains(' ') { format!("\"{x}\"") } else { x.clone() }).collect::<Vec<_>>().join(" ")) })); }
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdin(Stdio::null());
    // nada de cookies/credenciais herdadas pro pip: só o necessário pra baixar do GitHub/PyPI
    cmd.env_remove("PIP_INDEX_URL").env_remove("UV_INDEX_URL");
    let out = super::output_timeout(cmd, secs)?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        let tail: String = e.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("falhou: {}\n{}", argv[..argv.len().min(3)].join(" "), tail.trim()));
    }
    Ok(())
}
/// Instala no diretório dado (testável com uv/python falsos). Grava `starfork.json` com a versão.
pub(crate) fn reach_install_in(app: Option<&AppHandle>, dir: &Path, inst: &Installer) -> Result<serde_json::Value, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("não consegui criar {}: {e}", dir.display()))?;
    for step in reach_install_plan(inst, dir) { run_logged(app, &step, 600)?; }
    if !reach_installed(dir) { return Err("a instalação terminou mas o agent-reach não apareceu no venv".into()); }
    let meta = serde_json::json!({ "version": REACH_VERSION, "commit": REACH_COMMIT, "installedAt": super::now_ms(), "via": match inst { Installer::Uv(_) => "uv", Installer::Python(_) => "python" } });
    std::fs::write(dir.join("starfork.json"), serde_json::to_string_pretty(&meta).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(reach_status_of(dir))
}
pub(crate) fn reach_doctor_in(dir: &Path) -> Result<Vec<serde_json::Value>, String> {
    if !reach_installed(dir) { return Err("a pesquisa ampliada não está instalada".into()); }
    let args = reach_doctor_args();
    // trava: o Starfork só roda o doctor — nunca install/configure/setup (cookies, dependências do sistema)
    if args.first().is_some_and(|a| REACH_NEVER.contains(&a.as_str())) { return Err("comando do agent-reach não permitido".into()); }
    let mut cmd = Command::new(reach_bin(dir));
    cmd.args(args).env("PATH", path_with(&venv_bin_dir(dir))).stdin(Stdio::null());
    let out = super::output_timeout(cmd, 90)?;
    reach_parse_doctor(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command(async)]
pub fn reach_status() -> Result<serde_json::Value, String> {
    let mut v = reach_status_of(&reach_dir());
    v["installer"] = serde_json::json!(match find_installer() { Some(Installer::Uv(_)) => "uv", Some(Installer::Python(_)) => "python", None => "" });
    Ok(v)
}
#[tauri::command(async)]
pub fn reach_install(app: AppHandle) -> Result<serde_json::Value, String> {
    let inst = find_installer().ok_or("Pra instalar precisa do uv (recomendado: curl -LsSf https://astral.sh/uv/install.sh | sh) ou de um Python 3.10+.")?;
    reach_install_in(Some(&app), &reach_dir(), &inst)
}
#[tauri::command(async)]
pub fn reach_doctor() -> Result<Vec<serde_json::Value>, String> { reach_doctor_in(&reach_dir()) }
/// Remove a pesquisa ampliada (só a pasta do Starfork — nunca a config do agent-reach em ~/.agent-reach).
#[tauri::command(async)]
pub fn reach_remove() -> Result<(), String> {
    let d = reach_dir();
    if !d.ends_with(Path::new("tools").join("agent-reach")) && std::env::var("CARDUME_REACH_DIR").is_err() { return Err("pasta inesperada".into()); }
    match std::fs::remove_dir_all(&d) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.to_string()) }
}

/// Uma fonte coletada pela pesquisa ampliada.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Src { pub canal: &'static str, pub titulo: String, pub url: String, pub nota: String }

/// Palavras de busca: a 1ª linha "IDEIA: …" do prompt (o front sempre manda), cortada. PURA.
pub(crate) fn query_of(prompt: &str) -> String {
    let line = prompt.lines().find_map(|l| l.trim().strip_prefix("IDEIA:")).unwrap_or(prompt).trim();
    line.split_whitespace().take(8).collect::<Vec<_>>().join(" ")
}
pub(crate) fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
/// Hacker News (busca pública do Algolia). PURA.
pub(crate) fn hn_parse(raw: &str) -> Vec<Src> {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    v["hits"].as_array().map(|a| a.iter().filter_map(|h| {
        let t = h["title"].as_str().or_else(|| h["story_title"].as_str())?.trim().to_string();
        let id = h["objectID"].as_str()?;
        Some(Src { canal: "Hacker News", titulo: t, url: format!("https://news.ycombinator.com/item?id={id}"),
            nota: format!("{} pontos, {} comentários{}", h["points"].as_i64().unwrap_or(0), h["num_comments"].as_i64().unwrap_or(0),
                h["created_at"].as_str().map(|d| format!(", {}", &d[..d.len().min(10)])).unwrap_or_default()) })
    }).take(6).collect()).unwrap_or_default()
}
/// GitHub (busca pública de repositórios). PURA.
pub(crate) fn gh_parse(raw: &str) -> Vec<Src> {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    v["items"].as_array().map(|a| a.iter().filter_map(|r| {
        let url = r["html_url"].as_str()?.to_string();
        Some(Src { canal: "GitHub", titulo: r["full_name"].as_str().unwrap_or("").to_string(), url,
            nota: format!("{} estrelas, último push {}{}", r["stargazers_count"].as_i64().unwrap_or(0), r["pushed_at"].as_str().map(|d| &d[..d.len().min(10)]).unwrap_or("?"),
                r["description"].as_str().map(|d| format!(" — {}", d.chars().take(140).collect::<String>())).unwrap_or_default()) })
    }).take(6).collect()).unwrap_or_default()
}
/// YouTube (busca do yt-dlp do venv: "título\turl\tvisualizações"). PURA.
pub(crate) fn yt_parse(raw: &str) -> Vec<Src> {
    raw.lines().filter_map(|l| {
        let mut p = l.split('\t');
        let (t, u) = (p.next()?.trim(), p.next()?.trim());
        if !u.starts_with("http") || t.is_empty() { return None; }
        let views = p.next().map(str::trim).filter(|v| !v.is_empty() && *v != "NA").map(|v| format!("{v} visualizações")).unwrap_or_default();
        Some(Src { canal: "YouTube", titulo: t.to_string(), url: u.to_string(), nota: views })
    }).take(5).collect()
}
fn curl_get(url: &str, k: &Keyed) -> Option<String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sL", "--max-time", "20", "-A", "Starfork-pesquisa", url]);
    run_quiet(cmd, 25, k)
}
fn run_quiet(cmd: Command, secs: u64, k: &Keyed) -> Option<String> {
    let (on_start, on_end, stopped, cancelled) = (|p: i32| k.on_start(p), |p: i32| k.on_end(p), |_p: i32| k.stopped(), || k.cancelled());
    let h = ai_once::ChatHooks { activity: &|_| {}, on_start: &on_start, on_end: &on_end, stopped: &stopped, cancelled: &cancelled, stop_marker: mesa::STOPPED };
    ai_once::run_proc(cmd, None, secs, &h, &mut |_| {}).ok().filter(|o| o.status.success()).map(|o| o.stdout)
}
/// Coleta as fontes públicas (só canais sem login): HN, GitHub e YouTube. Parável entre um canal e outro.
fn reach_collect(q: &str, dir: &Path, say: &dyn Fn(&str), k: &Keyed) -> Vec<Src> {
    let mut out = vec![];
    if q.trim().is_empty() { return out; }
    say(&format!("buscando no Hacker News: {q}"));
    if let Some(r) = curl_get(&format!("https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=6&query={}", urlenc(q)), k) { out.extend(hn_parse(&r)); }
    if k.cancelled() { return out; }
    say(&format!("buscando no GitHub: {q}"));
    if let Some(r) = curl_get(&format!("https://api.github.com/search/repositories?sort=stars&per_page=6&q={}", urlenc(q)), k) { out.extend(gh_parse(&r)); }
    if k.cancelled() { return out; }
    say(&format!("buscando no YouTube: {q}"));
    let mut yt = Command::new(venv_bin_dir(dir).join(exe("yt-dlp")));
    // argumentos FIXOS: sem config do usuário e sem cookie nenhum (nem de arquivo, nem do navegador)
    yt.args(["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--flat-playlist", "--skip-download", "--no-warnings", "--print", "%(title)s\t%(url)s\t%(view_count)s", &format!("ytsearch5:{q}")]);
    if let Some(r) = run_quiet(yt, 60, k) { out.extend(yt_parse(&r)); }
    out
}
/// O material coletado, em texto pro prompt do gateway. PURA.
pub(crate) const REACH_MARK: &str = "MATERIAL COLETADO PELA PESQUISA AMPLIADA";
pub(crate) fn reach_material(srcs: &[Src]) -> String {
    let mut s = String::from("\n\nMATERIAL COLETADO PELA PESQUISA AMPLIADA (fontes públicas, lidas agora). Use SÓ estas fontes como fato; cite a URL de cada uma; o que não estiver aqui é inferência ou suposição:\n");
    for x in srcs { s.push_str(&format!("- [{}] {} — {}{}\n", x.canal, x.titulo, x.url, if x.nota.is_empty() { String::new() } else { format!(" ({})", x.nota) })); }
    s
}

// ---------------------------------------------------------------------------
// o documento da pesquisa no projeto criado
// ---------------------------------------------------------------------------

/// Caminho aceito: `docs/<nome>.md`, nome só com a-z0-9-. PURA.
pub(crate) fn ok_doc_rel(rel: &str) -> bool {
    rel.strip_prefix("docs/").and_then(|n| n.strip_suffix(".md")).is_some_and(|n| !n.is_empty() && n.len() <= 80 && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
}
pub(crate) fn commit_doc_in(repo: &Path, rel: &str, content: &str, msg: &str) -> Result<(), String> {
    if !ok_doc_rel(rel) { return Err("caminho de documento inválido".into()); }
    if !repo.join(".git").exists() { return Err("o projeto não tem git".into()); }
    let f = repo.join(rel);
    std::fs::create_dir_all(f.parent().unwrap_or(repo)).map_err(|e| e.to_string())?;
    std::fs::write(&f, content).map_err(|e| e.to_string())?;
    let git = |args: &[&str]| Command::new("git").arg("-C").arg(repo).args(args).output().map_err(|e| format!("git: {e}"));
    let o = git(&["add", "--", rel])?;
    if !o.status.success() { return Err(format!("git add: {}", String::from_utf8_lossy(&o.stderr).trim())); }
    // nada mudou (já commitado igual): ok
    if git(&["diff", "--cached", "--quiet", "--", rel])?.status.success() { return Ok(()); }
    let o = git(&["commit", "-q", "-m", msg, "--", rel])?;
    if !o.status.success() { return Err(format!("git commit: {}", String::from_utf8_lossy(&o.stderr).trim())); }
    Ok(())
}
#[tauri::command(async)]
pub fn ideia_commit_doc(repo: String, rel: String, content: String, message: Option<String>) -> Result<(), String> {
    let msg = message.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| format!("docs: {rel} (começar por uma ideia)"));
    commit_doc_in(Path::new(&repo), &rel, &content, &msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("starfork-ideia-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn arquivo_da_ideia_travado_na_pasta() {
        let d = tmp("io");
        for bad in ["", "../x", "a/b", "x.json", "i-1-r"] { assert!(ideia_path(&d, bad).is_err(), "{bad}"); }
        save_in(&d, "i-1", &serde_json::json!({"titulo":"skincare","updatedAt":1,"turns":[1,2],"report":{"status":"ok"},"costUsd":0.0,"tokUsd":0.42})).unwrap();
        save_in(&d, "i-2", &serde_json::json!({"titulo":"pou","updatedAt":5,"turns":[],"project":{"dir":"/x"}})).unwrap();
        std::fs::write(d.join("i-3.json"), "{ quebrado").unwrap();
        let l = list_in(&d);
        assert_eq!(l.len(), 3);
        assert_eq!(l[0]["id"], "i-2");
        assert_eq!(l[0]["projeto"], "/x");
        assert_eq!(l[1]["turnos"], 2);
        assert_eq!(l[1]["pesquisa"], "ok");
        assert_eq!(l[1]["tokUsd"].as_f64(), Some(0.42), "gasto por tokens (Codex/DeepSeek/gateway) vai pra lista da Fábrica");
        assert_eq!(l[2]["corrompida"], true);
        assert!(read_in(&d, "nao-tem").unwrap().is_null());
        assert!(read_in(&d, "i-3").is_err());
        delete_in(&d, "i-1").unwrap();
        delete_in(&d, "i-1").unwrap();
        assert_eq!(list_in(&d).len(), 2);
        assert!(d.read_dir().unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn persona_sem_ferramentas() {
        let a = persona_args("SYS", &Some("claude-sonnet-5".into()));
        let i = a.iter().position(|x| x == "--tools").unwrap();
        assert_eq!(a[i + 1], "", "nenhuma ferramenta");
        assert!(a.windows(2).any(|w| w[0] == "--model" && w[1] == "claude-sonnet-5"));
        assert!(!a.iter().any(|x| x.contains("WebSearch") || x == "--allowedTools"));
    }

    #[test]
    fn caminho_da_pesquisa_por_motor() {
        use ai_once::AiEngine::*;
        assert_eq!(research_mode(Claude, false), "native");
        assert_eq!(research_mode(Codex, false), "native");
        assert_eq!(research_mode(Deepseek, false), "native");
        assert_eq!(research_mode(Gateway, false), "none");
        assert_eq!(research_mode(Gateway, true), "reach");
        assert!(research_tools(Codex, "native").contains("Codex"));
        assert!(research_tools(Gateway, "reach").contains("Agent Reach"));
        assert_eq!(research_tools(Gateway, "none"), "");
        // Codex: a busca entra SÓ na pesquisa, antes do "-" (STDIN), e só-leitura continua
        let r = ai_once::codex_research_args(None, Some("gpt-5"));
        assert_eq!(r.last().map(String::as_str), Some("-"));
        assert!(r.windows(2).any(|w| w[0] == "-c" && w[1] == "web_search=\"live\""));
        assert!(r.iter().any(|x| x == "sandbox_mode=\"read-only\""));
        assert!(!ai_once::codex_chat_args(None, None).iter().any(|x| x.contains("web_search")));
    }

    #[test]
    fn args_da_pesquisa_no_claude() {
        let a = research_args("SYS", &None, Some(0.6), None, false);
        let at = |k: &str| a.iter().position(|x| x == k).map(|i| a[i + 1].clone());
        assert_eq!(at("--tools").as_deref(), Some("WebSearch,WebFetch"));
        assert_eq!(at("--allowedTools").as_deref(), Some("WebSearch,WebFetch"));
        assert_eq!(at("--max-budget-usd").as_deref(), Some("0.60"));
        assert_eq!(at("--output-format").as_deref(), Some("stream-json"));
        assert!(!a.iter().any(|x| x == "bypassPermissions"), "nunca pula as permissões");
        assert!(!a.iter().any(|x| x.contains("Bash")), "nada de Bash na pesquisa (injeção vinda de página lida)");
        // correção: sessão retomada, sem ferramentas, sem teto repetido
        let f = research_args("SYS", &None, None, Some("abc"), true);
        assert_eq!(f[f.iter().position(|x| x == "--tools").unwrap() + 1], "");
        assert!(f.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
    }

    #[test]
    fn stream_da_pesquisa_vira_eventos() {
        let t = stream_events(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch","input":{"url":"https://exemplo.com/a","prompt":"x"}},{"type":"tool_use","name":"WebSearch","input":{"query":"skincare app"}},{"type":"text","text":"oi"}]}}"#);
        assert_eq!(t, vec![StreamEv::Tool("consultando https://exemplo.com/a".into(), Some("https://exemplo.com/a".into())), StreamEv::Tool("consultando skincare app".into(), None)]);
        let r = stream_events(r#"{"type":"result","subtype":"success","result":"{}","session_id":"s1","total_cost_usd":0.2}"#);
        assert!(matches!(&r[0], StreamEv::Result(t, s, false, _) if t == "{}" && s == "s1"));
        let e = stream_events(r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"session_id":"s2"}"#);
        let StreamEv::Result(_, _, true, v) = &e[0] else { panic!("erro") };
        assert!(claude_result_error(v, Some(0.5)).contains("teto de US$ 0.50"));
        assert!(stream_events("lixo").is_empty());
        // DeepSeek: web_search com "_" também vira "consultando"
        assert_eq!(tool_line("web_search", &serde_json::json!({"query":"q"})), "consultando q");
    }

    #[cfg(unix)]
    #[test]
    fn plano_de_instalacao_fixo_e_isolado() {
        let d = Path::new("/h/.constellation/tools/agent-reach");
        let uv = reach_install_plan(&Installer::Uv("/u/uv".into()), d);
        assert_eq!(uv[0], ["/u/uv", "venv", "/h/.constellation/tools/agent-reach/venv", "--python", "3.12", "--quiet"]);
        assert_eq!(uv[1][..6], ["/u/uv", "pip", "install", "--quiet", "--python", "/h/.constellation/tools/agent-reach/venv/bin/python"]);
        let py = reach_install_plan(&Installer::Python("/usr/bin/python3.12".into()), d);
        assert_eq!(py[0], ["/usr/bin/python3.12", "-m", "venv", "/h/.constellation/tools/agent-reach/venv"]);
        for step in uv.iter().chain(py.iter()) {
            let last = step.last().unwrap();
            if step.contains(&"install".to_string()) { assert_eq!(last, &format!("agent-reach @ git+https://github.com/Panniantong/Agent-Reach@{REACH_COMMIT}"), "versão FIXA, por commit"); }
            // nada de install.md remoto, curl|sh, nem rodar o próprio agent-reach (install/configure)
            assert!(!step.iter().any(|x| x.contains("install.md") || x.contains("raw.githubusercontent") || x.ends_with("agent-reach")));
        }
        assert_eq!(REACH_COMMIT.len(), 40);
        assert_eq!(reach_doctor_args(), ["doctor", "--json"]);
        for never in REACH_NEVER { assert!(!reach_doctor_args().contains(&never.to_string())); }
    }

    #[test]
    fn canais_de_cookie_nunca_ficam_ativos() {
        let raw = r#"{"web":{"status":"ok"},"youtube":{"status":"ok"},"twitter":{"status":"ok"},"reddit":{"status":"warn"},"instagram":{"status":"ok"},"bilibili":{"status":"ok"},"exa_search":{"status":"off"},"linkedin":{"status":"ok"},"xueqiu":{"status":"ok"}}"#;
        let c = reach_parse_doctor(raw).unwrap();
        let uso = |id: &str| c.iter().find(|x| x["id"] == id).unwrap()["uso"].as_str().unwrap().to_string();
        assert_eq!(uso("web"), "ativo");
        assert_eq!(uso("youtube"), "ativo");
        for id in ["twitter", "reddit", "instagram", "linkedin", "xueqiu"] { assert_eq!(uso(id), "bloqueado", "{id}"); }
        assert_eq!(uso("bilibili"), "fora");
        assert_eq!(uso("exa_search"), "indisponivel");
        assert_eq!(c[0]["uso"], "ativo", "ativos primeiro");
        assert!(reach_parse_doctor("não é json").is_err());
        for id in REACH_COOKIE { assert!(!REACH_PUBLIC.contains(&id)); }
    }

    /// uv FALSO: o venv nasce com um agent-reach falso; o doctor falso devolve canais (cookie incluído) — instalado,
    /// versão gravada e o doctor nunca recebe configure/install.
    #[cfg(unix)]
    #[test]
    fn instala_com_uv_falso_e_roda_o_doctor_falso() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("reach");
        let log = d.join("calls.log");
        let fake_reach = format!("#!/bin/sh\necho \"agent-reach $@\" >> {log}\ncase \"$1\" in doctor) echo '{{\"web\":{{\"status\":\"ok\"}},\"twitter\":{{\"status\":\"ok\"}}}}';; *) exit 9;; esac\n", log = log.display());
        let uv = d.join("uv");
        std::fs::write(&uv, format!("#!/bin/sh\necho \"uv $@\" >> {log}\nif [ \"$1\" = venv ]; then mkdir -p \"$2/bin\"; cat > \"$2/bin/agent-reach\" <<'EOF'\n{fake}EOF\nchmod +x \"$2/bin/agent-reach\"; fi\nexit 0\n", log = log.display(), fake = fake_reach)).unwrap();
        std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tools = d.join("tools").join("agent-reach");
        assert!(!reach_installed(&tools));
        let st = reach_install_in(None, &tools, &Installer::Uv(uv.display().to_string())).unwrap();
        assert_eq!(st["installed"], true);
        assert_eq!(reach_meta(&tools)["version"], REACH_VERSION);
        let ch = reach_doctor_in(&tools).unwrap();
        assert_eq!(ch.iter().find(|c| c["id"] == "twitter").unwrap()["uso"], "bloqueado");
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("uv venv") && calls.contains("uv pip install") && calls.contains(REACH_COMMIT), "{calls}");
        assert!(calls.contains("agent-reach doctor --json"));
        for never in REACH_NEVER { assert!(!calls.contains(&format!("agent-reach {never}")), "{never}: {calls}"); }
        // pip falso que falha: erro humano com o comando
        let bad = d.join("python-ruim");
        std::fs::write(&bad, "#!/bin/sh\necho 'pip quebrou' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = reach_install_in(None, &d.join("outra"), &Installer::Python(bad.display().to_string())).unwrap_err();
        assert!(e.contains("falhou") && e.contains("pip quebrou"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn coleta_publica_e_material() {
        let hn = hn_parse(r#"{"hits":[{"title":"Show HN: skincare tracker","objectID":"42","points":120,"num_comments":33,"created_at":"2026-05-01T10:00:00Z"},{"objectID":"9"}]}"#);
        assert_eq!(hn.len(), 1);
        assert_eq!(hn[0].url, "https://news.ycombinator.com/item?id=42");
        assert!(hn[0].nota.contains("120 pontos") && hn[0].nota.contains("2026-05-01"));
        let gh = gh_parse(r#"{"items":[{"full_name":"a/skin","html_url":"https://github.com/a/skin","stargazers_count":900,"pushed_at":"2026-09-01T00:00:00Z","description":"routine app"}]}"#);
        assert_eq!(gh[0].url, "https://github.com/a/skin");
        assert!(gh[0].nota.contains("900 estrelas"));
        let yt = yt_parse("Minha rotina\thttps://www.youtube.com/watch?v=x\t12000\nlixo sem url\n");
        assert_eq!(yt.len(), 1);
        assert!(yt[0].nota.contains("12000"));
        let m = reach_material(&[hn[0].clone(), gh[0].clone()]);
        assert!(m.contains("https://news.ycombinator.com/item?id=42") && m.contains("Use SÓ estas fontes"));
        assert_eq!(query_of("IDEIA: app de rotina de skincare com lembretes\n\nresto"), "app de rotina de skincare com lembretes");
        assert!(m.contains(REACH_MARK));
        assert_eq!(url_in("consultando https://exemplo.com/a?b=1 agora").as_deref(), Some("https://exemplo.com/a?b=1"));
        assert_eq!(url_in("consultando skincare app"), None);
        assert_eq!(urlenc("skin care+ç"), "skin%20care%2B%C3%A7");
    }

    /// PESQUISA REAL com o Claude (manual, gasta dinheiro): `CARDUME_IDEIA_REAL=<pasta> cargo test --lib -- --ignored
    /// pesquisa_real_claude`. Lê `<pasta>/sys.txt` e `<pasta>/prompt.txt` (gerados pelo trecho puro da aba) e grava a
    /// resposta, a sessão, o custo e as linhas de progresso em `<pasta>/resposta.json`. Teto: US$ 0,60.
    #[test]
    #[ignore]
    fn pesquisa_real_claude() {
        let Ok(dir) = std::env::var("CARDUME_IDEIA_REAL") else { return };
        let dir = PathBuf::from(dir);
        let sys = std::fs::read_to_string(dir.join("sys.txt")).unwrap();
        let prompt = std::fs::read_to_string(dir.join("prompt.txt")).unwrap();
        let fix = std::fs::read_to_string(dir.join("fix.txt")).ok();
        let lines = std::sync::Mutex::new(Vec::<serde_json::Value>::new());
        let emit = |l: &str, u: Option<&str>| { eprintln!("· {l}"); lines.lock().unwrap().push(serde_json::json!({ "line": l, "url": u })); };
        let model = Some("claude-sonnet-5".to_string());
        let sid = std::fs::read_to_string(dir.join("session.txt")).ok();
        let t0 = Instant::now();
        let r = match (&fix, &sid) {
            (Some(f), Some(s)) => research_claude(&emit, "real-ideia-r", &sys, f, &model, None, Some(s.trim()), true),
            _ => research_claude(&emit, "real-ideia-r", &sys, &prompt, &model, Some(0.60), None, false),
        }.unwrap();
        let out = serde_json::json!({ "res": r, "acts": *lines.lock().unwrap(), "secs": t0.elapsed().as_secs() });
        std::fs::write(dir.join(if fix.is_some() { "resposta-fix.json" } else { "resposta.json" }), serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }

    #[test]
    fn documento_so_em_docs_e_commitado() {
        assert!(ok_doc_rel("docs/pesquisa-skincare.md"));
        for bad in ["docs/../x.md", "README.md", "docs/a b.md", "docs/x.txt", "docs/.md", "docs/sub/x.md"] { assert!(!ok_doc_rel(bad), "{bad}"); }
        let d = tmp("doc");
        let g = |a: &[&str]| assert!(Command::new("git").arg("-C").arg(&d).args(a).output().unwrap().status.success(), "{a:?}");
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        std::fs::write(d.join("README.md"), "x").unwrap();
        g(&["add", "-A"]);
        g(&["commit", "-qm", "init"]);
        std::fs::write(d.join("solto.txt"), "não entra").unwrap();
        commit_doc_in(&d, "docs/pesquisa-x.md", "# Pesquisa", "docs: pesquisa").unwrap();
        commit_doc_in(&d, "docs/pesquisa-x.md", "# Pesquisa", "docs: pesquisa").unwrap(); // igual: ok, sem commit vazio
        let log = Command::new("git").arg("-C").arg(&d).args(["log", "--name-only", "--format=%s"]).output().unwrap();
        let log = String::from_utf8_lossy(&log.stdout);
        assert_eq!(log.matches("docs: pesquisa").count(), 1);
        assert!(log.contains("docs/pesquisa-x.md") && !log.contains("solto.txt"));
        assert!(commit_doc_in(&d, "../fora.md", "x", "m").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
