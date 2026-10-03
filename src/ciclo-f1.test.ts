// node --test src/ciclo-f1.test.ts  (npm test)
// F1 da decisão da mesa (03/10): P6 teto sempre ligado (pausa a 80%, liberar com valor + motivo, retro dentro do
// teto) e P11 versões de agente/skill com "voltar pro jeito antigo" byte a byte (fixture dourado ≡ Rust).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.ts";
import { DEFAULT_CONFIG, resolveWorkflow } from "./config.ts";
import { capCheck, effectiveCap, parseRelease, releaseCheck } from "./lifecycle.ts";
import { bumpAgent, readAgentVersions, readSkillHistory, revertSkill, writeSkillVersion } from "./agent-versions.ts";
import { applySkill, revertLearnedSkill } from "./learn.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-f1-")));
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
const spec = (id: string, budgetUsd?: number): TaskSpec => ({
  id, title: id, objective: "x", deliverables: ["fazer x"], requirements: [],
  scope: { owns: ["src"], offLimits: [] },
  autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
  engine: "mock", agent: "Íris", light: true, base: "main", autoPr: "no", budgetUsd,
  roles: resolveWorkflow(DEFAULT_CONFIG, "feature", "mock"),
}) as TaskSpec;

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

// ---------------------------------------------------------------- P6

test("golden teto.json: capCheck, effectiveCap, parseRelease e releaseCheck (≡ app/src/js/60-ciclo.js)", () => {
  const g = gold("teto.json");
  for (const [s, c, e] of g.capCheck) assert.equal(capCheck(s, c), e, `${s}/${c}`);
  for (const [t, st, e] of g.effectiveCap) assert.equal(effectiveCap(t, st), e, `${t}/${st}`);
  for (const [t, e] of g.parseRelease) {
    const r = parseRelease(t);
    assert.equal(r.ok, e.ok, t);
    if (e.ok && r.ok) { assert.equal(r.usd, e.usd, t); assert.equal(r.reason, e.reason, t); }
    if (!r.ok) assert.match(r.why, /\S/, "erro em palavra");
  }
  for (const [u, t, e] of g.releaseCheck) {
    const r = releaseCheck(u, t);
    assert.equal(r.ok, e.ok, `${u}/${t}`);
    if (e.ok && r.ok) { assert.equal(r.usd, e.usd); assert.equal(r.reason, e.reason); }
  }
});

test("P6: a 80% do teto a tarefa para em 'precisa de você' ANTES da próxima etapa; liberar com valor+motivo retoma", async () => {
  const repo = gitRepo("cap");
  const orch = new Orchestrator(repo);
  try {
    // 3 papéis a US$ 0,10 cada, teto 0,20: antes do 3º (revisor) já gastou 0,20 ≥ 0,16 (80%)
    await orch.createTask(spec("t-cap", 0.2));
    // antes do 2º papel: 0,10 < 0,16 → segue; antes do 3º: 0,20 → pausa
    await orch.runTask("t-cap");
    let t = orch.store.getTask("t-cap")!;
    assert.equal(t.status, "needs-you");
    assert.equal(t.done_roles, 2, "planner e builder rodaram; o revisor NÃO começou");
    let sp = JSON.parse(t.spec_json) as TaskSpec;
    assert.equal(sp.needsYou?.kind, "teto");
    assert.equal(sp.budgetHit?.mode, "etapa");
    assert.match(sp.needsYou!.text, /US\$ 0,20 de US\$ 0,20 \(100% do teto\) — parei antes de Nyx revisar/);
    assert.ok(!orch.store.eventsForTask("t-cap").some((e) => e.role === "reviewer" && e.type === "papel"));
    // ▶ sem liberar: continua parada (o gasto segue ≥ 80%)
    await orch.runTask("t-cap");
    assert.equal(orch.store.getTask("t-cap")!.status, "needs-you");
    // a pessoa libera US$ 1 com motivo (o app grava assim — 60-ciclo/cicloRelease) e retoma
    const r = releaseCheck("1", "falta a revisão do Nyx");
    assert.ok(r.ok);
    orch.store.patchSpec("t-cap", { budgetUsd: 1.2, budgetHit: null, needsYou: null, budgetReleases: [{ usd: 1, reason: r.ok ? r.reason : "", at: 1, capBefore: 0.2, capAfter: 1.2 }] });
    await orch.runTask("t-cap");
    t = orch.store.getTask("t-cap")!;
    assert.equal(t.status, "review");
    sp = JSON.parse(t.spec_json) as TaskSpec;
    assert.equal(sp.budgetReleases?.[0].reason, "falta a revisão do Nyx", "o motivo fica na spec (vai pro PR)");
  } finally { orch.close(); }
});

test("P6: tarefa sem teto próprio herda o padrão (nunca 'sem teto') e grava o teto que valeu", async () => {
  const repo = gitRepo("default-cap");
  writeFileSync(join(home.home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "desligado", costCap: 0.15 }));
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(spec("t-def", 0)); // 0 = "sem teto" antigo: não desliga mais
    await orch.runTask("t-def");
    const t = orch.store.getTask("t-def")!;
    assert.equal(t.status, "needs-you");
    assert.equal((JSON.parse(t.spec_json) as TaskSpec).budgetUsd, 0.15);
  } finally {
    orch.close();
    writeFileSync(join(home.home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "desligado" }));
  }
});

