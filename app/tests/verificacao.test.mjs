// Verificação independente (Frente 1): selo + vigia do CI de 83-verificacao.js. `node --test app/tests/verificacao.test.mjs`
// Puras (@verif-puro) + o VIGIA inteiro num vm com o `gh` simulado atrás do pr_status: 2 voltas automáticas no máximo,
// a 3ª falha vira "precisa de você" e não volta mais sozinha; teto de custo vira pergunta; pendente = espera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = rd('../src/js/83-verificacao.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pure() {
  const c = { console };
  vm.createContext(c);
  vm.runInContext(cut(src, '// @verif-puro-inicio', '// @verif-puro-fim'), c);
  return c;
}
const J = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

test('selo: "Verificado: testes 84/86 · CI 3/4 · relato divergente" com o tom do pior item', () => {
  const c = pure();
  const s = J(c.verifSeal({ tests: { passed: 84, failed: 2, ran: true, runner: 'npm test', ok: false }, ci: { total: 4, fail: 1, pending: 0 }, divergente: true, relato: 'o agente relatou 86/86, a execução real deu 84/86' }));
  assert.equal(s.text, 'Verificado: testes 84/86 · CI 3/4 · relato divergente');
  assert.equal(s.tone, 'bad');
  assert.match(s.tip, /o agente relatou 86\/86, a execução real deu 84\/86/);
  assert.deepEqual(J(c.verifSeal({ tests: { passed: 12, failed: 0, ran: true, runner: 'pytest', ok: true }, ci: null, divergente: false })), { text: 'Verificado: testes 12/12', tone: 'ok', tip: 'Verificado: testes 12/12\npytest rodada pelo Starfork na cópia da tarefa' });
  assert.equal(c.verifSeal({ tests: null, ci: { total: 3, fail: 0, pending: 1 }, divergente: false }).tone, 'wait');
  assert.equal(c.verifSeal({ tests: { ran: false, skipped: 'a mudança só toca em docs/estilo (1 arquivo)', ok: true }, ci: null }).text, 'Verificado: testes pulados');
  assert.equal(c.verifSeal({ tests: { ran: true, timedOut: true, ok: false, runner: 'cargo test' }, ci: null }).tone, 'warn');
  assert.equal(c.verifSeal({ tests: { ran: true, ok: true, passed: null, failed: null }, ci: null }).text, 'Verificado: testes ok');
  assert.equal(c.verifSeal(null), null);
  assert.equal(c.verifSeal({ tests: null, ci: null, divergente: false }), null);
});

test('verifOf: junta o selo do motor com o CI que o vigia gravou (cada um na sua chave)', () => {
  const c = pure();
  assert.equal(c.verifOf({ spec: {} }), null);
  assert.deepEqual(J(c.verifOf({ spec: { ciGate: { rounds: 1, ci: { total: 2, fail: 1, pending: 0 } } } })), { tests: null, divergente: false, ci: { total: 2, fail: 1, pending: 0 } });
  const v = J(c.verifOf({ spec: { verification: { tests: { ran: true, ok: true, passed: 1, failed: 0 }, ci: null, divergente: false }, ciGate: { ci: { total: 1, fail: 0, pending: 0 } } } }));
  assert.equal(v.ci.total, 1);
  assert.equal(v.tests.passed, 1);
});

