// node --test src/guard.test.ts  (npm test)
// Frente 2 · guarda de segurança no diff (src/guard.ts): gitleaks e semgrep SIMULADOS (scripts que imprimem JSON fixo,
// via GITLEAKS_BIN/SEMGREP_BIN), mascaramento, fingerprint por conteúdo, dispensa só com assinatura do app (HMAC),
// linhas do diff × segredo antigo, cache da última varredura, guarda indisponível, download que nunca segura o portão
// (nada baixado da internet: servidor local / download injetado), árvore morta no timeout e o portão (verifyProofs).
// Com o gitleaks REAL em GUARD_REAL_GITLEAKS (ou no scratchpad da sessão), roda também a integração de verdade.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedLines, decide, fingerprintOf, gitleaksStatus, GITLEAKS_ASSETS, GITLEAKS_VERSION, GUARD_IGNORE_REL, guardKeyPath, guardSummary,
  inDiff, markOld, maskSecret, parseDiffLines, parseGitleaks, parseSemgrep, PREPARE_SCRIPT, readGuardKey, relToRoot, runGuard,
  semgrepRulesStatus, semgrepSeverity, signFingerprint, validIgnores, waitPrepared, type GuardDeps, type GuardFinding, type PrepareArgs,
} from "./guard.ts";
import { orgGuardPolicy } from "./org-policy.ts";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG, resolveWorkflow } from "./config.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-guarda-test-")));
// chave AWS FALSA montada em pedaços (o próprio repo não carrega um literal que pareça segredo)
const FAKE_KEY = "AKIA" + "IOSFODNN7EXAMPLA";
const NODE = process.execPath;
const ENV_KEYS = ["GITLEAKS_BIN", "SEMGREP_BIN", "FAKE_GL_LOG", "FAKE_SG_LOG", "FAKE_SG_OFFLINE", "FAKE_SG_HANG", "HOME", "USERPROFILE"];
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };

