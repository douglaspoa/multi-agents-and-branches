// MODO TERMINAL · LAYOUT A (spec-terminal-layout-a): funções puras de app/src/js/60-terminal-layout.js (painel de
// requisitos/faixa, folha de pergunta) e do layout do grupo no canvas (19-canvas-puro.js: lado a lado, empilhado,
// grade com o foco grande). `node --test app/tests/terminal-layout.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TL = new Function('esc', 'escA', cut(read('js/60-terminal-layout.js'), '// @tl-puro-inicio', '// @tl-puro-fim') +
  '\nreturn { TL_NARROW, TL_IN_TERMINAL, TL_SKIP_HUMAN, tlReqView, tlCount, tlRailHtml, tlPanelHtml, tlAskGroup, tlAskNew, tlAskAnswers, tlAskKey, tlSheetHtml };')(esc, esc);
const CV = new Function(cut(read('js/19-canvas-puro.js'), '// @canvas-puro-inicio', '// @canvas-puro-fim') +
  '\nreturn { CV_LAYS, CV_GUTTER, cvLayEff, cvLayout, cvDragFracs, cvGridFrac, cvSplitValid };')();

// ---------------- requisitos e provas ----------------
const ROWS = [
  { text: 'botão remarcar', st: 'ok', evidence: ['.cardume/artifacts/mobile-1.png'] },
  { text: 'seletor livre', st: 'blk', evidence: [], note: '' },
  { text: 'aviso por e-mail', st: 'blk', evidence: [], note: 'o e-mail só sai em produção' },
  { text: 'feito sem arquivo', st: 'ok', evidence: [] },
  { text: 'nem começou', st: 'na', evidence: [] },
];
test('requisitos: com prova · em andamento · sem prova (com o motivo) · feito sem arquivo não conta', () => {
  const run = TL.tlReqView(ROWS, true);
  assert.deepEqual(run.map((v) => v.ck), ['ok', 'go', 'no', 'no', 'go']);
  assert.match(run[0].sub, /prova: mobile-1\.png/);
  assert.match(run[2].sub, /o e-mail só sai em produção/);
  assert.match(run[3].sub, /sem arquivo de prova/);
  const idle = TL.tlReqView(ROWS, false);
  assert.deepEqual(idle.map((v) => v.ck), ['ok', 'no', 'no', 'no', ''], 'parado: o que não tem prova é "sem prova"');
  assert.equal(TL.tlCount(run), 1);
});

test('faixa recolhida: bolinha por requisito e "N/M com prova"; painel: portão com a ação certa por fase', () => {
  const view = TL.tlReqView(ROWS, true);
  const rail = TL.tlRailHtml(view, {});
  assert.equal((rail.match(/<i class=/g) || []).length, 5);
  assert.match(rail, /1\/5 com prova/);
  assert.match(rail, /data-tl="unfold"/);
  assert.match(TL.tlRailHtml([], {}), /sem requisitos/);
  const gate = { st: 'unproven', missing: [1] };
  const rev = TL.tlPanelHtml({ view, gate, phase: 'review' });
  assert.match(rev, /data-tl="askproof"/); assert.match(rev, /aprovar sem prova…/);
  assert.match(rev, /aria-valuenow="1"/);
  assert.match(TL.tlPanelHtml({ view, gate: { st: 'proven', missing: [] }, phase: 'review' }), /data-tl="approve"/);
  assert.match(TL.tlPanelHtml({ view, gate, phase: 'working' }), /aprovar exige a prova/);
  assert.match(TL.tlPanelHtml({ view, gate, phase: 'pr' }), /data-tl="pr"/);
  assert.match(TL.tlPanelHtml({ view, gate: { st: 'loading' }, phase: 'review', loading: true }), /conferindo as provas/);
  assert.match(TL.tlPanelHtml({ view: [], gate, phase: 'review' }), /Sem requisitos ainda/);
  assert.ok(!/<script/.test(TL.tlPanelHtml({ view: TL.tlReqView([{ text: '<script>x', st: 'na', evidence: [] }], false), phase: 'idle' })), 'texto escapado');
});

