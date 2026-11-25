// BATERIA DO COMANDO — roda as frases reais contra a IA de verdade, no mesmo modo enxuto do app, e confere o plano.
// Não entra no `node --test` (gasta IA): rode à mão →  node tests/comando-eval.mjs   (uns centavos e ~1 min)
// Dados fictícios (repo público). Cada caso: { pedido, foco?, conversa?, quer: [[acao, [tarefas…]]…], semMuta?, fala? }
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const JS = readFileSync(new URL('../src/js/89-comando.js', import.meta.url), 'utf8');
const i = JS.indexOf('// @comando-puro-inicio'), j = JS.indexOf('// @comando-puro-fim', i);
const C = new Function(JS.slice(i, j) + '\nreturn { cmdPlanPrompt, cmdPlanRegras, cmdPlanDados, cmdBusca, cmdAchar, cmdPlanParse, cmdRefTask, CMD_PLAN_SYS, CMD_MUTA };')();
const REFS = [
  { id:'a', ref:'LW-1168', code:'LW-1168', title:'Tracer: escala de risco, formato e premissas', st:'aguardando você', proj:'relay', criada:'ontem 09:10', mexida:'há 2 h', q:'O login expirou; posso rodar o login neste terminal?', ops:['Pode rodar o login', 'Não, eu mesmo faço o login'], fatos:'sem PR' },
  { id:'b', ref:'LW-1195', code:'LW-1195', title:'Auditoria de segurança do painel', st:'pronta pra revisar', criada:'ontem 14:00', mexida:'há 5 h', fatos:'3 de 3 requisitos com prova, PR aberto' },
  { id:'c', ref:'LW-1173', code:'LW-1173', title:'Lentidão no Fast após troca de roteador', st:'pronta pra revisar', proj:'relay', criada:'10/11', mexida:'há 1 d', fatos:'sem PR' },
  { id:'d', ref:'LW-1174', code:'LW-1174', title:'Lentidão no Fast após troca de roteador (parte 2)', st:'pronta pra revisar', proj:'relay', criada:'10/11', mexida:'há 1 d', fatos:'sem PR' },
  { id:'e', ref:'LW-1228', code:'LW-1228', title:'Catálogo Pro como caso do use_cases + bloqueio no MCP', st:'pronta pra revisar', criada:'hoje 10:12', mexida:'há 20 min', fatos:'0 de 26 requisitos com prova, sem PR' },
  { id:'f', ref:'LW-1208', code:'LW-1208', title:'Mock navegável: mapa de uso e replay', st:'rodando', criada:'hoje 08:30', mexida:'há 1 min', fatos:'sem PR' },
  { id:'g', ref:'T1', code:'', title:'Central de ajuda do use_cases em inglês', st:'rascunho', criada:'08/11' },
];
const FOCO_1228 = 'LW-1228 "Catálogo Pro como caso do use_cases" — selo: pronta pra revisar\nfatos: 0 de 26 requisitos com prova; sem PR; 11 arquivos mexidos nesta sessão; IA parada\núltima fala do agente:\nImplementei o catálogo e o roteador; faltam os testes de limite por plano.';
const CASOS = [
  { nome:'vários encerramentos + listagem', pedido:'Encerre a LW 1168 a 1195 a 1173 e a 1174 e depois me mostre as em aberto', quer:[['encerrar', ['LW-1168', 'LW-1195', 'LW-1173', 'LW-1174']], ['abertas|status', []]] },
  { nome:'não é a tarefa ao lado', foco:{ id:'a' }, pedido:'não estou falando dessa tarefa, falo da última tarefa que abrimos hoje, é sobre o catálogo pro no use cases. Como ela está?', tem:[['tarefa|perguntar_agente|instruir', 'LW-1228']], quer:[], naoPode:['LW-1168'] },
  { nome:'continuar rodando ela', foco:{ id:'e' }, conversa:['Pessoa: como está a LW-1228?', 'Comando: [Comando mostrou: tarefa de LW-1228]'], pedido:'eu sei, precisamos continuar rodando ela', tem:[['continuar|instruir', 'LW-1228']], quer:[] },
  { nome:'duvida do selo → usa os fatos', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'acredito que ela não esteja pronta, pode conferir com o agente?', tem:[['instruir|perguntar_agente', 'LW-1228']], quer:[], fala:/26|prova|PR/i },
  { nome:'pergunta de estado não vira bloco de texto', pedido:'quais as tasks ainda estão abertas?', quer:[['abertas|status', []]], semMuta:true, falaMax:260 },
  { nome:'o que me espera', pedido:'tem alguma coisa travada esperando resposta minha?', quer:[['esperando', []]], semMuta:true },
  { nome:'provas por descrição', pedido:'me mostra as provas da auditoria de segurança', quer:[['provas', ['LW-1195']]], semMuta:true },
  { nome:'ambíguo → pergunta, não escolhe', pedido:'encerra a da lentidão no fast', quer:[], duvida:true },
  { nome:'instrução ditada', pedido:'fala pro agente da 1208 usar dados fictícios no replay', tem:[['instruir', 'LW-1208']], quer:[], texto:/fict/i },
  { nome:'mock pronto → criar a versão real', minReq:3, conversa:['Pessoa: como está a 1208?', 'Comando: [Comando mostrou: tarefa de LW-1208]', 'Comando: LW-1208 está pronta pra revisar: 13 de 13 requisitos com prova, sem PR. O executor disse: «O replay em janela real com anotação guiada e o comparativo original × re-executado estão prontos como protótipo com dados simulados; o registro de eventos de uso já existe e pode servir de base.»'], pedido:'Sei que ela esta pronta, mas ela é um mock preciso agora fazer a versão real', quer:[], nova:{ req:3, origem:'1208' } },
  { nome:'ciclo: PR pra homol vai direto', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'preciso do pr de homol', tem:[['abrir_pr', 'LW-1228']], quer:[], alvo:/homol/i },
  { nome:'ciclo: abriu o PR?', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'abriu o pr de homol?', tem:[['ci', 'LW-1228']], quer:[], semMuta:true },
  { nome:'ciclo: aprova o plano', pedido:'pode seguir com o plano da 1208', tem:[['aprovar_plano', 'LW-1208']], quer:[] },
  { nome:'ciclo: roda os testes', pedido:'roda os testes da auditoria de segurança', tem:[['checks', 'LW-1195']], quer:[], semMuta:true },
  { nome:'ciclo: faça as provas', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'faça as provas no 1228', tem:[['pedir_prova|instruir', 'LW-1228']], quer:[] },
  { nome:'ciclo: corrige o CI', pedido:'o ci da 1195 quebrou, manda corrigir', tem:[['corrigir_ci', 'LW-1195']], quer:[] },
  { nome:'issues: mover', issues:[{ code:'LW-300', title:'Frete grátis acima de 200', st:'Backlog', who:'' }, { code:'LW-301', title:'Exportar pedidos em CSV', st:'Backlog', who:'ana lima' }], pedido:'move a LW-300 pra em andamento', quer:[['mover_issue', []]], alvo:/LW-?300/i },
  { nome:'issues: atribuir pra mim', pedido:'a LW-300 fica comigo', quer:[['atribuir_issue', []]], alvo:/LW-?300/i },
  { nome:'issues: comentar', pedido:'comenta na LW-300: aguardando retorno do cliente', quer:[['comentar_issue', []]], alvo:/LW-?300/i, texto:/aguardando retorno/i },
  { nome:'issues: criar sem começar', pedido:'cria uma issue pra trocar o cálculo do frete: grátis acima de 200 reais e fixo de 15 abaixo disso', quer:[['criar_issue', []]] },
  { nome:'issues: mandar pro time', pedido:'manda a LW-300 pro time, pro Bruno fazer', quer:[['mandar_time', []]], alvo:/LW-?300/i, texto:/bruno/i },
  { nome:'time: quem está com o quê', pedido:'como está o time? quem está com o quê?', quer:[['time', []]], semMuta:true },
  { nome:'time: entregas da semana', pedido:'o que foi entregue essa semana?', quer:[['entregas', []]], semMuta:true, texto:/semana/i },
  { nome:'time: quanto gastei', pedido:'quanto eu gastei de IA hoje?', quer:[['uso', []]], semMuta:true, texto:/hoje/i },
  { nome:'time: passar cartão', docs:[{ tipo:'cartão do time', code:'LW-77', title:'Exportação de pedidos em CSV', text:'', st:'em andamento', who:'ana lima' }], pedido:'passa o cartão da exportação em CSV pro Bruno', quer:[['passar_cartao', []]], texto:/bruno/i, alvo:/LW-?77|exporta/i },
  { nome:'time: passar cartão que a busca não achou', pedido:'passa o cartão do boleto parcelado pro Bruno', quer:[['passar_cartao', []]], texto:/bruno/i, alvo:/boleto/i },
  { nome:'real: olá não vira cartão', cheio:true, foco:{ id:'e', ctx:FOCO_1228 }, pedido:'ola', quer:[], semMuta:true, semPassos:true },
  { nome:'real: obrigado', cheio:true, pedido:'valeu, obrigado', quer:[], semMuta:true, semPassos:true },
  { nome:'real: acha issue por pedaço da descrição', cheio:true, pedido:'o que diz aquela issue de entrar com a conta do google?', quer:[['issue', []]], alvo:/LW-?302/i, semMuta:true },
  { nome:'real: acha issue por assunto e move', cheio:true, pedido:'a do carrinho demorando pode ir pra em andamento', quer:[['mover_issue', []]], alvo:/LW-?305/i },
  { nome:'real: começa issue descrita', cheio:true, pedido:'começa a da planilha de pedidos pro financeiro', quer:[['comecar_issue', []]], alvo:/LW-?301/i },
  { nome:'real: tarefa por pedaço do título no meio de muitas', cheio:true, pedido:'como está a auditoria de segurança?', tem:[['tarefa', 'LW-1195']], quer:[], semMuta:true },
  { nome:'real: PR de homol com tudo cheio', cheio:true, foco:{ id:'e', ctx:FOCO_1228 }, pedido:'preciso do pr de homol', tem:[['abrir_pr', 'LW-1228']], quer:[], alvo:/homol/i },
  { nome:'real: ambígua pergunta qual', cheio:true, pedido:'move o ajuste de layout do rodapé pra feito', quer:[], duvida:true },
  { nome:'aprovar', pedido:'pode aprovar a auditoria, tá tudo provado', tem:[['aprovar', 'LW-1195']], quer:[] },
  { nome:'código → ler_codigo', pedido:'onde no código fica a validação do limite de itens por plano?', quer:[['ler_codigo', []]], semMuta:true },
  { nome:'pergunta sobre a tarefa ao lado (caso real: foi pra outra tarefa)', foco:{ id:'e', ctx:FOCO_1228 }, conversa:['Pessoa: me mostra as provas da 1228', 'Comando: [Comando mostrou: provas de LW-1228]'], pedido:'O que falta para começar as provas?', quer:[], naoPode:['LW-1208', 'LW-1195', 'LW-1168'], fala:/prova|requisito|teste|PR/i },
  { nome:'vago → propõe com os fatos', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'resolve isso pra mim, quero ela entregue', tem:[['instruir|continuar', 'LW-1228']], quer:[] },
  // 12–13/11: perguntou e levou uma proposta de instrução; respondeu no chat e nada foi entregue ao agente
  { nome:'pergunta de estado não vira instrução', pedido:'como esta a task 1228?', tem:[['tarefa', 'LW-1228']], quer:[], semMuta:true },
  { nome:'PR aberto pelo agente conta', foco:{ id:'e', ctx:'LW-1228 "Catálogo Pro" — selo: rodando\nfatos: 23 de 26 requisitos com prova; PR aberto pelo agente: https://github.com/acme/loja/pull/77; a IA está trabalhando agora' }, pedido:'abriu o pr de homol?', quer:[], semMuta:true, fala:/77|aberto|sim/i },
  { nome:'pedido de ação ao agente continua virando instrução', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'pede pra ele trocar o seletor de colunas pelo componente que já existe no use cases', tem:[['instruir', 'LW-1228']], quer:[], texto:/componente/i },
  { nome:'resposta curta à pergunta aberta', foco:{ id:'a' }, conversa:['Comando avisou: LW-1168 — tem uma pergunta pra você. Pergunta dela: «O login expirou; posso rodar o login neste terminal?»'], pedido:'pode sim', tem:[['responder', 'LW-1168']], quer:[], texto:/pode/i },
  { nome:'escolhe a opção pelo número', foco:{ id:'a' }, conversa:['Comando avisou: LW-1168 — tem uma pergunta pra você. Pergunta dela: «O login expirou; posso rodar o login neste terminal?»'], pedido:'a segunda', tem:[['responder', 'LW-1168']], quer:[], texto:/^Não, eu mesmo faço o login$/ },
  { nome:'responde ao que o executor disse (sem pergunta formal)', foco:{ id:'f' }, conversa:['Comando avisou: LW-1208 — parou. O executor disse: «Montei o replay. Uso dados reais do cliente ou fictícios?»'], pedido:'ficticios, sempre', tem:[['instruir|responder', 'LW-1208']], quer:[], texto:/^fict[ií]cios, sempre\.?$/i },
  { nome:'abrir o preview', pedido:'abre o preview da 1208 pra mim', tem:[['ambiente_subir', 'LW-1208']], quer:[], semMuta:true },
  { nome:'me passa a url', foco:{ id:'e', ctx:FOCO_1228 }, pedido:'quero ver ela rodando, me passa a url', tem:[['ambiente_subir', 'LW-1228']], quer:[], semMuta:true },
];
const args = (sys) => ['--strict-mcp-config', '--tools', '', '--system-prompt', sys, '--setting-sources', '', '--no-session-persistence', '--model', process.env.CMD_MODEL || 'claude-sonnet-5', '--output-format', 'json'];
let ok = 0, tempo = 0, custo = 0; const falhas = [];
const CHEIO_REFS = Array.from({ length:42 }, (_, k) => ({ id:'x' + k, ref:'LW-' + (2000 + k), code:'LW-' + (2000 + k), title:['Relatório mensal de vendas por região', 'Migração do cadastro de clientes', 'Painel de estoque por depósito', 'Integração com a transportadora', 'Revisão das permissões de acesso', 'Cache das consultas de catálogo'][k % 6] + ' — parte ' + (k + 1), st:['rodando', 'pronta pra revisar', 'parou com erro', 'aguardando você'][k % 4], proj:'loja-web', criada:'há ' + (k + 2) + ' d', mexida:'há ' + (k + 1) + ' h', fatos:(k % 13) + ' de 13 requisitos com prova · sem PR · ' + (k % 9) + ' arquivos mexidos nesta sessão · última ação da IA há ' + (k + 1) + ' h · IA parada · plano 4 de 6 passos' }));
const PAINEL = [['LW-300', 'Frete grátis acima de 200', 'Backlog', '', 'Hoje o frete é sempre cobrado. Regra nova: pedidos acima de R$ 200 têm frete grátis; abaixo, valor fixo.'], ['LW-301', 'Exportar pedidos em CSV', 'Backlog', 'ana lima', 'O financeiro precisa baixar a planilha de pedidos do mês com filtros de período e status.'], ['LW-302', 'Login social', 'Em andamento', 'bruno reis', 'Permitir entrar com a conta do Google e da Apple, vinculando ao cadastro existente pelo e-mail.'], ['LW-303', 'Tela de rastreio', 'Backlog', '', 'O cliente acompanha a entrega com o código da transportadora, em linha do tempo.'], ['LW-304', 'Cupom de primeira compra', 'Backlog', 'carla dias', 'Desconto de 10% automático no primeiro pedido de cada cliente novo.'], ['LW-305', 'Lentidão no carrinho', 'Bloqueada', 'ana lima', 'O carrinho demora mais de 4 segundos pra abrir quando há mais de 30 itens.']]
  .concat(Array.from({ length:44 }, (_, k) => ['LW-' + (400 + k), ['Ajuste de layout no rodapé', 'Texto de ajuda do checkout', 'Ícones do menu lateral', 'Cor do botão de pagar'][k % 4] + ' ' + (k + 1), 'Backlog', '', 'Pequeno ajuste visual pedido pelo time de produto.'])).map(([code, title, st, who, text]) => ({ code, title, st, who, text }));
