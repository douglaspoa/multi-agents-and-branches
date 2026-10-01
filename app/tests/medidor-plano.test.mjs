// Medidor do plano no menu lateral (spec-medidor-plano): render dos estados (Claude/Codex/DeepSeek), cores,
// "configure sua IA", erro com "tentar de novo", minimizar persiste, IA padrão, acessibilidade, atualização leve
// e o gancho de fim de turno do 10-core (detectNotifs). Carrega 00-util + (11 puro + 29) + 28 num vm.
// Entrada = o MESMO golden que o Rust serializa (tests/fixtures/plan-usage-golden/payload.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const GOLDEN = JSON.parse(readFileSync(new URL('../../tests/fixtures/plan-usage-golden/payload.json', import.meta.url), 'utf8'));
const golden = () => JSON.parse(JSON.stringify(GOLDEN));

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
  const el = fakeEl();
  const ctx = {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { hidden: false, getElementById: (id) => (id === 'planMeter' ? el : null), addEventListener: noop, querySelectorAll: () => [], querySelector: () => null, documentElement: { style: { setProperty: noop } }, activeElement: null },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' },
    console,
    setTimeout: (fn, ms) => { const t = { ms, fn, on: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t && typeof t === 'object') t.on = false; },
    setInterval: (fn, ms) => { timers.push({ ms, fn, on: true, every: true }); return timers.length; },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    suaIaOpenCfg: () => calls.push(['suaIaOpenCfg']),
    invoke: async () => null,
    invokeQuiet: async (cmd) => {
      calls.push([cmd]);
      if (opts.fail && opts.fail()) throw new Error('falhou');
      return opts.usage === undefined ? golden() : opts.usage;
    },
  };
  vm.createContext(ctx);
  const env = cut(read('11-ambiente-updater.js'), '// @env-puro-inicio', '// @env-puro-fim');
  // 29-ia-picker de verdade: aiDefaults/aiEngineOf reais (localStorage defaultEngine)
  vm.runInContext(read('00-util.js') + '\n' + env + '\n' + read('29-ia-picker.js') + '\n' + read('28-medidor-plano.js'), ctx);
  return { ctx, el, calls, timers, run: (c) => vm.runInContext(c, ctx) };
}
const click = (P, pm) => P.el.listeners.click({ target: { closest: () => ({ dataset: { pm } }) } });

// horário local de um epoch (o widget mostra no fuso da máquina)
const hm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const NOW = GOLDEN.claude.resetsAt - 4 * 3600 * 1000;
const R = GOLDEN.claude.resetsAt;
const U = (over) => ({ ...golden(), ...over });
const row = (P, u, id) => P.ctx.pmRows(u, NOW).find((r) => r.id === id);

test('golden do Rust: as três linhas como na matriz da spec', () => {
  const P = load();
  const rows = P.ctx.pmRows(golden(), NOW);
  assert.equal(rows.map((r) => r.id).join(','), 'claude,codex,deepseek');
  assert.equal('Codex · ' + rows[1].text, 'Codex · 5h 9 % · semana 1 % · plus');
  assert.equal(rows[0].text, 'ok · reinicia ' + hm(R) + ' · Starfork usou 120k tok em 5h neste projeto');
  assert.equal('DeepSeek · ' + rows[2].text, 'DeepSeek · saldo US$ 4,20');
});

test('Codex: rótulo da janela pelos minutos; reinícios visíveis no detalhe; sem rate_limits → sem dados ainda', () => {
  const P = load();
  const r = row(P, golden(), 'codex');
  assert.match(r.detail, new RegExp('5h reinicia ' + hm(GOLDEN.codex.primary.resetsAt)));
  assert.match(r.detail, /semana reinicia \d\d\/\d\d \d\d:\d\d/, 'outro dia: com a data');
  const odd = row(P, U({ codex: { hasData: true, primary: { usedPercent: 40, windowMinutes: 120 }, secondary: { usedPercent: 5, windowMinutes: 4320 } } }), 'codex');
  assert.equal(odd.text, '2h 40 % · 3d 5 %');
  assert.equal(row(P, U({ codex: { hasData: false } }), 'codex').text, 'sem dados ainda');
  // cores: amarelo 70–90, vermelho > 90 (pelo maior das janelas)
  assert.equal(row(P, U({ codex: { hasData: true, primary: { usedPercent: 75, windowMinutes: 300 }, secondary: { usedPercent: 10, windowMinutes: 10080 } } }), 'codex').level, 'warn');
  assert.equal(row(P, U({ codex: { hasData: true, primary: { usedPercent: 20, windowMinutes: 300 }, secondary: { usedPercent: 95, windowMinutes: 10080 } } }), 'codex').level, 'crit');
});

