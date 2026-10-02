// Starfork — 34-orquestrador: terceiro caminho de Nova demanda.
// Você descreve o problema inteiro; um agente orquestrador quebra em fases, cada
// fase vira uma TAREFA REAL (branch + worktree) e o grafo é só uma visão sobre elas.
// Plano fica em .cardume/orchestrations/<id>.json; a coordenação (iniciar uma fase
// quando as anteriores PROVARAM o resultado) roda aqui, no app, a cada refresh.
const ORQ_KINDS={ invest:{label:'Investigar', badge:'IN', color:'#b47ce0', branch:'invest', doc:'INVESTIGATION.md', agent:'Investigador'},
                  design:{label:'Desenhar',   badge:'DS', color:'var(--info)', branch:'design', doc:'DESIGN.md', agent:'Designer'},
                  build: {label:'Implementar',badge:'IM', color:'#3fd68a', branch:'feat',   doc:null, agent:'Coder'},
                  review:{label:'Revisar',    badge:'CR', color:'#4fc4c9', branch:'review', doc:'REVIEW.md', agent:'Revisor'} };
function orqNewState(){ return { step:'brief', briefing:'', atts:[], plan:null, sel:null, zoom:1, pan:{x:40,y:40}, busy:false, msg:'', list:null, addOpen:false, model:'', chatDraft:'', chatBusy:false, chatAtts:[] }; }
let orq=orqNewState();
window.orqFresh=()=>{ const l=orq.list; orq=orqNewState(); orq.list=l; };
window.TAB_STATE_orq={ get:()=>Object.assign({ _title:(orq.plan&&orq.plan.title)||'' }, { s:orq }), set:(st)=>{ if(st&&st.s){ const list=orq.list; orq=st.s; if(!orq.list) orq.list=list;
  if(orq.busy && orq.planReq && !orqPlanReqs.has(orq.planReq)){ orq.busy=false; orq.planStopping=false; } } } }; // "montando" de um pedido que já acabou (ou de antes de reabrir o app) não prende a aba
let orqDrag=null, orqTickT=null, orqListAt=0;

