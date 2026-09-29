// Starfork — 40-nuvem-conta
/* ============================================================================
   TIME NA NUVEM (F1) — Supabase via fetch puro, zero dependência.
   Estados: setup (URL+anon key) → login → sem-org (criar org/aceitar convite)
   → home (org, times, membros, convites, seletor de time atual).
   RLS mora no banco; aqui só autentica e consome /auth/v1 + /rest/v1.
   ========================================================================= */
// Padrão: NUVEM (projeto Supabase do Starfork) — anon key é pública por
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
  if(custom&&isLocal) m+=' — este app está apontando pra um backend LOCAL que não está rodando. Em Conta e time, clique em "servidor…" → "usar nuvem (padrão)".';
  else if(custom) m+=' — backend personalizado configurado. Confira em Conta e time › "servidor…" ou clique em "usar nuvem (padrão)".';
  else m+=' — verifique sua internet/VPN (a rede pode estar bloqueando o Supabase).';
  return new Error(m);
}
// Erro de auth SEMPRE traduzido (39-i18n-auth): .message já vem no idioma do app; .info/.status/.code
// guardam o que o GoTrue disse (pra tela decidir campo/ação e pro suporte rastrear). Nunca inglês na tela.
function sbAuthError(status, j){
  const info=authErrInfo({ status, body:j||{} });
  const e=new Error(authErrPt(info)); e.info=info; e.status=status; e.code=info.code; e.authKey=info.key; e.raw=info.text;
  return e;
}
// POST (ou GET/PUT via opts) em /auth/v1/… com teto de 20 s — fetch pendurado deixava o botão em "entrando…" pra sempre
async function sbAuth(path, body, opts){
  opts=opts||{};
  const ctl=(typeof AbortController!=='undefined')?new AbortController():null;
  const to=ctl?setTimeout(()=>ctl.abort(), opts.timeout||20000):null;
  const headers={ 'apikey':SB.key(), 'Content-Type':'application/json' };
  if(opts.token) headers['Authorization']='Bearer '+opts.token;
  let r;
  try{ r=await fetch(SB.url()+'/auth/v1/'+path, { method:opts.method||'POST', headers, body: body==null?undefined:JSON.stringify(body), signal:ctl?ctl.signal:undefined }); }
  catch(e){
    if(e&&e.name==='AbortError') throw sbAuthError(0,{ error_code:'timeout' });
    const n=sbNetErr(); n.network=true; n.code='network'; n.info=authErrInfo(n); throw n;
  }finally{ if(to) clearTimeout(to); }
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw sbAuthError(r.status, j);
  return j;
}
// o que o servidor de contas tem ligado (providers Google/GitHub etc.) — público, sem sessão; cache por execução
let _sbAuthSettings=null;
function sbAuthSettings(){
  if(!_sbAuthSettings) _sbAuthSettings=sbAuth('settings', null, { method:'GET', timeout:8000 }).catch(()=>{ _sbAuthSettings=null; return null; });
  return _sbAuthSettings;
}
// troca atributos da conta (senha) com o token da sessão — renova o token 1x se ele venceu
async function sbAuthUpdate(attrs, retried){
  const s=SB.sess(); if(!s||!s.access_token) throw sbAuthError(401,{ error_code:'session_not_found' });
  try{ return await sbAuth('user', attrs, { method:'PUT', token:s.access_token }); }
  catch(e){
    if(!retried && (e.status===401 || (e.status===403 && e.authKey==='session_expired'))){ const n=await sbRefresh(); if(n) return sbAuthUpdate(attrs, true); }
    throw e;
  }
}
// ---- Login social Google (OAuth PKCE + callback local) ----
function b64url(bytes){ return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function pkcePair(){
  const rnd=new Uint8Array(48); crypto.getRandomValues(rnd);
  const verifier=b64url(rnd);
  const hash=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge:b64url(new Uint8Array(hash)) };
}
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
    const p=new URLSearchParams(query||'');
    if(p.get('error')) throw sbAuthError(400,{ error_code:p.get('error_code')||p.get('error'), msg:p.get('error_description')||p.get('error') });
    const code=p.get('code'); if(!code) throw sbAuthError(400,{ error_code:'bad_oauth_callback' });
    // troca o code por sessão (PKCE)
    const j=await sbAuth('token?grant_type=pkce',{ auth_code:code, code_verifier:verifier });
    if(!j.access_token) throw sbAuthError(400,{ error_code:'bad_oauth_callback' });
    SB.setSess(j); cloudMsg=''; await cloudLoad(); cloudBtnSync(); renderCloud(); try{ loginGateSync(); }catch(_){}
  }catch(e){
    // erro do Rust (porta ocupada, 3 min sem retorno) já vem em pt-BR como string; o resto passa pelo tradutor
    const pname=provider==='github'?'GitHub':'Google';
    let m=(typeof e==='string')?e:(e&&e.info)?authErrPt(e,{ provider:pname }):(e&&e.message)||String(e);
    const err=(e instanceof Error)?e:new Error(m); err.message=m; if(!err.info && typeof e==='string') err.info={ key:'oauth_failed', code:'', status:0, field:'', wait:null, min:8, text:m, rust:true };
    cloudMsg=m; renderCloud(); throw err;
  }finally{ if(g){ g.disabled=false; g.style.opacity=''; } }
}
// Renova o token. UMA renovação por vez (várias chamadas 401 ao mesmo tempo gastavam o mesmo refresh_token →
// "Already Used" → logout à toa). Só derruba a sessão quando o SERVIDOR diz que o refresh_token não vale mais;
// sem rede / 5xx / 429 a sessão fica e a próxima chamada tenta de novo (antes: offline no boot = deslogado).
let _sbRefreshing=null;
function sbRefresh(){
  const s = SB.sess(); if(!s || !s.refresh_token) return Promise.resolve(null);
  if(_sbRefreshing) return _sbRefreshing;
  _sbRefreshing=(async()=>{
    try{ const j = await sbAuth('token?grant_type=refresh_token', { refresh_token: s.refresh_token }); SB.setSess(j); return j; }
    catch(e){
      if(e && (e.network || e.authKey==='timeout' || e.status===429 || e.status>=500)) return null;
      const cur=SB.sess(); if(cur && cur.refresh_token!==s.refresh_token) return cur; // outra aba/chamada já renovou
      SB.setSess(null); sbSessionEnded('expired'); return null;
    }finally{ _sbRefreshing=null; }
  })();
  return _sbRefreshing;
}
// sessão caiu (refresh_token inválido): limpa o que é da conta e mostra o login com o aviso — nada de erro cru
function sbSessionEnded(reason){
  lsSet('sb:ended', reason||'expired');
  cloudData=null; cloudAutoInvTried=false;
  try{ if(typeof myBilling!=='undefined') myBilling=null; }catch(_){ }
  try{ cloudBtnSync(); }catch(_){ }
}
// sair da conta: UM caminho só (cabeçalho, painel Conta e tela de entrada). Revoga o refresh_token no
// servidor (melhor esforço, sem travar a UI) e limpa o estado da conta desta máquina.
function sbLogout(){
  const s=SB.sess();
  SB.setSess(null); lsSet('sb:ended','');
  cloudData=null; cloudAutoInvTried=false; cloudMsg='';
  try{ if(typeof myBilling!=='undefined') myBilling=null; }catch(_){ }
  if(s && s.access_token) sbAuth('logout?scope=local', null, { token:s.access_token, timeout:5000 }).catch(()=>{});
  try{ cloudBtnSync(); }catch(_){ }
  try{ renderCloud(); }catch(_){ }
}
async function sbFetch(path, opts, retried){
  const s = SB.sess(); if(!s) throw new Error(T('auth.err.session_expired'));
  const r = await fetch(SB.url()+path, { ...(opts||{}), headers:{ 'apikey':SB.key(), 'Authorization':'Bearer '+s.access_token, 'Content-Type':'application/json', ...((opts||{}).headers||{}) } }).catch(()=>{ throw sbNetErr(); });
  if(r.status===401 && !retried){ const n=await sbRefresh(); if(n) return sbFetch(path, opts, true); throw (SB.sess()?sbNetErr():new Error(T('auth.err.session_expired'))); }
  const tx = await r.text();
  let j=null; try{ j=tx?JSON.parse(tx):null; }catch(_){ }
  if(!r.ok) throw new Error((j&&(j.message||j.hint||j.details))||('erro '+r.status));
  return j;
}
// @cloud-puro-inicio — erro da nuvem (PostgREST/RPC) em pt-BR, com o que fazer (testado em app/tests/onboarding-conta.test.mjs).
// Antes a tela de Conta mostrava "Falhou: new row violates row-level security policy for table \"invites\"".
// As RPCs do Starfork já respondem em pt-BR ("convite inválido ou expirado") — essas passam como estão.
// Números de status só contam com prefixo ("erro 403", "HTTP 502") — um número solto no texto não é status.
// ORDEM importa: sessão vem antes de permissão (401 = token vencido, não falta de papel).
const CLOUD_ST=c=>new RegExp('\\b(erro|http|status)\\s*:?\\s*('+c+')\\b','i');
const CLOUD_ERR=[
  [/jwt|token (is )?expired|sess[ãa]o expirou/i, 'Sua sessão expirou — entre de novo na conta.'],
  [CLOUD_ST('401'), 'Sua sessão expirou — entre de novo na conta.'],
  [/row-level security|permission denied for|insufficient_privilege|42501/i, 'Você não tem permissão pra isso nesta organização — só o lead do time ou um admin pode.'],
  [CLOUD_ST('403'), 'Você não tem permissão pra isso nesta organização — só o lead do time ou um admin pode.'],
  [/duplicate key|already exists|unique constraint|23505/i, 'Isso já existe — a pessoa já está no time ou já tem um convite pra esse e-mail.'],
  [CLOUD_ST('409'), 'Isso já existe — a pessoa já está no time ou já tem um convite pra esse e-mail.'],
  [/foreign key|violates.*constraint.*fkey|23503|no rows/i, 'Esse item não existe mais — alguém mudou agora há pouco. Confira a lista e tente de novo.'],
  // tabela/RPC que não existe no servidor = app mais novo que a nuvem (migration faltando)
  [/could not find the (function|table)|relation .* does not exist|function .* does not exist|PGRST20[02]|not found/i, 'Recurso não encontrado — a nuvem pode estar desatualizada. Tente de novo mais tarde ou fale com o suporte do Starfork.'],
  [CLOUD_ST('404'), 'Recurso não encontrado — a nuvem pode estar desatualizada. Tente de novo mais tarde ou fale com o suporte do Starfork.'],
  [/invalid input syntax for type uuid|22P02/i, 'Esse código não é válido — confira se copiou o token inteiro.'],
  [/check constraint|violates check|23514|value too long|22001/i, 'Algum campo ficou fora do formato aceito — confira e tente de novo.'],
  [/failed to fetch|load failed|networkerror|sem conex[ãa]o/i, 'Sem conexão com a nuvem agora — cheque a internet/VPN e tente de novo.'],
  [/internal server error|bad gateway|service unavailable|gateway time-?out/i, 'A nuvem do Starfork está com problema agora — tente de novo em alguns minutos.'],
  [CLOUD_ST('5\\d\\d'), 'A nuvem do Starfork está com problema agora — tente de novo em alguns minutos.'],
];
// já está em português? (RPCs do Starfork, sbNetErr). Acento OU palavra que só existe em pt — nada de
// "time/plano/sem", que também são palavras em inglês. Compartilhado com o checkout (44-onboarding).
function isPtText(t){ return /[ãõçéêáíóúâô]/i.test(t) || /\b(nao|voce|convite|convites|assentos?|organizacao|usuario|invalido|expirado|permissao|nenhum|nenhuma|tente|obrigatorio)\b/i.test(t); }
function cloudErrMsg(e, ctx){
  const raw=String((e&&e.message)||e||'').trim();
  const pre=ctx?String(ctx).replace(/[\s:.…—-]+$/,'')+': ':'';
  const hit=CLOUD_ERR.find(([re])=>re.test(raw));
  if(hit) return pre+hit[1];
  if(isPtText(raw)) return pre+raw.charAt(0).toUpperCase()+raw.slice(1);
  return pre+'Não deu certo agora — tente de novo em instantes.'+(raw?' ('+raw.slice(0,80)+')':'');
}
// a mensagem do convite (UMA só: a do "gerar convite" e a do "copiar mensagem" da lista eram cópias).
// Desde a 0020 o convite pro e-mail entra SOZINHO ao criar a conta — o token é só o plano B.
function cloudInviteMsg(teamName, orgName, email, token){
  return `Você foi convidado(a) pro time ${teamName} da ${orgName} no Starfork.\n`
    +`1. Baixe o Starfork em starfork.com.br e abra o app\n`
    +`2. Crie a sua conta com o e-mail ${email} — você entra no time sozinho\n`
    +`3. Se não entrar: em Conta e time › "aceitar convite", cole este token:\n${token}`;
}
// já existe convite AINDA VÁLIDO pra esse e-mail? (vencido não conta — dá pra convidar de novo)
function cloudInvitePending(invites, mail, now){
  const m=String(mail||'').trim().toLowerCase();
  return (invites||[]).some(x=>String(x.email||'').toLowerCase()===m && !x.accepted_at && (!x.expires_at || new Date(x.expires_at).getTime()>now));
}
// @cloud-puro-fim
const sbGet = (q)=>sbFetch('/rest/v1/'+q);
const sbPost = (t,body)=>sbFetch('/rest/v1/'+t, { method:'POST', headers:{ 'Prefer':'return=representation' }, body: JSON.stringify(body) });
const sbRpc = (fn,args)=>sbFetch('/rest/v1/rpc/'+fn, { method:'POST', body: JSON.stringify(args||{}) });

