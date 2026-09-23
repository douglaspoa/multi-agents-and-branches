// Constellation — 42-nuvem-sync-mobile
/* ============================================================================
   F2 — TAREFAS COMPARTILHADAS: o "cartão" da tarefa vive no time (Supabase);
   o trabalho (worktree, stream do agente) vive na máquina de quem assumiu.
   - criar: "realizar eu mesmo" (cartão reservado) × "compartilhar" (backlog)
   - backlog do time: ver spec, editar, assumir & iniciar, remover
   - sync: status/etapa/custo/branch/PR/provas do cartão, a cada 6s
   ========================================================================= */
function setView(v){ const b=document.querySelector('#viewSeg button[data-v="'+v+'"]'); if(b) b.click(); }
function tmap(){ try{ return JSON.parse(lsGet('sb:tmap')||'{}'); }catch(_){ return {}; } }
function tmapSet(localId, cloudId){ const m=tmap(); m[localId]=cloudId; lsSet('sb:tmap', JSON.stringify(m)); }
function agoTx(iso){ const s=(Date.now()-new Date(iso).getTime())/1000; if(!(s>=0)) return ''; if(s<60) return 'agora'; if(s<3600) return Math.floor(s/60)+'min'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
const CT_ST_PT={ backlog:'backlog', queued:'na fila', running:'rodando', thinking:'pensando', 'plan-review':'plano em revisão', review:'pronta pra review', delivered:'entregue', done:'concluída', merged:'mergeada', error:'erro', conflict:'conflito', aborted:'abortada', cancelled:'cancelada' };
function ctStColor(st){ return st==='backlog'?'var(--muted)':(st==='review'||st==='delivered'||st==='done')?'var(--good)':(st==='merged')?'var(--accent)':(st==='error'||st==='conflict')?'var(--bad, #e5534b)':'var(--warn)'; }

async function cloudEnsureProject(){
  const teamId=cloudTeamId(); if(!teamId) throw new Error('escolha um time no botão do topo');
  const remote=await invoke('repo_remote');
  const rows=await sbGet('projects?select=id,name,repo_remote&team_id=eq.'+teamId+'&repo_remote=eq.'+encodeURIComponent(remote));
  if(rows.length) return rows[0];
  const name=String(remote).split('/').pop();
  const ins=await sbPost('projects',{ team_id:teamId, name, repo_remote:remote });
  return ins[0];
}
// nuvem → .cardume/issue.json local: todo mundo do time pega a última config
// de "criar issue ao abrir demanda" do projeto (espelha prefsPull)
async function issueConfigPull(){
  if(!SB.sess() || !cloudTeamId()) return;
  try{
    const proj=await cloudEnsureProject();
    const rows=await sbGet('project_issue_config?select=enabled,instructions,title_template,body_template&project_id=eq.'+proj.id);
    const r=rows&&rows[0]; if(!r) return;
    if(typeof trkReady==='function' && trkReady()) return; // o painel de issues (14) cria a issue — não religar a instrução antiga
    await invoke('set_issue_config', { config: { enabled:!!r.enabled, instructions:r.instructions||'', titleTemplate:r.title_template||'', bodyTemplate:r.body_template||'' } });
  }catch(_){ }
}
// compartilhar com o time: vira cartão no backlog — NÃO roda nesta máquina
async function cloudShareTask(payload){
  if(!SB.sess()) throw new Error('entre na sua conta (botão no topo)');
  const proj=await cloudEnsureProject();
  const rows=await sbPost('tasks',{ local_id:'card-'+Math.random().toString(36).slice(2,10), project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), claim_mode:'open', title:payload.title, status:'backlog', epic_id:(typeof ntEpicVal==='function'?ntEpicVal():null), spec:payload });
  sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'created', body:payload.title }).catch(()=>{});
  teamTasks=null;
  return rows[0];
}
// realizar eu mesmo: roda aqui + sobe o cartão reservado (decisão: "pra si")
async function cloudPublishSelf(localId, payload){
  if(!SB.sess() || !cloudTeamId()) return;
  const proj=await cloudEnsureProject();
  const rows=await sbPost('tasks',{ local_id:localId, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:payload.title, status:'running', epic_id:(typeof ntEpicVal==='function'?ntEpicVal():null), spec:payload });
  tmapSet(localId, rows[0].id);
  if(rows[0].epic_id && window.epicMarkInProgress) epicMarkInProgress(rows[0].epic_id); // 1ª tarefa rodando → épico em andamento
  sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'started', body:'' }).catch(()=>{});
  teamTasks=null;
}

