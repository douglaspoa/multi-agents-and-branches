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
const F = new Function(PURE + '\nreturn { CV_VER, CV_MAX_COLS, CV_MAX_TASKS, CV_CAPS, CV_TYPES, cvRmNew, cvRmAcquire, cvRmRelease, cvRmIsLive, cvRmCount, cvPaneTask, cvResKey, cvSiteUrl, cvMkTab, cvTabKey, cvFindTab, cvVisible, cvTasksIn, cvDefaultLayout, cvPreset, cvValidate, cvSerialize, cvSig, cvAddTab, cvActivate, cvCloseTab, cvDropZone, cvMoveTab, cvSplit, cvPlusItems, cvAllTabs, cvReplaceTab, cvTaskColor, cvWidths, CV_MODE2TYPE, CV_TYPE2MODE };')();
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

// ---------------- F2: modelo de layout ----------------
const H = 'H', CTX = { homeId: 'H', taskIds: ['H', 'B', 'C'] };
const types = (l) => l.cols.map((c) => c.tabs.map((t) => t.type + (t.id === c.active ? '*' : '')).join('+')).join(' | ');

test('layout padrão: [Meu app (ou Subir ambiente) | Conversa]; sem código → [Documento | Conversa]; sem página → Entrega/Celular', () => {
  assert.equal(types(F.cvDefaultLayout(H, {})), 'app* | conversa*');
  assert.equal(types(F.cvDefaultLayout(H, { web: null })), 'app* | conversa*', 'detecção ainda não chegou: Meu app (mostra o cartão)');
  const nc = F.cvDefaultLayout(H, { nonCode: true, doc: 'art:relatorio.pdf' });
  assert.equal(types(nc), 'documento* | conversa*'); assert.equal(nc.cols[0].tabs[0].ref, 'art:relatorio.pdf');
  assert.equal(types(F.cvDefaultLayout(H, { web: false })), 'entrega* | conversa*');
  assert.equal(types(F.cvDefaultLayout(H, { web: false, mobile: true })), 'dispositivo* | conversa*');
  assert.equal(F.cvDefaultLayout(H, {}).auto, true, 'padrão é automático (se ajusta quando a detecção chega)');
  assert.equal(types(F.cvPreset('construir', H, {})), 'app* | conversa*');
  assert.equal(types(F.cvPreset('revisar', H, {})), 'diff* | conversa*');
  assert.equal(types(F.cvPreset('construir', H, { nonCode: true })), 'documento* | conversa*');
  assert.equal(types(F.cvPreset('revisar', H, { nonCode: true })), 'entrega* | conversa*');
});

test('salvar e restaurar: JSON versionado ida e volta; versão desconhecida, lixo, demanda apagada e tipo estranho caem no padrão', () => {
  let l = F.cvDefaultLayout(H, {});
  l = F.cvAddTab(l, F.cvMkTab('site', null, { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }), 'new');
  l = F.cvAddTab(l, F.cvMkTab('documento', H, { ref: 'file:README.md' }), 0);
  const raw = F.cvSerialize(l);
  assert.equal(JSON.parse(raw).v, F.CV_VER);
  const back = F.cvValidate(raw, CTX);
  assert.equal(types(back), types(l)); assert.equal(F.cvSig(back), F.cvSig(l), 'mesmas abas, mesmos ids, mesma coluna em foco');
  assert.equal(back.auto, false, 'mexeu na mão: sai do automático');
  for (const bad of [null, '', '{', '[]', '{"v":2,"cols":[{"tabs":[{"type":"app"}]}]}', '{"v":1,"cols":[]}', '{"v":1,"cols":[{"tabs":[{"type":"terminal"}]}]}', '{"v":1,"cols":[{"tabs":[{"type":"app","taskId":"SUMIU"}]}]}', '{"v":1,"cols":"x"}'])
    assert.equal(F.cvValidate(bad, CTX), null, String(bad));
  // pedaços ruins saem, o resto fica; mais de 3 colunas → 3; ativa que não existe → a 1ª
  const mixed = F.cvValidate({ v: 1, focus: 9, cols: [
    { tabs: [{ type: 'app' }, { type: 'shell' }, { type: 'site', url: 'javascript:alert(1)' }, { type: 'documento', ref: 'file:../../etc/passwd' }, { type: 'documento', ref: 'file:docs/a.md' }], active: 'nao-existe' },
    { tabs: [{ type: 'conversa' }, { type: 'conversa' }] }, { tabs: [{ type: 'diff' }] }, { tabs: [{ type: 'entrega' }] }] }, CTX);
  assert.equal(types(mixed), 'app*+documento | conversa* | diff*');
  assert.equal(mixed.focus, 2, 'foco preso ao que existe');
  assert.equal(F.cvValidate({ v: 1, cols: [{ tabs: [{ type: 'app' }] }] }, { homeId: H, taskIds: [H], allow: (t) => t !== 'app' }), null, 'o que não faz sentido nesta demanda (pelo tipo da entrega) não volta');
  // larguras: frações sãs, uma por coluna
  const w = F.cvValidate({ v: 1, cols: [{ tabs: [{ type: 'app' }] }, { tabs: [{ type: 'conversa' }] }], w: [0.62, 5] }, CTX);
  assert.deepEqual(w.w, [0.62, null]);
});

