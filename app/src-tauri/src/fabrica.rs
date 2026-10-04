//! FÁBRICA DE APPS E DE FEATURES (spec-fabrica-mvp) — a aba "Fábrica" (app/src/js/65-fabrica.js).
//! Uma SESSÃO sob demanda (nada de radar): foco → varredura com teto em US$ e parada dura → triagem sem IA
//! (≥2 fontes independentes, autores distintos, sinal sem fonte consultável = descartado) → mesa curta (1 chamada,
//! votos em lote) → mock HTML por opção (kit fixo, validado; 1 retentativa) → até 3 opções. A sessão mora em
//! `~/.constellation/fabrica/<id>.json`; o progresso sai no evento `fabrica-progress` (sem polling); parar =
//! `fabrica_stop`. Escolher NÃO cria nada aqui: o front leva a opção pro "Começar por uma ideia" (app) ou monta o
//! épico em rascunho no projeto (feature) depois da confirmação inline.
//! Motor: o MESMO da Ideia (`ideia::research_claude_in`/`research_other_in`) — teto do Claude por `--max-budget-usd`,
//! outros motores estimados pelos tokens (`usage_ledger::estimate_usd`), igual à mesa.
//! Fontes de feature são LOCAIS primeiro: issues (gh + tracker que o front já leu), demandas e instruções passadas
//! (state.sqlite), memória do projeto (restrição, nunca sinal), texto colado e leitura do código ("achado de código").
//! Autor e data de fonte local vêm do NOSSO dado, nunca do modelo.
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::{ai_once, home_dir_s, ideia, memoria, mesa, now_ms, usage_ledger};

/// Teto padrão por sessão (US$) e o mínimo pra valer abrir mais uma chamada.
pub const TETO_PADRAO: f64 = 3.0;
/// Teto máximo aceito (a tela avisa e corta no mesmo valor).
pub const TETO_MAX: f64 = 50.0;
pub const MIN_CHAMADA: f64 = 0.03;
pub const MAX_OPCOES: usize = 3;
/// Parte do teto que a varredura pode usar (o resto: mesa + mocks, que rodam no modelo pequeno). Teto baixo = a
/// varredura leva mais (só o contexto inicial do Claude já custa centavos).
pub(crate) fn frac_varredura(teto: f64) -> f64 { if teto < 1.5 { 0.7 } else { 0.55 } }
/// Corpo do mock (sem o kit): tamanho máximo em caracteres.
pub const MOCK_MAX: usize = 16_000;
const VARREDURA_SECS: u64 = 900;
const CURTA_SECS: u64 = 240;
/// Mesa e mock no Claude: modelo pequeno (centavos por chamada — decisão da mesa).
const MODELO_CURTO: &str = "haiku";

// ---------------------------------------------------------------------------
// pasta e sessões vivas
// ---------------------------------------------------------------------------

/// `~/.constellation/fabrica` (CARDUME_FABRICA_DIR só pra testes).
pub fn fabrica_dir() -> PathBuf {
    std::env::var("CARDUME_FABRICA_DIR").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home_dir_s()).join(".constellation").join("fabrica"))
}
fn live() -> &'static Mutex<HashMap<String, serde_json::Value>> {
    static L: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}
/// Lê a sessão (viva na memória ou do disco).
pub(crate) fn sess_get(dir: &Path, id: &str) -> Result<serde_json::Value, String> {
    if let Some(v) = live().lock().unwrap_or_else(|e| e.into_inner()).get(id) { return Ok(v.clone()); }
    ideia::read_in(dir, id)
}
/// Muda a sessão SOB TRAVA e grava (o pipeline e os cliques da tela nunca se atropelam).
pub(crate) fn sess_edit(dir: &Path, id: &str, f: impl FnOnce(&mut serde_json::Value)) -> Result<serde_json::Value, String> { sess_edit_with(dir, id, true, f) }
/// `persist=false` = só na memória (linha de progresso entre gravações; sessão fora da memória grava sempre).
pub(crate) fn sess_edit_with(dir: &Path, id: &str, persist: bool, f: impl FnOnce(&mut serde_json::Value)) -> Result<serde_json::Value, String> {
    let mut g = live().lock().unwrap_or_else(|e| e.into_inner());
    let mut v = match g.get(id) { Some(v) => v.clone(), None => ideia::read_in(dir, id)? };
    if v.is_null() { return Err("sessão da fábrica não encontrada".into()); }
    f(&mut v);
    v["updatedAt"] = serde_json::json!(now_ms());
    if persist || !g.contains_key(id) { ideia::save_in(dir, id, &v)?; }
    if g.contains_key(id) { g.insert(id.to_string(), v.clone()); }
    Ok(v)
}

// ---------------------------------------------------------------------------
// PURO: texto, JSON, URL, datas
// ---------------------------------------------------------------------------

pub(crate) fn cut(s: &str, n: usize) -> String {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n { s } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>().trim_end()) }
}
fn s_of(v: &serde_json::Value, k: &str) -> String { v[k].as_str().unwrap_or("").trim().to_string() }
fn list_of(v: &serde_json::Value, k: &str, max: usize, n: usize) -> Vec<String> {
    v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| cut(x, n)).filter(|x| !x.is_empty()).take(max).collect()).unwrap_or_default()
}
/// O JSON de uma resposta: dentro de ```json … ``` ou o primeiro {…} cercado de texto (a mesma regra do ideiaJson). PURA.
pub(crate) fn json_in(text: &str) -> Option<serde_json::Value> {
    let mut tries: Vec<&str> = vec![];
    if let Some(i) = text.find("```") {
        let rest = &text[i + 3..];
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        if let Some(j) = rest.find("```") { tries.push(&rest[..j]); }
    }
    if let (Some(i), Some(j)) = (text.find('{'), text.rfind('}')) { if j > i { tries.push(&text[i..=j]); } }
    tries.into_iter().find_map(|t| serde_json::from_str::<serde_json::Value>(t.trim()).ok().filter(|v| v.is_object()))
}
/// Host de uma URL consultável (sem `www.`), ou None: http(s), com ponto, sem espaço, sem localhost e sem domínio de
/// EXEMPLO (fonte inventada). PURA.
pub(crate) fn url_host(u: &str) -> Option<String> {
    let u = u.trim();
    let rest = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://"))?;
    if u.len() > 500 || u.chars().any(char::is_whitespace) { return None; }
    let auth = rest.split(['/', '?', '#']).next()?.split('@').next_back()?;
    if auth.starts_with('[') { return None; } // IPv6 literal (::1, fc00::/7…) nunca é fonte pública
    let host = auth.split(':').next()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if !host.contains('.') || host.starts_with('.') || host.ends_with('.') || host == "localhost" || host.starts_with("127.") { return None; }
    if ip_privado(&host) { return None; }
    if host.split('.').any(|p| p == "example" || p == "exemplo" || p.ends_with("-exemplo") || p.ends_with("-example")) { return None; }
    Some(host)
}
/// IPv4 que não é público: 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10. PURA.
pub(crate) fn ip_privado(host: &str) -> bool {
    let o: Vec<u8> = host.split('.').filter_map(|x| x.parse().ok()).collect();
    if o.len() != 4 || host.split('.').count() != 4 { return false; }
    matches!((o[0], o[1]), (0, _) | (10, _) | (127, _) | (169, 254) | (192, 168)) || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 100 && (64..=127).contains(&o[1]))
}
/// Data legível dd/mm/aaaa a partir de ISO (2026-09-22…) ou já dd/mm/aaaa; "" se não parece data. PURA.
pub(crate) fn data_br(s: &str) -> String {
    // por caractere (nunca fatia byte: texto do modelo pode ter acento/emoji)
    let c: Vec<char> = s.trim().chars().take(10).collect();
    let d = |r: std::ops::Range<usize>| -> Option<String> { let x: String = c.get(r)?.iter().collect(); x.chars().all(|k| k.is_ascii_digit()).then_some(x) };
    if c.len() >= 10 && c[4] == '-' && c[7] == '-' { if let (Some(y), Some(m), Some(dd)) = (d(0..4), d(5..7), d(8..10)) { return format!("{dd}/{m}/{y}"); } }
    if c.len() >= 10 && c[2] == '/' && c[5] == '/' { if let (Some(dd), Some(m), Some(y)) = (d(0..2), d(3..5), d(6..10)) { return format!("{dd}/{m}/{y}"); } }
    if c.len() == 7 && c[4] == '-' { if let (Some(y), Some(m)) = (d(0..4), d(5..7)) { return format!("{m}/{y}"); } }
    String::new()
}
/// ms desde 1970 → dd/mm/aaaa (UTC). PURA.
pub(crate) fn data_ms(ms: i64) -> String {
    let z = (ms / 1000).div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{d:02}/{m:02}/{y:04}")
}
/// Minúsculo, sem acento, só letras/dígitos separados por espaço (o mesmo do `ideiaFold`/`fabFold` do front). PURA.
pub(crate) fn fold(s: &str) -> String {
    memoria::fold(s).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
/// Caminho relativo seguro dentro do projeto (sem `..`, sem absoluto). PURA.
pub(crate) fn rel_ok(p: &str) -> Option<String> {
    let p = p.trim().trim_start_matches("./").replace('\\', "/");
    if p.is_empty() || p.starts_with('/') || p.contains("..") || p.len() > 200 || p.as_bytes().get(1) == Some(&b':') { return None; }
    if p.chars().any(|c| c.is_control() || c == '`' || c == '"') { return None; }
    Some(p)
}

// ---------------------------------------------------------------------------
// PURO: sinais, autores, fontes, triagem
// ---------------------------------------------------------------------------

/// Fonte local conhecida (issue, demanda, texto colado) — autor e data vêm DAQUI, não do modelo.
#[derive(Debug, Clone, Default)]
pub(crate) struct LocalSrc { pub id: String, pub tipo: &'static str, pub origem: String, pub url: String, pub data: String, pub autores: Vec<String>, pub texto: String }

/// Rótulo da tela por tipo de sinal (a tela nunca mistura tipos num número só).
pub(crate) fn tipo_rotulo(t: &str) -> &'static str {
    match t { "user" => "pedido de usuário", "int" => "atrito interno", "code" => "achado de código", "comp" => "concorrente (contexto, não prova)", _ => "sinal" }
}
fn autor_vazio(a: &str) -> bool {
    let f = fold(a);
    f.is_empty() || ["desconhecido", "anonimo", "autor desconhecido", "n a", "na", "usuario", "usuarios", "varios", "nao informado", "unknown", "anonymous"].contains(&f.as_str())
}
/// Um sinal cru do modelo → sinal normalizado, ou None (sem fonte consultável = não aparece). `local` = fontes locais
/// por id; `repo` = projeto (achado de código precisa apontar arquivo que existe). PURA (lê só o disco do repo).
pub(crate) fn sanitize_sinal(s: &serde_json::Value, local: &HashMap<String, LocalSrc>, repo: Option<&Path>) -> Option<serde_json::Value> {
    let t = fold(&s_of(s, "tipo"));
    let texto = cut(&s_of(s, "texto"), 240);
    let origem = s_of(s, "origem");
    let url = s_of(s, "url");
    if t.contains("concorr") || t.contains("compet") {
        let host = url_host(&url)?;
        return Some(serde_json::json!({ "tipo": "comp", "texto": texto, "origem": host, "url": url, "data": data_br(&s_of(s, "data")), "autores": [] }));
    }
    if t.contains("codig") || t.contains("code") || t.contains("tecnic") {
        let repo = repo?;
        let rel = rel_ok(&origem)?;
        let file = rel.split(':').next().unwrap_or("");
        let full = repo.join(file);
        let canon = full.canonicalize().ok()?;
        if file.is_empty() || !canon.is_file() || !canon.starts_with(repo.canonicalize().ok()?) { return None; } // ARQUIVO que existe (pasta ou ":12" não)
        return Some(serde_json::json!({ "tipo": "code", "texto": texto, "origem": rel, "url": "", "data": "", "autores": [] }));
    }
    // humano: fonte local conhecida (id exato) ou página da web consultável
    let key = origem.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if let Some(l) = local.get(&key).or_else(|| local.get(&format!("#{key}"))) {
        return Some(serde_json::json!({ "tipo": l.tipo, "texto": if texto.is_empty() { cut(&l.texto, 200) } else { texto }, "origem": l.origem, "id": l.id, "url": l.url, "data": l.data, "autores": l.autores }));
    }
    let host = url_host(&url)?;
    let mut seen = BTreeSet::new();
    let autores: Vec<String> = s["autores"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| cut(x, 40)).filter(|x| !autor_vazio(x) && seen.insert(fold(x))).take(8).collect()).unwrap_or_default();
    Some(serde_json::json!({ "tipo": "user", "texto": texto, "origem": host, "url": url, "data": data_br(&s_of(s, "data")), "autores": autores }))
}
/// Chave de independência de um sinal: o site (host), a fonte local (id) ou "código" (toda leitura do código é UMA
/// fonte). Menções repetidas do mesmo site contam uma vez. PURA.
pub(crate) fn src_key(s: &serde_json::Value) -> String {
    match s["tipo"].as_str().unwrap_or("") {
        "code" => "code".into(),
        "comp" => format!("comp:{}", s_of(s, "origem")),
        _ => { let id = s_of(s, "id"); if !id.is_empty() { format!("loc:{id}") } else { format!("web:{}", s_of(s, "origem")) } }
    }
}
fn humano(s: &serde_json::Value) -> bool { matches!(s["tipo"].as_str(), Some("user") | Some("int")) }
/// Fontes independentes que contam como evidência (concorrente NÃO conta: é contexto). PURA.
pub(crate) fn fontes_indep(sinais: &[serde_json::Value]) -> usize {
    sinais.iter().filter(|s| s["tipo"].as_str() != Some("comp")).map(src_key).collect::<BTreeSet<_>>().len()
}
/// Autores DISTINTOS dos pedidos humanos: nome conhecido conta uma vez; fonte sem autor conhecido conta como 1 pessoa
/// (no máximo) por fonte. PURA.
pub(crate) fn autores_distintos(sinais: &[serde_json::Value]) -> usize {
    let mut nomes = BTreeSet::new();
    let mut sem_nome = BTreeSet::new();
    let mut com_nome = BTreeSet::new();
    for s in sinais.iter().filter(|s| humano(s)) {
        let k = src_key(s);
        let a: Vec<String> = s["autores"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).filter(|x| !autor_vazio(x)).map(fold).collect()).unwrap_or_default();
        if a.is_empty() { sem_nome.insert(k); } else { com_nome.insert(k); nomes.extend(a); }
    }
    nomes.len() + sem_nome.difference(&com_nome).count()
}
/// Sem NENHUM pedido humano (issue, demanda, texto colado, página com gente pedindo) = "ideia nossa". PURA.
pub(crate) fn ideia_nossa(sinais: &[serde_json::Value]) -> bool { !sinais.iter().any(humano) }
/// "1 pedido de usuário (3 autores) + 1 atrito interno + 1 evidência técnica" — contagem por FONTE, autores à parte. PURA.
pub(crate) fn resumo_sinais(sinais: &[serde_json::Value]) -> String {
    let n = |t: &str| sinais.iter().filter(|s| s["tipo"].as_str() == Some(t)).map(src_key).collect::<BTreeSet<_>>().len();
    let (u, i, c) = (n("user"), n("int"), n("code"));
    let us: Vec<serde_json::Value> = sinais.iter().filter(|s| s["tipo"].as_str() == Some("user")).cloned().collect();
    let au = autores_distintos(&us);
    let mut p = vec![format!("{u} pedido{} de usuário{}", if u == 1 { "" } else { "s" }, if u > 0 { format!(" ({au} autor{})", if au == 1 { "" } else { "es" }) } else { String::new() })];
    if i > 0 { p.push(format!("{i} atrito{} interno{}", if i == 1 { "" } else { "s" }, if i == 1 { "" } else { "s" })); }
    if c > 0 { p.push(format!("{c} evidência{} técnica{}", if c == 1 { "" } else { "s" }, if c == 1 { "" } else { "s" })); }
    p.join(" + ")
}
/// Número que precisaria de fonte (%, dinheiro, "mil usuários") — em problema/risco, sem fonte, vira aviso. PURA.
pub(crate) fn numero_sem_fonte(t: &str) -> bool {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"(?i)(\d[\d.,]*\s*(%|por cento|mil\b|milh|bilh|usu[aá]rios|downloads|clientes))|((us\$|r\$|\$|€)\s*\d)").unwrap()).is_match(t)
}