// gitleaks de mentira (comporta como o real 8.30.1): roda de dentro da cópia com --source ., caminhos relativos,
// respeita --gitleaks-ignore-path (file:regra:linha), sai 1 se achou; anexa cada chamada em FAKE_GL_LOG
const FAKE_GITLEAKS = `#!${NODE}
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2); const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : "");
const src = path.resolve(arg("--source")), report = arg("--report-path");
const ign = arg("--gitleaks-ignore-path") ? fs.readFileSync(arg("--gitleaks-ignore-path"), "utf8").split("\\n").map((x) => x.trim()).filter(Boolean) : [];
const out = [], seen = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const rel = path.relative(process.cwd(), p); seen.push(rel); fs.readFileSync(p, "utf8").split("\\n").forEach((l, i) => { const m = l.match(/AKIA[A-Z2-7]{16}/); const fp = rel + ":aws-access-token:" + (i + 1); if (m && !ign.includes(fp)) out.push({ Description: "AWS Access Key", StartLine: i + 1, EndLine: i + 1, File: rel, Secret: m[0], Match: l, RuleID: "aws-access-token", Fingerprint: fp }); }); } } };
walk(src);
if (process.env.FAKE_GL_LOG) fs.appendFileSync(process.env.FAKE_GL_LOG, JSON.stringify({ args: a, cwd: process.cwd(), seen: seen.sort() }) + "\\n");
fs.writeFileSync(report, JSON.stringify(out));
process.exit(out.length ? 1 : 0);
`;
// semgrep de mentira: SQL concatenado = WARNING; eval( = ERROR; FAKE_SG_OFFLINE = falha; FAKE_SG_HANG = trava com um
// neto (o "semgrep-core") que grava o pid
const FAKE_SEMGREP = `#!${NODE}
const fs = require("fs"), cp = require("child_process");
const a = process.argv.slice(2);
if (process.env.FAKE_SG_LOG) fs.appendFileSync(process.env.FAKE_SG_LOG, JSON.stringify(a) + "\\n");
if (process.env.FAKE_SG_HANG) { const k = cp.spawn("sleep", ["30"], { stdio: "ignore" }); fs.writeFileSync(process.env.FAKE_SG_HANG, String(k.pid)); setInterval(() => {}, 1000); return; }
if (process.env.FAKE_SG_OFFLINE) { process.stderr.write("Invalid rule file\\n"); process.exit(2); }
const files = a.slice(a.indexOf("--quiet") + 1);
const results = [];
for (const f of files) fs.readFileSync(f, "utf8").split("\\n").forEach((l, i) => {
  if (/SELECT .*["'\`]\\s*\\+/i.test(l)) results.push({ check_id: "javascript.lang.security.sql-concat", path: f, start: { line: i + 1, col: 1 }, end: { line: i + 1, col: 2 }, extra: { message: "SQL montado com concatenação — use parâmetros", severity: "WARNING", metadata: {} } });
  if (/\\beval\\(/.test(l)) results.push({ check_id: "javascript.lang.security.eval", path: f, start: { line: i + 1, col: 1 }, end: { line: i + 1, col: 2 }, extra: { message: "eval com dado externo", severity: "ERROR", metadata: {} } });
});
process.stdout.write(JSON.stringify({ results, errors: [] }));
`;
const bin = (name: string, body: string) => { const p = join(root, "bin", name); mkdirSync(join(root, "bin"), { recursive: true }); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
let GL = "", SG = "";
let n = 0;
/** home isolado por teste (cache, chave, regras e binários baixados não vazam entre testes) */
function iso(o: { gl?: boolean; sg?: boolean; rules?: boolean; env?: Record<string, string> } = {}): GuardDeps {
  const h = join(root, "home-" + ++n);
  mkdirSync(h, { recursive: true });
  if (o.rules) { mkdirSync(join(h, ".cardume", "semgrep-rules"), { recursive: true }); writeFileSync(join(h, ".cardume", "semgrep-rules", "owasp-top-ten.yml"), "rules: []\n"); }
  return { home: h, extraDirs: [], env: { PATH: "", HOME: h, STARFORK_GUARD_NO_DOWNLOAD: "1", ...(o.gl ? { GITLEAKS_BIN: GL } : {}), ...(o.sg ? { SEMGREP_BIN: SG } : {}), ...(o.env ?? {}) } };
}
const g = (repo: string, ...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
/** repo com `base` commitado na main e a tarefa numa branch com `files` (soltos, sem commit) */
function repoWith(name: string, files: Record<string, string>, base: Record<string, string> = {}): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "t@t"); g(repo, "config", "user.name", "t"); g(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  for (const [f, c] of Object.entries(base)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "base");
  g(repo, "checkout", "-q", "-b", "tarefa");
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
  return repo;
}
const logLines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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

test("fingerprint: arquivo:regra:hash da linha — sem número de linha, sem o segredo, espaço normalizado", () => {
  const a = fingerprintOf("src/s3.ts", "aws-access-token", `  key: "${FAKE_KEY}",`, FAKE_KEY);
  assert.match(a, /^src\/s3\.ts:aws-access-token:[0-9a-f]{16}$/);
  assert.ok(!a.includes(FAKE_KEY));
  assert.equal(fingerprintOf("src/s3.ts", "aws-access-token", `key:    "${FAKE_KEY}",`, FAKE_KEY), a, "indentação/espaço não muda");
  assert.notEqual(fingerprintOf("src/s3.ts", "aws-access-token", `key: "${FAKE_KEY}", // outro`, FAKE_KEY), a);
});

test("parseGitleaks: caminho ABSOLUTO do tmp (como o gitleaks real) vira relativo; motivo e fingerprint sem o tmp nem o valor", () => {
  const scan = "/private/tmp/starfork-guarda-abc/src";
  const json = JSON.stringify([{ Description: "AWS Access Key", StartLine: 3, File: "/private/tmp/starfork-guarda-abc/src/src/cfg.ts", Secret: FAKE_KEY, Match: "k=" + FAKE_KEY, RuleID: "aws-access-token", Fingerprint: "/private/tmp/starfork-guarda-abc/src/src/cfg.ts:aws-access-token:3" }]);
  const [f] = parseGitleaks(json, scan, true, () => `k="${FAKE_KEY}"`);
  assert.equal(f.file, "src/cfg.ts");
  assert.equal(f.masked, "AKIA••••");
  assert.ok(!JSON.stringify(f).includes(FAKE_KEY) && !JSON.stringify(f).includes("/private/tmp"));
  assert.equal(relToRoot("/tmp/starfork-guarda-abc/src/a/b.ts", scan), "a/b.ts", "/private/tmp ↔ /tmp do macOS");
  assert.equal(relToRoot("src/x.ts", scan), "src/x.ts");
  assert.match(f && (await_reason(f)), /^segredo no código em src\/cfg\.ts:3 \(AKIA••••, aws-access-token\) — troque por variável de ambiente; nunca escreva o valor no código$/);
  assert.deepEqual(parseGitleaks("lixo", "/x", true), []);
});
function await_reason(f: GuardFinding): string { return decide([f], [], []).reasons[0]; }

test("assinatura das dispensas: HMAC igual ao do Rust; sem hmac, hmac errado ou sem chave local = não vale", () => {
  assert.equal(signFingerprint("chave-de-teste", "src/s3.ts:aws-access-token:0123456789abcdef"), "e2aeb5bde8ba8a515f1f21ca7074caf51cbea414ab43098e2b55c5238fb4136f", "mesmo vetor de guard_sign.rs");
  const key = "a".repeat(64);
  const ok = { fingerprint: "a:r:1", motivo: "m", por: "p", em: "e", hmac: signFingerprint(key, "a:r:1") };
  const r = validIgnores([ok, { ...ok, fingerprint: "b:r:1" }, { fingerprint: "c:r:1", motivo: "m", por: "p", em: "e" }], key);
  assert.deepEqual([r.valid.map((x) => x.fingerprint), r.unsigned], [["a:r:1"], 2]);
  assert.deepEqual(validIgnores([ok], null).unsigned, 1, "sem chave local nada vale");
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
});

test("linhas do diff: parseDiffLines (-U0), inDiff e markOld (antigo não bloqueia)", () => {
  const m = parseDiffLines("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +2,2 @@\n+a\n+b\n@@ -9 +11 @@\n-c\n+d\n@@ -20,3 +22,0 @@\n-e\n");
  assert.deepEqual([...m.get("x.ts")!].sort((a, b) => a - b), [2, 3, 11]);
  const f: GuardFinding = { tool: "gitleaks", kind: "segredo", severity: "alta", file: "x.ts", line: 5, rule: "r", message: "m", fingerprint: "x", blocks: true };
  assert.equal(inDiff(new Map([["x.ts", m.get("x.ts")!]]), f), false);
  assert.equal(inDiff(new Map([["x.ts", "all"]]), f), true);
  assert.equal(inDiff(null, f), true, "sem diff: tudo conta");
  const o = markOld(f);
  assert.deepEqual([o.old, o.blocks, o.severity], [true, false, "baixa"]);
  assert.match(o.message, /^segredo antigo no arquivo/);
});

test("orgGuardPolicy: padrão bloqueia (null); só false explícito rebaixa", () => {
  assert.equal(orgGuardPolicy(null), null);
  assert.equal(orgGuardPolicy({ agentes: { guard: { secretsBlock: "nao" } } }), null, "lixo não desliga");
  assert.deepEqual(orgGuardPolicy({ agentes: { guard: { secretsBlock: false } } }), { secretsBlock: false, codeHighBlock: true });
});

// ---------------------------------------------------------------- com os binários simulados

test("runGuard: segredo no diff bloqueia; só os mudados vão (de dentro da cópia, --source ., --log-level error); semgrep com regras locais e --metrics=off", async () => {
  const repo = repoWith("loja", { "src/config.ts": `export const cfg = {\n  region: "sa-east-1",\n  key: "${FAKE_KEY}",\n};\n`, "src/db.ts": `export const q = (id) => "SELECT * FROM u WHERE id=" + id;\n`, "src/intocado.ts": `const x = "${FAKE_KEY}";\n` });
  const deps = iso({ gl: true, sg: true, rules: true });
  process.env.FAKE_GL_LOG = join(root, "gl-loja.log"); process.env.FAKE_SG_LOG = join(root, "sg-loja.log");
  try {
    const r = await runGuard({ worktree: repo, base: "main", files: ["src/config.ts", "src/db.ts", "src/apagado.ts", ".cardume/artifacts/x.md"], deps });
    const [gl] = logLines(process.env.FAKE_GL_LOG);
    assert.deepEqual(gl.seen, ["src/config.ts", "src/db.ts"], "src/intocado.ts (não mudou) não entra; caminhos relativos mantidos");
    assert.ok(gl.args.includes("--log-level") && gl.args[gl.args.indexOf("--source") + 1] === ".");
    const [sg] = logLines(process.env.FAKE_SG_LOG);
    assert.equal(sg[sg.indexOf("--config") + 1], join(deps.home!, ".cardume", "semgrep-rules", "owasp-top-ten.yml"));
    assert.ok(sg.includes("--metrics=off"));
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.reasons, ["segredo no código em src/config.ts:3 (AKIA••••, aws-access-token) — troque por variável de ambiente; nunca escreva o valor no código"]);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY) && !JSON.stringify(r).includes(tmpdir()), "o resultado nunca leva o valor nem o caminho do tmp");
    assert.deepEqual(r.findings.filter((f) => f.kind === "codigo").map((f) => [f.file, f.line, f.severity, f.blocks]), [["src/db.ts", 1, "media", false]]);
  } finally { delete process.env.FAKE_GL_LOG; delete process.env.FAKE_SG_LOG; }
});

