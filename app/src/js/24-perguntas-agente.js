// Starfork — 24-perguntas-agente
// ---------- pergunta do agente: responde-se inline na tela da tarefa (o modal antigo saiu) ----------
// pergunta do agente SEM modal: abre a tela de execução — a pergunta está inline
// na conversa, com os botões de opção e o input no mesmo lugar de sempre
function openAsk(pendingId){
  const p=(state.pending||[]).find(x=>x.id===pendingId); if(!p) return;
  const tid=p.taskId; if(!tid) return;
  selected=tid; render();
  // a pergunta e o campo de resposta moram na CONVERSA: a aba lembrava o último modo (Entrega/PR/Código)
  // e reabria com a pergunta escondida
  { const tab=(typeof tabById==='function')?tabById('task:'+tid):null; if(tab) tab.mode='conversa'; }
  if(typeof fwTask!=='undefined' && fwTask===tid && typeof fwMode!=='undefined' && fwMode!=='conversa'){ fwMode='conversa'; }
  openWorkspace(tid);
  setTimeout(()=>{ const t=(state.tasks||[]).find(x=>x.id===tid); if(t && typeof termViewOf==='function' && termViewOf(t) && typeof fwAskFix==='function'){ fwAskFix(); return; } const i=$id('fwInput'); if(i) i.focus(); }, 350);
}
// rascunho: clicar EDITA — reabre a Nova demanda preenchida; ao salvar/iniciar,
// o rascunho antigo é substituído (remove_task + criação nova)
let ntEditingDraft=null;
async function editDraft(t){
  if(!await ntOpenFormTab()) return; // abre a Nova demanda como ABA própria e limpa
  setNtMode('build');
  ntEditingDraft=t.id;
  $id('ntTitle').value=t.title||'';
  $id('ntObj').value=t.objective||'';
  ntDel=Array.isArray(t.deliverables)?t.deliverables.slice():[];
  ntReq=Array.isArray(t.requirements)?t.requirements.slice():[];
  ntRefs=Array.isArray(t.refs)?t.refs.slice():[];
  if(t.base) $id('ntBase').value=t.base;
  // motor E modelo do rascunho (setSelValue: id completo fora da lista virava "" e caía no padrão)
  if(t.engine) setSelValue($id('ntEngine'), t.engine);
  setSelValue($id('ntModel'), t.model||'');
  { const hm=$id('howModel'); if(hm) setSelValue(hm, t.model||''); }
  if(typeof aiPickRender==='function') aiPickRender();
  renderNtList('ntDeliverables',ntDel); renderNtList('ntRequirements',ntReq); renderNtRefs();
  wizN=1; if(typeof wizRender==='function') wizRender();
  ntGate();
}
const startingTasks=new Set();
async function startTask(taskId){
  // duplo clique em ▶ / "aprovar plano" subia dois times na mesma worktree: um pedido por vez
  if(startingTasks.has(taskId)) return;
  // slots: aviso leve quando já há muita coisa em paralelo (não bloqueia).
  const live = state.tasks.filter(x=>ACTIVE_ST.has(x.status)||x.status==='paused').length;
  if(live>=slotMax && !await askYes(`Já há ${live} execuções em andamento (limite ${slotMax}).\nIniciar mesmo assim?`)) return;
  startingTasks.add(taskId);
  document.querySelectorAll(`[data-rowplay="${CSS.escape(taskId)}"], #fwApprovePlan`).forEach(b=>{ b.disabled=true; });
  try{ await invoke("start_task",{taskId}); lastSig=""; await refresh(); }
  catch(e){ if(/já está rodando/.test(String(e))) toast('Essa tarefa já está rodando','info'); else showErr(e, 'Falha ao iniciar'); }
  finally{ startingTasks.delete(taskId); }
}
async function pauseTask(taskId){
  try{ await invoke("pause_task",{taskId}); await refresh(); }
  catch(e){ showErr(e, 'Falha ao pausar'); }
}
async function resumeTask(taskId){
  try{ await invoke("resume_task",{taskId}); lastSig=""; await refresh(); }
  catch(e){ showErr(e, 'Falha ao retomar'); }
}
async function abortTask(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!await askYes(`Interromper a tarefa de ${t?t.agent:'agente'}?\nO processo do agente é encerrado; a branch/worktree é preservada pra inspeção.`)) return;
  try{ await invoke("abort_task",{taskId}); await refresh(); }
  catch(e){ showErr(e, 'Falha ao abortar'); }
}
async function talkTask(taskId, message){
  const m=(message||'').trim(); if(!m) return;
  try{ await invoke("talk_task",{ taskId, message:m }); artifactsCache[taskId]=undefined; reqProofCache[taskId]=undefined; commitsCache[taskId]=undefined; prCache[taskId]=undefined; lastSig=""; refresh().catch(()=>{}); }
  catch(e){ showErr(e, 'Falha ao conversar'); }
}
async function stopTask(taskId){
  if(typeof budgetQuiet!=='undefined') budgetQuiet.add(taskId); // parar ≠ "pronta pra revisar" (sem notificação falsa)
  // refresh SEM await: com o banco ocupado ele podia levar até 8s e o "parar e enviar" do chat esperava junto
  try{ await invoke("stop_task",{ taskId }); lastSig=""; refresh().catch(()=>{}); }
  catch(e){ showErr(e, 'Falha ao parar'); }
}
// openChat: o "chat" da tarefa agora é o próprio workspace (colunas fw*)
function openChat(taskId){ /* chat agora É o workspace estilo Cursor (arquivos + requisitos + conversa) */ openWorkspace(taskId); setTimeout(()=>{ if(typeof fwFocusTalk==='function'){ fwFocusTalk(); return; } const i=$id('fwInput'); if(i) i.focus(); },250); }
async function rerunTask(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!await askYes(`Re-rodar "${t?t.title:taskId}" do zero?\n\nDescarta o trabalho parcial na worktree (reset pra base) e roda o time inteiro de novo. O plano/spec são mantidos.`)) return;
  try{ await invoke("rerun_task",{taskId}); lastSig=""; await refresh(); }
  catch(e){ showErr(e, 'Falha ao re-rodar'); }
}
// E9 (bug #19): "voltar pra em andamento" só trocava o status → card "rodando" pra sempre, sem processo nenhum.
// Agora é de verdade: o agente retoma a MESMA sessão e continua de onde parou (com custo — por isso pergunta).
// Devolve true se mandou; erro sobe pra quem chamou mostrar (showErr).
async function taskBackToRunning(taskId){
  const t=(state.tasks||[]).find(x=>x.id===taskId);
  if(!await askYes(`Voltar "${t?t.title:'esta tarefa'}" pra em andamento?\n\nO agente retoma a mesma conversa e continua de onde parou (isso usa a IA e tem custo). Se você só quer reabrir a tarefa sem rodar nada, use "reabrir".`)) return false;
  await invoke('talk_task',{ taskId, message:'A tarefa voltou pra "em andamento". CONTINUE de onde você parou: confira git status, git diff e os requisitos em .cardume/TASK.yaml e finalize o que falta — não recomece do zero.', asReq:false, agent:null });
  commitsCache[taskId]=undefined; prCache[taskId]=undefined; lastSig='';
  toast('O agente voltou a trabalhar nesta tarefa','ok');
  return true;
}

const LANE_COLORS = ["var(--chart-1)","var(--chart-3)","var(--chart-6)","var(--chart-5)","var(--chart-7)","var(--chart-2)","var(--chart-8)","var(--chart-4)"];
function parseRefs(refs){
  return refs ? refs.split(",").map(s=>s.trim().replace(/^HEAD -> /,"").replace(/^tag: /,"")).filter(Boolean) : [];
}
