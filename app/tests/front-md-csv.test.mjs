// Testes do front sem browser: `node --test app/tests/`
// Carrega só as funções puras de 23-kanban-artefatos-editor.js (mdToHtml, csvParse) direto do código-fonte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/js/23-kanban-artefatos-editor.js', import.meta.url), 'utf8');
const slice = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const md = slice('function mdSafeHref', '// BUG-12');
const csv = slice('function csvParse', 'function csvTableHtml');
const { mdToHtml, csvParse } = new Function(md + '\n' + csv + '\nreturn { mdToHtml, csvParse };')();

test('link com aspas não vira atributo (XSS por comentário de PR)', () => {
  const h = mdToHtml(`[x](https://a"onmouseover="alert(1)"y)`);
  assert.ok(!/onmouseover="/.test(h), h);
  assert.ok(!/<a [^>]*"\s+on/i.test(h), h);
});
test('só http(s)/mailto viram link; javascript: vira texto', () => {
  assert.ok(!mdToHtml('[clique](javascript:alert(1))').includes('<a '));
  assert.ok(!mdToHtml('[x](data:text/html,oi)').includes('<a '));
  const ok = mdToHtml('[site](https://starfork.com.br/a?b=1&c=2)');
  assert.match(ok, /<a href="https:\/\/starfork\.com\.br\/a\?b=1&amp;c=2" data-exthref="[^"]+" rel="noreferrer">site<\/a>/);
  assert.ok(!ok.includes('target='), 'sem target=_blank (o WKWebView ignora)');
});
test('HTML cru é escapado', () => {
  const h = mdToHtml('<img src=x onerror=alert(1)> e **"negrito"**');
  assert.ok(!h.includes('<img'), h);
  assert.ok(h.includes('<strong>&quot;negrito&quot;</strong>'), h);
});
test('tabela GFM vira <table>', () => {
  const h = mdToHtml('| Unidade | Atendimentos |\n|---|---:|\n| Centro | 120 |\n| Norte | 80 |');
  assert.match(h, /<table class="mdtable"><thead><tr><th>Unidade<\/th><th>Atendimentos<\/th><\/tr><\/thead><tbody><tr><td>Centro<\/td><td>120<\/td><\/tr>/);
});
test('CSV com aspas, separador ; e quebra dentro de aspas', () => {
  assert.deepEqual(csvParse('a;b\n"1;x";"diz ""oi"""\n'), [['a', 'b'], ['1;x', 'diz "oi"']]);
  assert.deepEqual(csvParse('nome,obs\r\nAna,"linha1\nlinha2"'), [['nome', 'obs'], ['Ana', 'linha1\nlinha2']]);
  assert.deepEqual(csvParse('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
});
