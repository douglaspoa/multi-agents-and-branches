// Constellation — 34-orquestrador: terceiro caminho de Nova demanda.
// Você descreve o problema inteiro; um agente orquestrador quebra em fases, cada
// fase vira uma TAREFA REAL (branch + worktree) e o grafo é só uma visão sobre elas.
// Plano fica em .cardume/orchestrations/<id>.json; a coordenação (iniciar uma fase
// quando as anteriores PROVARAM o resultado) roda aqui, no app, a cada refresh.
const ORQ_KINDS={ invest:{label:'Investigar', badge:'IN', color:'#b47ce0', branch:'invest', doc:'INVESTIGATION.md', agent:'Investigador'},
                  design:{label:'Desenhar',   badge:'DS', color:'#5b9df9', branch:'design', doc:'DESIGN.md', agent:'Designer'},
                  build: {label:'Implementar',badge:'IM', color:'#3fd68a', branch:'feat',   doc:null, agent:'Coder'},
                  review:{label:'Revisar',    badge:'CR', color:'#4fc4c9', branch:'review', doc:'REVIEW.md', agent:'Revisor'} };
function orqNewState(){ return { step:'brief', briefing:'', atts:[], plan:null, sel:null, zoom:1, pan:{x:40,y:40}, busy:false, msg:'', list:null, addOpen:false, model:'', chatDraft:'', chatBusy:false, chatAtts:[] }; }
let orq=orqNewState();
window.orqFresh=()=>{ const l=orq.list; orq=orqNewState(); orq.list=l; };
window.TAB_STATE_orq={ get:()=>Object.assign({ _title:(orq.plan&&orq.plan.title)||'' }, { s:orq }), set:(st)=>{ if(st&&st.s){ const list=orq.list; orq=st.s; if(!orq.list) orq.list=list; } } };
let orqDrag=null, orqTickT=null, orqListAt=0;

