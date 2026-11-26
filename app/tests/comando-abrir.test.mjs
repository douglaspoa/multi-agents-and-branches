// Comando · abrir no próprio Starfork (89-comando-abrir.js). Dados fictícios.
// `node --test app/tests/comando-abrir.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JS = readFileSync(new URL('../src/js/89-comando-abrir.js', import.meta.url), 'utf8');
const CMDJS = readFileSync(new URL('../src/js/89-comando.js', import.meta.url), 'utf8');
const AGJS = readFileSync(new URL('../src/js/89-comando-agente.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const puro = JS.slice(JS.indexOf('// @abrir-puro-inicio'), JS.indexOf('// @abrir-puro-fim'));
const P = new Function(puro + '; return { cmdAbrirTipo, cmdAbrirEscolhe, cmdAbrirQuer, cmdAbrirCodigos };')();

test('tipo do entregável pelo nome', () => {
  assert.equal(P.cmdAbrirTipo('proof-1.PNG'), 'imagem');
  assert.equal(P.cmdAbrirTipo('demo.mp4'), 'vídeo');
  assert.equal(P.cmdAbrirTipo('relatorio.pdf'), 'pdf');
  assert.equal(P.cmdAbrirTipo('mockup.html'), 'página');
  assert.equal(P.cmdAbrirTipo('tests.md'), 'documento');
});

test('escolhe: nome exato, pedaço, palavras e empate', () => {
  const fs = [{ path: 'src/checkout/Frete.tsx' }, { path: 'src/checkout/Cupom.tsx' }, { path: 'src/api/frete.test.ts' }];
  const por = (q) => P.cmdAbrirEscolhe(fs, (f) => f.path, q);
  assert.equal(por('Cupom.tsx').um.path, 'src/checkout/Cupom.tsx');
  assert.equal(por('cupom').um.path, 'src/checkout/Cupom.tsx');
  assert.equal(por('frete').varios.length, 2, 'dois arquivos têm "frete": pergunta qual');
  assert.equal(por('frete test').um.path, 'src/api/frete.test.ts');
  assert.deepEqual(por('pagamento'), { nenhum: true });
  assert.equal(por('').varios.length, 3);
  assert.equal(P.cmdAbrirEscolhe([fs[0]], (f) => f.path, '').um.path, 'src/checkout/Frete.tsx');
  assert.deepEqual(P.cmdAbrirEscolhe([], (f) => f.path, 'x'), { nenhum: true });
});

test('o que a pessoa quer ver', () => {
  assert.equal(P.cmdAbrirQuer('as imagens'), 'imagem');
  assert.equal(P.cmdAbrirQuer('o print da tela'), 'imagem');
  assert.equal(P.cmdAbrirQuer('o vídeo'), 'vídeo');
  assert.equal(P.cmdAbrirQuer('o pdf'), 'pdf');
  assert.equal(P.cmdAbrirQuer('proof-2.png'), '');
});

test('código: o mais mexido primeiro, sem lock nem pasta do app', () => {
  const r = P.cmdAbrirCodigos([{ path: 'package-lock.json', add: 900, del: 10 }, { path: '.cardume/TASK.yaml', add: 5, del: 0 }, { path: 'a.ts', add: 2, del: 1 }, { path: 'b.ts', add: 40, del: 8 }]);
  assert.deepEqual(r.map((f) => f.path), ['b.ts', 'a.ts']);
});

// ── a ação inteira, com o app de mentira ──
function app({ files = [], arts = [] } = {}) {
  const abertos = [], ditos = [];
  const fn = new Function('invoke', 'openWorkspace', 'cvOpenTop', 'openArtifact', 'loadArtifacts', 'entregaArts', 'cmdTask', 'console', JS + '; return { cmdAbrirDo, CMD_ABRIR };');
  const api = fn(async (cmd) => { if (cmd === 'task_files') return files; throw new Error('comando inesperado ' + cmd); },
    (id, path) => abertos.push(['codigo', id, path]), (desc, opts) => abertos.push(['aba', desc, opts]), () => abertos.push(['modal']),
    async () => {}, () => arts, (id) => ({ id, status: 'review' }), { warn() {} });
  return { ...api, abertos, ditos, say: (t) => ditos.push(t) };
}
const X = { id: 't1', code: 'ABC-12', title: 'Frete no checkout' };

test('abrir_codigo sem dizer qual: abre o mais alterado na aba da tarefa e conta os outros', async () => {
  const a = app({ files: [{ path: 'src/a.ts', add: 1, del: 0 }, { path: 'src/checkout/Frete.tsx', add: 80, del: 12 }] });
  await a.cmdAbrirDo({ acao: 'abrir_codigo' }, X, a.say);
  assert.deepEqual(a.abertos, [['codigo', 't1', 'src/checkout/Frete.tsx']]);
  assert.match(a.ditos[0], /Abri src\/checkout\/Frete\.tsx da ABC-12 no Starfork \(\+80 −12\)\. Ela também alterou: src\/a\.ts\./);
});

test('abrir_codigo com o nome: abre aquele; sem parecido: diz o que ela alterou, sem abrir nada', async () => {
  const a = app({ files: [{ path: 'src/a.ts', add: 1, del: 0 }, { path: 'src/checkout/Frete.tsx', add: 80, del: 12 }] });
  await a.cmdAbrirDo({ acao: 'abrir_codigo', alvo: 'a.ts' }, X, a.say);
  assert.deepEqual(a.abertos, [['codigo', 't1', 'src/a.ts']]);
  await a.cmdAbrirDo({ acao: 'abrir_codigo', alvo: 'pagamento' }, X, a.say);
  assert.equal(a.abertos.length, 1);
  assert.match(a.ditos[1], /não mexeu em nenhum arquivo parecido com “pagamento”/);
  const vazio = app({ files: [{ path: '.cardume/TASK.yaml', add: 3, del: 0 }] });
  await vazio.cmdAbrirDo({ acao: 'abrir_codigo' }, X, vazio.say);
  assert.equal(vazio.abertos.length, 0);
  assert.match(vazio.ditos[0], /ainda não alterou nenhum arquivo de código/);
});

test('abrir_entrega "as imagens": abre a primeira numa aba e lista as outras', async () => {
  const a = app({ arts: [{ name: 'tests.md' }, { name: 'proof-1.png' }, { name: 'proof-2.png' }] });
  await a.cmdAbrirDo({ acao: 'abrir_entrega', alvo: 'as imagens' }, X, a.say);
  assert.deepEqual(a.abertos, [['aba', { kind: 'doc', taskId: 't1', ref: 'art:proof-1.png' }, {}]], 'do Comando não tenta dividir a tela');
  assert.match(a.ditos[0], /Abri proof-1\.png \(imagem\) da ABC-12 no Starfork\. Tem mais 1: proof-2\.png\./);
});

test('abrir_entrega pelo nome, tipo que não existe e tarefa sem entrega', async () => {
  const a = app({ arts: [{ name: 'tests.md' }, { name: 'proof-1.png' }] });
  await a.cmdAbrirDo({ acao: 'abrir_entrega', alvo: 'tests' }, X, a.say);
  assert.equal(a.abertos[0][1].ref, 'art:tests.md');
  await a.cmdAbrirDo({ acao: 'abrir_entrega', alvo: 'o vídeo' }, X, a.say);
  assert.equal(a.abertos.length, 1);
  assert.match(a.ditos[1], /não entregou nenhum vídeo\. O que ela entregou: tests\.md, proof-1\.png\./);
  const v = app();
  await v.cmdAbrirDo({ acao: 'abrir_entrega' }, X, v.say);
  assert.match(v.ditos[0], /ainda não entregou nenhuma imagem/);
});

test('ambiente e simulador abrem como aba do canvas', async () => {
  const a = app();
  await a.cmdAbrirDo({ acao: 'abrir_ambiente' }, X, a.say);
  await a.cmdAbrirDo({ acao: 'abrir_simulador' }, X, a.say);
  assert.deepEqual(a.abertos.map((x) => x[1].kind), ['web', 'device']);
  assert.equal(a.abertos[0][1].app, true);
});

test('ligado no Comando: catálogo, despacho por tarefa, instrução do agente e ordem de carga', () => {
  for (const k of ['abrir_codigo', 'abrir_entrega', 'abrir_ambiente', 'abrir_simulador']) {
    assert.ok(new RegExp(`\\b${k}:'`).test(CMDJS), k + ' no catálogo');
    assert.ok(new RegExp(`${k}:'Abrir`).test(CMDJS), k + ' com rótulo');
  }
  assert.match(CMDJS, /CMD_ABRIR\.has\(p\.acao\)\)\{ await cmdAbrirDo\(p, x, say\); continue; \}/);
  assert.match(AGJS, /agir "abrir_codigo"/);
  assert.ok(HTML.indexOf('89-comando-abrir.js') > HTML.indexOf('89-comando.js') && HTML.indexOf('89-comando-abrir.js') < HTML.indexOf('89-comando-agente.js'));
});
