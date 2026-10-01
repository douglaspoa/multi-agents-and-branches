//! IA AUXILIAR "de uma vez" (spec com IA, título, nome de branch, previsão, relatórios, corpo de PR,
//! resumo de commit, "por que este arquivo", desdobrar épico, conector do tracker): ponto ÚNICO que segue
//! a IA padrão do usuário — `aiEngine`/`aiModel` em ~/.constellation/settings.json (o app espelha ali).
//!
//! - claude  → `claude -p <prompt> [--model <id>] [extras]` — EXATAMENTE os argumentos de antes (sem ANTHROPIC_API_KEY);
//! - codex   → `codex exec --json --skip-git-repo-check -c sandbox_mode="read-only" -c approval_policy="never"
//!             [-c model_reasoning_effort="low"] [-m <modelo>] -` com o prompt no STDIN e só a OPENAI_API_KEY
//!             do llm.env no env; resposta = texto do ÚLTIMO item `agent_message`;
//! - gateway → HTTP `chat/completions` OpenAI-compatível (curl; cabeçalhos e corpo em arquivos 0600, a chave
//!             nunca vai no argv), modelo `aiModel` (se for do gateway) ou `ALT_AI_MODEL`.
//!
//! Motor escolhido indisponível → o primeiro disponível na ordem claude, codex, gateway; nenhum → erro
//! humano dizendo o que instalar/configurar. Os chats de várias rodadas NÃO passam por aqui.
//! Golden compartilhado com o motor TS (src/ai-once.ts): tests/fixtures/ai-once-golden/.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum AiEngine {
    Claude,
    Codex,
    Gateway,
}
impl AiEngine {
    pub(crate) fn label(self) -> &'static str {
        match self {
            AiEngine::Claude => "Claude Code",
            AiEngine::Codex => "Codex",
            AiEngine::Gateway => "Gateway",
        }
    }
    pub(crate) fn parse(s: &str) -> Option<AiEngine> {
        let n = s.trim().to_ascii_lowercase();
        if n.starts_with("codex") { Some(AiEngine::Codex) }
        else if n.starts_with("gateway") || n.starts_with("logcomex") { Some(AiEngine::Gateway) }
        else if n.starts_with("claude") { Some(AiEngine::Claude) }
        else { None }
    }
}
const ORDER: [AiEngine; 3] = [AiEngine::Claude, AiEngine::Codex, AiEngine::Gateway];

/// Nível da chamada: `Rapido` (antes Haiku) e `Capaz` (antes Sonnet / padrão da assinatura).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Tier {
    Rapido,
    Capaz,
}

/// Quais motores esta máquina consegue usar agora.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Avail {
    pub claude: bool,
    pub codex: bool,
    pub gateway: bool,
}
impl Avail {
    fn has(&self, e: AiEngine) -> bool {
        match e { AiEngine::Claude => self.claude, AiEngine::Codex => self.codex, AiEngine::Gateway => self.gateway }
    }
}

pub(crate) const NO_ENGINE_MSG: &str = "Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), ou configure um gateway em Configurações → Gateway próprio.";
pub(crate) const CODEX_TIMEOUT_MSG: &str = "O Codex não respondeu a tempo — tente de novo.";
pub(crate) const CODEX_MISSING_MSG: &str = "O Codex não está instalado neste computador — npm install -g @openai/codex (veja Mais › Ambiente).";
pub(crate) const GATEWAY_CUT_MSG: &str = "a resposta do gateway foi cortada (limite de tokens) — peça algo menor ou aumente o limite no gateway.";

/// A regra ÚNICA (resolve_engine e o Ambiente): preferido se disponível; senão o primeiro disponível na
/// ordem claude, codex, gateway. Preguiçosa: só consulta os outros quando o preferido falta.
pub(crate) fn pick_with(pref: &str, has: impl Fn(AiEngine) -> bool) -> Option<AiEngine> {
    if let Some(p) = AiEngine::parse(pref) {
        if has(p) { return Some(p); }
    }
    ORDER.into_iter().find(|e| has(*e))
}
pub(crate) fn pick_engine(pref: &str, av: &Avail) -> Option<AiEngine> {
    pick_with(pref, |e| av.has(e))
}

/// IA padrão do usuário (espelhada pelo app em settings.json). Sem valor → claude (comportamento de antes).
pub(crate) fn pref_engine() -> String {
    setting_get("aiEngine").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "claude".into())
}
/// Id de modelo seguro (mesma regra do push_model).
pub(crate) fn safe_model(m: &str) -> Option<String> {
    let m = m.trim();
    (!m.is_empty() && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]".contains(c))).then(|| m.to_string())
}
/// `aiModel` só vale pro motor que o usuário escolheu (com fallback ele é de OUTRO motor) — e nunca no Claude,
/// cujas chamadas mantêm os modelos de antes.
pub(crate) fn user_model_for(pref: &str, eng: AiEngine, ai_model: Option<&str>) -> Option<String> {
    if eng == AiEngine::Claude || AiEngine::parse(pref) != Some(eng) { return None; }
    ai_model.and_then(safe_model)
}

