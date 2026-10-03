// Starfork mobile — NUVEM FALSA pra provar o app iOS no Simulador sem tocar no Supabase real.
//
//   node mobile/ios/mock/mock-supabase.mjs            (porta 54399; MOCK_PORT muda)
//   app: SIMCTL_CHILD_SUPA_URL=http://127.0.0.1:54399 SIMCTL_CHILD_DEMO_SESSION=1 xcrun simctl launch …
//
// O que imita (o suficiente pro app — não é o Supabase inteiro):
//  - GoTrue: /auth/v1/token (password · refresh_token) com tokens que EXPIRAM (MOCK_TTL, s) → testa o refresh;
//  - PostgREST: GET/POST/PATCH em /rest/v1/<tabela> com eq · neq · gt · gte · lt · in · is.null · not.is.null ·
//    or=(…) · order · limit · on_conflict; embutidos tasks(...) e projects(...);
//  - Storage: /storage/v1/object/sign/artifacts/<path> → URL servida daqui (com Range — o AVPlayer exige);
//  - Realtime (Phoenix v1 sobre WebSocket, implementado à mão): phx_join com postgres_changes (+ filtro eq),
//    heartbeat, access_token, phx_close quando o token vence; cada escrita vira postgres_changes;
//  - o "MAC": batimento em desktop_presence, entrega task_messages, executa intenções (com o PORTÃO DE PROVA
//    igual ao desktop), assume tarefas pedidas do celular, fecha perguntas respondidas.
// Controle (curl): /__ctl/mac?online=0|1 · /__ctl/drop · /__ctl/ws?down=1 · /__ctl/rest?down=1 · /__ctl/expire ·
//                  /__ctl/step?what=feed|ready|error|question|teto · /__ctl/log · /__ctl/reset
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = +(process.env.MOCK_PORT || 54399);
const TTL = +(process.env.MOCK_TTL || 3600);
const FIX = process.env.MOCK_FIXTURES || join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ME = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_LOJA = 'bbbbbbbb-0000-4000-8000-000000000001', P_API = 'bbbbbbbb-0000-4000-8000-000000000002';
const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const uuid = () => 'cccccccc-' + Math.random().toString(16).slice(2, 6) + '-4' + Math.random().toString(16).slice(2, 5) + '-8' + Math.random().toString(16).slice(2, 5) + '-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');

