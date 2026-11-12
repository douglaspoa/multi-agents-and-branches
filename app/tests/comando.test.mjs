// Comando (89-comando): o centralizador — intenção da frase, plano/decisões/caminho/arquivos lidos da sessão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/89-comando.js'), HTML = read('index.html');
const C = new Function(cut(JS, '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { cmdIntent, cmdPlan, cmdDecisions, cmdFiles, cmdPath, cmdLastErr, cmdSnapshot };')();
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
  assert.equal(C.cmdIntent('LW-999 como está', T).k, 'status', 'código que não existe não vira tarefa');
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
  assert.ok(/askYes\(/.test(JS) && !/window\.confirm|[^a-zA-Z]confirm\(/.test(JS), 'parar pede confirmação pelo askYes');
});
