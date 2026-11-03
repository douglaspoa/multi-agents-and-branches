// node --test app/tests/tarefa-duplicada.test.mjs — aviso antes de criar a mesma demanda 2× (14-issues-projeto)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const JS = readFileSync(new URL('../src/js/14-issues-projeto.js', import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const P = new Function(cut(JS, 'function trkTitleKey', 'async function trkBeforeNewTask') + '\nreturn { trkDupOf, trkTitleKey };')();

test('mesma demanda aberta (título igual, sem ligar pra acento/pontuação) → acha a que já existe', () => {
  const tasks = [
    { id: 'checkout-lento', title: 'Lentidão no checkout após trocar o gateway (#12/#13)', status: 'review' },
    { id: 'velha', title: 'Cupom no checkout', status: 'merged' },
    { id: 'fechada', title: 'Frete grátis', status: 'review', flag: 'closed' },
  ];
  assert.equal(P.trkDupOf({ title: 'lentidao no checkout apos trocar o gateway #12 #13' }, tasks).id, 'checkout-lento');
  assert.equal(P.trkDupOf({ title: 'Cupom no checkout' }, tasks), null, 'integrada não conta');
  assert.equal(P.trkDupOf({ title: 'Frete grátis' }, tasks), null, 'encerrada não conta');
  assert.equal(P.trkDupOf({ title: 'Outra coisa' }, tasks), null);
  assert.equal(P.trkDupOf({ title: '' }, tasks), null);
});

test('só pergunta quando é a pessoa criando (ask); o caminho automático não pergunta e o cartão religa a tarefa que já existe', () => {
  assert.match(JS, /async function trkBeforeNewTask\(payload, o\)\{\n  if\(o&&o\.ask\)\{ const d=trkDupOf/);
  const planner = readFileSync(new URL('../src/js/32-planner.js', import.meta.url), 'utf8');
  assert.equal((planner.match(/trkBeforeNewTask\(payload\)\)/g) || []).length, 0, 'toda criação pela tela pergunta');
  const times = readFileSync(new URL('../src/js/43-espaco-times.js', import.meta.url), 'utf8');
  assert.match(times, /const localId=ja \? ja\.id : await invoke\('new_task'/);
});