test('Claude: nunca % inventada; uso "neste projeto"; sem evento → só o uso; erro do uso; claude sem resumo → sem dados', () => {
  const P = load();
  const r = row(P, golden(), 'claude');
  assert.ok(!/%/.test(r.text));
  assert.match(r.detail, /% exata do Claude só aparece perto do limite/, 'aviso visível no expandido');
  assert.match(r.detail, /Neste projeto, últimas 5 h: 118k tok de entrada, 2k de saída, 3 turno\(s\), 10 min/);
  const n = row(P, U({ claude: { ...GOLDEN.claude, state: 'none', window: null, resetsAt: null } }), 'claude');
  assert.equal(n.text, 'Starfork usou 120k tok em 5h neste projeto');
  const e = row(P, U({ claude: { ...GOLDEN.claude, starforkError: 'database is locked' } }), 'claude');
  assert.match(e.text, /uso do Starfork indisponível/);
  const z = row(P, U({ claude: null }), 'claude');
  assert.equal(z.text, 'sem dados ainda', 'configurado mas sem resumo: a linha continua');
});

test('Claude perto do limite: 92 % vermelho; warn com % baixa nunca fica verde; bloqueado sempre vermelho', () => {
  const P = load();
  const c = (o) => row(P, U({ claude: { ...GOLDEN.claude, ...o } }), 'claude');
  const w = c({ state: 'warn', pct: 92 });
  assert.equal('Claude · ' + w.text, 'Claude · 92 % (5h)');
  assert.equal(w.level, 'crit');
  assert.equal(c({ state: 'warn', pct: 50 }).level, 'warn', 'allowed_warning com utilization < 0,7');
  assert.equal(c({ state: 'warn', pct: 75, window: 'seven_day' }).level, 'warn');
  assert.equal(c({ state: 'ok', pct: 40 }).level, 'ok');
  const b = c({ state: 'blocked', pct: 10 });
  assert.equal(b.text, 'limite atingido · volta ' + hm(R));
  assert.equal(b.level, 'crit');
});

test('DeepSeek: saldo com moeda; erro de rede → saldo indisponível', () => {
  const P = load();
  assert.equal(row(P, U({ deepseek: { ok: false, available: false, balances: [] } }), 'deepseek').text, 'saldo indisponível');
  assert.equal(row(P, U({ deepseek: { ok: true, available: false, balances: [{ currency: 'USD', total: '0.00' }] } }), 'deepseek').level, 'crit');
});

test('só IA configurada aparece; nada configurado → "configure sua IA"; nunca nome/valor de chave', () => {
  const P = load();
  const html = P.ctx.pmHtml(U({ configured: ['codex'] }), false, 'claude', NOW);
  assert.ok(html.includes('Codex') && !html.includes('Claude') && !html.includes('DeepSeek'));
  const empty = P.ctx.pmHtml(U({ configured: [] }), false, 'claude', NOW);
  assert.match(empty, /configure sua IA/);
  assert.match(empty, /data-pm="cfg"/);
  assert.ok(!/OPENAI_API_KEY|DEEPSEEK_API_KEY/.test(html + empty));
});

test('acessibilidade: aria-controls aponta pras linhas; detalhes em texto; bolinha com equivalente em texto', () => {
  const P = load();
  const html = P.ctx.pmHtml(golden(), false, 'claude', NOW);
  assert.match(html, /data-pm="toggle" aria-expanded="true" aria-controls="pmRows"/);
  assert.match(html, /<div class="pm-rows" id="pmRows">/);
  assert.match(html, /class="pm-det">[^<]*reinicia/, 'reinícios visíveis, não só no title');
  assert.match(html, /class="pm-det">[^<]*Saldo da conta DeepSeek/);
  assert.match(html, /class="pm-dot pm-ok" role="img" aria-label="normal"/);
  const min = P.ctx.pmHtml(golden(), true, 'claude', NOW);
  assert.match(min, /aria-expanded="false" aria-controls="pmRows"/);
  assert.match(min, /id="pmRows" hidden/);
});

