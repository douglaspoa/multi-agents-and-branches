// BLOQUEADORES DE CONTA (mesa-bugs-2/conta, itens 01–03): regra pura de cada um + os ganchos no código.
// `node --test app/tests/bloq-conta.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const chaves = read('js/41-assinatura-chaves.js'), nuvem = read('js/40-nuvem-conta.js'), onb = read('js/44-onboarding.js'), abas = read('js/15-config-abas-onboarding.js');
const ajustes = read('js/67-ajustes.js'), issues = read('js/14-issues-projeto.js'), a11y = read('js/54-acessibilidade.js'), css60 = read('css/60-grafo-times-nova-demanda.css'), html = read('index.html'), css99 = read('css/99-ajustes.css');
const K = new Function(cut(chaves, '// @puro-chaves-dono-inicio', '// @puro-chaves-dono-fim') + '\nreturn { secretsLocalPlan };')();
const F = new Function(cut(onb, '// @puro-au-foco-inicio', '// @puro-au-foco-fim') + '\nreturn { auInert, auInertSkip, auTrapNext, auBlocksApp };')();

test('01 · cofre vazio + arquivo espelho DESTA conta: não readota (a chave removida não volta)', () => {
  assert.equal(K.secretsLocalPlan('u-ana', 'u-ana', 'ana@x', 'ana@x'), 'mirror');
  const del = cut(chaves, 'async function secretDel', '\n}');
  assert.ok(del.indexOf("lsSet('sb:llmEnvOwner', cloudUserId())") > 0 && del.indexOf("lsSet('sb:llmEnvOwner'") < del.indexOf('secretsSync()'), 'marca o dono antes do sync');
  const sync = cut(chaves, 'async function secretsSync', '\n}');
  assert.match(sync, /!rows\.length && plan==='adopt'/);
  assert.match(sync, /write_llm_env[\s\S]*lsSet\('sb:llmEnvOwner', uid\)/, 'depois de espelhar, o arquivo é desta conta');
});

