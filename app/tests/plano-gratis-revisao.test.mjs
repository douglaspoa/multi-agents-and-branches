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
