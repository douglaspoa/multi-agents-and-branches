// Time integrado (mesa 09/10): issue nasce com o CARTÃO do time (14 @puro-trkcard-*).
// `node --test app/tests/` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const K = new Function(cut(read('14-issues-projeto.js'), '// @puro-trkcard-inicio', '// @puro-trkcard-fim')
  + '\nreturn { trkCoversRemote, trkCardIssueWhy, trkCardLink, trkCardBody };')();

const CONN = { baseUrl: 'https://tracker.exemplo.dev', ops: { list: { path: '/issues' }, create: { method: 'POST', path: '/issues' } } };
const LOJA = { remote: 'github.com/org/loja', legacy: 'github.com-work/org/loja' };

test('painel cobre o projeto do cartão pelo remote (forma nova ou antiga) ou "todos os projetos"', () => {
  const cfg = { connector: CONN, projects: ['github.com-work/org/loja'], rules: { createOnTask: true } };
  assert.equal(K.trkCoversRemote(cfg, 'github.com/org/loja', [LOJA]), true); // salvo na forma antiga (alias)
  assert.equal(K.trkCoversRemote({ ...cfg, projects: ['github.com/org/loja'] }, 'github.com/org/loja', []), true);
  assert.equal(K.trkCoversRemote(cfg, 'github.com/org/api', [LOJA]), false);
  assert.equal(K.trkCoversRemote({ ...cfg, projects: [], allProjects: true }, 'github.com/org/api', []), true);
  assert.equal(K.trkCoversRemote({ connector: { ...CONN, ops: {} }, allProjects: true }, 'x', []), false); // conector sem list = não pronto
});

test('cartão do time ganha issue quando a regra, o create e o projeto batem — senão "off" (escolha, não falha)', () => {
  const cfg = { connector: CONN, projects: ['github.com/org/loja'], rules: { createOnTask: true } };
  assert.equal(K.trkCardIssueWhy(cfg, 'github.com/org/loja', [LOJA]), null);
  assert.equal(K.trkCardIssueWhy({ ...cfg, rules: { createOnTask: false } }, 'github.com/org/loja', [LOJA]), 'off');
  assert.equal(K.trkCardIssueWhy({ ...cfg, connector: { ...CONN, ops: { list: {} } } }, 'github.com/org/loja', [LOJA]), 'off');
  assert.equal(K.trkCardIssueWhy(cfg, 'github.com/org/api', [LOJA]), 'off');
  assert.equal(K.trkCardIssueWhy(null, 'x', []), 'off');
});

test('vínculo do cartão: spec.issueCode/issueUrl, coluna issue_url, ou nada', () => {
  assert.deepEqual(K.trkCardLink({ spec: { issueCode: 'FND-7', issueUrl: 'https://t/FND-7' } }), { code: 'FND-7', url: 'https://t/FND-7' });
  assert.deepEqual(K.trkCardLink({ spec: {}, issue_url: 'https://t/x/9' }), { code: '', url: 'https://t/x/9' });
  assert.deepEqual(K.trkCardLink({ spec: { issueCode: '42', issueUrl: 'javascript:alert(1)' } }), { code: '42', url: '' }); // url que não é http não vira link
  assert.equal(K.trkCardLink({ spec: {} }), null);
  assert.equal(K.trkCardLink(null), null);
});

test('corpo da issue: objetivo, requisitos e a linha do épico (o quadro de Issues agrupa por "Épico: X")', () => {
  assert.equal(K.trkCardBody({ objective: 'Filtro por NCM', requirements: ['busca por código', ' '] }, 'Épico: FND-1'),
    'Filtro por NCM\n\nRequisitos:\n- busca por código\n\nÉpico: FND-1');
  assert.equal(K.trkCardBody({}, ''), '');
});

