// Comando — poderes (89-comando-poderes): conversa em turnos, arquivos com diff, pronto pra aprovar, radar de conflito.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/89-comando.js'), PJ = read('js/89-comando-poderes.js'), WS = read('js/20-workspace-tarefa.js'), HTML = read('index.html'), CSS = read('css/99-comando.css');
const C = new Function(cut(JS, '// @comando-puro-inicio', '// @comando-puro-fim') + '\nreturn { cmdIntent, cmdSlash, cmdPlanParse, cmdPlanPrompt, CMD_ACOES, CMD_SEM_TAREFA, CMD_MUTA, CMD_SLASH, CMD_ACAO_TX };')();
const P = new Function(cut(PJ, '// @poderes-puro-inicio', '// @poderes-puro-fim') + '\nreturn { cmdRadarCalc, cmdFaixas, cmdTrechoBate, cmdRadarSit, cmdMediarPergunta, cmdGrupoLeitura };')();
// o MESMO leitor de diff do app (20-workspace-tarefa): o radar confere o trecho com ele
const diffHunks = new Function(cut(WS, 'function diffHunks(text){', '// renderer ÚNICO do diff') + '\nreturn diffHunks;')();
const T = [{ id:'a', code:'LW-47', title:'Avisos de estoque baixo' }, { id:'b', code:'LW-97', title:'Prévia do frete' }];

test('ações novas: arquivos (por tarefa), prontas e radar (sem tarefa) — por frase, por "/" e pelo plano da IA', () => {
  assert.deepEqual(C.cmdIntent('mostra os arquivos da LW-47', T, [], ''), { k:'arquivos', id:'a' });
  assert.deepEqual(C.cmdIntent('diff LW-97', T, [], ''), { k:'arquivos', id:'b' });
  assert.deepEqual(C.cmdIntent('o que foi feito na LW-47?', T, [], ''), { k:'feito', id:'a' }, '"o que foi feito" continua sendo o resumo');
  assert.equal(C.cmdIntent('O que está pronto pra aprovar?', T, [], '').k, 'prontas');
  assert.equal(C.cmdIntent('Alguém mexe no mesmo arquivo?', T, [], '').k, 'radar');
  assert.equal(C.cmdIntent('abre a tela de aprovar', T, [], '').k, 'tela', 'abrir a tela continua abrindo a tela');
  for (const a of ['arquivos', 'prontas', 'radar']) { assert.ok(C.CMD_ACOES[a], a); assert.ok(C.CMD_ACAO_TX[a], a + ' tem texto no plano'); assert.ok(!C.CMD_MUTA.has(a), a + ' só mostra: não pede confirmação'); }
  assert.ok(C.CMD_SEM_TAREFA.has('prontas') && C.CMD_SEM_TAREFA.has('radar') && !C.CMD_SEM_TAREFA.has('arquivos'));
  assert.deepEqual(C.cmdSlash('/diff @LW-47', [{ id:'a', ref:'LW-47', code:'LW-47', title:'x' }]).passos[0], { acao:'arquivos', tarefas:['LW-47'], texto:'', alvo:'' });
  assert.equal(C.cmdSlash('/conflitos', []).passos[0].acao, 'radar'); assert.equal(C.cmdSlash('/prontas', []).passos[0].acao, 'prontas');
  assert.equal(C.cmdPlanParse('{"fala":"","passos":[{"acao":"arquivos","tarefas":["LW-47"]},{"acao":"radar"}]}').passos.length, 2);
  const pr = C.cmdPlanPrompt({ refs:[], pedido:'x' });
  assert.match(pr, /- arquivos: /); assert.match(pr, /- radar: /); assert.match(pr, /VÁRIAS tarefas no mesmo passo vira uma conversa só/);
});

test('radar: quem mexe em quê — arquivo em comum vem primeiro; artefato da tarefa não conta', () => {
  const R = P.cmdRadarCalc([
    { id:'a', code:'LW-47', title:'A', files:[{ path:'src/money.ts', add:1, del:2 }, { path:'src/a.ts', add:9, del:0 }, { path:'.cardume/artifacts/a/print.png', add:0, del:0 }] },
    { id:'b', code:'LW-97', title:'B', files:[{ path:'src/money.ts', add:4, del:1 }, { path:'src/b.ts', add:1, del:0 }] },
    { id:'c', code:'LW-12', title:'C', files:[] }, null ]);
  assert.equal(R.nTar, 3); assert.equal(R.nArq, 3); assert.equal(R.conf.length, 1);
  assert.equal(R.rows[0].path, 'src/money.ts'); assert.deepEqual(R.rows[0].quem.map(q => q.code), ['LW-47', 'LW-97']);
  assert.deepEqual(R.rows.map(r => r.path), ['src/money.ts', 'src/a.ts', 'src/b.ts'], 'depois, do mais mexido pro menos');
  assert.equal(P.cmdRadarCalc([]).conf.length, 0);
});

