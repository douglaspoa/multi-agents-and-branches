// Período (padrão últimos 7 dias, lembrado por pessoa) e ORDEM por modificação (08-periodo) + corrente (08-corrente).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const P = new Function(cut(read('08-periodo.js'), '// @puro-periodo-inicio', '// @puro-periodo-fim')
  + '\nreturn { PERIODOS, PERIODO_PADRAO, periodRange, periodNorm, periodLabel, periodHas, modTs, sortRows, modAgoTx, perFmtDay };')();
const C = new Function(cut(read('08-corrente.js'), '// @puro-corrente-inicio', '// @puro-corrente-fim') + '\nreturn { chainOf, chainHtml };')();
const NOW = new Date(2026, 9, 9, 15, 30).getTime(); // sex 09/10 15:30 (hora local)
const day = (d, h = 12) => new Date(2026, 9, d, h).getTime();

test('períodos: hoje, ontem, 7 dias (padrão, hoje incluso), 30 dias, este mês, personalizado (de–até, inclusivo)', () => {
  assert.equal(P.PERIODO_PADRAO, '7d');
  assert.deepEqual(P.PERIODOS.map((x) => x[1]), ['Hoje', 'Ontem', 'Últimos 7 dias', 'Últimos 30 dias', 'Este mês', 'Personalizado']);
  const has = (k, ms) => P.periodHas(P.periodRange(k, NOW), ms);
  assert.ok(has('hoje', day(9, 1)) && !has('hoje', day(8, 23)));
  assert.ok(has('ontem', day(8)) && !has('ontem', day(9, 1)));
  assert.ok(has('7d', day(3, 0)) && !has('7d', day(2, 23)) && has('7d', day(9, 23)));
  assert.ok(has('30d', new Date(2026, 8, 10, 1).getTime()) && !has('30d', new Date(2026, 8, 9, 23).getTime()));
  assert.ok(has('mes', day(1, 0)) && !has('mes', new Date(2026, 8, 30, 23).getTime()));
  const c = { key: 'custom', from: '2026-10-05', to: '2026-10-06' };
  assert.ok(P.periodHas(P.periodRange(c, NOW), day(6, 23)) && !P.periodHas(P.periodRange(c, NOW), day(7, 0)));
  assert.deepEqual(P.periodRange({ key: 'custom', from: '2026-10-06', to: '2026-10-05' }, NOW), P.periodRange(c, NOW), 'de/até invertidos');
  assert.deepEqual(P.periodNorm('xyz'), { key: '7d' }, 'valor estranho → padrão');
  assert.equal(P.periodLabel(c, NOW), '05/10–06/10');
});

test('ordem padrão = modificação mais recente primeiro; coluna clicada vale; empate cai na modificação', () => {
  const rows = [{ id: 'a', t: 'Zeta', at: day(5) }, { id: 'b', t: 'Alfa', at: day(9) }, { id: 'c', t: 'Meio', at: day(7) }];
  const ts = (r) => r.at;
  assert.deepEqual(P.sortRows(rows, ts).map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(P.sortRows(rows, ts, { col: 'mod', dir: 'desc' }).map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(P.sortRows(rows, ts, { col: 't', dir: 'asc' }, (r, c) => r[c]).map((r) => r.id), ['b', 'c', 'a'].sort((x, y) => rows.find((r) => r.id === x).t.localeCompare(rows.find((r) => r.id === y).t)));
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c'], 'a lista original não muda');
  assert.equal(P.modTs('2026-10-01T10:00:00Z', 0, null, [day(9)], 1700000000), day(9), 'maior carimbo, s ou ms');
  assert.equal(P.modAgoTx(NOW - 5 * 60000, NOW), 'há 5 min');
  assert.equal(P.modAgoTx(NOW - 26 * 3600000, NOW), 'ontem');
});

test('corrente: cartão com issue/épico/PR/pessoa; tarefa local liga no cartão; chips sem id', () => {
  const card = { id: 'c1', team_id: 'T', title: 'Cupom', created_by: 'ana', assignee: 'bruno', spec: { issueCode: 'FND-103', issueUrl: 'https://tracker.exemplo.dev/FND-103' }, epic_id: 'E1', pr_url: 'https://github.com/exemplo/loja/pull/93' };
  const k = { epicName: () => 'Checkout com Pix', local: () => ({ id: 'cupom-1', title: 'Cupom' }), proofs: () => 2 };
  const c = C.chainOf(card, k);
  assert.deepEqual(c.issue, { code: 'FND-103', url: 'https://tracker.exemplo.dev/FND-103' });
  assert.equal(c.epic.name, 'Checkout com Pix'); assert.equal(c.pr.num, '93'); assert.equal(c.who, 'bruno'); assert.equal(c.task.localId, 'cupom-1');
  const h = C.chainHtml(c, { st: { label: 'pronta pra revisar', color: 'var(--warn)' } });
  for (const s of ['FND-103', 'Checkout com Pix', 'PR', '#93', '2 provas', 'pronta pra revisar', 'data-chain="issue"', 'data-chain="epic"', 'data-chain="pr"']) assert.ok(h.includes(s), s);
  const local = { id: 'qr-1', title: 'QR do Pix', branch: 'feat/FND-101-qr', status: 'running', epic: { epicId: 'E1' } };
  const l = C.chainOf(local, { me: 'eu', card: () => null, epicName: () => 'Checkout com Pix' });
  assert.equal(l.issue.code, 'FND-101', 'código na branch'); assert.equal(l.who, 'eu');
  assert.equal(C.chainHtml(l, { omit: ['task', 'epic'] }).includes('Checkout'), false);
});
