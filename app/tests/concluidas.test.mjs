// node --test app/tests/concluidas.test.mjs — Central › Concluídas: grupo por projeto que recolhe + paginação (12 por vez).
// Os helpers são recortados do 22-quadro-fluxo.js de verdade e rodam contra fakes (localStorage e cartão que "carrega artefatos").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const quadro = readFileSync(new URL('../src/js/22-quadro-fluxo.js', import.meta.url), 'utf8');
const a = quadro.indexOf('const FLOW_DONE_PAGE'), b = quadro.indexOf('let flowView=');
assert.ok(a > 0 && b > a, 'bloco das Concluídas não encontrado');

// monta os helpers com um localStorage falso (persistente entre "sessões" se passar o mesmo store)
function mount(store = new Map()) {
  const lsGet = (k) => (store.has(k) ? store.get(k) : null);
  const lsSet = (k, v) => { store.set(k, String(v)); };
  const esc = (s) => String(s), escA = (s) => String(s).replace(/"/g, '&quot;');
  const IC = { chevR: '>', chevD: 'v' };
  const api = new Function('lsGet', 'lsSet', 'esc', 'escA', 'IC',
    quadro.slice(a, b) + '\nreturn { FLOW_DONE_PAGE, flowDoneShow, flowDoneCollapsed, flowDoneSetCollapsed, flowDoneGroupHtml, flowDonePageHtml };')(lsGet, lsSet, esc, escA, IC);
  // cartão falso no papel do flowDemandCard: desenhar = pedir artefatos e provas
  const loads = [];
  const item = (t) => { loads.push('art:' + t.id, 'req:' + t.id); return `<div class="dcard" data-id="${t.id}"></div>`; };
  return { ...api, store, loads, item };
}
const tasks = (proj, n) => Array.from({ length: n }, (_, i) => ({ id: proj + '-' + i, repo: '/p/' + proj }));
const cards = (html) => (html.match(/class="dcard"/g) || []).length;
const expanded = (html) => (html.match(/aria-expanded="(true|false)"/) || [])[1];
// simula o clique no cabeçalho (mesma regra do handler em renderFlow)
const click = (m, k, html) => m.flowDoneSetCollapsed(k, expanded(html) === 'true');

test('cada projeto começa ABERTO, com as 12 mais recentes, e só essas carregam artefatos/provas', () => {
  const m = mount();
  const list = tasks('alpha', 128);
  const html = m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', list, m.item);
  assert.equal(expanded(html), 'true');
  assert.equal(cards(html), 12);
  assert.match(html, /mostrar mais \(116 restantes\)/);
  assert.equal(m.loads.length, 24, '12 cartões × (artefatos + provas)');
  assert.ok(m.loads.includes('art:alpha-0') && !m.loads.includes('art:alpha-12'), 'mantém a ordem recebida: os 12 primeiros');
});

test('"mostrar mais" soma 12 de cada vez (24, depois 36) e "mostrar menos" volta pra 12', () => {
  const m = mount();
  const list = tasks('alpha', 30);
  m.flowDoneShow['/p/alpha'] = 24;
  let html = m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', list, m.item);
  assert.equal(cards(html), 24);
  assert.match(html, /mostrar mais \(6 restantes\)/);
  assert.match(html, /data-doneless=/);
  m.flowDoneShow['/p/alpha'] = 36;
  html = m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', list, m.item);
  assert.equal(cards(html), 30);
  assert.doesNotMatch(html, /mostrar mais/);
  delete m.flowDoneShow['/p/alpha'];
  assert.equal(cards(m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', list, m.item)), 12);
  assert.match(m.flowDonePageHtml('x', tasks('x', 13), m.item), /mostrar mais \(1 restante\)/);
  assert.doesNotMatch(m.flowDonePageHtml('y', tasks('y', 5), m.item), /cgmore/, 'até 12: sem botões');
});

test('recolher um projeto: zero cartões, zero cargas, aria-expanded=false — os outros projetos continuam abertos', () => {
  const m = mount();
  const A = tasks('alpha', 40), B = tasks('beta', 40);
  click(m, '/p/alpha', m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', A, () => ''));
  m.loads.length = 0;
  const ha = m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', A, m.item);
  assert.equal(expanded(ha), 'false');
  assert.equal(cards(ha), 0);
  assert.equal(m.loads.length, 0, 'grupo recolhido não pede artefatos nem provas');
  assert.match(ha, /<div class="cgbody" id="(cg[a-z0-9]+)" hidden>/, 'o alvo do aria-controls existe, vazio e escondido');
  assert.equal(ha.match(/aria-controls="([^"]+)"/)[1], ha.match(/class="cgbody" id="([^"]+)"/)[1]);
  const hb = m.flowDoneGroupHtml('/p/beta', 'beta', '#00f', B, m.item);
  assert.equal(expanded(hb), 'true');
  assert.equal(cards(hb), 12);
  // abrir de novo
  click(m, '/p/alpha', ha);
  assert.equal(expanded(m.flowDoneGroupHtml('/p/alpha', 'alpha', '#f00', A, m.item)), 'true');
});

test('o estado fica salvo por projeto (localStorage) e sobrevive a uma nova sessão', () => {
  const store = new Map();
  const m1 = mount(store);
  m1.flowDoneSetCollapsed('/p/beta', true);
  assert.equal(store.get('concl:col:/p/beta'), '1');
  const m2 = mount(store); // "reabriu o app"
  assert.equal(m2.flowDoneCollapsed('/p/beta'), true);
  assert.equal(m2.flowDoneCollapsed('/p/alpha'), false, 'projeto nunca mexido = aberto');
  assert.equal(cards(m2.flowDoneGroupHtml('/p/beta', 'beta', '#00f', tasks('beta', 20), m2.item)), 0);
});

test('localStorage indisponível não quebra: tudo aberto', () => {
  const m = new Function('lsGet', 'lsSet', 'esc', 'escA', 'IC', quadro.slice(a, b) + '\nreturn { flowDoneCollapsed, flowDoneSetCollapsed };')(
    () => { throw new Error('bloqueado'); }, () => { throw new Error('bloqueado'); }, String, String, {});
  assert.equal(m.flowDoneCollapsed('/p/x'), false);
  assert.doesNotThrow(() => m.flowDoneSetCollapsed('/p/x', true));
});

test('o cabeçalho é um <button> acessível e o renderFlow usa o grupo por projeto e só carrega o que desenhou', () => {
  const m = mount();
  const html = m.flowDoneGroupHtml('/p/a"b', 'a"b', '#f00', tasks('ab', 3), m.item);
  assert.match(html, /^<div class="secgrp cgrp" data-sec="[^"]*"><button type="button" class="sech cgtog" data-donetog="\/p\/a&quot;b" aria-expanded="true" aria-controls="cg/);
  const rf = quadro.slice(quadro.indexOf('function renderFlow(){'));
  assert.match(rf, /flowDoneGroupHtml\(k, projShort\(k\), projColor\(k\), list, item\)/);
  assert.match(rf, /for\(const t of \(flowScope==='done'\?rendered:tasks\)\)\{ if\(commitsNeedLoad/);
  assert.match(rf, /\[data-donetog\]/);
  assert.match(rf, /\[data-donemore\]/);
});
