// Chats de várias rodadas seguem a IA padrão (spec-chats-sem-claude): planner, chat do projeto, issues,
// orquestrador e mesa rodam em Codex/DeepSeek/gateway (Rust ai_once::chat_turn). Aqui: a continuidade no front
// (aiCallResumeSafe reenvia o histórico quando a sessão de QUALQUER motor some; o gateway manda sempre) e a
// fiação das telas no Rust (cada chat escolhe o motor antes de montar os argumentos do claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const rs = (f) => readFileSync(new URL('../src-tauri/src/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };

function resumeCtx() {
  const ctx = { console: { error() {} } };
  vm.createContext(ctx);
  vm.runInContext(cut(read('10-core.js'), '// @resume-inicio', '// @resume-fim') + '\nglobalThis.__safe=aiCallResumeSafe;', ctx);
  return ctx.__safe;
}
const HIST = [{ who: 'you', text: 'quero um filtro por data' }, { who: 'bot', text: 'Qual a tela?' }];

/** Backend falso: grava as chamadas; `errs` = erro por chamada (na ordem). */
function backend(errs = [], sessionId = 'nova') {
  const calls = [];
  const fn = async (prompt, sid) => {
    calls.push({ prompt, sid });
    const e = errs[calls.length - 1];
    if (e) throw new Error(e);
    return { text: '```json\n{"say":"ok"}\n```', sessionId };
  };
  return { fn, calls };
}

test('Claude: sessão retomada sem histórico; "No conversation found" → refaz com o histórico (como antes)', async () => {
  const safe = resumeCtx();
  let b = backend();
  let r = await safe(b.fn, 'uuid-claude', 'e a tela de pedidos', HIST);
  assert.deepEqual(b.calls, [{ prompt: 'e a tela de pedidos', sid: 'uuid-claude' }]);
  assert.equal(r.recovered, undefined);
  b = backend(['A sessão da conversa expirou no Claude — clique em +novo.\n\n(No conversation found with session ID: x)']);
  r = await safe(b.fn, 'uuid-claude', 'e a tela de pedidos', HIST);
  assert.equal(b.calls.length, 2);
  assert.equal(b.calls[1].sid, null);
  assert.match(b.calls[1].prompt, /sessão anterior desta conversa foi perdida[\s\S]*USUÁRIO: quero um filtro por data[\s\S]*VOCÊ: Qual a tela\?[\s\S]*e a tela de pedidos$/);
  assert.equal(r.recovered, true);
});

test('Codex e DeepSeek: sessão sumida (erro padrão do Rust ou texto cru do motor) → reenvia o histórico', async () => {
  const safe = resumeCtx();
  for (const err of [
    'session not found — a conversa anterior não pode ser retomada nesta IA; o app continua com o histórico.', // SESSION_LOST_MSG
    'Error: thread/resume: thread/resume failed: no rollout found for thread id th1 (code -32600)', // codex cru
    'session "s1" does not exist', // dsh cru
  ]) {
    const b = backend([err], 'codex:th2');
    const r = await safe(b.fn, 'codex:th1', 'segunda pergunta', HIST);
    assert.equal(b.calls.length, 2, err);
    assert.equal(b.calls[0].sid, 'codex:th1', 'tenta retomar primeiro');
    assert.equal(b.calls[1].sid, null);
    assert.match(b.calls[1].prompt, /USUÁRIO: quero um filtro por data[\s\S]*segunda pergunta$/);
    assert.equal(r.recovered, true);
    assert.equal(r.sessionId, 'codex:th2');
  }
});

test('gateway (sem sessão): TODA rodada já vai com o histórico, sem tentar retomar e sem aviso de sessão perdida', async () => {
  const safe = resumeCtx();
  const b = backend([], 'gateway:historico');
  const r = await safe(b.fn, 'gateway:historico', 'segunda pergunta', HIST);
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].sid, null);
  assert.match(b.calls[0].prompt, /^\[CONTEXTO — histórico desta conversa[\s\S]*USUÁRIO: quero um filtro por data\n\nVOCÊ: Qual a tela\?\n\[\/CONTEXTO\]\n\nsegunda pergunta$/);
  assert.equal(r.recovered, undefined, 'não é sessão perdida — é o jeito do gateway');
  assert.equal(r.sessionId, 'gateway:historico');
  // 1ª rodada (sem sid): sem histórico, chamada normal
  const b1 = backend([], 'gateway:historico');
  await safe(b1.fn, '', 'primeira', []);
  assert.deepEqual(b1.calls, [{ prompt: 'primeira', sid: null }]);
});

