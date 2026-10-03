// node --test src/agentes-f5.test.ts  (npm test)
// F5 da decisão da mesa (03/10): P14 política da organização (aplicada pelo motor no `cardume new`), P15 testar numa
// amostra (só o revisor, cópia descartável, nada grava na tarefa antiga, para no teto) e a persona sugerida pela retro
// reaberta com a trava da Júlia (n ≥ 10 tarefas no portão na versão atual).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store.ts";
import { applyOrgPolicy, orgAgentPolicy, policyActive, policyRules, teamPolicyIssues } from "./org-policy.ts";
import { itemText, parseRetro, pendingId, readPending, retroPrompt, type RetroCtx } from "./learn.ts";
import { oldVerdict, samplesFile, versionOfRoster } from "./amostra.ts";
import { starforkReport } from "./lifecycle.ts";
import type { TaskSpec } from "./types.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only" : false };
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const gold = (f: string) => JSON.parse(readFileSync(new URL(`../tests/fixtures/ciclo-golden/${f}`, import.meta.url), "utf8"));
const CAT = [
  { id: "vega", name: "Vega", role: "planner", engine: "claude" },
  { id: "iris", name: "Íris", role: "builder", engine: "claude", model: "opus" },
  { id: "nyx", name: "Nyx", role: "reviewer", engine: "claude", model: "opus", persona: "Você revisa correção e casos de borda." },
];
const spec = (o: Partial<TaskSpec> = {}): TaskSpec => ({
  id: "t", title: "T", agent: "Íris", objective: "o", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] },
  autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "ask" }, engine: "claude",
  roles: [{ role: "planner", agentId: "vega", name: "Vega", engine: "claude" }, { role: "builder", agentId: "iris", name: "Íris", engine: "claude", model: "opus" }],
  ...o,
} as TaskSpec);

// ---------------------------------------------------------------- P14: política da organização

test("golden politica.json: normalização, regras em frase e o que a equipe fere (TS ≡ app)", () => {
  const g = gold("politica.json");
  for (const c of g.policy) { assert.deepEqual(orgAgentPolicy(c.raw), c.expected); assert.deepEqual(policyRules(c.expected), c.rules); }
  for (const c of g.issues) assert.deepEqual(teamPolicyIssues(c.roles, c.policy), c.expected);
  assert.ok(g.issues.some((c: { expected: unknown[] }) => c.expected.length === 2) === false, "uma equipe nunca fere as duas ao mesmo tempo (sem revisor ≠ revisor igual)");
  assert.ok(g.issues.some((c: { expected: unknown[] }) => c.expected.length === 1));
});

test("política vazia não muda nada; lixo vira 'nada exigido'", () => {
  const p = orgAgentPolicy({ minRequirements: 3 });
  assert.equal(policyActive(p), false);
  const s = spec({ autoPr: "auto", budgetUsd: 9 });
  const r = applyOrgPolicy(s, p, CAT);
  assert.equal(r.blocked, ""); assert.deepEqual(r.notes, []);
  assert.equal(r.spec.autoPr, "auto"); assert.equal(r.spec.budgetUsd, 9); assert.equal(r.spec.orgPolicy, undefined);
});

test("applyOrgPolicy: revisor que falta entra do catálogo, teto máximo corta, portão tira o PR automático e põe prova", () => {
  const p = orgAgentPolicy({ agentes: { portao: true, tetoMaxUsd: 3, revisor: true, revisorDiferente: true } });
  const s0 = spec({ autoPr: "auto", budgetUsd: 8 });
  const r = applyOrgPolicy(s0, p, CAT);
  assert.equal(r.blocked, "");
  assert.deepEqual(r.spec.roles.map((x) => x.role), ["planner", "builder", "reviewer"]);
  assert.equal(r.spec.roles[2].model, "sonnet", "revisor no Claude igual ao builder → outro modelo");
  assert.equal(r.spec.budgetUsd, 3); assert.equal(r.spec.autoPr, "ask");
  assert.ok(r.spec.artifacts?.some((a) => a.kind === "proof"));
  assert.deepEqual(r.spec.orgPolicy?.rules, policyRules(p));
  assert.ok(r.notes.some((n) => /pôs Nyx pra revisar/.test(n)) && r.notes.some((n) => /US\$ 3,00/.test(n)));
  assert.equal(s0.roles.length, 2, "a spec de entrada não é mutada");
  // sem teto escolhido: vale o máximo da org; teto menor que o máximo fica
  assert.equal(applyOrgPolicy(spec(), p, CAT).spec.budgetUsd, 3);
  assert.equal(applyOrgPolicy(spec({ budgetUsd: 1.5 }), p, CAT).spec.budgetUsd, 1.5);
});

