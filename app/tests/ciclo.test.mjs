// O ciclo da tarefa (mesa 03/10) no app: `node --test app/tests/ciclo.test.mjs`
// Funções puras de 60-ciclo.js (espelho de src/lifecycle.ts, conferido pelos fixtures de tests/fixtures/ciclo-golden/),
// a seção "precisa de você" (inline, não modal) e a liberação de teto com valor + motivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/js/60-ciclo.js', import.meta.url), 'utf8');
const teto = readFileSync(new URL('../src/js/53-teto-protecao.js', import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marcador ' + a); return s.slice(i, j); };
const gold = (f) => JSON.parse(readFileSync(new URL('../../tests/fixtures/ciclo-golden/' + f, import.meta.url), 'utf8'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctx(extra = {}) {
  const calls = [];
  const c = {
    calls, console, esc, escA: esc, toast: (m, k) => calls.push(['toast', m, k]), lastSig: 'x', refresh: async () => {},
    fmtCost: (x) => 'US$ ' + (+x).toFixed(2).replace('.', ','), costCapDefault: () => 5,
    budgetBusy: new Set(), state: { tasks: [], pending: [] },
    invoke: async (cmd, args) => { calls.push([cmd, args]); return null; },
    taskCost: () => ({ usd: 1.6 }),
    ...extra,
  };
  vm.createContext(c);
  vm.runInContext(cut(src, '// @ciclo-puro-inicio', '// @ciclo-puro-fim'), c);
  return c;
}
const run = (c, code) => vm.runInContext(code, c);

test('golden teto.json: capCheck, effectiveCap, parseRelease e releaseCheck iguais ao motor', () => {
  const c = ctx(), g = gold('teto.json');
  for (const [s, cap, e] of g.capCheck) assert.equal(run(c, `capCheck(${JSON.stringify(s)}, ${JSON.stringify(cap)})`), e);
  for (const [t, st, e] of g.effectiveCap) assert.equal(run(c, `effectiveCap(${JSON.stringify(t)}, ${JSON.stringify(st)})`), e);
  for (const [t, e] of g.parseRelease) {
    const r = run(c, `parseRelease(${JSON.stringify(t)})`);
    assert.equal(r.ok, e.ok, t);
    if (e.ok) { assert.equal(r.usd, e.usd, t); assert.equal(r.reason, e.reason, t); }
  }
  for (const [u, t, e] of g.releaseCheck) {
    const r = run(c, `releaseCheck(${JSON.stringify(u)}, ${JSON.stringify(t)})`);
    assert.equal(r.ok, e.ok, `${u}/${t}`);
  }
});

function decCtx() {
  const c = ctx({ budgetOf: () => 2, budgetPrompt: () => 'A tarefa já usou US$ 1,60 de US$ 2,00 (80% do teto).\n\nresto' });
  run(c, cut(src, '// @ciclo-decisao-inicio', '// @ciclo-decisao-fim'));
  return c;
}

test('"precisa de você": teto parado entre etapas (motor), pausado no meio do turno (app) e nada a decidir', () => {
  const c = decCtx();
  const engine = { id: 't', status: 'needs-you', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'etapa' }, needsYou: { kind: 'teto', text: 'parei antes de Nyx revisar' } } };
  assert.deepEqual(JSON.parse(JSON.stringify(run(c, `cicloDecision(${JSON.stringify(engine)})`))), { kind: 'teto', text: 'parei antes de Nyx revisar', hit: engine.spec.budgetHit });
  const app = { id: 't', status: 'paused', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'paused' } } };
  assert.equal(run(c, `cicloDecision(${JSON.stringify(app)})`).kind, 'teto');
  assert.equal(run(c, `cicloDecision(${JSON.stringify({ id: 't', status: 'running', spec: {} })})`), null);
  // marca velha numa tarefa que voltou a rodar não pede decisão
  assert.equal(run(c, `cicloDecision(${JSON.stringify({ id: 't', status: 'running', spec: { budgetHit: { mode: 'paused' } } })})`), null);
  for (const kind of ['rodadas', 'veredito']) assert.equal(run(c, `cicloDecision(${JSON.stringify({ id: 't', status: 'needs-you', spec: { needsYou: { kind, text: 'x' } } })})`).kind, kind);
});

