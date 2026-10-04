// Testes da Mesa de personas sem browser: carrega o trecho puro de 38-mesa.js (@puro-inicio … @puro-fim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/38-mesa.js', import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const pure = cut(src, '// @puro-inicio', '// @puro-fim');
const M = new Function(pure + '\nreturn { MESA_PERSONAS, MESA_MODEL, mesaParseJson, mesaParsePersonas, mesaParsePosition, mesaCandidates, mesaParseVote, mesaTally, mesaDecision, mesaCost, mesaCapHit, mesaCapUsdOf, mesaPersonaMerge, mesaDiff, mesaJustify, mesaNoteBody, mesaR1Prompt, mesaR2Prompt, mesaArgPrompt, mesaAskPrompt, mesaVotesOf, mesaVoteOutcome, mesaNextStep, mesaRoundMissing };')();
const planner = readFileSync(new URL('../src/js/32-planner.js', import.meta.url), 'utf8');
const plOriginSuffix = new Function(cut(planner, 'function plOriginSuffix', '\n}') + '\n}\nreturn plOriginSuffix;')();

const cands = ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) => ({ id: 'F' + (i + 1), titulo: 'Feature ' + t, descricao: 'desc ' + t, autores: ['Bia'] }));
const ids = cands.map((c) => c.id);
const P = [{ id: 'bia', nome: 'Bia', papel: 'vibe coder' }, { id: 'rafa', nome: 'Rafa', papel: 'tech lead' }, { id: 'julia', nome: 'Júlia', papel: 'a cética' }];
const vote = (top, vetos = []) => M.mesaParseVote(JSON.stringify({ fala: 'x', top5: top.map(([id, peso]) => ({ id, peso, porque: 'pq ' + id })), vetos }), ids).vote;

test('personas: editor único (padrão + ajuste deste computador + criadas aqui + geradas pro projeto), ids fixos', () => {
  const L = M.mesaPersonaMerge(M.MESA_PERSONAS, { julia: { nome: 'Ju', papel: 'cética', desc: 'x', ativa: false } }, [{ id: 'c-1', nome: 'Nova', papel: '', desc: '' }], [{ id: 'g-a', nome: 'Analista', papel: 'gerada', desc: 'y' }, { id: 'bia', nome: 'Bia 2' }]);
  assert.deepEqual(L.map((p) => p.id), ['bia', 'rafa', 'carla', 'marcos', 'julia', 'c-1', 'g-a'], 'id repetido não duplica; a ordem é padrão → criadas → geradas');
  const j = L.find((p) => p.id === 'julia');
  assert.equal(j.nome, 'Ju'); assert.equal(j.ativa, false); assert.equal(j.origem, 'padrao');
  assert.equal(L.find((p) => p.id === 'g-a').origem, 'gerada');
  assert.equal(L.find((p) => p.id === 'c-1').ativa, true, 'nova persona entra ativa');
});

test('personas padrão: as 5 da rodada 2 e Sonnet', () => {
  assert.deepEqual(M.MESA_PERSONAS.map((p) => p.nome), ['Bia', 'Rafa', 'Carla', 'Marcos', 'Júlia']);
  assert.equal(M.MESA_MODEL, 'claude-sonnet-5');
});

test('parse de voto: JSON válido', () => {
  const r = M.mesaParseVote('{"fala":"oi","top5":[{"id":"F1","peso":5},{"id":"F2","peso":4}],"vetos":[{"id":"F3","motivo":"caro"}]}', ids);
  assert.equal(r.ok, true);
  assert.deepEqual(r.vote.top.map((t) => [t.id, t.peso]), [['F1', 5], ['F2', 4]]);
  assert.deepEqual(r.vote.vetos, [{ id: 'F3', motivo: 'caro' }]);
  assert.equal(r.warns.length, 0);
});

test('parse de voto: JSON cercado de texto e em bloco ```json', () => {
  const a = M.mesaParseVote('Pensei bastante.\n```json\n{"top5":[{"id":"f2","peso":5},{"id":3,"peso":4}]}\n```\nÉ isso.', ids);
  assert.equal(a.ok, true);
  assert.deepEqual(a.vote.top.map((t) => t.id), ['F2', 'F3']);
  const b = M.mesaParseVote('Meu voto: {"top5":[{"id":"F4","peso":2}],"vetos":["modo simples global"]} fim', ids);
  assert.equal(b.ok, true);
  assert.deepEqual(b.vote.vetos, [{ texto: 'modo simples global', motivo: '' }]);
});

