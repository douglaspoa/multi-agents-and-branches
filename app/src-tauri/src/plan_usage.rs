//! MEDIDOR DO PLANO (widget do menu lateral): quanto já foi usado do plano de cada IA configurada.
//! Só fontes documentadas ou arquivos locais da própria pessoa — e nada sai desta máquina:
//! - Claude → `~/.constellation/usage/claude-<rateLimitType>.json` (o último `rate_limit_event` de CADA janela, um
//!   arquivo por janela — gravado pelo motor TS (src/engine/claude.ts) e pelos chats stream-json do app
//!   (run_claude_stream → record_claude_rate_limit), formato fixado por tests/fixtures/plan-usage-golden/) + o uso que
//!   o Starfork registrou nas últimas 5 h NESTE projeto (tabela `cost`, atribuída pelo motor do papel).
//!   Porcentagem SÓ quando o evento trouxe `utilization` (o Claude Code manda perto do limite) — nunca inventada.
//!   + a % REAL das janelas de 5 h e da semana pela barra de status do Claude Code (opcional, interruptor em Sua IA):
//!   `~/.constellation/usage/claude-statusline.json` `{fiveHour:{pct,resetsAt}, sevenDay, at}`, gravado pelo script que
//!   o CLI `cardume claude-statusline install` instala (src/claude-statusline.ts — fonte única). Janela que já
//!   reiniciou → 0 %; `rate_limit_event` MAIS NOVO que o arquivo com rejected/allowed_warning → o estado prevalece.
//!   NUNCA chama /api/oauth/usage nem lê o token do Keychain.
//! - Codex → a última linha `token_count` COM rate_limits das sessões mais novas em
//!   `$CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl` (só a cauda; no máximo 2 arquivos). Nunca lê `auth.json`.
//! - DeepSeek → `GET https://api.deepseek.com/user/balance` com a chave do llm.env (cabeçalho em arquivo 0600,
//!   nunca no argv), prazo curto, cache de 2 min por chave e uma busca por vez. O valor da chave nunca sai daqui.
//! O comando é async (roda fora da thread da janela) — o front chama no boot, no fim de turno e a cada 2 min.
use super::*;
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StarforkUse {
    pub turns: i64,
    pub in_tok: i64,
    pub out_tok: i64,
    pub ms: i64,
}

