// Seletor de IA ÚNICO (F4 · D12, 29-ia-picker.js): `node --test app/tests/ia-pick.test.mjs`
// A lógica pura (rótulo, estado/login por motor, dica de custo, igualdade) e o uso nas telas do G2:
// Nova demanda (planner e Formulário), construir sozinho, Mesa e fim de caminho da Ideia — nenhum outro formato sobra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const SRC = read('29-ia-picker.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho: ' + a); return s.slice(i, j); };
const ctx = { console, esc: (s) => String(s), escA: (s) => String(s), suaIaStateText: (s) => ({ ready: 'pronto', login: 'falta login', key: 'falta chave' })[s.state] || '' };
vm.createContext(ctx);
// catálogo + helpers que o trecho puro usa (AI_ENGINES, aiEngineOf, aiRunLabel, aiModelName) + o trecho puro
vm.runInContext(cut(SRC, 'const AI_CLAUDE_MODELS', '// @cor-dado-fim') + cut(SRC, 'function aiModelName', '// IA que responde os chats') + cut(SRC, '// @ia-pick-puro-inicio', '// @ia-pick-puro-fim') + '\nglobalThis.P={ iaPickNorm, iaPickLabel, iaPickCostHint, iaPickOptions, iaPickSame, IA_PICK_SCOPE, IA_PICK_ALIAS };', ctx);
const P = ctx.P, plain = (v) => JSON.parse(JSON.stringify(v));

test('normaliza o valor: rótulos antigos (logcomex → gateway), vazio = Claude', () => {
  assert.deepEqual(plain(P.iaPickNorm({ engine: 'logcomex', model: 'x' })), { engine: 'gateway', model: 'x' });
  assert.deepEqual(plain(P.iaPickNorm({ eng: 'codex' })), { engine: 'codex', model: '' });
  assert.deepEqual(plain(P.iaPickNorm({})), { engine: 'claude', model: '' });
  assert.deepEqual(plain(P.iaPickNorm({ engine: 'mock' })), { engine: 'mock', model: '' }, 'mock só quando pedido');
});

test('rótulo da pílula: "Claude · Sonnet 5"; sem modelo = "· padrão"', () => {
  assert.equal(P.iaPickLabel({ engine: 'claude', model: 'claude-sonnet-5' }), 'Claude · Sonnet 5');
  assert.equal(P.iaPickLabel({ engine: 'claude', model: '' }), 'Claude · padrão');
  assert.equal(P.iaPickLabel({ engine: 'codex', model: 'gpt-6-astra' }), 'Codex · GPT-6-Astra');
});

test('dica de custo relativa (não é preço inventado)', () => {
  assert.match(P.iaPickCostHint({ engine: 'claude', model: 'claude-opus-5-5' }), /mais caro/);
  assert.match(P.iaPickCostHint({ engine: 'claude', model: 'claude-haiku-4-5-20251001' }), /mais barato/);
  assert.match(P.iaPickCostHint({ engine: 'codex' }), /ChatGPT/);
  assert.match(P.iaPickCostHint({ engine: 'gateway' }), /empresa/);
});

test('opções: estado de login/chave por motor; motor não pronto fica desligado com o caminho pra configurar', () => {
  const st = { claude: { ready: true, state: 'ready' }, codex: { ready: false, state: 'login' }, deepseek: { ready: false, state: 'key' } };
  const o = plain(P.iaPickOptions((id) => st[id] || null, null, { configured: true, label: 'Logcomex AI', model: 'logcomex-v2', models: ['logcomex-v2', 'qwen'] }));
  assert.deepEqual(o.map((x) => x.id), ['claude', 'codex', 'gateway', 'deepseek']);
  assert.equal(o[0].ready, true); assert.equal(o[0].state, 'pronto');
  assert.equal(o[1].ready, false); assert.equal(o[1].state, 'falta login'); assert.match(o[1].hint, /Ajustes › IA e modelos/);
  assert.equal(o[2].name, 'Logcomex AI (gateway)'); assert.deepEqual(o[2].models.map((m) => m.id), ['', 'qwen']);
  assert.equal(o[3].state, 'falta chave');
  assert.ok(!o[0].models.some((m) => /^(opus|sonnet|haiku)$/.test(m.id)), 'aliases ficam no "outro id…": os chips são versões travadas');
  const sem = plain(P.iaPickOptions(() => null, ['gateway'], { configured: false }));
  assert.equal(sem[0].ready, false); assert.equal(sem[0].state, 'falta configurar');
  assert.equal(plain(P.iaPickOptions(() => null, ['claude']))[0].ready, true, 'estado ainda verificando não bloqueia');
});

test('igualdade e recomendação em alias → id fixo', () => {
  assert.equal(P.iaPickSame({ engine: 'claude', model: 'x' }, { eng: 'claude', model: 'x' }), true);
  assert.equal(P.iaPickSame({ engine: 'claude', model: 'x' }, { engine: 'codex', model: 'x' }), false);
  assert.equal(P.IA_PICK_ALIAS.sonnet, 'claude-sonnet-5');
  assert.equal(P.IA_PICK_SCOPE.piloto, 'vale pra todas as tarefas do piloto');
});

