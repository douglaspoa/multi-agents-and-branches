// R8 (planner · formulário · dividir): lógica pura recortada dos arquivos reais pelo nome e montada com new Function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
function block(src, start) {
  let i = src.indexOf('{', start), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) break; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('chaves desbalanceadas');
}
function fn(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, 'função não encontrada: ' + name);
  return block(src, m.index);
}
const planner = read('32-planner.js'), form = read('31-nova-demanda-form.js'), orqSrc = read('34-orquestrador.js');

const plBusyInfo = new Function('const PL_SLOW_MS=90000;\n' + fn(planner, 'plBusyInfo') + '\nreturn plBusyInfo;')();
test('planner: progresso ao vivo mostra tempo, ações e o que está fazendo', () => {
  const a = plBusyInfo(12000, 3, 'lendo src/pontos/index.ts');
  assert.equal(a.tempo, '12s');
  assert.match(a.head, /pensando · 12s · 3 ações/);
  assert.match(a.hint, /^lendo src\/pontos\/index\.ts · 12s/);
  assert.equal(a.slow, false);
  assert.match(plBusyInfo(1000, 1, '').head, /1 ação$/);
  assert.match(plBusyInfo(0, 0, '').hint, /^pensando · 0s/);
});
test('planner: passou de 90 s avisa que dá pra parar sem perder nada', () => {
  const s = plBusyInfo(95000, 0, 'x');
  assert.equal(s.slow, true);
  assert.equal(s.tempo, '1min 35s');
  assert.match(s.hint, /demorando mais que o normal/);
});

// plTakeBack: devolve a última mensagem sua (e os anexos) pra caixa
test('planner: erro/parar devolve a mensagem e os anexos pra caixa', () => {
  const inp = { value: '', dispatchEvent() {} };
  const env = { plMsgs: [{ who: 'bot', text: 'oi' }, { who: 'you', text: 'quero X' }], plPend: [{ path: 'b' }] };
  const take = new Function('env', '$id', 'Event', 'let plMsgs=env.plMsgs, plPend=env.plPend;\n' + fn(planner, 'plTakeBack') + '\nreturn (t,a)=>{ const r=plTakeBack(t,a); env.plPend=plPend; return r; };')(env, () => inp, function () {});
  assert.equal(take('quero X', [{ path: 'a' }]), true);
  assert.equal(env.plMsgs.length, 1);
  assert.equal(inp.value, 'quero X');
  assert.deepEqual(env.plPend.map((x) => x.path), ['a', 'b']);
  assert.equal(take('outra', []), false, 'última não é sua com esse texto → não mexe');
});

test('formulário: o que falta em linguagem de gente', () => {
  const ntMissingText = new Function(fn(form, 'ntMissingText') + '\nreturn ntMissingText;')();
  assert.equal(ntMissingText(['título', 'objetivo']), 'falta: título, objetivo');
  assert.equal(ntMissingText([]), 'pronto pra começar');
  assert.doesNotMatch(ntMissingText(['x']), /obrigat|spec/);
});

test('dividir: tempo do plano e aviso de demora', () => {
  const orqBusyTx = new Function(fn(orqSrc, 'orqBusyTx') + '\nreturn orqBusyTx;')();
  assert.match(orqBusyTx(41000), /^há 41s · costuma levar/);
  assert.match(orqBusyTx(130000), /^há 2min 10s · está demorando/);
});
test('dividir: erro do orquestrador nunca mostra o JSON cru', () => {
  const orqPlanErr = new Function('humanErr', 'const ORQ_PLAN_SECS=300;\n' + fn(orqSrc, 'orqPlanErr') + '\nreturn orqPlanErr;')((raw, ctx) => ({ msg: ctx + ': ' + String(raw).split('\n')[0] }));
  assert.equal(orqPlanErr('ORQ_PLAN_STOPPED').stopped, true);
  const bad = orqPlanErr(new Error('ORQ_BAD_PLAN'));
  assert.equal(bad.stopped, false);
  assert.doesNotMatch(bad.msg, /[{}]/);
  assert.match(orqPlanErr('comando expirou após 300s').msg, /demorou demais \(mais de 5 min\)/);
  assert.match(orqPlanErr('falha ao rodar claude: x\n{"a":1}').msg, /^Não deu pra montar o plano: falha ao rodar claude: x$/);
});