// ---------------- dados ----------------
let db, seq, log;
function seed() {
  seq = { task_feed: 1000, task_messages: 10, task_activity: 50, questions: 0 };
  log = [];
  const T = (id, o) => ({ id, local_id: 'l-' + id.slice(-4), team_id: TEAM, project_id: P_LOJA, created_by: ME, assignee: ME, flag: null,
    branch: null, pr_url: null, issue_url: null, cost_usd: 0, cost_tokens: 0, stage: null, epic_id: null, claim_mode: 'reserved',
    created_at: ago(7200), updated_at: ago(60), requirements_proof: null, spec: {}, ...o });
  const reqsCheckout = ['carrinho mostra o total com frete', 'cupom inválido mostra erro em pt-BR', 'testes do checkout passando'];
  db = {
    profiles: [
      { user_id: ME, name: 'Douglas', email: 'douglas@exemplo.dev', last_seen_at: ago(20) },
      { user_id: ANA, name: 'Ana Souza', email: 'ana@exemplo.dev', last_seen_at: ago(4000) },
    ],
    teams: [{ id: TEAM, name: 'Time Produto' }],
    team_members: [{ team_id: TEAM, user_id: ME }, { team_id: TEAM, user_id: ANA }],
    billing_plans: [], billing: [], orgs: [],
    projects: [
      { id: P_LOJA, team_id: TEAM, name: 'loja-web', repo_remote: 'github.com/acme/loja-web' },
      { id: P_API, team_id: TEAM, name: 'api-pagamentos', repo_remote: 'github.com/acme/api-pagamentos' },
    ],
    tasks: [
      T('dddddddd-0000-4000-8000-000000000001', { title: 'Checkout com cálculo de frete', status: 'running', branch: 'feat/checkout-frete', cost_usd: 1.84, updated_at: ago(30),
        spec: { objective: 'Calcular o frete no carrinho pelos Correios e mostrar o total.', requirements: reqsCheckout, kind: 'build', model: 'claude-opus-5-5', budgetUsd: 5 },
        requirements_proof: { list: [{ req: reqsCheckout[0], status: 'done', evidence: ['proof-carrinho.png'] }] } }),
      T('dddddddd-0000-4000-8000-000000000002', { title: 'Login com Apple', status: 'review', branch: 'feat/login-apple', cost_usd: 3.12, updated_at: ago(400),
        spec: { objective: 'Entrar com a conta Apple no app e no site.', requirements: ['botão Entrar com Apple na tela de login', 'sessão criada no Supabase', 'vídeo do fluxo no simulador'], kind: 'build',
          stat: { files: 9, add: 312, del: 40, commits: 4 }, review: { summary: 'Botão **Entrar com Apple** na tela de login, troca do token pelo Supabase e testes do fluxo.', howToTest: '1. abra o app\n2. toque em Entrar com Apple\n3. confira a sessão' } },
        requirements_proof: { list: [
          { req: 'botão Entrar com Apple na tela de login', status: 'done', evidence: ['proof-login.png'] },
          { req: 'sessão criada no Supabase', status: 'done', evidence: ['tests.md'] },
          { req: 'vídeo do fluxo no simulador', status: 'done', evidence: [] } ] } }),
      T('dddddddd-0000-4000-8000-000000000003', { title: 'Corrigir arredondamento do Pix', status: 'review', project_id: P_API, branch: 'fix/pix-arredonda', cost_usd: 0.92, updated_at: ago(900),
        pr_url: 'https://github.com/acme/api-pagamentos/pull/41',
        spec: { objective: 'Valores com 3 casas quebravam o Pix.', requirements: ['arredonda pra 2 casas'], kind: 'build',
          prInfo: { number: 41, state: 'OPEN', decision: 'APPROVED', body: 'Arredonda o valor antes de gerar o QR.', comments: [{ id: 7, author: 'ana', path: 'src/pix.ts', line: 18, answered: false, body: 'use Math.round em centavos' }] } },
        requirements_proof: { list: [{ req: 'arredonda pra 2 casas', status: 'done', evidence: ['tests.md'] }] } }),
      T('dddddddd-0000-4000-8000-000000000004', { title: 'Migrar relatórios pro novo banco', status: 'paused', cost_usd: 5.02, updated_at: ago(1200),
        spec: { objective: 'Mover os relatórios mensais pra tabela nova.', requirements: ['relatório de vendas igual ao antigo'], kind: 'build', budgetUsd: 5, budgetHit: { usd: 5.02, cap: 5, at: Date.now() - 1200000, mode: 'paused' } } }),
      T('dddddddd-0000-4000-8000-000000000005', { title: 'Tela de pedidos no tablet', status: 'running', created_by: ANA, assignee: ANA, cost_usd: 0.6, updated_at: ago(80), spec: { objective: 'Layout de tablet.', kind: 'design' } }),
      T('dddddddd-0000-4000-8000-000000000006', { title: 'Página de status da API', status: 'merged', project_id: P_API, pr_url: 'https://github.com/acme/api-pagamentos/pull/39', cost_usd: 1.1, updated_at: ago(5000), spec: { kind: 'build', prInfo: { number: 39, state: 'MERGED' } } }),
      T('dddddddd-0000-4000-8000-000000000007', { title: 'Investigar lentidão no catálogo', status: 'error', cost_usd: 0.4, updated_at: ago(3000), spec: { objective: 'Catálogo leva 8s pra abrir.', kind: 'invest' } }),
    ],
    questions: [],
    task_feed: [],
    task_messages: [],
    task_activity: [],
    artifacts_meta: [
      { task_id: 'dddddddd-0000-4000-8000-000000000002', name: 'proof-login.png', kind: 'image', storage_path: 'demo/proof-login.png', created_at: ago(500) },
      { task_id: 'dddddddd-0000-4000-8000-000000000002', name: 'mobile-ios-1-fluxo.mp4', kind: 'video', storage_path: 'demo/fluxo.mp4', created_at: ago(450) },
      { task_id: 'dddddddd-0000-4000-8000-000000000002', name: 'tests.md', kind: 'doc', storage_path: 'demo/tests.md', created_at: ago(440) },
      { task_id: 'dddddddd-0000-4000-8000-000000000001', name: 'proof-carrinho.png', kind: 'image', storage_path: 'demo/proof-carrinho.png', created_at: ago(100) },
    ],
    device_tokens: [],
    desktop_presence: [{ user_id: ME, device_id: 'mac-demo', device_name: 'MacBook do Douglas', os: 'macos', app_build_ms: Date.now() - 86400000,
      open_remote: 'github.com/acme/loja-web', open_legacy: 'github.com/acme/loja-web', open_project: 'loja-web',
      local_remotes: ['github.com/acme/loja-web', 'github.com/acme/api-pagamentos'], running: 1, online: true, last_seen_at: ago(15) }],
  };
  const f = (tid, agent, kind, text, s) => db.task_feed.push({ id: ++seq.task_feed, task_id: tid, agent, kind, text, at: ago(s) });
  const t1 = db.tasks[0].id;
  f(t1, 'Sistema', 'note', '▶ o Mac assumiu: criando worktree e iniciando o agente…', 600);
  f(t1, 'coder', 'think', 'Vou ler o carrinho atual e a integração com os Correios antes de mexer — o cálculo hoje é feito no front e ignora o CEP.', 560);
  f(t1, 'coder', 'bash', '$ npm test -- cart', 500);
  f(t1, 'coder', 'edit', 'src/cart/frete.ts', 470);
  f(t1, 'coder', 'note', 'Frete calculado pelo CEP com cache de 10 min; o total do carrinho já soma o frete. Falta o caso do cupom inválido.', 420);
  addQuestion(t1, 'coder', 'O cupom inválido deve bloquear o checkout ou só mostrar o aviso e seguir sem desconto?', ['bloquear o checkout', 'mostrar aviso e seguir'], 300);
  addQuestion(db.tasks[3].id, 'Starfork', 'A tarefa “Migrar relatórios pro novo banco” chegou no teto de US$ 5,00. Já gastou US$ 5,02.\n\nO agente está pausado — nada se perde. Continuar libera mais um teto igual; parar deixa o trabalho como está, pra você revisar.', ['Continuar com mais US$ 5', 'Parar aqui'], 1200, -123456);
}
function addQuestion(taskId, agent, prompt, options, s = 0, localId) {
  const q = { id: uuid(), task_id: taskId, local_pending_id: localId ?? ++seq.questions, agent, prompt, options, status: 'open', answer: null, answered_by: null, created_at: ago(s), answered_at: null };
  db.questions.push(q); return q;
}

