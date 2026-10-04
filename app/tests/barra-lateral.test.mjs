// Mesa da barra lateral (03/10, _bmad-output/party-lateral/decisao.md):
// L3 uma contagem/uma regra (railCounts sobre a flowBucket da Central) · L4 "esperando você" primeiro ·
// L1 projetos vazios numa linha · L2 rodapé em português sem "− N/4 +" · L6 erro do medidor sem corte ·
// L7b Projetos · Issues · Chat à vista (Skills/Agentes/Daily no "Mais") · L13 ↑/↓ na lista · L14 tooltip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const gr = read('js/25-grafo.js'), qf = read('js/22-quadro-fluxo.js'), html = read('index.html');
const sw = read('js/33-switcher-projetos.js'), css = read('css/40-sidebar-quadro.css'), pm = read('js/28-medidor-plano.js');

const L = new Function(cut(gr, '// @rail-mesa-inicio', '// @rail-mesa-fim') +
  '\nreturn { railRank, railCounts, railSum, railFootText, railProjTip, railSplitProjects, railEmptyText, railRowTip, railNavIdx, RAIL_VOCE };')();
// a flowBucket DE VERDADE (a regra única da Central), com pergunta aberta só na t-ask
const PEND = new Set(['t-ask']);
const flowBucket = new Function('pendingOf', 'taskTs', cut(qf, 'function flowBucket(t){', '\n// status EFETIVO') + '\nreturn flowBucket;')(
  (id) => (PEND.has(id) ? [{ id: 'q' }] : []), () => Date.now());

const TASKS = [
  { id: 't-run', status: 'running' },
  { id: 't-think', status: 'thinking' },
  { id: 't-ask', status: 'running' },          // pergunta aberta: espera você (e não conta como rodando)
  { id: 't-plan', status: 'plan-review' },
  { id: 't-rev', status: 'review' },
  { id: 't-pr', status: 'review', prUrl: 'https://github.com/x/y/pull/1' },
  { id: 't-q', status: 'queued' },
  { id: 't-draft', status: 'draft' },
  { id: 't-err', status: 'error' },
];

test('L3: uma contagem, uma regra — railCounts classifica pela flowBucket da Central', () => {
  const c = L.railCounts(TASKS, flowBucket);
  assert.deepEqual(c, { vivas: 9, rodando: 2, voce: 4 }, 'esperando você = pergunta + plano + erro + pra revisar; PR aberto e fila não');
  assert.deepEqual(L.railCounts([{ id: 'x', status: 'merged' }, { id: 'y', status: 'done' }], flowBucket), { vivas: 0, rodando: 0, voce: 0 }, 'encerradas não contam');
  assert.deepEqual(L.railCounts(null, flowBucket), { vivas: 0, rodando: 0, voce: 0 });
  assert.deepEqual(L.railSum([c, { vivas: 1, rodando: 1, voce: 0 }]), { vivas: 10, rodando: 3, voce: 4 });
  // a fiação: projeto atual, outros projetos e rodapé saem da MESMA função (nada de mine.length/liveN soltos)
  const r = cut(gr, 'function renderRail(){', '\n}\n');
  assert.match(r, /const cMine=railCounts\(mine, flowBucket\);/);
  assert.match(r, /railCounts\(p\.tasks, flowBucket\)/);
  assert.match(r, /const cAll=railSum\(\[cMine, \.\.\.vivos\.map\(p=>cOf\.get\(p\)\)\]\);/);
  assert.ok(!/liveN/.test(r), 'a contagem paralela antiga (liveN) saiu');
});

