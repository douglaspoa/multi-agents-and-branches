// Piloto automático (spec-piloto-automatico, 56-piloto.js): `node --test app/tests/piloto.test.mjs`
// Formulário "app do zero" (validação → argumentos do autopilot_start), aba de progresso lendo o state.json
// (fases, ondas, tarefas, tentativas, reprovações, custo, ações parar/continuar/relatório), início pelo Rust e
// a aba registrada no padrão (VIEW_META/VIEW_OVERLAY/viewOpen, um dos jeitos da Nova demanda, overlays no HTML).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tick = () => new Promise((r) => setTimeout(r, 0));
// elemento "engole tudo" (o toast do 00-util cria nós no body)
const stubEl = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'dataset' ? {} : k === Symbol.toPrimitive ? () => '' : stubEl()),
  set: () => true,
  apply: () => stubEl(),
});

function load(opts = {}) {
  const calls = [], store = {}, els = {};
  const el = (id) => (els[id] ??= { id, innerHTML: '', value: undefined, style: { display: 'none' }, dataset: {}, addEventListener(ev, fn) { this['on' + ev] = fn; }, focus() {} });
  const tabs = [];
  const ctx = {
    window: { addEventListener: () => {}, openTab: (k) => tabs.push(k), switchProject: async (d) => { calls.push(['switch', d]); }, ndMethodSeg: (c) => `<seg ${c}>`, ndTakeCarry: () => opts.carry || '' },
    document: { getElementById: el, addEventListener: () => {}, createElement: () => stubEl(), body: stubEl(), querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' },
    console, setTimeout: (fn) => { if (opts.runTimers) fn(); return 0; }, clearTimeout: () => {},
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ovShow: (o) => { o.style.display = 'block'; }, toast: () => {},
    invokeQuiet: (cmd, args) => { calls.push([cmd, args]); return opts.invoke ? opts.invoke(cmd, args) : Promise.resolve(null); },
    state: { repo: '/r' },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/00-util.js') + '\n' + read('js/56-piloto.js') + '\ntoast=function(){};', ctx);
  return { ctx, el, calls, tabs, store, run: (c) => vm.runInContext(c, ctx) };
}

const ST = () => ({
  version: 1, idea: 'recriar o jogo Pou', name: 'Pou', platform: 'mobile', engine: 'claude', parallel: 2, attempts: 2, budgetUsd: 10,
  dir: '/Users/x/Documents/Starfork/pou', epicTitle: 'Pou', phase: 'building', pid: 42, alive: true, stopRequested: false, hasReport: false,
  costUsd: 3.456, events: [{ at: 1, text: 'épico "Pou": 3 tarefas' }, { at: 2, text: '✕ provas de "Alimentar" reprovadas', ok: false }],
  tasks: [
    { id: 'esqueleto', title: 'Criar o esqueleto', wave: 0, after: [], stage: 'merged', attempts: 1, reasons: [], history: [{ ok: true }] },
    { id: 'alimentar', title: 'Alimentar o bicho', wave: 1, after: ['esqueleto'], stage: 'running', attempts: 2, reasons: ['requisito não provado (blocked): barra sobe'], history: [{ ok: false }] },
    { id: 'dormir', title: 'Dormir <b>', wave: 1, after: ['esqueleto'], stage: 'blocked', attempts: 2, reasons: ['sem simulador'], history: [{ ok: false }, { ok: false }] },
  ],
});

test('validação: ideia, plataforma, limites e teto viram os argumentos do autopilot_start', () => {
  const { ctx } = load();
  assert.match(ctx.pilotoValidate({ idea: 'pou' }).err, /ideia/);
  assert.match(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'desktop', parallel: 2, attempts: 2 }).err, /plataforma/);
  assert.match(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 9, attempts: 2 }).err, /1 a 4/);
  assert.match(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 2, attempts: 2, budget: 'muito' }).err, /Teto/);
  const ok = ctx.pilotoValidate({ idea: '  recriar o jogo Pou ', platform: 'mobile', name: '', engine: 'claude', model: '', parallel: '3', attempts: '2', budget: '7,5' });
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { ok: true, args: { idea: 'recriar o jogo Pou', platform: 'mobile', name: null, engine: 'claude', model: null, parallel: 3, attempts: 2, budgetUsd: 7.5 } });
  assert.equal(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 1, attempts: 1, budget: '' }).args.budgetUsd, null, 'vazio = sem teto');
});

