// MESA DE BUGS 2 · CONTA E ACESSO — itens que ATRAPALHAM (04–13) e cosméticos (14–19).
// Funções puras recortadas por marcador + `new Function`, e ganchos lidos no código. `node --test app/tests/atrap-conta.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const aj = read('src/js/67-ajustes.js'), cloud = read('src/js/40-nuvem-conta.js'), onb = read('src/js/44-onboarding.js');
const i18n = read('src/js/39-i18n-auth.js'), suaia = read('src/js/30-sua-ia.js'), amb = read('src/js/11-ambiente-updater.js'), picker = read('src/js/29-ia-picker.js');
const lib = read('src-tauri/src/lib.rs'), once = read('src-tauri/src/ai_once.rs'), ideia = read('src-tauri/src/ideia.rs');
const noComments = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const P = new Function(cut(aj, '// @atrap-conta-puro-inicio', '// @atrap-conta-puro-fim') + '\nreturn { ppPcList, ppPcItems, ppAutoOk, ajOrgFormErr, ajInvRow };')();
const AJ = new Function(cut(aj, '// @ajustes-puro-inicio', '// @ajustes-puro-fim') + '\nreturn { ajBillingLine, ppSteps };')();
const ENV = new Function(cut(amb, '// @env-puro-inicio', '// @env-puro-fim') + '\nreturn { envKind };')();
const CLOUD = new Function(cut(cloud, '// @cloud-puro-inicio', '// @cloud-puro-fim') + '\nreturn { cloudErrMsg, cloudInviteMsg, cloudInvitePending };')();
const AU = new Function(cut(onb, '// @atrap-conta-au-inicio', '// @atrap-conta-au-fim') + '\nreturn { auReadyPlan };')();
const I = new Function(i18n + '\nreturn { T, authErrPt };')();
const SA = new Function(cut(suaia, '// @sua-ia-puro-inicio', '// @sua-ia-puro-fim') + '\nreturn { suaIaTagPt };')();

