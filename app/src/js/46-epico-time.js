// Starfork — 46-epico-time: o ÉPICO do time abre como PÁGINA (aba, nunca modal): o envelope
// (Outcome, Requisitos, "Pronto quando" como checklist, Não muda), as tarefas por onda e o status.
// Regras (épico "Épico com Done when no planner", R6/R7):
//  - o checklist é marcável por quem criou o épico (ou owner/admin do time); o agente revisor marca pela
//    tool MCP (story 8) e aparece como "agente revisor";
//  - status: `open` → `in-progress` quando a 1ª tarefa roda (epicMarkInProgress, chamado por quem põe
//    uma tarefa em running) → `done` SÓ quando todos os itens do "pronto quando" estão marcados. O merge
//    da última tarefa nunca fecha o épico. Épico antigo (sem envelope) fecha por um botão explícito.
let epTab=null;        // épico aberto na aba ativa
const epCache={};      // epicId → { ep, tasks, loaded }
const EP_ST_PT={ open:'aberto', 'in-progress':'em andamento', done:'concluído', archived:'arquivado' };
// B6: "onda" explicada em uma linha (tooltip em todo lugar que a palavra aparece)
const EP_WAVE_TIP='onda = grupo de tarefas que rodam juntas; a próxima começa quando esta termina';
// F2: cor ESTÁVEL por épico (mesmo hash da cor de projeto, com prefixo pra não coincidir com ela)
function epColor(id){ return (typeof projColor==='function')?projColor('epic:'+String(id||'')):'var(--accent)'; }
// nome do épico por id: épicos do time (aba Time) → fila do quadro → página já aberta
function epNameOf(id){
  if(!id) return '';
  const e=((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(x=>x.id===id);
  return (e&&e.name) || ((epQueue&&epQueue.epicOf)||{})[id] || (((epCache[id]||{}).ep)||{}).name || '';
}
// F3: selo "[ícone épico] nome · onda N" (R8: o ◆ virou IC.epic) na tarefa LOCAL que veio de um épico (snapshot: t.epic.epicId/wave) — clique abre o épico
function epTaskBadge(t){
  const e=t&&t.epic, id=e&&e.epicId; if(!id) return '';
  const w=parseInt(e.wave,10)||0, nm=epNameOf(id)||'épico';
  return `<span class="tsepc epbadge" data-epbadge="${escA(id)}" style="--epc:${epColor(id)}" title="${escA('tarefa do épico “'+nm+'”'+(w?' · onda '+w+' ('+EP_WAVE_TIP+')':'')+' — clique pra abrir o épico')}"><span class="epic">${IC.epic}</span><span class="epn">${esc(nm.slice(0,60))}</span>${w?'<span class="epw"> · onda '+w+'</span>':''}</span>`;
}
// "criada por Fulano" na tarefa LOCAL que veio de um cartão de OUTRA pessoa (assumida no Time / fila do épico):
// acha o cartão da nuvem pelo sb:tmap (ou local_id) no que já está em memória (Time + irmãs dos épicos) — sem ida à rede.
let taskOriginIdx={ a:null, b:null, m:{} };
function taskOriginCard(t){
  if(!t) return null;
  const a=(typeof teamTasks!=='undefined'&&teamTasks)||null, b=(typeof epQueue!=='undefined'&&epQueue.sibsOf)||null;
  if(taskOriginIdx.a!==a || taskOriginIdx.b!==b){
    const m={}, put=c=>{ if(!c) return; m[c.id]=c; if(c.local_id) m['l:'+c.local_id]=c; };
    (a||[]).forEach(put); Object.values(b||{}).forEach(l=>(l||[]).forEach(put)); taskOriginIdx={ a, b, m };
  }
  const m=taskOriginIdx.m, cid=(typeof tmap==='function')?tmap()[t.id]:null;
  return (cid&&m[cid]) || m['l:'+t.id] || null;
}
function taskOriginHtml(t){
  const ct=taskOriginCard(t); const w=ct?ctWhoLabel(ct, cloudUserId(), tmName):'';
  return w?`<span class="dc-who" title="${escA('cartão do time — '+w)}">${esc(w)}</span>`:'';
}
window.taskOriginHtml=taskOriginHtml;
// R5-2: A regra ÚNICA de "entregue" no progresso de épico (página, cabeçalho da fila, KPI, Time):
// mergeada/concluída/finalizada. Pronta pra revisar e PR aberto ainda NÃO contam (aparecem como "em revisão").
// Aceita cartão da nuvem (tem team_id → status efetivo via tsSt, que usa a tarefa local se houver) ou tarefa local.
function epEffSt(t){ if(!t) return ''; return ('team_id' in t && typeof tsSt==='function') ? tsSt(t) : taskSt(t); }
function epDelivered(t){ const st=epEffSt(t); return ['merged','done','closed'].includes(st); }
function epInReview(t){ return ['review','delivered','pr-open'].includes(epEffSt(t)); }
window.epColor=epColor; window.epNameOf=epNameOf; window.epTaskBadge=epTaskBadge; window.epDelivered=epDelivered;

function openEpicPage(ep){
  if(!ep||!ep.id) return;
  const id='epic:'+ep.id;
  let tab=tabById(id);
  if(!tab){ tab={ id, kind:'epic', ep, title:(ep.name||'Épico').slice(0,26) }; TABS.push(tab); }
  else tab.ep=ep;
  activateTab(id);
}
window.openEpicPage=openEpicPage;
function epicPageOpenInner(tab){
  const ep=tab&&tab.ep; if(!ep) return;
  epTab=ep;
  $id('epicOverlay').style.display='flex';
  epicPageRender(); // abre na hora com o que o quadro já tinha; a nuvem completa em seguida
  epicPageLoad(ep.id).then(()=>{ if(epTab&&epTab.id===ep.id) epicPageRender(); });
}
window.epicPageOpenInner=epicPageOpenInner;

async function epicPageLoad(id){
  let tasksErr=null;
  const [fresh, tasks]=await Promise.all([
    sbGet('epics?select=*&id=eq.'+id).then(r=>(r&&r[0])||null).catch(()=>null),
    // linha completa: a página agora tem "▶ iniciar" por tarefa (teamClaimStart precisa do cartão inteiro)
    sbGet('tasks?select=*&epic_id=eq.'+id+'&order=created_at').catch(e=>{ tasksErr=e||new Error('falha'); return null; }),
  ]);
  const c=epCache[id]||{ ep:null, tasks:[], loaded:false }; epCache[id]=c;
  if(tasks) c.tasks=tasks;
  c.err=tasks?null:tasksErr; // falhou a leitura: a página mostra o erro com "tentar de novo" (antes dizia "nenhuma tarefa neste épico")
  if(fresh){
    c.ep=fresh;
    if(epTab&&epTab.id===id) epTab={ ...epTab, ...fresh };
    const i=(teamEpics||[]).findIndex(e=>e.id===id); if(i>=0) teamEpics[i]={ ...teamEpics[i], ...fresh };
    const tab=tabById('epic:'+id); if(tab){ tab.ep={ ...(tab.ep||{}), ...fresh }; if(fresh.name) tab.title=fresh.name.slice(0,26); }
  }
  c.loaded=true;
  return c;
}
function epCanCheck(ep){
  const me=cloudUserId();
  return !!me && (ep.created_by===me || (typeof cloudData!=='undefined'&&cloudData&&(cloudData.meRole==='owner'||cloudData.meRole==='admin')));
}
function epWho(by){
  if(!by) return '';
  if(String(by).startsWith('agent:')) return 'agente revisor <span class="mono">('+esc(String(by).slice(6))+')</span>';
  return esc(tmName(by));
}
function epicPageRender(){
  const ep=epTab; if(!ep) return;
  const main=$id('epicPageMain'); if(!main) return;
  const c=epCache[ep.id]||{ tasks:[], loaded:false };
  const sp=ep.spec||{};
  const dw=Array.isArray(sp.doneWhen)?sp.doneWhen:[], reqs=Array.isArray(sp.requirements)?sp.requirements:[], bounds=Array.isArray(sp.boundaries)?sp.boundaries:[];
  const conv=Array.isArray(sp.conversation)?sp.conversation:[];
  const legacy=!sp.outcome && !dw.length && !reqs.length; // épico antigo (só nome): continua válido
  const okN=dw.filter(d=>d&&d.checkedBy).length;
  const tasks=c.tasks||[];
  const isDone=epDelivered, isRev=epInReview; // R5-2: mesma regra de "entregue" do Time e da fila
  const doneN=tasks.filter(isDone).length, revN=tasks.filter(isRev).length; // R3-C2: "entregues" = mergeadas/concluídas (mesma conta do cabeçalho do épico na Central)
  const can=epCanCheck(ep);
  // tarefas por onda (wave gravada no spec ao aprovar o card; tarefa antiga cai na onda 1)
  const waveOf=t=>Math.max(1, parseInt((t.spec||{}).wave,10)||1);
  const byWave={}; tasks.forEach(t=>{ const w=waveOf(t); (byWave[w]=byWave[w]||[]).push(t); });
  const waves=Object.keys(byWave).map(Number).sort((a,b)=>a-b);
  const curWave=waves.find(w=>byWave[w].some(t=>!isDone(t)&&!isRev(t)))||0; // 1ª onda que ainda tem trabalho
  // pré-requisito ainda aberto = irmã do épico citada em spec.after que não foi concluída/mergeada
  const sib={}; tasks.forEach(t=>{ sib[t.id]=t; });
  const depsOpen=t=>((t.spec||{}).after||[]).filter(a=>sib[a]&&!isDone(sib[a]));
  // R3-C2: UMA ação primária na lista inteira = a próxima recomendada (revisar libera a onda seguinte; depois a
  // 1ª tarefa pronta pra começar; depois olhar o problema). O resto é secundário, e "iniciar mesmo assim" é ghost.
  const ordered=waves.flatMap(w=>byWave[w]);
  const nextT=ordered.find(isRev) || ordered.find(t=>t.status==='backlog'&&!depsOpen(t).length) || ordered.find(t=>stIsBad(epEffSt(t)));
  const pri=t=>(nextT&&t.id===nextT.id)?' primary':'';
  // "prova" genérica ("prova definida no épico") e o "prova:" repetido não dizem nada — some
  const verifyTx=v=>{ const x=String(v||'').trim().replace(/^prova\s*:?\s*/i,''); return /^(definida|a definir|ver) no épico\.?$/i.test(x)?'':x; };
  const CODE_TIP='R = requisito do épico · D = critério de "pronto quando"';
  // A1: ícone/cor do STATUS_META — revisão = ◆ na cor de revisão; erro/conflito = ! crítico; resto neutro
  const taskRow=t=>{ const s=t.spec||{}; const est=epEffSt(t); const dn=isDone(t), rv=isRev(t), bad=stIsBad(est);
    const left=t.status==='backlog'?depsOpen(t):[];
    // A4: "na espera de X" = esperando OUTRA tarefa (nunca "aguardando", que é reservado pra quando depende de você)
    const stTx = est==='closed' ? stLabel('closed')
      : left.length ? 'na espera de '+left.map(a=>'<b>'+esc(String(sib[a].title||'tarefa').slice(0,40))+'</b>').join(', ')+(ctWaiting(t)?' · começa sozinha':'')
      : esc(stLabel(est));
    // M8: a próxima ação de cada linha, direto aqui
    const act = t.status==='backlog'
        ? (left.length ? `<button class="btn sm ghost" data-epgo="${escA(t.id)}" title="ainda depende de ${left.length} tarefa(s) — assumir e iniciar agora mesmo assim">iniciar mesmo assim</button>`
                       : `<button class="btn sm${pri(t)}" data-epgo="${escA(t.id)}" title="assumir e iniciar agora nesta máquina">▶ iniciar</button>`)
      : rv ? (est==='pr-open' ? `<button class="btn sm${pri(t)}" data-eprev="${escA(t.id)}" title="PR aberto — abrir a entrega e o PR">ver o PR</button>`
                              : `<button class="btn sm${pri(t)}" data-eprev="${escA(t.id)}" title="abrir a entrega pra revisar">revisar</button>`)
      : bad ? `<button class="btn sm${pri(t)}" data-eprev="${escA(t.id)}" title="abrir a tarefa pra ver o erro">ver o problema</button>` : '';
    const vtx=verifyTx(s.verify), cov=(Array.isArray(s.covers)&&s.covers.length)?s.covers:[];
    return `<div class="ep-task" data-ept="${escA(t.id)}" tabindex="0" title="${escA('abrir '+t.title+' — Enter')}"><span class="reqst ${dn?'ok':rv?'rev':bad?'blk':'na'}" title="${escA(stLabel(est))}">${dn?IC.check:stIcon(est)}</span><div class="en-rt">
      <div><b>${esc(t.title)}</b> <span class="dim" style="font-size:var(--fs-xs)">· ${stTx}${(()=>{ const me=cloudUserId(), w=[ctWhoLabel(t, me, tmName), t.assignee&&t.assignee===me?'com você':''].filter(Boolean).join(' · '); return w?' · '+esc(w):''; })()}</span></div>
      ${vtx||cov.length?`<div class="ep-verify">${vtx?IC.ok+' prova: '+esc(vtx):''}${cov.length?` <span class="mono dim ep-code" title="${escA('cobre '+cov.join(', ')+' — '+CODE_TIP)}">cobre ${esc(cov.join(' '))}</span>`:''}</div>`:''}
    </div>${act?`<div class="ep-acts">${act}</div>`:''}</div>`; };
  // R5-2: "x/y entregues · z em revisão" — a onda atual ainda avança com revisão (comportamento mantido),
  // mas o número só conta entregue de verdade (antes "1/3" numa onda sem nada mergeado contradizia o 0/7)
  const waveHead=w=>{ const l=byWave[w], ok=l.filter(isDone).length, rvN=l.filter(isRev).length;
    return `<div class="ep-wave${w===curWave?' cur':''}" title="${escA(EP_WAVE_TIP)}">ONDA ${w} · ${ok}/${l.length} entregues${rvN?' · '+rvN+' em revisão':''}${ok===l.length?' ✓':w===curWave?' · atual':''}</div>`; };
  const tasksHtml = tasks.length
    ? waves.map(w=>`${waveHead(w)}${byWave[w].map(taskRow).join('')}`).join('')
    : c.err ? errorHtml(c.err, 'epTasksRetry', 'Não consegui carregar as tarefas do épico')
    : `<div class="en-empty">${c.loaded?'nenhuma tarefa neste épico ainda':skeletonHtml('lista',{ n:4, compact:true, inline:true, label:'carregando as tarefas do épico' })}</div>`;
  const dwHtml = dw.length
    ? dw.map((d,i)=>`<label class="ep-dw${d.checkedBy?' ok':''}"><input type="checkbox" data-epdw="${i}" ${d.checkedBy?'checked':''}${can?'':' disabled'}><span class="en-rt">
        <div><span class="mono dim ep-code" title="${escA(CODE_TIP)}">${esc(d.id||('D'+(i+1)))}</span> ${esc(d.text||'')}</div>
        ${d.checkedBy?`<div class="ep-dwby">marcado por ${epWho(d.checkedBy)}${d.checkedAt?' · há '+agoTx(d.checkedAt):''}${d.evidence?' · '+esc(d.evidence):''}</div>`:''}
      </span></label>`).join('')
    : `<div class="en-empty">${legacy?'épico antigo, sem "pronto quando"':'sem checagens definidas'}${ep.status==='done'?' — já está concluído':can?' — ele fecha pelo botão abaixo':' — quem criou o épico (ou um admin) fecha quando terminar'}</div>`;
  // R3-C2: status aparece UMA vez (sobretítulo); os números viram uma faixa compacta ABAIXO da descrição
  // (antes eram 5 blocos ao lado, apertando o texto, e "em andamento" aparecia 3 vezes)
  main.innerHTML=`<div class="enpage">
    <div class="en-head">
      <div class="en-ht">
        <span class="ndeyebrow">épico do time · <span class="ep-st ep-st-${escA(ep.status||'open')}">${esc(EP_ST_PT[ep.status]||ep.status||'')}</span></span>
        <h2 class="en-h1">◆ ${esc(ep.name||'Épico')}</h2>${typeof aeEpicBadge==='function'?aeEpicBadge(sp):''}
        ${sp.outcome?`<p class="en-obj">${esc(sp.outcome)}</p>`:''}
        ${sp.description?`<p class="en-obj dim" style="font-size:var(--fs-sm)">${esc(sp.description)}</p>`:''}
        <div class="en-kpis ep-kpis">
          ${sp.issue&&sp.issue.code?`<button class="en-kpi" ${sp.issue.url?`data-lk="${escA(sp.issue.url)}" title="abrir a issue do épico no painel"`:'disabled'}><b>${esc(sp.issue.code)}</b><span>issue${sp.issue.url?' ↗':''}</span></button>`:''}
          ${dw.length?`<div class="en-kpi" title="${escA(okN+' de '+dw.length+' critérios de pronto marcados — o épico fecha com todos')}"><b>${okN}/${dw.length}</b><span>pronto quando</span></div>`:''}
          ${c.err&&!tasks.length?'':`<div class="en-kpi" title="${escA(doneN+" de "+tasks.length+" tarefas mergeadas ou concluídas"+(revN?" · "+revN+" em revisão (pronta pra revisar ou PR aberto)":""))}"><b>${doneN}/${tasks.length}</b><span>tarefas entregues</span></div>`}
          ${curWave?`<div class="en-kpi" title="${escA(EP_WAVE_TIP)}"><b>${curWave}/${waves.length}</b><span>onda atual</span></div>`:''}
        </div>
        <div class="ctp-who">${tsAv(ep.created_by, tsOnline(ep.created_by))}<span>criado por <b>${esc(tmName(ep.created_by))}</b>${ep.created_at?' · há '+agoTx(ep.created_at):''}</span></div>
      </div>
    </div>
    <div class="en-grid">
      <section class="en-sec">
        <div class="seclbl2">Pronto quando <span class="dim">· D1, D2… = critérios; o épico só fecha com tudo marcado${can?'':' · só quem criou (ou admin) marca'}</span></div>${dwHtml}
        ${reqs.length?`<div class="seclbl2" style="margin-top:14px">Requisitos <span class="dim">· R1, R2… = requisitos (as tarefas dizem quais cobrem)</span></div>${reqs.map(r=>`<div class="en-del"><span class="mono dim ep-code" title="${escA(CODE_TIP)}">${esc(r.id||'')}</span> ${esc(r.text||'')}</div>`).join('')}`:''}
        ${bounds.length?`<div class="seclbl2" style="margin-top:14px">Não muda</div>${bounds.map(b=>`<div class="en-del">⊘ ${esc(b)}</div>`).join('')}`:''}
        ${typeof aeEpicHistHtml==='function'?aeEpicHistHtml(sp, can, tasks, ep.id):''}
        ${can&&tasks.some(t=>t.status==='backlog'&&Array.isArray((t.spec||{}).after)&&(t.spec||{}).after.length&&!(t.spec||{}).autoStart)?`<div style="margin-top:14px"><button class="btn sm" id="epAutoOn" title="cada tarefa começa sozinha, nesta máquina, quando as de que ela depende forem mergeadas">${IC.clock} próximas ondas começam sozinhas</button></div>`:''}
        ${!dw.length&&ep.status!=='done'&&can?`<div style="margin-top:14px"><button class="btn sm" id="epLegacyDone">✓ marcar épico como concluído</button></div>`:''}
      </section>
      <section class="en-sec"><div class="seclbl2">Tarefas <span class="dim" title="${escA(EP_WAVE_TIP)}">· por onda (a próxima começa quando esta termina); clique pra abrir</span></div>${tasksHtml}</section>
    </div>
    ${conv.length?`<details class="en-sec ep-conv"><summary class="seclbl2">Conversa que originou o épico <span class="dim">· ${conv.length} mensage${conv.length===1?'m':'ns'} do "montar conversando"</span></summary>
      ${conv.map(m=>`<div class="plmsg ${m.who==='you'?'you':'bot'}">${m.who==='bot'?'<span class="plav">'+IC.starfork+'</span>':''}<div class="plbub">${m.who==='bot'?mdToHtml(String(m.text||'')):esc(m.text||'')}</div></div>`).join('')}</details>`:''}
  </div>`;
  main.querySelectorAll('[data-epdw]').forEach(cb=>cb.onchange=()=>epicToggleDone(ep, +cb.dataset.epdw, cb.checked));
  main.querySelectorAll('[data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  main.querySelectorAll('[data-ept]').forEach(r=>{ r.onclick=(e)=>{ if(e.target.closest('[data-epgo],[data-eprev]')) return; const t=(c.tasks||[]).find(x=>x.id===r.dataset.ept); if(t&&window.openCloudTaskPage) openCloudTaskPage(t); };
    r.onkeydown=(e)=>{ if((e.key==='Enter'||e.key===' ')&&e.target===r){ e.preventDefault(); r.onclick(e); } }; });
  if(c.err && !tasks.length) ldWireErr(main, c.err, 'Não consegui carregar as tarefas do épico', ()=>{ c.err=null; c.loaded=false; epicPageRender(); epicPageLoad(ep.id).then(()=>{ if(epTab&&epTab.id===ep.id) epicPageRender(); }); });
  main.querySelectorAll('[data-eprev]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const t=(c.tasks||[]).find(x=>x.id===b.dataset.eprev); if(t&&window.openCloudTaskPage) openCloudTaskPage(t); });
  main.querySelectorAll('[data-epgo]').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); const t=(c.tasks||[]).find(x=>x.id===b.dataset.epgo); if(!t) return;
    await epCardStart(t, b); await epicPageLoad(ep.id); if(epTab&&epTab.id===ep.id) epicPageRender(); });
  main.querySelectorAll('[data-epundo]').forEach(b=>b.onclick=()=>{ if(window.aeEpicUndo) aeEpicUndo(ep, b.dataset.epundo); });
  bindClick('epLegacyDone', ()=>epicSetStatus(ep,'done'));
  bindClick('epAutoOn', ()=>epicAutoOn(ep));
  { const h=$id('epicPageName'); if(h) h.textContent=ep.name||'Épico'; const s=$id('epicPageSub'); if(s) s.textContent=''; } // status já está no sobretítulo da página
}
async function epicPatch(ep, body){
  body.updated_at=new Date().toISOString();
  await sbFetch('/rest/v1/epics?id=eq.'+ep.id,{ method:'PATCH', body: JSON.stringify(body) });
  await epicPageLoad(ep.id);
  if(epTab&&epTab.id===ep.id) epicPageRender();
  teamTasks=null; teamPaintSig=''; if(typeof renderTeamBoard==='function') renderTeamBoard();
}
// marca/desmarca um item do "pronto quando"; com tudo marcado o épico fecha; desmarcar reabre (não há botão "reabrir" — a regra é só essa)
let epDwBusy=false; // um PATCH do checklist por vez: dois cliques rápidos liam o mesmo spec e o 2º apagava o 1º
async function epicToggleDone(ep, idx, on){
  if(epDwBusy) return; epDwBusy=true;
  document.querySelectorAll('#epicPageMain [data-epdw]').forEach(x=>{ x.disabled=true; });
  try{ await epicToggleDoneRun(ep, idx, on); }
  finally{ epDwBusy=false; // sempre destrava: redesenha a página do épico (se ainda é ela) ou só reabilita os checkboxes
    if(epTab&&epTab.id===ep.id) epicPageRender(); else document.querySelectorAll('#epicPageMain [data-epdw]').forEach(x=>{ x.disabled=false; }); }
}
async function epicToggleDoneRun(ep, idx, on){
  // parte do spec FRESCO da nuvem: outro membro ou o agente revisor podem ter marcado itens enquanto a aba ficou aberta
  try{ const f=(await sbGet('epics?select=spec,status&id=eq.'+ep.id))[0]; if(f){ ep={ ...ep, ...f }; } }catch(_){ }
  const spec={ ...(ep.spec||{}) }; const dw=(Array.isArray(spec.doneWhen)?spec.doneWhen:[]).map(d=>({ ...d }));
  if(!dw[idx]){ epicPageRender(); return; }
  if(on){ dw[idx].checkedBy=cloudUserId(); dw[idx].checkedAt=new Date().toISOString(); }
  else { delete dw[idx].checkedBy; delete dw[idx].checkedAt; delete dw[idx].evidence; }
  spec.doneWhen=dw;
  const all=dw.length>0 && dw.every(d=>d.checkedBy);
  const c=epCache[ep.id]; const started=!!(c&&(c.tasks||[]).some(t=>t.status!=='backlog'));
  const status= all ? 'done' : (ep.status==='done' ? (started?'in-progress':'open') : ep.status);
  try{ await epicPatch(ep, { spec, status }); }
  catch(e){ showErr(e, 'Não consegui salvar a marcação'); epicPageRender(); }
}
async function epicSetStatus(ep, status){ try{ await epicPatch(ep, { status }); }catch(e){ showErr(e, 'Falha'); } }
// 1ª tarefa rodando → épico em andamento. Só sai de `open` (nunca reabre um `done` sozinho).
async function epicMarkInProgress(epicId){
  if(!epicId) return;
  try{
    await sbFetch('/rest/v1/epics?id=eq.'+epicId+'&status=eq.open',{ method:'PATCH', body: JSON.stringify({ status:'in-progress', updated_at:new Date().toISOString() }) });
    const e=(teamEpics||[]).find(x=>x.id===epicId); if(e&&e.status==='open') e.status='in-progress';
  }catch(_){ }
}
window.epicMarkInProgress=epicMarkInProgress;
// ---- Contexto compilado do épico (CAP-6): EPIC.md que vai como REFERÊNCIA da tarefa ao assumir ----
// Regras (bmad-build/compile-epic-context): só o que quem faz qualquer tarefa do épico precisa, descrito por
// propósito, sem copiar documentos; 800 a 1500 tokens. O motor não fala com a Supabase, então é o app que monta.
const epCut=(s,n)=>{ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'…':s; };
async function epicCompileContext(epicId, forTask){
  let ep=(teamEpics||[]).find(e=>e.id===epicId)||null;
  try{ const f=(await sbGet('epics?select=id,name,status,spec,created_by&id=eq.'+epicId))[0]; if(f) ep={ ...(ep||{}), ...f }; }catch(_){ }
  if(!ep||!ep.name) return '';
  let sibs=null; if(cloudEpicId(epicId)) try{ sibs=await sbGet('tasks?select=id,local_id,title,status,assignee,spec,created_at&epic_id=eq.'+epicId+'&order=created_at'); }catch(_){ sibs=null; }
  if(!Array.isArray(sibs)||!sibs.length) sibs=(teamTasks||[]).filter(t=>t.epic_id===epicId);
  const sp=ep.spec||{}; const dw=Array.isArray(sp.doneWhen)?sp.doneWhen:[], reqs=Array.isArray(sp.requirements)?sp.requirements:[], bounds=Array.isArray(sp.boundaries)?sp.boundaries:[];
  const stPt=s=>stLabel(s);
  const byId={}; sibs.forEach(t=>{ byId[t.id]=t; });
  const L=['# Épico: '+epCut(ep.name,90), '', '<!-- Compilado pelo Starfork ao assumir a tarefa. Descreve por propósito; o código é a fonte do resto. -->', '',
    'id do épico: '+ep.id+' — a ideia mudou? atualize com mcp__cardume__edit_epic (épico) / mcp__cardume__edit_task (irmãs, pelo id abaixo; requisito se remove pelo TEXTO e vira proposta). Nenhum agente é acionado.', ''];
  L.push('## Objetivo', epCut(sp.outcome||sp.description||('Épico do time "'+ep.name+'".'),400)); if(sp.outcome&&sp.description) L.push(epCut(sp.description,300)); L.push('');
  if(reqs.length){ L.push('## Requisitos do épico'); reqs.slice(0,12).forEach(r=>L.push('- '+(r.id||'R?')+': '+epCut(r.text,200))); L.push(''); }
  if(dw.length){ L.push('## Pronto quando (o épico só fecha com tudo marcado)'); dw.slice(0,8).forEach((d,i)=>L.push('- '+(d.checkedBy?'[x]':'[ ]')+' '+(d.id||('D'+(i+1)))+': '+epCut(d.text,200))); L.push(''); }
  if(bounds.length){ L.push('## Não muda'); bounds.slice(0,8).forEach(b=>L.push('- '+epCut(b,160))); L.push(''); }
  if(sibs.length){
    L.push('## Tarefas do épico (as irmãs rodam em paralelo — fique no seu escopo)');
    sibs.slice(0,15).forEach(t=>{ const s=t.spec||{}; const me=!!(forTask&&t.id===forTask.id);
      const dep=(Array.isArray(s.after)?s.after:[]).map(a=>byId[a]?epCut(byId[a].title,40):'').filter(Boolean);
      const sid=(t.local_id&&!String(t.local_id).startsWith('card-'))?t.local_id:t.id; // iniciada: id local (o motor acha aqui); no backlog: id do cartão
      L.push('- '+(me?'**ESTA → **':'')+epCut(t.title,80)+' · id '+sid+' · onda '+(parseInt(s.wave,10)||1)+' · '+stPt(t.status)+(s.verify?' · prova: '+epCut(s.verify,120):'')+(Array.isArray(s.covers)&&s.covers.length?' · cobre '+s.covers.join(','):'')+(dep.length?' · depois de: '+dep.join('; '):'')+(s.owns?' · escopo: '+epCut(s.owns,60):'')+(Array.isArray(s.requirements)&&s.requirements.length&&!me?' · requisitos: '+s.requirements.slice(0,6).map(r=>epCut(r,70)).join(' | '):'')); });
    L.push('');
  }
  const notes=Array.isArray(sp.notes)?sp.notes:[]; if(notes.length){ L.push('## Decisões e pendências'); notes.slice(0,8).forEach(n=>L.push('- '+epCut((n&&n.kind?n.kind+': ':'')+(n&&n.text||n),200))); L.push(''); }
  if(!reqs.length&&!dw.length&&!sp.outcome) L.push('_Épico antigo, sem envelope: só o nome e as tarefas acima._');
  // orçamento (~1200 a 1600 tokens): corta por LINHA a partir do fim, nunca no meio de uma frase
  const MAX=5200; let out=L.join('\n');
  if(out.length>MAX){ const keep=[]; let n=0; for(const l of L){ if(n+l.length+1>MAX-90) break; keep.push(l); n+=l.length+1; }
    while(keep.length && /^(## |$)/.test(keep[keep.length-1])) keep.pop(); // sem cabeçalho órfão no fim
    out=keep.join('\n')+'\n\n_(contexto cortado por tamanho — o restante está no épico do time)_'; }
  return out;
}
// grava o EPIC.md em .cardume/tmp/refs/ (Rust, nome exato) e devolve o caminho pra entrar em `refs` do new_task
async function epicRefFor(epicId, forTask){
  if(!epicId) return null;
  try{
    const md=await epicCompileContext(epicId, forTask); if(!md) return null;
    const path=await invoke('write_ref_file',{ name:'EPIC.md', text:md }); // nome exato: o prompt cita .cardume/refs/EPIC.md
    return path||null;
  }catch(e){ console.warn('EPIC.md não gerado', e&&e.message||e); return null; }
}
// acrescenta o EPIC.md aos refs do payload (só caminhos absolutos entram; basenames do spec da nuvem não)
async function epicAttachRef(payload, epicId, forTask){
  const p=await epicRefFor(epicId, forTask); if(!p) return payload;
  const refs=(Array.isArray(payload.refs)?payload.refs:[]).filter(r=>typeof r==='string'&&r.startsWith('/'));
  payload.refs=[...refs, p]; return payload;
}
window.epicAttachRef=epicAttachRef;
// Espelho local→nuvem das marcas do agente revisor (tool mcp__cardume__check_done_when grava em
// tasks.spec.epicChecks; o snapshot expõe em t.epic.epicChecks). Cada marca vai UMA vez (localStorage),
// com checkedBy = "agent:<tarefa local>"; com tudo marcado o épico fecha, igual ao clique humano.
const epMirrorInFlight=new Set();
// marcas já espelhadas: POR CONTA (40-conta-escopo) — a de outra conta não vale aqui
const epMirroredKey=()=>userKey('ep:mirrored', cloudUserId());
function epMirroredSet(){ try{ return new Set(JSON.parse(lsGet(epMirroredKey())||'[]')); }catch(_){ return new Set(); } }
async function epicMirrorChecks(t){
  const ep=t.epic||{}; const epicId=ep.epicId; const checks=Array.isArray(ep.epicChecks)?ep.epicChecks:[];
  if(!epicId||!checks.length||epMirrorInFlight.has(t.id)||!cloudScopeOk()) return;
  const done=epMirroredSet(); const pend=checks.filter(c=>c&&c.id&&!done.has(t.id+'|'+c.id));
  if(!pend.length) return;
  epMirrorInFlight.add(t.id);
  try{
    const fresh=(await sbGet('epics?select=id,spec,status&id=eq.'+epicId))[0];
    if(!fresh){ pend.forEach(c=>done.add(t.id+'|'+c.id)); lsSet(epMirroredKey(), JSON.stringify([...done].slice(-500))); return; } // épico apagado: não fica tentando pra sempre
    const spec={ ...(fresh.spec||{}) }; const dw=(Array.isArray(spec.doneWhen)?spec.doneWhen:[]).map(d=>({ ...d }));
    let changed=false;
    for(const c of pend){
      const i=dw.findIndex((d,k)=>String(d.id||('D'+(k+1))).toUpperCase()===String(c.id).toUpperCase());
      if(i<0) continue; // item que não existe mais no épico: ignora
      if(!dw[i].checkedBy){ dw[i].checkedBy='agent:'+t.id; dw[i].checkedAt=c.at||new Date().toISOString(); dw[i].evidence=String(c.evidence||'').slice(0,300); changed=true; }
      else if(!dw[i].evidence && c.evidence){ dw[i].evidence=String(c.evidence).slice(0,300); changed=true; } // humano marcou antes: guarda a prova do agente
    }
    if(changed){
      spec.doneWhen=dw;
      const all=dw.length>0 && dw.every(d=>d.checkedBy);
      const body={ spec, updated_at:new Date().toISOString() }; if(all) body.status='done';
      await sbFetch('/rest/v1/epics?id=eq.'+epicId,{ method:'PATCH', body: JSON.stringify(body) });
      if(epTab&&epTab.id===epicId){ await epicPageLoad(epicId); epicPageRender(); }
      teamTasks=null; teamPaintSig='';
    }
    pend.forEach(c=>done.add(t.id+'|'+c.id)); lsSet(epMirroredKey(), JSON.stringify([...done].slice(-500)));
  }catch(e){ console.warn('espelho do pronto quando falhou', e&&e.message||e); }
  finally{ epMirrorInFlight.delete(t.id); }
}
window.epicMirrorChecks=epicMirrorChecks;
bindClick('epicPageClose', ()=>closeTabOfKind('epic'));
bindClick('epicPageRefresh', ()=>{ if(epTab){ const b=$id('epicPageRefresh'); if(b) b.disabled=true; epicPageLoad(epTab.id).then(()=>{ epicPageRender(); if(b) b.disabled=false; }); } });
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const o=$id('epicOverlay'); const cur=tabById(activeTab);
  if(o&&o.style.display!=='none'&&cur&&cur.kind==='epic'&&!escBusy(e)){ e.stopImmediatePropagation(); closeTabOfKind('epic'); }
}, true);

