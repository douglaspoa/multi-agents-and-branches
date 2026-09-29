// Testes do sistema único de carregamento (06-carregamento.js) sem browser: o bloco puro (@puro-inicio … @puro-fim)
// + o loadInto num elemento falso. Relógio falso (mock.timers) pra 150 ms / 1,5 s / 4 s.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/06-carregamento.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/css/86-carregamento.css', import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const pure = cut(src, '// @puro-inicio', '// @puro-fim');
const dom = cut(src, '// pinta seguindo', '// janela oculta');
let fixed = 0;
const humanErr = (e, ctx) => /JWT/.test(String((e && e.message) || e))
  ? { msg: 'Sua sessão expirou — entre de novo.', raw: String((e && e.message) || e), action: { label: 'entrar de novo', fn: () => { fixed++; } } }
  : { msg: (ctx ? ctx + ' — ' : '') + 'Sem conexão agora — cheque a internet/VPN e tente de novo.', raw: String((e && e.message) || e), action: null };
const toasts = []; const showErr = (e, ctx) => toasts.push([ctx, String((e && e.message) || e)]);
// DOM falso mínimo pro tabBusy: document.getElementById(overlay) → overlay com .modal (a caixa da aba)
function fakeNode(cls) { const n = { className: cls || '', children: [], attrs: {}, textContent: '', innerHTML: '', parent: null,
  classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
  setAttribute(k, v) { this.attrs[k] = v; }, remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
  prepend(c) { c.parent = this; this.children.unshift(c); },
  querySelector(sel) { if (sel === ':scope>.modal') return this.children.find((c) => c.className === 'modal') || null;
    if (sel === ':scope>.ld-bar') return this.children.find((c) => /ld-bar/.test(c.className)) || null;
    if (sel === ':scope>.ld-pill') return this.children.find((c) => c.className === 'ld-pill') || null; return null; },
  querySelectorAll(sel) { return this.children.filter((c) => /ld-bar|ld-pill/.test(c.className)); } }; return n; }
const ov = fakeNode('overlay'); const box = fakeNode('modal'); ov.prepend(box);
const document = { getElementById: (id) => (id === 'skOverlay' ? ov : null), createElement: () => fakeNode() };
const VIEW_OVERLAY = { skills: 'skOverlay' };
const IC = { search: '<svg data-ic="search"></svg>', warn: '<svg data-ic="warn"></svg>', retry: '<svg data-ic="retry"></svg>', stack: '<svg data-ic="stack"></svg>' };
let reduced = false;
const matchMedia = (q) => ({ matches: reduced && /reduce/.test(q) });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); // igual ao do app: NÃO escapa aspas
const L = new Function('esc', 'humanErr', 'IC', 'matchMedia', 'document', 'VIEW_OVERLAY', 'showErr', 'perfLog',
  pure + dom + '\nreturn { LD_MS, ldRun, ldIsEmpty, skeletonHtml, brandLoaderHtml, emptyHtml, errorHtml, ldWireErr, ldSlowText, loadInto, ldPaint, tabBusy };')(esc, humanErr, IC, matchMedia, document, VIEW_OVERLAY, showErr, () => {});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const after = (ms, v, fail) => new Promise((res, rej) => setTimeout(() => (fail ? rej(v) : res(v)), ms));
function clock(t) { mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset()); }
function spy() { const log = []; const h = {}; for (const k of ['show', 'brand', 'slow', 'done', 'empty', 'fail', 'stale']) h[k] = (x) => log.push(k); return { h, log }; }

test('carga rápida (< 150 ms): nada de skeleton/barra — só os dados', async (t) => {
  clock(t);
  const { h, log } = spy();
  const p = L.ldRun(() => after(100, [1]), h);
  mock.timers.tick(100); await flush();
  assert.equal(await p, 'done');
  mock.timers.tick(5000); await flush();
  assert.deepEqual(log, ['done'], 'nenhum gancho de tempo depois do fim');
});

