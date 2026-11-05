//! Docker e memória (05/11, dono: "ao subir os ambientes o docker tem consumido muita memória"). Mede quanto cada
//! PROJETO ocupa no Docker (Supabase local, docker compose, container avulso) e para um projeto inteiro com um clique.
//! `docker stop` respeita o restart policy: parado à mão, o container NÃO religa quando o Docker abre de novo.
//! Só leitura de `docker ps`/`docker stats`/`docker info` — nada de mexer nas configurações do Docker Desktop.
use serde::Serialize;
use std::collections::BTreeMap;
use std::process::Command;

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerProject { pub name: String, pub kind: String, pub mb: f64, pub containers: usize, pub dir: String }
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerUsage { pub ok: bool, pub why: String, pub limit_mb: f64, pub total_mb: f64, pub projects: Vec<DockerProject> }

/// "245.4MiB / 7.75GiB" → 245.4 (MB, base 1024 como o Docker mostra)
pub(crate) fn mem_mb(s: &str) -> f64 {
    let used = s.split('/').next().unwrap_or("").trim();
    let num: String = used.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let n: f64 = num.parse().unwrap_or(0.0);
    let unit = used[num.len()..].trim().to_ascii_lowercase();
    match unit.as_str() { "b" => n / 1048576.0, "kib" | "kb" => n / 1024.0, "gib" | "gb" => n * 1024.0, "tib" | "tb" => n * 1048576.0, _ => n }
}
/// "a=1,com.docker.compose.project=x" → valor da chave (labels com vírgula no valor são raras; o 1º "k=" vence)
pub(crate) fn label(labels: &str, key: &str) -> String {
    labels.split(',').find_map(|kv| kv.split_once('=').filter(|(k, _)| k.trim() == key).map(|(_, v)| v.trim().to_string())).unwrap_or_default()
}
/// de que projeto é o container: Supabase local › docker compose › o próprio container
pub(crate) fn project_of(name: &str, labels: &str) -> (String, String, String) {
    let sb = label(labels, "com.supabase.cli.project");
    let cp = label(labels, "com.docker.compose.project");
    let dir = label(labels, "com.docker.compose.project.working_dir");
    if !sb.is_empty() { return (sb, "supabase".into(), dir); }
    if name.starts_with("supabase_") && !cp.is_empty() { return (cp, "supabase".into(), dir); }
    if !cp.is_empty() { return (cp, "compose".into(), dir); }
    (name.to_string(), "avulso".into(), String::new())
}
/// junta `docker ps` (nome → labels) com `docker stats` (nome → memória), um JSON por linha cada
pub(crate) fn group(ps_lines: &str, stats_lines: &str) -> Vec<DockerProject> {
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    for l in ps_lines.lines() { if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
        labels.insert(v["Names"].as_str().unwrap_or("").to_string(), v["Labels"].as_str().unwrap_or("").to_string()); } }
    let mut by: BTreeMap<String, DockerProject> = BTreeMap::new();
    for l in stats_lines.lines() { if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
        let name = v["Name"].as_str().unwrap_or("").to_string(); if name.is_empty() { continue; }
        let (p, kind, dir) = project_of(&name, labels.get(&name).map(|s| s.as_str()).unwrap_or(""));
        let e = by.entry(p.clone()).or_insert(DockerProject { name: p, kind, mb: 0.0, containers: 0, dir: String::new() });
        e.mb += mem_mb(v["MemUsage"].as_str().unwrap_or("")); e.containers += 1; if e.dir.is_empty() { e.dir = dir; } } }
    let mut out: Vec<DockerProject> = by.into_values().collect();
    out.sort_by(|a, b| b.mb.partial_cmp(&a.mb).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn docker_bin() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    for c in ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"].iter().map(|s| s.to_string()).chain([format!("{home}/.docker/bin/docker")]) {
        if std::path::Path::new(&c).is_file() { return c; }
    }
    "docker".into()
}
fn run(args: &[&str], secs: u64) -> Result<String, String> {
    let mut c = Command::new(docker_bin()); c.args(args);
    let o = crate::output_timeout(c, secs)?;
    if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect()); }
    Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

