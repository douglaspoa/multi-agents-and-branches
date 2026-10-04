// MODO TERMINAL no front (60-terminal.js + ganchos): `node --test app/tests/`
// Roda o arquivo de verdade num contexto vm com xterm/Tauri falsos: liga/desliga eventos pela visibilidade,
// não perde saída entre o retrato do histórico e os eventos, redimensiona só quando muda e não deixa o
// render da conversa apagar o terminal. E confere que piloto/ondas/épico pedem o modo automático.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');

function makeCtx() {
  const calls = []; const listeners = {}; const docListeners = {};
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.className = ''; this._html = ''; this.parentNode = null; this.connected = false; this.clientWidth = 800; this.clientHeight = 400; }
    appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = this; this.children.push(c); return c; }
    set innerHTML(v) { this._html = v; for (const c of this.children) c.parentNode = null; this.children = []; }
    get innerHTML() { return this._html; }
    set textContent(v) { this._html = String(v); }
    querySelector() { return null; }
    get isConnected() { let n = this; while (n) { if (n.connected) return true; n = n.parentNode; } return false; }
  }
  const writes = [];
  class FakeTerm {
    constructor(o) { this.opts = o; this.cols = 100; this.rows = 30; this.out = []; writes.push(this.out); }
    loadAddon(a) { this.addon = a; } open(el) { this.el = el; } onData(fn) { this.onDataFn = fn; }
    write(d) { this.out.push(d); } reset() { this.out.length = 0; this.out.push('<reset>'); } focus() {}
  }
  class FakeFit { fit() {} }
  const ros = [];
  const ctx = {
    console, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(), CSS: { escape: (s) => s },
    getComputedStyle: () => ({ getPropertyValue: (n) => (n === '--accent' ? '#3fd68a' : '') }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; ros.push(this); } observe() {} },
    document: { documentElement: {}, hidden: false, createElement: (t) => new El(t), querySelector: () => ctx.__slot, addEventListener: (n, f) => { docListeners[n] = f; } },
    window: { Terminal: { Terminal: FakeTerm }, FitAddon: { FitAddon: FakeFit }, __TAURI__: { event: { listen: (n, f) => { listeners[n] = f; } } } },
    state: { tasks: [{ id: 't1', status: 'running', spec: { termMode: 'terminal' } }] },
    escA: (s) => String(s), esc: (s) => String(s), eventsOf: (id) => (ctx.state.events || []).filter((e) => e.taskId === id), lastSig: '', refresh: () => Promise.resolve(), showErr: () => {},
    invoke: (c, a) => { calls.push([c, a]); return Promise.resolve(ctx.__answers[c]); },
    invokeQuiet: (c, a) => { calls.push([c, a]); return ctx.__answers[c] instanceof Function ? ctx.__answers[c]() : Promise.resolve(ctx.__answers[c]); },
    __answers: {}, __slot: null,
  };
  vm.createContext(ctx);
  vm.runInContext(src('60-terminal.js') + '\nthis.TERM=TERM; this.termMount=termMount; this.termModeOf=termModeOf; this.termSlotHtml=termSlotHtml; this.termFit=termFit; this.termSweep=termSweep; this.termHistLoad=termHistLoad; this.termWtGone=termWtGone; this.termGoLive=termGoLive;', ctx);
  return { ctx, calls, listeners, docListeners, El, writes, ros };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('modo e slot: só tarefa com termMode=terminal ganha o slot (marcado pra a conversa não pintar por cima)', () => {
  const { ctx } = makeCtx();
  assert.equal(ctx.termModeOf({ spec: { termMode: 'terminal' } }), true);
  assert.equal(ctx.termModeOf({ spec: {} }), false);
  assert.equal(ctx.termModeOf({}), false);
  assert.match(ctx.termSlotHtml({ id: 'tx' }), /id="fwThread" data-term="tx"/);
});

