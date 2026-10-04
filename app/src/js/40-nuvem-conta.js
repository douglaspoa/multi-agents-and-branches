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
  if(custom&&isLocal) m+=' — este app está apontando pra um backend LOCAL que não está rodando. Em Ajustes › Sistema › Servidor da conta, clique em "usar a nuvem (padrão)".';
  else if(custom) m+=' — backend personalizado configurado. Confira em Ajustes › Sistema › Servidor da conta ou clique em "usar a nuvem (padrão)".';
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
    +`3. Se não entrar: em Ajustes › Times e pessoas › "aceitar convite", cole este código:\n${token}`;
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

let cloudCfgOpen=false; // compat: o servidor da conta agora mora em Ajustes › Sistema
// "Conta e time" virou Ajustes › Conta e time (67-ajustes, F4 · G3): abrir/fechar/redesenhar delegam pra lá
function openCloud(){ if(typeof ajustesOpen==='function') ajustesOpen(cloudCfgOpen?'sistema':'perfil'); cloudCfgOpen=false; }
function closeCloud(){ cloudMsg=''; if(window.closeTabOfKind) closeTabOfKind('cfg'); }

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
  if(typeof SF_PANE!=='undefined' && SF_PANE) return; // painel da tela dividida: o login é da janela principal
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

// a conta mudou (login, sair, ação): Ajustes redesenha a seção da conta que estiver aberta (o retorno vem em cloudMsg)
function renderCloud(){ if(typeof ajustesRefreshConta==='function') ajustesRefreshConta(); }
// copiar pra área de transferência com retorno de verdade (antes: "copiado ✓" mesmo quando o sistema recusava)
async function cloudCopy(text, btn){ try{ await navigator.clipboard.writeText(text); if(btn) btn.textContent='copiado ✓'; }catch(_){ if(btn) btn.textContent='não copiou — selecione o texto'; } }
// "Padrões de demanda" (modal) + "Política" (Meu time) viraram UMA página: Ajustes › Regras da organização (63-politica-org:
// orgRulesRender) — com versão, e só leitura pra quem não é o dono.
