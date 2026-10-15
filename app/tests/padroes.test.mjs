// Padrões do time (75-padroes.js, redesenho "Semana"): Skills, Agentes e Memória como ABAS próprias (kinds 'skills',
// 'agentes', 'memoria'), filtros/linhas puros e os ganchos exportados pra lateral e pra tarefa. `node --test app/tests/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const js = rd('js/75-padroes.js');
const html = rd('index.html');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const P = new Function(cut(js, '// @padroes-puro-inicio', '// @padroes-puro-fim') +
  '\nreturn { padSkFilter, padSkWhere, padSkHistLine, padSkTitle, padQuandoLabel, padWhen, padAgStat, padAgPerVersion, padMemConflicts, padMemFilter, padSkillsOfTask, padObjectiveWithSkills, padFirst };')();

const R1 = '/tmp/demo/loja-web', R2 = '/tmp/demo/api-pagamentos';
const SK = [
  { name: 'impeccable', source: 'comunidade', on: {} },
  { name: 'testes-carrinho', source: 'projeto', repo: R1, on: { [R1]: { on: true, quando: 'codigo' } } },
  { name: 'acessibilidade', source: 'pessoal', on: { [R1]: { on: true, quando: '' } } },
];

test('as 3 telas são abas próprias com os kinds exatos e entram no index (script + css)', () => {
  assert.match(js, /PAD_OV=\{ skills:'padSkOverlay', agentes:'padAgOverlay', memoria:'padMemOverlay' \}/);
  assert.match(js, /VIEW_META\.agentes=\{ title:'Agentes'/);
  assert.match(js, /Object\.assign\(VIEW_OVERLAY, PAD_OV\)/);
  assert.match(js, /delete VIEW_ROUTES\.memoria; delete VIEW_ROUTES\.skills; VIEW_ROUTES\.agents=\['agentes', null\]/, 'openTab antigo cai nas abas novas');
  assert.match(html, /<script src="js\/75-padroes\.js"><\/script>/);
  assert.match(html, /css\/99-padroes\.css/);
  assert.doesNotMatch(js, /window\.confirm|confirm\(/, 'confirm não funciona no Tauri: askYes');
  for (const g of ['padMemoriaDaTarefa', 'padMemoriaErrada', 'padSkillsDaTarefa', 'padUsarNaNovaDemanda']) assert.match(js, new RegExp('window\\.' + g + '=' + g), g + ' exportado');
});

test('catálogo: filtros (ligadas aqui, do repositório, sua biblioteca, comunidade) mantêm a ordem', () => {
  assert.deepEqual(P.padSkFilter(SK, 'aqui', R1).map((s) => s.name), ['testes-carrinho', 'acessibilidade']);
  assert.deepEqual(P.padSkFilter(SK, 'repo', R1).map((s) => s.name), ['testes-carrinho']);
  assert.deepEqual(P.padSkFilter(SK, 'biblioteca', R1).map((s) => s.name), ['acessibilidade']);
  assert.deepEqual(P.padSkFilter(SK, 'comunidade', R1).map((s) => s.name), ['impeccable']);
  assert.equal(P.padSkFilter(SK, 'todas', R1).length, 3);
  assert.equal(P.padSkTitle('testes-carrinho'), 'Testes carrinho');
});

test('onde está ligada: um projeto por linha; a do repositório só liga no repo dela', () => {
  const w = P.padSkWhere(SK[1], [R1, R2], R1);
  assert.deepEqual(w.map((x) => [x.name, x.on, x.can, x.text]), [['loja-web', true, true, 'sempre em tarefas de código'], ['api-pagamentos', false, false, 'fica no repositório de loja-web']]);
  assert.equal(P.padSkWhere(SK[2], [R1, R2], R1)[0].text, 'ligada, só quando pedir');
  assert.equal(P.padQuandoLabel('todas'), 'sempre, em todas');
});

test('histórico com NOME de quem mexeu (sem nome vira "Você", nunca "alguém")', () => {
  assert.equal(P.padSkHistLine({ by: 'Diego Souza', action: 'desligou', skill: 'acessibilidade', repo: '/x/app-mobile' }), 'Diego Souza desligou Acessibilidade em app-mobile');
  assert.equal(P.padSkHistLine({ by: '', action: 'ligou', skill: 'impeccable', repo: R1 }), 'Você ligou Impeccable em loja-web');
  const now = new Date(2026, 9, 15, 12, 0).getTime();
  assert.equal(P.padWhen(new Date(2026, 9, 15, 10, 40).getTime(), now), 'hoje, 10:40');
  assert.equal(P.padWhen(new Date(2026, 9, 14, 9).getTime(), now), 'ontem');
  assert.equal(P.padWhen(new Date(2026, 9, 9, 9).getTime(), now), '09/10');
});

test('cartão do agente: contagens (nunca % abaixo de 10), revisor fala em revisões', () => {
  assert.equal(P.padAgStat(null, 'builder'), 'ainda medindo');
  assert.equal(P.padAgStat({ tasks: 6, knowing: true }, 'designer'), 'ainda conhecendo (6 tarefas)');
  assert.equal(P.padAgStat({ tasks: 12, n: 11, first: 9, knowing: false }, 'planner'), '9 de 11 planos aprovados de primeira');
  assert.equal(P.padAgStat({ tasks: 12, n: 12, first: 7, knowing: false, reviewed: 12, returned: 4 }, 'reviewer'), 'achou problema em 4 de 12 revisões');
});

test('desempenho por versão: agrupa pelo evento `papel`, uma linha por tarefa, mais nova primeiro', () => {
  const ver = (t) => { const m = /@v(\d+)/.exec(String(t)); return m ? +m[1] : null; };
  const rows = [
    { taskId: 'a', papel: 'skills ativas: nenhuma · nyx@v3 · claude', status: 'merged', muda: 1 },
    { taskId: 'a', papel: 'skills ativas: nenhuma · nyx@v3 · claude', status: 'merged', muda: 1 },
    { taskId: 'b', papel: 'skills ativas: nenhuma · nyx@v4 · claude', status: 'merged', reworks: 1 },
    { taskId: 'c', papel: 'ilegível', status: 'merged' },
  ];
  const per = P.padAgPerVersion(rows, ver, (r) => !(r.reworks > 0), () => true);
  assert.deepEqual(per.map((p) => [p.v, p.tasks, p.problems, p.rework]), [[4, 1, 0, 1], [3, 1, 1, 0]]);
});

test('memória: conflito = mesmo assunto com números diferentes (e só isso)', () => {
  const n = (slug, title, type = 'regra') => ({ scope: 'time', slug, title, type, by: 'Ana' });
  const c = P.padMemConflicts([n('a', 'Frete grátis a partir de R$ 150 no carrinho'), n('b', 'Frete grátis a partir de R$ 199 no carrinho', 'decisão'), n('c', 'Botão de pagar usa o verde'), n('d', 'Frete grátis a partir de R$ 199 no carrinho')]);
  assert.equal(c['time:a'].slug, 'b');
  assert.equal(c['time:b'].slug, 'a');
  assert.ok(!c['time:c'], 'sem número, sem conflito');
  assert.equal(Object.keys(P.padMemConflicts([n('b', 'Frete grátis R$ 199'), n('d', 'Frete grátis R$ 199')])).length, 0, 'mesmos números não conflitam');
});

test('memória: filtros do time, só minhas, arquivadas + busca sem acento', () => {
  const notes = [{ scope: 'time', title: 'Frete grátis', tags: [], body: '' }, { scope: 'local', title: 'Testes em português', tags: [], body: '' }];
  assert.equal(P.padMemFilter(notes, [], 'time', '').length, 1);
  assert.equal(P.padMemFilter(notes, [], 'eu', 'portugues').length, 1);
  assert.equal(P.padMemFilter(notes, [{ title: 'NATAL10 venceu', tags: [] }], 'arq', 'natal').length, 1);
  assert.equal(P.padMemFilter(notes, [], 'time', 'cupom').length, 0);
});

test('o que foi pro agente: skills pedidas na Nova demanda + as do evento papel, com versão', () => {
  const obj = P.padObjectiveWithSkills('Revisar o carrinho', ['impeccable']);
  assert.match(obj, /Skills pedidas: \/impeccable — use/);
  assert.equal(P.padObjectiveWithSkills(obj, ['impeccable', 'textos']).match(/Skills pedidas/g).length, 1, 'não duplica');
  const l = P.padSkillsOfTask(obj, [{ type: 'papel', text: 'skills ativas: testes-carrinho@v2, impeccable@v4 · iris@v5 · claude' }]);
  assert.deepEqual(l.map((x) => [x.name, x.version, x.why]), [['impeccable', null, 'pedida'], ['testes-carrinho', 2, 'ligada no projeto']]);
  assert.equal(P.padFirst('Revisa e melhora telas. Ideal para interface.'), 'Revisa e melhora telas');
});
