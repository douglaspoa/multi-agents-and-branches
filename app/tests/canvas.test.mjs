// Canvas (spec-canvas-workspace, pivot "canvas no topo") — funções puras de app/src/js/19-canvas-puro.js:
// F0: gerente de recursos (≤ 2 páginas, ≤ 1 stream, LRU) — UM no app inteiro, inclusive dentro dos painéis divididos;
// estado por painel (mira/stream não trocam entre demandas). Pivot: modelo da TELA DIVIDIDA no topo (até 3 abas lado a
// lado, sem split recursivo, JSON versionado; inválido → sem divisão) e site externo (YouTube, bloqueados).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cv = read('js/19-canvas-puro.js'), nav = read('js/57-navegador.js'), dev = read('js/57-dispositivo.js');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const PURE = cut(cv, '// @canvas-puro-inicio', '// @canvas-puro-fim');
const F = new Function(PURE + '\nreturn { CV_VER, CV_MAX_PANES, CV_CAPS, CV_SPLIT_KINDS, cvRmNew, cvRmAcquire, cvRmRelease, cvRmIsLive, cvRmCount, cvSiteUrl, cvTaskHue, cvTaskColor, cvTabDesc, cvTabIdOf, cvDescValid, cvSplitValid, cvSplitAdd, cvSplitRemove, cvDropSide };')();
// instância do gerente (janela principal = sem pai; painel = usa o do pai)
function loadRm(parent) {
  const code = PURE + cut(cv, '// ---------- gerente de recursos: UM só no app', '// trocou de aba do app');
  const window = parent ? { parent } : {}; window.parent = window.parent || window;
  return new Function('window', 'console', code + '\nreturn { CV_RM, cvRmTake, cvRmDrop, CV_RM_HOST };')(window, { error() {} });
}

test('gerente de recursos: no máximo 2 páginas e 1 stream; o menos recente sai (LRU) e quem volta vira o mais recente', () => {
  const rm = F.cvRmNew();
  assert.deepEqual(rm.caps, { web: 2, stream: 1 });
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'app:A'), []);
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'site:1'), []);
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'app:A'), [], 'reafirmar não despeja nada (só move pro fim)');
  assert.deepEqual(F.cvRmAcquire(rm, 'web', 'site:2'), ['site:1'], '3ª página → a MENOS recente congela');
  for (let i = 3; i < 8; i++) F.cvRmAcquire(rm, 'web', 'site:' + i);
  assert.equal(F.cvRmCount(rm, 'web'), 2, 'abrir 5 páginas: só 2 vivas');
  assert.deepEqual(F.cvRmAcquire(rm, 'stream', 'dev:A'), []);
  assert.deepEqual(F.cvRmAcquire(rm, 'stream', 'dev:B'), ['dev:A'], '2º stream → o 1º para');
  assert.equal(F.cvRmRelease(rm, 'stream', 'dev:B'), true); assert.equal(F.cvRmRelease(rm, 'stream', 'dev:B'), false);
});

