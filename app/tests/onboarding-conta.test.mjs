// R7 onda 5 (onboarding · conta · ambiente): blocos puros sem browser.
// - 11-ambiente-updater: envKind/envWhat/envSummary (o que é obrigatório vs opcional) e o checkUpdate que
//   SEMPRE redesenha o bloco "Versão" (antes ficava preso em "verificando…").
// - 40-nuvem-conta: cloudErrMsg (erro do PostgREST em pt-BR) e cloudInviteMsg (mensagem única do convite).
// - 44-onboarding: auCheckoutErr (erro do checkout sem "Unexpected token" nem "HTTP 500").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'trecho não encontrado: ' + a); return s.slice(i, j); };

const envSrc = read('11-ambiente-updater.js');
const ENV = new Function(cut(envSrc, '// @env-puro-inicio', '// @env-puro-fim') + '\nreturn { envKind, envWhat, envSummary };')();

// nomes exatamente como o Rust manda (lib.rs env_check)
const CHECKS = (over) => [
  { name: 'Node.js (≥22.6)', ok: true }, { name: 'Motor do Starfork', ok: true }, { name: 'Git', ok: true },
  { name: 'Claude Code', ok: true }, { name: 'GitHub CLI (gh)', ok: true }, { name: 'Túnel do preview (opcional)', ok: true },
].map((c) => Object.assign({}, c, (over || {})[c.name] || {}));

test('envKind: gh é recomendado, túnel é opcional, o resto é obrigatório', () => {
  assert.equal(ENV.envKind({ name: 'GitHub CLI (gh)' }), 'rec');
  assert.equal(ENV.envKind({ name: 'gh' }), 'rec');
  assert.equal(ENV.envKind({ name: 'Túnel do preview (opcional)' }), 'opt');
  for (const n of ['Node.js (≥22.6)', 'Motor do Starfork', 'Git', 'Claude Code']) assert.equal(ENV.envKind({ name: n }), 'req', n);
});

test('envSummary: só túnel/gh faltando NÃO é pendência (antes abria a aba Ambiente a cada boot)', () => {
  const s = ENV.envSummary(CHECKS({ 'Túnel do preview (opcional)': { ok: false }, 'GitHub CLI (gh)': { ok: false } }));
  assert.deepEqual(s, { tot: 6, okN: 4, reqBad: 0, optBad: 2 });
  const r = ENV.envSummary(CHECKS({ 'Claude Code': { ok: false } }));
  assert.equal(r.reqBad, 1); assert.equal(r.optBad, 0);
  assert.deepEqual(ENV.envSummary(null), { tot: 0, okN: 0, reqBad: 0, optBad: 0 });
});

test('envWhat: cada peça tem explicação em linguagem de gente', () => {
  for (const c of CHECKS()) assert.ok(ENV.envWhat(c).length > 10, c.name);
  assert.equal(ENV.envWhat({ name: 'coisa nova' }), '');
});

test('checkUpdate redesenha o bloco "Versão" mesmo saindo cedo (sem sessão / dev / erro)', async () => {
  const block = cut(envSrc, 'async function checkUpdate(manual){', 'async function applyUpdate');
  const run = async (opts) => {
    let renders = 0;
    const f = new Function('SB', 'invoke', 'osKind', 'sbFetch', 'humanErr', '$id', 'toast', 'esc', 'ic', 'updRenderCfg',
      'let updInfo=null; let updLast={ at:0, ok:false, msg:"", dev:false, mine:0 }; let updToastFor=0;\n' + block + '\nreturn { checkUpdate, get last(){ return updLast; } };');
    const api = f(opts.SB, opts.invoke, () => 'mac', opts.sbFetch || (async () => { throw new Error('Failed to fetch'); }),
      (e, ctx) => ({ msg: ctx + ' — Sem conexão agora — cheque a internet/VPN e tente de novo.' }), () => ({ style: {} }), () => {}, (s) => s, () => '', () => { renders++; });
    const r = await api.checkUpdate(true);
    return { r, renders };
  };
  const noSess = await run({ SB: { sess: () => null }, invoke: async () => false });
  assert.equal(noSess.renders, 1); assert.match(noSess.r.msg, /sem sessão/);
  const dev = await run({ SB: { sess: () => ({}) }, invoke: async (c) => c === 'is_dev_install' });
  assert.equal(dev.renders, 1); assert.equal(dev.r.dev, true);
  const net = await run({ SB: { sess: () => ({}) }, invoke: async () => false });
  assert.equal(net.renders, 1); assert.equal(net.r.ok, false); assert.doesNotMatch(net.r.msg, /Failed to fetch/);
  assert.match(net.r.msg, /^não deu pra checar/);
});

