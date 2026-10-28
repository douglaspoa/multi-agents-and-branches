// Casca "Semana" (76-casca-semana): lateral em 3 grupos, Meu trabalho, Semana do time, Entregas, Onde fica cada coisa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcadores ' + a); return src.slice(i, j); };
const JS = read('js/76-casca-semana.js'), HTML = read('index.html'), CSS = read('css/99-casca-semana.css');
const S = new Function(cut(JS, '// @semana-puro-inicio', '// @semana-puro-fim')
  + '\nreturn { semDiasDaSemana, semIntervaloTx, semHojeTx, semColunas, semMenuOpcoes, semMotivoOk, semRelatorioTx, MAPA_GRUPOS, GUIAS, guiaPasso, guiaFaixaTx };')();
const QUA = new Date(2026, 9, 14, 10).getTime(); // quarta 14/10
const SAB = new Date(2026, 9, 17, 10).getTime(); // sábado 17/10

test('semana: seg–sex com hoje marcado; passado e futuro recolhidos; sábado só quando é hoje', () => {
  const d = S.semDiasDaSemana(QUA);
  assert.deepEqual(d.map((x) => x.lbl + x.num + ':' + x.kind), ['Seg12:past', 'Ter13:past', 'Qua14:today', 'Qui15:fut', 'Sex16:fut']);
  assert.equal(S.semIntervaloTx(d), '12 a 16 de outubro');
  assert.equal(S.semHojeTx(QUA), 'Quarta, 14 de outubro');
  const s = S.semDiasDaSemana(SAB);
  assert.deepEqual(s.map((x) => x.lbl), ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']);
  assert.equal(s[5].kind, 'today');
  const virada = S.semDiasDaSemana(new Date(2026, 9, 1, 9).getTime()); // quinta 01/10: a semana começa em setembro
  assert.equal(S.semIntervaloTx(virada), '28 de setembro a 2 de outubro');
});

test('grade sem rolagem lateral: hoje largo, outros dias 58px; o dia aberto também fica largo', () => {
  const d = S.semDiasDaSemana(QUA);
  assert.equal(S.semColunas(d, ''), 'minmax(110px,150px) 58px 58px minmax(0,1fr) 58px 58px');
  assert.equal(S.semColunas(d, d[1].key), 'minmax(110px,150px) 58px minmax(0,1fr) minmax(0,1fr) 58px 58px');
  assert.ok(!/px\)? \d{3,}px/.test(S.semColunas(d, '')), 'nenhuma coluna fixa larga');
});

test('Passar ▾ / Atribuir ▾: 1…n sem buraco, "Eu assumo" primeiro, 0 = devolver; membro só assume o que está livre', () => {
  const ppl = ['me', 'ana', 'bruno', 'carla'];
  const lider = S.semMenuOpcoes({ me: 'me', cur: 'bruno', pessoas: ppl, podeOutros: true });
  assert.deepEqual(lider.map((o) => o.k + ':' + (o.devolver ? 'dev' : o.uid)), ['1:me', '2:ana', '3:carla', '0:dev'], 'quem já está com ela sai da lista');
  assert.ok(lider.every((o) => !o.off));
  const livre = S.semMenuOpcoes({ me: 'me', cur: '', pessoas: ppl, podeOutros: false });
  assert.equal(livre[0].eu, true); assert.equal(livre[0].off, false, 'membro assume o cartão livre');
  assert.ok(livre.slice(1).every((o) => o.off && /líder/.test(o.why)), 'passar pra outra pessoa é do líder');
  assert.ok(!livre.some((o) => o.devolver), 'sem dono não tem "devolver"');
  const deOutro = S.semMenuOpcoes({ me: 'me', cur: 'ana', pessoas: ppl, podeOutros: false });
  assert.equal(deOutro[0].off, true, 'tomar de colega: não');
  assert.equal(deOutro.find((o) => o.devolver).off, true, 'devolver o cartão de outra pessoa: só o líder');
  assert.equal(S.semMenuOpcoes({ me: 'me', cur: 'me', pessoas: ppl, podeOutros: false }).find((o) => o.devolver).off, false, 'o meu eu devolvo');
  assert.deepEqual(S.semMenuOpcoes({ me: 'me', local: true, pessoas: ppl }), [], 'demanda só desta máquina não passa');
  const muitos = S.semMenuOpcoes({ me: 'me', pessoas: Array.from({ length: 14 }, (_, i) => 'p' + i), podeOutros: true });
  assert.equal(muitos.length, 9, 'teclas 1–9');
});

