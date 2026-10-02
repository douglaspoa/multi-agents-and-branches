// node --test src/engine-sticky.test.ts  (npm test)
// MOTOR GRUDADO NA TAREFA — caso do Roberto (usa só Codex): conversando com o agente, a conversa
// fechou e a tarefa foi pra erro; ao pedir "revisar" no chat da tarefa com erro, ela passou pro Claude.
// Aqui, com binários FALSOS (CARDUME_CODEX / CARDUME_CLAUDE só registram o argv) e repos git temporários:
//  - erro → conversa ("revisar") / rework / entregável / sessão perdida: TUDO segue no Codex, nunca no Claude;
//  - aviso transitório do Codex ("Reconnecting... 1/5") não derruba mais o turno nem põe a tarefa em erro;
//  - tarefa SEM motor registrado usa a IA padrão do usuário (aiEngine em settings.json), não o Claude fixo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "./types.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only (binários falsos com shebang)" : false };
const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-sticky-")));
const LOG = join(root, "argv.log");
const MODE = join(root, "codex-mode");
const saved: Record<string, string | undefined> = {};

type Call = { bin: string; argv: string[] };
const calls = (): Call[] =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
const reset = () => writeFileSync(LOG, "");
const mode = (m: string) => writeFileSync(MODE, m);
/** turnos de AGENTE do codex (o `exec` da IA auxiliar lê o prompt do stdin: último argumento "-") */
const codexTurns = () => calls().filter((c) => c.bin === "codex" && c.argv[c.argv.length - 1] !== "-");
const claudeCalls = () => calls().filter((c) => c.bin === "claude");

function writeBin(name: string, body: string): string {
  const p = join(root, `fake-${name}`);
  writeFileSync(
    p,
    `#!/usr/bin/env node\nconst fs = require("fs");\n` +
      `fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");\n` +
      `const out = (o) => console.log(JSON.stringify(o));\n${body}\n`
  );
  chmodSync(p, 0o755);
  return p;
}

function gitRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return repo;
}

const codexSpec = (id: string, engine = "codex", model: string | undefined = "gpt-5-codex"): TaskSpec =>
  ({
    id, title: id, objective: "x", deliverables: [], requirements: [],
    scope: { owns: [], offLimits: [] },
    autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
    engine, model, agent: "Íris", light: true, base: "main", autoPr: "no",
    roles: [{ role: "builder", name: "Íris", engine, model }],
  }) as unknown as TaskSpec;

before(() => {
  for (const k of ["CARDUME_CLAUDE", "CARDUME_CODEX", "HOME", "USERPROFILE", "CARDUME_LIMIT_RETRY_MIN", "CARDUME_CLAUDE_EXIT_GRACE_MS"]) saved[k] = process.env[k];
  const home = join(root, "home");
  mkdirSync(join(home, ".constellation"), { recursive: true });
  // IA padrão do usuário = Codex (o Roberto não tem Claude)
  writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify({ aiEngine: "codex", aiModel: "gpt-5", learnMode: "desligado" }));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CARDUME_LIMIT_RETRY_MIN = "0";
  process.env.CARDUME_CLAUDE_EXIT_GRACE_MS = "300";
  process.env.CARDUME_CLAUDE = writeBin("claude", `out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "claude-sess" });`);
  process.env.CARDUME_CODEX = writeBin(
    "codex",
    `const m = fs.existsSync(${JSON.stringify(MODE)}) ? fs.readFileSync(${JSON.stringify(MODE)}, "utf8").trim() : "ok";
const a = process.argv.slice(2);
const resume = a[0] === "exec" && a[1] === "resume";
if (m === "fail") { out({ type: "thread.started", thread_id: "th-1" }); out({ type: "turn.failed", error: { message: "unexpected status 500 Internal Server Error" } }); process.exit(1); }
if (m === "nosession" && resume) { console.error("Error: No saved session found with ID " + a[2]); process.exit(1); }
out({ type: "thread.started", thread_id: "th-1" });
if (m === "transient") out({ type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion: error sending request)" });
out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "feito" } });
out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });`
  );
  mode("ok");
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* o SO limpa o tmp */ }
});

test("tarefa Codex que deu ERRO: 'revisar' no chat, rework e entregável seguem no Codex — nunca no Claude", POSIX, async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("erro-revisar");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(codexSpec("r1"));
    mode("fail");
    reset();
    await orch.runTask("r1");
    assert.equal(orch.store.getTask("r1")!.status, "error", "o turno falhou de verdade (turn.failed + saída 1)");
    const err = orch.store.eventsForTask("r1").find((e) => e.type === "error");
    assert.ok(err && /O Codex parou com um erro/.test(err.text), "erro humano, em português: " + err?.text);

    mode("ok");
    reset();
    await orch.talkToAgent("r1", "revisar");
    assert.equal(claudeCalls().length, 0, "o chat da tarefa com erro foi pro Claude: " + JSON.stringify(calls()));
    const talk = codexTurns();
    assert.equal(talk.length, 1);
    assert.deepEqual(talk[0].argv.slice(0, 3), ["exec", "resume", "th-1"], "continua a sessão do PRÓPRIO Codex");
    assert.ok(talk[0].argv.includes("gpt-5-codex"), "com o modelo da tarefa");

    reset();
    orch.store.addInstruction("r1", "revisar de novo");
    await orch.reworkTask("r1");
    await orch.deliverArtifact("r1", "doc");
    assert.equal(claudeCalls().length, 0, "rework/entregável foram pro Claude: " + JSON.stringify(calls()));
    assert.ok(codexTurns().length >= 2, "rework e entregável rodaram no Codex");
    const spec = JSON.parse(orch.store.getTask("r1")!.spec_json) as TaskSpec;
    assert.equal(spec.engine, "codex");
    assert.deepEqual(spec.roles.map((r) => r.engine), ["codex"]);
  } finally {
    orch.close();
  }
});

