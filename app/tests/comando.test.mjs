// Comando (89-comando): o centralizador — intenção da frase, plano/decisões/caminho/arquivos lidos da sessão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/89-comando.js'), HTML = read('index.html');
const C = new Function(cut(JS, '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { cmdIntent, cmdAcaoDe, cmdPlan, cmdDecisions, cmdFiles, cmdPath, cmdLastErr, cmdSnapshot };')();
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