test('formulário: 4 plataformas, IA, botão "Construir sozinho", erro visível e a ideia escapada', () => {
  const { ctx } = load();
  const h = ctx.pilotoFormHtml({ idea: 'jogo <script>', platform: 'ios' }, false, 'falhou');
  assert.match(h, /data-pil-plat="ios" aria-pressed="true"/);
  assert.equal((h.match(/data-pil-plat=/g) || []).length, 4);
  assert.match(text(h), /Construir sozinho/);
  assert.match(h, /role="alert">falhou/);
  assert.match(h, /jogo &lt;script>/);
  assert.match(text(h), /sem GitHub/);
  assert.match(ctx.pilotoFormHtml({}, true, ''), /disabled>Criando o projeto…/);
});

test('progresso: fases, ondas, tarefas com tentativas e motivo, custo com teto, linha do tempo e ação Parar', () => {
  const { ctx } = load();
  const h = ctx.pilotoProgHtml(ST());
  const t = text(h);
  assert.match(h, /class="pil-step cur" aria-current="step">Construir/);
  assert.match(h, /class="pil-step ok">Planejar o épico/);
  assert.match(t, /Onda 0 · esqueleto/);
  assert.match(t, /Onda 1/);
  assert.match(t, /1\/3 na main/);
  assert.match(t, /US\$ 3,46 de US\$ 10,00/);
  assert.match(t, /tentativa 2\/2 · 1 reprovada/);
  assert.match(text(ctx.pilotoProgHtml(Object.assign(ST(), { tasks: [{ id: 'x', title: 'X', wave: 1, stage: 'pending', attempts: 0, reasons: [], history: [] }] }))), /ainda não começou/);
  assert.match(t, /requisito não provado \(blocked\): barra sobe/);
  assert.match(t, /sem simulador/);
  assert.match(h, /Dormir &lt;b>/);
  assert.match(h, /data-pil-act="stop"/);
  assert.doesNotMatch(h, /data-pil-act="resume"/);
  assert.match(h, /<li class="bad">✕ provas/);
  assert.match(h, /data-pil-task="alimentar"/);
});

test('progresso: parado/teto mostram o motivo e "Continuar"; concluído mostra o relatório e não continua', () => {
  const { ctx } = load();
  const b = Object.assign(ST(), { phase: 'budget', alive: false, stopReason: 'teto de custo atingido', hasReport: true });
  const h = ctx.pilotoProgHtml(b);
  assert.match(text(h), /Parou por custo/);
  assert.match(text(h), /teto de custo atingido/);
  assert.match(h, /data-pil-act="resume"/);
  assert.match(h, /data-pil-act="report"/);
  assert.doesNotMatch(h, /data-pil-act="stop"/);
  const d = ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'done', alive: false, hasReport: true }));
  assert.doesNotMatch(d, /data-pil-act="resume"/);
  assert.equal(ctx.pilotoEnded(Object.assign(ST(), { phase: 'done', alive: false })), true);
  assert.equal(ctx.pilotoEnded(ST()), false);
  assert.match(ctx.pilotoProgHtml(null), /Nenhum piloto/);
  assert.match(ctx.pilotoProgHtml(Object.assign(ST(), { alive: true, stopRequested: true })), /parando depois do passo atual/);
});

