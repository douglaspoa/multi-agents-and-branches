// Constellation — 46-epico-time: o ÉPICO do time abre como PÁGINA (aba, nunca modal): o envelope
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
  const [fresh, tasks]=await Promise.all([
    sbGet('epics?select=*&id=eq.'+id).then(r=>(r&&r[0])||null).catch(()=>null),
    sbGet('tasks?select=id,title,status,flag,assignee,created_by,pr_url,issue_url,spec,local_id,project_id,epic_id&epic_id=eq.'+id+'&order=created_at').catch(()=>null),
  ]);
  const c=epCache[id]||{ ep:null, tasks:[], loaded:false }; epCache[id]=c;
  if(tasks) c.tasks=tasks;
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
  const legacy=!sp.outcome && !dw.length && !reqs.length; // épico antigo (só nome): continua válido
  const okN=dw.filter(d=>d&&d.checkedBy).length;
  const tasks=c.tasks||[];
  const isDone=t=>['merged','done'].includes(t.status)||t.flag==='closed', isRev=t=>['review','delivered'].includes(t.status);
  const doneN=tasks.filter(t=>isDone(t)||isRev(t)).length;
  const can=epCanCheck(ep);
  const stPt=s=>(typeof CT_ST_PT!=='undefined'&&CT_ST_PT[s])||s;
  // tarefas por onda (wave gravada no spec ao aprovar o card; tarefa antiga cai na onda 1)
  const byWave={}; tasks.forEach(t=>{ const w=Math.max(1, parseInt((t.spec||{}).wave,10)||1); (byWave[w]=byWave[w]||[]).push(t); });
  const waves=Object.keys(byWave).map(Number).sort((a,b)=>a-b);
  const taskRow=t=>{ const s=t.spec||{}; return `<div class="ep-task" data-ept="${escA(t.id)}"><span class="reqst ${isDone(t)?'ok':isRev(t)?'blk':'na'}">${isDone(t)?IC.check:isRev(t)?'!':'·'}</span><div class="en-rt">
      <div><b>${esc(t.title)}</b> <span class="dim" style="font-size:11px">· ${esc(stPt(t.status))}${t.assignee?' · '+esc(tmName(t.assignee)):''}</span></div>
      ${s.verify?`<div class="ep-verify">✓ prova: ${esc(s.verify)}${(Array.isArray(s.covers)&&s.covers.length)?` <span class="mono dim">${esc(s.covers.join(' '))}</span>`:''}</div>`:''}
    </div></div>`; };
  const tasksHtml = tasks.length
    ? waves.map(w=>`<div class="ep-wave">ONDA ${w}</div>${byWave[w].map(taskRow).join('')}`).join('')
    : `<div class="en-empty">${c.loaded?'nenhuma tarefa neste épico ainda':'carregando…'}</div>`;
  const dwHtml = dw.length
    ? dw.map((d,i)=>`<label class="ep-dw${d.checkedBy?' ok':''}"><input type="checkbox" data-epdw="${i}" ${d.checkedBy?'checked':''}${can?'':' disabled'}><span class="en-rt">
        <div><span class="mono dim">${esc(d.id||('D'+(i+1)))}</span> ${esc(d.text||'')}</div>
        ${d.checkedBy?`<div class="ep-dwby">marcado por ${epWho(d.checkedBy)}${d.checkedAt?' · há '+agoTx(d.checkedAt):''}${d.evidence?' · '+esc(d.evidence):''}</div>`:''}
      </span></label>`).join('')
    : `<div class="en-empty">${legacy?'épico antigo, sem "pronto quando"':'sem checagens definidas'} — ele fecha pelo botão abaixo</div>`;
  main.innerHTML=`<div class="enpage">
    <div class="en-head">
      <div class="en-ht">
        <span class="ndeyebrow">épico do time · ${esc(EP_ST_PT[ep.status]||ep.status||'')}</span>
        <h2 class="en-h1">◆ ${esc(ep.name||'Épico')}</h2>
        ${sp.outcome?`<p class="en-obj">${esc(sp.outcome)}</p>`:''}
        ${sp.description?`<p class="en-obj dim" style="font-size:12px">${esc(sp.description)}</p>`:''}
        <div class="ctp-who">${tsAv(ep.created_by, tsOnline(ep.created_by))}<span>criado por <b>${esc(tmName(ep.created_by))}</b>${ep.created_at?' · há '+agoTx(ep.created_at):''}</span></div>
      </div>
      <div class="en-kpis">
        ${sp.issue&&sp.issue.code?`<button class="en-kpi" ${sp.issue.url?`data-lk="${escA(sp.issue.url)}"`:'disabled'}><b>${esc(sp.issue.code)}</b><span>issue do épico${sp.issue.url?' ↗':''}</span></button>`:''}
        <div class="en-kpi"><b>${okN}/${dw.length}</b><span>pronto quando</span></div>
        <div class="en-kpi"><b>${doneN}/${tasks.length}</b><span>tarefas entregues</span></div>
        <div class="en-kpi"><b>${esc(EP_ST_PT[ep.status]||ep.status||'')}</b><span>status</span></div>
      </div>
    </div>
    <div class="en-grid">
      <section class="en-sec">
        <div class="seclbl2">Pronto quando <span class="dim">· o épico só fecha com tudo marcado${can?'':' · só quem criou (ou admin) marca'}</span></div>${dwHtml}
        ${reqs.length?`<div class="seclbl2" style="margin-top:14px">Requisitos</div>${reqs.map(r=>`<div class="en-del"><span class="mono dim">${esc(r.id||'')}</span> ${esc(r.text||'')}</div>`).join('')}`:''}
        ${bounds.length?`<div class="seclbl2" style="margin-top:14px">Não muda</div>${bounds.map(b=>`<div class="en-del">⊘ ${esc(b)}</div>`).join('')}`:''}
        ${!dw.length&&ep.status!=='done'&&can?`<div style="margin-top:14px"><button class="btn sm" id="epLegacyDone">✓ marcar épico como concluído</button></div>`:''}
      </section>
      <section class="en-sec"><div class="seclbl2">Tarefas <span class="dim">· por onda; clique pra abrir</span></div>${tasksHtml}</section>
    </div>
  </div>`;
  main.querySelectorAll('[data-epdw]').forEach(cb=>cb.onchange=()=>epicToggleDone(ep, +cb.dataset.epdw, cb.checked));
  main.querySelectorAll('[data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  main.querySelectorAll('[data-ept]').forEach(r=>r.onclick=()=>{ const t=(c.tasks||[]).find(x=>x.id===r.dataset.ept); if(t&&window.openCloudTaskPage) openCloudTaskPage(t); });
  bindClick('epLegacyDone', ()=>epicSetStatus(ep,'done'));
  { const h=$id('epicPageName'); if(h) h.textContent=ep.name||'Épico'; const s=$id('epicPageSub'); if(s) s.textContent=EP_ST_PT[ep.status]||''; }
}
async function epicPatch(ep, body){
  body.updated_at=new Date().toISOString();
  await sbFetch('/rest/v1/epics?id=eq.'+ep.id,{ method:'PATCH', body: JSON.stringify(body) });
  await epicPageLoad(ep.id);
  if(epTab&&epTab.id===ep.id) epicPageRender();
  teamTasks=null; teamPaintSig=''; if(typeof renderTeamBoard==='function') renderTeamBoard();
}
// marca/desmarca um item do "pronto quando"; com tudo marcado o épico fecha; desmarcar reabre (não há botão "reabrir" — a regra é só essa)
async function epicToggleDone(ep, idx, on){
  // parte do spec FRESCO da nuvem: outro membro ou o agente revisor podem ter marcado itens enquanto a aba ficou aberta
  try{ const f=(await sbGet('epics?select=spec,status&id=eq.'+ep.id))[0]; if(f){ ep={ ...ep, ...f }; } }catch(_){ }
  const spec={ ...(ep.spec||{}) }; const dw=(Array.isArray(spec.doneWhen)?spec.doneWhen:[]).map(d=>({ ...d }));
  if(!dw[idx]) return;
  if(on){ dw[idx].checkedBy=cloudUserId(); dw[idx].checkedAt=new Date().toISOString(); }
  else { delete dw[idx].checkedBy; delete dw[idx].checkedAt; delete dw[idx].evidence; }
  spec.doneWhen=dw;
  const all=dw.length>0 && dw.every(d=>d.checkedBy);
  const c=epCache[ep.id]; const started=!!(c&&(c.tasks||[]).some(t=>t.status!=='backlog'));
  const status= all ? 'done' : (ep.status==='done' ? (started?'in-progress':'open') : ep.status);
  try{ await epicPatch(ep, { spec, status }); }
  catch(e){ alert('Falha ao marcar: '+(e.message||e)); epicPageRender(); }
}
async function epicSetStatus(ep, status){ try{ await epicPatch(ep, { status }); }catch(e){ alert('Falha: '+(e.message||e)); } }
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
  let sibs=null; try{ sibs=await sbGet('tasks?select=id,title,status,assignee,spec,created_at&epic_id=eq.'+epicId+'&order=created_at'); }catch(_){ sibs=null; }
  if(!Array.isArray(sibs)||!sibs.length) sibs=(teamTasks||[]).filter(t=>t.epic_id===epicId);
  const sp=ep.spec||{}; const dw=Array.isArray(sp.doneWhen)?sp.doneWhen:[], reqs=Array.isArray(sp.requirements)?sp.requirements:[], bounds=Array.isArray(sp.boundaries)?sp.boundaries:[];
  const stPt=s=>(typeof CT_ST_PT!=='undefined'&&CT_ST_PT[s])||s;
  const byId={}; sibs.forEach(t=>{ byId[t.id]=t; });
  const L=['# Épico: '+epCut(ep.name,90), '', '<!-- Compilado pelo Constellation ao assumir a tarefa. Descreve por propósito; o código é a fonte do resto. -->', ''];
  L.push('## Objetivo', epCut(sp.outcome||sp.description||('Épico do time "'+ep.name+'".'),400)); if(sp.outcome&&sp.description) L.push(epCut(sp.description,300)); L.push('');
  if(reqs.length){ L.push('## Requisitos do épico'); reqs.slice(0,12).forEach(r=>L.push('- '+(r.id||'R?')+': '+epCut(r.text,200))); L.push(''); }
  if(dw.length){ L.push('## Pronto quando (o épico só fecha com tudo marcado)'); dw.slice(0,8).forEach((d,i)=>L.push('- '+(d.checkedBy?'☑':'☐')+' '+(d.id||('D'+(i+1)))+': '+epCut(d.text,200))); L.push(''); }
  if(bounds.length){ L.push('## Não muda'); bounds.slice(0,8).forEach(b=>L.push('- '+epCut(b,160))); L.push(''); }
  if(sibs.length){
    L.push('## Tarefas do épico (as irmãs rodam em paralelo — fique no seu escopo)');
    sibs.slice(0,15).forEach(t=>{ const s=t.spec||{}; const me=!!(forTask&&t.id===forTask.id);
      const dep=(Array.isArray(s.after)?s.after:[]).map(a=>byId[a]?epCut(byId[a].title,40):'').filter(Boolean);
      L.push('- '+(me?'**ESTA → **':'')+epCut(t.title,80)+' · onda '+(parseInt(s.wave,10)||1)+' · '+stPt(t.status)+(s.verify?' · prova: '+epCut(s.verify,120):'')+(Array.isArray(s.covers)&&s.covers.length?' · cobre '+s.covers.join(','):'')+(dep.length?' · depois de: '+dep.join('; '):'')+(s.owns?' · escopo: '+epCut(s.owns,60):'')); });
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
function epMirroredSet(){ try{ return new Set(JSON.parse(lsGet('ep:mirrored')||'[]')); }catch(_){ return new Set(); } }
async function epicMirrorChecks(t){
  const ep=t.epic||{}; const epicId=ep.epicId; const checks=Array.isArray(ep.epicChecks)?ep.epicChecks:[];
  if(!epicId||!checks.length||epMirrorInFlight.has(t.id)) return;
  const done=epMirroredSet(); const pend=checks.filter(c=>c&&c.id&&!done.has(t.id+'|'+c.id));
  if(!pend.length) return;
  epMirrorInFlight.add(t.id);
  try{
    const fresh=(await sbGet('epics?select=id,spec,status&id=eq.'+epicId))[0];
    if(!fresh){ pend.forEach(c=>done.add(t.id+'|'+c.id)); lsSet('ep:mirrored', JSON.stringify([...done].slice(-500))); return; } // épico apagado: não fica tentando pra sempre
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
    pend.forEach(c=>done.add(t.id+'|'+c.id)); lsSet('ep:mirrored', JSON.stringify([...done].slice(-500)));
  }catch(e){ console.warn('espelho do pronto quando falhou', e&&e.message||e); }
  finally{ epMirrorInFlight.delete(t.id); }
}
window.epicMirrorChecks=epicMirrorChecks;
bindClick('epicPageClose', ()=>closeTabOfKind('epic'));
bindClick('epicPageRefresh', ()=>{ if(epTab){ const b=$id('epicPageRefresh'); if(b) b.disabled=true; epicPageLoad(epTab.id).then(()=>{ epicPageRender(); if(b) b.disabled=false; }); } });
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const o=$id('epicOverlay'); const cur=tabById(activeTab);
  if(o&&o.style.display!=='none'&&cur&&cur.kind==='epic'){ e.stopImmediatePropagation(); closeTabOfKind('epic'); }
}, true);
