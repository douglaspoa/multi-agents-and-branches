// Redesenho F2 (temas) + F3 (movimento): `node --test app/tests/tema-movimento.test.mjs`
// - nenhum css/*.css tem cor literal fora dos blocos de token do 10-base (claro e escuro);
// - JS só tem cor literal onde ela é DADO/identidade (paleta de agentes, marcas de fornecedor, documento exportado);
// - a escolha de tema (Sistema/Claro/Escuro) e as decisões puras do movimento (reduzir movimento, direção, FLIP, "acabou de provar").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const CSS = readdirSync(new URL('../src/css/', import.meta.url)).filter((f) => f.endsWith('.css')).sort();
const JS = readdirSync(new URL('../src/js/', import.meta.url)).filter((f) => f.endsWith('.js')).sort();
const LIT = /#[0-9a-fA-F]{3,8}\b|%23[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/; // %23 = # dentro de data: URI
const base = rd('css/10-base.css');
const LIGHT = base.match(/:root\{ \/\* tema: claro[^\n]*\n[\s\S]*?\n\}/)[0];
const DARK = base.match(/:root\[data-theme="dark"\]\{[^\n]*\n[\s\S]*?\n\}/)[0];

// declarações (propriedade: valor) de um CSS, sem comentários — seletor com #id nunca conta como cor
function decls(src) {
  const out = []; src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out.push([m[1].trim().split('\n').pop(), d.slice(0, i).trim(), d.slice(i + 1).trim()]); }
  return out;
}

test('CSS sem cor literal: só os blocos de token (claro e escuro) do 10-base definem cor', () => {
  for (const f of CSS) {
    let s = rd('css/' + f);
    if (f === '10-base.css') { assert.ok(s.includes(LIGHT) && s.includes(DARK)); s = s.replace(LIGHT, '').replace(DARK, ''); }
    const bad = decls(s).filter(([, , v]) => LIT.test(v)).map(([sel, p, v]) => `${sel} { ${p}: ${v} }`);
    assert.deepEqual(bad, [], f + ': troque a cor por um token de css/10-base.css');
  }
});

