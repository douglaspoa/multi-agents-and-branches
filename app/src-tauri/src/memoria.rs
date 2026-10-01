//! CÉREBRO DO PROJETO no app: notas .md ligadas por [[links]] em `.cardume/memoria/`
//! (local) e `.cardume/memoria/time/` (espelho do time, sincronizado pelo JS com a
//! tabela brain_notes). Comandos da aba Memória (listar, ler, gravar, apagar, mover,
//! grafo) e o bloco de contexto injetado nos chats (planner, chat do projeto,
//! orquestrador, nova issue).
//!
//! Formato, relevância, contexto, filtro de segredo e migração ESPELHAM `src/memory.ts`.
//! O fixture `tests/fixtures/memoria-golden/` é conferido aqui (cargo test) E lá (node --test):
//! se um lado mudar sem o outro, o teste quebra. Tamanhos são contados em CARACTERES.
//! Todo acesso a arquivo é TRAVADO dentro de `.cardume/memoria/` (ver `note_path`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::State;

use super::{os_open, repo_or, AppState};

pub const INDEX_CAP: usize = 2500;
pub const NOTES_CAP: usize = 6000;
const NOTE_TYPES: [&str; 6] = ["decisão", "regra", "gotcha", "contexto", "pessoa", "glossário"];

// ---------------------------------------------------------------------------
// texto
// ---------------------------------------------------------------------------

fn clen(s: &str) -> usize { s.chars().count() }
fn cslice(s: &str, n: usize) -> String { s.chars().take(n).collect() }

/// Minúsculo e sem acento (equivale ao NFD + remover diacríticos do TS pro português).
pub fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            'ý' | 'ÿ' => 'y',
            c => c,
        })
        .collect()
}

/// FNV-1a 32 bits sobre os bytes UTF-8 (mesmo hash do TS).
pub fn fnv1a(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

pub fn slugify(s: &str) -> String {
    let f = fold(s);
    let mut out = String::new();
    let mut dash = false;
    for c in f.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let mut out: String = out.trim_end_matches('-').chars().take(60).collect();
    while out.ends_with('-') { out.pop(); }
    if !out.is_empty() { return out; }
    let t = s.trim();
    if t.is_empty() { "nota".into() } else { format!("nota-{}", fnv1a(t)) }
}

fn norm_type(t: &str) -> String {
    let f = fold(t.trim());
    for x in NOTE_TYPES { if fold(x) == f { return x.to_string(); } }
    if f.starts_with("decis") { return "decisão".into(); }
    if f.starts_with("glos") { return "glossário".into(); }
    "contexto".into()
}

const STOP: &[&str] = &[
    "a", "o", "e", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma", "uns", "umas", "que", "se", "por",
    "para", "pra", "pro", "com", "sem", "ao", "aos", "as", "os", "mais", "menos", "muito", "pouco", "como", "quando", "onde", "qual",
    "quais", "isso", "isto", "esse", "essa", "este", "esta", "aqui", "ali", "nao", "sim", "ja", "tem", "ter", "ser", "estar", "foi",
    "era", "sao", "vai", "vou", "the", "and", "for", "with", "from", "this", "that", "you", "are", "was", "were", "not", "but", "all",
    "tarefa", "fazer", "faz", "feito", "deve", "precisa", "quero", "preciso", "sobre", "entre", "depois", "antes", "ainda", "tambem",
    "so", "sempre", "nunca",
];

pub fn terms(s: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for w in fold(s).split(|c: char| !c.is_ascii_alphanumeric()) {
        if w.len() >= 3 && !STOP.contains(&w) && seen.insert(w.to_string()) { out.push(w.to_string()); }
    }
    out
}

fn word_match(word: &str, t: &str) -> bool {
    word == t || (t.len() >= 5 && word.starts_with(t)) || (word.len() >= 5 && t.starts_with(word))
}

// ---------------------------------------------------------------------------
// segredos (mesmos padrões do SECRET_RES do TS, sem crate de regex)
// ---------------------------------------------------------------------------

fn is_word_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' }

/// Cada ocorrência de `prefix` numa fronteira de palavra seguida de ≥`min` bytes de `ok`: (início do trecho, fim).
fn prefixed_runs(s: &str, prefix: &str, ok: impl Fn(u8) -> bool, min: usize) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut from = 0;
    while let Some(i) = s[from..].find(prefix).map(|i| i + from) {
        from = i + 1;
        if i > 0 && is_word_byte(b[i - 1]) { continue; }
        let start = i + prefix.len();
        let mut j = start;
        while j < b.len() && ok(b[j]) { j += 1; }
        if j - start >= min { out.push((start, j)); }
    }
    out
}