// o papel da fase por extenso (antes: siglas IN/DS/IM/CR que ninguém decifrava)
function orqBadge(k){ return (ORQ_KINDS[k]||ORQ_KINDS.build).label; }
function orqColor(k){ return (ORQ_KINDS[k]||ORQ_KINDS.build).color; }
function orqTaskOf(ph){ return ph&&ph.taskId ? (state.tasks||[]).find(t=>t.id===ph.taskId) : null; }
function orqNewId(){ return 'orq-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

// ---- estado de cada fase (planejado · esperando · na fila · rodando · pronto · erro) ----
// Um estado = uma cor = uma ação. Rodando (amarelo) · perguntou, responda (rosa) · entregou,
// revise (azul) · pronto (verde) · erro (vermelho) · esperando (cinza).
// cores do grafo do orquestrador: tokens do tema (aqui "rodando" é âmbar de propósito — fase em andamento)
// R5-4: mesmas cores de status do resto do app (rodando = --st-run verde; revisão = --st-review; erro = --st-err)
const ORQ_ST={ running:'var(--st-run)', asking:'var(--st-ask)', review:'var(--st-review)', done:'var(--good)', error:'var(--st-err)', waiting:'var(--text-3)' };
function orqPhaseState(ph){
  const t=orqTaskOf(ph);
  if(!t) return { key:'planned', label:'planejado', color:ORQ_ST.waiting };
  const asks=(typeof pendingOf==='function')?pendingOf(t.id):[];
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return { key:'done', label:'pronto', color:ORQ_ST.done };
  if(['review','delivered'].includes(t.status)) return orqProved(t) ? { key:'done', label:'pronto · provado', color:ORQ_ST.done } : { key:'review', label:'entregou · revise', color:ORQ_ST.review };
  if(['error','conflict','timeout','aborted'].includes(t.status)) return orqProved(t) ? { key:'done', label:'pronto (sessão caiu no fim)', color:ORQ_ST.done } : { key:'error', label:t.status==='conflict'?'conflito':'erro', color:ORQ_ST.error };
  // perguntou ao humano e está parada esperando você — com todas as provas, as próximas fases
  // já foram liberadas (orqProved), mas ELA continua precisando da sua resposta
  if(asks.length) return { key:'asking', label:orqProved(t)?'terminou · confirme':'perguntou · responda', color:ORQ_ST.asking, ask:asks[0] };
  if(['thinking','running','queued'].includes(t.status) && orqProved(t)) return { key:'review', label:'entregou · parada', color:ORQ_ST.review };
  if(t.status==='draft') return { key:'waiting', label:'esperando', color:ORQ_ST.waiting };
  if(t.status==='paused') return { key:'paused', label:'pausada', color:ORQ_ST.running };
  if(t.status==='queued'||t.status==='plan-review') return { key:'queued', label:t.status==='queued'?'na fila':'plano em revisão', color:ORQ_ST.running };
  return { key:'running', label:'rodando', color:ORQ_ST.running };
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
  // viva mas PARADA: esperando resposta do humano (a fase 'ask' pergunta "concluí, confirmo?" e fica
  // em thinking pra sempre) ou sem evento há 3 min — com todas as provas, conta como entrega
  // sem evento no snapshot (só os últimos do projeto vêm) = parada há muito tempo, não "acabou de começar"
  const idleMs=(()=>{ const e=(typeof lastEventOf==='function')?lastEventOf(t.id):null; return e?Date.now()-new Date(e.ts).getTime():Infinity; })();
  // processo do agente MORTO com status vivo (thinking zumbi depois de reiniciar o app) também é parada
  const parked=['thinking','running','queued'].includes(t.status) && ((typeof pendingOf==='function'&&pendingOf(t.id).length>0) || !t.busy || idleMs>180000);
  if(!['review','delivered'].includes(t.status)&&!crashed&&!parked) return false;
  // liberada à mão pelo humano no grafo ("liberar as próximas fases")
  if(orqReleased(t)) return true;
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  if(!reqs.length) return !crashed&&!parked;
  orqFreshProofs(t);
  const c=reqProofCache[t.id];
  if(c===undefined) return false;
  if(!c.list) return false;
  const m=matchReqProofs(reqs, c.list);
  return m.every(x=>x&&orqReqSettled(x));
}
// requisito RESOLVIDO = provado, ou adiado/dispensado por DECISÃO DO HUMANO (o agente marca blocked/deferred
// com a nota da decisão) — isso não pode travar o plano pra sempre: quem decidiu adiar foi você.
function orqReqSettled(x){
  if(!x) return false;
  if(x.status==='done'||x.status==='deferred'||x.status==='waived') return true;
  return x.status==='blocked' && /deferid|adiad|dispensad|fora de escopo|decis[aã]o (de produto|do humano|do usu[aá]rio)|via ask_human/i.test(String(x.note||''));
}
function orqPhaseOfTask(t){ for(const p of [orq.plan, ...(orq.list||[])]){ if(!p) continue; const ph=(p.phases||[]).find(x=>x.taskId===t.id); if(ph) return { p, ph }; } return null; }
function orqReleased(t){ const f=orqPhaseOfTask(t); return !!(f&&f.ph.released); }
function orqObjDone(ph){ // [n provados, total]
  const objs=ph.objectives||[]; const t=orqTaskOf(ph);
  if(!t) return [0, objs.length];
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return [objs.length, objs.length];
  const reqs=Array.isArray(t.requirements)?t.requirements:objs; if(reqs.length) orqFreshProofs(t); const c=reqProofCache[t.id];
  if(!c||!c.list) return [0, reqs.length];
  const m=matchReqProofs(reqs, c.list); return [m.filter(x=>x&&orqReqSettled(x)).length, reqs.length]; // adiado por decisão sua conta como resolvido
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
function orqShow(){ ndInjectFonts&&ndInjectFonts(); { const c=window.ndTakeCarryAll?window.ndTakeCarryAll():{}; if(c.text && orq.step==='brief' && !orq.briefing.trim()) orq.briefing=[c.title&&c.title!==c.text?c.title+'\n\n':'', c.text, (c.deliverables||[]).length?'\n\nEntregas:\n'+c.deliverables.map(x=>'- '+x).join('\n'):'', (c.requirements||[]).length?'\n\nRequisitos:\n'+c.requirements.map(x=>'- '+x).join('\n'):''].join(''); } $id('orqOverlay').style.display='flex'; if(!orq.list||Date.now()-orqListAt>20000) orqLoadList().then(orqRender); orqRender(); }
async function orqLoadList(){ const before=JSON.stringify((orq.list||[]).map(p=>[p.id,p.status,(p.phases||[]).map(x=>x.taskId)])); try{ orq.list=await invoke('orch_list'); }catch(_){ orq.list=[]; } orqListAt=Date.now(); const after=JSON.stringify((orq.list||[]).map(p=>[p.id,p.status,(p.phases||[]).map(x=>x.taskId)])); if(before!==after){ lastSig=''; } }
// abre o grafo de um plano salvo (sidebar, quadro, chip da tarefa)
async function orqOpenPlan(id, taskId){
  if(!orq.list) await orqLoadList();
  const p=(orq.list||[]).find(x=>x.id===id); if(!p){ toast('Plano não encontrado neste projeto.','warn'); return; }
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
function orqProjName(p){ return p&&p.repo?pathBase(p.repo):''; }
function orqOtherRepo(p){ return !!(p&&p.repo&&state.repo&&p.repo!==state.repo); }
function orqPlanStats(p){ const ph=p.phases||[]; const st=ph.map(orqPhaseState); return { total:ph.length, done:st.filter(x=>x.key==='done').length, run:st.filter(x=>['running','queued'].includes(x.key)).length, err:st.filter(x=>x.key==='error').length, ask:st.filter(x=>x.key==='asking').length, rev:st.filter(x=>x.key==='review').length, st }; }
// cor/rótulo do plano inteiro pra sidebar e quadro: pergunta pendente > erro > pra revisar > rodando > esperando
function orqPlanTone(p, s){ if(p.status==='planned') return { col:'var(--muted)', label:'plano proposto · aguardando aprovação' }; if(p.status==='done') return { col:ORQ_ST.done, label:'concluído' };
  if(s.ask) return { col:ORQ_ST.asking, label:`${s.ask} fase${s.ask===1?'':'s'} esperando sua resposta` }; if(s.err) return { col:ORQ_ST.error, label:`${s.err} fase(s) com erro` }; if(s.rev) return { col:ORQ_ST.review, label:`${s.rev} entrega${s.rev===1?'':'s'} pra revisar` };
  if(s.run) return { col:ORQ_ST.running, label:`${s.run} rodando · ${s.done}/${s.total} prontas` }; return { col:'rgba(255,255,255,.5)', label:`esperando · ${s.done}/${s.total} prontas` }; }
// sidebar: uma linha por plano vivo, acima das tarefas do projeto
function orqRailRows(){
  const list=(orq.list||[]).filter(p=>p.status!=='done'&&!orqOtherRepo(p));
  if(!list.length){ if(!orq.list) orqLoadList(); return ''; }
  return list.slice(0,4).map(p=>{ const s=orqPlanStats(p); const tone=orqPlanTone(p, s); const col=tone.col;
    const tag=p.status==='planned'?'plano':s.ask?'pergunta: '+s.ask:s.rev?'revise':`${s.done}/${s.total}`;
    return `<div class="prow2 orqrow" data-orq="${escA(p.id)}" title="${escA(tone.label)} — abrir o grafo"><span class="d" style="background:${col}"></span><span class="tt"><span class="orqic">${IC.orq}</span>${esc(p.title||'plano')}</span><span class="tg" style="color:${col}">${tag}</span></div>`; }).join('');
}
// quadro (Execução): cartão por plano com as fases e o progresso
function orqBoardHtml(scope){
  const pf=(typeof projFilter!=='undefined')?projFilter:'all';
  const list=(orq.list||[]).filter(p=>scope==='done'?p.status==='done':p.status!=='done').filter(p=>pf==='all'||!p.repo||p.repo===pf||orqProjName(p)===pf);
  if(!list.length) return '';
  const cards=list.map(p=>{ const s=orqPlanStats(p); const pct=s.total?Math.round(s.done/s.total*100):0;
    const tone=orqPlanTone(p, s); const label=tone.label;
    const col=tone.col;
    const chips=(p.phases||[]).map((ph,i)=>`<span class="orqc-ph" style="--c:${orqColor(ph.kind)}" title="${escA(ph.name)} · ${escA(s.st[i].label)}"><i style="background:${s.st[i].color}"></i><b>${orqBadge(ph.kind)}</b>${esc(ph.name)}</span>`).join('');
    return `<div class="orqcard" data-orq="${escA(p.id)}"><div class="orqc-top"><span class="orqc-ring"></span><span class="orqc-title">${esc(p.title||'plano')}</span>${orqProjName(p)?`<span class="orqc-proj${orqOtherRepo(p)?' other':''}" title="${escA(p.repo)}">${esc(orqProjName(p))}</span>`:''}<span class="orqc-st" style="color:${col}">${esc(label)}</span><button class="btn sm" data-orq="${escA(p.id)}">abrir grafo</button></div>
      ${p.summary?`<div class="orqc-sum">${esc(String(p.summary).slice(0,200))}</div>`:''}
      <div class="orqc-bar"><i style="width:${pct}%"></i></div><div class="orqc-phs">${chips}</div></div>`; }).join('');
  return `<div class="secgrp orqgrp"><div class="sech"><span class="secic">${IC.orq}</span>Planos do orquestrador <span class="n">${list.length}</span></div>${cards}</div>`;
}
function orqWireOpeners(root){ (root||document).querySelectorAll('[data-orq]').forEach(b=>{ if(b.dataset.orqWired) return; b.dataset.orqWired='1'; b.onclick=(e)=>{ e.stopPropagation(); orqOpenPlan(b.dataset.orq, b.dataset.orqTask||null); }; }); }
window.orqRailRows=orqRailRows; window.orqBoardHtml=orqBoardHtml; window.orqWireOpeners=orqWireOpeners;
function orqSeg(cur){
  // mesmo seletor (e mesmos nomes) da Nova demanda / Montar conversando / Preencher eu mesmo
  return typeof ndMethodSeg==='function' ? ndMethodSeg('orq') : '';
}
function orqStatusPill(){
  if(orq.step==='brief') return `<span class="orq-pill"><i></i>nenhum plano ainda</span>`;
  const p=orq.plan; if(!p) return '';
  if(p.status==='planned') return `<span class="orq-pill"><i></i>plano proposto · aguardando você</span>`;
  const ks=p.phases.map(x=>orqPhaseState(x).key);
  const run=ks.filter(k=>k==='running'||k==='queued').length, done=ks.filter(k=>k==='done').length, ask=ks.filter(k=>k==='asking').length, rev=ks.filter(k=>k==='review').length;
  if(done===p.phases.length) return `<span class="orq-pill ok"><i></i>plano concluído</span>`;
  if(ask) return `<span class="orq-pill ask"><i></i>${ask} fase${ask===1?'':'s'} esperando sua resposta</span>`;
  if(rev) return `<span class="orq-pill rev"><i></i>${rev} entrega${rev===1?'':'s'} pra revisar</span>`;
  return `<span class="orq-pill live"><i></i>${run} subagente${run===1?'':'s'} rodando · ${done}/${p.phases.length} prontas</span>`;
}
function orqRender(){
  const body=$id('orqBody'); if(!body) return;
  const stick=stickBottom($id('orqChat')); // lendo lá em cima? o tick de 7s não te joga mais pro fim
  if(orq.step==='brief') orqRenderBrief(body); else orqRenderPlan(body);
  stick($id('orqChat'));
  body.querySelectorAll('[data-orqgo]').forEach(b=>b.onclick=()=>{ if(b.dataset.orqgo&&window.openTab) window.openTab(b.dataset.orqgo); });
}
function orqRenderBrief(body){
  const prev=(orq.list||[]).slice(0,6);
  body.__html=null; // o brief troca o conteúdo: a guarda do plano não pode achar que ainda está lá
  body.innerHTML=`<div class="orq-top">${orqSeg('orq')}<span style="flex:1"></span>${orqStatusPill()}</div>
  <div class="orq-brief"><div class="orq-briefin">
    <div class="ndeyebrow" style="color:var(--accent)">dividir entre vários agentes</div>
    <h1 class="ndh1" style="margin-top:10px">Descreva o problema inteiro</h1>
    <p class="ndsub">Não precisa quebrar em tarefas. Um agente orquestrador lê isso, propõe as fases e abre um subagente para cada uma. Você aprova o plano antes de qualquer coisa rodar.</p>
    ${orq.busy?brandLoaderHtml(orq.planStopping?'parando o orquestrador…':'o orquestrador está lendo o projeto e montando o plano…', { now:true })+`<div class="orq-busyrow"><span class="dim" id="orqBusyT">${esc(orq.planStopping?'parando…':orqBusyTx(orq.busyAt?Date.now()-orq.busyAt:0))}</span><button class="btn sm trk-stop" id="orqPlanStop" title="interrompe o orquestrador — seu texto continua aqui"${orq.planStopping?' disabled':''}>${orq.planStopping?'parando…':'■ parar'}</button></div>`:`
    <div class="attrow attpend" id="orqPend" style="display:${orq.atts.length?'flex':'none'}"></div>
    ${chatComposerHtml({ cls:'orq-briefcc', input:'orqTa', attach:'orqAtt', rows:5, value:orq.briefing,
      placeholder:'ex.: o autocomplete de empresas está retornando resultados ruins e ninguém sabe se é ranking, índice ou dado sujo — quero entender, propor a correção e entregar',
      extras:'<button class="btn sm" id="orqLastInv">usar a última investigação</button>',
      modelPill:aiChatModelPill('orqModel'),
      send:'orqGo', sendHtml:'Montar o plano' })}
    ${orq.msg?`<div class="orq-msg${orq.msgErr?' err':''}" role="${orq.msgErr?'alert':'status'}"><span>${esc(orq.msg)}</span>${orq.msgErr&&orq.briefing.trim().length>=12?'<button class="btn sm" id="orqRetry">tentar de novo</button>':''}</div>`:''}
    <div class="ndeyebrow" style="margin-top:26px">o orquestrador pode</div>
    <div class="orq-can">
      <div><i style="background:#3fd68a"></i>Quebrar em fases com dependência: uma só começa quando a anterior provar o resultado</div>
      <div><i style="background:#4fc4c9"></i>Abrir um subagente por fase, cada um numa cópia isolada do projeto</div>
      <div><i style="background:#b47ce0"></i>Rodar em paralelo o que não depende de ninguém</div>
      <div><i style="background:var(--st-ask)"></i>Parar e te perguntar sempre que a decisão for sua</div>
    </div>
`}
    ${prev.length?`<div class="ndeyebrow" style="margin-top:34px">planos anteriores</div><div class="orq-prev">${prev.map(p=>`<button class="orq-prevrow" data-orqopen="${escA(p.id)}"><b>${esc(p.title||'plano')}</b><span class="mono dim">${orqProjName(p)?esc(orqProjName(p))+' · ':''}${(p.phases||[]).length} fases · ${esc(p.status==='planned'?'não aprovado':p.status==='done'?'concluído':'rodando')} · ${esc(typeof agoTx==='function'?agoTx(new Date(p.createdAt).toISOString()):'')}</span></button>`).join('')}</div>`:''}
  </div></div>`;
  const briefHint=()=>orq.briefing.trim().length<12?'escreva pelo menos uma frase completa · ⌘Enter monta o plano · ⌘V ou arraste pra anexar':'⌘Enter monta o plano · nada roda antes de você aprovar · ⌘V ou arraste pra anexar';
  if(typeof attRenderPend==='function') attRenderPend('orqPend', orq.atts, ()=>orqRender());
  // mesmo composer dos chats (anexo · extras · enviar + dica); aqui Enter quebra linha e ⌘Enter monta o plano
  chatComposer({ input:'orqTa', attach:'orqAtt', pend:()=>orq.atts, taskId:()=>null, rerender:()=>orqRender(), onSend:orqPlanNow, hint:briefHint(), modelPill:aiChatModelPill('orqModel'),
    onKey:e=>{ if(e.key!=='Enter'||e.isComposing) return; if(e.metaKey||e.ctrlKey){ e.preventDefault(); orqPlanNow(); } return true; } });
  const ta=$id('orqTa'); if(ta){ ta.oninput=()=>{ orq.briefing=ta.value; const g=$id('orqGo'); if(g) g.disabled=ta.value.trim().length<12; const h=ta.closest('.cc'); if(h) chatHintLine(h, briefHint(), false); }; ta.focus(); }
  { const g=$id('orqGo'); if(g) g.disabled=orq.briefing.trim().length<12; }
  bindClick('orqLastInv', ()=>{ const inv=(state.tasks||[]).filter(t=>t.kind==='invest'||/^invest\//.test(t.branch||'')).slice(-1)[0]; if(!inv){ orq.msg='nenhuma investigação encontrada neste projeto.'; orq.msgErr=false; orqRender(); return; } orq.briefing=(orq.briefing?orq.briefing+'\n\n':'')+`Partir da investigação "${inv.title}" (tarefa ${inv.id} — leia .cardume/artifacts/${inv.id}/INVESTIGATION.md).`; orqRender(); });
  bindClick('orqGo', orqPlanNow);
  bindClick('orqRetry', orqPlanNow);
  bindClick('orqPlanStop', orqPlanStop);
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
// PURA: há quanto tempo o orquestrador está montando o plano (e o aviso de demora) — testada em r8-planner-form-orq.test.mjs
function orqBusyTx(ms){ const s=Math.max(0, Math.round((+ms||0)/1000)), t=s<60?s+'s':Math.floor(s/60)+'min '+String(s%60).padStart(2,'0')+'s';
  return s>=120?'há '+t+' · está demorando — pode parar e tentar com um texto mais curto':'há '+t+' · costuma levar de 30 s a 2 min'; }
// prazo do ai_orchestrate — o MESMO número do Rust (ORQ_PLAN_SECS em lib.rs)
const ORQ_PLAN_SECS=300;
// pedidos de plano ainda no ar (id → a aba sabe se o "montando" dela é de verdade depois de restaurada)
const orqPlanReqs=new Set();
// PURA: erro do ai_orchestrate → frase de gente (nunca o JSON cru da IA) · { msg, stopped }
function orqPlanErr(e){
  const raw=String((e&&e.message)||e||'');
  if(/ORQ_PLAN_STOPPED/.test(raw)) return { msg:'Parado. Seu texto continua aí — ajuste e monte de novo quando quiser.', stopped:true };
  if(/ORQ_BAD_PLAN/.test(raw)) return { msg:'O orquestrador respondeu, mas não num plano que eu consiga ler. Tente de novo — ou conte mais: onde acontece, o que precisa mudar e como saber que ficou pronto.', stopped:false };
  if(/expirou|timeout|timed out/i.test(raw)) return { msg:'O orquestrador demorou demais (mais de '+Math.round(ORQ_PLAN_SECS/60)+' min) e foi interrompido. Tente de novo — com um texto mais direto costuma ir mais rápido.', stopped:false };
  const h=(typeof humanErr==='function')?humanErr(raw, 'Não deu pra montar o plano'):{ msg:'Não deu pra montar o plano: '+raw.split('\n')[0] };
  return { msg:h.msg, stopped:false };
}
// parar: derruba SÓ o pedido desta aba (o Rust guarda um processo por reqId). Nada no ar (aba restaurada com
// busy velho) → solta a tela na hora em vez de esperar uma resposta que não vem
async function orqPlanStop(){ const o=orq; if(!o.busy||o.planStopping) return; o.planStopping=true; orqRender();
  let ok=false; try{ ok=await invoke('orq_plan_stop',{ reqId:o.planReq||'' }); }catch(_){ }
  if(!ok && !orqPlanReqs.has(o.planReq)){ o.busy=false; o.planStopping=false; clearInterval(o.busyTick); o.busyTick=null; o.msg=orqPlanErr('ORQ_PLAN_STOPPED').msg; o.msgErr=false; if(orq===o) orqRender(); } }
async function orqPlanNow(){
  // R8: `o` = o estado DESTA aba. Trocar de aba enquanto a IA pensava fazia o plano cair na aba que estava na tela
  // (TAB_STATE_orq troca o objeto `orq` inteiro).
  const o=orq; const text=o.briefing.trim(); if(text.length<12 || o.busy) return;
  const req=orqNewId(); orqPlanReqs.add(req);
  o.busy=true; o.busyAt=Date.now(); o.planReq=req; o.planStopping=false; o.msg=''; o.msgErr=false; orqRender();
  // o relógio é DESTA aba (em `o`): duas abas montando plano não congelam o tempo uma da outra
  clearInterval(o.busyTick); o.busyTick=setInterval(()=>{ if(!o.busy){ clearInterval(o.busyTick); o.busyTick=null; return; } const el=$id('orqBusyT'); if(el && orq===o && !o.planStopping) el.textContent=orqBusyTx(Date.now()-o.busyAt); }, 1000);
  try{
    const d=aiDefaults(); const model=o.model||d.model||'';
    const raw=await invoke('ai_orchestrate',{ briefing:text+attPromptBlock(o.atts), model:aiClaudeModel(d.eng, model), reqId:req });
    if(o.planStopping) throw new Error('ORQ_PLAN_STOPPED'); // parou e a resposta chegou mesmo assim: o plano NÃO aparece
    let obj=null; try{ const m=String(raw||'').match(/```json\s*([\s\S]*?)```/i)||String(raw||'').match(/(\{[\s\S]*\})/); if(m) obj=JSON.parse(m[1]); }catch(_){}
    if(!obj||!Array.isArray(obj.phases)||!obj.phases.length){ console.warn('[orquestrador] resposta sem plano', String(raw||'').slice(0,2000)); throw new Error('ORQ_BAD_PLAN'); }
    const phases=orqNormPhases(obj.phases);
    o.plan={ id:orqNewId(), title:String(obj.title||text.slice(0,60)).slice(0,80), summary:String(obj.summary||''), briefing:text, createdAt:Date.now(), status:'planned', model, engine:d.eng||defaultAiEngine(), phases, repo:state.repo||'' };
    o.step='plan'; o.sel=phases[0].key; o.pan={x:20,y:20}; o.zoom=1; o.needFit=true;
    await invoke('orch_save',{ id:o.plan.id, data:o.plan, repo:o.plan.repo||null }).catch(()=>{});
    orqListAt=0;
  }catch(e){ const r=orqPlanErr(o.planStopping?'ORQ_PLAN_STOPPED':e); o.msg=r.msg; o.msgErr=!r.stopped; if(!r.stopped) console.warn('orq plano', typeof errText==='function'?errText(e):e); }
  orqPlanReqs.delete(req); clearInterval(o.busyTick); o.busyTick=null;
  if(o.planReq===req){ o.busy=false; o.planStopping=false; } if(orq===o) orqRender();
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
      : st.key==='review' ? `entregou · ${done}/${tot} provados — revise a entrega`
      : st.key==='asking' ? `pergunta: ${String((st.ask&&st.ask.prompt)||'perguntou ao humano').replace(/\s+/g,' ').slice(0,140)}`
      : st.key==='error' ? 'falhou — abra a tarefa'
      : (deps.length&&st.key==='waiting') ? `aguardando ${deps.map(d=>d.key).join(', ')} · ${deps[0].name.toLowerCase()}`
      : t ? (st.key==='waiting'?'pronta pra começar':'iniciando…') : 'aguardando aprovação do plano';
    // rodando: mostra o terminal ao vivo; nos outros estados o resumo do estado vale mais que o log velho
    const sub=(st.key==='running'||st.key==='queued')&&last.length?last.map(l=>`<span>${esc(l)}</span>`).join(''):`<span class="${st.key==='asking'?'orq-askq':''}">${esc(idle)}</span>`;
    const action = !t ? `<button class="orq-open" data-orqsel2="${escA(ph.key)}">ver objetivos</button>`
      : st.key==='asking' ? `<button class="orq-open act" data-orqtask="${escA(t.id)}" data-orqmode="conversa">responder ↗</button>`
      : st.key==='review' ? `<button class="orq-open act" data-orqtask="${escA(t.id)}" data-orqmode="entrega">revisar entrega ↗</button>`
      : st.key==='running' ? `<button class="orq-open" data-orqtask="${escA(t.id)}" data-orqmode="conversa">acompanhar ↗</button>`
      : st.key==='error' ? `<button class="orq-open act" data-orqtask="${escA(t.id)}">ver o erro ↗</button>`
      : `<button class="orq-open" data-orqtask="${escA(t.id)}">abrir tarefa ↗</button>`;
    const chip = st.key==='asking' ? '<span class="orq-stchip asking">responda</span>' : st.key==='review' ? '<span class="orq-stchip review">revise</span>' : st.key==='running' ? '<span class="orq-stchip running"><i class="spin" style="--pc:var(--st-run);background:var(--st-run)"></i>rodando</span>' : st.key==='done' ? '<span class="orq-stchip done">✓</span>' : st.key==='error' ? '<span class="orq-stchip error">erro</span>' : '';
    return `<div class="orq-node ${st.key}${orq.sel===ph.key?' sel':''}" data-orqsel="${escA(ph.key)}" style="left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px;--c:${orqColor(ph.kind)};--st:${st.color}">
      <div class="orq-nh"><span class="orq-nn" title="${escA(ph.name)}">${esc(ph.name)}</span>${chip||`<i class="orq-dot" style="background:${st.color}"></i>`}</div>
      <div class="orq-nm mono"><span class="orq-nmk"><b class="orq-badge sm">${orqBadge(ph.kind)}</b><span style="color:${st.color}">${esc(st.label)}</span></span><span>${done}/${tot} objetivos</span></div>
      <div class="orq-bar"><i style="width:${tot?Math.round(done/tot*100):0}%;background:${st.key==='done'?ORQ_ST.done:st.color}"></i></div>
      <div class="orq-term mono">${sub}</div>
      ${action}
    </div>`; }).join('');
  const o=pos.__orq; const par=p.phases.filter(x=>!(x.dependsOn||[]).length).length;
  const orqNode=`<div class="orq-node orq-master${orq.sel==='__orq'?' sel':''}" data-orqsel="__orq" style="left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px">
      <div class="orq-nh"><i class="orq-ring"></i><span class="orq-nn">Orquestrador</span></div><div class="mono" style="font-size:var(--fs-xs);color:var(--accent);margin:-4px 0 6px 24px">${running?'comandando':'propôs o plano'}</div>
      <div class="orq-nd">${esc(p.summary||'')}</div><div class="mono dim" style="font-size:var(--fs-xs);margin-top:8px">${p.phases.length} subagentes · ${par} podem rodar juntos</div></div>`;
  const nObj=p.phases.reduce((a,x)=>a+(x.objectives||[]).length,0);
  const stKeys=p.phases.map(x=>orqPhaseState(x).key);
  const runN=stKeys.filter(k=>k==='running'||k==='queued').length, doneN=stKeys.filter(k=>k==='done').length, askN=stKeys.filter(k=>k==='asking').length, revN=stKeys.filter(k=>k==='review').length, errN=stKeys.filter(k=>k==='error').length;
  const footTx=[runN?`<span style="color:${ORQ_ST.running}">${runN} rodando</span>`:'', askN?`<span style="color:${ORQ_ST.asking}">${askN} esperando sua resposta</span>`:'', revN?`<span style="color:${ORQ_ST.review}">${revN} pra revisar</span>`:'', errN?`<span style="color:${ORQ_ST.error}">${errN} com erro</span>`:'', `<span style="color:${ORQ_ST.done}">${doneN}/${p.phases.length} prontas</span>`].filter(Boolean).join(' <span class="dim">·</span> ');
  const otherRepo=p.repo&&state.repo&&p.repo!==state.repo;
  const html=`<div class="orq-top">${orqSeg('orq')}<span style="flex:1"></span>${otherRepo?`<span class="mono" style="font-size:var(--fs-xs);color:var(--warn);margin-right:12px" title="${escA(p.repo)}">plano do projeto ${esc(pathBase(p.repo))}</span>`:''}${orqStatusPill()}</div>
  <div class="orq-main">
    <div class="orq-canvaswrap">
      <div class="orq-tools"><button class="as-btn" id="orqAdd">+ subagente</button>
        <span class="orq-leg"><i style="background:${ORQ_ST.running}"></i>rodando <i style="background:${ORQ_ST.asking}"></i>perguntou · responda <i style="background:${ORQ_ST.review}"></i>entregou · revise <i style="background:${ORQ_ST.done}"></i>pronto <i style="background:${ORQ_ST.error}"></i>erro <i style="background:rgba(255,255,255,.35)"></i>esperando</span>
        <span style="flex:1"></span><span class="mono dim" style="font-size:var(--fs-xs)">arraste o fundo</span>
        <span class="orq-zoom"><button data-orqz="-">−</button><button data-orqz="fit">ajustado</button><button data-orqz="+">+</button></span></div>
      <div class="orq-canvas" id="orqCanvas">
        <div class="orq-world" id="orqWorld" style="transform:translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})"><svg class="orq-svg" width="${pos.__size.w}" height="${pos.__size.h}">${edges}</svg>${orqNode}${nodes}</div></div>
    </div>
    <aside class="orq-insp" id="orqInsp">${orq.addOpen?orqAddHtml():orqInspHtml()}</aside>
  </div>
  <div class="orq-foot"><span class="mono" style="color:${running?'var(--text-2)':'var(--warn)'}">${running?footTx:`${nObj} objetivos em ${p.phases.length} fases · revise antes de soltar`}</span><span style="flex:1"></span>
    <button class="as-btn orq-chatbtn" id="orqChatBtn" title="pergunte sobre o projeto ou peça ajustes no plano">${ic('chat',13)}conversar</button>
    <button class="as-btn" id="orqRedo">${running?'novo plano':'refazer'}</button>
    ${running?`<button class="as-btn" disabled>${doneN===p.phases.length?'plano concluído':'plano rodando'}</button>`:`<button class="as-btn primary big" id="orqApprove" ${orq.busy?'disabled':''}>${orq.busy?'criando as tarefas…':'aprovar plano e rodar'}</button>`}</div>`;
  // tick de 7s: nada visível mudou → mantém o DOM (o céu animado reiniciava e o clique se perdia a cada tick)
  if(body.__html===html && body.firstChild) return;
  body.__html=html; body.innerHTML=html;
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
  try{ const rows=evNormAll((await invoke('task_events',{ taskId, sinceId:c.lastId }))||[]);
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
  canvas.onmousedown=e=>{ if(e.target.closest('.orq-node')) return; orqDrag={ x:e.clientX, y:e.clientY, px:orq.pan.x, py:orq.pan.y }; orq.autoFit=false; canvas.classList.add('drag'); };
  window.onmousemove=e=>{ if(!orqDrag) return; orq.pan.x=orqDrag.px+(e.clientX-orqDrag.x); orq.pan.y=orqDrag.py+(e.clientY-orqDrag.y); world.style.transform=`translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})`; };
  window.onmouseup=()=>{ if(orqDrag){ orqDrag=null; canvas.classList.remove('drag'); } };
  const fit=()=>{ const r=canvas.getBoundingClientRect(); if(!r.width) return; orq.zoom=Math.max(.85,Math.min(1,(r.width-40)/pos.__size.w,(r.height-40)/pos.__size.h)); /* piso .85 = cartões legíveis; o que não cabe continua à direita (fade na borda) */ orq.pan={x:Math.max(16,(r.width-pos.__size.w*orq.zoom)/2), y:Math.max(16,(r.height-pos.__size.h*orq.zoom)/2)}; world.style.transform=`translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})`; };
  if(orq.needFit){ orq.needFit=false; orq.autoFit=true; requestAnimationFrame(fit); }
  // R5-10: abrir/fechar o chat do orquestrador estreita o canvas — enquanto você não mexeu no zoom/arrasto, reajusta
  if(!canvas.__ro && typeof ResizeObserver==='function'){ canvas.__ro=new ResizeObserver(()=>{ if(orq.autoFit && canvas.__fit) canvas.__fit(); }); canvas.__ro.observe(canvas); }
  canvas.__fit=fit;
  body.querySelectorAll('[data-orqz]').forEach(b=>b.onclick=()=>{ const z=b.dataset.orqz; if(z==='fit'){ orq.autoFit=true; fit(); return; } orq.autoFit=false; orq.zoom=Math.max(.4,Math.min(1.6,orq.zoom+(z==='+'?.12:-.12))); world.style.transform=`translate(${orq.pan.x}px,${orq.pan.y}px) scale(${orq.zoom})`; });
  body.querySelectorAll('[data-orqsel]').forEach(n=>n.onclick=e=>{ if(e.target.closest('[data-orqtask]')) return; orq.sel=n.dataset.orqsel; orq.addOpen=false; orqRender(); });
  body.querySelectorAll('[data-orqsel2]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); orq.sel=b.dataset.orqsel2; orq.addOpen=false; orqRender(); });
  body.querySelectorAll('[data-orqtask]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); openWorkspace(b.dataset.orqtask); const m=b.dataset.orqmode; if(m){ setTimeout(()=>{ try{ if(fwTask===b.dataset.orqtask){ fwMode=m; renderWorkspace(); } }catch(_){ } }, 250); } });
  bindClick('orqAdd', ()=>{ orq.addOpen=!orq.addOpen; orqRender(); });
  bindClick('orqChatBtn', orqChatFocus);
  bindClick('orqRedo', async()=>{ const pl=orq.plan, planned=pl.status==='planned';
    // R8: "refazer" apagava o plano proposto (com as suas edições) sem perguntar e voltava com a caixa do problema vazia
    if(!await askYes(planned?'Descartar este plano e voltar pro texto do problema?\n\nO texto volta pra caixa pra você ajustar e montar de novo.':'Começar um plano novo? As tarefas já criadas continuam existindo.')) return;
    if(planned){ invoke('orch_delete',{ id:pl.id, repo:pl.repo||null }).catch(()=>{}); orq.briefing=pl.briefing||orq.briefing||''; }
    orq.plan=null; orq.step='brief'; orq.msg=''; orq.msgErr=false; orqListAt=0; orqRender(); });
  bindClick('orqApprove', orqApprove);
  orqWireInsp(body);
}
// ---- conversa com o orquestrador sobre o projeto/plano (persistida no plano) ----
function orqChatHtml(p){
  const msgs=p.chat||[];
  const locked=p.status!=='planned';
  const thread=msgs.length?msgs.map(chatMsgHtml).join('')
    :`<div class="orq-cm hint">Pergunte sobre o projeto ("por que a fase 2 depende da 1?", "quais arquivos a fase de build vai mexer?") ${locked?'ou peça sugestões — o plano já está rodando, então as fases não mudam por aqui.':'ou peça ajustes no plano ("junta as fases 2 e 3", "adiciona uma fase de testes de carga") — o grafo muda na hora.'}</div>`;
  return `<div class="orq-chatwrap"><div class="ndeyebrow" style="margin-top:12px">conversar com o orquestrador <span class="dim" style="text-transform:none;letter-spacing:0">· lê o repo de verdade${locked?'':' · pode ajustar o plano'}</span></div>
    <div class="orq-chat" id="orqChat">${thread}${orq.chatBusy?chatThinkHtml():''}</div>
    <div class="attrow attpend orq-chatpend" id="orqChatPend" style="display:none"></div>
    ${chatComposerHtml({ cls:'orq-chatin', input:'orqChatTa', attach:'orqChatAtt', stop:'orqChatStop', send:'orqChatSend', placeholder:'pergunte ou peça um ajuste…', value:orq.chatDraft||'', stopTitle:'interrompe o orquestrador agora' })}</div></div>`;
}
function orqWireChat(body){
  { const d=body.querySelector('.orq-more'); if(d) d.ontoggle=()=>{ orq.moreOpen=d.open; }; }
  const ta=$id('orqChatTa'); if(!ta) return;
  // a tela do plano tem guarda de "HTML igual → não repinta": os chips pendentes se desenham direto no lugar
  const pend=()=>attRenderPend('orqChatPend', orq.chatAtts, pend); pend();
  chatComposer({ input:'orqChatTa', attach:'orqChatAtt', pend:()=>orq.chatAtts, taskId:()=>null, rerender:pend, onSend:orqChatSend, send:'orqChatSend',
    stop:{ btn:'orqChatStop', busy:()=>!!orq.chatBusy, fn:orqChatStop }, busyHint:'o orquestrador está lendo o repo · ■ parar interrompe — dá pra ir escrevendo a próxima' });
  ta.oninput=()=>{ orq.chatDraft=ta.value; chatGrow(ta); };
  bindClick('orqChatSend', orqChatSend);
}
async function orqChatStop(){ if(!orq.chatBusy) return; orq.chatStopping=true; try{ await invoke('orq_chat_stop'); }catch(_){ } }
function orqChatFocus(){ orq.sel='__orq'; orq.addOpen=false; orqRender(); const ta=$id('orqChatTa'); if(ta){ ta.focus(); ta.scrollIntoView({block:'nearest'}); } }
async function orqChatSend(){
  const o=orq, p=o.plan; if(!p) return; // `o`: o estado desta aba (ver orqPlanNow)
  if(o.chatBusy){ toast('O orquestrador ainda está respondendo — espere ou toque em ■ parar.'); return; }
  let text=(o.chatDraft||'').trim();
  const atts=(o.chatAtts||[]).splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e extraia o contexto (spec, print do bug, etc.).';
  if(!text) return;
  p.chat=p.chat||[]; p.chat.push({who:'you', text, atts:attLite(atts)}); o.chatDraft=''; o.chatBusy=true; o.chatStopping=false; chatPinBottom('orqChat'); orqRender();
  try{
    const planJson=JSON.stringify({ title:p.title, summary:p.summary, briefing:p.briefing, status:p.status, phases:p.phases.map(x=>({ key:x.key, name:x.name, kind:x.kind, agent:x.agent, objective:x.objective, objectives:x.objectives, autonomy:x.autonomy, dependsOn:x.dependsOn, taskId:x.taskId||undefined })) });
    if(!p.repo) p.repo=state.repo||'';
    const r=await aiCallResumeSafe((pr,sid)=>invoke('ai_orchestrate_chat',{ prompt:pr, sessionId:sid, model:aiClaudeModel(p.engine||'claude', p.model||''), plan:planJson, repo:p.repo||null }), p.chatSid||null, text+attPromptBlock(atts), p.chat.slice(0,-1).filter(m=>m.who!=='sys'));
    if(r&&r.recovered) p.chat.push({who:'sys', text:'a sessão anterior foi perdida — continuei com o histórico da conversa.'});
    aiKeepSid(r, s=>{ p.chatSid=s; });
    let obj=null; try{ const m=(r.text||'').match(/```json\s*([\s\S]*?)```/i)||(r.text||'').match(/(\{[\s\S]*\})/); if(m) obj=JSON.parse(m[1]); }catch(_){}
    const say=obj&&typeof obj.say==='string'?obj.say:(r.text||'(sem resposta)');
    p.chat.push({who:'bot', text:say});
    if(obj&&obj.plan&&Array.isArray(obj.plan.phases)&&obj.plan.phases.length){
      if(p.status==='planned'){
        const before=p.phases.length;
        p.phases=orqNormPhases(obj.plan.phases, p.phases);
        if(obj.plan.title) p.title=String(obj.plan.title).slice(0,80);
        if(obj.plan.summary) p.summary=String(obj.plan.summary);
        if(!p.phases.some(x=>x.key===o.sel)&&o.sel!=='__orq') o.sel='__orq';
        o.needFit=true;
        p.chat.push({who:'sys', text:`plano atualizado — ${p.phases.length} fase(s)${p.phases.length!==before?` (antes ${before})`:''}: ${p.phases.map(x=>x.name).join(' · ')}`});
      } else {
        p.chat.push({who:'sys', text:'o plano já está rodando — a sugestão acima não foi aplicada (use "+ subagente" pra acrescentar uma fase).'});
      }
    }
  }catch(e){
    const msg=String((e&&e.message)||e||'');
    if(o.chatStopping||/ORQ_CHAT_STOPPED/.test(msg)){ // parado: a pergunta volta pra caixa (com os anexos)
      const last=p.chat[p.chat.length-1]; if(last&&last.who==='you'&&last.text===text) p.chat.pop();
      p.chat.push({who:'sys', text:'Parado. Sua mensagem voltou pra caixa — edite e envie de novo quando quiser.'});
      if(!o.chatDraft) o.chatDraft=text; o.chatAtts=(o.chatAtts||[]).concat(atts);
    } else { // erro: a pergunta e os anexos também voltam pra caixa (antes: "envie de novo" com a caixa vazia); texto traduzido (R8b)
      const last=p.chat[p.chat.length-1]; if(last&&last.who==='you'&&last.text===text) p.chat.pop();
      const h=humanErr(e,'O orquestrador não respondeu');
      p.chat.push({who:'sys', text:h.msg+' Sua mensagem voltou pra caixa — envie de novo quando quiser.'});
      if(h.action) showErr(e,'O orquestrador não respondeu');
      if(!o.chatDraft) o.chatDraft=text; o.chatAtts=(o.chatAtts||[]).concat(atts); }
  }
  o.chatBusy=false; o.chatStopping=false;
  if(o.plan===p) orqSave(p); // grava ESTE plano (não o da aba que estiver na tela)
  if(orq===o){ orqRender(); const ta=$id('orqChatTa'); if(ta) ta.focus(); }
}
function orqInspHtml(){
  const p=orq.plan; if(orq.sel==='__orq'||!orq.sel) return `<div class="orq-ih"><span class="orq-badge" style="--c:var(--accent)">◉</span><div><b>Orquestrador</b><div class="mono dim" style="font-size:var(--fs-xs)">${p.status==='planned'?'propôs o plano':'comandando'}${p.model?` · <span title="${escA(p.model)}">${esc(boardModelName(p.model)||p.model)}</span>`:''}</div></div></div>
    <p class="orq-p">${esc(p.summary||'')}</p>
    <details class="orq-more"${orq.moreOpen?' open':''}><summary>regras · briefing</summary>
      <div class="ndeyebrow">regras</div><ul class="orq-rules"><li>Nunca mexe em código — planeja, abre tarefa, coordena e para pra perguntar.</li><li>Nada roda sem a sua aprovação do plano.</li><li>Uma fase só começa quando as anteriores PROVAREM o resultado (requisitos com evidência).</li><li>Fases sem dependência rodam em paralelo, cada uma numa cópia isolada do projeto.</li></ul>
      <div class="ndeyebrow" style="margin-top:14px">briefing</div><p class="orq-p dim" style="white-space:pre-wrap">${esc(p.briefing||'')}</p>
    </details>
    ${orqChatHtml(p)}`;
  const ph=p.phases.find(x=>x.key===orq.sel); if(!ph) return '';
  const t=orqTaskOf(ph); const st=orqPhaseState(ph); const locked=!!t||p.status!=='planned'; const c=t?reqProofCache[t.id]:null; const m=(t&&c&&c.list)?matchReqProofs(Array.isArray(t.requirements)?t.requirements:ph.objectives, c.list):null;
  const objs=(ph.objectives||[]).map((o,i)=>{ const ok=m&&m[i]&&m[i].status==='done'; const defer=!ok&&m&&m[i]&&orqReqSettled(m[i]); const blk=!ok&&!defer&&m&&m[i]&&m[i].status==='blocked'; const ev=(m&&m[i]&&Array.isArray(m[i].evidence)&&m[i].evidence[0])||''; return `<div class="orq-obj${ok?' ok':defer?' defer':blk?' blk':''}"><span class="orq-chk" title="${ok?'provado':defer?'adiado por decisão sua — não trava o plano':blk?'bloqueado':'pendente'}">${ok?'✓':defer?'↷':blk?'!':(i+1)}</span><div class="orq-objbody">${locked?`<span class="orq-objt">${esc(o)}</span>${ev?`<span class="orq-objev mono">${esc(String(ev).split('/').pop())}</span>`:''}${(defer||blk)&&m[i].note?`<span class="orq-objnote">${defer?'adiado':'bloqueado'}: ${esc(String(m[i].note).slice(0,220))}</span>`:''}`:`<textarea class="orq-objin" data-orqobj="${i}" rows="2">${esc(o)}</textarea>`}</div>${locked?'':`<button class="orq-x" data-orqrm="${i}" title="remover">${IC.x}</button>`}</div>`; }).join('');
  const others=p.phases.filter(x=>x.key!==ph.key);
  const deps=locked?`<div class="orq-p dim">${(ph.dependsOn||[]).length?(ph.dependsOn||[]).map(k=>{ const d=p.phases.find(x=>x.key===k); return d?`<span class="orq-depchip" style="--c:${orqColor(d.kind)}">${orqBadge(d.kind)} ${esc(d.name)}</span>`:''; }).join(''):'roda em paralelo, sem depender de ninguém'}</div>`
    :`<div class="orq-deps">${others.map(o=>`<label class="orq-dep${(ph.dependsOn||[]).includes(o.key)?' on':''}"><input type="checkbox" data-orqdep="${escA(o.key)}" ${(ph.dependsOn||[]).includes(o.key)?'checked':''}><span class="orq-badge" style="--c:${orqColor(o.kind)}">${orqBadge(o.kind)}</span>${esc(o.name)}</label>`).join('')||'<span class="dim">só esta fase no plano</span>'}</div>`;
  const waiting=p.phases.filter(x=>(x.dependsOn||[]).includes(ph.key));
  const term=t?orqLastLines(t.id,8):[];
  return `<div class="orq-ih"><span class="orq-badge" style="--c:${orqColor(ph.kind)}">${orqBadge(ph.kind)}</span><div style="min-width:0;flex:1"><b>${locked?esc(ph.name):`<input class="orq-namein" id="orqName" value="${escA(ph.name)}">`}</b><div class="orq-meta mono"><span style="color:${st.color}">${esc(st.label)}</span><span class="dim">· ${esc(ph.agent)}</span></div></div>${t?`<button class="as-btn sm" data-orqtask="${escA(t.id)}">abrir tarefa ↗</button>`:''}</div>
    ${locked&&t&&t.branch?`<div class="orq-branch mono" title="${escA(t.branch)}">${esc(t.branch)}</div>`:''}
    ${orqIsIntegration(p, ph)?(()=>{ const src=orqIntegrationSources(p, ph); const r=ph.integration; return `<div class="orq-integ"><b>fase de integração</b> · branch a partir da main com o merge de ${src.map(x=>`<span class="orq-depchip" style="--c:${orqColor('build')}">IM ${esc(x.d.name)}</span>`).join('')} — testa tudo junto e o PR final sai daqui${r?(r.conflicts&&r.conflicts.length?`<div class="orq-integwarn">${IC.warn} conflito de merge deixado pro agente resolver: ${esc(r.conflicts.join(' · '))}</div>`:`<div class="dim" style="margin-top:4px">${(r.merged||[]).length} merge(s) feitos${(r.skipped||[]).length?` · ${(r.skipped||[]).length} já contida(s)/ignorada(s)`:''}</div>`):''}</div>`; })():''}
    ${locked?`<p class="orq-p">${esc(ph.objective)}</p>`:`<textarea class="orq-objta" id="orqObjective" placeholder="o que essa fase entrega">${esc(ph.objective)}</textarea>
    <div class="orq-kindrow">${Object.entries(ORQ_KINDS).map(([k,v])=>`<button class="orq-kind${ph.kind===k?' on':''}" data-orqkind="${k}" style="--c:${v.color}">${v.label}</button>`).join('')}</div>`}
    <div class="ndeyebrow" style="margin-top:14px">objetivos <span class="dim" style="text-transform:none;letter-spacing:0">${locked?'· provados com evidência pelo subagente':'· edite, marque ou adicione'}</span></div>
    <div class="orq-objs">${objs||'<span class="dim">sem objetivos ainda</span>'}</div>
    ${t&&!orqProved(t)&&['review','asking','error'].includes(st.key)&&p.phases.some(x=>(x.dependsOn||[]).includes(ph.key))?`<div class="orq-release"><span>Nem tudo está provado, então as fases que dependem desta continuam esperando.</span><button class="as-btn sm" id="orqRelease">liberar as próximas fases mesmo assim</button></div>`:''}
    ${ph.released?`<div class="orq-release ok"><span>Liberada por você — as próximas fases seguem sem esperar as provas que faltam.</span><button class="as-btn sm" id="orqUnrelease">desfazer</button></div>`:''}
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
  return `<div class="orq-ih"><span class="orq-badge" style="--c:var(--accent)">+</span><div><b>Novo subagente</b><div class="mono dim" style="font-size:var(--fs-xs)">entra no grafo já na coluna certa</div></div></div>
    <div class="ndeyebrow">nome da fase</div><input class="orq-namein" id="orqAddName" placeholder="ex.: Escrever testes de carga">
    <div class="ndeyebrow" style="margin-top:12px">o que ela entrega</div><textarea class="orq-objta" id="orqAddObj" placeholder="1-2 frases"></textarea>
    <div class="ndeyebrow" style="margin-top:12px">tipo / agente</div><div class="orq-kindrow" id="orqAddKinds">${Object.entries(ORQ_KINDS).map(([k,v])=>`<button class="orq-kind${k==='build'?' on':''}" data-k="${k}" style="--c:${v.color}">${v.label}</button>`).join('')}</div>
    <div class="ndeyebrow" style="margin-top:12px">quando roda</div>
    <div class="orq-auto"><button class="on" data-orqwhen="par">em paralelo</button><button data-orqwhen="after">depois de…</button></div>
    <div class="orq-deps" id="orqAddDeps" style="display:none">${p.phases.map(o=>`<label class="orq-dep"><input type="checkbox" value="${escA(o.key)}"><span class="orq-badge" style="--c:${orqColor(o.kind)}">${orqBadge(o.kind)}</span>${esc(o.name)}</label>`).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:18px"><button class="as-btn" id="orqAddCancel">cancelar</button><button class="as-btn primary" id="orqAddOk">adicionar ao plano</button></div>`;
}
function orqSave(pl){ pl=pl||orq.plan; if(pl){ if(!pl.repo) pl.repo=state.repo||''; invoke('orch_save',{ id:pl.id, data:pl, repo:pl.repo||null }).catch(()=>{}); } } // pl: o plano capturado por quem começou (async) — não o da aba na tela
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
          catch(e){ showErr(e, 'Fase adicionada ao plano, mas não consegui criar a tarefa'); } })();
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
  body.querySelectorAll('[data-orqdep]').forEach(i=>i.onchange=()=>{ const k=i.dataset.orqdep; ph.dependsOn=(ph.dependsOn||[]).filter(x=>x!==k); if(i.checked){ if(orqWouldCycle(ph.key,k)){ toast('Isso criaria um ciclo de dependência.','warn'); i.checked=false; return; } ph.dependsOn.push(k); } orqSave(); orqRender(); });
  bindClick('orqRelease', ()=>{ ph.released=true; ph.releasedAt=Date.now(); orqSave(); orqRender(); orqTick().catch(()=>{}); });
  bindClick('orqUnrelease', ()=>{ delete ph.released; orqSave(); orqRender(); });
  bindClick('orqRmPhase', async()=>{ if(!await askYes('Remover a fase "'+ph.name+'" do plano?')) return; p.phases=p.phases.filter(x=>x!==ph); p.phases.forEach(x=>{ x.dependsOn=(x.dependsOn||[]).filter(k=>k!==ph.key); }); orq.sel=p.phases[0]?p.phases[0].key:'__orq'; orqSave(); orqRender(); });
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
// ---- integração: a revisão que fecha fases de build vira a branch onde tudo é mergeado e testado junto ----
function orqIntegrationSources(p, ph){
  const byKey=Object.fromEntries(p.phases.map(x=>[x.key,x]));
  const seen=new Set(); const out=[];
  const walk=k=>{ const d=byKey[k]; if(!d||seen.has(k)) return; seen.add(k); if(d.kind==='build') out.push({ d, t:orqTaskOf(d)||(state.tasks||[]).find(t=>t.id===d.taskId) }); (d.dependsOn||[]).forEach(walk); };
  (ph.dependsOn||[]).forEach(walk);
  return out;
}
function orqIsIntegration(p, ph){
  if(ph.kind!=='review') return false;
  if(p.phases.some(x=>(x.dependsOn||[]).includes(ph.key)&&x.kind==='build')) return false; // não é a última
  return orqIntegrationSources(p, ph).length>0;
}
function orqHasIntegration(p){ return p.phases.some(x=>orqIsIntegration(p, x)); }
async function orqCreatePhaseTask(p, ph, created){
  const byKey=Object.fromEntries(p.phases.map(x=>[x.key,x]));
  const kd=ORQ_KINDS[ph.kind]||ORQ_KINDS.build; const deps=(ph.dependsOn||[]).map(k=>byKey[k]).filter(Boolean);
  const depTxt=deps.length?`\n\nDEPENDE DE: ${deps.map(d=>`"${d.name}" (tarefa ${created[d.key]||d.taskId||d.key})`).join(', ')}. ANTES de começar, leia o que essas fases entregaram: .cardume/artifacts/<id-da-tarefa>/ (INVESTIGATION.md, DESIGN.md, REVIEW.md, requirements.json, provas) e os commits da branch delas. Sua worktree já parte da branch da fase anterior quando há código.`:'';
  const ctx=`\n\n[PLANO DO ORQUESTRADOR "${p.title}" — fase ${ph.key} de ${p.phases.length}: ${ph.name} (${kd.label})]\nProblema original: ${(p.briefing||'').slice(0,1500)}\nResumo do plano: ${p.summary||''}${depTxt}\nFases irmãs rodam em paralelo em branches próprias — NÃO toque em arquivos fora do escopo desta fase.`;
  const depTasks=deps.map(d=>({ d, t:(state.tasks||[]).find(t=>t.id===(created[d.key]||d.taskId)) })).filter(x=>x.t);
  const buildDep=depTasks.filter(x=>['build','review'].includes(x.d.kind)).map(x=>x.t).slice(-1)[0];
  // fase de INTEGRAÇÃO: revisão que fecha fases de build — branch própria a partir da main,
  // recebe o merge de todas as branches de build (orch_integrate na largada), testa tudo junto
  // e o PR sai dela. As fases de build NÃO abrem PR próprio.
  const integrate=orqIsIntegration(p, ph);
  const intBranches=integrate?orqIntegrationSources(p, ph).map(x=>x.t&&x.t.branch).filter(Boolean):[];
  const intTxt=integrate?`\n\nESTA É A FASE DE INTEGRAÇÃO: sua branch nasceu da main e recebeu o MERGE das branches das fases de build (${intBranches.join(', ')||'ver commits de merge'}). Se houver CONFLITO de merge pendente na worktree (git status), resolva-o PRIMEIRO e complete os merges que faltarem (git merge --no-ff <branch>). Depois rode o projeto e os testes com TUDO junto, corrija problemas de integração e prove na UI real. O Pull Request final sai DESTA branch — com todos os merges.`:'';
  // começa já se não depende de ninguém OU se todas as dependências já provaram (plano em andamento)
  const startNow=deps.length===0 || (p.status!=='planned' && deps.every(d=>orqProved((state.tasks||[]).find(t=>t.id===(created[d.key]||d.taskId)))));
  const payload={ start:startNow, title:ph.name, workflow:null, agents:orqAgentIdFor(ph), engine:p.engine||defaultAiEngine(), model:p.model||null, approval:ph.autonomy==='ask'?'ask':'auto',
    owns:null, off:null, objective:(ph.objective||ph.name)+ctx+intTxt, deliverables:[], requirements:(ph.objectives||[]).slice(), doc:kd.doc,
    proof:ph.kind==='build'||ph.kind==='review', tests:ph.kind==='build'||integrate, planApproval:'auto', refs:[], branchType:integrate?'integration':kd.branch, issue:null,
    autoPr:integrate?'ask':(ph.kind==='build'&&!orqHasIntegration(p)?'ask':'no'), prBase:null, base:integrate?null:(buildDep&&buildDep.branch?buildDep.branch:null) };
  const id=await invoke('new_task', await trkBeforeNewTask(payload));
  created[ph.key]=id; ph.taskId=id; ph.startedAt=startNow?Date.now():null;
  await refresh();
  const depIds=deps.map(d=>created[d.key]||d.taskId).filter(Boolean);
  await invoke('patch_task_spec',{ taskId:id, patch:{ orchestration:{ id:p.id, title:p.title, phase:ph.key, name:ph.name }, dependsOn:depIds, dependents:[] }, base:null }).catch(e=>console.error('patch_task_spec',e));
  return id;
}
async function orqApprove(){
  const o=orq, p=o.plan; if(!p||o.busy) return; // `o`: o estado desta aba (ver orqPlanNow)
  // as tarefas nascem no projeto ATIVO — se o plano é de outro repo, trocar antes (senão as fases iriam pro lugar errado)
  if(p.repo && state.repo && p.repo!==state.repo){ toast('Este plano é do projeto '+pathBase(p.repo)+' — o projeto ativo agora é '+pathBase(state.repo)+'. Troque pro projeto do plano antes de aprovar, senão as tarefas seriam criadas no repositório errado.','warn'); return; }
  const bad=p.phases.filter(x=>!(x.objectives||[]).length);
  if(bad.length && !await askYes(`${bad.length} fase(s) sem objetivos verificáveis (${bad.map(x=>x.name).join(', ')}). Criar mesmo assim? Sem objetivos, a fase seguinte começa assim que esta entregar.`)) return;
  o.busy=true; orqRender();
  const order=orqTopo(p.phases); const created={}; p.phases.forEach(x=>{ if(x.taskId) created[x.key]=x.taskId; });
  try{
    for(const ph of order){ if(ph.taskId) continue; await orqCreatePhaseTask(p, ph, created); }
    // segunda passada: grava no spec de cada tarefa quem a criou e de quem depende
    for(const ph of p.phases){ const depIds=(ph.dependsOn||[]).map(k=>created[k]).filter(Boolean); const waitIds=p.phases.filter(x=>(x.dependsOn||[]).includes(ph.key)).map(x=>created[x.key]).filter(Boolean);
      await invoke('patch_task_spec',{ taskId:ph.taskId, patch:{ orchestration:{ id:p.id, title:p.title, phase:ph.key, name:ph.name }, dependsOn:depIds, dependents:waitIds }, base:null }).catch(e=>console.error('patch_task_spec',e)); }
    p.status='running'; p.approvedAt=Date.now(); orqSave(p); orqListAt=0;
    lastSig=''; await refresh();
  }catch(e){ showErr(e, 'Falha ao criar as tarefas do plano'); p.status=Object.values(created).length?'running':'planned'; orqSave(p); }
  o.busy=false; if(orq===o) orqRender();
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
      // relê as provas de QUALQUER dependência viva (não só review/delivered): a fase pode ter terminado
      // e ficado parada numa pergunta ao humano em 'thinking' — sem isto a próxima nunca começava
      for(const d of deps){ const dt=orqTaskOf(d); if(dt && ['review','delivered','thinking','running','queued','error','aborted','conflict'].includes(dt.status)){ try{ await loadReqProofs(dt.id); orqProofAt[dt.id]=Date.now(); }catch(_){ } } }
      if(!deps.every(d=>orqProved(orqTaskOf(d)))) continue;
      try{
        if(orqIsIntegration(live, ph)){
          // largada da integração: merge das branches de build na worktree (nascida da main)
          const branches=orqIntegrationSources(live, ph).map(x=>x.t&&x.t.branch).filter(Boolean);
          try{ const r=await invoke('orch_integrate',{ taskId:t.id, branches }); ph.integration=r; if(r&&r.conflicts&&r.conflicts.length) console.warn('orquestrador: conflito na integração', r.conflicts); }
          catch(e){ console.error('orquestrador: integrate', ph.key, e); }
        } else { await invoke('orch_sync_base',{ taskId:t.id }).catch(()=>{}); }
        await invoke('start_task',{ taskId:t.id }); ph.startedAt=Date.now(); changed=true; }
      catch(e){ console.error('orquestrador: start', ph.key, e); }
    }
    // o plano só fecha quando TODAS as tarefas de fato entregaram (parada numa pergunta ainda não conta)
    if(live.phases.every(ph=>{ const t=orqTaskOf(ph); return orqPhaseState(ph).key==='done' && t && (t.flag==='closed'||['merged','done','review','delivered'].includes(t.status)); })){ live.status='done'; live.doneAt=Date.now(); changed=true; }
    if(changed){ invoke('orch_save',{ id:live.id, data:live, repo:live.repo||null }).catch(()=>{}); if(live!==p) Object.assign(p, live); lastSig=''; }
  }
  if(orqOpen()&&orq.step==='plan'&&orq.plan&&orq.plan.status!=='planned'&&!orqDrag&&Date.now()>=uiHoldUntil&&!document.activeElement.closest?.('#orqInsp input, #orqInsp textarea')) orqRender();
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
    +(deps.length?`<span class="mono dim" style="font-size:var(--fs-xs)">depende de</span>${deps.map(d=>`<button class="btn sm orq-chipbtn" data-orqt="${escA(d.id)}" title="${escA(d.title)}">${esc(d.title.slice(0,22))} ${orqProved(d)?'✓':'…'}</button>`).join('')}`:'')
    +(waits.length?`<span class="mono dim" style="font-size:var(--fs-xs)">esperam por ela</span>${waits.map(d=>`<button class="btn sm orq-chipbtn" data-orqt="${escA(d.id)}" title="${escA(d.title)}">${esc(d.title.slice(0,22))}</button>`).join('')}`:'');
  el.querySelectorAll('[data-orqt]').forEach(b=>b.onclick=()=>openWorkspace(b.dataset.orqt));
  el.querySelectorAll('[data-orqgraph]').forEach(b=>b.onclick=async()=>{ if(!orq.list) await orqLoadList(); const p=(orq.list||[]).find(x=>x.id===b.dataset.orqgraph); if(p){ orq.plan=p; orq.step='plan'; orq.sel=(p.phases.find(x=>x.taskId===t.id)||{}).key||'__orq'; } if(window.openTab) window.openTab('orq'); });
}
window.openOrq=orqShow; window.orqTaskChips=orqTaskChips;
bindClick('orqClose', ()=>{ $id('orqOverlay').style.display='none'; if(window.closeTabOfKind) window.closeTabOfKind('orq'); });
