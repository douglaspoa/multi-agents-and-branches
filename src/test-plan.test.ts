// node --test src/test-plan.test.ts  (npm test)
// Onda 1.1 · portão rápido: modo por projeto (checks.json) e da org, detecção de CI, só os testes AFETADOS
// (vitest/jest/go/cargo/pytest + gatilhos de suíte inteira), começar cedo (debounce, cancela a versão velha, a
// entrega só lê o resultado), sugestão automática pela duração — e a META: com CI e diff de 2 arquivos, o portão
// roda só os relacionados; sem CI, a entrega não espera se a verificação de segundo plano já terminou.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { affectedPlan, detectCi, effectiveTestMode, jsTestTool, parseTestCfg, pytestTargets, readDurations, recordDuration, suggestAffected, type DurationRec } from "./test-plan.ts";
import { orgTestMode } from "./org-policy.ts";
import { isGitCommitCmd, Orchestrator } from "./orchestrator.ts";
import type { Runner } from "./test-runner.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-plano-")));
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };
before(() => {
  for (const k of ["HOME", "USERPROFILE", "CARDUME_MOCK_SPEED", "CARDUME_AUTOSUMMARY", "CARDUME_NOTIFY", "STARFORK_TEST_TIMEOUT_S"]) saved[k] = process.env[k];
  home = tempHome({ learnMode: "desligado" });
  process.env.HOME = home.home; process.env.USERPROFILE = home.home;
  process.env.CARDUME_MOCK_SPEED = "50"; process.env.CARDUME_AUTOSUMMARY = "0"; process.env.CARDUME_NOTIFY = "0";
  delete process.env.STARFORK_TEST_TIMEOUT_S;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  home.cleanup();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const dirWith = (files: Record<string, string>) => {
  const d = join(root, `p${++n}`);
  mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
  return d;
};
const NPM: Runner = { kind: "npm", cmd: "npm", args: ["test", "--silent"], label: "npm test" };

// ---------------------------------------------------------------- configuração

test("checks.json: padrão auto/40; modos válidos; testFast; lixo vira padrão; a org fixa o modo e vence o projeto", () => {
  assert.deepEqual(parseTestCfg(null), { testMode: "auto", fullSuiteOver: 40 });
  assert.deepEqual(parseTestCfg({ testMode: "so-no-pr", testFast: " npm run test:unit ", testTimeoutSec: 90, fullSuiteOver: 25, testModeAsked: true }), { testMode: "so-no-pr", testFast: "npm run test:unit", testTimeoutSec: 90, fullSuiteOver: 25, testModeAsked: true });
  assert.equal(parseTestCfg({ testMode: "turbo", fullSuiteOver: -1 }).testMode, "auto");
  assert.equal(orgTestMode({ agentes: { testMode: "sempre" } }), "sempre");
  assert.equal(orgTestMode({ testMode: "nada" }), null);
  assert.deepEqual(effectiveTestMode(parseTestCfg({ testMode: "desligado" }), "sempre"), { mode: "sempre", byOrg: true });
  assert.deepEqual(effectiveTestMode(parseTestCfg({ testMode: "desligado" }), null), { mode: "desligado", byOrg: false });
});

test("detectCi: GitHub Actions com push/pull_request, GitLab, CircleCI; workflow só manual não conta", () => {
  assert.equal(detectCi(dirWith({ ".github/workflows/ci.yml": "name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\n" })), true);
  assert.equal(detectCi(dirWith({ ".github/workflows/ci.yaml": "on: [push]\n" })), true);
  assert.equal(detectCi(dirWith({ ".github/workflows/rel.yml": "on:\n  workflow_dispatch:\n" })), false);
  assert.equal(detectCi(dirWith({ ".gitlab-ci.yml": "test:\n  script: npm test\n" })), true);
  assert.equal(detectCi(dirWith({ ".circleci/config.yml": "version: 2.1\n" })), true);
  assert.equal(detectCi(dirWith({ "README.md": "x" })), false);
});

// ---------------------------------------------------------------- só os afetados

test("jsTestTool: vitest/jest pelo script ou pelas dependências; node --test e mocha não têm modo afetado", () => {
  assert.equal(jsTestTool({ scripts: { test: "vitest run" } }), "vitest");
  assert.equal(jsTestTool({ scripts: { test: "jest --coverage" } }), "jest");
  assert.equal(jsTestTool({ scripts: { test: "npm run unit" }, devDependencies: { vitest: "^2" } }), "vitest");
  assert.equal(jsTestTool({ devDependencies: { jest: "^29" } }), "jest");
  assert.equal(jsTestTool({ scripts: { test: "node --test" }, devDependencies: { vitest: "^2" } }), null);
  assert.equal(jsTestTool({ scripts: { test: "mocha" } }), null);
});

test("affectedPlan JS: vitest related / jest --findRelatedTests só com os arquivos que existem; script genérico cai pra inteira", () => {
  const v = dirWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "src/a.ts": "", "src/b.ts": "" });
  const p = affectedPlan(v, NPM, ["src/a.ts", "src/b.ts", "src/apagado.ts", "README.md"]);
  assert.equal(p.scope, "afetados");
  assert.deepEqual([p.runner?.cmd, ...p.runner!.args], ["npx", "--no-install", "vitest", "related", "src/a.ts", "src/b.ts", "--run"]);
  const j = dirWith({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "", "src/a.js": "" });
  const pj = affectedPlan(j, { ...NPM, kind: "yarn", cmd: "yarn", args: ["test"] }, ["src/a.js"]);
  assert.deepEqual([pj.runner?.cmd, ...pj.runner!.args], ["yarn", "jest", "--ci", "--findRelatedTests", "src/a.js"]);
  const g = dirWith({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "a.js": "" });
  assert.equal(affectedPlan(g, NPM, ["a.js"]).scope, "inteira");
  assert.match(affectedPlan(g, NPM, ["a.js"]).why ?? "", /não tem modo de testes afetados/);
  // testFast substitui o comando
  const f = affectedPlan(g, NPM, ["a.js"], { testFast: "npm run unit" });
  assert.equal(f.scope, "afetados");
  assert.deepEqual(f.runner?.args.slice(-1), ["npm run unit"]);
});