test("segredo que JÁ estava na base não bloqueia quem só mexeu no arquivo: vira 'segredo antigo'", async () => {
  const repo = repoWith("legado", {}, { "src/cfg.ts": `// config\nconst k = "${FAKE_KEY}";\nexport default k;\n` });
  writeFileSync(join(repo, "src/cfg.ts"), `// config\nconst k = "${FAKE_KEY}";\nexport default k;\nexport const nome = "loja";\n`);
  const r = await runGuard({ worktree: repo, base: "main", files: ["src/cfg.ts"], deps: iso({ gl: true }) });
  assert.deepEqual(r.reasons, []);
  assert.equal(r.findings.length, 1);
  assert.deepEqual([r.findings[0].old, r.findings[0].blocks, r.findings[0].line], [true, false, 2]);
  assert.match(guardSummary(r), /1 aviso\(s\) antigo\(s\) fora do diff/);
  // agora a tarefa escreve um segredo NOVO no mesmo arquivo → esse bloqueia
  writeFileSync(join(repo, "src/cfg.ts"), `// config\nconst k = "${FAKE_KEY}";\nexport default k;\nexport const outra = "${FAKE_KEY}";\n`);
  const r2 = await runGuard({ worktree: repo, base: "main", files: ["src/cfg.ts"], deps: iso({ gl: true }) });
  assert.deepEqual(r2.reasons.map((x) => x.split(" (")[0]), ["segredo no código em src/cfg.ts:4"]);
});