/// Modo da sessão.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Mode { App, Feature }
impl Mode {
    pub(crate) fn parse(s: &str) -> Mode { if fold(s).starts_with("feat") { Mode::Feature } else { Mode::App } }
    pub(crate) fn id(self) -> &'static str { match self { Mode::App => "app", Mode::Feature => "feature" } }
}

/// Uma oportunidade crua → opção normalizada (sinais limpos, contagens, ideia nossa, escopo, impacto). PURA.
pub(crate) fn normalize_op(o: &serde_json::Value, mode: Mode, local: &HashMap<String, LocalSrc>, repo: Option<&Path>, lidas: &BTreeSet<String>) -> serde_json::Value {
    let mut seen = BTreeSet::new();
    let sinais: Vec<serde_json::Value> = o["sinais"].as_array().map(|a| a.iter()
        .filter_map(|s| sanitize_sinal(s, local, if mode == Mode::Feature { repo } else { None }))
        .filter(|s| mode == Mode::Feature || s["tipo"].as_str() != Some("int"))
        .map(|mut s| { let u = s_of(&s, "url"); if !u.is_empty() && lidas.contains(&u) { s["lida"] = serde_json::json!(true); } s["rotulo"] = serde_json::json!(tipo_rotulo(s["tipo"].as_str().unwrap_or(""))); s })
        .filter(|s| seen.insert(format!("{}|{}|{}", src_key(s), s_of(s, "url"), fold(&s_of(s, "texto")))))
        .take(8).collect()).unwrap_or_default();
    let conc: Vec<serde_json::Value> = o["concorrentes"].as_array().map(|a| a.iter().filter_map(|c| {
        let url = s_of(c, "url"); url_host(&url)?;
        Some(serde_json::json!({ "nome": cut(&s_of(c, "nome"), 60), "url": url, "preco": cut(&s_of(c, "preco"), 60), "reclamacao": cut(&s_of(c, "reclamacao"), 160) }))
    }).take(3).collect()).unwrap_or_default();
    let (problema, risco) = (cut(&s_of(o, "problema"), 280), cut(&s_of(o, "risco"), 220));
    let mut avisos: Vec<String> = vec![];
    if numero_sem_fonte(&problema) { avisos.push("o problema cita número sem fonte — confira".into()); }
    if numero_sem_fonte(&risco) { avisos.push("o risco cita número sem fonte — confira".into()); }
    let tarefas = o["tarefas"].as_u64().or_else(|| o["tarefasPlano"].as_array().map(|a| a.len() as u64)).unwrap_or(0).clamp(0, 12) as usize;
    let mut op = serde_json::json!({
        "titulo": cut(&s_of(o, "titulo"), 90), "problema": problema, "quem": cut(&s_of(o, "quem"), 120),
        "resumoSinais": resumo_sinais(&sinais), "autores": autores_distintos(&sinais), "fontes": fontes_indep(&sinais), "ideiaNossa": ideia_nossa(&sinais),
        "sinais": sinais, "concorrentes": conc, "dentro": list_of(o, "dentro", 5, 80), "fora": list_of(o, "fora", 4, 80),
        "risco": risco, "confianca": match fold(&s_of(o, "confianca")).as_str() { c if c.starts_with("alt") => "alta", c if c.starts_with("baix") => "baixa", _ => "média" },
        "plataforma": cut(&s_of(o, "plataforma"), 20), "tarefas": tarefas, "avisos": avisos,
    });
    if mode == Mode::Feature {
        let paths = |v: &serde_json::Value, max: usize| -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).filter_map(rel_ok).take(max).collect()).unwrap_or_default() };
        let im = &o["impacto"];
        let arquivos = paths(&im["arquivos"], 8);
        let areas = paths(&im["areas"], 6);
        let plano: Vec<serde_json::Value> = o["tarefasPlano"].as_array().map(|a| a.iter().filter_map(|t| {
            let titulo = cut(&s_of(t, "titulo"), 80); if titulo.is_empty() { return None; }
            Some(serde_json::json!({ "titulo": titulo, "owns": paths(&t["owns"], 6), "objetivo": cut(&s_of(t, "objetivo"), 240) }))
        }).take(6).collect()).unwrap_or_default();
        let grande = arquivos.len() >= 8 && areas.len() >= 4 || areas.len() > 5;
        let m = &o["manutencao"];
        let num = |k: &str| m[k].as_u64().unwrap_or(0).min(20);
        op["impacto"] = serde_json::json!({ "arquivos": arquivos, "areas": areas, "naoToca": list_of(im, "naoToca", 5, 60), "regressao": cut(&s_of(im, "regressao"), 240),
            "cobertura": match fold(&s_of(im, "cobertura")).as_str() { c if c.starts_with("sim") => "sim", c if c.starts_with("parc") => "parcial", _ => "não" } });
        op["manutencao"] = serde_json::json!({ "telas": num("telas"), "rotas": num("rotas"), "tabelas": num("tabelas") });
        op["conflitoMemoria"] = serde_json::json!(cut(&s_of(o, "conflitoMemoria"), 220));
        op["tela"] = serde_json::json!({ "nome": cut(&s_of(&o["tela"], "nome"), 40), "navegacao": list_of(&o["tela"], "navegacao", 7, 24), "destaque": cut(&s_of(&o["tela"], "destaque"), 60) });
        op["tarefasPlano"] = serde_json::json!(plano);
        op["grande"] = serde_json::json!(grande);
        op["tarefas"] = serde_json::json!(plano.len()); // contado DEPOIS de filtrar (título vazio sai, máx. 6)
    }
    op
}
/// Passa na triagem? App: ≥2 sites independentes com gente pedindo. Feature: ≥2 fontes independentes (pedido,
/// atrito, código) — ou só achado de código, aí vira "ideia nossa". Devolve o motivo do corte. PURA.
pub(crate) fn passa_triagem(op: &serde_json::Value, mode: Mode) -> Result<(), String> {
    let sinais = op["sinais"].as_array().cloned().unwrap_or_default();
    if op["titulo"].as_str().unwrap_or("").is_empty() { return Err("sem título".into()); }
    if sinais.is_empty() { return Err("nenhum sinal com fonte consultável".into()); }
    let humanos: BTreeSet<String> = sinais.iter().filter(|s| humano(s)).map(src_key).collect();
    match mode {
        Mode::App if humanos.len() >= 2 => Ok(()),
        Mode::App => Err(format!("só {} site com gente pedindo{} (precisa de 2 sites diferentes)", humanos.len(), if humanos.is_empty() { String::new() } else { format!(": {}", humanos.iter().map(|k| k.trim_start_matches("web:")).collect::<Vec<_>>().join(", ")) })),
        Mode::Feature if fontes_indep(&sinais) >= 2 => Ok(()),
        Mode::Feature if humanos.is_empty() && sinais.iter().any(|s| s["tipo"].as_str() == Some("code")) => Ok(()),
        Mode::Feature => Err("só 1 fonte independente (precisa de 2, ou um achado de código rotulado ideia nossa)".into()),
    }
}
/// Triagem: normaliza, corta (com motivo) e ordena — pedido humano antes de ideia nossa; depois autores distintos e
/// fontes. Máximo 3. PURA.
pub(crate) fn triage(raw: &[serde_json::Value], mode: Mode, local: &HashMap<String, LocalSrc>, repo: Option<&Path>, lidas: &BTreeSet<String>) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let mut ok = vec![];
    let mut cortadas = vec![];
    let mut titulos = BTreeSet::new();
    for o in raw.iter().take(10) {
        let op = normalize_op(o, mode, local, repo, lidas);
        if !titulos.insert(fold(op["titulo"].as_str().unwrap_or(""))) { cortadas.push(serde_json::json!({ "titulo": op["titulo"], "motivo": "repetida" })); continue; }
        match passa_triagem(&op, mode) { Ok(()) => ok.push(op), Err(m) => cortadas.push(serde_json::json!({ "titulo": op["titulo"], "motivo": m })) }
    }
    ok.sort_by_key(|o| (o["ideiaNossa"].as_bool().unwrap_or(false), std::cmp::Reverse(o["autores"].as_u64().unwrap_or(0)), std::cmp::Reverse(o["fontes"].as_u64().unwrap_or(0))));
    for o in ok.drain(MAX_OPCOES.min(ok.len())..).collect::<Vec<_>>() { cortadas.push(serde_json::json!({ "titulo": o["titulo"], "motivo": "ficou fora das 3 melhores" })); }
    (ok, cortadas)
}

// ---------------------------------------------------------------------------
// PURO: custo em faixa e teto
// ---------------------------------------------------------------------------

