// Constellation — 44-onboarding: entrada e assinatura (design "onboarding-planos").
// Telas: criar conta · entrar · confirmar e-mail (código de 6 dígitos) · nova senha · planos · pagamento · pronto.
// Tudo fala com o Supabase (GoTrue) e com a function stripe-checkout que já existem.
// Substitui o gate de login do cloudOverlay e o payOverlay (as duas funções são reapontadas no fim).
const AU_STEPS_ORDER=['signup','confirm','plans','pay','ready'];
// pra onde o LINK do e-mail leva (alternativa ao código): páginas do site
const AU_SITE='https://constellation-ai-v1.lovable.app';
const auRedir=path=>'?redirect_to='+encodeURIComponent(AU_SITE+path);
// Esqueci a senha: pede o CÓDIGO de 6 dígitos e abre a tela pra digitá-lo. O link do e-mail não entra no fluxo —
// a página /redefinir-senha do site não existe e clicar num link consumiria o código. Serve o login novo e o painel Conta.
async function auRecover(email){ await sbAuth('recover'+auRedir('/redefinir-senha'),{ email }); lsSet('sb:email',email); au.email=email; au.confirmType='recovery'; au.resendAt=Date.now()+60000; au.msg=''; auShow('confirm'); }
let au={ step:'login', email:lsGet('sb:email')||'', name:'', confirmType:'signup', msg:'', busy:false, resendAt:0, plan:{ key:'team', interval:'month', seats:5 }, fromGate:false, waiting:false, backTo:null };
let _auTimer=null;
function auEl(){ return $id('authOverlay'); }
function auShow(step, opts){
  Object.assign(au, opts||{}); if(step) au.step=step; au.msg=''; au.busy=false;
  const o=auEl(); if(!o) return; o.style.display='flex'; auRender(); try{ cosmosStart(o); }catch(_){ }
}
function auHide(){ const o=auEl(); if(o) o.style.display='none'; au.waiting=false; if(_auTimer){ clearInterval(_auTimer); _auTimer=null; } }
function auOpen(){ return !!auEl() && auEl().style.display!=='none'; }
// ---- copy da coluna esquerda por tela (do design) ----
const AU_LEFT={
  signup:{ h:'Sua equipe de agentes, rodando na sua máquina', s:'Cada tarefa ganha branch e worktree isoladas. Nada some, nada colide.', b:[['g','Escreva a demanda com requisitos claros'],['c','Agentes em paralelo, um por branch'],['p','Aprove a entrega e o PR abre sozinho']], f:'pareado com este Mac' },
  login:{ h:'Bem-vindo de volta ao cockpit', s:'Suas demandas continuam aqui — entre pra ver o que rodou enquanto você esteve fora.', b:[['g','Tarefas em órbita ficam visíveis pro time'],['c','Custo por tarefa, sempre à vista'],['p','PRs prontos pra merge num clique']], f:'sessão local · nada sai da sua máquina' },
  confirm:{ h:'Um passo e a constelação acende', s:'O código confirma que o e-mail é seu e liga sua conta à organização certa.', b:[['g','O link do e-mail também funciona'],['c','Você entra como membro; o lead aprova'],['p','Dá pra trocar de time depois']], f:'código expira em 10 minutos' },
  newpass:{ h:'Nova senha, mesma constelação', s:'Defina a senha nova — suas demandas, times e chaves continuam onde estavam.', b:[['g','8+ caracteres'],['c','Vale em todos os seus Macs'],['p','Sessões antigas continuam válidas']], f:'a senha nunca sai da sua máquina em texto' },
  ready:{ h:'Tudo pronto — falta só o repo', s:'Sua conta está ativa nesta máquina. Conecte o repositório e escreva a primeira demanda.', b:[['g','Ambiente checado automaticamente'],['c','Workflows do time já sincronizados'],['p','Companion mobile pareado']], f:'teste em andamento' },
};
const AU_DOT={ g:'#3fdd8a', c:'#5ec8c8', p:'#c493bb' };
function auLeftHtml(step){
  const L=AU_LEFT[step]||AU_LEFT.signup;
  return `<canvas class="cosmos-c au-sky"></canvas><div class="au-lin">
    <div class="au-brand"><span class="au-logo">C</span><span class="au-brandt">CONSTELLATION</span></div>
    <h1 class="au-h1">${esc(L.h)}</h1><p class="au-sub">${esc(L.s)}</p>
    <div class="au-bul">${L.b.map(([c,t])=>`<div class="au-b"><i style="background:${AU_DOT[c]}"></i>${esc(t)}</div>`).join('')}</div>
    <div class="au-foot"><i></i>${esc(L.f)}</div></div>`;
}
function auProgress(n){ return `<div class="au-prog">${[1,2,3].map(i=>`<i class="${i<=n?'on':''}"></i>`).join('')}<span>passo ${n} de 3</span></div>`; }
function auMsg(){ return au.msg?`<div class="au-msg${au.msg.startsWith('✓')?' ok':''}">${au.msg}</div>`:''; }
function auErr(e){ let m=(e&&e.message)||String(e); if(/already registered|user_already/i.test(m)) m='este e-mail já tem conta — use "já tenho conta".'; else if(/invalid login credentials/i.test(m)) m='e-mail ou senha incorretos.'; else if(/email not confirmed/i.test(m)) m='confirme o e-mail primeiro — use o código que enviamos.'; else if(/rate limit|too many/i.test(m)) m='muitas tentativas — espere um minuto e tente de novo.'; else if(/token has expired|otp_expired|invalid token|Token has expired/i.test(m)) m='código inválido ou expirado — peça um novo.'; return m; }
function auValidEmail(v){ return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v||''); }
// ---- fluxo pós-sessão: planos (se a cobrança está ligada e não há assinatura) → pronto ----
async function auAfterSession(){
  try{ await cloudLoad(); }catch(_){ }
  try{ cloudBtnSync(); }catch(_){ }
  try{ await billingSync(); }catch(_){ }
  if(typeof billingOn!=='undefined' && billingOn && !billingActive()){ auShow('plans'); return; }
  auShow('ready');
}
// ---- telas da coluna direita ----
function auRender(){
  const o=auEl(); if(!o) return;
  // planos e pagamento ocupam a tela toda (como no design); as outras telas têm a coluna da esquerda
  o.querySelector('.au-wrap').classList.toggle('full', au.step==='plans'||au.step==='pay');
  $id('auLeft').innerHTML=auLeftHtml(au.step==='plans'||au.step==='pay'?'ready':au.step);
  const R=$id('auRight'); const s=au.step;
  const dis=au.busy?' disabled':'';
  const topbar=`<div class="au-top"><span class="au-topl mono">${esc(({signup:'criar conta',login:'entrar',confirm:'confirmar e-mail',newpass:'nova senha',plans:'planos',pay:'pagamento',ready:'bem-vindo'})[s]||'')}</span><span style="flex:1"></span>${SB.sess()&&s!=='ready'?`<button class="au-link" id="auLogout">sair da conta</button>`:''}${au.backTo?`<button class="au-link" id="auBack">← voltar</button>`:''}</div>`;
  if(s==='signup'){
    R.innerHTML=topbar+`<div class="au-form">${auProgress(1)}<h2 class="au-h2">Criar conta</h2><p class="au-p">Use o e-mail do trabalho — é assim que a gente liga você ao time certo.</p>${auMsg()}
      <label class="au-lbl">Nome</label><input class="au-in" id="auName" placeholder="como o time te chama" value="${escA(au.name)}"${dis}>
      <label class="au-lbl">E-mail de trabalho</label><input class="au-in" id="auEmail" type="email" placeholder="voce@empresa.com" value="${escA(au.email)}"${dis}>
      <label class="au-lbl">Senha</label><input class="au-in" id="auPass" type="password" placeholder="mínimo 8 caracteres"${dis}><div class="au-strength" id="auStr"><i></i><i></i><i></i><i></i><span>use 8+ caracteres</span></div>
      <div class="au-row"><button class="au-btn primary" id="auGo"${dis}>${au.busy?'criando…':'Continuar'}</button><button class="au-btn" id="auGh"${dis}>${AU_GH} GitHub</button><button class="au-btn" id="auGoogle"${dis}>${AU_GG} Google</button><span style="flex:1"></span><button class="au-link" id="auToLogin">já tenho conta</button></div>
      <div class="au-legal">Ao continuar você aceita os <a data-ext="https://constellation.ai/termos">termos</a> e a <a data-ext="https://constellation.ai/privacidade">privacidade</a>.</div></div>`;
    const go=async()=>{ au.name=$id('auName').value.trim(); au.email=$id('auEmail').value.trim(); const pass=$id('auPass').value;
      if(!auValidEmail(au.email)){ au.msg='informe um e-mail válido.'; auRender(); return; } if(pass.length<8){ au.msg='a senha precisa de 8+ caracteres.'; auRender(); return; }
      au.busy=true; auRender(); lsSet('sb:email',au.email);
      try{ const j=await sbAuth('signup'+auRedir('/confirmado'),{ email:au.email, password:pass, data:{ name:au.name } });
        if(j.access_token){ SB.setSess(j); await auAfterSession(); return; }
        au.confirmType='signup'; au.resendAt=Date.now()+60000; auShow('confirm'); }
      catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); } };
    bindClick('auGo', go); bindClick('auToLogin', ()=>auShow('login'));
    bindClick('auGh', ()=>auOAuth('github')); bindClick('auGoogle', ()=>auOAuth('google'));
    { const p=$id('auPass'); if(p){ p.oninput=()=>{ const n=Math.min(4,Math.floor(p.value.length/3)); $id('auStr').querySelectorAll('i').forEach((i,k)=>i.classList.toggle('on',k<n)); }; p.onkeydown=e=>{ if(e.key==='Enter') go(); }; } }
  }
  else if(s==='login'){
    R.innerHTML=topbar+`<div class="au-form"><div class="au-eyebrow">bem-vindo de volta</div><h2 class="au-h2">Entrar</h2><p class="au-p">Entre pra ver o que rodou enquanto você esteve fora.</p>${auMsg()}
      <label class="au-lbl">E-mail</label><input class="au-in" id="auEmail" type="email" placeholder="voce@empresa.com" value="${escA(au.email)}"${dis}>
      <label class="au-lbl" style="display:flex;align-items:center">Senha<span style="flex:1"></span><button class="au-link" id="auForgot">esqueci</button></label><input class="au-in" id="auPass" type="password" placeholder="sua senha"${dis}>
      <div class="au-row"><button class="au-btn primary" id="auGo"${dis}>${au.busy?'entrando…':'Entrar'}</button><button class="au-btn outline" id="auMagic"${dis}>Link mágico</button><button class="au-btn" id="auGh"${dis}>${AU_GH}</button><button class="au-btn" id="auGoogle"${dis}>${AU_GG}</button></div>
      <div class="au-legal">Ainda não tem conta? <a id="auToSignup">criar agora</a></div></div>`;
    const go=async()=>{ au.email=$id('auEmail').value.trim(); const pass=$id('auPass').value;
      if(!auValidEmail(au.email)){ au.msg='informe um e-mail válido.'; auRender(); return; } if(!pass){ au.msg='digite a senha (ou use o link mágico).'; auRender(); return; }
      au.busy=true; auRender(); lsSet('sb:email',au.email);
      try{ const j=await sbAuth('token?grant_type=password',{ email:au.email, password:pass }); SB.setSess(j); await auAfterSession(); }
      catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); } };
    bindClick('auGo', go); bindClick('auToSignup', ()=>auShow('signup'));
    bindClick('auGh', ()=>auOAuth('github')); bindClick('auGoogle', ()=>auOAuth('google'));
    bindClick('auForgot', async()=>{ au.email=$id('auEmail').value.trim(); if(!auValidEmail(au.email)){ au.msg='digite seu e-mail acima — o código de recuperação vai pra ele.'; auRender(); return; }
      au.busy=true; auRender(); try{ await auRecover(au.email); }catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); } });
    bindClick('auMagic', async()=>{ au.email=$id('auEmail').value.trim(); if(!auValidEmail(au.email)){ au.msg='digite seu e-mail acima — o link mágico vai pra ele.'; auRender(); return; }
      au.busy=true; auRender(); try{ await sbAuth('otp'+auRedir('/confirmado'),{ email:au.email, create_user:false }); lsSet('sb:email',au.email); au.confirmType='magiclink'; au.resendAt=Date.now()+60000; auShow('confirm'); }catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); } });
    { const p=$id('auPass'); if(p) p.onkeydown=e=>{ if(e.key==='Enter') go(); }; }
  }
  else if(s==='confirm'){
    const what=au.confirmType==='recovery'?'recuperação':au.confirmType==='magiclink'?'acesso':'confirmação';
    const left=Math.max(0,Math.ceil((au.resendAt-Date.now())/1000));
    R.innerHTML=topbar+`<div class="au-form">${au.confirmType==='signup'?auProgress(2):''}<h2 class="au-h2">${au.confirmType==='recovery'?'Código de recuperação':'Confirme o e-mail'}</h2><p class="au-p">Mandamos um código de 6 dígitos de ${what} para <b class="mono">${esc(au.email)}</b></p>${auMsg()}
      <div class="au-code" id="auCode">${[0,1,2,3,4,5].map(i=>`<input inputmode="numeric" maxlength="1" data-ci="${i}"${dis}>`).join('')}</div>
      <div class="au-row"><button class="au-btn primary" id="auGo"${dis}>${au.busy?'confirmando…':'Confirmar'}</button><span class="au-hint">não chegou? ${left>0?`<span id="auResendIn">reenviar em 0:${String(left).padStart(2,'0')}</span>`:`<a id="auResend">reenviar código</a>`}</span></div>
      <div class="au-legal">${au.confirmType==='signup'?'Confirmou pelo link do e-mail? <a id="auToLogin">entrar com a senha</a>.':au.confirmType==='recovery'?'O código vale 10 minutos. Não chegou? Confira o spam ou toque em reenviar. Lembrou a senha? <a id="auToLogin">entrar</a>.':'Prefere o link do e-mail? Ele também funciona — depois volte aqui e <a id="auToLogin">entre</a>.'}${au.confirmType==='recovery'?'':'<br>Se o e-mail veio só com o link e sem código, peça pro admin incluir <code>{{ .Token }}</code> nos templates (Supabase → Auth → Email Templates).'}</div></div>`;
    const inputs=[...R.querySelectorAll('[data-ci]')];
    const code=()=>inputs.map(i=>i.value).join('');
    const go=async()=>{ const t=code(); if(t.length<6){ au.msg='digite os 6 dígitos.'; auRender(); return; }
      au.busy=true; auRender();
      try{ const j=await sbAuth('verify',{ type:au.confirmType==='magiclink'?'magiclink':au.confirmType, email:au.email, token:t });
        if(!j.access_token) throw new Error('o código foi aceito mas não veio sessão — entre com a senha.');
        SB.setSess(j); if(au.confirmType==='recovery'){ auShow('newpass'); return; } await auAfterSession(); }
      catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); } };
    inputs.forEach((inp,i)=>{
      inp.oninput=()=>{ inp.value=inp.value.replace(/\D/g,'').slice(-1); if(inp.value&&inputs[i+1]) inputs[i+1].focus(); if(code().length===6) go(); };
      inp.onkeydown=e=>{ if(e.key==='Backspace'&&!inp.value&&inputs[i-1]) inputs[i-1].focus(); if(e.key==='Enter') go(); };
      inp.onpaste=e=>{ const v=(e.clipboardData.getData('text')||'').replace(/\D/g,'').slice(0,6); if(v.length){ e.preventDefault(); [...v].forEach((c,k)=>{ if(inputs[k]) inputs[k].value=c; }); (inputs[v.length]||inputs[5]).focus(); if(v.length===6) go(); } };
    });
    if(inputs[0]&&!au.busy) inputs[0].focus();
    bindClick('auGo', go); bindClick('auToLogin', ()=>auShow('login'));
    bindClick('auResend', async()=>{ au.busy=true; auRender(); try{
        if(au.confirmType==='signup') await sbAuth('resend'+auRedir('/confirmado'),{ type:'signup', email:au.email }); else if(au.confirmType==='recovery') await sbAuth('recover'+auRedir('/redefinir-senha'),{ email:au.email }); else await sbAuth('otp'+auRedir('/confirmado'),{ email:au.email, create_user:false });
        au.resendAt=Date.now()+60000; au.msg='✓ código reenviado'; }catch(e){ au.msg='Falhou: '+auErr(e); } au.busy=false; auRender(); });
    if(left>0){ if(_auTimer) clearInterval(_auTimer); _auTimer=setInterval(()=>{ if(au.step!=='confirm'||!auOpen()){ clearInterval(_auTimer); _auTimer=null; return; } const l=Math.max(0,Math.ceil((au.resendAt-Date.now())/1000)); const e=$id('auResendIn'); if(!e||l<=0){ clearInterval(_auTimer); _auTimer=null; auRender(); return; } e.textContent='reenviar em 0:'+String(l).padStart(2,'0'); },1000); }
  }
  else if(s==='newpass'){
    R.innerHTML=topbar+`<div class="au-form"><div class="au-eyebrow">segurança</div><h2 class="au-h2">Definir nova senha</h2><p class="au-p">${SB.sess()?'Você está autenticado — escolha a senha nova.':'Sessão expirada — entre de novo e repita "esqueci".'}</p>${auMsg()}
      <label class="au-lbl">Nova senha</label><input class="au-in" id="auPass" type="password" placeholder="mínimo 8 caracteres"${dis}>
      <label class="au-lbl">Repita a senha</label><input class="au-in" id="auPass2" type="password" placeholder="igual à de cima"${dis}>
      <div class="au-row"><button class="au-btn primary" id="auGo"${dis}>${au.busy?'salvando…':'Salvar senha'}</button>${au.backTo?'':'<button class="au-link" id="auToLogin">voltar pra entrar</button>'}</div></div>`;
    const go=async()=>{ const a=$id('auPass').value, b=$id('auPass2').value; if(a.length<8){ au.msg='a senha precisa de 8+ caracteres.'; auRender(); return; } if(a!==b){ au.msg='as senhas não conferem.'; auRender(); return; }
      au.busy=true; auRender();
      try{ await sbFetch('/auth/v1/user',{ method:'PUT', body: JSON.stringify({ password:a }) }); au.msg=''; if(au.backTo){ const b2=au.backTo; au.backTo=null; auHide(); if(typeof b2==='function') b2(); else alert('✓ senha alterada'); return; } await auAfterSession(); }
      catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); } };
    bindClick('auGo', go); bindClick('auToLogin', ()=>auShow('login'));
  }
  else if(s==='plans'){ auRenderPlans(R, topbar); }
  else if(s==='pay'){ auRenderPay(R, topbar); }
  else if(s==='ready'){
    const seats=(myBilling&&myBilling.seats)||au.plan.seats||1, planName=(myBilling&&myBilling.plan==='team')?'Time':(myBilling&&myBilling.plan==='enterprise')?'Organização':(myBilling?'Solo':'');
    const trial=(myBilling&&myBilling.status==='trialing'&&myBilling.trial_end)?Math.max(0,Math.ceil((new Date(myBilling.trial_end)-Date.now())/864e5)):0;
    const hasRepo=!!(state&&state.repo);
    R.innerHTML=topbar+`<div class="au-form au-center"><div class="au-check">✓</div><h2 class="au-h2">Constelação ativa</h2><p class="au-p">${trial?`Teste de ${trial} dias começou. `:''}${planName?`${seats} assento${seats===1?'':'s'} no plano ${planName}, ativos neste Mac.`:'Sua conta está ativa neste Mac.'}</p>
      <div class="au-todo"><div class="au-td"><span class="au-tn" style="background:#3fdd8a">1</span><span>Conectar o repositório que os agentes vão trabalhar</span>${hasRepo?'<span class="au-tdone">✓ conectado</span>':'<button class="au-link" id="auRepo">conectar</button>'}</div>
        <div class="au-td"><span class="au-tn" style="background:#5ec8c8">2</span><span>Checar o ambiente: Node, Git, Claude Code e gh</span><button class="au-link" id="auEnv">verificar</button></div>
        <div class="au-td"><span class="au-tn" style="background:#c493bb">3</span><span>Convidar o time${seats>1?` — assentos livres: ${Math.max(0,seats-1)}`:''}</span><button class="au-link" id="auTeam">convidar</button></div></div>
      <button class="au-btn primary big" id="auGo">Abrir o cockpit</button></div>`;
    bindClick('auGo', ()=>{ auHide(); try{ if(window.openTab) window.openTab('flow'); }catch(_){ } });
    bindClick('auRepo', ()=>{ if(window.pickFolder) window.pickFolder().then(()=>auRender()); });
    bindClick('auEnv', ()=>{ auHide(); if(window.openTab) window.openTab('env'); });
    bindClick('auTeam', ()=>{ auHide(); if(window.openTab) window.openTab('conta'); });
  }
  bindClick('auLogout', ()=>{ SB.setSess(null); cloudData=null; try{ cloudBtnSync(); }catch(_){ } auShow('login'); });
  bindClick('auBack', ()=>{ const b=au.backTo; au.backTo=null; auHide(); if(typeof b==='function') b(); });
  R.querySelectorAll('[data-ext]').forEach(a=>a.onclick=()=>openExternal(a.dataset.ext));
}
const AU_GH='<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 .4a7.6 7.6 0 0 0-2.4 14.8c.4.1.5-.2.5-.4v-1.3c-2.1.5-2.6-1-2.6-1-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.2.6.1-.5.3-.8.5-1-1.7-.2-3.5-.8-3.5-3.7 0-.8.3-1.5.8-2-.1-.2-.3-1 .1-2 0 0 .6-.2 2.1.8a7.3 7.3 0 0 1 3.8 0c1.5-1 2.1-.8 2.1-.8.4 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.5 3.7.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.6 7.6 0 0 0 8 .4z"/></svg>';
const AU_GG='<svg viewBox="0 0 18 18" width="14" height="14"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
async function auOAuth(provider){
  au.busy=true; au.msg='Abrindo o '+(provider==='github'?'GitHub':'Google')+' no navegador — conclua o login lá e volte.'; auRender();
  try{ await loginOAuth(provider); au.msg=''; if(SB.sess()) await auAfterSession(); else { au.busy=false; auRender(); } }
  catch(e){ au.msg='Falhou: '+auErr(e); au.busy=false; auRender(); }
}
// ---- planos (lê billing_plans; sem seed mostra os preços do design, sem checkout) ----
const AU_PLAN_DEFAULTS=[
  { key:'individual', name:'Solo', who:'1 pessoa, 1 repo', perSeat:false, feats:['1 agente por vez, sem fila','Branch + worktree isolada por tarefa','Histórico de 30 dias'] },
  { key:'team', name:'Time', who:'squads de 3 a 12', perSeat:true, hot:true, feats:['Agentes em paralelo, sem limite de fila','Workflows e personas compartilhados','Daily automática e custo por pessoa','Preferências do projeto sincronizadas'] },
  { key:'enterprise', name:'Organização', who:'vários times e repos', feats:['Tudo do Time, sem teto de assentos','SSO, auditoria e política por repo','Chaves de modelo próprias (BYOK)','Suporte dedicado'] },
];
const AU_FALLBACK_PRICE={ individual:{month:4900,year:3900}, team:{month:3900,year:3100} };
function auPlanRow(key, interval){ return (billingPlans||[]).find(p=>p.plan===key&&p.interval===interval); }
// preço por assento (per_seat) ou fechado por time (planos antigos: amount = time inteiro, seats = teto)
function auPerSeat(key, interval){ const p=auPlanRow(key, interval); return p ? !!p.per_seat : key==='team'; }
function auSeatsOf(key){ const p=auPlanRow(key, au.plan.interval); return (key==='team' && p && !p.per_seat) ? (p.seats||1) : (key==='team' ? au.plan.seats : 1); }
function auPrice(key, interval){ const p=auPlanRow(key, interval); return p?p.amount_cents:(AU_FALLBACK_PRICE[key]||{})[interval]||0; }
function auTotal(){ const per=auPrice(au.plan.key, au.plan.interval); return auPerSeat(au.plan.key, au.plan.interval) ? per*auSeatsOf(au.plan.key) : per; }
function auRenderPlans(R, topbar){
  const iv=au.plan.interval, hasPlans=!!(billingPlans&&billingPlans.length);
  const cards=AU_PLAN_DEFAULTS.map(p=>{
    const on=au.plan.key===p.key; const price=p.key==='enterprise'?null:auPrice(p.key,iv); const ps=auPerSeat(p.key,iv); const row=auPlanRow(p.key,iv);
    return `<button class="au-plan${on?' on':''}${p.hot?' hot':''}" data-plan="${p.key}"><div class="au-plh"><span class="au-pldot"></span><b>${esc(p.name)}</b>${p.hot?'<span class="au-badge">mais usado</span>':''}<span class="au-plwho">${esc(p.who)}</span></div>
      <div class="au-plprice">${price==null?'<b>sob consulta</b><span>fale com vendas</span>':`<b>${fmtBRL(price).replace(',00','')}</b><span>${p.key==='team'&&!ps?`por time (até ${(row&&row.seats)||6} assentos)`:`por ${p.perSeat?'assento':'pessoa'}`}/${iv==='year'?(ps||p.key!=='team'?'mês, no anual':'ano'):'mês'}</span>`}</div>
      <ul class="au-plf">${p.feats.map(f=>`<li>${esc(f)}</li>`).join('')}</ul></button>`; }).join('');
  const total=auTotal(); const perSeat=auPerSeat(au.plan.key,iv); const seats=auSeatsOf(au.plan.key); const isEnt=au.plan.key==='enterprise';
  const trial=(auPlanRow(au.plan.key,iv)||{}).trial_days||14;
  R.innerHTML=topbar+`<div class="au-form wide">${auProgress(3)}<div class="au-plhead"><div><h2 class="au-h2">Escolha o plano</h2><p class="au-p">Você paga pelos assentos. O custo dos modelos é cobrado à parte, sempre visível na tarefa.</p></div><div class="au-seg"><button class="${iv==='month'?'on':''}" data-iv="month">mensal</button><button class="${iv==='year'?'on':''}" data-iv="year">anual <i>-20%</i></button></div></div>${auMsg()}
    <div class="au-plans">${cards}</div>
    <div class="au-plinv"><span class="au-hint">Sua empresa já usa o Constellation? <a id="auInvite">tenho um convite / verificar</a></span></div>
    <div class="au-plbar">${isEnt?`<div class="au-plsum"><span class="au-lbl" style="margin:0">Organização</span><b>Vamos montar junto</b><span class="au-hint">SSO, política por repo e chaves próprias — fale com a gente.</span></div><span style="flex:1"></span><button class="au-btn primary big" id="auSales">Falar com vendas</button>`:
      `${au.plan.key==='team'&&perSeat?`<div class="au-seats"><span class="au-lbl" style="margin:0">assentos</span><div class="au-step"><button id="auSeatM">−</button><b>${seats}</b><button id="auSeatP">+</button></div></div>`:''}<div class="au-plsum"><span class="au-lbl" style="margin:0">total</span><b>${fmtBRL(total).replace(',00','')} <small>/${iv==='year'&&!perSeat&&au.plan.key==='team'?'ano':'mês'}</small></b><span class="au-hint">${perSeat&&seats>1?`${seats} assentos × ${fmtBRL(auPrice(au.plan.key,iv)).replace(',00','')} por mês · `:(au.plan.key==='team'&&!perSeat?`até ${seats} assentos · `:'')}custo de modelo à parte${iv==='year'?' · cobrado anualmente':''}</span></div><span style="flex:1"></span><div class="au-plcta"><button class="au-btn primary big" id="auGo"${hasPlans?'':' disabled'}>Continuar para o pagamento</button><span class="au-hint">${hasPlans?`${trial} dias grátis · cancele quando quiser`:'cobrança ainda não ativada neste backend (BILLING-SETUP.md)'}</span></div>`}</div></div>`;
  R.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>{ au.plan.key=b.dataset.plan; auRender(); });
  R.querySelectorAll('[data-iv]').forEach(b=>b.onclick=()=>{ au.plan.interval=b.dataset.iv; auRender(); });
  bindClick('auSeatM', ()=>{ au.plan.seats=Math.max(1,au.plan.seats-1); auRender(); });
  bindClick('auSeatP', ()=>{ const cap=(auPlanRow('team',iv)||{}).seats||12; au.plan.seats=Math.min(cap,au.plan.seats+1); auRender(); });
  bindClick('auGo', ()=>auShow('pay'));
  bindClick('auSales', ()=>openExternal('mailto:vendas@constellation.ai?subject=Plano%20Organiza%C3%A7%C3%A3o%20Constellation'));
  bindClick('auInvite', async()=>{
    const tok=await askText('Convite do time','cole o token que o lead te mandou (se o convite foi pro seu e-mail, normalmente entra sozinho — deixe vazio pra só verificar)', '');
    if(tok===null) return;
    au.busy=true; au.msg=''; auRender();
    try{
      if(tok.trim()){ const j=await sbRpc('accept_invite',{ p_token:tok.trim() }); if(!j.ok) throw new Error(j.error); lsSet('sb:team', j.team_id); }
      cloudData=null; cloudAutoInvTried=false; await cloudLoad(); await billingSync();
      if(billingActive()){ au.busy=false; auShow('ready'); return; }
      au.msg=tok.trim()?'entrou no time, mas a organização não tem plano ativo — fale com o admin.':'nenhum convite pendente pro seu e-mail.';
    }catch(e){ au.msg=auErr(e); }
    au.busy=false; auRender();
  });
}
function auRenderPay(R, topbar){
  const p=auPlanRow(au.plan.key, au.plan.interval); const iv=au.plan.interval; const perSeat=auPerSeat(au.plan.key,iv); const seats=auSeatsOf(au.plan.key);
  const per=auPrice(au.plan.key,iv), total=auTotal(); const trial=(p&&p.trial_days)||14;
  const first=new Date(Date.now()+trial*864e5).toLocaleDateString('pt-BR');
  const name=(AU_PLAN_DEFAULTS.find(x=>x.key===au.plan.key)||{}).name||au.plan.key;
  R.innerHTML=topbar+`<div class="au-pay"><div class="au-payl"><button class="au-link" id="auToPlans">← planos</button><h2 class="au-h2">Pagamento</h2>${auMsg()}
      <div class="au-methods"><button class="on">Cartão</button><button>Pix</button><button>Boleto/NF</button></div>
      <p class="au-p">O pagamento acontece numa página segura da <b>Stripe</b>, no seu navegador — o cartão nunca passa pelo app. Cartão, Pix e boleto ficam disponíveis lá.</p>
      ${au.waiting?`<div class="au-wait">${cosmosHtml('esperando a confirmação da Stripe…','inline')}<div class="au-hint">Concluiu o pagamento? O app reconhece sozinho em instantes. <a id="auRecheck">verificar agora</a></div></div>`:`<button class="au-btn primary big" id="auGo">Começar teste de ${trial} dias</button><div class="au-hint" style="margin-top:10px">Sem cobrança agora. Avisamos 3 dias antes de renovar.</div>`}
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
async function auCheckout(){
  const p=auPlanRow(au.plan.key, au.plan.interval); if(!p){ au.msg='plano não encontrado no backend.'; auRender(); return; }
  if(au.plan.key==='team' && !cloudTeamId()){ au.msg='pra assinar o plano Time, crie ou entre num time primeiro (Conta → Sua organização).'; auRender(); return; }
  au.busy=true; auRender();
  try{
    const r=await fetch(SB.url()+'/functions/v1/stripe-checkout',{ method:'POST', headers:{ 'Content-Type':'application/json', 'apikey':SB.key(), 'Authorization':'Bearer '+SB.sess().access_token },
      body: JSON.stringify({ planId:p.id, teamId: au.plan.key==='team'?cloudTeamId():null, seats: (au.plan.key==='team'&&p.per_seat)?au.plan.seats:1 }) });
    const j=await r.json(); if(!j.url) throw new Error(j.error||('HTTP '+r.status));
    try{ await invoke('open_url',{ url:j.url }); }catch(_){ window.open(j.url); }
    au.waiting=true; au.busy=false; auRender();
    if(_auTimer) clearInterval(_auTimer);
    _auTimer=setInterval(async()=>{ if(au.step!=='pay'||!auOpen()){ clearInterval(_auTimer); _auTimer=null; return; } try{ await billingSync(); }catch(_){ } if(billingActive()){ clearInterval(_auTimer); _auTimer=null; auShow('ready'); } }, 5000);
  }catch(e){ au.msg='Não consegui abrir o checkout: '+auErr(e); au.busy=false; auRender(); }
}
// ---- gates: substituem o cadeado do cloudOverlay e o payOverlay antigo ----
loginGateSync=function(){
  const ov=$id('cloudOverlay'); if(ov){ ov.dataset.lock=''; ov.style.zIndex=''; const x=$id('cloudClose'); if(x) x.style.display=''; if(ov.style.display==='flex'&&!SB.sess()) ov.style.display='none'; }
  if(!SB.sess()){ if(!auOpen()||!['login','signup','confirm','newpass'].includes(au.step)) auShow(lsGet('sb:email')?'login':'signup', { fromGate:true }); }
  else if(auOpen() && ['login','signup'].includes(au.step)) auHide();
};
payShow=function(){ if(!auOpen()||!['plans','pay'].includes(au.step)) auShow('plans'); };
payHide=function(){ if(auOpen() && ['plans','pay'].includes(au.step) && !au.waiting) auHide(); };
setTimeout(loginGateSync, 3200);