test('carga normal: aparece aos 150 ms (não antes); texto honesto só aos 4 s', async (t) => {
  clock(t);
  const { h, log } = spy();
  const p = L.ldRun(() => after(5000, [1]), h);
  mock.timers.tick(149); await flush();
  assert.deepEqual(log, []);
  mock.timers.tick(1); await flush();
  assert.deepEqual(log, ['show']);
  mock.timers.tick(3849); await flush();
  assert.deepEqual(log, ['show'], 'sem texto antes dos 4 s');
  mock.timers.tick(1); await flush();
  assert.deepEqual(log, ['show', 'slow']);
  mock.timers.tick(1000); await flush();
  assert.equal(await p, 'done');
  assert.deepEqual(log, ['show', 'slow', 'done']);
  assert.equal(L.ldSlowText('buscando issues'), 'ainda carregando: buscando issues…');
});

test('loader da marca só aos 1,5 s e só quando pedido (sem skeleton)', async (t) => {
  clock(t);
  const a = spy(), b = spy();
  L.ldRun(() => after(2000, 1), a.h, { brand: true });
  L.ldRun(() => after(2000, 1), b.h);
  mock.timers.tick(1499); await flush();
  assert.ok(!a.log.includes('brand'));
  mock.timers.tick(1); await flush();
  assert.ok(a.log.includes('brand'));
  mock.timers.tick(600); await flush();
  assert.ok(!b.log.includes('brand'), 'com skeleton a marca nunca entra');
});

test('geração: resposta atrasada de uma carga velha é descartada', async (t) => {
  clock(t);
  let gen = 0;
  const run = (ms, v) => { const g = ++gen; const s = spy(); const p = L.ldRun(() => after(ms, v), s.h, { alive: () => g === gen }); return { p, s }; };
  const velha = run(3000, 'velha');
  const nova = run(500, 'nova');
  mock.timers.tick(500); await flush();
  assert.equal(await nova.p, 'done');
  mock.timers.tick(2500); await flush();
  assert.equal(await velha.p, 'stale');
  assert.ok(!velha.s.log.includes('done') && velha.s.log.includes('stale'));
});

test('falha: vira o erro humano com "tentar de novo", que refaz a carga', async (t) => {
  clock(t);
  const { h, log } = spy();
  const p = L.ldRun(() => after(300, new Error('Failed to fetch'), true), h);
  mock.timers.tick(300); await flush();
  assert.equal(await p, 'fail');
  assert.deepEqual(log, ['show', 'fail']);
  const html = L.errorHtml(new Error('Failed to fetch'), 'trkRetry', 'Não consegui ler');
  assert.match(html, /Sem conexão agora/);
  assert.match(html, /tentar de novo/);
  assert.match(html, /id="trkRetry"/);
  assert.match(html, /data-ldretry/);
  // exceção no próprio fetch (síncrona) e no render também viram erro, nunca "carregando…" eterno
  const s2 = spy(); assert.equal(await L.ldRun(() => { throw new Error('x'); }, s2.h), 'fail');
  const s3 = spy(); s3.h.done = () => { throw new Error('render'); };
  assert.equal(await L.ldRun(() => 1, s3.h), 'fail');
  assert.ok(s3.log.includes('fail'));
});

test('loadInto: skeleton na hora, erro com retry que refaz, e dados no fim', async (t) => {
  clock(t);
  const el = { isConnected: true, _h: '', firstChild: null, btn: null,
    set innerHTML(v) { this._h = v; this.firstChild = v ? {} : null; this.btn = null; }, get innerHTML() { return this._h; },
    querySelector(sel) { if (sel === '[data-ldretry]' && this._h.includes('data-ldretry')) return (this.btn = this.btn || {}); if (sel.includes('ld-slow') && this._h.includes('ld-slow')) return (this.slow = this.slow || {}); return null; },
    closest: () => null };
  let calls = 0; const got = [];
  const p = L.loadInto(el, 'kanban', () => (++calls === 1 ? after(200, new Error('Failed to fetch'), true) : after(100, ['LOJ-1'])), (d) => got.push(d), { label: 'buscando issues' });
  assert.match(el.innerHTML, /ld-sk ld-sk-kanban/, 'a aba pinta o kanban-esqueleto na hora');
  mock.timers.tick(200); await flush();
  assert.equal(await p, 'fail');
  assert.match(el.innerHTML, /tentar de novo/);
  el.btn.onclick();                       // "tentar de novo"
  assert.match(el.innerHTML, /ld-sk-kanban/, 'o retry volta pro esqueleto');
  mock.timers.tick(100); await flush();
  assert.equal(calls, 2);
  assert.deepEqual(got, [['LOJ-1']]);
});

