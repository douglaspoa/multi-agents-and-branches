// node --test app/tests/epico-local-nuvem.test.mjs — épico só local (piloto) não quebra a publicação na nuvem
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/js/42-nuvem-sync-mobile.js", import.meta.url), "utf8");
const ep = readFileSync(new URL("../src/js/46-epico-time.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("function cloudEpicId"), src.indexOf("\n", src.indexOf("function cloudEpicId")));
const cloudEpicId = new Function(fn + "; return cloudEpicId;")();
test("cloudEpicId: uuid passa, id local do piloto vira null", () => {
  assert.equal(cloudEpicId("piloto-pou-virtual"), null);
  assert.equal(cloudEpicId(""), null);
  assert.equal(cloudEpicId(undefined), null);
  assert.equal(cloudEpicId("3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab"), "3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab");
});
test("autopub/backfill e o tick de épicos só mandam epic_id da nuvem", () => {
  assert.doesNotMatch(src, /epic_id:\(t\.epic&&t\.epic\.epicId\)\|\|null/);
  assert.equal((src.match(/epic_id:cloudEpicId\(/g) || []).length, 2);
  assert.match(ep, /map\(t=>cloudEpicId\(t\.epic&&t\.epic\.epicId\)\)/);
  assert.match(ep, /if\(cloudEpicId\(epicId\)\) try\{ sibs=await sbGet/);
});
