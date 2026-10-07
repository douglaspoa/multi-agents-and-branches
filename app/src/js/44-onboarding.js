// Starfork — 44-onboarding: entrada e assinatura (design "onboarding-planos").
// Telas: criar conta · entrar · confirmar e-mail (código de 6 dígitos) · nova senha · planos · pagamento · pronto.
// Tudo fala com o Supabase (GoTrue) e com a function stripe-checkout que já existem.
// Substitui o gate de login do cloudOverlay e o payOverlay (as duas funções são reapontadas no fim).
// Textos e erros vêm do 39-i18n-auth (T, authErrInfo/authErrPt) — nada de inglês do servidor na tela.
// Regras da tela de conta: erro aparece AO LADO do campo (aria-invalid + aria-describedby), o que foi digitado
// não some ao errar, Enter envia (é um <form>), botão ocupado não envia 2x, foco vai pro campo com problema.
const AU_STEPS_ORDER=['signup','confirm','plans','pay','ready'];
// pra onde o LINK do e-mail leva (alternativa ao código): páginas do site
const AU_SITE='https://starfork.com.br'; // era constellation-ai-v1.lovable.app (domínio antigo — bug do inventário)
const auRedir=path=>'?redirect_to='+encodeURIComponent(AU_SITE+path);
// Esqueci a senha: pede o CÓDIGO de 6 dígitos e abre a tela pra digitá-lo. O link do e-mail não entra no fluxo —
// a página /redefinir-senha do site não existe e clicar num link consumiria o código.
async function auRecover(email){ await sbAuth('recover'+auRedir('/redefinir-senha'),{ email }); lsSet('sb:email',email); au.email=email; auShow('confirm',{ confirmType:'recovery', resendAt:Date.now()+AUTH_RESEND_S*1000, codeSentAt:Date.now() }); }
let au={ step:'login', email:lsGet('sb:email')||'', name:'', confirmType:'signup', msg:'', msgKind:'', msgRef:'', acts:null, err:{}, focus:'', showPass:false, busy:false, resendAt:0, codeSentAt:0, oauthGen:0, plan:{ key:'team', interval:'month', seats:5 }, fromGate:false, waiting:false, backTo:null };
let _auTimer=null;
function auEl(){ return $id('authOverlay'); }
function auShow(step, opts){
  if(typeof SF_PANE!=='undefined' && SF_PANE) return; // painel: conta/cobrança/onboarding são da janela principal
  au.msg=''; au.msgKind=''; au.msgRef=''; au.acts=null; au.err={}; au.focus=''; au.busy=false;
  Object.assign(au, opts||{}); if(step) au.step=step;
  const o=auEl(); if(!o) return; const R=$id('auRight'); if(R) R.dataset.step=''; // tela nova: não herda o que foi digitado noutra
  o.style.display='flex'; auInert(true, document.body, o); auTrapWire(o); auRender();
}
// @puro-au-foco-inicio — bloqueador 03 da mesa-bugs-2: com a tela de entrada aberta, o app por trás fica inerte
// (fora do Tab e do leitor de tela) e o Tab dá a volta DENTRO da tela. Só desfaz o que ela mesma marcou.
function auInert(on, body, overlay){
  for(const el of Array.from((body&&body.children)||[])){
    if(el===overlay || auInertSkip(el)) continue;
    if(on){ if(el.hasAttribute('inert')) continue; el.setAttribute('inert',''); el.setAttribute('aria-hidden','true'); el.setAttribute('data-au-inert','1'); }
    else if(el.getAttribute('data-au-inert')==='1'){ el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); el.removeAttribute('data-au-inert'); }
  }
}
// avisos (toast e regiões aria-live) continuam valendo por cima da tela de entrada
function auInertSkip(el){
  return ['SCRIPT','STYLE','LINK','TEMPLATE'].includes(el.tagName) || ['a11yLiveStatus','a11yLiveAlert','appToast'].includes(el.id)
    || /(^|\s)a11y-live(\s|$)/.test(typeof el.className==='string'?el.className:'');
}
// Tab no último item volta pro primeiro (Shift+Tab no primeiro vai pro último); foco fora da tela volta pra dentro
function auTrapNext(list, cur, back){
  if(!list.length) return null;
  const i=list.indexOf(cur);
  if(i<0) return back?list[list.length-1]:list[0];
  if(back && i===0) return list[list.length-1];
  if(!back && i===list.length-1) return list[0];
  return null; // meio da lista: o navegador segue normal
}
// abrir abas/planejador por trás da tela de entrada SEM sessão não pode (atalho, Enter, chamada solta)
function auBlocksApp(open, hasSess){ return !!open && !hasSess; }
// @puro-au-foco-fim
function auTrapWire(o){
  if(o.__auTrap) return; o.__auTrap=true;
  const sel='a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  document.addEventListener('keydown', e=>{
    if(e.key!=='Tab' || !auOpen()) return;
    const act=document.activeElement, dlg=act && act.closest && act.closest('[role=dialog]');
    if(dlg && !o.contains(dlg) && !dlg.closest('[inert]')) return; // janela viva fora da tela de entrada (folha de confirmação): o trap dela manda
    const list=Array.from(o.querySelectorAll(sel)).filter(el=>el.offsetParent!==null || el===document.activeElement);
    const nx=auTrapNext(list, document.activeElement, e.shiftKey);
    if(nx){ e.preventDefault(); nx.focus(); }
  }, true);
}
function auHide(){ const o=auEl(); if(o){ o.style.display='none'; auInert(false, document.body, o); } au.waiting=false; if(_auTimer){ clearInterval(_auTimer); _auTimer=null; }
  // 1º uso: o tour de boas-vindas só começa DEPOIS da entrada (antes ele abria por baixo do gate de login)
  setTimeout(()=>{ if(window.obMaybeStart) window.obMaybeStart(); }, 350); }
function auOpen(){ return !!auEl() && auEl().style.display!=='none'; }
// ---- copy da coluna esquerda por tela (do design) ----
// Só promessas VERDADEIRAS aqui (antes: "a senha nunca sai da sua máquina", "Companion mobile pareado",
// "teste em andamento", "o lead aprova" — nada disso era verdade na hora em que a tela aparecia).
const AU_LEFT={
  signup:{ h:'Agentes de IA trabalhando pra você', s:'Você conta o que precisa em português normal; os agentes de IA fazem, cada um numa cópia separada do projeto. Nada some, nada colide.', b:[['g','Descreva o que quer — a IA monta o plano com você'],['c','Vários agentes em paralelo, sem um atrapalhar o outro'],['p','Você revisa e aprova antes de qualquer coisa entrar']], f:'os agentes rodam no seu computador' },
  login:{ h:'Bem-vindo de volta', s:'Suas demandas continuam aqui — entre pra ver o que rodou enquanto você esteve fora.', b:[['g','O time vê o andamento de cada tarefa'],['c','Custo por tarefa, sempre à vista'],['p','Entregas prontas pra revisar num clique']], f:'os agentes rodam no seu computador' },
  confirm:{ h:'Só falta confirmar o e-mail', s:'O código confirma que o e-mail é seu. Se alguém do seu time te convidou, você já entra no time certo.', b:[['g','O link do e-mail também funciona'],['c','Convite pro seu e-mail entra sozinho'],['p','Dá pra trocar de time depois']], f:'o código vale 10 minutos' },
  newpass:{ h:'Defina a senha nova', s:'Defina a senha nova — suas demandas, times e chaves continuam onde estavam.', b:[['g','8+ caracteres, letras e números'],['c','Vale em todos os seus computadores'],['p','Nada do que você fez se perde']], f:'conexão protegida · a senha vai criptografada' },
  ready:{ h:'Conta ativa — agora é com você', s:'Conte o que você quer fazer e a IA monta o plano. Dá pra abrir uma pasta que já existe ou começar do zero.', b:[['g','Escreva o pedido em português normal'],['c','A IA monta o plano e pergunta o que faltar'],['p','Você aprova e acompanha ao vivo']], f:'conta ativa neste computador' },
  ready_repo:{ h:'Tudo pronto — pode começar', s:'Sua conta está ativa e o projeto já está aberto. Escreva a primeira demanda.', b:[['g','Escreva o pedido em português normal'],['c','A IA monta o plano e pergunta o que faltar'],['p','Você aprova e acompanha ao vivo']], f:'conta ativa neste computador' },
};
const AU_DOT={ g:'var(--accent)', c:'var(--cyan)', p:'var(--chart-7)' };
function auLeftHtml(step){
  if(step==='ready' && typeof state!=='undefined' && state && state.repo) step='ready_repo';
  const L=AU_LEFT[step]||AU_LEFT.signup;
  return `<div class="au-lin">
    <div class="au-brand"><span class="au-logo">${(typeof IC!=='undefined'&&IC.starfork)||''}</span><span class="au-brandt">Starfork</span></div>
    <h1 class="au-h1">${esc(L.h)}</h1><p class="au-sub">${esc(L.s)}</p>
    <div class="au-bul">${L.b.map(([c,t])=>`<div class="au-b"><i style="background:${AU_DOT[c]}"></i>${esc(t)}</div>`).join('')}</div>
    <div class="au-foot"><i></i>${esc(L.f)}</div></div>`;
}
// cobrança desligada = não há tela de planos: são 2 passos (antes dizia "passo 1 de 3" e o 3º nunca vinha)
function auProgress(n){ const tot=(typeof billingOn!=='undefined' && billingOn)||au.step==='plans'||au.step==='pay'?3:2; n=Math.min(n,tot);
  return `<div class="au-prog">${Array.from({ length:tot },(_,k)=>k+1).map(i=>`<i class="${i<=n?'on':''}"></i>`).join('')}<span>passo ${n} de ${tot}</span></div>`; }