/// US$ por tarefa SEM histórico, por motor/modelo (faixa larga, rotulada "sem histórico"). PURA.
pub(crate) fn por_tarefa_sem_hist(engine: &str, model: &str) -> (f64, f64) {
    let m = model.to_ascii_lowercase();
    match engine {
        "claude" if m.contains("opus") => (4.0, 9.0),
        "claude" if m.contains("haiku") => (0.6, 2.0),
        "claude" => (2.5, 6.0),
        "codex" => (1.0, 4.0),
        "deepseek" => (0.2, 1.0),
        "gateway" => (0.5, 3.0),
        _ => (1.0, 6.0),
    }
}
pub(crate) fn mediana(v: &[f64]) -> Option<f64> {
    let mut x: Vec<f64> = v.iter().copied().filter(|c| c.is_finite() && *c > 0.0).collect();
    if x.is_empty() { return None; }
    x.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = x.len();
    Some(if n % 2 == 1 { x[n / 2] } else { (x[n / 2 - 1] + x[n / 2]) / 2.0 })
}
/// Custo de CONSTRUIR (nunca valor único): nº de tarefas × mediana do projeto (≥3 tarefas com custo; histórico curto =
/// faixa mais larga) ou a faixa por motor. Manter fica de fora — dito nas premissas. PURA.
pub(crate) fn custo_faixa(tarefas: usize, hist: &[f64], engine: &str, model: &str) -> serde_json::Value {
    let n = tarefas.max(1);
    let t = n as f64;
    let pos = hist.iter().filter(|c| c.is_finite() && **c > 0.0).count(); // a mediana só usa custo > 0: a contagem também
    let med = if pos >= 3 { mediana(hist) } else { None };
    let (lo, hi, base) = match med {
        Some(m) => { let larga = pos < 10; (t * m * 0.8, t * m * if larga { 2.0 } else { 1.5 }, format!("mediana do projeto: US$ {} por tarefa ({pos} tarefas no histórico{})", br2(m), if larga { ", histórico curto: faixa larga" } else { "" })) }
        None => { let (a, b) = por_tarefa_sem_hist(engine, model); (t * a, t * b, format!("{} · sem histórico seu", engine_nome(engine))) }
    };
    serde_json::json!({ "min": (lo * 100.0).round() / 100.0, "max": (hi * 100.0).round() / 100.0, "tarefas": n, "medianaProjeto": med, "base": base,
        "premissas": [format!("{n} tarefa{} com a IA de agora", if n == 1 { "" } else { "s" }), "inclui retrabalho do portão (prova por requisito)".to_string(), "não inclui manter: hospedagem, suporte, lojas, domínio".to_string()] })
}
fn engine_nome(e: &str) -> &'static str { match e { "claude" => "Claude", "codex" => "Codex", "deepseek" => "DeepSeek", "gateway" => "gateway", _ => "IA" } }
fn br2(v: f64) -> String { format!("{v:.2}").replace('.', ",") }
/// Quanto a próxima chamada pode gastar: `frac` do que sobra (nunca além do teto); None = parou no teto. PURA.
pub(crate) fn budget_for(gasto: f64, teto: f64, frac: f64) -> Option<f64> {
    let sobra = teto - gasto;
    if !(sobra.is_finite()) || sobra < MIN_CHAMADA { return None; }
    Some(((sobra * frac.clamp(0.05, 1.0)).max(MIN_CHAMADA).min(sobra) * 100.0).floor() / 100.0)
}

// ---------------------------------------------------------------------------
// PURO: mock HTML (kit fixo, validação, documento do iframe)
// ---------------------------------------------------------------------------

/// O kit FIXO que a IA usa (as 3 opções ficam comparáveis). As cores vêm de variáveis `--mk-*` que a tela preenche com
/// os tokens do app ao renderizar (sem cor fixa aqui além do cinza de reserva).
pub(crate) const MOCK_KIT: &str = "Kit de componentes (use SÓ estas classes, sem CSS próprio além de style simples de layout): \
.mk-app (moldura da tela), .mk-top (barra do topo com o nome do produto), .mk-tabs > span (abas; .on = ativa), .mk-h (título), \
.mk-sub (texto secundário), .mk-card (cartão), .mk-list > li (lista; <em> à direita = status), .mk-row (linha flex), \
.mk-btn (botão; .pri = principal), .mk-input (campo, use <div class=\"mk-input\">texto</div>), .mk-tag (etiqueta), \
.mk-grid (grade de cartões), .mk-new (o elemento NOVO, destacado).";
const MOCK_CSS: &str = "*{box-sizing:border-box;margin:0;padding:0}body{font:12px/1.4 -apple-system,system-ui,sans-serif;background:var(--mk-bg,#f3f3f3);color:var(--mk-ink,#222);padding:10px}\
.mk-app{border:1px solid var(--mk-line,#ccc);border-radius:10px;background:var(--mk-card,#fff);overflow:hidden;max-width:520px;margin:0 auto}\
.mk-top{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--mk-line,#ccc);font-weight:700}\
.mk-tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--mk-line,#ccc);flex-wrap:wrap}.mk-tabs span{padding:2px 7px;border-radius:4px;opacity:.6}.mk-tabs .on{opacity:1;background:var(--mk-bg,#eee);font-weight:700}\
.mk-h{font-size:14px;font-weight:700;padding:8px 10px 2px}.mk-sub{opacity:.7;padding:0 10px 6px}.mk-card{border:1px solid var(--mk-line,#ccc);border-radius:7px;padding:8px;margin:6px 10px;background:var(--mk-card,#fff)}\
.mk-list{list-style:none;padding:4px 10px}.mk-list li{display:flex;gap:6px;align-items:center;border:1px solid var(--mk-line,#ccc);border-radius:6px;padding:5px 7px;margin:4px 0}.mk-list li em{margin-left:auto;font-style:normal;font-weight:700}\
.mk-row{display:flex;gap:6px;align-items:center;padding:4px 10px;flex-wrap:wrap}.mk-btn{display:inline-block;border:1px solid var(--mk-line,#bbb);border-radius:6px;padding:4px 9px;font-weight:600}.mk-btn.pri{background:var(--mk-acc,#333);color:var(--mk-on-acc,#fff);border-color:transparent}\
.mk-input{border:1px solid var(--mk-line,#bbb);border-radius:6px;padding:4px 8px;opacity:.8;margin:4px 10px}.mk-tag{display:inline-block;font-size:10px;border:1px solid var(--mk-line,#bbb);border-radius:3px;padding:0 5px}\
.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;padding:6px 10px}.mk-new{outline:2px dashed var(--mk-acc,#333);outline-offset:2px;border-radius:4px}";

