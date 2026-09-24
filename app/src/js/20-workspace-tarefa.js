// Constellation — 20-workspace-tarefa
// ---------- workspace 3 colunas (arquivos · código · chat do agente) ----------
let fwWhyCache={}, fwWhyOpen=false;
let fwTask=null, fwPath=null, fwContent='', fwAdded=[], fwSelA=0, fwSelB=0, fwFiles=[], fwEditing=false, fwDrag=false;
let fwEvents=[], fwEvLast=0, fwFetching=false; // conversa com texto COMPLETO (incremental)
let fwAgentSel=null; // com quem estou falando (null = agente padrão da tarefa)
const fwChat={}; // taskId -> [{who:'you'|'sys', text}]
const fwCollapsed=new Set(); // pastas recolhidas na árvore
// pinta a seleção de linhas durante o arraste sem re-render completo (leve)
function fwPaintSel(){
  const sel=fwSelRange(); const code=$id('fwCode'); if(!code) return;
  code.querySelectorAll('.fwln').forEach(el=>{ const n=+el.dataset.ln; el.classList.toggle('sel', !!(sel&&n>=sel.a&&n<=sel.b)); });
  const bar=document.querySelector('.fwselbar'); const t=fwTaskObj();
  if(bar) bar.innerHTML = sel?`<b>linhas ${sel.a}${sel.b>sel.a?'–'+sel.b:''} selecionadas</b> · pergunte ao ${esc(t?t.agent:'agente')} no chat →`:'clique e <b>arraste</b> pra selecionar várias linhas (ou shift+clique) e pergunte no chat';
}
async function fwSaveFile(){
  const ta=$id('fwText'); if(!ta) return; const v=ta.value; const b=$id('fwSave'); if(b) b.disabled=true;
  try{ await invoke('write_file',{ taskId:fwTask, path:fwPath, content:v }); fwContent=v; fwEditing=false; fileCache[fwTask]=undefined; lastSig=''; await refresh(); }
  catch(e){ alert('Falha ao salvar:\n'+e); }
  renderWorkspace();
}
window.addEventListener('mouseup', ()=>{ if(fwDrag){ fwDrag=false; renderWorkspace(); } });
function fwTaskObj(){ return (state.tasks||[]).find(t=>t.id===fwTask); }
let fwGroupMode='folder'; // 'folder' | 'deliverable'
function fwKeywords(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z0-9]+/).filter(w=>w.length>3); }
// agrupa arquivos por ENTREGÁVEL (vínculo heurístico por palavra-chave no caminho)
function fwGroupByDeliverable(files, dels){
  const norm=p=>String(p).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const groups=(dels||[]).map(d=>({label:d, kws:fwKeywords(d), files:[]}));
  const other={label:'outros arquivos', files:[], other:true};
  for(const f of files){ const np=norm(f.path); const hit=groups.filter(g=>g.kws.length&&g.kws.some(k=>np.includes(k))); if(hit.length) hit.forEach(g=>g.files.push(f)); else other.files.push(f); }
  return groups.filter(g=>g.files.length).concat(other.files.length?[other]:[]);
}
function fwDelivHtml(files, dels){
  const groups=fwGroupByDeliverable(files, dels);
  if(!groups.length) return '<div class="dim" style="padding:8px;font-size:11.5px">nenhum arquivo alterado</div>';
  return `<div class="fwtreebody">`+groups.map(g=>{
    const rows=g.files.slice().sort((a,b)=>a.path.localeCompare(b.path)).map(f=>{ const tag=f.doc?'·':((f.del===0&&f.add>0)?'A':'M');
      return `<button class="fwfile${f.path===fwPath?' on':''}" data-fwf="${escA(f.path)}" style="padding-left:20px"><span class="fwtag ${f.doc?'doc':(tag==='A'?'a':'m')}">${tag}</span><span class="fwfp mono">${esc(f.path.split('/').pop())}</span><span class="fwadd">+${f.add}</span></button>`;
    }).join('');
    return `<div class="fwdgrp${g.other?' other':''}"><span class="fwdmark">${g.other?'•':'✓'}</span><span class="fwdlabel">${esc(g.label)}</span><span class="fwdn">${g.files.length}</span></div>${rows}`;
  }).join('')+`</div>`;
}
function fwBuildTree(files){
  const root={dirs:{},files:[]};
  for(const f of files){ const parts=f.path.split('/'); let node=root;
    for(let i=0;i<parts.length-1;i++){ const d=parts[i]; node.dirs[d]=node.dirs[d]||{dirs:{},files:[],path:parts.slice(0,i+1).join('/')}; node=node.dirs[d]; }
    node.files.push(f); }
  return root;
}
function fwTreeHtml(node, depth){
  let h='';
  for(const d of Object.keys(node.dirs).sort()){ const dir=node.dirs[d]; const col=fwCollapsed.has(dir.path);
    h+=`<div class="fwdir" data-fwdir="${escA(dir.path)}" style="padding-left:${depth*13+8}px"><span class="fwchev">${col?'▸':'▾'}</span><span class="fwdname">${esc(d)}</span></div>`;
    if(!col) h+=fwTreeHtml(dir, depth+1);
  }
  for(const f of node.files.slice().sort((a,b)=>a.path.localeCompare(b.path))){ const tag=f.doc?'·':((f.del===0&&f.add>0)?'A':'M');
    h+=`<button class="fwfile${f.path===fwPath?' on':''}" data-fwf="${escA(f.path)}" style="padding-left:${depth*13+8}px"><span class="fwtag ${f.doc?'doc':(tag==='A'?'a':'m')}">${tag}</span><span class="fwfp mono">${esc(f.path.split('/').pop())}</span>${f.doc?'':`<span class="fwadd">+${f.add}</span>`}</button>`;
  }
  return h;
}
let fwMode='conversa';   // conversa | codigo | revisao | pr (modos da tela de execução)
let fwDiffCache={};      // taskId:path → texto do diff (tela de Revisão)
// abre a tarefa como ABA própria (uma por tarefa) — mantém o chrome do app
function openWorkspace(taskId, path){
  tabTaskPath=path||null;
  const id='task:'+taskId;
  const t=(state.tasks||[]).find(x=>x.id===taskId)||{};
  // cada aba lembra o PRÓPRIO arquivo e o PROJETO (antes: um tabTaskPath global — a aba B abria o arquivo da A,
  // e depois de trocar de projeto a aba velha abria uma tarefa que não existe no projeto atual)
  let tab=tabById(id); if(!tab){ tab={id, kind:'task', taskId, repo:state.repo, path:path||null, title:(t.title||'Tarefa').slice(0,26)}; TABS.push(tab); }
  else { if(t.title) tab.title=t.title.slice(0,26); tab.path=path||null; if(!tab.repo) tab.repo=state.repo; }
  activateTab(id);
}
async function fwOpenInner(taskId, path){
  fwTask=taskId; fwPath=path; fwSelA=0; fwSelB=0; fwContent=''; fwAdded=[]; fwEditing=false;
  fwFiles=[]; fwEvents=[]; fwEvLast=0; fwLiveSig=''; fwAgentSel=null;
  // modo inicial pela FASE da tarefa: PR aberto → página do PR; pronta → revisão; senão conversa
  { const t=(state.tasks||[]).find(x=>x.id===taskId);
    // pronta pra revisar ou concluída → aba ENTREGA (objetivo, provas, docs); rodando → código/conversa
    fwMode = path ? 'codigo' : (t&&(taskIsDone(t)||['review','delivered'].includes(t.status))) ? 'entrega' : (t&&t.prUrl&&t.status!=='draft') ? 'pr' : 'codigo'; }
  { const sc=$id('fwStepChip'); if(sc) sc.innerHTML=''; } // popover não vaza entre tarefas
  $id('fwOverlay').style.display='flex';
  renderWorkspace(); // abre NA HORA (skeleton); os dados chegam em paralelo
  const pFiles = invoke('task_files',{ taskId }).then(f=>{ if(fwTask===taskId) fwFiles=f||[]; }).catch(()=>{ if(fwTask===taskId) fwFiles=[]; });
  const pEvs = fwFetchEvents();
  await pFiles;
  if(fwTask!==taskId) return; // trocou de tarefa/aba enquanto carregava: esta resposta já não vale
  if(fwPath && !fwFiles.some(f=>f.path===fwPath)) fwFiles.unshift({ path:fwPath, add:0, del:0, doc:true });
  if(!fwPath && fwFiles.length) fwPath=fwFiles[0].path;
  await Promise.all([fwLoadFile(), pEvs]);
  if(fwTask!==taskId) return;
  renderWorkspace();
}
// busca só o que é NOVO (id > último) — payload minúsculo por tick
async function fwFetchEvents(){
  if(!fwTask) return;
  const tk=fwTask;
  try{ const rows=(await invoke('task_events',{ taskId:tk, sinceId:fwEvLast })||[]).filter(e=>e.id>fwEvLast);
    if(fwTask!==tk) return; // trocou de tarefa no meio: não mistura os eventos
    if(rows.length){ fwEvents.push(...rows); fwEvLast=rows[rows.length-1].id; } }catch(_){ }
}
async function fwLoadFile(){
  if(!fwPath){ fwContent=''; fwAdded=[]; renderWorkspace(); return; }
  const tk=fwTask, pth=fwPath; // arquivo/tarefa trocados enquanto lia → descarta a resposta velha
  let content, added;
  try{ const r=await invoke('read_file',{ taskId:tk, path:pth }); content=r.content||''; added=r.addedLines||[]; }
  catch(e){ content='// não consegui abrir: '+String(e); added=[]; }
  if(fwTask!==tk || fwPath!==pth) return;
  fwContent=content; fwAdded=added;
  fwSelA=0; fwSelB=0; renderWorkspace();
}
function closeWorkspace(){ const o=$id('fwOverlay'); if(o){ o.classList.remove('astab'); o.style.display='none'; } if(typeof closeTab==='function' && fwTask) closeTab('task:'+fwTask); }
function fwSelRange(){ if(!fwSelA) return null; const a=Math.min(fwSelA,fwSelB||fwSelA), b=Math.max(fwSelA,fwSelB||fwSelA); return {a,b}; }
function fwPlan(t){
  const roles=t.roles||[]; if(!roles.length) return '';
  let cur=roles.findIndex(r=>r.role===t.stage); if(cur<0) cur=0;
  const fin=(t.status==='review'||t.status==='merged'||t.status==='done');
  return `<div class="fwplan">`+roles.map((r,i)=>{
    let cls = fin||i<cur?'done':(i===cur&&ACTIVE_ST.has(t.status)?'cur':'wait');
    const mark = cls==='done'?IC.check:cls==='cur'?'<span class="spin"></span>':(i+1);
    return `<div class="fwstep ${cls}"><span class="fwmark">${mark}</span><span class="fwsteptx">${ROLE_PT[r.role]||r.role} · ${esc(r.name)}</span></div>`;
  }).join('')+`</div>`;
}
let fwCtxOpen=(lsGet('fwCtxOpen')==='1');
// barra compacta: estado da tarefa + progresso dos requisitos (expande no clique)
function fwCtxBarHtml(t){
  const asking=pendingOf(t.id);
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !asking.length;
  const col=STATUS_COLOR[t.status]||'var(--muted)';
  const st = asking.length?`<span class="fwctxst" style="color:var(--warn)"><span class="pulse" style="--pc:var(--warn)"></span>esperando você</span>`
    : working?`<span class="fwctxst" style="color:var(--good)"><span class="pulse" style="--pc:var(--good)"></span>${esc(ROLE_PT[t.stage]||t.stage||'trabalhando')}</span>`
    : `<span class="fwctxst" style="color:${col}">${IC.checkc} ${esc(t.status==='review'?'pronta pra review':t.status==='merged'?'mergeada':t.status)}</span>`;
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  let reqPart='';
  if(reqs.length){
    const c=reqProofCache[t.id];
    if(c&&Array.isArray(c.list)){
      const matched=matchReqProofs(reqs, c.list);
      const done=matched.filter(m=>m&&m.status==='done').length;
      const pct=reqs.length?Math.round(done/reqs.length*100):0;
      reqPart=`<span class="fwctxreq">requisitos <b>${done}/${reqs.length}</b><span class="minibar"><i style="width:${pct}%"></i></span></span>`;
    } else {
      reqPart=`<span class="fwctxreq">requisitos <b>${reqs.length}</b> · <span style="color:var(--warn)">sem provas — verificar ›</span></span>`;
    }
  }
  return `${st}${reqPart}<span class="fwchev">${fwCtxOpen?'▾':'▸'}</span>`;
}
function fwNowHtml(t){
  const ev=lastEventOf(t.id);
  if(ACTIVE_ST.has(t.status)){
    const evsN=fwEvents.length?fwEvents:eventsOf(t.id);
    const lastThink=[...evsN].reverse().find(e=>e.type==='think'&&(e.text||'').trim());
    const narr=lastThink?`<div class="nowsay"><span class="nsav" style="background:${agentColor(lastThink.agent)}">${agentBadge(lastThink.agent)}</span><div class="nowsaytx clamp4">${esc(lastThink.text)}</div></div>`:'';
    return `<div class="fwnowh"><span class="pulse" style="--pc:var(--good)"></span>O que estou fazendo agora <span class="fwnowstep">${esc(ROLE_PT[t.stage]||t.stage||'')}</span></div>${narr}<div class="fwnowtx">${ev?esc((GLYPH[ev.type]||'·')+' '+ev.text):'iniciando…'}</div>${fwPlan(t)}${(t.roles||[]).some(r=>r.engine==='claude')?`<button class="btn sm fwsteer" id="fwSteer">${IC.hand} mudar o rumo</button>`:''}`;
  }
  // estado final: só as etapas (o status já está na barra de contexto)
  return fwPlan(t);
}
let fwLiveSig='';
async function fwLiveUpdate(){
  const t=fwTaskObj(); if(!t) return;
  if(!fwFetching){ fwFetching=true; try{ await fwFetchEvents(); }catch(_){ } fwFetching=false; }
  const evs0=fwEvents.length?fwEvents:eventsOf(t.id);
  const rp=reqProofCache[t.id];
  const sig=[t.id,t.status,evs0.length,evs0.length?evs0[evs0.length-1].id:0,pendingOf(t.id).length,(rp&&Array.isArray(rp.list))?rp.list.filter(x=>x.status==='done').length:'-'].join('|');
  if(sig===fwLiveSig) return; // nada mudou → não mexe no DOM (digitação fica leve)
  fwLiveSig=sig;
  const now=$id('fwNow'); if(now){ now.className='fwnow'+(ACTIVE_ST.has(t.status)?'':' done'); now.innerHTML=fwNowHtml(t); const b=$id('fwSteer'); if(b) b.onclick=()=>{ const inp=$id('fwInput'); if(inp){ inp.focus(); inp.placeholder='descreva a mudança de rumo'; } }; }
  // conversa + requisitos ao vivo (o input não é tocado — foco/texto preservados)
  const th=$id('fwThread');
  if(th){ const atBottom=th.scrollHeight-th.scrollTop-th.clientHeight<80; th.innerHTML=fwThreadHtml(t); if(atBottom) th.scrollTop=th.scrollHeight; }
  const rq=$id('fwReqs'); if(rq) rq.innerHTML=fwReqsHtml(t);
  const cb=$id('fwCtxBar'); if(cb) cb.innerHTML=fwCtxBarHtml(t);
  const sub=$id('fwChatSub');
  const asking=pendingOf(t.id); const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !asking.length;
  if(sub) sub.textContent=asking.length?'esperando sua resposta':working?'trabalhando…':'mesma sessão — ele lembra o que fez';
  const send=$id('fwSend'); if(send) send.textContent=asking.length?'responder':working?'parar e enviar':'enviar';
  // árvore de arquivos AO VIVO: o agente cria/edita → aparece sem fechar o editor
  if(!fwFilesAt || Date.now()-fwFilesAt>4000){
    fwFilesAt=Date.now();
    invoke('task_files',{ taskId:t.id }).then(f=>{
      f=f||[];
      const s=f.map(x=>x.path+':'+x.add+':'+x.del).join('|');
      if(s!==fwFilesSig){ fwFilesSig=s; fwFiles=f; renderWorkspace(); }
    }).catch(()=>{});
  }
}
let fwFilesAt=0, fwFilesSig='';
let fwChatWide=(lsGet('fwChatWide')==='1');
// fase da tarefa no funil do redesign: Descoberta→Despacho→Execução→Revisão→PR
const PHASES=['Descoberta','Despacho','Execução','Revisão','PR'];
function taskPhase(t){
  if(t.prUrl) return 5;
  if(['review','delivered','merged','done'].includes(t.status)) return 4;
  if(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.status==='paused') return 3;
  if(t.status==='queued') return 2;
  return 1;
}
function phasesHtml(t){
  const ph=taskPhase(t);
  return PHASES.map((p,i)=>`<span class="pd${i+1<ph?' done':i+1===ph?' cur':''}" title="${escA(p)}"></span>`).join('')+`<span class="plabel">${esc(PHASES[ph-1])}</span>`;
}
// abas de sessão: alterna entre as tarefas vivas sem sair do workspace
function renderFwTabs(){
  const el=$id('fwTabs'); if(!el) return;
  el.style.display='none'; el.innerHTML=''; return; // tarefas abertas agora vivem na barra de abas do topo
  // abas = sessões RODANDO ou ESPERANDO REVIEW (fechadas/mergeadas não poluem o topo)
  let open=(state.tasks||[]).filter(t=>t.flag!=='closed'&&(ACTIVE_ST.has(t.status)||['thinking','plan-review','review','delivered'].includes(t.status)))
    .sort((a,b)=>b.created_at-a.created_at).slice(0,7);
  const cur=(state.tasks||[]).find(t=>t.id===fwTask);
  if(cur && !open.some(t=>t.id===cur.id)) open=[cur,...open].slice(0,6);
  // a barra fica SEMPRE visível: dá o recuo dos semáforos do macOS e é a área de arrastar a janela
  el.style.display='flex';
  el.innerHTML=open.map(t=>{
    const col=pendingOf(t.id).length?'var(--warn)':(ACTIVE_ST.has(t.status)||t.status==='thinking')?'var(--good)':['review','delivered'].includes(t.status)?'var(--warn)':'var(--muted)';
    return `<span class="fwtab${t.id===fwTask?' on':''}" data-tab="${escA(t.id)}"><span class="td" style="background:${col}"></span>${esc(t.title.slice(0,26))}</span>`;
  }).join('');
  el.querySelectorAll('.fwtab').forEach(b=>b.onclick=()=>{ if(b.dataset.tab!==fwTask) openWorkspace(b.dataset.tab); });
}
function renderWorkspace(){
  renderFwTabs();
  { const t=fwTaskObj(); const p=$id('fwPhases'); if(p&&t) p.innerHTML=phasesHtml(t); }
  const t=fwTaskObj(); if(!t){ closeWorkspace(); return; }
  { const cols=document.querySelector('#fwOverlay .fwcols'); if(cols) cols.classList.remove('chatwide'); }
  // modo da tela (conversa · código · revisão · PR) — layout muda junto
  { const cols=$id('fwCols'); if(cols){ cols.classList.remove('m-conversa','m-codigo','m-revisao','m-pr','m-entrega'); cols.classList.add('m-'+fwMode); } }
  { const m=$id('fwModes'); if(m){ m.innerHTML=fwModesHtml(t); m.querySelectorAll('[data-fwmode]').forEach(b=>b.onclick=()=>{ fwMode=b.dataset.fwmode; renderWorkspace(); }); } }
  // stepper flutuante de fases removido (pouco útil) — não renderiza mais
  // preserva o que está sendo digitado no chat entre re-renders
  const ai=document.activeElement, keepInput=(ai&&ai.id==='fwInput'), inEl=$id('fwInput'), inVal=inEl?inEl.value:null, inCaret=(inEl&&inEl.selectionStart!=null)?inEl.selectionStart:null;
  $id('fwTaskName').textContent=t.title;
  $id('fwTaskBranch').textContent=t.branch+' · '+t.agent;
  if(typeof orqTaskChips==='function') orqTaskChips(t);
  // barra de REVISÃO (redesign p12): entrega pronta → aprovar/pedir ajuste dali mesmo
  { const rb=$id('fwReviewBar');
    if(rb){
      const cost=taskCost(t.id);
      const modelChip=(t.status!=='draft')?`<button class="btn sm" id="fwModel" title="trocar o modelo desta demanda (vale a partir do próximo turno)" style="font-family:var(--mono);font-size:11px">⚙ ${esc(typeof aiModelName==='function'?aiModelName(t.model):(t.model||'padrão'))}</button>`:'';
      const costChip=modelChip+(cost.usd>0?`<span class="mono dim" style="font-size:11px" title="custo da tarefa até agora">${fmtUsd(cost.usd)}</span>`:'');
      // site local que o agente subiu (🌐 preview) — abrir aqui ou no celular (túnel)
      const pv=taskPreviewUrl(t.id);
      const tun=(typeof tunnelUp!=='undefined')?tunnelUp[t.id]:null;
      const pctHtml=`<button class="btn sm" id="fwSum" title="resumo de tudo que já foi feito + o que falta" style="display:flex;gap:7px;align-items:center"><span style="width:52px;height:4px;border-radius:99px;background:var(--border-strong);overflow:hidden;display:inline-block"><i style="display:block;height:100%;width:${taskPct(t)}%;background:var(--good)"></i></span><span class="mono" style="font-size:10.5px">${taskPct(t)}%</span></button>`;
      const pvHtml=pctHtml+(pv?`<button class="btn sm" id="fwPv" data-url="${escA(pv)}" title="${escA(pv)}" style="color:var(--accent)">${IC.globe} ${esc(pv.replace(/^https?:\/\//,'').slice(0,26))}</button>`+
        (tun?`<button class="btn sm" id="fwPvOff" title="fecha o túnel do celular agora (${escA(tun)})" style="color:var(--warn)">${IC.phone} fechar acesso</button>`
            :`<button class="btn sm" id="fwPvMob" data-url="${escA(pv)}" title="túnel criptografado pra abrir este preview no seu celular">${IC.phone}</button>`):'');
      // PR SEMPRE à mão: existe → página do PR; não existe → preparar e abrir
      const prN2=(String(t.prUrl||'').match(/\/pull\/(\d+)/)||[])[1];
      const prBtn = t.status==='draft' ? '' : (t.prUrl
        ? `<button class="btn sm" id="fwPrGo" title="página do PR — corpo, comentários, merge" style="color:var(--accent)">${IC.merge} PR${prN2?' #'+prN2:''}</button>`
        : `<button class="btn sm" id="fwPrOpen" title="checagens do repo → commit & push → cria o PR">${IC.merge} abrir PR</button>`);
      if(['review','delivered'].includes(t.status) && !t.prUrl){
        const rev=reviewOf(t.id);
        rb.innerHTML=`${pvHtml}${costChip}<button class="btn sm" id="fwAskFix" title="${rev?escA((rev.summary||'').slice(0,120)):'a entrega está pronta pra revisar'}">pedir ajuste</button><button class="btn primary sm" id="fwApprove">${IC.check} aprovar e abrir PR</button>`;
        const af=$id('fwAskFix'); if(af) af.onclick=()=>{ const i=$id('fwInput'); if(i){ i.placeholder='descreva o ajuste — vira instrução direta pro agente'; i.focus(); } };
        const ap=$id('fwApprove'); if(ap) ap.onclick=()=>prPrepOpen(t.id, lsGet('prBase:'+t.id)||'main');
      } else rb.innerHTML=pvHtml+costChip+prBtn;
      bindClick('fwPrGo', ()=>{ fwMode='pr'; renderWorkspace(); });
      bindClick('fwPrOpen', ()=>prPrepOpen(t.id, lsGet('prBase:'+t.id)||'main'));
      bindClick('fwSum', ()=>openTaskSummary(t.id));
      bindClick('fwModel', (e)=>{ e.stopPropagation(); openModelMenu(t.id, e.currentTarget); });
      bindClick('fwPv', ()=>invoke('open_url',{ url:b.dataset.url }).catch(()=>{}));
      { const b=$id('fwPvMob'); if(b) b.onclick=async()=>{ b.disabled=true; b.textContent='criando túnel…';
          const pub=await mobilePreview(t.id, b.dataset.url);
          if(pub && typeof tunnelUp!=='undefined'){ tunnelUp[t.id]=pub; }
          renderWorkspace(); }; }
      { const b=$id('fwPvOff'); if(b) b.onclick=async()=>{ b.disabled=true; b.textContent='fechando…';
          try{ await invoke('tunnel_stop',{ taskId:t.id }); }catch(_){ }
          if(typeof tunnelUp!=='undefined') delete tunnelUp[t.id];
          if(typeof autoTunneled!=='undefined') delete autoTunneled[t.id];
          try{ const cid=tmap()[t.id]; if(cid){ const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{}; await sbFetch('/rest/v1/tasks?id=eq.'+cid,{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),previewUrl:null,tunnelWanted:null,tunnelClose:null}})}); } }catch(_){ }
          renderWorkspace(); }; }
    }
  }
  // ---- coluna 1: árvore de arquivos ----
  const tree=$id('fwTree');
  const dels=Array.isArray(t.deliverables)?t.deliverables.filter(Boolean):[];
  const canDeliv=dels.length>0;
  const body = fwFiles.length
    ? (fwGroupMode==='deliverable'&&canDeliv ? fwDelivHtml(fwFiles, dels) : `<div class="fwtreebody">${fwTreeHtml(fwBuildTree(fwFiles),0)}</div>`)
    : '<div class="dim" style="padding:8px;font-size:11.5px">nada ainda — os arquivos que o agente alterar, os anexos (.cardume/refs) e os artefatos aparecem aqui ao vivo</div>';
  const tActive=ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy;
  const cost=taskCost(t.id);
  const liveAll=(state.tasks||[]).filter(x=>ACTIVE_ST.has(x.status)||x.status==='thinking').length;
  const treeFoot = `<div class="fwtreefoot"><div class="r"><span>slots em paralelo</span><b>${liveAll}/${slotMax}</b></div><div class="r"><span>custo até agora</span><b>${cost.usd>0?fmtUsd(cost.usd):'—'}</b></div></div>`;
  // Entregas & provas (artefatos) — sempre à mão, como no painel antigo
  const artC=artifactsCache[t.id];
  if(!artC || artC.status!==t.status){ loadArtifacts(t.id, t.status).then(()=>{ if(fwTask===t.id) renderWorkspace(); }); }
  const artsHtml=artC?artListHtml(artC.list):'';
  tree.innerHTML=`<div class="fwtreeh">${fwMode==='revisao'?'Arquivos alterados':tActive?'Arquivos sendo alterados':'Arquivos desta tarefa'}</div>`+
    (canDeliv?`<div class="fwgtoggle"><button class="fwgbtn${fwGroupMode==='folder'?' on':''}" data-fwg="folder">Pastas</button><button class="fwgbtn${fwGroupMode==='deliverable'?' on':''}" data-fwg="deliverable">Entregáveis</button></div>`:'')+
    body+
    (fwMode==='conversa'?'':`<div class="fwtreehint">${fwGroupMode==='deliverable'?'Vínculo por palavra-chave — o arquivo aparece sob o entregável que ele parece atender.':'Selecione linhas no código e pergunte ao agente que escreveu.'}</div>`)+
    (artsHtml?`<div class="fwarts">${artsHtml}</div>`:'')+
    treeFoot;
  tree.querySelectorAll('[data-art]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openArtifact(t.id, b.dataset.art); });
  tree.querySelectorAll('[data-fwg]').forEach(b=>b.onclick=()=>{ fwGroupMode=b.dataset.fwg; renderWorkspace(); });
  // status por arquivo (redesign p6): tocado há <3min = EDITANDO; resto = CONCLUÍDO
  if(fwFiles.length && (ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy)){
    const hot=new Set(); const now=Date.now();
    for(const e of eventsOf(t.id).slice(-80)){
      if(!['edit','write'].includes(e.type)) continue;
      if(now-(+new Date(e.ts)||0)>180000) continue;
      const m=String(e.text||'').match(/[\w@./-]+\.[A-Za-z]{1,8}/g)||[];
      m.forEach(x=>hot.add(x.replace(/^\.\//,'')));
    }
    tree.querySelectorAll('[data-fwf]').forEach(b=>{
      const p=b.dataset.fwf||'';
      const isHot=[...hot].some(h=>p.endsWith(h)||h.endsWith(p));
      b.insertAdjacentHTML('beforeend', `<span class="fwst ${isHot?'ed':'ok'}">${isHot?'editando':'concluído'}</span>`);
    });
  }
  tree.querySelectorAll('[data-fwf]').forEach(b=>b.onclick=()=>{ fwPath=b.dataset.fwf; fwEditing=false; if(fwMode==='conversa'||fwMode==='pr') fwMode='codigo'; fwLoadFile(); renderWorkspace(); });
  tree.querySelectorAll('[data-fwdir]').forEach(b=>b.onclick=()=>{ const p=b.dataset.fwdir; if(fwCollapsed.has(p)) fwCollapsed.delete(p); else fwCollapsed.add(p); renderWorkspace(); });
  // ---- coluna 2: código (visualizar + editar inline) ----
  const main=$id('fwMain');
  const added=new Set(fwAdded); const sel=fwSelRange();
  const f=fwFiles.find(x=>x.path===fwPath)||{add:0,del:0};
  const lines=fwContent.split('\n');
  // "Por que este arquivo": explicação REAL do diff deste arquivo (IA, cache por versão do diff),
  // recolhível; enquanto carrega, mostra o objetivo da tarefa (sem o bloco de contexto do orquestrador)
  const objShort=String(t.objective||'').split('[PLANO DO ORQUESTRADOR')[0].trim();
  const whyKey=t.id+'|'+(fwPath||'');
  if(fwPath && fwWhyCache[whyKey]===undefined && !fwEditing){
    fwWhyCache[whyKey]=null;
    invoke('ai_file_why',{ taskId:t.id, path:fwPath }).then(md=>{ fwWhyCache[whyKey]={ md:md||'' }; if(fwTask===t.id) renderWorkspace(); })
      .catch(e=>{ fwWhyCache[whyKey]={ err:String(e&&e.message||e) }; if(fwTask===t.id) renderWorkspace(); });
  }
  const w=fwPath?fwWhyCache[whyKey]:null;
  const whyInner = !fwPath ? esc(objShort)
    : w===null ? `<span class="dim">lendo o diff deste arquivo e escrevendo a explicação…</span>`
    : (w&&w.md) ? mdToHtml(w.md)
    : (w&&w.err) ? `<span style="color:var(--warn)">não consegui explicar este arquivo: ${esc(w.err)}</span> <a class="lnk" id="fwWhyRetry">tentar de novo</a>`
    : `<span class="dim">sem alterações neste arquivo nesta branch.</span> ${esc(objShort)}`;
  const whyBand = `<div class="fwwhy${fwWhyOpen?' open':''}"><svg viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="1.3" stroke-linejoin="round"><path d="M7 2.6l1 2.6 2.6 1-2.6 1L7 9.8 6 7.2 3.4 6.2 6 5.2z"/></svg><div class="fwwhyb"><div class="fwwhyh"><span class="fwwhyl">${fwPath?'O que foi feito neste arquivo e por quê':'Objetivo da tarefa'}</span><span style="flex:1"></span>${fwPath&&w&&w.md?`<button class="fwwhyre" id="fwWhyRedo" title="gerar de novo">↻</button>`:''}<button class="fwwhytg" id="fwWhyTg">${fwWhyOpen?'▴ menos':'▾ mais'}</button></div><div class="fwwhyt">${whyInner}</div></div></div>`;
  if(fwMode==='entrega'){ fwRenderEntrega(t, main); }
  else if(fwMode==='pr'){ fwRenderPrPage(t, main); }
  else if(fwMode==='revisao'){ fwRenderDiff(t, main); }
  else if(!fwPath){ main.innerHTML='<div class="empty">selecione um arquivo à esquerda</div>'; }
  else {
    const headBtns = fwEditing
      ? `<button class="btn primary sm" id="fwSave">${IC.check} salvar</button><button class="btn sm" id="fwCancel">cancelar</button>`
      : `<button class="btn sm" id="fwEditBtn">${IC.pencil||'✎'} editar</button>`;
    const body = fwEditing
      ? `<div class="fveditwrap fwedit"><div class="fvgutter" id="fwGutter" aria-hidden="true"></div><textarea class="fvedit mono" id="fwText" spellcheck="false" wrap="off"></textarea></div>`
      : `<div class="fwcode" id="fwCode">${lines.map((ln,i)=>{const n=i+1;const inSel=sel&&n>=sel.a&&n<=sel.b;return `<div class="fwln${added.has(n)?' add':''}${inSel?' sel':''}" data-ln="${n}"><span class="fwnum">${n}</span><span class="fwtxt">${esc(ln)||' '}</span></div>`;}).join('')}</div>`;
    const bar = fwEditing
      ? `<div class="fwselbar">editando <b>${esc(fwPath.split('/').pop())}</b> — <b>salvar</b> grava direto na worktree · <span class="kbd">esc</span> cancela`
      : `<div class="fwselbar">${sel?`<b>linhas ${sel.a}${sel.b>sel.a?'–'+sel.b:''} selecionadas</b> · pergunte ao ${esc(t.agent)} no chat →`:'clique e <b>arraste</b> pra selecionar várias linhas (ou shift+clique) e pergunte no chat'}</div>`;
    main.innerHTML = `
      <div class="fwmhead"><span class="fwmpath mono">${esc(fwPath)}</span><span class="fwmadd">+${f.add} <span style="color:var(--crit)">−${f.del}</span></span><span class="fwmby"><span class="fwav" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span>escrito por ${esc(t.agent)}</span><span style="flex:1"></span>${headBtns}</div>
      ${whyBand}
      ${body}
      ${bar}`;
  }
  if(fwMode==='pr'||fwMode==='revisao'||fwMode==='entrega'){ /* wiring próprio nas funções de página */ }
  else if(fwEditing){
    const ta=$id('fwText'), gut=$id('fwGutter');
    if(ta){ ta.value=fwContent; const sg=()=>{ const n=ta.value.split('\n').length||1; let s=''; for(let i=1;i<=n;i++) s+=i+'\n'; gut.textContent=s; }; sg(); ta.addEventListener('input',sg); ta.addEventListener('scroll',()=>gut.scrollTop=ta.scrollTop); ta.addEventListener('keydown',e=>{ if(e.key==='Tab'){ e.preventDefault(); const s=ta.selectionStart; ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(ta.selectionEnd); ta.selectionStart=ta.selectionEnd=s+2; sg(); } }); try{ ta.setSelectionRange(0,0); }catch(_){ } ta.focus({preventScroll:true}); requestAnimationFrame(()=>{ ta.scrollTop=0; ta.scrollLeft=0; gut.scrollTop=0; }); } // abre no TOPO: o caret ia pro fim e o focus rolava o texto todo
    const sv=$id('fwSave'); if(sv) sv.onclick=fwSaveFile;
    const cc=$id('fwCancel'); if(cc) cc.onclick=()=>{ fwEditing=false; renderWorkspace(); };
  } else {
    const codeEl=$id('fwCode');
    if(codeEl){
      // seleção por ARRASTE (várias linhas) + shift-clique; sem native text-select
      codeEl.addEventListener('mousedown',e=>{ const ln=e.target.closest('.fwln'); if(!ln)return; e.preventDefault(); const n=+ln.dataset.ln; if(e.shiftKey&&fwSelA){ fwSelB=n; } else { fwSelA=n; fwSelB=n; } fwDrag=true; fwPaintSel(); });
      codeEl.addEventListener('mouseover',e=>{ if(!fwDrag)return; const ln=e.target.closest('.fwln'); if(!ln)return; fwSelB=+ln.dataset.ln; fwPaintSel(); });
    }
    const eb=$id('fwEditBtn'); if(eb) eb.onclick=()=>{ fwEditing=true; renderWorkspace(); };
    bindClick('fwWhyTg', ()=>{ fwWhyOpen=!fwWhyOpen; renderWorkspace(); });
    bindClick('fwWhyRedo', async()=>{ const k=t.id+'|'+fwPath; try{ await invoke('ai_file_why_reset',{ taskId:t.id, path:fwPath }); }catch(_){ } fwWhyCache[k]=undefined; renderWorkspace(); });
    bindClick('fwWhyRetry', ()=>{ fwWhyCache[t.id+'|'+fwPath]=undefined; renderWorkspace(); });
  }
  // ---- coluna 3: chat com o agente (estilo Cursor: requisitos + conversa real) ----
  const chat=$id('fwChatCol');
  const nowBox = `<div class="fwnow${ACTIVE_ST.has(t.status)?'':' done'}" id="fwNow">${fwNowHtml(t)}</div>`;
  const askingW=pendingOf(t.id);
  const workingW=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !askingW.length;
  const sel2=fwSelRange();
  chat.innerHTML=`
    <div class="fwchath"><span class="fwav" style="background:${agentColor(fwAgentSel||t.agent)}">${agentBadge(fwAgentSel||t.agent)}</span><div><div class="fwchatt">${esc(fwAgentSel||t.agent)}</div><div class="fwchatd" id="fwChatSub">${askingW.length?'esperando sua resposta':workingW?'trabalhando…':'mesma sessão — ele lembra o que fez'}</div></div><button class="fwexp" id="fwExpand" title="${fwMode==='conversa'?'recolher — voltar à visão de código':'expandir o chat — só a barra de arquivos fica ao lado'}">${fwMode==='conversa'?'⇥':'⇤'}</button>${workingW?`<button class="btn sm chatstop" id="fwStop">${IC.pause} parar</button>`:''}</div>
    <div class="fwctx"><button class="fwctxbar" id="fwCtxBar">${fwCtxBarHtml(t)}</button><div class="fwctxbody" id="fwCtxBody" style="display:${fwCtxOpen?'block':'none'}">${nowBox}<div class="fwreqs" id="fwReqs">${fwReqsHtml(t)}</div></div></div>
    <div class="fwthread" id="fwThread">${fwThreadHtml(t)}</div>
    <div class="fwinput"><div class="atmenu" id="fwMenu" style="display:none"></div>${sel2?`<div class="fwselchip">↳ ${esc((fwPath||'').split('/').pop())}:${sel2.a}${sel2.b>sel2.a?'–'+sel2.b:''}<button class="fwselx" id="fwSelX">✕</button></div>`:''}
      <div class="attrow attpend" id="fwPend" style="display:${(fwPend[t.id]||[]).length?'flex':'none'}">${(fwPend[t.id]||[]).map((a,i)=>attChipHtml(a,i,true)).join('')}</div>
      <textarea class="in fwta" id="fwInput" rows="2" style="width:100%" placeholder="${askingW.length?'responda a pergunta — o turno continua':'peça um ajuste…  ( / abre as skills · ⌘V cola um print )'}"></textarea>
      <div class="fwinrow" style="margin-top:6px"><button class="btn sm" id="fwAttach" title="anexar arquivo">${IC.clip}</button><label class="fwreqtoggle" style="margin:0"><input type="checkbox" id="fwAsReq"><span>vira <b>requisito</b></span></label><span style="flex:1"></span>${workingW&&!askingW.length?'<button class="btn sm" id="fwQueue" title="não interrompe: o agente executa quando terminar o turno atual">na fila</button>':''}<button class="btn primary sm" id="fwSend" style="white-space:nowrap">${askingW.length?'responder':workingW?'parar e enviar':'enviar'}</button></div></div>`;
  bindClick('fwSteer', ()=>{ const inp=$id('fwInput'); if(inp){ inp.focus(); inp.placeholder='descreva a mudança de rumo'; } });
  bindClick('fwStop', ()=>stopTask(t.id));
  // expandir o chat = visão do PDF: conversa em quase toda a tela, SÓ a barra de
  // arquivos ao lado (clicar num arquivo volta pra visão de código)
  bindClick('fwExpand', ()=>{ fwMode = fwMode==='conversa' ? 'codigo' : 'conversa'; renderWorkspace(); });
  bindClick('fwCtxBar', ()=>{ fwCtxOpen=!fwCtxOpen; lsSet('fwCtxOpen', fwCtxOpen?'1':'0'); renderWorkspace(); });
  bindClick('fwSelX', ()=>{ fwSelA=0; fwSelB=0; renderWorkspace(); });
  bindClick('fwSend', ()=>fwSendMsg(false));
  bindClick('fwQueue', ()=>fwSendMsg(true));
  attWireComposer({ input:'fwInput', attach:'fwAttach', pend:()=>(fwPend[t.id]=fwPend[t.id]||[]), taskId:()=>t.id, rerender:renderWorkspace });
  { const pp=$id('fwPend'); if(pp) pp.querySelectorAll('[data-attrm]').forEach(x=>x.onclick=()=>{ (fwPend[t.id]||[]).splice(+x.dataset.attrm,1); renderWorkspace(); }); }
  chat.onclick=(e)=>{
    const ao=e.target.closest('[data-askopt]');
    if(ao){ const p=pendingOf(t.id)[0]; if(p){ ao.disabled=true; resolvePending(p.id, ao.dataset.askopt); } return; }
    const cp=e.target.closest('.ccopy');
    if(cp){ const bub=cp.parentElement; const cl=bub.cloneNode(true); cl.querySelectorAll('.ccopy').forEach(x=>x.remove()); try{ navigator.clipboard.writeText(cl.innerText.trim()); cp.textContent='✓'; setTimeout(()=>{cp.textContent='⧉';},900); }catch(_){} return; }
    const a=e.target.closest('[data-art]'); if(a){ openArtifact(t.id, a.dataset.art); return; }
    if(e.target.closest('#fwReqCheck')){ fwSendText(t.id, 'Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json. Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar.'); return; }
  };
  { const i=$id('fwInput'); if(i){ i.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$id('fwMenu').style.display!=='none'){ e.stopPropagation(); fwHideMenu(); return; } if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); fwHideMenu(); fwSendMsg(); } });
    i.addEventListener('input',()=>{ const v=i.value, last=v.slice(-1), ws=(v.length===1||/\s/.test(v.slice(-2,-1)));
      if(last==='/'&&ws) fwShowMenu(t,'req'); else if(last==='@'&&ws) fwShowMenu(t,'ref'); else fwHideMenu(); }); if(inVal!=null){ i.value=inVal; if(keepInput){ i.focus(); if(inCaret!=null){ try{ i.setSelectionRange(inCaret,inCaret); }catch(_){} } } } } }
  const th=$id('fwThread'); if(th) th.scrollTop=th.scrollHeight;
}
// ---- stepper flutuante da tela de execução (redesign p11) ----
function renderFwStep(t){
  const el=$id('fwStepChip'); if(!el||!t) return;
  const ph=taskPhase(t);
  const dots=PHASES.map((_,i)=>`<span class="pd2${i+1<ph?' done':i+1===ph?' cur':''}"></span>`).join('');
  const wasOpen=($id('fwStepPop')||{}).style?.display==='block';
  el.innerHTML=`<div class="pop" id="fwStepPop" style="display:${wasOpen?'block':'none'}">${PHASES.map((n,i)=>`<div class="pi${i+1<ph?' done':''}${i+1===ph?' cur':''}" data-ph="${i+1}"><span class="pd2${i+1<ph?' done':i+1===ph?' cur':''}"></span>${esc(n)}</div>`).join('')}</div>
    <div class="chip" id="fwStepBtn">${dots}<span>${esc(PHASES[ph-1])}</span></div>`;
  const pop=$id('fwStepPop');
  $id('fwStepBtn').onclick=(e)=>{ e.stopPropagation(); pop.style.display=pop.style.display==='none'?'block':'none'; };
  el.querySelectorAll('.pi').forEach(p=>p.onclick=()=>{
    const n=+p.dataset.ph; pop.style.display='none';
    if(n===4) fwMode='revisao';
    else if(n===5) fwMode='pr'; // sem PR ainda? a página oferece "preparar e abrir"
    else fwMode='codigo';
    renderWorkspace();
  });
}
// ---- Revisão: diff de verdade por arquivo (redesign p12) ----
function fwRenderDiff(t, main){
  if(!fwPath && fwFiles.length) fwPath=fwFiles.filter(f=>!f.doc)[0]?.path||fwFiles[0].path;
  const key=t.id+':'+fwPath;
  if(fwPath && fwDiffCache[key]===undefined){
    fwDiffCache[key]=null;
    invoke('file_diff',{ taskId:t.id, path:fwPath }).then(d=>{ fwDiffCache[key]=d||''; if(fwTask===t.id&&fwMode==='revisao') renderWorkspace(); }).catch(()=>{ fwDiffCache[key]=''; });
  }
  const rev=reviewOf(t.id);
  const f=fwFiles.find(x=>x.path===fwPath)||{add:0,del:0};
  const band=`<div class="fwrevband">${rev?`<b>${esc((rev.summary||'').slice(0,90))}</b>`:'<b>revisão da entrega</b>'}${rev&&rev.howToTest?`<span class="dim" style="margin-left:4px">· como testar: ${esc(rev.howToTest.slice(0,120))}</span>`:''}<span style="flex:1"></span><button class="btn sm" id="fwBackConv">← conversa</button></div>`;
  let rows='';
  const diff=fwPath?fwDiffCache[key]:'';
  if(!fwPath) rows='<div class="empty">nenhum arquivo alterado</div>';
  else if(diff==null) rows=cosmosHtml('carregando o diff…','inline');
  else {
    let oldLn=0, newLn=0;
    rows=diff.split('\n').map(l=>{
      if(l.startsWith('diff --git')||l.startsWith('index ')||l.startsWith('--- ')||l.startsWith('+++ ')||l.startsWith('new file')||l.startsWith('deleted file')) return '';
      if(l.startsWith('@@')){
        const m=l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if(m){ oldLn=+m[1]; newLn=+m[2]; }
        return `<div class="dl hunk"><span class="dn"></span><span class="dtx">${esc(l)}</span></div>`;
      }
      if(l.startsWith('+')) return `<div class="dl add"><span class="dn">${newLn++}</span><span class="dtx">${esc(l)||' '}</span></div>`;
      if(l.startsWith('-')) return `<div class="dl del"><span class="dn">${oldLn++}</span><span class="dtx">${esc(l)||' '}</span></div>`;
      const n=newLn++; oldLn++;
      return `<div class="dl"><span class="dn">${n}</span><span class="dtx">${esc(l)||' '}</span></div>`;
    }).join('');
  }
  main.innerHTML=`<div class="fwmhead"><span class="fwmpath mono">${esc(fwPath||'')}</span><span class="fwmadd">+${f.add} <span style="color:var(--crit)">−${f.del}</span></span><span style="flex:1"></span></div>${band}<div class="fwdiff">${rows}</div>`;
  bindClick('fwBackConv', ()=>{ fwMode='conversa'; renderWorkspace(); });
}
// ---- página do PR dentro da execução (redesign p14) ----
function fwRenderPrPage(t, main){
  const info=prCache[t.id];
  if(info===undefined){ loadPr(t.id).then(()=>{ if(fwTask===t.id&&fwMode==='pr') renderWorkspace(); }); main.innerHTML='<div class="empty">carregando o PR…</div>'; return; }
  if(!info||!info.exists){
    main.innerHTML=`<div class="empty" style="flex-direction:column;gap:14px"><div>nenhum PR aberto ainda pra <b>${esc(t.branch)}</b></div><button class="btn primary" id="prPgCreate">${IC.merge} preparar e abrir o PR</button><div class="dim" style="font-size:11.5px">roda as checagens do repo, faz commit &amp; push e cria o PR</div></div>`;
    bindClick('prPgCreate', ()=>prPrepOpen(t.id, lsGet('prBase:'+t.id)||'main'));
    return;
  }
  const ign=prIgnSet(t.id);
  const cKey=c=>String(c.id ?? ((c.author||'')+':'+(c.body||'').slice(0,40)));
  const cmts=(info.comments||[]).filter(c=>!c.inReplyTo);
  const openCmts=cmts.filter(c=>!c.answered && !ign.has(cKey(c)));
  const dec=info.decision||'';
  const decBadge=dec==='APPROVED'?'<span class="prbadge ok">✓ aprovado</span>':dec==='CHANGES_REQUESTED'?'<span class="prbadge chg">mudanças pedidas</span>':'<span class="prbadge">aguardando review</span>';
  const cmHtml=cmts.length?cmts.map((c,ci)=>{ const done=c.answered, skip=!done&&ign.has(cKey(c));
    return `<div class="prcmt${c.isBot?' bot':''}${done?' ok':''}"><div class="prcmt-h"><span class="prau">${esc(c.author)}${c.isBot?' <span class="botag">bot</span>':''}</span>${c.path?`<span class="prloc mono">${esc(c.path)}${c.line?':'+c.line:''}</span>`:'<span class="prloc">conversa</span>'}${done?'<span class="prbadge ok">✔ respondido</span>':skip?'<span class="prbadge">ignorado</span>':''}</div><div class="prcmt-b"${(done||skip)?' style="opacity:.55"':''}>${chatMd((c.body||'').slice(0,700))}</div>${(!done&&!skip)?`<div class="prcmt-acts"><button class="btn primary sm" data-prfix="${ci}" style="padding:4px 10px;font-size:11px">${IC.ai} aplicar correção</button><button class="btn sm" data-prign="${escA(cKey(c))}" style="padding:4px 10px;font-size:11px">ignorar</button></div>`:''}</div>`;
  }).join(''):'<div class="dim" style="font-size:12px">sem comentários ainda — o link já está com o time.</div>';
  main.innerHTML=`<div class="prpage">
    <div class="prleft">
      <div style="display:flex;align-items:baseline;gap:10px"><span class="mono" style="color:var(--accent);font-size:15px">#${info.number}</span><b style="font-size:17px">${esc(t.title)}</b></div>
      <div class="mono dim" style="font-size:11px;margin-top:5px">${esc(t.branch)} → ${esc(lsGet('prBase:'+t.id)||'main')} · ${esc((info.state||'').toLowerCase())} ${decBadge}</div>
      <div style="margin-top:14px;font-size:13px;line-height:1.6" class="prbody">${chatMd(info.body||'_sem descrição_')}</div>
      <div style="display:flex;gap:8px;margin-top:18px"><button class="btn sm" id="prPgOpen">${IC.extlink} abrir no GitHub</button><button class="btn sm" id="prPgCopy">copiar link</button><button class="btn sm" id="prPgRefresh">atualizar</button></div>
    </div>
    <div class="prright">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span class="mono" style="font-size:11px;letter-spacing:.08em;color:var(--muted)">COMENTÁRIOS · ${cmts.length}</span><span style="flex:1"></span><button class="btn primary" id="prPgMerge" style="background:var(--accent);font-weight:700">${IC.merge} Merge PR</button></div>
      ${cmHtml}
      ${openCmts.length>1?`<button class="btn primary sm" id="prPgAll" style="margin-top:6px">${IC.ai} corrigir todos os ${openCmts.length} em aberto</button>`:''}
    </div>
  </div>`;
  bindClick('prPgOpen', ()=>openExternal(info.url));
  bindClick('prPgCopy', ()=>copyLink(info.url,b));
  bindClick('prPgRefresh', async()=>{ await loadPr(t.id,true); renderWorkspace(); });
  bindClick('prPgMerge', ()=>mergePr(t.id));
  bindClick('prPgAll', ()=>{ reworkFromPr(t.id); fwMode='conversa'; renderWorkspace(); });
  main.querySelectorAll('[data-prfix]').forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent='enviando…'; try{ await prFixOne(t.id,+b.dataset.prfix); fwMode='conversa'; }finally{ renderWorkspace(); } });
  main.querySelectorAll('[data-prign]').forEach(b=>b.onclick=()=>{ prIgnAdd(t.id,b.dataset.prign); renderWorkspace(); });
}
// markdown leve nas bolhas (bold, `code`, títulos, listas) — sem ** cru na tela
function chatMd(t){ try{ const sp=attSplit(t); return mdToHtml(sp.text)+attRowHtml(sp.atts); }catch(_){ return esc(String(t||'')); } }
const mdMemo=new Map(); // evId:len → html (evita re-parsear a thread toda a cada tick)
function chatMdEv(id, t){ const k=id+':'+String(t||'').length; let v=mdMemo.get(k); if(v===undefined){ v=chatMd(t); if(mdMemo.size>800) mdMemo.clear(); mdMemo.set(k,v); } return v; }
// notas "de sistema" (não são fala do agente) viram linha discreta central
function isMetaNote(txt){ return /^(claude finalizou|\d+ artefato\(s\)|resumo técnico|sessão iniciada|requisito adicionado:|stderr:|PR aberto|PR NÃO aberto|falha ao finalizar)/i.test(String(txt||'')); }
// thread REAL (dos eventos do banco — persiste) + pergunta aberta destacada
// rótulo do modelo do agente na conversa (redesign p6: "VEGA · Opus")
function agentModelLabel(t, name){
  const r=(t.roles||[]).find(x=>x.name===name);
  const m=String((r&&r.model)||t.model||'').toLowerCase();
  const M={ opus:'Opus', sonnet:'Sonnet', haiku:'Haiku' };
  const k=Object.keys(M).find(k=>m.includes(k));
  return k?('Claude '+M[k]):'Claude';
}
// ---- chip de tool: nome técnico de ferramenta vira algo legível e bonito ----
const TOOL_IC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.4 2.6a3 3 0 0 0 3.9 3.9l2.7 2.7a1.15 1.15 0 0 1-1.6 1.6L8.7 8.1A3 3 0 0 1 4.8 4.2l1.7 1.7 1.1-1.1z" stroke-linejoin="round"/></svg>';
const TOOL_DONE_IC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 8.5l3 3 6-6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// parece nome técnico de ferramenta? (um token só, com __ ou CamelCase interno)
function looksLikeTool(tx){ const s=String(tx||'').trim(); return !/\s/.test(s) && s.length>1 && (s.includes('__') || /[a-z][A-Z]/.test(s)); }
// nome técnico → rótulo amigável em PT
function prettyTool(tx){
  const raw=String(tx||'').replace(/^mcp__[a-z0-9]*__/i,'').replace(/^mcp__/i,'').trim();
  const key=raw.toLowerCase().replace(/[_\s]/g,'');
  const MAP={ toolsearch:'buscou uma ferramenta', addrequirement:'registrou um requisito', adddeliverable:'registrou um entregável', askhuman:'perguntou ao humano', claim:'reivindicou um arquivo', websearch:'buscou na web', webfetch:'abriu uma página', todowrite:'atualizou o plano', task:'delegou a um subagente', bash:'rodou um comando', read:'leu um arquivo', grep:'buscou no código', glob:'listou arquivos', edit:'editou um arquivo', write:'escreveu um arquivo' };
  if(MAP[key]) return MAP[key];
  // humaniza: separa camelCase, troca _ por espaço, minúsculo
  return raw.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_]+/g,' ').toLowerCase().trim();
}
function toolChip(label, done){
  return `<div class="ctool${done?' done':''}"><span class="ctool-ic">${done?TOOL_DONE_IC:TOOL_IC}</span><span class="ctool-tx">${esc(label)}</span></div>`;
}
// ---- várias ações seguidas (ler/rodar/editar) viram UMA linha, tipo Claude ----
const ACT_IC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 5.2l2.2 1.8L3 8.8M7.3 9.2h5.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function actSummary(evs){
  const c={}; for(const e of evs) c[e.type]=(c[e.type]||0)+1;
  const plu=(n,s,p)=>`${n} ${n>1?(p||s+'s'):s}`;
  const parts=[];
  if(c.read) parts.push(plu(c.read,'arquivo lido','arquivos lidos'));
  if(c.bash) parts.push(plu(c.bash,'comando','comandos'));
  if(c.edit) parts.push(plu(c.edit,'edição','edições'));
  if(c.write) parts.push(plu(c.write,'arquivo criado','arquivos criados'));
  if(c.claim) parts.push(plu(c.claim,'reivindicação','reivindicações'));
  const known=(c.read||0)+(c.bash||0)+(c.edit||0)+(c.write||0)+(c.claim||0);
  const other=evs.length-known; if(other>0) parts.push(plu(other,'ação','ações'));
  return parts.join(' · ') || plu(evs.length,'ação','ações');
}
function actLine(evs){
  const details=evs.slice(-10).map(e=>String(e.text||'').replace(/\s+/g,' ').slice(0,70)).join('\n');
  return `<div class="cact cactsum" title="${escA(details)}"><span class="cg">${ACT_IC}</span><span class="ct">${esc(actSummary(evs))}</span></div>`;
}
function fwThreadHtml(t){
  const evs=fwEvents.length?fwEvents:eventsOf(t.id); // completos (fallback: snapshot)
  const asking=pendingOf(t.id);
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !asking.length;
  let lastWho='';
  const out=[]; let act=[];
  const flush=()=>{ if(act.length){ out.push(actLine(act)); act=[]; } };
  for(const e of evs){
    const tx=e.text||'';
    if(e.agent==='Você' && tx.startsWith('💬')){ flush(); lastWho=''; out.push(`<div class="cmsg you"><div class="cbub">${chatMdEv(e.id, tx.replace(/^💬\s*/,''))}<button class="ccopy" title="copiar">⧉</button></div></div>`); continue; }
    if(tx.startsWith('humano respondeu:')){ flush(); lastWho=''; out.push(`<div class="cmsg you"><div class="cbub">${chatMdEv(e.id, tx.replace(/^humano respondeu:\s*/,''))}<button class="ccopy" title="copiar">⧉</button></div></div>`); continue; }
    if(isMetaNote(tx)){ flush(); out.push(`<div class="csys">${esc(tx)}</div>`); continue; }
    if(tx.startsWith('perguntou ao humano:')||tx.startsWith('❓')) continue; // a pergunta já aparece no card destacado
    // chamada de ferramenta crua (ToolSearch, mcp__…): é ruído interno — o valor
    // está no RESULTADO (📦/🛠 abaixo). Esconde a chamada, igual o Claude faz.
    if(e.type==='note' && looksLikeTool(tx)) continue;
    // resultado de tool (📦 entregável / 🛠 …) → linha sutil "concluído"
    if(e.type==='note' && /^(📦|🛠)/.test(tx)){ flush(); lastWho=''; out.push(toolChip(tx.replace(/^[📦🛠]\s*/,'').replace(/\s*\(ref\s+\w+\)\s*$/i,''), true)); continue; }
    if(['think','note','done'].includes(e.type) && tx.trim()){
      flush();
      const who=e.agent!==lastWho?`<div class="cwho">${esc((e.agent||'').toUpperCase())} · ${agentModelLabel(t,e.agent)}</div>`:'';
      lastWho=e.agent;
      out.push(`<div class="cmsg bot"><span class="cav" style="background:${agentColor(e.agent)}">${agentBadge(e.agent)}</span><div style="min-width:0;flex:1">${who}<div class="cbub">${chatMdEv(e.id, tx)}<button class="ccopy" title="copiar">⧉</button></div></div></div>`);
      continue;
    }
    if(e.type==='error'){ flush(); out.push(`<div class="cmsg bot"><span class="cav" style="background:var(--crit)">!</span><div class="cbub err">${esc(tx)}</div></div>`); continue; }
    // atividade (ler/rodar/editar/…) — acumula pra virar UMA linha de raciocínio
    act.push(e);
  }
  flush();
  return out.join('')
  + (asking.length?`<div class="cmsg bot"><span class="cav" style="background:${agentColor(asking[0].agent||t.agent)}">${agentBadge(asking[0].agent||t.agent)}</span><div style="min-width:0;flex:1"><div class="cwho" style="color:var(--warn)">${esc(((asking[0].agent||t.agent)||'').toUpperCase())} · PERGUNTA PENDENTE</div><div class="cbub asknow">${chatMd(asking[0].prompt||'aguardando sua resposta')}${Array.isArray(asking[0].options)&&asking[0].options.length?`<div class="askopts">${asking[0].options.map(o=>`<button data-askopt="${escA(o)}">${esc(o)}</button>`).join('')}</div>`:''}<div class="asknote">↳ responda abaixo (ou toque numa opção) — o turno continua</div></div></div></div>`:'')
  + (working?`<div class="cmsg bot"><span class="cav" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span><div class="cbub think"><span class="blink">▍</span> trabalhando…</div></div>`:'');
}
// requisitos com status ao vivo (o "no que ele está trabalhando")
function fwReqsHtml(t){
  const reqs=Array.isArray(t.requirements)?t.requirements:[]; if(!reqs.length) return '';
  const c=reqProofCache[t.id];
  if(c===undefined){ loadReqProofs(t.id).then(()=>{ const el=$id('fwReqs'); if(el&&fwTask===t.id) el.innerHTML=fwReqsHtml(t); }); }
  const matched=matchReqProofs(reqs, c&&c.list);
  const rows=reqs.map((r,ri)=>{ const m=matched[ri]; const st=m?(m.status==='done'?'ok':'blk'):'na';
    const icon= st==='ok'?`<span class="reqst ok">${IC.check}</span>`:st==='blk'?'<span class="reqst blk">!</span>':'<span class="reqst na">·</span>';
    const ev=(m&&Array.isArray(m.evidence)&&m.evidence.length)?`<span class="reqev">${m.evidence.map(e=>`<button class="reqevb mono" data-art="${escA(e)}">${esc(e)}</button>`).join('')}</span>`:'';
    return `<div class="critrow2 ${st}">${icon}<div class="crt"><div>${esc(r)} ${ev}</div></div></div>`; }).join('');
  const canCheck=(!c||c.list===null)&&['review','error','aborted'].includes(t.status);
  const checkBtn=canCheck?'<button class="btn sm" id="fwReqCheck" style="margin-top:6px;width:100%">verificar requisitos agora (gera as provas)</button>':'';
  return `<div class="fwreqh">Requisitos <span class="dim">${(c&&Array.isArray(c.list))?c.list.filter(x=>x.status==='done').length+'/'+reqs.length:reqs.length}</span></div>${rows}${checkBtn}`;
}
function fwHideMenu(){ const m=$id('fwMenu'); if(m){ m.style.display='none'; m.innerHTML=''; } }
// "/" lista os REQUISITOS (pedir revisão de um específico) · "@" referencia arquivos/artefatos
async function fwShowMenu(t, kind){
  const m=$id('fwMenu'); if(!m) return;
  let items=[];
  if(kind==='req'){
    for(const s of CHAT_SKILLS) items.push({label:'/'+s.label+' — '+s.desc, kind:'skill', skill:s});
    const ags=(t.roles||[]).filter(r=>r.engine==='claude');
    if(ags.length>1) for(const r of ags) items.push({label:r.name+' · '+(ROLE_PT[r.role]||r.role), kind:'falar com', agent:r.name});
    const reqs=Array.isArray(t.requirements)?t.requirements:[];
    for(const r of reqs) items.push({label:r, kind:'requisito', ins:null, req:r});
    if(reqs.length>1) items.push({label:'TODOS os requisitos (verificação completa)', kind:'ação', req:'__all__'});
  } else {
    let files=[]; let arts=[];
    try{ files=await invoke('task_files',{ taskId:t.id }); }catch(_){ }
    try{ arts=await invoke('list_artifacts',{ taskId:t.id }); }catch(_){ }
    items=[...files.slice(0,12).map(f=>({label:f.path, ins:f.path, kind:'arquivo'})),
           ...arts.filter(a=>a.name!=='requirements.json').slice(0,8).map(a=>({label:a.name, ins:'.cardume/artifacts/'+a.name, kind:'artefato'}))];
  }
  if(!items.length){ fwHideMenu(); return; }
  m.innerHTML=`<div class="ath">${kind==='req'?'skills · agentes · requisitos':'referenciar'}</div>`+items.map((it,i)=>`<button class="atit" data-mi="${i}"><span class="${kind==='req'?'':'mono'}"${it.kind==='skill'?' style="color:var(--accent)"':''}>${esc(it.label)}</span><span class="atk">${it.kind}</span></button>`).join('');
  m.style.display='block';
  m.querySelectorAll('.atit').forEach(b=>b.onclick=()=>{
    const it=items[+b.dataset.mi]; const i=$id('fwInput');
    if(it.skill){
      i.value='';
      fwHideMenu();
      fwSendText(t.id, it.skill.prompt());
      return;
    }
    if(it.agent){
      const t2=fwTaskObj();
      const deflt=((t2&&t2.roles)||[]).find(r=>r.engine==='claude');
      fwAgentSel = (deflt && it.agent===deflt.name) ? null : it.agent;
      i.value=i.value.replace(/[@/]$/,'');
      fwHideMenu(); renderWorkspace(); const ni=$id('fwInput'); if(ni) ni.focus();
      return;
    }
    if(kind==='req'){
      i.value = it.req==='__all__'
        ? 'Verifique TODOS os requisitos do TASK.yaml um a um: status real, evidência (print/teste) linkada e requirements.json atualizado; me pergunte se algum não estiver cumprido.'
        : `Revisar o requisito: "${it.req}" — confira se está REALMENTE cumprido; se não estiver, cumpra agora; e linke a evidência (print e/ou teste) no requirements.json.`;
    } else {
      i.value=i.value.replace(/[@/]$/,'')+'`'+it.ins+'` ';
    }
    fwHideMenu(); i.focus();
  });
}
async function fwSendText(taskId, text){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  try{
    const pend=pendingOf(t.id);
    if(pend.length){ await resolvePending(pend[0].id, text); }
    else { if(ACTIVE_ST.has(t.status)||t.status==='thinking'){ try{ await stopTask(t.id); }catch(_){ } } await invoke('talk_task',{ taskId:t.id, message:text, asReq:false, agent: fwAgentSel }); commitsCache[t.id]=undefined; prCache[t.id]=undefined; }
    artifactsCache[t.id]=undefined; reqProofCache[t.id]=undefined; lastSig=''; await refresh(); renderWorkspace();
  }catch(e){ alert('Falha ao enviar:\n'+e); }
}
const fwPend={}; // taskId → anexos importados ainda não enviados
async function fwSendMsg(queueOnly){
  const t=fwTaskObj(); if(!t) return;
  const inp=$id('fwInput'); let v=inp.value.trim();
  const atts=(fwPend[t.id]||[]).splice(0);
  if(!v && atts.length) v='Anexei estes arquivos — leia e considere.';
  if(!v) return;
  const sel=fwSelRange();
  // só amarra ao arquivo quando o usuário SELECIONOU linhas — mensagem sem seleção vai pura
  const ctx = sel ? `Sobre ${fwPath}:${sel.a}${sel.b>sel.a?'-'+sel.b:''}: ` : '';
  const asReq=!!($id('fwAsReq')&&$id('fwAsReq').checked);
  const full = ctx+v+attPromptBlock(atts);
  inp.value=''; inp.disabled=true;
  try{
    const pend=pendingOf(t.id);
    if(pend.length){
      // pergunta aberta → responder CONTINUA o mesmo turno
      await resolvePending(pend[0].id, full);
    } else if(!queueOnly && (ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy)){
      // trabalhando → para o turno atual (inclusive turno de fundo) e manda já
      try{ await stopTask(t.id); }catch(_){ }
      await invoke('talk_task',{ taskId:t.id, message:full, asReq, agent: fwAgentSel }); commitsCache[t.id]=undefined; prCache[t.id]=undefined;
    } else {
      // livre, ou o usuário escolheu "na fila" → o motor enfileira se ocupado
      await invoke('talk_task',{ taskId:t.id, message:full, asReq, agent: fwAgentSel }); commitsCache[t.id]=undefined; prCache[t.id]=undefined;
    }
    artifactsCache[t.id]=undefined; reqProofCache[t.id]=undefined;
    lastSig=''; await refresh();
  }catch(e){ alert('Falha ao enviar:\n'+e); }
  finally{ inp.disabled=false; renderWorkspace(); const i=$id('fwInput'); if(i) i.focus(); }
}
$id('fwClose').onclick=closeWorkspace;
$id('fwPush').onclick=async function(){
  const b=this, t=fwTaskObj(); if(!t) return;
  b.disabled=true; const o=b.innerHTML; b.textContent='enviando…';
  try{
    const msg=await invoke('push_task',{ taskId:t.id });
    b.textContent='✓ '+msg;
    prCache[t.id]=undefined; commitsCache[t.id]=undefined; lastSig='';
    setTimeout(()=>{ b.disabled=false; b.innerHTML=o; }, 4000);
  }catch(e){ alert('Commit & push falhou:\n'+e); b.disabled=false; b.innerHTML=o; }
};
$id('fwOverlay').addEventListener('click', e=>{ if(e.target.id==='fwOverlay') closeWorkspace(); });
$id('sumOverlay').addEventListener('click', e=>{ if(e.target.id==='sumOverlay') e.target.style.display='none'; });
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && $id('fwOverlay').style.display!=='none'){ if(fwEditing){ fwEditing=false; renderWorkspace(); } else closeWorkspace(); } });
// atualiza SÓ o "O que estou fazendo agora" ao vivo (não mexe no código/input)
// (o refresh de 1s chama fwLiveUpdate quando o workspace está aberto — sem timer duplicado)
