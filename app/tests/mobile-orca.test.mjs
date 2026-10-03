// Companion nível Orca (feat/mobile-nivel-orca) — o lado do Mac do que o celular precisa:
// presença (48 @presenca), portão de prova no "aprovar" do celular e mensagem segurada no teto (48 @ponte-mobile),
// o laço real das intenções/mensagens (42 cloudIntentTick/cloudMsgTick com a nuvem e o Tauri falsos),
// o contrato iOS ↔ Mac (toda intenção que o app manda tem tratamento aqui) e o portão de prova Swift ≡ JS por
// fixture dourado (tests/fixtures/proof-gate-golden.json, lido também pelo ConstellationTests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const root = (f) => new URL('../../' + f, import.meta.url);
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
function fn(src, name) {
  const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src); assert.ok(m, 'função não encontrada: ' + name);
  let i = src.indexOf('{', m.index), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('chaves desbalanceadas: ' + name);
}
const p48 = read('48-presenca-mobile.js'), p42 = read('42-nuvem-sync-mobile.js'), p21 = read('21-pull-request.js'), p23 = read('23-kanban-artefatos-editor.js');
const P = new Function(cut(p48, '// @presenca-inicio', '// @presenca-fim') + cut(p48, '// @ponte-mobile-inicio', '// @ponte-mobile-fim') +
  '\nreturn { presenceDeviceName, presenceDeviceId, presenceRow, presenceMissingTable, mobileApproveDecide, mobileMsgPlan, mobileMsgRetry };')();
const G = new Function(cut(p21, '// @prova-gate-inicio', '// @prova-gate-fim') + fn(p23, 'reqNorm') + fn(p23, 'matchReqProofs') +
  '\nreturn { proofGateOf, proofSigOf, proofAskMsg, reqNorm, matchReqProofs };')();

// ---------------- presença ----------------
test('presença: linha com projeto aberto, clonados sem repetir, contagem e online', () => {
  const row = P.presenceRow({ userId: 'u1', deviceId: 'd-abc12345', deviceName: 'Mac', os: 'mac', buildMs: '1790000000000',
    open: { remote: 'github.com/acme/loja-web', legacy: 'github.com-work/acme/loja-web' },
    locals: [{ remote: 'github.com/acme/loja-web', legacy: 'github.com/acme/loja-web' }, { remote: 'github.com/acme/api', legacy: 'github.com/acme/api' }],
    running: 2, now: Date.UTC(2026, 9, 3, 12, 0, 0) });
  assert.equal(row.open_project, 'loja-web');
  assert.deepEqual(row.local_remotes, ['github.com/acme/loja-web', 'github.com-work/acme/loja-web', 'github.com/acme/api']);
  assert.equal(row.running, 2); assert.equal(row.online, true); assert.equal(row.app_build_ms, 1790000000000);
  assert.equal(row.last_seen_at, '2026-10-03T12:00:00.000Z');
  const off = P.presenceRow({ userId: 'u1', deviceId: 'd-x', online: false, running: -4, open: {} });
  assert.equal(off.online, false); assert.equal(off.running, 0); assert.equal(off.open_remote, null); assert.equal(off.open_project, null);
  assert.equal(P.presenceRow({ userId: 'u', deviceId: 'd', open: { remote: 'github.com/a/b.git' } }).open_project, 'b');
});

test('presença: id do computador é estável e válido; nome legível; tabela ausente detectada (0030 pendente)', () => {
  const store = {}; const get = (k) => store[k]; const set = (k, v) => { store[k] = v; };
  const a = P.presenceDeviceId(get, set), b = P.presenceDeviceId(get, set);
  assert.match(a, /^d-[a-z0-9]{6,40}$/); assert.equal(a, b, 'mesmo computador = mesmo id');
  store['sb:deviceId'] = 'lixo com espaço'; assert.notEqual(P.presenceDeviceId(get, set), 'lixo com espaço');
  assert.equal(P.presenceDeviceName('mac'), 'Mac'); assert.equal(P.presenceDeviceName('win'), 'PC Windows');
  assert.equal(P.presenceMissingTable(new Error("Could not find the table 'public.desktop_presence' in the schema cache")), true);
  assert.equal(P.presenceMissingTable(new Error('relation "public.desktop_presence" does not exist')), true);
  assert.equal(P.presenceMissingTable(new Error('erro 404')), true);
  assert.equal(P.presenceMissingTable(new Error('sem conexão com a nuvem')), false);
});

