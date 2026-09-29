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
  // erro de topo continua valendo
  assert.equal(mapCodexLine(JSON.stringify({ type: "error", message: "stream disconnected" }))[0].text, "stream disconnected");
});

test("comando aparece UMA vez no feed (antes: item.started e item.completed duplicavam)", () => {
  const item = { id: "i1", type: "command_execution", command: "npm test", status: "in_progress" };
  const started = mapCodexLine(JSON.stringify({ type: "item.started", item }));
  const completed = mapCodexLine(JSON.stringify({ type: "item.completed", item: { ...item, status: "completed", exit_code: 0 } }));
  assert.deepEqual(started.map((e) => [e.type, e.text]), [["bash", "npm test"]]);
  assert.deepEqual(completed, []);
  // comando que FALHOU (status do item) não é erro do turno
  assert.deepEqual(mapCodexLine(JSON.stringify({ type: "item.completed", item: { ...item, status: "failed", exit_code: 1 } })), []);
});

test("uso do turno vira custo/tokens no done", () => {
  const [d] = mapCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } }));
  assert.equal(d.type, "done");
  assert.deepEqual(d.cost, { usd: 0, inTok: 1200, outTok: 300 });
});

test("chaves da conta vêm de <home>/.constellation/llm.env (homedir, não $HOME cru)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-codex-"));
  const old = process.env.HOME;
  try {
    mkdirSync(join(dir, ".constellation"), { recursive: true });
    writeFileSync(join(dir, ".constellation", "llm.env"), "ALT_AI_KEY=abc123\n# comentário\nlixo sem igual\nlower=x\n");
    process.env.HOME = dir;
    assert.deepEqual(loadLlmEnv(), { ALT_AI_KEY: "abc123" });
  } finally {
    if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
