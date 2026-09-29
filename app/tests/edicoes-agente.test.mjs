// Edições de spec feitas por agentes (47-edicoes-agente): `node --test app/tests/edicoes-agente.test.mjs`
// Carrega o arquivo INTEIRO num vm com stubs — helpers puros (aplicar/propor/decidir/desfazer no épico e no
// cartão), o desenho do rastro, e o aplicador da fila (aeTick/aeApplyOne) com a nuvem e o motor falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/47-edicoes-agente.js', import.meta.url), 'utf8');
const EP = '11111111-2222-3333-4444-555555555555', CARD = 'aaaaaaaa-0000-0000-0000-000000000001', PROJ = 'bbbbbbbb-0000-0000-0000-000000000001';
function load(extra = {}) {
  const calls = [];
  const ctx = {
    console, JSON, Date, Math, Set, String, Array, Object, RegExp, Number, Promise, CSS: { escape: (s) => s },
    IC: { pencil: '<svg class="pen"></svg>', warn: '<svg class="w"></svg>', clock: '' },
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escA: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    agoTx: () => '5min', tickLoop: () => {}, document: { addEventListener: () => {} }, window: {},
    state: { repo: '/r', tasks: [{ id: 'autor', status: 'running', busy: true }], events: [] },
    SB: { sess: () => ({}) }, cloudTeamId: () => 't1', cloudUserId: () => 'u1', cloudData: { meRole: 'member' }, tmName: () => 'Douglas',
    cloudEnsureProject: async () => ({ id: PROJ }), tmap: () => ({}), toast: (m, k) => calls.push(['toast', m, k]),
    teamTasks: null, teamPaintSig: '', renderTeamBoard: () => {}, epTab: null, openTaskById: () => {}, ACTIVE_ST: new Set(['running']),
    calls, rows: {}, patchEmpty: 0, failGet: null,
    ...extra,
  };
  ctx.sbGet = async (q) => { calls.push(['get', q]); if (ctx.failGet) throw ctx.failGet; const k = Object.keys(ctx.rows).find((x) => q.includes(x)); return k ? [structuredClone(ctx.rows[k])] : []; };
  ctx.sbFetch = async (path, opts) => { calls.push(['patch', path, JSON.parse(opts.body)]); if (ctx.patchEmpty > 0) { ctx.patchEmpty--; return []; } return [{}]; };
  ctx.sbPost = async (t, b) => { calls.push(['post', t, b]); return [{}]; };
  ctx.invoke = async (cmd, a) => { calls.push([cmd, a]); if (cmd === 'task_edit_cli') return JSON.stringify({ ok: true, mode: ctx.cliMode || 'queued', message: 'ok' }); return null; };
  ctx.invokeQuiet = async (cmd, a) => { calls.push([cmd, a]); if (cmd === 'agent_edits_pending') return ctx.pending || []; return null; };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api={ aeValidate, aeApplyEpic, aeDecideEpic, aeUndoEpic, aeApplyCard, aeDecideCard, aeUndoCard, aeEventHtml, aeEpicHistHtml, aeEpicBadge, aeTick, aeApplyOne, aeWaiting, aeRetry };', ctx);
  return ctx;
}
const NOW = '2026-09-29T12:00:00.000Z';
const by = { agent: 'Orion', taskId: 'autor', taskTitle: 'Login', role: 'builder' };
const epicE = (epic, extra = {}) => ({ id: 'e-1', kind: 'epic', target: EP, epicId: EP, at: NOW, by, epic, note: 'SSO virou requisito', ...extra });
const cardE = (task, extra = {}) => ({ id: 'c-1', kind: 'card', target: CARD, epicId: EP, at: NOW, by, task: { note: 'SSO', ...task }, ...extra });
const J = (x) => JSON.parse(JSON.stringify(x));

test('validação da fila: mesmas regras do motor (motivo, papel, formato, ids, segredo, tamanho)', () => {
  const { api } = load();
  assert.equal(api.aeValidate(epicE({ description: 'x' })), null);
  assert.match(api.aeValidate(epicE({ description: 'x' }, { note: '' })), /porquê/);
  assert.match(api.aeValidate(epicE({ description: 'x' }, { by: { ...by, role: 'reviewer' } })), /revisor|papel/);
  assert.match(api.aeValidate(epicE({ description: 'x' }, { target: 'nao-uuid' })), /id de épico/);
  assert.match(api.aeValidate(epicE({ doneWhenRemove: ['X1'] })), /id inválido/);
  assert.match(api.aeValidate(epicE({ doneWhenAdd: 'solto' })), /lista/);
  assert.match(api.aeValidate(cardE({ objective: 'token = abcdefghijklmnop' })), /segredo/);
  assert.match(api.aeValidate(cardE({ objective: 'a'.repeat(2001) })), /longo/);
  assert.match(api.aeValidate(cardE({ objective: 'x' }, { epicId: null })), /mesmo épico/);
  assert.match(api.aeValidate(cardE({ objective: 'x' }, { target: '../x?y' })), /id de tarefa/);
});

