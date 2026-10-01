// node --test src/engine/protect.test.ts  (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyRules, protectArgs, protectEnabled, SECRET_PATHS, DANGEROUS_BASH } from "./protect.ts";

test("protegido por padrão; só '0'/off/false/livre desliga", () => {
  assert.equal(protectEnabled({}), true);
  assert.equal(protectEnabled({ CARDUME_PROTECT: "1" }), true);
  assert.equal(protectEnabled({ CARDUME_PROTECT: "" }), true);
  for (const v of ["0", "off", "false", "livre", " LIVRE "]) assert.equal(protectEnabled({ CARDUME_PROTECT: v }), false, v);
});

test("args: --disallowedTools seguido de uma regra por argv", () => {
  const a = protectArgs(true);
  assert.equal(a[0], "--disallowedTools");
  assert.equal(a.length, 1 + SECRET_PATHS.length * 2 + DANGEROUS_BASH.length);
  // nenhuma regra começa com "-" (senão o parser do CLI a leria como flag)
  assert.ok(a.slice(1).every((r) => !r.startsWith("-")));
  // formato Tool(padrão), sem vírgula (vírgula separa regras no CLI)
  assert.ok(a.slice(1).every((r) => /^(Read|Edit|Bash)\(.+\)$/.test(r) && !r.includes(",")));
  assert.deepEqual(protectArgs(false), []);
});

test("cobre segredos e comandos destrutivos pedidos pela mesa", () => {
  const r = denyRules();
  for (const must of [
    "Read(**/.env)", "Edit(**/.env)", "Read(**/*.pem)", "Read(**/id_rsa*)", "Read(~/.ssh/**)", "Read(~/.aws/**)",
    "Bash(rm -rf /)", "Bash(git push --force*)", "Bash(git push -f*)", "Bash(curl * | sh*)", "Bash(sudo *)",
  ]) assert.ok(r.includes(must), must);
  // .env.example continua legível (o agente precisa saber quais variáveis existem)
  assert.ok(!r.some((x) => x === "Read(**/.env*)" || x === "Read(**/.env.*)"));
  // rm -rf de QUALQUER caminho absoluto não pode estar bloqueado (a worktree é absoluta)
  assert.ok(!r.includes("Bash(rm -rf /*)"));
});

test("lib.rs espelha a mesma lista (planner / nova issue / conector)", () => {
  const rs = readFileSync(fileURLToPath(new URL("../../app/src-tauri/src/lib.rs", import.meta.url)), "utf8");
  const m = rs.match(/const PROTECT_DENY: \[&str; (\d+)\] = \[([\s\S]*?)\];/);
  assert.ok(m, "PROTECT_DENY não encontrado no lib.rs");
  const items = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  assert.deepEqual(items, denyRules());
  assert.equal(Number(m[1]), denyRules().length);
});
