// Gestão do time (mesa 09/10, D6): aviso pra quem PERDEU o cartão (72 @gestao-puro-*), motivo da trava (70 entMotivo/
// entPrTrava/entTravada) e ordem por modificação na Central (71/66 + 08-periodo). `node --test app/tests/` — recorta o
// código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const G = new Function(cut(read('72-gestao-time.js'), '// @gestao-puro-inicio', '// @gestao-puro-fim')
  + '\nreturn { gtMineSnap, gtLostCards, gtLostAct, gtLostNotif, gtLostAcaba };')();
const E = new Function(cut(read('70-time-entregas.js'), '// @puro-entregas-inicio', '// @puro-entregas-fim')
  + '\nreturn { entTravada, entPronta, entMotivo, entPrTrava, entNums };')();
const P = new Function(cut(read('08-periodo.js'), '// @puro-periodo-inicio', '// @puro-periodo-fim') + '\nreturn { sortRows, modTs, modAgoTx };')();

const ME = 'u-m', LEAD = 'u-a', C = 'u-c';
const NOW = Date.parse('2026-10-09T15:00:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const names = { [ME]: 'Bruno', [LEAD]: 'Ana', [C]: 'Carla' };
const nm = (u) => names[u] || u;

test('foto "no meu nome": vale o que veio na busca; o que não veio (outro time/alcance) fica como estava', () => {
  const prev = { x1: NOW - 9e5, fora: NOW - 5e6 };
  const tasks = [{ id: 'x1', assignee: C }, { id: 'x2', assignee: ME }, { id: 'x3', assignee: null }];
  const snap = G.gtMineSnap(prev, tasks, ME, NOW);
  assert.deepEqual(Object.keys(snap).sort(), ['fora', 'x2'], 'x1 saiu (agora é da Carla), x2 entrou, "fora" não veio e fica');
  assert.equal(snap.x2, NOW);
  assert.deepEqual(G.gtLostCards(prev, tasks, ME).map((t) => t.id), ['x1'], 'perdido = estava na foto e agora não está comigo');
  assert.deepEqual(G.gtLostCards({}, tasks, ME), [], 'sem foto, nada perdido');
  const big = {}; for (let i = 0; i < 500; i++) big['c' + i] = i;
  assert.equal(Object.keys(G.gtMineSnap(big, [], ME, NOW)).length, 400, 'teto de 400 (os mais recentes)');
  assert.ok('c499' in G.gtMineSnap(big, [], ME, NOW) && !('c0' in G.gtMineSnap(big, [], ME, NOW)));
});

test('a troca que tirou o cartão de mim: 1ª mudança de dono por OUTRA pessoa depois da última vez que vi no meu nome', () => {
  const since = NOW - 30 * 60000;
  const acts = [
    { id: 1, task_id: 'k', user_id: LEAD, kind: 'assigned', body: ME, at: at(29) },      // veio pra mim (ignora)
    { id: 2, task_id: 'k', user_id: LEAD, kind: 'assigned', body: C, at: at(10) },       // A passou pra Carla ← esta
    { id: 3, task_id: 'k', user_id: C, kind: 'released', body: '', at: at(5) },          // depois a Carla devolveu
    { id: 4, task_id: 'outro', user_id: LEAD, kind: 'assigned', body: C, at: at(8) },
    { id: 0, task_id: 'k', user_id: LEAD, kind: 'assigned', body: C, at: at(600) },      // antiga, antes da foto
  ];
  assert.equal(G.gtLostAct(acts, 'k', ME, since).id, 2, 'a mais antiga depois da foto (não a devolução da Carla)');
  assert.equal(G.gtLostAct([{ id: 9, task_id: 'k', user_id: ME, kind: 'assigned', body: C, at: at(3) }], 'k', ME, since), null, 'eu mesmo passei: sem aviso');
  assert.equal(G.gtLostAct([{ id: 9, task_id: 'k', user_id: ME, kind: 'released', body: '', at: at(3) }], 'k', ME, since), null, 'eu mesmo devolvi: sem aviso');
  assert.equal(G.gtLostAct(acts, 'nada', ME, since), null);
  assert.equal(G.gtLostAct([{ id: 5, task_id: 'k', user_id: null, kind: 'released', at: at(3) }], 'k', ME, since), null, 'sem autor: pula');
  // Carla devolveu, EU assumi, o líder passou pro Diego → avisa a passagem pro Diego (não a devolução da Carla)
  const seq = [{ id: 1, task_id: 'k', user_id: C, kind: 'released', at: at(12) }, { id: 2, task_id: 'k', user_id: ME, kind: 'claimed', at: at(11) }, { id: 3, task_id: 'k', user_id: LEAD, kind: 'assigned', body: 'u-d', at: at(2) }];
  assert.equal(G.gtLostAct(seq, 'k', ME, NOW - 11 * 60000).id, 3);
  assert.equal(G.gtLostAct([{ id: 4, task_id: 'k', user_id: C, kind: 'claimed', at: at(2) }], 'k', ME, since).id, 4, 'nuvem sem a 0032: colega assumiu o meu');
  // sem a troca achada: segura na foto (a atividade pode chegar depois) — desiste se EU mexi depois ou passou 1 dia
  assert.equal(G.gtLostAcaba([], 'k', ME, since, NOW), false);
  assert.equal(G.gtLostAcaba([], 'k', ME, NOW - 2 * 86400000, NOW), true);
  assert.equal(G.gtLostAcaba([{ task_id: 'k', user_id: ME, kind: 'released', at: at(3) }], 'k', ME, since, NOW), true);
  // relógio: 10 min de folga (a nuvem carimba um pouco antes da minha última busca)
  assert.equal(G.gtLostAct([{ id: 7, task_id: 'k', user_id: LEAD, kind: 'released', body: '', at: new Date(since - 60000).toISOString() }], 'k', ME, since).id, 7);
});

test('texto do aviso: "Fulano passou ‘X’ pra Beltrano" / "Fulano tirou ‘X’ de você — ficou livre"; o que EU fiz não avisa', () => {
  const t = { id: 'k', title: 'Botão remarcar em cada aula' };
  assert.deepEqual(G.gtLostNotif({ user_id: LEAD, kind: 'assigned', body: C }, t, ME, nm), { title: 'Tarefa passada pra outra pessoa', body: 'Ana passou ‘Botão remarcar em cada aula’ pra Carla' });
  assert.deepEqual(G.gtLostNotif({ user_id: LEAD, kind: 'released', body: '' }, t, ME, nm), { title: 'Tarefa tirada de você', body: 'Ana tirou ‘Botão remarcar em cada aula’ de você — ficou livre' });
  assert.equal(G.gtLostNotif({ user_id: ME, kind: 'released' }, t, ME, nm), null);
  assert.equal(G.gtLostNotif({ user_id: LEAD, kind: 'assigned', body: ME }, t, ME, nm), null, 'veio pra mim não é perda');
  assert.equal(G.gtLostNotif({ user_id: LEAD, kind: 'assigned', body: LEAD }, t, ME, nm).body, 'Ana ficou com ‘Botão remarcar em cada aula’ (era sua)', 'líder pegou pra si');
  assert.equal(G.gtLostNotif({ user_id: null, kind: 'released' }, t, ME, nm), null, 'sem autor não inventa nome');
  assert.equal(G.gtLostNotif({ user_id: C, kind: 'claimed' }, t, ME, nm).body, 'Carla assumiu ‘Botão remarcar em cada aula’ (era sua)');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(G.gtLostNotif({ user_id: LEAD, kind: 'assigned', body: C }, { title: 'x'.repeat(200) }, ME, nm).body), 'nunca uuid');
});

