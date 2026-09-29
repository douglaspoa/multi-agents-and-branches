// Skills (13-skills-projetos.js): a volta do "ligar/desligar todas" é por NOME, não por posição.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/13-skills-projetos.js', import.meta.url), 'utf8');
const i = src.indexOf('// @puro-skills-inicio'), j = src.indexOf('// @puro-skills-fim');
assert.ok(i >= 0 && j > i);
const S = new Function(src.slice(i, j) + '\nreturn { skSnapshot, skRestore };')();

test('restaura por nome mesmo com a lista reordenada ou com skill nova', () => {
  const list = [{ name: 'a', active: true }, { name: 'b', active: false }, { name: 'c', active: false }];
  const snap = S.skSnapshot(list);
  list.forEach(s => { s.active = true; });
  const reordered = [list[2], { name: 'nova', active: true }, list[0], list[1]];
  S.skRestore(reordered, snap);
  assert.deepEqual(reordered.map(s => [s.name, s.active]), [['c', false], ['nova', true], ['a', true], ['b', false]]);
  assert.deepEqual(S.skSnapshot(null), {});
});
