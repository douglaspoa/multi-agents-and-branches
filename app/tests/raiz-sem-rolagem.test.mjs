// a raiz do app nunca rola: rolada por código (focus do terminal, scrollIntoView), a barra de abas saía da janela e a
// lista de trás aparecia por cima da tarefa (as telas são position:fixed e não acompanham).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css=readFileSync(new URL('../src/css/10-base.css', import.meta.url), 'utf8');
const js=readFileSync(new URL('../src/js/00-util.js', import.meta.url), 'utf8');
test('html/body com overflow:hidden', ()=>{ assert.match(css, /html,body\{[^}]*overflow:hidden/); });
test('rolagem da raiz volta a 0', ()=>{
  const m=js.match(/function rootScrollReset\(\)\{[\s\S]*?\n/); assert.ok(m);
  const se={ scrollTop:40, scrollLeft:3 }, body={ scrollTop:12, scrollLeft:0 };
  const document={ scrollingElement:se, documentElement:se, body };
  new Function('document', m[0]+'rootScrollReset();')(document);
  assert.equal(se.scrollTop, 0); assert.equal(se.scrollLeft, 0); assert.equal(body.scrollTop, 0);
  assert.match(js, /addEventListener\('scroll'[^\n]*rootScrollReset\(\)/);
});