test('01 · adoção num POST só (bulk upsert): app fechado no meio não deixa cofre parcial', () => {
  const sync = cut(chaves, 'async function secretsSync', '\n}');
  assert.equal((sync.match(/method:'POST'/g) || []).length, 1);
  assert.doesNotMatch(sync, /for\s*\(const l of pairs\)/, 'sem POST por linha');
  assert.match(sync, /JSON\.stringify\(pairs\.map\(/);
});

test('02 · troca de conta: arquivo de outra conta é limpo antes de qualquer uso; sem dono só adota se for a mesma pessoa', () => {
  assert.equal(K.secretsLocalPlan('u-douglas', 'u-beto', 'beto@x', 'beto@x'), 'clear', 'arquivo do Douglas nunca vai pro Beto');
  assert.equal(K.secretsLocalPlan('', 'u-beto', 'douglas@x', 'beto@x'), 'clear', 'legado: último a entrar era outra pessoa');
  assert.equal(K.secretsLocalPlan(null, 'u-d', 'Douglas@X ', 'douglas@x'), 'adopt', 'legado da mesma pessoa: migração sem clique');
  assert.equal(K.secretsLocalPlan('', 'u-d', '', 'douglas@x'), 'clear', 'sem histórico: não adota');
  assert.equal(K.secretsLocalPlan('local', 'u-d', 'd@x', 'd@x'), 'clear', 'o ramo "local" saiu');
  const sync = cut(chaves, 'async function secretsSync', '\n}');
  assert.ok(sync.indexOf("plan==='clear'") < sync.indexOf('sbGet('), 'limpa antes até de ler o cofre');
  assert.match(chaves, /const SECRETS_BOOT_EMAIL=lsGet\('sb:email'\)/, 'e-mail de antes deste boot (o login sobrescreve sb:email)');
  const forget = cut(chaves, 'async function secretsForget', '\n}');
  assert.match(forget, /secretsCache=null/); assert.match(forget, /write_llm_env',\{ content:'' \}/); assert.match(forget, /lsSet\('sb:llmEnvOwner',''\)/);
  assert.match(forget, /secretsAvailRefresh\(\)/, 'disponibilidade das IAs relida na hora');
  assert.doesNotMatch(forget, /DELETE/, 'não apaga nada do cofre na nuvem');
});

test('02 · todo jeito de sair limpa as chaves locais; entrar sincroniza na hora', () => {
  assert.match(cut(nuvem, 'function sbLogout', '\n}'), /secretsForget\(\)/);
  assert.match(cut(nuvem, 'function sbSessionEnded', '\n}'), /secretsForget\(\)/, 'sessão expirada também');
  assert.match(chaves, /\$id\('payLogout'\)\.onclick=\(\)=>\{ sbLogout\(\);/);
  const relog = cut(ajustes, 'const relog=', '};');
  assert.match(relog, /sbLogout\(\)/); assert.doesNotMatch(relog, /SB\.setSess\(null\)/);
  assert.match(cut(onb, 'async function auAfterSession', '\n}'), /secretsSync\(\)\.then\(secretsAvailRefresh\)/, 'login por senha/código');
  assert.match(nuvem, /SB\.setSess\(j\); cloudMsg=''; try\{ if\(typeof secretsSync==='function'\) secretsSync\(\)\.then\(secretsAvailRefresh\)/, 'login por OAuth');
});

test('02 · segredo do conector com conta logada (mesmo sem time) vai pro cofre, não só pro arquivo', () => {
  const t = cut(issues, 'async function trkSecretSave', '\n}');
  assert.match(t, /if\(typeof SB!=='undefined' && SB\.sess\(\)\) await secretSet\(name, value\)/);
  assert.doesNotMatch(t, /trkCloudOn\(\)/);
});

const el = (tag, id, attrs = {}) => ({ tagName: tag, id, a: { ...attrs },
  setAttribute(k, v) { this.a[k] = v; }, getAttribute(k) { return k in this.a ? this.a[k] : null; },
  hasAttribute(k) { return k in this.a; }, removeAttribute(k) { delete this.a[k]; } });

test('03 · tela de entrada: o resto do app fica inerte e oculto; ao fechar volta como estava', () => {
  const app = el('DIV', 'app'), ov = el('DIV', 'authOverlay'), scr = el('SCRIPT', 's'), ja = el('DIV', 'x', { inert: '' });
  const body = { children: [app, ov, scr, ja] };
  F.auInert(true, body, ov);
  assert.equal(app.getAttribute('inert'), ''); assert.equal(app.getAttribute('aria-hidden'), 'true');
  assert.equal(ov.hasAttribute('inert'), false, 'a própria tela continua viva');
  assert.equal(scr.hasAttribute('inert'), false);
  F.auInert(true, body, ov); // idempotente (troca de passo)
  F.auInert(false, body, ov);
  assert.equal(app.hasAttribute('inert'), false); assert.equal(app.hasAttribute('aria-hidden'), false);
  assert.equal(ja.getAttribute('inert'), '', 'não desfaz inert que não foi dela');
});

test('03 · toast e regiões aria-live seguem vivos; a tela fica acima de toda janela (abaixo do toast)', () => {
  for (const [tag, id, cls] of [['DIV', 'appToast', ''], ['DIV', 'a11yLiveStatus', 'a11y-live'], ['DIV', 'a11yLiveAlert', 'a11y-live'], ['DIV', 'x', 'foo a11y-live']]) {
    const e = el(tag, id); e.className = cls; assert.equal(F.auInertSkip(e), true, id);
  }
  const app = el('DIV', 'app'); app.className = 'app'; assert.equal(F.auInertSkip(app), false);
  const z = +css60.match(/\.au\{position:fixed;inset:0;z-index:(\d+)/)[1];
  const outros = [...html.matchAll(/id="(?:pubOverlay|goOverlay)"[^>]*z-index:(\d+)/g)].map((m) => +m[1]).concat(+css99.match(/\.sfsheet\{position:fixed;z-index:(\d+)/)[1]);
  assert.ok(outros.length === 3 && outros.every((n) => z > n), 'z ' + z + ' > ' + outros); assert.ok(z < 9999, 'abaixo do toast');
});

test('03 · os dois traps não brigam; painel do canvas nunca abre a tela de entrada', () => {
  const trap = cut(onb, 'function auTrapWire', '\n}');
  assert.match(trap, /closest\('\[role=dialog\]'\)/); assert.match(trap, /!o\.contains\(dlg\)/);
  assert.match(cut(a11y, 'function a11yTrapTab', '\n}'), /top\.closest\('\[inert\]'\)/, 'janela inerte não puxa o Tab');
  const show = cut(onb, 'function auShow', '\n}');
  assert.ok(show.indexOf("if(typeof SF_PANE!=='undefined' && SF_PANE) return;") >= 0 && show.indexOf('SF_PANE') < show.indexOf('auInert'), 'SF_PANE sai antes de marcar inert');
});

test('03 · Tab dá a volta dentro da tela; foco fora volta pra dentro', () => {
  const L = ['email', 'senha', 'entrar', 'criar'];
  assert.equal(F.auTrapNext(L, 'criar', false), 'email');
  assert.equal(F.auTrapNext(L, 'email', true), 'criar');
  assert.equal(F.auTrapNext(L, 'senha', false), null, 'no meio, o navegador segue');
  assert.equal(F.auTrapNext(L, 'novaDemanda', false), 'email');
  assert.equal(F.auTrapNext([], 'x', false), null);
});

test('03 · sem sessão e com a tela aberta, nenhuma aba abre por trás (planner inclusive)', () => {
  assert.equal(F.auBlocksApp(true, null), true);
  assert.equal(F.auBlocksApp(true, { access_token: 't' }), false, 'logado (planos/pronto): fluxo segue');
  assert.equal(F.auBlocksApp(false, null), false);
  const ot = cut(abas, 'function openTab(kind, opts){', '\n}');
  assert.ok(ot.indexOf('auBlocksApp(auOpen(), SB.sess())') >= 0 && ot.indexOf('auBlocksApp') < ot.indexOf('activateTab'), 'guarda no topo do openTab');
  assert.match(cut(onb, 'function auShow', '\n}'), /auInert\(true, document\.body, o\); auTrapWire\(o\)/);
  assert.match(cut(onb, 'function auHide', '\n}'), /auInert\(false, document\.body, o\)/);
});
