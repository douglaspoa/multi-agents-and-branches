// BLOQUEADORES DE LANÇAMENTO do fluxo de trabalho (mesa-bugs-2 itens 8–11; o 12 é teste Rust em lib.rs
// stop_task_status_tests): IA do Conversar por motor, Formulário por aba, correção linkada como aba e terminal no painel.
// `node --test app/tests/bloq-trabalho.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const picker = read('js/29-ia-picker.js'), planner = read('js/32-planner.js'), form = read('js/31-nova-demanda-form.js'),
  tabs = read('js/15-config-abas-onboarding.js'), util = read('js/00-util.js');

test('8 · Codex escolhido no Conversar não herda o modelo padrão do Claude (padrão só vale no MESMO motor)', () => {
  const src = cut(picker, 'function aiEngineOf(e)', '\n') + '\n' + cut(planner, 'function plModelNow(){', '\n');
  const run = (fields, def) => new Function('plFields', 'lsGet', src + '\nfunction aiDefaults(){ return { eng:'+JSON.stringify(def.eng)+', model:'+JSON.stringify(def.model)+' }; }\nreturn plModelNow();')(fields, () => '');
  assert.deepEqual(run({ engine: 'codex', model: '' }, { eng: 'claude', model: 'claude-opus-5-5' }), { eng: 'codex', model: '' }, 'Codex vai vazio = padrão do Codex');
  assert.deepEqual(run({ engine: 'claude', model: '' }, { eng: 'claude', model: 'claude-opus-5-5' }), { eng: 'claude', model: 'claude-opus-5-5' }, 'mesmo motor: usa o padrão');
  assert.deepEqual(run({ engine: 'codex', model: '' }, { eng: 'codex', model: 'gpt-5' }), { eng: 'codex', model: 'gpt-5' });
  assert.deepEqual(run({ engine: 'codex', model: 'gpt-5.1' }, { eng: 'claude', model: 'claude-opus-5-5' }), { eng: 'codex', model: 'gpt-5.1' }, 'escolhido explícito vence');
  assert.deepEqual(run({ engine: 'claude', model: '' }, { eng: 'codex', model: 'gpt-5' }), { eng: 'claude', model: '' }, 'Claude não herda modelo do Codex');
  // aprovar local / épico / criar passam todos pelo plModelNow (nenhum lê aiDefaults().model direto)
  for (const f of ['async function plApproveLocal', 'async function plCreateEpic']) assert.match(cut(planner, f, '\n}\n'), /plModelNow\(\)/);
  assert.ok(!/aiDefaults\(\)\.model/.test(planner), 'nada no planner cai no modelo padrão sem olhar o motor');
});

// mini-sistema de abas: o bastante pra closeNewTask / ntOpenFormTab / ntSubmitDone
function formWorld() {
  const W = { TABS: [{ id: 'flow', kind: 'flow' }], activeTab: 'flow', closed: [], removed: [], resets: 0, overlayHidden: 0, seq: 0, openRefuse: false };
  const src = cut(form, '// a aba ATIVA do Formulário foi fechada', 'function ntShow(){') + cut(planner, 'let ntSubmitCtx=', 'async function submitNewTaskInner');
  const body = `let ntEditingDraft=null, ntLinkedTo=null, ntSubmitting=false;
    const tabById=id=>W.TABS.find(t=>t.id===id);
    Object.defineProperty(globalThis,'__w',{ value:W, configurable:true });
    function closeTab(id){ const i=W.TABS.findIndex(t=>t.id===id); if(i<0) return; if(W.TABS[i].kind==='form' && id===W.activeTab) ntFormTabClosed(); W.closed.push(id); W.TABS.splice(i,1); if(W.activeTab===id) W.activeTab=(W.TABS[i-1]||W.TABS[0]).id; }
    function resetNewTask(){ W.resets++; ntEditingDraft=null; ntLinkedTo=null; }
    async function openNewTask(){}
    async function submitNewTaskInner(){ return W.inner && W.inner({ get draft(){ return ntEditingDraft; }, set draft(v){ ntEditingDraft=v; }, set linked(v){ ntLinkedTo=v; }, get linked(){ return ntLinkedTo; } }); }
    const invoke=(c,a)=>{ if(c==='remove_task') W.removed.push(a.taskId); return Promise.resolve(); };
    const $id=()=>({ style:{ set display(v){ if(v==='none') W.overlayHidden++; } } });
    const window={ openTab:(k)=>{ if(W.openRefuse) return; const t={ id:k+':'+(++W.seq), kind:k }; W.TABS.push(t); W.activeTab=t.id; resetNewTask(); window.ntOpening=W.switchTo ? Promise.resolve().then(()=>{ W.activeTab=W.switchTo; }) : Promise.resolve(); } };
    ${src.replace(/\bactiveTab\b/g, 'W.activeTab')}
    return { closeNewTask, ntFormTabClosed, ntOpenFormTab, submitNewTask, ntSubmitDone, g:{ get draft(){ return ntEditingDraft; }, set draft(v){ ntEditingDraft=v; }, get linked(){ return ntLinkedTo; }, set linked(v){ ntLinkedTo=v; } } };`;
  const api = new Function('W', body)(W);
  return { W, ...api };
}

