// "Iniciar épico" (um botão pro épico inteiro) + o ⋯ por linha na tabela da Central.
// Funções puras recortadas de 46-epico-time.js (@ep-iniciar-puro-*) + ganchos nos arquivos de sempre.
// `node --test app/tests/epico-iniciar.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ep = read('js/46-epico-time.js'), ct = read('js/66-central-tabela.js'), fl = read('js/22-quadro-fluxo.js'), nv = read('js/42-nuvem-sync-mobile.js');
const EP = new Function(cut(ep, '// @ep-iniciar-puro-inicio', '// @ep-iniciar-puro-fim') + '\nreturn { epStartPlan, epStartAskText, epStartDoneText, epWaveOpen, epJoinItems };')();
const epqBucket = new Function(cut(ep, 'function epqBucket(', '\nfunction epqEpicTasks(') + '\nreturn epqBucket;')();
// startTask de verdade (24), com o motor e a tela falsos
const startTaskWith = (deps) => new Function('state', 'ACTIVE_ST', 'slotMax', 'askYes', 'invoke', 'refresh', 'toast', 'showErr', 'document', 'CSS',
  'let lastSig;\n' + cut(read('js/24-perguntas-agente.js'), 'const startingTasks=new Set();', '\nasync function pauseTask(') + '\nreturn startTask;')(
  deps.state, new Set(['running']), deps.slotMax ?? 4, deps.askYes ?? (async () => true), deps.invoke, async () => {}, () => {}, () => {}, { querySelectorAll: () => [] }, { escape: (x) => x });
const CT = new Function('esc', 'escA', cut(ct, '// @ct-puro-inicio', '// @ct-puro-fim') + '\nreturn { ctTableHtml };')(esc, esc);
const CW = new Function(cut(nv, 'function ctArmed', '// @exec-inicio') + '\nreturn { ctArmed, ctWaiting };')();

// rascunho local (startable) da onda w
const D = (id, wave, o) => ({ id, wave, b: 'queue', startable: true, mine: true, armed: false, ...o });

