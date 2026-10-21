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
import { affectedPlan, detectCi, effectiveTestMode, jsTestTool, parseTestCfg, pytestTargets, readDurations, recordDuration, suggestAffected, testModeNote, type DurationRec } from "./test-plan.ts";
import { orgTestMode } from "./org-policy.ts";
import { isGitCommitCmd, Orchestrator, parsePorcelainZ } from "./orchestrator.ts";
import { parseEtime, procStartMs, sameProcess, winArg } from "./test-runner.ts";
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

test("detectCi: só CI que RODA A SUÍTE (passo de teste) — workflow de deploy/lint não conta; GitLab e CircleCI pela mesma regra", () => {
  const step = "jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  assert.equal(detectCi(dirWith({ ".github/workflows/ci.yml": "name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\n" + step })), true);
  assert.equal(detectCi(dirWith({ ".github/workflows/ci.yaml": "on: [push]\n" + step.replace("npm test", "cargo test --all") })), true);
  assert.equal(detectCi(dirWith({ ".github/workflows/rel.yml": "on:\n  workflow_dispatch:\n" + step })), false, "sem gatilho de push/PR");
  assert.equal(detectCi(dirWith({ ".github/workflows/deploy.yml": "on:\n  push:\njobs:\n  d:\n    steps:\n      - run: npm run deploy\n" })), false, "deploy não é teste");
  assert.equal(detectCi(dirWith({ ".github/workflows/lint.yml": "on: [pull_request]\njobs:\n  l:\n    steps:\n      - run: npm run lint\n" })), false, "lint não é teste");
  assert.equal(detectCi(dirWith({ ".gitlab-ci.yml": "test:\n  script: pytest -q\n" })), true);
  assert.equal(detectCi(dirWith({ ".gitlab-ci.yml": "deploy:\n  script: ./deploy.sh\n" })), false);
  assert.equal(detectCi(dirWith({ ".circleci/config.yml": "version: 2.1\njobs:\n  t:\n    steps:\n      - run: go test ./...\n" })), true);
  assert.equal(detectCi(dirWith({ ".circleci/config.yml": "version: 2.1\n" })), false);
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
  const v = dirWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "src/a.ts": "", "src/b.ts": "", "README.md": "" });
  const p = affectedPlan(v, NPM, ["src/a.ts", "src/b.ts", "README.md"]);
  assert.equal(p.scope, "afetados");
  assert.deepEqual([p.runner?.cmd, ...p.runner!.args], ["npx", "--no-install", "vitest", "related", "src/a.ts", "src/b.ts", "--run", "--passWithNoTests"], "sem teste relacionado = 0 afetados, não vermelho");
  const j = dirWith({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "", "src/a.js": "" });
  const pj = affectedPlan(j, { ...NPM, kind: "yarn", cmd: "yarn", args: ["test"] }, ["src/a.js"]);
  assert.deepEqual([pj.runner?.cmd, ...pj.runner!.args], ["yarn", "jest", "--ci", "--passWithNoTests", "--findRelatedTests", "src/a.js"]);
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
  for (const f of ["package.json", "pnpm-lock.yaml", "vitest.config.ts", "vitest.workspace.ts", "vitest.setup.ts", "src/setupTests.ts", ".babelrc", ".env.test", "jest.config.js", "jest.setup.js", "tsconfig.build.json", "pyproject.toml", "conftest.py", "pytest.ini", "Cargo.toml", "go.mod"]) {
    mkdirSync(join(v, f, ".."), { recursive: true }); if (!existsSync(join(v, f))) writeFileSync(join(v, f), "");
    const p = affectedPlan(v, NPM, ["src/a.ts", f]);
    assert.equal(p.scope, "inteira", f);
    assert.match(p.why ?? "", new RegExp(f.replace(/\./g, "\\.")));
  }
  const many = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
  for (const f of many) writeFileSync(join(v, f), "");
  assert.match(affectedPlan(v, NPM, many).why ?? "", /41 arquivos \(mais de 40\)/);
  assert.equal(affectedPlan(v, NPM, many.slice(0, 5), { fullSuiteOver: 3 }).scope, "inteira");
  assert.equal(affectedPlan(v, NPM, ["src/a.ts"], { full: true, fullWhy: "o projeto não tem CI" }).why, "o projeto não tem CI");
  assert.notEqual(affectedPlan(v, NPM, ["src/a.ts"]).sig, affectedPlan(v, NPM, ["src/a.ts"], { full: true }).sig, "planos diferentes: cache diferente");
});