pub fn looks_secret(s: &str) -> bool {
    let b = s.as_bytes();
    // -----BEGIN [A-Z ]*PRIVATE KEY-----
    let mut from = 0;
    while let Some(i) = s[from..].find("-----BEGIN ").map(|i| i + from) {
        from = i + 1;
        let rest = &s[i + 11..];
        let head = rest.bytes().take_while(|c| c.is_ascii_uppercase() || *c == b' ').count();
        if rest[..head].ends_with("PRIVATE KEY") && rest[head..].starts_with("-----") { return true; }
    }
    let key = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    if !prefixed_runs(s, "sk-", key, 16).is_empty() { return true; }
    for p in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] { if !prefixed_runs(s, p, |c| c.is_ascii_alphanumeric(), 20).is_empty() { return true; } }
    for p in ["xoxa-", "xoxb-", "xoxp-", "xoxr-"] { if !prefixed_runs(s, p, |c| c.is_ascii_alphanumeric() || c == b'-', 10).is_empty() { return true; } }
    // \bAKIA[0-9A-Z]{16}\b — exatamente 16 e fronteira de palavra depois
    for (st, end) in prefixed_runs(s, "AKIA", |c| c.is_ascii_digit() || c.is_ascii_uppercase(), 16) {
        if end - st == 16 && (end >= b.len() || !is_word_byte(b[end])) { return true; }
    }
    // JWT: eyJ…{10,}.…{10,}.
    for (_, end) in prefixed_runs(s, "eyJ", key, 10) {
        if end < b.len() && b[end] == b'.' {
            let st = end + 1;
            let mut j = st;
            while j < b.len() && key(b[j]) { j += 1; }
            if j - st >= 10 && j < b.len() && b[j] == b'.' { return true; }
        }
    }
    // linha de .env com NOME de credencial
    for line in s.lines() {
        let l = line.trim_start_matches([' ', '\t']);
        let l = l.strip_prefix("export").filter(|r| r.starts_with([' ', '\t'])).map(|r| r.trim_start_matches([' ', '\t'])).unwrap_or(l);
        let name_len = l.bytes().take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_').count();
        let name = &l[..name_len];
        let cred = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "PWD", "CREDENTIAL", "PRIVATE", "AUTH"].iter().any(|k| name.contains(k));
        if name_len == 0 || !cred { continue; }
        let rest = l[name_len..].trim_start_matches([' ', '\t']);
        if let Some(v) = rest.strip_prefix('=') {
            let v = v.trim_start_matches([' ', '\t']);
            let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
            if v.chars().take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'').count() >= 8 { return true; }
        }
    }
    // (api_key|secret|token|password|senha|passwd) : valor ≥8 — sem diferenciar maiúsculas
    let low = s.to_lowercase();
    let lb = low.as_bytes();
    for w in ["api_key", "api-key", "apikey", "secret", "token", "password", "senha", "passwd"] {
        let mut from = 0;
        while let Some(i) = low[from..].find(w).map(|i| i + from) {
            from = i + 1;
            let end = i + w.len();
            if (i > 0 && is_word_byte(lb[i - 1])) || (end < lb.len() && is_word_byte(lb[end])) { continue; }
            let rest = low[end..].trim_start();
            let Some(v) = rest.strip_prefix([':', '=']) else { continue };
            let v = v.trim_start();
            let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
            if v.chars().take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'').count() >= 8 { return true; }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// formato da nota
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub slug: String,
    pub scope: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub tags: Vec<String>,
    pub updated: String,
    pub by: String,
    pub origem: String,
    pub atualizada_por: String,
    pub links: Vec<String>,
    pub mtime_ms: i64,
    pub summary: String,
    /// parece conter segredo: a tela avisa e o sync do time NÃO sobe
    pub secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip)]
    pub text: String,
}

fn unquote(v: &str) -> String {
    let t = v.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        return serde_json::from_str::<String>(t).unwrap_or_else(|_| t[1..t.len() - 1].to_string());
    }
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') { return t[1..t.len() - 1].replace("''", "'"); }
    t.to_string()
}

/// Frontmatter simples: chave → (é lista?, valores); e o corpo.
pub fn parse_frontmatter(text: &str) -> (HashMap<String, (bool, Vec<String>)>, String) {
    let src = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut data: HashMap<String, (bool, Vec<String>)> = HashMap::new();
    if !src.starts_with("---\n") { return (data, src); }
    let Some(end) = src[4..].find("\n---").map(|i| i + 4) else { return (data, src) };
    let head = &src[4..end];
    let mut body = src[end + 4..].to_string();
    if body.starts_with('\n') { body.remove(0); }
    let mut last = String::new();
    for line in head.lines() {
        let tl = line.trim_start();
        if line.starts_with(char::is_whitespace) && tl.starts_with('-') && tl[1..].starts_with(char::is_whitespace) && !last.is_empty() {
            let e = data.entry(last.clone()).or_insert((true, vec![]));
            e.0 = true;
            e.1.push(unquote(tl[1..].trim_start()));
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim_end();
        if key.is_empty() || key.contains(char::is_whitespace) || key.starts_with(|c: char| c.is_ascii_digit() || c == '-') { continue; }
        last = key.to_string();
        let v = line[colon + 1..].trim();
        if v.starts_with('[') && v.ends_with(']') && v.len() >= 2 {
            let items: Vec<String> = v[1..v.len() - 1].split(',').map(unquote).filter(|s| !s.is_empty()).collect();
            data.insert(last.clone(), (true, items));
        } else {
            data.insert(last.clone(), (false, vec![unquote(v)]));
        }
    }
    (data, body)
}

/// Alvos dos [[links]] em slug (aceita [[alvo|apelido]] e [[alvo#seção]]).
pub fn extract_links(body: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut rest = body;
    while let Some(i) = rest.find("[[") {
        let after = &rest[i + 2..];
        let Some(j) = after.find("]]") else { break };
        let inner = &after[..j];
        if !inner.contains('\n') && !inner.contains(']') {
            let target = inner.split(['|', '#']).next().unwrap_or("");
            if !target.is_empty() {
                let s = slugify(target);
                if !out.contains(&s) { out.push(s); }
            }
        }
        rest = &after[j + 2..];
    }
    out
}

/// 1ª linha útil: tira "#… " (títulos) OU "- "/"* " (itens), como o `^#+\s*|^[-*]\s+` do TS; ≤110 chars.
pub fn summary_of(title: &str, body: &str) -> String {
    for l in body.split('\n') {
        let s = if l.starts_with('#') {
            l.trim_start_matches('#').trim_start()
        } else if (l.starts_with('-') || l.starts_with('*')) && l[1..].starts_with(char::is_whitespace) {
            l[1..].trim_start()
        } else {
            l
        };
        let s = s.trim();
        if !s.is_empty() && s != title {
            return cslice(&s.split_whitespace().collect::<Vec<_>>().join(" "), 110);
        }
    }
    String::new()
}

pub fn parse_note(text: &str, slug: &str, scope: &str, mtime_ms: i64) -> Note {
    let (data, body) = parse_frontmatter(text);
    let get = |k: &str| data.get(k).map(|v| v.1.join(", ")).unwrap_or_default().trim().to_string();
    let tags: Vec<String> = match data.get("tags") {
        Some((true, v)) => v.iter().map(|t| t.trim_start_matches('#').trim().to_string()).filter(|t| !t.is_empty()).collect(),
        Some((false, v)) => v.iter().flat_map(|t| t.split(|c: char| c == ',' || c.is_whitespace())).map(|t| t.trim_start_matches('#').trim().to_string()).filter(|t| !t.is_empty()).collect(),
        None => vec![],
    };
    let heading = body.lines().find_map(|l| {
        let r = l.strip_prefix('#')?;
        if !r.starts_with(char::is_whitespace) { return None; }
        let t = r.trim();
        (!t.is_empty()).then(|| t.to_string())
    });
    let title = { let t = get("title"); if !t.is_empty() { t } else { heading.unwrap_or_else(|| slug.to_string()) } };
    let body_t = body.trim().to_string();
    Note {
        slug: slug.to_string(),
        scope: scope.to_string(),
        summary: summary_of(&title, &body_t),
        secret: looks_secret(&title) || looks_secret(&body_t),
        kind: norm_type(&get("type")),
        tags,
        updated: get("updated"),
        by: get("by"),
        origem: if get("origem") == "agente" { "agente".into() } else { "pessoa".into() },
        atualizada_por: get("atualizada_por"),
        links: extract_links(&body_t),
        mtime_ms,
        body: None,
        text: body_t,
        title,
    }
}

// ---------------------------------------------------------------------------
// pastas e caminho travado
// ---------------------------------------------------------------------------

pub fn brain_root(repo: &Path) -> PathBuf { repo.join(".cardume").join("memoria") }

fn scope_dir(repo: &Path, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "local" => Ok(brain_root(repo)),
        "time" => Ok(brain_root(repo).join("time")),
        _ => Err("escopo inválido (use local ou time)".into()),
    }
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Nome de nota NOVA: só um componente de arquivo que funcione em macOS, Linux e Windows.
pub fn valid_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    let n = n.strip_suffix(".md").unwrap_or(n).trim();
    if n.is_empty() || n.chars().count() > 120 { return Err("nome de nota inválido".into()); }
    if n.starts_with('.') || n.ends_with('.') || n.contains("..") || n.chars().any(|c| c.is_control() || "/\\:*?<>|\"".contains(c)) {
        return Err("nome de nota inválido".into());
    }
    let stem = n.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved { return Err("nome reservado pelo Windows".into()); }
    Ok(n.to_string())
}

