//! Várias contas do GitHub SEM trocar a ativa do gh.
//!
//! - donos possíveis de um repositório novo vêm de TODAS as contas logadas (cada uma com o próprio token);
//! - o repositório criado/publicado pelo app guarda, no `.git/config` dele, qual conta faz o push
//!   (um credential helper que pede o token ao gh NA HORA — nenhum token vai pro disco nem pro log);
//! - push recusado por credencial ("Repository not found"/403) num projeto antigo: descobre qual conta
//!   logada enxerga o repo, grava a credencial local dela e tenta de novo uma vez.
//!
//! O token só existe em memória, como variável GH_TOKEN do processo filho do gh.

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Output};

use crate::{gh_accounts_with, gh_bin, output_timeout};

/// Chaves do git config (escopo do github.com: outros hosts seguem com o helper global).
pub(crate) const CRED_HELPER_KEY: &str = "credential.https://github.com.helper";
pub(crate) const CRED_USER_KEY: &str = "credential.https://github.com.username";

/// Login do GitHub: letras, números e hífen (sem começar com hífen), até 39 — nada que o shell interprete.
pub(crate) fn valid_account(a: &str) -> bool {
    !a.is_empty() && a.len() <= 39 && !a.starts_with('-') && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Token da conta `account` (`gh auth token -u`). Fica só em memória — nunca logar nem devolver ao front.
fn account_token(gh: &str, account: &str) -> Option<String> {
    if !valid_account(account) {
        return None;
    }
    let mut c = Command::new(gh);
    c.args(["auth", "token", "-h", "github.com", "-u", account]).env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN");
    let o = output_timeout(c, 10).ok().filter(|o| o.status.success())?;
    let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if t.is_empty() || t.contains(char::is_whitespace) { None } else { Some(t) }
}

/// Command do gh agindo COMO `account` (GH_TOKEN só no ambiente do filho). Sem token → conta ativa.
pub(crate) fn gh_as(gh: &str, account: &str) -> Command {
    let mut c = Command::new(gh);
    if let Some(t) = account_token(gh, account) {
        c.env("GH_TOKEN", t);
    }
    c
}

/// Conta gravada NESTE repositório pelo app (config local; worktrees enxergam a mesma).
pub(crate) fn repo_account(repo: &Path) -> Option<String> {
    let o = Command::new("git").arg("-C").arg(repo).args(["config", "--local", "--get", CRED_USER_KEY]).output().ok()?;
    let a = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if o.status.success() && valid_account(&a) { Some(a) } else { None }
}

/// gh pros comandos de um repositório: usa a conta gravada nele (se houver), senão a ativa.
pub(crate) fn gh_in(repo: &Path) -> Command {
    let gh = gh_bin();
    match repo_account(repo) {
        Some(a) => gh_as(&gh, &a),
        None => Command::new(gh),
    }
}

// ---------- donos (usuário + organizações) de todas as contas ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GhOwner {
    pub owner: String,
    pub account: String,
    /// "user" | "org"
    pub kind: String,
    /// a conta é a ativa do gh
    pub active: bool,
}

pub(crate) struct AccountOwners {
    pub account: String,
    pub active: bool,
    /// login devolvido por `gh api user` (None = a chamada falhou → usa o nome da conta)
    pub user: Option<String>,
    pub orgs: Vec<String>,
}

/// Junta os donos das contas: a ATIVA primeiro, em cada conta o usuário e depois as orgs.
/// Dono repetido (org enxergada por duas contas) fica na primeira conta que aparece.
pub(crate) fn merge_owners(mut list: Vec<AccountOwners>) -> Vec<GhOwner> {
    list.sort_by_key(|a| !a.active); // estável: ativa na frente, resto na ordem do gh
    let mut out: Vec<GhOwner> = vec![];
    let push = |out: &mut Vec<GhOwner>, owner: &str, a: &AccountOwners, kind: &str| {
        let owner = owner.trim();
        if owner.is_empty() || out.iter().any(|o| o.owner.eq_ignore_ascii_case(owner)) {
            return;
        }
        out.push(GhOwner { owner: owner.to_string(), account: a.account.clone(), kind: kind.into(), active: a.active });
    };
    for a in &list {
        let user = a.user.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| a.account.clone());
        push(&mut out, &user, a, "user");
        for o in &a.orgs {
            push(&mut out, o, a, "org");
        }
    }
    out
}