test('UM seletor nas telas do G2: os 4 formatos antigos saíram', () => {
  assert.match(SRC, /window\.iaPick=iaPick/);
  assert.match(cut(SRC, 'function aiPickRender(target){', '\n}'), /if\(target===AI_TARGET_FORM && typeof iaPick==='function'\)/, 'Formulário: o seletor completo virou a pílula');
  assert.match(read('32-planner.js'), /PL_IA=iaPick\(host/, 'Nova demanda: pílula ao lado do Tipo (sem o cartão "Com qual IA?" empurrado no fio)');
  const pil = read('56-piloto.js');
  assert.match(pil, /PIL_IA=iaPick\(host, \{ value:\{ engine:PIL_FORM\.engine, model:PIL_FORM\.model \}, scope:'piloto'/);
  assert.doesNotMatch(pil, /id="pilModel"|<select id="pilEngine"/, 'construir sozinho: sem select de IA nem modelo em texto livre');
  const mesa = read('38-mesa.js');
  assert.match(mesa, /model:m\.model\|\|null/, 'Mesa: sem o Sonnet fixo — vai a IA escolhida');
  assert.doesNotMatch(mesa, /model:m\.model\|\|MESA_MODEL/);
  assert.match(read('65-fabrica.js'), /FAB_HUB\.mesaIa=iaPick\(h, \{ value:prev, scope:'mesa'/);
  assert.match(read('59-ideia.js'), /IDEIA\.endIa=iaPick\(h, \{ value:\{ engine:E\.engine, model:E\.model \}, scope:'piloto'/);
  // a folha fecha no Esc (nunca a aba) e devolve o foco
  assert.match(SRC, /if\(e\.key==='Escape'\)\{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(true\); \}/);
});

test('"Usar esta": só dispara quando muda (ou "usar como padrão")', () => {
  const C = vm.runInContext('iaPickCommit', ctx);
  assert.equal(C({ engine: 'claude', model: 'a' }, { engine: 'claude', model: 'a' }, false).fire, false);
  assert.equal(C({ engine: 'claude', model: 'a' }, { engine: 'claude', model: 'a' }, true).fire, true);
  assert.deepEqual(plain(C({ engine: 'claude', model: 'a' }, { engine: 'logcomex', model: 'b' }, false)), { value: { engine: 'gateway', model: 'b' }, fire: true });
});

test('Formulário: a pílula grava nos selects escondidos (#ntEngine/#ntModel/#howModel); "logcomex" antigo vira gateway', () => {
  const sel = (v) => ({ value: v, options: [], add(o) { this.options.push(o); } });
  const els = { ntEngine: sel('logcomex'), ntModel: sel('m0'), howModel: sel('') };
  const picks = [];
  const host = { innerHTML: '', contains: () => false, querySelector: () => null };
  const c2 = { console, esc: String, escA: String, IC: {}, lsGet: () => null, lsSet() {}, invoke: async () => '', window: {},
    $id: (id) => els[id] || null, document: { querySelectorAll: (q) => (q === '.aipick' ? [host] : []) },
    Option: function (t, v) { this.text = t; this.value = v; }, iaPick: (el, o) => { picks.push(o); return { set() {}, pill: null }; } };
  c2.window = c2; vm.createContext(c2);
  vm.runInContext(SRC.replace(/\naiApplyDefaults\(\);[\s\S]*$/, '\n'), c2);
  // a pílula NÃO começa com o rótulo velho: o select já vira gateway antes de montar
  vm.runInContext('aiPickRender()', c2);
  assert.equal(els.ntEngine.value, 'gateway');
  assert.deepEqual(plain(picks[0].value), { engine: 'gateway', model: 'm0' });
  picks[0].onChange({ engine: 'claude', model: 'claude-opus-5-5' });
  assert.equal(els.ntEngine.value, 'claude'); assert.equal(els.ntModel.value, 'claude-opus-5-5'); assert.equal(els.howModel.value, 'claude-opus-5-5');
  assert.equal(picks[0].scope, 'demanda'); assert.equal(typeof picks[0].recommend, 'function');
});

test('folhas do seletor e do ⋯: aria-modal, foco preso (Tab dá a volta), setas no menu, Esc fecha e devolve o foco', () => {
  assert.match(SRC, /sh\.setAttribute\('aria-modal','true'\); sh\.setAttribute\('aria-label','Com qual IA\?'\)/);
  assert.match(SRC, /function g2Trap\(sh, e\)\{\n  if\(e\.key!=='Tab'/);
  assert.match(SRC, /\['ArrowDown','ArrowUp','Home','End'\]\.includes\(e\.key\)/);
  assert.match(SRC, /if\(refocus\) try\{ p\.focus\(\{ preventScroll:true \}\); \}catch\(_\)\{ \}/);
});
