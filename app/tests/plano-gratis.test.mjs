// PLANO GRÁTIS — onda F1 (decisão do dono, party-preco seções 9–13): o Grátis é 100% local, abre sem login e sem rede;
// a nuvem é do Pro/Empresa. Regras puras (espaço, migração do localStorage, canal do updater, chaves do Grátis, planos) +
// os ganchos no código (gate de login, ticks da nuvem, CTAs fora do plano/prova/portão).
// `node --test app/tests/plano-gratis.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const espaco = read('js/39-espaco.js'), planos = read('js/82-planos.js'), chaves = read('js/41-assinatura-chaves.js');
const onb = read('js/44-onboarding.js'), nuvem = read('js/40-nuvem-conta.js'), escopo = read('js/40-conta-escopo.js');
const sync = read('js/42-nuvem-sync-mobile.js'), upd = read('js/11-ambiente-updater.js'), html = read('index.html');
const E = new Function(cut(espaco, '// @puro-espaco-inicio', '// @puro-espaco-fim') + '\nreturn { espacoNuvem, espacoMigPlan, updCanal, updPubParse, UPD_PUB_BASE, UPD_PUB_ZIP };')();
const K = new Function(cut(chaves, '// @puro-chaves-dono-inicio', '// @puro-chaves-dono-fim') + '\nreturn { secretsLocalPlan, secretsLocalPairs };')();
const P = new Function(cut(planos, '// @puro-planos-inicio', '// @puro-planos-fim') + '\nreturn { PLANOS, PLANOS_RODAPE, UPGRADE, upgradeInfo, planosAssinarAcao };')();

// o 39-espaco inteiro num vm, com SB/billingActive/localStorage falsos — cloudAllowed/isLocalSpace de verdade
function loadEspaco({ sess = null, configured = true, billing = () => true, store = {} } = {}) {
  const events = [];
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const ctx = {
    localStorage: new Proxy(ls, { ownKeys: () => Object.keys(store), getOwnPropertyDescriptor: (_t, k) => (k in store ? { enumerable: true, configurable: true, value: store[k] } : undefined) }),
    window: { dispatchEvent: (e) => events.push(e.detail) }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o.detail; } },
    SB: { configured: () => configured, sess: () => sess }, billingActive: () => billing(),
  };
  vm.createContext(ctx);
  vm.runInContext(espaco, ctx);
  return { ctx, events, store, set: (o) => Object.assign(ctx, o) };
}

test('cloudAllowed/isLocalSpace: sessão × cobrança (cobrança desligada = todo logado segue com nuvem)', () => {
  assert.equal(E.espacoNuvem(true, true, true), true);
  assert.equal(E.espacoNuvem(true, false, true), false, 'sem conta = Grátis local');
  assert.equal(E.espacoNuvem(true, true, false), false, 'logado sem plano com cobrança ligada = Grátis');
  assert.equal(E.espacoNuvem(false, true, true), false, 'sem servidor configurado');
  // runtime, com o billingActive() de verdade (41): !billingOn || org || trialing/active
  const billingActive = (on, my) => !on || !!(my && (my.org || ['trialing', 'active'].includes(my.status)));
  const cases = [
    ['sem sessão, cobrança desligada', null, false, null, false],
    ['logado, cobrança desligada (time Enterprise hoje)', { user: { id: 'u' } }, false, null, true],
    ['logado, cobrança ligada, sem plano', { user: { id: 'u' } }, true, null, false],
    ['logado, cobrança ligada, licença da org', { user: { id: 'u' } }, true, { org: true, status: 'active' }, true],
    ['logado, cobrança ligada, em teste', { user: { id: 'u' } }, true, { status: 'trialing' }, true],
    ['logado, cobrança ligada, cancelado', { user: { id: 'u' } }, true, { status: 'canceled' }, false],
  ];
  for (const [nome, sess, on, my, nuvemEsperada] of cases) {
    const X = loadEspaco({ sess, billing: () => billingActive(on, my) });
    assert.equal(X.ctx.cloudAllowed(), nuvemEsperada, nome);
    assert.equal(X.ctx.isLocalSpace(), !nuvemEsperada, nome);
  }
});

test('sf:espaco-mudou: dispara só quando o espaço muda (a 1ª leitura do boot não conta)', () => {
  let s = null; const X = loadEspaco({ billing: () => true });
  X.set({ SB: { configured: () => true, sess: () => s } });
  X.ctx.espacoSync(); assert.equal(X.events.length, 0, 'boot');
  X.ctx.espacoSync(); assert.equal(X.events.length, 0, 'nada mudou');
  s = { user: { id: 'u' } }; X.ctx.espacoSync();
  assert.deepEqual(JSON.parse(JSON.stringify(X.events)), [{ espaco: 'nuvem', antes: 'local' }], 'entrou');
  s = null; X.ctx.espacoSync(); assert.equal(X.events[1].espaco, 'local', 'saiu');
});