test('ciGateDecide: pendente espera; verde assenta; vermelho devolve até 2 voltas; a 3ª pergunta; mesmo commit não repete; teto pergunta', () => {
  const c = pure();
  const T = (ciGate, status = 'review') => ({ id: 't', status, prUrl: 'u', spec: { ciGate } });
  const I = (o) => Object.assign({ exists: true, state: 'OPEN', checksTotal: 4, checksFail: 0, checksPending: 0, failingChecks: [], headSha: 'a1' }, o);
  assert.equal(c.ciGateDecide(T(null), I({ checksPending: 2 })).act, 'wait');
  assert.equal(c.ciGateDecide(T(null), I({})).act, 'green');
  assert.equal(c.ciGateDecide(T(null), I({ state: 'MERGED' })).act, 'stop');
  assert.equal(c.ciGateDecide(T(null), { exists: false }).act, 'stop');
  assert.equal(c.ciGateDecide(T(null), I({ checksTotal: 0 })).act, 'stop', 'repo sem CI: nada a vigiar');
  const r1 = J(c.ciGateDecide(T(null), I({ checksFail: 1, failingChecks: ['test'] })));
  assert.deepEqual([r1.act, r1.round, r1.key], ['return', 1, 'a1']);
  assert.equal(c.ciGateDecide(T({ rounds: 1, lastSha: 'a1' }), I({ checksFail: 1 })).act, 'idle', 'a mesma falha não volta duas vezes');
  assert.equal(c.ciGateDecide(T({ rounds: 1, lastSha: 'a1' }), I({ checksFail: 1, headSha: 'b2' })).round, 2);
  assert.equal(c.ciGateDecide(T({ rounds: 2, lastSha: 'b2' }), I({ checksFail: 1, headSha: 'c3' })).act, 'ask', 'a 3ª falha vira pergunta');
  assert.equal(c.ciGateDecide(T({ rounds: 2, lastSha: 'c3', asked: true }), I({ checksFail: 1, headSha: 'c3' })).act, 'idle');
  assert.equal(c.ciGateDecide(T(null, 'running'), I({ checksFail: 1 })).act, 'wait', 'o agente está mexendo: espera');
  assert.equal(c.ciGateDecide(T(null), I({ checksFail: 1 }), { overBudget: true }).why, 'teto');
  assert.equal(c.ciGateDecide(T(null), I({ checksFail: 1, headSha: '', failingChecks: ['lint'] })).key, 'lint', 'sem headRefOid: a chave são os nomes');
});

test('ciWatchShould: só tarefa em revisão com PR; 60 s enquanto pendente; 10 min assentado; mudou de status → confere', () => {
  const c = pure();
  const t = { id: 't', status: 'review', prUrl: 'u' };
  assert.equal(c.ciWatchShould(t, null, 0), true);
  assert.equal(c.ciWatchShould({ ...t, prUrl: '' }, null, 0), false);
  assert.equal(c.ciWatchShould({ ...t, status: 'running' }, null, 0), false);
  assert.equal(c.ciWatchShould(t, { at: 0, st: 'review', pending: true }, 30_000), false);
  assert.equal(c.ciWatchShould(t, { at: 0, st: 'review', pending: true }, 60_000), true);
  assert.equal(c.ciWatchShould(t, { at: 0, st: 'review', pending: false }, 60_000), false, 'assentado: não martela o gh');
  assert.equal(c.ciWatchShould(t, { at: 0, st: 'review', pending: false }, 11 * 60_000), true);
  assert.equal(c.ciWatchShould(t, { at: 0, st: 'running', pending: false }, 1000), true, 'voltou pra revisão depois do ajuste');
});