// backfill: publica no time as tarefas locais criadas ANTES do modo time
// (ou com "não compartilhar") — como SUAS (reservadas), com o status real.
async function cloudBackfill(btn){
  const list=(state.tasks||[]).filter(t=>!tmap()[t.id] && t.status!=='draft');
  if(!list.length) return;
  if(!confirm('Publicar/vincular '+list.length+' tarefa(s) local(is) no time?\n\nSobem como SUAS (reservadas), com status, flag e datas reais. Cartão que já existe só é vinculado — nada é sobrescrito.')) return;
  if(btn){ btn.disabled=true; }
  let n=0;
  try{
    const proj=await cloudEnsureProject();
    for(const t of list){
      if(btn) btn.textContent=`publicando ${++n}/${list.length}…`;
      try{
        const cost=taskCost(t.id);
        await sbFetch('/rest/v1/tasks?on_conflict=project_id,local_id',{ method:'POST', headers:{ 'Prefer':'resolution=ignore-duplicates' }, body: JSON.stringify({ local_id:t.id, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:t.title, status:t.status, flag:t.flag||null, branch:t.branch||null, pr_url:t.prUrl||null, issue_url:t.issueUrl||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0, created_at:new Date(t.createdAt||t.created_at).toISOString(), spec:{ title:t.title, objective:t.objective||'', requirements:Array.isArray(t.requirements)?t.requirements:[], deliverables:Array.isArray(t.deliverables)?t.deliverables:[], kind:t.kind||'build', ...epicPubFields(t.epic) }, epic_id:(t.epic&&t.epic.epicId)||null }) });
        const rows=await sbGet('tasks?select=id&project_id=eq.'+proj.id+'&local_id=eq.'+encodeURIComponent(t.id));
        if(rows[0]) tmapSet(t.id, rows[0].id);
      }catch(e){ console.error('backfill', t.id, e.message); }
    }
    teamTasks=null; teamPaintSig=''; renderTeamBoard();
  }finally{ if(btn){ btn.disabled=false; } }
}

// campos de épico que vão pro spec do cartão — sem epicChecks/epicDoneWhen (cópias estáticas; a fonte é epics.spec)
function epicPubFields(ep){ const { epicChecks, epicDoneWhen, ...rest }=(ep||{}); return rest; }
// ---- auto-publicação: tarefa local sem cartão VIRA cartão sozinha ----
// O time tem que ver o quadro real sem ninguém clicar nada (o stream do agente
// continua só nesta máquina; provas continuam opt-in). Uma por tick.
const autoPubFails={}, autoPubLast={};
async function cloudAutoPublish(){
  // falha não desiste pra sempre: backoff de 2min e tenta de novo
  const t=(state.tasks||[]).find(x=>!tmap()[x.id] && x.status!=='draft' && ((autoPubFails[x.id]||0)<3 || Date.now()-(autoPubLast[x.id]||0)>120000));
  if(!t) return;
  autoPubLast[t.id]=Date.now();
  try{
    const proj=await cloudEnsureProject();
    const cost=taskCost(t.id);
    await sbFetch('/rest/v1/tasks?on_conflict=project_id,local_id',{ method:'POST', headers:{ 'Prefer':'resolution=ignore-duplicates' }, body: JSON.stringify({ local_id:t.id, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:t.title, status:t.status, flag:t.flag||null, branch:t.branch||null, pr_url:t.prUrl||null, issue_url:t.issueUrl||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0, created_at:new Date(t.createdAt||t.created_at).toISOString(), spec:{ title:t.title, objective:t.objective||'', requirements:Array.isArray(t.requirements)?t.requirements:[], deliverables:Array.isArray(t.deliverables)?t.deliverables:[], kind:t.kind||'build', ...epicPubFields(t.epic) }, epic_id:(t.epic&&t.epic.epicId)||null }) });
    const rows=await sbGet('tasks?select=id&project_id=eq.'+proj.id+'&local_id=eq.'+encodeURIComponent(t.id));
    if(rows[0]){
      tmapSet(t.id, rows[0].id); teamTasks=null;
      sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'created', body:t.title }).catch(()=>{});
      if(ACTIVE_ST.has(t.status)) sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'started', body:'' }).catch(()=>{});
    }
  }catch(e){ autoPubFails[t.id]=(autoPubFails[t.id]||0)+1; console.error('autopub', t.id, e.message); }
}

// ---- reparo único do cursor do feed: se a nuvem está vazia pra uma tarefa
// ATIVA mas há eventos locais, o cursor foi envenenado (falhas antigas
// avançaram sem publicar) → zera pra republicar o histórico. 1x por sessão.
let feedRepaired=false;
async function cloudFeedRepair(){
  if(feedRepaired || !SB.sess() || !cloudTeamId()) return;
  if(!(state.events||[]).length || !(state.tasks||[]).length) return; // snapshot ainda não chegou — NÃO marca reparado
  feedRepaired=true;
  const m=tmap(); const pos=feedPos();
  for(const lid of Object.keys(m)){
    if(!(pos[lid]>0)) continue;
    const t=(state.tasks||[]).find(x=>x.id===lid);
    if(!t || !(ACTIVE_ST.has(t.status)||['thinking','plan-review','review','delivered'].includes(t.status))) continue;
    try{
      const rows=await sbGet('task_feed?select=id&task_id=eq.'+m[lid]+'&limit=3');
      const evn=(state.events||[]).filter(e=>(e.taskId||e.task_id)===lid && FEED_KINDS.has(e.type||e.kind)).length;
      if(rows.length<3 && evn>=3){ const p=feedPos(); delete p[lid]; lsSet('sb:feedpos', JSON.stringify(p)); invoke('web_log',{line:'[feed] cursor reparado: '+lid+' ('+evn+' eventos locais, '+rows.length+' na nuvem)'}).catch(()=>{}); }
    }catch(_){ }
  }
}

