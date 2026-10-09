// Pedidos de épico do terminal (49-epico-pedidos): `node --test app/tests/epico-pedidos.test.mjs`
// Carrega 47-edicoes-agente + 49-epico-pedidos num vm com a nuvem e o motor FALSOS: criar épico, vincular/desvincular
// tarefas existentes (cartão + spec local, sem recriar), sem login/time = recusa honesta, idempotência e o tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src47 = readFileSync(new URL('../src/js/47-edicoes-agente.js', import.meta.url), 'utf8');
const src49 = readFileSync(new URL('../src/js/49-epico-pedidos.js', import.meta.url), 'utf8');
const EP = '11111111-2222-3333-4444-555555555555', EP2 = '22222222-2222-3333-4444-555555555555';
const CARD = 'aaaaaaaa-0000-0000-0000-000000000001', NEWCARD = 'aaaaaaaa-0000-0000-0000-000000000009', PROJ = 'bbbbbbbb-0000-0000-0000-000000000001';

function load(extra = {}) {
  const calls = [];
  const ctx = {
    console, JSON, Date, Math, Set, String, Array, Object, RegExp, Number, Promise, CSS: { escape: (s) => s }, encodeURIComponent,
    IC: {}, esc: (s) => String(s ?? ''), escA: (s) => String(s ?? ''), agoTx: () => '', tickLoop: () => {}, document: { addEventListener: () => {} }, window: {},
    state: { repo: '/r', tasks: [
      { id: 't-run', title: 'Tarefa rodando', status: 'running', busy: true },
      { id: 't-draft', title: 'Rascunho', status: 'draft', objective: 'o', requirements: ['r'], deliverables: [] },
    ], events: [] },
    SB: { sess: () => ({ access_token: 'x' }) }, cloudTeamId: () => 't1', cloudUserId: () => 'u1', cloudData: { meRole: 'member' }, tmName: () => 'Douglas',
    cloudEnsureProject: async () => ({ id: PROJ }), cloudScopeOk: () => true, tmapForeign: () => new Set(),
    tmapM: { 't-run': CARD }, toast: (m, k) => calls.push(['toast', m, k]), teamTasks: [], teamEpics: [], teamPaintSig: '', renderTeamBoard: () => {}, epTab: null,
    ACTIVE_ST: new Set(['running']), lastSig: 'x', refresh: async () => calls.push(['refresh']), taskCost: () => ({ usd: 0, tok: 0 }),
    calls, epics: [], cards: {}, failPost: null,
    ...extra,
  };
  ctx.tmap = () => ctx.tmapM;
  ctx.tmapSet = (l, c) => { ctx.tmapM = { ...ctx.tmapM, [l]: c }; calls.push(['tmapSet', l, c]); };
  ctx.sbGet = async (q) => {
    calls.push(['get', q]);
    if (q.startsWith('epics?')) {
      if (q.includes('requestId=eq.')) { const id = decodeURIComponent(q.split('requestId=eq.')[1]); return ctx.epics.filter((e) => e.spec && e.spec.requestId === id); }
      if (q.includes('&id=eq.') || q.includes('?select=id,name,spec,status,team_id&id=eq.') || /[?&]id=eq\./.test(q)) { const id = decodeURIComponent(q.split('id=eq.')[1].split('&')[0]); return ctx.epics.filter((e) => e.id === id); }
      return ctx.epics.filter((e) => e.team_id === 't1');
    }
    if (q.startsWith('tasks?')) {
      const all = Object.values(ctx.cards);
      if (q.includes('epic_id=eq.')) { const id = decodeURIComponent(q.split('epic_id=eq.')[1].split('&')[0]); return all.filter((c) => c.epic_id === id); }
      if (q.includes('local_id=eq.')) { const l = decodeURIComponent(q.split('local_id=eq.')[1].split('&')[0]); return all.filter((c) => c.local_id === l); }
      const id = decodeURIComponent(q.split('id=eq.')[1].split('&')[0]); return all.filter((c) => c.id === id);
    }
    return [];
  };
  ctx.sbPost = async (t, b) => {
    calls.push(['post', t, b]);
    if (ctx.failPost && t === 'epics') throw ctx.failPost;
    if (t === 'epics') { const row = { id: EP2, team_id: b.team_id, name: b.name, spec: b.spec, created_by: b.created_by }; ctx.epics.push(row); return [row]; }
    return [{}];
  };
  ctx.sbFetch = async (path, opts) => {
    const body = JSON.parse(opts.body); calls.push([opts.method, path, body]);
    if (path.includes('on_conflict')) { ctx.cards[NEWCARD] = { id: NEWCARD, local_id: body.local_id, project_id: body.project_id, title: body.title, status: body.status, epic_id: body.epic_id }; return []; }
    const id = decodeURIComponent(path.split('id=eq.')[1]); if (ctx.cards[id]) Object.assign(ctx.cards[id], body); return [{}];
  };
  ctx.invoke = async (cmd, a) => { calls.push([cmd, a]); if (cmd === 'epic_link_cli') return JSON.stringify({ ok: true, mode: 'applied', message: 'ok' }); return null; };
  ctx.invokeQuiet = async (cmd, a) => { calls.push([cmd, a]); if (cmd === 'epic_requests_pending') return ctx.pending || []; return null; };
  vm.createContext(ctx);
  vm.runInContext(src47 + '\n' + src49 + '\nthis.api={ erValidate, erPickEpic, erEpicSpec, erApplyOne, erTick, ER_NO_LOGIN, ER_NO_TEAM, erRetry };', ctx);
  return ctx;
}
const NOW = new Date().toISOString();
const by = { agent: 'Orion', taskId: 't-run', taskTitle: 'Tarefa rodando', role: 'builder' };
const req = (kind, x = {}) => ({ id: 'req-1', key: 'k', kind, at: NOW, by, tasks: [], ...x });
const J = (x) => JSON.parse(JSON.stringify(x));
const names = (calls) => calls.map((c) => c[0]);

