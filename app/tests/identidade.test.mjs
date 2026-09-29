// Repaginada C (identidade leve): `node --test app/tests/identidade.test.mjs`
// O símbolo Starfork (estrela de 4 pontas que se bifurca) é UM SVG, definido só em IC.starfork (10-core.js) e reusado
// no logo, na aba Nova demanda, no avatar da IA e no loader da marca. E os tokens do verde disciplinado + a escala existem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const src = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const JS = readdirSync(new URL('../src/js/', import.meta.url)).filter((f) => f.endsWith('.js'));
const core = src('js/10-core.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const IC = new Function('const IC = {};\n' + cut(core, 'IC.starforkG =', '\n{ const lg') + '\nreturn IC;')();
// a geometria da estrela: se aparecer em outro arquivo, alguém copiou o símbolo em vez de reusar IC.starfork
const STAR_D = (IC.starfork.match(/class="sf-star"[^>]*\sd="([^"]+)"/) || [])[1];

test('IC.starfork: um SVG, viewBox 16 (legível a 16 px), estrela + tronco + ramo + 2 nós', () => {
  assert.ok(STAR_D, 'a estrela tem um path com d');
  assert.match(IC.starfork, /^<svg class="sf-mark" viewBox="0 0 16 16" aria-hidden="true"><g /);
  assert.equal((IC.starfork.match(/<path /g) || []).length, 3, 'estrela + tronco + ramo');
  assert.equal((IC.starfork.match(/<circle /g) || []).length, 2, 'as pontas dos 2 ramos da bifurcação');
  assert.equal((IC.starfork.match(/pathLength="1"/g) || []).length, 3, 'o loader desenha os 3 traços');
  assert.ok(IC.starfork.includes(IC.starforkG), 'starforkG é o miolo do mesmo SVG (pra aba)');
  assert.doesNotMatch(IC.starfork, /#[0-9a-f]{3,6}/i, 'só currentColor: a cor vem de quem usa');
});

test('o símbolo não é duplicado no código', () => {
  const where = JS.filter((f) => src('js/' + f).includes(STAR_D));
  assert.deepEqual(where, ['10-core.js']);
  const html = src('index.html');
  assert.ok(!html.includes(STAR_D), 'o index.html não repete o SVG');
  assert.ok(!/M5 14L9\.5 9/.test(html + JS.map((f) => src('js/' + f)).join('')), 'o logo antigo de constelação saiu');
  assert.match(html, /<span class="logo" aria-hidden="true"><\/span>/, 'o logo é preenchido pelo 10-core');
  assert.match(core, /querySelector\('\.brand \.logo'\)[^\n]*IC\.starfork/);
});

test('reusado nos pontos de marca: aba Nova demanda, avatar da IA e loader', () => {
  const abas = src('js/15-config-abas-onboarding.js');
  assert.match(abas, /const SF_TAB_IC=\(typeof IC!=='undefined'&&IC\.starforkG\)/);
  assert.match(abas, /nova:\{title:'Nova demanda',icon:SF_TAB_IC\}/);
  assert.match(abas, /planner:\{title:'Nova demanda',icon:SF_TAB_IC\}/);
  const planner = src('js/32-planner.js');
  assert.ok(!/class="plav">[✦◆]/.test(planner), 'o avatar não é mais um caractere');
  assert.ok((planner.match(/<span class="plav">\$\{IC\.starfork\}<\/span>/g) || []).length >= 2);
  for (const f of JS) assert.ok(!/class="plav">[✦◆]/.test(src('js/' + f)), f + ': avatar da IA usa o símbolo');
  assert.match(src('js/06-carregamento.js'), /function brandLoaderHtml[\s\S]{0,300}\+IC\.starfork/);
});

test('tokens: verde disciplinado + escala tipográfica', () => {
  const base = src('css/10-base.css');
  for (const t of ['--accent-soft', '--accent-line']) assert.match(base, new RegExp(t + ':color-mix\\(in srgb, var\\(--accent\\)'), t + ' derivado do --accent');
  for (const [t, v] of [['xs', '11px'], ['sm', '12.5px'], ['md', '14px'], ['lg', '18px'], ['xl', '28px']]) assert.match(base, new RegExp('--fs-' + t + ':' + v.replace('.', '\\.')));
  // telas de A e B: tamanho solto de fonte saiu, e seleção não usa o verde cheio
  const nd = src('css/87-nova-demanda.css'), ld = src('css/86-carregamento.css');
  assert.doesNotMatch(nd, /font(-size)?:[^;]*\d+(\.\d+)?px/, 'Nova demanda: fontes pela escala');
  assert.doesNotMatch(ld, /font(-size)?:[^;]*\d+(\.\d+)?px/, 'carregamento: fontes pela escala');
  assert.doesNotMatch(nd, /\.on\{[^}]*var\(--accent\)[;}]/, 'seleção é soft');
  const telas = src('css/20-abas-e-telas.css');
  for (const sel of ['.ndtype.on', '.ndm.on', '.ndm-primary']) {
    const rule = cut(telas, sel + '{', '}');
    assert.doesNotMatch(rule, /var\(--accent\)|rgba\(63,214,138/, sel + ' usa o soft');
  }
});
