//! Lista de projetos POR CONTA (~/.cardume/projects.json).
//!
//! Antes a lista era só um array de caminhos, por máquina: trocar de conta na nuvem deixava os projetos
//! da outra conta na barra lateral e na Central, e os laços da nuvem tentavam publicar as tarefas deles
//! com a conta errada (RLS). Agora cada projeto tem um DONO (id do usuário da nuvem) ou nenhum
//! ("deste computador", visível pra todas as contas). Nada é apagado: projeto de outra conta só fica oculto.
//!
//! Formato v2 (o mesmo que o `registerProject` do piloto grava em TS — manter os dois iguais):
//!   {"v":2,"pending":false,"items":[{"path":"/repo","owner":"<uid>"|null}]}
//! `pending` = veio do formato antigo (array de strings) e os donos ainda não foram atribuídos pela
//! migração (o front decide com a evidência da nuvem — 40-conta-escopo.js).
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Dono "outra conta, ainda não identificada": a migração viu evidência de que o projeto é de OUTRA conta
/// (cartões que esta conta não enxerga + autores de commit de outro domínio), mas sem saber o id dela.
/// Fica oculto pra todos até a conta certa entrar e reivindicar (ou alguém abrir pelo "abrir existente…").
/// (Quem grava esse valor é o front — 40-conta-escopo.js; aqui ele só precisa ficar oculto como qualquer outro dono.)
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const OTHER_ACCOUNT: &str = "outra-conta";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct ProjEntry {
    pub path: String,
    #[serde(default)]
    pub owner: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ProjFile {
    pub items: Vec<ProjEntry>,
    pub pending: bool,
}

fn clean_owner(o: Option<&str>) -> Option<String> {
    o.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Lê os DOIS formatos: array de strings (antigo → pending) ou o objeto v2. Lixo → lista vazia.
pub(crate) fn parse(s: &str) -> ProjFile {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else { return ProjFile::default() };
    let (arr, pending) = match &v {
        serde_json::Value::Array(a) => (a.clone(), !a.is_empty()),
        serde_json::Value::Object(o) => (
            o.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default(),
            o.get("pending").and_then(|b| b.as_bool()).unwrap_or(false),
        ),
        _ => (vec![], false),
    };
    let mut items: Vec<ProjEntry> = Vec::new();
    for x in &arr {
        let e = if let Some(p) = x.as_str() {
            ProjEntry { path: p.to_string(), owner: None }
        } else if let Some(p) = x.get("path").and_then(|p| p.as_str()) {
            ProjEntry { path: p.to_string(), owner: clean_owner(x.get("owner").and_then(|o| o.as_str())) }
        } else {
            continue;
        };
        if e.path.is_empty() || items.iter().any(|i| i.path == e.path) { continue; }
        items.push(e);
    }
    ProjFile { items, pending }
}

pub(crate) fn to_json(f: &ProjFile) -> String {
    serde_json::to_string_pretty(&serde_json::json!({ "v": 2, "pending": f.pending, "items": f.items }))
        .unwrap_or_else(|_| "{\"v\":2,\"pending\":false,\"items\":[]}".into())
}

/// Serializa leitura+escrita dentro do processo (dois comandos async mexendo na lista ao mesmo tempo).
static IO: Mutex<()> = Mutex::new(());

pub(crate) fn read_from(file: &Path) -> ProjFile {
    std::fs::read_to_string(file).map(|s| parse(&s)).unwrap_or_default()
}

/// Escrita atômica (tmp + rename): o piloto (TS) e o app leem o mesmo arquivo.
pub(crate) fn write_to(file: &Path, f: &ProjFile) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, to_json(f)).is_ok() && std::fs::rename(&tmp, file).is_err() {
        let _ = std::fs::write(file, to_json(f));
    }
}