test('presença: batimento NÃO usa o tickLoop (janela escondida não pode deixar o Mac "offline" pro celular)', () => {
  assert.match(p48, /setInterval\(\(\)=>presencePing\(true\), 45000\)/);
  assert.doesNotMatch(p48, /tickLoop\(/);
  assert.match(p48, /keepalive:true/, 'fechar o app avisa offline na hora');
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/48-presenca-mobile.js') > html.indexOf('js/42-nuvem-sync-mobile.js'), '48 carrega depois do 42');
});

// ---------------- ponte: decisões puras ----------------
test('aprovar do celular: mesmo portão de prova do Mac — sem prova só com motivo', () => {
  const rows = [{ text: 'a', st: 'ok', evidence: ['a.png'] }, { text: 'b', st: 'ok', evidence: [] }];
  const g = G.proofGateOf(rows, true, null);
  assert.equal(g.st, 'unproven');
  const no = P.mobileApproveDecide(g, '');
  assert.equal(no.ok, false); assert.match(no.msg, /1 requisito sem prova/);
  assert.equal(P.mobileApproveDecide(g, 'ok').ok, false, 'motivo de 2 letras não vale');
  const yes = P.mobileApproveDecide(g, '  cliente validou na call  ');
  assert.deepEqual(yes, { ok: true, override: true, reason: 'cliente validou na call' });
  assert.deepEqual(P.mobileApproveDecide(G.proofGateOf([rows[0]], true, null), ''), { ok: true, override: false });
  assert.deepEqual(P.mobileApproveDecide(G.proofGateOf([], true, null), ''), { ok: true, override: false });
  assert.equal(P.mobileApproveDecide(G.proofGateOf(rows, false, null), 'x').ok, false, 'provas ainda carregando: não decide');
});

test('mensagem do celular: teto segura; foto, requisito e texto; vazia descarta; 3 tentativas', () => {
  assert.deepEqual(P.mobileMsgPlan('continua', { budgetOpen: true }), { kind: 'hold', why: 'teto' });
  assert.deepEqual(P.mobileMsgPlan('[img] t1/img-1.jpg | olha o botão', {}), { kind: 'img', path: 't1/img-1.jpg', caption: 'olha o botão' });
  assert.deepEqual(P.mobileMsgPlan('[img] t1/a.jpg', {}), { kind: 'img', path: 't1/a.jpg', caption: '' });
  assert.deepEqual(P.mobileMsgPlan('[req] botão azul', {}), { kind: 'talk', text: 'botão azul', asReq: true });
  assert.deepEqual(P.mobileMsgPlan('  ajusta o título ', {}), { kind: 'talk', text: 'ajusta o título', asReq: false });
  assert.deepEqual(P.mobileMsgPlan('[req]   ', {}), { kind: 'drop' });
  assert.equal(P.mobileMsgRetry(1), 'retry'); assert.equal(P.mobileMsgRetry(2), 'retry'); assert.equal(P.mobileMsgRetry(3), 'give-up');
});

// ---------------- o laço REAL (42) com nuvem e Tauri falsos ----------------
function harness({ tasks = [], pending = [], cards = {}, msgs = [], failTalk = 0 } = {}) {
  const calls = [], feed = [], patches = [];
  let talkFails = failTalk;
  const m = Object.fromEntries(Object.entries(cards).map(([l, c]) => [l, c.id]));
  const env = {
    SB: { sess: () => ({ access_token: 't' }), url: () => 'https://x', key: () => 'k' },
    cloudTeamId: () => 'team', cloudScopeOk: () => true, cloudUserId: () => 'u1',
    tmap: () => m, cloudTaskIds: (mm) => Object.keys(mm), pgIn: (ids) => '(' + ids.join(',') + ')',
    state: { tasks, pending },
    sbGet: async (q) => {
      if (q.startsWith('task_messages')) return msgs.filter((x) => !x.delivered_at);
      if (q.startsWith('tasks?select=id,spec,pr_url')) return Object.values(cards).filter((c) => c.spec && c.spec.intent);
      if (q.startsWith('tasks?select=spec&id=eq.')) { const id = q.split('eq.')[1]; return [Object.values(cards).find((c) => c.id === id) || {}]; }
      return [];
    },
    sbFetch: async (path, opts) => {
      const body = JSON.parse(opts.body); patches.push({ path, body });
      const mid = /task_messages\?id=eq\.(\d+)/.exec(path); if (mid) { const x = msgs.find((y) => String(y.id) === mid[1]); if (x) x.delivered_at = body.delivered_at; }
      const tid = /tasks\?id=eq\.([\w-]+)/.exec(path); if (tid) { const c = Object.values(cards).find((y) => y.id === tid[1]); if (c) Object.assign(c, body); }
      return null;
    },
    sbPost: async (t, b) => { if (t === 'task_feed') feed.push(b); return [b]; },
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'talk_task' && talkFails > 0) { talkFails--; throw new Error('motor ocupado'); }
      if (cmd === 'repo_checks') return [];
      if (cmd === 'open_pr') return 'https://github.com/acme/x/pull/9';
      if (cmd === 'pr_body_ai') return 'corpo';
      return null;
    },
    mobileMsgPlan: P.mobileMsgPlan, mobileMsgRetry: P.mobileMsgRetry, mobileApproveDecide: P.mobileApproveDecide,
    proofSigOf: G.proofSigOf, proofAskMsg: G.proofAskMsg,
    lsSet: (k, v) => { env.ls[k] = v; }, lsGet: (k) => env.ls[k], ls: {},
    humanErr: (e, ctx) => ({ msg: (ctx || '') + ': ' + (e && e.message) }), errText: (e) => String(e && e.message || e),
    refresh: async () => {}, prCache: {}, budgetQuiet: new Set(), console: { error() {} },
  };
  return { env, calls, feed, patches, msgs, cards };
}
const loopOf = (name, extra = '') => {
  const src = name === 'cloudMsgTick'
    ? 'const msgDelivering=new Set(), msgFails={}, msgHeld=new Set();\n' + fn(p42, 'cloudMsgTick')
    : 'const intentBusy={}; let lastSig="";\n' + fn(p42, 'cloudIntentTick');
  return (env) => {
    const names = Object.keys(env);
    return new Function(...names, extra + src + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
  };
};

test('mensagem do celular com teto aberto: fica na fila (não vira "continuar" escondido) e avisa no feed UMA vez', async () => {
  const h = harness({ cards: { L1: { id: 'C1' } }, pending: [{ id: -5, taskId: 'L1', kind: 'budget' }], msgs: [{ id: 1, task_id: 'C1', body: 'ajusta o botão', delivered_at: null }] });
  const tick = loopOf('cloudMsgTick')(h.env);
  await tick(); await tick();
  assert.equal(h.calls.filter((c) => c[0] === 'talk_task').length, 0, 'nada chegou ao agente');
  assert.equal(h.msgs[0].delivered_at, null, 'continua na fila');
  assert.equal(h.feed.filter((f) => /teto de custo/.test(f.text)).length, 1);
});

test('mensagem do celular: falha na entrega devolve pra fila e a próxima volta entrega (sem duplicar)', async () => {
  const h = harness({ cards: { L1: { id: 'C1' } }, failTalk: 1, msgs: [{ id: 7, task_id: 'C1', body: '[req] testes do checkout', delivered_at: null }] });
  const tick = loopOf('cloudMsgTick')(h.env);
  await tick();
  assert.equal(h.msgs[0].delivered_at, null, '1ª falhou: voltou pra fila');
  await tick();
  const talks = h.calls.filter((c) => c[0] === 'talk_task');
  assert.equal(talks.length, 2);
  assert.deepEqual(talks[1][1], { taskId: 'L1', message: 'testes do checkout', asReq: true, agent: null });
  assert.ok(h.msgs[0].delivered_at, 'entregue');
  await tick();
  assert.equal(h.calls.filter((c) => c[0] === 'talk_task').length, 2, 'não entrega de novo');
  assert.equal(h.feed.filter((f) => f.agent === 'Você').length, 1, 'eco "Você:" uma vez só');
});

test('mensagem do celular: depois de 3 falhas desiste e avisa no feed', async () => {
  const h = harness({ cards: { L1: { id: 'C1' } }, failTalk: 9, msgs: [{ id: 8, task_id: 'C1', body: 'oi', delivered_at: null }] });
  const tick = loopOf('cloudMsgTick')(h.env);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(h.calls.filter((c) => c[0] === 'talk_task').length, 3);
  assert.ok(h.feed.some((f) => f.kind === 'error' && /não chegou ao agente/.test(f.text)));
});

const T1 = { id: 'L1', title: 'Checkout', status: 'review', requirements: ['frete', 'cupom'], spec: {} };
const gateEnv = (st) => ({
  proofGate: () => (st === 'unproven' ? { st, missing: [{ text: 'cupom', st: 'na', evidence: [] }] } : { st, missing: [] }),
  reqProofCache: {}, loadReqProofs: async () => {}, chkPrBodyExtra: () => '\n\n## Provas\nsem prova: cupom',
  fwSendText: async () => true, prBodyOf: () => 'b', loadPr: async () => {}, prFixOne: async () => true, commitsCache: {},
});

test('intenção openPr do celular SEM motivo com requisito sem prova: o Mac recusa e explica (não abre PR)', async () => {
  const h = harness({ tasks: [T1], cards: { L1: { id: 'C1', spec: { intent: { kind: 'openPr' } } } } });
  Object.assign(h.env, gateEnv('unproven'));
  await loopOf('cloudIntentTick')(h.env)();
  assert.ok(!h.calls.some((c) => c[0] === 'open_pr' || c[0] === 'push_task'), 'nada de push/PR');
  const res = h.cards.L1.spec.intentResult;
  assert.equal(res.ok, false); assert.match(res.msg, /1 requisito sem prova/);
  assert.equal(h.cards.L1.spec.intent, null, 'a intenção é consumida (não repete a cada 6s)');
});

test('intenção openPr COM motivo: registra o override (local + log) e o PR leva a seção de provas', async () => {
  const h = harness({ tasks: [T1], cards: { L1: { id: 'C1', spec: { intent: { kind: 'openPr', noProofReason: 'cliente validou na call' } } } } });
  Object.assign(h.env, gateEnv('unproven'));
  await loopOf('cloudIntentTick')(h.env)();
  const ov = JSON.parse(h.env.ls['proofOv:L1']);
  assert.match(ov.reason, /cliente validou na call \(pelo celular\)/); assert.equal(ov.sig, 'cupom');
  assert.ok(h.calls.some((c) => c[0] === 'checks_override_log' && /\[sem prova · celular\]/.test(c[1].reason)));
  const pr = h.calls.find((c) => c[0] === 'open_pr');
  assert.ok(pr, 'abriu o PR'); assert.match(pr[1].body, /## Provas/);
  assert.equal(h.cards.L1.spec.intentResult.ok, true); assert.equal(h.cards.L1.pr_url, 'https://github.com/acme/x/pull/9');
});

test('intenções novas do celular: retomar (recusa no teto), parar o turno, pedir a prova', async () => {
  const paused = { ...T1, status: 'paused', spec: { budgetHit: { usd: 5 } } };
  let h = harness({ tasks: [paused], cards: { L1: { id: 'C1', spec: { intent: { kind: 'resume' } } } } });
  Object.assign(h.env, gateEnv('proven'));
  await loopOf('cloudIntentTick')(h.env)();
  assert.ok(!h.calls.some((c) => c[0] === 'resume_task'), 'teto: não retoma escondido');
  assert.match(h.cards.L1.spec.intentResult.msg, /teto de custo/);

  h = harness({ tasks: [{ ...T1, status: 'paused' }], cards: { L1: { id: 'C1', spec: { intent: { kind: 'resume' } } } } });
  Object.assign(h.env, gateEnv('proven'));
  await loopOf('cloudIntentTick')(h.env)();
  assert.ok(h.calls.some((c) => c[0] === 'resume_task')); assert.equal(h.cards.L1.spec.intentResult.ok, true);

  h = harness({ tasks: [{ ...T1, status: 'running' }], cards: { L1: { id: 'C1', spec: { intent: { kind: 'stop' } } } } });
  Object.assign(h.env, gateEnv('proven'));
  await loopOf('cloudIntentTick')(h.env)();
  assert.ok(h.calls.some((c) => c[0] === 'stop_task')); assert.ok(h.env.budgetQuiet.has('L1'), 'parar não vira "pronta pra revisar" falso');

  h = harness({ tasks: [T1], cards: { L1: { id: 'C1', spec: { intent: { kind: 'askProof' } } } } });
  const sent = []; Object.assign(h.env, gateEnv('unproven'), { fwSendText: async (id, txt) => { sent.push([id, txt]); return true; } });
  await loopOf('cloudIntentTick')(h.env)();
  assert.equal(sent.length, 1); assert.match(sent[0][1], /falta a PROVA/); assert.match(sent[0][1], /1\. cupom/);
  assert.equal(h.cards.L1.spec.intentResult.ok, true);
});

// ---------------- contrato iOS ↔ Mac ----------------
test('toda intenção que o app iOS manda tem tratamento no Mac (42 cloudIntentTick)', () => {
  const dir = root('mobile/ios/Constellation/');
  const swift = readdirSync(dir).filter((f) => f.endsWith('.swift')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const kinds = new Set();
  for (const m of swift.matchAll(/(?:intent\([^,]+,\s*|act\()"(\w+)"/g)) kinds.add(m[1]);
  for (const k of ['openPr', 'merge', 'pause', 'resume', 'stop', 'abort', 'askProof', 'fixComment']) assert.ok(kinds.has(k), 'o app manda ' + k);
  const tick = fn(p42, 'cloudIntentTick');
  for (const k of kinds) assert.match(tick, new RegExp("kind==='" + k + "'"), 'o Mac trata "' + k + '"');
});

test('migration 0030: idempotente, RLS própria, publicação do ao vivo e registrada na aba Banco (migrations.ts)', () => {
  const sql = readFileSync(root('supabase/migrations/0030_mobile_presenca_aovivo.sql'), 'utf8');
  assert.match(sql, /create table if not exists desktop_presence/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /using \(user_id = auth\.uid\(\)\) with check \(user_id = auth\.uid\(\)\)/);
  for (const t of ['desktop_presence', 'task_feed', 'task_messages']) assert.match(sql, new RegExp('add table ' + t + '; exception when others then null'));
  assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
  const reg = readFileSync(root('supabase/functions/admin-api/migrations.ts'), 'utf8');
  const m = reg.match(/\{ name: "0030_mobile_presenca_aovivo\.sql", sql: ("(?:[^"\\]|\\.)*") \}/);
  assert.ok(m, 'registrada'); assert.equal(JSON.parse(m[1]), sql, 'mesmo conteúdo do arquivo');
});

// ---------------- portão de prova: Swift ≡ JS (fixture dourado) ----------------
const CASES = [
  { name: 'tudo provado', reqs: ['frete no carrinho', 'cupom inválido'], list: [{ req: 'frete no carrinho', status: 'done', evidence: ['a.png'] }, { req: 'cupom inválido', status: 'done', evidence: ['b.png'] }] },
  { name: 'feito sem arquivo', reqs: ['a', 'b'], list: [{ req: 'a', status: 'done', evidence: ['a.png'] }, { req: 'b', status: 'done', evidence: [] }] },
  { name: 'sem requirements.json', reqs: ['a', 'b'], list: null },
  { name: 'casa por índice (mesmo tamanho)', reqs: ['Botão de login', 'Sessão criada'], list: [{ req: 'login com Apple', status: 'done', evidence: ['x.png'] }, { req: 'token salvo', status: 'blocked', evidence: [], note: 'sem conta' }] },
  { name: 'casa por "contém" sem acento/caixa', reqs: ['Cupom INVÁLIDO mostra erro', 'testes passando'], list: [{ req: 'cupom invalido mostra erro em pt-BR', status: 'done', evidence: ['c.png'] }] },
  { name: 'bloqueado com nota', reqs: ['modo escuro'], list: [{ req: 'modo escuro', status: 'blocked', evidence: [], note: 'falta o tema' }] },
  { name: 'sem requisitos', reqs: [], list: [] },
  { name: 'pontuação e espaços', reqs: ['  API — retorna 200!  '], list: [{ req: 'api retorna 200', status: 'done', evidence: ['t.md'] }] },
];
test('portão de prova: fixture dourado (o ConstellationTests do iOS lê o MESMO arquivo)', () => {
  const out = CASES.map((c) => {
    const m = G.matchReqProofs(c.reqs, c.list);
    const rows = c.reqs.map((r, i) => { const p = m[i]; return { text: r, st: p ? (p.status === 'done' ? 'ok' : 'blk') : 'na', evidence: (p && Array.isArray(p.evidence)) ? p.evidence : [], note: (p && p.note) || '' }; });
    const g = G.proofGateOf(rows, true, null);
    return { ...c, norm: c.reqs.map(G.reqNorm), rows, gate: g.st, missing: g.missing.map((r) => r.text) };
  });
  const gold = root('tests/fixtures/proof-gate-golden.json');
  if (process.env.CARDUME_UPDATE_GOLDEN === '1' || !existsSync(gold)) writeFileSync(gold, JSON.stringify(out, null, 2) + '\n');
  assert.deepEqual(out, JSON.parse(readFileSync(gold, 'utf8')));
});
