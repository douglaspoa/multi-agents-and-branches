// TIME ATIVO (bug do dono 09/10): líder em 3 times não tinha como alternar; aba "Quadro 129" com colunas 1/0/0/3;
// período escondido. 74 @puro-ta-* + as costuras com 08/14/42/43/68/70/71/72 e o index.
// `node --test app/tests/time-ativo.test.mjs` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const S74 = read('js/74-time-ativo.js');
const P = new Function(cut(S74, '// @puro-ta-inicio', '// @puro-ta-fim')
  + '\nreturn { taTeamsOf, taRoleLabel, taShort, taMyTeamIds, perAbertoOuNoPeriodo, perNoTx, perContaTx };')();

// nomes fictícios (repo público)
const T = { a: 'tm-a', b: 'tm-b', c: 'tm-c', d: 'tm-d' };
const teams = [{ id: T.a, name: 'Produto' }, { id: T.b, name: 'Plataforma' }, { id: T.c, name: 'Dados' }, { id: T.d, name: 'Financeiro' }];
const teamMembers = {
  [T.a]: [{ user_id: 'lider', role: 'lead' }, { user_id: 'membro', role: 'member' }, { user_id: 'dono', role: 'lead' }],
  [T.b]: [{ user_id: 'lider', role: 'lead' }],
  [T.c]: [{ user_id: 'lider', role: 'lead' }, { user_id: 'x', role: 'member' }],
  [T.d]: [{ user_id: 'y', role: 'member' }],
};

test('lista de times: líder em 3 times vê os 3 com papel e contagem — nunca o id', () => {
  // a RLS só devolve os times dele; mesmo que viesse um a mais, membro comum não vê time em que não está
  const L = P.taTeamsOf({ teams, teamMembers, meRole: 'member' }, 'lider');
  assert.deepEqual(L.map((t) => t.name), ['Dados', 'Plataforma', 'Produto'], 'A→Z');
  assert.deepEqual(L.map((t) => t.role), ['lead', 'lead', 'lead']);
  assert.equal(P.taShort(L[2]), 'líder · 3 pessoas');
  assert.equal(P.taShort(L[1]), 'líder · 1 pessoa');
  for (const t of L) assert.ok(!P.taShort(t).includes(t.id), 'o texto nunca leva o id');
});

test('lista de times: membro de 1 time vê 1 (chip simples); owner/admin vê todos, "admin da org" nos que não é membro', () => {
  assert.deepEqual(P.taTeamsOf({ teams, teamMembers, meRole: 'member' }, 'membro').map((t) => [t.name, t.role]), [['Produto', 'member']]);
  const A = P.taTeamsOf({ teams, teamMembers, meRole: 'owner' }, 'dono');
  assert.deepEqual(A.map((t) => [t.name, t.role]), [['Produto', 'lead'], ['Dados', 'admin'], ['Financeiro', 'admin'], ['Plataforma', 'admin']], 'os meus primeiro, depois os da org');
  assert.equal(P.taRoleLabel('admin'), 'admin da org');
  assert.deepEqual(P.taTeamsOf(null, 'x'), []);
  assert.deepEqual(P.taTeamsOf({ teams: [{ id: 'z', name: '  ' }], teamMembers: { z: [{ user_id: 'u', role: 'member' }] } }, 'u')[0].name, 'time sem nome');
});

test('Minhas junta os times em que EU estou (não os que só enxergo como admin)', () => {
  assert.deepEqual(P.taMyTeamIds({ teamMembers }, 'lider'), [T.a, T.b, T.c].sort());
  assert.deepEqual(P.taMyTeamIds({ teamMembers }, 'dono'), [T.a]);
  assert.deepEqual(P.taMyTeamIds(null, 'x'), []);
});

