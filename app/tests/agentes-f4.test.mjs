// F4 da decisão da mesa (03/10): P12 antes × depois por versão (61-meu-time.js · agBeforeAfter) e P13 curador sem IA
// (62-curador.js). Limiares 4/5/9/10 por lado, filtro por tipo, oferta de "voltar" quando piora, "melhorou" nunca,
// "sem uso" e Jaccard com os casos de borda, e o render da ficha/Memória sem DOM. `node --test app/tests/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const mt = rd('js/61-meu-time.js');
const cur = rd('js/62-curador.js');
const mem = rd('js/37-memoria.js');
const html = rd('index.html');
const css = rd('css/96-meu-time.css');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };

const P = new Function(cut(mt, '// @meutime-puro-inicio', '// @meutime-puro-fim') +
  '\nreturn { agBeforeAfter, agBaKinds, agVerOf, agLearnVersion, agVersionAt, agKindOfRow, AG_BA_LOW };')();
const C = new Function(cut(cur, '// @curador-puro-inicio', '// @curador-puro-fim') +
  '\nreturn { curTokens, curJaccard, curRosterSkills, curUnused, curPairs, curSuggest, curDue, curDrop, curSummary, curSentence, curSugId, curDismissed, CUR_DAY_MS };')();

// uma tarefa do Nyx que chegou ao portão, rodada na versão `v`
let seq = 0;
const row = (v, o = {}) => ({ agentId: 'nyx', taskId: 't' + (++seq), title: 'T', status: 'merged', createdAt: seq, role: 'reviewer', kind: 'codigo',
  papel: `skills ativas: nenhuma · nyx@v${v} · claude`, usd: 0.3, reworks: 0, muda: 0, rounds: 1, trounds: 1, tusd: 1, prevUsd: 1, ...o });
const side = (n, v, o) => Array.from({ length: n }, (_, i) => row(v, typeof o === 'function' ? o(i) : o));
const words = (ba) => JSON.stringify(ba);

// ---------------------------------------------------------------- P12: limiares por lado

test('n = 4 por lado: "ainda medindo (4 de 10)" — nenhum número de métrica, nenhuma conclusão', () => {
  const ba = P.agBeforeAfter([...side(4, 1), ...side(4, 2)], 2, { kind: 'codigo' });
  assert.equal(ba.stage, 'medindo');
  assert.equal(ba.text, 'ainda medindo (4 de 10)');
  assert.equal(ba.nb, 4); assert.equal(ba.na, 4);
  assert.deepEqual(ba.metrics, []);
  assert.equal(ba.offerBack, false);
  assert.ok(!/%/.test(words(ba)));
});

test('n = 5 por lado: contagens cruas lado a lado, sem %, sem conclusão nem "voltar"', () => {
  const ba = P.agBeforeAfter([...side(5, 1), ...side(5, 2, (i) => (i < 4 ? { muda: 1, reworks: 2, usd: 1 } : {}))], 2);
  assert.equal(ba.stage, 'cru');
  assert.match(ba.text, /^lado a lado, sem conclusão: 5 tarefas antes e 5 tarefas depois/);
  const m = Object.fromEntries(ba.metrics.map((x) => [x.key, x]));
  assert.equal(m.first.before, '5 de 5'); assert.equal(m.first.after, '1 de 5');
  assert.equal(m.rework.after, '8 retrabalhos em 5 tarefas');
  assert.equal(m.rounds.before, '5 rodadas em 5 tarefas');
  assert.equal(m.usd.after, 'US$ 4,30 em 5 tarefas');
  assert.equal(m.fc.before, 'previsto US$ 5,00 · real US$ 5,00 (5 tarefas)');
  assert.ok(!/%/.test(words(ba)), 'cru = sem porcentagem');
  assert.equal(ba.offerBack, false, 'pior, mas n < 10: não conclui');
  assert.ok(ba.metrics.every((x) => !x.worse && x.change === ''));
});

test('n = 9 por lado: ainda cru; 9 × 12 também (o menor lado manda)', () => {
  assert.equal(P.agBeforeAfter([...side(9, 1), ...side(9, 2)], 2).stage, 'cru');
  const ba = P.agBeforeAfter([...side(12, 1), ...side(9, 2)], 2);
  assert.equal(ba.stage, 'cru'); assert.equal(ba.k, 9);
  const m = P.agBeforeAfter([...side(12, 1), ...side(4, 2)], 2);
  assert.equal(m.stage, 'medindo'); assert.equal(m.text, 'ainda medindo (4 de 10)');
});

