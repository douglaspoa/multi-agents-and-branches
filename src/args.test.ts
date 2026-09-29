// node --test src/args.test.ts  (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOOL_FLAGS, TEXT_FLAGS, parseArgs } from "./util/args.ts";

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

test("flag de texto SEM valor: vira '' (não 'true') e não engole a próxima flag", () => {
  const a = parseArgs(["new", "--title", "--repo", "/r", "--objective"]);
  assert.equal(a.flags.title, "");
  assert.equal(a.flags.repo, "/r");
  assert.equal(a.flags.objective, "");
  // valor vazio explícito
  assert.equal(parseArgs(["x", "--base", ""]).flags.base, "");
  assert.equal(parseArgs(["x", "--issue", "", "--light"]).flags.issue, "");
  assert.deepEqual(parseArgs(["x", "--foo", ""])._, ["x"], "'' não vira posicional");
});

test("flags booleanas continuam booleanas", () => {
  const a = parseArgs(["new", "--light", "--no-start", "--engine", "claude", "--json"]);
  assert.equal(a.flags.light, "true");
  assert.equal(a.flags["no-start"], "true");
  assert.equal(a.flags.engine, "claude");
  assert.equal(a.flags.json, "true");
});

test("toda flag COM VALOR que o app (lib.rs) manda pro motor é tratada como texto", () => {
  const rs = readFileSync(new URL("../app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const valued = new Set<string>();
  // push_opt(&mut args, "--x", …) e os laços `for (flag, xs) in [("--cover", …)]`
  for (const m of rs.matchAll(/push_opt\(&mut args, "--([a-z-]+)"/g)) valued.add(m[1]);
  for (const m of rs.matchAll(/\("--([a-z-]+)", &[a-z_]+\)/g)) valued.add(m[1]);
  // args.push("--x") seguido de args.push(<valor>)
  for (const m of rs.matchAll(/args\.push\("--([a-z-]+)"\.to_string\(\)\);\s*args\.push\(/g)) valued.add(m[1]);
  for (const f of ["msg", "agent", "id", "title", "repo", "kind", "pr", "engine", "approve"]) valued.add(f);
  assert.ok(valued.size > 15, [...valued].join(","));
  // o mesmo padrão aparece montando a linha do `claude` (não do motor)
  const claudeCli = new Set(["permission-mode", "resume", "model", "append-system-prompt", "output-format"]);
  for (const f of ["deliverable", "requirement", "ref", "plan-approval"]) assert.ok(valued.has(f), `lib.rs deveria mandar --${f}`);
  const missing = [...valued].filter((f) => !TEXT_FLAGS.has(f) && f !== "artifact-doc" && !claudeCli.has(f));
  assert.deepEqual(missing, []);
  for (const f of BOOL_FLAGS) assert.ok(!TEXT_FLAGS.has(f), f);
});