/// O corpo do mock dentro da resposta (```html … ``` ou o que estiver entre <body>). PURA.
pub(crate) fn mock_body(text: &str) -> String {
    let mut t = text.trim().to_string();
    if let Some(i) = t.find("```") {
        let rest = &t[i + 3..];
        let rest = rest.strip_prefix("html").unwrap_or(rest);
        if let Some(j) = rest.find("```") { t = rest[..j].trim().to_string(); }
    }
    let low = t.to_ascii_lowercase();
    if let (Some(i), Some(j)) = (low.find("<body"), low.rfind("</body>")) {
        if let Some(k) = low[i..].find('>') { if i + k < j { t = t[i + k + 1..j].trim().to_string(); } }
    }
    t
}
/// Validação do mock ANTES de renderizar: sem script/handler/rede/embutidos, sem dado realista (e-mail, telefone, CPF),
/// tamanho máximo. Devolve os problemas (vazio = ok). PURA — a mesma regra do `fabMockCheck` (fixture dourado).
pub(crate) fn mock_check(body: &str) -> Vec<String> {
    static RS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let rs = RS.get_or_init(|| [
        (r"(?i)<\s*script", "tem <script>"),
        (r"(?i)<\s*(iframe|object|embed|link|meta|base|form|img|video|audio|svg|math|style)\b", "tem elemento proibido (iframe, img, svg, style, form…)"),
        (r#"(?i)\son[a-z]+\s*="#, "tem handler de evento (on…=)"),
        (r"(?i)javascript\s*:", "tem javascript:"),
        (r"(?i)(https?:)?//[a-z0-9.-]+\.[a-z]{2,}", "tem endereço externo"),
        (r"(?i)url\s*\(|@import", "tem url()/@import"),
        (r#"(?i)\s(src|href|action|srcset|poster|data)\s*="#, "tem atributo que carrega recurso (src/href…)"),
        (r"(?i)\b(fetch|xmlhttprequest|websocket|eventsource|import)\s*\(", "tem chamada de rede"),
        (r"(?i)[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}", "tem e-mail (use dados claramente falsos)"),
        (r"\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b", "tem telefone (use dados claramente falsos)"),
        (r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b", "tem CPF (use dados claramente falsos)"),
    ].into_iter().map(|(r, m)| (regex::Regex::new(r).unwrap(), m)).collect());
    let mut out: Vec<String> = vec![];
    if body.trim().len() < 40 { out.push("mock vazio".into()); }
    if body.chars().count() > MOCK_MAX { out.push(format!("mock grande demais ({} caracteres, máx. {MOCK_MAX})", body.chars().count())); }
    for (r, m) in rs.iter() {
        if r.find_iter(body).any(|x| !(m.starts_with("tem e-mail") && x.as_str().to_ascii_lowercase().contains("exemplo"))) { out.push((*m).to_string()); }
    }
    out
}
/// O documento do iframe: CSP sem rede nem script, o kit e o corpo validado. PURA.
pub(crate) fn mock_doc(body: &str) -> String {
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>{MOCK_CSS}</style></head><body>{body}</body></html>")
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

const VARREDURA_SYS: &str = "Você é a Pesquisadora da Fábrica do Starfork: procura DOR DOCUMENTADA e ainda mal atendida, com fonte, e é econômica. Regras inegociáveis: (1) todo sinal tem fonte CONSULTÁVEL: URL de página que você achou ou leu AGORA, ou o id EXATO de uma fonte local listada no pedido; sem fonte, não escreva o sinal; (2) nunca invente número, autor, data ou citação — autor só se a página mostra o nome/apelido; (3) \"concorrente lançou X\" é CONTEXTO, nunca prova de demanda; (4) achado de código é evidência técnica, não pedido de usuário; (5) responda em português do Brasil e SOMENTE com o JSON pedido.";

fn economia(teto: f64) -> &'static str {
    if teto < 1.0 { "Seja MUITO econômica: no máximo 5 buscas e 4 páginas lidas, em sites diferentes." } else if teto < 2.5 { "Seja econômica: no máximo 6 buscas e 6 páginas lidas." } else { "Seja econômica: no máximo 8 buscas e 8 páginas lidas." }
}
const SINAL_APP: &str = r#"{"tipo":"pedido|reclamacao|pagaria","texto":"trecho curto do que a pessoa disse","url":"https://página-lida","data":"aaaa-mm-dd","autores":["apelido como aparece"]}"#;
const SINAL_FEAT: &str = r#"{"tipo":"pedido|atrito|codigo|concorrente","texto":"trecho curto","origem":"id EXATO da fonte local (ex.: #212, D:abc123, colado) ou arquivo:linha pra código","url":"só pra página da web","data":"aaaa-mm-dd","autores":[]}"#;

pub(crate) fn varredura_prompt(cfg: &Cfg, fontes_md: &str, memoria_md: &str) -> String {
    let desc = if cfg.descartes.is_empty() { String::new() } else { format!("\n\nA pessoa já DESCARTOU antes (não repita nada parecido): {}", cfg.descartes.join("; ")) };
    match cfg.mode {
        Mode::App => format!("IDEIA: {}\n\nTAREFA: ache até 6 OPORTUNIDADES de produto novo dentro do foco — dores reais de pessoas (prefira 2025–2026; mais antigo vale, com a data): reviews de 1–3 estrelas de apps existentes, threads de fórum/Reddit com \"existe algo que…?\", \"eu pagaria por…\", gambiarras em planilha. Cada oportunidade PRECISA de sinais de pelo menos 2 SITES diferentes (ex.: um review no capterra.com + uma thread no reddit.com) — 2 páginas do mesmo site contam como 1 fonte e a oportunidade é DESCARTADA pela checagem; então busque em sites diferentes e prefira 3 oportunidades bem fontadas a 6 fracas. Concorrentes entram como contexto (com link e, se a página mostrar, preço e a reclamação recorrente). {}{desc}\n\nResponda SOMENTE com um bloco ```json no formato {{\"oportunidades\":[{{\"titulo\":\"nome curto da solução (até 60 caracteres)\",\"problema\":\"1 frase: quem sofre, quando, o que faz hoje\",\"quem\":\"público\",\"sinais\":[{SINAL_APP}],\"concorrentes\":[{{\"nome\":\"…\",\"url\":\"https://…\",\"preco\":\"como a página diz\",\"reclamacao\":\"…\"}}],\"dentro\":[\"3 a 5 itens do MVP\"],\"fora\":[\"3 itens fora\"],\"plataforma\":\"web|ios|android|mobile\",\"tarefas\":5,\"risco\":\"principal risco\",\"confianca\":\"alta|media|baixa\"}}]}}. \"tarefas\" = nº de tarefas pra construir o MVP (esqueleto + 1 por item).", cfg.foco, economia(cfg.teto)),
        Mode::Feature => format!("IDEIA: {}\nPROJETO: a pasta atual (leia o código só pra entender telas/rotas e achar lacunas; nunca leia .env nem chaves).\n\nFONTES LOCAIS (cite pelo id EXATO entre colchetes, sem o colchete):\n{}\n\nMEMÓRIA DO PROJETO (decisões e regras — RESTRIÇÃO, não sinal; se uma opção contraria uma delas, diga em \"conflitoMemoria\"):\n{}\n\nTAREFA: proponha até 5 FEATURES pra este projeto, partindo de PEDIDO REGISTRADO (issues, texto colado, demandas). Achado de código só complementa; feature só com achado de código é \"ideia nossa\". Pra cada uma, estime o impacto no código (3–8 arquivos principais, áreas/pastas, o que NÃO toca, o que já funciona e precisa ser conferido, se há teste perto: sim/parcial/nao) e quebre em 2–5 tarefas com \"owns\" (pastas/arquivos) que NÃO se sobrepõem. Sem web nesta etapa (concorrentes vêm depois): deixe \"concorrentes\" vazio. {}{desc}\n\nResponda SOMENTE com um bloco ```json no formato {{\"oportunidades\":[{{\"titulo\":\"nome curto (até 60 caracteres)\",\"problema\":\"1 frase: quem sofre, onde no produto, o que faz hoje\",\"sinais\":[{SINAL_FEAT}],\"concorrentes\":[{{\"nome\":\"…\",\"url\":\"https://…\",\"reclamacao\":\"o que lançaram\"}}],\"impacto\":{{\"arquivos\":[\"caminho/relativo\"],\"areas\":[\"pasta/\"],\"naoToca\":[\"área\"],\"regressao\":\"o que já funciona e será conferido\",\"cobertura\":\"sim|parcial|nao\"}},\"tarefasPlano\":[{{\"titulo\":\"…\",\"owns\":[\"pasta/ ou arquivo\"],\"objetivo\":\"1 frase\"}}],\"manutencao\":{{\"telas\":0,\"rotas\":0,\"tabelas\":0}},\"tela\":{{\"nome\":\"nome do produto/tela\",\"navegacao\":[\"itens do menu/abas reais da tela\"],\"destaque\":\"o elemento novo\"}},\"dentro\":[\"3 a 5 itens\"],\"fora\":[\"3 itens\"],\"risco\":\"principal risco de quebrar algo\",\"confianca\":\"alta|media|baixa\",\"conflitoMemoria\":\"\"}}]}}.", cfg.foco, if fontes_md.trim().is_empty() { "(nenhuma fonte local encontrada)" } else { fontes_md }, if memoria_md.trim().is_empty() { "(vazia)" } else { memoria_md }, economia(cfg.teto)),
    }
}
const FIX_PROMPT: &str = "PARE de pesquisar. Devolva AGORA o bloco ```json no formato pedido, só com o que você JÁ leu (pode ter menos oportunidades). Sinal sem fonte consultável fica de fora.";

pub(crate) fn mesa_prompt(ops: &[serde_json::Value], personas: &[serde_json::Value], mode: Mode) -> String {
    let ps: Vec<String> = personas.iter().map(|p| format!("- {} ({}): {}", s_of(p, "nome"), s_of(p, "papel"), cut(&s_of(p, "desc"), 220))).collect();
    let os: Vec<String> = ops.iter().enumerate().map(|(i, o)| format!("{}. {} — {} Sinais: {}.{} Custo: US$ {}–{}. Risco: {}", i + 1, s_of(o, "titulo"), s_of(o, "problema"), s_of(o, "resumoSinais"),
        if o["ideiaNossa"].as_bool().unwrap_or(false) { " (IDEIA NOSSA: ninguém pediu)" } else { "" }, o["custo"]["min"], o["custo"]["max"], s_of(o, "risco"))).collect();
    format!("MESA CURTA da Fábrica ({}). Personas:\n{}\n\nOpções:\n{}\n\nCada persona vota em CADA opção: seguir, talvez ou descartar, com 1 frase do porquê, sem jargão. A Júlia (a cética) dá também a objeção mais forte de cada opção (custo escondido, manutenção, o que quebra). Responda SOMENTE com ```json {{\"votos\":[{{\"opcao\":1,\"persona\":\"Bia\",\"voto\":\"seguir|talvez|descartar\",\"porque\":\"…\"}}],\"objecoes\":[{{\"opcao\":1,\"texto\":\"…\"}}]}}",
        if mode == Mode::App { "app novo" } else { "feature num projeto existente" }, ps.join("\n"), os.join("\n"))
}
/// Votos da mesa → por opção `[{persona, voto: y|m|n, porque}]` + objeção. Persona fora da lista é ignorada. PURA.
pub(crate) fn parse_mesa(v: &serde_json::Value, n_ops: usize, personas: &[serde_json::Value]) -> Vec<(Vec<serde_json::Value>, String)> {
    let nomes: Vec<String> = personas.iter().map(|p| s_of(p, "nome")).collect();
    let mut out: Vec<(Vec<serde_json::Value>, String)> = (0..n_ops).map(|_| (vec![], String::new())).collect();
    for x in v["votos"].as_array().cloned().unwrap_or_default() {
        let i = x["opcao"].as_u64().unwrap_or(0) as usize;
        let p = s_of(&x, "persona");
        let Some(nome) = nomes.iter().find(|n| fold(n) == fold(&p)) else { continue };
        if i == 0 || i > n_ops || out[i - 1].0.iter().any(|y| y["persona"].as_str() == Some(nome)) { continue; }
        let voto = match fold(&s_of(&x, "voto")).as_str() { f if f.starts_with("seg") => "y", f if f.starts_with("desc") => "n", _ => "m" };
        out[i - 1].0.push(serde_json::json!({ "persona": nome, "voto": voto, "porque": cut(&s_of(&x, "porque"), 200) }));
    }
    for x in v["objecoes"].as_array().cloned().unwrap_or_default() {
        let i = x["opcao"].as_u64().unwrap_or(0) as usize;
        if i >= 1 && i <= n_ops { out[i - 1].1 = cut(&s_of(&x, "texto"), 280); }
    }
    out
}
pub(crate) fn mock_prompt(op: &serde_json::Value, mode: Mode, erros: &[String]) -> String {
    let tela = &op["tela"];
    let ancora = if mode == Mode::Feature && !s_of(tela, "nome").is_empty() {
        format!("Desenhe a tela REAL do projeto \"{}\" (abas/menu: {}) com o elemento novo \"{}\" marcado com .mk-new.", s_of(tela, "nome"), list_of(tela, "navegacao", 7, 24).join(", "), s_of(tela, "destaque"))
    } else { "Desenhe a tela principal do produto (1 tela).".into() };
    let fix = if erros.is_empty() { String::new() } else { format!("\n\nA versão anterior foi RECUSADA: {}. Corrija.", erros.join("; ")) };
    format!("Mock de média fidelidade (wireframe) para: {} — {}\nMVP: {}.\n{ancora}\n\n{MOCK_KIT}\n\nRegras: SÓ HTML com essas classes (sem <script>, <style>, <img>, <svg>, links, src/href, nada externo); dados CLARAMENTE FALSOS (\"Pessoa Exemplo 1\", \"Item Exemplo\", valores redondos como 100), nunca nomes, e-mails, telefones ou números realistas; sem gráficos com números nem depoimentos; até 60 linhas. Responda SOMENTE com um bloco ```html com o conteúdo do <body> começando por <div class=\"mk-app\">.{fix}",
        s_of(op, "titulo"), s_of(op, "problema"), list_of(op, "dentro", 5, 80).join("; "))
}

// ---------------------------------------------------------------------------
// fontes locais (feature)
// ---------------------------------------------------------------------------

/// Issues do GitHub (gh com a conta do repo): autor + quem comentou contam como autores. PURA (parse).
pub(crate) fn parse_gh_issues(raw: &str) -> Vec<LocalSrc> {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    v.as_array().map(|a| a.iter().filter_map(|i| {
        let n = i["number"].as_u64()?;
        let mut seen = BTreeSet::new();
        let autores: Vec<String> = std::iter::once(i["author"]["login"].as_str().unwrap_or(""))
            .chain(i["comments"].as_array().map(|c| c.iter().map(|x| x["author"]["login"].as_str().unwrap_or("")).collect::<Vec<_>>()).unwrap_or_default())
            .filter(|x| !x.is_empty() && !x.ends_with("[bot]") && seen.insert(x.to_string())).map(String::from).take(12).collect();
        Some(LocalSrc { id: format!("#{n}"), tipo: "user", origem: format!("issue #{n}"), url: s_of(i, "url"), data: data_br(&s_of(i, "createdAt")), autores,
            texto: format!("{} — {}", cut(&s_of(i, "title"), 120), cut(&s_of(i, "body"), 240)) })
    }).collect()).unwrap_or_default()
}
/// Issues do tracker do time que o front já leu ({code,title,desc,autor,data,url,comentarios}). PURA.
pub(crate) fn parse_tracker(list: &[serde_json::Value]) -> Vec<LocalSrc> {
    list.iter().take(60).filter_map(|i| {
        let code = cut(&s_of(i, "code"), 30); if code.is_empty() { return None; }
        let autor = cut(&s_of(i, "autor"), 40);
        let url = s_of(i, "url");
        Some(LocalSrc { id: code.clone(), tipo: "user", origem: format!("issue {code}"), url: if url_host(&url).is_some() { url } else { String::new() }, data: data_br(&s_of(i, "data")),
            autores: if autor_vazio(&autor) { vec![] } else { vec![autor] }, texto: format!("{} — {}", cut(&s_of(i, "title"), 120), cut(&s_of(i, "desc"), 200)) })
    }).collect()
}
fn gh_issues(repo: &Path) -> Vec<LocalSrc> {
    let mut cmd = super::gh_contas::gh_in(repo);
    cmd.args(["issue", "list", "--state", "open", "--limit", "40", "--json", "number,title,body,author,createdAt,url,comments"]).current_dir(repo).stdin(std::process::Stdio::null());
    match super::output_timeout(cmd, 25) { Ok(o) if o.status.success() => parse_gh_issues(&String::from_utf8_lossy(&o.stdout)), _ => vec![] }
}
/// Demandas e instruções passadas do projeto (atrito interno) + custo por tarefa (mediana do projeto).
fn local_db(repo: &Path) -> (Vec<LocalSrc>, Vec<f64>) {
    let db = repo.join(".cardume").join("state.sqlite");
    let Ok(c) = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return (vec![], vec![]) };
    let _ = c.busy_timeout(std::time::Duration::from_secs(3));
    let mut out = vec![];
    if let Ok(mut st) = c.prepare("SELECT id, title, objective, status, created_at FROM task ORDER BY created_at DESC LIMIT 40") {
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?)));
        if let Ok(rows) = rows { for (id, t, o, s, at) in rows.flatten() {
            out.push(LocalSrc { id: format!("D:{id}"), tipo: "int", origem: format!("demanda {id}"), url: String::new(), data: data_ms(at), autores: vec!["time do projeto".into()], texto: format!("{} [{}] — {}", cut(&t, 100), s, cut(&o, 200)) });
        } }
    }
    if let Ok(mut st) = c.prepare("SELECT id, task_id, text, created_at FROM instruction ORDER BY id DESC LIMIT 30") {
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)));
        if let Ok(rows) = rows { for (id, task, t, at) in rows.flatten() {
            out.push(LocalSrc { id: format!("P:{id}"), tipo: "int", origem: format!("pedido no chat da demanda {task}"), url: String::new(), data: data_ms(at), autores: vec!["time do projeto".into()], texto: cut(&t, 220) });
        } }
    }
    let mut hist = vec![];
    if let Ok(mut st) = c.prepare("SELECT SUM(usd) FROM cost GROUP BY task_id HAVING SUM(usd) > 0") {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, f64>(0)) { hist.extend(rows.flatten()); }
    }
    (out, hist)
}
pub(crate) fn fontes_md(srcs: &[LocalSrc]) -> String {
    srcs.iter().map(|s| format!("- [{}] {} · {}{} — {}", s.id, s.origem, if s.data.is_empty() { "sem data".into() } else { s.data.clone() }, if s.autores.is_empty() { String::new() } else { format!(" · {} autor(es)", s.autores.len()) }, s.texto)).collect::<Vec<_>>().join("\n")
}

// ---------------------------------------------------------------------------
// a sessão
// ---------------------------------------------------------------------------

pub(crate) struct Cfg {
    pub id: String, pub mode: Mode, pub foco: String, pub teto: f64, pub repo: Option<PathBuf>, pub engine: ai_once::AiEngine, pub model: Option<String>,
    pub colado: String, pub tracker: Vec<serde_json::Value>, pub personas: Vec<serde_json::Value>, pub descartes: Vec<String>,
}
/// Contabilidade de uma chamada: Claude = custo real; outros = estimativa pelos tokens (como a mesa).
pub(crate) fn custo_de(r: &serde_json::Value, model: &Option<String>) -> f64 {
    let c = r["costUsd"].as_f64().unwrap_or(0.0);
    if c > 0.0 { return c; }
    let (i, o, k) = (r["inTok"].as_i64().unwrap_or(0), r["outTok"].as_i64().unwrap_or(0), r["cachedTok"].as_i64().unwrap_or(0));
    if i + o > 0 { usage_ledger::estimate_usd(r["engine"].as_str().unwrap_or(""), model.as_deref().unwrap_or(""), i, k, o) } else { 0.0 }
}
/// Pior caso de UMA chamada sem teto interno (Codex/DeepSeek/gateway): entrada ~1 token a cada 3 caracteres (×4 com
/// web: páginas lidas entram no contexto) + 8 mil tokens de saída. Antes de chamar: se não cabe no que sobra, não chama. PURA.
pub(crate) fn pior_caso(engine: &str, model: &str, chars: usize, web: bool) -> f64 {
    let inp = (chars / 3 + 2000) as i64 * if web { 4 } else { 1 };
    usage_ledger::estimate_usd(engine, model, inp, 0, 8000)
}
/// O erro que veio DENTRO do Ok (o Claude cobra e devolve `error`): (mensagem, foi o teto?). PURA.
pub(crate) fn erro_de(r: &serde_json::Value) -> Option<(String, bool)> {
    let e = r["error"].as_str()?.to_string();
    let teto = r["teto"].as_bool().unwrap_or(false) || e.contains("teto");
    Some((e, teto))
}
fn parou(e: &str) -> bool { e.contains(mesa::STOPPED) }