test('o 43 avisa quem perdeu ANTES do laço e o "told" existe antes de ser usado (ReferenceError do #143)', () => {
  const src = read('43-espaco-times.js');
  const fn = cut(src, 'async function teamNotifTick', "tickLoop('teamNotifTick'");
  assert.ok(fn.indexOf('const told=new Set()') >= 0 && fn.indexOf('const told=new Set()') < fn.indexOf('told.add('), 'told declarado antes do uso');
  assert.ok(fn.indexOf('gtLostTick(') > 0 && fn.indexOf('gtLostTick(') < fn.indexOf('for(const t of teamTasks)'), 'perda conferida antes (vale na 1ª volta depois de reabrir)');
  assert.ok(/lostTold\.has\(key\)/.test(fn), 'a atividade já avisada como perda não repete como "mudou de mãos"');
  const g = read('72-gestao-time.js');
  assert.ok(/pushNotif\(k\.title, k\.body/.test(g) && /toast\(k\.body/.test(g), 'notificação + toast');
  assert.ok(/seenSet\('sb:seenlost'\)/.test(g) && /userKey\('sb:minecards'/.test(g), 'dedupe por atividade e foto por pessoa (localStorage)');
});

// ---- motivo da trava (fonte única no 70) ----
const BK = { backlog: 'fila', running: 'andamento', error: 'aguardando', conflict: 'aguardando', 'plan-review': 'aguardando', 'needs-you': 'aguardando', review: 'prontas', merged: 'anteriores' };
const fn = { bucket: (t) => (t.pr_url && t.status !== 'merged' && !String(BK[t.status]).startsWith('ag') ? 'praberto' : BK[t.status] || 'andamento'),
  delivered: (t) => ['merged', 'done'].includes(t.status), flag: (t) => t.flag };

test('motivo: pergunta, plano, loop, decisão do ciclo, conflito, checagem do PR, pedido do celular, erro, bloqueada', () => {
  const t = { last_note: 'Teste de integração falhando no CI. Falta o mock.' };
  assert.equal(E.entMotivo(t, 'erro'), 'Teste de integração falhando no CI.', 'sem contexto = regra antiga (1ª frase da nota)');
  assert.equal(E.entMotivo({}, 'erro'), 'erro');
  assert.equal(E.entMotivo(t, 'erro', { st: 'error' }), 'erro: Teste de integração falhando no CI.');
  assert.equal(E.entMotivo({}, 'erro', { st: 'error' }), 'parou com erro');
  assert.equal(E.entMotivo(t, '', { st: 'asking', pergunta: 'Pode apagar a tabela antiga?' }), 'pergunta pendente: Pode apagar a tabela antiga?');
  assert.equal(E.entMotivo(t, '', { st: 'plan-review' }), 'plano pra aprovar');
  assert.equal(E.entMotivo(t, '', { st: 'needs-you', needsYou: { kind: 'teto', text: 'longo' } }), 'teto de custo atingido');
  assert.equal(E.entMotivo(t, '', { st: 'needs-you', loop: { what: 'npm test' } }), 'repetindo o mesmo erro: npm test');
  assert.equal(E.entMotivo(t, '', { st: 'conflict' }), 'conflito com a base');
  assert.equal(E.entMotivo(t, '', { st: 'pr-open', pr: E.entPrTrava({ checksFail: 2, failingChecks: ['lint', 'test'] }) }), 'checagem do PR falhou: lint, test');
  assert.equal(E.entMotivo(t, '', { st: 'pr-open', pr: E.entPrTrava({ mergeable: 'CONFLICTING' }) }), 'conflito com a base');
  assert.equal(E.entMotivo(t, '', { st: 'review', intent: 'não abriu o PR: checagem falhou: lint' }), 'não abriu o PR: checagem falhou: lint');
  assert.equal(E.entMotivo({ last_note: 'Esperando a definição do limite.' }, '', { st: 'backlog', flag: 'blocked' }), 'bloqueada: Esperando a definição do limite.');
  assert.ok(E.entMotivo({}, '', { pergunta: 'x'.repeat(300) }).length <= 90, 'curto (1 linha)');
  assert.equal(E.entPrTrava({ state: 'MERGED', checksFail: 3 }), null, 'PR integrado não trava');
  assert.equal(E.entPrTrava({ checksFail: 0, mergeable: 'MERGEABLE' }), null);
  assert.equal(E.entPrTrava(null), null);
  assert.equal(E.entPrTrava({ checksFail: 1, at: new Date(Date.now() - 2 * 86400000).toISOString() }), null, 'retrato velho (quem fez offline) não afirma trava');
  assert.equal(E.entMotivo({ last_note: 'Esperando o jurídico.' }, '', { st: 'pr-open', flag: 'blocked', pr: E.entPrTrava({ checksFail: 1 }) }), 'bloqueada: Esperando o jurídico.', 'bloqueio manual vence');
});

test('travada inclui PR que não anda (com fn.prTrava) e deixa de ser "pronta pra revisar"; entregue nunca trava', () => {
  const pr = { id: 'p', status: 'review', pr_url: 'https://github.com/exemplo/loja/pull/1' };
  assert.equal(E.entTravada(pr, fn), false);
  assert.equal(E.entPronta(pr, fn), true);
  const f2 = { ...fn, prTrava: (t) => t.id === 'p' || t.id === 'm' };
  assert.equal(E.entTravada(pr, f2), true, 'checagem falhou = travada (com PR)');
  assert.equal(E.entPronta(pr, f2), false);
  assert.equal(E.entTravada({ id: 'm', status: 'merged', pr_url: 'x' }, f2), false, 'integrada não trava');
  assert.equal(E.entTravada({ id: 'p', status: 'cancelled', pr_url: 'x' }, f2), false, 'cancelada não trava');
  assert.equal(E.entNums([pr], f2).travadas, 1);
});

test('telas usam a fonte única do motivo (entTravaTx) — Central, épicos, quadro do Time, cartão do colega, Entregas', () => {
  const ca = read('71-central-alcance.js'), ts = read('43-espaco-times.js'), ct = read('45-entrega-time.js'), en = read('70-time-entregas.js');
  assert.ok((ca.match(/entTravaTx\(t\)/g) || []).length >= 2, 'linha da tarefa e linha do épico');
  assert.ok(/entTravaTx\(t\)/.test(ts) && /entTravaTx\(ct\)/.test(ct) && /entTravaTx\(t\)/.test(en));
  assert.ok(!/entMotivo\(t, ''\)/.test(ca), 'a Central não monta motivo próprio');
  assert.ok(/checksFail:\+i\.checksFail/.test(read('42-nuvem-sync-mobile.js')), 'o PR publica o que trava (gestor vê sem a máquina de quem fez)');
});

// ---- ordem por modificação ----
test('Central: padrão = modificação mais recente; coluna clicada só com a tela aberta (sem gravar)', () => {
  const rows = [{ id: 'velha', title: 'A', m: P.modTs(at(300)) }, { id: 'nova', title: 'Z', m: P.modTs(at(2)) }, { id: 'meio', title: 'M', m: P.modTs(at(60), at(90)) }];
  assert.deepEqual(P.sortRows(rows, (r) => r.m, { col: 'mod', dir: 'desc' }).map((r) => r.id), ['nova', 'meio', 'velha']);
  assert.deepEqual(P.sortRows(rows, (r) => r.m, { col: 'dem', dir: 'asc' }, (r) => r.title).map((r) => r.id), ['velha', 'meio', 'nova']);
  const ca = read('71-central-alcance.js'), ct = read('66-central-tabela.js'), g = read('72-gestao-time.js'), tabs = read('15-config-abas-onboarding.js');
  assert.ok(/sortRows\(list, caModOf, sortGet\(SC\), caSortVal\)/.test(ca), 'tarefas (todos os alcances)');
  assert.ok(/sortRows\(base, r=>r\.md, so, val\)/.test(ca), 'épicos');
  assert.ok(/modAgoTx\(md\)/.test(ca) && !/agoTx\(t\.updated_at\)/.test(ca), '"atualizado há X" com a MESMA data');
  assert.ok(!/lsSet\('ctSort'/.test(ct) && !/lsGet\('ctSort'/.test(ct), 'a tabela local não grava a coluna clicada');
  assert.ok(/sortOnScreenOpen\(tabById\(id\)\)/.test(tabs) && /sortReset/.test(g), 'voltar pra Central zera a coluna clicada');
  assert.ok(/modTs\(t\.updated_at, t\.created_at, gtActAt\(t\.id\)/.test(g), 'cartão: updated_at + última atividade + tarefa local');
});
