// Execução só com o que é MEU (fix/execucao-so-minhas): a regra única de de-quem-é um cartão da nuvem
// (42 @exec-inicio … @exec-fim), a fila dos épicos da Central (46 epQueueMine/epQueueList/epQueueTeamCount)
// e o rótulo "criada por Fulano". `node --test app/tests/` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
// recorta `function nome(...){ ... }` contando chaves (ignora strings/templates/comentários)
function fn(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src); assert.ok(m, 'função não encontrada: ' + name);
  let i = src.indexOf('{', m.index), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('chaves desbalanceadas: ' + name);
}
const remote = cut(read('09-remote-id.js'), '// @puro-inicio', '// @puro-fim');
const exec = cut(read('42-nuvem-sync-mobile.js'), '// @exec-inicio', '// @exec-fim');
const X = new Function(remote + exec + '\nreturn { ctMineFor, ctProjLocal, ctExecOk, ctWhoLabel, remoteLocal };')();

const ME = 'u-me', ANA = 'u-ana', BRUNO = 'u-bruno';
const LOJA = { remote: 'github.com/org/loja', legacy: 'github.com-work/org/loja' };
const API = { remote: 'github.com/org/api', legacy: 'github.com/org/api' };
const local = [LOJA];
const pLoja = { repo_remote: 'github.com-work/org/loja' }, pApi = { repo_remote: API.remote };

test('meu = atribuído a mim; sem responsável, é de quem criou', () => {
  assert.equal(X.ctMineFor({ created_by: ME, assignee: null }, ME), true);
  assert.equal(X.ctMineFor({ created_by: ANA, assignee: ME }, ME), true, 'a Ana atribuiu pra mim');
  assert.equal(X.ctMineFor({ created_by: ANA, assignee: null }, ME), false, 'backlog sem dono de outra pessoa = do time');
  assert.equal(X.ctMineFor({ created_by: ME, assignee: BRUNO }, ME), false, 'criei, mas está com o Bruno');
  assert.equal(X.ctMineFor({ created_by: ME }, ''), false, 'sem sessão nada é meu');
  assert.equal(X.ctMineFor(null, ME), false);
});

test('projeto que não existe nesta máquina fica fora da Execução (mesmo se for meu)', () => {
  assert.equal(X.ctProjLocal(pLoja, local), true, 'forma antiga do remote também vale');
  assert.equal(X.ctProjLocal(pApi, local), false);
  assert.equal(X.ctProjLocal(null, local), true, 'cartão sem projeto: não dá pra saber, não esconde');
  assert.equal(X.ctProjLocal({ repo_remote: '' }, local), true);
  assert.equal(X.ctProjLocal(pApi, []), false);
  const mine = { created_by: ME, assignee: null };
  assert.equal(X.ctExecOk(mine, ME, pLoja, local), true);
  assert.equal(X.ctExecOk(mine, ME, pApi, local), false);
  assert.equal(X.ctExecOk({ created_by: ANA }, ME, pLoja, local), false);
});

test('rótulo de origem: "criada por" quando veio de outra pessoa; o meu não ganha nada', () => {
  const nm = (u) => ({ [ANA]: 'Ana Souza', [BRUNO]: 'Bruno Lima', [ME]: 'Douglas' })[u];
  assert.equal(X.ctWhoLabel({ created_by: ME, assignee: ME }, ME, nm), '');
  assert.equal(X.ctWhoLabel({ created_by: ME, assignee: null }, ME, nm), '');
  assert.equal(X.ctWhoLabel({ created_by: ANA, assignee: null }, ME, nm), 'criada por Ana Souza');
  assert.equal(X.ctWhoLabel({ created_by: ANA, assignee: ME }, ME, nm), 'criada por Ana Souza', 'eu não apareço');
  assert.equal(X.ctWhoLabel({ created_by: ANA, assignee: ANA }, ME, nm), 'criada por Ana Souza', 'responsável = criador: uma vez só');
  assert.equal(X.ctWhoLabel({ created_by: ANA, assignee: BRUNO }, ME, nm), 'criada por Ana Souza · com Bruno Lima');
  assert.equal(X.ctWhoLabel({ created_by: ME, assignee: BRUNO }, ME, nm), 'com Bruno Lima');
  assert.equal(X.ctWhoLabel(null, ME, nm), '');
});