test('parse de voto: inválido é descartado; itens ruins caem com aviso', () => {
  assert.equal(M.mesaParseVote('não sei votar', ids).ok, false);
  assert.equal(M.mesaParseVote('{"top5":"F1"}', ids).ok, false);
  assert.equal(M.mesaParseVote('{"top5":[{"id":"F99","peso":5}]}', ids).ok, false);
  const r = M.mesaParseVote('{"top5":[{"id":"F1","peso":5},{"id":"F2","peso":5},{"id":"F1","peso":4},{"id":"F3","peso":9},{"id":"F4","peso":3}],"vetos":[{"id":"F1","motivo":"?"}]}', ids);
  assert.equal(r.ok, true);
  assert.deepEqual(r.vote.top.map((t) => t.id), ['F1', 'F4']);
  assert.equal(r.vote.vetos.length, 0, 'não veta o que votou');
  assert.ok(r.warns.length >= 4, r.warns.join(' | '));
});

test('tally: soma dos pesos, veto, votada por todos', () => {
  const votes = { bia: vote([['F1', 5], ['F2', 4], ['F3', 1]]), rafa: vote([['F2', 5], ['F1', 3], ['F3', 2]], [{ id: 'F4', motivo: 'arriscado' }]), julia: vote([['F1', 4], ['F3', 3]], [{ texto: 'nada de segunda UI', motivo: 'confunde' }]) };
  const t = M.mesaTally(cands, votes, P);
  const by = Object.fromEntries(t.rows.map((r) => [r.id, r]));
  assert.equal(by.F1.total, 12);
  assert.equal(by.F2.total, 9);
  assert.equal(by.F3.total, 6);
  assert.deepEqual(by.F1.pesos, { bia: 5, rafa: 3, julia: 4 });
  assert.equal(by.F1.todos, true);
  assert.equal(by.F3.todos, true);
  assert.equal(by.F2.todos, false);
  assert.deepEqual(by.F4.vetadoPor, ['rafa']);
  assert.deepEqual(t.rows.slice(0, 3).map((r) => r.id), ['F1', 'F2', 'F3']);
  assert.deepEqual(t.vetosLivres, [{ pid: 'julia', texto: 'nada de segunda UI', motivo: 'confunde' }]);
});

test('tally: empate e persona ausente (voto descartado ou não respondeu)', () => {
  const votes = { bia: vote([['F1', 5], ['F2', 4]]), rafa: vote([['F2', 5], ['F1', 4]]), julia: null };
  const t = M.mesaTally(cands, votes, P);
  assert.deepEqual(t.ausentes, ['julia']);
  assert.deepEqual(t.presentes, ['bia', 'rafa']);
  const [a, b] = t.rows;
  assert.equal(a.total, 9); assert.equal(b.total, 9);
  assert.ok(a.empate && b.empate);
  assert.ok(a.todos, 'todos = todos os que votaram');
  assert.equal(t.rows.find((r) => r.id === 'F3').empate, false, 'zero não é empate');
});

test('decisão: top 5 sem veto + escolha do usuário vence', () => {
  const votes = { bia: vote([['F1', 5], ['F2', 4], ['F3', 3], ['F4', 2], ['F5', 1]]), rafa: vote([['F1', 5], ['F2', 4], ['F3', 3], ['F6', 2], ['F5', 1]], [{ id: 'F4', motivo: 'não' }]) };
  const t = M.mesaTally(cands, votes, P.slice(0, 2));
  let d = M.mesaDecision(t, {});
  assert.deepEqual(d.sugeridas.map((r) => r.id).sort(), ['F1', 'F2', 'F3', 'F5', 'F6'], 'F4 vetada fica de fora');
  assert.equal(d.rows.find((r) => r.id === 'F4').status, 'vetada');
  assert.equal(d.aprovadas.length, 0, 'nada vira aprovado sozinho');
  d = M.mesaDecision(t, { F4: 'aprovada', F1: 'rejeitada' });
  assert.deepEqual(d.aprovadas.map((r) => r.id), ['F4']);
  assert.equal(d.rows.find((r) => r.id === 'F1').status, 'rejeitada');
  assert.equal(d.rows.find((r) => r.id === 'F2').status, 'sugerida');
});