#[tauri::command(async)]
pub fn docker_usage() -> DockerUsage {
    let ps = match run(&["ps", "--format", "{{json .}}"], 8) {
        Ok(s) => s,
        Err(e) => return DockerUsage { ok: false, why: if e.contains("daemon") || e.contains("Cannot connect") { "O Docker não está ligado.".into() } else if e.contains("No such file") || e.contains("not found") { "O Docker não está instalado.".into() } else { e }, ..Default::default() },
    };
    let stats = run(&["stats", "--no-stream", "--format", "{{json .}}"], 20).unwrap_or_default();
    let limit = run(&["info", "--format", "{{.MemTotal}}"], 8).ok().and_then(|s| s.trim().parse::<f64>().ok()).map(|b| b / 1048576.0).unwrap_or(0.0);
    let projects = group(&ps, &stats);
    let total = projects.iter().map(|p| p.mb).sum();
    DockerUsage { ok: true, why: String::new(), limit_mb: limit, total_mb: total, projects }
}

/// para TODOS os containers do projeto (os dados ficam nos volumes; religar = `supabase start` / `docker compose up`)
#[tauri::command(async)]
pub fn docker_stop_project(name: String) -> Result<usize, String> {
    let ps = run(&["ps", "--format", "{{json .}}"], 8)?;
    let ids: Vec<String> = ps.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).filter(|v| {
        let n = v["Names"].as_str().unwrap_or(""); project_of(n, v["Labels"].as_str().unwrap_or("")).0 == name
    }).filter_map(|v| v["ID"].as_str().map(|s| s.to_string())).collect();
    if ids.is_empty() { return Ok(0); }
    let mut args = vec!["stop"]; args.extend(ids.iter().map(|s| s.as_str()));
    run(&args, 90)?;
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memoria_em_mb() {
        assert_eq!(mem_mb("245.4MiB / 7.75GiB"), 245.4);
        assert_eq!(mem_mb("1.5GiB / 7.75GiB"), 1536.0);
        assert_eq!(mem_mb("512KiB / 1GiB"), 0.5);
        assert_eq!(mem_mb("--"), 0.0);
    }
    #[test]
    fn agrupa_por_projeto_e_ordena_pelo_maior() {
        let ps = [
            r#"{"ID":"a1","Names":"supabase_db_loja","Labels":"com.supabase.cli.project=loja,com.docker.compose.project=loja"}"#,
            r#"{"ID":"a2","Names":"supabase_analytics_loja","Labels":"com.docker.compose.project=loja"}"#,
            r#"{"ID":"b1","Names":"api-redis","Labels":"com.docker.compose.project=api,com.docker.compose.project.working_dir=/srv/api"}"#,
            r#"{"ID":"c1","Names":"solto","Labels":""}"#,
        ].join("\n");
        let st = [
            r#"{"Name":"supabase_db_loja","MemUsage":"200MiB / 7.75GiB"}"#,
            r#"{"Name":"supabase_analytics_loja","MemUsage":"700MiB / 7.75GiB"}"#,
            r#"{"Name":"api-redis","MemUsage":"13MiB / 7.75GiB"}"#,
            r#"{"Name":"solto","MemUsage":"40MiB / 7.75GiB"}"#,
        ].join("\n");
        let g = group(&ps, &st);
        assert_eq!(g.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["loja", "solto", "api"]);
        assert_eq!(g[0].kind, "supabase"); assert_eq!(g[0].containers, 2); assert_eq!(g[0].mb, 900.0);
        assert_eq!(g[2].kind, "compose"); assert_eq!(g[2].dir, "/srv/api");
        assert_eq!(g[1].kind, "avulso");
    }
}
