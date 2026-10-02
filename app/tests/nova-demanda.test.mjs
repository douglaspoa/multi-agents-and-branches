// Repaginada B (Nova demanda numa tela só): `node --test app/tests/nova-demanda.test.mjs`
// Carrega 00-util + 14-nova-demanda-inicio + 15-config-abas + 29-ia-picker + 32-planner num vm com um DOM de mentira
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
  loadDaily: noop, dailyAISummary: noop, dailyGenDoc: noop, setTimeout: () => 0, clearTimeout: noop,
  state: { repo: '/r' }, toast: noop,
};
ctx.escA = (s) => ctx.esc(s).replace(/"/g, '&quot;');
vm.createContext(ctx);
vm.runInContext([read('00-util.js'), read('14-nova-demanda-inicio.js'), read('15-config-abas-onboarding.js'), read('29-ia-picker.js'), read('32-planner.js')].join('\n;\n')
  + '\n;globalThis.__nd={ ND_TYPES, ND_TO_MODE, ndKindCreate, ndSplitCarry, ndTakeCarry, ndTakeCarryAll, plKindTag, openTab, tabs:()=>TABS, setCarry:(t,x)=>{ ndCarryText=t; ndCarryExtra=x||null; }, ndExamples, ndGuessType, ndLegacy, ndProjectIsSoftware, plPreviewHtml, plHumanModel, plScopeLabel, ndMethodSeg };', ctx);
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
  assert.match(t, /Mexe em: só os documentos/, 'investigação só escreve documento');
  assert.match(t, /Vira: épico · 3 tarefas/);
});

test('prévia: tipos que não entregam código não falam de PR nem de branch', () => {
  for (const kind of ['invest', 'docs', 'design']) {
    const h = N.plPreviewHtml({ kind, engine: 'claude', model: '', owns: ['conteudo/'], tasks: 1 });
    assert.doesNotMatch(text(h), /\bPR\b|branch/i, kind);
  }
  assert.match(text(N.plPreviewHtml({ kind: 'build', engine: 'claude', model: '' })), /Entrega: PR pra revisar/);
});

test('rótulos humanos de IA e de escopo', () => {
  assert.equal(N.plHumanModel('claude', 'claude-haiku-4-5-20251001'), 'rápida');
  assert.equal(N.plHumanModel('claude', 'claude-fable-5-1'), 'caprichada');
  assert.equal(N.plHumanModel('codex', 'gpt-5'), 'Codex');
  assert.equal(N.plHumanModel('deepseek', 'deepseek-flash'), 'DeepSeek (beta)');
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

test('seletor de modo pequeno: Conversar · Formulário · Dividir · Piloto automático', () => {
  const h = N.ndMethodSeg('chat');
  assert.equal(text(h), 'Conversar Formulário Dividir Piloto automático');
  assert.match(N.ndMethodSeg('auto'), /class="on"[^>]*data-ndseg="piloto"/);
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

test('prévia: épico com tudo desmarcado e custo desconhecido', () => {
  const h = N.plPreviewHtml({ kind: 'build', engine: 'claude', model: '', tasks: 0 });
  assert.match(text(h), /Vira: nenhuma tarefa marcada/);
  assert.match(text(h), /Custo: —/, 'o item de custo (e o teto no popover) aparece sempre');
  assert.match(h, /data-prev="custo"/);
});

test('palpite de tipo: revisão (com acento) e design', () => {
  assert.equal(N.ndGuessType('Fazer a revisão do PR 42 do checkout'), 'review');
  assert.equal(N.ndGuessType('revisar o pull request de pagamentos'), 'review');
  assert.equal(N.ndGuessType('Desenhar a tela nova de onboarding, só mockup'), 'design');
  assert.notEqual(N.ndGuessType('revisões de preço da tabela'), 'review');
});

test('tipo → criação (o que o plCreate usa): mesmo mapeamento do formulário', () => {
  const b = N.ndKindCreate('build'), f = N.ndKindCreate('fix');
  assert.equal(b.branchType, 'feat'); assert.equal(b.autoPr, 'ask'); assert.equal(b.mode, 'build');
  assert.equal(f.branchType, 'fix'); assert.equal(f.autoPr, 'ask'); assert.equal(f.mode, 'fix');
  for (const k of ['invest', 'docs', 'design']) assert.equal(N.ndKindCreate(k).autoPr, 'no', k + ' entrega documento, sem PR');
  assert.equal(N.ndKindCreate('docs').branchType, 'docs'); assert.equal(N.ndKindCreate('docs').mode, 'build');
  assert.equal(N.ndKindCreate('invest').doc, 'INVESTIGATION.md');
  assert.equal(N.ndKindCreate('design').owns, '.cardume/');
  assert.equal(N.ndKindCreate('???').kind, 'build');
  // a prévia descreve o mesmo que vai ser criado
  for (const t of N.ND_TYPES) assert.match(text(N.plPreviewHtml({ kind: t.k })), new RegExp('Entrega: ' + N.ndKindCreate(t.k).delivery));
});

test('aviso de tipo pra IA: uma vez, e volta pro automático uma vez', () => {
  let r = N.plKindTag('fix', '');
  assert.match(r.tag, /Correção/); assert.equal(r.next, 'fix');
  r = N.plKindTag('fix', 'fix');
  assert.equal(r.tag, '', 'não repete'); assert.equal(r.next, 'fix');
  r = N.plKindTag('', 'fix');
  assert.match(r.tag, /automático — ignore o tipo anterior/); assert.equal(r.next, '');
  r = N.plKindTag('', '');
  assert.equal(r.tag, '');
  r = N.plKindTag('docs', 'fix');
  assert.match(r.tag, /Documentação/); assert.equal(r.next, 'docs');
});

test('texto levado entre modos: consome uma vez; título/objetivo', () => {
  N.setCarry('O botão some. Quero corrigir.', { title: 'Botão some' });
  const all = N.ndTakeCarryAll();
  assert.equal(all.text, 'O botão some. Quero corrigir.'); assert.equal(all.title, 'Botão some');
  assert.equal(N.ndTakeCarry(), '', 'só uma vez');
  N.setCarry('abc');
  assert.equal(N.ndTakeCarry(), 'abc'); assert.equal(N.ndTakeCarry(), '');
  assert.deepEqual({ ...N.ndSplitCarry('O botão some no celular. Quero entender.') }, { title: 'O botão some no celular.', objective: 'O botão some no celular. Quero entender.' });
  assert.equal(N.ndSplitCarry('x'.repeat(200)).title.length, 80);
  assert.equal(N.ndSplitCarry('texto', 'Título dado').title, 'Título dado');
});

test("openTab('nova') abre o planner; com nd:legacy volta a tela antiga", () => {
  ctx.activateTab = noop; // só o roteamento importa aqui (sem pintar)
  N.openTab('nova');
  assert.equal(N.tabs().at(-1).kind, 'planner');
  ctx.localStorage.setItem('nd:legacy', '1');
  N.openTab('nova');
  assert.equal(N.tabs().at(-1).kind, 'nova');
  ctx.localStorage.removeItem('nd:legacy');
});
