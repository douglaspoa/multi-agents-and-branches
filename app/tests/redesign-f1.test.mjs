// REDESENHO F1 (spec-redesign-f1-chrome-doca, protótipo aprovado 04/10): no máximo 2 faixas acima do conteúdo da tarefa
// (abas + modos · etapas + portão + adiados + gasto), "Responder" colado ao terminal e separado dos comandos, requisitos
// como linha do tempo com carimbo estático, lateral com as demandas primeiro e a Central em tabela ordenável.
// Funções puras + ganchos nos arquivos de sempre. `node --test app/tests/redesign-f1.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ws = read('js/20-workspace-tarefa.js'), ciclo = read('js/60-ciclo.js'), lay = read('js/60-terminal-layout.js');
const ti = read('js/64-terminal-integrado.js'), ct = read('js/66-central-tabela.js'), gr = read('js/25-grafo.js');
const html = read('index.html');
const ADIADO = cut(read('js/00-util.js'), '// @adiado-puro-inicio', '// @adiado-puro-fim'); // a régua única do adiado

const DOCK = new Function(cut(ws, '// @fw-dock-puro-inicio', '// @fw-dock-puro-fim') + '\nreturn { fwHeadDockOf };')();
const CI = new Function('esc', 'escA', 'fmtCost', cut(ciclo, '// @ciclo-faixa-inicio', '// @ciclo-faixa-fim') + '\nreturn { stageStripHtml, cicGateHtml };')(esc, esc, (v) => 'US$ ' + (+v).toFixed(2).replace('.', ','));
const TL = new Function('esc', 'escA', ADIADO + cut(lay, '// @tl-puro-inicio', '// @tl-puro-fim') + '\nreturn { reqIsAdiado, tlReqView, tlPanelHtml, tlRailHtml, tlStampHtml };')(esc, esc);
const TI = new Function('esc', 'escA', cut(ti, '// @ti-puro-inicio', '// @ti-puro-fim') + '\nreturn { tiReplyHtml };')(esc, esc);
const CT = new Function('esc', 'escA', cut(ct, '// @ct-puro-inicio', '// @ct-puro-fim') + '\nreturn { ctSort, ctNextSort, ctRouteHtml, ctAction, ctSentence, ctTableHtml };')(esc, esc);
const RL = new Function('esc', 'escA', cut(gr, '// @rail-mesa-inicio', '// @rail-mesa-fim') + '\nreturn { railBadgeHtml, railHeadHtml };')(esc, esc);

