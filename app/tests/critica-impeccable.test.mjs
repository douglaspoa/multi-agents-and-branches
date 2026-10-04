// Crítica Impeccable (02/10) — P1/P2 escolhidos pelo dono + achados baratos do detector:
// portão de prova em TODA porta de aprovação · destaque da barra lateral = o que está na tela · cabeçalho da
// tarefa em painel/estreito · piso de 11px na escala de texto · vermelho só pro "parar" · modos escondidos pelo tipo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pr = read('js/21-pull-request.js'), ws = read('js/20-workspace-tarefa.js'), en = read('js/27-entregas.js');
const qf = read('js/22-quadro-fluxo.js'), gr = read('js/25-grafo.js'), abas = read('js/15-config-abas-onboarding.js');
const cv = read('js/58-canvas.js'), prefs = read('js/12-chat-prefs-daily.js'), html = read('index.html');

// ---------- 1. portão de prova ----------
const G = new Function(cut(pr, '// @prova-gate-inicio', '// @prova-gate-fim') + '\nreturn { proofMissingOf, proofSigOf, proofGateOf, proofAskMsg };')();
const ROWS = [
  { text: 'cor da marca nos botões', st: 'ok', evidence: ['cores-1.png'] },
  { text: 'contraste AA nos textos', st: 'ok', evidence: [] },
  { text: 'modo escuro sem branco puro', st: 'blk', evidence: [], note: 'falta o modo escuro' },
];

test('portão de prova: sem prova = não feito OU feito sem arquivo; motivo vale só pro mesmo conjunto', () => {
  assert.deepEqual(G.proofGateOf([], true, null), { st: 'none', missing: [] });
  assert.equal(G.proofGateOf(ROWS, false, null).st, 'loading', 'provas ainda não lidas: não decide');
  const g = G.proofGateOf(ROWS, true, null);
  assert.equal(g.st, 'unproven');
  assert.deepEqual(g.missing.map((r) => r.text), ['contraste AA nos textos', 'modo escuro sem branco puro']);
  assert.equal(G.proofGateOf([ROWS[0]], true, null).st, 'proven');
  const ov = { sig: G.proofSigOf(g.missing), reason: 'cliente aprovou na call' };
  assert.equal(G.proofGateOf(ROWS, true, ov).st, 'override');
  const mais = ROWS.concat([{ text: 'novo requisito', st: 'na', evidence: [] }]);
  assert.equal(G.proofGateOf(mais, true, ov).st, 'unproven', 'apareceu outro requisito sem prova: pergunta de novo');
  const msg = G.proofAskMsg(g.missing);
  assert.match(msg, /falta a PROVA/); assert.match(msg, /requirements\.json/);
  assert.match(msg, /1\. contraste AA nos textos — marcado como feito, mas sem arquivo de prova/);
  assert.match(msg, /2\. modo escuro sem branco puro — você marcou como bloqueado: falta o modo escuro/);
});

