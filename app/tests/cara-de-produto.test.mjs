// R8 — cara de produto (F12 da mesa, tela por tela): `node --test app/tests/cara-de-produto.test.mjs`
// Central, barra lateral, barra de status e cabeçalho da Tarefa: glifo de texto não é ícone (vira SVG de IC),
// mono só pra dado técnico, STATUS_META continua a fonte única (agora com a CHAVE do ícone em IC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
// corpo INTEIRO de uma função top-level (balanceando chaves, pulando strings/templates/comentários) — e confere que compila
function fn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'função não encontrada: ' + name);
  let k = s.indexOf('{', s.indexOf(')', i)), depth = 0;
  const stack = []; // contexto: '`' dentro de template, '{' dentro de ${ }
  for (; k < s.length; k++) {
    const c = s[k], top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') { k++; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && s[k + 1] === '{') { stack.push('{'); k++; }
      continue;
    }
    if (c === "'" || c === '"') { const q = c; for (k++; k < s.length && s[k] !== q; k++) if (s[k] === '\\') k++; continue; }
    if (c === '/' && s[k + 1] === '/') { k = s.indexOf('\n', k); continue; }
    if (c === '/' && s[k + 1] === '*') { k = s.indexOf('*/', k) + 1; continue; }
    if (c === '`') { stack.push('`'); continue; }
    if (c === '{') { if (top === '{') stack.push('{'); else depth++; continue; }
    if (c === '}') { if (top === '{') { stack.pop(); continue; } if (--depth === 0) break; }
  }
  const out = s.slice(i, k + 1);
  new Function(out); // se o recorte saiu torto, nem compila
  return out;
}
const core = src('js/10-core.js'), util = src('js/00-util.js');

// IC só com os ícones do R8 (o bloco usa icEm, que vem de antes no 10-core)
// o icEm é o de verdade do 10-core (linha própria, recortada), não uma cópia
const IC = new Function('const IC = {};\n' + cut(core, 'const icEm = ', '\n') + '\n'
  + cut(core, '// @r8-icones-inicio', '// @r8-icones-fim') + '\nreturn { ...IC, icEm };')();
const icEm = IC.icEm; delete IC.icEm;
// STATUS_META + stIcon/stBadge de verdade, com o IC acima
const ST = new Function('IC', cut(util, 'const STATUS_META={', '// ===== toast global')
  + '\nreturn { STATUS_META, stIcon, stBadge, stLabel };')(IC);

// glifos que faziam papel de ícone nas telas desta rodada
const GLYPHS = /[◆◉▾▸▼⌥⚑↗⤢⋯●○✓✕×⊘❚❙▶■↻★⧉↳→▍]/u;

