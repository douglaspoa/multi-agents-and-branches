// Comando (89-comando): o centralizador — intenção da frase, plano/decisões/caminho/arquivos lidos da sessão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/89-comando.js'), HTML = read('index.html');
const C = new Function(cut(JS, '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { cmdIntent, cmdAcaoDe, cmdNeeds, cmdNovos, cmdSugestaoDe, cmdPlan, cmdDecisions, cmdFiles, cmdPath, cmdLastErr, cmdSnapshot };')();
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
  const r = C.cmdIntent(f, T, [], 'b');
  assert.equal(r.k, 'perguntar'); assert.equal(r.id, 'b'); assert.equal(r.text, f);
  assert.deepEqual(C.cmdIntent('perguntar LW-47: os testes passam?', T, [], ''), { k:'perguntar', id:'a', text:'os testes passam?' });
  assert.deepEqual(C.cmdIntent('como está a task?', T, [], 'a'), { k:'tarefa', id:'a' });
  assert.equal(C.cmdIntent('acho que tem algo errado com os agentes', T, [], '').k, 'ia');
  assert.equal(C.cmdIntent('me explica com calma o que cada agente fez hoje de manhã e o que falta', T, [], '').k, 'ia', 'frase longa vai pra IA');
  assert.equal(C.cmdIntent('quantas perguntas o cliente fez no chat?', T, [], '').k, 'ia', '"pergunta" solta não é "esperando você"');
  assert.equal(C.cmdIntent('o que está me esperando?', T, [], '').k, 'espera');
  const s = C.cmdSnapshot([], 'loja', [], 'LW-47 "Avisos" — selo: pronta pra revisar');
  assert.match(s, /TAREFA EM FOCO/); assert.match(s, /perguntar <código>: <pergunta pro agente da tarefa>/);
  assert.ok(/NÃO altere nenhum arquivo/.test(JS) && /k:'pergunta'/.test(JS), 'a pergunta pede só resposta e a fala do agente volta pra conversa');
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