test('n = 10 por lado: porcentagem e médias; nada pesou → sem "voltar"', () => {
  const ba = P.agBeforeAfter([...side(10, 1), ...side(10, 2)], 2);
  assert.equal(ba.stage, 'pct');
  const m = Object.fromEntries(ba.metrics.map((x) => [x.key, x]));
  assert.equal(m.first.before, '100% (10 de 10)');
  assert.equal(m.first.change, 'igual');
  assert.equal(m.rounds.after, '1,0 por tarefa');
  assert.equal(m.usd.after, 'US$ 0,30 por tarefa');
  assert.equal(m.fc.before, 'erra 0% em média');
  assert.equal(ba.offerBack, false);
  assert.equal(ba.text, 'antes × depois com 10 tarefas e 10 tarefas: nada pesou além da margem');
});

test('n ≥ 10 e prova de primeira caiu 30 pontos → "parece ter atrapalhado — voltar pro jeito antigo?"', () => {
  const ba = P.agBeforeAfter([...side(10, 1, (i) => (i < 2 ? { muda: 1 } : {})), ...side(10, 2, (i) => (i < 5 ? { muda: 1 } : {}))], 2);
  const m = Object.fromEntries(ba.metrics.map((x) => [x.key, x]));
  assert.equal(m.first.before, '80% (8 de 10)'); assert.equal(m.first.after, '50% (5 de 10)');
  assert.equal(m.first.change, '−30 pontos');
  assert.ok(m.first.worse);
  assert.equal(ba.offerBack, true);
  assert.deepEqual(ba.worse, ['prova de primeira']);
  assert.equal(ba.text, 'parece ter atrapalhado (prova de primeira) — voltar pro jeito antigo?');
});

test('margem: custo +20% pesa; +5% não; prova de primeira −9 pontos não pesa', () => {
  const up = P.agBeforeAfter([...side(10, 1, { usd: 1 }), ...side(10, 2, { usd: 1.2 })], 2);
  assert.deepEqual(up.worse, ['custo dele']);
  assert.equal(up.metrics.find((x) => x.key === 'usd').change, '+20%');
  assert.equal(P.agBeforeAfter([...side(10, 1, { usd: 1 }), ...side(10, 2, { usd: 1.05 })], 2).offerBack, false);
  const rw = P.agBeforeAfter([...side(10, 1), ...side(10, 2, (i) => (i < 3 ? { reworks: 1 } : {}))], 2);
  assert.ok(rw.worse.includes('retrabalho'), 'retrabalho de 0 → 0,3 por tarefa pesa');
  const nine = P.agBeforeAfter([...side(11, 1), ...side(11, 2, (i) => (i < 1 ? { muda: 1 } : {}))], 2);
  assert.ok(!nine.worse.includes('prova de primeira'), '100% → 91%: −9 pontos, dentro da margem');
});

test('erro da previsão: só compara com 10 previsões de cada lado; erro maior pesa', () => {
  const few = P.agBeforeAfter([...side(10, 1, (i) => (i < 6 ? {} : { prevUsd: null })), ...side(10, 2)], 2);
  const fc = few.metrics.find((x) => x.key === 'fc');
  assert.equal(fc.change, 'poucas previsões pra comparar'); assert.equal(fc.worse, false);
  const worse = P.agBeforeAfter([...side(10, 1, { tusd: 1.1 }), ...side(10, 2, { tusd: 1.5 })], 2);
  const f2 = worse.metrics.find((x) => x.key === 'fc');
  assert.equal(f2.before, 'erra 10% em média'); assert.equal(f2.after, 'erra 50% em média');
  assert.ok(f2.worse);
});

test('filtro por tipo: 10 × 10 de Documento comparam; 3 × 3 de Código ainda medem; tipo com mais comparação vem 1º', () => {
  const rows = [...side(10, 1, { kind: 'documento' }), ...side(10, 2, { kind: 'documento' }), ...side(3, 1), ...side(3, 2)];
  assert.equal(P.agBeforeAfter(rows, 2, { kind: 'documento' }).stage, 'pct');
  const c = P.agBeforeAfter(rows, 2, { kind: 'codigo' });
  assert.equal(c.stage, 'medindo'); assert.equal(c.text, 'ainda medindo (3 de 10)');
  assert.equal(P.agBeforeAfter(rows, 2).kind, 'codigo', 'sem tipo escolhido = Código, nunca misturado');
  assert.deepEqual(P.agBaKinds(rows, 2).map((k) => [k.kind, k.nb, k.na]), [['documento', 10, 10], ['codigo', 3, 3]]);
  // sem taskKind: pelo branchType (≡ taskKindOf)
  assert.equal(P.agKindOfRow({ branchType: 'docs' }), 'documento');
  assert.equal(P.agKindOfRow({ kind: 'xyz' }), 'codigo');
});

