//! Estado REAL do PR de uma tarefa (28/10 — "aprovei, abri o PR e fiz merge no GitHub e ela continua em
//! Precisa de mim; esse check nunca funcionou direito").
//!
//! Por que nunca funcionou: (1) sem `spec.prUrl` ninguém procurava o PR — o painel Aprovar só consultava tarefa COM
//! prUrl e a sondagem da nuvem rodava 1×/sessão, só com time; (2) a consulta usava a conta ATIVA do gh — com o repo
//! numa org de outra conta, "Could not resolve to a Repository", engolido calado; (3) não havia plano B sem o gh.
//!
//! Aqui: procura o PR pela branch (head) com a conta ligada ao projeto (gh_contas::gh_in_with — descobre a conta
//! certa sozinho), e quando o gh não serve (sem gh, sem acesso, sem rede) cai no git: a branch já está na base?
//! (ancestralidade, rebase via `git cherry`, squash comparando o conteúdo dos arquivos que a branch mexeu).
use serde::Serialize;
use std::path::Path;
use std::process::Command;

use crate::{gh_contas, output_timeout};

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrSync {
    /// "gh" (o GitHub respondeu) · "git" (conferido pelo git) · "none" (nada conclusivo)
    pub source: String,
    /// OPEN · MERGED · CLOSED · NONE (sem PR) · UNKNOWN (não deu pra conferir)
    pub state: String,
    pub number: u64,
    pub url: String,
    pub head: String,
    /// conta do gh que respondeu (vazia = a ativa)
    pub account: String,
    /// motivo humano (o que o git achou / por que não deu pra conferir)
    pub reason: String,
    /// "access" | "network" | "nogh" | "other" | ""
    pub err_kind: String,
    /// a tarefa acabou de virar integrada por esta conferência
    pub flipped: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PrFound {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub head: String,
}

/// Branch de tronco (main, develop…): NUNCA é a head do PR de uma tarefa. A branch da tarefa nasce de `origin/main`, então
/// o upstream dela é `main` — procurar PR "pela head main" achava qualquer PR antigo main→main (29/10: tarefa ligada ao
/// #232 "atualiza", de julho, e marcada integrada sem nunca ter subido).
pub(crate) fn is_trunk(name: &str, extra: &[&str]) -> bool {
    let n = name.trim().trim_start_matches("origin/");
    n.is_empty()
        || ["main", "master", "develop", "development", "dev", "trunk", "staging", "homol", "production", "release"].contains(&n)
        || extra.iter().any(|e| !e.trim().is_empty() && e.trim().trim_start_matches("origin/") == n)
}
/// O PR gravado na tarefa é de OUTRA branch (head = tronco, ou nenhuma das heads possíveis da tarefa): link errado.
pub(crate) fn link_bogus(found_head: &str, branch: &str, heads: &[String]) -> bool {
    let h = found_head.trim();
    !h.is_empty() && h != branch && (is_trunk(h, &[]) || !heads.iter().any(|x| x == h))
}

/// Saída de `gh pr list --json number,url,state,headRefName,updatedAt` (ou de um `gh pr view` = objeto) → o PR que vale:
/// aberto primeiro (é o que está vivo), senão o integrado, senão o fechado — o mais recente em cada grupo.
pub(crate) fn pick_pr(json: &str) -> Option<PrFound> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let arr = match v {
        serde_json::Value::Array(a) => a,
        o @ serde_json::Value::Object(_) => vec![o],
        _ => return None,
    };
    let rank = |s: &str| match s { "OPEN" => 0, "MERGED" => 1, "CLOSED" => 2, _ => 3 };
    let mut best: Option<(i32, String, PrFound)> = None;
    for x in arr {
        let number = x["number"].as_u64().unwrap_or(0);
        if number == 0 { continue; }
        let st = x["state"].as_str().unwrap_or("").to_ascii_uppercase();
        let f = PrFound { number, url: x["url"].as_str().unwrap_or("").to_string(), state: st.clone(), head: x["headRefName"].as_str().unwrap_or("").to_string() };
        let up = x["updatedAt"].as_str().unwrap_or("").to_string();
        let r = rank(&st);
        let better = match &best { None => true, Some((br, bu, _)) => r < *br || (r == *br && up > *bu) };
        if better { best = Some((r, up, f)); }
    }
    best.map(|b| b.2)
}