test('9 · fechar a aba do Formulário solta o rascunho/link: a próxima criação não apaga o rascunho', async () => {
  const { W, closeNewTask, ntOpenFormTab, submitNewTask, g } = formWorld();
  // aba A edita o rascunho d1 e é fechada no X: a próxima criação não apaga d1
  assert.equal(await ntOpenFormTab(), true); g.draft = 'd1'; g.linked = 't9';
  closeNewTask();
  assert.equal(g.draft, null, 'rascunho solto ao fechar'); assert.equal(g.linked, null, 'link solto ao fechar');
  await ntOpenFormTab(); W.inner = (x) => { assert.equal(x.draft, null, 'aba nova começa sem rascunho'); };
  await submitNewTask(true);
  assert.deepEqual(W.removed, [], 'nenhum rascunho apagado por uma aba que não o edita');
});

test('9 · ntSubmitDone usa o contexto do clique (aba + rascunho), não os globais da aba que está na tela', async () => {
  const { W, ntOpenFormTab, submitNewTask, ntSubmitDone, g } = formWorld();
  await ntOpenFormTab(); const B = W.activeTab; g.draft = 'd2';
  await ntOpenFormTab(); const C = W.activeTab;
  W.activeTab = B; g.draft = 'd2';
  W.inner = async () => { W.activeTab = C; g.draft = 'd3'; const r0 = W.resets; ntSubmitDone(); W.resetDuring = W.resets - r0; };
  await submitNewTask(true);
  assert.deepEqual(W.removed, ['d2'], 'apaga só o rascunho que a aba B editava');
  assert.deepEqual(W.closed, [B], 'fecha só a aba B');
  assert.equal(W.activeTab, C, 'a aba C continua na tela');
  assert.equal(g.draft, 'd3', 'o rascunho da aba C fica intacto');
  assert.equal(W.resetDuring, 0, 'não limpa os campos da aba C');
});