/// Uma janela do Claude pela barra de status (% real).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeWin {
    /// 0–100 (já reiniciou → 0)
    pub pct: f64,
    /// epoch ms
    pub resets_at: Option<i64>,
    /// a janela já reiniciou desde a gravação
    pub reset: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeUsage {
    /// ok | warn (perto do limite) | blocked (limite atingido) | none (o Claude Code ainda não mandou estado)
    pub state: &'static str,
    /// five_hour | seven_day | seven_day_opus | seven_day_sonnet | overage
    pub window: Option<String>,
    /// 0–100, só quando o evento trouxe `utilization`
    pub pct: Option<f64>,
    /// epoch ms
    pub resets_at: Option<i64>,
    /// o que o Starfork registrou nas últimas 5 h NESTE projeto (projeto ativo)
    pub starfork: StarforkUse,
    /// não deu pra ler o uso do Starfork (o widget mostra "uso do Starfork indisponível")
    pub starfork_error: Option<String>,
    /// % real das janelas pela barra de status do Claude Code (None = sem o arquivo / janela não veio)
    pub five_hour: Option<ClaudeWin>,
    pub seven_day: Option<ClaudeWin>,
    /// quando a barra de status gravou (epoch ms) — "atualizado há X"
    pub updated_at: Option<i64>,
    /// a barra de status do Starfork está instalada no Claude Code (dica "ative a % do Claude em Sua IA")
    pub statusline: bool,
    /// instalada e AINDA sem o arquivo de dados: desde quando (epoch ms, instalação) — > 30 min = plano sem % (API)
    pub statusline_waiting_since: Option<i64>,
    /// quando o Claude Code mandou o rate_limit_event escolhido (só pra mesclar com a barra; não vai pro front)
    #[serde(skip)]
    pub event_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexWindow {
    pub used_percent: f64,
    pub window_minutes: i64,
    /// epoch ms
    pub resets_at: Option<i64>,
    /// a janela já reiniciou desde a última leitura (o uso mostrado vira 0)
    pub reset: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexUsage {
    pub has_data: bool,
    pub plan: Option<String>,
    pub primary: Option<CodexWindow>,
    pub secondary: Option<CodexWindow>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Balance {
    pub currency: String,
    pub total: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepseekUsage {
    pub ok: bool,
    pub available: bool,
    pub balances: Vec<Balance>,
}

/// Gasto de uma IA no mês (livro de uso ~/.constellation/usage/usage.sqlite) — a linha do medidor quando não há %
/// (sem barra de status, Codex sem sessão, DeepSeek sem rede): "uso deste mês: US$ 3,20 · 14 tarefas".
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonthUse {
    pub usd: f64,
    /// tarefas distintas (task_id) com gasto no mês
    pub tasks: i64,
    /// chamadas registradas (tarefas + nova demanda + retro + …)
    pub calls: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanUsage {
    /// IA padrão do usuário (aiEngine)
    pub default_engine: String,
    /// IAs prontas COM fonte de medição (claude, codex, deepseek), na ordem do painel
    pub configured: Vec<&'static str>,
    pub claude: Option<ClaudeUsage>,
    pub codex: Option<CodexUsage>,
    pub deepseek: Option<DeepseekUsage>,
    /// gasto do mês por IA (claude | codex | deepseek | gateway) desde `monthSince` — sempre presente; vazio = nada no livro
    pub month: std::collections::BTreeMap<String, MonthUse>,
    /// início do mês (epoch ms, meia-noite local do dia 1 — mandado pelo front)
    pub month_since: i64,
    /// não deu pra ler o livro de uso (o medidor só esconde a linha do mês)
    pub month_error: Option<String>,
}

/// Soma o livro desde `since` por IA (id do motor normalizado: codex/deepseek/gateway/claude).
pub(crate) fn month_use(ledger: &Path, since: i64) -> Result<std::collections::BTreeMap<String, MonthUse>, String> {
    let rows = usage_ledger::ledger_rows(ledger, since, None, None)?;
    let mut out: std::collections::BTreeMap<String, MonthUse> = Default::default();
    let mut tasks: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    for r in rows {
        let e = usage_ledger::norm_engine(&r.engine);
        let m = out.entry(e.clone()).or_default();
        m.usd += r.usd;
        m.calls += 1;
        if let Some(t) = r.task_id.as_deref().filter(|t| !t.trim().is_empty()) {
            tasks.entry(e).or_default().insert(t.to_string());
        }
    }
    for (e, m) in out.iter_mut() {
        m.usd = (m.usd * 100.0).round() / 100.0;
        m.tasks = tasks.get(e).map(|s| s.len() as i64).unwrap_or(0);
    }
    Ok(out)
}

/// Meia-noite do dia 1 (aproximação em UTC) — só quando o front não manda o início do mês local.
pub(crate) fn month_start_utc(now: i64) -> i64 {
    let days = now.div_euclid(86_400_000);
    // civil-from-days (Howard Hinnant) → dia do mês
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    (days - (d - 1)) * 86_400_000
}

const FIVE_H_MS: i64 = 5 * 3600 * 1000;

/// epoch em segundos OU ms → ms
fn epoch_ms(v: &Value) -> Option<i64> {
    let n = v.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(if n < 1e12 { (n * 1000.0) as i64 } else { n as i64 })
}

/// Escrita atômica: tmp único na mesma pasta + rename.
fn write_atomic(file: &Path, body: &str) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = file.with_extension(format!("json.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, file).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })
}

// ---------- Claude: registro (mesmo formato do motor TS) ----------

pub(crate) fn claude_usage_dir() -> PathBuf {
    PathBuf::from(home_dir_s()).join(".constellation").join("usage")
}

/// `rate_limit_event` → (janela, conteúdo do arquivo). None: não é o evento, status desconhecido ou SEM janela
/// (não chuta five_hour). Mesma regra do `rateLimitOf`/`rateLimitRecord` do TS (golden compartilhado).
pub(crate) fn rate_limit_record(v: &Value, now: i64) -> Option<(String, Value)> {
    if v.get("type")?.as_str()? != "rate_limit_event" { return None; }
    let i = v.get("rate_limit_info")?;
    let status = i.get("status")?.as_str()?;
    if !matches!(status, "allowed" | "allowed_warning" | "rejected") { return None; }
    let kind = i.get("rateLimitType")?.as_str()?;
    if kind.is_empty() || kind.len() > 40 || !kind.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') { return None; }
    let mut r = serde_json::json!({ "v": 1, "rateLimitType": kind, "status": status, "at": now });
    if let Some(x) = i.get("resetsAt").filter(|x| x.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)) { r["resetsAt"] = x.clone(); }
    if let Some(x) = i.get("utilization").filter(|x| x.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)) { r["utilization"] = x.clone(); }
    Some((kind.to_string(), r))
}

/// Grava `<dir>/claude-<janela>.json` (um arquivo por janela: processos diferentes não se atropelam). Nunca falha alto.
pub(crate) fn record_claude_rate_limit(v: &Value, dir: &Path, now: i64) {
    let Some((kind, rec)) = rate_limit_record(v, now) else { return };
    let _ = std::fs::create_dir_all(dir);
    let _ = write_atomic(&dir.join(format!("claude-{kind}.json")), &rec.to_string());
}

/// Junta os arquivos por janela → `{ "windows": { tipo: registro } }` (a entrada do claude_summary).
pub(crate) fn read_claude_windows(dir: &Path) -> Value {
    let mut w = serde_json::Map::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(kind) = name.strip_prefix("claude-").and_then(|n| n.strip_suffix(".json")) else { continue };
        let Some(rec) = std::fs::read_to_string(e.path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
        if rec.get("rateLimitType").and_then(|t| t.as_str()) != Some(kind) { continue; }
        w.insert(kind.to_string(), rec);
    }
    serde_json::json!({ "windows": w })
}

// ---------- Claude: resumo ----------

/// `utilization` vem 0–1; se já vier em porcentagem (> 1), usa como está. Sempre 0–100, 1 casa.
fn util_pct(u: f64) -> f64 {
    let p = if u <= 1.0 { u * 100.0 } else { u };
    (p.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

/// Monta o resumo do Claude a partir das janelas gravadas (pode faltar) e do uso registrado pelo Starfork.
/// Janelas já reiniciadas (resetsAt no passado) ou velhas (> 5 h sem reinício conhecido) não contam mais.
/// Prioridade: bloqueado > perto do limite (maior utilization) > janela de 5 h > qualquer outra.
pub(crate) fn claude_summary(file: Option<&Value>, now: i64, starfork: Result<StarforkUse, String>) -> ClaudeUsage {
    struct W { kind: String, status: String, resets: Option<i64>, util: Option<f64>, at: i64 }
    let mut ws: Vec<W> = vec![];
    if let Some(map) = file.and_then(|f| f.get("windows")).and_then(|w| w.as_object()) {
        for (kind, w) in map {
            let status = w.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if !matches!(status.as_str(), "allowed" | "allowed_warning" | "rejected") { continue; }
            let resets = w.get("resetsAt").and_then(epoch_ms);
            let at = w.get("at").and_then(epoch_ms).unwrap_or(0);
            let live = match resets { Some(r) => r > now, None => now - at < FIVE_H_MS };
            if !live { continue; }
            let util = w.get("utilization").and_then(|u| u.as_f64()).filter(|u| u.is_finite() && *u >= 0.0);
            ws.push(W { kind: kind.clone(), status, resets, util, at });
        }
    }
    let pick = ws.iter().filter(|w| w.status == "rejected").max_by_key(|w| w.resets.unwrap_or(0))
        .or_else(|| ws.iter().filter(|w| w.status == "allowed_warning").max_by(|a, b| a.util.unwrap_or(0.0).total_cmp(&b.util.unwrap_or(0.0))))
        .or_else(|| ws.iter().find(|w| w.kind == "five_hour"))
        .or_else(|| ws.first());
    let (sf, sf_err) = match starfork { Ok(s) => (s, None), Err(e) => (StarforkUse::default(), Some(e)) };
    match pick {
        None => ClaudeUsage {
            state: "none", window: None, pct: None, resets_at: None, starfork: sf, starfork_error: sf_err,
            five_hour: None, seven_day: None, updated_at: None, statusline: false, statusline_waiting_since: None, event_at: None,
        },
        Some(w) => ClaudeUsage {
            state: match w.status.as_str() { "rejected" => "blocked", "allowed_warning" => "warn", _ => "ok" },
            window: Some(w.kind.clone()),
            pct: w.util.map(util_pct),
            resets_at: w.resets,
            starfork: sf,
            starfork_error: sf_err,
            five_hour: None, seven_day: None, updated_at: None, statusline: false, statusline_waiting_since: None,
            event_at: Some(w.at).filter(|a| *a > 0),
        },
    }
}

// ---------- Claude: barra de status (% real) ----------

const SEVEN_D_MS: i64 = 7 * 24 * 3600 * 1000;

/// Pasta de config do Claude Code: `CLAUDE_CONFIG_DIR` (como o próprio Claude Code), senão `~/.claude`.
/// MESMA regra do TS (src/claude-statusline.ts: claudeConfigDir).
pub(crate) fn claude_config_dir() -> PathBuf {
    std::env::var("CLAUDE_CONFIG_DIR").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home_dir_s()).join(".claude"))
}

/// A barra instalada aponta pra um node que sumiu e a reinstalação do boot falhou → o cartão do Claude avisa.
pub(crate) static SL_REPAIR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `claude-statusline.json` → (5 h, semana, quando gravou). None: sem `at` (não dá pra saber se é velho) ou sem
/// nenhuma janela legível. Janela com `resetsAt` passado → 0 %; SEM `resetsAt`, some quando o arquivo é mais velho
/// que a própria janela (5 h / 7 d). % sempre 0–100. Formato fixado por tests/fixtures/plan-usage-golden/statusline.json.
pub(crate) fn statusline_windows(sl: &Value, now: i64) -> Option<(Option<ClaudeWin>, Option<ClaudeWin>, i64)> {
    let at = sl.get("at").and_then(epoch_ms)?;
    let win = |k: &str, span: i64| -> Option<ClaudeWin> {
        let w = sl.get(k)?;
        let pct = w.get("pct")?.as_f64().filter(|p| p.is_finite())?;
        let resets_at = w.get("resetsAt").and_then(epoch_ms);
        if resets_at.is_none() && now - at > span { return None; }
        let reset = resets_at.is_some_and(|r| r <= now);
        Some(ClaudeWin { pct: if reset { 0.0 } else { (pct.clamp(0.0, 100.0) * 10.0).round() / 10.0 }, resets_at, reset })
    };
    let (f, s) = (win("fiveHour", FIVE_H_MS), win("sevenDay", SEVEN_D_MS));
    if f.is_none() && s.is_none() { return None; }
    Some((f, s, at))
}

/// Mescla a barra de status no resumo do evento. A barra manda nas porcentagens; o estado do evento prevalece quando:
/// bloqueado (`rejected`) com a volta ainda no futuro — ou mais novo que a barra; perto do limite (`allowed_warning`)
/// — a menos que a barra mostre aquela janela abaixo de 70 %. Destaque (window/pct/resetsAt) = a janela mais cheia
/// (empate → 5 h).
/// Barra de status mais velha que isso não decide o estado nem a % (o front mostra o gasto do mês).
pub(crate) const SL_OLD_MS: i64 = 12 * 3600 * 1000;

pub(crate) fn with_statusline(mut c: ClaudeUsage, sl: Option<&Value>, now: i64) -> ClaudeUsage {
    let Some((f, s, at)) = sl.and_then(|v| statusline_windows(v, now)) else { return c };
    c.five_hour = f;
    c.seven_day = s;
    c.updated_at = Some(at);
    // gravada há mais de 12 h (o Claude Code interativo não rodou desde então): a % é de outra janela — o resumo
    // fica com o rate_limit_event; as janelas vão junto só pro front explicar ("a % é de há X")
    if now - at > SL_OLD_MS { return c; }
    let file_pct = match c.window.as_deref() {
        Some("five_hour") => c.five_hour.as_ref().map(|w| w.pct),
        Some("seven_day") => c.seven_day.as_ref().map(|w| w.pct),
        _ => None,
    };
    let keep = match c.state {
        "blocked" => c.resets_at.is_some_and(|r| r > now) || c.event_at.is_some_and(|e| e > at),
        "warn" => file_pct.is_none_or(|p| p >= 70.0),
        _ => false,
    };
    if keep {
        if c.pct.is_none() { c.pct = file_pct; }
        return c;
    }
    let top = [("seven_day", &c.seven_day), ("five_hour", &c.five_hour)].into_iter()
        .filter_map(|(k, w)| w.as_ref().map(|w| (k, w.clone())))
        .max_by(|a, b| a.1.pct.total_cmp(&b.1.pct));
    if let Some((k, w)) = top {
        c.state = "ok";
        c.window = Some(k.to_string());
        c.pct = Some(w.pct);
        c.resets_at = w.resets_at;
    }
    c
}

fn statusline_cmd(settings: &str) -> Option<String> {
    serde_json::from_str::<Value>(settings).ok()?
        .get("statusLine")?.get("command")?.as_str().map(String::from)
}

/// O `statusLine` do settings.json do Claude Code é o do Starfork? MESMA regra do `isOurs` do TS
/// (src/claude-statusline.ts): o comando aponta pro claude-statusline.mjs. Golden: statusline.json.
pub(crate) fn statusline_installed_in(settings: &str) -> bool {
    statusline_cmd(settings).is_some_and(|c| c.contains("claude-statusline.mjs"))
}

/// 1º argumento do comando (o node): entre aspas (com \x → x) ou até o 1º espaço. MESMA regra do `nodeOfCommand` do TS.
pub(crate) fn node_of_command(cmd: &str) -> Option<String> {
    let t = cmd.trim_start();
    let mut it = t.chars();
    match it.next()? {
        '"' => {
            let mut out = String::new();
            while let Some(ch) = it.next() {
                match ch {
                    '\\' => out.push(it.next()?),
                    '"' => return Some(out),
                    _ => out.push(ch),
                }
            }
            None
        }
        _ => t.split_whitespace().next().map(String::from),
    }
}

/// Node gravado no comando da barra do Starfork (None: não instalada).
pub(crate) fn statusline_node_in(settings: &str) -> Option<String> {
    if !statusline_installed_in(settings) { return None; }
    node_of_command(&statusline_cmd(settings)?)
}

fn read_settings_in(claude_dir: &Path) -> Option<String> { std::fs::read_to_string(claude_dir.join("settings.json")).ok() }

pub(crate) fn statusline_installed_at(claude_dir: &Path) -> bool { read_settings_in(claude_dir).is_some_and(|s| statusline_installed_in(&s)) }

pub(crate) fn statusline_installed() -> bool { statusline_installed_at(&claude_config_dir()) }

/// Barra instalada cujo node sumiu (nvm removeu a versão…)? → Some(node antigo). O boot reinstala com o node atual.
pub(crate) fn statusline_node_missing(claude_dir: &Path) -> Option<String> {
    let n = statusline_node_in(&read_settings_in(claude_dir)?)?;
    (!Path::new(&n).is_file()).then_some(n)
}

/// Saída do `cardume claude-statusline … --json` → o objeto, ou o erro humano.
pub(crate) fn parse_statusline_cli(stdout: &str, stderr: &str) -> Result<Value, String> {
    let v = stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(|v| v.is_object()));
    match v {
        Some(v) if v.get("ok").and_then(|o| o.as_bool()) == Some(true) => Ok(v),
        Some(v) => Err(v.get("message").and_then(|m| m.as_str()).unwrap_or("não consegui mexer na barra de status").to_string()),
        None => {
            let e = stderr.trim();
            Err(if e.is_empty() { "o motor não respondeu".to_string() } else { e.chars().take(400).collect() })
        }
    }
}

/// Motor que rodou um turno: o do PAPEL (roles_json, por nome do agente e depois pelo papel), senão o da tarefa,
/// senão a IA padrão das configurações.
pub(crate) fn cost_engine(agent: &str, role: Option<&str>, roles_json: &str, task_engine: &str, default_engine: &str) -> String {
    let roles: Vec<Value> = serde_json::from_str(roles_json).unwrap_or_default();
    let by = roles.iter().find(|r| r.get("name").and_then(|n| n.as_str()) == Some(agent))
        .or_else(|| role.and_then(|ro| roles.iter().find(|r| r.get("role").and_then(|n| n.as_str()) == Some(ro))));
    by.and_then(|r| r.get("engine")).and_then(|e| e.as_str()).map(str::trim).filter(|s| !s.is_empty())
        .or_else(|| Some(task_engine.trim()).filter(|s| !s.is_empty()))
        .unwrap_or(default_engine)
        .to_string()
}

/// Turnos do CLAUDE gravados no `cost` desde `since` (só linhas com tarefa; motor atribuído por cost_engine).
/// Banco antigo sem a coluna `ms` soma sem o tempo; qualquer outro erro sobe.
pub(crate) fn starfork_claude_use(db: &Path, since: i64, default_engine: &str) -> Result<StarforkUse, String> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(Duration::from_millis(2000));
    let run = |ms: &str| -> rusqlite::Result<StarforkUse> {
        let sql = format!(
            "SELECT c.agent, c.role, c.in_tok, c.out_tok, {ms}, t.engine, t.roles_json FROM cost c JOIN task t ON t.id = c.task_id WHERE c.created_at >= ?1"
        );
        let mut st = conn.prepare(&sql)?;
        let mut rows = st.query([since])?;
        let mut u = StarforkUse::default();
        while let Some(r) = rows.next()? {
            let agent: String = r.get::<_, Option<String>>(0)?.unwrap_or_default();
            let role: Option<String> = r.get(1)?;
            let eng: String = r.get::<_, Option<String>>(5)?.unwrap_or_default();
            let roles: String = r.get::<_, Option<String>>(6)?.unwrap_or_default();
            if ai_once::AiEngine::parse(&cost_engine(&agent, role.as_deref(), &roles, &eng, default_engine)) != Some(ai_once::AiEngine::Claude) { continue; }
            u.turns += 1;
            u.in_tok += r.get::<_, Option<i64>>(2)?.unwrap_or(0);
            u.out_tok += r.get::<_, Option<i64>>(3)?.unwrap_or(0);
            u.ms += r.get::<_, Option<i64>>(4)?.unwrap_or(0);
        }
        Ok(u)
    };
    match run("c.ms") {
        Ok(u) => Ok(u),
        Err(e) if e.to_string().contains("no such column: c.ms") => run("0").map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- Codex ----------

fn codex_window(v: &Value, now: i64) -> Option<CodexWindow> {
    let used = v.get("used_percent")?.as_f64()?;
    let resets_at = v.get("resets_at").and_then(epoch_ms);
    let reset = resets_at.is_some_and(|r| r <= now);
    Some(CodexWindow {
        used_percent: if reset { 0.0 } else { used },
        window_minutes: v.get("window_minutes").and_then(|m| m.as_i64()).unwrap_or(0),
        resets_at,
        reset,
    })
}

/// UMA linha do rollout → uso (None se a linha não for um `token_count`).
pub(crate) fn codex_from_line(line: &str, now: i64) -> Option<CodexUsage> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let p = v.get("payload")?;
    if p.get("type")?.as_str()? != "token_count" { return None; }
    let rl = p.get("rate_limits").filter(|r| r.is_object());
    let Some(rl) = rl else { return Some(CodexUsage::default()) };
    let primary = rl.get("primary").and_then(|w| codex_window(w, now));
    let secondary = rl.get("secondary").and_then(|w| codex_window(w, now));
    let plan = rl.get("plan_type").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).map(String::from);
    Some(CodexUsage { has_data: primary.is_some() || secondary.is_some(), plan, primary, secondary })
}

/// Cauda do arquivo → a ÚLTIMA linha `token_count` que TEM rate_limits (sem nenhuma → sem dados).
pub(crate) fn codex_from_tail(text: &str, now: i64) -> CodexUsage {
    text.lines().rev().filter(|l| l.contains("\"token_count\""))
        .filter_map(|l| codex_from_line(l, now)).find(|u| u.has_data).unwrap_or_default()
}

fn codex_home() -> PathBuf {
    std::env::var("CODEX_HOME").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home_dir_s()).join(".codex"))
}

