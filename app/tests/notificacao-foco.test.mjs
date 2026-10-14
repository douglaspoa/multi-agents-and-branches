// NOTIFICAÇÃO NUNCA TIRA DA TAREFA (bug do dono, 14/10): "na tela da tarefa, no terminal, chega uma notificação e
// volta pra listagem de tarefas". Causa: com a janela sem foco, o pushNotif guardava o id e o PRÓXIMO 'focus' da
// janela (voltar de outro app, sair da webview do canvas) era tratado como clique → openTab('flow') = Central.
// Aqui: o trecho REAL do 10-core (pushNotif → notifRoute → 'focus'/'notif-open' → detectNotifs) roda numa vm com a
// aba da tarefa aberta e o foco no xterm; cada tipo de aviso é disparado e a aba ativa, o fwTask e o foco não mudam.
// Só o CLIQUE (evento nativo 'notif-open') navega — e abre o destino como aba, sem fechar a tarefa.
// `node --test app/tests/notificacao-foco.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const CORE = read('js/10-core.js'), TIME = read('js/43-espaco-times.js'), GT = read('js/72-gestao-time.js'), EPICO = read('js/46-epico-time.js'),
  LOOP = read('js/70-loop.js'), ISS = read('js/14-issues-projeto.js'), PIL = read('js/56-piloto.js');

const P = new Function(cut(CORE, '// @notif-rota-puro-inicio', '// @notif-rota-puro-fim') + '\nreturn { notifTarget };')();

test('rota do clique: Time pra avisos do time, a ABA da tarefa pra tarefa — nunca a Central', () => {
  const tasks = [{ id: 't1' }, { id: 't2' }];
  assert.equal(P.notifTarget('', tasks), null);
  assert.equal(P.notifTarget(null, tasks), null);
  assert.deepEqual(P.notifTarget('view:team', tasks), { kind: 'team' });
  assert.deepEqual(P.notifTarget('t2', tasks), { kind: 'task', id: 't2' });
  assert.deepEqual(P.notifTarget('x9', tasks), { kind: 'other', id: 'x9' }, 'de outro projeto: o abridor do cartão resolve');
});