/// O binário existe? Caminho → é arquivo; nome solto → procura no PATH.
pub(crate) fn bin_exists(bin: &str) -> bool {
    let p = Path::new(bin);
    if p.components().count() > 1 || p.is_absolute() {
        return p.is_file();
    }
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|d| {
        d.join(bin).is_file() || (cfg!(windows) && (d.join(format!("{bin}.exe")).is_file() || d.join(format!("{bin}.cmd")).is_file()))
    })
}

/// Acha o `codex` como acha o node/claude (app aberto pelo menu NÃO herda o PATH do shell):
/// CARDUME_CODEX (se existir) → ao lado do node configurado/escolhido → pastas dos gerenciadores de node
/// (nvm/fnm/volta/asdf/mise instalam o codex junto) → homebrew → /usr/local/bin → PATH.
pub(crate) fn codex_bin() -> String {
    if let Ok(c) = std::env::var("CARDUME_CODEX") {
        if !c.is_empty() && Path::new(&c).is_file() { return c; }
    }
    let names: &[&str] = if cfg!(windows) { &["codex.exe", "codex.cmd"] } else { &["codex"] };
    let beside = |node: &str| -> Option<String> {
        let dir = Path::new(node).parent()?;
        names.iter().map(|n| dir.join(n)).find(|c| c.is_file()).map(|c| c.display().to_string())
    };
    if let Ok(node) = std::env::var("CARDUME_NODE") {
        if let Some(c) = beside(&node) { return c; }
    }
    // ao lado do node que o app RESOLVEU (com nvm, `npm i -g @openai/codex` instala ali)
    if let Some(c) = beside(&node_bin()) { return c; }
    let mut cands = node_candidates();
    cands.sort();
    for n in cands.iter().rev() {
        if let Some(c) = beside(n) { return c; }
    }
    for p in ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] {
        if Path::new(p).is_file() { return p.to_string(); }
    }
    "codex".to_string()
}

/// Configuração do gateway OpenAI-compatível (mesmas chaves/padrões do route_ai_ping e do altProxy.ts).
#[derive(Clone, Debug)]
pub(crate) struct Gateway {
    pub base: String,
    pub key: String,
    pub model: String,
}
pub(crate) fn gateway_cfg_from(get: impl Fn(&str) -> Option<String>) -> Option<Gateway> {
    let nz = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let key = nz("ALT_AI_KEY").or_else(|| nz("LGCX_API_KEY"))?;
    let base = nz("ALT_AI_BASE_URL").unwrap_or_else(|| "https://llm.logcomex.ai/v1".into()).trim_end_matches('/').to_string();
    let model = nz("ALT_AI_MODEL")
        .or_else(|| nz("ALT_AI_MODELS").and_then(|m| m.split(',').map(str::trim).find(|s| !s.is_empty()).map(String::from)))
        .or_else(|| if base.contains("logcomex") { Some("logcomex-v2".into()) } else { None })?;
    Some(Gateway { base, key, model })
}
pub(crate) fn gateway_cfg() -> Option<Gateway> { gateway_cfg_from(llm_env_get) }

fn engine_avail_uncached(e: AiEngine) -> bool {
    match e {
        AiEngine::Claude => bin_exists(&claude_bin()),
        AiEngine::Codex => bin_exists(&codex_bin()),
        AiEngine::Gateway => gateway_cfg().is_some(),
    }
}
static AVAIL_CACHE: Mutex<Option<HashMap<AiEngine, (bool, Instant)>>> = Mutex::new(None);
/// Disponibilidade de UM motor com cache de 30s (as sondagens do node/codex não rodam a cada chamada).
pub(crate) fn engine_avail(e: AiEngine) -> bool {
    if let Some((v, at)) = AVAIL_CACHE.lock().unwrap_or_else(|x| x.into_inner()).as_ref().and_then(|m| m.get(&e).copied()) {
        if at.elapsed() < Duration::from_secs(30) { return v; }
    }
    let v = engine_avail_uncached(e);
    AVAIL_CACHE.lock().unwrap_or_else(|x| x.into_inner()).get_or_insert_with(HashMap::new).insert(e, (v, Instant::now()));
    v
}
#[cfg(test)]
pub(crate) fn clear_avail_cache() { *AVAIL_CACHE.lock().unwrap_or_else(|x| x.into_inner()) = None; }

pub(crate) fn availability() -> Avail {
    Avail { claude: engine_avail(AiEngine::Claude), codex: engine_avail(AiEngine::Codex), gateway: engine_avail(AiEngine::Gateway) }
}

/// Motor que as chamadas auxiliares vão usar agora (preferência + disponibilidade + fallback) — o
/// ai_once faz a mesma conta inline (precisa da preferência pra escolher o aiModel).
#[cfg(test)]
pub(crate) fn resolve_engine() -> Result<AiEngine, String> {
    pick_with(&pref_engine(), engine_avail).ok_or_else(|| NO_ENGINE_MSG.to_string())
}

