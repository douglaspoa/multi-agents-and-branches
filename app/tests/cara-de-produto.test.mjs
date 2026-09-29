// R8 — cara de produto (F12 da mesa, tela por tela): `node --test app/tests/cara-de-produto.test.mjs`
// Central, barra lateral, barra de status e cabeçalho da Tarefa: glifo de texto não é ícone (vira SVG de IC),
// mono só pra dado técnico, STATUS_META continua a fonte única (agora com a CHAVE do ícone em IC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };
const core = src('js/10-core.js'), util = src('js/00-util.js');

// IC só com os ícones do R8 (o bloco usa icEm, que vem de antes no 10-core)
const IC = new Function(
  'const IC = {};\nconst icEm = s => s.replace(\'<svg \', \'<svg width="1em" height="1em" style="vertical-align:-.125em;flex:none" aria-hidden="true" \');\n'
  + cut(core, '// @r8-icones-inicio', '// @r8-icones-fim') + '\nreturn IC;')();
// STATUS_META + stIcon/stBadge de verdade, com o IC acima
const ST = new Function('IC', cut(util, 'const STATUS_META={', '// ===== toast global')
  + '\nreturn { STATUS_META, stIcon, stBadge, stLabel };')(IC);

// glifos que faziam papel de ícone nas telas desta rodada
const GLYPHS = /[◆◉▾▸▼⌥⚑↗⤢⋯●○✓✕×⊘❚❙▶■]/u;

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
    flowSecHead: cut(q, 'function flowSecHead', '\n}'),
    linkChips: cut(q, 'function linkChips', '\n}'),
    openTaskMenu: cut(q, 'function openTaskMenu', '\n}'),
    'openStatusMenu (opções)': cut(q, 'const opts=[', '];'),
    flowDemandCard: cut(en, 'function flowDemandCard', '\n}'),
    epTaskBadge: cut(ep, 'function epTaskBadge', '\n}'),
    sbEpDot: cut(src('js/25-grafo.js'), 'function sbEpDot', '\n}'),
    orqRailRows: cut(orq, 'function orqRailRows', '\n}'),
    orqBoardHtml: cut(orq, 'function orqBoardHtml', '\n}'),
    flowTaskCard: cut(src('js/21-pull-request.js'), 'function flowTaskCard', '\n}'),
  };
  for (const [k, b] of Object.entries(blocks)) {
    // só o que vai pra TELA: tira comentários e o texto dos title="" (tooltip pode citar símbolos)
    const shown = b.replace(/\/\/[^\n]*/g, '').replace(/title="[^"]*"/g, '');
    const m = shown.match(GLYPHS);
    assert.ok(!m, k + ': glifo "' + (m && m[0]) + '" na tela — use IC.*');
  }
  assert.match(src('js/50-coordenacao.js'), /\$\{IC\.flag\} \$\{pl\(c, "tarefa com conflito"/);
});

test('status sem merge pra tarefa sem código: o menu tira "Integrada"', () => {
  const q = src('js/22-quadro-fluxo.js');
  const menu = cut(q, 'function openStatusMenu', '\n}');
  assert.match(menu, /const noCode=\['invest','design'\]\.includes\(taskType\(t\)\) \|\| \(typeof entregaNonCode==='function' && entregaNonCode\(t\)\)/);
  assert.match(menu, /if\(noCode\)\{ const i=opts\.findIndex\(o=>o\.key==='merged'\); if\(i>=0\) opts\.splice\(i,1\); \}/);
  assert.match(cut(q, 'function openTaskMenu', '\n}'), /const artifactOnly=\['invest','design'\]\.includes\(ty\)\|\|\(typeof entregaNonCode==='function'&&entregaNonCode\(t\)\)/);
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