test('radar: mesmo arquivo não é mesmo trecho — as faixas de linhas da base é que dizem', () => {
  const A = diffHunks('@@ -10,5 +10,5 @@ function toCents\n ctx\n ctx\n-  return Math.round(v*100)\n+  return Math.round(v*100+0.5)\n ctx\n ctx\n');
  const B = diffHunks('@@ -11,4 +11,5 @@\n ctx\n-  return Math.round(v*100)\n+  const c=v*100\n+  return Math.trunc(c)\n ctx\n ctx\n');
  const Longe = diffHunks('@@ -80,3 +80,4 @@\n ctx\n+export const X=1\n ctx\n ctx\n');
  assert.deepEqual(P.cmdFaixas(A), [[12, 12.5]]);
  assert.equal(P.cmdTrechoBate(A, B), true, 'as duas trocam a linha 12');
  assert.equal(P.cmdTrechoBate(A, Longe), false, 'linha 12 e linha 80: trechos diferentes');
  assert.equal(P.cmdTrechoBate(diffHunks('+novo\n+arquivo\n'), Longe), true, 'arquivo criado pelas duas = o arquivo inteiro');
  assert.equal(P.cmdTrechoBate({ hunks:[] }, A), false);
  assert.equal(P.cmdRadarSit(2, 'mesmo').k, 'hot'); assert.equal(P.cmdRadarSit(2, 'diferente').k, 'ok'); assert.equal(P.cmdRadarSit(2, '').k, 'chk'); assert.equal(P.cmdRadarSit(1, '').k, 'so');
});

