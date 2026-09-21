// Constellation — 41-assinatura-chaves
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
    // enquanto os dados da conta não carregaram, NÃO trave (senão o paywall pisca
    // pra quem tem plano/enterprise) — um sync posterior (pós-cloudLoad) decide.
    if(!cloudData){ payHide(); return; }
    // licença ENTERPRISE da org cobre TODOS os membros — lê direto do cloudData.org
    // (já vem com plan/paid_until via select=*), sem query extra nem corrida.
    const org=cloudData.org;
    const orgOk=!!(org && org.plan==='enterprise' && (!org.paid_until || new Date(org.paid_until)>new Date()));
    if(orgOk){ myBilling={ plan:'enterprise', status:'active', org:true }; payHide(); return; }
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
      <div style="display:flex;align-items:center"><b style="font-size:14px">${titulo}</b><span style="flex:1"></span>${plan==='team'?'<span class="mono" style="font-size:9px;letter-spacing:.08em;color:var(--accent)">PRO TIME</span>':''}</div>
      <div><span style="font-size:23px;font-weight:700">${fmtBRL(p.amount_cents)}</span><span class="dim" style="font-size:12px"> ${per}</span></div>
      <div class="dim" style="font-size:11.5px;flex:1">${desc}</div>
      <div class="mono" style="font-size:10px;color:var(--accent)">✓ ${p.trial_days} dias grátis</div>
      <button class="btn primary" data-pay="${plan}" style="justify-content:center">Começar o teste</button>
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
  if(plan==='team'&&!cloudTeamId()){ alert('Pra assinar o plano Equipes, entre/crie um time primeiro (botão da nuvem).'); return; }
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
  }catch(e){ alert('Não consegui abrir o checkout:\n'+e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Começar o teste'; } }
}
async function payPortal(btn){
  if(btn){ btn.disabled=true; }
  try{
    const r=await fetch(SB.url()+'/functions/v1/stripe-portal',{ method:'POST',
      headers:{ 'apikey':SB.key(), 'Authorization':'Bearer '+SB.sess().access_token } });
    const j=await r.json();
    if(!j.url) throw new Error(j.error||('HTTP '+r.status));
    try{ await invoke('open_url',{ url:j.url }); }catch(_){ window.open(j.url); }
  }catch(e){ alert('Não consegui abrir o portal:\n'+e); }
  finally{ if(btn) btn.disabled=false; }
}
// seção "Assinatura" dentro da Conta (cloudOverlay)
function billingRenderCloud(){
  const body=$id('cloudBody'); if(!body||!SB.sess()||!billingOn) return;
  const el=document.createElement('div');
  const b=myBilling;
  const dt=(s)=> s? new Date(s).toLocaleDateString('pt-BR') : '';
  let linha;
  if(b && ['trialing','active'].includes(b.status)){
    const nome=b.plan==='team'?'Equipes':'Individual';
    const quem=b.user_id===cloudUserId()?'':' (paga por outro membro do time)';
    linha=`<b>${nome}</b> · ${b.interval==='year'?'anual':'mensal'}${quem}`+
      (b.status==='trialing'?` · <span style="color:var(--accent)">teste grátis até ${dt(b.trial_end)}</span>`:` · renova em ${dt(b.current_period_end)}`)+
      (b.cancel_at_period_end?' · <span style="color:var(--warn)">cancela no fim do período</span>':'');
  } else linha='<span style="color:var(--warn)">sem assinatura ativa</span>';
  el.innerHTML=`<div class="seclbl2" style="margin-top:16px">Assinatura</div>
    <div style="display:flex;align-items:center;gap:10px;font-size:12.5px"><span style="flex:1">${linha}</span>
    ${(b&&b.user_id===cloudUserId()&&b.stripe_customer_id)?'<button class="btn sm" id="sbBillPortal">gerenciar</button>':''}
    ${billingActive()?'':'<button class="btn primary sm" id="sbBillGo">assinar</button>'}</div>`;
  body.appendChild(el);
  bindClick('sbBillPortal', ()=>payPortal(x));
  bindClick('sbBillGo', ()=>{ closeCloud(); payShow(); });
}
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
async function secretSet(name, value){
  await sbFetch('/rest/v1/user_secrets?on_conflict=user_id,name',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id:cloudUserId(), name, value }) });
  await secretsSync();
}
async function secretDel(name){
  await sbFetch('/rest/v1/user_secrets?user_id=eq.'+cloudUserId()+'&name=eq.'+encodeURIComponent(name), { method:'DELETE' });
  await secretsSync();
}
// seção na Conta: listar (mascarado), adicionar, remover
function secretsRenderCloud(){
  const body=$id('cloudBody'); if(!body||!SB.sess()) return;
  const el=document.createElement('div');
  const rows=secretsCache||[];
  el.innerHTML=`<div class="seclbl2" style="margin-top:16px">Chaves de modelo <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· seguem a sua conta (ex.: LGCX_API_KEY do LLM da Logcomex)</span></div>
    <div id="sbSecrets">${rows.length?rows.map(r=>`<div style="display:flex;align-items:center;gap:9px;font-size:12px;margin-top:6px"><span class="mono">${esc(r.name)}</span><span class="dim mono" style="font-size:10.5px">••••${esc(String(r.value).slice(-4))}</span><span style="flex:1"></span><button class="btn sm" data-sedit="${escA(r.name)}" style="padding:2px 8px;font-size:10.5px">editar</button><button class="btn sm" data-sdel="${escA(r.name)}" style="padding:2px 8px;font-size:10.5px">✕</button></div>`).join(''):'<div class="dim" style="font-size:11.5px;margin-top:4px">nenhuma chave ainda</div>'}</div>
    <button class="btn sm" id="sbSecretAdd" style="margin-top:8px">+ adicionar chave</button>`;
  body.appendChild(el);
  el.querySelectorAll('[data-sedit]').forEach(b=>b.onclick=async()=>{
    const v=await askText('Novo valor de '+b.dataset.sedit,'cole a chave'); if(v===null||!v.trim()) return;
    await secretSet(b.dataset.sedit, v.trim()); renderCloud();
  });
  el.querySelectorAll('[data-sdel]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Remover '+b.dataset.sdel+' da sua conta (e desta máquina)?')) return;
    await secretDel(b.dataset.sdel); renderCloud();
  });
  { const b=el.querySelector('#sbSecretAdd'); if(b) b.onclick=async()=>{
      const n=await askText('Nome da variável','LGCX_API_KEY'); if(n===null) return;
      const name=String(n).trim().toUpperCase().replace(/[^A-Z0-9_]/g,'_');
      if(!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)){ alert('Nome inválido — use MAIÚSCULAS_E_UNDERSCORE.'); return; }
      const v=await askText('Valor de '+name,'cole a chave'); if(v===null||!v.trim()) return;
      await secretSet(name, v.trim()); renderCloud();
    }; }
}
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
  return `<div class="seclbl2" style="margin-top:22px">Gateway próprio <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· qualquer endpoint OpenAI-compatível da sua empresa (vLLM, LiteLLM, Azure, Ollama…)</span></div>
    <div class="dim" style="margin-top:5px;line-height:1.5">Aparece como motor em "Com qual IA?" na hora de abrir a demanda e serve de <b>Route AI</b>: o agente continua sendo o <b>Claude Code</b> (todo o MCP do Constellation) — só o modelo por trás muda pro seu gateway. Config <b>individual</b> da sua conta.</div>
    ${!logged?`<div class="rawarn" style="margin-top:10px">Entre na conta (botão da nuvem, no topo) pra configurar — a chave fica no seu cofre pessoal.</div>`:`
    <div id="raPanel" style="margin-top:12px;border:1px solid var(--border);border-radius:var(--r-sm);padding:13px 14px;background:var(--surface-2)">
      <label style="margin:0">Chave do gateway <span class="dim" style="text-transform:none;letter-spacing:0">(fica só no seu cofre)</span></label>
      ${hasKey
        ? `<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span style="color:var(--ok,#3fb950)">✓ configurada</span><span class="dim mono" style="font-size:11px">••••${esc(key.slice(-4))}</span><span style="flex:1"></span><button class="btn sm" id="raKeyEdit">trocar</button></div>`
        : `<div style="display:flex;gap:8px;margin-top:6px"><input class="in mono" id="raKey" type="password" placeholder="cole a chave do gateway" style="flex:1"><button class="btn sm" id="raKeySave">salvar</button></div>`}
      <label style="margin-top:14px">Modelo</label>
      <select class="sel" id="raModel" style="width:100%;margin-top:6px"${hasKey?'':' disabled'}>${RA_MODELS.map(m=>`<option value="${escA(m[0])}"${m[0]===model?' selected':''}>${esc(m[1])}</option>`).join('')}${known?'':`<option value="${escA(model)}" selected>${esc(model)} (custom)</option>`}</select>
      <label style="margin-top:14px">Endpoint <span class="dim" style="text-transform:none;letter-spacing:0">(OpenAI-compatible)</span></label>
      <input class="in mono" id="raBase" value="${escA(baseUrl)}" placeholder="https://.../v1" style="margin-top:6px;font-size:12px"${hasKey?'':' disabled'}>
      <div class="two" style="margin-top:14px">
        <div><label style="margin:0">Nome do gateway <span class="dim" style="text-transform:none;letter-spacing:0">(como aparece no app)</span></label><input class="in" id="raLabel" value="${escA(label)}" placeholder="ex.: Logcomex AI, LLM interno…" style="margin-top:6px"${hasKey?'':' disabled'}></div>
        <div><label style="margin:0">Modelos disponíveis <span class="dim" style="text-transform:none;letter-spacing:0">(ids, separados por vírgula)</span></label><input class="in mono" id="raModels" value="${escA(models)}" placeholder="ex.: logcomex-v2, qwen3.8-27b" style="margin-top:6px;font-size:12px"${hasKey?'':' disabled'}></div>
      </div>
      <div class="raopt${hasKey?'':' off'}" style="margin-top:14px">
        <div class="rin"><b>Fallback automático</b><div class="dim" style="margin-top:2px">Claude bateu limite → roteia pra cá e <b>continua na hora</b>.</div></div>
        ${sw('raFallback',fallback,!hasKey)}
      </div>
      <div class="raopt${hasKey?'':' off'}">
        <div class="rin"><b>Usar sempre <span class="dim" style="font-weight:400">(modo teste)</span></b><div class="dim" style="margin-top:2px">Todas as tarefas novas rodam na alternativa. Desligue pra voltar ao Claude.</div></div>
        ${sw('raAlways',always,!hasKey)}
      </div>
      ${always?'<div class="rawarn" style="margin-top:10px;border-color:var(--warn,#9e6a03);color:var(--warn,#d29922)">⚠ Modo teste ligado — tudo está rodando na alternativa, não no Claude.</div>':''}
      <div style="display:flex;gap:9px;align-items:center;margin-top:13px">
        <button class="btn sm" id="raTest"${hasKey?'':' disabled'}>testar conexão</button>
        <span class="dim" id="raTestMsg" style="font-size:11.5px"></span>
      </div>
    </div>`}`;
}
// ponto de entrada chamado pelo openCfg (bloco 0) — preenche #raHost e liga tudo
window.routeAiMount=function(){
  const h=$id('raHost'); if(!h) return;
  h.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(h);
  // se as chaves ainda não sincronizaram, puxa e re-renderiza só este bloco
  if(SB.sess() && secretsCache===null){ secretsSync().then(()=>{ const h2=$id('raHost'); if(h2){ h2.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(h2); } }).catch(()=>{}); }
};
function wireRouteAiCfg(root){
  if(!SB.sess()) return;
  const $=id=>root.querySelector('#'+id);
  const save=(k,v)=>secretSet(k,v);
  const rerender=()=>{ const host=$('raHost'); if(host){ host.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(host); } };
  { const b=$('raKeySave'); if(b) b.onclick=async()=>{ const v=($('raKey')||{}).value||''; if(!v.trim()) return; await save('ALT_AI_KEY',v.trim()); rerender(); }; }
  { const b=$('raKeyEdit'); if(b) b.onclick=async()=>{ await secretDel('ALT_AI_KEY'); rerender(); }; }
  { const b=$('raModel'); if(b) b.onchange=e=>save('ALT_AI_MODEL',e.target.value); }
  { const b=$('raBase'); if(b) b.onchange=e=>save('ALT_AI_BASE_URL',e.target.value.trim()); }
  { const b=$('raLabel'); if(b) b.onchange=e=>save('ALT_AI_LABEL',e.target.value.trim()); }
  { const b=$('raModels'); if(b) b.onchange=e=>save('ALT_AI_MODELS',e.target.value.split(',').map(s=>s.trim()).filter(Boolean).join(',')); }
  { const b=$('raFallback'); if(b) b.onchange=e=>save('ALT_AI_FALLBACK',e.target.checked?'1':'0').then(rerender); }
  { const b=$('raAlways'); if(b) b.onchange=e=>save('ALT_AI_ALWAYS',e.target.checked?'1':'0').then(rerender); }
  { const tb=$('raTest'); if(tb) tb.onclick=async()=>{
      const msg=$('raTestMsg'); msg.style.color='var(--muted)'; msg.textContent='testando…'; tb.disabled=true;
      try{ const r=await invoke('route_ai_ping'); msg.textContent='✓ '+r; msg.style.color='var(--ok,#3fb950)'; }
      catch(e){ msg.textContent='✕ '+String(e); msg.style.color='var(--err,#f85149)'; }
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
    const info=await invoke('repo_docs').catch(()=>null);
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
$id('cloudBtn').onclick=openCloud;
$id('cloudClose').onclick=closeCloud;
$id('cloudOverlay').addEventListener('click',e=>{ if(e.target.id==='cloudOverlay') closeCloud(); });
// boot: sincroniza o rótulo do botão (e renova o token se já havia sessão)
if(SB.configured() && SB.sess()){ sbRefresh().then(()=>cloudLoad()).then(cloudBtnSync).catch(()=>cloudBtnSync()); } else cloudBtnSync();