test('devolver pede motivo de verdade (3 palavras) e o relatório sai pronto pra colar', () => {
  assert.equal(S.semMotivoOk('não sei'), false);
  assert.equal(S.semMotivoOk('  sem iPhone pra testar hoje '), true);
  const tx = S.semRelatorioTx({ periodo: 'Esta semana', projeto: 'loja-web', itens: [{ quem: 'Ana', titulo: 'Banner de frete', pr: '40', provas: '3/3' }, { quem: 'Bruno', titulo: 'Login', pr: '' }], parados: ['Elisa em LOJA-25'] });
  assert.equal(tx, 'Esta semana · loja-web · 2 entregas, 2 pessoas.\n• Ana: Banner de frete (PR #40, 3/3 com prova)\n• Bruno: Login\nParado: Elisa em LOJA-25.');
});

test('Onde fica cada coisa: os 3 grupos da lateral (+ dentro da tarefa) e guias com faixa "passo N de M"', () => {
  assert.deepEqual(S.MAPA_GRUPOS.map((g) => g[0]), ['Trabalho', 'Dentro de uma tarefa', 'Padrões do time', 'Conta']);
  assert.deepEqual(S.MAPA_GRUPOS[2][2].map((i) => i[1]), ['Projetos', 'Agentes', 'Skills', 'Memória']);
  for (const [k, g] of Object.entries(S.GUIAS)) {
    assert.ok(g.steps.length >= 3, k);
    assert.ok(/^Pronto/.test(g.steps[g.steps.length - 1][0]), k + ': o último passo diz o resultado');
  }
  assert.equal(S.guiaFaixaTx(S.GUIAS.passar, 1), 'Passar uma tarefa travada pra outra pessoa · passo 2 de 4: Clique em "Passar ▾" no bloco da tarefa');
  assert.equal(S.guiaPasso(S.GUIAS.passar, 99).fim, true, 'passa do fim → fica no último');
  assert.match(JS, /"Começar um app do zero" está em Projetos › Adicionar repo\. "Ainda é uma ideia" é uma opção da Nova demanda\./);
});

