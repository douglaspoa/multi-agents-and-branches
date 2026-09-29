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

const ASK="const fwAskSent={}; const fwOptim={}; const fwRpGen={}, fwArtGen={};\n"+line('fwAskKey')+line('fwAskIsSent')+line('fwIsBudgetAsk')+line('fwInvalidate');

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
    showErr: (e, m) => calls.push(['showErr', m]), toast: (m, k) => calls.push(['toast', m, k]), console,
    ...extra,
  };
  vm.createContext(ctx);
  return ctx;
}

test('envio programático com o agente TRABALHANDO vai na fila — não para o turno', async () => {
  const c = ctxWith();
  vm.runInContext(ASK + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwOptim=fwOptim;', c);
  c.state.tasks = [{ id: 't1', status: 'running', busy: true }];
  const ok = await c.fwSendText('t1', '/revisar o requisito X');
  assert.equal(ok, true);
  assert.ok(!c.calls.some((x) => x[0] === 'stopTask'), 'não pode parar o turno em curso');
  assert.deepEqual(c.calls.find((x) => x[0] === 'talk_task')[1].message, '/revisar o requisito X');
  assert.equal(c.fwOptim.t1[0].st, 'fila', 'a bolha diz que está na fila');
});

test('envio programático que falha devolve false e tira a bolha otimista', async () => {
  const c = ctxWith({ failOn: 'talk_task' });
  vm.runInContext(ASK + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwOptim=fwOptim;', c);
  c.state.tasks = [{ id: 't1', status: 'review' }];
  assert.equal(await c.fwSendText('t1', 'aplique a correção'), false);
  assert.equal(c.fwOptim.t1.length, 0);
  assert.ok(c.calls.some((x) => x[0] === 'showErr'));
});

test('pergunta aberta: responde UMA vez; a 2ª mensagem vira conversa (não 2ª resposta)', async () => {
  const c = ctxWith();
  vm.runInContext(ASK + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwAskSent=fwAskSent;', c);
  c.state.tasks = [{ id: 't1', status: 'running' }];
  c.state.pending = [{ id: 9, taskId: 't1', prompt: '?' }];
  await c.fwSendText('t1', 'sim');
  await c.fwSendText('t1', 'e mais uma coisa');
  assert.equal(c.calls.filter((x) => x[0] === 'resolvePending').length, 1);
  assert.equal(c.fwAskSent['9|'], 'sim');
  assert.equal(c.calls.filter((x) => x[0] === 'talk_task').length, 1);
});

test('envio automático NUNCA responde a pergunta do teto de custo (não amplia o teto)', async () => {
  const c = ctxWith();
  vm.runInContext(ASK + fn('fwSendText') + '\nthis.fwSendText=fwSendText; this.fwOptim=fwOptim;', c);
  c.state.tasks = [{ id: 't1', status: 'paused', busy: true }];
  c.state.pending = [{ id: -5, taskId: 't1', kind: 'budget', createdAt: 1 }];
  assert.equal(await c.fwSendText('t1', 'Verifique AGORA cada requisito'), false);
  assert.ok(!c.calls.some((x) => ['resolvePending', 'talk_task', 'resume_task'].includes(x[0])), 'nada é enviado nem retomado');
  assert.match(c.calls.find((x) => x[0] === 'toast')[1], /teto de custo/);
  assert.equal((c.fwOptim.t1 || []).length, 0);
});

test('trava da resposta: chave id+criação e solta quando a pergunta sai do pending', () => {
  const c = ctxWith();
  vm.runInContext(ASK + line('fwAskPrune') + '\nthis.S=fwAskSent; this.k=fwAskKey; this.isSent=fwAskIsSent; this.prune=fwAskPrune;', c);
  const hit1 = { id: -5, taskId: 't1', createdAt: 100 }, hit2 = { id: -5, taskId: 't1', createdAt: 200 };
  c.state.pending = [hit1];
  c.S[c.k(hit1)] = '';
  assert.equal(c.isSent(hit1), true, 'resposta vazia também trava (== null)');
  assert.equal(c.isSent(hit2), false, 'o PRÓXIMO teto da mesma tarefa nasce destravado');
  c.prune(); assert.equal(c.isSent(hit1), true, 'ainda no pending: continua travada');
  c.state.pending = []; c.prune(); assert.equal(Object.keys(c.S).length, 0);
});

test('fwSendMsg: pergunta já respondida não conta → "na fila" com o agente trabalhando', async () => {
  const inp = { value: 'mais um detalhe', disabled: false, focus() {} };
  const c = ctxWith({ $id: (id) => (id === 'fwInput' ? inp : null), fwPend: {}, fwDraft: {}, fwAsReqOn: {}, fwPath: 'a.ts',
    fwSelRange: () => null, attPromptBlock: () => '', setTimeout, clearTimeout });
  vm.runInContext(ASK + fn('fwSendMsg') + '\nthis.fwSendMsg=fwSendMsg; this.fwOptim=fwOptim; this.S=fwAskSent;', c);
  const t = { id: 't1', status: 'running', busy: true };
  c.state.tasks = [t]; c.fwTaskObj = () => t;
  c.state.pending = [{ id: 9, taskId: 't1', createdAt: 5 }];
  vm.runInContext("fwAskSent['9|5']='sim'", c);
  await c.fwSendMsg(true);
  assert.ok(!c.calls.some((x) => x[0] === 'resolvePending'), 'não vira 2ª resposta');
  assert.equal(c.fwOptim.t1[0].st, 'fila');
});

test('provas/artefatos: invalidação durante a carga descarta o resultado velho e busca de novo', async () => {
  let resolve; let loads = 0;
  const c = ctxWith({ fwTask: 't1', fwVisible: () => true, fwRpLoading: {},
    loadReqProofs: (id) => { loads++; return new Promise((r) => { resolve = () => { c.reqProofCache[id] = { list: ['velho' + loads] }; r(); }; }); } });
  vm.runInContext(ASK + 'const fwRpLoading={};\n' + fn('fwReqProofsEnsure') + '\nthis.ensure=fwReqProofsEnsure; this.inval=fwInvalidate;', c);
  c.ensure('t1'); c.ensure('t1');
  assert.equal(loads, 1, 'uma carga em voo por tarefa');
  c.inval('t1');
  resolve(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads, 2, 'invalidada no meio → recarrega');
  assert.equal(c.reqProofCache.t1, undefined, 'o resultado velho não fica');
  resolve(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(c.reqProofCache.t1.list, ['velho2']);
});

test('budgetAnswer: pergunta que sumiu e falha do backend viram ERRO (a tela destrava)', async () => {
  const teto = readFileSync(new URL('../src/js/53-teto-protecao.js', import.meta.url), 'utf8');
  const m = teto.match(/async function budgetAnswer\([^)]*\)\{[\s\S]*?\n\}\n/); assert.ok(m);
  const c = ctxWith({ budgetBusy: new Set(), budgetQuiet: new Set(), budgetOf: () => 5, costCapDefault: () => 5, fmtCost: (x) => 'US$ ' + x, failOn: 'patch_task_spec' });
  vm.runInContext(m[0] + '\nthis.budgetAnswer=budgetAnswer;', c);
  await assert.rejects(c.budgetAnswer(-1, 'Continuar'), /já não está aberta/);
  c.state.pending = [{ id: -1, taskId: 't1' }]; c.state.tasks = [{ id: 't1', spec: { budgetHit: { cap: 5, usd: 5.2 } } }];
  await assert.rejects(c.budgetAnswer(-1, 'Continuar'), /falhou patch_task_spec/);
  assert.ok(!c.calls.some((x) => x[0] === 'showErr'), 'quem mostra o erro é quem respondeu (sem mensagem dupla)');
});

test('fase: erro/abortada ficam em Execução; plano em Despacho; conflito em Revisão', () => {
  const c = ctxWith();
  vm.runInContext(fn('taskPhase') + '\nthis.taskPhase=taskPhase;', c);
  assert.equal(c.taskPhase({ status: 'error' }), 3);
  assert.equal(c.taskPhase({ status: 'aborted' }), 3);
  assert.equal(c.taskPhase({ status: 'plan-review' }), 2);
  assert.equal(c.taskPhase({ status: 'queued' }), 2, 'queued está no ACTIVE_ST mas é Despacho');
  assert.equal(c.taskPhase({ status: 'running' }), 3);
  assert.equal(c.taskPhase({ status: 'conflict' }), 4);
  assert.equal(c.taskPhase({ status: 'draft' }), 1);
  assert.equal(c.taskPhase({ status: 'review', prUrl: 'https://x/pull/1' }), 5);
});

test('caminho no cabeçalho: pasta separada do nome (o nome nunca é o que corta)', () => {
  const c = ctxWith();
  vm.runInContext(line('fwPathHtml') + '\nthis.fwPathHtml=fwPathHtml;', c);
  const h = c.fwPathHtml('src/pages/checkout/index.tsx');
  assert.match(h, /<span class="fwmdir">src\/pages\/checkout\/<\/span><span class="fwmname">index\.tsx<\/span>/);
  assert.match(c.fwPathHtml('docs/guia/'), /<span class="fwmname">guia<\/span>/, 'barra no fim não deixa o nome vazio');
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
  vm.runInContext(grab(/function fwLinkify\(tx\)\{[\s\S]*?return out\+esc\(s\.slice\(last\)\); \}\n/) + '\nthis.f=fwLinkify;', c);
  assert.match(c.f('ver https://x/y<b>'), /data-ext="https:\/\/x\/y">x\/y<\/a>&lt;b&gt;$/, 'a URL para no "<" do texto cru');
  const h = c.f('PR aberto: https://github.com/lojinha/loja/pull/42. <b>');
  assert.match(h, /data-ext="https:\/\/github\.com\/lojinha\/loja\/pull\/42"/);
  assert.match(h, />github\.com\/lojinha\/loja\/pull\/42<\/a>\. &lt;b&gt;$/);
});

test('eco otimista: ts ISO + só eventos depois do envio; texto fixo repetido não some na 2ª vez', () => {
  const core = readFileSync(new URL('../src/js/10-core.js', import.meta.url), 'utf8');
  const g = (re) => { const m = core.match(re); assert.ok(m); return m[0]; };
  const c = ctxWith();
  vm.runInContext(g(/function evIsUserMsg\(e\)\{[^\n]*\n/) + g(/function evUserText\(tx\)\{[^\n]*\n/) + 'const fwOptim={};\n' + fn('fwOptimFor') + '\nthis.O=fwOptim; this.f=fwOptimFor;', c);
  const t0 = Date.now();
  const ev1 = { agent: 'Você', text: 'Você: verificar requisitos', ts: new Date(t0 - 30000).toISOString() };
  c.O.t = [{ text: 'verificar requisitos', at: t0, st: 'enviada' }];
  assert.equal(c.f('t', [ev1]).length, 1, 'o evento do clique ANTERIOR (ISO, 30s antes) não confirma o novo');
  const ev2 = { agent: 'Você', text: 'Você: verificar requisitos', ts: new Date(t0 + 500).toISOString() };
  c.O.t = [{ text: 'verificar requisitos', at: t0, st: 'enviada' }, { text: 'verificar requisitos', at: t0 + 100, st: 'enviada' }];
  assert.equal(c.f('t', [ev1, ev2]).length, 1, 'um evento confirma UMA bolha');
});
