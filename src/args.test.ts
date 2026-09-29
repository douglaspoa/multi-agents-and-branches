// node --test src/args.test.ts  (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./util/args.ts";

test("mensagem do chat que começa com '--' chega inteira ao agente (antes: virava 'true')", () => {
  const a = parseArgs(["talk", "t1", "--msg", "--force não, use rebase", "--repo", "/r", "--as-req"]);
  assert.equal(a.flags.msg, "--force não, use rebase");
  assert.equal(a.flags.repo, "/r");
  assert.equal(a.flags["as-req"], "true");
  assert.deepEqual(a._, ["talk", "t1"]);
});

test("requisitos com '--' e vazios não somem nem viram posicionais", () => {
  const a = parseArgs(["new", "--title", "x", "--requirement", "--dry-run deve funcionar", "--requirement", "", "--no-start"]);
  assert.deepEqual(a.multi.requirement, ["--dry-run deve funcionar", ""]);
  assert.equal(a.flags["no-start"], "true");
  assert.deepEqual(a._, ["new"]);
});

test("flags booleanas continuam booleanas", () => {
  const a = parseArgs(["new", "--light", "--no-start", "--engine", "claude", "--json"]);
  assert.equal(a.flags.light, "true");
  assert.equal(a.flags["no-start"], "true");
  assert.equal(a.flags.engine, "claude");
  assert.equal(a.flags.json, "true");
});
