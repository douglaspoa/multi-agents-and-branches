// Quadro ao vivo (87-quadro): saneamento dos passos da IA, traço à mão determinístico, caneta da pessoa, pedidos pra IA.
// `node --test app/tests/quadro.test.mjs` — dados fictícios (loja-web; Ana, Bruno, Carla).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/87-quadro.js');
const Q = new Function(cut(JS, '// @qd-puro-inicio', '// @qd-puro-fim')
  + '\nreturn { QD_W, QD_H, QD_MAX_STEPS, QD_COLORS, qdStep, qdSanitize, qdJsonFrom, qdParse, qdShapes, qdRng, qdMineClean, qdMinePath, qdBBox, qdLabels, qdNear, qdMineInfo, qdTaskCtx, qdPromptDesenhar, qdPromptPergunta, qdSceneText, qdWantsDraw, qdApplyText, qdNewId, qdIdOk, qdDoc, qdSpeedNext, qdSpeedLabel, qdSayMs, qdIsDraw };')();

// a resposta de exemplo (a mesma do harness): o trilho da main, do mock
const TRILHO = {
  title: 'Por que o checkout perdia o cupom',
  steps: [
    { say: 'Vou desenhar o caminho do cupom como um trilho.' },
    { line: [90, 300, 930, 300], color: 'ink' }, { text: [40, 308], s: 'checkout', size: 28 },
    { dot: [170, 300] }, { dot: [430, 300] },
    { say: 'Aqui o carrinho recalcula e esquece o cupom.' },
    { circle: [430, 300, 46, 30], color: 'blue' }, { text: [360, 380], s: 'recalcula o total', size: 24, color: 'blue' },
    { arrow: [430, 240, 600, 140], bend: -30, color: 'red' }, { text: [610, 140], s: 'cupom some!', color: 'red' },
    { cross: [820, 300, 22], color: 'red' }, { check: [900, 200, 16], color: 'green' },
    { box: [600, 420, 300, 90], label: 'guardar o cupom no carrinho', color: 'green' },
    { file: [100, 400, 120, 150], label: 'pedido.json', color: 'green' }, { mark: [30, 280, 140, 40] },
  ],
  changes: ['Guardar o cupom quando o total for recalculado'],
};

test('saneia: tipos, limites do viewBox, cor fora da lista vira ink, texto ≤ 140, passo estranho some sem quebrar', () => {
  assert.deepEqual(Q.qdStep({ box: [-40, 10, 2000, 80], label: 'x', color: 'roxo' }), { box: [0, 10, 1000, 80], color: 'ink', label: 'x' });
  assert.deepEqual(Q.qdStep({ box: [100, 100, -50, 40] }), { box: [50, 100, 50, 40], color: 'ink' }, 'largura negativa vira a caixa certa');
  assert.equal(Q.qdStep({ box: [999, 10, 50, 50] }), null, 'caixa sem área dentro do quadro');
  assert.deepEqual(Q.qdStep({ arrow: [10, 10, 5000, -9], bend: 999, color: 'RED' }), { arrow: [10, 10, 1000, 0], color: 'red', bend: 200 });
  assert.equal(Q.qdStep({ line: [10, 10, 11, 11] }), null, 'linha de 1 px não é traço');
  assert.deepEqual(Q.qdStep({ circle: [500, 300, 40] }), { circle: [500, 300, 40, 40], color: 'ink' }, 'círculo com um raio só');
  assert.deepEqual(Q.qdStep({ text: [10, 5], s: 'oi', size: 300 }).size, 56);
  assert.equal(Q.qdStep({ text: [10, 5], s: 'oi' }).text[1] >= 20, true, 'linha de base não sai por cima');
  assert.equal(Q.qdStep({ text: [10, 50], s: '   ' }), null);
  assert.equal(Q.qdStep({ say: 'a'.repeat(400) }).say.length, 140);
  assert.equal(Q.qdStep({ text: ['x', 50], s: 'oi' }), null, 'coordenada não numérica');
  assert.equal(Q.qdStep({ text: [NaN, 50], s: 'oi' }), null);
  assert.deepEqual(Q.qdStep({ cross: [10, 10] }), { cross: [10, 10, 16], color: 'ink' });
  assert.equal(Q.qdStep({ path: 'M0 0 L10 10' }), null, 'a IA não manda caminho SVG');
  assert.equal(Q.qdStep({ ask: 'oi' }), null, 'pergunta da pessoa só no arquivo salvo');
  assert.deepEqual(Q.qdStep({ ask: 'oi' }, { allowAsk: true }), { ask: 'oi' });
  assert.equal(Q.qdStep('texto'), null); assert.equal(Q.qdStep(null), null); assert.equal(Q.qdStep([1, 2]), null);
  assert.equal(Q.qdStep({ mark: [10, 10, 100, 20], color: 'red' }).color, undefined, 'marca-texto tem cor própria');
  for (const c of Q.QD_COLORS) assert.equal(Q.qdStep({ dot: [1, 1], color: c }).color, c);
  assert.equal(Q.qdStep({ text: [1, 50], s: 'linha\u0000com\ncontrole' }).s, 'linha com controle');
});