/// Codex pronto pra uso (só o Ambiente consulta): `codex login status` ok OU OPENAI_API_KEY no cofre.
pub(crate) fn codex_logged_in(bin: &str) -> bool {
    if llm_env_get("OPENAI_API_KEY").is_some_and(|k| !k.trim().is_empty()) { return true; }
    let mut c = Command::new(bin);
    c.args(["login", "status"]);
    output_timeout(c, 8).map(|o| o.status.success()).unwrap_or(false)
}

/// Uma chamada auxiliar. `claude_model` = o `--model` que a chamada usava antes (None = sem flag);
/// `claude_extra` = argumentos a mais do claude (ex.: o tracker liberando a tool Read).
pub(crate) struct AiOnce<'a> {
    pub prompt: &'a str,
    pub tier: Tier,
    pub claude_model: Option<&'a str>,
    pub claude_extra: &'a [String],
    pub cwd: Option<&'a Path>,
    pub secs: u64,
}

/// Argumentos do claude — idênticos aos de antes da IA auxiliar plural.
pub(crate) fn claude_args(prompt: &str, model: Option<&str>, extra: &[String]) -> Vec<String> {
    let mut a = vec!["-p".to_string(), prompt.to_string()];
    if let Some(m) = model { a.push("--model".into()); a.push(m.into()); }
    a.extend(extra.iter().cloned());
    a
}

// ---------- Codex ----------

/// Modelos que o Codex desta conta RECUSOU (ex.: gpt-5-codex com login ChatGPT): as próximas chamadas
/// do processo já vão sem `-m` em vez de repetir a falha.
static CODEX_REFUSED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
fn codex_is_refused(m: &str) -> bool {
    CODEX_REFUSED.lock().unwrap_or_else(|x| x.into_inner()).as_ref().is_some_and(|s| s.contains(m))
}
fn codex_remember_refused(m: &str) {
    CODEX_REFUSED.lock().unwrap_or_else(|x| x.into_inner()).get_or_insert_with(Default::default).insert(m.to_string());
}

/// Plano do Codex: (modelo, esforço baixo?). `aiModel` do usuário vale nos dois níveis; sem ele, capaz →
/// gpt-5-codex e rápido → padrão do Codex. Rápido sempre com raciocínio "low". Modelo já recusado → sem -m.
pub(crate) fn codex_plan(tier: Tier, user_model: Option<&str>) -> (Option<String>, bool) {
    let m = user_model.map(String::from).or_else(|| (tier == Tier::Capaz).then(|| "gpt-5-codex".to_string()));
    (m.filter(|m| !codex_is_refused(m)), tier == Tier::Rapido)
}

/// Argumentos do Codex auxiliar: SEMPRE só-leitura, sem aprovação, prompt pelo STDIN (`-`).
pub(crate) fn codex_args(model: Option<&str>, low_effort: bool) -> Vec<String> {
    let mut a: Vec<String> = ["exec", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\""]
        .iter().map(|s| s.to_string()).collect();
    if low_effort { a.push("-c".into()); a.push("model_reasoning_effort=\"low\"".into()); }
    if let Some(m) = model { a.push("-m".into()); a.push(m.into()); }
    a.push("-".into());
    a
}

/// A API manda o erro como JSON dentro da string (`{"error":{"message":"..."}}`) — tira o texto.
fn unwrap_json_msg(m: &str) -> String {
    let m = m.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(m) {
        if let Some(s) = v["error"]["message"].as_str().or_else(|| v["message"].as_str()).or_else(|| v["detail"].as_str()) {
            return s.trim().to_string();
        }
    }
    m.to_string()
}

/// JSONL do `codex exec --json` → (texto do ÚLTIMO agent_message, erro CRU do turno). Itens `error` no meio
/// (avisos, ex.: "Skill descriptions were shortened") só contam se não houver erro de turno nem resposta.
pub(crate) fn codex_outcome(stdout: &str) -> (Option<String>, Option<String>) {
    let (mut last, mut fatal, mut warn) = (None, None, None);
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        let t = v["type"].as_str().unwrap_or("");
        let item = &v["item"];
        let it = item["type"].as_str().unwrap_or("");
        if it == "agent_message" {
            if let Some(s) = item["text"].as_str() { if !s.trim().is_empty() { last = Some(s.trim().to_string()); } }
        } else if t == "turn.failed" || t == "error" {
            let m = unwrap_json_msg(v["error"]["message"].as_str().or_else(|| v["message"].as_str()).or_else(|| v["error"].as_str()).unwrap_or(""));
            if !m.is_empty() { fatal = Some(m); }
        } else if it == "error" {
            if let Some(m) = item["message"].as_str() { warn = Some(m.trim().to_string()); }
        }
    }
    (last, fatal.or(warn))
}
/// Mesma leitura, já com o erro em mensagem humana (golden compartilhado com o TS).
#[cfg(test)]
pub(crate) fn parse_codex_jsonl(stdout: &str) -> Result<String, String> {
    match codex_outcome(stdout) {
        (Some(s), _) => Ok(s),
        (None, Some(raw)) => Err(codex_friendly_error(&raw)),
        (None, None) => Err("O Codex terminou sem resposta — tente de novo.".into()),
    }
}

