// Aba "Uso" (spec-aba-uso, 55-uso.js): render dos totais/barras/tarefas a partir do MESMO formato que o Rust devolve
// (tests/fixtures/usage-golden/report.json — o teste do Rust confere as chaves), rótulos "custo informado" ×
// "estimado por tokens", aviso de plano de assinatura, testes de conexão à parte, "mostrando N de M", estado vazio,
// erro humano, detalhe por agente e rodada, respostas velhas ignoradas, releitura ao voltar depois de 1 min, a11y
// (botões com aria-pressed, listitem em volta do botão) e a aba registrada no padrão (VIEW_META/VIEW_OVERLAY/viewOpen,
// menu Mais, medidor). A mesa usa a mesma tabela de preço (espelho conferido aqui).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const G = JSON.parse(readFileSync(new URL('../../tests/fixtures/usage-golden/report.json', import.meta.url), 'utf8'));
const g = (k) => JSON.parse(JSON.stringify(G[k]));
const tick = () => new Promise((r) => setTimeout(r, 0));

function load(opts = {}) {
  const calls = [], store = {};
  const body = { innerHTML: '', listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; } };
  const overlay = { style: { display: 'none' } };
  const ctx = {
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    navigator: { platform: 'MacIntel', userAgent: '' },
    document: { getElementById: (id) => (id === 'usoBody' ? body : id === 'usoOverlay' ? overlay : null), addEventListener: () => {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console, Date,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ovShow: (o) => { o.style.display = 'block'; },
    invokeQuiet: (cmd, args) => {
      calls.push([cmd, args]);
      if (opts.invoke) return opts.invoke(cmd, args);
      if (opts.fail) return Promise.reject(new Error(opts.fail));
      return Promise.resolve(cmd === 'usage_report' ? (opts.report === undefined ? g('report') : opts.report) : g('detail'));
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/00-util.js') + '\n' + read('js/55-uso.js'), ctx);
  return { ctx, body, overlay, calls, store, run: (c) => vm.runInContext(c, ctx) };
}
const btn = (attrs) => ({ target: { closest: () => ({ dataset: attrs.dataset || {}, hasAttribute: (a) => (attrs.has || []).includes(a) }) } });

test('relatório: totais, origens em pt-BR, IA, projeto e tarefas com custo informado × estimado', () => {
  const U = load();
  const r = g('report');
  const html = U.ctx.usoHtml(r, { period: '7d', projects: r.projects });
  assert.match(html, /gasto em 7 dias/);
  assert.match(html, /US\$ 3,53/);
  assert.match(html, /parte estimada por tokens/);
  assert.match(html, /informado <b>/);
  assert.match(html, /estimado por tokens/);
  assert.match(html, /equivalente em API — não é cobrança/);
  // F4: total "US$ X (≈ R$ Y)" no cabeçalho e no KPI (fmtUsdBr); informado × estimado só em "ver detalhes"
  assert.match(html, /<span class="pgh-sumv">· <b>US\$ 3,53 \(≈ R\$ 19,42\)<\/b> em 7 dias/);
  assert.match(html, /informado <b>US\$ 3,50 \(≈ R\$/);
  assert.match(html, /estimado por tokens <b>US\$ 0,03 \(≈ R\$/);
  assert.match(html, /<div class="uso-tech uso-split">/, 'selos técnicos escondidos (uso-tech)');
  const order = ['Tarefas', 'Nova demanda (conversa e formulário)', 'Fábrica · personas (ex-Mesa)', 'Títulos e nomes de branch'].map((l) => html.indexOf(l));
  assert.ok(order.every((i) => i > 0) && order.every((v, i, a) => !i || a[i - 1] < v), 'origens na ordem: ' + order);
  assert.match(html, /Fábrica · personas \(ex-Mesa\)[\s\S]*?estimado por tokens/);
  assert.match(html, /1,5 mi do cache/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  // testes de conexão: à parte, fora do total
  assert.match(html, /Testes de conexão \(fora do total\): US\$ 0,0002/);
  // tarefas: tabela; o título é um botão que abre a linha (aria-expanded)
  assert.match(html, /<tr class="uso-trw"><td><button type="button" class="uso-task" data-uso-task="t-filtro" data-uso-tproj="\/Users\/x\/proj-a" aria-expanded="false"/);
  assert.ok(html.indexOf('Filtro por data') < html.indexOf('Tarefa antiga'));
  assert.match(html, /proj-a · histórico/);
  assert.doesNotMatch(html, /mostrando/);
  // período: botões com aria-pressed (sem radiogroup pela metade)
  assert.match(html, /<button type="button" aria-pressed="true" class="on" data-uso-period="7d">/);
  assert.doesNotMatch(html, /role="radio/);
  // projeto: TODOS os conhecidos (proj-b não gastou no período)
  assert.match(html, /<option value="\/Users\/x\/proj-a">proj-a<\/option><option value="\/Users\/x\/proj-b">proj-b<\/option>/);
  // lista cortada: o Rust devolve o total
  const cut = U.ctx.usoHtml({ ...r, tasksTotal: 512 }, { period: '7d' });
  assert.match(cut, /mostrando 2 de 512 tarefas/);
});

test('estado vazio explica; erro mostra a frase humana com "tentar de novo"', () => {
  const U = load();
  const z = { usd: 0, usdEstimated: 0, usdReported: 0, inTok: 0, cachedTok: 0, outTok: 0, calls: 0, ms: 0 };
  const e = U.ctx.usoHtml({ ...g('report'), totals: z, tests: z, bySource: [], byEngine: [], byProject: [], tasks: [], tasksTotal: 0 }, { period: 'hoje' });
  assert.match(e, /Nenhum uso de IA registrado hoje/);
  assert.match(e, /tarefas, planner, personas, chats/);
  const err = U.ctx.usoHtml(null, { period: '7d', err: 'Não consegui ler o registro de uso (~/.constellation/usage/usage.sqlite) — as chamadas de IA seguem normais' });
  assert.match(err, /role="alert"/);
  assert.match(err, /as chamadas de IA seguem normais/);
  assert.match(err, /tentar de novo/);
});

test('detalhe da tarefa: por agente e por rodada, com tokens, US$, tempo e marcação de estimado/histórico', () => {
  const U = load();
  const h = U.ctx.usoDetailHtml(g('detail'));
  assert.match(h, /data-uso-back/);
  assert.match(h, /Filtro por data/);
  assert.match(h, /<td>Coder<\/td><td>Claude Code<\/td>/);
  assert.match(h, /<td>Revisor<\/td><td>Codex<\/td>/);
  assert.match(h, /claude-sonnet-5/);
  assert.match(h, /1,2 mi/);
  assert.match(h, /estimado<\/span>/);
  assert.match(h, /· histórico/);
});

test('abrir lê usage_report (hoje = meia-noite local, período lembrado pelo lsSet); detalhe; voltar', async () => {
  const U = load();
  await U.run('openUso()');
  assert.equal(U.overlay.style.display, 'block');
  assert.deepEqual([U.calls[0][0], U.calls[0][1].period, U.calls[0][1].since], ['usage_report', '7d', null]);
  assert.match(U.body.innerHTML, /Filtro por data/);
  U.body.listeners.click(btn({ dataset: { usoPeriod: 'hoje' } }));
  await tick();
  const [, a] = U.calls.at(-1);
  assert.equal(a.period, 'hoje');
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  assert.equal(a.since, mid.getTime());
  assert.equal(U.store.usoPeriod, 'hoje', 'grava com o mesmo helper que lê (lsSet/lsGet)');
  U.body.listeners.click(btn({ dataset: { usoTask: 't-filtro', usoTproj: '/Users/x/proj-a' } }));
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(U.calls.at(-1))), ['usage_task_detail', { taskId: 't-filtro', project: '/Users/x/proj-a' }]);
  assert.match(U.body.innerHTML, /Por etapa \/ agente/);
  U.body.listeners.click(btn({ has: ['data-uso-back'] }));
  assert.match(U.body.innerHTML, /Por origem/);
});

test('resposta VELHA do relatório é ignorada; erro do detalhe de outra tarefa não pinta a tela', async () => {
  const pend = [];
  const U = load({ invoke: (cmd, args) => new Promise((res, rej) => pend.push({ cmd, args, res, rej })) });
  const p1 = U.run('usoLoad()');                 // 7d
  U.run('USO.period="30d"');
  const p2 = U.run('usoLoad()');                 // 30d (a última pedida)
  pend[1].res({ ...g('report'), period: '30d' });
  await p2;
  pend[0].res({ ...g('report'), period: '7d', totals: { ...g('report').totals, calls: 0 } }); // chega depois: velha
  await p1;
  assert.equal(U.run('USO.data.period'), '30d');
  assert.match(U.body.innerHTML, /gasto em 30 dias/);
  // detalhe: abre t1, volta e abre t2; o erro de t1 chega depois → não aparece
  const d1 = U.run('usoOpenTask("t1","")');
  U.run('USO.detail=null');
  const d2 = U.run('usoOpenTask("t2","")');
  pend[2].rej(new Error('falhou t1'));
  await d1;
  assert.equal(U.run('USO.detailErr'), '');
  pend[3].res(g('detail'));
  await d2;
  assert.match(U.body.innerHTML, /Por etapa \/ agente/);
});

test('voltar pra aba: menos de 1 min só mostra (detalhe aberto fica); mais de 1 min relê', async () => {
  const U = load();
  await U.run('openUso()');
  assert.equal(U.calls.length, 1);
  await U.run('openUso()');
  assert.equal(U.calls.length, 1, 'dados frescos: não relê');
  U.run('USO.at = Date.now() - 61000');
  await U.run('openUso()');
  assert.equal(U.calls.length, 2, 'mais de 60 s: relê');
  const abas = read('js/15-config-abas-onboarding.js');
  assert.doesNotMatch(abas.match(/const KEEP_ON_SWITCH=new Set\(\[[^\]]*\]\)/)[0], /'uso'/, 'a aba Uso passa pelo openUso ao voltar');
});

test('livro indisponível: a aba mostra o erro humano (não trava)', async () => {
  const U = load({ fail: 'Não consegui ler o registro de uso — as chamadas de IA seguem normais, só a contagem ficou indisponível agora.' });
  await U.run('openUso()');
  assert.match(U.body.innerHTML, /role="alert"/);
  assert.match(U.body.innerHTML, /a contagem ficou indisponível/);
});

test('aba registrada no padrão: VIEW_META/VIEW_OVERLAY/viewOpen, menu Mais, medidor e index.html', () => {
  const abas = read('js/15-config-abas-onboarding.js');
  assert.match(abas, /uso:\{title:'Uso'/);
  assert.match(abas, /uso:'usoOverlay'/);
  assert.match(abas, /uso:\(\)=>window\.openUso&&window\.openUso\(\)/);
  const html = read('index.html');
  assert.match(html, /id="usoBtn"/);
  assert.match(html, /<div class="overlay" id="usoOverlay"/);
  assert.match(html, /<div class="mbody" id="usoBody">/);
  assert.match(html, /<script src="js\/55-uso\.js"><\/script>/);
  assert.match(html, /css\/89-uso\.css/);
});

test('mesa usa a MESMA tabela de preço do livro (src/usage-prices.json: entrada, cache, saída)', () => {
  const prices = JSON.parse(readFileSync(new URL('../../src/usage-prices.json', import.meta.url), 'utf8'));
  const src = read('js/38-mesa.js');
  const m = src.match(/const MESA_TOK_USD=(\{[^\n]*\});/);
  const f = src.match(/const MESA_TOK_FALLBACK=(\{[^\n]*\});/);
  assert.ok(m && f, 'MESA_TOK_USD/MESA_TOK_FALLBACK não encontrados');
  const mesa = new Function('return ' + m[1])();
  assert.deepEqual(Object.keys(mesa).sort(), ['codex', 'deepseek', 'gateway']);
  for (const k of Object.keys(mesa)) assert.deepEqual(mesa[k], prices.engines[k], k);
  assert.deepEqual(new Function('return ' + f[1])(), prices.fallback);
});
