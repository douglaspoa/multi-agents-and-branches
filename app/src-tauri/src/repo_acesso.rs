//! Acesso à pasta do projeto — o "por quê" REAL quando o app não consegue abrir/usar um repo.
//!
//! Bug 21/10 (chat da Nova demanda): o usuário via o projeto na tela e cada envio voltava com "repo não definido" ou
//! "Sem permissão pra essa ação". Causas que este módulo separa (antes eram todas `db.exists() == false`, que no macOS
//! também é `false` quando a privacidade do sistema NEGA o acesso — e virava "rode `cardume init`"):
//! - `SEM_ACESSO_PASTA_MAC`: o macOS (Privacidade e Segurança › Arquivos e Pastas / Acesso Total ao Disco) não deu ao
//!   Starfork acesso à pasta — Documentos, Mesa, Downloads e iCloud são protegidas (EPERM, os error 1);
//! - `SEM_ACESSO_PASTA`: permissão de arquivo comum (EACCES, os error 13);
//! - `PASTA_SUMIU`: a pasta não existe mais;
//! - `SEM_WORKSPACE`: a pasta abre, mas falta preparar o projeto (`.cardume/state.sqlite`).
//! Os prefixos em MAIÚSCULAS são o contrato com o front (00-util.js, ERR_CATALOG) — a tela casa por eles.
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

fn name_of(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
}

/// Traduz um erro de IO ao tocar `what` (a pasta do projeto ou algo dentro dela) num motivo com prefixo.
pub(crate) fn io_reason(repo: &Path, e: &std::io::Error) -> String {
    let nm = name_of(repo);
    match (e.raw_os_error(), e.kind()) {
        (Some(1), _) => format!(
            "SEM_ACESSO_PASTA_MAC: o macOS não deu ao Starfork acesso à pasta \"{nm}\" ({}) — libere em Ajustes do Sistema › Privacidade e Segurança › Arquivos e Pastas (ou Acesso Total ao Disco). [{e}]",
            repo.display()
        ),
        (_, ErrorKind::PermissionDenied) => format!("SEM_ACESSO_PASTA: sem permissão de leitura na pasta \"{nm}\" ({}). [{e}]", repo.display()),
        (_, ErrorKind::NotFound) => format!("PASTA_SUMIU: a pasta do projeto não existe mais: {} (movida, renomeada ou apagada?)", repo.display()),
        _ => format!("pasta do projeto \"{nm}\" ({}): {e}", repo.display()),
    }
}

/// `Some(motivo)` quando a pasta do projeto não pode ser LIDA (o claude roda com ela como diretório atual).
pub(crate) fn folder_err(repo: &Path) -> Option<String> {
    match std::fs::read_dir(repo) {
        Ok(_) => None,
        Err(e) => Some(io_reason(repo, &e)),
    }
}

/// O state.sqlite do projeto, ou o motivo REAL de não dar pra abrir (pasta bloqueada ≠ falta preparar).
pub(crate) fn workspace_db(repo: &Path) -> Result<PathBuf, String> {
    if let Some(e) = folder_err(repo) {
        return Err(e);
    }
    let db = repo.join(".cardume").join("state.sqlite");
    match std::fs::metadata(&db) {
        Ok(_) => Ok(db),
        Err(e) if e.kind() == ErrorKind::NotFound => Err(format!(
            "SEM_WORKSPACE: a pasta \"{}\" ainda não foi preparada pro Starfork (sem .cardume/state.sqlite em {}) — toque em Preparar (ou rode `cardume init`).",
            name_of(repo),
            repo.display()
        )),
        Err(e) => Err(io_reason(repo, &e)),
    }
}

/// Erro de um comando de IA com o PASSO que falhou na frente ("abrir o projeto: …", "iniciar a IA: …").
pub(crate) fn step(passo: &str, e: impl std::fmt::Display) -> String {
    format!("{passo}: {e}")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-repo-acesso-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pasta_sem_workspace_pede_preparar_e_nao_fala_de_permissao() {
        let d = tmp("semws");
        let e = workspace_db(&d).unwrap_err();
        assert!(e.starts_with("SEM_WORKSPACE:"), "{e}");
        assert!(e.contains("Preparar"));
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        std::fs::write(d.join(".cardume/state.sqlite"), b"").unwrap();
        assert_eq!(workspace_db(&d).unwrap(), d.join(".cardume/state.sqlite"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pasta_que_sumiu() {
        let d = tmp("sumiu").join("nao-existe");
        assert!(workspace_db(&d).unwrap_err().starts_with("PASTA_SUMIU:"));
    }

    #[test]
    fn pasta_sem_permissao_nao_vira_rode_cardume_init() {
        let d = tmp("perm");
        std::fs::create_dir_all(d.join(".cardume")).unwrap();
        std::fs::write(d.join(".cardume/state.sqlite"), b"").unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = workspace_db(&d);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        // root lê tudo (CI em container): aí não há o que provar
        if let Err(e) = r {
            assert!(e.starts_with("SEM_ACESSO_PASTA"), "{e}");
            assert!(!e.contains("cardume init"));
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn eperm_do_macos_vira_o_caminho_dos_ajustes() {
        let e = std::io::Error::from_raw_os_error(1); // "Operation not permitted" — o que a privacidade do macOS devolve
        let m = io_reason(Path::new("/Users/fulano/Documents/loja"), &e);
        assert!(m.starts_with("SEM_ACESSO_PASTA_MAC:"), "{m}");
        assert!(m.contains("\"loja\"") && m.contains("Arquivos e Pastas") && m.contains("os error 1"));
        assert_eq!(step("iniciar a IA", "x"), "iniciar a IA: x");
    }
}