fn api_lines(mut c: Command, args: &[&str], secs: u64) -> Option<Vec<String>> {
    c.args(args);
    let o = output_timeout(c, secs).ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// Donos de TODAS as contas logadas no gh (`gh` = binário; nos testes, um gh falso).
pub(crate) fn list_owners_with(gh: &str) -> Vec<GhOwner> {
    // tokens um de cada vez (o chaveiro do sistema não gosta de leituras simultâneas); a rede em paralelo
    let accts: Vec<_> = gh_accounts_with(gh).unwrap_or_default().into_iter().map(|a| (account_token(gh, &a.user), a)).collect();
    let handles: Vec<_> = accts
        .into_iter()
        .map(|(tok, a)| {
            let gh = gh.to_string();
            std::thread::spawn(move || {
                let cmd = || -> Option<Command> {
                    match &tok {
                        Some(t) => {
                            let mut c = Command::new(&gh);
                            c.env("GH_TOKEN", t);
                            Some(c)
                        }
                        // gh antigo (sem `auth token -u`): só a ativa responde, como antes
                        None if a.active => Some(Command::new(&gh)),
                        None => None,
                    }
                };
                let c1 = cmd()?;
                let user = api_lines(c1, &["api", "user", "--jq", ".login"], 15).and_then(|v| v.into_iter().next());
                let orgs = cmd().and_then(|c| api_lines(c, &["api", "user/orgs", "--paginate", "--jq", ".[].login"], 20)).unwrap_or_default();
                Some(AccountOwners { account: a.user, active: a.active, user, orgs })
            })
        })
        .collect();
    merge_owners(handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect())
}

/// Conta que cria o repositório no dono `owner`: a pedida (se logada), senão a dona do `owner`,
/// senão a ativa. None = gh sem nenhuma conta.
pub(crate) fn account_for(gh: &str, owner: &str, wanted: Option<&str>) -> Option<String> {
    let accts = gh_accounts_with(gh).unwrap_or_default();
    if let Some(w) = wanted.map(str::trim).filter(|w| !w.is_empty()) {
        if accts.iter().any(|a| a.user.eq_ignore_ascii_case(w)) {
            return Some(w.to_string());
        }
    }
    let owner = owner.trim();
    if !owner.is_empty() {
        if let Some(o) = list_owners_with(gh).into_iter().find(|o| o.owner.eq_ignore_ascii_case(owner)) {
            return Some(o.account);
        }
    }
    accts.iter().find(|a| a.active).or(accts.first()).map(|a| a.user.clone())
}

// ---------- credencial do push por repositório ----------

/// Aspas simples de shell ('…' com ' → '\'').
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Helper do git que entrega usuário + token da conta NA HORA do push (o token não fica gravado).
/// O git roda `sh -c '<helper> "$@"' _ get|store|erase`; só o `get` responde.
pub(crate) fn helper_command(gh: &str, account: &str) -> String {
    format!(
        "!f(){{ test \"$1\" = get || return 0; echo username={a}; echo \"password=$({g} auth token -h github.com -u {a})\"; }}; f",
        g = sh_quote(gh),
        a = account
    )
}

fn git_cfg(repo: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git").arg("-C").arg(repo).args(["config", "--local"]).args(args).output().map_err(|e| format!("git config: {e}"))
}

/// Grava no repositório: push pro github.com sempre como `account` (zera o helper global antes).
pub(crate) fn set_repo_account(repo: &Path, gh: &str, account: &str) -> Result<(), String> {
    if !valid_account(account) {
        return Err(format!("conta do GitHub inválida: {account}"));
    }
    let _ = git_cfg(repo, &["--unset-all", CRED_HELPER_KEY]);
    for args in [
        vec!["--add", CRED_HELPER_KEY, ""],
        vec!["--add", CRED_HELPER_KEY, &helper_command(gh, account)],
        vec!["--replace-all", CRED_USER_KEY, account],
    ] {
        let o = git_cfg(repo, &args)?;
        if !o.status.success() {
            return Err(format!("git config: {}", String::from_utf8_lossy(&o.stderr).trim()));
        }
    }
    Ok(())
}

/// Mensagem pro usuário quando o app escolheu a conta do push sozinho.
pub(crate) fn push_note(account: &str) -> String {
    format!("o push agora usa a conta {account} neste projeto")
}

/// Push recusado por CREDENCIAL (conta errada), não por rede/histórico.
pub(crate) fn is_auth_push_error(stderr: &str) -> bool {
    let l = stderr.to_lowercase();
    l.contains("repository not found")
        || l.contains("403")
        || (l.contains("permission to") && l.contains("denied"))
        || l.contains("permission denied")
        || l.contains("authentication failed")
        || l.contains("invalid username or password")
        || l.contains("could not read username")
}

/// `owner/repo` de um remote HTTPS do github.com (o helper só vale pra HTTPS; ssh fica de fora).
pub(crate) fn https_github_slug(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest); // https://user@github.com/…
    let path = rest.strip_prefix("github.com/")?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (o, r) = path.split_once('/')?;
    if o.is_empty() || r.is_empty() || r.contains('/') { None } else { Some(format!("{o}/{r}")) }
}