test('loadInto: aos 4 s o esqueleto ganha "ainda carregando: <o quê>"; aba trocada descarta', async (t) => {
  clock(t);
  const mk = () => ({ isConnected: true, _h: '', firstChild: null, slow: null,
    set innerHTML(v) { this._h = v; this.firstChild = v ? {} : null; this.slow = null; }, get innerHTML() { return this._h; },
    querySelector(sel) { if (sel.includes('ld-slow') && this._h.includes('ld-slow')) return (this.slow = this.slow || {}); return null; }, closest: () => null });
  const el = mk(); const got = [];
  L.loadInto(el, 'cards', () => after(6000, [1]), (d) => got.push(d), { label: 'buscando as skills' });
  mock.timers.tick(4000); await flush();
  assert.equal(el.slow.textContent, 'ainda carregando: buscando as skills…');
  el.isConnected = false;                 // saiu da tela antes da resposta
  mock.timers.tick(2000); await flush();
  assert.deepEqual(got, [], 'resposta tardia não pinta');
});

test('vazio: estado padrão com ícone SVG, uma frase, ajuda e UM botão', async (t) => {
  clock(t);
  const { h, log } = spy();
  assert.equal(await L.ldRun(() => [], h), 'empty');
  assert.deepEqual(log, ['empty']);
  assert.ok(L.ldIsEmpty([]) && L.ldIsEmpty(null) && !L.ldIsEmpty([0]) && !L.ldIsEmpty({}));
  const html = L.emptyHtml({ icon: 'search', title: 'Nenhuma issue no painel', help: 'Crie a primeira.', action: { id: 'x', label: '+ nova issue' } });
  assert.match(html, /<svg/);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<b>Nenhuma issue no painel<\/b>/);
  assert.match(html, /<p>Crie a primeira.<\/p>/);
});