/// Nome de nota que JÁ existe (criada no Obsidian, por ex.): só barra o que escaparia da pasta.
fn existing_name(name: &str) -> Result<String, String> {
    let n = name.strip_suffix(".md").unwrap_or(name);
    if n.is_empty() || n == "." || n == ".." || n.starts_with('.') || n.contains('/') || n.contains('\\') || n.chars().any(|c| c.is_control()) {
        return Err("nome de nota inválido".into());
    }
    Ok(n.to_string())
}

/// Caminho da nota TRAVADO dentro de `.cardume/memoria/`: nada de symlink (nem quebrado) na
/// pasta, na subpasta do time ou no arquivo. `strict`: nome de arquivo NOVO (regras portáveis);
/// senão aceita o nome de uma nota que já existe.
pub fn note_path(repo: &Path, scope: &str, name: &str, strict: bool) -> Result<PathBuf, String> {
    let dir = scope_dir(repo, scope)?;
    let root = brain_root(repo);
    if is_symlink(&root) || (scope == "time" && is_symlink(&dir)) { return Err("caminho fora da memória do projeto".into()); }
    let loose = existing_name(name)?;
    let exists = std::fs::symlink_metadata(dir.join(format!("{loose}.md"))).is_ok();
    let name = if strict && !exists { valid_name(name)? } else { loose };
    let p = dir.join(format!("{name}.md"));
    if is_symlink(&p) { return Err("caminho fora da memória do projeto".into()); }
    let base = repo.join(".cardume");
    if let (Ok(cd), Ok(cb)) = (dir.canonicalize(), base.canonicalize()) {
        if !cd.starts_with(&cb) { return Err("caminho fora da memória do projeto".into()); }
    }
    if let (Ok(cp), Ok(cb)) = (p.canonicalize(), base.canonicalize()) {
        if !cp.starts_with(&cb) { return Err("caminho fora da memória do projeto".into()); }
    }
    Ok(p)
}

fn mtime_ms(p: &Path) -> i64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn set_mtime(p: &Path, ms: i64) {
    if ms <= 0 { return; }
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(p) {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
        let _ = f.set_modified(t);
    }
}

/// Modo: "time" | "local" | "so-local" e se foi escolhido explicitamente.
pub fn brain_mode(repo: &Path) -> (String, bool) {
    if let Ok(t) = std::fs::read_to_string(repo.join(".cardume").join("memoria.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            if let Some(m) = v.get("mode").and_then(|m| m.as_str()) {
                if ["time", "local", "so-local"].contains(&m) { return (m.to_string(), true); }
            }
        }
    }
    (if brain_root(repo).join("time").is_dir() { "time" } else { "local" }.to_string(), false)
}

/// Cache de notas já parseadas por arquivo (mtime + tamanho): cada turno de chat só dá `stat`.
fn cache() -> &'static Mutex<HashMap<PathBuf, (i64, u64, Note)>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, (i64, u64, Note)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_scope(repo: &Path, scope: &str) -> Vec<Note> {
    let Ok(dir) = scope_dir(repo, scope) else { return vec![] };
    if is_symlink(&brain_root(repo)) || (scope == "time" && is_symlink(&dir)) { return vec![]; }
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    let mut out = vec![];
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    for name in names {
        if !name.ends_with(".md") || name.starts_with('.') || name.starts_with('_') { continue; }
        let p = dir.join(&name);
        let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
        if !md.file_type().is_file() { continue; } // symlink/pasta: fora
        let mt = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
        if let Some((m, l, n)) = c.get(&p) {
            if *m == mt && *l == md.len() && n.scope == scope { out.push(n.clone()); continue; }
        }
        if let Ok(t) = std::fs::read_to_string(&p) {
            let n = parse_note(&t, &name[..name.len() - 3], scope, mt);
            c.insert(p, (mt, md.len(), n.clone()));
            out.push(n);
        }
    }
    out
}