test('montar: liga eventos, pinta o histórico e escreve o que chegou DURANTE o retrato depois dele', async () => {
  const { ctx, calls, listeners, El } = makeCtx();
  let release;
  ctx.__answers.term_attach = () => new Promise((r) => { release = r; });
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' });
  const st = ctx.TERM.t1;
  assert.equal(st.host.parentNode, slot, 'xterm vai pro slot da Conversa');
  assert.ok(calls.some(([c]) => c === 'term_attach'));
  listeners['term-data']({ payload: { taskId: 't1', data: 'DEPOIS' } }); // chegou antes da resposta do attach
  release({ alive: true, data: 'HISTORICO' });
  await tick(); await tick();
  assert.deepEqual(st.term.out, ['<reset>', 'HISTORICO', 'DEPOIS']);
  listeners['term-data']({ payload: { taskId: 't1', data: 'ao vivo' } });
  assert.equal(st.term.out.at(-1), 'ao vivo');
  assert.ok(calls.some(([c, a]) => c === 'term_resize' && a.cols === 100 && a.rows === 30), 'PTY no tamanho do xterm');
  // tecla digitada no terminal vai pro PTY
  st.term.onDataFn('ls\r');
  assert.ok(calls.some(([c, a]) => c === 'term_write' && a.data === 'ls\r'));
});

test('escondido não recebe eventos; mesmo tamanho não redimensiona de novo; render seguinte REAPROVEITA o xterm', async () => {
  const { ctx, calls, El } = makeCtx();
  ctx.__answers.term_attach = { alive: true, data: '' };
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' }); await tick(); await tick();
  const st = ctx.TERM.t1, term = st.term;
  const resizes = () => calls.filter(([c]) => c === 'term_resize').length;
  const r0 = resizes();
  ctx.termFit('t1');
  assert.equal(resizes(), r0, 'tamanho igual: nada');
  // re-render: slot novo, MESMO terminal
  const slot2 = new El('div'); slot2.connected = true; slot.connected = false; ctx.__slot = slot2;
  ctx.termMount({ id: 't1' });
  assert.equal(ctx.TERM.t1.term, term);
  assert.equal(st.host.parentNode, slot2);
  // saiu da tela (outra tarefa/aba): para os eventos
  slot2.connected = false;
  ctx.termSweep();
  assert.ok(calls.some(([c]) => c === 'term_detach'));
  assert.equal(st.attached, false);
});

test('terminal fechado: o xterm mostra o HISTÓRICO da sessão (sem PTY) e "retomar sessão"; saída do processo chega por evento', async () => {
  const { ctx, calls, listeners, El } = makeCtx();
  ctx.state.tasks[0].status = 'review';
  ctx.__answers.term_attach = { alive: false, data: '' };
  ctx.__answers.term_history = { source: 'transcript', items: [{ k: 'say', ts: 1, text: 'velho' }], stamp: '10:1', sessionId: 'e3f63ca1-x', worktree: '/r/wt/t1', worktreeExists: true };
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' }); await tick(); await tick(); await tick();
  const st = ctx.TERM.t1;
  assert.equal(st.mode, 'hist');
  assert.match(st.bar.innerHTML, /retomar sessão/);
  assert.match(st.bar.innerHTML, /histórico · digite pra continuar/); // terminal integrado: digitar retoma
  const out = st.term.out.join('').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /╭─ claude · sessão e3f63ca1 · worktree t1/);
  assert.match(out, /● velho/);
  // poll sem mudança: pede com o carimbo e não repinta
  const n0 = st.term.out.length;
  ctx.__answers.term_history = { unchanged: true, stamp: '10:1', source: 'transcript' };
  await ctx.termHistLoad('t1', false);
  assert.equal(calls.filter(([c]) => c === 'term_history').at(-1)[1].since, '10:1');
  assert.equal(st.term.out.length, n0, 'arquivo igual: não repinta');
  // padrão "Automático" escolhido: a dica não promete retomar no terminal
  ctx.__answers.term_history = { source: 'transcript', items: [{ k: 'say', ts: 1, text: 'velho' }], stamp: '10:2', resumes: false, worktreeExists: true };
  await ctx.termHistLoad('t1', true);
  assert.match(st.bar.innerHTML, /o compositor manda no modo automático/);
  // log do PTY sem mudança mas evento novo: repinta com o log GUARDADO (não apaga o histórico)
  ctx.__answers.term_history = { source: 'log', raw: 'LOG-ANTIGO', stamp: '20:1', resumes: true };
  await ctx.termHistLoad('t1', true);
  ctx.__answers.term_history = { source: 'log', unchanged: true, stamp: '20:1' };
  ctx.state.events = [{ id: 99, taskId: 't1', agent: 'Sistema', type: 'note', text: 'PR aberto', ts: 5 }];
  await ctx.termHistLoad('t1', false);
  assert.match(st.term.out.join(''), /LOG-ANTIGO/);
  assert.match(st.term.out.join(''), /\x1b\[\?1049l/, 'sai da tela alternativa antes do rodapé');
  // integrada e sem worktree: dá pra conversar de novo (o backend recria a pasta) e a tarefa de ajuste fica como 2ª opção
  ctx.__answers.term_history = { source: 'transcript', items: [], stamp: '11:1', merged: true, worktreeExists: false };
  await ctx.termHistLoad('t1', true);
  assert.match(st.bar.innerHTML, /tarefa integrada · digite pra perguntar sobre o que foi feito/);
  assert.match(st.bar.innerHTML, /data-termopen="t1"[^>]*>conversar</);
  assert.match(st.bar.innerHTML, /abrir tarefa de ajuste/);
  assert.doesNotMatch(st.bar.innerHTML, /worktree foi apagada/);
  assert.equal(ctx.termWtGone('t1'), true);
  // a mensagem RETOMOU a sessão: o PTY nasceu → o xterm vira o vivo
  ctx.__answers.term_attach = { alive: true, data: 'VIVO' };
  ctx.termGoLive('t1'); await tick(); await tick();
  assert.equal(st.mode, 'live');
  assert.deepEqual(st.term.out, ['<reset>', 'VIVO']);
  // o terminal fechou: volta pro histórico (rascunho sem nada gravado → "abrir terminal")
  ctx.state.tasks[0].status = 'draft';
  ctx.__answers.term_history = { source: 'none', items: [], stamp: '' };
  listeners['term-exit']({ payload: { taskId: 't1', code: 0 } }); await tick(); await tick();
  assert.equal(st.mode, 'hist');
  assert.match(st.bar.innerHTML, /abrir terminal/);
});