test('os dois temas definem o MESMO conjunto de tokens (nada cai no valor do outro tema)', () => {
  const names = (blk) => [...blk.matchAll(/(--[\w-]+):/g)].map((m) => m[1]).sort();
  const fixed = ['--logo', '--on-color', '--on-color-dark', '--media-bg', '--web-bg', '--yt-red', '--device-1', '--device-2', '--device-edge', '--device-ink']; // iguais nos dois (marca, mídia, aparelho)
  assert.deepEqual(names(DARK), names(LIGHT).filter((n) => !fixed.includes(n)));
  // escuro: o verde do logo é o acento único de estado vivo; claro: o carimbo roxo do protótipo
  assert.match(DARK, /--live:#3FD68A;/); assert.match(LIGHT, /--live:#5A3AA5;/); assert.match(LIGHT, /--ground:#E8EFEA;/);
  assert.match(LIGHT, /--logo:#3FD68A;/);
  for (const t of ['--term-bg', '--term-fg', '--ansi-red', '--chart-1', '--shade', '--stamp', '--tone-focus', '--tone-ok', '--tone-warn', '--tone-crit', '--tone-info', '--tone-ask', '--term-ask']) assert.ok(LIGHT.includes(t + ':') && DARK.includes(t + ':'), t);
});

test('JS: cor literal só dentro de blocos // @cor-dado-inicio … @cor-dado-fim, e só nos arquivos permitidos', () => {
  // dado/identidade, nunca tema: Daily exportado, marca dos fornecedores de IA, logo do Google, fallbacks do termTheme e a
  // cor GRAVADA no agente (o <input type=color> exige hex). Todo o resto usa var(--token).
  const ALLOW = ['12-chat-prefs-daily.js', '29-ia-picker.js', '44-onboarding.js', '60-terminal.js', '33-switcher-projetos.js', '61-meu-time.js'];
  const COR = /['"`(:,=](#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3}))(?![\w-])|\brgba?\(\s*\d|\bhsla?\(\s*\d|\bhsla?\(\$\{/;
  for (const f of JS) {
    const src = rd('js/' + f);
    const blocks = (src.match(/@cor-dado-inicio/g) || []).length;
    if (blocks) assert.ok(ALLOW.includes(f), f + ': bloco @cor-dado fora da lista permitida');
    assert.equal(blocks, (src.match(/@cor-dado-fim/g) || []).length, f + ': bloco @cor-dado sem fim');
    const s = src.replace(/@cor-dado-inicio[\s\S]*?@cor-dado-fim/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/&#\w+;/g, '').replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
    const m = s.match(COR);
    assert.equal(m && m[0], null, f + ': cor literal no JS — use var(--token) (ou, se for dado, um bloco @cor-dado)');
  }
});

test('tema sem piscar: o <head> grava html[data-theme] ANTES do CSS; fontes locais (sem host externo)', () => {
  const html = rd('index.html');
  const boot = html.indexOf("localStorage.getItem('theme')"), css = html.indexOf('css/10-base.css');
  assert.ok(boot > 0 && boot < css, 'script do tema antes do 1º CSS');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html + JS.map((f) => rd('js/' + f)).join('')), 'nenhuma fonte de host externo');
  assert.ok(html.indexOf('js/04-tema.js') < html.indexOf('js/10-core.js') && html.indexOf('js/05-movimento.js') < html.indexOf('js/10-core.js'));
  for (const m of base.matchAll(/url\('\.\.\/vendor\/fonts\/([^']+)'\)/g)) assert.ok(existsSync(new URL('../src/vendor/fonts/' + m[1], import.meta.url)), m[1]);
  assert.match(base, /font-family:'Public Sans'/); assert.match(base, /font-family:'Martian Mono'/);
  assert.match(readFileSync(new URL('../src/vendor/fonts/OFL.txt', import.meta.url), 'utf8'), /SIL Open Font License/);
});

const temaSrc = rd('js/04-tema.js');
const TEMA = new Function(cut(temaSrc, '// @tema-puro-inicio', '// @tema-puro-fim') + '\nreturn { temaResolve, temaPrefNorm };')();
test('preferência de tema: Sistema segue o SO; Claro/Escuro fixam; valor estranho = Sistema', () => {
  assert.equal(TEMA.temaResolve('system', true), 'dark');
  assert.equal(TEMA.temaResolve('system', false), 'light');
  assert.equal(TEMA.temaResolve('light', true), 'light');
  assert.equal(TEMA.temaResolve('dark', false), 'dark');
  assert.equal(TEMA.temaResolve(null, true), 'dark', 'sem preferência salva = Sistema');
  assert.equal(TEMA.temaPrefNorm('azul'), 'system');
  // o SO trocando de modo: listener (sem polling); quem pinta fora do CSS ouve 'sf-theme'
  assert.match(temaSrc, /TEMA_MQ\.addEventListener\('change'/);
  assert.match(temaSrc, /CustomEvent\('sf-theme'/);
  assert.doesNotMatch(temaSrc, /setInterval/);
  assert.match(rd('js/15-config-abas-onboarding.js'), /temaCfgMount\(\$id\('temaHost'\)\)/, 'Configurações → Aparência');
});

test('xterm: tema vem dos tokens do terminal e todo terminal aberto repinta ao trocar o tema', () => {
  const t = rd('js/60-terminal.js');
  const th = cut(t, 'function termTheme(){', 'function termRetheme');
  for (const k of ['--term-bg', '--term-fg', '--term-live', '--term-sel', '--ansi-red', '--ansi-bwhite']) assert.ok(th.includes("'" + k + "'"), k);
  assert.match(t, /addEventListener\('sf-theme', termRetheme\)/);
  assert.match(t, /x\.term\.options\.theme=th/);
});

const mvSrc = rd('js/05-movimento.js');
const MV = new Function(cut(mvSrc, '// @movimento-puro-inicio', '// @movimento-puro-fim') + '\nreturn { mvShouldAnimate, slideDir, mvFlipDelta, mvNewlyTrue, mvTicked };')();
test('movimento: reduzir movimento, boot e janela escondida → não anima', () => {
  const ok = { can: true, reduced: false, boot: false, hidden: false };
  assert.equal(MV.mvShouldAnimate(ok), true);
  assert.equal(MV.mvShouldAnimate({ ...ok, reduced: true }), false, 'prefers-reduced-motion = corte instantâneo');
  assert.equal(MV.mvShouldAnimate({ ...ok, boot: true }), false, 'nada anima no boot');
  assert.equal(MV.mvShouldAnimate({ ...ok, hidden: true }), false);
  assert.equal(MV.mvShouldAnimate({ ...ok, can: false }), false, 'sem Web Animations: só muda');
  assert.equal(MV.mvShouldAnimate(null), false);
});

test('movimento: direção do deslize, FLIP e "acabou de ser provado"', () => {
  assert.equal(MV.slideDir(0, 2), 1, 'modo à direita vem da direita');
  assert.equal(MV.slideDir(3, 1), -1);
  assert.equal(MV.slideDir(2, 2), 0);
  assert.equal(MV.slideDir(-1, 2), 0, 'modo desconhecido: sem deslize');
  assert.deepEqual(MV.mvFlipDelta({ left: 10, top: 40 }, { left: 10, top: 0 }), { dx: 0, dy: 40 });
  assert.equal(MV.mvFlipDelta({ left: 10, top: 0.4 }, { left: 10.3, top: 0 }), null, 'menos de 1 px: fica');
  assert.deepEqual(MV.mvNewlyTrue(null, { 0: true }), [], '1ª pintura não carimba');
  assert.deepEqual(MV.mvNewlyTrue({ 0: true, 1: false, 2: false }, { 0: true, 1: true, 2: false, 3: true }), ['1'], 'só quem PASSOU de não provado a provado (o novo já provado não)');
  assert.deepEqual(MV.mvNewlyTrue({ 0: false }, { 0: false }), [], 'poll igual: nada');
  assert.equal(MV.mvTicked(2, 3), true); assert.equal(MV.mvTicked(3, 3), false); assert.equal(MV.mvTicked(null, 3), false);
});

test('movimento aplicado nos pontos do protótipo, sem laço', () => {
  assert.doesNotMatch(mvSrc, /setInterval|requestAnimationFrame\(/, 'nenhum laço de animação');
  const hooks = [['js/15-config-abas-onboarding.js', /mvTabsPainted\(bar\)/], ['js/20-workspace-tarefa.js', /mvGlide\(m\)/], ['js/20-workspace-tarefa.js', /mvSlideIn\(\$id\('fwCols'\), slideDir\(/],
    ['js/60-terminal-layout.js', /stampLand\(li\.querySelector\('\.tlstamp'\)\)/], ['js/60-ciclo.js', /cicMotion\(t, host\)/], ['js/64-terminal-integrado.js', /springIn\(box\.querySelectorAll\('\.tichip'\)\)/],
    ['js/64-terminal-integrado.js', /mvFromOrigin\(el\.querySelector\('\.tisheetbox'\), opener\)/], ['js/66-central-tabela.js', /flip\(tb, reorder/], ['js/66-central-tabela.js', /mvExpand\(/],
    ['js/58-canvas.js', /translateX\(40px\)/], ['js/00-util.js', /mvToast\(el\)/]];
  for (const [f, re] of hooks) assert.match(rd(f), re, f);
  const mcss = rd('css/15-movimento.css');
  assert.match(mcss, /html\.sf-hidden \*[^{]*\{animation-play-state:paused!important\}/, 'janela escondida pausa o infinito');
  assert.match(base, /@media \(prefers-reduced-motion: reduce\)\{\s*\*,\*::before,\*::after\{animation-duration:\.001ms!important/);
});

// toast: um toast novo durante o fade de saída entra de novo (e o fade velho não esconde); o mouse em cima cancela o fade
test('toast: fade de saída cancelado por toast novo ou pelo mouse; o "esconder" atrasado não vale', async () => {
  const util = rd('js/00-util.js');
  const src = cut(util, 'function toast(', 'window.toast=toast');
  const calls = []; let timers = [];
  const anims = [];
  const mk = (tag) => ({ tag, children: [], style: {}, className: '', textContent: '', appendChild(c) { this.children.push(c); }, getAnimations: () => anims.filter((a) => !a.done) });
  const el = mk('div'); el.id = 'appToast';
  const ctx = {
    $id: (id) => (id === 'appToast' ? el : null), document: { createElement: mk, body: { appendChild() {} } },
    a11yAnnounce() {}, toastUrgent: () => false, console,
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
    mvToast: (e, out) => { let res; const p = new Promise((r) => { res = r; }); const a = { out, done: false, cancel() { this.done = true; res(); }, finish() { this.done = true; res(); } }; anims.push(a); calls.push(out ? 'out' : 'in'); return p.then(() => {}); },
  };
  const T = new Function(...Object.keys(ctx), src + '\nreturn toast;')(...Object.values(ctx));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  T('primeiro'); assert.deepEqual(calls, ['in'], 'aparece subindo');
  timers.at(-1)(); assert.deepEqual(calls, ['in', 'out'], 'some descendo');
  const fade = anims.at(-1);
  T('segundo'); assert.ok(fade.done, 'o fade velho foi cancelado'); assert.deepEqual(calls, ['in', 'out', 'in'], 'o novo entra de novo');
  await flush(); assert.equal(el.style.display, 'block', 'o fim do fade velho não esconde o novo');
  timers.at(-1)(); const fade2 = anims.at(-1); el.onmouseenter(); assert.ok(fade2.done, 'mouse em cima cancela o fade');
  await flush(); assert.equal(el.style.display, 'block');
  el.onmouseleave(); timers.at(-1)(); anims.at(-1).finish(); // agora o fade termina sozinho
  await flush(); assert.equal(el.style.display, 'none', 'fade que terminou sozinho esconde');
  assert.match(util, /function mvToastStop\(el\)\{ el\._hiding=false; try\{ if\(el\.getAnimations\) el\.getAnimations\(\)\.forEach\(a=>a\.cancel\(\)\)/);
});

test('memCss: o canvas da memória resolve o token UMA vez por tema (hex→rgba com alfa; cor que não é var passa direto)', () => {
  const mem = rd('js/37-memoria.js');
  let calls = 0; const vals = { '--ok': '#2A7049', '--muted': '#55647A' };
  const getComputedStyle = () => ({ getPropertyValue: (n) => { calls++; return vals[n] || ''; } });
  const M = new Function('getComputedStyle', 'document', cut(mem, '// @mem-cor-puro-inicio', '// @mem-cor-puro-fim') + '\nreturn { memCss, reset:()=>{ MEM_PAL={}; } };')(getComputedStyle, { documentElement: {} });
  assert.equal(M.memCss('var(--ok)'), '#2A7049');
  assert.equal(M.memCss('var(--ok)', 0.5), 'rgba(42,112,73,0.5)');
  assert.equal(M.memCss('var(--ok)', 0.7), 'rgba(42,112,73,0.7)');
  assert.equal(calls, 1, 'cache: um getComputedStyle por token por tema');
  assert.equal(M.memCss('#123456'), '#123456', 'não-var passa');
  assert.equal(M.memCss('var(--nada)'), 'gray', 'token ausente → cinza');
  M.reset(); vals['--ok'] = '#7FDCA7'; assert.equal(M.memCss('var(--ok)'), '#7FDCA7', 'trocou o tema: relê');
  assert.match(mem, /addEventListener\('sf-theme', \(\)=>\{ MEM_PAL=\{\}; if\(typeof memG!=='undefined' && memG\) memPaint\(\); \}\)/);
});

test('script de tema do <head> (sem piscar) dá o mesmo que temaResolve — inclusive sem localStorage', () => {
  const html = rd('index.html');
  const m = html.match(/<script>(\/\* tema ANTES da 1ª pintura[\s\S]*?)<\/script>/); assert.ok(m, 'script do tema no <head>');
  const run = (stored, sysDark, lsThrows) => {
    const documentElement = { dataset: {} };
    const localStorage = { getItem: (k) => { if (lsThrows) throw new Error('bloqueado'); return k === 'theme' ? stored : null; } };
    const matchMedia = (q) => ({ matches: /dark/.test(q) && sysDark });
    new Function('document', 'localStorage', 'window', 'matchMedia', m[1])({ documentElement }, localStorage, { matchMedia }, matchMedia);
    return documentElement.dataset.theme;
  };
  for (const [stored, dark] of [['system', true], ['system', false], ['light', true], ['dark', false], [null, true]]) assert.equal(run(stored, dark, false), TEMA.temaResolve(stored, dark), `${stored} / SO ${dark ? 'escuro' : 'claro'}`);
  assert.equal(run(null, true, true), 'dark', 'localStorage bloqueado: ainda segue o sistema');
  assert.equal(run(null, false, true), 'light');
});

test('temaSet: grava, põe data-theme ANTES de UM sf-theme; sem mudança, nenhum evento; xterm: todos os terminais repintam', () => {
  const ls = {}; const events = []; const root = { dataset: { theme: 'light' } };
  const mq = { matches: false, addEventListener() {} };
  const win = { addEventListener() {}, dispatchEvent: (e) => { events.push([e.type, root.dataset.theme]); }, __TAURI__: null };
  class CustomEvent { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
  const T = new Function('lsGet', 'lsSet', 'matchMedia', 'window', 'document', 'CustomEvent', temaSrc + '\nreturn { temaSet, temaApply };')(
    (k) => ls[k] ?? null, (k, v) => { ls[k] = v; }, () => mq, win, { documentElement: root }, CustomEvent);
  events.length = 0; // o temaApply do carregamento (já 'light'): nada
  T.temaSet('dark'); assert.deepEqual(events, [['sf-theme', 'dark']], 'um evento, com o atributo já trocado'); assert.equal(ls.theme, 'dark');
  T.temaSet('dark'); assert.equal(events.length, 1, 'mesmo tema: nenhum evento');
  T.temaSet('system'); assert.deepEqual(events.at(-1), ['sf-theme', 'light'], 'Sistema com o SO claro');
  // xterm
  const term = rd('js/60-terminal.js');
  const fn = cut(term, '// @cor-dado-inicio — fallbacks do termTheme', '// a Martian Mono local');
  const TERM = { a: { term: { options: {} } }, b: { term: null }, c: { term: { options: {} } } };
  const R = new Function('TERM', 'termCss', 'window', fn + '\nreturn termRetheme;')(TERM, (n, fb) => n === '--term-bg' ? '#0F1E3D' : fb, { addEventListener() {} });
  R(); assert.equal(TERM.a.term.options.theme.background, '#0F1E3D'); assert.equal(TERM.c.term.options.theme.background, '#0F1E3D'); assert.equal(TERM.b.term, null, 'entrada sem xterm: ignorada');
});