test('9 · aba NOVA de Formulário começa limpa; resetNewTask solta o rascunho; fechar a aba ativa avisa o formulário', () => {
  assert.match(cut(tabs, 'function viewOpen', '\n}\n'), /form:\(\)=>\{ if\(fresh\|\|!window\.ntShow\)\{ if\(fresh && typeof resetNewTask==='function'\) resetNewTask\(\); window\.ntOpening=openNewTask\(\); \}/);
  assert.match(cut(tabs, 'function closeTab(id)', '\n}\n'), /if\(kind==='form' && id===activeTab && typeof ntFormTabClosed==='function'\) ntFormTabClosed\(\);/);
  assert.match(cut(form, 'function resetNewTask', '\n'), /ntEditingDraft=null/);
  assert.ok(!/closeTabOfKind\('form'\)/.test(form + planner), 'ninguém fecha "a última aba de Formulário" no escuro');
});

test('10 · correção linkada / entrega do design / Nova tarefa / chat abrem o Formulário como ABA própria', async () => {
  for (const f of ['async function openFromDesign', 'async function openLinkedFix']) {
    const b = cut(form, f, '\n}\n');
    assert.match(b, /if\(!await ntOpenFormTab\(\)\) return;/, f); assert.ok(!/await openNewTask\(\)/.test(b), f + ' sem modal');
  }
  assert.match(read('js/33-switcher-projetos.js'), /\$id\("newTaskBtn"\)\.onclick = \(\)=>ntOpenFormTab\(\);/);
  assert.match(cut(read('js/12-chat-prefs-daily.js'), 'async function pcToTask(){', '\nfunction openPc(){'), /if\(!await ntOpenFormTab\(\)\) return;/);
  assert.match(read('js/24-perguntas-agente.js'), /if\(!await ntOpenFormTab\(\)\) return;/);
  // comportamento: abre uma aba nova (limpa), e quando o openTab recusa (sem projeto/git) não preenche nada
  const { W, ntOpenFormTab, closeNewTask } = formWorld();
  W.TABS.push({ id: 'form:bia', kind: 'form' });
  assert.equal(await ntOpenFormTab(), true); const mine = W.activeTab;
  assert.notEqual(mine, 'form:bia'); assert.equal(W.resets, 1, 'aba nova = limpa');
  closeNewTask(mine);
  assert.deepEqual(W.closed, [mine]); assert.ok(W.TABS.some(t => t.id === 'form:bia'), 'a aba da Bia continua aberta');
  closeNewTask(mine); assert.deepEqual(W.closed, [mine], 'aba já fechada: não fecha outra');
  assert.equal(W.activeTab, 'form:bia');
  W.openRefuse = true; assert.equal(await ntOpenFormTab(), false, 'recusou com a aba da Bia na tela: não preenche a dela');
});

test('11 · painel do canvas: term-data/term-exit chegam, só os da demanda do painel', async () => {
  const block = cut(util, 'const SF_PANE=', '\n}\n') + '\n}';
  const got = [], listened = {};
  const parent = { __TAURI__: { event: { listen: (name, fn) => { listened[name] = fn; return Promise.resolve(() => {}); } }, core: {} } };
  const win = { parent, setInterval() {}, setTimeout() {} };
  const doc = { documentElement: { classList: { add() {} } }, addEventListener() {} };
  new Function('window', 'location', 'document', 'URLSearchParams', block)(win, { search: '?sfpane=task:t1' }, doc, URLSearchParams);
  const L = win.__TAURI__.event.listen;
  for (const ev of ['term-data', 'term-exit', 'env-progress', 'checks-progress']) await L(ev, (e) => got.push([ev, e.payload]));
  await L('notif-open', () => got.push(['notif']));
  assert.deepEqual(Object.keys(listened).sort(), ['checks-progress', 'env-progress', 'term-data', 'term-exit']);
  listened['term-data']({ payload: { taskId: 't1', data: 'oi' } });
  listened['term-data']({ payload: { taskId: 't2', data: 'outro' } });
  listened['term-exit']({ payload: { taskId: 't1', code: 0 } });
  listened['term-exit']({ payload: { taskId: 't2', code: 0 } });
  listened['env-progress']({ payload: { line: 'x' } });
  assert.deepEqual(got, [['term-data', { taskId: 't1', data: 'oi' }], ['term-exit', { taskId: 't1', code: 0 }], ['env-progress', { line: 'x' }]]);
});

test('revisão · X/Cancelar do Formulário fecham (o MouseEvent do onclick não vira id de aba)', async () => {
  assert.match(read('js/33-switcher-projetos.js'), /\$id\("ntClose"\)\.onclick = \(\)=>closeNewTask\(\);[^\n]*\n\$id\("ntCancel"\)\.onclick = \(\)=>closeNewTask\(\);/);
  const { W, ntOpenFormTab, closeNewTask } = formWorld();
  await ntOpenFormTab(); const mine = W.activeTab;
  closeNewTask({ type: 'click', target: {} });
  assert.deepEqual(W.closed, [mine], 'evento no lugar do id: fecha a aba ativa do Formulário');
});

test('revisão · trocou de aba enquanto o Formulário abria: quem chamou não preenche nada', async () => {
  const { W, ntOpenFormTab } = formWorld();
  W.TABS.push({ id: 'form:bia', kind: 'form' }); W.switchTo = 'form:bia';
  assert.equal(await ntOpenFormTab(), false);
});

test('revisão · "Recomeçar do zero" mantém o rascunho em edição; editar o MESMO rascunho volta pra aba dele', () => {
  assert.match(form, /onOk:\(\)=>\{ const ed=\(typeof ntEditingDraft!=='undefined'\)\?ntEditingDraft:null; resetNewTask\(\); if\(ed\) ntEditingDraft=ed;/);
  const ed = cut(read('js/24-perguntas-agente.js'), 'async function editDraft(t){', 'if(!await ntOpenFormTab()) return;');
  // roda o trecho de reaproveitar: aba de fundo com o rascunho → ativa ela; ativa editando ele → fica; outro rascunho → segue pra abrir aba nova
  const run = (TABS, activeTab, ntEditingDraft, id) => { let act = null;
    const f = new Function('TABS', 'activeTab', 'ntEditingDraft', 'activateTab', 'ntPaneDelegate', 't', ed.replace('async function editDraft(t){', '') + '\nreturn "nova";');
    const r = f(TABS, activeTab, ntEditingDraft, (id2) => { act = id2; }, () => false, { id }); return act || r; };
  const T = [{ id: 'flow', kind: 'flow' }, { id: 'form:1', kind: 'form', state: { ntEditingDraft: 'd1' } }, { id: 'form:2', kind: 'form', state: null }];
  assert.equal(run(T, 'flow', null, 'd1'), 'form:1', 'aba de fundo com o rascunho');
  assert.equal(run(T, 'form:2', 'd2', 'd2'), 'form:2', 'a aba ativa já edita esse rascunho');
  assert.equal(run(T, 'form:2', null, 'd9'), 'nova', 'outro rascunho: aba nova');
});

test('revisão · previsão usa o modelo do MESMO motor (Codex não estima com o modelo do Claude)', () => {
  const src = cut(picker, 'function aiEngineOf(e)', '\n') + '\n' + cut(planner, 'function plModelNow(){', '\n') + '\n' + cut(read('js/33-previsao.js'), 'function estDraft(){', '\nfunction estKey');
  const run = (fields) => new Function('plFields', src + '\nfunction aiDefaults(){ return { eng:"claude", model:"claude-opus-5-5" }; }\nreturn estDraft().model;')(fields);
  assert.equal(run({ engine: 'codex', model: '' }), '');
  assert.equal(run({ engine: 'claude', model: '' }), 'claude-opus-5-5');
  assert.equal(run({ engine: 'codex', model: 'gpt-5' }), 'gpt-5');
});

test('revisão · no painel do canvas, correção linkada / entrega do design / editar rascunho abrem na JANELA PRINCIPAL', () => {
  for (const f of ['async function openFromDesign(t){\n  if(ntPaneDelegate(\'openFromDesign\', t)) return;', 'async function openLinkedFix(t){\n  if(ntPaneDelegate(\'openLinkedFix\', t)) return;']) assert.ok(form.includes(f), f);
  assert.match(read('js/24-perguntas-agente.js'), /ntPaneDelegate\('editDraft', t\)/);
  const d = cut(form, 'function ntPaneDelegate(fn, t){', '\n}\n') + '\n}';
  const got = [];
  const parent = { state: { tasks: [{ id: 't2', title: 'da janela principal' }] }, openLinkedFix: (x) => got.push(x) };
  const win = { parent };
  assert.equal(new Function('SF_PANE', 'window', d + '\nreturn ntPaneDelegate("openLinkedFix", { id:"t2", title:"do painel" });')('task:t1', win), true);
  assert.deepEqual(got, [{ id: 't2', title: 'da janela principal' }], 'a janela principal recebe a tarefa dela');
  assert.equal(new Function('SF_PANE', 'window', d + '\nreturn ntPaneDelegate("openLinkedFix", { id:"t2" });')(null, win), false, 'fora do painel: abre aqui mesmo');
});