// ---- FILA DOS ÉPICOS: aparece no quadro de Tarefas + ondas seguintes começam sozinhas ----
// Cartão de épico no backlog do time é só NUVEM (não está no state.sqlite) — sem isto ele só aparecia
// na aba Time/épico. A cada 20s: busca o backlog dos épicos do time, pinta a seção "Na fila dos épicos"
// no quadro (epBoardHtml) e inicia sozinha a tarefa com spec.autoStart cujos pré-requisitos (spec.after)
// estão TODOS mergeados — só em cartão MEU (ctMineFor: atribuído a mim, ou sem responsável e criado por mim) e do
// projeto aberto (claim_task ainda protege de corrida). A fila da Central mostra só o que é meu e de projeto que
// existe nesta máquina (ctExecOk); o resto do backlog do time mora na aba Time.
const EP_AUTO_READY=new Set(['merged','done']);
let epAutoBusy=false, epAutoIdle=false; const epAutoWarned=new Set();
let epQueue={ rows:[], stOf:{}, flagOf:{}, titleOf:{}, epicOf:{}, projOf:{}, progOf:{}, sibsOf:{}, here:'', localIds:[], at:0 };
// pronta = mergeada/concluída OU FINALIZADA (flag closed): finalizar é o "terminei" do usuário — antes só merged/done
// contava e a onda seguinte nunca começava depois de você finalizar a anterior (24/09)
function epDepDone(a){ const q=epQueue; return EP_AUTO_READY.has(q.stOf[a]) || q.flagOf[a]==='closed'; }
function epDepsLeft(ct){ const q=epQueue; return ((ct.spec||{}).after||[]).filter(a=>(a in q.stOf) && !epDepDone(a)); }
async function epicAutoStartTick(){
  if(epAutoBusy || !SB.sess() || !cloudTeamId() || !cloudScopeOk()) return;
  epAutoBusy=true;
  try{
    const rows=await sbGet('tasks?select=*&team_id=eq.'+cloudTeamId()+'&status=eq.backlog&epic_id=not.is.null&order=created_at.asc')||[];
    const dep=[...new Set(rows.flatMap(t=>Array.isArray((t.spec||{}).after)?t.spec.after:[]))];
    const eids=[...new Set(rows.map(t=>t.epic_id))], pids=[...new Set(rows.map(t=>t.project_id).filter(Boolean))];
    // nomes: épicos da fila + épicos das tarefas LOCAIS já iniciadas (selo "◆ nome · onda N" no quadro)
    const localEids=[...new Set(((typeof state!=='undefined'&&state.tasks)||[]).map(t=>cloudEpicId(t.epic&&t.epic.epicId)).filter(Boolean))]; // só épicos da nuvem (uuid)
    epAutoIdle=!rows.length && !localEids.length; // nada de épico por aqui → o laço desacelera (60s)
    const nameIds=[...new Set(eids.concat(localEids))].slice(0,40);
    // progresso por épico da fila (cabeçalho "x/y entregues · onda N"): uma consulta leve por tick
    // R3-C1: a linha inteira (título/local_id) — o cabeçalho do grupo resume o épico TODO com um ponto por tarefa
    // inclui os épicos só com tarefas LOCAIS em andamento (fila vazia): sem isso o resumo "Épicos em andamento" contava só esta máquina
    const sibIds=[...new Set(eids.concat(localEids))].slice(0,20);
    // as 4 consultas seguintes só dependem da fila → em paralelo (antes: em série, até 6 idas e voltas)
    const [deps, eps, sibs, projs]=await Promise.all([
      dep.length?sbGet('tasks?select=id,title,status,flag,local_id,pr_url,team_id&id=in.('+dep.join(',')+')').then(x=>x||[]):[],
      nameIds.length?sbGet('epics?select=id,name&id=in.('+nameIds.join(',')+')').then(x=>x||[]):[],
      sibIds.length?sbGet('tasks?select=*&epic_id=in.('+sibIds.join(',')+')&order=created_at.asc').then(x=>x||[]).catch(()=>[]):[],
      pids.length?sbGet('projects?select=id,name,repo_remote&id=in.('+pids.join(',')+')').then(x=>x||[]):[],
    ]);
    const progOf={}, sibsOf={};
    sibs.forEach(t=>{ (sibsOf[t.epic_id]=sibsOf[t.epic_id]||[]).push(t); const p=progOf[t.epic_id]||(progOf[t.epic_id]={ n:0, ok:0, wave:0 });
      const ok=epDelivered(t); p.n++; if(ok) p.ok++; // R5-2: regra única de entregue
      const w=Math.max(1, parseInt((t.spec||{}).wave,10)||1); if(!ok && (!p.wave || w<p.wave)) p.wave=w; });
    const hereIds=await repoRemoteIds(), here=hereIds.remote;
    const localIds=await localRemoteIdsList().catch(()=>[]); // projetos desta máquina: cartão de projeto que não tenho não entra na Execução
    const sig=JSON.stringify([rows.map(r=>r.id+(r.spec&&r.spec.autoStart?'a':'')), deps.map(d=>d.id+d.status+(d.flag||'')), here, localIds.map(x=>x.remote), eps.map(e=>e.id+e.name), progOf, sibs.map(t=>t.id+t.status+(t.flag||'')+(t.pr_url?'p':''))]);
    const changed=sig!==epQueue.sig;
    epQueue={ rows, here, hereIds, localIds, sig, at:Date.now(), progOf, sibsOf,
      stOf:Object.fromEntries(deps.map(d=>[d.id,d.status])), effOf:Object.fromEntries(deps.map(d=>[d.id,epEffSt(d)])), flagOf:Object.fromEntries(deps.map(d=>[d.id,d.flag||null])), titleOf:Object.fromEntries(deps.map(d=>[d.id,d.title])),
      epicOf:Object.fromEntries(eps.map(e=>[e.id,e.name])), projOf:Object.fromEntries(projs.map(p=>[p.id,p])) };
    if(changed) lastSig=''; // o refresh (com a trava de clique) redesenha — nunca renderFlow direto daqui
    // pré-requisito apagado do backlog não trava a fila; cancelado/abortado trava (alguém decide)
    // só o que é MEU (atribuído a mim; sem responsável = quem criou) — cartão de outra pessoa nunca começa sozinho aqui
    const me=cloudUserId();
    const ready=rows.filter(t=>ctWaiting(t) && ctMineFor(t, me) && !epDepsLeft(t).length);
    for(const ct of ready){
      const pj=epQueue.projOf[ct.project_id]||{};
      if(pj.repo_remote && !remoteSame(pj.repo_remote, hereIds)){ // teamClaimStart roda no projeto ABERTO: outro repo espera (e avisa uma vez)
        if(!epAutoWarned.has(ct.id)){ epAutoWarned.add(ct.id); pushNotif('Pronta pra começar', ct.title+' — abra o projeto '+(pj.name||pj.repo_remote)+' que ela começa sozinha', null); }
        continue;
      }
      const live=(state.tasks||[]).filter(x=>ACTIVE_ST.has(x.status)).length;
      if(live>=slotMax) break; // respeita o limite de execuções; tenta de novo no próximo tick
      try{
        await teamClaimStart(ct, null, { silent:true, auto:true });
        pushNotif('▶ Começou sozinha', ct.title+' — os pré-requisitos foram concluídos', null);
      }catch(e){ console.error('início automático do épico:', e); }
    }
  }catch(e){ tickErr('epicAutoStart', e); }
  finally{ epAutoBusy=false; }
}
tickLoop('epicAutoStart', epicAutoStartTick, ()=>epAutoIdle?60000:20000, 3000); // 42: sem sobreposição; 60s sem épico nenhum
// seção do quadro de Tarefas (22-quadro-fluxo: renderFlow) — só na aba de execução, do projeto aberto
// tipo do cartão da nuvem (mesmas chaves do filtro de tipo da Central: 22 taskType)
function epqType(ct){
  const s=ct.spec||{}; if(s.kind==='review') return 'review';
  const bt=String(s.branchType||'').toLowerCase(); if(['fix','docs','chore','refactor','perf','design'].includes(bt)) return bt;
  if(s.kind==='invest'||s.kind==='design') return s.kind; return 'feat';
}
const epqWave=ct=>Math.max(1, parseInt((ct.spec||{}).wave,10)||1);
// M3: a fila respeita os MESMOS filtros da Central (busca, status, tipo, agente, épico, projeto) — antes sumia com a busca
// A regra ÚNICA do que da fila é MEU (Execução): ctExecOk (42) = meu e de projeto que existe nesta máquina.
// O projeto aberto sempre conta como local (a lista de projetos pode ainda não ter chegado).
function epqLocalIds(){ const q=epQueue; return (q.localIds||[]).concat(q.hereIds?[q.hereIds]:(q.here?[{ remote:q.here }]:[])); }
function epQueueMine(){
  const q=epQueue, me=cloudUserId(), loc=epqLocalIds();
  return (q.rows||[]).filter(ct=>ctExecOk(ct, me, q.projOf[ct.project_id], loc));
}
// backlog de épico que NÃO é meu (de outra pessoa / sem dono / projeto que não tenho aqui) — mora na aba Time
function epQueueTeamCount(){ return Math.max(0, ((epQueue.rows||[]).length) - epQueueMine().length); }
function epQueueList(ignoreStatus){
  const q=epQueue, all=(typeof projFilter!=='undefined'&&projFilter==='all');
  const qq=String((typeof flowQuery!=='undefined'&&flowQuery)||'').trim().toLowerCase();
  const fs=(typeof flowStatus!=='undefined')?flowStatus:'all', fe=(typeof flowEpic!=='undefined')?flowEpic:'all';
  const ft=(typeof flowType!=='undefined')?flowType:'all', fa=(typeof flowAgent!=='undefined')?flowAgent:'all';
  return epQueueMine().filter(ct=>{
    const pj=q.projOf[ct.project_id]||{};
    if(!(all || !pj.repo_remote || remoteSame(pj.repo_remote, q.hereIds||{ remote:q.here }))) return false;
    if(!ignoreStatus && fs!=='all' && fs!=='epicos') return false; // outro chip de status escolhido: a fila sai
    if(fe!=='all' && ct.epic_id!==fe) return false;
    if(ft!=='all' && epqType(ct)!==ft) return false;
    if(fa!=='all' && (ct.spec||{}).agent!==fa) return false;
    if(qq && !((ct.title||'')+' '+(epNameOf(ct.epic_id)||'')).toLowerCase().includes(qq)) return false;
    return true;
  });
}
function epQueueCount(){ return epQueueList(true).length; } // contador do chip "Na fila dos épicos"
// R3-C1: a linha da fila — borda esquerda = cor do ÉPICO (no grupo), ponto = cor do STATUS (sempre; nunca a do épico).
// Uma única ação primária por grupo: a 1ª tarefa pronta pra começar (`primary`); as outras prontas ficam secundárias,
// e "iniciar mesmo assim" (pré-requisito pendente) é ghost — antes vários botões verdes disputavam a atenção.
function epqRowHtml(ct, showProj, me, isAdmin, primary){
  const q=epQueue, left=epDepsLeft(ct), auto=ctWaiting(ct), pj=q.projOf[ct.project_id]||{};
  // A4: esperando OUTRA tarefa = "na espera de" (o "Aguardando você" da Central é só pro que depende de você)
  const st=left.length
    ? `na espera de ${left.map(a=>`<b>${esc(String(q.titleOf[a]||'tarefa').slice(0,40))}</b> (${esc(stLabel((q.effOf||{})[a]||q.stOf[a]))})`).join(', ')}${auto?' · começa sozinha quando elas forem concluídas':''}`
    : (auto?'pré-requisitos prontos — começando…':'pronta pra começar');
  const stk=left.length?'waiting':'backlog';
  const go=left.length
    ? `<button class="btn sm ghost" data-epqgo="${escA(ct.id)}" title="ainda depende de ${left.length} tarefa(s) — assumir e iniciar agora mesmo assim">iniciar mesmo assim</button>`
    : `<button class="btn sm${primary?' primary':''}" data-epqgo="${escA(ct.id)}" title="assumir e iniciar agora nesta máquina${primary?' — próxima recomendada deste épico':''}">${IC.play} iniciar</button>`;
  // M4: remover (DELETE na nuvem) só pra quem criou ou admin, e fora do caminho do ▶ — no menu ⋯
  const who=ctWhoLabel(ct, me, tmName); // veio de outra pessoa (ex.: atribuída a mim) → "criada por Fulano"
  const menu=(ct.created_by===me||isAdmin)?`<button class="btn sm ghost" data-epqmenu="${escA(ct.id)}" title="mais ações" aria-label="mais ações">${IC.more}</button>`:'';
  return `<div class="epq" data-epq="${escA(ct.id)}"><span class="epq-dot${left.length?' wait':''}" style="--stc:${stColor(stk)}" title="${escA(stLabel(stk))}"></span><div class="epq-body"><div class="epq-t">${esc(ct.title)}</div><div class="epq-m">${showProj&&pj.name?`<span class="epq-proj">${esc(pj.name)}</span>`:''}<span class="epq-wv" title="${escA(EP_WAVE_TIP)}">onda ${epqWave(ct)}</span><span class="epq-st">${st}</span>${who?`<span class="epq-who">${esc(who)}</span>`:''}</div></div><div class="epq-acts">${go}${menu}</div></div>`;
}
// R3-C1: TODAS as tarefas do épico (nuvem + locais já iniciadas), cada uma com o status efetivo — o cabeçalho do grupo
// resume o épico inteiro (antes dizia "4 na fila" com 7 tarefas no épico e as rodando/em PR soltas em outras seções)
const EPQ_BUCKETS=[ // ordem da frase do cabeçalho
  ['run','rodando'], ['ask','aguardando você'], ['rev','pronta(s) pra revisar'], ['pr','com PR aberto'], ['bad','com erro ou conflito'], ['queue','na fila'],
];
function epqBucket(st, flag, pr){
  if(flag==='closed'||['merged','done','closed'].includes(st)) return 'ok';
  if(st==='aborted'||st==='cancelled') return 'off';
  if(st==='error'||st==='conflict') return 'bad';
  if(pr) return 'pr';
  if(st==='review'||st==='delivered') return 'rev';
  if(st==='asking'||st==='plan-review') return 'ask';
  if(['running','thinking','queued','paused'].includes(st)) return 'run';
  return 'queue';
}
function epqEpicTasks(eid){
  const q=epQueue, m=(typeof tmap==='function')?tmap():{}, cloudToLocal={}; Object.keys(m).forEach(k=>{ cloudToLocal[m[k]]=k; });
  const locals=((typeof state!=='undefined'&&state.tasks)||[]).filter(t=>t.epic&&t.epic.epicId===eid);
  const byLocal={}; locals.forEach(t=>{ byLocal[t.id]=t; });
  const out=[], seen=new Set();
  ((q.sibsOf||{})[eid]||[]).forEach(ct=>{
    const lid=(ct.local_id&&byLocal[ct.local_id])?ct.local_id:cloudToLocal[ct.id], lt=lid&&byLocal[lid];
    if(lt) seen.add(lt.id);
    const st=lt?taskSt(lt):ct.status, flag=lt?lt.flag:ct.flag; // R5-1: status efetivo (pergunta aberta = aguardando você)
    const pr=lt?!!(lt.prUrl&&lt.status!=='merged'):!!(ct.pr_url&&!['merged','done','closed'].includes(ct.status));
    out.push({ title:ct.title||(lt&&lt.title)||'tarefa', st, flag, b:epqBucket(st, flag, pr), wave:epqWave(ct), local:lt?lt.id:null, cloud:ct.id });
  });
  locals.forEach(t=>{ if(seen.has(t.id)) return; // tarefa local ainda não espelhada na nuvem
    const pr=!!(t.prUrl&&t.status!=='merged');
    out.push({ title:t.title||'tarefa', st:taskSt(t), flag:t.flag, b:epqBucket(taskSt(t), t.flag, pr), wave:Math.max(1, parseInt(t.epic.wave,10)||1), local:t.id, cloud:null }); });
  return out.filter(x=>x.b!=='off').sort((a,b)=>a.wave-b.wave);
}
function epqSummaryHtml(eid, qn){
  const all=epqEpicTasks(eid);
  if(!all.length) return `<span class="epqk">${qn} na fila</span>`;
  const cnt={}; all.forEach(x=>{ cnt[x.b]=(cnt[x.b]||0)+1; });
  const cur=(all.find(x=>x.b!=='ok')||{}).wave||0;
  const parts=[`<span class="epqk" title="${escA((cnt.ok||0)+' de '+all.length+' tarefas deste épico entregues (mergeadas ou concluídas)')}"><b>${cnt.ok||0}/${all.length}</b> entregues</span>`];
  if(cur) parts.push(`<span class="epqk epq-wv" title="${escA('onda atual — '+EP_WAVE_TIP)}">onda ${cur}</span>`);
  EPQ_BUCKETS.forEach(([k,l])=>{ if(cnt[k]) parts.push(`<span class="epqk epqk-${k}">${cnt[k]} ${l}</span>`); });
  const dots=all.map((x,i)=>{ const pr=x.b==='pr', sk=pr?'pr-open':(x.flag==='closed'?'closed':x.st);
    const c=stColor(sk), lab=stLabel(sk);
    return `<button class="epqdot" style="--stc:${c}" data-epqt="${escA(eid)}|${i}" title="${escA(x.title+' — '+lab+' · onda '+x.wave+' · clique pra abrir')}" aria-label="${escA(x.title+' — '+lab)}"></button>`; }).join('');
  return parts.join('<span class="epqsep">·</span>')+`<span class="epqdots" role="group" aria-label="tarefas do épico, na ordem das ondas">${dots}</span>`;
}
function epqOpenTask(eid, i){
  const x=epqEpicTasks(eid)[i]; if(!x) return;
  if(x.cloud){ const ct=((epQueue.sibsOf||{})[eid]||[]).find(c=>c.id===x.cloud)||epQueue.rows.find(c=>c.id===x.cloud); if(ct&&window.openCloudTaskPage){ openCloudTaskPage(ct); return; } }
  if(x.local&&typeof openWorkspace==='function') openWorkspace(x.local);
}
// seção do quadro de Tarefas (22-quadro-fluxo: renderFlow) — só na aba de execução.
// F1: AGRUPADA por épico (cabeçalho com nome, resumo do épico inteiro, ⤢ abrir), tarefas da fila por onda,
// cada épico recolhível (epq:col:<id>). R3-C1: a seção nasce ABERTA — só fica recolhida se VOCÊ recolheu
// (antes recolhia sozinha sempre que havia algo aguardando você — quase sempre — e escondia a visão por épico).
function epBoardHtml(scope, opts){
  if(scope==='done') return '';
  const list=epQueueList(false); if(!list.length) return '';
  const showProj=(typeof projFilter!=='undefined'&&projFilter==='all');
  const me=cloudUserId(), isAdmin=!!(typeof cloudData!=='undefined'&&cloudData&&(cloudData.meRole==='owner'||cloudData.meRole==='admin'));
  const groups=new Map(); list.forEach(ct=>{ if(!groups.has(ct.epic_id)) groups.set(ct.epic_id,[]); groups.get(ct.epic_id).push(ct); });
  const body=[...groups.entries()].map(([eid, items])=>{
    items.sort((a,b)=>epqWave(a)-epqWave(b) || String(a.created_at||'').localeCompare(String(b.created_at||'')));
    const name=epNameOf(eid)||'épico', col=lsGet('epq:col:'+eid)==='1';
    const firstReady=items.find(ct=>!epDepsLeft(ct).length);
    return `<div class="epqep${col?' collapsed':''}" style="--epc:${epColor(eid)}">`+
      `<div class="epqh" data-epqtog="${escA(eid)}" role="button" tabindex="0" aria-expanded="${col?'false':'true'}" title="clique pra ${col?'expandir':'recolher'} as tarefas deste épico que estão na fila">`+
        `<span class="secchev">${col?IC.chevR:IC.chevD}</span><span class="tsepc epqname">${IC.epic} ${esc(name)}</span>`+
        `<span class="epqsum">${epqSummaryHtml(eid, items.length)}</span><span style="flex:1"></span>`+
        `<button class="btn sm ghost" data-epqopen="${escA(eid)}" title="abrir a página do épico (checklist, requisitos e todas as tarefas)">abrir</button></div>`+
      (col?'':items.map(ct=>epqRowHtml(ct, showProj, me, isAdmin, ct===firstReady)).join(''))+`</div>`;
  }).join('');
  const colAll=(typeof flowSecCollapsed==='function')?flowSecCollapsed('epicos', false):false;
  const head=(typeof flowSecHead==='function')?flowSecHead('epicos','Na fila dos épicos', list.length, '', colAll, IC.epic):`<div class="sech">${IC.epic} Na fila dos épicos <span class="n">${list.length}</span></div>`;
  return `<div class="secgrp epqgrp${colAll?' collapsed':''}" data-sec="epicos">${head}${colAll?'':body}</div>`;
}
// menu ⋯ do cartão da fila: abrir · remover (com confirmação)
function epqMenu(ct, anchor){
  $id('epqMenuPop')?.remove();
  const pop=document.createElement('div'); pop.id='epqMenuPop'; pop.className='epqpop';
  const item=(label, fn, danger)=>{ const b=document.createElement('button'); b.textContent=label; if(danger) b.className='danger'; b.onclick=(e)=>{ e.stopPropagation(); pop.remove(); fn(); }; pop.appendChild(b); };
  item('abrir o cartão', ()=>{ if(window.openCloudTaskPage) openCloudTaskPage(ct); });
  item('remover do backlog do time…', ()=>epCardCancel(ct), true); // teamDeleteCard pergunta (askYes) antes
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6)+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.right-pop.offsetWidth))+'px';
  setTimeout(()=>{ const close=(e)=>{ if(!pop.contains(e.target)){ pop.remove(); document.removeEventListener('click',close); } }; document.addEventListener('click',close); },0);
}
function epOpenById(id){ const e=((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(x=>x.id===id); openEpicPage(e||{ id, name:epNameOf(id)||'Épico' }); }
function epWireBoard(root){
  const R=root||document;
  R.querySelectorAll('[data-epq]').forEach(r=>{ r.onclick=(e)=>{ if(e.target.closest('[data-epqgo],[data-epqmenu]')) return; e.stopPropagation(); const ct=epQueue.rows.find(x=>x.id===r.dataset.epq); if(ct&&window.openCloudTaskPage) openCloudTaskPage(ct); }; });
  R.querySelectorAll('[data-epqgo]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const ct=epQueue.rows.find(x=>x.id===b.dataset.epqgo); if(ct) epCardStart(ct, b); });
  R.querySelectorAll('[data-epqmenu]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const ct=epQueue.rows.find(x=>x.id===b.dataset.epqmenu); if(ct) epqMenu(ct, b); });
  R.querySelectorAll('[data-epqopen]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); epOpenById(b.dataset.epqopen); });
  R.querySelectorAll('[data-epqt]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); const [eid,i]=b.dataset.epqt.split('|'); epqOpenTask(eid, +i); }; b.onkeydown=(e)=>e.stopPropagation(); });
  R.querySelectorAll('[data-epqtog]').forEach(h=>{
    h.onclick=(e)=>{ if(e.target.closest('[data-epqopen],[data-epqt]')) return; e.stopPropagation(); const id=h.dataset.epqtog; lsSet('epq:col:'+id, h.getAttribute('aria-expanded')==='false'?'0':'1'); lastSig=''; if(typeof renderFlow==='function') renderFlow(); };
    h.onkeydown=(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); h.onclick(e); } };
  });
  // selo "◆ épico · onda N" nas tarefas já iniciadas: abre a página do épico (sem abrir a tarefa)
  R.querySelectorAll('[data-epbadge]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); epOpenById(b.dataset.epbadge); });
}
// ▶ iniciar um cartão do épico NA MÃO (fila do quadro / página do cartão): confere o projeto aberto e avisa se
// ainda há pré-requisito pendente — antes só dava pela aba Time, e pelo épico não havia como
async function epCardStart(ct, btn){
  try{
    const pj=(typeof teamProj!=='undefined'&&teamProj&&teamProj[ct.project_id])||(ct.project_id?((await sbGet('projects?select=name,repo_remote&id=eq.'+ct.project_id))[0]||{}):{});
    const hereIds=await repoRemoteIds();
    // alert() no Tauri não é confiável (igual ao confirm) — o aviso vai no toast, com o atalho pra trocar de projeto
    if(pj.repo_remote && hereIds.remote && !remoteSame(pj.repo_remote, hereIds)){ toast('Esta tarefa é do projeto '+(pj.name||pj.repo_remote)+'. Abra esse projeto e clique em iniciar de novo.','warn',{ label:'abrir '+(pj.name||'o projeto'), fn:()=>epOpenProjectOf(pj) }); return; }
    const left=((ct.spec||{}).after||[]).filter(a=>(a in epQueue.stOf) && !epDepDone(a));
    if(left.length && !await askYes('Ainda depende de: '+left.map(a=>epQueue.titleOf[a]||a).join(', ')+' (não concluída).\n\nIniciar mesmo assim?')) return;
    await teamClaimStart(ct, btn||null);
    epicAutoStartTick();
  }catch(e){ showErr(e, 'Não deu pra iniciar'); }
}
// abre (troca pra) o projeto LOCAL cujo remote é o do cartão; não achou nesta máquina → aba Projetos
async function epOpenProjectOf(pj){
  try{
    const locals=(await invoke('list_projects', { user:(typeof cloudUserId==='function'?cloudUserId():undefined) }))||[];
    for(const p of locals){ const ids=await repoRemoteIds(p.path); if(remoteSame(pj.repo_remote, ids)){ if(window.switchProject) await window.switchProject(p.path); return; } }
  }catch(e){ console.warn('abrir projeto do cartão', e); }
  toast('O projeto '+(pj.name||pj.repo_remote||'')+' não está aberto nesta máquina — abra ou clone a pasta dele em Projetos.','warn');
  if(window.openTab) window.openTab('projetos');
}
// ✕ cancelar = tirar do backlog do time (as que dependiam dela deixam de esperar por ela)
async function epCardCancel(ct){
  if(typeof teamDeleteCard!=='function') return;
  if(!await teamDeleteCard(ct)) return; // pergunta antes (askYes); desistiu/falhou = nada muda
  if(window.closeTabOfKind && typeof ctpTask!=='undefined' && ctpTask && ctpTask.id===ct.id) closeTabOfKind('cttask');
  lastSig=''; epicAutoStartTick();
}
window.epCardStart=epCardStart; window.epCardCancel=epCardCancel;
window.epBoardHtml=epBoardHtml; window.epWireBoard=epWireBoard; window.epQueueTeamCount=epQueueTeamCount;
// épico já criado (antes disto existir): liga o início automático nas tarefas com pré-requisito
async function epicAutoOn(ep){
  const c=epCache[ep.id]||{ tasks:[] };
  const list=(c.tasks||[]).filter(t=>t.status==='backlog' && Array.isArray((t.spec||{}).after) && t.spec.after.length && !t.spec.autoStart);
  if(!list.length) return;
  if(!await askYes(list.length+' tarefa(s) vão ficar NA ESPERA e começar sozinhas nesta máquina quando as anteriores forem mergeadas:\n\n'+list.map(t=>'• '+t.title).join('\n'))) return;
  try{
    for(const t of list){ await sbFetch('/rest/v1/tasks?id=eq.'+t.id, { method:'PATCH', body: JSON.stringify({ spec:{ ...(t.spec||{}), autoStart:true } }) }); t.spec={ ...(t.spec||{}), autoStart:true }; }
    epicPageRender(); epicAutoStartTick();
  }catch(e){ showErr(e, 'Falhou'); }
}