test('a liberação é uma SEÇÃO da aba (não modal): valor + motivo, gasto até agora, parar aqui', () => {
  const c = decCtx();
  const t = { id: 't', status: 'needs-you', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'etapa' }, needsYou: { kind: 'teto', text: 'parei antes de Nyx revisar' } } };
  const h = run(c, `cicloDecisionHtml(${JSON.stringify(t)}, cicloDecision(${JSON.stringify(t)}), { why:'falta <b>' })`);
  assert.match(h, /^<section class="cicdec" id="cicDecide" aria-label="Precisa de você: teto de custo">/);
  assert.doesNotMatch(h, /overlay|modal|role="dialog"/, 'nunca modal');
  assert.match(h, /<b>Precisa de você<\/b>/);
  assert.match(h, /parei antes de Nyx revisar/);
  assert.match(h, /Gasto até agora <b>US\$ 1,60<\/b> de <b>US\$ 2,00<\/b>/);
  assert.match(h, /id="cicUsd"/); assert.match(h, /id="cicWhy"[^>]*value="falta &lt;b&gt;"/, 'o que foi digitado volta escapado');
  assert.match(h, /liberar e seguir/); assert.match(h, /parar aqui/);
  assert.match(h, /role="alert"/);
  // rodadas: seguir pra prova (com motivo), mais uma rodada, parar
  const r = { id: 't', status: 'needs-you', spec: { needsYou: { kind: 'rodadas', text: 'Nyx pediu mudanças na 2ª rodada' } } };
  const hr = run(c, `cicloDecisionHtml(${JSON.stringify(r)}, cicloDecision(${JSON.stringify(r)}), {})`);
  assert.match(hr, /Revisão pediu a 3ª rodada/);
  assert.match(hr, /seguir pra prova/); assert.match(hr, /mais uma rodada/);
  assert.doesNotMatch(hr, /melhorou/i);
});

test('budgetRelease: sem motivo nada muda; pouco demais recusa dizendo o mínimo; ok grava valor+motivo e retoma do jeito certo', async () => {
  const m = teto.match(/async function budgetRelease\([^)]*\)\{[\s\S]*?\n\}\n/); assert.ok(m);
  const mk = (t, spent) => { const c = ctx({ budgetOf: () => 2, taskCost: () => ({ usd: spent }) }); run(c, teto.match(/function budgetOrgMax\(t\)\{[^\n]*\n/)[0] + m[0] + '\nthis.budgetRelease=budgetRelease;'); return c; };
  const t = { id: 't', status: 'needs-you', spec: { budgetUsd: 2, budgetHit: { usd: 1.6, cap: 2, mode: 'etapa' }, budgetReleases: [{ usd: 1, reason: 'antes', at: 1, capBefore: 1, capAfter: 2 }] } };
  let c = mk(t, 1.6);
  await assert.rejects(c.budgetRelease(t, '2', 'sim'), /motivo/);
  await assert.rejects(c.budgetRelease(t, '', 'falta o teste de login'), /quanto liberar/);
  assert.equal(c.calls.filter((x) => x[0] === 'patch_task_spec').length, 0, 'nada gravado');
  // gasto 1,90 de 2,00: liberar 0,01 deixaria em 94% — pararia de novo na hora; diz o mínimo (0,39 → 80% de 2,39 ≥ 1,90)
  await assert.rejects(mk(t, 1.9).budgetRelease(t, '0,01', 'falta o teste de login'), /libere pelo menos US\$ 0,39/);
  await c.budgetRelease(t, '1,5', 'falta o teste de login');
  const p = c.calls.find((x) => x[0] === 'patch_task_spec')[1].patch;
  assert.equal(p.budgetUsd, 3.5);
  assert.equal(p.budgetHit, null); assert.equal(p.needsYou, null);
  assert.equal(p.budgetReleases.length, 2, 'acumula (o PR lista todas)');
  assert.deepEqual({ ...p.budgetReleases[1], at: 0 }, { usd: 1.5, reason: 'falta o teste de login', at: 0, capBefore: 2, capAfter: 3.5 });
  assert.ok(c.calls.some((x) => x[0] === 'start_task'), 'parada entre etapas (motor) → ▶ de novo');
  // pausada no meio do turno (app) → continua o mesmo processo
  const tp = { id: 't', status: 'paused', spec: { budgetHit: { usd: 1.6, cap: 2, mode: 'paused' } } };
  c = mk(tp, 1.6);
  await c.budgetRelease(tp, 2, 'o build demorou mais');
  assert.ok(c.calls.some((x) => x[0] === 'resume_task'));
  assert.ok(!c.calls.some((x) => x[0] === 'start_task'));
});

