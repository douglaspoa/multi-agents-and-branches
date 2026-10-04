// R8 acessibilidade: blocos puros do 54-acessibilidade.js, a lista única de janelas (00-util.js) e a de atalhos
// (15-config-abas-onboarding.js); o ciclo abrir/fechar/Tab das janelas num DOM falso mínimo; e guardas de CSS:
// contraste AA, anel de foco ≥ 3:1 (inclusive em botão verde), UM estilo de :focus-visible que vence na cascata,
// forced-colors, reduzir movimento sem congelar indicador de progresso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const a11ySrc = rd('../src/js/54-acessibilidade.js');
const tabsSrc = rd('../src/js/15-config-abas-onboarding.js');
const coreSrc = rd('../src/js/10-core.js');
const utilSrc = rd('../src/js/00-util.js');
const A = new Function(cut(a11ySrc, '// @puro-a11y-inicio', '// @puro-a11y-fim') + '\nreturn { A11Y_NAMES, a11yWrapIndex, a11yIsHelpKey, a11yPickInitial };')();
const S = new Function(cut(tabsSrc, '// @puro-atalhos-inicio', '// @puro-atalhos-fim') + '\nreturn { SHORTCUTS, SHORTCUT_WORDS, shortcutsFlat, shortcutsHelpText };')();
const DIALOGS = new Function(cut(utilSrc, '// @puro-dialogos-inicio', '// @puro-dialogos-fim') + '\nreturn A11Y_DIALOGS;')();
const T = new Function(cut(utilSrc, '// @puro-toast-inicio', '// @puro-toast-fim') + '\nreturn { toastUrgent };')();

test('Tab preso na janela: dá a volta nas pontas e entra pela ponta certa', () => {
  assert.equal(A.a11yWrapIndex(3, 2, false), 0);
  assert.equal(A.a11yWrapIndex(3, 0, true), 2);
  assert.equal(A.a11yWrapIndex(3, 1, false), 2);
  assert.equal(A.a11yWrapIndex(3, -1, false), 0);
  assert.equal(A.a11yWrapIndex(3, -1, true), 2);
  assert.equal(A.a11yWrapIndex(0, 0, false), -1);
});

test('? abre o painel só fora de campo de texto; ⌘/ e Ctrl+/ abrem de qualquer lugar', () => {
  assert.equal(A.a11yIsHelpKey({ key: '?' }, false), true);
  assert.equal(A.a11yIsHelpKey({ key: '?' }, true), false);
  assert.equal(A.a11yIsHelpKey({ key: '/', metaKey: true }, true), true);
  assert.equal(A.a11yIsHelpKey({ key: '/', ctrlKey: true }, false), true);
  assert.equal(A.a11yIsHelpKey({ key: '?', metaKey: true }, false), false);
  assert.equal(A.a11yIsHelpKey({ key: '/' }, false), false);
  assert.equal(A.a11yIsHelpKey(null, false), false);
});

test('foco inicial vai na ação MENOS destrutiva', () => {
  const b = (text, cls = 'btn', id = '') => ({ tag: 'BUTTON', text, cls, id });
  assert.equal(A.a11yPickInitial([b('×', 'x', 'txClose'), { tag: 'INPUT', text: '' }, b('ok', 'btn primary')]), 1); // campo primeiro
  assert.equal(A.a11yPickInitial([b('×', 'x'), b('excluir', 'btn danger'), b('cancelar')]), 2);
  assert.equal(A.a11yPickInitial([b('abrir Ambiente'), b('copiar'), b('fechar', 'btn primary')]), 2); // detalhes do erro
  assert.equal(A.a11yPickInitial([b('×', 'x'), b('apagar tudo'), b('publicar', 'btn primary')]), 0); // só perigosas → o X
  assert.equal(A.a11yPickInitial([b('Publicar', 'btn primary'), b('x', 'btn', 'pubCancel')]), 1);
  assert.equal(A.a11yPickInitial([]), -1);
});