test('dividir: o prazo do front é o mesmo do Rust', () => {
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const r = rs.match(/const ORQ_PLAN_SECS: u64 = (\d+);/), j = orqSrc.match(/const ORQ_PLAN_SECS=(\d+);/);
  assert.ok(r && j); assert.equal(r[1], j[1]);
  assert.match(rs, /output_stoppable_keyed\(cmd, ORQ_PLAN_SECS/);
});

// ---------- o planner de verdade num vm (00-util + 14 + 15 + 29 + 32) com DOM de mentira ----------
import vm from 'node:vm';
const noop = () => {};
const stubEl = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'dataset' ? {} : k === 'value' ? '' : k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : stubEl()),
  set: () => true, apply: () => stubEl(),
});
function loadPlanner() {
  const store = {};
  const ctx = {
    window: { addEventListener: noop },
    document: { getElementById: () => stubEl(), addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null, createElement: () => stubEl(), head: stubEl(), body: stubEl() },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' }, console,
    esc: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;'), chatComposer: noop, Option: function () {},
    loadDaily: noop, dailyAISummary: noop, dailyGenDoc: noop, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    state: { repo: '/r' }, Event: function (t) { this.type = t; },
  };
  ctx.escA = (x) => ctx.esc(x).replace(/"/g, '&quot;');
  vm.createContext(ctx);
  vm.runInContext([read('00-util.js'), read('14-nova-demanda-inicio.js'), read('15-config-abas-onboarding.js'), read('29-ia-picker.js'), read('32-planner.js')].join('\n;\n'), ctx);
  // o que o teste controla: caixa de texto, IA, toasts; render/salvar viram no-op
  vm.runInContext(`var __inp={ value:'', ev:0, dispatchEvent(){ this.ev++; }, closest:()=>null };
    var __toasts=[]; var __ai=null;
    $id=(id)=>id==='plInput'?__inp:null;
    toast=(m,k,a)=>{ __toasts.push({m,k,a}); };
    renderPlanner=()=>{}; plAutoSave=()=>{}; plActsPaint=()=>{}; chatPinBottom=()=>{}; plRenderRefs=()=>{};
    attPromptBlock=()=>''; aiClaudeModel=()=>''; aiCallResumeSafe=()=>__ai;
    invoke=async()=>null;`, ctx);
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
// promessa controlável pra "a IA ainda está pensando"
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

test('planner: parar na mesma aba devolve a mensagem pra caixa', async () => {
  const c = loadPlanner(); run(c, "plReset(); TABS.push({id:'t1',kind:'planner'}); activeTab='t1';");
  const d = deferred(); c.__ai = d.p;
  const sent = run(c, "plSend('quero pontos')");
  assert.equal(run(c, 'plBusy'), true);
  run(c, 'plStopping=true'); d.rej(new Error('PLANNER_STOPPED')); await sent;
  assert.equal(run(c, '__inp.value'), 'quero pontos');
  assert.equal(run(c, "plMsgs.filter(m=>m.who==='you').length"), 0);
  assert.match(run(c, 'plMsgs[plMsgs.length-1].text'), /voltou pra caixa/);
  assert.equal(run(c, 'plBusy'), false);
});
test('planner: parar/erro com a resposta caindo NOUTRA aba mantém a mensagem na conversa', async () => {
  for (const kind of ['stop', 'err']) {
    const c = loadPlanner(); run(c, "plReset(); TABS.push({id:'t1',kind:'planner'},{id:'t2',kind:'planner'}); activeTab='t1';");
    const d = deferred(); c.__ai = d.p;
    const sent = run(c, "plSend('quero pontos')");
    // troca pra aba t2 (conversa nova), guardando o estado da t1 como o openTab faz
    run(c, "tabById('t1').state=window.TAB_STATE_planner.get(); plReset(); activeTab='t2';");
    if (kind === 'stop') { run(c, 'plStopping=true'); d.rej(new Error('PLANNER_STOPPED')); } else d.rej(new Error('algo quebrou'));
    await sent;
    const t1 = run(c, "tabById('t1').state");
    assert.equal(t1.plMsgs.filter((m) => m.who === 'you').length, 1, kind + ': a mensagem continua na conversa da t1');
    assert.match(t1.plMsgs[t1.plMsgs.length - 1].text, /ficou (na conversa|salva)/);
    assert.equal(run(c, 'plMsgs.length'), 0, kind + ': nada caiu na conversa da t2');
    assert.equal(run(c, '__inp.value'), '', kind + ': a caixa da t2 não recebe o texto');
  }
});
test('planner: erro conhecido mantém o botão do catálogo no aviso', async () => {
  const c = loadPlanner(); run(c, "plReset(); TABS.push({id:'t1',kind:'planner'}); activeTab='t1';");
  c.__ai = Promise.reject(new Error('Invalid API key · Please run /login'));
  await run(c, "plSend('oi')");
  const t = run(c, '__toasts');
  assert.equal(t.length, 1); assert.equal(t[0].k, 'err'); assert.equal(t[0].a.label, 'abrir Ambiente'); assert.equal(typeof t[0].a.fn, 'function');
  assert.match(run(c, 'plMsgs[plMsgs.length-1].text'), /voltou pra caixa/);
});
test('planner: "+ novo" com a IA respondendo — a resposta velha é descartada', async () => {
  const c = loadPlanner(); run(c, "plReset(); TABS.push({id:'t1',kind:'planner'}); activeTab='t1';");
  const d = deferred(); c.__ai = d.p;
  const sent = run(c, "plSend('conversa velha')");
  run(c, 'plStopping=true; plReset();'); // plNew: para e zera
  assert.equal(run(c, 'plStopping'), false); assert.equal(run(c, 'plBusy'), false);
  d.res({ text: '```json\n{"say":"resposta velha"}\n```', sessionId: 's' }); await sent;
  assert.equal(run(c, 'plMsgs.length'), 0, 'nem "Parado." nem a resposta velha entram na conversa nova');
});
test('planner: trocar de aba no meio da resposta mantém Aprovar/criar travados', () => {
  const c = loadPlanner(); run(c, "plReset(); plCurGen=7; plInflight.add(7); plBusy=true;");
  const st = run(c, 'window.TAB_STATE_planner.get()');
  run(c, 'plReset();'); run(c, 'window.TAB_STATE_planner.set(' + JSON.stringify(st) + ')');
  assert.equal(run(c, 'plBusy'), true, 'envio ainda no ar → continua ocupado');
  run(c, 'plInflight.delete(7); window.TAB_STATE_planner.set(' + JSON.stringify(st) + ')');
  assert.equal(run(c, 'plBusy'), false, 'envio já respondido → libera');
});
test('planner: plTakeBack com texto na caixa junta e faz a caixa re-crescer', () => {
  const c = loadPlanner(); run(c, "plReset(); plMsgs=[{who:'you',text:'A'}]; __inp.value='B';");
  assert.equal(run(c, "plTakeBack('A',[])"), true);
  assert.equal(run(c, '__inp.value'), 'A\n\nB');
  assert.equal(run(c, '__inp.ev'), 1);
});
test('planner: plCreateHint — épico, IA respondendo, pronto e o que falta', () => {
  const c = loadPlanner(); run(c, 'plReset();');
  assert.match(run(c, 'plCreateHint()'), /^falta: título, objetivo, o que vai ser entregue$/);
  run(c, "plFields.title='T'; plFields.objective='O'; plFields.deliverables=['d'];");
  assert.match(run(c, 'plCreateHint()'), /pode criar/);
  run(c, 'plBusy=true;'); assert.match(run(c, 'plCreateHint()'), /espere a IA/);
  run(c, "plPlan={tasks:[]};"); assert.match(run(c, 'plCreateHint()'), /Aprovar e criar/);
});
test('planner: "depois de" enxuto — começa já / marcadas / chips só ao editar', () => {
  const c = loadPlanner(); run(c, 'plReset();');
  const others = [{ idx: 1, title: 'Acúmulo' }, { idx: 2, title: 'Troca por cupom' }];
  const txt = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const h0 = run(c, 'plAfterRowHtml')({ idx: 0 }, 0, [], others, '');
  assert.match(txt(h0), /começa já mudar/); assert.doesNotMatch(h0, /data-ppafter=/);
  const h1 = run(c, 'plAfterRowHtml')({ idx: 0 }, 0, [2], others, '');
  assert.match(txt(h1), /depois de: Troca por cupom mudar/); assert.doesNotMatch(h1, /Acúmulo/);
  run(c, 'plAfterEdit.add(0)');
  const h2 = run(c, 'plAfterRowHtml')({ idx: 0 }, 0, [2], others, '');
  assert.equal((h2.match(/data-ppafter=/g) || []).length, 2); assert.match(h2, /aria-pressed="true"/);
  assert.doesNotMatch(run(c, 'plAfterRowHtml')({ idx: 0 }, 0, [], others, ' disabled'), /mudar/, 'travado: sem editar');
  run(c, 'plReset()'); assert.equal(run(c, 'plAfterEdit.size'), 0);
});
test('Conversar leva o tipo: ND_CREATE tem todo tipo que o formulário carrega; desconhecido cai; consome uma vez', () => {
  const c = loadPlanner();
  for (const k of ['build', 'fix', 'design', 'invest', 'review', 'docs']) assert.ok(run(c, 'ND_CREATE')[k], 'ND_CREATE.' + k);
  run(c, "ndCarryKind='invest'"); assert.equal(run(c, 'ndTakeCarryKind()'), 'invest'); assert.equal(run(c, 'ndTakeCarryKind()'), '');
  run(c, "ndCarryKind='xyz'"); assert.equal(run(c, 'ndTakeCarryKind()'), '');
});
test('dividir: parar com a resposta chegando depois — o plano NÃO aparece', async () => {
  const body = fn(orqSrc, 'orqPlanNow');
  const o = { briefing: 'O carrinho fica lento com muitos itens', atts: [], model: '' };
  let resolveAi; const env = { orq: o };
  const run2 = new Function('env', 'invoke', 'orqRender', 'orqNewId', 'orqPlanReqs', 'orqPlanErr', 'orqNormPhases', 'aiDefaults', 'aiClaudeModel', 'attPromptBlock', 'setInterval', 'clearInterval', '$id', 'state',
    'let orq=env.orq, orqListAt=0;\n' + body + '\nreturn orqPlanNow;')(env,
    async (cmd) => cmd === 'ai_orchestrate' ? new Promise((r) => { resolveAi = r; }) : null, () => {}, () => 'orq-x', new Set(),
    (e) => ({ msg: /STOPPED/.test(String(e && e.message || e)) ? 'Parado.' : 'erro', stopped: /STOPPED/.test(String(e && e.message || e)) }),
    (l) => l, () => ({ eng: 'claude', model: '' }), () => '', () => '', () => 0, () => {}, () => null, { repo: '/r' });
  const p = run2();
  assert.equal(o.busy, true);
  o.planStopping = true; // tocou ■ parar, mas o processo já tinha respondido
  resolveAi('```json\n{"title":"T","phases":[{"key":"n1","name":"F"}]}\n```'); await p;
  assert.equal(o.plan, undefined); assert.equal(o.msg, 'Parado.'); assert.equal(o.msgErr, false);
  assert.equal(o.busy, false); assert.equal(o.planStopping, false);
});
