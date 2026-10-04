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

function resumeCtx(eng) {
  const ctx = { console: { error() {} }, aiDefaults: () => ({ eng: eng || 'claude', model: '' }) };
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

test('nenhum motor pronto → erro humano apontando a escolha da IA (Ajustes › IA e modelos)', () => {
  const ctx = { window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { platform: 'MacIntel', userAgent: '' }, console, invoke: async () => null };
  vm.createContext(ctx);
  vm.runInContext(read('00-util.js'), ctx);
  const h = ctx.humanErr(new Error('Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), configure um gateway em Configurações → Gateway próprio, ou use o DeepSeek Harness (beta: npm i -g @deepseek-ai/dsh + DEEPSEEK_API_KEY em Configurações → Sua IA).'));
  assert.equal(h.id, 'ai-none');
  assert.match(h.action.label, /escolher a IA/);
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
  // fora do Claude: US$ 0 (como nas tarefas) + tokens + motor — a tela aplica o TETO POR TOKENS (teste abaixo)
  assert.match(cut(mesa, 'fn ask_other_as(', '\n}\n'), /"costUsd": 0\.0, "inTok": out\.in_tok, "outTok": out\.out_tok, "cachedTok": out\.cached_tok, "engine": eng\.id\(\)/);
  const once = rs('ai_once.rs');
  assert.match(once, /sandbox_mode=\\"read-only\\"/);
  assert.match(once, /DSH_PERMISSION_MODE", "read-only"/);
  assert.doesNotMatch(cut(once, 'pub(crate) fn chat_turn(', '\n}\n'), /danger-full-access|workspace-write/);
});

test('sem sessão pra retomar: sid vazio + conversa já começada → histórico; IA padrão gateway → histórico mesmo com sid de outra IA', async () => {
  let safe = resumeCtx();
  let b = backend();
  await safe(b.fn, '', 'terceira', HIST);
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].sid, null);
  assert.match(b.calls[0].prompt, /USUÁRIO: quero um filtro por data[\s\S]*terceira$/, 'sid apagado (resposta sem sessão) não perde a conversa');
  b = backend();
  await safe(b.fn, '', 'primeira', [{ who: 'bot', text: 'Oi! Qual o objetivo?' }]);
  assert.deepEqual(b.calls, [{ prompt: 'primeira', sid: null }], 'só a saudação da tela não é conversa');
  safe = resumeCtx('gateway');
  b = backend([], 'gateway:historico');
  await safe(b.fn, 'codex:th1', 'troquei pro gateway', HIST);
  assert.equal(b.calls.length, 1, 'não tenta retomar a sessão do codex no gateway');
  assert.equal(b.calls[0].sid, null);
  assert.match(b.calls[0].prompt, /USUÁRIO: quero um filtro por data/);
});

test('rascunho do planner vai junto quando o histórico vai (gateway sem sessão)', async () => {
  const safe = resumeCtx();
  const b = backend([], 'gateway:historico');
  await safe(b.fn, 'gateway:historico', 'e os requisitos?', HIST, 'RASCUNHO ATUAL (o que já ficou fechado nesta conversa — continue daqui, sem perguntar de novo):\n{"title":"Filtro por data"}');
  assert.match(b.calls[0].prompt, /\[CONTEXTO[\s\S]*VOCÊ: Qual a tela\?\n\nRASCUNHO ATUAL[\s\S]*"title":"Filtro por data"\}\n\[\/CONTEXTO\]\n\ne os requisitos\?$/);
  // o planner monta o rascunho com os campos fechados
  const pl = read('32-planner.js');
  const mk = new Function('plFields', 'plAsking', 'plPlan', cut(pl, '// @pl-draft-inicio', '// @pl-draft-fim') + '\nreturn plDraftBlock();');
  const d = mk({ title: 'Filtro por data', objective: 'filtrar pedidos', deliverables: [], requirements: ['URL guarda o filtro'], owns: [], off: [], autonomy: '', artifacts: null, engine: 'claude' }, 'deliverables', null);
  assert.match(d, /^RASCUNHO ATUAL/);
  const obj = JSON.parse(d.split('\n')[1]);
  assert.deepEqual(obj, { title: 'Filtro por data', objective: 'filtrar pedidos', requirements: ['URL guarda o filtro'], asking: 'deliverables' });
  assert.equal(mk({ title: '', deliverables: [] }, '', null), '', 'nada fechado → nada a mandar');
  assert.match(pl, /aiCallResumeSafe\([\s\S]{0,200}plMsgs\.slice\(0,-1\), plDraftBlock\(\)\)/);
});

