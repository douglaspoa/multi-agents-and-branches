// Starfork — 49-epico-pedidos: o agente (ou a pessoa no terminal) CRIA épico e VINCULA/DESVINCULA tarefas que já
// existem — CLI `cardume epic new|link|unlink`, `starfork epico …`, tools MCP create_epic / link_tasks_to_epic /
// unlink_tasks_from_epic (src/epic-requests.ts). O motor não tem sessão: grava o PEDIDO em .cardume/epic-requests/ e
// este arquivo executa com a sessão do app, nas MESMAS regras da UI (criar épico e trocar o épico de um cartão =
// membro do time logado; a RLS da nuvem decide), e escreve o RESULTADO que o CLI/MCP está esperando:
//  - sem login / sem time → RECUSA com a frase do que fazer (nunca finge que criou);
//  - criar: épico na nuvem (idempotente pelo id do pedido em spec.requestId) com o "pronto quando" D1..Dn;
//  - vincular: epic_id do cartão (cartão que ainda não existe — ex.: rascunho — é publicado já no épico), contexto
//    do épico pro motor e o epicId da spec LOCAL pelo CLI (`epic apply-link`) — a tarefa NÃO é recriada nem reiniciada;
//  - mantém .cardume/epic-requests/epics.json (épicos do time) pro `cardume epic list`.
const ER_NO_LOGIN='o Starfork não está logado na nuvem — o épico é do TIME. Entre na sua conta (botão Conta, no rodapé da barra lateral), escolha um time e peça de novo. Nada foi criado nem alterado.';
const ER_NO_TEAM='o Starfork está logado, mas sem time escolhido — o épico é do TIME. Escolha um time no botão Conta (rodapé da barra lateral) e peça de novo. Nada foi criado nem alterado.';
const erFold=s=>String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
const erTx=s=>String(s==null?'':s).replace(/\s+/g,' ').trim();
const erUuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s||''));
const erEnc=s=>encodeURIComponent(String(s==null?'':s));
const erStrs=v=>Array.isArray(v)&&v.every(x=>typeof x==='string');
// segredos: MESMA lista do motor (AE_SECRET_RES, 47-edicoes-agente)
const erSecret=s=>(typeof AE_SECRET_RES!=='undefined'?AE_SECRET_RES:[]).some(re=>re.test(String(s||'')));

