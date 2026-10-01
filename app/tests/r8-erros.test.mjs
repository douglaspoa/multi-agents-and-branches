// R8 (erros-e-pendencias): aviso do painel de issues em 2º plano (lista de classes) e o Daily com erro
// (seletor de data inserido uma vez, data apagada volta, erro também no prazo estourado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const noop = () => {};
const ctx = { window: { addEventListener: noop }, document: { getElementById: () => null, addEventListener: noop },
  localStorage: { getItem: () => null, setItem: noop }, navigator: { platform: 'MacIntel', userAgent: '' }, console };
vm.createContext(ctx);
vm.runInContext(read('00-util.js'), ctx);

const iss = read('14-issues-projeto.js');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
vm.runInContext(cut(iss, '// @puro-trkbg-inicio', '// @puro-trkbg-fim') + '\nthis.trkBgWhy=trkBgWhy;', ctx);

test('trkBgWhy: rede/servidor/JSON/permissão usam o catálogo', () => {
  assert.match(ctx.trkBgWhy(new TypeError('Failed to fetch')), /Sem conexão/);
  assert.match(ctx.trkBgWhy('HTTP 502: Bad Gateway'), /servidor/);
  assert.match(ctx.trkBgWhy('HTTP 403 Forbidden'), /Sem permissão/);
});
test('trkBgWhy: classes do GitHub/git não valem pra painel externo (mostra o texto do painel)', () => {
  assert.equal(ctx.trkBgWhy('401 Unauthorized: requires authentication'), '401 Unauthorized: requires authentication');
  assert.equal(ctx.trkBgWhy('not a git repository'), 'not a git repository');
  assert.match(ctx.trkBgWhy('SECRET_MISSING:JIRA_TOKEN'), /Falta a chave JIRA_TOKEN/);
});

// ---- Daily: cabeçalho com o seletor de data em cima do erro ----
function fakeEl(tag) {
  const el = { tag, children: [], innerHTML: '', value: '', onchange: null, className: '', style: {},
    insertBefore(n, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; },
    querySelector(sel) {
      if (sel === ':scope>.ld-err') return this.children.find(c => c.className === 'ld-err') || null;
      if (sel === '#dlDate') { for (const c of this.children) { if (c.dl) return c.dl; } return null; }
      return null;
    } };
  return el;
}
const daily = read('12-chat-prefs-daily.js');
const fnSrc = cut(daily, 'function dailyErrHead(iso){', '\nfunction renderDaily(){');
function mkDaily() {
  const body = fakeEl('div'); const err = fakeEl('div'); err.className = 'ld-err'; body.children.push(err);
  const hidden = { value: '' }; let loads = 0;
  const document = { createElement: () => { const h = fakeEl('div'); h.dl = { value: '', onchange: null };
    Object.defineProperty(h, 'innerHTML', { set(v) { const m = v.match(/value="([^"]*)"/); h.dl.value = m ? m[1] : ''; }, get() { return ''; } });
    h.querySelector = s => s === '#dlDate' ? h.dl : null; return h; } };
  const $id = id => id === 'dailyBody' ? body : id === 'dailyDate' ? hidden : null;
  const f = new Function('$id', 'document', 'escA', 'loadDaily', fnSrc + '\nreturn dailyErrHead;')($id, document, s => String(s), () => { loads++; });
  return { f, body, hidden, loads: () => loads };
}
test('dailyErrHead: insere o seletor uma vez só, acima do erro', () => {
  const d = mkDaily();
  d.f('2026-09-28'); d.f('2026-09-28');
  assert.equal(d.body.children.length, 2);
  assert.equal(d.body.children[1].className, 'ld-err');
  assert.equal(d.body.querySelector('#dlDate').value, '2026-09-28');
});
test('dailyErrHead: trocar a data recarrega; apagar a data volta pro dia que falhou', () => {
  const d = mkDaily(); d.f('2026-09-28');
  const inp = d.body.querySelector('#dlDate');
  inp.value = ''; inp.onchange();
  assert.equal(inp.value, '2026-09-28'); assert.equal(d.loads(), 0);
  inp.value = '2026-09-27'; inp.onchange();
  assert.equal(d.hidden.value, '2026-09-27'); assert.equal(d.loads(), 1);
});
test('Daily: prazo estourado também resolve "fail" (o loadDaily põe o seletor nesse caso)', async () => {
  assert.match(daily, /\.then\(st=>\{ if\(st==='fail' && gen===dailyGen\) dailyErrHead\(iso\); \}\)/);
  const car = read('06-carregamento.js');
  const c2 = { setTimeout, clearTimeout, Promise, console };
  vm.createContext(c2);
  vm.runInContext(cut(car, 'const LD_MS', '// @puro-fim') + '\nthis.ldRun=ldRun;', c2);
  const st = await c2.ldRun(() => new Promise(() => {}), {}, { timeout: 20 });
  assert.equal(st, 'fail');
});
