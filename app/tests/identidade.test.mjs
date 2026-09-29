// Repaginada C (identidade leve): `node --test app/tests/identidade.test.mjs`
// O símbolo Starfork (estrela de 4 pontas que se bifurca) é UM SVG, definido só em IC.starfork (10-core.js) e reusado
// no logo, na aba Nova demanda, no avatar da IA e no loader da marca. E os tokens do verde disciplinado + a escala existem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadStarfork } from './starfork-src.mjs';

const src = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const JS = readdirSync(new URL('../src/js/', import.meta.url)).filter((f) => f.endsWith('.js'));
const core = src('js/10-core.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const IC = loadStarfork();
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

test('o símbolo não é duplicado: só 10-core.js; index.html e icon.svg são cópias conferidas', () => {
  const where = JS.filter((f) => src('js/' + f).includes(STAR_D));
  assert.deepEqual(where, ['10-core.js']);
  const html = src('index.html');
  assert.ok(!/M5 14L9\.5 9/.test(html + JS.map((f) => src('js/' + f)).join('')), 'o logo antigo de constelação saiu');
  // fallback estático do logo (sem JS): tem que ser IGUAL ao IC.starfork; o 10-core troca pela fonte no boot
  assert.ok(html.includes('<span class="logo" aria-hidden="true">' + IC.starfork + '</span>'), 'fallback do logo = IC.starfork');
  assert.equal(html.split(STAR_D).length - 1, 1, 'uma cópia só no index.html');
  assert.match(core, /querySelector\('\.brand \.logo'\)[^\n]*IC\.starfork/);
  // ícone do app: mesma geometria (todos os d e círculos) e o verde do --accent
  const icon = readFileSync(new URL('../src-tauri/icons/icon.svg', import.meta.url), 'utf8');
  for (const d of IC.starfork.match(/\sd="[^"]+"/g)) assert.ok(icon.includes(d.trim()), 'icon.svg: ' + d);
  for (const c of IC.starfork.match(/cx="[^"]+" cy="[^"]+" r="[^"]+"/g)) assert.ok(icon.includes(c), 'icon.svg: ' + c);
  const accent = (src('css/10-base.css').match(/--accent:(#[0-9a-f]{6})/i) || [])[1];
  assert.ok(accent && icon.includes(accent), 'icon.svg usa o --accent ' + accent);
});

test('reusado nos pontos de marca: aba Nova demanda, avatar da IA e loader', () => {
  const abas = src('js/15-config-abas-onboarding.js');
  assert.match(abas, /const SF_TAB_IC=\(typeof IC!=='undefined'&&IC\.starforkG\)/);
  assert.match(abas, /nova:\{title:'Nova demanda',icon:SF_TAB_IC\}/);
  assert.match(abas, /planner:\{title:'Nova demanda',icon:SF_TAB_IC\}/);
  const planner = src('js/32-planner.js');
  assert.ok(!/class="plav">[✦◆]/.test(planner), 'o avatar não é mais um caractere');
  assert.ok((planner.match(/<span class="plav">\$\{IC\.starfork\}<\/span>/g) || []).length >= 2);
  for (const f of JS) {
    const t = src('js/' + f);
    assert.ok(!t.includes('✦'), f + ': ✦ era a marca em glifo — use IC.starfork/IC.starforkEm');
    // ◆ continua sendo o selo de ÉPICO/revisão (STATUS_META, quadro); nos pontos de marca, não
    assert.ok(!/class="(plav|plheadic|pphead)">\s*◆/.test(t), f + ': ◆ como marca');
  }
  assert.match(planner, /<div class="pphead">\$\{IC\.starforkEm\} Épico proposto/);
  assert.match(src('js/14-issues-projeto.js'), /<span class="plheadic">\$\{IC\.starforkEm\}<\/span>/);
  assert.match(src('js/06-carregamento.js'), /function brandLoaderHtml[\s\S]{0,300}\(typeof IC!=='undefined'&&IC\.starfork\)/);
});

test('tokens: verde disciplinado + escala tipográfica', () => {
  const base = src('css/10-base.css');
  for (const t of ['--accent-soft', '--accent-line']) assert.match(base, new RegExp(t + ':color-mix\\(in srgb, var\\(--accent\\)'), t + ' derivado do --accent');
  for (const [t, v] of [['xs', '11px'], ['sm', '12.5px'], ['md', '14px'], ['lg', '18px'], ['xl', '28px']]) assert.match(base, new RegExp('--fs-' + t + ':' + v.replace('.', '\\.')));
  assert.match(src('css/20-abas-e-telas.css'), /\.ndmt\{font:600 var\(--fs-lg\)/, '--fs-lg em uso');
  assert.match(src('css/87-nova-demanda.css'), /\.ndpop-h\{font:600 var\(--fs-md\)/);
  assert.match(src('css/87-nova-demanda.css'), /\.ndpop-opt b\{font:600 var\(--fs-sm\)/, 'opção menor que o título do popover');
  // telas de A e B: tamanho solto de fonte saiu, e seleção não usa o verde cheio
  const nd = src('css/87-nova-demanda.css'), ld = src('css/86-carregamento.css');
  assert.doesNotMatch(nd, /font(-size)?:[^;]*\d+(\.\d+)?px/, 'Nova demanda: fontes pela escala');
  assert.doesNotMatch(ld, /font(-size)?:[^;]*\d+(\.\d+)?px/, 'carregamento: fontes pela escala');
  // seleção (.on/.set, inclusive em descendente: ".x.on .y", ".a .b.on") das peças da Nova demanda: nunca o verde cheio
  const PIECES = /\.(plchip|aicard|aimodel|plart|ppchip|ndpop-opt|ndchip|ndtype|ndm|ndex|tab)\b/;
  for (const f of ['20-abas-e-telas.css', '50-workspace-planner.css', '60-grafo-times-nova-demanda.css', '87-nova-demanda.css']) {
    for (const m of src('css/' + f).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].trim(), body = m[2];
      if (!/\.(on|set)\b/.test(sel) || !PIECES.test(sel) || / svg\b/.test(sel) && !/\.tab/.test(sel)) continue;
      assert.doesNotMatch(body, /(background|border-color|color|border)\s*:\s*var\(--accent\)|rgba\(63,214,138/, f + ' ' + sel + ' usa o soft');
    }
  }
});
