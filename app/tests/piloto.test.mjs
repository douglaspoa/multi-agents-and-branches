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
  const calls = [], store = {}, els = {}, timers = [], toasts = [];
  const el = (id) => (els[id] ??= { id, innerHTML: '', value: undefined, style: { display: 'none' }, dataset: {}, addEventListener(ev, fn) { this['on' + ev] = fn; }, focus() {} });
  const tabs = [];
  const ctx = {
    window: { addEventListener: () => {}, openTab: (k) => tabs.push(k), switchProject: async (d) => { calls.push(['switch', d]); }, ndMethodSeg: (c) => `<seg ${c}>`, ndTakeCarry: () => opts.carry || '' },
    document: { getElementById: el, addEventListener: () => {}, createElement: () => stubEl(), body: stubEl(), querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' },
    console, setTimeout: (fn, ms) => { timers.push(ms); if (opts.runTimers) fn(); return 0; }, clearTimeout: () => {},
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escA: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ovShow: (o) => { o.style.display = 'block'; }, toast: () => {},
    invokeQuiet: (cmd, args) => { calls.push([cmd, args]); return opts.invoke ? opts.invoke(cmd, args) : Promise.resolve(null); },
    state: { repo: opts.repo ?? '/r' },
    pushNotif: (title, body) => calls.push(['notif', title, body]),
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/00-util.js') + '\n' + read('js/56-piloto.js') + '\ntoast=function(m,k){ __toasts.push([m,k]); };', Object.assign(ctx, { __toasts: toasts }));
  return { ctx, el, calls, tabs, store, timers, toasts, run: (c) => vm.runInContext(c, ctx) };
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
  assert.match(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 2, attempts: 2, budget: 'muito' }).err, /teto/i);
  const ok = ctx.pilotoValidate({ idea: '  recriar o jogo Pou ', platform: 'mobile', name: '', engine: 'claude', model: '', parallel: '3', attempts: '2', budget: '7,5' });
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { ok: true, args: { idea: 'recriar o jogo Pou', platform: 'mobile', name: null, engine: 'claude', model: null, parallel: 3, attempts: 2, budgetUsd: 7.5 } });
  // F4: TETO OBRIGATÓRIO — vazio, 0 ou negativo não passam (fim do "padrão US$ 20" × "vazio = sem teto")
  const sem = ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 1, attempts: 1, budget: '' });
  assert.equal(sem.ok, false); assert.match(sem.err, /Defina um teto/); assert.equal(sem.field, 'pilBudget');
  assert.match(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 1, attempts: 1, budget: '0' }).err, /maior que 0/);
  assert.match(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 1, attempts: 1, budget: '-3' }).err, /maior que 0/);
  assert.equal(ctx.pilotoValidate({ idea: 'recriar o jogo Pou', platform: 'web', parallel: 1, attempts: 1, budget: '1.234,50' }).args.budgetUsd, 1234.5, 'formato BR');
});

