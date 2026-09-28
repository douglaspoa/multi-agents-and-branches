// Testes da tradução de erros do Supabase Auth (GoTrue) e das regras de senha — js/39-i18n-auth.js.
// Rodar: node --test   (na raiz do repo — acha todo *.test.mjs)  ou  node --test app/src/js/__tests__/auth-errors.test.mjs
// O arquivo é um script clássico (escopo global do app); aqui ele roda num contexto vm isolado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(here, '..', '39-i18n-auth.js'), 'utf8'), ctx, { filename: '39-i18n-auth.js' });
const A = vm.runInContext('({ T, I18N, i18nSetLocale, authErrInfo, authErrPt, authErrRef, authValidEmail, authPassStrength, authFmtWait, AUTH_PASS_MIN })', ctx);

const ENGLISH = /\b(the|invalid|error|password|should|email|rate|limit|expired|token|user|already|registered|please|failed|request)\b/i;
const res = (status, body) => ({ status, body });

// [descrição, entrada, chave esperada, campo esperado]
const CASES = [
  ['invalid_credentials (código)', res(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), 'invalid_credentials', 'pass'],
  ['invalid_credentials (legado)', res(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }), 'invalid_credentials', 'pass'],
  ['email_not_confirmed (código)', res(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' }), 'email_not_confirmed', ''],
  ['email_not_confirmed (legado)', res(400, { error: 'invalid_grant', error_description: 'Email not confirmed' }), 'email_not_confirmed', ''],
  ['user_already_exists (código)', res(422, { error_code: 'user_already_exists', msg: 'User already registered' }), 'user_exists', 'email'],
  ['email_exists (código)', res(422, { error_code: 'email_exists', msg: 'Email address already registered by another user' }), 'user_exists', 'email'],
  ['User already registered (legado)', res(400, { msg: 'User already registered' }), 'user_exists', 'email'],
  ['weak_password length', res(422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters.', weak_password: { reasons: ['length'] } }), 'weak_password_length', 'pass'],
  ['weak_password pwned', res(422, { error_code: 'weak_password', msg: 'Password is known to be weak and easy to guess, please choose a different one.', weak_password: { reasons: ['pwned'] } }), 'weak_password_pwned', 'pass'],
  ['weak_password characters', res(422, { error_code: 'weak_password', msg: 'Password should contain at least one character of each: abc', weak_password: { reasons: ['characters'] } }), 'weak_password_chars', 'pass'],
  ['weak password (legado)', res(422, { msg: 'Password should be at least 6 characters' }), 'weak_password_length', 'pass'],
  ['over_email_send_rate_limit hourly', res(429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }), 'rate_email', ''],
  ['over_email_send_rate_limit after N s', res(429, { error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 42 seconds.' }), 'rate_wait', ''],
  ['after N s (legado, sem código)', res(429, { msg: 'For security purposes, you can only request this after 17 seconds.' }), 'rate_wait', ''],
  ['over_request_rate_limit', res(429, { error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }), 'rate_request', ''],
  ['429 sem corpo', res(429, {}), 'rate_request', ''],
  ['otp_expired (código)', res(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' }), 'otp_invalid', 'code'],
  ['Token has expired (legado)', res(401, { error: 'invalid_grant', error_description: 'Token has expired or is invalid' }), 'otp_invalid', 'code'],
  ['otp signups disabled', res(422, { error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }), 'otp_no_user', 'email'],
  ['signup_disabled', res(422, { error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' }), 'signup_disabled', ''],
  ['email_address_invalid', res(400, { error_code: 'email_address_invalid', msg: 'Email address "a@b" is invalid' }), 'email_invalid', 'email'],
  ['validation_failed e-mail', res(400, { error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' }), 'email_invalid', 'email'],
  ['email_address_not_authorized', res(400, { error_code: 'email_address_not_authorized', msg: 'Email address "x" cannot be used as it is not authorized' }), 'email_not_authorized', ''],
  ['same_password', res(422, { error_code: 'same_password', msg: 'New password should be different from the old password.' }), 'same_password', 'pass'],
  ['refresh_token_not_found', res(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }), 'session_expired', ''],
  ['Invalid Refresh Token (legado)', res(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' }), 'session_expired', ''],
  ['provider disabled', res(400, { error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' }), 'provider_disabled', ''],
  ['erro ao mandar e-mail (500)', res(500, { error_code: 'unexpected_failure', msg: 'Error sending confirmation email' }), 'email_send_failed', ''],
  ['500 genérico', res(500, { msg: 'Internal Server Error' }), 'server', ''],
  ['502 sem JSON', res(502, {}), 'server', ''],
  ['código desconhecido', res(400, { error_code: 'brand_new_code', msg: 'Something brand new went wrong' }), 'unknown', ''],
  ['rede (Load failed)', Object.assign(new TypeError('Load failed'), {}), 'network', ''],
  ['rede (Failed to fetch)', new TypeError('Failed to fetch'), 'network', ''],
  ['rede marcada pelo sbAuth', Object.assign(new Error('sem conexão com x'), { network: true }), 'network', ''],
  ['timeout (AbortError)', Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }), 'timeout', ''],
  ['string solta', 'Invalid login credentials', 'invalid_credentials', 'pass'],
  ['corpo cru do GoTrue', { error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 'otp_invalid', 'code'],
  ['null', null, 'unknown', ''],
];

for (const [name, input, key, field] of CASES) {
  test('erro → chave: ' + name, () => {
    const i = A.authErrInfo(input);
    assert.equal(i.key, key);
    assert.equal(i.field, field);
    const msg = A.authErrPt(input);
    assert.ok(msg && !msg.startsWith('auth.'), 'tem texto no dicionário: ' + msg);
    assert.doesNotMatch(msg, ENGLISH, 'sem inglês: ' + msg);
    assert.doesNotMatch(msg, /\{\w+\}/, 'sem placeholder sobrando: ' + msg);
  });
}

test('traduzir o info de novo dá a mesma mensagem (a tela passa o info adiante)', () => {
  for (const [, input] of CASES) {
    const i = A.authErrInfo(input);
    assert.equal(A.authErrPt(i), A.authErrPt(input));
    assert.equal(A.authErrInfo(i), i);
  }
});

test('rate_wait carrega os segundos na mensagem', () => {
  const x = res(429, { error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 42 seconds.' });
  assert.equal(A.authErrInfo(x).wait, 42);
  assert.match(A.authErrPt(x), /42 s/);
});

test('senha curta do servidor respeita o mínimo do app (8)', () => {
  const x = res(422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters.', weak_password: { reasons: ['length'] } });
  assert.match(A.authErrPt(x), /8 caracteres/);
});

test('desconhecido: mensagem genérica + referência com código e HTTP', () => {
  const x = res(400, { error_code: 'brand_new_code', msg: 'Something brand new went wrong' });
  assert.equal(A.authErrPt(x), A.T('auth.err.unknown'));
  assert.equal(A.authErrRef(x), 'código: brand_new_code · HTTP 400');
  assert.equal(A.authErrRef(res(400, { error_code: 'invalid_credentials' })), '', 'erro conhecido não mostra código');
});

test('Error já traduzido pelo sbAuth mantém a info', () => {
  const e = new Error('x'); e.info = { key: 'otp_invalid', field: 'code', code: 'otp_expired', status: 403, wait: null, min: 8 };
  assert.equal(A.authErrInfo(e).key, 'otp_invalid');
});

test('toda chave auth.err.* do pt-BR é texto sem inglês', () => {
  for (const [k, v] of Object.entries(A.I18N['pt-BR'])) {
    if (!k.startsWith('auth.err.')) continue;
    assert.doesNotMatch(v.replace(/\{\w+\}/g, ''), ENGLISH, k);
  }
});

test('T: variáveis, fallback pro pt-BR e idioma novo', () => {
  assert.equal(A.T('auth.v.pass_min', { min: 8 }), 'A senha precisa de pelo menos 8 caracteres.');
  assert.equal(A.T('chave.que.nao.existe'), 'chave.que.nao.existe');
  A.I18N['en'] = { 'auth.err.invalid_credentials': 'Wrong e-mail or password.' };
  assert.equal(A.i18nSetLocale('en'), 'en');
  assert.equal(A.T('auth.err.invalid_credentials'), 'Wrong e-mail or password.');
  assert.equal(A.T('auth.err.otp_invalid'), A.I18N['pt-BR']['auth.err.otp_invalid'], 'chave que falta cai no pt-BR');
  assert.equal(A.i18nSetLocale('xx'), 'en', 'idioma inexistente não troca');
  A.i18nSetLocale('pt-BR');
});

test('e-mail: formato', () => {
  for (const ok of ['voce@empresa.com', ' a.b+c@sub.dominio.com.br ', 'x@y.io']) assert.ok(A.authValidEmail(ok), ok);
  for (const bad of ['', 'douglas@', 'douglas@empresa', 'a b@c.com', '@c.com', 'a@b.c', 'a@@b.com']) assert.ok(!A.authValidEmail(bad), bad);
});

test('força da senha coerente com o mínimo', () => {
  assert.equal(A.AUTH_PASS_MIN, 8);
  assert.equal(A.authPassStrength('').score, 0);
  const short = A.authPassStrength('Ab1!xyz'); assert.equal(short.ok, false); assert.equal(short.score, 1);
  assert.equal(A.authPassStrength('aaaaaaaaaaaa').score, 1, 'repetição não passa de fraca');
  const ok = A.authPassStrength('abcdefgh'); assert.equal(ok.ok, true); assert.equal(ok.score, 2);
  assert.equal(A.authPassStrength('abcdefg1').score, 3);
  assert.equal(A.authPassStrength('Estrela-Cadente-2026').score, 4);
  assert.deepEqual({ ...A.authPassStrength('abcdefg1').rules }, { min: true, mix: true, long: false });
});

test('tempo de espera m:ss', () => {
  assert.equal(A.authFmtWait(0), '0:00');
  assert.equal(A.authFmtWait(42), '0:42');
  assert.equal(A.authFmtWait(75), '1:15');
  assert.equal(A.authFmtWait(600), '10:00');
});
