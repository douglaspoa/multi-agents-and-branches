// Aprendizados para revisar (aba Memória) + controles do aprendizado contínuo (Configurações).
// Carrega o trecho puro de 37-memoria.js (@puro-inicio … @puro-fim), sem browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mem = readFileSync(new URL('../src/js/37-memoria.js', import.meta.url), 'utf8');
const cfg = readFileSync(new URL('../src/js/67-ajustes.js', import.meta.url), 'utf8'); // F4 · G3: Configurações virou Ajustes
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return src.slice(i, j); };
const M = new Function(cut(mem, '// @puro-inicio', '// @puro-fim') + '\nreturn { memLearnHtml, memLearnCard, memLearnLabel, memLearnSigOf };')();

const nota = { id: 'n1', kind: 'nota', taskId: 't1', taskTitle: 'Corrigir login', createdAt: 1, nota: { title: 'Usar pnpm', type: 'regra', tags: [], body: 'sempre pnpm' } };
const nova = { id: 's1', kind: 'skill', taskId: 't1', taskTitle: 'Corrigir login', createdAt: 1, skill: { acao: 'criar', nome: 'rodar-testes', descricao: 'Use ao validar', corpo: '## Passo a passo\nnpm test', porque: 'o humano pediu' } };
const upd = { ...nova, id: 's2', skill: { ...nova.skill, acao: 'atualizar', nome: 'validar-login' } };

test('fila vazia: a seção não aparece', () => {
  assert.equal(M.memLearnHtml([]), '');
  assert.equal(M.memLearnHtml(undefined), '');
});

test('cabeçalho com a contagem e um card por item com aceitar/descartar', () => {
  const h = M.memLearnHtml([nota, nova, upd]);
  assert.match(h, /Aprendizados para revisar \(3\)/);
  assert.equal((h.match(/class="memlcard"/g) || []).length, 3);
  for (const id of ['n1', 's1', 's2']) {
    assert.ok(h.includes('data-laccept="' + id + '"'), id);
    assert.ok(h.includes('data-ldiscard="' + id + '"'), id);
  }
});

test('card mostra tipo, título/nome, tarefa de origem, corpo; atualização diz qual skill', () => {
  const n = M.memLearnCard(nota);
  assert.match(n, /nota · regra/); assert.match(n, /Usar pnpm/); assert.match(n, /da tarefa "Corrigir login"/); assert.match(n, /sempre pnpm/);
  assert.match(M.memLearnCard(nova), /skill nova/);
  assert.match(M.memLearnCard(nova), /por quê: o humano pediu/);
  assert.equal(M.memLearnLabel(upd), 'atualiza a skill validar-login');
  assert.match(M.memLearnCard(upd), /atualiza a skill validar-login/);
});

test('texto proposto é escapado (não injeta HTML na aba)', () => {
  const h = M.memLearnCard({ ...nota, id: 'x"><img', nota: { ...nota.nota, title: '<img src=x onerror=alert(1)>', body: '<script>x</script>' } });
  assert.ok(!h.includes('<img'), h);
  assert.ok(!h.includes('<script>'), h);
  assert.ok(!h.includes('data-lid="x">'), h);
});

test('Ajustes › Aprendizado: modo e modelo gravados sozinhos; modelo personalizado do settings.json não é trocado', () => {
  for (const v of ["['sugerir'", "['auto'", "['desligado'"]) assert.ok(cfg.includes(v), v);
  assert.match(cfg, /ajSetting\('learnMode', b\.dataset\.ajlearn\)/);
  assert.match(cfg, /ajSetting\('retroModel', rm\.value\)/);
  const C = new Function(cut(cfg, '// modelos da retro', '// papel e plano em português') + '\nreturn { RETRO_MODELS, retroModelSelect };')();
  assert.deepEqual(C.RETRO_MODELS.map((m) => m[0]), ['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  // <select> mínimo, sem DOM
  const sel = { options: C.RETRO_MODELS.map(([value]) => ({ value })), value: 'claude-sonnet-5', appendChild(o) { this.options.push(o); } };
  const doc = globalThis.document; globalThis.document = { createElement: () => ({}) };
  try {
    C.retroModelSelect(sel, 'claude-haiku-4-5-20251001'); assert.equal(sel.value, 'claude-haiku-4-5-20251001'); assert.equal(sel.options.length, 2);
    C.retroModelSelect(sel, 'claude-opus-5-5'); assert.equal(sel.value, 'claude-opus-5-5'); assert.equal(sel.options.length, 3, 'virou opção');
    C.retroModelSelect(sel, ''); assert.equal(sel.value, 'claude-opus-5-5');
  } finally { globalThis.document = doc; }
});

test('skill atualizar: card traz a versão atual recolhida (aceitar troca o corpo inteiro)', () => {
  const h = M.memLearnCard({ ...upd, atual: '## Passo a passo\ncorpo <antigo>' });
  assert.match(h, /<details class="memlcur"><summary>versão atual/);
  assert.match(h, /corpo &lt;antigo&gt;/);
  assert.ok(!M.memLearnCard(upd).includes('memlcur'), 'sem versão atual conhecida: sem bloco');
  assert.ok(!M.memLearnCard({ ...nova, atual: 'x' }).includes('memlcur'), 'skill nova: sem bloco');
});

test('selo: assinatura só muda com troca de projeto ou evento "aprendizado…" novo', () => {
  const ev = (id, text) => ({ id, text });
  const a = M.memLearnSigOf({ repo: '/r', events: [ev(1, 'x'), ev(2, 'aprendizado: 2 sugestões da retro pra revisar na aba Memória')] });
  assert.equal(a, M.memLearnSigOf({ repo: '/r', events: [ev(2, 'aprendizado: 2 sugestões da retro pra revisar na aba Memória'), ev(3, 'outro evento')] }));
  assert.notEqual(a, M.memLearnSigOf({ repo: '/r', events: [ev(2, 'aprendizado: …'), ev(9, 'aprendizado: 1 sugestão')] }));
  assert.notEqual(a, M.memLearnSigOf({ repo: '/outro', events: [ev(2, 'aprendizado: …')] }));
  assert.equal(M.memLearnSigOf(null), '|');
});
