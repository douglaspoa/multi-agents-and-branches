// Chips do planejador cobrem TODAS as opções numeradas da fala (bug 06/10: 8 frentes, 4 chips): `node --test app/tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/32-planner.js', import.meta.url), 'utf8');
const plChipsFull = new Function(src.slice(src.indexOf('function plChipsFull'), src.indexOf('let plAfterEdit')) + '\nreturn plChipsFull;')();

test('8 frentes numeradas na fala e só 4 chips → os chips viram as 8, na ordem', () => {
  const say = 'Ordem sugerida: 1) Skills — leituras; 2) Shadow Billing — 1 toggle; 3) Company 360 — escritas; 4) Companies (listagem) — 3 leituras; 5) Billing — escritas; 6) Shipping Modules — muitas; 7) IA/Benchmark — benchmark; 8) Explorer — 1 leitura. Por qual começamos?';
  const got = plChipsFull(say, ['1) Skills (tracer bullet)', '2) Shadow Billing', '3) Company 360', '5) Billing']);
  assert.equal(got.length, 8);
  assert.equal(got[3], '4) Companies (listagem)');
  assert.equal(got[7], '8) Explorer');
});

test('sem lista numerada fica o que a IA mandou (todas — a caixa de chips rola; mesa-bugs-2 A2); lista inline "1. A ou 2. B"', () => {
  assert.deepEqual(plChipsFull('Qual o objetivo?', ['a', 'b']), ['a', 'b']);
  assert.equal(plChipsFull('x', Array.from({ length: 10 }, (_, i) => 'c' + i)).length, 10, '10 opções = 10 chips (antes cortava em 8 calado)');
  assert.deepEqual(plChipsFull('Prefere 1. Web ou 2. iOS?', ['Web']), ['1) Web', '2) iOS']);
  assert.deepEqual(plChipsFull('', null), []);
});
