// Página Projeto / Meu time (68): "0 prontas pra revisar" com um PR aberto esperando revisão (harness 14/10). As etapas
// do cabeçalho e do cartão lateral vêm TODAS do flowCounts (a mesma conta da Central e de Projetos) e o PR aberto
// aparece como etapa própria (D14), com as mesmas palavras. `node --test app/tests/contagem-projeto.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho: ' + a); return src.slice(i, j); };
const util = read('js/00-util.js'), qf = read('js/22-quadro-fluxo.js'), casca = read('js/68-casca-g1.js'), proj = read('js/13-skills-projetos.js');
const HELP = cut(util, '// @helpers-comuns-inicio', '// @helpers-comuns-fim');

const PR = 'https://github.com/exemplo/loja-web/pull/42';
// a fixture do harness: uma rodando, um PR aberto pra revisar, uma na fila do time
const TASKS = [
  { id: 't-cupom', status: 'running' },
  { id: 't-parcela', status: 'review', prUrl: PR },
  { id: 't-busca', status: 'queued' },
];
const M = new Function('state', 'pendingOf', 'taskTs', 'taskDoneTs', 'IC', 'escA',
  HELP + cut(qf, 'function flowBucket(t){', '\n// status EFETIVO') + cut(qf, 'function flowCounts(tasks){', 'const FLOW_SECS') +
  'function projLiveTasks(tasks){ return (tasks||[]).filter(t=>t && t.flag!==\'blocked\' && !taskEncerrada(t)); }\n' +
  cut(casca, 'function projCounts(){', 'function projPageOpen(') + cut(qf, 'function centralSumHtml(fc){', 'function renderFlowHead(') +
  cut(proj, 'function projCountsHtml(fc){', 'function projetosRender(') +
  '\nreturn { projCounts, projSumHtml, centralSumHtml, projCountsHtml, flowCounts };')(
  { tasks: TASKS }, () => [], () => 0, () => 0, {}, (s) => String(s));
const txt = (h) => h.replace(/<[^>]+>/g, '');

test('PR aberto aparece na página Projeto como na Central e em Projetos (não some num "0 prontas")', () => {
  const c = M.projCounts();
  assert.equal(c.vivas, 3);
  assert.equal(c.praberto, 1, 'o PR esperando revisão é contado');
  assert.equal(c.prontas, 0, 'PR aberto é etapa própria (D14), não "pronta pra revisar"');
  assert.equal(txt(M.projSumHtml(c)), '3 em aberto · 0 aguardando você · 0 prontas pra revisar · 1 PR aberto');
  assert.match(txt(M.centralSumHtml(c.fc)), /1 PR aberto/, 'mesma palavra da Central');
  assert.match(txt(M.projCountsHtml(c.fc)), /1 PR aberto/, 'mesma palavra de Projetos');
});

test('fonte única: os números do Projeto saem do flowCounts (iguais à Central)', () => {
  const c = M.projCounts(), fc = M.flowCounts(TASKS);
  for (const k of ['aguardando', 'prontas', 'praberto']) assert.equal(c[k], fc[k], k);
  assert.match(casca, /sum:projSumHtml\(c\)/, 'cabeçalho usa o resumo único');
  assert.match(cut(casca, '<div class="sn-card">', '</div>`'), /c\.praberto\?/, 'cartão lateral mostra o PR aberto');
  assert.match(proj, /tot\.pa\?/, 'Projetos soma os PRs abertos no cabeçalho');
});
