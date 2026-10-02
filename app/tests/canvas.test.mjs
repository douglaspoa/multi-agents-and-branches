// Canvas do workspace (spec-canvas-workspace) — F0: gerente de recursos (teto de webviews/stream, LRU) e ESTADO POR
// PAINEL (cada aba com o próprio taskId: duas demandas na tela não trocam diff, mira nem stream). Funções puras de
// app/src/js/19-canvas-puro.js (recortadas entre os marcadores) + os trechos de isolamento da Prévia e do Dispositivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cv = read('js/19-canvas-puro.js'), nav = read('js/57-navegador.js'), dev = read('js/57-dispositivo.js');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const PURE = cut(cv, '// @canvas-puro-inicio', '// @canvas-puro-fim');
const F = new Function(PURE + '\nreturn { CV_VER, CV_MAX_COLS, CV_MAX_TASKS, CV_CAPS, CV_TYPES, cvRmNew, cvRmAcquire, cvRmRelease, cvRmIsLive, cvRmCount, cvPaneTask, cvResKey, cvSiteUrl, cvMkTab, cvTabKey, cvFindTab, cvVisible, cvTasksIn, cvDefaultLayout, cvPreset, cvValidate, cvSerialize, cvSig, cvAddTab, cvActivate, cvCloseTab, cvDropZone, cvMoveTab, cvSplit, cvPlusItems, cvAllTabs };')();
// runtime do gerente (instância única do app + congeladores)
function loadRm() {
  const code = PURE + cut(cv, '// ---------- gerente de recursos: a instância do app', '// trocou de aba do app');
  return new Function('console', code + '\nreturn { CV_RM, cvRmTake, cvRmDrop };')({ error() {} });
}

test('gerente de recursos: no máximo 2 webviews e 1 stream; o menos recente sai (LRU) e quem volta vira o mais recente', () => {
  const rm = F.cvRmNew();
  assert.deepEqual(rm.caps, { web: 2, stream: 1 });
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'app:A'), []);
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'site:1'), []);
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'app:A'), [], 'reafirmar não despeja nada (só move pro fim)');
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'site:2'), ['site:1'], '3ª webview → a MENOS recente congela (site:1, não app:A)');
  assert.deepEqual(rm.live.web, ['app:A', 'site:2']);
  for (let i = 3; i < 8; i++) F.cvRmAcquire(rm, 'web', 'site:' + i);
  assert.equal(F.cvRmCount(rm, 'web'), 2, 'abrir 5 abas web: só 2 vivas');
  assert.deepEqual(F.cvRmAcquire(rm, 'stream', 'dev:A'), []);
  assert.deepEqual(F.cvRmAcquire(rm, 'stream', 'dev:B'), ['dev:A'], '2º stream → o 1º para');
  assert.equal(F.cvRmCount(rm, 'stream'), 1);
  assert.equal(F.cvRmRelease(rm, 'stream', 'dev:B'), true); assert.equal(F.cvRmRelease(rm, 'stream', 'dev:B'), false);
  assert.equal(F.cvRmIsLive(rm, 'web', 'site:7'), true);
});

test('gerente (instância do app): despejar chama o congelador DAQUELE recurso, uma vez só', () => {
  const R = loadRm(); const frozen = [];
  R.cvRmTake('web', 'app:A', () => frozen.push('app:A'));
  R.cvRmTake('web', 'app:B', () => frozen.push('app:B'));
  R.cvRmTake('web', 'site:x', () => frozen.push('site:x'));
  assert.deepEqual(frozen, ['app:A']);
  R.cvRmDrop('web', 'app:B'); R.cvRmTake('web', 'site:y', () => frozen.push('site:y'));
  assert.deepEqual(frozen, ['app:A'], 'soltar libera a vaga: ninguém congela');
  R.cvRmTake('web', 'site:z');
  assert.deepEqual(frozen, ['app:A', 'site:x']);
  assert.deepEqual(R.CV_RM.live.web, ['site:y', 'site:z']);
});