// ---- túnel AUTOMÁTICO: agente anunciou '🌐 preview:' numa tarefa ativa →
// cria o túnel sozinho e publica no cartão (nada manual; celular já abre).
const autoTunneled={};       // último pedido atendido por tarefa
const tunnelUp={};           // túneis vivos DESTA sessão: lid → url pública
let tunnelSweepDone=false;
async function cloudAutoTunnelTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  const m=tmap(); const ids=Object.values(m); if(!ids.length) return;
  // boot: túneis morreram com o app anterior — limpa previewUrl órfão dos cartões
  if(!tunnelSweepDone){
    tunnelSweepDone=true;
    try{
      const stale=await sbGet('tasks?select=id,spec&id=in.('+ids.slice(0,40).map(x=>'"'+x+'"').join(',')+')&spec-%3E%3EpreviewUrl=not.is.null&limit=10');
      for(const r of stale){ await sbFetch('/rest/v1/tasks?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({spec:{...(r.spec||{}),previewUrl:null}})}).catch(()=>{}); }
    }catch(_){ }
  }
  // ABERTURA E FECHO SÃO DECISÃO DO HUMANO: só atende pedidos explícitos
  // (tunnelWanted/tunnelClose vindos do celular; no Mac o chip chama direto).
  try{
    const rows=await sbGet('tasks?select=id,spec&id=in.('+ids.slice(0,40).map(x=>'"'+x+'"').join(',')+')&or=(spec-%3E%3EtunnelWanted.not.is.null,spec-%3E%3EtunnelClose.not.is.null)&limit=10');
    for(const r of rows){
      const lid=Object.keys(m).find(k=>m[k]===r.id); if(!lid) continue;
      const sp=r.spec||{};
      if(sp.tunnelClose){
        invoke('tunnel_stop',{ taskId: lid }).catch(()=>{});
        delete tunnelUp[lid]; delete autoTunneled[lid];
        await sbFetch('/rest/v1/tasks?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({spec:{...sp,previewUrl:null,tunnelClose:null,tunnelWanted:null}})}).catch(()=>{});
        continue;
      }
      if(sp.tunnelWanted){
        let pv=taskPreviewUrl(lid);
        if(!pv){
          // anúncio saiu da janela local de eventos → busca no feed da nuvem
          try{
            const notes=await sbGet('task_feed?select=text&task_id=eq.'+r.id+'&kind=eq.note&order=id.desc&limit=60');
            for(const n of notes){ const mm=(n.text||'').match(/🌐 preview:\s*(https?:\/\/[^\s'"”)]+)/); if(mm){ pv=mm[1]; break; } }
          }catch(_){ }
        }
        if(!pv){ invoke('web_log',{line:'[tunnel] pedido sem preview anunciado: '+lid}).catch(()=>{}); continue; }
        const key=pv+'|'+String(sp.tunnelWanted);
        if(autoTunneled[lid]===key) continue;
        autoTunneled[lid]=key;
        const pub=await mobilePreview(lid, pv, true);
        if(pub) tunnelUp[lid]=pub;
      }
    }
  }catch(_){ }
}
setInterval(()=>{ cloudAutoTunnelTick().catch(()=>{}); }, 9000);

// ---- sync: empurra o estado LOCAL das tarefas mapeadas pro cartão ----
const cloudSyncSigs={}, prProbed=new Set();
// ---- PONTES DE INTENÇÃO do celular (escopo mobile): o app escreve
// spec.intent={kind,...} → o Mac executa → publica spec.intentResult e limpa.
// kinds: openPr · merge · pause · abort · fixComment {commentId}
const intentBusy={};
const prPubAt={};
async function cloudIntentTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  const m=tmap(); const ids=Object.values(m); if(!ids.length) return;
  let rows=[];
  try{ rows=await sbGet('tasks?select=id,spec,pr_url&id=in.('+ids.slice(0,40).map(x=>'"'+x+'"').join(',')+')&spec-%3E%3Eintent=not.is.null&limit=6'); }catch(_){ return; }
  for(const r of rows){
    const lid=Object.keys(m).find(k=>m[k]===r.id); if(!lid || intentBusy[lid]) continue;
    const sp=r.spec||{}; const it=sp.intent||{}; const kind=it.kind;
    if(!kind) continue;
    intentBusy[lid]=true;
    const t=(state.tasks||[]).find(x=>x.id===lid);
    const finish=async(ok,msg,extra)=>{
      const cur=(await sbGet('tasks?select=spec&id=eq.'+r.id).catch(()=>[{}]))[0]||{};
      await sbFetch('/rest/v1/tasks?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({ ...(extra||{}), spec:{...(cur.spec||sp),intent:null,intentResult:{kind,ok,msg:String(msg||'').slice(0,300),at:new Date().toISOString()}}})}).catch(()=>{});
      delete intentBusy[lid];
      invoke('web_log',{line:'[intent] '+kind+' '+(ok?'ok':'FALHOU')+' · '+lid+(msg?' · '+String(msg).slice(0,80):'')}).catch(()=>{});
      lastSig=''; refresh().catch(()=>{});
    };
    try{
      if(kind==='openPr'){
        if(!t) return finish(false,'tarefa não está neste Mac');
        let checks=[]; try{ checks=await invoke('repo_checks',{taskId:lid}); }catch(_){ }
        const bad=checks.filter(c=>!c.ok);
        if(bad.length) return finish(false,'checagem falhou: '+bad.map(c=>c.name).join(', ')+' — abra pelo Mac pra ver o detalhe');
        try{ await invoke('push_task',{taskId:lid}); }catch(e){ return finish(false,'push falhou: '+e); }
        let body; try{ body=await invoke('pr_body_ai',{taskId:lid}); }catch(_){ body=prBodyOf(t); }
        try{
          const url=await invoke('open_pr',{taskId:lid, base:lsGet('prBase:'+lid)||'main', title:t.title, body});
          prCache[lid]=undefined;
          return finish(true,'PR aberto',{pr_url:url});
        }catch(e){ return finish(false,'criar PR falhou: '+e); }
      }
      if(kind==='merge'){
        try{ const msg=await invoke('merge_pr',{taskId:lid, method:'merge'}); return finish(true,msg); }
        catch(e){ return finish(false,String(e)); }
      }
      if(kind==='pause'){ try{ await invoke('pause_task',{taskId:lid}); return finish(true,'pausada'); }catch(e){ return finish(false,String(e)); } }
      if(kind==='abort'){ try{ await invoke('abort_task',{taskId:lid}); return finish(true,'abortada'); }catch(e){ return finish(false,String(e)); } }
      if(kind==='fixComment'){
        try{
          prCache[lid]=undefined; await loadPr(lid,true);
          const info=prCache[lid];
          const cmts=((info&&info.comments)||[]).filter(c=>!c.inReplyTo);
          const ci=cmts.findIndex(c=>String(c.id)===String(it.commentId));
          if(ci<0) return finish(false,'comentário não encontrado');
          await prFixOne(lid, ci);
          return finish(true,'agente acordado pra corrigir o comentário');
        }catch(e){ return finish(false,String(e)); }
      }
      return finish(false,'intenção desconhecida: '+kind);
    }catch(e){ return finish(false,String(e&&e.message||e)); }
  }
}
// publica na nuvem o que a tela Entrega/PR do celular mostra: stat do diff,
// commits e o PR (corpo+comentários truncados) — sem isso o mobile ficaria cego
async function cloudPrStatTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  const m=tmap();
  const live=(state.tasks||[]).filter(t=>m[t.id] && t.flag!=='closed' && !['merged','done','draft'].includes(t.status)).slice(0,8);
  for(const t of live){
    const cid=m[t.id];
    const now=Date.now();
    if(now-(prPubAt[t.id]||0) < 120000) continue;
    prPubAt[t.id]=now;
    try{
      const d=diffOf(t.id)||{}; const c=commitsCache[t.id];
      const stat={ files:(d.files||[]).length, add:d.additions||0, del:d.deletions||0, commits:Array.isArray(c)?c.length:null };
      let prInfo=null;
      if(t.prUrl){
        try{ await loadPr(t.id); const i=prCache[t.id];
          if(i&&i.exists) prInfo={ number:i.number, state:i.state, decision:i.decision, body:(i.body||'').slice(0,3000),
            comments:(i.comments||[]).filter(x=>!x.inReplyTo).slice(0,12).map(x=>({id:x.id,author:x.author,path:x.path,line:x.line,answered:x.answered,isBot:x.isBot,body:(x.body||'').slice(0,400)})) };
          // merge feito FORA do app (GitHub) → marca merged aqui também
          if(i&&i.exists&&i.state==='MERGED'&&!['merged','done'].includes(t.status)){
            invoke('mark_task_status',{ taskId:t.id, status:'merged' }).then(()=>{ lastSig=''; refresh(); }).catch(()=>{});
          }
        }catch(_){ }
      }
      const rev=reviewOf(t.id);
      const review=rev?{ summary:(rev.summary||'').slice(0,600), howToTest:(rev.howToTest||'').slice(0,800) }:null;
      const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{};
      await sbFetch('/rest/v1/tasks?id=eq.'+cid,{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),stat,prInfo,review}})});
    }catch(_){ }
  }
}
setInterval(()=>{ cloudIntentTick().catch(()=>{}); }, 6000);
setInterval(()=>{ cloudPrStatTick().catch(()=>{}); }, 30000);
async function cloudSyncTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  await cloudAutoPublish().catch(()=>{});
  const m=tmap(); const ids=Object.keys(m); if(!ids.length) return;
  // descobre o PR de UMA tarefa por tick (gh) — persiste no spec e o sync leva pro cartão
  const probe=ids.find(lid=>{ const t=(state.tasks||[]).find(x=>x.id===lid); return t && !t.prUrl && ['review','merged','error'].includes(t.status) && !prProbed.has(lid); });
  if(probe){ prProbed.add(probe); invoke('pr_status',{ taskId: probe }).catch(()=>{}); }
  for(const lid of ids){
    const t=(state.tasks||[]).find(x=>x.id===lid); if(!t) continue;
    // itens do "pronto quando" que o agente revisor marcou (tool check_done_when) → espelho no épico do time
    if(t.epic&&Array.isArray(t.epic.epicChecks)&&t.epic.epicChecks.length&&window.epicMirrorChecks) epicMirrorChecks(t).catch(()=>{});
    const cost=taskCost(lid);
    const body={ status:t.status, stage:t.stage||null, branch:t.branch||null, pr_url:t.prUrl||null, issue_url:t.issueUrl||null, flag:t.flag||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0 };
    const proofs=reqProofCache[lid]; if(proofs) body.requirements_proof=proofs;
    const sig=JSON.stringify(body);
    const prev=cloudSyncSigs[lid];
    if(prev===sig) continue;
    if(prev===undefined){
      // boot da sessão: não "toca" o cartão à toa (preserva updated_at real) —
      // compara com o cartão real ANTES de cachear a assinatura (sem o quadro
      // carregado, busca só este cartão; senão tarefa rápida ficava presa).
      cloudSyncSigs[lid]=sig;
      let card=(teamTasks||[]).find(c=>c.id===m[lid]);
      if(!card){ try{ card=(await sbGet('tasks?select=status,flag,pr_url&id=eq.'+m[lid]))[0]; }catch(_){ } }
      if(!card) continue;
      const same=card.status===t.status && (card.flag||null)===(t.flag||null) && (card.pr_url||null)===(t.prUrl||null);
      if(same) continue;
    }
    try{
      await sbFetch('/rest/v1/tasks?id=eq.'+m[lid], { method:'PATCH', body: JSON.stringify(body) });
      // AÇÕES vão pra nuvem sozinhas: mudança de status/PR vira atividade no feed
      const before=prev?JSON.parse(prev):null;
      if(before && before.status!==t.status) sbPost('task_activity',{ task_id:m[lid], user_id:cloudUserId(), kind:'status', body:CT_ST_PT[t.status]||t.status }).catch(()=>{});
      // tarefa TERMINOU → túnel do preview fecha e a URL sai do cartão
      if(before && (['merged','done','aborted'].includes(t.status)||t.flag==='closed') && !(['merged','done','aborted'].includes(before.status)||before.flag==='closed')){
        invoke('tunnel_stop',{ taskId: lid }).catch(()=>{});
        delete autoTunneled[lid];
        (async()=>{ try{ const cur=(await sbGet('tasks?select=spec&id=eq.'+m[lid]))[0]||{}; if((cur.spec||{}).previewUrl){ await sbFetch('/rest/v1/tasks?id=eq.'+m[lid],{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),previewUrl:null,tunnelWanted:null}})}); } }catch(_){ } })();
      }
      if(before && !before.pr_url && t.prUrl) sbPost('task_activity',{ task_id:m[lid], user_id:cloudUserId(), kind:'delivered', body:'PR aberto' }).catch(()=>{});
      cloudSyncSigs[lid]=sig;
    }
    catch(e){ console.error('sync '+lid+':', e.message); }
  }
}
setInterval(()=>{ cloudSyncTick().catch(()=>{}); }, 6000);
setInterval(()=>{ railProjTick().catch(()=>{}); }, 15000);
setTimeout(()=>{ railProjTick().catch(()=>{}); }, 2500);