test('teto sempre ligado no app: budgetOf com 0 vira o padrão; a vigia pausa a 80% (não a 100%)', () => {
  const b = teto.match(/function budgetOf\(t\)\{[^\n]*\n/)[0];
  const c = ctx(); run(c, b);
  assert.equal(run(c, 'budgetOf({ spec:{ budgetUsd:0 } })'), 5);
  assert.equal(run(c, 'budgetOf({ spec:{ budgetUsd:3 } })'), 3);
  assert.match(teto, /if\(!active \|\| capCheck\(spent, cap\)==='ok'\) continue;/, 'a vigia usa o capCheck (80%)');
  assert.doesNotMatch(teto, /BUDGET_STEP_TXT/, 'sem "Continuar com mais US$ X" de um clique');
});

// ---------------------------------------------------------------- F2: fluxo por tipo, faixa e relatório

function f2ctx(extra = {}) {
  const c = ctx(extra);
  run(c, cut(src, '// @ciclo-fluxo-inicio', '// @ciclo-fluxo-fim'));
  run(c, cut(src, '// @ciclo-faixa-inicio', '// @ciclo-faixa-fim'));
  run(c, cut(src, '// @ciclo-relatorio-inicio', '// @ciclo-relatorio-fim'));
  return c;
}
const J = (v) => JSON.parse(JSON.stringify(v));

test('golden fluxos.json: FLOW_BY_KIND, rótulos, equipes prontas e taskKindOf iguais ao motor', () => {
  const c = f2ctx(), g = gold('fluxos.json');
  assert.deepEqual(J(run(c, 'FLOW_BY_KIND')), g.flows);
  assert.deepEqual(J(run(c, 'KIND_LABEL')), g.labels);
  assert.deepEqual(J(run(c, 'KIND_TEAM')), g.teams);
  for (const [i, e] of g.taskKindOf) assert.equal(run(c, `taskKindOf(${JSON.stringify(i)})`), e);
  assert.deepEqual(J(run(c, "kindAgentStages('pesquisa').map(s=>s.label)")), ['Plano', 'Escrever', 'Conferir']);
  assert.equal(run(c, "kindAgentStages('codigo').length"), 3, 'Design do Código só se mexer em tela');
});

test('golden relatorio.json: cicloReport (PR aberto pelo app) ≡ starforkReport (PR do motor)', () => {
  const c = f2ctx();
  for (const k of gold('relatorio.json').cases) assert.equal(run(c, `cicloReport(${JSON.stringify(k.input)})`), k.expected);
});

const ROLES = [{ role: 'planner', name: 'Vega' }, { role: 'builder', name: 'Íris' }, { role: 'reviewer', name: 'Nyx' }];
const stages = (c, t, x = {}) => J(run(c, `taskStages(${JSON.stringify(t)}, ${JSON.stringify(x)})`));
const pick = (s) => s.map((x) => [x.id, x.state, x.word]);

test('faixa (P1): tarefa antiga = a MESMA sequência do fwPlan (papéis na ordem) + prova e portão', () => {
  const ws = readFileSync(new URL('../src/js/20-workspace-tarefa.js', import.meta.url), 'utf8');
  const fwPlan = ws.match(/function fwPlan\(t\)\{[\s\S]*?\n\}\n/)[0];
  const c = f2ctx({ ACTIVE_ST: new Set(['running', 'queued']), IC: { check: '✓' }, ROLE_PT: { planner: 'planejamento', builder: 'construção', reviewer: 'revisão' } });
  run(c, fwPlan);
  for (const roles of [ROLES, [{ role: 'builder', name: 'Íris' }], [{ role: 'designer', name: 'Aria' }, { role: 'planner', name: 'Vega' }, { role: 'builder', name: 'Íris' }, { role: 'tester', name: 'Cobalt' }, { role: 'reviewer', name: 'Nyx' }]]) {
    const t = { id: 't', status: 'running', stage: roles[0].role, roles, spec: {} };
    const plan = run(c, `fwPlan(${JSON.stringify(t)})`);
    const fromPlan = [...plan.matchAll(/· ([^<]+)<\/span>/g)].map((m) => m[1]);
    const st = stages(c, t);
    assert.deepEqual(st.filter((s) => s.who).map((s) => s.who), fromPlan, 'mesma ordem de agentes');
    assert.deepEqual(st.filter((s) => !s.who).map((s) => s.id), ['provar', 'entregar'], 'tarefa antiga: sem retro inventada');
  }
});

test('faixa (P1): quem age agora, sua vez nos cadeados, precisa de você, prova e entregue', () => {
  const c = f2ctx();
  const base = { id: 't', roles: ROLES, spec: { taskKind: 'codigo' } };
  // construindo, com custo das etapas feitas
  let s = stages(c, { ...base, status: 'running', stage: 'builder' }, { costs: [{ role: 'planner', agent: 'Vega', usd: 0.1 }, { role: 'builder', agent: 'Íris', usd: 0.25 }] });
  assert.deepEqual(pick(s), [['plano', 'feito', 'pronto'], ['construir', 'agora', 'construindo'], ['revisar', 'espera', 'depois'], ['provar', 'espera', 'depois'], ['entregar', 'espera', 'depois'], ['retro', 'espera', 'depois']]);
  assert.equal(s[0].usd, 0.1); assert.equal(s[0].lock, 1); assert.equal(s[4].lock, 2, 'os dois cadeados sempre visíveis');
  const sum = J(run(c, `stagesSummary(${JSON.stringify(s)}, { spent:0.35, cap:2 })`));
  assert.equal(sum.now, 'Agora: Íris está construindo');
  assert.equal(sum.next, 'Depois: Revisar (Nyx)');
  assert.equal(sum.pos, 2); assert.equal(sum.n, 6);
  assert.equal(sum.label, 'Construir', 'rótulo da etapa de agora ("etapa 2 de 6 · Construir" no estreito)');
  // Cadeado 1
  s = stages(c, { ...base, status: 'plan-review', stage: 'planner' });
  assert.deepEqual(pick(s).slice(0, 2), [['plano', 'sua-vez', 'sua vez'], ['construir', 'espera', 'depois']]);
  assert.equal(J(run(c, `stagesSummary(${JSON.stringify(s)})`)).now, 'Sua vez: aprovar o plano');
  // revisão 1/2 e "pediu mudança" quando volta pro builder
  s = stages(c, { ...base, status: 'review', stage: 'reviewer', spec: { taskKind: 'codigo' } });
  assert.equal(s[2].state, 'feito');
  s = stages(c, { ...base, status: 'review', stage: 'reviewer', spec: { taskKind: 'codigo', reviewRounds: [{ round: 1, verdict: 'muda', items: ['a'] }] } });
  assert.equal(s[2].word, 'pediu mudança');
  s = stages(c, { ...base, status: 'running', stage: 'reviewer', spec: { taskKind: 'codigo', reviewRounds: [{ round: 1, verdict: 'muda', items: ['a'] }] } });
  assert.equal(s[2].word, 'revisando 2/2');
  s = stages(c, { ...base, status: 'running', stage: 'reviewer', spec: { taskKind: 'documento' } });
  assert.equal(s[2].word, 'conferindo 1/2', 'lente documento');
  // teto: parou ANTES da revisão (roleIdx 2) — a revisão é a etapa que espera você
  s = stages(c, { ...base, status: 'needs-you', stage: 'builder', spec: { taskKind: 'codigo', needsYou: { kind: 'teto', roleIdx: 2 } } });
  assert.deepEqual(pick(s).slice(0, 3), [['plano', 'feito', 'pronto'], ['construir', 'feito', 'pronto'], ['revisar', 'sua-vez', 'teto']]);
  assert.equal(J(run(c, `stagesSummary(${JSON.stringify(s)})`)).now, 'Precisa de você: o teto');
  // 3ª rodada: a revisão precisa de você
  s = stages(c, { ...base, status: 'needs-you', stage: 'reviewer', spec: { taskKind: 'codigo', needsYou: { kind: 'rodadas', roleIdx: 3 } } });
  assert.deepEqual(pick(s)[2], ['revisar', 'precisa', 'precisa de você']);
  // portão: pronta, prova faltando → "falta prova"; provada → "sua vez" no Entregar
  s = stages(c, { ...base, status: 'review', stage: 'reviewer' }, { proof: 'unproven' });
  assert.deepEqual(pick(s).slice(3, 5), [['provar', 'precisa', 'falta prova'], ['entregar', 'sua-vez', 'sua vez']]);
  s = stages(c, { ...base, status: 'review', stage: 'reviewer' }, { proof: 'proven', retro: 'retro: 1 aprendizado pra você revisar' });
  assert.deepEqual(pick(s).slice(3), [['provar', 'feito', 'provado'], ['entregar', 'sua-vez', 'sua vez'], ['retro', 'feito', 'pronto']]);
  assert.equal(J(run(c, `stagesSummary(${JSON.stringify(s)})`)).now, 'Sua vez: aprovar a entrega');
  // PR aberto: tudo feito
  s = stages(c, { ...base, status: 'review', stage: 'reviewer', prUrl: 'https://x/pull/1' }, { retro: 'retro pulada: a tarefa já usou US$ 1,90 de US$ 2,00' });
  assert.ok(s.every((x) => x.state === 'feito'));
  assert.equal(s.at(-1).word, 'pulada');
});

test('faixa (P1) larga e estreita: rótulos, palavra, custo ao lado do ✓, cadeados, gasto até agora; no painel estreito só a etapa de agora', () => {
  const c = f2ctx();
  const t = { id: 't', status: 'running', stage: 'builder', roles: ROLES, spec: { taskKind: 'codigo' } };
  const x = { costs: [{ role: 'planner', agent: 'Vega', usd: 0.1 }] };
  const s = run(c, `taskStages(${JSON.stringify(t)}, ${JSON.stringify(x)})`);
  const h = run(c, `stageStripHtml(taskStages(${JSON.stringify(t)}, ${JSON.stringify(x)}), stagesSummary(taskStages(${JSON.stringify(t)}, ${JSON.stringify(x)}), { spent:0.1, cap:2 }), {})`);
  assert.match(h, /^<div class="cicstrip" role="group" aria-label="Etapas da tarefa">/);
  for (const w of ['Plano', 'Construir', 'Revisar', 'Provar', 'Entregar', 'Retro', 'pronto', 'construindo', 'depois']) assert.match(h, new RegExp(w));
  assert.match(h, /<li class="cicst s-feito"[^>]*><button[^>]*>.*Plano.*US\$ 0,10/s, 'custo ao lado do ✓');
  assert.equal((h.match(/class="cicst-k"/g) || []).length, 2, 'Cadeado 1 e Cadeado 2');
  assert.equal((h.match(/aria-current="step"/g) || []).length, 1);
  assert.match(h, /gasto <b>US\$ 0,10<\/b> de US\$ 2,00/); // redesenho F1: "gasto" curto, na mesma faixa das etapas
  assert.match(h, /<span class="cicst-pos">etapa 2 de 6<\/span>/);
  assert.equal(s.length, 6);
  // estreito: container query esconde o texto das etapas que não são a de agora e mostra "etapa n de N"
  const css = readFileSync(new URL('../src/css/95-ciclo.css', import.meta.url), 'utf8');
  assert.match(css, /\.fwciclo\{container-type:inline-size;container-name:ciclo/);
  const narrow = css.slice(css.indexOf('@container ciclo (max-width:620px)'));
  assert.match(narrow, /\.cicst:not\(\.s-agora\):not\(\.s-sua-vez\):not\(\.s-precisa\) \.cicst-tx/);
  assert.match(narrow, /\.cicst-pos\{display:inline\}/);
  assert.doesNotMatch(h + src, /melhorou/i, 'a palavra "melhorou" não aparece nunca');
});

test('a faixa e a decisão moram FORA do re-render do chat (#fwCiclo com assinatura) — sem polling novo', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="fwciclo" id="fwCiclo" hidden><\/div>/);
  assert.match(html, /<script src="js\/60-ciclo\.js"><\/script>/);
  assert.match(src, /if\(host\.__sig===sig\) return;/);
  assert.doesNotMatch(src, /setInterval|setTimeout\([^)]*refresh/, 'nada de laço');
  assert.doesNotMatch(src, /window\.confirm\(|[^a-zA-Z]confirm\(/, 'askYes, nunca confirm');
});
