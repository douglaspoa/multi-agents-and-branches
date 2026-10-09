// Aba Entregas do Time (visão do gestor · T7/T8 da mesa 09/10): 70 @puro-entregas-*.
// `node --test app/tests/` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const E = new Function(cut(read('70-time-entregas.js'), '// @puro-entregas-inicio', '// @puro-entregas-fim')
  + '\nreturn { entTravada, entPronta, entFora, entReqs, entMotivo, entPeso, entFiltra, entNums, entAgrupa, entVeCusto, entProvasPorTarefa, entFiltrosDe };')();

// regras injetadas (no app: flowBucket/epDelivered/tsWho/epAtivo)
const BK = { backlog: 'fila', running: 'andamento', error: 'aguardando', conflict: 'aguardando', review: 'prontas', merged: 'anteriores', done: 'anteriores', cancelled: 'anteriores' };
const fn = {
  bucket: (t) => (t.pr_url && t.status !== 'merged' && !BK[t.status]?.startsWith('ag') ? 'praberto' : BK[t.status] || 'andamento'),
  delivered: (t) => ['merged', 'done'].includes(t.status),
  who: (t) => t.assignee || t.created_by || '',
  ativo: (e, ts) => e.status !== 'done' && !(ts.length && ts.every((t) => ['merged', 'done'].includes(t.status))),
};
const T = (id, o) => ({ id, title: id, created_by: 'A', assignee: null, status: 'running', updated_at: '2026-10-0' + (o.d || 1) + 'T10:00:00Z', ...o });
const tasks = [
  T('a1', { epic_id: 'E1', assignee: 'A', status: 'merged', d: 2 }),
  T('a2', { epic_id: 'E1', assignee: 'B', status: 'review', pr_url: 'https://github.com/exemplo/loja/pull/12', d: 3 }),
  T('a3', { epic_id: 'E1', assignee: 'B', status: 'error', last_note: 'Teste de carrinho falhou no passo 3. Log longo depois.', d: 4 }),
  T('a4', { epic_id: 'E1', status: 'backlog', d: 5 }),
  T('a5', { epic_id: 'E1', status: 'cancelled', d: 6 }),
  T('b1', { epic_id: 'E2', assignee: 'A', status: 'done', d: 1 }),
  T('s1', { assignee: 'A', status: 'running', flag: 'blocked', d: 7 }),
];
const epics = [{ id: 'E2', name: 'Antigo', status: 'open' }, { id: 'E1', name: 'Checkout', status: 'open' }];

test('travada = etapa aguardando (erro/conflito) ou bloqueada; pronta = PR aberto ou pronta, não entregue', () => {
  assert.equal(E.entTravada(tasks[2], fn), true);
  assert.equal(E.entTravada(tasks[6], fn), true); // flag blocked
  assert.equal(E.entTravada(tasks[1], fn), false);
  assert.equal(E.entPronta(tasks[1], fn), true);
  assert.equal(E.entPronta(tasks[0], fn), false); // integrada já é entregue
  assert.equal(E.entPronta(tasks[2], fn), false);
  assert.equal(E.entFora(tasks[4], fn), true);
});

test('requisitos "x de y": requirements_proof.list ou a própria lista; status done', () => {
  assert.deepEqual(E.entReqs({ requirements_proof: { list: [{ req: 'a', status: 'done' }, { req: 'b', status: 'todo' }, { req: 'c', status: 'done' }] } }), { ok: 2, tot: 3 });
  assert.deepEqual(E.entReqs({ requirements_proof: [{ status: 'done' }] }), { ok: 1, tot: 1 });
  assert.equal(E.entReqs({ requirements_proof: { list: [] } }), null);
  assert.equal(E.entReqs({}), null);
});

test('motivo da trava: 1ª frase da última nota, curta; sem nota, o rótulo', () => {
  assert.equal(E.entMotivo(tasks[2], 'erro'), 'Teste de carrinho falhou no passo 3.');
  assert.equal(E.entMotivo({ last_note: '' }, 'conflito'), 'conflito');
  assert.ok(E.entMotivo({ last_note: 'x'.repeat(200) }, '').length <= 90);
});

test('números do épico: entregues de y (cancelada fora), prontas, travadas, pessoas, custo', () => {
  const n = E.entNums(tasks.filter((t) => t.epic_id === 'E1').map((t) => ({ ...t, cost_usd: 1.5 })), fn);
  assert.equal(n.ent, 1); assert.equal(n.tot, 4); assert.equal(n.prontas, 1); assert.equal(n.travadas, 1);
  assert.deepEqual(n.pessoas.sort(), ['A', 'B']);
  assert.equal(n.custo, 7.5);
});

test('agrupa: épicos ativos primeiro, concluídos depois, "Sem épico" no fim; dentro, travada e pronta antes', () => {
  const g = E.entAgrupa(tasks, tasks, epics, fn);
  assert.deepEqual(g.map((x) => x.nome), ['Checkout', 'Antigo', 'Sem épico']);
  assert.equal(g[1].ativo, false);
  assert.deepEqual(g[0].itens.map((t) => t.id), ['a3', 'a2', 'a4', 'a1', 'a5']);
  // filtro tira itens mas os números do épico continuam os do épico inteiro
  const vis = E.entFiltra(tasks, { trav: true }, fn);
  const g2 = E.entAgrupa(tasks, vis, epics, fn);
  assert.deepEqual(g2.map((x) => x.nome), ['Checkout', 'Sem épico']);
  assert.equal(g2[0].tot, 4);
});

test('filtros: pessoa (inclui "sem dono"), épico (inclui "sem épico"), só travadas, só prontas', () => {
  const ids = (f) => E.entFiltra(tasks, f, fn).map((t) => t.id).sort().join(',');
  assert.equal(ids({ who: 'B' }), 'a2,a3');
  assert.equal(ids({ who: '-' }), 'a4,a5');
  assert.equal(ids({ epic: '-' }), 's1');
  assert.equal(ids({ epic: 'E2' }), 'b1');
  assert.equal(ids({ pront: true }), 'a2');
  assert.equal(ids({ trav: true, pront: true }), 'a2,a3,s1');
  assert.equal(ids({}), tasks.map((t) => t.id).sort().join(','));
});

test('T8: custo só pra líder do time em vista ou owner/admin da org', () => {
  const tm = { T1: [{ user_id: 'A', role: 'lead' }, { user_id: 'B', role: 'member' }], T2: [{ user_id: 'B', role: 'lead' }] };
  assert.equal(E.entVeCusto('A', ['T1'], tm, 'member'), true);
  assert.equal(E.entVeCusto('B', ['T1'], tm, 'member'), false);
  assert.equal(E.entVeCusto('B', ['T1', 'T2'], tm, 'member'), true); // escopo com o time que ele lidera
  assert.equal(E.entVeCusto('B', ['T1'], tm, 'admin'), true);
  assert.equal(E.entVeCusto('', ['T1'], tm, null), false);
});

test('provas por tarefa e filtros gravados', () => {
  assert.deepEqual(E.entProvasPorTarefa([{ task_id: 'x' }, { task_id: 'x' }, { task_id: 'y' }, null]), { x: 2, y: 1 });
  assert.deepEqual(E.entFiltrosDe('{"who":"B","trav":1}'), { who: 'B', epic: '', trav: true, pront: false });
  assert.deepEqual(E.entFiltrosDe('lixo{', { epic: 'E1' }), { who: '', epic: 'E1', trav: false, pront: false });
  assert.deepEqual(E.entFiltrosDe(null, null), { who: '', epic: '', trav: false, pront: false });
});
