// ===== MODO TERMINAL — o CLI oficial (claude/codex) da tarefa num terminal de verdade (xterm.js local) =====
// A aba "Terminal" SUBSTITUI a Conversa em toda tarefa de motor Claude Code (e nas de modo terminal do Codex):
//  - sessão VIVA (PTY aberto): o xterm é o terminal de verdade (term_attach/term-data);
//  - tarefa PARADA (concluída, pra revisar, antiga/headless): o xterm mostra o HISTÓRICO da sessão — o transcript do
//    Claude Code (term_history, lido no Rust fora da UI), senão o log do PTY, senão os eventos do state.sqlite —
//    pintado na gramática do mock (● fala · ⎿ ferramenta · > você), sem PTY. Mandar algo pelo compositor RETOMA a
//    sessão (`claude --resume <sessão>` no PTY, talk_task → term::route) e o xterm passa a ser o vivo;
//  - DeepSeek/gateway/Codex headless seguem com a Conversa.
// Desempenho: um xterm por tarefa, criado na 1ª vez que aparece e REAPROVEITADO (o DOM é movido pro slot a cada
// render); só recebe eventos enquanto está visível (term_attach/term_detach); o histórico só é relido quando o
// arquivo muda (carimbo tamanho:mtime) e o PTY só é redimensionado quando o tamanho muda (ResizeObserver).
const TERM = {}; // taskId → { term, fit, host, attached, alive, mode:'live'|'hist', hinfo, hstamp, ro, lastSize, opening }
function termModeOf(t){ return !!(t && t.spec && t.spec.termMode === 'terminal'); }
/** A tarefa mostra a aba Terminal (e não a Conversa)? Modo terminal sempre; senão toda tarefa Claude Code que já rodou. */
function termViewOf(t){
  if(!t) return false;
  if(termModeOf(t)) return true;
  if((typeof state!=='undefined' && state.remote) || t.status==='draft') return false;
  return typeof aiEngineOf==='function' && aiEngineOf(t.engine)==='claude';
}
function termSlotHtml(t){ return `<div class="fwthread fwtermslot" id="fwThread" data-term="${escA(t.id)}"></div>`; }
function termCss(name, fb){ try{ const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v||fb; }catch(_){ return fb; } }
// tema a partir dos tokens do app (mesmo fundo/texto/acento da tela)
function termTheme(){
  return { background:termCss('--surface-2','#0e1113'), foreground:termCss('--text','#e9edef'), cursor:termCss('--accent','#3fd68a'),
    cursorAccent:termCss('--surface-2','#0e1113'), selectionBackground:'rgba(63,214,138,.28)',
    black:'#1b2024', red:termCss('--crit','#f2685c'), green:termCss('--good','#3fd68a'), yellow:termCss('--warn','#f0b449'),
    blue:termCss('--info','#5b9df9'), magenta:termCss('--purple','#b47ce0'), cyan:termCss('--cyan','#4fc4c9'), white:termCss('--text-2','#c9d1d6'),
    brightBlack:termCss('--muted','#8b959b'), brightWhite:termCss('--text','#e9edef') };
}
function termCtor(){ const T=window.Terminal; return T && (T.Terminal||T); }
function termFitCtor(){ const F=window.FitAddon; return F && (F.FitAddon||F); }

