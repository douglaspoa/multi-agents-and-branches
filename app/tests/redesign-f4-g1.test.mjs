// REDESENHO F4 · G1 (spec-redesign-f4-todas-as-telas; mocks _bmad-output/redesign/telas/g1-navegacao-projeto.html):
// helpers comuns (fmtUsdBr, "aguardando você" único, pageHead/pageTabs), a regra da Central (cancelada = encerrada,
// "concluída hoje" pela data de CONCLUSÃO, fila visível), as rotas das telas antigas pros lugares novos, o avatar,
// a página Projeto, a migração de preferências e os ganchos nos arquivos de sempre. `node --test app/tests/redesign-f4-g1.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escA = (s) => esc(s).replace(/"/g, '&quot;');

const util = read('js/00-util.js'), qf = read('js/22-quadro-fluxo.js'), abas = read('js/15-config-abas-onboarding.js');
const casca = read('js/68-casca-g1.js'), gr = read('js/25-grafo.js'), html = read('index.html');
const HELP = cut(util, '// @helpers-comuns-inicio', '// @helpers-comuns-fim');
const COST = cut(util, 'function usdBrlRate(){', '// faixa de estimativa');

// helpers com os globais mínimos (lsGet da cotação, IC só com as chaves usadas, escA do app)
const H = new Function('lsGet', 'IC', 'escA', COST + HELP + '\nreturn { fmtUsdBr, fmtCost, taskEncerrada, taskAguardaVoce, taskProntaRevisar, aguardandoVoceCount, prontasRevisarCount, pageHead, pageTabs, AGUARDA_ST };')(
  (k) => (k === 'usdBrl' ? '5' : null), { folder: '<svg>f</svg>', pc: '<svg>pc</svg>', team: '<svg>t</svg>', user: '<svg>u</svg>', dots: '<svg>d</svg>', plus: '<svg>+</svg>' }, escA);

// ---------------- dinheiro (D13) ----------------
test('fmtUsdBr: "US$ x (≈ R$ y)" com a MESMA cotação da barra de status; célula só em US$', () => {
  assert.equal(H.fmtUsdBr(1.79), 'US$ 1,79 (≈ R$ 8,95)');
  assert.equal(H.fmtUsdBr(2), 'US$ 2 (≈ R$ 10,00)');
  assert.equal(H.fmtUsdBr(1.79, { usdOnly: true }), 'US$ 1,79');
  assert.equal(H.fmtUsdBr(0), 'US$ 0 (≈ R$ 0)');
  assert.equal(H.fmtUsdBr(1.79), H.fmtCost(1.79), 'um formatador só (apelido do fmtCost)');
});

// ---------------- "aguardando você" único (D14) ----------------
const PEND = new Set(['ask']);
const pend = (t) => PEND.has(t.id);
const FIX = [
  { id: 'ask', status: 'running' }, { id: 'plan', status: 'plan-review' }, { id: 'need', status: 'needs-you' },
  { id: 'err', status: 'error' }, { id: 'conf', status: 'conflict' }, { id: 'abo', status: 'aborted' },
  { id: 'rev', status: 'review' }, { id: 'del', status: 'delivered' }, { id: 'pr', status: 'review', prUrl: 'https://x/pull/2' },
  { id: 'run', status: 'running' }, { id: 'draft', status: 'draft' }, { id: 'can', status: 'cancelled' },
  { id: 'closedErr', status: 'error', flag: 'closed' }, { id: 'merged', status: 'merged' }, { id: 'fila', status: 'backlog' },
];
test('aguardando você = pergunta + plano + precisa de você + erro/conflito/interrompida; pronta pra revisar À PARTE', () => {
  assert.equal(H.aguardandoVoceCount(FIX, pend), 6);
  assert.equal(H.prontasRevisarCount(FIX, pend), 2, 'review + delivered (PR aberto é outra etapa)');
  assert.equal(H.taskAguardaVoce({ id: 'can', status: 'cancelled' }, pend), false, 'cancelada é encerrada');
  assert.equal(H.taskAguardaVoce({ id: 'closedErr', status: 'error', flag: 'closed' }, pend), false, 'encerrada não espera ninguém');
  assert.equal(H.taskAguardaVoce({ id: 'ask', status: 'draft' }, pend), false, 'rascunho nunca');
  assert.equal(H.taskProntaRevisar({ id: 'ask', status: 'review' }, pend), false, 'pergunta aberta vence: conta só em aguardando');
  for (const s of ['cancelled', 'merged', 'done']) assert.equal(H.taskEncerrada({ status: s }), true, s);
  assert.equal(H.taskEncerrada({ status: 'review', flag: 'closed' }), true);
  assert.equal(H.taskEncerrada({ status: 'running' }), false);
});