test('Construir sozinho: chama autopilot_start, abre o projeto e a aba de progresso; erro fica no formulário', async () => {
  const L = load({ carry: 'recriar o jogo Pou', invoke: (cmd) => (cmd === 'autopilot_start' ? Promise.resolve('/docs/Starfork/pou') : Promise.resolve(null)) });
  L.ctx.openPiloto();
  assert.equal(L.el('pilotoOverlay').style.display, 'block');
  assert.match(L.el('pilBody').innerHTML, /recriar o jogo Pou/, 'o texto levado do Conversar vira a ideia');
  L.el('pilIdea').value = 'recriar o jogo Pou'; L.el('pilEngine').value = 'claude'; L.el('pilPar').value = '2'; L.el('pilAtt').value = '2'; L.el('pilBudget').value = '';
  await L.run('pilStart()');
  await tick();
  const start = L.calls.find((c) => c[0] === 'autopilot_start');
  assert.equal(start[1].idea, 'recriar o jogo Pou');
  assert.equal(start[1].platform, 'web');
  assert.equal(JSON.stringify(L.calls.find((c) => c[0] === 'switch')), JSON.stringify(['switch', '/docs/Starfork/pou']));
  assert.equal(JSON.stringify(L.tabs), JSON.stringify(['pilotorun']));
  assert.equal(L.store['piloto:dir'] ?? L.ctx.localStorage.getItem('piloto:dir'), '/docs/Starfork/pou');
  const F = load({ invoke: () => Promise.reject(new Error('o piloto não começou — saída do motor: x')) });
  F.ctx.openPiloto();
  F.el('pilIdea').value = 'um app de lista de compras'; F.el('pilPar').value = '2'; F.el('pilAtt').value = '2';
  await F.run('pilStart()');
  await tick();
  assert.match(F.el('pilBody').innerHTML, /role="alert"/);
  assert.equal(F.tabs.length, 0);
});

test('aba de progresso lê o autopilot_status da pasta lembrada e as ações chamam o Rust', async () => {
  const L = load({ invoke: (cmd) => (cmd === 'autopilot_status' ? Promise.resolve(ST()) : Promise.resolve(null)) });
  L.ctx.localStorage.setItem('piloto:dir', '/p');
  await L.ctx.openPilotoRun();
  await tick();
  assert.equal(JSON.stringify(L.calls.find((c) => c[0] === 'autopilot_status')), JSON.stringify(['autopilot_status', { dir: '/p' }]));
  assert.match(L.el('pilRunBody').innerHTML, /Alimentar o bicho/);
  await L.run("pilAct('stop')");
  assert.ok(L.calls.some((c) => c[0] === 'autopilot_stop' && c[1].dir === '/p'));
  await L.run("pilAct('resume')");
  assert.ok(L.calls.some((c) => c[0] === 'autopilot_resume' && c[1].dir === '/p'));
});

test('registrada no padrão: aba (não modal), um dos jeitos da Nova demanda, overlays, script, CSS e comandos do Rust', () => {
  const abas = read('js/15-config-abas-onboarding.js');
  assert.match(abas, /piloto:\{title:'Piloto automático'/);
  assert.match(abas, /pilotorun:\{title:'Progresso do piloto'/);
  assert.match(abas, /piloto:'pilotoOverlay', pilotorun:'pilotoRunOverlay'/);
  assert.match(abas, /piloto:\(\)=>window\.openPiloto&&window\.openPiloto\(\)/);
  assert.match(abas, /pilotorun:\(\)=>window\.openPilotoRun&&window\.openPilotoRun\(\)/);
  assert.match(abas, /MULTI_KINDS=new Set\(\[[^\]]*'piloto'/);
  assert.match(read('js/14-nova-demanda-inicio.js'), /\{ k:'auto', tab:'piloto', name:'Piloto automático'/);
  const html = read('index.html');
  for (const id of ['pilotoOverlay', 'pilotoRunOverlay', 'pilBody', 'pilRunBody', 'pilSeg']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<script src="js\/56-piloto\.js"><\/script>/);
  assert.match(html, /css\/90-piloto\.css/);
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  for (const c of ['autopilot_start', 'autopilot_status', 'autopilot_stop', 'autopilot_resume', 'autopilot_open_report']) assert.match(lib, new RegExp(`autopilot::${c},`));
});
