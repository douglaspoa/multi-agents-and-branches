// node --test src/ciclo-f2.test.ts  (npm test)
// F2 da decisão da mesa (03/10): FLOW_BY_KIND, revisor com veredito e 2 rodadas, bastão por HANDOFF.md, Relatório
// Starfork — e o e2e com o motor mock: plano (Cadeado 1) → construir → revisar (muda) → construir → revisar (aprova)
// → prova → portão, com o teto pausando a 80% no meio.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import {
  FLOW_BY_KIND, KIND_LABEL, KIND_TEAM, MAX_REVIEW_ROUNDS, diversifyReviewer, parseVerdict, producerIndex, reviewDecision,
  reviewerIsSame, rolesForKind, roundText, starforkReport, taskKindOf, type TaskKind,
} from "./lifecycle.ts";
import { buildHandoff, ensureHandoff, handoffOk, handoffPath, passBaton, rolePrompt } from "./handoff.ts";
import { parseArgs } from "./util/args.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-f2-")));
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };
const gold = (f: string) => JSON.parse(readFileSync(new URL(`../tests/fixtures/ciclo-golden/${f}`, import.meta.url), "utf8"));

function gitRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}
const kindSpec = (id: string, kind: TaskKind, o: Partial<TaskSpec> = {}): TaskSpec => ({
  id, title: id, objective: "lista de compras com total", deliverables: ["somar os itens"], requirements: ["mostra o total da lista"],
  scope: { owns: ["src"], offLimits: [] },
  autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto", planApproval: "review" },
  engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no", taskKind: kind,
  roles: rolesForKind(kind, DEFAULT_CONFIG.agents, { engine: "mock" }),
  ...o,
}) as TaskSpec;
const st = (orch: Orchestrator, id: string) => orch.store.getTask(id)!;
const sp = (orch: Orchestrator, id: string) => JSON.parse(st(orch, id).spec_json) as TaskSpec;