/// Subpastas numéricas (AAAA, MM, DD), da mais nova pra mais velha.
fn num_dirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<(u32, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()).map(|n| (n, e.path())))
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|x| x.1).collect()
}

/// Rollouts das 3 pastas de dia mais recentes, do modificado por último pro mais velho
/// (uma sessão aberta ontem e usada hoje continua sendo a mais nova).
pub(crate) fn codex_recent_rollouts(sessions: &Path) -> Vec<PathBuf> {
    let days: Vec<PathBuf> = num_dirs_desc(sessions).iter()
        .flat_map(|y| num_dirs_desc(y)).flat_map(|m| num_dirs_desc(&m)).take(3).collect();
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = days.iter()
        .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten())
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl")))
        .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok().map(|t| (t, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|x| x.1).collect()
}

fn read_tail(p: &Path, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(p) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > max { let _ = f.seek(SeekFrom::Start(len - max)); }
    let mut buf = vec![];
    let _ = f.take(max).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// A sessão mais nova; se ela ainda não tem limites (sessão recém-aberta, rate_limits nulo), a anterior.
pub(crate) fn codex_usage_in(sessions: &Path, now: i64) -> CodexUsage {
    codex_recent_rollouts(sessions).iter().take(2)
        .map(|p| codex_from_tail(&read_tail(p, 512 * 1024), now))
        .find(|u| u.has_data).unwrap_or_default()
}

pub(crate) fn codex_usage(now: i64) -> CodexUsage { codex_usage_in(&codex_home().join("sessions"), now) }

// ---------- DeepSeek ----------

/// Resposta de /user/balance → saldo (valores vêm como TEXTO). Sem `balance_infos` = erro.
pub(crate) fn parse_deepseek_balance(body: &str) -> Result<DeepseekUsage, String> {
    let v: Value = serde_json::from_str(body.trim()).map_err(|_| "resposta inválida".to_string())?;
    let infos = v.get("balance_infos").and_then(|b| b.as_array()).ok_or("sem saldo na resposta")?;
    let balances = infos.iter().filter_map(|b| {
        let currency = b.get("currency")?.as_str()?.to_string();
        let total = match b.get("total_balance")? { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), _ => return None };
        Some(Balance { currency, total })
    }).collect();
    Ok(DeepseekUsage { ok: true, available: v.get("is_available").and_then(|a| a.as_bool()).unwrap_or(true), balances })
}

