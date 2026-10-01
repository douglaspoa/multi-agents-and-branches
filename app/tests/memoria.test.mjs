// Testes da aba Memória sem browser: `node --test app/tests/`
// Carrega o trecho puro de 37-memoria.js (@puro-inicio … @puro-fim) + mdToHtml do editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mem = readFileSync(new URL('../src/js/37-memoria.js', import.meta.url), 'utf8');
const ed = readFileSync(new URL('../src/js/23-kanban-artefatos-editor.js', import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return src.slice(i, j); };
const pure = cut(mem, '// @puro-inicio', '// @puro-fim');
const md = cut(ed, 'function mdSafeHref', '// BUG-12');
const M = new Function(md + '\n' + pure + '\nreturn { mdToHtml, memSlug, memSerialize, memFromFile, memResolve, memLinkify, memBacklinks, memFilter, memForceLayout, memForceIters, memSyncPlan };')();

const notes = [
  { slug: 'usar-pnpm', scope: 'time', title: 'Usar pnpm, nunca npm', type: 'regra', tags: ['ferramentas'], links: ['ferramentas', 'ci'], body: 'Ver [[ferramentas]] e [[ci]].' },
  { slug: 'ferramentas', scope: 'local', title: 'Ferramentas', type: 'contexto', tags: [], links: [], body: 'pnpm, vitest' },
  { slug: 'checkout', scope: 'local', title: 'Checkout único', type: 'decisão', tags: ['pagamento'], links: ['usar-pnpm'], body: 'Um passo só. [[Usar pnpm, nunca npm|pnpm]]' },
];

test('slug igual ao do motor (sem acento, hífens)', () => {
  assert.equal(M.memSlug('Decisão de Arquitetura!'), 'decisao-de-arquitetura');
});

test('serialize bate com o formato do src/memory.ts (frontmatter + corpo)', () => {
  const s = M.memSerialize({ title: 'API: timeout', type: 'gotcha', tags: ['ci'], updated: '2026-09-28', by: 'Ana', origem: 'pessoa', body: 'x' });
  assert.equal(s, '---\ntitle: "API: timeout"\ntype: gotcha\ntags: [ci]\nupdated: 2026-09-28\nby: Ana\norigem: pessoa\n---\nx\n');
});

test('[[links]] viram links internos; quebrado vira "criar esta nota"', () => {
  const h = M.memLinkify(M.mdToHtml('Ver [[ferramentas]], [[Usar pnpm, nunca npm|pnpm]] e [[nao-existe]].'), notes, 'local');
  assert.match(h, /<a class="memlink" data-mscope="local" data-mslug="ferramentas">ferramentas<\/a>/);
  assert.match(h, /data-mscope="time" data-mslug="usar-pnpm">pnpm<\/a>/);
  assert.match(h, /class="memlink broken" data-mcreate="nao-existe"/);
});

test('link com aspas/HTML não injeta atributo nem tag', () => {
  const h = M.memLinkify(M.mdToHtml('[[x" onmouseover="alert(1)]] [[<img src=x>]]'), notes, 'local');
  assert.ok(!/onmouseover="alert/.test(h), h);
  assert.ok(!h.includes('<img'), h);
});

test('backlinks: quem cita a nota', () => {
  const b = M.memBacklinks(notes, notes[0]).map((n) => n.slug);
  assert.deepEqual(b, ['checkout']);
  assert.deepEqual(M.memBacklinks(notes, notes[1]).map((n) => n.slug), ['usar-pnpm']);
});

test('busca por termos (sem acento) e filtro por tipo', () => {
  assert.deepEqual(M.memFilter(notes, 'unico', '').map((n) => n.slug), ['checkout']);
  assert.deepEqual(M.memFilter(notes, '', 'regra').map((n) => n.slug), ['usar-pnpm']);
  assert.deepEqual(M.memFilter(notes, 'pnpm vitest', '').map((n) => n.slug), ['ferramentas']);
});

test('layout do grafo: posições dentro da tela e ligados mais perto que soltos', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i }));
  const edges = [{ from: 'n0', to: 'n1' }];
  const p = M.memForceLayout(nodes, edges, 600, 400);
  assert.equal(p.length, 12);
  for (const q of p) assert.ok(q.x >= 20 && q.x <= 580 && q.y >= 20 && q.y <= 380, JSON.stringify(q));
  const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
  assert.ok(d(0, 1) < d(0, 7), 'aresta aproxima');
});

test('slug com escrita não latina bate com o motor (nota-<hash>)', () => {
  const gold = JSON.parse(readFileSync(new URL('../../tests/fixtures/memoria-golden/slugs.json', import.meta.url), 'utf8'));
  for (const [i, o] of gold) assert.equal(M.memSlug(i), o, i);
});

