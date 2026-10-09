// ABRIR A TAREFA = TERMINAL VIVO (08/10): retomada quieta sozinha, troca histórico→vivo sem flash, foco no xterm,
// confiança da pasta como aviso e Ajustes. Funções puras recortadas por marcador + a fiação conferida no código.
// `node --test app/tests/terminal-vivo.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const term = read('js/60-terminal.js'), ti = read('js/64-terminal-integrado.js'), ws = read('js/20-workspace-tarefa.js'), aj = read('js/67-ajustes.js');
const P = new Function(cut(term, '// @term-vivo-puro-inicio', '// @term-vivo-puro-fim') + '\nreturn { TERM_RIS, TERM_READY, TERM_MARK, termAutoOk, termReadyNow, termTrustAsk, termFocusFree, termVis };')();

const H = { resumes: true, worktreeExists: true, sessionId: 's1', source: 'transcript' };
const base = { enabled: true, on: true, hidden: false, mode: 'hist', alive: false, opening: false, tried: false, hinfo: H, headless: false, budget: false, paused: false, exitAt: 0, now: 1e9 };

test('retoma sozinha só a tarefa visível, parada, com pasta e sessão — uma vez por visita', () => {
  assert.equal(P.termAutoOk(base), true);
  for (const [k, v, why] of [['enabled', false, 'Ajustes desligado'], ['on', false, 'fora da tela'], ['hidden', true, 'janela escondida'], ['mode', 'live', 'já vivo'],
    ['alive', true, 'PTY vivo'], ['opening', true, 'abrindo'], ['tried', true, 'já tentou nesta visita'], ['headless', true, 'turno em segundo plano'],
    ['budget', true, 'teto de custo esperando resposta'], ['paused', true, 'pausada (teto)']]) {
    assert.equal(P.termAutoOk({ ...base, [k]: v }), false, why);
  }
  assert.equal(P.termAutoOk({ ...base, hinfo: { ...H, worktreeExists: false } }), false, 'integrada sem pasta: só histórico + tarefa de ajuste');
  assert.equal(P.termAutoOk({ ...base, hinfo: { ...H, resumes: false } }), false, 'padrão Automático: o compositor manda no headless');
  assert.equal(P.termAutoOk({ ...base, hinfo: { ...H, sessionId: null, source: 'none' } }), false, 'nada pra retomar (tarefa nova)');
  assert.equal(P.termAutoOk({ ...base, hinfo: { ...H, sessionId: null, source: 'log' } }), true, 'sem id mas com log (codex): retoma a última');
  assert.equal(P.termAutoOk({ ...base, hinfo: null }), false);
  assert.equal(P.termAutoOk({ ...base, exitAt: base.now - 5000 }), false, 'acabou de fechar: não reabre em laço');
  assert.equal(P.termAutoOk({ ...base, exitAt: base.now - 61000 }), true);
});

test('troca só quando a IA desenhou e assentou (shell: depois do aviso do starfork ia); teto de espera', () => {
  const R = P.TERM_READY, t0 = 1000;
  const shellBoot = 'Last login…\r\n\x1b[2m' + P.TERM_MARK + ': Claude Code (retomando)\x1b[0m\r\n';
  assert.equal(P.termReadyNow({ t0, now: t0 + 800, last: t0 + 100, text: '', shell: true }), false, 'nada ainda');
  assert.equal(P.termReadyNow({ t0, now: t0 + 1500, last: t0 + 100, text: shellBoot, shell: true }), false, 'só o aviso: a IA ainda não desenhou (troca aqui = tela vazia)');
  assert.equal(P.termReadyNow({ t0, now: t0 + 1500, last: t0 + 1400, text: shellBoot + '\x1b[?25l╭───╮\r\n│ > │', shell: true }), false, 'desenhando');
  assert.equal(P.termReadyNow({ t0, now: t0 + 1500 + R.quietMs, last: t0 + 1500, text: shellBoot + '\x1b[?25l╭───╮\r\n│ > │', shell: true }), true, 'desenhou e assentou');
  assert.equal(P.termReadyNow({ t0, now: t0 + 1500 + R.quietMs, last: t0 + 1500, text: shellBoot + '\x1b[?2004h\x1b[?25l', shell: true }), false, 'só sequências de controle não contam');
  assert.equal(P.termReadyNow({ t0, now: t0 + 900, last: t0 + 400, text: '● oi', shell: false }), true, 'direto: qualquer coisa visível');
  assert.equal(P.termReadyNow({ t0, now: t0 + 400 + R.settleMs, last: t0 + 400, text: 'starfork ia: erro\r\n$ ', shell: true }), true, 'a IA nem subiu (erro + prompt): mostra depois de assentar');
  assert.equal(P.termReadyNow({ t0, now: t0 + R.maxMs, last: t0 + R.maxMs, text: '', shell: true }), true, 'teto: troca mesmo assim');
  assert.equal(P.TERM_RIS, '\x1bc', 'RIS dentro do write (limpa e desenha no mesmo quadro)');
});

