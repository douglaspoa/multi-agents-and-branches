// node --test app/tests/tarefa-duplicada.test.mjs — aviso antes de criar a mesma demanda 2× (14-issues-projeto)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const JS = readFileSync(new URL('../src/js/14-issues-projeto.js', import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const P = new Function(cut(JS, 'function trkTitleKey', 'async function trkBeforeNewTask') + '\nreturn { trkDupOf, trkTitleKey };')();

test('mesma demanda aberta (título igual, sem ligar pra acento/pontuação) → acha a que já existe', () => {
  const tasks = [
    { id: 'checkout-lento', title: 'Lentidão no checkout após trocar o gateway (#12/#13)', status: 'review' },
    { id: 'velha', title: 'Cupom no checkout', status: 'merged' },
    { id: 'fechada', title: 'Frete grátis', status: 'review', flag: 'closed' },
  ];
  assert.equal(P.trkDupOf({ title: 'lentidao no checkout apos trocar o gateway #12 #13' }, tasks).id, 'checkout-lento');
  assert.equal(P.trkDupOf({ title: 'Cupom no checkout' }, tasks), null, 'integrada não conta');
  assert.equal(P.trkDupOf({ title: 'Frete grátis' }, tasks), null, 'encerrada não conta');
  assert.equal(P.trkDupOf({ title: 'Outra coisa' }, tasks), null);
  assert.equal(P.trkDupOf({ title: '' }, tasks), null);
});

test('só pergunta quando é a pessoa criando (ask); o caminho automático não pergunta e o cartão religa a tarefa que já existe', () => {
  assert.match(JS, /async function trkBeforeNewTask\(payload, o\)\{\n  if\(o&&o\.ask\)\{ const d=trkDupOf/);
  const planner = readFileSync(new URL('../src/js/32-planner.js', import.meta.url), 'utf8');
  assert.equal((planner.match(/trkBeforeNewTask\(payload\)\)/g) || []).length, 0, 'toda criação pela tela pergunta');
  const times = readFileSync(new URL('../src/js/43-espaco-times.js', import.meta.url), 'utf8');
  assert.match(times, /const localId=ja \? ja\.id : await invoke\('new_task'/);
});

test('iniciar: o cartão do time não atualizou (rede/servidor) → a tarefa que já nasceu segue, aviso em vez de erro, sem 2ª cópia', async () => {
  const vm = await import('node:vm');
  const T = readFileSync(new URL('../src/js/43-espaco-times.js', import.meta.url), 'utf8');
  const i = T.indexOf('async function teamClaimStart'), j = T.indexOf('\nasync function teamDeleteCard', i);
  const made = [], toasts = [], errs = [];
  const tasks = [];
  const c = { console: { ...console, error: (...a) => errs.push(a.join(' ')), info() {} }, window: {}, defaultAiEngine: () => 'claude', aiDefaults: () => ({ advisor: '' }), epicDoneWhenOf: () => null,
    sbRpc: async () => ({ ok: true }), trkBeforeNewTask: async (p) => p, trkDupOf: (p, l) => l.find((t) => t.title === p.title) || null,
    invoke: async (cmd, p) => { made.push(p); tasks.push({ id: 'loc' + made.length, title: p.title, status: 'running' }); return 'loc' + made.length; },
    tmapSet() {}, tmap: () => ({}), sbFetch: async () => { throw new Error('sem conexão com o servidor'); }, sbPost: async () => ({}),
    cloudUserId: () => 'u1', refresh: async () => {}, tsClaimShow: () => [], toast: (m, k) => toasts.push(k), showErr(e) { throw e; }, humanErr: (e) => ({ msg: e.message }),
    state: { tasks } };
  vm.createContext(c);
  vm.runInContext('let teamTasks, lastSig, allTasksAt;\n' + T.slice(i, j) + '\nglobalThis.go=teamClaimStart;', c);
  const card = { id: 'c1', title: 'Cupom no checkout', spec: { title: 'Cupom no checkout' } };
  assert.equal(await c.go(card, null, {}), 'loc1');
  assert.deepEqual(toasts, ['warn']); assert.ok(errs.some((e) => /cartão do time não atualizou/.test(e)));
  assert.equal(await c.go(card, null, {}), 'loc1', 'o 2º clique religa a mesma tarefa');
  assert.equal(made.length, 1, 'nenhuma cópia nova');
});
