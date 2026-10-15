// Bug das ONDAS de épico (15/10): a onda seguinte começava sem o código da anterior.
// Portão da onda = o pré-requisito está INTEGRADO (o código na main de onde a tarefa seguinte nasce).
// Funções puras recortadas de 46-epico-time.js (@ep-ondas-*, @ep-iniciar-puro-*, epqBucket) + ganchos.
// O lado do git (branch/worktree próprias, main fresca) está em src/ondas-epico.test.ts.
// `node --test app/tests/epico-ondas.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ep = read('js/46-epico-time.js');
const O = new Function(cut(ep, '// @ep-ondas-inicio', '// @ep-ondas-fim') + '\nreturn { epPrOpen, epDepOk, epWaitTx };')();
const EP = new Function(cut(ep, '// @ep-iniciar-puro-inicio', '// @ep-iniciar-puro-fim') + '\nreturn { epStartPlan, epWaveOpen, epJoinItems };')();
const epqBucket = new Function(cut(ep, 'function epqBucket(', '\nfunction epqEpicTasks(') + '\nreturn epqBucket;')();

// cartões da nuvem de um épico da loja fictícia (3 ondas: catálogo → carrinho → checkout)
const card = (id, o) => ({ id, team_id: 't', status: 'backlog', flag: null, pr_url: null, spec: {}, ...o });

test('pré-requisito: integrado libera; rodando / pronto pra revisar / PR aberto seguram', () => {
  assert.equal(O.epDepOk(card('a', { status: 'merged', pr_url: 'https://github.com/loja/app/pull/1' })), true);
  assert.equal(O.epDepOk(card('a', { status: 'running' })), false);
  assert.equal(O.epDepOk(card('a', { status: 'review' })), false, 'pronta pra revisar: o código ainda não está na main');
  assert.equal(O.epDepOk(card('a', { status: 'review', pr_url: 'https://github.com/loja/app/pull/1' })), false, 'PR aberto');
});

test('O BUG: "concluir · sai da fila" com o PR ainda aberto liberava a onda seguinte — agora segura', () => {
  const fechadaComPr = card('a', { status: 'review', flag: 'closed', pr_url: 'https://github.com/loja/app/pull/7' });
  assert.equal(O.epDepOk(fechadaComPr), false);
  assert.equal(epqBucket('closed', 'closed', true), 'pr', 'na onda, conta como "com PR aberto" (segura)');
  assert.equal(EP.epWaveOpen([{ wave: 1, b: epqBucket('closed', 'closed', true) }], 2), 1, 'a onda 2 espera');
  // concluída SEM PR (pesquisa, doc, nada pra integrar): o "terminei" da pessoa continua liberando (24/09)
  assert.equal(O.epDepOk(card('a', { status: 'review', flag: 'closed' })), true);
  assert.equal(epqBucket('closed', 'closed', false), 'ok');
  // cancelada não segura ninguém (decisão de uma pessoa), mesmo com PR esquecido
  assert.equal(epqBucket('cancelled', 'closed', true), 'ok');
  // tarefa LOCAL usa prUrl
  assert.equal(O.epPrOpen({ status: 'review', prUrl: 'https://github.com/loja/app/pull/7' }), true);
  assert.equal(O.epPrOpen({ status: 'merged', prUrl: 'https://github.com/loja/app/pull/7' }), false);
});

test('a fila (tick da nuvem) usa a mesma regra: concluída com PR aberto não é pré-requisito pronto', () => {
  const fn = cut(ep, 'function epDepDone(a){', '\n');
  const epDepDone = new Function('epQueue', 'EP_AUTO_READY', fn + '\nreturn epDepDone;');
  const q = { stOf: { a: 'review', b: 'merged', c: 'review' }, flagOf: { a: 'closed', b: null, c: 'closed' }, prOf: { a: true, b: false, c: false } };
  const done = epDepDone(q, new Set(['merged', 'done']));
  assert.equal(done('a'), false, 'concluída com PR aberto');
  assert.equal(done('b'), true, 'integrada');
  assert.equal(done('c'), true, 'concluída sem PR');
  assert.match(ep, /prOf:Object\.fromEntries\(deps\.map\(d=>\[d\.id,epPrOpen\(d\)\]\)\)/, 'o tick grava se o PR do pré-requisito está aberto');
  assert.match(ep, /issue_code:spec->>issueCode&id=in\./, 'e o código da issue (LOJA-x) pra dizer quem segura');
  assert.match(ep, /const depsOpen=t=>\(\(t\.spec\|\|\{\}\)\.after\|\|\[\]\)\.filter\(a=>sib\[a\]&&!epDepOk\(sib\[a\]\)\);/, 'página do épico: mesma regra');
});

