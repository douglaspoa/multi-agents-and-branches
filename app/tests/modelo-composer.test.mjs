// Modelo no composer (pedido do Douglas: "mover o switch de modelo pra baixo, como nos chats de IA"):
// `node --test app/tests/modelo-composer.test.mjs`
// A pílula da IA/modelo mora embaixo da caixa de mensagem (chatModelPillHtml/chatComposer em 30-anexos.js);
// o "⋯" da tarefa não tem mais o item "modelo"; clicar na pílula abre o MESMO openModelMenu (set_task_model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const css = (f) => readFileSync(new URL('../src/css/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
// função de uma linha (`function f(){ … }`) ou de várias (fecha com `}` no começo da linha)
const fnSrc = (src, name) => {
  const one = src.match(new RegExp('\\n(async )?function ' + name + '\\([^)]*\\)\\{[^\\n]*\\}\\n'));
  if (one) return one[0];
  const m = src.match(new RegExp('(async )?function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n')); assert.ok(m, 'função não achada: ' + name); return m[0];
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escA = (s) => esc(s);

const ANEXOS = read('30-anexos.js');
const WS = read('20-workspace-tarefa.js');
const PICKER = read('29-ia-picker.js');

// composer único (30-anexos): pílula + chatComposerHtml, com $id falso pra fiação
function composerCtx(els = {}) {
  const ctx = { esc, escA, IC: { stop: '■' }, CHAT_CLIP_SVG: '<svg/>', $id: (id) => els[id] || null };
  vm.createContext(ctx);
  vm.runInContext(cut(ANEXOS, '// ---- pílula da IA/modelo no composer', '// marcação antiga (botões soltos')
    + '\nthis.chatComposerHtml=chatComposerHtml; this.chatModelPillHtml=chatModelPillHtml; this.chatModelPillWire=chatModelPillWire; this.TIP=CHAT_MODEL_TIP;', ctx);
  return ctx;
}

test('composer: com modelPill configurada, a pílula aparece embaixo da caixa, logo depois do clipe', () => {
  const C = composerCtx();
  const h = C.chatComposerHtml({ input: 'xIn', attach: 'xAtt', send: 'xSend', modelPill: { id: 'xModel', label: 'Codex · GPT-5 Codex' } });
  assert.match(h, /<button type="button" class="cc-model" id="xModel" aria-haspopup="menu" aria-expanded="false"/, 'é <button> com aria-haspopup');
  assert.match(h, /<span class="cc-model-t">Codex · GPT-5 Codex<\/span>/);
  assert.match(h, /title="trocar a IA\/modelo — vale a partir da próxima mensagem"/, 'tooltip pedido');
  const row = h.slice(h.indexOf('cc-row'));
  const iClip = row.indexOf('id="xAtt"'), iPill = row.indexOf('id="xModel"'), iSp = row.indexOf('cc-sp'), iSend = row.indexOf('id="xSend"');
  assert.ok(iClip >= 0 && iClip < iPill && iPill < iSp && iSp < iSend, 'ordem: clipe · pílula · espaço · enviar');
});

test('composer: sem modelPill não há pílula (slot opcional — as outras telas ficam iguais)', () => {
  const C = composerCtx();
  assert.doesNotMatch(C.chatComposerHtml({ input: 'a', attach: 'b', send: 'c' }), /cc-model/);
  assert.equal(C.chatModelPillHtml(null), '');
});

test('pílula que leva a outra tela (popup:"") não finge abrir menu', () => {
  const C = composerCtx();
  const h = C.chatModelPillHtml({ id: 'p', label: 'Claude · Sonnet 5', popup: '' });
  assert.doesNotMatch(h, /aria-haspopup|aria-expanded/);
  assert.match(h, /aria-label="IA: Claude · Sonnet 5/);
});

test('nome de modelo longo: reticências (cabe em janela estreita) e cara de texto secundário', () => {
  const s = css('81-chat.css');
  assert.match(s, /\.cc \.cc-model \.cc-model-t \{[^}]*text-overflow: ellipsis/);
  assert.match(s, /\.cc \.cc-model \{[^}]*max-width:[^;]*;[^}]*color: var\(--muted\)/);
  assert.match(s, /\.cc \.cc-model:hover[^{]*\{[^}]*color: var\(--text\)/, 'acende no hover');
});

// ---- tarefa: ⋯ sem "modelo"; pílula no composer chama openModelMenu(t.id, pílula) ----
function moreItems(t) {
  const ctx = {
    esc, escA, fwMode: 'conversa', ACTIVE_ST: new Set(['running']), document: { body: { classList: { contains: () => false } } },
    taskIsDone: () => false, fwPrimaryAction: () => null, taskPreviewTarget: () => null, taskPct: () => 45, fwPrNum: () => 1, fwArtOnly: () => false,
    taskType: () => 'feat', taskCost: () => ({ usd: 0, tok: 0 }), budgetOf: () => 0, fmtCost: String, fmtTok: String, fwTreeHidden: () => false,
    aiRunLabel: (e, m) => e + ' · ' + m,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(WS, 'fwMoreItems') + '\nthis.fwMoreItems=fwMoreItems;', ctx);
  return ctx.fwMoreItems(t);
}

test('⋯ da tarefa não tem mais o item "modelo" (uma fonte só: a pílula)', () => {
  for (const status of ['running', 'review', 'error', 'draft']) {
    const it = moreItems({ id: 't1', status, engine: 'codex', model: 'gpt-5-codex', kind: 'feat' });
    assert.ok(it.length > 0);
    assert.ok(!it.some((i) => i.k === 'model' || /^modelo/.test(i.label)), 'sem modelo no ⋯ (' + status + ')');
  }
  assert.doesNotMatch(fnSrc(WS, 'fwMoreDo'), /'model'/, 'fwMoreDo não trata mais "model"');
});

function pillCtx() {
  const opened = [];
  const btn = { disabled: false, onclick: null };
  const ctx = {
    esc, escA, IC: { stop: '■' }, CHAT_CLIP_SVG: '', $id: (id) => (id === 'fwModel' ? btn : null),
    aiRunLabel: (e, m) => (e === 'codex' ? 'Codex' : 'Claude') + (m ? ' · ' + m : ''),
    openModelMenu: (id, anchor) => opened.push([id, anchor]),
  };
  vm.createContext(ctx);
  vm.runInContext(cut(ANEXOS, '// ---- pílula da IA/modelo no composer', '// o: { input, attach, send')
    + fnSrc(WS, 'fwModelPill') + '\nthis.fwModelPill=fwModelPill; this.chatModelPillHtml=chatModelPillHtml; this.chatModelPillWire=chatModelPillWire;', ctx);
  return { ctx, opened, btn };
}

test('tarefa: a pílula mostra motor · modelo e o clique chama openModelMenu com o id da tarefa', () => {
  const { ctx, opened, btn } = pillCtx();
  const t = { id: 'task-42', status: 'running', engine: 'codex', model: 'gpt-5' };
  const p = ctx.fwModelPill(t);
  assert.equal(p.id, 'fwModel');
  assert.match(ctx.chatModelPillHtml(p), /Codex · gpt-5/);
  ctx.chatModelPillWire(p);
  assert.equal(typeof btn.onclick, 'function');
  btn.onclick({ preventDefault() {} });
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'task-42', 'openModelMenu recebe o id da tarefa');
  assert.equal(opened[0][1], btn, '…ancorado na própria pílula');
});

test('tarefa em rascunho: sem pílula (nunca teve o item "modelo")', () => {
  const { ctx } = pillCtx();
  assert.equal(ctx.fwModelPill({ id: 'd', status: 'draft', engine: 'claude' }), null);
  assert.equal(ctx.chatModelPillHtml(ctx.fwModelPill({ id: 'd', status: 'draft' })), '');
});

test('tarefa: a linha do composer monta e liga a pílula (sem duplicar a marcação do composer)', () => {
  assert.match(WS, /<div class="fwinrow cc-row"><button class="btn sm cc-clip" id="fwAttach"[^\n]*\$\{CHAT_CLIP_SVG\}<\/button>\$\{chatModelPillHtml\(fwModelPill\(t\)\)\}/);
  assert.match(WS, /chatModelPillWire\(fwModelPill\(t\)\);/);
});

test('openModelMenu continua gravando do mesmo jeito (set_task_model) e é operável pelo teclado', () => {
  const src = fnSrc(PICKER, 'openModelMenu');
  assert.match(src, /invoke\('set_task_model',\{ taskId, model:id \}\)/, 'mesma persistência — motor intocado');
  assert.doesNotMatch(src, /set_task_engine|engine:/, 'não mexe no motor');
  assert.match(src, /a11yMenu\(pop, anchor, close\)/);
  assert.match(src, /role','menuitemradio'/);
  assert.match(src, /r\.top-6-h/, 'abre pra cima quando não cabe embaixo');
});

test('a11yMenuStep: ↓/↑ dão a volta, Home/End vão às pontas', () => {
  const src = read('54-acessibilidade.js');
  const A = new Function(cut(src, '// @puro-a11y-inicio', '// @puro-a11y-fim') + '\nreturn { a11yMenuStep };')();
  assert.equal(A.a11yMenuStep(3, -1, 'ArrowDown'), 0);
  assert.equal(A.a11yMenuStep(3, 2, 'ArrowDown'), 0);
  assert.equal(A.a11yMenuStep(3, 0, 'ArrowUp'), 2);
  assert.equal(A.a11yMenuStep(3, 1, 'Home'), 0);
  assert.equal(A.a11yMenuStep(3, 1, 'End'), 2);
  assert.equal(A.a11yMenuStep(3, 1, 'a'), -1);
  assert.equal(A.a11yMenuStep(0, 0, 'ArrowDown'), -1);
  // Esc fecha e devolve o foco pra quem abriu
  assert.match(fnSrc(src, 'a11yMenu'), /e\.key==='Escape'\)\{[^}]*close\(true\)/);
});

// ---- chats que já tinham escolha de IA: a pílula no mesmo lugar ----
function chatPillCtx(def) {
  const calls = [];
  const ctx = {
    lsGet: (k) => (k === 'defaultEngine' ? def.eng : k === 'defaultModel' ? def.model : null),
    AI_ENGINES: [{ id: 'claude', name: 'Claude', models: [] }, { id: 'codex', name: 'Codex', models: [] }], _aiGw: null,
    modelFriendly: (m) => m, suaIaOpenCfg: () => calls.push('suaIa'),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(PICKER, 'aiDefaults') + fnSrc(PICKER, 'aiEngineOf') + fnSrc(PICKER, 'aiRunLabel') + fnSrc(PICKER, 'aiChatRunLabel') + fnSrc(PICKER, 'aiChatModelPill')
    + '\nthis.aiChatModelPill=aiChatModelPill;', ctx);
  return { ctx, calls };
}

test('chat do projeto: roda na IA padrão (a escolha mora em Sua IA) → o composer tem a pílula', () => {
  const pc = read('12-chat-prefs-daily.js');
  const hadChoice = /model:aiClaudeModel\(\)/.test(fnSrc(pc, 'pcSend'));
  assert.ok(hadChoice, 'o chat do projeto usa a IA padrão escolhida no painel Sua IA');
  assert.match(fnSrc(pc, 'pcRender'), /chatComposer\(\{ input:'pcInput'[^\n]*modelPill:aiChatModelPill\('pcModel'\)/);
  const { ctx, calls } = chatPillCtx({ eng: 'codex', model: 'gpt-5' });
  const p = ctx.aiChatModelPill('pcModel');
  assert.equal(p.label, 'Codex · gpt-5', 'mostra a IA que vai responder');
  assert.equal(p.popup, '', 'leva ao painel Sua IA — não cria uma segunda configuração');
  p.onPick();
  assert.deepEqual(calls, ['suaIa']);
  // mock não é IA: esses chats seguem no Claude
  assert.equal(chatPillCtx({ eng: 'mock', model: '' }).ctx.aiChatModelPill('x').label, 'Claude · padrão da assinatura');
});

test('orquestrador, issues e Nova demanda: a escolha de IA também foi pro composer', () => {
  const orq = read('34-orquestrador.js');
  assert.doesNotMatch(orq, /orq-model/, 'o "IA: …" solto à direita virou a pílula');
  assert.match(orq, /chatComposerHtml\(\{ cls:'orq-briefcc'[\s\S]*?modelPill:aiChatModelPill\('orqModel'\)/);
  assert.match(orq, /chatComposer\(\{ input:'orqTa'[^\n]*modelPill:aiChatModelPill\('orqModel'\)/);
  assert.match(read('14-issues-projeto.js'), /chatComposer\(\{ input:'trkNIInput'[^\n]*modelPill:aiChatModelPill\('trkNIModel'\)/);
  const pl = read('32-planner.js');
  // F4 (D12): na Nova demanda a IA é o SELETOR ÚNICO (iaPick) ao lado do Tipo, não o slot do composer
  assert.doesNotMatch(fnSrc(pl, 'plWireComposer'), /modelPill:/);
  assert.match(fnSrc(pl, 'plRenderCtl'), /PL_IA=iaPick\(host, \{ value:\{ engine:eng, model \}, scope:'demanda', recommend:plRecommend/);
  // chatComposer garante a pílula também na marcação estática (index.html) e mantém o rótulo atual
  assert.match(fnSrc(ANEXOS, 'chatComposer'), /if\(cfg\.modelPill\) chatModelPillEnsure\(box, cfg\.modelPill\)/);
});
