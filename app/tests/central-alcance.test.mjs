// Central com alcance (mock aprovado 09/10): 71 @ca-puro-* + as costuras com 22/42/43/46/70 e a RLS das migrations.
// `node --test app/tests/` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const S71 = read('js/71-central-alcance.js');
// o 71 usa as regras do 70 (fonte única): entram juntas, do código real
const E = cut(read('js/70-time-entregas.js'), '// @puro-entregas-inicio', '// @puro-entregas-fim');
const C = new Function(E + cut(S71, '// @ca-puro-inicio', '// @ca-puro-fim')
  + '\nreturn { caScopesFor, caScopeOf, caTabOf, caFiltrosDe, caFiltrosValidos, caLivre, caDoEscopo, caFiltra, caResumo, caMinhas, caAcoes, caEpicoLinha };')();

const BK = { backlog: 'fila', running: 'andamento', error: 'aguardando', review: 'prontas', merged: 'anteriores', done: 'anteriores', cancelled: 'anteriores' };
const fn = { bucket: (t) => (t.pr_url && !['merged', 'error'].includes(t.status) ? 'praberto' : BK[t.status] || 'andamento'), delivered: (t) => ['merged', 'done'].includes(t.status), flag: (t) => t.flag };
const T = (id, o) => ({ id, title: id, team_id: 'T1', project_id: 'P1', created_by: 'L', assignee: null, status: 'backlog', ...o });
const tasks = [
  T('livre', {}),
  T('minha-fila', { assignee: 'eu' }),
  T('minha-rev', { assignee: 'eu', status: 'review', pr_url: 'https://github.com/exemplo/loja/pull/1' }),
  T('minha-roda', { assignee: 'eu', status: 'running', local_id: 'x' }),
  T('colega', { assignee: 'ana', status: 'backlog' }),
  T('colega-roda', { assignee: 'ana', status: 'running' }),
  T('travada', { assignee: 'ana', status: 'error' }),
  T('entregue', { assignee: 'ana', status: 'merged', pr_url: 'https://github.com/exemplo/loja/pull/2' }),
  T('outro-time-livre', { team_id: 'T2' }),
  T('cancelada', { status: 'cancelled' }),
];
const by = (id) => tasks.find((t) => t.id === id);

test('alcance: "Org toda" só pra owner/admin; o salvo é validado pelo papel de agora', () => {
  assert.deepEqual(C.caScopesFor('member').map((x) => x[0]), ['minhas', 'time']);
  assert.deepEqual(C.caScopesFor('admin').map((x) => x[0]), ['minhas', 'time', 'org']);
  assert.deepEqual(C.caScopesFor('owner').map((x) => x[0]), ['minhas', 'time', 'org']);
  assert.equal(C.caScopeOf('org', 'member'), 'time', 'membro (ou líder que não é admin) com "org" salvo cai em Do time');
  assert.equal(C.caScopeOf('org', 'owner'), 'org');
  assert.equal(C.caScopeOf('', 'owner'), 'minhas', 'padrão = Minhas');
  assert.equal(C.caScopeOf('lixo', 'admin'), 'minhas');
  assert.equal(C.caTabOf('epicos'), 'epicos'); assert.equal(C.caTabOf('x'), 'tarefas');
  assert.deepEqual(C.caFiltrosDe('{"chip":"livres","proj":"P1"}'), { chip: 'livres', proj: 'P1', who: '' });
  assert.deepEqual(C.caFiltrosDe('{quebrado'), { chip: 'todas', proj: '', who: '' });
  assert.equal(C.caFiltrosDe('{"chip":"hack"}').chip, 'todas');
});