test("affectedPlan go/cargo/pytest: go roda ./... inteiro (dependentes não mapeados); -p dos crates (nome validado); pytest só com correspondência de TODO módulo, sem --lf", () => {
  const go = dirWith({ "go.mod": "module x", "api/h.go": "", "db/q.go": "", "main.go": "" });
  const pg = affectedPlan(go, { kind: "go", cmd: "go", args: ["test", "-v", "./..."], label: "go test ./..." }, ["api/h.go", "db/q.go"]);
  assert.equal(pg.scope, "inteira");
  assert.deepEqual(pg.runner?.args, ["test", "-v", "./..."]);
  assert.match(pg.why ?? "", /dependem do mudado/);
  const rs = dirWith({ "Cargo.toml": "[workspace]\nmembers = [\"core\", \"cli\"]\n", "core/Cargo.toml": "[package]\nname = \"meu-core\"\n", "core/src/lib.rs": "", "cli/Cargo.toml": "[package]\nname = \"meu-cli\"\n", "cli/src/main.rs": "", "x/Cargo.toml": "[package]\nname = \"x;rm -rf\"\n", "x/src/lib.rs": "" });
  const CARGO: Runner = { kind: "cargo", cmd: "cargo", args: ["test"], label: "cargo test" };
  assert.deepEqual(affectedPlan(rs, CARGO, ["core/src/lib.rs", "cli/src/main.rs"]).runner?.args, ["test", "-p", "meu-cli", "-p", "meu-core"]);
  assert.match(affectedPlan(rs, CARGO, ["x/src/lib.rs"]).why ?? "", /nome de crate inesperado/);
  const py = dirWith({ "pytest.ini": "", "app/precos.py": "", "app/outro.py": "", "tests/unit/test_precos.py": "", "tests/test_x.py": "" });
  const PY: Runner = { kind: "pytest", cmd: "python3", args: ["-m", "pytest", "-q"], label: "pytest" };
  const pp = affectedPlan(py, PY, ["app/precos.py", "tests/test_x.py"]);
  assert.deepEqual(pp.runner?.args, ["-m", "pytest", "-q", "tests/test_x.py", "tests/unit/test_precos.py"], "sem --lf");
  assert.equal(affectedPlan(py, PY, ["app/outro.py"]).scope, "inteira", "módulo sem teste correspondente: roda tudo");
  assert.equal(affectedPlan(py, PY, ["app/precos.py", "app/outro.py"]).scope, "inteira", "UM módulo sem correspondência já roda tudo");
  assert.deepEqual(pytestTargets(py, ["app/__init__.py"]), []);
  assert.equal(affectedPlan(dirWith({ "Package.swift": "", "Sources/a.swift": "" }), { kind: "swift", cmd: "swift", args: ["test"], label: "swift test" }, ["Sources/a.swift"]).scope, "inteira");
});

