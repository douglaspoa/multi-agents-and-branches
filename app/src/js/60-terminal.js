// ===== MODO TERMINAL — o CLI oficial (claude/codex) da tarefa num terminal de verdade (xterm.js local) =====
// Gancho MÍNIMO de UI (o layout final está sendo decidido): na tarefa em modo terminal, a área da Conversa
// mostra o terminal e o composer de sempre (anexos, "/" skills, "vira requisito", pílula do modelo) fica embaixo
// — o envio passa pelo talk_task, que no Rust vai pra sessão (fila quando ocupada; ⌘Enter = Esc e manda).
// Desempenho: um xterm por tarefa, criado na 1ª vez que aparece e REAPROVEITADO (o DOM dele é movido pro slot
// a cada render); só recebe eventos enquanto está visível (term_attach/term_detach) e o PTY só é redimensionado
// quando o tamanho muda (ResizeObserver).
const TERM = {}; // taskId → { term, fit, host, attached, alive, ro, lastSize, opening }
function termModeOf(t){ return !!(t && t.spec && t.spec.termMode === 'terminal'); }
function termSlotHtml(t){ return `<div class="fwthread fwtermslot" id="fwThread" data-term="${escA(t.id)}"></div>`; }
function termCss(name, fb){ try{ const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v||fb; }catch(_){ return fb; } }
// tema a partir dos tokens do app (mesmo fundo/texto/acento da tela)
function termTheme(){
  return { background:termCss('--surface-2','#0e1113'), foreground:termCss('--text','#e9edef'), cursor:termCss('--accent','#3fd68a'),
    cursorAccent:termCss('--surface-2','#0e1113'), selectionBackground:'rgba(63,214,138,.28)',
    black:'#1b2024', red:termCss('--crit','#f2685c'), green:termCss('--good','#3fd68a'), yellow:termCss('--warn','#f0b449'),
    blue:termCss('--info','#5b9df9'), magenta:termCss('--purple','#b47ce0'), cyan:termCss('--cyan','#4fc4c9'), white:termCss('--text-2','#c9d1d6'),
    brightBlack:termCss('--muted','#8b959b') };
}
function termCtor(){ const T=window.Terminal; return T && (T.Terminal||T); }
function termFitCtor(){ const F=window.FitAddon; return F && (F.FitAddon||F); }

