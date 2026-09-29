// Repaginada B (Nova demanda numa tela só): `node --test app/tests/nova-demanda.test.mjs`
// Carrega 00-util + 14-nova-demanda-inicio + 29-ia-picker + 32-planner num vm com um DOM de mentira
// e testa as partes puras: a prévia em linguagem de gente, tipo→modo, exemplos e a flag legada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const noop = () => {};
// elemento "engole tudo": qualquer propriedade vira função/objeto inofensivo (os arquivos ligam handlers no load)
const stubEl = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'dataset' ? {} : k === 'value' ? '' : k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : stubEl()),
  set: () => true,
  apply: () => stubEl(),
});
const store = {};
const ctx = {
  window: { addEventListener: noop },
  document: { getElementById: () => stubEl(), addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null, createElement: () => stubEl(), head: stubEl(), body: stubEl() },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  navigator: { platform: 'MacIntel', userAgent: '' },
  console,
  // dependências de outros arquivos do app que só são chamadas em handlers/render
  esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  chatComposer: noop, Option: function () {},
  loadDaily: noop, dailyAISummary: noop, dailyGenDoc: noop,
};
ctx.escA = (s) => ctx.esc(s).replace(/"/g, '&quot;');
vm.createContext(ctx);
vm.runInContext([read('00-util.js'), read('14-nova-demanda-inicio.js'), read('29-ia-picker.js'), read('32-planner.js')].join('\n;\n')
  + '\n;globalThis.__nd={ ND_TYPES, ND_TO_MODE, ND_NON_SOFTWARE, ndExamples, ndGuessType, ndLegacy, ndProjectIsSoftware, plPreviewHtml, plHumanModel, plScopeLabel, ndMethodSeg };', ctx);
const N = ctx.__nd;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('prévia: linguagem de gente, sem nome técnico de modelo nem glob', () => {
  const h = N.plPreviewHtml({ kind: 'fix', engine: 'claude', model: 'claude-sonnet-5', owns: ['src/pagamento/**', 'src/checkout/'], tasks: 1, costLo: 0.4, costHi: 0.8, rate: 5.5 });
  const t = text(h);
  assert.match(t, /Tipo: correção/);
  assert.match(t, /IA: equilibrada/);
  assert.match(t, /Mexe em: 2 pastas/);
  assert.match(t, /Custo: ~R\$ 3/);
  assert.match(t, /Vira: 1 tarefa/);
  assert.doesNotMatch(h, /claude-sonnet-5|src\/pagamento|\*\*/, 'nome técnico só no popover');
  // cada item é clicável (troca na hora)
  for (const k of ['tipo', 'entrega', 'modo', 'ia', 'escopo', 'custo']) assert.match(h, new RegExp(`<button[^>]*data-prev="${k}"`));
});

test('prévia: tipo automático usa o palpite e avisa que é automático', () => {
  const t = text(N.plPreviewHtml({ kind: '', guess: 'invest', engine: 'claude', model: 'opus', owns: [], tasks: 3 }));
  assert.match(t, /Tipo: investigação automático/);
  assert.match(t, /IA: caprichada/);
  assert.match(t, /Mexe em: a IA decide/);
  assert.match(t, /Vira: épico · 3 tarefas/);
});

test('prévia: projeto que não é software não fala de PR nem de branch', () => {
  for (const kind of ['invest', 'docs', 'design']) {
    assert.ok(N.ND_NON_SOFTWARE.has(kind));
    const h = N.plPreviewHtml({ kind, engine: 'claude', model: '', owns: ['conteudo/'], tasks: 1 });
    assert.doesNotMatch(text(h), /\bPR\b|branch/i, kind);
  }
  assert.match(text(N.plPreviewHtml({ kind: 'build', engine: 'claude', model: '' })), /Entrega: PR pra revisar/);
});

test('rótulos humanos de IA e de escopo', () => {
  assert.equal(N.plHumanModel('claude', 'claude-haiku-4-5-20251001'), 'rápida');
  assert.equal(N.plHumanModel('claude', 'claude-fable-5-1'), 'caprichada');
  assert.equal(N.plHumanModel('codex', 'gpt-5'), 'Codex');
  assert.equal(N.plHumanModel('claude', ''), 'padrão do plano');
  assert.equal(N.plScopeLabel(['src/a/**', 'README.md']), '1 pasta e 1 arquivo');
  assert.equal(N.plScopeLabel([]), 'a IA decide');
});

test('tipo → modo do formulário (docs entra como build com branch docs/)', () => {
  assert.equal(N.ND_TO_MODE.fix, 'fix');
  assert.equal(N.ND_TO_MODE.docs, 'build');
  assert.equal(N.ND_TO_MODE.review, 'review');
  for (const t of N.ND_TYPES) assert.ok(N.ND_TO_MODE[t.k], 'todo tipo tem modo: ' + t.k);
});

test('palpite de tipo pelo texto', () => {
  assert.equal(N.ndGuessType('o botão de pagar some no celular, corrigir'), 'fix');
  assert.equal(N.ndGuessType('Descobrir por que o login demora 10 s'), 'invest');
  assert.equal(N.ndGuessType('Escrever o e-mail de lançamento pros clientes'), 'docs');
  assert.equal(N.ndGuessType('Criar uma página de contato com formulário'), 'build');
  assert.equal(N.ndGuessType(''), '');
});

test('exemplos: 4 a 6, com pelo menos 2 que não são software, e ordem pelo tipo de projeto', () => {
  for (const sw of [true, false]) {
    const ex = N.ndExamples(sw);
    assert.ok(ex.length >= 4 && ex.length <= 6, 'quantidade');
    assert.ok(ex.filter((e) => !e.sw).length >= 2, 'não-software');
    assert.ok(ex.every((e) => N.ND_TYPES.some((t) => t.k === e.k)), 'tipo válido');
  }
  assert.equal(N.ndExamples(false)[0].sw, false);
  assert.equal(N.ndExamples(true)[0].sw, true);
  assert.equal(N.ndProjectIsSoftware('site-institucional'), false);
  assert.equal(N.ndProjectIsSoftware('loja'), true);
});

test('seletor de modo pequeno: Conversar · Formulário · Dividir', () => {
  const h = N.ndMethodSeg('chat');
  assert.equal(text(h), 'Conversar Formulário Dividir');
  assert.match(h, /ndseg-sm/);
  assert.match(h, /class="on"[^>]*data-ndseg="planner"/);
});

test('flag legada nd:legacy liga a tela antiga de 2 passos', () => {
  assert.equal(N.ndLegacy(), false);
  ctx.localStorage.setItem('nd:legacy', '1');
  assert.equal(N.ndLegacy(), true);
  ctx.localStorage.removeItem('nd:legacy');
  assert.equal(N.ndLegacy(), false);
});
