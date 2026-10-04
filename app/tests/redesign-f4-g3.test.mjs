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
  assert.match(del, /Remover a chave do gateway\?[\s\S]*danger:true[\s\S]*if\(!ok\) return; await secretDel\('ALT_AI_KEY'\)/);
});

test('bug: link do e-mail ia pro domínio antigo (constellation-ai-v1.lovable.app) → starfork.com.br', () => {
  const onb = read('js/44-onboarding.js');
  assert.match(onb, /const AU_SITE='https:\/\/starfork\.com\.br';/);
  assert.doesNotMatch(onb.replace(/\/\/.*$/gm, ''), /lovable/);
  const sh = root('scripts/supabase-auth-mail.sh');
  assert.match(sh, /"site_url": "https:\/\/starfork\.com\.br"/);
  assert.match(sh, /"uri_allow_list": "https:\/\/starfork\.com\.br\/\*\*/);
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
  assert.deepEqual(P0.steps.map((s) => s.id), ['pc', 'ia', 'proj', 'dem', 'conv']);
  assert.equal(P0.done, 0); assert.equal(P0.next, 'pc');
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
  assert.match(h, /data-ldcopy[^>]*>copiar<\/span> · <span data-ldtab[^>]*>abrir em aba/);
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
  assert.match(amb, /setTimeout\(async\(\)=>\{ await runEnvCheck\(\); if\(typeof ajEnvBand==='function'\) ajEnvBand\(\); \}, 2500\);/);
  assert.match(aj, /function ajEnvBand\(\)\{[\s\S]*pendência[\s\S]*resolver/);
  assert.match(aj, /if\(id==='verificacao' && typeof envChecks!=='undefined'/, 'selo na sub-nav');
});

test('chaves de modelo: só em Ajustes › IA e modelos (Conta e Issues não têm mais), mesmo cofre (user_secrets)', () => {
  const k = read('js/41-assinatura-chaves.js');
  assert.doesNotMatch(k, /function secretsRenderCloud|sbSecretAdd|sbSecretDs/);
  assert.match(k, /async function secretSet\(name, value\)\{\n  await sbFetch\('\/rest\/v1\/user_secrets\?on_conflict=user_id,name'/, 'armazenamento igual (compatível)');
  assert.match(aj, /<b>Outras chaves da conta<\/b>/);
  assert.match(aj, /\{ id:'gemini'[\s\S]*\{ id:'opencode'/, 'Gemini e opencode aparecem como novos');
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
  assert.match(h, /Fábrica de apps e features/);
  assert.match(read('../src-tauri/src/usage_ledger.rs'), /pub\(crate\) fn usage_report\(period: String, project: Option<String>, since: Option<i64>, engine: Option<String>\)/);
});