/// Todas as notas (migra o MEMORY.md antigo UMA vez por projeto nesta execução do app).
pub fn list_notes(repo: &Path, include_team: bool) -> Vec<Note> {
    static DONE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let first = DONE.get_or_init(|| Mutex::new(HashSet::new())).lock().unwrap_or_else(|e| e.into_inner()).insert(repo.to_path_buf());
    if first { migrate_legacy(repo); }
    let mut v = read_scope(repo, "local");
    if include_team { v.extend(read_scope(repo, "time")); }
    v
}

// ---------------------------------------------------------------------------
// migração do MEMORY.md (mesma regra do src/memory.ts — conferida pelo fixture)
// ---------------------------------------------------------------------------

/// Data LOCAL (AAAA-MM-DD), como o `today()` do TS.
fn today() -> String {
    #[cfg(unix)]
    {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as libc::time_t).unwrap_or(0);
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        if !unsafe { libc::localtime_r(&now, &mut tm) }.is_null() {
            return format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
        }
    }
    // sem localtime (Windows): data civil UTC
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

fn yaml_word(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' || ('\u{C0}'..='\u{17F}').contains(&c) }

fn yaml_str(s: &str) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let plain = t.chars().next().map(yaml_word).unwrap_or(false)
        && t.chars().all(|c| yaml_word(c) || " .,()/·-".contains(c))
        && !t.contains(": ") && !t.contains(" #");
    if plain { t } else { serde_json::to_string(&t).unwrap_or(t) }
}

pub fn serialize_note(title: &str, kind: &str, tags: &[String], updated: &str, by: &str, origem: &str, body: &str) -> String {
    let tags: Vec<String> = tags.iter().map(|t| yaml_str(t)).collect();
    format!(
        "---\ntitle: {}\ntype: {}\ntags: [{}]\nupdated: {}\nby: {}\norigem: {}\n---\n{}\n",
        yaml_str(title), kind, tags.join(", "), updated, yaml_str(by), origem, body.trim()
    )
}

fn strip_one(s: &str, set: &[char]) -> String {
    match s.chars().last() { Some(c) if set.contains(&c) => s[..s.len() - c.len_utf8()].to_string(), _ => s.to_string() }
}

