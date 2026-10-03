// Starfork — 48-presenca-mobile
/* ============================================================================
   COMPANION NÍVEL ORCA (lado do Mac) — o que o celular precisa deste computador:
   - PRESENÇA: batimento em desktop_presence a cada 45s (sem o ritmo lento de janela escondida — o Mac
     minimizado continua "online" pro celular), com o projeto ABERTO e os projetos clonados aqui. O celular
     diz a verdade: "Mac online · loja-web aberto", "Mac offline · visto há 12min", "abra o projeto X no Mac".
     Nuvem sem a migration 0030: desliga por 30 min e o celular usa profiles.last_seen_at (já existia).
   - Regras PURAS das intenções/mensagens que chegam do celular (o laço está no 42-nuvem-sync-mobile):
     portão de prova no "aprovar" (PR #100) e mensagem segurada enquanto o teto de custo está aberto.
   Testado em app/tests/mobile-orca.test.mjs (recorta os marcadores, sem browser).
   ========================================================================= */
// @presenca-inicio
// nome legível do computador (o celular mostra "MacBook… online"); sem hostname no front, vai o tipo
function presenceDeviceName(os){ return os==='mac'?'Mac':os==='win'?'PC Windows':os==='linux'?'PC Linux':'computador'; }
// id estável DESTE computador (várias máquinas da mesma conta = várias linhas)
function presenceDeviceId(get, set){
  let id=get('sb:deviceId');
  if(!id || !/^d-[a-z0-9]{6,40}$/.test(id)){ id='d-'+Math.random().toString(36).slice(2,10)+Date.now().toString(36); set('sb:deviceId', id); }
  return id;
}
// linha do batimento — `open` = ids {remote,legacy} do projeto aberto; `locals` = lista de ids dos projetos clonados
function presenceRow(o){
  const open=o.open||{}, seen=new Set(), locals=[];
  for(const x of [open, ...(o.locals||[])]){ for(const r of [x&&x.remote, x&&x.legacy]){ const v=String(r||'').trim(); if(v && !seen.has(v) && locals.length<60){ seen.add(v); locals.push(v); } } }
  const rem=String(open.remote||'').trim();
  return { user_id:o.userId, device_id:o.deviceId, device_name:String(o.deviceName||'computador').slice(0,80), os:o.os||null,
    app_build_ms:Number(o.buildMs)||null, open_remote:rem||null, open_legacy:String(open.legacy||'').trim()||rem||null,
    open_project:rem?rem.replace(/\.git$/,'').split('/').filter(Boolean).pop()||null:null,
    local_remotes:locals, running:Math.max(0, Math.min(999, Number(o.running)||0)), online:o.online!==false,
    last_seen_at:new Date(o.now||Date.now()).toISOString() };
}
// nuvem sem a tabela (0030 pendente): PostgREST responde 404/PGRST205 "schema cache" ou 42P01
function presenceMissingTable(e){ return /42P01|PGRST205|does not exist|schema cache|erro 404/i.test(String((e&&e.message)||e||'')); }
// @presenca-fim

