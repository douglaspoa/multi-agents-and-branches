// "Meu time" (61-meu-time.js) — F3 da decisão da mesa (03/10): o boletim com n à vista (agStatsView), os limiares
// (n=0, 9, 10), renomear não muda número, a ficha com as 3 abas, o cartão de aprendizado em frase com os 4 botões,
// as equipes com a mesma faixa da tarefa e o aviso "revisor = builder". `node --test app/tests/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const mt = rd('js/61-meu-time.js');
const mem = rd('js/37-memoria.js');
const ciclo = rd('js/60-ciclo.js');
const sw = rd('js/33-switcher-projetos.js');
const html = rd('index.html');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };

const P = new Function(cut(mt, '// @meutime-puro-inicio', '// @meutime-puro-fim') +
  '\nreturn { agStatsView, agBeforeAfter, agLineDiff, agTeamRoles, agTeamWarnings, agTeamStages, agAvgByRole, agTeamCost, agDoes, agFirstTry, AG_SAME_REVIEWER };')();

const row = (i, o = {}) => ({ agentId: 'nyx', taskId: 't' + i, title: 'T' + i, status: 'merged', createdAt: i, role: 'reviewer', usd: 0.3, reworks: 0, muda: 0, rounds: 1, ...o });

// ---------------------------------------------------------------- agStatsView

test('n = 0: "ainda conhecendo esse agente", sem porcentagem nem custo', () => {
  const v = P.agStatsView([]);
  assert.equal(v.tasks, 0); assert.equal(v.n, 0); assert.equal(v.pct, null);
  assert.equal(v.knowing, true);
  assert.equal(v.note, 'ainda conhecendo esse agente');
  assert.equal(v.line, '0 tarefas');
});

test('n = 9: contagem crua "3 de 9 de primeira", sem %', () => {
  const rows = Array.from({ length: 9 }, (_, i) => row(i, i < 3 ? {} : { muda: 1 }));
  const v = P.agStatsView(rows);
  assert.equal(v.n, 9); assert.equal(v.first, 3); assert.equal(v.pct, null);
  assert.match(v.line, /^9 tarefas · 3 de 9 de primeira · devolveu 6 de 9 · ~US\$ 0,30\/tarefa$/);
  assert.ok(!/%/.test(v.line));
  assert.equal(v.note, 'ainda conhecendo esse agente');
});

test('n = 10: a porcentagem aparece AO LADO da contagem; some o "ainda conhecendo"', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i, i < 7 ? {} : { reworks: 1 }));
  const v = P.agStatsView(rows, 10, { lembra: 4 });
  assert.equal(v.pct, 70);
  assert.match(v.line, /7 de 10 de primeira \(70%\)/);
  assert.match(v.line, /lembra 4 coisas$/);
  assert.equal(v.knowing, false); assert.equal(v.note, '');
});

test('n conta só quem chegou ao portão; tarefa rodando entra em "tarefas" mas não no n', () => {
  const rows = [row(1), row(2, { status: 'running' }), row(3, { status: 'error' }), row(4, { status: 'running', prUrl: 'https://x/pull/2' })];
  const v = P.agStatsView(rows, 10);
  assert.equal(v.tasks, 4); assert.equal(v.n, 2); assert.equal(v.first, 2);
  assert.match(v.line, /^4 tarefas · 2 de 2 de primeira/);
});

test('renomear o agente não muda nenhum número (a chave é o agent_id; o nome nem entra)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i, i % 3 ? {} : { muda: 1 }));
  const a = P.agStatsView(rows.map((r) => ({ ...r, agent: 'Nyx' })));
  const b = P.agStatsView(rows.map((r) => ({ ...r, agent: 'Nyx Revisora 2' })));
  assert.deepEqual(a, b);
});

test('linha repetida da mesma tarefa conta uma vez; custo médio por tarefa', () => {
  const v = P.agStatsView([row(1, { usd: 0.2 }), row(1, { usd: 0.2 }), row(2, { usd: 0.4 })]);
  assert.equal(v.tasks, 2); assert.ok(Math.abs(v.avgUsd - 0.3) < 1e-9);
});

