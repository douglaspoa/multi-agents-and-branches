// node --test src/model-engine.test.ts  (npm test)
// "Selecionei o modelo/motor e ele segue no Claude": prova, pelo ARGV REAL que chega
// nos binários, que o motor e o modelo escolhidos sobrevivem do CLI até o processo
// do agente — no turno inicial E nos turnos seguintes (conversa, instruções, --resume).
// Binários falsos (CARDUME_CLAUDE / CARDUME_CODEX) só registram o argv; repos git
// TEMPORÁRIOS — nunca toca projeto real nem chama IA.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "./types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-model-")));
const LOG = join(root, "argv.log");
const saved: Record<string, string | undefined> = {};

function fakeBin(name: string, lines: string[]): string {
  const p = join(root, `fake-${name}`);
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `require("fs").appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");\n` +
      lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n") + "\n"
  );
  chmodSync(p, 0o755);
  return p;
}
type Call = { bin: string; argv: string[] };
const calls = (): Call[] =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
const reset = () => writeFileSync(LOG, "");
const flag = (c: Call, f: string) => { const i = c.argv.indexOf(f); return i >= 0 ? c.argv[i + 1] : undefined; };

function gitRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}

before(() => {
  for (const k of ["CARDUME_CLAUDE", "CARDUME_CODEX", "CARDUME_DSH", "CARDUME_DSH_HOME", "DEEPSEEK_API_KEY", "HOME", "CARDUME_LIMIT_RETRY_MIN"]) saved[k] = process.env[k];
  const home = join(root, "home");
  mkdirSync(home, { recursive: true }); // sem ~/.constellation/llm.env → Route AI desligado (não mascara o modelo)
  process.env.HOME = home;
  process.env.CARDUME_CLAUDE = fakeBin("claude", [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "x", permissionMode: "bypassPermissions" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-1", total_cost_usd: 0 }),
  ]);
  // dsh falso (DeepSeek beta): a chave vai pelo env do processo (sem llm.env → Route AI segue desligado)
  process.env.CARDUME_DSH = fakeBin("dsh", [
    JSON.stringify({ type: "session", sessionId: "session-ds-1" }),
    JSON.stringify({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } }),
    JSON.stringify({ type: "final", text: "ok" }),
  ]);
  process.env.CARDUME_DSH_HOME = join(root, "dshhome");
  process.env.DEEPSEEK_API_KEY = "sk-ds-teste";
  process.env.CARDUME_CODEX = fakeBin("codex", [
    JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ]);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  // processos de fundo (retro/aux fire-and-forget) ainda podem escrever no repo temporário: tenta de novo
  // faxina melhor-esforço: pasta no tmp do sistema; falhar aqui não diz nada sobre o motor
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* o SO limpa o tmp */ }
});

test("ClaudeEngine: --model vai no turno novo E no --resume (antes o resume caía no padrão da assinatura)", async () => {
  const { ClaudeEngine } = await import("./engine/claude.ts");
  const cwd = gitRepo("eng");
  mkdirSync(join(cwd, ".cardume"), { recursive: true });
  const spec = { id: "e1", title: "e1", objective: "x", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { approval: "auto" }, engine: "claude", roles: [] } as unknown as TaskSpec;
  const base = { cwd, spec, systemContext: "", role: "builder" as const, agentName: "Íris", dbFile: join(root, "x.db") };
  reset();
  for await (const _ of new ClaudeEngine({ model: "claude-opus-5-5", approval: "auto" }).run(base)) { /* consome */ }
  for await (const _ of new ClaudeEngine({ model: "claude-opus-5-5", approval: "auto" }).run({ ...base, resume: { sessionId: "sess-1", instruction: "continua" } })) { /* consome */ }
  const [fresh, resumed] = calls();
  assert.equal(flag(fresh, "--model"), "claude-opus-5-5");
  assert.equal(flag(resumed, "--resume"), "sess-1");
  assert.equal(flag(resumed, "--model"), "claude-opus-5-5", "turno retomado precisa manter o modelo escolhido");
});

