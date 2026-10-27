// Protótipos (84-prototipo, Opção A aprovada em 27/10): modelo comum, versões, telas que chegam da IA, layout do quadro,
// menções só do time, e a fiação (aba, lateral, iframe sem scripts, ganchos pras outras frentes).
// `node --test app/tests/prototipo.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/84-prototipo.js'), HTML = read('index.html'), CSS = read('css/99-prototipo.css'), SEM = read('js/76-casca-semana.js');
const P = new Function(cut(JS, '// @proto-puro-inicio', '// @proto-puro-fim')
  + '\nreturn { PT_TELAS, PT_REF, ptNewId, ptTela, ptNovo, ptTituloDoPedido, ptOpenPins, ptBump, ptMergeScreens, ptLayout, ptFit, ptMentionsIn, ptMetaTx, ptAgoTx, ptAssetName };')();
const NOW = Date.UTC(2026, 9, 27, 12);

test('protótipo novo segue o modelo comum (desktop + celular, v1, sem comentários)', () => {
  const p = P.ptNovo({ source: 'ia', prompt: 'tela de checkout com cupom' }, NOW, 'Ana');
  assert.match(p.id, /^p-[a-z0-9]+$/);
  assert.equal(p.title, 'Tela de checkout com cupom');
  assert.equal(p.version, 1); assert.equal(p.createdBy, 'Ana'); assert.equal(p.source, 'ia'); assert.equal(p.taskId, null);
  assert.deepEqual(p.screens.map((s) => [s.id, s.w, s.h]), [['desk', 1280, 840], ['cel', 390, 844]]);
  assert.deepEqual([p.els, p.pins, p.history], [[], [], []]);
  assert.deepEqual(P.ptNovo({ source: 'branco', only: 'cel' }, NOW).screens.map((s) => s.id), ['cel']);
  assert.equal(P.ptNovo({ source: 'qualquer' }, NOW).source, 'branco');
  assert.equal(P.ptNovo({}, NOW).title, 'Protótipo sem nome');
});

test('versão nova sobe o número e anota quem e por quê', () => {
  const p = P.ptNovo({}, NOW, 'Bruno');
  assert.equal(P.ptBump(p, 'IA', 'IA gerou a 1ª versão', NOW + 1), 2);
  assert.deepEqual(p.history, [{ version: 2, at: NOW + 1, by: 'IA', note: 'IA gerou a 1ª versão' }]);
  P.ptBump(p, 'Carla', '', NOW + 2);
  assert.equal(p.version, 3); assert.equal(p.history[1].note, 'edição');
});

test('telas que chegam da IA entram por id: substitui a que existe, mantém tamanho, novas vão pro fim', () => {
  const old = [P.ptTela('desk', { html: '<p>a</p>' }), P.ptTela('cel')];
  const m = P.ptMergeScreens(old, [{ id: 'desk', html: '<div data-blk="pagar">Pagar</div>', css: 'b{}' }, { id: 'tab', html: 'x' }]);
  assert.deepEqual(m.map((s) => s.id), ['desk', 'cel', 'tab']);
  assert.equal(m[0].w, 1280); assert.equal(m[0].html, '<div data-blk="pagar">Pagar</div>');
  assert.equal(m[2].w, 820);
  assert.equal(old[0].html, '<p>a</p>', 'não muta o original');
  assert.deepEqual(P.ptMergeScreens(old, [null, {}]).map((s) => s.id), ['desk', 'cel']);
});

test('quadro: telas lado a lado, Referências no fim; o zoom que cabe ignora as Referências', () => {
  const L = P.ptLayout([P.ptTela('desk'), P.ptTela('cel')]);
  assert.deepEqual(L.map((a) => [a.id, a.x]), [['desk', 0], ['cel', 1360], ['ref', 1830]]);
  assert.ok(L[2].ref);
  const s = P.ptFit(L, 700, 600);
  assert.ok(P.ptFit(L, 700, 600, true) < s, 'com colagem nas Referências, elas entram no zoom');
  assert.ok(s > 0.3 && s < 0.4, 'cabe 1750px de telas em ~610px: ' + s);
  assert.equal(P.ptFit(L, 9000, 9000), 1, 'nunca passa de 100%');
});

