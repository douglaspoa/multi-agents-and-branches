// Agente do Comando: funções puras. Dados fictícios (repo público).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const corta = (f, a, b) => { const s = readFileSync(new URL(f, import.meta.url), 'utf8'); return s.slice(s.indexOf(a), s.indexOf(b)); };
const P = new Function(corta('../src/js/89-comando.js', '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { CMD_ACOES, CMD_MUTA };')();
const A = new Function(corta('../src/js/89-comando-agente.js', '// @agente-puro-inicio', '// @agente-puro-fim') + '\nreturn { CMD_AG_CONFIRMA, CMD_AG_VER, cmdAgenteAcoes, cmdAgenteSys, cmdAgenteTurno, cmdAgentePasso, cmdAgenteSimNao };')();

test('toda leitura da ferramenta "ver" aponta pra uma ação que existe, e toda confirmação é de ação que mexe', () => {
  Object.values(A.CMD_AG_VER).forEach(a => assert.ok(P.CMD_ACOES[a], 'ação de leitura inexistente: ' + a));
  [...A.CMD_AG_CONFIRMA].forEach(a => assert.ok(P.CMD_MUTA.has(a), 'confirma algo que não mexe: ' + a));
});
test('a lista da ferramenta "agir" tem as ações de mexer e não repete as de leitura', () => {
  const L = A.cmdAgenteAcoes(P.CMD_ACOES);
  ['instruir', 'responder', 'abrir_pr', 'aprovar_plano', 'criar_issue', 'mover_issue', 'criar_demanda', 'encerrar', 'passar_cartao'].forEach(a => assert.match(L, new RegExp('^- ' + a + ':', 'm')));
  ['status', 'tarefa', 'provas', 'ci', 'time', 'perguntar_agente', 'tela'].forEach(a => assert.doesNotMatch(L, new RegExp('^- ' + a + ':', 'm')));
  assert.match(L, /^- encerrar:.*\[pede confirmação da pessoa\]$/m); assert.doesNotMatch(L, /^- instruir:.*pede confirmação/m);
});
test('o turno leva o contexto e o pedido da pessoa por último, intacto', () => {
  const t = A.cmdAgenteTurno({ pedido:'a do frete pode ir pra feito?', proj:'loja', resumo:'3 abertas', foco:'LW-1 "Frete"', achados:[{ tipo:'issue', code:'LW-300', title:'Frete grátis', st:'Backlog', trecho:'acima de 200' }] });
  assert.ok(t.endsWith('[/CONTEXTO]\n\na do frete pode ir pra feito?')); assert.match(t, /\[issue\] LW-300 "Frete grátis" — Backlog · «acima de 200»/); assert.match(t, /tarefa em foco/);
  assert.match(A.cmdAgenteTurno({ pedido:'x', achados:[] }), /a busca não achou nada parecido/);
});
test('modo voz muda só o jeito de falar', () => { assert.doesNotMatch(A.cmdAgenteSys({}), /CONVERSANDO POR VOZ/); assert.match(A.cmdAgenteSys({ voz:true }), /CONVERSANDO POR VOZ/); assert.ok(A.cmdAgenteSys({ voz:true }).length < 40000); });
test('argumentos da ferramenta viram um passo limpo', () => {
  assert.deepEqual(A.cmdAgentePasso({ acao:' Instruir ', tarefas:'LW-1', texto:' use dados fictícios ' }), { acao:'instruir', tarefas:['LW-1'], texto:'use dados fictícios', alvo:'' });
  const c = A.cmdAgentePasso({ acao:'criar_issue', titulo:'Boleto  parcelado', requisitos:['Até 3 vezes', '', 'ok'] }); assert.equal(c.titulo, 'Boleto parcelado'); assert.deepEqual(c.requisitos, ['Até 3 vezes']);
  assert.deepEqual(A.cmdAgentePasso({ acao:'criar_demanda' }).requisitos, []); assert.equal(A.cmdAgentePasso({ acao:'parar' }).requisitos, undefined);
});
test('"sim" e "não" falados ou digitados valem como o clique — frase comprida não', () => {
  ['sim', 'Sim!', 'pode', 'pode fazer', 'isso mesmo', 'manda ver', 'ok', 'confirmo'].forEach(x => assert.equal(A.cmdAgenteSimNao(x), 'sim', x));
  ['não', 'nao', 'cancela', 'não é isso', 'deixa pra lá', 'espera'].forEach(x => assert.equal(A.cmdAgenteSimNao(x), 'nao', x));
  ['sim, mas troca o título pra outro', 'como está a 1228?', '', 'talvez'].forEach(x => assert.equal(A.cmdAgenteSimNao(x), '', x));
});
