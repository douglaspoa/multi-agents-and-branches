// Constellation — 40-nuvem-conta
/* ============================================================================
   TIME NA NUVEM (F1) — Supabase via fetch puro, zero dependência.
   Estados: setup (URL+anon key) → login → sem-org (criar org/aceitar convite)
   → home (org, times, membros, convites, seletor de time atual).
   RLS mora no banco; aqui só autentica e consome /auth/v1 + /rest/v1.
   ========================================================================= */
// Padrão: NUVEM (projeto Supabase do Constellation) — anon key é pública por
// design; o RLS protege os dados. "backend…" na tela de login troca o alvo
// (localStorage tem precedência) e SB_LOCAL volta pro stack de dev.
const SB_DEFAULT = { url: 'https://fivoakrhazlzcdoocgbg.supabase.co', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpdm9ha3JoYXpsemNkb29jZ2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjcxOTcsImV4cCI6MjEwMzYwMzE5N30.NXr1RjGqhcYHfMU050PRBcBraXsAYw-4FUVyoo3RC8U' };
const SB_LOCAL = { url: 'http://127.0.0.1:54341', key: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' };
const SB = {
  url(){ return (lsGet('sb:url') || SB_DEFAULT.url || '').replace(/\/+$/,''); },
  key(){ return lsGet('sb:key') || SB_DEFAULT.key || ''; },
  sess(){ try{ return JSON.parse(lsGet('sb:sess')||'null'); }catch(_){ return null; } },
  setSess(s){ if(s) lsSet('sb:sess', JSON.stringify(s)); else lsSet('sb:sess',''); },
  configured(){ return !!(this.url() && this.key()); },
};
// "Load failed"/"Failed to fetch" é o WebView dizendo que a REDE falhou — sem
// dizer pra onde. Traduzimos nomeando o host, porque a causa nº1 é um sb:url
// antigo (stack local) preso no localStorage de instalações velhas.
function sbNetErr(){
  let host=''; try{ host=new URL(SB.url()).host; }catch(_){ host=SB.url(); }
  const custom=!!lsGet('sb:url') && SB.url()!==SB_DEFAULT.url;
  const isLocal=/localhost|127\.0\.0\.1/.test(SB.url());
  let m='sem conexão com '+host;
  if(custom&&isLocal) m+=' — este app está apontando pra um backend LOCAL que não está rodando. Clique em "backend…" → "usar nuvem (padrão)".';
  else if(custom) m+=' — backend personalizado configurado. Confira em "backend…" ou clique em "usar nuvem (padrão)".';
  else m+=' — verifique sua internet/VPN (a rede pode estar bloqueando o Supabase).';
  return new Error(m);
}
async function sbAuth(path, body){
  const r = await fetch(SB.url()+'/auth/v1/'+path, { method:'POST', headers:{ 'apikey':SB.key(), 'Content-Type':'application/json' }, body: JSON.stringify(body) }).catch(()=>{ throw sbNetErr(); });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error_description || j.msg || j.message || ('auth falhou ('+r.status+')'));
  return j;
}
// ---- Login social Google (OAuth PKCE + callback local) ----
function b64url(bytes){ return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function pkcePair(){
  const rnd=new Uint8Array(48); crypto.getRandomValues(rnd);
  const verifier=b64url(rnd);
  const hash=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge:b64url(new Uint8Array(hash)) };
}
async function loginGoogle(){ try{ return await loginOAuth('google'); }catch(_){ /* a mensagem já foi pra tela */ } }
async function loginOAuth(provider){
  const g=$id('sbGoogle');
  try{
    if(g){ g.disabled=true; g.style.opacity='.6'; }
    const { verifier, challenge }=await pkcePair();
    const redirect='http://localhost:8788/callback';
    const url=SB.url()+'/auth/v1/authorize?provider='+encodeURIComponent(provider||'google')
      +'&redirect_to='+encodeURIComponent(redirect)
      +'&code_challenge='+challenge+'&code_challenge_method=s256';
    cloudMsg='Abrindo o Google no navegador — conclua o login lá e volte.'; renderCloud();
    const query=await invoke('oauth_wait_callback',{ authorizeUrl:url });
    const p=new URLSearchParams(query);
    if(p.get('error')) throw new Error(p.get('error_description')||p.get('error'));
    const code=p.get('code'); if(!code) throw new Error('o callback não trouxe o código de autorização');
    // troca o code por sessão (PKCE)
    const r=await fetch(SB.url()+'/auth/v1/token?grant_type=pkce',{ method:'POST',
      headers:{ 'apikey':SB.key(), 'Content-Type':'application/json' },
      body: JSON.stringify({ auth_code:code, code_verifier:verifier }) });
    const j=await r.json().catch(()=>({}));
    if(!j.access_token) throw new Error(j.error_description||j.msg||j.message||('troca falhou (HTTP '+r.status+')'));
    SB.setSess(j); cloudMsg=''; await cloudLoad(); cloudBtnSync(); renderCloud(); try{ loginGateSync(); }catch(_){}
  }catch(e){
    let m=e&&e.message||String(e);
    if(/provider.*not.*enabled|unsupported provider/i.test(m)) m='o provider '+(provider||'google')+' ainda não está ligado no Supabase (Authentication → Providers).';
    else if(/redirect/i.test(m)) m='a URL http://localhost:8788/callback precisa estar na allowlist do Supabase (Authentication → URL Configuration → Redirect URLs).';
    cloudMsg='Falha no login: '+m; renderCloud(); throw e;
  }finally{ if(g){ g.disabled=false; g.style.opacity=''; } }
}
async function sbRefresh(){
  const s = SB.sess(); if(!s || !s.refresh_token) return null;
  try{ const j = await sbAuth('token?grant_type=refresh_token', { refresh_token: s.refresh_token }); SB.setSess(j); return j; }
  catch(_){ SB.setSess(null); return null; }
}
async function sbFetch(path, opts, retried){
  const s = SB.sess(); if(!s) throw new Error('não autenticado');
  const r = await fetch(SB.url()+path, { ...(opts||{}), headers:{ 'apikey':SB.key(), 'Authorization':'Bearer '+s.access_token, 'Content-Type':'application/json', ...((opts||{}).headers||{}) } }).catch(()=>{ throw sbNetErr(); });
  if(r.status===401 && !retried){ const n=await sbRefresh(); if(n) return sbFetch(path, opts, true); throw new Error('sessão expirou — entre de novo'); }
  const tx = await r.text();
  let j=null; try{ j=tx?JSON.parse(tx):null; }catch(_){ }
  if(!r.ok) throw new Error((j&&(j.message||j.hint||j.details))||('erro '+r.status));
  return j;
}
const sbGet = (q)=>sbFetch('/rest/v1/'+q);
const sbPost = (t,body)=>sbFetch('/rest/v1/'+t, { method:'POST', headers:{ 'Prefer':'return=representation' }, body: JSON.stringify(body) });
const sbRpc = (fn,args)=>sbFetch('/rest/v1/rpc/'+fn, { method:'POST', body: JSON.stringify(args||{}) });

// ---- estado da tela ----
let cloudData = null;   // { org, teams, members(do time atual), meRole, profileByUser }
let cloudMsg = '';      // feedback (erro/ok) da última ação
function cloudTeamId(){ return lsGet('sb:team') || ''; }
function cloudUserId(){ const s=SB.sess(); return s && s.user ? s.user.id : ''; }

let cloudCfgOpen=false; // força a tela de backend mesmo com o default baked
function openCloud(){ $id('cloudOverlay').style.display='flex'; renderCloud(); }
// "sair" SEMPRE visível no cabeçalho quando logado (o do corpo ficava enterrado)
{ const b=$id('sbLogoutTop');
  if(b) b.onclick=()=>{ if(!confirm('Sair da conta nesta máquina?')) return; SB.setSess(null); cloudData=null; cloudBtnSync(); renderCloud(); };
  setInterval(()=>{ const e=$id('sbLogoutTop'); if(e) e.style.display=SB.sess()?'':'none'; }, 1500); }
function closeCloud(){
  if(!SB.sess() && $id('cloudOverlay').dataset.lock==='1') return; // login é obrigatório
  $id('cloudOverlay').style.display='none'; cloudMsg='';
}

let cloudAutoInvTried=false;
async function cloudLoad(){
  let orgs = await sbGet('orgs?select=*');
  // sem org: se existe convite pendente pro MEU e-mail, entra sozinho (sem token) — era isso
  // que deixava o convidado de uma org enterprise preso na tela de planos antes de poder aceitar
  if((!orgs || !orgs.length) && !cloudAutoInvTried){
    cloudAutoInvTried=true;
    try{ const j=await sbRpc('accept_pending_invites',{}); const joined=(j&&j.ok&&Array.isArray(j.joined))?j.joined:[];
      if(joined.length){ lsSet('sb:team', joined[0].team_id); orgs = await sbGet('orgs?select=*'); } }catch(_){ }
  }
  if(!orgs || !orgs.length){ cloudData = { org:null, teams:[], members:[], teamMembers:{}, orgMembers:[], invites:[], profileByUser:{}, meRole:'member' }; try{ billingSync(); }catch(_){} return; }
  const org = orgs[0]; // v1: uma org por usuário
  const [teams, myOrg, orgMembers] = await Promise.all([
    sbGet('teams?select=id,name&org_id=eq.'+org.id+'&order=name'),
    sbGet('org_members?select=role&org_id=eq.'+org.id+'&user_id=eq.'+cloudUserId()),
    sbGet('org_members?select=user_id,role&org_id=eq.'+org.id), // admin vê todos; membro só ele (RLS)
  ]);
  let teamId = cloudTeamId();
  if(!teams.find(t=>t.id===teamId)){ teamId = teams[0] ? teams[0].id : ''; lsSet('sb:team', teamId); }
  // membros de TODOS os times que o usuário enxerga (RLS filtra sozinho)
  const tms = teams.length ? await sbGet('team_members?select=team_id,user_id,role&team_id=in.('+teams.map(t=>'"'+t.id+'"').join(',')+')') : [];
  const teamMembers={}; teams.forEach(t=>{ teamMembers[t.id]=[]; });
  tms.forEach(m=>{ (teamMembers[m.team_id]||(teamMembers[m.team_id]=[])).push(m); });
  // convites em aberto (só lead/admin enxergam — RLS; membro comum recebe [])
  let invites=[]; try{ invites=await sbGet('invites?select=id,email,role,token,team_id,expires_at&org_id=eq.'+org.id+'&accepted_at=is.null&order=expires_at.desc'); }catch(_){ }
  // perfis de todo mundo citado
  const uids=new Set(); tms.forEach(m=>uids.add(m.user_id)); orgMembers.forEach(m=>uids.add(m.user_id));
  const profileByUser={};
  if(uids.size){ const profs=await sbGet('profiles?select=user_id,name,email&user_id=in.('+[...uids].map(u=>'"'+u+'"').join(',')+')'); profs.forEach(p=>{ profileByUser[p.user_id]=p; }); }
  cloudData = { org, teams, teamMembers, orgMembers, invites, profileByUser, meRole:(myOrg[0]||{}).role||'member', members: teamMembers[teamId]||[] };
  try{ billingSync(); }catch(_){}
}

function cloudBtnSync(){
  const tx=$id('cloudBtnTx'); if(!tx) return;
  const s=SB.sess();
  if(!s){ tx.textContent='Entrar'; }
  else {
    const team = cloudData && cloudData.teams.find(t=>t.id===cloudTeamId());
    const prof = cloudData && cloudData.profileByUser && cloudData.profileByUser[cloudUserId()];
    const meta = (s.user && s.user.user_metadata) || {};
    const name = (prof && prof.name) || meta.name || meta.full_name || ((s.user&&s.user.email)||'Conta').split('@')[0];
    tx.textContent = name;
    const btn=$id('cloudBtn'); if(btn) btn.title = (team ? 'Time '+team.name+' · ' : '') + ((s.user&&s.user.email)||'') + ' — conta, organização e convites';
  }
  loginGateSync();
}
// LOGIN OBRIGATÓRIO: sem conta não usa — dados (repos, agentes, memória) e
// assinatura são da conta do usuário. A própria tela da nuvem vira o gate.
function loginGateSync(){
  const ov=$id('cloudOverlay'), x=$id('cloudClose');
  if(!ov) return;
  if(!SB.sess()){
    ov.dataset.lock='1'; ov.style.zIndex='115'; // acima de tudo — login vem primeiro
    if(ov.style.display!=='flex'){ ov.style.display='flex'; renderCloud(); }
    if(x) x.style.display='none';
  } else {
    if(ov.dataset.lock==='1'){ ov.dataset.lock=''; ov.style.display='none'; cloudMsg=''; }
    ov.style.zIndex='';
    if(x) x.style.display='';
  }
}
setTimeout(loginGateSync, 3000); // depois do refresh de sessão do boot

function cloudMsgHtml(){ return cloudMsg ? `<div class="imhint" style="border-left:2px solid ${cloudMsg.startsWith('✓')?'var(--good)':'var(--warn)'};margin-bottom:12px">${esc(cloudMsg)}</div>` : ''; }

async function renderCloud(){
  const body=$id('cloudBody'); if(!body) return;
  const head=$id('cloudHead');
  // 1) tela de backend (aparece se não há default nem config, ou via "backend…")
  if(!SB.configured() || cloudCfgOpen){
    head.textContent='Conectar ao backend';
    const isLocal=SB.url().startsWith('http://127.0.0.1');
    body.innerHTML = cloudMsgHtml()+`
      <div class="imhint">Backend atual: <b>${esc(SB.url()||'nenhum')}</b>${isLocal?' <span class="dim">(Supabase local — dev)</span>':''}. Pra usar o projeto na nuvem, cole as credenciais (Settings → API) — vale só nesta máquina.</div>
      <label style="margin-top:10px">Project URL</label><input class="in" id="sbUrl" placeholder="https://xxxx.supabase.co" value="${escA(lsGet('sb:url')||'')}">
      <label style="margin-top:12px">anon key / publishable key</label><input class="in mono" id="sbKey" placeholder="eyJhbGciOi… ou sb_publishable_…" value="${escA(lsGet('sb:key')||'')}">
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn sm" id="sbCfgLocal" title="aponta pro Supabase local de desenvolvimento (supabase start)">usar local (dev)</button><button class="btn sm" id="sbCfgCloud" title="volta pro projeto padrão na nuvem">usar nuvem (padrão)</button><span style="flex:1"></span><button class="btn primary" id="sbSaveCfg">salvar e continuar</button></div>`;
    $id('sbSaveCfg').onclick=()=>{ lsSet('sb:url', $id('sbUrl').value.trim()); lsSet('sb:key', $id('sbKey').value.trim()); SB.setSess(null); cloudData=null; cloudCfgOpen=false; cloudMsg=''; renderCloud(); cloudBtnSync(); };
    $id('sbCfgLocal').onclick=()=>{ lsSet('sb:url',SB_LOCAL.url); lsSet('sb:key',SB_LOCAL.key); SB.setSess(null); cloudData=null; cloudCfgOpen=false; cloudMsg=''; renderCloud(); cloudBtnSync(); };
    $id('sbCfgCloud').onclick=()=>{ lsSet('sb:url',''); lsSet('sb:key',''); SB.setSess(null); cloudData=null; cloudCfgOpen=false; cloudMsg=''; renderCloud(); cloudBtnSync(); };
    return;
  }
  // 2) sem sessão → login / criar conta
  if(!SB.sess()){
    head.textContent='Entrar';
    body.innerHTML = cloudMsgHtml()+`
      <button class="btn" id="sbGoogle" style="width:100%;justify-content:center;gap:9px;padding:9px;font-weight:600"><svg viewBox="0 0 18 18" width="16" height="16"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>Entrar com Google</button>
      <div style="display:flex;align-items:center;gap:10px;margin:14px 0"><span style="flex:1;height:1px;background:var(--border)"></span><span class="dim" style="font-size:11px">ou</span><span style="flex:1;height:1px;background:var(--border)"></span></div>
      <label>E-mail</label><input class="in" id="sbEmail" placeholder="voce@empresa.com" value="${escA(lsGet('sb:email')||'')}">
      <label style="margin-top:12px;display:flex;align-items:center">Senha<span style="flex:1"></span><a class="lnk" id="sbForgot" style="text-transform:none;letter-spacing:0;font-size:11px;cursor:pointer">esqueci a senha</a></label><input class="in" id="sbPass" type="password" placeholder="••••••••">
      <div style="display:flex;gap:8px;margin-top:16px;align-items:center"><button class="btn sm" id="sbCfgEdit" title="trocar URL/chave do backend">backend…</button><span style="flex:1"></span><button class="btn" id="sbSignup">criar conta</button><button class="btn primary" id="sbLogin">entrar</button></div>
      <div class="aihint dim" style="margin-top:10px">A conta é sua identidade no time — quem criou a tarefa, quem assumiu, quem entregou.</div>`;
    const email=()=>$id('sbEmail').value.trim(), pass=()=>$id('sbPass').value;
    const go=async(kind)=>{
      cloudMsg='';
      // validação clara ANTES do servidor (o erro cru do GoTrue confunde)
      if(!email() || !email().includes('@')){ cloudMsg='Informe o e-mail — se você foi convidado, use o MESMO e-mail do convite.'; renderCloud(); $id('sbEmail').focus(); return; }
      if((pass()||'').length<6){ cloudMsg='A senha precisa de pelo menos 6 caracteres.'; renderCloud(); $id('sbPass').focus(); return; }
      try{
        lsSet('sb:email', email());
        if(kind==='up'){
          const j=await sbAuth('signup',{ email:email(), password:pass() });
          if(j.access_token){ SB.setSess(j); await cloudLoad(); }
          else { cloudMsg='✓ conta criada — confirme o e-mail que o Supabase enviou e depois clique em entrar.'; }
        } else {
          const j=await sbAuth('token?grant_type=password',{ email:email(), password:pass() });
          SB.setSess(j); await cloudLoad();
        }
      }catch(e){
        let m=e.message||String(e);
        if(/anonymous/i.test(m)) m='informe e-mail e senha.';
        else if(/already registered|user_already/i.test(m)) m='este e-mail já tem conta — use "entrar".';
        else if(/invalid login credentials/i.test(m)) m='e-mail ou senha incorretos (a conta existe? confirmou o e-mail?).';
        else if(/email not confirmed/i.test(m)) m='confirme o e-mail primeiro — procure o link na sua caixa de entrada.';
        cloudMsg='Falhou: '+m;
      }
      cloudBtnSync(); renderCloud();
    };
    $id('sbLogin').onclick=()=>go('in');
    $id('sbSignup').onclick=()=>go('up');
    bindClick('sbGoogle', loginGoogle);
    { const f=$id('sbForgot'); if(f) f.onclick=async()=>{
        if(!email() || !email().includes('@')){ cloudMsg='Digite seu e-mail acima primeiro — o link de recuperação vai pra ele.'; renderCloud(); $id('sbEmail').focus(); return; }
        f.textContent='enviando…';
        // mesmo fluxo do onboarding: código de 6 dígitos → nova senha (auRecover em 44-onboarding.js)
        try{ await auRecover(email()); cloudMsg=''; }
        catch(e){ cloudMsg='Falhou ao enviar recuperação: '+esc(e&&e.message||String(e)); }
        renderCloud();
      }; }
    $id('sbPass').addEventListener('keydown',e=>{ if(e.key==='Enter') go('in'); });
    $id('sbCfgEdit').onclick=()=>{ cloudCfgOpen=true; renderCloud(); };
    return;
  }
  // dados frescos
  if(!cloudData){ body.innerHTML=cosmosHtml('carregando a conta…'); try{ await cloudLoad(); }catch(e){ cloudMsg='Falhou: '+e.message; SB.setSess(SB.sess()); } }
  // 3) logado mas sem org → criar ou aceitar convite
  if(!cloudData || !cloudData.org){
    head.textContent='Sua organização';
    body.innerHTML = cloudMsgHtml()+`
      <div class="seclbl2">Criar organização + primeiro time</div>
      <label style="margin-top:6px">Nome da organização</label><input class="in" id="sbOrgName" placeholder="ex.: Logcomex">
      <label style="margin-top:12px">Nome do time</label><input class="in" id="sbTeamName" placeholder="ex.: Foundations">
      <div style="display:flex;margin-top:12px"><span style="flex:1"></span><button class="btn primary" id="sbCreateOrg">criar</button></div>
      <div class="seclbl2" style="margin-top:22px">…ou entrar num time existente</div>
      <label style="margin-top:6px">Token do convite</label><input class="in mono" id="sbInvTok" placeholder="cole o token que o lead te mandou">
      <div style="display:flex;margin-top:12px"><span style="flex:1"></span><button class="btn" id="sbAccept">aceitar convite</button></div>
      <div style="display:flex;margin-top:18px"><button class="btn sm" id="sbLogout">sair da conta</button></div>`;
    $id('sbCreateOrg').onclick=async()=>{
      cloudMsg='';
      try{ const j=await sbRpc('create_org_with_team',{ p_org_name:$id('sbOrgName').value.trim()||'Minha org', p_team_name:$id('sbTeamName').value.trim()||'Time 1' }); lsSet('sb:team', j.team_id); cloudData=null; cloudMsg='✓ organização criada'; }
      catch(e){ cloudMsg='Falhou: '+e.message; }
      renderCloud();
    };
    $id('sbAccept').onclick=async()=>{
      cloudMsg='';
      try{ const j=await sbRpc('accept_invite',{ p_token:$id('sbInvTok').value.trim() }); if(!j.ok) throw new Error(j.error); lsSet('sb:team', j.team_id); cloudData=null; cloudMsg='✓ você entrou no time'; }
      catch(e){ cloudMsg='Falhou: '+e.message; }
      renderCloud();
    };
    $id('sbLogout').onclick=()=>{ SB.setSess(null); cloudData=null; cloudBtnSync(); renderCloud(); };
    return;
  }
  // 4) home: gestão da org — times, membros por time, convites, catálogo, visão
  const d=cloudData, teamId=cloudTeamId();
  head.textContent=d.org.name;
  const isAdmin = d.meRole==='owner'||d.meRole==='admin';
  const myLeadTeams = d.teams.filter(t=>(d.teamMembers[t.id]||[]).some(m=>m.user_id===cloudUserId()&&m.role==='lead'));
  const canManage = t => isAdmin || myLeadTeams.some(x=>x.id===t.id);
  const meLead = myLeadTeams.length>0;
  const pName = uid => { const p=d.profileByUser[uid]||{}; return p.name||p.email||String(uid).slice(0,8); };
  const teamsHtml = d.teams.map(t=>{
    const mems=d.teamMembers[t.id]||[];
    const rows=mems.map(m=>`<div class="mrow"><span class="mav" style="background:${agentColor(pName(m.user_id))}">${esc(pName(m.user_id).slice(0,2).toUpperCase())}</span><span class="mnm">${esc(pName(m.user_id))}${m.user_id===cloudUserId()?' <span class="mme">você</span>':''}</span><span class="mrole${m.role==='lead'?' lead':''}">${m.role==='lead'?'lead':'membro'}</span>${canManage(t)?`<span class="macts"><button class="btn sm ghost" data-mact="lead" data-team="${escA(t.id)}" data-uid="${escA(m.user_id)}" title="${m.role==='lead'?'volta a ser membro':'vira lead do time'}">${m.role==='lead'?'tornar membro':'tornar lead'}</button><button class="mrm" data-mact="rm" data-team="${escA(t.id)}" data-uid="${escA(m.user_id)}" title="remover do time">${IC.trash}</button></span>`:''}</div>`).join('') || '<div class="mempty">time vazio — adicione alguém abaixo</div>';
    const fora=(d.orgMembers||[]).filter(om=>!mems.some(m=>m.user_id===om.user_id));
    const addRow = canManage(t)&&fora.length ? `<div class="maddrow"><select class="sel" id="sbAdd-${escA(t.id)}">${fora.map(om=>`<option value="${escA(om.user_id)}">${esc(pName(om.user_id))}</option>`).join('')}</select><button class="btn sm ghost" data-mact="add" data-team="${escA(t.id)}">+ adicionar ao time</button></div>` : '';
    const leadNames=mems.filter(m=>m.role==='lead').map(m=>pName(m.user_id));
    const leadTag=leadNames.length?`lead: ${esc(leadNames.join(', '))}`:'<span style="color:var(--warn)">sem lead</span>';
    return `<div class="tmcard tm2"><div class="tmhead"><div class="tmtl"><b class="tmtitle">${esc(t.name)}</b>${canManage(t)?`<button class="mrm" data-mact="rename" data-team="${escA(t.id)}" title="renomear time">${IC.pencil}</button>`:''}<span class="tmmeta">${mems.length} membro${mems.length===1?'':'s'} · ${leadTag} · só o time vê o que ele faz</span></div><span class="tmr">${t.id===teamId?'<span class="tmbadge on">time atual</span>':`<button class="btn sm ghost" data-mact="use" data-team="${escA(t.id)}">usar este time</button>`}${isAdmin?`<button class="mrm" data-mact="delteam" data-team="${escA(t.id)}" title="excluir time">${IC.trash}</button>`:''}</span></div><div class="mlist">${rows}</div>${addRow}</div>`;
  }).join('');
  const invTeams = isAdmin ? d.teams : myLeadTeams;
  const invListHtml=(d.invites||[]).map(iv=>{ const tn=(d.teams.find(x=>x.id===iv.team_id)||{}).name||'?'; return `<div class="mrow"><span class="mav" style="background:var(--surface-3);color:var(--muted)">@</span><span class="mnm">${esc(iv.email)}<span class="msub">${esc(tn)} · ${iv.role==='lead'?'lead':'membro'} · expira em ${Math.max(0,Math.round((new Date(iv.expires_at)-Date.now())/86400e3))}d</span></span><span class="macts"><button class="btn sm ghost" data-iact="copy" data-iv="${escA(iv.id)}">copiar mensagem</button><button class="mrm" data-iact="rev" data-iv="${escA(iv.id)}" title="revogar convite">${IC.trash}</button></span></div>`; }).join('');
  const seatsUsed=(d.orgMembers||[]).length, seatsFull=seatsUsed>=d.org.seats;
  body.innerHTML = cloudMsgHtml()+`
    ${!d.org.license_key?`<div class="imhint" style="border-left:2px solid var(--warn)">⚠ Organização <b>sem licença</b> — modo avaliação. ${d.meRole==='owner'?'Defina a chave na seção Licença abaixo.':'Peça ao owner pra ativar a licença.'}</div>`:''}
    ${seatsFull?`<div class="imhint" style="border-left:2px solid var(--warn)">⚠ Todos os <b>${d.org.seats} assentos</b> em uso — convites novos serão recusados até liberar assento ou ampliar o plano.</div>`:''}
    <div class="imhint">Plano <b>${esc(d.org.plan)}</b> · ${seatsUsed}/${d.org.seats} assentos · seu papel na org: <b>${esc(d.meRole)}</b>${isAdmin?' — você vê e administra todos os times':''}</div>
    <div class="seclbl2" style="margin-top:16px">Times da organização <span class="n">${d.teams.length}</span><span style="flex:1"></span>${isAdmin?'<button class="btn sm" id="sbTeamAdd">+ novo time</button>':''}</div>
    ${teamsHtml||'<div class="dim" style="font-size:12px">nenhum time ainda</div>'}
    ${(isAdmin||meLead)?`
    <div class="seclbl2" style="margin-top:18px">Convidar gente nova <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· pra quem ainda não tem conta — quem já tem, use "+ adicionar ao time"</span></div>
    <div style="display:flex;gap:8px;margin-top:6px"><input class="in" id="sbInvEmail" placeholder="email@empresa.com" style="flex:1"><select class="sel" id="sbInvTeam" style="width:150px">${invTeams.map(t=>`<option value="${escA(t.id)}"${t.id===teamId?' selected':''}>${esc(t.name)}</option>`).join('')}</select><select class="sel" id="sbInvRole" style="width:100px"><option value="member">membro</option><option value="lead">lead</option></select><button class="btn primary sm" id="sbInvite">gerar convite</button></div>
    <div id="sbInvOut"></div>
    ${invListHtml?`<div class="seclbl2" style="margin-top:14px">Convites pendentes <span class="n">${d.invites.length}</span></div><div class="mlist tm2">${invListHtml}</div>`:''}`:''}
    ${isAdmin?`<div class="seclbl2" style="margin-top:18px">Membros da organização <span class="n">${seatsUsed}</span></div>
    <div class="mlist tm2">${(d.orgMembers||[]).map(om=>`<div class="mrow"><span class="mav" style="background:${agentColor(pName(om.user_id))}">${esc(pName(om.user_id).slice(0,2).toUpperCase())}</span><span class="mnm">${esc(pName(om.user_id))}${om.user_id===cloudUserId()?' <span class="mme">você</span>':''}</span><span class="mrole${om.role==='owner'||om.role==='admin'?' lead':''}">${esc(om.role)}</span>${(om.role!=='owner'&&om.user_id!==cloudUserId())?`<span class="macts"><button class="btn sm ghost" data-orgrm="${escA(om.user_id)}" title="remove da organização e de todos os times — libera o assento">remover da org</button></span>`:''}</div>`).join('')}</div>`:''}
    <div class="seclbl2" style="margin-top:18px">Agentes &amp; equipes da organização</div>
    <div id="sbCat" class="dim" style="font-size:12px;padding:4px 2px">carregando…</div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm" id="sbCatPull" title="grava os agentes/workflows da org no cardume.config.json do projeto aberto">aplicar neste projeto</button>${isAdmin?`<button class="btn sm" id="sbCatPush" title="publica os agentes/workflows do projeto aberto pra org inteira">enviar os deste projeto</button>`:''}</div>
    ${isAdmin?`<div class="seclbl2" style="margin-top:18px">Visão da organização</div><div id="sbOrgView" class="dim" style="font-size:12px;padding:4px 2px">carregando…</div>`:''}
    ${d.meRole==='owner'?`<div class="seclbl2" style="margin-top:18px">Licença</div><div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="mono dim" style="font-size:11px;flex:1;word-break:break-all">${esc(d.org.license_key||'sem chave — plano de avaliação')}</span><button class="btn sm" id="sbLicSet">definir chave</button></div>`:''}
    <div style="display:flex;margin-top:22px;align-items:center;gap:8px"><span class="dim" style="font-size:11px">${esc((SB.sess().user||{}).email||'')}</span><span style="flex:1"></span><button class="btn sm" id="sbPassChange" title="define uma senha nova pra sua conta">trocar senha</button><button class="btn sm" id="sbLogout">sair</button></div>
    <div class="imhint" style="margin-top:12px">O backlog compartilhado fica na aba <b>Time</b> da tela principal — crie tarefas com “Compartilhar com o time”.</div>`;
  bindClick('sbTeamAdd', async()=>{ const n=await askText('Novo time','ex.: Data'); if(!n) return; cloudMsg=''; try{ const rows=await sbPost('teams',{ org_id:d.org.id, name:n }); await sbPost('team_members',{ team_id:rows[0].id, user_id:cloudUserId(), role:'lead' }); lsSet('sb:team',rows[0].id); cloudData=null; cloudMsg='✓ time criado'; }catch(e){ cloudMsg='Falhou: '+e.message; } renderCloud(); });
  // ações nos times: usar / promover-rebaixar / remover / adicionar membro
  body.querySelectorAll('[data-mact]').forEach(b=>{ b.onclick=async()=>{
    const act=b.dataset.mact, tid=b.dataset.team, uid=b.dataset.uid; cloudMsg='';
    try{
      if(act==='use'){ lsSet('sb:team', tid); cloudData=null; renderCloud(); cloudBtnSync(); return; }
      if(act==='add'){ const sel=$id('sbAdd-'+tid); if(!sel||!sel.value) return; await sbPost('team_members',{ team_id:tid, user_id:sel.value, role:'member' }); cloudMsg='✓ adicionado ao time'; }
      if(act==='rm'){ const nm=pName(uid); if(!confirm('Remover '+nm+' deste time?')) return; await sbFetch('/rest/v1/team_members?team_id=eq.'+tid+'&user_id=eq.'+uid, { method:'DELETE' }); cloudMsg='✓ removido do time'; }
      if(act==='lead'){ const cur=(d.teamMembers[tid]||[]).find(m=>m.user_id===uid); await sbFetch('/rest/v1/team_members?team_id=eq.'+tid+'&user_id=eq.'+uid, { method:'PATCH', body: JSON.stringify({ role: cur&&cur.role==='lead'?'member':'lead' }) }); cloudMsg='✓ papel atualizado'; }
      if(act==='rename'){ const cur=(d.teams.find(x=>x.id===tid)||{}).name||''; const n=await askText('Renomear time',cur,cur); if(n===null||!n.trim()||n.trim()===cur){ return; } await sbFetch('/rest/v1/teams?id=eq.'+tid, { method:'PATCH', body: JSON.stringify({ name:n.trim() }) }); cloudMsg='✓ time renomeado'; }
      if(act==='delteam'){ const tm=(d.teamMembers[tid]||[]).length; const nm=(d.teams.find(x=>x.id===tid)||{}).name||'time'; if(!confirm('Excluir o time "'+nm+'"?'+(tm?'\n\n'+tm+' membro(s) perdem o vínculo. As tarefas do time continuam no histórico.':''))) return; await sbFetch('/rest/v1/teams?id=eq.'+tid, { method:'DELETE' }); if(teamId===tid){ lsSet('sb:team',''); } cloudMsg='✓ time excluído'; }
      cloudData=null; renderCloud(); cloudBtnSync();
    }catch(e){ cloudMsg='Falhou: '+e.message; renderCloud(); }
  }; });
  // remover membro da ORG (admin): sai de todos os times + libera o assento
  body.querySelectorAll('[data-orgrm]').forEach(b=>{ b.onclick=async()=>{
    const uid=b.dataset.orgrm, nm=pName(uid);
    if(!confirm('Remover '+nm+' da ORGANIZAÇÃO?\n\nSai de todos os times e libera o assento. As tarefas que a pessoa criou/assumiu continuam no histórico.')) return;
    cloudMsg='';
    try{
      for(const t of d.teams){ await sbFetch('/rest/v1/team_members?team_id=eq.'+t.id+'&user_id=eq.'+uid, { method:'DELETE' }).catch(()=>{}); }
      await sbFetch('/rest/v1/org_members?org_id=eq.'+d.org.id+'&user_id=eq.'+uid, { method:'DELETE' });
      cloudData=null; cloudMsg='✓ '+nm+' removido da organização';
    }catch(e){ cloudMsg='Falhou: '+e.message; }
    renderCloud();
  }; });
  // convites pendentes: copiar mensagem / revogar
  const invMsg=(iv)=>{ const tn=(d.teams.find(x=>x.id===iv.team_id)||{}).name||''; return `Você foi convidado(a) pro time ${tn} da ${d.org.name} no Constellation.\n1. Abra o Constellation e clique em Entrar\n2. Crie sua conta com o e-mail ${iv.email}\n3. Em "aceitar convite", cole o token:\n${iv.token}`; };
  body.querySelectorAll('[data-iact]').forEach(b=>{ b.onclick=async()=>{
    const iv=(d.invites||[]).find(x=>x.id===b.dataset.iv); if(!iv) return;
    if(b.dataset.iact==='copy'){ navigator.clipboard.writeText(invMsg(iv)); b.textContent='copiado ✓'; return; }
    if(!confirm('Revogar o convite de '+iv.email+'?')) return;
    cloudMsg='';
    try{ await sbFetch('/rest/v1/invites?id=eq.'+iv.id, { method:'DELETE' }); cloudData=null; cloudMsg='✓ convite revogado'; }catch(e){ cloudMsg='Falhou: '+e.message; }
    renderCloud();
  }; });
  { const b=$id('sbInvite'); if(b) b.onclick=async()=>{
      cloudMsg='';
      try{
        const mail=$id('sbInvEmail').value.trim();
        if(!mail){ $id('sbInvEmail').focus(); throw new Error('informe o e-mail da pessoa'); }
        const invTeamId=$id('sbInvTeam').value;
        const rows=await sbPost('invites',{ org_id:d.org.id, team_id:invTeamId, email:mail, role:$id('sbInvRole').value, created_by:cloudUserId() });
        const tok=rows[0].token;
        const teamName=(d.teams.find(x=>x.id===invTeamId)||{}).name||'';
        const msg=`Você foi convidado(a) pro time ${teamName} da ${d.org.name} no Constellation.\n1. Abra o Constellation e clique em Entrar\n2. Crie sua conta com o e-mail ${mail}\n3. Em "aceitar convite", cole o token:\n${tok}`;
        $id('sbInvOut').innerHTML=`<div class="imhint" style="margin-top:10px;border-left:2px solid var(--good)">✓ convite gerado pra <b>${esc(mail)}</b> — o token <b>só funciona logado com esse e-mail</b>. Mande a mensagem pronta:<div class="mono" style="margin-top:6px;user-select:all;word-break:break-all;white-space:pre-wrap;font-size:11px">${esc(msg)}</div><button class="btn sm" id="sbInvCopy" style="margin-top:8px">copiar mensagem</button></div>`;
        $id('sbInvCopy').onclick=function(){ navigator.clipboard.writeText(msg); this.textContent='copiado ✓'; };
      }catch(e){ cloudMsg='Falhou: '+e.message; renderCloud(); }
    }; }
  $id('sbLogout').onclick=()=>{ SB.setSess(null); cloudData=null; cloudBtnSync(); renderCloud(); };
  bindClick('sbPassChange', ()=>auShow('newpass', { backTo: ()=>{ if(window.openTab) window.openTab('conta'); } }));
  cloudCatalog(d.org.id, isAdmin);
  if(isAdmin){
    cloudOrgView().then(rows=>{
      const el=$id('sbOrgView'); if(!el) return;
      el.innerHTML = rows.length ? `<div class="costlist">`+rows.map(r=>`<div class="costrow"><span class="cnm">${esc(r.name)}</span><span class="dim" style="font-size:11px">${r.n} tarefas · ${r.run} em andamento · ${r.done} entregues</span><span class="cusd">${fmtUsd(r.usd)}</span></div>`).join('')+`</div>` : 'nenhum time ainda';
    }).catch(e=>{ const el=$id('sbOrgView'); if(el) el.textContent='falhou: '+e.message; });
  }
  { const b=$id('sbLicSet'); if(b) b.onclick=async()=>{
      const k=await askText('Chave de licença da organização','LOGCOMEX-…', d.org.license_key||''); if(k===null) return;
      cloudMsg='';
      try{ await sbFetch('/rest/v1/orgs?id=eq.'+d.org.id, { method:'PATCH', body: JSON.stringify({ license_key: k.trim()||null }) }); cloudData=null; cloudMsg='✓ licença atualizada'; }
      catch(e){ cloudMsg='Falhou: '+e.message; }
      renderCloud();
    }; }
  cloudBtnSync();
  if(typeof billingRenderCloud==='function') billingRenderCloud();
  if(typeof orgDefaultsRenderCloud==='function') orgDefaultsRenderCloud(isAdmin);
  if(typeof secretsRenderCloud==='function') secretsRenderCloud();
}
// seção "Padrões da organização" na Conta (admins editam; o resto só vê)
function orgDefaultsRenderCloud(isAdmin){
  const body=$id('cloudBody'); if(!body||!SB.sess()) return;
  const el=document.createElement('div');
  el.innerHTML=`<div class="seclbl2" style="margin-top:16px">Padrões de demanda</div>
    <div style="display:flex;align-items:center;gap:10px;font-size:12.5px">
      <span style="flex:1" class="dim">guia de spec + política valem pra org inteira; repos refinam com <span class="mono">.cardume/</span></span>
      ${isAdmin?'<button class="btn sm" id="sbOrgTpl">editar padrões</button>':''}
    </div>`;
  body.appendChild(el);
  const b=$id('sbOrgTpl');
  if(b) b.onclick=async()=>{
    const og=await orgDefaultsGet();
    const p={ ...ORG_DEFAULT_POLICY, ...((og&&og.policy)||{}) };
    $id('orgTplText').placeholder=DEFAULT_SPEC_TEMPLATE;
    mountEditor($id('orgTplText'), { markdown:true });
    editorSet($id('orgTplText'), (og&&og.spec_template)||'');
    $id('orgPolMin').value=p.minRequirements;
    $id('orgPolCost').value=p.costWarn;
    $id('orgPolProof').checked=!!p.proofRequired;
    $id('orgPolTests').checked=!!p.testsRequired;
    $id('orgPolDoc').checked=!!p.docRequired;
    $id('orgTplMsg').textContent='';
    $id('orgTplOverlay').style.display='flex';
  };
}
{ const close=()=>{ $id('orgTplOverlay').style.display='none'; };
  $id('orgTplClose').onclick=close;
  $id('orgTplCancel').onclick=close;
  $id('orgTplOverlay').addEventListener('click',e=>{ if(e.target.id==='orgTplOverlay') close(); });
  $id('orgTplSave').onclick=async()=>{
    const orgId=cloudData&&cloudData.org&&cloudData.org.id; if(!orgId) return;
    const b=$id('orgTplSave'); b.disabled=true;
    try{
      await sbFetch('/rest/v1/orgs?id=eq.'+orgId,{ method:'PATCH', body: JSON.stringify({
        spec_template: $id('orgTplText').value.trim()||null,
        policy: {
          minRequirements: Math.max(1, parseInt($id('orgPolMin').value,10)||1),
          costWarn: Math.max(0, parseFloat($id('orgPolCost').value)||25),
          proofRequired: $id('orgPolProof').checked,
          testsRequired: $id('orgPolTests').checked,
          docRequired: $id('orgPolDoc').checked,
        } }) });
      orgDefCache=null; orgDefAt=0;
      $id('orgTplMsg').textContent='✓ salvo — vale pra org inteira já';
      setTimeout(close, 900);
    }catch(e){ $id('orgTplMsg').textContent='falhou: '+(e.message||e); }
    finally{ b.disabled=false; }
  };
}
