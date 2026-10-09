// Starfork — 45-entrega-time: a tarefa de um COLEGA abre como PÁGINA de entrega (uma aba),
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
  if(!tab){ tab={id, kind:'cttask', ct, title:(ct.title||'Tarefa do colega').slice(0,28)}; TABS.push(tab); }
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
    : `<div class="en-empty">${c.loaded?'nenhum print publicado — quem executa publica as provas pelo botão "publicar provas pro time" na tarefa dele':skeletonHtml('lista',{ n:2, compact:true, inline:true, label:'carregando as provas' })}</div>`;
  const reqHtml = rows.length ? rows.map(r=>`<div class="en-req ${r.st}"><span class="reqst ${r.st==='ok'?'ok':r.st==='blk'?'blk':'na'}">${r.st==='ok'?IC.check:r.st==='blk'?'!':'·'}</span><div class="en-rt"><div>${mdInline(r.text)}</div>${r.evidence.length?`<div class="en-ev">${r.evidence.map(e=>{ const a=findArt(e); return a?`<button class="reqevb mono" data-cart="${escA(a.storage_path)}" data-cname="${escA(a.name)}">${esc(e)}</button>`:`<span class="reqevb mono" title="essa evidência ainda não foi publicada pro time" style="opacity:.5;cursor:default">${esc(e)}</span>`; }).join('')}</div>`:''}${r.note&&r.st==='blk'?`<div class="reqnote">${esc(r.note)}</div>`:''}</div></div>`).join('') : '<div class="en-empty">sem requisitos no cartão</div>';
  const docIc=n=>/\.pdf$/i.test(n)?'PDF':/\.html?$/i.test(n)?'HTML':/\.md$/i.test(n)?'MD':/\.json$/i.test(n)?'JSON':'TXT';
  const docsHtml = docs.length
    ? docs.map(a=>`<div class="en-doc"><span class="en-dic">${docIc(a.name)}</span><span class="en-dn">${esc(a.name)}<span class="en-dd">${a.created_at?'há '+agoTx(a.created_at):''}${a.size?' · '+(a.size<1024?a.size+' B':Math.round(a.size/1024)+' KB'):''}</span></span><span class="en-dacts"><button class="btn sm ghost" data-cart="${escA(a.storage_path)}" data-cname="${escA(a.name)}">abrir</button><button class="btn sm ghost" data-cdl="${escA(a.storage_path)}" title="abrir no navegador (link assinado, 1h)">↗</button></span></div>`).join('')
    : `<div class="en-empty">${c.loaded?'nenhum documento publicado ainda':skeletonHtml('lista',{ n:2, compact:true, inline:true, label:'carregando os documentos' })}</div>`;
  const dels=(sp.deliverables||[]).filter(Boolean);
  const K={created:'criou o cartão',edited:'editou o cartão',claimed:'assumiu',released:'devolveu',assigned:'atribuiu a alguém',started:'iniciou',delivered:'publicou provas',comment:'comentou',status:'mudou o status'};
  const act=c.act||[];
  const timeline = act.length
    ? `<div class="stepper">${act.map((a,i)=>{ const last=i===act.length-1; return `<div class="step ${last?'cur':'done'}" style="cursor:default"><span class="smark">${last?'●':'✓'}</span><span class="stx"><span class="srole" style="text-transform:none">${esc(tmName(a.user_id))} · ${esc(K[a.kind]||a.kind)}</span><span class="sname">${esc(new Date(a.at).toLocaleString('pt-BR'))}${a.body?' — '+esc(String(a.body).slice(0,160)):''}</span></span></div>`; }).join('')}</div>`
    : `<div class="en-empty">${c.loaded?'sem atividade registrada':skeletonHtml('lista',{ n:3, compact:true, inline:true, label:'carregando a atividade' })}</div>`;
  const note = ct.last_note ? `<div class="seclbl2" style="margin-top:14px">Última nota do agente${ct.stage?` <span class="dim">· ${esc(ct.stage)}</span>`:''}</div><div class="en-how mdlite">${mdToHtml(ct.last_note)}</div>` : '';
  // F4 (G1, mesa tela 25): "Tarefa do colega" no padrão de página — título UMA vez, selo "Time · leitura", custo em
  // US$ (≈ R$) como no resto; revisar com agente (PR aberto) é a ação primária; ↻ no ⋯; Esc não fecha a aba
  const proj=((typeof teamProj!=='undefined'&&teamProj[ct.project_id])||{}).name||'';
  main.innerHTML=`<div class="enpage">${pageHead({ title:mdTitle(ct.title||'')||'Tarefa do colega', scope:'time', scopeLabel:'leitura', sum:`${esc(ctStLabel(ct))}${ep?' · ◆ '+esc(ep):''} · tarefa de ${esc(tmName(who))}${proj?' · '+esc(proj):''}`,
      primary:(prN&&!done)?{ id:'ctpReview', label:'Revisar com agente' }:null, more:{ id:'ctPageMore', title:'Atualizar · editar · cancelar' } })}
    <div class="en-head">
      <div class="en-ht">
        ${sp.objective?`<div class="en-obj mdlite">${mdToHtml(sp.objective)}</div>`:''}
        <div class="ctp-who">${ct.assignee?tsAv(ct.assignee, tsOnline(ct.assignee)):'<span class="tsav tmfree" aria-hidden="true">·</span>'}<span>${ct.assignee?'com <b>'+esc(ct.assignee===me?'você':tmName(ct.assignee))+'</b> · ':'<b>sem dono</b> · '}criada por <b>${esc(tmName(ct.created_by))}</b>${ct.branch?' · <span class="mono">'+esc(ct.branch)+'</span>':''}</span><span class="ctp-acts">${ctpActsHtml(ct, me)}</span>${canEdit?`<button class="btn sm ghost" id="ctpEdit">editar cartão</button><button class="btn sm ghost" id="ctpCancel" title="remover do backlog do time">✕ cancelar</button>`:''}</div>
      </div>
      <div class="en-kpis">
        ${prN?`<button class="en-kpi" data-lk="${escA(ct.pr_url)}"><b>PR #${prN}</b><span>${done?'mergeado':'aberto'} ↗</span></button>`:''}
        <div class="en-kpi"><b>${okN}/${rows.length}</b><span>requisitos provados</span></div>
        <div class="en-kpi"><b>${arts.length}</b><span>provas e documentos publicados</span></div>
        <div class="en-kpi"><b>${+ct.cost_usd>0?fmtUsdBr(+ct.cost_usd,{usdOnly:true}):'—'}</b><span>${+ct.cost_usd>0?'custo · ≈ R$ '+fmtNumBR(+ct.cost_usd*usdBrlRate(), true):'custo'}</span></div>
      </div>
    </div>
    <div class="en-grid">
      <section class="en-sec"><div class="seclbl2">Entregáveis <span class="dim">· requisitos e a prova de cada um</span></div>${reqHtml}${dels.length?`<div class="seclbl2" style="margin-top:14px">Escopo combinado</div>${dels.map(x=>`<div class="en-del">◆ ${mdInline(x)}</div>`).join('')}`:''}${note}</section>
      <section class="en-sec"><div class="seclbl2">Provas <span class="dim">· prints publicados por ${esc(tmName(who))}</span></div>${proofsHtml}
        <div class="seclbl2" style="margin-top:16px">Documentos</div>${docsHtml}</section>
    </div>
    <section class="en-sec" style="margin-top:6px"><div class="seclbl2">Linha do tempo</div><div class="en-tl">${timeline}</div></section>
  </div>`;
  main.querySelectorAll('[data-lb]').forEach(b=>b.onclick=()=>lbOpen(ct.id, imgs.map(a=>a.name), +b.dataset.lb));
  main.querySelectorAll('[data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  main.querySelectorAll('[data-cart]').forEach(b=>b.onclick=()=>openCloudArtifact(b.dataset.cart, b.dataset.cname));
  main.querySelectorAll('[data-cdl]').forEach(b=>b.onclick=async()=>{ try{ openExternal(await cloudSignedUrl(b.dataset.cdl)); }catch(e){ showErr(e, 'Falha ao abrir'); } });
  bindClick('ctpEdit', ()=>openCloudTask(ct));
  // mesma ação de Time › PRs pra revisar (avisa se o PR já foi revisado; a revisão vira tarefa na Central)
  bindClick('ctpReview', async()=>{ const b=$id('ctpReview'); if(b){ b.disabled=true; b.textContent='criando revisão…'; }
    const prev=(typeof cloudPrReviewCheck==='function')?await cloudPrReviewCheck(ct.pr_url).catch(()=>null):null;
    if(prev && !await askYes('Atenção: este PR já foi revisado '+(prev.mine?'por VOCÊ':'por '+prev.name)+' ('+prev.when+') pelo Starfork.\n\nRodar OUTRA revisão mesmo assim?')){ if(b){ b.disabled=false; b.textContent='Revisar com agente'; } return; }
    invoke('review_pr',{ prUrl:ct.pr_url, agents:null }).then(()=>{ lastSig=''; refresh(); toast('Revisão criada — está na sua Central','ok'); if(b) b.textContent='revisão criada ✓'; })
      .catch(err=>{ showErr(err, 'Não consegui criar a revisão'); if(b){ b.disabled=false; b.textContent='Revisar com agente'; } }); });
  // ⋯ = menu de verdade: atualizar (não trava), editar/cancelar o cartão (só no backlog, criador ou admin), abrir o PR
  { const mb=main.querySelector('#ctPageMore'); if(mb && typeof g1Menu==='function') mb.onclick=()=>g1Menu(mb, [
      { label:'Atualizar', hint:'da nuvem', act:()=>ctPageLoad(ct.id, true).then(()=>{ if(ctpTask&&ctpTask.id===ct.id) ctPageRender(); }) },
      ...(ct.pr_url?[{ label:'Abrir o PR', hint:prN?'#'+prN:'', act:()=>openExternal(ct.pr_url) }]:[]),
      ...(canEdit?[{ label:'Editar cartão', act:()=>openCloudTask(ct) }, { label:'Cancelar cartão…', danger:true, act:()=>{ if(window.epCardCancel) epCardCancel(ct); else teamDeleteCard(ct); } }]:[]) ]); }
  // assumir / iniciar / devolver / trocar — as MESMAS regras e ações do cartão no quadro do Time (43: tsActsHtml)
  main.querySelectorAll('.ctp-acts [data-act]').forEach(b=>b.onclick=async()=>{ const a=b.dataset.act;
    if(a==='claim'){ if(window.epCardStart) await epCardStart(ct, b); else await teamClaimStart(ct, b); }
    else if(a==='claimonly') await tsClaimOnly(ct, b); else if(a==='release') await tsRelease(ct, b); else if(a==='reassign') await tsReassign(ct, b);
    else if(a==='openproj' && typeof epOpenProjectOf==='function') epOpenProjectOf((typeof teamProj!=='undefined'&&teamProj[ct.project_id])||{});
    ctPageLoad(ct.id, true).then(()=>{ if(ctpTask&&ctpTask.id===ct.id) ctPageRender(); }); });
  bindClick('ctpCancel', ()=>{ if(window.epCardCancel) epCardCancel(ct); else teamDeleteCard(ct); });
  { const h=$id('ctPageName'); if(h) h.textContent=ct.title; const s=$id('ctPageSub'); if(s) s.textContent=((typeof teamProj!=='undefined'&&teamProj[ct.project_id])||{}).name||''; }
}
function ctpActsHtml(ct, me){
  if(typeof tsActsHtml!=='function') return '';
  const proj=((typeof teamProj!=='undefined'&&teamProj[ct.project_id])||null);
  if(ct.project_id && !proj) return tsActsHtml(ct, me, ct.status==='backlog' && (ct.claim_mode==='open'||ct.created_by===me), false, false, {}); // projeto ainda não carregado: só assumir/devolver (nunca iniciar no repo errado)
  const sameRepo=!proj.repo_remote||remoteSame(proj.repo_remote, (typeof teamRepoIds!=='undefined'&&teamRepoIds)||{ remote:(typeof teamRepoRemote!=='undefined'?teamRepoRemote:'') });
  const here=((typeof localRemoteList!=='undefined'&&localRemoteList)||[]);
  return tsActsHtml(ct, me, ct.status==='backlog' && (ct.claim_mode==='open'||ct.created_by===me), sameRepo, sameRepo||ctProjLocal(proj, here), proj);
}
// Abre um artefato PUBLICADO (Storage) no mesmo visualizador dos artefatos locais.
async function openCloudArtifact(storagePath, name){
  let url; try{ url=await cloudSignedUrl(storagePath); }catch(e){ showErr(e, 'Falha ao abrir'); return; }
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
// F4 (D24): Esc NUNCA fecha a aba da tarefa do colega — quem fecha é ⌘W (o Esc continua dos modais por cima)
