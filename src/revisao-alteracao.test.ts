// node --test src/revisao-alteracao.test.ts  (npm test)
// Revisão (mesa 09/10, _bmad-output/revisao-alteracao/mesa.md): "Pedir alteração" (texto ÚNICO) e "Chamar outro agente"
// (ETAPA EXTRA na mesma branch, motor mock = stub da IA — nunca a IA real), terminal vivo (term-msg --kind stage + fim
// do turno), `starfork etapa`/`starfork alteracao`, tool MCP e a linha do Relatório Starfork.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG, resolveWorkflow } from "./config.ts";
import { tempHome } from "./testing/temp-home.ts";
import { termMessage } from "./terminal.ts";
import { starforkCli } from "./starfork-cli.ts";
import { callTool, TOOLS } from "./mcp/tools.ts";
import { Store } from "./store.ts";
import * as R from "./revisao-alteracao.ts";
import { FLOW_BY_KIND, starforkReport } from "./lifecycle.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-rq-")));
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };
const gold = JSON.parse(readFileSync(new URL("../tests/fixtures/revisao-alteracao-golden/casos.json", import.meta.url), "utf8"));

function gitRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}
const spec = (id: string, budgetUsd?: number): TaskSpec => ({
  id, title: id, objective: "tela de horários", deliverables: ["fazer x"], requirements: ["Listar horários", "Reservar"],
  scope: { owns: ["src"], offLimits: [] },
  autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
  engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no", budgetUsd,
  roles: resolveWorkflow(DEFAULT_CONFIG, "feature", "mock"),
}) as TaskSpec;
async function readyTask(orch: Orchestrator, id: string, budget?: number) {
  await orch.createTask(spec(id, budget));
  await orch.runTask(id);
  assert.equal(orch.store.getTask(id)!.status, "review", "a tarefa terminou pronta pra revisar");
}
const specOf = (orch: Orchestrator, id: string) => JSON.parse(orch.store.getTask(id)!.spec_json) as TaskSpec;