test("respeita .gitleaks.toml e .gitleaksignore do projeto (passados ao gitleaks)", async () => {
  const repo = repoWith("cfg", { "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  writeFileSync(join(repo, ".gitleaks.toml"), "[extend]\nuseDefault = true\n");
  writeFileSync(join(repo, ".gitleaksignore"), "src/k.ts:aws-access-token:1\n");
  process.env.FAKE_GL_LOG = join(root, "gl-cfg.log");
  try {
    const r = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps: iso({ gl: true }) });
    const [gl] = logLines(process.env.FAKE_GL_LOG);
    assert.equal(gl.args[gl.args.indexOf("--config") + 1], join(repo, ".gitleaks.toml"));
    assert.equal(gl.args[gl.args.indexOf("--gitleaks-ignore-path") + 1], join(repo, ".gitleaksignore"));
    assert.deepEqual(r.reasons, [], "o .gitleaksignore do projeto vale");
  } finally { delete process.env.FAKE_GL_LOG; }
});

test("runGuard: eval (ERROR) bloqueia; política da org rebaixa segredo pra aviso", async () => {
  const repo = repoWith("api", { "src/run.ts": `export const go = (s) => eval(s);\n`, "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const r = await runGuard({ worktree: repo, base: "main", files: ["src/run.ts", "src/k.ts"], deps: iso({ gl: true, sg: true, rules: true }) });
  assert.equal(r.reasons.length, 2);
  const soft = await runGuard({ worktree: repo, base: "main", files: ["src/run.ts", "src/k.ts"], policy: { guard: { secretsBlock: false } }, deps: iso({ gl: true, sg: true, rules: true }) });
  assert.deepEqual(soft.reasons.map((x) => x.split(" ")[0]), ["falha"], "segredo vira só aviso; semgrep alto continua bloqueando");
  assert.match(guardSummary(soft), /só aviso pela política da organização/);
});

test("dispensa escrita pelo AGENTE (sem assinatura do app) não vale; a do app vale e sobrevive a linhas inseridas acima; o portão não rastreia nada", async () => {
  const repo = repoWith("doc", { "docs/exemplo.md": `use ${FAKE_KEY} como exemplo\n` });
  const deps = iso({ gl: true });
  const first = await runGuard({ worktree: repo, base: "main", files: ["docs/exemplo.md"], deps });
  const fp = first.findings[0].fingerprint;
  mkdirSync(join(repo, ".cardume"), { recursive: true });
  // o agente deduz a fingerprint e escreve a dispensa ele mesmo (até com um hmac inventado)
  writeFileSync(join(repo, GUARD_IGNORE_REL), JSON.stringify([{ fingerprint: fp, motivo: "é só exemplo", por: "Íris", em: "2026-10-19", hmac: "0".repeat(64) }]));
  const forged = await runGuard({ worktree: repo, base: "main", files: ["docs/exemplo.md"], deps });
  assert.equal(forged.reasons.length, 1, "continua bloqueando");
  assert.equal(forged.unsigned, 1);
  assert.match(guardSummary(forged), /1 dispensa\(s\) sem assinatura do app ignorada\(s\)/);
  // o app (Rust, guard_dismiss) assina com a chave local
  const key = "f".repeat(64);
  mkdirSync(join(deps.home!, ".cardume"), { recursive: true });
  writeFileSync(guardKeyPath(deps), key + "\n");
  assert.equal(readGuardKey(deps), key);
  writeFileSync(join(repo, GUARD_IGNORE_REL), JSON.stringify([{ fingerprint: fp, motivo: "chave de exemplo da AWS", por: "Ana", em: "2026-10-19", hmac: signFingerprint(key, fp) }]));
  const ok = await runGuard({ worktree: repo, base: "main", files: ["docs/exemplo.md"], deps });
  assert.deepEqual([ok.reasons.length, ok.findings.length, ok.ignored, ok.unsigned], [0, 0, 1, 0]);
  writeFileSync(join(repo, "docs/exemplo.md"), `# Exemplos\n\nveja abaixo:\nuse ${FAKE_KEY} como exemplo\n`);
  const moved = await runGuard({ worktree: repo, base: "main", files: ["docs/exemplo.md"], deps });
  assert.deepEqual([moved.reasons.length, moved.ignored], [0, 1], "a linha andou 3 pra baixo e a dispensa continua valendo");
  assert.equal(execFileSync("git", ["-C", repo, "ls-files", GUARD_IGNORE_REL], { encoding: "utf8" }).trim(), "", "o portão não faz git add (isso é do app, ao dispensar)");
});

test("mesmo SHA + mesmos arquivos e conteúdo: reaproveita a última varredura sem rodar as ferramentas", async () => {
  const repo = repoWith("cache", { "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const deps = iso({ gl: true });
  const log = join(root, "gl-cache.log");
  process.env.FAKE_GL_LOG = log;
  try {
    const a = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps });
    const b = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps });
    assert.equal(logLines(log).length, 1, "a 2ª não chamou o gitleaks");
    assert.deepEqual([b.cached, b.reasons], [true, a.reasons]);
    writeFileSync(join(repo, "src/k.ts"), `const k = process.env.K;\n`);
    const c = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps });
    assert.equal(logLines(log).length, 2, "conteúdo mudou → varre de novo");
    assert.deepEqual([c.cached, c.reasons], [undefined, []]);
    assert.ok(existsSync(join(deps.home!, ".cardume", "guard-cache")), "cache fora da worktree");
  } finally { delete process.env.FAKE_GL_LOG; }
});

