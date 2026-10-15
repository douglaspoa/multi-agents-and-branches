// node --test src/change-reasons.test.ts  (npm test)
// Código explicado (redesenho "Semana", 14/10): o porquê de cada trecho — funções puras + a tool MCP
// register_change_reason gravando na worktree + o mesmo pelo `starfork porque` no shell + a instrução no prompt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG, resolveWorkflow } from "./config.ts";
import { tempHome } from "./testing/temp-home.ts";
import { starforkCli } from "./starfork-cli.ts";
import { callTool, TOOLS } from "./mcp/tools.ts";
import { Store } from "./store.ts";
import { INTEGRADO_RULE, SHELL_COMMANDS, shellInstructions } from "./terminal-integrado.ts";
import { cleanReason, mergeReason, normRequirement, reasonLine, reasonRule, REASONS_REL, REASONS_ARTIFACT } from "./change-reasons.ts";
import type { TaskSpec } from "./types.ts";

const REQS = ["Aviso de cupom vencido", "Desconto aplicado no carrinho", "Total com frete fica correto com cupom"];

test("normRequirement: R3 / 3 / texto do requisito → R<n>; null/nenhum → null; desconhecido → undefined", () => {
  assert.equal(normRequirement("R3", REQS), "R3");
  assert.equal(normRequirement("r 2", REQS), "R2");
  assert.equal(normRequirement(1, REQS), "R1");
  assert.equal(normRequirement("total com frete fica correto com cupom", REQS), "R3");
  assert.equal(normRequirement(null, REQS), null);
  assert.equal(normRequirement("nenhum", REQS), null);
  assert.equal(normRequirement("R9", REQS), undefined, "não existe R9");
  assert.equal(normRequirement("login com google", REQS), undefined);
});

test("cleanReason: valida arquivo, faixa, requisito e motivo; ts é do Starfork", () => {
  const ok = cleanReason({ file: "./src/carrinho/total.ts", range: "14 – 15", requirement: "R3", reason: "O frete entrava depois do desconto; a LOJA-12 pede cupom sobre o total com frete.", covered_by: "tests/carrinho.test.ts › total com frete", ts: 1 }, REQS, 1234);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.entry, { file: "src/carrinho/total.ts", range: "14-15", requirement: "R3", reason: "O frete entrava depois do desconto; a LOJA-12 pede cupom sobre o total com frete.", covered_by: "tests/carrinho.test.ts › total com frete", ts: 1234 });
  const nullReq = cleanReason({ file: "src/a.ts", range: "7", requirement: null, reason: "efeito validava o cupom salvo vazio e chamava a API à toa" }, REQS, 1);
  assert.ok(nullReq.ok && nullReq.entry.requirement === null);
  assert.match((cleanReason({ file: "/etc/x", range: "1", requirement: "R1", reason: "a b c d e" }, REQS, 1) as { error: string }).error, /file inválido/);
  assert.match((cleanReason({ file: "a.ts", range: "", requirement: "R1", reason: "a b c d e" }, REQS, 1) as { error: string }).error, /range inválido/);
  assert.match((cleanReason({ file: "a.ts", range: "3", requirement: "R7", reason: "a b c d e" }, REQS, 1) as { error: string }).error, /não é desta tarefa/);
  assert.match((cleanReason({ file: "a.ts", range: "3", requirement: "R1", reason: "melhoria" }, REQS, 1) as { error: string }).error, /curto demais/);
});

test("mergeReason: mesma faixa substitui; outras entram no fim", () => {
  const a = { file: "a.ts", range: "1-2", requirement: "R1", reason: "x", covered_by: "", ts: 1 };
  const b = { file: "a.ts", range: "5", requirement: null, reason: "y", covered_by: "", ts: 2 };
  const a2 = { ...a, reason: "x corrigido", ts: 3 };
  assert.deepEqual(mergeReason([a, b], a2).map((x) => x.reason), ["y", "x corrigido"]);
  assert.deepEqual(mergeReason("lixo", a), [a]);
});