test('comentários abertos, menções só de quem é do time, meta da lista', () => {
  assert.equal(P.ptOpenPins({ pins: [{ text: 'a' }, { text: 'b', resolved: true }, { text: '  ' }] }), 1);
  assert.deepEqual(P.ptMentionsIn('@Bruno dá pra validar? cc @Zé', ['Bruno', 'Carla']), ['Bruno']);
  assert.deepEqual(P.ptMentionsIn('@Bruno', []), [], 'sem time: sem menções');
  assert.equal(P.ptMetaTx({ createdBy: 'Ana', version: 2, openPins: 3 }), 'Ana · v2 · 3 comentários abertos');
  assert.equal(P.ptMetaTx({ createdBy: 'Elisa', version: 4, openPins: 0, taskId: 't1' }), 'Elisa · v4 · virou tarefa');
  assert.equal(P.ptAgoTx(NOW - 4 * 60e3, NOW), 'há 4 min');
  assert.match(P.ptAssetName('image/jpeg', NOW, 0.5), /^img-[a-z0-9]+\.jpg$/);
});

test('fiação: aba própria (nunca modal), item em TRABALHO, iframe sandbox sem scripts, ganchos exportados', () => {
  assert.match(HTML, /id="protoBtn"[^>]*>[\s\S]*?<span class="sbl">Protótipos<\/span><span class="sbcnt" id="protoCnt" hidden><\/span><\/button>/);
  assert.ok(HTML.indexOf('id="issuesBtn"') < HTML.indexOf('id="protoBtn"') && HTML.indexOf('id="protoBtn"') < HTML.indexOf('id="sbAbertasH"'), 'logo depois de Issues, em TRABALHO');
  assert.match(HTML, /class="overlay fwoverlay pgov" id="protoListOverlay"/);
  assert.match(HTML, /class="overlay fwoverlay pgov" id="protoOverlay"/);
  assert.ok(HTML.indexOf('js/83-verificacao.js') < HTML.indexOf('js/84-prototipo.js'));
  assert.match(HTML, /css\/99-prototipo\.css/);
  assert.match(JS, /VIEW_OVERLAY\.prototipos='protoListOverlay'; VIEW_OVERLAY\.prototipo='protoOverlay'/);
  assert.match(JS, /id:tid, kind:'prototipo', protoId:id/);
  // HTML gerado roda isolado: sandbox SEM allow-scripts
  const fr = JS.match(/<iframe class="pt-frame" sandbox="([^"]*)"/); assert.ok(fr); assert.ok(!/allow-scripts/.test(fr[1]));
  assert.ok(!/allow-scripts/.test(JS), 'nenhum iframe do protótipo roda script');
  for (const g of ['openPrototipo', 'protoNew', 'protoState', 'protoApplyScreens', 'protoSnapshot']) assert.match(JS, new RegExp('window\\.' + g + '=' + g));
  assert.match(JS, /new CustomEvent\('sf:proto-salvo', \{ detail:\{ id:p\.id, version:p\.version \} \}\)/);
  assert.match(JS, /window\.protoGerarIA/); assert.match(JS, /window\.protoParaDemanda/); assert.match(JS, /ia\.panelHtml/);
  assert.ok(!/window\.confirm\(|[^.]confirm\(/.test(JS), 'confirmação é askYes');
  assert.match(SEM, /ptSideSync\(\)/); assert.match(SEM, /'Protótipos','rascunhar a tela/);
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)/);
});

test('teclado: atalhos do quadro nunca roubam tecla de campo de texto nem do terminal', () => {
  const ty = cut(JS, 'function ptTyping(el)', '\n');
  assert.match(ty, /INPUT\|TEXTAREA\|SELECT/); assert.match(ty, /isContentEditable/); assert.match(ty, /\.xterm/);
  const k = cut(JS, 'function ptKey(e)', '\n}\n');
  assert.ok(k.indexOf("if(typing || e.metaKey || e.ctrlKey || e.altKey) return;") < k.indexOf("'VRTPCI'.includes(k)"), 'letras só fora de campo');
  assert.match(k, /if\(!ptTabOn\('prototipo'\) \|\| ptModal\(\)\) return;/);
});
