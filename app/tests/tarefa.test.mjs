// Tela da Tarefa (R7): `node --test app/tests/tarefa.test.mjs`
// Extrai funções puras / com dependências injetadas de 20-workspace-tarefa.js num contexto vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
const grab = (re) => { const m = ws.match(re); assert.ok(m, 'trecho não achado: ' + re); return m[0]; };
const fn = (name) => grab(new RegExp('(async )?function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));
const line = (name) => grab(new RegExp('function ' + name + '\\([^)]*\\)\\{[^\\n]*\\n'));

function ctxWith(extra) {
  const calls = [];
  const ctx = {
    calls, state: { tasks: [], pending: [] }, fwTask: null, fwAgentSel: null, lastSig: 'x',
    ACTIVE_ST: new Set(['running', 'queued']), commitsCache: {}, prCache: {}, artifactsCache: {}, reqProofCache: {},
    PHASES: ['Descoberta', 'Despacho', 'Execução', 'Revisão', 'PR'],
    IC: { bolt: '<i>b</i>', ai: '<i>a</i>' },
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escA: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    pendingOf: (id) => ctx.state.pending.filter((p) => p.taskId === id),
    invoke: async (cmd, args) => { calls.push([cmd, args]); if (ctx.failOn === cmd) throw new Error('falhou ' + cmd); return null; },
    resolvePending: async (id, ans) => { calls.push(['resolvePending', id, ans]); if (ctx.failOn === 'resolvePending') throw new Error('x'); },
    stopTask: async (id) => { calls.push(['stopTask', id]); },
    refresh: async () => {}, renderWorkspace: () => {}, fwPaintThread: () => {}, fwTaskObj: () => null,
    showErr: (e, m) => calls.push(['showErr', m]), console,
    ...extra,
  };
  vm.createContext(ctx);
  return ctx;
}

test('envio programático com o agente TRABALHANDO vai na fila — não para o turno', async () => {
  const c = ctxWith();
  vm.runInContext('const fwAskSent={}; const fwOptim={};\n' + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwOptim=fwOptim;', c);
  c.state.tasks = [{ id: 't1', status: 'running', busy: true }];
  const ok = await c.fwSendText('t1', '/revisar o requisito X');
  assert.equal(ok, true);
  assert.ok(!c.calls.some((x) => x[0] === 'stopTask'), 'não pode parar o turno em curso');
  assert.deepEqual(c.calls.find((x) => x[0] === 'talk_task')[1].message, '/revisar o requisito X');
  assert.equal(c.fwOptim.t1[0].st, 'fila', 'a bolha diz que está na fila');
});

test('envio programático que falha devolve false e tira a bolha otimista', async () => {
  const c = ctxWith({ failOn: 'talk_task' });
  vm.runInContext('const fwAskSent={}; const fwOptim={};\n' + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwOptim=fwOptim;', c);
  c.state.tasks = [{ id: 't1', status: 'review' }];
  assert.equal(await c.fwSendText('t1', 'aplique a correção'), false);
  assert.equal(c.fwOptim.t1.length, 0);
  assert.ok(c.calls.some((x) => x[0] === 'showErr'));
});

test('pergunta aberta: responde UMA vez; a 2ª mensagem vira conversa (não 2ª resposta)', async () => {
  const c = ctxWith();
  vm.runInContext('const fwAskSent={}; const fwOptim={};\n' + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwAskSent=fwAskSent;', c);
  c.state.tasks = [{ id: 't1', status: 'running' }];
  c.state.pending = [{ id: 9, taskId: 't1', prompt: '?' }];
  await c.fwSendText('t1', 'sim');
  await c.fwSendText('t1', 'e mais uma coisa');
  assert.equal(c.calls.filter((x) => x[0] === 'resolvePending').length, 1);
  assert.equal(c.fwAskSent[9], 'sim');
  assert.equal(c.calls.filter((x) => x[0] === 'talk_task').length, 1);
});

test('tarefa pausada pelo TETO (pergunta aberta) não é retomada antes da resposta', async () => {
  const c = ctxWith();
  vm.runInContext('const fwAskSent={}; const fwOptim={};\n' + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwOptim=fwOptim;', c);
  c.state.tasks = [{ id: 't1', status: 'paused', busy: true }];
  c.state.pending = [{ id: -5, taskId: 't1', kind: 'budget' }];
  await c.fwSendText('t1', 'Parar aqui');
  assert.ok(!c.calls.some((x) => x[0] === 'resume_task'), 'responder "parar" não pode retomar o agente');
  assert.equal(c.fwOptim.t1.length, 0, 'pergunta sintética: a bolha sai na hora (não há evento pra confirmá-la)');
});

test('fase: erro/abortada ficam em Execução; plano em Despacho; conflito em Revisão', () => {
  const c = ctxWith();
  vm.runInContext(fn('taskPhase') + '\nthis.taskPhase=taskPhase;', c);
  assert.equal(c.taskPhase({ status: 'error' }), 3);
  assert.equal(c.taskPhase({ status: 'aborted' }), 3);
  assert.equal(c.taskPhase({ status: 'plan-review' }), 2);
  assert.equal(c.taskPhase({ status: 'conflict' }), 4);
  assert.equal(c.taskPhase({ status: 'draft' }), 1);
  assert.equal(c.taskPhase({ status: 'review', prUrl: 'https://x/pull/1' }), 5);
});

test('caminho no cabeçalho: pasta separada do nome (o nome nunca é o que corta)', () => {
  const c = ctxWith();
  vm.runInContext(line('fwPathHtml') + '\nthis.fwPathHtml=fwPathHtml;', c);
  const h = c.fwPathHtml('src/pages/checkout/index.tsx');
  assert.match(h, /<span class="fwmdir">src\/pages\/checkout\/<\/span><span class="fwmname">index\.tsx<\/span>/);
  assert.match(c.fwPathHtml('README.md'), /^<span class="fwmpath mono" title="README.md"><span class="fwmname">README\.md<\/span><\/span>$/);
});

test('PR bloqueado oferece a saída: conflito → resolver com IA; checagens → pedir correção', () => {
  const c = ctxWith();
  vm.runInContext(fn('fwPrUnblockHtml') + '\nthis.f=fwPrUnblockHtml;', c);
  assert.match(c.f({ state: 'OPEN', mergeable: 'CONFLICTING' }), /id="prPgResolve"/);
  assert.match(c.f({ state: 'OPEN', mergeable: 'MERGEABLE', checksFail: 2 }), /id="prPgFixChecks"/);
  assert.equal(c.f({ state: 'OPEN', mergeable: 'MERGEABLE' }), '');
  assert.equal(c.f({ state: 'MERGED', mergeable: 'CONFLICTING' }), '');
});

test('nota de sistema com link vira link clicável (e escapa o resto)', () => {
  const c = ctxWith();
  vm.runInContext(line('fwLinkify') + '\nthis.f=fwLinkify;', c);
  const h = c.f('PR aberto: https://github.com/lojinha/loja/pull/42. <b>');
  assert.match(h, /data-ext="https:\/\/github\.com\/lojinha\/loja\/pull\/42"/);
  assert.match(h, />github\.com\/lojinha\/loja\/pull\/42<\/a>\. &lt;b&gt;$/);
});
