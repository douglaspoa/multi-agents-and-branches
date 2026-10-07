// Bloqueadores de lançamento da Fábrica (mesa de bugs 2, B1–B4) + revisão: `node --test app/tests/teto-sessao.test.mjs`
// B1/B2: o teto da sessão (Mesa, conversa/decisão/pesquisa da Ideia) vale POR CHAMADA. O CLI do Claude confere o gasto
// DEPOIS de cada mensagem — uma fala é cobrada INTEIRA e pode passar da reserva. A garantia honesta é: nunca começa uma
// fala que a sobra não cobre (estimativa ou custo já medido de uma fala), inclusive a 1ª.
// B3: gasto e teto ficam fora do trecho que encolhe no cabeçalho. B4: épico parado no meio = "criado em parte" + continuar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const MESA = read('js/38-mesa.js'), IDEIA = read('js/59-ideia.js'), FABJS = read('js/65-fabrica.js');
const M = new Function(cut(MESA, '// @puro-inicio', '// @puro-fim') + '\nreturn { mesaCallBudget, mesaCallFloor, mesaPurse, mesaLearnWant, mesaGenCap, mesaTetoNote: typeof mesaTetoNote==="undefined"?null:mesaTetoNote, MESA_MIN_CALL };')();
const F = new Function(cut(FABJS, '// @fabrica-puro-inicio', '// @fabrica-puro-fim') + '\nreturn { fabCriadoEstado, fabParte, fabJaCriadas };')();

// motor de mentira como o CLI real: a fala é cobrada INTEIRA (mesmo passando da reserva) e o custo só chega no fim
async function simula({ cap, n, pool, custo, est, sess = { gasto: 0, want: 0 }, queue = Array.from({ length: n }, (_, i) => i) }) {
  const purse = M.mesaPurse(() => sess.gasto, () => cap, () => Math.max(sess.want, est)); // como a tela: estimativa é o mínimo
  let lancadas = 0, maxEmVoo = 0, parouNoTeto = false, excedente = 0;
  const worker = async () => {
    while (queue.length) {
      const antes = { gasto: sess.gasto, reserva: purse.reserved }, free0 = purse.free();
      const b = purse.take(Math.min(pool - purse.inflight, queue.length));
      if (b == null) { if (!purse.inflight) parouNoTeto = true; break; }
      // a garantia: só começa se a sobra cobre a reserva E o piso de uma fala
      assert.ok(antes.gasto + antes.reserva + b <= cap + 1e-9, 'reserva cabe na sobra');
      assert.ok(cap - antes.gasto - antes.reserva >= M.mesaCallFloor(Math.max(sess.want, est), cap) - 1e-9, 'sobra cobre uma fala');
      queue.shift(); lancadas++; maxEmVoo = Math.max(maxEmVoo, purse.inflight);
      await new Promise((r) => setTimeout(r, 1 + Math.random() * 4));
      const c = custo();
      sess.gasto += c; excedente += Math.max(0, c - b); // cobra a fala inteira
      sess.want = M.mesaLearnWant(sess.want, c, false, b >= free0 - 0.01);
      purse.give(b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, queue.length) }, worker));
  return { gasto: sess.gasto, lancadas, sobrou: queue.length, maxEmVoo, parouNoTeto, excedente, sess, queue };
}

test('B1: teto US$ 0,50, 5 personas de ~US$ 0,40, 3 em paralelo (estimativa 0,26): cobrando a fala inteira, não passa do teto', async () => {
  const r = await simula({ cap: 0.5, n: 5, pool: 3, custo: () => 0.4, est: 0.26 });
  assert.ok(r.gasto <= 0.5 + 1e-9, `gastou ${r.gasto} de 0,50 (antes: 1,60)`);
  assert.equal(r.lancadas, 1, 'uma fala com a sobra inteira; a 2ª não cabe (0,10 < piso) e não começa');
  assert.equal(r.parouNoTeto, true); assert.ok(r.sobrou > 0);
});

