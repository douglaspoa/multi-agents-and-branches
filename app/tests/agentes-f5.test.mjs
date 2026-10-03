// F5 da decisão da mesa (03/10): P14 política da organização (63-politica-org.js ≡ src/org-policy.ts pelo golden
// politica.json), P17 compartilhar aprendizado por item ("nome de cliente", quem decide, nuvem só no pago), P15 testar
// numa amostra (candidatas, preço em faixa + teto, nunca "melhorou") e a persona sugerida (cartão sem "só no projeto").
// `node --test app/tests/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const root = (f) => new URL('../../' + f, import.meta.url);
const pol = rd('js/63-politica-org.js');
const mt = rd('js/61-meu-time.js');
const mem = rd('js/37-memoria.js');
const sw = rd('js/33-switcher-projetos.js');
const iss = rd('js/14-issues-projeto.js');
const ciclo = rd('js/60-ciclo.js');
const html = rd('index.html');
const css = rd('css/96-meu-time.css');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const gold = (f) => JSON.parse(readFileSync(root('tests/fixtures/ciclo-golden/' + f), 'utf8'));

const P = new Function(cut(pol, '// @politica-puro-inicio', '// @politica-puro-fim') +
  '\nreturn { orgAgentPolicy, orgPolActive, policyRules, teamPolicyIssues, teamPolicyView, orgPlanOf, orgCloudPaid, canDecideLearning, approverWords, shareNames, sampleCandidates, sampleEstimate, sampleVerdictText, sampleCompareText, polVerOf };')();

// ---------------------------------------------------------------- P14
test('golden politica.json: o app normaliza, escreve as regras e acha o que a equipe fere igual ao motor', () => {
  const g = gold('politica.json');
  for (const c of g.policy) { assert.deepEqual(P.orgAgentPolicy(c.raw), c.expected, JSON.stringify(c.raw)); assert.deepEqual(P.policyRules(c.expected), c.rules); }
  for (const c of g.issues) assert.deepEqual(P.teamPolicyIssues(c.roles, c.policy), c.expected);
});

test('teamPolicyView: o que o motor conserta sozinho aparece como aviso; o que não dá é "bloqueado"', () => {
  const p = P.orgAgentPolicy({ revisor: true, revisorDiferente: true });
  const sem = [{ role: 'builder', name: 'Íris', engine: 'claude' }];
  assert.deepEqual(P.teamPolicyView(sem, p, true).map((x) => x.blocked), [false]);
  assert.deepEqual(P.teamPolicyView(sem, p, false).map((x) => x.blocked), [true]);
  const claude = [{ role: 'builder', name: 'Íris', engine: 'claude', model: 'opus' }, { role: 'reviewer', name: 'Nyx', engine: 'claude', model: 'opus' }];
  assert.equal(P.teamPolicyView(claude, p, true)[0].blocked, false);
  assert.match(P.teamPolicyView(claude, p, true)[0].fix, /outro modelo/);
  const codex = [{ role: 'builder', name: 'Íris', engine: 'codex' }, { role: 'reviewer', name: 'Nyx', engine: 'codex' }];
  assert.equal(P.teamPolicyView(codex, p, true)[0].blocked, true);
  assert.deepEqual(P.teamPolicyView(claude, P.orgAgentPolicy({}), true), []);
});

test('orgPlanOf / orgCloudPaid: política só com Empresa ativa; nuvem do aprendizado com licença ou assinatura', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(P.orgPlanOf({ plan: 'enterprise', paid_until: null }, now), 'empresa');
  assert.equal(P.orgPlanOf({ plan: 'enterprise', paid_until: '2026-12-01' }, now), 'empresa');
  assert.equal(P.orgPlanOf({ plan: 'enterprise', paid_until: '2026-09-01' }, now), '', 'Empresa vencida = nada');
  assert.equal(P.orgPlanOf({ plan: 'team', paid_until: '2026-11-01' }, now), 'pago');
  assert.equal(P.orgPlanOf({ plan: 'team', paid_until: null }, now), '');
  assert.equal(P.orgPlanOf(null, now), '');
  assert.equal(P.orgCloudPaid({ plan: 'team' }, { status: 'active' }, now), true);
  assert.equal(P.orgCloudPaid({ plan: 'team' }, { status: 'canceled' }, now), false);
  assert.equal(P.orgCloudPaid(null, { status: 'active' }, now), false, 'sem org não há nuvem do time');
});

