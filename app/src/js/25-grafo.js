// Starfork — 25-grafo
// ============================================================================
// GRAFO v2 — trilhos por tarefa: cada branch é uma linha horizontal legível
// (fork na base → commits clicáveis → ponta com o agente e a cor do status →
// seta de merge quando voltou pra main). A main vira a régua de cima.
// ============================================================================
function renderGraph(){
  const pane=$id("graphPane");
  const svg=$id("graphSvg"); if(svg) svg.style.display='none';
  let host=$id('gtl');
  if(!host){ host=document.createElement('div'); host.id='gtl'; pane.appendChild(host); }
  const commits=state.graph||[];
  const mainCommits=commits.filter(c=>{ const r=parseRefs(c.refs); return r.includes('main')||r.includes('master')||!(c.parents||[]).length||true; }).slice(0,14);
  const tasks=(state.tasks||[]).filter(t=>t.kind!=='review' && t.status!=='draft' && notHidden(t));
  const ORDER={running:0,thinking:0,queued:1,'plan-review':1,paused:1,error:2,conflict:2,review:3,aborted:4,merged:5};
  tasks.sort((a,b)=>(ORDER[a.status]??3)-(ORDER[b.status]??3) || taskTs(b)-taskTs(a));
  // garante os commits de cada tarefa (lazy — re-renderiza quando chegar)
  tasks.forEach(t=>{ if(commitsNeedLoad(t.id) && !commitsLoading[t.id]){ const before=JSON.stringify(commitsCache[t.id]||null); loadCommits(t.id).then(c=>{ if(JSON.stringify(c||null)!==before) lastSig=''; }); } });
  const railW=520;
  const rail=(t)=>{
    const cs=(commitsCache[t.id]||[]).slice().reverse(); // antigo → novo
    const col=stColor(taskSt(t));
    const n=cs.length, shown=cs.slice(-24);
    const x0=16, xTip=railW-30;
    const step=shown.length>1?Math.min(34,(xTip-40-x0)/(shown.length-1)):0;
    let g=`<line x1="${x0}" y1="20" x2="${xTip}" y2="20" stroke="${col}" stroke-width="2" opacity=".45"/>`;
    g+=`<circle cx="${x0}" cy="20" r="3.5" fill="var(--surface-3)" stroke="${col}" stroke-width="1.5"/>`; // fork
    shown.forEach((c,i)=>{ const x=x0+18+i*step;
      g+=`<circle class="gdot" data-hash="${escA(c.hash)}" cx="${x}" cy="20" r="5" fill="var(--surface)" stroke="${col}" stroke-width="2" style="cursor:pointer"><title>${escA((c.subject||'').slice(0,90))}</title></circle>`; });
    const tip=`<g style="cursor:pointer" data-tsel="${escA(t.id)}"><circle cx="${xTip}" cy="20" r="11" fill="var(--surface)" stroke="${col}" stroke-width="2"${ACTIVE_ST.has(t.status)?' class="gtipping"':''}/><text x="${xTip}" y="23" text-anchor="middle" font-size="8" font-weight="700" fill="${col}">${esc((t.agent||'?').slice(0,2).toUpperCase())}</text></g>`;
    const merge=t.status==='merged'?`<path d="M${xTip+11} 20 C ${xTip+24} 20 ${xTip+24} 6 ${xTip+34} 6" fill="none" stroke="${col}" stroke-width="2" opacity=".7"/><text x="${xTip+38}" y="9" font-size="8" fill="${col}">main</text>`:'';
    return `<svg width="${railW+70}" height="40" viewBox="0 0 ${railW+70} 40">${g}${tip}${merge}</svg>`+(n>24?`<span class="dim" style="font-size:var(--fs-xs)">+${n-24}</span>`:'');
  };
  const rows=tasks.map(t=>{
    const col=stColor(taskSt(t));
    const cs=commitsCache[t.id];
    return `<div class="grow2${t.id===selected?' sel':''}" data-tsel="${escA(t.id)}" tabindex="0" title="abrir a tarefa">
      <div class="grh">
        <span class="cav" aria-hidden="true" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span>
        <b class="grt">${esc(t.title)}</b>
        ${typeof epTaskBadge==='function'?epTaskBadge(t):''}
        ${linkChips(t)}
        <span style="flex:1"></span>
        <span class="mono dim" style="font-size:var(--fs-xs)">${esc(t.base||'main')} → ${esc(t.branch)}</span>
        ${stBadge(taskSt(t))}${t.flag==='blocked'?' <span class="flagbadge blk">bloqueada</span>':''}
      </div>
      <div class="grrail">${cs===undefined?'<div style="padding:8px 16px">'+skeletonHtml('lista',{ n:2, compact:true, inline:true, label:'carregando os commits' })+'</div>':(cs.length?rail(t):'<span class="dim" style="font-size:var(--fs-xs);padding:8px 16px;display:inline-block">sem commits ainda</span>')}</div>
    </div>`;
  }).join('');
  const mainRow=mainCommits.length?`<div class="grmain"><span class="mono" style="color:var(--text-2);font-size:var(--fs-xs);font-weight:700">main</span><div class="grmc">${mainCommits.slice(0,12).map(c=>`<span class="gmdot" data-hash="${escA(c.hash)}" title="${escA((c.subject||'').slice(0,90))}"></span>`).join('')}</div><span class="dim" style="font-size:var(--fs-xs)">últimos ${Math.min(12,mainCommits.length)} commits · clique num ponto pra ver o diff</span></div>`:'';
  // R7: vazio padrão (com saída) e guarda de innerHTML — o render roda a cada tick do snapshot e antes
  // reescrevia o grafo inteiro sempre (piscava e engolia o clique no meio); agora só quando o HTML mudou
  const empty=emptyHtml({ icon:'route', title:'Nenhuma tarefa com branch ainda', help:'Cada demanda iniciada ganha um trilho aqui, com os commits do agente e a ponta na cor do status.', action:{ id:'gtlNew', label:'Nova demanda' } });
  if(!setHtmlGuarded(host, `<div class="gtlwrap">${mainRow}${rows||empty}</div>`)) return;
  bindClick('gtlNew', ()=>{ if(window.openTab) window.openTab('nova'); else openNewTask(); });
  // .sel = a última tarefa aberta (openTaskById grava `selected`) — ao voltar pro grafo, você acha de onde veio
  host.querySelectorAll('.gdot,.gmdot').forEach(d=>{ d.onclick=(e)=>{ e.stopPropagation(); openCommit(d.dataset.hash); }; });
  host.querySelectorAll('[data-epbadge]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); if(typeof epOpenById==='function') epOpenById(b.dataset.epbadge); }); // R5-7
  // R7: clicar no trilho ABRE a tarefa (antes só "selecionava" — sem o painel lateral antigo, o clique não fazia nada visível)
  host.querySelectorAll('[data-tsel]').forEach(r=>{
    r.addEventListener('click',(e)=>{ if(e.target.closest('.gdot,.gmdot,[data-lk],[data-lkcfg],[data-epbadge]')) return; e.stopPropagation(); openTaskById(r.dataset.tsel); });
    if(r.classList.contains('grow2')) r.addEventListener('keydown',(e)=>{ if(e.target===r && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); openTaskById(r.dataset.tsel); } });
  });
  wireLinkChips(host);
}
const DEFPAT=[/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/,/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/,/^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_,\s]*)\s*=>/,/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/,/^\s*def\s+([A-Za-z0-9_]+)/,/^\s*#\[tauri::command\]/];
function camelIdJS(s){ const w=String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).slice(0,4); return w.map((x,i)=>i?x.charAt(0).toUpperCase()+x.slice(1):x).join(""); }
function parseDiff(diff){
  const files=[]; let cur=null, oldLn=0, newLn=0;
  for(const l of (diff||"").split("\n")){
    if(l.startsWith("diff --git")){ const m=l.match(/^diff --git a\/(.+?) b\/(.+)$/); cur={path:m?m[2]:"", rows:[]}; files.push(cur); continue; }
    if(!cur) continue;
    if(l.startsWith("index ")||l.startsWith("new file")||l.startsWith("deleted file")||l.startsWith("similarity")||l.startsWith("rename ")||l.startsWith("--- ")||l.startsWith("+++ ")||l.startsWith("\\ ")) continue;
    if(l.startsWith("@@")){ const m=l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/); if(m){ oldLn=+m[1]; newLn=+m[2]; } cur.rows.push({t:"hunk", text:l}); continue; }
    if(l.startsWith("+")){ cur.rows.push({t:"add", n:newLn, text:l.slice(1)}); newLn++; }
    else if(l.startsWith("-")){ cur.rows.push({t:"del", o:oldLn, text:l.slice(1)}); oldLn++; }
    else { cur.rows.push({t:"ctx", o:oldLn, n:newLn, text:l.slice(1)}); oldLn++; newLn++; }
  }
  return files;
}
function commitTech(files){
  let add=0, del=0; const addFns=[], delFns=[], names=[];
  for(const f of files){
    if(f.path && !/^\.cardume\//.test(f.path)) names.push(f.path);
    for(const r of f.rows){
      if(r.t==="add"){ add++; for(const p of DEFPAT){ const m=r.text.match(p); if(m&&m[1]){ addFns.push(m[1]); break; } } }
      else if(r.t==="del"){ del++; for(const p of DEFPAT){ const m=r.text.match(p); if(m&&m[1]){ delFns.push(m[1]); break; } } }
    }
  }
  const uniq=a=>[...new Set(a)];
  const af=uniq(addFns), df=uniq(delFns).filter(x=>!af.includes(x));
  const parts=[`Altera ${names.length} arquivo(s) · +${add} −${del} linhas.`];
  if(af.length) parts.push(`Introduz ${af.slice(0,8).join(", ")}${af.length>8?"…":""}.`);
  if(df.length) parts.push(`Remove/renomeia ${df.slice(0,6).join(", ")}${df.length>6?"…":""}.`);
  return { text: parts.join(" "), addFns: af, files: names };
}
function renderDiff(files){
  let total=0, out="", truncated=false;
  for(const f of files){
    if(!f.rows.length) continue;
    let rows="";
    for(const r of f.rows){
      if(total>1500){ truncated=true; break; }
      total++;
      if(r.t==="hunk"){ rows+=`<div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="lc">${esc(r.text)}</span></div>`; continue; }
      const sign=r.t==="add"?"+":r.t==="del"?"−":" ";
      rows+=`<div class="dl ${r.t}"><span class="ln">${r.o||""}</span><span class="ln">${r.n||""}</span><span class="lc">${esc(sign+" "+r.text)}</span></div>`;
    }
    out+=`<div class="difffile"><div class="fh"><span class="p mono">${esc(f.path)}</span></div><div class="dlines">${rows}</div></div>`;
    if(truncated) break;
  }
  if(truncated) out+='<div class="dim" style="font-size:var(--fs-xs);margin-top:6px">…diff grande, truncado.</div>';
  return out || '<div class="dim" style="font-size:var(--fs-sm)">sem alterações de linha (ex.: merge)</div>';
}
let curCommit=null;
async function openCommit(hash){
  curCommit=hash;
  const ov=$id("cmOverlay"), body=$id("cmBody");
  ov.style.display="flex"; ldPaint(body, skeletonHtml('tabela',{ n:6, cols:2, label:'carregando o commit' }));
  let d; try{ d=await invoke("commit_detail",{hash}); }
  catch(e){ if(curCommit!==hash) return; body.innerHTML=errorHtml(e,'cmRetry','Não consegui abrir o commit'); ldWireErr(body,e,'Não consegui abrir o commit',()=>openCommit(hash)); return; }
  if(curCommit!==hash) return; // outro commit foi aberto enquanto este carregava
  const files = parseDiff(d.diff);
  const tech = commitTech(files);
  // vincula à tarefa e ao(s) entregável(is)
  let taskBox="";
  const t = d.taskId ? (state.tasks||[]).find(x=>x.id===d.taskId) : null;
  if(t){
    const dels = Array.isArray(t.deliverables)?t.deliverables:[];
    const matched = dels.filter(dl=> tech.addFns.some(fn=> fn.toLowerCase()===camelIdJS(dl).toLowerCase()));
    const rel = matched.length?matched:dels;
    taskBox = `<div class="cmtask">
      <div class="cmtask-h">Parte da tarefa</div>
      <div class="cmtask-t">${esc(t.title)} <span class="dim">· ${esc(t.agent)}</span></div>
      ${t.objective?`<div class="cmtask-o">${esc(t.objective)}</div>`:''}
      ${rel.length?`<div class="cmtask-dl">${matched.length?'Entregável relacionado:':'Entregáveis da tarefa:'}${rel.map(x=>`<span class="delchip${matched.includes(x)?' on':''}">${esc(x)}</span>`).join("")}</div>`:''}
    </div>`;
  }
  body.innerHTML = `
    <div class="cmsub">${esc(d.subject)}</div>
    <div class="cmmeta"><span class="mono">${esc((d.hash||"").slice(0,8))}</span> · ${esc(d.author)} · ${esc(d.date)}</div>
    ${taskBox}
    <div class="cmsum"><div class="cmsum-h">Resumo técnico</div><div id="cmAI" class="cmai"></div><div class="cmstat">${esc(tech.text)}</div></div>
    ${d.body?`<div class="cmbody-txt">${esc(d.body).replace(/\n/g,"<br>")}</div>`:''}
    <div class="seclbl2" style="margin-top:15px">Alterações <span style="flex:1"></span><span class="dim" style="letter-spacing:0;text-transform:none">${d.files.length} arquivo(s)</span></div>
    <div class="diffwrap">${renderDiff(files)}</div>
    ${(t && t.status!=='merged' && (t.roles||[]).some(r=>aiCanTalk(r.engine))) ? `<div class="instrbox" style="margin-top:14px">
      <div class="ilbl">${IC.ai} Pedir ajuste neste commit</div>
      <div class="ihint">Descreva o que não ficou bom — o agente refaz na worktree (mesma sessão) e recompõe o review.</div>
      <div class="irow"><input class="in iinput" id="cmRwInput" placeholder="ex.: renomeia verify() para verifyTotp()"><button class="btn primary sm" id="cmRwSend">pedir ajuste</button></div>
    </div>` : ''}`;
  const rwBtn=$id("cmRwSend");
  if(rwBtn && t) rwBtn.onclick=()=>sendRework(t.id, $id("cmRwInput"), `Sobre o commit ${(d.hash||'').slice(0,8)} (${d.subject}): `);
  const h=hash;
  const aiEl=$id("cmAI");
  let cached=null; try{ cached=await invoke("commit_summary_cached",{hash:h}); }catch(e){}
  if(curCommit!==h) return;
  if(cached){ aiEl.textContent=cached; }
  else{
    aiEl.innerHTML=`<button class="btn sm" id="cmAIbtn">${IC.ai} Explicar com IA</button> <span class="dim" style="font-size:var(--fs-xs)">gera um resumo do que foi feito e por quê (usa Claude · fica em cache)</span>`;
    const b=$id("cmAIbtn"); if(b) b.onclick=()=>genAI(h);
  }
}
async function genAI(h){
  const el=$id("cmAI"); if(!el) return;
  el.innerHTML='<span class="dim">gerando resumo com IA…</span>';
  try{ const s=await invoke("ai_commit_summary",{hash:h}); if(curCommit!==h) return; $id("cmAI").textContent=s; }
  catch(e){ if(curCommit!==h) return; const x=$id("cmAI"); x.innerHTML='<span class="dim">'+esc(humanErr(e,'Não foi possível gerar').msg)+'</span> <button class="btn sm" id="cmAIbtn2">tentar de novo</button>'; const b=$id("cmAIbtn2"); if(b) b.onclick=()=>genAI(h); }
}
function closeCommit(){ curCommit=null; $id("cmOverlay").style.display="none"; }

const ACTIVE_ST = new Set(["running","thinking","queued"]);
// limite "confortável" de execuções em paralelo (slots) — só orienta/avisa.
let slotMax = (()=>{ const v=parseInt(lsGet('slotMax')||'4',10); return (v>=1&&v<=12)?v:4; })();
function setSlotMax(n){ slotMax=Math.max(1,Math.min(12,n)); lsSet('slotMax',String(slotMax)); renderRail(); }
function lastEventOf(taskId){ const es=eventsOf(taskId); return es.length?es[es.length-1]:null; }
// Rail = monitor de EXECUÇÃO AO VIVO (não duplica o Fluxo): só o que acontece agora.
// destaque da barra lateral = o que está NA TELA (crítica Impeccable P1, 02/10): a demanda da aba ativa e, com a
// tela dividida, TODAS as demandas visíveis nos painéis; aria-current na do painel em foco. Antes vinha de
// `selected` (última tarefa clicada), que nem ⌘1–9 nem o clique na aba atualizavam — o destaque mentia.
// @rail-hi-inicio (testado em app/tests/critica-impeccable.test.mjs)
function railHiOf(tab, splitIds, focusIdx, tabOf){
  const ids=[]; const add=(tb)=>{ const id=tb&&tb.taskId; if(id && !ids.includes(id)) ids.push(id); };
  if(!tab) return { ids, cur:null };
  const inSplit=!!(splitIds && splitIds.includes(tab.id));
  if(inSplit) splitIds.forEach(id=>add(tabOf(id))); else add(tab);
  const ft=inSplit ? tabOf(splitIds[focusIdx|0]||tab.id) : tab;
  return { ids, cur:(ft&&ft.taskId)||null };
}
// @rail-hi-fim
function railHi(){
  try{ const spl=(typeof SPL!=='undefined')?SPL:null;
    return railHiOf(tabById(activeTab), spl&&spl.ids, spl?spl.focus:0, tabById); }catch(_){ return { ids:[], cur:null }; }
}
function renderRail(){
  // sidebar por PROJETO (redesign p2/p6): projeto atual com as sessões vivas,
  // depois os outros repos salvos, e o total no rodapé.
  const el = $id("rail");
  const curPath=state.repo||'';
  const curName=pathBase(curPath)||'projeto';
  // etiqueta e ponto = o status EFETIVO (taskSt: pergunta aberta vence, PR aberto = 'pr-open') com o nome curto e
  // a cor do STATUS_META — antes era um vocabulário próprio (exec/disc/rev/rasc/ampulheta) que juntava erro/conflito/abortada em "erro"
  const tagOf=(t)=>{ const st=taskSt(t); return [stShort(st), stColor(st), stLabel(st)]; };
  const dotOf=(t)=> stColor(taskSt(t));
  // MESMA regra de visibilidade do quadro (bloqueadas e encerradas ficam fora — o quadro tem o chip pra revelar)
  const mine=(state.tasks||[]).filter(t=>t.flag!=='closed'&&t.flag!=='blocked'&&!['merged','done'].includes(t.status));
  const ord=t=> pendingOf(t.id).length?0 : t.status==='plan-review'?1 : (ACTIVE_ST.has(t.status)||t.status==='thinking')?2 : ['review','delivered'].includes(t.status)?3 : t.status==='draft'?5 : 4;
  const rows=mine.slice().sort((a,b)=>ord(a)-ord(b)|| taskTs(b)-taskTs(a)).slice(0,12);
  const hi=railHi();
  const liveN=mine.filter(t=>ACTIVE_ST.has(t.status)||t.status==='thinking'||t.status==='plan-review'||pendingOf(t.id).length).length;
  // rank de tarefa de OUTRO projeto (sem pendingOf): review/entregue e ativas em cima
  const rankOther=(t)=> (t.status==='review'||t.status==='delivered')?3 : (ACTIVE_ST.has(t.status)||t.status==='thinking')?2 : t.status==='plan-review'?1 : 0;

  // ---- PROJETO ATUAL (tarefas vivas do state, já priorizadas: pendência → plano → exec → review) ----
  let html = '';
  // R7: o número é o TOTAL de demandas vivas (antes era o das linhas mostradas, cortado em 12) e o que não coube
  // vira uma linha "+N na Central" que abre a Central filtrada neste projeto
  html+=`<div class="rproj on" title="projeto atual"><div class="rph"><b>${esc(curName)}</b><span class="n" title="${escA(nPl(mine.length,'demanda viva','demandas vivas'))}">${mine.length}</span></div>${gitRailTag()}</div>`;
  if(window.orqRailRows) html+=window.orqRailRows();
  if(rows.length){
    html+=rows.map(t=>{ const [tg,tc,tl]=tagOf(t);
      return `<div class="prow2${hi.ids.includes(t.id)?' sel':''}" data-id="${t.id}" role="button" tabindex="0"${hi.cur===t.id?' aria-current="page"':''}><span class="d" style="background:${dotOf(t)}"></span><span class="tt" title="${escA(t.title)}">${esc(t.title)}</span>${sbEpDot(t)}<span class="tg" style="color:${tc}" title="${escA(tl)}">${esc(tg)}</span></div>`;
    }).join('');
    if(mine.length>rows.length) html+=`<div class="prow2 more" data-more="1" role="button" tabindex="0" title="ver todas as demandas deste projeto na Central"><span class="tt dim">+${mine.length-rows.length} na Central</span></div>`;
  } else if(!(window.orqRailRows&&window.orqRailRows())){
    html+=`<div class="prow2 emptyrow"><span class="tt dim" style="font-size:var(--fs-xs)">${repoHasGit()?'sem demanda ativa':'pasta sem git — crie o repositório'}</span></div>`;
  }

  // ---- TODOS os OUTROS projetos com as últimas demandas (ativos primeiro; exec/review em cima) ----
  const allOthers=(projOv||[]).filter(p=>p.path!==curPath)
    .sort((a,b)=> (b.active+b.review)-(a.active+a.review) || String(a.name).localeCompare(String(b.name)));
  for(const p of allOthers){
    const act=p.active+p.review;
    html+=`<div class="rproj"><div class="rph"><b>${esc(p.name)}</b><span class="n">${act}</span></div></div>`;
    const ptasks=(p.tasks||[]).slice().sort((x,y)=>rankOther(y)-rankOther(x)).slice(0,3);
    if(ptasks.length){
      // ponto na cor do STATUS_META (stColor) — antes um vocabulário próprio (review = amarelo "warn", resto cinza)
      html+=ptasks.map(t=>`<div class="prow2 other" data-proj="${escA(p.path)}"${t.id?` data-id="${escA(t.id)}"`:''} role="button" tabindex="0"><span class="d" style="background:${stColor(t.status)}" title="${escA(stLabel(t.status))}"></span><span class="tt" title="${escA(t.title+' · '+p.name)}">${esc(t.title)}</span></div>`).join('');
    } else {
      html+=`<div class="prow2 other emptyrow" data-proj="${escA(p.path)}" role="button" tabindex="0"><span class="tt dim" style="font-size:var(--fs-xs)">abrir projeto</span></div>`;
    }
  }

  const totalS=liveN+allOthers.reduce((s,p)=>s+p.active+p.review,0);
  const nProj=1+allOthers.length;
  html+=`<div class="rpfoot">${totalS} sess${totalS===1?'ão atual':'ões atuais'} · em ${nProj} projeto${nProj===1?'':'s'}
    <span style="float:right"><button class="sbtn" data-slot="-" title="menos slots">−</button> ${liveN}/${slotMax} <button class="sbtn" data-slot="+" title="mais slots">+</button></span></div>`;
  if(el.__html===html && el.firstChild) return; // nada visível mudou: mantém o DOM (e os handlers) — sem piscar
  el.__html=html; el.innerHTML = html;
  if(window.orqWireOpeners) window.orqWireOpeners(el);
  el.querySelectorAll('.prow2:not(.orqrow)').forEach(r=>r.onclick=()=>{
    if(r.dataset.more){ flowJump({ status:'all', proj:state.repo }); return; }
    if(r.classList.contains('other')){ // demanda de outro projeto: ABRE a tarefa (não é "selecionar projeto")
      if(r.dataset.id) switchToProjectTask(r.dataset.proj, r.dataset.id);
      else switchProject(r.dataset.proj);
      return;
    }
    if(r.dataset.id) openTaskById(r.dataset.id); // abre a tarefa (ou o rascunho, via openOrEdit) numa aba
  });
  // R7: linhas da barra lateral pelo teclado (Tab chega, Enter/Espaço abre) — vale pras linhas de plano (orqrow) também
  el.querySelectorAll('.prow2[tabindex],.prow2.orqrow').forEach(r=>{ if(!r.hasAttribute('tabindex')) r.tabIndex=0;
    r.onkeydown=(e)=>{ if(e.target===r && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); r.click(); } }; });
  el.querySelectorAll("[data-slot]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); setSlotMax(slotMax+(b.dataset.slot==='+'?1:-1)); });
}

// R5-7: tarefa de épico na barra lateral = ◆ pequeno na cor do épico (nome no tooltip) — a linha é estreita demais pro selo inteiro
function sbEpDot(t){
  const id=t&&t.epic&&t.epic.epicId; if(!id) return '';
  const nm=(typeof epNameOf==='function'&&epNameOf(id))||'épico', w=parseInt(t.epic.wave,10)||0;
  return `<span class="sbepdot" style="color:${typeof epColor==='function'?epColor(id):'var(--accent)'}" title="${escA('épico “'+nm+'”'+(w?' · onda '+w:''))}">${IC.epic}</span>`;
}