test('B1/B2: estimativa que cobre a fala (e cabe em meio teto) → soma nunca passa do teto (300 sessões aleatórias, custo cobrado inteiro)', async () => {
  for (let k = 0; k < 300; k++) {
    const cap = Math.round((0.05 + Math.random() * 5) * 100) / 100, n = 1 + Math.floor(Math.random() * 9), pool = 1 + Math.floor(Math.random() * 4);
    const est = Math.min(0.05 + Math.random() * 0.6, cap / 2); // acima de meio teto o piso fica em meio teto (não trava): aí pode passar
    const r = await simula({ cap, n, pool, est, custo: () => est * Math.random() });
    assert.ok(r.gasto <= cap + 1e-9, `teto ${cap} · gastou ${r.gasto}`);
  }
});

test('B1: estimativa errada pra baixo → o teto só passa pelo excedente das falas que já tinham começado', async () => {
  for (let k = 0; k < 100; k++) {
    const cap = 1 + Math.random() * 3, r = await simula({ cap, n: 8, pool: 3, est: 0.1, custo: () => Math.random() * 0.8 });
    assert.ok(r.gasto <= cap + r.excedente + 1e-9, 'nunca começa fala sem sobra: o que passa é só o excedente');
  }
});

test('B1: com folga todo mundo roda; com sobra curta, menos em paralelo; piso nunca passa de metade do teto', async () => {
  const r = await simula({ cap: 10, n: 5, pool: 3, custo: () => 0.4, est: 0.26 });
  assert.equal(r.lancadas, 5); assert.equal(r.sobrou, 0); assert.ok(Math.abs(r.gasto - 2) < 1e-9);
  assert.equal(M.mesaCallBudget(0, 0, 0.5, 3, null, 0.1), 0.16, 'arredonda pra baixo: 3 × 0,16 ≤ 0,50');
  assert.equal(M.mesaCallBudget(0, 0, 1, 3, null, 0.4), 0.5, 'fala de 0,40 com sobra 1,00: 2 em paralelo, não 3');
  assert.equal(M.mesaCallBudget(0.6, 0, 1, 3, null, 0.5), null, 'sobra 0,40 < fala medida 0,50: não começa (inclusive pela estimativa)');
  assert.equal(M.mesaCallBudget(0, 0, 0.2, 1, null, 0.26), 0.2, 'estimativa maior que metade do teto: o piso fica em metade (não trava a sessão)');
  assert.equal(M.mesaCallFloor(5, 1), 0.5);
  assert.equal(M.mesaCallBudget(0.48, 0, 0.5, 1), null, 'sobra menor que a fala mínima');
  assert.equal(M.mesaCallBudget(0, 0, 0, 1), null, 'sem teto = não lança (teto obrigatório)');
  assert.equal(M.mesaCallBudget(0, 0, 5, 1, 1), 1, 'max: a pesquisa reserva até o teto dela');
  assert.equal(M.mesaCallBudget(0, 0, 5, 1, 0), null, 'max 0 = nada (não é "sem limite")');
});

test('revisão 4: o custo aprendido não trava a sessão — fala cortada com a sobra inteira não ensina; "continuar" anda', async () => {
  assert.equal(M.mesaLearnWant(0.2, 0.5, true, true), 0.2, 'cortada com a sobra inteira: não aprende');
  assert.equal(M.mesaLearnWant(0.2, 0.5, true, false), 0.5);
  assert.equal(M.mesaLearnWant(0.2, 0.1, false, false), 0.2);
  const s1 = await simula({ cap: 0.5, n: 5, pool: 3, custo: () => 0.4, est: 0.4 });
  const s2 = await simula({ cap: 1.0, pool: 3, custo: () => 0.4, est: 0.4, sess: s1.sess, queue: s1.queue }); // teto subiu: o custo medido continua valendo
  assert.ok(s2.lancadas >= 1, 'continuar com mais teto entrega');
  assert.ok(s2.sess.gasto <= 1.0 + 1e-9);
  // estimativa baixa (0,25) e fala real de 0,40: a 1ª leva passa do teto, MAS aprende o custo real e o "continuar"
  // não repete o estouro (zerar o aprendido ao subir o teto repetia: 0,80 → 1,60 no harness)
  const b1 = await simula({ cap: 0.5, n: 5, pool: 3, custo: () => 0.4, est: 0.25 });
  const b2 = await simula({ cap: Math.max(0.5, b1.sess.gasto) + 0.5, pool: 3, custo: () => 0.4, est: 0.25, sess: b1.sess, queue: b1.queue });
  assert.ok(b2.sess.gasto <= Math.max(0.5, b1.gasto) + 0.5 + 1e-9, 'depois de aprender, o continuar respeita o teto');
  assert.ok(b2.lancadas >= 1);
});