fn title_from(s: &str) -> String {
    let t: String = s.replace(['*', '_', '`'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    if clen(&t) <= 70 { return strip_one(&t, &['.', ';', ':']); }
    let cut: Vec<char> = t.chars().take(70).collect();
    let sp = cut.iter().rposition(|c| *c == ' ');
    let at = match sp { Some(i) if i > 30 => i, _ => 70 };
    format!("{}…", strip_one(&cut[..at].iter().collect::<String>(), &[',', '.', ';', ':']))
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// (título, tipo, corpo, data) — igual ao `parseLegacyMemory` do TS.
pub fn parse_legacy(txt: &str) -> Vec<(String, String, String, String)> {
    let mut out = vec![];
    let mut loose: Vec<String> = vec![];
    let flush = |loose: &mut Vec<String>, out: &mut Vec<(String, String, String, String)>| {
        let body = loose.join("\n").trim().to_string();
        loose.clear();
        if body.is_empty() { return; }
        let first = body.trim_start_matches('#').trim_start().split('\n').next().unwrap_or("").replace(['*', '_', '`'], "");
        let mut title = cslice(first.trim(), 70);
        if title.is_empty() { title = "Contexto do projeto".into(); }
        out.push((title, "contexto".into(), body, String::new()));
    };
    for raw in txt.replace("\r\n", "\n").split('\n') {
        let line = raw.trim();
        let bullet = (line.starts_with('-') || line.starts_with('*')) && line[1..].starts_with(char::is_whitespace);
        if bullet {
            let rest = line[1..].trim_start();
            let (mut rule, mut date) = (rest.to_string(), String::new());
            if let Some(i) = rest.rfind("_(aprendido") {
                let tail = &rest[i + "_(aprendido".len()..];
                if let Some(mid) = tail.strip_suffix(")_") {
                    let d = mid.trim_start();
                    let before = rest[..i].trim_end();
                    if mid.len() > d.len() && is_date(d) && !before.is_empty() { rule = before.to_string(); date = d.to_string(); }
                }
            }
            if clen(&rule) >= 3 {
                flush(&mut loose, &mut out);
                let rule = rule.trim().to_string();
                out.push((title_from(&rule), "regra".into(), rule, date));
                continue;
            }
        }
        if line.is_empty() { flush(&mut loose, &mut out); continue; }
        loose.push(raw.to_string());
    }
    flush(&mut loose, &mut out);
    out
}

fn bump(slug: &str) -> String {
    match slug.rsplit_once('-') {
        Some((a, b)) if !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()) => match b.parse::<u64>().ok().and_then(|n| n.checked_add(1)) {
            Some(n) => format!("{a}-{n}"),
            None => format!("{slug}-2"),
        },
        _ => format!("{slug}-2"),
    }
}

/// MEMORY.md → uma nota por item (local). O original é renomeado (.migrado), nunca apagado.
pub fn migrate_legacy(repo: &Path) -> usize {
    let legacy = repo.join(".cardume").join("MEMORY.md");
    let Ok(txt) = std::fs::read_to_string(&legacy) else { return 0 };
    let dir = brain_root(repo);
    if is_symlink(&dir) || std::fs::create_dir_all(&dir).is_err() { return 0; }
    let mut n = 0;
    for (title, kind, body, date) in parse_legacy(&txt) {
        let mut slug = slugify(&title);
        for _ in 0..10_000 {
            let p = dir.join(format!("{slug}.md"));
            match std::fs::read_to_string(&p) {
                Ok(cur) => {
                    if fold(parse_note(&cur, &slug, "local", 0).text.trim()) == fold(body.trim()) { break; }
                    slug = bump(&slug);
                }
                Err(_) => break,
            }
        }
        let date = if date.is_empty() { today() } else { date };
        let content = serialize_note(&title, &kind, &["migrado".to_string()], &date, "migrado do MEMORY.md", "pessoa", &body);
        if std::fs::write(dir.join(format!("{slug}.md")), content).is_ok() { n += 1; }
    }
    let _ = std::fs::rename(&legacy, repo.join(".cardume").join("MEMORY.md.migrado"));
    n
}

// ---------------------------------------------------------------------------
// relevância + contexto (espelho de src/memory.ts)
// ---------------------------------------------------------------------------

fn score(n: &Note, q: &[String]) -> usize {
    if q.is_empty() { return 0; }
    let tw = terms(&format!("{} {}", n.title, n.slug.replace('-', " ")));
    let tg = terms(&n.tags.join(" "));
    let bf = fold(&n.text);
    let bw: Vec<&str> = bf.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| w.len() >= 3).collect();
    let mut s = 0;
    for t in q {
        if tw.iter().any(|w| word_match(w, t)) { s += 3; }
        if tg.iter().any(|w| word_match(w, t)) { s += 3; }
        let mut c = 0;
        for w in &bw { if word_match(w, t) { c += 1; if c >= 3 { break; } } }
        s += c;
    }
    s
}

fn type_order(t: &str) -> usize {
    match t { "regra" => 0, "decisão" => 1, "gotcha" => 2, "contexto" => 3, "glossário" => 4, _ => 5 }
}

/// Mesma ordem do TS: TODAS as regras (as que batem primeiro) → as 8 mais relevantes → 1 salto.
pub fn relevant(notes: &[Note], query: &str) -> Vec<usize> {
    let q = terms(query);
    let sc: Vec<usize> = notes.iter().map(|n| score(n, &q)).collect();
    let by_sc = |a: &usize, b: &usize| sc[*b].cmp(&sc[*a]).then(notes[*b].mtime_ms.cmp(&notes[*a].mtime_ms));
    let mut rules: Vec<usize> = (0..notes.len()).filter(|&i| notes[i].kind == "regra").collect();
    rules.sort_by(by_sc);
    let mut scored: Vec<usize> = (0..notes.len()).filter(|&i| sc[i] > 0).collect();
    scored.sort_by(by_sc);
    scored.truncate(8);
    let mut out: Vec<usize> = vec![];
    fn push(i: usize, out: &mut Vec<usize>) { if !out.contains(&i) { out.push(i) } }
    for i in &rules { push(*i, &mut out); }
    for i in &scored { push(*i, &mut out); }
    for i in &scored {
        for l in &notes[*i].links {
            if let Some(j) = notes.iter().position(|n| &n.slug == l) { push(j, &mut out); }
        }
    }
    out
}

pub fn build_index(notes: &[Note], cap: usize) -> String {
    let mut idx: Vec<&Note> = notes.iter().collect();
    idx.sort_by(|a, b| type_order(&a.kind).cmp(&type_order(&b.kind)).then(b.mtime_ms.cmp(&a.mtime_ms)));
    let mut out = String::new();
    let mut used = 0;
    let mut shown = 0;
    for n in &idx {
        let line = format!(
            "- [[{}]] · {}{} · {}{}\n",
            n.slug, n.kind, if n.scope == "time" { " · time" } else { "" }, n.title,
            if n.summary.is_empty() { String::new() } else { format!(" — {}", n.summary) }
        );
        let l = clen(&line);
        if used + l > cap { break; }
        out.push_str(&line);
        used += l;
        shown += 1;
    }
    if shown < idx.len() { out.push_str(&format!("- … mais {} nota(s): grep -ril \"termo\" .cardume/memoria/\n", idx.len() - shown)); }
    out
}

pub fn build_context(notes: &[Note], query: &str, index_cap: usize, notes_cap: usize) -> String {
    if notes.is_empty() { return String::new(); }
    let mut out = format!(
        "## MEMÓRIA DO PROJETO — cérebro de notas (.cardume/memoria/, as do time em .cardume/memoria/time/). Regras e decisões daqui são do humano/time: OBEDEÇA. Pra achar mais: grep -ril \"termo\" .cardume/memoria/\n### Índice\n{}",
        build_index(notes, index_cap)
    );
    let mut budget = notes_cap as i64;
    let mut body = String::new();
    for i in relevant(notes, query) {
        if budget <= 0 { break; }
        let n = &notes[i];
        let block = format!(
            "#### {} ({} · {}{})\n{}\n\n",
            n.title, n.kind, n.scope, if n.updated.is_empty() { String::new() } else { format!(" · {}", n.updated) }, n.text
        );
        let l = clen(&block) as i64;
        if l > budget {
            if budget > 400 && body.is_empty() {
                body.push_str(&cslice(&block, (budget - 20) as usize));
                body.push_str("…\n\n");
                budget = 0; // cortou: acabou o espaço
            }
            continue;
        }
        budget -= l;
        body.push_str(&block);
    }
    if !body.is_empty() { out.push_str("### Notas relevantes pra agora\n"); out.push_str(&body); }
    out.push('\n');
    out
}

/// Contexto de memória pra um prompt de chat (respeita o modo "só local"). "" sem cérebro.
/// Nunca falha: memória não pode derrubar a conversa.
pub fn brain_context(repo: &Path, query: &str) -> String {
    let (mode, _) = brain_mode(repo);
    let notes = list_notes(repo, mode != "so-local");
    build_context(&notes, query, INDEX_CAP, NOTES_CAP)
}

/// Anexa a memória ao system prompt de um chat.
pub fn with_memory(sys: &str, repo: &Path, query: &str) -> String {
    let mem = brain_context(repo, query);
    if mem.is_empty() { sys.to_string() } else { format!("{sys}\n\n{mem}") }
}

// ---------------------------------------------------------------------------
// comandos da aba Memória (todos async: nada de I/O na thread da janela)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn memory_list(state: State<AppState>, repo: Option<String>, with_body: Option<bool>) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    let (mode, explicit) = brain_mode(&repo);
    let mut notes = list_notes(&repo, true);
    if with_body.unwrap_or(false) { for n in notes.iter_mut() { n.body = Some(n.text.clone()); } }
    notes.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(serde_json::json!({
        "mode": mode, "explicitMode": explicit,
        "root": brain_root(&repo).display().to_string(),
        "notes": notes,
    }))
}

