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
//! - deepseek (BETA) → `dsh --patch <fixo> --patch <modelo> --profile headless --json` SÓ-LEITURA
//!             (DSH_PERMISSION_MODE=read-only), prompt no STDIN, só a DEEPSEEK_API_KEY no env (nunca no argv);
//!             resposta = texto do evento `final`. Modelo: `aiModel`, senão deepseek-flash (rápido) / deepseek-v4-pro (capaz).
//!
//! Motor escolhido indisponível → o primeiro disponível na ordem claude, codex, gateway, deepseek; nenhum → erro
//! humano dizendo o que instalar/configurar. Os chats de várias rodadas usam a MESMA escolha via `chat_turn` (abaixo).
//! Golden compartilhado com o motor TS (src/ai-once.ts): tests/fixtures/ai-once-golden/.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum AiEngine {
    Claude,
    Codex,
    Gateway,
    Deepseek,
}
impl AiEngine {
    pub(crate) fn label(self) -> &'static str {
        match self {
            AiEngine::Claude => "Claude Code",
            AiEngine::Codex => "Codex",
            AiEngine::Gateway => "Gateway",
            AiEngine::Deepseek => "DeepSeek (beta)",
        }
    }
    pub(crate) fn parse(s: &str) -> Option<AiEngine> {
        let n = s.trim().to_ascii_lowercase();
        if n.starts_with("codex") { Some(AiEngine::Codex) }
        else if is_dsh_label(&n) { Some(AiEngine::Deepseek) }
        else if n.starts_with("gateway") || n.starts_with("logcomex") { Some(AiEngine::Gateway) }
        else if n.starts_with("claude") { Some(AiEngine::Claude) }
        else { None }
    }
}
/// Fallback automático: SEM o DeepSeek (beta, terceiro) — ele só roda quando é a IA escolhida (aiEngine=deepseek).
const ORDER: [AiEngine; 3] = [AiEngine::Claude, AiEngine::Codex, AiEngine::Gateway];

/// Mesmo rótulo do TS (isDshLabel): "deepseek…" ou "dsh" como palavra ("dsh-flash", "dsh:x"; "dshx" não).
pub(crate) fn is_dsh_label(s: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let n = s.trim().to_lowercase();
    n.starts_with("deepseek") || RE.get_or_init(|| regex::Regex::new(r"^dsh\b").unwrap()).is_match(&n)
}

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
    pub deepseek: bool,
}
impl Avail {
    fn has(&self, e: AiEngine) -> bool {
        match e { AiEngine::Claude => self.claude, AiEngine::Codex => self.codex, AiEngine::Gateway => self.gateway, AiEngine::Deepseek => self.deepseek }
    }
}

pub(crate) const NO_ENGINE_MSG: &str = "Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), configure um gateway em Configurações → Gateway próprio, ou use o DeepSeek Harness (beta: npm i -g @deepseek-ai/dsh + DEEPSEEK_API_KEY em Configurações → Sua IA).";
pub(crate) const DSH_MISSING_MSG: &str = "O DeepSeek Harness (dsh) não está instalado neste computador — instale com npm i -g @deepseek-ai/dsh (veja Mais › Ambiente).";
pub(crate) const DSH_KEY_MSG: &str = "Falta a chave da DeepSeek (DEEPSEEK_API_KEY) — adicione em Configurações → Sua IA.";
pub(crate) const DSH_TIMEOUT_MSG: &str = "O DeepSeek não respondeu a tempo — tente de novo.";
pub(crate) const DSH_FAST_MODEL: &str = "deepseek-flash";
pub(crate) const DSH_CAPABLE_MODEL: &str = "deepseek-v4-pro";
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
pub(crate) fn codex_bin() -> String { node_tool_bin("CARDUME_CODEX", "codex") }

/// Mesma busca pra qualquer CLI instalada com `npm i -g` (codex, dsh): <ENV> (se existir) → ao lado do node
/// configurado/escolhido → pastas dos gerenciadores de node → homebrew → /usr/local/bin → nome solto (PATH).
pub(crate) fn node_tool_bin(env_var: &str, name: &str) -> String {
    if let Ok(c) = std::env::var(env_var) {
        if !c.is_empty() && Path::new(&c).is_file() { return c; }
    }
    let exe = format!("{name}.exe");
    let cmd = format!("{name}.cmd");
    let names: Vec<&str> = if cfg!(windows) { vec![exe.as_str(), cmd.as_str()] } else { vec![name] };
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
    for p in [format!("/opt/homebrew/bin/{name}"), format!("/usr/local/bin/{name}")] {
        if Path::new(&p).is_file() { return p; }
    }
    name.to_string()
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
        AiEngine::Deepseek => dsh_status().is_ok(),
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
/// Zera o cache de disponibilidade (testes, e o app ao salvar/remover uma chave em Conta → Chaves de modelo).
pub(crate) fn clear_avail_cache() { *AVAIL_CACHE.lock().unwrap_or_else(|x| x.into_inner()) = None; }

pub(crate) fn availability() -> Avail {
    Avail { claude: engine_avail(AiEngine::Claude), codex: engine_avail(AiEngine::Codex), gateway: engine_avail(AiEngine::Gateway), deepseek: engine_avail(AiEngine::Deepseek) }
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
        return format!("O Codex está sem login/chave — rode `codex login` num terminal ou configure a chave OpenAI em Configurações → Sua IA.\n\n({short})");
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

/// Command do codex (sem argumentos): cwd, SÓ a OPENAI_API_KEY do cofre e o PATH com a pasta do node.
fn codex_command(bin: &str, key: Option<&str>, cwd: Option<&Path>) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd.map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir));
    if let Some(k) = key { cmd.env("OPENAI_API_KEY", k); }
    // o codex do npm é `#!/usr/bin/env node`: app aberto pelo Finder tem PATH mínimo — põe a pasta do
    // codex e a do node escolhido na frente (mesmo cuidado do claudeEnv no motor)
    let mut dirs: Vec<PathBuf> = vec![];
    for b in [bin.to_string(), node_bin()] {
        if let Some(d) = Path::new(&b).parent().filter(|d| !d.as_os_str().is_empty()) { dirs.push(d.to_path_buf()); }
    }
    let cur = std::env::var_os("PATH").unwrap_or_default();
    dirs.extend(std::env::split_paths(&cur));
    if let Ok(p) = std::env::join_paths(dirs) { cmd.env("PATH", p); }
    cmd
}

/// Uma execução do `codex exec` (sem retry). `key` = OPENAI_API_KEY do cofre — a ÚNICA chave que entra
/// no env (o codex lê diffs não confiáveis; as outras chaves da conta ficam de fora).
pub(crate) fn codex_exec(bin: &str, prompt: &str, cwd: Option<&Path>, model: Option<&str>, low: bool, key: Option<&str>, deadline: Instant) -> Result<String, CodexFail> {
    let fail = |raw: &str, friendly: String| CodexFail { raw: raw.to_string(), friendly };
    let left = deadline.saturating_duration_since(Instant::now()).as_secs();
    if left == 0 { return Err(fail("timeout", CODEX_TIMEOUT_MSG.into())); }
    let mut cmd = codex_command(bin, key, cwd);
    cmd.args(codex_args(model, low));
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
#[cfg(test)]
pub(crate) fn codex_run(bin: &str, key: Option<&str>, req: &AiOnce, user_model: Option<&str>) -> Result<String, String> {
    codex_run_used(bin, key, req, user_model, deadline_for(AiEngine::Codex, req.secs, None)).map(|x| x.0)
}
/// Codex com prazo de `secs` (ver deadline_for). Devolve (resposta, modelo USADO — None = padrão do Codex, inclusive
/// quando o escolhido foi recusado e a 2ª tentativa foi sem -m).
pub(crate) fn codex_run_used(bin: &str, key: Option<&str>, req: &AiOnce, user_model: Option<&str>, secs: u64) -> Result<(String, Option<String>), String> {
    let deadline = Instant::now() + Duration::from_secs(secs.max(1));
    let (model, low) = codex_plan(req.tier, user_model);
    match codex_exec(bin, req.prompt, req.cwd, model.as_deref(), low, key, deadline) {
        Ok(s) => Ok((s, model)),
        Err(f) if model.is_some() && codex_model_refused(&f.raw) => {
            codex_remember_refused(model.as_deref().unwrap_or(""));
            codex_exec(bin, req.prompt, req.cwd, None, low, key, deadline).map(|s| (s, None)).map_err(|f| f.friendly)
        }
        Err(f) => Err(f.friendly),
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

// ---------- DeepSeek Harness (beta) ----------

/// Acha o `dsh` como acha o codex (CARDUME_DSH só se existir, pasta do node escolhido, homebrew, /usr/local, PATH).
pub(crate) fn dsh_bin() -> String { node_tool_bin("CARDUME_DSH", "dsh") }

/// O dsh pede Node ^22.19 ou ≥24 (o 23 não serve).
pub(crate) fn dsh_node_ok_v(v: (u32, u32, u32)) -> bool { v.0 >= 24 || (v.0 == 22 && v.1 >= 19) }

/// Chave da DeepSeek: a da conta (llm.env) ou a do ambiente.
pub(crate) fn dsh_key() -> Option<String> {
    llm_env_get("DEEPSEEK_API_KEY").map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
        .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()))
}

/// O que falta pro dsh rodar — TIPADO (o painel Sua IA decide o estado por aqui, não pelo texto da mensagem).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DshIssue {
    Missing,
    /// Node incompatível/ausente — a mensagem humana já pronta
    Node(String),
    Key,
}
impl DshIssue {
    pub(crate) fn msg(&self) -> String {
        match self { DshIssue::Missing => DSH_MISSING_MSG.into(), DshIssue::Node(m) => m.clone(), DshIssue::Key => DSH_KEY_MSG.into() }
    }
}
/// Pronto pra uso? Err = o que falta (binário → node → chave).
pub(crate) fn dsh_check() -> Result<(), DshIssue> {
    if !bin_exists(&dsh_bin()) { return Err(DshIssue::Missing); }
    match node_version(&node_bin()) {
        Some(v) if dsh_node_ok_v(v) => {}
        Some(v) => return Err(DshIssue::Node(format!("O DeepSeek Harness precisa do Node 22.19+ ou 24+ (o escolhido pelo app é {}.{}.{}) — atualize o Node (veja Mais › Ambiente).", v.0, v.1, v.2))),
        None => return Err(DshIssue::Node("O DeepSeek Harness precisa do Node 22.19+ ou 24+ e não achei o Node (veja Mais › Ambiente).".into())),
    }
    if dsh_key().is_none() { return Err(DshIssue::Key); }
    Ok(())
}
/// Mesma checagem, já em mensagem humana.
pub(crate) fn dsh_status() -> Result<(), String> { dsh_check().map_err(|i| i.msg()) }

/// aiModel do usuário vale nos dois níveis — vazio ou alias/id do CLAUDE (opus/sonnet/haiku/claude…) não vale;
/// sem ele: capaz → deepseek-v4-pro, rápido → deepseek-flash. Mesma regra do TS (dshModelFor).
pub(crate) fn dsh_plan(tier: Tier, user_model: Option<&str>) -> String {
    let m = user_model.map(str::trim).unwrap_or("");
    let l = m.to_lowercase();
    if m.is_empty() || ["opus", "sonnet", "haiku", "claude"].iter().any(|p| l.starts_with(p)) {
        return (if tier == Tier::Capaz { DSH_CAPABLE_MODEL } else { DSH_FAST_MODEL }).to_string();
    }
    m.to_string()
}

/// Versão mínima testada (os ids de plugin dos patches vêm dela — developer preview muda nomes).
pub(crate) const DSH_MIN_VERSION: &str = "0.2.0-rc.2";
/// semver com pré-release: mesma regra do TS (dshVersionCmp). Ilegível = Equal (não bloqueia).
pub(crate) fn dsh_version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    fn parse(v: &str) -> Option<([u64; 3], Vec<String>)> {
        let c = regex::Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?").ok()?.captures(v.trim().trim_start_matches('v'))?;
        let n = [c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?];
        Some((n, c.get(4).map(|m| m.as_str().split('.').map(String::from).collect()).unwrap_or_default()))
    }
    let (Some(x), Some(y)) = (parse(a), parse(b)) else { return Equal };
    if x.0 != y.0 { return x.0.cmp(&y.0); }
    match (x.1.is_empty(), y.1.is_empty()) {
        (true, true) => return Equal,
        (true, false) => return Greater,
        (false, true) => return Less,
        _ => {}
    }
    for i in 0..x.1.len().max(y.1.len()) {
        let (Some(p), Some(q)) = (x.1.get(i), y.1.get(i)) else { return if x.1.len() < y.1.len() { Less } else { Greater } };
        let (pn, qn) = (p.parse::<u64>().ok(), q.parse::<u64>().ok());
        let o = match (pn, qn) { (Some(a), Some(b)) => a.cmp(&b), (Some(_), None) => Less, (None, Some(_)) => Greater, _ => p.cmp(q) };
        if o != Equal { return o; }
    }
    Equal
}
pub(crate) fn dsh_version_ok(v: &str) -> bool { dsh_version_cmp(v, DSH_MIN_VERSION) != std::cmp::Ordering::Less }

