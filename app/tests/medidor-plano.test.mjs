// Medidor do plano no menu lateral (spec-medidor-plano + spec-medidor-v2-statusline): barras por janela com o número
// à direita, cores, ordem (IA padrão primeiro, depois por maior uso), detalhes recolhidos por IA, % real do Claude pela
// barra de status (e a dica de ativar quando não há), minimizado = barra fina da IA padrão (persiste), acessibilidade
// (progressbar com valor), "configure sua IA", erro com "tentar de novo", atualização leve e o gancho de fim de turno
// do 10-core (detectNotifs). Carrega 00-util + (11 puro + 29) + 28 num vm.
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
const click = (P, pm, pmId) => P.el.listeners.click({ target: { closest: () => ({ dataset: { pm, pmId } }) } });

// horário local de um epoch (o widget mostra no fuso da máquina)
const hm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const NOW = GOLDEN.claude.updatedAt + 2 * 60 * 1000; // a barra gravou há 2 min
const R5 = GOLDEN.claude.fiveHour.resetsAt;
const U = (over) => ({ ...golden(), ...over });
const C = (over) => U({ claude: { ...GOLDEN.claude, ...over } });
// Claude SEM a barra de status (só o rate_limit_event, como antes)
const NO_SL = { fiveHour: null, sevenDay: null, updatedAt: null, statusline: false, state: 'ok', window: 'five_hour', pct: null, resetsAt: R5 };
const rows = (P, u, def = 'claude') => P.ctx.pmRows(u, NOW, def);
const row = (P, u, id, def) => rows(P, u, def).find((r) => r.id === id);
const bars = (r) => r.bars.map((b) => `${b.label} ${Math.round(b.pct)}`).join(' · ');

test('gasto do mês (livro de uso): texto, singular/plural, nada usado, desconhecido; com % vai na linha de baixo; pede o início do mês local', async () => {
  const P = load();
  const t = (m) => P.ctx.pmMonthTxt(m);
  assert.equal(t({ usd: 3.2, tasks: 14, calls: 41 }), 'uso deste mês: US$ 3,20 · 14 tarefas');
  assert.equal(t({ usd: 1234.5, tasks: 1, calls: 2 }), 'uso deste mês: US$ 1.234,50 · 1 tarefa');
  assert.equal(t({ usd: 0.07, tasks: 0, calls: 3 }), 'uso deste mês: US$ 0,07', 'só chamadas avulsas (nova demanda, título)');
  assert.equal(t({ usd: 0, tasks: 0, calls: 0 }), 'nada usado este mês');
  assert.equal(t(null), '');
  const c = row(P, golden(), 'claude');
  assert.equal(c.foot, 'uso deste mês: US$ 3,20 · 14 tarefas');
  assert.match(P.ctx.pmHtml(golden(), false, 'claude', NOW), /<div class="pm-sub pm-month">uso deste mês: US\$ 3,20 · 14 tarefas<\/div>/);
  await P.run('pmLoad()');
  const d = new Date(); const since = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  assert.equal(P.ctx.pmMonthSince(), since);
  assert.equal(P.ctx.pmMonthSince(new Date(2026, 9, 31, 23, 59).getTime()), new Date(2026, 9, 1).getTime());
});

test('barra de status velha (> 12 h): a % some (era de outra janela) e o gasto do mês assume; detalhe pede o Claude Code', () => {
  const P = load();
  // o Rust (with_statusline) já não deixa a barra velha decidir: state/pct/window vêm do rate_limit_event
  const r = row(P, C({ updatedAt: NOW - 2 * 86400000, state: 'ok', window: 'five_hour', pct: null }), 'claude');
  assert.equal(r.bars.length, 0);
  assert.equal(r.text, 'uso deste mês: US$ 3,20 · 14 tarefas');
  assert.equal(r.hint, '');
  assert.equal(r.short, 'US$ 3,20 no mês');
  assert.ok(r.details.some((x) => /A % do Claude é de há 2 d — abra o Claude Code/.test(x)));
});

