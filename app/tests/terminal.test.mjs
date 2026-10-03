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
    escA: (s) => String(s), lastSig: '', refresh: () => Promise.resolve(), showErr: () => {},
    invoke: (c, a) => { calls.push([c, a]); return Promise.resolve(ctx.__answers[c]); },
    invokeQuiet: (c, a) => { calls.push([c, a]); return ctx.__answers[c] instanceof Function ? ctx.__answers[c]() : Promise.resolve(ctx.__answers[c]); },
    __answers: {}, __slot: null,
  };
  vm.createContext(ctx);
  vm.runInContext(src('60-terminal.js') + '\nthis.TERM=TERM; this.termMount=termMount; this.termModeOf=termModeOf; this.termSlotHtml=termSlotHtml; this.termFit=termFit; this.termSweep=termSweep;', ctx);
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

test('terminal fechado mostra "retomar sessão"; saída do processo chega por evento', async () => {
  const { ctx, listeners, El } = makeCtx();
  ctx.__answers.term_attach = { alive: false, data: 'velho' };
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' }); await tick(); await tick();
  assert.match(ctx.TERM.t1.bar.innerHTML, /retomar sessão/);
  ctx.state.tasks[0].status = 'draft';
  listeners['term-exit']({ payload: { taskId: 't1', code: 0 } });
  assert.match(ctx.TERM.t1.bar.innerHTML, /abrir terminal/);
});

test('conversa não pinta por cima do terminal; composer fica embaixo; caminhos sozinhos pedem automático', () => {
  const ws = src('20-workspace-tarefa.js');
  assert.match(ws, /function fwPaintThread\(t\)\{ const th=\$id\('fwThread'\); if\(!th\|\|!t\|\|th\.dataset\.term\) return;/);
  assert.match(ws, /if\(th && !th\.dataset\.term\)/);
  assert.match(ws, /termModeOf\(t\)\?termSlotHtml\(t\)/);
  assert.match(ws, /if\(termModeOf\(t\)\) termMount\(t\); else termSweep\(\);/);
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