test('conversa não pinta por cima do terminal; composer fica embaixo; caminhos sozinhos pedem automático', () => {
  const ws = src('20-workspace-tarefa.js');
  assert.match(ws, /function fwPaintThread\(t\)\{ const th=\$id\('fwThread'\); if\(!th\|\|!t\|\|th\.dataset\.term\) return;/);
  assert.match(ws, /if\(th && !th\.dataset\.term\)/);
  // layout A (60-terminal-layout): a coluna inteira vira terminal + painel; o slot do terminal mora no tlChatHtml
  assert.match(ws, /chat\.innerHTML=isTerm \? tlChatHtml\(t, composer\)/);
  assert.match(ws, /if\(isTerm\)\{ termMount\(t\); tlWire\(t, sheetGrab\);[^\n]*\} else termSweep\(\);/);
  // terminal integrado (64): o dock (sugestões/anexar/botões) entra entre o terminal e o compositor
  assert.match(src('60-terminal-layout.js'), /\$\{termSlotHtml\(t\)\}<div id="tlBudget">\$\{tlBudgetHtml\(t\)\}<\/div>\$\{typeof tiDockHtml==='function'\?tiDockHtml\(t\):''\}\$\{composer\}/);
  assert.match(src('34-orquestrador.js'), /termMode:'auto', start:startNow/);
  assert.match(src('59-ideia.js'), /payload\.termMode='auto'/);
  assert.match(src('43-espaco-times.js'), /if\(opts\.auto\) payload\.termMode='auto'/);
  assert.match(src('32-planner.js'), /teamClaimStart\(c\.row, null, \{ auto:true \}\)/);
  assert.match(src('46-epico-time.js'), /teamClaimStart\(ct, null, \{ silent:true, auto:true \}\)/);
  const cfg = src('15-config-abas-onboarding.js');
  assert.match(cfg, /id="cfgTaskMode"/);
  assert.match(cfg, /chave de API/);
  assert.match(cfg, /w\('taskMode'/);
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /vendor\/xterm\/xterm\.js/);
  assert.doesNotMatch(html, /cdn[^"']*xterm/i, 'xterm local, sem CDN');
});
