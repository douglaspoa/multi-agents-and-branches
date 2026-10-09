// Painel de Issues LIGADO (mesa 09/10 D2/D3): vínculo nas duas pontas (cartão do time incluso), filtros, status no painel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const L = new Function(cut(read('14-issues-projeto.js'), '// @puro-trklig-inicio', '// @puro-trklig-fim')
  + '\nreturn { trkCodeFromUrl, trkCodeOfCard, trkLinkIdx, trkWantKind, trkStatusForKind, trkKindOfStatus, trkShouldMove, trkRowOf, trkRowsFilter };')();
const ISS = [{ code: 'FND-101', url: 'https://t.exemplo.dev/i/FND-101' }, { code: 'FND-103' }, { code: 'FND-110' }];
const codeOfLocal = (t) => (t.branch.match(/\b([A-Z]{2,10}-\d+)\b/) || [])[1] || null;

test('índice: tarefa local e o cartão dela são UMA entrada; cartão de colega entra pela spec ou pela URL', () => {
  const tasks = [{ id: 'qr-1', branch: 'feat/FND-101-qr', status: 'running' }, { id: 'sem-1', branch: 'feat/sem', status: 'running' }];
  const cards = [{ id: 'c1', spec: { issueCode: 'FND-101' } }, { id: 'c2', spec: {}, issue_url: 'https://t.exemplo.dev/i/FND-101' }, { id: 'c3', spec: { issueCode: 'FND-103' }, assignee: 'bruno' }, { id: 'c4', spec: { issue: 'FND-110' } }];
  const idx = L.trkLinkIdx(ISS, tasks, cards, { 'qr-1': 'c1', 'sem-1': 'c4' }, codeOfLocal);
  assert.equal(idx.get('FND-101').length, 2, 'qr-1+c1 (uma) e c2 (outra, pela URL)');
  assert.equal(idx.get('FND-101')[0].local.id, 'qr-1'); assert.equal(idx.get('FND-101')[0].card.id, 'c1');
  assert.equal(idx.get('FND-103')[0].card.id, 'c3', 'cartão de colega aparece na issue');
  assert.equal(idx.get('FND-110')[0].local.id, 'sem-1', 'tarefa sem código na branch herda o código do cartão dela');
});

test('status no painel: rodando → em andamento; pronta/PR → em revisão SÓ se o conector tem; integrada → feito; nunca reabre', () => {
  assert.equal(L.trkWantKind({ status: 'running' }), 'doing');
  assert.equal(L.trkWantKind({ status: 'review' }), 'review');
  assert.equal(L.trkWantKind({ status: 'running', prUrl: 'x' }), 'review');
  assert.equal(L.trkWantKind({ status: 'merged' }), 'done');
  assert.equal(L.trkWantKind({ status: 'backlog' }), null);
  const comRev = [{ id: 'todo', kind: 'todo' }, { id: 'doing', label: 'Fazendo', kind: 'doing' }, { id: 'rev', label: 'Em revisão', kind: 'doing' }, { id: 'done', kind: 'done' }];
  const semRev = [{ id: 'todo', kind: 'todo' }, { id: 'doing', kind: 'doing' }, { id: 'done', kind: 'done' }];
  assert.equal(L.trkStatusForKind(comRev, 'review').id, 'rev');
  assert.equal(L.trkStatusForKind(comRev, 'doing').id, 'doing', '"em revisão" não vale como em andamento');
  assert.equal(L.trkStatusForKind(semRev, 'review'), null, 'sem revisão no conector: não mexe');
  assert.equal(L.trkStatusForKind([{ id: 'r', kind: 'review' }], 'review').id, 'r');
  assert.equal(L.trkKindOfStatus(comRev, 'rev'), 'review');
  assert.equal(L.trkShouldMove('done', 'doing'), false);
  assert.equal(L.trkShouldMove('review', 'doing'), true, 'voltou a rodar');
  assert.equal(L.trkShouldMove('blocked', 'doing'), false);
  assert.equal(L.trkShouldMove('doing', 'doing'), false);
});