test('"Iniciar épico": quem depende (`after`) de outra tarefa da MESMA onda fica na espera, nunca começa junto', () => {
  const d = { c2l: {}, armedLoc: {}, me: 'ana', mine: (ct, me) => !ct.assignee || ct.assignee === me, bucket: epqBucket,
    st: (t) => t.status, started: () => false, cardWave: (ct) => Math.max(1, +(ct.spec || {}).wave || 1) };
  // onda gravada errada (cartão antigo/editado à mão: tudo onda 1), mas o `after` diz a ordem
  const cloud = [
    card('c1', { spec: { wave: 1, issueCode: 'LOJA-1' } }),
    card('c2', { spec: { wave: 1, after: ['c1'], issueCode: 'LOJA-2' } }),
    card('c3', { spec: { wave: 1, after: ['c2'], issueCode: 'LOJA-3' } }),
  ];
  const p = EP.epStartPlan(EP.epJoinItems(cloud, [], d));
  assert.deepEqual(p.now.map((x) => x.id), ['c1'], 'só o catálogo começa agora');
  assert.deepEqual(p.wait.map((x) => x.id).sort(), ['c2', 'c3'], 'carrinho e checkout ficam armados (o tick confere o after)');
  // catálogo com PR aberto, ainda não integrado: carrinho continua esperando
  cloud[0] = card('c1', { status: 'review', pr_url: 'https://github.com/loja/app/pull/1', spec: { wave: 1 } });
  const p2 = EP.epStartPlan(EP.epJoinItems(cloud, [], d));
  assert.deepEqual(p2.now.map((x) => x.id), []);
  assert.deepEqual(p2.wait.map((x) => x.id).sort(), ['c2', 'c3']);
  // catálogo integrado: agora sim o carrinho
  cloud[0] = card('c1', { status: 'merged', spec: { wave: 1 } });
  assert.deepEqual(EP.epStartPlan(EP.epJoinItems(cloud, [], d)).now.map((x) => x.id), ['c2']);
});

test('rascunho LOCAL com cartão: o `after` (ids da nuvem) vale pela tarefa local ligada', () => {
  const d = { c2l: { c1: 'loc1' }, armedLoc: {}, me: 'ana', mine: () => true, bucket: epqBucket,
    st: (t) => (t.flag === 'closed' ? 'closed' : t.status), started: () => false, cardWave: (ct) => Math.max(1, +(ct.spec || {}).wave || 1) };
  const cloud = [card('c1', { status: 'running', spec: { wave: 1 } }), card('c2', { spec: { wave: 1, after: ['c1'] } })];
  const locals = [{ id: 'loc1', status: 'review', flag: 'closed', prUrl: 'https://github.com/loja/app/pull/3', epic: { wave: 1 } }];
  const it = EP.epJoinItems(cloud, locals, d);
  assert.equal(it.find((x) => x.id === 'loc1').cloud, 'c1');
  assert.equal(it.find((x) => x.id === 'loc1').b, 'pr', 'concluída localmente com PR aberto segura');
  const p = EP.epStartPlan(it);
  assert.deepEqual(p.now.map((x) => x.id), []);
  assert.deepEqual(p.wait.map((x) => x.id), ['c2']);
});

test('a UI diz quem segura e por quê ("esperando LOJA-1 · Catálogo terminar") em vez de iniciar', () => {
  assert.equal(O.epWaitTx([{ title: 'Catálogo', code: 'LOJA-1', b: 'pr' }], esc), 'esperando <b>LOJA-1 · Catálogo</b> (PR aberto · falta integrar) terminar');
  assert.equal(O.epWaitTx([{ title: 'LOJA-2 Carrinho', code: 'LOJA-2', b: 'run' }, { title: 'Frete', b: 'queue' }], esc),
    'esperando <b>LOJA-2 Carrinho</b> (rodando), <b>Frete</b> (ainda não começou) terminarem', 'código já no título não repete');
  assert.equal(O.epWaitTx([], esc), '');
  assert.match(O.epWaitTx([1, 2, 3, 4, 5].map((n) => ({ title: 'T' + n, b: 'rev' })), esc), / e mais 2 terminarem$/);
  assert.equal(O.epWaitTx([{ title: '<script>', b: 'run' }], esc), 'esperando <b>&lt;script&gt;</b> (rodando) terminar');
  // ganchos: fila da Central e página do épico usam o texto; o rascunho local armado também espera o after
  assert.match(ep, /: wl \? \(epWaitTx\(epWaveWho\(ct\.epic_id, epqWave\(ct\)\), esc\)\|\|`na espera da onda/);
  assert.match(ep, /: wl \? \(epWaitTx\(epWaveWho\(ep\.id, /);
  assert.match(ep, /: left\.length \? epWaitTx\(left\.map\(a=>\(\{ title:sib\[a\]\.title/);
  assert.match(cut(ep, 'async function epAutoLocalTick(){', '\n}\n'), /if\(epAfterOpen\(t\.epic&&t\.epic\.epicId, \(t\.epic\|\|\{\}\)\.after\)\.length\) continue;/);
  assert.ok(cut(ep, 'async function epAutoLocalTick(){', '\n}\n').indexOf('epAfterOpen') < cut(ep, 'async function epAutoLocalTick(){', '\n}\n').indexOf('await startTask(id)'));
});
