// BLOQUEADORES DE CONTA (mesa-bugs-2/conta, itens 01–03): regra pura de cada um + os ganchos no código.
// `node --test app/tests/bloq-conta.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const chaves = read('js/41-assinatura-chaves.js'), nuvem = read('js/40-nuvem-conta.js'), onb = read('js/44-onboarding.js'), abas = read('js/15-config-abas-onboarding.js');
const K = new Function(cut(chaves, '// @puro-chaves-dono-inicio', '// @puro-chaves-dono-fim') + '\nreturn { secretsAdoptLocal };')();
const F = new Function(cut(onb, '// @puro-au-foco-inicio', '// @puro-au-foco-fim') + '\nreturn { auInert, auTrapNext, auBlocksApp };')();

test('01 · cofre vazio + arquivo espelho DESTA conta: não adota (a chave removida não volta)', () => {
  assert.equal(K.secretsAdoptLocal('u-ana', 'u-ana'), false);
  // remover marca o arquivo como espelho da conta antes de sincronizar
  const del = cut(chaves, 'async function secretDel', '\n}');
  assert.ok(del.indexOf("lsSet('sb:llmEnvOwner', cloudUserId())") > 0 && del.indexOf("lsSet('sb:llmEnvOwner'") < del.indexOf('secretsSync()'), 'marca o dono antes do sync');
  const sync = cut(chaves, 'async function secretsSync', '\n}');
  assert.match(sync, /!rows\.length && secretsAdoptLocal\(lsGet\('sb:llmEnvOwner'\), uid\)/);
  assert.match(sync, /write_llm_env[\s\S]*lsSet\('sb:llmEnvOwner', uid\)/, 'depois de espelhar, o arquivo é desta conta');
});

test('02 · troca de conta: arquivo de outra conta nunca sobe pro cofre; sair limpa o arquivo local', () => {
  assert.equal(K.secretsAdoptLocal('u-douglas', 'u-beto'), false, 'arquivo do Douglas não vai pro Beto');
  assert.equal(K.secretsAdoptLocal('', 'u-beto'), true, 'sem dono (legado / depois de sair): migração sem clique segue');
  assert.equal(K.secretsAdoptLocal(null, 'u-beto'), true);
  assert.equal(K.secretsAdoptLocal('local', 'u-beto'), true, 'gravado sem conta neste computador');
  const forget = cut(chaves, 'async function secretsForget', '\n}');
  assert.match(forget, /secretsCache=null/); assert.match(forget, /write_llm_env',\{ content:'' \}/); assert.match(forget, /lsSet\('sb:llmEnvOwner',''\)/);
  const logout = cut(nuvem, 'function sbLogout', '\n}');
  assert.match(logout, /secretsForget\(\)/, 'sbLogout limpa as chaves locais');
  assert.doesNotMatch(forget, /DELETE/, 'não apaga nada do cofre na nuvem');
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