test('só entra tarefa medida: chegou ao portão, tem `papel` com versão legível, uma linha por tarefa', () => {
  const ok = side(5, 1);
  const extra = [row(2, { status: 'running' }), row(2, { papel: null }), row(2, { papel: 'skills ativas: nenhuma · nyx · claude' }), row(2, { papel: 'texto qualquer' })];
  const dup = side(5, 2); const again = dup.map((r) => ({ ...r, role: 'builder' }));
  const ba = P.agBeforeAfter([...ok, ...extra, ...dup, ...again], 2);
  assert.equal(ba.nb, 5); assert.equal(ba.na, 5, 'fora do portão, sem papel e versão ilegível não contam; repetida conta 1×');
  assert.equal(P.agBeforeAfter(ok, null).text, 'ainda medindo (0 de 10)', 'sem versão do aceite = ainda medindo');
});

test('agVerOf lê a versão do agente na linha do `papel` (P10)', () => {
  assert.equal(P.agVerOf('skills ativas: a@v3, b@v1 · nyx@v4 · codex'), 4);
  assert.equal(P.agVerOf('skills ativas: nenhuma · Íris@v12 · claude · sonnet'), 12);
  assert.equal(P.agVerOf('skills ativas: a@v3 · nyx · codex'), null);
  assert.equal(P.agVerOf(''), null);
  assert.equal(P.agVerOf(null), null);
});

test('qual versão o aprendizado criou: nota = v; skill = entrada "skill" do agente; sem ela, a 1ª tarefa depois do aceite', () => {
  assert.equal(P.agLearnVersion('nota', { v: 3 }, [], []), 3);
  const versions = [{ v: 2, change: 'skill', what: 'menor-diff' }, { v: 3, change: 'persona', what: 'x' }, { v: 4, change: 'skill', what: 'menor-diff' }];
  assert.equal(P.agLearnVersion('skill', { name: 'menor-diff', at: 1 }, versions, []), 4, 'a mais recente');
  const rows = [row(5, { createdAt: 100 }), row(6, { createdAt: 200 }), row(7, { createdAt: 50 })];
  assert.equal(P.agLearnVersion('skill', { name: 'outra', at: 90 }, versions, rows), 5);
  assert.equal(P.agLearnVersion('skill', { name: 'outra', at: 0 }, versions, rows), null);
});

test('a palavra "melhorou" (nem "melhor") nunca aparece — em nenhum estágio, nem no código', () => {
  const scenarios = [];
  for (const n of [0, 4, 5, 9, 10, 15]) for (const mod of [{}, { usd: 0.1 }, { usd: 3 }, { muda: 1 }, { reworks: 2 }, { tusd: 9 }]) {
    scenarios.push(P.agBeforeAfter([...side(n, 1), ...side(n, 2, mod)], 2));
    scenarios.push(P.agBeforeAfter([...side(n, 1, mod), ...side(n, 2)], 2));
  }
  for (const s of scenarios) assert.ok(!/melhor/i.test(words(s)), words(s));
  for (const [f, src] of [['61-meu-time.js', mt], ['62-curador.js', cur], ['37-memoria.js', mem], ['96-meu-time.css', css]]) assert.ok(!/melhorou/i.test(src), f);
});

// ---------------------------------------------------------------- P13: curador (puro)

const NOW = 100 * 86400000;
const DAY = 86400000;
const usage = (txt, daysAgo, agentId = 'nyx') => ({ agentId, text: txt, ts: NOW - daysAgo * DAY });

test('tokens normalizados: sem acento, minúsculo, sem palavra vazia nem letra solta; Jaccard com vazio = 0', () => {
  assert.deepEqual([...C.curTokens('Sempre citar a FONTE, com link e data (é obrigatório)!')].sort(), ['citar', 'data', 'fonte', 'link', 'obrigatorio']);
  assert.equal(C.curJaccard(C.curTokens(''), C.curTokens('')), 0);
  assert.equal(C.curJaccard(C.curTokens('a e o'), C.curTokens('x')), 0, 'só palavra vazia = conjunto vazio, nunca casa');
  assert.equal(C.curJaccard(C.curTokens('rodar testes antes'), C.curTokens('Rodar TESTES antes')), 1);
});

test('lista "skills ativas" do papel: nomes do 1º trecho; "nenhuma" = []', () => {
  assert.deepEqual(C.curRosterSkills('skills ativas: a@v3, a-2@v1 · nyx@v4 · codex'), ['a', 'a-2']);
  assert.deepEqual(C.curRosterSkills('skills ativas: nenhuma · nyx@v4 · codex'), []);
  assert.deepEqual(C.curRosterSkills('outra coisa'), []);
});

