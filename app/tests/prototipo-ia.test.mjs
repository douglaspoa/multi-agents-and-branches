// Protótipo · a IA (85-prototipo-ia): sanitização, montagem do pedido, leitura do JSON da IA e aplicação das propostas.
// `node --test app/tests/prototipo-ia.test.mjs` — dados fictícios (loja-web; Ana, Bruno, Carla, Diego, Elisa).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/85-prototipo-ia.js');
const P = new Function(cut(JS, '// @pia-puro-inicio', '// @pia-puro-fim')
  + '\nreturn { piaSanitize, piaSanitizeCss, piaBadUrl, piaBlkRange, piaBlkOf, piaBlks, piaReplaceBlk, piaBlkContext, piaJsonFrom, piaParseGerar, piaParsePropostas, piaParseDiffs, piaApply, piaPromptGerar, piaPromptOlhar, piaPromptDiff, piaDiffAgentText, piaDemanda, piaKeyAsk, piaKeyUndo, piaDoc, piaOpenPins, piaScreenId };')();

const DESK = '<main class="lj"><section data-blk="cupom"><label for="c">Cupom</label><div class="rw"><input id="c" value="NATAL10"><button class="apl">Aplicar</button></div></section><section data-blk="resumo"><p>Subtotal R$ 189,00</p><div><p>Total</p></div></section><button data-blk="pagar">Pagar</button></main>';
const CEL = '<main class="lj m"><section data-blk="cupom"><label for="c2">Cupom</label><button class="apl">Aplicar</button></section><button data-blk="pagar" style="height:30px">Pagar</button></main>';
const proto = () => ({
  id: 'p-abc123', title: 'Checkout da loja-web', version: 2, prompt: 'checkout com cupom', createdBy: 'Carla', source: 'ia', taskId: null,
  screens: [{ id: 'desk', name: 'Desktop · 1280', w: 1280, h: 840, html: DESK, css: '.apl{background:#bfe8cf;color:#fff}' },
    { id: 'cel', name: 'Celular · 390', w: 390, h: 844, html: CEL, css: '.apl{background:#bfe8cf}' }],
  els: [],
  pins: [
    { id: 1, n: 1, screen: 'desk', x: 372, y: 182, target: 'botão Aplicar', selector: '[data-blk=cupom] .apl', who: 'Elisa', text: 'O botão Aplicar quase some: branco em verde clarinho.', replies: [], resolved: false, at: 1 },
    { id: 2, n: 2, screen: 'desk', x: 300, y: 220, target: 'cupom', selector: '[data-blk=cupom]', who: 'Carla', text: 'Cupom vencido precisa avisar.', replies: [], resolved: false, at: 2 },
    { id: 3, n: 3, screen: 'desk', x: 520, y: 80, target: 'resumo', selector: '[data-blk=resumo]', who: 'Ana', text: 'Desconto no resumo.', replies: [{ who: 'IA', text: 'IA: corrigido na v2 — Mostrar o desconto no resumo', at: 3 }], resolved: true, at: 3 },
  ],
  history: [],
});