test("affectedPlan: gatilhos de suíte inteira (package.json, lockfile, configs) e diff grande; full forçado", () => {
  const v = dirWith({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "src/a.ts": "" });
  for (const f of ["package.json", "pnpm-lock.yaml", "vitest.config.ts", "jest.config.js", "tsconfig.build.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    const p = affectedPlan(v, NPM, ["src/a.ts", f]);
    assert.equal(p.scope, "inteira", f);
    assert.match(p.why ?? "", new RegExp(f.replace(/\./g, "\\.")));
  }
  const many = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
  assert.match(affectedPlan(v, NPM, many).why ?? "", /41 arquivos \(mais de 40\)/);
  assert.equal(affectedPlan(v, NPM, many.slice(0, 5), { fullSuiteOver: 3 }).scope, "inteira");
  assert.equal(affectedPlan(v, NPM, ["src/a.ts"], { full: true, fullWhy: "o projeto não tem CI" }).why, "o projeto não tem CI");
  assert.notEqual(affectedPlan(v, NPM, ["src/a.ts"]).sig, affectedPlan(v, NPM, ["src/a.ts"], { full: true }).sig, "planos diferentes: cache diferente");
});

test("affectedPlan go/cargo/pytest: pacotes das pastas mudadas, -p dos crates, testes dos módulos (+ --lf); sem correspondência roda tudo", () => {
  const go = dirWith({ "go.mod": "module x", "api/h.go": "", "db/q.go": "", "main.go": "" });
  const pg = affectedPlan(go, { kind: "go", cmd: "go", args: ["test", "-v", "./..."], label: "go test ./..." }, ["api/h.go", "db/q.go", "main.go"]);
  assert.deepEqual(pg.runner?.args, ["test", "-v", "./api/...", "./db/...", "."]);
  const rs = dirWith({ "Cargo.toml": "[workspace]\nmembers = [\"core\", \"cli\"]\n", "core/Cargo.toml": "[package]\nname = \"meu-core\"\n", "core/src/lib.rs": "", "cli/Cargo.toml": "[package]\nname = \"meu-cli\"\n", "cli/src/main.rs": "" });
  const pr = affectedPlan(rs, { kind: "cargo", cmd: "cargo", args: ["test"], label: "cargo test" }, ["core/src/lib.rs", "cli/src/main.rs"]);
  assert.deepEqual(pr.runner?.args, ["test", "-p", "meu-cli", "-p", "meu-core"]);
  const py = dirWith({ "pytest.ini": "", "app/precos.py": "", "app/outro.py": "", "tests/unit/test_precos.py": "", "tests/test_x.py": "" });
  const PY: Runner = { kind: "pytest", cmd: "python3", args: ["-m", "pytest", "-q"], label: "pytest" };
  const pp = affectedPlan(py, PY, ["app/precos.py", "tests/test_x.py"]);
  assert.deepEqual(pp.runner?.args, ["-m", "pytest", "-q", "--lf", "tests/test_x.py", "tests/unit/test_precos.py"]);
  assert.equal(affectedPlan(py, PY, ["app/outro.py"]).scope, "inteira", "módulo sem teste correspondente: roda tudo");
  assert.deepEqual(pytestTargets(py, ["app/__init__.py"]), []);
  assert.equal(affectedPlan(dirWith({ "Package.swift": "" }), { kind: "swift", cmd: "swift", args: ["test"], label: "swift test" }, ["Sources/a.swift"]).scope, "inteira");
});

// ---------------------------------------------------------------- duração e sugestão

test("duração por repo + sugestão: suíte INTEIRA > 2 min duas vezes, modo sempre/auto sem CI, ainda não respondida", () => {
  const repo = dirWith({ "x": "" });
  recordDuration(repo, { at: 1, ms: 200_000, scope: "inteira", ok: true });
  assert.equal(readDurations(repo).length, 1);
  const recs: DurationRec[] = [{ at: 1, ms: 250_000, scope: "inteira", ok: true }, { at: 2, ms: 230_000, scope: "inteira", ok: false }];
  assert.equal(suggestAffected(recs, parseTestCfg(null), "auto", false), 240);
  assert.equal(suggestAffected(recs.slice(0, 1), parseTestCfg(null), "auto", false), null, "uma vez só não basta");
  assert.equal(suggestAffected(recs, parseTestCfg(null), "auto", true), null, "com CI o auto já roda só os afetados");
  assert.equal(suggestAffected(recs, parseTestCfg({ testModeAsked: true }), "sempre", false), null, "já respondeu");
  assert.equal(suggestAffected(recs, parseTestCfg(null), "afetados", false), null);
  assert.equal(suggestAffected([{ at: 1, ms: 250_000, scope: "afetados", ok: true }, { at: 2, ms: 250_000, scope: "afetados", ok: true }], parseTestCfg(null), "auto", false), null, "só a suíte inteira conta");
  for (let i = 0; i < 25; i++) recordDuration(repo, { at: i, ms: 1, scope: "afetados", ok: true });
  assert.equal(readDurations(repo).length, 20, "guarda as últimas 20");
});

test("isGitCommitCmd: o commit do agente no Bash (também com -C e encadeado); outros git não", () => {
  assert.ok(isGitCommitCmd("git commit -m 'x'"));
  assert.ok(isGitCommitCmd("git add -A && git commit -am x"));
  assert.ok(isGitCommitCmd("git -C sub commit -m x"));
  assert.ok(isGitCommitCmd(["bash", "-lc", "git commit -m x"]));
  assert.ok(!isGitCommitCmd("git status"));
  assert.ok(!isGitCommitCmd("echo 'commit'"));
  // o hook PostToolUse (assíncrono: não segura o turno) dispara a verificação com o debounce
  const term = readFileSync(new URL("./terminal.ts", import.meta.url), "utf8");
  assert.match(term, /event === "PostToolUse" && isGitCommitCmd\(.*\)\) spawnVerifyCli\(taskId, repo, VERIFY_DEBOUNCE_MS\)/);
  assert.match(term, /ASYNC_HOOKS = new Set\(\["PreToolUse", "PostToolUse"/);
});

// ---------------------------------------------------------------- portão de ponta a ponta

function gitRepo(name: string, files: Record<string, string> = {}): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.cardume/\n");
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}
const spec = (id: string): TaskSpec => ({
  id, title: id, objective: "x", deliverables: ["x"], requirements: [],
  scope: { owns: ["src"], offLimits: [] },
  autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
  engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no",
  roles: [{ role: "builder", name: "Íris", engine: "mock" }],
}) as TaskSpec;
const sp = (orch: Orchestrator, id: string) => JSON.parse(orch.store.getTask(id)!.spec_json) as TaskSpec;
const commitIn = (wt: string, files: Record<string, string>, msg = "agente") => {
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(wt, f, ".."), { recursive: true }); writeFileSync(join(wt, f), c); }
  execFileSync("git", ["-C", wt, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", msg], { stdio: "ignore" });
};

test("META · projeto COM CI e diff de 2 arquivos: o portão roda só os testes relacionados (vitest related) e o selo diz 'suíte completa no CI'", async () => {
  const repo = gitRepo("com-ci", {
    ".github/workflows/ci.yml": "on:\n  pull_request:\n",
    "package.json": JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2" } }),
    "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "src/c.ts": "export const c = 1;\n",
  });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("ci1"));
    const wt = orch.store.getTask("ci1")!.worktree;
    // vitest falso (node_modules/.bin): grava os argumentos e responde em TAP
    const log = join(root, "vitest-args");
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(wt, "node_modules", ".bin", "vitest"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho "# pass 2"\necho "# fail 0"\n`);
    chmodSync(join(wt, "node_modules", ".bin", "vitest"), 0o755);
    commitIn(wt, { "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 2;\n" });
    const gate = await orch.verifyProofs("ci1", orch.store.getTask("ci1")!, sp(orch, "ci1"));
    assert.deepEqual(gate, { ok: true, reasons: [] });
    assert.equal(readFileSync(log, "utf8").trim(), "related src/a.ts src/b.ts --run", "só os 2 arquivos do diff");
    const t = sp(orch, "ci1").verification!.tests!;
    assert.equal(t.scope, "afetados");
    assert.equal(t.ci, true);
    assert.deepEqual([t.passed, t.failed, t.ok], [2, 0, true]);
    // o mesmo diff tocando o package.json → suíte inteira (npm test → vitest run)
    commitIn(wt, { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2" }, name: "x" }) });
    await orch.verifyProofs("ci1", orch.store.getTask("ci1")!, sp(orch, "ci1"));
    assert.match(readFileSync(log, "utf8").trim().split("\n").pop()!, /^run/);
    assert.equal(sp(orch, "ci1").verification!.tests!.scope, "inteira");
  } finally { orch.close(); }
});

const COUNT_SUITE = (file: string, ms = 0) => `import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\ntest("a", async () => { appendFileSync(${JSON.stringify(file)}, "x"); await new Promise((r) => setTimeout(r, ${ms})); });\n`;

test("META · projeto SEM CI: a entrega não espera nem roda de novo se a verificação de segundo plano já terminou; se ainda roda a mesma versão, espera ela", async () => {
  const runs = join(root, "semci-runs");
  const repo = gitRepo("sem-ci", { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }), "c.test.mjs": COUNT_SUITE(runs, 800) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("s1"));
    const wt = orch.store.getTask("s1")!.worktree;
    commitIn(wt, { "src/a.js": "export const a = 1;\n" });
    await orch.runTestsNow("s1"); // o segundo plano (commit do agente) terminou
    assert.equal(readFileSync(runs, "utf8"), "x");
    assert.equal(sp(orch, "s1").verification!.tests!.scope, "inteira", "sem CI: a suíte inteira");
    const t0 = Date.now();
    const g = await orch.verifyProofs("s1", orch.store.getTask("s1")!, sp(orch, "s1"), { forPr: true });
    assert.deepEqual(g, { ok: true, reasons: [] });
    assert.ok(Date.now() - t0 < 700, "a entrega só leu o resultado");
    assert.equal(readFileSync(runs, "utf8"), "x");
    // versão nova: o segundo plano começa; a entrega ESPERA ele (não começa outra)
    commitIn(wt, { "src/b.js": "export const b = 1;\n" });
    const bg = orch.runTestsNow("s1");
    await new Promise((r) => setTimeout(r, 300));
    const g2 = await orch.verifyProofs("s1", orch.store.getTask("s1")!, sp(orch, "s1"), { forPr: true });
    await bg;
    assert.deepEqual(g2, { ok: true, reasons: [] });
    assert.equal(readFileSync(runs, "utf8"), "xx", "rodou uma vez só pra versão nova");
  } finally { orch.close(); }
});

test("começar cedo: debounce — dois pedidos seguidos rodam a suíte UMA vez (o mais novo vence)", async () => {
  const runs = join(root, "deb-runs");
  const repo = gitRepo("debounce", { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }), "c.test.mjs": COUNT_SUITE(runs) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("d1"));
    commitIn(orch.store.getTask("d1")!.worktree, { "src/a.js": "1\n" });
    const a = orch.runTestsNow("d1", { debounceMs: 400 });
    await new Promise((r) => setTimeout(r, 100));
    const b = orch.runTestsNow("d1", { debounceMs: 400 });
    await Promise.all([a, b]);
    assert.equal(readFileSync(runs, "utf8"), "x");
  } finally { orch.close(); }
});

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (f: () => boolean, ms = 15_000) => { const until = Date.now() + ms; while (!f() && Date.now() < until) await new Promise((r) => setTimeout(r, 50)); return f(); };

test("começar cedo: commit novo CANCELA a verificação da versão velha (mata a árvore) e roda a nova", { skip: process.platform === "win32" }, async () => {
  const repo = gitRepo("cancela", { "package.json": JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('kid.pid', String(process.pid)); setTimeout(()=>{}, 60000)"` } }) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("k1"));
    const wt = orch.store.getTask("k1")!.worktree;
    commitIn(wt, { "src/a.js": "1\n" });
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "verify-tests", "k1", "--repo", repo], { stdio: "ignore", env });
    assert.ok(await waitFor(() => existsSync(join(wt, "kid.pid"))), "a verificação velha começou");
    const kid = Number(readFileSync(join(wt, "kid.pid"), "utf8"));
    // versão nova com uma suíte que passa
    commitIn(wt, { "package.json": JSON.stringify({ scripts: { test: "node -e \"console.log('# pass 1')\"" } }) });
    await orch.runTestsNow("k1");
    await new Promise((r) => p.exitCode !== null ? r(null) : p.on("exit", r));
    assert.ok(await waitFor(() => !alive(kid), 5000), "a suíte velha ficou órfã");
    assert.equal(sp(orch, "k1").verification!.tests!.ok, true, "o selo é da versão nova");
  } finally { orch.close(); }
});