// --- o trecho real do 10-core numa vm: aba da tarefa t1 aberta, foco no xterm dela ---
function mundo() {
  const W = { listeners: {}, tauri: {} };
  const ctx = {
    console, Date, Set, String, Object, Array, Promise, parseFloat, setTimeout: () => 0,
    state: { tasks: [{ id: 't1', title: 'Aberta', status: 'running' }, { id: 't2', title: 'Outra', status: 'running' }, { id: 't3', title: 'Terceira', status: 'review' }], pending: [], events: [] },
    activeTab: 'task:t1', fwTask: 't1', selected: 't1', focused: 'xterm:t1', hasFocus: true, sent: [], opened: [],
    notifReady: false, notifOn: true, notifState: 'authorized', prevStatus: {}, prevPr: {}, prevPending: new Set(),
    commitsStale: {}, prCache: {}, ACTIVE_ST: new Set(['running', 'queued']), costWarned: new Set(),
  };
  // o que mexe em aba/foco: grava e aplica (se alguém chamar sozinho, o teste vê a aba/foco mudarem)
  ctx.openTab = (k) => { ctx.opened.push('tab:' + k); ctx.activeTab = k; ctx.focused = 'tab'; };
  ctx.activateTab = (id) => { ctx.opened.push('activate:' + id); ctx.activeTab = id; ctx.focused = 'tab'; };
  ctx.openWorkspace = (id) => { ctx.opened.push('task:' + id); ctx.activeTab = 'task:' + id; ctx.fwTask = id; ctx.focused = 'xterm:' + id; };
  ctx.openTaskById = (id) => { ctx.opened.push('byid:' + id); };
  ctx.boardSource = () => [...ctx.state.tasks, { id: 'x9', _cross: true }]; ctx.toast = (m) => { ctx.toasts = (ctx.toasts || []).concat(m); };
  ctx.render = () => {}; ctx.activeIs = () => false; ctx.lsGet = () => ''; ctx.$id = () => null; ctx.fmtCost = (x) => '$' + x; ctx.taskCost = () => ({ usd: 0 });
  ctx.invokeQuiet = (cmd, a) => { ctx.sent.push(a); return Promise.resolve(); };
  ctx.notifApi = () => null; ctx.notifRefresh = () => Promise.resolve('authorized'); ctx.notifCfgMount = () => {};
  ctx.document = { hasFocus: () => ctx.hasFocus, querySelector: () => null };
  ctx.window = {
    __TAURI__: { event: { listen: (n, f) => { W.tauri[n] = f; return Promise.resolve(() => {}); } } },
    addEventListener: (n, f) => { (W.listeners[n] = W.listeners[n] || []).push(f); },
    openTab: (...a) => ctx.openTab(...a),
  };
  vm.createContext(ctx);
  const code = cut(CORE, '// @notif-vm-inicio', '// @notif-vm-fim') + '\nconst prevEvTop={};\n'
    + 'this.__api = { pushNotif, notifRoute, detectNotifs };';
  vm.runInContext(code, ctx);
  const fire = (n, ev) => (W.listeners[n] || []).forEach((f) => f(ev || {}));
  const clickNotif = (id) => W.tauri['notif-open']({ payload: id });
  return { ctx, api: ctx.__api, fire, clickNotif, W };
}
const snap = (ctx, over) => Object.assign({ tasks: ctx.state.tasks.map((t) => ({ ...t })), pending: [], events: [] }, over || {});
const intacta = (ctx, msg) => {
  assert.equal(ctx.activeTab, 'task:t1', msg + ': a aba ativa continua a da tarefa');
  assert.equal(ctx.fwTask, 't1', msg + ': a tarefa aberta continua a mesma');
  assert.equal(ctx.focused, 'xterm:t1', msg + ': o foco continua no terminal');
  assert.deepEqual(ctx.opened, [], msg + ': nada abriu sozinho');
};

test('cada tipo de aviso, com a janela em 2º plano e o foco voltando depois, NÃO troca a aba nem o foco', () => {
  const casos = {
    'pronta pra review (outra tarefa)': (s) => { s.tasks[1].status = 'review'; },
    'plano pra aprovar': (s) => { s.tasks[1].status = 'plan-review'; },
    'precisa de você': (s) => { s.tasks[1].status = 'needs-you'; },
    'falhou': (s) => { s.tasks[1].status = 'error'; },
    'mergeada': (s) => { s.tasks[2].status = 'merged'; },
    'PR aberto': (s) => { s.tasks[2].prUrl = 'https://example.test/pr/1'; },
    'nova tarefa iniciada': (s) => { s.tasks.push({ id: 't4', title: 'Nova', status: 'running' }); },
    'pergunta do agente de OUTRA tarefa': (s) => { s.pending = [{ id: 'p1', taskId: 't2', agent: 'dev', prompt: 'qual?' }]; },
    'mudança na PRÓPRIA tarefa aberta': (s) => { s.tasks[0].status = 'review'; },
  };
  for (const [nome, muda] of Object.entries(casos)) {
    const { ctx, api, fire } = mundo();
    api.detectNotifs(snap(ctx)); // 1ª volta só semeia
    ctx.hasFocus = false;
    const s = snap(ctx); muda(s); api.detectNotifs(s);
    assert.ok(ctx.sent.length >= 1, nome + ': a notificação saiu');
    ctx.hasFocus = true; fire('focus'); fire('focus');
    intacta(ctx, nome);
  }
  // avisos que não passam pelo snapshot: time (atribuiu/assumiu/devolveu/PR/review — view:team), issues, loop, épico, piloto
  for (const [nome, id] of [['time', 'view:team'], ['painel de issues', 't2'], ['loop', 't2'], ['épico (sem id)', null], ['piloto', undefined]]) {
    const { ctx, api, fire } = mundo();
    ctx.hasFocus = false; api.pushNotif('aviso', 'corpo', id); ctx.hasFocus = true; fire('focus');
    intacta(ctx, nome);
  }
  // app em primeiro plano (foco no terminal): o aviso chega e a tela fica
  { const { ctx, api, fire } = mundo(); api.detectNotifs(snap(ctx)); const s = snap(ctx); s.tasks[1].status = 'error'; api.detectNotifs(s); fire('focus'); intacta(ctx, 'primeiro plano'); }
});