test("sessão que o Codex não acha (id de outro motor/máquina): recomeça NO CODEX com o resumo, sem erro", POSIX, async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("nosession");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(codexSpec("s1"));
    orch.store.setSession("s1", "sessao-do-claude-antiga");
    mode("nosession");
    reset();
    await orch.talkToAgent("s1", "revisar");
    assert.equal(claudeCalls().length, 0, JSON.stringify(calls()));
    const t = codexTurns();
    assert.equal(t.length, 2, "1ª tentativa (resume) + sessão nova: " + JSON.stringify(t.map((c) => c.argv.slice(0, 3))));
    assert.deepEqual(t[0].argv.slice(0, 3), ["exec", "resume", "sessao-do-claude-antiga"]);
    assert.notEqual(t[1].argv[1], "resume", "a 2ª é uma sessão NOVA");
    const evs = orch.store.eventsForTask("s1");
    assert.ok(evs.some((e) => /sessão anterior do agente não foi encontrada/.test(e.text)));
    assert.ok(!evs.some((e) => /não consegui rodar/.test(e.text)), "não terminou em erro");
  } finally {
    orch.close();
  }
});

test("aviso transitório do Codex ('Reconnecting... 1/5') NÃO põe a tarefa em erro nem fecha a conversa", POSIX, async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("transient");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(codexSpec("x1"));
    mode("transient");
    reset();
    await orch.runTask("x1");
    assert.equal(orch.store.getTask("x1")!.status, "review", "o codex concluiu — a tarefa não pode ir pra erro");
    await orch.talkToAgent("x1", "ajusta o botão");
    const evs = orch.store.eventsForTask("x1");
    assert.equal(evs.filter((e) => e.type === "error").length, 0, evs.filter((e) => e.type === "error").map((e) => e.text).join(" | "));
    assert.ok(evs.some((e) => /reconectando sozinho/.test(e.text)), "o aviso aparece como nota");
    assert.ok(!evs.some((e) => /não consegui rodar/.test(e.text)));
    assert.equal(claudeCalls().length, 0);
  } finally {
    orch.close();
  }
});

test("tarefa SEM motor registrado usa a IA padrão configurada (aiEngine=codex) e o motor fica gravado", POSIX, async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const repo = gitRepo("noengine");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask(codexSpec("n1", "", undefined));
    mode("ok");
    reset();
    await orch.runTask("n1");
    assert.equal(claudeCalls().length, 0, "sem motor registrado caiu no Claude: " + JSON.stringify(calls()));
    assert.equal(codexTurns().length, 1);
    const spec = JSON.parse(orch.store.getTask("n1")!.spec_json) as TaskSpec;
    assert.equal(spec.engine, "codex", "o motor padrão é gravado na tarefa (próximos turnos grudam nele)");
    assert.equal(spec.roles[0].engine, "codex");
    reset();
    await orch.talkToAgent("n1", "revisar");
    assert.equal(claudeCalls().length, 0);
    assert.equal(codexTurns().length, 1);
  } finally {
    orch.close();
  }
});

test("defaults: rótulo desconhecido e papel sem motor seguem a IA padrão, não o Claude fixo", async () => {
  const { engineKind, defaultEngine, stickEngines } = await import("./orchestrator.ts");
  assert.equal(defaultEngine(), "codex");
  assert.equal(engineKind("openai"), "codex", "rótulo fora da lista = IA padrão do usuário");
  assert.equal(engineKind("Claude · Opus 4.8"), "claude", "motor registrado continua valendo");
  assert.equal(engineKind(""), "mock");
  const spec = codexSpec("d1", "claude", "claude-opus-5-5");
  assert.equal(stickEngines(spec), false, "tarefa com motor não muda");
  assert.equal(spec.engine, "claude");
  const blank = codexSpec("d2", "", undefined);
  assert.equal(stickEngines(blank), true);
  assert.equal(blank.engine, "codex");
});

test("erros do Codex viram mensagem humana em português (sem sugerir trocar de IA)", async () => {
  const { codexFriendlyError, mapCodexLine } = await import("./engine/codex.ts");
  assert.match(codexFriendlyError("401 Unauthorized: Not logged in"), /codex login/);
  assert.match(codexFriendlyError("You've hit your usage limit"), /limite de uso/);
  assert.match(codexFriendlyError("No saved session found with ID abc"), /sessão anterior do Codex não foi encontrada/);
  assert.match(codexFriendlyError("stream disconnected before completion"), /conexão/);
  for (const m of ["401", "usage limit", "stream disconnected", "boom"]) assert.doesNotMatch(codexFriendlyError(m), /claude/i);
  const [tf] = mapCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }));
  assert.equal(tf.type, "error");
  assert.match(tf.text, /usage limit reached/, "o texto cru segue junto (o orquestrador reconhece limite/rede por ele)");
  const [w] = mapCodexLine(JSON.stringify({ type: "error", message: "Reconnecting... 2/5" }));
  assert.equal(w.type, "note", "aviso de topo do codex não é fim de turno");
});
