//! MEDIDOR DO PLANO (widget do menu lateral): quanto já foi usado do plano de cada IA configurada.
//! Só fontes documentadas ou arquivos locais da própria pessoa — e nada sai desta máquina:
//! - Claude → `~/.constellation/usage/claude.json` (o último `rate_limit_event` por janela, gravado pelo motor TS
//!   em src/engine/claude.ts) + o uso que o Starfork registrou nas últimas 5 h (tabela `cost` do projeto ativo).
//!   Porcentagem SÓ quando o evento trouxe `utilization` (o Claude Code manda perto do limite) — nunca inventada.
//!   NUNCA chama /api/oauth/usage nem lê o token do Keychain.
//! - Codex → a ÚLTIMA linha `token_count` (rate_limits.primary/secondary) da sessão mais nova em
//!   `$CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl` (só a cauda do arquivo). Nunca lê `auth.json`.
//! - DeepSeek → `GET https://api.deepseek.com/user/balance` com a chave do llm.env (cabeçalho em arquivo 0600,
//!   nunca no argv), prazo curto e cache de 2 min. O valor da chave nunca sai daqui.
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
    /// o que o Starfork registrou nas últimas 5 h (projeto ativo)
    pub starfork: StarforkUse,
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
}

const FIVE_H_MS: i64 = 5 * 3600 * 1000;

/// epoch em segundos OU ms → ms
fn epoch_ms(v: &Value) -> Option<i64> {
    let n = v.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(if n < 1e12 { (n * 1000.0) as i64 } else { n as i64 })
}

// ---------- Claude ----------

/// Monta o resumo do Claude a partir do arquivo do motor (pode faltar) e do uso registrado pelo Starfork.
/// Janelas já reiniciadas (resetsAt no passado) ou velhas (> 5 h sem reinício conhecido) não contam mais.
/// Prioridade: bloqueado > perto do limite (maior utilization) > janela de 5 h > qualquer outra.
pub(crate) fn claude_summary(file: Option<&Value>, now: i64, starfork: StarforkUse) -> ClaudeUsage {
    struct W { kind: String, status: String, resets: Option<i64>, util: Option<f64> }
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
            ws.push(W { kind: kind.clone(), status, resets, util });
        }
    }
    let pick = ws.iter().filter(|w| w.status == "rejected").max_by_key(|w| w.resets.unwrap_or(0))
        .or_else(|| ws.iter().filter(|w| w.status == "allowed_warning").max_by(|a, b| a.util.unwrap_or(0.0).total_cmp(&b.util.unwrap_or(0.0))))
        .or_else(|| ws.iter().find(|w| w.kind == "five_hour"))
        .or_else(|| ws.first());
    match pick {
        None => ClaudeUsage { state: "none", window: None, pct: None, resets_at: None, starfork },
        Some(w) => ClaudeUsage {
            state: match w.status.as_str() { "rejected" => "blocked", "allowed_warning" => "warn", _ => "ok" },
            window: Some(w.kind.clone()),
            pct: w.util.map(|u| ((u * 100.0) * 10.0).round() / 10.0),
            resets_at: w.resets,
            starfork,
        },
    }
}

pub(crate) fn claude_usage_file() -> PathBuf {
    PathBuf::from(home_dir_s()).join(".constellation").join("usage").join("claude.json")
}

/// Turnos das tarefas do CLAUDE gravados no `cost` desde `since` (tarefa apagada conta: o motor padrão é o Claude).
pub(crate) fn starfork_claude_use(db: &Path, since: i64) -> StarforkUse {
    let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return StarforkUse::default() };
    let _ = conn.busy_timeout(Duration::from_millis(2000));
    let q = |ms: &str| format!(
        "SELECT COUNT(*), COALESCE(SUM(c.in_tok),0), COALESCE(SUM(c.out_tok),0), {ms} FROM cost c LEFT JOIN task t ON t.id = c.task_id \
         WHERE c.created_at >= ?1 AND (t.engine IS NULL OR t.engine = '' OR t.engine LIKE 'claude%')"
    );
    let row = |sql: String| conn.query_row(&sql, [since], |r| Ok(StarforkUse { turns: r.get(0)?, in_tok: r.get(1)?, out_tok: r.get(2)?, ms: r.get(3)? }));
    // banco antigo sem a coluna `ms`: soma sem o tempo
    row(q("COALESCE(SUM(c.ms),0)")).or_else(|_| row(q("0"))).unwrap_or_default()
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

