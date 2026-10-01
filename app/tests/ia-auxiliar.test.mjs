// IA auxiliar segue a IA padrão (spec-ia-auxiliar-sem-claude): o app ESPELHA a IA padrão em settings.json
// (aiEngine/aiModel) e o Ambiente não exige mais o Claude — basta um motor (Claude, Codex ou gateway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };

function pickerCtx(store, opts = {}) {
  const calls = [];
  const listeners = {};
  let inflight = 0, maxInflight = 0, fails = opts.fails || 0;
  const noop = () => {};
  const ctx = {
    window: { addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }, removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); } },
    document: { getElementById: () => null, addEventListener: noop, querySelectorAll: () => [] },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' },
    console,
    invoke: async (cmd, args) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      calls.push([cmd, JSON.parse(JSON.stringify(args))]);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      if (fails > 0) { fails--; throw new Error('backend ainda subindo'); }
      return null;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('00-util.js') + '\n' + read('29-ia-picker.js'), ctx);
  return { ctx, calls, listeners, maxInflight: () => maxInflight };
}
const tick = () => new Promise((r) => setTimeout(r, 40));

test('boot: espelha o padrão do localStorage em settings.json (aiEngine/aiModel), em série', async () => {
  const P = pickerCtx({ defaultEngine: 'codex', defaultModel: 'gpt-5' });
  await tick();
  assert.deepEqual(P.calls, [['write_setting', { key: 'aiEngine', value: 'codex' }], ['write_setting', { key: 'aiModel', value: 'gpt-5' }]]);
  assert.equal(P.maxInflight(), 1, 'duas gravações em paralelo perdiam uma chave');
});

test('salvar o padrão nas Configurações grava no localStorage E no settings.json; repetido não regrava', async () => {
  const store = {};
  const P = pickerCtx(store);
  await tick();
  assert.deepEqual(P.calls.map((c) => c[1].value), ['claude', ''], 'sem padrão salvo = claude');
  P.calls.length = 0;
  P.ctx.aiSaveDefaults('gateway', 'modelo-interno');
  await tick();
  assert.equal(store.defaultEngine, 'gateway');
  assert.deepEqual(P.calls, [['write_setting', { key: 'aiEngine', value: 'gateway' }], ['write_setting', { key: 'aiModel', value: 'modelo-interno' }]]);
  P.calls.length = 0;
  P.ctx.aiSaveDefaults('gateway', 'modelo-interno');
  await tick();
  assert.equal(P.calls.length, 0);
  // mock não é IA: a auxiliar segue no claude; logcomex é o nome antigo do gateway
  P.ctx.aiSaveDefaults('mock', '');
  await tick();
  assert.equal(P.calls[0][1].value, 'claude');
  P.calls.length = 0;
  P.ctx.aiSaveDefaults('logcomex', '');
  await tick();
  assert.equal(P.calls[0][1].value, 'gateway');
});

test('duas trocas seguidas NÃO intercalam as gravações (fila única)', async () => {
  const P = pickerCtx({});
  await tick();
  P.calls.length = 0;
  P.ctx.aiSaveDefaults('codex', 'gpt-5');
  P.ctx.aiSaveDefaults('gateway', 'm2');
  await tick(); await tick();
  assert.deepEqual(P.calls.map((c) => c[1].value), ['codex', 'gpt-5', 'gateway', 'm2']);
  assert.equal(P.maxInflight(), 1);
});

test('gravação do boot falhou → tenta UMA vez de novo no próximo foco da janela', async () => {
  const P = pickerCtx({ defaultEngine: 'codex' }, { fails: 1 });
  await tick();
  assert.equal(P.calls.length, 1, 'falhou na 1ª gravação');
  assert.equal((P.listeners.focus || []).length, 1);
  P.listeners.focus[0]();
  await tick();
  assert.deepEqual(P.calls.slice(1).map((c) => c[1].value), ['codex', '']);
  assert.equal((P.listeners.focus || []).length, 0);
});