// ---- PONTE DE PERGUNTAS (mobile): pergunta aberta sobe, resposta desce ----
// O agente pergunta (ask_human) → o Mac publica no cartão; o dev responde do
// celular (PWA) → o Mac entrega a resposta ao agente (resolve_pending).
const qPushed=new Set();
// ---- push APNs REAL pros meus iPhones (app fechado): pergunta nova · entrega pronta ----
let apnsTokens=null, apnsTokensAt=0;
async function apnsNotify(title, body, extra){
  try{
    if(!SB.sess()) return;
    if(!apnsTokens || Date.now()-apnsTokensAt>300000){
      apnsTokens=(await sbGet('device_tokens?select=token&user_id=eq.'+cloudUserId()+'&platform=eq.ios&limit=5')).map(r=>r.token);
      apnsTokensAt=Date.now();
    }
    for(const tk of (apnsTokens||[])){
      invoke('apns_push',{ token:tk, title, body, category:(extra&&extra.category)||null, taskId:(extra&&extra.taskId)||null, questionId:(extra&&extra.questionId)||null })
        .then(()=>invoke('web_log',{line:'[apns] ✓ '+title.slice(0,40)}))
        .catch(e=>invoke('web_log',{line:'[apns] ✖ '+String(e).slice(0,120)}));
    }
  }catch(_){ }
}
// entrega ficou PRONTA → push (transição de status observada no snapshot local)
const pushedReady=new Set();
async function pushReadyTick(){
  const m=tmap();
  for(const t of (state.tasks||[])){
    if(!['review','delivered'].includes(t.status) || t.flag==='closed' || pushedReady.has(t.id)) continue;
    pushedReady.add(t.id);
    if(!m[t.id]) continue;
    // só empurra transições NOVAS (tarefa que já estava pronta no boot não notifica)
    if(Date.now()-bootAt<20000) continue;
    apnsNotify('Entrega pronta pra revisar', t.title.slice(0,120), { taskId:m[t.id] });
  }
}
const bootAt=Date.now();
setInterval(()=>{ pushReadyTick().catch(()=>{}); }, 6000);
async function cloudQuestionsTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  const m=tmap(); const ids=Object.keys(m); if(!ids.length) return;
  for(const lid of ids){
    const cid=m[lid];
    const pend=(state.pending||[]).filter(p=>p.taskId===lid);
    // 1) publica perguntas abertas (upsert por task+pending_id)
    for(const p of pend){
      const key=cid+'|'+p.id;
      if(qPushed.has(key)) continue;
      try{
        const qrows=await sbFetch('/rest/v1/questions?on_conflict=task_id,local_pending_id', { method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ task_id:cid, local_pending_id:p.id, agent:p.agent||'', prompt:(p.prompt||'').slice(0,2000), options:Array.isArray(p.options)?p.options:[], status:'open' }) });
        qPushed.add(key);
        // push REAL: responder direto da notificação, com o app fechado
        const qid=(Array.isArray(qrows)&&qrows[0]&&qrows[0].id)?String(qrows[0].id):'';
        apnsNotify('Precisa de você — '+(p.agent||'agente'), String(p.prompt||'').slice(0,160), { taskId:cid, questionId:qid, category:'QUESTION' });
      }catch(err){
        // erro visível: sem isso a ponte falha em silêncio e ninguém fica sabendo
        if(!qPushed.has('err|'+key)){ qPushed.add('err|'+key); sbPost('task_feed',{ task_id:cid, agent:'Sistema', kind:'error', text:'⚠ pergunta não subiu pro celular: '+String(err.message||err).slice(0,180) }).catch(()=>{}); }
      }
    }
    try{
      // 2) respostas vindas do celular → entrega ao agente e fecha
      const answered=await sbGet('questions?select=id,local_pending_id,answer&task_id=eq.'+cid+'&status=eq.answered');
      for(const q of answered){
        if(pend.some(p=>p.id===q.local_pending_id)){
          try{ await invoke('resolve_pending',{ id:q.local_pending_id, answer:q.answer||'' }); }catch(_){ continue; }
        }
        await sbFetch('/rest/v1/questions?id=eq.'+q.id, { method:'PATCH', body: JSON.stringify({ status:'closed' }) }).catch(()=>{});
        lastSig='';
      }
      // 3) pergunta respondida NO DESKTOP (sumiu do pending local) → fecha na nuvem
      const open=await sbGet('questions?select=id,local_pending_id&task_id=eq.'+cid+'&status=eq.open');
      for(const q of open){
        if(!pend.some(p=>p.id===q.local_pending_id)){
          await sbFetch('/rest/v1/questions?id=eq.'+q.id, { method:'PATCH', body: JSON.stringify({ status:'closed' }) }).catch(()=>{});
        }
      }
    }catch(_){ }
  }
}
setInterval(()=>{ cloudQuestionsTick().catch(()=>{}); }, 7000);