/// Cauda do arquivo → a ÚLTIMA linha `token_count` (as anteriores nem são lidas).
pub(crate) fn codex_from_tail(text: &str, now: i64) -> CodexUsage {
    text.lines().rev().filter(|l| l.contains("\"token_count\"")).find_map(|l| codex_from_line(l, now)).unwrap_or_default()
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

/// O rollout mais novo: o dia mais recente que tem sessão, e nele o arquivo modificado por último.
pub(crate) fn codex_newest_rollout(sessions: &Path) -> Option<PathBuf> {
    for y in num_dirs_desc(sessions) {
        for m in num_dirs_desc(&y) {
            for d in num_dirs_desc(&m) {
                let newest = std::fs::read_dir(&d).into_iter().flatten().flatten()
                    .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl")))
                    .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok().map(|t| (t, e.path())))
                    .max_by_key(|x| x.0);
                if let Some((_, p)) = newest { return Some(p); }
            }
        }
    }
    None
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

pub(crate) fn codex_usage(now: i64) -> CodexUsage {
    match codex_newest_rollout(&codex_home().join("sessions")) {
        Some(p) => codex_from_tail(&read_tail(&p, 512 * 1024), now),
        None => CodexUsage::default(),
    }
}

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

static DS_CACHE: Mutex<Option<(Instant, DeepseekUsage)>> = Mutex::new(None);
const DS_TTL: Duration = Duration::from_secs(120);

fn deepseek_fetch(key: &str) -> DeepseekUsage {
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

/// Saldo com cache de 2 min (erro também fica 2 min — nunca martela a API).
pub(crate) fn deepseek_usage() -> DeepseekUsage {
    if let Some((at, v)) = DS_CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < DS_TTL { return v.clone(); }
    }
    let v = match ai_once::dsh_key() { Some(k) => deepseek_fetch(&k), None => DeepseekUsage::default() };
    *DS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), v.clone()));
    v
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