test("guarda indisponível: sem gitleaks nem semgrep NÃO bloqueia mas diz 'desligada'; timeout, erro do semgrep e regras não baixadas também", async () => {
  const repo = repoWith("off", { "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const r = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps: iso() });
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.skipped, ["guarda de segredos desligada: gitleaks não instalado (download desligado neste ambiente)", "guarda de código desligada (semgrep não instalado)"]);
  const slow = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps: { ...iso({ gl: true, sg: true, rules: true }), exec: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }) } });
  assert.deepEqual(slow.skipped, ["guarda de segredos desligada: o gitleaks passou de 60s", "guarda de código desligada: o semgrep passou de 60s"]);
  process.env.FAKE_SG_OFFLINE = "1";
  try {
    const bad = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps: iso({ gl: true, sg: true, rules: true }) });
    assert.equal(bad.reasons.length, 1, "o gitleaks ainda roda e bloqueia");
    assert.match(bad.skipped[0], /^guarda de código indisponível: Invalid rule file/);
  } finally { delete process.env.FAKE_SG_OFFLINE; }
  const noRules = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps: iso({ gl: true, sg: true }) });
  assert.deepEqual(noRules.skipped, ["guarda de código desligada: regras do semgrep não baixadas (download desligado neste ambiente)"]);
  const broken = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps: iso({ env: { GITLEAKS_BIN: join(root, "nao-existe") } }) });
  assert.match(broken.skipped[0], /GITLEAKS_BIN aponta pra um arquivo que não existe/);
});