/// O Codex recusou o MODELO pra esta conta (mensagem CRUA do provedor) — vale tentar o padrão do Codex.
pub(crate) fn codex_model_refused(raw: &str) -> bool {
    let l = raw.to_lowercase();
    l.contains("model is not supported") || l.contains("not supported when using codex with a chatgpt account")
}

/// Erros comuns do Codex numa ação concreta (nunca JSON cru).
pub(crate) fn codex_friendly_error(msg: &str) -> String {
    let l = msg.to_lowercase();
    let short: String = msg.chars().take(300).collect();
    if l.contains("401") || l.contains("unauthorized") || l.contains("api key") || l.contains("not logged") || l.contains("login") {
        return format!("O Codex está sem login/chave — rode `codex login` num terminal ou configure a chave OpenAI em Conta → Chaves de modelo.\n\n({short})");
    }
    if l.contains("429") || l.contains("rate limit") || l.contains("quota") || l.contains("usage limit") {
        return format!("O Codex está sem cota/limite no momento — espere um pouco e tente de novo.\n\n({short})");
    }
    if l.contains("stream disconnected") || l.contains("network") || l.contains("timed out") || l.contains("connection") {
        return format!("O Codex não conseguiu falar com a OpenAI — cheque a internet/VPN e tente de novo.\n\n({short})");
    }
    format!("O Codex falhou: {short}")
}

/// Falha do Codex: o texto CRU (pra detectar recusa de modelo) e o humano (pra tela).
#[derive(Debug)]
pub(crate) struct CodexFail {
    pub raw: String,
    pub friendly: String,
}

/// Roda o comando com `input` no STDIN, até `secs` (estourou → mata e devolve timed_out=true).
fn output_stdin(mut cmd: Command, input: &str, secs: u64) -> std::io::Result<(std::process::Output, bool)> {
    use std::io::Write;
    use std::sync::mpsc;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let pid = child.id() as i32;
    let mut stdin = child.stdin.take();
    let data = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || { if let Some(s) = stdin.as_mut() { let _ = s.write_all(&data); } drop(stdin); });
    let timed = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<()>();
    let t2 = timed.clone();
    let watch = std::thread::spawn(move || {
        if rx.recv_timeout(Duration::from_secs(secs.max(1))).is_err() {
            t2.store(true, Ordering::SeqCst);
            kill_pid(pid, procsig::KILL);
        }
    });
    let out = child.wait_with_output();
    let _ = tx.send(());
    let _ = watch.join();
    let _ = writer.join();
    Ok((out?, timed.load(Ordering::SeqCst)))
}

/// Uma execução do `codex exec` (sem retry). `key` = OPENAI_API_KEY do cofre — a ÚNICA chave que entra
/// no env (o codex lê diffs não confiáveis; as outras chaves da conta ficam de fora).
pub(crate) fn codex_exec(bin: &str, prompt: &str, cwd: Option<&Path>, model: Option<&str>, low: bool, key: Option<&str>, deadline: Instant) -> Result<String, CodexFail> {
    let fail = |raw: &str, friendly: String| CodexFail { raw: raw.to_string(), friendly };
    let left = deadline.saturating_duration_since(Instant::now()).as_secs();
    if left == 0 { return Err(fail("timeout", CODEX_TIMEOUT_MSG.into())); }
    let mut cmd = Command::new(bin);
    cmd.args(codex_args(model, low));
    cmd.current_dir(cwd.map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir));
    if let Some(k) = key { cmd.env("OPENAI_API_KEY", k); }
    // o codex do npm é `#!/usr/bin/env node`: app aberto pelo Finder tem PATH mínimo — põe a pasta do
    // codex e a do node escolhido na frente (mesmo cuidado do claudeEnv no motor)
    {
        let mut dirs: Vec<PathBuf> = vec![];
        for b in [bin.to_string(), node_bin()] {
            if let Some(d) = Path::new(&b).parent().filter(|d| !d.as_os_str().is_empty()) { dirs.push(d.to_path_buf()); }
        }
        let cur = std::env::var_os("PATH").unwrap_or_default();
        dirs.extend(std::env::split_paths(&cur));
        if let Ok(p) = std::env::join_paths(dirs) { cmd.env("PATH", p); }
    }
    let (out, timed) = match output_stdin(cmd, prompt, left) {
        Ok(x) => x,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(fail(&e.to_string(), CODEX_MISSING_MSG.into())),
        Err(e) => return Err(fail(&e.to_string(), format!("Não consegui rodar o Codex: {e}"))),
    };
    if timed { return Err(fail("timeout", CODEX_TIMEOUT_MSG.into())); }
    let stdout = String::from_utf8_lossy(&out.stdout);
    match codex_outcome(&stdout) {
        (Some(s), _) => Ok(s),
        (None, Some(raw)) => Err(fail(&raw, codex_friendly_error(&raw))),
        (None, None) => {
            let err: String = String::from_utf8_lossy(&out.stderr).trim().chars().take(400).collect();
            if err.is_empty() { Err(fail("", "O Codex terminou sem resposta — tente de novo.".into())) }
            else { Err(fail(&err, codex_friendly_error(&err))) }
        }
    }
}