// PURA: a linha do arquivo é um pedido válido? (a fila é um arquivo: nada passa sem checar) → recusa pt-BR ou null
function erValidate(r){
  if(!r||typeof r!=='object'||!r.id) return 'pedido ilegível';
  if(!['create','link','unlink'].includes(r.kind)) return 'tipo de pedido desconhecido';
  const by=r.by||{};
  if(typeof by.agent!=='string'||!erTx(by.agent)) return 'pedido sem autor';
  if(by.role && !['planner','builder'].includes(by.role)) return 'o papel '+by.role+' não cria nem vincula épico';
  if(!Array.isArray(r.tasks)) return 'pedido sem a lista de tarefas';
  if(r.tasks.length>30) return 'no máximo 30 tarefas por pedido';
  for(const t of r.tasks){ if(!t||typeof t!=='object') return 'tarefa inválida no pedido';
    if(t.cloudId&&!erUuid(t.cloudId)) return 'id de cartão inválido: '+t.cloudId;
    if(t.localId&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(t.localId))) return 'id de tarefa inválido: '+t.localId;
    if(!t.cloudId&&!t.localId) return 'tarefa sem id no pedido'; }
  if(r.kind==='create'){
    const e=r.epic||{}; const title=erTx(e.title);
    if(!title) return 'épico sem título';
    if(title.length>140) return 'título do épico longo demais (máx. 140)';
    for(const k of ['description','outcome']) if(e[k]!==undefined&&(typeof e[k]!=='string'||e[k].length>2000)) return k+' inválido(a) ou longo(a) demais';
    if(e.doneWhen!==undefined&&(!erStrs(e.doneWhen)||e.doneWhen.length>30||e.doneWhen.some(x=>x.length>300))) return '"pronto quando" inválido';
    if([title,e.description,e.outcome,...(e.doneWhen||[])].some(erSecret)) return 'o texto parece conter um segredo — não gravo isso no épico';
  }
  if(r.kind==='link'){
    if(!r.epicId&&!erTx(r.epicTitle)) return 'diga a qual épico vincular';
    if(r.epicId&&!erUuid(r.epicId)) return 'id de épico inválido (épico do time é um uuid)';
    if(!r.tasks.length) return 'diga quais tarefas vincular';
  }
  if(r.kind==='unlink'&&!r.tasks.length) return 'diga quais tarefas tirar do épico';
  return null;
}
// PURA: o épico pelo NOME, entre os do time (sem caixa/acento) → { ep } | { err }
function erPickEpic(list, title){
  const hit=(list||[]).filter(e=>erFold(e.name)===erFold(title));
  if(hit.length===1) return { ep:hit[0] };
  const names=l=>l.slice(0,15).map(e=>e.id+' — '+e.name).join('\n');
  if(hit.length>1) return { err:'mais de um épico do time chamado "'+title+'" — use o id:\n'+names(hit) };
  return { err:'não achei o épico "'+title+'" no time. Épicos do time (id — nome):\n'+(names(list||[])||'(nenhum)') };
}
// PURA: spec do épico novo a partir do pedido
function erEpicSpec(r){
  const e=r.epic||{}, by=r.by||{};
  const dw=(e.doneWhen||[]).map(erTx).filter(Boolean).map((t,i)=>({ id:'D'+(i+1), text:t }));
  return { ...(erTx(e.description)?{ description:erTx(e.description) }:{}), ...(erTx(e.outcome)?{ outcome:erTx(e.outcome) }:{}),
    ...(dw.length?{ doneWhen:dw, doneWhenSeq:dw.length }:{}), requestId:r.id,
    origin:{ via:'terminal', agent:erTx(by.agent).slice(0,60), task:erTx(by.taskTitle||by.taskId||'').slice(0,120) } };
}
// PURA: desfecho → resultado que o CLI mostra
function erResult(r, ep, linked, failed){
  const n=linked.length, f=failed.length;
  const verb=r.kind==='unlink'?'tirada(s) do épico':'vinculada(s)';
  let status, ok, message;
  if(r.kind==='create'){
    ok=true; status=f?'partial':'done';
    message='épico "'+ep.name+'" criado no time'+(r.tasks.length?(n?' e '+n+' tarefa(s) '+verb:'')+(f?' — '+f+' tarefa(s) NÃO foram vinculadas':''):'')+'.';
  } else {
    ok=n>0; status=!n?'refused':f?'partial':'done';
    message=!n?'nenhuma tarefa foi '+(r.kind==='unlink'?'tirada do épico':'vinculada')+'.'
      :n+' tarefa(s) '+verb+(ep&&r.kind==='link'?' ao épico "'+ep.name+'"':'')+(f?' — '+f+' falharam':'')+'. Nada foi recriado nem reiniciado.';
  }
  return { id:r.id, ok, status, message, ...(ep?{ epicId:ep.id, epicTitle:ep.name }:{}), linked, failed, at:new Date().toISOString() };
}
const erRefused=(r, msg)=>({ id:r.id, ok:false, status:'refused', message:msg, linked:[], failed:[], at:new Date().toISOString() });

