// Bloqueadores de lançamento da Fábrica (mesa de bugs 2, B1–B4): `node --test app/tests/teto-sessao.test.mjs`
// B1/B2: o teto da sessão (Mesa, conversa e decisão da Ideia) vale POR CHAMADA — cada fala reserva a sua parte do que
// sobra e vai pro motor com esse teto; a soma do gasto nunca passa do teto, mesmo com 3 em paralelo.
// B3: gasto e teto ficam fora do trecho que encolhe no cabeçalho. B4: épico parado no meio = "criado em parte" + continuar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const MESA = read('js/38-mesa.js'), IDEIA = read('js/59-ideia.js'), FABJS = read('js/65-fabrica.js');
const M = new Function(cut(MESA, '// @puro-inicio', '// @puro-fim') + '\nreturn { mesaCallBudget, mesaPurse, mesaLearnWant, MESA_MIN_CALL };')();
const F = new Function(cut(FABJS, '// @fabrica-puro-inicio', '// @fabrica-puro-fim') + '\nreturn { fabCriadoEstado };')();

// motor de mentira que respeita o teto da chamada como o Claude (`--max-budget-usd`): gasta o que custaria, até o teto
async function simula({ cap, n, pool, custo, want0 = 0, sess = { gasto: 0, want: 0 }, queue = Array.from({ length: n }, (_, i) => i) }) {
  const purse = M.mesaPurse(() => sess.gasto, () => cap, () => sess.want || want0, () => sess.want);
  let lancadas = 0, maxEmVoo = 0, ok = 0, parouNoTeto = false;
  const worker = async () => {
    while (queue.length) {
      const b = purse.take(Math.min(pool - purse.inflight, queue.length));
      if (b == null) { if (!purse.inflight) parouNoTeto = true; break; } // como na tela: só conclui o teto sem fala em voo
      queue.shift(); lancadas++; maxEmVoo = Math.max(maxEmVoo, purse.inflight);
      assert.ok(purse.reserved + sess.gasto <= cap + 1e-9, 'reserva + gasto nunca passam do teto');
      await new Promise((r) => setTimeout(r, 1 + Math.random() * 4));
      const c = custo(), hit = c > b;
      sess.gasto += Math.min(c, b); // o custo só chega no FIM da chamada
      if (hit) queue.push('de novo'); else ok++; // bateu no teto da chamada: volta pra fila
      sess.want = M.mesaLearnWant(sess.want, hit ? { budgetHit: true } : { costUsd: c }, b);
      purse.give(b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, queue.length) }, worker));
  return { gasto: sess.gasto, lancadas, sobrou: queue.length, maxEmVoo, ok, sess, queue, parouNoTeto };
}

test('B1: a mesa com teto US$ 0,50 e 5 personas de ~US$ 0,40, 3 em paralelo, nunca passa do teto', async () => {
  const r = await simula({ cap: 0.5, n: 5, pool: 3, custo: () => 0.4 });
  assert.ok(r.gasto <= 0.5 + 1e-9, `gastou ${r.gasto} de 0,50 (antes: 1,60)`);
  assert.ok(r.sobrou > 0, 'quem não coube volta pra fila (a mesa pausa no teto)');
  assert.equal(r.parouNoTeto, true);
  assert.equal(r.maxEmVoo, 3);
});

test('B1: teto curto não desperdiça — menos falas em paralelo, cada uma com o bastante; "continuar" anda', async () => {
  // estimativa de 1 fala (~US$ 0,26) com teto 0,50: 1 por vez com a sobra inteira → a 1ª persona (0,40) termina
  const r = await simula({ cap: 0.5, n: 5, pool: 3, custo: () => 0.4, want0: 0.26 });
  assert.ok(r.gasto <= 0.5 + 1e-9); assert.ok(r.ok >= 1, 'pelo menos uma persona entregou');
  // sem estimativa: a 1ª leva bate no teto da chamada, aprende (dobra) e o "continuar com +0,50" entrega
  const s1 = await simula({ cap: 0.5, n: 5, pool: 3, custo: () => 0.4 });
  assert.ok(s1.gasto <= 0.5 + 1e-9);
  const s2 = await simula({ cap: 1.0, pool: 3, custo: () => 0.4, sess: s1.sess, queue: s1.queue });
  assert.ok(s2.sess.gasto <= 1.0 + 1e-9); assert.ok(s2.ok >= 1, 'continuar com mais teto entrega');
});

test('B1/B2: soma nunca passa do teto — 300 sessões aleatórias (teto, personas, paralelo e custo variados)', async () => {
  for (let k = 0; k < 300; k++) {
    const cap = Math.round((0.05 + Math.random() * 5) * 100) / 100, n = 1 + Math.floor(Math.random() * 9), pool = 1 + Math.floor(Math.random() * 4);
    const r = await simula({ cap, n, pool, custo: () => Math.random() * 1.2 });
    assert.ok(r.gasto <= cap + 1e-9, `teto ${cap} · gastou ${r.gasto}`);
  }
});

