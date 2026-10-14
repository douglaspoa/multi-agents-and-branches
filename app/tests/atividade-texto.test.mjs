// Atividade do time em pt-BR (harness 14/10: "você pr_opened" na página Time). FONTE ÚNICA = ACT_KIND_PT (00-util):
// toda tela que mostra "fulano <fez> <cartão>" passa por actVerb/actShort; código cru (snake_case, inglês) nunca
// chega na tela — nem o de um kind que a nuvem/outro cliente inventar depois. `node --test app/tests/atividade-texto.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const util = read('js/00-util.js');
const SM = cut(util, 'const STATUS_META={', '\nfunction stMeta');
const A = new Function(SM + cut(util, '// @puro-atividade-inicio', '// @puro-atividade-fim') + '\nreturn { ACT_KIND_PT, ACT_KIND_ALIAS, actVerb, actShort, actKindMeta, actStatusBody };')();
const CORRENTE = new Function(SM + cut(util, '// @puro-atividade-inicio', '// @puro-atividade-fim') + cut(read('js/72-corrente-tarefa.js'), '// @puro-tcorrente-inicio', '// @puro-tcorrente-fim') + '\nreturn { tcActText };')();

// "código cru" = identificador de máquina: snake_case/kebab, ou palavra inglesa de evento que não é pt-BR
const CRU = /\b[a-z]+[_-][a-z_-]+\b|\b(opened|merged|closed|created|edited|claimed|released|assigned|started|delivered|comment|status|review)\b/;
const KINDS_SQL = ['created', 'edited', 'claimed', 'released', 'started', 'delivered', 'comment', 'status', 'assigned']; // check da 0032
const ESTRANHOS = ['pr_opened', 'pr_merged', 'pr_closed', 'PR-Opened', 'merged', 'pr', 'algo_novo_da_nuvem', 'x', '', null, undefined, 'review_requested'];

test('todo kind do banco (0032) tem texto pt-BR próprio, verbo e curto', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/0032_time_responsavel.sql', import.meta.url), 'utf8');
  const lista = (/kind in \(([^)]+)\)/.exec(sql) || [])[1] || '';
  const doBanco = [...lista.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(doBanco.sort(), [...KINDS_SQL].sort(), 'a lista do banco mudou: ponha o kind novo no ACT_KIND_PT');
  for (const k of doBanco) {
    assert.ok(A.ACT_KIND_PT[k], 'sem texto pra ' + k);
    assert.doesNotMatch(A.actVerb(k), CRU, k); assert.doesNotMatch(A.actShort(k), CRU, k);
  }
});

test('kind desconhecido ou de outro cliente NUNCA vira código cru na tela', () => {
  for (const k of [...KINDS_SQL, ...ESTRANHOS, ...Object.keys(A.ACT_KIND_ALIAS)]) {
    for (const f of [A.actVerb, A.actShort]) {
      const s = f(k);
      assert.ok(typeof s === 'string' && s.length > 2, 'texto vazio pra ' + k);
      assert.doesNotMatch(s, CRU, `"${k}" → "${s}"`);
    }
  }
  assert.equal(A.actVerb('pr_opened'), 'abriu o PR de');
  assert.equal(A.actShort('pr_opened'), 'abriu o PR');
  assert.equal(A.actVerb('PR-Opened'), 'abriu o PR de', 'caixa e hífen normalizados');
  assert.equal(A.actVerb('algo_novo_da_nuvem'), 'atualizou');
  assert.equal(A.actShort('delivered'), 'entregou');
  assert.equal(A.actVerb('delivered'), 'publicou provas em');
});

test('linha do tempo da tarefa (72) usa a mesma fonte: "Você abriu o PR", não "você pr_opened"', () => {
  const nm = (u) => (u === 'eu' ? 'você' : 'Ana Souza');
  assert.equal(CORRENTE.tcActText({ kind: 'pr_opened', user_id: 'eu', body: 'PR #42' }, nm).text, 'Você abriu o PR');
  for (const k of ESTRANHOS) assert.doesNotMatch(CORRENTE.tcActText({ kind: k, user_id: 'a' }, nm).text, CRU, String(k));
});

test('status gravado como código ("review", "merged", "pr_open") aparece com o rótulo do STATUS_META', () => {
  assert.equal(A.actStatusBody('review'), 'pronta pra revisar');
  assert.equal(A.actStatusBody('merged'), 'integrada');
  assert.equal(A.actStatusBody('pr_open'), 'PR aberto');
  assert.equal(A.actStatusBody('in_progress'), 'em andamento');
  assert.equal(A.actStatusBody('integrada'), 'integrada', 'rótulo pt-BR (o que o app grava) passa igual');
  assert.equal(A.actStatusBody('FND-103 → “Em revisão” no painel'), 'FND-103 → “Em revisão” no painel', 'texto livre intacto');
  const nm = () => 'Caio';
  assert.equal(CORRENTE.tcActText({ kind: 'status', user_id: 'c', body: 'review' }, nm).text, 'Caio — ficou “pronta pra revisar”');
  assert.match(read('js/08-pessoas.js'), /a\.kind==='status' && typeof actStatusBody==='function'\) return actStatusBody\(a\.body\)/, 'feed do Time (personActBody)');
});

// nenhuma tela monta o texto da atividade por conta própria (mapa local com `||kind`, `${a.kind}` cru na tela…)
test('fonte única: Time, cartão e Entregas passam por actVerb/actShort; nenhum kind cru interpolado', () => {
  const dir = new URL('../src/js/', import.meta.url);
  const ruins = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    if (!/task_activity|teamActivity|tsK\(|tcActText/.test(src)) continue; // só quem lê/mostra atividade do time
    src.split('\n').forEach((l, i) => {
      if (/\[\s*(a|act|x|r)\.kind\s*\]\s*\|\|\s*(a|act|x|r)\.kind|\]\s*\|\|\s*kind\s*[;)}]|\$\{\s*(esc\()?\s*(a|act|lastAct)\.kind\s*\)?\s*\}/.test(l)) ruins.push(f + ':' + (i + 1) + ': ' + l.trim().slice(0, 140));
    });
  }
  assert.deepEqual(ruins, [], 'texto de atividade fora da fonte única:\n' + ruins.join('\n'));
  const times = read('js/43-espaco-times.js'), ent = read('js/70-time-entregas.js');
  assert.match(times, /function tsK\(kind\)\{ return actVerb\(kind\); \}/, 'feed do Time e "último:" do membro');
  assert.match(cut(times, "sbGet('task_activity?select=user_id,kind,body,at&task_id=eq.'", '}).catch'), /esc\(actShort\(a\.kind\)\)/, 'atividade do cartão (escapada)');
  assert.match(ent, /esc\(actShort\(a\.kind\)\)/, 'linha "atividade" das Entregas');
});
