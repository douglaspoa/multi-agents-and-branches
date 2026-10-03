// node --test src/engine/codex.test.ts  (npm test)
// Motor Codex/gateway: leitura da saída do `codex exec --json` e das chaves da conta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLlmEnv, mapCodexLine } from "./codex.ts";

test("turn.failed traz o MOTIVO (antes: sumia e o turno morria só com 'código 1')", () => {
  const evs = mapCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "429 Too Many Requests: usage limit reached" } }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "error");
  assert.match(evs[0].text, /usage limit reached/);
  // erro de TOPO é aviso não terminal (o codex reconecta e segue): vira nota, não encerra o turno
  const [w] = mapCodexLine(JSON.stringify({ type: "error", message: "stream disconnected" }));
  assert.equal(w.type, "note");
  assert.match(w.text, /stream disconnected/);
});

test("comando aparece UMA vez no feed (antes: item.started e item.completed duplicavam)", () => {
  const item = { id: "i1", type: "command_execution", command: "npm test", status: "in_progress" };
  const seen = new Set<string>();
  const started = mapCodexLine(JSON.stringify({ type: "item.started", item }), seen);
  const completed = mapCodexLine(JSON.stringify({ type: "item.completed", item: { ...item, status: "completed", exit_code: 0 } }), seen);
  assert.deepEqual(started.map((e) => [e.type, e.text]), [["bash", "npm test"]]);
  assert.deepEqual(completed, []);
  // comando que FALHOU (status do item) não é erro do turno
  assert.deepEqual(mapCodexLine(JSON.stringify({ type: "item.completed", item: { ...item, status: "failed", exit_code: 1 } }), seen), []);
  // comando que SÓ chega no completed (sem started) aparece — antes sumia
  const only = mapCodexLine(JSON.stringify({ type: "item.completed", item: { id: "i2", type: "command_execution", command: "ls", status: "completed" } }), seen);
  assert.deepEqual(only.map((e) => [e.type, e.text]), [["bash", "ls"]]);
});

test("uso do turno vira custo/tokens no done", () => {
  const [d] = mapCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } }));
  assert.equal(d.type, "done");
  assert.deepEqual(d.cost, { usd: 0, inTok: 1200, outTok: 300, cachedTok: 200 }); // cache vai pro livro de uso (preço menor)
});

test("chaves da conta vêm de <home>/.constellation/llm.env (homedir, não $HOME cru)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-codex-"));
  const old = process.env.HOME, oldUp = process.env.USERPROFILE;
  try {
    mkdirSync(join(dir, ".constellation"), { recursive: true });
    writeFileSync(join(dir, ".constellation", "llm.env"), "ALT_AI_KEY=abc123\n# comentário\nlixo sem igual\nlower=x\n");
    process.env.HOME = dir;
    process.env.USERPROFILE = dir; // Node usa USERPROFILE no Windows
    assert.deepEqual(loadLlmEnv(), { ALT_AI_KEY: "abc123" });
  } finally {
    if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
    if (oldUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codexPath: pasta do node em uso e do codex vão pra frente do PATH mínimo do Finder (codex do npm é #!/usr/bin/env node)", async () => {
  const { codexPath } = await import("./codex.ts");
  const { dirname, delimiter } = await import("node:path");
  const p = codexPath("/u/.nvm/versions/node/v22/bin/codex", "/opt/homebrew/bin:/usr/bin:/bin").split(delimiter);
  // a pasta do codex primeiro (o `env node` acha o node com que ele foi instalado), depois a do node em uso
  assert.equal(p[0], "/u/.nvm/versions/node/v22/bin");
  assert.equal(p[1], dirname(process.execPath));
  assert.deepEqual(p.slice(-3), ["/opt/homebrew/bin", "/usr/bin", "/bin"]);
  assert.equal(codexPath("codex", "/usr/bin").split(delimiter).filter((d) => d === dirname(process.execPath)).length, 1);
});

test("file_change do codex 0.1xx (changes em LISTA) mostra os caminhos, não o índice", async () => {
  const { mapCodexLine } = await import("./codex.ts");
  const evs = mapCodexLine(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "file_change", changes: [{ path: "/w/math.js", kind: "update" }, { path: "/w/b.js", kind: "add" }] } }));
  assert.deepEqual(evs, [{ type: "edit", text: "/w/math.js, /w/b.js" }]);
  const seen = new Set<string>();
  const st = { id: "i9", type: "file_change", changes: [{ path: "/w/x.js", kind: "update" }] };
  assert.equal(mapCodexLine(JSON.stringify({ type: "item.started", item: st }), seen).length, 1);
  assert.equal(mapCodexLine(JSON.stringify({ type: "item.completed", item: st }), seen).length, 0, "started+completed = 1 edição");
  const old = mapCodexLine(JSON.stringify({ type: "item.completed", item: { type: "patch_apply", changes: { "a.ts": {} } } }));
  assert.deepEqual(old, [{ type: "edit", text: "a.ts" }]);
});

test("rework no Codex: o ajuste do humano vai no prompt (antes o Codex achava a tarefa 'já atendida' e ignorava)", async () => {
  const { buildPrompt } = await import("./codex.ts");
  const spec = { id: "t", title: "t", objective: "o", requirements: [], scope: { owns: [], offLimits: [] }, autonomy: {}, engine: "codex", roles: [], adjustment: "Renomeie o parâmetro b para c" } as never;
  const p = buildPrompt({ cwd: "/tmp/nao-existe", spec, role: "builder", agentName: "A" } as never);
  assert.match(p, /AJUSTE SOLICITADO PELO HUMANO[^\n]*Renomeie o parâmetro b para c/);
  const sem = buildPrompt({ cwd: "/tmp/nao-existe", spec: { ...(spec as object), adjustment: undefined } as never, role: "builder", agentName: "A" } as never);
  assert.doesNotMatch(sem, /AJUSTE SOLICITADO/);
});