test('fim de caminho: seguir à mão | construir sozinho, 4 plataformas, IA, teto OBRIGATÓRIO, erro visível e a ideia escapada', () => {
  const { ctx } = load();
  const h = ctx.pilotoFormHtml({ idea: 'jogo <script>', platform: 'ios' }, false, 'falhou');
  assert.match(h, /data-pil-eo="hand"/); assert.match(h, /type="radio" class="g2eor" name="pilEnd" value="auto" data-pil-eor="auto" checked/, 'construir sozinho vem marcado — rádio de verdade');
  assert.match(h, /<\/label><label class="ias-chk g2ghrow"><input type="checkbox" id="pilGh">/, 'o checkbox do GitHub fica FORA do rótulo do rádio e desmarcado sem conta conectada');
  assert.match(h, /id="pilGo" disabled>Construir sozinho/, 'sem teto o botão fica desligado');
  assert.match(h, /id="pilBudget" class="in err"/);
  assert.match(text(h), /Defina um teto: o piloto para sozinho quando chegar nele\./);
  assert.match(text(h), /obrigatório/);
  assert.doesNotMatch(h, /padrão US\$ 20|sem teto/, 'nada de placeholder contraditório');
  assert.doesNotMatch(ctx.pilotoFormHtml({ idea: 'recriar o Pou', budget: '40' }, false, ''), /id="pilGo" disabled/, 'com teto, libera');
  assert.match(ctx.pilotoFormHtml({ end: 'hand' }, false, ''), /id="pilGo">Criar o projeto/, 'seguir à mão não pede teto');
  assert.match(h, /id="pilIa"/, 'a IA é a pílula do seletor único (sem texto livre de modelo)');
  assert.doesNotMatch(h, /id="pilModel"|id="pilEngine"/);
  assert.match(h, /data-pil-plat="ios" aria-pressed="true"/);
  assert.equal((h.match(/data-pil-plat=/g) || []).length, 4);
  assert.match(text(h), /Construir sozinho/);
  assert.match(h, /role="alert">falhou/);
  assert.match(h, /jogo &lt;script>/);
  assert.match(text(h), /sem GitHub/);
  assert.match(ctx.pilotoFormHtml({}, true, ''), /disabled>Criando o projeto…/);
  assert.equal(ctx.pilotoCapSuggest(6), 40); assert.equal(ctx.pilotoCapSuggest(1), 20);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.pilotoCapCheck('5', 6))), { ok: false, err: 'O novo teto precisa ser maior que o já gasto (US$ 6,00).' });
});

test('progresso: etapas, tarefas com tentativas e motivo, custo com teto, linha do tempo e ação Parar', () => {
  const { ctx } = load();
  const h = ctx.pilotoProgHtml(ST());
  const t = text(h);
  assert.match(h, /class="g2stg now" role="listitem" aria-current="step"><span class="c"><\/span><b>Construir<\/b><small>1 de 3<\/small>/);
  assert.match(h, /class="g2stg done" role="listitem"><span class="c"><svg[^]*?<\/svg><\/span><b>Planejar<\/b>/);
  assert.match(t, /Etapa 0 · esqueleto/);
  assert.match(t, /Etapa 1/);
  assert.doesNotMatch(t, /Onda|na main|mergeando/, 'vocabulário: etapa / integrada / integrando');
  assert.match(t, /1 de 3 tarefas prontas e integradas/);
  assert.match(t, /US\$ 3,46 de US\$ 10,00/);
  assert.match(t, /tentativa 2\/2 · 1 reprovada/);
  assert.match(text(ctx.pilotoProgHtml(Object.assign(ST(), { tasks: [{ id: 'x', title: 'X', wave: 1, stage: 'pending', attempts: 0, reasons: [], history: [] }] }))), /ainda não começou/);
  assert.match(t, /requisito não provado \(blocked\): barra sobe/);
  assert.match(t, /sem simulador/);
  assert.match(h, /Dormir &lt;b>/);
  assert.match(h, /data-pil-act="stop"/);
  assert.doesNotMatch(h, /data-pil-act="resume"/);
  assert.match(h, /<li class="bad">(<time>[^<]*<\/time>)?<span>✕ provas/);
  assert.match(h, /data-pil-task="alimentar"/);
  assert.match(h, /data-pil-act="more"/, 'relatório, projeto e pasta no ⋯');
});