test('editor: chaves do Obsidian (aliases, cssclasses) sobrevivem a abrir e salvar', () => {
  const src = '---\ntitle: Deploy\ntype: regra\ntags: [ci]\nupdated: 2026-09-01\nby: Ana\norigem: pessoa\naliases: [publicar, subir]\ncssclasses: wide\n---\nDeploy pelo CI.\n';
  const f = M.memFromFile(src);
  assert.equal(f.title, 'Deploy'); assert.equal(f.type, 'regra'); assert.equal(f.by, 'Ana');
  assert.deepEqual(f.extra, { aliases: ['publicar', 'subir'], cssclasses: 'wide' });
  const out = M.memSerialize({ ...f, body: 'Deploy pelo CI, com aprovação.', atualizadaPor: 'Bruno' });
  assert.match(out, /\naliases: \[publicar, subir\]\n/);
  assert.match(out, /\ncssclasses: wide\n/);
  assert.match(out, /\natualizada_por: Bruno\n/);
  assert.deepEqual(M.memFromFile(out).extra, f.extra);
});

test('grafo: iterações caem com N (N²·iters limitado)', () => {
  assert.equal(M.memForceIters(10), 260);
  assert.ok(M.memForceIters(2000) * 2000 * 2000 <= 3e6 * 20, 'teto');
  assert.ok(M.memForceIters(2000) >= 12);
});

// ---- sync do cérebro do time: decisão nota a nota ----
const T = (s) => Date.parse(s);
const plan = (local, rows, known = [], lastSync = 0) => M.memSyncPlan(local, rows, new Set(known), local.length === 0, lastSync);

test('sync: nova do colega é puxada; nota minha nova sobe; iguais ficam', () => {
  const p = plan(
    [{ slug: 'minha', mtimeMs: T('2026-09-28T10:00:00Z'), body: 'a' }, { slug: 'igual', mtimeMs: T('2026-09-28T10:00:00Z'), body: 'x' }],
    [{ slug: 'dele', body: 'b', updated_at: '2026-09-28T09:00:00Z' }, { slug: 'igual', body: 'x', updated_at: '2026-09-28T10:00:01Z' }],
    ['igual']);
  assert.deepEqual(p.pull, ['dele']); assert.deepEqual(p.push, ['minha']); assert.deepEqual(p.keep, ['igual']);
});

test('sync: mais recente vence nos dois sentidos', () => {
  const p = plan(
    [{ slug: 'a', mtimeMs: T('2026-09-28T12:00:00Z'), body: '1' }, { slug: 'b', mtimeMs: T('2026-09-28T08:00:00Z'), body: '1' }],
    [{ slug: 'a', body: '0', updated_at: '2026-09-28T10:00:00Z' }, { slug: 'b', body: '2', updated_at: '2026-09-28T10:00:00Z' }],
    ['a', 'b']);
  assert.deepEqual(p.push, ['a']); assert.deepEqual(p.pull, ['b']);
});

test('sync: espelho local vazio com "known" cheio = 1º sync (só puxa, nunca apaga)', () => {
  const p = plan([], [{ slug: 'a', body: '1', updated_at: '2026-09-01T00:00:00Z' }, { slug: 'b', body: '2', updated_at: '2026-09-01T00:00:00Z', deleted_at: '2026-09-02T00:00:00Z' }], ['a', 'b'], T('2026-09-10T00:00:00Z'));
  assert.deepEqual(p.pull, ['a']); assert.deepEqual(p.tombstoneCloud, []); assert.deepEqual(p.delLocal, []);
});

test('sync: apagada aqui (fora do app) vira lápide; editada pelo colega DEPOIS do último sync é puxada', () => {
  const local = [{ slug: 'fica', mtimeMs: T('2026-09-01T00:00:00Z'), body: 'f' }];
  const p = plan(local, [
    { slug: 'fica', body: 'f', updated_at: '2026-09-01T00:00:00Z' },
    { slug: 'sumiu', body: 's', updated_at: '2026-09-05T00:00:00Z' },
    { slug: 'editada', body: 'e2', updated_at: '2026-09-20T00:00:00Z' },
  ], ['fica', 'sumiu', 'editada'], T('2026-09-10T00:00:00Z'));
  assert.deepEqual(p.tombstoneCloud, ['sumiu']); assert.deepEqual(p.pull, ['editada']);
});

test('sync: lápide × edição — a mais nova vence', () => {
  const p = plan(
    [{ slug: 'revive', mtimeMs: T('2026-09-20T00:00:00Z'), body: 'r' }, { slug: 'morre', mtimeMs: T('2026-09-01T00:00:00Z'), body: 'm' }],
    [{ slug: 'revive', body: 'r', updated_at: '2026-09-10T00:00:00Z', deleted_at: '2026-09-10T00:00:00Z' },
     { slug: 'morre', body: 'm', updated_at: '2026-09-10T00:00:00Z', deleted_at: '2026-09-10T00:00:00Z' },
     { slug: 'ja-foi', body: 'x', updated_at: '2026-09-10T00:00:00Z', deleted_at: '2026-09-10T00:00:00Z' }],
    ['revive', 'morre']);
  assert.deepEqual(p.push, ['revive']); assert.deepEqual(p.delLocal, ['morre']); assert.deepEqual(p.pull, []);
});

test('sync: mesmo nome, notas diferentes, nunca sincronizada = renomeia a minha (não sobrescreve a do colega)', () => {
  const p = plan([{ slug: 'deploy', mtimeMs: T('2026-09-28T12:00:00Z'), body: 'minha versão' }], [{ slug: 'deploy', body: 'a do colega', updated_at: '2026-09-28T10:00:00Z' }], []);
  assert.deepEqual(p.rename, ['deploy']); assert.deepEqual(p.push, []);
});