test("modos: desligado (selo), so-no-pr (só no openPr), entregar sem esperar (motivo no selo, não roda)", async () => {
  const runs = join(root, "modo-runs");
  const repo = gitRepo("modos", { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }), "c.test.mjs": COUNT_SUITE(runs) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("m1"));
    const wt = orch.store.getTask("m1")!.worktree;
    commitIn(wt, { "src/a.js": "1\n" });
    mkdirSync(join(repo, ".cardume"), { recursive: true });
    writeFileSync(join(repo, ".cardume", "checks.json"), JSON.stringify({ testMode: "desligado" }));
    await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"), { forPr: true });
    assert.equal(sp(orch, "m1").verification!.tests!.off, "testes desligados neste projeto");
    assert.ok(!existsSync(runs));
    writeFileSync(join(repo, ".cardume", "checks.json"), JSON.stringify({ testMode: "so-no-pr" }));
    await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"));
    assert.equal(sp(orch, "m1").verification!.tests!.off, "os testes rodam ao abrir o PR");
    assert.ok(!existsSync(runs), "fora do PR não roda");
    await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"), { forPr: true });
    assert.equal(readFileSync(runs, "utf8"), "x", "no openPr roda");
    // "afetados" sem CI: no meio do caminho só os afetados (testFast); ao abrir o PR, a suíte completa
    writeFileSync(join(repo, ".cardume", "checks.json"), JSON.stringify({ testMode: "afetados", testFast: "echo '# pass 1'" }));
    commitIn(wt, { "src/a2.js": "1\n" });
    await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"));
    assert.equal(sp(orch, "m1").verification!.tests!.scope, "afetados");
    assert.equal(readFileSync(runs, "utf8"), "x", "o testFast rodou no lugar da suíte");
    await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"), { forPr: true });
    assert.equal(sp(orch, "m1").verification!.tests!.scope, "inteira");
    assert.equal(readFileSync(runs, "utf8"), "xx", "ao abrir o PR, a suíte completa");
    writeFileSync(runs, "x");
    // a org fixa "sempre" e vence o desligado do projeto
    writeFileSync(join(repo, ".cardume", "checks.json"), JSON.stringify({ testMode: "desligado" }));
    commitIn(wt, { "src/b.js": "1\n" });
    orch.store.patchSpec("m1", { orgPolicy: { rules: [], testMode: "sempre" } });
    await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"));
    assert.equal(readFileSync(runs, "utf8"), "xx", "a política da organização vence o projeto");
    // entregar sem esperar os testes: não roda, o motivo vai pro selo
    commitIn(wt, { "src/c.js": "1\n" });
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    orch.store.patchSpec("m1", { testsSkip: { reason: "hotfix do pagamento, o CI confere", at: 1, sha: head } });
    const g = await orch.verifyProofs("m1", orch.store.getTask("m1")!, sp(orch, "m1"), { forPr: true });
    assert.deepEqual(g, { ok: true, reasons: [] });
    assert.equal(sp(orch, "m1").verification!.tests!.skippedBy, "hotfix do pagamento, o CI confere");
    assert.equal(readFileSync(runs, "utf8"), "xx");
  } finally { orch.close(); }
});

test("sugestão: a suíte inteira passou de 2 min duas vezes → o selo leva a sugestão (média em segundos)", async () => {
  const repo = gitRepo("lento", { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }), "c.test.mjs": COUNT_SUITE(join(root, "lento-runs")) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("l1"));
    commitIn(orch.store.getTask("l1")!.worktree, { "src/a.js": "1\n" });
    // histórico de rodadas lentas (a suíte já roda: a duração é medida e guardada por repo)
    recordDuration(repo, { at: 1, ms: 250_000, scope: "inteira", ok: true });
    recordDuration(repo, { at: 2, ms: 230_000, scope: "inteira", ok: true });
    await orch.verifyProofs("l1", orch.store.getTask("l1")!, sp(orch, "l1"));
    assert.equal(sp(orch, "l1").verification!.suggest?.avgSec, 240);
    assert.ok((readDurations(repo).at(-1)?.ms ?? -1) >= 0, "esta rodada também foi medida");
  } finally { orch.close(); }
});