// ---------------- PNG mínimo (prova sem arquivo) ----------------
function png(w, h, rgb) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const band = ((x / 40 | 0) + (y / 40 | 0)) % 2; raw[o] = rgb[0] - band * 20; raw[o + 1] = rgb[1] - band * 20; raw[o + 2] = rgb[2] - band * 20; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- auth ----------------
let tokN = 0, expireBefore = 0;
function mint() { tokN++; const exp = Math.floor(Date.now() / 1000) + TTL; return { access_token: `mock-at-${tokN}-${exp}`, refresh_token: `mock-rt-${tokN}`, expires_in: TTL, expires_at: exp, token_type: 'bearer', user: { id: ME, email: 'douglas@exemplo.dev' } }; }
function tokenOk(tok) {
  const m = /^mock-at-(\d+)-(\d+)$/.exec(tok || ''); if (!m) return tok === 'demo';
  return +m[2] * 1000 > Date.now() && +m[1] > expireBefore;
}

// ---------------- PostgREST mínimo ----------------
function parseVal(v) { if (v === 'null') return null; if (v === 'true') return true; if (v === 'false') return false; return v; }
function cond(col, expr) {
  if (col.includes('->')) return () => true; // filtro em json (spec->>intent) — o app não depende dele aqui
  const neg = expr.startsWith('not.'); if (neg) expr = expr.slice(4);
  const i = expr.indexOf('.'); const op = expr.slice(0, i), val = expr.slice(i + 1);
  let f;
  if (op === 'eq') f = (r) => String(r[col]) === val;
  else if (op === 'neq') f = (r) => String(r[col]) !== val;
  else if (op === 'gt') f = (r) => cmp(r[col], val) > 0;
  else if (op === 'gte') f = (r) => cmp(r[col], val) >= 0;
  else if (op === 'lt') f = (r) => cmp(r[col], val) < 0;
  else if (op === 'is') f = (r) => (val === 'null' ? r[col] == null : r[col] === parseVal(val));
  else if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); f = (r) => set.includes(String(r[col])); }
  else f = () => true;
  return neg ? (r) => !f(r) : f;
}
function cmp(a, b) { const na = +a, nb = +b; if (!isNaN(na) && !isNaN(nb)) return na - nb; return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }
function orCond(expr) { const parts = expr.replace(/^\(|\)$/g, '').split(','); const fs = parts.map((p) => { const i = p.indexOf('.'); return cond(p.slice(0, i), p.slice(i + 1)); }); return (r) => fs.some((f) => f(r)); }
function query(table, params) {
  let rows = (db[table] || []).slice();
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'on_conflict', 'offset'].includes(k)) continue;
    rows = rows.filter(k === 'or' ? orCond(v) : cond(k, v));
  }
  const ord = params.get('order');
  if (ord) { const [c, dir] = ord.split('.'); rows.sort((a, b) => cmp(a[c], b[c]) * (dir === 'desc' ? -1 : 1)); }
  const lim = +(params.get('limit') || 0); if (lim) rows = rows.slice(0, lim);
  const sel = params.get('select') || '';
  return rows.map((r) => {
    const o = { ...r };
    if (/tasks\(/.test(sel)) { const t = db.tasks.find((x) => x.id === r.task_id); o.tasks = t ? { title: t.title, assignee: t.assignee, created_by: t.created_by } : null; }
    if (/projects\(/.test(sel)) { const p = db.projects.find((x) => x.id === r.project_id); o.projects = p ? { repo_remote: p.repo_remote, name: p.name } : null; }
    return o;
  });
}
function write(table, type, rec, old) {
  if (table === 'tasks' && type === 'UPDATE') rec.updated_at = now();
  log.push({ at: now(), table, type, rec: JSON.parse(JSON.stringify(rec)) });
  if (log.length > 400) log.shift();
  broadcast(table, type, rec, old);
}
function insert(table, body, onConflict) {
  const list = Array.isArray(body) ? body : [body]; const out = [];
  db[table] = db[table] || [];
  for (const b of list) {
    if (onConflict) {
      const keys = onConflict.split(',');
      const hit = db[table].find((r) => keys.every((k) => String(r[k]) === String(b[k])));
      if (hit) { const old = { ...hit }; Object.assign(hit, b); write(table, 'UPDATE', hit, old); out.push(hit); continue; }
    }
    const r = { ...b };
    if (seq[table] != null && r.id == null) r.id = ++seq[table];
    if (r.id == null) r.id = uuid();
    if (table === 'task_feed' && !r.at) r.at = now();
    if (table === 'task_messages' && !r.created_at) { r.created_at = now(); r.delivered_at = r.delivered_at ?? null; }
    if (table === 'tasks') { r.created_at = r.created_at || now(); r.updated_at = now(); r.flag = r.flag ?? null; r.pr_url = r.pr_url ?? null; r.cost_usd = r.cost_usd ?? 0; r.requirements_proof = null; }
    db[table].push(r); write(table, 'INSERT', r); out.push(r);
  }
  return out;
}
function patch(table, params, body) {
  const rows = query(table, params).map((r) => (db[table] || []).find((x) => x === r || (x.id != null && x.id === r.id) || (x.user_id && x.user_id === r.user_id && x.device_id === r.device_id)));
  for (const r of rows) { if (!r) continue; const old = { ...r }; Object.assign(r, body); write(table, 'UPDATE', r, old); }
  return rows.filter(Boolean);
}

// ---------------- Realtime (Phoenix v1) ----------------
const sockets = new Set();
let wsDown = false, restDown = false, macOnline = true;
function wsAccept(req, socket) {
  if (wsDown) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const acc = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  const S = { socket, buf: Buffer.alloc(0), chans: new Map(), token: '' };
  sockets.add(S);
  socket.on('data', (d) => { S.buf = Buffer.concat([S.buf, d]); readFrames(S); });
  socket.on('close', () => sockets.delete(S));
  socket.on('error', () => sockets.delete(S));
}
function readFrames(S) {
  for (;;) {
    const b = S.buf; if (b.length < 2) return;
    const op = b[0] & 0x0f; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = b[1] & 0x80; const mOff = off; if (masked) off += 4;
    if (b.length < off + len) return;
    let data = b.subarray(off, off + len);
    if (masked) { const m = b.subarray(mOff, mOff + 4); data = Buffer.from(data.map((x, i) => x ^ m[i % 4])); }
    S.buf = b.subarray(off + len);
    if (op === 8) { try { S.socket.end(); } catch {} sockets.delete(S); return; }
    if (op === 9) { sendFrame(S, data, 0xa); continue; }
    if (op === 1) { try { onMsg(S, JSON.parse(data.toString('utf8'))); } catch (e) { console.error('ws msg', e.message); } }
  }
}
function sendFrame(S, payload, op = 1) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const h = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : p.length < 65536 ? Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x80 | op; x[1] = 127; x.writeBigUInt64BE(BigInt(p.length), 2); return x; })();
  try { S.socket.write(Buffer.concat([h, p])); } catch {}
}
const send = (S, m) => sendFrame(S, JSON.stringify(m));
let pcId = 1;
function onMsg(S, m) {
  const { topic, event, payload, ref } = m;
  if (topic === 'phoenix' && event === 'heartbeat') return send(S, { topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref });
  if (event === 'phx_join') {
    const tok = payload.access_token || '';
    if (!tokenOk(tok)) return send(S, { topic, event: 'phx_reply', payload: { status: 'error', response: { reason: 'Invalid token' } }, ref, join_ref: m.join_ref });
    S.token = tok;
    const pcs = ((payload.config || {}).postgres_changes || []).map((c) => ({ ...c, id: pcId++ }));
    const missing = pcs.find((c) => !(c.table in db));
    if (missing) {
      send(S, { topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: pcs } }, ref, join_ref: m.join_ref });
      return send(S, { topic, event: 'system', payload: { channel: topic.replace(/^realtime:/, ''), extension: 'postgres_changes', status: 'error', message: 'Unable to subscribe to changes with given parameters. Please check Realtime is enabled for the given connect parameters: [schema: public, table: ' + missing.table + ']' }, ref: null });
    }
    S.chans.set(topic, { pcs, joinRef: m.join_ref });
    send(S, { topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: pcs } }, ref, join_ref: m.join_ref });
    return send(S, { topic, event: 'system', payload: { channel: topic.replace(/^realtime:/, ''), extension: 'postgres_changes', status: 'ok', message: 'Subscribed to PostgreSQL' }, ref: null });
  }
  if (event === 'phx_leave') { S.chans.delete(topic); return send(S, { topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref }); }
  if (event === 'access_token') { if (tokenOk(payload.access_token)) S.token = payload.access_token; return; }
}
function broadcast(table, type, rec, old) {
  for (const S of sockets) for (const [topic, ch] of S.chans) {
    const ids = ch.pcs.filter((c) => c.table === table && (c.event === '*' || c.event === type) && (!c.filter || cond(c.filter.split('=')[0], c.filter.split('=').slice(1).join('='))(rec))).map((c) => c.id);
    if (!ids.length) continue;
    send(S, { topic, event: 'postgres_changes', payload: { ids, data: { schema: 'public', table, type, commit_timestamp: now(), record: rec, old_record: old || null, errors: null } }, ref: null });
  }
}
// token venceu com o canal aberto → o servidor fecha o canal (o app tem que renovar e entrar de novo)
setInterval(() => {
  for (const S of sockets) if (S.token && !tokenOk(S.token)) {
    for (const topic of S.chans.keys()) { send(S, { topic, event: 'system', payload: { extension: 'system', status: 'error', message: 'Token has expired' }, ref: null }); send(S, { topic, event: 'phx_close', payload: {}, ref: null }); }
    S.chans.clear(); S.token = '';
  }
}, 1000);

