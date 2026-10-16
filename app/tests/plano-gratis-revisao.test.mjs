// PLANO GRÁTIS — revisão adversarial da F1: um teste por correção.
// `node --test app/tests/plano-gratis-revisao.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const onb = read('js/44-onboarding.js');

test('1 · nova senha da recuperação: não herda o "voltar" do entrar, salva → pós-login, voltar → sai da sessão do código', () => {
  assert.match(onb, /if\(ct==='recovery'\)\{ auShow\('newpass',\{ backTo:null, recovering:true \}\); return; \}/);
  const np = cut(onb, 'function auRenderNewpass(', '\n// Tela "pronto"');
  assert.match(np, /if\(au\.backTo && !au\.recovering\)\{/, 'o backTo só vale fora da recuperação (trocar senha em Ajustes)');
  assert.match(np, /au\.recovering=false; au\.backTo=null; await auAfterSession\(\);/);
  assert.match(cut(onb, "bindClick('auBack',", '\n'), /if\(au\.step==='newpass' && au\.recovering\)\{ au\.recovering=false; sbLogout\(\); \}/);
  assert.match(read('js/67-ajustes.js'), /auShow\('newpass', \{ backTo:\(\)=>ajustesOpen\('perfil'\), recovering:false \}\)/);
});

test('7 · userRepoSync: a trava repoSyncBusy roda (estava engolida pelo comentário da guarda do Grátis)', () => {
  const fn = cut(read('js/41-assinatura-chaves.js'), 'async function userRepoSync(){', '\n  try{');
  assert.match(fn, /\n  repoSyncBusy=true;$/, 'a trava fica na própria linha');
  assert.doesNotMatch(fn, /\/\/[^\n]*repoSyncBusy=true/);
  // a varredura do atrap-fabrica agora pega atribuição solta no fim do comentário
  assert.match(readFileSync(new URL('./atrap-fabrica.test.mjs', import.meta.url), 'utf8'), /\(true\|false\|null\|\\d\+\|'\[\^'\]\*'\|\\\[\\\]\|\\\{\\\}\);\\s\*\$/);
});

test('2 · sair/sessão caída zera billingOn e billingKnown (Enterprise que entra depois não cai no local)', () => {
  const nuvem = read('js/40-nuvem-conta.js');
  for (const fn of ['function sbLogout(){', 'function sbSessionEnded(reason){'])
    assert.match(cut(nuvem, fn, '\n}'), /billingOn=false; billingKnown=false;/, fn);
  // efeito: com billingOn=false, billingActive() é true → logado = nuvem até o billingSync decidir
  const ba = new Function('let billingOn=true, myBilling=null;' + cut(read('js/41-assinatura-chaves.js'), 'function billingActive(){', '\n') + ' const a=!!billingActive(); billingOn=false; return [a, !!billingActive()];')();
  assert.deepEqual(ba, [false, true]);
});

test('8 · epicAutoStart é tick com parte local (rascunhos do "Iniciar épico" rodam no Grátis)', () => {
  const ep = read('js/46-epico-time.js');
  assert.match(ep, /tickLoop\('epicAutoStart', epicAutoStartTick, \(\)=>epAutoIdle\?60000:20000, 3000, \{ local:true \}\);/);
  assert.match(cut(ep, 'async function epicAutoStartTick(){', '\n  epAutoBusy=true;'), /epAutoLocalTick\(\);[\s\S]*!cloudScopeOk\(\)\) return;/, 'a parte de nuvem continua guardada');
});