test('progresso: parado/teto mostram o motivo e "Continuar" com o teto novo; concluído não continua', () => {
  const { ctx } = load();
  const b = Object.assign(ST(), { phase: 'budget', alive: false, stopReason: 'teto de custo atingido', hasReport: true });
  const h = ctx.pilotoProgHtml(b);
  assert.match(text(h), /Parou no teto/);
  assert.match(text(h), /teto de custo atingido/);
  assert.match(h, /data-pil-act="resume"/);
  assert.match(h, /data-pil-act="more"/);
  assert.doesNotMatch(h, /data-pil-act="stop"/);
  const d = ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'done', alive: false, hasReport: true }));
  assert.doesNotMatch(d, /data-pil-act="resume"/);
  assert.equal(ctx.pilotoEnded(Object.assign(ST(), { phase: 'done', alive: false })), true);
  assert.equal(ctx.pilotoEnded(ST()), false);
  assert.match(ctx.pilotoProgHtml(null), /Nenhum piloto aberto/);
  assert.match(ctx.pilotoProgHtml(null), /data-pil-act="fabrica"/, 'sem piloto: leva à Fábrica (nunca aba vazia)');
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
  assert.ok(!L.calls.some((c) => c[0] === 'autopilot_start'), 'sem teto não dispara (teto obrigatório)');
  assert.match(L.el('pilBody').innerHTML, /role="alert">Defina um teto/);
  L.el('pilBudget').value = '25';
  await L.run('pilStart()');
  await tick();
  const start = L.calls.find((c) => c[0] === 'autopilot_start');
  assert.equal(start[1].idea, 'recriar o jogo Pou');
  assert.equal(start[1].platform, 'web');
  assert.equal(start[1].budgetUsd, 25);
  assert.equal(JSON.stringify(L.calls.find((c) => c[0] === 'switch')), JSON.stringify(['switch', '/docs/Starfork/pou']));
  assert.equal(JSON.stringify(L.tabs), JSON.stringify(['pilotorun']));
  assert.equal(L.store['piloto:dir'] ?? L.ctx.localStorage.getItem('piloto:dir'), '/docs/Starfork/pou');
  const F = load({ invoke: () => Promise.reject(new Error('o piloto não começou — saída do motor: x')) });
  F.ctx.openPiloto();
  F.el('pilIdea').value = 'um app de lista de compras'; F.el('pilPar').value = '2'; F.el('pilAtt').value = '2'; F.el('pilBudget').value = '10';
  await F.run('pilStart()');
  await tick();
  assert.match(F.el('pilBody').innerHTML, /role="alert"/);
  assert.equal(F.tabs.length, 0);
});

test('aba de progresso lê o autopilot_status da pasta lembrada e as ações chamam o Rust', async () => {
  // o projeto aberto (/r) não tem piloto → cai no lembrado
  const L = load({ invoke: (cmd, a) => (cmd === 'autopilot_status' ? (a.dir === '/r' ? Promise.reject(new Error('nenhum piloto automático nesta pasta')) : Promise.resolve(ST())) : Promise.resolve(null)) });
  L.ctx.localStorage.setItem('piloto:dir', '/p');
  await L.ctx.openPilotoRun();
  await tick();
  assert.equal(JSON.stringify(L.calls.filter((c) => c[0] === 'autopilot_status').map((c) => c[1].dir)), JSON.stringify(['/r', '/p']));
  assert.match(L.el('pilRunBody').innerHTML, /Alimentar o bicho/);
  await L.run("pilAct('stop')");
  assert.ok(L.calls.some((c) => c[0] === 'autopilot_stop' && c[1].dir === '/p'));
  await L.run("pilAct('resume')");
  assert.ok(L.calls.some((c) => c[0] === 'autopilot_resume' && c[1].dir === '/p'));
});

