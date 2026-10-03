//! HISTÓRICO DA SESSÃO pro terminal da tarefa PARADA (concluída, pra revisar, antiga/headless).
//!
//! A aba Terminal substitui a Conversa em toda tarefa Claude Code: sem PTY vivo, o xterm mostra o que aconteceu na
//! sessão. A fonte é o TRANSCRIPT do próprio Claude Code (`<config>/projects/<cwd-encodado>/<sessão>.jsonl` — o mesmo
//! arquivo que o `claude --resume` lê), resumido aqui em itens compactos; o front (60-terminal.js) pinta na gramática
//! do mock (● / ⎿ / cores). Nada de base64 de imagem nem do system prompt chega ao front.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Itens mantidos (os mais recentes). Uma sessão longa de headless passa de mil chamadas de ferramenta.
pub const MAX_ITEMS: usize = 1500;

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistItem {
    /// you | say | tool | edit | ask | sys
    pub k: String,
    /// ms desde a época (0 = sem horário)
    pub ts: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub arg: String,
    /// 1ª linha útil do resultado da ferramenta
    #[serde(skip_serializing_if = "String::is_empty")]
    pub out: String,
    /// linhas do resultado (Read: tamanho do arquivo lido)
    #[serde(skip_serializing_if = "is_zero")]
    pub lines: usize,
    #[serde(skip_serializing_if = "is_false")]
    pub err: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub add: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub del: usize,
    /// a ferramenta já devolveu resultado
    #[serde(skip_serializing_if = "is_false")]
    pub done: bool,
}
fn is_zero(n: &usize) -> bool { *n == 0 }
fn is_false(b: &bool) -> bool { !*b }

fn clip(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n { return t.to_string(); }
    let mut o: String = t.chars().take(n.saturating_sub(1)).collect();
    o.push('…');
    o
}
fn first_line(s: &str) -> &str { s.lines().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("") }
fn nlines(s: &str) -> usize { if s.is_empty() { 0 } else { s.lines().count().max(1) } }
fn ts_of(o: &Value) -> i64 {
    o.get("timestamp").and_then(|v| v.as_str()).and_then(|s| chrono_ms(s)).unwrap_or(0)
}
/// "2026-10-02T05:10:42.206Z" → ms (sem dependência de crate de data: só o formato ISO UTC do transcript)
pub fn chrono_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 { return None; }
    let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 2)?, n(8, 2)?, n(11, 2)?, n(14, 2)?, n(17, 2)?);
    let ms = if b.len() > 20 && b[19] == b'.' { format!("{:0<3}", s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect::<String>()).parse::<i64>().unwrap_or(0) } else { 0 };
    // dias desde 1970-01-01 (algoritmo civil de Howard Hinnant)
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

fn rel(p: &str, cwd: &str) -> String {
    let c = cwd.trim_end_matches('/');
    if !c.is_empty() { if let Some(r) = p.strip_prefix(c).and_then(|r| r.strip_prefix('/')) { return r.to_string(); } }
    p.to_string()
}
fn compact_json(v: &Value, n: usize) -> String {
    match v {
        Value::Object(m) if m.is_empty() => String::new(),
        _ => clip(&v.to_string(), n),
    }
}
/// Ferramenta → (rótulo, argumento, +linhas, −linhas). Rótulos como os do Claude Code (Update = Edit).
fn tool_summary(name: &str, input: &Value, cwd: &str) -> (String, String, usize, usize) {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "Bash" => (name.into(), clip(first_line(s("command")), 200), 0, 0),
        "Read" | "NotebookRead" => (name.into(), rel(s("file_path"), cwd), 0, 0),
        "Edit" => ("Update".into(), rel(s("file_path"), cwd), nlines(s("new_string")), nlines(s("old_string"))),
        "MultiEdit" => {
            let (mut a, mut d) = (0, 0);
            for e in input.get("edits").and_then(|v| v.as_array()).into_iter().flatten() {
                a += nlines(e.get("new_string").and_then(|v| v.as_str()).unwrap_or(""));
                d += nlines(e.get("old_string").and_then(|v| v.as_str()).unwrap_or(""));
            }
            ("Update".into(), rel(s("file_path"), cwd), a, d)
        }
        "Write" => ("Write".into(), rel(s("file_path"), cwd), nlines(s("content")), 0),
        "NotebookEdit" => ("Update".into(), rel(s("notebook_path"), cwd), 0, 0),
        "Grep" => (name.into(), clip(&format!("{}{}", s("pattern"), if s("path").is_empty() { String::new() } else { format!(" em {}", rel(s("path"), cwd)) }), 160), 0, 0),
        "Glob" => (name.into(), clip(s("pattern"), 160), 0, 0),
        "WebSearch" => (name.into(), clip(s("query"), 160), 0, 0),
        "WebFetch" => (name.into(), clip(s("url"), 160), 0, 0),
        "Task" | "Agent" => ("Agent".into(), clip(s("description"), 160), 0, 0),
        "TodoWrite" => ("Plano".into(), format!("{} itens", input.get("todos").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)), 0, 0),
        _ if name.starts_with("mcp__") => {
            let mut p = name.trim_start_matches("mcp__").splitn(2, "__");
            let srv = p.next().unwrap_or("");
            let tool = p.next().unwrap_or("");
            let srv = if srv == "cardume" { "starfork" } else { srv };
            ("mcp".into(), format!("{srv}.{tool}{}", { let j = compact_json(input, 110); if j.is_empty() { j } else { format!(" {j}") } }), 0, 0)
        }
        _ => (name.into(), compact_json(input, 140), 0, 0),
    }
}
/// Conteúdo do tool_result → (texto, tem imagem)
fn result_text(c: &Value) -> (String, bool) {
    match c {
        Value::String(s) => (s.clone(), false),
        Value::Array(a) => {
            let mut t = String::new();
            let mut img = false;
            for x in a {
                match x.get("type").and_then(|v| v.as_str()) {
                    Some("text") => { if !t.is_empty() { t.push('\n'); } t.push_str(x.get("text").and_then(|v| v.as_str()).unwrap_or("")); }
                    Some("image") => img = true,
                    _ => {}
                }
            }
            (t, img)
        }
        _ => (String::new(), false),
    }
}
/// Fala do usuário que é ruído do próprio CLI (comando local, aviso de interrupção, eco de imagem).
fn user_noise(t: &str) -> bool {
    let t = t.trim_start();
    t.is_empty() || t.starts_with("<command-") || t.starts_with("<local-command") || t.starts_with("[Request interrupted") || t.starts_with("[Image") || t.starts_with("Caveat:")
}

