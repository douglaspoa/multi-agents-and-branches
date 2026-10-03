// O ciclo da tarefa (mesa 03/10) no app: `node --test app/tests/ciclo.test.mjs`
// Funções puras de 60-ciclo.js (espelho de src/lifecycle.ts, conferido pelos fixtures de tests/fixtures/ciclo-golden/),
// a seção "precisa de você" (inline, não modal) e a liberação de teto com valor + motivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/60-ciclo.js', import.meta.url), 'utf8');
const teto = readFileSync(new URL('../src/js/53-teto-protecao.js', import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const gold = (f) => JSON.parse(readFileSync(new URL('../../tests/fixtures/ciclo-golden/' + f, import.meta.url), 'utf8'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctx(extra = {}) {
  const calls = [];
  const c = {
    calls, console, esc, escA: esc, toast: (m, k) => calls.push(['toast', m, k]), lastSig: 'x', refresh: async () => {},
    fmtCost: (x) => 'US$ ' + (+x).toFixed(2).replace('.', ','), costCapDefault: () => 5,
    budgetBusy: new Set(), state: { tasks: [], pending: [] },
    invoke: async (cmd, args) => { calls.push([cmd, args]); return null; },
    taskCost: () => ({ usd: 1.6 }),
    ...extra,
  };
  vm.createContext(c);
  vm.runInContext(cut(src, '// @ciclo-puro-inicio', '// @ciclo-puro-fim'), c);
  return c;
}
const run = (c, code) => vm.runInContext(code, c);

test('golden teto.json: capCheck, effectiveCap, parseRelease e releaseCheck iguais ao motor', () => {
  const c = ctx(), g = gold('teto.json');
  for (const [s, cap, e] of g.capCheck) assert.equal(run(c, `capCheck(${JSON.stringify(s)}, ${JSON.stringify(cap)})`), e);
  for (const [t, st, e] of g.effectiveCap) assert.equal(run(c, `effectiveCap(${JSON.stringify(t)}, ${JSON.stringify(st)})`), e);
  for (const [t, e] of g.parseRelease) {
    const r = run(c, `parseRelease(${JSON.stringify(t)})`);
    assert.equal(r.ok, e.ok, t);
    if (e.ok) { assert.equal(r.usd, e.usd, t); assert.equal(r.reason, e.reason, t); }
  }
  for (const [u, t, e] of g.releaseCheck) {
    const r = run(c, `releaseCheck(${JSON.stringify(u)}, ${JSON.stringify(t)})`);
    assert.equal(r.ok, e.ok, `${u}/${t}`);
  }
});

function decCtx() {
  const c = ctx({ budgetOf: () => 2, budgetPrompt: () => 'A tarefa já usou US$ 1,60 de US$ 2,00 (80% do teto).\n\nresto' });
  run(c, cut(src, '// @ciclo-decisao-inicio', '// @ciclo-decisao-fim'));
  return c;
}

test('"precisa de você": teto parado entre etapas (motor), pausado no meio do turno (app) e nada a decidir', () => {
  const c = decCtx();
  const engine = { id: 't', status: 'needs-you', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'etapa' }, needsYou: { kind: 'teto', text: 'parei antes de Nyx revisar' } } };
  assert.deepEqual(JSON.parse(JSON.stringify(run(c, `cicloDecision(${JSON.stringify(engine)})`))), { kind: 'teto', text: 'parei antes de Nyx revisar', hit: engine.spec.budgetHit });
  const app = { id: 't', status: 'paused', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'paused' } } };
  assert.equal(run(c, `cicloDecision(${JSON.stringify(app)})`).kind, 'teto');
  assert.equal(run(c, `cicloDecision(${JSON.stringify({ id: 't', status: 'running', spec: {} })})`), null);
  // marca velha numa tarefa que voltou a rodar não pede decisão
  assert.equal(run(c, `cicloDecision(${JSON.stringify({ id: 't', status: 'running', spec: { budgetHit: { mode: 'paused' } } })})`), null);
  for (const kind of ['rodadas', 'veredito']) assert.equal(run(c, `cicloDecision(${JSON.stringify({ id: 't', status: 'needs-you', spec: { needsYou: { kind, text: 'x' } } })})`).kind, kind);
});