test('épico: acrescenta com ids max+1; REMOÇÃO vira proposta (marcado = proposta recusada); reabre status com rastro', () => {
  const { api } = load();
  const spec = { description: 'antiga', doneWhen: [{ id: 'D1', text: 'login ok', checkedBy: 'u1' }, { id: 'D2', text: 'logout ok' }], requirements: [{ id: 'R1', text: 'x' }] };
  const r = api.aeApplyEpic(spec, epicE({ description: 'nova', doneWhenAdd: ['SSO ok', 'login ok'], doneWhenRemove: ['D2', 'D1'], reqAdd: ['SSO'] }), NOW, 'done');
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(J(r.spec.doneWhen.map((d) => d.id)), ['D1', 'D2', 'D3'], 'D2 NÃO sai; novo = D3');
  assert.equal(r.spec.proposals[0].status, 'open');
  assert.deepEqual(J(r.spec.proposals[0].remove), { doneWhen: ['D2'] });
  assert.match(r.msg, /proposta recusada: D1 já marcado/);
  assert.equal(r.status, 'in-progress', 'ganhou item em aberto: não está mais pronto');
  const h = r.spec.history.at(-1);
  assert.equal(h.statusBefore, 'done');
  assert.equal(h.statusAfter, 'in-progress');
  assert.equal(api.aeApplyEpic(r.spec, epicE({ description: 'outra' }), NOW, 'in-progress').outcome, 'duplicate');
  const only = api.aeApplyEpic(spec, epicE({ doneWhenRemove: ['D1'] }, { id: 'e-2' }), NOW, 'open');
  assert.equal(only.outcome, 'refused');
});

test('épico: aprovar proposta remove (item marcado fica); recusar registra; desfazer volta item e status', () => {
  const { api } = load();
  const base = { doneWhen: [{ id: 'D1', text: 'a', checkedBy: 'u' }, { id: 'D2', text: 'b' }] };
  const p = api.aeApplyEpic(base, epicE({ doneWhenRemove: ['D2'] }), NOW, 'in-progress');
  assert.equal(p.outcome, 'proposed');
  const ok = api.aeDecideEpic(p.spec, 'e-1', true, 'Douglas', NOW, 'in-progress');
  assert.equal(ok.ok, true);
  assert.deepEqual(J(ok.spec.doneWhen.map((d) => d.id)), ['D1']);
  assert.equal(ok.status, 'done', 'o que sobrou está todo marcado');
  assert.equal(ok.spec.proposals[0].status, 'approved');
  assert.equal(api.aeDecideEpic(ok.spec, 'e-1', true, 'x', NOW, 'done').ok, false, 'não decide 2x');
  const u = api.aeUndoEpic(ok.spec, 'p:e-1', 'Douglas', NOW, 'done');
  assert.equal(u.ok, true);
  assert.deepEqual(J(u.spec.doneWhen.map((d) => d.id)), ['D1', 'D2']);
  assert.equal(u.status, 'in-progress', 'status volta junto');
  const no = api.aeDecideEpic(p.spec, 'e-1', false, 'Douglas', NOW, 'in-progress');
  assert.equal(no.spec.proposals[0].status, 'rejected');
  assert.equal(no.spec.doneWhen.length, 2);
  // marcado depois da proposta → aprovar vira "proposta recusada: já marcado"
  const marcado = J(p.spec); marcado.doneWhen[1].checkedBy = 'u';
  const late = api.aeDecideEpic(marcado, 'e-1', true, 'Douglas', NOW, 'in-progress');
  assert.match(late.msg, /proposta recusada: D2 já marcado/);
  assert.equal(late.spec.doneWhen.length, 2);
});