test('portão de prova vale em TODA porta de aprovação (cabeçalho, card da Central, Entrega, resumo, aba PR)', () => {
  // uma porta só: prova → verificação → PR
  const gate = cut(pr, 'async function approveGate(t){', '\n}\n');
  assert.match(gate, /proofGate\(t\)[\s\S]*st==='unproven'[\s\S]*approveShowEntrega[\s\S]*chkEnsure\(t\)[\s\S]*chkApproveClick\(t\)/);
  // cabeçalho: sem prova o verde é "pedir a prova ao agente"; "aprovar sem prova…" é secundário (e está no ⋯)
  assert.match(ws, /proofGate\(t\)\.st==='unproven'\)\s*\? \{ id:'fwAskProof', html:`\$\{IC\.ai\} pedir a prova ao agente`/);
  assert.match(ws, /id="fwNoProof"[^`]*>aprovar sem prova…<\/button>/);
  assert.match(ws, /if\(prim==='fwAskProof'\) it\.push\(\{ k:'noproof', label:'aprovar sem prova…'/);
  assert.match(ws, /bindClick\('fwApprove', \(\)=>approveGate\(t\)\);/);
  assert.match(ws, /bindClick\('prPgCreate', \(\)=>approveGate\(t\)\);/);
  // card da Central: não pula mais direto pro prPrepOpen
  assert.match(qf, /data-rowpr[\s\S]{0,200}crossRun\(id, \(\)=>approveGate\(taskOfId\(id\)\)\)/);
  assert.ok(!/data-rowpr[^\n]*prPrepOpen/.test(qf), 'card não abre o PR sem o portão');
  assert.match(en, /proofGate\(t\)\.st==='unproven' \? `<button class="btn sm ghost" data-rownoproof=[\s\S]*?<button class="btn primary sm" data-rowproof=/);
  assert.match(qf, /bindClick\('sumPr', \(\)=>\{ \$id\('sumOverlay'\)\.style\.display='none'; approveGate\(t\); \}\);/);
  // Entrega: vfApprove/vfOverride passam pelo portão; os botões de lá são neutros (o verde é o do cabeçalho)
  assert.match(en, /bindClick\('vfApprove', \(\)=>\{ const g=chkGate\(t\); if\(chkCanApprove\(g\)\) approveGate\(t\); \}\);/);
  assert.match(en, /chkOverride\(t, g\)\)\{ renderWorkspace\(\); approveGate\(t\); \}/);
  assert.match(en, /<button class="btn" id="vfAskProof"/); assert.match(en, /<button class="btn" id="vfApprove"/);
  assert.ok(!/class="btn primary" id="vf(Approve|AskProof)"/.test(en), 'um verde por tela');
  // motivo registrado como o override das checagens + vai no PR
  const ovr = cut(pr, 'async function proofOverride(t){', '\n}\n');
  assert.match(ovr, /askText\('Aprovar sem prova'/); assert.match(ovr, /lsSet\('proofOv:'\+t\.id/); assert.match(ovr, /invoke\('checks_override_log'/);
  assert.match(pr, /## Provas\\nAtenção: aprovado sem prova de/);
  // pedir a prova = mesma via do composer (na fila se ele estiver trabalhando)
  assert.match(cut(pr, 'async function proofAsk(t, btn){', '\n}\n'), /fwSendText\(t\.id, proofAskMsg\(g\.missing\)\)/);
});

// ---------- 2. destaque da barra lateral ----------
const R = new Function(cut(gr, '// @rail-hi-inicio', '// @rail-hi-fim') + '\nreturn { railHiOf };')();
const TABS = { flow: { id: 'flow', kind: 'flow' }, 'task:t1': { id: 'task:t1', kind: 'task', taskId: 't1' }, 'task:t2': { id: 'task:t2', kind: 'task', taskId: 't2' }, 'web:x': { id: 'web:x', kind: 'web', url: 'https://x' }, 'device:t3': { id: 'device:t3', kind: 'device', taskId: 't3' } };
const of = (id) => TABS[id] || null;

test('destaque da barra lateral = a aba ativa e TODAS as demandas da tela dividida (aria-current no painel em foco)', () => {
  assert.deepEqual(R.railHiOf(of('flow'), null, 0, of), { ids: [], cur: null }, 'na Central nada fica destacado');
  assert.deepEqual(R.railHiOf(of('task:t2'), null, 0, of), { ids: ['t2'], cur: 't2' });
  assert.deepEqual(R.railHiOf(of('task:t1'), ['task:t1', 'task:t2', 'web:x'], 1, of), { ids: ['t1', 't2'], cur: 't2' });
  assert.deepEqual(R.railHiOf(of('task:t1'), ['task:t2', 'web:x'], 0, of), { ids: ['t1'], cur: 't1' }, 'aba fora da divisão: só ela');
  assert.deepEqual(R.railHiOf(of('device:t3'), null, 0, of), { ids: ['t3'], cur: 't3' }, 'simulador de uma demanda aponta pra ela');
  // fiação: a linha usa o destaque derivado (não o `selected` antigo) e repinta na troca de aba e de foco
  // (mesa da barra lateral 03/10: a linha virou rowHtml — o destaque continua vindo de hi.ids/hi.cur)
  assert.match(gr, /const sel=!other && hi\.ids\.includes\(t\.id\);/);
  assert.match(gr, /\$\{sel\?' sel':''\}[^`]*role="button" tabindex="0"\$\{!other&&hi\.cur===t\.id\?' aria-current="page"':''\}/);
  assert.ok(!/prow2\$\{t\.id===selected/.test(gr));
  assert.match(cut(abas, 'function activateTab(id){', '// canvas: stream'), /if\(at && at\.taskId\) selected=at\.taskId;[\s\S]*renderRail\(\)/);
  assert.match(cut(cv, 'function cvPaneFocus(tabId){', '// aria-current'), /renderRail\(\)/);
});

// ---------- 3. cabeçalho em painel / janela estreita ----------
test('cabeçalho: no painel sem título/×, UMA pílula de estado, Dispositivo no ⋯, apertado vira ícone com aria-label', () => {
  const css = read('css/93-critica.css');
  assert.match(css, /html\.sfpane \.fwhead #fwTaskName,html\.sfpane \.fwhead #fwClose\{display:none\}/);
  assert.match(css, /html\.sfpane \.fwhead\.narrow #fwPhases\{display:flex\}/, 'a largura do título vai pro estado');
  const ph = cut(ws, 'function phasesHtml(t){', '\n}\n');
  assert.ok(!/class="pd/.test(ph), 'sem os 5 pontos'); assert.match(ph, /class="fwstpill"/); assert.match(ph, /fase '\+/);
  assert.ok(!/id="fwDevBtn"/.test(html));
  { const ah = cut(ws, 'function fwActionHtml(t){', '\n}\n'); assert.match(ah, /aria-label="\$\{escA\(lbl\)\}"/); assert.match(ah, /class="fwal"/); }
  assert.match(css, /\.fwhead\.tight #fwReviewBar \.btn \.fwal\{display:none\}/);
  assert.match(ws, /head\.scrollWidth>head\.clientWidth\+1\) head\.classList\.add\('tight'\)/, 'mede o próprio cabeçalho (ResizeObserver), sem laço');
  assert.match(css, /\.cmsg \.cbub\{min-width:0;overflow-wrap:anywhere\}/, 'mensagem do chat quebra');
  assert.match(css, /\.bus #clock\{flex:0 1 auto;min-width:0;overflow:hidden/, 'relógio não empurra a Central');
});

test('barra lateral recolhe sozinha em janela estreita (sem gravar a preferência; ResizeObserver)', () => {
  const A = new Function(cut(prefs, '// @rail-auto-inicio', '// @rail-auto-fim') + '\nreturn { railAutoNarrow };')();
  assert.equal(A.railAutoNarrow(1440), false); assert.equal(A.railAutoNarrow(900), false);
  assert.equal(A.railAutoNarrow(800), true, '800 − 220 < 600 de conteúdo'); assert.equal(A.railAutoNarrow(420), true);
  assert.match(prefs, /if\(RAIL_AUTO\.on\)\{ RAIL_AUTO\.open=!v; railPaint\(!!v\); return; \}/, 'estreita: não grava');
  assert.match(prefs, /new ResizeObserver\(\(\)=>requestAnimationFrame\(railAutoFit\)\)/);
  assert.ok(!/setInterval/.test(cut(prefs, '// @rail-auto-inicio', "$id('railToggle')")));
});

// ---------- 4. piso de 11px ----------
// única exceção: iniciais do agente dentro do círculo (decorativas, aria-hidden — o nome vem ao lado)
const FS_DECORATIVOS = ['.cav', '.fav', '.fcommit .cav', '.frow .ini2', '.kav', '.fwav', '.fwav.sm', '.nsav', '.costrow .cav', '.tsav', '.dc-foot .ini2', '.ctp-who .tsav', '.trk-av'];
test('escala de texto: nenhum font-size abaixo de 11px (CSS, HTML e estilos inline do JS) — só as iniciais decorativas', () => {
  const css = readdirSync(new URL('../src/css/', import.meta.url)).filter((f) => f.endsWith('.css'));
  const px = /font(?:-size)?:\s*(?:(?:italic|normal|bold|[1-9]00)\s+)*([0-9.]+)px/g;
  const bad = [];
  for (const f of css) for (const [m, v] of read('css/' + f).matchAll(px)) if (+v < 11) bad.push(f + ': ' + m);
  for (const f of readdirSync(new URL('../src/js/', import.meta.url)).filter((x) => x.endsWith('.js'))) for (const [m, v] of read('js/' + f).matchAll(px)) if (+v < 11) bad.push(f + ': ' + m);
  for (const [m, v] of html.matchAll(px)) if (+v < 11) bad.push('index.html: ' + m);
  assert.deepEqual(bad, []);
  const base = read('css/10-base.css');
  assert.match(base, /--fs-xs:11px; --fs-sm:12\.5px; --fs-base:13px; --fs-md:14px; --fs-lg:18px; --fs-xl:28px;/);
  // quem usa o token decorativo é só a lista fechada
  const users = [];
  for (const f of css) for (const line of read('css/' + f).split('\n')) if (/var\(--fs-ini\)/.test(line)) users.push(line.trim().split('{')[0]);
  assert.deepEqual([...new Set(users)].sort(), [...FS_DECORATIVOS].sort());
  assert.match(read('js/27-entregas.js'), /<span class="ini2" aria-hidden="true"/, 'iniciais decorativas fora do leitor de tela');
  assert.match(read('css/88-acessibilidade.css') + read('css/93-critica.css'), /::placeholder\{color:var\(--muted\);opacity:1\}/);
});

// ---------- 5. vermelho só pro "parar" ----------
const C = new Function('IC', cut(ws, '// @composer-envio-inicio', '// @composer-envio-fim') + '\nreturn { fwSendRowOf };')({ stop: '<svg/>' });
test('composer: UM envio neutro ("na fila" trabalhando) + menu ▾; nada vermelho; verde só sem ação no cabeçalho', () => {
  const w = C.fwSendRowOf({ working: true, asking: false, headPrimary: false });
  assert.ok(!/trk-stop|parar/.test(w.btns), 'sem "parar e enviar" vermelho');
  assert.equal((w.btns.match(/<button/g) || []).length, 2);
  assert.match(w.btns, /class="btn sm cc-send" id="fwQueue"[^>]*>na fila<\/button>/);
  assert.match(w.btns, /id="fwSendMore" aria-haspopup="menu"[^>]*aria-label="mais opções de envio"/);
  assert.match(w.hint, /⌘Enter<\/span> interrompe e envia já/);
  assert.ok(!/primary/.test(w.btns));
  assert.match(C.fwSendRowOf({ headPrimary: false }).btns, /btn primary sm cc-send/, 'sem ação no topo: o envio é o verde');
  assert.ok(!/primary/.test(C.fwSendRowOf({ headPrimary: true }).btns), 'com verde no topo: envio neutro');
  assert.match(ws, /pop\.innerHTML=`<button class="fwmi" role="menuitem" data-fwsend="now"><span>interromper e enviar já<\/span>/);
  assert.match(ws, /\.onclick=\(\)=>\{ close\(false\); fwSendMsg\(false\); \};/, 'mesma semântica de interromper');
  // o único vermelho de ação na tela da tarefa é o "parar" do cabeçalho
  const hits = (ws.match(/trk-stop/g) || []).length;
  assert.equal(hits, 1); assert.match(ws, /id:'fwStopTop', cls:'btn sm fwstopbtn trk-stop'/);
});

// ---------- 6. modos escondidos pelo tipo ----------
const M = new Function(cut(en, '// @modos-tipo-inicio', '// @modos-tipo-fim') + '\nreturn { fwModesNonCodeOf, fwModesListOf };')();
test('modos pelo tipo: entrega que não é código esconde Código, Revisão e PR (sem "modo simples" global)', () => {
  const keys = (nc, prUrl) => M.fwModesListOf(nc, prUrl).map(([k]) => k);
  assert.deepEqual(keys(false, false), ['entrega', 'codigo', 'conversa', 'revisao', 'previa']);
  assert.deepEqual(keys(false, true), ['entrega', 'codigo', 'conversa', 'revisao', 'previa', 'pr']);
  assert.deepEqual(keys(true, false), ['entrega', 'conversa', 'previa']);
  for (const type of ['invest', 'design', 'research', 'report']) assert.equal(M.fwModesNonCodeOf({ type }), true, type);
  assert.equal(M.fwModesNonCodeOf({ type: 'feat', kind: 'research' }), true);
  assert.equal(M.fwModesNonCodeOf({ type: 'feat', branch: 'report/q3' }), true);
  assert.equal(M.fwModesNonCodeOf({ type: 'docs', diffFiles: 0 }), true, 'docs sem mexer no repo = documento');
  assert.equal(M.fwModesNonCodeOf({ type: 'docs', diffFiles: 2 }), false, 'docs que mudou arquivos ainda precisa de Revisão');
  assert.equal(M.fwModesNonCodeOf({ type: 'feat', nonCode: true }), true, 'entregaNonCode (só entregou arquivos)');
  assert.equal(M.fwModesNonCodeOf({ type: 'invest', prUrl: 'https://github.com/a/b/pull/1' }), false, 'PR aberto: mostra tudo');
  assert.equal(M.fwModesNonCodeOf({ type: 'feat' }), false);
  assert.match(en, /nonCode:entregaNonCode\(t\)/);
  assert.match(ws, /if\(typeof fwModesList==='function' && !fwModesList\(t\)\.some\(\(\[k\]\)=>k===fwMode\)\)\{ fwMode='entrega';/, 'modo escondido guardado na aba cai na Entrega');
  assert.ok(!/modoSimples|simpleMode|lsGet\('modo/.test(en + ws), 'sem modo simples global');
});

// ---------- achados baratos do detector ----------
test('detector: ícones do "+" são SVG do IC, botões só-ícone têm aria-label, cartões focáveis têm papel', () => {
  const plus = cut(cv, 'function cvPlusMenu(anchor, opts){', 'm.innerHTML=');
  assert.ok(!/[◐◍▯▤]/.test(plus), 'sem glifos Unicode no menu "+"');
  assert.match(plus, /ic:IC\.stack[\s\S]*ic:IC\.globe[\s\S]*ic:IC\.phone[\s\S]*ic:IC\.doc/);
  assert.ok(!/'▤'/.test(cut(cv, 'function cvSubMenu(m, list, title){', '\n}\n')));
  assert.match(qf, /id="ffMore" title="filtros avançados" aria-label="filtros avançados"/);
  assert.equal((qf.match(/<button class="fvic[^>]*data-(?:fv|view|nv-view)="[^"]*"[^>]*aria-label="/g) || []).length, 6); // + "ver em tabela" (redesenho F1)
  assert.match(qf, /if\(!r\.hasAttribute\('role'\)\)\{ r\.setAttribute\('role','button'\);/);
  assert.match(gr, /<div class="prow2 more" data-more="1" role="button" tabindex="0"/);
});