test('registrada no padrão: aba (não modal), fim de caminho da Fábrica (saiu da Nova demanda), overlays, script, CSS e comandos do Rust', () => {
  const abas = read('js/15-config-abas-onboarding.js');
  assert.match(abas, /piloto:\{title:'Piloto automático'/);
  assert.match(abas, /pilotorun:\{title:'Progresso do piloto'/);
  assert.match(abas, /piloto:'pilotoOverlay', pilotorun:'pilotoRunOverlay'/);
  assert.match(abas, /piloto:\(\)=>window\.openPiloto&&window\.openPiloto\(\)/);
  assert.match(abas, /pilotorun:\(\)=>window\.openPilotoRun&&window\.openPilotoRun\(\)/);
  assert.match(abas, /MULTI_KINDS=new Set\(\[[^\]]*'piloto'/);
  // F4 (D9): o piloto não é mais porta — "Já sei o que quero" (Fábrica › App novo) e a ideia levam ao fim de caminho
  assert.doesNotMatch(read('js/14-nova-demanda-inicio.js'), /tab:'piloto'/);
  assert.match(read('js/65-fabrica.js'), /pilotoOpenWith\(\{ idea:t, platform:FAB_HUB\.plat/);
  assert.match(read('js/56-piloto.js'), /VIEW_META\.piloto\.title='Construir'/);
  const html = read('index.html');
  for (const id of ['pilotoOverlay', 'pilotoRunOverlay', 'pilBody', 'pilRunBody']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<script src="js\/56-piloto\.js"><\/script>/);
  assert.match(html, /css\/90-piloto\.css/);
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  for (const c of ['autopilot_start', 'autopilot_status', 'autopilot_stop', 'autopilot_resume', 'autopilot_open_report']) assert.match(lib, new RegExp(`autopilot::${c},`));
});

test('aba de progresso: o piloto do PROJETO ABERTO vem antes do último lembrado', async () => {
  const L = load({ repo: '/atual', invoke: (cmd, a) => (cmd === 'autopilot_status' ? Promise.resolve(Object.assign(ST(), { dir: a.dir, epicTitle: 'de ' + a.dir })) : Promise.resolve(null)) });
  L.ctx.localStorage.setItem('piloto:dir', '/velho');
  await L.ctx.openPilotoRun();
  await tick();
  assert.ok(L.calls.filter((c) => c[0] === 'autopilot_status').every((c) => c[1].dir === '/atual'));
  assert.match(L.el('pilRunBody').innerHTML, /g2dir mono">\/atual</);
});

test('parado/falhou: verde só até onde chegou; a etapa em que parou fica marcada (não tudo verde)', () => {
  const { ctx } = load();
  const st = (h, label) => (h.match(new RegExp(`class="g2stg (\\w+)"[^>]*><span class="c">(?:<svg[^]*?</svg>)?</span><b>${label}</b>`)) || [])[1];
  const h = ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'stopped', lastPhase: 'building', alive: false }));
  assert.equal(st(h, 'Criar o projeto'), 'done');
  assert.equal(st(h, 'Planejar'), 'done');
  assert.equal(st(h, 'Construir'), 'stop');
  assert.match(h, /<b>Construir<\/b><small>parado aqui<\/small>/);
  assert.equal(st(h, 'Verificação final'), 'next');
  assert.equal(st(h, 'Relatório'), 'next');
  const f = ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'failed', lastPhase: 'planning', alive: false, stopReason: 'a IA não devolveu um plano' }));
  assert.equal(st(f, 'Criar o projeto'), 'done');
  assert.equal(st(f, 'Planejar'), 'fail');
  assert.equal(st(f, 'Construir'), 'next');
  const d = ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'done', lastPhase: 'report', alive: false }));
  assert.equal((d.match(/class="g2stg done"/g) || []).length, 5);
  assert.doesNotMatch(d, /g2stg (stop|fail)/);
});

test('teto: Continuar pede um teto novo (maior que o gasto; 0 não é mais "sem teto") e manda budgetUsd no autopilot_resume', async () => {
  const B = () => Object.assign(ST(), { phase: 'budget', alive: false, budgetUsd: 3, costUsd: 3.2, stopReason: 'teto de custo atingido' });
  const { ctx } = load();
  const h = ctx.pilotoProgHtml(B());
  assert.match(h, /id="pilNewBudget"/);
  assert.match(text(h), /maior que o já gasto · obrigatório/);
  // parado por VOCÊ também oferece o teto (já vem com o atual, se ainda sobra)
  assert.match(ctx.pilotoProgHtml(Object.assign(B(), { phase: 'stopped', costUsd: 2 })), /id="pilNewBudget" type="text" inputmode="decimal" value="3"/);
  assert.match(ctx.pilotoProgHtml(Object.assign(B(), { phase: 'stopped' })), /id="pilNewBudget" type="text" inputmode="decimal" value=""/, 'teto já gasto: campo vazio, pede um maior');
  assert.match(ctx.pilotoResumeArgs(B(), '').err, /novo teto/);
  assert.match(ctx.pilotoResumeArgs(B(), '3').err, /maior que o já gasto/);
  assert.match(ctx.pilotoResumeArgs(B(), '0').err, /maior que 0/);
  assert.equal(ctx.pilotoResumeArgs(B(), '5,5').args.budgetUsd, 5.5);
  assert.equal(JSON.stringify(ctx.pilotoResumeArgs(Object.assign(B(), { phase: 'stopped', costUsd: 2 }), '').args), '{}', 'parado com teto sobrando: mantém');
  assert.match(ctx.pilotoResumeArgs(Object.assign(B(), { phase: 'stopped' }), '').err, /já foi gasto/, 'parado com o teto gasto: exige um maior');
  const L = load({ repo: '/p', invoke: (cmd) => (cmd === 'autopilot_status' ? Promise.resolve(B()) : Promise.resolve(null)) });
  await L.ctx.openPilotoRun(); await tick();
  L.el('pilNewBudget').value = '2';
  await L.run("pilAct('resume')");
  assert.ok(!L.calls.some((c) => c[0] === 'autopilot_resume'), 'teto menor que o gasto não dispara');
  assert.match(L.el('pilRunBody').innerHTML, /maior que o já gasto/);
  L.el('pilNewBudget').value = '10';
  await L.run("pilAct('resume')");
  const r = L.calls.find((c) => c[0] === 'autopilot_resume');
  assert.equal(JSON.stringify(r[1]), JSON.stringify({ dir: '/p', budgetUsd: 10 }));
});