test('cartão: guardas (épico nulo/outro, outro projeto, fechado); remoção = proposta; noutra máquina = só a nuvem; decidir e desfazer', () => {
  const { api } = load();
  const card = { id: CARD, title: 'Logout', status: 'backlog', epic_id: EP, project_id: PROJ, spec: { title: 'Logout', objective: 'velho', requirements: ['a', 'b'], owns: 'src/a/**' } };
  const ctx = { projectId: PROJ };
  assert.equal(api.aeApplyCard({ ...card, epic_id: null }, cardE({ objective: 'n' }), NOW, ctx).outcome, 'refused');
  assert.equal(api.aeApplyCard({ ...card, epic_id: 'outro' }, cardE({ objective: 'n' }), NOW, ctx).outcome, 'refused');
  assert.equal(api.aeApplyCard({ ...card, project_id: 'outro' }, cardE({ objective: 'n' }), NOW, ctx).outcome, 'refused');
  assert.equal(api.aeApplyCard({ ...card, status: 'merged' }, cardE({ objective: 'n' }), NOW, ctx).outcome, 'refused');
  assert.equal(api.aeApplyCard(null, cardE({ objective: 'n' }), NOW, ctx).outcome, 'gone');
  const r = api.aeApplyCard(card, cardE({ title: 'Logout SSO', objective: 'novo', reqAdd: ['c'], reqRemove: ['a'], owns: ['src/sso/**'] }), NOW, ctx);
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(J(r.spec.requirements), ['a', 'b', 'c'], "'a' só sai com aprovação");
  assert.equal(r.spec.owns, 'src/a/**, src/sso/**');
  assert.deepEqual(J(r.proposal.remove), { requirements: ['a'], owns: ['src/a/**'] });
  assert.equal(r.cloudOnly, false);
  assert.equal(api.aeApplyCard({ ...card, spec: r.spec }, cardE({ objective: 'x' }), NOW, ctx).outcome, 'duplicate');
  const away = api.aeApplyCard({ ...card, status: 'running' }, cardE({ objective: 'n' }), NOW, ctx);
  assert.equal(away.cloudOnly, true);
  assert.match(away.msg, /só no card da nuvem; o agente daquela máquina não recebeu/);
  const d = api.aeDecideCard({ ...card, spec: r.spec }, 'c-1', true, 'Douglas', NOW);
  assert.deepEqual(J(d.spec.requirements), ['b', 'c']);
  assert.equal(d.spec.owns, 'src/sso/**');
  const u = api.aeUndoCard({ ...card, spec: r.spec, title: 'Logout SSO' }, 'c-1', 'Douglas', NOW);
  assert.equal(u.ok, true);
  assert.equal(u.spec.objective, 'velho');
  assert.equal(u.title, 'Logout');
});