#[tauri::command(async)]
pub fn memory_read(state: State<AppState>, repo: Option<String>, scope: String, slug: String) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    let p = note_path(&repo, &scope, &slug, false)?;
    let content = std::fs::read_to_string(&p).map_err(|_| "nota não encontrada".to_string())?;
    Ok(serde_json::json!({ "content": content, "mtimeMs": mtime_ms(&p) }))
}

/// Grava uma nota. Sem `slug` (ou com `create`): nota NOVA com nome único. `expect_mtime`: o mtime que a
/// tela carregou — se o arquivo mudou depois (um agente gravou), a gravação ainda vence (é a mais
/// recente), mas volta `conflict: true` pra tela avisar. `set_mtime_ms`: sync da nuvem (preserva a data).
/// Nota do TIME com cara de segredo é recusada (ela sincronizaria com a nuvem).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn memory_write(
    state: State<AppState>, repo: Option<String>, scope: String, slug: Option<String>, content: String,
    expect_mtime: Option<i64>, set_mtime_ms: Option<i64>, create: Option<bool>,
) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    write_note(&repo, &scope, slug.as_deref(), &content, expect_mtime, set_mtime_ms, create.unwrap_or(false))
}

pub const SECRET_MSG: &str = "essa nota parece conter um segredo (chave, senha ou valor de .env) — notas do time sincronizam com a nuvem; tire o segredo ou salve no cérebro local";

pub fn write_note(repo: &Path, scope: &str, slug: Option<&str>, content: &str, expect_mtime: Option<i64>, set_mtime_ms: Option<i64>, create: bool) -> Result<serde_json::Value, String> {
    if scope == "time" && looks_secret(content) { return Err(SECRET_MSG.into()); }
    let dir = scope_dir(repo, scope)?;
    let base = match slug.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(s) => s.strip_suffix(".md").unwrap_or(s).to_string(),
        None => slugify(&parse_note(content, "nota", scope, 0).title),
    };
    let fresh = create || slug.map(|s| s.trim().is_empty()).unwrap_or(true);
    let mut name = base.clone();
    if fresh {
        let mut i: u32 = 2;
        while std::fs::symlink_metadata(dir.join(format!("{name}.md"))).is_ok() {
            name = format!("{base}-{i}");
            i = i.checked_add(1).ok_or("nomes esgotados")?;
        }
    }
    // trava ANTES de criar qualquer pasta
    let p = note_path(repo, scope, &name, true)?;
    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cur = mtime_ms(&p);
    let conflict = matches!(expect_mtime, Some(e) if e > 0 && cur > e + 1);
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    if let Some(ms) = set_mtime_ms { set_mtime(&p, ms); }
    Ok(serde_json::json!({ "slug": name, "scope": scope, "mtimeMs": mtime_ms(&p), "conflict": conflict }))
}

/// Apaga uma nota — só por ação da PESSOA na aba (agente nunca apaga).
#[tauri::command(async)]
pub fn memory_delete(state: State<AppState>, repo: Option<String>, scope: String, slug: String) -> Result<(), String> {
    let repo = repo_or(&state, repo)?;
    let p = note_path(&repo, &scope, &slug, false)?;
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

/// Move uma nota entre o cérebro local e o do time (selo "local" ↔ "time").
#[tauri::command(async)]
pub fn memory_move(state: State<AppState>, repo: Option<String>, slug: String, from: String, to: String) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    move_note(&repo, &slug, &from, &to)
}

pub fn move_note(repo: &Path, slug: &str, from: &str, to: &str) -> Result<serde_json::Value, String> {
    if from == to { return Err("a nota já está aí".into()); }
    let src = note_path(repo, from, slug, false)?;
    if !src.is_file() { return Err("nota não encontrada".into()); }
    let content = std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
    if to == "time" && looks_secret(&content) { return Err(SECRET_MSG.into()); }
    let dir = scope_dir(repo, to)?;
    let base = existing_name(slug)?;
    let base = valid_name(&base).unwrap_or_else(|_| slugify(&base)); // no destino o nome precisa ser portável
    let mut name = base.clone();
    let mut i: u32 = 2;
    while std::fs::symlink_metadata(dir.join(format!("{name}.md"))).is_ok() {
        name = format!("{base}-{i}");
        i = i.checked_add(1).ok_or("nomes esgotados")?;
    }
    let dst = note_path(repo, to, &name, true)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    std::fs::remove_file(&src).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "slug": name, "scope": to, "mtimeMs": mtime_ms(&dst) }))
}

/// Grafo: nós = notas; arestas = [[links]] (resolvidos no mesmo escopo primeiro); `missing` = links quebrados.
#[tauri::command(async)]
pub fn memory_graph(state: State<AppState>, repo: Option<String>) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    Ok(graph_of(&list_notes(&repo, true)))
}

pub fn graph_of(notes: &[Note]) -> serde_json::Value {
    let id = |n: &Note| format!("{}:{}", n.scope, n.slug);
    let nodes: Vec<serde_json::Value> = notes.iter().map(|n| serde_json::json!({ "id": id(n), "slug": n.slug, "scope": n.scope, "title": n.title, "type": n.kind })).collect();
    let mut edges = vec![];
    let mut missing: Vec<String> = vec![];
    for n in notes {
        for l in &n.links {
            let hit = notes.iter().find(|m| &m.slug == l && m.scope == n.scope).or_else(|| notes.iter().find(|m| &m.slug == l));
            match hit {
                Some(m) => edges.push(serde_json::json!({ "from": id(n), "to": id(m) })),
                None => if !missing.contains(l) { missing.push(l.clone()) },
            }
        }
    }
    serde_json::json!({ "nodes": nodes, "edges": edges, "missing": missing })
}