/// Patch FIXO do Starfork (mesmo texto do motor TS): upload de log de sessão pra DeepSeek e OTel desligados,
/// título por IA desligado (chamada extra ao modelo). Vai por --patch — nunca editamos o ~/.dsh do usuário.
pub(crate) fn dsh_base_patch() -> &'static str {
    "# Starfork — gerado automaticamente a cada execução (não edite: o app reescreve).\n# Envio de logs de sessão pra DeepSeek DESLIGADO por padrão.\n- id: session-log-deepseek\n  config:\n    enabled: false\n- id: session-telemetry-otel\n  disabled: true\n# título da sessão por IA = uma chamada extra ao modelo a cada turno (tokens à toa)\n- id: session-title-llm\n  disabled: true\n"
}
/// Patch por chamada: só o modelo (JSON = YAML válido, sem `!!js`).
pub(crate) fn dsh_model_patch(model: &str) -> String {
    // ordem de chaves FIXA (provider, model) — idêntico ao runPatchYaml do TS (golden dsh-patch.json)
    format!("# Starfork — gerado (não edite).\n- id: agent-default-model\n  config: {{\"provider\":\"deepseek-official\",\"model\":{}}}\n", serde_json::Value::String(model.to_string()))
}
/// Grava o patch fixo SÓ se o conteúdo mudou, via temporário + rename ATÔMICO, 0600: um dsh em paralelo nunca lê
/// o arquivo vazio (e roda com upload de log/OTel ligados). Mesmo comportamento do writeBasePatch (TS).
pub(crate) fn dsh_write_base_patch() -> Result<PathBuf, String> {
    let dir = PathBuf::from(home_dir_s()).join(".constellation").join("dsh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("não consegui preparar o DeepSeek: {e}"))?;
    let p = dir.join("starfork.patch.yml");
    let set600 = |_p: &Path| {
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(0o600)); }
    };
    if std::fs::read_to_string(&p).ok().as_deref() == Some(dsh_base_patch()) { set600(&p); return Ok(p); }
    let tmp = dir.join(format!("starfork.patch.yml.{}.{}.tmp", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::SeqCst)));
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let res = (|| -> std::io::Result<()> {
        use std::io::Write;
        o.open(&tmp)?.write_all(dsh_base_patch().as_bytes())?;
        std::fs::rename(&tmp, &p)
    })();
    let _ = std::fs::remove_file(&tmp);
    res.map_err(|e| format!("não consegui preparar o DeepSeek: {e}"))?;
    set600(&p);
    Ok(p)
}
/// Variável que NÃO vai pro dsh (mesma regra do TS dshEnvDrop): *_API_KEY/*_TOKEN/*_SECRET herdadas (menos a
/// DEEPSEEK_API_KEY) e marcadores do Claude Code.
pub(crate) fn dsh_env_drop(k: &str) -> bool {
    if k == "DEEPSEEK_API_KEY" { return false; }
    let u = k.to_uppercase();
    u.ends_with("_API_KEY") || u.ends_with("_TOKEN") || u.ends_with("_SECRET") || k.starts_with("CLAUDECODE") || k == "CLAUDE_CODE_ENTRYPOINT" || k == "CLAUDE_CODE_SSE_PORT"
}
/// argv do dsh — sem chave e sem prompt (vai no STDIN).
pub(crate) fn dsh_args(patches: &[String]) -> Vec<String> {
    let mut a = vec![];
    for p in patches { a.push("--patch".to_string()); a.push(p.clone()); }
    a.extend(["--profile", "headless", "--json"].iter().map(|s| s.to_string()));
    a
}
/// DSH_HOME do Starfork (CARDUME_DSH_HOME só pra testes): nunca o ~/.dsh do usuário.
pub(crate) fn dsh_home() -> PathBuf {
    std::env::var("CARDUME_DSH_HOME").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home_dir_s()).join(".constellation").join("dsh").join("home"))
}

/// JSONL do `dsh --json` → (texto do `final` se o turno CONCLUIU, erro CRU). Golden compartilhado com o TS.
pub(crate) fn dsh_outcome(stdout: &str) -> (Option<String>, Option<String>) {
    let (mut fin, mut err): (Option<String>, Option<String>) = (None, None);
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        match v["type"].as_str().unwrap_or("") {
            "final" => fin = Some(v["text"].as_str().unwrap_or("").to_string()),
            "error" => { let m = unwrap_json_msg(v["message"].as_str().unwrap_or("")); err = Some(if m.is_empty() { err.unwrap_or_else(|| "erro".into()) } else { m }); }
            "status" if v["phase"].as_str() == Some("turn_end") => {
                let kind = v["reason"]["kind"].as_str().unwrap_or("");
                if !kind.is_empty() && kind != "completed" {
                    let e = &v["reason"]["error"];
                    let parts: Vec<String> = [e["code"].as_str().map(String::from), e["message"].as_str().map(unwrap_json_msg)].into_iter().flatten().filter(|s| !s.is_empty()).collect();
                    err = Some(if parts.is_empty() { format!("turno {kind}") } else { parts.join(": ") });
                }
            }
            _ => {}
        }
    }
    match (fin, err) {
        (_, Some(e)) => (None, Some(e)),
        (Some(t), None) if !t.trim().is_empty() => (Some(t.trim().to_string()), None),
        _ => (None, None),
    }
}
#[cfg(test)]
pub(crate) fn parse_dsh_jsonl(stdout: &str) -> Result<String, String> {
    match dsh_outcome(stdout) {
        (Some(s), _) => Ok(s),
        (None, Some(raw)) => Err(dsh_friendly_error(&raw)),
        (None, None) => Err("O DeepSeek terminou sem resposta — tente de novo.".into()),
    }
}
/// As MESMAS regex do TS (DSH_ERR_KEY/QUOTA/NET em src/engine/dsh.ts) — números com \b ("4010" não é 401).
pub(crate) fn dsh_friendly_error(msg: &str) -> String {
    static RES: std::sync::OnceLock<[regex::Regex; 3]> = std::sync::OnceLock::new();
    let [key, quota, net] = RES.get_or_init(|| [
        regex::Regex::new(r"(?i)missing_credential|\b401\b|unauthorized|api[ _-]?key|authentication").unwrap(),
        regex::Regex::new(r"(?i)\b429\b|\b402\b|rate[ _-]?limit|quota|insufficient[ _-]?balance").unwrap(),
        regex::Regex::new(r"(?i)network|timed out|econn|fetch failed|\bconnection\b").unwrap(),
    ]);
    let short: String = msg.chars().take(300).collect();
    if key.is_match(msg) {
        return format!("{} e confira se ela é válida.\n\n({short})", DSH_KEY_MSG.trim_end_matches('.'));
    }
    if quota.is_match(msg) {
        return format!("O DeepSeek está sem saldo/limite no momento — confira a conta na DeepSeek e tente de novo.\n\n({short})");
    }
    if net.is_match(msg) {
        return format!("O DeepSeek não conseguiu falar com a API — cheque a internet/VPN e tente de novo.\n\n({short})");
    }
    format!("O DeepSeek falhou: {short}")
}

/// PATH do dsh: pasta do node ESCOLHIDO pelo app na frente (o dsh do npm é `#!/usr/bin/env node`), depois a do dsh.
fn dsh_path_env(bin: &str) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = vec![];
    for b in [node_bin(), bin.to_string()] {
        if let Some(d) = Path::new(&b).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !dirs.iter().any(|x| x == d) { dirs.push(d.to_path_buf()); }
        }
    }
    let cur = std::env::var_os("PATH").unwrap_or_default();
    dirs.extend(std::env::split_paths(&cur).filter(|d| !dirs.contains(d)).collect::<Vec<_>>());
    std::env::join_paths(dirs).ok()
}
/// `dsh --version` com o PATH certo (app aberto pelo Finder tem PATH mínimo) — só o Ambiente usa.
pub(crate) fn dsh_version(bin: &str) -> Option<String> {
    let mut c = Command::new(bin);
    c.arg("--version");
    if let Some(p) = dsh_path_env(bin) { c.env("PATH", p); }
    output_timeout(c, 8).ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string())
}

/// Command do dsh SÓ-LEITURA (DSH_PERMISSION_MODE=read-only), só a DEEPSEEK_API_KEY no env, patches fixo + modelo
/// (+ CARDUME_DSH_PATCH) e `--session-id` quando retoma. Os temporários (patch do modelo) vivem enquanto `TmpFiles` viver.
fn dsh_command(bin: &str, key: &str, tier: Tier, user_model: Option<&str>, cwd: Option<&Path>, session: Option<&str>) -> Result<(Command, TmpFiles), String> {
    if !bin_exists(bin) { return Err(DSH_MISSING_MSG.into()); }
    let base = dsh_write_base_patch()?;
    let mut files = TmpFiles(vec![]);
    let model_patch = tmp_private(&mut files, "dsh.patch.yml", &dsh_model_patch(&dsh_plan(tier, user_model)))?;
    let mut patches = vec![base.display().to_string(), model_patch.display().to_string()];
    if let Ok(x) = std::env::var("CARDUME_DSH_PATCH") { if !x.trim().is_empty() && Path::new(&x).is_file() { patches.push(x); } }
    let mut cmd = Command::new(bin);
    cmd.args(dsh_args(&patches));
    if let Some(s) = session { cmd.args(["--session-id", s]); }
    cmd.current_dir(cwd.map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir));
    // segredos herdados pelo app (OPENAI/ANTHROPIC/LGCX…) não chegam no dsh — só a DEEPSEEK_API_KEY
    for (k, _) in std::env::vars_os() { if let Some(k) = k.to_str() { if dsh_env_drop(k) { cmd.env_remove(k); } } }
    cmd.env("DEEPSEEK_API_KEY", key).env("DSH_PERMISSION_MODE", "read-only")
        .env("DSH_TELEMETRY_MODE", "DISABLED").env("DSH_TELEMETRY_DISABLED", "1").env("DSH_HOME", dsh_home());
    if let Some(p) = dsh_path_env(bin) { cmd.env("PATH", p); }
    Ok((cmd, files))
}

/// Uma chamada auxiliar no dsh: SÓ-LEITURA, prompt no STDIN, a chave só no env.
#[cfg(test)]
pub(crate) fn dsh_run(bin: &str, key: &str, req: &AiOnce, user_model: Option<&str>) -> Result<String, String> {
    dsh_run_secs(bin, key, req, user_model, deadline_for(AiEngine::Deepseek, req.secs, None))
}
/// dsh com prazo de `secs` (ver deadline_for).
pub(crate) fn dsh_run_secs(bin: &str, key: &str, req: &AiOnce, user_model: Option<&str>, secs: u64) -> Result<String, String> {
    let (cmd, files) = dsh_command(bin, key, req.tier, user_model, req.cwd, None)?;
    let (out, timed) = match output_stdin(cmd, req.prompt, secs.max(1)) {
        Ok(x) => x,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(DSH_MISSING_MSG.into()),
        Err(e) => return Err(format!("Não consegui rodar o DeepSeek Harness: {e}")),
    };
    drop(files);
    if timed { return Err(DSH_TIMEOUT_MSG.into()); }
    match dsh_outcome(&String::from_utf8_lossy(&out.stdout)) {
        (Some(s), _) => Ok(s),
        (None, Some(raw)) => Err(dsh_friendly_error(&raw)),
        (None, None) => {
            let err: String = String::from_utf8_lossy(&out.stderr).replace("dsh: ", "").trim().chars().take(400).collect();
            Err(if err.is_empty() { "O DeepSeek terminou sem resposta — tente de novo.".into() } else { dsh_friendly_error(&err) })
        }
    }
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
    run_on(eng, &req, user_model.as_deref(), None).map(|x| x.0)
}

/// Prazo (s) de uma chamada: `exact` (o "testar" do painel, curto) vale como veio; sem ele, os pisos de sempre —
/// codex/dsh 120s, gateway 90s, claude o pedido.
pub(crate) fn deadline_for(eng: AiEngine, req_secs: u64, exact: Option<u64>) -> u64 {
    if let Some(s) = exact { return s.max(1); }
    match eng {
        AiEngine::Codex | AiEngine::Deepseek => req_secs.max(120),
        AiEngine::Gateway => req_secs.max(90),
        AiEngine::Claude => req_secs,
    }
}

/// Roda a chamada num motor JÁ escolhido → (resposta, modelo USADO; None = padrão do motor).
fn run_on(eng: AiEngine, req: &AiOnce, user_model: Option<&str>, exact_secs: Option<u64>) -> Result<(String, Option<String>), String> {
    let secs = deadline_for(eng, req.secs, exact_secs);
    match eng {
        AiEngine::Claude => {
            let r2 = AiOnce { prompt: req.prompt, tier: req.tier, claude_model: req.claude_model, claude_extra: req.claude_extra, cwd: req.cwd, secs };
            run_claude(&r2).map(|s| (s, req.claude_model.map(String::from)))
        }
        AiEngine::Codex => {
            let key = llm_env_get("OPENAI_API_KEY").filter(|k| !k.trim().is_empty());
            codex_run_used(&codex_bin(), key.as_deref(), req, user_model, secs)
        }
        AiEngine::Deepseek => {
            let key = dsh_key().ok_or_else(|| DSH_KEY_MSG.to_string())?;
            dsh_run_secs(&dsh_bin(), &key, req, user_model, secs).map(|s| (s, Some(dsh_plan(req.tier, user_model))))
        }
        AiEngine::Gateway => {
            let mut g = gateway_cfg().ok_or(GATEWAY_CFG_MSG)?;
            if let Some(m) = user_model { g.model = m.to_string(); }
            gateway_call(&g, req.prompt, secs).map(|s| (s, Some(g.model.clone())))
        }
    }
}
pub(crate) const GATEWAY_CFG_MSG: &str = "Configure o gateway (URL, chave e modelo) em Configurações → Gateway próprio.";
/// UM comando de instalação do Claude Code (painel e mensagem de "não instalado").
pub(crate) const CLAUDE_INSTALL_CMD: &str = "npm install -g @anthropic-ai/claude-code && claude";
pub(crate) const CLAUDE_MISSING_MSG: &str = "O Claude Code não está instalado neste computador — rode `npm install -g @anthropic-ai/claude-code && claude` (o `claude` faz o login).";