function termEnsure(taskId){
  let st=TERM[taskId]; if(st) return st;
  const Term=termCtor(), Fit=termFitCtor();
  const host=document.createElement('div'); host.className='fwterm'; host.dataset.task=taskId;
  const bar=document.createElement('div'); bar.className='fwtermbar'; bar.style.display='none'; host.appendChild(bar);
  const box=document.createElement('div'); box.className='fwtermbox'; host.appendChild(box);
  st=TERM[taskId]={ term:null, fit:null, host, bar, box, attached:false, alive:false, ro:null, lastSize:'', opening:false };
  if(!Term){ box.textContent='terminal indisponível (xterm não carregou)'; return st; }
  const term=new Term({ fontFamily:termCss('--mono','ui-monospace, Menlo, monospace'), fontSize:12.5, lineHeight:1.15, cursorBlink:false,
    scrollback:5000, allowProposedApi:false, convertEol:false, macOptionIsMeta:true, theme:termTheme() });
  const fit=Fit?new Fit():null; if(fit) term.loadAddon(fit);
  term.open(box);
  term.onData(d=>{ if(st.alive) invokeQuiet('term_write',{ taskId, data:d }).catch(()=>{}); });
  st.term=term; st.fit=fit;
  // redimensiona o PTY só quando o tamanho REAL muda; tamanho zero = escondido → para os eventos
  st.ro=new ResizeObserver(()=>{ clearTimeout(st.rt); st.rt=setTimeout(()=>termFit(taskId), 60); });
  st.ro.observe(box);
  return st;
}
function termFit(taskId){
  const st=TERM[taskId]; if(!st||!st.term) return;
  const w=st.box.clientWidth, h=st.box.clientHeight;
  if(!w||!h||!st.host.isConnected){ termDetach(taskId); return; }
  if(!st.attached) termAttach(taskId);
  try{ st.fit && st.fit.fit(); }catch(_){ }
  const k=st.term.cols+'x'+st.term.rows;
  if(k!==st.lastSize){ st.lastSize=k; if(st.alive) invokeQuiet('term_resize',{ taskId, cols:st.term.cols, rows:st.term.rows }).catch(()=>{}); }
}
async function termAttach(taskId){
  const st=TERM[taskId]; if(!st||!st.term||st.attached) return;
  st.attached=true; st.pend=[]; // o que chegar ENQUANTO o retrato vem fica guardado e é escrito depois dele
  try{
    const info=await invokeQuiet('term_attach',{ taskId });
    st.term.reset(); if(info && info.data) st.term.write(info.data);
    const pend=st.pend; st.pend=null; for(const d of pend||[]) st.term.write(d);
    termSetAlive(taskId, !!(info && info.alive));
    if(st.alive && st.term.cols) invokeQuiet('term_resize',{ taskId, cols:st.term.cols, rows:st.term.rows }).catch(()=>{});
  }catch(e){ st.attached=false; st.pend=null; console.error('term_attach', e); }
}
function termDetach(taskId){
  const st=TERM[taskId]; if(!st||!st.attached) return;
  st.attached=false; invokeQuiet('term_detach',{ taskId }).catch(()=>{});
}
function termSetAlive(taskId, alive){
  const st=TERM[taskId]; if(!st) return; st.alive=alive;
  const t=(state.tasks||[]).find(x=>x.id===taskId);
  if(alive){ st.bar.style.display='none'; st.bar.innerHTML=''; return; }
  const fresh=t && (t.status==='draft' || t.status==='queued');
  st.bar.style.display='flex';
  st.bar.innerHTML=`<span>${fresh?'o terminal desta tarefa ainda não foi aberto':'terminal fechado — o histórico acima ficou salvo'}</span><span class="cc-sp"></span>`+
    `<button class="btn sm primary" data-termopen="${escA(taskId)}">${fresh?'abrir terminal':'retomar sessão'}</button>`;
}
async function termOpen(taskId){
  const st=termEnsure(taskId); if(st.opening) return; st.opening=true;
  const b=st.bar.querySelector('[data-termopen]'); if(b){ b.disabled=true; b.textContent='abrindo…'; }
  try{
    const cols=(st.term&&st.term.cols)||120, rows=(st.term&&st.term.rows)||34;
    const info=await invoke('term_open',{ taskId, cols, rows, resume:true });
    st.attached=true; st.pend=null; st.term.reset(); if(info && info.data) st.term.write(info.data);
    termSetAlive(taskId, !!(info && info.alive)); st.term.focus();
    lastSig=''; refresh().catch(()=>{});
  }catch(e){ showErr(e, 'Não consegui abrir o terminal'); termSetAlive(taskId, false); }
  finally{ st.opening=false; }
}
/** Chamado pelo render da tarefa: põe o terminal (já existente) no slot da Conversa e solta os que saíram da tela. */
function termMount(t){
  const slot=document.querySelector(`#fwThread[data-term="${CSS.escape(t.id)}"]`); if(!slot) return;
  const st=termEnsure(t.id);
  if(st.host.parentNode!==slot){ slot.innerHTML=''; slot.appendChild(st.host); }
  termSweep();
  requestAnimationFrame(()=>termFit(t.id));
}
/** Terminais que não estão mais na tela param de receber eventos (a sessão segue viva no app). */
function termSweep(){ for(const id in TERM){ if(!TERM[id].host.isConnected) termDetach(id); } }

try{
  window.__TAURI__.event.listen('term-data', ev=>{ const p=ev&&ev.payload; const st=p&&TERM[p.taskId]; if(!st||!st.attached||!st.term) return; if(st.pend) st.pend.push(p.data); else st.term.write(p.data); });
  window.__TAURI__.event.listen('term-exit', ev=>{ const p=ev&&ev.payload; if(!p) return; termSetAlive(p.taskId, false); lastSig=''; refresh().catch(()=>{}); });
}catch(_){ }
document.addEventListener('visibilitychange', ()=>{ for(const id in TERM){ if(document.hidden) termDetach(id); else if(TERM[id].host.isConnected) termFit(id); } });
document.addEventListener('click', (e)=>{ const b=e.target.closest&&e.target.closest('[data-termopen]'); if(!b) return; e.stopPropagation(); termOpen(b.dataset.termopen); });
