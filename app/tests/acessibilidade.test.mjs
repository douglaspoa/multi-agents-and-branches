// R8 acessibilidade: blocos puros do 54-acessibilidade.js e da lista de atalhos (15-config-abas-onboarding.js)
// + guardas de CSS: contraste AA dos textos "apagados", anel de foco ≥ 3:1, UM estilo de :focus-visible e
// "reduzir movimento" global. Sem browser: recorta os blocos entre os marcadores e roda com new Function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const a11ySrc = rd('../src/js/54-acessibilidade.js');
const tabsSrc = rd('../src/js/15-config-abas-onboarding.js');
const coreSrc = rd('../src/js/10-core.js');
const A = new Function(cut(a11ySrc, '// @puro-a11y-inicio', '// @puro-a11y-fim') + '\nreturn { A11Y_DIALOGS, A11Y_NAMES, a11yWrapIndex, a11yIsHelpKey };')();
const S = new Function(cut(tabsSrc, '// @puro-atalhos-inicio', '// @puro-atalhos-fim') + '\nreturn { SHORTCUTS, shortcutsFlat, shortcutsHelpText };')();

test('Tab preso na janela: dá a volta nas pontas e entra pela ponta certa', () => {
  assert.equal(A.a11yWrapIndex(3, 2, false), 0); // último + Tab → primeiro
  assert.equal(A.a11yWrapIndex(3, 0, true), 2); // primeiro + ⇧Tab → último
  assert.equal(A.a11yWrapIndex(3, 1, false), 2);
  assert.equal(A.a11yWrapIndex(3, -1, false), 0); // foco fora da janela → entra no primeiro
  assert.equal(A.a11yWrapIndex(3, -1, true), 2); // … ou no último com ⇧
  assert.equal(A.a11yWrapIndex(0, 0, false), -1); // janela sem nada focável
});

test('? abre o painel só fora de campo de texto; ⌘/ e Ctrl+/ abrem de qualquer lugar', () => {
  assert.equal(A.a11yIsHelpKey({ key: '?' }, false), true);
  assert.equal(A.a11yIsHelpKey({ key: '?' }, true), false); // digitando uma pergunta no chat
  assert.equal(A.a11yIsHelpKey({ key: '/', metaKey: true }, true), true);
  assert.equal(A.a11yIsHelpKey({ key: '/', ctrlKey: true }, false), true);
  assert.equal(A.a11yIsHelpKey({ key: '?', metaKey: true }, false), false);
  assert.equal(A.a11yIsHelpKey({ key: '/' }, false), false);
  assert.equal(A.a11yIsHelpKey(null, false), false);
});

test('janelas: as do escBusy estão todas na lista de diálogos (role=dialog + foco preso)', () => {
  const util = rd('../src/js/00-util.js');
  const esc = cut(util, 'function escBusy', '.some(').match(/'([a-zA-Z]+Overlay)'/g).map((x) => x.slice(1, -1));
  for (const id of esc) assert.ok(A.A11Y_DIALOGS.includes(id), id + ' fora de A11Y_DIALOGS');
  assert.ok(A.A11Y_DIALOGS.includes('kbdOverlay'));
  for (const id of Object.keys(A.A11Y_NAMES)) assert.ok(A.A11Y_DIALOGS.includes(id), 'nome sem janela: ' + id);
});

