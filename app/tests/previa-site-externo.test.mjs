// node --test app/tests/previa-site-externo.test.mjs — site de fora na Prévia vira aba de Navegador ao lado
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/js/57-navegador.js", import.meta.url), "utf8");
const a = src.indexOf("function nvIsLocalUrl"), b = src.indexOf("function nvNormUrl");
function load(cvOpenTop) {
  const toasts = [];
  const f = new Function("cvOpenTop", "toast", src.slice(a, b) + "; return { nvIsLocalUrl, nvExternalToCanvas };");
  return { ...f(cvOpenTop, (m) => toasts.push(m)), toasts };
}
test("local fica na Prévia; site de fora abre no Navegador dividindo à direita", () => {
  const calls = [];
  const { nvIsLocalUrl, nvExternalToCanvas, toasts } = load((d, o) => calls.push([d, o]));
  for (const u of ["http://localhost:5173/", "http://127.0.0.1:3000/", "http://app.localhost:8080/", "http://meu.test/"]) {
    assert.equal(nvIsLocalUrl(u), true, u);
    assert.equal(nvExternalToCanvas(u), false, u);
  }
  assert.equal(nvExternalToCanvas("https://youtube.com/"), true);
  assert.deepEqual(calls, [[{ kind: "web", url: "https://youtube.com/" }, { split: "right" }]]);
  assert.equal(toasts.length, 1);
});
test("sem o canvas (painel dividido em iframe), cai no comportamento antigo", () => {
  const f = new Function("toast", src.slice(a, b) + "; return nvExternalToCanvas;");
  assert.equal(f(() => {})("https://youtube.com/"), false);
});