/// Lê, aplica `op` e grava (sob a trava). Devolve o que `op` devolver.
pub(crate) fn update<T>(file: &Path, op: impl FnOnce(&mut ProjFile) -> T) -> T {
    let _g = IO.lock().unwrap_or_else(|e| e.into_inner());
    let mut f = read_from(file);
    let before = f.clone();
    let out = op(&mut f);
    if f != before {
        write_to(file, &f);
    }
    out
}

/// Visível pra `user`: sem dono (deste computador) ou dono = `user`. Sem sessão (`None`) → só os sem dono.
pub(crate) fn visible(e: &ProjEntry, user: Option<&str>) -> bool {
    match &e.owner {
        None => true,
        Some(o) => Some(o.as_str()) == user,
    }
}
pub(crate) fn visible_paths(f: &ProjFile, user: Option<&str>) -> Vec<String> {
    f.items.iter().filter(|e| visible(e, user)).map(|e| e.path.clone()).collect()
}
pub(crate) fn hidden_count(f: &ProjFile, user: Option<&str>) -> usize {
    f.items.iter().filter(|e| !visible(e, user)).count()
}

/// Põe `path` no topo. `stamp`: `Some(dono)` grava o dono (`Some(None)` = sem dono); `None` mantém o atual.
pub(crate) fn touch(f: &mut ProjFile, path: &str, stamp: Option<Option<String>>) {
    let cur = f.items.iter().position(|e| e.path == path).map(|i| f.items.remove(i));
    let owner = match stamp {
        Some(o) => clean_owner(o.as_deref()),
        None => cur.and_then(|e| e.owner),
    };
    f.items.insert(0, ProjEntry { path: path.to_string(), owner });
}

/// Projeto aberto/criado com a conta `user` logada: vai pro topo e passa a ser DESSA conta
/// (o "abrir existente…" traz um projeto de outra conta pra atual). Sem sessão: mantém o dono que tinha.
pub(crate) fn register_opened(f: &mut ProjFile, path: &str, user: Option<&str>) {
    let stamp = clean_owner(user).map(Some);
    touch(f, path, stamp);
}

/// Atribuições da migração (front). Só mexe em caminhos que existem; `done` encerra o `pending`.
pub(crate) fn assign(f: &mut ProjFile, assigns: &[(String, Option<String>)], done: bool) {
    for (p, o) in assigns {
        if let Some(e) = f.items.iter_mut().find(|e| &e.path == p) {
            e.owner = clean_owner(o.as_deref());
        }
    }
    if done {
        f.pending = false;
    }
}

