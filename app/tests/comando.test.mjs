// Comando (89-comando): o centralizador — intenção da frase, plano/decisões/caminho/arquivos lidos da sessão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/89-comando.js'), HTML = read('index.html');
const C = new Function(cut(JS, '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { cmdIntent, cmdAcaoDe, cmdNeeds, cmdNovos, cmdSugestaoDe, cmdDireto, cmdPrecisaOk, cmdRefTask, cmdPlanParse, cmdPlanPrompt, cmdSemRefs, cmdLinkCodes, cmdFalaUtil, cmdSlash, cmdToken, CMD_PERIGO, CMD_SEM_TAREFA, CMD_PLAN_SYS, CMD_SLASH, CMD_MUTA, CMD_ACOES, cmdPlan, cmdDecisions, cmdFiles, cmdPath, cmdLastErr, cmdSnapshot };')();
const T = [{ id:'a', code:'LW-47', title:'Avisos de estoque baixo' }, { id:'b', code:'LW-97', title:'Prévia do frete' }];

test('intenção: estado sai dos dados; só o texto livre vai pra IA', () => {
  assert.equal(C.cmdIntent('Como estão os agentes?', T).k, 'status');
  assert.equal(C.cmdIntent('o que está me esperando?', T).k, 'espera');
  assert.equal(C.cmdIntent('alguma tarefa parou?', T).k, 'erro');
  assert.deepEqual(C.cmdIntent('por que a lw-47 parou?', T), { k:'porque', id:'a' });
  assert.deepEqual(C.cmdIntent('abre a LW-97', T), { k:'abrir', id:'b' });
  assert.deepEqual(C.cmdIntent('como vai a prévia do frete', T), { k:'tarefa', id:'b' });
  assert.deepEqual(C.cmdIntent('pausa a LW-97', T), { k:'parar', id:'b' });
  assert.equal(C.cmdIntent('pausa tudo que está rodando', T).k, 'parar');
  assert.equal(C.cmdIntent('onde fica a validação do CEP no código?', T).k, 'ia');
  assert.deepEqual(C.cmdIntent('LW-999 como está', T), { k:'issue', code:'LW-999', go:false, link:false }, 'código que não é tarefa = issue do painel');
  assert.deepEqual(C.cmdIntent('pega a lw-102 e começa', T), { k:'issue', code:'LW-102', go:true, link:false });
  assert.deepEqual(C.cmdIntent('me dá o link da LW-300', T), { k:'issue', code:'LW-300', go:false, link:true });
  assert.equal(C.cmdIntent('o que tem na fila de issues?', T).k, 'fila');
  assert.equal(C.cmdIntent('qual a próxima?', T).k, 'fila');
  assert.equal(C.cmdIntent('  ', T).k, '');
});

test('sessão: plano, decisões, arquivos e caminho', () => {
  const it = [
    { k:'you', ts:1, text:'faz o aviso' },
    { k:'tool', name:'Plano', arg:'1 itens', text:'pending\tvelho' },
    { k:'tool', name:'Read', arg:'a.ts' }, { k:'tool', name:'Read', arg:'b.ts' },
    { k:'ask', text:'Na hora ou resumo?', done:true, out:'User has answered your questions: Resumo diário' },
    { k:'edit', name:'Update', arg:'src/a.ts', add:10, del:2 }, { k:'edit', name:'Update', arg:'src/a.ts', add:5, del:0 }, { k:'edit', name:'Write', arg:'src/b.ts', add:3, del:0 },
    { k:'tool', name:'Bash', arg:'npm test', out:'1 falhou', err:true },
    { k:'tool', name:'Plano', arg:'2 itens', text:'completed\tRegra\nin_progress\tTestes' },
    { k:'ask', text:'Qual fuso?' },
  ];
  assert.deepEqual(C.cmdPlan(it), [{ st:'ok', tx:'Regra' }, { st:'now', tx:'Testes' }], 'vale o último plano');
  assert.deepEqual(C.cmdDecisions(it).map(d => [d.q, d.a]), [['Na hora ou resumo?', 'Resumo diário'], ['Qual fuso?', '']]);
  assert.deepEqual(C.cmdFiles(it).map(f => [f.f, f.add, f.del]), [['src/a.ts', 15, 2], ['src/b.ts', 3, 0]]);
  const p = C.cmdPath(it, 30);
  assert.equal(p.filter(x => x.k === 'read').length, 1, 'leituras seguidas viram uma linha');
  assert.equal(p.find(x => x.k === 'read').tx, '2 arquivos');
  assert.ok(p.find(x => x.err && /npm test — 1 falhou/.test(x.tx)));
  assert.equal(C.cmdPath(it, 3).length, 3);
  assert.deepEqual(C.cmdLastErr(it), { name:'Bash', arg:'npm test', out:'1 falhou' });
  assert.deepEqual(C.cmdPlan([]), []);
});

test('estado pra IA e ligação da aba', () => {
  const s = C.cmdSnapshot([{ code:'LW-97', title:'Prévia do frete', st:'aguardando você', branch:'feat/frete', q:'Que dados?' }], 'loja-web');
  assert.match(s, /LW-97 "Prévia do frete" — aguardando você · branch feat\/frete · pergunta aberta: Que dados\?/);
  assert.match(C.cmdSnapshot([], ''), /nenhuma tarefa aberta/);
  assert.ok(HTML.includes('id="comandoOverlay"') && HTML.includes('id="comandoBtn"') && HTML.includes('js/89-comando.js') && HTML.includes('css/99-comando.css'));
  assert.ok(HTML.indexOf('js/89-comando.js') > HTML.indexOf('js/76-casca-semana.js'), 'carrega depois da casca');
  assert.ok(/invoke\('new_task', await trkBeforeNewTask\(payload, \{ ask:true \}\)\)/.test(JS), 'começar issue = a mesma criação da Nova demanda (com aviso de duplicada)');
  assert.ok(/issue:i\.code/.test(JS) && /minRequirements/.test(JS), 'leva o código da issue e respeita a política de requisitos');
  assert.ok(/SpeechSynthesisUtterance/.test(JS) && /not-allowed/.test(JS) && HTML.includes('js/89-comando.js'), 'voz: fala a resposta e explica quando o microfone é negado');
  assert.ok(/askYes\(/.test(JS) && !/window\.confirm|[^a-zA-Z]confirm\(/.test(JS), 'parar pede confirmação pelo askYes');
});

test('épicos, provas, links, instrução e telas — e a linha ACAO da IA cai no mesmo caminho', () => {
  const E = [{ id:'e1', name:'Checkout novo' }, { id:'e2', name:'Relatórios' }];
  assert.equal(C.cmdIntent('como estão os épicos?', T, E).k, 'epicos');
  assert.deepEqual(C.cmdIntent('como vai o épico checkout novo', T, E), { k:'epico', id:'e1' });
  assert.deepEqual(C.cmdIntent('abre as imagens de prova da LW-97', T, E), { k:'provas', id:'b' });
  assert.deepEqual(C.cmdIntent('prints da prévia do frete', T, E), { k:'provas', id:'b' });
  assert.equal(C.cmdIntent('quais provas tenho pra ver?', T, E).k, 'provas');
  assert.deepEqual(C.cmdIntent('pega o link do PR da LW-47', T, E), { k:'link', id:'a' });
  assert.deepEqual(C.cmdIntent('LW-97: usa só prazo e valor', T, E), { k:'instruir', id:'b', text:'usa só prazo e valor' });
  assert.deepEqual(C.cmdIntent('abre a tela de issues', T, E), { k:'tela', tela:'issues' });
  assert.deepEqual(C.cmdIntent('vai pra central', T, E), { k:'tela', tela:'flow' });
  assert.deepEqual(C.cmdIntent('começa o épico checkout novo', T, E), { k:'epico', id:'e1', act:'start' });
  assert.deepEqual(C.cmdIntent('libera a próxima onda do relatórios', T, E), { k:'epico', id:'e2', act:'liberar' });
  assert.deepEqual(C.cmdIntent('pode entregar o épico relatórios', T, E), { k:'epico', id:'e2', act:'entregar' });
  assert.deepEqual(C.cmdIntent('verificar epico Relatórios', T, E), { k:'epico', id:'e2', act:'verificar' });
  assert.ok(/act\.k!==k/.test(JS) && /askYes\(`\$\{act\.label/.test(JS), 'ação do épico: só a do momento, e com confirmação');
  assert.equal(C.cmdAcaoDe('ACAO: provas LW-97'), 'provas LW-97');
  assert.equal(C.cmdAcaoDe('Claro.\nacao:  epico Relatórios \n'), 'epico Relatórios');
  assert.equal(C.cmdAcaoDe('A validação fica em src/cep.ts'), '');
  // toda frase do catálogo que a IA pode devolver vira uma ação conhecida
  for (const f of ['status', 'esperando', 'erro', 'fila de issues', 'epicos', 'epico Relatórios', 'tarefa LW-97', 'por que LW-47 parou', 'provas LW-97', 'link LW-97', 'abrir LW-97', 'parar LW-97', 'parar tudo rodando', 'comecar LW-102', 'LW-97: troca o texto', 'abrir tela entregas'])
    assert.notEqual(C.cmdIntent(f, T, E).k, 'ia', f);
  const s = C.cmdSnapshot([], 'loja', [{ name:'Checkout novo', done:2, total:5 }]);
  assert.match(s, /épico "Checkout novo" — 2 de 5 tarefas entregues/);
  assert.match(s, /ACAO: <frase>/);
  assert.ok(/proofPanel\(t\.id, 'compact'\)/.test(JS) && /openExternal\(b\.dataset\.cmdlk\)/.test(JS) && /epOpenById/.test(JS), 'provas = o painel de provas do app; link abre fora; épico abre a aba dele');
});

test('entendimento: frase conversada não vira ação por palavra solta; "a task" é a que está aberta; perguntar ao agente', () => {
  // o caso real (12/11): isto virou "Nada esperando por você agora"
  const f = 'poderia perguntar para o agente da task? acredito que esse status não reflita o cenário real';
  assert.equal(C.cmdIntent(f, T, [], '').k, 'ia', 'sem tarefa em foco vai pra IA');
  assert.equal(C.cmdIntent(f, T, [], 'b').k, 'ia', 'frase longa não se apoia na tarefa ao lado: a IA resolve e propõe');
  const r = C.cmdIntent('pergunta pro agente da task', T, [], 'b');
  assert.equal(r.k, 'perguntar'); assert.equal(r.id, 'b');
  assert.deepEqual(C.cmdIntent('perguntar LW-47: os testes passam?', T, [], ''), { k:'perguntar', id:'a', text:'os testes passam?' });
  assert.deepEqual(C.cmdIntent('como está a task?', T, [], 'a'), { k:'tarefa', id:'a' });
  assert.equal(C.cmdIntent('acho que tem algo errado com os agentes', T, [], '').k, 'ia');
  assert.equal(C.cmdIntent('me explica com calma o que cada agente fez hoje de manhã e o que falta', T, [], '').k, 'ia', 'frase longa vai pra IA');
  assert.equal(C.cmdIntent('quantas perguntas o cliente fez no chat?', T, [], '').k, 'ia', '"pergunta" solta não é "esperando você"');
  assert.equal(C.cmdIntent('o que está me esperando?', T, [], '').k, 'espera');
  const s = C.cmdSnapshot([], 'loja', [], 'LW-47 "Avisos" — selo: pronta pra revisar');
  assert.match(s, /TAREFA EM FOCO/); assert.match(s, /perguntar <código>: <pergunta pro agente da tarefa>/);
  assert.ok(/sem alterar nenhum arquivo/.test(JS) && /k:'pergunta'/.test(JS), 'a pergunta pede só resposta e a fala do agente volta pra conversa');
});

test('assistente: avisa o que é novo, uma vez; resolveu e voltou, avisa de novo; 1ª vez não despeja tudo', () => {
  const rows = [{ id:'a', st:'review' }, { id:'b', st:'asking', ask:'g:1' }, { id:'c', st:'running' }, { id:'d', st:'error' }];
  const n = C.cmdNeeds(rows);
  assert.deepEqual(n.map(x => x.tipo + ':' + x.id), ['ask:b', 'bad:d', 'rev:a'], 'pergunta, erro, revisão — rodando não pede conversa');
  const p0 = C.cmdNovos(n, null);
  assert.deepEqual(p0.novos, [], 'primeira vez: o resumo de abertura cobre');
  assert.equal(p0.seen.length, 3);
  assert.deepEqual(C.cmdNovos(n, p0.seen).novos, [], 'nada mudou: não repete');
  const n2 = C.cmdNeeds([{ id:'a', st:'review' }, { id:'b', st:'asking', ask:'g:2' }, { id:'c', st:'asking', ask:'p:9' }]);
  const p2 = C.cmdNovos(n2, p0.seen);
  assert.deepEqual(p2.novos.map(x => x.id), ['b', 'c'], 'pergunta NOVA na mesma tarefa e pergunta em outra');
  const p3 = C.cmdNovos(C.cmdNeeds([{ id:'a', st:'running' }]), p2.seen);
  assert.deepEqual(p3.seen, [], 'o que se resolveu sai da lista');
  assert.deepEqual(C.cmdNovos(C.cmdNeeds([{ id:'a', st:'review' }]), p3.seen).novos.map(x => x.id), ['a'], 'terminou de novo: avisa de novo');
  assert.ok(HTML.includes('id="comandoCnt"') && /Precisamos conversar sobre/.test(JS) && /cmdWatch\(\); cmdWatchOutros\(\); if\(cmdAtiva\(\)\)/.test(JS), 'contador na lateral e vigia a cada atualização, com a aba aberta ou não');
});

test('assistente: sugestão vem com a instrução pronta; outros projetos entram na vigia', () => {
  assert.deepEqual(C.cmdSugestaoDe('SUGESTAO: O teste falha por fuso. Eu trocaria pra UTC.\nINSTRUCAO: Use UTC na virada do dia e rode os testes.'),
    { sug:'O teste falha por fuso. Eu trocaria pra UTC.', ins:'Use UTC na virada do dia e rode os testes.' });
  assert.deepEqual(C.cmdSugestaoDe('Sugestão: Está tudo provado; é só aprovar.\nInstrução: vazio'), { sug:'Está tudo provado; é só aprovar.', ins:'' });
  assert.deepEqual(C.cmdSugestaoDe('texto solto sem formato'), { sug:'texto solto sem formato', ins:'' });
  assert.ok(/t\.repo!==repo/.test(JS) && /pushNotif\(/.test(JS) && /cmdseen:outros/.test(JS), 'outros projetos: aviso + notificação do sistema, lembrados à parte');
  assert.ok(/data-cmdmandar/.test(JS) && /m\.sent=true/.test(JS), 'a instrução sugerida só vai pro agente com o clique');
});

test('encerrar, ambiente e o que foi feito pelo chat; pergunta ao agente num cartão só', () => {
  assert.deepEqual(C.cmdIntent('pode encerrar a LW-47', T, [], ''), { k:'encerrar', id:'a' });
  assert.deepEqual(C.cmdIntent('sobe o ambiente da LW-97', T, [], ''), { k:'ambiente', id:'b', on:true });
  assert.deepEqual(C.cmdIntent('desliga o servidor da LW-97', T, [], ''), { k:'ambiente', id:'b', on:false });
  assert.deepEqual(C.cmdIntent('sobe o ambiente', T, [], 'a'), { k:'ambiente', id:'a', on:true }, 'sem citar a tarefa, vale a que está aberta ao lado');
  assert.deepEqual(C.cmdIntent('o que foi feito na LW-47?', T, [], ''), { k:'feito', id:'a' });
  assert.deepEqual(C.cmdIntent('encerra', T, [], 'b'), { k:'encerrar', id:'b' });
  assert.equal(C.cmdIntent('sobe o ambiente', T, [], '').k, 'ia', 'sem tarefa em foco não adivinha qual');
  for (const f of ['o que foi feito LW-97', 'subir ambiente LW-97', 'desligar ambiente LW-97', 'encerrar LW-97']) assert.notEqual(C.cmdIntent(f, T, [], '').k, 'ia', f);
  assert.ok(/encerrarTarefa\(it\.id/.test(JS) && /envUp\(it\.id\)/.test(JS) && /envDown\(it\.id\)/.test(JS), 'usa o encerrar (com motivo e desfazer) e a Prévia do app');
  assert.ok(/state:'wait'/.test(JS) && /cmdqa-q/.test(JS) && /respondeu em/.test(JS), 'pergunta ao agente: um cartão com a pergunta, o andamento e a resposta');
});

test('caso real 12/11 (2): conversa não é comando; "para" não é parar; o que escreve numa tarefa vira proposta', () => {
  const f1 = 'não estou falando dessa tarefa falo da ultima tarefa que abrimos hoje é sobre criar um use cases para o ncm intel pro';
  const f2 = 'eu sei precisamos continuar rodando ela';
  assert.equal(C.cmdDireto(f1), false); assert.equal(C.cmdDireto(f2), false);
  assert.notEqual(C.cmdIntent(f1, T, [], 'b').k, 'parar', '"para o ncm" não é "parar"; frase longa não usa a tarefa ao lado');
  assert.equal(C.cmdIntent('quero um resumo para a LW-97', T, [], '').k, 'tarefa', 'a preposição "para" não para tarefa');
  for (const f of ['como estão os agentes?', 'o que está me esperando?', 'pega a LW-102 e começa', 'como esta a task LW-47', 'sobe o ambiente', 'encerra a LW-47']) assert.equal(C.cmdDireto(f), true, f);
  for (const f of ['não é essa tarefa', 'acho que tem algo errado', 'a última de hoje', 'precisamos continuar ela']) assert.equal(C.cmdDireto(f), false, f);
  assert.deepEqual(C.cmdIntent('continuar LW-47', T, [], ''), { k:'continuar', id:'a' });
  // vindas da IA: instrução, pergunta ao agente, continuar, subir ambiente e começar issue pedem confirmação; ler não
  for (const it of [{ k:'instruir' }, { k:'perguntar' }, { k:'continuar' }, { k:'ambiente', on:true }, { k:'issue', go:true }]) assert.equal(C.cmdPrecisaOk(it), true, it.k);
  for (const it of [{ k:'status' }, { k:'tarefa' }, { k:'provas' }, { k:'feito' }, { k:'link' }, { k:'issue', go:false }, { k:'ambiente', on:false }]) assert.equal(C.cmdPrecisaOk(it), false, it.k);
  assert.ok(/if\(chip\)\{ const it=cmdResolve\(text\)/.test(JS) && !/if\(cmdDireto\(text\)\)\{ const it=cmdResolve/.test(JS) && /return cmdPlanejar\(text\)/.test(JS), 'texto digitado nunca é adivinhado por palavra: só o botão de sugestão responde na hora');
  const s = C.cmdSnapshot([{ code:'LW-97', title:'Prévia', st:'rodando', criada:'hoje 10:12', mexida:'há 5 min', foco:true }], 'loja', []);
  assert.match(s, /criada hoje 10:12 · mexida há 5 min/); assert.match(s, /\[ABERTA AO LADO\]/); assert.match(s, /pergunte qual em vez de escolher/);
});

test('caso real 12/11 (3): vários encerramentos e uma listagem numa frase só viram UM plano', () => {
  const frase = 'Encerre a FND 1168 a 1195 a 1173 e a 1174 e depois me mostre as em aberto';
  assert.equal(C.cmdDireto(frase), false, 'mais de uma tarefa / mais de um passo nunca é atalho');
  assert.equal(C.cmdDireto('encerra a 1168 e a 1195'), false);
  const R = [{ id:'a', ref:'FND-1168', code:'FND-1168', title:'Tracer: escala de risco' }, { id:'b', ref:'FND-1195', code:'FND-1195', title:'Auditoria de segurança' },
    { id:'c', ref:'FND-1173', code:'FND-1173', title:'Lentidão no Fast após troca' }, { id:'d', ref:'FND-1174', code:'FND-1174', title:'Lentidão no Fast após troca (2)' }, { id:'e', ref:'T1', code:'', title:'Central de ajuda do use_cases em inglês' }];
  // a pessoa escreve o código de vários jeitos
  for (const [q, id] of [['FND-1168', 'a'], ['fnd 1168', 'a'], ['FND1168', 'a'], ['1195', 'b'], ['T1', 'e'], ['central de ajuda', 'e'], ['Auditoria de segurança', 'b']]) assert.equal((C.cmdRefTask(q, R) || {}).id, id, q);
  assert.equal(C.cmdRefTask('lentidão no fast', R), null, 'título que bate em duas não escolhe');
  assert.equal(C.cmdRefTask('9999', R), null); assert.equal(C.cmdRefTask('68', R), 'a' && C.cmdRefTask('68', R), 'sufixo curto só vale se for único');
  // o plano que a IA devolve
  const P = C.cmdPlanParse('Claro!\n{"fala":"Vou encerrar as quatro e listar o que sobra.","passos":[{"acao":"encerrar","tarefas":["FND-1168","FND-1195","FND-1173","FND-1174"]},{"acao":"abertas"},{"acao":"apagar_tudo"}],"duvida":""}\nfim');
  assert.equal(P.fala, 'Vou encerrar as quatro e listar o que sobra.');
  assert.deepEqual(P.passos.map(p => p.acao), ['encerrar', 'abertas'], 'ação desconhecida é descartada');
  assert.deepEqual(P.passos[0].tarefas, ['FND-1168', 'FND-1195', 'FND-1173', 'FND-1174']);
  assert.equal(C.cmdPlanParse('não sei'), null); assert.equal(C.cmdPlanParse('{quebrado'), null);
  assert.deepEqual(C.cmdPlanParse('{"passos":[{"acao":"instruir","tarefas":"FND-1168","texto":" usa UTC "}]}').passos[0], { acao:'instruir', tarefas:['FND-1168'], texto:'usa UTC', alvo:'' });
  // o que mexe em algo espera confirmação; ler não
  for (const a of ['encerrar', 'parar', 'continuar', 'instruir', 'ambiente_subir', 'comecar_issue', 'epico_acao']) assert.ok(C.CMD_MUTA.has(a), a);
  assert.ok(!C.CMD_MUTA.has('perguntar_agente'), 'conferir é leitura: não pede confirmação');
  for (const a of ['status', 'abertas', 'tarefa', 'feito', 'provas', 'link', 'epicos', 'ler_codigo']) assert.ok(!C.CMD_MUTA.has(a) && C.CMD_ACOES[a], a);
  const pr = C.cmdPlanPrompt({ proj:'loja', refs:[{ ref:'FND-1168', code:'FND-1168', title:'Tracer', st:'pronta pra revisar', proj:'relay', criada:'ontem 10:00', foco:true }], epics:[], foco:'', conversa:['Pessoa: oi'], pedido:frase });
  assert.match(pr, /- FND-1168 "Tracer" — pronta pra revisar · projeto relay · criada ontem 10:00 · \[ABERTA AO LADO\]/);
  assert.match(pr, /PEDIDO DA PESSOA: Encerre a FND 1168/); assert.match(pr, /VÁRIAS tarefas no mesmo passo/); assert.match(pr, /NÃO escolha/); assert.match(pr, /CONVERSA ATÉ AQUI:\nPessoa: oi/);
  assert.ok(/invoke\('comando_plan'/.test(JS) && /k:'plano', plan:P/.test(JS) && /motivo:''/.test(JS), 'plano que mexe em algo vira cartão de confirmação; encerrar em lote não abre uma folha por tarefa');
  assert.ok(/await cmdProjeto\(x\.repo\)/.test(JS) && /if\(cmdRepo\(\)!==home\) await cmdProjeto\(home\)/.test(JS), 'tarefa de outro projeto: troca, age e volta');
});

test('a caixa do chat cresce com a mensagem', () => {
  assert.ok(/<textarea class="in" id="cmdQ" rows="1"/.test(JS) && /function cmdGrow\(\)/.test(JS), 'textarea que cresce');
  assert.ok(/e\.key==='Enter' && !e\.shiftKey && !e\.isComposing/.test(JS), 'Enter envia, Shift+Enter quebra linha');
});

test('formatação: lista é do app, identificador interno não vaza, código vira atalho, lote vira um resultado', () => {
  const refs = [{ ref:'T1', code:'', title:'MCP use_cases T5 — Compras internacionais' }, { ref:'FND-1208', code:'FND-1208', title:'Mock navegável' }];
  assert.equal(C.cmdSemRefs('Abertas: FND-1208 e T1. T9 não existe.', refs), 'Abertas: FND-1208 e “MCP use_cases T5 — Compras internaciona…”. T9 não existe.');
  assert.equal(C.cmdLinkCodes('<p>Veja a FND-1208 e a XX-1.</p><a href="FND-1208">x</a>', { 'FND-1208':'id1' }),
    '<p>Veja a <button type="button" class="cmdchipc" data-cmdsel="id1">FND-1208</button> e a XX-1.</p><a href="FND-1208">x</a>', 'só fora das tags e só tarefa conhecida');
  const pr = C.cmdPlanPrompt({ refs:[], pedido:'x' });
  assert.match(pr, /NUNCA liste tarefas em texto corrido/); assert.match(pr, /no máximo 2 frases/);
  assert.ok(/k:'resultado', titulo:LOTE\[p\.acao\]/.test(JS) && /quiet:true/.test(JS), 'encerrar/parar/continuar em lote: uma lista de resultado, não uma fala por tarefa');
});

test('caso real 12/11 (4): "No response requested." não é resposta; o assistente usa os fatos e lê a resposta do agente', () => {
  for (const s of ['No response requested.', 'no response requested', 'ok', 'Entendido.', '', '   ']) assert.equal(C.cmdFalaUtil(s), false, JSON.stringify(s));
  assert.equal(C.cmdFalaUtil('Não está pronta: nenhum dos 26 requisitos tem prova registrada e não abri PR.'), true);
  const pr = C.cmdPlanPrompt({ refs:[{ ref:'FND-1228', code:'FND-1228', title:'NCM Intel Pro', st:'pronta pra revisar', fatos:'0 de 26 requisitos com prova, sem PR', foco:true }], pedido:'acredito que ela não esteja pronta, pode conferir com o agente?' });
  assert.match(pr, /FATOS: 0 de 26 requisitos com prova, sem PR/);
  assert.match(pr, /O SELO .* é só o rótulo do app/); assert.match(pr, /DIGA ISSO em "fala", com os números/); assert.match(pr, /ponha a pergunta, de forma específica/);
  const ask = JS.slice(JS.indexOf('async function cmdAskAgent'), JS.indexOf('function cmdPerguntaHtml'));
  assert.ok(!/const pedido=`[^`]*\\n/.test(ask), 'a pergunta vai em UMA linha (quebra de linha no terminal envia pela metade)');
  assert.ok(/interno:\(m\.text\?/.test(ask) && /semPerguntar:true/.test(ask) && /cmdFalaUtil\(x\.text\)/.test(ask), 'depois da resposta útil, o assistente lê com os fatos e propõe o próximo passo (sem perguntar de novo)');
  assert.ok(/\.cmdproof \.apv-g2\{grid-template-columns:minmax\(0,1fr\)\}/.test(read('css/99-comando.css')), 'provas na conversa: uma coluna');
});

test('caso real 12/11 (5): conferir NÃO escreve no terminal do agente; erro de API não é resposta', () => {
  for (const s of ['API Error: The response stopped arriving. The response above may be incomplete.', 'Error: overloaded', 'Request timed out after 60s, try again']) assert.equal(C.cmdFalaUtil(s), false, s);
  const conf = JS.slice(JS.indexOf('async function cmdConferir'), JS.indexOf('async function cmdAskAgent'));
  assert.ok(/invoke\('comando_portavoz'/.test(conf) && !/tiSend\(/.test(conf), 'o porta-voz responde à parte: nada vai pro terminal do executor');
  assert.ok(/O QUE VOCÊ JÁ RESPONDEU SOBRE ESTA TAREFA/.test(conf) && /lsSet\(cmdPvKey\(id\), JSON\.stringify\(mem\.slice\(-3\)\)\)/.test(conf) && !/--resume|aiCallResumeSafe/.test(conf), 'memória do porta-voz vai no pedido; ele não grava sessão');
  assert.ok(/case 'perguntar': cmdConferir\(it\.id, it\.text\)/.test(JS) && /case 'perguntar-direto': cmdAskAgent/.test(JS), 'perguntar = conferir; escrever no terminal só pelo botão "Perguntar direto ao agente"');
  assert.match(C.cmdPlanPrompt({ refs:[], pedido:'x' }), /DOIS agentes: o executor \(trabalha\) e o porta-voz \(só lê e responde\)/);
  const RS = read('../src-tauri/src/lib.rs');
  const pv = RS.slice(RS.indexOf('fn comando_portavoz_inner('), RS.indexOf('fn comando_portavoz_inner(') + 2600);
  assert.ok(/comando_portavoz,/.test(RS) && /comando_portavoz_stop,/.test(RS) && /Read,Grep,Glob,LS,Bash\(git log:\*\)/.test(pv) && /current_dir\(&wt\)/.test(pv) && !/"--resume"/.test(pv) && /--no-session-persistence/.test(pv) && /--setting-sources/.test(pv) && !/Edit|Write/.test(pv), 'porta-voz: só leitura, sem gravar sessão e sem os ganchos da pasta da tarefa');
  const TR = read('../src-tauri/src/term.rs');
  assert.ok(/fn is_portavoz_transcript/.test(TR) && /fn executor_transcript_near/.test(TR) && /UPDATE term_session SET session_id=\?2/.test(TR), 'reparo: sessão do porta-voz gravada como a da tarefa volta pra sessão de verdade');
});

test('comando direto "/" e "@": sem IA, na hora; perigo ainda pede o sim', () => {
  const R = [{ id:'a', ref:'FND-1168', code:'FND-1168', title:'Tracer' }, { id:'b', ref:'FND-1195', code:'FND-1195', title:'Auditoria' }, { id:'e', ref:'T1', code:'', title:'Central de ajuda' }];
  assert.deepEqual(C.cmdSlash('/encerrar @FND-1168 1195 e @T1', R).passos, [{ acao:'encerrar', tarefas:['FND-1168', '1195', 'T1'], texto:'', alvo:'' }]);
  assert.deepEqual(C.cmdSlash('/instruir @FND-1168 usa UTC na virada do dia', R).passos[0], { acao:'instruir', tarefas:['FND-1168'], texto:'usa UTC na virada do dia', alvo:'' });
  assert.deepEqual(C.cmdSlash('/nova Exportar pedidos em CSV', R).passos[0], { acao:'criar_demanda', tarefas:[], texto:'Exportar pedidos em CSV', alvo:'Exportar pedidos em CSV' });
  assert.deepEqual(C.cmdSlash('/parar todas', R).passos[0].tarefas, ['todas']);
  assert.equal(C.cmdSlash('/pr @FND-1195', R).passos[0].acao, 'abrir_pr'); assert.equal(C.cmdSlash('/status', R).passos[0].acao, 'status');
  assert.equal(C.cmdSlash('/naoexiste x', R), null); assert.equal(C.cmdSlash('encerrar a 1168', R), null, 'sem barra não é comando direto');
  assert.deepEqual(C.cmdToken('/enc', 4), { tipo:'acao', q:'enc', ini:0 });
  assert.deepEqual(C.cmdToken('/encerrar @fnd', 14), { tipo:'tarefa', q:'fnd', ini:10 });
  assert.equal(C.cmdToken('olha a @', 8).tipo, 'tarefa'); assert.equal(C.cmdToken('texto normal', 12), null); assert.equal(C.cmdToken('a/b', 3), null);
  assert.equal((C.cmdRefTask('@FND-1195', R) || {}).id, 'b', '@ na frente não atrapalha');
  for (const a of ['encerrar', 'aprovar', 'epico_acao']) assert.ok(C.CMD_PERIGO.has(a), a);
  for (const a of Object.values(C.CMD_SLASH)) assert.ok(C.CMD_ACOES[a], 'apelido aponta pra ação que existe: ' + a);
  for (const a of ['aprovar', 'pedir_alteracao', 'abrir_pr', 'responder', 'criar_demanda', 'trocar_projeto']) assert.ok(C.CMD_ACOES[a], a);
  assert.ok(C.CMD_SEM_TAREFA.has('criar_demanda') && C.CMD_SEM_TAREFA.has('trocar_projeto') && /SOMENTE com o objeto JSON/.test(C.CMD_PLAN_SYS));
  const RS = read('../src-tauri/src/lib.rs'), pl = RS.slice(RS.indexOf('fn comando_plan('), RS.indexOf('fn comando_plan(') + 1900);
  assert.ok(/--strict-mcp-config/.test(pl) && /"--tools", ""/.test(pl) && /--system-prompt/.test(pl) && /--no-session-persistence/.test(pl) && /claude-sonnet-5/.test(pl), 'plano no modo enxuto: sem ferramentas, sem MCP, modelo médio');
  assert.ok(/fn comando_log\(/.test(RS) && /comando\.jsonl/.test(RS) && /invokeQuiet\('comando_log'/.test(JS) && /via:'decisao'/.test(JS), 'diário: pedido, plano e a decisão da pessoa');
  assert.ok(/id="cmdVoz"/.test(JS) && /lsGet\('cmdvoz'\)/.test(JS), 'voz: escolhe entre as instaladas no sistema');
});