// @ponte-mobile-inicio
// "aprovar e abrir PR" vindo do celular passa pelo MESMO portão de prova do desktop (21: proofGate):
// requisito sem prova só passa com MOTIVO (vai no PR e no registro de override). Devolve a decisão.
function mobileApproveDecide(gate, reason){
  const st=gate&&gate.st, miss=(gate&&gate.missing)||[];
  if(st==='loading') return { ok:false, msg:'ainda lendo as provas no Mac — tente de novo em alguns segundos' };
  if(st!=='unproven') return { ok:true, override:false };
  const why=String(reason||'').trim();
  if(why.length<4) return { ok:false, msg:miss.length+' requisito'+(miss.length===1?'':'s')+' sem prova — peça a prova ao agente ou aprove sem prova com um motivo' };
  return { ok:true, override:true, reason:why.slice(0,500) };
}
// mensagem do celular → o que fazer com ela. Teto de custo aberto: SEGURA (qualquer texto ao agente retomaria o
// gasto pelo caminho "nova mensagem" do 53-teto — o celular tem que responder o teto primeiro, igual ao Mac).
function mobileMsgPlan(body, ctx){
  const b=String(body||'');
  if(ctx && ctx.budgetOpen) return { kind:'hold', why:'teto' };
  const img=b.match(/^\[img\]\s*(\S+)(?:\s*\|\s*([\s\S]*))?$/);
  if(img) return { kind:'img', path:img[1], caption:(img[2]||'').trim() };
  const asReq=/^\[req\]\s*/i.test(b);
  const text=b.replace(/^\[req\]\s*/i,'').trim();
  if(!text) return { kind:'drop' };
  return { kind:'talk', text, asReq };
}
// entrega falhou: tenta de novo até 3x (devolve a mensagem pra fila); depois avisa no feed e desiste
function mobileMsgRetry(fails){ return (Number(fails)||0)<3 ? 'retry' : 'give-up'; }
// @ponte-mobile-fim

// ---- batimento ----
let presOffUntil=0, presBusy=false, presLast='';
async function presencePing(online){
  if(typeof SB==='undefined' || !SB.sess() || (typeof cloudScopeOk==='function' && !cloudScopeOk())) return;
  if(Date.now()<presOffUntil || presBusy) return;
  presBusy=true;
  try{
    const os=(typeof osKind==='function')?osKind():'';
    const [open, locals, ms]=await Promise.all([
      repoRemoteIds().catch(()=>({ remote:'', legacy:'' })),
      (typeof localRemoteIdsList==='function'?localRemoteIdsList():Promise.resolve([])).catch(()=>[]),
      invoke('build_info').catch(()=>0),
    ]);
    const running=((state&&state.tasks)||[]).filter(t=>ACTIVE_ST.has(t.status)||t.status==='thinking').length;
    const row=presenceRow({ userId:cloudUserId(), deviceId:presenceDeviceId(lsGet, lsSet), deviceName:presenceDeviceName(os), os, buildMs:ms, open, locals, running, online, now:Date.now() });
    await sbFetch('/rest/v1/desktop_presence?on_conflict=user_id,device_id', { method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=minimal' }, body:JSON.stringify(row) });
    const sig=row.open_remote+'|'+row.running;
    if(sig!==presLast){ presLast=sig; invoke('web_log',{ line:'[presença] '+(row.open_project||'sem projeto')+' · '+running+' rodando' }).catch(()=>{}); }
  }catch(e){
    if(presenceMissingTable(e)){ presOffUntil=Date.now()+30*60000; invoke('web_log',{ line:'[presença] nuvem sem desktop_presence (migration 0030) — o celular usa o last_seen do perfil' }).catch(()=>{}); }
  }finally{ presBusy=false; }
}
setTimeout(()=>presencePing(true), 5000);
setInterval(()=>presencePing(true), 45000);
// voltou a aparecer / rede voltou: bate já (o celular sai do "offline" sem esperar 45s)
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) presencePing(true); });
window.addEventListener('online', ()=>presencePing(true));
// fechando o app: avisa "offline" na hora (melhor esforço — keepalive sobrevive ao unload)
window.addEventListener('beforeunload', ()=>{
  try{
    const s=SB.sess(); if(!s || Date.now()<presOffUntil) return;
    fetch(SB.url()+'/rest/v1/desktop_presence?user_id=eq.'+cloudUserId()+'&device_id=eq.'+encodeURIComponent(presenceDeviceId(lsGet, lsSet)), {
      method:'PATCH', keepalive:true, headers:{ 'apikey':SB.key(), 'Authorization':'Bearer '+s.access_token, 'Content-Type':'application/json' },
      body:JSON.stringify({ online:false, last_seen_at:new Date().toISOString() }) }).catch(()=>{});
  }catch(_){ }
});