// ---------------- pergunta do agente ----------------
const AUQ = [
  { id: 92, taskId: 't', agent: 'Íris', kind: 'question', prompt: 'Antecedência?', options: ['2h', '24h'], createdAt: 5, meta: { src: 'auq', group: 'tu1', idx: 1, n: 2, header: 'antecedência', desc: ['padrão', ''], multi: false } },
  { id: 91, taskId: 't', agent: 'Íris', kind: 'question', prompt: 'Aula cheia?', options: ['Espera', 'Livres', 'Os dois'], createdAt: 5, meta: { src: 'auq', group: 'tu1', idx: 0, n: 2, header: 'aula cheia', desc: ['avisa', 'simples', ''], multi: false } },
  { id: 93, taskId: 't', agent: 'Íris', kind: 'question', prompt: 'outra rodada', options: [], meta: { src: 'auq', group: 'tu2', idx: 0, n: 1 } },
];
test('grupo da folha: AskUserQuestion junta as perguntas do MESMO tool_use na ordem; ask_human é uma só; teto fica de fora', () => {
  const g = TL.tlAskGroup(AUQ);
  assert.equal(g.key, 'g:tu1'); assert.equal(g.auq, true);
  assert.deepEqual(g.rows.map((r) => r.id), [91, 92], 'ordem do idx');
  assert.equal(g.rows[0].ck, '91|5', 'mesma chave do fwAskSent');
  assert.deepEqual(g.rows[0].desc, ['avisa', 'simples', '']);
  const h = TL.tlAskGroup([{ id: 7, kind: 'question', prompt: 'Qual banco?', options: ['pg', 'sqlite'] }]);
  assert.equal(h.key, 'p:7'); assert.equal(h.auq, false); assert.equal(h.rows.length, 1);
  assert.equal(TL.tlAskGroup([{ id: -1, kind: 'budget', prompt: 'teto' }]), null);
  assert.equal(TL.tlAskGroup([]), null);
});

test('teclado da folha: ↑↓ e 1–N escolhem, ←→ trocam de pergunta, Enter avança/envia, Esc esconde; digitando, só Enter/Esc', () => {
  const g = TL.tlAskGroup(AUQ); let st = TL.tlAskNew(g);
  assert.deepEqual(st.sel, [[0], [0]], 'começa na 1ª opção');
  let r = TL.tlAskKey(g, st, 'ArrowDown', false); assert.deepEqual(r.st.sel[0], [1]);
  r = TL.tlAskKey(g, r.st, 'ArrowUp', false); r = TL.tlAskKey(g, r.st, 'ArrowUp', false); assert.deepEqual(r.st.sel[0], [2], 'dá a volta');
  r = TL.tlAskKey(g, r.st, '2', false); assert.deepEqual(r.st.sel[0], [1]);
  assert.equal(TL.tlAskKey(g, r.st, '9', false).pass, true, 'atalho fora das opções passa');
  r = TL.tlAskKey(g, r.st, 'ArrowRight', false); assert.equal(r.st.q, 1);
  r = TL.tlAskKey(g, r.st, 'ArrowRight', false); assert.equal(r.st.q, 1, 'última fica');
  r = TL.tlAskKey(g, r.st, 'ArrowLeft', false); assert.equal(r.st.q, 0);
  r = TL.tlAskKey(g, r.st, 'Enter', false); assert.equal(r.st.q, 1); assert.equal(r.act, null);
  assert.equal(TL.tlAskKey(g, r.st, 'Enter', false).act, 'send');
  assert.equal(TL.tlAskKey(g, r.st, 'Escape', false).act, 'close');
  assert.equal(TL.tlAskKey(g, r.st, '1', true).pass, true, 'digitando "1" na outra resposta não escolhe opção');
  assert.equal(TL.tlAskKey(g, r.st, 'Enter', true).act, 'send');
  // original intocado (puro)
  assert.deepEqual(st.sel, [[0], [0]]);
});

test('respostas: opção, outra resposta vence, pulada = "" no AskUserQuestion e "siga com a suposição" no ask_human; multi junta', () => {
  const g = TL.tlAskGroup(AUQ); const st = TL.tlAskNew(g);
  st.sel[0] = [1]; st.other[1] = '  só até 12h  ';
  assert.deepEqual(TL.tlAskAnswers(g, st), ['Livres', 'só até 12h']);
  st.skip[0] = true; assert.deepEqual(TL.tlAskAnswers(g, st), ['', 'só até 12h']);
  const m = { key: 'g:x', auq: true, rows: [{ id: 1, prompt: 'avisos?', options: ['e-mail', 'push', 'sms'], desc: [], multi: true }] };
  const ms = TL.tlAskNew(m); assert.deepEqual(ms.sel, [[]], 'multi começa vazio');
  let r = TL.tlAskKey(m, ms, '3', false); r = TL.tlAskKey(m, r.st, '1', false);
  assert.deepEqual(TL.tlAskAnswers(m, r.st), ['e-mail, sms'], 'na ordem das opções');
  r = TL.tlAskKey(m, r.st, '3', false); assert.deepEqual(TL.tlAskAnswers(m, r.st), ['e-mail'], 'clicar de novo desmarca');
  const h = TL.tlAskGroup([{ id: 7, kind: 'question', prompt: 'Qual banco?', options: [] }]); const hs = TL.tlAskNew(h);
  assert.deepEqual(TL.tlAskAnswers(h, hs), [TL.TL_SKIP_HUMAN], 'ask_human sem resposta não fica em branco');
  assert.equal(TL.TL_IN_TERMINAL, '(responder no terminal)', 'igual ao AUQ_IN_TERMINAL do motor');
});