test('"isso ajudou?" sem amostra é "ainda medindo (k de 10)" (a conta inteira da F4 está em agentes-f4.test.mjs) e nunca diz "melhorou"', () => {
  assert.equal(P.agBeforeAfter([], 2).text, 'ainda medindo (0 de 10)');
  assert.equal(P.agBeforeAfter([], null).text, 'ainda medindo (0 de 10)');
  for (const [f, src] of [['61-meu-time.js', mt], ['37-memoria.js', mem], ['60-ciclo.js', ciclo], ['33-switcher-projetos.js', sw], ['index.html', html]]) assert.ok(!/melhorou/i.test(src), f);
});

// ---------------------------------------------------------------- equipes e P5

const cat = {
  vega: { id: 'vega', name: 'Vega', role: 'planner', engine: 'claude' },
  iris: { id: 'iris', name: 'Íris', role: 'builder', engine: 'claude' },
  nyx: { id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' },
  lumen: { id: 'lumen', name: 'Lumen', role: 'docs', engine: 'codex', model: 'gpt-5' },
  nyxc: { id: 'nyxc', name: 'Nyx C', role: 'reviewer', engine: 'codex', model: 'gpt-5' },
};

test('equipe montada à mão: revisor no mesmo motor e modelo de quem produz → aviso "revisor = builder"', () => {
  const w = P.agTeamWarnings(P.agTeamRoles(['vega', 'iris', 'nyx'], cat, false));
  assert.equal(w.length, 1);
  assert.equal(w[0].text, 'revisor igual ao builder — revisão menos independente');
  assert.match(w[0].detail, /Nyx e Íris/);
  assert.equal(P.agTeamWarnings(P.agTeamRoles(['vega', 'iris', 'nyxc'], cat, false)).length, 0, 'motor diferente');
  assert.equal(P.agTeamWarnings(P.agTeamRoles(['lumen', 'nyxc'], cat, false)).length, 1, 'documento: Lumen e o revisor no Codex/gpt-5');
});

test('equipe pronta (por tipo) faz o que a tarefa faz: no Claude o revisor vai pra outro modelo (sem aviso)', () => {
  const roles = P.agTeamRoles(['vega', 'iris', 'nyx'], cat, true);
  assert.equal(roles[2].model, 'sonnet');
  assert.equal(P.agTeamWarnings(roles).length, 0);
  assert.equal(P.agTeamWarnings(P.agTeamRoles(['lumen', 'nyxc'], cat, true)).length, 1, 'fora do Claude não troca sozinho: avisa');
});

test('faixa da equipe: papéis + Provar + Entregar (cadeado 2) + Retro; cadeado 1 no plano; custo médio por papel', () => {
  const rows = [{ agentId: 'iris', taskId: 'a', role: 'builder', usd: 0.4 }, { agentId: 'iris', taskId: 'b', role: 'builder', usd: 0.2 }, { agentId: 'nyx', taskId: 'a', role: 'reviewer', usd: 0.1 }];
  const avg = P.agAvgByRole(rows);
  assert.ok(Math.abs(avg.builder.usd - 0.3) < 1e-9); assert.equal(avg.builder.n, 2);
  const roles = P.agTeamRoles(['vega', 'iris', 'nyx'], cat, true);
  const st = P.agTeamStages(roles, avg, { builder: 'construindo' });
  assert.deepEqual(st.map((s) => s.id), ['planner', 'builder', 'reviewer', 'provar', 'entregar', 'retro']);
  assert.equal(st[0].lock, 1); assert.equal(st[4].lock, 2);
  assert.equal(st[1].word, 'construindo');
  assert.equal(P.agTeamStages(P.agTeamRoles(['iris'], cat, false), {}, {}, { builder: 'Construir' })[0].label, 'Construir', 'rótulo em português, nunca o id do papel'); assert.ok(Math.abs(st[1].usd - 0.3) < 1e-9);
  const c = P.agTeamCost(roles, avg); assert.ok(Math.abs(c.usd - 0.4) < 1e-9); assert.equal(c.n, 1);
  assert.equal(P.agTeamCost(roles, {}), null);
});

test('a faixa das equipes é a MESMA da tarefa (stageStripHtml) com rodapé próprio; compartilhar só volta pela política (F5)', () => {
  assert.match(mt, /return stageStripHtml\(st, /);
  assert.match(ciclo, /o\.foot!=null\?/);
  // F5: escondido por padrão; só aparece pra admin de org com nuvem paga e passa pela política antes de publicar
  assert.match(sw, /data-wshare="\$\{i\}"\$\{typeof orgCanShareTeams==='function'&&orgCanShareTeams\(\)\?'':' hidden'\}/);
  assert.match(sw, /orgTeamShareBlock\(agTeamRoles\(/);
  assert.match(rd('css/96-meu-time.css'), /\[data-wshare\]\[hidden\]\{display:none!important\}/);
  for (const k of ['Feature com revisão', 'Página simples', 'Relatório conferido']) assert.ok(ciclo.includes(k), k);
  assert.match(mt, /const AG_READY_KINDS=\['codigo','pagina','documento'\]/);
});

test('diff da persona por linha', () => {
  assert.deepEqual(P.agLineDiff('a\nb\nc', 'a\nB\nc').map((x) => x.t + x.s), ['=a', '-b', '+B', '=c']);
  assert.deepEqual(P.agLineDiff('', 'x').map((x) => x.t), ['-', '+']);
});

// ---------------------------------------------------------------- render da página e da ficha (sem DOM)

const stub = `
const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escA=s=>esc(s).replace(/"/g,'&quot;');
const avatarInner=a=>esc((a.name||'?').slice(0,2).toUpperCase());
const roleLabel=r=>({ reviewer:'Revisor', builder:'Construtor', docs:'Documentador' }[r]||r);
const aiRunLabel=(e,m)=>e+' · '+(m||'padrão');
const stBadge=s=>'<span class="stbadge">'+s+'</span>';
const IC={ trash:'', chevL:'' };
const MEM_ART={ nyx:'A', lumen:'A' };
const LEARN_EDIT={};
const memLearnCard=it=>'<article class="memlcard">'+it.id+'</article>';
const PALETTE=[], GLYPHS=[]; const allCats=()=>[];
const AI_ENGINES=[{ id:'claude', name:'Claude', models:[{ id:'', name:'Padrão da assinatura' }, { id:'sonnet', name:'Sonnet' }] }, { id:'codex', name:'Codex', models:[{ id:'', name:'Padrão do Codex' }] }];
let cfgEdit={ agents:[], workflows:[] };
const host={ innerHTML:'', querySelector:()=>null, querySelectorAll:()=>[] }, title={ textContent:'' };
const $id=k=>k==='agFicha'?host:k==='agTitle'?title:k==='agHome'?{}:null;
const state={ repo:'/r' };
`;
const R = new Function(stub + mt + '\nreturn { AGS, AGF, agCardHtml, agFichaRender, agMemSectionsHtml, host, title, setCfg:c=>{ cfgEdit=c; } };')();

test('cartão: rosto, nome, papel, "o que faz" numa frase, contagens com n e o "ainda conhecendo"', () => {
  R.AGS.rows = Array.from({ length: 7 }, (_, i) => row(i, i < 3 ? {} : { muda: 1 }));
  R.AGS.lembra = { nyx: 4 };
  const h = R.agCardHtml({ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude', color: '#56b6c2' }, 0);
  assert.match(h, /class="av"/);
  assert.match(h, /Nyx<span class="agc-r">Revisor<\/span>/);
  assert.match(h, /revisa código e documentos/);
  assert.match(h, /7 tarefas · 3 de 7 de primeira · devolveu 4 de 7 · ~US\$ 0,30\/tarefa · lembra 4 coisas/);
  assert.match(h, /ainda conhecendo esse agente/);
  assert.match(h, /data-open="0"/); assert.match(h, /draggable="true"/);
  R.AGS.rows = null;
  assert.match(R.agCardHtml({ id: 'nyx', name: 'Nyx', role: 'reviewer' }, 0), /lendo o que Nyx já fez/);
});

test('ficha: cabeçalho motor · modelo · versão e as 3 abas; cada aba mostra o seu conteúdo', () => {
  R.setCfg({ agents: [{ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude', model: 'sonnet', persona: 'revisa' }], workflows: [] });
  R.AGS.rows = Array.from({ length: 10 }, (_, i) => row(i, { title: 'Tarefa ' + i }));
  R.AGS.lembra = {};
  R.AGF.id = 'nyx'; R.AGF.tab = 'historico';
  R.AGF.card = { versions: { current: 4, versions: [{ v: 4, at: 1, change: 'persona', what: 'persona editada à mão', persona: 'revisa', before: 'revisa\ncom calma' }, { v: 3, at: 1, change: 'persona', what: 'x', persona: 'antiga', before: '' }] },
    learnings: { notes: [{ id: 'n1', title: 'Conferir o teste de login', body: 'b', v: 3, at: 5, taskId: 't' }, { id: 'n2', title: 'velha', body: 'b', v: 2, at: 1, taskId: 't', forgottenAt: 9 }], skills: [] } };
  R.AGF.pend = [{ id: 'p1', agente: 'nyx' }];
  R.agFichaRender();
  const h = R.host.innerHTML;
  assert.match(h, /claude · sonnet/); assert.match(h, /v4/);
  assert.match(h, /10 de 10 de primeira \(100%\)/);
  assert.ok(!/ainda conhecendo/.test(h), 'n = 10');
  // F4 (D15/D16): ficha Histórico · Desempenho · Editar; "pra você decidir", o que ela lembra e as esquecidas moram na
  // Memória › Pra revisar (agMemSectionsHtml) — a ficha mostra só o link
  for (const t of ['Histórico 10', 'Desempenho', 'Editar']) assert.match(h, new RegExp('role="tab"[^>]*>' + t + '<'));
  assert.match(h, /aria-selected="true"[^>]*>Histórico/);
  assert.match(h, /data-agtask="t9"/); assert.match(h, /stbadge/); assert.match(h, /US\$ 0,30/);
  assert.equal(R.title.textContent, 'Agentes');
  R.AGF.tab = 'aprendizados'; R.agFichaRender(); // aba antiga → Desempenho
  const d = R.host.innerHTML;
  assert.match(d, /1 aprendizado de Nyx esperando você\.[\s\S]*data-agmem="1">Ver em Memória › Pra revisar/);
  assert.match(d, /Nyx lembra 1 coisa\. <button class="lnk" data-agmem="1">ver na Memória/);
  assert.ok(!/Pra você decidir/.test(d), 'os cartões de decidir saíram da ficha');
  const a = R.agMemSectionsHtml({ id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }, R.AGF.card);
  assert.match(a, /A Nyx lembra: conferir o teste de login\./);
  assert.match(a, /desde a v3/);
  assert.match(a, /data-agback="nota" data-key="n1">voltar pro jeito antigo/);
  assert.match(a, /data-agforget="nota" data-key="n1">esquecer/);
  assert.match(a, /isso ajudou\? <span class="agba-t">ainda medindo \(\d+ de 10\)/);
  assert.match(a, /esquecidas \(1\)/);
  // Editar: motor e modelo por papel + versões com diff e restaurar
  R.AGF.tab = 'editar'; R.agFichaRender();
  const e = R.host.innerHTML;
  assert.match(e, /id="agfEngine"[\s\S]*<option value="claude" selected>Claude/);
  assert.match(e, /id="agfModel"[\s\S]*<option value="sonnet" selected>Sonnet/);
  assert.match(e, /data-agrevert="1">voltar pro jeito antigo/);
  assert.match(e, /data-agrestore="3">restaurar esta persona/);
  assert.match(e, /ver a diferença[\s\S]*class="dr">- com calma/);
});

test('ficha do revisor avisa quando uma equipe o põe no mesmo motor/modelo do builder', () => {
  R.setCfg({ agents: [{ id: 'iris', name: 'Íris', role: 'builder', engine: 'claude' }, { id: 'nyx', name: 'Nyx', role: 'reviewer', engine: 'claude' }], workflows: [{ id: 'f', name: 'Feature', steps: ['iris', 'nyx'] }] });
  R.AGF.id = 'nyx'; R.AGF.tab = 'historico'; R.agFichaRender();
  assert.match(R.host.innerHTML, /class="agwarn"[^>]*>revisor igual ao builder — revisão menos independente — Nyx e Íris no mesmo motor e modelo na equipe "Feature"/);
});

test('agente sem tarefas: histórico vazio com orientação em português', () => {
  R.setCfg({ agents: [{ id: 'cobalt', name: 'Cobalt', role: 'tester', engine: 'claude' }], workflows: [] });
  R.AGS.rows = []; R.AGF.id = 'cobalt'; R.AGF.tab = 'historico'; R.agFichaRender();
  assert.match(R.host.innerHTML, /Cobalt ainda não trabalhou em nenhuma tarefa deste projeto/);
  assert.match(R.host.innerHTML, /ainda conhecendo esse agente/);
});

// ---------------------------------------------------------------- aba, visibilidade e custo zero quando escondida

test('é ABA (VIEW_OVERLAY agents), o boletim é UMA chamada ao abrir e nada roda com a aba escondida', () => {
  const cfg = rd('js/15-config-abas-onboarding.js');
  assert.match(cfg, /agents:\{title:'Meu time'/);
  assert.match(cfg, /agents:'agOverlay'/);
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(mt), 'sem timer na página');
  const calls = (sw + mt + ciclo + mem).match(/invoke\('agent_stats'/g) || [];
  assert.equal(calls.length, 1, 'uma chamada só (agStatsLoad)');
  const open = cut(sw, 'async function openAgents(){', 'function agLock(');
  assert.match(open, /agStatsLoad\(\)\.then\(\(\)=>\{ if\(agVisible\(\)\)/, 'só pinta se a aba ainda estiver visível');
  assert.ok(!/agStatsLoad\(/.test(cut(sw, '// poll blindado', '}, 1000);')), 'o refresh do app não recalcula o boletim');
  assert.match(html, /<section id="agFicha" hidden/);
  assert.ok(!/confirm\(/.test(mt), 'askYes, nunca confirm');
});

// ---------------------------------------------------------------- cartão de aprendizado em frase (37-memoria, fonte única)

const M = new Function(cut(mem, '// @puro-inicio', '// @puro-fim') + '\nreturn { memLearnCard, memLearnSentence };')();

test('aprendizado com dono: "A Lumen vai lembrar: …" com [Guardar pra Lumen] [Só no projeto] [Editar] [Descartar]', () => {
  const it = { id: 'a1', kind: 'nota', taskId: 't', taskTitle: 'Relatório', agente: 'lumen', agenteNome: 'Lumen', papel: 'docs', nota: { title: 'Sempre citar fonte com link e data', type: 'regra', body: 'b' } };
  assert.equal(M.memLearnSentence(it), 'A Lumen vai lembrar: sempre citar fonte com link e data.');
  const h = M.memLearnCard(it);
  assert.match(h, /data-laccept="a1" data-como="agente">Guardar pra Lumen</);
  assert.match(h, /data-lproj="a1">Só no projeto</);
  assert.match(h, /data-ledit="a1">Editar</);
  assert.match(h, /data-ldiscard="a1">Descartar</);
  // jargão só em "ver detalhes"
  const before = h.slice(0, h.indexOf('<details class="memldet">'));
  assert.ok(!/skill|nota ·|versão|regra/.test(before), before);
  assert.match(h, /<details class="memldet"><summary>ver detalhes<\/summary>[\s\S]*nota · regra/);
});

test('sem dono: "O projeto vai lembrar"; skill vira "um jeito de fazer"; modo Editar mostra os campos', () => {
  const sk = { id: 's1', kind: 'skill', taskId: 't', skill: { acao: 'criar', nome: 'rodar-testes', descricao: 'Use ao validar uma mudança', corpo: 'npm test' } };
  assert.equal(M.memLearnSentence(sk), 'O projeto vai lembrar um jeito de fazer: rodar testes — use ao validar uma mudança.');
  const h = M.memLearnCard(sk);
  assert.match(h, /data-como="projeto">Guardar no projeto</);
  assert.ok(!/data-lproj/.test(h));
  const e = M.memLearnCard(sk, { editing: { a: 'Use sempre', b: 'npm test' } });
  assert.match(e, /data-ledita value="Use sempre"/);
  assert.match(e, /data-ledit="s1" data-off="1">cancelar edição/);
  assert.equal(M.memLearnSentence({ id: 'x', kind: 'nota', agente: 'cobalt', nota: { title: 'API sem cache' } }), 'O Cobalt vai lembrar: API sem cache.');
});

test('os 4 botões usam o MESMO caminho na Memória, na ficha e na etapa Retro (learnWire → learn_accept com "como")', () => {
  assert.match(mem, /invoke\('learn_accept',\{ repo, id, edited, como:act \}\)/);
  assert.match(mem, /function memWireLearn\(root\)\{ learnWire\(/);
  assert.match(mt, /learnWire\(host, ctx\)/);
  assert.match(ciclo, /learnWire\(host, \{ repo:\(\)=>state\.repo/);
  assert.match(mem, /label:'voltar pro jeito antigo'/);
});