test('período do quadro: em aberto sempre; concluída/cancelada só se mexeu no período (o "Quadro 129")', () => {
  const r = { from: 1000, to: 2000 };
  const fn = { delivered: (t) => t.st === 'merged', fora: (t) => t.st === 'cancelled', mod: (t) => t.m };
  const list = [
    { id: 'aberta-velha', st: 'backlog', m: 10 }, { id: 'rodando', st: 'running', m: 1500 },
    { id: 'entregue-agora', st: 'merged', m: 1500 }, { id: 'entregue-velha', st: 'merged', m: 10 },
    { id: 'cancelada-velha', st: 'cancelled', m: 10 }, { id: 'cancelada-agora', st: 'cancelled', m: 1999 },
    { id: 'entregue-sem-data', st: 'merged', m: 0 }, { id: 'fim-exclusivo', st: 'merged', m: 2000 },
  ];
  assert.deepEqual(P.perAbertoOuNoPeriodo(list, r, fn).map((t) => t.id), ['aberta-velha', 'rodando', 'entregue-agora', 'cancelada-agora']);
  // 129 cartões, 125 concluídas antigas → a aba e as colunas contam 4 (antes: aba 129, colunas 1/0/0/3)
  const muitos = [...Array(125)].map((_, i) => ({ id: 'v' + i, st: 'merged', m: 5 })).concat([{ id: 'f', st: 'backlog', m: 1 }, { id: 'r', st: 'running', m: 1200 }, { id: 'p', st: 'review', m: 1300 }, { id: 'q', st: 'review', m: 1400 }]);
  const vis = P.perAbertoOuNoPeriodo(muitos, r, fn);
  assert.equal(vis.length, 4);
  assert.equal(P.perContaTx(muitos.length, vis.length, P.perNoTx({ key: '7d' })), '4 de 129 · em aberto e concluídas nos últimos 7 dias');
  assert.equal(P.perContaTx(4, 4, 'hoje'), '', 'quando bate, sem texto');
});

test('período no meio da frase', () => {
  assert.equal(P.perNoTx({ key: 'hoje' }), 'hoje');
  assert.equal(P.perNoTx('ontem'), 'ontem');
  assert.equal(P.perNoTx({ key: '30d' }), 'nos últimos 30 dias');
  assert.equal(P.perNoTx({ key: 'mes' }), 'neste mês');
  assert.equal(P.perNoTx({ key: 'custom' }, '05/10–09/10'), 'em 05/10–09/10');
});

// ---------------- costuras (o código real das telas) ----------------
const S43 = read('js/43-espaco-times.js'), S68 = read('js/68-casca-g1.js'), S71 = read('js/71-central-alcance.js');
const S72 = read('js/72-kanban.js'), S70 = read('js/70-time-entregas.js'), S14 = read('js/14-issues-projeto.js');
const S42 = read('js/42-nuvem-sync-mobile.js'), S08 = read('js/08-periodo.js'), IDX = read('index.html');

