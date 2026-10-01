// Aba "Uso" (spec-aba-uso, 55-uso.js): render dos totais/barras/tarefas a partir do MESMO formato que o Rust devolve
// (tests/fixtures/usage-golden/report.json — o teste do Rust confere as chaves), rótulos "custo informado" ×
// "estimado por tokens", aviso de plano de assinatura, estado vazio, erro humano, detalhe por agente e rodada, e a
// aba registrada no padrão (VIEW_META/VIEW_OVERLAY/viewOpen, menu Mais, medidor "ver uso detalhado").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const G = JSON.parse(readFileSync(new URL('../../tests/fixtures/usage-golden/report.json', import.meta.url), 'utf8'));
const g = (k) => JSON.parse(JSON.stringify(G[k]));

function load(opts = {}) {
  const calls = [];
  const body = { innerHTML: '', listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; } };
  const overlay = { style: { display: 'none' } };
  const ctx = {
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    navigator: { platform: 'MacIntel', userAgent: '' },
    document: { getElementById: (id) => (id === 'usoBody' ? body : id === 'usoOverlay' ? overlay : null), addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ovShow: (o) => { o.style.display = 'block'; },
    invokeQuiet: async (cmd, args) => {
      calls.push([cmd, args]);
      if (opts.fail) throw new Error(opts.fail);
      return cmd === 'usage_report' ? (opts.report === undefined ? g('report') : opts.report) : g('detail');
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/00-util.js') + '\n' + read('js/55-uso.js'), ctx);
  return { ctx, body, overlay, calls, run: (c) => vm.runInContext(c, ctx) };
}

test('relatório: totais, origens em pt-BR, IA, projeto e tarefas com custo informado × estimado', () => {
  const U = load();
  const html = U.ctx.usoHtml(g('report'), { period: '7d', projects: g('report').byProject });
  // totais + rótulos de custo + aviso do plano de assinatura
  assert.match(html, /gasto em 7 dias/);
  assert.match(html, /US\$ 3,53/);
  assert.match(html, /parte estimada por tokens/);
  assert.match(html, />informado</);
  assert.match(html, /estimado por tokens/);
  assert.match(html, /equivalente em API — não é cobrança/);
  // origens com nome humano, na ordem do Rust (por gasto)
  const order = ['Tarefas', 'Nova tarefa (planner e spec com IA)', 'Personas (mesa)', 'Título e nome de branch'].map((l) => html.indexOf(l));
  assert.ok(order.every((i) => i > 0) && order.every((v, i, a) => !i || a[i - 1] < v), 'origens na ordem: ' + order);
  assert.match(html, /Personas \(mesa\)[\s\S]*?estimado por tokens/);
  assert.match(html, /Tarefas[\s\S]*?custo informado/);
  // IA e projeto
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /proj-a/);
  // tarefas: clicáveis, a antiga marcada como histórico
  assert.match(html, /data-uso-task="t-filtro"/);
  assert.ok(html.indexOf('Filtro por data') < html.indexOf('Tarefa antiga'));
  assert.match(html, /proj-a · histórico/);
  // período e projeto
  assert.match(html, /role="radio" aria-checked="true" class="on" data-uso-period="7d"/);
  assert.match(html, /<option value="\/Users\/x\/proj-a">proj-a<\/option>/);
});

test('estado vazio explica; erro mostra a frase humana com "tentar de novo"', () => {
  const U = load();
  const empty = { ...g('report'), totals: { usd: 0, usdEstimated: 0, usdReported: 0, inTok: 0, outTok: 0, calls: 0, ms: 0 }, bySource: [], byEngine: [], byProject: [], tasks: [] };
  const e = U.ctx.usoHtml(empty, { period: 'hoje' });
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
  assert.match(h, /Por etapa \/ agente/);
  assert.match(h, /<td>Coder<\/td><td>Claude Code<\/td>/);
  assert.match(h, /<td>Revisor<\/td><td>Codex<\/td>/);
  assert.match(h, /Rodadas/);
  assert.match(h, /claude-sonnet-5/);
  assert.match(h, /1,2 mi/); // tokens legíveis
  assert.match(h, /estimado<\/span>/);
  assert.match(h, /· histórico/);
});

test('abrir a aba lê usage_report (hoje = meia-noite local); clicar na tarefa lê usage_task_detail; voltar', async () => {
  const U = load();
  await U.run('openUso()');
  assert.equal(U.overlay.style.display, 'block');
  assert.deepEqual(U.calls[0][0], 'usage_report');
  assert.equal(U.calls[0][1].period, '7d');
  assert.equal(U.calls[0][1].since, null);
  assert.match(U.body.innerHTML, /Filtro por data/);
  // troca de período pra hoje
  const btn = (attrs) => ({ target: { closest: () => ({ dataset: attrs.dataset || {}, hasAttribute: (a) => (attrs.has || []).includes(a) }) } });
  U.body.listeners.click(btn({ dataset: { usoPeriod: 'hoje' } }));
  await new Promise((r) => setTimeout(r, 0));
  const [, a] = U.calls.at(-1);
  assert.equal(a.period, 'hoje');
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  assert.equal(a.since, mid.getTime());
  // detalhe
  U.body.listeners.click(btn({ dataset: { usoTask: 't-filtro', usoTproj: '/Users/x/proj-a' } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(U.calls.at(-1))), ['usage_task_detail', { taskId: 't-filtro', project: '/Users/x/proj-a' }]);
  assert.match(U.body.innerHTML, /Por etapa \/ agente/);
  U.body.listeners.click(btn({ has: ['data-uso-back'] }));
  assert.match(U.body.innerHTML, /Por origem/);
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
  const pm = read('js/28-medidor-plano.js');
  assert.match(pm, /data-pm="uso"[^>]*>ver uso detalhado</);
  assert.match(pm, /dataset\.pm==='uso'/);
});

test('mesa usa a MESMA tabela de preço do livro (src/usage-prices.json)', () => {
  const prices = JSON.parse(readFileSync(new URL('../../src/usage-prices.json', import.meta.url), 'utf8'));
  const src = read('js/38-mesa.js');
  const m = src.match(/const MESA_TOK_USD_PER_M=(\{[^}]*\});/);
  assert.ok(m, 'MESA_TOK_USD_PER_M não encontrado');
  const mesa = new Function('return ' + m[1])();
  for (const k of Object.keys(mesa)) assert.equal(mesa[k], prices.perMillion[k], k);
  assert.deepEqual(Object.keys(mesa).sort(), ['codex', 'deepseek', 'gateway']);
});