// ---------------- o "Mac" ----------------
const remoteOf = (pid) => (db.projects.find((p) => p.id === pid) || {}).repo_remote || '';
function feed(taskId, agent, kind, text) { insert('task_feed', { task_id: taskId, agent, kind, text }); }
function setTask(t, patchBody) { const old = { ...t }; Object.assign(t, patchBody); write('tasks', 'UPDATE', t, old); }
const proofMissing = (t) => { const reqs = (t.spec || {}).requirements || []; const list = ((t.requirements_proof || {}).list) || []; return reqs.filter((r) => { const p = list.find((x) => x.req === r); return !p || p.status !== 'done' || !(p.evidence || []).length; }); };
function macTick() {
  if (!macOnline) return;
  const pres = db.desktop_presence[0];
  if (Date.now() - new Date(pres.last_seen_at).getTime() > 20000) { const old = { ...pres }; pres.last_seen_at = now(); pres.online = true; write('desktop_presence', 'UPDATE', pres, old); }
  const open = pres.open_remote;
  const mineHere = (t) => (t.assignee || t.created_by) === ME && remoteOf(t.project_id) === open;
  for (const t of db.tasks.filter((x) => x.status === 'requested' && mineHere(x))) {
    setTask(t, { status: 'running', local_id: 'l-' + t.id.slice(-4) });
    feed(t.id, 'Sistema', 'note', '▶ o Mac assumiu: criando worktree e iniciando o agente…');
  }
  for (const m of db.task_messages.filter((x) => !x.delivered_at)) {
    const t = db.tasks.find((x) => x.id === m.task_id); if (!t || !mineHere(t)) continue;
    const old = { ...m }; m.delivered_at = now(); write('task_messages', 'UPDATE', m, old);
    feed(t.id, 'Você', 'note', 'Você: ' + String(m.body).replace(/^\[req\]\s*/, '').slice(0, 280));
    setTimeout(() => feed(t.id, 'coder', 'think', 'Entendido — ajustando agora: ' + String(m.body).replace(/^\[req\]\s*/, '').slice(0, 120) + '. Te aviso quando terminar.'), 1500);
  }
  for (const q of db.questions.filter((x) => x.status === 'answered')) {
    const t = db.tasks.find((x) => x.id === q.task_id); if (!t || !mineHere(t)) continue;
    const old = { ...q }; q.status = 'closed'; write('questions', 'UPDATE', q, old);
    feed(t.id, q.agent || 'coder', 'note', 'humano respondeu: ' + q.answer);
    if (q.local_pending_id < 0) { if (/^parar/i.test(q.answer)) setTask(t, { status: 'review', spec: { ...t.spec, budgetHit: null } }); else setTask(t, { status: 'running', spec: { ...t.spec, budgetHit: null, budgetUsd: 10 } }); }
  }
  for (const t of db.tasks.filter((x) => x.spec && x.spec.intent && mineHere(x))) {
    const it = t.spec.intent; let ok = true, msg = '', extra = {};
    if (it.kind === 'openPr') {
      const miss = proofMissing(t);
      if (miss.length && !String(it.noProofReason || '').trim()) { ok = false; msg = `${miss.length} requisito${miss.length > 1 ? 's' : ''} sem prova — peça a prova ao agente ou aprove sem prova com um motivo`; }
      else { extra.pr_url = 'https://github.com/acme/loja-web/pull/' + (50 + Math.floor(Math.random() * 40)); msg = 'PR aberto'; }
    } else if (it.kind === 'merge') { extra.status = 'merged'; msg = 'merge feito (squash)'; }
    else if (it.kind === 'pause') { extra.status = 'paused'; msg = 'pausada'; }
    else if (it.kind === 'resume') { extra.status = 'running'; msg = 'retomada'; }
    else if (it.kind === 'abort') { extra.status = 'aborted'; msg = 'abortada'; }
    else if (it.kind === 'askProof') { feed(t.id, 'Você', 'note', 'Você: pediu a prova de ' + proofMissing(t).length + ' requisito(s)'); msg = 'pedido de prova enviado ao agente'; }
    else if (it.kind === 'fixComment') msg = 'agente acordado pra corrigir o comentário';
    else { ok = false; msg = 'intenção desconhecida: ' + it.kind; }
    setTask(t, { ...extra, spec: { ...t.spec, ...(extra.pr_url ? { prInfo: { number: +extra.pr_url.split('/').pop(), state: 'OPEN', comments: [] } } : {}), intent: null, intentResult: { kind: it.kind, ok, msg, at: now() } } });
  }
}
setInterval(macTick, 1500);
const LINES = ['Rodando os testes do carrinho com o CEP de exemplo…', '$ npm test -- cart', 'src/cart/cupom.ts', 'Cupom inválido agora mostra "Cupom inválido ou expirado" e o checkout segue sem desconto.'];
let lineI = 0;
function step(what) {
  const t1 = db.tasks[0];
  if (what === 'feed') { const l = LINES[lineI++ % LINES.length]; feed(t1.id, 'coder', l.startsWith('$') ? 'bash' : l.startsWith('src/') ? 'edit' : 'think', l); setTask(t1, { cost_usd: +(t1.cost_usd + 0.07).toFixed(2) }); }
  if (what === 'ready') setTask(t1, { status: 'review', requirements_proof: { list: [...(t1.requirements_proof?.list || []), { req: (t1.spec.requirements || [])[1], status: 'done', evidence: ['proof-cupom.png'] }] } });
  if (what === 'error') setTask(db.tasks[4], { status: 'error' }) || setTask(db.tasks[0], { status: 'error' });
  if (what === 'question') { const q = addQuestion(t1.id, 'coder', 'Posso remover o cálculo antigo de frete do front?', ['pode remover', 'manter por enquanto']); write('questions', 'INSERT', q); }
  if (what === 'teto') { setTask(t1, { status: 'paused', spec: { ...t1.spec, budgetHit: { usd: 5.1, cap: 5, at: Date.now(), mode: 'paused' } } }); const q = addQuestion(t1.id, 'Starfork', 'A tarefa “' + t1.title + '” chegou no teto de US$ 5,00. Já gastou US$ 5,10.', ['Continuar com mais US$ 5', 'Parar aqui'], 0, -777); write('questions', 'INSERT', q); }
}