test('linha + filtros: Com tarefa / Sem tarefa / Comigo (painel OU Starfork) / período pela modificação', () => {
  const k = { me: 'eu', myEmail: 'eu@exemplo.dev', modOf: (i) => i.mod };
  const rows = [
    L.trkRowOf({ code: 'A-1', mod: 500 }, [{ local: null, card: { assignee: 'eu', status: 'running' } }], k),
    L.trkRowOf({ code: 'A-2', mod: 400, assigneeEmail: 'EU@exemplo.dev' }, [], k),
    L.trkRowOf({ code: 'A-3', mod: 50 }, [{ local: null, card: { assignee: 'bruno', status: 'review', pr_url: 'https://github.com/x/y/pull/9' } }], k),
    L.trkRowOf({ code: 'A-4', mod: 450 }, [{ local: { id: 'l', status: 'running' }, card: null }], k),
  ];
  assert.deepEqual([rows[0].mineWhy, rows[1].mineWhy, rows[2].mineWhy, rows[3].mineWhy], ['starfork', 'painel', '', 'starfork']);
  assert.equal(rows[2].pr, 'https://github.com/x/y/pull/9');
  const ids = (f, o) => L.trkRowsFilter(rows, f, o).map((r) => r.i.code);
  assert.deepEqual(ids('linked'), ['A-1', 'A-3', 'A-4']);
  assert.deepEqual(ids('unlinked'), ['A-2']);
  assert.deepEqual(ids('mine'), ['A-1', 'A-2', 'A-4']);
  assert.deepEqual(ids('all', { range: { from: 100, to: 600 } }), ['A-1', 'A-2', 'A-4'], 'fora do período sai');
  const cancel = L.trkRowOf({ code: 'B', mod: 1 }, [{ card: { status: 'cancelled', assignee: 'x' } }, { card: { status: 'running', assignee: 'eu' } }], k);
  assert.equal(cancel.who, 'eu', 'o vínculo vivo vence o cancelado'); assert.equal(cancel.more, 1);
});