// ---- caminhos com efeito (vm com painel/nuvem FALSOS): o recorte é o código real das funções ----
function fn(src, name) {
  const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src); assert.ok(m, 'função não encontrada: ' + name);
  let i = src.indexOf('{', m.index + m[0].length - 1), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('chaves desbalanceadas: ' + name);
}
const S14 = read('14-issues-projeto.js'), S42 = read('42-nuvem-sync-mobile.js');
const PURO = cut(S14, '// @puro-trkcard-inicio', '// @puro-trkcard-fim') + cut(S14, '// @puro-trkmade-inicio', '// @puro-trkmade-fim');
function world(over = {}) {
  const W = { made: [], patches: [], toasts: [], posts: [], seq: 100, failCreate: null, hasParent: false, ...over };
  W.trk = { connector: CONN, projects: ['github.com/org/loja'], rules: { createOnTask: true } };
  const g = {
    trkLoad: async () => W.trk, trkReady: () => true, trkProjectOn: async () => true, trkRepoRemote: async () => 'github.com/org/loja', trkRemote: 'github.com/org/loja', trkRemoteIds: LOJA, repoRemoteIds: async () => LOJA,
    trkParentSupport: () => W.hasParent, trkCreateBodyHas: () => false, trkEpicType: () => '', trkStoryType: () => '', trkCall: async () => ({}),
    trkErrText: (e) => String(e && e.message || e),
    trkCreateIssue: async (title, desc, goal, extra) => { if (W.failCreate && W.failCreate(title)) throw new Error('HTTP 401'); const code = 'FND-' + (++W.seq); W.made.push({ code, title, desc, extra }); return { code, url: '', id: code }; },
    sbFetch: async (path, o) => { W.patches.push([path, JSON.parse(o.body)]); return [{}]; },
    sbPost: async (t, b) => { W.posts.push([t, b]); return [{ id: 'card-1', ...b }]; },
    cloudEnsureProject: async () => ({ id: 'p1', repo_remote: 'github.com/org/loja' }), SB: { sess: () => ({}) }, cloudTeamId: () => 't1', cloudUserId: () => 'u1',
    ntEpicVal: () => null, teamEpics: [], teamTasks: [], window: {},
    toast: (m, k) => W.toasts.push([k, m]),
  };
  const code = PURO + ['trkCardFailToast', 'trkIssueForCard', 'trkCardIds', 'trkSpecWithIssue', 'trkPublishEpic', 'cloudShareTask'].map((n) => fn(n === 'cloudShareTask' ? S42 : S14, n)).join('\n')
    + '\nreturn { trkPublishEpic, trkIssueForCard, cloudShareTask };';
  const names = Object.keys(g);
  W.api = new Function('W', ...names, 'let trk=W.trk; ' + code)(W, ...names.map((k) => g[k]));
  return W;
}

test('épico com conector SEM "pai": issue do épico + uma por cartão com "Épico: CODE", ligadas; publicar de novo não duplica', async () => {
  const W = world();
  const ep = { id: 'e1', name: 'Busca por NCM', spec: { outcome: 'achar pelo NCM' } };
  const created = [{ row: { id: 'r1', title: 'Índice', spec: { objective: 'índice' } }, wave: 1 }, { row: { id: 'r2', title: 'Tela', spec: { objective: 'tela', after: ['r1'] } }, wave: 2 }];
  const parent = await W.api.trkPublishEpic(ep, created);
  assert.equal(parent.code, 'FND-101');
  assert.deepEqual(W.made.map((m) => m.title), ['Busca por NCM', 'Índice', 'Tela']);
  assert.ok(W.made.slice(1).every((m) => m.desc.includes('Épico: FND-101')));
  assert.ok(W.made[2].desc.includes('Bloqueada por: FND-102'));
  assert.ok(W.made.slice(1).every((m) => !m.extra.parent)); // sem suporte a pai: não manda {{parent}}
  assert.deepEqual(W.patches.filter((p) => p[0].includes('/tasks?')).map((p) => p[1].spec.issueCode), ['FND-102', 'FND-103']);
  assert.equal(W.toasts.at(-1)[0], 'ok');
  // de novo (épico e linhas já ligados): nada novo no painel
  await W.api.trkPublishEpic(ep, created);
  assert.equal(W.made.length, 3);
});

