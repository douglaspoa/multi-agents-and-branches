// Entregas POR DIA (72 @puro-dia-*), período/ordem por modificação na aba (70) e o RELATÓRIO do período (73 @puro-relatorio-*).
// `node --test app/tests/entregas-dia.test.mjs` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const PER = cut(read('08-periodo.js'), '// @puro-periodo-inicio', '// @puro-periodo-fim');
const D = new Function(PER + cut(read('72-entregas-dia.js'), '// @puro-dia-inicio', '// @puro-dia-fim')
  + '\nreturn { periodRange, diaKey, diaRotulo, diaCarimbos, diaEntrega, diaDias, diaAgrupa, diaResumo, diaEscolhe, diaFiltraQuem };')();
const E = new Function(PER + cut(read('70-time-entregas.js'), '// @puro-entregas-inicio', '// @puro-entregas-fim')
  + '\nreturn { entAgrupa, entBaseEpico, entAtvIndice, entModDe, entModoDe, entProvasLista };')();
const R = new Function(cut(read('73-relatorio-entregas.js'), '// @puro-relatorio-inicio', '// @puro-relatorio-fim')
  + '\nreturn { relMonta, relMarkdown, relHtml, relNome };')();

const NOW = new Date(2026, 9, 9, 15, 30).getTime(); // sex 09/10
const at = (d, h = 12) => new Date(2026, 9, d, h).toISOString();
const ms = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const ROT = { merged: ['integrada', 'merged'], done: ['concluída', 'done'] };
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

test('carimbo de entrega = evento de status "integrada" (o mais recente); outros eventos não contam', () => {
  const c = D.diaCarimbos([
    { task_id: 'a', kind: 'status', body: 'pronta pra revisar', at: at(5) },
    { task_id: 'a', kind: 'status', body: 'integrada', at: at(6) },
    { task_id: 'a', kind: 'status', body: 'integrada', at: at(8) },
    { task_id: 'b', kind: 'comment', body: 'integrada', at: at(7) },
    { task_id: 'c', kind: 'status', body: 'concluída', at: at(7, 9) },
    { task_id: 'd', body: 'merged', at: at(9) }, // linha sem kind (consulta já filtrada) e id cru
  ], ROT);
  assert.equal(c.a.merged, ms(8)); assert.equal(c.b, undefined); assert.equal(c.c.done, ms(7, 9)); assert.equal(c.d.merged, ms(9));
});

test('entrega NUNCA usa updated_at: sem evento e sem finishedAt local → ts 0 (sem data); concluída sem PR → "sempr"', () => {
  const k = (car, loc) => ({ carimbos: car || {}, delivered: (t) => ['merged', 'done', 'closed'].includes(t.status), st: (t) => t.status, localTs: loc });
  const merged = { id: 'm', status: 'merged', pr_url: 'https://github.com/x/y/pull/9', updated_at: at(9) };
  assert.deepEqual(D.diaEntrega(merged, k()), { ts: 0, tipo: 'pr' }, 'updated_at fica de fora');
  assert.deepEqual(D.diaEntrega(merged, k({ m: { merged: ms(6) } })), { ts: ms(6), tipo: 'pr' });
  assert.deepEqual(D.diaEntrega(merged, k({}, () => ms(7))), { ts: ms(7), tipo: 'pr' }, 'finishedAt da tarefa desta máquina');
  assert.deepEqual(D.diaEntrega({ id: 'd', status: 'done', updated_at: at(9) }, k({ d: { done: ms(8) } })), { ts: ms(8), tipo: 'sempr' });
  assert.deepEqual(D.diaEntrega({ id: 'p', status: 'done', pr_url: 'https://github.com/x/y/pull/3' }, k({ p: { done: ms(8) } })), { ts: ms(8), tipo: 'sempr' }, 'PR aberto e tarefa concluída sem merge NÃO conta como integrada');
  assert.equal(D.diaEntrega({ id: 'r', status: 'review' }, k()), null, 'não entregue');
});