test("affectedPlan: arquivo apagado/renomeado, dado de teste (.json/.snap/.env/fixtures) e nome com caractere especial → suíte inteira", () => {
  const v = dirWith({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "src/a.ts": "", "src/dados.json": "", "src/__snapshots__/a.test.ts.snap": "", "test/fixtures/x.ts": "", "src/b&c.ts": "", "docs/x.md": "" });
  assert.match(affectedPlan(v, NPM, ["src/a.ts", "src/velho.ts"]).why ?? "", /apaga ou renomeia src\/velho\.ts/);
  assert.match(affectedPlan(v, NPM, ["src/a.ts", "src/dados.json"]).why ?? "", /dado\/configuração/);
  assert.equal(affectedPlan(v, NPM, ["src/a.ts", "src/__snapshots__/a.test.ts.snap"]).scope, "inteira");
  assert.equal(affectedPlan(v, NPM, ["src/a.ts", "test/fixtures/x.ts"]).scope, "inteira", "código dentro de fixtures é dado");
  assert.match(affectedPlan(v, NPM, ["src/b&c.ts"]).why ?? "", /caractere especial/);
  assert.equal(affectedPlan(v, NPM, ["src/a.ts", "docs/x.md"]).scope, "afetados", "doc junto não força a inteira");
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
  assert.ok(isGitCommitCmd("git -c user.name=x commit -m y"));
  assert.ok(isGitCommitCmd("git -c a=b -C dir commit --amend"));
  assert.ok(isGitCommitCmd("git --no-pager commit -m x"));
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
    ".github/workflows/ci.yml": "on:\n  pull_request:\njobs:\n  t:\n    steps:\n      - run: npm test\n",
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
    assert.equal(readFileSync(log, "utf8").trim(), "related src/a.ts src/b.ts --run --passWithNoTests", "só os 2 arquivos do diff");
    const t = sp(orch, "ci1").verification!.tests!;
    assert.equal(t.scope, "afetados");
    assert.equal(t.ci, true);
    assert.deepEqual([t.passed, t.failed, t.ok], [2, 0, true]);
    assert.equal(t.kind, "npm", "o selo diz de qual runner é (o FT-5 só usa na checagem dele)");
    assert.equal(t.cmdLine, "npx --no-install vitest related src/a.ts src/b.ts --run --passWithNoTests");
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

test("changedFiles: -z sem aspas (acento/espaço), arquivo novo em pasta nova vem como ARQUIVO, renome conta os dois lados", async () => {
  assert.deepEqual(parsePorcelainZ("?? src/novo/a.ts\0 M ação.ts\0R  novo.ts\0velho.ts\0"), ["src/novo/a.ts", "ação.ts", "novo.ts", "velho.ts"]);
  const repo = gitRepo("mudados", { "src/velho.ts": "1\n", "src/ação x.ts": "1\n" });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("cf1"));
    const wt = orch.store.getTask("cf1")!.worktree;
    execFileSync("git", ["-C", wt, "mv", "src/velho.ts", "src/novo.ts"]);
    commitIn(wt, { "src/ação x.ts": "2\n" });
    mkdirSync(join(wt, "lib", "sub"), { recursive: true });
    writeFileSync(join(wt, "lib", "sub", "u.ts"), "x");
    const files = (await (orch as unknown as { changedFiles: (w: string, b: string) => Promise<string[]> }).changedFiles(wt, "main")).sort();
    assert.deepEqual(files, ["lib/sub/u.ts", "src/ação x.ts", "src/novo.ts", "src/velho.ts"]);
  } finally { orch.close(); }
});

