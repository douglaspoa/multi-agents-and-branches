// node --test src/guard.test.ts  (npm test)
// Frente 2 · guarda de segurança no diff (src/guard.ts): gitleaks e semgrep SIMULADOS (scripts que imprimem JSON fixo,
// via GITLEAKS_BIN/SEMGREP_BIN), mascaramento, dispensa por fingerprint, guarda indisponível, política que rebaixa o
// bloqueio, hash do download (nada é baixado de verdade) e o portão (verifyProofs) reprovando com segredo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addIgnore, decide, ensureGitleaks, findingReason, GITLEAKS_ASSETS, GITLEAKS_VERSION, GUARD_IGNORE_REL, guardSummary, maskSecret,
  parseGitleaks, parseSemgrep, readIgnores, runGuard, semgrepSeverity, type GuardDeps, type GuardFinding,
} from "./guard.ts";
import { orgGuardPolicy } from "./org-policy.ts";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG, resolveWorkflow } from "./config.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-guarda-test-")));
// chave AWS FALSA montada em pedaços (o próprio repo não carrega um literal que pareça segredo)
const FAKE_KEY = "AKIA" + "Z7QX2LMN4PRT6VWY";
const NODE = process.execPath;
const ENV_KEYS = ["GITLEAKS_BIN", "SEMGREP_BIN", "FAKE_GL_LOG", "FAKE_SG_OFFLINE", "HOME", "USERPROFILE"];
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };

// gitleaks de mentira: varre a pasta --source atrás de AKIA…, escreve o relatório no formato do gitleaks e sai 1 se achou
const FAKE_GITLEAKS = `#!${NODE}
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2); const arg = (k) => a[a.indexOf(k) + 1];
const src = arg("--source"), report = arg("--report-path");
const out = [], seen = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { seen.push(path.relative(src, p)); fs.readFileSync(p, "utf8").split("\\n").forEach((l, i) => { const m = l.match(/AKIA[A-Z2-7]{16}/); if (m) out.push({ Description: "AWS Access Key", StartLine: i + 1, EndLine: i + 1, File: p, Secret: m[0], Match: l, RuleID: "aws-access-token", Fingerprint: p + ":aws-access-token:" + (i + 1) }); }); } } };
walk(src);
if (process.env.FAKE_GL_LOG) fs.writeFileSync(process.env.FAKE_GL_LOG, JSON.stringify({ args: a, seen: seen.sort() }));
fs.writeFileSync(report, JSON.stringify(out));
process.exit(out.length ? 1 : 0);
`;
// semgrep de mentira: SQL concatenado = WARNING; eval( = ERROR; FAKE_SG_OFFLINE = sem rede pras regras
const FAKE_SEMGREP = `#!${NODE}
const fs = require("fs");
if (process.env.FAKE_SG_OFFLINE) { process.stderr.write("Failed to download configuration from https://semgrep.dev/c/p/owasp-top-ten: network connection error\\n"); process.exit(2); }
const a = process.argv.slice(2); const files = a.slice(a.indexOf("--quiet") + 1);
const results = [];
for (const f of files) fs.readFileSync(f, "utf8").split("\\n").forEach((l, i) => {
  if (/SELECT .*["'\`]\\s*\\+/i.test(l)) results.push({ check_id: "javascript.lang.security.sql-concat", path: f, start: { line: i + 1, col: 1 }, end: { line: i + 1, col: 2 }, extra: { message: "SQL montado com concatenação — use parâmetros", severity: "WARNING", metadata: {} } });
  if (/\\beval\\(/.test(l)) results.push({ check_id: "javascript.lang.security.eval", path: f, start: { line: i + 1, col: 1 }, end: { line: i + 1, col: 2 }, extra: { message: "eval com dado externo", severity: "ERROR", metadata: {} } });
});
process.stdout.write(JSON.stringify({ results, errors: [] }));
`;
const bin = (name: string, body: string) => { const p = join(root, "bin", name); mkdirSync(join(root, "bin"), { recursive: true }); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
let GL = "", SG = "";
/** env isolado: só os binários falsos, nada do PATH da máquina */
const isoEnv = (o: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: "", HOME: home.home, STARFORK_GUARD_NO_DOWNLOAD: "1", ...o });
const noExtra: GuardDeps = { extraDirs: [] };