test('revisão 2: aprende pelo gasto real (delta), em qualquer motor; aviso "sem teto por chamada" fora do Claude', () => {
  const ask = cut(MESA, 'async function mesaAsk', 'function mesaErrMsg');
  assert.match(ask, /mesaLearnWant\(m\.callWant, delta/, 'mesa: delta de mesaSpentUsd (US$ do Claude ou tokens)');
  assert.match(cut(IDEIA, 'async function ideiaAsk', 'async function ideiaRunTurn'), /mesaLearnWant\(m\.callWant, ideiaSpent\(m\)-c0/);
  const note = new Function(cut(MESA, 'function mesaTetoNote', 'function mesaMesaHtml') + 'return mesaTetoNote;')();
  assert.match(note('codex'), /sem teto por chamada neste motor/);
  assert.match(note('claude'), /não começa uma fala que a sobra do teto não cobre/);
  assert.match(note('claude', true), /gasto pode estar subestimado/, 'revisão 11: fala parada no meio');
});

test('revisão 1/5/11: fala que passa da PARTE volta pra fila (uma vez) e a sessão segue; parada no meio marca o gasto como incerto', () => {
  const round = cut(MESA, 'async function mesaRunRound', 'async function mesaStop');
  assert.match(round, /MESA_BUDGET[^\n]*again\.has\(p\.id\)[^\n]*queue\.push\(p\)/);
  assert.doesNotMatch(round, /budgetHit=true/, 'passar da parte não pausa a sessão');
  assert.match(round, /return capped && queue\.length>0;/);
  assert.match(cut(MESA, 'async function mesaAsk', 'function mesaErrMsg'), /MESA_STOPPED\|demorou mais[^\n]*costUnsure=true/);
  for (const fn of ['async function ideiaRunTurn', 'async function ideiaDecide']) assert.match(cut(IDEIA, fn, '\n}\n'), /again\.has\(p\.id\)[^\n]*queue\.push\(p\)/);
});

test('revisão 3/10: a pesquisa reserva dentro do try, deixa uma fala na sobra, e libera quem esperava por ela', () => {
  const res = cut(IDEIA, 'async function ideiaResearch', 'async function ideiaStopResearch');
  const iTry = res.indexOf('  try{\n'), iTake = res.indexOf('budget=purse.take(');
  assert.ok(iTry > 0 && iTake > iTry, 'o take fica dentro do try (a reserva nunca fica presa)');
  assert.match(res, /const lim=purse\.free\(\)-mesaCallFloor\(/);
  assert.match(res, /if\(budget!=null\) purse\.give\(budget\);[^\n]*\n\s*ideiaAfterResearch\(m\)/);
  assert.match(cut(IDEIA, 'async function ideiaRunTurn', 'async function ideiaStopTurn'), /else if\(L\.research&&L\.research\.running\) L\.waitRes=true/);
  assert.match(IDEIA, /esperando a pesquisa terminar/);
});

test('revisão 6/8/9: gerar personas tem teto; novo teto ≥ gasto + fala mínima; mesa sem teto pede um teto', () => {
  assert.equal(M.mesaGenCap(2), 0.5); assert.equal(M.mesaGenCap(0.3), 0.3); assert.equal(M.mesaGenCap(0), 0.5);
  assert.match(cut(MESA, 'async function mesaGenerate', 'async function mesaArgue'), /mesaAsk\(tmp, MESA_GEN_SYS, mesaGenPrompt\(tema\), true, mesaGenCap\(/);
  const chk = cut(IDEIA, 'function ideiaCapCheck', '\n}\n');
  assert.match(chk, /c\.cap < \(\+spent\|\|0\)\+MESA_MIN_CALL/);
  assert.match(cut(IDEIA, 'async function ideiaCapRaise', 'function ideiaRender'), /ideiaCapCheck\(/);
  assert.match(cut(MESA, 'function mesaMesaHtml', 'function mesaCriadasHtml'), /esta mesa não tem teto/);
});

test('B1/B2: as chamadas levam o teto da chamada pro motor; a Ideia nasce com teto obrigatório', () => {
  assert.match(MESA, /invoke\('mesa_ask',\{[^}]*budgetUsd:/);
  assert.match(IDEIA, /'ideia_ask',\{[^}]*budgetUsd:/);
  assert.match(cut(MESA, 'async function mesaRunRound', 'async function mesaStop'), /purse\.take\(/);
  const dec = cut(IDEIA, 'async function ideiaDecide', 'async function ideiaStopDecide');
  assert.match(cut(IDEIA, 'async function ideiaRunTurn', 'async function ideiaStopTurn'), /purse\.take\(/);
  assert.match(dec, /purse\.take\(/); assert.match(dec, /ideiaNeedsCap\(m/);
  assert.match(cut(IDEIA, 'async function ideiaStart', 'async function ideiaSendFromInput'), /ideiaCapCheck\(/);
});

test('B3: gasto e teto vão no slot que não encolhe (pgh-money), na Ideia e na Mesa', () => {
  assert.match(read('js/00-util.js'), /class="pgh-money"/);
  assert.match(read('css/99-paginas.css'), /\.pgh-money\{[^}]*flex:none/);
  assert.match(read('css/99-paginas.css'), /\.pgh-t:has\(\.pgh-money\)\{[^}]*flex-wrap:wrap/);
  assert.match(cut(IDEIA, 'function ideiaIdeaHtml', 'function ideiaWire'), /pageHead\(\{ title:[^\n]*\bmoney,/);
  assert.match(cut(MESA, 'function mesaMesaHtml', 'function mesaCriadasHtml'), /pageHead\(\{ title:[^\n]*\bmoney,/);
});

test('B4 + revisão 7: "criado em parte" e "continuar" usam a MESMA regra; retomada confere as tarefas do épico no projeto', () => {
  assert.deepEqual(F.fabCriadoEstado({ epicId: 'e', partial: true, tasks: ['t1'] }, 3), { kind: 'parcial', n: 1, m: 3 });
  assert.deepEqual(F.fabCriadoEstado({ epicId: 'e', partial: false, tasks: ['t1', 't2', 't3'] }, 3), { kind: 'feito', n: 3, m: 3 });
  assert.deepEqual(F.fabCriadoEstado({ epicId: 'e', partial: false, tasks: ['t1'] }, 3), { kind: 'parcial', n: 1, m: 3 }, 'faltou tarefa = em parte, mesmo sem a marca');
  assert.equal(F.fabCriadoEstado({ tasks: ['t1'] }, 3).kind, 'feito', 'sem id de épico não dá pra retomar: não oferece');
  assert.deepEqual(F.fabCriadoEstado({ ideia: 'i-1' }, 0), { kind: 'ideia' });
  assert.equal(F.fabCriadoEstado(null, 3), null);
  assert.ok(F.fabParte({ epicId: 'e', partial: false, tasks: ['t1'] }), 'parcial sem a marca também retoma (antes criava o épico inteiro de novo)');
  assert.equal(F.fabParte({ ideia: 'i' }), null);
  // a marca da 2ª tarefa não foi gravada: ela existe no projeto com o épico → não cria de novo
  assert.deepEqual(F.fabJaCriadas(['t1'], ['A', 'B', 'C'], [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }]), ['t1', 't2']);
  assert.deepEqual(F.fabJaCriadas([], ['A', 'B'], [{ id: 'x', title: 'B' }]), [], 'para no 1º buraco');
  const mk = cut(FABJS, 'async function fabMakeEpic', '// ---------------- tela');
  assert.match(mk, /const part=fabParte\(/);
  assert.match(mk, /made=fabJaCriadas\(made, all\.map\(x=>x\.payload\.title\)/);
  assert.match(cut(FABJS, 'function fabFooterHtml', 'function fabConfirmHtml'), /criado em parte/);
});