// ---- MOBILE AO VIVO: o celular escreve intenções, ESTE Mac executa ----
// 1) tarefa pedida do celular (status='requested', minha) → cria e RODA aqui
const remoteStartFails={};
async function cloudRemoteStartTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  const me=cloudUserId();
  const rows=await sbGet('tasks?select=*,projects(repo_remote)&status=eq.requested&assignee=eq.'+me+'&limit=3').catch(()=>[]);
  if(!rows.length) return;
  let remote=''; try{ remote=await invoke('repo_remote'); }catch(_){ }
  for(const ct of rows){
    if((remoteStartFails[ct.id]||0)>=3) continue;
    const rr=(ct.projects||{}).repo_remote;
    if(rr && rr!==remote) continue; // é de outro projeto — outro Mac atende
    try{
      const sp=ct.spec||{};
      const payload={ workflow:null, agents:null, engine:sp.engine||'claude', model:sp.model||null, approval:'auto', owns:null, off:null,
        objective:sp.objective||ct.title, deliverables:[], requirements:Array.isArray(sp.requirements)?sp.requirements:[],
        doc:sp.doc||null, proof:!!sp.proof, tests:!!sp.tests, autoPr:sp.autoPr||'ask', prBase:null, planApproval:'auto', refs:[],
        branchType:sp.branchType||'feat', issue:(sp.issueCode||'').trim()||null, base:null, linkedTo:null,
        // tarefa de ÉPICO: os campos do cartão vão pro TASK.yaml (bloco epic)
        epicId: ct.epic_id||null, epicDoneWhen:(typeof epicDoneWhenOf==='function'?epicDoneWhenOf(ct.epic_id):null), verify:sp.verify||null, covers:sp.covers||null, after:sp.after||null, wave:sp.wave||null, risk:sp.risk||null, hitl:sp.hitl||null, boundaries:sp.boundaries||null,
        title: ct.title, start:true };
      const localId=await invoke('new_task', await trkBeforeNewTask(payload));
      tmapSet(localId, ct.id);
      await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'PATCH', body: JSON.stringify({ status:'running', local_id: localId }) });
      if(ct.epic_id && window.epicMarkInProgress) epicMarkInProgress(ct.epic_id);
      sbPost('task_activity',{ task_id:ct.id, user_id:me, kind:'started', body:'iniciada do celular' }).catch(()=>{});
      sbPost('task_feed',{ task_id:ct.id, agent:'Sistema', kind:'note', text:'▶ o Mac assumiu: criando worktree e iniciando o agente…' }).catch(()=>{});
      teamTasks=null; lastSig='';
    }catch(e){ remoteStartFails[ct.id]=(remoteStartFails[ct.id]||0)+1; console.error('remoteStart', e.message); }
  }
}
setInterval(()=>{ cloudRemoteStartTick().catch(()=>{}); }, 6000);

