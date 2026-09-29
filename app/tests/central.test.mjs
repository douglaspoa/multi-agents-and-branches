// R7 (central): lógica pura da Central, das abas e do Kanban sem browser — cada função é recortada do arquivo
// real pelo nome (chaves balanceadas) e montada com new Function, com os globais que ela usa passados à mão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
// recorta um bloco { … } a partir de `i` contando chaves; ignora chaves dentro de strings, template e comentários
// (// e /* */) — um apóstrofo num comentário não desalinha mais a contagem
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
  throw new Error('chaves desbalanceadas a partir de ' + start);
}
// recorta `function nome(...){ ... }` (ou `async function`)
function fn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src); assert.ok(m, 'função não encontrada: ' + name);
  return block(src, m.index);
}
const quadro = read('22-quadro-fluxo.js');
const abas = read('15-config-abas-onboarding.js');
const kanban = read('23-kanban-artefatos-editor.js');

test('taskTs lê createdAt (snapshot local) e created_at (outro projeto/nuvem), em ms', () => {
  const taskTs = new Function(fn(quadro, 'taskTs') + '\nreturn taskTs;')();
  assert.equal(taskTs({ createdAt: 1790637188921 }), 1790637188921);
  assert.equal(taskTs({ created_at: 1790637188921 }), 1790637188921);
  assert.equal(taskTs({ created_at: '2026-09-28T10:00:00Z' }), Date.parse('2026-09-28T10:00:00Z'));
  assert.equal(taskTs({ createdAt: 1790637188 }), 1790637188000, 'segundos viram ms');
  assert.equal(taskTs({}), 0);
  assert.equal(taskTs({ createdAt: 0, created_at: 1790637188921 }), 1790637188921, 'createdAt 0/vazio cai no created_at');
  assert.equal(taskTs({ createdAt: '', created_at: '2026-09-28T10:00:00Z' }), Date.parse('2026-09-28T10:00:00Z'));
  assert.equal(taskTs(null), 0);
});

test('inPeriod: "últimos 7 dias" não esconde mais as tarefas do projeto aberto (createdAt)', () => {
  const mk = (period) => new Function('taskTs', 'let flowPeriod=' + JSON.stringify(period) + ';\n' + fn(quadro, 'inPeriod') + '\nreturn inPeriod;')(
    new Function(fn(quadro, 'taskTs') + '\nreturn taskTs;')());
  const now = Date.now();
  const week = mk('week'), today = mk('today'), all = mk('all');
  assert.equal(week({ createdAt: now - 2 * 864e5 }), true, 'tarefa local de 2 dias atrás entra');
  assert.equal(week({ createdAt: now - 9 * 864e5 }), false);
  assert.equal(week({ created_at: now - 864e5 }), true, 'agregada (created_at) continua entrando');
  assert.equal(today({ createdAt: now }), true);
  assert.equal(all({}), true);
});

test('tabMove: reordena abas, a Central fixa fica sempre na frente', () => {
  const mk = () => new Function('let TABS=[{id:"flow",pin:true},{id:"a"},{id:"b"},{id:"c"}];\n' + fn(abas, 'tabDropAfter') + fn(abas, 'tabMove') + '\nreturn { tabMove, ids:()=>TABS.map(t=>t.id) };')();
  let T = mk(); assert.equal(T.tabMove('a', 'c'), true); assert.deepEqual(T.ids(), ['flow', 'b', 'c', 'a'], 'pra direita: entra depois do alvo');
  T = mk(); assert.equal(T.tabMove('c', 'a'), true); assert.deepEqual(T.ids(), ['flow', 'c', 'a', 'b'], 'pra esquerda: entra no lugar do alvo');
  T = mk(); assert.equal(T.tabMove('b', 'flow'), true); assert.deepEqual(T.ids(), ['flow', 'b', 'a', 'c'], 'soltar na Central = primeira depois dela');
  T = mk(); assert.equal(T.tabMove('flow', 'c'), false, 'a fixa não se move'); assert.deepEqual(T.ids(), ['flow', 'a', 'b', 'c']);
  T = mk(); assert.equal(T.tabMove('a', 'a'), false); assert.equal(T.tabMove('x', 'a'), false);
});

test('tabStepId: próxima/anterior aba dá a volta', () => {
  const S = new Function('let TABS=[{id:"flow"},{id:"a"},{id:"b"}]; let activeTab="b";\n' + fn(abas, 'tabStepId') + '\nreturn { tabStepId, set:(v)=>{ activeTab=v; } };')();
  assert.equal(S.tabStepId(1), 'flow');
  assert.equal(S.tabStepId(-1), 'a');
  S.set('flow'); assert.equal(S.tabStepId(-1), 'b');
});

