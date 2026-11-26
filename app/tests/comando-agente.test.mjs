// Agente do Comando: funções puras. Dados fictícios (repo público).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const corta = (f, a, b) => { const s = readFileSync(new URL(f, import.meta.url), 'utf8'); return s.slice(s.indexOf(a), s.indexOf(b)); };
const P = new Function(corta('../src/js/89-comando.js', '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { CMD_ACOES, CMD_MUTA };')();
const A = new Function(corta('../src/js/89-comando-agente.js', '// @agente-puro-inicio', '// @agente-puro-fim') + '\nreturn { CMD_AG_CONFIRMA, CMD_AG_VER, cmdAgenteAcoes, cmdAgenteSys, cmdAgenteTurno, cmdAgentePasso, cmdAgenteSimNao, cmdAgAcaoErrada, cmdAgFalta, CMD_AG_PRECISA, cmdAgPareceCodigo, cmdHtmlTexto };')();

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
  assert.deepEqual(A.cmdAgentePasso({ acao:'responder', alvo:'LW-1168', texto:'pode' }).tarefas, ['LW-1168']); assert.equal(A.cmdAgentePasso({ acao:'responder', alvo:'2', texto:'homol' }).alvo, '2'); assert.deepEqual(A.cmdAgentePasso({ acao:'responder', alvo:'2', texto:'homol' }).tarefas, []);
  assert.deepEqual(A.cmdAgentePasso({ acao:'criar_demanda' }).requisitos, []); assert.equal(A.cmdAgentePasso({ acao:'parar' }).requisitos, undefined);
});
test('"sim" e "não" falados ou digitados valem como o clique — frase comprida não', () => {
  ['sim', 'Sim!', 'pode', 'pode fazer', 'isso mesmo', 'manda ver', 'ok', 'confirmo'].forEach(x => assert.equal(A.cmdAgenteSimNao(x), 'sim', x));
  ['não', 'nao', 'cancela', 'não é isso', 'deixa pra lá', 'espera'].forEach(x => assert.equal(A.cmdAgenteSimNao(x), 'nao', x));
  ['sim, mas troca o título pra outro', 'como está a 1228?', '', 'talvez'].forEach(x => assert.equal(A.cmdAgenteSimNao(x), '', x));
});
test('nome de ação errado ensina o certo', () => {
  const e = A.cmdAgAcaoErrada('memorizar', P.CMD_ACOES); assert.match(e, /NADA foi feito/); assert.match(e, /anotar_memoria/); assert.match(e, /Nomes válidos: .*abrir_pr/);
  assert.match(A.cmdAgAcaoErrada('voar', P.CMD_ACOES), /Nomes válidos/);
});

test('chamada torta de "agir" volta pra IA em vez de virar cartão de confirmação', () => {
  // o caso real de 26/11: epico_acao com alvo vazio no meio de um "criar issue"
  const f = A.cmdAgFalta({ acao: 'epico_acao', alvo: '', texto: '' }, 0, 'agir no épico');
  assert.match(f, /NADA foi feito/); assert.match(f, /campo alvo/); assert.match(f, /campo texto/);
  assert.match(A.cmdAgFalta({ acao: 'epico_acao', alvo: 'Frete', texto: 'voar' }, 0), /comecar \| liberar/);
  assert.equal(A.cmdAgFalta({ acao: 'epico_acao', alvo: 'Frete', texto: 'Começar' }, 0), '');
  assert.match(A.cmdAgFalta({ acao: 'criar_issue', texto: 'algo' }, 0), /campo titulo/);
  assert.equal(A.cmdAgFalta({ acao: 'criar_issue', titulo: 'Calcular frete' }, 0), '');
  assert.match(A.cmdAgFalta({ acao: 'aprovar' }, 0), /a tarefa/);
  assert.equal(A.cmdAgFalta({ acao: 'aprovar' }, 1), '');
  assert.equal(A.cmdAgFalta({ acao: 'parar' }, 0), '');
  // toda ação com regra existe no catálogo, e toda que pede confirmação tem regra
  Object.keys(A.CMD_AG_PRECISA).forEach(a => assert.ok(P.CMD_ACOES[a], 'regra de ação que não existe: ' + a));
  [...A.CMD_AG_CONFIRMA].forEach(a => assert.ok(A.CMD_AG_PRECISA[a], 'pede confirmação sem regra do que precisa: ' + a));
});

