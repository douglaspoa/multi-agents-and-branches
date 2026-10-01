// Conversa da tarefa: ao abrir a atividade / trocar pra "Código" a coluna do chat ainda está sem layout
// e o scrollTop era ignorado → abria no TOPO. fwStickBottom reaplica o "fim" quando ela ganha altura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
const i = src.indexOf('function fwStickBottom(');
const j = src.indexOf('\n}\n', i);
const fn = src.slice(i, j + 2);

function mk() {
  const q = [];
  const ctx = { requestAnimationFrame: (f) => q.push(f) };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  const th = { isConnected: true, clientHeight: 0, scrollHeight: 0, scrollTop: 0, _wheel: null,
    addEventListener(ev, f) { if (ev === 'wheel') this._wheel = f; } };
  return { ctx, q, th, frame: () => { const f = q.shift(); if (f) f(); } };
}

test('coluna ainda escondida: quando ganha altura, a conversa vai pro fim', () => {
  const { ctx, th, frame } = mk();
  ctx.fwStickBottom(th);
  frame(); assert.equal(th.scrollTop, 0, 'sem altura ainda: espera');
  th.clientHeight = 500; th.scrollHeight = 9000;
  frame(); assert.equal(th.scrollTop, 9000, 'com layout: rola pro fim');
});

test('se a pessoa rolar pra cima antes, não puxa pro fim', () => {
  const { ctx, th, frame } = mk();
  ctx.fwStickBottom(th);
  th._wheel();
  th.clientHeight = 500; th.scrollHeight = 9000;
  frame(); assert.equal(th.scrollTop, 0);
});

test('desiste depois de ~10 quadros sem layout (não fica rodando pra sempre)', () => {
  const { ctx, th, q, frame } = mk();
  ctx.fwStickBottom(th);
  for (let k = 0; k < 12; k++) frame();
  assert.equal(q.length, 0);
});