test('migração do localStorage no 1º login: base:- → base:<uid> só pra destino vazio, sem cursores da nuvem, idempotente', () => {
  const store = { 'ca:tab:-': 'minhas', 'per:central:-': '7d', 'kb:central:-': '{"x":1}', 'ca:f:-': 'a', 'ca:f:u1': 'já-tinha',
    'sb:tmap:-': '{}', 'sb:team:-': 't', 'ep:mirrored:-': '[]', 'ep:ownWarn:-': '1', 'onboarded': '1', 'x:-:y': 'z' };
  const has = (k) => k in store;
  const plan = E.espacoMigPlan(Object.keys(store), 'u1', has);
  assert.deepEqual(plan.map((p) => p[0]).sort(), ['ca:tab:-', 'kb:central:-', 'per:central:-']);
  assert.ok(plan.every(([f, t]) => t === f.slice(0, -2) + ':u1'));
  assert.deepEqual(E.espacoMigPlan(Object.keys(store), '', has), [], 'sem conta: nada');
  assert.deepEqual(E.espacoMigPlan(Object.keys(store), '-', has), []);
  // runtime: copia, marca a conta e não repete (nem sobrescreve o que a pessoa mudou depois)
  const X = loadEspaco({ store });
  assert.equal(X.ctx.espacoMigrar('u1'), 3);
  assert.equal(store['ca:tab:u1'], 'minhas'); assert.equal(store['ca:f:u1'], 'já-tinha', 'destino com valor fica');
  assert.equal(store['ca:tab:-'], 'minhas', 'o original do Grátis fica (sair da conta volta pra ele)');
  assert.equal(store['sf:migLocal:u1'], '1');
  store['ca:tab:u1'] = 'do-time';
  assert.equal(X.ctx.espacoMigrar('u1'), 0, 'idempotente');
  assert.equal(store['ca:tab:u1'], 'do-time');
  assert.equal(X.ctx.espacoMigrar('u2'), 4, 'outra conta neste computador também recebe o do Grátis (inclusive o ca:f que a u1 já tinha)');
});

test('updater: canal pela sessão; sem sessão = GitHub Releases público; latest.json torto/404 = silêncio', () => {
  assert.deepEqual(E.updCanal(true), { tipo: 'conta' });
  const pub = E.updCanal(false);
  assert.equal(pub.tipo, 'publico');
  assert.equal(pub.manifest, 'https://github.com/douglaspoa/multi-agents-and-branches/releases/latest/download/latest.json');
  assert.equal(pub.zip, 'https://github.com/douglaspoa/multi-agents-and-branches/releases/latest/download/Starfork-portable.zip');
  assert.equal(E.updPubParse(''), null, '404/sem rede: o Rust devolve ""');
  assert.equal(E.updPubParse('<html>Not Found</html>'), null);
  assert.equal(E.updPubParse('{"version":"x"}'), null, 'sem buildMs');
  assert.equal(E.updPubParse('{"buildMs":"abc"}'), null);
  assert.deepEqual(E.updPubParse('{"buildMs":1760000000000,"version":"16/10","file":"Starfork-portable.zip"}'), { buildMs: 1760000000000, version: '16/10', file: 'Starfork-portable.zip' });
  // ganchos: o Rust busca a URL FIXA (nada do front) e segue o redirect; o front usa o mesmo apply_update
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(rs, /const UPD_PUB_MANIFEST: &str = "https:\/\/github\.com\/douglaspoa\/multi-agents-and-branches\/releases\/latest\/download\/latest\.json";/);
  assert.match(cut(rs, 'fn update_manifest_public() -> String {', '\n}'), /"-fsSL"/);
  assert.match(rs, /apply_update,\n\s+update_manifest_public,/, 'registrado no invoke_handler');
  assert.match(upd, /invoke\('update_manifest_public'\)/);
  assert.match(upd, /if\(updInfo\.canal==='publico'\) url=updCanal\(false\)\.zip;/);
  assert.doesNotMatch(upd, /entre na conta pra receber atualizações/);
});

