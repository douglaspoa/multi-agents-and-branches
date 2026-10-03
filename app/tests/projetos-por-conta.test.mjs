// Projetos e nuvem POR CONTA (fix/projetos-por-conta): trocar da conta do trabalho pra pessoal deixava os
// projetos da outra conta na tela e os laços da nuvem publicavam as tarefas deles com a conta errada
// ("row-level security" no log). Recorta o código real (40-conta-escopo @escopo, 42 @tmap/@feedpos e as
// funções dos laços) e roda com localStorage/nuvem falsos. `node --test app/tests/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
function fn(src, name) {
  const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src); assert.ok(m, 'função não encontrada: ' + name);
  // pula a lista de parâmetros e acha o { do corpo
  let i = src.indexOf('{', src.indexOf(')', m.index)), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('chaves desbalanceadas: ' + name);
}
const ESC = read('40-conta-escopo.js'), SYNC = read('42-nuvem-sync-mobile.js');
const pure = cut(ESC, '// @escopo-inicio', '// @escopo-fim');
const P = new Function(pure + '\nreturn { OTHER_ACCOUNT, userKey, mailDomain, mailCorp, mailSignals, projOwnerDecide, projClaimOk, tmapSplit, tmapForeignOf, emailShort, projScopeText };')();

const GMAIL = 'u-gmail-4242', WORK = 'u-work-6f5a';

test('chave do localStorage por usuário — sem sessão nunca cai na chave de uma conta', () => {
  assert.equal(P.userKey('sb:tmap', GMAIL), 'sb:tmap:' + GMAIL);
  assert.notEqual(P.userKey('sb:tmap', GMAIL), P.userKey('sb:tmap', WORK));
  assert.equal(P.userKey('sb:tmap', ''), 'sb:tmap:-');
  assert.notEqual(P.userKey('sb:tmap', ''), 'sb:tmap', 'nunca a chave antiga (o estoque sem dono)');
});

test('e-mails dos commits: meu, do meu domínio de empresa, ou de OUTRA empresa', () => {
  const work = ['49099655+douglaspoa@users.noreply.github.com', 'h@logcomex.com', 'paulo.lavoratti@logcomex.com', 'douglassobreira@mac.lan'];
  assert.deepEqual(P.mailSignals(work, 'dodosobreira@gmail.com'), { mine: false, sameOrg: false, foreignOrg: true });
  assert.deepEqual(P.mailSignals(work, 'douglas.sobreira@logcomex.com'), { mine: false, sameOrg: true, foreignOrg: false });
  assert.deepEqual(P.mailSignals(['dodosobreira@gmail.com', '1+x@users.noreply.github.com'], 'dodosobreira@gmail.com'), { mine: true, sameOrg: false, foreignOrg: false });
  assert.deepEqual(P.mailSignals(['a@gmail.com', 'b@hotmail.com'], 'c@gmail.com'), { mine: false, sameOrg: false, foreignOrg: false }, 'provedor público não é empresa');
  assert.equal(P.mailCorp('mac.lan'), false, 'nome de máquina não é empresa');
  assert.equal(P.mailCorp('users.noreply.github.com'), false);
  assert.equal(P.mailCorp('logcomex.com'), true);
});

test('migração do caso real: logcomex-ai-v2 e code-refuge-relay vão pra conta do trabalho; pou e o Starfork não somem', () => {
  const gmailMail = 'dodosobreira@gmail.com';
  const ev = (cards, emails) => ({ cardsMine: 0, cardsHidden: 0, cardsOther: 0, ...cards, mail: P.mailSignals(emails, gmailMail) });
  // migração roda com a conta PESSOAL logada; os cartões foram publicados pela do trabalho (invisíveis por RLS)
  const v2 = P.projOwnerDecide(ev({ cardsHidden: 94 }, ['h@logcomex.com', '1+douglaspoa@users.noreply.github.com']), GMAIL, true);
  const relay = P.projOwnerDecide(ev({ cardsHidden: 28 }, ['douglas.sobreira@logcomex.com', 'lucas.cavalherie@logcomex.com']), GMAIL, true);
  const pou = P.projOwnerDecide(ev({ cardsHidden: 8 }, ['1+douglaspoa@users.noreply.github.com']), GMAIL, true);
  const multi = P.projOwnerDecide(ev({ cardsHidden: 4 }, ['dodosobreira@gmail.com']), GMAIL, true);
  assert.equal(v2, P.OTHER_ACCOUNT, 'oculto pra conta pessoal');
  assert.equal(relay, P.OTHER_ACCOUNT);
  assert.ok(pou === null || pou === GMAIL, 'pou: sem dono ou pessoal — nunca oculto');
  assert.ok(multi === null || multi === GMAIL);
  // depois a conta do trabalho entra: enxerga os cartões → reivindica
  assert.equal(P.projClaimOk({ cardsMine: 90, cardsHidden: 0, cardsOther: 4, mail: P.mailSignals(['h@logcomex.com'], 'douglas.sobreira@logcomex.com') }, WORK), true);
  // e uma conta sem evidência positiva não rouba o projeto marcado como "outra conta"
  assert.equal(P.projClaimOk({ cardsMine: 0, cardsHidden: 94, mail: P.mailSignals(['h@logcomex.com'], 'x@gmail.com') }, GMAIL), false);
  assert.equal(P.projClaimOk({ cardsMine: 0, cardsHidden: 0, mail: P.mailSignals([], 'x@gmail.com') }, GMAIL), false, 'nada contra também não basta pra reivindicar');
});