test('golden do Rust: Claude com a % real (5h 43, semana 61) + "atualizado há 2 min"; Codex com barras; DeepSeek com saldo', () => {
  const P = load();
  const rs = rows(P, golden());
  assert.equal(rs.map((r) => r.id).join(','), 'claude,codex,deepseek');
  const [c, x, d] = rs;
  assert.equal(bars(c), '5h 43 · semana 61');
  assert.equal(c.sub, 'atualizado há 2 min');
  assert.equal(c.hint, '', 'com a barra ativa: sem dica');
  assert.equal(c.level, 'ok');
  assert.equal(c.short, 'semana 61 %', 'minimizado: a maior janela');
  assert.equal(bars(x), '5h 9 · semana 1');
  assert.equal(d.bars.length, 0, 'DeepSeek: saldo, sem barra');
  assert.equal(d.text, 'saldo US$ 4,20');
  const html = P.ctx.pmHtml(golden(), false, 'claude', NOW);
  assert.match(html, /role="progressbar" aria-label="Claude 5h" aria-valuemin="0" aria-valuemax="100" aria-valuenow="43" aria-valuetext="43 % — normal"/);
  assert.match(html, /aria-label="Claude semana"[^>]*aria-valuenow="61"/);
  assert.match(html, /<span class="pm-wn pm-ok">43 %<\/span>/, 'número à direita da barra');
  assert.match(html, /style="width:43%"/);
});

test('cores: verde < 70, amarelo 70–90, vermelho > 90 ou bloqueado', () => {
  const P = load();
  const lv = (p) => row(P, C({ fiveHour: { pct: p, resetsAt: R5, reset: false }, sevenDay: null }), 'claude').bars[0].level;
  assert.deepEqual([69, 70, 90, 91, 100].map(lv), ['ok', 'warn', 'warn', 'crit', 'crit']);
  const cx = (a, b) => row(P, U({ codex: { hasData: true, primary: { usedPercent: a, windowMinutes: 300 }, secondary: { usedPercent: b, windowMinutes: 10080 } } }), 'codex');
  assert.equal(cx(75, 10).level, 'warn', 'a IA fica com a pior janela');
  assert.equal(cx(20, 95).level, 'crit');
  assert.equal(bars(cx(40, 5)), '5h 40 · semana 5');
  const odd = row(P, U({ codex: { hasData: true, primary: { usedPercent: 40, windowMinutes: 120 }, secondary: { usedPercent: 5, windowMinutes: 4320 } } }), 'codex');
  assert.equal(bars(odd), '2h 40 · 3d 5');
  assert.equal(row(P, U({ codex: { hasData: false } }), 'codex').text, 'uso deste mês: US$ 0,85 · 2 tarefas', 'sem % → gasto do mês (livro)');
  assert.equal(row(P, U({ codex: { hasData: false }, month: undefined }), 'codex').text, 'sem dados ainda', 'backend sem livro: como antes');
});

test('ordem: IA padrão primeiro, depois as outras por maior uso (sem % no fim)', () => {
  const P = load();
  assert.equal(rows(P, golden(), 'codex').map((r) => r.id).join(','), 'codex,claude,deepseek');
  assert.equal(rows(P, golden(), 'deepseek').map((r) => r.id).join(','), 'deepseek,claude,codex');
  const hot = U({ codex: { hasData: true, primary: { usedPercent: 80, windowMinutes: 300 } } });
  assert.equal(rows(P, hot, 'deepseek').map((r) => r.id).join(','), 'deepseek,codex,claude', 'Codex 80 % passa o Claude 61 %');
  assert.equal(rows(P, U({ claude: { ...GOLDEN.claude, ...NO_SL } }), 'deepseek').map((r) => r.id).join(','), 'deepseek,codex,claude', 'Claude sem % vai pro fim');
});