// 2) feed condensado ao vivo: eventos novos das MINHAS tarefas mapeadas → task_feed
function feedPos(){ try{ return JSON.parse(lsGet('sb:feedpos')||'{}'); }catch(_){ return {}; } }
function feedPosSet(lid, id){ const m=feedPos(); m[lid]=id; lsSet('sb:feedpos', JSON.stringify(m)); }
const FEED_KINDS=new Set(['think','note','bash','error','done','edit','write']);
async function cloudFeedTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  await cloudFeedRepair();
  const m=tmap(); const pos=feedPos();
  for(const lid of Object.keys(m)){
    const evs=(state.events||[]).filter(e=>(e.taskId||e.task_id)===lid && e.id>(pos[lid]||0) && FEED_KINDS.has(e.type||e.kind)).slice(0,8);
    if(!evs.length) continue;
    try{
      for(const e of evs){
        await sbPost('task_feed',{ task_id:m[lid], agent:e.agent||'', kind:(e.type||e.kind), text:String(e.text||'').slice(0,300) });
      }
      feedPosSet(lid, evs[evs.length-1].id);
      invoke('web_log',{line:'[feed] +'+evs.length+' → '+lid}).catch(()=>{});
    }catch(err){
      // cartão apagado na nuvem (FK) ou RLS: avança o cursor pra não travar a
      // fila — um lid quebrado NUNCA pode segurar o feed dos outros.
      feedPosSet(lid, evs[evs.length-1].id);
      console.error('feed '+lid+': '+(err.message||err));
    }
  }
}
setInterval(()=>{ cloudFeedTick().catch(()=>{}); }, 4000);