test('sanitiza: sem script, on*, javascript:, iframe, srcdoc nem URL de fora (vários disfarces)', () => {
  const bad = [
    '<script>alert(1)</script><p>ok</p>',
    '<SCRIPT src=x></SCRIPT><p>ok</p>',
    '<scr<script>x</script>ipt>alert(1)</script><p>ok</p>',
    '<p>ok</p><script>sem fechar',
    '<img src=x onerror=alert(1)><p>ok</p>',
    '<svg/onload=alert(1)><p>ok</p>',
    '<a href="javascript:alert(1)">x</a><p>ok</p>',
    '<a href="java&#115;cript&colon;alert(1)">x</a><p>ok</p>',
    '<a href=" JaVaScRiPt:alert(1)">x</a><p>ok</p>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><p>ok</p>',
    '<object data="x.swf"></object><embed src="x"><p>ok</p>',
    '<form action="javascript:alert(1)"><button formaction="javascript:x">b</button></form><p>ok</p>',
    '<div style="background:url(javascript:alert(1))">x</div><p>ok</p>',
    '<link rel="stylesheet" href="https://mal.example/x.css"><meta http-equiv="refresh" content="0;url=https://mal.example"><base href="https://mal.example/"><p>ok</p>',
    '<img src="https://rastreador.example/p.png"><p>ok</p>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a><p>ok</p>',
    '<style>@import url(https://mal.example/x.css); .a{width:expression(alert(1))}</style><p>ok</p>',
    '<!-- <script>alert(1)</script> --><p>ok</p>',
    '<div onclick = "alert(1)" ONMOUSEOVER=\'x\'>x</div><p>ok</p>',
  ];
  for (const h of bad) {
    const s = P.piaSanitize(h);
    assert.ok(!/<script|<iframe|<object|<embed|<link|<meta|<base/i.test(s), 'tag perigosa: ' + h + ' → ' + s);
    assert.ok(!/\son[a-z]+\s*=/i.test(s), 'on*: ' + s);
    assert.ok(!/javascript:|java&#|srcdoc|expression\(|@import|https?:\/\//i.test(s), 'url/código: ' + s);
    assert.ok(s.includes('<p>ok</p>') || h.includes('sem fechar'), 'o conteúdo bom fica: ' + s);
    assert.equal(P.piaSanitize(s), s, 'idempotente');
  }
  // o que é legítimo continua: data-blk, classes, estilos, rótulos, imagem local e data:image
  const ok = '<section data-blk="cupom" class="c" style="color:#1f7a4d"><label for="x">Cupom</label><input id="x" aria-label="Cupom"><img src="assets/print.png" alt="print"><img src="data:image/png;base64,AAA=" alt=""></section>';
  const s = P.piaSanitize(ok);
  for (const k of ['data-blk="cupom"', 'class="c"', 'style="color:#1f7a4d"', 'for="x"', 'aria-label="Cupom"', 'src="assets/print.png"', 'src="data:image/png;base64,AAA="']) assert.ok(s.includes(k), k + ' em ' + s);
  assert.ok(!P.piaSanitizeCss('a{x:1}</style><script>').includes('</style'));
  assert.ok(!/<script/i.test(P.piaDoc('<p>x</p><script>1</script>', 'p{}</style><script>alert(1)</script>')));
});

test('blocos data-blk: acha o bloco com aninhamento e troca só ele', () => {
  const html = '<div data-blk="a"><div><div>x</div></div></div><div data-blk="b">y</div>';
  assert.equal(P.piaBlkOf(html, 'a'), '<div data-blk="a"><div><div>x</div></div></div>');
  assert.equal(P.piaBlkOf(html, 'b'), '<div data-blk="b">y</div>');
  assert.equal(P.piaBlkRange(html, 'z'), null);
  assert.deepEqual(P.piaBlks(DESK), ['cupom', 'resumo', 'pagar']);
  // a IA esqueceu o data-blk no html novo: ganha o nome; e o resto fica igual
  const r = P.piaReplaceBlk(html, 'a', '<section class="novo">z</section>');
  assert.equal(r, '<section data-blk="a" class="novo">z</section><div data-blk="b">y</div>');
  assert.equal(P.piaReplaceBlk(html, 'z', '<p>x</p>'), null);
  // antes/depois: o bloco vai dentro das mesmas caixas (os seletores .lj .apl continuam valendo)
  assert.deepEqual(P.piaBlkContext(DESK, 'pagar'), { open: '<main class="lj">', close: '</main>' });
  assert.deepEqual(P.piaBlkContext('<main class="lj"><div class="g"><br><img src="a.png"><section data-blk="x">y</section></div></main>', 'x'), { open: '<main class="lj"><div class="g">', close: '</div></main>' });
  assert.deepEqual(P.piaBlkContext('<div><p>a</p></div><div class="b"><i data-blk="x"></i></div>', 'x'), { open: '<div class="b">', close: '</div>' });
  // html novo com script é limpo na troca
  assert.ok(!P.piaReplaceBlk(html, 'b', '<div data-blk="b" onclick="x()">y<script>1</script></div>').includes('script'));
});

test('JSON da IA: bloco ```json, texto em volta, último bloco vale; sem JSON → erro acionável', () => {
  assert.deepEqual(P.piaJsonFrom('Aqui:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(P.piaJsonFrom('blá {"a":{"b":"}"}} fim'), { a: { b: '}' } });
  assert.deepEqual(P.piaJsonFrom('```json\n{"a":1}\n```\n```json\n{"a":2}\n```'), { a: 2 });
  assert.throws(() => P.piaJsonFrom('não consegui'), /JSON combinado/);
});

test('gerar: devolve Desktop e Celular sanitizados (falta uma → copia a outra); sem tela → erro', () => {
  const r = P.piaParseGerar('```json\n' + JSON.stringify({ title: 'Checkout', screens: [{ id: 'desktop', html: '<main data-blk="x" onclick="a()">ok<script>1</script></main>', css: '@import url(x); a{color:red}' }] }) + '\n```', 'checkout');
  assert.equal(r.title, 'Checkout');
  assert.deepEqual(r.screens.map((s) => [s.id, s.w, s.h]), [['desk', 1280, 840], ['cel', 390, 844]]);
  assert.ok(!/script|onclick/.test(r.screens[0].html) && !/@import/.test(r.screens[0].css));
  assert.equal(r.screens[1].html, r.screens[0].html);
  const r2 = P.piaParseGerar(JSON.stringify({ screens: [{ id: 'cel', w: 390, h: 844, html: '<p>c</p>' }, { id: 'desk', html: '<p>d</p>' }] }), 'Tela de cupom vencido. E mais');
  assert.equal(r2.title, 'Tela de cupom vencido');
  assert.equal(r2.screens[0].html, '<p>d</p>');
  assert.throws(() => P.piaParseGerar('{"screens":[]}', 'x'), /nenhuma tela/);
});

test('olhar: o pedido leva telas, comentários ABERTOS com posição/alvo/seletor/recorte e a crítica quando ligada', () => {
  const p = proto();
  const txt = P.piaPromptOlhar(p, { crit: true, crops: { 1: '/repo/.cardume/prototipos/p-abc123/assets/ia-pin-1-v2.png' }, shots: { desk: '/repo/x/ia-desk-v2.png' } });
  assert.ok(txt.includes('"alvo": "botão Aplicar"') && txt.includes('"seletor": "[data-blk=cupom] .apl"') && txt.includes('"x": 372'));
  assert.ok(txt.includes('ia-pin-1-v2.png') && txt.includes('ia-desk-v2.png'));
  assert.ok(!txt.includes('Desconto no resumo'), 'comentário resolvido não vai');
  assert.ok(txt.includes('"blocos"') && txt.includes('"cupom"'));
  assert.ok(/contraste/.test(txt) && /44px/.test(txt) && /Padrões do time/.test(txt));
  assert.ok(/desligada/.test(P.piaPromptOlhar(p, { crit: false })));
  assert.ok(/refaça SÓ a proposta do comentário 1/.test(P.piaPromptOlhar(p, { ajuste: { pinId: 1, titulo: 'Escurecer', pedido: 'verde da marca' } })));
  const g = P.piaPromptGerar('checkout com cupom', { project: 'loja-web' });
  assert.ok(g.includes('loja-web') && /Desktop \(1280×840\)/.test(g) && /Celular \(390×844\)/.test(g) && g.includes('data-blk'));
});

test('propostas: só de comentário aberto ou crítica; sanitizadas; tela e bloco normalizados', () => {
  const p = proto();
  const resp = '```json\n' + JSON.stringify({ propostas: [
    { pinId: 1, titulo: 'Escurecer o botão Aplicar', explicacao: 'Contraste 1,6:1 → 5,4:1.', blk: 'cupom', screen: 'desk', html: '<section data-blk="cupom"><button class="apl" style="background:#1f7a4d" onclick="x()">Aplicar</button></section>', css: '' },
    { pinId: 3, titulo: 'já resolvido', blk: 'resumo', html: '<p>x</p>' },
    { pinId: 99, titulo: 'inventado', blk: 'x', html: '<p>x</p>' },
    { pinId: 1, titulo: 'duplicado', blk: 'cupom', html: '<p>x</p>' },
    { pinId: null, titulo: 'Botão Pagar com 44px no celular', blk: 'Pagar', screen: 'Celular', html: '', css: '[data-blk=pagar]{min-height:44px}' },
  ] }) + '\n```';
  const L = P.piaParsePropostas(resp, p);
  assert.deepEqual(L.map((x) => x.key), ['p1', 'c4']);
  assert.ok(!L[0].html.includes('onclick'));
  assert.equal(L[1].crit, true); assert.equal(L[1].blk, 'pagar'); assert.equal(L[1].screen, 'cel');
});

test('aplicar: só as aceitas; nova versão; comentário resolvido com "IA: corrigido na vN"; crítica vira comentário resolvido; nada muta a entrada', () => {
  const p = proto(); const snap = JSON.stringify(p);
  const props = [
    { key: 'p1', pinId: 1, crit: false, titulo: 'Escurecer o botão Aplicar', explicacao: '', blk: 'cupom', screen: null, html: '<section data-blk="cupom"><button class="apl ok">Aplicar</button></section>', css: '.apl.ok{background:#1f7a4d}' },
    { key: 'p2', pinId: 2, crit: false, titulo: 'Avisar cupom vencido', explicacao: '', blk: 'cupom-erro', screen: 'desk', html: '<p data-blk="cupom-erro">x</p>', css: '' },
    { key: 'c4', pinId: null, crit: true, titulo: 'Botão Pagar com 44px', explicacao: '30px → 44px', blk: 'pagar', screen: 'cel', html: '', css: '[data-blk=pagar]{min-height:44px}' },
  ];
  const r = P.piaApply(p, props, { p1: 'ok', p2: 'ok', c4: 'ok' }, { now: 99 });
  assert.equal(JSON.stringify(p), snap, 'não muta');
  assert.equal(r.version, 3);
  assert.equal(r.applied, 2); assert.deepEqual(r.skipped, ['p2'], 'bloco inexistente fica de fora (não finge que corrigiu)');
  // sem tela escolhida: muda nas duas telas que têm o bloco
  assert.ok(r.screens[0].html.includes('class="apl ok"') && r.screens[1].html.includes('class="apl ok"'));
  assert.ok(r.screens[0].html.includes('data-blk="resumo"'), 'o resto da tela fica');
  assert.ok(r.screens[1].css.includes('min-height:44px') && !r.screens[0].css.includes('min-height:44px'), 'crítica só no celular');
  const pin1 = r.pins.find((x) => x.id === 1);
  assert.equal(pin1.resolved, true); assert.equal(pin1.replies.at(-1).text, 'IA: corrigido na v3 — Escurecer o botão Aplicar'); assert.equal(pin1.replies.at(-1).who, 'IA');
  assert.equal(r.pins.find((x) => x.id === 2).resolved, false, 'não aplicada = continua aberta');
  const crit = r.pins.at(-1);
  assert.deepEqual([crit.id, crit.n, crit.who, crit.resolved, crit.screen, crit.selector], [4, 4, 'IA', true, 'cel', '[data-blk=pagar]']);
  // recusadas ou sem decisão não mudam nada
  const r0 = P.piaApply(p, props, { p1: 'no' }, { now: 1 });
  assert.equal(r0.applied, 0); assert.equal(JSON.stringify(r0.screens), JSON.stringify(p.screens));
});

test('diferenças: leitura do JSON e o pedido pro terminal no formato da Mira', () => {
  const r = P.piaParseDiffs('```json\n{"iguais":4,"diffs":[{"titulo":"Desconto não aparece no resumo","detalhe":"o protótipo tem a linha Desconto (NATAL10)","blk":"resumo"},{"x":1}]}\n```');
  assert.equal(r.iguais, 4); assert.equal(r.diffs.length, 1); assert.equal(r.diffs[0].blk, 'resumo');
  const t = P.piaDiffAgentText(r.diffs, { title: 'Checkout da loja-web', version: 3, screen: 'cel', ref: 'docs/prototipos/checkout-da-loja-web/', realRel: '.cardume/refs/prototipo-previa.png' });
  assert.ok(t.startsWith('Diferenças entre a Prévia e o protótipo "Checkout da loja-web" v3 (Celular) · 1 item:'));
  assert.ok(t.includes('[1] Desconto não aparece no resumo — o protótipo tem a linha Desconto (NATAL10) · bloco do protótipo [data-blk=resumo]'));
  assert.ok(t.includes('docs/prototipos/checkout-da-loja-web/') && t.includes('@.cardume/refs/prototipo-previa.png') && /não copie o HTML/.test(t));
  assert.equal(P.piaDiffAgentText([], {}), '');
  const pd = P.piaPromptDiff(proto(), 'cel', { realShot: '/w/.cardume/refs/prototipo-previa.png', branch: 'feat/cupom' });
  assert.ok(pd.includes('Celular · 390') && pd.includes('feat/cupom') && pd.includes('prototipo-previa.png'));
});

test('demanda: "Pronto quando" dos resolvidos (com quem pediu), crítica marcada, abertos como pendência e a referência', () => {
  const p = proto();
  p.pins.push({ id: 4, n: 4, screen: 'cel', who: 'IA', text: 'Crítica: Botão Pagar com 44px — 30px → 44px', replies: [{ who: 'IA', text: 'IA: corrigido na v2 — Botão Pagar com 44px' }], resolved: true });
  const d = P.piaDemanda(p, { ref: 'docs/prototipos/checkout-da-loja-web/' });
  assert.equal(d.title, 'Checkout da loja-web');
  assert.deepEqual(d.reqs, [{ text: 'Mostrar o desconto no resumo', from: 'Ana · #3' }, { text: 'Botão Pagar com 44px', from: 'crítica de design' }]);
  assert.equal(d.open, 2); assert.equal(d.resolved, 2);
  assert.ok(d.objective.includes('docs/prototipos/checkout-da-loja-web/') && /REFERÊNCIA visual/.test(d.objective) && /não copie o HTML/.test(d.objective));
  assert.ok(d.objective.includes('PENDÊNCIAS') && d.objective.includes('#1 Elisa em botão Aplicar'));
});

test('atalhos: ⌘↵ pede pra IA olhar (fora do terminal); ⌘Z não rouba campo de texto', () => {
  const el = (tag, xterm) => ({ tagName: tag, closest: (s) => (xterm && s === '.xterm' ? {} : null) });
  assert.equal(P.piaKeyAsk({ metaKey: true, key: 'Enter', target: el('DIV') }), true);
  assert.equal(P.piaKeyAsk({ ctrlKey: true, key: 'Enter', target: el('TEXTAREA') }), true, '⌘↵ vale dentro do comentário');
  assert.equal(P.piaKeyAsk({ metaKey: true, key: 'Enter', target: el('DIV', true) }), false);
  assert.equal(P.piaKeyAsk({ key: 'Enter', target: el('DIV') }), false);
  assert.equal(P.piaKeyUndo({ metaKey: true, key: 'z', target: el('BUTTON') }), true);
  assert.equal(P.piaKeyUndo({ metaKey: true, key: 'z', target: el('TEXTAREA') }), false);
  assert.equal(P.piaKeyUndo({ metaKey: true, shiftKey: true, key: 'z', target: el('DIV') }), false);
});

test('pontes: Prévia chama a comparação, Nova demanda tem o chip e liga a tarefa; script e css carregados', () => {
  const MR = read('js/79-previa-mira.js'), PL = read('js/32-planner.js'), HTML = read('index.html');
  assert.ok(MR.includes("piaCmpOn(t)") && MR.includes('piaCmpPaint(t, root)') && MR.includes('piaCmpToolsHtml(t)'));
  assert.ok(PL.includes('Rascunhar a tela') && PL.includes('protoRascunharDaDemanda(plGuessText())'));
  assert.ok(PL.includes('protoAfterTaskCreated(localId, ntSubmitCtx.tab)') && PL.includes('protoLinkTask(plFields.protoId, nid)') && PL.includes('protoPayloadRef(plFields.protoId, payload)'));
  assert.ok(HTML.indexOf('js/85-prototipo-ia.js') > HTML.indexOf('js/79-previa-mira.js'));
  assert.ok(HTML.includes('css/99-prototipo-ia.css'));
  for (const k of ['window.protoIA=', 'window.protoGerarIA=', 'window.protoParaDemanda=']) assert.ok(JS.includes(k), k);
  // tudo atrás de typeof: a outra frente pode não estar no mesmo build
  for (const f of ['protoApplyScreens', 'protoSnapshot', 'openPrototipo', 'protoNew', 'protoState']) assert.ok(new RegExp('typeof ' + f + "[!=]=='function'").test(JS), f);
});
