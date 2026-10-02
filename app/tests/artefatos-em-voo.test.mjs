// node --test app/tests/artefatos-em-voo.test.mjs — leitura em voo reaproveitada (travamento com 80+ provas)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/js/23-kanban-artefatos-editor.js", import.meta.url), "utf8");
const a = src.indexOf("const artInflight"), b = src.indexOf("function reqNorm");
test("list_artifacts e requirements.json: uma chamada por vez mesmo com render a cada segundo", async () => {
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const invoke = async (cmd) => { calls++; await gate; return cmd === "list_artifacts" ? [{ name: "x.png" }] : { text: "[]" }; };
  const invokeQuiet = invoke;
  const artifactsCache = {}, reqProofCache = {};
  const f = new Function("invoke", "invokeQuiet", "artifactsCache", "reqProofCache",
    src.slice(a, b).replace(/const reqProofCache=\{\};/, "") + "; return { loadArtifacts, loadReqProofs };");
  const { loadArtifacts, loadReqProofs } = f(invoke, invokeQuiet, artifactsCache, reqProofCache);
  const ps = [1, 2, 3, 4, 5].map(() => loadArtifacts("t", "merged"));
  const rs = [1, 2, 3].map(() => loadReqProofs("t"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2);
  release();
  const lists = await Promise.all(ps); await Promise.all(rs);
  assert.deepEqual(lists[4], [{ name: "x.png" }]);
  await loadArtifacts("t", "merged"); assert.equal(calls, 2); // cache
});

test("fila: no máximo 3 leituras de artefato ao mesmo tempo (boot com centenas de tarefas)", async () => {
  let live = 0, peak = 0, calls = 0;
  const invoke = async () => { calls++; live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return []; };
  const f = new Function("invoke", "invokeQuiet", "artifactsCache", "reqProofCache",
    src.slice(a, b).replace(/const reqProofCache=\{\};/, "") + "; return { loadArtifacts };");
  const { loadArtifacts } = f(invoke, invoke, {}, {});
  await Promise.all(Array.from({ length: 40 }, (_, i) => loadArtifacts("t" + i, "merged")));
  assert.equal(calls, 40);
  assert.ok(peak <= 3, "pico " + peak);
});
