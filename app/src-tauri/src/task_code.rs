//! Código de uma tarefa SEM a worktree (mergeada/limpa no merge): "ao voltar numa tarefa não vejo o código".
//! Cadeia de fontes, da mais barata/fiel pra mais cara:
//!  1. cache `<repo>/.cardume/diffs/<tarefa>.patch` — gravado ANTES de a worktree sair (merge pelo app, merge
//!     externo detectado, limpeza); offline e instantâneo;
//!  2. branch ainda no repo (`refs/heads/<b>` ou `refs/remotes/origin/<b>`): `fork..branch` no REPO — fork = merge-base
//!     com a base; se a branch já está DENTRO da base (merge commit), o fork sai do merge commit que a trouxe;
//!  3. merge commit na base (branch apagada): "Merge pull request #N", nome da branch na mensagem, ou squash "(#N)";
//!  4. `gh pr diff <prUrl>` (conta gh do repo) → vira o cache do passo 1.
//! O front não muda: `task_files`/`file_diff`/`read_file`/`ai_file_why` devolvem o mesmo formato (+ `source`).
use std::path::{Path, PathBuf};
use std::process::Command;

/// De onde veio o código mostrado (o front pode dizer "versão integrada").
pub(crate) enum Fonte {
    /// patch inteiro (cache em disco ou `gh pr diff`)
    Patch { texto: String, origem: &'static str },
    /// faixa de commits no repo: `git diff de ate`
    Faixa { de: String, ate: String, origem: &'static str },
}
impl Fonte {
    pub(crate) fn origem(&self) -> &'static str {
        match self { Fonte::Patch { origem, .. } | Fonte::Faixa { origem, .. } => origem }
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let o = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}
fn rev(dir: &Path, r: &str) -> Option<String> {
    git(dir, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
/// `git diff --quiet` sai 1 quando HÁ diferença
fn tem_diff(dir: &Path, de: &str, ate: &str) -> bool {
    Command::new("git").arg("-C").arg(dir).args(["diff", "--quiet", de, ate, "--", ".", ":(exclude).cardume"])
        .status().map(|s| s.code() == Some(1)).unwrap_or(false)
}
fn bases(dir: &Path, base: &str) -> Vec<String> {
    let clean = base.trim_start_matches("origin/");
    [format!("origin/{clean}"), clean.to_string()].into_iter().filter(|b| rev(dir, b).is_some()).collect()
}
/// first-parent da base: (sha, pais, assunto)
fn log_base(dir: &Path, base_ref: &str) -> Vec<(String, Vec<String>, String)> {
    git(dir, &["log", "--first-parent", "-n", "5000", "--format=%H%x09%P%x09%s", base_ref]).unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let h = it.next()?.to_string();
            let ps = it.next()?.split_whitespace().map(String::from).collect();
            Some((h, ps, it.next().unwrap_or("").to_string()))
        })
        .collect()
}

pub(crate) fn cache_path(repo: &Path, task_id: &str) -> PathBuf {
    repo.join(".cardume").join("diffs").join(format!("{task_id}.patch"))
}

/// Ponto de bifurcação REAL da tarefa. Igual ao `merge_base_ref`, exceto quando a ponta já está DENTRO da base
/// (tarefa mergeada por merge commit): aí o merge-base é a própria ponta (diff vazio) — o fork vem do merge commit
/// que trouxe a ponta: merge-base(M^1, ponta).
pub(crate) fn fork_point(dir: &Path, base: &str, tip: &str) -> String {
    let mb = super::merge_base_ref(&dir.to_path_buf(), base, tip);
    let Some(tip_sha) = rev(dir, tip) else { return mb };
    if mb != tip_sha { return mb; }
    for b in bases(dir, base) {
        if let Some((m, _, _)) = log_base(dir, &b).into_iter().find(|(_, ps, _)| ps.iter().skip(1).any(|p| *p == tip_sha)) {
            if let Some(fp) = git(dir, &["merge-base", &format!("{m}^1"), &tip_sha]) {
                let fp = fp.trim().to_string();
                if !fp.is_empty() && fp != tip_sha { return fp; }
            }
        }
    }
    mb
}

/// Nº do PR da spec: `prNumber` (número ou texto) ou o fim de `prUrl` (…/pull/N).
pub(crate) fn pr_number(spec: &serde_json::Value) -> Option<u64> {
    if let Some(n) = spec["prNumber"].as_u64() { return Some(n); }
    if let Some(n) = spec["prNumber"].as_str().and_then(|s| s.trim().trim_start_matches('#').parse().ok()) { return Some(n); }
    let url = spec["prUrl"].as_str()?;
    url.split("/pull/").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// Merge commit (ou squash) da tarefa na base → (de, até) já resolvidos em sha.
fn achar_merge(repo: &Path, base: &str, pr: Option<u64>, branch: &str) -> Option<(String, String)> {
    for b in bases(repo, base) {
        let log = log_base(repo, &b);
        let casa_pr = |s: &str| pr.map(|n| { let t = format!("#{n}"); s.contains(&format!("{t} ")) || s.trim_end().ends_with(&t) }).unwrap_or(false);
        let casa_branch = |s: &str| !branch.is_empty() && (s.trim_end().ends_with(&format!("/{branch}")) || s.contains(&format!("'{branch}'")) || s.trim_end().ends_with(&format!(" {branch}")));
        // merge commit: PR primeiro (mais confiável), depois o nome da branch
        let m = log.iter().find(|(_, ps, s)| ps.len() >= 2 && casa_pr(s))
            .or_else(|| log.iter().find(|(_, ps, s)| ps.len() >= 2 && casa_branch(s)));
        if let Some((h, ps, _)) = m { return Some((ps[0].clone(), h.clone())); }
        // squash: um commit só, assunto "… (#N)"
        if let Some(n) = pr {
            let suf = format!("(#{n})");
            if let Some((h, ps, _)) = log.iter().find(|(_, ps, s)| ps.len() == 1 && s.trim_end().ends_with(&suf)) {
                return Some((ps[0].clone(), h.clone()));
            }
        }
    }
    None
}

/// `gh pr diff` que falhou: não repete a cada abertura da aba (10 min de folga).
fn gh_falhou() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// Fonte do código de uma tarefa sem worktree (ver cadeia no topo). `usar_gh=false` nos testes / quando não vale a rede.
pub(crate) fn resolver(repo: &Path, task_id: &str, base: &str, branch: &str, spec: &serde_json::Value, usar_gh: bool) -> Option<Fonte> {
    // 1. cache gravado antes da worktree sair
    if let Ok(t) = std::fs::read_to_string(cache_path(repo, task_id)) {
        if !t.trim().is_empty() { return Some(Fonte::Patch { texto: t, origem: "cache" }); }
    }
    // 2. branch ainda no repo
    if !branch.is_empty() {
        for r in [format!("refs/heads/{branch}"), format!("refs/remotes/origin/{branch}")] {
            if rev(repo, &r).is_none() { continue; }
            let de = fork_point(repo, base, &r);
            if tem_diff(repo, &de, &r) { return Some(Fonte::Faixa { de, ate: r, origem: "branch" }); }
        }
    }
    // 3. merge/squash commit na base
    let pr = pr_number(spec);
    if let Some((de, ate)) = achar_merge(repo, base, pr, branch) {
        if tem_diff(repo, &de, &ate) { return Some(Fonte::Faixa { de, ate, origem: "merge" }); }
    }
    // 4. gh pr diff → cache
    let url = spec["prUrl"].as_str().unwrap_or("").trim().to_string();
    if usar_gh && url.starts_with("https://") {
        let k = format!("{}#{task_id}", repo.display());
        if gh_falhou().lock().unwrap_or_else(|e| e.into_inner()).get(&k).map(|t| t.elapsed().as_secs() < 600).unwrap_or(false) { return None; }
        let mut c = super::gh_contas::gh_in(repo);
        c.args(["pr", "diff", &url, "--color", "never"]).current_dir(repo);
        match super::output_timeout(c, 60) {
            Ok(o) if o.status.success() && !o.stdout.is_empty() => {
                let texto = String::from_utf8_lossy(&o.stdout).to_string();
                let p = cache_path(repo, task_id);
                if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
                let _ = std::fs::write(&p, &texto);
                return Some(Fonte::Patch { texto, origem: "gh" });
            }
            _ => { gh_falhou().lock().unwrap_or_else(|e| e.into_inner()).insert(k, std::time::Instant::now()); }
        }
    }
    None
}

/// Um bloco `diff --git` do patch: caminho final, +/−, texto do bloco.
pub(crate) struct Bloco<'a> { pub path: String, pub add: i64, pub del: i64, pub texto: &'a str }

fn tira_prefixo(p: &str) -> String {
    let p = p.trim_end_matches('\t').trim();
    let p = p.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(p);
    p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(p).to_string()
}
/// Patch → blocos por arquivo. Caminho: `+++ b/x` (apagado: `--- a/x`; renomeado sem hunk: `rename to`; binário:
/// fim do `diff --git … b/x`). Conta +/− só DEPOIS do primeiro `@@` (o cabeçalho `---`/`+++` não conta).
pub(crate) fn blocos(patch: &str) -> Vec<Bloco<'_>> {
    let mut starts: Vec<usize> = Vec::new();
    let mut off = 0usize;
    for l in patch.split_inclusive('\n') {
        if l.starts_with("diff --git ") { starts.push(off); }
        off += l.len();
    }
    let mut out = Vec::new();
    for (i, &s) in starts.iter().enumerate() {
        let e = starts.get(i + 1).copied().unwrap_or(patch.len());
        let texto = &patch[s..e];
        let (mut novo, mut velho, mut renom, mut add, mut del, mut em_hunk) = (None, None, None, 0i64, 0i64, false);
        let mut cab = String::new();
        for (j, l) in texto.lines().enumerate() {
            if j == 0 { cab = l.to_string(); continue; }
            if l.starts_with("@@") { em_hunk = true; continue; }
            if !em_hunk {
                if let Some(p) = l.strip_prefix("+++ ") { if p.trim() != "/dev/null" { novo = Some(tira_prefixo(p)); } }
                else if let Some(p) = l.strip_prefix("--- ") { if p.trim() != "/dev/null" { velho = Some(tira_prefixo(p)); } }
                else if let Some(p) = l.strip_prefix("rename to ") { renom = Some(p.trim().to_string()); }
                continue;
            }
            if l.starts_with('+') { add += 1 } else if l.starts_with('-') { del += 1 }
        }
        let path = novo.or(renom).or(velho).unwrap_or_else(|| {
            cab.rfind(" b/").map(|k| cab[k + 3..].trim().trim_matches('"').to_string()).unwrap_or_default()
        });
        if !path.is_empty() { out.push(Bloco { path, add, del, texto }); }
    }
    out
}

/// (caminho, +, −) — mesmo shape do `git diff --numstat`. `.cardume/` fica de fora (é git-excluded na worktree).
pub(crate) fn arquivos(repo: &Path, f: &Fonte) -> Vec<(String, i64, i64)> {
    match f {
        Fonte::Patch { texto, .. } => blocos(texto).into_iter().filter(|b| !b.path.starts_with(".cardume/")).map(|b| (b.path, b.add, b.del)).collect(),
        Fonte::Faixa { de, ate, .. } => git(repo, &["diff", "--no-color", "--no-ext-diff", "--numstat", de, ate, "--", ".", ":(exclude).cardume"]).unwrap_or_default()
            .lines()
            .filter_map(|l| { let p: Vec<&str> = l.split('\t').collect(); (p.len() >= 3).then(|| (p[2].to_string(), p[0].parse().unwrap_or(0), p[1].parse().unwrap_or(0))) })
            .collect(),
    }
}

/// Diff unificado de UM arquivo (contexto 3) — mesmo texto que o `git diff` da worktree daria.
pub(crate) fn diff_arquivo(repo: &Path, f: &Fonte, path: &str) -> String {
    match f {
        Fonte::Patch { texto, .. } => blocos(texto).into_iter().find(|b| b.path == path).map(|b| b.texto.to_string()).unwrap_or_default(),
        Fonte::Faixa { de, ate, .. } => git(repo, &["diff", "--no-color", "--no-ext-diff", "--unified=3", de, ate, "--", path]).unwrap_or_default(),
    }
}

/// Conteúdo do arquivo NA VERSÃO DA TAREFA: faixa → `ate:path`; patch → só arquivo novo (o patch é ele inteiro).
pub(crate) fn conteudo(repo: &Path, f: &Fonte, path: &str) -> Option<String> {
    match f {
        Fonte::Faixa { ate, .. } => git(repo, &["show", &format!("{ate}:{path}")]),
        Fonte::Patch { texto, .. } => {
            let b = blocos(texto).into_iter().find(|b| b.path == path)?;
            if !b.texto.lines().any(|l| l == "--- /dev/null") { return None; }
            let mut em = false;
            Some(b.texto.lines().filter_map(|l| { if l.starts_with("@@") { em = true; return None; } if em { l.strip_prefix('+').map(|x| format!("{x}\n")) } else { None } }).collect())
        }
    }
}

/// Linhas ADICIONADAS (numeração do arquivo novo) a partir dos hunks de um diff unificado.
pub(crate) fn linhas_adicionadas(diff: &str) -> Vec<i64> {
    let mut out = Vec::new();
    let mut n: i64 = 0;
    let mut em = false;
    for l in diff.lines() {
        if let Some(rest) = l.strip_prefix("@@") {
            // @@ -a,b +c,d @@
            n = rest.split('+').nth(1).and_then(|p| p.split([',', ' ']).next()).and_then(|s| s.trim().parse().ok()).unwrap_or(1);
            em = true;
            continue;
        }
        if !em || l.starts_with("diff --git ") { em = false; continue; }
        // '-' (removida) e '\\ No newline' não andam na numeração nova
        if l.starts_with('+') { out.push(n); n += 1; } else if l.starts_with(' ') { n += 1; }
    }
    out
}

/// Grava o cache ANTES de a worktree sair: `git diff <fork>` da árvore (inclui não commitado) + untracked como
/// arquivo novo. Diff vazio NÃO sobrescreve um cache existente. Devolve se gravou.
pub(crate) fn salvar_cache(repo: &Path, wt: &Path, base: &str, task_id: &str) -> bool {
    if task_id.is_empty() || !wt.join(".git").exists() { return false; }
    let de = fork_point(wt, base, "HEAD");
    let mut patch = git(wt, &["diff", "--no-color", "--no-ext-diff", "--unified=3", &de, "--", ".", ":(exclude).cardume"]).unwrap_or_default();
    for rel in git(wt, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default().lines() {
        let rel = rel.trim();
        if rel.is_empty() || rel.starts_with(".cardume/") { continue; }
        // --no-index sai 1 quando há diferença: lê o stdout de qualquer jeito
        if let Ok(o) = Command::new("git").arg("-C").arg(wt).args(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", rel]).output() {
            patch.push_str(&String::from_utf8_lossy(&o.stdout));
        }
    }
    if patch.trim().is_empty() { return false; }
    let p = cache_path(repo, task_id);
    if let Some(d) = p.parent() { if std::fs::create_dir_all(d).is_err() { return false; } }
    let tmp = p.with_extension("patch.tmp");
    std::fs::write(&tmp, &patch).is_ok() && std::fs::rename(&tmp, &p).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn g(d: &Path, a: &[&str]) {
        let o = Command::new("git").arg("-C").arg(d).args(["-c", "user.email=a@b", "-c", "user.name=a", "-c", "commit.gpgsign=false"]).args(a).output().unwrap();
        assert!(o.status.success(), "{a:?}: {}", String::from_utf8_lossy(&o.stderr));
    }
    /// repo com main (a.txt) + worktree de tarefa feat/t1 que muda a.txt e cria novo.txt (commitado)
    fn montar(nome: &str) -> (PathBuf, PathBuf, PathBuf) {
        let d = std::env::temp_dir().join(format!("sf-taskcode-{nome}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let repo = d.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        // como no app: .cardume/ fica fora do git (senão `add .` engole a worktree como gitlink)
        std::fs::write(repo.join(".git").join("info").join("exclude"), ".cardume/\n").unwrap();
        std::fs::write(repo.join("a.txt"), "um\ndois\n").unwrap();
        g(&repo, &["add", "."]);
        g(&repo, &["commit", "-q", "-m", "base"]);
        let wt = repo.join(".cardume").join("worktrees").join("t1");
        g(&repo, &["worktree", "add", "-q", "-b", "feat/t1", wt.to_str().unwrap()]);
        std::fs::write(wt.join("a.txt"), "um\ndois\ntres\n").unwrap();
        std::fs::write(wt.join("novo.txt"), "oi\n").unwrap();
        g(&wt, &["add", "."]);
        g(&wt, &["commit", "-q", "-m", "tarefa"]);
        (d, repo, wt)
    }
    fn tira_wt(repo: &Path, wt: &Path) { g(repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]); }
    fn nomes(v: &[(String, i64, i64)]) -> Vec<String> { let mut n: Vec<String> = v.iter().map(|x| x.0.clone()).collect(); n.sort(); n }

    #[test]
    fn worktree_removida_branch_existe() {
        let (d, repo, wt) = montar("branch");
        // main avança depois do fork: não pode entrar no código da tarefa
        std::fs::write(repo.join("outro.txt"), "x\n").unwrap();
        g(&repo, &["add", "."]); g(&repo, &["commit", "-q", "-m", "avanço"]);
        tira_wt(&repo, &wt);
        let f = resolver(&repo, "t1", "main", "feat/t1", &serde_json::json!({}), false).expect("fonte");
        assert_eq!(f.origem(), "branch");
        let fs = arquivos(&repo, &f);
        assert_eq!(nomes(&fs), vec!["a.txt", "novo.txt"]);
        assert!(fs.contains(&("a.txt".into(), 1, 0)));
        let df = diff_arquivo(&repo, &f, "a.txt");
        assert!(df.contains("+tres"), "{df}");
        assert_eq!(linhas_adicionadas(&df), vec![3]);
        assert_eq!(conteudo(&repo, &f, "novo.txt").as_deref(), Some("oi\n"));
        // já mergeada por merge commit (branch ainda existe): o fork sai do merge commit, não fica vazio
        g(&repo, &["merge", "-q", "--no-ff", "--no-edit", "feat/t1"]);
        let f = resolver(&repo, "t1", "main", "feat/t1", &serde_json::json!({}), false).expect("fonte pós-merge");
        assert_eq!(nomes(&arquivos(&repo, &f)), vec!["a.txt", "novo.txt"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn branch_apagada_acha_merge_pelo_numero_do_pr() {
        let (d, repo, wt) = montar("merge");
        tira_wt(&repo, &wt);
        g(&repo, &["merge", "-q", "--no-ff", "-m", "Merge pull request #42 from dono/feat/t1", "feat/t1"]);
        g(&repo, &["branch", "-D", "feat/t1"]);
        // ruído: outro merge com #4 (não pode casar com #42) depois
        g(&repo, &["checkout", "-q", "-b", "x"]); std::fs::write(repo.join("x.txt"), "x\n").unwrap();
        g(&repo, &["add", "."]); g(&repo, &["commit", "-q", "-m", "x"]);
        g(&repo, &["checkout", "-q", "main"]); g(&repo, &["merge", "-q", "--no-ff", "-m", "Merge pull request #4 from dono/x", "x"]);
        let spec = serde_json::json!({ "prUrl": "https://github.com/dono/r/pull/42" });
        let f = resolver(&repo, "t1", "main", "feat/t1-renomeada", &spec, false).expect("fonte");
        assert_eq!(f.origem(), "merge");
        assert_eq!(nomes(&arquivos(&repo, &f)), vec!["a.txt", "novo.txt"]);
        assert!(diff_arquivo(&repo, &f, "novo.txt").contains("+oi"));
        // squash "(#7)"
        g(&repo, &["checkout", "-q", "-b", "sq"]); std::fs::write(repo.join("s.txt"), "s\n").unwrap();
        g(&repo, &["add", "."]); g(&repo, &["commit", "-q", "-m", "s"]);
        g(&repo, &["checkout", "-q", "main"]); g(&repo, &["merge", "-q", "--squash", "sq"]); g(&repo, &["commit", "-q", "-m", "feat: s (#7)"]);
        g(&repo, &["branch", "-D", "sq"]);
        let f = resolver(&repo, "t2", "main", "sq", &serde_json::json!({ "prNumber": 7 }), false).expect("squash");
        assert_eq!(nomes(&arquivos(&repo, &f)), vec!["s.txt"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn cache_gravado_antes_de_limpar_e_preferido() {
        let (d, repo, wt) = montar("cache");
        // não commitado + untracked também entram no cache
        std::fs::write(wt.join("solto.txt"), "a\nb\n").unwrap();
        assert!(salvar_cache(&repo, &wt, "main", "t1"));
        tira_wt(&repo, &wt);
        let f = resolver(&repo, "t1", "main", "feat/t1", &serde_json::json!({}), false).expect("fonte");
        assert_eq!(f.origem(), "cache", "cache vence a branch");
        let fs = arquivos(&repo, &f);
        assert_eq!(nomes(&fs), vec!["a.txt", "novo.txt", "solto.txt"]);
        assert!(fs.contains(&("solto.txt".into(), 2, 0)));
        assert!(fs.contains(&("a.txt".into(), 1, 0)));
        let df = diff_arquivo(&repo, &f, "a.txt");
        assert!(df.starts_with("diff --git a/a.txt b/a.txt") && df.contains("+tres") && !df.contains("novo.txt"), "{df}");
        assert_eq!(conteudo(&repo, &f, "solto.txt").as_deref(), Some("a\nb\n"));
        assert_eq!(conteudo(&repo, &f, "a.txt"), None, "arquivo alterado: patch não tem ele inteiro");
        // offline de verdade: branch apagada, cache continua respondendo
        g(&repo, &["branch", "-D", "feat/t1"]);
        assert_eq!(resolver(&repo, "t1", "main", "feat/t1", &serde_json::json!({}), false).map(|f| f.origem()), Some("cache"));
        // diff vazio não apaga o cache existente
        assert!(!salvar_cache(&repo, &repo.join("nao-existe"), "main", "t1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pr_number_e_blocos() {
        assert_eq!(pr_number(&serde_json::json!({ "prNumber": "#12" })), Some(12));
        assert_eq!(pr_number(&serde_json::json!({ "prUrl": "https://github.com/a/b/pull/99/files" })), Some(99));
        assert_eq!(pr_number(&serde_json::json!({})), None);
        let p = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- linha que parece cabeçalho\n+++ outra\n ctx\ndiff --git a/y.png b/y.png\nBinary files a/y.png and b/y.png differ\ndiff --git a/z b/z\ndeleted file mode 100644\n--- a/z\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n";
        let b = blocos(p);
        assert_eq!(b.iter().map(|b| (b.path.as_str(), b.add, b.del)).collect::<Vec<_>>(), vec![("x", 1, 1), ("y.png", 0, 0), ("z", 0, 1)]);
    }
}
