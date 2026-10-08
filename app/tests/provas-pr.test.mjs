// Provas no PR (app): assinatura das provas, quando sincronizar, a pergunta do repositório público e a fiação
// (abrir PR pergunta antes do corpo; relatório leva os links; aba PR sincroniza só quando muda; comandos async).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = rd('../src/js/60-provas-pr.js');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const c = vm.createContext({});
vm.runInContext(cut(src, '// @provas-puro-inicio', '// @provas-puro-fim'), c);
const run = (code) => vm.runInContext(code, c);

test('assinatura: só requisito provado + imagem/vídeo, ordenada (ordem não muda a assinatura)', () => {
  const rows = [
    { st: 'ok', evidence: ['b.png', 'tests.md'] },
    { st: 'ok', evidence: ['a.MP4'] },
    { st: 'blk', evidence: ['c.png'] },
    { st: 'na', evidence: [] },
  ];
  assert.equal(run(`provasSigOf(${JSON.stringify(rows)})`), 'a.MP4|b.png');
  assert.equal(run(`provasSigOf(${JSON.stringify([rows[1], rows[0]])})`), 'a.MP4|b.png');
  assert.equal(run('provasSigOf([])'), '');
});

test('sincroniza só quando a assinatura muda, ou falhou há mais de 10 min (nunca em loop)', () => {
  const now = 1_000_000_000;
  assert.equal(run(`provasNeedSync(null, 'a.png', ${now})`), true);
  assert.equal(run(`provasNeedSync({ sig:'a.png', at:${now} }, 'a.png', ${now})`), false);
  assert.equal(run(`provasNeedSync({ sig:'a.png', at:${now} }, 'a.png|b.png', ${now})`), true);
  assert.equal(run(`provasNeedSync({ sig:'a.png', at:${now}, failed:true }, 'a.png', ${now + 60000})`), false);
  assert.equal(run(`provasNeedSync({ sig:'a.png', at:${now}, failed:true }, 'a.png', ${now + 11 * 60000})`), true);
  assert.equal(run(`provasNeedSync(null, '', ${now})`), false, 'sem prova de imagem: nada a fazer');
});

test('pergunta do repositório público: honesta (quem vê, o que pode vazar, onde trocar)', () => {
  const pub = run("provasAskText('PUBLIC')");
  assert.match(pub, /PÚBLICO/);
  assert.match(pub, /qualquer pessoa/);
  assert.match(pub, /dados de clientes, e-mails ou caminhos/);
  assert.match(pub, /Projeto › Regras › Provas no PR/);
  assert.match(run("provasAskText('')"), /Não deu pra confirmar se o repositório é privado/);
});