test('agrupa por dia: seg–sex sempre, sáb/dom só com entrega; barras contam só PR; sem data à parte; ordem por modificação', () => {
  const r = D.periodRange({ key: 'custom', from: '2026-10-03', to: '2026-10-09' }, NOW); // sáb 03 → sex 09
  const itens = [
    { t: { id: 'a' }, ts: ms(5, 10), tipo: 'pr', mod: ms(5, 10) },
    { t: { id: 'b' }, ts: ms(8, 9), tipo: 'pr', mod: ms(8, 9) },
    { t: { id: 'c' }, ts: ms(8, 15), tipo: 'pr', mod: ms(9, 8) }, // mexeu depois: vem primeiro
    { t: { id: 'd' }, ts: ms(7), tipo: 'sempr', mod: ms(7) },
    { t: { id: 'e' }, ts: ms(4), tipo: 'pr', mod: ms(4) }, // domingo com entrega: aparece
    { t: { id: 'f' }, ts: 0, tipo: 'pr', mod: ms(9) }, // sem carimbo, mexeu no período
    { t: { id: 'g' }, ts: 0, tipo: 'pr', mod: ms(1) }, // sem carimbo, fora do período: não conta
    { t: { id: 'h' }, ts: ms(1), tipo: 'pr', mod: ms(1) }, // fora do período
  ];
  const g = D.diaAgrupa(itens, r);
  assert.deepEqual(g.dias.map((d) => d.rotulo), ['dom 04/10', 'seg 05/10', 'ter 06/10', 'qua 07/10', 'qui 08/10', 'sex 09/10'], 'sábado sem entrega some');
  assert.deepEqual(g.dias.map((d) => d.n), [1, 1, 0, 0, 2, 0]);
  assert.equal(g.dias[3].sempr, 1); assert.equal(g.dias[3].itens.length, 1, 'concluída sem PR entra no dia, fora da barra');
  assert.deepEqual(g.dias[4].itens.map((x) => x.t.id), ['c', 'b']);
  assert.equal(g.total, 4); assert.equal(g.semData, 1); assert.equal(g.max, 2);
  assert.equal(D.diaEscolhe(g.dias, ''), '2026-10-08', 'abre no dia mais recente com entrega');
  assert.equal(D.diaEscolhe(g.dias, '2026-10-05'), '2026-10-05');
  assert.equal(D.diaEscolhe(g.dias, '2020-01-01'), '2026-10-08');
});

test('resumo do dia copiado: texto puro no formato da mesa', () => {
  const dia = { rotulo: 'sex 09/10', n: 1, itens: [{ k: 1 }, { k: 2 }] };
  const linha = (x) => x.k === 1
    ? { titulo: 'Tela de pedido  pago', pessoa: 'Carla Dias', pr: '93', issue: 'FND-103', reqs: { ok: 3, tot: 3 } }
    : { titulo: 'Revisar textos', pessoa: '', pr: '', issue: '', reqs: null, sempr: true };
  assert.equal(D.diaResumo(dia, linha), 'Entregas de sex 09/10 · 1\n• Tela de pedido pago — Carla Dias — PR #93 — FND-103 — requisitos 3/3\n• Revisar textos — Sem dono — sem PR');
  assert.equal(D.diaResumo({ rotulo: 'seg 05/10', n: 0, itens: [] }, linha), 'Entregas de seg 05/10 · 0');
  assert.equal(D.diaResumo({ rotulo: 'ter 06/10', n: 0, itens: [{}] }, () => ({ titulo: 'X', pessoa: 'Ana', pr: '7', sempr: true })), 'Entregas de ter 06/10 · 0\n• X — Ana — PR #7 (sem merge)');
  // "só minhas" no modo por dia = quem ENTREGOU (responsável, senão quem criou); '-' = sem responsável
  const L = [{ id: 1, assignee: 'A', created_by: 'B' }, { id: 2, assignee: null, created_by: 'A' }, { id: 3, assignee: 'B', created_by: 'A' }];
  assert.deepEqual(D.diaFiltraQuem(L, 'A').map((t) => t.id), [1, 2]);
  assert.deepEqual(D.diaFiltraQuem(L, '-').map((t) => t.id), [2]);
  assert.equal(D.diaFiltraQuem(L, '').length, 3);
});

