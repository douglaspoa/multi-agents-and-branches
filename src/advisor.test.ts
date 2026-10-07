// node --test src/advisor.test.ts  (npm test)
// CONSELHEIRO (advisor do Claude Code): args por motor/versão/conselheiro, pares recusados, DeepSeek desliga, a
// retomada (--resume) mantém, evento de consulta e a parte do custo. O "claude" é um script FALSO — nenhuma IA real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisorArgs, advisorCostOf, advisorEventOf, advisorNorm, advisorPair, cliVersionOk, modelFamily } from "./advisor.ts";
import { ClaudeEngine, mapLine } from "./engine/claude.ts";
import type { AgentEvent } from "./engine/types.ts";

const SET = (m: string) => ["--settings", JSON.stringify({ advisorModel: m })];

test("normaliza: só opus|fable; o resto = desligado", () => {
  assert.equal(advisorNorm("Opus"), "opus");
  assert.equal(advisorNorm(" fable "), "fable");
  for (const v of ["", "off", "sonnet", null, undefined, 3]) assert.equal(advisorNorm(v), null);
});

test("família/versão do modelo", () => {
  assert.deepEqual(modelFamily("claude-opus-4-8"), { fam: "opus", ver: 4.8 });
  assert.deepEqual(modelFamily("claude-haiku-4-5-20251001"), { fam: "haiku", ver: 4.5 });
  assert.deepEqual(modelFamily("claude-sonnet-5"), { fam: "sonnet", ver: 5 });
  assert.deepEqual(modelFamily("opus"), { fam: "opus", ver: null });
  assert.deepEqual(modelFamily(""), { fam: "", ver: null });
});

test("pares da tabela da doc: Fable principal só aceita Fable; modelo antigo não aceita; padrão do plano passa", () => {
  assert.equal(advisorPair("claude", "claude-sonnet-5", "opus").ok, true);
  assert.equal(advisorPair("claude", "claude-haiku-4-5-20251001", "fable").ok, true);
  assert.equal(advisorPair("claude", "claude-opus-5-5", "opus").ok, true, "Opus 5.5 + Opus 5 ou mais novo");
  assert.equal(advisorPair("claude", "", "opus").ok, true, "padrão da assinatura: o Claude Code confere");
  const f = advisorPair("claude", "claude-fable-5-1", "opus");
  assert.equal(f.ok, false); assert.match(f.why, /só o Fable/);
  assert.equal(advisorPair("claude", "claude-fable-5-1", "fable").ok, true);
  assert.equal(advisorPair("claude", "claude-opus-4-5", "opus").ok, false, "anterior ao 4.6 não aceita");
  assert.equal(advisorPair("claude", "claude-sonnet-4-6", "opus").ok, true);
});

test("versão do Claude Code: 2.1.280 passa, 2.1.200 não, sem versão = não sei", () => {
  assert.equal(cliVersionOk("2.1.280 (Claude Code)"), true);
  assert.equal(cliVersionOk("2.1.260"), true);
  assert.equal(cliVersionOk("2.1.259"), false);
  assert.equal(cliVersionOk("2.0.99"), false);
  assert.equal(cliVersionOk("3.0.0"), true);
  assert.equal(cliVersionOk(null), null);
});

test("args: --settings advisorModel só no Claude, com par aceito e versão boa", () => {
  assert.deepEqual(advisorArgs({ engine: "claude", model: "claude-sonnet-5", advisor: "opus", cliVersion: "2.1.280" }), { args: SET("opus"), on: "opus", note: "" });
  assert.deepEqual(advisorArgs({ engine: "claude", model: "", advisor: "fable", cliVersion: null }).args, SET("fable"), "versão desconhecida não bloqueia");
  assert.deepEqual(advisorArgs({ engine: "claude", model: "x", advisor: null }), { args: [], on: null, note: "" }, "desligado: nada, sem nota");
  const old = advisorArgs({ engine: "claude", advisor: "opus", cliVersion: "2.1.100" });
  assert.deepEqual(old.args, []); assert.match(old.note, /precisa atualizar o Claude Code/);
  const gw = advisorArgs({ engine: "claude", advisor: "opus", viaGateway: true });
  assert.deepEqual(gw.args, []); assert.match(gw.note, /gateway/);
  const fb = advisorArgs({ engine: "claude", model: "claude-fable-5-1", advisor: "opus", cliVersion: "2.1.280" });
  assert.deepEqual(fb.args, []); assert.match(fb.note, /só o Fable/);
});

