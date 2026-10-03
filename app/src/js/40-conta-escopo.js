// Starfork — 40-conta-escopo
/* ============================================================================
   PROJETOS E NUVEM POR CONTA (fix/projetos-por-conta)
   Trocar de conta (ex.: a do trabalho → a pessoal) deixava os projetos da outra conta na barra lateral e
   na Central, e os laços da nuvem seguiam publicando as tarefas deles com a conta errada (RLS no log).
   - a lista de projetos (~/.cardume/projects.json) agora tem DONO por projeto (Rust: projetos_conta.rs);
     o front avisa a conta da vez (set_projects_user) no boot e a cada troca de sessão;
   - o mapa tarefa→cartão e os cursores da nuvem (sb:tmap, sb:feedpos, ep:mirrored, sb:seen*) são POR USUÁRIO;
     o mapa antigo (sem usuário) vira um "estoque" que cada conta reivindica pelo que enxerga na nuvem;
   - os laços da nuvem só rodam com a conta já migrada (cloudScopeOk) e nunca publicam tarefa cujo cartão é
     de outra conta (tmapForeign);
   - migração dos donos: evidência da nuvem (cartões que esta conta enxerga) + e-mails dos commits.
   ========================================================================= */
// @escopo-inicio — regras PURAS (testadas em app/tests/projetos-por-conta.test.mjs)
const OTHER_ACCOUNT='outra-conta'; // = projetos_conta::OTHER_ACCOUNT (Rust): de outra conta, ainda sem id conhecido
// chave do localStorage de UM usuário (sem sessão → ':-', que nunca se mistura com conta nenhuma)
function userKey(base, uid){ return base+':'+(uid||'-'); }
// provedores públicos: e-mail daqui não diz de que empresa o projeto é
const MAIL_PUBLIC=new Set(['gmail.com','googlemail.com','hotmail.com','hotmail.com.br','outlook.com','outlook.com.br','live.com','msn.com','yahoo.com','yahoo.com.br','icloud.com','me.com','mac.com','aol.com','proton.me','protonmail.com','gmx.com','zoho.com','yandex.com','uol.com.br','bol.com.br','terra.com.br','ig.com.br']);
function mailDomain(e){ const m=String(e||'').trim().toLowerCase().match(/@([a-z0-9.-]+)$/); return m?m[1]:''; }
// domínio de EMPRESA: não é provedor público, nem noreply do GitHub, nem nome de máquina (Mac.lan, .local)
function mailCorp(d){
  return !!d && d.includes('.') && !MAIL_PUBLIC.has(d) && !/(^|\.)github\.com$/.test(d) && !/\.(lan|local|localdomain|home|internal)$/.test(d);
}
// o que os e-mails de commit de um repo dizem sobre a conta logada (`myEmail`):
//   mine = o meu e-mail commitou ali · sameOrg = alguém do MEU domínio de empresa · foreignOrg = de OUTRA empresa
function mailSignals(emails, myEmail){
  const me=String(myEmail||'').trim().toLowerCase(), myDom=mailDomain(me), myCorp=mailCorp(myDom)?myDom:'';
  let mine=false, sameOrg=false, foreignOrg=false;
  for(const e of (emails||[])){
    const x=String(e||'').trim().toLowerCase(); if(!x) continue;
    if(me && x===me){ mine=true; continue; }
    const d=mailDomain(x); if(!mailCorp(d)) continue;
    if(myCorp && d===myCorp) sameOrg=true; else foreignOrg=true;
  }
  return { mine, sameOrg, foreignOrg };
}
// dono de um projeto pela evidência (conta logada = `me`):
//   ev.cardsMine   tarefas do projeto com cartão MEU (que eu enxergo e criei/assumi)
//   ev.cardsHidden tarefas com cartão que esta conta NÃO enxerga (ou mapeado por outra conta nesta máquina)
//   ev.cardsOther  cartão visível mas de outra pessoa do time
//   ev.mail        mailSignals dos commits
// Devolve o uid, OTHER_ACCOUNT, null (sem dono: ambíguo, aparece pra todas) ou undefined (não mexe).
// `firstRun` = 1ª migração do formato antigo: sem evidência nenhuma, o projeto é da conta logada.
function projOwnerDecide(ev, me, firstRun){
  if(!me) return undefined;
  const m=(ev&&ev.mail)||{}, mine=(ev&&ev.cardsMine)||0, hidden=(ev&&ev.cardsHidden)||0, other=(ev&&ev.cardsOther)||0;
  if(mine>0) return me;                                     // a nuvem diz que é meu
  if(m.mine || m.sameOrg) return (hidden>0 || m.foreignOrg) ? null : me; // meu pelo git; com sinal contrário = ambíguo
  if(hidden>0 && m.foreignOrg) return OTHER_ACCOUNT;         // cartões que não enxergo + commits de outra empresa
  if(hidden>0 || other>0 || m.foreignOrg) return null;       // um sinal só: ambíguo → fica visível pra todas
  return firstRun ? me : undefined;                         // nada contra: é da conta que estava logada
}
// projeto marcado como "outra conta": só a conta com evidência POSITIVA o reivindica
function projClaimOk(ev, me){ return projOwnerDecide(ev, me, false)===me; }
// separa o mapa antigo (sem usuário) entre o que é MEU (cartão visível, criado ou assumido por mim) e o resto
function tmapSplit(legacy, cards, me){
  const mineIds=new Set((cards||[]).filter(c=>c && me && (c.created_by===me || c.assignee===me)).map(c=>c.id));
  const mine={}, rest={};
  for(const lid in (legacy||{})){ const cid=legacy[lid]; if(mineIds.has(cid)) mine[lid]=cid; else rest[lid]=cid; }
  return { mine, rest };
}
// tarefas locais cujo cartão é de OUTRA conta: o estoque antigo + os mapas das outras contas desta máquina
// (`maps` = { chaveDoLocalStorage: {lid:cid} }; a minha chave fica de fora)
function tmapForeignOf(maps, myKey){
  const out=new Set();
  for(const k in (maps||{})){ if(k===myKey) continue; for(const lid in (maps[k]||{})) out.add(lid); }
  return out;
}
// "dodosobreira@gmail.com" → "dodosobr…@gmail.com" (cabe na barra lateral)
function emailShort(e){
  const s=String(e||'').trim(); const i=s.lastIndexOf('@'); if(i<0) return s.length>18?s.slice(0,16)+'…':s;
  const u=s.slice(0,i), d=s.slice(i); return (u.length>10?u.slice(0,8)+'…':u)+d;
}
function projScopeText(email, hidden){
  const h=+hidden||0;
  return 'mostrando os projetos de '+emailShort(email)+(h?' · '+h+(h===1?' de outra conta oculto':' de outras contas ocultos'):'');
}
// @escopo-fim

