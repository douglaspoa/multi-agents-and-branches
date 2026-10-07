// Starfork — 70-loop: DETECTOR DE LOOP na tela. A regra mora no motor (src/loop-detect.ts: a mesma falha 3× sem
// nenhuma mudança de arquivo no meio); ele grava o aviso na tabela loop_state e o snapshot traz em `t.loop` — aqui só
// se LÊ (taskLoop, 00-util). Sem polling novo: o aviso pinta na faixa do ciclo (#fwCiclo, 60-ciclo — em cima do terminal e
// da Conversa) e a notificação/pausa saem do detectNotifs (10-core), no refresh que já existe.
// Ações: Dar uma dica (compositor com o começo) · Pedir revisão (tiSend: o caminho dos botões do terminal integrado;
// no automático vira talk_task) · Parar (o stopTask de sempre). Pausa automática: Ajustes › Como as tarefas rodam.

// @loop-puro-inicio (testado em app/tests/loop.test.mjs — sem DOM)
const LOOP_HINT='Pare e tente outra abordagem: ';
const LOOP_REVIEW_MSG='Pare um instante: você está repetindo a mesma tentativa e ela continua dando o mesmo resultado. Antes de continuar, resuma em poucas linhas o que já tentou e por que não funcionou, e proponha uma abordagem diferente. Não repita o mesmo comando nem a mesma edição até explicar o que muda.';
function loopTitle(l){ return 'A IA está repetindo o mesmo erro ('+((l&&+l.n)||3)+'×)'; }
// a frase da falha com `comando` em código (escapada antes)
function loopWhatHtml(what){ return esc(String(what||'')).replace(/`([^`]+)`/g, '<code>$1</code>'); }
function loopWorking(t){ return !!t && (ACTIVE_ST.has(t.status) || t.status==='thinking' || !!t.busy); }
function loopBannerHtml(t){
  const l=taskLoop(t); if(!l) return '';
  const x=(typeof IC!=='undefined'&&IC.x)||'×';
  return `<section class="cicdec loopdec" id="loopDec" role="status" aria-label="${escA(loopTitle(l))}">`
    +`<div class="cicdec-h"><span class="cicdec-dot" aria-hidden="true"></span><b>${esc(loopTitle(l))}</b><span class="cicdec-k">precisa de você</span>`
    +`<button type="button" class="btn icon quiet loopx" data-loop="dismiss" title="Dispensar o aviso (a IA segue como está)" aria-label="Dispensar o aviso">${x}</button></div>`
    +`<p class="cicdec-t">${loopWhatHtml(l.what)}</p>`
    +`<div class="cicdec-acts"><button type="button" class="btn sm cicdec-go" data-loop="hint">Dar uma dica</button>`
    +`<button type="button" class="btn sm" data-loop="review">Pedir revisão</button>`
    +(loopWorking(t)?`<button type="button" class="btn sm" data-loop="stop">Parar</button>`:'')+`</div></section>`;
}
// episódio NOVO = tarefa JÁ VISTA (como o prevStatus do detectNotifs) cujo aviso mudou e é RECENTE: a 1ª leitura, a
// troca de projeto e tarefa que aparece agora só aprendem — nunca notifica nem pausa aviso velho
const LOOP_FRESH_MS=10*60000;
function loopNews(seen, tasks, now){
  const out=[];
  for(const t of tasks||[]){ const l=taskLoop(t), had=Object.prototype.hasOwnProperty.call(seen, t.id), prev=seen[t.id]; seen[t.id]=l?l.at:0;
    if(had && l && prev!==l.at && (now||Date.now())-(+l.at||0)<LOOP_FRESH_MS) out.push(t); }
  return out;
}
// pausa automática (Ajustes): ligada, tarefa trabalhando e NÃO do piloto automático (o piloto só é avisado)
function loopShouldPause(t, on){ return !!on && loopWorking(t) && !(t.spec && t.spec.autopilot); }
// @loop-puro-fim

function loopPauseOn(){ return lsGet('loopPause')==='1'; }
const LOOP_SEEN={};
/** detectNotifs (10-core, só a janela principal): notificação do episódio novo e, com a opção ligada, a pausa. */
function loopWatch(tasks){
  for(const t of loopNews(LOOP_SEEN, tasks, Date.now())){
    const l=taskLoop(t);
    if(typeof pushNotif==='function') pushNotif(loopTitle(l), (t.title||'')+' — '+String(l.what||'').replace(/`/g,''), t.id);
    if(loopShouldPause(t, loopPauseOn())) loopPause(t);
  }
}
async function loopPause(t){
  if(typeof budgetQuiet!=='undefined') budgetQuiet.add(t.id); // parada não é "pronta pra revisar"
  try{ await invoke('stop_task',{ taskId:t.id, keepLoop:true }); toast('Pausei “'+(t.title||'a tarefa')+'”: a IA estava repetindo o mesmo erro. O aviso está na tarefa.','warn'); lastSig=''; refresh().catch(()=>{}); }
  catch(e){ showErr(e, 'Não consegui pausar a tarefa que está repetindo o erro'); }
}
// o aviso mora na tabela loop_state do motor (não no spec): dispensar apaga a linha (lib.rs loop_clear)
async function loopClear(t){ await invoke('loop_clear',{ taskId:t.id }); lastSig=''; refresh().catch(()=>{}); }
function loopHint(t){
  const i1=$id('fwInput'), cur=String((i1 && i1.dataset.tk===t.id)?i1.value:(fwDraft[t.id]||''));
  fwDraft[t.id]=cur.startsWith(LOOP_HINT)?cur:LOOP_HINT+cur;
  { const i0=$id('fwInput'); if(i0 && i0.dataset.tk===t.id) i0.value=fwDraft[t.id]; } // o re-render copia o campo pro rascunho
  const show=(typeof fwInputShow==='function')?fwInputShow:(()=>$id('fwInput'));
  show();
  setTimeout(()=>{ const i=$id('fwInput'); if(!i) return; if(i.value!==fwDraft[t.id]) i.value=fwDraft[t.id]; i.focus(); try{ const n=LOOP_HINT.length; i.setSelectionRange(n, n); }catch(_){ } }, 0);
}
async function loopAct(t, k, btn){
  if(k==='hint'){ loopHint(t); return; }
  const bs=[...document.querySelectorAll('#loopDec button')]; bs.forEach(b=>b.disabled=true);
  try{
    if(k==='review'){ const ok=(typeof tiSend==='function')?await tiSend(t.id, LOOP_REVIEW_MSG, { interrupt:true }):await fwSendText(t.id, LOOP_REVIEW_MSG); if(ok) await loopClear(t); }
    else if(k==='stop') await stopTask(t.id); // stop_task (lib.rs) já zera o detector
    else if(k==='dismiss') await loopClear(t);
  }catch(e){ showErr(e, 'Não deu certo'); }
  finally{ bs.forEach(b=>{ if(b.isConnected) b.disabled=false; }); }
}
// aba da tarefa aberta (fwLiveUpdate): o aviso entrou, saiu ou o "Parar" mudou → repinta a faixa do ciclo (que tem a
// própria assinatura); nada mudou → não toca no DOM
function loopLivePaint(t){
  const host=$id('fwCiclo'); if(!host || typeof cicloPaint!=='function') return;
  const l=taskLoop(t), k=t.id+'|'+(l?l.at:0)+'|'+(l&&loopWorking(t)?1:0);
  if(host.__loopK===k) return; host.__loopK=k; cicloPaint(t);
}
function loopWire(host, t){ host.querySelectorAll('#loopDec [data-loop]').forEach(b=>b.onclick=()=>loopAct(t, b.dataset.loop, b)); }