test('atalhos: todo atalho tratado no código está no painel (e o texto do tooltip sai da MESMA lista)', () => {
  const keys = S.shortcutsFlat(S.SHORTCUTS).map(([k]) => k).join(' | ');
  // teclas com ⌘ tratadas nos handlers globais
  const handled = new Set();
  for (const m of cut(tabsSrc, 'const SHORTCUTS_HELP', '\nfunction eventsOf').matchAll(/k===['"](.)['"]/g)) handled.add(m[1]);
  for (const m of coreSrc.matchAll(/if\(k===["'](.)["']\)|else if\(k===["'](.)["']\)/g)) handled.add(m[1] || m[2]);
  handled.add('k'); // ⌘K (10-core, e.key.toLowerCase()==='k')
  assert.ok(handled.size >= 6, 'não achei os handlers: ' + [...handled]);
  for (const k of handled) assert.ok(keys.includes('⌘' + k.toUpperCase()) || keys.includes('⌘' + k), 'atalho ⌘' + k + ' sem documentação');
  for (const k of ['⌘1…⌘9', 'Ctrl+Tab', 'Delete', 'Esc', '⌘Enter', '⇧Enter', '?']) assert.ok(keys.includes(k), k + ' sem documentação');
  const txt = S.shortcutsHelpText(S.SHORTCUTS);
  assert.match(txt, /^Atalhos: ⌘N nova demanda/);
  assert.ok(!/\s{2,}/.test(txt), 'espaços duplos no tooltip');
  assert.ok(txt.includes('arraste uma aba pra reordenar'));
});

// ---- CSS ----
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
const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'].map((n) => [n, hex(tok(n))]);

test('contraste AA (4,5:1) do texto apagado (--muted/--text-dim e --text-3) em todas as superfícies', () => {
  const muted = hex(tok('muted'));
  const t3 = tok('text-3').match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/); assert.ok(t3, '--text-3 em rgba');
  for (const [n, s] of surfaces) {
    assert.ok(ratio(muted, s) >= 4.5, `--muted sobre --${n}: ${ratio(muted, s).toFixed(2)}`);
    const c = mix([+t3[1], +t3[2], +t3[3]], +t3[4], s);
    assert.ok(ratio(c, s) >= 4.5, `--text-3 sobre --${n}: ${ratio(c, s).toFixed(2)}`);
  }
  assert.match(base, /--text-dim:var\(--muted\)/);
});

test('anel de foco (--ring) com ≥ 3:1 sobre as superfícies (WCAG 1.4.11)', () => {
  const m = tok('ring').match(/var\(--accent\)\s*(\d+)%/); assert.ok(m, '--ring com color-mix do --accent');
  const acc = hex(tok('accent'));
  for (const [n, s] of surfaces) { const r = ratio(mix(acc, +m[1] / 100, s), s); assert.ok(r >= 3, `--ring sobre --${n}: ${r.toFixed(2)}`); }
});

test('texto branco translúcido abaixo de 48% (menos de 4,5:1) não volta', () => {
  for (const [f, s] of Object.entries(css)) {
    for (const m of s.matchAll(/(?<![-\w])color:\s*rgba\(255,\s*255,\s*255,\s*(0?\.\d+)\)/g)) {
      assert.ok(+m[1] >= 0.48, `${f}: color com alfa ${m[1]} — use var(--text-3)`);
    }
  }
});

test('UM estilo de foco: todo :focus-visible usa o --ring (exceções: fundo de menu, ponto colorido do épico)', () => {
  const allow = [/#tmenuPop button:focus-visible/, /\.epqdot:focus-visible/, /:not\(:focus-visible\)/, /\[role=dialog\]:focus-visible/, /\.busln:focus-visible/];
  for (const [f, s] of Object.entries(css)) {
    for (const m of s.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)) {
      const sel = m[1].trim(), body = m[2];
      if (allow.some((r) => r.test(sel))) continue;
      assert.ok(/var\(--ring\)/.test(body), `${f}: "${sel.slice(0, 80)}" sem var(--ring)`);
      assert.ok(!/outline:\s*2px solid/.test(body), `${f}: "${sel.slice(0, 80)}" ainda com contorno próprio`);
    }
  }
});

test('reduzir movimento vale pro app inteiro', () => {
  const m = base.match(/@media \(prefers-reduced-motion: reduce\)\{\s*\*,\*::before,\*::after\{([^}]*)\}/);
  assert.ok(m, 'bloco global de prefers-reduced-motion em 10-base.css');
  assert.match(m[1], /animation-duration:[^;]*!important/);
  assert.match(m[1], /animation-iteration-count:1!important/);
  assert.match(m[1], /transition-duration:[^;]*!important/);
  // rolagem suave por JS também respeita (o CSS não alcança scrollIntoView({behavior:'smooth'}))
  for (const f of readdirSync(new URL('../src/js/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    const s = rd('../src/js/' + f);
    assert.ok(!/behavior:\s*'smooth'\s*}/.test(s), f + ': scrollIntoView smooth sem checar ldReduced()');
  }
});