test('o Grátis nunca toca na rede: sem sessão orgPolGet volta null antes de qualquer sbGet; o new_task passa pelo gancho', () => {
  const get = cut(pol, 'async function orgPolGet(', '\n}\n');
  assert.ok(get.indexOf('if(!orgSessOk()) return null;') < get.indexOf('sbGet('), 'sessão conferida antes da rede');
  assert.match(get, /orgPlanOf\(org, Date\.now\(\)\)!=='empresa'/);
  const hook = cut(iss, 'async function trkBeforeNewTask(payload){', '\n}\n');
  assert.ok(hook.indexOf('orgPolBeforeNewTask') < hook.indexOf('try{'), 'fora do try: a recusa da política sobe pra quem chamou');
  assert.match(pol, /payload\.orgPolicy=p;/);
});

test('a política mora na aba Meu time (seção, nunca modal), salva mesclando o jsonb e confirma com askYes', () => {
  assert.match(html, /<div id="agPolicy" class="agpol"><\/div>\s*<\/section>/);
  assert.match(html, /<script src="js\/62-curador\.js"><\/script>\s*<script src="js\/63-politica-org\.js"><\/script>/);
  assert.match(sw, /if\(typeof orgPolRender==='function'\) orgPolRender\(\);/);
  const r = cut(pol, 'async function orgPolRender(', '\n// ----');
  assert.ok(!/overlay|modal|confirm\(/i.test(r), 'sem modal nem confirm');
  assert.match(r, /await askYes\('Salvar a política/);
  assert.match(r, /Object\.assign\(\{\}, cur, \{ agentes:next \}\)/);
  assert.match(r, /orgIsAdmin\(\)/);
  assert.match(mt, /orgPolIssuesHtml\(roles\)/);
  assert.match(sw, /orgPolIssuesHtml\(roles\)/);
  for (const c of ['.agpol-r', '.agpol-f', '.agsmp-l', '.agorg-by']) assert.ok(css.includes(c), c);
});

// ---------------------------------------------------------------- P17
test('shareNames: e-mail, domínio, CNPJ/CPF e nome próprio no meio da frase; ignora início de frase, item, siglas e nomes de ferramenta', () => {
  const t = 'Sempre conferir o pedido da Padaria Pão Quente antes do deploy.\n- Mandar o relatório pra joana@cliente.com.br\nVer o site acme.com.br e o CNPJ 12.345.678/0001-90.\nRodar no GitHub e no Supabase com a Nyx.\n## Passo a passo\nUsar a API do Stripe';
  const n = P.shareNames(t, ['Nyx']);
  assert.ok(n.includes('joana@cliente.com.br'));
  assert.ok(n.includes('acme.com.br'));
  assert.ok(n.some((x) => /^CNPJ 12\.345\.678\/0001-90$/.test(x)));
  assert.ok(n.includes('Padaria Pão Quente'));
  assert.ok(!n.some((x) => /^(Sempre|Mandar|Ver|Rodar|Passo|Usar|GitHub|Supabase|Nyx|Stripe|API)$/.test(x)), JSON.stringify(n));
  assert.deepEqual(P.shareNames('Rodar os testes antes de aprovar.'), []);
  assert.ok(P.shareNames('x '.repeat(3) + 'Acme Beta Gama Delta Eps Zeta Eta Teta Iota Kapa Lambda'.split(' ').map((w) => 'com a ' + w).join(', ')).length <= 8);
});

test('canDecideLearning ≡ org_learning_can_decide (0031): admin decide; com "membros" qualquer outro; nunca quem compartilhou', () => {
  const adm = P.orgAgentPolicy({}), mem2 = P.orgAgentPolicy({ aprovaAprendizado: 'membros' });
  assert.equal(P.canDecideLearning(adm, 'admin', 'u1', 'u2'), true);
  assert.equal(P.canDecideLearning(adm, 'owner', 'u1', 'u2'), true);
  assert.equal(P.canDecideLearning(adm, 'member', 'u1', 'u2'), false);
  assert.equal(P.canDecideLearning(mem2, 'member', 'u1', 'u2'), true);
  assert.equal(P.canDecideLearning(mem2, 'admin', 'u1', 'u1'), false, 'ninguém aprova o próprio item');
  assert.equal(P.canDecideLearning(adm, 'admin', '', 'u2'), false);
  assert.equal(P.approverWords(adm), 'um admin da organização');
  assert.equal(P.approverWords(mem2), 'outra pessoa da organização');
});

test('compartilhar: filtro de segredo/injeção ANTES, aviso de nome no askYes, botão só com nuvem paga; trazer = fila "pra você decidir"', () => {
  const w = cut(pol, 'function orgTeamWire(', '\n// ----');
  assert.ok(w.indexOf("invoke('learn_check_text'") < w.indexOf('askYes('), 'o filtro roda antes da pergunta');
  assert.ok(w.indexOf('askYes(') < w.indexOf("sbPost('org_learnings'"), 'nada sobe sem o sim');
  assert.match(w, /pode ter nome de cliente ou dado de fora: '\+names\.join/);
  assert.match(w, /invoke\('learn_import',\{ repo, item \}\)/);
  assert.match(w, /id:'time-'\+r\.id/);
  assert.match(cut(pol, 'function orgShareBtn(', '\n}\n'), /if\(!orgCloudOk\(\)\) return '';/);
  assert.match(cut(pol, 'async function orgTeamLoad(', '\n}\n'), /if\(!orgCloudOk\(\)\)\{ ORGL\.id=agentId; ORGL\.rows=null; return; \}/);
  assert.match(mt, /orgShareBtn\(k, key\)/);
  assert.match(mt, /orgTeamLearnHtml\(a\)/);
  assert.ok(!/setInterval|setTimeout\(.*orgTeamLoad/.test(pol), 'sem polling');
});

test('migration 0031: RLS confere plano no insert, ninguém decide o próprio item, decisão carimbada no servidor; registrada na aba Banco', () => {
  const sql = readFileSync(root('supabase/migrations/0031_org_learnings.sql'), 'utf8');
  assert.match(sql, /create table if not exists org_learnings/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /with check \(shared_by = auth\.uid\(\) and status = 'pendente' and org_cloud_ok\(org_id\)/);
  assert.match(sql, /auth\.uid\(\) <> p_shared_by/);
  assert.match(sql, /new\.decided_by := auth\.uid\(\); new\.decided_at := now\(\);/);
  assert.match(sql, /'membros'/);
  assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
  assert.doesNotMatch(sql, /logcomex/i);
  const reg = readFileSync(root('supabase/functions/admin-api/migrations.ts'), 'utf8');
  const m = reg.match(/\{ name: "0031_org_learnings\.sql", sql: ("(?:[^"\\]|\\.)*") \}/);
  assert.ok(m, 'registrada'); assert.equal(JSON.parse(m[1]), sql, 'mesmo conteúdo do arquivo');
});

// ---------------------------------------------------------------- P15
let seq = 0;
const row = (o) => ({ agentId: 'nyx', taskId: 't' + (++seq), title: 'T' + seq, createdAt: seq, rounds: 1, muda: 0, usd: 0.2, papel: 'skills ativas: nenhuma · nyx@v3 · claude', ...o });

test('sampleCandidates: só tarefas que ESSE agente revisou, mais recentes primeiro, sem repetir, no máximo 8', () => {
  const rows = [row({ rounds: 0 }), row({ taskId: 'a', createdAt: 50, muda: 1 }), row({ taskId: 'a', createdAt: 50 }), row({ agentId: 'iris' }), ...Array.from({ length: 10 }, () => row())];
  const c = P.sampleCandidates(rows, 'nyx', 8);
  assert.equal(c.length, 8);
  assert.equal(c[0].taskId, 'a'); assert.equal(c[0].muda, true); assert.equal(c[0].v, 3);
  assert.ok(!c.some((x) => x.taskId === 't1'), 'sem rodada não é amostra');
  assert.equal(new Set(c.map((x) => x.taskId)).size, c.length);
  assert.deepEqual(P.sampleCandidates([], 'nyx'), []);
});

test('sampleEstimate: faixa por rodada (nunca um número só) + teto ≥ 2× a alta; sem histórico diz isso', () => {
  const e0 = P.sampleEstimate([], 'nyx');
  assert.equal(e0.n, 0); assert.match(e0.text, /sem histórico/); assert.ok(e0.cap >= 0.25);
  const e1 = P.sampleEstimate([row({ usd: 0.4, rounds: 2 })], 'nyx');
  assert.equal(e1.lo, 0.1); assert.equal(e1.hi, 0.3);
  const e = P.sampleEstimate([row({ usd: 0.12 }), row({ usd: 0.3 }), row({ usd: 0.5, rounds: 2 })], 'nyx');
  assert.equal(e.lo, 0.12); assert.equal(e.hi, 0.3); assert.equal(e.text, 'US$ 0,12–0,30');
  assert.ok(e.cap >= e.hi * 2);
});

test('amostra em palavra: "mesmo veredito" / "veredito mudou" — a palavra da Júlia nunca aparece', () => {
  assert.equal(P.sampleCompareText({ old: { kind: 'muda' }, now: { kind: 'aprova' } }), 'veredito mudou');
  assert.equal(P.sampleCompareText({ old: { kind: 'aprova' }, now: { kind: 'aprova' } }), 'mesmo veredito');
  assert.match(P.sampleCompareText({ old: { kind: null }, now: { kind: 'aprova' } }), /não havia veredito/);
  assert.equal(P.sampleVerdictText({ kind: 'muda', items: ['a', 'b'] }), 'muda (2)');
  assert.equal(P.sampleVerdictText({ kind: 'ilegivel' }), 'veredito ilegível');
  assert.ok(!/melhor/i.test(pol), 'nem "melhorou" nem "melhor" no módulo');
  const s = cut(pol, 'function sampleWire(', '\n}\n');
  assert.ok(s.indexOf('await askYes(') < s.indexOf("invoke('agent_sample_review'"), 'askYes com o preço antes de gastar');
  assert.match(s, /Custo estimado: '\+est\.text\+'\\nTeto: '\+polUsd\(est\.cap\)/);
  assert.match(s, /capUsd:est\.cap/);
  assert.match(cut(pol, 'function sampleSectionHtml(', '\n}\n'), /if\(a\.role!=='reviewer'\) return '';/);
});

// ---------------------------------------------------------------- persona sugerida
const M = new Function('agLineDiff', cut(mem, '// ---- aprendizados para revisar', '// @puro-fim') + '\nreturn { memLearnCard, memLearnSentence, memLearnLabel };')(
  (a, b) => [{ t: '-', s: a }, { t: '+', s: b }]);

test('persona sugerida: frase com o nome e o porquê; só "Guardar pra X", Editar e Descartar; diff em "ver detalhes"', () => {
  const it = { id: 'p1', kind: 'persona', taskId: 't', taskTitle: 'Agenda', agente: 'nyx', papel: 'reviewer', agenteNome: 'Nyx',
    persona: { texto: 'Você revisa e roda os testes.', porque: 'Aprovou sem rodar os testes', antes: 'Você revisa.' } };
  assert.equal(M.memLearnSentence(it), 'A Nyx vai mudar o jeito de trabalhar: aprovou sem rodar os testes.');
  assert.equal(M.memLearnLabel(it), 'persona nova');
  const h = M.memLearnCard(it, {});
  assert.match(h, /Guardar pra Nyx/);
  assert.ok(!/Só no projeto|data-lproj/.test(h), 'persona é do agente');
  assert.match(h, /<details class="memldet"><summary>ver detalhes<\/summary>[\s\S]*class="dr">- Você revisa\./);
  assert.match(M.memLearnCard(it, { editing: { a: '', b: 'novo texto' } }), /data-leditb rows="8">novo texto</);
  assert.match(mem, /edited=it\.kind==='persona'\?\{ texto:e\.b \}/);
  assert.match(mem, /invoke\('agent_revert',\{ agentId:r\.agente/);
});

test('Relatório do PR pelo app leva a política (golden relatorio.json com o caso novo)', () => {
  const c = new Function(cut(ciclo, '// @ciclo-relatorio-inicio', '// @ciclo-relatorio-fim') + '\nreturn cicloReport;')();
  const cases = gold('relatorio.json').cases;
  assert.ok(cases.some((k) => k.input.orgPolicy));
  for (const k of cases) assert.equal(c(k.input), k.expected);
  assert.match(ciclo, /orgPolicy:sp\.orgPolicy&&Array\.isArray\(sp\.orgPolicy\.rules\)/);
});