test('arrastar pra dividir: borda esquerda/direita abre coluna (até 3), meio junta, soltar na própria coluna não muda nada', () => {
  const r = { left: 100, width: 600 };
  assert.equal(F.cvDropZone(r, 110, 2), 'left'); assert.equal(F.cvDropZone(r, 690, 2), 'right'); assert.equal(F.cvDropZone(r, 400, 2), 'center');
  assert.equal(F.cvDropZone(r, 690, 3), 'center-full', 'já são 3: a borda vira "juntar" (e a tela diz o porquê)');
  assert.equal(F.cvDropZone({ left: 0, width: 150 }, 30, 1), 'left', 'faixa mínima de 40 px em coluna estreita');
  let l = F.cvDefaultLayout(H, {}); // app | conversa
  const app = l.cols[0].tabs[0].id, conv = l.cols[1].tabs[0].id;
  assert.equal(types(F.cvMoveTab(l, app, 1, 'right')), 'conversa* | app*');
  assert.equal(types(F.cvMoveTab(l, app, 1, 'center')), 'conversa+app*', 'meio: entra nas abas da coluna (a vazia some)');
  assert.equal(types(F.cvMoveTab(l, app, 0, 'right')), types(l), 'única aba na própria borda: nada muda');
  assert.equal(types(F.cvMoveTab(l, conv, 0, 'left')), 'conversa* | app*');
  l = F.cvAddTab(l, F.cvMkTab('diff', H), 0); // app+diff* | conversa
  assert.equal(types(l), 'app+diff* | conversa*');
  const split = F.cvMoveTab(l, l.cols[0].active, 0, 'right');
  assert.equal(types(split), 'app* | diff* | conversa*', 'borda da própria coluna com 2 abas: divide');
  assert.equal(types(F.cvMoveTab(split, split.cols[0].tabs[0].id, 2, 'right')), 'diff* | conversa* | app*', 'a coluna que esvaziou some: cabe a nova (nunca passa de 3)');
  const full = F.cvAddTab(split, F.cvMkTab('entrega', H), 0); // app+entrega | diff | conversa
  assert.equal(types(F.cvMoveTab(full, full.cols[0].active, 2, 'right')), 'app* | diff* | conversa+entrega*', 'com 3 colunas cheias a borda junta');
  assert.equal(types(F.cvSplit(l)), 'app* | diff* | conversa*', '⌘\\ = a ativa vai pra uma coluna nova');
  assert.equal(F.cvSplit(F.cvDefaultLayout(H, {})), null, '⌘\\ com 1 aba: abre o "+" (sem split)');
  assert.equal(F.cvSplit(split), null, '3 colunas: não divide mais');
});