test("Windows: argumento pro cmd vai entre aspas (aspas internas dobradas)", () => {
  assert.equal(winArg("src/a b.ts"), '"src/a b.ts"');
  assert.equal(winArg('x"y'), '"x""y"');
  const src = readFileSync(new URL("./test-runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /shell: win/, "nada de shell:true com nome vindo do diff");
});

// ---------------------------------------------------------------- revisão adversarial 2: travas, sinais, "sem esperar"

test("dono da trava confere pid + horário de início: pid reaproveitado não é o mesmo processo", () => {
  assert.equal(parseEtime("05:07"), 307);
  assert.equal(parseEtime("2-01:00:00"), 2 * 86400 + 3600);
  assert.equal(parseEtime("x"), null);
  const me = procStartMs(process.pid)!;
  assert.ok(sameProcess(process.pid, me));
  assert.ok(!sameProcess(process.pid, me - 3_600_000), "início diferente: outro processo com o mesmo pid");
  assert.ok(!sameProcess(process.pid, undefined), "trava sem horário: morta");
});

test("trava atômica: duas entregas ao mesmo tempo no MESMO processo rodam a suíte uma vez; trava de pid reaproveitado é ignorada (sem sinal)", async () => {
  const runs = join(root, "atom-runs");
  const repo = gitRepo("atomica", { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }), "c.test.mjs": COUNT_SUITE(runs, 400) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("a1"));
    const wt = orch.store.getTask("a1")!.worktree;
    commitIn(wt, { "src/a.js": "1\n" });
    // trava de um processo que "morreu" e cujo pid foi reaproveitado (o nosso, com outro início): ignorada
    mkdirSync(join(wt, ".cardume"), { recursive: true });
    writeFileSync(join(wt, ".cardume", "verify.lock"), JSON.stringify({ pid: process.pid, start: 1, bg: true, sha: "velho" }));
    const t = () => orch.store.getTask("a1")!;
    const [g1, g2] = await Promise.all([orch.verifyProofs("a1", t(), sp(orch, "a1"), { forPr: true }), orch.verifyProofs("a1", t(), sp(orch, "a1"), { forPr: true })]);
    assert.deepEqual([g1.ok, g2.ok], [true, true]);
    assert.equal(readFileSync(runs, "utf8"), "x", "uma suíte só na worktree");
    assert.ok(!existsSync(join(wt, ".cardume", "verify.lock")), "trava solta no fim");
  } finally { orch.close(); }
});

test("fim de turno NÃO mata a verificação da mesma versão (espera); SIGTERM no meio solta o 'rodando' do selo e a trava", { skip: process.platform === "win32" }, async () => {
  const repo = gitRepo("mesmo-sha", { "package.json": JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('kid.pid', String(process.pid)); setTimeout(()=>{}, 60000)"` } }) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("ms1"));
    const wt = orch.store.getTask("ms1")!.worktree;
    commitIn(wt, { "src/a.js": "1\n" });
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "verify-tests", "ms1", "--repo", repo], { stdio: "ignore", env });
    assert.ok(await waitFor(() => existsSync(join(wt, "kid.pid"))), "a verificação começou");
    const kid = Number(readFileSync(join(wt, "kid.pid"), "utf8"));
    assert.ok(sp(orch, "ms1").verification?.running, "selo 'rodando'");
    // pedido novo pra MESMA versão (o fim de turno): não mata, não começa outra
    const t0 = Date.now();
    assert.deepEqual(await orch.runTestsNow("ms1"), []);
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(alive(kid) && p.exitCode === null, "a verificação da mesma versão continua");
    // SIGTERM: a suíte morre, o selo deixa de dizer 'rodando' e a trava some
    p.kill("SIGTERM");
    await new Promise((r) => p.exitCode !== null ? r(null) : p.on("exit", r));
    assert.ok(await waitFor(() => !alive(kid), 5000), "suíte órfã");
    assert.equal(sp(orch, "ms1").verification?.running ?? null, null, "o 'rodando' foi solto");
    assert.ok(!existsSync(join(wt, ".cardume", "verify.lock")), "a trava não ficou presa");
  } finally { orch.close(); }
});

