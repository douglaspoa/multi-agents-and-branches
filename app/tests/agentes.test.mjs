// Agentes & Equipes (33-switcher-projetos.js): cabeçalho do .md importado, id único de equipe e
// remoção de agente das equipes. `node --test app/tests/` — carrega o trecho puro (@puro-agentes-inicio … fim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/33-switcher-projetos.js', import.meta.url), 'utf8');
const i = src.indexOf('// @puro-agentes-inicio'), j = src.indexOf('// @puro-agentes-fim');
assert.ok(i >= 0 && j > i);
const A = new Function(src.slice(i, j) + '\nreturn { agSlug, agFrontmatter, wfEnsureIds, wfDropAgent };')();

test('frontmatter com LF', () => {
  const r = A.agFrontmatter('---\nname: revisor\ndescription: "revisa PR"\nmodel: sonnet\n---\n\nVocê revisa.\n');
  assert.equal(r.fm.name, 'revisor');
  assert.equal(r.fm.description, 'revisa PR');
  assert.equal(r.fm.model, 'sonnet');
  assert.equal(r.body, 'Você revisa.');
});

test('frontmatter com CRLF e BOM (arquivo do Windows) também é lido', () => {
  const r = A.agFrontmatter('﻿---\r\nname: testador\r\nrole: tester\r\n---\r\nEscreve testes.\r\n');
  assert.equal(r.fm.name, 'testador');
  assert.equal(r.fm.role, 'tester');
  assert.equal(r.body, 'Escreve testes.');
});

test('sem cabeçalho: tudo vira corpo; cabeçalho sem corpo não quebra', () => {
  assert.deepEqual(A.agFrontmatter('só texto'), { fm: {}, body: 'só texto' });
  const r = A.agFrontmatter('---\nname: x\n---');
  assert.equal(r.fm.name, 'x');
  assert.equal(r.body, '');
});

test('equipes com o mesmo nome ganham ids diferentes; id existente é mantido', () => {
  const ws = [{ id: '', name: 'Nova equipe' }, { id: '', name: 'Nova equipe' }, { id: 'plano', name: 'Plano' }, { id: 'plano', name: 'Cópia' }];
  A.wfEnsureIds(ws);
  const ids = ws.map(w => w.id);
  assert.equal(ids[0], 'nova-equipe');
  assert.equal(ids[1], 'nova-equipe-2');
  assert.equal(ids[2], 'plano');
  assert.notEqual(ids[3], 'plano');
  assert.equal(new Set(ids).size, ids.length);
});

test('agente removido sai de todas as equipes', () => {
  const ws = [{ steps: ['vega', 'orion', 'lyra'] }, { steps: ['orion'] }, { steps: ['lyra'] }, {}];
  assert.equal(A.wfDropAgent(ws, 'orion'), 2);
  assert.deepEqual(ws.map(w => w.steps), [['vega', 'lyra'], [], ['lyra'], []]);
  assert.equal(A.wfDropAgent(ws, 'ninguem'), 0);
});