test('abrir/fechar/ativar: mesma aba não duplica; fechar a última de uma coluna tira a coluna; fechar tudo → padrão (null)', () => {
  let l = F.cvDefaultLayout(H, {});
  const d1 = F.cvAddTab(l, F.cvMkTab('documento', H, { ref: 'file:README.md' }), 'new');
  assert.equal(types(d1), 'app* | conversa* | documento*');
  assert.equal(types(F.cvAddTab(d1, F.cvMkTab('documento', H, { ref: 'file:README.md' }), 0)), 'app* | conversa* | documento*', 'reabrir = focar a existente');
  assert.equal(F.cvAddTab(d1, F.cvMkTab('site', null, { url: 'https://a.com' }), 'new').cols.length, 3, 'nunca 4 colunas');
  const c = F.cvCloseTab(d1, d1.cols[2].tabs[0].id); assert.equal(types(c), 'app* | conversa*');
  assert.equal(F.cvCloseTab(F.cvCloseTab(c, c.cols[0].tabs[0].id), c.cols[1].tabs[0].id), null);
  const two = F.cvAddTab(l, F.cvMkTab('entrega', H), 0);
  assert.equal(types(F.cvActivate(two, two.cols[0].tabs[0].id)), 'app*+entrega | conversa*');
  assert.equal(types(F.cvCloseTab(two, two.cols[0].tabs[1].id)), 'app* | conversa*', 'fechou a ativa: a vizinha vira ativa');
  assert.equal(types(F.cvReplaceTab(l, l.cols[0].tabs[0].id, F.cvMkTab('entrega', H))), 'entrega* | conversa*');
});

test('site externo: só http(s), YouTube vira /embed/ (nocookie), bloqueados conhecidos abrem no "abrir fora"', () => {
  assert.equal(F.cvSiteUrl('youtube.com/watch?v=aqz-KE-bpKQ&t=42').embed, 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?start=42');
  assert.equal(F.cvSiteUrl('https://youtu.be/aqz-KE-bpKQ').embed, 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ');
  assert.equal(F.cvSiteUrl('https://www.youtube.com/shorts/abcDEF12345').video, true);
  assert.equal(F.cvSiteUrl('docs.python.org/3/').url, 'https://docs.python.org/3/');
  assert.equal(F.cvSiteUrl('https://github.com/x/y').blocked, true);
  assert.equal(F.cvSiteUrl('https://www.google.com/search?q=x').blocked, true);
  assert.equal(F.cvSiteUrl('https://developer.mozilla.org/').blocked, false);
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://u:p@x.com']) assert.equal(F.cvSiteUrl(bad), null, bad);
});

test('"+" com nomes humanos, pelo TIPO da demanda (sem "modo simples"); Log fora do "+"; teto de demandas', () => {
  const names = (ctx) => F.cvPlusItems(ctx).map((x) => x.label);
  assert.deepEqual(names({}), ['Meu app', 'Conversa', 'Documento', 'Mudanças', 'Código', 'Entrega', 'Site qualquer', 'Outra demanda']);
  assert.ok(!names({ nonCode: true }).some((n) => ['Meu app', 'Mudanças', 'Código'].includes(n)), 'relatório/pesquisa: nada de código nem app');
  assert.ok(!names({ web: false }).includes('Meu app'), 'projeto sem página: Meu app não aparece');
  assert.ok(names({ mobile: true }).includes('Celular')); assert.ok(names({ hasPr: true }).includes('PR'));
  assert.ok(!F.cvPlusItems({}).some((x) => x.type === 'log'), 'log só pela faixa "detalhes" do ambiente');
  const od = (ctx) => F.cvPlusItems(ctx).find((x) => x.type === 'demanda');
  assert.equal(od({ others: [] }).disabled, true); assert.match(od({ others: [] }).why, /não há outra demanda/);
  assert.equal(od({ others: [{ id: 'B', title: 'b' }], tasksN: 1 }).disabled, false);
  assert.match(od({ others: [{ id: 'B', title: 'b' }], tasksN: F.CV_MAX_TASKS }).why, /no máximo 2 demandas/);
  let l = F.cvAddTab(F.cvDefaultLayout(H, {}), F.cvMkTab('demanda', 'B'), 'new');
  assert.deepEqual(F.cvTasksIn(l), ['H', 'B']);
  assert.equal(F.cvAddTab(l, F.cvMkTab('demanda', 'C'), 0), null, '3ª demanda barrada enquanto o teto for 2');
});