/// Tipo de falha do gh (o texto que a pessoa vê vem de `err_reason`).
pub(crate) fn err_kind(stderr: &str) -> &'static str {
    let l = stderr.to_lowercase();
    if l.contains("could not resolve to a repository") || l.contains("http 404") || l.contains("not found") && l.contains("repos/") || l.contains("saml") {
        "access"
    } else if l.contains("os error 2") || l.contains("no such file") || l.contains("command not found") || l.contains("gh auth login") || l.contains("not logged") {
        "nogh"
    } else if l.contains("could not resolve host") || l.contains("timed out") || l.contains("timeout") || l.contains("network") || l.contains("connection") || l.contains("sem resposta") {
        "network"
    } else {
        "other"
    }
}
pub(crate) fn err_reason(kind: &str, slug: &str) -> String {
    match kind {
        "access" => format!("nenhuma conta do GitHub logada no gh enxerga {}", if slug.is_empty() { "este repositório" } else { slug }),
        "nogh" => "o GitHub CLI (gh) não está instalado ou sem login".into(),
        "network" => "sem resposta do GitHub (rede)".into(),
        _ => "o GitHub CLI (gh) deu erro".into(),
    }
}

fn gh_json(mut c: Command, repo: &Path, args: &[&str], slug: &str) -> Result<String, String> {
    c.args(args);
    if !slug.is_empty() { c.args(["--repo", slug]); }
    c.current_dir(repo);
    let o = output_timeout(c, 15)?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).to_string()) } else { Err(String::from_utf8_lossy(&o.stderr).to_string()) }
}

/// Procura o PR: pelo link gravado (se houver), senão por cada head candidata (branch atual + nome remoto antigo).
/// Ok(None) = o GitHub respondeu e não há PR. Err(stderr) = o gh não serviu.
pub(crate) fn gh_find(gh: &str, repo: &Path, slug: &str, pr_url: &str, heads: &[String]) -> Result<Option<PrFound>, String> {
    const F: &str = "number,url,state,headRefName,updatedAt";
    if !pr_url.trim().is_empty() {
        let out = gh_json(gh_contas::gh_in_with(gh, repo), repo, &["pr", "view", pr_url.trim(), "--json", F], "")?;
        return Ok(pick_pr(&out));
    }
    let mut all: Vec<PrFound> = vec![];
    for h in heads.iter().filter(|h| !h.trim().is_empty()) {
        let out = gh_json(gh_contas::gh_in_with(gh, repo), repo, &["pr", "list", "--head", h, "--state", "all", "--limit", "20", "--json", F], slug)?;
        // defesa: `--head` casa só a head, mas um PR main→main nunca é o da tarefa
        if let Some(p) = pick_pr(&out).filter(|p| !is_trunk(&p.head, &[])) { all.push(p); }
    }
    // mesma régua entre as heads: aberto > integrado > fechado
    let rank = |s: &str| match s { "OPEN" => 0, "MERGED" => 1, "CLOSED" => 2, _ => 3 };
    all.sort_by_key(|p| rank(&p.state));
    Ok(all.into_iter().next())
}

/// gh_find com a conta certa: se a conta usada não enxerga o repo, descobre a que enxerga (sem trocar a ativa) e tenta 1× mais.
pub(crate) fn gh_find_any_account(gh: &str, repo: &Path, slug: &str, pr_url: &str, heads: &[String], force: bool) -> Result<Option<PrFound>, String> {
    match gh_find(gh, repo, slug, pr_url, heads) {
        Err(e) if err_kind(&e) == "access" && !slug.is_empty() => {
            if gh_contas::discover_query_account(gh, repo, slug, force).is_some() {
                gh_find(gh, repo, slug, pr_url, heads)
            } else {
                Err(e)
            }
        }
        r => r,
    }
}

// ---------------------------------------------------------------- plano B: o git
fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let o = Command::new("git").arg("-C").arg(repo).args(args).env("GIT_TERMINAL_PROMPT", "0").output().ok()?;
    if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None }
}
fn git_ok(repo: &Path, args: &[&str]) -> bool {
    Command::new("git").arg("-C").arg(repo).args(args).env("GIT_TERMINAL_PROMPT", "0").output().map(|o| o.status.success()).unwrap_or(false)
}
fn rev(repo: &Path, r: &str) -> Option<String> { git(repo, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).filter(|s| !s.is_empty()) }