test('validação do pedido: tipo, autor, papel, ids, título, segredo, alvo do link', () => {
  const { api } = load();
  assert.equal(api.erValidate(req('create', { epic: { title: 'Arquitetura' } })), null);
  assert.match(api.erValidate(req('apagar')), /desconhecido/);
  assert.match(api.erValidate(req('create', { epic: { title: 'x' }, by: { ...by, role: 'reviewer' } })), /papel/);
  assert.match(api.erValidate(req('create', { epic: { title: ' ' } })), /título/);
  assert.match(api.erValidate(req('create', { epic: { title: 'x', description: 'senha: abcdefghijkl' } })), /segredo/);
  assert.match(api.erValidate(req('link', { epicId: 'nao-uuid', tasks: [{ localId: 't' }] })), /uuid/);
  assert.match(api.erValidate(req('link', { tasks: [{ localId: 't' }] })), /qual épico/);
  assert.match(api.erValidate(req('link', { epicId: EP, tasks: [] })), /quais tarefas/);
  assert.match(api.erValidate(req('link', { epicId: EP, tasks: [{ cloudId: '../x' }] })), /cartão inválido/);
  assert.match(api.erValidate(req('unlink', { tasks: [{}] })), /sem id/);
});

test('SEM LOGIN / SEM TIME: recusa com a frase do que fazer e não toca na nuvem nem na tarefa', async () => {
  for (const [extra, msg] of [[{ SB: { sess: () => null } }, /não está logado.*Entre na sua conta/], [{ cloudTeamId: () => '' }, /sem time escolhido.*Escolha um time/]]) {
    const c = load(extra);
    const r = await c.api.erApplyOne(req('create', { epic: { title: 'X' }, tasks: [{ ref: 't-run', localId: 't-run', title: 'Tarefa rodando' }] }));
    assert.equal(r.ok, false); assert.equal(r.status, 'refused'); assert.match(r.message, msg); assert.match(r.message, /Nada foi criado/);
    assert.ok(!names(c.calls).some((n) => ['post', 'PATCH', 'POST', 'epic_link_cli'].includes(n)), 'nada foi feito');
  }
});