before(() => {
  for (const k of ["HOME", "USERPROFILE", "CARDUME_MOCK_SPEED", "CARDUME_MOCK_ROLE_COST_USD", "CARDUME_AUTOSUMMARY", "CARDUME_DB", "CARDUME_TASK", "CARDUME_AGENT", "CARDUME_ROLE"]) saved[k] = process.env[k];
  home = tempHome({ learnMode: "desligado" });
  process.env.HOME = home.home; process.env.USERPROFILE = home.home;
  process.env.CARDUME_MOCK_SPEED = "50";
  process.env.CARDUME_MOCK_ROLE_COST_USD = "0.1";
  process.env.CARDUME_AUTOSUMMARY = "0";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- puro (≡ app/src/js/71-revisao-alteracao.js)

test("golden casos.json: texto do pedido, portões, agentes, caminho de UI e linhas do PR (≡ app)", () => {
  for (const [cat, exp] of gold.agents) assert.deepEqual(JSON.parse(JSON.stringify(R.extraStageAgents(cat))), exp);
  for (const [c, exp] of gold.changeRequestText) assert.equal(R.changeRequestText(c), exp);
  for (const [g, exp] of gold.changeGate) assert.deepEqual(R.changeGate(g), exp);
  for (const [s, c, exp] of gold.extraCapGate) assert.deepEqual(R.extraCapGate(s, c), exp);
  for (const [q, exp] of gold.resolveExtraAgent) assert.equal(R.resolveExtraAgent(gold.catalog, q)?.id ?? null, exp, q);
  for (const [p, exp] of gold.isUiPath) assert.equal(R.isUiPath(p), exp, p);
  for (const [x, exp] of gold.extraReportLines) assert.deepEqual(R.extraReportLines(x), exp);
});

test("pedido de alteração: UMA mensagem com requisitos e anexos; vazio não manda nada", () => {
  const t = R.changeRequestText({ text: "o botão some", reqs: [{ i: 1, text: "Reservar" }], attachments: [".cardume/attachments/p.png"] });
  assert.match(t, /^PEDIDO DE ALTERAÇÃO \(revisão humana\): o botão some/);
  assert.match(t, /R2 “Reservar”/);
  assert.match(t, /\.cardume\/attachments\/p\.png/);
  assert.match(t, /mesma branch, sem recomeçar/);
  assert.equal(R.changeRequestText({ text: "  " }), "");
  assert.equal(R.changeGate({ status: "running" }).ok, false);
  assert.equal(R.changeGate({ status: "review" }).ok, true);
});

test("instrução da etapa: design usa a Impeccable quando o projeto tem, fica na UI e pede prints de antes/depois", () => {
  const a = R.resolveExtraAgent([], "design")!;
  const withImp = R.extraStagePrompt(a, { impeccable: true, note: "tela apertada", reqs: ["Listar horários"] });
  assert.match(withImp, /skill \*\*impeccable\*\*/);
  assert.match(withImp, /design-antes-1\.png/);
  assert.match(withImp, /design-depois-1\.png/);
  assert.match(withImp, /NÃO mude regra de negócio/);
  assert.match(withImp, /tela apertada/);
  assert.match(withImp, /R1\. Listar horários/);
  assert.doesNotMatch(R.extraStagePrompt(a, {}), /impeccable/);
  assert.match(R.extraStagePrompt(R.resolveExtraAgent([], "qa")!, {}), /tests\.md/);
});

test("faixa: a etapa extra entra DEPOIS de Revisar e antes de Provar (e no fim dos papéis quando não há revisor)", () => {
  const ex = [{ id: "extra-aria-1", agentId: "aria", name: "Aria", kind: "design", role: "designer", status: "feito", by: "app", at: 1 }] as R.ExtraStage[];
  const ids = R.flowWithExtras(FLOW_BY_KIND.codigo, ex).map((s) => s.id);
  assert.deepEqual(ids.slice(ids.indexOf("revisar"), ids.indexOf("revisar") + 3), ["revisar", "extra-aria-1", "provar"]);
  assert.equal(R.flowWithExtras(FLOW_BY_KIND.codigo, []), FLOW_BY_KIND.codigo);
  const n1 = R.newExtraStage(ex, { id: "aria", name: "Aria", kind: "design", role: "designer" }, { at: 2, by: "app" });
  assert.equal(n1.id, "extra-aria-2");
  const done = R.finishExtraStage(n1, { ok: true, at: 3, files: ["src/App.css", "src/api.ts", ".cardume/artifacts/x.png"], summary: " a\n b ", usd: 0.123456 });
  assert.deepEqual(done.files, ["src/App.css", "src/api.ts"], ".cardume não conta como mudança");
  assert.deepEqual(done.outsideUi, ["src/api.ts"]);
  assert.equal(done.summary, "a b");
  assert.equal(done.usd, 0.1235);
});

test("Relatório Starfork: a linha 'Passou pelo agente de design' vai no corpo do PR", () => {
  const md = starforkReport({ requirements: [], costByRole: [], totalUsd: 0, capUsd: 5, releases: [], rounds: [], runs: [],
    extraLines: R.extraReportLines([{ id: "e", agentId: "aria", name: "Aria", kind: "design", role: "designer", status: "feito", by: "app", at: 1, files: ["a.css"], summary: "contraste" }]) });
  assert.match(md, /\*\*Passou pelo agente de design \(Aria\):\*\* contraste — 1 arquivo/);
});

// ---------------------------------------------------------------- motor (mock = stub da IA)

test("Chamar agente de design: a etapa entra, roda na MESMA branch, volta pra revisar com o que mudou e vai pro PR", async () => {
  const repo = gitRepo("extra");
  const orch = new Orchestrator(repo);
  try {
    await readyTask(orch, "t-ex");
    const branch = orch.store.getTask("t-ex")!.branch;
    await orch.runExtraStage("t-ex", "design", { note: "a lista está apertada", by: "app" });
    const t = orch.store.getTask("t-ex")!;
    assert.equal(t.status, "review", "voltou pra pronta pra revisar");
    assert.equal(t.branch, branch, "mesma branch");
    const sp = specOf(orch, "t-ex");
    assert.equal(sp.extraStages?.length, 1);
    const st = sp.extraStages![0];
    assert.equal(st.status, "feito");
    assert.equal(st.agentId, "aria");
    assert.equal(st.note, "a lista está apertada");
    assert.ok(st.shaBefore && st.shaAfter && st.shaBefore !== st.shaAfter, "commit novo da etapa");
    assert.ok((st.files ?? []).length >= 1, "arquivos que a etapa mudou");
    assert.ok((st.usd ?? 0) > 0, "custo da etapa (mock)");
    assert.ok(!("spentBefore" in st), "campo interno não fica no registro");
    const evs = orch.store.eventsForTask("t-ex").map((e) => e.text).join("\n");
    assert.match(evs, /etapa extra: Aria \(design\) entrou na tarefa/);
    assert.match(evs, /etapa extra de design terminou — mudou \d+ arquivo/);
    const log = execFileSync("git", ["-C", t.worktree, "log", "-1", "--format=%s"], { encoding: "utf8" });
    assert.match(log, /etapa extra \(design\): Aria/);
    // chamar de novo: id novo, mesma lista
    await orch.runExtraStage("t-ex", "aria", {});
    assert.deepEqual(specOf(orch, "t-ex").extraStages!.map((s) => s.id), ["extra-aria-1", "extra-aria-2"]);
  } finally { orch.close(); }
});

test("etapa extra respeita o teto: a 80% não começa (explica e não muda status)", async () => {
  const repo = gitRepo("extra-cap");
  const orch = new Orchestrator(repo);
  try {
    // 3 papéis a US$ 0,10 = 0,30; teto 0,35 → 86% ≥ 80%
    orch.store; await orch.createTask(spec("t-cap", 0.35));
    orch.store.patchSpec("t-cap", { budgetUsd: 10 });
    await orch.runTask("t-cap");
    orch.store.patchSpec("t-cap", { budgetUsd: 0.35 });
    await orch.runExtraStage("t-cap", "design", {});
    assert.equal(orch.store.getTask("t-cap")!.status, "review");
    assert.equal(specOf(orch, "t-cap").extraStages, undefined);
    assert.match(orch.store.eventsForTask("t-cap").map((e) => e.text).join("\n"), /não chamei o agente: a tarefa já usou US\$ 0,30 de US\$ 0,35 \(86% do teto\)/);
    await assert.rejects(orch.beginExtraStage("t-cap", "nada"), /não conheço o agente "nada"/);
  } finally { orch.close(); }
});

test("terminal vivo: term-msg --kind stage começa a etapa e devolve a instrução; o fim do turno fecha com o que mudou", async () => {
  const repo = gitRepo("extra-term");
  const orch = new Orchestrator(repo);
  try {
    await readyTask(orch, "t-tm");
    const text = await termMessage(orch, "t-tm", "stage", { msg: "olha o contraste", deliver: "design" });
    assert.match(text, /ETAPA EXTRA DA REVISÃO — você é Aria \(design\)/);
    assert.match(text, /olha o contraste/);
    assert.equal(R.runningExtra(specOf(orch, "t-tm").extraStages)?.by, "terminal");
    // outra etapa enquanto esta roda → recusa
    await assert.rejects(termMessage(orch, "t-tm", "stage", { deliver: "qa" }), /ainda está rodando/);
    // o "agente" do terminal mexe numa tela e o turno acaba
    const wt = orch.store.getTask("t-tm")!.worktree;
    mkdirSync(join(wt, "src", "styles"), { recursive: true });
    writeFileSync(join(wt, "src", "styles", "lista.css"), ".lista{gap:8px}\n");
    mkdirSync(join(wt, ".cardume", "artifacts"), { recursive: true });
    writeFileSync(join(wt, ".cardume", "artifacts", "etapa-extra.md"), "# etapa\nmais espaço entre os itens da lista\n");
    await orch.terminalTurnEnd("t-tm");
    const st = specOf(orch, "t-tm").extraStages![0];
    assert.equal(st.status, "feito");
    assert.deepEqual(st.files, ["src/styles/lista.css"]);
    assert.equal(st.outsideUi, undefined, "css é tela");
    assert.equal(st.summary, "mais espaço entre os itens da lista");
    assert.equal(orch.store.getTask("t-tm")!.status, "review");
  } finally { orch.close(); }
});

test("`starfork etapa design` e a tool MCP extra_stage; `starfork etapa review` continua sendo status; `starfork alteracao`", async () => {
  const repo = gitRepo("extra-sf");
  const orch = new Orchestrator(repo);
  try {
    await readyTask(orch, "t-sf");
    const wt = orch.store.getTask("t-sf")!.worktree;
    const db = join(repo, ".cardume", "state.sqlite");
    assert.ok(existsSync(db));
    process.env.CARDUME_DB = db; process.env.CARDUME_TASK = "t-sf"; process.env.CARDUME_AGENT = "Íris";
    const out: string[] = [], err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    // shell no prompt (sem IA aberta): grava a instrução e mostra o comando que abre a IA com ela
    assert.equal(await starforkCli(["etapa", "design", "olha", "o", "contraste"], io), 0, err.join("\n"));
    assert.match(out.join("\n"), /starfork ia claude --resume --msg-file \.cardume\/term\/next-msg\.txt/);
    assert.match(readFileSync(join(wt, ".cardume", "term", "next-msg.txt"), "utf8"), /você é Aria[\s\S]*olha o contraste/);
    const s2 = new Store(db);
    try { assert.equal(R.runningExtra((JSON.parse(s2.getTask("t-sf")!.spec_json) as TaskSpec).extraStages)?.by, "mcp"); } finally { s2.close(); }
    await orch.finishExtraStage("t-sf", true);
    // a tool MCP direto (a IA chama): devolve a instrução pra ela seguir no mesmo turno
    assert.ok(TOOLS.some((t) => t.name === "extra_stage"));
    const ctx = { store: new Store(db), db, task: "t-sf", agent: "Íris", role: "builder", orch: async () => orch };
    try {
      const r = await callTool(ctx, "extra_stage", { agent: "revisor", note: "casos de borda" });
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /você é Nyx/);
      const r2 = await callTool(ctx, "extra_stage", { agent: "qa" });
      assert.ok(r2.isError, "uma etapa por vez");
    } finally { ctx.store.close(); }
    await orch.finishExtraStage("t-sf", true);
    // status continua igual
    out.length = 0;
    assert.equal(await starforkCli(["etapa", "review", "--nota", "provado"], io), 0, err.join("\n"));
    assert.match(out.join("\n"), /status: pronta pra revisão/);
    // alteração: o MESMO texto do botão, com o requisito marcado
    out.length = 0;
    assert.equal(await starforkCli(["alteracao", "o", "botão", "some", "--req", "2"], io), 0, err.join("\n"));
    const msg = readFileSync(join(wt, ".cardume", "term", "next-msg.txt"), "utf8");
    assert.equal(msg, R.changeRequestText({ text: "o botão some", reqs: [{ i: 1, text: "Reservar" }] }));
  } finally { orch.close(); }
});

test("CLI: `cardume etapa` roda a etapa (motor da tarefa) e `cardume alteracao` recusa tarefa trabalhando", async () => {
  const repo = gitRepo("extra-cli");
  const orch = new Orchestrator(repo);
  try { await readyTask(orch, "t-cli"); } finally { orch.close(); }
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "etapa", "t-cli", "qa", "--msg", "cobre o vazio", "--repo", repo], { stdio: "pipe", env: process.env });
  const o2 = new Orchestrator(repo);
  try {
    const st = specOf(o2, "t-cli").extraStages!;
    assert.equal(st[0].agentId, "cobalt");
    assert.equal(st[0].status, "feito");
    assert.equal(st[0].note, "cobre o vazio");
    assert.equal(o2.store.getTask("t-cli")!.status, "review");
    o2.store.setStatus("t-cli", "running");
  } finally { o2.close(); }
  assert.throws(() => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "alteracao", "t-cli", "--msg", "x", "--repo", repo], { stdio: "pipe", env: process.env }), /trabalhando/);
});
