// R7 (chat · memória · mesa · daily): funções puras novas/corrigidas, sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = f => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return src.slice(i, j); };
const mem = rd('37-memoria.js'), mesa = rd('38-mesa.js'), daily = rd('12-chat-prefs-daily.js');
const M = new Function(cut(mem, '// @puro-inicio', '// @puro-fim') + '\nreturn { memPlain, memDateBR, memErrText };')();
const Me = new Function(cut(mesa, '// @puro-inicio', '// @puro-fim') + '\nreturn { mesaFailed, mesaNextStep };')();
const dailyIsoShift = new Function(cut(daily, 'function dailyIsoShift', '\n') + '\nreturn dailyIsoShift;')();
const pcGate = new Function(cut(daily, 'function pcGate', '// @puro-fim pcGate') + '\nreturn pcGate;')();
const dailyBtnState = new Function(cut(daily, 'function dailyBtnState', '// @puro-fim dailyBtnState') + '\nreturn dailyBtnState;')();
const cfgValidate = new Function(cut(rd('67-ajustes.js'), 'function cfgValidate', '// @puro-fim cfgValidate') + '\nreturn cfgValidate;')();

test('memPlain: resumo da lista sem a marcação do markdown', () => {
  assert.equal(M.memPlain('O projeto usa **pnpm** (lockfile `pnpm-lock.yaml`).'), 'O projeto usa pnpm (lockfile pnpm-lock.yaml).');
  assert.equal(M.memPlain('Ligado a [[usar-pnpm]] e [[ci-lento|o CI]].'), 'Ligado a usar-pnpm e o CI.');
  assert.equal(M.memPlain('- veja [a doc](https://x.dev) e *isto*'), 'veja a doc e isto');
  assert.equal(M.memPlain('nomes_com_underscore ficam'), 'nomes_com_underscore ficam');
  // código primeiro: nada dentro das crases vira ênfase
  assert.equal(M.memPlain('rode `__init__.py` e `**x**`'), 'rode __init__.py e **x**');
  // dunders e globs fora de código também ficam
  assert.equal(M.memPlain('edite __init__.py e todos os *.md'), 'edite __init__.py e todos os *.md');
  assert.equal(M.memPlain('**pnpm**. e __ok__, fim'), 'pnpm. e ok, fim');
  // corte do resumo: delimitador aberto sem fechamento some
  assert.equal(M.memPlain('O projeto usa **pnpm (lockfile `pnpm-lo…'), 'O projeto usa pnpm (lockfile pnpm-lo…');
  assert.equal(M.memPlain('ver [[usar-pn…'), 'ver usar-pn…');
  assert.equal(M.memPlain(''), '');
  assert.equal(M.memPlain(null), '');
});

test('memDateBR: dia/mês (ano só quando não é o atual)', () => {
  const now = new Date(2026, 8, 28);
  assert.equal(M.memDateBR('2026-09-26', now), '26/09');
  assert.equal(M.memDateBR('2025-12-01', now), '01/12/2025');
  assert.equal(M.memDateBR('ontem', now), 'ontem');
  assert.equal(M.memDateBR('', now), '');
});

test('memErrText: io::Error do Rust em inglês vira pt-BR; o resto passa', () => {
  assert.match(M.memErrText('No such file or directory (os error 2)'), /não existe mais/);
  assert.match(M.memErrText(new Error('Read-only file system (os error 30)')), /só leitura/);
  assert.match(M.memErrText('Is a directory (os error 21)'), /pasta com o mesmo nome/);
  assert.equal(M.memErrText('nota não encontrada'), 'nota não encontrada');
  assert.equal(M.memErrText('Permission denied (os error 13)'), 'Permission denied (os error 13)'); // o catálogo global traduz
  // Windows
  assert.match(M.memErrText('O sistema não pode encontrar o caminho especificado. (os error 3)'), /não existe mais/);
  assert.match(M.memErrText('Cannot create a file when that file already exists. (os error 183)'), /já existe/);
  assert.match(M.memErrText('The directory is not empty. (os error 145)'), /não está vazia/);
});