test('fiação: askYes (nunca confirm), abrir PR anexa ANTES do corpo, relatório leva links, aba PR só repinta quando sincronizou', () => {
  assert.doesNotMatch(src, /window\.confirm|[^.]\bconfirm\(/, 'pergunta só pelo askYes');
  assert.match(src, /await askYes\(provasAskText\(r\.visibility\)/);
  assert.match(src, /invokeQuiet\('pr_attach_proofs'/);
  const pr = rd('../src/js/21-pull-request.js');
  const fin = cut(pr, 'async function prPrepFinish', 'async function openPr(');
  const a = fin.indexOf('provasAttach(t, { ask:true })'), b = fin.indexOf("invoke('pr_body_ai'");
  assert.ok(a > 0 && b > a, 'provas antes do corpo do PR');
  assert.ok(fin.indexOf("invoke('push_task'") < a, 'depois do push da branch');
  const ciclo = rd('../src/js/60-ciclo.js');
  assert.match(cut(ciclo, 'function cicloReportFor', '// ---------- a faixa'), /proofs:pv&&pv\.links/);
  assert.match(rd('../src/js/63-revisao-pr.js'), /provasSyncOpenPr\(t\)\.then\(did=>\{ if\(did\) lastSig=''; \}\)/);
  assert.match(src, /async function provasSyncOpenPr[\s\S]*?return false;[\s\S]*?return true;\n\}/);
  assert.match(rd('../src/js/42-nuvem-sync-mobile.js'), /await provasAttach\(t\); \}catch/);
  const html = rd('../src/index.html');
  assert.match(html, /<script src="js\/60-provas-pr\.js"><\/script>/);
  assert.match(html, /id="prefsProvasHost"/);
  assert.match(rd('../src/js/12-chat-prefs-daily.js'), /provasPrefsRender\(repoPath\)/);
});

test('Rust: os 3 comandos são async (rede/git fora da thread da janela) e registrados', () => {
  const rs = rd('../src-tauri/src/lib.rs');
  for (const f of ['pr_attach_proofs', 'pr_update_report', 'provas_setting']) {
    assert.match(rs, new RegExp(`#\\[tauri::command\\(async\\)\\]\\nfn ${f}\\(`), f + ' async');
    assert.match(rs, new RegExp(`\\n\\s+${f},\\n`), f + ' no generate_handler');
  }
  assert.match(rs, /"pr-provas"\.into\(\)/);
  assert.match(rs, /output_timeout\(c, 300\)/);
});

// ---- comportamento (o arquivo inteiro numa vm, com invokeQuiet/askYes/localStorage falsos) ----
function appCtx({ replies, yes = true, rows }) {
  const calls = [], asked = [], store = {};
  const ctx = vm.createContext({
    calls, asked, store, console, Date, JSON, Object, Map, Set, Promise,
    lsGet: (k) => (k in store ? store[k] : null), lsSet: (k, v) => { store[k] = v; },
    localStorage: { get length() { return Object.keys(store).length; }, key: (i) => Object.keys(store)[i], removeItem: (k) => { delete store[k]; } },
    reqRows: () => rows,
    invokeQuiet: async (cmd, args) => { calls.push([cmd, args]); const r = replies.shift(); if (r instanceof Error) throw r; return typeof r === 'function' ? r(cmd, args) : r; },
    askYes: async (msg) => { asked.push(msg); return yes; },
    toast: () => {}, errText: (e) => String(e && e.message || e), errFirstLine: (s) => String(s).split('\n')[0],
    cicloReportFor: () => '\n\n## Relatório Starfork\n\nx\n', window: {}, state: { tasks: [] },
  });
  vm.runInContext(src, ctx);
  return ctx;
}
const T = { id: 't1' };
const ROWS = [{ st: 'ok', evidence: ['a.png'] }];

test('público sem decisão: abrir o PR pergunta e manda decide=on (sim) / off (não); sem ask só guarda needConfirm', async () => {
  for (const [yes, dec] of [[true, 'on'], [false, 'off']]) {
    const c = appCtx({ rows: ROWS, yes, replies: [{ links: {}, note: 'provas não anexadas: …', needConfirm: true, visibility: 'PUBLIC' }, { links: yes ? { 'a.png': { url: 'u', kind: 'img' } } : {}, note: '' }] });
    const v = await vm.runInContext('provasAttach(' + JSON.stringify(T) + ', { ask:true })', c);
    assert.equal(c.asked.length, 1);
    assert.match(c.asked[0], /PÚBLICO/);
    assert.deepEqual(JSON.parse(JSON.stringify(c.calls[1])), ['pr_attach_proofs', { taskId: 't1', decide: dec }]);
    assert.equal(Object.keys(v.links).length, yes ? 1 : 0);
    assert.equal(v.needConfirm, false);
  }
  const c = appCtx({ rows: ROWS, replies: [{ links: {}, note: 'provas não anexadas', needConfirm: true, visibility: 'PUBLIC' }] });
  const v = await vm.runInContext('provasAttach(' + JSON.stringify(T) + ')', c);
  assert.equal(c.asked.length, 0, 'sem ask não pergunta');
  assert.equal(v.needConfirm, true);
  assert.match(vm.runInContext("provasConfirmHtml({ id:'t1' })", Object.assign(c, { esc: (s) => s, escA: (s) => s })), /publicar as provas…/);
});

test('falha: nota "não consegui anexar as provas (…)" com failed=true (o erro do motor e a nota do próprio motor)', async () => {
  const c = appCtx({ rows: ROWS, replies: [new Error('timeout do git\nmais')] });
  const v = await vm.runInContext('provasAttach(' + JSON.stringify(T) + ')', c);
  assert.equal(v.note, 'não consegui anexar as provas (timeout do git)');
  assert.equal(v.failed, true);
  // a nota que o motor devolve (src/pr-provas.ts) também marca falha — o app tenta de novo depois de 10 min
  const motor = readFileSync(new URL('../../src/pr-provas.ts', import.meta.url), 'utf8');
  const note = motor.match(/note: `(não consegui anexar as provas \(\$\{short\(e\)\}\))`/)[1].replace('${short(e)}', 'x');
  const c2 = appCtx({ rows: ROWS, replies: [{ links: {}, note }] });
  assert.equal((await vm.runInContext('provasAttach(' + JSON.stringify(T) + ')', c2)).failed, true);
});

test('aba PR: só sincroniza com assinatura nova (relatório reescrito com a URL), e trocar a opção do projeto esquece o cache', async () => {
  const c = appCtx({ rows: ROWS, replies: [{ links: { 'a.png': { url: 'u', kind: 'img' } }, note: '' }, { changed: true }] });
  c.prCache = { t1: { url: 'https://github.com/o/r/pull/9' } };
  assert.equal(await vm.runInContext('provasSyncOpenPr({ id:"t1" })', c), true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls.map((x) => x[0]))), ['pr_attach_proofs', 'pr_update_report']);
  assert.equal(c.calls[1][1].url, 'https://github.com/o/r/pull/9');
  assert.equal(await vm.runInContext('provasSyncOpenPr({ id:"t1" })', c), false, 'mesma assinatura: nada');
  assert.equal(c.calls.length, 2);
  vm.runInContext('provasResetAll()', c);
  assert.equal(Object.keys(c.store).length, 0);
  assert.equal(vm.runInContext('provasOf("t1")', c), null);
});

test('mesmas regras dos dois lados: extensões de mídia (app) ≡ proofKind (motor); chave do .git/config igual no Rust e no TS', () => {
  const motor = readFileSync(new URL('../../src/pr-provas.ts', import.meta.url), 'utf8');
  const ext = (re) => re.match(/\(([a-z?|]+)\)\$/)[1];
  assert.equal(ext(motor.match(/if \(\/\\\.(\([^)]+\)\$)\/\.test\(n\)\) return "img"/)[0].replace(/^.*?\\\./, '')), 'png|jpe?g|gif|webp');
  const media = src.match(/PROVAS_MEDIA=\/\\\.\(([^)]+)\)\$\/i/)[1];
  assert.equal(media, 'png|jpe?g|gif|webp|mp4|mov');
  assert.match(motor, /\/\\\.\(mp4\|mov\)\$\/\.test\(n\)\) return "video"/);
  assert.match(motor, /PROVAS_SETTING_KEY = "starfork\.provasNoPr"/);
  assert.match(readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'), /const PROVAS_SETTING_KEY: &str = "starfork\.provasNoPr";/);
});