test('minimizado = uma linha (a IA padrão) e persiste após reiniciar; clique numa IA → Sua IA', async () => {
  const store = { defaultEngine: 'codex' };
  const P = load(store);
  await P.run('pmLoad()');
  assert.equal((P.el.innerHTML.match(/class="pm-row pm-/g) || []).length, 3, 'expandido: uma linha por IA');
  click(P, 'toggle');
  assert.equal(store.planMeterMin, '1');
  assert.ok(P.el.classList.contains('min'));
  assert.match(P.el.innerHTML, /id="pmRows" hidden/);
  assert.match(P.el.innerHTML, /Codex · 5h 9 %/, 'minimizado: a IA padrão + %');
  const Q = load(store); // "reinicia o app": mesmo localStorage
  await Q.run('pmLoad()');
  assert.ok(Q.el.classList.contains('min'), 'continua minimizado');
  click(Q, 'toggle');
  assert.equal(store.planMeterMin, '0');
  click(Q, 'cfg');
  assert.deepEqual(Q.calls.at(-1), ['suaIaOpenCfg']);
});

test('IA padrão DeepSeek: "deepseek" ou "dsh…" no localStorage → a linha do DeepSeek no minimizado', async () => {
  for (const eng of ['deepseek', 'dsh-flash']) {
    const P = load({ defaultEngine: eng, planMeterMin: '1' });
    await P.run('pmLoad()');
    assert.match(P.el.innerHTML, /DeepSeek · US\$ 4,20/, eng);
  }
});

test('1ª leitura falha → "não consegui ler o uso — tentar de novo"; tentar de novo relê', async () => {
  let fail = true;
  const P = load({}, { fail: () => fail });
  await P.run('pmLoad()');
  assert.match(P.el.innerHTML, /não consegui ler o uso — tentar de novo/);
  assert.match(P.el.innerHTML, /data-pm="retry"/);
  fail = false;
  click(P, 'retry');
  await P.run('_pmP');
  assert.match(P.el.innerHTML, /Uso do plano/);
  // falha depois de ter dados: mantém o último valor
  fail = true;
  await P.run('pmLoad()');
  assert.match(P.el.innerHTML, /Codex/);
});

test('atualização leve: boot + 2 min só visível; pmAt marcado no início; fim de turno = debounce no fim', async () => {
  const P = load({}, { usage: U({ configured: [] }) });
  assert.ok(P.timers.some((t) => t.every && t.ms === 120000), 'ciclo de 2 min');
  assert.ok(P.timers.some((t) => !t.every && t.ms === 1500), 'leitura no boot');
  const p = P.run('pmLoad()');
  assert.ok(Date.now() - P.run('pmAt') < 1000, 'pmAt marcado no início da leitura');
  await p;
  const n0 = P.calls.length;
  P.run('pmTick()'); // acabou de ler: não relê
  P.run('pmAt=0; document.hidden=true; pmTick()'); // escondida: não lê
  assert.equal(P.calls.length, n0);
  await P.run('document.hidden=false; pmTick()');
  assert.equal(P.calls.length, n0 + 1);
  const t0 = P.timers.length;
  P.run('planMeterTurnEnd(); planMeterTurnEnd(); planMeterTurnEnd()');
  const turn = P.timers.slice(t0);
  assert.equal(turn.length, 3);
  assert.deepEqual(turn.map((t) => t.on), [false, false, true], 'só a ÚLTIMA fica agendada (pega o último turno)');
});

// ---- gancho no 10-core: detectNotifs chama planMeterTurnEnd ao sair de running/thinking ----
function loadDetect() {
  const core = read('10-core.js');
  const i = core.indexOf('function detectNotifs(snap){');
  const j = core.indexOf('\n}\n', i);
  assert.ok(i >= 0 && j > i, 'detectNotifs não encontrado');
  const ctx = {
    n: 0, notifs: [],
    lsGet: () => '0', ACTIVE_ST: new Set(['running']), taskCost: () => ({ usd: 0 }), fmtCost: String,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(`let notifReady=false, prevStatus={}, prevPr={}, prevPending=new Set();
    const commitsStale={}, prCache={}, prevEvTop={}, costWarned=new Set();
    function pushNotif(t){ notifs.push(t); }
    function planMeterTurnEnd(){ n++; }
    ${core.slice(i, j + 2)}`, ctx);
  const snap = (status) => ({ tasks: [{ id: 't', title: 'x', status }], pending: [], events: [] });
  return { ctx, step: (st) => vm.runInContext('detectNotifs(__s)', Object.assign(ctx, { __s: snap(st) })) };
}

test('10-core detectNotifs: fim de turno em QUALQUER saída de running/thinking (parada, teto, done, merged…)', () => {
  for (const [from, to, yes] of [
    ['running', 'review', true], ['running', 'stopped', true], ['running', 'paused', true], ['thinking', 'waiting', true],
    ['running', 'done', true], ['running', 'merged', true], ['running', 'error', true], ['thinking', 'plan-review', true],
    ['queued', 'running', false], ['running', 'thinking', false], ['review', 'merged', false], ['running', 'running', false],
  ]) {
    const D = loadDetect();
    D.step(from); D.step(from);
    D.step(to);
    assert.equal(D.ctx.n, yes ? 1 : 0, `${from} → ${to}`);
  }
});
