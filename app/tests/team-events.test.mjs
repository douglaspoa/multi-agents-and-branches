// Avisos do time (team_events, migration 0033): o "padrão do time desligado" do PR #170 passa a aparecer pra TODO
// o time. `node --test app/tests/team-events.test.mjs` — recorta o código real, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const root = (p) => new URL('../../' + p, import.meta.url);
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const SEM = read('76-casca-semana.js'), NUV = read('42-nuvem-sync-mobile.js'), CONTA = read('40-nuvem-conta.js');
const S = new Function(cut(SEM, '// @semana-puro-inicio', '// @semana-puro-fim')
  + '\nreturn { semPadraoVale, semPadraoCorpo, semPadraoDoTime, semPadraoMaisNovo, SEM_PADRAO_ABRIR };')();
const C = new Function(cut(CONTA, '// @cloud-puro-inicio', '// @cloud-puro-fim') + '\nreturn { cloudTabelaFalta };')();

const NOW = Date.UTC(2026, 9, 14, 13);
const H = 3600e3, D = 86400e3;
const ev = (uid, padrao, ms, extra) => ({ id: uid + ms, team_id: 't1', user_id: uid, kind: 'padrao-desligado', created_at: new Date(NOW - ms).toISOString(), body: { padrao, onde: 'loja', abrir: 'skills', ...(extra || {}) } });

test('aviso do time: o mais novo de qualquer membro nos últimos 7 dias, com uid (o nome sai de personName)', () => {
  const rows = [ev('ana', 'a skill revisar-pr', 5 * H), ev('bruno', 'o agente Revisor', 1 * H), ev('carla', 'a skill antiga', 8 * D)];
  const a = S.semPadraoDoTime(rows, NOW);
  assert.equal(a.uid, 'bruno'); assert.equal(a.padrao, 'o agente Revisor'); assert.equal(a.onde, 'loja'); assert.equal(a.abrir, 'skills');
  assert.equal(a.at, NOW - H);
  assert.equal(S.semPadraoDoTime([ev('carla', 'velho', 8 * D)], NOW), null, 'passou de 7 dias');
  assert.equal(S.semPadraoDoTime([{ ...ev('ana', 'x', H), kind: 'outro' }], NOW), null, 'só o tipo do aviso');
  assert.equal(S.semPadraoDoTime([{ ...ev('ana', '', H) }], NOW), null, 'sem padrão não vale');
  assert.equal(S.semPadraoDoTime(null, NOW), null);
  assert.ok(!('quem' in a) && !JSON.stringify(a).includes('"quem"'), 'nunca nome guardado no corpo: resolve na hora');
});

test('corpo saneado: "abrir" só skills/agentes (vem de outra pessoa), textos curtos e numa linha', () => {
  assert.deepEqual(S.SEM_PADRAO_ABRIR, ['skills', 'agentes']);
  assert.equal(S.semPadraoCorpo({ padrao: 'a skill X', abrir: 'ajustes' }).abrir, undefined);
  assert.equal(S.semPadraoCorpo({ padrao: 'a skill X', abrir: 'agentes' }).abrir, 'agentes');
  const c = S.semPadraoCorpo({ padrao: 'a  skill\n' + 'x'.repeat(400), onde: 'y'.repeat(200), quem: 'Ana', at: 1 });
  assert.ok(c.padrao.length <= 160 && !c.padrao.includes('\n')); assert.equal(c.onde.length, 80);
  assert.ok(!('quem' in c) && !('at' in c), 'quem/hora vêm do banco (user_id/created_at), não do corpo');
});

test('local × time: o mais novo ganha; vencido não conta', () => {
  const loc = { quem: 'Você', padrao: 'a skill A', at: NOW - 2 * H };
  const tim = { uid: 'ana', quem: 'Ana Souza', padrao: 'a skill B', at: NOW - H };
  assert.equal(S.semPadraoMaisNovo(loc, tim, NOW).padrao, 'a skill B');
  assert.equal(S.semPadraoMaisNovo({ ...loc, at: NOW }, tim, NOW).padrao, 'a skill A');
  assert.equal(S.semPadraoMaisNovo(null, tim, NOW).padrao, 'a skill B');
  assert.equal(S.semPadraoMaisNovo({ ...loc, at: NOW - 9 * D }, null, NOW), null);
  assert.equal(S.semPadraoMaisNovo(null, null, NOW), null);
});