test('confiança da pasta: Claude Code (antigo e novo) e Codex viram aviso; texto qualquer não', () => {
  assert.ok(P.termTrustAsk('\x1b[1mDo you trust the files in this folder?\x1b[0m\r\n❯ 1. Yes, proceed'));
  assert.ok(P.termTrustAsk('Quick safety check: Is this a project you created or one you trust?'));
  assert.ok(P.termTrustAsk('> You are in /x\r\n  Do you trust the contents of this directory? Working with untrusted contents…'));
  assert.ok(!P.termTrustAsk('● pronto, o teste passou'));
  assert.ok(!P.termTrustAsk('Do you trust the files in this folder?' + 'x'.repeat(4000)), 'só o fim da tela');
});

test('foco: vai pro terminal salvo campo de texto ou folha de pergunta', () => {
  const host = { contains: (x) => x && x.inHost };
  assert.ok(P.termFocusFree(null, host)); assert.ok(P.termFocusFree({ tagName: 'BODY' }, host));
  assert.ok(P.termFocusFree({ tagName: 'TEXTAREA', inHost: true }, host), 'o textarea do próprio xterm');
  assert.ok(!P.termFocusFree({ tagName: 'TEXTAREA' }, host), 'compositor com foco: fica');
  assert.ok(!P.termFocusFree({ tagName: 'INPUT' }, host));
  assert.ok(!P.termFocusFree({ tagName: 'BUTTON', closest: (s) => /tlsheet/.test(s) }, host), 'folha de pergunta');
  assert.ok(P.termFocusFree({ tagName: 'BUTTON', closest: () => null }, host), 'clicou na aba da tarefa');
});

