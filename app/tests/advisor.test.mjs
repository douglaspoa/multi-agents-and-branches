// CONSELHEIRO (advisor do Claude Code) no app: `node --test app/tests/advisor.test.mjs`
// A regra do front (29-ia-picker.js @advisor-puro) é a MESMA do motor (src/advisor.ts) — comparadas aqui numa tabela;
// a linha "Conselheiro" da folha (só com o Claude, par recusado desligado com o motivo), o payload do new_task
// (escolha da tela ou o padrão; DeepSeek/Codex = 'off') e onde aparece (faixa da tarefa, Entrega, doca do terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { advisorPair, cliVersionOk } from '../../src/advisor.ts';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const SRC = read('js/29-ia-picker.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho: ' + a); return s.slice(i, j); };
const fn = (s, name) => { const i = s.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, k = s.indexOf('{', i); for (; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) break; } return s.slice(i, k + 1) + '\n'; };
let DEF = '';
const ctx = { console, esc: (s) => String(s), escA: (s) => String(s), lsGet: (k) => (k === 'defaultAdvisor' ? DEF : ''), envChecks: null };
vm.createContext(ctx);
vm.runInContext(cut(SRC, '// @advisor-puro-inicio', '// @advisor-puro-fim') + fn(SRC, 'aiEngineOf') + fn(SRC, 'aiDefaults') + fn(SRC, 'advCliVersion') + fn(SRC, 'aiAdvisorFill') + fn(SRC, 'iaAdvHtml') +
  '\nglobalThis.P={ advNorm, advPair, advCliOk, advForTask, advLabel, advCalls, advEntregaSub, aiAdvisorFill, iaAdvHtml, aiDefaults, ADV_WHY, ADV_MIN_CLI, ADV_OPTS, ADV_FABLE_NOTE };', ctx);
const P = ctx.P;

test('front ≡ motor: mesmos pares aceitos/recusados e mesma regra de versão', () => {
  const engines = ['claude', 'deepseek', 'codex', 'gateway'];
  const models = ['', 'opus', 'sonnet', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'gpt-6-astra'];
  for (const e of engines) for (const m of models) for (const a of ['', 'opus', 'fable']) {
    const f = P.advPair(e, m, a), t = advisorPair(e, m, a);
    assert.equal(f.ok, t.ok, `${e} ${m} ${a}`); assert.equal(f.why, t.why, `${e} ${m} ${a}`);
  }
  for (const v of ['2.1.280 (Claude Code)', '2.1.260', '2.1.259', '2.0.1', '10.0.0', '', null]) assert.equal(P.advCliOk(v), cliVersionOk(v), String(v));
});

test('pares recusados: Fable principal recusa Opus; DeepSeek nunca (explica a API da Anthropic)', () => {
  assert.equal(P.advPair('claude', 'claude-fable-5-1', 'opus').ok, false);
  const ds = P.advPair('deepseek', '', 'opus'); assert.equal(ds.ok, false); assert.match(ds.why, /API da Anthropic/);
  assert.equal(P.advPair('deepseek', '', '').ok, true, 'desligado sempre vale');
});

test('payload do new_task: só a escolha explícita vale; ausente = off; motor não-Claude/par recusado = off', () => {
  DEF = 'opus';
  assert.equal(P.aiDefaults().advisor, 'opus');
  assert.equal(P.aiAdvisorFill({ engine: 'claude', model: 'claude-sonnet-5' }).advisor, 'off', 'sem escolha (criação em segundo plano) → desligado, mesmo com padrão');
  assert.equal(P.aiAdvisorFill({ engine: 'claude', model: 'claude-sonnet-5', advisor: 'opus' }).advisor, 'opus', 'escolha da tela vale');
  assert.equal(P.aiAdvisorFill({ engine: 'claude', model: 'claude-sonnet-5', advisor: '' }).advisor, 'off', 'desligou nesta demanda');
  assert.equal(P.aiAdvisorFill({ engine: 'claude', model: '', advisor: 'fable' }).advisor, 'fable');
  assert.equal(P.aiAdvisorFill({ engine: 'deepseek', model: '' }).advisor, 'off', 'DeepSeek desliga');
  assert.equal(P.aiAdvisorFill({ engine: 'codex', advisor: 'opus' }).advisor, 'off');
  assert.equal(P.aiAdvisorFill({ engine: 'claude', model: 'claude-fable-5-1', advisor: 'opus' }).advisor, 'off', 'par recusado');
  DEF = '';
  assert.equal(P.aiAdvisorFill({ engine: 'claude' }).advisor, 'off', 'padrão = desligado');
});

