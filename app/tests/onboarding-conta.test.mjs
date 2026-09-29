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
const ENV = new Function(cut(envSrc, '// @env-puro-inicio', '// @env-puro-fim') + '\nreturn { envKind, envWhat, envSummary, ENV_KIND_TAG };')();

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

test('envKind: o `kind` do Rust vence o nome; selo único pra Ambiente e tour', () => {
  assert.equal(ENV.envKind({ name: 'Git', kind: 'opt' }), 'opt');
  assert.equal(ENV.envKind({ name: 'GitHub CLI (gh)', kind: 'req' }), 'req');
  assert.equal(ENV.envKind({ name: 'GitHub CLI (gh)', kind: 'lixo' }), 'rec'); // valor inválido → cai no nome
  assert.deepEqual(ENV.ENV_KIND_TAG, { req: '', rec: 'recomendado', opt: 'opcional' });
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
    const api = f(opts.SB, opts.invoke, () => opts.os || 'mac', opts.sbFetch || (async () => { throw new Error('Failed to fetch'); }),
      (e, ctx) => ({ msg: ctx + ' — Sem conexão agora — cheque a internet/VPN e tente de novo.' }), opts.$id || (() => ({ style: {} })), opts.toast || (() => {}), (s) => s, () => '', () => { renders++; });
    const r = await api.checkUpdate(true);
    return { r, renders, api };
  };
  const noSess = await run({ SB: { sess: () => null }, invoke: async () => false });
  assert.equal(noSess.renders, 1); assert.match(noSess.r.msg, /sem sessão/);
  const dev = await run({ SB: { sess: () => ({}) }, invoke: async (c) => c === 'is_dev_install' });
  assert.equal(dev.renders, 1); assert.equal(dev.r.dev, true);
  const net = await run({ SB: { sess: () => ({}) }, invoke: async () => false });
  assert.equal(net.renders, 1); assert.equal(net.r.ok, false); assert.doesNotMatch(net.r.msg, /Failed to fetch/);
  assert.match(net.r.msg, /^não deu pra checar/);
  // Windows/Linux: sai cedo (sem canal de .app) e ainda assim redesenha
  const win = await run({ SB: { sess: () => ({}) }, invoke: async () => false, os: 'windows' });
  assert.equal(win.renders, 1); assert.equal(win.r.ok, true); assert.match(win.r.msg, /só no Mac/);
  // dev → checagem normal na MESMA instância: updLast.dev volta a false
  let devNow = true;
  const seq = await run({ SB: { sess: () => ({}) }, invoke: async (c) => (c === 'is_dev_install' ? devNow : c === 'build_info' ? '5' : false), sbFetch: async () => ({ buildMs: 1 }) });
  assert.equal(seq.r.dev, true);
  devNow = false; const r2 = await seq.api.checkUpdate(true);
  assert.equal(r2.dev, false); assert.match(r2.msg, /versão mais recente/);
  // versão nova com o botão "atualizar" fora do DOM (a barra de abas re-renderizou): não quebra e AVISA
  let toasts = 0;
  const neu = await run({ SB: { sess: () => ({}) }, invoke: async (c) => (c === 'build_info' ? '1000' : false),
    sbFetch: async () => ({ buildMs: 999999, version: '29/09' }), $id: () => null, toast: () => { toasts++; } });
  assert.equal(neu.r.ok, true); assert.match(neu.r.msg, /versão nova/); assert.equal(toasts, 1);
});

const cloudSrc = read('40-nuvem-conta.js');
const CLOUD = new Function(cut(cloudSrc, '// @cloud-puro-inicio', '// @cloud-puro-fim') + '\nreturn { cloudErrMsg, cloudInviteMsg, cloudInvitePending, isPtText };')();