/// Qual conta usar dadas as sondagens (conta, enxerga o repo, pode dar push):
/// exatamente uma enxerga → ela; várias → a única com push; senão nenhuma (ambíguo / ninguém).
pub(crate) fn pick_account(seen: &[(String, bool, bool)]) -> Option<String> {
    let vis: Vec<&(String, bool, bool)> = seen.iter().filter(|s| s.1).collect();
    if vis.len() == 1 {
        return Some(vis[0].0.clone());
    }
    let push: Vec<_> = vis.iter().filter(|s| s.2).collect();
    if push.len() == 1 { Some(push[0].0.clone()) } else { None }
}

/// (enxerga, pode dar push) do repo `slug` com o token de uma conta.
fn probe_repo(gh: &str, token: Option<&str>, slug: &str) -> (bool, bool) {
    let Some(t) = token else { return (false, false) };
    let mut c = Command::new(gh);
    c.env("GH_TOKEN", t).args(["api", &format!("repos/{slug}"), "--jq", ".permissions.push"]);
    match output_timeout(c, 15) {
        Ok(o) if o.status.success() => (true, String::from_utf8_lossy(&o.stdout).trim() == "true"),
        _ => (false, false),
    }
}

/// Push falhou por credencial: acha a conta logada que enxerga o repo, grava a credencial local
/// dela e devolve o nome (pra tentar de novo). None = não é caso de credencial / não deu pra decidir.
pub(crate) fn recover_push_account(gh: &str, repo: &Path, stderr: &str) -> Option<String> {
    if !is_auth_push_error(stderr) {
        return None;
    }
    let o = Command::new("git").arg("-C").arg(repo).args(["config", "--get", "remote.origin.url"]).output().ok()?;
    let slug = https_github_slug(&String::from_utf8_lossy(&o.stdout))?;
    let accts: Vec<_> = gh_accounts_with(gh).ok()?.into_iter().map(|a| (account_token(gh, &a.user), a.user)).collect();
    let handles: Vec<_> = accts
        .into_iter()
        .map(|(tok, user)| {
            let (gh, slug) = (gh.to_string(), slug.clone());
            std::thread::spawn(move || {
                let (vis, push) = probe_repo(&gh, tok.as_deref(), &slug);
                (user, vis, push)
            })
        })
        .collect();
    let seen: Vec<(String, bool, bool)> = handles.into_iter().filter_map(|h| h.join().ok()).collect();
    let acc = pick_account(&seen)?;
    if repo_account(repo).as_deref() == Some(acc.as_str()) {
        return None; // já era esta conta: tentar de novo daria o mesmo erro
    }
    set_repo_account(repo, gh, &acc).ok()?;
    Some(acc)
}