// ações do erro ("entrar · esqueci a senha") viram links clicáveis por teclado
function auActsHtml(){ return (au.acts||[]).length?`<span class="au-acts">${au.acts.map((a,i)=>`<a data-auact="${i}">${esc(a[0])}</a>`).join('<span aria-hidden="true"> · </span>')}</span>`:''; }
// caixa geral (erros sem campo: rede, limite, servidor) — sempre escapada; fica logo acima dos botões
function auMsg(){
  if(!au.msg) return '<div class="au-msgslot" id="auMsg" aria-live="polite"></div>';
  const k=au.msgKind==='ok'||String(au.msg).startsWith('✓')?' ok':au.msgKind==='info'?' info':'';
  const onField=Object.keys(au.err||{}).length>0; // ações já aparecem no campo
  return `<div class="au-msgslot" id="auMsg" aria-live="polite"><div class="au-msg${k}" role="${k?'status':'alert'}">${esc(au.msg)}${onField?'':auActsHtml()}${au.msgRef?`<small class="au-ref">${esc(au.msgRef)}</small>`:''}</div></div>`;
}
// linha de erro/dica embaixo do campo (espaço reservado: aparecer o erro não empurra o formulário)
function auFieldMsg(id, hint){ const e=au.err[id]; return `<div class="au-ferr${e?' bad':''}" id="${id}Msg"${e?' role="alert"':''}>${esc(e||hint||'')}${e?auActsHtml():''}${e&&au.msgRef?`<small class="au-ref">${esc(au.msgRef)}</small>`:''}</div>`; }
function auInput(id, type, ph, ac, val, dis){ const bad=!!au.err[id]; return `<input class="au-in${bad?' bad':''}" id="${id}" name="${id}" type="${type}" placeholder="${escA(ph)}" autocomplete="${ac}" value="${escA(val||'')}" aria-invalid="${bad}" aria-describedby="${id}Msg" spellcheck="false" autocapitalize="off"${dis}>`; }
function auPassInput(id, ph, ac, dis){ const bad=!!au.err[id];
  return `<div class="au-inw"><input class="au-in${bad?' bad':''}" id="${id}" name="${id}" data-pw type="${au.showPass?'text':'password'}" placeholder="${escA(ph)}" autocomplete="${ac}" aria-invalid="${bad}" aria-describedby="${id}Msg" spellcheck="false" autocapitalize="off"${dis}><span class="au-caps" data-caps="${id}" hidden>${esc(T('auth.pw.caps'))}</span><button type="button" class="au-eye" data-eye aria-pressed="${au.showPass}" aria-label="${escA(T(au.showPass?'auth.pw.hide_a11y':'auth.pw.show_a11y'))}"${dis}>${esc(T(au.showPass?'auth.pw.hide':'auth.pw.show'))}</button></div>`; }