// @term-hist-puro-inicio (puro — testado em app/tests/terminal-sempre.test.mjs)
// Histórico → texto ANSI na gramática do mock: "> você", "● fala", "  ⎿ Ferramenta arg", "● Update(arq) +N −M".
const TH_MAX_LINES={ you:6, say:40, ask:4 };
const thC=(code, s)=>'\x1b['+code+'m'+s+'\x1b[0m';
// nada do transcript pode virar sequência de controle no xterm (cor, cursor, título, colagem)
function thClean(s){ return String(s==null?'':s).replace(/\r\n?/g,'\n').replace(/\t/g,'  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,''); }
function thMd(s){ return s.replace(/^#{1,6}\s+(.*)$/, (_,x)=>thC('1',x)).replace(/\*\*([^*]+)\*\*/g, (_,x)=>thC('1',x)).replace(/`([^`\n]+)`/g, (_,x)=>thC('36',x)); }
function thBlock(text, max, first, rest, md){
  const L=thClean(text).split('\n'); while(L.length && !L[L.length-1].trim()) L.pop();
  const keep=L.slice(0, max), more=L.length-keep.length;
  const out=keep.map((l,i)=>(i?rest:first)+(md?thMd(l):l));
  if(more>0) out.push(rest+thC('2','… +'+more+' linha'+(more>1?'s':'')));
  return out;
}
function thToolArg(it){
  const a=thClean(it.arg||'').replace(/\n/g,' ');
  if(!a) return '';
  const color=/^(Bash|WebSearch)$/.test(it.name)?'33':/^(Read|Grep|Glob|mcp|Agent)$/.test(it.name)?'34':'0';
  return ' '+(color==='0'?a:thC(color,a));
}
function thItemLines(it){
  const out=thClean(it.out||'').replace(/\n/g,' ');
  switch(it.k){
    case 'you': return thBlock(it.text, TH_MAX_LINES.you, thC('1;97','> '), '  ', false);
    case 'say': return thBlock(it.text, TH_MAX_LINES.say, thC('32','● '), '  ', true);
    case 'edit': return [thC('32','● ')+thC('1;97', it.name||'Update')+'('+thC('34', thClean(it.arg))+')'+(it.add?'  '+thC('32','+'+it.add):'')+(it.del?' '+thC('31','−'+it.del):'')+(it.err?'  '+thC('31','✗ '+out):'')];
    case 'tool': {
      const meta=it.err?'  '+thC('31','✗ '+(out||'falhou')) : (it.name==='Read' && it.lines)?' '+thC('2','('+it.lines+' linhas)') : out?'  '+thC('2',out) : '';
      return ['  '+thC('2','⎿ '+(it.name||''))+thToolArg(it)+meta];
    }
    case 'ask': { const L=thBlock(it.text, TH_MAX_LINES.ask, thC('33','? '), '  ', false);
      L.push(it.done ? '  '+thC('32','✓ respondido: ')+out.replace(/^User (has )?answered[^:]*:\s*/i,'') : '  '+thC('2','aguardando sua resposta…')); return L; }
    case 'note': return thBlock(it.text, 3, thC('36','▸ '), '  ', false).map((l,i)=>i?thC('2',l):l);
    case 'err': return thBlock(it.text, 4, thC('31','✗ '), '  ', false);
    case 'sys': return [thC('2','── '+thClean(it.text)+' ──')];
    default: return [];
  }
}
// eventos do state.sqlite (tarefa sem transcript) → os mesmos itens
function thTs(e){ const v=e&&e.ts; return typeof v==='number'?v:(Date.parse(v||'')||0); }
function thFromEvents(evs){
  const out=[];
  for(const e of evs||[]){
    const tx=String(e.text||''); const ts=thTs(e);
    if(!tx.trim() || e.type==='papel') continue;
    if(e.agent==='Você' && /^Você:\s/.test(tx)){ out.push({ k:'you', ts, text:tx.replace(/^Você:\s*/,'') }); continue; }
    if(/^humano respondeu:/.test(tx)){ out.push({ k:'you', ts, text:tx.replace(/^humano respondeu:\s*/,'') }); continue; }
    if(e.agent==='Sistema'){ out.push({ k:'note', ts, text:tx }); continue; }
    if(e.type==='error'){ out.push({ k:'err', ts, text:tx }); continue; }
    if(e.type==='edit'||e.type==='write'){ out.push({ k:'edit', ts, name:e.type==='write'?'Write':'Update', arg:tx }); continue; }
    if(e.type==='read'){ out.push({ k:'tool', ts, name:'Read', arg:tx }); continue; }
    if(e.type==='bash'){ out.push({ k:'tool', ts, name:'Bash', arg:tx }); continue; }
    if(/^perguntou ao humano:/.test(tx)){ out.push({ k:'ask', ts, text:tx.replace(/^perguntou ao humano:\s*/,''), done:true, out:'' }); continue; }
    if(['think','note','done'].includes(e.type)){ out.push({ k:'say', ts, text:tx }); continue; }
  }
  return out;
}
// notas do Starfork que entram no meio do transcript (PR aberto, fila, requisito, sessão retomada…)
function thSysNotes(evs){
  return (evs||[]).filter(e=>{ const tx=String(e.text||''); return tx.trim() && ((e.agent==='Sistema' && (e.type==='note'||e.type==='status')) || /^(PR aberto|PR NÃO aberto|requisito adicionado:|falha ao finalizar)/i.test(tx)); })
    .map(e=>({ k:'note', ts:thTs(e), text:String(e.text) }));
}
/** itens (+ notas do sistema intercaladas pelo horário) → texto pro xterm. o: { head, foot, notes } */
function thRender(items, o){
  o=o||{}; const notes=(o.notes||[]).slice().sort((a,b)=>a.ts-b.ts); let ni=0;
  const L=[]; if(o.head) L.push(thC('2','╭─ '+thClean(o.head)), '');
  const flush=(upTo)=>{ while(ni<notes.length && (upTo==null || notes[ni].ts<=upTo)) L.push(...thItemLines(notes[ni++])); };
  let last=0;
  for(const it of items||[]){
    const ts=+it.ts||last; if(ts) { flush(ts); last=ts; }
    const lines=thItemLines(it); if(!lines.length) continue;
    // um respiro antes de cada fala/edição/pergunta (como o Claude Code); ferramentas ficam coladas na fala
    if(L.length && it.k!=='tool' && L[L.length-1]!=='') L.push('');
    L.push(...lines);
  }
  flush(null);
  if(!items || !items.length) L.push(thC('2','(a sessão ainda não tem nada registrado)'));
  if(o.foot) L.push('', thC('2','╰─ '+thClean(o.foot)));
  return L.join('\r\n')+'\r\n';
}
// @term-hist-puro-fim

function termEnsure(taskId){
  let st=TERM[taskId]; if(st) return st;
  const Term=termCtor(), Fit=termFitCtor();
  const host=document.createElement('div'); host.className='fwterm'; host.dataset.task=taskId;
  const bar=document.createElement('div'); bar.className='fwtermbar'; bar.style.display='none'; host.appendChild(bar);
  const box=document.createElement('div'); box.className='fwtermbox'; host.appendChild(box);
  st=TERM[taskId]={ term:null, fit:null, host, bar, box, attached:false, alive:false, mode:'', hinfo:null, hstamp:'', hsys:'', ro:null, lastSize:'', opening:false };
  if(!Term){ box.textContent='terminal indisponível (xterm não carregou)'; return st; }
  const term=new Term({ fontFamily:termCss('--mono','ui-monospace, Menlo, monospace'), fontSize:12.5, lineHeight:1.15, cursorBlink:false,
    scrollback:8000, allowProposedApi:false, convertEol:false, macOptionIsMeta:true, theme:termTheme() });
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
    if(info && info.alive){
      st.mode='live'; st.term.reset(); if(info.data) st.term.write(info.data);
      const pend=st.pend; st.pend=null; for(const d of pend||[]) st.term.write(d);
      termSetAlive(taskId, true);
      if(st.term.cols) invokeQuiet('term_resize',{ taskId, cols:st.term.cols, rows:st.term.rows }).catch(()=>{});
      return;
    }
    st.pend=null;
    const was=st.mode; st.mode='hist'; st.alive=false;
    await termHistLoad(taskId, was!=='hist');
  }catch(e){ st.attached=false; st.pend=null; console.error('term_attach', e); }
}
function termDetach(taskId){
  const st=TERM[taskId]; if(!st||!st.attached) return;
  st.attached=false; if(st.mode==='live') invokeQuiet('term_detach',{ taskId }).catch(()=>{});
}
function termEvents(taskId){ return (typeof fwTask!=='undefined' && fwTask===taskId && typeof fwEvents!=='undefined' && fwEvents.length) ? fwEvents : (typeof eventsOf==='function'?eventsOf(taskId):[]); }
/** Histórico da sessão (tarefa sem terminal vivo). force: repinta mesmo sem mudança (voltou do vivo, abriu agora). */
async function termHistLoad(taskId, force){
  const st=TERM[taskId]; if(!st||!st.term||st.mode!=='hist') return;
  if(st.hloading){ st.hagain=st.hagain||!!force; return; }
  st.hloading=true; st.hat=Date.now();
  try{
    const h=await invokeQuiet('term_history',{ taskId, since:force?null:(st.hstamp||null) });
    if(st.mode!=='hist') return;
    if(h && h.alive){ st.attached=false; st.hloading=false; termAttach(taskId); return; } // o PTY nasceu (retomada)
    const evs=termEvents(taskId);
    const sysSig=evs.length+':'+(evs.length?evs[evs.length-1].id:0);
    st.hinfo=h;
    if(!force && h.unchanged && sysSig===st.hsys){ termSetAlive(taskId, false); return; }
    st.hsys=sysSig; if(!h.unchanged) st.hstamp=h.stamp||'';
    if(h.unchanged && st.hitems===undefined){ st.hstamp=''; st.hloading=false; return termHistLoad(taskId, true); }
    if(!h.unchanged) st.hitems=h.source==='transcript'?h.items:null;
    const t=(state.tasks||[]).find(x=>x.id===taskId);
    const wt=String(h.worktree||(t&&t.worktree)||'').split('/').filter(Boolean).pop()||'';
    const eng=(t&&typeof aiEngineOf==='function')?aiEngineOf(t.engine):'claude';
    const head=`${eng} · ${h.sessionId?'sessão '+String(h.sessionId).slice(0,8):'sem sessão gravada'}${wt?' · worktree '+wt:''} · histórico${h.source==='transcript'?'':h.source==='log'?' (log do terminal)':' (eventos da tarefa)'}`;
    const foot=termGone(h)?'a worktree foi apagada ao integrar — pra mexer de novo, abra uma tarefa nova de ajuste':termHeadless(t)?'rodando em segundo plano — o histórico se atualiza sozinho':'fim do histórico · mande uma mensagem pelo compositor pra retomar esta sessão no terminal';
    let out;
    if(h.source==='log') out=String(h.raw||'')+'\x1b[0m\r\n\r\n'+thC('2','╰─ '+foot)+'\r\n';
    else out=thRender(st.hitems||thFromEvents(evs), { head, foot, notes:st.hitems?thSysNotes(evs):[] });
    const b=st.term.buffer&&st.term.buffer.active; const atEnd=!b || force || b.viewportY>=b.baseY-1;
    st.term.reset(); st.term.write(out, ()=>{ if(atEnd) try{ st.term.scrollToBottom(); }catch(_){ } });
    termSetAlive(taskId, false);
  }catch(e){ console.error('term_history', e); try{ st.term.write('\r\n'+thC('31','não consegui ler o histórico desta sessão: '+thClean(typeof errShort==='function'?errShort(e):String(e)))+'\r\n'); }catch(_){ } }
  finally{ st.hloading=false; if(st.hagain){ const f=st.hagain; st.hagain=false; termHistLoad(taskId, f); } }
}
/** Poll do workspace (fwLiveUpdate): no histórico de uma tarefa rodando em segundo plano, relê quando o arquivo muda. */
function termHistTick(t){
  const st=t&&TERM[t.id]; if(!st||st.mode!=='hist'||!st.attached||st.hloading) return;
  const evs=termEvents(t.id); const sysSig=evs.length+':'+(evs.length?evs[evs.length-1].id:0);
  const due=termHeadless(t) ? Date.now()-(st.hat||0)>2500 : sysSig!==st.hsys;
  if(due) termHistLoad(t.id, false);
}
function termHeadless(t){ return !!t && !termModeOf(t) && (ACTIVE_ST.has(t.status)||t.status==='thinking'||!!t.busy); }
function termGone(h){ return !!(h && h.merged && !h.worktreeExists); }
/** A worktree desta tarefa foi apagada ao integrar? (então não há sessão pra retomar) */
function termWtGone(taskId){ const st=TERM[taskId]; return !!(st && st.mode==='hist' && termGone(st.hinfo)); }
/** Uma linha no próprio terminal (aviso do app, não do agente). */
function termSayLine(taskId, text, code){ const st=TERM[taskId]; if(st&&st.term) try{ st.term.write('\r\n'+thC(code||'33','! '+thClean(text))+'\r\n'); st.term.scrollToBottom(); }catch(_){ } }
/** Depois de mandar pelo compositor: se o PTY nasceu (retomada), o xterm passa a ser o vivo. */
function termGoLive(taskId){ const st=TERM[taskId]; if(!st||st.mode==='live') return; st.attached=false; if(st.host.isConnected) termAttach(taskId); }
function termSetAlive(taskId, alive){
  const st=TERM[taskId]; if(!st) return; st.alive=alive;
  if(alive){ st.mode='live'; st.bar.style.display='none'; st.bar.innerHTML=''; st.bar.__html=''; return; }
  const t=(state.tasks||[]).find(x=>x.id===taskId); const h=st.hinfo||{};
  const fresh=t && (t.status==='draft' || t.status==='queued') && (!h.source || h.source==='none');
  let html;
  if(termGone(h)) html=`<span>integrada · a worktree foi apagada ao integrar — pra mexer de novo, abra uma tarefa nova de ajuste</span><span class="cc-sp"></span><button class="btn sm primary" data-termfix="${escA(taskId)}">abrir tarefa de ajuste</button>`;
  else if(termHeadless(t)) html=`<span><span class="pulse" style="--pc:var(--good)"></span> rodando em segundo plano (modo automático) · o histórico se atualiza sozinho</span><span class="cc-sp"></span>`;
  else if(fresh) html=`<span>o terminal desta tarefa ainda não foi aberto</span><span class="cc-sp"></span><button class="btn sm primary" data-termopen="${escA(taskId)}">abrir terminal</button>`;
  else html=`<span>histórico da sessão · mande uma mensagem pelo compositor pra retomar no terminal</span><span class="cc-sp"></span><button class="btn sm" data-termopen="${escA(taskId)}" title="abre o terminal retomando a sessão, sem mandar nada">retomar sessão</button>`;
  st.bar.style.display='flex';
  if(st.bar.__html!==html){ st.bar.__html=html; st.bar.innerHTML=html; }
}
async function termOpen(taskId){
  const st=termEnsure(taskId); if(st.opening) return; st.opening=true;
  const b=st.bar.querySelector('[data-termopen]'); if(b){ b.disabled=true; b.textContent='abrindo…'; }
  try{
    const cols=(st.term&&st.term.cols)||120, rows=(st.term&&st.term.rows)||34;
    const info=await invoke('term_open',{ taskId, cols, rows, resume:true });
    st.attached=true; st.pend=null; st.mode='live'; st.term.reset(); if(info && info.data) st.term.write(info.data);
    termSetAlive(taskId, !!(info && info.alive)); st.term.focus();
    lastSig=''; refresh().catch(()=>{});
  }catch(e){ showErr(e, 'Não consegui abrir o terminal'); termSetAlive(taskId, false); }
  finally{ st.opening=false; }
}
/** Chamado pelo render da tarefa: põe o terminal (já existente) no slot e solta os que saíram da tela. */
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
  window.__TAURI__.event.listen('term-data', ev=>{ const p=ev&&ev.payload; const st=p&&TERM[p.taskId]; if(!st||!st.attached||!st.term||st.mode==='hist') return; if(st.pend) st.pend.push(p.data); else st.term.write(p.data); });
  // terminal fechou: o xterm vira o histórico da sessão (o transcript já tem o último turno)
  window.__TAURI__.event.listen('term-exit', ev=>{ const p=ev&&ev.payload; if(!p) return; const st=TERM[p.taskId];
    if(st){ st.alive=false; st.mode='hist'; st.hstamp=''; if(st.attached) termHistLoad(p.taskId, true); }
    lastSig=''; refresh().catch(()=>{}); });
}catch(_){ }
document.addEventListener('visibilitychange', ()=>{ for(const id in TERM){ if(document.hidden) termDetach(id); else if(TERM[id].host.isConnected) termFit(id); } });
document.addEventListener('click', (e)=>{
  const b=e.target.closest&&e.target.closest('[data-termopen],[data-termfix]'); if(!b) return; e.stopPropagation();
  if(b.dataset.termopen){ termOpen(b.dataset.termopen); return; }
  const t=(state.tasks||[]).find(x=>x.id===b.dataset.termfix); if(t && typeof openLinkedFix==='function') openLinkedFix(t);
});
