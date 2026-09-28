//! CÉREBRO DO PROJETO no app: notas .md ligadas por [[links]] em `.cardume/memoria/`
//! (local) e `.cardume/memoria/time/` (espelho do time, sincronizado pelo JS com a
//! tabela brain_notes). Comandos da aba Memória (listar, ler, gravar, apagar, mover,
//! grafo) e o bloco de contexto injetado nos chats (planner, chat do projeto,
//! orquestrador, nova issue).
//!
//! O formato e a relevância espelham `src/memory.ts` (núcleo do motor): mudou lá, mude aqui.
//! Todo acesso a arquivo é TRAVADO dentro de `.cardume/memoria/` (ver `note_path`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::State;

use super::{os_open, repo_or, AppState};

pub const INDEX_CAP: usize = 2500;
pub const NOTES_CAP: usize = 6000;
const NOTE_TYPES: [&str; 6] = ["decisão", "regra", "gotcha", "contexto", "pessoa", "glossário"];

// ---------------------------------------------------------------------------
// texto
// ---------------------------------------------------------------------------

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
    if out.is_empty() { "nota".into() } else { out }
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
        if w.chars().count() >= 3 && !STOP.contains(&w) && seen.insert(w.to_string()) { out.push(w.to_string()); }
    }
    out
}

