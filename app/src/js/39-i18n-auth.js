// Starfork — 39-i18n-auth: textos da conta (criar conta · entrar · código · nova senha) por idioma
// e a tradução ÚNICA dos erros do Supabase Auth (GoTrue) — nenhum texto em inglês chega na tela.
// Puro (sem DOM, sem fetch): testado em js/__tests__/auth-errors.test.mjs (node --test).
// Outro idioma: I18N['en']={ 'auth.err.invalid_credentials':'…', … } e i18nSetLocale('en');
// chave que faltar no idioma cai no pt-BR (nunca some texto).
const I18N={ 'pt-BR':{
  // ---- erros do servidor (GoTrue) — sempre com o próximo passo ----
  'auth.err.invalid_credentials':'E-mail ou senha incorretos. Confira a senha (Caps Lock?) ou use “esqueci a senha”.',
  'auth.err.email_not_confirmed':'Seu e-mail ainda não foi confirmado. Digite o código de 6 dígitos que enviamos no cadastro — ou peça um novo.',
  'auth.err.user_exists':'Já existe uma conta com esse e-mail. Entre com a sua senha ou use “esqueci a senha”.',
  'auth.err.weak_password':'Senha fraca demais. Use {min}+ caracteres misturando letras e números.',
  'auth.err.weak_password_length':'Senha curta demais: use pelo menos {min} caracteres.',
  'auth.err.weak_password_pwned':'Essa senha aparece em vazamentos conhecidos e é fácil de adivinhar. Escolha outra — uma frase com números funciona bem.',
  'auth.err.weak_password_chars':'A senha precisa misturar letras maiúsculas, minúsculas, números e símbolos.',
  'auth.err.rate_wait':'Por segurança, espere {s} s antes de pedir outro código.',
  'auth.err.rate_email':'Limite de e-mails atingido por agora. Espere alguns minutos e tente de novo — o último código enviado continua valendo por 10 minutos.',
  'auth.err.rate_request':'Muitas tentativas seguidas. Espere um minuto e tente de novo.',
  'auth.err.otp_invalid':'Código inválido ou expirado. Use o código do e-mail mais recente (vale 10 minutos) ou peça um novo.',
  'auth.err.otp_no_user':'Não achamos conta com esse e-mail. Confira o endereço ou crie uma conta.',
  'auth.err.otp_disabled':'Entrar por código está desativado no momento. Entre com e-mail e senha.',
  'auth.err.signup_disabled':'Novos cadastros estão fechados no momento. Fale com o administrador do seu time.',
  'auth.err.email_invalid':'Esse e-mail não parece válido. Confira se está completo (ex.: voce@empresa.com).',
  'auth.err.email_not_authorized':'Não conseguimos enviar e-mail para esse endereço agora. Tente de novo mais tarde ou fale com o suporte do Starfork.',
  'auth.err.email_send_failed':'Não conseguimos enviar o e-mail agora. Tente de novo em alguns minutos.',
  'auth.err.same_password':'A nova senha precisa ser diferente da atual.',
  'auth.err.session_expired':'Sua sessão expirou. Entre de novo para continuar.',
  'auth.err.reauth_needed':'Por segurança, entre de novo antes de trocar a senha.',
  'auth.err.user_not_found':'Não achamos essa conta. Confira o e-mail ou crie uma conta.',
  'auth.err.user_banned':'Esta conta está bloqueada. Fale com o administrador do seu time.',
  'auth.err.email_login_disabled':'Entrar com e-mail está desativado no momento. Fale com o suporte do Starfork.',
  'auth.err.provider_disabled':'Entrar com {provider} ainda não está disponível. Use e-mail e senha.',
  'auth.err.oauth_failed':'O login pelo navegador não terminou. Tente de novo.',
  'auth.err.captcha':'A verificação de segurança falhou. Tente de novo.',
  'auth.err.timeout':'O servidor demorou demais para responder. Confira sua conexão e tente de novo.',
  'auth.err.server':'O servidor de contas está com problema agora. Tente de novo em alguns minutos.',
  'auth.err.network':'Sem conexão com o servidor de contas. Confira sua internet ou VPN e tente de novo.',
  'auth.err.missing_fields':'Preencha o e-mail e a senha.',
  'auth.err.invalid_request':'Não deu certo com esses dados. Confira os campos e tente de novo.',
  'auth.err.unknown':'Algo deu errado. Tente de novo em instantes.',
  'auth.err.ref':'código: {code}',
  // ---- validação local (antes de ir ao servidor) ----
  'auth.v.email_required':'Digite o seu e-mail.',
  'auth.v.email_invalid':'Esse e-mail não parece válido — confira se está completo (ex.: voce@empresa.com).',
  'auth.v.email_for_reset':'Digite o seu e-mail acima — o código de recuperação vai para ele.',
  'auth.v.email_for_code':'Digite o seu e-mail acima — o código de acesso vai para ele.',
  'auth.v.pass_required':'Digite a sua senha.',
  'auth.v.pass_min':'A senha precisa de pelo menos {min} caracteres.',
  'auth.v.pass_mismatch':'As senhas não conferem — digite a mesma senha nos dois campos.',
  'auth.v.code_incomplete':'Digite os 6 dígitos do código.',
  // ---- regras e força da senha ----
  'auth.pw.rule_min':'{min}+ caracteres',
  'auth.pw.rule_mix':'letras e números',
  'auth.pw.rule_long':'12+ deixa mais forte',
  'auth.pw.s0':'força da senha',
  'auth.pw.s1':'fraca',
  'auth.pw.s2':'razoável',
  'auth.pw.s3':'boa',
  'auth.pw.s4':'forte',
  'auth.pw.show':'mostrar',
  'auth.pw.hide':'ocultar',
  'auth.pw.show_a11y':'mostrar a senha',
  'auth.pw.hide_a11y':'ocultar a senha',
  'auth.pw.caps':'Caps Lock ligado',
  // ---- telas ----
  'auth.top.signup':'criar conta', 'auth.top.login':'entrar', 'auth.top.confirm':'confirmar e-mail', 'auth.top.newpass':'nova senha',
  'auth.top.plans':'planos', 'auth.top.pay':'pagamento', 'auth.top.ready':'bem-vindo',
  'auth.logout':'sair da conta', 'auth.back':'← voltar',
  'auth.signup.title':'Criar conta',
  'auth.signup.sub':'Use o e-mail do trabalho — é assim que a gente liga você ao time certo.',
  'auth.signup.name':'Nome', 'auth.signup.name_ph':'como o time te chama (opcional)',
  'auth.signup.email':'E-mail de trabalho', 'auth.signup.pass':'Senha', 'auth.signup.pass_ph':'mínimo {min} caracteres',
  'auth.signup.go':'Criar conta', 'auth.signup.busy':'criando…', 'auth.signup.have':'já tenho conta',
  'auth.signup.legal':'Ao continuar você aceita os <a data-ext="https://starfork.com.br/termos">termos</a> e a <a data-ext="https://starfork.com.br/privacidade">privacidade</a>.',
  'auth.login.eyebrow':'bem-vindo de volta', 'auth.login.title':'Entrar',
  'auth.login.sub':'Entre pra ver o que rodou enquanto você esteve fora.',
  'auth.login.email':'E-mail', 'auth.login.pass':'Senha', 'auth.login.pass_ph':'sua senha', 'auth.login.forgot':'esqueci a senha',
  'auth.login.go':'Entrar', 'auth.login.busy':'entrando…', 'auth.login.code':'Entrar com código por e-mail',
  'auth.login.no_account':'Ainda não tem conta?', 'auth.login.create':'criar agora',
  'auth.oauth.opening':'Abrindo o {provider} no navegador — conclua o login lá e volte pra cá.',
  'auth.confirm.title_signup':'Confirme o e-mail', 'auth.confirm.title_recovery':'Código de recuperação', 'auth.confirm.title_magic':'Código de acesso',
  'auth.confirm.sent':'Mandamos um código de 6 dígitos para',
  'auth.confirm.change':'trocar e-mail',
  'auth.confirm.group':'código de 6 dígitos',
  'auth.confirm.digit':'dígito {n} de 6',
  'auth.confirm.valid_until':'O código vale 10 minutos (até {hh}). Confira também o spam.',
  'auth.confirm.valid':'O código vale 10 minutos. Confira também o spam.',
  'auth.confirm.go':'Confirmar', 'auth.confirm.busy':'confirmando…',
  'auth.confirm.resend_in':'reenviar em {t}', 'auth.confirm.resend':'reenviar código', 'auth.confirm.not_arrived':'não chegou?',
  'auth.confirm.resent':'Enviamos um código novo para {email}. Use sempre o do e-mail mais recente.',
  'auth.confirm.foot_signup':'Confirmou pelo link do e-mail? <a data-act="toLogin">entrar com a senha</a>.',
  'auth.confirm.foot_recovery':'Lembrou a senha? <a data-act="toLogin">voltar ao login</a>.',
  'auth.confirm.foot_magic':'Prefere a senha? <a data-act="toLogin">voltar ao login</a>.',
  'auth.confirm.no_session':'O código foi aceito, mas o servidor não abriu a sessão. Entre com a sua senha.',
  'auth.confirm.have_code':'já tenho um código',
  'auth.newpass.eyebrow':'segurança', 'auth.newpass.title':'Definir nova senha',
  'auth.newpass.sub':'Escolha a senha nova — ela vale em todos os seus aparelhos.',
  'auth.newpass.nosess':'O código de recuperação expirou antes de você salvar a senha. Peça um código novo — leva um minuto.',
  'auth.newpass.again':'pedir código novo',
  'auth.newpass.pass':'Nova senha', 'auth.newpass.pass2':'Repita a senha', 'auth.newpass.pass2_ph':'igual à de cima',
  'auth.newpass.go':'Salvar senha', 'auth.newpass.busy':'salvando…', 'auth.newpass.back':'voltar ao login',
  'auth.newpass.done':'Senha alterada ✓',
  'auth.act.cancel':'cancelar',
  'auth.act.login':'entrar', 'auth.act.forgot':'esqueci a senha', 'auth.act.signup':'criar conta', 'auth.act.resend':'reenviar código',
  'auth.expired':'Sua sessão expirou — entre de novo pra continuar de onde parou.',
  'auth.cloud.nosess':'Você não está conectado. Entre (ou crie a sua conta) pra ver organização, times e convites.',
  'auth.cloud.open':'Entrar ou criar conta',
}};
let I18N_LOCALE='pt-BR';
function i18nSetLocale(l){ if(I18N[l]) I18N_LOCALE=l; return I18N_LOCALE; }
// T('chave', {var}) — texto no idioma atual; cai no pt-BR e, por último, na própria chave
function T(key, vars){
  const d=I18N[I18N_LOCALE]||{}, base=I18N['pt-BR'];
  let s=Object.prototype.hasOwnProperty.call(d,key)?d[key]:(Object.prototype.hasOwnProperty.call(base,key)?base[key]:key);
  if(vars) s=String(s).replace(/\{(\w+)\}/g,(m,k)=>vars[k]!=null?String(vars[k]):m);
  return s;
}
const AUTH_PASS_MIN=8;           // mais rígido que o mínimo do Supabase (6) — a regra mostrada é esta
const AUTH_CODE_TTL_S=600;       // mailer_otp_exp do projeto (10 min)
const AUTH_RESEND_S=60;          // intervalo mínimo do GoTrue entre e-mails pro mesmo endereço
// códigos (error_code) do GoTrue → chave de mensagem
const AUTH_CODE_MAP={
  invalid_credentials:'invalid_credentials', email_not_confirmed:'email_not_confirmed',
  user_already_exists:'user_exists', email_exists:'user_exists', identity_already_exists:'user_exists',
  weak_password:'weak_password', same_password:'same_password',
  over_request_rate_limit:'rate_request', over_sms_send_rate_limit:'rate_request',
  otp_expired:'otp_invalid', otp_disabled:'otp_disabled', signup_disabled:'signup_disabled',
  email_address_invalid:'email_invalid', email_address_not_authorized:'email_not_authorized',
  refresh_token_not_found:'session_expired', refresh_token_already_used:'session_expired', session_not_found:'session_expired',
  session_expired:'session_expired', bad_jwt:'session_expired', no_authorization:'session_expired',
  reauthentication_needed:'reauth_needed', reauthentication_not_valid:'reauth_needed',
  user_not_found:'user_not_found', user_banned:'user_banned', email_provider_disabled:'email_login_disabled',
  provider_disabled:'provider_disabled', oauth_provider_not_supported:'provider_disabled',
  flow_state_expired:'oauth_failed', flow_state_not_found:'oauth_failed', bad_code_verifier:'oauth_failed', bad_oauth_state:'oauth_failed', bad_oauth_callback:'oauth_failed',
  captcha_failed:'captcha', request_timeout:'timeout', validation_failed:'invalid_request', unexpected_failure:'server',
};
// textos antigos do GoTrue (sem error_code) → chave. Ordem importa (o 1º que casar vence).
const AUTH_TEXT_MAP=[
  [/invalid login credentials|invalid_grant.*credentials/i,'invalid_credentials'],
  [/email not confirmed/i,'email_not_confirmed'],
  [/already (been )?registered|already exists|user_already_exists|email_exists/i,'user_exists'],
  [/known to be weak|pwned|easy to guess/i,'weak_password_pwned'],
  [/password should be at least|password.*(too short|at least \d+)/i,'weak_password_length'],
  [/password should contain|password.*characters? (of|from) each/i,'weak_password_chars'],
  [/token has expired|otp.*(expired|invalid)|invalid (otp|token)|expired or is invalid/i,'otp_invalid'],
  [/only request this after|request this (once )?every/i,'rate_wait'],
  [/email rate limit|over_email_send_rate_limit/i,'rate_email'],
  [/rate limit|too many requests/i,'rate_request'],
  [/signups? not allowed for otp/i,'otp_no_user'],
  [/signups? not allowed|signup(s)? (is |are )?disabled/i,'signup_disabled'],
  [/different from the old password/i,'same_password'],
  [/unable to validate email|email address .* is invalid|invalid email|invalid format/i,'email_invalid'],
  [/not authorized/i,'email_not_authorized'],
  [/error sending .*e?-?mail|sending (confirmation|recovery|magic|invite)/i,'email_send_failed'],
  [/invalid refresh token|refresh token (not found|already used)|jwt (is )?expired|session (not found|expired|missing)/i,'session_expired'],
  [/unsupported provider|provider is not enabled|provider.*disabled/i,'provider_disabled'],
  [/reauthenticat/i,'reauth_needed'],
  [/user not found/i,'user_not_found'],
  [/banned/i,'user_banned'],
  [/email logins are disabled/i,'email_login_disabled'],
  [/anonymous sign-?ins are disabled|missing (email|password)/i,'missing_fields'],
  [/captcha/i,'captcha'],
  [/(flow state|code verifier|oauth state)/i,'oauth_failed'],
];
// campo da tela onde o erro aparece (ao lado do campo, não no topo)
const AUTH_FIELD={ invalid_credentials:'pass', user_exists:'email', email_invalid:'email', otp_no_user:'email', user_not_found:'email',
  weak_password:'pass', weak_password_length:'pass', weak_password_pwned:'pass', weak_password_chars:'pass', same_password:'pass', otp_invalid:'code', missing_fields:'pass' };