test('página Time: o chip "Time · X" é o seletor do time ativo (botão + menu por teclado)', () => {
  const f = cut(S68, 'function timeHeadPaint(){', '\n}');
  assert.match(f, /teamPickHtml\(\{ ctx:'time' \}\)/);
  assert.match(f, /pageHead\(\{ title:'Time', sum, afterTitle:pick \}\)/, 'slot do pageHead (00-util), não .replace no HTML');
  assert.match(read('js/00-util.js'), /<\/h1>\$\{o\.afterTitle\|\|''\}/);
  assert.match(S74, /aria-haspopup="menu"/);
  assert.match(S74, /role="menuitemradio" aria-checked=/);
  assert.match(S74, /menuWire\(pop, anchor\)/, 'setas, Esc e Tab = o menu padrão do app (22 menuWire)');
  assert.match(S74, /e\.key!=='ArrowDown'/, 'seta pra baixo no botão abre o menu');
  assert.match(S74, /L\.length<2\) return `<span class="pgh-scope tapick-one"/, 'um time só = chip simples');
});

test('trocar o time: UMA porta (teamActiveSet) — grava por pessoa, limpa o time velho e redesenha tudo sem recarregar', () => {
  const f = cut(S74, 'function teamActiveSet(', '\n}');
  assert.match(f, /lsSet\('sb:team', tid\)/);
  assert.match(f, /userKey\('sb:team', me\)/, 'lembrado por pessoa (40-conta-escopo devolve na troca de conta)');
  for (const k of ['teamTasks=null', 'teamEpics=[]', 'CA.last=null', 'ctSent=', 'entProvas=', "lsSet('tmEpic','')", "lsSet('tmDev','')", 'trkLoad(true)', 'TA.mine=null'])
    assert.ok(f.includes(k), 'limpa ' + k);
  const r = cut(S74, 'function taRepaint(){', '\n}');
  for (const k of ['timeHeadPaint', 'renderTeamBoard', 'caRerender', 'ntShareSync', 'renderPlanner', 'issRender', 'meSync'])
    assert.ok(r.includes(k), 'redesenha ' + k);
  assert.doesNotMatch(f + r, /location\.reload/);
  // ninguém mais grava o time por fora (a Central tinha um <select id="caTeam"> próprio)
  assert.doesNotMatch(S71, /caTeam|lsSet\('sb:team'/);
  assert.match(cut(S71, 'function caHead(', '\n}'), /teamPickHtml\(\{ ctx:'central' \}\)/);
});

test('troca no meio da busca: a resposta do time velho não vira o quadro do time novo', () => {
  const f = cut(S42, 'async function teamFetchRun(){', '\n}');
  assert.match(f, /const same=\(\)=>cloudTeamId\(\)===teamId && tsScopeTeamIds\(\)\.join\(','\)===ids\.join\(','\)/);
  assert.match(f, /if\(!same\(\)\) return; \/\/ nada do time velho é gravado[\s\S]*teamTasks=tasks;/, 'tudo grava junto depois do último await');
  assert.match(S42, /if\(teamFetchP\.__key===teamFetchKey\(\)\) return teamFetchP; return teamFetchP\.catch/, 'a busca em voo do time velho não serve pro novo');
  assert.match(f, /taMineProj\(\)/, 'os projetos dos meus outros times continuam conhecidos');
});

test('Central › Minhas junta TODOS os meus times, com a etiqueta do time em cada linha (limitação do #145)', () => {
  assert.match(cut(S71, 'function caTasks(', '\n'), /scope==='minhas'&&typeof caMineSrc==='function'\?caMineSrc\(\)/);
  const m = cut(S71, 'function caMinhasHtml(', '\nwindow.caMinhasHtml');
  assert.match(m, /caMineSrc\(\)/);
  assert.match(m, /team:multi/);
  assert.match(m, /Livres nos seus times/);
  assert.match(cut(S72, 'function kbCentralMinhasHtml(', '\n}'), /caMineSrc\(\)[\s\S]*tag:multi/, 'o quadro da Minhas também');
  assert.match(cut(S71, 'function caTaskById(', '\n'), /caMineSrc/, 'as ações acham a linha de outro time');
  const f = cut(S74, 'function taMineFetch(', '\n}');
  assert.match(f, /if\(ids\.length<2/, 'um time só: o teamFetch já basta');
  assert.match(f, /team_id=in\./);
});

test('contadores: a aba conta o MESMO conjunto que a tela mostra', () => {
  const b = cut(S43, 'function renderTeamBoard(){', '\n// itens do "pronto quando"');
  assert.match(b, /\['board','Quadro',String\(visP\.length\)\]/, 'Quadro = os cartões das colunas (antes: vis.length = tudo de sempre)');
  assert.match(b, /kbTeamBoardHtml\(visP\)/);
  assert.match(b, /perContaTx\(vis\.length, visP\.length, perNo\)/, 'a diferença proposital vira texto');
  assert.match(b, /entTabN\(\{ all, members \}\)/, 'Entregas = os itens da lista');
  assert.doesNotMatch(b, /tmPeriod|#tbPeriod|id="tbPeriod"/, 'o período próprio do Time (7/30/90/tudo) saiu');
  const h = cut(S71, 'function caHead(', '\n}');
  assert.match(h, /caPer\(caTasks\(/);
  assert.match(h, /caEpPer\(/);
  assert.match(h, /entTabN\(/);
  assert.match(cut(S70, 'function entregasHtml(', '\n}'), /entConjunto\(all, f, modo, r\)/, 'lista e número da aba saem da mesma função');
  const i = cut(S14, 'function issRender(){', '\n}');
  assert.match(i, /\['board','Quadro',ready\?\(nPer!=null\?nPer:trkIssues\.length\):null\]/, 'Issues: a aba conta o período, o resumo diz o total');
  assert.match(i, /no painel · <b>\$\{nPer\}<\/b>/);
});

test('período visível em toda tela que filtra por data (Time, Central, Entregas, Issues) e com cara de controle', () => {
  const b = cut(S43, 'function renderTeamBoard(){', '\n// itens do "pronto quando"');
  assert.match(b, /const perSel=periodPickerHtml\('time', tsPer\(\)\);/);
  for (const v of ['Quadro do time', 'PRs pra revisar', 'Atividade do time']) assert.ok(new RegExp(v + '</h1><div class="tssub">\\$\\{perSel\\}').test(b), v);
  assert.match(b, /periodPickerWire\(el,/);
  assert.match(cut(S71, 'function caFiltersOwn(', '\nwindow.caFiltersOwn'), /periodPickerHtml\('time', null, 'central'\)[\s\S]*tab==='epicos'[\s\S]*periodPickerHtml\('time', null, 'central'\)/);
  assert.match(cut(S08, 'function periodPickerHtml(', '\n}'), /perpick-ic/, 'ícone de calendário');
  assert.match(read('css/99-time-ativo.css'), /select\.sel\{background-image:linear-gradient/, 'a seta do <select> volta (o refino zerava com o shorthand background)');
  assert.match(S14, /periodPickerHtml\('issues', per\)/);
});

test('Issues: o painel é do time ativo — time sem painel não herda o de outro time pela cópia local', () => {
  const f = cut(S14, 'async function trkLoad(', '\n}');
  assert.match(f, /_team:cloudTeamId\(\)/);
  assert.match(f, /loc\._team===cloudTeamId\(\)/);
  assert.match(cut(S14, 'async function trkSave(', '\n}'), /_team:cloudTeamId\(\)/);
});

test('Mandar pro time / épico: o time de destino quando há mais de um (padrão = time ativo)', () => {
  assert.match(IDX, /id="ntDestTeamRow"/);
  assert.equal((IDX.match(/id="ntTeamRow"/g) || []).length, 1, 'sem id repetido (o ntTeamRow é da equipe de agentes)');
  assert.match(cut(S43, 'function ntDestTeamPaint(', '\n}'), /teamActiveList\(\)\.length>1[\s\S]*teamPickHtml\(\{ ctx:'nova', prefix:false \}\)/);
  assert.match(S43, /teamEpics\.filter\(e=>!e\.team_id\|\|e\.team_id===cloudTeamId\(\)\)/, 'épicos da lista = os do time de destino');
  assert.match(read('js/32-planner.js'), /teamPickHtml\(\{ ctx:'plan', prefix:false \}\)/);
});

test('index carrega o módulo e o CSS', () => {
  assert.match(IDX, /<script src="js\/74-time-ativo\.js"><\/script>\n<script src="js\/99-e2e\.js">/);
  assert.match(IDX, /css\/99-time-ativo\.css/);
});

// ---------------- execução (não só o texto): dublês no lugar da nuvem e do DOM ----------------
const defer = () => { let r; const p = new Promise((x) => { r = x; }); return { p, r }; };
test('trocar de time com a busca do time velho no meio: a resposta velha é descartada e o time NOVO é buscado', async () => {
  const code = cut(S42, 'let teamFetchP=null;', '// nome de quem criou/assumiu');
  const env = { team: 'A', calls: [], pend: [] };
  const box = {};
  const f = new Function('env', 'box', `
    let teamTasks=null, teamFetchedAt=0, teamFetching=false, teamEpics=[], teamActivity=[], teamProj={}, teamProfiles={}, teamRepoRemote='', teamRepoIds=null, cloudData=null;
    const cloudTeamId=()=>env.team, tsScopeTeamIds=()=>[env.team], tsOrgScope=()=>false, taMineProj=()=>({});
    const sbGet=(q)=>{ env.calls.push(q); if(q.startsWith('tasks')){ const d={}; d.p=new Promise(r=>{ d.r=r; }); env.pend.push({ team:env.team, d }); return d.p; } return Promise.resolve([]); };
    const repoRemoteIds=async()=>({ remote:'r' }), localRemoteIdsList=async()=>[];
    ${code}
    box.fetch=teamFetch; box.get=()=>teamTasks;`);
  f(env, box);
  const p1 = box.fetch(true);
  await new Promise((r) => setTimeout(r, 0));
  env.team = 'B'; // trocou de time com a busca do A em voo
  const p2 = box.fetch(true);
  env.pend[0].d.r([{ id: 'a1', team_id: 'A' }]); // a resposta do A chega depois da troca
  await p1; await new Promise((r) => setTimeout(r, 5));
  assert.equal(box.get(), null, 'nada do time A vira o quadro do B');
  assert.equal(env.pend.length, 2, 'buscou de novo, agora o B');
  assert.equal(env.pend[1].team, 'B');
  env.pend[1].d.r([{ id: 'b1', team_id: 'B' }]);
  await p2;
  assert.deepEqual(box.get().map((t) => t.id), ['b1']);
});

test('Issues: a cópia local do painel só vale pro time dela (ou com a nuvem fora do ar)', async () => {
  const code = cut(S14, 'async function trkLoad(', '\nasync function trkSave');
  const run = async ({ cloud, local, team = 'B', teams = 2 }) => {
    const f = new Function('o', `let trk=null, trkLoadedFor=null; const TRK_RULES={};
      const trkBlank=()=>({ name:'', connector:null, rules:{} }); const SB={ sess:()=>true }; const cloudTeamId=()=>o.team;
      const trkCloudOn=()=>true; const teamActiveList=()=>Array.from({ length:o.teams });
      const sbGet=async()=>{ if(o.cloud==='erro') throw new Error('fora do ar'); return o.cloud; };
      const invoke=async(c)=>c==='tracker_local_get'?o.local:null;
      ${code}
      return trkLoad(true);`);
    return f({ cloud, local, team, teams });
  };
  assert.equal((await run({ cloud: [], local: { name: 'Painel A', _team: 'A' } })).name, '', 'o time B (sem painel) não herda o do A');
  const own = await run({ cloud: [], local: { name: 'Painel B', _team: 'B' } });
  assert.equal(own.name, 'Painel B'); assert.equal(own._team, undefined, '_team não vaza pro painel');
  assert.equal((await run({ cloud: 'erro', local: { name: 'Painel A', _team: 'A' } })).name, 'Painel A', 'nuvem fora do ar: vale a cópia local');
  assert.equal((await run({ cloud: [], local: { name: 'Antigo' }, teams: 1 })).name, 'Antigo', 'cópia antiga sem _team: vale com 1 time');
  assert.equal((await run({ cloud: [], local: { name: 'Antigo' }, teams: 3 })).name, '', '…e não com vários');
  assert.equal((await run({ cloud: [{ config: { name: 'Da nuvem' } }], local: { name: 'x', _team: 'B' } })).name, 'Da nuvem');
});

test('Minhas: junta os times sem repetir — a linha do time ativo (teamFetch) vence a do outro lote', () => {
  const code = cut(S74, 'let taMineMemo=', '\n// a busca dos outros times falhou');
  const f = new Function('o', `const TA=o.TA; const caSrc=()=>o.base; const taMineTeams=()=>o.teams; const taMineFetch=()=>{ o.fetched++; };
    ${code}
    return caMineSrc;`);
  const o = { TA: { mine: [{ id: 'x', v: 'velho' }, { id: 'y' }] }, base: [{ id: 'x', v: 'novo' }], teams: ['A', 'B'], fetched: 0 };
  const caMineSrc = f(o);
  const out = caMineSrc();
  assert.deepEqual(out.map((t) => t.id + (t.v ? ':' + t.v : '')), ['x:novo', 'y']);
  assert.equal(caMineSrc(), out, 'memo: a mesma foto não junta de novo');
  o.teams = ['A']; assert.equal(caMineSrc(), o.base, 'um time só: o teamFetch basta');
});

test('teamActiveSet: time desconhecido ou o atual não troca; trocar grava por pessoa, limpa filtros do time velho', () => {
  const code = cut(S74, 'function teamActiveSet(', '\n// redesenha TUDO');
  const ls = { 'sb:team': 'A', tmEpic: 'ep1', tmDev: 'u1' };
  const f = new Function('ls', `let teamTasks=[1], teamFetchedAt=5, teamEpics=[1], teamActivity=[1], teamPaintSig='x'; const window={};
    const TA={ mine:[1], at:9 }; const cloudData={ teamMembers:{ B:[{ user_id:'eu' }] }, members:[] };
    const lsSet=(k,v)=>{ ls[k]=v; }, lsGet=(k)=>ls[k]; const userKey=(k,u)=>k+':'+u; const cloudUserId=()=>'eu', cloudTeamId=()=>ls['sb:team'];
    const teamActiveList=()=>[{ id:'A', name:'Produto' }, { id:'B', name:'Dados' }]; const taRepaint=()=>{}; const toast=()=>{}; const taIssuesOpen=()=>false;
    const entFiltros=()=>({ who:'u1', epic:'ep1', trav:true, pront:false });
    ${code}
    return { set:teamActiveSet, st:()=>({ teamTasks, teamEpics, members:cloudData.members, TA }) };`);
  const T = f(ls);
  assert.equal(T.set('Z'), false, 'time que a pessoa não enxerga');
  assert.equal(T.set('A'), false, 'já é o ativo');
  assert.equal(T.set('B', { quiet: true }), true);
  assert.equal(ls['sb:team'], 'B'); assert.equal(ls['sb:team:eu'], 'B', 'lembrado por pessoa');
  assert.equal(ls.tmEpic, ''); assert.equal(ls.tmDev, '');
  assert.deepEqual(JSON.parse(ls.tmEntF), { who: '', epic: '', trav: true, pront: false }, 'só o que é do time velho sai');
  const st = T.st(); assert.equal(st.teamTasks, null); assert.deepEqual(st.teamEpics, []); assert.deepEqual(st.members, [{ user_id: 'eu' }]); assert.equal(st.TA.mine, null);
});

test('Central › Épicos no período: ativo sempre; concluído só se mexeu no período', () => {
  const code = cut(S71, 'function caEpPer(', '\n');
  const f = new Function(`const tsRange=()=>({ from:100, to:200 }); const CA_FN={ ativo:(e)=>e.ativo }; const caEpModOf=(e)=>e.md; ${code}; return caEpPer;`)();
  const eps = [{ id: 'a', ativo: true, md: 1 }, { id: 'c-agora', ativo: false, md: 150 }, { id: 'c-velho', ativo: false, md: 50 }];
  assert.deepEqual(f(eps, []).map((e) => e.id), ['a', 'c-agora']);
});
