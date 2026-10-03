// Abas Revisão (por requisito) e PR ("pronto pra integrar?"): `node --test app/tests/revisao-pr.test.mjs`
// Funções puras de 63-revisao-pr.js (@revpr-puro) + o diffHunks de 20-workspace-tarefa.js (o mesmo parser da tela).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = rd('../src/js/63-revisao-pr.js');
const ws = rd('../src/js/20-workspace-tarefa.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctx() {
  const c = { esc, escA: esc, console };
  vm.createContext(c);
  vm.runInContext(cut(ws, 'function diffHunks(text){', '// renderer ÚNICO do diff'), c);
  vm.runInContext(cut(src, '// @revpr-puro-inicio', '// @revpr-puro-fim'), c);
  return c;
}
const run = (c, code) => { const v = vm.runInContext(code, c); return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; };

// dois arquivos: Agenda.tsx com 2 trechos (linhas ~10 e ~84), datas.ts com 1 (troca de lib, escopo que vazou)
const DIFF_AGENDA = `diff --git a/src/pages/Agenda.tsx b/src/pages/Agenda.tsx
--- a/src/pages/Agenda.tsx
+++ b/src/pages/Agenda.tsx
@@ -9,3 +9,4 @@ import
 import x from 'x'
+import { abrirRemarcar } from '../lib/remarcar'
 import y from 'y'
 const z = 1
@@ -83,3 +84,6 @@ export function Agenda() {
   <AulaCard aula={a}>
+    {a.futura && !a.cancelada && (
+      <Button onClick={() => abrirRemarcar(a)}>Remarcar</Button>
+    )}
   </AulaCard>
 </div>
`;
const DIFF_DATAS = `@@ -3,1 +3,1 @@
-import moment from 'moment'
+import { format } from 'date-fns'
`;
const files = (c) => vm.runInContext( `[{ path:'src/pages/Agenda.tsx', hunks:diffHunks(${JSON.stringify(DIFF_AGENDA)}).hunks }, { path:'src/lib/datas.ts', hunks:diffHunks(${JSON.stringify(DIFF_DATAS)}).hunks }]`, c);

test('agente registrou o mapa (code com faixa): só os trechos que cruzam a faixa; o resto vai pra "Fora dos requisitos"', () => {
  const c = ctx(); c.F = files(c);
  const m = run(c, `rvMap([{ text:'R1 botão remarcar', code:[{ file:'src/pages/Agenda.tsx', lines:'84-90' }] }, { text:'R2 import', code:[{ file:'./src/pages/Agenda.tsx', lines:'10' }] }], F)`);
  assert.equal(m.explicit, true);
  assert.equal(m.byReq[0].length, 1); assert.equal(m.byReq[0][0].a, 85); assert.equal(m.byReq[0][0].how, 'agente');
  assert.equal(m.byReq[1].length, 1); assert.equal(m.byReq[1][0].a, 10);
  assert.deepEqual(m.out.map(x => x.path), ['src/lib/datas.ts']);
  assert.equal(m.unc.length, 0);
});

test('arquivo sem faixa = todos os trechos dele; caminho por sufixo só quando não é ambíguo', () => {
  const c = ctx(); c.F = files(c);
  const m = run(c, `rvMap([{ text:'R1', code:[{ file:'Agenda.tsx' }] }], F)`);
  assert.equal(m.byReq[0].length, 2);
  assert.equal(run(c, `rvResolvePath('index.ts', ['a/index.ts','b/index.ts'])`), null, 'dois arquivos com o mesmo nome: não chuta');
  assert.equal(run(c, `rvResolvePath('b/index.ts', ['a/index.ts','b/index.ts'])`), 'b/index.ts');
  assert.equal(run(c, `rvMap([{ text:'R1', code:[{ file:'src/nao-mudou.ts' }] }], F).byReq[0].length`), 0, 'arquivo que não mudou não liga nada');
});