// ---------------- faixa 1: o cabeçalho da tarefa na barra de abas ----------------
test('faixa 1: o cabeçalho da tarefa só doca na barra de abas com a tarefa sozinha e visível (nunca no painel nem na tela dividida)', () => {
  const base = { pane: false, visible: true, kind: 'task', split: false, tabTask: 't1', fwTask: 't1' };
  assert.equal(DOCK.fwHeadDockOf(base), true);
  for (const [k, v] of [['pane', true], ['visible', false], ['kind', 'flow'], ['split', true], ['tabTask', 't2'], ['tabTask', null]]) assert.equal(DOCK.fwHeadDockOf({ ...base, [k]: v }), false, k);
  assert.equal(DOCK.fwHeadDockOf(null), false);
  const tabs = read('js/15-config-abas-onboarding.js');
  assert.match(tabs, /<span class="tabtools" id="tabTools"><\/span>/, 'slot na barra de abas');
  assert.match(tabs, /const h=bar\.querySelector\('\.fwhead'\); if\(h\) h\.remove\(\);/, 'o nó sai antes do innerHTML e volta (handlers intactos)');
  assert.match(tabs, /if\(typeof fwHeadDock==='function'\) fwHeadDock\(\);/);
  assert.match(ws, /function renderWorkspace\(\)\{\n[^\n]*\n  fwHeadDock\(\);/);
  // docado, quem muda de tamanho é a barra: o ResizeObserver observa ela também (sem polling)
  assert.match(ws, /if\(bar\) FW_HEAD\.ro\.observe\(bar\)/);
  const css = read('css/95-ciclo.css');
  assert.match(css, /\.tabbar \.fwhead\.docked #fwTaskName,[^{]*#fwClose[^{]*\{display:none\}/);
});

// ---------------- faixa 2: etapas · portão · adiados · gasto ----------------
const STAGES = [
  { id: 'plano', label: 'Plano', state: 'feito', word: 'pronto', lock: 1, who: 'Vega' },
  { id: 'construir', label: 'Construir', state: 'feito', word: 'pronto', lock: 0, who: 'Íris' },
  { id: 'provar', label: 'Provar', state: 'precisa', word: 'falta prova', lock: 0 },
  { id: 'entregar', label: 'Entregar', state: 'espera', word: 'depois', lock: 2 },
];
const SUM = { now: 'Falta prova', next: 'Depois: Entregar', spent: 1.79, cap: 1000, n: 4, pos: 3, label: 'Provar' };
test('faixa 2: UMA faixa com selo, etapas, portão (N de M com prova), adiados tracejados e o gasto curto', () => {
  const gate = CI.cicGateHtml({ st: 'unproven', ok: 3, n: 5, adiados: 2 });
  assert.match(gate, /class="cicgate g-no"/); assert.match(gate, /<b>3 de 5<\/b><span class="cicgate-w"> exigidos com prova<\/span>/); assert.match(gate, /<span class="cicgate-ad"[^>]*>2 adiados<\/span>/);
  const ld = CI.cicGateHtml({ st: 'loading', ok: 2, n: 3 });
  assert.match(ld, /class="cicgate g-ld"/); assert.match(ld, /stroke-dasharray="0\.00 /, 'lendo: anel vazio (nunca fechado)');
  assert.match(CI.cicGateHtml({ st: 'proven', ok: 0, n: 0, adiados: 2 }), /nenhum exigido[^]*2 adiados/, 'só adiados: o portão está liberado');
  assert.match(CI.cicGateHtml({ st: 'proven', ok: 2, n: 2 }), /g-ok/);
  assert.match(CI.cicGateHtml({ st: 'override', ok: 1, n: 2 }), /g-ov/);
  assert.match(CI.cicGateHtml({ st: 'loading', ok: 0, n: 2 }), /conferindo as provas…/);
  assert.equal(CI.cicGateHtml({ st: 'none', n: 0 }), '');
  assert.ok(!/adiado/.test(CI.cicGateHtml({ st: 'proven', ok: 2, n: 2, adiados: 0 })), 'sem adiado, sem selo');
  assert.ok(!/animation|<animate/.test(gate), 'anel estático (movimento é a F3)');
  const h = CI.stageStripHtml(STAGES, SUM, { gate, pill: '<span class="cicst-pill">PILL</span>' });
  assert.match(h, /^<div class="cicstrip" role="group" aria-label="Etapas da tarefa"><span class="cicst-pill">PILL<\/span><ol class="cicst-list">/);
  assert.match(h, /<div class="cicst-sum"[^>]*><span class="cicgate g-no"/, 'o portão mora na faixa');
  assert.match(h, /<span class="cicst-pos">etapa 3 de 4<\/span><span class="cicst-posl"> · Provar<\/span>/, 'estreito: "etapa n de N · Rótulo"');
  assert.match(h, /gasto <b>US\$ 1,79<\/b> de US\$ 1000,00/);
  assert.match(h, /title="Falta prova · Depois: Entregar"/, 'agora/depois no tooltip e no leitor de tela');
  // Meu time: rodapé próprio continua (sem portão nem selo)
  assert.match(CI.stageStripHtml(STAGES, SUM, { foot: 'custo médio' }), /<div class="cicst-sum"><span class="cicst-cost">custo médio<\/span><\/div>/);
  const css = read('css/95-ciclo.css');
  assert.match(css, /\.fwciclo \.cicstrip\{flex-wrap:nowrap/);
  assert.match(css, /@container ciclo \(max-width:960px\)\{[^}]*\.cicst-posl\{display:inline\}/);
  assert.match(css, /\.cicgate\.g-ld\{color:var\(--muted\)\}/);
  assert.ok(!/max-width:960px\)\{[^@]*\.cicst-pill\{display:none\}/.test(css), 'estreito: o selo do estado continua (compacto)');
  assert.match(ciclo, /gate:cicGateHtml\(x\.gate\), pill/);
  assert.match(ciclo, /gate:\{ st:pg\.st, n, ok:pg\.st==='loading'\?0:n-\(pg\.missing\|\|\[\]\)\.length, adiados \}/, 'portão = proofGate (fonte única); lendo = 0');
  // o que o cabeçalho docado escondia vem pra faixa: épico (clique abre), chips do orquestrador e a branch
  assert.match(ciclo, /<span class="cicst-epic">\$\{ep\}<\/span>/); assert.match(ciclo, /<span class="cicst-orq" id="cicOrq"><\/span>/); assert.match(ciclo, /class="cicst-br mono"/);
  assert.match(ciclo, /\.cicst-epic \[data-epbadge\]/); assert.match(ws, /function fwOrqChipsPlace\(\)/);
  assert.match(ws, /head\.classList\.remove\('tight','narrow'\)/, 'a medida do outro lugar não vale docado');
  assert.ok(!/fwdocked/.test(ws), 'sem classe sem uso');
});

// ---------------- requisitos: linha do tempo + carimbo ----------------
test('requisitos: adiado é tracejado com "adiado — motivo: …" (nunca riscado); linha do tempo R1…Rn com carimbo estático', () => {
  assert.equal(TL.reqIsAdiado({ status: 'deferred' }), true);
  assert.equal(TL.reqIsAdiado({ status: 'waived' }), true);
  assert.equal(TL.reqIsAdiado({ status: 'blocked', note: 'adiado por decisão do humano' }), true);
  assert.equal(TL.reqIsAdiado({ status: 'blocked', note: 'o e-mail só sai em produção' }), false);
  assert.equal(TL.reqIsAdiado({ status: 'done' }), false);
  assert.equal(TL.reqIsAdiado({ status: 'deferred', st: 'ok', evidence: ['p.png'] }), false, 'provado nunca é adiado');
  // uma régua só: o orquestrador e o portão usam a mesma
  assert.match(read('js/34-orquestrador.js'), /return x\.status==='done' \|\| reqIsAdiado\(x\);/);
  assert.ok(!/deferid\|adiad/.test(lay + read('js/34-orquestrador.js')), 'sem regex duplicada');
  const view = TL.tlReqView([
    { text: 'r1', st: 'ok', evidence: ['p.png'] },
    { text: 'r2', st: 'blk', status: 'deferred', note: 'você escolheu a main', evidence: [] },
    { text: 'r3', st: 'blk', status: 'deferred', note: '', evidence: [] },
    { text: 'r4', st: 'na', evidence: [] },
  ], false);
  assert.deepEqual(view.map((v) => v.ck), ['ok', 'ad', 'ad', '']);
  assert.equal(view[1].sub, 'adiado — motivo: você escolheu a main');
  assert.equal(view[2].sub, 'adiado', 'sem motivo → "adiado"');
  const p = TL.tlPanelHtml({ view, gate: { st: 'unproven', missing: [1, 2, 3] }, phase: 'idle' });
  assert.ok(p.indexOf('class="tlgate"') < p.indexOf('class="tltl"'), 'o resumo do portão vem antes da linha do tempo');
  assert.match(p, /1 de 2 exigidos com prova · 2 adiados/);
  assert.match(p, /aria-valuemax="2" aria-valuenow="1"/);
  assert.match(p, /<span class="tlphn">4 requisitos<\/span>/);
  assert.match(p, /<li class="tlreq ck-ok"><span class="tlck ok"[^>]*><\/span><span class="tlrt"><span class="tlrtx"><b class="tlrn">R1<\/b> r1/);
  assert.equal((p.match(/class="tlstamp ok"/g) || []).length, 1);
  assert.equal((p.match(/class="tlstamp ad"/g) || []).length, 2);
  assert.equal(TL.tlStampHtml('no'), '', 'só provado e adiado carimbam');
  assert.ok(!/line-through|<s>|<del>/.test(p), 'adiado nunca riscado');
  const rail = TL.tlRailHtml(view, {});
  assert.match(rail, /<span class="tlnum"><b>1\/4<\/b><small>provas<\/small><\/span>/, 'faixa recolhida com o número na horizontal');
  assert.match(rail, /<i class="ad"><\/i>/);
  const css = read('css/95-terminal.css');
  const f1 = css.slice(css.indexOf('redesenho F1: requisitos como LINHA DO TEMPO'));
  assert.ok(!/rotate|animation|transition/.test(f1), 'carimbo estático');
  // Entrega usa os mesmos carimbos e o mesmo "adiado — motivo"
  const en = read('js/27-entregas.js');
  assert.match(en, /tlStampHtml\(ck\)/); assert.match(en, /tlAdiadoSub\(r\.note\)/); assert.match(en, /<b class="tlrn">R\$\{i\+1\}<\/b>/);
});

// ---------------- doca: Responder colado ao terminal, comandos separados ----------------
test('doca: "Responder" com 1·2·3; IA ocupada → só "Interromper (esc)"; shell sem IA → "a IA parou · Continuar com…"', () => {
  const rec = { ai: 'claude', model: 'opus', command: 'starfork ia claude --modelo opus' };
  const chips = TI.tiReplyHtml({ chips: { id: 7, list: ['Ver o PR', 'Rodar os testes', 'Abrir a Entrega'] }, rec });
  assert.match(chips, /<div class="tireply"><span class="tirl" id="tiReplyL">Responder<\/span>/);
  assert.equal((chips.match(/data-tichip="/g) || []).length, 3);
  assert.match(chips, /data-tichip="0" data-sid="7"[^>]*aria-keyshortcuts="1"><span class="tichx">Ver o PR<\/span><span class="tik" aria-hidden="true">1<\/span>/);
  const four = TI.tiReplyHtml({ chips: { id: 1, list: ['a', 'b', 'c', 'd'] }, rec });
  assert.equal((four.match(/class="tik"/g) || []).length, 3, 'atalho só 1–3');
  assert.match(ti, /!\/\^\[1-3\]\$\/\.test\(e\.key\) \|\| !e\.target\.closest\('\.tireply'\)/, 'só com o foco na faixa Responder');
  const busy = TI.tiReplyHtml({ chips: { id: 7, list: ['a'] }, busy: true, live: true, rec });
  assert.ok(!/data-tichip/.test(busy), 'ocupada: chips somem');
  assert.match(busy, /data-ti="esc"[^>]*>Interromper <span class="kbd">esc<\/span>/);
  assert.equal(TI.tiReplyHtml({ busy: true, live: false, rec }), '', 'sem terminal vivo não há o que interromper');
  const sh = TI.tiReplyHtml({ shell: true, rec });
  assert.match(sh, /<span class="tirl">a IA parou<\/span><button type="button" class="btn sm primary tirecbtn" data-ti="rec"[^>]*>Continuar com Claude · opus<\/button>/);
  assert.equal(TI.tiReplyHtml({ rec }), '', 'nada a responder: a faixa some');
  // a linha de comandos: IA ▾ · Anexar · ✎ | Etapa · Skills · Tarefa · Revisão / PR — sem o rótulo "compositor" solto
  const dock = cut(ti, 'function tiDockHtml(t){', '\n}\n');
  assert.ok(dock.indexOf('id="tiChips"') < dock.indexOf('class="tiacts"'), 'Responder antes (colado ao terminal), comandos depois');
  assert.ok(!/<span>compositor<\/span>/.test(dock), 'compositor é ícone');
  assert.match(dock, /aria-label="\$\{comp\?'esconder o compositor de texto':'mostrar o compositor de texto'\}"/);
  assert.match(dock, /botão só digita o comando/);
  assert.match(ti, /invokeQuiet\('term_write', \{ taskId, data:'\\x1b' \}\)/, 'Interromper = o mesmo Esc do terminal');
  // a barra "histórico · digite pra continuar" saiu de cima do terminal
  assert.ok(!/histórico\$\{h\.resumes===false/.test(read('js/60-terminal.js')));
  assert.match(lay, /class="lnk tlresume" data-termopen=/);
});

// ---------------- lateral ----------------
test('lateral: "Demandas · N em aberto", selo do projeto com cor E inicial, navegação embaixo das demandas, uso do plano recolhido', () => {
  assert.equal(RL.railBadgeHtml('logcomex-ai-v2', 'hsl(145 62% 60%)'), '<span class="rpbadge" style="--pc:hsl(145 62% 60%)" aria-hidden="true">L</span>');
  assert.match(RL.railBadgeHtml('.cardume', ''), />C</, 'pula pontuação inicial');
  assert.match(RL.railBadgeHtml('', ''), />\?</);
  assert.equal(RL.railHeadHtml(4), '<div class="rhead"><span>Demandas</span><span class="n">4 em aberto</span></div>');
  assert.match(RL.railHeadHtml(1), /1 em aberto/);
  assert.match(gr, /html=railHeadHtml\(cAll\.vivas\)\+html;/);
  assert.ok(html.indexOf('<div class="sbscroll">') < html.indexOf('<div class="sbnav2"') && html.indexOf('<div class="sbnav2"') < html.indexOf('id="planMeter"'));
  assert.match(read('js/28-medidor-plano.js'), /function pmIsMin\(\)\{ return lsGet\(PM_MIN_KEY\)!=='0'; \}/);
});

// ---------------- Central em tabela ----------------
const R = (o) => ({ id: 'x', title: 'X', proj: 'p', ia: 'Claude', stages: [], pos: 0, n: 0, label: '', nreq: 0, ok: 0, ad: 0, loaded: true, pr: '', prUrl: '', status: 'running', bucket: 'andamento', st: 'running', stLabel: 'rodando', stColor: 'var(--st-run)', rank: 1, ts: 0, ago: '', ...o });
test('Central: ordena por qualquer cabeçalho (estável, empate = mais recente) e o clique inverte o sentido', () => {
  const rows = [R({ id: 'a', title: 'Beta', ts: 1, rank: 1, nreq: 4, ok: 1 }), R({ id: 'b', title: 'alfa', ts: 3, rank: 3, nreq: 2, ok: 2 }), R({ id: 'c', title: 'Gama', ts: 2, rank: 1, nreq: 0 })];
  assert.deepEqual(CT.ctSort(rows, 'title', 'asc').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(CT.ctSort(rows, 'upd', 'desc').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(CT.ctSort(rows, 'situacao', 'asc').map((r) => r.id), ['b', 'c', 'a'], 'quem precisa de você primeiro; empate → mais recente');
  assert.deepEqual(CT.ctSort(rows, 'provas', 'desc').map((r) => r.id), ['b', 'a', 'c'], 'sem requisitos vai pro fim');
  assert.deepEqual(CT.ctSort(rows, 'nada', 'asc').map((r) => r.id), ['a', 'c', 'b'], 'chave inválida → atualizado');
  assert.deepEqual(CT.ctNextSort({ key: 'title', dir: 'asc' }, 'title'), { key: 'title', dir: 'desc' });
  assert.deepEqual(CT.ctNextSort({ key: 'title', dir: 'asc' }, 'upd'), { key: 'upd', dir: 'desc' });
  assert.deepEqual(CT.ctNextSort({ key: 'upd', dir: 'desc' }, 'situacao'), { key: 'situacao', dir: 'asc' });
  assert.deepEqual(CT.ctNextSort({ key: 'upd', dir: 'desc' }, 'pr'), { key: 'upd', dir: 'desc' }, 'PR não ordena');
});
test('Central: UMA ação clara por linha, o percurso de etapas e a frase do portão na linha aberta', () => {
  assert.deepEqual(CT.ctAction(R({ status: 'draft' })), { label: 'Iniciar', act: 'play', primary: true });
  assert.equal(CT.ctAction(R({ asking: true })).label, 'Responder');
  assert.equal(CT.ctAction(R({ status: 'plan-review' })).label, 'Aprovar plano');
  assert.equal(CT.ctAction(R({ bucket: 'prontas', status: 'review' })).label, 'Revisar');
  assert.deepEqual(CT.ctAction(R({ bucket: 'praberto', prUrl: 'https://x/pull/2' })), { label: 'Ver PR', act: 'pr', primary: false });
  assert.equal(CT.ctAction(R({ blocked: true, status: 'review' })).label, 'Ver motivo');
  assert.deepEqual(CT.ctAction(R({})), { label: 'Abrir', act: 'open', primary: false });
  const route = CT.ctRouteHtml([{ label: 'Plano', state: 'feito' }, { label: 'Construir', state: 'agora' }, { label: 'Provar', state: 'precisa' }, { label: 'Entregar', state: 'espera' }], 2, 4, 'Construir');
  assert.match(route, /aria-label="etapa 2 de 4: Construir"/);
  assert.match(route, /ctdot f[^]*ctdot a[^]*ctdot p[^]*ctdot e/);
  assert.match(route, /<b>Construir<\/b> · 2 de 4/);
  assert.match(CT.ctRouteHtml([], 0, 0, ''), /ctroute none/);
  assert.equal(CT.ctSentence(R({ nreq: 14, ok: 12 })), '<b>12 de 14 exigidos com prova.</b> Faltam 2 pra liberar a entrega.');
  assert.equal(CT.ctSentence(R({ nreq: 3, ok: 3, ad: 2 })), '<b>3 de 3 exigidos com prova.</b> 2 adiados com motivo. Pode entregar.');
  assert.equal(CT.ctSentence(R({ nreq: 3, ok: 1, gateSt: 'override' })), '<b>1 de 3 exigidos com prova.</b> Liberado sem prova, com motivo.');
  assert.match(CT.ctSentence(R({ nreq: 2, cross: true, loaded: false })), /Provas no outro projeto/);
  assert.match(CT.ctSentence(R({ nreq: 2, ok: 2 })), /Pode entregar\./);
  assert.equal(CT.ctSentence(R({ nreq: 2, loaded: false })), 'conferindo as provas…');
  const rows = [R({ id: 't1', title: 'Header <b>', nreq: 3, ok: 2, ad: 1, pr: '253', prUrl: 'https://x/pull/253', bucket: 'prontas', status: 'review', canAskProof: true }), R({ id: 't2', title: 'Outra' })];
  const h = CT.ctTableHtml(rows, { sort: { key: 'title', dir: 'asc' }, open: new Set(['t1']) });
  assert.match(h, /<th class="ct-title" scope="col" aria-sort="ascending"><button type="button" class="ctsort on" data-ctsort="title"/);
  assert.match(h, /<th class="ct-pr" scope="col">PR<\/th>/, 'PR não ordena');
  assert.equal((h.match(/<tr class="ctrow/g) || []).length, 2);
  assert.match(h, /data-ctrow="t1" tabindex="0" aria-label="Header &lt;b&gt; — rodando"/, 'a linha tem nome (título + situação)');
  assert.match(h, /data-cttog="t1" aria-label="resumo de Header &lt;b&gt;" aria-expanded="true">▾/, 'abrir/recolher é o botão');
  assert.ok(!/<tr[^>]*aria-expanded/.test(h), 'aria-expanded não mora no <tr>');
  assert.ok(!/Header <b>/.test(h), 'título escapado');
  assert.match(h, /<tr class="ctexp" data-ctexp="t1"><td colspan="9">/);
  assert.match(h, /data-dcopen="t1">Abrir tarefa/); assert.match(h, /data-lk="https:\/\/x\/pull\/253">Revisar PR #253/); assert.match(h, /data-rowproof="t1">Pedir a prova que falta/);
  assert.match(h, /<td class="ct-act"><button type="button" class="btn sm primary" data-dcopen="t1">Revisar<\/button>/, 'ação da linha reaproveita os data-* da Central');
  assert.ok(!/class="ctrow[^"]*needs/.test(h), '"Revisar" não ganha a barra de precisa de você');
  assert.match(CT.ctTableHtml([R({ id: 'q', needsYou: true })], {}), /class="ctrow needs"/);
  assert.match(h, /\+1 adiado/);
  assert.equal((h.match(/class="ctexp"/g) || []).length, 1, 'só a linha aberta expande');
});
test('Central: tabela é a vista padrão (uma vez pra todo mundo), cartões/grade/Kanban continuam; arquivo registrado', () => {
  const q = read('js/22-quadro-fluxo.js');
  assert.match(q, /if\(lsGet\('flowViewF1'\)!=='1'\)\{ lsSet\('flowViewF1','1'\); if\(!v \|\| v==='list'\)\{ lsSet\('flowView','table'\); return 'table'; \} \}/, 'só migra lista ou nada escolhido (grade fica)');
  assert.match(q, /function flowTableOk\(\)\{ return flowScope!=='done' && flowGroupBy!=='day'; \}/);
  assert.match(q, /Tabela só na Execução sem agrupar por dia[^`]*\$\{flowTableOk\(\)\?'':' disabled'\}/);
  assert.match(q, /selected=t\.id; render\(\); openOrEdit\(t\); \}\);/, 'data-dcopen = mesmo caminho do Enter (rascunho abre o editor)');
  // abrir a linha e ordenar mexem NO LUGAR (sem refazer a Central a cada clique)
  const wire = cut(ct, 'function ctWire(el, src){', '\n}\n');
  assert.ok(!/renderFlow\(/.test(wire), 'nada de renderFlow no clique');
  assert.match(wire, /insertAdjacentHTML\('afterend', ctExpHtml\(r\)\)/); assert.match(wire, /ctSyncLast\(\)/); assert.match(wire, /clearTimeout\(CT\.clickT\)/);
  assert.match(q, /data-fv="table"/); assert.match(q, /data-fv="list"/); assert.match(q, /data-fv="grid"/); assert.match(q, /data-view="kanban"/);
  assert.match(q, /\} else if\(flowViewEff\(\)==='table' && typeof ctHtml==='function'\)\{/);
  assert.match(q, /ctWire\(el, src\)/);
  assert.match(html, /<script src="js\/64-terminal-integrado\.js"><\/script>\n(?:<script src="js\/65-fabrica\.js"><\/script>\n)?<script src="js\/66-central-tabela\.js"><\/script>/);
  assert.ok(!/setInterval|setTimeout\([^)]*renderFlow/.test(ct), 'sem polling novo');
});

test('ctRow (com os stubs do app): ordem de urgência, provas lendo = 0, adiado conta à parte, pedir prova e outro projeto', () => {
  const PEND = new Set(['ask']); const proofs = { rev: [1], ask: [1] };
  const rowsOf = { rev: [{ text: 'a', st: 'ok', status: 'done', evidence: ['p.png'] }, { text: 'b', st: 'blk', status: 'deferred', note: 'decisão do humano', evidence: [] }, { text: 'c', st: 'na', status: 'pending', evidence: [] }] };
  const c = { esc, escA: esc, console, state: { repo: '/r/proj', tasks: [] }, reqProofCache: {}, lsGet: () => null, lsSet: () => {},
    taskSt: (t) => (PEND.has(t.id) ? 'asking' : t.status), flowBucket: (t) => (PEND.has(t.id) ? 'aguardando' : t.status === 'review' ? 'prontas' : 'andamento'),
    stShort: (s) => s, stColor: () => 'var(--muted)', pendingOf: (id) => (PEND.has(id) ? [{}] : []), pathBase: (p) => String(p).split('/').pop(), taskTs: () => 1,
    loadReqProofs: () => ({ then: () => ({ catch: () => {} }) }), flowRerenderSoon: () => {}, reqRows: (t) => rowsOf[t.id] || [],
    railRank: (st) => ({ asking: 0, review: 3, running: 5 }[st] ?? 6) };
  c.proofGate = (t) => { const rows = c.reqRows(t); if (!rows.length) return { st: 'none', missing: [] }; if (c.reqProofCache[t.id] === undefined) return { st: 'loading', missing: [] }; const miss = rows.filter((r) => !(r.st === 'ok' && r.evidence.length) && !c.reqIsAdiado(r)); return { st: miss.length ? 'unproven' : 'proven', missing: miss }; };
  vm.createContext(c);
  vm.runInContext(ADIADO + cut(ct, '// @ct-puro-inicio', '// @ct-puro-fim') + cut(ct, 'const CT_NEEDS_ST', '/** HTML da tabela'), c);
  const T = (o) => ({ id: 'x', title: 'X', status: 'running', requirements: ['a', 'b', 'c'], ...o });
  let r = vm.runInContext('ctRow', c)(T({ id: 'rev', status: 'review' }));
  assert.equal(r.loaded, false); assert.equal(r.ok, 0, 'lendo as provas: 0, nunca "tudo ok"'); assert.equal(r.ad, 1); assert.equal(r.nreq, 2, 'exigidos = sem o adiado');
  c.reqProofCache.rev = { list: [] };
  r = vm.runInContext('ctRow', c)(T({ id: 'rev', status: 'review' }));
  assert.equal(r.ok, 1); assert.equal(r.canAskProof, true); assert.equal(r.gateSt, 'unproven'); assert.equal(r.needsYou, false, 'pronta pra revisar não é "precisa de você"');
  const ask = vm.runInContext('ctRow', c)(T({ id: 'ask' })), run = vm.runInContext('ctRow', c)(T({ id: 'run' }));
  assert.equal(ask.needsYou, true);
  assert.deepEqual(vm.runInContext('ctSort', c)([run, ask], 'situacao', 'asc').map((x) => x.id), ['ask', 'run'], 'perguntando antes de rodando');
  const cross = vm.runInContext('ctRow', c)(T({ id: 'far', _cross: true, repo: '/r/outro' }));
  assert.equal(cross.cross, true); assert.equal(cross.loaded, false); assert.equal(cross.canAskProof, false);
  assert.match(vm.runInContext('ctSentence', c)({ ...cross, nreq: 3 }), /Provas no outro projeto/, 'estado final, nunca "conferindo…" pra sempre');
});

test('portão: adiado por decisão sua conta como resolvido (igual ao verifyProofs do motor) e não entra no "pedir a prova"', () => {
  const pr = read('js/21-pull-request.js');
  const G = new Function(ADIADO + cut(pr, 'function proofMissingOf(rows)', 'function proofSigOf') + '\nreturn { proofMissingOf };')();
  const rows = [{ text: 'a', st: 'ok', evidence: ['p.png'] }, { text: 'b', st: 'blk', status: 'deferred', note: 'você escolheu a main', evidence: [] }, { text: 'c', st: 'na', evidence: [] }, { text: 'd', st: 'blk', status: 'blocked', note: 'o e-mail só sai em produção', evidence: [] }];
  assert.deepEqual(G.proofMissingOf(rows).map((r) => r.text), ['c', 'd']);
  assert.deepEqual(G.proofMissingOf(rows.slice(0, 2)), [], 'só provado + adiado: liberado');
});

// ---------------- contrato da F1: só estrutura ----------------
test('F1 é só estrutura: as seções novas de CSS usam tokens (sem cor fixa) e não animam', () => {
  const secs = [
    [read('css/95-ciclo.css'), 'redesenho F1 (protótipo aprovado 04/10)'],
    [read('css/95-terminal.css'), 'redesenho F1: requisitos como LINHA DO TEMPO'],
    [read('css/98-terminal-integrado.css'), 'redesenho F1 (protótipo aprovado)'],
    [read('css/40-sidebar-quadro.css'), 'redesenho F1: lateral'],
  ];
  for (const [css, mark] of secs) {
    const i = css.indexOf(mark); assert.ok(i >= 0, mark);
    const s = css.slice(i);
    assert.ok(!/#[0-9a-f]{3,8}\b(?![^{]*\{)/i.test(s.replace(/#fw\w+|#tab\w+|#tlBar|#fwCiclo/g, '')), 'sem cor fixa: ' + mark);
    assert.ok(!/@keyframes|animation:|transition:/.test(s), 'sem animação nova: ' + mark);
  }
});