test('L4: "esperando você" primeiro — pergunta › plano › erro › pra revisar › PR › rodando › fila › rascunho', () => {
  const sts = ['draft', 'running', 'pr-open', 'queued', 'review', 'error', 'plan-review', 'asking'];
  assert.deepEqual(sts.slice().sort((a, b) => L.railRank(a) - L.railRank(b)), ['asking', 'plan-review', 'error', 'review', 'pr-open', 'running', 'queued', 'draft']);
  assert.ok(L.railRank('review') < L.railRank('running'), 'antes "pra revisar" ficava abaixo de "rodando"');
  assert.equal(L.railRank('status-novo'), L.railRank('queued'), 'desconhecido cai no meio, não no topo');
  const r = cut(gr, 'function renderRail(){', '\n}\n');
  assert.match(r, /sort\(\(a,b\)=>railRank\(a\.st\)-railRank\(b\.st\) \|\| taskTs\(b\.t\)-taskTs\(a\.t\)\)/);
  assert.match(r, /sort\(\(x,y\)=>railRank\(x\.status\)-railRank\(y\.status\)\)/, 'outros projetos: mesma ordem');
  assert.match(r, /const wait=RAIL_VOCE\.has\(flowBucket\(t\)\);/);
  assert.match(css, /\.prow2\.wait \.tt\{font-weight:600;color:var\(--text\)\}/, 'peso de texto, sem cor nova');
  // não reordena com o mouse ou o foco na lista: adia até sair (sem timer, sem polling)
  assert.match(r, /el\.__order!==order && \(\(el\.matches&&el\.matches\(':hover'\)\) \|\| el\.contains\(document\.activeElement\)\)/);
  assert.match(r, /if\(busy\)\{ el\.__defer=true; return; \}/);
  assert.match(r, /addEventListener\('mouseleave', flush\)/);
  assert.ok(!/setInterval|setTimeout/.test(r), 'nada de timer na lateral');
});

test('veto da Bia: o status é palavra também nas linhas dos OUTROS projetos', () => {
  const r = cut(gr, 'function renderRail(){', '\n}\n');
  const row = cut(r, 'const rowHtml=', '\n\n');
  assert.match(row, /<span class="tg" style="color:\$\{tc\}">\$\{esc\(tg\)\}<\/span>/);
  assert.match(r, /pt\.slice\(0,3\)\.map\(t=>rowHtml\(t, t\.status, p\.name, p\.path\)\)/);
  assert.match(r, /\+\$\{pt\.length-3\} neste projeto/, 'o que não coube vira linha (nada vivo escondido)');
});

test('L1: projeto sem demanda viva vira UMA linha, acima do escopo por conta (PR #103)', () => {
  const ps = [{ name: 'a', tasks: [{ id: 1 }] }, { name: 'b', tasks: [] }, { name: 'c' }, { name: 'd', tasks: [{ id: 2 }] }];
  const { vivos, vazios } = L.railSplitProjects(ps);
  assert.deepEqual(vivos.map((p) => p.name), ['a', 'd']);
  assert.deepEqual(vazios.map((p) => p.name), ['b', 'c']);
  assert.equal(L.railEmptyText(1), '+1 projeto sem demanda');
  assert.equal(L.railEmptyText(3), '+3 projetos sem demanda');
  const r = cut(gr, 'function renderRail(){', '\n}\n');
  assert.ok(!/abrir projeto/.test(r), 'sem as linhas "abrir projeto"');
  const iEmpty = r.indexOf('railEmptyText(vazios.length)'), iScope = r.indexOf('html+=projScopeHtml()');
  assert.ok(iEmpty > 0 && iScope > iEmpty, 'a linha dos vazios vem antes (e separada) da linha do escopo por conta');
  assert.match(r, /if\(r\.dataset\.allproj\)\{ if\(window\.openTab\) window\.openTab\('projetos'\); return; \}/);
});

