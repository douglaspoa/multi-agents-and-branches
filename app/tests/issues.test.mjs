// Painel de Issues (14-issues-projeto.js): leitura tolerante dos campos da API e issue → tarefa.
// `node --test app/tests/` — carrega os trechos puros (@puro-issues-*, @puro-issuespec-*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/14-issues-projeto.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const I = new Function(cut('// @puro-issues-inicio', '// @puro-issues-fim') + cut('// @puro-issuespec-inicio', '// @puro-issuespec-fim')
  + '\nreturn { trkPath, trkField, trkIssueSpec };')();

test('trkPath segue o caminho com pontos e tolera nulo', () => {
  assert.equal(I.trkPath({ a: { b: { c: 3 } } }, 'a.b.c'), 3);
  assert.equal(I.trkPath({ a: null }, 'a.b'), null);
  assert.deepEqual(I.trkPath({ x: 1 }, ''), { x: 1 });
});

test('trkField: usa o caminho do conector e cai nos nomes comuns quando vem vazio', () => {
  const c = { body: 'oi', author: { name: 'Ana' }, created_at: '2026-09-01' };
  assert.equal(I.trkField(c, 'text', 'body', 'comment'), 'oi');          // conector sem fields.text: lê body
  assert.equal(I.trkField({ text: 'direto', body: 'x' }, 'text', 'body'), 'direto');
  assert.equal(I.trkField({ text: '', comment: 'c' }, 'text', 'body', 'comment'), 'c');
  assert.deepEqual(I.trkField(c, 'author'), { name: 'Ana' });
  assert.equal(I.trkField({}, 'text', 'body'), undefined);
});

test('trkIssueSpec desmonta objetivo, requisitos e metadados que o painel escreveu', () => {
  const s = I.trkIssueSpec({ title: 'Pix', description: 'Pagar com Pix.\n\nRequisitos:\n- QR dinâmico\n* webhook\n\nProjeto: loja\nResponsável: Ana', raw: { final_goal: 'pedido pago', activity_type: 'Bug' } });
  assert.equal(s.objective, 'Pagar com Pix.');
  assert.deepEqual(s.reqs, ['QR dinâmico', 'webhook']);
  assert.equal(s.goal, 'pedido pago');
  assert.equal(s.bug, true);
});