test('outros erros seguem pra tela (erro humano do motor), sem retentar', async () => {
  const safe = resumeCtx();
  const b = backend(['O Codex está sem cota/limite no momento — espere um pouco.\n\n(429)']);
  await assert.rejects(safe(b.fn, 'codex:th1', 'x', HIST), /sem cota/);
  assert.equal(b.calls.length, 1);
  const b2 = backend(['PLANNER_STOPPED']);
  await assert.rejects(safe(b2.fn, 'codex:th1', 'x', HIST), /PLANNER_STOPPED/);
  assert.equal(b2.calls.length, 1, 'parar não vira retentativa');
});

test('nenhum motor pronto → erro humano apontando "Sua IA"', () => {
  const ctx = { window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { platform: 'MacIntel', userAgent: '' }, console, invoke: async () => null };
  vm.createContext(ctx);
  vm.runInContext(read('00-util.js'), ctx);
  const h = ctx.humanErr(new Error('Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), configure um gateway em Configurações → Gateway próprio, ou use o DeepSeek Harness (beta: npm i -g @deepseek-ai/dsh + DEEPSEEK_API_KEY em Configurações → Sua IA).'));
  assert.equal(h.id, 'ai-none');
  assert.match(h.action.label, /Sua IA/);
  let opened = false;
  ctx.window.suaIaOpenCfg = () => { opened = true; };
  h.action.fn();
  assert.ok(opened, 'o botão abre o painel Sua IA');
});

test('Rust: cada chat escolhe o motor ANTES dos argumentos do claude; os não-Claude vão pro chat_turn (só-leitura)', () => {
  const lib = rs('lib.rs');
  const body = (name) => cut(lib, `fn ${name}(`, '\n}\n');
  for (const [name, marker] of [['ai_chat', 'PLANNER_STOPPED'], ['project_chat', 'PROJECT_CHAT_STOPPED'], ['issue_chat', 'ISSUE_CHAT_STOPPED'], ['ai_orchestrate_chat', 'ORQ_CHAT_STOPPED'], ['ai_orchestrate', 'ORQ_PLAN_STOPPED']]) {
    const b = body(name);
    const pick = b.search(/chat_pick\(|ai_once::chat_engine\(/), other = b.indexOf('chat_other('), claude = b.indexOf('claude_cmd(');
    assert.ok(pick > 0 && other > pick && claude > other, `${name}: escolhe o motor, desvia pro chat_turn e só então monta o claude`);
    assert.match(b.slice(other, claude), new RegExp(marker), `${name}: o parar devolve o mesmo marcador da tela`);
  }
  assert.match(body('ai_chat'), /emit_activity\(&app, "planner-activity"\)/);
  assert.match(body('project_chat'), /emit_activity\(&app, "project-chat-activity"\)/);
  const mesa = rs('mesa.rs');
  const ask = cut(mesa, 'pub fn mesa_ask(', '\n}\n');
  assert.ok(ask.indexOf('ai_once::chat_engine()') > 0 && ask.indexOf('ask_other(') < ask.indexOf('claude_cmd('), 'mesa: motor antes do claude');
  assert.match(cut(mesa, 'fn ask_other(', '\n}\n'), /"costUsd": 0\.0/, 'fora do Claude, US$ 0 (como nas tarefas)');
  const once = rs('ai_once.rs');
  assert.match(once, /sandbox_mode=\\"read-only\\"/);
  assert.match(once, /DSH_PERMISSION_MODE", "read-only"/);
  assert.doesNotMatch(cut(once, 'pub(crate) fn chat_turn(', '\n}\n'), /danger-full-access|workspace-write/);
});