test('decisão: empate no corte entra junto; votada por todos entra mesmo fora do top', () => {
  const votes = { bia: vote([['F1', 5], ['F2', 1]]), rafa: vote([['F1', 5], ['F2', 1]]), julia: vote([['F3', 5], ['F2', 1]]) };
  const d = M.mesaDecision(M.mesaTally(cands, votes, P), {}, 1);
  assert.deepEqual(d.sugeridas.map((r) => r.id).sort(), ['F1', 'F2'], 'F1 (top 1) + F2 (voto de todos, 3 pts); F3 fora');
  const d3 = M.mesaDecision(M.mesaTally(cands, { bia: vote([['F1', 5], ['F2', 4]]), rafa: vote([['F3', 5], ['F4', 4]]) }, P.slice(0, 2)), {}, 1);
  assert.deepEqual(d3.sugeridas.map((r) => r.id).sort(), ['F1', 'F3'], 'empate de 5 no corte');
});

test('custo: personas × rodadas; régua do roughEstimate quando existe', () => {
  const [lo, hi] = M.mesaCost(5, 2, 'claude-sonnet-5');
  assert.ok(Math.abs(lo - 0.5375) < 1e-9 && Math.abs(hi - 2.15) < 1e-9, `${lo} ${hi}` + ' (5 × (1 + 1,15 de margem do revoto))');
  const est = (n, m) => (assert.equal(m, 'sonnet'), [n * 0.12, n * 0.5]);
  const [a, b] = M.mesaCost(4, 2, 'claude-sonnet-5', est);
  assert.ok(Math.abs(a - 8.6 * 0.12 * 0.4) < 1e-9 && Math.abs(b - 8.6 * 0.5 * 0.4) < 1e-9, `${a} ${b}`);
  // F4 (D13): o teto da mesa é em US$ — antes era R$ na Mesa e US$ na Ideia
  assert.equal(M.mesaCapHit(1, 1), true);
  assert.equal(M.mesaCapHit(0.9, 1), false);
  assert.equal(M.mesaCapHit(100, 0), false, 'mesa antiga sem teto');
  // mesa antiga em R$ migra pelo câmbio; a nova grava capUsd
  assert.equal(M.mesaCapUsdOf({ capBrl: 11 }, 5.5), 2);
  assert.equal(M.mesaCapUsdOf({ capUsd: 3, capBrl: 99 }, 5.5), 3);
  assert.equal(M.mesaCapUsdOf({}, 5.5), 0);
});

test('rodada 1: propostas viram features F1..Fn sem duplicar título', () => {
  const pos = M.mesaParsePosition('```json\n{"posicao":"quero simples","propostas":[{"titulo":"Começar sem portões","descricao":"x"},{"titulo":""}]}\n```');
  assert.equal(pos.texto, 'quero simples');
  assert.equal(pos.propostas.length, 1);
  const semJson = M.mesaParsePosition('só texto');
  assert.equal(semJson.texto, 'só texto'); assert.ok(semJson.aviso);
  const resp = { bia: { st: 'ok', propostas: [{ titulo: 'Começar sem portões' }, { titulo: 'Custo em R$' }] }, rafa: { st: 'ok', propostas: [{ titulo: 'começar sem PORTÕES!' }, { titulo: 'Gate de verificação' }] }, julia: { st: 'falhou' } };
  const c = M.mesaCandidates(P, resp);
  assert.deepEqual(c.map((x) => x.id + ':' + x.titulo), ['F1:Começar sem portões', 'F2:Custo em R$', 'F3:Gate de verificação']);
  assert.deepEqual(c[0].autores, ['Bia', 'Rafa']);
});

test('personas geradas: 3-5, id único, descarta sem nome', () => {
  const ps = M.mesaParsePersonas('{"personas":[{"nome":"Ana","papel":"dona do estúdio","desc":"paga a conta"},{"nome":"Bia","desc":"cliente"},{"nome":"","desc":"x"},{"nome":"Ana","desc":"outra"}]}', ['bia']);
  assert.deepEqual(ps.map((p) => p.id), ['g-ana', 'g-bia', 'g-ana-2']);
  assert.ok(ps.every((p) => p.gerada));
  assert.deepEqual(M.mesaParsePersonas('nada'), []);
});