before(() => {
  for (const k of ["HOME", "USERPROFILE", "CARDUME_MOCK_SPEED", "CARDUME_MOCK_ROLE_COST_USD", "CARDUME_AUTOSUMMARY", "CARDUME_MOCK_VERDICTS", "CARDUME_MOCK_PROVE"]) saved[k] = process.env[k];
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

// ---------------------------------------------------------------- puras (fixtures ≡ app)

test("golden fluxos.json: FLOW_BY_KIND por tipo, rótulos, equipes prontas, rolesForKind e taskKindOf", () => {
  const g = gold("fluxos.json");
  assert.deepEqual(JSON.parse(JSON.stringify(FLOW_BY_KIND)), g.flows);
  assert.deepEqual(KIND_LABEL, g.labels);
  assert.deepEqual(KIND_TEAM, g.teams);
  for (const k of Object.keys(FLOW_BY_KIND)) assert.deepEqual(rolesForKind(k as TaskKind, DEFAULT_CONFIG.agents).map((r) => ({ role: r.role, agentId: r.agentId, model: r.model ?? null })), g.rolesForKind[k]);
  assert.deepEqual(rolesForKind("codigo", DEFAULT_CONFIG.agents, { withDesign: true }).map((r) => ({ role: r.role, agentId: r.agentId, model: r.model ?? null })), g.rolesForKind["codigo+design"]);
  for (const [i, e] of g.taskKindOf) assert.equal(taskKindOf(i), e, JSON.stringify(i));
  // etapa que não vale pro tipo NÃO aparece: Pesquisa/Documento sem Design, Código com Design só se pedir
  assert.ok(!FLOW_BY_KIND.pesquisa.some((s) => s.id === "design"));
  assert.ok(FLOW_BY_KIND.codigo.find((s) => s.id === "design")!.optional);
  // só dois cadeados humanos, sempre: Plano (1) e Entregar (2)
  for (const k of Object.keys(FLOW_BY_KIND) as TaskKind[]) assert.deepEqual(FLOW_BY_KIND[k].filter((s) => s.lock).map((s) => [s.id, s.lock]), [["plano", 1], ["entregar", 2]]);
  assert.equal(FLOW_BY_KIND.documento.find((s) => s.role === "reviewer")!.lens, "documento");
});

test("revisor independente: no mesmo motor e modelo do builder, o Claude troca o modelo; outro motor só avisa", () => {
  const b = { role: "builder", name: "Íris", engine: "claude" }, rv = { role: "reviewer", name: "Nyx", engine: "claude" };
  assert.equal(diversifyReviewer([b, rv])[1].model, "sonnet");
  assert.equal(diversifyReviewer([{ ...b, model: "sonnet" }, { ...rv, model: "sonnet" }])[1].model, "opus");
  assert.equal(diversifyReviewer([b, { ...rv, engine: "codex" }])[1].model, undefined, "motor diferente: já independente");
  const cx = [{ ...b, engine: "codex" }, { ...rv, engine: "codex" }];
  assert.ok(reviewerIsSame(diversifyReviewer(cx)[0], diversifyReviewer(cx)[1]), "Codex igual: mantém e a UI avisa");
  assert.equal(producerIndex([{ role: "planner" }, { role: "docs" }, { role: "reviewer" }], 2), 1);
  assert.equal(producerIndex([{ role: "reviewer" }], 0), -1);
});

test("golden veredito.json: parseVerdict nunca aprova por omissão; reviewDecision com o limite de 2 rodadas", () => {
  const g = gold("veredito.json");
  for (const [t, k, items] of g.cases) assert.deepEqual(parseVerdict(t), { kind: k, items }, JSON.stringify(t));
  for (const [r, k, e] of g.decision) assert.equal(reviewDecision(r, { kind: k, items: k === "muda" ? ["x"] : [] }), e);
  assert.equal(MAX_REVIEW_ROUNDS, 2);
  assert.equal(roundText({ round: 1, verdict: "muda", items: ["a", "b"], reviewer: "Nyx" }), "Revisão 1/2 (Nyx): muda — 2 itens");
});

test("golden relatorio.json: Relatório Starfork (requisitos × provas, motivos, custo por papel, versões)", () => {
  for (const c of gold("relatorio.json").cases) assert.equal(starforkReport(c.input), c.expected);
  assert.doesNotMatch(gold("relatorio.json").cases[0].expected, /melhorou/i);
});

test("bastão: buildHandoff tem as 3 seções; a guarda recusa vazio; ensureHandoff mantém o do papel e escreve o fallback", () => {
  const wt = mkdtempSync(join(root, "wt-"));
  const h = buildHandoff({ from: { name: "Nyx", role: "reviewer" }, to: { name: "Íris", role: "builder" }, did: "revisei o diff", verdict: { kind: "muda", items: ["cobrir lista vazia"] } });
  assert.match(h, /## O que fiz\nrevisei o diff/);
  assert.match(h, /## O que falta\n- cobrir lista vazia/);
  assert.match(h, /## O que decidi\n- Veredito: muda/);
  assert.ok(handoffOk(h));
  for (const bad of [null, "", "# Bastão\n\n", "   \n#t\n"]) assert.ok(!handoffOk(bad as string), JSON.stringify(bad));
  // papel não escreveu → o orquestrador escreve
  let r = ensureHandoff(wt, 1, { from: { name: "Vega", role: "planner" }, did: "planejei em 2 passos" });
  assert.ok(r.wrote);
  assert.match(readFileSync(handoffPath(wt), "utf8"), /planejei em 2 passos/);
  // papel escreveu um bom → fica o dele
  writeFileSync(handoffPath(wt), "## O que fiz\nimplementei a soma com testes\n");
  r = ensureHandoff(wt, 2, { from: { name: "Íris", role: "builder" }, did: "x" });
  assert.equal(r.wrote, false);
  assert.match(r.text, /implementei a soma/);
  assert.deepEqual(readdirSync(join(wt, ".cardume", "handoffs")).sort(), ["01-planner.md", "02-builder.md"]);
});

test("modo terminal: passBaton devolve o prompt da PRÓXIMA sessão (com lente e veredito pro revisor)", () => {
  const wt = mkdtempSync(join(root, "wt-"));
  const spec = { title: "Relatório de vendas", objective: "relatório com fontes" };
  const r = passBaton(wt, 1, spec, { from: { name: "Lumen", role: "docs" }, did: "escrevi as 3 seções" }, { name: "Nyx", role: "reviewer" }, { kind: "documento", round: 1 });
  assert.ok(r.wrote);
  assert.match(r.nextPrompt!, /^Você é Nyx \(papel: reviewer\) na tarefa "Relatório de vendas"/);
  assert.match(r.nextPrompt!, /escrevi as 3 seções/);
  assert.match(r.nextPrompt!, /LENTE: DOCUMENTO — confira as FONTES/);
  assert.match(r.nextPrompt!, /VEREDITO: aprova/);
  assert.equal(passBaton(wt, 2, spec, { from: { name: "Nyx", role: "reviewer" }, did: "ok" }, undefined).nextPrompt, null);
  assert.doesNotMatch(rolePrompt(spec, { name: "Íris", role: "builder" }, "x"), /VEREDITO/);
});

test("CLI: --task-kind monta a equipe pelo tipo (flag de texto conhecida)", () => {
  const a = parseArgs(["new", "--title", "x", "--task-kind", "pesquisa", "--with-design"]);
  assert.equal(a.flags["task-kind"], "pesquisa");
  assert.equal(a.flags["with-design"], "true");
});

// ---------------------------------------------------------------- e2e (motor mock)

test("e2e mock: plano (Cadeado 1) → construir → revisar muda → construir → [teto 80%] → revisar aprova → prova → portão", async () => {
  process.env.CARDUME_MOCK_VERDICTS = "muda,aprova";
  process.env.CARDUME_MOCK_PROVE = "1";
  const repo = gitRepo("e2e");
  const orch = new Orchestrator(repo);
  try {
    // US$ 0,10 por papel. Teto 0,50 (80% = 0,40): plano 0,1 · build 0,2 · revisão 0,3 · build 0,4 → para ANTES da revisão 2
    await orch.createTask(kindSpec("t-e2e", "codigo", { budgetUsd: 0.5 }));
    assert.deepEqual(sp(orch, "t-e2e").roles.map((r) => r.agentId), ["vega", "iris", "nyx"]);

    // 1) Cadeado 1: o plano para pra aprovar
    await orch.runTask("t-e2e");
    assert.equal(st(orch, "t-e2e").status, "plan-review");
    assert.ok(existsSync(join(st(orch, "t-e2e").worktree, ".cardume", "PLAN.md")));
    assert.ok(handoffOk(readFileSync(handoffPath(st(orch, "t-e2e").worktree), "utf8")), "bastão do plano pro builder");

    // 2) aprovar = ▶ de novo: build → revisão 1 (muda) → build de novo → teto a 80% antes da revisão 2
    await orch.runTask("t-e2e");
    let t = st(orch, "t-e2e");
    assert.equal(t.status, "needs-you");
    let s = sp(orch, "t-e2e");
    assert.equal(s.needsYou?.kind, "teto");
    assert.match(s.needsYou!.text, /parei antes de Nyx revisar/);
    assert.deepEqual(s.reviewRounds!.map((r) => [r.round, r.verdict, r.items.length]), [[1, "muda", 2]]);
    assert.match(s.adjustment ?? "", /A revisão 1 \(Nyx\) pediu estas mudanças:\n- cobrir o caso de lista vazia/);
    const hs = readdirSync(join(t.worktree, ".cardume", "handoffs")).sort();
    assert.deepEqual(hs, ["01-planner.md", "02-builder.md", "03-reviewer.md", "04-builder.md"]);
    assert.match(readFileSync(join(t.worktree, ".cardume", "handoffs", "03-reviewer.md"), "utf8"), /## O que falta\n- cobrir o caso de lista vazia/, "o builder recebe o 'muda' pelo bastão");
    const evs = orch.store.eventsForTask("t-e2e");
    assert.deepEqual(evs.filter((e) => e.type === "papel").map((e) => e.role), ["planner", "builder", "reviewer", "builder"]);
    assert.ok(evs.some((e) => e.type === "veredito" && /^Revisão 1\/2 \(Nyx\): muda — 2 itens/.test(e.text)));
    assert.ok(evs.some((e) => e.type === "bastao" && /bastão: Nyx → Íris/.test(e.text)), "o 'muda' volta pelo bastão");

    // 3) liberar com valor + motivo e seguir: revisão 2 aprova → pronta pra revisar (portão)
    orch.store.patchSpec("t-e2e", { budgetUsd: 1, budgetHit: null, needsYou: null, budgetReleases: [{ usd: 0.5, reason: "falta a segunda revisão do Nyx", at: 1, capBefore: 0.5, capAfter: 1 }] });
    await orch.runTask("t-e2e");
    t = st(orch, "t-e2e");
    assert.equal(t.status, "review", "portão: pronta pra você aprovar");
    s = sp(orch, "t-e2e");
    assert.deepEqual(s.reviewRounds!.map((r) => r.verdict), ["muda", "aprova"]);
    assert.ok(!existsSync(join(t.worktree, ".cardume", "VEREDITO.md")) || /aprova/.test(readFileSync(join(t.worktree, ".cardume", "VEREDITO.md"), "utf8")));

    // 4) prova (mecânica) passa e o Relatório Starfork tem tudo
    const gate = await orch.verifyProofs("t-e2e", t, s);
    assert.ok(gate.ok, gate.reasons.join(" · "));
    const rep = await orch.reportFor("t-e2e");
    assert.match(rep, /\| mostra o total da lista \| provado — `evidence-t-e2e\.md` \|/);
    assert.match(rep, /\*\*Revisão:\*\* rodada 1 \(Nyx\) — muda \(2\) · rodada 2 \(Nyx\) — aprova/);
    // custo e liberações de teto não vão pro PR (pedido do dono, 08/10) — ficam só no app
    assert.doesNotMatch(rep, /Custo|teto|US\$/);
    assert.match(rep, /\*\*Versões:\*\* plano `vega@v1 · mock` · construção `iris@v1 · mock` · revisão `nyx@v1 · mock`$/m);
  } finally {
    orch.close();
    delete process.env.CARDUME_MOCK_VERDICTS; delete process.env.CARDUME_MOCK_PROVE;
  }
});

test("e2e mock: 'muda' na 2ª rodada para em 'precisa de você · rodadas'; 'mais uma rodada' volta pro builder; ilegível nunca aprova", async () => {
  const repo = gitRepo("rounds");
  const orch = new Orchestrator(repo);
  try {
    process.env.CARDUME_MOCK_VERDICTS = "muda,muda,aprova";
    await orch.createTask(kindSpec("t-r", "codigo", { budgetUsd: 10, autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto", planApproval: "auto" } }));
    await orch.runTask("t-r");
    let s = sp(orch, "t-r");
    assert.equal(st(orch, "t-r").status, "needs-you");
    assert.equal(s.needsYou?.kind, "rodadas");
    assert.match(s.needsYou!.text, /Uma 3ª rodada só com você/);
    assert.deepEqual(s.reviewRounds!.map((r) => r.verdict), ["muda", "muda"]);
    // a pessoa libera mais uma rodada: volta pro builder com o último "muda"
    orch.store.patchSpec("t-r", { needsYou: null, reviewExtra: true });
    await orch.runTask("t-r");
    s = sp(orch, "t-r");
    assert.equal(st(orch, "t-r").status, "review");
    assert.deepEqual(s.reviewRounds!.map((r) => r.verdict), ["muda", "muda", "aprova"]);
    assert.match(s.adjustment ?? "", /você liberou mais uma rodada/);
    assert.equal(s.reviewExtra, undefined, "o pedido foi consumido");

    process.env.CARDUME_MOCK_VERDICTS = "ilegivel";
    const repo2 = gitRepo("ilegivel");
    const o2 = new Orchestrator(repo2);
    try {
      await o2.createTask(kindSpec("t-i", "documento", { budgetUsd: 10, autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto", planApproval: "auto" } }));
      assert.deepEqual(sp(o2, "t-i").roles.map((r) => r.agentId), ["vega", "lumen", "nyx"]);
      await o2.runTask("t-i");
      assert.equal(st(o2, "t-i").status, "needs-you");
      assert.equal(sp(o2, "t-i").needsYou?.kind, "veredito");
      assert.equal(sp(o2, "t-i").reviewRounds![0].verdict, "ilegivel");
      assert.ok(o2.store.eventsForTask("t-i").some((e) => e.type === "papel" && e.role === "docs"), "Lumen escreveu");
    } finally { o2.close(); }
  } finally {
    orch.close();
    delete process.env.CARDUME_MOCK_VERDICTS;
  }
});

test("ajuste pedido pela pessoa (rework) abre um ciclo novo de revisão (as 2 rodadas valem de novo)", async () => {
  const repo = gitRepo("rework");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(kindSpec("t-w", "codigo", { budgetUsd: 10, autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto", planApproval: "auto" } }));
    await orch.runTask("t-w");
    assert.equal(sp(orch, "t-w").reviewRounds!.length, 1);
    orch.store.addInstruction("t-w", "troque o rótulo do total");
    await orch.reworkTask("t-w");
    assert.deepEqual(sp(orch, "t-w").reviewRounds!.map((r) => r.round), [1], "zerou e a nova revisão é a rodada 1");
  } finally { orch.close(); }
});
