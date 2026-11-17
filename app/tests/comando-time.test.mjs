// Time, entregas e uso no chat: funções puras. Dados fictícios (repo público).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const JS = readFileSync(new URL('../src/js/89-comando-time.js', import.meta.url), 'utf8');
const C = new Function(JS.slice(0, JS.indexOf('function cmdTimeHtml')) + '\nreturn { CMD_TIME, cmdPeriodo, cmdTimeResumo, cmdCartaoDe };')();
const QUA = new Date(2026, 10, 18, 15, 0).getTime(), DIA = 86400000; // quarta, 18/11/2026

test('período dito vira intervalo', () => {
  const h = C.cmdPeriodo('hoje', QUA); assert.equal(h.to - h.from, DIA); assert.equal(h.uso, 'hoje');
  const s = C.cmdPeriodo('', QUA); assert.equal(new Date(s.from).getDay(), 1); assert.equal(s.label, 'esta semana');
  const sp = C.cmdPeriodo('semana passada', QUA); assert.equal(sp.to, s.from); assert.equal(sp.to - sp.from, 7 * DIA);
  assert.equal(new Date(C.cmdPeriodo('esse mês', QUA).from).getDate(), 1); assert.equal(C.cmdPeriodo('ontem', QUA).to, h.from);
});
test('quem está com o quê: travadas primeiro, fila e entregues fora', () => {
  const I = [{ who:'a', titulo:'Frete', code:'LW-1', trav:true, motivo:'erro' }, { who:'a', titulo:'Cupom', code:'LW-2' }, { who:'b', titulo:'CSV', code:'LW-3', esp:true }, { who:'b', titulo:'Velha', done:true }, { who:'', titulo:'Solta', bucket:'fila' }];
  const R = C.cmdTimeResumo(I, id => ({ a:'Ana Lima', b:'Bruno Reis' })[id]);
  assert.equal(R.length, 2); assert.equal(R[0].nome, 'Ana Lima'); assert.equal(R[0].abertas, 2); assert.equal(R[0].itens[0].sit, 'travada'); assert.equal(R[1].esp, 1);
  assert.equal(C.cmdTimeResumo(I, id => ({ a:'Ana Lima', b:'Bruno Reis' })[id], 'bruno').length, 1);
});
test('cartão pelo código, pelo número ou pelo título', () => {
  const I = [{ card:{}, code:'LW-10', titulo:'Exportar pedidos em CSV' }, { card:{}, code:'LW-11', titulo:'Exportar clientes em CSV' }, { code:'LW-12', titulo:'Só local' }];
  assert.equal(C.cmdCartaoDe(I, 'lw 10').code, 'LW-10'); assert.equal(C.cmdCartaoDe(I, 'a 11').code, 'LW-11'); assert.equal(C.cmdCartaoDe(I, 'exportar').varios.length, 2);
  assert.equal(C.cmdCartaoDe(I, 'pedidos em csv').code, 'LW-10'); assert.equal(C.cmdCartaoDe(I, 'LW-12'), null);
});