test('Claude sem a barra de status: comportamento antigo + dica "ative a % do Claude em Sua IA" (clicável); nunca % inventada', () => {
  const P = load();
  const r = row(P, C(NO_SL), 'claude');
  assert.equal(r.bars.length, 0);
  assert.equal(r.text, 'uso deste mês: US$ 3,20 · 14 tarefas', 'sem %: o gasto do mês é a linha principal');
  assert.ok(r.details.includes('Limite ok · reinicia ' + hm(R5) + '.'));
  assert.equal(row(P, U({ claude: { ...GOLDEN.claude, ...NO_SL }, month: undefined }), 'claude').text, 'ok · reinicia ' + hm(R5), 'sem livro: comportamento antigo');
  assert.equal(r.hint, 'Ative a % do Claude em Sua IA.');
  assert.ok(!/%\s*$/.test(r.text) && !/\d+ %/.test(r.text));
  const html = P.ctx.pmHtml(C(NO_SL), false, 'claude', NOW);
  assert.match(html, /<button class="pm-hint" data-pm="cfg" data-pm-id="claude">Ative a % do Claude em Sua IA.<\/button>/);
  // instalada mas ainda sem resposta do Claude Code: nada pra pessoa fazer → a explicação vai pros detalhes
  const sl = row(P, C({ ...NO_SL, statusline: true }), 'claude');
  assert.equal(sl.hint, '');
  assert.ok(sl.details.includes('A % aparece depois da próxima resposta do Claude Code.'));
  assert.ok(row(P, C(NO_SL), 'claude').details.some((d) => /só aparece perto do limite/.test(d)));
  // sem evento e sem livro: só o uso do Starfork; erro do uso NUNCA vira texto principal (só detalhes)
  const noLedger = (o) => U({ claude: { ...GOLDEN.claude, ...NO_SL, ...o }, month: undefined });
  assert.equal(row(P, noLedger({ state: 'none', window: null, resetsAt: null }), 'claude').text, 'Starfork usou 120k tok em 5h');
  const se = row(P, C({ ...NO_SL, state: 'none', starforkError: 'database is locked' }), 'claude');
  assert.equal(se.text, 'uso deste mês: US$ 3,20 · 14 tarefas');
  assert.ok(se.details.includes('Uso do Starfork indisponível agora.'));
  const z = row(P, U({ claude: null }), 'claude');
  assert.equal(z.text, 'uso deste mês: US$ 3,20 · 14 tarefas', 'configurado mas sem resumo: a linha continua com o gasto do mês');
  assert.equal(row(P, U({ claude: null, monthError: 'locked' }), 'claude').text, 'sem dados ainda', 'livro com erro: não inventa "nada usado"');
  assert.equal(z.hint, 'Ative a % do Claude em Sua IA.');
});

test('Claude perto do limite / bloqueado: estado do evento prevalece; warn nunca verde; % só do evento sem a barra', () => {
  const P = load();
  const b = row(P, C({ state: 'blocked', window: 'five_hour', pct: 98, resetsAt: R5, fiveHour: { pct: 98, resetsAt: R5, reset: false } }), 'claude');
  assert.equal(b.text, 'limite atingido · volta ' + hm(R5));
  assert.equal(b.level, 'crit');
  assert.equal(b.bars.find((x) => x.key === 'five_hour').level, 'crit');
  assert.equal(b.short, 'limite atingido');
  const w = row(P, C({ ...NO_SL, state: 'warn', pct: 92 }), 'claude');
  assert.equal(bars(w), '5h 92', 'sem a barra: a % que o Claude Code mandou perto do limite');
  assert.equal(w.level, 'crit');
  assert.equal(row(P, C({ ...NO_SL, state: 'warn', pct: 50 }), 'claude').level, 'warn', 'allowed_warning com utilization < 0,7');
  const nw = row(P, C({ ...NO_SL, state: 'warn', pct: null, window: 'seven_day' }), 'claude');
  assert.equal(nw.text, 'perto do limite (semana) · reinicia ' + hm(R5));
  assert.equal(nw.level, 'warn');
});