test('CRIAR + vincular: épico no time (D1.., requestId), cartão existente PATCH, rascunho sem cartão PUBLICADO no épico, contexto ANTES da spec local', async () => {
  const c = load();
  c.cards[CARD] = { id: CARD, local_id: 't-run', project_id: PROJ, title: 'Tarefa rodando', status: 'running', epic_id: null };
  const r = await c.api.erApplyOne(req('create', { epic: { title: 'Arquitetura do user_cases', outcome: 'quem usa vê X', doneWhen: ['login ok', 'logout ok'] },
    tasks: [{ ref: 't-run', localId: 't-run', title: 'Tarefa rodando' }, { ref: 'Rascunho', localId: 't-draft', title: 'Rascunho' }] }));
  assert.equal(r.status, 'done', r.message);
  assert.equal(r.epicId, EP2);
  assert.match(r.message, /criado no time e 2 tarefa\(s\) vinculada/);
  const post = c.calls.find((x) => x[0] === 'post' && x[1] === 'epics')[2];
  assert.equal(post.team_id, 't1'); assert.equal(post.created_by, 'u1'); assert.equal(post.name, 'Arquitetura do user_cases');
  assert.deepEqual(J(post.spec.doneWhen), [{ id: 'D1', text: 'login ok' }, { id: 'D2', text: 'logout ok' }]);
  assert.equal(post.spec.requestId, 'req-1');
  assert.equal(c.cards[CARD].epic_id, EP2, 'cartão existente mudou de épico');
  assert.equal(c.cards[NEWCARD].epic_id, EP2, 'rascunho virou cartão já no épico');
  assert.equal(c.cards[NEWCARD].status, 'draft', 'status real, nada reiniciado');
  assert.ok(c.calls.some((x) => x[0] === 'tmapSet' && x[1] === 't-draft'));
  const iCtx = c.calls.findIndex((x) => x[0] === 'write_epic_context'), iLink = c.calls.findIndex((x) => x[0] === 'epic_link_cli');
  assert.ok(iCtx >= 0 && iLink > iCtx, 'contexto do épico gravado antes da spec local');
  const links = c.calls.filter((x) => x[0] === 'epic_link_cli').map((x) => x[1]);
  assert.deepEqual(links.map((a) => a.taskId), ['t-run', 't-draft']);
  assert.equal(links[0].epicId, EP2);
  assert.deepEqual(J(links[0].doneWhen), ['D1: login ok', 'D2: logout ok']);
  assert.ok(!c.calls.some((x) => /new_task|start_task|talk/.test(x[0])), 'nenhuma tarefa recriada/iniciada');
});

test('criar é IDEMPOTENTE: o app caiu depois do insert → reaproveita o épico do mesmo pedido', async () => {
  const c = load();
  c.epics.push({ id: EP, team_id: 't1', name: 'Já criado', spec: { requestId: 'req-1' } });
  const r = await c.api.erApplyOne(req('create', { epic: { title: 'Já criado' } }));
  assert.equal(r.epicId, EP);
  assert.ok(!c.calls.some((x) => x[0] === 'post' && x[1] === 'epics'));
});

test('VINCULAR por nome: ambíguo/inexistente recusa listando; achado troca o cartão; cartão de outro projeto falha só ele', async () => {
  const c = load();
  c.epics.push({ id: EP, team_id: 't1', name: 'Arquitetura do user_cases' }, { id: EP2, team_id: 't1', name: 'Outro' });
  const none = await c.api.erApplyOne(req('link', { epicTitle: 'Nada', tasks: [{ ref: 't-run', localId: 't-run' }] }));
  assert.equal(none.status, 'refused'); assert.match(none.message, /não achei o épico "Nada".*Arquitetura do user_cases/s);
  c.cards[CARD] = { id: CARD, local_id: 't-run', project_id: PROJ, title: 'Tarefa rodando', status: 'running', epic_id: EP2 };
  c.cards['cccccccc-0000-0000-0000-000000000001'] = { id: 'cccccccc-0000-0000-0000-000000000001', local_id: 'card-x', project_id: 'outro', title: 'De fora', status: 'backlog', epic_id: null };
  const r = await c.api.erApplyOne(req('link', { epicTitle: 'arquitetura do USER_CASES', tasks: [{ ref: 't-run', localId: 't-run', title: 'Tarefa rodando' }, { ref: 'cccccccc-0000-0000-0000-000000000001', cloudId: 'cccccccc-0000-0000-0000-000000000001' }] }));
  assert.equal(r.status, 'partial'); assert.equal(r.ok, true);
  assert.equal(c.cards[CARD].epic_id, EP, 'movido do Outro pro Arquitetura');
  assert.match(r.failed[0].why, /outro projeto/);
  assert.match(r.message, /Nada foi recriado nem reiniciado/);
  const dup = load(); dup.epics.push({ id: EP, team_id: 't1', name: 'A' }, { id: EP2, team_id: 't1', name: 'a' });
  assert.match((await dup.api.erApplyOne(req('link', { epicTitle: 'A', tasks: [{ localId: 't-run' }] }))).message, /mais de um épico/);
  const foreign = load(); foreign.epics.push({ id: EP, team_id: 'OUTRO', name: 'X' });
  assert.match((await foreign.api.erApplyOne(req('link', { epicId: EP, tasks: [{ localId: 't-run' }] }))).message, /outro time/);
});