test("CLI new (caminho do app): --engine/--model chegam no argv do claude — builder simples e agente do catálogo", async () => {
  const repo = gitRepo("cli");
  const cli = join(import.meta.dirname, "cli.ts");
  const env = { ...process.env };
  const run = (...a: string[]) =>
    execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "new", "--repo", repo, "--approve", "auto", "--no-overlap-check", "--light", ...a], { env, stdio: "ignore", timeout: 60000 });
  reset();
  run("--id", "c1", "--title", "c1", "--engine", "claude", "--model", "claude-sonnet-5");
  run("--id", "c2", "--title", "c2", "--agents", "iris", "--engine", "claude", "--model", "haiku");
  const cl = calls().filter((c) => c.bin === "claude" && flag(c, "--output-format") === "stream-json");
  assert.ok(cl.some((c) => flag(c, "--model") === "claude-sonnet-5"), JSON.stringify(cl.map((c) => flag(c, "--model"))));
  assert.ok(cl.some((c) => flag(c, "--model") === "haiku"), JSON.stringify(cl.map((c) => flag(c, "--model"))));
});

test("CLI new com --engine codex: roda o CODEX com -m, nunca o claude", async () => {
  const repo = gitRepo("clicodex");
  const cli = join(import.meta.dirname, "cli.ts");
  reset();
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "new", "--repo", repo, "--id", "x1", "--title", "x1", "--engine", "codex", "--model", "gpt-5-codex", "--approve", "auto", "--no-overlap-check", "--light"], { env: process.env, stdio: "ignore", timeout: 60000 });
  const cs = calls();
  const codex = cs.filter((c) => c.bin === "codex");
  assert.ok(codex.length > 0, "o codex deveria ter rodado");
  assert.equal(flag(codex[0], "-m"), "gpt-5-codex");
  assert.equal(cs.filter((c) => c.bin === "claude" && flag(c, "--output-format") === "stream-json").length, 0, "nenhum agente no claude");
});

test("conversa/instrução numa tarefa Codex continua no Codex com o modelo dela (antes caía no Claude)", async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("talk");
  const orch = new Orchestrator(repo);
  try {
    const spec = {
      id: "t1", title: "t1", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "codex", model: "gpt-5", agent: "Íris", light: true, base: "main",
      roles: [{ role: "builder", name: "Íris", engine: "codex", model: "gpt-5" }],
    } as unknown as TaskSpec;
    await orch.createTask(spec);
    reset();
    await orch.talkToAgent("t1", "ajusta o texto do botão");
    const cs = calls();
    assert.equal(cs.filter((c) => c.bin === "claude" && flag(c, "--output-format") === "stream-json").length, 0, JSON.stringify(cs.map((c) => c.bin)));
    const codex = cs.filter((c) => c.bin === "codex");
    assert.equal(codex.length, 1);
    assert.equal(flag(codex[0], "-m"), "gpt-5");
  } finally {
    orch.close();
  }
});

test("conversa numa tarefa Claude mantém o modelo escolhido também no --resume", async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("talk2");
  const orch = new Orchestrator(repo);
  try {
    const spec = {
      id: "t2", title: "t2", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "claude", model: "claude-opus-5-5", agent: "Íris", light: true, base: "main",
      roles: [{ role: "builder", name: "Íris", engine: "claude", model: "claude-opus-5-5" }],
    } as unknown as TaskSpec;
    await orch.createTask(spec);
    orch.store.setSession("t2", "sess-1"); // já teve um turno → a conversa RETOMA a sessão
    reset();
    await orch.talkToAgent("t2", "mais um ajuste");
    const cl = calls().filter((c) => c.bin === "claude" && flag(c, "--output-format") === "stream-json");
    assert.equal(cl.length, 1);
    assert.equal(flag(cl[0], "--resume"), "sess-1");
    assert.equal(flag(cl[0], "--model"), "claude-opus-5-5");
  } finally {
    orch.close();
  }
});