test('filtros Comigo/Livres/Pra revisar/Travadas + projeto + pessoa', () => {
  const ids = (f) => C.caFiltra(tasks, f, 'eu', fn).map((t) => t.id);
  assert.deepEqual(ids({ chip: 'comigo' }), ['minha-fila', 'minha-rev', 'minha-roda']);
  const extra = tasks.concat([T('minha-entregue', { assignee: 'eu', status: 'merged' })]);
  assert.equal(C.caFiltra(extra, { chip: 'comigo' }, 'eu', fn).length, C.caResumo(extra, 'eu', fn).comigo, 'chip "Comigo" = "com você" do topo (entregue não conta)');
  assert.deepEqual(C.caFiltrosValidos({ chip: 'todas', proj: 'P9', who: 'saiu' }, ['P1'], ['eu', 'ana']), { chip: 'todas', proj: '', who: '' }, 'filtro salvo que não vale mais volta pra todos');
  assert.deepEqual(C.caFiltrosValidos({ chip: 'todas', proj: 'P1', who: '-' }, ['P1'], []), { chip: 'todas', proj: 'P1', who: '-' });
  assert.deepEqual(ids({ chip: 'livres' }), ['livre', 'outro-time-livre'], 'cancelada não é livre');
  assert.deepEqual(ids({ chip: 'revisar' }), ['minha-rev']);
  assert.deepEqual(ids({ chip: 'travadas' }), ['travada']);
  assert.deepEqual(ids({ chip: 'todas', who: 'ana' }), ['colega', 'colega-roda', 'travada', 'entregue']);
  assert.deepEqual(ids({ chip: 'todas', who: '-' }), ['livre', 'outro-time-livre', 'cancelada']);
  assert.deepEqual(ids({ chip: 'livres', proj: 'P9' }), []);
  assert.deepEqual(C.caResumo(tasks, 'eu', fn), { comigo: 3, livres: 2, revisar: 1, travadas: 1 });
});

test('alcance nos dados: Do time = só o time escolhido; Org toda = todos; Minhas = meu nome + livres dos meus times', () => {
  const ids = (scope, x) => C.caDoEscopo(tasks, scope, { me: 'eu', myTeams: new Set(['T1']), scopeTeams: new Set(['T1']), ...x }, fn).map((t) => t.id);
  assert.ok(!ids('time').includes('outro-time-livre'), 'Do time não mostra outro time mesmo se o dado veio da org');
  assert.ok(ids('org', { scopeTeams: new Set(['T1', 'T2']) }).includes('outro-time-livre'));
  assert.deepEqual(ids('minhas'), ['livre', 'minha-fila', 'minha-rev', 'minha-roda']);
  const outro = tasks.concat([T('eu-em-T2', { team_id: 'T2', assignee: 'eu' })]);
  assert.ok(C.caDoEscopo(outro, 'minhas', { me: 'eu', myTeams: new Set(['T1']), scopeTeams: new Set() }, fn).some((t) => t.id === 'eu-em-T2'), 'no meu nome conta em qualquer time');
});

test('Minhas: no meu nome e não roda aqui + livres dos MEUS times (sem duplicar a fila dos épicos)', () => {
  const m = C.caMinhas(tasks, 'eu', new Set(['T1']), fn, (t) => !!t.local_id, (t) => t.id === 'minha-fila-no-epico');
  assert.deepEqual(m.comigo.map((t) => t.id), ['minha-fila', 'minha-rev'], 'a que roda nesta máquina já está na Central de sempre');
  assert.deepEqual(m.livres.map((t) => t.id), ['livre'], 'livre de OUTRO time não entra em Minhas');
  const m2 = C.caMinhas(tasks, 'eu', new Set(['T1']), fn, () => false, (t) => t.id === 'minha-fila');
  assert.ok(!m2.comigo.some((t) => t.id === 'minha-fila'), 'o que já está na fila dos épicos não repete');
});

test('ações da linha = as do mock (assumir / iniciar+devolver / revisar / terminal / ver+reatribuir / ver entrega)', () => {
  const a = (id, x) => C.caAcoes(by(id), { me: 'eu', canAssign: false, local: false, repo: 'here', ...x }, fn).map((y) => y.act + (y.off ? '!' : ''));
  assert.deepEqual(a('livre'), ['claim']);
  assert.deepEqual(a('livre', { canAssign: true }), ['claim', 'assign']);
  assert.deepEqual(a('minha-fila'), ['start', 'release']);
  assert.deepEqual(a('minha-fila', { repo: 'other' }), ['openproj', 'release']);
  assert.deepEqual(a('minha-fila', { repo: 'none' }), ['start!', 'release'], 'projeto fora deste computador: Iniciar desabilitado');
  assert.deepEqual(a('minha-rev'), ['review']);
  assert.deepEqual(a('minha-roda', { local: true }), ['term']);
  assert.deepEqual(a('colega'), ['view'], 'cartão de colega não se toma — membro só vê');
  assert.deepEqual(a('colega', { canAssign: true }), ['view', 'assign'], 'líder/admin reatribui');
  assert.deepEqual(a('colega-roda', { canAssign: true }), ['view'], 'rodando: nem o líder troca (0032 recusa)');
  assert.deepEqual(a('entregue', { canAssign: true }), ['entrega']);
  const lab = C.caAcoes(by('livre'), { me: 'eu', canAssign: true }, fn).map((y) => y.label);
  assert.deepEqual(lab, ['Assumir', 'atribuir…']);
});