test('DeepSeek: saldo com moeda; erro de rede → saldo indisponível; sem saldo vermelho', () => {
  const P = load();
  const off = row(P, U({ deepseek: { ok: false, available: false, balances: [] } }), 'deepseek');
  assert.equal(off.text, 'nada usado este mês', 'saldo fora do ar: mostra o gasto do mês, não um erro');
  assert.match(off.details[0], /não respondeu agora/);
  const m = { claude: { usd: 1, tasks: 1, calls: 1 }, deepseek: { usd: 0.4, tasks: 1, calls: 3 } };
  assert.equal(row(P, U({ deepseek: { ok: false, balances: [] }, month: m }), 'deepseek').text, 'uso deste mês: US$ 0,40 · 1 tarefa');
  assert.equal(row(P, U({ deepseek: { ok: false, balances: [] }, month: undefined }), 'deepseek').text, 'saldo indisponível');
  assert.equal(row(P, U({ month: m }), 'deepseek').foot, 'uso deste mês: US$ 0,40 · 1 tarefa', 'com saldo: o mês vai na linha de baixo');
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

test('detalhes recolhidos por IA: expandir mostra reinício, tokens do Starfork e saldo; aria-expanded/aria-controls', async () => {
  const P = load();
  await P.run('pmLoad()');
  const h0 = P.el.innerHTML;
  assert.match(h0, /data-pm="det" data-pm-id="claude" aria-expanded="false" aria-controls="pmDet-claude"/);
  assert.match(h0, /<div class="pm-det" id="pmDet-claude" hidden>/);
  click(P, 'det', 'claude');
  const h1 = P.el.innerHTML;
  assert.match(h1, /data-pm="det" data-pm-id="claude" aria-expanded="true"/);
  assert.match(h1, /<div class="pm-det" id="pmDet-claude">/);
  const det = h1.slice(h1.indexOf('id="pmDet-claude"'), h1.indexOf('</div></div>', h1.indexOf('id="pmDet-claude"')));
  // o golden tem data fixa: no dia dele é só a hora; noutro dia o produto acrescenta a data (dd/mm) — vale nos dois
  assert.match(det, new RegExp('5h reinicia (\\d\\d/\\d\\d )?' + hm(R5)));
  assert.match(det, /semana reinicia \d\d\/\d\d \d\d:\d\d/, 'outro dia: com a data');
  assert.match(det, /Starfork neste projeto, últimas 5 h: 118k tok de entrada, 2k de saída, 3 turno\(s\), 10 min/);
  assert.match(h1, /<div class="pm-det" id="pmDet-codex" hidden>/, 'só a IA clicada abre');
  assert.match(h1, /id="pmDet-deepseek" hidden><div>Saldo da conta DeepSeek/);
  click(P, 'det', 'claude');
  assert.match(P.el.innerHTML, /<div class="pm-det" id="pmDet-claude" hidden>/);
});

test('acessibilidade: aria-controls aponta pras IAs; bolinha/estado com texto; minimizado esconde a lista', () => {
  const P = load();
  const html = P.ctx.pmHtml(golden(), false, 'claude', NOW);
  assert.match(html, /data-pm="toggle" aria-expanded="true" aria-controls="pmRows"/);
  assert.match(html, /<div class="pm-rows" id="pmRows">/);
  assert.ok((html.match(/role="progressbar"/g) || []).length === 4, '2 barras do Claude + 2 do Codex');
  const min = P.ctx.pmHtml(golden(), true, 'claude', NOW);
  assert.match(min, /aria-expanded="false" aria-controls="pmRows"/);
  assert.match(min, /id="pmRows" hidden/);
  assert.match(P.ctx.pmHtml(U({ configured: [] }), false, 'claude', NOW, 'x'), /class="pm-dot pm-idle" role="img" aria-label="sem dados"/);
});

test('minimizado = barra fina da IA padrão (maior janela) + rótulo curto, e persiste após reiniciar; nome da IA → Sua IA', async () => {
  const store = { defaultEngine: 'claude' };
  const P = load(store);
  await P.run('pmLoad()');
  assert.equal((P.el.innerHTML.match(/class="pm-ia pm-/g) || []).length, 3, 'expandido: uma por IA');
  click(P, 'toggle');
  assert.equal(store.planMeterMin, '1');
  assert.ok(P.el.classList.contains('min'));
  assert.match(P.el.innerHTML, /id="pmRows" hidden/);
  assert.match(P.el.innerHTML, /<span class="pm-title">Claude<\/span><span class="pm-sum pm-ok">semana 61 %<\/span>/);
  assert.match(P.el.innerHTML, /<span class="pm-bar pm-minbar pm-ok" role="progressbar" aria-label="Claude semana"[^>]*aria-valuenow="61"/);
  const Q = load(store); // "reinicia o app": mesmo localStorage
  await Q.run('pmLoad()');
  assert.ok(Q.el.classList.contains('min'), 'continua minimizado');
  click(Q, 'toggle');
  assert.equal(store.planMeterMin, '0');
  click(Q, 'cfg');
  assert.deepEqual(Q.calls.at(-1), ['suaIaOpenCfg']);
});

test('IA padrão Codex / DeepSeek ("deepseek" ou "dsh…"): a barra fina é dela; DeepSeek sem barra mostra o saldo', async () => {
  const P = load({ defaultEngine: 'codex', planMeterMin: '1' });
  await P.run('pmLoad()');
  assert.match(P.el.innerHTML, /<span class="pm-title">Codex<\/span><span class="pm-sum pm-ok">5h 9 %<\/span>/);
  assert.match(P.el.innerHTML, /pm-minbar[^>]*aria-label="Codex 5h"/);
  for (const eng of ['deepseek', 'dsh-flash']) {
    const D = load({ defaultEngine: eng, planMeterMin: '1' });
    await D.run('pmLoad()');
    assert.match(D.el.innerHTML, /<span class="pm-title">DeepSeek<\/span><span class="pm-sum pm-ok">US\$ 4,20<\/span>/, eng);
    assert.ok(!/pm-minbar/.test(D.el.innerHTML), 'sem % → sem barra');
  }
});

test('pmAgo: limites (agora / min / h / d)', () => {
  const P = load();
  const ago = (ms) => P.ctx.pmAgo(NOW - ms, NOW);
  assert.deepEqual([0, 59999, 60000, 3599999, 3600000, 86399999, 86400000, 3 * 86400000].map(ago),
    ['agora', 'agora', 'há 1 min', 'há 59 min', 'há 1 h', 'há 23 h', 'há 1 d', 'há 3 d']);
  assert.equal(P.ctx.pmAgo(NOW + 5000, NOW), 'agora', 'relógio adiantado não vira negativo');
});

test('barra velha (> 2 h): mostra a % mas pede pra abrir o Claude Code; instalada > 30 min sem dados → precisa de Pro/Max', () => {
  const P = load();
  const H = 3600 * 1000;
  assert.equal(row(P, C({ updatedAt: NOW - 2 * H }), 'claude').sub, 'atualizado há 2 h', 'exatamente 2 h: ainda sem aviso');
  const old = row(P, C({ updatedAt: NOW - 3 * H }), 'claude');
  assert.equal(old.sub, 'atualizado há 3 h — abra o Claude Code pra atualizar');
  assert.equal(bars(old), '5h 43 · semana 61', 'a % continua visível');
  const wait = (since) => row(P, C({ ...NO_SL, statusline: true, statuslineWaitingSince: since }), 'claude').details[0];
  assert.equal(wait(NOW - 10 * 60000), 'A % aparece depois da próxima resposta do Claude Code.');
  assert.equal(wait(null), 'A % aparece depois da próxima resposta do Claude Code.');
  assert.equal(wait(NOW - 31 * 60000), 'sem dados da barra — precisa de plano Pro/Max no Claude Code (com chave de API não há %)');
});

test('ordem: Claude bloqueado/perto do limite SEM % sobe (101 / 70)', () => {
  const P = load();
  const hot = (o) => U({ claude: { ...GOLDEN.claude, ...NO_SL, ...o }, codex: { hasData: true, primary: { usedPercent: 80, windowMinutes: 300 } } });
  assert.equal(rows(P, hot({ state: 'blocked' }), 'deepseek').map((r) => r.id).join(','), 'deepseek,claude,codex', 'bloqueado (101) passa o Codex 80 %');
  assert.equal(rows(P, hot({ state: 'warn', window: 'seven_day' }), 'deepseek').map((r) => r.id).join(','), 'deepseek,codex,claude', 'warn (70) fica abaixo de 80 %');
  const cold = U({ claude: { ...GOLDEN.claude, ...NO_SL, state: 'warn', window: 'seven_day' }, codex: { hasData: true, primary: { usedPercent: 50, windowMinutes: 300 } } });
  assert.equal(rows(P, cold, 'deepseek').map((r) => r.id).join(','), 'deepseek,claude,codex', 'warn (70) acima de 50 %');
});

test('ordem estável: só reordena quando alguma IA muda ≥ 10 pontos; a IA padrão sempre primeiro', () => {
  const P = load();
  const ord = { prev: null };
  const cx = (p) => U({ codex: { hasData: true, primary: { usedPercent: p, windowMinutes: 300 } } });
  const ids = (u, def = 'deepseek') => P.ctx.pmRows(u, NOW, def, ord).map((r) => r.id).join(',');
  assert.equal(ids(cx(55)), 'deepseek,claude,codex', 'Claude 61 > Codex 55');
  assert.equal(ids(cx(64)), 'deepseek,claude,codex', 'Codex +9: não pula');
  assert.equal(ids(cx(65)), 'deepseek,codex,claude', 'Codex +10: reordena');
  assert.equal(ids(cx(60)), 'deepseek,codex,claude', 'caiu 5: mantém');
  assert.equal(ids(cx(60), 'claude'), 'claude,deepseek,codex', 'trocou a padrão: ela vem primeiro (mesma ordem pro resto)');
});

test('planMeterReset com leitura em andamento: espera ela e lê de novo; redesenho devolve o foco', async () => {
  const P = load();
  const n0 = P.calls.length;
  const p1 = P.run('pmLoad()');
  const p2 = P.run('planMeterReset()');
  await p1; await p2;
  assert.equal(P.calls.length, n0 + 2, 'a em andamento + uma NOVA depois dela');
  // foco num "detalhes" antes do redesenho → volta pro mesmo controle
  let focused = null;
  const btn = { focus: () => { focused = 'novo' } };
  Object.assign(P.el, { contains: () => true, querySelector: (sel) => (sel === '[data-pm="det"][data-pm-id="codex"]' ? btn : null) });
  P.ctx.document.activeElement = { dataset: { pm: 'det', pmId: 'codex' } };
  P.run('pmData=JSON.parse(JSON.stringify(pmData)); pmData.codex.primary.usedPercent=12; pmRender()');
  assert.equal(focused, 'novo');
});

test('leitura falha: tenta de novo sozinho; só na 3ª falha seguida mostra "não carregou" + "tentar de novo"; tentar de novo relê', async () => {
  let fail = true;
  const P = load({}, { fail: () => fail });
  await P.run('pmLoad()');
  assert.match(P.el.innerHTML, /verificando…/, '1ª falha: sem erro na cara da pessoa');
  assert.ok(P.timers.some((t) => t.on && t.ms === 15000), 'agendou nova tentativa');
  await P.run('pmLoad()');
  assert.ok(!/pm-err/.test(P.el.innerHTML));
  await P.run('pmLoad()');
  assert.match(P.el.innerHTML, /<div class="pm-err"[^>]*>.*<span class="pm-errtx">uso do plano não carregou<\/span><button class="pm-retry" data-pm="retry"[^>]*>tentar de novo<\/button><\/div>/);
  assert.match(P.el.innerHTML, /aria-label="Não consegui ler o uso do plano — tentar de novo"/);
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

test('janela volta ao foco: relê se a última leitura tem mais de 30 s (macOS pode marcar a janela de fundo como escondida)', async () => {
  const P = load({}, { usage: U({ configured: [] }) });
  await P.run('pmLoad()');
  const n0 = P.calls.length;
  P.run('pmOnFocus()'); // acabou de ler: não relê
  assert.equal(P.calls.length, n0);
  await P.run('pmAt=Date.now()-31000; pmOnFocus()');
  assert.equal(P.calls.length, n0 + 1, 'foco depois de 30 s relê');
});

test('"ver uso detalhado": o link aparece na lista expandida e o clique (pmWire) abre a aba Uso', async () => {
  const P = load({});
  await P.run('pmLoad()');
  assert.match(P.el.innerHTML, /<button class="pm-uso" data-pm="uso"[^>]*>ver uso detalhado<\/button><\/div>$/);
  const opened = [];
  P.ctx.usoOpenTab = () => opened.push('uso');
  click(P, 'uso');
  assert.deepEqual(opened, ['uso']);
  assert.ok(!P.calls.some((c) => c[0] === 'suaIaOpenCfg'), 'não cai no "abrir Sua IA"');
});