test('cloudErrMsg: erros do PostgREST viram pt-BR com o que fazer', () => {
  const m = (x) => CLOUD.cloudErrMsg(new Error(x));
  assert.match(m('new row violates row-level security policy for table "invites"'), /permissão/);
  assert.match(m('duplicate key value violates unique constraint "team_members_pkey"'), /já existe/);
  assert.match(m('erro 409'), /já existe/);
  assert.match(m('insert or update on table "team_members" violates foreign key constraint "team_members_team_id_fkey"'), /não existe mais/);
  // 401 é sessão vencida (antes caía em "sem permissão")
  assert.match(m('erro 401'), /sessão expirou/);
  // RPC/tabela que não existe no servidor ≠ "alguém mudou"
  assert.match(m('Could not find the function public.accept_pending_invites without parameters in the schema cache'), /Recurso não encontrado — a nuvem pode estar desatualizada/);
  assert.match(m('erro 404'), /Recurso não encontrado/);
  // inglês com "time"/"plan"/"sem"/número parecido com 5xx NÃO passa como português nem vira "nuvem com problema"
  assert.match(m('request time limit reached'), /^Não deu certo agora/);
  assert.match(m('sem-ver 2.0 parse error at 503 bytes'), /^Não deu certo agora/);
  assert.equal(CLOUD.isPtText('time out'), false); assert.equal(CLOUD.isPtText('nao autenticado'), true);
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

test('cloudInvitePending: convite vencido não bloqueia um novo', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const inv = [{ email: 'Ana@Lojinha.dev', expires_at: '2026-09-30T00:00:00Z' }, { email: 'bia@x.dev', expires_at: '2026-09-01T00:00:00Z' }];
  assert.equal(CLOUD.cloudInvitePending(inv, 'ana@lojinha.dev', now), true);
  assert.equal(CLOUD.cloudInvitePending(inv, 'bia@x.dev', now), false);
  assert.equal(CLOUD.cloudInvitePending(null, 'x@y.dev', now), false);
});

test('cloudInviteMsg: diz que entra sozinho e traz o token como plano B', () => {
  const s = CLOUD.cloudInviteMsg('Loja', 'Lojinha', 'ana@lojinha.dev', 'tok-123');
  assert.match(s, /time Loja da Lojinha/);
  assert.match(s, /ana@lojinha\.dev — você entra no time sozinho/);
  assert.ok(s.trim().endsWith('tok-123'));
});

const onbSrc = read('44-onboarding.js');
const auCheckoutErr = new Function('isPtText', cut(onbSrc, 'function auCheckoutErr(', 'async function auCheckout(') + '\nreturn auCheckoutErr;')(CLOUD.isPtText);

test('auCheckoutErr: nada de "Unexpected token"/"HTTP 500" na tela de pagamento', () => {
  assert.match(auCheckoutErr(0, null, { network: true, message: 'Failed to fetch' }), /Sem conexão/);
  assert.match(auCheckoutErr(401, { error: 'Invalid JWT' }), /sessão expirou/);
  assert.match(auCheckoutErr(500, null), /problema agora/);
  assert.match(auCheckoutErr(0, null), /problema agora/); // resposta sem url / HTML no lugar de JSON
  assert.match(auCheckoutErr(404, { error: 'Function not found' }), /não está disponível/);
  assert.match(auCheckoutErr(400, { error: 'teamId required' }), /plano Time/);
  assert.match(auCheckoutErr(400, { error: 'request timeout' }), /Não deu pra abrir o pagamento/); // "timeout" não é "time"
  assert.equal(auCheckoutErr(400, { error: 'plano não está ativo' }), 'Plano não está ativo');
  assert.match(auCheckoutErr(400, { error: 'plan inactive' }), /Não deu pra abrir o pagamento/);
  for (const s of [0, 400, 401, 404, 500]) assert.doesNotMatch(auCheckoutErr(s, { error: 'Unexpected token < in JSON' }), /Unexpected|HTTP/);
});

// regressão: o botão "atualizar" sobrevive a vários renders da barra de abas (e a um render sem #tabRight)
test('renderTabs 2x: #updBtn continua na barra (e volta se um render ficar sem #tabRight)', () => {
  const src15 = read('15-config-abas-onboarding.js');
  const block = cut(src15, 'let _updBtnNode=null;', '// R7: barra de abas lotada');
  let withSlot = true;
  const node = (id) => { const n = { id, children: [], parentElement: null, style: {}, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} },
    appendChild(c) { if (c.parentElement) c.remove(); c.parentElement = n; n.children.push(c); return c; },
    remove() { const p = n.parentElement; if (p) { p.children = p.children.filter((x) => x !== n); n.parentElement = null; } },
    contains(c) { return n.children.some((x) => x === c || x.contains(c)); },
    querySelectorAll() { return []; }, querySelector() { return null; } };
    Object.defineProperty(n, 'innerHTML', { set(h) { n.children.forEach((c) => { c.parentElement = null; }); n.children = []; if (withSlot && /id="tabRight"/.test(h)) n.appendChild(node('tabRight')); } });
    return n; };
  const root = node('root'), bar = root.appendChild(node('tabBar')), stash = root.appendChild(node('stash'));
  const upd = stash.appendChild(node('updBtn'));
  const find = (n, id) => { if (n.id === id) return n; for (const c of n.children) { const r = find(c, id); if (r) return r; } return null; };
  const $id = (id) => find(root, id);
  const noop = () => {};
  const api = new Function('$id', 'TABS', 'activeTab', 'MULTI_KINDS', 'VIEW_META', 'tabStateApi', 'esc', 'escA', 'tabIcon', 'IC', 'SHORTCUTS_HELP',
    'requestAnimationFrame', 'syncChromeH', 'tabsFit', 'openTab', 'setRailCollapsed', 'tabLeaveGuard', 'activateTab', 'tabCloseGuarded', 'tabDropAfter', 'tabMove',
    'let tabDragId=null;\n' + block + '\nreturn { renderTabs };')($id, [], '', new Set(), {}, noop, (s) => s, (s) => s, () => '', { x: '' }, '', noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  api.renderTabs();
  assert.equal($id('updBtn'), upd); assert.equal(upd.parentElement.id, 'tabRight');
  api.renderTabs();
  assert.equal($id('updBtn'), upd, 'o 2º render não pode destruir o botão'); assert.equal(upd.parentElement.id, 'tabRight');
  withSlot = false; api.renderTabs(); // render sem #tabRight: o nó fica guardado
  withSlot = true; api.renderTabs();
  assert.equal($id('updBtn'), upd, 'volta no render seguinte');
});

test('emErrMsg: erro ao criar a pasta do projeto em pt-BR, texto cru só nos detalhes', () => {
  const EM = new Function(cut(read('36-comecar.js'), '// @em-puro-inicio', '// @em-puro-fim') + '\nreturn emErrMsg;')();
  assert.match(EM.call(null, "File exists (os error 17)").msg, /Já existe uma pasta/);
  assert.match(EM('Permission denied (os error 13)').msg, /permissão/);
  assert.match(EM('Read-only file system (os error 30)').msg, /somente leitura/);
  assert.match(EM('No such file or directory (os error 2)').msg, /Documentos não foi encontrada/);
  const g = EM('weird thing happened'); assert.match(g.msg, /^Não deu pra criar a pasta/); assert.equal(g.raw, 'weird thing happened');
  const git = EM('O git não está instalado — rode xcode-select --install'); assert.equal(git.msg, 'O git não está instalado — rode xcode-select --install'); assert.equal(git.raw, '');
});