test('regex de sessão perdida é ESPECÍFICA: "MCP session config not found" não vira reenvio', async () => {
  const safe = resumeCtx();
  const b = backend(['MCP session config not found']);
  await assert.rejects(safe(b.fn, 'codex:th1', 'x', HIST), /MCP session/);
  assert.equal(b.calls.length, 1);
});

/** contexto com 00-util (lsGet/lsSet/aiKeepSid/humanErr) + a porta única (aiCallResumeSafe) + invoke falso */
function chatCtx(store, replies) {
  const calls = [];
  const el = () => ({ style: {}, value: '', checked: false, focus() {} });
  const ctx = {
    window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { platform: 'MacIntel', userAgent: '' }, console: { error() {}, log() {} },
    invoke: async (cmd, args) => { calls.push([cmd, JSON.parse(JSON.stringify(args))]); const r = replies.shift(); if (r instanceof Error) throw r; return r; },
    __el: el,
  };
  vm.createContext(ctx);
  vm.runInContext(read('00-util.js') + '\n' + cut(read('10-core.js'), '// @resume-inicio', '// @resume-fim'), ctx);
  return { ctx, calls };
}
const LOST = new Error('session not found — a conversa anterior não pode ser retomada nesta IA; o app continua com o histórico.');

test('"virar tarefa" (pcToTask) passa pela porta única: gateway leva o histórico; sessão de outra IA → reenvia', async () => {
  const spec = { text: '```json\n{"title":"Filtrar pedidos","objective":"o","requirements":["r1"]}\n```', sessionId: 'gateway:historico' };
  for (const [sid, replies, n] of [['gateway:historico', [spec], 1], ['dsh:s1', [LOST, { ...spec, sessionId: 'codex:th9' }], 2]]) {
    const store = { 'pcsid:/r': sid };
    const { ctx, calls } = chatCtx(store, replies);
    const msgs = [{ role: 'user', text: 'quero filtrar pedidos por data' }, { role: 'assistant', text: 'em qual tela?' }, { role: 'sys', text: 'aviso' }];
    Object.assign(ctx, { state: { repo: '/r' }, pcGate: () => '', pcGateSt: () => ({}), pcMsgs: () => msgs, pcRender() {}, openNewTask: async () => {}, setNtMode() {}, renderNtList() {},
      $id: () => ctx.__el(), toast() {}, showErr: (e) => { throw new Error('showErr: ' + (e && e.message || e)); }, aiClaudeModel: () => '' });
    vm.runInContext(cut(read('12-chat-prefs-daily.js'), 'async function pcToTask(){', '\nfunction openPc(){') + '\nglobalThis.__go=pcToTask;', ctx);
    await ctx.__go();
    assert.equal(calls.length, n, sid);
    const last = calls[n - 1][1];
    assert.equal(calls[n - 1][0], 'project_chat');
    assert.equal(last.sessionId, '', `${sid}: sem retomar`);
    assert.match(last.prompt, /USUÁRIO: quero filtrar pedidos por data[\s\S]*VOCÊ: em qual tela\?[\s\S]*monte a especificação de UMA tarefa/);
    assert.doesNotMatch(last.prompt, /SISTEMA: aviso/, 'aviso da tela não vira fala');
    if (n === 2) assert.equal(calls[0][1].sessionId, 'dsh:s1', 'tentou retomar antes');
    assert.equal(store['pcsid:/r'], n === 1 ? 'gateway:historico' : 'codex:th9', 'guarda o sid devolvido');
  }
});