test('rótulo da faixa/Entrega: diz o que foi PEDIDO e, quando o motor viu, quantas consultas', () => {
  assert.equal(P.advLabel({ engine: 'claude', spec: { advisor: 'opus' } }), 'pedido: conselheiro (Opus)');
  assert.equal(P.advLabel({ engine: 'claude', spec: { advisor: 'fable', advisorCalls: 3 } }), 'pedido: conselheiro (Fable) · consultado 3×');
  assert.equal(P.advLabel({ engine: 'claude', spec: {} }), '');
  assert.equal(P.advLabel({ engine: 'deepseek', spec: { advisor: 'opus' } }), '');
});

test('linha "Conselheiro" da folha: só com o Claude; explica; par recusado e Claude Code velho ficam desligados com o motivo', () => {
  assert.equal(P.iaAdvHtml({ engine: 'codex', model: '' }, ''), '');
  const h = P.iaAdvHtml({ engine: 'claude', model: 'claude-sonnet-5' }, 'opus');
  assert.match(h, /Conselheiro/); assert.match(h, /antes do plano, quando um erro se repete e antes de terminar/); assert.match(h, /Custa por consulta/); assert.match(h, /Experimental/i);
  assert.match(h, /data-iaadv="opus" aria-checked="true"|class="ias-ac on"[^>]*data-iaadv="opus"/);
  assert.match(h, /precisa de acesso/, 'Fable avisa do acesso');
  const fb = P.iaAdvHtml({ engine: 'claude', model: 'claude-fable-5-1' }, '');
  assert.match(fb, /data-iaadv="opus" disabled[^>]*title="com Fable como modelo principal/);
  ctx.envChecks = [{ name: 'Claude Code (opcional)', ok: true, detail: '2.1.100 (Claude Code) · /x/claude' }];
  const old = P.iaAdvHtml({ engine: 'claude', model: '' }, '');
  assert.match(old, /Precisa atualizar o Claude Code \(instalado 2\.1\.100, mínimo 2\.1\.260\)/);
  assert.match(old, /data-iaadv="opus" disabled/);
  ctx.envChecks = null;
});

test('ligações: pílula da Nova demanda/Formulário/Ajustes com conselheiro; payload passa pelo trkBeforeNewTask; Rust repassa', () => {
  const planner = read('js/32-planner.js'), aj = read('js/67-ajustes.js'), trk = read('js/14-issues-projeto.js');
  assert.match(planner, /recommend:plRecommend, advisor:true, advisorValue:plFields\.advisor/);
  assert.match(planner, /advisor:plFields\.advisor!==undefined\?plFields\.advisor:aiDefaults\(\)\.advisor, approval:'auto'/);
  assert.match(SRC, /advisor:true, advisorValue:aiFormAdvisor\(\)/, 'Formulário');
  assert.match(aj, /advisor:isDefault/, 'Ajustes › Motores e chaves: o padrão');
  assert.match(aj, /aiSaveDefaults\(v\.engine, v\.model\|\|'', v\.advisor\)/);
  assert.match(trk, /payload=aiAdvisorFill\(payload\)/);
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(rs, /advisor: Option<String>,\n[^\n]*\n    org_policy: Option<serde_json::Value>,\n\) -> Result<String, String> \{/);
  assert.match(rs, /if let Some\(a\) = advisor_flag\(advisor\.as_deref\(\)\) \{ args\.push\("--advisor"/);
  assert.match(read('js/60-terminal-layout.js'), /advLabel\(t\)/, 'faixa da tarefa');
  assert.doesNotMatch(read('js/27-entregas.js'), /consultas incluídas no custo/, 'Entrega não afirma o que pode não ter acontecido');
  assert.match(read('js/64-terminal-integrado.js'), /patch_task_spec',\{ taskId, patch:\{ advisor:o\.id\|\|null \} \}/, 'doca do terminal troca na tarefa existente');
});

// `//` engolindo código: a varredura geral de atrap-fabrica.test.mjs já cobre todos os js do app

test('tokens nos dois temas: o CSS novo não usa cor fixa', () => {
  const css = read('css/98-fabrica.css') + read('css/95-terminal.css') + read('css/98-terminal-integrado.css');
  for (const sel of ['.ias-adv', '.ias-ac', '.ias-advw', '.iapill .iaadv', '.tladv', '.tiadv']) {
    const rules = css.split('\n').filter((l) => l.includes(sel + '{') || l.includes(sel + '.'));
    assert.ok(rules.length, sel);
    for (const r of rules) assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(r), 'cor fixa em ' + sel);
  }
});

// ---- COMPORTAMENTO a partir da tarefa como o snapshot de verdade entrega (lib.rs task_front_spec + advisorCalls) ----
const snapTask = (spec) => ({ id: 't1', engine: 'claude', model: 'claude-sonnet-5', roles: [{ role: 'builder', name: 'Íris', engine: 'claude', model: 'claude-sonnet-5' }], spec });
const TI = read('js/64-terminal-integrado.js');

test('tarefa do snapshot com spec.advisor: faixa, Entrega e doca mostram; a doca DESLIGA (patch advisor:null)', async () => {
  const t = snapTask({ termMode: 'terminal', advisor: 'opus', advisorCalls: 2 });
  assert.equal(P.advLabel(t), 'pedido: conselheiro (Opus) · consultado 2×');
  const calls = [], menus = [];
  const c = Object.assign(Object.create(null), { console, esc: String, escA: String, toast() {}, showErr(e) { throw e; }, refresh: async () => {}, lastSig: 'x',
    state: { tasks: [t] }, invoke: async (cmd, a) => { calls.push([cmd, a]); }, g2SheetMenu: (b, items) => menus.push(items), tiAiRowReset() {}, $id: () => null });
  vm.createContext(c);
  vm.runInContext(cut(SRC, '// @advisor-puro-inicio', '// @advisor-puro-fim') + fn(SRC, 'aiEngineOf') + fn(TI, 'tiTask') + fn(TI, 'tiTaskAi') + fn(TI, 'tiTaskModel') + fn(TI, 'tiAdvChip') + fn(TI, 'tiAdvMenu') + '\nglobalThis.X={ tiAdvChip, tiAdvMenu };', c);
  assert.match(c.X.tiAdvChip(t), /Conselheiro: <b>Opus<\/b>/);
  assert.match(c.X.tiAdvChip(snapTask({ termMode: 'terminal' })), /Conselheiro: <b>desligado<\/b>/);
  assert.equal(c.X.tiAdvChip(Object.assign(snapTask({ advisor: 'opus' }), { engine: 'deepseek' })), '', 'DeepSeek: sem o botão');
  c.X.tiAdvMenu('t1', {});
  const off = menus[0].find((m) => /Desligado/.test(m.label));
  await off.fn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['patch_task_spec', { taskId: 't1', patch: { advisor: null } }]]);
});

test('Formulário: ao repintar (reset) a pílula recebe o conselheiro atual, não o velho', () => {
  const sel = (v) => ({ value: v, options: [], add(o) { this.options.push(o); } });
  const els = { ntEngine: sel('claude'), ntModel: sel(''), howModel: sel('') };
  const sets = [];
  const host = { innerHTML: '', contains: () => true, querySelector: () => null };
  host.__ia = { set: (v) => sets.push(v), pill: {} };
  let LS = { defaultAdvisor: 'fable' };
  const c2 = { console, esc: String, escA: String, IC: {}, lsGet: (k) => LS[k] ?? null, lsSet() {}, invoke: async () => '', window: {},
    $id: (id) => els[id] || null, document: { querySelectorAll: (q) => (q === '.aipick' ? [host] : []) }, Option: function () {}, iaPick: () => ({}) };
  c2.window = c2; vm.createContext(c2);
  vm.runInContext(SRC.replace(/\naiApplyDefaults\(\);[\s\S]*$/, '\n'), c2);
  vm.runInContext("AI_FORM_ADV='opus'; aiPickRender(); aiApplyDefaults(); aiPickRender();", c2);
  assert.deepEqual(sets.map((v) => v.advisor), ['opus', 'fable'], 'escolha da demanda, depois (reset) o padrão');
});

test('Time: o cartão compartilhado não leva o conselheiro; quem assume usa o PRÓPRIO padrão (épico automático: desligado)', async () => {
  const NUV = read('js/42-nuvem-sync-mobile.js');
  const c = { console }; vm.createContext(c);
  vm.runInContext(fn(NUV, 'cloudSpecOf') + '\nglobalThis.f=cloudSpecOf;', c);
  const out = c.f({ title: 'x', advisor: 'opus', engine: 'claude' });
  assert.equal('advisor' in out, false); assert.equal(out.title, 'x');
  // compartilhar (cartão do time, com a issue e dispatch:'team' — #141) e "pra si" usam o filtro
  assert.match(NUV, /spec:\{ \.\.\.cloudSpecOf\(spec\), dispatch:'team' \}[\s\S]*spec:cloudSpecOf\(payload\) \}\);/, 'compartilhar e "pra si" usam o filtro');
  const TIMES = read('js/43-espaco-times.js'), made = [];
  const run = async (auto) => {
    const c3 = { console, window: {}, defaultAiEngine: () => 'claude', aiDefaults: () => ({ eng: 'claude', model: '', advisor: '' }), epicDoneWhenOf: () => null,
      sbRpc: async () => ({ ok: true }), trkBeforeNewTask: async (p) => p, invoke: async (cmd, p) => { made.push(p); return 'loc1'; }, tmapSet() {}, sbFetch: async () => ({}), sbPost: async () => ({}),
      cloudUserId: () => 'u2', refresh: async () => {}, tsClaimShow: () => [], toast() {}, showErr(e) { throw e; } };
    vm.createContext(c3);
    vm.runInContext('let teamTasks, lastSig, allTasksAt;\nasync ' + fn(TIMES, 'teamClaimStart') + '\nglobalThis.go=teamClaimStart;', c3);
    await c3.go({ id: 'c1', title: 'cartão', spec: { title: 'cartão', advisor: 'opus' } }, null, { auto, silent: true });
  };
  await run(false); await run(true);
  assert.deepEqual(made.map((p) => p.advisor), ['', 'off'], 'o "opus" do autor some: padrão de quem roda (vazio) e automático desligado');
});

test('texto honesto por modo: terminal nunca diz "nenhuma consulta"; headless mostra consultado N× ou nenhuma', () => {
  const term = { engine: 'claude', spec: { termMode: 'terminal', advisor: 'opus' } };
  assert.equal(P.advLabel(term), 'pedido: conselheiro (Opus)', 'faixa: só o pedido');
  assert.equal(P.advEntregaSub(term), 'pedido · no modo terminal as consultas não aparecem aqui (o custo já está no total)');
  assert.doesNotMatch(P.advLabel(term) + P.advEntregaSub(term), /nenhuma consulta/);
  const auto = { engine: 'claude', spec: { termMode: 'auto', advisor: 'opus' } };
  assert.equal(P.advEntregaSub(auto), 'pedido · nenhuma consulta registrada');
  assert.equal(P.advEntregaSub({ engine: 'claude', spec: { advisor: 'opus', advisorCalls: 2 } }), 'pedido · consultado 2×');
  assert.equal(P.advLabel({ engine: 'claude', spec: { advisor: 'opus', advisorCalls: 2 } }), 'pedido: conselheiro (Opus) · consultado 2×');
});