test('gerente é UM no app: o painel dividido (iframe) usa o da janela principal — o teto vale somando todos', () => {
  const main = loadRm(null); const frozen = [];
  assert.equal(main.CV_RM_HOST, null, 'janela principal: gerente próprio');
  const pane = loadRm({ cvRmTake: main.cvRmTake, cvRmDrop: main.cvRmDrop, CV_RM: main.CV_RM });
  assert.equal(pane.CV_RM, main.CV_RM, 'painel aponta pro MESMO gerente');
  main.cvRmTake('web', 'site:x@main', () => frozen.push('site:x@main'));
  pane.cvRmTake('web', 'app:B@task:B', () => frozen.push('app:B@task:B'));
  pane.cvRmTake('web', 'app:C@task:C', () => frozen.push('app:C@task:C'));
  assert.deepEqual(frozen, ['site:x@main'], 'a 3ª página (num painel) congela a mais antiga (na janela principal)');
  assert.equal(main.CV_RM.live.web.length, 2);
  pane.cvRmDrop('web', 'app:B@task:B'); assert.deepEqual(main.CV_RM.live.web, ['app:C@task:C']);
  // chaves por painel: a mesma demanda aberta em dois lugares conta duas vezes (não esconde webview)
  assert.match(nav, /function nvResKey\(taskId\)\{ return 'app:'\+taskId\+'@'\+/);
  assert.match(dev, /function dvKey\(id\)\{ return 'dev:'\+id\+'@'\+/);
});

test('isolamento: duas demandas na tela NÃO trocam mira (mensagem da página A só vira seleção de A)', () => {
  const route = new Function(cut(nav, 'function nvRouteMsg', '// @nav-puro-fim') + '\nreturn nvRouteMsg;')();
  const wA = {}, wB = {};
  const states = { A: { frame: { contentWindow: wA }, proxy: { origin: 'http://127.0.0.1:5001' } }, B: { frame: { contentWindow: wB }, proxy: { origin: 'http://127.0.0.1:5002' } } };
  assert.equal(route(states, wA, 'http://127.0.0.1:5001'), 'A'); assert.equal(route(states, wB, 'http://127.0.0.1:5002'), 'B');
  assert.equal(route(states, wA, 'http://127.0.0.1:5002'), null, 'janela de A com origem de B: ninguém');
  assert.equal(route({ A: { frame: null, proxy: null } }, wA, 'x'), null, 'prévia desmontada não recebe nada');
  const run = nav.slice(nav.indexOf('const nvState={}'));
  assert.ok(!/\$id\(/.test(run), 'Prévia sem $id: cada painel acha os elementos DENTRO dele');
  assert.match(run, /cvRmTake\('web', nvResKey\(taskId\)/, 'iframe só monta pelo gerente (teto de 2)');
});

test('isolamento: o stream do dispositivo é DA demanda — quadro de A nunca é desenhado com o painel em B', () => {
  const sessFor = new Function(cut(dev, 'function dvSessFor', '// pedaços do /stream') + '\nreturn dvSessFor;')();
  const sA = { id: 'A' };
  assert.equal(sessFor(sA, 'A'), sA); assert.equal(sessFor(sA, 'B'), null); assert.equal(sessFor(null, 'A'), null);
  assert.match(dev, /Object\.defineProperty\(DV, 'sess', \{ get\(\)\{ return dvSessFor\(DV\._sess, DV\.task\); \}/);
  assert.match(cut(dev, 'function dvStopStream', 'async function dvPollState'), /const s=DV\._sess; if\(!s\) return;/);
});

test('tela dividida: até 3, sem repetir, do lado pedido; dividir uma aba com ela mesma precisa de OUTRA', () => {
  assert.deepEqual(F.cvSplitAdd(null, 'task:A', 'web:x', 'right'), ['task:A', 'web:x']);
  assert.deepEqual(F.cvSplitAdd(null, 'task:A', 'web:x', 'left'), ['web:x', 'task:A']);
  assert.deepEqual(F.cvSplitAdd(['task:A', 'web:x'], 'task:A', 'task:B', 'right'), ['task:A', 'web:x', 'task:B']);
  assert.equal(F.cvSplitAdd(['task:A', 'web:x', 'task:B'], 'task:A', 'doc:y', 'right'), null, 'nunca 4');
  assert.deepEqual(F.cvSplitAdd(['task:A', 'web:x', 'task:B'], 'task:A', 'task:B', 'left'), ['task:B', 'task:A', 'web:x'], 'mover dentro da divisão');
  assert.equal(F.cvSplitAdd(null, 'task:A', 'task:A', 'right'), null, 'a aba com ela mesma não divide');
  assert.deepEqual(F.cvSplitAdd(['x', 'y'], 'task:A', 'web:z', 'right'), ['task:A', 'web:z'], 'base fora da divisão: começa outra');
  assert.deepEqual(F.cvSplitRemove(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.equal(F.cvSplitRemove(['a', 'b'], 'a'), null, 'sobrou 1: volta pra tela normal');
  const r = { left: 100, width: 1000 };
  assert.equal(F.cvDropSide(r, 150), 'left'); assert.equal(F.cvDropSide(r, 1050), 'right'); assert.equal(F.cvDropSide(r, 600), null, 'faixa do meio não divide');
  assert.equal(F.cvDropSide(null, 5), null);
});

test('salvar e restaurar a divisão: JSON versionado; versão desconhecida, lixo, demanda apagada, tipo estranho → sem divisão', () => {
  const ids = ['A', 'B'];
  const tabA = { id: 'task:A', kind: 'task', taskId: 'A' }, web = { id: 'w', kind: 'web', url: 'https://youtu.be/aqz-KE-bpKQ' };
  assert.deepEqual(F.cvTabDesc(tabA), { kind: 'task', taskId: 'A' }); assert.equal(F.cvTabDesc({ kind: 'flow' }), null, 'Central não vai pra divisão');
  assert.equal(F.cvTabIdOf({ kind: 'task', taskId: 'A' }), 'task:A');
  assert.equal(F.cvTabIdOf({ kind: 'web', url: 'https://a.com/' }), F.cvTabIdOf({ kind: 'web', url: 'https://a.com/' }), 'id estável pelo conteúdo');
  assert.notEqual(F.cvTabIdOf({ kind: 'doc', taskId: 'A', ref: 'file:README.md' }), F.cvTabIdOf({ kind: 'doc', taskId: 'B', ref: 'file:README.md' }));
  const raw = JSON.stringify({ v: 1, panes: [F.cvTabDesc(tabA), F.cvTabDesc(web), { kind: 'doc', taskId: 'B', ref: 'file:README.md' }], focus: 2, w: [0.4, 0.3, 0.3] });
  const s = F.cvSplitValid(raw, ids);
  assert.equal(s.panes.length, 3); assert.equal(s.focus, 2); assert.deepEqual(s.w, [0.4, 0.3, 0.3]);
  assert.equal(s.panes[1].url, 'https://youtu.be/aqz-KE-bpKQ');
  for (const bad of [null, '', '{', '[]', '{"v":2,"panes":[{"kind":"task","taskId":"A"},{"kind":"task","taskId":"B"}]}', '{"v":1,"panes":[{"kind":"task","taskId":"A"}]}', '{"v":1,"panes":"x"}'])
    assert.equal(F.cvSplitValid(bad, ids), null, String(bad));
  // pedaços ruins saem; se sobrar < 2 → nada
  const mixed = F.cvSplitValid({ v: 1, focus: 9, panes: [{ kind: 'task', taskId: 'A' }, { kind: 'terminal' }, { kind: 'task', taskId: 'SUMIU' }, { kind: 'web', url: 'javascript:alert(1)' }, { kind: 'doc', taskId: 'A', ref: 'file:../../etc/passwd' }, { kind: 'task', taskId: 'A' }, { kind: 'device', taskId: 'B' }] }, ids);
  assert.deepEqual(mixed.panes.map((p) => p.kind + ':' + (p.taskId || '')), ['task:A', 'device:B']);
  assert.equal(mixed.focus, 1, 'foco preso ao que existe');
  assert.equal(F.cvSplitValid({ v: 1, panes: [{ kind: 'task', taskId: 'A' }, { kind: 'task', taskId: 'B' }], w: [0.9, 0.5] }, ids).w, undefined, 'larguras malucas: automáticas');
  assert.equal(F.cvDescValid({ kind: 'web', app: true, taskId: 'A' }, ids).app, true, 'Navegador com o app de uma demanda');
  assert.equal(F.cvDescValid({ kind: 'device' }, ids), null, 'Simulador sem demanda não existe');
  assert.deepEqual(F.CV_SPLIT_KINDS, ['task', 'web', 'device', 'doc']); assert.equal(F.CV_MAX_PANES, 3);
});

test('site externo: só http(s), YouTube vira /embed/ (nocookie) com o id pra capa; bloqueados conhecidos → "abrir fora"', () => {
  assert.equal(F.cvSiteUrl('youtube.com/watch?v=aqz-KE-bpKQ&t=42').embed, 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?start=42');
  assert.equal(F.cvSiteUrl('https://youtu.be/aqz-KE-bpKQ').vid, 'aqz-KE-bpKQ');
  assert.equal(F.cvSiteUrl('https://www.youtube.com/shorts/abcDEF12345').video, true);
  assert.equal(F.cvSiteUrl('docs.python.org/3/').url, 'https://docs.python.org/3/');
  assert.equal(F.cvSiteUrl('https://github.com/x/y').blocked, true); assert.equal(F.cvSiteUrl('https://developer.mozilla.org/').blocked, false);
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://u:p@x.com']) assert.equal(F.cvSiteUrl(bad), null, bad);
});

test('cor por demanda: estável; ao lado da casa, a outra NUNCA fica com cor parecida', () => {
  assert.equal(F.cvTaskColor('t1'), F.cvTaskColor('t1'));
  const hue = (c) => +c.match(/hsl\((\d+)/)[1];
  const d = (a, b) => { const x = Math.abs(a - b); return Math.min(x, 360 - x); };
  for (const [home, other] of [['t1', 't2'], ['t2', 't3'], ['a1b2', 'tcim4vb'], ['H', 'B']]) assert.ok(d(hue(F.cvTaskColor(home)), hue(F.cvTaskColor(other, home))) >= 50, home + ' x ' + other);
});
