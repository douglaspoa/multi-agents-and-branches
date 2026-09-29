// Agentes & Equipes (33-switcher-projetos.js): cabeçalho do .md importado, id único de equipe e
// remoção de agente das equipes. `node --test app/tests/` — carrega o trecho puro (@puro-agentes-inicio … fim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/33-switcher-projetos.js', import.meta.url), 'utf8');
const i = src.indexOf('// @puro-agentes-inicio'), j = src.indexOf('// @puro-agentes-fim');
assert.ok(i >= 0 && j > i);
const A = new Function(src.slice(i, j) + '\nreturn { agSlug, agFrontmatter, agFromMd, wfEnsureIds, wfDropAgent };')();

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

test('equipes sem id ganham ids únicos; id existente NUNCA é renomeado', () => {
  const ws = [{ id: '', name: 'Nova equipe' }, { id: 'nova-equipe', name: 'Antiga' }, { id: '', name: 'Nova equipe' }, { id: 'plano', name: 'Plano' }, { id: 'plano', name: 'Cópia' }];
  assert.equal(A.wfEnsureIds(ws), true);
  assert.equal(ws[1].id, 'nova-equipe');          // a existente fica com o dela
  assert.equal(ws[0].id, 'nova-equipe-2');        // a nova desvia do id reservado
  assert.equal(ws[2].id, 'nova-equipe-3');
  assert.deepEqual([ws[3].id, ws[4].id], ['plano', 'plano']); // existentes nunca mudam
  assert.equal(A.wfEnsureIds(ws), false);         // nada a fazer = nada mudou
});

test('cabeçalho vazio (---/---) e valores em bloco do YAML (> e |)', () => {
  assert.deepEqual(A.agFrontmatter('---\n---\nsó corpo'), { fm: {}, body: 'só corpo' });
  const r = A.agFrontmatter('---\nname: rev\ndescription: >\n  Revisa o PR\n  com calma.\nnotes: |\n  linha 1\n  linha 2\nmodel: sonnet\n---\nCorpo');
  assert.equal(r.fm.description, 'Revisa o PR com calma.');
  assert.equal(r.fm.notes, 'linha 1\nlinha 2');
  assert.equal(r.fm.model, 'sonnet');
  assert.equal(r.body, 'Corpo');
  const c = A.agFrontmatter('---\r\ndescription: >-\r\n  a\r\n  b\r\nname: x\r\n---\r\n');
  assert.equal(c.fm.description, 'a b'); assert.equal(c.fm.name, 'x');
});

test('agFromMd: sem nome no cabeçalho usa o arquivo sem .md; descrição entra na persona', () => {
  const a = A.agFromMd('revisor-pr.md', '---\ndescription: revisa PR\n---\nOlhe testes.');
  assert.equal(a.name, 'revisor-pr');
  assert.equal(a.persona, 'revisa PR Olhe testes.');
  assert.equal(a.engine, 'claude'); assert.equal(a.role, 'builder');
  assert.equal(A.agFromMd('x.MD', 'sem cabeçalho').name, 'x');
});

test('agente removido sai de todas as equipes', () => {
  const ws = [{ steps: ['vega', 'orion', 'lyra'] }, { steps: ['orion'] }, { steps: ['lyra'] }, {}];
  assert.equal(A.wfDropAgent(ws, 'orion'), 2);
  assert.deepEqual(ws.map(w => w.steps), [['vega', 'lyra'], [], ['lyra'], []]);
  assert.equal(A.wfDropAgent(ws, 'ninguem'), 0);
});