/// Codex com o retry de modelo recusado: a 2ª tentativa (sem -m) usa o TEMPO QUE SOBROU, e a recusa fica
/// guardada pro resto do processo.
pub(crate) fn codex_run(bin: &str, key: Option<&str>, req: &AiOnce, user_model: Option<&str>) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(req.secs.max(120));
    let (model, low) = codex_plan(req.tier, user_model);
    match codex_exec(bin, req.prompt, req.cwd, model.as_deref(), low, key, deadline) {
        Err(f) if model.is_some() && codex_model_refused(&f.raw) => {
            codex_remember_refused(model.as_deref().unwrap_or(""));
            codex_exec(bin, req.prompt, req.cwd, None, low, key, deadline).map_err(|f| f.friendly)
        }
        r => r.map_err(|f| f.friendly),
    }
}

// ---------- Gateway ----------

pub(crate) fn gateway_payload(model: &str, prompt: &str) -> String {
    serde_json::json!({
        "model": model, "max_tokens": 16000, "stream": false,
        "messages": [{ "role": "user", "content": prompt }]
    }).to_string()
}

/// Resposta do `chat/completions` → texto, ou erro humano. `content` pode vir em partes ([{text}]);
/// `finish_reason: "length"` = cortada → erro claro (antes saía meio relatório calado).
pub(crate) fn parse_gateway(body: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).map_err(|_| {
        let s: String = body.trim().chars().take(160).collect();
        if s.is_empty() { "O gateway não respondeu — cheque a URL em Configurações → Gateway próprio.".to_string() }
        else { format!("O gateway respondeu algo inesperado (não é JSON): {s}") }
    })?;
    let ch = &v["choices"][0];
    let content = &ch["message"]["content"];
    let text = if let Some(s) = content.as_str() {
        Some(s.to_string())
    } else {
        content.as_array().map(|parts| parts.iter().filter_map(|p| p["text"].as_str().or_else(|| p.as_str())).collect::<String>())
    };
    if let Some(t) = text {
        if ch["finish_reason"].as_str() == Some("length") { return Err(GATEWAY_CUT_MSG.into()); }
        let t = t.trim();
        if t.is_empty() { return Err("O gateway devolveu uma resposta vazia — tente de novo.".into()); }
        return Ok(t.to_string());
    }
    let err = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["detail"].as_str()).unwrap_or("").to_string();
    let l = err.to_lowercase();
    if l.contains("401") || l.contains("unauthorized") || (l.contains("invalid") && l.contains("key")) || l.contains("authentication") {
        return Err(format!("O gateway recusou a chave — confira em Configurações → Gateway próprio.\n\n({err})"));
    }
    if !err.is_empty() { return Err(format!("O gateway recusou: {err}")); }
    Err(format!("Sem resposta do gateway ({})", body.chars().take(120).collect::<String>()))
}

/// Arquivos temporários PRIVADOS (0600, nome único) apagados sempre — inclusive em erro/pânico.
struct TmpFiles(Vec<PathBuf>);
impl Drop for TmpFiles {
    fn drop(&mut self) { for p in &self.0 { let _ = std::fs::remove_file(p); } }
}
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
fn tmp_private(files: &mut TmpFiles, kind: &str, content: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    let p = std::env::temp_dir().join(format!("starfork-ai-{}-{}-{kind}", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::SeqCst)));
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let mut f = o.open(&p).map_err(|e| format!("não consegui preparar a chamada ao gateway: {e}"))?;
    files.0.push(p.clone());
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p)
}

/// argv do curl: cabeçalhos (com a chave) e corpo vêm de ARQUIVOS — nada sensível aparece no `ps`.
pub(crate) fn gateway_curl_args(url: &str, hdr: &Path, body: &Path, secs: u64) -> Vec<String> {
    vec![
        "-s".into(), "-m".into(), secs.to_string(), "-X".into(), "POST".into(), url.into(),
        "-H".into(), format!("@{}", hdr.display()), "--data-binary".into(), format!("@{}", body.display()),
    ]
}

pub(crate) fn gateway_call(g: &Gateway, prompt: &str, secs: u64) -> Result<String, String> {
    let mut files = TmpFiles(vec![]);
    let hdr = tmp_private(&mut files, "h", &format!("Authorization: Bearer {}\nContent-Type: application/json\n", g.key))?;
    let body = tmp_private(&mut files, "b", &gateway_payload(&g.model, prompt))?;
    let mut c = Command::new("curl");
    c.args(gateway_curl_args(&format!("{}/chat/completions", g.base), &hdr, &body, secs));
    let out = output_timeout(c, secs + 5).map_err(|e| format!("Não consegui falar com o gateway ({}): {e}", g.base))?;
    drop(files);
    if !out.status.success() && out.stdout.is_empty() {
        return Err(format!("Não consegui falar com o gateway ({}) — cheque a URL e a internet/VPN (curl código {}).", g.base, out.status.code().unwrap_or(-1)));
    }
    parse_gateway(&String::from_utf8_lossy(&out.stdout))
}