test("'sem esperar' só vale pra versão commitada (sha não vazio, sem mudança solta); o openPr invalida o skip se commitar algo novo", async () => {
  const runs = join(root, "skip-runs");
  const repo = gitRepo("skip-limpo", { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }), "c.test.mjs": COUNT_SUITE(runs) });
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("sk1"));
    const wt = orch.store.getTask("sk1")!.worktree;
    commitIn(wt, { "src/a.js": "1\n" });
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    orch.store.patchSpec("sk1", { testsSkip: { reason: "hotfix", at: 1, sha: head } });
    writeFileSync(join(wt, "src", "solto.js"), "2\n"); // mudança solta: o skip não cobre isso
    await orch.verifyProofs("sk1", orch.store.getTask("sk1")!, sp(orch, "sk1"), { forPr: true });
    assert.equal(readFileSync(runs, "utf8"), "x", "com mudança solta a suíte roda");
    orch.store.patchSpec("sk1", { testsSkip: { reason: "hotfix", at: 1, sha: "" } });
    rmSync(join(wt, "src", "solto.js"));
    await orch.verifyProofs("sk1", orch.store.getTask("sk1")!, sp(orch, "sk1"), { forPr: true });
    assert.notEqual(sp(orch, "sk1").verification?.tests?.skippedBy, "hotfix", "skip sem sha não vale");
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    assert.match(src, /await commitLoose\(\);\n\s*\/\/ "entregue sem esperar os testes" vale pra versão que a pessoa viu[\s\S]{0,400}testsSkip: null/);
    assert.match(src, /const tmo = testTimeoutMs\(this\.ws\.repo\);/, "env STARFORK_TEST_TIMEOUT_S vence o checks.json");
  } finally { orch.close(); }
});

// ---------------------------------------------------------------- transparência do modo de testes

test("testModeNote: padrão não diz nada; projeto/organização dizem o modo; tentativa de mudar avisa", () => {
  assert.deepEqual(testModeNote({ mode: "auto" }), []);
  assert.deepEqual(testModeNote({ mode: "desligado" }), ["modo de testes: desligado (definido no projeto)"]);
  assert.deepEqual(testModeNote({ mode: "auto", testFast: "npm run unit" }), ["modo de testes: automático · comando rápido `npm run unit` (definido no projeto)"]);
  assert.deepEqual(testModeNote({ mode: "sempre", byOrg: true }), ["modo de testes: sempre a suíte inteira (definido pela organização)"]);
  assert.deepEqual(testModeNote({ mode: "sempre", tampered: true }), ["a tarefa tentou mudar o modo de testes (vale o da base)", "modo de testes: sempre a suíte inteira (definido no projeto)"]);
});

test("a branch da tarefa muda o checks.json pra 'desligado': vale o da BASE (sempre), a suíte roda e o selo + o PR avisam", async () => {
  const runs = join(root, "tamper-runs");
  const repo = join(root, "tamper");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.cardume/*\n!.cardume/checks.json\n");
  mkdirSync(join(repo, ".cardume"), { recursive: true });
  writeFileSync(join(repo, ".cardume", "checks.json"), JSON.stringify({ testMode: "sempre" }));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap c.test.mjs" } }));
  writeFileSync(join(repo, "c.test.mjs"), COUNT_SUITE(runs));
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("tp1"));
    const wt = orch.store.getTask("tp1")!.worktree;
    commitIn(wt, { "src/a.js": "1\n", ".cardume/checks.json": JSON.stringify({ testMode: "desligado" }) }, "agente mexeu no modo");
    // o app lê o checks.json do repo principal; aqui a branch da tarefa também mudou o dela
    await orch.verifyProofs("tp1", orch.store.getTask("tp1")!, sp(orch, "tp1"));
    assert.equal(readFileSync(runs, "utf8"), "x", "vale o da base: a suíte rodou");
    const t = sp(orch, "tp1").verification!.tests!;
    assert.deepEqual(t.modeNote, ["a tarefa tentou mudar o modo de testes (vale o da base)", "modo de testes: sempre a suíte inteira (definido no projeto)"]);
    const rep = await orch.reportFor("tp1");
    assert.match(rep, /\*\*Testes:\*\* a tarefa tentou mudar o modo de testes/);
    assert.match(rep, /\*\*Testes:\*\* modo de testes: sempre a suíte inteira \(definido no projeto\)/);
  } finally { orch.close(); }
});