test('"sem uso": skill fora de toda lista nos 30 dias e aceita há ≥ 30 dias; prefixo de nome não conta como uso', () => {
  const items = [
    { kind: 'skill', key: 'a', owner: '', title: 'a', at: NOW - 40 * DAY },
    { kind: 'skill', key: 'usada', owner: 'nyx', title: 'usada', at: NOW - 40 * DAY },
    { kind: 'skill', key: 'nova', owner: '', title: 'nova', at: NOW - 10 * DAY },
    { kind: 'skill', key: 'sem-data', owner: '', title: 'x', at: 0 },
    { kind: 'skill', key: 'velha-uso', owner: '', title: 'x', at: NOW - 90 * DAY },
  ];
  const u = [usage('skills ativas: a-2@v1, usada@v3 · nyx@v4 · claude', 2), usage('skills ativas: velha-uso@v1 · nyx@v2 · claude', 45)];
  const r = C.curUnused(items, u, NOW, 30);
  assert.deepEqual(r.map((x) => x.key), ['a', 'velha-uso'], 'a-2 não é a; nova é recente; sem data não se sabe; uso de 45 dias atrás fica fora da janela');
  assert.equal(r[0].type, 'arquivar'); assert.equal(r[0].days, 30);
});

test('"sem uso" de nota do agente = o dono não rodou nenhum papel na janela; projeto parado = nada', () => {
  const items = [
    { kind: 'nota', key: 'n1', owner: 'nyx', title: 'Conferir login', at: NOW - 60 * DAY },
    { kind: 'nota', key: 'n2', owner: 'lumen', title: 'Citar fonte', at: NOW - 60 * DAY },
  ];
  assert.deepEqual(C.curUnused(items, [usage('skills ativas: nenhuma · nyx@v2 · claude', 3)], NOW).map((x) => x.key), ['n2']);
  assert.deepEqual(C.curUnused(items, [], NOW), [], 'nenhuma tarefa em 30 dias: não sugere nada');
  assert.deepEqual(C.curUnused(items, [usage('skills ativas: nenhuma · nyx@v2 · claude', 31)], NOW), [], 'só uso velho = projeto parado');
});

test('Jaccard ≥ 0,8: igual sugere juntar; 0,8 exato entra; 0,75 não; dono ou tipo diferente nunca; vazio nunca', () => {
  const n = (key, owner, text, kind = 'nota') => ({ kind, key, owner, title: key, text, at: 1 });
  const items = [
    n('n1', 'lumen', 'Citar fonte com link e data'),
    n('n2', 'lumen', 'citar a fonte, com link e data.'),
    n('n3', 'nyx', 'Citar fonte com link e data'),
    n('s1', 'lumen', 'Citar fonte com link e data', 'skill'),
    n('e1', 'lumen', ''), n('e2', 'lumen', 'de a o'),
    n('p1', 'iris', 'alfa beta gama delta'), n('p2', 'iris', 'alfa beta gama delta epsilon'), // 4/5 = 0,8
    n('q1', 'cobalt', 'alfa beta gama'), n('q2', 'cobalt', 'alfa beta gama delta'),           // 3/4 = 0,75
  ];
  const pairs = C.curPairs(items);
  assert.deepEqual(pairs.map((p) => [p.a.key, p.b.key, p.sim]), [['n1', 'n2', 1], ['p1', 'p2', 0.8]]);
  assert.equal(pairs[0].type, 'juntar'); assert.equal(pairs[0].owner, 'lumen');
});

test('rodada: dispensado não volta; ids estáveis; resumo e frase em português', () => {
  const input = { now: NOW, usage: [usage('skills ativas: nenhuma · iris@v1 · claude', 1, 'iris')], items: [
    { kind: 'skill', key: 'menor-diff', owner: 'nyx', title: 'menor-diff', text: 'mude o mínimo', at: NOW - 40 * DAY },
    { kind: 'nota', key: 'n1', owner: 'lumen', title: 'Citar fonte', text: 'citar fonte link', at: NOW - 40 * DAY },
    { kind: 'nota', key: 'n2', owner: 'lumen', title: 'Fonte sempre', text: 'citar fonte link', at: NOW - 40 * DAY },
  ] };
  const all = C.curSuggest(input);
  assert.deepEqual(all.map((s) => s.id), ['arquivar:skill:nyx:menor-diff', 'arquivar:nota:lumen:n1', 'arquivar:nota:lumen:n2', 'juntar:nota:lumen:n1:n2']);
  assert.equal(C.curSummary(all), '1 skill sem uso há 30 dias · 2 notas sem uso há 30 dias · 1 par parecido — revisar?');
  assert.equal(C.curSentence(all[0], 'Nyx'), 'Nyx: o jeito de fazer «menor diff» não entrou em nenhuma tarefa nos últimos 30 dias.');
  assert.equal(C.curSentence(all[3], ''), '«Citar fonte» e «Fonte sempre» dizem quase a mesma coisa.');
  const left = C.curSuggest(input, { dismissed: [{ id: 'juntar:nota:lumen:n1:n2', at: NOW - DAY }, { id: 'arquivar:skill:nyx:menor-diff', at: NOW - 10 * DAY }] });
  assert.deepEqual(left.map((s) => s.id), ['arquivar:nota:lumen:n1', 'arquivar:nota:lumen:n2']);
  assert.deepEqual(C.curDrop(all, 'nota', 'n1', 'lumen').map((s) => s.id), ['arquivar:skill:nyx:menor-diff', 'arquivar:nota:lumen:n2'], 'agir num item tira o par dele também');
  assert.equal(C.curSummary([]), '');
  for (const s of all) assert.ok(!/melhor/i.test(C.curSentence(s, 'X')));
});

