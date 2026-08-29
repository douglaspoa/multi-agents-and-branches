// E2E do backend Times no Supabase LOCAL — mesmo contrato do app (fetch puro).
const URL0 = process.env.SB_URL || 'http://127.0.0.1:54341';
const KEY = process.env.SB_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
let failures = 0;
const ok = (name, cond, extra) => { console.log((cond ? '✓' : '✗ FALHOU'), name, extra ?? ''); if (!cond) failures++; };

async function auth(path, body) {
  const r = await fetch(`${URL0}/auth/v1/${path}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
}
const api = (tok) => async (path, opts = {}) => {
  const r = await fetch(`${URL0}${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) } });
  const tx = await r.text(); let j = null; try { j = tx ? JSON.parse(tx) : null; } catch {}
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || `erro ${r.status}: ${tx.slice(0, 200)}`);
  return j;
};

const suf = Date.now().toString(36);
const alice = await auth('signup', { email: `alice-${suf}@test.dev`, password: 'senha-forte-123' });
ok('signup alice devolve sessão', !!alice.access_token);
const A = api(alice.access_token);

const orgRes = await A('/rest/v1/rpc/create_org_with_team', { method: 'POST', body: JSON.stringify({ p_org_name: 'Logcomex', p_team_name: 'Foundations' }) });
ok('create_org_with_team', !!orgRes.org_id && !!orgRes.team_id, orgRes.team_id);

const prof = await A(`/rest/v1/profiles?select=name,email&user_id=eq.${alice.user.id}`);
ok('profile auto-criado no signup', prof.length === 1 && prof[0].email.startsWith('alice'));

const inv = await A('/rest/v1/invites', { method: 'POST', body: JSON.stringify({ org_id: orgRes.org_id, team_id: orgRes.team_id, email: `bob-${suf}@test.dev`, role: 'member', created_by: alice.user.id }) });
ok('lead gera convite com token', !!inv[0].token);

const bob = await auth('signup', { email: `bob-${suf}@test.dev`, password: 'senha-forte-123' });
const B = api(bob.access_token);
const before = await B('/rest/v1/tasks?select=id');
ok('bob NÃO vê nada antes de aceitar (RLS)', before.length === 0);

const acc = await B('/rest/v1/rpc/accept_invite', { method: 'POST', body: JSON.stringify({ p_token: inv[0].token }) });
ok('accept_invite consome assento', acc.ok === true, JSON.stringify(acc));

const proj = await A('/rest/v1/projects', { method: 'POST', body: JSON.stringify({ team_id: orgRes.team_id, name: 'logcomex-ai-v2', repo_remote: 'github.com/comexio/logcomex-ai-v2' }) });
const card = await A('/rest/v1/tasks', { method: 'POST', body: JSON.stringify({ local_id: 'card-x1', project_id: proj[0].id, team_id: orgRes.team_id, created_by: alice.user.id, claim_mode: 'open', title: 'Autocomplete NCM', status: 'backlog', spec: { objective: 'autocomplete', requirements: ['limit 20'] } }) });
ok('alice compartilha tarefa (backlog)', card[0].status === 'backlog');

const seen = await B('/rest/v1/tasks?select=id,title');
ok('bob vê a tarefa do time', seen.length === 1 && seen[0].title === 'Autocomplete NCM');

const claim = await B('/rest/v1/rpc/claim_task', { method: 'POST', body: JSON.stringify({ p_task: card[0].id }) });
ok('bob assume a tarefa (claim livre)', claim.ok === true, JSON.stringify(claim));

const upd = await B(`/rest/v1/tasks?id=eq.${card[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'running', branch: 'feat/autocomplete', cost_usd: 1.23 }) });
ok('bob sincroniza o cartão (status/custo)', upd[0].status === 'running' && upd[0].version > card[0].version);

// tarefa RESERVADA: bob não pode assumir a "pra si" da alice
const res = await A('/rest/v1/tasks', { method: 'POST', body: JSON.stringify({ local_id: 'card-x2', project_id: proj[0].id, team_id: orgRes.team_id, created_by: alice.user.id, claim_mode: 'reserved', title: 'Reservada', status: 'backlog', spec: {} }) });
const steal = await B('/rest/v1/rpc/claim_task', { method: 'POST', body: JSON.stringify({ p_task: res[0].id }) });
ok('claim de tarefa "pra si" é NEGADO', steal.ok === false, steal.error);

const act = await B(`/rest/v1/task_activity?select=kind&task_id=eq.${card[0].id}`);
ok('atividade registrada (claimed)', act.some(a => a.kind === 'claimed'));

const charlie = await auth('signup', { email: `charlie-${suf}@test.dev`, password: 'senha-forte-123' });
const C = api(charlie.access_token);
const spy = await C('/rest/v1/tasks?select=id');
const spyTeams = await C('/rest/v1/teams?select=id');
ok('estranho (sem org) não vê NADA — RLS', spy.length === 0 && spyTeams.length === 0);

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} FALHA(S)`);
process.exit(failures ? 1 : 0);