// ---------- chats de várias rodadas (planner, chat do projeto, issues, orquestrador, mesa) ----------
// Seguem a MESMA escolha de motor da IA auxiliar (aiEngine; DeepSeek só quando escolhido). O Claude continua no
// caminho próprio de cada tela (lib.rs/mesa.rs, argumentos idênticos); os outros motores passam por `chat_turn`:
//  - codex    → `codex exec [resume <id>] --json … sandbox_mode="read-only"` com o prompt no STDIN;
//  - deepseek → `dsh … --json [--session-id <id>]` com DSH_PERMISSION_MODE=read-only, prompt no STDIN;
//  - gateway  → `chat/completions` (system + user), SEM ferramentas e SEM sessão: o front reenvia o histórico.
// O id da sessão leva o motor como prefixo ("codex:…", "dsh:…", "gateway:…"; o do Claude segue sem prefixo): sessão de
// outro motor (o usuário trocou a IA no meio) ou sumida → SESSION_LOST_MSG, que o front (aiCallResumeSafe) reconhece e
// refaz a rodada com o histórico.

/// Erro PADRÃO de "sessão não encontrada" de qualquer motor — casa com o aiCallResumeSafe (`session.*not found`).
pub(crate) const SESSION_LOST_MSG: &str = "session not found — a conversa anterior não pode ser retomada nesta IA; o app continua com o histórico.";
/// Sessão do gateway: não existe do lado dele — o front manda o histórico a cada rodada.
pub(crate) const GATEWAY_SID: &str = "gateway:historico";

/// O texto CRU de um motor diz que a sessão a retomar não existe (Codex: "no rollout found"; dsh: `session "x" does not
/// exist` / gravada noutra pasta; Claude: "No conversation found").
pub(crate) fn session_lost_raw(raw: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"(?i)no rollout found|thread/resume failed|session "[^"]*" (does not exist|was recorded in|recorded no working directory)|no conversation found|session (id )?.{0,60}not found|could not find session"#).unwrap()).is_match(raw)
}

fn sid_tag(e: AiEngine) -> &'static str {
    match e { AiEngine::Claude => "", AiEngine::Codex => "codex:", AiEngine::Deepseek => "dsh:", AiEngine::Gateway => "gateway:" }
}
fn safe_sid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
}
/// Sessão a retomar NESTE motor: Ok(None) = conversa nova; Ok(Some(id)) = retomar; Err(SESSION_LOST_MSG) = a sessão
/// é de outro motor (ou é do gateway, que não guarda nada) — o front refaz com o histórico.
pub(crate) fn sid_resume(e: AiEngine, sid: Option<&str>) -> Result<Option<String>, String> {
    let s = sid.map(str::trim).unwrap_or("");
    if s.is_empty() { return Ok(None); }
    let other_tag = ["codex:", "dsh:", "gateway:"].iter().any(|t| s.starts_with(t));
    match e {
        AiEngine::Claude => if other_tag { Err(SESSION_LOST_MSG.into()) } else { Ok(Some(s.to_string())) },
        AiEngine::Gateway => Err(SESSION_LOST_MSG.into()),
        _ => match s.strip_prefix(sid_tag(e)) {
            Some(id) if safe_sid(id) => Ok(Some(id.to_string())),
            _ => Err(SESSION_LOST_MSG.into()),
        },
    }
}

/// Motor dos chats agora (preferência + disponibilidade cacheada + fallback sem DeepSeek); nenhum → erro humano.
pub(crate) fn chat_engine() -> Result<AiEngine, String> {
    pick_with(&pref_engine(), engine_avail).ok_or_else(|| NO_ENGINE_MSG.to_string())
}

/// Uma rodada de chat: instruções da tela (`sys`, o mesmo texto que o Claude recebe em --append-system-prompt),
/// a mensagem, a sessão a retomar (com prefixo do motor) e a pasta do projeto (lida SÓ-LEITURA).
pub(crate) struct ChatTurn<'a> {
    pub sys: &'a str,
    pub prompt: &'a str,
    pub session_id: Option<&'a str>,
    pub cwd: &'a Path,
    pub secs: u64,
}
/// Ganchos da tela: linha de atividade ("lendo X") e o "parar" (pid registrado num slot/chave/mesa).
/// `stopped(pid)` diz se o usuário parou ESTE processo (no Windows o taskkill devolve código 1, não "sem código").
pub(crate) struct ChatHooks<'a> {
    pub activity: &'a dyn Fn(String),
    pub on_start: &'a dyn Fn(i32),
    pub on_end: &'a dyn Fn(i32),
    pub stopped: &'a dyn Fn(i32) -> bool,
    pub stop_marker: &'a str,
}
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChatOut {
    pub text: String,
    /// com o prefixo do motor (o front guarda e devolve na próxima rodada)
    pub session_id: String,
    pub in_tok: u64,
    pub out_tok: u64,
}

/// Prompt único pro codex/dsh (não há --append-system-prompt): as instruções da tela vão INTEIRAS a cada rodada
/// (o plano/cérebro mudam entre rodadas), com a regra de só-leitura.
pub(crate) fn chat_prompt(sys: &str, prompt: &str) -> String {
    format!("<instrucoes>\n{}\n</instrucoes>\n\nSiga as instruções acima à risca, inclusive o FORMATO da resposta. Você está em modo SÓ-LEITURA: pode ler o projeto nesta pasta, mas NÃO edita arquivos nem roda comandos que alterem estado, e não lê arquivos de segredo (.env, chaves).\n\nMENSAGEM:\n{}", sys.trim(), prompt)
}

/// Evento de uma linha JSONL dos motores, já no formato da tela.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ChatEv {
    Session(String),
    Activity(String),
    Usage(u64, u64),
}

/// "/bin/zsh -lc 'rg -n foo'" → "rg -n foo" (o Codex embrulha todo comando num shell).
fn unwrap_shell(cmd: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"^(?:\S*/)?(?:ba|z)?sh\s+-l?c\s+(.+)$"#).unwrap());
    let c = cmd.trim();
    match re.captures(c) {
        Some(m) => {
            let inner = m[1].trim();
            let q = inner.chars().next().filter(|q| *q == '\'' || *q == '"');
            match q { Some(q) if inner.len() >= 2 && inner.ends_with(q) => inner[1..inner.len() - 1].to_string(), _ => inner.to_string() }
        }
        None => c.to_string(),
    }
}

/// Uma linha do `codex exec --json` → sessão, atividade (comando/busca/ferramenta, UMA vez por item) e tokens.
pub(crate) fn codex_events(line: &str, seen: &mut std::collections::HashSet<String>) -> Vec<ChatEv> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return vec![] };
    let t = v["type"].as_str().unwrap_or("");
    if t == "thread.started" {
        return v["thread_id"].as_str().filter(|s| !s.is_empty()).map(|s| vec![ChatEv::Session(s.to_string())]).unwrap_or_default();
    }
    if t == "turn.completed" {
        let u = &v["usage"];
        return vec![ChatEv::Usage(u["input_tokens"].as_u64().unwrap_or(0), u["output_tokens"].as_u64().unwrap_or(0))];
    }
    if !t.starts_with("item.") { return vec![]; }
    let item = &v["item"];
    let it = item["type"].as_str().unwrap_or("");
    if !matches!(it, "command_execution" | "web_search" | "mcp_tool_call") { return vec![]; }
    let id = item["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() && t != "item.started" { return vec![]; }
    if !id.is_empty() && !seen.insert(id) { return vec![]; }
    let line = match it {
        "command_execution" => {
            let c = &item["command"];
            let shown = c.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")).or_else(|| c.as_str().map(String::from)).unwrap_or_default();
            if shown.trim().is_empty() { return vec![]; }
            crate::tool_line("bash", &serde_json::json!({ "command": unwrap_shell(&shown) }))
        }
        "web_search" => crate::tool_line("websearch", &serde_json::json!({ "query": item["query"].as_str().unwrap_or("") })),
        _ => crate::tool_line(item["tool"].as_str().unwrap_or("tool"), &item["arguments"]),
    };
    vec![ChatEv::Activity(line)]
}

/// Uma linha do `dsh --json` → sessão, atividade (tool_call, com o mesmo texto do Claude) e tokens (step_end).
pub(crate) fn dsh_events(line: &str) -> Vec<ChatEv> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return vec![] };
    match v["type"].as_str().unwrap_or("") {
        "session" => v["sessionId"].as_str().filter(|s| !s.is_empty()).map(|s| vec![ChatEv::Session(s.to_string())]).unwrap_or_default(),
        "tool_call" => vec![ChatEv::Activity(crate::tool_line(v["tool"].as_str().unwrap_or("tool"), &v["input"]))],
        "status" if v["phase"].as_str() == Some("step_end") => {
            let u = &v["usage"];
            vec![ChatEv::Usage(u["inputTokens"].as_u64().unwrap_or(0), u["outputTokens"].as_u64().unwrap_or(0))]
        }
        _ => vec![],
    }
}

enum ProcErr {
    Spawn(std::io::Error),
    Stopped,
    Timeout,
}
struct ProcOut {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}
/// Roda o processo num grupo próprio (o "parar" derruba a árvore), `input` no STDIN, lendo o stdout linha a linha
/// (`on_line`) com teto de `secs`.
fn run_proc(mut cmd: Command, input: Option<&str>, secs: u64, h: &ChatHooks, on_line: &mut dyn FnMut(&str)) -> Result<ProcOut, ProcErr> {
    use std::io::{BufRead, Read, Write};
    detach_new_group(&mut cmd);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(ProcErr::Spawn)?;
    let pid = child.id() as i32;
    (h.on_start)(pid);
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let timed = AtomicBool::new(false);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let (status, out, err) = std::thread::scope(|sc| {
        if let (Some(mut w), Some(inp)) = (stdin, input) { sc.spawn(move || { let _ = w.write_all(inp.as_bytes()); }); }
        let errh = sc.spawn(move || { let mut s = String::new(); if let Some(mut e) = stderr { let _ = e.read_to_string(&mut s); } s });
        let timed = &timed;
        sc.spawn(move || {
            if rx.recv_timeout(Duration::from_secs(secs.max(1))).is_err() { timed.store(true, Ordering::SeqCst); signal_group(pid, procsig::KILL); }
        });
        let mut all = String::new();
        if let Some(o) = stdout {
            for line in std::io::BufReader::new(o).lines().map_while(Result::ok) { on_line(&line); all.push_str(&line); all.push('\n'); }
        }
        let st = child.wait();
        let _ = tx.send(());
        (st, all, errh.join().unwrap_or_default())
    });
    let was_stopped = (h.stopped)(pid);
    (h.on_end)(pid);
    let status = match status { Ok(s) => s, Err(e) => return Err(ProcErr::Spawn(e)) };
    if timed.load(Ordering::SeqCst) { return Err(ProcErr::Timeout); }
    if status.code().is_none() || (was_stopped && !status.success()) { return Err(ProcErr::Stopped); }
    Ok(ProcOut { status, stdout: out, stderr: err })
}

/// Argumentos do Codex no chat: SÓ-LEITURA, sem aprovação, prompt pelo STDIN; retomando, `exec resume <id>` (que não
/// aceita --sandbox — por isso o sandbox vai por -c, como no motor das tarefas).
pub(crate) fn codex_chat_args(resume: Option<&str>, model: Option<&str>) -> Vec<String> {
    let mut a = codex_args(model, false);
    if let Some(id) = resume { a.splice(1..1, ["resume".to_string(), id.to_string()]); }
    a
}

