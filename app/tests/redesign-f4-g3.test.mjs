// Redesenho F4 · G3 (Ajustes, conta, Uso, auth, Primeiros passos, estados globais) — spec-redesign-f4-todas-as-telas.md.
// Puro sempre que dá (trechos @…-puro de 67-ajustes, 52-erros, 06-carregamento, 00-util); o resto confere a fonte.
// Cobre: busca e filtro de Ajustes, rotas antigas (conta/env/cfg → Ajustes), e um teste por bug do inventário da área.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const root = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return src.slice(i, j); };
const aj = read('js/67-ajustes.js');
const A = new Function(cut(aj, '// @ajustes-puro-inicio', '// @ajustes-puro-fim') + '\nreturn { AJ_SECTIONS, AJ_GROUPS, ajSearch, ajRoute, ajSecId, ajScope, cfgValidate, ajBillingLine, ajInviteState, ajPolicyNext, ajPolicyVersion, ajPolicyDiff, ppSteps, ajRolePt, ajPlanPt };')();

// ---------------------------------------------------------------- Ajustes: estrutura, busca, filtro
test('Ajustes: 3 grupos (IA e modelos · Este computador · Conta e time); Navegador e Previsão viraram linhas de "Como as tarefas rodam"', () => {
  assert.deepEqual(A.AJ_GROUPS.map((g) => g[1]), ['IA e modelos', 'Este computador', 'Conta e time']);
  const ids = A.AJ_SECTIONS.map((s) => s.id);
  for (const id of ['motores', 'custo', 'modo', 'aparencia', 'aprendizado', 'github', 'verificacao', 'notificacoes', 'versao', 'disco', 'sistema', 'perfil', 'org', 'times', 'convites', 'regras', 'assinatura']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('navegador') && !ids.includes('previsao'), 'sem seção própria (dono aprovou o encurtamento)');
  assert.equal(A.ajSecId('navegador'), 'modo'); assert.equal(A.ajSecId('previsao'), 'modo');
  assert.equal(A.AJ_SECTIONS.filter((s) => s.grp === 'conta').length, 6);
});

test('busca: todas as palavras, sem acento e sem caixa; vazio = tudo; o que mudou de lugar aparece em "também em outro lugar"', () => {
  const all = A.ajSearch('');
  assert.equal(all.sections.length, A.AJ_SECTIONS.length); assert.deepEqual(all.elsewhere, []);
  assert.deepEqual(A.ajSearch('senha').sections, ['perfil']);
  assert.ok(A.ajSearch('NAVEGADOR').sections.includes('modo'), 'Navegador mora em Como as tarefas rodam');
  assert.ok(A.ajSearch('previsao').sections.includes('modo'), 'sem acento acha "Previsão"');
  assert.ok(A.ajSearch('gateway').sections.includes('motores'));
  assert.ok(A.ajSearch('ambiente').sections.includes('verificacao'), 'o nome antigo ainda acha');
  assert.deepEqual(A.ajSearch('teto maximo').sections, ['regras']);
  const iss = A.ajSearch('issues');
  assert.equal(iss.elsewhere[0].where, 'Issues › Conexão', 'endereço das issues mora em Issues › Conexão');
  assert.ok(A.ajSearch('limpar').elsewhere.some((e) => e.where === 'Projeto › Espaço em disco'));
  const none = A.ajSearch('xyzzy'); assert.deepEqual([none.sections.length, none.elsewhere.length], [0, 0]);
});