test('"deixar como está" vale 90 dias: depois a sugestão pode voltar; entrada estragada é ignorada', () => {
  const d = [{ id: 'a', at: NOW - 89 * DAY }, { id: 'b', at: NOW - 91 * DAY }, { id: 'c' }, 'd', null];
  assert.deepEqual(C.curDismissed(d, NOW).map((x) => x.id), ['a']);
});

test('tipo da tarefa na comparação ≡ taskKindOf (golden fluxos.json do ciclo)', () => {
  const g = JSON.parse(readFileSync(new URL('../../tests/fixtures/ciclo-golden/fluxos.json', import.meta.url), 'utf8'));
  for (const [i, e] of g.taskKindOf) assert.equal(P.agKindOfRow({ kind: i.taskKind, branchType: i.branchType }), e, JSON.stringify(i));
});

test('no máximo uma rodada por dia', () => {
  assert.equal(C.curDue(null, NOW), true);
  assert.equal(C.curDue({ at: NOW - 3 * 3600000 }, NOW), false, '3 h atrás: usa o guardado');
  assert.equal(C.curDue({ at: NOW - DAY }, NOW), true, '24 h: roda de novo');
  assert.equal(C.curDue({ at: NOW + DAY }, NOW), true, 'relógio voltou: roda');
});