test('depois de Continuar: segue lendo (botão desligado) até a rodada nova aparecer — não para no estado velho', async () => {
  let st = Object.assign(ST(), { phase: 'stopped', alive: false, runs: 1, updatedAt: 100 });
  const L = load({ repo: '/p', invoke: (cmd) => (cmd === 'autopilot_status' ? Promise.resolve(JSON.parse(JSON.stringify(st))) : Promise.resolve(null)) });
  L.el('pilotoRunOverlay').style.display = 'block';
  await L.ctx.openPilotoRun(); await tick();
  L.timers.length = 0;
  await L.run("pilAct('resume')"); await tick();
  // o estado ainda é o da rodada anterior: continua lendo (1 s) e o botão fica "Retomando…" desligado
  assert.ok(L.timers.includes(1000), JSON.stringify(L.timers));
  assert.match(L.el('pilRunBody').innerHTML, /data-pil-act="resume" disabled>Retomando…/);
  // a rodada nova apareceu: volta ao ritmo normal
  st = Object.assign(ST(), { runs: 2, updatedAt: 200, alive: true });
  L.timers.length = 0;
  await L.run('pilPoll()'); await tick();
  assert.ok(L.timers.includes(2500), JSON.stringify(L.timers));
  assert.match(L.el('pilRunBody').innerHTML, /data-pil-act="stop"/);
});

test('fim do piloto: aviso no app + notificação do sistema UMA vez por rodada (lembrado por pasta)', async () => {
  const L = load({ repo: '/p', invoke: (cmd) => (cmd === 'autopilot_status' ? Promise.resolve(Object.assign(ST(), { phase: 'done', alive: false, runs: 1 })) : Promise.resolve(null)) });
  await L.ctx.pilWatch(); await tick();
  assert.equal(L.toasts.length, 1);
  assert.match(L.toasts[0][0], /concluído: Pou/);
  assert.ok(L.calls.some((c) => c[0] === 'notif' && /concluído/.test(c[2])));
  L.run("PIL_WATCH.repo=''"); // força reler (troca de projeto)
  await L.ctx.pilWatch(); await tick();
  assert.equal(L.toasts.length, 1, 'mesma rodada não avisa de novo');
  assert.equal(L.store['piloto:fim:/p'], 'done:1');
});

test('Construir sozinho com aviso de demora (CLI vivo, ainda preparando): abre a aba e mostra o aviso, sem erro', async () => {
  const L = load({ invoke: (cmd) => (cmd === 'autopilot_start' ? Promise.resolve({ dir: '/docs/Starfork/pou', warning: 'o piloto ainda está preparando o projeto' }) : Promise.resolve(null)) });
  L.ctx.openPiloto();
  L.el('pilIdea').value = 'recriar o jogo Pou'; L.el('pilPar').value = '2'; L.el('pilAtt').value = '2'; L.el('pilBudget').value = '20';
  await L.run('pilStart()'); await tick();
  assert.equal(JSON.stringify(L.tabs), JSON.stringify(['pilotorun']));
  assert.match(L.toasts[0][0], /ainda está preparando/);
  assert.doesNotMatch(L.el('pilBody').innerHTML, /role="alert"/);
  assert.match(L.ctx.pilotoFormHtml({}, false, ''), /Teto de custo \(US\$\) <small>— obrigatório/);
});

