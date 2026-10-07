// ATRAPALHA da TAREFA ABERTA (mesa-bugs-2 · trabalho, parte 2): terminal/doca, folha de pergunta, Entrega, aba PR,
// Prévia/ambiente e canvas dividido. Funções puras recortadas por marcador + a fiação conferida no código.
// `node --test app/tests/atrap-tarefa.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const term = read('js/60-terminal.js'), tl = read('js/60-terminal-layout.js'), canvas = read('js/58-canvas.js'), amb = read('js/58-ambiente.js'),
  rev = read('js/63-revisao-pr.js'), pr = read('js/21-pull-request.js'), en = read('js/27-entregas.js'), ws = read('js/20-workspace-tarefa.js'),
  tabs = read('js/15-config-abas-onboarding.js'), nav = read('js/57-navegador.js'), ti = read('js/64-terminal-integrado.js'),
  cvCss = read('css/92-canvas.css'), tCss = read('css/95-terminal.css');

test('abrir terminal que falha: o botão volta (não fica "abrindo…" desabilitado pra sempre)', () => {
  const fn = cut(term, 'async function termOpen(taskId){', '\n}\n');
  assert.match(fn, /const bTx=b\?b\.textContent:''/);
  assert.match(fn, /catch\(e\)\{[\s\S]*b\.disabled=false; b\.textContent=bTx;[\s\S]*st\.bar\.__html=''; termSetAlive\(taskId, false\)/);
});

test('xterm fora da tela é descartado: só os mais antigos, nunca a tarefa aberta nem quem está abrindo', () => {
  const T = new Function(cut(term, '// @term-sweep-puro-inicio', '// @term-sweep-puro-fim') + '\nreturn { TERM_KEEP, termDropIds };')();
  const L = (n) => Array.from({ length: n }, (_, i) => ({ id: 't' + i, on: false, used: i, busy: false }));
  assert.deepEqual(T.termDropIds(L(6), 6, null), [], 'até o limite: nada sai');
  assert.deepEqual(T.termDropIds(L(8), 6, null), ['t0', 't1'], 'os 2 mais antigos');
  assert.deepEqual(T.termDropIds(L(8), 6, 't0'), ['t1', 't2'], 'a tarefa aberta fica');
  const l = L(8); l[1].on = true; l[2].busy = true;
  assert.deepEqual(T.termDropIds(l, 6, null), ['t0', 't3'], 'na tela ou abrindo: fica');
  assert.equal(T.TERM_KEEP, 6);
  assert.match(term, /function termSweep\(\)\{[\s\S]*termDropIds\(list, TERM_KEEP[\s\S]*termDispose\(id\)/);
  assert.match(cut(term, 'function termDispose(taskId){', '\n}\n'), /st\.ro\.disconnect\(\)[\s\S]*st\.term\.dispose\(\)[\s\S]*delete TERM\[taskId\][\s\S]*delete TL\.sheets\[taskId\]/);
});

const TLP = new Function('esc', 'escA', cut(tl, '// @tl-puro-inicio', '// @tl-puro-fim') + '\nreturn { tlAskGroup, tlAskNew, tlAskResume };')(esc, esc);
const Q = (id, idx) => ({ id, taskId: 't1', kind: 'question', prompt: 'p' + id, options: ['a', 'b'], meta: { src: 'auq', group: 'g1', idx, n: 2 } });

test('folha de pergunta: envio que cai no meio NÃO some — fica com a que falta', () => {
  const g = TLP.tlAskGroup([Q(1, 0), Q(2, 1)]);
  const st = Object.assign(TLP.tlAskNew(g), { g, task: 't1' });
  const ask = { [g.key]: st };
  // 1ª resposta foi, a 2ª falhou: o snapshot só traz a #2 → o grupo "incompleto" sozinho daria null
  st.sent[1] = 1;
  assert.equal(TLP.tlAskGroup([Q(2, 1)]), null, 'sem o guardado, a folha sumiria');
  const r = TLP.tlAskResume(TLP.tlAskGroup([Q(2, 1)]), [Q(2, 1)], ask, 't1');
  assert.ok(r && r.st === st && r.g.rows.length === 2, 'continua com o grupo guardado (a #1 já marcada como enviada)');
  assert.equal(TLP.tlAskResume(null, [Q(2, 1)], ask, 't9'), null, 'outra tarefa: não');
  assert.equal(TLP.tlAskResume(null, [], ask, 't1'), null, 'pendência sumiu (respondida/expirada): some');
  st.sent = {}; assert.equal(TLP.tlAskResume(null, [Q(2, 1)], ask, 't1'), null, 'nada enviado ainda: regra normal');
  assert.match(tl, /function tlAskOf\(t\)\{[\s\S]*tlAskResume\(g, pend, TL\.ask, t\.id\)[\s\S]*st\.g=g; st\.task=t\.id;/);
});

test('pergunta nova não rouba o foco de quem está no terminal ("1"+Enter não responde sem querer)', () => {
  const paint = cut(tl, 'function tlAskPaint(t, focus, grab){', '\n}\n');
  assert.match(paint, /const idle=!ae \|\| ae===document\.body;/);
  assert.ok(!/TERM\[t\.id\]\.host\.contains\(ae\)/.test(paint), 'o xterm com foco não conta como "livre"');
});

test('aba PR: botões "atualizando…/enviando…" repintam mesmo com o HTML igual', () => {
  assert.match(rev, /function prvDirty\(\)\{ const p=document\.querySelector\('\.prv'\); if\(p && p\.parentElement\) p\.parentElement\.__prvHtml=''; \}/);
  const r = cut(rev, 'function prvRender(t, main, info){', '\nconst prvBodyOpen');
  assert.match(r, /prPgRefresh[\s\S]*finally\{ prvDirty\(\); renderWorkspace\(\); \}/);
  assert.match(r, /k==='checks'[\s\S]*prvDirty\(\); renderWorkspace\(\);/);
  assert.match(r, /\[data-prfix\][\s\S]*prvDirty\(\); renderWorkspace\(\);/);
  assert.match(cut(pr, 'function prRerender(taskId){', '\n}\n'), /prvDirty\(\)/, '"pedir correção" do review (prRerender) também');
});

test('Entrega: subir/pedir/encerrar repintam no fim (o botão não fica preso desabilitado)', () => {
  assert.match(en, /function enDirty\(\)\{ const p=document\.querySelector\('\.enpage'\); if\(p && p\.parentElement\) p\.parentElement\._enHtml=''; \}/);
  assert.match(en, /const back=\(\)=>\{ enDirty\(\); pvRerender\(t\.id\); \};/);
  assert.match(en, /bindClick\('enLiveUp',[^\n]*pvStartUp\(t\)[^\n]*\.finally\(back\)/);
  assert.match(en, /bindClick\('enLiveAsk',[^\n]*pvAskAgent\(t\)[^\n]*\.finally\(back\)/);
  assert.match(en, /bindClick\('enJustClose',[^\n]*enDirty\(\); renderWorkspace\(\); \}\);/);
  // jargão: "DOCS · REVISÃO", "exit code"
  assert.match(en, /EN_TYPE_TX\[taskType\(t\)\]\|\|'demanda'/); assert.ok(!/exit code/.test(en));
});

test('envio que falha na tarefa A não puxa o rascunho da tarefa B (campo da tela)', () => {
  const c = cut(ws, '// falhou: o texto e os anexos VOLTAM pro composer', "showErr(e, 'Não consegui enviar");
  assert.match(c, /const cur=String\(fwDraft\[t\.id\]\|\|''\)\.trim\(\)/);
  assert.ok(!/\$id\('fwInput'\)/.test(c), 'não lê o campo da tela');
});

test('duplo clique em "aprovar e abrir PR": uma preparação só', async () => {
  const src = cut(pr, '// duplo clique em "aprovar e abrir PR"', 'async function approveGateRun(t){');
  let runs = 0, release;
  const api = new Function('approveGateRun', src + '\nreturn { approveGate };')(() => { runs++; return new Promise((r) => { release = r; }); });
  const t = { id: 't1' };
  const a = api.approveGate(t); api.approveGate(t); api.approveGate(t);
  assert.equal(runs, 1, '2º e 3º cliques durante a 1ª: ignorados');
  release(); await a; api.approveGate(t); assert.equal(runs, 2, 'terminou: pode de novo');
  const open = cut(pr, 'function prPrepOpen(taskId, base){', '\n}\n');
  assert.match(open, /if\(prepRunning\.has\(taskId\)\)\{/); assert.match(open, /prepRunning\.add\(taskId\);[\s\S]*\.finally\(\(\)=>prepRunning\.delete\(taskId\)\)/);
});

test('canvas: o rascunho do painel volta pra janela principal ao desagrupar/fechar (e o painel começa com ele)', () => {
  const C = new Function(cut(canvas, '// @cv-rascunho-inicio', '// @cv-rascunho-fim') + '\nreturn { cvDraftMerge, cvAttsMerge };')();
  assert.equal(C.cvDraftMerge('', 'texto do painel'), 'texto do painel');
  assert.equal(C.cvDraftMerge('começo', 'começo e mais'), 'começo e mais', 'o painel continuou o rascunho herdado');
  assert.equal(C.cvDraftMerge('principal', ''), 'principal', 'painel vazio não apaga');
  assert.equal(C.cvDraftMerge('A', 'B'), 'A\nB', 'os dois diferentes: nada se perde');
  assert.equal(C.cvDraftMerge('abc mais', 'abc'), 'abc mais');
  assert.deepEqual(C.cvAttsMerge([{ p: 'a.png' }], [{ p: 'a.png' }, { p: 'b.png' }]), [{ p: 'a.png' }, { p: 'b.png' }]);
  assert.deepEqual(C.cvAttsMerge(undefined, []), []);
  assert.match(cut(canvas, 'function cvPaneDispose(id){', '\n}\n'), /w\.sfPaneDraftOut\(\)[\s\S]*fr\.src='about:blank'/, 'devolve ANTES de virar about:blank');
  assert.match(canvas, /window\.sfPaneDraftOut=\(\)=>\{[\s\S]*window\.parent\.cvDraftTake\(id, fwDraft\[id\]\|\|'', fwPend\[id\]\|\|\[\]\)/);
  assert.match(canvas, /window\.parent\.cvDraftGive && window\.parent\.cvDraftGive\(id\)/);
});

test('⌘W dentro do painel fecha o painel pela porta guardada — e a guarda olha a edição DO painel', () => {
  assert.match(tabs, /if\(typeof SF_PANE!=='undefined' && SF_PANE\)\{[\s\S]{0,300}k==='w'[\s\S]{0,200}window\.parent\.tabCloseGuarded\(id\)/);
  assert.match(cut(tabs, 'async function tabLeaveGuard(targetId, closing){', '\n}\n'), /cvPaneWin\(targetId\)[\s\S]*w\.sfPaneLeaveOk\(\)/);
  assert.match(canvas, /async function sfPaneLeaveOk\(\)\{ return \(typeof fwEditing!=='undefined' && fwEditing && typeof fwLeaveEditor==='function'\) \? await fwLeaveEditor\(\) : true; \}/);
});

test('"Subir ambiente": o supervisor que morre sem avisar falha diz que o site parou (não volta calado)', () => {
  const A = new Function('esc', 'escA', cut(amb, '// @amb-puro-inicio', '// @amb-puro-fim') + '\nreturn { envApply, envCardHtml };')(esc, esc);
  let v = A.envApply(null, { ev: 'step', step: 'detect' }); v = A.envApply(v, { ev: 'step', step: 'start' });
  const mid = A.envApply(v, { ev: 'end' });
  assert.equal(mid.fail && mid.fail.code, 'end'); assert.match(mid.fail.msg, /parou antes de responder/);
  assert.match(A.envCardHtml({ plan: { kind: 'script', web: true }, view: mid }), /role="alert"[\s\S]*parou antes de responder[\s\S]*tentar de novo/);
  const up = A.envApply(A.envApply(v, { ev: 'ready', url: 'http://127.0.0.1:1/' }), { ev: 'end' });
  assert.equal(up.fail.msg, 'O site parou.');
  const failed = A.envApply(A.envApply(v, { ev: 'fail', msg: 'X' }), { ev: 'end' });
  assert.equal(failed.fail.msg, 'X', 'a falha que o supervisor contou fica');
  const idle = A.envApply(null, { ev: 'end' });
  assert.equal(idle.fail, null); assert.deepEqual(idle.steps, [], 'nada rodando: nada a dizer');
  assert.match(amb, /p\.ev==='end' && \(!s\.view\.fail \|\| s\.view\.fail\.code==='end'\)/);
  assert.match(amb, /s\.log='Não consegui ler o registro do site: '\+/);
});

test('erros crus: prévia (navegador) e PR (stderr do gh) falam como gente; o original fica em "ver detalhes"', () => {
  assert.match(nav, /st\.err=\(typeof errShort==='function'\)\?errShort\(e\)/);
  const p = cut(ws, 'function fwRenderPrPage(t, main){', "  if(!info.exists){");
  assert.ok(!/esc\(det\.slice\(0,300\)\)/.test(p), 'o texto cru não vai pra tela');
  assert.match(p, /id="prPgErrDet">ver detalhes/); assert.match(p, /errDetails\(\{ msg:head, raw:String\(info\.error\) \}\)/);
});

test('cosméticos: tarefa na fila não mostra "parar"; doca sem alias cru; 3 painéis a 920 sem cortes', () => {
  assert.match(ws, /if\(fwIsWorking\(t\) && t\.status!=='queued'\) return \{ id:'fwStopTop'/);
  const L = new Function('TI_AIS', cut(ti, 'function tiAiLabel(ai, model){', '\n') + '\nreturn tiAiLabel;')([{ id: 'claude', short: 'Claude' }]);
  assert.equal(L('claude', 'opus'), 'Claude · Opus'); assert.equal(L('claude', 'claude-opus-5-5'), 'Claude · claude-opus-5-5'); assert.equal(L('claude', ''), 'Claude');
  assert.match(cvCss, /html\.sfpane \.appmain>\.bus\{display:none!important\}/);
  assert.match(cvCss, /html\.sfpane \.en-kpi span\{min-width:0\}/);
  assert.match(tCss, /\.tlsheethost\.tight \.tlsf\{flex-wrap:wrap;row-gap:4px\}/);
  assert.match(pr, /pill:\['falta prova','warn'\]/);
});