test("timeout mata a ÁRVORE: o 'semgrep-core' (neto) não fica órfão", async () => {
  const repo = repoWith("trava", { "src/a.ts": "export const a = 1;\n" });
  const pidFile = join(root, "neto.pid");
  process.env.FAKE_SG_HANG = pidFile;
  try {
    const r = await runGuard({ worktree: repo, base: "main", files: ["src/a.ts"], deps: { ...iso({ sg: true, rules: true }), timeoutMs: 800 } });
    assert.ok(r.skipped.some((s) => /o semgrep passou de 1s/.test(s)), r.skipped.join(" | "));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(alive(pid), false, "o neto morreu junto");
  } finally { delete process.env.FAKE_SG_HANG; }
});

// ---------------------------------------------------------------- download: nunca no caminho do portão

test("download NÃO segura o portão: sai na hora com 'preparando o gitleaks (1ª vez)', um download só, e depois usa o binário", async () => {
  const pkgDir = join(root, "pkg"); mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "gitleaks"), FAKE_GITLEAKS); chmodSync(join(pkgDir, "gitleaks"), 0o644);
  const tgz = join(root, "gl.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", pkgDir, "gitleaks"]);
  const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const urls: string[] = [];
  const deps: GuardDeps = { ...iso(), platform: "darwin", arch: "arm64", assets: { "darwin-arm64": { file: "gl.tar.gz", sha256: sha } },
    download: async (url, dest) => { urls.push(url); await gate; writeFileSync(dest, readFileSync(tgz)); } };
  const repo = repoWith("primeira", { "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const t0 = Date.now();
  const r = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps });
  assert.ok(Date.now() - t0 < 5000, "não esperou o download");
  assert.deepEqual(r.reasons, [], "sem gitleaks pronto: não bloqueia");
  assert.equal(r.skipped[0], "guarda de segredos desligada: preparando o gitleaks (1ª vez)");
  await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps }); // outra tarefa no mesmo motor
  assert.equal(urls.length, 1, "uma promessa por processo: um download só");
  release();
  await waitPrepared();
  const binDir = join(deps.home!, ".cardume", "bin");
  assert.deepEqual(readdirSync(binDir), ["gitleaks"], "sobra só o binário (pasta mkdtemp e trava apagadas)");
  const st = gitleaksStatus(deps);
  assert.ok("bin" in st && st.bin === join(binDir, "gitleaks"));
  const r2 = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps });
  assert.equal(r2.reasons.length, 1, "com o binário pronto a guarda roda e bloqueia");
});