test('estado por painel: a demanda do painel vem da ABA; recurso pesado tem chave por demanda', () => {
  const a = F.cvMkTab('app', 'A'), b = F.cvMkTab('app', 'B'), site = F.cvMkTab('site', null, { url: 'https://docs.x.com/' }), d = F.cvMkTab('dispositivo', 'A');
  assert.equal(F.cvPaneTask(a, 'H'), 'A'); assert.equal(F.cvPaneTask(b, 'H'), 'B');
  assert.equal(F.cvPaneTask({ type: 'conversa' }, 'H'), 'H', 'tipo da casa sem taskId herda a casa');
  assert.equal(F.cvPaneTask(site, 'H'), 'H', 'site externo não é de demanda nenhuma (prova vai pra casa)');
  assert.equal(F.cvResKey(a, 'H'), 'app:A'); assert.equal(F.cvResKey(b, 'H'), 'app:B');
  assert.equal(F.cvResKey(site, 'H'), 'site:' + site.id); assert.equal(F.cvResKey(d, 'H'), 'dev:A');
  assert.equal(F.cvResKey(F.cvMkTab('conversa', 'A'), 'H'), null, 'conversa não pesa');
  assert.notEqual(a.id, b.id, 'mesma aba de duas demandas = abas diferentes');
});

test('isolamento: duas demandas na tela NÃO trocam mira (mensagem da página A só vira seleção de A)', () => {
  const route = new Function(cut(nav, 'function nvRouteMsg', '// @nav-puro-fim') + '\nreturn nvRouteMsg;')();
  const wA = {}, wB = {};
  const states = { A: { frame: { contentWindow: wA }, proxy: { origin: 'http://127.0.0.1:5001' } }, B: { frame: { contentWindow: wB }, proxy: { origin: 'http://127.0.0.1:5002' } } };
  assert.equal(route(states, wA, 'http://127.0.0.1:5001'), 'A');
  assert.equal(route(states, wB, 'http://127.0.0.1:5002'), 'B');
  assert.equal(route(states, wA, 'http://127.0.0.1:5002'), null, 'janela de A com origem de B: ninguém');
  assert.equal(route(states, {}, 'http://127.0.0.1:5001'), null);
  assert.equal(route({ A: { frame: null, proxy: null } }, wA, 'x'), null, 'prévia desmontada não recebe nada');
  // a prévia é por RAIZ do painel: nenhum id fixo (o 2º painel pintaria no 1º) e nada de "só a tarefa do fwTask"
  const run = nav.slice(nav.indexOf('const nvState={}'));
  assert.ok(!/\$id\(/.test(run), 'Prévia sem $id: cada painel acha os elementos DENTRO dele');
  assert.ok(!/fwTask/.test(run), 'Prévia não lê a tarefa global');
  assert.match(run, /cvRmTake\('web', nvResKey\(taskId\)/, 'iframe só monta pelo gerente (teto de 2)');
  assert.match(run, /function nvFreeze[\s\S]*?st\.frozen=wasLive/, "congelada mostra pausado (webview morta não)");
});

test('isolamento: o stream do dispositivo é DA demanda — quadro de A nunca é desenhado com o painel em B', () => {
  const sessFor = new Function(cut(dev, 'function dvSessFor', '// pedaços do /stream') + '\nreturn dvSessFor;')();
  const sA = { id: 'A' };
  assert.equal(sessFor(sA, 'A'), sA); assert.equal(sessFor(sA, 'B'), null); assert.equal(sessFor(null, 'A'), null); assert.equal(sessFor(sA, null), null);
  assert.match(dev, /Object\.defineProperty\(DV, 'sess', \{ get\(\)\{ return dvSessFor\(DV\._sess, DV\.task\); \}/);
  // parar usa a sessão CRUA (a de outra demanda é justamente a que precisa morrer)
  assert.match(cut(dev, 'function dvStopStream', 'async function dvPollState'), /const s=DV\._sess; if\(!s\) return;/);
});

test('isolamento: diff/conversa/dispositivo são da demanda-casa — layout salvo não consegue apontar pra outra', () => {
  const ctx = { homeId: 'H', taskIds: ['H', 'B'] };
  const l = F.cvValidate({ v: 1, cols: [{ tabs: [{ type: 'diff', taskId: 'B' }, { type: 'conversa', taskId: 'B' }, { type: 'dispositivo', taskId: 'B' }] }, { tabs: [{ type: 'app', taskId: 'B' }, { type: 'demanda', taskId: 'B' }] }] }, ctx);
  const tabs = F.cvAllTabs(l);
  assert.deepEqual(tabs.filter((t) => ['diff', 'conversa', 'dispositivo'].includes(t.type)).map((t) => t.taskId), ['H', 'H', 'H']);
  assert.deepEqual(tabs.filter((t) => ['app', 'demanda'].includes(t.type)).map((t) => t.taskId), ['B', 'B'], 'prévia e "outra demanda" podem ser de B');
  assert.equal(F.cvValidate({ v: 1, cols: [{ tabs: [{ type: 'demanda', taskId: 'H' }] }] }, ctx), null, '"outra demanda" apontando pra casa não vale');
});