test('curador: sem timer, sem confirm, sem IA; só lê o banco quando a rodada venceu; Memória e ficha chamam ao ABRIR', () => {
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(cur));
  assert.ok(!/confirm\(/.test(cur)); assert.match(cur, /await askYes\(/);
  assert.ok(!/ai_once|ai_estimate|claude/i.test(cut(cur, '// @curador-puro-inicio', '// @curador-puro-fim')));
  const load = cut(cur, 'async function curLoadNow(', 'function curAgentName(');
  assert.match(load, /if\(curDue\(st, Date\.now\(\)\)\)\{\s*const inp=await invoke\('curator_inputs'/);
  assert.equal((cur + mt + mem).match(/invoke\('curator_inputs'/g).length, 1);
  assert.match(mem, /async function openMemoria\(\)[\s\S]*?curLoad\(r\)\.then\(\(\)=>\{ if\(memVisible\(\)/, 'Memória: depois de pintar as notas, sem segurar a abertura');
  assert.match(cut(mt, 'async function agFichaLoad(', 'function agFichaAgent('), /curLoad\(repo\)/);
  assert.match(html, /<script src="js\/61-meu-time\.js"><\/script>\n<script src="js\/62-curador\.js"><\/script>/);
});

// ---------------------------------------------------------------- render (sem DOM): ficha e Memória

const stub = `
const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escA=s=>esc(s).replace(/"/g,'&quot;');
const avatarInner=a=>esc((a.name||'?').slice(0,2).toUpperCase());
const roleLabel=r=>r; const aiRunLabel=(e,m)=>e+' · '+(m||'padrão');
const stBadge=s=>'<span class="stbadge">'+s+'</span>';
const IC={ trash:'', chevL:'' }; const MEM_ART={ nyx:'A' }; const LEARN_EDIT={};
const memLearnCard=it=>'<article class="memlcard">'+it.id+'</article>';
const PALETTE=[], GLYPHS=[]; const allCats=()=>[]; const AI_ENGINES=[{ id:'claude', name:'Claude', models:[] }];
let cfgEdit={ agents:[], workflows:[] };
const host={ innerHTML:'', querySelector:()=>null, querySelectorAll:()=>[] }, title={ textContent:'' };
const $id=k=>k==='agFicha'?host:k==='agTitle'?title:k==='agHome'?{}:null;
const state={ repo:'/r', config:{ agents:[{ id:'nyx', name:'Nyx' }, { id:'lumen', name:'Lumen' }] } };
`;
const R = new Function(stub + mt + '\n' + cur + '\nreturn { AGS, AGF, CUR, agFichaRender, agMemSectionsHtml, curHtml, host, setCfg:c=>{ cfgEdit=c; } };')();

test('ficha › Aprendizados: "Antes e depois" por versão, chips de tipo, "isso ajudou?" com a tabela e o "voltar" quando pesou', () => {
  R.setCfg({ agents: [{ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }], workflows: [] });
  seq = 0;
  R.AGS.rows = [...side(10, 2, (i) => (i < 1 ? { muda: 1 } : {})), ...side(10, 3, (i) => (i < 6 ? { muda: 1 } : {})), ...side(2, 3, { kind: 'documento' })];
  R.AGS.lembra = {};
  R.AGF.id = 'nyx'; R.AGF.tab = 'aprendizados'; R.AGF.kind = null; R.AGF.pend = [];
  R.AGF.card = { versions: { current: 3, versions: [{ v: 2, at: 1, change: 'persona', what: 'persona editada' }, { v: 3, at: 2, change: 'nota', what: 'Conferir o teste de login' }] },
    learnings: { notes: [{ id: 'n1', title: 'Conferir o teste de login', body: 'b', v: 3, at: 5, taskId: 't' }], skills: [] } };
  R.CUR.data = { at: 1, suggestions: [{ id: 'arquivar:nota:nyx:n1', type: 'arquivar', kind: 'nota', key: 'n1', owner: 'nyx', title: 'Conferir o teste de login', days: 30 }], dismissed: [] };
  R.CUR.archived = [{ kind: 'skill', key: 'velha-skill', owner: 'nyx', reason: 'sem uso há 30 dias (curador)' }];
  R.agFichaRender();
  // F4 (D16): a ficha mostra Desempenho (antes e depois + amostra); o que ele lembra, o curador e os esquecidos moram
  // na Memória › Pra revisar (agMemSectionsHtml) — a aba antiga "aprendizados" abre Desempenho
  const hf = R.host.innerHTML;
  assert.equal(R.AGF.tab, 'desempenho');
  assert.match(hf, /data-agftab="desempenho"[^>]*>Desempenho</);
  const h = hf + R.agMemSectionsHtml({ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }, R.AGF.card);
  assert.match(h, /<h3 class="agf-h3">Antes e depois de cada versão<\/h3>/);
  assert.match(h, /data-agbakind="codigo">Código <span class="dim">20<\/span>/);
  assert.match(h, /data-agbakind="documento">Documento/);
  // v3 (a nota): 90% → 40% de primeira → pesou, com o botão do item
  assert.match(h, /isso ajudou\? <span class="agba-t">parece ter atrapalhado \(prova de primeira\) — voltar pro jeito antigo\?<\/span>/);
  assert.match(h, /<td>90% \(9 de 10\)<\/td><td>40% \(4 de 10\)<\/td><td>−50 pontos <span class="agba-w">pesou<\/span>/);
  assert.match(h, /<button class="btn sm primary" data-agback="nota" data-key="n1">voltar pro jeito antigo<\/button>/);
  // v2 (persona) não é a atual: sem botão de reverter; só v ≥ 2 aparecem
  assert.match(h, /<span class="agf-lv">v2<\/span> <span class="agba-what">persona editada<\/span><details class="agf-ba"><summary><span class="agba-t">ainda medindo \(0 de 10\)/);
  // curador na ficha (só o que é dele) + skill arquivada dele com restaurar
  assert.match(h, /Arrumar a memória<\/span> <span class="cursum">1 nota sem uso há 30 dias — revisar\?/);
  assert.match(h, /data-curarch="arquivar:nota:nyx:n1">Arquivar/);
  assert.match(h, /data-currestore="skill" data-key="velha-skill" data-owner="nyx">restaurar/);
  assert.ok(!/melhor/i.test(h));
  // trocar pra Documento: 0 × 2 → ainda medindo
  R.AGF.kind = 'documento'; R.agFichaRender();
  assert.match(R.host.innerHTML + R.agMemSectionsHtml({ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }, R.AGF.card), /isso ajudou\? <span class="agba-t">ainda medindo \(0 de 10\)/);
  assert.match(R.host.innerHTML, /aria-checked="true" data-agbakind="documento"/);
});

test('Memória: cartões de todos os donos + "arquivados" com restaurar; nada quando não há o que mostrar', () => {
  R.CUR.err = '';
  R.CUR.data = { at: 1, dismissed: [], suggestions: [
    { id: 'arquivar:skill::rodar', type: 'arquivar', kind: 'skill', key: 'rodar-testes', owner: '', title: 'rodar-testes', days: 30 },
    { id: 'juntar:nota:lumen:a:b', type: 'juntar', kind: 'nota', owner: 'lumen', sim: 0.86, a: { key: 'a', title: 'Citar fonte' }, b: { key: 'b', title: 'Fonte sempre' } }] };
  R.CUR.archived = [{ kind: 'nota', key: 'n9', owner: 'lumen', title: 'Velha', reason: 'parecida com «Citar fonte» (curador)', archived: true }];
  const h = R.curHtml(null);
  assert.match(h, /1 skill sem uso há 30 dias · 1 par parecido — revisar\?/);
  assert.match(h, /«rodar testes» não entrou em nenhuma tarefa nos últimos 30 dias\./);
  assert.match(h, /Lumen: «Citar fonte» e «Fonte sempre» dizem quase a mesma coisa\./);
  assert.match(h, /data-curmerge="juntar:nota:lumen:a:b" data-keep="a">Ficar com «Citar fonte»/);
  assert.match(h, /data-curkeep="juntar:nota:lumen:a:b">Deixar as duas/);
  assert.match(h, /86% das palavras em comum \(Jaccard 0,86\)/, 'jargão só em ver detalhes');
  assert.match(h, /arquivados \(1\)[\s\S]*data-currestore="nota" data-key="n9" data-owner="lumen">restaurar/);
  const before = h.slice(0, h.indexOf('<details class="curdet">'));
  assert.ok(!/Jaccard/.test(before), 'sem jargão fora de "ver detalhes"');
  for (const m of h.matchAll(/<p class="cursent">([^<]*)<\/p>/g)) assert.ok(!/skill|Jaccard|vers/.test(m[1]), m[1]); // o resumo usa "skills sem uso" (redação da decisão)
  R.CUR.data = { at: 1, suggestions: [], dismissed: [] }; R.CUR.archived = [];
  assert.equal(R.curHtml(null), '');
});

// ---------------------------------------------------------------- executando curLoad e os botões (invoke de mentira)

function curRig(store) {
  const calls = [];
  const btns = [];
  const env = `
const state={ repo:'/r', config:{ agents:[] } };
const calls=__calls, store=__store;
const invoke=async(cmd,a)=>{ calls.push([cmd, JSON.parse(JSON.stringify(a||{}))]);
  if(cmd==='curator_state') return store.state; if(cmd==='curator_inputs') return store.inputs; if(cmd==='curator_archived') return store.archived||[];
  if(cmd==='curator_save'){ if(store.saveFails) throw new Error('disco cheio'); store.state=a.data; return null; }
  if(cmd==='curator_archive'){ if(store.archiveErr) throw new Error(store.archiveErr); return {}; }
  if(cmd==='curator_restore') return {}; return null; };
const askYes=async()=>true, toast=()=>{}, showErr=()=>{};
`;
  const C2 = new Function('__calls', '__store', env + cur + '\nreturn { CUR, curLoad, curWire };')(calls, store);
  const root = { querySelectorAll: (sel) => btns.filter((b) => sel.includes(b.attr)) };
  const btn = (attr, data) => { const b = { attr, dataset: data, disabled: false, closest: () => null }; btns.push(b); return b; };
  return { calls, C2, root, btn, btns };
}
const inputsOf = () => ({ now: NOW, usage: [usage('skills ativas: nenhuma · iris@v1 · claude', 1, 'iris')], archived: [], items: [
  { kind: 'nota', key: 'n1', owner: 'lumen', title: 'Citar fonte', text: 'citar fonte link data', at: NOW - 40 * DAY },
  { kind: 'nota', key: 'n2', owner: 'lumen', title: 'Fonte sempre', text: 'citar fonte link data', at: NOW - 40 * DAY }] });

test('curLoad: rodada vencida lê o banco, carrega as dispensas e guarda; no mesmo dia só lê o guardado; duas aberturas = 1 leitura', async () => {
  const store = { state: { at: 1, suggestions: [], dismissed: [{ id: 'juntar:nota:lumen:n1:n2', at: Date.now() - DAY }] }, inputs: inputsOf() };
  const { calls, C2 } = curRig(store);
  await Promise.all([C2.curLoad('/r'), C2.curLoad('/r')]);
  assert.equal(calls.filter((c) => c[0] === 'curator_inputs').length, 1, 'duas telas abrindo juntas: uma rodada só');
  const saved = calls.filter((c) => c[0] === 'curator_save');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0][1].data.dismissed.map((d) => d.id), ['juntar:nota:lumen:n1:n2'], 'a dispensa atravessa o dia');
  assert.ok(!saved[0][1].data.suggestions.some((s) => s.type === 'juntar'), 'o par dispensado não volta');
  assert.deepEqual(saved[0][1].data.suggestions.map((s) => s.id), ['arquivar:nota:lumen:n1', 'arquivar:nota:lumen:n2']);
  calls.length = 0;
  store.state.at = Date.now() - 3600000;
  await C2.curLoad('/r');
  assert.deepEqual(calls.map((c) => c[0]), ['curator_state', 'curator_archived'], 'no mesmo dia: sem banco, sem gravar');
});

test('curLoad: falhar ao GUARDAR não vira erro na tela (as sugestões aparecem)', async () => {
  const { C2 } = curRig({ state: null, inputs: inputsOf(), saveFails: true });
  await C2.curLoad('/r');
  assert.equal(C2.CUR.err, '');
  assert.equal(C2.CUR.data.suggestions.length, 3);
});

test('botões: "Ficar com «B»" arquiva o A; "Deixar" guarda a dispensa com data; erro passageiro mantém o cartão', async () => {
  const store = { state: null, inputs: inputsOf() };
  const { calls, C2, root, btn, btns } = curRig(store);
  await C2.curLoad('/r');
  const pair = C2.CUR.data.suggestions.find((s) => s.type === 'juntar');
  let after = 0; const ctx = { repo: () => '/r', after: async () => { after++; } };
  const keepB = btn('data-curmerge', { curmerge: pair.id, keep: 'b' });
  C2.curWire(root, ctx);
  await keepB.onclick();
  const arch = calls.filter((c) => c[0] === 'curator_archive');
  assert.equal(arch.length, 1);
  assert.equal(arch[0][1].key, pair.a.key, 'ficar com o B arquiva o A');
  assert.match(arch[0][1].reason, /parecida com «Fonte sempre»/);
  assert.ok(!C2.CUR.data.suggestions.some((s) => s.id === pair.id || (s.type === 'arquivar' && s.key === pair.a.key)), 'saem as sugestões do arquivado');
  assert.equal(after, 1);
  // deixar como está
  btns.length = 0; calls.length = 0;
  const left = C2.CUR.data.suggestions[0];
  const keep = btn('data-curkeep', { curkeep: left.id });
  C2.curWire(root, ctx);
  await keep.onclick();
  const sv = calls.filter((c) => c[0] === 'curator_save').pop();
  assert.ok(sv[1].data.dismissed.some((d) => d.id === left.id && d.at > 0), 'dispensa guardada com a data');
  assert.ok(!sv[1].data.suggestions.some((s) => s.id === left.id));
  // erro passageiro: o cartão fica; item que sumiu: o cartão sai
  store.inputs = inputsOf(); store.state = null; await C2.curLoad('/r');
  const one = C2.CUR.data.suggestions.find((s) => s.type === 'arquivar');
  btns.length = 0; store.archiveErr = 'database is locked';
  const ar = btn('data-curarch', { curarch: one.id });
  C2.curWire(root, ctx); await ar.onclick();
  assert.ok(C2.CUR.data.suggestions.some((s) => s.id === one.id), 'erro passageiro mantém a sugestão');
  store.archiveErr = 'esse agente não lembra mais disso';
  btns.length = 0; const ar2 = btn('data-curarch', { curarch: one.id });
  C2.curWire(root, ctx); await ar2.onclick();
  assert.ok(!C2.CUR.data.suggestions.some((s) => s.id === one.id), 'item que já sumiu: a sugestão sai');
});

test('ficha: esquecida 2× aparece uma vez; "depois" avisa quando inclui versões seguintes', () => {
  R.setCfg({ agents: [{ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }], workflows: [] });
  R.CUR.data = { at: 1, suggestions: [], dismissed: [] }; R.CUR.archived = [];
  R.AGF.id = 'nyx'; R.AGF.tab = 'aprendizados'; R.AGF.kind = null; R.AGF.pend = [];
  R.AGF.card = { versions: { current: 4, versions: [{ v: 2, at: 1, change: 'nota', what: 'x' }] },
    learnings: { notes: [{ id: 'n0', title: 'Velha', body: 'b', v: 2, at: 1, forgottenAt: 3 }, { id: 'n0', title: 'Velha', body: 'b', v: 2, at: 4, forgottenAt: 6 }], skills: [] } };
  R.agFichaRender(); // F4: o antes/depois fica na ficha (Desempenho); as esquecidas moram na Memória
  const h = R.host.innerHTML + R.agMemSectionsHtml({ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }, R.AGF.card);
  assert.match(h, /esquecidas \(1\)/);
  assert.equal((h.match(/data-currestore="nota" data-key="n0"/g) || []).length, 1);
  assert.match(h, /o &quot;depois&quot; inclui as v3 a v4|o "depois" inclui as v3 a v4/);
});