function repoWith(name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n"); g("add", "-A"); g("commit", "-q", "-m", "base");
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
  return repo;
}

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = tempHome({ learnMode: "desligado" });
  process.env.HOME = home.home; process.env.USERPROFILE = home.home;
  GL = bin("gitleaks", FAKE_GITLEAKS);
  SG = bin("semgrep", FAKE_SEMGREP);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- puras

test("maskSecret: só os 4 primeiros + ••••; valor curto não mostra nada", () => {
  assert.equal(maskSecret(FAKE_KEY), "AKIA••••");
  assert.equal(maskSecret("  ghp_abcdefghijklmnop  "), "ghp_••••");
  assert.equal(maskSecret("abc123"), "••••");
  assert.equal(maskSecret(""), "••••");
});

test("parseGitleaks: caminho relativo à worktree, valor mascarado, nunca o segredo nem o Match", () => {
  const json = JSON.stringify([{ Description: "AWS Access Key", StartLine: 3, File: "/tmp/x/src/src/cfg.ts", Secret: FAKE_KEY, Match: "k=" + FAKE_KEY, RuleID: "aws-access-token" }]);
  const [f] = parseGitleaks(json, "/tmp/x/src", true);
  assert.deepEqual({ file: f.file, line: f.line, masked: f.masked, fp: f.fingerprint, blocks: f.blocks }, { file: "src/cfg.ts", line: 3, masked: "AKIA••••", fp: "src/cfg.ts:aws-access-token:3", blocks: true });
  assert.ok(!JSON.stringify(f).includes(FAKE_KEY), "o achado guardado não leva o valor");
  assert.match(findingReason(f), /^segredo no código em src\/cfg\.ts:3 \(AKIA••••, aws-access-token\) — troque por variável de ambiente; nunca escreva o valor no código$/);
  assert.deepEqual(parseGitleaks("lixo", "/x", true), []);
});

test("semgrep: ERROR/HIGH = alta (bloqueia); WARNING = média; INFO = baixa (só achado)", () => {
  assert.equal(semgrepSeverity("ERROR"), "alta");
  assert.equal(semgrepSeverity("WARNING", { impact: "HIGH" }), "alta");
  assert.equal(semgrepSeverity("WARNING"), "media");
  assert.equal(semgrepSeverity("INFO"), "baixa");
  const fs = parseSemgrep(JSON.stringify({ results: [
    { check_id: "a", path: "src/a.ts", start: { line: 2 }, extra: { severity: "ERROR", message: "x" } },
    { check_id: "b", path: "src/b.ts", start: { line: 5 }, extra: { severity: "WARNING", message: "y" } },
  ] }), true);
  assert.deepEqual(fs.map((f) => [f.severity, f.blocks]), [["alta", true], ["media", false]]);
  assert.deepEqual(parseSemgrep(JSON.stringify({ results: [{ check_id: "a", path: "a", start: { line: 1 }, extra: { severity: "ERROR" } }] }), false).map((f) => f.blocks), [false]);
});

test("decide + addIgnore: achado com fingerprint dispensado não conta; dispensar de novo atualiza em vez de duplicar", () => {
  const f: GuardFinding = { tool: "gitleaks", kind: "segredo", severity: "alta", file: "a.ts", line: 1, rule: "r", message: "m", masked: "AKIA••••", fingerprint: "a.ts:r:1", blocks: true };
  assert.equal(decide([f], [], []).reasons.length, 1);
  let ig = addIgnore([], { fingerprint: "a.ts:r:1", motivo: "chave de exemplo da documentação", por: "Douglas", em: "2026-10-19T00:00:00.000Z" });
  ig = addIgnore(ig, { fingerprint: "a.ts:r:1", motivo: "exemplo do README", por: "Douglas", em: "2026-10-19T01:00:00.000Z" });
  assert.equal(ig.length, 1);
  assert.equal(ig[0].motivo, "exemplo do README");
  const d = decide([f], ig, []);
  assert.deepEqual([d.reasons.length, d.findings.length, d.ignored], [0, 0, 1]);
  assert.match(guardSummary(d), /1 dispensado/);
});