test('épico com 3 rascunhos na onda 1 + 1 na onda 2: inicia as 3 agora e deixa a da onda 2 na espera', () => {
  const p = EP.epStartPlan([D('a', 1), D('b', 1), D('c', 1), D('d', 2)]);
  assert.equal(p.mode, 'start');
  assert.equal(p.wave, 1);
  assert.deepEqual(p.now.map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(p.wait.map((x) => x.id), ['d']);
  assert.deepEqual(p.waves, [2]);
  assert.equal(p.begun, false, 'nada começou: o botão é a ação principal');
  const q = EP.epStartAskText('Reuso da arquitetura', p, { free: 4, slotMax: 4, cost: { txt: 'US$ 3,20', n: 3, of: 4 } });
  assert.equal(q.title, 'Iniciar o épico “Reuso da arquitetura”?');
  assert.equal(q.go, 3); assert.equal(q.queued, 0);
  assert.match(q.text, /^3 tarefas começam agora \(onda 1\)\./);
  assert.match(q.text, /1 fica na espera e começa sozinha, nesta máquina, quando a onda anterior for entregue \(onda 2\)\./);
  assert.match(q.text, /Custo estimado: ~US\$ 3,20 \(previsão de 3 de 4 tarefas\)\./);
});

test('limite de agentes: o que não cabe agora espera vaga (armado) — nunca passa do limite sem perguntar', () => {
  const p = EP.epStartPlan([D('a', 1), D('b', 1), D('c', 1)]);
  const q = EP.epStartAskText('E', p, { free: 1, slotMax: 4 });
  assert.equal(q.go, 1); assert.equal(q.queued, 2);
  assert.match(q.text, /^1 tarefa começa agora \(onda 1\)\.\n2 esperam vaga: o limite é de 4 agentes ao mesmo tempo\. Começam sozinhas quando abrir\./);
  assert.equal(EP.epStartAskText('E', p, { free: -2, slotMax: 4 }).go, 0, 'acima do limite: nada começa agora');
  assert.match(EP.epStartAskText('E', p, { free: 0, slotMax: 4 }).text, /^Nenhuma tarefa começa agora\./);
  assert.ok(!/Custo/.test(q.text), 'sem previsão: não fala de custo');
});

test('onda atual = a 1ª com algo não entregue; entregue/cancelada não seguram; em revisão segura', () => {
  const p = EP.epStartPlan([D('a', 1, { b: 'rev', startable: false }), D('b', 2)]);
  assert.equal(p.wave, 1); assert.equal(p.now.length, 0); assert.deepEqual(p.wait.map((x) => x.id), ['b']);
  assert.equal(p.mode, 'start', 'ainda dá pra armar a onda 2'); assert.equal(p.begun, true);
  const p2 = EP.epStartPlan([D('a', 1, { b: 'ok', startable: false }), D('x', 1, { b: 'off' }), D('b', 2)]);
  assert.equal(p2.wave, 2); assert.deepEqual(p2.now.map((x) => x.id), ['b']);
});

test('já armado vira "pausar épico"; nada a iniciar some o botão; de outra pessoa fica de fora', () => {
  const pz = EP.epStartPlan([D('a', 1, { b: 'run', startable: false }), D('b', 2, { armed: true })]);
  assert.equal(pz.mode, 'pause'); assert.equal(pz.canPause, true);
  // tarefa nova no épico depois de armar (ou início que falhou): "Iniciar" volta, e "Pausar" continua disponível
  const mix = EP.epStartPlan([D('a', 1, { b: 'run', startable: false }), D('b', 2, { armed: true }), D('c', 2)]);
  assert.equal(mix.mode, 'start'); assert.equal(mix.canPause, true);
  assert.equal(EP.epStartPlan([D('a', 1, { b: 'run', startable: false }), D('b', 1, { b: 'ok', startable: false })]).mode, '');
  assert.equal(EP.epStartPlan([]).mode, '');
  const p = EP.epStartPlan([D('a', 1), D('z', 1, { mine: false })]);
  assert.equal(p.others, 1); assert.deepEqual(p.now.map((x) => x.id), ['a']);
  assert.match(EP.epStartAskText('E', p, { free: 4, slotMax: 4 }).text, /1 é de outra pessoa e fica de fora\./);
  assert.equal(EP.epStartPlan([D('z', 1, { mine: false })]).mode, '', 'só tarefa de outra pessoa: sem botão');
});

test('toast do fim diz o que aconteceu', () => {
  assert.deepEqual(EP.epStartDoneText({ started: 3, armed: 1, failed: 0, elsewhere: 0 }), { text: 'Épico iniciado: 3 tarefas começaram agora · 1 na espera (começa sozinha).', kind: 'ok' });
  assert.equal(EP.epStartDoneText({ started: 0, armed: 2, failed: 0, elsewhere: 0 }).text, 'Épico armado: 2 na espera (começam sozinhas).');
  assert.equal(EP.epStartDoneText({ started: 1, armed: 0, failed: 1, elsewhere: 0 }).kind, 'warn');
  assert.equal(EP.epStartDoneText({ started: 0, armed: 0, failed: 0, elsewhere: 0 }).kind, 'warn');
});

test('cartão da nuvem: armado sem `after` também começa sozinho; "na espera da onda anterior" só na onda 2+ ou com after', () => {
  const c = (spec, status = 'backlog') => ({ status, spec });
  assert.equal(CW.ctArmed(c({ autoStart: true, wave: 1 })), true);
  assert.equal(CW.ctWaiting(c({ autoStart: true, wave: 1 })), false, 'onda atual armada só espera vaga');
  assert.equal(CW.ctWaiting(c({ autoStart: true, wave: 2 })), true);
  assert.equal(CW.ctWaiting(c({ autoStart: true, after: ['x'] })), true, 'regra antiga intacta');
  assert.equal(CW.ctArmed(c({ autoStart: true }, 'running')), false);
  assert.equal(CW.ctArmed(c({ wave: 2 })), false);
  // o tick: armado sem after espera a onda anterior inteira; com after vale só o after
  assert.match(ep, /const due=t=>ctArmed\(t\) && !epStartBusy\.has\(t\.epic_id\) && !epDepsLeft\(t\)\.length && \(\(\(t\.spec\|\|\{\}\)\.after\|\|\[\]\)\.length \|\| !epWaveLeft\(t\.epic_id, epqWave\(t\)\)\);/);
  assert.match(ep, /const ready=rows\.filter\(t=>due\(t\) && ctAutoMine\(t, me\)\);/, 'só cartão no MEU nome (mesa 09/10, T5)');
  assert.match(ep, /if\(cloudEpicId\(eid\) && SB\.sess\(\) && !\(epQueue\.sibsOk&&epQueue\.sibsOk\.has\(eid\)\)\) return 1;/, 'irmãs da nuvem não lidas: espera, nunca começa antes');
  assert.match(ep, /async function epicAutoStartTick\(\)\{\n  epAutoLocalTick\(\);/, 'rascunho local armado roda mesmo sem nuvem');
});

test('o botão aparece no cabeçalho do épico na Central (fila e "em andamento") e na página; sempre por askYes e pelo caminho do "Iniciar"', () => {
  assert.match(ep, /<span style="flex:1"><\/span>\$\{epStartBtnHtml\(eid, \{ primary:true \}\)\}`\+\n\s*`<button class="btn sm ghost" data-epqopen=/, 'fila dos épicos: ao lado de "abrir"');
  assert.match(fl, /\$\{typeof epStartBtnHtml==='function'\?epStartBtnHtml\(eid, \{ primary:true \}\):''\}`\+\n\s*`<button class="btn sm ghost" data-epqopen=/, 'épicos em andamento: ao lado de "abrir"');
  assert.match(ep, /class="seclbl2 ep-taskshead"[^\n]*\$\{startBtn\?`<span class="ep-start">\$\{startBtn\}<\/span>`:''\}/, 'página do épico');
  assert.match(ep, /const pri=t=>\(!startPri && nextT&&t\.id===nextT\.id\)\?' primary':'';/, 'uma ação principal só');
  assert.match(ep, /R\.querySelectorAll\('\[data-epstart\]'\)\.forEach\(b=>b\.onclick=\(e\)=>\{ e\.stopPropagation\(\); epicStart\(b\.dataset\.epstart, b\); \}\);/);
  assert.match(ep, /\[data-epqopen\],\[data-epqt\],\[data-epstart\],\[data-eppause\]/, 'clicar no botão não recolhe o épico');
  const run = cut(ep, 'async function epicStart(', '\nasync function epicPause(');
  assert.match(run, /if\(!await askYes\(q\.text\+[^\n]*q\.title\)\) return;/);
  assert.ok(!/window\.confirm|[^.]confirm\(/.test(run), 'nunca window.confirm');
  assert.match(run, /await startTask\(x\.id\)/, 'rascunho local: o mesmo startTask do botão "Iniciar"');
  assert.match(run, /await teamClaimStart\(x\.ct, null, \{ silent:true \}\)/, 'cartão da nuvem: o mesmo teamClaimStart');
  assert.match(run, /free:slotMax-epLiveCount\(\)/, 'respeita o limite de agentes');
  assert.match(run, /epicMarkInProgress\(eid\)/, 'épico vira "em andamento"');
  assert.match(run, /const d=epStartDoneText\(res\); toast\(d\.text, d\.kind\);/);
  const pause = cut(ep, 'async function epicPause(', 'window.epicStart=');
  assert.match(pause, /epArm\(p\.armed, false, eid\)/, 'pausar só desarma a espera');
  assert.ok(!/abort|stop_task|pause_task/.test(pause), 'pausar não mata as que rodam');
});

test('⋯ por linha na tabela da Central abre o MESMO openTaskMenu, sem abrir a linha', () => {
  const R = { id: 't1', title: 'Rascunho', status: 'draft', stages: [], nreq: 0, ok: 0, ad: 0, ts: 1 };
  const h = CT.ctTableHtml([R], {});
  assert.match(h, /<td class="ct-act"><span class="ctacts"><button type="button" class="btn sm primary" data-rowplay="t1">Iniciar<\/button><button type="button" class="btn sm ghost ctmore" data-tmenu="t1" aria-haspopup="menu" aria-label="mais ações"/);
  assert.match(ct, /\[data-dcopen\],\[data-rowproof\],\[data-rowplay\],\[data-lk\],\[data-tmenu\]/, 'delegação cobre a linha recém-inserida');
  assert.match(ct, /else if\(b\.dataset\.tmenu\) openTaskMenu\(b\.dataset\.tmenu, b\);/);
  assert.ok(!/function openTaskMenu/.test(ct), 'nenhum menu novo');
  // o clique em qualquer <button> da linha nunca abre/recolhe a linha
  assert.match(ct, /if\(!tr \|\| e\.target\.closest\('button,a,input,select'\)\) return;/);
  // o menu único tem "concluir" (vai pra Concluídas) e mudar status
  const menu = cut(fl, 'function openTaskMenu(', '\nfunction menuWire(');
  assert.match(menu, /item\('concluir · sai da fila', \(\)=>invoke\('set_task_flag',\{taskId,flag:'closed'\}\)/);
  assert.match(menu, /item\('marcar pronta pra revisar'/);
  assert.match(menu, /menuWire\(pop, anchor\);/, 'teclado: foco no 1º item, setas, Esc devolve o foco');
});

test('rascunho armado aparece "na espera" na tabela e a página lista as tarefas locais do épico', () => {
  assert.match(ct, /const st=\(t\.status==='draft' && typeof epAutoLocalHas==='function' && epAutoLocalHas\(t\.id\)\)\?'waiting':taskSt\(t\)/);
  assert.match(ep, /const tasks=\(c\.tasks\|\|\[\]\)\.concat\(locOnly\);/);
  assert.match(ep, /data-eplocgo="\$\{escA\(t\._local\)\}"/);
});

test('onda anterior aberta segura a próxima; entregue, cancelada e interrompida não seguram', () => {
  const L = [{ wave: 1, b: 'rev' }, { wave: 1, b: 'ok' }, { wave: 2, b: 'queue' }];
  assert.equal(EP.epWaveOpen(L, 2), 1, 'em revisão ainda segura');
  assert.equal(EP.epWaveOpen(L, 1), 0, 'a própria onda não se segura');
  assert.equal(EP.epWaveOpen([{ wave: 1, b: 'ok' }, { wave: 1, b: 'off' }], 2), 0);
  assert.equal(EP.epWaveOpen([{ wave: 1, b: 'ok' }, { wave: 2, b: 'run' }], 3), 1, 'onda 2 rodando segura a 3');
});

test('junção nuvem × local: cada tarefa uma vez, concluída/começada não é "a iniciar", cartão de outra pessoa marcado', () => {
  const d = { c2l: { cardB: 'locB' }, armedLoc: { locC: {} }, me: 'eu', mine: (ct, me) => (ct.assignee ? ct.assignee === me : ct.created_by === me),
    bucket: epqBucket, st: (t) => (t.flag === 'closed' ? 'closed' : t.status), started: () => false, cardWave: (ct) => Math.max(1, +(ct.spec || {}).wave || 1) };
  const cloud = [
    { id: 'cardA', local_id: 'locA', status: 'running', spec: { wave: 1 } }, // ligado pelo local_id
    { id: 'cardB', status: 'review', spec: { wave: 1 } },                    // ligado pelo mapa (tmap)
    { id: 'cardD', status: 'backlog', created_by: 'eu', spec: { wave: 2, autoStart: true } },
    { id: 'cardE', status: 'backlog', assignee: 'outra', spec: { wave: 2 } },
    { id: 'cardF', status: 'backlog', created_by: 'eu', flag: 'closed', spec: { wave: 2 } },
  ];
  const locals = [
    { id: 'locA', status: 'running', epic: { wave: 1 } }, { id: 'locB', status: 'review', epic: { wave: 1 } },
    { id: 'locC', status: 'draft', epic: { wave: 1 } }, { id: 'locG', status: 'draft', flag: 'closed', epic: { wave: 1 } },
  ];
  const it = EP.epJoinItems(cloud, locals, d);
  const by = Object.fromEntries(it.map((x) => [x.id, x]));
  assert.deepEqual(it.map((x) => x.id).sort(), ['cardD', 'cardE', 'cardF', 'locA', 'locB', 'locC', 'locG'], 'cartão ligado vira a tarefa local, sem repetir');
  assert.equal(by.locA.kind, 'local'); assert.equal(by.locA.startable, false);
  assert.equal(by.locC.startable, true); assert.equal(by.locC.armed, true);
  assert.equal(by.locG.startable, false, 'rascunho concluído pelo ⋯ não volta a ser iniciado');
  assert.equal(by.cardF.startable, false, 'cartão concluído também não');
  assert.equal(by.cardD.armed, true); assert.equal(by.cardD.mine, true); assert.equal(by.cardE.mine, false);
  const p = EP.epStartPlan(it);
  assert.equal(p.wave, 1); assert.deepEqual(p.now.map((x) => x.id), ['locC']); assert.deepEqual(p.wait.map((x) => x.id), ['cardD']); assert.equal(p.others, 1);
});

test('startTask devolve se o motor aceitou (o "Iniciar épico" conta por aqui)', async () => {
  const st = { tasks: [] };
  assert.equal(await startTaskWith({ state: st, invoke: async () => null })('t1'), true);
  assert.equal(await startTaskWith({ state: st, invoke: async () => { throw new Error('já está rodando'); } })('t1'), true);
  assert.equal(await startTaskWith({ state: st, invoke: async () => { throw new Error('quebrou'); } })('t1'), false);
  const cheio = { tasks: [{ status: 'running' }, { status: 'running' }] };
  let chamou = false;
  assert.equal(await startTaskWith({ state: cheio, slotMax: 2, askYes: async () => false, invoke: async () => { chamou = true; } })('t1'), false, 'acima do limite e a pessoa disse não');
  assert.equal(chamou, false);
});

test('tick local: relê a lista antes de gravar, apaga tarefa sumida e não corre junto com o "Iniciar épico"', () => {
  const tick = cut(ep, 'async function epAutoLocalTick(){', '\n}\n');
  assert.match(tick, /const drop=id=>\{ const cur=epAutoLocalGet\(\);/);
  assert.match(tick, /const e=epAutoLocalGet\(\)\[id\]; if\(!e\) continue;/, 'pausado no meio do laço não volta');
  assert.match(tick, /if\(e\.epic && epStartBusy\.has\(e\.epic\)\) continue;/);
  assert.match(tick, /drop\(id\); \/\/ sai da lista ANTES de iniciar/);
  assert.ok(tick.indexOf('drop(id); // sai da lista ANTES') < tick.indexOf('await startTask(id)'));
});