/// Transcript (.jsonl) → itens, na ordem. Linha ilegível é ignorada (o arquivo pode estar sendo escrito agora).
pub fn parse_transcript(text: &str, cwd: &str) -> Vec<HistItem> {
    let mut out: Vec<HistItem> = Vec::new();
    let mut by_tool: HashMap<String, usize> = HashMap::new();
    for line in text.lines() {
        if line.len() < 2 { continue; }
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
        let ty = o.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = ts_of(&o);
        if o.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) { continue; }
        match ty {
            "user" => {
                if o.get("isMeta").and_then(|v| v.as_bool()) == Some(true) { continue; }
                let c = o.get("message").and_then(|m| m.get("content"));
                match c {
                    Some(Value::String(s)) => { if !user_noise(s) { out.push(HistItem { k: "you".into(), ts, text: s.trim().to_string(), ..Default::default() }); } }
                    Some(Value::Array(a)) => {
                        for x in a {
                            match x.get("type").and_then(|v| v.as_str()) {
                                Some("tool_result") => {
                                    let id = x.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                                    let Some(&i) = by_tool.get(id) else { continue };
                                    let (t, img) = result_text(x.get("content").unwrap_or(&Value::Null));
                                    let it = &mut out[i];
                                    it.done = true;
                                    it.err = x.get("is_error").and_then(|v| v.as_bool()) == Some(true);
                                    it.lines = nlines(&t);
                                    it.out = if img && t.trim().is_empty() { "[imagem]".into() } else { clip(first_line(&t), 160) };
                                    if it.k == "ask" && !it.err { it.out = clip(&t.replace('\n', " "), 300); }
                                }
                                Some("text") => {
                                    let s = x.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                    if !user_noise(s) { out.push(HistItem { k: "you".into(), ts, text: s.trim().to_string(), ..Default::default() }); }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                for x in o.get("message").and_then(|m| m.get("content")).and_then(|v| v.as_array()).into_iter().flatten() {
                    match x.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            let s = x.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
                            if !s.is_empty() { out.push(HistItem { k: "say".into(), ts, text: s.to_string(), ..Default::default() }); }
                        }
                        Some("tool_use") => {
                            let name = x.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                            let input = x.get("input").cloned().unwrap_or(Value::Null);
                            let id = x.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let it = if name == "AskUserQuestion" {
                                let qs: Vec<String> = input.get("questions").and_then(|v| v.as_array()).into_iter().flatten()
                                    .filter_map(|q| q.get("question").and_then(|v| v.as_str()).map(|s| s.trim().to_string())).collect();
                                HistItem { k: "ask".into(), ts, text: clip(&qs.join(" · "), 400), ..Default::default() }
                            } else {
                                let (label, arg, add, del) = tool_summary(name, &input, cwd);
                                let k = if label == "Update" || label == "Write" { "edit" } else { "tool" };
                                HistItem { k: k.into(), ts, name: label, arg, add, del, ..Default::default() }
                            };
                            if !id.is_empty() { by_tool.insert(id, out.len()); }
                            out.push(it);
                        }
                        _ => {}
                    }
                }
            }
            "system" => {
                if o.get("subtype").and_then(|v| v.as_str()) == Some("compact_boundary") {
                    out.push(HistItem { k: "sys".into(), ts, text: "contexto compactado".into(), ..Default::default() });
                }
            }
            _ => {}
        }
    }
    if out.len() > MAX_ITEMS { out.drain(..out.len() - MAX_ITEMS); }
    out
}

/// Pasta do projeto no config do Claude Code: todo caractere que não é letra/dígito vira '-'.
pub fn encode_cwd(cwd: &str) -> String { cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect() }

/// Onde está o transcript da sessão: a pasta da worktree primeiro; senão varre `projects/*` (cwd diferente, movida).
pub fn find_transcript(config_dir: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.len() > 80 || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return None; }
    let root = config_dir.join("projects");
    let direct = root.join(encode_cwd(cwd)).join(format!("{session_id}.jsonl"));
    if direct.is_file() { return Some(direct); }
    std::fs::read_dir(&root).ok()?.flatten().map(|d| d.path().join(format!("{session_id}.jsonl"))).find(|p| p.is_file())
}
/// `CLAUDE_CONFIG_DIR` ou `~/.claude` (a mesma regra do motor — claudeTranscriptExists em src/terminal.ts).
pub fn claude_config_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) { return Some(PathBuf::from(d)); }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".claude"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const CWD: &str = "/r/.cardume/worktrees/t1";
    fn tr() -> String {
        [
            r#"{"type":"attachment","attachment":{"type":"hook_non_blocking_error"}}"#,
            r#"{"type":"user","timestamp":"2026-10-02T05:10:42.206Z","message":{"role":"user","content":"Leia .cardume/TASK.yaml e execute"}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-02T05:10:45.000Z","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"Vou ler a agenda."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/r/.cardume/worktrees/t1/src/A.tsx"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"1\n2\n3"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/r/.cardume/worktrees/t1/src/A.tsx","old_string":"a\nb","new_string":"a\nb\nc\nd"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"npm test -- agenda\necho fim"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","is_error":true,"content":[{"type":"text","text":"\nFAIL agenda.test\nmais"}]}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"[Image: original 1206x2622]"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"mcp__cardume__record_proof","input":{"req":"R1"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t4","content":[{"type":"image","source":{"data":"AAAA"}}]}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t5","name":"AskUserQuestion","input":{"questions":[{"question":"Cheia?"},{"question":"Até quando?"}]}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t5","content":"User answered: Cheia?=Só livres"}]}}"#,
            r#"{"type":"system","subtype":"compact_boundary"}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagente"}]}}"#,
            r#"{"type":"user","message":{"content":"#,
        ].join("\n")
    }
    #[test]
    fn transcript_vira_itens_compactos() {
        let it = parse_transcript(&tr(), CWD);
        let ks: Vec<&str> = it.iter().map(|x| x.k.as_str()).collect();
        assert_eq!(ks, ["you", "say", "tool", "edit", "tool", "tool", "ask", "sys"]);
        assert_eq!(it[0].ts, 1790917842206);
        assert_eq!((it[2].name.as_str(), it[2].arg.as_str(), it[2].lines, it[2].done), ("Read", "src/A.tsx", 3, true));
        assert_eq!((it[3].name.as_str(), it[3].add, it[3].del), ("Update", 4, 2));
        assert_eq!((it[4].arg.as_str(), it[4].err, it[4].out.as_str()), ("npm test -- agenda", true, "FAIL agenda.test"));
        assert_eq!((it[5].name.as_str(), it[5].out.as_str()), ("mcp", "[imagem]"));
        assert!(it[5].arg.starts_with("starfork.record_proof "), "{}", it[5].arg);
        assert_eq!((it[6].text.as_str(), it[6].out.as_str()), ("Cheia? · Até quando?", "User answered: Cheia?=Só livres"));
        let j = serde_json::to_string(&it[1]).unwrap();
        assert!(!j.contains("\"arg\"") && !j.contains("\"err\""), "campos vazios não viajam: {j}");
    }
    #[test]
    fn so_os_ultimos_itens_e_pasta_do_projeto() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}"#;
        let big = vec![line; MAX_ITEMS + 30].join("\n");
        assert_eq!(parse_transcript(&big, CWD).len(), MAX_ITEMS);
        assert_eq!(encode_cwd("/Users/x/Starfork/pou/.cardume/worktrees/v_1"), "-Users-x-Starfork-pou--cardume-worktrees-v-1");
        assert_eq!(chrono_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(chrono_ms("lixo"), None);
    }
    #[test]
    fn acha_o_transcript_na_pasta_ou_varrendo() {
        let d = std::env::temp_dir().join(format!("sf-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("projects").join("-outra")).unwrap();
        std::fs::write(d.join("projects").join("-outra").join("abc-123.jsonl"), "{}").unwrap();
        assert_eq!(find_transcript(&d, "/qualquer", "abc-123"), Some(d.join("projects").join("-outra").join("abc-123.jsonl")));
        std::fs::create_dir_all(d.join("projects").join(encode_cwd("/w/t"))).unwrap();
        std::fs::write(d.join("projects").join(encode_cwd("/w/t")).join("abc-123.jsonl"), "{}").unwrap();
        assert_eq!(find_transcript(&d, "/w/t", "abc-123"), Some(d.join("projects").join("-w-t").join("abc-123.jsonl")));
        assert_eq!(find_transcript(&d, "/w/t", "../etc"), None, "id com barra/ponto não vira caminho");
        assert_eq!(find_transcript(&d, "/w/t", "nao-existe"), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