test('épico: uma filha falha → as outras nascem e UM aviso com o nome da que falhou e o motivo', async () => {
  const W = world({ failCreate: (t) => t === 'Tela' });
  await W.api.trkPublishEpic({ id: 'e1', name: 'Ép', spec: {} }, [{ row: { id: 'r1', title: 'Índice', spec: {} } }, { row: { id: 'r2', title: 'Tela', spec: {} } }, { row: { id: 'r3', title: 'Doc', spec: {} } }]);
  assert.deepEqual(W.made.map((m) => m.title), ['Ép', 'Índice', 'Doc']);
  const warns = W.toasts.filter((t) => t[0] === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /“Tela” ficou sem issue no painel: HTTP 401/);
});

test('cartão mandado pro time nasce com a issue no spec; falha do painel avisa e NÃO impede o cartão', async () => {
  const W = world();
  await W.api.cloudShareTask({ title: 'Filtro por NCM', objective: 'buscar', requirements: ['8 dígitos'] });
  assert.equal(W.posts[0][0], 'tasks');
  assert.equal(W.posts[0][1].spec.issueCode, 'FND-101');
  assert.match(W.made[0].desc, /Requisitos:\n- 8 dígitos/);
  const F = world({ failCreate: () => true });
  await F.api.cloudShareTask({ title: 'Exportar CSV', objective: 'x' });
  assert.equal(F.posts.filter((p) => p[0] === 'tasks').length, 1); // o cartão nasceu
  assert.equal(F.posts[0][1].spec.issueCode, undefined);
  assert.match(F.toasts[0][1], /“Exportar CSV” ficou sem issue no painel: HTTP 401/);
  // regra desligada: nem chama o painel, nem avisa
  const O = world(); O.trk.rules.createOnTask = false;
  await O.api.cloudShareTask({ title: 'Sem painel' });
  assert.equal(O.made.length, 0); assert.equal(O.toasts.length, 0);
  // payload que já tem issue (ex.: veio de uma issue do painel): não cria outra
  const E = world();
  await E.api.cloudShareTask({ title: 'Da issue', issue: 'FND-7' });
  assert.equal(E.made.length, 0); assert.equal(E.posts[0][1].spec.issueCode, 'FND-7');
});

// ---- PR2: mandar pro time, responsável, início automático só com dono ----
const RESP = new Function(cut(S42, '// @time-resp-inicio', '// @time-resp-fim') + cut(S42, '// @exec-inicio', '// @exec-fim')
  + '\nreturn { tmCanAssign, tmAssignOpts, tmDestDefault, ctMineFor, ctAutoMine };')();
const MEM = [{ user_id: 'ana', role: 'lead' }, { user_id: 'bruno', role: 'member' }, { user_id: 'caio', role: 'member' }];
const PROF = { ana: { name: 'Ana Souza' }, bruno: { name: 'Bruno Lima' }, caio: { email: 'caio@exemplo.dev' } };

test('quem pode pôr OUTRA pessoa: líder do time ou owner/admin da org (membro não)', () => {
  assert.equal(RESP.tmCanAssign('member', MEM, 'ana'), true);   // líder
  assert.equal(RESP.tmCanAssign('member', MEM, 'bruno'), false);
  assert.equal(RESP.tmCanAssign('admin', MEM, 'bruno'), true);
  assert.equal(RESP.tmCanAssign('owner', [], 'x'), true);
});