test('chaves do Grátis: dono "-" (sem conta) — ao entrar, só sobem as que a conta ainda não tem; PR #130 preservado', () => {
  assert.equal(K.secretsLocalPlan('-', 'u1', '', 'a@x'), 'adopt-local');
  assert.equal(K.secretsLocalPlan('u-outro', 'u1', 'a@x', 'a@x'), 'clear', 'arquivo de outra conta continua sendo limpo');
  assert.equal(K.secretsLocalPlan('u1', 'u1', '', ''), 'mirror');
  assert.deepEqual(K.secretsLocalPairs('DEEPSEEK_API_KEY=sk-1\nOPENAI_API_KEY=sk-2\n# comentário\nlixo\n', ['OPENAI_API_KEY']), ['DEEPSEEK_API_KEY=sk-1']);
  assert.deepEqual(K.secretsLocalPairs('A=1', []), [], 'nome curto demais não é chave');
  const set = cut(chaves, 'async function secretSet(name, value){', '\n}');
  assert.match(set, /if\(secretsAreLocal\(\)\)\{ await secretsLocalWrite\(name, value\);/);
  assert.match(cut(chaves, 'async function secretDel(name){', '\n}'), /if\(secretsAreLocal\(\)\)\{ await secretsLocalWrite\(name, null\);/);
  const file = cut(chaves, 'async function secretsLocalFile(){', '\n}');
  assert.match(file, /owner && owner!=='-' && owner!==me/, 'arquivo de outra conta: limpa antes (nunca herda)');
  assert.match(cut(chaves, 'async function secretsSync(){', '\n}'), /if\(typeof cloudAllowed==='function' && !cloudAllowed\(\)\) return;/, 'espaço local não espelha o cofre');
  assert.match(cut(chaves, 'async function secretsForget(){', '\n}'), /lsGet\('sb:llmEnvOwner'\)==='-'/, 'sair não apaga as chaves do Grátis');
  assert.match(read('js/67-ajustes.js'), /Guardada só neste computador/);
  assert.match(read('js/30-sua-ia.js'), /Guardada só neste computador/);
});

test('aba Planos: Grátis R$0 × Pro R$29 × Empresa R$79, rodapé, e "Assinar o Pro" sem botão que não funciona', () => {
  assert.deepEqual(P.PLANOS.map((p) => [p.id, p.preco]), [['gratis', 'R$0'], ['pro', 'R$29'], ['empresa', 'R$79']]);
  assert.match(P.PLANOS[0].per, /sem cartão/); assert.match(P.PLANOS[0].lead, /tudo no seu computador, sem limite/i);
  assert.match(P.PLANOS[1].per, /R\$290\/ano/); assert.match(P.PLANOS[1].lead, /aprovadores ilimitados/i);
  for (const f of ['Quadro do time na nuvem', 'App de celular e push', 'Provas na nuvem', 'Links de entrega pro cliente', 'Memória sincronizada']) assert.ok(P.PLANOS[1].itens.some((i) => i.startsWith(f)), f);
  assert.match(P.PLANOS[2].per, /mínimo de 5/); assert.ok(['Política da organização', 'Auditoria', 'SSO'].every((f) => P.PLANOS[2].itens.some((i) => i.startsWith(f))));
  assert.equal(P.PLANOS_RODAPE, 'Abre sem login e sem rede; cancelar não trava nada local.');
  assert.equal(P.planosAssinarAcao(false, true), 'entrar');
  assert.equal(P.planosAssinarAcao(false, false), 'entrar');
  assert.equal(P.planosAssinarAcao(true, true), 'checkout', 'cobrança ligada: o fluxo do Stripe que já existe');
  assert.equal(P.planosAssinarAcao(true, false), 'embreve');
  assert.match(planos, /A assinatura abre em breve\. Os preços ficam em starfork\.com\.br\/precos\./);
  assert.match(planos, /auShow\('plans', \{ backTo:\(\)=>planosOpen\(\) \}\)/);
  // padrão de aba (nunca modal)
  assert.match(planos, /VIEW_META\.planos=\{ title:'Planos'/); assert.match(planos, /VIEW_OVERLAY\.planos='planosOverlay'/);
  assert.match(html, /<div class="overlay fwoverlay pgov" id="planosOverlay" style="display:none">/);
});

test('CTA de upgrade: motivo + preço + alternativa grátis; nunca no plano, na prova ou no portão', () => {
  assert.equal(P.upgradeInfo('convite').t, 'Convidar alguém é do Pro');
  assert.match(P.upgradeInfo('convite').p, /quem cria custa R\$29\/mês, quem só aprova não paga/i);
  assert.match(P.upgradeInfo('cliente').alt, /relatório local em Entregas \(PDF ou HTML\)/);
  assert.match(P.upgradeInfo('time').alt, /a prova vai no próprio PR/);
  assert.match(P.upgradeInfo('epico').alt, /Dividir/);
  assert.equal(P.upgradeInfo('qualquer'), P.UPGRADE.time);
  for (const f of ['32-planner.js', '34-orquestrador.js', '80-aprovar.js', '60-provas-pr.js', '77-tarefa-etapas.js'])
    assert.doesNotMatch(read('js/' + f), /upgradeCta|upgradeToast|R\$29/, f + ': sem upgrade dentro do plano/prova/portão');
  // superfícies ligadas
  assert.match(read('js/67-ajustes.js'), /upgradeCtaHtml\(id==='convites'\?'convite'/);
  assert.match(read('js/43-espaco-times.js'), /upgradeCtaHtml\('time'\)/);
  assert.match(read('js/20-workspace-tarefa.js'), /upgradeToast\('celular'\)/);
  assert.match(read('js/31-nova-demanda-form.js'), /upgradeToast\('epico'\)/);
  assert.doesNotMatch(planos, /limite de|restam|\d+ de \d+ (demandas|projetos)/i, 'nenhum contador em recurso local');
});

test('abre sem login: o gate não força a tela de entrada; sessão caída vira aviso; sem plano não abre os planos à força', () => {
  const gate = cut(onb, 'loginGateSync=function(){', '\n};');
  assert.doesNotMatch(gate.replace(/fn:\(\)=>auShow\(/g, ''), /auShow\(/, 'sem sessão nada abre sozinho (só o botão "entrar" do aviso)');
  assert.match(gate, /toast\('Sua sessão expirou\. O app segue no Grátis/);
  assert.match(onb, /payShow=function\(\)\{ gratisAvisoConta\(\); \};/);
  assert.match(onb, /Sua conta está no Grátis: tudo roda no seu computador\. A nuvem do time é do Pro\./);
  const after = cut(onb, 'async function auAfterSession(o){', '\n}');
  assert.match(after, /if\(want\)\{ auPlanFromSite\(\); auShow\('plans'\); return; \}/);
  assert.doesNotMatch(after, /auPlanFromSite\(\); auShow\('plans'\); return; \}\n  if\(!o\.fresh\)/);
  assert.match(cut(onb, 'function auShow(step, opts){', '\n}'), /au\.backTo=\(\)=>\{\};/, 'a tela de conta sempre fecha');
  const old = cut(nuvem, 'function loginGateSync(){', '\n}');
  assert.doesNotMatch(old, /dataset\.lock='1'/, 'a versão antiga também não tranca');
  assert.doesNotMatch(cut(nuvem, 'function closeCloud(){', '\n}'), /auShow/);
  // 1ª abertura: boas-vindas no topo dos Primeiros passos (não bloqueia), sem exigir conta
  const aj = read('js/67-ajustes.js');
  assert.match(aj, /Começar no Grátis \(tudo no seu computador\)/);
  assert.match(aj, /id="ppEntrar">Entrar na conta/);
  assert.doesNotMatch(cut(aj, 'function ppMaybeStart(){', '\n}'), /SB\.sess\(\)/);
});

test('nuvem calada no espaço local: tickLoop, cloudScopeOk, cloudTeamId e os ticks de fora do laço', () => {
  assert.match(cut(sync, 'function tickLoop(name, fn, ms, firstMs, opts){', '\n}'), /if\(!L\.local && typeof isLocalSpace==='function' && isLocalSpace\(\)\) return;/);
  assert.match(cut(escopo, 'function cloudScopeOk(){', '\n}'), /isLocalSpace\(\)\) return false;/);
  assert.match(cut(nuvem, 'function cloudTeamId(){', '}'), /isLocalSpace\(\)\) return ''/);
  assert.match(sync, /if\(SB\.sess\(\) && cloudAllowed\(\)\) sbFetch\('\/rest\/v1\/profiles/, 'last_seen_at');
  assert.match(cut(sync, 'async function appVersionPing(){', '\n}'), /!cloudAllowed\(\)/);
  assert.match(cut(read('js/37-memoria.js'), 'async function memTeamSync(){', '\n  const repo'), /!cloudAllowed\(\)\) return false;/);
  assert.match(cut(chaves, 'async function userRepoSync(){', '\n  try{'), /!cloudAllowed\(\)\) return;/);
  assert.match(read('js/48-presenca-mobile.js'), /!cloudAllowed\(\)\)\) return;/, 'beforeunload da presença');
  assert.match(read('js/47-edicoes-agente.js'), /tickLoop\('agentEdits', aeTick, 10000, 4000, \{ local:true \}\)/);
  assert.match(read('js/49-epico-pedidos.js'), /tickLoop\('epicRequests', erTick, 3000, 2000, \{ local:true \}\)/);
  assert.match(read('js/52-erros.js'), /app_errors/, 'telemetria de erro continua (permitida no Grátis)');
  // billingSync liga o billingOn só com a assinatura decidida e avisa a mudança de espaço
  assert.match(cut(chaves, 'async function billingSync(){', '\n}'), /espacoSync\(\)/);
  // ordem de carga: 39-espaco antes da conta; 82-planos por último (antes do e2e)
  assert.ok(html.indexOf('js/39-espaco.js') < html.indexOf('js/40-nuvem-conta.js'));
  assert.ok(html.indexOf('js/82-planos.js') > html.indexOf('js/81-epico-aba.js') && html.indexOf('js/82-planos.js') < html.indexOf('js/99-e2e.js'));
});