test('aba: modo lembrado (padrão por épico), período pela modificação REAL (updated_at ou última atividade), grupos por modificação', () => {
  assert.equal(E.entModoDe('dia'), 'dia'); assert.equal(E.entModoDe('xyz'), 'epico'); assert.equal(E.entModoDe(null), 'epico');
  const r = D.periodRange('7d', NOW);
  // a modificação é o maior carimbo: updated_at antigo + atividade recente = mexeu no período
  const idx = E.entAtvIndice([{ task_id: 'b', at: at(8) }, { task_id: 'b', at: at(2) }, { task_id: 'z', at: at(9) }]);
  assert.equal(E.entModDe({ id: 'b', updated_at: at(1) }, idx), ms(8));
  assert.equal(E.entModDe({ id: 'a', updated_at: at(9) }, idx), ms(9));
  const fb = { bucket: (t) => (t.status === 'error' ? 'aguardando' : t.status === 'review' ? 'prontas' : 'andamento'), delivered: () => false };
  const list = [{ id: 'a', updated_at: at(9) }, { id: 'b', updated_at: at(1) }, { id: 'c', updated_at: at(1) }, { id: 'd', updated_at: at(1), status: 'error' }, { id: 'e', updated_at: at(1), status: 'review' }];
  assert.deepEqual(E.entBaseEpico(list, r, (t) => E.entModDe(t, idx), fb).map((t) => t.id), ['a', 'b', 'd', 'e'], 'c não mexeu; travada e pronta ficam sempre');
  const fn = { bucket: (t) => (t.status === 'error' ? 'aguardando' : 'andamento'), delivered: () => false, ativo: () => true, mod: (t) => t.m };
  const ts = [{ id: 'x', epic_id: 'E', status: 'running', m: ms(9) }, { id: 'y', epic_id: 'E', status: 'error', m: ms(5) }, { id: 'z', epic_id: 'E', status: 'running', m: ms(7) }];
  assert.deepEqual(E.entAgrupa(ts, ts, [{ id: 'E', name: 'Ep' }], fn)[0].itens.map((t) => t.id), ['x', 'z', 'y'], 'modificação manda; travada não pula mais na frente');
  assert.deepEqual(Object.keys(E.entProvasLista([{ task_id: 'a', name: 'p.png' }, { task_id: 'a', name: 'requirements.json' }, { task_id: 'b', name: 'q.png' }])), ['a', 'b']);
});

const dados = (o) => ({
  periodo: 'Últimos 7 dias', de: '03/10', ate: '09/10', escopo: 'Do time · Produto', filtros: '', geradoEm: '09/10/2026 15:30',
  itens: [
    { id: '0000ffff-0000-4000-8000-000000000003', titulo: 'Tela de pedido pago', quem: 'Carla Dias', quemId: 'uC', epico: 'Checkout com Pix', epicoId: 'E1', issue: { code: 'FND-102', url: 'https://tracker.exemplo.dev/FND-102' }, pr: { num: '90', url: 'https://github.com/exemplo/loja/pull/90' }, reqs: { ok: 3, tot: 3 }, provas: 2, imgs: [{ nome: 'tela-1.png', path: 'p/tela-1.png' }, { nome: 'tela-2.png', path: 'p/tela-2.png' }], ts: ms(9), dia: 'sex 09/10', tipo: 'pr', mod: ms(9) },
    { id: 'i2', titulo: 'Login com Google', quem: 'Bruno Lima', quemId: 'uB', epico: '', epicoId: '', issue: { code: 'FND-090', url: '' }, pr: { num: '84', url: 'https://github.com/exemplo/loja/pull/84' }, reqs: null, provas: 0, imgs: [], ts: ms(8), dia: 'qui 08/10', tipo: 'pr', mod: ms(8) },
    { id: 'i3', titulo: 'Desconto <b>progressivo</b>', quem: 'Carla Dias', quemId: 'uC', epico: 'Checkout com Pix', epicoId: 'E1', issue: null, pr: { num: '89', url: 'javascript:alert(1)' }, reqs: { ok: 1, tot: 2 }, provas: 0, imgs: [], ts: ms(7), dia: 'qua 07/10', tipo: 'pr', mod: ms(9, 13) },
    { id: 'i4', titulo: 'Revisar textos', quem: 'Carla Dias', quemId: 'uC', epico: '', epicoId: '', issue: null, pr: null, reqs: null, provas: 0, imgs: [], ts: ms(7), dia: 'qua 07/10', tipo: 'sempr', mod: ms(7) },
  ],
  epicos: [{ id: 'E1', nome: 'Checkout com Pix', ent: 3, tot: 5 }],
  travadas: [{ titulo: 'Seletor de horários', quem: 'Carla Dias', motivo: 'Teste de integração falhando no CI.', epico: 'Remarcar aulas', mod: ms(8) }],
  prontas: [{ titulo: 'Cupom de desconto', quem: 'Bruno Lima', epico: 'Checkout com Pix', pr: { num: '88', url: 'https://github.com/exemplo/loja/pull/88' }, mod: ms(9) }],
  fila: [{ titulo: 'Conferir pagamento', quem: 'Sem dono', epico: 'Checkout com Pix', mod: ms(2) }],
  semData: 1, custo: null, ...o,
});

