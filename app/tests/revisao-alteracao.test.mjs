// "Pedir alteração" + "Chamar outro agente…" no app (mesa 09/10): `node --test app/tests/revisao-alteracao.test.mjs`
// Núcleo puro de 71-revisao-alteracao.js ≡ src/revisao-alteracao.ts (tests/fixtures/revisao-alteracao-golden/), o painel
// (nunca modal), a etapa extra na faixa (60-ciclo) e a FONTE ÚNICA: toda superfície abre a mesma caixa (rqOpen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = rd('../src/js/71-revisao-alteracao.js');
const ciclo = rd('../src/js/60-ciclo.js');
const gold = JSON.parse(rd('../../tests/fixtures/revisao-alteracao-golden/casos.json'));
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const J = (v) => JSON.parse(JSON.stringify(v));
function ctx() { const c = { esc, escA: esc, console }; vm.createContext(c); vm.runInContext(cut(src, '// @rq-puro-inicio', '// @rq-puro-fim'), c); return c; }
const run = (c, code) => vm.runInContext(code, c);

test('golden casos.json: o espelho do app ≡ src/revisao-alteracao.ts', () => {
  const c = ctx();
  for (const [cat, exp] of gold.agents) assert.deepEqual(J(run(c, `rqExtraAgents(${JSON.stringify(cat)})`)), exp);
  for (const [r, exp] of gold.changeRequestText) assert.equal(run(c, `rqChangeText(${JSON.stringify(r)})`), exp);
  for (const [g, exp] of gold.changeGate) assert.deepEqual(J(run(c, `rqChangeGate(${JSON.stringify(g)})`)), exp);
  for (const [s, cap, exp] of gold.extraCapGate) assert.deepEqual(J(run(c, `rqCapGate(${s}, ${cap})`)), exp);
  for (const [q, exp] of gold.resolveExtraAgent) assert.equal(run(c, `(rqResolveAgent(${JSON.stringify(gold.catalog)}, ${JSON.stringify(q)})||{}).id||null`), exp, q);
  for (const [p, exp] of gold.isUiPath) assert.equal(run(c, `rqIsUiPath(${JSON.stringify(p)})`), exp, p);
  for (const [x, exp] of gold.extraReportLines) assert.deepEqual(J(run(c, `rqExtraReportLines(${JSON.stringify(x)})`)), exp);
});

const base = (o = {}) => ({ id: 't1', mode: 'alt', text: '', note: '', reqs: [{ i: 0, text: 'Listar horários', on: true }, { i: 1, text: 'Reservar <já>', on: false }],
  agents: [], agent: '', team: false, gate: { ok: true, why: '' }, cap: { ok: true, why: '', spent: 0.42, capUsd: 5 }, sending: false, ...o });