test("DeepSeek/Codex/gateway: nunca vira flag; DeepSeek explica (só API da Anthropic)", () => {
  const ds = advisorArgs({ engine: "deepseek", advisor: "opus", cliVersion: "2.1.280" });
  assert.deepEqual(ds.args, []); assert.match(ds.note, /DeepSeek.*Anthropic/);
  for (const e of ["codex", "gateway", "logcomex"]) assert.deepEqual(advisorArgs({ engine: e, advisor: "opus" }).args, [], e);
});

test("evento: server_tool_use 'advisor' = consultado; erro e recusa viram texto; o resto não inventa", () => {
  assert.equal(advisorEventOf({ type: "server_tool_use", name: "advisor", input: {} }), "Conselheiro consultado");
  assert.equal(advisorEventOf({ type: "server_tool_use", name: "web_search" }), null);
  assert.equal(advisorEventOf({ type: "advisor_tool_result", content: { type: "advisor_tool_result_error", error_code: "overloaded" } }), "Conselheiro indisponível (overloaded)");
  assert.match(String(advisorEventOf({ type: "advisor_tool_result", content: { type: "advisor_result", stop_reason: "refusal" } })), /não opinar/);
  assert.equal(advisorEventOf({ type: "advisor_tool_result", content: { type: "advisor_redacted_result" } }), null);
});

test("custo: separa a parte do conselheiro só quando é outra família que o principal", () => {
  const mu = { "claude-sonnet-5": { costUSD: 0.8 }, "claude-opus-5-5": { costUSD: 0.25 }, "claude-haiku-4-5-20251001": { costUSD: 0.01 } };
  assert.equal(advisorCostOf(mu, "opus", "claude-sonnet-5"), 0.25);
  assert.equal(advisorCostOf(mu, "opus", "claude-opus-5-5"), null, "Opus aconselhando Opus: uma linha só");
  assert.equal(advisorCostOf(mu, "fable", "claude-sonnet-5"), null, "sem consulta: nada");
  assert.equal(advisorCostOf(mu, "opus", ""), null, "principal desconhecido: não separa");
});

test("mapLine: consulta vira nota no histórico; result com modelUsage mostra a parte do conselheiro", () => {
  const ctx = { advisor: "opus" as const, mainModel: "" };
  mapLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-5" }), 0, ctx);
  assert.equal(ctx.mainModel, "claude-sonnet-5");
  const a = mapLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "server_tool_use", id: "x", name: "advisor", input: {} }] } }), 0, ctx);
  assert.deepEqual(a.map((e) => e.text), ["Conselheiro consultado"]);
  const r = mapLine(JSON.stringify({ type: "result", total_cost_usd: 1.05, modelUsage: { "claude-sonnet-5": { costUSD: 0.8 }, "claude-opus-5-5": { costUSD: 0.25 } } }), 0, ctx);
  assert.match(String(r[0].text), /^Conselheiro \(Opus\): US\$ 0\.250 nesta sessão — já incluído/);
  assert.equal(r[1].type, "done");
  assert.equal(mapLine(JSON.stringify({ type: "result", total_cost_usd: 1 }), 0).length, 1, "sem conselheiro: só o done");
});