// o ouvinte de atalhos (15): roda o handler de verdade com stubs
function shortcutEnv(guardOk) {
  const log = []; let handler = null;
  const env = {
    document: { addEventListener: (ev, f) => { if (ev === 'keydown') handler = f; } },
    TABS: [{ id: 'flow', pin: true }, { id: 'a' }, { id: 'task:1', kind: 'task' }],
    activeTab: 'a',
    tabLeaveGuard: async (id) => { log.push(['guard', id]); return guardOk; },
    activateTab: (id) => log.push(['activate', id]),
    tabById: () => null, closeTab: () => {}, openTab: () => {}, setRailCollapsed: () => {}, railIsCol: () => false, fwLeaveEditor: async () => true,
  };
  const i = abas.indexOf("document.addEventListener('keydown', async e=>{", abas.indexOf('const SHORTCUTS_HELP'));
  assert.ok(i > 0, 'ouvinte de atalhos não encontrado');
  const code = block(abas, i) + ');';
  new Function(...Object.keys(env), fn(abas, 'tabStepId') + '\n' + code)(...Object.values(env));
  const press = (o) => handler(Object.assign({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {} }, o));
  return { press, log };
}

test('⌘1…⌘9 passa pela guarda de edição não salva: guarda nega → não troca; aceita → troca', async () => {
  let r = shortcutEnv(false); await r.press({ key: '3' });
  assert.deepEqual(r.log, [['guard', 'task:1']]);
  r = shortcutEnv(true); await r.press({ key: '9' });
  assert.deepEqual(r.log, [['guard', 'task:1'], ['activate', 'task:1']]);
  r = shortcutEnv(true); await r.press({ key: '2' }); // já é a ativa: nada
  assert.deepEqual(r.log, []);
});

test('⌘⇧] / ⌘⇧[ seguem a tecla produzida (e.key), não a posição física', async () => {
  let r = shortcutEnv(true); await r.press({ key: '}', code: 'Backslash', shiftKey: true });
  assert.deepEqual(r.log.at(-1), ['activate', 'task:1']);
  r = shortcutEnv(true); await r.press({ key: '{', code: 'BracketRight', shiftKey: true });
  assert.deepEqual(r.log.at(-1), ['activate', 'flow']);
  r = shortcutEnv(true); await r.press({ key: 'Tab', metaKey: false, ctrlKey: true, shiftKey: true });
  assert.deepEqual(r.log.at(-1), ['activate', 'flow']);
});

test('tabMove: com UMA aba livre, soltar na Central não passa pra frente da fixa', () => {
  const T = new Function('let TABS=[{id:"flow",pin:true},{id:"a"}];\n' + fn(abas, 'tabDropAfter') + fn(abas, 'tabMove') + '\nreturn { tabMove, tabDropAfter, ids:()=>TABS.map(t=>t.id) };')();
  assert.equal(T.tabDropAfter('a', 'flow'), true, 'marcador mostra "depois" sobre a fixa');
  T.tabMove('a', 'flow'); assert.deepEqual(T.ids(), ['flow', 'a']);
});

test('flowEmptyHtml: em Concluídas o chip de status salvo não conta como filtro; busca + filtro oferece "limpar tudo"', () => {
  const mk = (vars) => new Function('emptyHtml', Object.entries(Object.assign({ flowQuery: '', flowStatus: 'all', flowType: 'all', flowPeriod: 'all', flowAgent: 'all', flowEpic: 'all', projFilter: 'all', flowScope: 'exec' }, vars)).map(([k, v]) => 'let ' + k + '=' + JSON.stringify(v) + ';').join('') + fn(quadro, 'flowEmptyHtml') + '\nreturn flowEmptyHtml();')((o) => JSON.stringify(o));
  assert.match(mk({ flowScope: 'done', flowStatus: 'aguardando' }), /Nada concluído ainda/);
  assert.match(mk({ flowScope: 'exec', flowStatus: 'aguardando' }), /flowClearFilters/);
  assert.match(mk({ flowQuery: 'pix', flowType: 'fix' }), /flowClearAll/);
  assert.match(mk({ flowQuery: 'pix' }), /flowClearSearch/);
});

test('flowJump (barra de status / "+N na Central"): zera busca e os outros filtros salvos', () => {
  const ls = {}; const log = [];
  const J = new Function('$id', 'lsSet', 'flowSetF', 'window', 'curView', 'setView', 'render',
    'let flowQuery="pix", flowScope="done", flowStatus="rascunho", flowPeriod="week", flowAgent="Orion", flowType="fix", flowEpic="ep1", projFilter="/b", lastSig="x";\n'
    + fn(quadro, 'flowJump') + '\nreturn { flowJump, st:()=>({flowQuery,flowScope,flowStatus,flowPeriod,flowAgent,flowType,flowEpic,projFilter}) };')(
    () => null, (k, v) => { ls[k] = v; }, (k, v) => { ls[k] = v; }, { openTab: (k) => log.push(k) }, () => 'kanban', (v) => log.push('view:' + v), () => {});
  J.flowJump({ status: 'prontas', proj: 'all' });
  assert.deepEqual(J.st(), { flowQuery: '', flowScope: 'exec', flowStatus: 'prontas', flowPeriod: 'all', flowAgent: 'all', flowType: 'all', flowEpic: 'all', projFilter: 'all' });
  assert.equal(ls.flowType, 'all'); assert.equal(ls.flowStatus, 'prontas');
  assert.deepEqual(log, ['flow', 'view:flow']);
});

