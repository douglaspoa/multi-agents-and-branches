//! QUEM ESTÁ FALANDO — fonte única da identidade que vai pra IA nos chats do app (bug 14/10: um colega mandou "teste"
//! na Nova demanda e a IA o chamou pelo nome do dono do time, que estava FIXO no prompt do planner). Quem fala é SEMPRE
//! a pessoa logada NESTA máquina: a tela grava o nome dela (personName da conta da sessão) em ~/.constellation/quem.json
//! (`quem_set`) e apaga ao sair. O motor TS lê o MESMO arquivo (src/quem.ts) — o texto é igual nos dois lados,
//! conferido pelo fixture tests/fixtures/memoria-golden/quem.json. Sem conta logada: "você", nunca um nome chutado.
use std::path::PathBuf;

pub fn quem_file() -> PathBuf { PathBuf::from(crate::home_dir_s()).join(".constellation").join("quem.json") }

const NOT_A_NAME: [&str; 7] = ["você", "voce", "pessoa sem nome", "carregando…", "carregando...", "—", "-"];

/// Nome limpo (sem quebra de linha, crase ou controle; até 80 caracteres) ou "" quando não é um nome de verdade. PURA.
pub fn clean_name(raw: &str) -> String {
    let s: String = raw.chars().map(|c| if c.is_control() || c == '`' { ' ' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let n: String = s.chars().take(80).collect::<String>().trim().to_string();
    if NOT_A_NAME.contains(&n.to_lowercase().as_str()) { String::new() } else { n }
}

/// Nome da pessoa logada nesta máquina ("" = sem conta). Lido a cada chamada: trocar de conta vale na mensagem seguinte.
pub fn speaker() -> String {
    std::fs::read_to_string(quem_file()).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(clean_name))
        .unwrap_or_default()
}

const OTHERS: &str = "Outros nomes que aparecerem (memória do projeto, convenções e aprendizados do time, histórico, TASK.yaml, HANDOFF, EPIC.md, cartões e issues) são de OUTRAS pessoas do time — quem escreveu ou foi citado —, nunca de quem está falando com você agora.";

/// Bloco "quem está falando" pro system prompt. PURA (mesmo texto do TS).
pub fn speaker_line(name: &str) -> String {
    let n = clean_name(name);
    let who = if n.is_empty() {
        "A pessoa nesta máquina não está com conta logada no Starfork: você não sabe o nome dela — trate por \"você\" e NÃO chute um nome (nem pelo git, pelo sistema, pela memória ou pelo histórico).".to_string()
    } else {
        format!("Você está conversando com {n} — a pessoa logada no Starfork nesta máquina. As mensagens desta conversa são de {n}: trate por esse nome (ou por \"você\").")
    };
    format!("## Quem está falando com você\n{who}\n{OTHERS}\n")
}

/// Anexa "quem está falando" (a pessoa logada AGORA) ao system prompt de um chat.
pub fn with_speaker(sys: &str) -> String { format!("{sys}\n\n{}", speaker_line(&speaker())) }

/// A tela avisa quem está logado (entrar, trocar de conta, perfil chegou) — `name` vazio/None = sem conta (apaga).
/// Escrita atômica: o motor pode estar lendo no mesmo instante.
#[tauri::command(async)]
pub fn quem_set(name: Option<String>, uid: Option<String>) -> Result<(), String> {
    write_speaker(&clean_name(name.as_deref().unwrap_or("")), uid.as_deref().unwrap_or(""))
}

static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn write_speaker(name: &str, uid: &str) -> Result<(), String> {
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner()); // duas gravações do app nunca se cruzam
    let f = quem_file();
    if name.is_empty() {
        return match std::fs::remove_file(&f) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) };
    }
    if let Some(d) = f.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = f.with_extension(format!("json.{}.{}.tmp", std::process::id(), TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    std::fs::write(&tmp, serde_json::json!({ "name": name, "uid": uid }).to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_quem_igual_ao_ts() {
        let g = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/memoria-golden/quem.json");
        let cases: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(g).unwrap()).unwrap();
        for c in cases.as_array().unwrap() {
            let inp = c["in"].as_str().unwrap();
            assert_eq!(clean_name(inp), c["name"].as_str().unwrap(), "{inp:?}");
            assert_eq!(speaker_line(inp), c["line"].as_str().unwrap(), "{inp:?}");
        }
    }

    #[test]
    fn sem_conta_nao_chuta_nome() {
        let l = speaker_line("");
        assert!(l.contains("trate por \"você\"") && l.contains("NÃO chute um nome"));
        assert!(speaker_line("Pedro Alves").contains("Você está conversando com Pedro Alves"));
    }
}