test('sem mapa, citado na prova (arquivo:linha) → ligação "estimada"; o resto fica "não classificado" (nunca "fora")', () => {
  const c = ctx(); c.F = files(c);
  const m = run(c, `rvMap([{ text:'R1', evidence:['proof-1.png'], note:'o botão está em src/pages/Agenda.tsx:86' }, { text:'R2', evidence:['tests.md'] }], F)`);
  assert.equal(m.explicit, false);
  assert.equal(m.byReq[0].length, 1); assert.equal(m.byReq[0][0].how, 'estimado'); assert.equal(m.byReq[0][0].a, 85);
  assert.equal(m.byReq[1].length, 0, 'nada citado: nada ligado (não inventa)');
  assert.equal(m.out.length, 0);
  assert.equal(m.unc.length, 2);
});

test('nada registrado nem citado: tudo em "não classificado"', () => {
  const c = ctx(); c.F = files(c);
  const m = run(c, `rvMap([{ text:'R1' }, { text:'R2', code:[] }], F)`);
  assert.equal(m.explicit, false);
  assert.equal(m.unc.length, 3); assert.equal(m.total, 3);
  assert.deepEqual(run(c, `rvMap([], [])`), { explicit: false, byReq: [], out: [], unc: [], total: 0 });
});

test('aceite vale até o código do requisito mudar (assinatura dos trechos); carregando não derruba', () => {
  const c = ctx(); c.F = files(c);
  const sig = run(c, `rvSig(rvMap([{ text:'R1', code:[{ file:'Agenda.tsx' }] }], F).byReq[0])`);
  assert.equal(run(c, `rvAccOf({ at:1, sig:${JSON.stringify(sig)} }, ${JSON.stringify(sig)}, true)`), 'acc');
  c.F2 = vm.runInContext(`[{ path:'src/pages/Agenda.tsx', hunks:diffHunks(${JSON.stringify(DIFF_AGENDA.replace('Remarcar</Button>', 'Remarcar aula</Button>'))}).hunks }]`, c);
  const sig2 = run(c, `rvSig(rvMap([{ text:'R1', code:[{ file:'Agenda.tsx' }] }], F2).byReq[0])`);
  assert.notEqual(sig2, sig);
  assert.equal(run(c, `rvAccOf({ at:1, sig:${JSON.stringify(sig)} }, ${JSON.stringify(sig2)}, true)`), 'stale');
  assert.equal(run(c, `rvAccOf({ at:1, sig:${JSON.stringify(sig)} }, ${JSON.stringify(sig2)}, false)`), 'acc', 'diffs carregando');
  assert.equal(run(c, `rvAccOf(null, 'x', true)`), '');
  // a chave do trecho não depende do número da linha (deslocou = mesmo trecho)
  const k1 = run(c, `rvHunkKey('a.ts', { rows:[{t:'ctx',n:1,text:'x'},{t:'add',n:2,text:'y'}] })`);
  const k2 = run(c, `rvHunkKey('a.ts', { rows:[{t:'ctx',n:40,text:'z'},{t:'add',n:41,text:'y'}] })`);
  assert.equal(k1, k2);
});

test('comentário do revisor com arquivo:linha fica preso ao trecho; sem casar vai pra lista geral', () => {
  const c = ctx(); c.F = files(c);
  const p = run(c, `rvPinItems(['src/pages/Agenda.tsx:86 — esconda em aula cancelada', 'datas.ts — por que trocar de lib?', 'faltou teste de semana sem vagas', 'Agenda.tsx — revise'], F)`);
  const keys = Object.keys(p.pins);
  assert.equal(keys.length, 2);
  assert.ok(keys.some(k => k.startsWith('src/pages/Agenda.tsx#')));
  assert.ok(keys.some(k => k.startsWith('src/lib/datas.ts#')), 'arquivo com 1 trecho só: prende sem linha');
  assert.deepEqual(p.loose, ['faltou teste de semana sem vagas', 'Agenda.tsx — revise'], 'arquivo com 2 trechos e sem linha: não chuta');
});