// 3) chat do celular → entrega ao agente (fila do motor cuida do turno ocupado)
const msgDelivering=new Set();
async function cloudMsgTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  const m=tmap(); const ids=Object.values(m); if(!ids.length) return;
  const rows=await sbGet('task_messages?select=id,task_id,body,author&delivered_at=is.null&task_id=in.('+ids.map(x=>'"'+x+'"').join(',')+')&order=id&limit=5').catch(()=>[]);
  for(const msg of rows){
    if(msgDelivering.has(msg.id)) continue; msgDelivering.add(msg.id);
    const lid=Object.keys(m).find(k=>m[k]===msg.task_id); if(!lid) continue;
    try{
      await sbFetch('/rest/v1/task_messages?id=eq.'+msg.id, { method:'PATCH', body: JSON.stringify({ delivered_at:new Date().toISOString() }) });
      // "[img] <path> | legenda" = FOTO do celular: baixa pra .cardume/refs e manda o agente ABRIR
      const img=String(msg.body||'').match(/^\[img\]\s*(\S+)(?:\s*\|\s*([\s\S]*))?$/);
      if(img){
        const local=await invoke('fetch_task_ref',{ taskId: lid, url:SB.url(), anon:SB.key(), token:SB.sess().access_token, path: img[1] });
        const cap=(img[2]||'').trim();
        const m2=`📎 O humano anexou uma IMAGEM do celular em ${local} — ABRA e analise (tool Read) antes de responder.${cap?`\nLegenda: ${cap}`:''}`;
        await invoke('talk_task',{ taskId: lid, message: m2, asReq:false, agent:null });
        sbPost('task_feed',{ task_id:msg.task_id, agent:'Você', kind:'note', text:'💬 📎 imagem anexada'+(cap?': '+cap.slice(0,200):'') }).catch(()=>{});
        continue;
      }
      // "[req] ..." vindo do celular = adicionar como REQUISITO da tarefa (checklist)
      const asReq=/^\[req\]\s*/i.test(String(msg.body||''));
      const body=String(msg.body||'').replace(/^\[req\]\s*/i,'');
      await invoke('talk_task',{ taskId: lid, message: body, asReq, agent:null });
      sbPost('task_feed',{ task_id:msg.task_id, agent:'Você', kind:'note', text:'💬 '+body.slice(0,280) }).catch(()=>{});
    }catch(e){ console.error('msg', e.message); }
  }
}
setInterval(()=>{ cloudMsgTick().catch(()=>{}); }, 5000);