test('regras de dono: nuvem manda; sinal único = ambíguo (visível pra todas); sem nada = conta logada na 1ª vez', () => {
  const none = { mine: false, sameOrg: false, foreignOrg: false };
  assert.equal(P.projOwnerDecide({ cardsMine: 3, cardsHidden: 9, mail: { ...none, foreignOrg: true } }, GMAIL, true), GMAIL, 'cartão meu visível = meu');
  assert.equal(P.projOwnerDecide({ cardsMine: 0, mail: none }, GMAIL, true), GMAIL, '1ª migração sem evidência: da conta logada');
  assert.equal(P.projOwnerDecide({ cardsMine: 0, mail: none }, GMAIL, false), undefined, 'fora da 1ª migração: não mexe');
  assert.equal(P.projOwnerDecide({ cardsOther: 2, mail: none }, GMAIL, true), null, 'cartões de colegas: ambíguo');
  assert.equal(P.projOwnerDecide({ mail: { ...none, foreignOrg: true } }, GMAIL, true), null, 'só commit de outra empresa (clone de open source?) não esconde');
  assert.equal(P.projOwnerDecide({ mail: { ...none, mine: true } }, GMAIL, true), GMAIL);
  assert.equal(P.projOwnerDecide({ cardsMine: 1, mail: none }, '', true), undefined, 'sem sessão não decide nada');
});

test('mapa antigo (sem usuário) se divide: só o cartão que esta conta enxerga e criou/assumiu é dela', () => {
  const legacy = { a: 'c1', b: 'c2', c: 'c3', d: 'c4' };
  const cards = [{ id: 'c1', created_by: GMAIL }, { id: 'c2', created_by: 'colega', assignee: GMAIL }, { id: 'c3', created_by: 'colega' }];
  const { mine, rest } = P.tmapSplit(legacy, cards, GMAIL);
  assert.deepEqual(mine, { a: 'c1', b: 'c2' });
  assert.deepEqual(rest, { c: 'c3', d: 'c4' }, 'invisível (c4) e de colega (c3) ficam no estoque pra outra conta');
  const fg = P.tmapForeignOf({ 'sb:tmap': rest, ['sb:tmap:' + WORK]: { e: 'c5' }, ['sb:tmap:' + GMAIL]: mine }, 'sb:tmap:' + GMAIL);
  assert.deepEqual([...fg].sort(), ['c', 'd', 'e'], 'o meu mapa nunca entra no "de outra conta"');
});

test('linha da barra lateral: e-mail abreviado e quantos de outras contas estão ocultos', () => {
  assert.equal(P.emailShort('dodosobreira@gmail.com'), 'dodosobr…@gmail.com');
  assert.equal(P.emailShort('ana@x.io'), 'ana@x.io');
  assert.equal(P.projScopeText('dodosobreira@gmail.com', 2), 'mostrando os projetos de dodosobr…@gmail.com · 2 de outras contas ocultos');
  assert.equal(P.projScopeText('ana@x.io', 1), 'mostrando os projetos de ana@x.io · 1 de outra conta oculto');
  assert.equal(P.projScopeText('ana@x.io', 0), 'mostrando os projetos de ana@x.io');
});