test('portões: bloqueado diz o que falta; tudo verde libera; sem revisor/checagens não bloqueia', () => {
  const c = ctx();
  const blocked = run(c, `rvGatesOf({ proof:{ st:'unproven', n:3, missing:1 }, acc:{ n:3, done:2, first:'R3' }, rev:{ has:true, rounds:[{ round:1, verdict:'muda', items:['a'] }] }, pr:{ checksTotal:4, checksFail:1, checksPending:0, failing:['lint'], mergeable:'CONFLICTING', base:'main' } })`);
  assert.deepEqual(blocked.map(g => g.st), ['bad', 'wn', 'bad', 'bad', 'bad']);
  assert.equal(blocked[3].val, '3 de 4 · lint falhou');
  assert.equal(run(c, `rvMissingText(${JSON.stringify(blocked)})`), 'Falta: prova de 1 requisito, você aceitar R3, o revisor aprovar, as checagens passarem e resolver o conflito.');
  const green = run(c, `rvGatesOf({ proof:{ st:'proven', n:3, missing:0 }, acc:{ n:3, done:3 }, rev:{ has:true, rounds:[{ round:1, verdict:'muda', items:['a'] }, { round:2, verdict:'aprova', items:[] }] }, pr:{ checksTotal:4, checksFail:0, checksPending:0, mergeable:'MERGEABLE', base:'main' } })`);
  assert.deepEqual(green.map(g => g.st), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(green[2].val, 'aprovou na rodada 2');
  assert.equal(run(c, `rvMissingText(${JSON.stringify(green)})`), '');
  assert.equal(run(c, `rvMissingText(${JSON.stringify(green)}, 'o PR está em rascunho')`), 'Falta: o PR está em rascunho.');
  const na = run(c, `rvGatesOf({ proof:{ st:'none', n:0 }, acc:{ n:0, done:0 }, rev:{ has:false, rounds:[] }, pr:{ checksTotal:2, checksFail:0, checksPending:1, mergeable:'UNKNOWN' } })`);
  assert.deepEqual(na.map(g => g.st), ['na', 'na', 'na', 'run', 'run']);
  assert.equal(run(c, `rvMissingText(${JSON.stringify(na)})`), '', 'andando/não se aplica não bloqueia');
  const ov = run(c, `rvGatesOf({ proof:{ st:'override', n:2, missing:1 }, acc:{ n:2, done:1, stale:1 }, rev:{ has:true, rounds:[{ round:2, verdict:'muda', items:['x'] }], override:true }, pr:{ mergeable:'MERGEABLE' } })`);
  assert.equal(ov[0].st, 'ok'); assert.equal(ov[2].st, 'ok', 'seguir sem nova revisão (com motivo) libera');
  assert.match(ov[1].val, /1 mudou depois/);
});

test('cada portão vermelho tem a própria saída (conflito → resolver com IA; checagens → pedir correção)', () => {
  const c = ctx();
  assert.match(run(c, `prvGateExit({ id:'conflito', st:'bad' })`), /data-prvx="conflito"/);
  assert.match(run(c, `prvGateExit({ id:'checks', st:'bad' })`), /data-prvx="checks"/);
  assert.match(run(c, `prvGateExit({ id:'prova', st:'bad' })`), /data-prvx="prova"[\s\S]*data-prvx="semprova"/);
  assert.match(run(c, `prvGateExit({ id:'aceite', st:'wn' }, { i:2 })`), /revisar R3/);
  assert.equal(run(c, `prvGateExit({ id:'checks', st:'ok' })`), '');
  assert.equal(run(c, `prvGateExit({ id:'checks', st:'run' })`), '');
});

test('fiação: script e css no index, despacho da Revisão, merge passa pelos portões, sem window.confirm', () => {
  const html = rd('../src/index.html');
  assert.match(html, /<script src="js\/63-revisao-pr\.js"><\/script>/);
  assert.match(html, /href="css\/97-revisao-pr\.css"/);
  assert.match(ws, /rvViewOf\(t\.id\)!=='diff'\) rvRender\(t, main\); else fwRenderDiff\(t, main\)/, '"ver diff completo" mantém o diff de antes');
  assert.match(ws, /prvRender\(t, main, info\)/);
  const pr = rd('../src/js/21-pull-request.js');
  assert.match(pr, /async function mergePr\(taskId\)\{[\s\S]{0,400}prvMergeWhy\(t, prCache\[taskId\]\)/);
  assert.doesNotMatch(src, /window\.confirm|[^.\w]confirm\(/);
  assert.match(rd('../src-tauri/src/lib.rs'), /#\[tauri::command\(async\)\]\nfn review_state_set/);
  assert.match(rd('../src-tauri/src/lib.rs'), /#\[tauri::command\(async\)\]\nfn review_state_get/);
});
