// Bloco "Guarda" da aba Revisão (Frente 2): `node --test app/tests/guarda.test.mjs`
// Funções puras de 63-revisao-pr.js (@guarda-puro) — paridade do dispensar com src/guard.ts e o HTML do bloco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = rd('../src/js/63-revisao-pr.js');
const css = rd('../src/css/97-revisao-pr.css');
const ws = rd('../src/js/20-workspace-tarefa.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function ctx() {
  const c = { esc, escA: esc, console };
  vm.createContext(c);
  vm.runInContext(cut(src, '// @guarda-puro-inicio', '// @guarda-puro-fim'), c);
  return c;
}
const J = (v) => JSON.parse(JSON.stringify(v));

const SECRET = { tool: 'gitleaks', kind: 'segredo', severity: 'alta', file: 'src/s3.ts', line: 1, rule: 'aws-access-token', message: 'AWS Access Key', masked: 'AKIA••••', fingerprint: 'src/s3.ts:aws-access-token:1', blocks: true };
const SQL = { tool: 'semgrep', kind: 'codigo', severity: 'media', file: 'src/db.ts', line: 4, rule: 'sql-concat', message: 'SQL montado com concatenação', fingerprint: 'src/db.ts:sql-concat:4', blocks: false };
const G = { reasons: ['segredo no código em src/s3.ts:1 (AKIA••••, aws-access-token) — troque por variável de ambiente; nunca escreva o valor no código'], findings: [SQL, SECRET], skipped: [], ignored: 0, at: 1, ms: 5 };

test('gdModel: bloqueio primeiro, segredo antes de código; estados', () => {
  const c = ctx();
  const m = J(c.gdModel(G));
  assert.equal(m.state, 'block');
  assert.deepEqual(m.findings.map((f) => f.kind), ['segredo', 'codigo']);
  assert.equal(J(c.gdModel({ ...G, findings: [SQL], reasons: [] })).state, 'warn');
  assert.equal(J(c.gdModel({ findings: [], skipped: ['guarda de código desligada (semgrep não instalado)'] })).state, 'off');
  assert.equal(J(c.gdModel({ findings: [], skipped: [] })).state, 'ok');
  assert.equal(J(c.gdModel(null)).state, 'none');
});

test('gdHtml: achado com arquivo:linha, valor só mascarado, dispensar e o selo "guarda desligada"', () => {
  const c = ctx();
  const h = c.gdHtml({ ...G, skipped: ['guarda de código desligada (semgrep não instalado)'] });
  assert.match(h, /a entrega está bloqueada/);
  assert.match(h, /<code class="gdloc">src\/s3\.ts:1<\/code>/);
  assert.match(h, /AKIA••••/);
  assert.match(h, /segredo · alta · bloqueia/);
  assert.match(h, /código · média</);
  assert.match(h, /data-gdign="src\/s3\.ts:aws-access-token:1"/);
  assert.match(h, /<span class="gdoff" role="status">guarda de código desligada \(semgrep não instalado\)<\/span>/);
  assert.equal(c.gdHtml(null), '', 'sem portão ainda: nada');
});

test('gdAddIgnore ≡ addIgnore do motor; gdParseIgnores aceita lista ou { list }; gdWithout tira o achado e o motivo', () => {
  const c = ctx();
  let l = c.gdAddIgnore([], { fingerprint: 'a:r:1', motivo: ' exemplo ', por: '', em: '2026-10-19T00:00:00.000Z' });
  l = c.gdAddIgnore(l, { fingerprint: 'a:r:1', motivo: 'exemplo do README', por: 'Douglas', em: '2026-10-19T01:00:00.000Z' });
  assert.deepEqual(J(l), [{ fingerprint: 'a:r:1', motivo: 'exemplo do README', por: 'Douglas', em: '2026-10-19T01:00:00.000Z' }]);
  assert.equal(J(c.gdAddIgnore([], { fingerprint: 'x', motivo: 'm' }))[0].por, 'Você');
  assert.deepEqual(J(c.gdParseIgnores(JSON.stringify({ list: [{ fingerprint: 'x' }, { nada: 1 }] }))).length, 1);
  assert.deepEqual(J(c.gdParseIgnores('lixo')), []);
  const w = J(c.gdWithout(G, SECRET.fingerprint));
  assert.deepEqual([w.findings.length, w.reasons.length, w.ignored], [1, 0, 1]);
  assert.equal(J(c.gdModel(w)).state, 'warn');
});

test('fiação: Revisão monta o bloco, dispensar usa askText (nunca window.confirm), CSS só com tokens', () => {
  assert.match(ws, /if\(fwMode==='revisao' && typeof gdMount==='function'\) gdMount\(t, main\);/);
  assert.match(ws, /if\(e\.type==='guarda'\)/, 'o evento guarda vira linha de sistema na conversa (não atividade)');
  const dom = src.slice(src.indexOf('// @guarda-puro-fim'));
  assert.match(dom, /await askText\(/);
  assert.match(dom, /invoke\('write_file',\{ taskId, path, content/);
  assert.doesNotMatch(dom, /window\.confirm|confirm\(/);
  const block = css.slice(css.indexOf('Frente 2 · bloco "Guarda"'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'nenhuma cor literal');
  assert.match(block, /var\(--tone-crit\)/);
});
