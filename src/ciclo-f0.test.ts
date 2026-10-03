// node --test src/ciclo-f0.test.ts  (npm test)
// F0 da decisão da mesa (03/10): P7 agent_id estável em spec.roles/cost/event e P10 um evento por papel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG, resolveWorkflow } from "./config.ts";
import { Store } from "./store.ts";
import { rosterLine, runTag, upsertRoleRun } from "./lifecycle.ts";
import { bumpAgent } from "./agent-versions.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-f0-")));
const saved: Record<string, string | undefined> = {};
let home: { home: string; cleanup: () => void };

function gitRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}
export function mockSpec(id: string, roles = resolveWorkflow(DEFAULT_CONFIG, "feature", "mock")): TaskSpec {
  return {
    id, title: id, objective: "x", deliverables: ["fazer x"], requirements: [],
    scope: { owns: ["src"], offLimits: [] },
    autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
    engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no", roles,
  } as TaskSpec;
}

before(() => {
  for (const k of ["HOME", "USERPROFILE", "CARDUME_MOCK_SPEED", "CARDUME_MOCK_ROLE_COST_USD", "CARDUME_AUTOSUMMARY"]) saved[k] = process.env[k];
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

test("P7: os papéis do catálogo levam o agentId (id estável), e custo + eventos gravam agent_id", async () => {
  const repo = gitRepo("p7");
  const orch = new Orchestrator(repo);
  try {
    const spec = mockSpec("t-p7");
    assert.deepEqual(spec.roles.map((r) => r.agentId), ["vega", "iris", "nyx"]);
    await orch.createTask(spec);
    await orch.runTask("t-p7");
    const db = orch.store.db;
    const rows = db.prepare(`SELECT agent, agent_id, usd FROM cost WHERE task_id = 't-p7' ORDER BY id`).all() as { agent: string; agent_id: string; usd: number }[];
    assert.deepEqual(rows.map((r) => r.agent_id), ["vega", "iris", "nyx"]);
    const evIds = new Set((db.prepare(`SELECT DISTINCT agent_id FROM event WHERE task_id = 't-p7' AND agent_id IS NOT NULL`).all() as { agent_id: string }[]).map((r) => r.agent_id));
    assert.deepEqual([...evIds].sort(), ["iris", "nyx", "vega"]);
  } finally { orch.close(); }
});

test("P7: renomear o agente não muda a soma de custo dele (soma pelo agent_id)", async () => {
  const repo = gitRepo("rename");
  const orch = new Orchestrator(repo);
  try {
    const a = mockSpec("t-a");
    await orch.createTask(a);
    await orch.runTask("t-a");
    const before = orch.store.costByAgent("nyx");
    assert.ok(before > 0);
    // mesmo agente, nome novo (editado na ficha): a tarefa nova grava o MESMO agent_id
    const roles = resolveWorkflow(DEFAULT_CONFIG, "feature", "mock").map((r) => (r.agentId === "nyx" ? { ...r, name: "Nyx Revisora" } : r));
    const b = mockSpec("t-b", roles);
    await orch.createTask(b);
    await orch.runTask("t-b");
    assert.equal(Math.round(orch.store.costByAgent("nyx") * 100), Math.round(before * 200), "a soma dobrou: as duas tarefas contam pro mesmo agente");
    const byName = orch.store.db.prepare(`SELECT COUNT(DISTINCT agent) AS n FROM cost WHERE agent_id = 'nyx'`).get() as { n: number };
    assert.equal(byName.n, 2, "dois nomes, um agente");
  } finally { orch.close(); }
});

test("P7: banco antigo ganha as colunas na abertura e as linhas velhas ficam sem ficha (NULL)", () => {
  const dir = join(root, "old", ".cardume");
  execFileSync("mkdir", ["-p", dir]);
  const f = join(dir, "state.sqlite");
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE cost (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT, usd REAL NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL);
           CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, ok INTEGER);
           INSERT INTO cost (task_id, agent, role, usd, in_tok, out_tok, created_at) VALUES ('velha', 'Nyx', 'reviewer', 0.5, 1, 1, 1);`);
  db.close();
  const s = new Store(f);
  try {
    const r = s.db.prepare(`SELECT agent_id FROM cost WHERE task_id = 'velha'`).get() as { agent_id: string | null };
    assert.equal(r.agent_id, null);
    assert.equal(s.costByAgent("nyx"), 0, "não adivinha pelo nome");
    s.addEvent("velha", "Nyx", "note", "x", true, "reviewer", "nyx");
    assert.equal((s.db.prepare(`SELECT agent_id FROM event WHERE task_id='velha'`).get() as { agent_id: string }).agent_id, "nyx");
  } finally { s.close(); }
});

test("P10: um evento 'papel' por papel com skills@versão · agente@versão · motor, mesmo com retry", async () => {
  const repo = gitRepo("p10");
  const orch = new Orchestrator(repo);
  try {
    writeFileSync(join(repo, ".cardume", "skills.json"), JSON.stringify([{ name: "rodar-testes", description: "x" }]));
    bumpAgent(join(repo, ".cardume"), "nyx", { at: 1, change: "skill", what: "rodar-testes" }); // nyx → v2
    const spec = mockSpec("t-p10");
    await orch.createTask(spec);
    // o builder cai uma vez por queda de rede (retriable) e tenta de novo: o evento NÃO duplica
    const o = orch as unknown as { engineFor: (n: string, m: string | undefined, a: string) => unknown };
    const real = o.engineFor.bind(orch);
    let fails = 1;
    o.engineFor = (n, m, a) => {
      const e = real(n, m, a) as { run: (i: { role: string }) => AsyncIterable<unknown> };
      return { id: "mock", displayName: "mock", async *run(i: { role: string }) {
        if (i.role === "builder" && fails-- > 0) throw new Error("socket hang up");
        yield* e.run(i);
      } };
    };
    await orch.runTask("t-p10");
    const evs = orch.store.eventsForTask("t-p10").filter((e) => e.type === "papel");
    assert.deepEqual(evs.map((e) => e.role), ["planner", "builder", "reviewer"]);
    assert.equal(evs[2].text, "skills ativas: rodar-testes@v1 · nyx@v2 · mock");
    assert.equal(evs[0].text, "skills ativas: rodar-testes@v1 · vega@v1 · mock");
    const spec2 = JSON.parse(orch.store.getTask("t-p10")!.spec_json) as TaskSpec;
    assert.deepEqual(spec2.roleRuns!.map((r) => runTag(r)), ["vega@v1 · mock", "iris@v1 · mock", "nyx@v2 · mock"]);
    assert.equal(orch.store.getTask("t-p10")!.status, "review");
  } finally { orch.close(); }
});

test("P10: rosterLine sem skills e com modelo; upsertRoleRun troca a entrada do mesmo papel+agente", () => {
  assert.equal(rosterLine({ agentId: "nyx", name: "Nyx", version: 4, engine: "codex", skills: [] }), "skills ativas: nenhuma · nyx@v4 · codex");
  assert.equal(rosterLine({ agentId: "", name: "Íris", version: 1, engine: "claude", model: "sonnet", skills: ["a@v3", "b@v1"] }), "skills ativas: a@v3, b@v1 · Íris@v1 · claude · sonnet");
  const a = { role: "reviewer", agentId: "nyx", name: "Nyx", version: 1, engine: "claude", skills: [], at: 1 };
  const l = upsertRoleRun(upsertRoleRun([], a), { ...a, version: 2, at: 2 });
  assert.equal(l.length, 1);
  assert.equal(l[0].version, 2);
});
