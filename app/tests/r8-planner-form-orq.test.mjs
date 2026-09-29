// R8 (planner · formulário · dividir): lógica pura recortada dos arquivos reais pelo nome e montada com new Function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
function block(src, start) {
  let i = src.indexOf('{', start), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) break; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('chaves desbalanceadas');
}
function fn(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, 'função não encontrada: ' + name);
  return block(src, m.index);
}
const planner = read('32-planner.js'), form = read('31-nova-demanda-form.js'), orqSrc = read('34-orquestrador.js');

const plBusyInfo = new Function('const PL_SLOW_MS=90000;\n' + fn(planner, 'plBusyInfo') + '\nreturn plBusyInfo;')();
test('planner: progresso ao vivo mostra tempo, ações e o que está fazendo', () => {
  const a = plBusyInfo(12000, 3, 'lendo src/pontos/index.ts');
  assert.equal(a.tempo, '12s');
  assert.match(a.head, /pensando · 12s · 3 ações/);
  assert.match(a.hint, /^lendo src\/pontos\/index\.ts · 12s/);
  assert.equal(a.slow, false);
  assert.match(plBusyInfo(1000, 1, '').head, /1 ação$/);
  assert.match(plBusyInfo(0, 0, '').hint, /^pensando · 0s/);
});
test('planner: passou de 90 s avisa que dá pra parar sem perder nada', () => {
  const s = plBusyInfo(95000, 0, 'x');
  assert.equal(s.slow, true);
  assert.equal(s.tempo, '1min 35s');
  assert.match(s.hint, /demorando mais que o normal/);
});

// plTakeBack: devolve a última mensagem sua (e os anexos) pra caixa
test('planner: erro/parar devolve a mensagem e os anexos pra caixa', () => {
  const inp = { value: '', dispatchEvent() {} };
  const env = { plMsgs: [{ who: 'bot', text: 'oi' }, { who: 'you', text: 'quero X' }], plPend: [{ path: 'b' }] };
  const take = new Function('env', '$id', 'Event', 'let plMsgs=env.plMsgs, plPend=env.plPend;\n' + fn(planner, 'plTakeBack') + '\nreturn (t,a)=>{ const r=plTakeBack(t,a); env.plPend=plPend; return r; };')(env, () => inp, function () {});
  assert.equal(take('quero X', [{ path: 'a' }]), true);
  assert.equal(env.plMsgs.length, 1);
  assert.equal(inp.value, 'quero X');
  assert.deepEqual(env.plPend.map((x) => x.path), ['a', 'b']);
  assert.equal(take('outra', []), false, 'última não é sua com esse texto → não mexe');
});

test('formulário: o que falta em linguagem de gente', () => {
  const ntMissingText = new Function(fn(form, 'ntMissingText') + '\nreturn ntMissingText;')();
  assert.equal(ntMissingText(['título', 'objetivo']), 'falta: título, objetivo');
  assert.equal(ntMissingText([]), 'pronto pra começar');
  assert.doesNotMatch(ntMissingText(['x']), /obrigat|spec/);
});

test('dividir: tempo do plano e aviso de demora', () => {
  const orqBusyTx = new Function(fn(orqSrc, 'orqBusyTx') + '\nreturn orqBusyTx;')();
  assert.match(orqBusyTx(41000), /^há 41s · costuma levar/);
  assert.match(orqBusyTx(130000), /^há 2min 10s · está demorando/);
});
test('dividir: erro do orquestrador nunca mostra o JSON cru', () => {
  const orqPlanErr = new Function('humanErr', fn(orqSrc, 'orqPlanErr') + '\nreturn orqPlanErr;')((raw, ctx) => ({ msg: ctx + ': ' + String(raw).split('\n')[0] }));
  assert.equal(orqPlanErr('ORQ_PLAN_STOPPED').stopped, true);
  const bad = orqPlanErr(new Error('ORQ_BAD_PLAN'));
  assert.equal(bad.stopped, false);
  assert.doesNotMatch(bad.msg, /[{}]/);
  assert.match(orqPlanErr('comando expirou após 300s').msg, /demorou demais/);
  assert.match(orqPlanErr('falha ao rodar claude: x\n{"a":1}').msg, /^Não deu pra montar o plano: falha ao rodar claude: x$/);
});