test('tabela que não existe na nuvem (migration não aplicada) é reconhecida; outros erros não', () => {
  for (const m of ["Could not find the table 'public.team_events' in the schema cache", 'PGRST205', 'relation "team_events" does not exist', '42P01', 'erro 404'])
    assert.equal(C.cloudTabelaFalta(new Error(m)), true, m);
  for (const m of ['Sem conexão com a nuvem agora', 'new row violates row-level security policy', 'erro 500', 'erro 4040'])
    assert.equal(C.cloudTabelaFalta(new Error(m)), false, m);
});

// o bloco real de 42 com a nuvem falsa
function nuvem({ falta = false, falhaPost = false } = {}) {
  const calls = { get: 0, post: [] };
  const src = cut(NUV, '// ---- avisos do time (team_events', 'let teamFetchP=null;');
  const env = {
    sbGet: async (q) => { calls.get++; calls.lastQ = q; if (falta) throw new Error("Could not find the table 'public.team_events' in the schema cache"); return [ev('ana', 'a skill X', H)]; },
    sbPost: async (t, b) => { calls.post.push([t, b]); if (falta) throw new Error('erro 404'); if (falhaPost) throw new Error('Sem conexão com a nuvem agora'); return [{ id: 'e9', team_id: b.team_id, user_id: 'me', kind: b.kind, body: b.body, created_at: new Date().toISOString() }]; },
    cloudTeamId: () => 't1', SB: { sess: () => ({ user: { id: 'me' } }) }, cloudTabelaFalta: C.cloudTabelaFalta,
  };
  const N = new Function(...Object.keys(env), src + '\nreturn { teamEventsGet, teamEventPost, teamEventsQuery, get off(){ return teamEventsOff; }, get rows(){ return teamEvents; } };')(...Object.values(env));
  return { N, calls };
}

test('lê só o time ativo e os últimos 7 dias, do mais novo pro mais velho', async () => {
  const { N, calls } = nuvem();
  const r = await N.teamEventsGet('t1');
  assert.equal(r.length, 1);
  assert.match(calls.lastQ, /^team_events\?select=id,team_id,user_id,kind,body,created_at&team_id=eq\.t1&created_at=gte\./);
  assert.match(calls.lastQ, /order=created_at\.desc&limit=20$/);
  const q = N.teamEventsQuery('t1', NOW);
  assert.ok(q.includes('gte.' + new Date(NOW - 7 * D).toISOString()));
  assert.equal(await N.teamEventsGet(''), null, 'sem time não pede');
});

test('nuvem SEM a 0033: falha UMA vez, desliga e não pede mais (nem lê nem grava) — sem lançar', async () => {
  const { N, calls } = nuvem({ falta: true });
  assert.equal(await N.teamEventsGet('t1'), null);
  assert.equal(N.off, true);
  for (let i = 0; i < 5; i++) await N.teamEventsGet('t1');
  assert.equal(calls.get, 1, 'não tenta de novo a cada tick');
  assert.equal(await N.teamEventPost('padrao-desligado', { padrao: 'x' }), false);
  assert.equal(calls.post.length, 0);
});

test('gravar: no time ativo, entra na lista local na hora; erro de rede não desliga nem lança', async () => {
  const { N, calls } = nuvem();
  assert.equal(await N.teamEventPost('padrao-desligado', { padrao: 'a skill X', onde: 'loja', abrir: 'skills' }), true);
  assert.deepEqual(calls.post[0], ['team_events', { team_id: 't1', kind: 'padrao-desligado', body: { padrao: 'a skill X', onde: 'loja', abrir: 'skills' } }]);
  assert.ok(!('user_id' in calls.post[0][1]), 'user_id é o default auth.uid() do banco');
  assert.equal(N.rows[0].id, 'e9');
  const f = nuvem({ falhaPost: true });
  assert.equal(await f.N.teamEventPost('padrao-desligado', { padrao: 'x' }), false);
  assert.equal(f.N.off, false, 'falha de rede não é "tabela falta"');
});

