// Grupo de abas (pedido do Douglas, 03/10): a tela dividida aparece na barra de cima como UMA aba — estilo grupo
// de abas do Chrome — com um segmento por membro (ícone + nome, "|" fino entre eles, × em cada um). Fechar um membro
// tira ele do grupo e da tela; sobrou 1 → vira aba normal. Desagrupar / tirar do grupo / arrastar / teclado / salvo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const cvp = read('js/19-canvas-puro.js'), canvas = read('js/58-canvas.js'), tabsJs = read('js/15-config-abas-onboarding.js'), css = read('css/92-canvas.css');
const PURE = cut(cvp, '// @canvas-puro-inicio', '// @canvas-puro-fim');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = (s) => esc(s).replace(/"/g, '&quot;');
const P = new Function('esc', 'escA', PURE + cut(canvas, '// @grupo-abas-inicio', '// @grupo-abas-fim') +
  '\nreturn { CV_VER, CV_MAX_PANES, cvStripItems, cvGroupContig, cvGroupLeave, cvGroupDrop, cvGroupKey, cvGroupLabel, cvGroupHtml, cvSplitValid };')(esc, escA);

// mini-app: TABS + SPL + closeTab/tabMove de verdade (15) e a lógica do grupo de verdade (58), o resto vira stub
function app(tabIds, groupIds, active, focus) {
  const env = { activated: [], disposed: [], store: {}, toasts: [] };
  const code = cut(canvas, 'function cvTask(id)', '// boot: a divisão salva volta') +
    cut(tabsJs, 'function closeTab(id){', '// R7: reordenar abas') + cut(tabsJs, 'function tabDropAfter', '// fecha uma aba passando');
  const f = new Function('env', `
    let TABS=env.tabs, activeTab=env.active; const state={ tasks:[{id:'A',title:'Login'},{id:'B',title:'Checkout'},{id:'C',title:'Busca'}], repo:'r' };
    const SPL={ ids:env.ids, w:null, focus:env.focus, panes:{}, docs:{}, menu:null, dragId:null };
    for(const id of (env.ids||[])) SPL.panes[id]={ id };
    const CV_VER=2, CV_MAX_PANES=3, CV_SPLIT_KINDS=['task','web','device','doc'], VIEW_OVERLAY={}, VIEW_META={};
    const localStorage={ setItem(k,v){ env.store[k]=v; }, removeItem(k){ delete env.store[k]; }, getItem(k){ return env.store[k]??null; } };
    function $id(){ return { style:{ display:'block' } }; }
    function tabById(id){ return TABS.find(t=>t.id===id); }
    function cvTabDesc(t){ return t?{ kind:t.kind, taskId:t.taskId }:null; }
    function cvSplitAdd(ids, base, id, side){ let l=ids&&ids.length?ids.slice():[base]; l=l.filter(x=>x!==id); if(l.length>=3) return null; side==='left'?l.unshift(id):l.push(id); return l; }
    ${cut(PURE, 'function cvGroupContig', 'function cvGroupDrop')}
    function cvPaneDispose(id){ env.disposed.push(id); delete SPL.panes[id]; }
    function renderTabs(){} function showActiveView(){} function toast(m){ env.toasts.push(m); }
    function activateTab(id){ activeTab=id; env.activated.push(id); }
    async function tabCloseGuarded(id){ closeTab(id); return true; }
    ${code}
    return { SPL, env, get TABS(){ return TABS; }, get activeTab(){ return activeTab; }, closeTab, cvUnsplit, cvGroupUngroup, cvGroupCloseAll, cvGroupAdd, cvGroupEject, cvGroupMember, cvGroupContigTabs, cvSplitWith, cvOnTabClosed };`);
  env.tabs = tabIds.map((id) => ({ id, kind: id === 'flow' ? 'flow' : id.split(':')[0], taskId: id.startsWith('task:') ? id.slice(5) : undefined, pin: id === 'flow', title: id }));
  env.ids = groupIds; env.active = active; env.focus = focus | 0;
  return f(env);
}
const saved = (a) => a.env.store['cv:split'] ? JSON.parse(a.env.store['cv:split']) : null;

test('aba-grupo: UMA aba (role=tab) com um segmento por membro, "|" fino entre eles, × em cada um, segmento em foco aceso', () => {
  const m = [{ id: 'task:A', title: 'Login <novo>', icon: '<path d="M1 1"/>', kind: 'Tarefa' }, { id: 'web:x', title: 'youtube.com', icon: '', kind: 'Navegador' }];
  const h = P.cvGroupHtml(m, { on: true, focus: 1, color: 'hsl(120 72% 62%)', x: '<svg class="ix"></svg>' });
  assert.equal((h.match(/role="tab"/g) || []).length, 1, 'uma parada só pro leitor de tela / Tab');
  assert.match(h, /^<span class="tab tgroup on" data-tg="1" role="tab" tabindex="0" aria-selected="true"/);
  assert.equal((h.match(/class="tgseg( cur)?"/g) || []).length, 2);
  assert.equal((h.match(/class="tgsep"/g) || []).length, 1, 'n-1 divisórias');
  assert.match(h, /data-segx="task:A"[\s\S]*data-segx="web:x"/, 'cada segmento fecha só o seu membro');
  assert.match(h, /class="tgseg cur" data-seg="web:x"/, 'o segmento do painel em foco acende');
  assert.match(h, /Login &lt;novo&gt;/, 'título escapado'); assert.ok(!h.includes('<novo>'));
  assert.match(h, /style="--tg:hsl\(120 72% 62%\);--n:2"/, 'cor da 1ª demanda');
  assert.match(h, /aria-label="grupo de 2 abas lado a lado: Login &lt;novo&gt;, youtube\.com\. Em foco: youtube\.com \(2 de 2\)/);
  assert.match(h, /<span class="tgsegs" aria-hidden="true">/, 'controles dentro de role=tab ficam fora da árvore (como o × das abas)');
  assert.match(h, /class="tgchip" data-tgmenu="1" aria-hidden="true"/);
  const h3 = P.cvGroupHtml([...m, { id: 'doc:y', title: 'README.md', kind: 'Documento' }], { on: false, focus: 0 });
  assert.equal((h3.match(/class="tgsep"/g) || []).length, 2); assert.match(h3, /tabindex="-1" aria-selected="false"/);
  assert.match(h3, /--tg:var\(--accent\)/, 'sem demanda no grupo: cor do app');
  assert.ok(!/\|<\/span>|>\|</.test(h3), 'o "|" é um traço desenhado (tgsep), não um caractere');
});

test('barra: o grupo aparece UMA vez no lugar do 1º membro; grupo com < 2 = abas soltas; membros ficam colados', () => {
  assert.deepEqual(P.cvStripItems(['flow', 'task:A', 'cfg', 'web:x'], ['task:A', 'web:x']), [{ id: 'flow' }, { group: ['task:A', 'web:x'] }, { id: 'cfg' }]);
  assert.deepEqual(P.cvStripItems(['flow', 'task:A'], ['task:A', 'web:sumiu']), [{ id: 'flow' }, { id: 'task:A' }], 'membro que não existe mais não forma grupo');
  assert.deepEqual(P.cvStripItems(['flow', 'a'], null), [{ id: 'flow' }, { id: 'a' }]);
  assert.deepEqual(P.cvGroupContig(['flow', 'a', 'x', 'b', 'y'], ['b', 'a']), ['flow', 'b', 'a', 'x', 'y'], 'na ordem do grupo, no lugar do 1º');
  const a = app(['flow', 'task:A', 'cfg', 'task:B'], null, 'task:A');
  a.cvSplitWith('task:A', 'task:B', 'right');
  assert.deepEqual(a.TABS.map((t) => t.id), ['flow', 'task:A', 'task:B', 'cfg'], 'ao agrupar, os membros encostam');
});

test('fechar UM membro: sai do grupo e da tela, os outros se rearranjam e o foco vai pro vizinho', () => {
  assert.deepEqual(P.cvGroupLeave(['a', 'b', 'c'], 'b', 1), { ids: ['a', 'c'], focus: 1, next: 'c' });
  assert.deepEqual(P.cvGroupLeave(['a', 'b', 'c'], 'a', 2), { ids: ['b', 'c'], focus: 1, next: 'c' }, 'foco fica no mesmo painel');
  assert.deepEqual(P.cvGroupLeave(['a', 'b', 'c'], 'c', 2), { ids: ['a', 'b'], focus: 1, next: 'b' });
  assert.equal(P.cvGroupLeave(['a', 'b'], 'z', 0), null);
  const a = app(['flow', 'task:A', 'task:B', 'task:C'], ['task:A', 'task:B', 'task:C'], 'task:B', 1);
  a.closeTab('task:B');
  assert.deepEqual(a.SPL.ids, ['task:A', 'task:C']); assert.equal(a.activeTab, 'task:C', 'a tela continua no grupo');
  assert.ok(!a.TABS.some((t) => t.id === 'task:B')); assert.ok(a.env.disposed.includes('task:B'), 'o painel dele solta tudo');
  assert.equal(saved(a).panes.length, 2, 'o grupo salvo acompanha');
  // fechar um membro de FUNDO (grupo fora da tela) não muda a aba ativa
  const b = app(['flow', 'cfg', 'task:A', 'task:B', 'task:C'], ['task:A', 'task:B', 'task:C'], 'cfg', 0);
  b.closeTab('task:C'); assert.equal(b.activeTab, 'cfg'); assert.deepEqual(b.SPL.ids, ['task:A', 'task:B']);
  // ⌘W com o grupo na tela fecha o membro EM FOCO
  assert.match(tabsJs, /k==='w' && !e\.shiftKey\)\{ e\.preventDefault\(\); const t=tabById\(\(typeof cvGroupMember==='function' && cvGroupMember\(\)\) \|\| activeTab\)/);
  assert.match(canvas, /if\(k==='w'\)\{ const t=cvTabOf\(cvGroupMember\(\)\|\|activeTab\)/, '⌘W vindo do menu do app (foco no Navegador nativo) também');
  const c = app(['flow', 'task:A', 'web:x'], ['task:A', 'web:x'], 'task:A', 1); assert.equal(c.cvGroupMember(), 'web:x');
});

test('sobrou 1 membro: o grupo se desfaz e ele volta a ser uma aba normal na tela', () => {
  const a = app(['flow', 'task:A', 'task:B'], ['task:A', 'task:B'], 'task:A', 0);
  a.closeTab('task:A');
  assert.equal(a.SPL.ids, null); assert.equal(a.activeTab, 'task:B'); assert.equal(saved(a), null, 'nada salvo');
  assert.ok(a.env.disposed.includes('task:B'), 'a demanda que sobrou volta pra tela dela (o iframe do painel sai)');
  assert.deepEqual(P.cvStripItems(a.TABS.map((t) => t.id), a.SPL.ids), [{ id: 'flow' }, { id: 'task:B' }]);
  assert.deepEqual(P.cvGroupLeave(['a', 'b'], 'a', 0), { ids: null, focus: 0, next: 'b' });
});

test('desagrupar: cada membro vira aba separada e a tela mostra só o que estava em foco; fechar grupo fecha todos', async () => {
  const a = app(['flow', 'task:A', 'web:x', 'task:C'], ['task:A', 'web:x', 'task:C'], 'task:A', 1);
  a.cvGroupUngroup();
  assert.equal(a.SPL.ids, null); assert.equal(a.activeTab, 'web:x'); assert.equal(saved(a), null);
  assert.deepEqual(a.TABS.map((t) => t.id), ['flow', 'task:A', 'web:x', 'task:C'], 'todas continuam abertas');
  assert.deepEqual(a.env.disposed.sort(), ['task:A', 'task:C'], 'só os iframes das demandas saem; o Navegador continua vivo');
  const b = app(['flow', 'task:A', 'task:B', 'cfg'], ['task:A', 'task:B'], 'task:A', 0);
  await b.cvGroupCloseAll();
  assert.deepEqual(b.TABS.map((t) => t.id), ['flow', 'cfg']); assert.equal(b.SPL.ids, null);
  const menu = cut(canvas, 'function cvGroupMenu', '// fiação da aba-grupo');
  for (const l of ["label:'desagrupar'", "label:'fechar grupo'", "label:'adicionar ao grupo…'"]) assert.ok(menu.includes(l), l);
  assert.match(menu, /if\(ids\.length<CV_MAX_PANES\)/, '"adicionar" só com menos de 3');
});

test('tirar do grupo: o membro vira uma aba separada (continua aberta) e o resto do grupo segue na tela', () => {
  const a = app(['flow', 'task:A', 'task:B', 'task:C'], ['task:A', 'task:B', 'task:C'], 'task:A', 0);
  a.cvUnsplit('task:B');
  assert.deepEqual(a.SPL.ids, ['task:A', 'task:C']); assert.ok(a.TABS.some((t) => t.id === 'task:B'));
  assert.equal(a.activeTab, 'task:A');
  assert.deepEqual(P.cvStripItems(a.TABS.map((t) => t.id), a.SPL.ids), [{ id: 'flow' }, { group: ['task:A', 'task:C'] }, { id: 'task:B' }]);
  const seg = cut(canvas, 'function cvSegMenu', '// menu do grupo');
  assert.match(seg, /label:'tirar do grupo'[\s\S]*go:\(\)=>cvUnsplit\(id\)/); assert.match(seg, /label:'fechar'[\s\S]*tabCloseGuarded\(id\)/);
  assert.match(canvas, /title="tirar do grupo \(a aba continua aberta\)"/, 'o × do cabeçalho do painel diz a mesma coisa');
});

test('arrastar: segmento pra barra sai do grupo; aba solta em cima do grupo entra (até 3); metade da tela continua', () => {
  assert.equal(P.cvGroupDrop(['a', 'b'], 'a', false), 'eject');
  assert.equal(P.cvGroupDrop(['a', 'b'], 'x', false), 'move', 'aba comum: reordena como sempre');
  assert.equal(P.cvGroupDrop(['a', 'b'], 'x', true), 'add');
  assert.equal(P.cvGroupDrop(['a', 'b', 'c'], 'x', true), 'full');
  assert.equal(P.cvGroupDrop(['a', 'b'], 'a', true), 'none', 'soltar o segmento no próprio grupo não faz nada');
  const a = app(['flow', 'task:A', 'task:B', 'cfg', 'task:C'], ['task:A', 'task:B'], 'task:A', 0);
  a.cvGroupAdd('task:C');
  assert.deepEqual(a.SPL.ids, ['task:A', 'task:B', 'task:C']); assert.deepEqual(a.TABS.map((t) => t.id), ['flow', 'task:A', 'task:B', 'task:C', 'cfg']);
  a.cvGroupAdd('cfg'); assert.match(a.env.toasts.at(-1), /no máximo 3/);
  a.cvGroupEject('task:B', 'end');
  assert.deepEqual(a.SPL.ids, ['task:A', 'task:C']); assert.equal(a.TABS.at(-1).id, 'task:B', 'solto no espaço livre: vai pro fim');
  const b = app(['flow', 'cfg', 'task:A', 'task:B'], ['task:A', 'task:B'], 'task:A', 0);
  b.cvGroupEject('task:B', 'cfg'); assert.equal(b.SPL.ids, null); assert.deepEqual(b.TABS.map((t) => t.id), ['flow', 'task:B', 'cfg', 'task:A'], 'solto sobre uma aba: fica ali');
  // fiação: segmentos arrastáveis, grupo aceita aba, barra aceita segmento; arrastar pra metade da tela continua
  const w = cut(canvas, 'function cvWireGroup', '// ---------- arrastar uma aba do topo');
  assert.match(w, /s\.addEventListener\('dragstart'[\s\S]*cvTabDragStart\(tabDragId\)/);
  assert.match(w, /else cvGroupAdd\(id\)/); assert.match(w, /cvGroupEject\(id, 'end'\)/);
  assert.match(tabsJs, /cvGroupDrop\(SPL\.ids, from, false\)==='eject'\)\{[^}]*\}? ?cvGroupEject\(from, el\.dataset\.tk\)|cvGroupEject\(from, el\.dataset\.tk\)/);
  assert.match(canvas, /if\(side\) cvSplitWith\(activeTab, id, side\)/, 'soltar na metade da janela ainda divide');
});

test('teclado: a aba-grupo é uma parada; ←/→ trocam o segmento (e o painel), nas pontas saem; Delete fecha; Shift+F10 = menu', () => {
  assert.deepEqual(P.cvGroupKey(3, 0, 'ArrowRight'), { seg: 1 });
  assert.deepEqual(P.cvGroupKey(3, 2, 'ArrowRight'), { out: 1 }, 'última → próxima aba da barra');
  assert.deepEqual(P.cvGroupKey(3, 0, 'ArrowLeft'), { out: -1 });
  assert.deepEqual(P.cvGroupKey(3, 2, 'Home'), { seg: 0 }); assert.deepEqual(P.cvGroupKey(3, 0, 'End'), { seg: 2 });
  assert.deepEqual(P.cvGroupKey(3, 1, 'Delete'), { close: 1 }); assert.deepEqual(P.cvGroupKey(2, 1, 'Backspace'), { close: 1 });
  assert.deepEqual(P.cvGroupKey(2, 0, 'Enter'), { enter: 0 }); assert.equal(P.cvGroupKey(2, 0, 'a'), null);
  assert.match(P.cvGroupLabel(['A', 'B', 'C'], 1), /Em foco: B \(2 de 3\)/);
  const w = cut(canvas, 'function cvWireGroup', '// ---------- arrastar uma aba do topo');
  assert.match(w, /e\.key==='ContextMenu' \|\| \(e\.shiftKey && e\.key==='F10'\)\)\{ e\.preventDefault\(\); cvGroupMenu\(g, null, true\)/);
  assert.match(w, /bar\.querySelectorAll\('\[data-tk\],\[data-tg\]'\)/, 'sai pra aba vizinha');
  assert.match(tabsJs, /const l=\[\.\.\.bar\.querySelectorAll\('\[data-tk\],\[data-tg\]'\)\]/, 'das abas comuns as setas chegam no grupo');
  assert.match(cut(canvas, 'function cvGroupPaintFocus', 'function cvSegMenu'), /setAttribute\('aria-label', cvGroupLabel/, 'o nome acompanha o segmento');
  assert.match(cut(canvas, 'function cvPaneFocus', '// ---------- Navegador'), /cvGroupPaintFocus\(\)/, 'clicar num painel / ⌘1..3 acende o segmento');
  // menu de contexto: role=menu, setas (a11yMenuStep), Esc devolve o foco pra quem abriu
  const ctx = cut(canvas, 'function cvCtxMenu', '// ---------- grupo de abas');
  assert.match(ctx, /role','menu'/); assert.match(ctx, /role="menuitem"/); assert.match(ctx, /cvMenuKeys\(m, anchor\)/);
  assert.match(cut(canvas, 'function cvMenuKeys', '// botão direito'), /a11yMenuStep\(/);
  assert.match(cut(canvas, 'function cvMenuKeys', '// botão direito'), /const a=\(back && back\.isConnected\)\?back:\$id\('tabAdd'\)/);
  assert.match(tabsJs, /if\(g && typeof cvWireGroup==='function'\) cvWireGroup\(g, bar\)/);
});

test('salvo: o grupo volta depois de reiniciar; layout antigo (v1, antes do grupo) ainda carrega', () => {
  const ids = ['A', 'B'];
  const old = P.cvSplitValid('{"v":1,"panes":[{"kind":"task","taskId":"A"},{"kind":"task","taskId":"B"}],"focus":1}', ids);
  assert.deepEqual(old.panes, [{ kind: 'task', taskId: 'A' }, { kind: 'task', taskId: 'B' }]); assert.equal(old.focus, 1); assert.equal(old.v, 2);
  assert.ok(P.cvSplitValid({ v: 2, group: true, panes: [{ kind: 'task', taskId: 'A' }, { kind: 'web', url: 'https://a.com' }] }, ids));
  assert.equal(P.cvSplitValid({ v: 3, panes: [{ kind: 'task', taskId: 'A' }, { kind: 'task', taskId: 'B' }] }, ids), null, 'versão do futuro: sem grupo');
  const a = app(['flow', 'task:A', 'task:B'], null, 'task:A');
  a.cvSplitWith('task:A', 'task:B', 'right');
  assert.deepEqual(saved(a), { v: 2, group: true, panes: [{ kind: 'task', taskId: 'A' }, { kind: 'task', taskId: 'B' }], focus: 1, lay: 'side' }); // layout A: o layout do grupo vai junto
  assert.match(cut(canvas, 'function cvRestoreSplit', '// ---------- mostrar'), /SPL\.focus=s\.focus\|0; cvGroupContigTabs\(\);/, 'restaurado: membros colados de novo');
});

test('Navegador nativo: o menu do grupo/segmento é um .cvmenu no <body> → o webview se esconde enquanto ele está aberto', () => {
  assert.match(cut(canvas, 'function cvCtxMenu', '// ---------- grupo de abas'), /m\.className='cvmenu cvctx'[\s\S]*document\.body\.appendChild\(m\)/);
  assert.match(cut(canvas, 'function cvNatBlocked', 'function cvNatSync'), /body > \.cvmenu/);
  assert.match(canvas, /mo\.observe\(document\.body, \{ childList:true \}\)/, 'abrir/fechar o menu dispara a ressincronização (sem polling)');
  for (const fn of ['function cvSegMenu', 'function cvGroupMenu']) assert.match(cut(canvas, fn, '\n}\n'), /cvCtxMenu\(/, fn);
  assert.match(canvas, /html\.cvdragging|classList\.add\('cvdragging'\)/, 'arrastando segmento também esconde (cvTabDragStart)');
});

test('visual calmo (Impeccable): sem degradê nem brilho; janela estreita encolhe com reticências e mantém ícone e ×', () => {
  const g = css.slice(css.indexOf('/* grupo de abas'), css.indexOf('.cvmsep'));
  assert.ok(g.length > 200);
  assert.ok(!/gradient|text-shadow|box-shadow:0 0/.test(g), 'sem degradê/brilho');
  assert.match(g, /\.tgseg\{[^}]*min-width:58px/); assert.match(g, /\.tgseg \.tt\{[^}]*text-overflow:ellipsis/);
  assert.match(g, /\.tabbar\.crowded \.tab\.tgroup \.tgsegs \.tgseg \.x\{display:inline-flex\}/, 'barra lotada: o × do segmento continua');
  assert.match(g, /\.tgsep\{[^}]*width:1px/); assert.match(g, /var\(--tg\)/);
  assert.ok(!/insplit/.test(css + tabsJs), 'a marquinha antiga de "na divisão" saiu (agora é o grupo)');
});