test('folha: abas por pergunta, opções numeradas com descrição, botão da vez e "responder no terminal" só no AskUserQuestion', () => {
  const g = TL.tlAskGroup(AUQ); const st = TL.tlAskNew(g);
  const h = TL.tlSheetHtml(g, st);
  assert.match(h, /role="dialog"/); assert.match(h, /Íris pergunta/);
  assert.equal((h.match(/data-tlq=/g) || []).length, 2);
  assert.equal((h.match(/data-tlopt=/g) || []).length, 3);
  assert.match(h, /<small>avisa<\/small>/);
  assert.match(h, />próxima</); assert.match(h, /data-tl="askterm"/);
  st.q = 1; assert.match(TL.tlSheetHtml(g, st), /enviar respostas/);
  const one = TL.tlAskGroup([{ id: 7, kind: 'question', prompt: 'Qual banco?', options: [] }]);
  const oh = TL.tlSheetHtml(one, TL.tlAskNew(one));
  assert.ok(!/data-tl="askterm"/.test(oh), 'ask_human não tem picker no terminal');
  assert.match(oh, /sua resposta…/); assert.match(oh, />enviar</);
});

// ---------------- canvas: layout do grupo ----------------
test('layout: lado a lado e empilhado com divisórias entre os painéis; grade só com 3 (com 2 vira lado a lado)', () => {
  const s = CV.cvLayout(3, 'side', 0, {});
  assert.equal(s.panes.length, 3); assert.equal(s.splits.length, 2);
  assert.equal(s.panes[1], '1 / 3 / 2 / 4'); assert.equal(s.splits[0].dir, 'v');
  assert.match(s.cols, /6px/); assert.equal(s.rows, 'minmax(0,1fr)');
  const v = CV.cvLayout(2, 'stack', 0, { h: [0.7, 0.3] });
  assert.equal(v.lay, 'stack'); assert.equal(v.splits[0].dir, 'h'); assert.match(v.rows, /0\.700fr.*0\.300fr/);
  assert.equal(CV.cvLayout(2, 'grid', 0, {}).lay, 'side');
  assert.equal(CV.cvLayout(1, 'grid', 0, {}).splits.length, 0);
});
test('grade: o painel em FOCO fica grande à esquerda; os outros empilham à direita na ordem; tamanhos salvos valem', () => {
  const g0 = CV.cvLayout(3, 'grid', 0, {});
  assert.deepEqual(g0.panes, ['1 / 1 / 4 / 2', '1 / 3 / 2 / 4', '3 / 3 / 4 / 4']);
  const g2 = CV.cvLayout(3, 'grid', 2, { g: [0.6, 0.4] });
  assert.deepEqual(g2.panes, ['1 / 3 / 2 / 4', '3 / 3 / 4 / 4', '1 / 1 / 4 / 2'], '⌘3 → a 3ª vai pro grande');
  assert.match(g2.cols, /0\.600fr.*0\.400fr/); assert.match(g2.rows, /0\.400fr.*0\.600fr/);
  assert.deepEqual(g2.splits.map((x) => x.dir), ['v', 'h']);
});
test('arrastar divisória: soma 1, ninguém abaixo do mínimo; grade limita a 25–75%', () => {
  const f = CV.cvDragFracs([500, 500, 500], 0, 120, 200);
  assert.ok(Math.abs(f.reduce((a, b) => a + b, 0) - 1) < 0.002); assert.ok(f[0] > f[1]); assert.equal(f[2], 0.333);
  const g = CV.cvDragFracs([500, 500], 0, -900, 200); assert.equal(Math.round(g[0] * 1000), 200);
  assert.equal(CV.cvGridFrac(100, 0, 1000), 0.25); assert.equal(CV.cvGridFrac(900, 0, 1000), 0.75); assert.equal(CV.cvGridFrac(600, 0, 1000), 0.6);
});
test('grupo salvo: layout e tamanhos por layout voltam; lixo é ignorado sem derrubar o grupo', () => {
  const panes = [{ kind: 'task', taskId: 'a' }, { kind: 'task', taskId: 'b' }, { kind: 'task', taskId: 'c' }];
  const ok = CV.cvSplitValid({ v: 2, panes, lay: 'grid', g: [0.6, 0.45], h: [0.3, 0.3, 0.4] }, ['a', 'b', 'c']);
  assert.equal(ok.lay, 'grid'); assert.deepEqual(ok.g, [0.6, 0.45]); assert.deepEqual(ok.h, [0.3, 0.3, 0.4]);
  const bad = CV.cvSplitValid({ v: 2, panes, lay: 'mosaico', g: [0.9, 0.1], h: [1, 0, 0] }, ['a', 'b', 'c']);
  assert.equal(bad.lay, undefined); assert.equal(bad.g, undefined); assert.equal(bad.h, undefined); assert.equal(bad.panes.length, 3);
});