const cloudSrc = read('40-nuvem-conta.js');
const CLOUD = new Function(cut(cloudSrc, '// @cloud-puro-inicio', '// @cloud-puro-fim') + '\nreturn { cloudErrMsg, cloudInviteMsg };')();

test('cloudErrMsg: erros do PostgREST viram pt-BR com o que fazer', () => {
  const m = (x) => CLOUD.cloudErrMsg(new Error(x));
  assert.match(m('new row violates row-level security policy for table "invites"'), /permissão/);
  assert.match(m('duplicate key value violates unique constraint "team_members_pkey"'), /já existe/);
  assert.match(m('erro 409'), /já existe/);
  assert.match(m('insert or update on table "team_members" violates foreign key constraint "team_members_team_id_fkey"'), /não existe mais/);
  assert.match(m('invalid input syntax for type uuid: "abc"'), /token inteiro/);
  assert.match(m('erro 403'), /permissão/);
  assert.match(m('erro 502'), /problema agora/);
  assert.match(m('JWT expired'), /sessão expirou/);
  // RPC do Starfork já responde em português: passa como veio (com maiúscula)
  assert.equal(m('convite inválido ou expirado'), 'Convite inválido ou expirado');
  assert.equal(m('sem assentos livres na organização'), 'Sem assentos livres na organização');
  // desconhecido em inglês: frase humana + o texto curto entre parênteses (pro suporte)
  const u = m('something weird happened');
  assert.match(u, /^Não deu certo agora/); assert.match(u, /something weird/);
  assert.match(CLOUD.cloudErrMsg(new Error('erro 403'), 'Ao convidar'), /^Ao convidar: Você não tem permissão/);
});

test('cloudInviteMsg: diz que entra sozinho e traz o token como plano B', () => {
  const s = CLOUD.cloudInviteMsg('Loja', 'Lojinha', 'ana@lojinha.dev', 'tok-123');
  assert.match(s, /time Loja da Lojinha/);
  assert.match(s, /ana@lojinha\.dev — você entra no time sozinho/);
  assert.ok(s.trim().endsWith('tok-123'));
});

const onbSrc = read('44-onboarding.js');
const auCheckoutErr = new Function(cut(onbSrc, 'function auCheckoutErr(', 'async function auCheckout(') + '\nreturn auCheckoutErr;')();

test('auCheckoutErr: nada de "Unexpected token"/"HTTP 500" na tela de pagamento', () => {
  assert.match(auCheckoutErr(0, null, { network: true, message: 'Failed to fetch' }), /Sem conexão/);
  assert.match(auCheckoutErr(401, { error: 'Invalid JWT' }), /sessão expirou/);
  assert.match(auCheckoutErr(500, null), /problema agora/);
  assert.match(auCheckoutErr(0, null), /problema agora/); // resposta sem url / HTML no lugar de JSON
  assert.match(auCheckoutErr(404, { error: 'Function not found' }), /não está disponível/);
  assert.match(auCheckoutErr(400, { error: 'teamId required' }), /plano Time/);
  assert.match(auCheckoutErr(400, { error: 'request timeout' }), /Não deu pra abrir o pagamento/); // "timeout" não é "time"
  assert.equal(auCheckoutErr(400, { error: 'plano inativo' }), 'Plano inativo');
  for (const s of [0, 400, 401, 404, 500]) assert.doesNotMatch(auCheckoutErr(s, { error: 'Unexpected token < in JSON' }), /Unexpected|HTTP/);
});