test('conversa entre agentes: o Comando pergunta a um, leva a resposta ao outro e a pessoa confirma o combinado', () => {
  const o = [{ code:'LW-97', title:'B' }];
  assert.match(P.cmdMediarPergunta('src/money.ts', { code:'LW-47' }, o, 0, ''), /A LW-97 também alterou src\/money\.ts\. O que a sua tarefa mudou/);
  const q2 = P.cmdMediarPergunta('src/money.ts', { code:'LW-97' }, [{ code:'LW-47', title:'A' }], 1, 'arredondei\npra cima');
  assert.match(q2, /O porta-voz dela disse: «arredondei pra cima»\. Você concorda\?/); assert.ok(!/\n/.test(q2), 'uma linha só');
  const lei = P.cmdGrupoLeitura({ modo:'mediar', path:'src/money.ts', partes:[{ code:'LW-47', text:'fico com Math.round' }, { code:'LW-97', text:'' }] });
  assert.match(lei, /COMBINADO/); assert.match(lei, /passos "instruir", um por tarefa/); assert.match(lei, /- LW-97: \(sem resposta\)/); assert.match(lei, /Não use perguntar_agente/);
  assert.match(P.cmdGrupoLeitura({ modo:'varios', q:'está pronta?', partes:[{ code:'LW-47', text:'sim' }, { code:'LW-97', text:'não' }] }), /Você perguntou a 2 tarefas: «está pronta\?»/);
  const g = PJ.slice(PJ.indexOf('async function cmdPvCore'), PJ.indexOf('function cmdGrupoHtml'));
  assert.ok(/invoke\('comando_portavoz'/.test(g) && !/tiSend\(/.test(g), 'a conversa é com os PORTA-VOZES: nada é escrito no terminal de nenhum executor');
  assert.ok(/semPerguntar:true/.test(g) && /cmdPlanejar\(''/.test(g), 'no fim o Comando lê tudo e propõe; o que mexe numa tarefa passa pela confirmação do plano');
  assert.ok(/p\.acao==='perguntar_agente' && p\.alvos\.length>1/.test(JS) && /cmdGrupo\(\{ modo:'varios'/.test(JS), 'várias tarefas no mesmo passo = um cartão só');
});

test('a conversa aparece em turnos (no chat e ao lado) e continua no mesmo cartão', () => {
  assert.ok(/turns\|\|\(m\.turns=\[\]\)\)\.push\(\{ w:'cmd'/.test(JS) && /w:'ag', de:'porta-voz'/.test(JS) && /w:'ag', de:'executor'/.test(JS), 'cada pergunta e cada resposta é um turno');
  assert.ok(/\(o&&o\.thread\)\|\|\{ r:'bot', k:'pergunta'/.test(JS) && /if\(!\(o&&o\.thread\)\) ms\.push\(m\)/.test(JS), 'continuar não abre outro cartão');
  assert.ok(/data-cmdconv/.test(PJ) && /closest\('\[data-cmdconv\]'\)/.test(JS) && /cmdConvSec\(t\)/.test(JS), 'ao lado, a conversa da tarefa com o campo pra continuar');
  assert.ok(/\['cmdInst','cmdConv'\]/.test(JS), 'o que a pessoa está digitando ao lado não se perde quando o painel repinta');
  assert.ok(/\.cmdturn\.a\{background:var\(--term-bg\)/.test(CSS) && /\.cmdturn\.c\{background:var\(--surface-2\)/.test(CSS), 'agente em tinta de terminal, Comando na faixa clara');
});

test('arquivos e diff: os mesmos comandos e o mesmo renderer da Revisão; aprovar usa o painel de provas do app', () => {
  assert.ok(/invoke\('task_files',\{ taskId:id \}\)/.test(PJ) && /invoke\('file_diff',\{ taskId:id, path \}\)/.test(PJ) && /diffViewHtml\(diffHunks\(d\), \{\}\)/.test(PJ));
  assert.ok(/data-pre="\$\{escA\('No arquivo '\+f\.path\+': '\)\}"/.test(PJ) && /\(f\.dataset\.pre\|\|''\)\+v/.test(JS), 'a instrução dada no diff já diz de qual arquivo é');
  assert.ok(/proofPanel\(t\.id, 'compact'\)/.test(PJ) && /aprovarTarefa\(id\)/.test(PJ) && /apPedirAbrir\(id\)/.test(PJ) && /apFila\(\)/.test(PJ), 'aprovar, pedir alteração e desfazer são os do 80-aprovar');
  assert.ok(/v\.dec && v\.dec\.kind==='ok'/.test(PJ), 'o botão Aprovar do cartão só aparece quando não falta nada; senão, as provas decidem');
  assert.ok(HTML.indexOf('js/89-comando.js') < HTML.indexOf('js/89-comando-poderes.js') && HTML.indexOf('js/89-comando-poderes.js') < HTML.indexOf('js/99-e2e.js'));
  assert.ok(/\[data-cmdx\]/.test(JS) && /cmdPoder\(b\)/.test(JS) && /cmdSideExtra\(t\)/.test(JS));
});

test('caso real 12/11 (6): "faça as provas no 1228" virou instrução e NADA apareceu — instruir também abre a conversa com o executor', () => {
  const ins = JS.slice(JS.indexOf("case 'instruir':"), JS.indexOf("case 'parar':"));
  assert.ok(/cmdAcompanhar\(it\.id, it\.text, antes\)/.test(ins) && /const antes=\(await cmdHistFetch\(it\.id\)\)\.length/.test(ins), 'depois de enviar, o cartão da conversa abre e acompanha o terminal a partir daquele ponto');
  assert.ok(/cmdAcompanhar\(it\.id, 'Continue de onde parou\.', antes\)/.test(JS) && /cmdAcompanhar\(id, \(f\.dataset\.pre\|\|''\)\+v, antes\)/.test(JS), 'continuar e a instrução dada ao lado também');
  const ac = PJ.slice(PJ.indexOf('async function cmdAcompanhar'), PJ.indexOf('/** O porta-voz de UMA tarefa'));
  assert.ok(/modo:'instruir'/.test(ac) && /w:'ag', de:'executor'/.test(ac) && /cmdFalaUtil\(x\.text\)/.test(ac), 'cada fala útil do executor vira um turno');
  assert.ok(!/CMD\.asking=/.test(ac) && !/invoke\('comando_|project_chat/.test(ac), 'acompanhar não trava o Comando nem gasta IA: só lê o histórico do terminal');
  assert.ok(/cmdIsAsk\(cur\)/.test(ac) && /parou pra perguntar/.test(ac) && /segue trabalhando/.test(ac) && /terminou em/.test(ac), 'o fim diz o que aconteceu');
});