test('o planner salva o padrão pelo mesmo caminho (aiSaveDefaults)', () => {
  const src = read('32-planner.js');
  assert.match(src, /if\(saved\)\{ aiSaveDefaults\(eng, model\); \}/);
  assert.doesNotMatch(src, /lsSet\('defaultEngine'/);
});

const envSrc = read('11-ambiente-updater.js');
const ENV = new Function(cut(envSrc, '// @env-puro-inicio', '// @env-puro-fim') + '\nreturn { envKind, envWhat, envSummary, envFixLines };')();
// nomes/kinds exatamente como o Rust manda agora (lib.rs env_check + env_ai_item)
const CHECKS = (over) => [
  { name: 'Node.js (≥22.13)', kind: 'req', ok: true }, { name: 'Motor do Starfork', kind: 'req', ok: true }, { name: 'Git', kind: 'req', ok: true },
  { name: 'Motor de IA (pelo menos um)', kind: 'req', ok: true }, { name: 'Claude Code (opcional)', kind: 'opt', ok: true },
  { name: 'Codex (opcional)', kind: 'opt', ok: true }, { name: 'Gateway de IA (opcional)', kind: 'opt', ok: true },
  { name: 'GitHub CLI (gh)', kind: 'rec', ok: true }, { name: 'Túnel do preview (opcional)', kind: 'opt', ok: true },
].map((c) => Object.assign({}, c, (over || {})[c.name] || {}));

test('ambiente só com Codex: sem claude NÃO é pendência', () => {
  const s = ENV.envSummary(CHECKS({ 'Claude Code (opcional)': { ok: false }, 'Gateway de IA (opcional)': { ok: false } }));
  assert.equal(s.reqBad, 0);
  assert.equal(s.optBad, 2);
  // sem nenhum motor: UMA pendência (o Motor de IA), não três
  const n = ENV.envSummary(CHECKS({ 'Motor de IA (pelo menos um)': { ok: false }, 'Claude Code (opcional)': { ok: false }, 'Codex (opcional)': { ok: false }, 'Gateway de IA (opcional)': { ok: false } }));
  assert.equal(n.reqBad, 1);
  assert.equal(ENV.envKind({ name: 'Codex (opcional)' }), 'opt', 'versão velha do backend sem kind: o nome resolve');
});

test('envWhat: Motor de IA ≠ Motor do Starfork; cada motor explicado', () => {
  for (const c of CHECKS()) assert.ok(ENV.envWhat(c).length > 10, c.name);
  assert.match(ENV.envWhat({ name: 'Motor de IA (pelo menos um)' }), /Basta uma/);
  assert.match(ENV.envWhat({ name: 'Motor do Starfork' }), /dentro do app/);
  assert.match(ENV.envWhat({ name: 'Codex (opcional)' }), /OpenAI/);
  assert.match(ENV.envWhat({ name: 'Gateway de IA (opcional)' }), /empresa/);
});

test('envFixLines: 3 opções de correção — comandos copiáveis, "configure…" é instrução', () => {
  const f = ENV.envFixLines('npm install -g @anthropic-ai/claude-code && claude\nnpm install -g @openai/codex && codex login\nconfigure um gateway em Configurações → Gateway próprio');
  assert.deepEqual(f.map((x) => x.cmd), [true, true, false]);
  assert.deepEqual(ENV.envFixLines('reinstale o app (o motor vai dentro dele)').map((x) => x.cmd), [false]);
  assert.deepEqual(ENV.envFixLines(''), []);
});

test('erros da IA auxiliar: Codex/gateway/nenhum motor NÃO viram "faça login no Claude"', () => {
  const store = {};
  const P = pickerCtx(store);
  const id = (m) => P.ctx.humanErr(new Error(m)).id;
  assert.equal(id('Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex'), 'ai-none');
  assert.equal(id('O Codex está sem login/chave — rode `codex login` num terminal.\n\n(401 Unauthorized: invalid api key)'), 'codex-login');
  assert.notEqual(id('dica: rode codex login depois'), 'codex-login', 'só a falha real de auth, não qualquer menção');
  assert.equal(id('O Codex não está instalado neste computador — npm install -g @openai/codex'), 'codex-missing');
  assert.equal(id('O Codex não respondeu a tempo — tente de novo.'), 'codex-timeout');
  assert.equal(id('O Codex está sem cota/limite no momento.\n\n(429 rate limit; invalid api key)'), 'codex-quota');
  assert.equal(id('O Codex não conseguiu falar com a OpenAI — cheque a internet/VPN.\n\n(stream disconnected)'), 'codex-network');
  assert.equal(id('Não consegui falar com o gateway (http://x) — cheque a URL'), 'gateway-unreachable');
  assert.equal(id('a resposta do gateway foi cortada (limite de tokens) — peça algo menor'), 'gateway-truncated');
  assert.equal(id('O gateway devolveu uma resposta vazia — tente de novo.'), 'gateway-empty');
  assert.equal(id('O gateway recusou a chave — confira em Configurações → Gateway próprio.\n\n(Invalid API key)'), 'gateway-key');
  assert.equal(id('Login do Claude Code expirou — rode `claude`'), 'claude-login');
});

test('textos de onboarding não dizem mais que o Claude é obrigatório', () => {
  assert.match(read('15-config-abas-onboarding.js'), /basta uma, com login feito/);
  assert.match(read('44-onboarding.js'), /Git e uma IA: Claude Code, Codex ou gateway/);
});

test('tour de boas-vindas: correção com várias opções vira uma linha por opção (copiar só em comando)', () => {
  const cfg = read('15-config-abas-onboarding.js');
  const ctx = { esc: (x) => String(x), escA: (x) => String(x) };
  vm.createContext(ctx);
  vm.runInContext(cut(envSrc, '// @env-puro-inicio', '// @env-puro-fim') + cut(cfg, '// @ob-envfix-inicio', '// @ob-envfix-fim') + '\nglobalThis.__f=obEnvFixHtml;', ctx);
  const html = ctx.__f('npm install -g @anthropic-ai/claude-code && claude\nnpm install -g @openai/codex && codex login\nconfigure um gateway em Configurações → Gateway próprio', false);
  assert.equal((html.match(/data-envfix=/g) || []).length, 2);
  assert.equal((html.match(/margin-top:5px/g) || []).length, 3);
  assert.match(html, /ou rode no Terminal:/);
  assert.match(html, /como resolver:<\/span><span[^>]*>configure um gateway/);
  assert.doesNotMatch(cfg, /data-envfix="\$\{escA\(c\.fix\)\}"/, 'o tour não copia mais o fix inteiro como um comando só');
});

test('DeepSeek (beta): erros humanos próprios, Ambiente explica, chave não manda logar no Claude', () => {
  const P = pickerCtx({});
  const id = (m) => P.ctx.humanErr(new Error(m)).id;
  assert.equal(id('Falta a chave da DeepSeek (DEEPSEEK_API_KEY) — adicione em Conta → Chaves de modelo.'), 'dsh-key');
  assert.equal(id('Falta a chave da DeepSeek (DEEPSEEK_API_KEY) — adicione em Conta → Chaves de modelo e confira se ela é válida.\n\n(401 Unauthorized: invalid api key)'), 'dsh-key');
  assert.equal(id('O DeepSeek Harness (dsh) não está instalado neste computador — instale com npm i -g @deepseek-ai/dsh (veja Mais › Ambiente).'), 'dsh-missing');
  assert.equal(id('O DeepSeek Harness precisa do Node 22.19+ ou 24+ (o deste computador é 22.12.0)'), 'dsh-node');
  assert.equal(id('O DeepSeek não respondeu a tempo — tente de novo.'), 'dsh-timeout');
  assert.equal(id('O DeepSeek está sem saldo/limite no momento — confira a conta.\n\n(429)'), 'dsh-quota');
  assert.equal(id('Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), configure um gateway em Configurações → Gateway próprio, ou use o DeepSeek Harness (beta: npm i -g @deepseek-ai/dsh + DEEPSEEK_API_KEY em Conta → Chaves de modelo).'), 'ai-none');
  assert.match(ENV.envWhat({ name: 'DeepSeek Harness (opcional · beta)' }), /BETA/);
  assert.equal(ENV.envKind({ name: 'DeepSeek Harness (opcional · beta)' }), 'opt');
  assert.match(ENV.envWhat({ name: 'Motor de IA (pelo menos um)' }), /DeepSeek Harness \(beta\)/);
  // a correção do "nenhum motor" (Rust env_ai_item): instalar o dsh é comando; a chave é instrução
  assert.deepEqual(ENV.envFixLines('npm i -g @deepseek-ai/dsh\nconfigure a DEEPSEEK_API_KEY em Conta → Chaves de modelo (DeepSeek, beta)').map((x) => x.cmd), [true, false]);
});

test('salvar/remover chave em Conta → Chaves de modelo zera o cache de disponibilidade (DeepSeek aparece na hora)', async () => {
  const src = read('41-assinatura-chaves.js');
  const calls = [];
  const ctx = { invoke: async (c) => { calls.push(c); }, sbFetch: async () => ({}), cloudUserId: () => 'u', secretsSync: async () => {} };
  vm.createContext(ctx);
  vm.runInContext(cut(src, '// chave nova/removida', '// seção na Conta: listar') + '\nglobalThis.__s=secretSet; globalThis.__d=secretDel;', ctx);
  await ctx.__s('DEEPSEEK_API_KEY', 'k');
  await ctx.__d('DEEPSEEK_API_KEY');
  assert.deepEqual(calls, ['ai_avail_refresh', 'ai_avail_refresh']);
});