// ---------------- correções da revisão (4 lentes) ----------------
test('grupo pela metade (snapshot no meio da gravação) não abre a folha; multi: ↑↓ andam pelo cursor', () => {
  assert.equal(TL.tlAskGroup([AUQ[1]]), null, '1 de 2 perguntas: espera');
  const m = { key: 'g:x', auq: true, rows: [{ id: 1, prompt: 'avisos?', options: ['e-mail', 'push', 'sms'], desc: [], multi: true }] };
  let r = TL.tlAskKey(m, TL.tlAskNew(m), 'ArrowDown', false); assert.equal(r.st.cursor, 0);
  r = TL.tlAskKey(m, r.st, 'ArrowDown', false); assert.equal(r.st.cursor, 1, 'sem nada marcado, desce mesmo assim');
  r = TL.tlAskKey(m, r.st, ' ', false); assert.deepEqual(TL.tlAskAnswers(m, r.st), ['push']);
});
test('painel de tarefa encerrada não oferece aprovar', () => {
  const view = TL.tlReqView(ROWS, false);
  const h = TL.tlPanelHtml({ view, gate: { st: 'unproven', missing: [1] }, phase: 'closed' });
  assert.ok(!/data-tl="(approve|askproof|noproof)"/.test(h)); assert.ok(!/aprovar exige/.test(h));
});
test('divisória em painéis estreitos: nunca negativo nem abaixo dos 12% que o grupo salvo aceita', () => {
  const f = CV.cvDragFracs([150, 150, 150], 0, -500, 200);
  assert.ok(f.every((x) => x > 0)); assert.ok(f[0] >= 0.12, String(f));
  assert.ok(Math.abs(f.reduce((a, b) => a + b, 0) - 1) < 0.002);
});
// Configurações ↔ term.rs: o MESMO quadro de casos do teste Rust (modo_padrao_tests)
test('tela de Configurações mostra o mesmo modo que o term.rs usa (TS≡Rust) e só grava o que foi escolhido', () => {
  const cfg = read('js/15-config-abas-onboarding.js');
  const F = new Function(cut(cfg, 'function cfgTaskModeOf', 'function cfgHide') + '\nreturn { cfgTaskModeOf, cfgTaskModeShouldSave };')();
  // mode_default(None,None)=terminal · (auto,None)=terminal · (auto,"2")=auto · (terminal,"2")=terminal
  assert.equal(F.cfgTaskModeOf({}), 'terminal');
  assert.equal(F.cfgTaskModeOf({ taskMode: 'auto' }), 'terminal', 'auto da tela antiga não é escolha');
  assert.equal(F.cfgTaskModeOf({ taskMode: 'auto', taskModeSet: '2' }), 'auto');
  assert.equal(F.cfgTaskModeOf({ taskMode: 'terminal', taskModeSet: '2' }), 'terminal');
  assert.equal(F.cfgTaskModeShouldSave('terminal', undefined, ''), false, 'antes de ler: não grava');
  assert.equal(F.cfgTaskModeShouldSave('auto', 'auto', 'auto'), false, 'nada mudou');
  assert.equal(F.cfgTaskModeShouldSave('auto', 'terminal', ''), true);
  assert.equal(F.cfgTaskModeShouldSave('terminal', 'terminal', ''), true, 'salvar com Terminal na tela vira escolha (Codex)');
  assert.equal(F.cfgTaskModeShouldSave('terminal', 'terminal', 'terminal'), false);
  const rs = read('../src-tauri/src/term.rs');
  for (const c of ['mode_default(None, None), "terminal"', 'mode_default(Some("auto"), None), "terminal"', 'mode_default(Some("auto"), Some("2")), "auto"', 'mode_default(Some("terminal"), Some("2")), "terminal"']) assert.ok(rs.includes(c), 'caso espelhado no Rust: ' + c);
});