test('fiação: teamFetch lê os eventos e busca o perfil de quem desligou; a Semana posta e pinta o nome', () => {
  assert.match(NUV, /teamEventsGet\(teamId\), \/\/ avisos do time/);
  assert.match(NUV, /\(evs\|\|\[\]\)\.forEach\(a=>\{ if\(a&&a\.user_id\) uids\.add\(a\.user_id\); \}\)/);
  assert.match(NUV, /if\(evs\) teamEvents=evs; else if\(teamEventsOff\) teamEvents=\[\];/);
  assert.match(SEM, /teamEventPost\('padrao-desligado', semPadraoCorpo\(d\)\)/);
  assert.match(SEM, /quem:personCap\(personName\(t\.uid, \{ noYou:false \}\)\)/);
  assert.match(SEM, /r&&r\.team_id===tid/, 'só o time ativo');
  assert.match(SEM, /semIr\(SEM_PADRAO_ABRIR\.includes\(a\)\?a:'skills'\)/);
  assert.match(read('40-conta-escopo.js'), /teamEvents=\[\]; teamEventsOff=false;/, 'troca de conta zera');
});

test('migration 0033: tabela, índice, RLS de membro (insert em nome próprio), sem update, retenção, registrada na aba Banco', () => {
  const sql = readFileSync(root('supabase/migrations/0033_team_events.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.match(code, /create table if not exists team_events \(/);
  assert.match(code, /team_id\s+uuid not null references teams\(id\) on delete cascade/);
  assert.match(code, /user_id\s+uuid not null default auth\.uid\(\) references auth\.users\(id\)/);
  assert.match(code, /created_at timestamptz not null default now\(\)/);
  assert.match(code, /check \(kind in \('padrao-desligado'\)\)/);
  assert.match(code, /pg_column_size\(body\) <= 2048/);
  assert.match(code, /create index if not exists team_events_team_at on team_events \(team_id, created_at desc\)/);
  assert.match(code, /alter table team_events enable row level security/);
  for (const p of ['select', 'insert', 'update', 'delete']) assert.match(code, new RegExp('drop policy if exists team_events_' + p + ' on team_events'));
  assert.match(code, /team_events_select on team_events for select\s+using \(can_see_team\(team_id\) and created_at > now\(\) - interval '14 days'\)/);
  assert.match(code, /team_events_insert on team_events for insert\s+with check \(user_id = auth\.uid\(\) and is_team_member\(team_id\)/);
  assert.doesNotMatch(code, /create policy \w+ on team_events for (update|all)/, 'evento não se edita');
  assert.match(code, /for delete\s+using \(user_id = auth\.uid\(\) or is_team_lead\(team_id\) or is_org_admin\(org_of_team\(team_id\)\)\)/);
  assert.match(code, /grant select, insert, delete on team_events to authenticated/);
  assert.doesNotMatch(code, /join team_members/i, 'sem a armadilha das 0010/0022/0023');
  assert.doesNotMatch(code, /drop table|truncate|delete from/i);
  assert.doesNotMatch(code, /create table (?!if not exists)|create index (?!if not exists)|create policy (\w+)[\s\S]*?create policy \1\b/i, 'idempotente');
  const reg = readFileSync(root('supabase/functions/admin-api/migrations.ts'), 'utf8');
  const m = reg.match(/\{ name: "0033_team_events\.sql", sql: ("(?:[^"\\]|\\.)*") \}/);
  assert.ok(m, 'registrada'); assert.equal(JSON.parse(m[1]), sql, 'mesmo conteúdo do arquivo');
  assert.ok(reg.indexOf('0032_time_responsavel.sql') < reg.indexOf('0033_team_events.sql'), 'na ordem');
});