// ---- runtime ----
let projScope={ visible:0, hidden:0, pending:false };
let acctBusy=null;            // sincronia da conta em voo (uma por vez)
let acctReadyUid='';          // conta cujo escopo já foi aplicado nesta sessão do app
// laços da nuvem só rodam com a conta da vez aplicada e o mapa dela migrado — nunca com o mapa de outra
function cloudScopeOk(){
  const me=(typeof cloudUserId==='function')?cloudUserId():'';
  return !!me && acctReadyUid===me && lsGet(userKey('sb:tmapmig', me))==='1';
}
function lsJsonRead(k){ try{ return JSON.parse(lsGet(k)||'{}')||{}; }catch(_){ return {}; } }
function lsKeys(){ try{ return Object.keys(localStorage); }catch(_){ return []; } }
// tarefas locais com cartão de OUTRA conta (cloudAutoPublish/backfill pulam — senão republicariam com a conta errada)
function tmapForeign(){
  const me=cloudUserId(); const maps={};
  maps['sb:tmap']=lsJsonRead('sb:tmap'); // estoque antigo ainda não reivindicado
  lsKeys().filter(k=>k.startsWith('sb:tmap:')).forEach(k=>{ maps[k]=lsJsonRead(k); });
  return tmapForeignOf(maps, userKey('sb:tmap', me));
}
const acctReset=(f)=>{ try{ f(); }catch(_){ } };
const acctClear=(o)=>{ if(!o) return; if(o instanceof Set || o instanceof Map) o.clear(); else for(const k in o) delete o[k]; };
// tudo que está em memória e é da conta: some na troca (o próximo tick busca de novo, já com a conta nova)
function acctResetCaches(){
  acctReset(()=>{ teamTasks=null; teamProj={}; teamProfiles={}; teamFetchedAt=0; teamEpics=[]; teamActivity=[]; teamPaintSig=''; teamRepoRemote=''; teamRepoIds=null; });
  acctReset(()=>{ teamNotifReady=false; tsLocalIdx={ src:null, m:{} }; });
  acctReset(()=>{ ctpTask=null; acctClear(ctpCache); });
  acctReset(()=>{ acctClear(epCache); epQueue={ rows:[], stOf:{}, flagOf:{}, titleOf:{}, epicOf:{}, projOf:{}, progOf:{}, sibsOf:{}, here:'', localIds:[], at:0 }; taskOriginIdx={ a:null, b:null, m:{} }; acctClear(epAutoWarned); });
  acctReset(()=>{ acctClear(cloudSyncSigs); acctClear(prProbed); acctClear(autoPubFails); acctClear(autoPubLast); feedRepaired=false; });
  acctReset(()=>{ acctClear(intentBusy); acctClear(prPubAt); acctClear(qPushed); acctClear(qNotified); acctClear(remoteStartFails); acctClear(msgDelivering); acctClear(pushedReady); });
  acctReset(()=>{ apnsTokens=null; apnsTokensAt=0; appVerSent=''; acctClear(cloudPubCache); acctClear(tmPending); acctClear(tmTried); });
  acctReset(()=>{ allTasksCache=[]; allTasksSig=''; allTasksAt=0; });
  acctReset(()=>{ projOv=null; projOvAt=0; });
  acctReset(()=>{ localRemoteAt=0; localRemoteList=[]; });
  acctReset(()=>{ trfCache=null; trfAt=0; });
  acctReset(()=>{ orqListAt=0; });
}
// o time escolhido é da CONTA: guarda o da que saiu e devolve o da que entrou (cloudLoad valida)
function acctSwapTeam(prev, next){
  if(prev) lsSet(userKey('sb:team', prev), lsGet('sb:team')||'');
  lsSet('sb:team', next ? (lsGet(userKey('sb:team', next))||'') : '');
}
// chaves que viraram por usuário: o valor antigo (sem usuário) vai pra 1ª conta que entrar — só o que é
// idempotente (marcas já espelhadas, avisos já vistos); o mapa de cartões tem migração própria (tmapMigrate)
function acctMigrateKeys(me){
  ['ep:mirrored','sb:seenpr','sb:seencard','sb:seenrev'].forEach(k=>{ if(lsMigrateKey(k, userKey(k, me), lsGet, lsSet)) lsSet(k, ''); });
}
function pgInQ(ids){ return '('+ids.map(x=>'"'+x+'"').join(',')+')'; }
// cartões que ESTA conta enxerga, em lotes (RLS esconde o resto). Lança se a rede falhar (migração tenta depois).
async function acctCardsVisible(cids){
  const out=[]; const ids=[...new Set(cids.filter(Boolean))];
  for(let i=0; i<ids.length; i+=50) out.push(...((await sbGet('tasks?select=id,created_by,assignee&id=in.'+pgInQ(ids.slice(i,i+50))))||[]));
  return out;
}
// mapa antigo → o desta conta (só os cartões dela); o cursor do feed vai junto. Uma vez por conta.
async function tmapMigrate(me){
  const flag=userKey('sb:tmapmig', me);
  if(lsGet(flag)==='1') return;
  const pool=lsJsonRead('sb:tmap'); const lids=Object.keys(pool);
  if(lids.length){
    const cards=await acctCardsVisible(lids.map(l=>pool[l]));
    const { mine, rest }=tmapSplit(pool, cards, me);
    const myKey=userKey('sb:tmap', me);
    lsSet(myKey, JSON.stringify({ ...mine, ...lsJsonRead(myKey) }));
    lsSet('sb:tmap', JSON.stringify(rest));
    const fp=lsJsonRead('sb:feedpos'), myFp=lsJsonRead(userKey('sb:feedpos', me));
    for(const lid in mine){ if(fp[lid]!=null && myFp[lid]==null) myFp[lid]=fp[lid]; delete fp[lid]; }
    lsSet(userKey('sb:feedpos', me), JSON.stringify(myFp)); lsSet('sb:feedpos', JSON.stringify(fp));
    invoke('web_log',{ line:'[conta] mapa da nuvem migrado: '+Object.keys(mine).length+' cartão(ões) desta conta, '+Object.keys(rest).length+' de outra(s)' }).catch(()=>{});
  }
  lsSet(flag, '1');
}
// donos dos projetos: 1ª vez (formato antigo) e "outra conta" que esta conta pode reivindicar
async function projOwnerMigrate(me){
  if(!projScope.pending && !(+projScope.hidden>0)) return false; // nada antigo nem "outra conta" a reivindicar: sem git log
  const audit=await invoke('projects_owner_audit');
  const items=(audit&&audit.items)||[];
  const todo=items.filter(it=>(audit.pending && !it.owner) || it.owner===OTHER_ACCOUNT);
  if(!todo.length){ if(audit && audit.pending) await invoke('assign_project_owners',{ assign:[], done:true }); return false; }
  const myMap=tmap(), pool=lsJsonRead('sb:tmap'), others={};
  lsKeys().filter(k=>k.startsWith('sb:tmap:') && k!==userKey('sb:tmap', me)).forEach(k=>Object.assign(others, lsJsonRead(k)));
  // cartões do estoque antigo dos projetos em jogo: uma consulta (em lotes) pra todos
  const poolCids=[]; todo.forEach(it=>(it.taskIds||[]).forEach(l=>{ if(pool[l] && !myMap[l]) poolCids.push(pool[l]); }));
  const vis={}; (await acctCardsVisible(poolCids.slice(0,600))).forEach(c=>{ vis[c.id]=c; });
  const email=((SB.sess()||{}).user||{}).email||'';
  const assign=[];
  for(const it of todo){
    const ev={ cardsMine:0, cardsHidden:0, cardsOther:0, mail:mailSignals(it.emails, email) };
    for(const l of (it.taskIds||[])){
      if(myMap[l]){ ev.cardsMine++; continue; }
      if(others[l]){ ev.cardsHidden++; continue; }
      const cid=pool[l]; if(!cid) continue;
      const c=vis[cid];
      if(!c){ if(poolCids.indexOf(cid)<600) ev.cardsHidden++; }
      else if(c.created_by===me || c.assignee===me) ev.cardsMine++;
      else ev.cardsOther++;
    }
    if(it.owner===OTHER_ACCOUNT){ if(projClaimOk(ev, me)) assign.push({ path:it.path, owner:me }); continue; }
    const o=projOwnerDecide(ev, me, true);
    if(o!==undefined) assign.push({ path:it.path, owner:o });
    invoke('web_log',{ line:'[conta] dono de '+it.path.split('/').pop()+': '+(o===me?'esta conta':o===OTHER_ACCOUNT?'outra conta':o===null?'sem dono (ambíguo)':'—')+' · '+JSON.stringify({ m:ev.cardsMine, h:ev.cardsHidden, o:ev.cardsOther, mail:ev.mail }) }).catch(()=>{});
  }
  await invoke('assign_project_owners',{ assign, done:true });
  return assign.length>0;
}
// projeto ativo trocou por causa da conta: zera a seleção e redesenha tudo
async function acctAfterSwitch(){
  acctReset(()=>{ selected=null; });
  acctReset(()=>{ lastSig=''; });
  acctReset(()=>clearProjectCaches());
  try{ await refresh(); }catch(_){ }
}
async function acctApplyProjects(){
  const me=cloudUserId();
  const r=await invoke('set_projects_user',{ user:me||'' });
  projScope=r||projScope;
  if(r && r.switched){ await acctAfterSwitch(); toast('Este projeto é de outra conta — abri '+(r.active?pathBase(r.active):'a tela inicial')+'.', 'info'); }
  acctReset(()=>{ projOv=null; projOvAt=0; allTasksAt=0; localRemoteAt=0; });
  acctReset(()=>loadProjects());
  acctReset(()=>{ if(typeof railProjTick==='function') railProjTick().catch(()=>{}); });
  acctReset(()=>renderRail());
}
// aplica a conta da vez: projetos visíveis, mapa da nuvem dela, donos migrados. Falha de rede → tenta em 1 min.
function acctSync(){
  if(SF_PANE) return Promise.resolve();
  if(acctBusy) return acctBusy;
  acctBusy=(async()=>{
    const me=cloudUserId();
    try{
      await acctApplyProjects();
      if(!me){ acctReadyUid=''; return; }
      acctMigrateKeys(me);
      await tmapMigrate(me);
      acctReadyUid=me; // laços liberados: o mapa desta conta está pronto
      if(await projOwnerMigrate(me)) await acctApplyProjects();
    }catch(e){
      console.warn('conta: sincronia do escopo falhou — tento de novo em 1 min', e&&e.message||e);
      setTimeout(()=>{ acctSync(); }, 60000);
    }
  })().finally(()=>{ acctBusy=null; });
  return acctBusy;
}
// troca de sessão (login, logout, outra conta): time, caches e escopo — o time é trocado JÁ (o cloudLoad do
// login vem logo depois e não pode ler o time da conta anterior)
function acctChanged(prev, next){
  acctReadyUid='';
  acctSwapTeam(prev, next);
  lsSet('sb:lastuid', next||'');
  acctResetCaches();
  invoke('web_log',{ line:'[conta] sessão trocou: '+(prev?prev.slice(0,8):'—')+' → '+(next?next.slice(0,8):'—') }).catch(()=>{});
  acctSync();
}
if(!SF_PANE){
  // TODA troca de sessão passa por SB.setSess (login por senha/código/OAuth, refresh, logout, sessão caída)
  const setSess0=SB.setSess;
  SB.setSess=function(s){ const before=cloudUserId(); setSess0.call(SB, s); const after=cloudUserId(); if(before!==after) acctChanged(before, after); };
  // boot: a conta pode ter mudado com o app fechado (ou é a 1ª vez com o escopo) — compara com a última vista
  { const me=cloudUserId(), last=lsGet('sb:lastuid');
    if(last!==null && last!==(me||'')){ acctSwapTeam(last, me); lsSet('sb:lastuid', me||''); }
    else if(last===null) lsSet('sb:lastuid', me||'');
    // espera os outros módulos (42 define o tmap, 46 a fila dos épicos) antes de aplicar
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', ()=>acctSync()); else setTimeout(()=>acctSync(), 0); }
}
// linha discreta da barra lateral: de quem são os projetos mostrados e quantos de outras contas estão ocultos
function projScopeHtml(){
  const s=SB.sess(); if(!s || !s.user) return '';
  const h=+projScope.hidden||0;
  const tip=h ? 'Projetos de outras contas ficam ocultos, não apagados. Para trazer um pra esta conta, use “abrir existente…” em Projetos.'
              : 'Projetos desta conta e os deste computador (sem dono).';
  return `<div class="rpscope" role="button" tabindex="0" data-scope="1" title="${escA(tip)}">${esc(projScopeText(s.user.email||'', h))}</div>`;
}