// Kanban: soltar numa coluna
function kanbanEnv({ task, askAnswer = true, invokeFails = false }) {
  const log = [];
  const env = {
    state: { repo: '/a', tasks: task ? [task] : [] },
    projShort: (p) => String(p).split('/').pop(),
    kanbanCol: (t) => (t.status === 'draft' ? 'rascunho' : t.status === 'review' ? 'prontas' : 'andamento'),
    renderKanban: () => log.push('render'),
    toast: (m, k) => log.push(['toast', k, m]),
    startTask: (id) => log.push(['start', id]),
    ACTIVE_ST: new Set(['running', 'thinking', 'queued']),
    pendingOf: () => [],
    askYes: async (m) => { log.push(['ask', m]); return askAnswer; },
    invoke: async (c, a) => { log.push(['invoke', c, a]); if (invokeFails) throw new Error('db travado'); },
    refresh: async () => log.push('refresh'),
    showErr: (e, ctx) => log.push(['err', ctx]),
  };
  const f = new Function(...Object.keys(env), 'let lastSig="x";\n' + fn(kanban, 'kanbanDrop') + '\nreturn kanbanDrop;')(...Object.values(env));
  return { f, log };
}

test('kanbanDrop: coluna não suportada volta o cartão E explica o que dá pra fazer', async () => {
  const { f, log } = kanbanEnv({ task: { id: 't1', title: 'X', status: 'running' } });
  await f('t1', 'praberto');
  assert.ok(log.includes('render'));
  assert.ok(log.some((x) => x[0] === 'toast' && /Em andamento|Concluídas/.test(x[2])), 'mostra um aviso');
  assert.ok(!log.some((x) => x[0] === 'invoke'), 'não grava nada');
});

test('kanbanDrop: concluir tarefa rodando pergunta antes; "não" não grava', async () => {
  const { f, log } = kanbanEnv({ task: { id: 't1', title: 'Checkout', status: 'running' }, askAnswer: false });
  await f('t1', 'concluidas');
  assert.ok(log.some((x) => x[0] === 'ask'));
  assert.ok(!log.some((x) => x[0] === 'invoke'));
});

test('kanbanDrop: concluir parada não pergunta; erro vira showErr (antes era engolido)', async () => {
  let r = kanbanEnv({ task: { id: 't1', title: 'Y', status: 'review' } });
  await r.f('t1', 'concluidas');
  assert.ok(!r.log.some((x) => x[0] === 'ask'));
  assert.ok(r.log.some((x) => x[0] === 'invoke' && x[1] === 'set_task_flag' && x[2].flag === 'closed'));
  r = kanbanEnv({ task: { id: 't1', title: 'Y', status: 'review' }, invokeFails: true });
  await r.f('t1', 'concluidas');
  assert.ok(r.log.some((x) => x[0] === 'err'), 'erro aparece pro usuário');
});

test('kanbanDrop: rascunho em "Em andamento" inicia; cartão de outro projeto avisa', async () => {
  let r = kanbanEnv({ task: { id: 'd1', title: 'Z', status: 'draft' } });
  await r.f('d1', 'andamento');
  assert.ok(r.log.some((x) => x[0] === 'start' && x[1] === 'd1'));
  r = kanbanEnv({ task: null });
  await r.f('zz', 'concluidas');
  assert.ok(r.log.some((x) => x[0] === 'toast' && /outro projeto/.test(x[2])));
});

test('kanbanDrop: rascunho de OUTRO projeto em "Em andamento" não inicia (avisa)', async () => {
  const r = kanbanEnv({ task: { id: 'd2', title: 'W', status: 'draft', repo: '/b' } });
  await r.f('d2', 'andamento');
  assert.ok(!r.log.some((x) => x[0] === 'start'));
  assert.ok(r.log.some((x) => x[0] === 'toast' && /outro projeto/.test(x[2])));
});

test('kanbanDrop: pausada / plano pra aprovar também pedem confirmação ao concluir', async () => {
  for (const status of ['paused', 'plan-review', 'error']) {
    const r = kanbanEnv({ task: { id: 't', title: 'P', status }, askAnswer: false });
    await r.f('t', 'concluidas');
    assert.ok(r.log.some((x) => x[0] === 'ask'), status);
  }
});
