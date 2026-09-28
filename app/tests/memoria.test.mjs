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
const M = new Function(md + '\n' + pure + '\nreturn { mdToHtml, memSlug, memSerialize, memResolve, memLinkify, memBacklinks, memFilter, memForceLayout };')();

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
