// Identidade do projeto (09-remote-id.js): nova + antiga (alias de ssh) na leitura, nova na escrita.
// `node --test app/tests/` — carrega o trecho puro (@puro-inicio … @puro-fim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/09-remote-id.js', import.meta.url), 'utf8');
const i = src.indexOf('// @puro-inicio'), j = src.indexOf('// @puro-fim');
assert.ok(i >= 0 && j > i);
const R = new Function(src.slice(i, j) + '\nreturn { remoteIdsList, remoteSame, remoteInQ, remotePick, remoteMergeRows, lsMigrateKey };')();

const ids = { remote: 'github.com/org/repo', legacy: 'github.com-work/org/repo' };
const same = { remote: 'github.com/org/repo', legacy: 'github.com/org/repo' };

test('lista sem repetidos nem vazios', () => {
  assert.deepEqual(R.remoteIdsList(ids), ['github.com/org/repo', 'github.com-work/org/repo']);
  assert.deepEqual(R.remoteIdsList(same), ['github.com/org/repo']);
  assert.deepEqual(R.remoteIdsList({ remote: 'x', legacy: '' }), ['x']);
  assert.deepEqual(R.remoteIdsList(null), []);
});

test('remoteSame aceita a forma nova e a antiga', () => {
  assert.equal(R.remoteSame('github.com/org/repo', ids), true);
  assert.equal(R.remoteSame('github.com-work/org/repo', ids), true);
  assert.equal(R.remoteSame('github.com/org/outro', ids), false);
  assert.equal(R.remoteSame('', ids), false);
  assert.equal(R.remoteSame('github.com/org/repo', { remote: '' }), false);
});

test('filtro PostgREST: eq com uma forma, in com as duas (citadas e codificadas)', () => {
  assert.equal(R.remoteInQ('repo', same), 'repo=eq.' + encodeURIComponent('github.com/org/repo'));
  const q = R.remoteInQ('repo_remote', ids);
  assert.equal(decodeURIComponent(q), 'repo_remote=in.("github.com/org/repo","github.com-work/org/repo")');
  assert.ok(!/[" ]/.test(q.slice('repo_remote=in.('.length, -1)), 'aspas codificadas');
  assert.equal(decodeURIComponent(R.remoteInQ('r', { remote: 'a"b', legacy: 'c' })), 'r=in.("a\\"b","c")');
});

test('remotePick prefere a linha da forma nova', () => {
  const rows = [{ id: 1, repo_remote: ids.legacy }, { id: 2, repo_remote: ids.remote }];
  assert.equal(R.remotePick(rows, ids, 'repo_remote').id, 2);
  assert.equal(R.remotePick([rows[0]], ids, 'repo_remote').id, 1);
  assert.equal(R.remotePick([], ids, 'repo_remote'), null);
});

test('remoteMergeRows: por slug fica a mais recente; legacyOnly = só na forma antiga', () => {
  const rows = [
    { repo: ids.legacy, slug: 'a', updated_at: '2026-09-01T00:00:00Z', body: 'velha' },
    { repo: ids.remote, slug: 'a', updated_at: '2026-09-02T00:00:00Z', body: 'nova' },
    { repo: ids.legacy, slug: 'b', updated_at: '2026-09-03T00:00:00Z', body: 'só antiga' },
    { repo: ids.remote, slug: 'c', updated_at: '2026-09-01T00:00:00Z', body: 'nova c' },
    { repo: ids.legacy, slug: 'c', updated_at: '2026-09-05T00:00:00Z', body: 'antiga c mais recente' },
  ];
  const m = R.remoteMergeRows(rows, ids, 'repo', 'slug');
  const by = Object.fromEntries(m.rows.map((r) => [r.slug, r.body]));
  assert.deepEqual(by, { a: 'nova', b: 'só antiga', c: 'antiga c mais recente' });
  assert.deepEqual(m.legacyOnly, ['b']);
  // sem forma antiga: nada a migrar
  assert.deepEqual(R.remoteMergeRows([{ repo: same.remote, slug: 'x', updated_at: '' }], same, 'repo', 'slug').legacyOnly, []);
});

test('lsMigrateKey copia uma vez e nunca sobrescreve', () => {
  const ls = { old: '["a"]' }; const get = (k) => (k in ls ? ls[k] : null); const set = (k, v) => { ls[k] = v; };
  assert.equal(R.lsMigrateKey('old', 'new', get, set), true);
  assert.equal(ls.new, '["a"]');
  ls.old = '["b"]';
  assert.equal(R.lsMigrateKey('old', 'new', get, set), false);
  assert.equal(ls.new, '["a"]');
  assert.equal(R.lsMigrateKey('x', 'x', get, set), false);
  assert.equal(R.lsMigrateKey('nada', 'novo', get, set), false);
  assert.ok(!('novo' in ls));
});
