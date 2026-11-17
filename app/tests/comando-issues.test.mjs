// Issues no chat: funções puras. Dados fictícios (repo público).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const JS = readFileSync(new URL('../src/js/89-comando-issues.js', import.meta.url), 'utf8');
const C = new Function(JS.slice(0, JS.indexOf('function cmdIssueAcha')) + '\nreturn { CMD_ISSUES, cmdStatusDe, cmdPessoaDe, cmdIssueDesc };')();
const ST = [{ id:'s1', label:'Backlog', kind:'todo' }, { id:'s2', label:'Em andamento', kind:'doing' }, { id:'s3', label:'Code Review', kind:'doing' }, { id:'s4', label:'Concluído', kind:'done' }, { id:'s5', label:'Bloqueado', kind:'blocked' }];
const P = [{ id:'ana@loja.test', name:'ana lima' }, { id:'bruno@loja.test', name:'bruno reis' }, { id:'ana.souza@loja.test', name:'ana souza' }];

test('status pelo nome do painel ou pelo jeito de falar', () => {
  assert.equal(C.cmdStatusDe(ST, 'em andamento').id, 's2'); assert.equal(C.cmdStatusDe(ST, 'pra feito').id, 's4'); assert.equal(C.cmdStatusDe(ST, 'bloqueada').id, 's5');
  assert.equal(C.cmdStatusDe(ST, 'revisão').id, 's3'); assert.equal(C.cmdStatusDe(ST, 'fazendo').id, 's2'); assert.equal(C.cmdStatusDe(ST, 'backlog').id, 's1');
  assert.equal(C.cmdStatusDe(ST, 'banana'), null); assert.equal(C.cmdStatusDe(ST, ''), null);
});
test('pessoa: eu, nome único, ambíguo e desconhecido', () => {
  assert.equal(C.cmdPessoaDe(P, 'eu', 'bruno@loja.test').id, 'bruno@loja.test'); assert.equal(C.cmdPessoaDe(P, 'pro Bruno', 'x').id, 'bruno@loja.test');
  assert.equal(C.cmdPessoaDe(P, 'ana', 'x').varios.length, 2); assert.equal(C.cmdPessoaDe(P, 'ana souza', 'x').id, 'ana.souza@loja.test'); assert.equal(C.cmdPessoaDe(P, 'carla', 'x'), null);
});
test('descrição da issue leva os requisitos no formato que o painel lê', () => {
  assert.equal(C.cmdIssueDesc('Trocar o cálculo do frete.', ['Frete grátis acima de 200', ' ']), 'Trocar o cálculo do frete.\n\nRequisitos:\n- Frete grátis acima de 200'); assert.equal(C.cmdIssueDesc('Só isso', []), 'Só isso');
});