// ---- backlog do time (aba Time) ----
let teamTasks=null, teamProj={}, teamProfiles={}, teamFetchedAt=0, teamRepoRemote='', teamFetching=false, teamPaintSig='', teamEpics=[], teamActivity=[];
let tmView=lsGet('tmView')||'overview';
// escopo da aba Time: 'team' (o time escolhido no topo) ou 'org' (TODOS os times — só owner/admin,
// que já enxergam tudo pela RLS; é a visão de super usuário da empresa)
let tmScope=lsGet('tmScope')||'team';
function tsIsOrgAdmin(){ return !!(cloudData && (cloudData.meRole==='owner'||cloudData.meRole==='admin')); }
function tsOrgScope(){ return tmScope==='org' && tsIsOrgAdmin() && !!(cloudData&&cloudData.teams&&cloudData.teams.length); }
function tsScopeTeamIds(){ return tsOrgScope() ? cloudData.teams.map(t=>t.id) : (cloudTeamId()?[cloudTeamId()]:[]); }
function tsTeamName(id){ return ((((cloudData&&cloudData.teams)||[]).find(x=>x.id===id))||{}).name||''; }
function tsSetScope(s){ tmScope=s==='org'?'org':'team'; lsSet('tmScope',tmScope); teamTasks=null; teamPaintSig=''; if(typeof renderTeamBoard==='function') renderTeamBoard(); }
// presença: marca "estou online" a cada 60s (profiles.last_seen_at)
setInterval(()=>{ if(SB.sess()) sbFetch('/rest/v1/profiles?user_id=eq.'+cloudUserId(), { method:'PATCH', body: JSON.stringify({ last_seen_at: new Date().toISOString() }) }).catch(()=>{}); }, 60000);
let teamFetchP=null; // promise compartilhada: chamadas concorrentes esperam o MESMO fetch
function teamFetch(force){
  if(teamFetchP) return teamFetchP;
  if(!force && teamTasks && Date.now()-teamFetchedAt<10000) return Promise.resolve();
  teamFetchP=teamFetchRun().finally(()=>{ teamFetchP=null; });
  return teamFetchP;
}
async function teamFetchRun(){
  teamFetching=true;
  try{
    const teamId=cloudTeamId(); if(!teamId) return;
    const ids=tsScopeTeamIds(); if(!ids.length) return;
    const inq='team_id=in.('+ids.map(i=>'"'+i+'"').join(',')+')';
    const [tasks, projs, eps, acts]=await Promise.all([
      sbGet('tasks?select=*&'+inq+'&order=updated_at.desc&limit='+(ids.length>1?600:200)),
      sbGet('projects?select=id,name,repo_remote&'+inq),
      sbGet('epics?select=id,name,status,team_id,spec,created_by,created_at,updated_at&'+inq+'&status=neq.archived&order=created_at').catch(()=>sbGet('epics?select=id,name,status,team_id&'+inq+'&status=neq.archived&order=created_at')).catch(()=>[]), // fallback: nuvem sem a 0025
      sbGet('task_activity?select=id,task_id,user_id,kind,body,at&order=id.desc&limit=60').catch(()=>[]),
    ]);
    teamEpics=eps||[]; teamActivity=acts||[];
    teamProj={}; projs.forEach(p=>teamProj[p.id]=p);
    const uids=new Set(); tasks.forEach(t=>{ uids.add(t.created_by); if(t.assignee) uids.add(t.assignee); });
    (teamActivity||[]).forEach(a=>uids.add(a.user_id));
    ids.forEach(tid=>((cloudData&&cloudData.teamMembers&&cloudData.teamMembers[tid])||[]).forEach(m=>uids.add(m.user_id)));
    if(tsOrgScope()) ((cloudData&&cloudData.orgMembers)||[]).forEach(m=>uids.add(m.user_id)); // membro da org sem time também aparece
    if(uids.size){ const profs=await sbGet('profiles?select=user_id,name,email,last_seen_at&user_id=in.('+[...uids].map(u=>'"'+u+'"').join(',')+')'); teamProfiles={}; profs.forEach(p=>teamProfiles[p.user_id]=p); }
    try{ teamRepoRemote=await invoke('repo_remote'); }catch(_){ teamRepoRemote=''; }
    teamTasks=tasks; teamFetchedAt=Date.now();
  } finally { teamFetching=false; }
}
function tmName(uid){ const p=teamProfiles[uid]; return p?(p.name||p.email):((uid||'').slice(0,8)); }