// ---- o motor de verdade com um claude FALSO: args do -p e do --resume ----
const POSIX = { skip: process.platform === "win32" ? "POSIX-only" : false };
function setup(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "starfork-adv-"));
  mkdirSync(join(dir, "wt", ".cardume"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  const f = join(dir, "fake-claude.mjs");
  writeFileSync(f, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nif (process.argv.includes("--version")) { console.log(${JSON.stringify(version)} + " (Claude Code)"); process.exit(0); }\n` +
    `appendFileSync(${JSON.stringify(join(dir, "argv.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
    `const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\nout({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5" });\n` +
    `out({ type: "assistant", message: { content: [{ type: "server_tool_use", id: "a1", name: "advisor", input: {} }] } });\n` +
    `out({ type: "result", total_cost_usd: 0.5, modelUsage: { "claude-sonnet-5": { costUSD: 0.4 }, "claude-opus-5-5": { costUSD: 0.1 } } });\n`);
  chmodSync(f, 0o755);
  const saved = { ...process.env };
  process.env.HOME = join(dir, "home");
  process.env.CARDUME_CLAUDE = f;
  process.env.CARDUME_PROTECT = "0";
  delete process.env.CLAUDE_CONFIG_DIR;
  const input = (advisor: string | null, resume?: string) => ({
    cwd: join(dir, "wt"),
    spec: { id: "t1", title: "x", objective: "x", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] }, advisor } as never,
    systemContext: "", role: "builder", agentName: "Íris", dbFile: join(dir, "state.sqlite"),
    ...(resume ? { resume: { sessionId: resume, instruction: "continue" } } : {}),
  });
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); };
  const argvs = () => readFileSync(join(dir, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  return { input, restore, argvs };
}
async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> { const out: AgentEvent[] = []; for await (const e of it) out.push(e); return out; }
const hasSet = (a: string[], m: string) => a.some((x, i) => x === "--settings" && a[i + 1] === JSON.stringify({ advisorModel: m }));

test("headless: -p e --resume levam o --settings do conselheiro; consulta e custo chegam como eventos", POSIX, async () => {
  const s = setup("2.1.280");
  try {
    const eng = new ClaudeEngine({ model: "claude-sonnet-5", approval: "auto" });
    const ev1 = await drain(eng.run(s.input("opus") as never));
    await drain(eng.run(s.input("opus", "s1") as never));
    const [fresh, resumed] = s.argvs();
    assert.ok(hasSet(fresh, "opus"), "turno novo");
    assert.ok(resumed.includes("--resume") && hasSet(resumed, "opus"), "retomada mantém o conselheiro");
    assert.ok(ev1.some((e) => e.text === "Conselheiro consultado"));
    assert.ok(ev1.some((e) => /Conselheiro \(Opus\): US\$ 0\.100/.test(String(e.text))));
    await drain(eng.run(s.input(null) as never));
    assert.ok(!s.argvs()[2].includes("--settings"), "desligado: sem --settings");
  } finally { s.restore(); }
});

test("headless: Claude Code antigo → sem flag e com o motivo no histórico", POSIX, async () => {
  const s = setup("2.1.100");
  try {
    const ev = await drain(new ClaudeEngine({ model: "claude-sonnet-5", approval: "auto" }).run(s.input("fable") as never));
    assert.ok(!s.argvs()[0].includes("--settings"));
    assert.ok(ev.some((e) => /precisa atualizar o Claude Code/.test(String(e.text))));
  } finally { s.restore(); }
});

// ---- modo TERMINAL: o mesmo lançamento do `starfork ia claude` (e do `--resume`) ----
test("terminal: claude leva o --settings (também ao retomar); DeepSeek dentro do claude desliga e explica", POSIX, async () => {
  const { execFileSync } = await import("node:child_process");
  const { realpathSync } = await import("node:fs");
  const { tempHome } = await import("./testing/temp-home.ts");
  const { Orchestrator } = await import("./orchestrator.ts");
  const { termPrep } = await import("./terminal.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-adv-term-")));
  const repo = join(root, "repo");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n"); g("add", "-A"); g("commit", "-q", "-m", "base");
  const h = tempHome();
  const fake = join(root, "claude");
  writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo '2.1.280 (Claude Code)'\nexit 0\n");
  chmodSync(fake, 0o755);
  const keys = ["HOME", "CARDUME_NOTIFY", "CARDUME_AI_BIN_claude", "DEEPSEEK_API_KEY"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: h.home, CARDUME_NOTIFY: "0", CARDUME_AI_BIN_claude: fake, DEEPSEEK_API_KEY: "sk-teste" });
  const orch = new Orchestrator(repo);
  const spec = (id: string, extra: object) => ({ id, title: id, objective: "o", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "claude", model: "claude-sonnet-5" }], engine: "claude", deliverables: ["d"], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto" }, autoPr: "no", ...extra }) as never;
  try {
    await orch.createTask(spec("cl", { advisor: "opus" }));
    assert.ok(hasSet(termPrep(orch, "cl", { direct: true }).args, "opus"), "terminal novo");
    assert.ok(hasSet(termPrep(orch, "cl", { direct: true, resume: true }).args, "opus"), "retomar mantém");
    await orch.createTask(spec("sem", {}));
    assert.ok(!termPrep(orch, "sem", { direct: true }).args.includes("--settings"), "sem conselheiro: nada");
    await orch.createTask(spec("ds", { advisor: "opus", engine: "deepseek", roles: [{ role: "builder", name: "Vega", engine: "deepseek" }] }));
    const L = termPrep(orch, "ds", { direct: true });
    assert.equal(L.engine, "deepseek");
    assert.ok(!L.args.includes("--settings"), "DeepSeek: nunca");
    assert.ok(orch.store.eventsForTask("ds").some((e) => /Conselheiro \(Opus\) desligado: o DeepSeek/.test(e.text)), "explica no histórico");
  } finally {
    orch.close();
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    h.cleanup(); rmSync(root, { recursive: true, force: true });
  }
});