test('linha do épico: x/y entregues, pra revisar, travadas e livres sobre TODAS as tarefas dele', () => {
  const ts = tasks.filter((t) => t.team_id === 'T1');
  const n = C.caEpicoLinha({ id: 'E1' }, ts, fn);
  assert.equal(n.ent, 1); assert.equal(n.tot, ts.length - 1, 'cancelada fica fora da conta');
  assert.equal(n.prontas, 1); assert.equal(n.travadas, 1); assert.equal(n.livres, 1);
  assert.deepEqual(n.projetos, ['P1']);
});

test('costuras: a Central usa as fontes únicas (sem lógica nova de assumir/atribuir/custo/entregas)', () => {
  for (const f of ['tsClaimOnly(', 'tsReassign(', 'tsRelease(', 'teamClaimStart(', 'entregasHtml(', 'entregasWire(', 'entPodeVerCusto()', 'entAgrupa(', 'teamFetch(', 'ctStLabel(', 'stColor(', 'tsAv(', 'openTaskMenu(', 'tsIssueChip(', 'trkCardRetry(']) assert.ok(S71.includes(f), f);
  assert.ok(!/sbRpc\(|sbFetch\(|sbGet\(/.test(S71), 'o 71 não fala com a nuvem direto — só pelo teamFetch e pelas ações do 43');
  assert.ok(!/localStorage\./.test(S71), 'memória por pessoa via lsGet/lsSet + userKey');
  assert.match(S71, /userKey\('ca:scope'/); assert.match(S71, /userKey\('ca:tab'/);
  const s22 = read('js/22-quadro-fluxo.js');
  assert.match(s22, /caFiltersOwn\(el\)/); assert.match(s22, /caBodyOwn\(el\)/); assert.match(s22, /caHead\(\{ sum, scopeLabel:scope \}\)/); assert.match(s22, /caMinhasHtml\(flowScope\)/);
  assert.match(read('js/66-central-tabela.js'), /\(L\.post\|\|''\)/, 'a tabela mexida no lugar mantém as seções do time no fim');
  const s42 = read('js/42-nuvem-sync-mobile.js');
  assert.match(s42, /function tmWhoPick\(anchor, cur, onPick, tid\)/, 'a lista de responsáveis é do time DO CARTÃO');
  assert.match(s42, /caFromTeamScope\(tmScope\)/, 'o alcance do Time e o da Central são o mesmo dado');
  const s43 = read('js/43-espaco-times.js');
  assert.match(s43, /\}, ct\.team_id\); \}\);/); assert.match(s43, /tmCanAssignNow\(t\.team_id\)/);
  assert.match(s43, /sem issue · tentar de novo/);
  const s70 = read('js/70-time-entregas.js');
  assert.match(s70, /function entregasWire\(el, onChange\)/); assert.match(s70, /ctx&&ctx\.noTitle/);
  
  const html = read('index.html');
  assert.ok(html.indexOf('js/70-time-entregas.js') < html.indexOf('js/71-central-alcance.js'), '71 depois do 70');
  assert.ok(html.includes('css/99-central-alcance.css'));
});

test('"Com o time" (46) só esconde a livre que aparece em "Livres no seu time" — nunca some das duas', () => {
  const src = read('js/46-epico-time.js');
  const fnSrc = cut(src, '// @ct-sent-inicio', '// @ct-sent-fim') + cut(src, 'function ctSentHtml(scope){', 'window.ctSentHtml=ctSentHtml;');
  const run = (caFreeShown) => new Function('ctSent', 'flowSecCollapsed', 'flowQuery', 'flowEpic', 'flowSecHead', 'cloudUserId', 'ctStLabel', 'tsSt', 'trkCardLink', 'epNameOf', 'tsAv', 'tsOnline', 'tmName', 'stColor', 'esc', 'escA', 'agoTx', 'IC', 'caFreeShown', fnSrc + '\nreturn ctSentHtml("exec");')(
    { rows: [{ id: 'livre', title: 'livre', created_by: 'eu', status: 'backlog', spec: { dispatch: 'team' } }, { id: 'comana', title: 'com Ana', created_by: 'eu', assignee: 'ana', status: 'running', spec: {} }] },
    () => false, '', 'all', (k, l, n) => `<h>${l} ${n}</h>`, () => 'eu', () => 'st', () => 'running', () => null, () => '', () => '', () => false, (u) => u, () => '#000', String, String, () => 'agora', {}, caFreeShown);
  const sem = run(undefined);
  assert.match(sem, /data-ctsent="livre"/); assert.match(sem, /data-ctsent="comana"/);
  const carregada = run(() => true);
  assert.doesNotMatch(carregada, /data-ctsent="livre"/, 'mostrada em Livres no seu time'); assert.match(carregada, /data-ctsent="comana"/);
  const semDado = run(() => false);
  assert.match(semDado, /data-ctsent="livre"/, 'time ainda não carregou (ou erro): continua no Com o time');
});

test('responsável é escolhido no time DO CARTÃO (Org toda)', () => {
  const s42 = read('js/42-nuvem-sync-mobile.js');
  const pure = cut(s42, '// @time-resp-inicio', '// @time-resp-fim');
  const glue = ['function tmTeamMembers(', 'function tmProfiles(', 'function tmCanAssignNow(', 'function tmAssignOptsNow('].map((h) => { const i = s42.indexOf(h); return s42.slice(i, s42.indexOf('\n', i)); }).join('\n');
  const cloudData = { meRole: 'member', teamMembers: { T1: [{ user_id: 'eu', role: 'member' }, { user_id: 'ana', role: 'member' }], T2: [{ user_id: 'eu', role: 'lead' }, { user_id: 'leo', role: 'member' }] }, profileByUser: { eu: { name: 'Eu' }, ana: { name: 'Ana' }, leo: { name: 'Leo' } } };
  const M = new Function('cloudData', 'cloudTeamId', 'cloudUserId', 'teamProfiles', pure + glue + '\nreturn { tmTeamMembers, tmCanAssignNow, tmAssignOptsNow };')(cloudData, () => 'T1', () => 'eu', {});
  assert.deepEqual(M.tmTeamMembers().map((m) => m.user_id), ['eu', 'ana'], 'sem time = o escolhido');
  assert.deepEqual(M.tmTeamMembers('T2').map((m) => m.user_id), ['eu', 'leo']);
  assert.equal(M.tmCanAssignNow(), false, 'no T1 sou membro');
  assert.equal(M.tmCanAssignNow('T2'), true, 'no T2 sou líder');
  assert.deepEqual(M.tmAssignOptsNow('T2').map((o) => o.label), ['Livre', 'Eu', 'Leo']);
  assert.deepEqual(M.tmAssignOptsNow().map((o) => o.label), ['Livre', 'Eu'], 'membro: só livre ou eu');
});

test('sem rolagem horizontal: colunas somem por prioridade (container query) e a tabela é de layout fixo', () => {
  const css = read('css/99-central-alcance.css');
  assert.match(css, /\.ca-wrap\{container-type:inline-size/); assert.match(css, /\.ca-sec\{container-type:inline-size\}/);
  assert.match(css, /table-layout:fixed/);
  // ordem de saída: atividade → requisitos → custo → issue → com (cada uma num degrau MENOR que a anterior)
  const at = (c) => { const m = css.match(new RegExp('@container \\(max-width: (\\d+)px\\)\\{[^\\n]*\\.ca-tbl \\.' + c + '[,{ ][^\\n]*display:none')); assert.ok(m, c); return +m[1]; };
  const w = ['c-atv', 'c-req', 'c-cus', 'c-iss', 'c-com'].map(at);
  assert.deepEqual([...w].sort((a, b) => b - a), w);
});

test('RLS (migrations): membro e líder que não é admin só leem o próprio time; admin da org lê todos — nada mudou', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  assert.match(all, /create or replace function can_see_team\(p_team uuid\)[\s\S]*?select is_team_member\(p_team\) or is_org_admin\(org_of_team\(p_team\)\);/);
  assert.match(all, /role in \('owner','admin'\)/, 'is_org_admin = owner/admin');
  for (const t of ['tasks', 'epics', 'projects', 'teams', 'team_members']) assert.match(all, new RegExp('create policy \\w+ on ' + t + ' for select using \\(can_see_team\\('), t);
  assert.ok(!/drop policy if exists tasks_select/.test(all), 'ninguém afrouxou o select de tasks depois da 0001');
});
