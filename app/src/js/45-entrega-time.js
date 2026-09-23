// Constellation — 45-entrega-time: a tarefa de um COLEGA abre como PÁGINA de entrega (uma aba),
// com o mesmo layout da aba "Entrega" das tarefas locais — só que alimentada pela nuvem:
// cartão (tasks), requisitos provados (requirements_proof), provas publicadas (artifacts_meta +
// Storage) e atividade (task_activity). O modal antigo (openCloudTask) fica só pra EDITAR o cartão.
let ctpTask=null;   // cartão aberto na aba ativa
const ctpCache={};  // cloudId → { task, arts, urls:{storage_path→url assinada}, act, loaded }

// Abre a tarefa do time. Se for MINHA e existir localmente → abre a aba completa da tarefa
// (código, conversa, entrega); senão → página de entrega com o que o time publicou.
function openCloudTaskPage(ct){
  const m=tmap(); const localId=Object.keys(m).find(k=>m[k]===ct.id);
  if(localId && (state.tasks||[]).some(t=>t.id===localId)){ openWorkspace(localId); return; }
  const id='cttask:'+ct.id;
  let tab=tabById(id);
  if(!tab){ tab={id, kind:'cttask', ct, title:(ct.title||'Tarefa do time').slice(0,26)}; TABS.push(tab); }
  else tab.ct=ct;
  activateTab(id);
}
window.openCloudTaskPage=openCloudTaskPage;
function ctPageOpenInner(tab){
  const ct=tab&&tab.ct; if(!ct) return;
  ctpTask=ct;
  $id('ctPageOverlay').style.display='flex';
  ctPageRender(); // abre na hora com o cartão; provas/atividade chegam em seguida
  ctPageLoad(ct.id, true).then(()=>{ if(ctpTask&&ctpTask.id===ct.id) ctPageRender(); });
}
window.ctPageOpenInner=ctPageOpenInner;
function ctpIsImg(a){ return a.kind==='image'||/\.(png|jpe?g|gif|webp|svg)$/i.test(a.name||''); }
async function ctPageLoad(cid, force){
  if(ctpCache[cid]&&ctpCache[cid].loaded&&!force) return ctpCache[cid];
  const c=ctpCache[cid]||{ task:null, arts:[], urls:{}, act:[], loaded:false };
  ctpCache[cid]=c;
  const [arts, act, fresh]=await Promise.all([
    sbGet('artifacts_meta?select=id,name,kind,size,storage_path,created_at,uploaded_by&task_id=eq.'+cid+'&order=created_at.desc').catch(()=>null),
    sbGet('task_activity?select=user_id,kind,body,at&task_id=eq.'+cid+'&order=id.asc&limit=80').catch(()=>null),
    sbGet('tasks?select=*&id=eq.'+cid).then(r=>(r&&r[0])||null).catch(()=>null),
  ]);
  if(arts) c.arts=arts; if(act) c.act=act;
  if(fresh){ c.task=fresh; if(ctpTask&&ctpTask.id===cid) ctpTask={...ctpTask, ...fresh}; const tab=tabById('cttask:'+cid); if(tab){ tab.ct={...(tab.ct||{}), ...fresh}; if(fresh.title) tab.title=fresh.title.slice(0,26); } }
  // URLs assinadas das imagens — miniaturas e o lightbox (que lê artThumbCache) reaproveitam
  await Promise.all(c.arts.filter(ctpIsImg).map(async a=>{ try{ const u=await cloudSignedUrl(a.storage_path); c.urls[a.storage_path]=u; artThumbCache[cid+'|'+a.name]=u; }catch(_){ } }));
  c.loaded=true;
  return c;
}
function ctPageRender(){
  const ct=ctpTask; if(!ct) return;
  const main=$id('ctPageMain'); if(!main) return;
  const c=ctpCache[ct.id]||{ arts:[], urls:{}, act:[], loaded:false };
  const me=cloudUserId();
  const sp=ct.spec||{};
  const reqs=(sp.requirements||[]).filter(Boolean);
  const rp=ct.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  const m=matchReqProofs(reqs, list);
  const rows=reqs.map((r,i)=>{ const p=m[i]; const st=p?(p.status==='done'?'ok':'blk'):'na'; return { text:r, st, evidence:(p&&Array.isArray(p.evidence))?p.evidence:[], note:(p&&p.note)||'' }; });
  const okN=rows.filter(r=>r.st==='ok').length;
  const arts=(c.arts||[]).filter(a=>a.name!=='requirements.json');
  const imgs=arts.filter(ctpIsImg), docs=arts.filter(a=>!ctpIsImg(a));
  const byName={}; arts.forEach(a=>{ byName[a.name]=a; byName[String(a.name).split('/').pop()]=a; });
  const findArt=e=>byName[e]||byName[String(e||'').split('/').pop()];
  const prN=(String(ct.pr_url||'').match(/\/pull\/(\d+)/)||[])[1]||'';
  const done=['merged','done'].includes(ct.status)||ct.flag==='closed';
  const who=ct.assignee||ct.created_by;
  const ep=ct.epic_id?(((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===ct.epic_id)||{}).name:'';
  const canEdit=ct.status==='backlog' && (ct.created_by===me || (typeof cloudData!=='undefined'&&cloudData&&(cloudData.meRole==='owner'||cloudData.meRole==='admin')));
  const evidenceNames=new Set(rows.flatMap(r=>r.evidence.map(e=>String(e).split('/').pop())));
  const proofsHtml = imgs.length
    ? `<div class="en-proofs">${imgs.map((a,i)=>{ const th=c.urls[a.storage_path]; return `<button class="en-proof" data-lb="${i}" title="${escA(a.name)}">${th?`<img src="${escA(th)}" alt="">`:`<span class="en-ph">${IC.image}</span>`}<span class="en-pn">${esc(a.name)}</span>${evidenceNames.has(String(a.name).split('/').pop())?'<span class="en-pv">evidência</span>':''}</button>`; }).join('')}</div>`
    : `<div class="en-empty">${c.loaded?'nenhum print publicado — quem executa publica as provas pelo botão "publicar provas pro time" na tarefa dele':'carregando provas…'}</div>`;
  const reqHtml = rows.length ? rows.map(r=>`<div class="en-req ${r.st}"><span class="reqst ${r.st==='ok'?'ok':r.st==='blk'?'blk':'na'}">${r.st==='ok'?IC.check:r.st==='blk'?'!':'·'}</span><div class="en-rt"><div>${esc(r.text)}</div>${r.evidence.length?`<div class="en-ev">${r.evidence.map(e=>{ const a=findArt(e); return a?`<button class="reqevb mono" data-cart="${escA(a.storage_path)}" data-cname="${escA(a.name)}">${esc(e)}</button>`:`<span class="reqevb mono" title="essa evidência ainda não foi publicada pro time" style="opacity:.5;cursor:default">${esc(e)}</span>`; }).join('')}</div>`:''}${r.note&&r.st==='blk'?`<div class="reqnote">${esc(r.note)}</div>`:''}</div></div>`).join('') : '<div class="en-empty">sem requisitos no cartão</div>';
  const docIc=n=>/\.pdf$/i.test(n)?'PDF':/\.html?$/i.test(n)?'HTML':/\.md$/i.test(n)?'MD':/\.json$/i.test(n)?'JSON':'TXT';
  const docsHtml = docs.length
    ? docs.map(a=>`<div class="en-doc"><span class="en-dic">${docIc(a.name)}</span><span class="en-dn">${esc(a.name)}<span class="en-dd">${a.created_at?'há '+agoTx(a.created_at):''}${a.size?' · '+(a.size<1024?a.size+' B':Math.round(a.size/1024)+' KB'):''}</span></span><span class="en-dacts"><button class="btn sm ghost" data-cart="${escA(a.storage_path)}" data-cname="${escA(a.name)}">abrir</button><button class="btn sm ghost" data-cdl="${escA(a.storage_path)}" title="abrir no navegador (link assinado, 1h)">↗</button></span></div>`).join('')
    : `<div class="en-empty">${c.loaded?'nenhum documento publicado ainda':'carregando…'}</div>`;
  const dels=(sp.deliverables||[]).filter(Boolean);
  const K={created:'criou o cartão',edited:'editou o cartão',claimed:'assumiu',released:'liberou',started:'iniciou',delivered:'publicou provas',comment:'comentou',status:'mudou o status'};
  const act=c.act||[];
  const timeline = act.length
    ? `<div class="stepper">${act.map((a,i)=>{ const last=i===act.length-1; return `<div class="step ${last?'cur':'done'}" style="cursor:default"><span class="smark">${last?'●':'✓'}</span><span class="stx"><span class="srole" style="text-transform:none">${esc(tmName(a.user_id))} · ${esc(K[a.kind]||a.kind)}</span><span class="sname">${esc(new Date(a.at).toLocaleString('pt-BR'))}${a.body?' — '+esc(String(a.body).slice(0,160)):''}</span></span></div>`; }).join('')}</div>`
    : `<div class="en-empty">${c.loaded?'sem atividade registrada':'carregando…'}</div>`;
  const note = ct.last_note ? `<div class="seclbl2" style="margin-top:14px">Última nota do agente${ct.stage?` <span class="dim">· ${esc(ct.stage)}</span>`:''}</div><div class="en-how">${esc(ct.last_note)}</div>` : '';
  main.innerHTML=`<div class="enpage">
    <div class="en-head">
      <div class="en-ht">
        <span class="ndeyebrow">tarefa do time · ${esc(ctStLabel(ct))}${ep?' · ◆ '+esc(ep):''}</span>
        <h2 class="en-h1">${esc(ct.title)}</h2>
        ${sp.objective?`<p class="en-obj">${esc(sp.objective)}</p>`:''}
        <div class="ctp-who">${tsAv(who, tsOnline(who))}<span>${ct.assignee?'com <b>'+esc(tmName(ct.assignee))+'</b> · ':''}criada por <b>${esc(tmName(ct.created_by))}</b>${ct.branch?' · <span class="mono">'+esc(ct.branch)+'</span>':''}</span>${canEdit?`<button class="btn sm ghost" id="ctpEdit">editar cartão</button>`:''}</div>
      </div>
      <div class="en-kpis">
        ${prN?`<button class="en-kpi" data-lk="${escA(ct.pr_url)}"><b>PR #${prN}</b><span>${done?'mergeado':'aberto'} ↗</span></button>`:''}
        <div class="en-kpi"><b>${okN}/${rows.length}</b><span>requisitos provados</span></div>
        <div class="en-kpi"><b>${arts.length}</b><span>publicado(s) pro time</span></div>
        <div class="en-kpi"><b>${+ct.cost_usd>0?fmtUsd(+ct.cost_usd):'—'}</b><span>${+ct.cost_tokens>0?Math.round(ct.cost_tokens/1000)+'k tokens':'custo'}</span></div>
      </div>
    </div>
    <div class="en-grid">
      <section class="en-sec"><div class="seclbl2">Entregáveis <span class="dim">· requisitos e a prova de cada um</span></div>${reqHtml}${dels.length?`<div class="seclbl2" style="margin-top:14px">Escopo combinado</div>${dels.map(x=>`<div class="en-del">◆ ${esc(x)}</div>`).join('')}`:''}${note}</section>
      <section class="en-sec"><div class="seclbl2">Provas <span class="dim">· prints publicados por ${esc(tmName(who))}</span></div>${proofsHtml}
        <div class="seclbl2" style="margin-top:16px">Documentos</div>${docsHtml}</section>
    </div>
    <section class="en-sec" style="margin-top:6px"><div class="seclbl2">Linha do tempo</div><div class="en-tl">${timeline}</div></section>
  </div>`;
  main.querySelectorAll('[data-lb]').forEach(b=>b.onclick=()=>lbOpen(ct.id, imgs.map(a=>a.name), +b.dataset.lb));
  main.querySelectorAll('[data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  main.querySelectorAll('[data-cart]').forEach(b=>b.onclick=()=>openCloudArtifact(b.dataset.cart, b.dataset.cname));
  main.querySelectorAll('[data-cdl]').forEach(b=>b.onclick=async()=>{ try{ openExternal(await cloudSignedUrl(b.dataset.cdl)); }catch(e){ alert('Falha ao abrir: '+(e.message||e)); } });
  bindClick('ctpEdit', ()=>openCloudTask(ct));
  { const h=$id('ctPageName'); if(h) h.textContent=ct.title; const s=$id('ctPageSub'); if(s) s.textContent=((typeof teamProj!=='undefined'&&teamProj[ct.project_id])||{}).name||''; }
}
// Abre um artefato PUBLICADO (Storage) no mesmo visualizador dos artefatos locais.
async function openCloudArtifact(storagePath, name){
  let url; try{ url=await cloudSignedUrl(storagePath); }catch(e){ alert('Falha ao abrir: '+(e.message||e)); return; }
  const isImg=/\.(png|jpe?g|gif|webp|svg)$/i.test(name), isPdf=/\.pdf$/i.test(name), isMd=/\.(md|markdown)$/i.test(name), isTxt=/\.(txt|json|csv|yaml|yml|log|html?)$/i.test(name);
  if(!(isImg||isPdf||isMd||isTxt)){ openExternal(url); return; }
  let body='';
  if(isImg) body=`<img class="artimg" src="${escA(url)}" alt="${escA(name)}">`;
  else if(isPdf) body=`<iframe class="pdfview" src="${escA(url)}#zoom=page-width" title="${escA(name)}"></iframe>`;
  else { let tx=''; try{ const r=await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); tx=await r.text(); }catch(_){ openExternal(url); return; } body=isMd?`<div class="mdview">${mdToHtml(tx)}</div>`:`<pre class="artpre">${esc(tx)}</pre>`; }
  const modal=document.querySelector('#artOverlay .modal'); if(modal) modal.classList.toggle('pdfmode', isPdf);
  $id('artIcon').innerHTML=isImg?IC.image:IC.doc; $id('artTitle').textContent=name; $id('artBody').innerHTML=body;
  { const h=document.querySelector('#artOverlay .mhead'); ['artOpenExt','artSlack','artFinder'].forEach(id=>{ const o=$id(id); if(o) o.remove(); });
    if(h){ const x=h.querySelector('#artClose'); const bx=document.createElement('button'); bx.id='artOpenExt'; bx.className='btn sm'; bx.style.marginRight='8px'; bx.textContent='↗ abrir no navegador'; bx.onclick=()=>openExternal(url); h.insertBefore(bx, x); } }
  $id('artOverlay').style.display='flex';
}
bindClick('ctPageClose', ()=>closeTabOfKind('cttask'));
bindClick('ctPageRefresh', ()=>{ if(ctpTask){ const b=$id('ctPageRefresh'); if(b) b.disabled=true; ctPageLoad(ctpTask.id, true).then(()=>{ ctPageRender(); if(b) b.disabled=false; }); } });
// Esc fecha a aba — em fase de CAPTURA, pra decidir ANTES de os handlers do lightbox/artefato
// fecharem o modal deles (senão o mesmo esc fechava o modal E a aba).
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const o=$id('ctPageOverlay'); if(!o||o.style.display==='none'||!o.classList.contains('astab')) return;
  // com um modal aberto por cima (artefato, lightbox, editar cartão), o esc é deles
  if(['artOverlay','lbOverlay','ctOverlay'].some(id=>{ const m=$id(id); return m&&m.style.display!=='none'; })) return;
  if(e.target&&/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  closeTabOfKind('cttask');
}, true);