test('ciReturnText: nome do check, a volta e as últimas linhas do log', () => {
  const c = pure();
  const tx = c.ciReturnText(['test', 'lint'], 'erro na linha 3\nFAIL', 1);
  assert.match(tx, /^O CI do PR falhou: test, lint \(volta automática 1 de 2\)\./);
  assert.match(tx, /gh run view --log-failed\):\n```\nerro na linha 3\nFAIL\n```$/);
  assert.doesNotMatch(c.ciReturnText([], '', 2), /```/, 'sem log: vai só o nome');
  assert.match(c.ciAskText(['test'], 'voltas'), /depois de 2 voltas automáticas · decida/);
  assert.match(c.ciAskText(['test'], 'teto'), /teto de custo/);
});

// ---------------------------------------------------------------- o vigia inteiro, com o gh simulado

function harness(o = {}) {
  const calls = [];
  const gh = { sha: 'a1', fail: [], pending: 0, runs: ['901'] }; // o "GitHub" que o pr_status (simulado) lê
  const task = { id: 't1', title: 'Soma', status: 'review', prUrl: 'https://github.com/o/r/pull/7', spec: {} };
  const invoke = async (cmd, args) => {
    calls.push([cmd, J(args)]);
    if (cmd === 'pr_status') return { exists: true, state: 'OPEN', number: 7, headSha: gh.sha, checksTotal: 3, checksFail: gh.fail.length, checksPending: gh.pending, failingChecks: [...gh.fail], failingRuns: gh.fail.length ? gh.runs : [] };
    if (cmd === 'pr_ci_log') return Array.from({ length: 80 }, (_, i) => `log ${i + 1}`).slice(-60).join('\n');
    if (cmd === 'patch_task_spec') { task.spec = Object.assign({}, task.spec, args.patch); return null; }
    if (cmd === 'mark_task_status') { task.status = args.status; return null; }
    if (cmd === 'rework_task') { task.status = 'running'; return null; }
    throw new Error('comando inesperado: ' + cmd);
  };
  const c = {
    console, state: { tasks: [task] }, lastSig: '', esc, escA: esc,
    invoke, invokeQuiet: invoke, refresh: async () => {}, toast: () => {}, showErr: (e) => { throw e; }, pushNotif: () => calls.push(['notif']),
    stColor: () => 'var(--st-done)', tickLoop: () => {},
    budgetOf: () => o.cap || 0, taskCost: () => ({ usd: o.spent || 0 }),
    loadPr: async (id) => invoke('pr_status', { taskId: id }),
    Date: { now: () => c.__now }, __now: 1_000_000,
  };
  vm.createContext(c);
  vm.runInContext(src, c);
  const tick = async (advance = 61_000) => { c.__now += advance; await vm.runInContext('ciWatchTick()', c); };
  return { c, gh, task, calls, tick, n: (cmd) => calls.filter((x) => x[0] === cmd).length };
}

test('vigia: 2 voltas automáticas com o log; a 3ª falha vira "precisa de você" e não volta mais sozinha', async () => {
  const h = harness();
  // CI rodando: só olha (a cada 60 s), não faz nada
  h.gh.pending = 2;
  await h.tick();
  assert.equal(h.n('pr_status'), 1);
  assert.equal(h.n('rework_task'), 0);
  // check vermelho → volta 1, com o nome do check e as últimas 60 linhas do log
  h.gh.pending = 0; h.gh.fail = ['test'];
  await h.tick();
  const rw = h.calls.filter((x) => x[0] === 'rework_task');
  assert.equal(rw.length, 1);
  assert.match(rw[0][1].text, /O CI do PR falhou: test \(volta automática 1 de 2\)/);
  assert.match(rw[0][1].text, /log 21\nlog 22/);
  assert.match(rw[0][1].text, /log 80\n```$/);
  assert.equal(h.task.spec.ciGate.rounds, 1);
  assert.deepEqual(h.calls.find((x) => x[0] === 'pr_ci_log')[1], { runId: '901' });
  // o agente está corrigindo: o vigia não olha tarefa rodando
  await h.tick();
  assert.equal(h.n('pr_status'), 2);
  // terminou o ajuste com push novo (sha b2) que falha de novo → volta 2
  h.task.status = 'review'; h.gh.sha = 'b2';
  await h.tick();
  assert.equal(h.n('rework_task'), 2);
  assert.equal(h.task.spec.ciGate.rounds, 2);
  // 3ª falha (sha c3) → pergunta pra pessoa, status needs-you, NÃO devolve
  h.task.status = 'review'; h.gh.sha = 'c3';
  await h.tick();
  assert.equal(h.n('rework_task'), 2, 'no máximo 2 voltas automáticas');
  assert.equal(h.task.status, 'needs-you');
  assert.equal(h.task.spec.needsYou.kind, 'ci');
  assert.match(h.task.spec.needsYou.text, /depois de 2 voltas automáticas/);
  assert.equal(h.n('notif'), 1);
  // a pessoa deixa como está (volta pra revisão): a mesma falha não reabre nada sozinha
  h.task.status = 'review';
  for (let i = 0; i < 3; i++) await h.tick(11 * 60_000);
  assert.equal(h.n('rework_task'), 2);
  assert.equal(h.n('mark_task_status'), 1);
});

test('vigia: teto de custo estourado vira pergunta (não gasta sozinho); CI verde grava o selo e para de olhar', async () => {
  const h = harness({ cap: 1, spent: 1.2 });
  h.gh.fail = ['build'];
  await h.tick();
  assert.equal(h.n('rework_task'), 0);
  assert.equal(h.task.status, 'needs-you');
  assert.match(h.task.spec.needsYou.text, /teto de custo/);

  const g = harness();
  await g.tick();
  assert.deepEqual(J(g.task.spec.ciGate.ci), { total: 3, fail: 0, pending: 0 });
  await g.tick();
  assert.equal(g.n('pr_status'), 1, 'verde: não consulta de novo no minuto seguinte');
});