test('resposta inteira: ≤ 120 passos, título e mudanças curtos; JSON em bloco ```json ou solto', () => {
  const many = { steps: Array.from({ length: 300 }, (_, i) => ({ dot: [i % 1000, 10] })) };
  assert.equal(Q.qdSanitize(many).steps.length, Q.QD_MAX_STEPS);
  const r = Q.qdSanitize({ title: 'x'.repeat(200), steps: [{ say: 'a' }, { lixo: 1 }, 7, { dot: [1, 1] }], changes: ['um', '', { text: 'dois' }, 3] });
  assert.equal(r.title.length, 80); assert.equal(r.steps.length, 2); assert.deepEqual(r.changes, ['um', 'dois', '3']);
  assert.deepEqual(Q.qdSanitize([{ dot: [1, 1] }]).steps.length, 1, 'só a lista também vale');
  assert.deepEqual(Q.qdSanitize(null), { title: '', steps: [], changes: [] });
  const txt = 'Aqui está:\n```json\n' + JSON.stringify(TRILHO) + '\n```\nfim';
  const p = Q.qdParse(txt);
  assert.equal(p.title, TRILHO.title); assert.equal(p.steps.length, TRILHO.steps.length); assert.deepEqual(p.changes, TRILHO.changes);
  assert.equal(Q.qdParse('blá ' + JSON.stringify(TRILHO) + ' blá').steps.length, TRILHO.steps.length, 'sem cerca');
  assert.throws(() => Q.qdParse('não sei desenhar'), /JSON combinado/);
  assert.throws(() => Q.qdParse('{"steps":[{"say":"só falo"}]}'), /nenhum traço/);
});

test('traço à mão: determinístico por passo (rever = mesmo traço), dentro do quadro, cada primitiva vira o que deve', () => {
  const a = Q.qdShapes(Q.qdStep({ box: [100, 100, 300, 120], label: 'guardar o cupom', color: 'green' }), 3);
  const b = Q.qdShapes(Q.qdStep({ box: [100, 100, 300, 120], label: 'guardar o cupom', color: 'green' }), 3);
  assert.deepEqual(a, b, 'semente fixa');
  assert.notDeepEqual(Q.qdShapes(Q.qdStep({ box: [100, 100, 300, 120] }), 4).strokes, Q.qdShapes(Q.qdStep({ box: [100, 100, 300, 120] }), 3).strokes, 'tremida varia por passo');
  assert.equal(a.strokes.length, 4, 'caixa = 4 traços'); assert.equal(a.texts.length, 1); assert.equal(a.strokes[0].color, 'green');
  for (const s of a.strokes) assert.match(s.d, /^M[\d.-]+ [\d.-]+ Q/);
  assert.equal(Q.qdShapes(Q.qdStep({ arrow: [10, 10, 200, 200] }), 0).strokes.length, 2, 'seta = linha + ponta');
  assert.equal(Q.qdShapes(Q.qdStep({ cross: [100, 100, 20] }), 0).strokes.length, 2);
  assert.equal(Q.qdShapes(Q.qdStep({ check: [100, 100, 20] }), 0).strokes.length, 1);
  assert.equal(Q.qdShapes(Q.qdStep({ file: [100, 100, 120, 150], label: 'pedido.json' }), 0).strokes.length, 2);
  assert.equal(Q.qdShapes(Q.qdStep({ circle: [300, 300, 50, 30] }), 0).strokes[0].d.split('L').length > 40, true, 'elipse tremida');
  assert.deepEqual(Q.qdShapes(Q.qdStep({ mark: [1, 2, 30, 40] }), 0).marks, [[1, 2, 30, 40]]);
  assert.equal(Q.qdShapes(Q.qdStep({ dot: [5, 6], color: 'red' }), 0).dots[0].color, 'red');
  assert.deepEqual(Q.qdShapes({ say: 'oi' }, 0).strokes, []);
  // rótulo longo encolhe pra caber na caixa
  const lbl = Q.qdShapes(Q.qdStep({ box: [0, 0, 120, 60], label: 'um rótulo bem comprido mesmo' }), 0).texts[0];
  assert.ok(lbl.size < 24 && lbl.size >= 14);
});