// ---------------- revisão F4: dinheiro, retomada sem beco, ids por aba ----------------
test('parseUsd (o parser ÚNICO de dinheiro): "2.5" = "2,5"; milhar BR; arredonda ANTES de validar', () => {
  const { ctx } = load();
  for (const [x, v] of [['2.5', 2.5], ['2,5', 2.5], ['1.000', 1000], ['1.234,50', 1234.5], ['US$ 40', 40], ['40,00', 40]]) assert.equal(ctx.parseUsd(x), v, x);
  assert.equal(ctx.parseUsd(''), null);
  assert.ok(Number.isNaN(ctx.parseUsd('abc')));
  assert.match(ctx.pilotoCapCheck('0,004', 0).err, /maior que 0/, '0,004 arredonda pra 0 → recusa (antes passava e virava teto 0)');
  assert.match(ctx.pilotoCapCheck('1,204', 1.2).err, /maior que o já gasto/, '1,204 vira 1,20 = o gasto → recusa');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.pilotoCapCheck('2.5', 0))), { ok: true, cap: 2.5 });
  assert.match(read('js/65-fabrica.js'), /const cap=parseUsd\(FAB_HUB\.cap/, 'a Mesa usa o mesmo parser (2.5 não vira 25)');
});

test('retomada sem beco: processo morreu no meio, falhou com o teto gasto — sempre há caixa de teto e Continuar', () => {
  const { ctx } = load();
  for (const phase of ['building', 'planning', 'final']) {
    const h = ctx.pilotoProgHtml(Object.assign(ST(), { phase, alive: false }));
    assert.match(h, /id="pilNewBudget"/, phase); assert.match(h, /data-pil-act="resume"/, phase);
    assert.match(text(h), /O processo do piloto parou no meio/, phase);
  }
  const f = ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'failed', alive: false, costUsd: 10, budgetUsd: 10 }));
  assert.match(f, /id="pilNewBudget"/); assert.match(text(f), /o teto já foi gasto/);
  assert.match(ctx.pilotoResumeArgs(Object.assign(ST(), { phase: 'failed', costUsd: 10, budgetUsd: 10 }), '').err, /já foi gasto/);
  assert.equal(ctx.pilotoResumeArgs(Object.assign(ST(), { phase: 'failed', costUsd: 10, budgetUsd: 10 }), '15').args.budgetUsd, 15);
  assert.equal(JSON.stringify(ctx.pilotoResumeArgs(Object.assign(ST(), { phase: 'building', costUsd: 3, budgetUsd: 10 }), '').args), '{}');
  assert.doesNotMatch(ctx.pilotoProgHtml(Object.assign(ST(), { phase: 'done', alive: false })), /pilNewBudget/);
  assert.doesNotMatch(ctx.pilotoProgHtml(ST()), /pilNewBudget/, 'rodando: sem caixa');
});

test('o mesmo formulário em duas abas NÃO repete id: Construir usa "pil", a Ideia › Projeto usa "ipil"', () => {
  const { ctx } = load();
  const ids = (h) => [...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const a = ids(ctx.pilotoEndHtml({ f: { idea: 'recriar o Pou' } })), b = ids(ctx.pilotoEndHtml({ idp: 'ipil', f: {}, ideaEditable: false }));
  assert.ok(a.length > 8 && b.length > 8);
  assert.deepEqual(a.filter((x) => b.includes(x)), [], 'nenhum id em comum');
  assert.ok(b.every((x) => x.startsWith('ipil')), b.join(' '));
  assert.ok(!/['"#]pil[A-Z]/.test(read('js/59-ideia.js').replace(/data-pil-\w+/g, '')), 'a Ideia não procura ids da aba Construir');
});
