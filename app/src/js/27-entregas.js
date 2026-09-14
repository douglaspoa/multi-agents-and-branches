// Constellation — 27-entregas: card de demanda (Execução/Concluídas), aba ENTREGA da demanda
// (objetivo · entregáveis com provas · documentos · linha do tempo), lightbox dos prints,
// relatório da entrega e relatório do período (IA), tudo em cima do que o app já guarda.
const TASK_DONE_ST=['merged','done'];
function taskIsDone(t){ return !!t && (t.flag==='closed' || TASK_DONE_ST.includes(t.status)); }
function prNumOf(t){ return (String((t&&t.prUrl)||'').match(/\/pull\/(\d+)/)||[])[1]||''; }
function agoShort(ms){ const s=(Date.now()-ms)/1000; if(!(s>=0)) return ''; if(s<60) return 'agora'; if(s<3600) return Math.floor(s/60)+'min'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function fmtDurMs(ms){ ms=Math.max(0,ms||0); const m=Math.round(ms/60000); if(m<60) return m+' min'; const h=Math.floor(m/60); return h<48?`${h}h${String(m%60).padStart(2,'0')}`:Math.round(h/24)+' dias'; }
function taskDurationMs(t){ const evs=eventsOf(t.id); const last=evs.length?+new Date(evs[evs.length-1].ts):0; const a=t.createdAt||t.created_at||0; return last&&a?last-a:0; }
// ---- requisitos com estado de prova (mesma regra do resumo/lateral) ----
function reqRows(t){
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  const c=reqProofCache[t.id];
  const m=matchReqProofs(reqs, c&&c.list);
  return reqs.map((r,i)=>{ const p=m[i]; const st=p?(p.status==='done'?'ok':'blk'):'na'; return { text:r, st, evidence:(p&&Array.isArray(p.evidence))?p.evidence:[], note:(p&&p.note)||'' }; });
}
// ---- CARD DE DEMANDA (lista da Central: Execução e Concluídas) ----
function flowDemandCard(t){
  const asking=pendingOf(t.id);
  const done=taskIsDone(t);
  const ph=taskPhase(t), pct=taskPct(t);
  const dot= asking.length||t.status==='plan-review'?'var(--warn)' : ['error','conflict'].includes(t.status)?'var(--crit)' : (ACTIVE_ST.has(t.status)||t.status==='thinking')?'var(--good)' : ['review','delivered'].includes(t.status)?'var(--warn)' : done?'var(--info)':'var(--muted)';
  const ev=lastEventOf(t.id);
  const prN=prNumOf(t);
  const proj=t.proj||(state.repo||'').split('/').filter(Boolean).slice(-1)[0]||'';
  const ty=taskType(t);
  if(reqProofCache[t.id]===undefined) loadReqProofs(t.id).then(()=>{ if(activeIs('flow')){ lastSig=''; safe(renderFlow); } });
  const rows=reqRows(t);
  const okN=rows.filter(r=>r.st==='ok').length;
  const reqsHtml = rows.length ? `<div class="dc-reqs">${rows.slice(0,4).map(r=>`<span class="dc-req ${r.st}"><i>${r.st==='ok'?'✓':r.st==='blk'?'!':'○'}</i>${esc(r.text)}</span>`).join('')}${rows.length>4?`<span class="dc-more">+${rows.length-4}</span>`:''}</div>` : '';
  const msg= asking.length ? `<b>${esc(asking[0].agent||t.agent)} perguntou</b> — ${esc((asking[0].prompt||'').slice(0,90))}`
    : t.status==='plan-review' ? 'plano pronto — aprove pra continuar'
    : t.status==='draft' ? 'rascunho — clique pra editar'
    : done ? (prN?`PR #${prN} mergeado`:'concluída')
    : (t.prUrl&&prN) ? `PR #${prN} aguardando aprovação`
    : ['review','delivered'].includes(t.status) ? `pronta pra revisar · ${(diffOf(t.id)?.files||[]).length||0} arquivo(s)`
    : ev ? `${esc(ev.agent||t.agent)} ${GLYPH[ev.type]||''} ${esc(String(ev.text||'').slice(0,90))}` : 'iniciando…';
  const artC=artifactsCache[t.id];
  if(done && (!artC||artC.status!==t.status)) loadArtifacts(t.id, t.status).then(()=>{ if(activeIs('flow')){ lastSig=''; safe(renderFlow); } });
  const arts=(artC&&artC.list||[]).filter(a=>a.name!=='requirements.json');
  const nImg=arts.filter(a=>a.kind==='image').length, nDoc=arts.filter(a=>/\.(md|txt|pdf|html?)$/i.test(a.name)).length;
  const readyPr=['review','delivered'].includes(t.status);
  const artOnly=['invest','design'].includes(ty);
  const primary = t.status==='draft' ? `<button class="btn primary sm" data-rowplay="${escA(t.id)}">${IC.cright} iniciar</button>`
    : asking.length ? `<button class="btn primary sm" data-dcopen="${escA(t.id)}">responder</button>`
    : (!done && !t.prUrl && readyPr) ? (artOnly?`<button class="btn primary sm" data-arch="${escA(t.id)}">✓ concluir</button>`:`<button class="btn primary sm" data-rowpr="${escA(t.id)}">${IC.merge} aprovar e abrir PR</button>`)
    : (done ? `<button class="btn sm" data-dcopen="${escA(t.id)}">ver entrega</button>` : '');
  const segs=[1,2,3,4,5].map(i=>`<i class="${i<=ph?((asking.length&&i===ph)?'on warn':'on'):''}"></i>`).join('');
  const foot = done
    ? `<span class="dc-meta">${prN?`<span class="dc-pr" data-lk="${escA(t.prUrl)}">PR #${prN} ↗</span>`:''}${nImg?`<span>${nImg} prova${nImg===1?'':'s'}</span>`:''}${nDoc?`<span>${nDoc} doc${nDoc===1?'':'s'}</span>`:''}${rows.length?`<span>${okN}/${rows.length} requisitos provados</span>`:''}<span>${esc(fmtDurMs(taskDurationMs(t)))}</span></span>`
    : `<span class="seg5">${segs}</span><span class="dc-pct mono" data-sum="${escA(t.id)}" title="resumo do que já foi feito">${pct}%</span><span class="dc-msg">${msg}</span>`;
  return `<div class="dcard${done?' done':''}" data-id="${escA(t.id)}">
    <div class="dc-top"><span class="d" style="background:${dot}"></span><span class="dc-title">${esc(t.title)}</span><span class="dc-type" style="color:${TYPE_COLOR[ty]||'var(--muted)'}">${esc(TYPE_PT[ty]||ty)}</span><span class="prj"><span class="prjd" style="background:${projColor(t.repo||state.repo)}"></span>${esc(proj)}</span><span style="flex:1"></span>${pvChips(t,true)}${linkChips(t)}${primary}<button class="btn sm dc-menu" data-tmenu="${escA(t.id)}" title="mudar status / encerrar">⋯</button></div>
    ${t.objective?`<div class="dc-obj">${esc(String(t.objective).replace(/\s+/g,' ').slice(0,220))}</div>`:''}
    ${reqsHtml}
    <div class="dc-foot"><span class="ini2" style="background:${agentColor(t.agent)}">${esc((t.agent||'?').slice(0,2).toUpperCase())}</span><span class="dc-agent">${esc(t.agent||'')}${t.model?` <span class="dc-model">· ${esc(typeof aiModelName==='function'?aiModelName(t.model):t.model)}</span>`:''}</span>${foot}<span class="tm">${agoShort(ev?+new Date(ev.ts):(t.createdAt||t.created_at))}</span></div>
  </div>`;
}
// ---- ABA ENTREGA (dentro da demanda) ----
const artThumbCache={}; // taskId|name → dataUrl | null
function artThumb(taskId, name){
  const k=taskId+'|'+name;
  if(artThumbCache[k]!==undefined) return artThumbCache[k];
  artThumbCache[k]=null;
  invoke('read_artifact',{ taskId, name }).then(c=>{ artThumbCache[k]=(c&&c.kind==='image'&&c.dataUrl)||null; if(fwTask===taskId&&fwMode==='entrega') renderWorkspace(); }).catch(()=>{});
  return null;
}
function fwModesHtml(t){
  const M=[['entrega','Entrega'],['codigo','Código'],['conversa','Conversa'],['revisao','Revisão']]; if(t.prUrl) M.push(['pr','PR']);
  return M.map(([k,l])=>`<button class="fwmode${fwMode===k?' on':''}" data-fwmode="${k}">${l}</button>`).join('');
}
function fwRenderEntrega(t, main){
  const done=taskIsDone(t);
  if(reqProofCache[t.id]===undefined) loadReqProofs(t.id).then(()=>{ if(fwTask===t.id) renderWorkspace(); });
  const artC=artifactsCache[t.id];
  if(!artC||artC.status!==t.status) loadArtifacts(t.id, t.status).then(()=>{ if(fwTask===t.id) renderWorkspace(); });
  if(commitsCache[t.id]===undefined) loadCommits(t.id).then(()=>{ if(fwTask===t.id) renderWorkspace(); });
  const arts=(artC&&artC.list||[]).filter(a=>a.name!=='requirements.json');
  const imgs=arts.filter(a=>a.kind==='image');
  const docs=arts.filter(a=>!/\.(png|jpe?g|gif|webp|svg)$/i.test(a.name));
  const rows=reqRows(t); const okN=rows.filter(r=>r.st==='ok').length;
  const prN=prNumOf(t); const cost=taskCost(t.id); const d=diffOf(t.id); const rev=reviewOf(t.id);
  const c=commitsCache[t.id]||[];
  const evidenceNames=new Set(rows.flatMap(r=>r.evidence));
  const proofsHtml = imgs.length ? `<div class="en-proofs">${imgs.map((a,i)=>{ const th=artThumb(t.id,a.name); return `<button class="en-proof" data-lb="${i}" title="${escA(a.name)}">${th?`<img src="${th}" alt="">`:`<span class="en-ph">${IC.image}</span>`}<span class="en-pn">${esc(a.name)}</span>${evidenceNames.has(a.name)?'<span class="en-pv">evidência</span>':''}</button>`; }).join('')}</div>` : `<div class="en-empty">nenhum print de prova ainda${done?'':' — o agente anexa em .cardume/artifacts quando comprova um requisito'}</div>`;
  const reqHtml = rows.length ? rows.map(r=>`<div class="en-req ${r.st}"><span class="reqst ${r.st==='ok'?'ok':r.st==='blk'?'blk':'na'}">${r.st==='ok'?IC.check:r.st==='blk'?'!':'·'}</span><div class="en-rt"><div>${esc(r.text)}</div>${r.evidence.length?`<div class="en-ev">${r.evidence.map(e=>`<button class="reqevb mono" data-art="${escA(e)}">${esc(e)}</button>`).join('')}</div>`:''}${r.note&&r.st==='blk'?`<div class="reqnote">${esc(r.note)}</div>`:''}</div></div>`).join('') : '<div class="en-empty">sem critérios de aceite nesta demanda</div>';
  const docIc=n=>/\.pdf$/i.test(n)?'PDF':/\.html?$/i.test(n)?'HTML':/\.md$/i.test(n)?'MD':'TXT';
  const docsHtml = docs.length ? docs.map(a=>`<div class="en-doc"><span class="en-dic">${docIc(a.name)}</span><span class="en-dn">${esc(a.name)}<span class="en-dd">${artDate(a.created)}${a.size?' · '+(a.size<1024?a.size+' B':Math.round(a.size/1024)+' KB'):''}</span></span><span class="en-dacts"><button class="btn sm ghost" data-art="${escA(a.name)}">abrir</button>${/\.md$/i.test(a.name)?`<button class="btn sm ghost" data-docpdf="${escA(a.name)}">PDF</button>`:''}<button class="btn sm ghost" data-docslack="${escA(a.name)}">Slack</button></span></div>`).join('') : '<div class="en-empty">nenhum documento ainda</div>';
  const dels=(t.deliverables||[]).filter(Boolean);
  const timeline=stageStepper(t).replace('<div class="seclbl" style="margin-top:13px">Etapas</div>','');
  const dur=fmtDurMs(taskDurationMs(t));
  main.innerHTML=`<div class="enpage">
    <div class="en-head">
      <div class="en-ht"><span class="ndeyebrow">${esc(TYPE_PT[taskType(t)]||'demanda')} · ${done?'concluída':esc(PHASES[taskPhase(t)-1]||'')}</span><h2 class="en-h1">${esc(t.title)}</h2>${t.objective?`<p class="en-obj">${esc(t.objective)}</p>`:''}</div>
      <div class="en-kpis">
        ${prN?`<button class="en-kpi" data-lk="${escA(t.prUrl)}"><b>PR #${prN}</b><span>${done?'mergeado':'aberto'} ↗</span></button>`:''}
        <div class="en-kpi"><b>${okN}/${rows.length}</b><span>requisitos provados</span></div>
        <div class="en-kpi"><b>${d?`+${d.additions||0} −${d.deletions||0}`:'—'}</b><span>${d?(d.files||[]).length+' arquivo(s)':'sem diff'}</span></div>
        <div class="en-kpi"><b>${esc(dur||'—')}</b><span>${c.length} commit(s)${cost.usd>0?' · '+fmtUsd(cost.usd):''}</span></div>
      </div>
    </div>
    <div class="en-grid">
      <section class="en-sec"><div class="seclbl2">Entregáveis <span class="dim">· requisitos e a prova de cada um</span></div>${reqHtml}${dels.length?`<div class="seclbl2" style="margin-top:14px">Escopo combinado</div>${dels.map(x=>`<div class="en-del">◆ ${esc(x)}</div>`).join('')}`:''}${rev&&rev.howToTest?`<div class="seclbl2" style="margin-top:14px">Como testar</div><div class="en-how">${esc(rev.howToTest)}</div>`:''}</section>
      <section class="en-sec"><div class="seclbl2">Provas <span class="dim">· prints anexados pelo agente</span></div>${proofsHtml}
        <div class="seclbl2" style="margin-top:16px">Documentos <span style="flex:1"></span><button class="btn sm primary" id="enGen" title="a IA escreve o relatório desta entrega — o que foi feito, por quê, como e o que foi validado">${IC.ai} gerar relatório da entrega</button></div>
        <div id="enGenOut"></div>${docsHtml}</section>
    </div>
    <section class="en-sec" style="margin-top:6px"><div class="seclbl2">Linha do tempo</div><div class="en-tl">${timeline}</div>${c.length?`<div class="en-commits">${c.slice(0,8).map(x=>`<button class="fcommit" data-hash="${escA(x.hash||'')}"><span class="mono">${esc(String(x.hash||'').slice(0,7))}</span> ${esc(x.subject||'')}</button>`).join('')}</div>`:''}</section>
  </div>`;
  main.querySelectorAll('[data-art]').forEach(b=>b.onclick=()=>openArtifact(t.id, b.dataset.art));
  main.querySelectorAll('[data-lb]').forEach(b=>b.onclick=()=>lbOpen(t.id, imgs.map(a=>a.name), +b.dataset.lb));
  main.querySelectorAll('[data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  main.querySelectorAll('[data-docpdf]').forEach(b=>b.onclick=()=>entregaDocPdf(t, b.dataset.docpdf, b));
  main.querySelectorAll('[data-docslack]').forEach(b=>b.onclick=()=>sendArtifactSlack(t.id, b.dataset.docslack));
  main.querySelectorAll('.fcommit').forEach(b=>b.onclick=()=>{ if(b.dataset.hash&&typeof openCommit==='function') openCommit(b.dataset.hash); });
  bindClick('enGen', ()=>entregaGenReport(t));
}
// ---- lightbox das provas ----
let lbList=[], lbIdx=0, lbTask='';
function lbOpen(taskId, names, idx){ lbTask=taskId; lbList=names; lbIdx=idx||0; $id('lbOverlay').style.display='flex'; lbShow(); }
function lbShow(){
  const name=lbList[lbIdx]; if(!name) return;
  $id('lbCap').textContent=`${name} · ${lbIdx+1} de ${lbList.length}`;
  const img=$id('lbImg'); const th=artThumbCache[lbTask+'|'+name];
  if(th){ img.src=th; } else { img.removeAttribute('src'); invoke('read_artifact',{ taskId:lbTask, name }).then(c=>{ artThumbCache[lbTask+'|'+name]=c.dataUrl||null; if(lbList[lbIdx]===name) img.src=c.dataUrl||''; }).catch(()=>{}); }
  $id('lbPrev').style.visibility=lbIdx>0?'visible':'hidden'; $id('lbNext').style.visibility=lbIdx<lbList.length-1?'visible':'hidden';
}
function lbClose(){ $id('lbOverlay').style.display='none'; }
bindClick('lbClose', lbClose); bindClick('lbPrev', ()=>{ if(lbIdx>0){ lbIdx--; lbShow(); } }); bindClick('lbNext', ()=>{ if(lbIdx<lbList.length-1){ lbIdx++; lbShow(); } });
{ const o=$id('lbOverlay'); if(o) o.addEventListener('click', e=>{ if(e.target===o) lbClose(); }); }
document.addEventListener('keydown', e=>{ const o=$id('lbOverlay'); if(!o||o.style.display==='none') return; if(e.key==='Escape') lbClose(); if(e.key==='ArrowLeft'&&lbIdx>0){ lbIdx--; lbShow(); } if(e.key==='ArrowRight'&&lbIdx<lbList.length-1){ lbIdx++; lbShow(); } });
// ---- fatos da entrega → texto pra IA ----
async function entregaFacts(t){
  if(reqProofCache[t.id]===undefined) await loadReqProofs(t.id).catch(()=>{});
  if(commitsCache[t.id]===undefined) await loadCommits(t.id).catch(()=>{});
  if(t.prUrl && prCache[t.id]===undefined) await loadPr(t.id).catch(()=>{});
  const rows=reqRows(t); const d=diffOf(t.id); const rev=reviewOf(t.id); const c=commitsCache[t.id]||[]; const pr=prCache[t.id];
  const notas=eventsOf(t.id).filter(e=>['done','note'].includes(e.type)&&(e.text||'').length>30&&!/^(💬|❓|perguntou ao humano|humano respondeu)|sess[aã]o iniciada|claude finaliz|timeout|rework/i.test(e.text||'')).slice(-12).map(e=>`- ${e.agent||''}: ${String(e.text).slice(0,220)}`);
  const roles=(t.roles||[]).map(r=>`${r.name} (${r.role}, ${r.engine||''}${r.model?' '+r.model:''})`).join(', ');
  return [
    `DEMANDA: ${t.title}`, `TIPO: ${TYPE_PT[taskType(t)]||taskType(t)}`, `PROJETO: ${(state.repo||'').split('/').pop()}`,
    `OBJETIVO: ${t.objective||'—'}`,
    `REQUISITOS:\n${rows.map(r=>`- ${r.text} → ${r.st==='ok'?'PROVADO'+(r.evidence.length?' (evidência: '+r.evidence.join(', ')+')':''):r.st==='blk'?'NÃO PROVADO'+(r.note?' — '+r.note:''):'sem verificação'}`).join('\n')||'—'}`,
    `ENTREGÁVEIS COMBINADOS: ${(t.deliverables||[]).join(' | ')||'—'}`,
    `MUDANÇAS (assuntos dos commits): ${c.map(x=>x.subject||'').filter(Boolean).join(' | ')||'—'}`,
    `ESCOPO: ${d?`${(d.files||[]).length} arquivo(s), +${d.additions||0} −${d.deletions||0}`:'—'}`,
    `PR: ${t.prUrl?`#${prNumOf(t)} ${t.prUrl} · ${pr&&pr.state?pr.state:(taskIsDone(t)?'MERGED':'aberto')}${pr&&pr.body?'\nDESCRIÇÃO DO PR:\n'+String(pr.body).slice(0,2500):''}`:'sem PR'}`,
    `REVISÃO INTERNA: ${rev?(rev.summary||'')+(rev.howToTest?'\nCOMO TESTAR: '+rev.howToTest:''):'—'}`,
    `DIÁRIO DO AGENTE:\n${notas.join('\n')||'—'}`,
    `AGENTES: ${roles||t.agent||'—'}`, `DURAÇÃO: ${fmtDurMs(taskDurationMs(t))}`,
  ].join('\n\n');
}
async function entregaGenReport(t){
  const out=$id('enGenOut'), b=$id('enGen'); if(!out) return;
  if(b) b.disabled=true;
  out.innerHTML=cosmosHtml('a IA está escrevendo o relatório da entrega…','inline');
  try{
    const md=await invoke('ai_task_report',{ text: await entregaFacts(t), kind:'entrega', label:'Relatório de entrega — '+t.title });
    await invoke('write_artifact',{ taskId:t.id, name:'RELATORIO-ENTREGA.md', content:md });
    artifactsCache[t.id]=undefined; out.innerHTML='';
    repShow('Relatório de entrega — '+t.title, md, 'relatorio-'+t.id);
    renderWorkspace();
  }catch(e){ out.innerHTML=`<div class="imhint" style="border-left:2px solid var(--crit)">Falhou o relatório: ${esc(String(e&&e.message||e))}</div>`; }
  finally{ if(b) b.disabled=false; }
}
async function entregaDocPdf(t, name, btn){
  try{ if(btn){ btn.disabled=true; btn.textContent='PDF…'; } const c=await invoke('read_artifact',{ taskId:t.id, name }); const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(c.text||'', new Date().toLocaleDateString('pt-BR')), name: (t.id+'-'+name).replace(/\.md$/i,'') }); if(btn) btn.textContent='PDF ✓'; setTimeout(()=>{ if(btn){ btn.textContent='PDF'; btn.disabled=false; } },2500); }
  catch(e){ alert('Falhou o PDF:\n'+(e&&e.message||e)); if(btn){ btn.textContent='PDF'; btn.disabled=false; } }
}
// ---- modal do relatório (entrega ou período): ler · copiar · salvar .md · PDF ----
function repShow(title, md, fileBase){
  $id('repTitle').textContent=title;
  $id('repBody').innerHTML=`<div class="mdview" style="font-size:13.5px;line-height:1.65">${mdToHtml(md)}</div>`;
  $id('repFoot').innerHTML=`<span class="dim" id="repMsg" style="font-size:11px"></span><span style="flex:1"></span><button class="btn sm" id="repCopy">copiar</button><button class="btn sm" id="repMd">${ic('save')}salvar .md</button><button class="btn primary sm" id="repPdf">${ic('doc')}PDF</button>`;
  const msg=v=>{ const m=$id('repMsg'); if(m) m.textContent=v; };
  bindClick('repCopy', function(){ navigator.clipboard.writeText(md); this.textContent='copiado ✓'; });
  bindClick('repMd', async function(){ this.disabled=true; try{ const p=await invoke('save_doc',{ name:fileBase+'.md', content:md }); msg('salvo em '+p); }catch(e){ msg('falhou: '+(e&&e.message||e)); } this.disabled=false; });
  bindClick('repPdf', async function(){ this.disabled=true; const o=this.textContent; this.textContent='gerando PDF…'; try{ const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(md, new Date().toLocaleDateString('pt-BR')), name:fileBase }); msg('PDF em '+p); }catch(e){ msg('falhou o PDF: '+(e&&e.message||e)); } this.textContent=o; this.disabled=false; });
  bindClick('repClose', ()=>{ $id('repOverlay').style.display='none'; });
  $id('repOverlay').style.display='flex';
}
// ---- relatório do PERÍODO (Concluídas): várias entregas num documento ----
async function periodReport(){
  let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); }
  const tasks=flowVisible(src).filter(taskIsDone).sort((a,b)=>b.created_at-a.created_at).slice(0,25);
  if(!tasks.length){ alert('Nenhuma demanda concluída neste filtro/período.'); return; }
  const b=$id('flowPeriodRep'); if(b){ b.disabled=true; b.textContent='escrevendo…'; }
  try{
    const facts=[]; for(const t of tasks){ facts.push(await entregaFacts(t)); }
    const label={today:'hoje',week:'últimos 7 dias',month:'últimos 30 dias'}[flowPeriod]||'todas as entregas';
    const md=await invoke('ai_task_report',{ text: facts.join('\n\n=====\n\n'), kind:'periodo', label });
    repShow('Relatório de entregas — '+label, md, 'entregas-'+(flowPeriod||'todas'));
  }catch(e){ alert('Falhou o relatório: '+(e&&e.message||e)); }
  finally{ if(b){ b.disabled=false; b.innerHTML=ic('doc')+'relatório do período'; } }
}
