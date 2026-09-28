// Diff unificado ÚNICO (R8): parser diffHunks + renderer diffViewHtml do 20-workspace-tarefa.js.
// `node --test app/tests/` — extrai as duas funções do arquivo e roda num contexto vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
const pick = (name) => { const i = src.indexOf('function ' + name + '('); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && !--d) break; } return src.slice(i, j + 1); };
const ctx = { esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), escA: (s) => String(s), fwDvOpen: new Set() };
vm.createContext(ctx);
vm.runInContext(pick('diffHunks') + '\n' + pick('diffViewHtml') + '\nthis.diffHunks=diffHunks; this.diffViewHtml=diffViewHtml;', ctx);
const { diffHunks, diffViewHtml } = ctx;

const full = Array.from({ length: 60 }, (_, i) => 'L' + (i + 1)); full[19] = 'NOVA20';
const diff = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -17,7 +17,7 @@ function f() {\n L17\n L18\n L19\n-L20\n+NOVA20\n L21\n L22\n L23\n';

test('parser: números antigo/novo por linha', () => {
  const d = diffHunks(diff);
  assert.equal(d.isNew, false);
  assert.equal(d.hunks.length, 1);
  const r = d.hunks[0].rows;
  assert.deepEqual(r.map((x) => x.t).join(','), 'ctx,ctx,ctx,del,add,ctx,ctx,ctx');
  assert.equal(r[3].o, 20); assert.equal(r[4].n, 20); assert.equal(r[7].o, 23);
});
test('arquivo novo (untracked, só "+linha") vira um hunk de adições a partir da linha 1', () => {
  const d = diffHunks('+a\n+b\n+c\n');
  assert.equal(d.isNew, true);
  assert.equal(JSON.stringify(d.hunks[0].rows.map((x) => x.n)), "[1,2,3]");
  assert.match(diffViewHtml(d, {}), /linhas 1–3/);
});
test('hunk de contagem 0 começa na linha seguinte', () => {
  assert.equal(JSON.stringify(diffHunks("@@ -10,0 +11,2 @@\n+x\n+y\n").hunks.map((h) => [h.o, h.n])), "[[11,11]]");
});
test('renderer: cabeçalho "linhas", trechos sem mudança recolhidos e expansíveis com o arquivo inteiro', () => {
  const d = diffHunks(diff);
  let h = diffViewHtml(d, { full, keyPre: 'k|' });
  assert.match(h, /linhas 17–23/);
  assert.match(h, /16 linhas sem mudança/);
  assert.match(h, /37 linhas sem mudança/);
  assert.match(h, /data-ln="20"/); // linha nova selecionável
  assert.equal((h.match(/class="fwln dv del"/g) || []).length, 1);
  assert.doesNotMatch(h, /class="fwln dv del"[^>]*data-ln/); // removida não entra na seleção
  ctx.fwDvOpen.add('k|24-60');
  h = diffViewHtml(d, { full, keyPre: 'k|' });
  assert.match(h, /data-ln="60"/);
  assert.match(h, /recolher 37 linhas/);
  // sem o arquivo inteiro: só avisa, não oferece "mostrar"
  assert.doesNotMatch(diffViewHtml(d, {}), /mostrar/);
});
test('seleção marca as linhas novas do intervalo', () => {
  const h = diffViewHtml(diffHunks(diff), { sel: { a: 19, b: 20 } });
  assert.equal((h.match(/ sel"/g) || []).length, 2);
});
