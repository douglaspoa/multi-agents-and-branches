// node --test app/tests/publicar-release.test.mjs — publicar release nunca manda token vazio
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/js/33-switcher-projetos.js", import.meta.url), "utf8");
test("publicar: sem access_token renova a sessão; sem conta, erro humano (nunca 'missing required key token')", () => {
  const i = src.indexOf("$id('pubGo').onclick"); const body = src.slice(i, src.indexOf("publish_release", i) + 80);
  assert.match(body, /sbRefresh\(\)/);
  assert.match(body, /entre de novo na sua conta/);
  assert.doesNotMatch(body, /SB\.sess\(\)\.access_token/);
});