/// O que o git diz: ("MERGED", motivo) se o conteúdo da branch JÁ está na base; ("UNKNOWN", motivo) se não dá pra
/// afirmar. `since_ms` = criação da tarefa (uma branch sem commit novo "está na base" à toa — não conta).
/// `fetch` = buscar o origin antes (com --prune: a branch apagada no GitHub some de origin/).
pub(crate) fn git_verdict(repo: &Path, branch: &str, base: &str, since_ms: i64, fetch: bool) -> (String, String) {
    let base = base.trim().trim_start_matches("origin/");
    let base = if base.is_empty() { "main" } else { base };
    let mut fetched = true;
    if fetch {
        let mut c = Command::new("git");
        c.arg("-C").arg(repo).args(["fetch", "--prune", "--quiet", "origin"]).env("GIT_TERMINAL_PROMPT", "0");
        fetched = output_timeout(c, 40).map(|o| o.status.success()).unwrap_or(false);
    }
    let base_ref = if rev(repo, &format!("refs/remotes/origin/{base}")).is_some() { format!("origin/{base}") } else { base.to_string() };
    let Some(base_sha) = rev(repo, &base_ref) else { return ("UNKNOWN".into(), format!("não achei a {base} neste repositório")) };
    let tip = rev(repo, &format!("refs/heads/{branch}")).or_else(|| rev(repo, &format!("refs/remotes/origin/{branch}")));
    let Some(tip) = tip else { return ("UNKNOWN".into(), "a branch da tarefa não existe mais neste computador".into()) };
    let remote_gone = fetched && rev(repo, &format!("refs/remotes/origin/{branch}")).is_none();
    let mb = git(repo, &["merge-base", &tip, &base_sha]).unwrap_or_default();
    // 1) merge comum / fast-forward: a ponta da branch já está na base — desde que a branch tenha commit DA TAREFA
    if mb == tip {
        let ct = git(repo, &["log", "-1", "--format=%ct", &tip]).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) * 1000;
        if since_ms > 0 && ct + 120_000 < since_ms {
            return ("UNKNOWN".into(), "a branch não tem commit novo da tarefa".into());
        }
        return ("MERGED".into(), format!("o último commit da branch já está na {base}"));
    }
    // 2) rebase-merge: todo commit da branch tem um equivalente na base
    if let Some(ch) = git(repo, &["cherry", &base_sha, &tip]) {
        let lines: Vec<&str> = ch.lines().filter(|l| !l.trim().is_empty()).collect();
        if !lines.is_empty() && lines.iter().all(|l| l.starts_with('-')) {
            return ("MERGED".into(), format!("os commits da branch já estão na {base}"));
        }
    }
    // 3) squash: os arquivos que a branch mexeu estão IGUAIS na base (o conteúdo entrou num commit só)
    let files: Vec<String> = git(repo, &["diff", "--name-only", &mb, &tip]).unwrap_or_default().lines().map(String::from).filter(|l| !l.is_empty()).collect();
    if !files.is_empty() && !mb.is_empty() {
        let mut args: Vec<&str> = vec!["diff", "--quiet", &tip, &base_sha, "--"];
        args.extend(files.iter().map(|s| s.as_str()));
        if git_ok(repo, &args) {
            return ("MERGED".into(), format!("o conteúdo da branch já está na {base} (squash)"));
        }
    }
    if remote_gone {
        return ("UNKNOWN".into(), format!("a branch foi apagada no GitHub, mas o conteúdo dela não está na {base}"));
    }
    ("UNKNOWN".into(), format!("pelo git, a branch ainda não está na {base}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sf-prreal-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn g(dir: &Path, args: &[&str]) {
        let o = Command::new("git").arg("-C").arg(dir).args(args)
            .env("GIT_AUTHOR_NAME", "Ana").env("GIT_AUTHOR_EMAIL", "ana@exemplo.test")
            .env("GIT_COMMITTER_NAME", "Ana").env("GIT_COMMITTER_EMAIL", "ana@exemplo.test").output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }
    fn write(dir: &Path, f: &str, s: &str) { std::fs::write(dir.join(f), s).unwrap(); }
    /// repo "loja-web" com origin local (bare) e uma branch de tarefa com 1 commit
    fn loja(tag: &str) -> (PathBuf, PathBuf) {
        let d = tmpdir(tag);
        let bare = d.join("origin.git");
        let r = d.join("loja-web");
        std::fs::create_dir_all(&r).unwrap();
        g(&d, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        g(&r, &["init", "-q", "-b", "main"]);
        write(&r, "a.txt", "um\n");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "base"]);
        g(&r, &["remote", "add", "origin", bare.to_str().unwrap()]);
        g(&r, &["push", "-q", "origin", "main"]);
        g(&r, &["checkout", "-qb", "design/LW-12-cupom"]);
        write(&r, "cupom.js", "export const cupom = 10;\n");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "cupom"]);
        g(&r, &["push", "-q", "origin", "design/LW-12-cupom"]);
        g(&r, &["checkout", "-q", "main"]);
        (d, r)
    }

    #[test]
    fn escolhe_o_pr_que_vale() {
        assert_eq!(pick_pr("[]"), None);
        let j = r#"[{"number":3,"url":"https://github.com/loja/web/pull/3","state":"CLOSED","headRefName":"x","updatedAt":"2026-10-01"},
                    {"number":7,"url":"https://github.com/loja/web/pull/7","state":"MERGED","headRefName":"x","updatedAt":"2026-10-02"}]"#;
        assert_eq!(pick_pr(j).unwrap().number, 7);
        let j2 = r#"[{"number":7,"state":"MERGED","updatedAt":"2026-10-02"},{"number":9,"state":"OPEN","updatedAt":"2026-09-01"}]"#;
        assert_eq!(pick_pr(j2).unwrap().number, 9, "aberto vence");
        let o = r#"{"number":5,"url":"u","state":"merged","headRefName":"h"}"#;
        assert_eq!(pick_pr(o).unwrap().state, "MERGED");
    }

    #[test]
    fn tronco_nunca_e_head_de_pr_da_tarefa() {
        assert!(is_trunk("main", &[]) && is_trunk("origin/master", &[]) && is_trunk("develop", &[]));
        assert!(is_trunk("hml", &["origin/hml"]));
        assert!(!is_trunk("feat/LW-1-cupom", &[]) && !is_trunk("agent/x", &[]));
        let heads = vec!["feat/LW-1-cupom".to_string(), "agent/cupom".to_string()];
        // o caso real: PR antigo main→main ligado à tarefa
        assert!(link_bogus("main", "feat/LW-1-cupom", &heads));
        // PR de outra branch qualquer também não é dela
        assert!(link_bogus("feat/LW-9-outra", "feat/LW-1-cupom", &heads));
        // a própria branch ou o nome antigo (renomeada depois do push) valem
        assert!(!link_bogus("feat/LW-1-cupom", "feat/LW-1-cupom", &heads));
        assert!(!link_bogus("agent/cupom", "feat/LW-1-cupom", &heads));
        assert!(!link_bogus("", "feat/LW-1-cupom", &heads));
    }

    #[test]
    fn tipos_de_erro_do_gh() {
        assert_eq!(err_kind("GraphQL: Could not resolve to a Repository with the name 'loja/web'. (repository)"), "access");
        assert_eq!(err_kind("error connecting to api.github.com\nCould not resolve host"), "network");
        assert_eq!(err_kind("No such file or directory (os error 2)"), "nogh");
        assert!(err_reason("access", "loja/web").contains("loja/web"));
    }

    #[test]
    fn git_merge_comum_vira_integrada() {
        let (d, r) = loja("ff");
        assert_eq!(git_verdict(&r, "design/LW-12-cupom", "main", 0, true).0, "UNKNOWN");
        g(&r, &["merge", "-q", "--no-ff", "-m", "merge", "design/LW-12-cupom"]);
        g(&r, &["push", "-q", "origin", "main"]);
        let (st, why) = git_verdict(&r, "design/LW-12-cupom", "main", 0, true);
        assert_eq!(st, "MERGED", "{why}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn git_squash_e_branch_apagada() {
        let (d, r) = loja("squash");
        // 2º commit na branch: o squash junta os dois num só (o `git cherry` não reconhece mais commit a commit)
        g(&r, &["checkout", "-q", "design/LW-12-cupom"]);
        write(&r, "cupom.js", "export const cupom = 15;\n");
        g(&r, &["commit", "-qam", "cupom 15"]);
        g(&r, &["push", "-q", "origin", "design/LW-12-cupom"]);
        g(&r, &["checkout", "-q", "main"]);
        // squash no "GitHub": o conteúdo entra num commit só na main e a branch remota é apagada
        g(&r, &["merge", "-q", "--squash", "design/LW-12-cupom"]);
        g(&r, &["commit", "-qm", "Cupom (#12)"]);
        g(&r, &["push", "-q", "origin", "main"]);
        g(&r, &["push", "-q", "origin", "--delete", "design/LW-12-cupom"]);
        let (st, why) = git_verdict(&r, "design/LW-12-cupom", "main", 0, true);
        assert_eq!(st, "MERGED", "{why}");
        assert!(why.contains("squash"), "{why}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn git_branch_apagada_sem_conteudo_na_base_nao_afirma() {
        let (d, r) = loja("gone");
        g(&r, &["push", "-q", "origin", "--delete", "design/LW-12-cupom"]);
        let (st, why) = git_verdict(&r, "design/LW-12-cupom", "main", 0, true);
        assert_eq!(st, "UNKNOWN");
        assert!(why.contains("apagada"), "{why}");
        // branch sem commit da tarefa (criada depois do último commit) não "está integrada" à toa
        g(&r, &["branch", "design/LW-13-vazia", "main"]);
        let (st2, why2) = git_verdict(&r, "design/LW-13-vazia", "main", 4_102_444_800_000, false);
        assert_eq!(st2, "UNKNOWN", "{why2}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// gh falso: a conta ATIVA (bruno) não enxerga a org; a outra (carla) enxerga e tem o PR integrado.
    fn fake_gh(dir: &Path) -> String {
        let p = dir.join("gh");
        std::fs::write(&p, r#"#!/bin/sh
echo "$GH_TOKEN|$*" >> "$(dirname "$0")/gh.log"
case "$*" in
  "auth status") printf 'github.com\n  ✓ Logged in to github.com account bruno (keyring)\n  - Active account: true\n  ✓ Logged in to github.com account carla (keyring)\n  - Active account: false\n' >&2; exit 0;;
  "auth token -h github.com -u bruno") echo tok-bruno; exit 0;;
  "auth token -h github.com -u carla") echo tok-carla; exit 0;;
  "api repos/loja/web --jq .permissions.push") [ "$GH_TOKEN" = tok-carla ] && { echo true; exit 0; }; echo 'Not Found' >&2; exit 1;;
esac
case "$1 $2" in
  "pr list")
    [ "$GH_TOKEN" = tok-carla ] || { echo "GraphQL: Could not resolve to a Repository with the name 'loja/web'. (repository)" >&2; exit 1; }
    case "$*" in *"--head design/LW-12-cupom"*) echo '[{"number":12,"url":"https://github.com/loja/web/pull/12","state":"MERGED","headRefName":"design/LW-12-cupom","updatedAt":"2026-10-28T10:00:00Z"}]';; *) echo '[]';; esac
    exit 0;;
