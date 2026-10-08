// Provas no PR (app): assinatura das provas, quando sincronizar, a pergunta do repositório público e a fiação
// (abrir PR pergunta antes do corpo; relatório leva os links; aba PR sincroniza só quando muda; comandos async).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = rd('../src/js/70-provas-pr.js');
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
  assert.match(html, /<script src="js\/70-provas-pr\.js"><\/script>/);
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