/// Onde as memórias novas vão: "time" | "local" | "so-local" (agentes ignoram o time).
#[tauri::command(async)]
pub fn memory_set_mode(state: State<AppState>, repo: Option<String>, mode: String) -> Result<(), String> {
    if !["time", "local", "so-local"].contains(&mode.as_str()) { return Err("modo inválido".into()); }
    let repo = repo_or(&state, repo)?;
    let dir = repo.join(".cardume");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("memoria.json"), serde_json::json!({ "mode": mode }).to_string()).map_err(|e| e.to_string())
}

/// A pasta já é um cofre conhecido do Obsidian? (obsidian.json de macOS, Linux/Flatpak ou Windows)
fn obsidian_knows(root: &Path) -> bool {
    let mut cfgs: Vec<PathBuf> = vec![];
    if let Some(h) = std::env::var_os("HOME").map(PathBuf::from) {
        cfgs.push(h.join("Library/Application Support/obsidian/obsidian.json"));
        cfgs.push(h.join(".config/obsidian/obsidian.json"));
        cfgs.push(h.join(".var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json"));
    }
    if let Some(a) = std::env::var_os("APPDATA").map(PathBuf::from) { cfgs.push(a.join("obsidian").join("obsidian.json")); }
    let want = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    for c in cfgs {
        let Ok(t) = std::fs::read_to_string(&c) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { continue };
        if let Some(vs) = v.get("vaults").and_then(|v| v.as_object()) {
            for (_, vault) in vs {
                if let Some(p) = vault.get("path").and_then(|p| p.as_str()) {
                    let pb = PathBuf::from(p);
                    if pb.canonicalize().unwrap_or(pb) == want { return true; }
                }
            }
        }
    }
    false
}