esac
exit 1
"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p.display().to_string()
    }

    #[test]
    fn acha_o_pr_pela_branch_com_a_conta_do_projeto() {
        let d = tmpdir("conta");
        let gh = fake_gh(&d);
        let r = d.join("loja-web");
        std::fs::create_dir_all(&r).unwrap();
        g(&r, &["init", "-q", "-b", "main"]);
        let heads = vec!["design/LW-12-cupom".to_string()];
        // com a conta ativa: sem acesso (o bug: era engolido e o PR "não existia")
        let e = gh_find(&gh, &r, "loja/web", "", &heads).unwrap_err();
        assert_eq!(err_kind(&e), "access");
        // com descoberta: acha a conta que enxerga, grava no repo e acha o PR integrado
        let p = gh_find_any_account(&gh, &r, "loja/web", "", &heads, true).unwrap().unwrap();
        assert_eq!((p.number, p.state.as_str()), (12, "MERGED"));
        assert_eq!(gh_contas::query_account(&r).as_deref(), Some("carla"));
        // dali em diante a conta do projeto vale direto (sem nova sondagem) e o token vai só no ambiente do filho
        let p2 = gh_find(&gh, &r, "loja/web", "", &heads).unwrap().unwrap();
        assert_eq!(p2.number, 12);
        let log = std::fs::read_to_string(d.join("gh.log")).unwrap();
        assert!(!log.contains("auth switch"), "nunca troca a conta ativa:\n{log}");
        assert!(log.lines().last().unwrap().starts_with("tok-carla|pr list --head design/LW-12-cupom"), "{log}");
        // branch sem PR: o GitHub respondeu "nada" (Ok(None)), não erro
        assert_eq!(gh_find(&gh, &r, "loja/web", "", &["outra".to_string()]).unwrap(), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