fn codex_turn_once(bin: &str, key: Option<&str>, t: &ChatTurn, resume: Option<&str>, model: Option<&str>, deadline: Instant, h: &ChatHooks) -> Result<ChatOut, CodexFail> {
    let fail = |raw: &str, friendly: String| CodexFail { raw: raw.to_string(), friendly };
    let left = deadline.saturating_duration_since(Instant::now()).as_secs();
    if left == 0 { return Err(fail("timeout", CODEX_TIMEOUT_MSG.into())); }
    let mut cmd = codex_command(bin, key, Some(t.cwd));
    cmd.args(codex_chat_args(resume, model));
    let mut seen = std::collections::HashSet::new();
    let (mut sid, mut tin, mut tout) = (resume.map(String::from).unwrap_or_default(), 0u64, 0u64);
    let input = chat_prompt(t.sys, t.prompt);
    let r = run_proc(cmd, Some(&input), left, h, &mut |line| {
        for ev in codex_events(line, &mut seen) {
            match ev { ChatEv::Session(s) => sid = s, ChatEv::Activity(a) => (h.activity)(a), ChatEv::Usage(i, o) => { tin += i; tout += o; } }
        }
    });
    let out = match r {
        Ok(o) => o,
        Err(ProcErr::Stopped) => return Err(fail("", h.stop_marker.to_string())),
        Err(ProcErr::Timeout) => return Err(fail("timeout", CODEX_TIMEOUT_MSG.into())),
        Err(ProcErr::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => return Err(fail(&e.to_string(), CODEX_MISSING_MSG.into())),
        Err(ProcErr::Spawn(e)) => return Err(fail(&e.to_string(), format!("Não consegui rodar o Codex: {e}"))),
    };
    match codex_outcome(&out.stdout) {
        (Some(text), _) => Ok(ChatOut { text, session_id: if sid.is_empty() { String::new() } else { format!("codex:{sid}") }, in_tok: tin, out_tok: tout }),
        (None, raw) => {
            let raw = raw.unwrap_or_else(|| out.stderr.trim().chars().take(400).collect());
            if resume.is_some() && (session_lost_raw(&raw) || session_lost_raw(&out.stderr)) { return Err(fail(&raw, SESSION_LOST_MSG.into())); }
            if raw.is_empty() { Err(fail("", "O Codex terminou sem resposta — tente de novo.".into())) }
            else { Err(fail(&raw, codex_friendly_error(&raw))) }
        }
    }
}

/// Rodada no Codex com o retry de modelo recusado (a 2ª tentativa sem -m, no tempo que sobrou).
pub(crate) fn codex_chat(bin: &str, key: Option<&str>, t: &ChatTurn, resume: Option<&str>, user_model: Option<&str>, h: &ChatHooks) -> Result<ChatOut, String> {
    let deadline = Instant::now() + Duration::from_secs(deadline_for(AiEngine::Codex, t.secs, None));
    let (model, _) = codex_plan(Tier::Capaz, user_model);
    match codex_turn_once(bin, key, t, resume, model.as_deref(), deadline, h) {
        Err(f) if model.is_some() && codex_model_refused(&f.raw) => {
            codex_remember_refused(model.as_deref().unwrap_or(""));
            codex_turn_once(bin, key, t, resume, None, deadline, h).map_err(|f| f.friendly)
        }
        r => r.map_err(|f| f.friendly),
    }
}

/// Rodada no DeepSeek Harness (SÓ-LEITURA), retomando com `--session-id`.
pub(crate) fn dsh_chat(bin: &str, key: &str, t: &ChatTurn, resume: Option<&str>, user_model: Option<&str>, h: &ChatHooks) -> Result<ChatOut, String> {
    let (cmd, files) = dsh_command(bin, key, Tier::Capaz, user_model, Some(t.cwd), resume)?;
    let (mut sid, mut tin, mut tout) = (resume.map(String::from).unwrap_or_default(), 0u64, 0u64);
    let input = chat_prompt(t.sys, t.prompt);
    let r = run_proc(cmd, Some(&input), deadline_for(AiEngine::Deepseek, t.secs, None), h, &mut |line| {
        for ev in dsh_events(line) {
            match ev { ChatEv::Session(s) => sid = s, ChatEv::Activity(a) => (h.activity)(a), ChatEv::Usage(i, o) => { tin += i; tout += o; } }
        }
    });
    drop(files);
    let out = match r {
        Ok(o) => o,
        Err(ProcErr::Stopped) => return Err(h.stop_marker.to_string()),
        Err(ProcErr::Timeout) => return Err(DSH_TIMEOUT_MSG.into()),
        Err(ProcErr::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => return Err(DSH_MISSING_MSG.into()),
        Err(ProcErr::Spawn(e)) => return Err(format!("Não consegui rodar o DeepSeek Harness: {e}")),
    };
    match dsh_outcome(&out.stdout) {
        (Some(text), _) => Ok(ChatOut { text, session_id: if sid.is_empty() { String::new() } else { format!("dsh:{sid}") }, in_tok: tin, out_tok: tout }),
        (None, raw) => {
            let stderr = out.stderr.replace("dsh: ", "");
            if resume.is_some() && (raw.as_deref().is_some_and(session_lost_raw) || session_lost_raw(&stderr)) { return Err(SESSION_LOST_MSG.into()); }
            match raw {
                Some(r) => Err(dsh_friendly_error(&r)),
                None => {
                    let e: String = stderr.trim().chars().take(400).collect();
                    Err(if e.is_empty() { "O DeepSeek terminou sem resposta — tente de novo.".into() } else { dsh_friendly_error(&e) })
                }
            }
        }
    }
}

/// Corpo do chat no gateway: instruções da tela como `system`, a mensagem (com o histórico, que o front põe) como `user`.
pub(crate) fn gateway_chat_payload(model: &str, sys: &str, prompt: &str) -> String {
    serde_json::json!({
        "model": model, "max_tokens": 16000, "stream": false,
        "messages": [{ "role": "system", "content": sys }, { "role": "user", "content": prompt }]
    }).to_string()
}

/// Rodada no gateway (sem ferramentas, sem sessão). O curl também é parável.
pub(crate) fn gateway_chat(g: &Gateway, t: &ChatTurn, h: &ChatHooks) -> Result<ChatOut, String> {
    let secs = deadline_for(AiEngine::Gateway, t.secs, None);
    let mut files = TmpFiles(vec![]);
    let hdr = tmp_private(&mut files, "h", &format!("Authorization: Bearer {}\nContent-Type: application/json\n", g.key))?;
    let body = tmp_private(&mut files, "b", &gateway_chat_payload(&g.model, t.sys, t.prompt))?;
    let mut c = Command::new("curl");
    c.args(gateway_curl_args(&format!("{}/chat/completions", g.base), &hdr, &body, secs));
    let r = run_proc(c, None, secs + 5, h, &mut |_| {});
    drop(files);
    let out = match r {
        Ok(o) => o,
        Err(ProcErr::Stopped) => return Err(h.stop_marker.to_string()),
        Err(ProcErr::Timeout) => return Err(format!("Não consegui falar com o gateway ({}) — tempo esgotado; cheque a URL e a internet/VPN.", g.base)),
        Err(ProcErr::Spawn(e)) => return Err(format!("Não consegui falar com o gateway ({}): {e}", g.base)),
    };
    if !out.status.success() && out.stdout.trim().is_empty() {
        return Err(format!("Não consegui falar com o gateway ({}) — cheque a URL e a internet/VPN (curl código {}).", g.base, out.status.code().unwrap_or(-1)));
    }
    let text = parse_gateway(&out.stdout)?;
    let u = serde_json::from_str::<serde_json::Value>(out.stdout.trim()).map(|v| v["usage"].clone()).unwrap_or_default();
    Ok(ChatOut { text, session_id: GATEWAY_SID.into(), in_tok: u["prompt_tokens"].as_u64().unwrap_or(0), out_tok: u["completion_tokens"].as_u64().unwrap_or(0) })
}

/// Uma rodada de chat num motor que NÃO é o Claude (o Claude segue no caminho de cada tela).
pub(crate) fn chat_turn(eng: AiEngine, t: &ChatTurn, h: &ChatHooks) -> Result<ChatOut, String> {
    let resume = sid_resume(eng, t.session_id)?;
    let pref = pref_engine();
    let user_model = user_model_for(&pref, eng, setting_get("aiModel").as_deref());
    match eng {
        AiEngine::Claude => Err("o Claude Code usa o caminho próprio de cada chat".into()),
        AiEngine::Codex => {
            let key = llm_env_get("OPENAI_API_KEY").filter(|k| !k.trim().is_empty());
            codex_chat(&codex_bin(), key.as_deref(), t, resume.as_deref(), user_model.as_deref(), h)
        }
        AiEngine::Deepseek => {
            let key = dsh_key().ok_or_else(|| DSH_KEY_MSG.to_string())?;
            dsh_chat(&dsh_bin(), &key, t, resume.as_deref(), user_model.as_deref(), h)
        }
        AiEngine::Gateway => {
            let mut g = gateway_cfg().ok_or(GATEWAY_CFG_MSG)?;
            if let Some(m) = user_model { g.model = m; }
            gateway_chat(&g, t, h)
        }
    }
}

// ---------- painel "Sua IA" (primeiro acesso e Configurações) ----------
// Estado de CADA motor com o que falta e a correção — a MESMA disponibilidade do ai_once/Ambiente
// (binário no lugar, login do Codex, config do gateway, dsh_status), só que por motor em vez de "pelo menos um".

/// O que a máquina tem agora (separado pra testar com disponibilidades simuladas).
#[derive(Clone, Debug)]
pub(crate) struct Probe {
    pub claude_bin: Option<String>,
    pub codex_bin: Option<String>,
    pub codex_login: bool,
    pub openai_key: bool,
    pub gateway: Option<Gateway>,
    pub gateway_label: String,
    pub gateway_models: Vec<String>,
    pub dsh_bin: Option<String>,
    pub dsh: Result<(), DshIssue>,
    pub deepseek_key: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineStatus {
    /// claude | codex | deepseek | gateway (mesmos ids do seletor do app)
    pub id: &'static str,
    pub label: String,
    pub installed: bool,
    pub ready: bool,
    /// ready | install | login | key ("key" no gateway = falta configurar)
    pub state: &'static str,
    pub reason: String,
    /// correções, uma por item: comando (o app mostra com "copiar") ou instrução
    pub fixes: Vec<String>,
    /// nome da chave que o cartão grava no cofre da conta (a pessoa nunca digita o nome)
    pub key_name: Option<&'static str>,
    /// já existe a chave no cofre (o VALOR nunca sai daqui)
    pub key_saved: bool,
    /// modelos conhecidos pela máquina (só o gateway: os da config da conta)
    pub models: Vec<String>,
    pub detail: String,
    /// é a IA padrão do usuário (aiEngine)
    pub is_default: bool,
    /// é o motor que as chamadas auxiliares usam agora (padrão ou fallback)
    pub in_use: bool,
}

pub(crate) fn engines_status_from(pref: &str, p: &Probe) -> Vec<EngineStatus> {
    let want = AiEngine::parse(pref).unwrap_or(AiEngine::Claude);
    let mk = |e: AiEngine, id: &'static str, label: String| EngineStatus {
        id, label, installed: false, ready: false, state: "install", reason: String::new(), fixes: vec![], key_name: None,
        key_saved: false, models: vec![], detail: String::new(), is_default: want == e, in_use: false,
    };
    let mut out = vec![];
    // Claude Code
    let mut c = mk(AiEngine::Claude, "claude", "Claude Code".into());
    match &p.claude_bin {
        Some(b) => { c.installed = true; c.ready = true; c.state = "ready"; c.reason = "pronto — se a 1ª chamada pedir login, rode `claude` uma vez".into(); c.detail = b.clone(); }
        None => { c.reason = "não instalado neste computador".into(); c.fixes = vec![CLAUDE_INSTALL_CMD.into()]; }
    }
    out.push(c);
    // Codex: pronto = instalado + (login OU chave OpenAI no cofre) — a regra do Ambiente
    let mut x = mk(AiEngine::Codex, "codex", "Codex".into());
    x.key_name = Some("OPENAI_API_KEY");
    x.key_saved = p.openai_key;
    match &p.codex_bin {
        Some(b) if p.codex_login || p.openai_key => { x.installed = true; x.ready = true; x.state = "ready"; x.reason = if p.codex_login { "pronto".into() } else { "pronto — com a chave OpenAI da sua conta".into() }; x.detail = b.clone(); }
        Some(b) => { x.installed = true; x.state = "login"; x.reason = "instalado, mas sem login — rode `codex login` ou cole a chave OpenAI".into(); x.fixes = vec!["codex login".into()]; x.detail = b.clone(); }
        None => { x.reason = "não instalado neste computador".into(); x.fixes = vec!["npm install -g @openai/codex && codex login".into()]; }
    }
    out.push(x);
    // DeepSeek Harness (beta): binário → Node compatível → chave (erro TIPADO do dsh_check)
    let mut d = mk(AiEngine::Deepseek, "deepseek", "DeepSeek Harness (beta)".into());
    d.key_name = Some("DEEPSEEK_API_KEY");
    d.key_saved = p.deepseek_key;
    d.detail = p.dsh_bin.clone().unwrap_or_default();
    d.installed = p.dsh_bin.is_some();
    match (&p.dsh_bin, &p.dsh) {
        (None, _) | (Some(_), Err(DshIssue::Missing)) => { d.installed = false; d.reason = "não instalado neste computador".into(); d.fixes = vec!["npm i -g @deepseek-ai/dsh".into()]; }
        (Some(_), Ok(())) => { d.ready = true; d.state = "ready"; d.reason = "pronto (beta)".into(); }
        (Some(_), Err(DshIssue::Node(m))) => { d.state = "node"; d.reason = m.clone(); d.fixes = vec![node_fix_hint()]; }
        (Some(_), Err(DshIssue::Key)) => { d.state = "key"; d.reason = "instalado, falta a chave da DeepSeek — cole abaixo".into(); }
    }
    out.push(d);
    // gateway da empresa: config "Gateway próprio" (URL + chave + modelo); nome só do ALT_AI_LABEL
    let label = if p.gateway_label.trim().is_empty() { "Gateway da empresa".to_string() } else { p.gateway_label.trim().to_string() };
    let mut g = mk(AiEngine::Gateway, "gateway", label);
    match &p.gateway {
        Some(gw) => {
            g.installed = true; g.ready = true; g.state = "ready"; g.reason = "pronto".into(); g.detail = format!("{} · modelo {}", gw.base, gw.model);
            let mut ms = p.gateway_models.clone();
            ms.retain(|m| m != &gw.model);
            ms.insert(0, gw.model.clone());
            g.models = ms;
        }
        None => { g.state = "key"; g.reason = "não configurado — URL, chave e modelo ficam em Gateway próprio".into(); }
    }
    out.push(g);
    // em uso = o que as chamadas usariam entre os PRONTOS de verdade (Codex sem login não conta)
    let ready = |e: AiEngine| out.iter().any(|s| AiEngine::parse(s.id) == Some(e) && s.ready);
    let used = pick_with(pref, ready);
    for s in out.iter_mut() { s.in_use = AiEngine::parse(s.id).is_some() && AiEngine::parse(s.id) == used; }
    out
}

/// O estado real desta máquina (sem cache: "verificar de novo" vale na hora).
pub(crate) fn engines_status() -> Vec<EngineStatus> {
    clear_avail_cache();
    let some_bin = |b: String| if bin_exists(&b) { Some(b) } else { None };
    let codex = some_bin(codex_bin());
    let openai_key = llm_env_get("OPENAI_API_KEY").is_some_and(|k| !k.trim().is_empty());
    let codex_login = codex.as_deref().is_some_and(codex_logged_in);
    let models = llm_env_get("ALT_AI_MODELS").map(|m| m.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    let p = Probe {
        claude_bin: some_bin(claude_bin()),
        codex_bin: codex,
        codex_login,
        openai_key,
        gateway: gateway_cfg(),
        gateway_label: llm_env_get("ALT_AI_LABEL").unwrap_or_default(),
        gateway_models: models,
        dsh_bin: some_bin(dsh_bin()),
        dsh: dsh_check(),
        deepseek_key: dsh_key().is_some(),
    };
    engines_status_from(&pref_engine(), &p)
}

/// Resultado do "testar": a resposta curta, quanto demorou e com QUAL modelo respondeu.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTestOut {
    pub engine: String,
    pub text: String,
    pub ms: u64,
    /// modelo que respondeu ("" = padrão do motor)
    pub model: String,
    /// o modelo pedido
    pub requested: String,
    /// não deu pra usar o pedido (id inválido descartado ou recusado pela conta) — respondeu o padrão
    pub fallback: bool,
}
pub(crate) const AI_TEST_PROMPT: &str = "Responda apenas com a palavra: ok";
pub(crate) const AI_TEST_SECS: u64 = 45;

/// "testar" do painel: UMA chamada mínima FORÇANDO o motor (sem fallback — testar o Codex nunca responde pelo Claude),
/// prompt mínimo e prazo curto. Erro = a mensagem humana do próprio motor.
pub(crate) fn ai_test_run(engine: &str, model: Option<&str>) -> Result<AiTestOut, String> {
    let eng = AiEngine::parse(engine).ok_or_else(|| format!("Motor desconhecido: {engine}"))?;
    clear_avail_cache();
    if !engine_avail(eng) {
        return Err(match eng {
            AiEngine::Claude => CLAUDE_MISSING_MSG.to_string(),
            AiEngine::Codex => CODEX_MISSING_MSG.to_string(),
            AiEngine::Gateway => GATEWAY_CFG_MSG.to_string(),
            AiEngine::Deepseek => dsh_status().err().unwrap_or_else(|| DSH_MISSING_MSG.to_string()),
        });
    }
    let requested = model.map(str::trim).unwrap_or("").to_string();
    let m = model.and_then(safe_model);
    // no Claude, o modelo do teste vai no --model (o run_claude usa claude_model); nos outros, é o user_model
    let req = AiOnce { prompt: AI_TEST_PROMPT, tier: Tier::Rapido, claude_model: if eng == AiEngine::Claude { m.as_deref() } else { None }, claude_extra: &[], cwd: None, secs: AI_TEST_SECS };
    let t0 = Instant::now();
    let user_model = if eng == AiEngine::Claude { None } else { m.as_deref() };
    let (text, used) = run_on(eng, &req, user_model, Some(AI_TEST_SECS))?;
    let used = used.unwrap_or_default();
    let fallback = !requested.is_empty() && used != requested;
    Ok(AiTestOut { engine: eng.label().to_string(), text: text.chars().take(200).collect(), ms: t0.elapsed().as_millis() as u64, model: used, requested, fallback })
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
    const DSH: &str = include_str!("../../../tests/fixtures/ai-once-golden/dsh.json");
    const DSH_PATCH: &str = include_str!("../../../tests/fixtures/ai-once-golden/dsh-patch.json");

    #[test]
    fn ai_once_golden_dsh_jsonl() {
        let cases: serde_json::Value = serde_json::from_str(DSH).unwrap();
        for c in cases.as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let (text, raw) = dsh_outcome(c["jsonl"].as_str().unwrap());
            assert_eq!(text.as_deref(), c["text"].as_str(), "{name}");
            if let Some(r) = c["rawError"].as_str() { assert!(raw.as_deref().unwrap_or("").contains(r), "{name}: {raw:?}"); }
            if let Some(f) = c["friendly"].as_str() {
                let e = parse_dsh_jsonl(c["jsonl"].as_str().unwrap()).unwrap_err();
                assert!(e.contains(f) && !e.contains("{\""), "{name}: {e}");
            }
        }
        assert_eq!(dsh_plan(Tier::Rapido, None), "deepseek-flash");
        assert_eq!(dsh_plan(Tier::Capaz, None), "deepseek-v4-pro");
        assert_eq!(dsh_plan(Tier::Rapido, Some("deepseek-v4-pro")), "deepseek-v4-pro");
        assert_eq!(AiEngine::parse("deepseek"), Some(AiEngine::Deepseek));
        assert_eq!(AiEngine::parse("dsh"), Some(AiEngine::Deepseek));
        assert_eq!(user_model_for("deepseek", AiEngine::Deepseek, Some("deepseek-flash")), Some("deepseek-flash".into()));
        assert!(dsh_node_ok_v((22, 19, 0)) && dsh_node_ok_v((24, 0, 0)) && !dsh_node_ok_v((22, 18, 9)) && !dsh_node_ok_v((23, 9, 0)));
        // patches IDÊNTICOS aos do TS (mesma ordem de chaves) — golden compartilhado
        let g: serde_json::Value = serde_json::from_str(DSH_PATCH).unwrap();
        assert_eq!(dsh_base_patch(), g["base"].as_str().unwrap());
        assert_eq!(dsh_model_patch(g["model"].as_str().unwrap()), g["modelPatch"].as_str().unwrap());
        assert_eq!(dsh_plan(Tier::Capaz, Some("sonnet")), "deepseek-v4-pro", "alias do Claude nunca vai pro deepseek-official");
        assert_eq!(dsh_plan(Tier::Rapido, Some("claude-opus-5-5")), "deepseek-flash");
        assert!(dsh_version_ok("0.2.0-rc.2") && dsh_version_ok("0.2.0") && dsh_version_ok("0.2.0-rc.10") && dsh_version_ok("1.0.0") && dsh_version_ok("lixo"));
        assert!(!dsh_version_ok("0.2.0-rc.1") && !dsh_version_ok("0.1.9") && !dsh_version_ok("0.2.0-beta.5"));
        assert!(is_dsh_label("dsh-flash") && is_dsh_label("dsh:x") && is_dsh_label("DeepSeek · v4") && !is_dsh_label("dshx"));
        assert!(dsh_env_drop("OPENAI_API_KEY") && dsh_env_drop("GH_TOKEN") && dsh_env_drop("AWS_SECRET") && dsh_env_drop("CLAUDECODE") && !dsh_env_drop("DEEPSEEK_API_KEY") && !dsh_env_drop("PATH"));
        assert_eq!(dsh_args(&["/a".into()]), vec!["--patch", "/a", "--profile", "headless", "--json"]);
    }

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
            let av = Avail { claude: a["claude"].as_bool().unwrap(), codex: a["codex"].as_bool().unwrap(), gateway: a["gateway"].as_bool().unwrap(), deepseek: a["deepseek"].as_bool().unwrap_or(false) };
            let got = pick_engine(c["pref"].as_str().unwrap(), &av).map(|e| match e { AiEngine::Claude => "claude", AiEngine::Codex => "codex", AiEngine::Gateway => "gateway", AiEngine::Deepseek => "deepseek" });
            assert_eq!(got, c["expect"].as_str(), "{c}");
        }
        assert!(NO_ENGINE_MSG.contains("Claude Code") && NO_ENGINE_MSG.contains("Codex") && NO_ENGINE_MSG.contains("gateway") && NO_ENGINE_MSG.contains("@deepseek-ai/dsh"));
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
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()); // o teste do dsh mexe no env (LGCX herdada)
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

    fn probe() -> Probe {
        Probe { claude_bin: None, codex_bin: None, codex_login: false, openai_key: false, gateway: None, gateway_label: String::new(),
            gateway_models: vec![], dsh_bin: None, dsh: Err(DshIssue::Missing), deepseek_key: false }
    }
    fn st<'a>(v: &'a [EngineStatus], id: &str) -> &'a EngineStatus { v.iter().find(|s| s.id == id).unwrap() }

    #[test]
    fn sua_ia_status_disponibilidades_simuladas() {
        // nada instalado: tudo "falta", com a correção; o gateway pede configuração; nenhum em uso
        let v = engines_status_from("claude", &probe());
        assert_eq!(v.iter().map(|s| s.id).collect::<Vec<_>>(), vec!["claude", "codex", "deepseek", "gateway"]);
        assert!(v.iter().all(|s| !s.ready && !s.in_use));
        assert_eq!(st(&v, "claude").state, "install");
        assert!(st(&v, "claude").fixes[0].contains("@anthropic-ai/claude-code"));
        assert_eq!(st(&v, "codex").state, "install");
        assert_eq!(st(&v, "deepseek").fixes, vec!["npm i -g @deepseek-ai/dsh".to_string()]);
        assert_eq!(st(&v, "gateway").state, "key");
        assert!(st(&v, "claude").is_default);
        // nomes de chave certos — o app nunca pede o nome da variável
        assert_eq!(st(&v, "codex").key_name, Some("OPENAI_API_KEY"));
        assert_eq!(st(&v, "deepseek").key_name, Some("DEEPSEEK_API_KEY"));
        assert_eq!(st(&v, "claude").key_name, None);

        // Codex instalado SEM login: "falta login" com `codex login`; com a chave OpenAI no cofre → pronto
        let mut p = probe();
        p.codex_bin = Some("/x/codex".into());
        let v = engines_status_from("codex", &p);
        let x = st(&v, "codex");
        assert_eq!((x.state, x.installed, x.ready, x.fixes.clone()), ("login", true, false, vec!["codex login".to_string()]));
        assert!(x.is_default && !x.in_use, "em uso só conta motor PRONTO (sem login não está)");
        assert!(v.iter().all(|s| !s.in_use));
        p.openai_key = true;
        let v = engines_status_from("codex", &p);
        assert!(st(&v, "codex").ready && st(&v, "codex").key_saved);
        p.openai_key = false; p.codex_login = true;
        assert_eq!(st(&engines_status_from("codex", &p), "codex").state, "ready");

        // DeepSeek instalado sem chave → "falta chave"; com chave → pronto; Node velho → correção do Node
        let mut p = probe();
        p.dsh_bin = Some("/x/dsh".into());
        p.dsh = Err(DshIssue::Key);
        assert_eq!(st(&engines_status_from("deepseek", &p), "deepseek").state, "key");
        p.dsh = Err(DshIssue::Node("precisa do Node 22.19+".into()));
        let d = engines_status_from("deepseek", &p);
        assert_eq!((st(&d, "deepseek").state, st(&d, "deepseek").installed), ("node", true), "instalado, só falta atualizar o Node");
        assert_eq!(st(&d, "deepseek").fixes, vec![node_fix_hint()]);
        p.dsh = Ok(()); p.deepseek_key = true;
        let d = engines_status_from("deepseek", &p);
        assert!(st(&d, "deepseek").ready && st(&d, "deepseek").in_use && st(&d, "deepseek").key_saved);

        // gateway configurado: pronto, nome e modelos da conta; padrão claude ausente → fallback pro gateway
        let mut p = probe();
        p.gateway = Some(Gateway { base: "https://gw/v1".into(), key: "k".into(), model: "m1".into() });
        p.gateway_label = "LLM interno".into();
        p.gateway_models = vec!["m2".into(), "m1".into()];
        let v = engines_status_from("claude", &p);
        let g = st(&v, "gateway");
        assert!(g.ready && g.in_use && !g.is_default);
        assert_eq!((g.label.as_str(), g.models.clone()), ("LLM interno", vec!["m1".to_string(), "m2".to_string()]));
        assert!(!format!("{v:?}").contains("\"k\""), "a chave do gateway nunca sai no status");
        assert!(!st(&v, "claude").in_use);
        p.gateway_label = String::new();
        assert_eq!(st(&engines_status_from("claude", &p), "gateway").label, "Gateway da empresa");
        assert_eq!(st(&probe_v(), "claude").fixes, vec![CLAUDE_INSTALL_CMD.to_string()]);
        assert!(CLAUDE_MISSING_MSG.contains(CLAUDE_INSTALL_CMD));
    }
    fn probe_v() -> Vec<EngineStatus> { engines_status_from("claude", &probe()) }

    #[test]
    fn sua_ia_prazos() {
        // pisos de sempre nas chamadas normais
        assert_eq!(deadline_for(AiEngine::Codex, 20, None), 120);
        assert_eq!(deadline_for(AiEngine::Deepseek, 300, None), 300);
        assert_eq!(deadline_for(AiEngine::Gateway, 20, None), 90);
        assert_eq!(deadline_for(AiEngine::Claude, 20, None), 20);
        // "testar": prazo EXATO e curto, sem piso
        for e in [AiEngine::Codex, AiEngine::Deepseek, AiEngine::Gateway, AiEngine::Claude] { assert_eq!(deadline_for(e, 20, Some(AI_TEST_SECS)), 45); }
        assert_eq!(deadline_for(AiEngine::Codex, 20, Some(0)), 1);
    }

    #[test]
    fn sua_ia_testar_forca_o_motor_com_codex_falso() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmpdir("suaia");
        let d = tmpdir("suaia-codex");
        let bin = fake_codex(&d, false);
        let (home_s, bin_s) = (home.display().to_string(), bin.clone());
        let _env = EnvGuard::set(&[("HOME", home_s.as_str()), ("CARDUME_CODEX", bin_s.as_str())]);
        let r = ai_test_run("codex", Some("o4-mini")).unwrap();
        assert_eq!((r.engine.as_str(), r.text.as_str()), ("Codex", "resposta falsa"));
        assert_eq!((r.model.as_str(), r.fallback), ("o4-mini", false));
        let argv: Vec<String> = std::fs::read_to_string(d.join("argv.txt")).unwrap().lines().map(String::from).collect();
        assert!(argv.windows(2).any(|w| w[0] == "-m" && w[1] == "o4-mini"), "modelo escolhido no cartão: {argv:?}");
        assert!(argv.contains(&"model_reasoning_effort=\"low\"".to_string()) && argv.contains(&"sandbox_mode=\"read-only\"".to_string()));
        assert_eq!(std::fs::read_to_string(d.join("stdin.txt")).unwrap(), AI_TEST_PROMPT);
        // modelo inseguro não chega no argv
        let r = ai_test_run("codex", Some("x; rm -rf /")).unwrap();
        assert!(!std::fs::read_to_string(d.join("argv.txt")).unwrap().lines().any(|l| l == "-m"));
        assert_eq!((r.model.as_str(), r.fallback), ("", true), "id inválido descartado → respondeu o padrão, sinalizado");
        // modelo recusado pela conta → 2ª tentativa sem -m, sinalizada
        let d2 = tmpdir("suaia-refuse");
        let bin2 = fake_codex(&d2, true);
        std::env::set_var("CARDUME_CODEX", &bin2);
        let r = ai_test_run("codex", Some("modelo-recusado-suaia")).unwrap();
        assert_eq!((r.model.as_str(), r.requested.as_str(), r.fallback), ("", "modelo-recusado-suaia", true));
        let _ = std::fs::remove_dir_all(&d2);
        // motor não pronto: erro humano, sem cair noutro motor (HOME vazio = sem gateway)
        let e = ai_test_run("gateway", None).unwrap_err();
        assert_eq!(e, GATEWAY_CFG_MSG);
        assert!(ai_test_run("xyz", None).unwrap_err().contains("desconhecido"));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Estado REAL desta máquina + "testar" no motor padrão (chamada de verdade, curtinha).
    /// `cargo test sua_ia_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn sua_ia_real() {
        let v = engines_status();
        for s in &v { eprintln!("{:<9} {:<8} ready={} default={} inUse={} keySaved={} · {} · {:?}", s.id, s.state, s.ready, s.is_default, s.in_use, s.key_saved, s.reason, s.fixes); }
        if let Some(s) = v.iter().find(|s| s.ready && s.id == "codex") {
            let r = ai_test_run(s.id, None);
            eprintln!("testar {}: {r:?}", s.id);
            assert!(r.is_ok());
        }
    }

    /// dsh FALSO: grava argv, env e stdin; responde o JSONL real do headless (dsh 0.2.0-rc.2).
    fn fake_dsh(dir: &Path) -> String {
        let d = dir.display();
        let script = format!(r#"#!/bin/sh
printf '%s\n' "$@" > "{d}/argv.txt"
echo "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" > "{d}/env.txt"
echo "DSH_PERMISSION_MODE=$DSH_PERMISSION_MODE" >> "{d}/env.txt"
echo "DSH_HOME=$DSH_HOME" >> "{d}/env.txt"
echo "OPENAI_API_KEY=$OPENAI_API_KEY" >> "{d}/env.txt"
echo "LGCX_API_KEY=$LGCX_API_KEY" >> "{d}/env.txt"
echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> "{d}/env.txt"
cat > "{d}/stdin.txt"
echo '{{"type":"session","sessionId":"s1"}}'
echo '{{"type":"status","phase":"turn_end","turn":1,"reason":{{"kind":"completed"}}}}'
echo '{{"type":"final","text":" resposta do deepseek "}}'
"#);
        let p = dir.join("dsh");
        std::fs::write(&p, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.display().to_string()
    }

    #[test]
    fn ai_once_dsh_falso_so_leitura_stdin_chave_so_no_env() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _gw = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner()); // dsh_run cria temporários starfork-ai-* (o teste do gateway os conta)
        let home = tmpdir("dshhome");
        let home_s = home.display().to_string();
        let dsh_home = home.join("dsh-home").display().to_string();
        let _env = EnvGuard::set(&[("HOME", home_s.as_str()), ("CARDUME_DSH_HOME", dsh_home.as_str()), ("OPENAI_API_KEY", "herdada-openai"), ("LGCX_API_KEY", "herdada-lgcx"), ("ANTHROPIC_API_KEY", "herdada-anthropic")]);
        let d = tmpdir("dsh");
        let bin = fake_dsh(&d);
        let prompt = "um prompt \"com aspas\" e\nquebra";
        let out = dsh_run(&bin, "sk-ds-teste", &req(prompt, Tier::Capaz, None), None).unwrap();
        assert_eq!(out, "resposta do deepseek");
        let argv: Vec<String> = std::fs::read_to_string(d.join("argv.txt")).unwrap().lines().map(String::from).collect();
        assert_eq!(&argv[argv.len() - 3..], &["--profile", "headless", "--json"]);
        assert_eq!(argv[1], home.join(".constellation/dsh/starfork.patch.yml").display().to_string());
        assert!(!argv.iter().any(|a| a.contains("sk-ds") || a.contains("um prompt")), "chave e prompt fora do argv");
        assert!(!Path::new(&argv[3]).exists(), "patch por chamada (modelo) apagado");
        assert_eq!(std::fs::read_to_string(d.join("stdin.txt")).unwrap(), prompt);
        let env = std::fs::read_to_string(d.join("env.txt")).unwrap();
        assert!(env.contains("DEEPSEEK_API_KEY=sk-ds-teste") && env.contains("DSH_PERMISSION_MODE=read-only") && env.contains(&format!("DSH_HOME={dsh_home}")), "{env}");
        assert!(env.contains("OPENAI_API_KEY=\n") && env.contains("LGCX_API_KEY=\n") && env.contains("ANTHROPIC_API_KEY=\n"), "segredos herdados não chegam no dsh: {env}");
        // patch fixo 0600 e não reescrito quando igual
        let fixed = home.join(".constellation/dsh/starfork.patch.yml");
        { use std::os::unix::fs::{MetadataExt, PermissionsExt}; let m = std::fs::metadata(&fixed).unwrap(); assert_eq!(m.permissions().mode() & 0o777, 0o600);
          let ino = m.ino(); dsh_write_base_patch().unwrap(); assert_eq!(std::fs::metadata(&fixed).unwrap().ino(), ino, "igual → não reescreve");
          std::fs::write(&fixed, "").unwrap(); dsh_write_base_patch().unwrap(); assert_eq!(std::fs::read_to_string(&fixed).unwrap(), dsh_base_patch());
          assert_eq!(std::fs::metadata(&fixed).unwrap().permissions().mode() & 0o777, 0o600); }
        assert_eq!(std::fs::read_to_string(home.join(".constellation/dsh/starfork.patch.yml")).unwrap(), dsh_base_patch());
        let e = dsh_run("/nao/existe/dsh", "k", &req("x", Tier::Rapido, None), None).unwrap_err();
        assert_eq!(e, DSH_MISSING_MSG);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// dsh REAL apontado pra um servidor OpenAI-compatível FALSO local (sem custo). Pula se o dsh não estiver instalado.
    #[test]
    fn ai_once_dsh_real_servidor_falso() {
        let bin = node_tool_bin("CARDUME_DSH", "dsh");
        if !bin_exists(&bin) || !node_version(&node_bin()).is_some_and(dsh_node_ok_v) { eprintln!("dsh não instalado — pulando"); return; }
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _gw = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let srv = std::thread::spawn(move || {
            let mut n = 0;
            l.set_nonblocking(false).unwrap();
            while let Ok((mut s, _)) = l.accept() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let k = s.read(&mut chunk).unwrap_or(0);
                    if k == 0 { break; }
                    buf.extend_from_slice(&chunk[..k]);
                    let txt = String::from_utf8_lossy(&buf).to_string();
                    if let Some(i) = txt.find("\r\n\r\n") {
                        let len = txt.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if buf.len() >= i + 4 + len { break; }
                    }
                }
                n += 1;
                let c1 = r#"{"id":"c","object":"chat.completion.chunk","created":1,"model":"fake-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Filtro por data"},"finish_reason":null}]}"#;
                let c2 = r#"{"id":"c","object":"chat.completion.chunk","created":1,"model":"fake-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}"#;
                let body = format!("data: {c1}\n\ndata: {c2}\n\ndata: [DONE]\n\n");
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
                if n >= 1 { break; }
            }
            n
        });
        let home = tmpdir("dshreal");
        let prov = home.join("prov.yml");
        std::fs::write(&prov, format!("- id: llm-pi-ai\n  config:\n    providers:\n      fake:\n        apiKeyEnv: DEEPSEEK_API_KEY\n        api: openai-completions\n        baseURL: http://127.0.0.1:{port}/v1\n        compat:\n          supportsDeveloperRole: false\n          maxTokensField: max_tokens\n        models:\n          - id: fake-model\n- id: agent-default-model\n  config:\n    provider: fake\n    model: fake-model\n")).unwrap();
        let (home_s, dsh_home, prov_s) = (home.display().to_string(), home.join("dsh-home").display().to_string(), prov.display().to_string());
        let _env = EnvGuard::set(&[("HOME", home_s.as_str()), ("CARDUME_DSH_HOME", dsh_home.as_str()), ("CARDUME_DSH_PATCH", prov_s.as_str())]);
        let out = dsh_run(&bin, "sk-fake", &req("gere um título curto: filtro por data", Tier::Rapido, None), None);
        assert_eq!(out.as_deref(), Ok("Filtro por data"));
        assert_eq!(srv.join().unwrap(), 1, "uma chamada só ao modelo");
        assert!(!home.join(".dsh").exists(), "nunca o ~/.dsh");
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---------- chats de várias rodadas ----------

    fn script(dir: &Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.display().to_string()
    }
    /// Resposta do planner no formato da tela (bloco ```json).
    const PLANNER_JSON: &str = "```json\\n{\\\"say\\\":\\\"Qual o objetivo?\\\",\\\"chips\\\":[],\\\"patch\\\":{\\\"title\\\":\\\"Filtro\\\"},\\\"asking\\\":\\\"objective\\\",\\\"done\\\":false}\\n```";
    /// codex FALSO de chat: grava argv/stdin/cwd; `exec resume perdida` → erro real de sessão sumida; `sleep` → trava 30 s.
    fn fake_codex_chat(dir: &Path, sleep: bool) -> String {
        let d = dir.display();
        std::fs::write(dir.join("out.jsonl"), format!(concat!(
            "{{\"type\":\"thread.started\",\"thread_id\":\"__TID__\"}}\n",
            "{{\"type\":\"turn.started\"}}\n",
            "{{\"type\":\"item.started\",\"item\":{{\"id\":\"c1\",\"type\":\"command_execution\",\"command\":\"/bin/zsh -lc 'rg -n filtro src'\",\"status\":\"in_progress\"}}}}\n",
            "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"c1\",\"type\":\"command_execution\",\"command\":\"/bin/zsh -lc 'rg -n filtro src'\",\"exit_code\":0}}}}\n",
            "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"c2\",\"type\":\"command_execution\",\"command\":\"git log --oneline -5\",\"exit_code\":0}}}}\n",
            "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"m1\",\"type\":\"agent_message\",\"text\":\"{}\"}}}}\n",
            "{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":120,\"cached_input_tokens\":0,\"output_tokens\":30}}}}\n"), PLANNER_JSON)).unwrap();
        script(dir, "codex", &format!(r#"echo call >> "{d}/calls.log"
printf '%s\n' "$@" > "{d}/argv.txt"
pwd > "{d}/cwd.txt"
cat > "{d}/stdin.txt"
TID=th-novo
if [ "$2" = "resume" ]; then
  if [ "$3" = "perdida" ]; then echo 'Error: thread/resume: thread/resume failed: no rollout found for thread id perdida (code -32600)' >&2; exit 1; fi
  TID="$3"
fi
if [ "{sleep}" = "true" ]; then sleep 30; fi
sed "s/__TID__/$TID/" "{d}/out.jsonl"
"#))
    }
    /// Ganchos de teste: atividades num Vec, pid num slot (o "parar" do teste zera o slot e mata o grupo).
    macro_rules! hooks {
        ($acts:ident, $slot:ident, $h:ident) => {
            let $acts = Mutex::new(Vec::<String>::new());
            let act = |l: String| $acts.lock().unwrap().push(l);
            let on_start = |p: i32| $slot.store(p, Ordering::SeqCst);
            let on_end = |p: i32| { let _ = $slot.compare_exchange(p, 0, Ordering::SeqCst, Ordering::SeqCst); };
            let stopped = |p: i32| $slot.load(Ordering::SeqCst) != p;
            let $h = ChatHooks { activity: &act, on_start: &on_start, on_end: &on_end, stopped: &stopped, stop_marker: "TEST_STOPPED" };
        };
    }
    fn lines(p: PathBuf) -> Vec<String> { std::fs::read_to_string(p).unwrap().lines().map(String::from).collect() }

    #[test]
    fn chat_sessao_por_motor_e_erro_padrao() {
        // Claude: id como sempre (sem prefixo); id de outro motor → sessão perdida (o front reenvia o histórico)
        assert_eq!(sid_resume(AiEngine::Claude, Some("abc-123")), Ok(Some("abc-123".into())));
        assert_eq!(sid_resume(AiEngine::Claude, Some("codex:th1")), Err(SESSION_LOST_MSG.into()));
        assert_eq!(sid_resume(AiEngine::Claude, None), Ok(None));
        assert_eq!(sid_resume(AiEngine::Codex, Some("codex:th-1")), Ok(Some("th-1".into())));
        assert_eq!(sid_resume(AiEngine::Codex, Some("abc-123")), Err(SESSION_LOST_MSG.into()), "sessão do Claude não vai pro codex");
        assert_eq!(sid_resume(AiEngine::Codex, Some("codex:--sandbox")), Err(SESSION_LOST_MSG.into()), "nada de flag no argv");
        assert_eq!(sid_resume(AiEngine::Deepseek, Some("dsh:s1")), Ok(Some("s1".into())));
        assert_eq!(sid_resume(AiEngine::Deepseek, Some("codex:th1")), Err(SESSION_LOST_MSG.into()));
        assert_eq!(sid_resume(AiEngine::Gateway, Some(GATEWAY_SID)), Err(SESSION_LOST_MSG.into()), "gateway não guarda sessão");
        assert_eq!(sid_resume(AiEngine::Gateway, Some("")), Ok(None));
        // a MESMA regex do front (aiCallResumeSafe) casa o erro padrão; os textos crus dos motores são reconhecidos
        assert!(regex::Regex::new(r"(?i)session.*not found").unwrap().is_match(SESSION_LOST_MSG));
        assert!(session_lost_raw("Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)"));
        assert!(session_lost_raw(r#"session "s1" does not exist"#) && session_lost_raw(r#"session "s1" was recorded in /outra/pasta"#));
        assert!(session_lost_raw("No conversation found with session ID: x"));
        assert!(!session_lost_raw("429 rate limit"));
        // codex retomando: `exec resume <id>` com o sandbox por -c (resume não aceita --sandbox), prompt no stdin
        assert_eq!(codex_chat_args(Some("th1"), None), vec!["exec", "resume", "th1", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\"", "-"]);
        assert_eq!(codex_chat_args(None, Some("gpt-5")), vec!["exec", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"never\"", "-m", "gpt-5", "-"]);
        let p = chat_prompt("SISTEMA X", "oi");
        assert!(p.contains("SISTEMA X") && p.ends_with("oi") && p.contains("SÓ-LEITURA") && p.contains("FORMATO"));
    }

    #[test]
    fn chat_eventos_de_atividade_codex_e_dsh() {
        let mut seen = std::collections::HashSet::new();
        assert_eq!(codex_events(r#"{"type":"thread.started","thread_id":"th9"}"#, &mut seen), vec![ChatEv::Session("th9".into())]);
        let st = r#"{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"/bin/zsh -lc 'rg -n \"filtro\" src'"}}"#;
        assert_eq!(codex_events(st, &mut seen), vec![ChatEv::Activity("rodando rg -n \"filtro\" src".into())]);
        let done = r#"{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"x","exit_code":0}}"#;
        assert!(codex_events(done, &mut seen).is_empty(), "o mesmo comando (started + completed) aparece uma vez só");
        assert_eq!(codex_events(r#"{"type":"item.completed","item":{"id":"c2","type":"command_execution","command":["bash","-lc","ls"]}}"#, &mut seen), vec![ChatEv::Activity("rodando ls".into())]);
        assert_eq!(codex_events(r#"{"type":"item.started","item":{"id":"w","type":"web_search","query":"tauri emit"}}"#, &mut seen), vec![ChatEv::Activity("consultando tauri emit".into())]);
        assert!(codex_events(r#"{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"oi"}}"#, &mut seen).is_empty());
        assert_eq!(codex_events(r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}"#, &mut seen), vec![ChatEv::Usage(10, 3)]);
        assert!(codex_events("lixo", &mut seen).is_empty());
        // dsh: tool_call vira a MESMA frase do Claude (Read → "lendo …", grep → "procurando …")
        assert_eq!(dsh_events(r#"{"type":"session","sessionId":"s1"}"#), vec![ChatEv::Session("s1".into())]);
        assert_eq!(dsh_events(r#"{"type":"tool_call","callId":"c","tool":"read","input":{"path":"src/app/main.ts"}}"#), vec![ChatEv::Activity("lendo src/app/main.ts".into())]);
        assert_eq!(dsh_events(r#"{"type":"tool_call","callId":"c","tool":"grep","input":{"pattern":"filtro"}}"#), vec![ChatEv::Activity("procurando \"filtro\"".into())]);
        assert_eq!(dsh_events(r#"{"type":"status","phase":"step_end","usage":{"inputTokens":7,"outputTokens":2}}"#), vec![ChatEv::Usage(7, 2)]);
        assert!(dsh_events(r#"{"type":"final","text":"x"}"#).is_empty());
        // o Claude continua igual
        assert_eq!(crate::tool_line("Read", &serde_json::json!({"file_path":"/a/b/c/d.rs"})), "lendo b/c/d.rs");
    }

    #[test]
    fn chat_codex_falso_so_leitura_atividade_sessao_e_json_do_planner() {
        let d = tmpdir("chat-codex");
        let bin = fake_codex_chat(&d, false);
        let repo = tmpdir("chat-repo");
        let slot = std::sync::atomic::AtomicI32::new(0);
        hooks!(acts, slot, h);
        let t = ChatTurn { sys: "VOCÊ É O PLANNER", prompt: "quero um \"filtro\" por data", session_id: None, cwd: &repo, secs: 20 };
        let out = codex_chat(&bin, Some("sk-x"), &t, None, None, &h).unwrap();
        // 1ª rodada: sessão nova, só-leitura, prompt (instruções + mensagem) no STDIN, cwd = projeto
        let argv = lines(d.join("argv.txt"));
        assert_eq!(&argv[..2], &["exec", "--json"]);
        assert!(argv.contains(&"sandbox_mode=\"read-only\"".to_string()) && argv.contains(&"approval_policy=\"never\"".to_string()));
        assert!(!argv.iter().any(|a| a.contains("danger") || a.contains("PLANNER") || a.contains("filtro")), "{argv:?}");
        assert_eq!(argv.last().unwrap(), "-");
        let stdin = std::fs::read_to_string(d.join("stdin.txt")).unwrap();
        assert!(stdin.contains("VOCÊ É O PLANNER") && stdin.contains("quero um \"filtro\" por data"));
        assert_eq!(PathBuf::from(std::fs::read_to_string(d.join("cwd.txt")).unwrap().trim()).canonicalize().unwrap(), repo.canonicalize().unwrap());
        // linhas de atividade (uma por comando), sessão com prefixo do motor, tokens e o JSON do planner no texto final
        assert_eq!(*acts.lock().unwrap(), vec!["rodando rg -n filtro src".to_string(), "rodando git log --oneline -5".to_string()]);
        assert_eq!(out.session_id, "codex:th-novo");
        assert_eq!((out.in_tok, out.out_tok), (120, 30));
        let m = regex::Regex::new(r"(?s)```json\s*(.*?)```").unwrap().captures(&out.text).unwrap();
        let obj: serde_json::Value = serde_json::from_str(&m[1]).unwrap();
        assert_eq!((obj["say"].as_str(), obj["asking"].as_str(), obj["patch"]["title"].as_str()), (Some("Qual o objetivo?"), Some("objective"), Some("Filtro")));
        // 2ª rodada: retoma a sessão do codex
        let t2 = ChatTurn { session_id: Some(&out.session_id), ..t };
        let resume = sid_resume(AiEngine::Codex, t2.session_id).unwrap();
        let out2 = codex_chat(&bin, None, &t2, resume.as_deref(), None, &h).unwrap();
        assert_eq!(&lines(d.join("argv.txt"))[..3], &["exec", "resume", "th-novo"]);
        assert_eq!(out2.session_id, "codex:th-novo");
        // sessão sumida → erro PADRÃO (o front refaz com o histórico)
        let e = codex_chat(&bin, None, &t2, Some("perdida"), None, &h).unwrap_err();
        assert_eq!(e, SESSION_LOST_MSG);
        assert_eq!(slot.load(Ordering::SeqCst), 0, "pid sai do slot no fim");
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn chat_parar_mata_o_processo() {
        let d = tmpdir("chat-stop");
        let bin = fake_codex_chat(&d, true);
        let slot = std::sync::atomic::AtomicI32::new(0);
        let t0 = Instant::now();
        let r = std::thread::scope(|sc| {
            sc.spawn(|| {
                // o "parar" da tela: tira o pid do slot e derruba o grupo (ai_chat_stop)
                for _ in 0..100 { if slot.load(Ordering::SeqCst) > 0 { break; } std::thread::sleep(Duration::from_millis(50)); }
                std::thread::sleep(Duration::from_millis(200));
                let pid = slot.swap(0, Ordering::SeqCst);
                assert!(pid > 0);
                signal_group(pid, procsig::KILL);
            });
            hooks!(acts, slot, h);
            let t = ChatTurn { sys: "s", prompt: "p", session_id: None, cwd: &d, secs: 60 };
            let r = codex_chat(&bin, None, &t, None, None, &h);
            assert!(acts.lock().unwrap().is_empty());
            r
        });
        assert_eq!(r.unwrap_err(), "TEST_STOPPED");
        assert!(t0.elapsed() < Duration::from_secs(10), "parou na hora, não esperou o sleep 30");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn chat_dsh_falso_so_leitura_session_id_e_atividade() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _gw = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmpdir("chat-dshhome");
        let (home_s, dsh_home) = (home.display().to_string(), home.join("dsh-home").display().to_string());
        let _env = EnvGuard::set(&[("HOME", home_s.as_str()), ("CARDUME_DSH_HOME", dsh_home.as_str())]);
        let d = tmpdir("chat-dsh");
        std::fs::write(d.join("out.jsonl"), format!(concat!(
            "{{\"type\":\"session\",\"sessionId\":\"__SID__\"}}\n",
            "{{\"type\":\"tool_call\",\"callId\":\"c1\",\"tool\":\"read\",\"input\":{{\"path\":\"src/pedidos/lista.ts\"}}}}\n",
            "{{\"type\":\"tool_result\",\"callId\":\"c1\",\"status\":\"ok\",\"result\":\"...\"}}\n",
            "{{\"type\":\"status\",\"phase\":\"step_end\",\"usage\":{{\"inputTokens\":50,\"outputTokens\":9}}}}\n",
            "{{\"type\":\"status\",\"phase\":\"turn_end\",\"turn\":1,\"reason\":{{\"kind\":\"completed\"}}}}\n",
            "{{\"type\":\"final\",\"text\":\"{}\"}}\n"), PLANNER_JSON)).unwrap();
        std::fs::write(d.join("lost.jsonl"), "{\"type\":\"error\",\"message\":\"session \\\"perdida\\\" does not exist\"}\n").unwrap();
        let dd = d.display();
        let bin = script(&d, "dsh", &format!(r#"printf '%s\n' "$@" > "{dd}/argv.txt"
echo "DSH_PERMISSION_MODE=$DSH_PERMISSION_MODE" > "{dd}/env.txt"
cat > "{dd}/stdin.txt"
SID=s-novo; prev=
for a in "$@"; do if [ "$prev" = "--session-id" ]; then SID="$a"; fi; prev="$a"; done
if [ "$SID" = "perdida" ]; then cat "{dd}/lost.jsonl"; exit 1; fi
sed "s/__SID__/$SID/" "{dd}/out.jsonl"
"#));
        let slot = std::sync::atomic::AtomicI32::new(0);
        hooks!(acts, slot, h);
        let t = ChatTurn { sys: "VOCÊ É O COPILOTO", prompt: "onde mora a lista?", session_id: None, cwd: &d, secs: 20 };
        let out = dsh_chat(&bin, "sk-ds", &t, None, None, &h).unwrap();
        assert_eq!(out.session_id, "dsh:s-novo");
        assert!(out.text.contains("```json") && out.text.contains("Qual o objetivo?"));
        assert_eq!((out.in_tok, out.out_tok), (50, 9));
        assert_eq!(*acts.lock().unwrap(), vec!["lendo src/pedidos/lista.ts".to_string()]);
        assert!(std::fs::read_to_string(d.join("env.txt")).unwrap().contains("DSH_PERMISSION_MODE=read-only"));
        assert!(!lines(d.join("argv.txt")).contains(&"--session-id".to_string()), "1ª rodada: sessão nova");
        assert!(std::fs::read_to_string(d.join("stdin.txt")).unwrap().contains("VOCÊ É O COPILOTO"));
        // 2ª rodada: --session-id
        let out2 = dsh_chat(&bin, "sk-ds", &t, Some("s-novo"), None, &h).unwrap();
        let argv = lines(d.join("argv.txt"));
        assert!(argv.windows(2).any(|w| w[0] == "--session-id" && w[1] == "s-novo"), "{argv:?}");
        assert!(!argv.iter().any(|a| a.contains("sk-ds") || a.contains("onde mora")));
        assert_eq!(out2.session_id, "dsh:s-novo");
        assert_eq!(dsh_chat(&bin, "sk-ds", &t, Some("perdida"), None, &h).unwrap_err(), SESSION_LOST_MSG);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Servidor HTTP de uma requisição só: devolve `body` e entrega o que recebeu.
    fn serve_once(body: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
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
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
            String::from_utf8_lossy(&buf).to_string()
        });
        (port, h)
    }

    #[test]
    fn chat_gateway_servidor_local_sistema_mais_historico() {
        let _l = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (port, srv) = serve_once(r#"{"choices":[{"message":{"content":"```json\n{\"say\":\"ok\"}\n```"},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":5}}"#);
        let g = Gateway { base: format!("http://127.0.0.1:{port}/v1"), key: "gw-chave".into(), model: "m-chat".into() };
        let slot = std::sync::atomic::AtomicI32::new(0);
        hooks!(acts, slot, h);
        // o front (aiCallResumeSafe) põe o histórico na mensagem a cada rodada do gateway
        let prompt = "[CONTEXTO — histórico desta conversa até aqui]\nUSUÁRIO: primeira pergunta\n\nVOCÊ: primeira resposta\n[/CONTEXTO]\n\nsegunda pergunta";
        let dir = std::env::temp_dir();
        let t = ChatTurn { sys: "VOCÊ É O ORQUESTRADOR", prompt, session_id: None, cwd: &dir, secs: 10 };
        let out = gateway_chat(&g, &t, &h).unwrap();
        assert_eq!(out.text, "```json\n{\"say\":\"ok\"}\n```");
        assert_eq!((out.session_id.as_str(), out.in_tok, out.out_tok), (GATEWAY_SID, 40, 5));
        assert!(acts.lock().unwrap().is_empty(), "gateway sem ferramentas: sem linhas de atividade");
        let got = srv.join().unwrap();
        let body: serde_json::Value = serde_json::from_str(&got[got.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "VOCÊ É O ORQUESTRADOR");
        assert_eq!(body["messages"][1]["role"], "user");
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("primeira pergunta") && user.contains("primeira resposta") && user.ends_with("segunda pergunta"), "histórico reenviado");
        assert!(body.get("tools").is_none(), "nenhuma ferramenta");
        assert!(got.contains("Authorization: Bearer gw-chave"));
        // resposta fora do formato continua sendo só texto (a tela recupera como hoje); falha de rede → erro humano
        let e = gateway_chat(&Gateway { base: "http://127.0.0.1:9/v1".into(), key: "k".into(), model: "m".into() }, &t, &h).unwrap_err();
        assert!(e.contains("Não consegui falar com o gateway"), "{e}");
    }

    /// IA padrão Codex numa máquina "sem Claude": os chats vão pro Codex e NENHUM processo claude é iniciado.
    #[test]
    fn chat_ia_padrao_codex_nao_inicia_claude() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmpdir("chat-pick");
        std::fs::create_dir_all(home.join(".constellation")).unwrap();
        std::fs::write(home.join(".constellation/settings.json"), r#"{"aiEngine":"codex"}"#).unwrap();
        let d = tmpdir("chat-pick-bin");
        let codex = fake_codex_chat(&d, false);
        let claude = script(&d, "claude", &format!("echo call >> \"{}/claude.log\"\n", d.display()));
        let (home_s, codex_s, claude_s) = (home.display().to_string(), codex.clone(), claude.clone());
        let _env = EnvGuard::set(&[("HOME", home_s.as_str()), ("CARDUME_CODEX", codex_s.as_str()), ("CARDUME_CLAUDE", claude_s.as_str()), ("DEEPSEEK_API_KEY", "")]);
        assert_eq!(chat_engine(), Ok(AiEngine::Codex), "segue a IA padrão mesmo com o claude instalado");
        let slot = std::sync::atomic::AtomicI32::new(0);
        hooks!(acts, slot, h);
        let t = ChatTurn { sys: "PLANNER", prompt: "oi", session_id: None, cwd: &d, secs: 20 };
        let out = chat_turn(AiEngine::Codex, &t, &h).unwrap();
        assert_eq!(out.session_id, "codex:th-novo");
        assert!(!acts.lock().unwrap().is_empty());
        assert!(!d.join("claude.log").exists(), "nenhum processo claude");
        // IA padrão Claude disponível → Claude (o caminho de antes); Claude ausente → cai no Codex
        std::fs::write(home.join(".constellation/settings.json"), r#"{"aiEngine":"claude"}"#).unwrap();
        clear_avail_cache();
        assert_eq!(chat_engine(), Ok(AiEngine::Claude));
        std::env::set_var("CARDUME_CLAUDE", "/nao/existe/claude");
        clear_avail_cache();
        assert_eq!(chat_engine(), Ok(AiEngine::Codex));
        // DeepSeek nunca é fallback automático: escolhido mas sem dsh pronto → codex
        std::fs::write(home.join(".constellation/settings.json"), r#"{"aiEngine":"deepseek"}"#).unwrap();
        clear_avail_cache();
        assert_eq!(chat_engine(), Ok(AiEngine::Codex));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// dsh REAL contra um servidor OpenAI-compatível FALSO local: um turno do planner e o 2º com --session-id (o
    /// histórico da sessão vai junto pro modelo). Pula se o dsh não estiver instalado.
    #[test]
    fn chat_dsh_real_servidor_falso_retoma_sessao() {
        let bin = node_tool_bin("CARDUME_DSH", "dsh");
        if !bin_exists(&bin) || !node_version(&node_bin()).is_some_and(dsh_node_ok_v) { eprintln!("dsh não instalado — pulando"); return; }
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _gw = GW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let srv = std::thread::spawn(move || {
            let mut bodies = vec![];
            while bodies.len() < 2 {
                let Ok((mut s, _)) = l.accept() else { break };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let k = s.read(&mut chunk).unwrap_or(0);
                    if k == 0 { break; }
                    buf.extend_from_slice(&chunk[..k]);
                    let txt = String::from_utf8_lossy(&buf).to_string();
                    if let Some(i) = txt.find("\r\n\r\n") {
                        let len = txt.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if buf.len() >= i + 4 + len { break; }
                    }
                }
                bodies.push(String::from_utf8_lossy(&buf).to_string());
                let say = if bodies.len() == 1 { "```json\\n{\\\"say\\\":\\\"Qual a tela?\\\",\\\"chips\\\":[],\\\"patch\\\":{},\\\"asking\\\":\\\"objective\\\",\\\"done\\\":false}\\n```" } else { "segunda resposta" };
                let c1 = format!(r#"{{"id":"c","object":"chat.completion.chunk","created":1,"model":"fake-model","choices":[{{"index":0,"delta":{{"role":"assistant","content":"{say}"}},"finish_reason":null}}]}}"#);
                let c2 = r#"{"id":"c","object":"chat.completion.chunk","created":1,"model":"fake-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}"#;
                let body = format!("data: {c1}\n\ndata: {c2}\n\ndata: [DONE]\n\n");
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
            }
            bodies
        });
        let home = tmpdir("chat-dshreal");
        let repo = tmpdir("chat-dshreal-repo");
        let prov = home.join("prov.yml");
        std::fs::write(&prov, format!("- id: llm-pi-ai\n  config:\n    providers:\n      fake:\n        apiKeyEnv: DEEPSEEK_API_KEY\n        api: openai-completions\n        baseURL: http://127.0.0.1:{port}/v1\n        compat:\n          supportsDeveloperRole: false\n          maxTokensField: max_tokens\n        models:\n          - id: fake-model\n- id: agent-default-model\n  config:\n    provider: fake\n    model: fake-model\n")).unwrap();
        let (home_s, dsh_home, prov_s) = (home.display().to_string(), home.join("dsh-home").display().to_string(), prov.display().to_string());
        let _env = EnvGuard::set(&[("HOME", home_s.as_str()), ("CARDUME_DSH_HOME", dsh_home.as_str()), ("CARDUME_DSH_PATCH", prov_s.as_str())]);
        let slot = std::sync::atomic::AtomicI32::new(0);
        hooks!(acts, slot, h);
        let t = ChatTurn { sys: "VOCÊ É O PLANNER", prompt: "quero um filtro por data", session_id: None, cwd: &repo, secs: 60 };
        let out = dsh_chat(&bin, "sk-fake", &t, None, None, &h).unwrap();
        assert!(out.text.contains("Qual a tela?"), "{out:?}");
        assert!(out.session_id.starts_with("dsh:") && out.session_id.len() > 4, "{out:?}");
        let resume = sid_resume(AiEngine::Deepseek, Some(&out.session_id)).unwrap();
        let t2 = ChatTurn { prompt: "a tela de pedidos", session_id: Some(&out.session_id), ..t };
        let out2 = dsh_chat(&bin, "sk-fake", &t2, resume.as_deref(), None, &h).unwrap();
        assert_eq!(out2.text, "segunda resposta");
        assert_eq!(out2.session_id, out.session_id, "mesma sessão");
        let bodies = srv.join().unwrap();
        assert!(bodies[1].contains("quero um filtro por data") && bodies[1].contains("a tela de pedidos"), "a 2ª rodada leva a 1ª (sessão retomada)");
        assert!(acts.lock().unwrap().is_empty());
        assert!(!home.join(".dsh").exists(), "nunca o ~/.dsh");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// REAL (codex desta máquina com login; dsh com servidor falso): um turno do planner e um do chat do projeto, SEM claude.
    /// `cargo test chat_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn chat_real_codex_sem_claude() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let real_home = std::env::var("HOME").unwrap();
        let tmp = tmpdir("chat-real");
        std::fs::create_dir_all(tmp.join(".constellation")).unwrap();
        std::fs::write(tmp.join(".constellation/settings.json"), r#"{"aiEngine":"codex","aiModel":""}"#).unwrap();
        let codex_home = format!("{real_home}/.codex");
        let tmp_s = tmp.display().to_string();
        let _env = EnvGuard::set(&[("CODEX_HOME", codex_home.as_str()), ("HOME", tmp_s.as_str()), ("CARDUME_CLAUDE", "/nao/existe/claude")]);
        assert_eq!(chat_engine(), Ok(AiEngine::Codex));
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let acts = Mutex::new(Vec::<String>::new());
        let act = |l: String| { eprintln!("  · {l}"); acts.lock().unwrap().push(l); };
        let nop = |_: i32| {};
        let no = |_: i32| false;
        let h = ChatHooks { activity: &act, on_start: &nop, on_end: &nop, stopped: &no, stop_marker: "X" };
        let sys = "Você é o PLANNER. Responda SEMPRE E SOMENTE com um bloco ```json {\"say\":\"\",\"chips\":[],\"patch\":{},\"asking\":\"\",\"done\":false}. Leia o código antes (só-leitura).";
        let t0 = Instant::now();
        let out = chat_turn(AiEngine::Codex, &ChatTurn { sys, prompt: "Quero um teste para a função tool_line em src/lib.rs. Leia-a e pergunte o objetivo.", session_id: None, cwd: &repo, secs: 300 }, &h);
        eprintln!("planner codex ({:?}): {out:?}", t0.elapsed());
        let out = out.unwrap();
        assert!(out.session_id.starts_with("codex:") && out.text.contains('{'));
        let out2 = chat_turn(AiEngine::Codex, &ChatTurn { sys: "Você é o copiloto do projeto. Responda curto.", prompt: "Em que arquivo está a função tool_line?", session_id: Some(&out.session_id), cwd: &repo, secs: 300 }, &h);
        eprintln!("chat do projeto codex (retomado): {out2:?}");
        assert!(out2.is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
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
