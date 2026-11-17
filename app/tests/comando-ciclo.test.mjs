// Ciclo da tarefa no chat: funções puras. Dados fictícios (repo público).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const JS = readFileSync(new URL('../src/js/89-comando-ciclo.js', import.meta.url), 'utf8');
const puro = JS.slice(0, JS.indexOf('function cmdCicloCard'));
const C = new Function('nPl', puro + '\nreturn { CMD_CICLO, cmdCicloPode, cmdPrBase, cmdChecksResumo, cmdCiResumo };')((n, s, p) => n + ' ' + (n === 1 ? s : p || s + 's'));

test('base do PR sai do que a pessoa disse', () => {
  assert.equal(C.cmdPrBase('homol'), 'homol'); assert.equal(C.cmdPrBase('pra develop'), 'develop'); assert.equal(C.cmdPrBase('para a homologação'), 'homol');
  assert.equal(C.cmdPrBase('na release/2.4'), 'release/2.4'); assert.equal(C.cmdPrBase(''), ''); assert.equal(C.cmdPrBase('homologação'), 'homol');
});
test('cada ação só vale no estado certo', () => {
  assert.equal(C.cmdCicloPode('aprovar_plano', { status:'plan-review' }), ''); assert.equal(C.cmdCicloPode('aprovar_plano', { status:'running', needsPlano:true }), '');
  assert.match(C.cmdCicloPode('aprovar_plano', { status:'running' }), /plano/); assert.match(C.cmdCicloPode('resolver_conflito', { status:'review' }), /conflito/);
  assert.equal(C.cmdCicloPode('iniciar', { status:'draft' }), ''); assert.equal(C.cmdCicloPode('abrir_pr', { status:'review' }), '');
});
test('resumo da verificação separa falha de ferramenta ausente', () => {
  const R = C.cmdChecksResumo({ results:[{ label:'testes', ok:true }, { label:'lint', ok:false }, { label:'build', ok:false, notFound:true }] });
  assert.equal(R.ok, false); assert.deepEqual(R.falhas, ['lint']); assert.deepEqual(R.faltam, ['build']); assert.equal(C.cmdChecksResumo({ results:[] }).ok, true);
});
test('resumo do PR e do CI', () => {
  assert.equal(C.cmdCiResumo({ exists:false }).tem, false);
  const R = C.cmdCiResumo({ exists:true, number:42, state:'OPEN', baseRefName:'homol', checksTotal:5, checksFail:2, failingChecks:['testes', 'lint'], decision:'REVIEW_REQUIRED', mergeable:'CONFLICTING', url:'https://example.test/pr/42' });
  assert.match(R.tx, /PR #42 aberto → homol/); assert.match(R.tx, /2 de 5 checagens falhando/); assert.match(R.tx, /conflito/); assert.deepEqual(R.falhando, ['testes', 'lint']);
  assert.match(C.cmdCiResumo({ exists:true, number:7, state:'MERGED', checksTotal:3 }).tx, /integrado · 3 checagens passando/);
});
