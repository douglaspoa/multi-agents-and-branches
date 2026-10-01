// Motor/modelo na tela (fix/modelo-selecionado): `node --test app/tests/`
// Carrega 00-util.js + 29-ia-picker.js num vm e testa o rótulo do que RODA e o modelo dos chats no claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const noop = () => {};
const store = {};
const ctx = {
  window: { addEventListener: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelectorAll: () => [] },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  navigator: { platform: 'MacIntel', userAgent: '' },
  console,
};
vm.createContext(ctx);
vm.runInContext(read('00-util.js') + '\n' + read('29-ia-picker.js'), ctx);
const { aiEngineOf, aiCanTalk, aiRunLabel, aiClaudeModel, lsSet } = ctx;

test('aiEngineOf segue a regra do motor (engineKind)', () => {
  assert.equal(aiEngineOf('Claude · Opus 4.8'), 'claude');
  assert.equal(aiEngineOf('codex'), 'codex');
  assert.equal(aiEngineOf('logcomex'), 'gateway');
  assert.equal(aiEngineOf(''), 'mock');
  assert.equal(aiCanTalk('codex'), true);
  assert.equal(aiCanTalk('mock'), false);
});

test('rótulo mostra o motor de verdade — tarefa Codex não aparece como "Claude"', () => {
  assert.match(aiRunLabel('codex', 'gpt-5'), /^Codex · GPT-5$/);
  assert.match(aiRunLabel('claude', 'claude-opus-5-5'), /^Claude · Opus 5\.5$/);
  assert.match(aiRunLabel('claude', ''), /^Claude · padrão da assinatura$/);
  assert.equal(aiRunLabel('mock', ''), 'Mock (sem IA)');
});

test('chats no claude usam a IA padrão só quando o motor padrão é o Claude', () => {
  lsSet('defaultEngine', 'claude'); lsSet('defaultModel', 'claude-sonnet-5');
  assert.equal(aiClaudeModel(), 'claude-sonnet-5');
  lsSet('defaultEngine', 'codex'); lsSet('defaultModel', 'gpt-5');
  assert.equal(aiClaudeModel(), null, 'id do Codex no --model do claude derrubaria a chamada');
  assert.equal(aiClaudeModel('claude', 'opus'), 'opus');
  assert.equal(aiClaudeModel('claude', ''), null);
});

test('DeepSeek Harness (beta): motor próprio, rótulo com "beta", modelos do catálogo do dsh', () => {
  assert.equal(aiEngineOf('deepseek'), 'deepseek');
  assert.equal(aiEngineOf('dsh'), 'deepseek');
  assert.equal(aiCanTalk('deepseek'), true);
  assert.match(aiRunLabel('deepseek', 'deepseek-flash'), /^DeepSeek beta · DeepSeek Flash$/);
  assert.match(aiRunLabel('deepseek', ''), /^DeepSeek beta$/);
  const e = ctx.AI_ENGINES ?? vm.runInContext('AI_ENGINES', ctx);
  const ds = e.find((x) => x.id === 'deepseek');
  assert.ok(ds && ds.beta && /beta/i.test(ds.vendor) && /BETA/.test(ds.desc));
  assert.equal(JSON.stringify(ds.models.map((m) => m.id)), JSON.stringify(['', 'deepseek-v4-pro', 'deepseek-flash']));
  assert.equal(aiClaudeModel('deepseek', 'deepseek-flash'), null, 'id do DeepSeek nunca vai pro --model do claude');
});