// ---- nuvem ----
async function erCreateEpic(r){
  const team=cloudTeamId();
  // idempotente: app caiu depois do insert e antes do resultado → reaproveita o épico do mesmo pedido
  const had=((await sbGet('epics?select=id,name,spec,status,created_by&team_id=eq.'+erEnc(team)+'&spec-%3E%3ErequestId=eq.'+erEnc(r.id)))||[])[0];
  if(had) return had;
  const rows=await sbPost('epics',{ team_id:team, name:erTx(r.epic.title), created_by:cloudUserId(), spec:erEpicSpec(r) });
  if(!rows||!rows[0]) throw new Error('a nuvem não devolveu o épico criado');
  if(typeof teamEpics!=='undefined'&&Array.isArray(teamEpics)) teamEpics.push(rows[0]);
  return rows[0];
}
async function erFindEpic(r){
  const team=cloudTeamId();
  if(r.epicId){
    const ep=((await sbGet('epics?select=id,name,spec,status,team_id&id=eq.'+erEnc(r.epicId)))||[])[0];
    if(!ep||(ep.team_id&&ep.team_id!==team)) return { err:'o épico '+r.epicId+' não existe no time escolhido (ou é de outro time). Veja os épicos com: cardume epic list' };
    return { ep };
  }
  const list=(await sbGet('epics?select=id,name,spec,status&team_id=eq.'+erEnc(team)+'&order=created_at.desc&limit=200'))||[];
  return erPickEpic(list, r.epicTitle);
}
// fase 1 (nuvem) de UMA tarefa: cartão no épico (ou fora dele). → { lid, cardId, title, mode }
async function erCloudOne(t, ep, proj){
  const lt=t.localId?(state.tasks||[]).find(x=>x.id===t.localId):null;
  if(t.localId&&!lt&&!t.cloudId) throw new Error('a tarefa '+t.localId+' não existe mais neste projeto');
  if(lt&&typeof tmapForeign==='function'&&tmapForeign().has(lt.id)) throw new Error('o cartão desta tarefa é de outra conta — entre com ela pra mudar o épico');
  let cardId=t.cloudId||(lt&&tmap()[lt.id])||null;
  let card=null;
  if(cardId) card=((await sbGet('tasks?select=id,local_id,title,status,epic_id,project_id&id=eq.'+erEnc(cardId)))||[])[0]||null;
  if(!card&&lt) card=((await sbGet('tasks?select=id,local_id,title,status,epic_id,project_id&project_id=eq.'+erEnc(proj.id)+'&local_id=eq.'+erEnc(lt.id)))||[])[0]||null;
  if(card&&card.project_id&&card.project_id!==proj.id) throw new Error('a tarefa "'+card.title+'" é de outro projeto');
  const want=ep?ep.id:null;
  if(card){
    if(lt&&!tmap()[lt.id]) tmapSet(lt.id, card.id);
    if((card.epic_id||null)!==want){
      await sbFetch('/rest/v1/tasks?id=eq.'+erEnc(card.id),{ method:'PATCH', body:JSON.stringify({ epic_id:want }) });
      sbPost('task_activity',{ task_id:card.id, user_id:cloudUserId(), kind:'edited', body:want?'épico: '+ep.name:'saiu do épico' }).catch(()=>{});
      return { lid:lt?lt.id:(card.local_id&&!String(card.local_id).startsWith('card-')?card.local_id:null), cardId:card.id, title:card.title, mode:'applied' };
    }
    return { lid:lt?lt.id:null, cardId:card.id, title:card.title, mode:'unchanged' };
  }
  if(!lt) throw new Error('o cartão '+t.cloudId+' não existe (ou é de outro time)');
  if(!want) return { lid:lt.id, cardId:null, title:lt.title, mode:'unchanged' }; // sem cartão e sem épico na nuvem: só a cópia local
  // sem cartão (ex.: rascunho): publica JÁ no épico — senão a tarefa não aparece na página do épico nem no quadro
  const cost=typeof taskCost==='function'?taskCost(lt.id):{ usd:0, tok:0 };
  await sbFetch('/rest/v1/tasks?on_conflict=project_id,local_id',{ method:'POST', headers:{ 'Prefer':'resolution=ignore-duplicates' }, body:JSON.stringify({
    local_id:lt.id, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:lt.title, status:lt.status,
    flag:lt.flag||null, branch:lt.branch||null, pr_url:lt.prUrl||null, issue_url:lt.issueUrl||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0,
    created_at:new Date(lt.createdAt||lt.created_at||Date.now()).toISOString(),
    spec:{ title:lt.title, objective:lt.objective||'', requirements:Array.isArray(lt.requirements)?lt.requirements:[], deliverables:Array.isArray(lt.deliverables)?lt.deliverables:[], kind:lt.kind||'build' },
    epic_id:want }) });
  const row=((await sbGet('tasks?select=id,epic_id&project_id=eq.'+erEnc(proj.id)+'&local_id=eq.'+erEnc(lt.id)))||[])[0];
  if(!row) throw new Error('não consegui publicar o cartão da tarefa no time');
  tmapSet(lt.id, row.id);
  if(row.epic_id!==want) await sbFetch('/rest/v1/tasks?id=eq.'+erEnc(row.id),{ method:'PATCH', body:JSON.stringify({ epic_id:want }) });
  sbPost('task_activity',{ task_id:row.id, user_id:cloudUserId(), kind:'created', body:lt.title }).catch(()=>{});
  return { lid:lt.id, cardId:row.id, title:lt.title, mode:'applied' };
}
// contexto do épico pro motor (EPIC.md das tarefas daqui) — antes de mexer na spec local
async function erWriteContext(epicId, proj){
  try{
    const [ep, cards]=await Promise.all([
      sbGet('epics?select=id,name,spec,status&id=eq.'+erEnc(epicId)).then(x=>(x||[])[0]||null),
      sbGet('tasks?select=id,local_id,title,status,assignee,spec,project_id,epic_id&epic_id=eq.'+erEnc(epicId)+'&order=created_at').then(x=>x||[]) ]);
    if(!ep||typeof aeEpicContextJson!=='function') return ep;
    const json=aeEpicContextJson(ep, cards, (state.tasks||[]).map(t=>t.id), proj&&proj.id, new Date().toISOString(), typeof tmName==='function'?tmName:null);
    await invokeQuiet('write_epic_context',{ epicId, json:JSON.stringify(json) });
    return ep;
  }catch(e){ console.warn('contexto do épico (pedido)', e&&e.message||e); return null; }
}