test("P6: a retro roda dentro do teto — com 80% gasto ela é pulada com aviso em palavra (sem chamar IA)", async () => {
  const repo = gitRepo("retro");
  writeFileSync(join(home.home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "sugerir" }));
  const orch = new Orchestrator(repo);
  try {
    // 0,30 gasto no fim, teto 0,35 (80% = 0,28): os 3 papéis passam, a retro não
    await orch.createTask(spec("t-retro", 0.35));
    await orch.runTask("t-retro");
    assert.equal(orch.store.getTask("t-retro")!.status, "review");
    let ev;
    for (let i = 0; i < 40 && !(ev = orch.store.eventsForTask("t-retro").find((e) => e.type === "retro")); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(ev, "evento da retro");
    assert.match(ev!.text, /^retro pulada: a tarefa já usou US\$ 0,30 de US\$ 0,35/);
  } finally {
    orch.close();
    writeFileSync(join(home.home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "desligado" }));
  }
});

// ---------------------------------------------------------------- P11

test("golden versoes.json: versões de skill/agente e 'voltar' byte a byte (≡ agent_versions.rs)", () => {
  const d = mkdtempSync(join(root, "gv-"));
  const cd = join(d, ".cardume"), sroot = join(d, ".claude", "skills");
  for (const st of gold("versoes.json").steps) {
    if (st.op === "write") assert.equal(writeSkillVersion(cd, sroot, st.name, st.content, { at: st.at, action: st.action, agente: st.agente }), st.result);
    if (st.op === "legacy") { mkdirSync(join(sroot, st.name), { recursive: true }); writeFileSync(join(sroot, st.name, "SKILL.md"), st.content); }
    if (st.op === "revert") assert.deepEqual(revertSkill(cd, sroot, st.name, st.reason, st.at), st.result);
    if (st.op === "agent") assert.equal(bumpAgent(cd, st.agentId, { at: st.at, change: st.change, what: st.what, persona: st.persona, before: st.before }), st.result);
    if (st.name) {
      const md = join(sroot, st.name, "SKILL.md");
      const hd = join(cd, "aprendizado", "historico", st.name);
      assert.equal(existsSync(md) ? readFileSync(md, "utf8") : null, st.expect.skill, `${st.op} ${st.name}`);
      if (st.expect.skill !== null) assert.ok(readFileSync(md).equals(Buffer.from(st.expect.skill, "utf8")), "byte a byte");
      assert.deepEqual(readSkillHistory(cd, st.name), st.expect.history);
      assert.deepEqual(existsSync(hd) ? readdirSync(hd).filter((f) => f !== "index.json").sort() : [], st.expect.files);
    } else assert.deepEqual(readAgentVersions(cd, st.agentId), st.expect.agent);
  }
});

test("P11: aceitar skill versiona; 'voltar pro jeito antigo' restaura byte a byte e o agente dono ganha versão", () => {
  const d = gitRepo("revert");
  const cd = join(d, ".cardume");
  const sk = (corpo: string, acao: "criar" | "atualizar") => ({ acao, nome: "rodar-testes", descricao: "Use ao validar", corpo, porque: "x" });
  const r1 = applySkill(d, cd, sk("## Passo a passo\nnpm test", "criar"), "t1", join(d, "home"), 1);
  const v1 = readFileSync(join(d, ".claude", "skills", "rodar-testes", "SKILL.md"));
  const r2 = applySkill(d, cd, sk("## Passo a passo\nnpm test && lint", "atualizar"), "t2", join(d, "home"), 2);
  assert.deepEqual([r1.version, r2.version], [1, 2]);
  // marca o agente dono na versão atual (o aceite de item com `agente`, no app, faz isso)
  const h = readSkillHistory(cd, "rodar-testes")!;
  h.versions[h.versions.length - 1].agente = "nyx";
  writeFileSync(join(cd, "aprendizado", "historico", "rodar-testes", "index.json"), JSON.stringify(h));
  const r = revertLearnedSkill(d, cd, "rodar-testes", "a lint quebra no CI", 3);
  assert.equal(r.action, "restaurada");
  assert.ok(readFileSync(join(d, ".claude", "skills", "rodar-testes", "SKILL.md")).equals(v1), "byte a byte");
  assert.equal(r.agentVersion, 2);
  assert.equal(readAgentVersions(cd, "nyx").versions[0].change, "voltar");
  assert.equal(readSkillHistory(cd, "rodar-testes")!.versions.at(-1)!.reason, "a lint quebra no CI");
  // a 1ª versão (recém-criada) não tem anterior: voltar ARQUIVA (move) e tira do skills.json
  applySkill(d, cd, { acao: "criar", nome: "outra-skill", descricao: "Use quando precisar", corpo: "## Passo a passo\nfaça", porque: "x" }, "t3", join(d, "home"), 4);
  const a = revertLearnedSkill(d, cd, "outra-skill", "não serve aqui", 5);
  assert.equal(a.action, "arquivada");
  assert.ok(!existsSync(join(d, ".claude", "skills", "outra-skill", "SKILL.md")));
  assert.ok(existsSync(join(cd, "aprendizado", "historico", "outra-skill", "arquivada.md")), "nunca apaga");
  assert.ok(!JSON.parse(readFileSync(join(cd, "skills.json"), "utf8")).some((s: { name: string }) => s.name === "outra-skill"));
  assert.throws(() => revertLearnedSkill(d, cd, "outra-skill", "de novo", 6), /não tem versão pra voltar/);
});

test("K3: no modo auto, item com agente dono NÃO é aplicado — vai pra fila", async () => {
  // a regra mora no retroTask; aqui a fila: appendPending aceita o campo agente
  const { appendPending, readPending } = await import("./learn.ts");
  const d = mkdtempSync(join(root, "k3-"));
  appendPending(d, [{ kind: "nota", taskId: "t", taskTitle: "T", agente: "lumen", papel: "docs", nota: { title: "Citar fonte", type: "regra", tags: [], body: "sempre com link e data" } }]);
  assert.equal(readPending(d)[0].agente, "lumen");
});