test('DESVINCULAR: cartão sai do épico e a spec local é limpa (epicId null)', async () => {
  const c = load();
  c.cards[CARD] = { id: CARD, local_id: 't-run', project_id: PROJ, title: 'Tarefa rodando', status: 'running', epic_id: EP };
  const r = await c.api.erApplyOne(req('unlink', { tasks: [{ ref: 't-run', localId: 't-run', title: 'Tarefa rodando' }] }));
  assert.equal(r.status, 'done'); assert.match(r.message, /tirada\(s\) do épico/);
  assert.equal(c.cards[CARD].epic_id, null);
  const l = c.calls.find((x) => x[0] === 'epic_link_cli')[1];
  assert.equal(l.epicId, null);
});

test('tick: grava o resultado; erro de rede fica na fila e desiste com motivo depois de 5 voltas; permissão negada recusa na hora', async () => {
  const c = load({ pending: [req('create', { epic: { title: 'X' } })] });
  await c.api.erTick();
  const done = c.calls.find((x) => x[0] === 'epic_request_done');
  assert.equal(done[1].id, 'req-1'); assert.equal(JSON.parse(done[1].result).ok, true);
  assert.ok(c.calls.some((x) => x[0] === 'write_team_epics'), 'lista dos épicos do time pro `cardume epic list`');
  const net = load({ pending: [req('create', { epic: { title: 'X' } })], failPost: new Error('Failed to fetch') });
  for (let i = 0; i < 4; i++) await net.api.erTick();
  assert.ok(!net.calls.some((x) => x[0] === 'epic_request_done'), 'transitório: espera');
  await net.api.erTick();
  const gave = JSON.parse(net.calls.find((x) => x[0] === 'epic_request_done')[1].result);
  assert.equal(gave.ok, false); assert.match(gave.message, /desisti depois de 5/);
  const rls = load({ pending: [req('create', { epic: { title: 'X' } })], failPost: new Error('HTTP 403: new row violates row-level security policy') });
  await rls.api.erTick();
  assert.equal(JSON.parse(rls.calls.find((x) => x[0] === 'epic_request_done')[1].result).status, 'refused');
  const nolog = load({ pending: [req('create', { epic: { title: 'X' } })], SB: { sess: () => null } });
  await nolog.api.erTick();
  assert.match(JSON.parse(nolog.calls.find((x) => x[0] === 'epic_request_done')[1].result).message, /não está logado/);
});