test('código ou número nunca é adivinhado por parecido', () => {
  for (const q of ['FND-1260', 'fnd 1260', '1260', 'T3', '@FND-1260', 'LW_47']) assert.ok(A.cmdAgPareceCodigo(q), q);
  for (const q of ['a do frete', 'frete 2', 'seletor de pesquisas', '', 'FND-1260 e FND-1261']) assert.ok(!A.cmdAgPareceCodigo(q), q);
});

test('o texto de um cartão é o que a pessoa lê nele — com os endereços e sem os botões', () => {
  const h = '<p>Links da <b>LW-47</b>:</p><div class="cmdlks"><div class="cmdlk"><span class="cmdlk-l">Pull request</span><span class="cmdlk-v mono">https://example.com/o/r/pull/12</span><button type="button" class="btn sm quiet" data-cmdlk="https://example.com/o/r/pull/12">abrir ↗</button><button type="button" class="btn sm quiet" data-cmdcopy="x">copiar</button></div></div>';
  const t = A.cmdHtmlTexto(h); assert.match(t, /Links da LW-47:/); assert.match(t, /Pull request https:\/\/example\.com\/o\/r\/pull\/12/); assert.doesNotMatch(t, /copiar|abrir ↗/);
  assert.equal(A.cmdHtmlTexto('<ul><li>um &amp; dois</li><li>tr&ecirc;s &lt;b&gt;</li></ul>'), '- um & dois\n- tr&ecirc;s <b>');
  assert.equal(A.cmdHtmlTexto('<p>Veja <a href="https://example.com/x" data-exthref="https://example.com/x">o PR</a></p>'), 'Veja o PR (https://example.com/x)');
  assert.equal(A.cmdHtmlTexto('<button type="button" class="cmdrow" data-cmdsel="t1"><span>LW-1</span><span>Frete</span></button>'), 'LW-1 Frete'); // linha de tarefa é conteúdo, não botão de ação
  assert.match(A.cmdHtmlTexto('<p>' + 'a '.repeat(4000) + '</p>', 200), /…\(cortado\)$/);
  assert.equal(A.cmdHtmlTexto('<svg><path d="M0"/></svg><script>x()</script>'), '');
});

test('lista de ações: por assunto, criar primeiro, épico por último — e nenhuma fica de fora ou repetida', () => {
  const L = A.cmdAgenteAcoes(P.CMD_ACOES), nomes = [...L.matchAll(/^- ([a-z_]+):/gm)].map(m => m[1]);
  assert.equal(nomes[0], 'criar_demanda', 'a 1ª ação é a mais pedida, não uma rara');
  assert.ok(nomes.indexOf('criar_issue') < 3 && nomes.indexOf('epico_acao') > nomes.length / 2, 'épico não pode vir antes das comuns');
  assert.equal(new Set(nomes).size, nomes.length, 'ação repetida');
  const fora = new Set(Object.values(A.CMD_AG_VER).concat(['abertas', 'erros', 'perguntar_agente', 'tela', 'trocar_projeto_x']));
  Object.keys(P.CMD_ACOES).filter(k => !fora.has(k)).forEach(k => assert.ok(nomes.includes(k), 'ficou de fora da lista: ' + k));
  assert.match(L, /^CRIAR\n- criar_demanda/); assert.ok(L.length < 12000, 'a lista é cortada em 12000 no Rust');
});
test('apelido natural de ação vira o nome do catálogo', () => {
  assert.equal(A.cmdAgentePasso({ acao: 'criar_tarefa', titulo: 'x' }).acao, 'criar_demanda');
  assert.equal(A.cmdAgentePasso({ acao: 'Pausar' }).acao, 'parar');
  assert.equal(A.cmdAgentePasso({ acao: 'abrir_pr' }).acao, 'abrir_pr');
});
