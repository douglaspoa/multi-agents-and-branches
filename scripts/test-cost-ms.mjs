// Testes da captura de duração por turno (cost.ms): claude.ts → evento done → Store.addCost.
// uso: node scripts/test-cost-ms.mjs   (Node ≥22.6: importa .ts com type stripping)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mapLine } from "../src/engine/claude.ts";
import { Store } from "../src/store.ts";

let fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n    " + (e && e.message)); }
}

console.log("cost.ms:");
t("evento result com duration_ms vira cost.ms", () => {
  const evs = mapLine(JSON.stringify({ type: "result", is_error: false, result: "ok", total_cost_usd: 0.1, duration_ms: 1234, usage: { input_tokens: 10, output_tokens: 2 } }));
  const done = evs.find((e) => e.type === "done");
  assert.ok(done && done.cost, "sem evento done com custo");
  assert.equal(done.cost.ms, 1234);
});
t("Store.addCost grava e devolve ms", () => {
  const dir = mkdtempSync(join(tmpdir(), "cardume-cost-ms-"));
  try {
    const s = new Store(join(dir, "state.sqlite"));
    s.addCost("t1", "Agente", "builder", 0.1, 10, 2, 1234);
    const row = s.db.prepare("SELECT SUM(ms) AS ms FROM cost WHERE task_id='t1'").get();
    s.close();
    assert.equal(Number(row.ms), 1234);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

process.exit(fail ? 1 : 0);
