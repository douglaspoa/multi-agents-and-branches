// Estado REAL do PR (86-pr-real + pr_real.rs) — 28/10: tarefa integrada no GitHub continuava em "Precisa de mim" pedindo Aprovar.
// `node --test app/tests/pr-real.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/86-pr-real.js'), AP = read('js/80-aprovar.js'), SEM = read('js/76-casca-semana.js'), MENU = read('js/22-quadro-fluxo.js'), HTML = read('index.html');
const P = new Function(cut(JS, '// @prr-puro-inicio', '// @prr-puro-fim') + '\nreturn { prrCandidata, prrDevida, prrDecide, prrFrase, PRR_ESPERA };')();

test('candidatas: só em revisão / PR aberto — nunca rascunho, rodando ou encerrada', () => {
  assert.equal(P.prrCandidata({ status: 'review' }), true, 'a tarefa do relato: review, sem prUrl');
  assert.equal(P.prrCandidata({ status: 'running', prUrl: 'https://github.com/loja/web/pull/3' }), true, 'PR aberto');
  assert.equal(P.prrCandidata({ status: 'running' }), false);
  assert.equal(P.prrCandidata({ status: 'draft' }), false);
  for (const st of ['merged', 'done', 'cancelled']) assert.equal(P.prrCandidata({ status: st, prUrl: 'x' }), false, st);
  assert.equal(P.prrCandidata({ status: 'review', flag: 'closed' }), false);
});

test('frequência: 3 min com resposta, 5 min depois de erro; foco/aba no máximo a cada 30 s', () => {
  const E = P.PRR_ESPERA, now = 10_000_000;
  assert.equal(P.prrDevida(null, now), true, 'nunca conferida');
  assert.equal(P.prrDevida({ at: now - E.vivo + 1000, state: 'NONE' }, now), false);
  assert.equal(P.prrDevida({ at: now - E.vivo, state: 'OPEN' }, now), true);
  assert.equal(P.prrDevida({ at: now - E.vivo, state: 'UNKNOWN', errKind: 'access' }, now), false, 'erro recua mais');
  assert.equal(P.prrDevida({ at: now - E.erro, state: 'UNKNOWN', errKind: 'access' }, now), true);
  assert.equal(P.prrDevida({ at: now - 10_000, state: 'OPEN' }, now, true), false, 'trocar de aba não martela o gh');
  assert.equal(P.prrDevida({ at: now - 31_000, state: 'OPEN' }, now, true), true);
});

test('decisão: MERGED / CLOSED / OPEN / sem PR / erro de acesso / squash pelo git', () => {
  assert.deepEqual(P.prrDecide({ source: 'gh', state: 'MERGED', number: 12 }), { kind: 'merged', pr: 12, via: 'gh', why: '' });
  const sq = P.prrDecide({ source: 'git', state: 'MERGED', reason: 'o conteúdo da branch já está na main (squash)' });
  assert.equal(sq.kind, 'merged'); assert.equal(sq.via, 'git'); assert.match(sq.why, /squash/);
  assert.deepEqual(P.prrDecide({ source: 'gh', state: 'CLOSED', number: 4 }), { kind: 'closed', pr: 4 });
  assert.deepEqual(P.prrDecide({ source: 'gh', state: 'OPEN', number: 9 }), { kind: 'open', pr: 9 });
  assert.equal(P.prrDecide({ source: 'gh', state: 'NONE' }).kind, 'none');
  assert.equal(P.prrDecide(null).kind, 'none');
  const u = P.prrDecide({ source: 'none', state: 'UNKNOWN', errKind: 'access', reason: 'nenhuma conta do GitHub logada no gh enxerga loja/web · pelo git, a branch ainda não está na main' });
  assert.equal(u.kind, 'unknown');
  assert.match(u.aviso, /^não consegui conferir o PR no GitHub \(nenhuma conta .* loja\/web/);
  assert.match(P.prrDecide({ state: 'UNKNOWN' }).aviso, /motivo desconhecido/);
});

test('frases: PR aberto por fora → "falta integrar"; fechado → "fechado sem integrar"', () => {
  const tt = '<span class="tt">Cupom no checkout</span>';
  assert.equal(P.prrFrase({ kind: 'open', pr: 12 }, tt), 'PR #12 de <span class="tt">Cupom no checkout</span> aberto — falta integrar.');
  assert.match(P.prrFrase({ kind: 'closed', pr: 4 }, tt), /PR #4 .* <b>fechado sem integrar<\/b>/);
  assert.equal(P.prrFrase({ kind: 'merged', pr: 1 }, tt), null);
  assert.equal(P.prrFrase(null, tt), null);
});

test('ligações: Aprovar some quando o PR foi integrado/fechado; Integrar no lugar de Aprovar com PR aberto; Já integrei em 2 lugares', () => {
  assert.match(AP, /prrVis\(t\.id\)\.kind; if\(k==='merged'\|\|k==='closed'\) return false;/, 'apAprovavel lê o estado real');
  assert.match(AP, /l:prAberto\?'Integrar':'Aprovar'/, 'PR aberto: o botão integra');
  assert.match(AP, /if\(!t\.prUrl && typeof prrConferir==='function'\)/, 'Aprovar confere no GitHub antes de abrir outro PR');
  assert.match(AP, /prrJaIntegrei\(id, b\)/, '"Já integrei" no Precisa de mim');
  assert.match(AP, /prrAvisoHtml\(v\.id\)/, 'aviso discreto no painel de provas (fila, Central, Meu trabalho, Revisão da tarefa)');
  assert.match(SEM, /prrEventoFechado\(x, meta\(x, x\.mod\)\)/, 'PR fechado tem frase própria no Precisa de mim');
  assert.match(MENU, /já integrei · colar link do PR…/, '"Já integrei" no menu ⋯');
  const i80 = HTML.indexOf('js/80-aprovar.js'), i86 = HTML.indexOf('js/86-pr-real.js'), i99 = HTML.indexOf('js/99-e2e.js');
  assert.ok(i80 > 0 && i86 > i80 && i99 > i86, 'carrega depois do 80 e antes do 99');
  assert.doesNotMatch(JS, /invoke\(['"]gh_switch_account/, 'nunca troca a conta ativa');
  assert.match(JS, /tickLoop\('prrTick'.*\{ local:true \}\)/, 'roda também no plano Grátis (local)');
  assert.match(JS, /addEventListener\('focus'/, 'confere ao focar a janela');
});
