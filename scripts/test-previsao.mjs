// Testes da previsão de tempo/tokens (app/src/js/33-previsao.js) — funções puras em node:vm.
// uso: node scripts/test-previsao.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../app/src/js/33-previsao.js", import.meta.url), "utf8");
const ctx = vm.createContext({ console });
vm.runInContext(src, ctx);
const { estCalibrate, estCompute } = ctx;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n    " + (e && e.message)); }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const hist = (n, o = {}) => Array.from({ length: n }, (_, i) => ({
  taskId: "t" + i, model: "claude-opus-5-5", status: "merged", nReq: 2, points: 6,
  usd: 1.2, inTok: 600000, outTok: 12000, ms: 6 * 60000,
  roles: [{ role: "builder", usd: 0.9, inTok: 450000, outTok: 9000, ms: 4 * 60000 }, { role: "reviewer", usd: 0.3, inTok: 150000, outTok: 3000, ms: 2 * 60000 }],
  ...o,
}));

console.log("previsão:");
t("semente com <5 tarefas", () => {
  const c = estCalibrate(hist(4), "claude-opus-5-5");
  assert.equal(c.seeded, true);
  assert.equal(c.rates.inTok, 300000); assert.equal(c.rates.outTok, 8000); assert.equal(c.rates.min, 3); assert.equal(c.rates.usd, 0.60);
  assert.equal(estCalibrate([], "claude-sonnet-5").rates.usd, 0.25);
  assert.equal(estCalibrate([], "claude-haiku-4-5").rates.usd, 0.06);
  assert.equal(estCalibrate([], "gpt-x").rates.usd, 0.30);
});
t("calibração com ≥5 tarefas (mesma família)", () => {
  const c = estCalibrate(hist(5), "claude-opus-5-5");
  assert.equal(c.seeded, false); assert.equal(c.n, 5); assert.equal(c.scope, "familia");
  near(c.rates.inTok, 100000); near(c.rates.outTok, 2000); near(c.rates.usd, 0.2); near(c.rates.min, 1);
});
t("calibração cai pra todas as famílias quando a própria tem <5", () => {
  const c = estCalibrate(hist(5), "claude-sonnet-5");
  assert.equal(c.seeded, false); assert.equal(c.scope, "todas");
});
t("histórico sem points usa 3×nReq", () => {
  const c = estCalibrate(hist(5, { points: null, nReq: 4 }), "opus");
  near(c.rates.inTok, 600000 / 12);
});
t("só tarefas terminadas (review/done/merged) com custo calibram", () => {
  const h = hist(3).concat(hist(3, { usd: 0 }), hist(3, { status: "running" }), hist(3, { status: "queued" }), hist(3, { status: "error" }));
  assert.equal(estCalibrate(h, "opus").seeded, true);
  const ok = hist(2).concat(hist(2, { status: "review" }), hist(1, { status: "done" }));
  assert.equal(estCalibrate(ok, "opus").seeded, false);
});
t("tokens calibrados mas <5 tarefas com ms → timeSeeded", () => {
  const c = estCalibrate(hist(5, { ms: 0 }), "opus");
  assert.equal(c.seeded, false); assert.equal(c.timeSeeded, true); assert.equal(c.rates.min, 3);
  assert.equal(estCompute([{ text: "a", size: "M" }], ["builder"], c).timeSeeded, true);
  assert.equal(estCalibrate(hist(5), "opus").timeSeeded, false);
});
t("faixa = ponto × [0,7 ; 1,5]", () => {
  const e = estCompute([{ text: "a", size: "G" }], ["builder"], estCalibrate([], "opus"));
  near(e.total.min, 24); near(e.total.minLo, 24 * 0.7); near(e.total.minHi, 24 * 1.5);
  near(e.items[0].minLo, e.items[0].min * 0.7); near(e.items[0].minHi, e.items[0].min * 1.5);
});
t("soma por requisito = total", () => {
  const e = estCompute([{ text: "a", size: "P" }, { text: "b", size: "M" }, { text: "c", size: "G" }], ["builder"], estCalibrate(hist(6), "opus"));
  assert.equal(e.points, 12);
  for (const k of ["inTok", "outTok", "tok", "usd", "min"]) near(e.items.reduce((s, x) => s + x[k], 0), e.total[k]);
});
t("quebra por etapa soma 100%", () => {
  const seeded = estCompute([{ text: "a", size: "M" }], ["planner", "builder", "reviewer", "docs"], estCalibrate([], "opus"));
  near(seeded.roles.reduce((s, r) => s + r.share, 0), 1);
  near(seeded.roles.reduce((s, r) => s + r.tok, 0), seeded.total.tok);
  near(seeded.roles.find((r) => r.role === "builder").share, 0.6 / 1.05);
  const obs = estCompute([{ text: "a", size: "M" }], ["builder", "reviewer"], estCalibrate(hist(5), "opus"));
  near(obs.roles.reduce((s, r) => s + r.share, 0), 1);
  near(obs.roles.find((r) => r.role === "builder").share, 0.75);
  const one = estCompute([{ text: "a", size: "M" }], ["builder"], estCalibrate(hist(5), "opus"));
  near(one.roles[0].share, 1);
});
t("item sem tamanho (ou inválido) = M", () => {
  const e = estCompute([{ text: "a" }, { text: "b", size: "XL" }, { text: "c", size: "g" }], ["builder"], estCalibrate([], "opus"));
  assert.deepEqual(Array.from(e.items, (x) => x.size), ["M", "M", "G"]);
  assert.equal(e.points, 3 + 3 + 8);
});

console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
