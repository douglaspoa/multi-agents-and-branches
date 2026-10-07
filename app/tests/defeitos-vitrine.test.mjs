// Defeitos de vitrine (plateia sintética 03/10): o que fazia o produto "não parecer pronto" nos prints.
// Portão de provas visível, commits à frente da base, simulador desligado com chamada clara, varredura de textos crus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const pr = read('21-pull-request.js'), ent = read('27-entregas.js');
const G = new Function(cut(pr, '// @prova-gate-inicio', '// @prova-gate-fim') + '\nreturn { proofGateOf, proofGateLine };')();
const R = (st, ev = ['x.png']) => ({ text: 'req ' + st, st, evidence: st === 'ok' ? ev : [] });

test('portão de provas: ligado sempre que há requisitos — "2/3 com prova — aprovar exige a prova ou um motivo"', () => {
  const rows = [R('ok'), R('ok'), R('blk')];
  const l = G.proofGateLine(G.proofGateOf(rows, true, null), 3, esc);
  assert.equal(l.on, true);
  assert.equal(l.html, '<b>Portão de provas</b>: 2/3 com prova — aprovar exige a prova ou um motivo');
  assert.deepEqual(l.pill, ['falta prova', 'warn']);
  const ok = G.proofGateLine(G.proofGateOf([R('ok')], true, null), 1, esc);
  assert.match(ok.html, /1\/1 com prova — liberado pra aprovar/);
  assert.deepEqual(ok.pill, ['provas ok', 'good']);
  // feito SEM arquivo de prova não conta
  assert.match(G.proofGateLine(G.proofGateOf([R('ok', [])], true, null), 1, esc).html, /0\/1 com prova/);
  const g = G.proofGateOf([R('blk')], true, { sig: 'req blk', reason: 'cliente <aprovou>' });
  assert.match(G.proofGateLine(g, 1, esc).html, /motivo registrado: <b>cliente &lt;aprovou>/);
  assert.equal(G.proofGateLine(G.proofGateOf([], true, null), 0, esc).on, false, 'sem requisitos: nada');
  assert.equal(G.proofGateLine(G.proofGateOf(rows, false, null), 3, esc).on, true, 'carregando: continua ligado');
});

test('verificação: nunca diz que "a aprovação não fica bloqueada"; checagens do repo são extra opcional em tom neutro', () => {
  assert.ok(!/não fica bloqueada/.test(ent));
  const v = cut(ent, 'function enVerifHtml', 'function enWireVerif');
  assert.match(v, /Checagens do repositório \(opcional\)/);
  assert.match(v, /proofGateLine\(pg0/);
  assert.match(v, /if\(g\.st==='none' && gl\.pill\) pillShown=/, 'sem checagens: selo do portão, não "sem checagens"');
});

test('commits: à frente da base; alterações não commitadas ditas com todas as letras; nunca "0 commits"', () => {
  const C = new Function(cut(pr, '// @commits-rotulo-inicio', '// @commits-rotulo-fim') + '\nreturn commitsLabelOf;')();
  assert.equal(C(null, false, false), '… commits');
  assert.equal(C(3, false, false), '3 commits');
  assert.equal(C(1, true, false), '1 commit + alterações não commitadas');
  assert.equal(C(0, true, false), 'alterações não commitadas');
  assert.equal(C(0, false, false), 'nada salvo ainda');
  assert.equal(C(0, false, true), 'integrado', 'mergeada: a branch some, não é "0 commits"');
  assert.match(pr, /invoke\("task_commit_info",\{taskId\}\)/, 'o front usa o comando que conta pela worktree');
  for (const f of ['21-pull-request.js', '22-quadro-fluxo.js', '27-entregas.js']) assert.ok(!/nPl\(c\.length,'commit'\)/.test(read(f)), f);
});

test('varredura: duração desconhecida não vira "0 min"; arquivo sumido na prévia é dito em texto de gente', () => {
  const kan = read('23-kanban-artefatos-editor.js');
  const D = new Function(cut(ent, '// duração desconhecida', 'function taskDurationMs') + '\nreturn { fmtDurKnown, fmtDurMs };')();
  assert.equal(D.fmtDurKnown(0), '');
  assert.equal(D.fmtDurKnown(NaN), '');
  assert.equal(D.fmtDurKnown(3600000), '1h00');
  assert.ok(!/fmtDurMs\(taskDurationMs/.test(ent), 'toda duração de tarefa passa por fmtDurKnown');
  const P = new Function('esc', 'skeletonHtml', 'humanErr', cut(kan, 'function pvKind', '// BUG-23') + '\nreturn artPreviewHtml;')(esc, () => 'S', (e, c) => ({ msg: c + ': ' + e }));
  assert.match(P('x.png', { err: 'artefato não encontrado: x.png (ainda não foi gerado ou já foi removido)' }, 't1'), /arquivo não encontrado — ainda não foi gerado/);
  assert.match(P('x.md', { err: 'permission denied' }, 't1'), /Não consegui ler o arquivo: permission denied/);
});

test('varredura: card "pronta pra revisar" não mostra "0 arquivos" (sem diff = sem número)', () => {
  assert.ok(!/pronta pra revisar · \$\{nPl\(diffFiles/.test(ent));
  assert.match(ent, /pronta pra revisar\$\{\(n=>n>0\?' · '\+nPl\(n,'arquivo'\):''\)/);
});
