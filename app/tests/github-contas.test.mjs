// Novo projeto → "dono": donos de TODAS as contas do gh, agrupados por conta, e relidos a cada abertura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/13-skills-projetos.js', import.meta.url), 'utf8');
const i = src.indexOf('// @puro-ghdonos-inicio'), j = src.indexOf('// @puro-ghdonos-fim');
assert.ok(i >= 0 && j > i);
const G = new Function(src.slice(i, j) + '\nreturn { ghOwnersNorm, ghOwnerLabel, ghOwnerGroups, ghOwnerDefault, ghOwnerFind, ghOwnersLoader };')();

// ordem como o Rust devolve (a ativa vem primeiro, mas o front não depende disso)
const LIST = [
  { owner: 'douglaspoa-logcomex', account: 'douglaspoa-logcomex', kind: 'user', active: false },
  { owner: 'comexio', account: 'douglaspoa-logcomex', kind: 'org', active: false },
  { owner: 'douglaspoa', account: 'douglaspoa', kind: 'user', active: true },
  { owner: 'minha-org', account: 'douglaspoa', kind: 'org', active: true },
];

test('agrupa por conta com a ativa primeiro e rótulos humanos', () => {
  const g = G.ghOwnerGroups(LIST);
  assert.deepEqual(g.map(x => [x.account, x.active]), [['douglaspoa', true], ['douglaspoa-logcomex', false]]);
  assert.deepEqual(g.flatMap(x => x.items.map(G.ghOwnerLabel)), [
    'douglaspoa (você)', 'minha-org · via douglaspoa', 'douglaspoa-logcomex', 'comexio · via douglaspoa-logcomex',
  ]);
});

test('padrão = usuário da conta ativa; acha a conta do dono escolhido', () => {
  assert.equal(G.ghOwnerDefault(LIST), 'douglaspoa');
  assert.equal(G.ghOwnerFind(LIST, 'comexio').account, 'douglaspoa-logcomex');
  assert.equal(G.ghOwnerFind(LIST, 'nada'), null);
  assert.equal(G.ghOwnerDefault([]), '');
  // backend antigo (só strings da conta ativa) continua funcionando
  assert.deepEqual(G.ghOwnersNorm(['eu', 'org']).map(o => [o.owner, o.active]), [['eu', true], ['org', true]]);
  assert.equal(G.ghOwnerDefault(['eu', 'org']), 'eu');
});

test('cache aparece na hora e toda abertura relê do gh (avisa só quando mudou)', async () => {
  let calls = 0, answer = [LIST[2]];
  const changes = [];
  const st = G.ghOwnersLoader(async (cmd) => { assert.equal(cmd, 'gh_owners'); calls++; return answer; }, (l) => changes.push(l.map(o => o.owner)));
  assert.equal(st.list, null);
  await st.load(false);                       // 1ª abertura: lê
  assert.equal(calls, 1);
  assert.deepEqual(changes, [['douglaspoa']]);
  await st.load(false);                       // sem forçar: usa o cache
  assert.equal(calls, 1);
  answer = LIST;                              // logou a 2ª conta
  const p = st.load(true);                    // abriu o formulário de novo
  assert.deepEqual(st.list.map(o => o.owner), ['douglaspoa']); // enquanto relê, o cache segue na tela
  assert.equal(st.load(true), p);             // uma leitura por vez
  await p;
  assert.equal(calls, 2);
  assert.deepEqual(changes.at(-1), ['douglaspoa-logcomex', 'comexio', 'douglaspoa', 'minha-org']);
  await st.load(true);                        // nada mudou: não re-renderiza
  assert.equal(calls, 3);
  assert.equal(changes.length, 2);
});

test('falha do gh mantém a lista que já estava', async () => {
  let fail = false;
  const st = G.ghOwnersLoader(async () => { if (fail) throw new Error('rede'); return LIST; });
  await st.load(true);
  fail = true;
  const l = await st.load(true);
  assert.equal(l.length, 4);
});

test('a tela usa o carregador: relê ao abrir e manda a conta junto do dono', () => {
  assert.match(src, /projNewOpen=!projNewOpen;[^\n]*ghOwnersReload\(\)/);
  assert.match(src, /invoke\('create_project',\{[^}]*owner, account \}/);
  assert.match(src, /<optgroup/);
  const amb = readFileSync(new URL('../src/js/11-ambiente-updater.js', import.meta.url), 'utf8');
  assert.match(amb, /ghOwnersStale\(\)/); // login/troca de conta → o dono relê
  const pr = readFileSync(new URL('../src/js/21-pull-request.js', import.meta.url), 'utf8');
  assert.match(pr, /invoke\('publish_github',\{[^}]*account:/);
});