test('caneta: traços saneados, caixa delimitadora e os rótulos mais perto (primeiro os que a caixa toca)', () => {
  const mine = Q.qdMineClean([[[400, 280], [470, 320], ['x', 1], [460, 330]], 'lixo', [], [[2000, -5]]]);
  assert.deepEqual(mine, [[[400, 280], [470, 320], [460, 330]], [[1000, 0]]]);
  assert.equal(Q.qdMineClean(Array.from({ length: 300 }, () => [[1, 1]])).length, 200);
  assert.deepEqual(Q.qdBBox([[[10, 20], [30, 5]], [[50, 60]]]), { x: 10, y: 5, w: 40, h: 55 });
  assert.equal(Q.qdBBox([]), null);
  assert.equal(Q.qdMinePath([[1, 2], [3, 4]]), 'M1 2 L3 4');
  assert.match(Q.qdMinePath([[1, 2]]), /l0\.1 0$/, 'um toque vira um pontinho visível');
  const steps = Q.qdSanitize(TRILHO).steps;
  const labels = Q.qdLabels(steps);
  assert.ok(labels.some((l) => l.s === 'guardar o cupom no carrinho'), 'rótulo de caixa conta');
  assert.ok(labels.some((l) => l.s === 'pedido.json'), 'rótulo de arquivo conta');
  const info = Q.qdMineInfo([[[350, 350], [480, 390]]], steps);
  assert.equal(info.near[0], 'recalcula o total', 'o que está embaixo do traço vem primeiro');
  assert.equal(info.strokes, 1);
  assert.deepEqual(Q.qdNear(null, labels), []);
});