pub(crate) fn collect(db: Option<PathBuf>, configured: Vec<&'static str>, now: i64) -> PlanUsage {
    let has = |id: &str| configured.contains(&id);
    let claude = has("claude").then(|| {
        let file = std::fs::read_to_string(claude_usage_file()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let used = db.as_deref().map(|d| starfork_claude_use(d, now - FIVE_H_MS)).unwrap_or_default();
        claude_summary(file.as_ref(), now, used)
    });
    let codex = has("codex").then(|| codex_usage(now));
    let deepseek = has("deepseek").then(deepseek_usage);
    PlanUsage { default_engine: ai_once::pref_engine(), configured, claude, codex, deepseek }
}

/// Medidor do plano (widget do menu lateral). Async: nunca segura a janela.
#[tauri::command(async)]
pub(crate) fn plan_usage(state: State<AppState>) -> PlanUsage {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
    collect(db, ready_engines(), now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_870_000_000; // 2026-10-01 ~13:13 BRT

    #[test]
    fn codex_token_count_fixture() {
        // linha real (formato do rollout do Codex 0.13x, plano plus)
        let line = r#"{"timestamp":"2026-10-01T16:12:14.817Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":19914}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":9.0,"window_minutes":300,"resets_at":1790884401},"secondary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1791471201},"credits":{"has_credits":false},"plan_type":"plus","rate_limit_reached_type":null}}}"#;
        let tail = format!("{{\"type\":\"response_item\"}}\n{}\n{}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\"}}}}\n",
            line.replace("9.0", "50.0"), line);
        let u = codex_from_tail(&tail, NOW);
        assert!(u.has_data);
        assert_eq!(u.plan.as_deref(), Some("plus"));
        let p = u.primary.unwrap();
        assert_eq!((p.used_percent, p.window_minutes, p.resets_at, p.reset), (9.0, 300, Some(1_790_884_401_000), false), "a ÚLTIMA token_count vale");
        let s = u.secondary.unwrap();
        assert_eq!((s.used_percent, s.window_minutes), (1.0, 10080));
    }

    #[test]
    fn codex_sem_rate_limits_e_janela_reiniciada() {
        let none = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#;
        assert_eq!(codex_from_tail(none, NOW), CodexUsage::default(), "sessão sem rate_limits → sem dados ainda");
        assert_eq!(codex_from_tail("{\"type\":\"session_meta\"}\nlixo", NOW), CodexUsage::default());
        let old = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":80.0,"window_minutes":300,"resets_at":1000}}}}"#;
        let u = codex_from_tail(old, NOW);
        let p = u.primary.unwrap();
        assert!(p.reset);
        assert_eq!(p.used_percent, 0.0, "janela que já reiniciou não mostra o uso velho");
        assert!(u.secondary.is_none());
    }

    #[test]
    fn codex_rollout_mais_novo() {
        let d = std::env::temp_dir().join(format!("sf-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let s = d.join("sessions");
        for (p, body) in [("2026/09/30/rollout-a.jsonl", "a"), ("2026/10/01/rollout-b.jsonl", "b"), ("2026/10/01/rollout-c.jsonl", "c"), ("2026/10/01/outro.txt", "x")] {
            let f = s.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, body).unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
        std::fs::create_dir_all(s.join("2026/10/02")).unwrap(); // dia vazio: pula
        assert_eq!(codex_newest_rollout(&s).unwrap().file_name().unwrap(), "rollout-c.jsonl");
        assert!(codex_newest_rollout(&d.join("nada")).is_none());
        // cauda: só os últimos bytes
        let big = s.join("2026/10/01/rollout-c.jsonl");
        std::fs::write(&big, format!("{}\nfim", "x".repeat(4000))).unwrap();
        assert_eq!(read_tail(&big, 10), "xxxxxx\nfim");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deepseek_saldo() {
        let ok = r#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"4.20","granted_balance":"0.00","topped_up_balance":"4.20"}]}"#;
        assert_eq!(parse_deepseek_balance(ok).unwrap(), DeepseekUsage { ok: true, available: true, balances: vec![Balance { currency: "USD".into(), total: "4.20".into() }] });
        assert!(parse_deepseek_balance(r#"{"error":{"message":"Authentication Fails"}}"#).is_err());
        assert!(parse_deepseek_balance("<html>").is_err());
        assert_eq!(DeepseekUsage::default().ok, false, "erro de rede → saldo indisponível");
    }

    fn sf() -> StarforkUse { StarforkUse { turns: 3, in_tok: 100_000, out_tok: 20_000, ms: 60_000 } }

    #[test]
    fn claude_sem_evento_so_uso_do_starfork() {
        let c = claude_summary(None, NOW, sf());
        assert_eq!((c.state, c.pct, c.resets_at), ("none", None, None));
        assert_eq!(c.starfork.in_tok + c.starfork.out_tok, 120_000);
    }

    #[test]
    fn claude_normal_sem_utilization_nao_inventa_porcentagem() {
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "resetsAt": 1_790_884_800, "at": NOW - 1000 } } });
        let c = claude_summary(Some(&f), NOW, sf());
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
        let c = claude_summary(Some(&f), NOW, sf());
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("warn", Some("seven_day"), Some(92.0)));
        let f = json!({ "windows": {
            "five_hour": { "status": "rejected", "resetsAt": 1_790_884_800 },
            "seven_day": { "status": "allowed_warning", "resetsAt": 1_791_400_000, "utilization": 0.92 } } });
        let c = claude_summary(Some(&f), NOW, sf());
        assert_eq!((c.state, c.window.as_deref(), c.pct), ("blocked", Some("five_hour"), None));
    }

    #[test]
    fn claude_janela_que_ja_reiniciou_nao_conta() {
        let f = json!({ "windows": { "five_hour": { "status": "rejected", "resetsAt": 1_000 } } });
        assert_eq!(claude_summary(Some(&f), NOW, sf()).state, "none");
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "at": NOW - FIVE_H_MS - 1 } } });
        assert_eq!(claude_summary(Some(&f), NOW, sf()).state, "none", "sem reinício conhecido e > 5 h: velho");
        let f = json!({ "windows": { "five_hour": { "status": "allowed", "at": NOW - 60_000 } } });
        assert_eq!(claude_summary(Some(&f), NOW, sf()).state, "ok");
    }

    #[test]
    fn claude_uso_do_starfork_so_claude_e_so_5h() {
        let d = std::env::temp_dir().join(format!("sf-plan-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&d);
        let c = Connection::open(&d).unwrap();
        c.execute_batch("CREATE TABLE task (id TEXT PRIMARY KEY, engine TEXT NOT NULL);
            CREATE TABLE cost (id INTEGER PRIMARY KEY, task_id TEXT, agent TEXT, role TEXT, usd REAL, in_tok INTEGER, out_tok INTEGER, ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
            INSERT INTO task VALUES ('a','claude'),('b','codex');").unwrap();
        let now = NOW;
        for (t, i, o, ms, at) in [("a", 1000, 100, 5000, now - 1000), ("a", 2000, 200, 7000, now - 2 * 3600 * 1000), ("b", 9999, 9999, 1, now - 1000), ("a", 5555, 5555, 1, now - 6 * 3600 * 1000), ("apagada", 10, 1, 0, now - 1000)] {
            c.execute("INSERT INTO cost (task_id, agent, usd, in_tok, out_tok, ms, created_at) VALUES (?1,'x',0,?2,?3,?4,?5)", params![t, i, o, ms, at]).unwrap();
        }
        drop(c);
        assert_eq!(starfork_claude_use(&d, now - FIVE_H_MS), StarforkUse { turns: 3, in_tok: 3010, out_tok: 301, ms: 12000 });
        assert_eq!(starfork_claude_use(Path::new("/nao/existe.sqlite"), 0), StarforkUse::default());
        let _ = std::fs::remove_file(&d);
    }

    #[test]
    fn so_aparece_ia_configurada() {
        let u = collect(None, vec![], NOW);
        assert!(u.claude.is_none() && u.codex.is_none() && u.deepseek.is_none());
    }

    /// Conferência manual nesta máquina: `cargo test real_machine -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_machine_plan_usage() {
        let u = collect(None, vec!["claude", "codex"], now_ms());
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "claude": u.claude, "codex": u.codex })).unwrap());
        println!("rollout: {:?}", codex_newest_rollout(&codex_home().join("sessions")));
    }
}