test('L2: rodapé em português, sem "− N/4 +" (o limite mora em Configurações)', () => {
  assert.equal(L.railFootText({ rodando: 0, voce: 0 }, 4), 'nada rodando agora');
  assert.equal(L.railFootText({ rodando: 1, voce: 2 }, 4), '1 rodando · 2 esperando você');
  assert.equal(L.railFootText({ rodando: 0, voce: 1 }, 4), '1 esperando você');
  assert.equal(L.railFootText({ rodando: 4, voce: 0 }, 4), '4 rodando · limite de 4 atingido');
  assert.equal(L.railProjTip({ vivas: 1, rodando: 0, voce: 1 }), '1 demanda viva · 1 esperando você');
  const r = cut(gr, 'function renderRail(){', '\n}\n');
  assert.ok(!/data-slot|sess(ão|ões) atua|sbtn/.test(r), 'sem controle de número nem "sessões"');
  assert.match(r, /Configurações › Tarefas ao mesmo tempo/);
  assert.match(read('js/15-config-abas-onboarding.js'), /id="cfgSlots"/, 'o ajuste continua em Configurações');
  assert.ok(!/\.sbtn\{/.test(css), 'CSS do −/+ removido');
});

test('L6: erro do medidor em duas linhas que quebram — "tentar de novo" sempre visível', () => {
  assert.match(pm, /<div class="pm-err"[^`]*<span class="pm-errtx">uso do plano não carregou<\/span><button class="pm-retry" data-pm="retry"/);
  assert.match(css, /\.planmeter \.pm-err\{display:flex;flex-wrap:wrap;/);
  assert.ok(!/\.pm-err[^{]*\{[^}]*white-space:nowrap/.test(css), 'nada de nowrap no erro');
});

test('L7b: Projetos · Issues · Chat · Fábrica à vista (redesenho F1: embaixo das demandas); Skills, Agentes & Equipes e Daily no topo do "Mais"', () => {
  assert.ok(html.indexOf('<div class="sbscroll">') < html.indexOf('<div class="sbnav2"'), 'demandas primeiro, navegação depois');
  const nav = cut(html, '<div class="sbnav2"', '<div class="planmeter"');
  const visible = [...nav.matchAll(/<button class="btn sbitem[^"]*" id="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(visible, ['projetosBtn', 'issuesBtn', 'pcBtn', 'fabricaBtn']);
  assert.ok(!/class="btn sbitem/.test(cut(html, '<div class="sbnew">', '<div class="sbscroll">')), 'em cima só a Nova demanda');
  assert.match(read('js/26-sidebar-projetos.js'), /typeof fabOpen==='function' \? fabOpen\(\) : toast\('Fábrica chegando'\)/);
  const menu = cut(html, '<div class="moremenu" id="moreMenu"', '</aside>');
  const inMenu = [...menu.matchAll(/<button class="btn" id="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(inMenu.slice(0, 3), ['skillsBtn', 'agentsBtn', 'dailyBtn'], 'no topo do menu, com os mesmos ids (handlers e atalhos intactos)');
  assert.match(menu, /dailyBtn[\s\S]*<div class="mmsep" role="separator"><\/div>[\s\S]*prefsBtn/);
  assert.equal((html.match(/id="skillsBtn"/g) || []).length, 1);
  // o "Mais" agora carrega navegação: precisa de teclado (setas, Home/End, Esc devolve o foco) e aria-expanded
  assert.match(html, /id="moreBtn" aria-haspopup="true" aria-expanded="false" aria-controls="moreMenu"/);
  const mm = cut(sw, "{ const mb=$id('moreBtn')", '// publicar release');
  assert.match(mm, /mb\.setAttribute\('aria-expanded', on\?'true':'false'\)/);
  assert.match(mm, /e\.key==='Escape'\)\{ e\.preventDefault\(\); mmShow\(false\); mb\.focus\(\);/);
  assert.match(mm, /e\.key==='ArrowDown'\?i\+1:e\.key==='ArrowUp'\?i-1:e\.key==='Home'\?0:e\.key==='End'\?it\.length-1:null/);
});

test('L13/L14: ↑/↓/Home/End andam na lista; tooltip com título · estado · branch · projeto (sem hora relativa)', () => {
  assert.equal(L.railNavIdx(-1, 5, 'ArrowDown'), 0);
  assert.equal(L.railNavIdx(2, 5, 'ArrowDown'), 3);
  assert.equal(L.railNavIdx(4, 5, 'ArrowDown'), 4, 'não dá a volta');
  assert.equal(L.railNavIdx(0, 5, 'ArrowUp'), 0);
  assert.equal(L.railNavIdx(3, 5, 'Home'), 0);
  assert.equal(L.railNavIdx(1, 5, 'End'), 4);
  assert.equal(L.railNavIdx(1, 5, 'Enter'), -1);
  assert.equal(L.railNavIdx(0, 0, 'ArrowDown'), -1);
  assert.equal(L.railRowTip({ title: 'Ajustar cores', branch: 'feat/cores' }, 'pronta pra revisar', 'studio'), 'Ajustar cores · pronta pra revisar · feat/cores · studio');
  assert.equal(L.railRowTip({ title: 'X' }, 'rodando', ''), 'X · rodando');
  const r = cut(gr, 'function renderRail(){', '\n}\n');
  assert.match(r, /title="\$\{escA\(railRowTip\(t, tl, proj\)\)\}"/);
  assert.match(r, /railNavIdx\(it\.indexOf\(document\.activeElement\), it\.length, e\.key\)/);
  assert.match(r, /if\(!el\.__wired\)\{ el\.__wired=true;/, 'ouvintes da lista ligados uma vez só');
  assert.ok(!/ago|há \$\{|pmAgo|Date\.now\(\)/.test(r), 'sem tempo relativo no HTML da lateral');
});