// ---- a fila dos épicos da Central: SÓ o que é meu, e as contagens pela mesma regra ----
const ep = read('46-epico-time.js');
const Q = new Function('X', `
  const { ctExecOk } = X; let projFilter='all', flowQuery='', flowStatus='all', flowEpic='all', flowType='all', flowAgent='all';
  const cloudUserId=()=>'${ME}'; const epNameOf=()=>''; const remoteSame=(r,ids)=>!!r&&[ids.remote,ids.legacy].includes(r);
  let epQueue;
  ${fn(ep, 'epqType')} ${fn(ep, 'epqLocalIds')} ${fn(ep, 'epQueueMine')} ${fn(ep, 'epQueueTeamCount')} ${fn(ep, 'epQueueList')}
  function epQueueCount(){ return epQueueList(true).length; }
  return { set:(q)=>{ epQueue=q; }, filters:(o)=>{ ({ projFilter=projFilter, flowStatus=flowStatus } = o); }, epQueueMine, epQueueTeamCount, epQueueList, epQueueCount };
`)(X);

const rows = [
  { id: 'a', epic_id: 'e1', project_id: 'p-loja', created_by: ME, assignee: null, title: 'minha sem dono' },
  { id: 'b', epic_id: 'e1', project_id: 'p-loja', created_by: ANA, assignee: ME, title: 'da Ana pra mim' },
  { id: 'c', epic_id: 'e1', project_id: 'p-loja', created_by: ANA, assignee: null, title: 'da Ana, sem dono' },
  { id: 'd', epic_id: 'e2', project_id: 'p-loja', created_by: BRUNO, assignee: BRUNO, title: 'do Bruno' },
  { id: 'e', epic_id: 'e2', project_id: 'p-api', created_by: ME, assignee: null, title: 'minha, projeto que não tenho' },
];
const queue = (localIds) => ({ rows, projOf: { 'p-loja': { repo_remote: LOJA.remote }, 'p-api': { repo_remote: API.remote } }, here: LOJA.remote, hereIds: LOJA, localIds });

test('fila dos épicos na Execução: só as minhas e de projeto local', () => {
  Q.set(queue([LOJA])); Q.filters({ projFilter: 'all', flowStatus: 'all' });
  assert.deepEqual(Q.epQueueMine().map((r) => r.id), ['a', 'b']);
  assert.deepEqual(Q.epQueueList(false).map((r) => r.id), ['a', 'b']);
});

test('contagens seguem a mesma regra: chip = lista; minhas + do time = fila inteira', () => {
  Q.set(queue([LOJA])); Q.filters({ projFilter: 'all', flowStatus: 'all' });
  assert.equal(Q.epQueueCount(), Q.epQueueList(false).length);
  assert.equal(Q.epQueueCount() + Q.epQueueTeamCount(), rows.length);
  assert.equal(Q.epQueueTeamCount(), 3);
  // outro chip de status: a lista esvazia, mas o número do chip "Na fila dos épicos" continua o mesmo
  Q.filters({ flowStatus: 'andamento' });
  assert.equal(Q.epQueueList(false).length, 0);
  assert.equal(Q.epQueueCount(), 2);
});

test('lista de projetos locais ainda não chegou: o projeto aberto conta como local', () => {
  Q.set(queue([])); Q.filters({ projFilter: 'all', flowStatus: 'all' });
  assert.deepEqual(Q.epQueueMine().map((r) => r.id), ['a', 'b']);
  Q.set(queue([LOJA, API]));
  assert.deepEqual(Q.epQueueMine().map((r) => r.id), ['a', 'b', 'e'], 'com o projeto api clonado aqui, a minha volta');
});

test('início automático do épico só pega cartão MEU', () => {
  const auto = /const ready=rows\.filter\(t=>([^;]+)\);/.exec(ep);
  assert.ok(auto, 'filtro do início automático não encontrado');
  assert.match(auto[1], /ctMineFor\(t, me\)/);
  assert.doesNotMatch(auto[1], /created_by===/);
});