test('UMA lista de janelas: o escBusy usa a A11Y_DIALOGS (e os nomes fixos são de janelas dela)', () => {
  assert.match(cut(utilSrc, 'function escBusy', '\n}'), /return A11Y_DIALOGS\s*\.some\(/);
  for (const id of ['errOverlay', 'txOverlay', 'lbOverlay', 'kbdOverlay', 'prepOverlay', 'bdOverlay', 'payOverlay']) assert.ok(DIALOGS.includes(id), id);
  for (const id of Object.keys(A.A11Y_NAMES)) assert.ok(DIALOGS.includes(id), 'nome sem janela: ' + id);
  assert.ok(!/const A11Y_DIALOGS/.test(a11ySrc), '54-acessibilidade.js não pode ter lista própria');
});

test('toast: erro e aviso (barrado) vão pra região alert; o resto pra status — regiões fixas, sem trocar role', () => {
  assert.equal(T.toastUrgent('err'), true);
  assert.equal(T.toastUrgent('warn'), true);
  assert.equal(T.toastUrgent('ok'), false);
  assert.equal(T.toastUrgent(undefined), false);
  assert.ok(!/el\.setAttribute\('role'/.test(cut(utilSrc, 'function toast(', 'window.toast=toast')), 'o toast não troca mais o role do nó');
  assert.match(utilSrc, /'a11yLiveStatus','status'/); assert.match(utilSrc, /'a11yLiveAlert','alert'/);
});

test('atalhos: tudo que o código trata está no painel; "ou" é texto; o tooltip do + mostra o SHORTCUTS_HELP', () => {
  const flat = S.shortcutsFlat(S.SHORTCUTS);
  for (const [k] of flat) assert.ok(Array.isArray(k) && k.length, 'teclas em lista');
  const keys = flat.map(([k]) => k.join(' ')).join(' | ');
  const handled = new Set();
  for (const m of cut(tabsSrc, 'const SHORTCUTS_HELP', '\nfunction eventsOf').matchAll(/k===['"](.)['"]/g)) handled.add(m[1]);
  for (const m of coreSrc.matchAll(/if\(k===["'](.)["']\)|else if\(k===["'](.)["']\)/g)) handled.add(m[1] || m[2]);
  handled.add('k');
  assert.ok(handled.size >= 6, 'não achei os handlers: ' + [...handled]);
  for (const k of handled) assert.ok(keys.includes('⌘' + k.toUpperCase()) || keys.includes('⌘' + k), 'atalho ⌘' + k + ' sem documentação');
  for (const k of ['⌘1…⌘9', 'Ctrl+Tab', 'Delete', 'Esc', '⌘Enter', '⇧Enter', '?', '⌘/']) assert.ok(keys.includes(k), k + ' sem documentação');
  // o painel desenha "ou" como texto, não como tecla
  const kbdKeysHtml = new Function('SHORTCUT_WORDS', 'esc', cut(a11ySrc, 'function kbdKeysHtml', '\nfunction kbdPanelHtml') + '\nreturn kbdKeysHtml;')(S.SHORTCUT_WORDS, (s) => String(s));
  const help = flat.find(([, d]) => /estes atalhos/.test(d))[0];
  assert.equal(kbdKeysHtml(help), '<kbd>?</kbd> <span class="kbdor">ou</span> <kbd>⌘/</kbd>');
  const txt = S.shortcutsHelpText(S.SHORTCUTS);
  assert.match(txt, /^Atalhos: ⌘N nova demanda/);
  assert.ok(!/\s{2,}/.test(txt));
  const plus = cut(tabsSrc, 'id="tabAdd"', '</span>');
  assert.match(plus, /\$\{escA\(SHORTCUTS_HELP\)\}/, 'o tooltip do + mostra a lista');
  assert.match(plus, /aria-keyshortcuts="Meta\+N Control\+N"/);
});

// ---------- DOM falso mínimo: o ciclo abrir → foco dentro → Tab preso → fechar → foco devolvido ----------
function makeDom() {
  const listeners = { doc: {}, win: {} }; const observers = []; let timers = [];
  class El {
    constructor(tag, o = {}) { Object.assign(this, { tagName: tag, id: o.id || '', className: o.cls || '', _text: o.text || '', focusable: !!o.focusable, heading: !!o.heading, visible: o.visible !== false, children: [], parentElement: null, style: { display: o.display || '' }, attrs: {} });
      this.classList = { contains: (c) => String(this.className).split(/\s+/).includes(c) }; }
    append(...cs) { for (const c of cs) { c.parentElement = this; this.children.push(c); } return this; }
    remove() { const p = this.parentElement; if (p) { p.children = p.children.filter((x) => x !== this); this.parentElement = null; } }
    get isConnected() { let n = this; while (n) { if (n === doc.body) return true; n = n.parentElement; } return false; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    get isContentEditable() { return false; }
    desc() { return this.children.flatMap((c) => [c, ...c.desc()]); }
    contains(n) { for (; n; n = n.parentElement) if (n === this) return true; return false; }
    querySelectorAll() { return this.desc().filter((d) => d.focusable); }
    querySelector() { return this.desc().find((d) => d.heading) || null; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } setAttribute(k, v) { this.attrs[k] = String(v); } removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
    set tabIndex(v) { this.attrs.tabindex = String(v); }
    getClientRects() { let n = this; while (n) { if (!n.visible || n.style.display === 'none') return []; n = n.parentElement; } return this.isConnected ? [1] : []; }
    focus() { doc.activeElement = this; (listeners.doc.focusin || []).forEach((f) => f({ target: this })); }
    closest() { return null; }
    matches(sel) { return sel === 'textarea[data-tab-indent]' && this.tagName === 'TEXTAREA' && 'data-tab-indent' in this.attrs; }
  }
  const doc = { body: new El('BODY'), activeElement: null,
    getElementById: (id) => doc.body.desc().find((d) => d.id === id) || null,
    querySelector: (sel) => (sel === '#tabBar .tab.on' ? doc.body.desc().find((d) => d.classList.contains('on') && d.classList.contains('tab')) || null : null),
    addEventListener: (t, f) => { (listeners.doc[t] ||= []).push(f); } };
  doc.activeElement = doc.body;
  const win = { addEventListener: (t, f) => { (listeners.win[t] ||= []).push(f); } };
  class MO { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } }
  const env = { El, doc, win,
    flush(recs = []) { for (const o of [...observers]) if (!o.off) o.cb(recs); },
    run() { const t = timers.filter((x) => x.ms < 1000); timers = timers.filter((x) => x.ms >= 1000); t.forEach((x) => x.fn()); },
    key(k, o = {}) { const ev = Object.assign({ key: k, target: doc.activeElement, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} }, o);
      for (const f of listeners.win.keydown || []) f(ev); for (const f of listeners.doc.keydown || []) f(ev); return ev; } };
  env.load = (dialogs, viewOverlay = {}) => new Function('document', 'window', 'getComputedStyle', 'MutationObserver', 'setTimeout', 'A11Y_DIALOGS', 'VIEW_OVERLAY', 'VIEW_META', '$id', 'bindClick', 'esc', 'IC',
    a11ySrc + '\nreturn { a11yLabel, a11yTop, a11yStack };')(doc, win, (el) => ({ display: el.style.display === 'none' ? 'none' : 'block', visibility: 'visible' }), MO,
    (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return 0; }, dialogs, viewOverlay, { skills: { title: 'Skills' } }, doc.getElementById, () => {}, (s) => String(s), {});
  return env;
}
function scene() {
  const d = makeDom(); const { El, doc } = d;
  const tab = new El('SPAN', { cls: 'tab on', focusable: true, text: 'Central' });
  const opener = new El('BUTTON', { id: 'opener', focusable: true, text: 'renomear' });
  const tx = new El('DIV', { id: 'txOverlay', display: 'none' }).append(
    new El('B', { id: 'txTitle', heading: true, text: 'Nome' }),
    new El('BUTTON', { id: 'txClose', cls: 'x', focusable: true, text: '×' }),
    new El('INPUT', { id: 'txInput', focusable: true }),
    new El('BUTTON', { id: 'txCancel', cls: 'btn', focusable: true, text: 'cancelar' }),
    new El('BUTTON', { id: 'txOk', cls: 'btn primary', focusable: true, text: 'ok' }));
  const sk = new El('DIV', { id: 'skOverlay', cls: 'overlay astab', display: 'none' }).append(new El('BUTTON', { focusable: true, text: 'ligar' }));
  doc.body.append(tab, opener, tx, sk);
  const api = d.load(['txOverlay', 'errOverlay'], { skills: 'skOverlay' });
  return { d, doc, El, tab, opener, tx, sk, api };
}

test('janela: role/nome, foco entra no campo, Tab dá a volta, ao fechar o foco volta pra quem abriu', () => {
  const { d, doc, tab, opener, tx } = scene();
  assert.equal(tx.getAttribute('role'), 'dialog'); assert.equal(tx.getAttribute('aria-modal'), 'true'); assert.equal(tx.getAttribute('aria-labelledby'), 'txTitle');
  opener.focus(); tx.style.display = 'flex'; d.flush();
  assert.equal(doc.activeElement.id, 'txInput');
  doc.getElementById('txOk').focus(); let ev = d.key('Tab'); assert.ok(ev.prevented); assert.equal(doc.activeElement.id, 'txClose'); // último → primeiro
  ev = d.key('Tab', { shiftKey: true }); assert.equal(doc.activeElement.id, 'txOk'); // primeiro → último
  tab.focus(); d.key('Tab'); assert.equal(doc.activeElement.id, 'txClose'); // foco fugiu da janela → volta pra dentro
  tx.style.display = 'none'; d.flush(); doc.activeElement = doc.body; d.run();
  assert.equal(doc.activeElement, opener);
});

test('quem abriu é lembrado mesmo quando a tela já joga o foco dentro da janela na hora (focusin)', () => {
  const { d, doc, opener, tx } = scene();
  opener.focus(); tx.style.display = 'flex'; doc.getElementById('txOk').focus(); // como o errDetails: ok.focus() antes do observer
  d.flush(); tx.style.display = 'none'; d.flush(); d.run();
  assert.equal(doc.activeElement, opener);
});

test('quem abriu sumiu → foco vai pra aba ativa; editor com Tab de indentar não é preso', () => {
  const { d, doc, El, tab, opener, tx } = scene();
  opener.focus(); tx.style.display = 'flex'; d.flush();
  const ed = new El('TEXTAREA', { focusable: true }); ed.setAttribute('data-tab-indent', ''); tx.append(ed); ed.focus();
  const ev = d.key('Tab'); assert.equal(ev.prevented, false); assert.equal(doc.activeElement, ed);
  opener.remove(); tx.style.display = 'none'; d.flush(); d.run();
  assert.equal(doc.activeElement, tab);
});

test('aba-overlay: region com o nome da aba, não prende Tab e ao sumir NÃO volta pro abridor antigo', () => {
  const { d, doc, tab, opener, sk } = scene();
  assert.equal(sk.getAttribute('role'), 'region'); assert.equal(sk.getAttribute('aria-label'), 'Skills');
  opener.focus(); sk.style.display = 'block'; d.flush();
  assert.equal(doc.activeElement, opener, 'aba não rouba o foco');
  assert.equal(d.key('Tab').prevented, false);
  doc.activeElement = doc.body; sk.style.display = 'none'; d.flush(); d.run();
  assert.equal(doc.activeElement, tab);
});

test('janela preenchida depois (invoke): o foco espera o conteúdo e cai no cancelar, não no excluir', () => {
  const d = makeDom(); const { El, doc } = d;
  const op = new El('BUTTON', { focusable: true, text: 'abrir' }); const ov = new El('DIV', { id: 'errOverlay', display: 'none' });
  doc.body.append(op, ov); d.load(['errOverlay']);
  op.focus(); ov.style.display = 'flex'; d.flush();
  assert.equal(doc.activeElement, ov, 'sem conteúdo ainda: foco na caixa');
  ov.append(new El('BUTTON', { cls: 'btn danger', focusable: true, text: 'excluir' }), new El('BUTTON', { cls: 'btn', focusable: true, text: 'cancelar' }));
  d.flush(); assert.equal(doc.activeElement.textContent, 'cancelar');
});

test('aria-labelledby apontando pra id que sumiu é refeito', () => {
  const { tx, api, doc } = scene();
  tx.setAttribute('aria-labelledby', 'sumiu'); doc.getElementById('txTitle').id = '';
  api.a11yLabel(tx);
  assert.equal(tx.getAttribute('aria-labelledby'), 'txOverlay-titulo');
});

// ---------- CSS ----------
const cssDir = new URL('../src/css/', import.meta.url);
const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith('.css')).sort();
const css = Object.fromEntries(cssFiles.map((f) => [f, readFileSync(new URL(f, cssDir), 'utf8')]));
const base = css['10-base.css'];
const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (fg, a, bg) => fg.map((v, i) => v * a + bg[i] * (1 - a));
const tok = (name) => { const m = base.match(new RegExp('--' + name + ':\\s*([^;]+);')); assert.ok(m, 'token --' + name); return m[1].trim(); };
// redesenho F2: DOIS temas — os tokens primitivos moram no bloco do claro (:root{ /* tema: claro …) e no do escuro
// (:root[data-theme="dark"]); os nomes do app (--muted, --bg…) apontam pra eles. Contraste conferido nos dois.
const themeBlock = (re) => { const m = base.match(re); assert.ok(m, 'bloco de tema ' + re); return m[1]; };
const THEMES = { claro: themeBlock(/:root\{ \/\* tema: claro[^\n]*\n([\s\S]*?)\n\}/), escuro: themeBlock(/:root\[data-theme="dark"\]\{[^\n]*\n([\s\S]*?)\n\}/) };
const tv = (blk, name) => { const m = blk.match(new RegExp('--' + name + ':\\s*([^;]+);')); assert.ok(m, 'token --' + name); return m[1].trim(); };
const tokHex = (blk, name) => { const v = tv(blk, name); const r = v.match(/^var\(--([\w-]+)\)$/); return hex(r ? tv(blk, r[1]) : v); };
const SURF = ['ground', 'surf-1', 'surf-2', 'surf-3', 'card'];

test('contraste AA (4,5:1) do texto apagado (--muted/--text-3 = --ink-3) em todas as superfícies, nos dois temas', () => {
  assert.match(base, /--muted:var\(--ink-3\); --text-3:var\(--ink-3\);/);
  assert.match(base, /--text-dim:var\(--muted\)/);
  for (const [nome, blk] of Object.entries(THEMES)) {
    const muted = tokHex(blk, 'ink-3');
    for (const s of SURF) assert.ok(ratio(muted, tokHex(blk, s)) >= 4.5, `${nome}: --ink-3 sobre --${s}: ${ratio(muted, tokHex(blk, s)).toFixed(2)}`);
    // terminal (xterm e os do orquestrador) e lateral: a tinta apagada de cada um sobre o próprio fundo
    for (const t of ['term-fg', 'term-dim', 'term-faint']) assert.ok(ratio(tokHex(blk, t), tokHex(blk, 'term-bg')) >= 4.5, `${nome}: --${t} sobre --term-bg`);
    for (const s of ['side', 'side-2']) assert.ok(ratio(tokHex(blk, 'on-side-2'), tokHex(blk, s)) >= 4.5, `${nome}: --on-side-2 sobre --${s}`);
    for (const c of ['tone-ok', 'tone-warn', 'tone-crit', 'tone-info', 'tone-ask', 'live']) for (const s of SURF) assert.ok(ratio(tokHex(blk, c), tokHex(blk, s)) >= 4.5, `${nome}: --${c} como texto sobre --${s} (página e menu "Mais")`);
    // lateral: as cores de estado viram as claras (--side-*) e precisam ler sobre o marinho/verde-quase-preto
    for (const c of ['side-ok', 'side-warn', 'side-crit', 'side-info', 'side-ask', 'live-side', 'on-side']) for (const s of ['side', 'side-2']) assert.ok(ratio(tokHex(blk, c), tokHex(blk, s)) >= 4.5, `${nome}: --${c} sobre --${s}`);
    // terminal: toda cor ANSI (menos o preto) e o "perguntou" sobre o fundo do terminal
    for (const c of ['ansi-red', 'ansi-green', 'ansi-yellow', 'ansi-blue', 'ansi-magenta', 'ansi-cyan', 'ansi-white', 'ansi-bblack', 'ansi-bred', 'ansi-bgreen', 'ansi-byellow', 'ansi-bblue', 'ansi-bmagenta', 'ansi-bcyan', 'ansi-bwhite', 'term-ask', 'term-live'])
      assert.ok(ratio(tokHex(blk, c), tokHex(blk, 'term-bg')) >= 4.5, `${nome}: --${c} sobre --term-bg`);
    // texto sobre botão: primário e acento (inclusive o hover --live-2), e os chips do terminal
    assert.ok(ratio(tokHex(blk, 'tone-on-primary'), tokHex(blk, 'tone-primary')) >= 4.5, nome + ': --on-primary sobre --primary');
    for (const b of ['live', 'live-2']) assert.ok(ratio(tokHex(blk, 'on-live'), tokHex(blk, b)) >= 4.5, `${nome}: --on-live sobre --${b}`);
    for (const b of ['chip-bg', 'chip1-bg']) assert.ok(ratio(tokHex(blk, 'chip-ink'), tokHex(blk, b)) >= 4.5, `${nome}: --chip-ink sobre --${b}`);
  }
});

test('anel de foco ≥ 3:1 nos dois temas: vão na cor do fundo + anel --focus (o acento do tema)', () => {
  assert.match(base, /--ring:0 0 0 2px var\(--bg\), 0 0 0 4px var\(--focus\);/);
  assert.match(base, /--ring-inset:inset 0 0 0 2px var\(--focus\);/);
  for (const [nome, blk] of Object.entries(THEMES)) {
    const f = tv(blk, 'tone-focus'), live = tokHex(blk, 'live');
    const pct = /^var\(--live\)$/.test(f) ? 100 : +((f.match(/color-mix\(in srgb, var\(--live\) (\d+)%, transparent\)/) || [])[1]);
    assert.ok(pct > 0, nome + ': --focus = o acento (cheio ou em color-mix): ' + f);
    for (const s of SURF) { const bg = tokHex(blk, s), r = ratio(mix(live, pct / 100, bg), bg); assert.ok(r >= 3, `${nome}: anel sobre --${s}: ${r.toFixed(2)}`); }
    // o vão (--bg = --ground) separa o anel do botão primário (--primary) e do acento cheio
    for (const b of ['tone-primary', 'live']) assert.ok(ratio(tokHex(blk, 'ground'), tokHex(blk, b)) >= 3, `${nome}: vão contra --${b}`);
    // nos escopos: o anel da lateral é --live-side (vão --side-3) e o do terminal é --term-live (vão --term-bg)
    for (const s of ['side', 'side-2', 'side-3']) assert.ok(ratio(tokHex(blk, 'live-side'), tokHex(blk, s)) >= 3, `${nome}: foco da lateral sobre --${s}`);
    for (const s of ['term-bg', 'term-bg-2']) assert.ok(ratio(tokHex(blk, 'term-live'), tokHex(blk, s)) >= 3, `${nome}: foco do terminal sobre --${s}`);
  }
  // os escopos redeclaram o foco e o anel (var() resolve onde é declarado: herdar o --ring da raiz traria o foco da página)
  const scope = (sel) => { const i = base.indexOf(sel + '{'); assert.ok(i >= 0, sel); return base.slice(i, base.indexOf('\n}', i)); };
  for (const sel of ['.sidebar', '.fwtermslot,.tltermbar,.tireply,.orq-term,.orq-termbox,.orq-chat,.orq-branch,.vf-log']) {
    const b = scope(sel);
    for (const t of ['--focus:', '--ring:0 0 0 2px var(--bg), 0 0 0 4px var(--focus);', '--st-ask:var(--ask)', '--st-done:var(--info)', '--ok:', '--warn:', '--crit:', '--ask:']) assert.ok(b.includes(t), sel + ' redeclara ' + t);
  }
  assert.ok(scope('.fwtermslot,.tltermbar,.tireply,.orq-term,.orq-termbox,.orq-chat,.orq-branch,.vf-log').includes('--bg:var(--term-bg)'), 'vão do anel no terminal');
  // o menu "Mais" (dentro da lateral) volta pro escopo da página: mesmo bloco da raiz, com estado e primário
  const pg = scope(':root, .sidebar .moremenu');
  for (const t of ['--ok:var(--tone-ok)', '--warn:var(--tone-warn)', '--crit:var(--tone-crit)', '--info:var(--tone-info)', '--ask:var(--tone-ask)', '--primary:var(--tone-primary)', '--on-primary:var(--tone-on-primary)', '--focus:var(--tone-focus)', '--good:var(--tone-ok)', '--st-run:var(--accent)']) assert.ok(pg.includes(t), 'menu "Mais" repõe ' + t);
});

// cor clara translúcida em texto (CSS e estilos inline no JS): abaixo de 48% fica < 4,5:1
function lowAlphaWhites(src) {
  const out = [];
  for (const m of src.matchAll(/(?<![-\w])color:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*(0?\.\d+)\)/g)) if (+m[1] >= 200 && +m[2] >= 200 && +m[3] >= 200 && +m[4] < 0.48) out.push(m[0]);
  return out;
}
test('texto claro translúcido abaixo de 48% não volta (CSS e estilo inline do JS)', () => {
  for (const [f, s] of Object.entries(css)) assert.deepEqual(lowAlphaWhites(s), [], f);
  for (const f of readdirSync(new URL('../src/js/', import.meta.url)).filter((x) => x.endsWith('.js'))) assert.deepEqual(lowAlphaWhites(rd('../src/js/' + f)), [], f);
});

test('UM estilo de foco: todo :focus-visible usa --ring/--ring-inset e deixa contorno transparente (forced-colors)', () => {
  for (const [f, s] of Object.entries(css)) {
    for (const m of s.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)) {
      const sel = m[1].trim(), body = m[2];
      if (!sel.replace(/:not\([^)]*:focus-visible[^)]*\)/g, '').includes(':focus-visible')) continue; // só dentro de :not()
      assert.ok(/var\(--ring(-inset)?\)/.test(body), `${f}: "${sel.slice(0, 80)}" sem var(--ring)`);
      assert.ok(!/outline:\s*(none|0)\b/.test(body), `${f}: "${sel.slice(0, 80)}" com outline:none (some no alto contraste)`);
      assert.ok(!/outline:\s*2px solid var/.test(body), `${f}: "${sel.slice(0, 80)}" com contorno próprio`);
    }
    for (const m of s.matchAll(/([^{}]*)\{([^}]*var\(--ring[^}]*)\}/g)) assert.ok(!/outline:\s*(none|0)\b/.test(m[2]), `${f}: "${m[1].trim().slice(0, 60)}" anel com outline:none`);
  }
});

// especificidade simplificada (ids, classes/atributos/pseudo-classes, elementos) de UM seletor composto
function spec(sel) {
  let s = sel.replace(/:where\([^)]*\)/g, '').replace(/::?[a-z-]+\(/g, (x) => (x.startsWith('::') ? '' : ':x(')).replace(/::[a-z-]+/g, ' e');
  const ids = (s.match(/#[\w-]+/g) || []).length; const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!x\()[\w-]+/g) || []).length;
  const els = (s.replace(/"[^"]*"/g, '').match(/(^|[\s>+~(,])[a-z][\w-]*/g) || []).length;
  return ids * 10000 + cls * 100 + els;
}
test('o anel de foco vence na cascata: carrega por último e nenhum box-shadow de .btn/.iconbtn/button o supera', () => {
  const idx = rd('../src/index.html');
  const order = [...idx.matchAll(/href="css\/([\w-]+\.css)"/g)].map((m) => m[1]);
  const focusFile = '88-acessibilidade.css';
  const fm = css[focusFile].match(/(html :is\([^{]*\):focus-visible)\{([^}]*)\}/);
  assert.ok(fm && /box-shadow:var\(--ring\)/.test(fm[2]), 'regra global de foco em ' + focusFile);
  const focusSpec = 0 * 10000 + 2 * 100 + 1; // html + :is(classe) + :focus-visible = (0,2,1)
  const imp = /box-shadow:var\(--ring\)!important/.test(fm[2]); // com !important só outro !important o supera
  const fi = order.indexOf(focusFile); assert.ok(fi >= 0);
  for (const [f, s] of Object.entries(css)) {
    const clean = s.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of clean.matchAll(/([^{}@]*)\{([^{}]*box-shadow[^{}]*)\}/g)) {
      for (const one of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!/(\.btn|\.iconbtn|(^|[\s>])button)\b/.test(one) || /:focus/.test(one) || /:disabled|\[disabled\]/.test(one)) continue;
        if (imp && !/box-shadow:[^;]*!important/.test(m[2])) continue;
        const sp = spec(one), later = order.indexOf(f) > fi;
        assert.ok(sp < focusSpec || (sp === focusSpec && !later), `${f}: "${one}" (${sp}) vence o anel de foco (${focusSpec})`);
      }
    }
  }
});

test('reduzir movimento: global, mas indicador de progresso "respira" (opacidade) em vez de congelar', () => {
  const m = base.match(/@media \(prefers-reduced-motion: reduce\)\{([\s\S]*?)\n\}/);
  assert.ok(m, 'bloco global de prefers-reduced-motion em 10-base.css');
  assert.match(m[1], /\*,\*::before,\*::after\{[^}]*animation-iteration-count:1!important/);
  const br = m[1].match(/([^{}]+)\{animation:a11y-breathe [\d.]+s[^}]*infinite!important\}/); assert.ok(br, 'indicadores com animação lenta');
  for (const sel of ['.pubspin', '.pulse::after', '.ld-bar i', '.conn.live .d']) assert.ok(br[1].includes(sel), sel + ' não pode congelar');
  const kf = base.match(/@keyframes a11y-breathe\{([^}]*\})\}/); assert.ok(kf); assert.ok(!/transform|width|height/.test(kf[1]), 'só opacidade');
  // rolagem suave por JS passa por scrollOpts (que checa ldReduced)
  for (const f of readdirSync(new URL('../src/js/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    const s = rd('../src/js/' + f).replace(/function scrollOpts[^\n]*/, '');
    assert.ok(!/behavior\s*:\s*['"`]smooth['"`]/.test(s), f + ': rolagem suave sem scrollOpts()');
  }
});