// ---- runtime com localStorage e nuvem falsos ----
function sandbox() {
  const store = new Map();
  const env = { uid: GMAIL, posts: [], fetches: [], cards: [], events: [], tasks: [], ready: GMAIL };
  const lsGet = (k) => (store.has(k) ? store.get(k) : null);
  const lsSet = (k, v) => store.set(k, String(v));
  const code = pure + cut(SYNC, '// @tmap-inicio', '// @tmap-fim') + cut(SYNC, '// @feedpos-inicio', '// @feedpos-fim')
    + fn(ESC, 'lsJsonRead') + fn(ESC, 'lsKeys') + fn(ESC, 'tmapForeign') + fn(ESC, 'pgInQ') + fn(ESC, 'acctCardsVisible') + fn(ESC, 'tmapMigrate')
    + fn(SYNC, 'cloudFeedTick') + fn(SYNC, 'cloudAutoPublish')
    + `\nfunction cloudScopeOk(){ const me=cloudUserId(); return !!me && env.ready===me && lsGet(userKey('sb:tmapmig', me))==='1'; }`
    + `\nreturn { tmap, tmapSet, feedPos, feedPosSet, tmapForeign, tmapMigrate, cloudFeedTick, cloudAutoPublish, autoPubFails, autoPubLast };`;
  const X = new Function('env', 'lsGet', 'lsSet', 'localStorage', 'Object', `
    const cloudUserId=()=>env.uid; const SB={ sess:()=>env.uid?{user:{id:env.uid}}:null };
    const cloudTeamId=()=>'team'; const cloudFeedRepair=async()=>{};
    const invoke=async()=>{}; const console={ error:()=>{} };
    const sbPost=async(t,b)=>{ env.posts.push([t,b]); if(env.rls) throw new Error('new row violates row-level security policy for table "'+t+'"'); return [{id:'x'}]; };
    const sbGet=async(q)=>{ if(q.startsWith('tasks?select=id,created_by,assignee&id=in.')){ const ids=decodeURIComponent(q.split('id=in.')[1]).replace(/[()"]/g,'').split(','); return env.cards.filter(c=>ids.includes(c.id)); } if(q.startsWith('tasks?select=id&project_id')) return [{id:'novo-'+q.split('local_id=eq.')[1]}]; return []; };
    const sbFetch=async(u,o)=>{ env.fetches.push([u,o&&o.body]); return []; };
    const cloudEnsureProject=async()=>({id:'p1'}); const taskCost=()=>({usd:0,tok:0}); const cloudEpicId=()=>null; const epicPubFields=()=>({});
    const ACTIVE_ST=new Set(['running']); const autoPubFails={}, autoPubLast={};
    let teamTasks=null; const state={ get tasks(){ return env.tasks; }, get events(){ return env.events; } };
    ${code}`);
  // Object.keys(localStorage) precisa enxergar as chaves do Map
  const LS = new Proxy({}, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
  return { env, store, X: X(env, lsGet, lsSet, LS, Object) };
}

test('tmap/feedpos por usuário: trocar de conta troca o mapa; um nunca lê o do outro', () => {
  const { env, store, X } = sandbox();
  X.tmapSet('t1', 'c1'); X.feedPosSet('t1', 7);
  assert.equal(store.get('sb:tmap:' + GMAIL), '{"t1":"c1"}');
  env.uid = WORK;
  assert.deepEqual(X.tmap(), {}, 'a conta do trabalho não vê o mapa da pessoal (mesmo com o memo quente)');
  assert.deepEqual(X.feedPos(), {});
  X.tmapSet('t9', 'c9');
  env.uid = GMAIL;
  assert.deepEqual(X.tmap(), { t1: 'c1' });
  assert.deepEqual(X.feedPos(), { t1: 7 });
  assert.equal(store.has('sb:tmap'), false, 'a chave antiga (sem usuário) não é mais escrita');
});

test('migração do mapa antigo: a conta leva só os cartões dela (e o cursor do feed junto)', async () => {
  const { env, store, X } = sandbox();
  store.set('sb:tmap', JSON.stringify({ w1: 'cw1', w2: 'cw2', g1: 'cg1' }));
  store.set('sb:feedpos', JSON.stringify({ w1: 50, g1: 12 }));
  env.cards = [{ id: 'cg1', created_by: GMAIL }]; // RLS: a conta pessoal só enxerga o cartão dela
  await X.tmapMigrate(GMAIL);
  assert.deepEqual(JSON.parse(store.get('sb:tmap:' + GMAIL)), { g1: 'cg1' });
  assert.deepEqual(JSON.parse(store.get('sb:tmap')), { w1: 'cw1', w2: 'cw2' }, 'o resto espera a conta do trabalho');
  assert.deepEqual(JSON.parse(store.get('sb:feedpos:' + GMAIL)), { g1: 12 });
  assert.deepEqual(JSON.parse(store.get('sb:feedpos')), { w1: 50 });
  assert.equal(store.get('sb:tmapmig:' + GMAIL), '1');
  // a conta do trabalho entra depois e reivindica o resto
  env.uid = WORK; env.cards = [{ id: 'cw1', created_by: WORK }, { id: 'cw2', created_by: 'colega', assignee: WORK }];
  await X.tmapMigrate(WORK);
  assert.deepEqual(JSON.parse(store.get('sb:tmap:' + WORK)), { w1: 'cw1', w2: 'cw2' });
  assert.deepEqual(JSON.parse(store.get('sb:feedpos:' + WORK)), { w1: 50 });
  assert.deepEqual(JSON.parse(store.get('sb:tmap')), {});
});

test('feed: só publica eventos das tarefas com cartão DESTA conta — a de outra conta nem é tentada', async () => {
  const { env, store, X } = sandbox();
  store.set('sb:tmapmig:' + GMAIL, '1');
  store.set('sb:tmap:' + GMAIL, JSON.stringify({ minha: 'cm' }));
  store.set('sb:tmap', JSON.stringify({ trabalho: 'cw' })); // estoque antigo: cartão da conta do trabalho
  env.events = [{ id: 1, taskId: 'trabalho', type: 'note', text: 'a' }, { id: 2, taskId: 'minha', type: 'note', text: 'b' }];
  await X.cloudFeedTick();
  assert.equal(env.posts.length, 1);
  assert.deepEqual(env.posts[0][1].map((r) => r.task_id), ['cm']);
});

test('laços parados até a conta da vez estar migrada (sem tentar com o mapa errado)', async () => {
  const { env, store, X } = sandbox();
  store.set('sb:tmap:' + GMAIL, JSON.stringify({ minha: 'cm' }));
  env.events = [{ id: 1, taskId: 'minha', type: 'note', text: 'a' }];
  await X.cloudFeedTick();
  assert.equal(env.posts.length, 0, 'sem sb:tmapmig da conta: não roda');
  store.set('sb:tmapmig:' + GMAIL, '1'); env.ready = '';
  await X.cloudFeedTick();
  assert.equal(env.posts.length, 0, 'escopo ainda não aplicado (troca de conta em andamento): não roda');
  env.ready = GMAIL;
  await X.cloudFeedTick();
  assert.equal(env.posts.length, 1);
});

test('auto-publicação pula tarefa cujo cartão é de outra conta (estoque antigo ou mapa da outra)', async () => {
  const { env, store, X } = sandbox();
  store.set('sb:tmapmig:' + GMAIL, '1');
  store.set('sb:tmap', JSON.stringify({ velha: 'cw' }));
  store.set('sb:tmap:' + WORK, JSON.stringify({ trabalho: 'cw2' }));
  env.tasks = [{ id: 'velha', status: 'review', title: 'v' }, { id: 'trabalho', status: 'running', title: 't' }, { id: 'nova', status: 'running', title: 'n', createdAt: 1 }];
  assert.deepEqual([...X.tmapForeign()].sort(), ['trabalho', 'velha']);
  await X.cloudAutoPublish(); await X.cloudAutoPublish(); await X.cloudAutoPublish();
  const published = env.fetches.filter(([u]) => u.startsWith('/rest/v1/tasks?on_conflict')).map(([, b]) => JSON.parse(b).local_id);
  assert.deepEqual([...new Set(published)], ['nova'], 'só a tarefa sem cartão de ninguém sobe com esta conta');
  assert.deepEqual(JSON.parse(store.get('sb:tmap:' + GMAIL)), { nova: 'novo-nova' });
});

test('o app carrega o módulo depois do 40 e todo list_projects informa a conta', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const i = html.indexOf('js/40-nuvem-conta.js'), j = html.indexOf('js/40-conta-escopo.js'), k = html.indexOf('js/42-nuvem-sync-mobile.js');
  assert.ok(i > 0 && j > i && k > j, 'ordem: 40-nuvem-conta → 40-conta-escopo → 42');
  for (const f of ['09-remote-id.js', '14-issues-projeto.js', '33-switcher-projetos.js', '46-epico-time.js']) {
    const src = read(f); const calls = src.match(/invoke(Quiet)?\(\s*["']list_projects["'][^)]*\)/g) || [];
    assert.ok(calls.length, f);
    for (const c of calls) assert.match(c, /user:/, f + ': list_projects sem a conta');
  }
  // todos os laços da nuvem respeitam o escopo da conta
  for (const name of ['cloudAutoTunnelTick', 'cloudIntentTick', 'cloudPrStatTick', 'cloudSyncTick', 'cloudQuestionsTick', 'cloudRemoteStartTick', 'cloudFeedTick', 'cloudMsgTick', 'pushReadyTick', 'cloudAutoPublish', 'cloudBackfill', 'cloudFeedRepair'])
    assert.match(fn(SYNC, name), /cloudScopeOk\(\)/, name);
  const EP = read('46-epico-time.js');
  for (const name of ['epicAutoStartTick', 'epicMirrorChecks']) assert.match(fn(EP, name), /cloudScopeOk\(\)/, name);
  assert.match(fn(read('43-espaco-times.js'), 'teamNotifTick'), /cloudScopeOk\(\)/);
  assert.match(fn(EP, 'epMirroredSet'), /epMirroredKey\(\)/);
});