test('IC do R8: SVG de linha 16 px, em 1em, só currentColor', () => {
  for (const [k, v] of Object.entries(IC)) {
    assert.match(v, /^<svg width="1em" height="1em"[^>]* viewBox="0 0 16 16"/, k + ': viewBox 16 em 1em');
    assert.match(v, /aria-hidden="true"/, k);
    assert.doesNotMatch(v, /#[0-9a-f]{3,6}\b/i, k + ': cor vem de quem usa');
  }
});

test('STATUS_META: fonte única, ícone = chave de IC (nada de glifo), significado mantido', () => {
  const { STATUS_META, stIcon, stBadge } = ST;
  for (const [st, m] of Object.entries(STATUS_META)) {
    assert.ok(IC[m.ic], st + ': ic "' + m.ic + '" existe em IC');
    assert.ok(!GLYPHS.test(m.ic), st + ': ic não é glifo');
    assert.ok(stIcon(st).startsWith('<svg'), st + ': stIcon devolve SVG');
    assert.ok(stBadge(st).includes('<i>' + IC[m.ic] + '</i>'), st + ': stBadge usa o SVG');
  }
  // mesma família de status = mesmo ícone e mesma cor (o significado não mudou)
  const same = (a, b) => { assert.equal(STATUS_META[a].ic, STATUS_META[b].ic, a + '~' + b); assert.equal(STATUS_META[a].c, STATUS_META[b].c, a + '~' + b); };
  same('running', 'thinking'); same('review', 'delivered'); same('error', 'conflict'); same('done', 'merged'); same('asking', 'plan-review');
  assert.equal(stIcon('status-que-não-existe').startsWith('<svg'), true, 'fallback também é SVG');
});

test('vocabulário de gente no STATUS_META: sem "mergeada"/"abortada"', () => {
  assert.equal(ST.stLabel('merged'), 'integrada');
  assert.equal(ST.stLabel('aborted'), 'interrompida');
  assert.doesNotMatch(cut(util, 'const STATUS_META={', '};'), /mergeada|abortada/);
});

test('stIcon é HTML: ninguém passa por esc()', () => {
  for (const f of ['js/46-epico-time.js', 'js/21-pull-request.js', 'js/22-quadro-fluxo.js', 'js/20-workspace-tarefa.js'])
    assert.doesNotMatch(src(f), /esc\(\s*stIcon\(/, f);
});

test('Central, barra lateral e menus: sem glifo de texto como ícone', () => {
  const q = src('js/22-quadro-fluxo.js'), en = src('js/27-entregas.js'), ep = src('js/46-epico-time.js'), orq = src('js/34-orquestrador.js');
  const blocks = {
    flowSecHead: fn(q, 'flowSecHead'),
    linkChips: fn(q, 'linkChips'),
    openTaskMenu: fn(q, 'openTaskMenu'),
    openStatusMenu: fn(q, 'openStatusMenu'),
    renderTaskSummary: fn(q, 'renderTaskSummary'),
    flowDemandCard: fn(en, 'flowDemandCard'),
    epTaskBadge: fn(ep, 'epTaskBadge'),
    sbEpDot: fn(src('js/25-grafo.js'), 'sbEpDot'),
    orqRailRows: fn(orq, 'orqRailRows'),
    orqBoardHtml: fn(orq, 'orqBoardHtml'),
    flowTaskCard: fn(src('js/21-pull-request.js'), 'flowTaskCard'),
    tsCardHtml: fn(src('js/43-espaco-times.js'), 'tsCardHtml'),
    fwPrimaryAction: fn(src('js/20-workspace-tarefa.js'), 'fwPrimaryAction'),
  };
  for (const [k, b] of Object.entries(blocks)) {
    // só o que vai pra TELA: tira comentários e o texto dos title="" (tooltip pode citar símbolos)
    const shown = b.replace(/\/\/[^\n]*/g, '').replace(/title="[^"]*"/g, '');
    const m = shown.match(GLYPHS);
    assert.ok(!m, k + ': glifo "' + (m && m[0]) + '" na tela — use IC.*');
  }
  assert.match(src('js/50-coordenacao.js'), /\$\{IC\.flag\} \$\{pl\(c, "tarefa com conflito"/);
});

test('integrada (merge) só quando dá pra saber que a tarefa tem código; os dois menus usam a mesma regra', () => {
  const q = src('js/22-quadro-fluxo.js');
  const diffs = {};
  const offers = new Function('diffOf', 'taskType', 'entregaNonCode', fn(q, 'taskOffersMerge') + '\nreturn taskOffersMerge;')(
    (id) => diffs[id], (t) => t.type || 'feature', (t) => !!t.docsOnly);
  assert.equal(offers({ id: 'a', status: 'running' }), false, 'diff ainda desconhecido: escondida');
  diffs.a = { files: 3 };
  assert.equal(offers({ id: 'a', status: 'running' }), true, 'diff conhecido, com código: aparece');
  assert.equal(offers({ id: 'a', status: 'review', docsOnly: true }), false, 'só documentos: escondida');
  assert.equal(offers({ id: 'b', status: 'review', type: 'invest', prUrl: 'x' }), false, 'investigação nunca');
  assert.equal(offers({ id: 'c', status: 'review', prUrl: 'https://x/pull/1' }), true, 'com PR: aparece');
  assert.equal(offers({ id: 'd', status: 'merged', type: 'design' }), true, 'já integrada: mantém (é o estado atual)');
  assert.match(fn(q, 'openTaskMenu'), /if\(t\.status!=='merged' && taskOffersMerge\(t\)\) item\('marcar como integrada/);
  assert.match(fn(q, 'openStatusMenu'), /if\(!taskOffersMerge\(t\)\)\{ const i=opts\.findIndex\(o=>o\.key==='merged'\)/);
});

test('menu de status: todo status marca uma opção (menuitemradio + aria-checked)', () => {
  const q = src('js/22-quadro-fluxo.js');
  const pend = new Set(['q']);
  const help = cut(src('js/00-util.js'), '// @helpers-comuns-inicio', '// @helpers-comuns-fim'); // F4: taskAguardaVoce/taskEncerrada
  const cur = new Function('pendingOf', 'taskTs', 'taskDoneTs', help + fn(q, 'flowBucket') + fn(q, 'stMenuCur') + '\nreturn stMenuCur;')(
    (id) => (pend.has(id) ? [1] : []), () => Date.now(), () => Date.now());
  const C = (status, x) => cur({ id: 'z', status, ...x });
  for (const s of ['running', 'thinking', 'queued', 'paused', 'error', 'conflict', 'aborted', 'plan-review']) assert.equal(C(s), 'running', s);
  assert.equal(cur({ id: 'q', status: 'running' }), 'running', 'aguardando você');
  for (const s of ['review', 'delivered']) assert.equal(C(s), 'review', s);
  assert.equal(C('running', { prUrl: 'x' }), 'review', 'PR aberto');
  assert.equal(C('merged'), 'merged'); assert.equal(C('done'), 'finished'); assert.equal(C('cancelled'), 'cancelled');
  assert.equal(C('review', { flag: 'closed' }), 'finished'); assert.equal(C('draft'), '');
  const m = fn(q, 'openStatusMenu');
  assert.match(m, /const cur = stMenuCur\(t\);/);
  assert.match(m, /b\.setAttribute\('role','menuitemradio'\); b\.setAttribute\('aria-checked', on\?'true':'false'\);/);
  assert.match(fn(q, 'menuWire'), /if\(!b\.getAttribute\('role'\)\) b\.setAttribute\('role','menuitem'\)/);
  // menu ⋯: todo item tem o slot do ícone (alinhado), inclusive "trocar modelo"
  const tm = fn(q, 'openTaskMenu');
  assert.match(tm, /b\.innerHTML='<span class="mnic">'\+\(icon\|\|''\)\+'<\/span>'/);
  assert.match(tm, /item\('trocar modelo · '/);
  assert.doesNotMatch(tm, /document\.createElement\('button'\); b\.textContent='trocar modelo/);
  assert.match(tm, /item\('desbloquear'[^\n]*IC\.unlock\)/);
  assert.match(tm, /item\('refazer do zero[^\n]*IC\.reset\)/);
});

test('mono só pra dado técnico: rótulos, status, contagens e tempo na fonte de UI com --fs-*', () => {
  const css = ['10-base', '30-refino-macos', '40-sidebar-quadro', '50-workspace-planner', '60-grafo-times-nova-demanda', '70-orquestrador', '88-cara-de-produto']
    .map((f) => src('css/' + f + '.css')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  const SEL = ['.sech', '.dc-type', '.dc-top .prj', '.dc-foot .tm', '.dc-pct', '.dc-model', '.dc-more', '.dc-meta', '.tsepc.epbadge', '.epqh .epqk',
    '.rproj .rph b', '.rproj .rph .n', '.typetag', '.phst', '.fmeta .prj', '.cwho', '.fwctxst', '.artcat', '.fwreqh', '.prcmtsn', '.prpage h2',
    '.orqc-ph b', '.dc-orq', '.protbadge', '.cardpct>.cpv', '.coordchip'];
  for (const s of SEL) {
    const mine = rules.filter(([sel]) => sel.split(',').map((x) => x.trim()).includes(s));
    assert.ok(mine.length, 'regra de ' + s + ' existe');
    for (const [, body] of mine) assert.doesNotMatch(body, /var\(--(mono|code)|monospace/, s + ' não é mono');
  }
  for (const s of ['.sech', '.dc-type', '.tsepc.epbadge', '.cwho', '.fwctxst', '.artcat', '.prcmtsn'])
    assert.ok(rules.some(([sel, b]) => sel.split(',').map((x) => x.trim()).includes(s) && /var\(--fs-/.test(b)), s + ' usa a escala --fs-*');
  // título da tarefa é texto de gente
  assert.match(src('index.html'), /<b class="fwtname" id="fwTaskName">/);
  assert.match(src('index.html'), /href="css\/88-cara-de-produto\.css"/);
  // e o que é técnico continua mono: arquivo no diff, código da issue
  assert.match(src('js/22-quadro-fluxo.js'), /<span class="mono">\$\{esc\(ic\)\}<\/span>/);
});

test('verde disciplinado: custo e "Agora" saem do --accent cheio', () => {
  assert.doesNotMatch(src('js/26-sidebar-projetos.js'), /color:var\(--accent\);font-weight:600">\$\{fmtCost/);
  assert.doesNotMatch(src('css/50-workspace-planner.css'), /\.fcost\{color:var\(--accent\)/);
  assert.match(src('css/88-cara-de-produto.css'), /\.bus \.live\{background:var\(--accent-soft\)/);
});