// a flowBucket DE VERDADE (22) com os helpers — a fixture prova que lateral, Central e o helper dão o MESMO número
const QB = new Function('pendingOf', 'taskTs', 'taskDoneTs', HELP + cut(qf, 'function flowBucket(t){', '\n// status EFETIVO') +
  cut(qf, 'function flowCounts(tasks){', 'const FLOW_SECS') + '\nreturn { flowBucket, flowCounts };')(
  (id) => (PEND.has(id) ? [1] : []), (t) => t.createdAt || 0, (t) => t.finishedAt || t.createdAt || 0);
const RL = new Function(cut(gr, '// @rail-mesa-inicio', '// @rail-mesa-fim') + '\nreturn { railCounts };')();
test('fixture: lateral (railCounts), Central (flowCounts) e o helper contam o MESMO "aguardando você" (Júlia, D14)', () => {
  const live = FIX.filter((t) => !H.taskEncerrada(t));
  const fc = QB.flowCounts(live), rc = RL.railCounts(live, QB.flowBucket);
  const pendOf = (t) => PEND.has(t.id);
  assert.equal(fc.aguardando, 6); assert.equal(rc.voce, 6); assert.equal(H.aguardandoVoceCount(live, pendOf), 6);
  assert.equal(fc.prontas, 2); assert.equal(rc.revisar, 2); assert.equal(H.prontasRevisarCount(live, pendOf), 2);
  assert.equal(fc.fila, 1, 'a fila é uma etapa contada (e agora visível)');
});
test('Central (inventário 01): cancelada vai pra Concluídas; "concluída hoje" usa a data de CONCLUSÃO; fila tem seção', () => {
  const now = Date.now(), old = now - 5 * 864e5;
  assert.equal(QB.flowBucket({ id: 'c', status: 'cancelled', createdAt: old, finishedAt: now }), 'hoje', 'cancelada encerrada hoje');
  assert.equal(QB.flowBucket({ id: 'm', status: 'merged', createdAt: old, finishedAt: now }), 'hoje', 'criada há 5 dias, concluída hoje = hoje');
  assert.equal(QB.flowBucket({ id: 'm2', status: 'merged', createdAt: now, finishedAt: old }), 'anteriores', 'criada hoje, concluída antes = anteriores');
  assert.equal(QB.flowBucket({ id: 'f', status: 'requested' }), 'fila');
  assert.match(qf, /\['fila','Na fila','',''\]/, 'seção "Na fila" na lista');
  assert.match(qf, /const FLOW_EXEC_KEYS=\['aguardando','andamento','prontas','praberto','rascunho','fila'\];/, 'chip "Na fila"');
  assert.match(qf, /function taskDoneTs\(t\)\{[\s\S]*ms\(t\.finishedAt\)\|\|ms\(t\.finished_at\)\|\|ms\(t\.updated_at\)\|\|taskTs\(t\)/);
  assert.match(qf, /const tsOf = flowScope==='done' \? taskDoneTs : taskTs;/, 'Concluídas ordena pela conclusão');
  assert.match(qf, /ts=taskEncerrada\(t\)\?taskDoneTs\(t\):taskTs\(t\); \/\/ concluída: pela data de conclusão/, 'filtro de período idem');
  assert.match(read('js/23-kanban-artefatos-editor.js'), /\['fila','Na fila'\]/, 'Kanban com a coluna da fila');
  // o Rust manda a data de conclusão (último evento) no snapshot e na lista de todos os projetos
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.equal((rs.match(/finished_at_sql\(task_has_col\(&conn, "closed_at"\)\)/g) || []).length, 2, 'snapshot e lista de todos os projetos');
  assert.match(rs, /if f\.as_deref\(\) == Some\("closed"\) \{ task_mark_closed\(&conn, &task_id, true, now_ms\(\)\); \}/, 'encerrar à mão grava a data (teste Rust: finished_at_tests)');
  assert.equal((rs.match(/finished_at: r\.get::<_, Option<i64>>\((17|9)\)\.unwrap_or\(None\)\.unwrap_or\(0\)/g) || []).length, 2);
});

// ---------------- padrão de página (D25) ----------------
test('pageHead: título · selo de escopo · resumo · 1 primária · ⋯ · subtítulo · abas; sem X nem "fechar esc"', () => {
  const h = H.pageHead({ title: 'Projeto · <x>', scope: 'projeto', scopeLabel: 'logcomex', sum: '<b>2</b> aguardando você', sub: 'O que "os" agentes', primary: { id: 'pp', label: 'Novo', icon: 'plus' }, more: { id: 'mm' }, tabs: '<div class="pgtabs"></div>' });
  assert.match(h, /^<header class="pghead"><div class="pgh-t"><h1 class="pgh-title">Projeto · &lt;x&gt;<\/h1>/);
  assert.match(h, /<span class="pgh-scope" title="Pra quem vale o que está nesta página"><svg>f<\/svg>Este projeto · logcomex<\/span>/);
  assert.match(h, /<span class="pgh-sum"><b>2<\/b> aguardando você<\/span>/);
  assert.match(h, /<button class="btn primary pgh-primary" id="pp"><svg>\+<\/svg>Novo<\/button>/);
  assert.match(h, /<button class="btn icon quiet pgh-more" id="mm" title="Mais ações" aria-label="Mais ações" aria-haspopup="menu"><svg>d<\/svg><\/button>/);
  assert.match(h, /<p class="pgh-sub">O que &quot;os&quot; agentes<\/p><div class="pgtabs"><\/div><\/header>$/);
  assert.ok(!/fechar|esc<|kbd/.test(h));
  assert.match(H.pageHead({ title: 'Central', scope: 'computador' }), /<svg>pc<\/svg>Este computador</);
  assert.match(H.pageHead({ title: 'Time', scope: 'time', scopeLabel: 'Foundations' }), /<svg>t<\/svg>Time · Foundations</);
  assert.match(H.pageHead({ title: 'X', scope: 'Organização Logcomex', scopeIcon: 'team' }), /<svg>t<\/svg>Organização Logcomex</);
  assert.ok(!/pgh-scope|pgh-primary|pgh-more|pgh-sub/.test(H.pageHead({ title: 'Só título' })));
});
test('pageTabs: role=tablist, só a ativa no Tab, contagem e "quente"', () => {
  const t = H.pageTabs('mv', [['a', 'Notas', 24], ['b', 'Grafo'], ['c', 'Pra revisar', 3, true]], 'c');
  assert.match(t, /^<div class="pgtabs" role="tablist" data-pgtabs="mv">/);
  assert.match(t, /aria-selected="false" tabindex="-1" data-pgtab="mv:a">Notas <b>24<\/b><\/button>/);
  assert.match(t, /data-pgtab="mv:b">Grafo<\/button>/);
  assert.match(t, /class="on hot" aria-selected="true" tabindex="0" data-pgtab="mv:c">Pra revisar <b>3<\/b>/);
});

// ---------------- rotas: tela antiga → lugar novo ----------------
const RT = new Function(cut(abas, '// @puro-rotas-inicio', '// @puro-rotas-fim') + '\nreturn { viewRoute, VIEW_ROUTES };')();
test('rotas: Chat/Memória/Meu time/Skills/Preferências → Projeto; Daily → Central › Resumo; Nova issue → Issues; Time → página', () => {
  const r = (k, o) => { const x = RT.viewRoute(k, o); return [x.kind, x.opts.sub || null]; };
  assert.deepEqual(r('chat'), ['projeto', 'conversa']);
  assert.deepEqual(r('memoria'), ['projeto', 'memoria']);
  assert.deepEqual(r('agents'), ['projeto', 'agentes']);
  assert.deepEqual(r('skills'), ['projeto', 'skills']);
  assert.deepEqual(r('prefs'), ['projeto', 'regras']);
  assert.deepEqual(r('daily'), ['flow', 'resumo']);
  assert.deepEqual(r('issuesbulk'), ['issues', 'nova']);
  assert.deepEqual(r('team'), ['time', null]);
  assert.deepEqual(r('memoria', { sub: 'revisar' }), ['projeto', 'revisar'], 'quem pede seção mantém a dela');
  assert.deepEqual(r('fabrica'), ['fabrica', null], 'o resto passa direto');
  assert.deepEqual(r('task', { x: 1 }), ['task', null]);
  assert.match(abas, /function openTab\(kind, opts\)\{\n  \{ const r=viewRoute\(kind, opts\); kind=r\.kind; opts=r\.opts; if\(r\.from && opts\.from==null\) opts\.from=r\.from; \}/, 'de onde veio segue junto (mesas → Sessões filtrada)');
  assert.match(abas, /if\(k==='j' && !e\.shiftKey\)\{ e\.preventDefault\(\); openTab\('projeto',\{ sub:'conversa' \}\); \}/, '⌘J = Projeto › Conversa');
  assert.match(abas, /if\(k===',' && !e\.shiftKey\)\{ e\.preventDefault\(\); if\(typeof ajustesOpen==='function'\) ajustesOpen\(\); else openTab\('cfg'\); \}/);
  assert.match(abas, /if\(o && tgtEl && tgtEl!==o && tgtEl\.contains\(o\)\) return;/, 'a seção dentro da página Projeto não some ao trocar de aba');
});

// ---------------- avatar (D6) ----------------
const AV = new Function(cut(casca, '// @puro-avatar-inicio', '// @puro-avatar-fim') + '\nreturn { meInfoOf, meMenuItemsOf };')();
test('avatar: nome, iniciais e "Organização · Time"; sem org o menu oferece criar/entrar num time; único "Sair"', () => {
  const sess = { user: { id: 'u1', email: 'douglas@x.com', user_metadata: { name: 'Douglas Sobreira' } } };
  const data = { org: { name: 'Logcomex' }, teams: [{ id: 't1', name: 'Foundations' }], profileByUser: {} };
  const i = AV.meInfoOf(sess, data, 't1');
  assert.equal(i.name, 'Douglas Sobreira'); assert.equal(i.ini, 'DS'); assert.equal(i.sub, 'Logcomex · Time Foundations');
  const keys = (x, o) => AV.meMenuItemsOf(x, o).map((it) => it.k);
  assert.deepEqual(keys(i), ['conta', 'ajustes', 'uso', 'atalhos', 'primeiros', 'tema', 'sair']);
  const solo = AV.meInfoOf(sess, { org: null }, null);
  assert.equal(solo.sub, 'sem organização'); assert.equal(solo.org, null);
  assert.deepEqual(keys(solo), ['conta', 'times', 'ajustes', 'uso', 'atalhos', 'primeiros', 'tema', 'sair']);
  const anon = AV.meInfoOf(null);
  assert.equal(anon.name, 'Entrar'); assert.deepEqual(keys(anon), ['entrar', 'ajustes', 'uso', 'atalhos', 'primeiros', 'tema']);
  assert.ok(keys(i, { pubRel: true }).includes('pubrel'), 'publicar release só pra dev/admin');
  assert.equal(AV.meMenuItemsOf(i).find((x) => x.k === 'ajustes').hint, '⌘,');
  assert.equal(AV.meMenuItemsOf(i).find((x) => x.k === 'atalhos').hint, '?');
  // ganchos do G3 sempre guardados
  assert.match(casca, /function g1Ajustes\(section\)\{ if\(typeof ajustesOpen==='function'\) return ajustesOpen\(section\);/);
  assert.match(casca, /function g1PrimeirosPassos\(\)\{ if\(typeof primeirosPassosOpen==='function'\) return primeirosPassosOpen\(\);/);
  assert.match(casca, /const t=\$id\('timeBtn'\); if\(t\)\{ const on=!!i\.org;/, 'Time na lateral só com organização');
});

// ---------------- página Projeto ----------------
const PJ = new Function(cut(casca, '// @puro-projeto-inicio', '// @puro-projeto-fim') + '\nreturn { PROJ_SECS, PROJ_OV, projSubNorm };')();
test('Projeto: sub-nav Conversa · Linha · Memória · Agentes · Skills · Regras · Espaço em disco; seção inválida cai na Conversa', () => {
  assert.deepEqual(PJ.PROJ_SECS.map((x) => x[1]), ['Conversa', 'Linha', 'Memória', 'Agentes', 'Skills', 'Regras', 'Espaço em disco']);
  assert.deepEqual(PJ.PROJ_OV, { conversa: 'pcOverlay', linha: null, memoria: 'memOverlay', agentes: 'agOverlay', skills: 'skOverlay', regras: 'prefsOverlay', disco: null });
  assert.equal(PJ.projSubNorm('regras'), 'regras'); assert.equal(PJ.projSubNorm('xx'), 'conversa'); assert.equal(PJ.projSubNorm(null), 'conversa');
  assert.match(casca, /title:'Esta página é de um projeto\.'/, 'sem projeto: estado padrão, nunca aba vazia (inventário 13)');
  assert.match(html, /<div class="overlay fwoverlay pgov" id="projOverlay"[^>]*><div class="pgpage" id="projPage"><div id="projHead"><\/div><div class="pgsplit"><nav class="subnav" id="projNav" role="tablist"/);
});

// ---------------- migração de preferências ----------------
const MG = new Function(cut(util, '// @puro-migra-inicio', '// @puro-migra-fim') + '\nreturn g1MigratePrefs;')();
test('migração (00-util, roda antes de quem lê): grade → lista, escopo "Time" → Em andamento; Atividade (feed) continua; valor antigo guardado; uma vez só', () => {
  const ls = { flowView: 'grid', flowScope: 'team', tmView: 'feed', outra: 'x' };
  const get = (k) => (k in ls ? ls[k] : null), set = (k, v) => { ls[k] = v; };
  assert.deepEqual(MG(get, set), ['flowView', 'flowScope']);
  assert.equal(ls.flowView, 'table'); assert.equal(ls['flowView:f4'], 'grid');
  assert.equal(ls.flowScope, 'exec'); assert.equal(ls['flowScope:f4'], 'team');
  assert.equal(ls.tmView, 'feed', 'Atividade é vista válida'); assert.equal(ls.outra, 'x');
  const l2 = { tmView: 'grafo' }; MG((k) => (k in l2 ? l2[k] : null), (k, v) => { l2[k] = v; }); assert.equal(l2.tmView, 'overview');
  ls.flowView = 'grid'; assert.deepEqual(MG(get, set), [], 'já migrado: não mexe de novo');
  assert.ok(util.indexOf('try{ g1MigratePrefs(lsGet, lsSet); }catch(_){ }') > 0 && util.indexOf('g1MigratePrefs(lsGet') < util.indexOf('function fmtCost'), 'roda na carga do 00-util');
  assert.ok(!/g1MigratePrefs\(get, set\)/.test(casca), 'uma definição só');
});

// ---------------- ganchos estruturais ----------------
test('Esc NUNCA fecha uma aba (D24): tarefa, Nova demanda, épico e tarefa do colega; ⌘W continua fechando', () => {
  assert.ok(!/nvEscape\(fwTask\)\) return;\n  closeWorkspace\(\);/.test(read('js/20-workspace-tarefa.js')));
  assert.match(read('js/32-planner.js'), /!\$id\('plannerOverlay'\)\.classList\.contains\('astab'\)&&!escBusy\(e\)\) closePlanner\(\);/);
  assert.ok(!/closeTabOfKind\('epic'\); \}\n\}, true\);/.test(read('js/46-epico-time.js')));
  assert.ok(!/closeTabOfKind\('cttask'\);\n\}, true\);/.test(read('js/45-entrega-time.js')));
  assert.match(abas, /else if\(k==='w' && !e\.shiftKey\)\{ if\(!tabCloseKey\(e, osKind\(\)\)\) return; e\.preventDefault\(\);/);
});
test('"+" das abas: Criar (Nova demanda · Novo projeto… → Fábrica) e Abrir (demanda · Conversa do projeto ⌘J · Navegador · Simulador · Documento); "Ideia nova" saiu', () => {
  const cv = read('js/58-canvas.js'); const plus = cut(cv, 'function cvPlusMenu(anchor, opts){', 'm.innerHTML=');
  assert.ok(!/k:'ideia'/.test(plus));
  assert.match(plus, /k:'nova', label:'Nova demanda', hint:'⌘N'[^\n]*grp:'Criar'/);
  assert.match(plus, /k:'novoproj', label:'Novo projeto…', hint:'Fábrica'/);
  assert.match(plus, /k:'conversa', label:'Conversa do projeto', hint:'⌘J'/);
  assert.match(cv, /if\(x\.k==='novoproj'\)\{ cvCloseMenu\(\); if\(typeof g1NovoProjeto==='function'\) g1NovoProjeto\(\);/);
});
test('Regras (inventário 13): checagens e proteção SEM conta; documento com altura de documento; salvar não fecha a aba', () => {
  const p = read('js/12-chat-prefs-daily.js'); const op = cut(p, 'async function openPrefs(){', '\n}\n');
  assert.ok(op.indexOf('prefsChecksRender()') < op.indexOf('const cloudOk='), 'checagens antes de olhar a nuvem');
  assert.ok(op.indexOf("ovShow(ov)") < op.indexOf("if(!repoPath) return;"), 'sem projeto a seção aparece (nunca aba em branco)');
  assert.ok(!/ovHide/.test(cut(p, "$id('prefsSave').onclick=async()=>{", '\n};\n')), 'salvar pro time não fecha');
  assert.match(read('css/99-paginas.css'), /#prefsOverlay \.cearea,#prefsText\{min-height:300px\}/);
  assert.match(html, /<section class="rsec"><div class="rsec-h"><h4>Checagens antes de aprovar<\/h4><span class="pgh-scope">Este projeto<\/span>/);
  assert.ok(!/id="prefsMemMode"/.test(html), 'o seletor de memória saiu (mora só na Memória)');
});
test('Issues: abas Quadro · Nova issue · Conexão; endereço base das issues na Conexão; lista ou colunas', () => {
  const i = read('js/14-issues-projeto.js');
  assert.match(i, /tabs:pageTabs\('trk', \[\['board','Quadro',ready\?trkIssues\.length:null\],\['nova','Nova issue'\],\['conn','Conexão'\]\], trkView\)/);
  assert.match(i, /function trkNIOpen\(\)\{ trkView='nova'; trkSel=null; if\(window\.openTab\) window\.openTab\('issues',\{ sub:'nova' \}\); \}/);
  assert.match(i, /id="trkIssueBase" value="\$\{escA\(lsGet\('issueBase'\)\|\|''\)\}"/);
  assert.match(i, /function trkListHtml\(items\)\{/);
  assert.match(i, /let trkLayout=lsGet\('trkLayout'\)==='colunas'\?'colunas':'lista';/);
});
test('Memória é a dona única de aprendizados, curador e "o que cada agente lembra" (D16); ficha = Histórico · Desempenho · Editar', () => {
  const m = read('js/37-memoria.js'), a = read('js/61-meu-time.js');
  assert.match(m, /pageTabs\('mview', \[\['lista','Notas',MEM\.notes\.length\],\['grafo','Grafo'\],\['revisar','Pra revisar',nRev\|\|null,nRev>0\]\], MEM\.view\)/);
  assert.match(m, /typeof agMemHostRender==='function'\) agMemHostRender\(\$id\('memAgHost'\)\)/);
  assert.match(m, /const MEM_TYPE_PT=\{ gotcha:'armadilha' \};/);
  assert.match(a, /const TABS=\[\['historico','Histórico'[^\]]*\],\['desempenho','Desempenho'\],\['editar','Editar'\]\];/);
  assert.match(html, /No terminal, vale o perfil, as skills e a memória do agente que constrói\.<\/b> A sequência da equipe \(revisor, rodadas\) roda no modo automático\./);
});
test('99-paginas.css: só tokens do tema (nenhuma cor literal), registrado depois das fatias antigas; 68-casca-g1 carrega por último', () => {
  const css = read('css/99-paginas.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(css), 'sem cor literal');
  assert.match(html, /<link rel="stylesheet" href="css\/98-fabrica\.css">\n<link rel="stylesheet" href="css\/99-paginas\.css">/);
  assert.match(html, /<script src="js\/68-casca-g1\.js"><\/script>\n<script src="js\/69-linha\.js"><\/script>\n<\/body>/, 'depois da casca só a Linha (69), que não reescreve nada da casca');
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(casca), 'sem cor fixa no JS da casca');
});

// ---------------- revisão F4 (correções) ----------------
test('Projeto: voltar pra aba mostra a seção de novo (KEEP_ON_SWITCH não chama viewOpen) e o ⋯ da página tem id próprio', () => {
  assert.match(casca, /showActiveView=function\(\)\{ const r=sa\.apply\(this, arguments\);\n\s*try\{ const t=tabById\(activeTab\); if\(t && t\.kind==='projeto' && t\.loaded\) projShowSub\(projSub\);/);
  assert.match(casca, /more:\{ id:'projPageMore'/); assert.match(casca, /head\.querySelector\('#projPageMore'\)/);
  assert.ok(!/projMoreBtn/.test(casca), 'o id projMoreBtn é só da página Projetos');
  assert.equal((read('js/13-skills-projetos.js').match(/projMoreBtn/g) || []).length, 2);
  assert.match(casca, /if\(head\.__html===hh && nav\.__html===nh\) return;/, 'contagens vivas sem trocar o DOM à toa');
  assert.match(casca, /if\(g1TabOn\('projeto'\)\)\{ const ch=projRepoShown!==\(state\.repo\|\|''\); projPageRender\(\);/);
});
test('Regras/Agentes: rascunho não some (trocar de seção, fechar a aba, reabrir) e as convenções gravam no projeto CARREGADO', () => {
  const p = read('js/12-chat-prefs-daily.js');
  assert.match(p, /function prefsDirty\(\)\{ const ta=\$id\('prefsText'\); return !!\(prefsK && ta && ta\.value!==prefsLoaded\); \}/);
  assert.match(p, /if\(prefsDirty\(\) && prefsK\.path===repoPath\)\{ ovShow\(ov\); prefsBarSync\(\); return; \}/, 'reabrir mantém o rascunho');
  assert.match(p, /prefsK=k\?Object\.assign\(\{ path:repoPath \}, k\):null;/, 'chave presa ao projeto carregado');
  assert.match(cut(p, "$id('prefsSave').onclick=async()=>{", '\n};\n'), /const k=prefsK; if\(!k\) return;/, 'salvar não recalcula pro projeto aberto agora');
  assert.match(casca, /async function g1ProjLeaveOk\(to\)\{[\s\S]*agDirty\(\)[\s\S]*prefsDirty\(\)/);
  assert.match(casca, /async function projGo\(sub\)\{ sub=projSubNorm\(sub\); if\(g1TabOn\('projeto'\) && !await g1ProjLeaveOk\(sub\)\) return;/);
  assert.match(abas, /if\(kind==='projeto' && typeof g1ProjLeaveOk==='function' && !closeTab\.__projOk\)\{ g1ProjLeaveOk\(null\)/, 'fechar a aba Projeto pergunta');
  assert.match(casca, /const keep=\(sub==='agentes' && typeof agDirty==='function' && agDirty\(\)\);/, 'voltar pra Agentes não relê por cima do rascunho');
  assert.match(casca, /closeAgents=function\(\)\{ const o=\$id\('agOverlay'\); if\(o && o\.classList\.contains\('inproj'\)\)\{ agBase='';/);
});
test('padrão de página: attrs viram pares escapados; pageTabs escapa sem depender do escA', () => {
  const h = H.pageHead({ title: 'X', primary: { label: 'Ir', attrs: { 'data-to': 'a"b', 'on click': 'x' } } });
  assert.match(h, / data-to="a&quot;b">Ir<\/button>/); assert.ok(!/on click/.test(h), 'nome inválido some');
  assert.match(H.pageTabs('s', [['k', '<b>']], 'k'), /&lt;b&gt;/);
});