test('formas do skeleton e loader da marca', () => {
  for (const k of ['cards', 'kanban', 'lista', 'chat', 'nota', 'tabela']) {
    const h = L.skeletonHtml(k, { label: 'x' });
    assert.match(h, new RegExp('ld-sk ld-sk-' + k), k);
    assert.match(h, /aria-busy="true"/);
    assert.match(h, /class="ld-slow"/);
  }
  assert.match(L.skeletonHtml('cards', { wrap: 'sk-screen', head: true }), /^<div class="sk-screen"><div class="ld-sk ld-sk-cards ld-hashead/);
  const b = L.brandLoaderHtml('colocando no ar', { now: true });
  assert.match(b, /ld-brand ld-now/);
  assert.equal((b.match(/<path /g) || []).length, 3, 'a estrela que se bifurca: 3 traços');
  assert.ok(!/canvas/i.test(b));
});

test('movimento reduzido: tudo estático (classe + @media)', () => {
  reduced = true;
  try {
    assert.match(L.skeletonHtml('kanban'), /ld-static/);
    assert.match(L.brandLoaderHtml('x'), /ld-static/);
  } finally { reduced = false; }
  assert.ok(!/ld-static/.test(L.skeletonHtml('kanban')));
  const m = css.match(/@media \(prefers-reduced-motion: reduce\)\{([\s\S]*?)\n\}/);
  assert.ok(m, 'bloco @media reduced-motion');
  for (const sel of ['.ld-b::after', '.ld-bar i', '.ld-brand path', '.ld-brand circle']) assert.ok(m[1].includes(sel + '{animation:none'), sel);
  assert.match(css, /\.ld-paused [^{]*\{animation-play-state:paused/, 'janela oculta pausa');
});

test('regras da Lia/Júlia: sem canvas/rAF no loader; keyframes só em transform/opacity/stroke-dashoffset; sem cosmos', () => {
  assert.ok(!/requestAnimationFrame|getContext|<canvas/.test(pure + dom));
  for (const [, body] of css.matchAll(/@keyframes [\w-]+\{([\s\S]*?\})\}/g)) {
    for (const [, prop] of body.matchAll(/([a-z-]+)\s*:/g)) assert.ok(['transform', 'opacity', 'stroke-dashoffset'].includes(prop), 'propriedade animada proibida: ' + prop);
  }
  const dir = new URL('../src/js/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) assert.ok(!/cosmos/.test(readFileSync(new URL(f, dir), 'utf8')), 'ainda usa cosmos: ' + f);
});

// ---------- revisão: prazo, keep, tabBusy, escape, ação do catálogo, guarda ----------
const mkEl = (html) => ({ isConnected: true, _h: html || '', firstChild: html ? {} : null, btn: null, fix: null,
  set innerHTML(v) { this._h = v; this.firstChild = v ? {} : null; this.btn = this.fix = null; }, get innerHTML() { return this._h; },
  querySelector(sel) { if (sel === '[data-ldretry]' && this._h.includes('data-ldretry')) return (this.btn = this.btn || {});
    if (sel === '[data-ldfix]' && this._h.includes('data-ldfix')) return (this.fix = this.fix || {});
    if (sel === '.ld-sk,.ld-err,.ld-hold') return /ld-sk|ld-err|ld-hold/.test(this._h) ? {} : null;
    if (sel.includes('ld-slow') && this._h.includes('ld-slow')) return (this.slow = this.slow || {}); return null; },
  closest: () => null });

test('prazo: promise que nunca termina vira erro "demorou demais" com retry; resposta tardia da carga atual ainda pinta', async (t) => {
  clock(t);
  const { h, log } = spy(); let err = null; h.fail = (e) => { err = e; log.push('fail'); };
  const p = L.ldRun(() => new Promise(() => {}), h);
  mock.timers.tick(29999); await flush();
  assert.ok(!log.includes('fail'));
  mock.timers.tick(1); await flush();
  assert.equal(await p, 'fail');
  assert.match(err.message, /Demorou demais/);
  assert.match(L.errorHtml(err), /Demorou demais pra responder/, 'mensagem direta, sem "Algo deu errado"');
  const el = mkEl(); const got = [];
  const r = L.loadInto(el, 'cards', () => after(31000, ['ok']), (d) => got.push(d), { label: 'x' });
  mock.timers.tick(30000); await flush();
  assert.equal(await r, 'fail');
  assert.match(el.innerHTML, /tentar de novo/);
  mock.timers.tick(1000); await flush();
  assert.deepEqual(got, [['ok']], 'chegou depois do prazo e ainda é a carga atual: pinta');
  const s2 = spy(); const p2 = L.ldRun(() => after(60000, 1), s2.h, { timeout: 0 });
  mock.timers.tick(60000); await flush(); assert.equal(await p2, 'done', 'timeout 0 = sem prazo');
});

test('keep: recarregar que falha mantém o conteúdo na tela e avisa por toast; erro anterior conta como não-conteúdo', async (t) => {
  clock(t);
  toasts.length = 0;
  const el = mkEl('<div class="memlist">notas</div>');
  const r = L.loadInto(el, 'nota', () => after(200, new Error('Failed to fetch'), true), () => {}, { keep: true, ctx: 'Não consegui ler a memória' });
  assert.equal(el.innerHTML, '<div class="memlist">notas</div>', 'sem skeleton por cima do que você lê');
  mock.timers.tick(200); await flush();
  assert.equal(await r, 'fail');
  assert.equal(el.innerHTML, '<div class="memlist">notas</div>');
  assert.deepEqual(toasts, [['Não consegui ler a memória', 'Failed to fetch']]);
  const e2 = mkEl(L.errorHtml(new Error('x')));
  L.loadInto(e2, 'nota', () => after(9000, 1), () => {}, { keep: true });
  assert.match(e2.innerHTML, /ld-sk-nota/, 'erro na tela não é conteúdo: volta o esqueleto');
  mock.timers.tick(9000); await flush();
});

test('tabBusy: barra só depois de 150 ms, na caixa da aba; duas cargas seguram até a última; pílula aos 4 s; some no reject', async (t) => {
  clock(t);
  const bar = () => box.children.find((c) => /ld-bar/.test(c.className));
  const pill = () => box.children.find((c) => c.className === 'ld-pill');
  let r1, j2; const p1 = new Promise((r) => { r1 = r; }); const p2 = new Promise((_, j) => { j2 = j; });
  L.tabBusy('skills', p1, { label: 'buscando as skills' });
  mock.timers.tick(149); await flush();
  assert.equal(bar(), undefined, 'nada antes de 150 ms');
  mock.timers.tick(1); await flush();
  assert.ok(bar(), 'barra aos 150 ms');
  assert.ok(!ov.children.some((c) => /ld-bar/.test(c.className)), 'não vai no overlay (fundo escurecido)');
  p2.catch(() => {}); L.tabBusy('skills', p2, { label: 'buscando as skills' });
  mock.timers.tick(3850); await flush();
  assert.equal(pill().textContent, 'ainda carregando: buscando as skills…');
  r1(); await flush();
  assert.ok(bar(), 'a 2ª carga ainda corre: a barra fica');
  j2(new Error('x')); await flush();
  assert.equal(bar(), undefined, 'rejeitou: limpa');
  assert.equal(pill(), undefined);
  mock.timers.tick(5000); await flush();
  assert.equal(box.children.length, 0, 'nada reaparece depois');
});

test('errorHtml: aspas do erro cru não viram atributo; a ação do catálogo vira 2º botão e é ligada', () => {
  const h = L.errorHtml(new Error('x" onmouseover="alert(1)'), 'r"x');
  assert.ok(!/title="[^"]*" onmouseover=/.test(h), h);
  assert.match(h, /&quot; onmouseover=&quot;/);
  assert.match(h, /id="r&quot;x"/);
  const e = new Error('JWT expired');
  const html = L.errorHtml(e, null, 'Falha');
  assert.match(html, /data-ldfix>entrar de novo</);
  assert.equal((html.match(/<button/g) || []).length, 2);
  const el = mkEl(html); let retried = 0;
  L.ldWireErr(el, e, 'Falha', () => { retried++; });
  fixed = 0; el.fix.onclick(); el.btn.onclick();
  assert.equal(fixed, 1); assert.equal(retried, 1);
  assert.match(L.errorHtml('Sem conexão com o painel', null, null, { human: true }), /<b>Sem conexão com o painel<\/b>/, 'human: não traduz de novo');
  assert.ok(!/Algo deu errado|Sem conexão agora/.test(L.errorHtml('Sem conexão com o painel', null, null, { human: true })));
});

test('ldPaint: mesma HTML não repinta; quem escreveu innerHTML por fora é detectado', () => {
  const el = mkEl();
  assert.equal(L.ldPaint(el, '<b>a</b>'), true);
  assert.equal(L.ldPaint(el, '<b>a</b>'), false, 'nada mudou');
  el.innerHTML = '<i>outro render</i>';   // render sem a guarda
  assert.equal(L.ldPaint(el, '<b>a</b>'), true, 'firstChild mudou: repinta');
  assert.equal(el.innerHTML, '<b>a</b>');
});

test('skeleton inline: aparece já, sem região viva; o normal tem UMA região (role=status, sem aria-live aninhado)', () => {
  const i = L.skeletonHtml('lista', { inline: true, compact: true, label: 'x' });
  assert.match(i, /ld-inl/); assert.ok(!/role=|aria-live/.test(i)); assert.match(i, /aria-hidden="true"/);
  const n = L.skeletonHtml('cards', { label: 'x' });
  assert.equal((n.match(/role="status"|aria-live/g) || []).length, 1);
  assert.ok(!/aria-live/.test(L.brandLoaderHtml('x')));
  assert.match(css, /\.ld-sk\.ld-inl\{opacity:1;animation:none\}/);
});