test('seletor de responsável: Livre + eu (+ o time, só pra quem pode), nome do perfil ou do e-mail', () => {
  assert.deepEqual(RESP.tmAssignOpts(MEM, PROF, 'bruno', false).map((o) => [o.id, o.label]), [['', 'Livre'], ['bruno', 'Bruno Lima']]);
  assert.deepEqual(RESP.tmAssignOpts(MEM, PROF, 'ana', true).map((o) => [o.id, o.label]), [['', 'Livre'], ['ana', 'Ana Souza'], ['bruno', 'Bruno Lima'], ['caio', 'caio']]);
});

test('"Mandar pro time" é o padrão com time; a última escolha vale; sem time só roda', () => {
  assert.equal(RESP.tmDestDefault(true, null), 'team');
  assert.equal(RESP.tmDestDefault(true, 'run'), 'run');
  assert.equal(RESP.tmDestDefault(false, 'team'), 'run');
});

test('cartão mandado pro time sem dono não é de quem criou; só cartão no MEU nome começa sozinho', () => {
  const sent = { created_by: 'ana', assignee: null, spec: { dispatch: 'team' } };
  assert.equal(RESP.ctMineFor(sent, 'ana'), false);
  assert.equal(RESP.ctMineFor({ created_by: 'ana', assignee: null, spec: {} }, 'ana'), true); // cartão antigo segue como era na Execução
  assert.equal(RESP.ctAutoMine({ created_by: 'ana', assignee: null, spec: { autoStart: true } }, 'ana'), false); // a armadilha do líder
  assert.equal(RESP.ctAutoMine({ created_by: 'ana', assignee: 'bruno' }, 'ana'), false);
  assert.equal(RESP.ctAutoMine({ created_by: 'ana', assignee: 'bruno' }, 'bruno'), true);
});

test('"--para" do terminal acha a pessoa do time por e-mail ou nome; desconhecido/ambíguo recusa', () => {
  const S49 = read('49-epico-pedidos.js');
  const P = new Function("const erFold=s=>String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\\s+/g,' ').trim().toLowerCase();\n" + fn(S49, 'erPickMember') + '\nreturn erPickMember;')();
  const prof = { ana: { name: 'Ana Souza', email: 'ana@exemplo.dev' }, bruno: { name: 'Bruno Lima', email: 'bruno@exemplo.dev' } };
  assert.deepEqual(P(MEM, prof, 'bruno@exemplo.dev'), { uid: 'bruno' });
  assert.deepEqual(P(MEM, prof, 'ana souza'), { uid: 'ana' });
  assert.match(P(MEM, prof, 'zeca').err, /não é do time/);
  assert.deepEqual(P(MEM, prof, ''), { uid: null });
});

test('migration 0032: gatilho do responsável, claim que não toma de colega, devolver/atribuir em RPC, registrada na aba Banco', () => {
  const root = (p) => new URL('../../' + p, import.meta.url);
  const sql = readFileSync(root('supabase/migrations/0032_time_responsavel.sql'), 'utf8');
  assert.match(sql, /before insert or update of assignee on tasks/);
  assert.match(sql, /can_assign_others\(new\.team_id\)/);
  assert.match(sql, /já está com outra pessoa/); // claim_task não toma cartão de colega
  assert.match(sql, /a tarefa está rodando/);
  for (const f of ['claim_task(uuid)', 'release_task(uuid, text)', 'assign_task(uuid, uuid)']) assert.ok(sql.includes('grant execute on function ' + f + ' to authenticated'), f);
  assert.doesNotMatch(sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), /join team_members/i, 'sem a armadilha das 0010/0022/0023');
  assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
  const reg = readFileSync(root('supabase/functions/admin-api/migrations.ts'), 'utf8');
  const m = reg.match(/\{ name: "0032_time_responsavel\.sql", sql: ("(?:[^"\\]|\\.)*") \}/);
  assert.ok(m, 'registrada'); assert.equal(JSON.parse(m[1]), sql, 'mesmo conteúdo do arquivo');
});