test('issue chat (trkNICall): gateway e sessão de outra IA reenviam o histórico; reenvio do JSON quebrado também; se falhar fica o "say"', async () => {
  const issues = read('14-issues-projeto.js');
  const load = (ctx) => vm.runInContext(cut(issues, 'function trkParseJson(text){', '\n// ----- ABA') + '\n' + cut(issues, '// @trk-ni-call-inicio', '// @trk-ni-call-fim') + '\nglobalThis.__call=trkNICall;', ctx);
  const broken = { text: '```json\n{"say":"Duas perguntas: ```x``` e "y"","issues":[}\n```', sessionId: 'gateway:historico' };
  const good = { text: '```json\n{"say":"ok","issues":[{"title":"Filtrar pedidos"}],"done":false}\n```', sessionId: 'gateway:historico' };
  // gateway: as DUAS chamadas (rodada + reenvio do JSON) levam o histórico, sem sessão
  let { ctx, calls } = chatCtx({}, [broken, good]);
  Object.assign(ctx, { aiClaudeModel: () => '', trkNIContext: () => '{}' });
  load(ctx);
  let n = { sid: 'gateway:historico', stop: false, project: { path: '/p' }, msgs: [{ who: 'you', text: 'issue: filtro por data' }, { who: 'bot', text: 'qual tela?' }, { who: 'you', text: 'pedidos' }] };
  let r = await ctx.__call(n, 'pedidos');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([c, a]) => c === 'issue_chat' && a.sessionId === ''));
  assert.match(calls[0][1].prompt, /USUÁRIO: issue: filtro por data[\s\S]*pedidos$/);
  assert.match(calls[1][1].prompt, /VOCÊ: ```json[\s\S]*Duas perguntas[\s\S]*NÃO era um JSON válido/, 'o reenvio leva a resposta quebrada no histórico');
  assert.equal(r.obj.say, 'ok');
  // sessão de outra IA: retoma → perdida → reenvia; o reenvio do JSON FALHA → fica o "say" já recebido
  ({ ctx, calls } = chatCtx({}, [LOST, { ...broken, sessionId: 'codex:th2' }, new Error('O Codex está sem cota/limite no momento')]));
  Object.assign(ctx, { aiClaudeModel: () => '', trkNIContext: () => '{}' });
  load(ctx);
  n = { sid: 'dsh:s1', stop: false, project: { path: '/p' }, msgs: [{ who: 'you', text: 'issue: filtro por data' }] };
  r = await ctx.__call(n, 'issue: filtro por data');
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1].sessionId, 'dsh:s1');
  assert.equal(calls[2][1].sessionId, 'codex:th2', 'o reenvio do JSON retoma a sessão nova');
  assert.equal(r.obj, null);
  assert.match(r.text, /^Duas perguntas/, 'ficou a resposta que já chegou (só o say)');
  assert.equal(n.sid, 'codex:th2');
  assert.doesNotMatch(issues, /=await invoke\('issue_chat',/, 'nenhum invoke direto do issue_chat');
  assert.doesNotMatch(read('12-chat-prefs-daily.js'), /=await invoke\('project_chat',/, 'nenhum invoke direto do project_chat');
});

test('Sua IA: aviso visível de que, fora do Claude, a IA dos chats consegue ler .env (sem deny de caminhos no Codex/dsh)', () => {
  const src = read('30-sua-ia.js');
  const N = new Function(cut(src, 'const SUAIA_SECRET_NOTE={', '\n};\n') + '\n};\nreturn SUAIA_SECRET_NOTE;')();
  for (const id of ['codex', 'deepseek']) assert.match(N[id], /fora do Claude, a IA dos chats consegue ler arquivos como \.env do projeto/i);
  assert.match(N.gateway, /não leem arquivos do projeto/);
  assert.equal(N.claude, undefined, 'no Claude vale o modo protegido (deny de .env)');
  assert.match(src, /SUAIA_SECRET_NOTE\[s\.id\]\?`<details class="suaia-secret[^`]*<summary>privacidade nos chats<\/summary>/, 'o cartão mostra o aviso (recolhido em "privacidade nos chats")');
  assert.match(rs('ai_once.rs'), /const CHAT_RO_RULE: &str = "[^"]*não lê arquivos de segredo \(\.env, chaves\)/, 'a regra do prompt continua');
});

test('mesa fora do Claude: TETO POR TOKENS (US$ 0 + tokens → gasto estimado conservador)', () => {
  const src = read('38-mesa.js');
  const M = new Function(cut(src, '// @puro-inicio', '// @puro-fim') + '\nreturn { mesaCapHit, mesaTokUsd, mesaSpentUsd, MESA_TOK_USD };')();
  assert.equal(M.mesaTokUsd('codex', 0, 1e6), 10, 'saída do codex: US$ 10/milhão');
  assert.equal(M.mesaTokUsd('codex', 1e6, 0, 1e6), 0.125, 'entrada toda do cache: preço de cache');
  assert.equal(M.mesaTokUsd('desconhecido', 0, 1e6), 15, 'motor sem taxa → o fallback (o mais caro)');
  const m = { costUsd: 0, tokUsd: M.mesaTokUsd('codex', 0, 120000), capUsd: 1 }; // 1,2 US$ estimados · teto em US$ (F4)
  assert.equal(M.mesaCapHit(m.costUsd, m.capUsd), false, 'só pelo custo (US$ 0) nunca dispararia');
  assert.equal(M.mesaCapHit(M.mesaSpentUsd(m), m.capUsd), true, 'com a estimativa por tokens, dispara');
  // a tela soma os tokens do retorno e usa mesaSpentUsd em TODO teto; e mostra "teto por tokens"
  assert.match(src, /m\.tokUsd=\(\+m\.tokUsd\|\|0\)\+mesaTokUsd\(r\.engine, r\.inTok, r\.outTok, r\.cachedTok\)/);
  assert.doesNotMatch(src, /mesaCapHit\(m\.costUsd/);
  assert.match(src, /teto por tokens/);
});