// ---- estado da tela ----
let cloudData = null;   // { org, teams, members(do time atual), meRole, profileByUser }
let cloudMsg = '';      // feedback (erro/ok) da última ação
let cloudInvLast = null; // convite recém-gerado: a mensagem pronta sobrevive ao redesenho da Conta
function cloudTeamId(){ return lsGet('sb:team') || ''; }
function cloudUserId(){ const s=SB.sess(); return s && s.user ? s.user.id : ''; }

let cloudCfgOpen=false; // força a tela de backend mesmo com o default baked
function openCloud(){ $id('cloudOverlay').style.display='flex'; renderCloud(); }
// "sair" SEMPRE visível no cabeçalho quando logado (o do corpo ficava enterrado)
{ const b=$id('sbLogoutTop');
  if(b) b.onclick=async()=>{ if(!await askYes('Sair da conta nesta máquina?')) return; sbLogout(); };
  setInterval(()=>{ const e=$id('sbLogoutTop'); if(e) e.style.display=SB.sess()?'':'none'; }, 1500); }
function closeCloud(){
  if(!SB.sess() && $id('cloudOverlay').dataset.lock==='1') return; // login é obrigatório
  const o=$id('cloudOverlay'); cloudMsg='';
  if(o.classList.contains('astab') && window.closeTabOfKind){ closeTabOfKind('conta'); return; } // aba: fecha a aba (não deixa em branco)
  o.style.display='none';
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
  if(typeof devUiSync==='function') devUiSync(); // "Publicar release" aparece pra owner/admin
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
setTimeout(()=>loginGateSync(), 3000); // depois do refresh de sessão do boot (arrow: usa a versão do 44-onboarding)

// retorno da última ação: erro em destaque (antes era cinza-claro de 11px e passava batido) e anunciado ao leitor de tela
function cloudMsgHtml(){ if(!cloudMsg) return ''; const ok=cloudMsg.startsWith('✓');
  return `<div class="imhint cloudmsg ${ok?'ok':'bad'}" role="${ok?'status':'alert'}">${esc(cloudMsg)}</div>`; }

async function renderCloud(){
  const body=$id('cloudBody'); if(!body) return;
  const head=$id('cloudHead');
  // 1) tela de backend (aparece se não há default nem config, ou via "backend…")
  if(!SB.configured() || cloudCfgOpen){
    head.textContent='Conta e time · servidor (avançado)';
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
  // 2) sem sessão → a tela de entrada (44-onboarding) é o ÚNICO formulário de conta: criar, entrar, código,
  // esqueci a senha — com os erros traduzidos. Aqui fica só o atalho pra ela (+ "servidor…" pra dev/admin).
  // (antes havia um 2º formulário aqui, com mínimo de 6 caracteres, Google sempre visível e erros em inglês)
  if(!SB.sess()){
    head.textContent='Conta e time · entrar';
    body.innerHTML = cloudMsgHtml()+`
      <div class="imhint">${esc(T('auth.cloud.nosess'))}</div>
      <div style="display:flex;gap:8px;margin-top:16px;align-items:center">${(canSeeDevTools()||lsGet('sb:url'))?'<button class="btn sm" id="sbCfgEdit" title="avançado: trocar o servidor da conta (dev/admin)">servidor…</button>':''}<span style="flex:1"></span><button class="btn primary" id="sbOpenAuth">${esc(T('auth.cloud.open'))}</button></div>`;
    bindClick('sbOpenAuth', ()=>{ if(typeof auShow==='function') auShow(lsGet('sb:email')?'login':'signup'); });
    bindClick('sbCfgEdit', ()=>{ cloudCfgOpen=true; renderCloud(); });
    return;
  }
  // dados frescos
  let loadErr=null;
  if(!cloudData){ ldPaint(body, skeletonHtml('lista',{ head:true, n:4, label:'buscando a conta' })); try{ await tabBusy('conta', cloudLoad(), { label:'buscando a conta e o time' }); }catch(e){ loadErr=e; } }
  // carga FALHOU (sem rede, servidor fora): erro com "tentar de novo". Antes caía no "Criar organização" —
  // quem já tinha org, offline, via o formulário de criar outra (e podia criar uma duplicada).
  // (mesmo que o cloudLoad tenha preenchido parte do cloudData antes de falhar: dado pela metade não é mostrado)
  if(loadErr){
    cloudData=null; head.textContent='Conta e time';
    // o retorno da ação que disparou o recarregamento (ex.: "sem permissão") continua visível acima do erro
    body.innerHTML=cloudMsgHtml()+errorHtml(loadErr, 'cloudRetry', 'Não consegui carregar a conta'); // "sair da conta" fica no cabeçalho
    ldWireErr(body, loadErr, 'Não consegui carregar a conta', ()=>{ cloudMsg=''; renderCloud(); });
    return;
  }
  // 3) logado mas sem org → criar ou aceitar convite
  if(!cloudData || !cloudData.org){
    head.textContent='Conta e time · sua organização';
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
      const b=$id('sbCreateOrg'); if(b.disabled) return; b.disabled=true; b.textContent='criando…'; // 2 cliques = 2 organizações
      cloudMsg='';
      try{ const j=await sbRpc('create_org_with_team',{ p_org_name:$id('sbOrgName').value.trim()||'Minha org', p_team_name:$id('sbTeamName').value.trim()||'Time 1' }); lsSet('sb:team', j.team_id); cloudData=null; cloudMsg='✓ organização criada'; }
      catch(e){ cloudMsg=cloudErrMsg(e); }
      renderCloud();
    };
    $id('sbAccept').onclick=async()=>{
      cloudMsg='';
      const tok=$id('sbInvTok').value.trim();
      if(!tok){ cloudMsg='Cole o token do convite que o lead te mandou (ou peça um convite pro seu e-mail — aí ele entra sozinho).'; renderCloud(); setTimeout(()=>{ const i=$id('sbInvTok'); if(i) i.focus(); },0); return; }
      try{ const j=await sbRpc('accept_invite',{ p_token:tok }); if(!j.ok) throw new Error(j.error); lsSet('sb:team', j.team_id); cloudData=null; cloudMsg='✓ você entrou no time'; }
      catch(e){ cloudMsg=cloudErrMsg(e); }
      renderCloud();
    };
    $id('sbLogout').onclick=()=>sbLogout();
    return;
  }
  // 4) home: gestão da org — times, membros por time, convites, catálogo, visão
  const d=cloudData, teamId=cloudTeamId();
  head.textContent='Conta e time · '+d.org.name;
  const isAdmin = d.meRole==='owner'||d.meRole==='admin';
  const myLeadTeams = d.teams.filter(t=>(d.teamMembers[t.id]||[]).some(m=>m.user_id===cloudUserId()&&m.role==='lead'));
  const canManage = t => isAdmin || myLeadTeams.some(x=>x.id===t.id);
  const meLead = myLeadTeams.length>0;
  const pName = uid => { const p=d.profileByUser[uid]||{}; return p.name||p.email||String(uid).slice(0,8); };
  const teamsHtml = d.teams.map(t=>{
    const mems=d.teamMembers[t.id]||[];
    const rows=mems.map(m=>`<div class="mrow"><span class="mav" style="background:${agentColor(pName(m.user_id))}">${esc(pName(m.user_id).slice(0,2).toUpperCase())}</span><span class="mnm">${esc(pName(m.user_id))}${m.user_id===cloudUserId()?' <span class="mme">você</span>':''}</span><span class="mrole${m.role==='lead'?' lead':''}">${m.role==='lead'?'lead':'membro'}</span>${canManage(t)?`<span class="macts"><button class="btn sm ghost" data-mact="lead" data-team="${escA(t.id)}" data-uid="${escA(m.user_id)}" title="${m.role==='lead'?'volta a ser membro':'vira lead do time'}">${m.role==='lead'?'tornar membro':'tornar lead'}</button><button class="mrm" data-mact="rm" data-team="${escA(t.id)}" data-uid="${escA(m.user_id)}" title="remover do time">${IC.trash}</button></span>`:''}</div>`).join('') || '<div class="mempty">time vazio — adicione alguém abaixo</div>';
    const fora=(d.orgMembers||[]).filter(om=>!mems.some(m=>m.user_id===om.user_id));
    const addRow = canManage(t)&&fora.length ? `<div class="maddrow"><select class="sel" id="sbAdd-${escA(t.id)}" aria-label="pessoa pra adicionar ao time ${escA(t.name||'')}">${fora.map(om=>`<option value="${escA(om.user_id)}">${esc(pName(om.user_id))}</option>`).join('')}</select><button class="btn sm ghost" data-mact="add" data-team="${escA(t.id)}">+ adicionar ao time</button></div>` : '';
    const leadNames=mems.filter(m=>m.role==='lead').map(m=>pName(m.user_id));
    const leadTag=leadNames.length?`lead: ${esc(leadNames.join(', '))}`:'<span style="color:var(--warn)">sem lead</span>';
    return `<div class="tmcard tm2"><div class="tmhead"><div class="tmtl"><b class="tmtitle">${esc(t.name)}</b>${canManage(t)?`<button class="mrm" data-mact="rename" data-team="${escA(t.id)}" title="renomear time">${IC.pencil}</button>`:''}<span class="tmmeta">${mems.length} membro${mems.length===1?'':'s'} · ${leadTag} · só o time vê o que ele faz</span></div><span class="tmr">${t.id===teamId?'<span class="tmbadge on">time atual</span>':`<button class="btn sm ghost" data-mact="use" data-team="${escA(t.id)}">usar este time</button>`}${isAdmin?`<button class="mrm" data-mact="delteam" data-team="${escA(t.id)}" title="excluir time">${IC.trash}</button>`:''}</span></div><div class="mlist">${rows}</div>${addRow}</div>`;
  }).join('');
  const invTeams = isAdmin ? d.teams : myLeadTeams;
  const invListHtml=(d.invites||[]).map(iv=>{ const tn=(d.teams.find(x=>x.id===iv.team_id)||{}).name||'?'; return `<div class="mrow"><span class="mav" style="background:var(--surface-3);color:var(--muted)">@</span><span class="mnm">${esc(iv.email)}<span class="msub">${esc(tn)} · ${iv.role==='lead'?'lead':'membro'} · expira em ${Math.max(0,Math.round((new Date(iv.expires_at)-Date.now())/86400e3))}d</span></span><span class="macts"><button class="btn sm ghost" data-iact="copy" data-iv="${escA(iv.id)}">copiar mensagem</button><button class="mrm" data-iact="rev" data-iv="${escA(iv.id)}" title="revogar convite">${IC.trash}</button></span></div>`; }).join('');
  const seatsUsed=(d.orgMembers||[]).length, seatsFull=seatsUsed>=d.org.seats;
  body.innerHTML = cloudMsgHtml()+`
    ${!d.org.license_key?`<div class="imhint" style="border-left:2px solid var(--warn)">${IC.warn} Organização <b>sem licença</b> — modo avaliação. ${d.meRole==='owner'?'Defina a chave na seção Licença abaixo.':'Peça ao owner pra ativar a licença.'}</div>`:''}
    ${seatsFull?`<div class="imhint" style="border-left:2px solid var(--warn)">${IC.warn} Todos os <b>${d.org.seats} assentos</b> em uso — convites novos serão recusados até liberar assento ou ampliar o plano.</div>`:''}
    <div class="imhint">Plano <b>${esc(d.org.plan)}</b> · ${seatsUsed}/${d.org.seats} assentos · seu papel na org: <b>${esc(d.meRole)}</b>${isAdmin?' — você vê e administra todos os times':''}</div>
    <div class="seclbl2" style="margin-top:16px">Times da organização <span class="n">${d.teams.length}</span><span style="flex:1"></span>${isAdmin?'<button class="btn sm" id="sbTeamAdd">+ novo time</button>':''}</div>
    ${teamsHtml||'<div class="dim" style="font-size:12px">nenhum time ainda</div>'}
    ${(isAdmin||meLead)?`
    <div class="seclbl2" style="margin-top:18px">Convidar gente nova <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· pra quem ainda não tem conta — quem já tem, use "+ adicionar ao time"</span></div>
    <div style="display:flex;gap:8px;margin-top:6px"><input class="in" id="sbInvEmail" aria-label="e-mail do convidado" placeholder="email@empresa.com" style="flex:1"><select class="sel" id="sbInvTeam" aria-label="time do convite" style="width:150px">${invTeams.map(t=>`<option value="${escA(t.id)}"${t.id===teamId?' selected':''}>${esc(t.name)}</option>`).join('')}</select><select class="sel" id="sbInvRole" aria-label="papel do convidado" style="width:100px"><option value="member">membro</option><option value="lead">lead</option></select><button class="btn primary sm" id="sbInvite">gerar convite</button></div>
    <div id="sbInvOut"></div>
    ${invListHtml?`<div class="seclbl2" style="margin-top:14px">Convites pendentes <span class="n">${d.invites.length}</span></div><div class="mlist tm2">${invListHtml}</div>`:''}`:''}
    ${isAdmin?`<div class="seclbl2" style="margin-top:18px">Membros da organização <span class="n">${seatsUsed}</span></div>
    <div class="mlist tm2">${(d.orgMembers||[]).map(om=>`<div class="mrow"><span class="mav" style="background:${agentColor(pName(om.user_id))}">${esc(pName(om.user_id).slice(0,2).toUpperCase())}</span><span class="mnm">${esc(pName(om.user_id))}${om.user_id===cloudUserId()?' <span class="mme">você</span>':''}</span><span class="mrole${om.role==='owner'||om.role==='admin'?' lead':''}">${esc(om.role)}</span>${(om.role!=='owner'&&om.user_id!==cloudUserId())?`<span class="macts"><button class="btn sm ghost" data-orgrm="${escA(om.user_id)}" title="remove da organização e de todos os times — libera o assento">remover da org</button></span>`:''}</div>`).join('')}</div>`:''}
    <div class="seclbl2" style="margin-top:18px">Agentes &amp; equipes da organização</div>
    <div id="sbCat" class="dim" style="font-size:12px;padding:4px 2px">${skeletonHtml('lista',{ n:2, compact:true, inline:true, label:'carregando o catálogo' })}</div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm" id="sbCatPull" title="copia os agentes e equipes da organização pras configurações do projeto aberto">aplicar neste projeto</button>${isAdmin?`<button class="btn sm" id="sbCatPush" title="publica os agentes/workflows do projeto aberto pra org inteira">enviar os deste projeto</button>`:''}</div>
    ${isAdmin?`<div class="seclbl2" style="margin-top:18px">Visão da organização</div><div id="sbOrgView" class="dim" style="font-size:12px;padding:4px 2px">${skeletonHtml('lista',{ n:2, compact:true, inline:true, label:'carregando a visão da organização' })}</div>`:''}
    ${d.meRole==='owner'?`<div class="seclbl2" style="margin-top:18px">Licença</div><div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="mono dim" style="font-size:11px;flex:1;word-break:break-all">${esc(d.org.license_key||'sem chave — plano de avaliação')}</span><button class="btn sm" id="sbLicSet">definir chave</button></div>`:''}
    <div style="display:flex;margin-top:22px;align-items:center;gap:8px"><span class="dim" style="font-size:11px">${esc((SB.sess().user||{}).email||'')}</span><span style="flex:1"></span><button class="btn sm" id="sbPassChange" title="define uma senha nova pra sua conta">trocar senha</button><button class="btn sm" id="sbLogout">sair</button></div>
    <div class="imhint" style="margin-top:12px">O backlog compartilhado fica na aba <b>Time</b> da tela principal — crie tarefas com “Compartilhar com o time”.</div>`;
  bindClick('sbTeamAdd', async()=>{ const n=await askText('Novo time','ex.: Data'); if(!n) return; cloudMsg=''; try{ const rows=await sbPost('teams',{ org_id:d.org.id, name:n }); await sbPost('team_members',{ team_id:rows[0].id, user_id:cloudUserId(), role:'lead' }); lsSet('sb:team',rows[0].id); cloudData=null; cloudMsg='✓ time criado'; }catch(e){ cloudMsg=cloudErrMsg(e); } renderCloud(); });
  // ações nos times: usar / promover-rebaixar / remover / adicionar membro
  body.querySelectorAll('[data-mact]').forEach(b=>{ b.onclick=async()=>{
    const act=b.dataset.mact, tid=b.dataset.team, uid=b.dataset.uid; cloudMsg='';
    try{
      if(act==='use'){ lsSet('sb:team', tid); cloudData=null; renderCloud(); cloudBtnSync(); return; }
      if(act==='add'){ const sel=$id('sbAdd-'+tid); if(!sel||!sel.value) return; await sbPost('team_members',{ team_id:tid, user_id:sel.value, role:'member' }); cloudMsg='✓ adicionado ao time'; }
      if(act==='rm'){ const nm=pName(uid); if(!await askYes('Remover '+nm+' deste time?')) return; await sbFetch('/rest/v1/team_members?team_id=eq.'+tid+'&user_id=eq.'+uid, { method:'DELETE' }); cloudMsg='✓ removido do time'; }
      if(act==='lead'){ const cur=(d.teamMembers[tid]||[]).find(m=>m.user_id===uid); await sbFetch('/rest/v1/team_members?team_id=eq.'+tid+'&user_id=eq.'+uid, { method:'PATCH', body: JSON.stringify({ role: cur&&cur.role==='lead'?'member':'lead' }) }); cloudMsg='✓ papel atualizado'; }
      if(act==='rename'){ const cur=(d.teams.find(x=>x.id===tid)||{}).name||''; const n=await askText('Renomear time',cur,cur); if(n===null||!n.trim()||n.trim()===cur){ return; } await sbFetch('/rest/v1/teams?id=eq.'+tid, { method:'PATCH', body: JSON.stringify({ name:n.trim() }) }); cloudMsg='✓ time renomeado'; }
      if(act==='delteam'){ const tm=(d.teamMembers[tid]||[]).length; const nm=(d.teams.find(x=>x.id===tid)||{}).name||'time'; if(!await askYes('Excluir o time "'+nm+'"?'+(tm?'\n\n'+tm+' membro(s) perdem o vínculo. As tarefas do time continuam no histórico.':''))) return; await sbFetch('/rest/v1/teams?id=eq.'+tid, { method:'DELETE' }); if(teamId===tid){ lsSet('sb:team',''); } cloudMsg='✓ time excluído'; }
      cloudData=null; renderCloud(); cloudBtnSync();
    }catch(e){ cloudMsg=cloudErrMsg(e); cloudData=null; renderCloud(); } // recarrega: o erro mais comum é a lista estar velha
  }; });
  // remover membro da ORG (admin): sai de todos os times + libera o assento
  body.querySelectorAll('[data-orgrm]').forEach(b=>{ b.onclick=async()=>{
    const uid=b.dataset.orgrm, nm=pName(uid);
    if(!await askYes('Remover '+nm+' da ORGANIZAÇÃO?\n\nSai de todos os times e libera o assento. As tarefas que a pessoa criou/assumiu continuam no histórico.')) return;
    cloudMsg='';
    try{
      for(const t of d.teams){ await sbFetch('/rest/v1/team_members?team_id=eq.'+t.id+'&user_id=eq.'+uid, { method:'DELETE' }).catch(()=>{}); }
      await sbFetch('/rest/v1/org_members?org_id=eq.'+d.org.id+'&user_id=eq.'+uid, { method:'DELETE' });
      cloudData=null; cloudMsg='✓ '+nm+' removido da organização';
    }catch(e){ cloudMsg=cloudErrMsg(e); }
    renderCloud();
  }; });
  // convites pendentes: copiar mensagem / revogar
  const invMsg=(iv)=>cloudInviteMsg((d.teams.find(x=>x.id===iv.team_id)||{}).name||'', d.org.name, iv.email, iv.token);
  body.querySelectorAll('[data-iact]').forEach(b=>{ b.onclick=async()=>{
    const iv=(d.invites||[]).find(x=>x.id===b.dataset.iv); if(!iv) return;
    if(b.dataset.iact==='copy'){ cloudCopy(invMsg(iv), b); return; }
    if(!await askYes('Revogar o convite de '+iv.email+'?')) return;
    cloudMsg='';
    try{ await sbFetch('/rest/v1/invites?id=eq.'+iv.id, { method:'DELETE' }); cloudData=null; cloudMsg='✓ convite revogado'; }catch(e){ cloudMsg=cloudErrMsg(e); }
    renderCloud();
  }; });
  { const inp=$id('sbInvEmail'); if(inp) inp.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); const b=$id('sbInvite'); if(b) b.click(); } }; }
  { const b=$id('sbInvite'); if(b) b.onclick=async()=>{
      if(b.disabled) return;
      cloudMsg='';
      const mail=$id('sbInvEmail').value.trim().toLowerCase();
      const invErr=m=>{ const o=$id('sbInvOut'); if(o) o.innerHTML=`<div class="imhint" role="alert" style="margin-top:10px;border-left:2px solid var(--warn)">${esc(m)}</div>`; const i=$id('sbInvEmail'); if(i) i.focus(); };
      // validação local: antes ia pro servidor e voltava em inglês (ou gerava convite pra "ana@x")
      if(!mail) return invErr('Digite o e-mail da pessoa que você quer convidar.');
      if(typeof authValidEmail==='function' && !authValidEmail(mail)) return invErr('Esse e-mail não parece válido — confira se está completo (ex.: ana@empresa.com).');
      if(cloudInvitePending(d.invites, mail, Date.now())) return invErr('Já existe um convite pendente pra '+mail+' — use "copiar mensagem" na lista de convites abaixo.');
      if(seatsFull) return invErr('Todos os '+d.org.seats+' assentos estão em uso — libere um assento ou amplie o plano antes de convidar.');
      b.disabled=true;
      try{
        const invTeamId=$id('sbInvTeam').value;
        const rows=await sbPost('invites',{ org_id:d.org.id, team_id:invTeamId, email:mail, role:$id('sbInvRole').value, created_by:cloudUserId() });
        const tok=rows[0].token; (d.invites||(d.invites=[])).push(rows[0]); // 2º clique no mesmo e-mail já avisa que existe
        const teamName=(d.teams.find(x=>x.id===invTeamId)||{}).name||'';
        const msg=cloudInviteMsg(teamName, d.org.name, mail, tok);
        // redesenha a Conta (com os dados que já temos + o convite novo): a lista "Convites pendentes" ganha a linha
        // com copiar/revogar; a mensagem pronta volta no mesmo lugar logo abaixo do campo
        cloudInvLast={ mail, msg }; renderCloud();
      }catch(e){ const o=$id('sbInvOut'); if(o) o.innerHTML=`<div class="imhint" role="alert" style="margin-top:10px;border-left:2px solid var(--warn)">${esc(cloudErrMsg(e))}</div>`; }
      finally{ b.disabled=false; }
    }; }
  if(cloudInvLast){ const { mail, msg }=cloudInvLast; cloudInvLast=null; const o=$id('sbInvOut');
    if(o){ o.innerHTML=`<div class="imhint" style="margin-top:10px;border-left:2px solid var(--good)">✓ convite gerado pra <b>${esc(mail)}</b> — o token <b>só funciona logado com esse e-mail</b>. Mande a mensagem pronta:<div class="mono" style="margin-top:6px;user-select:all;word-break:break-all;white-space:pre-wrap;font-size:11px">${esc(msg)}</div><button class="btn sm" id="sbInvCopy" style="margin-top:8px">copiar mensagem</button></div>`;
      $id('sbInvCopy').onclick=function(){ cloudCopy(msg, this); }; } }
  $id('sbLogout').onclick=()=>sbLogout();
  bindClick('sbPassChange', ()=>auShow('newpass', { backTo: ()=>{ if(window.openTab) window.openTab('conta'); } }));
  cloudCatalog(d.org.id, isAdmin);
  if(isAdmin){
    cloudOrgView().then(rows=>{
      const el=$id('sbOrgView'); if(!el) return;
      el.innerHTML = rows.length ? `<div class="costlist">`+rows.map(r=>`<div class="costrow"><span class="cnm">${esc(r.name)}</span><span class="dim" style="font-size:11px">${r.n} tarefas · ${r.run} em andamento · ${r.done} entregues</span><span class="cusd">${fmtUsd(r.usd)}</span></div>`).join('')+`</div>` : 'nenhum time ainda';
    }).catch(e=>{ const el=$id('sbOrgView'); if(el) el.textContent=cloudErrMsg(e); });
  }
  { const b=$id('sbLicSet'); if(b) b.onclick=async()=>{
      const k=await askText('Chave de licença da organização','LOGCOMEX-…', d.org.license_key||''); if(k===null) return;
      cloudMsg='';
      try{ await sbFetch('/rest/v1/orgs?id=eq.'+d.org.id, { method:'PATCH', body: JSON.stringify({ license_key: k.trim()||null }) }); cloudData=null; cloudMsg='✓ licença atualizada'; }
      catch(e){ cloudMsg=cloudErrMsg(e); }
      renderCloud();
    }; }
  cloudBtnSync();
  if(typeof billingRenderCloud==='function') billingRenderCloud();
  if(typeof orgDefaultsRenderCloud==='function') orgDefaultsRenderCloud(isAdmin);
  if(typeof secretsRenderCloud==='function') secretsRenderCloud();
}
// copiar pra área de transferência com retorno de verdade (antes: "copiado ✓" mesmo quando o sistema recusava)
async function cloudCopy(text, btn){ try{ await navigator.clipboard.writeText(text); if(btn) btn.textContent='copiado ✓'; }catch(_){ if(btn) btn.textContent='não copiou — selecione o texto'; } }
// seção "Padrões da organização" na Conta (admins editam; o resto só vê)
function orgDefaultsRenderCloud(isAdmin){
  const body=$id('cloudBody'); if(!body||!SB.sess()) return;
  const el=document.createElement('div');
  el.innerHTML=`<div class="seclbl2" style="margin-top:16px">Padrões de demanda</div>
    <div style="display:flex;align-items:center;gap:10px;font-size:12.5px">
      <span style="flex:1" class="dim">guia de spec + política valem pra org inteira; cada repo pode refinar na própria pasta de trabalho do Starfork</span>
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
    }catch(e){ $id('orgTplMsg').textContent=cloudErrMsg(e); }
    finally{ b.disabled=false; }
  };
}