/// (hash da chave, quando, valor) — trocar a chave invalida.
static DS_CACHE: Mutex<Option<(u64, Instant, DeepseekUsage)>> = Mutex::new(None);
const DS_TTL: Duration = Duration::from_secs(120);

fn key_hash(k: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    k.hash(&mut h);
    h.finish()
}

fn deepseek_fetch(key: &str) -> DeepseekUsage {
    // CR/LF na chave viraria um cabeçalho extra no arquivo do curl
    if key.contains('\r') || key.contains('\n') { return DeepseekUsage::default(); }
    let mut files = ai_once::TmpFiles(vec![]);
    let Ok(hdr) = ai_once::tmp_private(&mut files, "dsb", &format!("Authorization: Bearer {key}\nAccept: application/json\n")) else { return DeepseekUsage::default() };
    let mut c = Command::new("curl");
    c.args(["-s", "-m", "6", "-H"]).arg(format!("@{}", hdr.display())).arg("https://api.deepseek.com/user/balance");
    let out = output_timeout(c, 8);
    drop(files);
    match out {
        Ok(o) => parse_deepseek_balance(&String::from_utf8_lossy(&o.stdout)).unwrap_or_default(),
        Err(_) => DeepseekUsage::default(),
    }
}

/// Saldo com cache de 2 min POR CHAVE (erro também fica 2 min). A trava fica presa durante a busca:
/// uma busca por vez — chamadas simultâneas esperam e usam o resultado dela.
pub(crate) fn deepseek_usage_with(key: &str, fetch: impl Fn(&str) -> DeepseekUsage) -> DeepseekUsage {
    let h = key_hash(key);
    let mut g = DS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((kh, at, v)) = g.as_ref() {
        if *kh == h && at.elapsed() < DS_TTL { return v.clone(); }
    }
    let v = fetch(key);
    *g = Some((h, Instant::now(), v.clone()));
    v
}

pub(crate) fn deepseek_usage() -> DeepseekUsage {
    match ai_once::dsh_key() { Some(k) => deepseek_usage_with(&k, deepseek_fetch), None => DeepseekUsage::default() }
}

// ---------- agregador ----------

/// Quais IAs estão prontas (cache de 60 s: a sondagem do codex/dsh abre processos).
static READY_CACHE: Mutex<Option<(Instant, Vec<&'static str>)>> = Mutex::new(None);
fn ready_engines() -> Vec<&'static str> {
    if let Some((at, v)) = READY_CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < Duration::from_secs(60) { return v.clone(); }
    }
    let v: Vec<&'static str> = ai_once::engines_status().into_iter()
        .filter(|s| s.ready && matches!(s.id, "claude" | "codex" | "deepseek"))
        .map(|s| s.id)
        .collect();
    *READY_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), v.clone()));
    v
}