test("a linha no terminal e a instrução do prompt", () => {
  assert.equal(reasonLine({ file: "src/carrinho/total.ts", range: "14-15", requirement: "R3" }), "starfork · porquê registrado · total.ts:14-15 → R3");
  assert.equal(reasonLine({ file: "a.ts", range: "7", requirement: null }), "starfork · porquê registrado · a.ts:7 → fora dos requisitos");
  assert.match(reasonRule(false), /register_change_reason[\s\S]*desfaça o trecho/);
  assert.match(reasonRule(true), /starfork porque --json/);
  assert.match(INTEGRADO_RULE, /register_change_reason/);
  assert.match(shellInstructions(), /starfork porque/);
  assert.ok(SHELL_COMMANDS.some((c) => c.tool === "register_change_reason"));
  assert.ok(TOOLS.some((t) => t.name === "register_change_reason"));
  assert.equal(REASONS_REL, ".cardume/artifacts/" + REASONS_ARTIFACT);
});

// ---------------- a tool de verdade (motor mock, nada de IA real) ----------------
const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-porque-")));
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };
before(() => {
  for (const k of ["HOME", "USERPROFILE", "CARDUME_DB", "CARDUME_TASK", "CARDUME_AGENT", "CARDUME_ROLE"]) saved[k] = process.env[k];
  home = tempHome({ learnMode: "desligado" });
  process.env.HOME = home.home; process.env.USERPROFILE = home.home;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("register_change_reason grava na worktree (pasta .starfork, fora da lista de artefatos) e o `starfork porque` faz o mesmo", async () => {
  const repo = join(root, "loja");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n"); g("add", "-A"); g("commit", "-q", "-m", "base");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask({ id: "cupom", title: "Cupom", objective: "cupom no carrinho", deliverables: [], requirements: REQS, scope: { owns: ["src"], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" }, engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no",
      roles: resolveWorkflow(DEFAULT_CONFIG, "feature", "mock") } as TaskSpec);
    const wt = orch.store.getTask("cupom")!.worktree;
    const db = join(repo, ".cardume", "state.sqlite");
    const ctx = { store: new Store(db), db, task: "cupom", agent: "Íris", role: "builder", orch: async () => orch };
    try {
      const r = await callTool(ctx, "register_change_reason", { file: "src/carrinho/total.ts", range: "14-15", requirement: "R3", reason: "O frete entrava depois do desconto e o teste do R3 esperava R$ 179,10.", covered_by: "tests/carrinho.test.ts › total com frete" });
      assert.ok(!r.isError, r.text);
      assert.equal(r.text, "starfork · porquê registrado · total.ts:14-15 → R3");
      const bad = await callTool(ctx, "register_change_reason", { file: "src/a.ts", range: "1", requirement: "R1", reason: "ajuste" });
      assert.ok(bad.isError);
    } finally { ctx.store.close(); }
    process.env.CARDUME_DB = db; process.env.CARDUME_TASK = "cupom"; process.env.CARDUME_AGENT = "Íris";
    const out: string[] = [], err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    assert.equal(await starforkCli(["porque", "--json", JSON.stringify({ file: "src/carrinho/useCupom.ts", range: "32-35", requirement: "aviso de cupom vencido", reason: "Cupom vencido passava sem aviso; o R1 pede a mensagem antes de aplicar." })], io), 0, err.join("\n"));
    assert.match(out.join("\n"), /useCupom\.ts:32-35 → R1/);
    assert.equal(await starforkCli(["porque", "--json", "{nao é json"], io), 1);
    const saved = JSON.parse(readFileSync(join(wt, REASONS_REL), "utf8"));
    assert.deepEqual(saved.map((x: { file: string; requirement: string }) => [x.file, x.requirement]), [["src/carrinho/total.ts", "R3"], ["src/carrinho/useCupom.ts", "R1"]]);
    assert.ok(saved.every((x: { ts: number }) => x.ts > 0), "ts preenchido pelo Starfork");
  } finally { orch.close(); }
});