test('a liberação é uma SEÇÃO da aba (não modal): valor + motivo, gasto até agora, parar aqui', () => {
  const c = decCtx();
  const t = { id: 't', status: 'needs-you', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'etapa' }, needsYou: { kind: 'teto', text: 'parei antes de Nyx revisar' } } };
  const h = run(c, `cicloDecisionHtml(${JSON.stringify(t)}, cicloDecision(${JSON.stringify(t)}), { why:'falta <b>' })`);
  assert.match(h, /^<section class="cicdec" id="cicDecide" aria-label="Precisa de você: teto de custo">/);
  assert.doesNotMatch(h, /overlay|modal|role="dialog"/, 'nunca modal');
  assert.match(h, /<b>Precisa de você<\/b>/);
  assert.match(h, /parei antes de Nyx revisar/);
  assert.match(h, /Gasto até agora <b>US\$ 1,60<\/b> de <b>US\$ 2,00<\/b>/);
  assert.match(h, /id="cicUsd"/); assert.match(h, /id="cicWhy"[^>]*value="falta &lt;b&gt;"/, 'o que foi digitado volta escapado');
  assert.match(h, /liberar e seguir/); assert.match(h, /parar aqui/);
  assert.match(h, /role="alert"/);
  // rodadas: seguir pra prova (com motivo), mais uma rodada, parar
  const r = { id: 't', status: 'needs-you', spec: { needsYou: { kind: 'rodadas', text: 'Nyx pediu mudanças na 2ª rodada' } } };
  const hr = run(c, `cicloDecisionHtml(${JSON.stringify(r)}, cicloDecision(${JSON.stringify(r)}), {})`);
  assert.match(hr, /Revisão pediu a 3ª rodada/);
  assert.match(hr, /seguir pra prova/); assert.match(hr, /mais uma rodada/);
  assert.doesNotMatch(hr, /melhorou/i);
});

test('budgetRelease: sem motivo nada muda; pouco demais recusa dizendo o mínimo; ok grava valor+motivo e retoma do jeito certo', async () => {
  const m = teto.match(/async function budgetRelease\([^)]*\)\{[\s\S]*?\n\}\n/); assert.ok(m);
  const mk = (t, spent) => { const c = ctx({ budgetOf: () => 2, taskCost: () => ({ usd: spent }) }); run(c, m[0] + '\nthis.budgetRelease=budgetRelease;'); return c; };
  const t = { id: 't', status: 'needs-you', spec: { budgetUsd: 2, budgetHit: { usd: 1.6, cap: 2, mode: 'etapa' }, budgetReleases: [{ usd: 1, reason: 'antes', at: 1, capBefore: 1, capAfter: 2 }] } };
  let c = mk(t, 1.6);
  await assert.rejects(c.budgetRelease(t, '2', 'sim'), /motivo/);
  await assert.rejects(c.budgetRelease(t, '', 'falta o teste de login'), /quanto liberar/);
  assert.equal(c.calls.filter((x) => x[0] === 'patch_task_spec').length, 0, 'nada gravado');
  // gasto 1,90 de 2,00: liberar 0,01 deixaria em 94% — pararia de novo na hora; diz o mínimo (0,39 → 80% de 2,39 ≥ 1,90)
  await assert.rejects(mk(t, 1.9).budgetRelease(t, '0,01', 'falta o teste de login'), /libere pelo menos US\$ 0,39/);
  await c.budgetRelease(t, '1,5', 'falta o teste de login');
  const p = c.calls.find((x) => x[0] === 'patch_task_spec')[1].patch;
  assert.equal(p.budgetUsd, 3.5);
  assert.equal(p.budgetHit, null); assert.equal(p.needsYou, null);
  assert.equal(p.budgetReleases.length, 2, 'acumula (o PR lista todas)');
  assert.deepEqual({ ...p.budgetReleases[1], at: 0 }, { usd: 1.5, reason: 'falta o teste de login', at: 0, capBefore: 2, capAfter: 3.5 });
  assert.ok(c.calls.some((x) => x[0] === 'start_task'), 'parada entre etapas (motor) → ▶ de novo');
  // pausada no meio do turno (app) → continua o mesmo processo
  const tp = { id: 't', status: 'paused', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'paused' } } };
  c = mk(tp, 1.6);
  await c.budgetRelease(tp, 2, 'o build demorou mais');
  assert.ok(c.calls.some((x) => x[0] === 'resume_task'));
  assert.ok(!c.calls.some((x) => x[0] === 'start_task'));
});

test('teto sempre ligado no app: budgetOf com 0 vira o padrão; a vigia pausa a 80% (não a 100%)', () => {
  const b = teto.match(/function budgetOf\(t\)\{[^\n]*\n/)[0];
  const c = ctx(); run(c, b);
  assert.equal(run(c, 'budgetOf({ spec:{ budgetUsd:0 } })'), 5);
  assert.equal(run(c, 'budgetOf({ spec:{ budgetUsd:3 } })'), 3);
  assert.match(teto, /if\(!active \|\| capCheck\(spent, cap\)==='ok'\) continue;/, 'a vigia usa o capCheck (80%)');
  assert.doesNotMatch(teto, /BUDGET_STEP_TXT/, 'sem "Continuar com mais US$ X" de um clique');
});