test('antes → depois, justificativa e nota de decisão', () => {
  const m = { id: 'm1', tema: 'próximas features', personas: P, cands, escolhas: {}, rounds: [
    { n: 1, tipo: 'posicao', resp: {} },
    { n: 2, tipo: 'voto', resp: { bia: { st: 'ok', voto: vote([['F1', 5]]) }, rafa: { st: 'ok', voto: vote([['F2', 5]]) }, julia: { st: 'falhou' } } },
    { n: 3, tipo: 'voto', argumento: 'sem backend', resp: { bia: { st: 'ok', voto: vote([['F1', 5], ['F2', 4]]) }, rafa: { st: 'ok', voto: vote([['F1', 4], ['F2', 5]]) }, julia: { st: 'ok', voto: vote([['F1', 3]], [{ id: 'F2', motivo: 'precisa de backend' }]) } } },
  ] };
  const t2 = M.mesaTally(cands, M.mesaVotesOf(m.rounds[1]), P), t3 = M.mesaTally(cands, M.mesaVotesOf(m.rounds[2]), P);
  const d = M.mesaDiff(t2, t3);
  assert.deepEqual(d.F1, { antes: 5, depois: 12, delta: 7 });
  assert.deepEqual(d.F2, { antes: 5, depois: 9, delta: 4 });
  const row = t3.rows.find((r) => r.id === 'F2');
  const j = M.mesaJustify(m, row);
  assert.match(j, /mesa de personas "próximas features"/);
  assert.match(j, /9 pontos, votada por 2 de 3 \(Rafa 5, Bia 4\)/);
  assert.match(j, /- Rafa \(5\): pq F2/);
  assert.match(j, /Vetada por[^\n]*\n- Júlia: precisa de backend/);
  const dec = M.mesaDecision(t3, { F1: 'aprovada' });
  const body = M.mesaNoteBody(m, dec, '- Feature A (tarefa 42)');
  assert.match(body, /## Aprovadas\n- \*\*Feature A\*\* — 12 pts/);
  assert.match(body, /Rastro: mesa próximas features/);
});

test('prompts: rodada 2 leva as posições e as features; argumento leva o argumento; persona só a própria', () => {
  const r2 = M.mesaR2Prompt('tema X', P, { bia: { st: 'ok', texto: 'POSICAO-BIA' }, rafa: { st: 'falhou' } }, cands.slice(0, 2));
  assert.match(r2, /POSICAO-BIA/); assert.match(r2, /### Rafa \(tech lead\)\n\(não respondeu\)/); assert.match(r2, /F2 — Feature B/);
  assert.match(r2, /escolha as 2 features/);
  const t = M.mesaTally(cands, { bia: vote([['F1', 5]]) }, P);
  const a = M.mesaArgPrompt('tema X', P, { bia: { texto: 'FALA', voto: vote([['F1', 5]]) } }, cands, t, 'não temos backend');
  assert.match(a, /> não temos backend/); assert.match(a, /F1 Feature A: 5 pts/);
  const q = M.mesaAskPrompt('tema X', P[1], { posicao: 'P-RAFA', voto: vote([['F2', 5]]), cands, chat: [] }, 'por que vetou?');
  assert.match(q, /P-RAFA/); assert.match(q, /Responda só como Rafa/); assert.ok(!q.includes('POSICAO-BIA'));
});

test('parse de voto: peso acima do nº de features cai; observações passam', () => {
  const ids3 = ['F1', 'F2', 'F3'];
  const r = M.mesaParseVote('{"top5":[{"id":"F1","peso":5},{"id":"F2","peso":3},{"id":"F3","peso":1}],"observacoes":"ideia nova: lembrete por WhatsApp"}', ids3);
  assert.equal(r.ok, true);
  assert.deepEqual(r.vote.top.map((t) => t.id + t.peso), ['F2' + 3, 'F3' + 1]);
  assert.match(r.warns.join(' '), /peso inválido em F1/);
  assert.equal(r.vote.obs, 'ideia nova: lembrete por WhatsApp');
});

test('voto: malformado → uma nova tentativa → descartado com aviso (não "falhou")', () => {
  const bad = M.mesaParseVote('sem json', ids);
  assert.equal(M.mesaVoteOutcome(bad, null, 'sem json').kind, 'retry');
  const again = M.mesaVoteOutcome(bad, M.mesaParseVote('{"fala":"ainda sem voto"}', ids), '{"fala":"ainda sem voto"}');
  assert.equal(again.kind, 'discard');
  assert.equal(again.texto, 'ainda sem voto');
  assert.ok(again.erro);
  const fixed = M.mesaVoteOutcome(bad, M.mesaParseVote('{"top5":[{"id":"F1","peso":5}]}', ids), '');
  assert.equal(fixed.kind, 'ok');
  assert.equal(M.mesaVoteOutcome(M.mesaParseVote('{"top5":[{"id":"F2","peso":5}]}', ids), null, '').kind, 'ok', 'válido na 1ª não pede de novo');
});

test('próximo passo: rodada 1 → features → rodada 2 → concluída; tudo falhou → interrompida; Continuar inclui quem falhou', () => {
  const base = () => ({ personas: P.slice(0, 2), rounds: [{ n: 1, tipo: 'posicao', resp: {} }] });
  const m = base();
  assert.equal(M.mesaNextStep(m).kind, 'run');
  m.rounds[0].resp = { bia: { st: 'ok', propostas: [{ titulo: 'A' }] }, rafa: { st: 'falhou' } };
  const s1 = M.mesaNextStep(m);
  assert.equal(s1.kind, 'open-vote');
  assert.deepEqual(s1.cands.map((c) => c.titulo), ['A']);
  assert.equal(M.mesaNextStep(m, true).kind, 'run', 'Continuar: quem falhou roda de novo');
  assert.deepEqual(M.mesaRoundMissing(m, m.rounds[0], true).map((p) => p.id), ['rafa']);
  assert.deepEqual(M.mesaRoundMissing(m, m.rounds[0]).map((p) => p.id), []);
  m.cands = s1.cands;
  m.rounds.push({ n: 2, tipo: 'voto', resp: { bia: { st: 'ok', voto: vote([['F1', 1]]) }, rafa: { st: 'ok', voto: null } } });
  assert.equal(M.mesaNextStep(m).kind, 'concluded');
  const dead = base();
  dead.rounds[0].resp = { bia: { st: 'falhou' }, rafa: { st: 'falhou' } };
  assert.equal(M.mesaNextStep(dead).kind, 'interrupted');
  const novotes = base();
  novotes.rounds[0].resp = { bia: { st: 'ok', propostas: [{ titulo: 'A' }] }, rafa: { st: 'ok', propostas: [] } };
  novotes.rounds.push({ n: 2, tipo: 'voto', resp: { bia: { st: 'ok', voto: null }, rafa: { st: 'falhou' } } });
  assert.equal(M.mesaNextStep(novotes).kind, 'interrupted', 'rodada de voto sem nenhum voto válido');
  const noprops = base();
  noprops.rounds[0].resp = { bia: { st: 'ok', propostas: [] }, rafa: { st: 'ok', propostas: [] } };
  assert.equal(M.mesaNextStep(noprops).kind, 'concluded');
  assert.ok(M.mesaNextStep(noprops).aviso);
});

test('revoto: prompt diz que só vota nas features da lista e ideia nova vai em observacoes', () => {
  const t = M.mesaTally(cands.slice(0, 2), {}, P);
  const a = M.mesaArgPrompt('tema', P, {}, cands.slice(0, 2), t, 'arg');
  assert.match(a, /\(F1, F2\)/); assert.match(a, /NÃO cria feature nova/); assert.match(a, /observacoes/);
});

test('planner: sufixo de origem — originNote "" suprime, ausente mantém o padrão', () => {
  assert.equal(plOriginSuffix({}), '');
  assert.equal(plOriginSuffix({ origin: { title: 'T' }, originNote: '' }), '');
  assert.match(plOriginSuffix({ origin: { title: 'T' } }), /\(Origem: tarefa "T"/);
});