// regras + medidor de força, VISÍVEIS antes de enviar; o erro do campo toma o lugar das regras
function auPassRules(id){
  const e=au.err[id];
  return `<div class="au-pwbox" id="${id}Msg"><div class="au-strength" aria-hidden="true"><i></i><i></i><i></i><i></i><span data-strl>${esc(T('auth.pw.s0'))}</span></div>
    ${e?`<div class="au-ferr bad" role="alert">${esc(e)}${auActsHtml()}${au.msgRef?`<small class="au-ref">${esc(au.msgRef)}</small>`:''}</div>`:`<ul class="au-rules"><li data-r="min">${esc(T('auth.pw.rule_min',{ min:AUTH_PASS_MIN }))}</li><li data-r="mix">${esc(T('auth.pw.rule_mix'))}</li><li data-r="long">${esc(T('auth.pw.rule_long'))}</li></ul>`}</div>`;
}
function auPassMeter(inputId){
  const p=$id(inputId), box=$id(inputId+'Msg'); if(!p||!box) return;
  const st=authPassStrength(p.value);
  box.querySelectorAll('.au-strength i').forEach((i,k)=>{ i.className=k<st.score?'on s'+st.score:''; });
  const l=box.querySelector('[data-strl]'); if(l) l.textContent=p.value?T('auth.pw.s'+st.score):T('auth.pw.s0');
  box.querySelectorAll('[data-r]').forEach(li=>li.classList.toggle('ok', !!st.rules[li.dataset.r]));
}
function auErr(e){ if(e&&e.info) return authErrPt(e); return errShort(e); }
function auValidEmail(v){ return authValidEmail(v); }
// Erro de servidor → campo certo (ou caixa geral) + próximos passos + código pequeno quando desconhecido
function auFail(e, o){
  o=o||{}; const i=authErrInfo(e); au.busy=false; au.err={}; au.acts=null;
  const text=(e&&e.info&&e.info.rust)?e.message:authErrPt(i, o.vars);
  const ids={ email:'auEmail', pass:o.passId||'auPass', code:'auCode' };
  const fid=i.field&&ids[i.field]; const has=fid&&$id(fid);
  if(has){ au.err[fid]=text; au.focus=fid==='auCode'?'code':fid; au.msg=''; if(fid==='auCode') au.clearCode=true; } else { au.msg=text; au.msgKind=''; }
  au.msgRef=authErrRef(i);
  const email=au.email;
  if(i.key==='invalid_credentials') au.acts=[[T('auth.act.forgot'),()=>auForgot(email)]];
  else if(i.key==='user_exists') au.acts=[[T('auth.act.login'),()=>auShow('login',{ email })],[T('auth.act.forgot'),()=>auForgot(email)]];
  else if(i.key==='otp_no_user'||i.key==='user_not_found') au.acts=[[T('auth.act.signup'),()=>auShow('signup',{ email })]];
  else if(i.key==='rate_wait' && o.recover) au.acts=[[T('auth.confirm.have_code'),()=>auShow('confirm',{ email, confirmType:'recovery', resendAt:Date.now()+(i.wait||AUTH_RESEND_S)*1000 })]];
  // o que a tela não sabe explicar vai pro app_errors (sem e-mail nem senha) — o suporte acha pelo código
  if(['unknown','server','invalid_request'].includes(i.key) && window.logAppError){
    try{ window.logAppError('auth', new Error('auth '+(i.code||'-')+' HTTP '+(i.status||0)+': '+String(i.text||'').replace(/\S+@\S+/g,'<email>').slice(0,160)), { step:au.step, key:i.key }); }catch(_){ }
  }
  auRender();
}
// esqueci a senha (do login, do cadastro "já existe" ou da nova senha sem sessão)
async function auForgot(email){
  if(au.busy) return;
  if(!authValidEmail(email)){ au.err={ auEmail:T('auth.v.email_for_reset') }; au.focus='auEmail'; auRender(); return; }
  au.email=email; au.busy=true; au.err={}; au.msg=''; au.acts=null; auRender();
  try{ await auRecover(email); }catch(e){ auFail(e,{ recover:true }); }
}
// ---- fluxo pós-sessão: planos (se a cobrança está ligada e não há assinatura) → pronto ----
async function auAfterSession(){
  lsSet('sb:ended','');
  try{ await cloudLoad(); }catch(_){ }
  try{ cloudBtnSync(); }catch(_){ }
  try{ if(typeof appVersionPing==='function') appVersionPing(); }catch(_){ } // /admin vê a versão logo após o login
  try{ await billingSync(); }catch(_){ }
  try{ if(typeof secretsSync==='function') secretsSync().then(secretsAvailRefresh).catch(()=>{}); }catch(_){ } // chaves da conta valem já (não espera o ciclo de 30 min)
  if(typeof billingOn!=='undefined' && billingOn && !billingActive()){ auPlanFromSite(); auShow('plans'); return; }
  auShow('ready');
}
// conta criada pelo site (starfork.com.br/comecar): o plano e o ciclo escolhidos lá vêm no user_metadata —
// a tela de planos já abre neles (a pessoa só confirma e vai pro teste grátis).
function auPlanFromSite(){
  try{
    const m=(SB.sess()&&SB.sess().user&&SB.sess().user.user_metadata)||{};
    if(m.plano_desejado==='individual'||m.plano_desejado==='team') au.plan.key=m.plano_desejado;
    if(m.ciclo_desejado==='ano') au.plan.interval='year'; else if(m.ciclo_desejado==='mes') au.plan.interval='month';
  }catch(_){ }
}
function auOAuthBtns(dis, compact){
  return ['github','google'].map(p=>{ const n=p==='github'?'GitHub':'Google';
    return `<button type="button" class="au-btn" id="${p==='github'?'auGh':'auGoogle'}" data-oa="${p}" aria-label="${escA('Entrar com '+n)}" hidden${dis}>${p==='github'?AU_GH:AU_GG}${compact?'':' '+n}</button>`; }).join('');
}
// ---- telas da coluna direita ----
function auRender(){
  const o=auEl(); if(!o) return;
  // planos e pagamento ocupam a tela toda (como no design); as outras telas têm a coluna da esquerda
  o.querySelector('.au-wrap').classList.toggle('full', au.step==='plans'||au.step==='pay');
  $id('auLeft').innerHTML=auLeftHtml(au.step==='plans'||au.step==='pay'?'ready':au.step);
  const R=$id('auRight'); const s=au.step;
  // mesma tela re-renderizada (ocupado/erro): devolve o que a pessoa digitou — antes a senha sumia a cada erro
  const same=R.dataset.step===s, keep={};
  if(same) R.querySelectorAll('input[id]').forEach(i=>{ keep[i.id]=i.value; });
  const keepCode=same&&!au.clearCode?[...R.querySelectorAll('[data-ci]')].map(i=>i.value):null; au.clearCode=false; // código fica visível enquanto confirma; some só se estiver errado
  const dis=au.busy?' disabled':'';
  const topbar=`<div class="au-top"><span class="au-topl mono">${esc(T('auth.top.'+s))}</span><span style="flex:1"></span>${SB.sess()&&s!=='ready'?`<button type="button" class="au-link" id="auLogout">${esc(T('auth.logout'))}</button>`:''}${au.backTo?`<button type="button" class="au-link" id="auBack">${esc(T('auth.back'))}</button>`:''}</div>`;
  let after=null;
  if(s==='signup') after=auRenderSignup(R, topbar, dis);
  else if(s==='login') after=auRenderLogin(R, topbar, dis);
  else if(s==='confirm') after=auRenderConfirm(R, topbar, dis);
  else if(s==='newpass') after=auRenderNewpass(R, topbar, dis);
  else if(s==='plans'){ auRenderPlans(R, topbar); }
  else if(s==='pay'){ auRenderPay(R, topbar); }
  else if(s==='ready'){ auRenderReady(R, topbar); }
  R.dataset.step=s;
  if(same) Object.keys(keep).forEach(id=>{ const e=$id(id); if(e && !e.value && keep[id]) e.value=keep[id]; });
  if(keepCode) R.querySelectorAll('[data-ci]').forEach((e,k)=>{ if(!e.value && keepCode[k]) e.value=keepCode[k]; });
  if(typeof after==='function') after();
  auBindCommon(R, !same);
}
// ligações comuns: sair/voltar, links externos, ações de erro, mostrar senha, Caps Lock, foco
function auBindCommon(R, fresh){
  bindClick('auLogout', ()=>{ sbLogout(); auShow('login'); });
  bindClick('auBack', ()=>{ const b=au.backTo; au.backTo=null; auHide(); if(typeof b==='function') b(); });
  R.querySelectorAll('[data-ext]').forEach(a=>a.onclick=()=>openExternal(a.dataset.ext));
  R.querySelectorAll('[data-auact]').forEach(a=>a.onclick=()=>{ const f=(au.acts||[])[+a.dataset.auact]; if(f) f[1](); });
  const ACT={ toLogin:()=>auShow('login',{ email:au.email }), changeEmail:()=>auShow(au.confirmType==='signup'?'signup':'login',{ email:au.email }) };
  R.querySelectorAll('[data-act]').forEach(a=>a.onclick=()=>{ const f=ACT[a.dataset.act]; if(f) f(); });
  // <a> sem href não recebe foco: vira botão de teclado
  R.querySelectorAll('a[data-act],a[data-auact],a[data-ext],a[id]').forEach(a=>{ if(a.hasAttribute('href')) return; a.tabIndex=0; a.setAttribute('role','button'); a.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); a.click(); } }; });
  R.querySelectorAll('[data-eye]').forEach(b=>b.onclick=()=>{ au.showPass=!au.showPass;
    R.querySelectorAll('[data-pw]').forEach(i=>{ i.type=au.showPass?'text':'password'; });
    R.querySelectorAll('[data-eye]').forEach(x=>{ x.textContent=T(au.showPass?'auth.pw.hide':'auth.pw.show'); x.setAttribute('aria-pressed',String(au.showPass)); x.setAttribute('aria-label',T(au.showPass?'auth.pw.hide_a11y':'auth.pw.show_a11y')); }); });
  R.querySelectorAll('[data-pw]').forEach(i=>{ const cap=e=>{ if(!e.getModifierState) return; const on=e.getModifierState('CapsLock'); const c=R.querySelector(`[data-caps="${i.id}"]`); if(c) c.hidden=!on; };
    i.addEventListener('keydown',cap); i.addEventListener('keyup',cap); i.addEventListener('blur',()=>{ const c=R.querySelector(`[data-caps="${i.id}"]`); if(c) c.hidden=true; }); });
  // OAuth: só aparece o provider que o servidor tem LIGADO (hoje nenhum) — antes o botão abria o navegador e falhava
  if(R.querySelector('[data-oa]')) sbAuthSettings().then(st=>{ const ex=(st&&st.external)||{}; R.querySelectorAll('[data-oa]').forEach(b=>{ if(ex[b.dataset.oa]){ b.hidden=false; b.onclick=()=>auOAuth(b.dataset.oa); } }); });
  if(au.busy) return;
  let f=null;
  if(au.focus==='code') f=[...R.querySelectorAll('[data-ci]')].find(i=>!i.value)||R.querySelector('[data-ci]');
  else if(au.focus) f=$id(au.focus);
  else if(fresh) f=[...R.querySelectorAll('input:not([type=hidden]):not([hidden])')].find(i=>!i.value&&!i.disabled)||null;
  au.focus='';
  if(f){ try{ f.focus(); if(f.dataset&&f.dataset.pw!==undefined&&f.value) f.select(); }catch(_){ } }
}
function auRenderSignup(R, topbar, dis){
  R.innerHTML=topbar+`<form class="au-form" id="auForm" novalidate>${auProgress(1)}<h2 class="au-h2">${esc(T('auth.signup.title'))}</h2><p class="au-p">${esc(T('auth.signup.sub'))}</p>
    <label class="au-lbl" for="auName">${esc(T('auth.signup.name'))}</label><input class="au-in" id="auName" name="auName" autocomplete="name" placeholder="${escA(T('auth.signup.name_ph'))}" value="${escA(au.name)}"${dis}>
    <label class="au-lbl" for="auEmail">${esc(T('auth.signup.email'))}</label>${auInput('auEmail','email','voce@empresa.com','email',au.email,dis)}${auFieldMsg('auEmail')}
    <label class="au-lbl" for="auPass">${esc(T('auth.signup.pass'))}</label>${auPassInput('auPass',T('auth.signup.pass_ph',{ min:AUTH_PASS_MIN }),'new-password',dis)}${auPassRules('auPass')}
    ${auMsg()}
    <div class="au-row"><button type="submit" class="au-btn primary" id="auGo"${dis}>${esc(T(au.busy?'auth.signup.busy':'auth.signup.go'))}</button>${auOAuthBtns(dis)}<span style="flex:1"></span><button type="button" class="au-link" id="auToLogin"${dis}>${esc(T('auth.signup.have'))}</button></div>
    <div class="au-legal">${T('auth.signup.legal')}</div></form>`;
  const go=async(ev)=>{ if(ev) ev.preventDefault(); if(au.busy) return;
    au.name=$id('auName').value.trim(); au.email=$id('auEmail').value.trim(); const pass=$id('auPass').value;
    au.err={}; au.msg=''; au.msgRef=''; au.acts=null;
    if(!au.email) au.err.auEmail=T('auth.v.email_required'); else if(!authValidEmail(au.email)) au.err.auEmail=T('auth.v.email_invalid');
    if(pass.length<AUTH_PASS_MIN) au.err.auPass=T('auth.v.pass_min',{ min:AUTH_PASS_MIN });
    if(Object.keys(au.err).length){ au.focus=Object.keys(au.err)[0]; auRender(); return; }
    au.busy=true; auRender(); lsSet('sb:email',au.email);
    try{ const j=await sbAuth('signup'+auRedir('/confirmado'),{ email:au.email, password:pass, data:{ name:au.name } });
      if(j.access_token){ SB.setSess(j); await auAfterSession(); return; }
      // e-mail já cadastrado + confirmação ligada: o GoTrue responde "sucesso" com identities vazio e NÃO manda
      // e-mail (anti-enumeração). Antes a tela ia pro código e ficava esperando um e-mail que nunca chega.
      const u=j.user||j;
      if(u && Array.isArray(u.identities) && u.identities.length===0){ au.busy=false; au.err={ auEmail:T('auth.err.user_exists') }; au.focus='auEmail'; const em=au.email;
        au.acts=[[T('auth.act.login'),()=>auShow('login',{ email:em })],[T('auth.act.forgot'),()=>auForgot(em)]]; auRender(); return; }
      auShow('confirm',{ confirmType:'signup', resendAt:Date.now()+AUTH_RESEND_S*1000, codeSentAt:Date.now() }); }
    catch(e){ auFail(e); } };
  $id('auForm').onsubmit=go;
  bindClick('auToLogin', ()=>auShow('login',{ email:($id('auEmail')||{}).value||au.email }));
  const p=$id('auPass'); p.addEventListener('input',()=>auPassMeter('auPass'));
  $id('auEmail').addEventListener('blur',e=>{ const v=e.target.value.trim(); if(v && !authValidEmail(v) && !au.err.auEmail){ au.err.auEmail=T('auth.v.email_invalid'); const m=$id('auEmailMsg'); if(m){ m.textContent=au.err.auEmail; m.classList.add('bad'); } e.target.setAttribute('aria-invalid','true'); e.target.classList.add('bad'); } });
  $id('auEmail').addEventListener('input',e=>{ if(au.err.auEmail && authValidEmail(e.target.value)){ delete au.err.auEmail; const m=$id('auEmailMsg'); if(m){ m.textContent=''; m.classList.remove('bad'); } e.target.setAttribute('aria-invalid','false'); e.target.classList.remove('bad'); } });
  return ()=>auPassMeter('auPass');
}
function auRenderLogin(R, topbar, dis){
  R.innerHTML=topbar+`<form class="au-form" id="auForm" novalidate><div class="au-eyebrow">${esc(T('auth.login.eyebrow'))}</div><h2 class="au-h2">${esc(T('auth.login.title'))}</h2><p class="au-p">${esc(T('auth.login.sub'))}</p>
    <label class="au-lbl" for="auEmail">${esc(T('auth.login.email'))}</label>${auInput('auEmail','email','voce@empresa.com','username',au.email,dis)}${auFieldMsg('auEmail')}
    <div class="au-pwfield"><label class="au-lbl" for="auPass">${esc(T('auth.login.pass'))}</label>${auPassInput('auPass',T('auth.login.pass_ph'),'current-password',dis)}<button type="button" class="au-link au-forgot" id="auForgot"${dis}>${esc(T('auth.login.forgot'))}</button></div>${auFieldMsg('auPass')}
    ${auMsg()}
    <div class="au-row"><button type="submit" class="au-btn primary" id="auGo"${dis}>${esc(T(au.busy?'auth.login.busy':'auth.login.go'))}</button><button type="button" class="au-btn outline" id="auMagic"${dis}>${esc(T('auth.login.code'))}</button>${auOAuthBtns(dis,true)}</div>
    <div class="au-legal">${esc(T('auth.login.no_account'))} <a id="auToSignup">${esc(T('auth.login.create'))}</a></div></form>`;
  const go=async(ev)=>{ if(ev) ev.preventDefault(); if(au.busy) return;
    au.email=$id('auEmail').value.trim(); const pass=$id('auPass').value;
    au.err={}; au.msg=''; au.msgRef=''; au.acts=null;
    if(!au.email) au.err.auEmail=T('auth.v.email_required'); else if(!authValidEmail(au.email)) au.err.auEmail=T('auth.v.email_invalid');
    if(!pass) au.err.auPass=T('auth.v.pass_required');
    if(Object.keys(au.err).length){ au.focus=Object.keys(au.err)[0]; auRender(); return; }
    au.busy=true; auRender(); lsSet('sb:email',au.email);
    try{ const j=await sbAuth('token?grant_type=password',{ email:au.email, password:pass }); SB.setSess(j); await auAfterSession(); }
    catch(e){
      // conta existe mas o e-mail não foi confirmado: vai direto pro código (sem gastar e-mail — "reenviar" fica liberado)
      if(e && e.authKey==='email_not_confirmed'){ auShow('confirm',{ confirmType:'signup', resendAt:0, codeSentAt:0, msg:T('auth.err.email_not_confirmed'), msgKind:'info' }); return; }
      auFail(e);
    } };
  $id('auForm').onsubmit=go;
  bindClick('auToSignup', ()=>auShow('signup',{ email:($id('auEmail')||{}).value||au.email }));
  bindClick('auForgot', ()=>{ const v=$id('auEmail').value.trim(); if(!authValidEmail(v)){ au.err={ auEmail:T('auth.v.email_for_reset') }; au.msg=''; au.acts=null; au.focus='auEmail'; auRender(); return; } auForgot(v); });
  bindClick('auMagic', async()=>{ if(au.busy) return; au.email=$id('auEmail').value.trim(); au.msg=''; au.acts=null;
    if(!authValidEmail(au.email)){ au.err={ auEmail:T('auth.v.email_for_code') }; au.focus='auEmail'; auRender(); return; }
    au.err={}; au.busy=true; auRender();
    try{ await sbAuth('otp'+auRedir('/confirmado'),{ email:au.email, create_user:false }); lsSet('sb:email',au.email); auShow('confirm',{ confirmType:'magiclink', resendAt:Date.now()+AUTH_RESEND_S*1000, codeSentAt:Date.now() }); }
    catch(e){ auFail(e); } });
  return null;
}
function auResendHtml(left){ return `${esc(T('auth.confirm.not_arrived'))} ${left>0?`<span id="auResendIn">${esc(T('auth.confirm.resend_in',{ t:authFmtWait(left) }))}</span>`:`<a id="auResend">${esc(T('auth.confirm.resend'))}</a>`}`; }
function auRenderConfirm(R, topbar, dis){
  const ct=au.confirmType, left=Math.max(0,Math.ceil((au.resendAt-Date.now())/1000));
  const title=T(ct==='recovery'?'auth.confirm.title_recovery':ct==='magiclink'?'auth.confirm.title_magic':'auth.confirm.title_signup');
  const until=au.codeSentAt?new Date(au.codeSentAt+AUTH_CODE_TTL_S*1000).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' }):'';
  const hint=until?T('auth.confirm.valid_until',{ hh:until }):T('auth.confirm.valid');
  const bad=!!au.err.auCode;
  R.innerHTML=topbar+`<form class="au-form" id="auForm" novalidate>${ct==='signup'?auProgress(2):''}<h2 class="au-h2">${esc(title)}</h2><p class="au-p">${esc(T('auth.confirm.sent'))} <b class="mono">${esc(au.email)}</b> · <a data-act="changeEmail">${esc(T('auth.confirm.change'))}</a></p>
    <div class="au-code${bad?' bad':''}" id="auCode" role="group" aria-label="${escA(T('auth.confirm.group'))}" aria-describedby="auCodeMsg">${[0,1,2,3,4,5].map(i=>`<input inputmode="numeric" pattern="[0-9]*" maxlength="6" data-ci="${i}" aria-label="${escA(T('auth.confirm.digit',{ n:i+1 }))}" aria-invalid="${bad}" autocomplete="${i===0?'one-time-code':'off'}"${dis}>`).join('')}</div>
    ${auFieldMsg('auCode', hint)}
    ${auMsg()}
    <div class="au-row"><button type="submit" class="au-btn primary" id="auGo"${dis}>${esc(T(au.busy?'auth.confirm.busy':'auth.confirm.go'))}</button><span class="au-hint" id="auResendBox">${auResendHtml(left)}</span></div>
    <div class="au-legal">${T(ct==='signup'?'auth.confirm.foot_signup':ct==='recovery'?'auth.confirm.foot_recovery':'auth.confirm.foot_magic')}</div></form>`;
  const inputs=[...R.querySelectorAll('[data-ci]')];
  const code=()=>inputs.map(i=>i.value).join('');
  const go=async(ev)=>{ if(ev) ev.preventDefault(); if(au.busy) return; const t=code();
    au.msg=''; au.msgRef=''; au.acts=null;
    if(t.length<6){ au.err={ auCode:T('auth.v.code_incomplete') }; au.focus='code'; auRender(); return; }
    au.err={}; au.busy=true; auRender();
    try{ const j=await sbAuth('verify',{ type:ct==='magiclink'?'magiclink':ct, email:au.email, token:t });
      if(!j.access_token){ au.busy=false; au.msg=T('auth.confirm.no_session'); au.acts=[[T('auth.act.login'),()=>auShow('login',{ email:au.email })]]; auRender(); return; }
      SB.setSess(j); if(ct==='recovery'){ auShow('newpass'); return; } await auAfterSession(); }
    catch(e){ auFail(e); } };
  const fillFrom=(i,d)=>{ [...d].slice(0,6-i).forEach((c,k)=>{ inputs[i+k].value=c; }); const nx=inputs.find(x=>!x.value)||inputs[5]; nx.focus(); };
  inputs.forEach((inp,i)=>{
    // um dígito por caixa; colar/autopreencher (inclusive o "código do Mail" do macOS) espalha pelos 6
    inp.oninput=()=>{ const d=inp.value.replace(/\D/g,''); if(d.length>1) fillFrom(d.length>=6?0:i, d.length>=6?d.slice(0,6):d); else { inp.value=d; if(d&&inputs[i+1]) inputs[i+1].focus(); } if(code().length===6) go(); };
    inp.onkeydown=e=>{
      if(e.key==='Backspace'&&!inp.value&&inputs[i-1]){ e.preventDefault(); inputs[i-1].value=''; inputs[i-1].focus(); }
      else if(e.key==='ArrowLeft'&&inputs[i-1]){ e.preventDefault(); inputs[i-1].focus(); }
      else if(e.key==='ArrowRight'&&inputs[i+1]){ e.preventDefault(); inputs[i+1].focus(); } };
    inp.onfocus=()=>{ try{ inp.select(); }catch(_){ } };
    inp.onpaste=e=>{ const v=((e.clipboardData&&e.clipboardData.getData('text'))||'').replace(/\D/g,'').slice(0,6); if(!v.length) return; e.preventDefault(); fillFrom(v.length===6?0:i, v); if(code().length===6) go(); };
  });
  $id('auForm').onsubmit=go;
  const resend=async()=>{ if(au.busy) return; au.busy=true; au.msg=''; au.msgRef=''; au.err={}; au.acts=null; auRender();
    try{
      if(ct==='signup') await sbAuth('resend'+auRedir('/confirmado'),{ type:'signup', email:au.email });
      else if(ct==='recovery') await sbAuth('recover'+auRedir('/redefinir-senha'),{ email:au.email });
      else await sbAuth('otp'+auRedir('/confirmado'),{ email:au.email, create_user:false });
      au.resendAt=Date.now()+AUTH_RESEND_S*1000; au.codeSentAt=Date.now(); au.busy=false; au.msg=T('auth.confirm.resent',{ email:au.email }); au.msgKind='ok'; au.focus='code'; auRender();
    }catch(e){ const i=authErrInfo(e);
      // o botão volta com o tempo que o servidor pediu (limite por hora: 5 min, pra não queimar a cota)
      if(i.key==='rate_wait') au.resendAt=Date.now()+(i.wait||AUTH_RESEND_S)*1000; else if(i.key==='rate_email'||i.key==='rate_request') au.resendAt=Date.now()+300000;
      auFail(e); } };
  const bindResend=()=>bindClick('auResend', resend);
  bindResend();
  if(_auTimer) clearInterval(_auTimer); _auTimer=null;
  if(left>0){ _auTimer=setInterval(()=>{
      if(au.step!=='confirm'||!auOpen()){ clearInterval(_auTimer); _auTimer=null; return; }
      const l=Math.max(0,Math.ceil((au.resendAt-Date.now())/1000)); const box=$id('auResendBox'); if(!box){ clearInterval(_auTimer); _auTimer=null; return; }
      if(l<=0){ clearInterval(_auTimer); _auTimer=null; box.innerHTML=auResendHtml(0); bindResend(); const a=$id('auResend'); if(a){ a.tabIndex=0; a.setAttribute('role','button'); a.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); a.click(); } }; } return; }
      const e=$id('auResendIn'); if(e) e.textContent=T('auth.confirm.resend_in',{ t:authFmtWait(l) }); },1000); }
  if(!au.focus && !au.busy) au.focus='code';
  return null;
}
function auRenderNewpass(R, topbar, dis){
  if(!SB.sess()){
    R.innerHTML=topbar+`<form class="au-form" id="auForm" novalidate><div class="au-eyebrow">${esc(T('auth.newpass.eyebrow'))}</div><h2 class="au-h2">${esc(T('auth.newpass.title'))}</h2>
      <div class="au-msg info" role="status">${esc(T('auth.newpass.nosess'))}</div>
      <div class="au-row">${authValidEmail(au.email)?`<button type="button" class="au-btn primary" id="auAgain"${dis}>${esc(T('auth.newpass.again'))}</button>`:''}<button type="button" class="au-link" id="auToLogin">${esc(T('auth.newpass.back'))}</button></div></form>`;
    bindClick('auAgain', ()=>auForgot(au.email)); bindClick('auToLogin', ()=>auShow('login',{ email:au.email }));
    return null;
  }
  R.innerHTML=topbar+`<form class="au-form" id="auForm" novalidate><div class="au-eyebrow">${esc(T('auth.newpass.eyebrow'))}</div><h2 class="au-h2">${esc(T('auth.newpass.title'))}</h2><p class="au-p">${esc(T('auth.newpass.sub'))}</p>
    <input type="email" name="username" autocomplete="username" value="${escA(au.email||((SB.sess().user||{}).email)||'')}" hidden>
    <label class="au-lbl" for="auPass">${esc(T('auth.newpass.pass'))}</label>${auPassInput('auPass',T('auth.signup.pass_ph',{ min:AUTH_PASS_MIN }),'new-password',dis)}${auPassRules('auPass')}
    <label class="au-lbl" for="auPass2">${esc(T('auth.newpass.pass2'))}</label>${auPassInput('auPass2',T('auth.newpass.pass2_ph'),'new-password',dis)}${auFieldMsg('auPass2')}
    ${auMsg()}
    <div class="au-row"><button type="submit" class="au-btn primary" id="auGo"${dis}>${esc(T(au.busy?'auth.newpass.busy':'auth.newpass.go'))}</button>${au.backTo?'':`<button type="button" class="au-link" id="auToLogin"${dis}>${esc(T('auth.newpass.back'))}</button>`}</div></form>`;
  const go=async(ev)=>{ if(ev) ev.preventDefault(); if(au.busy) return; const a=$id('auPass').value, b=$id('auPass2').value;
    au.err={}; au.msg=''; au.msgRef=''; au.acts=null;
    if(a.length<AUTH_PASS_MIN) au.err.auPass=T('auth.v.pass_min',{ min:AUTH_PASS_MIN }); else if(a!==b) au.err.auPass2=T('auth.v.pass_mismatch');
    if(Object.keys(au.err).length){ au.focus=Object.keys(au.err)[0]; auRender(); return; }
    au.busy=true; auRender();
    try{ await sbAuthUpdate({ password:a }); au.msg='';
      try{ toast(T('auth.newpass.done'),'ok'); }catch(_){ }
      if(au.backTo){ const b2=au.backTo; au.backTo=null; auHide(); if(typeof b2==='function') b2(); return; }
      await auAfterSession(); }
    catch(e){ if(!SB.sess()){ au.busy=false; auRender(); return; } auFail(e); } };
  $id('auForm').onsubmit=go;
  // voltar sem salvar: a sessão do código de recuperação não fica aberta nesta máquina
  bindClick('auToLogin', ()=>{ const em=au.email; sbLogout(); auShow('login',{ email:em }); });
  $id('auPass').addEventListener('input',()=>auPassMeter('auPass'));
  return ()=>auPassMeter('auPass');
}
// Tela "pronto": diz a verdade do estado (projeto aberto? ambiente ok?) e leva pro próximo passo real.
// Antes: "falta só o repo" mesmo com o projeto aberto, "Abrir o cockpit", "neste Mac" no Windows e o
// ambiente sempre como "verificar", mesmo já checado.
// "Conta pronta": diz o plano (se houver) e leva pra aba Primeiros passos — o checklist mora SÓ lá (antes o "Pronto"
// repetia o 1-2-3 do tour e dizia "Estrela acesa").
function auRenderReady(R, topbar){
  const seats=(myBilling&&myBilling.seats)||au.plan.seats||1, planName=(myBilling&&myBilling.plan==='team')?'Time':(myBilling&&myBilling.plan==='enterprise')?'Enterprise':(myBilling?'Solo':'');
  const trial=(myBilling&&myBilling.status==='trialing'&&myBilling.trial_end)?Math.max(0,Math.ceil((new Date(myBilling.trial_end)-Date.now())/864e5)):0;
  R.innerHTML=topbar+`<div class="au-form au-center"><div class="au-check">✓</div><h2 class="au-h2">Conta pronta</h2><p class="au-p">${trial?`Teste de ${trial} dias começou. `:''}${planName?`${seats} assento${seats===1?'':'s'} no plano ${planName}, ativo neste computador.`:'Sua conta está ativa neste computador.'}</p>
    <p class="au-p">O próximo passo é deixar o computador e a IA prontos — leva uns minutos e cada item se marca sozinho.</p>
    <button class="au-btn primary big" id="auGo">Ir pra Primeiros passos</button></div>`;
  bindClick('auGo', ()=>{ auHide(); if(typeof primeirosPassosOpen==='function') primeirosPassosOpen(); else if(window.openTab) window.openTab('flow'); });
}
const AU_GH='<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 .4a7.6 7.6 0 0 0-2.4 14.8c.4.1.5-.2.5-.4v-1.3c-2.1.5-2.6-1-2.6-1-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.2.6.1-.5.3-.8.5-1-1.7-.2-3.5-.8-3.5-3.7 0-.8.3-1.5.8-2-.1-.2-.3-1 .1-2 0 0 .6-.2 2.1.8a7.3 7.3 0 0 1 3.8 0c1.5-1 2.1-.8 2.1-.8.4 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.5 3.7.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.6 7.6 0 0 0 8 .4z"/></svg>';
// @cor-dado-inicio — logo do Google (as 4 cores da marca)
const AU_GG='<svg viewBox="0 0 18 18" width="14" height="14"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
// @cor-dado-fim
// Google/GitHub: o botão só aparece se o provider estiver LIGADO no servidor (auBindCommon lê /auth/v1/settings).
// "cancelar" solta a tela na hora (o navegador pode nunca voltar — antes ficava 3 min em "entrando…").
async function auOAuth(provider){
  if(au.busy) return;
  const pname=provider==='github'?'GitHub':'Google'; const gen=++au.oauthGen;
  au.busy=true; au.err={}; au.msgRef=''; au.msg=T('auth.oauth.opening',{ provider:pname }); au.msgKind='info';
  au.acts=[[T('auth.act.cancel'),()=>{ au.oauthGen++; au.busy=false; au.msg=''; au.acts=null; auRender(); }]]; auRender();
  try{ await loginOAuth(provider); if(gen!==au.oauthGen) return; au.msg=''; au.acts=null; if(SB.sess()) await auAfterSession(); else { au.busy=false; auRender(); } }
  catch(e){ if(gen!==au.oauthGen) return; auFail(e,{ vars:{ provider:pname } }); }
}
// ---- planos (lê billing_plans; sem seed mostra os preços do design, sem checkout) ----
const AU_PLAN_DEFAULTS=[
  // Solo tem TODAS as funcionalidades (30/09): o plano muda só QUANTAS PESSOAS usam — o app nunca bloqueou nada por plano
  { key:'individual', name:'Solo', who:'1 pessoa, todas as funcionalidades', perSeat:false, feats:['Agentes em paralelo e épicos em ondas','Painel de Issues e daily automática','Memória do projeto e custo antes de rodar','App de iPhone pra responder o agente'] },
  { key:'team', name:'Time', who:'squads de 3 a 12', perSeat:true, hot:true, feats:['Tudo do Solo, pra cada pessoa do time','Quadro e backlog compartilhados','Convites, papéis e custo por pessoa','Preferências do projeto sincronizadas'] },
  { key:'enterprise', name:'Organização', who:'vários times e projetos', feats:['Tudo do Time, sem teto de assentos','SSO, auditoria e política por projeto','Chaves de modelo próprias (BYOK)','Suporte dedicado'] },
];
function auPlanRow(key, interval){ return (billingPlans||[]).find(p=>p.plan===key&&p.interval===interval); }
// preço por assento (per_seat) ou fechado por time (planos antigos: amount = time inteiro, seats = teto)
function auPerSeat(key, interval){ const p=auPlanRow(key, interval); return p ? !!p.per_seat : key==='team'; }
function auSeatsOf(key){ const p=auPlanRow(key, au.plan.interval); return (key==='team' && p && !p.per_seat) ? (p.seats||1) : (key==='team' ? au.plan.seats : 1); }
// preço SÓ da tabela billing_plans (antes havia preço de reserva fixo no código) — sem a linha, não há número
function auPrice(key, interval){ const p=auPlanRow(key, interval); return p?p.amount_cents:null; }
// sem a linha do plano na tabela não há total (null) — nunca "R$ 0"; o botão de seguir fica desligado
function auTotal(){ const per=auPrice(au.plan.key, au.plan.interval); if(per==null) return null; return auPerSeat(au.plan.key, au.plan.interval) ? per*auSeatsOf(au.plan.key) : per; }
// TESTE GRÁTIS em destaque (fonte única): dias do plano (billing_plans.trial_days; sem a linha, o padrão da
// migration 0010) e a data da 1ª cobrança — o cartão é cadastrado agora, mas nada é cobrado antes dela.
const AU_TRIAL_DEFAULT=7;
function auTrialDays(key, iv){ const d=(auPlanRow(key, iv)||{}).trial_days; return d>0 ? d : AU_TRIAL_DEFAULT; }
function auTrialFirstCharge(days){ return new Date(Date.now()+days*864e5).toLocaleDateString('pt-BR',{ day:'2-digit', month:'2-digit' }); }
function auTrialBanner(days){
  return `<div class="au-trial" role="note"><span class="au-trial-n">${days}</span><div class="au-trial-t"><b>dias grátis em qualquer plano</b><span>Cadastre o cartão e use tudo por ${days} dias. Nada é cobrado hoje: a primeira cobrança só vem em <b>${auTrialFirstCharge(days)}</b>. Cancelou antes, não paga nada.</span></div></div>`;
}
function auRenderPlans(R, topbar){
  const iv=au.plan.interval, hasPlans=!!(billingPlans&&billingPlans.length);
  const cards=AU_PLAN_DEFAULTS.map(p=>{
    const on=au.plan.key===p.key; const price=p.key==='enterprise'?null:auPrice(p.key,iv); const noPrice=p.key!=='enterprise' && price==null; const ps=auPerSeat(p.key,iv); const row=auPlanRow(p.key,iv);
    return `<button class="au-plan${on?' on':''}${p.hot?' hot':''}" data-plan="${p.key}"><div class="au-plh"><span class="au-pldot"></span><b>${esc(p.name)}</b>${p.hot?'<span class="au-badge">mais usado</span>':''}<span class="au-plwho">${esc(p.who)}</span></div>
      ${price==null?'':`<span class="au-trialchip">${auTrialDays(p.key,iv)} dias grátis</span>`}
      <div class="au-plprice">${noPrice?'<b>—</b><span>preço indisponível agora</span>':price==null?'<b>sob consulta</b><span>fale com vendas</span>':`<b>${fmtBRL(price).replace(',00','')}</b><span>${p.key==='team'&&!ps?`por time (até ${(row&&row.seats)||6} assentos)`:`por ${p.perSeat?'assento':'pessoa'}`}/${iv==='year'?(ps||p.key!=='team'?'mês, no anual':'ano'):'mês'}</span>`}</div>
      <ul class="au-plf">${p.feats.map(f=>`<li>${esc(f)}</li>`).join('')}</ul></button>`; }).join('');
  const total=auTotal(); const perSeat=auPerSeat(au.plan.key,iv); const seats=auSeatsOf(au.plan.key); const isEnt=au.plan.key==='enterprise';
  const trial=auTrialDays(au.plan.key,iv);
  R.innerHTML=topbar+`<div class="au-form wide">${auProgress(3)}<div class="au-plhead"><div><h2 class="au-h2">Escolha o plano</h2><p class="au-p">Você paga pelos assentos. O custo dos modelos é cobrado à parte, sempre visível na tarefa.</p></div><div class="au-seg"><button class="${iv==='month'?'on':''}" data-iv="month">mensal</button><button class="${iv==='year'?'on':''}" data-iv="year">anual <i>2 meses grátis</i></button></div></div>${auMsg()}
    ${hasPlans?auTrialBanner(trial):'<div class="au-msg" role="alert">Não consegui carregar a tabela de planos agora — sem ela não mostramos preço. Tente de novo em instantes ou fale com o suporte do Starfork. <button type="button" class="au-link" id="auPlansRetry">tentar de novo</button></div>'}
    <div class="au-plans">${cards}</div>
    <div class="au-plinv"><span class="au-hint">Sua empresa já usa o Starfork? <a id="auInvCheck">procurar convite pro meu e-mail</a> · <a id="auInvite">colar o token de um convite</a></span></div>
    <div class="au-plbar">${isEnt?`<div class="au-plsum"><span class="au-lbl" style="margin:0">Organização</span><b>Vamos montar junto</b><span class="au-hint">SSO, política por projeto e chaves próprias — fale com a gente.</span></div><span style="flex:1"></span><button class="au-btn primary big" id="auSales">Falar com vendas</button>`:
      `${au.plan.key==='team'&&perSeat?`<div class="au-seats"><span class="au-lbl" style="margin:0">assentos</span><div class="au-step"><button id="auSeatM">−</button><b>${seats}</b><button id="auSeatP">+</button></div></div>`:''}<div class="au-plsum"><span class="au-lbl" style="margin:0">total</span><b>${total!=null?fmtBRL(total).replace(',00',''):'—'} <small>/${iv==='year'&&!perSeat&&au.plan.key==='team'?'ano':'mês'}</small></b><span class="au-hint">${perSeat&&seats>1&&total!=null?`${seats} assentos × ${fmtBRL(auPrice(au.plan.key,iv)).replace(',00','')} por mês · `:(au.plan.key==='team'&&!perSeat?`até ${seats} assentos · `:'')}custo de modelo à parte${iv==='year'?' · cobrado anualmente':''}</span></div><span style="flex:1"></span><div class="au-plcta"><button class="au-btn primary big" id="auGo"${hasPlans&&total!=null?'':' disabled'}>${hasPlans?`Começar ${trial} dias grátis`:'Continuar para o pagamento'}</button><span class="au-hint">${hasPlans?`sem cobrança hoje · 1ª cobrança em ${auTrialFirstCharge(trial)} · cancele quando quiser`:'o pagamento ainda não está disponível — fale com o suporte do Starfork'}</span></div>`}</div></div>`;
  R.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>{ au.plan.key=b.dataset.plan; auRender(); });
  R.querySelectorAll('[data-iv]').forEach(b=>b.onclick=()=>{ au.plan.interval=b.dataset.iv; auRender(); });
  bindClick('auSeatM', ()=>{ au.plan.seats=Math.max(1,au.plan.seats-1); auRender(); });
  bindClick('auSeatP', ()=>{ const cap=(auPlanRow('team',iv)||{}).seats||12; au.plan.seats=Math.min(cap,au.plan.seats+1); auRender(); });
  bindClick('auGo', ()=>{ if(auTotal()==null) return; auShow('pay'); });
  bindClick('auPlansRetry', async()=>{ try{ await billingSync(); }catch(_){ } auRender(); });
  bindClick('auSales', ()=>openExternal('mailto:vendas@starfork.com.br?subject=Plano%20Organiza%C3%A7%C3%A3o%20Starfork'));
  // Antes: um só link com askText "deixe vazio pra só verificar" — mas o askText devolve null no vazio, igual ao
  // cancelar, então "só verificar" nunca fazia nada. Agora são duas ações.
  const invGo=async(tok)=>{
    if(au.busy) return;
    au.busy=true; au.msg=''; auRender();
    let joined=false;
    try{ if(tok.trim()){ const j=await sbRpc('accept_invite',{ p_token:tok.trim() }); if(!j.ok) throw new Error(j.error); lsSet('sb:team', j.team_id); joined=true; } }
    catch(e){ au.msg=(typeof cloudErrMsg==='function')?cloudErrMsg(e):auErr(e); au.busy=false; auRender(); return; }
    // o aceite já valeu: se recarregar a conta/assinatura falhar, a pessoa precisa saber que ENTROU no time
    try{ cloudData=null; cloudAutoInvTried=false; await cloudLoad(); await billingSync(); }
    catch(e){ au.msg=joined?'Você entrou no time ✓ — mas não consegui atualizar a assinatura agora ('+((typeof cloudErrMsg==='function')?cloudErrMsg(e):auErr(e))+'). Tente de novo em instantes.':((typeof cloudErrMsg==='function')?cloudErrMsg(e):auErr(e)); au.busy=false; auRender(); return; }
    if(billingActive()){ au.busy=false; auShow('ready'); return; }
    const org=cloudData&&cloudData.org;
    au.msg=(joined||org)?`Você já está ${org&&org.name?'na organização '+org.name:'no time'}, mas ela ainda não tem plano ativo — fale com quem administra a conta.`:'Nenhum convite pendente pro seu e-mail. Peça pro lead do time te convidar com este e-mail — aí você entra sozinho.';
    au.busy=false; auRender();
  };
  bindClick('auInvCheck', ()=>invGo(''));
  bindClick('auInvite', async()=>{ const tok=await askText('Convite do time','cole o token que o lead te mandou', ''); if(tok) invGo(tok); });
}
function auRenderPay(R, topbar){
  const p=auPlanRow(au.plan.key, au.plan.interval); const iv=au.plan.interval; const perSeat=auPerSeat(au.plan.key,iv); const seats=auSeatsOf(au.plan.key);
  const per=auPrice(au.plan.key,iv), total=auTotal(); const trial=auTrialDays(au.plan.key,iv);
  const first=new Date(Date.now()+trial*864e5).toLocaleDateString('pt-BR');
  const name=(AU_PLAN_DEFAULTS.find(x=>x.key===au.plan.key)||{}).name||au.plan.key;
  R.innerHTML=topbar+`<div class="au-pay"><div class="au-payl"><button class="au-link" id="auToPlans">← planos</button><h2 class="au-h2">Pagamento</h2>${auMsg()}
      ${auTrialBanner(trial)}
      <p class="au-p">O pagamento acontece numa página segura da <b>Stripe</b>, no seu navegador — o cartão nunca passa pelo app.</p>
      <div class="au-methods" aria-label="formas de pagamento aceitas na Stripe"><span>Cartão</span><span>Pix</span><span>Boleto/NF</span><em>você escolhe lá</em></div>
      ${au.waiting?`<div class="au-wait">${brandLoaderHtml('esperando a confirmação da Stripe…', { inline:true, now:true })}<div class="au-hint">Concluiu o pagamento? O app reconhece sozinho em instantes. <a id="auRecheck">verificar agora</a></div></div>`:`<button class="au-btn primary big" id="auGo"${au.busy?' disabled':''}>${au.busy?'abrindo a Stripe…':`Começar ${trial} dias grátis`}</button><div class="au-hint" style="margin-top:10px">Sem cobrança agora: o cartão fica cadastrado e a primeira cobrança só vem em ${first}. Avisamos 3 dias antes.</div>`}
    </div>
    <aside class="au-payr"><div class="au-lbl" style="margin:0 0 10px">resumo</div><div class="au-sumt"><i></i>${esc(name)} · ${iv==='year'?'anual':'mensal'}</div>
      ${perSeat?`<div class="au-sumr"><span>Assento</span><b>${fmtBRL(per).replace(',00','')}/mês</b></div>`:''}<div class="au-sumr"><span>Assentos</span><b>${seats}</b></div><div class="au-sumr"><span>Após o teste</span><b>${fmtBRL(total).replace(',00','')}/${iv==='year'?(perSeat||au.plan.key!=='team'?'mês (anual)':'ano'):'mês'}</b></div>
      <div class="au-sumr big"><span>Hoje</span><b style="color:var(--accent)">R$ 0,00</b></div>
      <p class="au-hint">Primeira cobrança em ${first}. Custo de modelo é medido por tarefa e cobrado no mês seguinte.</p>
      <div class="au-secure"><i></i>pagamento seguro · Stripe</div></aside></div>`;
  bindClick('auToPlans', ()=>{ au.waiting=false; auShow('plans'); });
  bindClick('auGo', ()=>auCheckout());
  bindClick('auRecheck', async()=>{ try{ await billingSync(); }catch(_){ } if(billingActive()) auShow('ready'); else { au.msg='ainda não chegou a confirmação — tente de novo em alguns segundos.'; auRender(); } });
}
// erro do checkout em pt-BR (antes: "Não consegui abrir o checkout: Unexpected token '<'…" quando a function
// respondia HTML, ou "HTTP 500") — puro, testado em app/tests/onboarding-conta.test.mjs
function auCheckoutErr(status, body, e){
  const m=String((body&&(body.error||body.message))||(e&&e.message)||'');
  if(e && (e.network || /failed to fetch|load failed|networkerror/i.test(m))) return 'Sem conexão com o servidor de pagamento — confira a internet e tente de novo.';
  if(status===401||status===403) return 'Sua sessão expirou — saia e entre de novo pra assinar.';
  if(/seat|assento/i.test(m)) return 'O número de assentos não bate com o plano — ajuste e tente de novo.';
  if(/\b(team(_?id)?|time)\b/i.test(m) && status>=400 && status<500) return 'Pra assinar o plano Time, crie ou entre num time primeiro (Conta e time).';
  if(status===404) return 'O pagamento ainda não está disponível neste servidor — fale com o suporte do Starfork.';
  if(status>=500 || !status) return 'O servidor de pagamento está com problema agora — tente de novo em alguns minutos.';
  // RPC/function do Starfork que já fala português passa como veio
  if(typeof isPtText==='function' ? isPtText(m) : /[ãõçéêáíóú]/i.test(m)) return m.charAt(0).toUpperCase()+m.slice(1);
  return 'Não deu pra abrir o pagamento agora — tente de novo em instantes.';
}
async function auCheckout(){
  if(au.busy) return; // 2 cliques = 2 sessões de checkout
  const p=auPlanRow(au.plan.key, au.plan.interval); if(!p){ au.msg='Esse plano não está disponível agora — volte e escolha de novo.'; auRender(); return; }
  if(au.plan.key==='team' && !cloudTeamId()){ au.msg='Pra assinar o plano Time, crie ou entre num time primeiro (Ajustes › Times e pessoas).'; auRender(); return; }
  const sess=SB.sess(); if(!sess||!sess.access_token){ au.msg=T('auth.err.session_expired'); auRender(); return; }
  au.busy=true; au.msg=''; auRender();
  let r=null, j=null;
  try{
    r=await fetch(SB.url()+'/functions/v1/stripe-checkout',{ method:'POST', headers:{ 'Content-Type':'application/json', 'apikey':SB.key(), 'Authorization':'Bearer '+sess.access_token },
      body: JSON.stringify({ planId:p.id, teamId: au.plan.key==='team'?cloudTeamId():null, seats: (au.plan.key==='team'&&p.per_seat)?au.plan.seats:1 }) });
    j=await r.json().catch(()=>null);
  }catch(e){ // só é "sem conexão" quando o fetch diz isso; o resto (AbortError, bug) cai no genérico
    const net=/failed to fetch|load failed|networkerror/i.test(String((e&&e.message)||e||''));
    au.msg=auCheckoutErr(0, null, net?{ network:true, message:String(e&&e.message||'') }:e); au.busy=false; auRender(); return; }
  // 200 sem url: a function respondeu fora do contrato — vai pro app_errors (o suporte acha) e a pessoa sabe que não é com ela
  if(r.ok && (!j || !j.url)){
    try{ if(window.logAppError) window.logAppError('checkout', new Error('stripe-checkout 200 sem url'), { plan:au.plan.key, interval:au.plan.interval }); }catch(_){ }
    au.msg='A página de pagamento não abriu — o problema é do nosso lado e já foi registrado. Tente de novo em alguns minutos.'; au.busy=false; auRender(); return; }
  if(!r.ok){ au.msg=auCheckoutErr(r.status, j); au.busy=false; auRender(); return; }
  try{ await invoke('open_url',{ url:j.url }); }catch(_){ window.open(j.url); }
  au.waiting=true; au.busy=false; auRender();
  if(_auTimer) clearInterval(_auTimer);
  _auTimer=setInterval(async()=>{ if(au.step!=='pay'||!auOpen()){ clearInterval(_auTimer); _auTimer=null; return; } try{ await billingSync(); }catch(_){ } if(billingActive()){ clearInterval(_auTimer); _auTimer=null; auShow('ready'); } }, 5000);
}
// ---- gates: substituem o cadeado do cloudOverlay e o payOverlay antigo ----
loginGateSync=function(){
  if(typeof SF_PANE!=='undefined' && SF_PANE) return; // painel da tela dividida: o login é da janela principal
  const ov=$id('cloudOverlay'); if(ov){ ov.dataset.lock=''; ov.style.zIndex=''; const x=$id('cloudClose'); if(x) x.style.display=''; if(ov.style.display==='flex'&&!SB.sess()) ov.style.display='none'; }
  if(!SB.sess()){
    if(!auOpen()||!['login','signup','confirm','newpass'].includes(au.step)){
      // sessão caiu sozinha (refresh_token inválido): aviso amigável em vez de erro cru
      const ended=lsGet('sb:ended')==='expired'; if(ended) lsSet('sb:ended','');
      auShow(lsGet('sb:email')?'login':'signup', Object.assign({ fromGate:true, email:lsGet('sb:email')||au.email }, ended?{ msg:T('auth.expired'), msgKind:'info' }:{}));
    }
  }
  else if(auOpen() && ['login','signup'].includes(au.step)) auHide();
};
payShow=function(){ if(!auOpen()||!['plans','pay'].includes(au.step)) auShow('plans'); };
payHide=function(){ if(auOpen() && ['plans','pay'].includes(au.step) && !au.waiting) auHide(); };
setTimeout(()=>loginGateSync(), 3200);