test("orgGuardPolicy: padrão bloqueia (null); só false explícito rebaixa", () => {
  assert.equal(orgGuardPolicy(null), null);
  assert.equal(orgGuardPolicy({ agentes: { portao: true } }), null);
  assert.equal(orgGuardPolicy({ agentes: { guard: { secretsBlock: "nao" } } }), null, "lixo não desliga");
  assert.deepEqual(orgGuardPolicy({ agentes: { guard: { secretsBlock: false } } }), { secretsBlock: false, codeHighBlock: true });
});

// ---------------------------------------------------------------- com os binários simulados

test("runGuard: segredo bloqueia com arquivo:linha mascarado; só os arquivos mudados vão pro gitleaks; SQL concatenado vira achado médio", async () => {
  const repo = repoWith("loja", { "src/config.ts": `export const cfg = {\n  region: "sa-east-1",\n  key: "${FAKE_KEY}",\n};\n`, "src/db.ts": `export const q = (id) => "SELECT * FROM u WHERE id=" + id;\n`, "src/intocado.ts": `const x = "${FAKE_KEY}";\n` });
  const log = join(root, "gl-log.json");
  const r = await runGuard({ worktree: repo, files: ["src/config.ts", "src/db.ts", "src/apagado.ts", ".cardume/artifacts/x.md"], deps: { ...noExtra, env: isoEnv({ GITLEAKS_BIN: GL, SEMGREP_BIN: SG }) } });
  process.env.FAKE_GL_LOG = log;
  const r2 = await runGuard({ worktree: repo, files: ["src/config.ts", "src/db.ts"], deps: { ...noExtra, env: isoEnv({ GITLEAKS_BIN: GL, SEMGREP_BIN: SG }) } });
  delete process.env.FAKE_GL_LOG;
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")).seen, ["src/config.ts", "src/db.ts"], "src/intocado.ts (não mudou) não entra; caminhos relativos mantidos");
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.reasons, ["segredo no código em src/config.ts:3 (AKIA••••, aws-access-token) — troque por variável de ambiente; nunca escreva o valor no código"]);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), "o resultado inteiro (que vai pra spec/evento) nunca leva o valor");
  const code = r.findings.filter((f) => f.kind === "codigo");
  assert.deepEqual(code.map((f) => [f.file, f.line, f.severity, f.blocks]), [["src/db.ts", 1, "media", false]]);
  assert.match(guardSummary(r), /^guarda: 1 segredo\(s\) bloqueiam a entrega — src\/config\.ts:3 · 1 achado\(s\) de código$/);
  assert.equal(r2.reasons.length, 1);
});