test('as telas: lista do mock, "mandar pro time" com o fluxo do #141, vínculo nas duas pontas, falha com selo e motivo', () => {
  const S = read('14-issues-projeto.js');
  for (const s of ["['code','Issue'],['epic','Épico'],['task','Tarefa no Starfork'],['who','Com'],['st','Situação'],['pr','PR · provas'],['mod','Atualizada']", "chip('unlinked','Sem tarefa'", "chip('mine','Comigo'", "periodPickerHtml('issues'", "sortRows(rows, r=>r.mod, sort, trkSortVal)", 'data-trkact="team"', 'await ntShareSync()', 'trkCardIssueSet(', "kind:'edited', body:code?'ligou a issue '", 'trkSyncSeloHtml(i.code)', "toast(fails.length===1?'Não atualizei '", "sortReset('issues')"]) assert.ok(S.includes(s), s);
  assert.ok(read('42-nuvem-sync-mobile.js').includes("payload.issue?{ issueCode:payload.issue }:{}"), 'cartão "realizar eu mesmo" leva a issue');
  assert.ok(!/console\.warn\('responsável na issue'/.test(S), 'falha do responsável no painel não fica calada');
});

// o laço de sincronia DE VERDADE (recortado do 14) com painel e nuvem falsos: anda, falha com selo + 1 aviso, volta
test('sincronia: em revisão quando há PR; falha = selo + UM aviso por transição; sucesso limpa; código vindo só do cartão também anda', async () => {
  const S = read('14-issues-projeto.js');
  const body = S.slice(S.indexOf('async function trkSyncTasks(force){'), S.indexOf('// TODA criação de tarefa passa aqui'));
  const pure = cut(S, '// @puro-trklig-inicio', '// @puro-trklig-fim');
  const W = { calls: [], toasts: [], acts: [], fail: false, log: {} };
  const statuses = [{ id: 'todo', kind: 'todo' }, { id: 'doing', label: 'Fazendo', kind: 'doing' }, { id: 'rev', label: 'Em revisão', kind: 'doing' }, { id: 'done', label: 'Feito', kind: 'done' }];
  const env = {
    trk: { rules: { syncStatus: true }, connector: { ops: { updateStatus: {} }, statuses } },
    state: { tasks: [{ id: 'qr-1', branch: 'feat/FND-101-qr', status: 'running', prUrl: 'https://github.com/x/y/pull/9' }, { id: 'sem-1', branch: 'feat/sem', status: 'running' }] },
    teamTasks: [{ id: 'c4', spec: { issueCode: 'FND-110' } }],
    trkIssues: [{ code: 'FND-101', id: '1', status: 'doing' }, { code: 'FND-110', id: '2', status: 'todo' }],
  };
  const make = new Function('env', 'W', pure + `
    let trkSyncAt=0, trkNextAt=0, trkIssuesAt=Date.now(), trkMine={}; const trkSyncErr={};
    const trk=env.trk, state=env.state, teamTasks=env.teamTasks, trkIssues=env.trkIssues, SB={ sess:()=>({}) };
    const trkLoad=async()=>{}, trkReady=()=>true, trkProjectOn=async()=>true, trkFetchIssues=async()=>{}, trkBgRepaint=()=>{};
    const trkBgRun=async(fn)=>{ await fn(); return true; };
    const trkTaskCode=(t)=>(t.branch.match(/\\b([A-Z]{2,10}-\\d+)\\b/)||[])[1]||null, tmap=()=>({ 'sem-1':'c4', 'qr-1':'c1' });
    const trkErrText=(e)=>e.message, cloudUserId=()=>'eu';
    const trkCall=async(op, a)=>{ W.calls.push(a.code+'→'+a.status); if(W.fail) throw new Error('HTTP 503'); };
    const toast=(m)=>W.toasts.push(m), sbPost=async(t, r)=>{ W.acts.push(r.body); };
    const trkSyncLogPut=(c, r)=>{ W.log[c]=r; };
    ` + body + '\nreturn { trkSyncTasks, trkSyncRetry, err:()=>trkSyncErr };');
  const M = make(env, W);
  await M.trkSyncTasks(true);
  assert.deepEqual(W.calls.sort(), ['FND-101→rev', 'FND-110→doing'], 'PR aberto → "Em revisão"; tarefa cujo código vem do cartão também anda');
  assert.deepEqual(W.acts.sort(), ['FND-101 → “Em revisão” no painel', 'FND-110 → “Fazendo” no painel']);
  env.state.tasks[0].status = 'merged'; W.fail = true; W.calls = [];
  await M.trkSyncTasks(true); await M.trkSyncTasks(true);
  assert.equal(W.toasts.length, 1, 'mesma transição falhando de novo não repete o aviso');
  assert.match(W.toasts[0], /Não atualizei FND-101 no painel \(“Feito”\): HTTP 503/);
  assert.equal(M.err()['FND-101'].why, 'HTTP 503', 'selo com o motivo');
  W.fail = false; await M.trkSyncTasks(true);
  assert.equal(M.err()['FND-101'], undefined, 'deu certo: o selo sai');
  assert.equal(env.trkIssues[0].status, 'done');
  env.state.tasks[1].status = 'error'; await M.trkSyncTasks(true);
  assert.equal(env.trkIssues[1].status, 'doing', 'tarefa com erro não mexe no painel');
});

test('"realizar eu mesmo" grava a issue no cartão e "mandar pro time" leva o responsável pro painel', async () => {
  const S42 = read('42-nuvem-sync-mobile.js');
  const fnOf = (h) => { const i = S42.indexOf(h); return S42.slice(i, S42.indexOf('\n}\n', i) + 3); };
  const posted = [];
  const pub = new Function('W', `const SB={ sess:()=>({}) }, cloudTeamId=()=>'T', cloudUserId=()=>'eu', cloudEnsureProject=async()=>({ id:'P' });
    const sbPost=async(t, r)=>{ W.push([t, r]); return [{ id:'c9', ...r }]; }, tmapSet=()=>{}, ntEpicVal=()=>null; let teamTasks=[]; const window={};
    function cloudSpecOf(p){ const s=Object.assign({}, p||{}); delete s.advisor; return s; }
    ${fnOf('async function cloudPublishSelf(')} return cloudPublishSelf;`)(posted);
  await pub('qr-1', { title: 'QR', issue: 'FND-101', issueUrl: 'https://t.exemplo.dev/FND-101' });
  const row = posted.find((x) => x[0] === 'tasks')[1];
  assert.equal(row.spec.issueCode, 'FND-101'); assert.equal(row.issue_url, 'https://t.exemplo.dev/FND-101');
  const L = new Function(cut(read('14-issues-projeto.js'), '// @puro-trklig-inicio', '// @puro-trklig-fim') + '\nreturn trkCodeOfCard;')();
  assert.equal(L(row, []), 'FND-101', 'o painel acha a tarefa pelo cartão');
  assert.match(S42, /await cloudAssign\(rows\[0\]\.id, who\); rows\[0\]\.assignee=who; if\(typeof trkCardAssign==='function'\) trkCardAssign\(rows\[0\], who\);/);
});