function orqBadge(k){ return (ORQ_KINDS[k]||ORQ_KINDS.build).badge; }
function orqColor(k){ return (ORQ_KINDS[k]||ORQ_KINDS.build).color; }
function orqTaskOf(ph){ return ph&&ph.taskId ? (state.tasks||[]).find(t=>t.id===ph.taskId) : null; }
function orqNewId(){ return 'orq-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

// ---- estado de cada fase (planejado · esperando · na fila · rodando · pronto · erro) ----
function orqPhaseState(ph){
  const t=orqTaskOf(ph);
  if(!t) return { key:'planned', label:'planejado', color:'rgba(255,255,255,.4)' };
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return { key:'done', label:'pronto', color:'var(--accent)' };
  if(['review','delivered'].includes(t.status)) return orqProved(t) ? { key:'done', label:'pronto', color:'var(--accent)' } : { key:'review', label:'pronto pra revisar', color:'var(--accent)' };
  if(['error','conflict','timeout','aborted'].includes(t.status)) return orqProved(t) ? { key:'done', label:'pronto (sessão caiu no fim)', color:'var(--accent)' } : { key:'error', label:t.status==='conflict'?'conflito':'erro', color:'var(--bad)' };
  if(t.status==='draft') return { key:'waiting', label:'esperando', color:'rgba(255,255,255,.4)' };
  if(t.status==='paused') return { key:'paused', label:'pausada', color:'var(--warn)' };
  if(t.status==='queued'||t.status==='plan-review') return { key:'queued', label:t.status==='queued'?'na fila':'plano em revisão', color:'var(--warn)' };
  return { key:'running', label:'rodando', color:'var(--warn)' };
}
// provas com validade: o requirements.json nasce no FIM do turno, então o cache lido cedo ({list:null})
// precisa ser relido enquanto a fase está viva ou esperando revisão — senão ficava 0/N pra sempre.
const orqProofAt={};
function orqFreshProofs(t){
  if(!t) return;
  const live=['review','delivered','running','thinking','queued','plan-review'].includes(t.status);
  const c=reqProofCache[t.id]; const age=Date.now()-(orqProofAt[t.id]||0);
  if(c===undefined || (live && age>8000 && !orqProofAt['loading:'+t.id])){
    orqProofAt['loading:'+t.id]=1;
    loadReqProofs(t.id).then(()=>{ orqProofAt[t.id]=Date.now(); delete orqProofAt['loading:'+t.id]; if(orqOpen()) orqRender(); }).catch(()=>{ delete orqProofAt['loading:'+t.id]; });
  }
}
// "provou": entregou (review/delivered/done/merged) E, se tem requisitos, todos com prova
function orqProved(t){
  if(!t) return false;
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return true;
  // erro/abortada com TODAS as provas no requirements.json = entregou (a sessão caiu depois de terminar)
  const crashed=['error','aborted','conflict'].includes(t.status)&&!t.busy;
  if(!['review','delivered'].includes(t.status)&&!crashed) return false;
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  if(!reqs.length) return !crashed;
  orqFreshProofs(t);
  const c=reqProofCache[t.id];
  if(c===undefined) return false;
  if(!c.list) return false;
  const m=matchReqProofs(reqs, c.list);
  return m.every(x=>x&&x.status==='done');
}
function orqObjDone(ph){ // [n provados, total]
  const objs=ph.objectives||[]; const t=orqTaskOf(ph);
  if(!t) return [0, objs.length];
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return [objs.length, objs.length];
  const reqs=Array.isArray(t.requirements)?t.requirements:objs; if(reqs.length) orqFreshProofs(t); const c=reqProofCache[t.id];
  if(!c||!c.list) return [0, reqs.length];
  const m=matchReqProofs(reqs, c.list); return [m.filter(x=>x&&x.status==='done').length, reqs.length];
}
function orqOpen(){ const o=$id('orqOverlay'); return o && o.style.display!=='none'; }

// ---- layout: coluna = profundidade da dependência; linha = ordem ----
function orqLayout(plan){
  const ph=plan.phases; const byKey=Object.fromEntries(ph.map(p=>[p.key,p]));
  const depth={}; const d=(p,seen)=>{ if(depth[p.key]!=null) return depth[p.key]; if(seen.has(p.key)) return 0; seen.add(p.key);
    const deps=(p.dependsOn||[]).map(k=>byKey[k]).filter(Boolean); depth[p.key]=deps.length?1+Math.max(...deps.map(x=>d(x,seen))):0; return depth[p.key]; };
  ph.forEach(p=>d(p,new Set()));
  const cols={}; ph.forEach(p=>{ (cols[depth[p.key]]||(cols[depth[p.key]]=[])).push(p); });
  const W=236, H=142, GX=56, GY=26, X0=290, Y0=30; const pos={};
  const maxRows=Math.max(1,...Object.values(cols).map(c=>c.length));
  Object.entries(cols).forEach(([c,list])=>{ const off=(maxRows-list.length)*(H+GY)/2; list.forEach((p,i)=>{ pos[p.key]={ x:X0+(+c)*(W+GX), y:Y0+off+i*(H+GY), w:W, h:H }; }); });
  const totalH=Y0*2+maxRows*(H+GY)-GY;
  pos.__orq={ x:20, y:Math.max(Y0, totalH/2-78), w:212, h:156 };
  pos.__size={ w:X0+(Object.keys(cols).length)*(W+GX)+40, h:totalH+40 };
  return pos;
}
function orqEdge(a,b,cls){ const x1=a.x+a.w, y1=a.y+a.h/2, x2=b.x, y2=b.y+b.h/2; const c=Math.max(30,(x2-x1)/2); return `<path class="${cls}" d="M${x1},${y1} C${x1+c},${y1} ${x2-c},${y2} ${x2},${y2}"/>`; }

// ---- render ----
function orqShow(){ ndInjectFonts&&ndInjectFonts(); $id('orqOverlay').style.display='flex'; if(!orq.list||Date.now()-orqListAt>20000) orqLoadList().then(orqRender); orqRender(); }
async function orqLoadList(){ const before=JSON.stringify((orq.list||[]).map(p=>[p.id,p.status,(p.phases||[]).map(x=>x.taskId)])); try{ orq.list=await invoke('orch_list'); }catch(_){ orq.list=[]; } orqListAt=Date.now(); const after=JSON.stringify((orq.list||[]).map(p=>[p.id,p.status,(p.phases||[]).map(x=>x.taskId)])); if(before!==after){ lastSig=''; } }
// abre o grafo de um plano salvo (sidebar, quadro, chip da tarefa)
async function orqOpenPlan(id, taskId){
  if(!orq.list) await orqLoadList();
  const p=(orq.list||[]).find(x=>x.id===id); if(!p){ alert('plano não encontrado neste projeto.'); return; }
  if(window.openTab){
    // aba que já mostra este plano → volta pra ela; senão, uma aba nova só pra ele
    window.openTab('orq', { reuse:t=>(t.id===activeTab && orq.plan && orq.plan.id===p.id) || (t.state && t.state.s && t.state.s.plan && t.state.s.plan.id===p.id) });
  }
  if(!p.repo) p.repo=state.repo||'';
  if(!orq.plan||orq.plan.id!==p.id){ orq.plan=p; orq.needFit=true; orq.pan={x:20,y:20}; orq.zoom=1; }
  orq.step='plan'; orq.addOpen=false;
  orq.sel=(taskId&&(p.phases.find(x=>x.taskId===taskId)||{}).key)||orq.sel||(p.phases[0]?p.phases[0].key:'__orq');
  if(!window.openTab) orqShow();
  orqRender();
}
window.orqOpenPlan=orqOpenPlan;
function orqProjName(p){ return p&&p.repo?String(p.repo).split('/').filter(Boolean).slice(-1)[0]:''; }
function orqOtherRepo(p){ return !!(p&&p.repo&&state.repo&&p.repo!==state.repo); }
function orqPlansHere(){ return (orq.list||[]).filter(p=>p.status!=='planned'||(p.phases||[]).some(x=>x.taskId)).concat((orq.list||[]).filter(p=>p.status==='planned'&&!(p.phases||[]).some(x=>x.taskId))); }
function orqPlanStats(p){ const ph=p.phases||[]; const st=ph.map(orqPhaseState); return { total:ph.length, done:st.filter(x=>x.key==='done').length, run:st.filter(x=>['running','queued'].includes(x.key)).length, err:st.filter(x=>x.key==='error').length, st }; }
// sidebar: uma linha por plano vivo, acima das tarefas do projeto
function orqRailRows(){
  const list=(orq.list||[]).filter(p=>p.status!=='done'&&!orqOtherRepo(p));
  if(!list.length){ if(!orq.list) orqLoadList(); return ''; }
  return list.slice(0,4).map(p=>{ const s=orqPlanStats(p); const col=p.status==='planned'?'var(--muted)':s.err?'var(--crit)':s.run?'var(--good)':'var(--warn)';
    return `<div class="prow2 orqrow" data-orq="${escA(p.id)}" title="plano do orquestrador — abrir o grafo"><span class="d" style="background:${col}"></span><span class="tt">◉ ${esc(p.title||'plano')}</span><span class="tg mono" style="color:${col}">${p.status==='planned'?'plano':`${s.done}/${s.total}`}</span></div>`; }).join('');
}
// quadro (Execução): cartão por plano com as fases e o progresso
function orqBoardHtml(scope){
  const pf=(typeof projFilter!=='undefined')?projFilter:'all';
  const list=(orq.list||[]).filter(p=>scope==='done'?p.status==='done':p.status!=='done').filter(p=>pf==='all'||!p.repo||p.repo===pf||orqProjName(p)===pf);
  if(!list.length) return '';
  const cards=list.map(p=>{ const s=orqPlanStats(p); const pct=s.total?Math.round(s.done/s.total*100):0;
    const label=p.status==='planned'?'plano proposto · aguardando aprovação':p.status==='done'?'concluído':s.err?`${s.err} fase(s) com erro`:s.run?`${s.run} rodando · ${s.done}/${s.total} entregues`:`esperando · ${s.done}/${s.total} entregues`;
    const col=p.status==='planned'?'var(--muted)':p.status==='done'?'var(--accent)':s.err?'var(--crit)':s.run?'var(--good)':'var(--warn)';
    const chips=(p.phases||[]).map((ph,i)=>`<span class="orqc-ph" style="--c:${orqColor(ph.kind)}" title="${escA(ph.name)} · ${escA(s.st[i].label)}"><i style="background:${s.st[i].color}"></i><b>${orqBadge(ph.kind)}</b>${esc(ph.name)}</span>`).join('');
    return `<div class="orqcard" data-orq="${escA(p.id)}"><div class="orqc-top"><span class="orqc-ring"></span><span class="orqc-title">${esc(p.title||'plano')}</span>${orqProjName(p)?`<span class="orqc-proj mono${orqOtherRepo(p)?' other':''}" title="${escA(p.repo)}">${esc(orqProjName(p))}</span>`:''}<span class="orqc-st mono" style="color:${col}">${esc(label)}</span><button class="btn sm" data-orq="${escA(p.id)}">abrir grafo ↗</button></div>
      ${p.summary?`<div class="orqc-sum">${esc(String(p.summary).slice(0,200))}</div>`:''}
      <div class="orqc-bar"><i style="width:${pct}%"></i></div><div class="orqc-phs">${chips}</div></div>`; }).join('');
  return `<div class="secgrp orqgrp"><div class="sech">◉ Planos do orquestrador <span class="n">${list.length}</span></div>${cards}</div>`;
}
function orqWireOpeners(root){ (root||document).querySelectorAll('[data-orq]').forEach(b=>{ if(b.dataset.orqWired) return; b.dataset.orqWired='1'; b.onclick=(e)=>{ e.stopPropagation(); orqOpenPlan(b.dataset.orq, b.dataset.orqTask||null); }; }); }
window.orqRailRows=orqRailRows; window.orqBoardHtml=orqBoardHtml; window.orqWireOpeners=orqWireOpeners;
function orqSeg(cur){
  return `<div class="orq-seg"><button class="${cur==='chat'?'on':''}" data-orqgo="planner">Conversar</button><button class="${cur==='form'?'on':''}" data-orqgo="form">Formulário</button><button class="on" data-orqgo="">Orquestrador</button></div><span class="orq-segd">um agente lê o problema inteiro e abre uma tarefa por fase</span>`;
}
function orqStatusPill(){
  if(orq.step==='brief') return `<span class="orq-pill"><i></i>nenhum plano ainda</span>`;
  const p=orq.plan; if(!p) return '';
  if(p.status==='planned') return `<span class="orq-pill"><i></i>plano proposto · aguardando você</span>`;
  const run=p.phases.filter(x=>orqPhaseState(x).key==='running').length, done=p.phases.filter(x=>orqPhaseState(x).key==='done').length;
  return `<span class="orq-pill ${done===p.phases.length?'ok':'live'}"><i></i>${done===p.phases.length?'plano concluído':`${run} subagente${run===1?'':'s'} rodando · ${done} pronto${done===1?'':'s'}`}</span>`;
}
function orqRender(){
  const body=$id('orqBody'); if(!body) return;
  if(orq.step==='brief') orqRenderBrief(body); else orqRenderPlan(body);
  body.querySelectorAll('[data-orqgo]').forEach(b=>b.onclick=()=>{ if(b.dataset.orqgo&&window.openTab) window.openTab(b.dataset.orqgo); });
  if(typeof cosmosMount==='function') cosmosMount(body);
}
function orqRenderBrief(body){
  const prev=(orq.list||[]).slice(0,6);
  body.innerHTML=`<div class="orq-top">${orqSeg('orq')}<span style="flex:1"></span>${orqStatusPill()}</div>
  <div class="orq-brief"><div class="orq-briefin">
    <div class="ndeyebrow" style="color:var(--accent)">orquestrador</div>
    <h1 class="ndh1" style="margin-top:10px">Descreva o problema inteiro</h1>
    <p class="ndsub">Não precisa quebrar em tarefas. Um agente orquestrador lê isso, propõe as fases e abre um subagente para cada uma. Você aprova o plano antes de qualquer coisa rodar.</p>
    ${orq.busy?cosmosHtml('o orquestrador está lendo o repositório e montando o plano…'):`
    <textarea class="orq-ta" id="orqTa" placeholder="ex.: o autocomplete de empresas está retornando resultados ruins e ninguém sabe se é ranking, índice ou dado sujo — quero entender, propor a correção e entregar">${esc(orq.briefing)}</textarea>
    <div class="attpend" id="orqPend" style="display:${orq.atts.length?'flex':'none'}"></div>
    <div class="orq-chips"><button class="orq-chip" id="orqAtt">anexar print / arquivo</button><button class="orq-chip" id="orqLastInv">usar a última investigação</button><span style="flex:1"></span><span class="dim mono" style="font-size:11px">IA: ${esc(typeof aiModelName==='function'?aiModelName(orq.model||aiDefaults().model):'padrão')}</span></div>
    ${orq.msg?`<div class="orq-msg">${esc(orq.msg)}</div>`:''}
    <div class="ndeyebrow" style="margin-top:26px">o orquestrador pode</div>
    <div class="orq-can">
      <div><i style="background:#3fd68a"></i>Quebrar em fases com dependência: uma só começa quando a anterior provar o resultado</div>
      <div><i style="background:#4fc4c9"></i>Abrir um subagente por fase, cada um com branch e worktree isoladas</div>
      <div><i style="background:#b47ce0"></i>Rodar em paralelo o que não depende de ninguém</div>
      <div><i style="background:#e8788a"></i>Parar e te perguntar sempre que a decisão for sua</div>
    </div>
    <div class="orq-briefact"><button class="as-btn primary big" id="orqGo" ${orq.briefing.trim().length<12?'disabled':''}>Montar o plano</button><span class="dim" style="font-size:12px">${orq.briefing.trim().length<12?'escreva pelo menos uma frase completa':'o plano aparece como grafo — nada roda antes de você aprovar'}</span></div>`}
    ${prev.length?`<div class="ndeyebrow" style="margin-top:34px">planos anteriores</div><div class="orq-prev">${prev.map(p=>`<button class="orq-prevrow" data-orqopen="${escA(p.id)}"><b>${esc(p.title||'plano')}</b><span class="mono dim">${orqProjName(p)?esc(orqProjName(p))+' · ':''}${(p.phases||[]).length} fases · ${esc(p.status==='planned'?'não aprovado':p.status==='done'?'concluído':'rodando')} · ${esc(typeof agoTx==='function'?agoTx(new Date(p.createdAt).toISOString()):'')}</span></button>`).join('')}</div>`:''}
  </div></div>`;
  const ta=$id('orqTa'); if(ta){ ta.oninput=()=>{ orq.briefing=ta.value; const g=$id('orqGo'); if(g) g.disabled=ta.value.trim().length<12; }; ta.focus(); }
  if(typeof attRenderPend==='function') attRenderPend('orqPend', orq.atts, ()=>orqRender());
  bindClick('orqAtt', async()=>{ const got=await attPick(null); orq.atts.push(...got); orqRender(); });
  bindClick('orqLastInv', ()=>{ const inv=(state.tasks||[]).filter(t=>t.kind==='invest'||/^invest\//.test(t.branch||'')).slice(-1)[0]; if(!inv){ orq.msg='nenhuma investigação encontrada neste projeto.'; orqRender(); return; } orq.briefing=(orq.briefing?orq.briefing+'\n\n':'')+`Partir da investigação "${inv.title}" (tarefa ${inv.id} — leia .cardume/artifacts/${inv.id}/INVESTIGATION.md).`; orqRender(); });
  bindClick('orqGo', orqPlanNow);
  body.querySelectorAll('[data-orqopen]').forEach(b=>b.onclick=()=>{ const p=(orq.list||[]).find(x=>x.id===b.dataset.orqopen); if(p){ if(!p.repo) p.repo=state.repo||''; orq.plan=p; orq.step='plan'; orq.sel=p.phases[0]?p.phases[0].key:null; orq.pan={x:20,y:20}; orq.zoom=1; orq.needFit=true; orqRender(); } });
}
// normaliza a lista de fases vinda da IA (plano novo OU plano ajustado na conversa); `prev` preserva taskId das fases com a mesma key
function orqNormPhases(list, prev){
  const prevBy=Object.fromEntries((prev||[]).map(x=>[x.key,x]));
  const phases=(list||[]).slice(0,8).map((p,i)=>({ key:String(p.key||('n'+(i+1))), name:String(p.name||('Fase '+(i+1))).slice(0,60), kind:ORQ_KINDS[p.kind]?p.kind:'build', agent:String(p.agent||(ORQ_KINDS[p.kind]||ORQ_KINDS.build).agent).slice(0,30),
    objective:String(p.objective||'').trim(), objectives:(Array.isArray(p.objectives)?p.objectives:[]).map(x=>String(x).trim()).filter(Boolean).slice(0,6), autonomy:p.autonomy==='ask'?'ask':'free', dependsOn:(Array.isArray(p.dependsOn)?p.dependsOn:[]).map(String), taskId:(prevBy[String(p.key)]||{}).taskId||null }));
  const keys=new Set(phases.map(p=>p.key)); phases.forEach(p=>{ p.dependsOn=p.dependsOn.filter(k=>keys.has(k)&&k!==p.key); });
  return phases;
}
async function orqPlanNow(){
  const text=orq.briefing.trim(); if(text.length<12) return;
  orq.busy=true; orq.msg=''; orqRender();
  try{
    const d=aiDefaults(); const model=orq.model||d.model||'';
    const raw=await invoke('ai_orchestrate',{ briefing:text+attPromptBlock(orq.atts), model:model||null });
    let obj=null; try{ const m=raw.match(/```json\s*([\s\S]*?)```/i)||raw.match(/(\{[\s\S]*\})/); if(m) obj=JSON.parse(m[1]); }catch(_){}
    if(!obj||!Array.isArray(obj.phases)||!obj.phases.length) throw new Error('o orquestrador não devolveu um plano válido — tente descrever com mais contexto.\n\n'+raw.slice(0,400));
    const phases=orqNormPhases(obj.phases);
    orq.plan={ id:orqNewId(), title:String(obj.title||text.slice(0,60)).slice(0,80), summary:String(obj.summary||''), briefing:text, createdAt:Date.now(), status:'planned', model, engine:d.eng||'claude', phases, repo:state.repo||'' };
    orq.step='plan'; orq.sel=phases[0].key; orq.pan={x:20,y:20}; orq.zoom=1; orq.needFit=true;
    await invoke('orch_save',{ id:orq.plan.id, data:orq.plan, repo:orq.plan.repo||null }).catch(()=>{});
    orqListAt=0;
  }catch(e){ orq.msg='Falhou montar o plano: '+(e&&e.message||e); }
  orq.busy=false; orqRender();
}

function orqRenderPlan(body){
  const p=orq.plan; const pos=orqLayout(p); const byKey=Object.fromEntries(p.phases.map(x=>[x.key,x]));
  const running=p.status!=='planned';
  const edges=p.phases.map(ph=>(ph.dependsOn||[]).map(k=>byKey[k]?orqEdge(pos[k],pos[ph.key],'orq-e dep'):'').join('')).join('')
    + p.phases.map(ph=>{ const st=orqPhaseState(ph).key; const cls='orq-e cmd'+(st==='running'||st==='queued'?' live':'')+(running&&!(ph.dependsOn||[]).length||!running&&!(ph.dependsOn||[]).length?'':' faint'); return orqEdge(pos.__orq,pos[ph.key],cls); }).join('');
  const nodes=p.phases.map(ph=>{ const q=pos[ph.key]; const st=orqPhaseState(ph); const [done,tot]=orqObjDone(ph); const t=orqTaskOf(ph);
    const last=t?orqLastLines(t.id,2):[];
    const deps=(ph.dependsOn||[]).map(k=>byKey[k]).filter(Boolean);
    const idle = st.key==='done' ? `entregou · ${done}/${tot} objetivos provados`
      : st.key==='review' ? `entregou · ${done}/${tot} provados — revise`
      : st.key==='error' ? 'falhou — abra a tarefa'
      : (deps.length&&st.key==='waiting') ? `aguardando ${deps.map(d=>d.key).join(', ')} · ${deps[0].name.toLowerCase()}`
      : t ? (st.key==='waiting'?'pronta pra começar':'iniciando…') : 'aguardando aprovação do plano';
    const sub=last.length?last.map(l=>`<span>${esc(l)}</span>`).join(''):`<span>${esc(idle)}</span>`;
    return `<div class="orq-node ${st.key}${orq.sel===ph.key?' sel':''}" data-orqsel="${escA(ph.key)}" style="left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px;--c:${orqColor(ph.kind)}">
      <div class="orq-nh"><b class="orq-badge">${orqBadge(ph.kind)}</b><span class="orq-nn">${esc(ph.name)}</span><i class="orq-dot" style="background:${st.color}"></i></div>
      <div class="orq-nm mono"><span style="color:${st.color}">${esc(st.label)}</span><span>${done}/${tot} objetivos</span></div>
      <div class="orq-bar"><i style="width:${tot?Math.round(done/tot*100):0}%"></i></div>
      <div class="orq-term mono">${sub}</div>
      ${t?`<button class="orq-open" data-orqtask="${escA(t.id)}">abrir tarefa ↗</button>`:`<button class="orq-open" data-orqsel2="${escA(ph.key)}">ver objetivos</button>`}
    </div>`; }).join('');
  const o=pos.__orq; const par=p.phases.filter(x=>!(x.dependsOn||[]).length).length;
  const orqNode=`<div class="orq-node orq-master${orq.sel==='__orq'?' sel':''}" data-orqsel="__orq" style="left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px">
      <div class="orq-nh"><i class="orq-ring"></i><span class="orq-nn">Orquestrador</span></div><div class="mono" style="font-size:10px;color:var(--accent);margin:-4px 0 6px 24px">${running?'comandando':'propôs o plano'}</div>
      <div class="orq-nd">${esc(p.summary||'')}</div><div class="mono dim" style="font-size:10px;margin-top:8px">${p.phases.length} subagentes · ${par} podem rodar juntos</div></div>`;
  const nObj=p.phases.reduce((a,x)=>a+(x.objectives||[]).length,0);
  const runN=p.phases.filter(x=>orqPhaseState(x).key==='running').length, doneN=p.phases.filter(x=>orqPhaseState(x).key==='done').length;
  const otherRepo=p.repo&&state.repo&&p.repo!==state.repo;
  body.innerHTML=`<div class="orq-top">${orqSeg('orq')}<span style="flex:1"></span>${otherRepo?`<span class="mono" style="font-size:11px;color:var(--warn);margin-right:12px" title="${escA(p.repo)}">plano do projeto ${esc(p.repo.split('/').pop())}</span>`:''}${orqStatusPill()}</div>
  <div class="orq-main">
    <div class="orq-canvaswrap">
      <div class="orq-tools"><button class="as-btn" id="orqAdd">+ subagente</button>
        <span class="orq-leg"><i style="background:var(--warn)"></i>rodando <i style="background:var(--accent)"></i>pronto <i style="background:rgba(255,255,255,.35)"></i>esperando <i class="orq-legcmd"></i>comando</span>
        <span style="flex:1"></span><span class="mono dim" style="font-size:11px">arraste o fundo</span>
        <span class="orq-zoom"><button data-orqz="-">−</button><button data-orqz="fit">ajustado</button><button data-orqz="+">+</button></span></div>
      <div class="orq-canvas" id="orqCanvas"><canvas class="cosmos-c orq-sky"></canvas>
        <div class="orq-world" id="orqWorld" style="transform:translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})"><svg class="orq-svg" width="${pos.__size.w}" height="${pos.__size.h}">${edges}</svg>${orqNode}${nodes}</div></div>
    </div>
    <aside class="orq-insp" id="orqInsp">${orq.addOpen?orqAddHtml():orqInspHtml()}</aside>
  </div>
  <div class="orq-foot"><span class="mono" style="color:${running?'var(--accent)':'var(--warn)'}">${running?`${runN} rodando · ${doneN}/${p.phases.length} entregues`:`${nObj} objetivos em ${p.phases.length} fases · revise antes de soltar`}</span><span style="flex:1"></span>
    <button class="as-btn orq-chatbtn" id="orqChatBtn" title="pergunte sobre o projeto ou peça ajustes no plano">${ic('chat',13)}conversar</button>
    <button class="as-btn" id="orqRedo">${running?'novo plano':'refazer'}</button>
    ${running?`<button class="as-btn" disabled>${doneN===p.phases.length?'plano concluído':'plano rodando'}</button>`:`<button class="as-btn primary big" id="orqApprove" ${orq.busy?'disabled':''}>${orq.busy?'criando as tarefas…':'aprovar plano e rodar'}</button>`}</div>`;
  orqWire(body, pos);
}
// eventos por tarefa via task_events (incremental) — o snapshot só carrega os 1200 últimos do projeto
// inteiro, então uma fase antiga aparecia "sem atividade" mesmo tendo rodado.
const orqEv={}; // taskId → { lastId, lines:[], at }
const ORQ_EV_TYPES=new Set(['bash','edit','write','note','done','error','think','talk','msg','status','read']);
async function orqLoadEvents(taskId, force){
  const c=orqEv[taskId]||(orqEv[taskId]={ lastId:0, lines:[], at:0, loading:false });
  if(c.loading) return; if(!force && Date.now()-c.at<6000) return;
  c.loading=true;
  try{ const rows=(await invoke('task_events',{ taskId, sinceId:c.lastId }))||[];
    for(const e of rows){ if(e.id>c.lastId) c.lastId=e.id; if(!ORQ_EV_TYPES.has(e.type)) continue; c.lines.push((e.type==='bash'?'$ ':e.type==='status'?'· ':'')+String(e.text||'').split('\n')[0].slice(0,90)); }
    if(c.lines.length>40) c.lines=c.lines.slice(-40);
    c.at=Date.now(); if(rows.length && orqOpen()) orqRender();
  }catch(_){ c.at=Date.now(); }
  c.loading=false;
}
function orqLastLines(taskId,n){
  const c=orqEv[taskId];
  if(!c){ orqLoadEvents(taskId, true); const ev=(state.events||[]).filter(e=>e.taskId===taskId&&ORQ_EV_TYPES.has(e.type)).slice(-n); return ev.map(e=>(e.type==='bash'?'$ ':'')+String(e.text||'').split('\n')[0].slice(0,60)); }
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(t&&['running','thinking','queued','plan-review'].includes(t.status)) orqLoadEvents(taskId,false);
  return c.lines.slice(-n);
}
function orqWire(body,pos){
  const canvas=$id('orqCanvas'), world=$id('orqWorld');
  canvas.onmousedown=e=>{ if(e.target.closest('.orq-node')) return; orqDrag={ x:e.clientX, y:e.clientY, px:orq.pan.x, py:orq.pan.y }; canvas.classList.add('drag'); };
  window.onmousemove=e=>{ if(!orqDrag) return; orq.pan.x=orqDrag.px+(e.clientX-orqDrag.x); orq.pan.y=orqDrag.py+(e.clientY-orqDrag.y); world.style.transform=`translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})`; };
  window.onmouseup=()=>{ if(orqDrag){ orqDrag=null; canvas.classList.remove('drag'); } };
  const fit=()=>{ const r=canvas.getBoundingClientRect(); if(!r.width) return; orq.zoom=Math.max(.85,Math.min(1,(r.width-40)/pos.__size.w,(r.height-40)/pos.__size.h)); orq.pan={x:Math.max(16,(r.width-pos.__size.w*orq.zoom)/2), y:Math.max(16,(r.height-pos.__size.h*orq.zoom)/2)}; world.style.transform=`translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})`; };
  if(orq.needFit){ orq.needFit=false; requestAnimationFrame(fit); }
  body.querySelectorAll('[data-orqz]').forEach(b=>b.onclick=()=>{ const z=b.dataset.orqz; if(z==='fit'){ fit(); return; } orq.zoom=Math.max(.4,Math.min(1.6,orq.zoom+(z==='+'?.12:-.12))); world.style.transform=`translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})`; });
  body.querySelectorAll('[data-orqsel]').forEach(n=>n.onclick=e=>{ if(e.target.closest('[data-orqtask]')) return; orq.sel=n.dataset.orqsel; orq.addOpen=false; orqRender(); });
  body.querySelectorAll('[data-orqsel2]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); orq.sel=b.dataset.orqsel2; orq.addOpen=false; orqRender(); });
  body.querySelectorAll('[data-orqtask]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); openWorkspace(b.dataset.orqtask); });
  bindClick('orqAdd', ()=>{ orq.addOpen=!orq.addOpen; orqRender(); });
  bindClick('orqChatBtn', orqChatFocus);
  bindClick('orqRedo', ()=>{ if(orq.plan.status!=='planned' && !confirm('Começar um plano novo? As tarefas já criadas continuam existindo.')) return; if(orq.plan.status==='planned') invoke('orch_delete',{ id:orq.plan.id, repo:orq.plan.repo||null }).catch(()=>{}); orq.plan=null; orq.step='brief'; orqListAt=0; orqRender(); });
  bindClick('orqApprove', orqApprove);
  orqWireInsp(body);
}
// ---- conversa com o orquestrador sobre o projeto/plano (persistida no plano) ----
function orqChatHtml(p){
  const msgs=p.chat||[];
  const locked=p.status!=='planned';
  const thread=msgs.length?msgs.map(m=>`<div class="orq-cm ${m.who}">${m.who==='bot'?mdToHtml(m.text||''):esc(m.text||'')+(m.who==='you'?attRowHtml(m.atts):'')}</div>`).join('')
    :`<div class="orq-cm hint">Pergunte sobre o projeto ("por que a fase 2 depende da 1?", "quais arquivos a fase de build vai mexer?") ${locked?'ou peça sugestões — o plano já está rodando, então as fases não mudam por aqui.':'ou peça ajustes no plano ("junta as fases 2 e 3", "adiciona uma fase de testes de carga") — o grafo muda na hora.'}</div>`;
  return `<div class="orq-chatwrap"><div class="ndeyebrow" style="margin-top:12px">conversar com o orquestrador <span class="dim" style="text-transform:none;letter-spacing:0">· lê o repo de verdade${locked?'':' · pode ajustar o plano'}</span></div>
    <div class="orq-chat" id="orqChat">${thread}${orq.chatBusy?'<div class="orq-cm bot think"><span class="pltyping"><i></i><i></i><i></i></span></div>':''}</div>
    <div class="attrow attpend orq-chatpend" id="orqChatPend" style="display:none"></div>
    <div class="orq-chatin"><button class="as-btn sm orq-attbtn" id="orqChatAtt" title="anexar print / PDF / doc (ou cole com ⌘V)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 3.5L5 8a2 2 0 0 0 2.8 2.8l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 6.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><textarea id="orqChatTa" rows="2" placeholder="pergunte ou peça um ajuste… (⌘V cola print · enter envia)" ${orq.chatBusy?'disabled':''}>${esc(orq.chatDraft||'')}</textarea><button class="as-btn primary sm" id="orqChatSend" ${orq.chatBusy?'disabled':''}>${ic('send',12)}enviar</button></div></div>`;
}
function orqWireChat(body){
  { const d=body.querySelector('.orq-more'); if(d) d.ontoggle=()=>{ orq.moreOpen=d.open; }; }
  const ta=$id('orqChatTa'); if(!ta) return;
  if(typeof attWireComposer==='function') attWireComposer({ input:'orqChatTa', attach:'orqChatAtt', pend:()=>orq.chatAtts, taskId:()=>null, rerender:()=>orqRender() });
  if(typeof attRenderPend==='function') attRenderPend('orqChatPend', orq.chatAtts, ()=>orqRender());
  ta.oninput=()=>{ orq.chatDraft=ta.value; };
  ta.onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); orqChatSend(); } };
  bindClick('orqChatSend', orqChatSend);
  const th=$id('orqChat'); if(th) th.scrollTop=th.scrollHeight;
}
function orqChatFocus(){ orq.sel='__orq'; orq.addOpen=false; orqRender(); const ta=$id('orqChatTa'); if(ta){ ta.focus(); ta.scrollIntoView({block:'nearest'}); } }
async function orqChatSend(){
  const p=orq.plan; if(!p||orq.chatBusy) return;
  let text=(orq.chatDraft||'').trim();
  const atts=(orq.chatAtts||[]).splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e extraia o contexto (spec, print do bug, etc.).';
  if(!text) return;
  p.chat=p.chat||[]; p.chat.push({who:'you', text, atts:attLite(atts)}); orq.chatDraft=''; orq.chatBusy=true; orqRender();
  try{
    const planJson=JSON.stringify({ title:p.title, summary:p.summary, briefing:p.briefing, status:p.status, phases:p.phases.map(x=>({ key:x.key, name:x.name, kind:x.kind, agent:x.agent, objective:x.objective, objectives:x.objectives, autonomy:x.autonomy, dependsOn:x.dependsOn, taskId:x.taskId||undefined })) });
    if(!p.repo) p.repo=state.repo||'';
    const r=await aiCallResumeSafe((pr,sid)=>invoke('ai_orchestrate_chat',{ prompt:pr, sessionId:sid, model:p.model||null, plan:planJson, repo:p.repo||null }), p.chatSid||null, text+attPromptBlock(atts), p.chat.slice(0,-1));
    if(r&&r.recovered) p.chat.push({who:'sys', text:'a sessão anterior foi perdida — continuei com o histórico da conversa.'});
    if(r&&r.sessionId) p.chatSid=r.sessionId;
    let obj=null; try{ const m=(r.text||'').match(/```json\s*([\s\S]*?)```/i)||(r.text||'').match(/(\{[\s\S]*\})/); if(m) obj=JSON.parse(m[1]); }catch(_){}
    const say=obj&&typeof obj.say==='string'?obj.say:(r.text||'(sem resposta)');
    p.chat.push({who:'bot', text:say});
    if(obj&&obj.plan&&Array.isArray(obj.plan.phases)&&obj.plan.phases.length){
      if(p.status==='planned'){
        const before=p.phases.length;
        p.phases=orqNormPhases(obj.plan.phases, p.phases);
        if(obj.plan.title) p.title=String(obj.plan.title).slice(0,80);
        if(obj.plan.summary) p.summary=String(obj.plan.summary);
        if(!p.phases.some(x=>x.key===orq.sel)&&orq.sel!=='__orq') orq.sel='__orq';
        orq.needFit=true;
        p.chat.push({who:'sys', text:`plano atualizado — ${p.phases.length} fase(s)${p.phases.length!==before?` (antes ${before})`:''}: ${p.phases.map(x=>x.name).join(' · ')}`});
      } else {
        p.chat.push({who:'sys', text:'o plano já está rodando — a sugestão acima não foi aplicada (use "+ subagente" pra acrescentar uma fase).'});
      }
    }
  }catch(e){ p.chat.push({who:'sys', text:'⚠ '+(e&&e.message||e)}); }
  orq.chatBusy=false; orqSave(); orqRender();
  const ta=$id('orqChatTa'); if(ta) ta.focus();
}
function orqInspHtml(){
  const p=orq.plan; if(orq.sel==='__orq'||!orq.sel) return `<div class="orq-ih"><span class="orq-badge" style="--c:var(--accent)">◉</span><div><b>Orquestrador</b><div class="mono dim" style="font-size:10.5px">${p.status==='planned'?'propôs o plano':'comandando'} · ${esc(typeof aiModelName==='function'?aiModelName(p.model):'')}</div></div></div>
    <p class="orq-p">${esc(p.summary||'')}</p>
    <details class="orq-more"${orq.moreOpen?' open':''}><summary>regras · briefing</summary>
      <div class="ndeyebrow">regras</div><ul class="orq-rules"><li>Nunca mexe em código — planeja, abre tarefa, coordena e para pra perguntar.</li><li>Nada roda sem a sua aprovação do plano.</li><li>Uma fase só começa quando as anteriores PROVAREM o resultado (requisitos com evidência).</li><li>Fases sem dependência rodam em paralelo, uma branch por fase.</li></ul>
      <div class="ndeyebrow" style="margin-top:14px">briefing</div><p class="orq-p dim" style="white-space:pre-wrap">${esc(p.briefing||'')}</p>
    </details>
    ${orqChatHtml(p)}`;
  const ph=p.phases.find(x=>x.key===orq.sel); if(!ph) return '';
  const t=orqTaskOf(ph); const st=orqPhaseState(ph); const locked=!!t||p.status!=='planned'; const c=t?reqProofCache[t.id]:null; const m=(t&&c&&c.list)?matchReqProofs(Array.isArray(t.requirements)?t.requirements:ph.objectives, c.list):null;
  const objs=(ph.objectives||[]).map((o,i)=>{ const ok=m&&m[i]&&m[i].status==='done'; const ev=(m&&m[i]&&Array.isArray(m[i].evidence)&&m[i].evidence[0])||''; return `<div class="orq-obj${ok?' ok':''}"><span class="orq-chk" title="${ok?'provado':'pendente'}">${ok?'✓':(i+1)}</span><div class="orq-objbody">${locked?`<span class="orq-objt">${esc(o)}</span>${ev?`<span class="orq-objev mono">${esc(String(ev).split('/').pop())}</span>`:''}`:`<textarea class="orq-objin" data-orqobj="${i}" rows="2">${esc(o)}</textarea>`}</div>${locked?'':`<button class="orq-x" data-orqrm="${i}" title="remover">×</button>`}</div>`; }).join('');
  const others=p.phases.filter(x=>x.key!==ph.key);
  const deps=locked?`<div class="orq-p dim">${(ph.dependsOn||[]).length?(ph.dependsOn||[]).map(k=>{ const d=p.phases.find(x=>x.key===k); return d?`<span class="orq-depchip" style="--c:${orqColor(d.kind)}">${orqBadge(d.kind)} ${esc(d.name)}</span>`:''; }).join(''):'roda em paralelo, sem depender de ninguém'}</div>`
    :`<div class="orq-deps">${others.map(o=>`<label class="orq-dep${(ph.dependsOn||[]).includes(o.key)?' on':''}"><input type="checkbox" data-orqdep="${escA(o.key)}" ${(ph.dependsOn||[]).includes(o.key)?'checked':''}><span class="orq-badge" style="--c:${orqColor(o.kind)}">${orqBadge(o.kind)}</span>${esc(o.name)}</label>`).join('')||'<span class="dim">só esta fase no plano</span>'}</div>`;
  const waiting=p.phases.filter(x=>(x.dependsOn||[]).includes(ph.key));
  const term=t?orqLastLines(t.id,8):[];
  return `<div class="orq-ih"><span class="orq-badge" style="--c:${orqColor(ph.kind)}">${orqBadge(ph.kind)}</span><div style="min-width:0;flex:1"><b>${locked?esc(ph.name):`<input class="orq-namein" id="orqName" value="${escA(ph.name)}">`}</b><div class="orq-meta mono"><span style="color:${st.color}">${esc(st.label)}</span><span class="dim">· ${esc(ph.agent)}</span></div></div>${t?`<button class="as-btn sm" data-orqtask="${escA(t.id)}">abrir tarefa ↗</button>`:''}</div>
    ${locked&&t&&t.branch?`<div class="orq-branch mono" title="${escA(t.branch)}">${esc(t.branch)}</div>`:''}
    ${locked?`<p class="orq-p">${esc(ph.objective)}</p>`:`<textarea class="orq-objta" id="orqObjective" placeholder="o que essa fase entrega">${esc(ph.objective)}</textarea>
    <div class="orq-kindrow">${Object.entries(ORQ_KINDS).map(([k,v])=>`<button class="orq-kind${ph.kind===k?' on':''}" data-orqkind="${k}" style="--c:${v.color}">${v.badge} ${v.label}</button>`).join('')}</div>`}
    <div class="ndeyebrow" style="margin-top:14px">objetivos <span class="dim" style="text-transform:none;letter-spacing:0">${locked?'· provados com evidência pelo subagente':'· edite, marque ou adicione'}</span></div>
    <div class="orq-objs">${objs||'<span class="dim">sem objetivos ainda</span>'}</div>
    ${locked?'':`<div class="orq-objadd"><input class="orq-objin" id="orqNewObj" placeholder="adicionar objetivo…"><button class="as-btn primary sm" id="orqAddObj">+</button></div>`}
    <div class="ndeyebrow" style="margin-top:14px">autonomia</div>
    <div class="orq-auto"><button class="${ph.autonomy==='ask'?'on':''}" data-orqauto="ask" ${locked?'disabled':''}>pede aprovação</button><button class="${ph.autonomy!=='ask'?'on':''}" data-orqauto="free" ${locked?'disabled':''}>segue livre</button></div>
    <div class="ndeyebrow" style="margin-top:14px">depende de</div>${deps}
    ${waiting.length?`<div class="ndeyebrow" style="margin-top:14px">esperam por ela</div><div class="orq-p dim">${waiting.map(w=>`<span class="orq-depchip" style="--c:${orqColor(w.kind)}">${orqBadge(w.kind)} ${esc(w.name)}</span>`).join('')}</div>`:''}
    <div class="ndeyebrow" style="margin-top:14px">terminal</div>
    <div class="orq-termbox mono">${term.length?term.map(l=>`<div>${esc(l)}</div>`).join(''):`<div class="dim">${locked?'sem atividade ainda':'começa depois de aprovar o plano'}</div>`}</div>
    ${locked?'':`<button class="orq-rmphase" id="orqRmPhase">remover esta fase do plano</button>`}`;
}
function orqAddHtml(){
  const p=orq.plan;
  return `<div class="orq-ih"><span class="orq-badge" style="--c:var(--accent)">+</span><div><b>Novo subagente</b><div class="mono dim" style="font-size:10.5px">entra no grafo já na coluna certa</div></div></div>
    <div class="ndeyebrow">nome da fase</div><input class="orq-namein" id="orqAddName" placeholder="ex.: Escrever testes de carga">
    <div class="ndeyebrow" style="margin-top:12px">o que ela entrega</div><textarea class="orq-objta" id="orqAddObj" placeholder="1-2 frases"></textarea>
    <div class="ndeyebrow" style="margin-top:12px">tipo / agente</div><div class="orq-kindrow" id="orqAddKinds">${Object.entries(ORQ_KINDS).map(([k,v])=>`<button class="orq-kind${k==='build'?' on':''}" data-k="${k}" style="--c:${v.color}">${v.badge} ${v.label}</button>`).join('')}</div>
    <div class="ndeyebrow" style="margin-top:12px">quando roda</div>
    <div class="orq-auto"><button class="on" data-orqwhen="par">em paralelo</button><button data-orqwhen="after">depois de…</button></div>
    <div class="orq-deps" id="orqAddDeps" style="display:none">${p.phases.map(o=>`<label class="orq-dep"><input type="checkbox" value="${escA(o.key)}"><span class="orq-badge" style="--c:${orqColor(o.kind)}">${orqBadge(o.kind)}</span>${esc(o.name)}</label>`).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:18px"><button class="as-btn" id="orqAddCancel">cancelar</button><button class="as-btn primary" id="orqAddOk">adicionar ao plano</button></div>`;
}
function orqSave(){ if(orq.plan){ if(!orq.plan.repo) orq.plan.repo=state.repo||''; invoke('orch_save',{ id:orq.plan.id, data:orq.plan, repo:orq.plan.repo||null }).catch(()=>{}); } }
function orqWireInsp(body){
  const p=orq.plan; const ph=p.phases.find(x=>x.key===orq.sel);
  body.querySelectorAll('#orqInsp [data-orqtask]').forEach(b=>b.onclick=()=>openWorkspace(b.dataset.orqtask));
  if(orq.addOpen){
    let kind='build', when='par';
    body.querySelectorAll('#orqAddKinds [data-k]').forEach(b=>b.onclick=()=>{ kind=b.dataset.k; body.querySelectorAll('#orqAddKinds [data-k]').forEach(x=>x.classList.toggle('on',x===b)); });
    body.querySelectorAll('[data-orqwhen]').forEach(b=>b.onclick=()=>{ when=b.dataset.orqwhen; body.querySelectorAll('[data-orqwhen]').forEach(x=>x.classList.toggle('on',x===b)); $id('orqAddDeps').style.display=when==='after'?'flex':'none'; });
    bindClick('orqAddCancel', ()=>{ orq.addOpen=false; orqRender(); });
    bindClick('orqAddOk', ()=>{ const name=($id('orqAddName').value||'').trim(); if(!name){ $id('orqAddName').focus(); return; }
      const deps=when==='after'?[...body.querySelectorAll('#orqAddDeps input:checked')].map(i=>i.value):[];
      let n=p.phases.length+1, key='n'+n; while(p.phases.some(x=>x.key===key)) key='n'+(++n);
      const ph={ key, name:name.slice(0,60), kind, agent:ORQ_KINDS[kind].agent, objective:($id('orqAddObj').value||'').trim(), objectives:[], autonomy:'free', dependsOn:deps, taskId:null };
      p.phases.push(ph);
      orq.addOpen=false; orq.sel=key; orqSave(); orqRender();
      if(p.status!=='planned'){ // plano já aprovado: a fase nova vira tarefa agora (rascunho se depende de algo ainda não provado)
        (async()=>{ try{ const created={}; p.phases.forEach(x=>{ if(x.taskId) created[x.key]=x.taskId; }); await orqCreatePhaseTask(p, ph, created); if(p.status==='done') p.status='running'; orqSave(); lastSig=''; orqRender(); }
          catch(e){ alert('Fase adicionada ao plano, mas não consegui criar a tarefa:\n'+(e&&e.message||e)); } })();
      } });
    return;
  }
  if(!ph){ orqWireChat(body); return; }
  const nm=$id('orqName'); if(nm) nm.onchange=()=>{ ph.name=nm.value.trim().slice(0,60)||ph.name; orqSave(); orqRender(); };
  const ob=$id('orqObjective'); if(ob) ob.onchange=()=>{ ph.objective=ob.value.trim(); orqSave(); };
  body.querySelectorAll('[data-orqkind]').forEach(b=>b.onclick=()=>{ ph.kind=b.dataset.orqkind; ph.agent=ORQ_KINDS[ph.kind].agent; orqSave(); orqRender(); });
  body.querySelectorAll('[data-orqobj]').forEach(i=>i.onchange=()=>{ ph.objectives[+i.dataset.orqobj]=i.value.trim(); ph.objectives=ph.objectives.filter(Boolean); orqSave(); orqRender(); });
  body.querySelectorAll('[data-orqrm]').forEach(b=>b.onclick=()=>{ ph.objectives.splice(+b.dataset.orqrm,1); orqSave(); orqRender(); });
  const add=()=>{ const i=$id('orqNewObj'); const v=(i.value||'').trim(); if(!v) return; ph.objectives.push(v); orqSave(); orqRender(); const j=$id('orqNewObj'); if(j) j.focus(); };
  bindClick('orqAddObj', add); { const i=$id('orqNewObj'); if(i) i.onkeydown=e=>{ if(e.key==='Enter') add(); }; }
  body.querySelectorAll('[data-orqauto]').forEach(b=>b.onclick=()=>{ if(b.disabled) return; ph.autonomy=b.dataset.orqauto; orqSave(); orqRender(); });
  body.querySelectorAll('[data-orqdep]').forEach(i=>i.onchange=()=>{ const k=i.dataset.orqdep; ph.dependsOn=(ph.dependsOn||[]).filter(x=>x!==k); if(i.checked){ if(orqWouldCycle(ph.key,k)){ alert('isso criaria um ciclo de dependência.'); i.checked=false; return; } ph.dependsOn.push(k); } orqSave(); orqRender(); });
  bindClick('orqRmPhase', ()=>{ if(!confirm('Remover a fase "'+ph.name+'" do plano?')) return; p.phases=p.phases.filter(x=>x!==ph); p.phases.forEach(x=>{ x.dependsOn=(x.dependsOn||[]).filter(k=>k!==ph.key); }); orq.sel=p.phases[0]?p.phases[0].key:'__orq'; orqSave(); orqRender(); });
}
function orqWouldCycle(from, to){ // adicionar from→to fecha ciclo se to alcança from
  const byKey=Object.fromEntries(orq.plan.phases.map(x=>[x.key,x])); const seen=new Set(); const st=[to];
  while(st.length){ const k=st.pop(); if(k===from) return true; if(seen.has(k)) continue; seen.add(k); ((byKey[k]||{}).dependsOn||[]).forEach(d=>st.push(d)); }
  return false;
}

// ---- aprovar: cria as tarefas em ordem topológica; raízes começam, dependentes esperam a prova ----
function orqTopo(phases){
  const byKey=Object.fromEntries(phases.map(x=>[x.key,x])); const out=[], seen=new Set();
  const visit=(p,stack)=>{ if(seen.has(p.key)||stack.has(p.key)) return; stack.add(p.key); (p.dependsOn||[]).map(k=>byKey[k]).filter(Boolean).forEach(d=>visit(d,stack)); stack.delete(p.key); seen.add(p.key); out.push(p); };
  phases.forEach(p=>visit(p,new Set())); return out;
}
function orqAgentIdFor(ph){
  const ags=(state.config&&state.config.agents)||[]; const want=String(ph.agent||'').toLowerCase();
  const byName=ags.find(a=>String(a.name||'').toLowerCase()===want||String(a.id||'').toLowerCase()===want); if(byName) return byName.id;
  const role={ invest:'investigator', design:'designer', build:'builder', review:'reviewer' }[ph.kind];
  const byRole=ags.find(a=>String(a.role||'').toLowerCase()===role); return byRole?byRole.id:null;
}
// cria a TAREFA REAL de uma fase: raízes começam na hora; dependentes nascem em rascunho e o
// coordenador (orqTick) inicia quando as anteriores provarem. Build/review parte da branch da fase anterior.
async function orqCreatePhaseTask(p, ph, created){
  const byKey=Object.fromEntries(p.phases.map(x=>[x.key,x]));
  const kd=ORQ_KINDS[ph.kind]||ORQ_KINDS.build; const deps=(ph.dependsOn||[]).map(k=>byKey[k]).filter(Boolean);
  const depTxt=deps.length?`\n\nDEPENDE DE: ${deps.map(d=>`"${d.name}" (tarefa ${created[d.key]||d.taskId||d.key})`).join(', ')}. ANTES de começar, leia o que essas fases entregaram: .cardume/artifacts/<id-da-tarefa>/ (INVESTIGATION.md, DESIGN.md, REVIEW.md, requirements.json, provas) e os commits da branch delas. Sua worktree já parte da branch da fase anterior quando há código.`:'';
  const ctx=`\n\n[PLANO DO ORQUESTRADOR "${p.title}" — fase ${ph.key} de ${p.phases.length}: ${ph.name} (${kd.label})]\nProblema original: ${(p.briefing||'').slice(0,1500)}\nResumo do plano: ${p.summary||''}${depTxt}\nFases irmãs rodam em paralelo em branches próprias — NÃO toque em arquivos fora do escopo desta fase.`;
  const depTasks=deps.map(d=>({ d, t:(state.tasks||[]).find(t=>t.id===(created[d.key]||d.taskId)) })).filter(x=>x.t);
  const buildDep=depTasks.filter(x=>['build','review'].includes(x.d.kind)).map(x=>x.t).slice(-1)[0];
  // começa já se não depende de ninguém OU se todas as dependências já provaram (plano em andamento)
  const startNow=deps.length===0 || (p.status!=='planned' && deps.every(d=>orqProved((state.tasks||[]).find(t=>t.id===(created[d.key]||d.taskId)))));
  const payload={ start:startNow, title:ph.name, workflow:null, agents:orqAgentIdFor(ph), engine:p.engine||'claude', model:p.model||null, approval:ph.autonomy==='ask'?'ask':'auto',
    owns:null, off:null, objective:(ph.objective||ph.name)+ctx, deliverables:[], requirements:(ph.objectives||[]).slice(), doc:kd.doc,
    proof:ph.kind==='build'||ph.kind==='review', tests:ph.kind==='build', planApproval:'auto', refs:[], branchType:kd.branch, issue:null,
    autoPr:ph.kind==='build'?'ask':'no', prBase:null, base:buildDep&&buildDep.branch?buildDep.branch:null };
  const id=await invoke('new_task', payload);
  created[ph.key]=id; ph.taskId=id; ph.startedAt=startNow?Date.now():null;
  await refresh();
  const depIds=deps.map(d=>created[d.key]||d.taskId).filter(Boolean);
  await invoke('patch_task_spec',{ taskId:id, patch:{ orchestration:{ id:p.id, title:p.title, phase:ph.key, name:ph.name }, dependsOn:depIds, dependents:[] }, base:null }).catch(e=>console.error('patch_task_spec',e));
  return id;
}
async function orqApprove(){
  const p=orq.plan; if(!p||orq.busy) return;
  // as tarefas nascem no projeto ATIVO — se o plano é de outro repo, trocar antes (senão as fases iriam pro lugar errado)
  if(p.repo && state.repo && p.repo!==state.repo){ alert('Este plano é do projeto '+p.repo.split('/').pop()+' — o projeto ativo agora é '+state.repo.split('/').pop()+'.\n\nTroque pro projeto do plano na barra lateral antes de aprovar, senão as tarefas seriam criadas no repo errado.'); return; }
  const bad=p.phases.filter(x=>!(x.objectives||[]).length);
  if(bad.length && !confirm(`${bad.length} fase(s) sem objetivos verificáveis (${bad.map(x=>x.name).join(', ')}). Criar mesmo assim? Sem objetivos, a fase seguinte começa assim que esta entregar.`)) return;
  orq.busy=true; orqRender();
  const order=orqTopo(p.phases); const created={}; p.phases.forEach(x=>{ if(x.taskId) created[x.key]=x.taskId; });
  try{
    for(const ph of order){ if(ph.taskId) continue; await orqCreatePhaseTask(p, ph, created); }
    // segunda passada: grava no spec de cada tarefa quem a criou e de quem depende
    for(const ph of p.phases){ const depIds=(ph.dependsOn||[]).map(k=>created[k]).filter(Boolean); const waitIds=p.phases.filter(x=>(x.dependsOn||[]).includes(ph.key)).map(x=>created[x.key]).filter(Boolean);
      await invoke('patch_task_spec',{ taskId:ph.taskId, patch:{ orchestration:{ id:p.id, title:p.title, phase:ph.key, name:ph.name }, dependsOn:depIds, dependents:waitIds }, base:null }).catch(e=>console.error('patch_task_spec',e)); }
    p.status='running'; p.approvedAt=Date.now(); orqSave(); orqListAt=0;
    lastSig=''; await refresh();
  }catch(e){ alert('Falha ao criar as tarefas do plano:\n'+(e&&e.message||e)); p.status=Object.values(created).length?'running':'planned'; orqSave(); }
  orq.busy=false; orqRender();
}

// ---- coordenação: inicia fases cujas dependências PROVARAM o resultado; fecha o plano quando tudo entregou ----
async function orqTick(){
  if(!state.repo) return;
  if(!orq.list||Date.now()-orqListAt>30000) await orqLoadList();
  for(const p of (orq.list||[])){
    if(p.status!=='running'||orqOtherRepo(p)) continue;
    const live=(orq.plan&&orq.plan.id===p.id)?orq.plan:p; let changed=false;
    const byKey=Object.fromEntries(live.phases.map(x=>[x.key,x]));
    for(const ph of live.phases){
      const t=orqTaskOf(ph); if(!t||t.status!=='draft'||ph.startedAt) continue;
      const deps=(ph.dependsOn||[]).map(k=>byKey[k]).filter(Boolean);
      for(const d of deps){ const dt=orqTaskOf(d); if(dt && ['review','delivered'].includes(dt.status)){ try{ await loadReqProofs(dt.id); orqProofAt[dt.id]=Date.now(); }catch(_){ } } }
      if(!deps.every(d=>orqProved(orqTaskOf(d)))) continue;
      try{ await invoke('orch_sync_base',{ taskId:t.id }).catch(()=>{}); await invoke('start_task',{ taskId:t.id }); ph.startedAt=Date.now(); changed=true; }
      catch(e){ console.error('orquestrador: start', ph.key, e); }
    }
    if(live.phases.every(ph=>orqPhaseState(ph).key==='done')){ live.status='done'; live.doneAt=Date.now(); changed=true; }
    if(changed){ invoke('orch_save',{ id:live.id, data:live, repo:live.repo||null }).catch(()=>{}); if(live!==p) Object.assign(p, live); lastSig=''; }
  }
  if(orqOpen()&&orq.step==='plan'&&orq.plan&&orq.plan.status!=='planned'&&!orqDrag&&!document.activeElement.closest?.('#orqInsp input, #orqInsp textarea')) orqRender();
}
orqTickT=setInterval(()=>{ orqTick().catch(e=>console.error('orqTick',e)); }, 7000);

// chips no cabeçalho da tarefa: quem a criou (orquestrador) e de quem depende
function orqTaskChips(t){
  const el=$id('fwOrqChips'); if(!el) return;
  if(!t||!t.orchestration){ el.innerHTML=''; el.style.display='none'; return; }
  const o=t.orchestration; const deps=(t.dependsOn||[]).map(id=>(state.tasks||[]).find(x=>x.id===id)).filter(Boolean);
  const waits=(state.tasks||[]).filter(x=>(x.dependsOn||[]).includes(t.id));
  el.style.display='flex';
  el.innerHTML=`<button class="btn sm orq-chipbtn" data-orqgraph="${escA(o.id)}" title="ver o grafo do plano">◉ ${esc(o.title||'orquestrador')} · ${esc(o.phase||'')}</button>`
    +(deps.length?`<span class="mono dim" style="font-size:10.5px">depende de</span>${deps.map(d=>`<button class="btn sm orq-chipbtn" data-orqt="${escA(d.id)}" title="${escA(d.title)}">${esc(d.title.slice(0,22))} ${orqProved(d)?'✓':'…'}</button>`).join('')}`:'')
    +(waits.length?`<span class="mono dim" style="font-size:10.5px">esperam por ela</span>${waits.map(d=>`<button class="btn sm orq-chipbtn" data-orqt="${escA(d.id)}" title="${escA(d.title)}">${esc(d.title.slice(0,22))}</button>`).join('')}`:'');
  el.querySelectorAll('[data-orqt]').forEach(b=>b.onclick=()=>openWorkspace(b.dataset.orqt));
  el.querySelectorAll('[data-orqgraph]').forEach(b=>b.onclick=async()=>{ if(!orq.list) await orqLoadList(); const p=(orq.list||[]).find(x=>x.id===b.dataset.orqgraph); if(p){ orq.plan=p; orq.step='plan'; orq.sel=(p.phases.find(x=>x.taskId===t.id)||{}).key||'__orq'; } if(window.openTab) window.openTab('orq'); });
}
window.openOrq=orqShow; window.orqTaskChips=orqTaskChips;
bindClick('orqClose', ()=>{ $id('orqOverlay').style.display='none'; if(window.closeTabOfKind) window.closeTabOfKind('orq'); });