// Entende QUALQUER forma de erro de auth: Error vindo do sbAuth (com .status/.body), { status, body }, resposta
// crua do GoTrue ({ error_code, msg } ou legado { error, error_description }), TypeError de rede ou string.
// → { key, code, status, field, wait, min, text }
function authErrInfo(x){
  if(x && x.info && x.info.key) return x.info;
  if(x && typeof x.key==='string' && 'field' in x && 'wait' in x) return x; // já é um info
  const out={ key:'unknown', code:'', status:0, field:'', wait:null, min:AUTH_PASS_MIN, text:'' };
  if(x==null) return out;
  if(typeof x==='string') x={ message:x };
  const body=(x.body && typeof x.body==='object') ? x.body : ((x.error_code||x.msg||x.error_description) ? x : null);
  out.status=Number(x.status||(body&&typeof body.code==='number'?body.code:0))||0;
  const code=String((body&&(body.error_code||(typeof body.code==='string'?body.code:'')))||x.code||'').trim();
  out.code=code;
  const text=String((body&&(body.msg||body.error_description||body.message||body.error))||x.message||'');
  out.text=text.slice(0,300);
  // rede: fetch rejeitado (Failed to fetch / Load failed / NetworkError) ou marcado pelo sbAuth
  if(x.network || code==='network' || (x.name==='TypeError' && /fetch|load failed|network/i.test(text)) || /^(failed to fetch|load failed|networkerror)/i.test(text)){ out.key='network'; out.code='network'; return out; }
  if(code==='timeout' || x.name==='AbortError'){ out.key='timeout'; out.code=out.code||'timeout'; return out; }
  let key=AUTH_CODE_MAP[code]||'';
  // códigos genéricos: o texto diz mais (ex.: validation_failed "Unsupported provider", otp_disabled "Signups not allowed for otp")
  if(!key || ['invalid_request','server','otp_disabled','weak_password'].includes(key)){
    const hit=AUTH_TEXT_MAP.find(([re])=>re.test(text)); const k=hit&&hit[1];
    if(k){
      if(!key || key==='invalid_request' || key==='server') key=k;
      else if(key==='otp_disabled' && k==='otp_no_user') key=k;
      else if(key==='weak_password' && k.startsWith('weak_password')) key=k;
    }
  }
  if(code==='over_email_send_rate_limit') key=/after \d+ seconds?/i.test(text)?'rate_wait':'rate_email';
  if(code==='weak_password' && body && body.weak_password && Array.isArray(body.weak_password.reasons)){
    const r=body.weak_password.reasons; key=r.includes('pwned')?'weak_password_pwned':r.includes('characters')?'weak_password_chars':r.includes('length')?'weak_password_length':key;
  }
  if(!key){ if(out.status===429) key='rate_request'; else if(out.status>=500) key='server'; else key='unknown'; }
  const w=text.match(/after (\d+) seconds?/i); if(w) out.wait=Number(w[1]);
  if(key==='rate_wait' && out.wait==null) out.wait=AUTH_RESEND_S;
  const mn=text.match(/at least (\d+) characters?/i); if(mn) out.min=Math.max(Number(mn[1]), AUTH_PASS_MIN);
  out.key=key; out.field=AUTH_FIELD[key]||'';
  return out;
}
// mensagem pronta (idioma atual). Desconhecido → genérico; a UI mostra o código em letra pequena (authErrRef).
function authErrPt(x, vars){
  const i=authErrInfo(x);
  return T('auth.err.'+i.key, Object.assign({ s:i.wait, min:i.min, provider:'' }, vars||{}));
}
// "código: brand_new_code · HTTP 400" — só pra erro que a tela não sabe explicar (suporte consegue rastrear)
function authErrRef(x){
  const i=authErrInfo(x); if(!['unknown','server','invalid_request','timeout'].includes(i.key)) return '';
  const c=[i.code, i.status?('HTTP '+i.status):''].filter(Boolean).join(' · ');
  return c ? T('auth.err.ref',{ code:c }) : '';
}
function authValidEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(String(v||'').trim()); }
// força da senha (0–4) coerente com a regra mínima: abaixo do mínimo nunca passa de "fraca"
function authPassStrength(p){
  p=String(p||''); const len=p.length;
  const hasL=/[a-zA-Zà-úÀ-Ú]/.test(p), hasD=/\d/.test(p), hasU=/[A-ZÀ-Ú]/.test(p)&&/[a-zà-ú]/.test(p), hasS=/[^a-zA-Z0-9à-úÀ-Ú]/.test(p);
  const rules={ min:len>=AUTH_PASS_MIN, mix:hasL&&hasD, long:len>=12 };
  let score=0;
  if(len) score=1;
  if(rules.min){ score=2; if(rules.mix) score++; if((hasU||hasS) && rules.long) score++; else if(hasU&&hasS) score++; }
  if(rules.min && /^(.)\1+$/.test(p)) score=1;
  score=Math.min(4,score);
  return { score, ok:rules.min, rules, label:T('auth.pw.s'+score) };
}
// 75 → "1:15"
function authFmtWait(sec){ sec=Math.max(0,Math.ceil(Number(sec)||0)); return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0'); }