test('painel "Pedir alteração": texto, anexos (print/mira), requisitos marcados, time inteiro só opt-in', () => {
  const c = ctx();
  const h = run(c, `rqPanelHtml(${JSON.stringify(base({ text: 'o botão some' }))})`);
  assert.match(h, /role="tablist"/);
  assert.match(h, /aria-selected="true" data-rqmode="alt">Pedir alteração/);
  assert.match(h, /<textarea id="rqTx"[^>]*>o botão some<\/textarea>/);
  assert.match(h, /id="rqAttach"/); assert.match(h, /data-rqmira/);
  assert.match(h, /data-rqreq="0" checked/); assert.doesNotMatch(h, /data-rqreq="1" checked/);
  assert.match(h, /R2 Reservar &lt;já&gt;/, 'requisito escapado');
  assert.match(h, /<input type="checkbox" data-rqteam>/, 'time inteiro desmarcado por padrão');
  assert.match(h, /1 turno, na mesma sessão e branch/);
  assert.match(h, /id="rqSend">Mandar pro agente/);
  assert.doesNotMatch(h, /class="modal|role="dialog"/, 'nunca modal');
  const busy = run(c, `rqPanelHtml(${JSON.stringify(base({ gate: { ok: false, why: 'o agente está trabalhando nesta tarefa — espere o turno acabar' } }))})`);
  assert.match(busy, /rqp-warn[^>]*>o agente está trabalhando/);
  assert.match(busy, /id="rqSend" disabled/);
  assert.match(run(c, `rqPanelHtml(${JSON.stringify(base({ team: true }))})`), /O time inteiro roda de novo/);
});

test('painel "Chamar outro agente": lista do time com 1 linha, custo antes de rodar, teto bloqueia', () => {
  const c = ctx();
  const agents = J(run(c, 'rqExtraAgents([])'));
  assert.deepEqual(agents.map((a) => a.kind), ['design', 'revisor', 'qa', 'seguranca', 'performance', 'docs']);
  const h = run(c, `rqPanelHtml(${JSON.stringify(base({ mode: 'agente', agents, agent: 'aria' }))})`);
  assert.match(h, /role="radiogroup"/);
  for (const a of agents) assert.ok(h.includes(esc(a.line)), 'descrição de 1 linha: ' + a.kind);
  assert.match(h, /aria-checked="true" data-rqag="aria"/);
  assert.match(h, /Gasto até agora US\$ 0,42 de US\$ 5,00/);
  assert.match(h, /id="rqRun">Chamar Aria/);
  const cap = J(run(c, 'rqCapGate(4.5, 5)'));
  const blocked = run(c, `rqPanelHtml(${JSON.stringify(base({ mode: 'agente', agents, agent: 'aria', cap: { ...cap, spent: 4.5, capUsd: 5 } }))})`);
  assert.match(blocked, /90% do teto/); assert.match(blocked, /id="rqRun" disabled/);
  assert.match(run(c, `rqPanelHtml(${JSON.stringify(base({ mode: 'agente', agents }))})`), /id="rqRun" disabled>Escolha um agente/);
});

test('faixa: etapa extra entra depois de Revisar com estado; rodando, os papéis da tarefa ficam prontos', () => {
  const c = { esc, escA: esc, console, costCapDefault: () => 5 }; vm.createContext(c);
  for (const [a, b] of [['// @ciclo-puro-inicio', '// @ciclo-puro-fim'], ['// @ciclo-fluxo-inicio', '// @ciclo-fluxo-fim'], ['// @ciclo-faixa-inicio', '// @ciclo-faixa-fim'], ['// @ciclo-relatorio-inicio', '// @ciclo-relatorio-fim']]) run(c, cut(ciclo, a, b));
  const roles = [{ role: 'planner', name: 'Vega' }, { role: 'builder', name: 'Íris' }, { role: 'reviewer', name: 'Nyx' }];
  const ex = (status, files) => ({ id: 'extra-aria-1', agentId: 'aria', name: 'Aria', kind: 'design', role: 'designer', status, files, usd: 0.2 });
  const st = (t) => J(run(c, `taskStages(${JSON.stringify(t)}, {})`)).map((s) => [s.id, s.state, s.word]);
  const t = { id: 't', roles, stage: 'reviewer', spec: { taskKind: 'codigo' } };
  assert.deepEqual(st({ ...t, status: 'running', spec: { ...t.spec, extraStages: [ex('rodando')] } }).slice(0, 5),
    [['plano', 'feito', 'pronto'], ['construir', 'feito', 'pronto'], ['revisar', 'feito', 'pronto'], ['extra-aria-1', 'agora', 'desenhando'], ['provar', 'espera', 'depois']]);
  assert.deepEqual(st({ ...t, status: 'review', spec: { ...t.spec, extraStages: [ex('feito', ['a.css', 'b.css'])] } })[3], ['extra-aria-1', 'feito', '2 arquivos']);
  assert.deepEqual(st({ ...t, status: 'review', spec: { ...t.spec, extraStages: [ex('falhou', [])] } })[3], ['extra-aria-1', 'precisa', 'parou']);
  const label = J(run(c, `taskStages(${JSON.stringify({ ...t, status: 'review', spec: { ...t.spec, extraStages: [ex('feito', [])] } })}, {})`))[3];
  assert.equal(label.label, '+ Design'); assert.equal(label.who, 'Aria'); assert.equal(label.extra, true);
  // relatório do app ≡ motor com a linha da etapa (o caso "etapa extra de design" do relatorio.json)
  const k = JSON.parse(rd('../../tests/fixtures/ciclo-golden/relatorio.json')).cases.find((x) => x.name === 'etapa extra de design');
  assert.ok(k); assert.equal(run(c, `cicloReport(${JSON.stringify(k.input)})`), k.expected);
  assert.match(ciclo, /extraLines:\(typeof rqExtraReportLines==='function'/, 'cicloReportFor manda as etapas pro PR');
});

test('FONTE ÚNICA: cabeçalho, ⋯, Revisão, PR, Central, Time e commit abrem/usam a MESMA caixa', () => {
  const ws = rd('../src/js/20-workspace-tarefa.js');
  assert.match(ws, /id="fwChange"[^`]*>Pedir alteração<\/button>/, 'cabeçalho: "Pedir alteração" à vista');
  assert.match(ws, /id="fwCallAgent"[^`]*>Chamar agente…<\/button>/);
  assert.match(ws, /bindClick\('fwChange', \(\)=>rqOpen\(t\.id\)\)/);
  assert.match(ws, /bindClick\('fwCallAgent', \(\)=>rqOpen\(t\.id, \{ mode:'agente' \}\)\)/);
  assert.match(ws, /k==='askfix'\) rqOpen\(t\.id\)/, '⋯ "pedir alteração" (também com PR aberto) abre a caixa');
  assert.doesNotMatch(ws, /label:'pedir ajuste'/);
  assert.match(ws, /rqPaint\(t\)/, 'o painel pinta no slot da tarefa');
  const rv = rd('../src/js/63-revisao-pr.js');
  assert.match(rv, /d\.rvchg!=null\)\{[^\n]*rqOpen\(taskId, \{ reqs:\[r\.i\] \}\)/, 'Revisão por requisito: abre a caixa com o requisito marcado');
  assert.doesNotMatch(rv, /rvasksend|id="rvAskTx"/, 'a caixinha própria da Revisão saiu (uma só)');
  assert.match(rv, /data-rqopen="\$\{escA\(t\.id\)\}">Pedir alteração<\/button>`:''\}<button type="button" class="btn sm" id="prPgOpen"/, 'aba PR');
  assert.match(rv, /rqExtraBandHtml\(t\)/, 'Revisão destaca o que a etapa extra mudou');
  assert.match(rd('../src/js/66-central-tabela.js'), /data-rqopen="\$\{escA\(r\.id\)\}">Pedir alteração/, 'linha da Central');
  assert.match(rd('../src/js/22-quadro-fluxo.js'), /item\('pedir alteração…', \(\)=>rqOpen\(taskId\)/, '⋯ dos cartões e da Central');
  assert.match(rd('../src/js/70-time-entregas.js'), /rqLocalOfCloud\(t\.id\)[\s\S]*data-rqopen/, 'Time: cartão com tarefa nesta máquina');
  const kb = rd('../src/js/23-kanban-artefatos-editor.js');
  assert.doesNotMatch(kb.slice(kb.indexOf('async function sendRework'), kb.indexOf('async function resolvePending')), /rework_task/, 'commit: 1 turno, não o time inteiro por padrão');
  // ninguém mais monta o texto do pedido por conta própria
  for (const f of ['20-workspace-tarefa.js', '63-revisao-pr.js', '22-quadro-fluxo.js', '66-central-tabela.js']) assert.doesNotMatch(rd('../src/js/' + f), /PEDIDO DE ALTERAÇÃO/, f);
  const html = rd('../src/index.html');
  assert.match(html, /<section class="fwrq" id="fwRq" hidden><\/section>/);
  assert.ok(html.indexOf('js/70-time-entregas.js') < html.indexOf('js/71-revisao-alteracao.js'));
  assert.match(html, /css\/99-revisao-alteracao\.css/);
});

test('ações: pedir alteração vai por fwSendText (talk_task / terminal vivo); time inteiro por rework_task; agente por extra_stage', () => {
  assert.match(src, /ok=await fwSendText\(t\.id, full\)/);
  assert.match(src, /if\(u\.team\)\{ await invoke\('rework_task'/);
  assert.match(src, /u\.team && !await askYes\(/, 'time inteiro confirma o custo antes');
  assert.match(src, /invoke\('extra_stage',\{ taskId:t\.id, agent:ag\.id/);
  assert.match(src, /rqCapGate\(taskCost\(t\.id\)\.usd, budgetOf\(t\)\)/, 'teto conferido antes de chamar');
  const lib = rd('../src-tauri/src/lib.rs');
  assert.match(lib, /fn extra_stage\(state: State<AppState>, task_id: String, agent: String, note: Option<String>\)/);
  assert.match(lib, /term::route\(&state, &task_id, "stage", &n, false, Some\(&a\)\)/, 'terminal vivo: a instrução vai pra mesma sessão');
  assert.match(lib, /"etapa", &task_id, &a/);
  assert.match(lib, /talk_task,\s*extra_stage,/, 'comando registrado');
});