test('pedidos pra IA: contexto da tarefa, fundo pra revisar, pergunta com os traços e a cena (só acrescenta)', () => {
  const ctx = Q.qdTaskCtx({ title: 'Checkout: aviso de cupom vencido', status: 'review', branch: 'feat/cupom-vencido', objective: 'Avisar quando o cupom NATAL10 venceu.\n[PLANO DO ORQUESTRADOR] interno',
    requirements: ['aviso aparece', 'botão Aplicar legível'], proofs: [{ status: 'done', evidence: ['browser-1.png'] }, null],
    files: [{ path: 'src/checkout/cupom.ts', add: 40, del: 3 }], talk: [{ who: 'Você', text: 'e o cupom vencido?' }, { who: 'Bruno', text: 'Validei no servidor.' }] });
  assert.match(ctx, /DEMANDA: Checkout: aviso de cupom vencido \(status: review\) · branch feat\/cupom-vencido/);
  assert.ok(!ctx.includes('PLANO DO ORQUESTRADOR'), 'o plano interno não vai');
  assert.match(ctx, /- aviso aparece → provado \(browser-1\.png\)/); assert.match(ctx, /- botão Aplicar legível$/m);
  assert.match(ctx, /src\/checkout\/cupom\.ts \+40 −3/); assert.match(ctx, /Bruno: Validei no servidor\./);
  assert.equal(Q.qdTaskCtx(null), '');
  const p = Q.qdPromptDesenhar('como resolveu?', { ctx, bgPath: '/tmp/demo/loja-web/.cardume/quadros/q-1/assets/fundo.png', project: 'loja-web' });
  assert.match(p, /^PEDIDO: como resolveu\?/); assert.match(p, /PRINT DE FUNDO .*fundo\.png — abra com Read/); assert.match(p, /changes/); assert.match(p, /```json/);
  assert.ok(!Q.qdPromptDesenhar('x').includes('PRINT DE FUNDO'), 'sem fundo, sem linha de fundo');
  const steps = Q.qdSanitize(TRILHO).steps;
  const q = Q.qdPromptPergunta('por que some aqui?', Q.qdMineInfo([[[350, 350], [480, 390]]], steps), steps, {});
  assert.match(q, /PERGUNTA DA PESSOA: por que some aqui\?/); assert.match(q, /TRAÇOS DA PESSOA \(roxo, 1 traço\): caixa x 350, y 350/); assert.match(q, /perto de: "recalcula o total"/);
  assert.match(q, /passos NOVOS \(eles são acrescentados\)/); assert.match(q, /CENA ATUAL/);
  assert.match(Q.qdPromptPergunta('e isso?', Q.qdMineInfo([], steps), steps), /não riscou nada/);
  assert.ok(Q.qdSceneText(Array.from({ length: 2000 }, () => ({ say: 'uma fala comprida o bastante pra encher' })), 3000).length <= 3000, 'cena com teto');
});

test('chat: "desenha"/"explica desenhando" oferece o quadro; texto comum não', () => {
  for (const s of ['desenha pra mim como fica o fluxo', 'Explica desenhando o checkout', 'faz um diagrama do cupom', 'me explica com um desenho', 'rabisca a ideia']) assert.ok(Q.qdWantsDraw(s), s);
  for (const s of ['corrige o botão Aplicar', 'qual o status?', 'o quadro do time tá lento', '']) assert.ok(!Q.qdWantsDraw(s), s);
});

test('arquivo salvo: doc são (perguntas no meio, fundo só em assets/, id), velocidade e tempos', () => {
  const d = Q.qdDoc({ id: 'q-abc', title: 'Cupom', taskId: 't1', steps: [{ say: 'oi' }, { ask: 'e aqui?' }, { dot: [1, 1] }, { path: 'x' }], mine: [[[1, 1]]], bg: '../../etc/passwd', history: [{ q: 'e aqui?', at: 5, from: 1, to: 3 }, 'lixo'] }, 'q-abc');
  assert.equal(d.steps.length, 3); assert.equal(d.steps[1].ask, 'e aqui?'); assert.equal(d.bg, null, 'fundo fora de assets/ não vale');
  assert.equal(d.taskId, 't1'); assert.equal(d.history.length, 1); assert.deepEqual(d.mine, [[[1, 1]]]);
  assert.equal(Q.qdDoc({ bg: 'assets/fundo-1.png' }, 'q-1').bg, 'assets/fundo-1.png');
  assert.equal(Q.qdDoc(null, 'q-1').id, 'q-1');
  assert.ok(Q.qdIdOk(Q.qdNewId(1761700000000, 'ab3z'))); assert.ok(!Q.qdIdOk('../x')); assert.ok(!Q.qdIdOk('q-'));
  assert.equal(Q.qdSpeedNext(1), 2); assert.equal(Q.qdSpeedNext(2), 0.5); assert.equal(Q.qdSpeedNext(0.5), 1);
  assert.equal(Q.qdSpeedLabel(0.5), '½×'); assert.equal(Q.qdSpeedLabel(2), '2×');
  assert.equal(Q.qdSayMs('abcd'), 572);
  const ap = Q.qdApplyText({ title: 'Revisão do checkout', changes: ['Escurecer o botão Aplicar', 'Avisar cupom vencido'] });
  assert.match(ap, /Quadro “Revisão do checkout”/); assert.match(ap, /1\. Escurecer o botão Aplicar\n2\. Avisar cupom vencido/);
  assert.match(Q.qdApplyText({}), /verde por cima do print/);
});

test('ligações: aba do canvas, menu "+", ⋯ da tarefa, bolha do chat, tokens dos dois temas, sem fonte de fora', () => {
  const cv = read('js/58-canvas.js'), cfg = read('js/15-config-abas-onboarding.js'), ws = read('js/20-workspace-tarefa.js'), anx = read('js/30-anexos.js'), html = read('index.html'), base = read('css/10-base.css');
  assert.match(cv, /k:'quadro', label:'Quadro · a IA desenha'/); assert.match(cv, /tab\.kind==='quadro' && typeof qdRender==='function'/);
  assert.match(cfg, /quadro:'cvSplit'/); assert.match(cfg, /quadro:\{title:'Quadro'/);
  assert.match(ws, /k:'quadro', label:'desenhar · a IA explica num quadro'/); assert.match(ws, /qdBubbleHtml\(evUserText\(tx\), t\.id\)/);
  assert.match(anx, /qdBubbleHtml\(t, m\.taskId\|\|null\)/);
  assert.ok(html.indexOf('js/86-pr-real.js') < html.indexOf('js/87-quadro.js') && html.indexOf('js/87-quadro.js') < html.indexOf('js/99-e2e.js'));
  assert.match(html, /css\/99-quadro\.css/);
  for (const t of ['--qd-paper', '--qd-ink', '--qd-red', '--qd-green', '--qd-blue', '--qd-mute', '--qd-mark', '--qd-pen', '--qd-cap', '--qd-on-cap']) assert.equal(base.split(t + ':').length - 1, 2, t + ' nos dois temas');
  assert.ok(!/fonts\.googleapis|https?:\/\//.test(JS.replace(/QD_NS='http:\/\/www\.w3\.org\/2000\/svg'/, '')), 'nada de CDN no quadro');
  assert.match(JS, /await askYes\(/, 'aplicar pergunta antes (askYes, nunca confirm)'); assert.ok(!/window\.confirm|\bconfirm\(/.test(JS));
});