test('CLIQUE na notificação abre o destino como aba — a tarefa em que você estava continua aberta', () => {
  { const { ctx, clickNotif } = mundo(); clickNotif('t2'); assert.deepEqual(ctx.opened, ['task:t2']); assert.ok(!ctx.opened.some((x) => /flow/.test(x)), 'nunca a Central'); }
  { const { ctx, clickNotif } = mundo(); clickNotif('view:team'); assert.deepEqual(ctx.opened, ['tab:time']); }
  { const { ctx, clickNotif } = mundo(); clickNotif('t1'); assert.deepEqual(ctx.opened, ['task:t1'], 'a própria tarefa: só reativa a aba dela'); }
  { const { ctx, clickNotif } = mundo(); clickNotif('x9'); assert.deepEqual(ctx.opened, ['byid:x9'], 'outro projeto: abridor do cartão'); }
  { const { ctx, clickNotif } = mundo(); clickNotif(''); intacta(ctx, 'clique sem id'); }
  { const { ctx, clickNotif } = mundo(); clickNotif('sumiu'); intacta(ctx, 'tarefa que não existe mais'); assert.equal((ctx.toasts || []).length, 1, 'clique não fica mudo: avisa'); }
  { const { ctx, clickNotif } = mundo(); ctx.openOrEdit = (t) => ctx.opened.push('edit:' + t.id); clickNotif('t2'); assert.deepEqual(ctx.opened, ['edit:t2'], 'mesmo abridor do cartão (rascunho → editor)'); assert.equal(ctx.selected, 't2'); }
});

test('fiação: foco da janela não roteia; quem dispara aviso não navega', () => {
  const route = cut(CORE, 'function notifRoute(', '\n}\n');
  assert.doesNotMatch(route, /openTab\('flow'\)|activateTab\('flow'\)|viewSeg/, 'clique nunca leva pra Central');
  assert.doesNotMatch(CORE, /lastNotif/, 'sem a heurística "ganhou foco logo depois = clicou"');
  const foc = cut(CORE, "window.addEventListener('focus', ()=>{", '\n});\n');
  assert.doesNotMatch(foc, /notifRoute|openTab|activateTab|openWorkspace/);
  assert.match(CORE, /listen\('notif-open', \(ev\)=>\{ notifRoute\(ev\.payload\|\|''\); \}\)/);
  // os ticks que disparam aviso (time, perda de cartão, épico, loop, issues, piloto) não trocam a tela por conta própria
  const NAV = /openTab\(|activateTab\(|openWorkspace\(|setView\(|switchProject\(|closeTab\(|closeWorkspace\(/;
  for (const [nome, src, a] of [['detectNotifs', CORE, 'function detectNotifs('], ['teamNotifTick', TIME, 'async function teamNotifTick('],
    ['gtLostTick', GT, 'async function gtLostTick('], ['epAutoLocalTick', EPICO, 'async function epAutoLocalTick('], ['epicAutoStartTick', EPICO, 'async function epicAutoStartTick('],
    ['loopWatch', LOOP, 'function loopWatch('], ['pushNotif', CORE, 'function pushNotif(']]) {
    assert.doesNotMatch(cut(src, a, '\n}\n'), NAV, nome + ' não navega');
  }
  // issues e piloto: o aviso fica no pushNotif (o que abre tela é só botão de toast/clique)
  assert.match(ISS, /pushNotif\(i\.code\+' — '\+what/);
  assert.match(PIL, /pushNotif\('Starfork — piloto', msg\)/);
});