test('conversa: resumo do snapshot + antes/depois sob demanda + desfazer com aria-label; proposta com aprovar/recusar', () => {
  const { api } = load();
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const t = { id: 't2', status: 'review', spec: { agentEdits: [{ id, by: 'Orion', fields: ['objective'] }], agentProposals: [{ id, by: 'Orion', byTitle: 'Login', remove: { requirements: ['req A'] }, note: 'mudou', status: 'open' }] } };
  const e = { type: 'spec-edit', text: 'Orion (tarefa Login) atualizou esta tarefa: o objetivo — motivo: SSO · edição ' + id };
  const h = api.aeEventHtml(t, e);
  assert.match(h, /atualizado por agente/);
  assert.doesNotMatch(h, /edição 0f0e/);
  assert.match(h, new RegExp('<summary data-aefull="' + id + '" data-aetask="t2">ver antes → depois \\(objetivo\\)'));
  assert.match(h, /aria-label="desfazer a edição de objetivo feita por Orion"/);
  assert.doesNotMatch(h, /[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(api.aeEventHtml({ ...t, status: 'merged' }, e), /data-aeundo/);
  const full = api.aeEventHtml({ ...t, spec: { agentEdits: [{ id, by: 'O', changes: [{ field: 'objective', before: 'velho <b>', after: 'novo' }] }] } }, e);
  assert.match(full, /velho &lt;b&gt;/);
  assert.match(full, /class="ae-a"[^>]*>novo</);
  const pe = { type: 'spec-proposal', text: 'Orion propõe remover desta tarefa: requisito "req A" — motivo: mudou · proposta ' + id };
  const ph = api.aeEventHtml(t, pe);
  assert.match(ph, /Orion \(tarefa Login\) propõe remover: requisito &quot;req A&quot; — motivo: mudou/);
  assert.match(ph, new RegExp('data-aeprop="' + id + '" data-aetask="t2" data-aeok="1"[^>]*>aprovar'));
  assert.match(ph, /data-aeok="0"[^>]*>recusar/);
  const decided = { ...t, spec: { agentProposals: [{ ...t.spec.agentProposals[0], status: 'rejected', decided: { by: 'Douglas' } }] } };
  assert.match(api.aeEventHtml(decided, pe), /proposta recusada por Douglas/);
});

test('página do épico: propostas, histórico (status), cartões mexidos e o aviso "esperando quem criou"', () => {
  const { api } = load();
  const r = api.aeApplyEpic({ description: 'a', doneWhen: [{ id: 'D1', text: 'x' }] }, epicE({ description: 'b', doneWhenRemove: ['D1'] }, { at: new Date().toISOString() }), NOW, 'open');
  const tasks = [{ id: CARD, title: 'Logout', status: 'backlog', spec: { agentProposals: [{ id: 'c-1', by: 'Orion', remove: { requirements: ['a'] }, status: 'open' }] } }];
  api.aeWaiting[EP] = { n: 2, msg: 'precisa de quem criou o épico' };
  const h = api.aeEpicHistHtml(r.spec, true, tasks, EP);
  assert.match(h, /2 mudança\(s\) de agente esperando: precisa de quem criou o épico/);
  assert.match(h, /data-epprop="e-1"[^>]*data-aeok="1"/);
  assert.match(h, /data-cardprop="c-1" data-card="aaaaaaaa/);
  assert.match(h, /motivo: SSO virou requisito/);
  assert.match(h, /data-epundo="e-1"/);
  assert.doesNotMatch(api.aeEpicHistHtml(r.spec, false, [], null), /data-epundo|data-aeok/);
  assert.equal(api.aeEpicHistHtml({}, true, [], null), '');
  assert.match(api.aeEpicBadge(r.spec), /atualizado por agente/);
});

test('fila: épico aplicado com trava updated_at (conflito → relê e refaz), sincroniza cópias locais e marca feito', async () => {
  const c = load({ cloudData: { meRole: 'admin' } });
  c.rows['epics?'] = { id: EP, name: 'Auth', status: 'open', created_by: 'outro', updated_at: '2026-01-01T00:00:00Z', spec: { doneWhen: [{ id: 'D1', text: 'a' }] } };
  c.patchEmpty = 1; // 1ª escrita perde a corrida
  c.pending = [epicE({ doneWhenAdd: ['b'] })];
  await c.api.aeTick();
  const patches = c.calls.filter((x) => x[0] === 'patch');
  assert.equal(patches.length, 2, 'refez depois do conflito');
  assert.match(patches[0][1], /epics\?id=eq\.11111111-2222-3333-4444-555555555555&updated_at=eq\.2026-01-01T00%3A00%3A00Z/);
  assert.deepEqual(J(patches[1][2].spec.doneWhen.map((d) => d.id)), ['D1', 'D2']);
  const sync = c.calls.find((x) => x[0] === 'epic_sync_cli');
  assert.deepEqual(J(sync[1].doneWhen), ['D1: a', 'D2: b']);
  assert.deepEqual(J(c.calls.find((x) => x[0] === 'agent_edits_done')[1]), { id: 'e-1', outcome: 'applied', msg: '' });
});

test('fila: sem permissão no épico fica pendente e visível; inválida é recusada e o autor rodando fica sabendo', async () => {
  const c = load();
  c.rows['epics?'] = { id: EP, name: 'Auth', status: 'open', created_by: 'outro', spec: {} };
  c.pending = [epicE({ description: 'x' }), epicE({ description: 'y' }, { id: 'e-2', note: '' })];
  await c.api.aeTick();
  const done = c.calls.filter((x) => x[0] === 'agent_edits_done').map((x) => x[1]);
  assert.equal(done.length, 1, 'a sem permissão NÃO sai da fila');
  assert.equal(done[0].id, 'e-2');
  assert.equal(done[0].outcome, 'refused');
  assert.match(c.api.aeWaiting[EP].msg, /precisa de quem criou o épico/);
  assert.ok(c.calls.some((x) => x[0] === 'add_instruction' && /RECUSADA/.test(x[1].text)));
  assert.ok(!c.calls.some((x) => x[0] === 'patch'));
});

test('fila: erro transitório agenda nova tentativa sem travar as outras; 403 é recusa definitiva', async () => {
  const c = load({ cloudData: { meRole: 'owner' } });
  c.rows['id=eq.' + CARD] = { id: CARD, title: 'Logout', status: 'backlog', epic_id: EP, project_id: PROJ, spec: {} };
  const realGet = c.sbGet;
  c.sbGet = async (q) => { if (q.startsWith('epics')) throw new Error('Failed to fetch'); return realGet(q); };
  c.pending = [epicE({ description: 'x' }), cardE({ objective: 'novo' })];
  await c.api.aeTick();
  const done = c.calls.filter((x) => x[0] === 'agent_edits_done').map((x) => x[1]);
  assert.deepEqual(done.map((d) => d.id), ['c-1'], 'o cartão passou mesmo com o épico falhando');
  assert.ok(c.api.aeRetry['e-1'].next > Date.now(), 'épico em espera (backoff)');
  c.calls.length = 0;
  await c.api.aeTick();
  assert.ok(!c.calls.some((x) => x[0] === 'get' && x[1].startsWith('epics')), 'em backoff: nem tenta');
  const c2 = load({ cloudData: { meRole: 'owner' } });
  c2.sbGet = async () => { throw new Error('erro 403'); };
  c2.pending = [epicE({ description: 'x' })];
  await c2.api.aeTick();
  assert.equal(c2.calls.find((x) => x[0] === 'agent_edits_done')[1].outcome, 'refused');
});

test('fila/cartão: roda NESTA máquina → motor (editId + modo repassado); noutra máquina → só a nuvem + rastro no feed', async () => {
  const c = load();
  c.state.tasks.push({ id: 'irma-local', status: 'running' });
  c.rows['id=eq.' + CARD] = { id: CARD, title: 'Logout', status: 'running', local_id: 'irma-local', epic_id: EP, project_id: PROJ, spec: {} };
  c.cliMode = 'unchanged';
  c.pending = [cardE({ objective: 'novo' })];
  await c.api.aeTick();
  const cli = c.calls.find((x) => x[0] === 'task_edit_cli');
  assert.equal(cli[1].taskId, 'irma-local');
  assert.equal(cli[1].editId, 'c-1');
  assert.equal(c.calls.find((x) => x[0] === 'agent_edits_done')[1].outcome, 'unchanged');
  const c2 = load();
  c2.rows['id=eq.' + CARD] = { id: CARD, title: 'Logout', status: 'running', local_id: 'de-outro-mac', epic_id: EP, project_id: PROJ, spec: {} };
  c2.pending = [cardE({ objective: 'novo' })];
  await c2.api.aeTick();
  const d = c2.calls.find((x) => x[0] === 'agent_edits_done')[1];
  assert.equal(d.outcome, 'cloud-only');
  assert.match(d.msg, /o agente daquela máquina não recebeu/);
  assert.ok(c2.calls.some((x) => x[0] === 'post' && x[1] === 'task_feed' && /atualizou esta tarefa/.test(x[2].text)));
  // pelo local_id: filtra projeto e épico, com encode
  const c3 = load();
  c3.pending = [cardE({ objective: 'n' }, { target: 'irma x' })];
  c3.pending[0].target = 'irma-x';
  await c3.api.aeTick();
  assert.ok(c3.calls.some((x) => x[0] === 'get' && x[1] === 'tasks?select=*&local_id=eq.irma-x&project_id=eq.' + PROJ + '&epic_id=eq.' + EP));
  assert.equal(c3.calls.find((x) => x[0] === 'agent_edits_done')[1].outcome, 'gone');
});

test('fiação: a conversa delega spec-edit/spec-proposal, o index carrega o script e o EPIC.md leva ids e requisitos', () => {
  const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
  assert.match(ws, /e\.type==='spec-edit'\|\|e\.type==='spec-proposal'\) && typeof aeEventHtml==='function'/);
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/47-edicoes-agente.js') > html.indexOf('js/46-epico-time.js'));
  const ep = readFileSync(new URL('../src/js/46-epico-time.js', import.meta.url), 'utf8');
  assert.match(ep, /id do épico: '\+ep\.id/);
  assert.match(ep, /' · id '\+sid/);
  assert.match(ep, /' · requisitos: '/);
  assert.match(ep, /aeEpicHistHtml\(sp, can, tasks, ep\.id\)/);
  const css = readFileSync(new URL('../src/css/81-chat.css', import.meta.url), 'utf8');
  assert.match(css, /\.ae-a\{/);
});