test('relatório: resumo SEM IA em 3–5 linhas (contagens, épicos, travadas, quem entregou), seções ordenadas por modificação', () => {
  const m = R.relMonta(dados());
  assert.ok(m.resumo.length >= 3 && m.resumo.length <= 5);
  assert.equal(m.resumo[0], '3 entregas integradas por 2 pessoas: Carla Dias (2), Bruno Lima (1).');
  assert.match(m.resumo[1], /^Épicos que avançaram: Checkout com Pix \(\+2, 3 de 5 entregues\)\.$/);
  assert.match(m.resumo[2], /^1 travada agora: Seletor de horários \(Teste de integração falhando no CI\.\)\.$/);
  assert.equal(m.resumo[3], '1 pronta pra revisar e 1 na fila dos épicos.');
  assert.equal(m.resumo[4], '1 concluída sem PR · 1 sem data de entrega (fora das contas).');
  assert.deepEqual(m.porEpico.map((g) => g.nome), ['Checkout com Pix', 'Sem épico']);
  assert.deepEqual(m.porEpico[0].itens.map((x) => x.id), ['i3', '0000ffff-0000-4000-8000-000000000003'], 'modificação mais recente primeiro');
  assert.deepEqual(m.porPessoa.map((p) => p.nome + ':' + p.n), ['Carla Dias:2', 'Bruno Lima:1'], 'entrega mais recente primeiro');
  // homônimos: agrupa pelo id, não pelo nome; "Sem dono" não conta como pessoa
  const h = R.relMonta(dados({ itens: [{ ...dados().itens[1], quemId: 'u1', quem: 'Ana' }, { ...dados().itens[1], id: 'x', quemId: 'u2', quem: 'Ana' }, { ...dados().itens[1], id: 'y', quemId: '', quem: 'Sem dono' }] }));
  assert.equal(h.porPessoa.length, 2); assert.match(h.resumo[0], /^3 entregas integradas por 2 pessoas/);
  assert.equal(R.relNome(dados()), 'relatorio-entregas-03-10-a-09-10');
  const vazio = R.relMonta(dados({ itens: [], epicos: [], travadas: [], prontas: [], fila: [], semData: 0 }));
  assert.deepEqual(vazio.resumo, ['Nenhuma entrega integrada no período.', 'Nenhum épico avançou no período.', 'Nada travado agora.', '0 prontas pra revisar e 0 na fila dos épicos.']);
});

test('relatório em Markdown e em HTML autocontido: sem script, sem uuid, custo só quando veio (líder/admin)', () => {
  const m = R.relMonta(dados()), md = R.relMarkdown(m);
  assert.match(md, /^# Relatório de entregas\n/);
  assert.match(md, /- \*\*Tela de pedido pago\*\* — Carla Dias — sex 09\/10 — FND-102 — PR #90 — requisitos 3\/3 — 2 provas/);
  assert.match(md, /## O que está travado agora\n\n- \*\*Seletor de horários\*\* — Carla Dias — Teste de integração falhando no CI\. \(Remarcar aulas\)/);
  assert.match(md, /Desconto \\<b\\>progressivo\\<\/b\\>/, 'markdown escapado');
  const src = (p) => (p === 'p/tela-1.png' ? 'data:image/jpeg;base64,AAAA' : 'https://assinada.exemplo.dev/x.png');
  const html = R.relHtml(m, { css: 'body{}', src });
  assert.ok(html.startsWith('<!doctype html>') && !/<script/i.test(html), 'sem script');
  assert.ok(!UUID.test(html) && !UUID.test(md), 'nenhum id interno');
  assert.ok(!/US\$|custo/i.test(html + md), 'membro: sem custo');
  assert.match(html, /<img src="data:image\/jpeg;base64,AAAA" alt="prova: tela-1.png">/);
  assert.ok(!html.includes('assinada.exemplo.dev'), 'só data: no arquivo (nada de link assinado que expira)');
  assert.ok(!/javascript:/i.test(html), 'link que não é http(s) vira texto');
  assert.match(html, /<a href="https:\/\/github.com\/exemplo\/loja\/pull\/90">PR #90<\/a>/);
  assert.ok(html.includes('Desconto &lt;b&gt;progressivo&lt;/b&gt;'));
  const lider = R.relMonta(dados({ custo: 4.5 }));
  assert.match(lider.resumo[4], /custo das entregas: US\$ 4,50\.$/);
});
