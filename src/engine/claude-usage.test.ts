// node --test src/engine/claude-usage.test.ts  (npm test)
// Medidor do plano: o `rate_limit_event` do stream-json do Claude Code vira o último estado POR janela
// em ~/.constellation/usage/claude.json (escrita atômica). Nada de API de uso nem token do Keychain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapLine, rateLimitOf, recordClaudeRateLimit } from "./claude.ts";

const ev = (info: Record<string, unknown>) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

test("rateLimitOf: allowed sem utilization (normal) — estado + reinício, sem porcentagem inventada", () => {
  const rl = rateLimitOf(ev({ status: "allowed", resetsAt: 1790884800, rateLimitType: "five_hour", isUsingOverage: false }));
  assert.deepEqual(rl, { status: "allowed", rateLimitType: "five_hour", resetsAt: 1790884800 });
  assert.equal(rl && "utilization" in rl, false);
});

test("rateLimitOf: allowed_warning com utilization e rejected; linhas que não são o evento → null", () => {
  assert.deepEqual(rateLimitOf(ev({ status: "allowed_warning", resetsAt: 10, rateLimitType: "seven_day", utilization: 0.92 })),
    { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: 10, utilization: 0.92 });
  assert.equal(rateLimitOf(ev({ status: "rejected" }))?.rateLimitType, "five_hour", "sem tipo → janela de 5 h");
  assert.equal(rateLimitOf(ev({ status: "qualquer" })), null);
  assert.equal(rateLimitOf('{"type":"result"}'), null);
  assert.equal(rateLimitOf("lixo"), null);
});

test("mapLine: rate_limit_event não vira evento da tarefa", () => {
  assert.deepEqual(mapLine(ev({ status: "allowed_warning", utilization: 0.95 })), []);
});

test("recordClaudeRateLimit: último estado por janela, escrita atômica, sobrescreve só a janela do evento", () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-usage-"));
  const f = join(dir, "usage", "claude.json");
  try {
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", resetsAt: 100 }, f, 1000);
    recordClaudeRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: 200, utilization: 0.8 }, f, 2000);
    recordClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 300 }, f, 3000);
    const o = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(o.last, "five_hour");
    assert.equal(o.updatedAt, 3000);
    assert.deepEqual(o.windows.five_hour, { status: "rejected", at: 3000, resetsAt: 300 });
    assert.deepEqual(o.windows.seven_day, { status: "allowed_warning", at: 2000, resetsAt: 200, utilization: 0.8 });
    assert.deepEqual(readdirSync(join(dir, "usage")), ["claude.json"], "nenhum .tmp sobrando");
    // arquivo corrompido: recomeça (nunca derruba a tarefa)
    writeFileSync(f, "{quebrado");
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour" }, f, 4000);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).windows, { five_hour: { status: "allowed", at: 4000 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // pasta impossível: engole o erro
  assert.doesNotThrow(() => recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour" }, "/dev/null/x/claude.json"));
  assert.equal(existsSync("/dev/null/x"), false);
});
