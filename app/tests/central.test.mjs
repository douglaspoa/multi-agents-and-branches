// R7 (central): lógica pura da Central, das abas e do Kanban sem browser — cada função é recortada do arquivo
// real pelo nome (chaves balanceadas) e montada com new Function, com os globais que ela usa passados à mão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
// recorta `function nome(...){ ... }` (ou `async function`) contando chaves — o bastante pro código do app
function fn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src); assert.ok(m, 'função não encontrada: ' + name);
  let i = src.indexOf('{', m.index), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('chaves desbalanceadas em ' + name);
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
  const mk = () => new Function('let TABS=[{id:"flow",pin:true},{id:"a"},{id:"b"},{id:"c"}];\n' + fn(abas, 'tabMove') + '\nreturn { tabMove, ids:()=>TABS.map(t=>t.id) };')();
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

test('⌘1…⌘9 passa pela guarda de edição não salva (tabLeaveGuard) antes de trocar de aba', () => {
  const line = abas.split('\n').find((l) => l.includes("/^[1-9]$/.test(k)"));
  assert.ok(line && /tabLeaveGuard\(/.test(line), 'o atalho numérico precisa chamar tabLeaveGuard');
});

// Kanban: soltar numa coluna
function kanbanEnv({ task, askAnswer = true, invokeFails = false }) {
  const log = [];
  const env = {
    state: { tasks: task ? [task] : [] },
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