test('cartão mandado pro time: dispatch=team, responsável DEPOIS do cartão (recusa deixa livre), épico do chamador', async () => {
  const W = world();
  const assigned = [];
  const S = world();
  // cloudAssign / tmAssignOptsNow falsos no mundo: refaz com eles
  const code = PURO + ['trkCardFailToast', 'trkIssueForCard', 'trkCardIds', 'trkSpecWithIssue', 'cloudShareTask'].map((n) => fn(n === 'cloudShareTask' ? S42 : S14, n)).join('\n') + '\nreturn cloudShareTask;';
  const mk = (failAssign) => { const posts = [], toasts = [];
    const share = new Function('trk', 'trkLoad', 'trkRepoRemote', 'trkRemote', 'trkRemoteIds', 'repoRemoteIds', 'trkErrText', 'trkCreateIssue', 'sbPost', 'cloudEnsureProject', 'SB', 'cloudTeamId', 'cloudUserId', 'ntEpicVal', 'teamEpics', 'teamTasks', 'window', 'toast', 'cloudAssign', 'tmAssignOptsNow', 'cloudErrMsg', code)(
      { ...S.trk, rules: { createOnTask: false } }, async () => S.trk, async () => '', '', LOJA, async () => LOJA, (e) => String(e.message || e), async () => ({}),
      async (t, b) => { posts.push([t, b]); return [{ id: 'card-1', ...b }]; }, async () => ({ id: 'p1', repo_remote: 'github.com/org/loja' }), { sess: () => ({}) }, () => 't1', () => 'u1',
      () => 'epico-do-formulario', [], [], {}, (m, k) => toasts.push([k, m]),
      async (id, uid) => { if (failAssign) throw new Error('só o líder do time ou um admin atribui tarefa a outra pessoa'); assigned.push([id, uid]); }, () => [{ id: '' }, { id: 'u1' }, { id: 'u2' }], (e) => e.message);
    return { share, posts, toasts }; };
  const ok = mk(false);
  await ok.share({ title: 'A' }, { assignee: 'u2', epicId: null });
  const row = ok.posts.find((p) => p[0] === 'tasks')[1];
  assert.equal(row.spec.dispatch, 'team'); assert.equal(row.assignee, undefined); assert.equal(row.epic_id, null, 'planner não herda o épico do Formulário');
  assert.deepEqual(assigned, [['card-1', 'u2']]);
  const no = mk(true);
  await no.share({ title: 'B' }, { assignee: 'u2' });
  assert.equal(no.posts.filter((p) => p[0] === 'tasks').length, 1, 'o cartão nasceu');
  assert.equal(no.posts.find((p) => p[0] === 'tasks')[1].epic_id, 'epico-do-formulario', 'Formulário usa o seletor dele');
  assert.match(no.toasts.at(-1)[1], /ficou livre: só o líder/);
});

// ---- PR3: assumir · devolver · avisos de mudança de dono · "Com o time" na Central ----
const S43 = read('43-espaco-times.js'), S46 = read('46-epico-time.js');
const NOTIF = new Function(cut(S43, '// @time-notif-inicio', '// @time-notif-fim') + '\nreturn ctOwnerNotif;')();
const SENT = new Function(cut(S46, '// @ct-sent-inicio', '// @ct-sent-fim') + '\nreturn ctSentShow;')();
const nm = (u) => ({ ana: 'Ana', bruno: 'Bruno', caio: 'Caio' }[u] || u);

