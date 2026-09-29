// Edições de spec feitas por agentes (47-edicoes-agente): `node --test app/tests/edicoes-agente.test.mjs`
// Carrega o arquivo INTEIRO num vm com stubs — os helpers puros aplicam/desfazem no épico e no cartão da nuvem
// e desenham o rastro (evento na conversa + histórico do épico).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/47-edicoes-agente.js', import.meta.url), 'utf8');
function load() {
  const ctx = {
    console, JSON, Date, Math, Set, String, Array, Object, RegExp, Number,
    IC: { pencil: '<svg class="pen"></svg>' },
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escA: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    agoTx: () => '5min',
    tickLoop: () => {}, document: { addEventListener: () => {} }, window: {},
    state: { tasks: [], events: [] },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api={ aeApplyEpic, aeUndoEpic, aeApplyCard, aeEventHtml, aeEpicHistHtml, aeEpicBadge };', ctx);
  return ctx.api;
}
const NOW = '2026-09-29T12:00:00.000Z';
const entry = (epic, extra = {}) => ({ id: 'e-1', kind: 'epic', target: 'ep1', at: NOW, by: { agent: 'Orion', taskId: 't1', taskTitle: 'Login' }, epic, note: 'SSO virou requisito', ...extra });

test('épico: aplica descrição + pronto quando + requisito, com histórico; a mesma edição não aplica 2x', () => {
  const { aeApplyEpic } = load();
  const spec = { description: 'antiga', doneWhen: [{ id: 'D1', text: 'login ok', checkedBy: 'u1' }, { id: 'D2', text: 'logout ok' }], requirements: [{ id: 'R1', text: 'x' }] };
  const r = aeApplyEpic(spec, entry({ description: 'nova', doneWhenAdd: ['SSO ok', 'login ok'], doneWhenRemove: ['D2'], reqAdd: ['SSO'] }), NOW);
  assert.equal(r.outcome, 'applied');
  assert.equal(r.spec.description, 'nova');
  assert.deepEqual(r.spec.doneWhen.map((d) => d.id + ':' + d.text), ['D1:login ok', 'D2:SSO ok'], 'D2 removido; o novo reaproveita o próximo id livre; texto repetido não entra');
  assert.deepEqual(r.spec.requirements.map((x) => x.id), ['R1', 'R2']);
  const h = r.spec.history.at(-1);
  assert.equal(h.editId, 'e-1');
  assert.equal(h.by, 'Orion');
  assert.equal(h.byTask, 'Login');
  assert.equal(h.note, 'SSO virou requisito');
  assert.equal(h.changes.find((c) => c.field === 'description').before, 'antiga');
  assert.equal(spec.description, 'antiga', 'não muta a entrada');
  assert.equal(aeApplyEpic(r.spec, entry({ description: 'outra' }), NOW).outcome, 'duplicate');
});

test('épico: item já marcado não sai; nada novo = unchanged', () => {
  const { aeApplyEpic } = load();
  const spec = { doneWhen: [{ id: 'D1', text: 'a', checkedBy: 'u' }] };
  const r = aeApplyEpic(spec, entry({ doneWhenRemove: ['D1'] }), NOW);
  assert.equal(r.outcome, 'refused');
  assert.match(r.msg, /D1 já foi marcado/);
  assert.equal(aeApplyEpic({ description: 'x' }, entry({ description: 'x' }), NOW).outcome, 'unchanged');
});

test('épico: desfazer volta como estava; recusa se mudou de novo', () => {
  const { aeApplyEpic, aeUndoEpic } = load();
  const base = { description: 'antiga', doneWhen: [{ id: 'D1', text: 'a' }, { id: 'D2', text: 'b' }] };
  const r = aeApplyEpic(base, entry({ description: 'nova', doneWhenRemove: ['D1'], doneWhenAdd: ['c'] }), NOW);
  const u = aeUndoEpic(r.spec, 'e-1', 'Douglas', NOW);
  assert.equal(u.ok, true);
  assert.equal(u.spec.description, 'antiga');
  assert.deepEqual(u.spec.doneWhen.map((d) => d.id), ['D1', 'D2']);
  assert.equal(u.spec.history.at(-1).undone.by, 'Douglas');
  assert.equal(aeUndoEpic(u.spec, 'e-1', 'x', NOW).ok, false, 'não desfaz 2x');
  const mexido = { ...r.spec, description: 'alguém mudou' };
  const u2 = aeUndoEpic(mexido, 'e-1', 'x', NOW);
  assert.equal(u2.ok, false);
  assert.match(u2.msg, /mudou de novo/);
});

test('cartão da nuvem: aplica spec+título, owns em texto, rastro; mergeado recusado; de outro épico recusado; repetido = duplicate', () => {
  const { aeApplyCard } = load();
  const card = { id: 'c1', title: 'Logout', status: 'backlog', epic_id: 'ep1', spec: { title: 'Logout', objective: 'velho', requirements: ['a', 'b'], owns: 'src/a/**' } };
  const e = { id: 'e-9', kind: 'card', target: 'c1', epicId: 'ep1', at: NOW, by: { agent: 'Orion', taskId: 't1', taskTitle: 'Login' }, task: { title: 'Logout com SSO', objective: 'novo', reqRemove: [1], reqAdd: ['c'], owns: ['src/a/**', 'src/sso/**'], note: 'SSO' } };
  const r = aeApplyCard(card, e, NOW);
  assert.equal(r.outcome, 'applied');
  assert.equal(r.title, 'Logout com SSO');
  assert.equal(r.spec.objective, 'novo');
  assert.deepEqual([...r.spec.requirements], ['b', 'c']);
  assert.equal(r.spec.owns, 'src/a/**, src/sso/**');
  assert.equal(r.spec.agentEdits[0].by, 'Orion');
  assert.equal(aeApplyCard({ ...card, spec: r.spec }, e, NOW).outcome, 'duplicate');
  assert.equal(aeApplyCard({ ...card, status: 'merged' }, e, NOW).outcome, 'refused');
  assert.equal(aeApplyCard({ ...card, epic_id: 'outro' }, e, NOW).outcome, 'refused');
  assert.equal(aeApplyCard(null, e, NOW).outcome, 'gone');
});

test('conversa: evento spec-edit mostra antes → depois + desfazer; desfeita/mergeada sem botão', () => {
  const { aeEventHtml } = load();
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const t = { id: 't2', status: 'review', spec: { agentEdits: [{ id, by: 'Orion', changes: [{ field: 'objective', before: 'velho <b>', after: 'novo' }] }] } };
  const e = { type: 'spec-edit', text: 'Orion (tarefa Login) atualizou esta tarefa: o objetivo — motivo: SSO · edição ' + id };
  const h = aeEventHtml(t, e);
  assert.match(h, /atualizado por agente/);
  assert.match(h, /Orion \(tarefa Login\) atualizou esta tarefa/);
  assert.doesNotMatch(h, /edição 0f0e/, 'o id técnico não aparece no texto');
  assert.match(h, /velho &lt;b&gt;/, 'escapa o antes');
  assert.match(h, /class="ae-a"[^>]*>novo</);
  assert.match(h, new RegExp('data-aeundo="' + id + '" data-aetask="t2"'));
  assert.doesNotMatch(h, /[\u{1F300}-\u{1FAFF}]/u, 'sem emoji');
  const undone = { ...t, spec: { agentEdits: [{ ...t.spec.agentEdits[0], undone: { at: NOW, by: 'Você' } }] } };
  assert.match(aeEventHtml(undone, e), /desfeita por Você/);
  assert.doesNotMatch(aeEventHtml({ ...t, status: 'merged' }, e), /data-aeundo/);
  // evento antigo/sem rastro no spec: só a frase
  assert.match(aeEventHtml({ id: 't3', status: 'review' }, { text: 'Orion atualizou esta tarefa' }), /Orion atualizou esta tarefa/);
});

test('página do épico: histórico com quem/por quê + desfazer (só quem pode); selo das últimas 24h', () => {
  const { aeApplyEpic, aeEpicHistHtml, aeEpicBadge } = load();
  const r = aeApplyEpic({ description: 'a' }, entry({ description: 'b', doneWhenAdd: ['novo item'] }, { at: new Date().toISOString() }), NOW);
  const h = aeEpicHistHtml(r.spec, true);
  assert.match(h, /Mudanças no épico/);
  assert.match(h, /Orion · tarefa Login/);
  assert.match(h, /motivo: SSO virou requisito/);
  assert.match(h, /\+ <span class="mono">D1<\/span> novo item/);
  assert.match(h, /data-epundo="e-1"/);
  assert.doesNotMatch(aeEpicHistHtml(r.spec, false), /data-epundo/);
  assert.equal(aeEpicHistHtml({}, true), '');
  assert.match(aeEpicBadge(r.spec), /atualizado por agente/);
  assert.equal(aeEpicBadge({ history: [{ at: '2020-01-01T00:00:00Z', by: 'x' }] }), '');
});

test('fiação: a conversa delega o evento spec-edit, o index carrega o script e o EPIC.md leva os ids', () => {
  const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
  assert.match(ws, /e\.type==='spec-edit' && typeof aeEventHtml==='function'/);
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/47-edicoes-agente.js') > html.indexOf('js/46-epico-time.js'));
  const ep = readFileSync(new URL('../src/js/46-epico-time.js', import.meta.url), 'utf8');
  assert.match(ep, /id do épico: '\+ep\.id/);
  assert.match(ep, /' · id '\+sid/);
  assert.match(ep, /aeEpicHistHtml\(sp, can\)/);
});
