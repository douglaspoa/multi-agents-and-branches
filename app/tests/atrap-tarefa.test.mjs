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
  assert.match(fn, /return termResume\(taskId, \{ quiet:!fresh, btn:b \}\)/);
  const rs = cut(term, 'async function termResume(taskId, o){', '\n}\n');
  assert.match(rs, /const bTx=b\?b\.textContent:''/);
  assert.match(rs, /catch\(e\)\{[\s\S]*b\.disabled=false; b\.textContent=bTx;[\s\S]*st\.bar\.__html=''; termSetAlive\(taskId, false\)/);
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
  const B = new Function(cut(term, '// @term-sweep-puro-inicio', '// @term-sweep-puro-fim') + '\nreturn termBusy;')();
  assert.equal(B({ pend: [] }), true, 'attach em voo (retrato chegando) conta como ocupado'); assert.equal(B({ pend: null }), false);
  assert.equal(B({ opening: true }), true); assert.equal(B({ hloading: true }), true); assert.equal(B({}), false);
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

test('pergunta nova não rouba o foco de quem está no terminal — nem depois do renderWorkspace (foco caiu no body)', () => {
  const F = new Function('esc', 'escA', cut(tl, '// @tl-puro-inicio', '// @tl-puro-fim') + '\nreturn tlAskTakesFocus;')(esc, esc);
  const base = { hadFocus: false, focus: false, fresh: true, min: false };
  assert.equal(F({ ...base, termFocus: true, onBody: true }), false, 'xterm tinha o foco antes do render (agora no body): a folha NÃO pega');
  assert.equal(F({ ...base, termFocus: true, onBody: false }), false, 'foco ainda no xterm: não pega');
  assert.equal(F({ ...base, termFocus: false, onBody: true }), true, 'ninguém digitando: a pergunta nova pega o foco');
  assert.equal(F({ ...base, termFocus: false, onBody: false }), false, 'digitando noutro campo: não pega');
  assert.equal(F({ ...base, fresh: false, termFocus: false, onBody: true }), false, 'repinta da mesma folha: não rouba');
  assert.equal(F({ ...base, termFocus: true, onBody: true, focus: true }), true, 'pedido explícito (responder/abrir a folha): pega');
  assert.equal(F({ ...base, termFocus: true, onBody: true, hadFocus: true }), true, 'quem já estava na folha continua nela');
  // o caminho do render passa o "terminal tinha o foco" até a folha (e o 20 devolve o foco ao xterm depois)
  assert.match(ws, /tlWire\(t, sheetGrab, termHadFocus\); if\(termHadFocus && !chat\.querySelector\('\.tlsheet:focus-within'\)\) setTimeout\(\(\)=>tlFocusTerm\(t\.id\), 0\)/);
  assert.match(tl, /function tlWire\(t, grab, termFocus\)\{[\s\S]*tlAskPaint\(t, false, grab, termFocus\)/);
  assert.match(cut(tl, 'function tlAskPaint(t, focus, grab, termFocus){', '\n}\n'), /tlAskTakesFocus\(\{ hadFocus, focus, fresh, min:a\.st\.min, termFocus:tf, onBody:/);
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

test('xterm descartado enquanto o attach voava: o PTY é solto de novo (contador de quem assiste não fica >0)', async () => {
  const fn = cut(term, 'async function termAttach(taskId){', '\n}\n') + '\n}';
  const calls = []; const TERM = {};
  const st = { term: {}, attached: false };
  TERM.t1 = st;
  const invokeQuiet = async (c, a) => { calls.push(c); if (c === 'term_attach') { delete TERM.t1; return { alive: true, data: 'x' }; } return null; };
  const termAttach = new Function('TERM', 'invokeQuiet', 'termSetAlive', 'termHistLoad', fn + '\nreturn termAttach;')(TERM, invokeQuiet, () => { throw new Error('não devia pintar'); }, () => { throw new Error('não devia ler'); });
  await termAttach('t1'); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['term_attach', 'term_detach']);
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

test('canvas: o rascunho MUDA de dono — o painel leva, devolve ao sair; nada ressuscita nem duplica', () => {
  const src = cut(canvas, '// @cv-rascunho-inicio', '// --- lado do PAINEL');
  const world = () => new Function('W', 'let fwTask=W.cur; const fwDraft=W.d, fwPend=W.p; const $id=()=>W.input;\n' + src + '\nreturn { cvDraftGive, cvDraftTake };');
  const mk = (d, p, input) => { const W = { d, p, input, cur: 't1' }; return { W, ...world()(W) }; };
  // herda "A" → a principal fica sem; o painel envia (campo vazio) e fecha → nada volta (sem reenvio)
  { const { W, cvDraftGive, cvDraftTake } = mk({ t1: 'A' }, { t1: [{ p: 'x.png' }] }, { dataset: { tk: 't1' }, value: 'A' });
    const g = cvDraftGive('t1');
    assert.deepEqual(g, { text: 'A', atts: [{ p: 'x.png' }] });
    assert.equal(W.d.t1, '', 'a principal não guarda cópia'); assert.equal(W.p.t1, undefined); assert.equal(W.input.value, '', 'nem no campo montado');
    cvDraftTake('t1', '', []);
    assert.equal(W.d.t1, '', 'mensagem enviada pelo painel não volta ao compositor'); assert.equal(W.p.t1, undefined, 'anexos enviados não voltam'); }
  // apagou "A" e escreveu "B" no painel → "B" (não "A\nB"); apagou tudo → vazio (não ressuscita)
  { const { W, cvDraftGive, cvDraftTake } = mk({ t1: 'A' }, {}, null); cvDraftGive('t1'); cvDraftTake('t1', 'B', []); assert.equal(W.d.t1, 'B'); }
  { const { W, cvDraftGive, cvDraftTake } = mk({ t1: 'A' }, {}, null); cvDraftGive('t1'); cvDraftTake('t1', '   ', []); assert.equal(W.d.t1, ''); }
  // a principal ganhou texto NOVO depois de entregar → os dois ficam
  { const { W, cvDraftGive, cvDraftTake } = mk({ t1: 'A' }, {}, null); cvDraftGive('t1'); W.d.t1 = 'C'; W.p.t1 = [{ p: 'c.png' }];
    cvDraftTake('t1', 'B', [{ p: 'c.png' }, { p: 'b.png' }]); assert.equal(W.d.t1, 'C\nB'); assert.deepEqual(W.p.t1, [{ p: 'c.png' }, { p: 'b.png' }], 'sem anexo duplicado'); }
  // o campo da tarefa aberta na janela mostra o que voltou
  { const inp = { dataset: { tk: 't1' }, value: '' }; const { cvDraftGive, cvDraftTake } = mk({ t1: '' }, {}, inp); cvDraftGive('t1'); cvDraftTake('t1', 'do painel', []); assert.equal(inp.value, 'do painel'); }
  assert.match(cut(canvas, 'function cvPaneDispose(id){', '\n}\n'), /w\.sfPaneDraftOut\(\)[\s\S]*fr\.src='about:blank'/, 'devolve ANTES de virar about:blank');
});

test('envio que falha: o texto volta pro CAMPO desta tarefa (o render do finally não o zera) e não pega o de outra', () => {
  const blk = cut(ws, '    fwOptim[t.id]=(fwOptim[t.id]||[]).filter(x=>x!==op); if(answered)', "    showErr(e, 'Não consegui enviar");
  const run = (draft, input) => { const W = { fwDraft: { ...draft }, fwPend: {}, fwOptim: {}, input };
    new Function('W', 't', 'typed', 'atts', 'op', 'answered', 'const fwDraft=W.fwDraft, fwPend=W.fwPend, fwOptim=W.fwOptim; const $id=()=>W.input;\n' + blk)(W, { id: 'A' }, 'msg A', [{ p: 'a.png' }], {}, null); return W; };
  // ficou na A: campo vazio (desabilitado no envio) → recebe o texto
  { const inp = { dataset: { tk: 'A' }, value: '' }; const W = run({ A: '' }, inp); assert.equal(W.fwDraft.A, 'msg A'); assert.equal(inp.value, 'msg A'); assert.deepEqual(W.fwPend.A, [{ p: 'a.png' }]);
    // o que o renderWorkspace faz primeiro (20:959): campo → rascunho. Agora o rascunho continua com o texto
    W.fwDraft[inp.dataset.tk] = inp.value; assert.equal(W.fwDraft.A, 'msg A'); }
  // foi pra B e digitou lá: o campo da B não é tocado e o texto da B não entra na A
  { const inp = { dataset: { tk: 'B' }, value: 'Rascunho da B' }; const W = run({ A: '', B: 'Rascunho da B' }, inp); assert.equal(W.fwDraft.A, 'msg A'); assert.equal(inp.value, 'Rascunho da B'); }
});

test('fechar aba pelo teclado: ⌘W no Mac (Ctrl+W é do terminal), Ctrl+W fora do Mac exceto dentro do xterm', () => {
  const K = new Function(cut(tabs, '// @puro-atalhos-inicio', '// @puro-atalhos-fim') + '\nreturn tabCloseKey;')();
  const term = { closest: (sel) => sel === '.xterm' }, field = { closest: () => null };
  const ev = (o) => ({ key: 'w', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, target: field, ...o });
  assert.equal(K(ev({ metaKey: true }), 'mac'), true);
  assert.equal(K(ev({ metaKey: true, target: term }), 'mac'), true, '⌘W com o foco no terminal fecha (⌘ não é do terminal)');
  assert.equal(K(ev({ ctrlKey: true }), 'mac'), false, 'Mac: Ctrl+W não fecha a aba');
  assert.equal(K(ev({ ctrlKey: true, target: term }), 'mac'), false);
  assert.equal(K(ev({ ctrlKey: true }), 'win'), true, 'Windows/Linux: Ctrl+W fecha');
  assert.equal(K(ev({ ctrlKey: true, target: term }), 'linux'), false, '…mas dentro do terminal é "apagar palavra"');
  assert.equal(K(ev({ metaKey: true, shiftKey: true }), 'mac'), false);
  assert.equal(K(ev({ key: 'q', metaKey: true }), 'mac'), false);
});

test('⌘W fecha pela porta guardada: na janela (membro do grupo) e dentro do painel — a guarda olha a edição DO painel', async () => {
  const handler = cut(tabs, "document.addEventListener('keydown', async e=>{", '\n});\n') + '\n});';
  const mk = (pane) => { const W = { guarded: [], closed: [], parentGuarded: [] };
    const body = `let h; const document={ addEventListener:(n,f)=>{ h=f; } }; const window=W.win; const SF_PANE=${pane ? "'task:t2'" : 'null'};
      const cvShortcut=()=>false, cvGroupMember=()=>'task:t2', activeTab='task:t1', osKind=()=>'mac', TABS=[];
      const tabById=id=>({ id, kind:'task' }); const tabCloseGuarded=async id=>{ W.guarded.push(id); }; const closeTab=id=>W.closed.push(id);
      ${cut(tabs, '// @puro-atalhos-inicio', '// @puro-atalhos-fim')}
      ${handler}
      return h;`;
    W.win = { frameElement: { dataset: { tabid: 'task:t2' } }, parent: { tabCloseGuarded: async (id) => { W.parentGuarded.push(id); } } };
    return { W, h: new Function('W', body)(W) }; };
  const ev = (o) => ({ key: 'w', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: { closest: () => null }, preventDefault() {}, ...o });
  { const { W, h } = mk(false); await h(ev()); assert.deepEqual(W.guarded, ['task:t2'], 'membro em foco, pela tabCloseGuarded'); assert.deepEqual(W.closed, [], 'nunca o closeTab direto');
    await h(ev({ metaKey: false, ctrlKey: true })); assert.deepEqual(W.guarded, ['task:t2'], 'Ctrl+W no Mac: nada'); }
  { const { W, h } = mk(true); await h(ev()); assert.deepEqual(W.parentGuarded, ['task:t2'], 'no painel: fecha ESTE painel pela janela principal'); }
  assert.match(cut(tabs, 'async function tabLeaveGuard(targetId, closing){', '\n}\n'), /cvPaneWin\(targetId\)[\s\S]*w\.sfPaneLeaveOk\(\)/);
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

test('aba PR com erro do gh: sem acesso mostra a frase do backend (repositório + SSO); o resto sem stderr cru', () => {
  const fn = cut(ws, 'function fwRenderPrPage(t, main){', '\n}\n') + '\n}';
  const paint = (error, errKind) => { const main = { innerHTML: '' }; const bound = {};
    new Function('prCache', 'bindClick', 'esc', 'humanErr', 'IC', 'fn', fn + '\nreturn fwRenderPrPage;')({ t1: { exists: false, error, errKind } }, (id, f) => { bound[id] = f; }, esc, () => ({ id: 'generic', msg: '' }), {})({ id: 't1', branch: 'b' }, main);
    return { html: main.innerHTML, bound }; };
  const no = paint('GH_NO_ACCESS: a conta logada no gh não tem acesso a org/repo — se a org usa SSO, rode `gh auth refresh -s repo`', 'access');
  assert.match(no.html, /org\/repo/); assert.match(no.html, /gh auth refresh -s repo/); assert.ok(!/GH_NO_ACCESS/.test(no.html));
  const net = paint('gh: error connecting to api.github.com\nexit status 1', 'network');
  assert.ok(!/api\.github\.com|exit status/.test(net.html), 'stderr não vai pra tela'); assert.ok(net.bound.prPgErrDet, '"ver detalhes" leva o original');
});

test('erros crus: prévia (navegador) fala como gente e o original vai pro console', () => {
  assert.match(nav, /catch\(e\)\{ console\.error\('browser_open', e\); st\.err=\(typeof errShort==='function'\)\?errShort\(e\)/);
});

test('cosméticos: tarefa na fila não mostra "parar"; doca sem alias cru; 3 painéis a 920 sem cortes', () => {
  assert.match(ws, /if\(fwIsWorking\(t\) && t\.status!=='queued'\) return \{ id:'fwStopTop'/);
  const L = new Function('TI_AIS', cut(ti, 'function tiAiLabel(ai, model){', '\n') + '\nreturn tiAiLabel;')([{ id: 'claude', short: 'Claude' }]);
  assert.equal(L('claude', 'opus'), 'Claude · Opus'); assert.equal(L('claude', 'claude-opus-5-5'), 'Claude · claude-opus-5-5'); assert.equal(L('claude', ''), 'Claude');
  assert.match(cvCss, /html\.sfpane \.appmain>\.bus\{display:none!important\}/);
  assert.match(cvCss, /html\.sfpane \.en-kpi span\{min-width:0\}/);
  assert.match(tCss, /\.tlsf\{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;row-gap:4px;/, 'pular/próxima quebram linha em qualquer painel estreito (não só no .tight por altura)');
  assert.match(pr, /pill:\['falta prova','warn'\]/);
});