// ---------------- HTTP ----------------
function json(res, code, body, headers = {}) { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { const s = Buffer.concat(c).toString('utf8'); try { r(s ? JSON.parse(s) : null); } catch { r(s); } }); }); }
function serveFile(req, res, buf, type) {
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], buf.length - 1) : buf.length - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' }); res.end(buf);
}
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (p.startsWith('/__ctl/')) {
      const what = p.slice(7);
      if (what === 'mac') { macOnline = u.searchParams.get('online') !== '0'; const pres = db.desktop_presence[0]; const old = { ...pres }; pres.online = macOnline; if (!macOnline) pres.last_seen_at = ago(+(u.searchParams.get('ago') || 720)); else pres.last_seen_at = now(); write('desktop_presence', 'UPDATE', pres, old); }
      if (what === 'open') { const pres = db.desktop_presence[0]; const old = { ...pres }; pres.open_remote = pres.open_legacy = u.searchParams.get('remote'); pres.open_project = pres.open_remote.split('/').pop(); write('desktop_presence', 'UPDATE', pres, old); }
      if (what === 'drop') for (const S of sockets) { try { S.socket.destroy(); } catch {} sockets.delete(S); }
      if (what === 'ws') wsDown = u.searchParams.get('down') === '1';
      if (what === 'rest') restDown = u.searchParams.get('down') === '1';
      if (what === 'expire') expireBefore = tokN;
      if (what === 'step') step(u.searchParams.get('what'));
      if (what === 'reset') { seed(); wsDown = false; restDown = false; macOnline = true; }
      if (what === 'log') return json(res, 200, log.slice(-+(u.searchParams.get('n') || 60)));
      if (what === 'state') return json(res, 200, { sockets: sockets.size, chans: [...sockets].map((s) => [...s.chans.keys()]), macOnline, wsDown, restDown });
      return json(res, 200, { ok: true, what });
    }
    if (p.startsWith('/auth/v1/token')) {
      const body = await readBody(req); const gt = u.searchParams.get('grant_type');
      if (gt === 'refresh_token' && !/^mock-rt-\d+$/.test(body?.refresh_token || '')) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      log.push({ at: now(), table: 'auth', type: gt, rec: { grant: gt } });
      return json(res, 200, mint());
    }
    if (p.startsWith('/auth/v1/')) return json(res, 200, {});
    if (p.startsWith('/storage/v1/object/sign/')) {
      const path = p.replace('/storage/v1/object/sign/artifacts/', '');
      return json(res, 200, { signedURL: '/object/public/artifacts/' + path + '?token=mock' });
    }
    if (p.startsWith('/storage/v1/object/public/artifacts/')) {
      const name = p.split('/').pop(); const f = join(FIX, name);
      if (existsSync(f) && statSync(f).isFile()) return serveFile(req, res, readFileSync(f), name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.md') ? 'text/markdown' : 'image/png');
      if (name.endsWith('.md')) return serveFile(req, res, Buffer.from('# testes\n\n$ npm test\n✓ 42 passaram'), 'text/markdown; charset=utf-8');
      return serveFile(req, res, png(390, 640, [40, 160, 110]), 'image/png');
    }
    if (p.startsWith('/storage/v1/object/task-refs/')) { await readBody(req); return json(res, 200, { Key: p }); }
    if (p.startsWith('/rest/v1/')) {
      if (restDown) return json(res, 503, { message: 'serviço indisponível (simulado)' });
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!tokenOk(tok)) return json(res, 401, { code: 'PGRST301', message: 'JWT expired' });
      const table = p.slice(9);
      if (!(table in db)) return json(res, 404, { code: '42P01', message: `relation "public.${table}" does not exist` });
      if (req.method === 'GET') return json(res, 200, query(table, u.searchParams));
      const body = await readBody(req);
      if (req.method === 'POST') return json(res, 201, insert(table, body, u.searchParams.get('on_conflict')));
      if (req.method === 'PATCH') return json(res, 200, patch(table, u.searchParams, body));
      return json(res, 405, { message: 'método' });
    }
    json(res, 404, { message: 'não existe no mock: ' + p });
  } catch (e) { console.error(e); json(res, 500, { message: String(e.message || e) }); }
});
server.on('upgrade', (req, socket) => { if (req.url.startsWith('/realtime/v1/websocket')) wsAccept(req, socket); else socket.destroy(); });
seed();
server.listen(PORT, '127.0.0.1', () => console.log(`mock supabase em http://127.0.0.1:${PORT} (TTL ${TTL}s)`));