test('telas registradas como ABA (nunca modal) e a lateral liga cada item; Agentes/Skills/Memória com o guarda do kind', () => {
  for (const k of ['meu', 'semana', 'entregas', 'mapa']) {
    assert.match(JS, new RegExp(`VIEW_OVERLAY\\.${k}='${k}Overlay'`));
    assert.match(HTML, new RegExp(`<div class="overlay fwoverlay pgov" id="${k}Overlay" style="display:none"><div class="pgpage sempage" id="${k}Page"></div></div>`));
  }
  assert.match(JS, /if\(typeof VIEW_META!=='undefined' && VIEW_META\[kind\] && !rota\) return openTab\(kind\);/);
  assert.match(JS, /case 'agentes': return semAbreKind\('agentes', \(\)=>openTab\('agents'\)\);/);
  assert.match(JS, /\['meuBtn','meu'\],\['semanaBtn','semana'\],\['entregasBtn','entregas'\]/);
  assert.ok(!/function sideTaskMode/.test(JS), 'a lateral de etapas é do 77-tarefa-etapas (a casca não a sobrescreve)');
  assert.match(JS, /window\.openMeuTrabalho=function\(\)\{ openTab\('meu'\); \};/);
  assert.match(JS, /window\.openOndeFica=function\(\)\{ openTab\('mapa'\); \};/);
  assert.match(JS, /openShortcuts=function\(\)\{ openTab\('mapa'\); \}/, 'a tecla ? abre o mapa');
  assert.ok(!/window\.confirm|confirm\(/.test(JS.replace(/askYes/g, '')), 'confirmação = askYes');
  assert.ok(!/setInterval/.test(JS), 'sem polling novo');
  assert.match(HTML, /<script src="js\/76-casca-semana\.js"><\/script>/);
  assert.match(HTML, /<link rel="stylesheet" href="css\/99-casca-semana\.css">/);
  assert.match(HTML, /<div class="semguia" id="semGuia" role="status" aria-live="polite" hidden><\/div>\n  <div class="tabbar" id="tabBar"/, 'a faixa do guia empurra as abas (não cobre)');
});

test('rótulo "Issues" + nome do painel (nunca "Issues do GitHub"); Fábrica e Ideia ganharam porta nova', () => {
  assert.ok(!/Issues do GitHub/.test(JS + HTML), 'vem de qualquer painel conectado');
  assert.match(JS, /Issues <span class="sbsrc">\$\{esc\(src\)\}<\/span>/);
  const pj = read('js/13-skills-projetos.js');
  assert.match(pj, /label:'Adicionar repo'/);
  for (const k of ['pasta', 'clonar', 'novo', 'zero']) assert.match(pj, new RegExp(`data-addrepo="${k}"`));
  assert.match(pj, /invoke\('clone_project',\{ url \}\)/);
  assert.match(pj, /Começar um app do zero/);
  const pl = read('js/32-planner.js');
  assert.match(pl, /Ainda é uma ideia: conversar antes de planejar/);
  assert.match(pl, /if\(typeof ideiaNew==='function'\) ideiaNew\(tx\)/);
  const iss = read('js/14-issues-projeto.js');
  assert.match(iss, /data-trklay="triagem"/);
  assert.match(iss, /if\(k==='r'\|\|k==='R'\)\{ e\.preventDefault\(\); trkTriAct\('run'\); \}/);
  assert.match(iss, /<span class="lab">mandar para<\/span>/);
});

test('CSS: só o miolo rola; rodapé fixo; nada de rolagem lateral nas grades', () => {
  assert.match(CSS, /\.semgrid\{display:grid;[^}]*overflow:hidden;min-width:0\}/);
  assert.match(CSS, /\.semcols\{display:grid;gap:10px;min-width:0\}/);
  assert.match(CSS, /@media \(max-height:740px\)\{[\s\S]*?\.sbfoot \.sbgrp\{display:none\}/, 'a 700px de altura o rodapé cabe');
});

test('Minha semana: cada tarefa no dia da última mudança; concluídas recolhidas; >7 dias concluída some (28/10)', () => {
  const src = read('js/76-casca-semana.js');
  const pure = src.slice(src.indexOf('// @mws-puro-inicio'), src.indexOf('// @mws-puro-fim'));
  const dia0 = src.match(/function semDia0\(ms\)\{[^\n]*\n/)[0];
  const consts = src.match(/const SEM_DIAS_LONGO=[^\n]*\n/)[0] + src.match(/const SEM_MESES=[^\n]*\n/)[0];
  const M = new Function('semEntregueEm', consts + dia0 + pure + '\nreturn { semFim, semDiasMinha };')((x) => x.ent || 0);
  const now = new Date(2026, 9, 28, 15, 0).getTime(), D = 86400000;
  const L = [
    { id: 'a', mod: now - 1000, st: 'running' },
    { id: 'b', mod: now - D, st: 'review' },
    { id: 'c', mod: now - 3 * D, st: 'running' },
    { id: 'd', mod: now - 2 * D, st: 'closed', ent: now - 2 * D },
    { id: 'e', mod: now - 10 * D, st: 'done', done: true, ent: now - 10 * D },
    { id: 'f', mod: now - 10 * D, st: 'blocked' },
  ];
  const r = M.semDiasMinha(L, now);
  assert.deepEqual(r.map((d) => d.l), ['Hoje', 'Ontem', r[2].l, r[3].l, 'Antes']);
  assert.deepEqual(r[0].abertas.map((x) => x.id), ['a'], 'Hoje só tem o que mudou hoje');
  assert.deepEqual(r[1].abertas.map((x) => x.id), ['b']);
  assert.ok(r.some((d) => d.fim.some((x) => x.id === 'd')), 'concluída (mesmo com PR aberto) vai pras concluídas do dia');
  assert.ok(!r.some((d) => [...d.abertas, ...d.fim].some((x) => x.id === 'e')), 'concluída há mais de 7 dias sai da semana');
  assert.deepEqual(r.at(-1).abertas.map((x) => x.id), ['f'], 'aberta antiga vai pra "Antes", não pra Hoje');
  assert.equal(M.semFim({ st: 'closed' }), true);
  assert.match(src, /x\.card&&!semFim\(x\)&&x\.card\.assignee===me/, 'Devolver só em aberta');
});