fn word_match(word: &str, t: &str) -> bool {
    word == t || (t.len() >= 5 && word.starts_with(t)) || (word.len() >= 5 && t.starts_with(word))
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
    pub links: Vec<String>,
    pub mtime_ms: i64,
    pub summary: String,
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

/// Frontmatter simples: (chave → valores, corpo). Escalar vira vetor de 1.
pub fn parse_frontmatter(text: &str) -> (HashMap<String, Vec<String>>, String) {
    let src = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut data: HashMap<String, Vec<String>> = HashMap::new();
    if !src.starts_with("---\n") { return (data, src); }
    let Some(end) = src[4..].find("\n---").map(|i| i + 4) else { return (data, src) };
    let head = &src[4..end];
    let mut body = src[end + 4..].to_string();
    if body.starts_with('\n') { body.remove(0); }
    let mut last = String::new();
    for line in head.lines() {
        let tl = line.trim_start();
        if line.starts_with(char::is_whitespace) && tl.starts_with("- ") && !last.is_empty() {
            data.entry(last.clone()).or_default().push(unquote(&tl[2..]));
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim();
        if key.is_empty() || key.contains(' ') { continue; }
        last = key.to_string();
        let v = line[colon + 1..].trim();
        if v.starts_with('[') && v.ends_with(']') && v.len() >= 2 {
            let items: Vec<String> = v[1..v.len() - 1].split(',').map(unquote).filter(|s| !s.is_empty()).collect();
            data.insert(last.clone(), items);
        } else if v.is_empty() {
            data.insert(last.clone(), vec![]);
        } else {
            data.insert(last.clone(), vec![unquote(v)]);
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
        if !inner.contains('\n') && !inner.contains('[') {
            let target = inner.split(['|', '#']).next().unwrap_or("").trim();
            if !target.is_empty() {
                let s = slugify(target);
                if !out.contains(&s) { out.push(s); }
            }
        }
        rest = &after[j + 2..];
    }
    out
}

fn summary_of(title: &str, body: &str) -> String {
    let line = body
        .lines()
        .map(|l| l.trim_start_matches('#').trim_start_matches(['-', '*']).trim())
        .find(|l| !l.is_empty() && *l != title)
        .unwrap_or("");
    let s: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(110).collect()
}

pub fn parse_note(text: &str, slug: &str, scope: &str, mtime_ms: i64) -> Note {
    let (data, body) = parse_frontmatter(text);
    let get = |k: &str| data.get(k).map(|v| v.join(", ")).unwrap_or_default().trim().to_string();
    let tags: Vec<String> = data
        .get("tags")
        .map(|v| v.iter().flat_map(|t| t.split([',', ' '])).map(|t| t.trim_start_matches('#').trim().to_string()).filter(|t| !t.is_empty()).collect())
        .unwrap_or_default();
    let heading = body.lines().find_map(|l| l.strip_prefix("# ").map(|x| x.trim().to_string()));
    let title = { let t = get("title"); if !t.is_empty() { t } else { heading.unwrap_or_else(|| slug.to_string()) } };
    let body_t = body.trim().to_string();
    Note {
        slug: slug.to_string(),
        scope: scope.to_string(),
        summary: summary_of(&title, &body_t),
        title,
        kind: norm_type(&get("type")),
        tags,
        updated: get("updated"),
        by: get("by"),
        origem: if get("origem") == "agente" { "agente".into() } else { "pessoa".into() },
        links: extract_links(&body_t),
        mtime_ms,
        body: None,
        text: body_t,
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

/// Nome de nota seguro: só um componente de arquivo, sem `..`, barras, ponto inicial ou controle.
pub fn valid_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    let n = n.strip_suffix(".md").unwrap_or(n).trim();
    if n.is_empty() || n.chars().count() > 120 { return Err("nome de nota inválido".into()); }
    if n.starts_with('.') || n.contains("..") || n.contains('/') || n.contains('\\') || n.contains(':') || n.chars().any(|c| c.is_control()) {
        return Err("nome de nota inválido".into());
    }
    Ok(n.to_string())
}

/// Caminho da nota TRAVADO dentro de `.cardume/memoria/` (inclusive contra symlink pra fora).
pub fn note_path(repo: &Path, scope: &str, name: &str) -> Result<PathBuf, String> {
    let name = valid_name(name)?;
    let dir = scope_dir(repo, scope)?;
    let p = dir.join(format!("{name}.md"));
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

fn read_scope(repo: &Path, scope: &str) -> Vec<Note> {
    let Ok(dir) = scope_dir(repo, scope) else { return vec![] };
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut out = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") || name.starts_with('.') || name.starts_with('_') { continue; }
        let p = e.path();
        if !p.is_file() { continue; }
        if let Ok(t) = std::fs::read_to_string(&p) {
            out.push(parse_note(&t, &name[..name.len() - 3], scope, mtime_ms(&p)));
        }
    }
    out
}

/// Todas as notas (migra o MEMORY.md antigo na primeira vez).
pub fn list_notes(repo: &Path, include_team: bool) -> Vec<Note> {
    migrate_legacy(repo);
    let mut v = read_scope(repo, "local");
    if include_team { v.extend(read_scope(repo, "time")); }
    v
}

// ---------------------------------------------------------------------------
// migração do MEMORY.md (mesma regra do src/memory.ts)
// ---------------------------------------------------------------------------

fn today() -> String {
    // data civil (UTC) a partir do epoch — sem depender do `date` do sistema (Windows)
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

fn yaml_str(s: &str) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let plain = !t.is_empty()
        && t.chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false)
        && t.chars().all(|c| c.is_alphanumeric() || " _.,()/·-".contains(c))
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

fn title_from(s: &str) -> String {
    let t: String = s.replace(['*', '_', '`'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= 70 { return t.trim_end_matches(['.', ';', ':']).to_string(); }
    let cut: String = t.chars().take(70).collect();
    let at = cut.rfind(' ').filter(|&i| i > 30).unwrap_or(cut.len());
    format!("{}…", cut[..at].trim_end_matches([',', '.', ';', ':']))
}

/// (título, tipo, corpo, data)
pub fn parse_legacy(txt: &str) -> Vec<(String, String, String, String)> {
    let mut out = vec![];
    let mut loose: Vec<String> = vec![];
    let flush = |loose: &mut Vec<String>, out: &mut Vec<(String, String, String, String)>| {
        let body = loose.join("\n").trim().to_string();
        loose.clear();
        if body.is_empty() { return; }
        let first = body.lines().next().unwrap_or("").trim_start_matches('#').replace(['*', '_', '`'], "");
        let mut title: String = first.trim().chars().take(70).collect();
        if title.is_empty() { title = "Contexto do projeto".into(); }
        out.push((title, "contexto".into(), body, String::new()));
    };
    for raw in txt.replace("\r\n", "\n").lines() {
        let line = raw.trim();
        let bullet = line.strip_prefix("- ").or_else(|| line.strip_prefix("* "));
        if let Some(b) = bullet {
            let mut rule = b.trim().to_string();
            let mut date = String::new();
            if let Some(i) = rule.rfind("_(aprendido ") {
                let tail = &rule[i + 12..];
                if tail.len() >= 12 && tail.ends_with(")_") { date = tail[..tail.len() - 2].trim().to_string(); rule = rule[..i].trim().to_string(); }
            }
            if rule.chars().count() >= 3 {
                flush(&mut loose, &mut out);
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

/// MEMORY.md → uma nota por item (local). O original é renomeado (.migrado), nunca apagado.
pub fn migrate_legacy(repo: &Path) -> usize {
    let legacy = repo.join(".cardume").join("MEMORY.md");
    let Ok(txt) = std::fs::read_to_string(&legacy) else { return 0 };
    let dir = brain_root(repo);
    if std::fs::create_dir_all(&dir).is_err() { return 0; }
    let mut n = 0;
    for (title, kind, body, date) in parse_legacy(&txt) {
        let mut slug = slugify(&title);
        loop {
            let p = dir.join(format!("{slug}.md"));
            match std::fs::read_to_string(&p) {
                Ok(cur) => {
                    if fold(parse_note(&cur, &slug, "local", 0).text.trim()) == fold(body.trim()) { break; }
                    slug = match slug.rsplit_once('-') {
                        Some((a, b)) if b.parse::<u32>().is_ok() => format!("{a}-{}", b.parse::<u32>().unwrap() + 1),
                        _ => format!("{slug}-2"),
                    };
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

pub fn relevant(notes: &[Note], query: &str) -> Vec<usize> {
    let q = terms(query);
    let mut scored: Vec<(usize, usize)> = notes.iter().enumerate().map(|(i, n)| (i, score(n, &q))).filter(|x| x.1 > 0).collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(notes[b.0].mtime_ms.cmp(&notes[a.0].mtime_ms)));
    scored.truncate(8);
    let mut out: Vec<usize> = vec![];
    fn push(i: usize, out: &mut Vec<usize>) { if !out.contains(&i) { out.push(i) } }
    for (i, _) in &scored { push(*i, &mut out); }
    for (i, _) in &scored {
        for l in &notes[*i].links {
            if let Some(j) = notes.iter().position(|n| &n.slug == l) { push(j, &mut out); }
        }
    }
    let mut rules: Vec<usize> = (0..notes.len()).filter(|&i| notes[i].kind == "regra").collect();
    rules.sort_by(|a, b| notes[*b].mtime_ms.cmp(&notes[*a].mtime_ms));
    for i in rules { push(i, &mut out); }
    out
}

pub fn build_index(notes: &[Note], cap: usize) -> String {
    let mut idx: Vec<&Note> = notes.iter().collect();
    idx.sort_by(|a, b| type_order(&a.kind).cmp(&type_order(&b.kind)).then(b.mtime_ms.cmp(&a.mtime_ms)));
    let mut out = String::new();
    let mut shown = 0;
    for n in &idx {
        let line = format!(
            "- [[{}]] · {}{} · {}{}\n",
            n.slug, n.kind, if n.scope == "time" { " · time" } else { "" }, n.title,
            if n.summary.is_empty() { String::new() } else { format!(" — {}", n.summary) }
        );
        if out.len() + line.len() > cap { break; }
        out.push_str(&line);
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
    let mut budget = notes_cap;
    let mut body = String::new();
    for i in relevant(notes, query) {
        let n = &notes[i];
        let block = format!(
            "#### {} ({} · {}{})\n{}\n\n",
            n.title, n.kind, n.scope, if n.updated.is_empty() { String::new() } else { format!(" · {}", n.updated) }, n.text
        );
        if block.len() > budget {
            if budget > 400 && body.is_empty() {
                let cut: String = block.chars().take(budget.saturating_sub(20) / 2).collect();
                body.push_str(&cut);
                body.push_str("…\n\n");
            }
            continue;
        }
        budget -= block.len();
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
// comandos da aba Memória
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
    let p = note_path(&repo, &scope, &slug)?;
    let content = std::fs::read_to_string(&p).map_err(|_| "nota não encontrada".to_string())?;
    Ok(serde_json::json!({ "content": content, "mtimeMs": mtime_ms(&p) }))
}

/// Grava uma nota. Sem `slug`: nota nova (slug do título, único). `expect_mtime`: o mtime que a
/// tela carregou — se o arquivo mudou depois (um agente gravou), a gravação ainda vence (é a mais
/// recente), mas volta `conflict: true` pra tela avisar. `set_mtime`: sync da nuvem (preserva a data).
#[tauri::command(async)]
pub fn memory_write(
    state: State<AppState>, repo: Option<String>, scope: String, slug: Option<String>, content: String,
    expect_mtime: Option<i64>, set_mtime_ms: Option<i64>,
) -> Result<serde_json::Value, String> {
    let repo = repo_or(&state, repo)?;
    write_note(&repo, &scope, slug.as_deref(), &content, expect_mtime, set_mtime_ms)
}

pub fn write_note(repo: &Path, scope: &str, slug: Option<&str>, content: &str, expect_mtime: Option<i64>, set_mtime_ms: Option<i64>) -> Result<serde_json::Value, String> {
    let dir = scope_dir(repo, scope)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = match slug.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(s) => valid_name(s)?,
        None => {
            let n = parse_note(content, "nota", scope, 0);
            let base = slugify(&n.title);
            let mut s = base.clone();
            let mut i = 2;
            while dir.join(format!("{s}.md")).exists() { s = format!("{base}-{i}"); i += 1; }
            s
        }
    };
    let p = note_path(repo, scope, &name)?;
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
    let p = note_path(&repo, &scope, &slug)?;
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
    let src = note_path(repo, from, slug)?;
    if !src.is_file() { return Err("nota não encontrada".into()); }
    let dir = scope_dir(repo, to)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = valid_name(slug)?;
    let mut name = base.clone();
    let mut i = 2;
    while dir.join(format!("{name}.md")).exists() { name = format!("{base}-{i}"); i += 1; }
    let dst = note_path(repo, to, &name)?;
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

/// Abre a pasta do cérebro no Obsidian (obsidian://open?path=…); sem Obsidian, abre a pasta.
#[tauri::command(async)]
pub fn memory_open_obsidian(state: State<AppState>, repo: Option<String>) -> Result<String, String> {
    let repo = repo_or(&state, repo)?;
    let root = brain_root(&repo);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.display().to_string();
    let enc: String = path.bytes().map(|b| {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }
    }).collect();
    let obsidian_installed = cfg!(target_os = "macos") && (Path::new("/Applications/Obsidian.app").exists()
        || std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications/Obsidian.app").exists()).unwrap_or(false));
    if obsidian_installed {
        os_open(std::ffi::OsStr::new(&format!("obsidian://open?path={enc}"))).map_err(|e| e.to_string())?;
        return Ok("obsidian".into());
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

    #[test]
    fn caminho_travado_dentro_da_memoria() {
        let repo = tmp_repo("path");
        for bad in ["../x", "..", "a/b", "a\\b", ".oculta", "", "   ", "c:x", "../../etc/passwd"] {
            assert!(note_path(&repo, "local", bad).is_err(), "{bad} deveria falhar");
        }
        assert!(note_path(&repo, "outro", "ok").is_err());
        let p = note_path(&repo, "local", "usar-pnpm").unwrap();
        assert!(p.ends_with(".cardume/memoria/usar-pnpm.md"));
        let t = note_path(&repo, "time", "ci.md").unwrap();
        assert!(t.ends_with(".cardume/memoria/time/ci.md"));
        // symlink da pasta do time pra fora do projeto é barrado
        #[cfg(unix)]
        {
            let fora = std::env::temp_dir().join(format!("sf-mem-fora-{}", std::process::id()));
            std::fs::create_dir_all(&fora).unwrap();
            std::fs::create_dir_all(brain_root(&repo)).unwrap();
            let _ = std::os::unix::fs::symlink(&fora, brain_root(&repo).join("time"));
            assert!(note_path(&repo, "time", "x").is_err());
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
        let s = serialize_note("Usar pnpm, nunca npm", "regra", &["ferramentas".into()], "2026-09-28", "Douglas", "pessoa", "corpo");
        let back = parse_note(&s, "x", "local", 0);
        assert_eq!(back.title, "Usar pnpm, nunca npm");
        assert_eq!(back.kind, "regra");
    }

    #[test]
    fn gravar_ler_mover_apagar_e_grafo() {
        let repo = tmp_repo("crud");
        let r = write_note(&repo, "local", None, "---\ntitle: Usar pnpm\ntype: regra\n---\nSempre pnpm. Ver [[ferramentas]] e [[ci]].", None, None).unwrap();
        assert_eq!(r["slug"], "usar-pnpm");
        write_note(&repo, "time", Some("ci"), "---\ntitle: CI\n---\nGitHub Actions.", None, Some(1_700_000_000_000)).unwrap();
        let ci = note_path(&repo, "time", "ci").unwrap();
        assert_eq!(mtime_ms(&ci), 1_700_000_000_000, "sync preserva a data da nuvem");
        // conflito: o arquivo mudou depois do que a tela carregou → grava, mas avisa
        let c = write_note(&repo, "time", Some("ci"), "x", Some(1_600_000_000_000), None).unwrap();
        assert_eq!(c["conflict"], true);
        let g = graph_of(&list_notes(&repo, true));
        assert_eq!(g["edges"].as_array().unwrap().len(), 1);
        assert_eq!(g["missing"], serde_json::json!(["ferramentas"]));
        let m = move_note(&repo, "usar-pnpm", "local", "time").unwrap();
        assert_eq!(m["scope"], "time");
        assert!(!note_path(&repo, "local", "usar-pnpm").unwrap().exists());
        assert!(note_path(&repo, "time", "usar-pnpm").unwrap().exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn migracao_e_contexto_com_regra() {
        let repo = tmp_repo("mig");
        std::fs::write(repo.join(".cardume/MEMORY.md"), "- Sempre use pnpm, nunca npm _(aprendido 2026-09-01)_\nTexto solto\n").unwrap();
        let notes = list_notes(&repo, true);
        assert_eq!(notes.len(), 2);
        assert!(repo.join(".cardume/MEMORY.md.migrado").exists());
        assert!(!repo.join(".cardume/MEMORY.md").exists());
        let ctx = brain_context(&repo, "oi, me ajuda a montar o checkout");
        assert!(ctx.contains("Sempre use pnpm, nunca npm"), "{ctx}");
        // só-local esconde o time
        write_note(&repo, "time", Some("segredo-do-time"), "---\ntitle: Nota do time\n---\nabc", None, None).unwrap();
        assert!(brain_context(&repo, "x").contains("Nota do time"));
        std::fs::write(repo.join(".cardume/memoria.json"), r#"{"mode":"so-local"}"#).unwrap();
        assert!(!brain_context(&repo, "x").contains("Nota do time"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn contexto_tem_teto() {
        let notes: Vec<Note> = (0..300).map(|i| parse_note(&format!("---\ntitle: Nota checkout {i}\n---\n{}", "checkout ".repeat(200)), &format!("n{i}"), "local", 0)).collect();
        let c = build_context(&notes, "checkout", INDEX_CAP, NOTES_CAP);
        assert!(c.len() < INDEX_CAP + NOTES_CAP + 800, "{}", c.len());
        assert!(c.contains("mais "));
    }
}