test('fiação: sem reset() + write (quadro vazio), histórico como placeholder, uma troca, retomada QUIETA', () => {
  assert.ok(!/st\.term\.reset\(\)/.test(term), 'nenhum reset() síncrono seguido de write assíncrono');
  const sw = cut(term, 'function termSwap(taskId, data){', '\n}\n');
  assert.match(sw, /st\.term\.write\(TERM_RIS\+d,/, 'um único write com RIS');
  const rs = cut(term, 'async function termResume(taskId, o){', '\n}\n');
  assert.match(rs, /st\.attached=true; st\.pend=\[\]; st\.pendAt=0; st\.holding=true;[\s\S]*invoke\('term_open',\{ taskId, cols, rows, resume:true, quiet:!!o\.quiet \}\)/, 'histórico fica; o PTY vai pra fila');
  assert.match(rs, /while\(st\.holding && !termReadyNow\(/);
  assert.match(rs, /termSwap\(taskId, head\+\(st\.pend\|\|\[\]\)\.join\(''\)\)/);
  assert.match(rs, /return drop\(\)/, 'saiu da tela no meio: solta o attach do term_open');
  assert.match(cut(term, 'async function termHistLoad(taskId, force){', '\n}\n'), /st\.term\.write\(TERM_RIS\+out,[\s\S]*else if\(auto\) termAutoMaybe\(taskId\)/, 'histórico pintado → retoma sozinha');
  assert.match(cut(term, 'async function termAttach(taskId){', '\n}\n'), /st\.holding\) return;[\s\S]*termSwap\(taskId, String\(info\.data\|\|''\)/);
  assert.match(cut(term, 'function termDetach(taskId){', '\n}\n'), /st\.autoTried=false/, 'saiu da tela: a próxima visita retoma de novo');
  assert.match(term, /listen\('term-data'[^\n]*st\.pend\.push\(p\.data\); st\.pendAt=Date\.now\(\)/);
  assert.match(term, /listen\('term-exit'[^\n]*\n?[^\n]*st\.exitAt=p\.reaped\?0:Date\.now\(\)/);
  // clique/tecla no histórico: a mesma troca (quieta, sem a linha "abrindo a sessão…" por cima)
  const go = cut(ti, 'async function tiGoLive(taskId, o){', '\n}\n');
  assert.match(go, /termResume\(taskId, \{ quiet:true, auto:!!\(o&&o\.auto\), takeover:!!\(o&&o\.takeover\) \}\)/);
  assert.ok(!/abrindo a sessão…/.test(go));
  assert.match(ws, /if\(!path && typeof termWantFocus==='function'\) termWantFocus\(taskId\);/, 'abrir a tarefa pede o foco pro terminal');
});

test('confiança da pasta: barra com confiar (Enter) / sair (Esc), sem travar', () => {
  const sa = cut(term, 'function termSetAlive(taskId, alive){', '\n}\n');
  assert.match(sa, /data-termtrust="yes"[\s\S]*data-termtrust="no"/);
  assert.match(term, /data:b\.dataset\.termtrust==='yes'\?'\\r':'\\x1b'/);
});

test('Ajustes: retomar sozinho (padrão ligado) e encerrar terminal parado (padrão 15 min, 0 = nunca)', () => {
  const A = new Function(cut(aj, '// encerrar terminal parado', 'function ajRenderModo(host){') + '\nreturn { AJ_TERM_IDLE, ajTermIdleOf };')();
  assert.equal(A.ajTermIdleOf(undefined), '15'); assert.equal(A.ajTermIdleOf('"30"'), '30'); assert.equal(A.ajTermIdleOf('7'), '15'); assert.equal(A.ajTermIdleOf(0), '0');
  assert.ok(A.AJ_TERM_IDLE.some(([v, l]) => v === '0' && /nunca/.test(l)));
  assert.match(aj, /ajSetting\('termAutoResume', ta\.checked\?'1':'0'\)/);
  assert.match(aj, /ajSetting\('termIdleMin', ti\.value\)/);
});

// ---- comportamento de verdade (60-terminal.js num vm com xterm/Tauri falsos) ----
import vm from 'node:vm';
function makeCtx(o = {}) {
  const calls = []; const hs = {}; const listeners = new Proxy({}, { get: (_, n) => (ev) => (hs[n] || []).forEach((f) => f(ev)) });
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.className = ''; this._html = ''; this.parentNode = null; this.connected = false; this.clientWidth = 800; this.clientHeight = 400; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    set innerHTML(v) { this._html = v; this.children = []; }
    get innerHTML() { return this._html; }
    querySelector() { return null; }
    contains(x) { return x === this; }
    addEventListener() {}
    get isConnected() { let n = this; while (n) { if (n.connected) return true; n = n.parentNode; } return false; }
  }
  class FakeTerm {
    constructor() { this.cols = 100; this.rows = 30; this.out = []; this.focused = 0; }
    loadAddon() {} open() {} onData(fn) { const p = this.onDataFn; this.onDataFn = p ? (d) => { p(d); fn(d); } : fn; }
    write(d, cb) { this.out.push(d); if (cb) cb(); } reset() { this.out.push('<reset>'); } focus() { this.focused++; } scrollToBottom() {} refresh() {}
  }
  const ctx = {
    console, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(), CSS: { escape: (s) => s },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} },
    document: { documentElement: {}, hidden: false, activeElement: null, createElement: (t) => new El(t), querySelector: () => ctx.__slot, addEventListener: () => {} },
    window: { Terminal: { Terminal: FakeTerm }, FitAddon: { FitAddon: class { fit() {} } }, __TAURI__: { event: { listen: (n, f) => { (hs[n] ||= []).push(f); } } } },
    $id: () => null, lsGet: () => null, pendingOf: () => [],
    state: { tasks: [{ id: 't1', status: 'review', engine: 'claude', spec: { termMode: 'terminal' } }] },
    ACTIVE_ST: new Set(['running', 'queued']), aiEngineOf: () => 'claude',
    escA: (s) => String(s), esc: (s) => String(s), eventsOf: () => [], lastSig: '', refresh: () => Promise.resolve(), showErr: () => { ctx.__err = (ctx.__err || 0) + 1; },
    invoke: (c, a) => { calls.push([c, a]); const v = ctx.__answers[c]; return v instanceof Function ? v(a) : Promise.resolve(v); },
    invokeQuiet: (c, a) => { calls.push([c, a]); const v = ctx.__answers[c]; return v instanceof Function ? v(a) : Promise.resolve(v); },
    __answers: { read_settings: '{}' }, __slot: null,
  };
  vm.createContext(ctx);
  vm.runInContext(src60 + (o.ti ? '\n' + read('js/64-terminal-integrado.js') : '') + '\nthis.TERM=TERM; this.termMount=termMount; this.termWantFocus=termWantFocus; this.termSweep=termSweep; this.termOpen=termOpen;', ctx);
  return { ctx, calls, listeners, El };
}
const src60 = read('js/60-terminal.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HIST = { source: 'transcript', items: [{ k: 'say', ts: 1, text: 'conversa de ontem' }], stamp: '1:1', sessionId: 'abc', worktree: '/r/wt', worktreeExists: true, resumes: true };

test('abrir tarefa parada: retoma QUIETA sozinha, histórico fica até a IA desenhar, troca num write só, foco no xterm', async () => {
  const { ctx, calls, listeners, El } = makeCtx();
  ctx.__answers.term_attach = { alive: false, data: '' };
  ctx.__answers.term_history = HIST;
  let openArgs; ctx.__answers.term_open = (a) => { openArgs = a; return Promise.resolve({ alive: true, shell: true, data: '' }); };
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termWantFocus('t1');
  const t0 = Date.now();
  ctx.termMount({ id: 't1' });
  await wait(20);
  const st = ctx.TERM.t1;
  assert.ok(openArgs && openArgs.quiet === true && openArgs.resume === true, 'term_open quieto (sem prompt, não gasta)');
  assert.ok(st.term.focused >= 1, 'teclado já no terminal, ainda no histórico');
  const histOut = st.term.out.slice();
  assert.match(histOut.join(''), /conversa de ontem/);
  assert.equal(st.mode, 'hist', 'histórico na tela enquanto a IA sobe');
  // o shell sobe, a IA avisa e desenha — tudo vai pra fila; a tela NÃO muda
  listeners['term-data']({ payload: { taskId: 't1', data: '\x1b[2m▸ Starfork: Claude Code (retomando)\x1b[0m\r\n' } });
  await wait(120);
  assert.deepEqual(st.term.out, histOut, 'só o aviso: segue o histórico (trocar agora = tela vazia)');
  st.term.onDataFn('o'); // a pessoa já digita
  listeners['term-data']({ payload: { taskId: 't1', data: '● conversa de ontem\r\n╭──╮\r\n│ > │\r\n╰──╯' } });
  for (let i = 0; i < 40 && st.mode !== 'live'; i++) await wait(50);
  assert.equal(st.mode, 'live');
  assert.ok(Date.now() - t0 < 2000, 'vivo em < 2 s');
  const swap = st.term.out.slice(histOut.length);
  assert.equal(swap.length, 1, 'UM write na troca (sem quadro intermediário)');
  assert.ok(swap[0].startsWith('\x1bc') && swap[0].includes('▸ Starfork') && swap[0].includes('│ > │'));
  assert.ok(!st.term.out.includes('<reset>'));
  // depois da troca a tecla vai direto pro PTY
  st.term.onDataFn('i');
  assert.ok(calls.some(([c, a]) => c === 'term_write' && a.data === 'i'));
  listeners['term-data']({ payload: { taskId: 't1', data: 'ao vivo' } });
  assert.equal(st.term.out.at(-1), 'ao vivo');
});

test('integrada sem pasta não retoma; Ajustes desligado não retoma; saiu da tela no meio: solta o attach e não troca', async () => {
  { const { ctx, calls, El } = makeCtx();
    ctx.__answers.term_attach = { alive: false, data: '' };
    ctx.__answers.term_history = { ...HIST, merged: true, worktreeExists: false };
    const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
    ctx.termMount({ id: 't1' }); await wait(30);
    assert.ok(!calls.some(([c]) => c === 'term_open'), 'integrada sem pasta: só histórico');
    assert.match(ctx.TERM.t1.bar.innerHTML, /abrir tarefa de ajuste/); }
  { const { ctx, calls, El } = makeCtx();
    ctx.__answers.read_settings = '{"termAutoResume":"0"}';
    ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = HIST;
    const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
    // sem pré-leitura: a 1ª tarefa aberta ESPERA o settings (antes retomava com o padrão ligado)
    ctx.termMount({ id: 't1' }); await wait(30);
    assert.ok(!calls.some(([c]) => c === 'term_open'), 'Ajustes › retomar sozinho desligado'); }
  { const { ctx, calls, El, listeners } = makeCtx();
    ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = HIST;
    ctx.__answers.term_open = () => Promise.resolve({ alive: true, shell: false, data: '' });
    const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
    ctx.termMount({ id: 't1' }); await wait(20);
    const st = ctx.TERM.t1; const n = st.term.out.length;
    slot.connected = false; ctx.termSweep(); // trocou de tarefa antes de a IA desenhar
    listeners['term-data']({ payload: { taskId: 't1', data: 'tarde demais' } });
    await wait(500);
    assert.equal(st.mode, 'hist'); assert.equal(st.term.out.length, n, 'nada pintado fora da tela');
    assert.ok(calls.some(([c]) => c === 'term_detach'), 'solta o attach que o term_open fez (o encerramento de parado conta certo)'); }
});

test('confiança da pasta no meio da retomada: aviso na barra, Enter confia', async () => {
  const { ctx, calls, listeners, El } = makeCtx();
  ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = HIST;
  ctx.__answers.term_open = () => Promise.resolve({ alive: true, shell: false, data: '' });
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' }); await wait(20);
  listeners['term-data']({ payload: { taskId: 't1', data: 'Do you trust the files in this folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit' } });
  const st = ctx.TERM.t1;
  for (let i = 0; i < 40 && st.mode !== 'live'; i++) await wait(50);
  assert.equal(st.mode, 'live');
  assert.match(st.bar.innerHTML, /confia nesta pasta[\s\S]*data-termtrust="yes"/);
  assert.equal(st.bar.style.display, 'flex');
  assert.ok(!calls.some(([c]) => c === 'term_write'), 'nada respondido sem a pessoa');
});


test('teclas digitadas ENQUANTO a sessão abre (60 + 64 de verdade): entram em ordem num write só, depois da troca', async () => {
  const { ctx, calls, listeners, El } = makeCtx({ ti: true });
  ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = HIST;
  ctx.__answers.term_open = () => Promise.resolve({ alive: true, shell: false, data: '' });
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' }); await wait(20);
  const st = ctx.TERM.t1;
  st.term.onDataFn('o'); st.term.onDataFn('i');
  assert.ok(!calls.some(([c]) => c === 'term_write'), 'nada vai pro PTY antes da IA desenhar');
  listeners['term-data']({ payload: { taskId: 't1', data: '● oi\r\nFAKE-PROMPT> ' } });
  for (let i = 0; i < 40 && !calls.some(([c]) => c === 'term_write'); i++) await wait(50);
  assert.equal(st.mode, 'live');
  assert.deepEqual(calls.filter(([c]) => c === 'term_write').map(([, a]) => a.data), ['oi'], 'um write, em ordem');
  st.term.onDataFn('!');
  assert.equal(calls.filter(([c]) => c === 'term_write').at(-1)[1].data, '!', 'depois: direto');
});

test('botão "abrir terminal": tarefa nova abre com kickoff (quiet:false); parada só retoma (quiet:true)', async () => {
  for (const [status, quiet] of [['draft', false], ['queued', false], ['review', true]]) {
    const { ctx, El } = makeCtx();
    ctx.state.tasks[0].status = status;
    let args; ctx.__answers.term_open = (a) => { args = a; return Promise.resolve({ alive: true, shell: false, data: 'x' }); };
    const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
    ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = { ...HIST, sessionId: null, source: 'none' };
    ctx.termMount({ id: 't1' }); await wait(10);
    ctx.termOpen('t1'); await wait(10);
    assert.equal(args.quiet, quiet, status);
  }
});

test('encerrado por ficar parado: voltar à tarefa retoma na hora; fechou de verdade: não reabre em laço', async () => {
  const { ctx, listeners, El } = makeCtx();
  ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = HIST;
  ctx.__answers.term_open = () => Promise.resolve({ alive: true, shell: false, data: '● oi' });
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' });
  const st = () => ctx.TERM.t1;
  for (let i = 0; i < 40 && st().mode !== 'live'; i++) await wait(50);
  listeners['term-exit']({ payload: { taskId: 't1', code: null, reaped: true } });
  assert.equal(st().exitAt, 0);
  listeners['term-exit']({ payload: { taskId: 't1', code: 0 } });
  assert.ok(st().exitAt > 0);
});

test('confiança respondida pelo teclado (Enter no xterm): a barra some na hora', async () => {
  const { ctx, listeners, El } = makeCtx();
  ctx.__answers.term_attach = { alive: false, data: '' }; ctx.__answers.term_history = HIST;
  ctx.__answers.term_open = () => Promise.resolve({ alive: true, shell: false, data: '' });
  const slot = new El('div'); slot.connected = true; ctx.__slot = slot;
  ctx.termMount({ id: 't1' }); await wait(20);
  listeners['term-data']({ payload: { taskId: 't1', data: 'Do you trust the files in this folder?\r\n❯ 1. Yes, proceed' } });
  const st = ctx.TERM.t1;
  for (let i = 0; i < 40 && st.mode !== 'live'; i++) await wait(50);
  assert.equal(st.bar.style.display, 'flex');
  st.term.onDataFn('\r');
  assert.equal(st.bar.style.display, 'none', 'sem barra velha (o "sair" mandaria Esc no meio de um turno)');
  listeners['term-data']({ payload: { taskId: 't1', data: '● seguindo' } });
  assert.equal(st.bar.style.display, 'none');
});