/// O pipeline inteiro (sem AppHandle: o teste de fumaça roda direto). `emit` recebe cada evento de progresso. Grava a
/// sessão no disco a cada mudança de fase/resultado e no máximo 1×/s pras linhas; devolve a sessão final.
pub(crate) fn run_session(cfg: &Cfg, dir: &Path, emit: &dyn Fn(&serde_json::Value)) -> serde_json::Value {
    let id = cfg.id.as_str();
    let gasto = std::cell::Cell::new(0.0f64);
    let ult = std::cell::RefCell::new((String::new(), std::time::Instant::now()));
    let say = |fase: &str, line: &str, url: Option<&str>, reload: bool| {
        let line = cut(line, 160);
        let persist = { let mut u = ult.borrow_mut(); let p = reload || u.0 != fase || u.1.elapsed().as_millis() >= 1000; if p { *u = (fase.to_string(), std::time::Instant::now()); } p };
        let _ = sess_edit_with(dir, id, persist, |v| {
            v["fase"] = serde_json::json!(fase); v["gasto"] = serde_json::json!(gasto.get());
            if !line.is_empty() { let a = v["linhas"].as_array_mut().map(std::mem::take).unwrap_or_default(); let mut a: Vec<_> = a.into_iter().rev().take(29).collect::<Vec<_>>().into_iter().rev().collect(); a.push(serde_json::json!({ "line": line, "url": url })); v["linhas"] = serde_json::json!(a); }
        });
        emit(&serde_json::json!({ "id": id, "fase": fase, "gasto": gasto.get(), "teto": cfg.teto, "line": line, "url": url, "reload": reload }));
    };
    let fim = |status: &str, erro: &str| -> serde_json::Value {
        let v = sess_edit(dir, id, |v| { v["status"] = serde_json::json!(status); v["erro"] = serde_json::json!(erro); v["gasto"] = serde_json::json!(gasto.get()); v["fase"] = serde_json::json!("fim"); v["fimAt"] = serde_json::json!(now_ms()); }).unwrap_or_default();
        emit(&serde_json::json!({ "id": id, "fase": "fim", "status": status, "gasto": gasto.get(), "teto": cfg.teto, "reload": true }));
        v
    };
    let stopped = || mesa::is_stopped(id);
    let key = id.to_string();
    let eng = cfg.engine;
    let claude = eng == ai_once::AiEngine::Claude;
    let curto: Option<String> = if claude { Some(MODELO_CURTO.into()) } else { cfg.model.clone() };
    // páginas que a IA leu AGORA (WebFetch): o sinal com essa URL ganha "lida"
    let lidas: std::cell::RefCell<BTreeSet<String>> = Default::default();
    // uma chamada (com teto) no motor da Ideia. `cwd` = onde roda (o projeto SÓ na leitura de código, sem web).
    #[allow(clippy::too_many_arguments)]
    let call = |sys: &str, prompt: &str, tools: &str, budget: f64, resume: Option<&str>, secs: u64, model: &Option<String>, fase: &str, cwd: &Path| -> Result<serde_json::Value, String> {
        let web = tools.contains("WebSearch");
        // sem teto dentro da chamada (outros motores): o PIOR caso tem que caber no que sobra, senão nem chama
        let est = if claude { budget } else { pior_caso(eng.id(), model.as_deref().unwrap_or(""), sys.len() + prompt.len(), web) };
        if !claude && gasto.get() + est > cfg.teto { return Ok(serde_json::json!({ "error": format!("a próxima chamada pode passar do teto estimado (até ~US$ {}) — parei antes", br2(est)), "teto": true })); }
        let run = ideia::Run { source: "fabrica", cwd, tools, secs, reach: eng == ai_once::AiEngine::Gateway };
        let em = |l: &str, u: Option<&str>| { if let Some(u) = u { lidas.borrow_mut().insert(u.to_string()); } say(fase, l, u, false); };
        let r = if claude { ideia::research_claude_in(&em, &key, sys, prompt, model, Some(budget), resume, &run) } else { ideia::research_other_in(&em, eng, &key, sys, prompt, resume, &run) };
        match r {
            Ok(r) => { gasto.set(gasto.get() + custo_de(&r, model)); Ok(r) }
            // parou/estourou o tempo/caiu no meio: o custo parcial não volta — conta o máximo daquela chamada (conservador)
            Err(e) => { if !e.starts_with("não consegui rodar") { gasto.set(gasto.get() + est); } Err(e) }
        }
    };
    let home = dir.to_path_buf();

    // 1. fontes locais (feature)
    let mut local: HashMap<String, LocalSrc> = HashMap::new();
    let (mut fontes, mut memoria_md, mut hist) = (String::new(), String::new(), vec![]);
    if let (Mode::Feature, Some(repo)) = (cfg.mode, cfg.repo.as_deref()) {
        say("fontes", "lendo issues do GitHub do projeto", None, false);
        let mut srcs = gh_issues(repo);
        let ng = srcs.len();
        srcs.extend(parse_tracker(&cfg.tracker));
        let (db, h) = local_db(repo);
        hist = h;
        let nd = db.len();
        srcs.extend(db);
        if !cfg.colado.trim().is_empty() {
            srcs.push(LocalSrc { id: "colado".into(), tipo: "user", origem: "texto colado por você".into(), url: String::new(), data: data_ms(now_ms()), autores: vec![], texto: cut(&cfg.colado, 6000) });
        }
        say("fontes", &format!("{ng} issue(s) do GitHub · {} do tracker · {nd} demanda(s)/pedido(s) passados{}", cfg.tracker.len().min(60), if cfg.colado.trim().is_empty() { "" } else { " · texto colado" }), None, false);
        let notes = memoria::list_notes(repo, true);
        memoria_md = memoria::build_index(&notes, memoria::INDEX_CAP);
        if !notes.is_empty() { say("fontes", &format!("memória do projeto: {} nota(s) — usadas como restrição", notes.len()), None, false); }
        fontes = fontes_md(&srcs);
        local = srcs.into_iter().map(|s| (s.id.clone(), s)).collect();
    }
    if stopped() { return fim("parada", "você parou a varredura"); }

    // 2. varredura. Feature = DUAS chamadas isoladas: leitura do código (Read/Grep/Glob, segredos negados, SEM web) com
    // o texto não confiável (issues, colado); depois a web (SEM o repositório) só com título+problema — injeção num
    // texto não consegue ler segredo E mandar pra fora na mesma sessão.
    let Some(b) = budget_for(gasto.get(), cfg.teto, frac_varredura(cfg.teto)) else { return fim("teto", "o teto é pequeno demais pra varrer"); };
    let (tools, cwd): (&str, &Path) = match (cfg.mode, eng, cfg.repo.as_deref()) {
        (Mode::Feature, ai_once::AiEngine::Claude, Some(r)) => ("Read,Grep,Glob", r),
        (Mode::Feature, _, Some(r)) => ("", r), // outros motores leem a pasta só-leitura, sem web
        _ => ("WebSearch,WebFetch", &home),
    };
    say("varredura", &format!("{}: {}", if cfg.mode == Mode::Feature { "lendo o projeto" } else { "varrendo" }, cfg.foco), None, false);
    let prompt = varredura_prompt(cfg, &fontes, &memoria_md);
    let sys = mesa::cap_sys(VARREDURA_SYS.to_string());
    let mut teto_hit = false;
    let mut texto = match call(&sys, &prompt, tools, b, None, VARREDURA_SECS, &cfg.model, "varredura", cwd) {
        Err(e) if parou(&e) => return fim("parada", "você parou a varredura"),
        Err(e) => return fim("falhou", &e),
        Ok(v) => match erro_de(&v) {
            None => s_of(&v, "text"),
            Some((err, teto)) => {
                teto_hit = teto;
                // bateu no teto no meio: pede o JSON com o que já leu (sessão retomada, MESMAS ferramentas e instruções:
                // o começo sai do cache — trocar as ferramentas custava mais que a varredura, medido: US$ 0,47 × 0,29)
                let sid = s_of(&v, "sessionId");
                match (teto && claude && !sid.is_empty(), budget_for(gasto.get(), cfg.teto, 0.5)) {
                    (true, Some(b2)) => { say("varredura", "bateu no teto da varredura — juntando o que já leu", None, false);
                        match call(&sys, FIX_PROMPT, tools, b2, Some(&sid), CURTA_SECS, &cfg.model, "varredura", cwd) {
                            Ok(r) => match erro_de(&r) { None => s_of(&r, "text"), Some((e2, _)) => { say("varredura", &cut(&e2, 140), None, false); String::new() } },
                            Err(_) => String::new(),
                        } }
                    _ => return fim(if teto { "teto" } else { "falhou" }, &err),
                }
            }
        },
    };
    if stopped() { return fim("parada", "você parou a varredura"); }
    let parsed = json_in(&texto).and_then(|v| v["oportunidades"].as_array().cloned());
    let mut raw = parsed.clone().unwrap_or_default();
    if parsed.is_none() && !texto.trim().is_empty() && !teto_hit {
        // resposta fora do formato: UMA correção barata, sem pesquisar de novo (nunca depois de bater no teto)
        if let Some(b2) = budget_for(gasto.get(), cfg.teto, 0.3) {
            match call(&sys, &format!("{FIX_PROMPT}\n\nO que você devolveu:\n{}", cut(&texto, 12000)), "", b2, None, CURTA_SECS, &curto, "varredura", &home) {
                Ok(r) => match erro_de(&r) {
                    None => { texto = s_of(&r, "text"); raw = json_in(&texto).and_then(|v| v["oportunidades"].as_array().cloned()).unwrap_or_default(); }
                    Some((e, teto)) => { teto_hit |= teto; say("varredura", &cut(&e, 140), None, false); }
                },
                Err(e) if parou(&e) => return fim("parada", "você parou a varredura"),
                Err(_) => {}
            }
        }
    }
    let found = raw.len();
    if raw.is_empty() {
        // nada no formato: guarda um trecho pra "ver detalhes" (nunca some calado)
        let b = cut(&texto, 1500);
        say("varredura", if b.is_empty() { "a IA terminou sem resposta" } else { "a resposta não trouxe oportunidades no formato pedido" }, None, false);
        let _ = sess_edit(dir, id, |v| v["bruto"] = serde_json::json!(b));
    }
    // 2b. feature: concorrentes na web, numa sessão SEM o repositório (só título + problema)
    if cfg.mode == Mode::Feature && !raw.is_empty() && !teto_hit && eng != ai_once::AiEngine::Gateway && !stopped() {
        if let Some(b2) = budget_for(gasto.get(), cfg.teto, 0.35) {
            say("concorrentes", "olhando concorrentes na web (contexto, não prova)", None, false);
            match call(&sys, &concorrentes_prompt(&raw), "WebSearch,WebFetch", b2, None, CURTA_SECS * 2, &cfg.model, "concorrentes", &home) {
                Ok(r) => match erro_de(&r) {
                    None => if let Some(v) = json_in(&s_of(&r, "text")) { merge_concorrentes(&mut raw, &v); },
                    Some((e, teto)) => { teto_hit |= teto; say("concorrentes", &cut(&e, 140), None, false); }
                },
                Err(e) if parou(&e) => return fim("parada", "você parou a varredura"),
                Err(e) => say("concorrentes", &format!("sem concorrentes: {}", cut(&e, 100)), None, false),
            }
        }
    }

    // 3. triagem (sem IA)
    let (mut ops, cortadas) = triage(&raw, cfg.mode, &local, cfg.repo.as_deref(), &lidas.borrow());
    let eng_id = eng.id();
    let model_s = cfg.model.clone().unwrap_or_default();
    for o in ops.iter_mut() {
        let n = o["tarefas"].as_u64().unwrap_or(0) as usize + 1; // + tarefa 0 (esqueleto / confirmar impacto)
        o["custo"] = custo_faixa(n.max(2), &hist, eng_id, &model_s);
        o["votos"] = serde_json::json!([]); o["objecao"] = serde_json::json!("");
        o["mock"] = serde_json::json!({ "estado": "gerando" });
    }
    let _ = sess_edit(dir, id, |v| { v["encontradas"] = serde_json::json!(found); v["cortadas"] = serde_json::json!(cortadas); v["opcoes"] = serde_json::json!(ops); v["descartes"] = serde_json::json!({}); });
    say("triagem", &format!("{found} oportunidade(s) achada(s), {} com fontes suficientes", ops.len()), None, true);
    if ops.is_empty() {
        return fim(if teto_hit { "teto" } else { "vazia" }, if found == 0 { "a varredura não trouxe nada com fonte" } else { "nenhuma passou na triagem (2 fontes independentes)" });
    }
    if stopped() { return fim("parada", "você parou depois da triagem"); }

    // 4. mesa curta (1 chamada, sem ferramentas)
    if !cfg.personas.is_empty() && !teto_hit {
        match budget_for(gasto.get(), cfg.teto, 0.35) {
            None => teto_hit = true,
            Some(b) => {
                say("mesa", "a mesa está votando em lote", None, false);
                let sys = "Você conduz uma mesa de personas de produto. Fale como cada uma falaria, com franqueza, em português do Brasil, sem jargão. Responda SOMENTE com o JSON pedido.";
                match call(sys, &mesa_prompt(&ops, &cfg.personas, cfg.mode), "", b, None, CURTA_SECS, &curto, "mesa", &home) {
                    Ok(r) => match erro_de(&r) {
                        None => if let Some(v) = json_in(&s_of(&r, "text")) {
                            let n = ops.len();
                            for (o, (votos, obj)) in ops.iter_mut().zip(parse_mesa(&v, n, &cfg.personas)) { o["votos"] = serde_json::json!(votos); o["objecao"] = serde_json::json!(obj); }
                        },
                        Some((e, teto)) => { teto_hit |= teto; say("mesa", &format!("a mesa não votou: {}", cut(&e, 120)), None, false); }
                    },
                    Err(e) if parou(&e) => {}
                    Err(e) => say("mesa", &format!("a mesa não votou: {}", cut(&e, 100)), None, false),
                }
                let snapshot = ops.clone();
                let _ = sess_edit(dir, id, |v| v["opcoes"] = serde_json::json!(snapshot));
                say("mesa", "votos da mesa prontos", None, true);
            }
        }
    }

    // 5. mocks (1 por opção, validados; 1 retentativa — nunca paga de novo depois de bater no teto)
    for i in 0..ops.len() {
        if stopped() { break; }
        let left = (ops.len() - i) as f64;
        let mut erros: Vec<String> = vec![];
        let mut estado = serde_json::json!({ "estado": "indisponivel", "aviso": "mock indisponível" });
        for tentativa in 0..2 {
            if teto_hit { estado = serde_json::json!({ "estado": "indisponivel", "aviso": "mock indisponível: parou no teto" }); break; }
            let Some(b) = budget_for(gasto.get(), cfg.teto, 0.8 / left) else { teto_hit = true; estado = serde_json::json!({ "estado": "indisponivel", "aviso": "mock indisponível: parou no teto" }); break };
            say("mocks", &format!("desenhando o mock {}/{}{}", i + 1, ops.len(), if tentativa > 0 { " (2ª tentativa)" } else { "" }), None, false);
            let sys = "Você desenha wireframes HTML honestos com um kit fixo de componentes. Responda SOMENTE com o bloco ```html pedido.";
            match call(sys, &mock_prompt(&ops[i], cfg.mode, &erros), "", b.min(0.25), None, CURTA_SECS, &curto, "mocks", &home) {
                Ok(r) => match erro_de(&r) {
                    Some((e, teto)) => { teto_hit |= teto; say("mocks", &cut(&e, 140), None, false); estado = serde_json::json!({ "estado": "indisponivel", "aviso": format!("mock indisponível ({})", cut(&e, 80)) }); break; }
                    None => {
                        let body = mock_body(&s_of(&r, "text"));
                        erros = mock_check(&body);
                        if erros.is_empty() {
                            let ancorado = cfg.mode == Mode::Feature && !s_of(&ops[i]["tela"], "nome").is_empty();
                            estado = serde_json::json!({ "estado": "ok", "html": mock_doc(&body), "selo": if cfg.mode == Mode::App { "mock" } else if ancorado { "mock sobre a sua tela" } else { "wireframe isolado" } });
                            break;
                        }
                        estado = serde_json::json!({ "estado": "indisponivel", "aviso": format!("mock indisponível ({})", erros.join("; ")) });
                    }
                },
                Err(e) if parou(&e) => break,
                Err(e) => { estado = serde_json::json!({ "estado": "indisponivel", "aviso": format!("mock indisponível ({})", cut(&e, 80)) }); break; }
            }
        }
        ops[i]["mock"] = estado;
        let snapshot = ops.clone();
        let _ = sess_edit(dir, id, |v| v["opcoes"] = serde_json::json!(snapshot));
        say("mocks", "", None, true);
    }
    for o in ops.iter_mut() { if o["mock"]["estado"] == "gerando" { o["mock"] = serde_json::json!({ "estado": "indisponivel", "aviso": "mock indisponível" }); } }
    let snapshot = ops.clone();
    let _ = sess_edit(dir, id, |v| v["opcoes"] = serde_json::json!(snapshot));
    if stopped() { return fim("parada", "você parou — ficou o que já tinha"); }
    if teto_hit || gasto.get() >= cfg.teto { return fim("teto", &format!("parou no teto de US$ {}", br2(cfg.teto))); }
    fim("pronta", "")
}
/// Concorrentes da FEATURE: a sessão de web recebe só título + problema (nada do repositório nem das issues). PURA.
pub(crate) fn concorrentes_prompt(raw: &[serde_json::Value]) -> String {
    let os: Vec<String> = raw.iter().take(5).enumerate().map(|(i, o)| format!("{}. {} — {}", i + 1, cut(&s_of(o, "titulo"), 80), cut(&s_of(o, "problema"), 200))).collect();
    format!("Pra cada feature abaixo, ache até 2 produtos concorrentes que JÁ têm algo parecido (página pública lida agora, com link). É CONTEXTO, não prova de demanda. Se não achar, deixe a lista vazia. Seja econômica: no máximo 4 buscas e 4 páginas.\n\n{}\n\nResponda SOMENTE com ```json {{\"concorrentes\":[{{\"opcao\":1,\"nome\":\"…\",\"url\":\"https://…\",\"reclamacao\":\"o que lançaram / como fazem\"}}]}}", os.join("\n"))
}
/// Junta os concorrentes (por nº da opção) nas oportunidades cruas. PURA.
pub(crate) fn merge_concorrentes(raw: &mut [serde_json::Value], v: &serde_json::Value) {
    for c in v["concorrentes"].as_array().cloned().unwrap_or_default() {
        let i = c["opcao"].as_u64().unwrap_or(0) as usize;
        if i == 0 || i > raw.len().min(5) { continue; }
        if !raw[i - 1]["concorrentes"].is_array() { raw[i - 1]["concorrentes"] = serde_json::json!([]); }
        if let Some(a) = raw[i - 1]["concorrentes"].as_array_mut() { a.push(c); }
    }
}