async function erApplyOne(r){
  const bad=erValidate(r); if(bad) return erRefused(r, bad);
  if(!SB.sess()) return erRefused(r, ER_NO_LOGIN);
  if(!cloudTeamId()) return erRefused(r, ER_NO_TEAM);
  let ep=null;
  try{
    if(r.kind==='create') ep=await erCreateEpic(r);
    else if(r.kind==='link'){ const x=await erFindEpic(r); if(x.err) return erRefused(r, x.err); ep=x.ep; }
  }catch(e){
    if(typeof aeIsPermanent==='function' && !aeIsPermanent(e)) throw e; // rede/conflito: o pedido fica na fila (criar é idempotente)
    return erRefused(r, (typeof cloudErrMsg==='function'?cloudErrMsg(e, r.kind==='create'?'Não consegui criar o épico':'Não consegui achar o épico'):String(e&&e.message||e))); }
  const linked=[], failed=[], done=[];
  let proj=null;
  if(r.tasks.length){
    try{ proj=await cloudEnsureProject(); }
    catch(e){ r.tasks.forEach(t=>failed.push({ ref:t.ref||t.localId||t.cloudId, title:t.title||'', why:typeof cloudErrMsg==='function'?cloudErrMsg(e):String(e&&e.message||e) })); }
  }
  if(proj) for(const t of r.tasks){ // fase 1: nuvem
    try{ done.push({ t, x:await erCloudOne(t, r.kind==='unlink'?null:ep, proj) }); }
    catch(e){ failed.push({ ref:t.ref||t.localId||t.cloudId, title:t.title||'', why:(typeof cloudErrMsg==='function'?cloudErrMsg(e):String(e&&e.message||e)) }); }
  }
  // fase 2: contexto do épico (o EPIC.md local nasce dele); fase 3: spec LOCAL pelo motor
  const epFresh=ep&&done.some(d=>d.x.lid)?(await erWriteContext(ep.id, proj))||ep:ep;
  const sp=(epFresh&&epFresh.spec)||{};
  const by=r.by||{};
  for(const { t, x } of done){
    let mode=x.mode;
    if(x.lid&&(state.tasks||[]).some(s=>s.id===x.lid)){
      try{
        const out=JSON.parse(await invoke('epic_link_cli',{ taskId:x.lid, epicId:r.kind==='unlink'?null:ep.id, epicTitle:r.kind==='unlink'?null:ep.name,
          doneWhen:r.kind==='unlink'?null:(typeof aeDoneWhenLines==='function'?aeDoneWhenLines(sp):[]), seq:+sp.doneWhenSeq||0, byAgent:by.agent||'agente', byTask:by.taskId||null }));
        if(out.mode==='applied') mode='applied';
      }catch(e){ failed.push({ ref:t.ref||x.lid, title:x.title||t.title||'', why:'o cartão mudou, mas a tarefa local não: '+String(e&&e.message||e) }); continue; }
    }
    linked.push({ ref:t.ref||x.lid||x.cardId, title:x.title||t.title||'', ...(x.lid?{ localId:x.lid }:{}), ...(x.cardId?{ cloudId:x.cardId }:{}), mode });
  }
  return erResult(r, ep, linked, failed);
}

