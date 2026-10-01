// node --test src/engine/claude-usage.test.ts  (npm test)
// Medidor do plano: o `rate_limit_event` do stream-json do Claude Code vira o último estado da janela em
// ~/.constellation/usage/claude-<rateLimitType>.json (um arquivo por janela, escrita atômica). Formato fixado pelo
// golden compartilhado com o Rust (tests/fixtures/plan-usage-golden/claude-rate-limit.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapLine, rateLimitOf, rateLimitRecord, recordClaudeRateLimit } from "./claude.ts";

const GOLDEN = JSON.parse(readFileSync(new URL("../../tests/fixtures/plan-usage-golden/claude-rate-limit.json", import.meta.url), "utf8")) as
  { name: string; line: string; now: number; file: string | null; record: Record<string, unknown> | null }[];

test("golden: linha do stream → arquivo da janela e conteúdo (mesmo formato do writer Rust)", () => {
  for (const g of GOLDEN) {
    const dir = mkdtempSync(join(tmpdir(), "starfork-usage-"));
    try {
      const rl = rateLimitOf(g.line);
      if (g.record === null) { assert.equal(rl, null, g.name); continue; }
      assert.ok(rl, g.name);
      assert.deepEqual(rateLimitRecord(rl, g.now), g.record, g.name);
      recordClaudeRateLimit(rl, dir, g.now);
      assert.deepEqual(readdirSync(dir), [g.file], g.name + " (nenhum .tmp sobrando)");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, g.file!), "utf8")), g.record, g.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("mapLine: rate_limit_event não vira evento da tarefa", () => {
  assert.deepEqual(mapLine(GOLDEN[1].line), []);
});

test("um arquivo por janela: gravar uma janela não apaga a outra; a mesma janela sobrescreve", () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-usage-"));
  try {
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", resetsAt: 100 }, dir, 1000);
    recordClaudeRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8 }, dir, 2000);
    recordClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 300 }, dir, 3000);
    assert.deepEqual(readdirSync(dir).sort(), ["claude-five_hour.json", "claude-seven_day.json"]);
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-five_hour.json"), "utf8")).status, "rejected");
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-seven_day.json"), "utf8")).utilization, 0.8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // pasta impossível: engole o erro
  assert.doesNotThrow(() => recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour" }, "/dev/null/x"));
  assert.equal(existsSync("/dev/null/x"), false);
});
