// ATRAPALHA do fluxo de trabalho — PARTE 1: criação e organização (mesa-bugs-2, trabalho/RELATORIO.md + LEITURA-CODIGO.md).
// Chips/épico sem corte calado, ⌘W pergunta antes de perder Conversar/Formulário, wizard guarda a etapa, duplo clique,
// pedido que demora, anexos, modelo por agente, erros em pt-BR, GH_FAIL sem pasta duplicada, issue sem duplicar,
// troca de projeto que falha, contagens com UMA régua. `node --test app/tests/atrap-trabalho.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const planner = read('js/32-planner.js'), form = read('js/31-nova-demanda-form.js'), abas = read('js/15-config-abas-onboarding.js'),
  anexos = read('js/30-anexos.js'), util = read('js/00-util.js'), proj = read('js/13-skills-projetos.js'), iss = read('js/14-issues-projeto.js'),
  fluxo = read('js/22-quadro-fluxo.js'), grafo = read('js/25-grafo.js'), tabela = read('js/66-central-tabela.js'), casca = read('js/68-casca-g1.js'),
  switcher = read('js/33-switcher-projetos.js'), memoria = read('js/37-memoria.js'), core = read('js/10-core.js'), epico = read('js/46-epico-time.js'),
  comecar = read('js/36-comecar.js'), ideia = read('js/59-ideia.js'), piloto = read('js/56-piloto.js');

// ---------------------------------------------------------------- A1 · A2 · A3: chips e épico
test('A2 · 10 chips sem lista numerada = 10 chips (antes cortava em 8 calado)', () => {
  const plChipsFull = new Function(cut(planner, 'function plChipsFull', 'let plAfterEdit') + '\nreturn plChipsFull;')();
  assert.equal(plChipsFull('Qual?', Array.from({ length: 10 }, (_, i) => 'opção ' + i)).length, 10);
});