const CHEIO_CONV = Array.from({ length:14 }, (_, k) => (k % 2 ? 'Comando: ' : 'Pessoa: ') + 'mensagem antiga número ' + k + ' sobre o andamento geral das tarefas, com bastante detalhe pra ocupar espaço e forçar o orçamento do pedido a trabalhar de verdade neste teste. '.repeat(3));
for (const c of CASOS.filter(x => !process.env.CMD_SO || process.env.CMD_SO.split('|').some(k => x.nome.includes(k)))) {
  const refs = REFS.map(r => ({ ...r, foco: !!(c.foco && c.foco.id === r.id) }));
  // MESMO CAMINHO DO APP: regras no sistema, dados orçados no pedido, e os tetos do Rust (comando_plan) por cima.
  // c.cheio = volume de produção (dezenas de tarefas com fatos, painel inteiro, conversa longa) — o caso que quebrou em 25/11.
  const extra = c.cheio ? CHEIO_REFS : [], painel = c.painel || (c.cheio ? PAINEL : []);
  const todas = refs.concat(extra), docs = painel.map(i => ({ tipo:'issue', code:i.code, title:i.title, text:i.text || '', st:i.st, who:i.who })).concat(todas.map(r => ({ tipo:'tarefa', code:r.code, title:r.title, text:'', st:r.st }))).concat(c.docs || []);
  const dados = { achados:C.cmdAchar(c.pedido, docs, 8), proj:'loja-web', refs:todas, epics:[], foco:(c.foco && c.foco.ctx) || '', conversa:(c.cheio ? CHEIO_CONV : []).concat(c.conversa || []), pedido:c.pedido, minReq:c.minReq || 0, issues:c.issues || painel.slice(0, 30) };
  const sistema = (C.CMD_PLAN_SYS + '\n\n' + C.cmdPlanRegras({ minReq:c.minReq || 0 })).slice(0, 40000), prompt = C.cmdPlanDados(dados, 40000).slice(0, 80000);
  if (!prompt.includes('PEDIDO DA PESSOA: ' + c.pedido) || !sistema.includes('REGRAS:')) { falhas.push({ caso:c.nome, erros:['o pedido ou as regras foram cortados antes de chegar na IA'] }); console.log('✗ CORTE  ' + c.nome); continue; }
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', prompt, ...args(sistema)], { cwd: tmpdir(), encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'], env:{ ...process.env, ANTHROPIC_API_KEY:'' } });
  const s = (Date.now() - t0) / 1000; tempo += s;
  let env = null; try { env = JSON.parse(r.stdout); } catch (_) { }
  custo += (env && env.total_cost_usd) || 0;
  const P = C.cmdPlanParse(env ? String(env.result || '') : '');
  const erros = [];
  if (!P) erros.push('não veio JSON: ' + String((env && env.result) || r.stderr || r.stdout).slice(0, 120));
  else {
    const got = P.passos.map(p => [p.acao, p.tarefas.map(q => (C.cmdRefTask(q, refs) || {}).ref || '?' + q)]);
    c.quer.forEach(([acoes, ts], k) => { const g = got[k]; if (!g) return erros.push(`faltou o passo ${k + 1} (${acoes})`);
      if (!acoes.split('|').includes(g[0])) erros.push(`passo ${k + 1}: veio "${g[0]}", queria ${acoes}`);
      if (ts.length && JSON.stringify([...g[1]].sort()) !== JSON.stringify([...ts].sort())) erros.push(`passo ${k + 1}: tarefas ${g[1].join(',') || '(nenhuma)'}, queria ${ts.join(',')}`); });
    (c.tem || []).forEach(([acoes, ref]) => { if (!got.some(g => acoes.split('|').includes(g[0]) && g[1].includes(ref))) erros.push(`faltou um passo ${acoes} com ${ref} (veio: ${got.map(g => g[0] + ' ' + g[1].join(',')).join(' → ') || 'nenhum'})`); });
    if (c.quer.length === 0 && !c.tem && c.duvida && got.some(g => C.CMD_MUTA.has(g[0]))) erros.push('devia perguntar, mas propôs ' + got.map(g => g[0] + ' ' + g[1].join(',')).join(' → '));
    if (c.duvida && !P.duvida && !/\?/.test(P.fala)) erros.push('não perguntou qual');
    if (c.semMuta && got.some(g => C.CMD_MUTA.has(g[0]))) erros.push('propôs mexer em algo: ' + got.map(g => g[0]).join(','));
    if (c.naoPode && got.some(g => g[1].some(x => c.naoPode.includes(x)))) erros.push('usou a tarefa errada: ' + c.naoPode.join(','));
    if (c.fala && !c.fala.test(P.fala)) erros.push('a fala não citou os fatos: "' + P.fala.slice(0, 100) + '"');
    if (c.nova) { const n = P.passos.find(p => p.acao === 'criar_demanda'); if (!n) erros.push('não propôs criar a tarefa'); else { if ((n.requisitos || []).length < c.nova.req) erros.push(`só ${(n.requisitos || []).length} requisitos`); if (!n.titulo) erros.push('sem título'); if (n.texto.length < 80) erros.push('objetivo curto demais'); if (c.nova.origem && !n.tarefas.some(t => t.replace(/\D/g, '') === c.nova.origem)) erros.push('não citou a tarefa de origem'); console.log('   título: ' + n.titulo + '\n   objetivo: ' + n.texto.slice(0, 300) + '\n   requisitos:\n     - ' + n.requisitos.join('\n     - ')); } }
    if (c.alvo && !P.passos.some(p => c.alvo.test(p.alvo))) erros.push('não levou o destino em alvo: ' + JSON.stringify(P.passos.map(p => p.alvo)));
    if (c.semPassos && P.passos.length) erros.push('era só conversa, mas veio passo: ' + P.passos.map(p => p.acao).join(','));
    if (c.semPassos && P.fala.length < 2) erros.push('não respondeu nada');
    if (c.falaMax && P.fala.length > c.falaMax) erros.push(`fala longa (${P.fala.length} caracteres)`);
    if (c.texto && !P.passos.some(p => c.texto.test(p.texto))) erros.push('o texto da instrução não levou o que a pessoa disse');
    if (/\bT\d+\b/.test(P.fala + P.duvida)) erros.push('vazou identificador interno (T1…)');
  }
  if (erros.length) falhas.push({ caso:c.nome, erros, plano:P && P.passos.map(p => p.acao + ' ' + p.tarefas.join(',')).join(' → '), fala:P && P.fala.slice(0, 140), duvida:P && P.duvida.slice(0, 140) }); else ok++;
  console.log(`${erros.length ? '✗' : '✓'} ${s.toFixed(1)}s  ${c.nome}${erros.length ? '\n    ' + erros.join('\n    ') : ''}`);
}
console.log(`\n${ok} de ${CASOS.length} certos · tempo médio ${(tempo / CASOS.length).toFixed(1)} s · custo total US$ ${custo.toFixed(3)} (US$ ${(custo / CASOS.length).toFixed(4)} por pedido)`);
if (falhas.length) console.log('\nFALHAS:\n' + JSON.stringify(falhas, null, 1));
process.exit(falhas.length ? 1 : 0);