/// `git <args>` em `dir` (um push); recusado por credencial → corrige a conta do repo e tenta UMA vez mais.
/// Devolve a saída final e, se trocou, a conta escolhida.
pub(crate) fn git_push_any_account(dir: &Path, args: &[&str]) -> Result<(Output, Option<String>), String> {
    let run = || Command::new("git").arg("-C").arg(dir).args(args).env("GIT_TERMINAL_PROMPT", "0").output().map_err(|e| e.to_string());
    let out = run()?;
    if out.status.success() {
        return Ok((out, None));
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    match recover_push_account(&gh_bin(), dir, &err) {
        Some(acc) => Ok((run()?, Some(acc))),
        None => Ok((out, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-ghcontas-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// gh falso: duas contas (pessoal ativa + trabalho), token por conta, api respondendo pelo GH_TOKEN.
    fn fake_gh(dir: &Path) -> String {
        let p = dir.join("gh");
        std::fs::write(
            &p,
            r#"#!/bin/sh
case "$*" in
  "auth status") printf 'github.com\n  ✓ Logged in to github.com account pessoal (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  ✓ Logged in to github.com account trampo (keyring)\n  - Active account: false\n  - Git operations protocol: https\n' >&2; exit 0;;
  "auth token -h github.com -u pessoal") echo tok-pessoal; exit 0;;
  "auth token -h github.com -u trampo") echo tok-trampo; exit 0;;
  "api user --jq .login") case "$GH_TOKEN" in tok-pessoal) echo pessoal;; tok-trampo) echo trampo;; *) exit 1;; esac; exit 0;;
  "api user/orgs --paginate --jq .[].login") case "$GH_TOKEN" in tok-pessoal) echo minha-org;; tok-trampo) printf 'empresa\nminha-org\n';; *) exit 1;; esac; exit 0;;
  "api repos/empresa/app --jq .permissions.push") [ "$GH_TOKEN" = tok-trampo ] && { echo true; exit 0; }; echo 'Not Found' >&2; exit 1;;
  "api repos/aberto/lib --jq .permissions.push") [ "$GH_TOKEN" = tok-trampo ] && echo true || echo false; exit 0;;
