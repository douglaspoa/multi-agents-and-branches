// Medidor do plano no menu lateral (spec-medidor-plano): render dos estados (Claude/Codex/DeepSeek),
// cores, "configure sua IA", minimizar persiste e clique leva ao painel Sua IA. Carrega 00-util + 28 num vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');

function fakeEl() {
  const cls = new Set();
  const el = {
    innerHTML: '', __html: null, listeners: {},
    classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
  };
  return el;
}

function load(store = {}, opts = {}) {
  const calls = [], timers = [];
  const noop = () => {};
  const el = opts.noEl ? null : fakeEl();
  const ctx = {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { hidden: false, getElementById: (id) => (id === 'planMeter' ? el : null), addEventListener: noop, querySelectorAll: () => [], querySelector: () => null, documentElement: { style: { setProperty: noop } } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' },
    console, Date, Math, Promise, Number, String, Array, Object, isFinite,
    setTimeout: (fn, ms) => { timers.push(['t', ms, fn]); return timers.length; },
    setInterval: (fn, ms) => { timers.push(['i', ms, fn]); return timers.length; },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    aiDefaults: () => ({ eng: store.defaultEngine || 'claude', model: '' }),
    aiEngineOf: (e) => String(e || 'claude'),
    suaIaOpenCfg: () => calls.push(['suaIaOpenCfg']),
    invokeQuiet: async (cmd) => { calls.push([cmd]); return opts.usage ?? null; },
  };
  vm.createContext(ctx);
  vm.runInContext(read('00-util.js') + '\n' + read('28-medidor-plano.js'), ctx);
  return { ctx, el, calls, timers, run: (c) => vm.runInContext(c, ctx) };
}

// horário local de um epoch (o widget mostra no fuso da máquina)
const hm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const NOW = new Date(2026, 9, 1, 13, 0).getTime();
const R18 = new Date(2026, 9, 1, 18, 0).getTime();
const sf = (tok) => ({ turns: tok ? 3 : 0, inTok: tok, outTok: 0, ms: 0 });
const U = (over) => ({ defaultEngine: 'claude', configured: ['claude', 'codex', 'deepseek'], claude: null, codex: null, deepseek: null, ...over });
const row = (P, u, id) => P.ctx.pmRows(u, NOW).find((r) => r.id === id);

test('Codex: % real das janelas + plano; reinícios no tooltip; sem rate_limits → sem dados ainda', () => {
  const P = load();
  const u = U({ configured: ['codex'], codex: { hasData: true, plan: 'plus', primary: { usedPercent: 9, windowMinutes: 300, resetsAt: R18, reset: false }, secondary: { usedPercent: 1, windowMinutes: 10080, resetsAt: R18 + 6 * 864e5, reset: false } } });
  const r = row(P, u, 'codex');
  assert.equal(r.name + ' · ' + r.text, 'Codex · 5h 9 % · semana 1 % · plus');
  assert.equal(r.level, 'ok');
  assert.match(r.tip, new RegExp('5h: 9 % · reinicia ' + hm(R18)));
  assert.match(r.tip, /semana: 1 % · reinicia \d\d\/\d\d \d\d:\d\d/, 'outro dia: com a data');
  const none = row(P, U({ configured: ['codex'], codex: { hasData: false } }), 'codex');
  assert.equal(none.text, 'sem dados ainda');
  assert.equal(none.level, 'idle');
  // cores: amarelo 70–90, vermelho > 90 (pelo maior das janelas)
  assert.equal(row(P, U({ codex: { hasData: true, primary: { usedPercent: 75 }, secondary: { usedPercent: 10 } } }), 'codex').level, 'warn');
  assert.equal(row(P, U({ codex: { hasData: true, primary: { usedPercent: 20 }, secondary: { usedPercent: 95 } } }), 'codex').level, 'crit');
});

test('Claude normal: ok · reinicia · uso do Starfork; sem evento → só o uso do Starfork; nunca % inventada', () => {
  const P = load();
  const r = row(P, U({ claude: { state: 'ok', window: 'five_hour', pct: null, resetsAt: R18, starfork: sf(120000) } }), 'claude');
  assert.equal(r.text, 'ok · reinicia ' + hm(R18) + ' · Starfork usou 120k tok em 5h');
  assert.equal(r.level, 'ok');
  assert.ok(!/%/.test(r.text), 'sem utilization não há porcentagem');
  assert.match(r.tip, /% exata do Claude só aparece perto do limite/);
  const n = row(P, U({ claude: { state: 'none', window: null, pct: null, resetsAt: null, starfork: sf(45000) } }), 'claude');
  assert.equal(n.text, 'Starfork usou 45k tok em 5h');
  const z = row(P, U({ claude: { state: 'none', starfork: sf(0) } }), 'claude');
  assert.equal(z.text, 'sem dados ainda');
});

test('Claude perto do limite (92 %) em vermelho; bloqueado → limite atingido · volta HH:MM', () => {
  const P = load();
  const w = row(P, U({ claude: { state: 'warn', window: 'five_hour', pct: 92, resetsAt: R18, starfork: sf(0) } }), 'claude');
  assert.equal(w.name + ' · ' + w.text, 'Claude · 92 % (5h)');
  assert.equal(w.level, 'crit');
  assert.equal(row(P, U({ claude: { state: 'warn', window: 'seven_day', pct: 75, starfork: sf(0) } }), 'claude').level, 'warn');
  const b = row(P, U({ claude: { state: 'blocked', window: 'five_hour', pct: null, resetsAt: R18, starfork: sf(0) } }), 'claude');
  assert.equal(b.text, 'limite atingido · volta ' + hm(R18));
  assert.equal(b.level, 'crit');
});

test('DeepSeek: saldo com moeda; erro de rede → saldo indisponível (sem travar)', () => {
  const P = load();
  const d = row(P, U({ deepseek: { ok: true, available: true, balances: [{ currency: 'USD', total: '4.20' }] } }), 'deepseek');
  assert.equal(d.name + ' · ' + d.text, 'DeepSeek · saldo US$ 4,20');
  const e = row(P, U({ deepseek: { ok: false, available: false, balances: [] } }), 'deepseek');
  assert.equal(e.text, 'saldo indisponível');
  assert.equal(row(P, U({ deepseek: { ok: true, available: false, balances: [{ currency: 'USD', total: '0.00' }] } }), 'deepseek').level, 'crit');
});

test('só IA configurada aparece; nada configurado → "configure sua IA" → painel', () => {
  const P = load();
  const html = P.ctx.pmHtml(U({ configured: ['codex'], codex: { hasData: false } }), false, 'claude', NOW);
  assert.ok(html.includes('Codex') && !html.includes('Claude') && !html.includes('DeepSeek'));
  const empty = P.ctx.pmHtml(U({ configured: [] }), false, 'claude', NOW);
  assert.match(empty, /configure sua IA/);
  assert.match(empty, /data-pm="cfg"/);
  assert.ok(!/OPENAI_API_KEY|DEEPSEEK_API_KEY/.test(html + empty), 'nunca nome/valor de chave');
});

test('minimizado = uma linha (a IA padrão) e persiste após reiniciar; expandido = uma linha por IA', async () => {
  const store = { defaultEngine: 'codex' };
  const usage = U({ claude: { state: 'ok', window: 'five_hour', resetsAt: R18, starfork: sf(0) }, codex: { hasData: true, plan: 'plus', primary: { usedPercent: 9 }, secondary: { usedPercent: 1 } }, deepseek: { ok: true, available: true, balances: [{ currency: 'USD', total: '4.20' }] } });
  const P = load(store, { usage });
  await P.run('pmLoad()');
  assert.deepEqual(P.calls.filter((c) => c[0] === 'plan_usage').length, 1);
  assert.equal((P.el.innerHTML.match(/class="pm-row pm-/g) || []).length, 3, 'expandido: uma linha por IA');
  // clique no cabeçalho → minimiza
  P.el.listeners.click({ target: { closest: () => ({ dataset: { pm: 'toggle' } }) } });
  assert.equal(store.planMeterMin, '1');
  assert.ok(P.el.classList.contains('min'));
  assert.ok(!/class="pm-row/.test(P.el.innerHTML));
  assert.match(P.el.innerHTML, /Codex · 5h 9 %/, 'minimizado: a IA padrão + %');
  // "reinicia o app": novo contexto com o mesmo localStorage
  const Q = load(store, { usage });
  await Q.run('pmLoad()');
  assert.ok(Q.el.classList.contains('min'), 'continua minimizado');
  assert.match(Q.el.innerHTML, /Codex · 5h 9 %/);
  // clique numa linha (expandido) → painel Sua IA
  Q.el.listeners.click({ target: { closest: () => ({ dataset: { pm: 'toggle' } }) } });
  assert.equal(store.planMeterMin, '0');
  Q.el.listeners.click({ target: { closest: () => ({ dataset: { pm: 'cfg' } }) } });
  assert.deepEqual(Q.calls.at(-1), ['suaIaOpenCfg']);
});

test('atualização leve: boot + ciclo de 2 min só com a janela visível; fim de turno sem rajada', async () => {
  const P = load({}, { usage: U({ configured: [] }) });
  assert.ok(P.timers.some((t) => t[0] === 'i' && t[1] === 120000), 'ciclo de 2 min');
  assert.ok(P.timers.some((t) => t[0] === 't' && t[1] === 1500), 'leitura no boot');
  await P.run('pmLoad()');
  const n0 = P.calls.length;
  P.run('pmTick()'); // acabou de ler: não relê
  P.run('pmAt=0; document.hidden=true; pmTick()'); // escondida: não lê
  assert.equal(P.calls.length, n0);
  await P.run('document.hidden=false; pmTick() || _pmP');
  assert.equal(P.calls.length, n0 + 1);
  const t0 = P.timers.length;
  P.run('planMeterTurnEnd(); planMeterTurnEnd(); planMeterTurnEnd()');
  assert.equal(P.timers.length, t0 + 1, 'várias tarefas terminando juntas = uma leitura');
});
