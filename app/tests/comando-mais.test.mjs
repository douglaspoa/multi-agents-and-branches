// Memória, skills e épico no chat: funções puras. Dados fictícios (repo público).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const JS = readFileSync(new URL('../src/js/89-comando-mais.js', import.meta.url), 'utf8');
const C = new Function(JS.slice(0, JS.indexOf('async function cmdMaisDo')) + '\nreturn { CMD_MAIS, cmdMemTipo, cmdMaisAcha };')();
test('tipo da nota sai do jeito de falar', () => {
  assert.equal(C.cmdMemTipo('decisão de arquitetura'), 'decisão'); assert.equal(C.cmdMemTipo('regra: sempre homol antes'), 'regra'); assert.equal(C.cmdMemTipo('cuidado com a VPN'), 'gotcha'); assert.equal(C.cmdMemTipo('como funciona o login'), 'contexto');
});
test('acha um item pelo nome, parte do nome ou palavras; ambíguo devolve as candidatas', () => {
  const L = [{ name:'revisao-de-pr' }, { name:'provas-na-ui' }, { name:'provas-de-api' }], n = x => x.name;
  assert.equal(C.cmdMaisAcha(L, n, 'revisão de PR').name, 'revisao-de-pr'); assert.equal(C.cmdMaisAcha(L, n, 'a skill provas na ui').name, 'provas-na-ui');
  assert.equal(C.cmdMaisAcha(L, n, 'provas').varios.length, 2); assert.equal(C.cmdMaisAcha(L, n, 'banco'), null); assert.equal(C.cmdMaisAcha(L, n, ''), null);
});
