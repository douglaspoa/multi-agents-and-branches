// Dentro de uma tarefa (redesenho "Semana", 14/10): as etapas na lateral (77-tarefa-etapas.js), o Código explicado com
// conversa no trecho (78-codigo-explicado.js) e a Prévia com Mira (79-previa-mira.js) — as partes puras.
// `node --test app/tests/tarefa-etapas.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TE = new Function('esc', 'escA', cut(read('js/77-tarefa-etapas.js'), '// @te-puro-inicio', '// @te-puro-fim') +
  '\nreturn { TE_STEPS, TE_RAIL_W, teStepOfMode, teStepsOf, teStepKey, teStepMeta, teRanWith, teRailHtml };')(esc, esc);
const CX = new Function('esc', 'escA', cut(read('js/78-codigo-explicado.js'), '// @cx-puro-inicio', '// @cx-puro-fim') +
  '\nreturn { cxRange, cxHunkSpan, cxRef, cxWhyOf, cxTurnAt, cxFileSummary, cxAnswerOf, cxPtyText, CX_SRC_LABEL, cxIsBin, cxOrderFiles, cxChipFiles, CX_CHIPS_MAX };')(esc, esc);
const MR = new Function('esc', 'escA', cut(read('js/79-previa-mira.js'), '// @mr-puro-inicio', '// @mr-puro-fim') +
  '\nreturn { MR_DEVS, mrSelShort, mrRequestText, mrChangedOf, mrKeyToggles };')(esc, esc);