/// Config da Sua IA mudou (chave salva/removida, "verificar de novo"): esquece prontas e saldo.
pub(crate) fn clear_caches() {
    *READY_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *DS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

pub(crate) fn collect(db: Option<PathBuf>, configured: Vec<&'static str>, now: i64, month_since: Option<i64>) -> PlanUsage {
    let mut u = collect_in(&claude_usage_dir(), &claude_config_dir(), db, configured, now);
    with_month(&mut u, &usage_ledger::db_path(), month_since.filter(|s| *s > 0 && *s <= now).unwrap_or_else(|| month_start_utc(now)));
    u
}

pub(crate) fn with_month(u: &mut PlanUsage, ledger: &Path, since: i64) {
    u.month_since = since;
    match month_use(ledger, since) {
        Ok(m) => { u.month = m; u.month_error = None; }
        Err(e) => { u.month = Default::default(); u.month_error = Some(e); }
    }
}

/// `usage_dir` = ~/.constellation/usage; `claude_dir` = config do Claude Code (parametrizados pros testes).
/// A barra de status só entra quando está INSTALADA (desligou → o arquivo velho não conta).
pub(crate) fn collect_in(usage_dir: &Path, claude_dir: &Path, db: Option<PathBuf>, configured: Vec<&'static str>, now: i64) -> PlanUsage {
    let has = |id: &str| configured.contains(&id);
    let default_engine = ai_once::pref_engine();
    let claude = has("claude").then(|| {
        let windows = read_claude_windows(usage_dir);
        let used = match db.as_deref() { Some(d) => starfork_claude_use(d, now - FIVE_H_MS, &default_engine), None => Ok(StarforkUse::default()) };
        let mut c = claude_summary(Some(&windows), now, used);
        if statusline_installed_at(claude_dir) {
            let data = usage_dir.join("claude-statusline.json");
            match std::fs::read_to_string(&data) {
                Ok(t) => c = with_statusline(c, serde_json::from_str::<Value>(&t).ok().as_ref(), now),
                // instalada sem dados ainda: desde a instalação (statusline-prev.json é gravado só ao instalar)
                Err(_) => c.statusline_waiting_since = std::fs::metadata(usage_dir.join("statusline-prev.json")).and_then(|m| m.modified()).ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
            }
            c.statusline = true;
        }
        c
    });
    let codex = has("codex").then(|| codex_usage(now));
    let deepseek = has("deepseek").then(deepseek_usage);
    PlanUsage { default_engine, configured, claude, codex, deepseek, month: Default::default(), month_since: 0, month_error: None }
}

/// Medidor do plano (widget do menu lateral). Async: nunca segura a janela.
#[tauri::command(async)]
pub(crate) fn plan_usage(state: State<AppState>, month_since: Option<i64>) -> PlanUsage {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    collect(db, ready_engines(), now_ms(), month_since)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_870_000_000; // 2026-10-01 ~13:13 BRT
    const CODEX_LINE: &str = r#"{"timestamp":"2026-10-01T16:12:14.817Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":19914}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":9.0,"window_minutes":300,"resets_at":1790884401},"secondary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1791471201},"credits":{"has_credits":false},"plan_type":"plus","rate_limit_reached_type":null}}}"#;
    const NULL_RL: &str = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-plan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn golden_registro_do_claude_igual_ao_ts() {
        let g: Vec<Value> = serde_json::from_str(include_str!("../../../tests/fixtures/plan-usage-golden/claude-rate-limit.json")).unwrap();
        for c in g {
            let name = c["name"].as_str().unwrap();
            let line: Value = serde_json::from_str(c["line"].as_str().unwrap()).unwrap();
            let now = c["now"].as_i64().unwrap();
            let d = tmpdir("golden");
            record_claude_rate_limit(&line, &d, now);
            let files: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            match c["file"].as_str() {
                None => { assert!(rate_limit_record(&line, now).is_none(), "{name}"); assert!(files.is_empty(), "{name}"); }
                Some(f) => {
                    assert_eq!(files, vec![f.to_string()], "{name} (sem .tmp sobrando)");
                    let got: Value = serde_json::from_str(&std::fs::read_to_string(d.join(f)).unwrap()).unwrap();
                    assert_eq!(got, c["record"], "{name}");
                }
            }
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn leitura_junta_os_arquivos_por_janela() {
        let d = tmpdir("windows");
        let ev = |st: &str, kind: &str, u: Option<f64>| {
            let mut i = json!({ "status": st, "rateLimitType": kind, "resetsAt": 1_791_400_000 });
            if let Some(u) = u { i["utilization"] = json!(u); }
            json!({ "type": "rate_limit_event", "rate_limit_info": i })
        };
        record_claude_rate_limit(&ev("allowed", "five_hour", None), &d, NOW);
        record_claude_rate_limit(&ev("allowed_warning", "seven_day", Some(0.8)), &d, NOW);
        std::fs::write(d.join("claude-lixo.json"), "{quebrado").unwrap();
        std::fs::write(d.join("claude-x.json"), r#"{"rateLimitType":"outro","status":"rejected"}"#).unwrap();
        let w = read_claude_windows(&d);
        let keys: Vec<&String> = w["windows"].as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["five_hour", "seven_day"]);
        let c = claude_summary(Some(&w), NOW, Ok(StarforkUse::default()));
        assert_eq!((c.state, c.pct), ("warn", Some(80.0)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn codex_token_count_fixture() {
        let tail = format!("{{\"type\":\"response_item\"}}\n{}\n{}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\"}}}}\n",
            CODEX_LINE.replace("9.0", "50.0"), CODEX_LINE);
        let u = codex_from_tail(&tail, NOW);
        assert!(u.has_data);
        assert_eq!(u.plan.as_deref(), Some("plus"));
        let p = u.primary.unwrap();
        assert_eq!((p.used_percent, p.window_minutes, p.resets_at, p.reset), (9.0, 300, Some(1_790_884_401_000), false), "a ÚLTIMA token_count vale");
        let s = u.secondary.unwrap();
        assert_eq!((s.used_percent, s.window_minutes), (1.0, 10080));
    }

    #[test]
    fn codex_rate_limits_nulo_usa_a_ultima_com_limites() {
        assert_eq!(codex_from_tail(NULL_RL, NOW), CodexUsage::default(), "sessão sem rate_limits → sem dados ainda");
        assert_eq!(codex_from_tail("{\"type\":\"session_meta\"}\nlixo", NOW), CodexUsage::default());
        let u = codex_from_tail(&format!("{CODEX_LINE}\n{NULL_RL}\n"), NOW);
        assert_eq!(u.primary.unwrap().used_percent, 9.0, "a última token_count veio nula: vale a anterior com limites");
        let old = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":80.0,"window_minutes":300,"resets_at":1000}}}}"#;
        let p = codex_from_tail(old, NOW).primary.unwrap();
        assert!(p.reset);
        assert_eq!(p.used_percent, 0.0, "janela que já reiniciou não mostra o uso velho");
    }

    fn put(s: &Path, rel: &str, body: &str, mtime_s: u64) {
        let f = s.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, body).unwrap();
        let t = std::time::UNIX_EPOCH + Duration::from_secs(mtime_s);
        std::fs::File::options().write(true).open(&f).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn codex_rollout_mais_novo_por_mtime_nas_3_ultimas_pastas() {
        let d = tmpdir("codex");
        let s = d.join("sessions");
        put(&s, "2026/09/28/rollout-velho.jsonl", CODEX_LINE, 9_000); // 4ª pasta: fora
        put(&s, "2026/09/30/rollout-ontem.jsonl", CODEX_LINE, 5_000); // aberta ontem, usada por último
        put(&s, "2026/10/01/rollout-b.jsonl", NULL_RL, 3_000);
        put(&s, "2026/09/29/rollout-a.jsonl", NULL_RL, 1_000);
        put(&s, "2026/10/01/outro.txt", "x", 9_999);
        let names: Vec<String> = codex_recent_rollouts(&s).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["rollout-ontem.jsonl", "rollout-b.jsonl", "rollout-a.jsonl"]);
        assert!(codex_usage_in(&s, NOW).has_data);
        // a mais nova ainda sem limites → a anterior
        put(&s, "2026/10/01/rollout-b.jsonl", NULL_RL, 8_000);
        assert_eq!(codex_recent_rollouts(&s)[0].file_name().unwrap(), "rollout-b.jsonl");
        assert_eq!(codex_usage_in(&s, NOW).primary.unwrap().used_percent, 9.0);
        // nenhuma das 2 mais novas tem limites → sem dados (não varre o resto)
        put(&s, "2026/09/29/rollout-a.jsonl", NULL_RL, 8_500);
        put(&s, "2026/09/30/rollout-ontem.jsonl", CODEX_LINE, 100);
        assert!(!codex_usage_in(&s, NOW).has_data);
        assert!(codex_recent_rollouts(&d.join("nada")).is_empty());
        let big = s.join("2026/10/01/rollout-b.jsonl");
        std::fs::write(&big, format!("{}\nfim", "x".repeat(4000))).unwrap();
        assert_eq!(read_tail(&big, 10), "xxxxxx\nfim");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deepseek_saldo_e_cache_por_chave() {
        let ok = r#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"4.20","granted_balance":"0.00","topped_up_balance":"4.20"}]}"#;
        assert_eq!(parse_deepseek_balance(ok).unwrap(), DeepseekUsage { ok: true, available: true, balances: vec![Balance { currency: "USD".into(), total: "4.20".into() }] });
        assert!(parse_deepseek_balance(r#"{"error":{"message":"Authentication Fails"}}"#).is_err());
        assert!(parse_deepseek_balance("<html>").is_err());
        assert_eq!(deepseek_fetch("sk-a\r\nX-Evil: 1"), DeepseekUsage::default(), "CR/LF na chave: nem monta o cabeçalho");
        // cache: mesma chave não busca de novo; chave nova invalida; clear_caches esquece
        let n = std::sync::atomic::AtomicU32::new(0);
        let f = |_: &str| { n.fetch_add(1, std::sync::atomic::Ordering::SeqCst); parse_deepseek_balance(ok).unwrap() };
        clear_caches();
        deepseek_usage_with("k1", f);
        deepseek_usage_with("k1", f);
        assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 1);
        deepseek_usage_with("k2", f);
        assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 2, "trocou a chave → busca de novo");
        clear_caches();
        deepseek_usage_with("k2", f);
        assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    fn sf() -> StarforkUse { StarforkUse { turns: 3, in_tok: 100_000, out_tok: 20_000, ms: 60_000 } }

    #[test]
    fn claude_sem_evento_so_uso_do_starfork() {
        let c = claude_summary(None, NOW, Ok(sf()));
        assert_eq!((c.state, c.pct, c.resets_at), ("none", None, None));
        assert_eq!(c.starfork.in_tok + c.starfork.out_tok, 120_000);
        let e = claude_summary(None, NOW, Err("database is locked".into()));
        assert_eq!(e.starfork_error.as_deref(), Some("database is locked"));
    }

    #[test]
    fn claude_normal_sem_utilization_nao_inventa_porcentagem() {
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "resetsAt": 1_790_884_800, "at": NOW - 1000 } } });
        let c = claude_summary(Some(&f), NOW, Ok(sf()));
        assert_eq!(c.state, "ok");
        assert_eq!(c.window.as_deref(), Some("five_hour"));
        assert_eq!(c.pct, None);
        assert_eq!(c.resets_at, Some(1_790_884_800_000));
    }

    #[test]
    fn claude_perto_e_bloqueado() {
        let f = json!({ "windows": {
            "five_hour": { "status": "allowed", "resetsAt": 1_790_884_800 },
            "seven_day": { "status": "allowed_warning", "resetsAt": 1_791_400_000, "utilization": 0.92 } } });
        let c = claude_summary(Some(&f), NOW, Ok(sf()));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("warn", Some("seven_day"), Some(92.0)));
        let f = json!({ "windows": {
            "five_hour": { "status": "rejected", "resetsAt": 1_790_884_800 },
            "seven_day": { "status": "allowed_warning", "resetsAt": 1_791_400_000, "utilization": 0.92 } } });
        let c = claude_summary(Some(&f), NOW, Ok(sf()));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("blocked", Some("five_hour"), None));
    }

    #[test]
    fn claude_utilization_em_escala_errada() {
        let w = |u: f64| json!({ "windows": { "five_hour": { "status": "allowed_warning", "resetsAt": 1_790_884_800, "utilization": u } } });
        assert_eq!(claude_summary(Some(&w(92.0)), NOW, Ok(sf())).pct, Some(92.0), "já em %: não vira 9200 %");
        assert_eq!(claude_summary(Some(&w(9200.0)), NOW, Ok(sf())).pct, Some(100.0), "teto 100");
        assert_eq!(claude_summary(Some(&w(1.0)), NOW, Ok(sf())).pct, Some(100.0));
        assert_eq!(claude_summary(Some(&w(0.0)), NOW, Ok(sf())).pct, Some(0.0));
    }

    #[test]
    fn claude_janela_que_ja_reiniciou_nao_conta() {
        let f = json!({ "windows": { "five_hour": { "status": "rejected", "resetsAt": 1_000 } } });
        assert_eq!(claude_summary(Some(&f), NOW, Ok(sf())).state, "none");
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "at": NOW - FIVE_H_MS - 1 } } });
        assert_eq!(claude_summary(Some(&f), NOW, Ok(sf())).state, "none", "sem reinício conhecido e > 5 h: velho");
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "at": NOW - 60_000 } } });
        assert_eq!(claude_summary(Some(&f), NOW, Ok(sf())).state, "ok");
    }

    fn sl(f: Option<f64>, s: Option<f64>, at: i64) -> Value {
        let w = |p: Option<f64>, r: i64| p.map(|p| json!({ "pct": p, "resetsAt": r })).unwrap_or(Value::Null);
        json!({ "v": 1, "fiveHour": w(f, 1_790_884_800_000), "sevenDay": w(s, 1_791_400_000_000), "at": at })
    }

    #[test]
    fn barra_de_status_da_a_porcentagem_real() {
        let ev = json!({ "windows": { "five_hour": { "status": "allowed", "resetsAt": 1_790_884_800, "at": NOW - 600_000 } } });
        let c = with_statusline(claude_summary(Some(&ev), NOW, Ok(sf())), Some(&sl(Some(43.0), Some(61.0), NOW - 120_000)), NOW);
        assert_eq!(c.five_hour, Some(ClaudeWin { pct: 43.0, resets_at: Some(1_790_884_800_000), reset: false }));
        assert_eq!(c.seven_day.as_ref().map(|w| w.pct), Some(61.0));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("ok", Some("seven_day"), Some(61.0)), "destaque = a janela mais cheia");
        assert_eq!(c.updated_at, Some(NOW - 120_000));
        // sem evento nenhum: a barra sozinha basta
        let c = with_statusline(claude_summary(None, NOW, Ok(sf())), Some(&sl(Some(10.0), None, NOW)), NOW);
        assert_eq!((c.state, c.window.as_deref(), c.pct, c.seven_day.clone()), ("ok", Some("five_hour"), Some(10.0), None));
        // sem arquivo / arquivo sem janelas: nada muda
        let base = claude_summary(Some(&ev), NOW, Ok(sf()));
        assert_eq!(with_statusline(base.clone(), None, NOW), base);
        assert_eq!(with_statusline(base.clone(), Some(&json!({ "at": NOW })), NOW), base);
        assert_eq!(with_statusline(base.clone(), Some(&json!({ "fiveHour": { "pct": "x" } })), NOW), base);
    }

    #[test]
    fn barra_de_status_janela_reiniciada_vira_zero() {
        let s = json!({ "fiveHour": { "pct": 97, "resetsAt": NOW - 1 }, "sevenDay": { "pct": 40, "resetsAt": NOW + 1000 }, "at": NOW - 6 * 3600 * 1000 });
        let c = with_statusline(claude_summary(None, NOW, Ok(sf())), Some(&s), NOW);
        assert_eq!(c.five_hour, Some(ClaudeWin { pct: 0.0, resets_at: Some(NOW - 1), reset: true }));
        assert_eq!((c.window.as_deref(), c.pct), (Some("seven_day"), Some(40.0)));
        // resetsAt em segundos também vale
        let s = json!({ "fiveHour": { "pct": 50, "resetsAt": 1_000 }, "at": NOW });
        assert_eq!(with_statusline(claude_summary(None, NOW, Ok(sf())), Some(&s), NOW).pct, Some(0.0));
    }

    #[test]
    fn barra_de_status_x_evento() {
        let ev = |st: &str, at: i64, resets: Option<i64>| {
            let mut w = json!({ "status": st, "at": at });
            if let Some(r) = resets { w["resetsAt"] = json!(r); }
            json!({ "windows": { "five_hour": w } })
        };
        let run = |e: &Value, s: &Value| with_statusline(claude_summary(Some(e), NOW, Ok(sf())), Some(s), NOW);
        // rejected MAIS NOVO que a barra: o estado prevalece; a % da janela vem da barra
        let c = run(&ev("rejected", NOW - 1000, Some(1_790_884_800)), &sl(Some(98.0), Some(70.0), NOW - 60_000));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("blocked", Some("five_hour"), Some(98.0)));
        assert_eq!(c.resets_at, Some(1_790_884_800_000), "com a hora da volta");
        assert_eq!(c.seven_day.as_ref().map(|w| w.pct), Some(70.0), "as barras continuam");
        // rejected MAIS VELHO que a barra, mas a volta ainda no futuro: continua bloqueado (não esconde o bloqueio)
        let c = run(&ev("rejected", NOW - 600_000, Some(1_790_884_800)), &sl(Some(30.0), Some(20.0), NOW - 60_000));
        assert_eq!((c.state, c.window.as_deref(), c.pct, c.resets_at), ("blocked", Some("five_hour"), Some(30.0), Some(1_790_884_800_000)));
        // rejected velho SEM hora de volta (ainda dentro das 5 h): a barra mais nova manda
        let c = run(&ev("rejected", NOW - 600_000, None), &sl(Some(30.0), Some(20.0), NOW - 60_000));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("ok", Some("five_hour"), Some(30.0)));
        // allowed_warning: fica warn, a menos que a barra mostre aquela janela < 70 %
        let w = |at: i64, u: Option<f64>| {
            let mut x = json!({ "status": "allowed_warning", "resetsAt": 1_791_400_000, "at": at });
            if let Some(u) = u { x["utilization"] = json!(u); }
            json!({ "windows": { "seven_day": x } })
        };
        let c = run(&w(NOW - 1000, Some(0.91)), &sl(Some(20.0), Some(88.0), NOW - 60_000));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("warn", Some("seven_day"), Some(91.0)));
        let c = run(&w(NOW - 600_000, None), &sl(Some(20.0), Some(75.0), NOW - 60_000));
        assert_eq!((c.state, c.pct), ("warn", Some(75.0)), "evento mais velho, barra ≥ 70 %: continua warn");
        let c = run(&w(NOW - 1000, Some(0.8)), &sl(Some(20.0), Some(50.0), NOW - 60_000));
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("ok", Some("seven_day"), Some(50.0)), "barra < 70 % naquela janela: some o aviso");
        let c = run(&w(NOW - 1000, None), &sl(Some(20.0), None, NOW - 60_000));
        assert_eq!((c.state, c.window.as_deref()), ("warn", Some("seven_day")), "barra sem aquela janela: fica o aviso");
        // allowed mais novo: não prevalece (só rejected/allowed_warning)
        let c = run(&ev("allowed", NOW - 1000, Some(1_790_884_800)), &sl(Some(30.0), None, NOW - 60_000));
        assert_eq!((c.state, c.pct), ("ok", Some(30.0)));
    }

    #[test]
    fn golden_da_barra_igual_ao_ts() {
        let g: Value = serde_json::from_str(include_str!("../../../tests/fixtures/plan-usage-golden/statusline.json")).unwrap();
        for c in g["commands"].as_array().unwrap() {
            assert_eq!(node_of_command(c["command"].as_str().unwrap()).as_deref(), c["node"].as_str());
        }
        for c in g["settings"].as_array().unwrap() {
            let (name, text) = (c["name"].as_str().unwrap(), c["text"].as_str().unwrap());
            assert_eq!(statusline_installed_in(text), c["installed"].as_bool().unwrap(), "{name}");
            assert_eq!(statusline_node_in(text).as_deref(), c["node"].as_str(), "{name}");
        }
        for c in g["read"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let got = statusline_windows(&c["file"], c["now"].as_i64().unwrap())
                .map(|(f, s, at)| json!({ "fiveHour": f, "sevenDay": s, "at": at }))
                .unwrap_or(Value::Null);
            assert_eq!(got, c["expect"], "{name}");
        }
        // o arquivo que o script do TS grava (+ at) é lido
        let mut f = g["script"]["file"].clone();
        f["at"] = json!(NOW);
        let (five, week, _) = statusline_windows(&f, NOW).unwrap();
        assert_eq!((five.unwrap().pct, week.unwrap().pct), (43.0, 61.4));
    }

    #[test]
    fn cli_da_barra_ok_e_erro_humano() {
        assert_eq!(parse_statusline_cli("{\"ok\":true,\"message\":\"x\",\"installed\":true}\n", "").unwrap()["installed"], json!(true));
        assert_eq!(parse_statusline_cli("{\"ok\":false,\"message\":\"settings inválido\"}", "").unwrap_err(), "settings inválido");
        assert_eq!(parse_statusline_cli("", "boom").unwrap_err(), "boom");
    }

    #[test]
    fn collect_so_usa_a_barra_quando_instalada() {
        let d = tmpdir("collect");
        let (usage, cfg) = (d.join("usage"), d.join("claude"));
        std::fs::create_dir_all(&usage).unwrap();
        std::fs::create_dir_all(&cfg).unwrap();
        let installed = format!(r#"{{"statusLine":{{"type":"command","command":"\"/n/node\" \"{}\""}}}}"#, usage.join("claude-statusline.mjs").display());
        // instalada, sem dados ainda: "esperando desde" a instalação
        std::fs::write(cfg.join("settings.json"), &installed).unwrap();
        std::fs::write(usage.join("statusline-prev.json"), "{}").unwrap();
        let c = collect_in(&usage, &cfg, None, vec!["claude"], NOW).claude.unwrap();
        assert!(c.statusline && c.five_hour.is_none());
        assert!(c.statusline_waiting_since.is_some());
        // com dados: a %
        std::fs::write(usage.join("claude-statusline.json"), sl(Some(43.0), Some(61.0), NOW - 1000).to_string()).unwrap();
        let c = collect_in(&usage, &cfg, None, vec!["claude"], NOW).claude.unwrap();
        assert_eq!((c.five_hour.map(|w| w.pct), c.statusline_waiting_since), (Some(43.0), None));
        // desligada: o arquivo velho NÃO conta
        std::fs::write(cfg.join("settings.json"), r#"{"model":"x"}"#).unwrap();
        let c = collect_in(&usage, &cfg, None, vec!["claude"], NOW).claude.unwrap();
        assert!(!c.statusline && c.five_hour.is_none() && c.pct.is_none());
        assert!(statusline_node_missing(&cfg).is_none());
        // node sumido → o boot repara
        std::fs::write(cfg.join("settings.json"), &installed).unwrap();
        assert_eq!(statusline_node_missing(&cfg).as_deref(), Some("/n/node"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn motor_do_turno_pelo_papel() {
        let roles = r#"[{"role":"builder","name":"Íris","engine":"codex"},{"role":"reviewer","name":"Leo","engine":"claude"}]"#;
        assert_eq!(cost_engine("Íris", Some("builder"), roles, "claude", "claude"), "codex", "o papel manda");
        assert_eq!(cost_engine("Outro", Some("reviewer"), roles, "codex", "claude"), "claude", "sem nome: pelo papel");
        assert_eq!(cost_engine("Zé", None, roles, "codex", "claude"), "codex", "sem papel: o da tarefa");
        assert_eq!(cost_engine("Zé", None, "[]", "", "deepseek"), "deepseek", "nada: a IA padrão (não 'claude')");
        assert_eq!(cost_engine("Zé", None, "lixo", " ", "codex"), "codex");
    }

    fn mkdb(tag: &str, with_ms: bool) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-plan-{tag}-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&d);
        let c = Connection::open(&d).unwrap();
        let ms = if with_ms { ", ms INTEGER NOT NULL DEFAULT 0" } else { "" };
        c.execute_batch(&format!("CREATE TABLE task (id TEXT PRIMARY KEY, engine TEXT NOT NULL, roles_json TEXT NOT NULL DEFAULT '[]');
            CREATE TABLE cost (id INTEGER PRIMARY KEY, task_id TEXT, agent TEXT, role TEXT, usd REAL, in_tok INTEGER, out_tok INTEGER{ms}, created_at INTEGER);
            INSERT INTO task VALUES ('a','claude','[]'),('b','codex','[]'),('mix','claude','[{{\"role\":\"builder\",\"name\":\"Íris\",\"engine\":\"codex\"}}]'),('vazio','','[]');")).unwrap();
        d
    }

    #[test]
    fn uso_do_starfork_so_claude_so_5h_sem_orfas() {
        let d = mkdb("use", true);
        let c = Connection::open(&d).unwrap();
        for (t, agent, i, o, ms, at) in [
            ("a", "x", 1000, 100, 5000, NOW - 1000),
            ("a", "x", 2000, 200, 7000, NOW - 2 * 3600 * 1000),
            ("b", "x", 9999, 9999, 1, NOW - 1000),           // codex
            ("a", "x", 5555, 5555, 1, NOW - 6 * 3600 * 1000), // fora das 5 h
            ("apagada", "x", 10, 1, 0, NOW - 1000),          // órfã: não conta
            ("mix", "Íris", 777, 7, 0, NOW - 1000),          // papel no codex
            ("mix", "Leo", 30, 3, 10, NOW - 1000),           // papel sem motor → o da tarefa (claude)
            ("vazio", "x", 400, 4, 0, NOW - 1000),           // sem motor → a padrão
        ] {
            c.execute("INSERT INTO cost (task_id, agent, usd, in_tok, out_tok, ms, created_at) VALUES (?1,?2,0,?3,?4,?5,?6)", params![t, agent, i, o, ms, at]).unwrap();
        }
        drop(c);
        let since = NOW - FIVE_H_MS;
        assert_eq!(starfork_claude_use(&d, since, "claude").unwrap(), StarforkUse { turns: 4, in_tok: 3430, out_tok: 307, ms: 12010 });
        assert_eq!(starfork_claude_use(&d, since, "codex").unwrap().turns, 3, "tarefa sem motor segue a IA padrão");
        assert!(starfork_claude_use(Path::new("/nao/existe.sqlite"), 0, "claude").is_err());
        let _ = std::fs::remove_file(&d);
    }

    #[test]
    fn uso_do_starfork_banco_antigo_sem_ms_e_erro_real() {
        let d = mkdb("old", false);
        let c = Connection::open(&d).unwrap();
        c.execute("INSERT INTO cost (task_id, agent, usd, in_tok, out_tok, created_at) VALUES ('a','x',0,10,2,?1)", [NOW]).unwrap();
        drop(c);
        assert_eq!(starfork_claude_use(&d, 0, "claude").unwrap(), StarforkUse { turns: 1, in_tok: 10, out_tok: 2, ms: 0 });
        // outro erro (sem a tabela task) NÃO é escondido
        let c = Connection::open(&d).unwrap();
        c.execute_batch("DROP TABLE task;").unwrap();
        drop(c);
        let e = starfork_claude_use(&d, 0, "claude").unwrap_err();
        assert!(e.contains("no such table"), "{e}");
        let _ = std::fs::remove_file(&d);
    }

    #[test]
    fn so_aparece_ia_configurada() {
        let u = collect(None, vec![], NOW, None);
        assert!(u.claude.is_none() && u.codex.is_none() && u.deepseek.is_none());
    }

    #[test]
    fn formato_serializado_igual_ao_golden_do_front() {
        let golden: Value = serde_json::from_str(include_str!("../../../tests/fixtures/plan-usage-golden/payload.json")).unwrap();
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "resetsAt": 1_790_884_800 } } });
        let u = PlanUsage {
            default_engine: "claude".into(),
            configured: vec!["claude", "codex", "deepseek"],
            claude: Some({
                let sl = json!({ "v": 1, "fiveHour": { "pct": 43, "resetsAt": 1_790_884_800_000_i64 }, "sevenDay": { "pct": 61, "resetsAt": 1_791_400_000_000_i64 }, "at": NOW - 120_000 });
                let mut c = with_statusline(claude_summary(Some(&f), NOW, Ok(StarforkUse { turns: 3, in_tok: 118_000, out_tok: 2_000, ms: 600_000 })), Some(&sl), NOW);
                c.statusline = true;
                c
            }),
            codex: Some(codex_from_tail(CODEX_LINE, NOW)),
            deepseek: Some(parse_deepseek_balance(r#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"4.20"}]}"#).unwrap()),
            month: [("claude".to_string(), MonthUse { usd: 3.2, tasks: 14, calls: 41 }), ("codex".to_string(), MonthUse { usd: 0.85, tasks: 2, calls: 5 })].into_iter().collect(),
            month_since: 1_790_823_600_000,
            month_error: None,
        };
        assert_eq!(serde_json::to_value(&u).unwrap(), golden);
    }

    #[test]
    fn mes_soma_o_livro_por_ia_e_conta_tarefas_distintas() {
        let d = tmpdir("month");
        let db = d.join("usage.sqlite");
        let mk = |at: i64, engine: &str, task: Option<&str>, usd: f64| {
            let mut e = usage_ledger::Entry::new("tarefa", engine);
            e.at = at; e.task_id = task.map(String::from); e.usd = usd;
            usage_ledger::record_in(&db, &e).unwrap();
        };
        let since = NOW - 10 * 86_400_000;
        mk(since - 1, "claude", Some("velha"), 9.0); // mês passado: fora
        mk(NOW - 1000, "claude", Some("t1"), 1.5);
        mk(NOW - 900, "claude", Some("t1"), 0.5);
        mk(NOW - 800, "claude", Some("t2"), 1.2);
        mk(NOW - 700, "claude", None, 0.004); // nova demanda / retro: conta no gasto, não como tarefa
        mk(NOW - 600, "codex", Some("c1"), 0.85);
        let m = month_use(&db, since).unwrap();
        assert_eq!(m["claude"], MonthUse { usd: 3.2, tasks: 2, calls: 4 });
        assert_eq!(m["codex"], MonthUse { usd: 0.85, tasks: 1, calls: 1 });
        assert!(!m.contains_key("deepseek"));
        // livro inexistente = vazio (nunca erro)
        assert!(month_use(&d.join("nao-existe.sqlite"), since).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn barra_de_status_velha_nao_decide_a_porcentagem() {
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "resetsAt": 1_790_884_800 } } });
        let base = claude_summary(Some(&f), NOW, Ok(StarforkUse::default()));
        let sl = json!({ "v": 1, "fiveHour": { "pct": 43, "resetsAt": NOW + 3_600_000 }, "sevenDay": { "pct": 61, "resetsAt": NOW + 86_400_000 }, "at": NOW - SL_OLD_MS - 1 });
        let c = with_statusline(base.clone(), Some(&sl), NOW);
        assert_eq!((c.state, c.pct, c.window.as_deref()), (base.state, None, base.window.as_deref()), "velha: o resumo fica com o evento");
        assert_eq!(c.updated_at, Some(NOW - SL_OLD_MS - 1), "o front sabe de quando é");
        let fresh = json!({ "v": 1, "fiveHour": { "pct": 43, "resetsAt": NOW + 3_600_000 }, "at": NOW - 1000 });
        assert_eq!(with_statusline(base, Some(&fresh), NOW).pct, Some(43.0));
    }

    #[test]
    fn inicio_do_mes_utc() {
        // 2026-10-01 13:13 UTC → 2026-10-01 00:00 UTC; 2024-02-29 → 2024-02-01
        assert_eq!(month_start_utc(1_790_870_000_000), 1_790_812_800_000);
        assert_eq!(month_start_utc(1_709_208_000_000), 1_706_745_600_000);
    }

    /// Conferência manual nesta máquina: `cargo test real_machine -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_machine_plan_usage() {
        let u = collect(None, vec!["claude", "codex"], now_ms(), None);
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "claude": u.claude, "codex": u.codex })).unwrap());
        println!("rollouts: {:?}", codex_recent_rollouts(&codex_home().join("sessions")).iter().take(2).collect::<Vec<_>>());
    }
}