/// Abre o cérebro no Obsidian quando a pasta já é um cofre dele (obsidian://open?path=…, em qualquer
/// SO). Senão abre a PASTA no sistema e devolve "pasta" — a tela explica como abrir como cofre
/// (o obsidian:// com cofre não registrado só mostra um erro do Obsidian).
#[tauri::command(async)]
pub fn memory_open_obsidian(state: State<AppState>, repo: Option<String>) -> Result<String, String> {
    let repo = repo_or(&state, repo)?;
    let root = brain_root(&repo);
    if is_symlink(&root) { return Err("caminho fora da memória do projeto".into()); }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if obsidian_knows(&root) {
        let path = root.display().to_string();
        let enc: String = path.bytes().map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }
        }).collect();
        if os_open(std::ffi::OsStr::new(&format!("obsidian://open?path={enc}"))).is_ok() { return Ok("obsidian".into()); }
    }
    os_open(root.as_os_str()).map_err(|e| e.to_string())?;
    Ok("pasta".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-mem-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        d
    }
    fn gold() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/memoria-golden") }

    #[test]
    fn golden_contexto_igual_ao_ts() {
        let g = gold();
        let cases: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(g.join("cases.json")).unwrap()).unwrap();
        for c in cases.as_array().unwrap() {
            let notes: Vec<Note> = c["notes"].as_array().unwrap().iter().map(|p| {
                let p = p.as_str().unwrap();
                let (sc, f) = p.split_once('/').unwrap();
                parse_note(&std::fs::read_to_string(g.join("notes").join(p)).unwrap(), &f[..f.len() - 3], sc, 0)
            }).collect();
            let got = build_context(&notes, c["query"].as_str().unwrap(), c["index"].as_u64().unwrap() as usize, c["notes_cap"].as_u64().unwrap() as usize);
            let want = std::fs::read_to_string(g.join(c["expected"].as_str().unwrap())).unwrap();
            assert_eq!(got, want, "{}", c["name"]);
        }
    }

    #[test]
    fn golden_migracao_slugs_segredos() {
        let g = gold();
        let want: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(g.join("legacy-expected.json")).unwrap()).unwrap();
        let got: Vec<serde_json::Value> = parse_legacy(&std::fs::read_to_string(g.join("legacy.md")).unwrap())
            .into_iter().map(|(title, kind, body, date)| serde_json::json!({ "title": title, "type": kind, "body": body, "date": date })).collect();
        assert_eq!(serde_json::Value::Array(got), want);
        let slugs: Vec<(String, String)> = serde_json::from_str(&std::fs::read_to_string(g.join("slugs.json")).unwrap()).unwrap();
        for (i, o) in slugs { assert_eq!(slugify(&i), o, "{i}"); }
        let sec: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(g.join("secrets.json")).unwrap()).unwrap();
        for s in sec["secret"].as_array().unwrap() { assert!(looks_secret(s.as_str().unwrap()), "deveria ser segredo: {s}"); }
        for s in sec["benign"].as_array().unwrap() { assert!(!looks_secret(s.as_str().unwrap()), "falso positivo: {s}"); }
    }

    #[test]
    fn caminho_travado_dentro_da_memoria() {
        let repo = tmp_repo("path");
        for bad in ["../x", "..", "a/b", "a\\b", ".oculta", "", "   ", "c:x", "../../etc/passwd", "a*b", "que?", "x<y", "a|b", "a\"b", "CON", "nul", "com1", "LPT9.txt"] {
            assert!(note_path(&repo, "local", bad, true).is_err(), "{bad} deveria falhar");
        }
        assert!(note_path(&repo, "outro", "ok", true).is_err());
        let p = note_path(&repo, "local", "usar-pnpm", true).unwrap();
        assert!(p.ends_with(".cardume/memoria/usar-pnpm.md"));
        let t = note_path(&repo, "time", "ci.md", true).unwrap();
        assert!(t.ends_with(".cardume/memoria/time/ci.md"));
        // nota com nome "estranho" criada fora do app continua abrível (ler/apagar)
        std::fs::create_dir_all(brain_root(&repo)).unwrap();
        std::fs::write(brain_root(&repo).join("O que é? Deploy.md"), "x").unwrap();
        assert!(note_path(&repo, "local", "O que é? Deploy", false).is_ok());
        #[cfg(unix)]
        {
            // symlink de arquivo (inclusive quebrado) e pasta do time apontando pra fora: barrados
            std::os::unix::fs::symlink("/etc/hosts", brain_root(&repo).join("hosts.md")).unwrap();
            assert!(note_path(&repo, "local", "hosts", false).is_err());
            std::os::unix::fs::symlink("/nao/existe", brain_root(&repo).join("quebrado.md")).unwrap();
            assert!(note_path(&repo, "local", "quebrado", true).is_err());
            assert!(write_note(&repo, "local", Some("quebrado"), "x", None, None, false).is_err());
            let fora = std::env::temp_dir().join(format!("sf-mem-fora-{}", std::process::id()));
            std::fs::create_dir_all(&fora).unwrap();
            std::os::unix::fs::symlink(&fora, brain_root(&repo).join("time")).unwrap();
            assert!(note_path(&repo, "time", "x", true).is_err());
            assert!(write_note(&repo, "time", Some("x"), "x", None, None, false).is_err());
            assert!(!fora.join("x.md").exists());
            assert!(read_scope(&repo, "time").is_empty());
            assert!(!read_scope(&repo, "local").iter().any(|n| n.slug == "hosts"));
            let _ = std::fs::remove_dir_all(&fora);
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn nota_frontmatter_links_e_slug() {
        let n = parse_note("---\ntitle: \"API: timeout\"\ntype: Decisao\ntags: [ci, ferramentas]\nby: Ana\norigem: agente\n---\nVer [[Decisão Pagamento|pagto]] e [[ci#jobs]].\n", "api", "local", 1);
        assert_eq!(n.title, "API: timeout");
        assert_eq!(n.kind, "decisão");
        assert_eq!(n.tags, vec!["ci", "ferramentas"]);
        assert_eq!(n.origem, "agente");
        assert_eq!(n.links, vec!["decisao-pagamento", "ci"]);
        assert_eq!(slugify("Usar pnpm, nunca npm!"), "usar-pnpm-nunca-npm");
        assert!(slugify("日本語").starts_with("nota-"));
        assert_eq!(bump("x-18446744073709551615"), "x-18446744073709551615-2");
        let s = serialize_note("Usar pnpm, nunca npm", "regra", &["ferramentas".into()], "2026-09-28", "Douglas", "pessoa", "corpo");
        let back = parse_note(&s, "x", "local", 0);
        assert_eq!(back.title, "Usar pnpm, nunca npm");
        assert_eq!(back.kind, "regra");
    }

    #[test]
    fn gravar_ler_mover_apagar_grafo_e_segredo() {
        let repo = tmp_repo("crud");
        let r = write_note(&repo, "local", None, "---\ntitle: Usar pnpm\ntype: regra\n---\nSempre pnpm. Ver [[ferramentas]] e [[ci]].", None, None, false).unwrap();
        assert_eq!(r["slug"], "usar-pnpm");
        // nota nova com nome já usado → nome único (não sobrescreve a de um colega)
        let r2 = write_note(&repo, "local", Some("usar-pnpm"), "---\ntitle: Outra\n---\nx", None, None, true).unwrap();
        assert_eq!(r2["slug"], "usar-pnpm-2");
        write_note(&repo, "time", Some("ci"), "---\ntitle: CI\n---\nGitHub Actions.", None, Some(1_700_000_000_000), false).unwrap();
        let ci = note_path(&repo, "time", "ci", false).unwrap();
        assert_eq!(mtime_ms(&ci), 1_700_000_000_000, "sync preserva a data da nuvem");
        let c = write_note(&repo, "time", Some("ci"), "---\ntitle: CI\n---\nGitHub Actions e cache.", Some(1_600_000_000_000), None, false).unwrap();
        assert_eq!(c["conflict"], true);
        // segredo não entra no cérebro do time (iria pra nuvem)
        assert!(write_note(&repo, "time", Some("chaves"), "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx", None, None, false).is_err());
        let g = graph_of(&list_notes(&repo, true));
        assert_eq!(g["edges"].as_array().unwrap().len(), 1);
        assert_eq!(g["missing"], serde_json::json!(["ferramentas"]));
        let m = move_note(&repo, "usar-pnpm", "local", "time").unwrap();
        assert_eq!(m["scope"], "time");
        assert!(!note_path(&repo, "local", "usar-pnpm", false).unwrap().exists());
        assert!(note_path(&repo, "time", "usar-pnpm", false).unwrap().exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn cache_ve_edicao_e_migracao_uma_vez() {
        let repo = tmp_repo("mig");
        std::fs::write(repo.join(".cardume/MEMORY.md"), "- Sempre use pnpm, nunca npm _(aprendido 2026-09-01)_\nTexto solto\n").unwrap();
        let notes = list_notes(&repo, true);
        assert_eq!(notes.len(), 2);
        assert!(repo.join(".cardume/MEMORY.md.migrado").exists());
        let ctx = brain_context(&repo, "oi, me ajuda a montar o checkout");
        assert!(ctx.contains("Sempre use pnpm, nunca npm"), "{ctx}");
        // edição no arquivo aparece mesmo com cache
        let p = brain_root(&repo).join("texto-solto.md");
        std::fs::write(&p, "---\ntitle: Texto solto\n---\nconteúdo novo e mais comprido").unwrap();
        set_mtime(&p, 1_800_000_000_000);
        assert!(list_notes(&repo, true).iter().any(|n| n.text.contains("conteúdo novo")));
        // só-local esconde o time
        write_note(&repo, "time", Some("nota-do-time"), "---\ntitle: Nota do time\n---\nabc", None, None, false).unwrap();
        assert!(brain_context(&repo, "x").contains("Nota do time"));
        std::fs::write(repo.join(".cardume/memoria.json"), r#"{"mode":"so-local"}"#).unwrap();
        assert!(!brain_context(&repo, "x").contains("Nota do time"));
        let _ = std::fs::remove_dir_all(&repo);
    }
}