test('B1: com folga no teto todo mundo roda; o orçamento por chamada é a sobra dividida pelas vagas', async () => {
  const r = await simula({ cap: 10, n: 5, pool: 3, custo: () => 0.4 });
  assert.equal(r.lancadas, 5); assert.equal(r.sobrou, 0); assert.ok(Math.abs(r.gasto - 2) < 1e-9);
  assert.equal(M.mesaCallBudget(0, 0, 0.5, 3), 0.16, 'arredonda pra baixo: 3 × 0,16 ≤ 0,50');
  assert.equal(M.mesaCallBudget(0.3, 0.16, 0.5, 1), 0.04);
  assert.equal(M.mesaCallBudget(0.48, 0, 0.5, 1), null, 'sobra menor que uma chamada mínima = parou no teto');
  assert.equal(M.mesaCallBudget(0.6, 0, 0.5, 1), null, 'já passou = não lança');
  assert.equal(M.mesaCallBudget(0, 0, 0, 1), null, 'sem teto = não lança (teto obrigatório)');
  assert.equal(M.mesaCallBudget(0, 0, 5, 1, 1), 1, 'max: a pesquisa reserva até o teto dela');
  assert.equal(M.mesaCallBudget(0.6, 0, 1, 3, 0, 0.5, 0.5), null, 'sobra (0,40) menor que o custo já medido de uma fala (0,50): não lança pra não jogar dinheiro fora');
  assert.equal(M.mesaCallBudget(0, 0, 1, 3, 0, 0.4), 0.5, 'want 0,40 com sobra 1,00: 2 em paralelo, não 3');
});

test('B1/B2: as chamadas da mesa e da ideia levam o teto da chamada pro motor', () => {
  assert.match(MESA, /invoke\('mesa_ask',\{[^}]*budgetUsd:/);
  assert.match(IDEIA, /'ideia_ask',\{[^}]*budgetUsd:/);
  assert.match(cut(MESA, 'async function mesaRunRound', 'async function mesaStop'), /purse\.take\(/, 'a mesa reserva antes de lançar cada persona');
  const turn = cut(IDEIA, 'async function ideiaRunTurn', 'async function ideiaStopTurn'), dec = cut(IDEIA, 'async function ideiaDecide', 'async function ideiaStopDecide');
  assert.match(turn, /purse\.take\(/, 'a conversa da ideia reserva antes de cada fala');
  assert.match(dec, /purse\.take\(/, 'o "Decidir com a mesa" reserva antes de cada voto');
  assert.match(dec, /ideiaNeedsCap\(m/, 'decidir sem teto é recusado');
  assert.match(cut(IDEIA, 'async function ideiaStart', 'async function ideiaSendFromInput'), /pilotoCapCheck\(/, 'a ideia nasce com teto obrigatório');
});

test('B3: gasto e teto vão no slot que não encolhe (pgh-money), na Ideia e na Mesa', () => {
  assert.match(read('js/00-util.js'), /class="pgh-money"/);
  assert.match(read('css/99-paginas.css'), /\.pgh-money\{[^}]*flex:none/);
  assert.match(read('css/99-paginas.css'), /\.pgh-t:has\(\.pgh-money\)\{[^}]*flex-wrap:wrap/);
  assert.match(cut(IDEIA, 'function ideiaIdeaHtml', 'function ideiaWire'), /pageHead\(\{ title:[^\n]*\bmoney,/);
  assert.match(cut(MESA, 'function mesaMesaHtml', 'function mesaCriadasHtml'), /pageHead\(\{ title:[^\n]*\bmoney,/);
});

test('B4: épico parado no meio é "criado em parte (N de M)", não "criado"', () => {
  assert.deepEqual(F.fabCriadoEstado({ partial: true, tasks: ['t1'] }, 3), { kind: 'parcial', n: 1, m: 3 });
  assert.deepEqual(F.fabCriadoEstado({ partial: false, tasks: ['t1', 't2', 't3'] }, 3), { kind: 'feito', n: 3, m: 3 });
  assert.deepEqual(F.fabCriadoEstado({ partial: false, tasks: ['t1'] }, 3), { kind: 'parcial', n: 1, m: 3 }, 'faltou tarefa = em parte, mesmo sem a marca');
  assert.deepEqual(F.fabCriadoEstado({ ideia: 'i-1' }, 0), { kind: 'ideia' });
  assert.equal(F.fabCriadoEstado(null, 3), null);
  const foot = cut(FABJS, 'function fabFooterHtml', 'function fabConfirmHtml');
  assert.match(foot, /criado em parte/);
  assert.match(foot, /data-fmk="\$\{i\}"/, 'o botão de continuar chama o mesmo criador, que retoma sem duplicar');
  assert.match(cut(FABJS, 'async function fabMakeEpic', '// ---------------- tela'), /for\(let k=made\.length;k<all\.length;k\+\+\)/, 'retoma da próxima tarefa que falta');
});