esac
exit 1
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p.display().to_string()
    }

    fn git(dir: &Path, args: &[&str]) -> Output {
        Command::new("git").arg("-C").arg(dir).args(args).output().unwrap()
    }

    #[test]
    fn merge_ativa_primeiro_e_sem_dono_repetido() {
        let got = merge_owners(vec![
            AccountOwners { account: "trampo".into(), active: false, user: Some("trampo".into()), orgs: vec!["empresa".into(), "Minha-Org".into()] },
            AccountOwners { account: "pessoal".into(), active: true, user: None, orgs: vec!["minha-org".into(), " ".into()] },
        ]);
        let v: Vec<(&str, &str, &str, bool)> = got.iter().map(|o| (o.owner.as_str(), o.account.as_str(), o.kind.as_str(), o.active)).collect();
        assert_eq!(v, vec![
            ("pessoal", "pessoal", "user", true), // api user falhou → nome da conta
            ("minha-org", "pessoal", "org", true),
            ("trampo", "trampo", "user", false),
            ("empresa", "trampo", "org", false),
        ]);
    }

    #[test]
    fn donos_de_todas_as_contas_pelo_gh_falso() {
        let d = tmpdir("donos");
        let gh = fake_gh(&d);
        let got = list_owners_with(&gh);
        let v: Vec<(String, String, String)> = got.iter().map(|o| (o.owner.clone(), o.account.clone(), o.kind.clone())).collect();
        assert_eq!(v, vec![
            ("pessoal".into(), "pessoal".into(), "user".into()),
            ("minha-org".into(), "pessoal".into(), "org".into()),
            ("trampo".into(), "trampo".into(), "user".into()),
            ("empresa".into(), "trampo".into(), "org".into()),
        ]);
        assert_eq!(account_for(&gh, "empresa", None).as_deref(), Some("trampo"));
        assert_eq!(account_for(&gh, "", None).as_deref(), Some("pessoal"));
        assert_eq!(account_for(&gh, "empresa", Some("pessoal")).as_deref(), Some("pessoal"));
        assert_eq!(account_for(&gh, "empresa", Some("intrusa")).as_deref(), Some("trampo"));
        // o token vai SÓ no ambiente do filho
        let c = gh_as(&gh, "trampo");
        let env: Vec<_> = c.get_envs().filter(|(k, _)| *k == "GH_TOKEN").map(|(_, v)| v.map(|v| v.to_string_lossy().to_string())).collect();
        assert_eq!(env, vec![Some("tok-trampo".to_string())]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn helper_aspas_e_validacao() {
        assert_eq!(sh_quote("/a b/it's/gh"), r"'/a b/it'\''s/gh'");
        let h = helper_command("/opt/homebrew/bin/gh", "douglaspoa-logcomex");
        assert_eq!(h, r#"!f(){ test "$1" = get || return 0; echo username=douglaspoa-logcomex; echo "password=$('/opt/homebrew/bin/gh' auth token -h github.com -u douglaspoa-logcomex)"; }; f"#);
        assert!(valid_account("douglaspoa-logcomex"));
        for bad in ["", "-x", "a b", "a;rm", "a$(x)", "a'b", &"x".repeat(40)] {
            assert!(!valid_account(bad), "{bad}");
        }
        let d = tmpdir("inval");
        assert!(set_repo_account(&d, "gh", "a;rm -rf").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn credencial_local_vence_o_helper_global() {
        let d = tmpdir("cred");
        let gh = fake_gh(&d);
        let repo = d.join("r");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(git(&repo, &["init", "-q"]).status.success());
        // "global" com um helper que entregaria a conta errada
        let global = d.join("gitconfig");
        std::fs::write(&global, "[credential \"https://github.com\"]\n\thelper = \"!f(){ echo username=errada; echo password=tok-errado; }; f\"\n").unwrap();
        set_repo_account(&repo, &gh, "trampo").unwrap();
        set_repo_account(&repo, &gh, "trampo").unwrap(); // idempotente: não empilha helpers
        let all = git(&repo, &["config", "--local", "--get-all", CRED_HELPER_KEY]);
        let lines: Vec<String> = String::from_utf8_lossy(&all.stdout).lines().map(String::from).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "");
        assert_eq!(repo_account(&repo).as_deref(), Some("trampo"));
        let mut c = Command::new("git");
        c.arg("-C").arg(&repo).args(["credential", "fill"]).env("GIT_CONFIG_GLOBAL", &global).env("GIT_TERMINAL_PROMPT", "0");
        c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut ch = c.spawn().unwrap();
        {
            use std::io::Write;
            ch.stdin.take().unwrap().write_all(b"protocol=https\nhost=github.com\npath=empresa/app.git\n\n").unwrap();
        }
        let out = ch.wait_with_output().unwrap();
        let s = String::from_utf8_lossy(&out.stdout);
        assert!(s.contains("username=trampo"), "{s}");
        assert!(s.contains("password=tok-trampo"), "{s}");
        assert!(!s.contains("errad"), "{s}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deteccao_de_erro_de_credencial_e_slug() {
        assert!(is_auth_push_error("remote: Repository not found.\nfatal: repository 'https://github.com/comexio/x.git/' not found"));
        assert!(is_auth_push_error("remote: Permission to comexio/x.git denied to douglaspoa.\nfatal: unable to access '…': The requested URL returned error: 403"));
        assert!(!is_auth_push_error("! [rejected] main -> main (fetch first)"));
        assert!(!is_auth_push_error("Could not resolve host: github.com"));
        assert_eq!(https_github_slug("https://github.com/comexio/x.git").as_deref(), Some("comexio/x"));
        assert_eq!(https_github_slug("https://douglaspoa@github.com/o/r/").as_deref(), Some("o/r"));
        assert_eq!(https_github_slug("git@github.com:o/r.git"), None);
        assert_eq!(https_github_slug("https://gitlab.com/o/r"), None);
        let s = |v: &[(&str, bool, bool)]| v.iter().map(|(a, b, c)| (a.to_string(), *b, *c)).collect::<Vec<_>>();
        assert_eq!(pick_account(&s(&[("a", false, false), ("b", true, true)])).as_deref(), Some("b"));
        assert_eq!(pick_account(&s(&[("a", true, false), ("b", true, false)])), None); // ambíguo
        assert_eq!(pick_account(&s(&[("a", true, false), ("b", true, true)])).as_deref(), Some("b")); // só b dá push
        assert_eq!(pick_account(&s(&[("a", false, false)])), None);
    }

    #[test]
    fn push_recusado_acha_a_conta_que_enxerga_o_repo() {
        let d = tmpdir("recover");
        let gh = fake_gh(&d);
        let repo = d.join("r");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(git(&repo, &["init", "-q"]).status.success());
        assert!(git(&repo, &["remote", "add", "origin", "https://github.com/empresa/app.git"]).status.success());
        let err = "remote: Repository not found.\nfatal: repository 'https://github.com/empresa/app.git/' not found";
        assert_eq!(recover_push_account(&gh, &repo, "! [rejected] (fetch first)"), None); // não é credencial
        assert_eq!(recover_push_account(&gh, &repo, err).as_deref(), Some("trampo"));
        assert_eq!(repo_account(&repo).as_deref(), Some("trampo"));
        // já configurada com a mesma conta: não tenta de novo (evita laço)
        assert_eq!(recover_push_account(&gh, &repo, err), None);
        // repo que as duas enxergam mas só uma dá push
        assert!(git(&repo, &["remote", "set-url", "origin", "https://github.com/aberto/lib"]).status.success());
        let _ = git(&repo, &["config", "--local", "--unset", CRED_USER_KEY]);
        assert_eq!(recover_push_account(&gh, &repo, "error: 403").as_deref(), Some("trampo"));
        // ssh: o helper não se aplica
        assert!(git(&repo, &["remote", "set-url", "origin", "git@github.com:empresa/app.git"]).status.success());
        let _ = git(&repo, &["config", "--local", "--unset", CRED_USER_KEY]);
        assert_eq!(recover_push_account(&gh, &repo, err), None);
        assert_eq!(push_note("trampo"), "o push agora usa a conta trampo neste projeto");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Prova REAL (ignorado por padrão): `REAL_GH=1 cargo test --lib gh_contas::tests::real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_donos_de_todas_as_contas() {
        let got = list_owners_with(&gh_bin());
        for o in &got {
            println!("{} · {} · via {}{}", o.owner, o.kind, o.account, if o.active { " (ativa)" } else { "" });
        }
        let accts: std::collections::HashSet<_> = got.iter().map(|o| o.account.clone()).collect();
        assert!(accts.len() >= 2, "esperava donos de 2+ contas: {got:?}");
    }

    /// Prova REAL do helper (ignorado): `REAL_URL=https://github.com/o/r.git REAL_ACCOUNT=conta cargo test --lib
    /// gh_contas::tests::real_ls_remote -- --ignored --nocapture` — repo novo, credencial local, `git ls-remote`.
    #[test]
    #[ignore]
    fn real_ls_remote() {
        let (url, acc) = (std::env::var("REAL_URL").unwrap(), std::env::var("REAL_ACCOUNT").unwrap());
        let d = tmpdir("real");
        assert!(git(&d, &["init", "-q"]).status.success());
        assert!(git(&d, &["remote", "add", "origin", &url]).status.success());
        set_repo_account(&d, &gh_bin(), &acc).unwrap();
        let o = Command::new("git").arg("-C").arg(&d).args(["ls-remote", "--heads", "origin"]).env("GIT_TERMINAL_PROMPT", "0").output().unwrap();
        println!("ls-remote como {acc}: ok={} · {} refs · {}", o.status.success(), String::from_utf8_lossy(&o.stdout).lines().count(), String::from_utf8_lossy(&o.stderr).trim());
        let _ = std::fs::remove_dir_all(&d);
        assert!(o.status.success());
    }

    /// Prova REAL da detecção (ignorado): `REAL_URL=… REAL_EXPECT=conta cargo test --lib gh_contas::tests::real_recover -- --ignored --nocapture`
    /// — repo sem credencial local, push "recusado" → acha a conta que enxerga o repo e faz o ls-remote com ela.
    #[test]
    #[ignore]
    fn real_recover() {
        let (url, want) = (std::env::var("REAL_URL").unwrap(), std::env::var("REAL_EXPECT").unwrap());
        let d = tmpdir("realrec");
        assert!(git(&d, &["init", "-q"]).status.success());
        assert!(git(&d, &["remote", "add", "origin", &url]).status.success());
        let got = recover_push_account(&gh_bin(), &d, "remote: Repository not found.");
        let o = Command::new("git").arg("-C").arg(&d).args(["ls-remote", "--heads", "origin"]).env("GIT_TERMINAL_PROMPT", "0").output().unwrap();
        println!("conta detectada: {got:?} · {} · ls-remote ok={}", got.as_deref().map(push_note).unwrap_or_default(), o.status.success());
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(got.as_deref(), Some(want.as_str()));
        assert!(o.status.success());
    }
}