// ---------------------------------------------------------------- 04 · org criada / convite aceito
test('04: a conta recarregada em Ajustes avisa o avatar e a lateral (cloudBtnSync → meSync)', () => {
  const ready = cut(aj, 'async function ajCloudReady(', 'function ajCloudMsg(');
  assert.match(ready, /await tabBusy\('cfg', cloudLoad\(\)[\s\S]*cloudBtnSync\(\)/, 'depois do cloudLoad, cloudBtnSync');
});

// ---------------------------------------------------------------- 05 · "Conta pronta"
test('05: "Conta pronta" segue o próximo passo real nas duas colunas', () => {
  assert.deepEqual(AU.auReadyPlan('pc'), { left: 'ready', lead: AU.auReadyPlan('ia').lead, btn: 'Ir pra Primeiros passos', act: 'pp' });
  assert.equal(AU.auReadyPlan('proj').act, 'pp'); assert.match(AU.auReadyPlan('proj').lead, /abrir um projeto/);
  const d = AU.auReadyPlan('dem');
  assert.equal(d.left, 'ready_repo'); assert.equal(d.act, 'nova'); assert.match(d.btn, /primeira demanda/);
  assert.equal(AU.auReadyPlan(null).act, 'nova', 'tudo feito');
  assert.doesNotMatch(onb, /step==='ready' && typeof state!=='undefined' && state && state\.repo/, 'a esquerda não decide sozinha pelo projeto aberto');
});

test('05: só conta NOVA vê "Conta pronta"; quem já tinha conta volta pro app (e sabe se entrou num time)', () => {
  assert.match(onb, /async function auAfterSession\(o\)/);
  assert.match(onb, /if\(!o\.fresh\)\{ const j=[^\n]*cloudJoinedMsg\(\)[^\n]*auHide\(\)/);
  assert.match(onb, /sbAuth\('signup'[\s\S]*auAfterSession\(\{ fresh:true \}\)/, 'cadastro sem confirmação');
  assert.match(onb, /auAfterSession\(\{ fresh:ct==='signup' \}\)/, 'código: só o de cadastro é conta nova');
  assert.match(cloud, /cloudJustJoined=joined\[0\]\.team_id/, 'o auto-aceite guarda o time');
  assert.match(cloud, /function cloudJoinedMsg\(\)[\s\S]*Você entrou no time /);
});

// ---------------------------------------------------------------- 06 · reautenticação
test('06: "confirme que é você" tem ação: receber o código no e-mail (recuperação vale como reautenticação)', () => {
  assert.doesNotMatch(I.T('auth.err.reauth_needed'), /entre de novo/);
  assert.match(I.T('auth.err.reauth_needed'), /código/);
  assert.equal(I.T('auth.act.reauth'), 'receber o código no e-mail');
  assert.match(onb, /i\.key==='reauth_needed'\)\{[^\n]*au\.acts=\[\[T\('auth\.act\.reauth'\),\(\)=>auForgot\(em\)\]\]/);
});

// ---------------------------------------------------------------- 07 · assinatura com cobrança desligada
test('07: cobrança desligada = "Uso livre", sem "inativo" nem "ver planos"', () => {
  const off = AJ.ajBillingLine(null, 'u1', null, true);
  assert.equal(off.free, true); assert.equal(off.active, true); assert.equal(off.name, 'Uso livre');
  assert.doesNotMatch(off.sub, /Escolha um plano/);
  assert.equal(AJ.ajBillingLine({ status: 'canceled' }, 'u1', null, true).free, true, 'assinatura velha também é livre');
  assert.equal(AJ.ajBillingLine({ plan: 'enterprise', org: true }, 'u1', null, true).org, true, 'contrato da org continua aparecendo');
  assert.equal(AJ.ajBillingLine(null, 'u1').active, false, 'cobrança ligada: continua "sem assinatura"');
  const sec = cut(aj, 'async function ajRenderAssinatura(', 'const AJ_RENDER=');
  assert.match(sec, /ajBillingLine\(b, ajMe\(\), null, off\)/);
  assert.match(sec, /!L\.active&&!L\.free\?'<button type="button" class="btn primary sm" id="sbBillGo">ver planos/);
  assert.match(sec, /L\.free\?'<span class="ajst ok">livre<\/span>'/);
});

// ---------------------------------------------------------------- 08 · Primeiros passos › computador
const CH = [
  { name: 'Motor de IA (pelo menos um)', ok: false, fix: 'npm install -g @anthropic-ai/claude-code && claude\nnpm install -g @openai/codex && codex login' },
  { name: 'Claude Code (opcional)', ok: false, fix: 'npm install -g @anthropic-ai/claude-code && claude' },
  { name: 'Codex (opcional)', ok: false, fix: 'codex login' },
  { name: 'DeepSeek Harness (opcional · beta)', ok: false, fix: 'npm i -g @deepseek-ai/dsh' },
  { name: 'Gateway de IA (opcional)', ok: false, fix: 'configure em Ajustes' },
  { name: 'GitHub CLI (gh)', ok: false, fix: 'brew install gh && gh auth login' },
  { name: 'Túnel do preview (opcional)', ok: false, fix: 'brew install cloudflared' },
  { name: 'Git', ok: true, fix: '' },
  { name: 'Node.js (≥22.13)', ok: false, fix: 'brew install node' },
  { name: 'Node 2 (mesmo comando)', ok: false, fix: 'brew install node' },
];
test('08: o passo "Este computador" ignora as IAs (passo 2), não repete comando e marca opcional/recomendado', () => {
  assert.deepEqual(P.ppPcList(CH).map((c) => c.name), ['GitHub CLI (gh)', 'Túnel do preview (opcional)', 'Git', 'Node.js (≥22.13)', 'Node 2 (mesmo comando)']);
  const it = P.ppPcItems(CH, ENV.envKind);
  assert.deepEqual(it.map((x) => [x.name, x.kind]), [['Node.js (≥22.13)', 'req'], ['GitHub CLI (gh)', 'rec'], ['Túnel do preview', 'opt']]);
  assert.equal(it.filter((x) => /claude-code/.test(x.fix)).length, 0, 'npm install do Claude não aparece no passo 1');
  assert.deepEqual(P.ppPcItems(null), []);
  // só com o que é do computador ok, o passo 1 fica verde mesmo sem IA
  const okPc = CH.map((c) => (/motor de ia|claude|codex|deepseek|gateway/i.test(c.name) ? c : { ...c, ok: true }));
  assert.equal(P.ppPcList(okPc).every((c) => c.ok), true);
  assert.match(aj, /envSummary\(ppPcList\(envChecks\)\):null;\n  const d=typeof aiDefaults/, 'ppCtx.envOk conta só o computador');
  assert.match(aj, /const bad=ppPcItems\(envChecks, typeof envKind==='function'\?envKind:null\);/);
  assert.match(aj, /ENV_KIND_TAG\[x\.kind\]\?` <span class="ajtag">/);
});

// ---------------------------------------------------------------- 09 · sem Terminal
test('09: chave salva sem a IA instalada não parece sucesso; Primeiros passos explica o caminho sem saber Terminal', () => {
  assert.match(suaia, /\{ ok:false, text:'Chave salva, mas ainda falta um passo'/);
  assert.doesNotMatch(suaia, /'✓ chave salva'\+\(s&&s\.reason/);
  assert.match(aj, /Nunca usou o Terminal\?/);
  assert.match(aj, /IA da sua empresa<\/b> não precisa instalar nada/);
});

// ---------------------------------------------------------------- 10 · telas que não existem
test('10: nenhum texto aponta pra "Configurações → Sua IA/Gateway próprio" nem "Mais › Ambiente"', () => {
  const stale = /Configurações (→|›) (Sua IA|Gateway próprio|GitHub)|Mais › Ambiente|ficam em Gateway próprio/;
  for (const [n, s] of [['lib.rs', lib], ['ai_once.rs', once], ['ideia.rs', ideia], ['29-ia-picker', picker], ['11-ambiente-updater', amb]]) {
    assert.doesNotMatch(noComments(s), stale, n);
  }
  assert.match(once, /GATEWAY_CFG_MSG: &str = "Configure o gateway \(URL, chave e modelo\) em Ajustes › Motores e chaves › IA da sua empresa\."/);
  assert.match(lib, /fix: "configure a DEEPSEEK_API_KEY em Ajustes › Motores e chaves"/);
});

// ---------------------------------------------------------------- 11 · convite pra quem já tem conta / já está numa org
test('11: a mensagem do convite serve pra quem já tem conta, e "aceitar convite" existe também com organização', () => {
  const m = CLOUD.cloudInviteMsg('Loja', 'Lojinha', 'beto@x.dev', 'tok-9');
  assert.match(m, /Entre na sua conta \(ou crie uma, se ainda não tiver\) com o e-mail beto@x\.dev/);
  assert.doesNotMatch(m, /2\. Crie a sua conta/);
  assert.match(m, /Times e pessoas, clique em "aceitar convite"/);
  const times = cut(aj, 'async function ajRenderTimes(', 'let ajInvLast=');
  const inOrg = times.slice(times.indexOf('const me=ajMe(), teamId'));
  assert.match(inOrg, /id="ajInvCode">aceitar convite<\/button>/, 'com organização também');
  assert.match(inOrg, /bindClick\('ajInvCode'[\s\S]*ajAcceptInvite\(b, String\(tok\)\.trim\(\)\)/);
});

// ---------------------------------------------------------------- 12 · gerar convite sem a linha de volta
test('12: convite gravado sem linha de volta não quebra o botão nem mostra inglês', () => {
  assert.equal(P.ajInvRow([], 'a@x.dev'), null);
  assert.equal(P.ajInvRow([undefined, { email: 'A@x.dev', token: 't1' }], 'a@x.dev').token, 't1');
  assert.equal(P.ajInvRow([{ email: 'a@x.dev' }], 'a@x.dev'), null, 'sem token não serve');
  assert.equal(CLOUD.cloudInvitePending([undefined, null, { email: 'b@x.dev' }], 'b@x.dev', Date.now()), true, 'undefined na lista não lança');
  const m = CLOUD.cloudErrMsg(new TypeError("Cannot read properties of undefined (reading 'token')"), 'Não consegui gerar o convite');
  assert.equal(m, 'Não consegui gerar o convite: Não deu certo agora — tente de novo em instantes.');
  assert.match(CLOUD.cloudErrMsg(new Error('brand_new_code xyz')), /\(brand_new_code xyz\)/, 'código desconhecido do servidor continua pequeno');
  const conv = cut(aj, 'async function ajRenderConvites(', 'async function ajRenderRegras(');
  assert.doesNotMatch(conv, /rows\[0\]\.token/);
  assert.match(conv, /let iv=ajInvRow\(rows, mail\);[\s\S]*iv=ajInvRow\(d2&&d2\.invites, mail\)/);
});

// ---------------------------------------------------------------- 13 · Primeiros passos por cima
test('13: Primeiros passos só abre sozinho no boot se a pessoa ainda está na Central', () => {
  assert.equal(P.ppAutoOk('flow'), true); assert.equal(P.ppAutoOk(''), true);
  assert.equal(P.ppAutoOk('cfg'), false); assert.equal(P.ppAutoOk('t:123'), false);
  assert.match(aj, /setTimeout\(\(\)=>\{ if\(ppAutoOk\(typeof activeTab!=='undefined'\?activeTab:''\)\) ppMaybeStart\(\); \}, 3800\);/);
  assert.doesNotMatch(aj, /setTimeout\(ppMaybeStart, 3800\)/);
});

// ---------------------------------------------------------------- cosméticos 14–19
test('14: "crie uma nova" diz que é a senha', () => {
  assert.match(I.T('auth.err.invalid_credentials'), /crie uma senha nova/);
  assert.match(I.T('auth.err.user_exists'), /senha nova/);
});
test('15: limite de envio diz a hora em que libera', () => {
  const x = { status: 429, body: { error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 42 seconds.' } };
  assert.match(I.authErrPt(x), /42 s .*libera às \d\d:\d\d:\d\d/);
});
test('16: GitHub sem gh: "entrar com uma conta" e o comando pra instalar', () => {
  assert.match(amb, /'\+ entrar com outra conta':'\+ entrar com uma conta do GitHub'/);
  assert.match(amb, /instale o GitHub CLI no Terminal:/);
  assert.doesNotMatch(amb, /nenhuma conta logada no gh/);
});
test('17: sem jargão: "Motores e chaves", e nada de "alias"/"id fixo"; sem lista de modelos pra IA não instalada', () => {
  assert.doesNotMatch(aj, /Mesmo componente de Ajustes › IA e modelos/);
  assert.equal(SA.suaIaTagPt('alias · mais capaz'), 'mais capaz');
  assert.equal(SA.suaIaTagPt('id fixo · mais novo'), 'mais novo');
  assert.equal(SA.suaIaTagPt('id fixo'), '');
  assert.equal(SA.suaIaTagPt('auto'), '');
  assert.match(suaia, /\$\{s\.state==='install'\?'':`<select class="in suaia-model"/);
});
test('18: criar organização exige os dois nomes; permissão sem org não fala de "lead do time"', () => {
  assert.deepEqual(P.ajOrgFormErr('', 'Produto').field, 'sbOrgName');
  assert.deepEqual(P.ajOrgFormErr('Loja', '  ').field, 'sbTeamName');
  assert.equal(P.ajOrgFormErr('Loja', 'Produto'), null);
  assert.doesNotMatch(aj, /'Minha organização'|\|\|'Time 1'/);
  assert.match(aj, /function ajOrgCreateErr\(e\)[\s\S]*não tem permissão[\s\S]*Saia e entre de novo/);
});
test('19: "aceitar convite" fica ocupado (duplo clique não manda 2 pedidos)', () => {
  const f = cut(aj, 'async function ajAcceptInvite(', '\n}\n');
  assert.match(f, /if\(b && b\.disabled\) return;/);
  assert.match(f, /b\.disabled=true; b\.textContent='entrando…'/);
  assert.match(aj, /bindClick\('sbAccept', \(\)=>ajAcceptInvite\(/);
});

// ---------------------------------------------------------------- bloqueadores (base) não regridem
test('bloqueadores 01–03 continuam: sair limpa as chaves e a tela de entrada prende o foco', () => {
  assert.match(cloud, /function sbLogout\(\)[\s\S]*secretsForget\(\)/);
  assert.match(onb, /o\.style\.display='flex'; auInert\(true, document\.body, o\); auTrapWire\(o\);/);
});
