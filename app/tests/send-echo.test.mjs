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
  grab(ws, /function fwOptimFor\(taskId, evs\)\{[\s\S]*?\n\}\n/),
].join('\n') + '\nthis.fwOptim=fwOptim; this.fwOptimFor=fwOptimFor;';
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { fwOptim, fwOptimFor } = ctx;

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