// ---------------- etapas ----------------
test('etapas: 5, na ordem do mock, ⌘ fixo por etapa; PR mora na Revisão; não-código esconde Código e Revisão', () => {
  assert.deepEqual(TE.TE_STEPS.map((s) => s.n), ['Conversa', 'Código explicado', 'Revisão', 'Prévia', 'Entrega']);
  assert.equal(TE.teStepOfMode('pr'), 'revisao');
  assert.equal(TE.teStepOfMode('codigo'), 'codigo');
  assert.equal(TE.teStepOfMode('qualquer'), 'conversa');
  assert.deepEqual(TE.teStepsOf(true).map((s) => [s.k, s.key]), [['conversa', 1], ['previa', 4], ['entrega', 5]]);
  assert.ok(TE.TE_RAIL_W <= 176, 'lateral estreita (terminal ≥ 100 colunas a 1000 px)');
});
test('atalho: ⌘1–5 no Mac MESMO no terminal; Ctrl fora do Mac, menos no terminal; shift/alt não', () => {
  const k = (key, o) => Object.assign({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, o);
  assert.equal(TE.teStepKey(k('2', { metaKey: true }), true, true), 1);
  assert.equal(TE.teStepKey(k('5', { metaKey: true }), true, false), 4);
  assert.equal(TE.teStepKey(k('6', { metaKey: true }), true, false), -1);
  assert.equal(TE.teStepKey(k('1', { ctrlKey: true }), true, false), -1, 'Ctrl no Mac é do terminal');
  assert.equal(TE.teStepKey(k('1', { ctrlKey: true }), false, false), 0);
  assert.equal(TE.teStepKey(k('1', { ctrlKey: true }), false, true), -1, 'Linux/Windows com o foco no terminal: Ctrl+1 fica com o shell');
  assert.equal(TE.teStepKey(k('1', { metaKey: true, shiftKey: true }), true, false), -1);
});
test('estado de cada etapa numa linha (sem inventar)', () => {
  assert.equal(TE.teStepMeta('conversa', { stLabel: 'rodando', running: true, turn: 7 }), 'Rodando · 7ª resposta');
  assert.equal(TE.teStepMeta('conversa', { done: true }), 'encerrada');
  assert.equal(TE.teStepMeta('codigo', { files: 3, hunks: 5, threads: 1 }), '3 arquivos · 5 trechos · 1 conversa');
  assert.equal(TE.teStepMeta('codigo', { files: 0 }), 'nada mudou ainda');
  assert.equal(TE.teStepMeta('revisao', { reqOk: 2, reqTot: 4 }), '2 de 4 com prova');
  assert.equal(TE.teStepMeta('revisao', { reqTot: 0 }), 'sem requisitos');
  assert.equal(TE.teStepMeta('previa', { prevChanged: true }), 'mudou · comparar');
  assert.equal(TE.teStepMeta('entrega', {}), 'ainda não');
});
test('"foi pro agente" vem do que a tarefa registrou (roleRuns + memNotes)', () => {
  const r = TE.teRanWith({ roleRuns: [{ name: 'vega', version: 3, skills: ['testes-carrinho@v2'] }, { name: 'iris', version: 5, skills: ['testes-carrinho@v2', 'acessibilidade@v1.3'] }], memNotes: [{ title: 'Centavos inteiros na API', by: 'Bruno' }] });
  assert.deepEqual(r, { skills: ['testes-carrinho@v2', 'acessibilidade@v1.3'], agents: ['Vega v3', 'Iris v5'], notes: ['Centavos inteiros na API'] });
  assert.deepEqual(TE.teRanWith({}), { skills: [], agents: [], notes: [] });
});
test('lateral da tarefa: tudo clicável por [data-te] (a casca só põe o HTML) e escapa o título', () => {
  const h = TE.teRailHtml({ taskId: 't1', back: { label: 'Semana do time' }, needMe: 4, code: 'LOJA-12', title: 'Carrinho <b>x</b>', who: '', cur: 'codigo',
    steps: TE.teStepsOf(false).map((s) => Object.assign({}, s, { meta: 'm' })), open: [{ id: 'task:t2', code: 'LOJA-9', title: 'Checkout', color: 'var(--ok)' }] });
  assert.match(h, /data-te="back"[^>]*>.*Semana do time/);
  assert.match(h, /data-te="needme".*<span class="te-cnt">4<\/span>/);
  assert.match(h, /data-te="step" data-k="codigo" aria-current="page"/);
  assert.match(h, /⌘2/);
  assert.match(h, /data-te="open" data-id="task:t2"/);
  assert.ok(h.includes('Carrinho &lt;b&gt;x&lt;/b&gt;') && !h.includes('<b>x</b>'));
});

// ---------------- Código explicado ----------------
const hunk = (rows, n = 12) => ({ n, o: n, rows });
const H14 = hunk([{ t: 'ctx', o: 12, n: 12, text: 'a' }, { t: 'del', o: 14, text: 'b' }, { t: 'add', n: 14, text: 'c' }, { t: 'add', n: 15, text: 'd' }, { t: 'ctx', o: 15, n: 16, text: '}' }]);
const REQS = [{ text: 'Aviso de cupom vencido', did: 'aviso com a data', code: [{ file: 'src/useCupom.ts', lines: '32-35' }], tests: [{ name: 'carrinho.test.ts › avisa' }] },
  { text: 'Total com frete', did: '', code: [{ file: 'src/total.ts', lines: '14-15' }], tests: [] }];
test('faixa do hunk no arquivo novo e a referência @arquivo:i-f', () => {
  assert.deepEqual(CX.cxHunkSpan(H14), { a: 12, b: 16 });
  assert.deepEqual(CX.cxHunkSpan(hunk([{ t: 'del', o: 9, text: 'x' }], 9)), { a: 9, b: 9, delOnly: true });
  assert.equal(CX.cxRef('src/total.ts', 14, 15), '@src/total.ts:14-15');
  assert.equal(CX.cxRef('src/total.ts', 22, 22), '@src/total.ts:22');
  assert.deepEqual(CX.cxRange('14 – 15'), { a: 14, b: 15 });
  assert.equal(CX.cxRange('lixo'), null);
});
test('o porquê do trecho: agente > mapa do requisito > conversa > commit > PR > nada', () => {
  const span = { a: 12, b: 16 };
  const reasons = [{ file: 'src/total.ts', range: '14-15', requirement: 'R2', reason: 'frete antes do desconto', covered_by: 't › frete', ts: 1000 }];
  const ag = CX.cxWhyOf({ file: 'src/total.ts', span, reasons, reqs: REQS });
  assert.deepEqual([ag.src, ag.req, ag.why, ag.covered], ['agente', 'R2', 'frete antes do desconto', 't › frete']);
  const mapa = CX.cxWhyOf({ file: 'src/useCupom.ts', span: { a: 30, b: 36 }, reasons: [], reqs: REQS });
  assert.deepEqual([mapa.src, mapa.req, mapa.why, mapa.covered], ['mapa', 'R1', 'aviso com a data', 'carrinho.test.ts › avisa']);
  const hist = [{ k: 'you', ts: 1, text: 'vai' }, { k: 'say', ts: 2, text: 'Arredondo pra centavos porque o teste compara exato.' }, { k: 'edit', ts: 3, arg: 'src/total.ts' }];
  const conv = CX.cxWhyOf({ file: 'src/total.ts', span: { a: 21, b: 22 }, reasons, reqs: REQS, hist });
  assert.deepEqual([conv.src, conv.req, conv.why], ['conversa', null, 'Arredondo pra centavos porque o teste compara exato.']);
  const cm = CX.cxWhyOf({ file: 'src/x.ts', span, reasons: [], reqs: [], hist: [], commits: [{ subject: 'fix: frete antes do desconto' }] });
  assert.equal(cm.src, 'commit');
  assert.equal(CX.cxWhyOf({ file: 'src/x.ts', span, reasons: [], reqs: [], commits: [{ subject: 'a b c' }, { subject: 'd e f' }], prBody: '## Resumo\nO cupom passa a valer sobre o total com frete.' }).src, 'pr');
  const none = CX.cxWhyOf({ file: 'src/x.ts', span, reasons: [], reqs: [] });
  assert.deepEqual([none.src, none.why], ['', '']);
  assert.match(CX.CX_SRC_LABEL.conversa, /inferido da conversa/);
});
test('Nª resposta pelo transcript, resumo do arquivo sem chamar a IA', () => {
  const hist = [{ k: 'you', ts: 10 }, { k: 'say', ts: 11 }, { k: 'you', ts: 20 }, { k: 'you', ts: 30 }];
  assert.equal(CX.cxTurnAt(hist, 25), 2);
  assert.equal(CX.cxTurnAt(hist, 0), 0);
  assert.equal(CX.cxFileSummary([{ why: 'A.', src: 'agente' }, { why: 'A.', src: 'conversa' }, { why: 'B.', src: 'mapa' }, { why: 'C.', src: 'agente' }]), 'A. B.');
});
test('a resposta da IA do fio sai do transcript: a sua fala com a referência e o que veio depois', () => {
  const ref = '@src/total.ts:14-15';
  const hist = [{ k: 'you', ts: 5000, text: ref + ' Por que?' }, { k: 'say', ts: 5100, text: 'Porque a LOJA-12 manda.' }, { k: 'tool', ts: 5200 }, { k: 'say', ts: 5300, text: 'Cito total.ts:14.' }];
  assert.deepEqual(CX.cxAnswerOf(hist, ref, 4000, true), { found: true, text: 'Porque a LOJA-12 manda.\n\nCito total.ts:14.', done: false });
  assert.equal(CX.cxAnswerOf(hist, ref, 4000, false).done, true);
  assert.equal(CX.cxAnswerOf(hist.concat([{ k: 'you', ts: 6000, text: 'outra' }]), ref, 4000, true).done, true);
  assert.equal(CX.cxAnswerOf(hist, '@outro.ts:1', 4000, false).found, false);
});
test('o texto de cada botão (uma fonte só: vai pro terminal)', () => {
  const ref = '@src/total.ts:14-15';
  assert.equal(CX.cxPtyText('ask', ref, ' Por que  o frete? '), ref + ' Por que o frete?');
  assert.equal(CX.cxPtyText('ask', ref, ''), '');
  assert.equal(CX.cxPtyText('paste', ref, ''), ref + ' ');
  assert.equal(CX.cxPtyText('alt', ref, 'aplique só no subtotal'), 'Altere ' + ref + ': aplique só no subtotal');
  assert.match(CX.cxPtyText('why', ref), /^@src\/total\.ts:14-15 Por que este trecho mudou\?.*register_change_reason/);
});

// ---------------- Prévia com Mira ----------------
test('Mira: o pedido numerado com @anexo e seletor de cada elemento', () => {
  const t = MR.mrRequestText([{ selector: 'div.res > button.pagar:nth-of-type(1)', text: 'Pagar com Pix', note: 'Botão maior', rel: '.cardume/refs/mira-1.png' }, { selector: 'p.prazo', text: 'Chega em 3 dias úteis', note: '' }], 'ios', 'http://localhost:5173/carrinho');
  const L = t.split('\n');
  assert.equal(L[0], 'Pedido pela Mira na Prévia (iPhone · http://localhost:5173/carrinho) · 2 elementos:');
  assert.equal(L[1], '[1] div.res > button.pagar:nth-of-type(1) "Pagar com Pix" → Botão maior');
  assert.equal(L[2], '    anexo @.cardume/refs/mira-1.png (print recortado) · seletor div.res > button.pagar:nth-of-type(1)');
  assert.match(L[3], /^\[2\] p\.prazo "Chega em 3 dias úteis" → \(sem texto/);
  assert.match(L[4], /anexo \(sem print\)/);
  assert.equal(MR.mrRequestText([], 'web'), '');
  assert.equal(MR.mrSelShort('div.res > button.pagar:nth-of-type(1)'), 'button.pagar');
  assert.deepEqual(MR.MR_DEVS.map((d) => d.n), ['Navegador', 'iPhone', 'Android']);
});
test('Mira: "mudou" só com edição da IA depois do envio; tecla M fora de campo e do terminal', () => {
  assert.equal(MR.mrChangedOf(1000, [{ type: 'edit', ts: 900 }]), false);
  assert.equal(MR.mrChangedOf(1000, [{ type: 'write', ts: 2000 }]), true);
  assert.equal(MR.mrChangedOf(0, [{ type: 'edit', ts: 2000 }]), false);
  const el = (tag, xterm) => ({ tagName: tag, isContentEditable: false, closest: (s) => (xterm && s === '.xterm' ? {} : null) });
  assert.equal(MR.mrKeyToggles({ key: 'm', target: el('DIV') }), true);
  assert.equal(MR.mrKeyToggles({ key: 'M', target: el('BUTTON') }), true);
  assert.equal(MR.mrKeyToggles({ key: 'm', target: el('TEXTAREA') }), false);
  assert.equal(MR.mrKeyToggles({ key: 'm', target: el('DIV', true) }), false, 'no terminal o m é do shell');
  assert.equal(MR.mrKeyToggles({ key: 'm', metaKey: true, target: el('DIV') }), false);
});
test('ordem de carga: 75 → 76 → 77 depois de tudo que eles usam; CSS da etapa no fim', () => {
  const h = read('index.html');
  const i75 = h.indexOf('js/77-tarefa-etapas.js'), i76 = h.indexOf('js/78-codigo-explicado.js'), i77 = h.indexOf('js/79-previa-mira.js');
  assert.ok(i75 > h.indexOf('js/72-corrente-tarefa.js') && i76 > i75 && i77 > i76 && i77 < h.indexOf('js/99-e2e.js'));
  assert.ok(h.indexOf('css/99-tarefa-etapas.css') > h.indexOf('css/95-terminal.css'));
});

test('Código explicado com centenas de assets: código primeiro, binário fora dos chips (bug 15/10)', () => {
  const imgs = Array.from({ length: 240 }, (_, i) => ({ path: `public/assets/sprite_${i}.png`, add: 0, del: 0 }));
  const files = [...imgs.slice(0, 120), { path: 'public/assets/CREDITS.TXT', add: 101, del: 0 },
    { path: 'src/combate/golpe.ts', add: 40, del: 6 }, { path: 'pack.zip', add: 0, del: 0 }, ...imgs.slice(120)];
  const ord = CX.cxOrderFiles(files);
  assert.equal(ord[0].path, 'src/combate/golpe.ts', 'código antes de texto solto');
  assert.equal(ord[1].path, 'public/assets/CREDITS.TXT');
  assert.ok(ord.slice(2).every(f => CX.cxIsBin(f)), 'binários no fim');
  const chips = CX.cxChipFiles(ord, ord[0].path);
  assert.equal(chips.length, 2, 'só código/texto vira chip');
  assert.ok(CX.cxChipFiles(ord, 'pack.zip').some(f => f.path === 'pack.zip'), 'o aberto sempre aparece');
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `src/m${i}.ts`, add: i + 1, del: 0 }));
  assert.equal(CX.cxChipFiles(CX.cxOrderFiles(many), null).length, CX.CX_CHIPS_MAX);
});