const P = [{ id: 'a', nome: 'Ana' }, { id: 'b', nome: 'Beto' }];
const ok = { st: 'ok', texto: 'x', voto: { top: [{ id: 'F1', peso: 1 }], vetos: [] } };
test('mesaFailed: só quem falhou na ÚLTIMA rodada, e só se as anteriores estão limpas', () => {
  const m = { personas: P, rounds: [{ n: 1, tipo: 'posicao', resp: { a: { st: 'ok' }, b: { st: 'ok' } } }, { n: 2, tipo: 'voto', resp: { a: ok, b: { st: 'falhou', erro: 'limite' } } }] };
  assert.deepEqual(Me.mesaFailed(m).map(p => p.id), ['b']);
  // o "tentar de novo" (withFailed) refaz exatamente essa rodada
  assert.equal(Me.mesaNextStep(m, true).round.n, 2);
  assert.equal(Me.mesaNextStep(m, false).kind, 'concluded');
  const m2 = { personas: P, rounds: [{ n: 1, tipo: 'posicao', resp: { a: { st: 'falhou' }, b: { st: 'ok' } } }, m.rounds[1]] };
  assert.deepEqual(Me.mesaFailed(m2), []);
  assert.deepEqual(Me.mesaFailed({ personas: P, rounds: [] }), []);
});

test('dailyIsoShift: dia anterior no calendário LOCAL (vira mês e ano)', () => {
  assert.equal(dailyIsoShift('2026-09-28', -1), '2026-09-27');
  assert.equal(dailyIsoShift('2026-03-01', -1), '2026-02-28');
  assert.equal(dailyIsoShift('2026-01-01', -1), '2025-12-31');
});

test('pcGate: pergunta e "virar tarefa" nunca juntas no MESMO projeto', () => {
  const st = o => Object.assign({ busy: false, busyRepo: '', toTask: false, toTaskRepo: '', repo: '/a' }, o);
  assert.equal(pcGate('send', st()), null);
  assert.equal(pcGate('task', st()), null);
  assert.match(pcGate('send', st({ toTask: true, toTaskRepo: '/a' })), /Montando a tarefa/);
  assert.match(pcGate('task', st({ busy: true, busyRepo: '/a' })), /Espere a resposta/);
  assert.match(pcGate('task', st({ toTask: true, toTaskRepo: '/b' })), /Já estou montando/);
  // pergunta de OUTRO projeto em andamento: virar tarefa aqui pode; perguntar aqui espera (um chat por vez)
  assert.equal(pcGate('task', st({ busy: true, busyRepo: '/b' })), null);
  assert.match(pcGate('send', st({ busy: true, busyRepo: '/b' })), /outro projeto/);
  assert.equal(pcGate('send', st({ toTask: true, toTaskRepo: '/b' })), null);
});

test('dailyBtnState: escrevendo › carregando › sem atividade › livre (título original volta)', () => {
  assert.deepEqual(dailyBtnState('doc', { busy: true, loading: true, has: true }), { disabled: true, label: 'escrevendo o relatório…', title: '' });
  assert.equal(dailyBtnState('ai', { busy: false, loading: true, has: true }).title, 'espere o dia carregar');
  assert.deepEqual(dailyBtnState('ai', { busy: false, loading: false, has: false }), { disabled: true, label: 'Resumo curto', title: 'dia sem atividade — troque a data' });
  assert.deepEqual(dailyBtnState('doc', { busy: false, loading: false, has: true }), { disabled: false, label: 'Gerar relatório do dia', title: null });
});

test('cfgValidate: faixas com aviso em vez de ajuste silencioso', () => {
  const ok = { cap: '5', cost: '25', brl: '5,5', slots: '4', retry: '60' };
  assert.equal(cfgValidate(ok), null);
  assert.equal(cfgValidate({ ...ok, cost: '0', retry: '0' }), null);
  assert.equal(cfgValidate({ ...ok, cap: '0' }).field, 'cfgCap', 'teto sempre ligado: 0 não desliga');
  assert.equal(cfgValidate({ ...ok, cap: '-1' }).field, 'cfgCap');
  assert.equal(cfgValidate({ ...ok, cost: '' }).field, 'cfgCost');
  assert.equal(cfgValidate({ ...ok, brl: '0' }).field, 'cfgBrl');
  assert.equal(cfgValidate({ ...ok, slots: '0' }).field, 'cfgSlots');
  assert.equal(cfgValidate({ ...ok, slots: '13' }).field, 'cfgSlots');
  assert.equal(cfgValidate({ ...ok, slots: '2.5' }).field, 'cfgSlots');
  assert.equal(cfgValidate({ ...ok, retry: '300' }).field, 'cfgLimitRetry');
});