test("download com hash errado: nada instalado, motivo no portão (que segue normal) e sem nova tentativa por 1 h", async () => {
  const deps: GuardDeps = { ...iso(), platform: "darwin", arch: "arm64", download: async (_url: string, dest: string) => { writeFileSync(dest, "isto não é o gitleaks"); } };
  assert.deepEqual(gitleaksStatus(deps), { off: "preparando o gitleaks (1ª vez)" });
  await waitPrepared();
  const binDir = join(deps.home!, ".cardume", "bin");
  assert.deepEqual(readdirSync(binDir), [".gitleaks-erro.json"], "o arquivo com hash ruim foi apagado");
  const st = gitleaksStatus(deps);
  assert.ok("off" in st && /não confere com o hash fixado/.test(st.off), JSON.stringify(st));
  const repo = repoWith("hashruim", { "src/k.ts": `const k = "${FAKE_KEY}";\n` });
  const r = await runGuard({ worktree: repo, base: "main", files: ["src/k.ts"], deps });
  assert.deepEqual(r.reasons, []);
  assert.match(r.skipped[0], /^guarda de segredos desligada: o gitleaks baixado não confere com o hash fixado/);
  const later = gitleaksStatus({ ...deps, now: () => Date.now() + 2 * 3600_000 });
  assert.deepEqual(later, { off: "preparando o gitleaks (1ª vez)" }, "depois de 1 h tenta de novo");
  await waitPrepared();
});

test("sem downloader injetado: dispara o preparador destacado (sem esperar); versão e hashes fixados pros 4 alvos", () => {
  assert.equal(GITLEAKS_VERSION, "8.30.1");
  for (const k of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) assert.match(GITLEAKS_ASSETS[k].sha256, /^[0-9a-f]{64}$/);
  const calls: PrepareArgs[] = [];
  const deps: GuardDeps = { ...iso(), platform: "darwin", arch: "arm64", spawnPrepare: (a) => calls.push(a) };
  assert.deepEqual(gitleaksStatus(deps), { off: "preparando o gitleaks (1ª vez)" });
  assert.deepEqual(gitleaksStatus(deps), { off: "preparando o gitleaks (1ª vez)" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz");
  assert.equal(calls[0].sha256, GITLEAKS_ASSETS["darwin-arm64"].sha256);
  // regras do semgrep: velhas (> 7 dias) são usadas e renovadas em segundo plano
  const d2: GuardDeps = { ...iso({ rules: true }), spawnPrepare: (a) => calls.push(a), now: () => Date.now() + 8 * 24 * 3600_000 };
  const rs = semgrepRulesStatus(d2);
  assert.ok("rules" in rs);
  assert.equal(calls[1].kind, "rules");
  assert.equal(calls[1].url, "https://semgrep.dev/c/p/owasp-top-ten");
});

test("PREPARE_SCRIPT (o preparador destacado de verdade) contra um servidor LOCAL: hash certo instala, hash errado não", async () => {
  const pkgDir = join(root, "pkg2"); mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "gitleaks"), "#!/bin/sh\necho ok\n");
  const tgz = join(root, "gl2.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", pkgDir, "gitleaks"]);
  const body = readFileSync(tgz);
  const sha = createHash("sha256").update(body).digest("hex");
  const srv = createServer((req, res) => { if (req.url === "/rules") { res.end("rules:\n  - id: x\n"); return; } res.end(body); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const runScript = (args: string[]) => new Promise<void>((res, rej) => execFile(NODE, ["-e", PREPARE_SCRIPT, ...args], (e) => (e ? rej(e) : res())));
  try {
    const good = join(root, "dl-good"), bad = join(root, "dl-bad"), rules = join(root, "dl-rules");
    await runScript(["gitleaks", `http://127.0.0.1:${port}/gl.tar.gz`, sha, "gl2.tar.gz", good, "gitleaks"]);
    assert.deepEqual(readdirSync(good), ["gitleaks"]);
    assert.equal(execFileSync(join(good, "gitleaks"), { encoding: "utf8" }).trim(), "ok", "executável");
    await runScript(["gitleaks", `http://127.0.0.1:${port}/gl.tar.gz`, "0".repeat(64), "gl2.tar.gz", bad, "gitleaks"]);
    assert.deepEqual(readdirSync(bad), [".gitleaks-erro.json"]);
    assert.match(readFileSync(join(bad, ".gitleaks-erro.json"), "utf8"), /não confere com o hash fixado/);
    await runScript(["rules", `http://127.0.0.1:${port}/rules`, "", "owasp-top-ten.yml", rules, ""]);
    assert.match(readFileSync(join(rules, "owasp-top-ten.yml"), "utf8"), /^rules:/);
  } finally { srv.close(); }
});

// ---------------------------------------------------------------- o portão

test("portão: verifyProofs reprova com segredo (motivo pro agente), grava evento `guarda` + spec; consulta sem efeito não roda", async () => {
  const repo = repoWith("portao", {});
  g(repo, "checkout", "-q", "main");
  const orch = new Orchestrator(repo);
  process.env.GITLEAKS_BIN = GL;
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
    assert.ok(!orch.store.getTask("chave")!.spec_json.includes(FAKE_KEY), "a spec nunca guarda o valor");
    writeFileSync(join(t.worktree, "src", "s3.ts"), `export const s3 = { accessKeyId: process.env.AWS_ACCESS_KEY_ID };\n`);
    const fixed = await orch.verifyProofs("chave", t, spec);
    assert.ok(fixed.ok, fixed.reasons.join(" · "));
    for (let i = 0; i < 20; i++) writeFileSync(join(t.worktree, "src", `m${i}.ts`), `export const v${i} = ${i};\n`);
    const t0 = Date.now();
    await orch.verifyProofs("chave", t, spec);
    assert.ok(Date.now() - t0 < 15_000, `portão com 20 arquivos levou ${Date.now() - t0}ms`);
  } finally {
    delete process.env.GITLEAKS_BIN;
    orch.close();
  }
});