test('A1 · a caixa de chips tem teto e rola; janela baixa solta o rodapé do resumo', () => {
  const css = read('css/50-workspace-planner.css');
  assert.match(css, /#plChips\{[^}]*max-height:[^;}]+;[^}]*overflow-y:auto/);
  assert.match(read('css/98-fabrica.css'), /@media \(max-height:700px\)\{ \.plmesh \.plmeshfoot\{position:static\} \}/);
});

function planFrom() {
  const src = cut(planner, 'const plStrs=', '\n// rascunho/aba restaurados');
  return new Function('plFields', src + '\nreturn plPlanFrom;')({ title: 'Épico' });
}
test('A3 · épico com 10 etapas mostra as 10 (e as dependências da 9ª/10ª); acima de 20, o card avisa', () => {
  const plPlanFrom = planFrom();
  const tasks = Array.from({ length: 10 }, (_, i) => ({ title: 'Etapa ' + (i + 1), after: i ? [i - 1] : [] }));
  const p = plPlanFrom({ tasks });
  assert.equal(p.tasks.length, 10); assert.equal(p.cut, 0);
  assert.deepEqual(p.tasks.find((t) => t.title === 'Etapa 10').after, [8], 'a 10ª depende da 9ª');
  const big = plPlanFrom({ tasks: Array.from({ length: 23 }, (_, i) => ({ title: 'T' + i })) });
  assert.equal(big.tasks.length, 20); assert.equal(big.cut, 3);
  assert.match(cut(planner, 'function plPlanCardHtml', '\n}\n'), /PLP\(\)\.cut\?`<div class="ppwarn">A IA propôs/);
});

// ---------------------------------------------------------------- A4: ⌘W / X pergunta antes de perder trabalho
const ndw = new Function(cut(form, '// @puro-ndwork-inicio', '// @puro-ndwork-fim') + '\nreturn ndTabLoses;')();
test('A4 · ndTabLoses: 2ª conversa (sem rascunho) com mensagem pergunta; a dona do rascunho não; formulário preenchido pergunta', () => {
  assert.equal(ndw('planner', { plOwnsDraft: false, plMsgs: [{ who: 'you', text: 'oi' }] }), 'a conversa desta aba');
  assert.equal(ndw('planner', { plOwnsDraft: true, plMsgs: [{ who: 'you', text: 'oi' }] }), '', 'a dona tem rascunho em disco');
  assert.equal(ndw('planner', { plOwnsDraft: false, plMsgs: [{ who: 'bot', text: 'oi' }] }), '', 'sem fala sua não há o que perder');
  assert.equal(ndw('planner', { plOwnsDraft: false, plMsgs: [], plPlan: { tasks: [] } }), 'a conversa desta aba', 'épico proposto conta');
  assert.equal(ndw('form', { fields: { ntTitle: { v: '' }, ntObj: { v: '  ' } }, ntReq: [''] }), '');
  assert.equal(ndw('form', { fields: { ntFixObj: { v: 'quebra no login' } } }), 'o que você preencheu no formulário');
  assert.equal(ndw('form', { fields: {}, ntReq: ['o botão aparece'] }), 'o que você preencheu no formulário');
  assert.equal(ndw('form', { fields: {}, ntRefs: ['/x/print.png'] }), 'o que você preencheu no formulário');
  assert.equal(ndw('task', { fields: { ntTitle: { v: 'x' } } }), '');
});
test('A4 · ⌘W e o X passam pela MESMA guarda (tabLeaveGuard → ndTabCloseOk com askYes)', () => {
  assert.match(cut(abas, 'async function tabLeaveGuard', '\n}\n'), /if\(closing && typeof ndTabCloseOk==='function' && !await ndTabCloseOk\(tabById\(targetId\)\)\) return false;/);
  const w = cut(abas, "else if(k==='w' && !e.shiftKey)", "else if(/^[1-9]$/");
  assert.match(w, /if\(t\.kind!=='task' && typeof tabLeaveGuard==='function' && !await tabLeaveGuard\(t\.id, true\)\) return;/);
  assert.match(cut(form, 'async function ndTabCloseOk', '\n}\n'), /await askYes\(/);
  assert.ok(!/window\.confirm/.test(cut(form, 'async function ndTabCloseOk', '\n}\n')));
});

// ---------------------------------------------------------------- A5: wizard guarda a etapa por aba
test('A5 · trocar de aba não volta o wizard pra etapa 1 (wizN no estado da aba; ntShow preserva)', () => {
  const st = cut(form, 'window.TAB_STATE_form={', '\n};');
  assert.match(st, /return \{ _title:ti, fields, ntMode, wizN,/);
  assert.match(st, /wizN=\+st\.wizN\|\|1;/);
  let wizN = 3, modeCalls = 0;
  const ntShow = new Function('g', 'let ntMode="build"; const $id=()=>({style:{}}); function setNtMode(){ g.calls++; g.wizN=1; }' +
    cut(form, 'function ntShow(){', '\n').replace(/wizN/g, 'g.wizN') + '\nreturn ntShow;');
  const g = { wizN: 3, calls: 0 }; ntShow(g)(); assert.equal(g.calls, 1); assert.equal(g.wizN, 3, 'continua na etapa 3');
  void wizN; void modeCalls;
});
test('wizard: duplo clique no "Iniciar execução" não roda 2× nem deixa "voltar" ativo durante a criação', () => {
  const w = cut(form, 'let wizLaunching=false;', 'async function wizLaunchInner');
  assert.match(w, /if\(wizLaunching \|\| \(typeof ntSubmitting!=='undefined' && ntSubmitting\)\) return;/);
  assert.match(w, /\['wizNext','wizBack','wizSkip'\]\.forEach\(id=>\{ const b=\$id\(id\); if\(b\) b\.disabled=true; \}\)/);
});

// ---------------------------------------------------------------- L4 · C8: duplo clique / botão preso
test('L4 · duplo clique em "Aprovar e criar N tarefas" (neste computador) cria UM plano', async () => {
  const saves = [];
  const fn = new Function('E', `const { PLP, toast, plFields, state, invoke, window, $id }=E; let orq=E.orq;
    const plModelNow=()=>({ eng:'claude', model:'' }), plEngineNorm=e=>e, plEffKind=()=>'build', plWaves=()=>{}, plSortWaves=()=>{};
    const plPlanToOrq=()=>({ id:'orq-1', repo:'/r' }); const orqOpenPlan=async()=>{}; const orqLoadList=async()=>{}; let plPlan=null, plAfterEdit=null; const plClearDraft=async()=>{};
    ${cut(planner, 'let plApproving=false;', '\nasync function plCreateEpic')}
    return plApproveLocal;`);
  const btn = { disabled: false, innerHTML: 'Aprovar', textContent: 'Aprovar' };
  let release; const gate = new Promise((r) => { release = r; });
  const run = fn({ PLP: () => ({ tasks: [{ on: true }] }), toast() {}, plFields: {}, state: { repo: '/r' }, orq: { list: [] },
    invoke: async (c, a) => { saves.push(c); await gate; }, window: { openTab() {} }, $id: () => btn });
  const a = run(btn), b = run(btn);
  assert.equal(btn.disabled, true); assert.equal(btn.textContent, 'criando…');
  release(); await Promise.all([a, b]);
  assert.deepEqual(saves, ['orch_save'], 'um plano só');
});
test('C8 · "criando…" não fica preso se trfApply lança; editar o resumo não religa o botão durante a criação', () => {
  const inner = cut(planner, 'async function plCreateInner(){', '\n}\n');
  assert.ok(inner.indexOf('try{ if(window.trfApply)') > 0, 'trfApply dentro do try (o catch devolve o botão)');
  assert.match(cut(planner, 'let plCreating=false;', 'async function plCreateInner'), /if\(!plReady\(\) \|\| plBusy \|\| plCreating\) return;/);
  assert.match(cut(planner, 'function renderPlannerMeterOnly', '\n}\n'), /c\.disabled=!plReady\(\)\|\|plBusy\|\|plCreating;/);
});

// ---------------------------------------------------------------- L8: pedido que demora não some
test('L8 · Conversar que demora: o pedido vai pra caixa (ou fica num aviso com "tentar de novo") — nunca some calado', () => {
  const src = cut(planner, 'const PL_START_TRIES=', 'window.plStartWith=plStartWith;');
  const mk = (inp) => { const toasts = []; const f = new Function('E', `const { $id, toast }=E; function plStartWith(){ E.retried=true; } ${src} return plStartGiveUp;`);
    const E = { $id: () => inp, toast: (m, k, a) => toasts.push([m, k, a]) }; return { f: f(E), toasts, E }; };
  const inp = { value: '', dispatchEvent() {} };
  const A = mk(inp); assert.equal(A.f('troque o botão', { style: { display: 'flex' } }, { id: 'planner:1', kind: 'planner' }, 'planner:1'), 'caixa');
  assert.equal(inp.value, 'troque o botão'); assert.match(A.toasts[0][0], /ficou na caixa/);
  const B = mk(null); assert.equal(B.f('troque o botão', null, null), 'aviso');
  assert.equal(B.toasts[0][2].label, 'tentar de novo'); B.toasts[0][2].fn(); assert.equal(B.E.retried, true);
  assert.match(cut(planner, 'function plStartWith(', '\n}\n'), /if\(text\) plStartGiveUp\(text, o, t, tid\)/);
  assert.match(src, /PL_START_TRIES=300/);
});

// ---------------------------------------------------------------- L6: anexos
test('L6 · anexo repetido não entra 2×, arquivo > 25 MB é barrado antes do base64, erro visível', () => {
  const A = new Function(cut(anexos, '// @puro-anexos-inicio', '// @puro-anexos-fim') + '\nreturn { attKey, attFileKey, attFileVer, attNewFiles, attTooBig, ATT_MAX_BYTES };')();
  const f1 = { name: 'print.png', size: 1000, lastModified: 5 }, f2 = { name: 'spec.md', size: 20, lastModified: 6 };
  const have = [{ name: 'print-2.png', rel: '.cardume/refs/print-2.png', src: A.attFileKey(f1), srcVer: A.attFileVer(f1) }];
  assert.deepEqual(A.attNewFiles(have, [f1, f2, f2]).map((f) => f.name), ['spec.md'], 'o mesmo arquivo (e o repetido no mesmo lote) não entra de novo');
  assert.equal(A.attTooBig({ size: A.ATT_MAX_BYTES + 1 }), true); assert.equal(A.attTooBig({ size: 5 }), false);
  const imp = cut(anexos, 'async function attImportFiles', '\n}\n');
  assert.ok(imp.indexOf('attTooBig(f)') < imp.indexOf('attFileToB64(f)'), 'checa o tamanho ANTES de ler o arquivo');
  assert.match(cut(anexos, 'async function attPick', '\n}\n'), /showErr\(e, 'Não consegui abrir o seletor de arquivos'\)/);
  assert.match(cut(anexos, 'async function pickRefsInto', '\n'), /showErr\(e, 'Não consegui anexar'\)/);
  assert.match(anexos, /function attBusy\(n\)\{[^\n]*importando/);
});

// ---------------------------------------------------------------- L7: modelo por agente
test('L7 · "Modelo por agente" segue a IA escolhida; a correção leva o ntModels', () => {
  const AI_ENGINES = [{ id: 'codex', models: [{ id: '', name: 'Padrão do Codex' }, { id: 'gpt-6-astra', name: 'GPT-6-Astra' }] }, { id: 'gateway', models: [] }];
  const aiEngineOf = (e) => String(e || '').startsWith('codex') ? 'codex' : String(e).startsWith('gateway') ? 'gateway' : 'claude';
  const opts = new Function('AI_ENGINES', 'aiEngineOf', cut(form, '// @puro-agmodel-inicio', '// @puro-agmodel-fim') + '\nreturn ntAgentModelOpts;')(AI_ENGINES, aiEngineOf);
  assert.deepEqual(opts('claude').map((x) => x[0]), ['opus', 'sonnet', 'haiku']);
  assert.deepEqual(opts('codex'), [['gpt-6-astra', 'GPT-6-Astra']], 'Codex = modelos do Codex (sem o "padrão", que é o "modelo geral")');
  assert.deepEqual(opts('gateway'), [], 'motor sem lista = sem a escolha por agente');
  assert.match(cut(planner, "if(ntMode==='fix'){", "if(ntMode==='design'){"), /models:ntModels\|\|null/);
});

// ---------------------------------------------------------------- A10 · L9: erros e pasta duplicada
test('A10 · novo projeto: erro em pt-BR (pasta que já existe), nunca "Falhou: Error: Os { code: 17 …"', () => {
  const m = new Function('humanErr', cut(proj, '// @puro-projerr-inicio', '// @puro-projerr-fim') + '\nreturn projNewErrMsg;')((e, c) => ({ msg: c + ': ' + e }));
  assert.match(m('Error: Os { code: 17, kind: AlreadyExists, message: "File exists" } create_dir_all(/x/a)'), /^Já existe uma pasta com esse nome/);
  assert.match(m('já existe uma pasta app em /x (e ela não é um projeto git)'), /^Já existe uma pasta/);
  assert.ok(!/'Falhou: '\+m/.test(proj)); assert.match(proj, /else projNewMsg=projNewErrMsg\(m\);/);
});
test('L9 · GH_FAIL vira frase e o retry REAPROVEITA a pasta (sem "nome-2"); sem GitHub abre a pasta que ficou', async () => {
  const calls = [];
  const H = new Function('invoke', cut(util, '// L9 (mesa-bugs-2):', '// @helpers-comuns-fim') + '\nreturn { ghFailOf, ghFailText, projCreateQuick };')(async (c, a) => { calls.push([c, a]); return c === 'quick_project_target' ? '/U/Docs/Starfork/app-2' : '/U/Docs/Starfork/app'; });
  const g = H.ghFailOf(new Error('GH_FAIL::/U/Docs/Starfork/app::A pasta e o git foram criados.\n\nMotivo: HTTP 401: Bad credentials\n\nConfira'));
  assert.deepEqual(g.path, '/U/Docs/Starfork/app');
  const txt = H.ghFailText(g); assert.ok(!/GH_FAIL/.test(txt)); assert.match(txt, /mesma pasta é reaproveitada/); assert.match(txt, /Bad credentials/);
  assert.equal(H.ghFailOf(new Error('outra coisa')), null);
  await H.projCreateQuick('app', true, g.path);
  assert.deepEqual(calls.pop(), ['create_project', { parent: '/U/Docs/Starfork', name: 'app', github: true, private: true, owner: '' }]);
  assert.ok(!calls.some((c) => c[0] === 'quick_project_target'), 'retry não pede nome novo');
  await H.projCreateQuick('app', false, g.path); assert.deepEqual(calls.pop(), ['open_project', { path: '/U/Docs/Starfork/app' }]);
  for (const src of [ideia, piloto]) { assert.match(src, /projCreateQuick\(slug, !!/); assert.match(src, /ghFailOf\(e\)/); }
  assert.match(cut(comecar, 'async function emStart', '\n}\n'), /try\{ await refresh\(\); if\(typeof loadProjects==='function'\) await loadProjects\(\); \}catch\(e2\)/);
});

// ---------------------------------------------------------------- Issues: A7 · L10 · erros
test('A7 · conector com JSON quebrado: não diz "✓ conexão salva", não salva e o texto fica na caixa', () => {
  const save = cut(iss, "on('trkConnSave'", '\n  });');
  assert.match(save, /if\(!trkKeepForm\(\)\)\{ issRender\(\); return; \}/);
  assert.match(save, /try\{ cloud=await trkSave\(\); \}catch\(e\)/);
  assert.match(cut(iss, "const b=body.querySelector('#trkRulesSave')", '\n  };'), /try\{ cloud=await trkSave\(\); \}catch\(e\)/);
  const keep = cut(iss, 'function trkKeepForm(){', '\n}\n');
  assert.match(keep, /trkJsonBad=v\('trkJson'\)/); assert.match(keep, /return ok;$/);
  assert.match(iss, /esc\(trkJsonBad!=null\?trkJsonBad:JSON\.stringify\(c,null,2\)\)/);
});
test('L10 · retry da criação reaproveita a issue já criada (30 min); erro HTTP do painel em pt-BR', () => {
  const T = new Function(cut(iss, '// @puro-trkmade-inicio', '// @puro-trkmade-fim') + cut(iss, '// @puro-trkhttp-inicio', '// @puro-trkhttp-fim') + '\nreturn { trkMadeKey, trkMadeGet, trkMadeSet, trkHttpMsg, TRK_MADE_MS };')();
  const p = { title: 'Botão some', objective: 'no celular', requirements: ['aparece', ' '] };
  const k = T.trkMadeKey(p, '/r'); assert.equal(k, T.trkMadeKey({ ...p, requirements: ['aparece'] }, '/r'));
  T.trkMadeSet(k, { code: 'FND-1', url: 'u' }, 1000);
  assert.equal(T.trkMadeGet(k, 2000).code, 'FND-1');
  assert.equal(T.trkMadeGet(k, 1000 + T.TRK_MADE_MS + 1), null, 'expira');
  assert.match(cut(iss, 'async function trkBeforeNewTask', '\n}\n'), /const key=trkMadeKey\(payload, [^\n]*prev=trkMadeGet\(key, 0, code=>trkTasksFor\(code\)\.length>0\);/);
  assert.match(T.trkHttpMsg(401), /recusou o acesso \(HTTP 401\) — confira a chave/);
  assert.match(T.trkHttpMsg(503), /problema agora/);
  assert.ok(!/throw new Error\('HTTP '\+r\.status/.test(iss), 'o corpo cru da resposta não vai pra tela');
});
test('Issues · a busca mantém o cursor onde estava', () => {
  assert.match(iss, /const c0=qi\.selectionStart, c1=qi\.selectionEnd;[^\n]*n\.setSelectionRange\(c0, c1\)/);
});

// ---------------------------------------------------------------- L14 · L13: projeto certo
test('L14 · switchProject que falha SOBE o erro (e mostra) — quem chamou não abre o projeto anterior', async () => {
  const shown = [];
  const sw = new Function('E', `const { invoke, openProjMenu }=E; let projErr=''; const errText=e=>String(e);
    ${cut(switcher, 'async function switchProject(path){', '\nasync function pickFolder')} return switchProject;`)({ invoke: async () => { throw 'sem workspace do Starfork em /x'; }, openProjMenu: () => shown.push('menu') });
  await assert.rejects(sw('/x'), (e) => e.shown === true && /sem workspace/.test(e.message));
  assert.deepEqual(shown, ['menu'], 'o erro aparece (openProjMenu → showErr)');
  assert.match(proj, /\[data-pjpage\][^\n]*try\{ await window\.switchProject\(p\); \}catch\(_\)\{ return; \}/);
  assert.match(grafo, /\[data-projpage\][^\n]*try\{ await window\.switchProject\(p\); \}catch\(_\)\{ return; \}/);
});
test('L13 · "Iniciar" de rascunho de outro projeto passa pelo crossRun (troca pro dono antes)', () => {
  assert.match(tabela, /crossRun\(id, \(\)=>startTask\(id\)\)/);
  assert.match(fluxo, /\[data-rowplay\][^\n]*crossRun\(id, \(\)=>startTask\(id\)\)/);
  assert.match(cut(fluxo, 'async function crossRun', '\n}\n'), /try\{ await window\.switchProject\(t\.repo\); \}catch\(_\)\{ return; \}/);
});

// ---------------------------------------------------------------- L11 · C1 · C2: contagens
test('L11 · UMA régua de "viva" (lateral = Projetos = página Projeto), sem depender do botão Bloqueadas', () => {
  const taskEncerrada = new Function(cut(util, 'function taskEncerrada(t)', '\n') + '\nreturn taskEncerrada;')();
  const live = new Function('taskEncerrada', cut(fluxo, '// @proj-vivas-inicio', '// @proj-vivas-fim') + '\nreturn projLiveTasks;')(taskEncerrada);
  const ts = [{ id: 'a', status: 'running' }, { id: 'b', status: 'draft' }, { id: 'c', status: 'review', flag: 'blocked' }, { id: 'd', status: 'merged' }, { id: 'e', status: 'review', flag: 'closed' }, { id: 'f', status: 'paused' }];
  assert.deepEqual(live(ts).map((t) => t.id), ['a', 'b', 'f']);
  assert.match(grafo, /tasks:projLiveTasks\(projTasksOf\(p\.path\)\)/, 'outros projetos = list_all_tasks (a lista da Central)');
  assert.match(cut(proj, 'function projCountsOf', '\n}\n'), /projLiveTasks\(mine\)/);
  assert.match(cut(casca, 'function projCounts()', '\n'), /projLiveTasks\(\(state\.tasks\|\|\[\]\)\)/);
});
test('C1 · C2 · chips contam com busca/tipo/épico; a aba é "Em aberto"; "restaurar ordem" some na tabela; aguardando inclui interrompida', () => {
  assert.match(fluxo, /const byPeriod=srcAll\.filter\(t=>flowScopeOk\(t\)&&flowOtherFiltersOk\(t\)\);/);
  assert.match(cut(fluxo, 'function flowVisible', '\n}\n'), /flowOtherFiltersOk\(t\)/);
  assert.match(fluxo, /\['exec','Em aberto',nExec\]/);
  assert.match(fluxo, /const manualOn=flowScope!=='done' && flowViewEff\(\)!=='table'/);
  assert.match(tabela, /const CT_NEEDS_ST=new Set\(typeof AGUARDA_ST!=='undefined'\?AGUARDA_ST:/);
  assert.match(util, /const AGUARDA_ST=\[[^\]]*'aborted'/);
});

// ---------------------------------------------------------------- A6 · Projeto · C4 · C9 · L16
test('A6 · nota nova da Memória não some ao trocar de seção (o editor é guardado antes do esqueleto)', () => {
  const o = cut(memoria, 'async function openMemoria(){', '\n}\n');
  assert.ok(o.indexOf('memCaptureEdit()') > 0 && o.indexOf('memCaptureEdit()') < o.indexOf('loadInto('));
});
test('Projeto · números não congelam com Conversa/Agentes/Skills abertos (o atalho do overlay grande também pinta a página)', () => {
  assert.match(cut(core, 'if(bigOverlay){', 'return;\n  }'), /g1TabOn\('projeto'\) && typeof projPageRender==='function'\) safe\(projPageRender\)/);
});
test('C4 · correção linkada sem jargão; C9 · "Resumo do dia" (é um dia do projeto aberto); L16 · nada de "clone"', () => {
  const f = cut(form, 'async function openLinkedFix', '\n}\n');
  assert.ok(!/LINKADA|\(id '|branch '\+/.test(f));
  assert.match(fluxo, /data-cdsub="res"[^>]*>Resumo do dia</);
  assert.ok(!/clone a pasta/.test(epico)); assert.match(epico, /Abrir pasta que já tenho/);
});

// ================================================================ revisão adversarial (commit 5cd1649) — COMPORTAMENTO
const fluxFn = (names, globals) => new Function('G', `with(G){ ${names.map((n) => cut(fluxo, n, '\n}\n') + '\n}').join('\n')} return { ${names.map((n) => n.match(/function (\w+)/)[1]).join(',')} }; }`);
test('rev 1 · o select de Tipo conta cada tipo SEM o próprio filtro de tipo (escolher "Correção" não some com os outros)', () => {
  const G = { flowEpic: 'all', flowType: 'fix', flowAgent: 'all', flowQuery: '', inPeriod: () => true, taskType: (t) => t.ty, taskAgents: () => [] };
  const { flowOtherFiltersOk } = fluxFn(['function flowOtherFiltersOk('], G)(G);
  const ts = [{ ty: 'fix', title: 'a' }, { ty: 'build', title: 'b' }, { ty: 'build', title: 'c' }];
  assert.equal(ts.filter((t) => flowOtherFiltersOk(t)).length, 1, 'a lista continua filtrada por tipo');
  const noType = ts.filter((t) => flowOtherFiltersOk(t, 'type'));
  assert.equal(noType.filter((t) => t.ty === 'build').length, 2, 'o select ainda mostra "Feature (2)"');
  assert.match(fluxo, /const tyCount=k=>byNoType\.filter\(t=>taskType\(t\)===k\)\.length;/);
});
test('rev 2 · concluir (flag) ou abrir PR em outro projeto atualiza o cache (assinatura muda)', async () => {
  let resp = [{ id: 'x', status: 'review', sortOrder: null }];
  const G = { allTasksAt: 0, allTasksSig: '', allTasksCache: [], allTasksOk: false, lastSig: 'L', curView: () => 'flow', invoke: async () => resp, Date };
  const { loadAllTasks } = fluxFn(['async function loadAllTasks('], G)(G);
  await loadAllTasks(true); assert.equal(G.allTasksCache[0].flag, undefined);
  resp = [{ id: 'x', status: 'review', sortOrder: null, flag: 'closed' }]; await loadAllTasks(true);
  assert.equal(G.allTasksCache[0].flag, 'closed', 'encerrar muda a assinatura');
  resp = [{ id: 'x', status: 'review', sortOrder: null, flag: 'closed', prUrl: 'https://gh/pr/1' }]; await loadAllTasks(true);
  assert.equal(G.allTasksCache[0].prUrl, 'https://gh/pr/1', 'PR aberto muda a assinatura');
});
test('rev 3 · cabeçalho da Central e barra de status contam pela régua única (bloqueada fora mesmo com o botão ligado)', () => {
  const taskEncerrada = new Function(cut(util, 'function taskEncerrada(t)', '\n') + '\nreturn taskEncerrada;')();
  const live = new Function('taskEncerrada', cut(fluxo, '// @proj-vivas-inicio', '// @proj-vivas-fim') + '\nreturn projLiveTasks;')(taskEncerrada);
  let got = null; const el = {};
  const G = { $id: () => el, flowShowBlocked: true, flowScope: 'exec', projLiveTasks: live, boardSource: () => [{ status: 'running' }, { status: 'review', flag: 'blocked' }],
    flowCounts: (ts) => ({ n: ts.length }), centralSumHtml: (fc) => 'N=' + fc.n, projList: () => [], projFilter: 'all', projShort: (x) => x, pathBase: (x) => x, state: { repo: '/r' }, pageHead: (o) => (got = o.sum) };
  fluxFn(['function renderFlowHead('], G)(G).renderFlowHead();
  assert.equal(got, 'N=1', 'a bloqueada não entra no cabeçalho');
  assert.match(read('js/26-sidebar-projetos.js'), /const live=L\(projLiveTasks\(boardSource\(\)\)\);/);
  assert.ok(!/flowLiveTasks\(\)/.test(cut(fluxo, 'function renderFlowHead', '\n}\n')));
});
test('rev 4 · rascunho aberto pra editar / correção pré-preenchida fechados SEM mexer não perguntam; mexeu, pergunta', () => {
  const W = new Function(cut(form, '// @puro-ndwork-inicio', '// @puro-ndwork-fim') + '\nreturn { ndTabLoses, ntWorkSig };')();
  const st = { fields: { ntTitle: { v: 'Rascunho antigo' }, ntObj: { v: 'obj' } }, ntReq: ['r1'], ntEditingDraft: 'd1' };
  st.ntBaseSig = W.ntWorkSig(st);
  assert.equal(W.ndTabLoses('form', st), '', 'rascunho intacto (está no banco)');
  const mexeu = { ...st, fields: { ...st.fields, ntObj: { v: 'obj editado' } } };
  assert.equal(W.ndTabLoses('form', mexeu), 'o que você preencheu no formulário');
  const fix = { fields: { ntFixTitle: { v: 'Corrigir: x' }, ntFixObj: { v: 'Correção da tarefa "x".' } }, ntFixReq: ['a', 'b'] }; fix.ntBaseSig = W.ntWorkSig(fix);
  assert.equal(W.ndTabLoses('form', fix), '', 'correção linkada só pré-preenchida');
  assert.equal(W.ndTabLoses('form', { fields: { ntTitle: { v: 'novo' } } }), 'o que você preencheu no formulário', 'formulário limpo + digitou');
  assert.match(read('js/24-perguntas-agente.js'), /ntMarkBase\(\); \/\/ o rascunho está no banco/);
  for (const f of ['async function openLinkedFix', 'async function openFromDesign']) assert.match(cut(form, f, '\n}\n'), /ntMarkBase\(\)/);
});
test('rev 5 · botão fechar/cancelar do Formulário passa pela guarda (não fecha calado)', async () => {
  const calls = [];
  const f = new Function('E', `const { tabById, tabCloseGuarded, closeNewTask }=E; let activeTab='form:1'; const window={}; ${cut(form, 'function ntUserClose()', '\n')} return ntUserClose;`);
  await f({ tabById: (id) => ({ id, kind: 'form' }), tabCloseGuarded: async (id) => { calls.push(['guard', id]); return false; }, closeNewTask: () => calls.push(['direto']) })();
  assert.deepEqual(calls, [['guard', 'form:1']], 'pergunta (guarda) e não fecha direto');
});
test('rev 6 · erro que a troca de projeto já mostrou não aparece 2×', () => {
  const toasts = [];
  const showErr = new Function('humanErr', 'toast', 'errDetails', 'console', cut(util, 'function showErr(e, ctx){', '\n}\n') + '\n}\nreturn showErr;')(
    (e) => ({ msg: String(e && e.message || e), id: 'generic', raw: '' }), (m) => toasts.push(m), () => {}, { warn() {} });
  const e = new Error('sem workspace'); e.shown = true; showErr(e, 'Não consegui abrir o projeto');
  assert.equal(toasts.length, 0); showErr(new Error('outro'), 'x'); assert.equal(toasts.length, 1);
});
test('rev 7 · pedido da tela inicial não cai noutra aba Conversar aberta durante a espera', () => {
  const sent = [], toasts = [], q = [];
  const inp = { value: '', dispatchEvent() {}, focus() {} }, ov = { style: { display: 'flex' } };
  const E = { activeTab: 'flow', plOpenSeq: 0, plOpenDone: 0, tabs: { 'planner:1': { id: 'planner:1', kind: 'planner' }, 'planner:2': { id: 'planner:2', kind: 'planner' } } };
  const f = new Function('E', `let activeTab; Object.defineProperty(globalThis,'__E',{value:E,configurable:true});
    const $id=(id)=>id==='plInput'?E.inp:E.ov; const tabById=(id)=>E.tabs[id]; const toast=(m,k,a)=>E.toasts.push(m); const plSend=(t)=>E.sent.push(t); const plMsgs=[]; const plBusy=false;
    const setTimeout=(fn)=>E.q.push(fn); const window={ openTab:()=>{ activeTab='planner:1'; E.plOpenSeq++; } };
    let plOpenSeq=0, plOpenDone=0;
    ${cut(planner, 'function plStartWith(', '\n}\n')}\n}\n${cut(planner, 'const PL_START_TRIES=', 'window.plStartWith=plStartWith;')}
    return { go:(t)=>{ plStartWith(t); activeTab='planner:2'; plOpenSeq=1; plOpenDone=1; } };`);
  Object.assign(E, { inp, ov, toasts, sent, q });
  f(E).go('pedido da Bia');
  for (let i = 0; i < 400 && q.length; i++) q.shift()();
  assert.deepEqual(sent, [], 'não enviou na aba errada'); assert.equal(inp.value, '', 'nem pôs na caixa da outra aba');
  assert.match(toasts[0], /não abriu a tempo/);
});
test('rev 8 · issue reaproveitada só pro MESMO projeto e só enquanto nenhuma tarefa nasceu com ela', () => {
  const T = new Function(cut(iss, '// @puro-trkmade-inicio', '// @puro-trkmade-fim') + '\nreturn { trkMadeKey, trkMadeGet, trkMadeSet };')();
  const p = { title: 'Botão some', objective: 'no celular', requirements: ['aparece'] };
  assert.notEqual(T.trkMadeKey(p, '/a'), T.trkMadeKey(p, '/b'), 'outro projeto = outra chave');
  const k = T.trkMadeKey(p, '/a'); T.trkMadeSet(k, { code: 'FND-9' }, 1000);
  assert.equal(T.trkMadeGet(k, 2000, () => false).code, 'FND-9', 'retry depois de falhar: reaproveita');
  assert.equal(T.trkMadeGet(k, 2000, (c) => c === 'FND-9'), null, 'a tarefa nasceu com ela: a próxima demanda igual cria outra');
  assert.equal(T.trkMadeGet(k, 2000, () => false), null, 'e a entrada foi apagada');
});
test('rev 9 · conector com JSON quebrado tem saída: "descartar edição" e "gerar de novo" zeram a edição', () => {
  const wire = cut(iss, 'function trkConnWire(body){', '\n}\n');
  assert.match(wire, /on\('trkJsonUndo', \(\)=>\{ trkJsonOpen=false; trkKeepForm\(\); trkJsonBad=null;/);
  assert.match(wire, /trk\.connector=c; trkJsonBad=null;/);
  assert.match(cut(iss, 'function trkConnHtml(){', '\n}\n'), /trkJsonBad!=null\?'<button class="btn sm" id="trkJsonUndo"/);
  // e o keep sem a caixa aberta não lê o JSON quebrado (a saída funciona)
  const keep = new Function('E', `let trk={ connector:{a:1} }, trkJsonOpen=false, trkMsg='', trkJsonBad='{ruim'; const $id=(id)=>id==='trkJson'?{value:'{ruim'}:null; const document={ querySelectorAll:()=>[] }; const trkUserVars=()=>({}); const lsSet=()=>{};
    ${cut(iss, 'function trkKeepForm(){', '\n}\n')}\n}\nreturn ()=>({ ok:trkKeepForm(), c:trk.connector });`)();
  assert.deepEqual(keep(), { ok: true, c: { a: 1 } });
});
test('rev 10 · o plano do orquestrador usa o mesmo teto do épico (não corta em 8)', () => {
  const orq = read('js/34-orquestrador.js');
  const norm = new Function('PL_PLAN_MAX', 'const ORQ_KINDS={ build:{agent:"Construtor"} };' + cut(orq, 'function orqNormPhases(', '\n}\n') + '\n}\nreturn orqNormPhases;')(20);
  assert.equal(norm(Array.from({ length: 12 }, (_, i) => ({ key: 'n' + (i + 1), name: 'E' + i }))).length, 12);
});
test('rev 11 · pasta da tentativa com GitHub recusado só é reaproveitada pro MESMO nome', () => {
  const ghRetryFor = new Function(cut(util, 'function ghRetryFor(', '\n') + '\nreturn ghRetryFor;')();
  const r = { path: '/D/Starfork/app', slug: 'app' };
  assert.equal(ghRetryFor(r, 'app'), '/D/Starfork/app'); assert.equal(ghRetryFor(r, 'app-novo'), '', 'trocou o nome: cria do zero');
  assert.equal(ghRetryFor(null, 'app'), '');
  assert.match(piloto, /PIL_FORM\.ghRetry=\{ path:g\.path, slug \}/); assert.match(ideia, /m\.ghRetry=\{ path:g\.path, slug \}/);
});
test('rev 12 · textos: vazio da aba "Em aberto" e botão "relatório do dia"', () => {
  assert.match(fluxo, /title:'Nada em aberto'/);
  assert.ok(!/relatório do período'/.test(read('js/12-chat-prefs-daily.js')));
});
test('rev 14 · anexar de novo o mesmo arquivo: igual não repete; EDITADO entra como versão nova (substitui a anterior)', async () => {
  const A = new Function(cut(anexos, '// @puro-anexos-inicio', '// @puro-anexos-fim') + '\nreturn { attVersion, attNewFiles, attFileKey, attFileVer };')();
  const old = { name: 'spec.md', src: 'f:spec.md', srcVer: '20|1' };
  assert.equal(A.attVersion([old], 'f:spec.md', '20|1'), 'dup');
  assert.equal(A.attVersion([old], 'f:spec.md', '25|2'), 0);
  assert.deepEqual(A.attNewFiles([old], [{ name: 'spec.md', size: 25, lastModified: 2 }]).length, 1, 'editado passa');
  assert.deepEqual(A.attNewFiles([old], [{ name: 'spec.md', size: 20, lastModified: 1 }]).length, 0, 'igual não passa');
  // pelo seletor (caminho): tamanho diferente = versão nova substitui
  const toasts = [], have = [{ name: 'spec.md', src: 'p:/x/spec.md', srcVer: '20' }];
  const pick = new Function('E', `const { invoke, toast, showErr, pathBase }=E; ${cut(anexos, '// @puro-anexos-inicio', '// @puro-anexos-fim')} function attBusy(){ return ()=>{}; } ${cut(anexos, 'async function attPick', '\n}\n')}\n}\nreturn attPick;`)({
    invoke: async (c) => c === 'pick_ref_files' ? ['/x/spec.md'] : { name: 'spec-2.md', size: 31 }, toast: (m) => toasts.push(m), showErr() {}, pathBase: (p) => p.split('/').pop() });
  const out = await pick(null, have);
  assert.equal(out.length, 1); assert.equal(have.length, 0, 'a versão anterior saiu'); assert.match(toasts[0], /Versão nova/);
  const have2 = [{ name: 'spec.md', src: 'p:/x/spec.md', srcVer: '31' }];
  assert.equal((await pick(null, have2)).length, 0, 'mesmo tamanho = repetido'); assert.equal(have2.length, 1);
});
test('rev · todo arquivo tocado nesta frente é JS válido (um comentário // no meio da linha quebrou o 22 uma vez)', () => {
  for (const f of ['00-util', '12-chat-prefs-daily', '13-skills-projetos', '14-issues-projeto', '22-quadro-fluxo', '24-perguntas-agente', '25-grafo', '26-sidebar-projetos', '30-anexos', '31-nova-demanda-form', '32-planner', '33-switcher-projetos', '34-orquestrador', '56-piloto', '59-ideia', '66-central-tabela', '68-casca-g1'])
    assert.doesNotThrow(() => new Function(read('js/' + f + '.js')), f);
});
