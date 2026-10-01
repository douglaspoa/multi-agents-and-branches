// Eco otimista do chat da tarefa (travamento 28/09): `node --test app/tests/`
// A bolha "enviando…" entra na hora e só sai quando o banco confirma a mensagem (fala "Você: …",
// resposta a pergunta ou o aviso "Na fila (…)" do motor). Extrai as funções do front num contexto vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const core = readFileSync(new URL('../src/js/10-core.js', import.meta.url), 'utf8');
const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
const grab = (src, re) => { const m = src.match(re); assert.ok(m, 'trecho não achado: ' + re); return m[0]; };
const code = [
  grab(core, /function evIsUserMsg\(e\)\{[^\n]*\n/),
  grab(core, /function evUserText\(tx\)\{[^\n]*\n/),
  grab(ws, /const fwOptim=\{\};[^\n]*\n/),
  grab(ws, /function fwOptimFor\(taskId, evs, ctx\)\{[\s\S]*?\n\}\n/),
  grab(ws, /function fwEvTs\(e\)\{[^\n]*\n/),
  grab(ws, /function fwAgentAfter\(evs, at\)\{[^\n]*\n/),
  grab(ws, /const FW_ECHO_WAIT_MS=[^\n]*\n/),
  grab(ws, /function fwEchoNext\(o, c\)\{[\s\S]*?\n\}\n/),
].join('\n') + '\nthis.fwOptim=fwOptim; this.fwOptimFor=fwOptimFor; this.fwEchoNext=fwEchoNext;';
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { fwOptim, fwOptimFor, fwEchoNext } = ctx;

test('bolha fica até o banco confirmar a fala do humano', () => {
  const at = Date.now();
  fwOptim.t1 = [{ text: 'pode revisar o card?', at, st: 'enviada' }];
  assert.equal(fwOptimFor('t1', [{ agent: 'Coder', text: 'lendo', ts: at }]).length, 1);
  assert.equal(fwOptimFor('t1', [{ agent: 'Você', text: 'Você: pode revisar  o card?', ts: at + 900 }]).length, 0);
});
test('confirma por resposta a pergunta e pelo aviso de fila do motor', () => {
  const at = Date.now();
  fwOptim.t2 = [{ text: 'sim, pode', at, st: 'enviada' }];
  assert.equal(fwOptimFor('t2', [{ agent: 'Coder', text: 'humano respondeu: sim, pode', ts: at }]).length, 0);
  fwOptim.t3 = [{ text: 'esta demorando demais', at, st: 'fila' }];
  assert.equal(fwOptimFor('t3', [{ agent: 'Sistema', type: 'note', text: 'Na fila (1º): mensagem — "esta demorando demais" — o agente está no meio de um turno', ts: at }]).length, 0);
});
test('mensagem IGUAL antiga não confirma a nova; bolha velha (3 min) expira', () => {
  const at = Date.now();
  fwOptim.t4 = [{ text: 'ok', at, st: 'enviada' }];
  assert.equal(fwOptimFor('t4', [{ agent: 'Você', text: 'Você: ok', ts: at - 3600_000 }]).length, 1, 'um "ok" de uma hora atrás não é esta mensagem');
  fwOptim.t5 = [{ text: 'x', at: at - 200_000, st: 'lento' }];
  assert.equal(fwOptimFor('t5', []).length, 0);
});

// 29/09 (logcomex-ai-v2): resposta a uma pergunta cujo turno já tinha acabado ficou "enviada · aguardando o agente"
// e sumiu em 3 min sem nenhum turno rodar. Agora a bolha segue a verdade.
test('máquina do eco: enviada → começou → some quando o turno acaba; sem turno em 20s → não começou', () => {
  const at = 1_000_000;
  const c = (dt, x = {}) => ({ now: at + dt, working: false, queued: 0, agentAfter: false, ...x });
  assert.equal(fwEchoNext({ at, st: 'enviando' }, c(60_000)), 'enviando', 'invoke em voo não muda');
  assert.equal(fwEchoNext({ at, st: 'enviada' }, c(5_000)), 'enviada');
  assert.equal(fwEchoNext({ at, st: 'enviada' }, c(5_000, { working: true })), 'comecou');
  assert.equal(fwEchoNext({ at, st: 'enviada' }, c(5_000, { agentAfter: true })), 'comecou');
  assert.equal(fwEchoNext({ at, st: 'enviada' }, c(21_000)), 'parou');
  assert.equal(fwEchoNext({ at, st: 'parou' }, c(90_000, { working: true })), 'comecou', 'turno começou depois: sai do "não começou"');
  assert.equal(fwEchoNext({ at, st: 'comecou' }, c(30_000, { working: true })), 'comecou');
  assert.equal(fwEchoNext({ at, st: 'comecou' }, c(30_000)), 'fim');
});
test('máquina do eco: fila anda com o turno; fila parada quando o turno morreu', () => {
  const at = 1_000_000;
  assert.equal(fwEchoNext({ at, st: 'fila' }, { now: at + 600_000, working: true, queued: 1 }), 'fila');
  assert.equal(fwEchoNext({ at, st: 'fila' }, { now: at + 5_000, working: false, queued: 1 }), 'fila-parada');
  assert.equal(fwEchoNext({ at, st: 'fila-parada' }, { now: at + 9_000, working: true, queued: 1 }), 'fila');
  assert.equal(fwEchoNext({ at, st: 'fila' }, { now: at + 30_000, working: false, queued: 0 }), 'parou');
});
test('"não começou" NÃO some sozinha em 3 min (a mensagem não pode se perder calada)', () => {
  const at = Date.now() - 200_000;
  fwOptim.t6 = [{ text: 'não daria pra criar um login dev use cases?', at, st: 'enviada' }];
  const l = fwOptimFor('t6', [], { now: Date.now(), working: false, queued: 0 });
  assert.equal(l.length, 1); assert.equal(l[0].st, 'parou');
  // turno de outra coisa rodou e acabou sem eco desta mensagem: começou → fim → sai
  fwOptim.t7 = [{ text: 'x', at: Date.now() - 30_000, st: 'comecou' }];
  assert.equal(fwOptimFor('t7', [], { now: Date.now(), working: false, queued: 0 }).length, 0);
});