// ---------------------------------------------------------------- gitleaks REAL (opcional)

const REAL_GL = process.env.GUARD_REAL_GITLEAKS || "/private/tmp/claude-501/-Users-douglassobreira-Documents-Git-branches-with-agents/e9deb87e-4b50-444a-b132-bc9a75c091fc/scratchpad/gl-bin/gitleaks";
test("gitleaks REAL 8.30.1: bloqueia AKIA no diff, caminho relativo, fingerprint estável, .gitleaksignore do projeto vale", { skip: !existsSync(REAL_GL) && "gitleaks real não disponível nesta máquina" }, async () => {
  const repo = repoWith("real", { "src/s3.ts": `export const s3 = { accessKeyId: "AKIAIOSFODNN7EXAMPLA" };\n` });
  const deps = iso({ env: { GITLEAKS_BIN: REAL_GL } });
  const r = await runGuard({ worktree: repo, base: "main", files: ["src/s3.ts"], deps });
  assert.deepEqual(r.skipped, ["guarda de código desligada (semgrep não instalado)"]);
  assert.equal(r.reasons.length, 1, JSON.stringify(r));
  assert.match(r.reasons[0], /^segredo no código em src\/s3\.ts:1 \(AKIA••••, aws-access-token\)/);
  assert.match(r.findings[0].fingerprint, /^src\/s3\.ts:aws-access-token:[0-9a-f]{16}$/);
  const again = await runGuard({ worktree: repo, base: "main", files: ["src/s3.ts"], deps: iso({ env: { GITLEAKS_BIN: REAL_GL } }) });
  assert.equal(again.findings[0].fingerprint, r.findings[0].fingerprint, "estável entre execuções (sem caminho do tmp)");
  writeFileSync(join(repo, ".gitleaksignore"), "src/s3.ts:aws-access-token:1\n");
  const ign = await runGuard({ worktree: repo, base: "main", files: ["src/s3.ts"], deps: iso({ env: { GITLEAKS_BIN: REAL_GL } }) });
  assert.deepEqual(ign.reasons, []);
});

test("changedLines: sem base conhecida devolve null (tudo conta)", async () => {
  const repo = repoWith("semBase", { "a.ts": "x\n" });
  assert.equal(await changedLines(repo, "nao-existe", ["a.ts"]), null);
  const m = await changedLines(repo, "main", ["a.ts"]);
  assert.equal(m!.get("a.ts"), "all", "arquivo novo, não rastreado = inteiro");
});
