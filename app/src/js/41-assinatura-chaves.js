// Starfork — 41-assinatura-chaves
// ========== Assinatura (Stripe) ==========
// billing_plans vazio = cobrança desligada (app livre). Semeou os planos
// (BILLING-SETUP.md) → o gate liga sozinho no próximo sync. Nuvem sem clique.
let billingPlans=[], myBilling=null, billingOn=false, payYear=false, payPollT=null;
function fmtBRL(c){ return 'R$ '+(c/100).toFixed(2).replace('.',','); }
function billingActive(){ return !billingOn || (myBilling && (myBilling.org || ['trialing','active'].includes(myBilling.status))); }
async function billingSync(){
  if(!SB.sess()){ billingOn=false; payHide(); return; }
  try{
    billingPlans=await sbGet('billing_plans?select=*&active=eq.true');
    billingOn=billingPlans.length>0;
    if(!billingOn){ payHide(); return; }
    // licença ENTERPRISE da org cobre TODOS os membros. Pergunta ao banco DIRETO (a RLS devolve só as
    // orgs de que sou membro) em vez de depender do cloudData: antes, com a conta ainda carregando (ou
    // falhando), o sync saía sem decidir, myBilling ficava vazio e o login mandava o membro enterprise
    // pra tela de planos (24/09: Arllon, da Logcomex, preso na cobrança).
    let orgs=(cloudData&&cloudData.org)?[cloudData.org]:null;
    if(!orgs){ try{ orgs=await sbGet('orgs?select=plan,paid_until'); }catch(_){ payHide(); return; } }
    // paid_until só é gravado pelo ADMIN (liberação manual): validade futura libera em QUALQUER plano da org.
    // Antes só 'enterprise' contava — o Beto (org 'team', liberada até 01/11 pelo admin) caía na tela de planos (30/09).
    const now=new Date();
    const grant=(orgs||[]).find(o=>o && ((o.paid_until && new Date(o.paid_until)>now) || (o.plan==='enterprise' && !o.paid_until)));
    if(grant){ myBilling={ plan:grant.plan||'enterprise', status:'active', org:true }; payHide(); return; }
    const rows=await sbGet('billing?select=*');
    const mine=rows.find(r=>r.user_id===cloudUserId());
    const team=rows.find(r=>r.plan==='team' && ['trialing','active'].includes(r.status) && r.team_id===cloudTeamId());
    myBilling=(mine && ['trialing','active'].includes(mine.status)) ? mine : (team || mine || null);
    if(billingActive()){ payHide(); } else payShow();
  }catch(_){ /* erro de rede NUNCA tranca o app */ payHide(); }
}
function payHide(){ const o=$id('payOverlay'); if(o) o.style.display='none'; if(payPollT){ clearInterval(payPollT); payPollT=null; } }
function payShow(){
  const o=$id('payOverlay'); if(!o) return;
  o.style.display='flex';
  const iv=payYear?'year':'month';
  const card=(plan,titulo,desc)=>{
    const p=billingPlans.find(x=>x.plan===plan&&x.interval===iv); if(!p) return '';
    const per=iv==='year'?'/ano':'/mês';
    return `<div style="border:1px solid var(--border);border-radius:14px;padding:18px 18px 16px;display:flex;flex-direction:column;gap:8px${plan==='team'?';border-color:var(--accent)':''}">
      <div style="display:flex;align-items:center"><b style="font-size:var(--fs-md)">${titulo}</b><span style="flex:1"></span>${plan==='team'?'<span class="mono" style="font-size:var(--fs-xs);letter-spacing:.08em;color:var(--accent)">PRO TIME</span>':''}</div>
      <div><span style="font-size:23px;font-weight:700">${fmtBRL(p.amount_cents)}</span><span class="dim" style="font-size:var(--fs-sm)"> ${per}</span></div>
      <div class="dim" style="font-size:var(--fs-xs);flex:1">${desc}</div>
      <span class="au-trialchip" style="align-self:flex-start">${p.trial_days>0?p.trial_days:7} dias grátis</span>
      <div class="dim" style="font-size:var(--fs-xs)">Cadastre o cartão e nada é cobrado hoje. Cancelou antes do fim do teste, não paga nada.</div>
      <button class="btn primary" data-pay="${plan}" style="justify-content:center">Começar ${p.trial_days>0?p.trial_days:7} dias grátis</button>
    </div>`;
  };
  $id('payCards').innerHTML=
    card('individual','Individual','Agentes ilimitados, seus repos, memória e catálogo amarrados à sua conta — em qualquer Mac.')+
    card('team','Equipes','Tudo do Individual + board do time, releases pro time e catálogo compartilhado. Até 6 membros.');
  $id('payCards').querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>payCheckout(b.dataset.pay,b));
  $id('payMon').classList.toggle('on',!payYear);
  $id('payYr').classList.toggle('on',payYear);
}
$id('payMon').onclick=()=>{ payYear=false; payShow(); };
$id('payYr').onclick=()=>{ payYear=true; payShow(); };
$id('payRefresh').onclick=()=>billingSync();
$id('payLogout').onclick=()=>{ SB.setSess(null); cloudData=null; cloudBtnSync(); payHide(); };
async function payCheckout(plan,btn){
  const iv=payYear?'year':'month';
  const p=billingPlans.find(x=>x.plan===plan&&x.interval===iv); if(!p) return;
  if(plan==='team'&&!cloudTeamId()){ toast('Pra assinar o plano Time, entre ou crie um time primeiro (Ajustes › Times e pessoas).','warn'); return; }
  const btnTx=btn?btn.textContent:''; // volta o rótulo que o botão tinha ("Começar N dias grátis")
  if(btn){ btn.disabled=true; btn.textContent='abrindo…'; }
  try{
    const r=await fetch(SB.url()+'/functions/v1/stripe-checkout',{ method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SB.key(), 'Authorization':'Bearer '+SB.sess().access_token },
      body: JSON.stringify({ planId:p.id, teamId: plan==='team'?cloudTeamId():null }) });
    const j=await r.json();
    if(!j.url) throw new Error(j.error||('HTTP '+r.status));
    try{ await invoke('open_url',{ url:j.url }); }catch(_){ window.open(j.url); }
    $id('payWait').style.display='flex';
    if(payPollT) clearInterval(payPollT);
    payPollT=setInterval(billingSync, 5000);
    setTimeout(()=>{ if(payPollT){ clearInterval(payPollT); payPollT=null; } }, 10*60*1000);
  }catch(e){ showErr(e, 'Não consegui abrir o checkout'); }
  finally{ if(btn){ btn.disabled=false; btn.textContent=btnTx; } }
}
async function payPortal(btn){
  if(btn){ btn.disabled=true; }
  try{
    const r=await fetch(SB.url()+'/functions/v1/stripe-portal',{ method:'POST',
      headers:{ 'apikey':SB.key(), 'Authorization':'Bearer '+SB.sess().access_token } });
    const j=await r.json();
    if(!j.url) throw new Error(j.error||('HTTP '+r.status));
    try{ await invoke('open_url',{ url:j.url }); }catch(_){ window.open(j.url); }
  }catch(e){ showErr(e, 'Não consegui abrir o portal'); }
  finally{ if(btn) btn.disabled=false; }
}
// a seção "Assinatura" mora em Ajustes › Assinatura e plano (67-ajustes: ajRenderAssinatura, com ajBillingLine) — F4 · G3.
// Bugs corrigidos lá: "gerenciar" chamava o portal com uma variável inexistente (ReferenceError) e org enterprise sem paid_until
// aparecia como "Individual · mensal … renova em " vazio.
// ========== chaves de modelo VINCULADAS À CONTA (user_secrets → llm.env) ==========
let secretsCache=null;
async function secretsSync(){
  if(!SB.sess()) return;
  try{
    let rows=await sbGet('user_secrets?select=name,value&order=name');
    if(!rows.length){
      // primeira vez: adota o llm.env local existente (migração sem clique)
      const local=await invoke('read_llm_env').catch(()=>'');
      const pairs=String(local||'').split('\n').map(l=>l.trim()).filter(l=>/^[A-Z][A-Z0-9_]{2,63}=/.test(l));
      for(const l of pairs){ const i=l.indexOf('=');
        await sbFetch('/rest/v1/user_secrets?on_conflict=user_id,name',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id:cloudUserId(), name:l.slice(0,i), value:l.slice(i+1) }) });
      }
      if(pairs.length) rows=await sbGet('user_secrets?select=name,value&order=name');
    }
    secretsCache=rows;
    // nuvem → arquivo local (600) que os motores leem
    await invoke('write_llm_env',{ content: rows.map(r=>r.name+'='+r.value).join('\n')+(rows.length?'\n':'') });
  }catch(_){ }
}
// chave nova/removida (ex.: DEEPSEEK_API_KEY) vale JÁ no seletor/Ambiente: zera o cache de 30s da disponibilidade
// (o Rust também esquece as prontas/saldo do medidor do plano — e o medidor relê na hora)
function secretsAvailRefresh(){ if(typeof suaIaAt!=='undefined') suaIaAt=0; /* painel Sua IA relê na próxima vez */ try{ return Promise.resolve(invoke('ai_avail_refresh')).catch(()=>{}).then(()=>{ if(typeof planMeterReset==='function') planMeterReset(); }); }catch(_){ return Promise.resolve(); } }
async function secretSet(name, value){
  await sbFetch('/rest/v1/user_secrets?on_conflict=user_id,name',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id:cloudUserId(), name, value }) });
  await secretsSync();
  await secretsAvailRefresh();
}
async function secretDel(name){
  await sbFetch('/rest/v1/user_secrets?user_id=eq.'+cloudUserId()+'&name=eq.'+encodeURIComponent(name), { method:'DELETE' });
  await secretsSync();
  await secretsAvailRefresh();
}
// "Chaves de modelo" saiu da Conta: as chaves vivem SÓ em Ajustes › IA e modelos (cartões dos motores + "Outras chaves
// da conta", 67-ajustes). O cofre continua o mesmo (user_secrets → llm.env) — nada muda pra quem já tinha chave salva.
// seção na Conta: ROUTE AI — IA alternativa pro Claude Code (fallback / teste)
// ROUTE AI — painel dentro das CONFIGURAÇÕES (pessoal/local), ao lado do
// "retomar após limite". Config individual (user_secrets), não é do time.
const RA_MODELS=[['logcomex-v2','DeepSeek V4 Flash · 1M contexto'],['qwen3.8-27b','Qwen 3.8 27B · 3× mais rápido']];
function raGet(n){ const r=(secretsCache||[]).find(x=>x.name===n); return r?String(r.value):''; }
function routeAiCfgHtml(){
  const logged=!!SB.sess();
  const key=raGet('ALT_AI_KEY')||raGet('LGCX_API_KEY'); const hasKey=!!key;
  const always=raGet('ALT_AI_ALWAYS')==='1', fallback=raGet('ALT_AI_FALLBACK')==='1';
  const baseUrl=raGet('ALT_AI_BASE_URL')||'https://llm.logcomex.ai/v1';
  const model=raGet('ALT_AI_MODEL')||'logcomex-v2';
  const known=RA_MODELS.some(m=>m[0]===model);
  const sw=(id,on,dis)=>`<label class="sw"><input type="checkbox" id="${id}"${on?' checked':''}${dis?' disabled':''}><span class="tr"><span class="kn"></span></span></label>`;
  const label=raGet('ALT_AI_LABEL')||'', models=raGet('ALT_AI_MODELS')||'';
  const warnIc=(typeof IC!=='undefined'&&IC.warn)||'';
  if(!logged) return `<div class="rawarn">Entre na sua conta pra configurar — a chave fica no cofre da conta e vale em qualquer computador. <button type="button" class="btn sm" id="raSignIn">entrar</button></div>`;
  return `<div id="raPanel" class="rapanel">
      <div class="rarow"><span class="ralbl">Chave</span>${hasKey
        ? `<span class="raok">✓ configurada</span><span class="dim mono">••••${esc(key.slice(-4))}</span><span style="flex:1"></span><button class="btn sm" id="raKeyEdit">trocar</button><button class="btn sm" id="raKeyDel">remover</button>`
        : `<input class="in mono" id="raKey" type="password" placeholder="cole a chave do gateway" style="flex:1" aria-label="chave do gateway"><button class="btn sm" id="raKeySave">salvar</button>`}</div>
      <p class="dim rakept">salva na sua conta, vale em qualquer computador</p>
      <div class="rarow"><label class="ralbl" for="raBase">Endereço</label><input class="in mono" id="raBase" value="${escA(baseUrl)}" placeholder="https://.../v1"${hasKey?'':' disabled'}></div>
      <div class="rarow"><label class="ralbl" for="raLabel">Nome no app</label><input class="in" id="raLabel" value="${escA(label)}" placeholder="ex.: IA da empresa"${hasKey?'':' disabled'}></div>
      <div class="rarow"><label class="ralbl" for="raModel">Modelo</label><select class="sel" id="raModel"${hasKey?'':' disabled'}>${RA_MODELS.map(m=>`<option value="${escA(m[0])}"${m[0]===model?' selected':''}>${esc(m[1])}</option>`).join('')}${known?'':`<option value="${escA(model)}" selected>${esc(model)} (outro modelo)</option>`}</select></div>
      <div class="rarow"><label class="ralbl" for="raModels">Modelos disponíveis</label><input class="in mono" id="raModels" value="${escA(models)}" placeholder="nomes separados por vírgula"${hasKey?'':' disabled'}></div>
      <div class="raopt${hasKey?'':' off'}"><div class="rin"><b>Se o Claude bater o limite</b><div class="dim">continuar por aqui na hora</div></div>${sw('raFallback',fallback,!hasKey)}</div>
      <div class="raopt${hasKey?'':' off'}"><div class="rin"><b>Usar sempre</b><div class="dim">todas as tarefas novas rodam aqui (modo teste)</div></div>${sw('raAlways',always,!hasKey)}</div>
      ${always?`<div class="rawarn warn" role="status">${warnIc} Modo teste ligado: todas as tarefas novas vão pro gateway, inclusive as que você esperava no Claude.</div>`:''}
      <div class="rarow"><button class="btn sm" id="raTest"${hasKey?'':' disabled'}>testar conexão</button><span class="dim" id="raTestMsg"></span></div>
    </div>`;
}
// ponto de entrada chamado pelo openCfg (bloco 0) — preenche #raHost e liga tudo
window.routeAiMount=function(){
  const h=$id('raHost'); if(!h) return;
  h.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(h);
  // se as chaves ainda não sincronizaram, puxa e re-renderiza só este bloco
  if(SB.sess() && secretsCache===null){ secretsSync().then(()=>{ const h2=$id('raHost'); if(h2){ h2.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(h2); } }).catch(()=>{}); }
};
function wireRouteAiCfg(root){
  { const si=root.querySelector('#raSignIn'); if(si) si.onclick=()=>{ if(typeof auShow==='function') auShow(lsGet('sb:email')?'login':'signup'); }; }
  if(!SB.sess()) return;
  const $=id=>root.querySelector('#'+id);
  // gravou/removeu → o painel Sua IA relê o estado (o cartão do gateway sai de "falta configurar")
  const relSuaIa=r=>{ if(typeof suaIaLoad==='function') suaIaLoad(true).catch(()=>{}); return r; };
  const save=(k,v)=>secretSet(k,v).then(relSuaIa);
  // redesenha o PRÓPRIO container (antes procurava #raHost dentro dele mesmo e não achava: a tela ficava velha)
  const rerender=()=>{ root.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(root); };
  { const b=$('raKeySave'); if(b) b.onclick=async()=>{ const v=($('raKey')||{}).value||''; if(!v.trim()) return; await save('ALT_AI_KEY',v.trim()); rerender(); }; }
  // "trocar" NUNCA apaga antes (bug do inventário): a chave atual vale até a nova ser salva; "remover" pergunta à parte
  { const b=$('raKeyEdit'); if(b) b.onclick=async()=>{ const cur=raGet('ALT_AI_KEY')||raGet('LGCX_API_KEY');
      const v=(typeof sheetAsk==='function')?await sheetAsk({ anchor:b, title:'Trocar a chave do gateway', text:'A chave atual (••••'+String(cur).slice(-4)+') continua valendo até você salvar a nova. Nada é apagado antes.', field:{ type:'password', placeholder:'cole a chave nova' }, ok:'salvar nova chave' }):await askText('Trocar a chave do gateway','cole a chave nova');
      if(!v) return; await save('ALT_AI_KEY', String(v).trim()); rerender(); }; }
  { const b=$('raKeyDel'); if(b) b.onclick=async()=>{
      const ok=(typeof sheetAsk==='function')?await sheetAsk({ anchor:b, title:'Remover a chave do gateway?', text:'As tarefas que usam a IA da sua empresa param até você pôr outra chave. A chave sai da sua conta em todos os computadores.', ok:'remover chave', danger:true }):await askYes('Remover a chave do gateway?');
      if(!ok) return; await secretDel('ALT_AI_KEY'); relSuaIa(); rerender(); }; }
  { const b=$('raModel'); if(b) b.onchange=e=>save('ALT_AI_MODEL',e.target.value); }
  { const b=$('raBase'); if(b) b.onchange=e=>save('ALT_AI_BASE_URL',e.target.value.trim()); }
  { const b=$('raLabel'); if(b) b.onchange=e=>save('ALT_AI_LABEL',e.target.value.trim()); }
  { const b=$('raModels'); if(b) b.onchange=e=>save('ALT_AI_MODELS',e.target.value.split(',').map(s=>s.trim()).filter(Boolean).join(',')); }
  { const b=$('raFallback'); if(b) b.onchange=e=>save('ALT_AI_FALLBACK',e.target.checked?'1':'0').then(rerender); }
  { const b=$('raAlways'); if(b) b.onchange=e=>save('ALT_AI_ALWAYS',e.target.checked?'1':'0').then(rerender); }
  { const tb=$('raTest'); if(tb) tb.onclick=async()=>{
      const msg=$('raTestMsg'); msg.style.color='var(--muted)'; msg.textContent='testando…'; tb.disabled=true;
      try{ const r=await invoke('route_ai_ping'); msg.textContent='✓ '+r; msg.style.color='var(--ok)'; }
      catch(e){ const h=humanErr(e,'O teste falhou'); msg.textContent='✕ '+h.msg; msg.title=h.raw||''; msg.style.color='var(--crit)'; }
      tb.disabled=false;
    }; }
}
setTimeout(secretsSync, 6000);
setInterval(secretsSync, 30*60*1000);
// ========== dados do usuário: repo + memória (.cardume) seguem a conta ==========
let repoSyncBusy=false;
async function userRepoSync(){
  if(!SB.sess()||repoSyncBusy) return; repoSyncBusy=true;
  try{
    const info=state.repo?await invoke('repo_docs').catch(()=>null):null; // sem projeto aberto: nada a sincronizar (antes: erro 'repo não definido' no painel a cada 10min)
    if(!info||!info.repo) return;
    await sbFetch('/rest/v1/user_repos?on_conflict=user_id,repo',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id:cloudUserId(), repo:info.repo, path:info.path, last_opened:new Date().toISOString() }) });
    const cloud=await sbGet('user_repo_docs?select=doc,content,updated_at&repo=eq.'+encodeURIComponent(info.repo));
    const byDoc=Object.fromEntries(cloud.map(r=>[r.doc,r]));
    for(const [doc,loc] of Object.entries(info.docs||{})){
      const c=byDoc[doc]; const cMs=c?Date.parse(c.updated_at):0;
      if(!c || loc.mtimeMs>cMs+2000)
        await sbFetch('/rest/v1/user_repo_docs?on_conflict=user_id,repo,doc',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id:cloudUserId(), repo:info.repo, doc, content:loc.content, updated_at:new Date(loc.mtimeMs).toISOString() }) });
    }
    for(const c of cloud){
      const loc=(info.docs||{})[c.doc];
      if(!loc || Date.parse(c.updated_at)>loc.mtimeMs+2000)
        await invoke('repo_doc_write',{ doc:c.doc, content:c.content }).catch(()=>{});
    }
  }catch(_){ }
  finally{ repoSyncBusy=false; }
  // preferências do TIME (project_prefs) → .cardume/PREFS.md local, pra os agentes
  try{ await prefsPull(); }catch(_){ }
  // config de issue do TIME (project_issue_config) → .cardume/issue.json local
  try{ await issueConfigPull(); }catch(_){ }
}
setTimeout(billingSync, 4000);
setInterval(billingSync, 30*60*1000);
setTimeout(userRepoSync, 15000);
setInterval(userRepoSync, 10*60*1000);
bindClick('cloudBtn', ()=>{ if(typeof ajustesOpen==='function') ajustesOpen('perfil'); else openCloud(); });
bindClick('cloudClose', closeCloud);
// boot: sincroniza o rótulo do botão (e renova o token se já havia sessão)
if(SB.configured() && SB.sess()){ sbRefresh().then(()=>cloudLoad()).then(cloudBtnSync).catch(()=>cloudBtnSync()); } else cloudBtnSync();