// ---------- o ponto único ----------

fn run_claude(req: &AiOnce) -> Result<String, String> {
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(claude_args(req.prompt, req.claude_model, req.claude_extra));
    if let Some(d) = req.cwd { cmd.current_dir(d); }
    let out = output_timeout(cmd, req.secs).map_err(|e| format!("Não consegui rodar o Claude Code: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().chars().take(300).collect() } else { err };
        return Err(if err.is_empty() {
            format!("O Claude Code saiu com código {} sem mensagem.", out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
        } else { claude_friendly_error(&err) });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Roda a chamada auxiliar no motor resolvido.
pub(crate) fn ai_once(req: AiOnce) -> Result<String, String> {
    let pref = pref_engine();
    let eng = pick_with(&pref, engine_avail).ok_or_else(|| NO_ENGINE_MSG.to_string())?;
    let user_model = user_model_for(&pref, eng, setting_get("aiModel").as_deref());
    match eng {
        AiEngine::Claude => run_claude(&req),
        AiEngine::Codex => {
            let key = llm_env_get("OPENAI_API_KEY").filter(|k| !k.trim().is_empty());
            codex_run(&codex_bin(), key.as_deref(), &req, user_model.as_deref())
        }
        AiEngine::Gateway => {
            let mut g = gateway_cfg().ok_or("Configure o gateway (URL, chave e modelo) em Configurações → Gateway próprio.")?;
            if let Some(m) = user_model { g.model = m; }
            gateway_call(&g, req.prompt, req.secs.max(90))
        }
    }
}

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    const PICK: &str = include_str!("../../../tests/fixtures/ai-once-golden/pick.json");
    const CODEX: &str = include_str!("../../../tests/fixtures/ai-once-golden/codex.json");
    const GATEWAY: &str = include_str!("../../../tests/fixtures/ai-once-golden/gateway.json");

    fn req<'a>(prompt: &'a str, tier: Tier, cwd: Option<&'a Path>) -> AiOnce<'a> {
        AiOnce { prompt, tier, claude_model: None, claude_extra: &[], cwd, secs: 20 }
    }
    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("starfork-aitest-{tag}-{}-{}", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// codex FALSO: grava argv (um por linha), env, cwd e stdin; `-m` presente + `refuse` → recusa de modelo.
    fn fake_codex(dir: &Path, refuse: bool) -> String {
        let refused = r#"{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}}"#;
        let d = dir.display();
        let script = format!(r#"#!/bin/sh
echo call >> "{d}/calls.log"
printf '%s\n' "$@" > "{d}/argv.txt"
echo "OPENAI_API_KEY=$OPENAI_API_KEY" > "{d}/env.txt"
echo "LGCX_API_KEY=$LGCX_API_KEY" >> "{d}/env.txt"
pwd > "{d}/cwd.txt"
cat > "{d}/stdin.txt"
if [ "{refuse}" = "true" ]; then for a in "$@"; do if [ "$a" = "-m" ]; then echo '{refused}'; exit 1; fi; done; fi
echo '{{"type":"item.completed","item":{{"id":"i","type":"agent_message","text":"resposta falsa"}}}}'
"#);
        let p = dir.join("codex");
        std::fs::write(&p, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.display().to_string()
    }

    #[test]
    fn ai_once_golden_pick() {
        let cases: serde_json::Value = serde_json::from_str(PICK).unwrap();
        for c in cases.as_array().unwrap() {
            let a = &c["avail"];
            let av = Avail { claude: a["claude"].as_bool().unwrap(), codex: a["codex"].as_bool().unwrap(), gateway: a["gateway"].as_bool().unwrap() };
            let got = pick_engine(c["pref"].as_str().unwrap(), &av).map(|e| match e { AiEngine::Claude => "claude", AiEngine::Codex => "codex", AiEngine::Gateway => "gateway" });
            assert_eq!(got, c["expect"].as_str(), "{c}");
        }
        assert!(NO_ENGINE_MSG.contains("Claude Code") && NO_ENGINE_MSG.contains("Codex") && NO_ENGINE_MSG.contains("gateway"));
    }

    #[test]
    fn ai_once_golden_codex_jsonl() {
        let cases: serde_json::Value = serde_json::from_str(CODEX).unwrap();
        for c in cases.as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let (text, raw) = codex_outcome(c["jsonl"].as_str().unwrap());
            assert_eq!(text.as_deref(), c["text"].as_str(), "{name}");
            if let Some(r) = c["rawError"].as_str() { assert!(raw.as_deref().unwrap_or("").contains(r), "{name}: {raw:?}"); }
            assert_eq!(codex_model_refused(raw.as_deref().unwrap_or("")), c["refused"].as_bool().unwrap(), "{name}");
            if let Some(f) = c["friendly"].as_str() {
                let e = parse_codex_jsonl(c["jsonl"].as_str().unwrap()).unwrap_err();
                assert!(e.contains(f) && !e.contains("{\""), "{name}: {e}");
            }
        }
        // o detector olha o texto CRU — a mensagem amigável do app não o dispara
        assert!(!codex_model_refused("O Codex falhou: modelo"));
    }

    #[test]
    fn ai_once_golden_gateway() {
        let cases: serde_json::Value = serde_json::from_str(GATEWAY).unwrap();
        for c in cases.as_array().unwrap() {
            let r = parse_gateway(c["body"].as_str().unwrap());
            match c["text"].as_str() {
                Some(t) => assert_eq!(r.as_deref(), Ok(t), "{}", c["name"]),
                None => assert!(r.unwrap_err().contains(c["error"].as_str().unwrap()), "{}", c["name"]),
            }
        }
        let p: serde_json::Value = serde_json::from_str(&gateway_payload("m1", "oi")).unwrap();
        assert_eq!((p["model"].as_str(), p["max_tokens"].as_i64(), p["stream"].as_bool()), (Some("m1"), Some(16000), Some(false)));
    }

    #[test]
    fn ai_once_args_e_modelos() {
        assert_eq!(claude_args("oi", Some("claude-haiku-4-5-20251001"), &[]), vec!["-p", "oi", "--model", "claude-haiku-4-5-20251001"]);
        assert_eq!(claude_args("oi", None, &["--allowedTools".into(), "Read".into()]), vec!["-p", "oi", "--allowedTools", "Read"]);
        assert_eq!(codex_args(Some("gpt-5-codex"), false), vec!["exec", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\"", "-m", "gpt-5-codex", "-"]);
        let r = codex_args(None, true);
        assert!(r.contains(&"model_reasoning_effort=\"low\"".to_string()) && !r.contains(&"-m".to_string()) && r.last().unwrap() == "-");
        assert_eq!(codex_plan(Tier::Capaz, None), (Some("gpt-5-codex".into()), false));
        assert_eq!(codex_plan(Tier::Rapido, None), (None, true));
        assert_eq!(codex_plan(Tier::Rapido, Some("o4-mini")), (Some("o4-mini".into()), true));
        // aiModel só vale pro motor escolhido, nunca no claude
        assert_eq!(user_model_for("codex", AiEngine::Codex, Some("gpt-5")), Some("gpt-5".into()));
        assert_eq!(user_model_for("claude", AiEngine::Codex, Some("opus")), None);
        assert_eq!(user_model_for("gateway", AiEngine::Gateway, Some("m; rm -rf")), None);
        assert_eq!(user_model_for("claude", AiEngine::Claude, Some("opus")), None);
    }

    #[test]
    fn ai_once_codex_falso_so_leitura_stdin_e_so_a_chave_permitida() {
        let d = tmpdir("codex");
        let bin = fake_codex(&d, false);
        let cwd = tmpdir("cwd");
        let prompt = "um prompt \"com aspas\" e\nquebra de linha";
        let out = codex_run(&bin, Some("sk-teste"), &req(prompt, Tier::Capaz, Some(&cwd)), None).unwrap();
        assert_eq!(out, "resposta falsa");
        let argv = std::fs::read_to_string(d.join("argv.txt")).unwrap();
        assert_eq!(argv.lines().collect::<Vec<_>>(), vec!["exec", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\"", "-m", "gpt-5-codex", "-"]);
        assert!(!argv.contains("um prompt"), "o prompt vai pelo stdin, não no argv");
        assert_eq!(std::fs::read_to_string(d.join("stdin.txt")).unwrap(), prompt);
        let env = std::fs::read_to_string(d.join("env.txt")).unwrap();
        assert!(env.contains("OPENAI_API_KEY=sk-teste") && env.contains("LGCX_API_KEY=\n"), "{env}");
        assert_eq!(PathBuf::from(std::fs::read_to_string(d.join("cwd.txt")).unwrap().trim()).canonicalize().unwrap(), cwd.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn ai_once_codex_modelo_recusado_tenta_sem_m_e_lembra() {
        let d = tmpdir("refused");
        let bin = fake_codex(&d, true);
        let model = "modelo-recusado-teste-rs";
        let out = codex_run(&bin, None, &req("x", Tier::Capaz, None), Some(model)).unwrap();
        assert_eq!(out, "resposta falsa");
        assert_eq!(std::fs::read_to_string(d.join("calls.log")).unwrap().lines().count(), 2);
        assert!(!std::fs::read_to_string(d.join("argv.txt")).unwrap().lines().any(|l| l == "-m"));
        // próxima chamada: direto sem -m (sem repetir a falha)
        let out = codex_run(&bin, None, &req("y", Tier::Capaz, None), Some(model)).unwrap();
        assert_eq!(out, "resposta falsa");
        assert_eq!(std::fs::read_to_string(d.join("calls.log")).unwrap().lines().count(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ai_once_codex_ausente_e_mensagem_humana() {
        let e = codex_run("/nao/existe/codex", None, &req("x", Tier::Rapido, None), None).unwrap_err();
        assert_eq!(e, CODEX_MISSING_MSG);
    }

    /// os testes de gateway contam/criam arquivos temporários — um de cada vez
    static GW_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn ai_once_gateway_http_local_sem_chave_no_argv() {
        let _l = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let srv = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).unwrap();
                if n == 0 { break; }
                buf.extend_from_slice(&chunk[..n]);
                let txt = String::from_utf8_lossy(&buf).to_string();
                if let Some(i) = txt.find("\r\n\r\n") {
                    let len = txt.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if buf.len() >= i + 4 + len { break; }
                }
            }
            let body = r#"{"choices":[{"message":{"content":[{"type":"text","text":"resposta "},{"type":"text","text":"do gateway"}]},"finish_reason":"stop"}]}"#;
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
            String::from_utf8_lossy(&buf).to_string()
        });
        let g = Gateway { base: format!("http://127.0.0.1:{port}/v1"), key: "gw-segredo".into(), model: "modelo-interno".into() };
        let before = std::fs::read_dir(std::env::temp_dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&format!("starfork-ai-{}-", std::process::id()))).count();
        let out = gateway_call(&g, "oi gateway", 10).unwrap();
        assert_eq!(out, "resposta do gateway");
        let got = srv.join().unwrap();
        assert!(got.starts_with("POST /v1/chat/completions"), "{got}");
        assert!(got.contains("Authorization: Bearer gw-segredo"));
        assert!(got.contains("\"max_tokens\":16000") && got.contains("\"model\":\"modelo-interno\""));
        let after = std::fs::read_dir(std::env::temp_dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&format!("starfork-ai-{}-", std::process::id()))).count();
        assert_eq!(before, after, "arquivos temporários com a chave sempre apagados");
        let args = gateway_curl_args("http://x/v1/chat/completions", Path::new("/tmp/h"), Path::new("/tmp/b"), 9);
        assert!(!args.iter().any(|a| a.contains("gw-segredo") || a.contains("Bearer")));
    }

    #[test]
    fn ai_once_gateway_inalcancavel() {
        let _l = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let g = Gateway { base: "http://127.0.0.1:9/v1".into(), key: "k".into(), model: "m".into() };
        let e = gateway_call(&g, "oi", 5).unwrap_err();
        assert!(e.contains("Não consegui falar com o gateway"), "{e}");
    }

    #[test]
    fn ai_once_bin_exists() {
        assert!(!bin_exists("/nao/existe/claude"));
        assert!(bin_exists("sh"));
        assert!(!bin_exists("binario-que-nao-existe-xyz"));
    }

    /// Restaura as variáveis ao sair (inclusive em pânico).
    struct EnvGuard(Vec<(String, Option<std::ffi::OsString>)>);
    impl EnvGuard {
        fn set(vars: &[(&str, &str)]) -> EnvGuard {
            let g = EnvGuard(vars.iter().map(|(k, _)| (k.to_string(), std::env::var_os(k))).collect());
            for (k, v) in vars { std::env::set_var(k, v); }
            clear_avail_cache();
            g
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.0 { match v { Some(v) => std::env::set_var(k, v), None => std::env::remove_var(k) } }
            clear_avail_cache();
        }
    }

    /// Ponta a ponta REAL (precisa do codex com login): IA padrão Codex, SEM claude, HOME temporário.
    /// `CARDUME_CODEX=<codex real> cargo test ai_once_e2e -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn ai_once_e2e_codex_sem_claude() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let real_home = std::env::var("HOME").unwrap();
        let tmp = tmpdir("e2e");
        std::fs::create_dir_all(tmp.join(".constellation")).unwrap();
        std::fs::write(tmp.join(".constellation/settings.json"), r#"{"aiEngine":"codex","aiModel":""}"#).unwrap();
        let codex_home = format!("{real_home}/.codex");
        let tmp_s = tmp.display().to_string();
        let _env = EnvGuard::set(&[("CODEX_HOME", codex_home.as_str()), ("HOME", tmp_s.as_str()), ("CARDUME_CLAUDE", "/nao/existe/claude")]);
        assert_eq!(resolve_engine(), Ok(AiEngine::Codex));
        let t0 = Instant::now();
        let title = crate::ai_title("quero que a lista de pedidos tenha um filtro por intervalo de datas salvo na URL".into());
        eprintln!("ai_title ({:?}): {title:?}", t0.elapsed());
        assert!(title.is_ok());
        let t0 = Instant::now();
        let spec = ai_once(AiOnce { prompt: "Responda SOMENTE um objeto JSON {\"title\": string, \"requirements\": [string]} para: filtro por data na lista de pedidos.", tier: Tier::Capaz, claude_model: Some("claude-sonnet-5"), claude_extra: &[], cwd: None, secs: 60 });
        eprintln!("capaz ({:?}): {spec:?}", t0.elapsed());
        assert!(spec.as_ref().map(|s| s.contains('{')).unwrap_or(false));
        let env = crate::env_check();
        let ia = env.iter().find(|c| c.name.starts_with("Motor de IA")).unwrap();
        eprintln!("env: {} ok={} · {}", ia.name, ia.ok, ia.detail);
        assert!(ia.ok && ia.detail.contains("Codex"));
        assert!(env.iter().any(|c| c.name.starts_with("Claude Code") && !c.ok && c.kind == "opt"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
