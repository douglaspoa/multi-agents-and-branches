// Constellation — 24-perguntas-agente
// ---------- modal de resposta ao agente (legível, input estável fora do poll) ----------
let askId=null;
// pergunta do agente SEM modal: abre a tela de execução — a pergunta está inline
// na conversa, com os botões de opção e o input no mesmo lugar de sempre
function openAsk(pendingId){
  const p=(state.pending||[]).find(x=>x.id===pendingId); if(!p) return;
  const tid=p.taskId; if(!tid) return;
  selected=tid; render();
  openWorkspace(tid);
  setTimeout(()=>{ const i=$id('fwInput'); if(i) i.focus(); }, 350);
}
function closeAsk(){ $id('askOverlay').style.display='none'; askId=null; }
function askDoSend(){ const v=$id('askTa').value.trim(); if(!v||askId==null) return; resolvePending(askId, v); closeAsk(); }
$id('askClose').onclick=closeAsk;
$id('askCancel').onclick=closeAsk;
$id('askSend').onclick=askDoSend;
$id('askTa').addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)) askDoSend(); });
$id('askOverlay').addEventListener('click',e=>{ if(e.target.id==='askOverlay') closeAsk(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$id('askOverlay').style.display!=='none') closeAsk(); });
async function mergeTask(taskId){
  try{ await invoke("merge_task",{taskId}); await refresh(); }
  catch(e){ alert("Merge falhou:\n"+e); }
}
// rascunho: clicar EDITA — reabre a Nova demanda preenchida; ao salvar/iniciar,
// o rascunho antigo é substituído (remove_task + criação nova)
let ntEditingDraft=null;
async function editDraft(t){
  if(window.openTab) window.openTab('form'); else await openNewTask(); // abre a Nova demanda como ABA
  setNtMode('build');
  ntEditingDraft=t.id;
  $id('ntTitle').value=t.title||'';
  $id('ntObj').value=t.objective||'';
  ntDel=Array.isArray(t.deliverables)?t.deliverables.slice():[];
  ntReq=Array.isArray(t.requirements)?t.requirements.slice():[];
  ntRefs=Array.isArray(t.refs)?t.refs.slice():[];
  if(t.base) $id('ntBase').value=t.base;
  if(t.model) $id('ntModel').value=t.model;
  renderNtList('ntDeliverables',ntDel); renderNtList('ntRequirements',ntReq); renderNtRefs();
  wizN=1; if(typeof wizRender==='function') wizRender();
  ntGate();
}
async function startTask(taskId){
  // slots: aviso leve quando já há muita coisa em paralelo (não bloqueia).
  const live = state.tasks.filter(x=>ACTIVE_ST.has(x.status)||x.status==='paused').length;
  if(live>=slotMax && !await askYes(`Já há ${live} execuções em andamento (limite ${slotMax}).\nIniciar mesmo assim?`)) return;
  try{ await invoke("start_task",{taskId}); lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao iniciar:\n"+e); }
}
async function pauseTask(taskId){
  try{ await invoke("pause_task",{taskId}); await refresh(); }
  catch(e){ alert("Falha ao pausar:\n"+e); }
}
async function resumeTask(taskId){
  try{ await invoke("resume_task",{taskId}); lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao retomar:\n"+e); }
}
async function abortTask(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!await askYes(`Abortar a tarefa de ${t?t.agent:'agente'}?\nO processo do agente é encerrado; a branch/worktree é preservada pra inspeção.`)) return;
  try{ await invoke("abort_task",{taskId}); await refresh(); }
  catch(e){ alert("Falha ao abortar:\n"+e); }
}
function startRenameBranch(t){
  const sub=document.querySelector('#side .sub'); if(!sub) return;
  sub.innerHTML=`<span class="brnlbl">branch</span><input class="in brnin mono" id="brnInput" value="${escA(t.branch)}"><button class="btn primary sm" id="brnSave">salvar</button><button class="btn sm" id="brnCancel">cancelar</button>`;
  const inp=$id('brnInput'); inp.focus(); inp.select();
  const go=async()=>{ const name=inp.value.trim(); if(!name||name===t.branch){ renderSide(); return; } inp.disabled=true;
    try{ await invoke('rename_branch',{ taskId:t.id, name }); prCache[t.id]=undefined; lastSig=''; await refresh(); }
    catch(e){ alert('Falha ao renomear a branch:\n'+e); renderSide(); } };
  $id('brnSave').onclick=go;
  $id('brnCancel').onclick=()=>renderSide();
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter') go(); if(e.key==='Escape') renderSide(); });
}
async function removeTask(taskId){
  try{ await invoke("remove_task",{taskId}); if(selected===taskId) selected=null; await refresh(); }
  catch(e){ console.error("remove_task", e); }
}
let stMenuOpen=false;
async function markStatus(taskId, status){
  try{ await invoke("mark_task_status",{ taskId, status }); lastSig=""; await refresh(); }
  catch(e){ alert("Falha:\n"+e); }
}
// ações de ESTADO disponíveis pro pill, conforme a situação atual
function statusMenuItems(t){
  const it=[];
  if(t.status==='review'){
    it.push({l:'Mergear na '+t.base+' (merge local)', a:()=>mergeTask(t.id)});
    it.push({l:'Marcar como mergeada (PR já mergeado)', a:()=>markStatus(t.id,'merged')});
  }
  if(['review','merged','error'].includes(t.status)) it.push({l:'Abrir tarefa de correção linkada…', a:()=>openLinkedFix(t)});
  if(['error','aborted','conflict'].includes(t.status)) it.push({l:'Voltar pra review', a:()=>markStatus(t.id,'review')});
  if(t.status==='draft') it.push({l:'Iniciar agora', a:()=>startTask(t.id)});
  if(ACTIVE_ST.has(t.status)){ it.push({l:'Pausar', a:()=>pauseTask(t.id)}); it.push({l:'Abortar', a:()=>abortTask(t.id), danger:true}); }
  if(t.status==='paused'){ it.push({l:'Retomar', a:()=>resumeTask(t.id)}); }
  if(t.flag==='blocked') it.push({l:'Desbloquear', a:()=>setFlag(t.id,'')});
  else it.push({l:'Bloquear', a:()=>setFlag(t.id,'blocked')});
  if(t.flag==='closed') it.push({l:'Reabrir', a:()=>setFlag(t.id,'')});
  else if(t.status!=='draft') it.push({l:'Encerrar (finalizada)', a:()=>setFlag(t.id,'closed')});
  return it;
}
async function setFlag(taskId, flag){
  try{ await invoke("set_task_flag",{ taskId, flag: flag||null }); lastSig=""; await refresh(); }
  catch(e){ alert("Falha:\n"+e); }
}
async function talkTask(taskId, message){
  const m=(message||'').trim(); if(!m) return;
  try{ await invoke("talk_task",{ taskId, message:m }); artifactsCache[taskId]=undefined; reqProofCache[taskId]=undefined; commitsCache[taskId]=undefined; prCache[taskId]=undefined; lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao conversar:\n"+e); }
}
async function stopTask(taskId){
  try{ await invoke("stop_task",{ taskId }); lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao parar:\n"+e); }
}
// openChat: o "chat" da tarefa agora é o próprio workspace (colunas fw*)
function openChat(taskId){ /* chat agora É o workspace estilo Cursor (arquivos + requisitos + conversa) */ openWorkspace(taskId); setTimeout(()=>{ const i=$id('fwInput'); if(i) i.focus(); },250); }
async function deliverArtifact(taskId, kind){
  const lbl={doc:'documento de arquitetura',tests:'testes',proof:'prova (prints)',all:'todos os entregáveis'}[kind]||kind;
  try{ await invoke("deliver_artifact",{ taskId, kind }); artifactsCache[taskId]=undefined; reqProofCache[taskId]=undefined; lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao pedir "+lbl+":\n"+e); }
}
function deliverBlock(t){
  if(t.kind==='review' || !['review','error','aborted','conflict'].includes(t.status)) return '';
  return `<div class="seclbl">Pedir entregáveis</div>`+
    `<div class="delivrow"><button class="btn primary sm" data-deliver="all">${IC.stack} Pedir todos</button></div>`+
    `<div class="delivrow" style="margin-top:5px"><button class="btn sm" data-deliver="doc">${IC.doc} Doc de arquitetura</button><button class="btn sm" data-deliver="tests">${IC.beaker} Testes</button><button class="btn sm" data-deliver="proof">${IC.camera} Prova (prints)</button></div>`+
    `<div class="dim" style="font-size:10.5px;margin-top:5px">Um agente lê o código já pronto e gera os artefatos — aparecem na seção <b>Artefatos</b> aqui do Briefing (clique pra abrir).</div>`;
}
async function rerunTask(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!await askYes(`Re-rodar "${t?t.title:taskId}" do zero?\n\nDescarta o trabalho parcial na worktree (reset pra base) e roda o time inteiro de novo. O plano/spec são mantidos.`)) return;
  try{ await invoke("rerun_task",{taskId}); lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao re-rodar:\n"+e); }
}

const LANE_COLORS = ["#39d46a","#e5c07b","#56b6c2","#ff6b5f","#b48ead","#5b9dff","#d19a66","#8dd17a"];
function parseRefs(refs){
  return refs ? refs.split(",").map(s=>s.trim().replace(/^HEAD -> /,"").replace(/^tag: /,"")).filter(Boolean) : [];
}
