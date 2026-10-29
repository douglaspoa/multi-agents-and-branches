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