test("engineKind: rótulos variados resolvem pro motor certo (mesma regra do engineFor)", async () => {
  const { engineKind } = await import("./orchestrator.ts");
  assert.equal(engineKind("Claude · Opus 4.8"), "claude");
  assert.equal(engineKind("CODEX"), "codex");
  assert.equal(engineKind("gateway"), "gateway");
  assert.equal(engineKind("logcomex"), "logcomex");
  assert.equal(engineKind("mock"), "mock");
  assert.equal(engineKind(""), "mock");
});

// DshEngine checa o node (^22.19 ou ≥24) antes de rodar o dsh falso
const DSH_NODE = { skip: process.platform === "win32" ? "POSIX-only" : !/^(2[4-9]|[3-9]\d)\.|^22\.(19|[2-9]\d)\./.test(process.versions.node) ? `node ${process.versions.node} < 22.19` : false };
const dshPatchModel = (wt: string) => (readFileSync(join(wt, ".cardume", "dsh.patch.yml"), "utf8").match(/"model":"([^"]+)"/) ?? [])[1];

test("CLI new com --engine deepseek: roda o DSH com o modelo no patch da worktree, nunca claude/codex; alias do Claude vira o capaz", DSH_NODE, async () => {
  const repo = gitRepo("clidsh");
  const cli = join(import.meta.dirname, "cli.ts");
  reset();
  const run = (id: string, model: string) => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "new", "--repo", repo, "--id", id, "--title", id, "--engine", "deepseek", "--model", model, "--approve", "auto", "--no-overlap-check", "--light"], { env: process.env, stdio: "ignore", timeout: 60000 });
  run("d1", "deepseek-flash");
  const cs = calls();
  assert.ok(cs.some((c) => c.bin === "dsh"), "o dsh deveria ter rodado: " + JSON.stringify(cs.map((c) => c.bin)));
  assert.equal(cs.filter((c) => (c.bin === "claude" && flag(c, "--output-format") === "stream-json") || c.bin === "codex").length, 0, "nenhum agente no claude/codex");
  const { Store } = await import("./store.ts");
  const st = new Store(join(repo, ".cardume", "state.sqlite"));
  try {
    const wt = (n: string) => st.getTask(n)!.worktree;
    assert.equal(dshPatchModel(wt("d1")), "deepseek-flash");
    run("d2", "sonnet");
    assert.equal(dshPatchModel(wt("d2")), "deepseek-v4-pro", "alias do Claude (#ntModel) não vai pro deepseek-official");
  } finally { st.close(); }
});

test("conversa numa tarefa DeepSeek continua no dsh com --session-id e o modelo dela (nunca claude/codex)", DSH_NODE, async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("talkdsh");
  const orch = new Orchestrator(repo);
  try {
    const spec = {
      id: "t3", title: "t3", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "deepseek", model: "deepseek-flash", agent: "Íris", light: true, base: "main",
      roles: [{ role: "builder", name: "Íris", engine: "deepseek", model: "deepseek-flash" }],
    } as unknown as TaskSpec;
    await orch.createTask(spec);
    orch.store.setSession("t3", "session-ds-0"); // já teve um turno → a conversa RETOMA a sessão
    reset();
    await orch.talkToAgent("t3", "ajusta o texto do botão");
    const cs = calls();
    assert.equal(cs.filter((c) => (c.bin === "claude" && flag(c, "--output-format") === "stream-json") || c.bin === "codex").length, 0, JSON.stringify(cs.map((c) => c.bin)));
    const dsh = cs.filter((c) => c.bin === "dsh");
    assert.equal(dsh.length, 1);
    assert.equal(flag(dsh[0], "--session-id"), "session-ds-0");
    assert.equal(dshPatchModel(orch.store.getTask("t3")!.worktree), "deepseek-flash");
  } finally {
    orch.close();
  }
});