test('aviso de mudança de dono: quem criou sabe quando assumem/devolvem/passam; quem recebe sabe; o que EU faço não me avisa', () => {
  const t = { id: 'c1', title: 'Índice de NCM', created_by: 'ana', assignee: 'bruno' };
  assert.match(NOTIF({ user_id: 'bruno', kind: 'claimed', task_id: 'c1' }, t, 'ana', nm).title, /Bruno assumiu a sua demanda/);
  assert.match(NOTIF({ user_id: 'bruno', kind: 'released', task_id: 'c1', body: 'sem tempo essa semana' }, { ...t, assignee: null }, 'ana', nm).body, /livre na fila do time — sem tempo/);
  assert.match(NOTIF({ user_id: 'ana', kind: 'assigned', body: 'bruno' }, t, 'bruno', nm).title, /Nova tarefa pra você/);
  assert.match(NOTIF({ user_id: 'caio', kind: 'assigned', body: 'bruno' }, t, 'ana', nm).body, /Caio passou “Índice de NCM” pra Bruno/);
  assert.equal(NOTIF({ user_id: 'ana', kind: 'claimed' }, t, 'ana', nm), null, 'eu mesma');
  assert.equal(NOTIF({ user_id: 'bruno', kind: 'claimed' }, { ...t, created_by: 'caio' }, 'ana', nm), null, 'demanda de outra pessoa');
  assert.match(NOTIF({ user_id: 'bruno', kind: 'started' }, t, 'ana', nm).title, /começou a sua demanda/);
});

test('"Com o time" na Central: o que eu criei e está com outra pessoa, ou mandei pro time livre — nunca o meu nem o entregue', () => {
  assert.equal(SENT({ created_by: 'ana', assignee: 'bruno', status: 'running' }, 'ana'), true);
  assert.equal(SENT({ created_by: 'ana', assignee: null, status: 'backlog', spec: { dispatch: 'team' } }, 'ana'), true);
  assert.equal(SENT({ created_by: 'ana', assignee: null, status: 'backlog', spec: {} }, 'ana'), false, 'cartão antigo meu sem dono segue na minha Execução');
  assert.equal(SENT({ created_by: 'ana', assignee: 'ana', status: 'running' }, 'ana'), false);
  assert.equal(SENT({ created_by: 'ana', assignee: 'bruno', status: 'merged' }, 'ana'), false);
  assert.equal(SENT({ created_by: 'caio', assignee: 'bruno', status: 'running' }, 'ana'), false);
});

test('ações do cartão: livre → assumir (só o nome) + ▶; meu → iniciar + devolver; de colega → nada pro membro, trocar/devolver pro líder', () => {
  const src = fn(S43, 'tsActsHtml');
  const mk = (canAssign) => new Function('tmCanAssignNow', 'esc', 'escA', 'IC', 'TS_LIVE', src + '\nreturn tsActsHtml;')(() => canAssign, (s) => String(s), (s) => String(s), { play: '▶' }, new Set(['running', 'thinking', 'plan-review', 'queued']));
  const acts = (h) => [...h.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]);
  const M = mk(false), L = mk(true);
  assert.deepEqual(acts(M({ status: 'backlog', assignee: null, claim_mode: 'open' }, 'me', true, true, true, {})), ['claimonly', 'claim']);
  assert.deepEqual(acts(M({ status: 'backlog', assignee: 'me' }, 'me', true, true, true, {})), ['claim', 'release']);
  assert.deepEqual(acts(M({ status: 'backlog', assignee: 'bruno' }, 'me', false, true, true, {})), [], 'cartão de colega não se toma');
  assert.deepEqual(acts(L({ status: 'backlog', assignee: 'bruno' }, 'me', false, true, true, {})), ['release', 'reassign']);
  assert.deepEqual(acts(L({ status: 'backlog', assignee: null, claim_mode: 'open' }, 'me', true, true, true, {})), ['claimonly', 'claim', 'reassign']);
  assert.deepEqual(acts(M({ status: 'running', assignee: 'me' }, 'me', false, true, true, {})), [], 'rodando: devolver não aparece');
  assert.deepEqual(acts(M({ status: 'error', assignee: 'me' }, 'me', false, true, true, {})), ['release']);
  assert.deepEqual(acts(M({ status: 'review', assignee: 'me', pr_url: 'x' }, 'me', false, true, true, {})), [], 'entregue não volta');
});
