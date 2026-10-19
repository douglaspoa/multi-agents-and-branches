// node --test src/test-runner.test.ts  (npm test)
// Frente 1 · verificação independente: detectRunner / parseCounts / parseClaim / divergência (puras) + o PORTÃO
// (Orchestrator.verifyProofs) numa worktree de verdade: suíte que falha com o agente relatando sucesso → reprova
// com o número real e grava o evento `relato-divergente` e o selo em spec.verification.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentClaimFrom, claimDivergence, claimFromReq, detectRunner, parseClaim, parseCounts, runTests, skipReason, testGate, testTimeoutMs, type TestRun } from "./test-runner.ts";
import { Orchestrator } from "./orchestrator.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-verif-")));
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
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
  mkdirSync(d, { recursive: true });
  return d;
};

// ---------------------------------------------------------------- detectRunner

test("detectRunner: npm/pnpm/yarn/bun pelo lockfile; 'no test specified' não conta; pytest, cargo, go e swift; nada → null", () => {
  assert.equal(detectRunner(dirWith({ "package.json": '{"scripts":{"test":"node --test"}}' }))?.label, "npm test");
  assert.equal(detectRunner(dirWith({ "package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": "" }))?.kind, "pnpm");
  assert.equal(detectRunner(dirWith({ "package.json": '{"scripts":{"test":"jest"}}', "yarn.lock": "" }))?.kind, "yarn");
  assert.deepEqual(detectRunner(dirWith({ "package.json": '{"scripts":{"test":"x"}}', "bun.lock": "" }))?.args, ["run", "test"]);
  // o test que o `npm init` cria não é suíte — e um projeto Python com package.json de ferramenta cai no pytest
  assert.equal(detectRunner(dirWith({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
  assert.equal(detectRunner(dirWith({ "package.json": '{"scripts":{}}', "tests/test_a.py": "" }))?.kind, "pytest");
  assert.equal(detectRunner(dirWith({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))?.kind, "pytest");
  assert.equal(detectRunner(dirWith({ "pytest.ini": "" }))?.label, "pytest");
  assert.equal(detectRunner(dirWith({ "test_x.py": "" }))?.kind, "pytest");
  assert.equal(detectRunner(dirWith({ "Cargo.toml": "[package]" }))?.label, "cargo test");
  assert.deepEqual(detectRunner(dirWith({ "go.mod": "module x" }))?.args, ["test", "-v", "./..."]);
  assert.equal(detectRunner(dirWith({ "Package.swift": "// swift" }))?.label, "swift test");
  assert.equal(detectRunner(dirWith({ "README.md": "oi" })), null);
  assert.equal(detectRunner(dirWith({ "pyproject.toml": "[project]\nname='x'\n" })), null, "pyproject sem pytest e sem tests/ não é suíte");
});

test("detectRunner: package.json inválido LANÇA (o portão reprova, a regra de sempre)", () => {
  assert.throws(() => detectRunner(dirWith({ "package.json": "{ quebrado" })), /package\.json inválido/);
});

// ---------------------------------------------------------------- parseCounts

test("parseCounts: node:test (TAP e spec, soma rodadas encadeadas), jest, vitest, mocha", () => {
  assert.deepEqual(parseCounts("npm", "# tests 86\n# pass 84\n# fail 2\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("npm", "# pass 10\n# fail 0\n...\n# pass 5\n# fail 1\n"), { passed: 15, failed: 1 });
  assert.deepEqual(parseCounts("npm", "ℹ tests 3\nℹ pass 3\nℹ fail 0\n"), { passed: 3, failed: 0 });
  assert.deepEqual(parseCounts("yarn", "Test Suites: 1 failed\nTests:       2 failed, 84 passed, 86 total\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("pnpm", " Test Files  1 failed (3)\n      Tests  2 failed | 84 passed (86)\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("npm", "\n  84 passing (2s)\n  2 failing\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("npm", "\u001b[32m# pass 3\u001b[0m\n# fail 0"), { passed: 3, failed: 0 }, "sem as cores ANSI");
  assert.equal(parseCounts("npm", "tudo certo"), null);
});

test("parseCounts: pytest, cargo (soma os alvos), go -v, swift (XCTest e swift-testing)", () => {
  assert.deepEqual(parseCounts("pytest", "....F.\n=========== 84 passed, 2 failed in 1.20s ===========\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("pytest", "84 passed, 1 error in 0.3s\n"), { passed: 84, failed: 1 });
  assert.deepEqual(parseCounts("pytest", "===== 12 passed in 0.10s =====\n"), { passed: 12, failed: 0 });
  assert.deepEqual(parseCounts("cargo", "test result: ok. 40 passed; 0 failed; 0 ignored\n...\ntest result: FAILED. 44 passed; 2 failed; 0 ignored\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("go", "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n    --- PASS: TestB/sub (0.00s)\nFAIL\n"), { passed: 2, failed: 1 });
  assert.deepEqual(parseCounts("swift", "Executed 10 tests, with 0 failures\nExecuted 86 tests, with 2 failures (0 unexpected) in 1.0s\n"), { passed: 84, failed: 2 });
  assert.deepEqual(parseCounts("swift", "✔ Test run with 12 tests passed after 0.5 seconds.\n"), { passed: 12, failed: 0 });
  assert.equal(parseCounts("go", "ok  \tx\t0.1s\n"), null);
});

// ---------------------------------------------------------------- parseClaim + divergência

test("parseClaim: '86/86', 'ALL PASSED', '86 passed', 'Tests: 84 passed, 2 failed', em português também", () => {
  assert.deepEqual(parseClaim("Pronto! Testes: 86/86 ✅"), { passed: 86, total: 86 });
  assert.deepEqual(parseClaim("Tests: 84 passed, 2 failed"), { passed: 84, total: 86 });
  assert.deepEqual(parseClaim("2 failed, 84 passed, 86 total"), { passed: 84, total: 86 });
  assert.deepEqual(parseClaim("rodei a suíte: 86 passed"), { passed: 86, total: null });
  assert.deepEqual(parseClaim("86 testes passando"), { passed: 86, total: null });
  assert.deepEqual(parseClaim("passaram 86 de 86 testes"), { passed: 86, total: 86 });
  assert.deepEqual(parseClaim("ALL PASSED"), { passed: null, total: null, allPassed: true });
  assert.deepEqual(parseClaim("todos os testes passaram"), { passed: null, total: null, allPassed: true });
  // sem número de teste: não acusa ninguém
  assert.equal(parseClaim("Fiz a tela de login e o botão de sair."), null);
  assert.equal(parseClaim("Entrega em 19/10, rodada 1/2"), null, "data e rodada não são relato de teste");
  assert.equal(parseClaim("R2 passed na revisão"), null, "número colado em palavra (R2) não conta");
  assert.equal(parseClaim(""), null);
});

test("claimDivergence: número diferente do real reprova com a frase exata; real verde + relato verde não acusa", () => {
  assert.equal(claimDivergence({ passed: 86, total: 86 }, { passed: 84, failed: 2 }), "o agente relatou 86/86, a execução real deu 84/86");
  assert.equal(claimDivergence({ passed: 86, total: null }, { passed: 84, failed: 2 }), "o agente relatou 86/86, a execução real deu 84/86");
  assert.equal(claimDivergence({ passed: null, total: null, allPassed: true }, { passed: 84, failed: 2 }), "o agente relatou todos os testes passando, a execução real deu 84/86");
  assert.equal(claimDivergence({ passed: 84, total: 86 }, { passed: 84, failed: 2 }), null, "relatou a falha certinho: bate");
  assert.equal(claimDivergence({ passed: 5, total: 5 }, { passed: 86, failed: 0 }), null, "rodou só um pedaço, tudo verde: não acusa");
  assert.equal(claimDivergence({ passed: 80, total: 86 }, { passed: 86, failed: 0 }), "o agente relatou 80/86, a execução real deu 86/86");
  assert.equal(claimDivergence(null, { passed: 1, failed: 1 }), null, "sem relato legível: só mostra o real");
  assert.equal(claimDivergence({ passed: 3, total: 3 }, null), null, "sem contagem real legível: não acusa");
});

test("agentClaimFrom: a fala mais recente do agente DESDE o último pedido da pessoa; Sistema não conta. claimFromReq lê texto ou objeto", () => {
  const evs = [
    { agent: "Íris", type: "done", text: "Testes: 10/10" },
    { agent: "Você", type: "note", text: "Você: arruma o login" },
    { agent: "Íris", type: "think", text: "rodando npm test… 84 passed, 2 failed" },
    { agent: "Íris", type: "done", text: "Pronto, 86/86 testes passando" },
    { agent: "Sistema", type: "note", text: "gate de verificação: 1/2" },
  ];
  assert.deepEqual(agentClaimFrom(evs)?.claim, { passed: 86, total: 86 });
  assert.equal(agentClaimFrom(evs.slice(0, 2)), null, "relato de antes do pedido novo não vale");
  assert.deepEqual(claimFromReq({ list: [], tests: "86/86" }), { passed: 86, total: 86 });
  assert.deepEqual(claimFromReq({ tests: { passed: 84, failed: 2 } }), { passed: 84, total: 86 });
  assert.equal(claimFromReq([{ req: "x" }]), null);
});

test("skipReason: só docs/CSS pula com motivo; código, diff vazio ou só .cardume roda", () => {
  assert.match(skipReason(["README.md", "docs/guia.md", "src/app.css"]) ?? "", /só toca em docs\/estilo \(3 arquivos\)/);
  assert.equal(skipReason(["README.md", "src/app.ts"]), null);
  assert.equal(skipReason([]), null);
  assert.equal(skipReason([".cardume/artifacts/requirements.json"]), null);
});

test("testTimeoutMs: padrão 180 s; env STARFORK_TEST_TIMEOUT_S; testTimeoutSec do .cardume/checks.json", () => {
  assert.equal(testTimeoutMs(), 180_000);
  const repo = dirWith({ ".cardume/checks.json": '{"testTimeoutSec":30}' });
  assert.equal(testTimeoutMs(repo), 30_000);
  process.env.STARFORK_TEST_TIMEOUT_S = "5";
  try { assert.equal(testTimeoutMs(repo), 5_000); } finally { delete process.env.STARFORK_TEST_TIMEOUT_S; }
});

// ---------------------------------------------------------------- testGate (com run injetado)

const fakeRun = (r: Partial<TestRun>) => async () => ({ ran: true, passed: true, detail: "ok", runner: "npm test", kind: "npm", ...r }) as TestRun;
test("testGate: projeto sem suíte passa; timeout sem a tarefa pedir não reprova (fica no selo); com pedido reprova", async () => {
  const none = await testGate({ worktree: root, wantsTests: false, changed: ["a.ts"], claims: [], timeoutMs: 1000, run: async () => ({ ran: false, passed: true, detail: "sem suíte de testes detectada" }) });
  assert.deepEqual(none.reasons, []);
  assert.equal(none.verification.tests, null);
  const slow = fakeRun({ ran: true, passed: false, timedOut: true, detail: "npm test estourou o tempo (1s)" });
  const a = await testGate({ worktree: root, wantsTests: false, changed: ["a.ts"], claims: [], timeoutMs: 1000, run: slow });
  assert.deepEqual(a.reasons, []);
  assert.equal(a.verification.tests?.timedOut, true);
  const b = await testGate({ worktree: root, wantsTests: true, changed: ["a.ts"], claims: [], timeoutMs: 1000, run: slow });
  assert.match(b.reasons[0], /estourou o tempo/);
});

test("testGate: docs-only pula (com motivo) a não ser que a tarefa peça testes; mesma versão já verificada não roda de novo", async () => {
  let calls = 0;
  const run = async () => { calls++; return { ran: true, passed: false, detail: "npm test: 1/2 passaram", runner: "npm test", counts: { passed: 1, failed: 1 } } as TestRun; };
  const skip = await testGate({ worktree: root, wantsTests: false, changed: ["README.md"], claims: [], timeoutMs: 1000, run });
  assert.equal(calls, 0);
  assert.match(skip.verification.tests?.skipped ?? "", /docs\/estilo/);
  await testGate({ worktree: root, wantsTests: true, changed: ["README.md"], claims: [], timeoutMs: 1000, run });
  assert.equal(calls, 1, "a tarefa pediu testes: roda mesmo só com docs");
  const first = await testGate({ worktree: root, wantsTests: false, changed: ["a.ts"], claims: [{ passed: 2, total: 2 }], timeoutMs: 1000, sha: "abc", run });
  assert.equal(calls, 2);
  assert.equal(first.verification.sha, "abc");
  assert.equal(first.verification.divergente, true);
  const again = await testGate({ worktree: root, wantsTests: false, changed: ["a.ts"], claims: [], timeoutMs: 1000, sha: "abc", prev: first.verification, run });
  assert.equal(calls, 2, "mesmo HEAD, sem mudança solta: reaproveita");
  assert.equal(again.divergence, null, "não grava o evento de novo");
  assert.deepEqual(again.reasons, ["os testes falharam: npm test (1/2 passaram)", "o agente relatou 2/2, a execução real deu 1/2"]);
  await testGate({ worktree: root, wantsTests: false, changed: ["a.ts"], claims: [], timeoutMs: 1000, sha: "abc", dirty: true, prev: first.verification, run });
  assert.equal(calls, 3, "mudança solta: roda de novo");
});

// ---------------------------------------------------------------- runTests de verdade (node --test)

const SUITE_2_DE_3 = `import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => {});\ntest("b", () => {});\ntest("c", () => { assert.equal(1, 2); });\n`;
test("runTests: roda a suíte de verdade e lê o número real; tempo-limite mata a árvore", async () => {
  const d = dirWith({ "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap t.test.mjs" } }), "t.test.mjs": SUITE_2_DE_3 });
  const r = await runTests(d, { timeoutMs: 60_000 });
  assert.equal(r.ran, true);
  assert.equal(r.passed, false);
  assert.deepEqual(r.counts, { passed: 2, failed: 1 });
  assert.match(r.detail, /npm test: 2\/3 passaram/);
  const slow = dirWith({ "package.json": JSON.stringify({ scripts: { test: "node -e \"setTimeout(()=>{},60000)\"" } }) });
  const t0 = Date.now();
  const s = await runTests(slow, { timeoutMs: 1500 });
  assert.equal(s.timedOut, true);
  assert.ok(Date.now() - t0 < 15_000, "não esperou o processo filho");
});

// ---------------------------------------------------------------- o PORTÃO (verifyProofs) com fixture de repo

function gitRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}
const spec = (id: string): TaskSpec => ({
  id, title: id, objective: "somar itens", deliverables: ["soma"], requirements: ["soma os itens"],
  scope: { owns: ["src"], offLimits: [] },
  autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
  engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no",
  roles: [{ role: "builder", name: "Íris", engine: "mock" }],
}) as TaskSpec;

test("portão: suíte que FALHA com o agente relatando sucesso → reprova com o número real, evento relato-divergente e selo", async () => {
  const repo = gitRepo("portao");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("t1"));
    const t = orch.store.getTask("t1")!;
    const wt = t.worktree;
    writeFileSync(join(wt, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap t.test.mjs" } }));
    writeFileSync(join(wt, "t.test.mjs"), SUITE_2_DE_3);
    mkdirSync(join(wt, ".cardume", "artifacts"), { recursive: true });
    writeFileSync(join(wt, ".cardume", "artifacts", "evidence.md"), "rodei os testes\n");
    writeFileSync(join(wt, ".cardume", "artifacts", "requirements.json"), JSON.stringify({ list: [{ req: "soma os itens", status: "done", evidence: ["evidence.md"] }] }));
    orch.store.addEvent("t1", "Íris", "done", "Pronto! Implementei a soma. Testes: 3/3 passando ✅", true, "builder");

    // consulta sem efeito colateral (task_status do terminal): não roda a suíte nem grava selo
    const quiet = await orch.verifyProofs("t1", t, JSON.parse(t.spec_json), { runTests: false });
    assert.equal(quiet.ok, true, "runTests:false continua sem rodar a suíte");
    assert.equal((JSON.parse(orch.store.getTask("t1")!.spec_json) as TaskSpec).verification, undefined);
    await orch.verifyProofs("t1", t, JSON.parse(t.spec_json));

    const evs = orch.store.eventsForTask("t1");
    const div = evs.filter((e) => e.type === "relato-divergente");
    assert.equal(div.length, 1);
    assert.equal(div[0].text, "o agente relatou 3/3, a execução real deu 2/3");
    const s = JSON.parse(orch.store.getTask("t1")!.spec_json) as TaskSpec;
    assert.deepEqual({ ...s.verification!.tests }, { passed: 2, failed: 1, ran: true, runner: "npm test", ok: false });
    assert.equal(s.verification!.divergente, true);
    assert.equal(s.verification!.ci, null);
    // a mesma checagem pelo resultado do portão
    const gate = await orch.verifyProofs("t1", orch.store.getTask("t1")!, s);
    assert.equal(gate.ok, false);
    assert.ok(gate.reasons.some((r) => /^os testes falharam: npm test/.test(r)), gate.reasons.join(" · "));
    assert.ok(gate.reasons.includes("o agente relatou 3/3, a execução real deu 2/3"), gate.reasons.join(" · "));
  } finally { orch.close(); }
});

test("portão: projeto sem suíte continua passando; a tarefa não pediu testes e mesmo assim a suíte roda quando existe", async () => {
  const repo = gitRepo("sem-suite");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("t2"));
    const t = orch.store.getTask("t2")!;
    mkdirSync(join(t.worktree, ".cardume", "artifacts"), { recursive: true });
    writeFileSync(join(t.worktree, ".cardume", "artifacts", "ev.md"), "ok\n");
    writeFileSync(join(t.worktree, ".cardume", "artifacts", "requirements.json"), JSON.stringify([{ req: "soma os itens", status: "done", evidence: ["ev.md"] }]));
    const g1 = await orch.verifyProofs("t2", t, JSON.parse(t.spec_json));
    assert.deepEqual(g1, { ok: true, reasons: [] });
    writeFileSync(join(t.worktree, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test --test-reporter=tap ok.test.mjs" } }));
    writeFileSync(join(t.worktree, "ok.test.mjs"), `import { test } from "node:test";\ntest("a", () => {});\n`);
    const g2 = await orch.verifyProofs("t2", t, JSON.parse(orch.store.getTask("t2")!.spec_json));
    assert.deepEqual(g2, { ok: true, reasons: [] });
    const s = JSON.parse(orch.store.getTask("t2")!.spec_json) as TaskSpec;
    assert.deepEqual({ ...s.verification!.tests }, { passed: 1, failed: 0, ran: true, runner: "npm test", ok: true });
  } finally { orch.close(); }
});