test("applyOrgPolicy: sem revisor no catálogo ou revisor Codex igual ao builder → recusa em palavra", () => {
  const p = orgAgentPolicy({ agentes: { revisor: true, revisorDiferente: true } });
  assert.match(applyOrgPolicy(spec(), p, CAT.filter((a) => a.role !== "reviewer")).blocked, /não tem nenhum agente revisor/);
  const codex = spec({ roles: [{ role: "builder", agentId: "iris", name: "Íris", engine: "codex" }, { role: "reviewer", agentId: "nyx", name: "Nyx", engine: "codex" }] });
  assert.match(applyOrgPolicy(codex, p, CAT).blocked, /motor ou modelo diferente.*Nyx e Íris/);
});

test("Relatório do PR leva a política da organização (≡ cicloReport do app pelo golden)", () => {
  const c = gold("relatorio.json").cases.find((x: { input: { orgPolicy?: string[] } }) => x.input.orgPolicy);
  assert.ok(c, "caso com política no golden");
  assert.equal(starforkReport(c.input), c.expected);
  assert.match(c.expected, /\*\*Política da organização:\*\* toda tarefa passa pelo portão/);
  assert.match(c.expected, /regra com \\\| barra/);
});

test("cardume new --org-policy: recusa a criação quando a política não dá pra cumprir (nada de worktree)", POSIX, () => {
  const root = tmp("sf-f5-new-");
  try {
    const r = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", r]);
    writeFileSync(join(r, "cardume.config.json"), JSON.stringify({ agents: CAT.filter((a) => a.role !== "reviewer"), workflows: [] }));
    execFileSync("git", ["-C", r, "add", "."]); execFileSync("git", ["-C", r, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"]);
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    let err = "";
    try {
      execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "new", "--repo", r, "--title", "X", "--engine", "mock", "--approve", "auto", "--task-kind", "codigo", "--no-start", "--org-policy", JSON.stringify({ revisor: true })], { stdio: "pipe", env: { ...process.env, HOME: join(root, "home") } });
    } catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? ""); }
    assert.match(err, /exige um revisor/);
    assert.ok(!existsSync(join(r, ".cardume", "worktrees")) || readdirSync(join(r, ".cardume", "worktrees")).length === 0, "nenhuma worktree nasceu");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- persona sugerida (trava n ≥ 10)

const ctx0: RetroCtx = { title: "T", objective: "o", requirements: [], corrections: [], reworks: 0, reviewSummary: "", events: [], brainCatalog: "", learnedSkills: [] };

test("retroPrompt: sem agente elegível continua 'NUNCA proponha persona'; com elegível, só ele e a persona atual", () => {
  assert.match(retroPrompt(ctx0), /NUNCA proponha mudar a persona/);
  assert.ok(!/personas/.test(retroPrompt(ctx0)));
  const p = retroPrompt({ ...ctx0, personaAgents: [{ agentId: "nyx", name: "Nyx", n: 12, persona: "Você revisa correção." }] });
  assert.ok(!/NUNCA proponha mudar a persona/.test(p));
  assert.match(p, /nyx \(Nyx, 12 tarefas na versão atual\)/);
  assert.match(p, /### Persona atual de nyx\nVocê revisa correção\./);
  assert.match(p, /"personas":\[\{"agente"/);
  assert.match(p, /Nunca mude modelo nem motor/);
});

test("parseRetro: persona precisa de dono, texto e porquê; no máximo 1; itemText e pendingId cobrem a persona", () => {
  const r = parseRetro(JSON.stringify({ notas: [], skills: [], personas: [
    { agente: "nyx", persona: "Você revisa correção, casos de borda e sempre roda os testes.", porque: "a revisão aprovou duas vezes sem rodar os testes" },
    { agente: "iris", persona: "Outra persona longa o bastante pra valer.", porque: "segunda proposta" },
    { persona: "sem dono nenhum, mas longa o bastante", porque: "sem dono" } ] }));
  assert.equal(r.personas.length, 1);
  assert.equal(r.personas[0].dono, "nyx");
  assert.equal(parseRetro(JSON.stringify({ personas: [{ agente: "nyx", persona: "curta", porque: "x" }] })).personas.length, 0);
  assert.equal(parseRetro("{}").personas.length, 0);
  const it = { kind: "persona", taskId: "t", agente: "nyx", persona: { texto: "Você revisa tudo com calma e cuidado.", porque: "pressa" } };
  assert.match(itemText(it), /pressa/);
  assert.notEqual(pendingId(it), pendingId({ ...it, agente: "iris" }));
});

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  return fn().finally(() => { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

function seedGate(store: Store, agentId: string, v: number, n: number, status = "merged"): void {
  for (let i = 0; i < n; i++) {
    const id = `g-${agentId}-${v}-${status}-${i}`;
    store.db.prepare("INSERT INTO task (id,title,objective,status,agent,branch,worktree,base,engine,spec_json,created_at) VALUES (?,?,'o',?,'x','b','w','main','claude','{}',?)").run(id, id, status, i);
    store.db.prepare("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?,?,?,?,?,?,?,?)").run(id, "Nyx", "reviewer", 1, "papel", `skills ativas: nenhuma · ${agentId}@v${v} · claude`, 1, agentId);
    store.db.prepare("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?,?,?,?,?,?,?,?)").run(id, "Nyx", "reviewer", 2, "papel", `skills ativas: nenhuma · ${agentId}@v9 · claude`, 1, agentId); // retry não muda a versão
  }
}

test("agentVersionGateCount: só tarefas no portão, na versão do 1º papel", () => {
  const d = tmp("sf-f5-gate-");
  try {
    const store = new Store(join(d, "state.sqlite"));
    seedGate(store, "nyx", 1, 7); seedGate(store, "nyx", 1, 4, "running"); seedGate(store, "nyx", 2, 3); seedGate(store, "nyxa", 1, 5);
    assert.equal(store.agentVersionGateCount("nyx", 1), 7);
    assert.equal(store.agentVersionGateCount("nyx", 2), 3);
    assert.equal(store.agentVersionGateCount("nyx", 9), 0, "a versão do retry não conta");
    assert.equal(store.agentVersionGateCount("", 1), 0);
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

async function retroWithPersona(gateN: number) {
  const root = tmp("sf-f5-retro-");
  const r = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  writeFileSync(join(r, "cardume.config.json"), JSON.stringify({ agents: CAT, workflows: [] }));
  const home = join(root, "home");
  mkdirSync(join(home, ".constellation"), { recursive: true });
  writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "auto" }));
  const ans = join(root, "answer.json");
  const prompt = join(root, "prompt.txt");
  writeFileSync(ans, JSON.stringify({ notas: [], skills: [], personas: [{ agente: "nyx", persona: "Você revisa correção e casos de borda. Sempre roda os testes antes do veredito.", porque: "aprovou sem rodar os testes duas vezes" }] }));
  const fake = join(root, "claude-falso.sh");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${prompt}"\ncat "${ans}"\n`);
  chmodSync(fake, 0o755);
  const orch = new Orchestrator(r);
  try {
    seedGate(orch.store, "nyx", 1, gateN);
    orch.store.createTask({ id: "t-p", title: "Agenda", objective: "o", requirements: [], agent: "Íris", engine: "claude",
      roles: [{ role: "builder", agentId: "iris", name: "Íris", engine: "claude" }, { role: "reviewer", agentId: "nyx", name: "Nyx", engine: "claude", model: "sonnet" }] } as unknown as TaskSpec, "b", r, "main");
    orch.store.addEvent("t-p", "Nyx", "done", "aprovei", true);
    await withEnv({ HOME: home, CARDUME_CLAUDE: fake, CARDUME_AUX_TIMEOUT_MS: "5000" }, () => (orch as unknown as { retroTask(id: string): Promise<void> }).retroTask("t-p"));
    return { q: readPending(join(r, ".cardume")), prompt: existsSync(prompt) ? readFileSync(prompt, "utf8") : "", cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } finally { orch.close(); }
}

test("retro: com 10 tarefas no portão na versão atual, a persona sugerida vai pra FILA (nunca auto) com o texto de antes", POSIX, async () => {
  const res = await retroWithPersona(10);
  try {
    assert.match(res.prompt, /nyx \(Nyx, 10 tarefas na versão atual\)/);
    assert.equal(res.q.length, 1, "o modo auto não aplica persona (K3)");
    const it = res.q[0];
    assert.equal(it.kind, "persona"); assert.equal(it.agente, "nyx"); assert.equal(it.papel, "reviewer");
    assert.equal(it.persona?.antes, "Você revisa correção e casos de borda.");
    assert.match(String(it.persona?.texto), /Sempre roda os testes/);
    assert.ok(!("dono" in (it.persona as object)));
  } finally { res.cleanup(); }
});

test("retro: com 9 tarefas (abaixo da trava), nada de persona — nem no prompt, nem na fila", POSIX, async () => {
  const res = await retroWithPersona(9);
  try {
    assert.match(res.prompt, /NUNCA proponha mudar a persona/);
    assert.equal(res.q.filter((x) => x.kind === "persona").length, 0);
  } finally { res.cleanup(); }
});

// ---------------------------------------------------------------- P15: testar numa amostra

test("oldVerdict/versionOfRoster: o 1º veredito do agente na tarefa e a versão do 1º papel", () => {
  assert.equal(versionOfRoster("skills ativas: a@v1 · nyx@v4 · codex"), 4);
  assert.equal(versionOfRoster("lixo"), null);
  const evs = [{ type: "papel", agent_id: "nyx", text: "skills ativas: nenhuma · nyx@v3 · claude", ok: 1 }, { type: "papel", agent_id: "nyx", text: "skills ativas: nenhuma · nyx@v4 · claude", ok: 1 },
    { type: "veredito", agent_id: "nyx", text: "Revisão 1/2 (Nyx): muda — 2 itens\n- a\n- b", ok: 0 }];
  assert.deepEqual(oldVerdict({ reviewRounds: [] }, evs, "nyx"), { v: 3, kind: "muda", items: ["a", "b"] });
  assert.deepEqual(oldVerdict({ reviewRounds: [{ round: 1, verdict: "aprova", items: [], at: 1, reviewer: "Nyx", agentId: "nyx" }] }, evs, "nyx"), { v: 3, kind: "aprova", items: [] });
  assert.deepEqual(oldVerdict({}, [], "nyx"), { v: null, kind: null, items: [] });
});

async function sampleRepo(root: string) {
  const r = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  const git = (...a: string[]) => execFileSync("git", ["-C", r, "-c", "user.email=a@b", "-c", "user.name=a", ...a]);
  writeFileSync(join(r, "a.txt"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "feat/agenda"); writeFileSync(join(r, "a.txt"), "1\n2\n"); git("commit", "-qam", "agenda"); git("checkout", "-q", "main");
  writeFileSync(join(r, "cardume.config.json"), JSON.stringify({ agents: [{ id: "iris", name: "Íris", role: "builder", engine: "mock" }, { id: "nyx", name: "Nyx", role: "reviewer", engine: "mock", persona: "Você revisa." }], workflows: [] }));
  return r;
}

test("sampleReview: só a revisão, numa worktree descartável — a tarefa antiga não ganha evento nem custo; resultado guardado", POSIX, async () => {
  const root = tmp("sf-f5-amostra-");
  try {
    const r = await sampleRepo(root);
    const orch = new Orchestrator(r);
    try {
      orch.store.createTask({ id: "t-a", title: "Remarcar aula", objective: "o", requirements: ["botão"], agent: "Íris", engine: "mock", taskKind: "codigo",
        scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "ask" },
        roles: [{ role: "builder", agentId: "iris", name: "Íris", engine: "mock" }, { role: "reviewer", agentId: "nyx", name: "Nyx", engine: "mock" }],
        reviewRounds: [{ round: 1, verdict: "muda", items: ["faltou o caso vazio"], at: 1, reviewer: "Nyx", agentId: "nyx" }] } as unknown as TaskSpec, "feat/agenda", join(r, "nao-existe"), "main");
      orch.store.addEvent("t-a", "Nyx", "papel", "skills ativas: nenhuma · nyx@v1 · mock", true, "reviewer", "nyx");
      const evBefore = orch.store.eventsForTask("t-a").length;
      const res = await withEnv({ CARDUME_MOCK_SPEED: "50", CARDUME_MOCK_VERDICTS: "aprova" }, () => orch.sampleReview("t-a", "nyx", 1));
      assert.equal(res.old.kind, "muda"); assert.equal(res.old.v, 1); assert.deepEqual(res.old.items, ["faltou o caso vazio"]);
      assert.equal(res.now.kind, "aprova"); assert.equal(res.now.v, 1);
      assert.equal(res.stopped, false);
      assert.equal(orch.store.eventsForTask("t-a").length, evBefore, "nenhum evento na tarefa antiga");
      assert.equal(orch.store.taskSpend("t-a"), 0, "nenhum custo na tarefa antiga");
      assert.equal(orch.store.getTask("t-a")?.spec_json.includes("amostra"), false);
      const saved = JSON.parse(readFileSync(samplesFile(join(r, ".cardume")), "utf8"));
      assert.equal(saved[0].taskId, "t-a"); assert.equal(saved[0].now.kind, "aprova");
      assert.ok(!existsSync(join(r, ".cardume", "amostras")) || readdirSync(join(r, ".cardume", "amostras")).length === 0, "a cópia descartável saiu");
      assert.ok(!execFileSync("git", ["-C", r, "worktree", "list"]).toString().includes("amostras"), "nada sobra no git worktree list");
      // teto: o custo do turno passa do teto → para e diz
      const cap = await withEnv({ CARDUME_MOCK_SPEED: "50", CARDUME_MOCK_VERDICTS: "muda", CARDUME_MOCK_ROLE_COST_USD: "0.5" }, () => orch.sampleReview("t-a", "nyx", 0.2));
      assert.equal(cap.stopped, true);
      assert.ok(cap.usd > 0.2);
      // só o revisor; agente fora do catálogo; branch apagada
      await assert.rejects(orch.sampleReview("t-a", "iris", 1), /só pro revisor/);
      await assert.rejects(orch.sampleReview("t-a", "zzz", 1), /catálogo/);
      await assert.rejects(orch.sampleReview("t-a", "nyx", 0), /teto/);
      execFileSync("git", ["-C", r, "branch", "-qD", "feat/agenda"]);
      await assert.rejects(orch.sampleReview("t-a", "nyx", 1), /branch dessa tarefa não existe mais/);
    } finally { orch.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cardume sample-review --json: erro vem em JSON (o app mostra a frase)", POSIX, () => {
  const root = tmp("sf-f5-cli-");
  try {
    const r = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", r]);
    mkdirSync(join(r, ".cardume"), { recursive: true });
    new Store(join(r, ".cardume", "state.sqlite")).close();
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    let out = "";
    try { execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "sample-review", "nada", "--agent", "nyx", "--cap", "1", "--repo", r, "--json"], { stdio: "pipe" }); }
    catch (e) { out = String((e as { stdout?: Buffer }).stdout ?? ""); }
    assert.deepEqual(JSON.parse(out.trim().split("\n").pop()!), { error: "essa tarefa não existe mais neste projeto" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- correções da revisão
test("cardume new --org-policy (caminho feliz): revisor entra, teto da org, PR pergunta, prova, regras e notas na tarefa", POSIX, () => {
  const root = tmp("sf-f5-new-ok-");
  try {
    const r = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", r]);
    writeFileSync(join(r, "cardume.config.json"), JSON.stringify({ agents: [...CAT.map((a) => ({ ...a, engine: "mock", ...(a.id === "nyx" ? { model: "haiku" } : {}) }))], workflows: [{ id: "so-iris", name: "Só Íris", steps: ["iris"] }] }));
    execFileSync("git", ["-C", r, "add", "."]); execFileSync("git", ["-C", r, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"]);
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "new", "--id", "t-pol", "--repo", r, "--title", "X", "--engine", "mock", "--approve", "auto", "--workflow", "so-iris", "--auto-pr", "auto", "--no-start",
      "--org-policy", JSON.stringify({ agentes: { portao: true, tetoMaxUsd: 2, revisor: true, revisorDiferente: true } })], { stdio: "pipe", env: { ...process.env, HOME: join(root, "home") } });
    const st = new Store(join(r, ".cardume", "state.sqlite"));
    try {
      const sp = JSON.parse(st.getTask("t-pol")!.spec_json) as TaskSpec;
      assert.deepEqual(sp.roles.map((x) => x.role), ["builder", "reviewer"]);
      assert.equal(sp.budgetUsd, 2); assert.equal(sp.autoPr, "ask");
      assert.ok(sp.artifacts?.some((a) => a.kind === "proof"));
      assert.equal(sp.orgPolicy?.tetoMaxUsd, 2); assert.equal(sp.orgPolicy?.portao, true);
      assert.ok(sp.orgPolicy?.rules.some((x) => /portão/.test(x)));
      const notes = st.eventsForTask("t-pol").filter((e) => e.type === "note").map((e) => e.text);
      assert.ok(notes.some((n) => /pôs Nyx pra revisar/.test(n)), notes.join(" | "));
    } finally { st.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("piloto automático: portão obrigatório da org recusa antes de criar qualquer coisa; política vale nas tarefas", POSIX, async () => {
  const { runAutopilot, AP_GATE_POLICY } = await import("./autopilot.ts");
  const root = tmp("sf-f5-ap-");
  try {
    const dir = join(root, "novo");
    await assert.rejects(runAutopilot({ dir, idea: "um app", orgPolicy: { agentes: { portao: true } }, log: () => {} }), (e: Error) => e.message === AP_GATE_POLICY);
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, "nada criado");
    const src = readFileSync(new URL("./autopilot.ts", import.meta.url), "utf8");
    assert.match(src, /const r = applyOrgPolicy\(spec, s\.orgPolicy,/);
    assert.match(src, /if \(r\.blocked\) throw new Error\(r\.blocked\);/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sampleReview: o motor falhar no meio não deixa a cópia descartável pra trás", POSIX, async () => {
  const root = tmp("sf-f5-amostra-fail-");
  try {
    const r = await sampleRepo(root);
    writeFileSync(join(r, "cardume.config.json"), JSON.stringify({ agents: [{ id: "nyx", name: "Nyx", role: "reviewer", engine: "claude" }], workflows: [] }));
    const fake = join(root, "claude-quebra.sh");
    writeFileSync(fake, "#!/bin/sh\necho 'boom' >&2\nexit 3\n"); chmodSync(fake, 0o755);
    const orch = new Orchestrator(r);
    try {
      orch.store.createTask({ id: "t-f", title: "T", objective: "o", requirements: [], deliverables: [], agent: "Nyx", engine: "claude", scope: { owns: [], offLimits: [] },
        autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "ask" }, roles: [] } as unknown as TaskSpec, "feat/agenda", join(r, "x"), "main");
      try { await withEnv({ CARDUME_CLAUDE: fake, CARDUME_IDLE_MS: "3000" }, () => orch.sampleReview("t-f", "nyx", 1)); } catch { /* falhar é aceitável; sobrar worktree não */ }
      assert.ok(!existsSync(join(r, ".cardume", "amostras")) || readdirSync(join(r, ".cardume", "amostras")).length === 0, "a cópia saiu");
      assert.ok(!execFileSync("git", ["-C", r, "worktree", "list"]).toString().includes("amostras"));
    } finally { orch.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