// ---------------------------------------------------------------------------
// comandos
// ---------------------------------------------------------------------------

/// Motivos de descarte das últimas sessões (alimentam a próxima varredura).
fn descartes_recentes(dir: &Path) -> Vec<String> {
    let mut l = ideia::list_in(dir);
    l.truncate(12);
    l.iter().filter_map(|x| x["id"].as_str()).filter_map(|id| ideia::read_in(dir, id).ok()).flat_map(|v| {
        let ops = v["opcoes"].as_array().cloned().unwrap_or_default();
        v["descartes"].as_object().cloned().unwrap_or_default().into_iter().filter_map(move |(k, m)| {
            let i: usize = k.parse().ok()?; Some(format!("\"{}\" ({})", s_of(ops.get(i)?, "titulo"), m.as_str().unwrap_or("")))
        }).collect::<Vec<_>>()
    }).take(10).collect()
}
/// Id único mesmo no mesmo milissegundo (contador do processo).
fn new_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("f-{}-{}x", now_ms(), SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
}
fn vivo(id: &str) -> bool { live().lock().unwrap_or_else(|e| e.into_inner()).contains_key(id) }
/// "rodando" sem pipeline vivo (app fechou no meio) vira "interrompida" GRAVADO — e as opções salvas continuam escolhíveis.
fn persist_interrompida(dir: &Path, id: &str, v: &serde_json::Value) -> serde_json::Value {
    if v["status"] != "rodando" || vivo(id) { return v.clone(); }
    sess_edit(dir, id, |v| { v["status"] = serde_json::json!("interrompida"); v["erro"] = serde_json::json!("o app fechou no meio da varredura — ficou o que já tinha; rode de novo pra completar"); }).unwrap_or_else(|_| v.clone())
}
/// Arrumação ao começar: sessões com mais de 30 dias saem; "rodando" órfã vira "interrompida".
pub(crate) const KEEP_DIAS: i64 = 30;
pub(crate) fn arrumar(dir: &Path) {
    let limite = now_ms() - KEEP_DIAS * 86_400_000;
    for x in ideia::list_in(dir) {
        let Some(id) = x["id"].as_str() else { continue };
        if x["updatedAt"].as_i64().unwrap_or(0) < limite && !vivo(id) { let _ = ideia::delete_in(dir, id); continue; }
        if let Ok(v) = ideia::read_in(dir, id) { persist_interrompida(dir, id, &v); }
    }
}

