// Painel de Issues (14-issues-projeto.js): leitura tolerante dos campos da API e issue → tarefa.
// `node --test app/tests/` — carrega os trechos puros (@puro-issues-*, @puro-issuespec-*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/14-issues-projeto.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const I = new Function(cut('// @puro-issues-inicio', '// @puro-issues-fim') + cut('// @puro-issuespec-inicio', '// @puro-issuespec-fim')
  + '\nreturn { trkPath, trkField, trkFieldPrim, trkFill, trkCommentVars, trkCmSendRun, trkCommentsLoad, trkEmptyFilterText, trkIssueSpec };')();

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

test('trkFieldPrim pula objeto (corpo ADF do Jira) em texto/data', () => {
  const adf = { type: 'doc', content: [] };
  assert.equal(I.trkFieldPrim({ body: adf, text: '' }, 'text', 'body', 'comment'), undefined);
  assert.equal(I.trkFieldPrim({ body: adf, comment: 'ok' }, 'body', 'comment'), 'ok');
  assert.equal(I.trkFieldPrim({ created_at: 5 }, 'x', 'created_at'), 5);
});

test('variáveis do comentário: body/comment só quando o template cita e o conector não tem var própria', () => {
  const op = { method: 'POST', path: '/issues/{{code}}/comments', body: { body: '{{ body }}', kind: '{{comment}}' } };
  assert.deepEqual(I.trkCommentVars(op, 'oi'), { text: 'oi', body: 'oi', comment: 'oi' });
  assert.deepEqual(I.trkCommentVars({ body: { text: '{{text}}' } }, 'oi'), { text: 'oi' });
  assert.deepEqual(I.trkCommentVars(op, 'oi', ['comment']), { text: 'oi', body: 'oi' });
  // interpolação de ponta a ponta: var própria do conector não é sobrescrita
  const ctx = Object.assign({ comment: 'tipo-nota', code: 'LOJ-1' }, I.trkCommentVars(op, 'olá', ['comment']));
  assert.deepEqual(I.trkFill(op.body, ctx), { body: 'olá', kind: 'tipo-nota' });
  assert.equal(I.trkFill(op.path, ctx), '/issues/LOJ-1/comments');
  // template antigo só com {{text}}: nada vazio vai pro corpo
  assert.deepEqual(I.trkFill({ text: '{{text}}', body: '{{body}}' }, I.trkCommentVars({ body: { text: '{{text}}' } }, 'x')), { text: 'x' });
});

test('envio de comentário: trocar de issue no meio não mistura rascunho/erro nem puxa a tela de volta', async () => {
  const st = { drafts: {}, errs: {}, sending: {} };
  let sel = 'A', fail;
  const p = I.trkCmSendRun(st, 'A', 'meu texto', () => new Promise((res, rej) => { fail = rej; }), () => sel);
  assert.equal(st.sending.A, true); assert.equal(st.drafts.A, 'meu texto');
  assert.equal(await I.trkCmSendRun(st, 'A', 'de novo', async () => {}, () => sel), 'skip'); // sem envio duplo
  sel = 'B'; fail(new Error('HTTP 500'));
  assert.equal(await p, 'fail');
  assert.equal(st.drafts.A, 'meu texto'); assert.ok(st.errs.A); assert.equal(st.drafts.B, undefined); assert.equal(st.errs.B, undefined);
  // sucesso com outra issue aberta: 'done' (não recarrega/seleciona A)
  assert.equal(await I.trkCmSendRun(st, 'A', 'meu texto', async () => {}, () => sel), 'done');
  assert.equal(st.drafts.A, undefined); assert.equal(st.errs.A, undefined);
  sel = 'A';
  assert.equal(await I.trkCmSendRun(st, 'A', 'outro', async () => {}, () => sel), 'reload');
});

test('comentários: resposta atrasada da issue A não pisa nos da B', async () => {
  let sel = 'A', resolveA; const applied = [];
  const pa = I.trkCommentsLoad('A', () => new Promise(r => { resolveA = r; }), () => sel, (l, e) => applied.push(['A', l, e]));
  sel = 'B';
  assert.equal(await I.trkCommentsLoad('B', async () => ['b1'], () => sel, (l, e) => applied.push(['B', l, e])), true);
  resolveA(['a1']);
  assert.equal(await pa, false);
  assert.deepEqual(applied, [['B', ['b1'], null]]);
  const err = await I.trkCommentsLoad('B', async () => { throw new Error('503'); }, () => sel, (l, e) => applied.push(['B', l, e && e.message]));
  assert.equal(err, true); assert.deepEqual(applied[1], ['B', [], '503']);
});

test('vazio filtrado explica busca e filtro juntos', () => {
  assert.match(I.trkEmptyFilterText('pix', 'linked').title, /“pix”.*“com tarefa”/);
  assert.match(I.trkEmptyFilterText('pix', 'all').title, /“pix”/);
  assert.match(I.trkEmptyFilterText('', 'unseen').help, /Nada mudou/);
  assert.match(I.trkEmptyFilterText('x', 'ep:LOJ-12').title, /LOJ-12/);
});