test("runGuard: eval (ERROR) bloqueia; política da org rebaixa segredo pra aviso", async () => {
  const repo = repoWith("api", { "src/run.ts": `export const go = (s) => eval(s);\n`, "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const env = isoEnv({ GITLEAKS_BIN: GL, SEMGREP_BIN: SG });
  const r = await runGuard({ worktree: repo, files: ["src/run.ts", "src/k.ts"], deps: { ...noExtra, env } });
  assert.equal(r.reasons.length, 2);
  assert.match(r.reasons.find((x) => x.startsWith("falha"))!, /^falha de segurança de severidade alta em src\/run\.ts:1 \(javascript\.lang\.security\.eval\)/);
  const soft = await runGuard({ worktree: repo, files: ["src/run.ts", "src/k.ts"], policy: { guard: { secretsBlock: false } }, deps: { ...noExtra, env } });
  assert.deepEqual(soft.reasons.map((x) => x.split(" ")[0]), ["falha"], "segredo vira só aviso; semgrep alto continua bloqueando");
  assert.equal(soft.findings.find((f) => f.kind === "segredo")!.blocks, false);
  assert.match(guardSummary(soft), /só aviso pela política da organização/);
});

test("runGuard: guard-ignore.json dispensa pelo fingerprint e vai pra branch mesmo com .cardume/ no exclude", async () => {
  const repo = repoWith("doc", { "docs/exemplo.md": `use ${FAKE_KEY} como exemplo\n` });
  writeFileSync(join(repo, ".git", "info", "exclude"), ".cardume/\n");
  mkdirSync(join(repo, ".cardume"), { recursive: true });
  writeFileSync(join(repo, GUARD_IGNORE_REL), JSON.stringify([{ fingerprint: "docs/exemplo.md:aws-access-token:1", motivo: "chave de exemplo da AWS", por: "Douglas", em: "2026-10-19T00:00:00.000Z" }]));
  const r = await runGuard({ worktree: repo, files: ["docs/exemplo.md"], deps: { ...noExtra, env: isoEnv({ GITLEAKS_BIN: GL }) } });
  assert.deepEqual([r.reasons.length, r.findings.length, r.ignored], [0, 0, 1]);
  assert.equal(readIgnores(repo)[0].motivo, "chave de exemplo da AWS");
  assert.match(execFileSync("git", ["-C", repo, "ls-files", GUARD_IGNORE_REL], { encoding: "utf8" }), /guard-ignore\.json/, "rastreado à força: o merge leva o dispensado junto");
});

test("guarda indisponível: sem gitleaks nem semgrep NÃO bloqueia mas diz 'desligada'; timeout e sem rede também", async () => {
  const repo = repoWith("off", { "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const r = await runGuard({ worktree: repo, files: ["src/k.ts"], deps: { ...noExtra, binDir: join(root, "vazio"), env: isoEnv() } });
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.skipped, ["guarda de segredos desligada: gitleaks não instalado (download desligado neste ambiente)", "guarda de código desligada (semgrep não instalado)"]);
  assert.match(guardSummary(r), /guarda de segredos desligada/);
  const slow = await runGuard({ worktree: repo, files: ["src/k.ts"], deps: { ...noExtra, env: isoEnv({ GITLEAKS_BIN: GL, SEMGREP_BIN: SG }), exec: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }) } });
  assert.deepEqual(slow.reasons, []);
  assert.deepEqual(slow.skipped, ["guarda de segredos desligada: o gitleaks passou de 60s", "guarda de código desligada: o semgrep passou de 60s"]);
  process.env.FAKE_SG_OFFLINE = "1";
  try {
    const net = await runGuard({ worktree: repo, files: ["src/k.ts"], deps: { ...noExtra, env: isoEnv({ GITLEAKS_BIN: GL, SEMGREP_BIN: SG }) } });
    assert.equal(net.reasons.length, 1, "o gitleaks ainda roda e bloqueia");
    assert.match(net.skipped[0], /^guarda de código indisponível \(sem rede pra baixar as regras\): Failed to download configuration/);
  } finally { delete process.env.FAKE_SG_OFFLINE; }
  const broken = await runGuard({ worktree: repo, files: ["src/k.ts"], deps: { ...noExtra, env: isoEnv({ GITLEAKS_BIN: join(root, "nao-existe") }) } });
  assert.match(broken.skipped[0], /GITLEAKS_BIN aponta pra um arquivo que não existe/);
});

test("download sob demanda: hash errado apaga o arquivo e desliga; hash certo instala em ~/.cardume/bin (nada baixado de verdade)", async () => {
  // a versão e os hashes fixados existem pros 4 alvos
  assert.equal(GITLEAKS_VERSION, "8.30.1");
  for (const k of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) assert.match(GITLEAKS_ASSETS[k].sha256, /^[0-9a-f]{64}$/);
  const binDir = join(root, "bin-dl");
  const urls: string[] = [];
  const bad = await ensureGitleaks({ binDir, env: isoEnv(), extraDirs: [], platform: "darwin", arch: "arm64", download: async (url, dest) => { urls.push(url); writeFileSync(dest, "isto não é o gitleaks"); } });
  assert.ok("off" in bad && /não confere com o hash fixado/.test(bad.off), JSON.stringify(bad));
  assert.deepEqual(urls, ["https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz"]);
  assert.deepEqual(readdirSync(binDir), [], "o arquivo com hash ruim foi apagado");
  // pacote de mentira com hash conhecido (troca só a tabela de hashes): extrai, marca executável e usa
  const pkgDir = join(root, "pkg"); mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "gitleaks"), FAKE_GITLEAKS); chmodSync(join(pkgDir, "gitleaks"), 0o644);
  const tgz = join(root, "gl.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", pkgDir, "gitleaks"]);
  const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  const ok = await ensureGitleaks({ binDir, env: isoEnv(), extraDirs: [], platform: "darwin", arch: "arm64", assets: { "darwin-arm64": { file: "gl.tar.gz", sha256: sha } }, download: async (_u, dest) => { writeFileSync(dest, readFileSync(tgz)); } });
  assert.ok("bin" in ok && ok.bin === join(binDir, "gitleaks"), JSON.stringify(ok));
  assert.deepEqual(readdirSync(binDir), ["gitleaks"], "sobra só o binário (pacote e pasta de extração apagados)");
  // da próxima vez acha em ~/.cardume/bin e nem chama o download
  const again = await ensureGitleaks({ binDir, env: isoEnv(), extraDirs: [], platform: "darwin", arch: "arm64", download: async () => { throw new Error("não devia baixar"); } });
  assert.ok("bin" in again);
  // sem downloader injetado e em modo de teste: nunca baixa
  const never = await ensureGitleaks({ binDir: join(root, "bin-nunca"), env: isoEnv(), extraDirs: [], platform: "darwin", arch: "arm64" });
  assert.ok("off" in never);
  assert.ok(!existsSync(join(root, "bin-nunca")), "nem a pasta foi criada");
});