/// Começa uma sessão. Devolve o id na hora; o resto chega pelo evento `fabrica-progress`.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn fabrica_start(app: AppHandle, mode: String, foco: String, teto_usd: Option<f64>, project: Option<String>, model: Option<String>,
    colado: Option<String>, tracker: Option<Vec<serde_json::Value>>, personas: Option<Vec<serde_json::Value>>) -> Result<String, String> {
    let mode = Mode::parse(&mode);
    let foco = cut(&foco, 300);
    if foco.chars().count() < 4 { return Err("diga o foco numa frase (ex.: \"apps pra pequenas clínicas\")".into()); }
    let teto = teto_usd.filter(|t| t.is_finite() && *t > 0.0).unwrap_or(TETO_PADRAO).min(TETO_MAX);
    let repo = project.map(PathBuf::from).filter(|p| p.is_dir());
    if mode == Mode::Feature && repo.is_none() { return Err("abra o projeto da feature primeiro".into()); }
    let engine = ai_once::chat_engine()?;
    if mode == Mode::App && ideia::research_mode(engine, ideia::reach_installed(&ideia::reach_dir())) == "none" { return Err(ideia::NO_WEB_MSG.into()); }
    let dir = fabrica_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("não consegui criar a pasta da fábrica: {e}"))?;
    arrumar(&dir);
    let id = new_id();
    let cfg = Cfg { id: id.clone(), mode, foco: foco.clone(), teto, repo: repo.clone(), engine, model: model.filter(|m| !m.trim().is_empty()), colado: colado.unwrap_or_default(),
        tracker: tracker.unwrap_or_default(), personas: personas.unwrap_or_default(), descartes: descartes_recentes(&dir) };
    let v = serde_json::json!({ "id": id, "v": 1, "titulo": foco, "mode": mode.id(), "foco": foco, "teto": teto, "tetoEstimado": engine != ai_once::AiEngine::Claude, "projeto": repo.as_ref().map(|p| p.display().to_string()), "engine": engine.id(),
        "colado": !cfg.colado.trim().is_empty(), "status": "rodando", "fase": "inicio", "gasto": 0.0, "linhas": [], "opcoes": [], "cortadas": [], "descartes": {}, "createdAt": now_ms(), "updatedAt": now_ms() });
    ideia::save_in(&dir, &id, &v)?;
    live().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), v);
    let _ = mesa::mesa_resume(id.clone());
    std::thread::spawn(move || {
        let em = |p: &serde_json::Value| { let _ = app.emit("fabrica-progress", p.clone()); };
        // guarda: um pânico no pipeline NUNCA deixa a sessão "rodando" pra sempre nem a entrada viva presa
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_session(&cfg, &dir, &em)));
        if r.is_err() {
            let _ = sess_edit(&dir, &cfg.id, |v| { v["status"] = serde_json::json!("falhou"); v["erro"] = serde_json::json!("erro interno na Fábrica — rode de novo"); v["fase"] = serde_json::json!("fim"); });
            em(&serde_json::json!({ "id": cfg.id, "fase": "fim", "status": "falhou", "reload": true }));
        }
        live().lock().unwrap_or_else(|e| e.into_inner()).remove(&cfg.id);
        let _ = mesa::mesa_resume(cfg.id.clone()); // o "parar" desta sessão não fica no registro
    });
    Ok(id)
}
/// A sessão inteira (progresso + resultado). Arquivo de app fechado no meio: "rodando" vira "interrompida" (gravado).
#[tauri::command(async)]
pub fn fabrica_read(id: String) -> Result<serde_json::Value, String> {
    let dir = fabrica_dir();
    let v = sess_get(&dir, &id)?;
    Ok(persist_interrompida(&dir, &id, &v))
}
/// Sessões recentes (mais nova primeiro); as órfãs ficam "interrompida".
#[tauri::command(async)]
pub fn fabrica_list() -> Result<Vec<serde_json::Value>, String> {
    let dir = fabrica_dir();
    for x in ideia::list_in(&dir) { if let Some(id) = x["id"].as_str() { if let Ok(v) = ideia::read_in(&dir, id) { persist_interrompida(&dir, id, &v); } } }
    Ok(ideia::list_in(&dir))
}
#[tauri::command(async)]
pub fn fabrica_stop(id: String) -> Result<bool, String> { Ok(mesa::stop_id(&id)) }
/// Opção existe e a varredura não está rodando (o pipeline regrava as opções). PURA sobre a sessão.
pub(crate) fn opcao_editavel(v: &serde_json::Value, idx: usize, rodando_vivo: bool) -> Result<(), String> {
    if v["opcoes"].get(idx).is_none() { return Err("opção não encontrada".into()); }
    if rodando_vivo { return Err("espere a varredura terminar".into()); }
    Ok(())
}
/// Descarta (motivo) ou desfaz (motivo vazio) uma opção. O motivo entra na próxima varredura.
#[tauri::command(async)]
pub fn fabrica_discard(id: String, idx: usize, motivo: Option<String>) -> Result<serde_json::Value, String> {
    let dir = fabrica_dir();
    let v = persist_interrompida(&dir, &id, &sess_get(&dir, &id)?);
    opcao_editavel(&v, idx, v["status"] == "rodando" && vivo(&id))?;
    let m = cut(motivo.as_deref().unwrap_or(""), 80);
    sess_edit(&dir, &id, |v| {
        if !v["descartes"].is_object() { v["descartes"] = serde_json::json!({}); }
        if m.is_empty() { if let Some(o) = v["descartes"].as_object_mut() { o.remove(&idx.to_string()); } } else { v["descartes"][idx.to_string()] = serde_json::json!(m); }
    })
}
/// Marca a escolha e o que foi criado (também PARCIAL: a criação do épico retoma daqui sem duplicar). Não cria nada.
#[tauri::command(async)]
pub fn fabrica_choose(id: String, idx: usize, criado: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let dir = fabrica_dir();
    let v = persist_interrompida(&dir, &id, &sess_get(&dir, &id)?);
    opcao_editavel(&v, idx, v["status"] == "rodando" && vivo(&id))?;
    sess_edit(&dir, &id, |v| { v["escolha"] = serde_json::json!({ "idx": idx, "at": now_ms(), "criado": criado }); })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn golden() -> serde_json::Value { serde_json::from_str(include_str!("../../tests/fixtures/fabrica-golden.json")).unwrap() }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("starfork-fabrica-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fixture_dourado_igual_ao_front() {
        let g = golden();
        for c in g["sinais"].as_array().unwrap() {
            let s = c["sinais"].as_array().unwrap();
            assert_eq!(autores_distintos(s), c["autores"].as_u64().unwrap() as usize, "autores: {}", c["nome"]);
            assert_eq!(fontes_indep(s), c["fontes"].as_u64().unwrap() as usize, "fontes: {}", c["nome"]);
            assert_eq!(ideia_nossa(s), c["ideiaNossa"].as_bool().unwrap(), "ideia nossa: {}", c["nome"]);
            assert_eq!(resumo_sinais(s), c["resumo"].as_str().unwrap(), "resumo: {}", c["nome"]);
        }
        for c in g["mocks"].as_array().unwrap() {
            let errs = mock_check(c["html"].as_str().unwrap());
            assert_eq!(errs.is_empty(), c["ok"].as_bool().unwrap(), "mock {}: {:?}", c["nome"], errs);
        }
    }

    #[test]
    fn sinal_sem_fonte_consultavel_some() {
        let l = HashMap::new();
        let s = |v: serde_json::Value| sanitize_sinal(&v, &l, None);
        assert!(s(serde_json::json!({"tipo":"pedido","texto":"x","url":""})).is_none(), "sem URL");
        assert!(s(serde_json::json!({"tipo":"pedido","texto":"x","url":"https://forum-exemplo.com.br/t/1"})).is_none(), "domínio de exemplo = inventado");
        assert!(s(serde_json::json!({"tipo":"pedido","texto":"x","url":"http://localhost:3000/a"})).is_none());
        assert!(s(serde_json::json!({"tipo":"concorrente","texto":"x"})).is_none());
        assert!(s(serde_json::json!({"tipo":"codigo","origem":"src/a.ts"})).is_none(), "código sem projeto");
        let ok = s(serde_json::json!({"tipo":"reclamacao","texto":"cobra por profissional","url":"https://www.reddit.com/r/x/1","data":"2026-09-12","autores":["ana","Ana","desconhecido"]})).unwrap();
        assert_eq!(ok["tipo"], "user");
        assert_eq!(ok["origem"], "reddit.com");
        assert_eq!(ok["data"], "12/09/2026");
        assert_eq!(ok["autores"], serde_json::json!(["ana"]), "autor repetido e vazio saem");
    }

    #[test]
    fn fonte_local_usa_o_nosso_autor_e_data() {
        let mut l = HashMap::new();
        l.insert("#212".to_string(), LocalSrc { id: "#212".into(), tipo: "user", origem: "issue #212".into(), url: "https://github.com/o/r/issues/212".into(), data: "22/09/2026".into(), autores: vec!["a".into(), "b".into(), "c".into()], texto: "avise-me".into() });
        let s = sanitize_sinal(&serde_json::json!({"tipo":"pedido","origem":"212","autores":["inventado"],"data":"2020-01-01"}), &l, None).unwrap();
        assert_eq!(s["autores"], serde_json::json!(["a","b","c"]));
        assert_eq!(s["data"], "22/09/2026");
        assert!(sanitize_sinal(&serde_json::json!({"tipo":"pedido","origem":"#999"}), &l, None).is_none(), "id que não existe");
        // código: arquivo precisa existir DENTRO do projeto
        let d = tmp("code");
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.ts"), "x").unwrap();
        assert!(sanitize_sinal(&serde_json::json!({"tipo":"codigo","origem":"src/a.ts:12"}), &l, Some(&d)).is_some());
        assert!(sanitize_sinal(&serde_json::json!({"tipo":"codigo","origem":"src/nao.ts"}), &l, Some(&d)).is_none());
        assert!(sanitize_sinal(&serde_json::json!({"tipo":"codigo","origem":"../etc/passwd"}), &l, Some(&d)).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn triagem_corta_e_ordena() {
        let l = HashMap::new();
        let si = |url: &str, a: &[&str]| serde_json::json!({"tipo":"pedido","texto":"t","url":url,"autores":a});
        let raw = vec![
            serde_json::json!({"titulo":"Uma fonte só","problema":"p","sinais":[si("https://a.com/1",&["x"]), si("https://a.com/2",&["y"])]}),
            serde_json::json!({"titulo":"Duas fontes","problema":"p","sinais":[si("https://a.com/1",&["x"]), si("https://b.org/2",&[])]}),
            serde_json::json!({"titulo":"Muitos autores","problema":"p","sinais":[si("https://a.com/1",&["x","y","z"]), si("https://c.net/9",&["w"])]}),
            serde_json::json!({"titulo":"Sem fonte","problema":"p","sinais":[{"tipo":"pedido","texto":"t"}]}),
        ];
        let (ok, cut) = triage(&raw, Mode::App, &l, None, &BTreeSet::new());
        assert_eq!(ok.iter().map(|o| o["titulo"].as_str().unwrap()).collect::<Vec<_>>(), vec!["Muitos autores", "Duas fontes"]);
        assert_eq!(ok[0]["autores"], 4);
        assert_eq!(cut.len(), 2);
        assert!(cut.iter().any(|c| c["motivo"].as_str().unwrap().contains("só 1 site com gente pedindo: a.com")), "mesmo site 2× = 1 fonte: {cut:?}");
        // feature: só achado de código passa como IDEIA NOSSA, por último
        let d = tmp("tri");
        std::fs::write(d.join("App.tsx"), "x").unwrap();
        let mut lo = HashMap::new();
        lo.insert("#1".to_string(), LocalSrc { id: "#1".into(), tipo: "user", origem: "issue #1".into(), autores: vec!["a".into()], ..Default::default() });
        lo.insert("D:t1".to_string(), LocalSrc { id: "D:t1".into(), tipo: "int", origem: "demanda t1".into(), autores: vec!["time do projeto".into()], ..Default::default() });
        let raw = vec![
            serde_json::json!({"titulo":"Só código","sinais":[{"tipo":"codigo","origem":"App.tsx"}]}),
            serde_json::json!({"titulo":"Pedido + código","sinais":[{"tipo":"pedido","origem":"#1"},{"tipo":"codigo","origem":"App.tsx"}]}),
            serde_json::json!({"titulo":"Só issue","sinais":[{"tipo":"pedido","origem":"#1"}]}),
        ];
        let (ok, cut) = triage(&raw, Mode::Feature, &lo, Some(&d), &BTreeSet::new());
        assert_eq!(ok.iter().map(|o| o["titulo"].as_str().unwrap()).collect::<Vec<_>>(), vec!["Pedido + código", "Só código"]);
        assert_eq!(ok[1]["ideiaNossa"], true);
        assert_eq!(ok[0]["resumoSinais"], "1 pedido de usuário (1 autor) + 1 evidência técnica");
        assert_eq!(cut[0]["titulo"], "Só issue");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn maximo_tres_opcoes() {
        let si = |h: &str| serde_json::json!({"tipo":"pedido","url":format!("https://{h}/x")});
        let raw: Vec<_> = (0..6).map(|i| serde_json::json!({"titulo":format!("op {i}"),"sinais":[si(&format!("a{i}.com")), si(&format!("b{i}.com"))]})).collect();
        let (ok, cut) = triage(&raw, Mode::App, &HashMap::new(), None, &BTreeSet::new());
        assert_eq!(ok.len(), 3);
        assert_eq!(cut.len(), 3);
    }

    #[test]
    fn teto_duro_e_custo_em_faixa() {
        assert_eq!(budget_for(0.0, 3.0, 0.55), Some(1.65));
        assert_eq!(budget_for(2.98, 3.0, 0.5), None, "sobra menor que o mínimo = parou no teto");
        assert_eq!(budget_for(3.2, 3.0, 0.5), None);
        let b = budget_for(2.9, 3.0, 0.9).unwrap();
        assert!(b <= 0.1 + 1e-9, "nunca além do que sobra: {b}");
        let c = custo_faixa(6, &[], "claude", "");
        assert_eq!((c["min"].as_f64().unwrap(), c["max"].as_f64().unwrap()), (15.0, 36.0));
        assert!(c["base"].as_str().unwrap().contains("sem histórico"));
        assert!(c["medianaProjeto"].is_null());
        let c = custo_faixa(5, &[4.0, 4.2, 3.9, 4.1], "claude", "");
        assert_eq!(c["medianaProjeto"].as_f64().unwrap(), 4.05);
        assert!(c["max"].as_f64().unwrap() > c["min"].as_f64().unwrap(), "nunca valor único");
        assert!(c["base"].as_str().unwrap().contains("histórico curto"));
        assert!(c["premissas"].as_array().unwrap().iter().any(|p| p.as_str().unwrap().contains("não inclui manter")));
    }

    #[test]
    fn mock_validado_e_isolado() {
        assert!(mock_check("<div class=\"mk-app\"><div class=\"mk-top\">Produto Exemplo</div><ul class=\"mk-list\"><li>Pessoa Exemplo 1<em>ok</em></li></ul></div>").is_empty());
        for bad in ["<div class=mk-app><script>alert(1)</script>xxxxxxxxxxxxxxxxxxxxxxxx</div>", "<div class=mk-app onclick=\"x()\">xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</div>",
            "<div class=mk-app><img src=\"https://x.com/a.png\">xxxxxxxxxxxxxxxxxxxxxxxx</div>", "<div class=mk-app style=\"background:url(x)\">xxxxxxxxxxxxxxxxxxxxxxxxx</div>",
            "<div class=mk-app>maria.silva@gmail.com xxxxxxxxxxxxxxxxxxxxxxxxxxxx</div>", "<div class=mk-app>(11) 98765-4321 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</div>"] {
            assert!(!mock_check(bad).is_empty(), "{bad}");
        }
        assert!(!mock_check(&format!("<div class=mk-app>{}</div>", "x".repeat(MOCK_MAX))).is_empty(), "grande demais");
        assert!(mock_check("<div class=\"mk-app\">contato@exemplo.com.br xxxxxxxxxxxxxxxxxxxxxxxx</div>").is_empty(), "e-mail de exemplo é falso óbvio");
        assert_eq!(mock_body("aqui:\n```html\n<div class=\"mk-app\">a</div>\n```"), "<div class=\"mk-app\">a</div>");
        let d = mock_doc("<div class=\"mk-app\">a</div>");
        assert!(d.contains("default-src 'none'") && d.contains(".mk-app{"));
    }

    #[test]
    fn mesa_parse_ignora_quem_nao_esta_na_mesa() {
        let ps = vec![serde_json::json!({"nome":"Bia"}), serde_json::json!({"nome":"Júlia"})];
        let v = serde_json::json!({"votos":[{"opcao":1,"persona":"bia","voto":"seguir","porque":"bonito"},{"opcao":1,"persona":"Bia","voto":"descartar"},{"opcao":2,"persona":"Julia","voto":"descartar"},{"opcao":1,"persona":"Zé","voto":"seguir"},{"opcao":9,"persona":"Bia","voto":"seguir"}],"objecoes":[{"opcao":2,"texto":"manter custa"}]});
        let r = parse_mesa(&v, 2, &ps);
        assert_eq!(r[0].0.len(), 1);
        assert_eq!(r[0].0[0]["voto"], "y");
        assert_eq!(r[1].0[0]["persona"], "Júlia");
        assert_eq!(r[1].0[0]["voto"], "n");
        assert_eq!(r[1].1, "manter custa");
    }

    #[test]
    fn json_datas_e_issues() {
        assert_eq!(json_in("blá ```json\n{\"a\":1}\n``` fim").unwrap()["a"], 1);
        assert_eq!(json_in("texto {\"b\":2} texto").unwrap()["b"], 2);
        assert!(json_in("nada").is_none());
        assert_eq!(data_ms(1_759_000_000_000), "27/09/2025");
        assert_eq!(data_br("2026-09-22T10:00:00Z"), "22/09/2026");
        assert_eq!(data_br("ontem"), "");
        let gh = parse_gh_issues(r#"[{"number":212,"title":"Avise-me","body":"quero","author":{"login":"ana"},"createdAt":"2026-09-22T00:00:00Z","url":"https://github.com/o/r/issues/212","comments":[{"author":{"login":"beto"}},{"author":{"login":"ana"}},{"author":{"login":"dependabot[bot]"}}]}]"#);
        assert_eq!(gh[0].id, "#212");
        assert_eq!(gh[0].autores, vec!["ana", "beto"]);
        assert!(numero_sem_fonte("30% das clínicas") && numero_sem_fonte("custa R$ 89") && !numero_sem_fonte("a recepção confirma 1 por 1"));
    }

    #[test]
    fn sessao_no_disco_e_edicao_travada() {
        let d = tmp("sess");
        ideia::save_in(&d, "f-1-abcdx", &serde_json::json!({"status":"pronta","opcoes":[{"titulo":"a"}],"descartes":{}})).unwrap();
        let v = sess_edit(&d, "f-1-abcdx", |v| { v["descartes"]["0"] = serde_json::json!("fora do foco"); }).unwrap();
        assert_eq!(v["descartes"]["0"], "fora do foco");
        assert_eq!(ideia::read_in(&d, "f-1-abcdx").unwrap()["descartes"]["0"], "fora do foco");
        assert!(sess_edit(&d, "f-nao-tem", |_| {}).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn mock_doc_dourado() {
        let g = golden();
        let body = g["mockDoc"]["body"].as_str().unwrap();
        if std::env::var("FAB_PRINT").is_ok() { println!("{}", serde_json::to_string(&mock_doc(body)).unwrap()); }
        assert_eq!(mock_doc(body), g["mockDoc"]["doc"].as_str().unwrap(), "o documento do iframe mudou: atualize o fixture (FAB_PRINT=1)");
        assert!(mock_check(body).is_empty());
    }

    #[test]
    fn feature_normalizada_pelo_fixture() {
        let g = golden();
        let op = normalize_op(&g["featureRaw"], Mode::Feature, &HashMap::new(), None, &BTreeSet::new());
        let want = &g["featureNorm"];
        assert_eq!(op["tarefasPlano"], want["tarefasPlano"], "título vazio sai, ../ sai das owns");
        assert_eq!(op["tarefas"], want["tarefas"], "contado DEPOIS de filtrar");
        assert_eq!(op["manutencao"], want["manutencao"]);
        assert_eq!(op["impacto"], want["impacto"]);
        assert_eq!(op["grande"], false);
    }

    #[test]
    fn local_db_le_demandas_pedidos_e_custo() {
        let d = tmp("db");
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        let c = rusqlite::Connection::open(d.join(".cardume/state.sqlite")).unwrap();
        c.execute_batch("CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE instruction (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, usd REAL NOT NULL);
            INSERT INTO task VALUES ('t1','Exportar CSV','a carteira','done',1759000000000),('t2','Avise-me','módulos','running',1759100000000);
            INSERT INTO instruction (task_id,text,created_at) VALUES ('t1','de novo o CSV sem filtro',1759000000000);
            INSERT INTO cost (task_id,usd) VALUES ('t1',2.0),('t1',1.0),('t2',4.0),('t3',0.0);").unwrap();
        drop(c);
        let (srcs, hist) = local_db(&d);
        assert_eq!(srcs.iter().filter(|s| s.id.starts_with("D:")).count(), 2);
        assert_eq!(srcs[0].id, "D:t2", "mais recente primeiro");
        let p = srcs.iter().find(|s| s.id.starts_with("P:")).unwrap();
        assert_eq!(p.tipo, "int");
        assert_eq!(p.data, "27/09/2025");
        let mut h = hist.clone(); h.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(h, vec![3.0, 4.0], "custo somado por tarefa, zero fora");
        assert!(local_db(&d.join("nao-tem")).0.is_empty(), "sem banco: vazio, sem pânico");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ferramentas_so_da_lista_e_segredos_negados() {
        let a = ideia::research_args_with("S", &None, None, None, "Read, Grep,Bash(rm:*),WebFetch,Write,Edit,NotebookEdit");
        let at = |k: &str| a.iter().position(|x| x == k).map(|i| a[i + 1].clone());
        assert_eq!(at("--tools").as_deref(), Some("Read,Grep,WebFetch"));
        assert_eq!(at("--allowedTools").as_deref(), Some("Read,Grep,WebFetch"));
        let deny = at("--disallowedTools").unwrap();
        for r in ["Read(.env*)", "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)", "Read(**/.ssh/**)", "Read(**/secrets/**)"] { assert!(deny.contains(r), "{r}"); }
        let w = ideia::research_args_with("S", &None, None, None, "WebSearch,WebFetch");
        assert!(!w.iter().any(|x| x == "--disallowedTools"), "sem Read, sem regra de leitura");
        let z = ideia::research_args_with("S", &None, None, None, "Bash");
        assert_eq!(z[z.iter().position(|x| x == "--tools").unwrap() + 1], "");
    }

    #[test]
    fn datas_com_acento_e_emoji_nao_quebram() {
        for s in ["", "é", "2026-09-2é", "ção-09-22T", "12/0é/2026", "🙂🙂🙂🙂-🙂🙂-🙂🙂", "2026-🙂", "aaaa-mm-dd", "2026-09"] { let _ = data_br(s); }
        assert_eq!(data_br("2026-09-2é"), "");
        assert_eq!(data_br("2026-09"), "09/2026");
        assert_eq!(data_br("05/10/2026 às 10h"), "05/10/2026");
    }

    #[test]
    fn host_privado_nao_e_fonte() {
        for u in ["http://10.0.0.5/a", "https://172.16.1.1/x", "https://172.31.255.1", "http://192.168.0.10:8080/", "http://169.254.169.254/latest", "http://[::1]/", "http://[fc00::1]/x", "http://[fd12::3]/", "http://127.0.0.1/", "http://0.0.0.0/"] {
            assert!(url_host(u).is_none(), "{u}");
        }
        assert_eq!(url_host("https://172.32.0.1/a").as_deref(), Some("172.32.0.1"));
        assert_eq!(url_host("https://www.reddit.com/r/x").as_deref(), Some("reddit.com"));
        let t = parse_tracker(&[serde_json::json!({"code":"ABC-1","title":"t","url":"http://192.168.1.2/browse/ABC-1"})]);
        assert_eq!(t[0].url, "", "tracker com URL privada fica sem link");
    }

    #[test]
    fn codigo_precisa_de_arquivo() {
        let d = tmp("arq");
        std::fs::create_dir_all(d.join("src/pasta")).unwrap();
        std::fs::write(d.join("src/a.ts"), "x").unwrap();
        let l = HashMap::new();
        for o in ["src/pasta", "src/pasta/", ":12", "src", ""] { assert!(sanitize_sinal(&serde_json::json!({"tipo":"codigo","origem":o}), &l, Some(&d)).is_none(), "{o}"); }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pior_caso_erro_e_edicao() {
        assert!(pior_caso("codex", "", 30_000, true) > pior_caso("codex", "", 30_000, false));
        assert!(pior_caso("deepseek", "", 0, false) > 0.0);
        assert_eq!(erro_de(&serde_json::json!({"error":"a pesquisa bateu no teto de US$ 1,00"})), Some(("a pesquisa bateu no teto de US$ 1,00".into(), true)));
        assert_eq!(erro_de(&serde_json::json!({"error":"x","teto":true})).unwrap().1, true);
        assert!(erro_de(&serde_json::json!({"text":"ok"})).is_none());
        let v = serde_json::json!({"opcoes":[{"titulo":"a"}]});
        assert!(opcao_editavel(&v, 0, false).is_ok());
        assert!(opcao_editavel(&v, 1, false).is_err());
        assert!(opcao_editavel(&v, 0, true).is_err());
        let ids: BTreeSet<String> = (0..50).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 50, "sem colisão no mesmo ms");
        assert!(ids.iter().all(|i| mesa::ok_id(i) && !i.ends_with("-r")));
    }

    #[test]
    fn interrompida_gravada_e_escolhivel() {
        let d = tmp("int");
        ideia::save_in(&d, "f-9-0x", &serde_json::json!({"status":"rodando","opcoes":[{"titulo":"a"}]})).unwrap();
        let v = persist_interrompida(&d, "f-9-0x", &ideia::read_in(&d, "f-9-0x").unwrap());
        assert_eq!(v["status"], "interrompida");
        assert_eq!(ideia::read_in(&d, "f-9-0x").unwrap()["status"], "interrompida", "gravado, não só devolvido");
        assert!(opcao_editavel(&v, 0, v["status"] == "rodando").is_ok());
        // arrumar: velha sai
        ideia::save_in(&d, "f-1-0x", &serde_json::json!({"status":"pronta","updatedAt":1})).unwrap();
        arrumar(&d);
        assert!(ideia::read_in(&d, "f-1-0x").unwrap().is_null());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn custo_conta_so_historico_positivo() {
        let c = custo_faixa(1, &[0.0, 0.0, 2.0, 2.0, 2.0], "claude", "");
        assert!(c["base"].as_str().unwrap().contains("(3 tarefas no histórico"));
        assert_eq!(c["premissas"][0], "1 tarefa com a IA de agora");
        assert_eq!(custo_faixa(0, &[], "claude", "")["premissas"][0], "1 tarefa com a IA de agora");
    }

    /// FUMAÇA REAL (ignorado por padrão — gasta dinheiro de verdade): uma sessão App com teto US$ 0,50 no Claude.
    /// `cargo test --manifest-path app/src-tauri/Cargo.toml --lib fabrica::tests::fumaca_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn fumaca_real() {
        let d = tmp("fumaca");
        let teto: f64 = std::env::var("FAB_TETO").ok().and_then(|s| s.parse().ok()).unwrap_or(0.5);
        let cfg = Cfg { id: format!("f-{}-fumx", now_ms()), mode: Mode::App, foco: std::env::var("FAB_FOCO").unwrap_or_else(|_| "apps pra pequenas clínicas".into()), teto,
            repo: None, engine: ai_once::AiEngine::Claude, model: Some(std::env::var("FAB_MODEL").unwrap_or_else(|_| "sonnet".into())), colado: String::new(), tracker: vec![],
            personas: ["Bia", "Rafa", "Carla", "Marcos", "Júlia"].iter().map(|n| serde_json::json!({"nome": n, "papel": "", "desc": ""})).collect(), descartes: vec![] };
        let v0 = serde_json::json!({ "id": cfg.id, "status": "rodando", "linhas": [], "opcoes": [], "descartes": {} });
        ideia::save_in(&d, &cfg.id, &v0).unwrap();
        live().lock().unwrap().insert(cfg.id.clone(), v0);
        let t0 = std::time::Instant::now();
        let fin = run_session(&cfg, &d, &|p| eprintln!("[{}] US$ {:.3} {}", p["fase"].as_str().unwrap_or(""), p["gasto"].as_f64().unwrap_or(0.0), p["line"].as_str().unwrap_or("")));
        let mut slim = fin.clone();
        if let Some(a) = slim["opcoes"].as_array_mut() { for o in a { if o["mock"]["html"].is_string() { let n = o["mock"]["html"].as_str().unwrap().len(); o["mock"]["html"] = serde_json::json!(format!("<{n} bytes>")); } } }
        slim["linhas"] = serde_json::json!(null);
        println!("FUMACA status={} gasto=US$ {:.3} teto=US$ {teto} tempo={}s\n{}", fin["status"], fin["gasto"].as_f64().unwrap_or(0.0), t0.elapsed().as_secs(), serde_json::to_string_pretty(&slim).unwrap());
        let out = std::env::var("FAB_OUT").ok();
        if let Some(o) = out { std::fs::write(o, serde_json::to_string_pretty(&fin).unwrap()).unwrap(); }
        assert!(fin["gasto"].as_f64().unwrap_or(0.0) <= teto * 1.15, "gasto muito acima do teto");
    }
}