// ---- tick: atende os pedidos do projeto aberto ----
let erBusy=false, erEpicsAt=0; const erRetry={};
async function erPublishEpicsList(force){
  if(!force && Date.now()-erEpicsAt<60000) return;
  erEpicsAt=Date.now();
  try{
    const list=(await sbGet('epics?select=id,name,status&team_id=eq.'+erEnc(cloudTeamId())+'&order=created_at.desc&limit=200'))||[];
    const cnt={}; ((typeof teamTasks!=='undefined'&&teamTasks)||[]).forEach(t=>{ if(t.epic_id) cnt[t.epic_id]=(cnt[t.epic_id]||0)+1; });
    await invokeQuiet('write_team_epics',{ json:JSON.stringify({ at:new Date().toISOString(), epics:list.map(e=>({ id:e.id, name:e.name, status:e.status||'', ...(e.id in cnt?{ tasks:cnt[e.id] }:{}) })) }) });
  }catch(e){ console.warn('lista de épicos do time', e&&e.message||e); }
}
async function erTick(){
  if(erBusy || (typeof SF_PANE!=='undefined'&&SF_PANE) || !state.repo) return;
  erBusy=true;
  try{
    const logged=!!(SB.sess()&&cloudTeamId());
    if(logged && (typeof cloudScopeOk!=='function'||cloudScopeOk())) await erPublishEpicsList(false);
    const pend=await invokeQuiet('epic_requests_pending').catch(()=>[]);
    if(!Array.isArray(pend)||!pend.length) return;
    if(logged && typeof cloudScopeOk==='function' && !cloudScopeOk()) return; // conta ainda carregando o mapa dela: espera (nada se perde)
    let any=false;
    for(const r of pend){
      let res;
      try{ res=await erApplyOne(r); delete erRetry[r.id]; }
      catch(e){ // transitório: fica na fila e tenta de novo; depois de 5 voltas desiste com o motivo
        const n=(erRetry[r.id]||0)+1; erRetry[r.id]=n;
        if(n<5){ console.warn('pedido de épico (tento de novo)', r&&r.id, e&&e.message||e); continue; }
        delete erRetry[r.id]; res=erRefused(r, 'desisti depois de '+n+' tentativas: '+(typeof cloudErrMsg==='function'?cloudErrMsg(e):String(e&&e.message||e))); }
      await invokeQuiet('epic_request_done',{ id:r.id, result:JSON.stringify(res) }).catch(e=>console.warn('resultado do pedido', e));
      erAfter(r, res); any=true;
    }
    if(any){ if(logged) erPublishEpicsList(true); try{ lastSig=''; await refresh(); }catch(_){ } }
  }finally{ erBusy=false; }
}
// avisa a pessoa (toast) e o agente que pediu, se ele ainda roda e já desistiu de esperar
function erAfter(r, res){
  const by=r.by||{}, who=by.agent||'Um agente';
  if(res.ok){
    toast(who+': '+res.message, res.status==='partial'?'warn':'ok', res.epicId&&typeof epOpenById==='function'?{ label:'abrir o épico', fn:()=>epOpenById(res.epicId) }:undefined);
    if(res.epicId && typeof aeRefreshTeam==='function') aeRefreshTeam(res.epicId);
  } else toast('Pedido de épico de '+who+' recusado: '+res.message.split('\n')[0], 'warn');
  const t=by.taskId&&(state.tasks||[]).find(x=>x.id===by.taskId);
  const late=Date.now()-new Date(r.at||0).getTime()>12000; // o CLI/MCP espera ~12s; depois disso ele só sabe por aqui
  if(t && late && (t.busy || (typeof ACTIVE_ST!=='undefined'&&ACTIVE_ST.has(t.status))))
    invokeQuiet('add_instruction',{ taskId:t.id, text:'Seu pedido de épico ('+r.id+') foi '+(res.ok?'EXECUTADO':'RECUSADO')+' pelo app: '+res.message+(res.epicId?' (épico '+res.epicId+')':'')+(res.ok?'':' Não repita igual; se for essencial, pergunte ao humano.') }).catch(()=>{});
}
tickLoop('epicRequests', erTick, 3000, 2000);