test('RLS que filtra o PATCH (200 com zero linhas) NÃO vira "vinculada"; pedido velho expira; tudo igual = "nada mudou"; rascunho publicado é dito', async () => {
  const c = load();
  c.cards[CARD] = { id: CARD, local_id: 't-run', project_id: PROJ, title: 'Tarefa rodando', status: 'running', epic_id: null };
  c.epics.push({ id: EP, team_id: 't1', name: 'Arq' });
  const real = c.sbFetch; c.sbFetch = async (p, o) => (o.method === 'PATCH' ? [] : real(p, o));
  const r = await c.api.erApplyOne(req('link', { epicId: EP, tasks: [{ ref: 't-run', localId: 't-run', title: 'Tarefa rodando' }] }));
  assert.equal(r.status, 'refused'); assert.match(r.failed[0].why, /permissão/);
  assert.ok(!c.calls.some((x) => x[0] === 'epic_link_cli'), 'spec local não muda se a nuvem não mudou');
  const old = load();
  const ex = await old.api.erApplyOne(req('create', { at: new Date(Date.now() - 4 * 86400000).toISOString(), epic: { title: 'X' } }));
  assert.equal(ex.status, 'refused'); assert.match(ex.message, /expirou/);
  assert.ok(!old.calls.some((x) => x[0] === 'post'));
  const same = load(); same.epics.push({ id: EP, team_id: 't1', name: 'Arq' });
  same.cards[CARD] = { id: CARD, local_id: 't-run', project_id: PROJ, title: 'Tarefa rodando', status: 'running', epic_id: EP };
  same.invoke = async (cmd, a) => { same.calls.push([cmd, a]); return JSON.stringify({ ok: true, mode: 'unchanged', message: 'já' }); };
  const u = await same.api.erApplyOne(req('link', { epicId: EP, tasks: [{ ref: 't-run', localId: 't-run' }] }));
  assert.match(u.message, /nada mudou — a tarefa já estava neste épico/);
  const pub = load(); pub.epics.push({ id: EP, team_id: 't1', name: 'Arq' });
  const p = await pub.api.erApplyOne(req('link', { epicId: EP, tasks: [{ ref: 'Rascunho', localId: 't-draft', title: 'Rascunho' }] }));
  assert.equal(p.linked[0].mode, 'published');
  const titleObj = load();
  assert.match(titleObj.api.erValidate(req('create', { epic: { title: { x: 1 } } })), /sem título/);
});

test('tick: lista dos épicos no formato que o `cardume epic list` lê; recado ao agente SÓ depois do tempo que ele esperou; troca de projeto no meio para', async () => {
  const c = load({ pending: [req('create', { epic: { title: 'X' }, waitMs: 0 })], teamTasks: [{ epic_id: EP }, { epic_id: EP }] });
  c.epics.push({ id: EP, team_id: 't1', name: 'Arq', status: 'open' });
  await c.api.erTick();
  const lists = c.calls.filter((x) => x[0] === 'write_team_epics').map((x) => JSON.parse(x[1].json));
  const l = lists[0]; // a 1ª volta (antes do refresh do quadro zerar teamTasks)
  assert.ok(l.at);
  assert.deepEqual(J(l.epics.find((e) => e.id === EP)), { id: EP, name: 'Arq', status: 'open', tasks: 2 });
  const ins = c.calls.find((x) => x[0] === 'add_instruction');
  assert.ok(ins, 'o agente que pediu (rodando) e já não espera recebe o desfecho');
  assert.match(ins[1].text, /req-1.*EXECUTADO/);
  const fresh = load({ pending: [req('create', { epic: { title: 'X' }, waitMs: 60000 })] });
  await fresh.api.erTick();
  assert.ok(!fresh.calls.some((x) => x[0] === 'add_instruction'), 'quem ainda espera lê o resultado direto');
  const sw = load({ pending: [req('create', { epic: { title: 'X' } })] });
  const realPost = sw.sbPost; sw.sbPost = async (t, b) => { sw.state.repo = '/outro'; return realPost(t, b); };
  await sw.api.erTick();
  assert.ok(!sw.calls.some((x) => x[0] === 'epic_request_done'), 'resultado não vai pro projeto errado');
});

test('épico criado pelo terminal vai pro painel de Issues (trkPublishEpic) — vincular/desvincular não publicam', async () => {
  const pub = [];
  const c = load({ window: { trkPublishEpic: async (ep, rows) => { pub.push([ep.name, rows.length]); return { code: 'FND-1' }; } } });
  await c.api.erApplyOne(req('create', { epic: { title: 'Contas' } }));
  assert.deepEqual(pub, [['Contas', 0]]);
  c.epics.push({ id: EP, team_id: 't1', name: 'Arquitetura', spec: {} });
  await c.api.erApplyOne(req('link', { id: 'req-2', epicId: EP, tasks: [{ ref: 't-run', localId: 't-run', cloudId: CARD, title: 'Tarefa rodando' }] }));
  assert.equal(pub.length, 1);
});