/// Conta "da vez" (id do usuário da nuvem) — o front avisa no boot e a cada troca de sessão
/// (`set_projects_user` / `list_projects{user}`). `None` = sem sessão.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);
pub(crate) fn current_user() -> Option<String> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
pub(crate) fn set_current_user(u: Option<&str>) {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = clean_owner(u);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sf-proj-{tag}-{}-{}", std::process::id(), super::super::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d.join("projects.json")
    }
    fn e(p: &str, o: Option<&str>) -> ProjEntry { ProjEntry { path: p.into(), owner: o.map(String::from) } }

    #[test]
    fn le_o_formato_antigo_como_pendente_e_sem_dono() {
        let f = parse(r#"["/a","/b","/a"]"#);
        assert_eq!(f.items, vec![e("/a", None), e("/b", None)], "duplicado sai");
        assert!(f.pending, "array antigo = migração pendente");
        assert!(!parse("[]").pending, "lista antiga vazia não tem o que migrar");
        assert_eq!(parse("lixo"), ProjFile::default());
    }

    #[test]
    fn le_e_grava_o_formato_v2() {
        let f = parse(r#"{"v":2,"pending":false,"items":[{"path":"/a","owner":"u1"},{"path":"/b","owner":null},{"path":"/c","owner":""},"/d"]}"#);
        assert_eq!(f.items, vec![e("/a", Some("u1")), e("/b", None), e("/c", None), e("/d", None)]);
        assert!(!f.pending);
        let back = parse(&to_json(&f));
        assert_eq!(back, f, "ida e volta");
        let v: serde_json::Value = serde_json::from_str(&to_json(&f)).unwrap();
        assert_eq!(v["v"], 2);
        assert_eq!(v["items"][1]["owner"], serde_json::Value::Null);
    }

    #[test]
    fn filtra_por_conta() {
        let f = ProjFile { items: vec![e("/work", Some("uw")), e("/home", Some("ug")), e("/livre", None), e("/x", Some(OTHER_ACCOUNT))], pending: false };
        assert_eq!(visible_paths(&f, Some("ug")), vec!["/home", "/livre"]);
        assert_eq!(visible_paths(&f, Some("uw")), vec!["/work", "/livre"]);
        assert_eq!(visible_paths(&f, None), vec!["/livre"], "sem sessão: só os deste computador");
        assert_eq!(hidden_count(&f, Some("ug")), 2);
        assert_eq!(hidden_count(&f, None), 3);
        assert_eq!(visible_paths(&f, Some(OTHER_ACCOUNT)).len(), 2, "o marcador nunca é uma sessão real, mas não quebra");
    }

    #[test]
    fn abrir_ou_criar_logado_carimba_a_conta_atual() {
        let mut f = ProjFile { items: vec![e("/a", Some("uw")), e("/b", None)], pending: false };
        register_opened(&mut f, "/novo", Some("ug"));
        assert_eq!(f.items[0], e("/novo", Some("ug")), "projeto novo entra no topo, da conta logada");
        register_opened(&mut f, "/a", Some("ug"));
        assert_eq!(f.items[0], e("/a", Some("ug")), "abrir existente traz o projeto da outra conta pra atual");
        assert_eq!(f.items.len(), 3, "sem duplicar");
        register_opened(&mut f, "/b", None);
        assert_eq!(f.items[0], e("/b", None), "sem sessão: mantém o dono (nenhum)");
        register_opened(&mut f, "/a", None);
        assert_eq!(f.items[0], e("/a", Some("ug")), "sem sessão não rouba nem solta o dono");
        touch(&mut f, "/novo", None);
        assert_eq!(f.items[0], e("/novo", Some("ug")), "trocar de projeto só reordena");
    }

    #[test]
    fn migracao_atribui_e_encerra_o_pendente_sem_apagar_nada() {
        let mut f = parse(r#"["/logcomex-ai-v2","/pou","/code-refuge-relay","/multi"]"#);
        assign(&mut f, &[("/logcomex-ai-v2".into(), Some("uw".into())), ("/code-refuge-relay".into(), Some(OTHER_ACCOUNT.into())), ("/naoexiste".into(), Some("x".into())), ("/pou".into(), None)], true);
        assert!(!f.pending);
        assert_eq!(f.items.len(), 4, "nenhum projeto sumiu da lista");
        assert_eq!(visible_paths(&f, Some("ug")), vec!["/pou", "/multi"]);
        assert_eq!(visible_paths(&f, Some("uw")), vec!["/logcomex-ai-v2", "/pou", "/multi"]);
        let mut g = parse(r#"["/a"]"#);
        assign(&mut g, &[], false);
        assert!(g.pending, "sem done, continua pendente");
    }

    #[test]
    fn arquivo_le_os_dois_formatos_e_grava_v2() {
        let file = tmp_file("io");
        std::fs::write(&file, r#"["/a","/b"]"#).unwrap();
        let out = update(&file, |f| { register_opened(f, "/b", Some("ug")); visible_paths(f, Some("uw")) });
        assert_eq!(out, vec!["/a"], "o /b agora é da ug");
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"v\": 2"), "regravado no formato novo: {raw}");
        let f = read_from(&file);
        assert_eq!(f.items, vec![e("/b", Some("ug")), e("/a", None)]);
        assert!(f.pending, "o /a ainda espera a migração");
        assert_eq!(read_from(&file.with_file_name("nao-existe.json")), ProjFile::default());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn conta_atual_vazia_vira_sem_sessao() {
        assert_eq!(clean_owner(Some("  ")), None);
        assert_eq!(clean_owner(Some("u1")), Some("u1".into()));
    }
}