// ---------------------------------------------------------------- o portão

test("portão: verifyProofs reprova com segredo (motivo pro agente), grava evento `guarda` + spec; consulta sem efeito não roda", async () => {
  const repo = repoWith("portao", {});
  const orch = new Orchestrator(repo);
  process.env.GITLEAKS_BIN = GL;
  process.env.SEMGREP_BIN = SG;
  try {
    await orch.createTask({ id: "chave", title: "Chave", objective: "integra S3", deliverables: [], requirements: [], scope: { owns: ["src"], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" }, engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no",
      roles: resolveWorkflow(DEFAULT_CONFIG, "feature", "mock") } as TaskSpec);
    const t = orch.store.getTask("chave")!;
    mkdirSync(join(t.worktree, "src"), { recursive: true });
    writeFileSync(join(t.worktree, "src", "s3.ts"), `export const s3 = { accessKeyId: "${FAKE_KEY}" };\n`);
    const spec = JSON.parse(t.spec_json) as TaskSpec;
    const quiet = await orch.verifyProofs("chave", t, spec, { runTests: false });
    assert.ok(quiet.ok, "runTests:false = consulta: a guarda não roda");
    assert.equal(orch.store.eventsForTask("chave").filter((e) => e.type === "guarda").length, 0);
    const gate = await orch.verifyProofs("chave", t, spec);
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.reasons, ["segredo no código em src/s3.ts:1 (AKIA••••, aws-access-token) — troque por variável de ambiente; nunca escreva o valor no código"]);
    const ev = orch.store.eventsForTask("chave").filter((e) => e.type === "guarda");
    assert.equal(ev.length, 1);
    assert.match(ev[0].text, /^guarda: 1 segredo\(s\) bloqueiam a entrega — src\/s3\.ts:1/);
    const g = (JSON.parse(orch.store.getTask("chave")!.spec_json) as TaskSpec).guard!;
    assert.equal(g.findings[0].fingerprint, "src/s3.ts:aws-access-token:1");
    assert.ok(!orch.store.getTask("chave")!.spec_json.includes(FAKE_KEY), "a spec nunca guarda o valor");
    // o agente troca por variável de ambiente → o portão passa
    writeFileSync(join(t.worktree, "src", "s3.ts"), `export const s3 = { accessKeyId: process.env.AWS_ACCESS_KEY_ID };\n`);
    const fixed = await orch.verifyProofs("chave", t, spec);
    assert.ok(fixed.ok, fixed.reasons.join(" · "));
    // diff de 20 arquivos com os binários simulados: a guarda não pesa no portão
    for (let i = 0; i < 20; i++) writeFileSync(join(t.worktree, "src", `m${i}.ts`), `export const v${i} = ${i};\n`);
    const t0 = Date.now();
    await orch.verifyProofs("chave", t, spec);
    assert.ok(Date.now() - t0 < 15_000, `portão com 20 arquivos levou ${Date.now() - t0}ms`);
  } finally {
    delete process.env.GITLEAKS_BIN; delete process.env.SEMGREP_BIN;
    orch.close();
  }
});