test('rotas antigas: "Conta e time" → Ajustes › Perfil; "Ambiente" → Ajustes › Verificação; cfg aceita seção (e apelido)', () => {
  assert.deepEqual(A.ajRoute('conta'), { kind: 'cfg', section: 'perfil' });
  assert.deepEqual(A.ajRoute('env'), { kind: 'cfg', section: 'verificacao' });
  assert.deepEqual(A.ajRoute('cfg', { section: 'suaia' }), { kind: 'cfg', section: 'motores' });
  assert.deepEqual(A.ajRoute('cfg'), { kind: 'cfg', section: null });
  assert.equal(A.ajRoute('issues'), null);
  assert.equal(A.ajSecId('qualquer-coisa'), 'motores');
  // o embrulho do openTab usa a rota (as chamadas por identificador também passam)
  const w = cut(aj, '(function ajWrapOpenTab(){', '})();');
  assert.match(w, /const r=ajRoute\(kind, opts\); if\(r\)\{ if\(r\.section\) AJ\.sec=r\.section; return orig\.call\(this, 'cfg', opts\); \}/);
  assert.match(w, /openTab=w;[\s\S]*window\.openTab=w;/);
  // as antigas portas de entrada delegam: openCloud/openEnv/suaIaOpenCfg/errDetails
  assert.match(read('js/40-nuvem-conta.js'), /function openCloud\(\)\{ if\(typeof ajustesOpen==='function'\) ajustesOpen/);
  assert.match(read('js/11-ambiente-updater.js'), /function openEnv\(\)\{ if\(typeof ajustesOpen==='function'\) ajustesOpen\('verificacao'\); \}/);
  assert.match(read('js/30-sua-ia.js'), /if\(typeof ajustesOpen==='function'\) ajustesOpen\('motores'\)/);
  assert.match(read('js/15-config-abas-onboarding.js'), /function openCfg\(\)\{ if\(typeof ajustesRender==='function'\) ajustesRender\(\); \}/);
  assert.ok(!/cfgValidate|OB_STEPS|function coachStart/.test(read('js/15-config-abas-onboarding.js').replace(/\/\/.*$/gm, '')), 'Configurações/tour saíram do 15');
});

test('selo de escopo troca a cada seção (computador · sua conta · organização <nome>)', () => {
  assert.deepEqual(A.ajScope('custo'), { scope: 'computador' });
  assert.deepEqual(A.ajScope('perfil'), { scope: 'conta' });
  assert.deepEqual(A.ajScope('regras', 'Logcomex'), { scope: 'org', scopeLabel: 'Logcomex' });
  assert.equal(A.ajRolePt('owner'), 'dono'); assert.equal(A.ajPlanPt('enterprise'), 'Enterprise');
});

test('autosave: validação no campo (era toast) e nada fecha a aba', () => {
  assert.equal(A.cfgValidate({ cap: '0', cost: '1', brl: '5', slots: '2', retry: '0' }).field, 'cfgCap');
  const custo = cut(aj, 'function ajRenderCusto(host){', 'function ajRenderModo(host){');
  assert.match(custo, /const bad=cfgValidate\(vals\(\)\);\s*if\(bad\)\{ const e=\$id\(bad\.field\+'Err'\)/);
  assert.match(custo, /ajSaved\(\)/);
  assert.ok(!/toast\(bad/.test(custo) && !/cfgHide\(\)/.test(aj), 'sem toast de validação e sem fechar a aba');
  assert.ok(!/addEventListener\('click',e=>\{ if\(e\.target\.id==='cfgOverlay'\) cfgHide/.test(read('js/15-config-abas-onboarding.js')), 'clique fora não fecha Ajustes');
});

// ---------------------------------------------------------------- bugs do inventário (área G3)
test('bug: "aplicar neste projeto" usava $id (getElementById) no lugar do helper byId', () => {
  const s = read('js/43-espaco-times.js');
  assert.match(s, /const la=byId\(local\.agents\), lw=byId\(local\.workflows\);/);
  assert.doesNotMatch(s, /\$id\(local\.(agents|workflows)\)/);
});

test('bug: "gerenciar" assinatura chamava payPortal(x) com x inexistente (ReferenceError)', () => {
  assert.doesNotMatch(read('js/41-assinatura-chaves.js') + aj, /payPortal\(x\)/);
  assert.match(aj, /bindClick\('sbBillPortal', \(\)=>payPortal\(\$id\('sbBillPortal'\)\)\)/);
});

test('bug: org enterprise sem paid_until aparecia como "Individual · mensal … renova em " vazio', () => {
  const L = A.ajBillingLine({ plan: 'enterprise', status: 'active', org: true }, 'u1');
  assert.equal(L.name, 'Enterprise'); assert.ok(L.org && L.active);
  assert.match(L.sub, /pago pela organização/);
  assert.doesNotMatch(L.name + L.sub, /Individual|renova em\s*$/);
  const t = A.ajBillingLine({ plan: 'team', status: 'trialing', interval: 'month', trial_end: '2026-11-01T00:00:00Z', user_id: 'u1' }, 'u1', () => '01/11/2026');
  assert.equal(t.name, 'Time'); assert.match(t.sub, /teste grátis até 01\/11\/2026 · você paga/);
  const r = A.ajBillingLine({ plan: 'individual', status: 'active', interval: 'year', current_period_end: 'x', user_id: 'u2' }, 'u1', () => '12/11/2026');
  assert.match(r.sub, /anual · renova em 12\/11\/2026 · pago por outra pessoa do time/);
  assert.equal(A.ajBillingLine(null, 'u1').active, false);
});

test('bug: convite numa org sem times mostrava um select vazio → estado guiado "crie um time antes"', () => {
  assert.equal(A.ajInviteState(true, []), 'noteams');
  assert.equal(A.ajInviteState(true, [{ id: 't' }]), 'form');
  assert.equal(A.ajInviteState(false, [{ id: 't' }]), 'none');
  assert.match(cut(aj, 'async function ajRenderConvites(host){', 'async function ajRenderRegras'), /Crie um time antes de convidar[\s\S]*criar o primeiro time/);
});

function gatewayHtml(secrets) {
  const s = read('js/41-assinatura-chaves.js');
  const ctx = { SB: { sess: () => ({}) }, secretsCache: secrets, esc: (x) => String(x), escA: (x) => String(x), IC: { warn: '<svg class="icwarn"></svg>' } };
  vm.createContext(ctx);
  vm.runInContext(cut(s, 'const RA_MODELS=', '// ponto de entrada chamado pelo openCfg') + '\nglobalThis.__h=routeAiCfgHtml;', ctx);
  return ctx.__h();
}
test('bug: faixa do modo teste do gateway mostrava "${IC.warn}" literal', () => {
  const h = gatewayHtml([{ name: 'ALT_AI_KEY', value: 'sk-abcd' }, { name: 'ALT_AI_ALWAYS', value: '1' }]);
  assert.ok(!h.includes('${IC.warn}'), 'sem template cru');
  assert.match(h, /<svg class="icwarn"><\/svg> Modo teste ligado/);
  assert.doesNotMatch(gatewayHtml([{ name: 'ALT_AI_KEY', value: 'sk-abcd' }]), /Modo teste ligado/);
  assert.match(h, /Endereço/); assert.doesNotMatch(h, /Route AI|Fallback automático|OpenAI-compatible|\(custom\)/, 'rótulos em português');
});

test('bug: "trocar" a chave do gateway apagava a chave sem perguntar — agora folha, e só substitui ao salvar; remover pergunta à parte', () => {
  const w = cut(read('js/41-assinatura-chaves.js'), 'function wireRouteAiCfg(root){', '\nsetTimeout(secretsSync');
  const edit = cut(w, "const b=$('raKeyEdit');", "const b=$('raKeyDel');");
  assert.doesNotMatch(edit, /secretDel/, 'trocar não apaga');
  assert.match(edit, /sheetAsk\(\{ anchor:b, title:'Trocar a chave do gateway'/);
  assert.match(edit, /await save\('ALT_AI_KEY', String\(v\)\.trim\(\)\)/);
  const del = cut(w, "const b=$('raKeyDel');", '{ const b=$(\'raModel\')');
  assert.match(del, /Remover a chave do gateway\?[\s\S]*danger:true[\s\S]*if\(!ok\) return; await secretDel\(name\)/);
});

test('bug: link do e-mail ia pro domínio antigo (constellation-ai-v1.lovable.app) → starfork.com.br', () => {
  const onb = read('js/44-onboarding.js');
  assert.match(onb, /const AU_SITE='https:\/\/starfork\.com\.br';/);
  assert.doesNotMatch(onb.replace(/\/\/.*$/gm, ''), /lovable/);
  const sh = root('scripts/supabase-auth-mail.sh');
  assert.match(sh, /"site_url": "https:\/\/starfork\.com\.br"/);
  assert.match(sh, /"uri_allow_list": allow,/);
  assert.match(sh, /have=\[x\.strip\(\) for x in str\(now\.get\("uri_allow_list"\)/, 'mescla com a lista atual (nada some)');
  assert.match(sh, /want=\["https:\/\/starfork\.com\.br\/\*\*"/);
});

test('bug: id "permission" duplicado no catálogo de erros — um id só, e o lock sem permissão continua em "permission"', () => {
  const util = read('js/00-util.js');
  const ctx = { window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, navigator: { platform: 'MacIntel', userAgent: '' }, console };
  vm.createContext(ctx); vm.runInContext(util + '\nglobalThis.__c=ERR_CATALOG;', ctx);
  const ids = ctx.__c.map((c) => c.id);
  assert.equal(JSON.stringify(ids.filter((x, i) => ids.indexOf(x) !== i)), '[]', 'ids únicos');
  assert.equal(ctx.humanErr(new Error("fatal: Unable to create '/r/.git/index.lock': Permission denied")).id, 'permission');
  assert.equal(ctx.humanErr(new Error("fatal: Unable to create '/r/.git/index.lock': File exists")).id, 'git-lock');
  // catálogo aponta pros lugares novos (não "Mais › Ambiente"); gateway vai pra IA e modelos
  assert.doesNotMatch(util, /Mais › Ambiente|label:'abrir Ambiente'|Configurações → (Sua IA|Gateway)/);
  assert.equal(ctx.humanErr(new Error('O gateway recusou a chave')).action.label, 'abrir IA e modelos');
});

// ---------------------------------------------------------------- Regras da organização com versão
test('Regras da organização: cada salvar vira uma versão (histórico no próprio orgs.policy, até 20); diferença conta as mudanças', () => {
  const v1 = A.ajPolicyNext({}, { minRequirements: 2 }, 'u1', 100);
  assert.equal(v1.version, 1); assert.deepEqual(v1.history, []);
  const v2 = A.ajPolicyNext(v1, { costWarn: 30 }, 'u2', 200);
  assert.equal(v2.version, 2); assert.equal(v2.minRequirements, 2, 'mescla o que já existia'); assert.equal(v2.costWarn, 30);
  assert.equal(v2.history.length, 1); assert.equal(v2.history[0].version, 1); assert.equal(v2.history[0].savedBy, 'u1');
  assert.ok(!('history' in v2.history[0]), 'histórico não aninha');
  let p = v2; for (let i = 0; i < 30; i++) p = A.ajPolicyNext(p, { costWarn: i }, 'u', i);
  assert.ok(p.history.length <= 20); assert.equal(p.version, 32);
  // política antiga (sem versão) vira a v1 do histórico ao salvar
  const old = A.ajPolicyNext({ agentes: { portao: true } }, { minRequirements: 3 }, 'u', 1);
  assert.equal(old.version, 2); assert.equal(old.history[0].agentes.portao, true);
  assert.equal(A.ajPolicyDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 1 }), 2);
  assert.equal(A.ajPolicyVersion({}), 1);
});

// ---------------------------------------------------------------- Primeiros passos
test('Primeiros passos: computador → IA → projeto → 1ª demanda → convite (opcional); cada passo se marca sozinho', () => {
  const P0 = A.ppSteps({});
  assert.deepEqual(P0.steps.map((s) => s.id), ['pc', 'ia', 'proj', 'dem'], 'fora de uma organização o convite nem aparece');
  assert.equal(P0.done, 0); assert.equal(P0.total, 4); assert.equal(P0.next, 'pc');
  // o convite (opcional) só aparece numa organização e NUNCA entra no progresso
  const Po = A.ppSteps({ inOrg: true, invited: true });
  assert.deepEqual(Po.steps.map((s) => s.id), ['pc', 'ia', 'proj', 'dem', 'conv']);
  assert.equal(Po.total, 4); assert.equal(Po.done, 0, 'convidar não conta como feito');
  assert.equal(A.ppSteps({ envOk: true, iaReady: true, hasRepo: true, tasks: 1, inOrg: true }).done, 4);
  const P1 = A.ppSteps({ envOk: true, iaReady: true, hasRepo: false, tasks: 0 });
  assert.equal(P1.done, 2); assert.equal(P1.next, 'proj');
  const P2 = A.ppSteps({ envOk: true, iaReady: true, hasRepo: true, tasks: 3 });
  assert.equal(P2.next, null, 'convite é opcional: nada obrigatório pendente');
  // substitui o tour modal e as coach marks: abre como aba uma vez e "dispensar" fica no ⋯
  assert.match(aj, /window\.obMaybeStart=ppMaybeStart;/);
  assert.match(aj, /label:'dispensar'/);
  assert.match(aj, /\['newTaskBtn','Tudo começa em Nova demanda'/);
  assert.match(aj, /contorno = aguardando você · amarelo = pronta pra revisar/, 'corrige "amarelo = aguardando"');
  assert.match(read('js/44-onboarding.js'), /<h2 class="au-h2">Conta pronta<\/h2>[\s\S]*primeirosPassosOpen\(\)/, '"Pronto" leva a Primeiros passos');
  assert.doesNotMatch(read('js/44-onboarding.js').replace(/\/\/.*$/gm, ''), /estrela acende|mesma órbita|Estrela acesa/, 'sem metáfora espacial');
});

// ---------------------------------------------------------------- estados globais
test('folha ancorada: abaixo do botão se couber, senão acima; nunca sai da tela; askYes/askText usam a folha', () => {
  const e = read('js/52-erros.js');
  const F = new Function(cut(e, '// @folha-puro-inicio', '// @folha-puro-fim') + '\nreturn sheetPlace;')();
  const below = F({ top: 100, bottom: 130, left: 200, width: 80 }, 400, 160, 1280, 800);
  assert.equal(below.up, false); assert.equal(below.top, 138);
  const above = F({ top: 700, bottom: 730, left: 1250, width: 20 }, 400, 160, 1280, 800);
  assert.equal(above.up, true); assert.equal(above.top, 700 - 8 - 160);
  assert.ok(above.left + 400 <= 1272, 'cabe na largura');
  assert.match(read('js/00-util.js'), /if\(typeof sheetAsk==='function'\)\{ const t=String\(message\)\.split/);
  assert.match(read('js/11-ambiente-updater.js'), /if\(typeof sheetAsk==='function'\) return sheetAsk\(\{ title, field:/);
});

test('erro: diz o que fazer (passos), "ver detalhes" inline com copiar e abrir em aba (nunca modal)', () => {
  const ld = read('js/06-carregamento.js');
  const humanErr = (e) => ({ id: /fetch/.test(String(e.message)) ? 'network' : 'generic', msg: /fetch/.test(String(e.message)) ? 'Sem conexão agora' : 'Algo deu errado: ' + e.message, raw: e.message, action: null });
  const L = new Function('esc', 'humanErr', 'IC', cut(ld, '// @puro-inicio', '// @puro-fim') + '\nreturn { errorHtml, ldStateHtml };')((s) => String(s).replace(/</g, '&lt;'), humanErr, {});
  const h = L.errorHtml(new Error('Failed to fetch\nstack linha 2'));
  assert.match(h, /<span>O que fazer<\/span><ol><li>Confira a internet ou a VPN\.<\/li><li>Tente de novo\.<\/li><\/ol>/);
  assert.match(h, /<details class="ld-det"><summary>ver detalhes<\/summary><pre class="ld-pre">Failed to fetch\nstack linha 2<\/pre>/);
  assert.match(h, /<button type="button" class="btn sm quiet" data-ldcopy>copiar<\/button><button type="button" class="btn sm quiet" data-ldtab>abrir em aba<\/button>/);
  for (const k of ['semprojeto', 'semconta', 'semorg', 'semperm']) assert.match(L.ldStateHtml(k, 'x'), /ld-empty/);
  assert.match(read('js/00-util.js'), /function errDetails\(h\)\{\n  if\(typeof errTabOpen==='function'\)\{ errTabOpen\(h\); return; \}/);
  assert.match(aj, /VIEW_OVERLAY\.errtab='errTabOverlay'/);
});

test('teto atingido = "Aviso do Starfork" (não pergunta de agente fictício): parar ou liberar com motivo', () => {
  const t = read('js/53-teto-protecao.js');
  assert.match(t, /agent:'Aviso do Starfork', kind:'budget', notice:true/);
  const n = cut(t, 'function budgetNoticeHtml(t){', 'function budgetNoticeWire(root){');
  assert.match(n, /<b>Aviso do Starfork<\/b><span class="dim">· não é pergunta de agente<\/span>/);
  assert.match(n, /data-bn="stop">\$\{BUDGET_STOP_TXT\}/); assert.match(n, /placeholder="motivo \(vai pro PR\)"/);
  assert.match(cut(t, 'function budgetNoticeWire(root){', '// teto escolhido'), /if\(!why\)\{ err\('Escreva o motivo — ele vai pro PR\.'\)/);
});

test('Verificação não abre mais sozinha no boot: faixa na Central + selo na sub-navegação', () => {
  const amb = read('js/11-ambiente-updater.js');
  assert.doesNotMatch(amb, /window\.openTab\('env'\)/);
  assert.match(amb, /setTimeout\(\(\)=>\{ runEnvCheck\(\)\.catch\(\(\)=>\{\}\); \}, 2500\);/);
  assert.match(amb, /if\(typeof ajEnvBand==='function'\) try\{ ajEnvBand\(\); \}catch\(_\)\{ \}/, 'a faixa sai de dentro da checagem (uma vez)');
  assert.match(aj, /function ajEnvBand\(\)\{[\s\S]*pendência[\s\S]*resolver/);
  assert.match(aj, /if\(id==='verificacao' && typeof envChecks!=='undefined'/, 'selo na sub-nav');
});

test('chaves de modelo: só em Ajustes › IA e modelos (Conta e Issues não têm mais), mesmo cofre (user_secrets)', () => {
  const k = read('js/41-assinatura-chaves.js');
  assert.doesNotMatch(k, /function secretsRenderCloud|sbSecretAdd|sbSecretDs/);
  assert.match(k, /async function secretSet\(name, value\)\{\n  await sbFetch\('\/rest\/v1\/user_secrets\?on_conflict=user_id,name'/, 'armazenamento igual (compatível)');
  assert.match(aj, /<b>Outras chaves da conta<\/b>/);
  assert.match(aj, /\{ id:'gemini'[\s\S]*\{ id:'opencode'/, 'Gemini e OpenCode têm cartão');
  assert.match(aj, /invoke\('term_ai_bins'\)/, 'estado real pelo mesmo resolvedor do terminal');
  assert.doesNotMatch(aj, /ainda não existe no app|a confirmar|Seletor de IA único<\/h3>/, 'sem conteúdo de mock em produção');
  assert.match(read('../src-tauri/src/lib.rs'), /fn term_ai_bins\(\) -> serde_json::Value \{[\s\S]*bin_resolve::resolve_cached\(n,/);
});

test('index.html: carrega 67-ajustes.js depois da Central e o 99-ajustes.css; o modal "Padrões de demanda" saiu', () => {
  const html = read('index.html');
  assert.match(html, /<script src="js\/66-central-tabela\.js"><\/script>\s*<script src="js\/67-ajustes\.js"><\/script>/);
  assert.match(html, /css\/99-ajustes\.css/);
  assert.doesNotMatch(html, /id="orgTplOverlay"/);
});

// ---------------------------------------------------------------- Uso: filtro por IA e US$ ≈ R$
test('Uso: filtro por IA vai pro Rust (usage_report engine) e o total do cabeçalho é "US$ X (≈ R$ Y)"', async () => {
  const calls = [], body = { innerHTML: '', addEventListener() {} };
  const ctx = { window: { addEventListener() {} }, navigator: { platform: 'MacIntel', userAgent: '' }, console, Date,
    document: { getElementById: (id) => (id === 'usoBody' ? body : null), addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    esc: (s) => String(s), escA: (s) => String(s), invokeQuiet: (c, a) => { calls.push([c, a]); return Promise.resolve(null); } };
  vm.createContext(ctx);
  vm.runInContext(read('js/00-util.js') + '\n' + read('js/55-uso.js'), ctx);
  vm.runInContext("USO.engine='codex'", ctx);
  await vm.runInContext('usoLoad()', ctx);
  assert.equal(calls[0][1].engine, 'codex');
  const h = ctx.usoHtml({ totals: { usd: 2, calls: 3 }, bySource: [{ source: 'fabrica', usd: 1, calls: 1 }], byEngine: [], byProject: [], tasks: [] }, { period: '30d', engine: 'codex' });
  assert.match(h, /· <b>US\$ 2 \(≈ R\$ 11,00\)<\/b> em 30 dias/);
  assert.match(h, /<option value="codex" selected>Codex<\/option>/);
  assert.match(h, /Fábrica · varreduras/);
  assert.match(read('../src-tauri/src/usage_ledger.rs'), /pub\(crate\) fn usage_report\(period: String, project: Option<String>, since: Option<i64>, engine: Option<String>\)/);
});

// ---------------------------------------------------------------- correções da revisão
test('teto: a pendência do aviso leva createdAt (o comentário engolia o campo)', () => {
  const t = read('js/53-teto-protecao.js');
  const ctx = { BUDGET_STOP_TXT: 'Parar aqui', budgetPrompt: () => 'p', budgetPendId: () => -1 };
  const f = new Function('ctx', 'with(ctx){ ' + cut(t, 'function budgetInject(snap){', '\nconst budgetBusy') + '\n return budgetInject; }')(ctx);
  const snap = { tasks: [{ id: 't1', status: 'paused', spec: { budgetHit: { at: 1234, usd: 4, cap: 5 } } }] };
  f(snap);
  assert.equal(snap.pending[0].createdAt, 1234);
  assert.equal(snap.pending[0].agent, 'Aviso do Starfork');
  assert.match(cut(t, 'function budgetNoticeWire(root){', '// teto escolhido'), /if\(!\(usd>0\)\)\{ err\('Escreva quanto liberar/);
  assert.match(t, /function budgetOrgMax\(t\)/); assert.match(cut(t, 'async function budgetRelease(', '\n}\n'), /const max=budgetOrgMax\(t\);/);
});

// folha: DOM falso mínimo (só o que sheetOpen usa)
function sheetEnv() {
  const listeners = { mousedown: [], keydown: [] }, made = [];
  const mkKid = (tag, attrs) => { const k = { tag, value: '', dataset: {}, disabled: false, onclick: null, attrs,
    getAttribute: (a) => (attrs.includes(a + '="true"') ? 'true' : null), matches: (sel) => attrs.includes(sel.replace(/[\[\]]/g, '')),
    focus() { doc.activeElement = k; }, closest(sel) { return sel === '[data-sh-i]' && 'shI' in k.dataset ? k : null }, classList: { toggle() {} }, setAttribute() {} };
    const m = attrs.match(/data-sh-i="(\d+)"/); if (m) k.dataset.shI = m[1]; return k; };
  const mkEl = () => { const kids = []; const el = { kids, style: { setProperty() {} }, classList: { add() {} }, setAttribute() {}, offsetWidth: 380, offsetHeight: 160, removed: false,
    remove() { el.removed = true; }, contains: (x) => x === el || kids.includes(x),
    set innerHTML(h) { for (const m of h.matchAll(/<(button|input)([^>]*)>/g)) if (/data-sh-/.test(m[2])) kids.push(mkKid(m[1], m[2])); },
    querySelector: (sel) => kids.find((k) => k.attrs.includes(sel.replace(/[\[\]]/g, ''))) || null,
    querySelectorAll: (sel) => kids.filter((k) => sel.split(',').some((x) => k.attrs.includes(x.replace(/[\[\]]/g, '').replace(/:not.*/, '')) || x.startsWith(k.tag))) };
    made.push(el); return el; };
  const doc = { activeElement: null, body: { appendChild() {} }, createElement: mkEl,
    addEventListener: (t, f) => listeners[t].push(f), removeEventListener: (t, f) => { listeners[t] = listeners[t].filter((x) => x !== f); } };
  const e = read('js/52-erros.js');
  const S = new Function('document', 'window', cut(e, '// @folha-puro-inicio', 'window.sheetAsk=sheetAsk;') + '\nreturn { sheetAsk, sheetCancelValue, sheetPlace };')(doc, { innerWidth: 1280, innerHeight: 800 });
  const key = (k, target) => listeners.keydown.slice().forEach((f) => f({ key: k, target: target || made[made.length - 1].kids[0], preventDefault() {}, stopPropagation() {} }));
  return { S, made, listeners, key, doc };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
test('folha (askYes): ok → true; cancelar/Esc/clique fora → false; campo cancelado → null; a 2ª espera a 1ª (não cancela a pendente)', async () => {
  const E = sheetEnv();
  assert.equal(E.S.sheetCancelValue({}), false); assert.equal(E.S.sheetCancelValue({ field: {} }), null); assert.equal(E.S.sheetCancelValue({ choices: [] }), null);
  let p = E.S.sheetAsk({ title: 'a' }); await tick();
  E.made.at(-1).querySelector('[data-sh-ok]').onclick(); assert.equal(await p, true);
  p = E.S.sheetAsk({ title: 'b' }); await tick(); E.made.at(-1).querySelector('[data-sh-no]').onclick(); assert.equal(await p, false);
  p = E.S.sheetAsk({ title: 'c' }); await tick(); E.key('Escape'); assert.equal(await p, false);
  p = E.S.sheetAsk({ title: 'd' }); await tick(); E.listeners.mousedown.slice().forEach((f) => f({ target: {} })); assert.equal(await p, false);
  p = E.S.sheetAsk({ title: 'e', field: {} }); await tick(); E.key('Escape'); assert.equal(await p, null, 'campo cancelado = null');
  assert.equal(E.listeners.keydown.length + E.listeners.mousedown.length, 0, 'sem ouvinte pendurado');
  // fila: a 1ª (confirmação) continua aberta quando a 2ª (campo) é pedida
  const p1 = E.S.sheetAsk({ title: 'primeira' }); const p2 = E.S.sheetAsk({ title: 'segunda', field: {} }); await tick();
  const n = E.made.length; assert.ok(!E.made.at(-1).removed);
  E.made.at(-1).querySelector('[data-sh-ok]').onclick(); assert.equal(await p1, true, 'a 1ª não foi cancelada');
  await tick(); assert.equal(E.made.length, n + 1, 'a 2ª só abriu depois');
  E.key('Escape'); assert.equal(await p2, null, 'cancelar da 2ª usa o tipo DELA (campo → null)');
  // Enter numa opção focada escolhe ESSA opção
  const p3 = E.S.sheetAsk({ title: 'f', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }); await tick();
  const optB = E.made.at(-1).kids.find((k) => k.dataset.shI === '1'); E.key('Enter', optB); assert.equal(await p3, 'b');
  // topo nunca sai da tela
  assert.ok(E.S.sheetPlace({ top: 5, bottom: 10, left: 10, width: 10 }, 380, 900, 1280, 800).top >= 8);
});

test('Regras da organização: salvar = versão N+1 com histórico, a partir da política RELIDA; erro transitório nunca tira o histórico', () => {
  const pol = read('js/63-politica-org.js');
  const R = new Function(cut(aj, '// @ajustes-puro-inicio', '// @ajustes-puro-fim') + cut(pol, '// @politica-puro-inicio', '// @politica-puro-fim') + cut(pol, '// @regras-puro-inicio', '// @regras-puro-fim') + '\nreturn { orgRulesSaveBody, orgRulesFlat, orgRulesHistFatal };')();
  const fresh = { minRequirements: 2, costWarn: 10, version: 3, savedAt: 1, savedBy: 'u0', history: [{ version: 2 }, { version: 1 }], extra: 'de outra pessoa' };
  const draft = Object.assign(R.orgRulesFlat(fresh, ''), { minRequirements: 4, tpl: '## guia' });
  const b = R.orgRulesSaveBody(fresh, draft, 'u1', 99, true);
  assert.equal(b.policy.version, 4); assert.equal(b.policy.history.length, 3); assert.equal(b.policy.history.at(-1).version, 3);
  assert.equal(b.policy.minRequirements, 4); assert.equal(b.policy.extra, 'de outra pessoa', 'mescla o que outra pessoa salvou'); assert.equal(b.spec_template, '## guia');
  const plain = R.orgRulesSaveBody(fresh, draft, 'u1', 99, false);
  assert.equal(plain.policy.history.length, 2, 'sem versão nova, mas o histórico fica intacto'); assert.equal(plain.policy.version, 3);
  assert.equal(R.orgRulesHistFatal(new Error('Failed to fetch')), false); assert.equal(R.orgRulesHistFatal(new Error('value too long for type')), true);
  const save = cut(pol, "bindClick('orgrSave'", '\n  sync();\n}');
  assert.match(save, /const rows=await sbGet\('orgs\?select=policy&id=eq\.'\+org\.id\)/, 'relê antes de gravar');
  assert.match(save, /catch\(e\)\{ if\(!orgRulesHistFatal\(e\)\) throw e;/, 'transitório: erro + rascunho fica');
  assert.match(pol, /canEdit=d\.meRole==='owner'\|\|d\.meRole==='admin'/);
  assert.match(pol, /orgPlanOf\(org, Date\.now\(\)\)!=='empresa'/, 'portão do plano Enterprise');
  assert.match(pol, /AJ\.sec!=='regras'\) return;/); assert.match(pol, /falha NÃO vira cache/);
  assert.match(pol, /sb\.disabled=ORGR\.bad\|\|ORGR\.saving/, 'teto inválido desliga o salvar');
});

test('chaves: "Outras chaves" esconde as dos motores; "trocar" nunca apaga antes de salvar; remover do gateway apaga a chave EM USO (LGCX_API_KEY)', () => {
  const rows = new Function('secretsCache', cut(aj, 'function ajSecretsRows(){', '\nfunction ajTermLoad') + '\nreturn ajSecretsRows();')([{ name: 'LGCX_API_KEY', value: 'x' }, { name: 'ALT_AI_KEY', value: 'y' }, { name: 'DEEPSEEK_API_KEY', value: 'z' }, { name: 'OPENAI_API_KEY', value: 'w' }]);
  assert.deepEqual(rows.map((r) => r.name), ['LGCX_API_KEY']);
  const edit = cut(aj, "host.querySelectorAll('[data-ajkedit]')", "host.querySelectorAll('[data-ajkdel]')");
  assert.doesNotMatch(edit, /secretDel/); assert.match(edit, /await secretSet\(b\.dataset\.ajkedit, v\)/);
  const k = read('js/41-assinatura-chaves.js');
  const name = new Function('secretsCache', cut(k, 'function raGet(n){', '\nfunction routeAiCfgHtml') + '\nreturn raKeyName();');
  assert.equal(name([{ name: 'LGCX_API_KEY', value: 'k' }]), 'LGCX_API_KEY');
  assert.equal(name([{ name: 'LGCX_API_KEY', value: 'k' }, { name: 'ALT_AI_KEY', value: 'a' }]), 'ALT_AI_KEY');
  assert.match(cut(k, "const b=$('raKeyDel');", "{ const b=$('raModel')"), /await secretDel\(name\)/);
});

test('planos: sem a linha do plano o total é null (nunca R$ 0) e o botão fica desligado', () => {
  const onb = read('js/44-onboarding.js');
  const F = new Function('au', 'billingPlans', cut(onb, 'function auPlanRow(key, interval){', '// TESTE GRÁTIS') + '\nreturn auTotal();');
  assert.equal(F({ plan: { key: 'team', interval: 'month', seats: 5 } }, []), null);
  assert.equal(F({ plan: { key: 'team', interval: 'month', seats: 5 } }, [{ plan: 'team', interval: 'month', amount_cents: 3900, per_seat: true }]), 19500);
  assert.match(onb, /id="auGo"\$\{hasPlans&&total!=null\?'':' disabled'\}/);
  assert.match(onb, /<button type="button" class="au-link" id="auPlansRetry">/);
});
