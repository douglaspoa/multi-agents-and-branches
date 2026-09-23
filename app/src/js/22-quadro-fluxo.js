// Constellation — 22-quadro-fluxo
// ----- filtros do Fluxo (status · período · agente · busca) -----
let flowStatus = 'all';   // all | active | review | merged | error
let projFilter = lsGet('projFilter')||'all'; // 'all' (integrado) | caminho de um projeto
let allTasksCache = [];   // tarefas de TODOS os projetos (list_all_tasks), pro board integrado
let allTasksSig = '';
let allTasksAt = 0;       // throttle: list_all_tasks abre o sqlite de CADA projeto (I/O)
function projShort(p){ return String(p||'').split('/').filter(Boolean).slice(-1)[0]||''; }
// lista [caminho, nome] dos projetos conhecidos (ativo + os do cache multi-projeto)
function projList(){ const m=new Map(); if(state.repo) m.set(state.repo, projShort(state.repo)); (allTasksCache||[]).forEach(t=>{ if(t.repo) m.set(t.repo, t.proj||projShort(t.repo)); }); return [...m.entries()]; }
function projColor(p){ // cor estável por projeto (hash → hue)
  let h=0; const s=String(p||''); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0;
  const hues=[145,210,265,32,190,330,95]; return `hsl(${hues[h%hues.length]} 62% 60%)`;
}
// normaliza uma tarefa agregada (de outro projeto) pro formato que o board espera
function normAgg(t){ return Object.assign({}, t, { created_at: t.createdAt, roles: [], _cross: true }); }
// fonte de tarefas do board conforme o filtro de projeto
function boardSource(){
  const cur=(state.tasks||[]).map(t=>Object.assign({}, t, { repo: state.repo, proj: projShort(state.repo) }));
  if(projFilter && projFilter!=='all'){
    if(projFilter===state.repo) return cur;
    return (allTasksCache||[]).filter(t=>t.repo===projFilter).map(normAgg);
  }
  const others=(allTasksCache||[]).filter(t=>t.repo!==state.repo).map(normAgg);
  return cur.concat(others);
}
async function loadAllTasks(force){
  // throttle: abre o state.sqlite de CADA projeto — rodar a cada 1s (com 48 agentes
  // escrevendo) fazia o board recarregar sem parar e "comer" o clique. A cada ~4s basta.
  if(!force && Date.now()-allTasksAt < 4000) return;
  allTasksAt=Date.now();
  try{ const r=await invoke('list_all_tasks'); const sig=r.map(t=>t.id+':'+t.status+':'+(t.sortOrder??'')).join(','); if(sig!==allTasksSig){ allTasksSig=sig; allTasksCache=r;
    // NÃO re-renderiza o Fluxo direto aqui: isso pulava o guard de clique (uiHoldUntil)
    // e destruía o card entre mousedown/mouseup. Marca sujo e deixa o refresh (guardado)
    // aplicar no próximo tick, respeitando o clique em andamento.
    if(curView&&curView()==='flow') lastSig='';
  } }catch(_){}
}
// popula o seletor "projeto" da nova demanda; trocar ali muda o projeto-alvo
function ntFillProjects(){
  const sel=$id('ntProj'); if(!sel) return;
  let list=(window.projectsList&&window.projectsList())||[];
  if(!list.length) list=projList().map(([path,name])=>({path,name}));
  if(!list.length && state.repo) list=[{path:state.repo,name:projShort(state.repo)}];
  sel.innerHTML=list.map(p=>`<option value="${escA(p.path)}"${p.path===state.repo?' selected':''}>${esc(p.name||projShort(p.path))}</option>`).join('');
  sel.onchange=async()=>{ const p=sel.value; if(p && p!==state.repo && window.switchProject) await window.switchProject(p); };
}
// clicar numa tarefa de OUTRO projeto → troca pra ele e abre a tarefa
async function switchToProjectTask(repo, id){
  try{ if(window.switchProject) await window.switchProject(repo); }catch(_){}
  selected=id; try{ lsSet('sel:'+repo, id); }catch(_){}
  const t=(state.tasks||[]).find(x=>x.id===id); render(); if(t) openOrEdit(t);
}
// abre uma demanda clicada no board — do projeto ATUAL ou de OUTRO (card agregado).
// usa boardSource() (a MESMA lista que renderizou o card) como fonte de verdade: assim
// a tarefa é sempre encontrada, com o flag _cross/repo pra saber se precisa trocar de
// projeto. Antes buscava em state.tasks/allTasksCache e às vezes não achava → clique morto.
function openTaskById(id){
  let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); }
  const t=src.find(x=>x.id===id); if(!t) return;
  if(t._cross && t.repo && t.repo!==state.repo){ switchToProjectTask(t.repo, id); return; }
  selected=id; render(); openOrEdit(t);
}
let flowPeriod = 'all';   // all | today | week
let flowAgent  = 'all';   // 'all' | nome do agente
let flowType   = 'all';   // all | build | design | invest | fix | review
let flowQuery  = '';      // busca por nome da tarefa
let flowGroupBy= 'none';  // none | day
let flowShowBlocked=false, flowShowClosed=false; // por padrão, escondidas do Fluxo
function dayLabel(ts){
  const d=new Date(ts), today=new Date(), y=new Date(); y.setDate(today.getDate()-1);
  const same=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  if(same(d,today)) return 'Hoje';
  if(same(d,y)) return 'Ontem';
  return d.toLocaleDateString('pt-BR',{ day:'2-digit', month:'short', ...(d.getFullYear()!==today.getFullYear()?{year:'numeric'}:{}) });
}
const STATUS_GROUP = { draft:'draft', 'plan-review':'review', running:'active', thinking:'active', queued:'active', paused:'active', review:'review', merged:'merged', done:'merged', error:'error', conflict:'error', aborted:'error' };
function taskGroup(t){ return STATUS_GROUP[t.status] || 'other'; }
function inPeriod(t){
  if(flowPeriod==='all') return true;
  const now=Date.now(), d=new Date();
  if(flowPeriod==='today'){ return t.created_at >= new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); }
  if(flowPeriod==='week'){ return t.created_at >= now-7*864e5; }
  if(flowPeriod==='month'){ return t.created_at >= now-30*864e5; }
  return true;
}
// agentes de uma tarefa = líder + toda a equipe (papéis) — assim o filtro cobre "agente" e "equipe"
function taskAgents(t){ const s=new Set((t.roles||[]).map(r=>r.name)); if(t.agent) s.add(t.agent); return [...s]; }
function notHidden(t){ return (t.flag!=='blocked'||flowShowBlocked) && (t.flag!=='closed'||flowShowClosed); }
// tipo da tarefa, derivado do kind/prefixo da branch
function taskType(t){
  if(t.kind==='review') return 'review';
  const b=t.branch||'';
  if(b.startsWith('design/')) return 'design';
  if(b.startsWith('invest/')) return 'invest';
  if(b.startsWith('fix/')) return 'fix';
  if(b.startsWith('docs/')) return 'docs';
  if(b.startsWith('chore/')) return 'chore';
  if(b.startsWith('refactor/')) return 'refactor';
  if(b.startsWith('perf/')) return 'perf';
  // rascunho ainda sem branch: usa o branchType da spec
  const bt=(t.branchType||(t.spec&&t.spec.branchType)||'').toLowerCase();
  if(['fix','docs','chore','refactor','perf','design'].includes(bt)) return bt;
  return 'feat';
}
const TYPE_PT={ feat:'Feature', fix:'Fix', docs:'Docs', chore:'Chore', refactor:'Refactor', perf:'Perf', design:'Design', invest:'Investigação', review:'Review', build:'Entrega' };
const TYPE_COLOR={ feat:'var(--accent)', fix:'var(--crit)', docs:'var(--info)', chore:'var(--muted)', refactor:'var(--warn)', perf:'#c99cdb', design:'#7cd0b8', invest:'var(--warn)', review:'var(--info)' };
const TYPE_ORDER=['feat','fix','docs','refactor','perf','chore','design','invest','review'];
// código da issue (FND-853) direto da branch; link usa a base configurada em ⚙
function issueCodeOf(t){ const m=((t.branch||'')+' '+(t.title||'')).match(/\b([A-Z]{2,10}-\d+)\b/); return m?m[1]:null; }
function issueUrlOf(t){ const c=issueCodeOf(t); const b=(lsGet('issueBase')||'').trim(); return (c&&b)?(b.replace(/\/+$/,'')+'/'+c):null; }
function linkChips(t, small){
  const cls=small?'btn sm':'btn sm';
  let h='';
  if(t.prUrl) h+=`<button class="${cls}" data-lk="${escA(t.prUrl)}" title="abrir o Pull Request" style="padding:3px 9px;font-size:10.5px;color:var(--accent)">PR ↗</button>`;
  const iu=t.issueUrl||issueUrlOf(t), ic=issueCodeOf(t);
  if(iu) h+=`<button class="${cls} mono" data-lk="${escA(iu)}" title="abrir a issue" style="padding:3px 9px;font-size:10.5px">${esc(ic||'issue')} ↗</button>`;
  else if(ic) h+=`<button class="${cls} mono" data-lkcfg="1" title="configure a URL base das issues em ⚙ pra este código virar link" style="padding:3px 9px;font-size:10.5px;color:var(--muted)">${esc(ic)}</button>`;
  return h;
}
function wireLinkChips(root){
  root.querySelectorAll('[data-lk]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); openExternal(b.dataset.lk); }; });
  root.querySelectorAll('[data-lkcfg]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); openCfg(); }; });
}
let flowScope=(lsGet('flowScope')==='done')?'done':'exec';   // all | mine | done (abas da Central)
let ffAdvOpen=false;                        // filtros avançados recolhidos por padrão
let flowLastHtml=null;                      // último HTML do flow — pula rebuild idêntico (evita piscar no hover)
// Execução = o que está vivo (rascunho, rodando, review, PR aberto); Concluídas = mergeadas/encerradas.
// Uma tarefa ENCERRADA (flag closed) mora em Concluídas mesmo que o status seja review/erro.
function flowScopeOk(t){
  return flowScope==='done'
    ? (t.flag==='closed'||['merged','done'].includes(t.status))
    : (notHidden(t) && !(t.flag==='closed'||['merged','done'].includes(t.status)));
}
function flowVisible(tasks){
  const q=flowQuery.trim().toLowerCase();
  return tasks.filter(t=>
    flowScopeOk(t) &&
    (flowStatus==='all'||taskGroup(t)===flowStatus) &&
    (flowType==='all'||taskType(t)===flowType) &&
    inPeriod(t) &&
    (flowAgent==='all'||taskAgents(t).includes(flowAgent)) &&
    (!q || (t.title||'').toLowerCase().includes(q))
  );
}
function renderFlowFilters(){
  const el=$id('flowFilters'); if(!el) return;
  // preserva foco/caret da busca (o poll pode re-renderizar durante digitação)
  const ae=document.activeElement, wasSearch=ae&&ae.id==='ffSearch', caret=wasSearch?ae.selectionStart:0;
  // os chips contam SÓ o que a aba atual (Execução/Concluídas) mostra — senão "Review 29" aparece
  // com a lista vazia porque as 29 estão encerradas (moram em Concluídas)
  let srcAll; try{ srcAll=boardSource(); }catch(_){ srcAll=(state.tasks||[]); }
  const byPeriod=srcAll.filter(t=>inPeriod(t)&&flowScopeOk(t));
  const count=g=> g==='all'?byPeriod.length:byPeriod.filter(t=>taskGroup(t)===g).length;
  const ST=[['all','Todas',null],['draft','Rascunho','var(--muted)'],['active','Rodando','var(--good)'],['review','Review','var(--warn)'],['merged','Merged','var(--info)'],['error','Erro','var(--crit)']]
    .filter(([k])=>k==='all'||k===flowStatus||count(k)>0);
  if(flowStatus!=='all' && count(flowStatus)===0 && !ST.some(([k])=>k===flowStatus)) flowStatus='all';
  let stChips=ST.map(([k,label,col])=>`<button class="fchip${flowStatus===k?' on':''}" data-st="${k}">${col?`<span class="dot" style="background:${col}"></span>`:''}${label}<span class="n">${count(k)}</span></button>`).join('');
  // bloqueadas: escondidas por padrão em Execução (toggle); encerradas moram em Concluídas
  const nBlocked=flowScope==='done'?0:srcAll.filter(t=>t.flag==='blocked'&&inPeriod(t)&&!(t.flag==='closed'||['merged','done'].includes(t.status))).length;
  if(nBlocked) stChips+=`<button class="fchip flagchip${flowShowBlocked?' on':''}" data-flag="blocked" title="mostrar/ocultar bloqueadas">${IC.pause} Bloqueadas<span class="n">${nBlocked}</span></button>`;
  flowShowClosed=false;
  const PE=[['all','Todo período'],['today','Hoje'],['week','Últimos 7 dias'],['month','Últimos 30 dias']];
  const peOpts=PE.map(([k,label])=>`<option value="${k}"${flowPeriod===k?' selected':''}>${label}</option>`).join('');
  const agents=[...new Set((state.tasks||[]).flatMap(taskAgents))].sort((a,b)=>a.localeCompare(b));
  if(flowAgent!=='all' && !agents.includes(flowAgent)) flowAgent='all';
  const agOpts=['all',...agents].map(a=>`<option value="${escA(a)}"${flowAgent===a?' selected':''}>${a==='all'?'Todos os agentes':esc(a)}</option>`).join('');
  const tyCount=k=>byPeriod.filter(t=>taskType(t)===k).length;
  const tyOpts=[['all','Todos os tipos']].concat(TYPE_ORDER.filter(k=>tyCount(k)>0).map(k=>[k, TYPE_PT[k]+' ('+tyCount(k)+')']))
    .map(([k,l])=>`<option value="${k}"${flowType===k?' selected':''}>${l}</option>`).join('');
  // abas da Central: Execução (o que está vivo) · Concluídas (portfólio) · Time (espaço próprio)
  if(flowScope!=='done') flowScope='exec';
  const TABS=[['exec','Execução'],['done','Concluídas'],['team','Time']];
  const tabsHtml=`<div class="ftabs">`+
    TABS.map(([k,l])=>`<button class="ft${(k!=='team'&&flowScope===k)?' on':''}" data-ftab="${k}">${l}</button>`).join('')+
    `<span class="grow"></span>`+
    `<button class="fvic${ffAdvOpen?' on':''}" id="ffMore" title="filtros avançados"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4.5h11M4.5 8h7M6.8 11.5h2.4" stroke-linecap="round"/></svg></button>`+
    `<span class="fvsep"></span>`+
    `<button class="fvic${flowView==='list'?' on':''}" data-fv="list" title="Fluxo em lista"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h10" stroke-linecap="round"/></svg></button>`+
    `<button class="fvic${flowView==='grid'?' on':''}" data-fv="grid" title="Fluxo em grade"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="4.4" height="4.4" rx="1"/><rect x="8.6" y="3" width="4.4" height="4.4" rx="1"/><rect x="3" y="8.6" width="4.4" height="4.4" rx="1"/><rect x="8.6" y="8.6" width="4.4" height="4.4" rx="1"/></svg></button>`+
    `<button class="fvic" data-view="kanban" title="Kanban"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3" width="3.4" height="10" rx="1"/><rect x="6.9" y="3" width="3.4" height="6.5" rx="1"/><rect x="11.3" y="3" width="3.4" height="8.4" rx="1"/></svg></button>`+
    `</div>`;
  // SEMPRE visível: status (review/rodando/merged/…) + tipo — é o que mais se filtra
  const isDone=flowScope==='done';
  const filterRow=`<div class="ffrow" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">`+
    (isDone?`<select class="sel" id="ffPeriod2">${peOpts}</select><button class="btn sm" id="flowPeriodRep" title="a IA escreve um relatório com todas as entregas concluídas deste filtro">${ic('doc')}relatório do período</button>`:`<div class="ffchips">${stChips}</div>`)+
    `<span style="flex:1"></span>`+
    // busca por nome SEMPRE visível (antes ficava escondida nos filtros avançados)
    `<div class="ffsearchwrap"><svg class="ffic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4L14 14" stroke-linecap="round"/></svg>`+
    `<input class="ffsearch" id="ffSearch" type="text" placeholder="buscar tarefa pelo nome…" value="${escA(flowQuery)}"></div>`+
    `<select class="sel" id="ffType" title="filtrar por tipo (feature/fix/docs/investigação…)">${tyOpts}</select></div>`;
  // AVANÇADO (toggle): período, agente, agrupar
  const advHtml=`<div class="ffadv" style="display:${ffAdvOpen?'flex':'none'};flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">`+
    `<select class="sel" id="ffPeriod">${peOpts}</select>`+
    `<select class="sel" id="ffAgent">${agOpts}</select>`+
    `<select class="sel" id="ffGroup"><option value="none"${flowGroupBy==='none'?' selected':''}>Sem agrupar</option><option value="day"${flowGroupBy==='day'?' selected':''}>Por dia</option></select></div>`;
  // chips de PROJETO (multi-projeto integrado) — só quando há mais de um
  const pl=projList();
  const projChips = pl.length>1 ? `<div class="pfrow">`+
    `<button class="pfchip${projFilter==='all'?' on':''}" data-pf="all">Todos os projetos</button>`+
    pl.map(([path,name])=>`<button class="pfchip${projFilter===path?' on':''}" data-pf="${escA(path)}"><span class="pfd" style="background:${projColor(path)}"></span>${esc(name)}</button>`).join('')+
    `</div>` : '';
  el.innerHTML = tabsHtml + projChips + filterRow + advHtml;
  el.querySelectorAll('[data-pf]').forEach(b=>b.onclick=()=>{ projFilter=b.dataset.pf; lsSet('projFilter',projFilter); lastSig=''; renderFlow(); });
  el.querySelectorAll('[data-ftab]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.ftab;
    if(k==='team'){ tmView='people'; lsSet('tmView','people'); teamPaintSig=''; setView('team'); return; } // PDF p7: time por PESSOA
    flowScope=k; lsSet('flowScope',k); lastSig=''; renderFlow();
  });
  el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  el.querySelectorAll('[data-fv]').forEach(b=>b.onclick=()=>{ flowView=b.dataset.fv; lsSet('flowView',flowView); if(curView()!=='flow') setView('flow'); lastSig=''; renderFlow(); });
  { const b=el.querySelector('#ffMore'); if(b) b.onclick=()=>{ ffAdvOpen=!ffAdvOpen; lastSig=''; renderFlow(); }; }
  el.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{ flowStatus=b.dataset.st; lastSig=''; renderFlow(); });
  el.querySelectorAll('[data-flag]').forEach(b=>b.onclick=()=>{ if(b.dataset.flag==='blocked') flowShowBlocked=!flowShowBlocked; else flowShowClosed=!flowShowClosed; lastSig=''; renderFlow(); });
  $id('ffType').onchange=(e)=>{ flowType=e.target.value; lastSig=''; renderFlow(); };
  $id('ffPeriod').onchange=(e)=>{ flowPeriod=e.target.value; lastSig=''; renderFlow(); };
  { const p2=$id('ffPeriod2'); if(p2) p2.onchange=(e)=>{ flowPeriod=e.target.value; lastSig=''; renderFlow(); }; }
  bindClick('flowPeriodRep', periodReport);
  $id('ffAgent').onchange=(e)=>{ flowAgent=e.target.value; lastSig=''; renderFlow(); };
  $id('ffGroup').onchange=(e)=>{ flowGroupBy=e.target.value; lastSig=''; renderFlow(); };
  const s=$id('ffSearch');
  s.oninput=(e)=>{ flowQuery=e.target.value; lastSig=''; renderFlow(); };
  if(wasSearch){ s.focus(); try{ s.setSelectionRange(caret,caret); }catch(e){} }
}
// barra de navegação NOVA nas demais vistas (Kanban/Grafo/Atividade/Time) —
// mesma linguagem da home; o seg2 antigo não aparece mais em lugar nenhum
function renderNavTabs(v){
  const el=$id('navTabs'); if(!el) return;
  if(el.dataset.sig===('nav:'+v)) return; el.dataset.sig='nav:'+v;
  el.innerHTML=`<div class="ftabs">
    <button class="ft" data-nv-scope="exec">Execução</button>
    <button class="ft" data-nv-scope="done">Concluídas</button>
    <button class="ft${v==='team'?' on':''}" data-nv-team>Time</button>
    <span class="grow"></span>
    <button class="fvic${v==='flow'?' on':''}" data-nv-view="flow" title="Fluxo (lista)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h10" stroke-linecap="round"/></svg></button>
    <button class="fvic${v==='kanban'?' on':''}" data-nv-view="kanban" title="Kanban"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3" width="3.4" height="10" rx="1"/><rect x="6.9" y="3" width="3.4" height="6.5" rx="1"/><rect x="11.3" y="3" width="3.4" height="8.4" rx="1"/></svg></button>
  </div>`;
  el.querySelectorAll('[data-nv-scope]').forEach(b=>b.onclick=()=>{ flowScope=b.dataset.nvScope; lsSet('flowScope',flowScope); lastSig=''; setView('flow'); });
  { const b=el.querySelector('[data-nv-team]'); if(b) b.onclick=()=>{ if(v==='team') return; tmView='people'; lsSet('tmView','people'); teamPaintSig=''; setView('team'); }; }
  el.querySelectorAll('[data-nv-view]').forEach(b=>b.onclick=()=>{ if(b.dataset.nvView!==v) setView(b.dataset.nvView); });
}
let flowDragId=null;
// Central de execuções: bucket de cada tarefa (ordem = urgência pro humano)
function flowBucket(t){
  if(t.status==='draft') return 'rascunho';
  if((t.flag==='closed'||['merged','done'].includes(t.status))) {
    const d=new Date(t.createdAt||t.created_at); const today=new Date();
    return (d.toDateString()===today.toDateString())?'hoje':'anteriores';
  }
  if(pendingOf(t.id).length || ['plan-review','error','conflict','aborted'].includes(t.status)) return 'aguardando';
  if(t.prUrl && t.status!=='merged') return 'praberto';
  if(['review','delivered'].includes(t.status)) return 'prontas';
  return 'andamento'; // running/thinking/queued/paused
}
const FLOW_SECS=[
  ['aguardando','Aguardando você','warn','acc-warn'],
  ['andamento','Em andamento','','acc-good'],
  ['prontas','Prontas pra revisar','',''],
  ['praberto','PR aberto','','acc-info'],
  ['rascunho','Rascunhos','',''],
  ['hoje','Concluídas hoje','',''],
  ['anteriores','Anteriores','',''],
];
let flowView=lsGet('flowView')||'list';   // list | grid (redesign p1/p2)
function renderFlowHead(){
  const el=$id('flowHead'); if(!el) return;
  const vis=(state.tasks||[]).filter(t=>notHidden(t));
  const andamento=vis.filter(t=>['andamento','prontas','praberto'].includes(flowBucket(t))).length;
  const aguardando=vis.filter(t=>flowBucket(t)==='aguardando').length;
  if(flowScope==='done'){
    let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); }
    const done=flowVisible(src); const prs=done.filter(t=>t.prUrl).length;
    el.innerHTML=`<h1>Entregas concluídas</h1><div class="sub">${done.length} demanda${done.length===1?'':'s'}${prs?` · ${prs} PR${prs===1?'':'s'}`:''} · objetivos, provas e documentos de cada uma</div><span style="flex:1"></span>`;
    return;
  }
  el.innerHTML=`<h1>Central de execuções</h1><div class="sub">${andamento} em andamento${aguardando?` · <b>${aguardando} aguardando você</b>`:''}</div>
    <span style="flex:1"></span><span id="coordChip" class="mono" title="Coordenação (baseline): conflitos de merge · colisões do bus · reworks" style="font-size:11px;color:var(--muted);align-self:center"></span>`;
}
// % de conclusão da tarefa: fase + requisitos PROVADOS puxam a barra
function taskPct(t){
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return 100;
  if(t.prUrl) return 92;
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  const c=reqProofCache[t.id];
  if(reqs.length && c===undefined){ loadReqProofs(t.id).then(()=>{ if(activeIs('flow')){ lastSig=''; safe(renderFlow); } }); }
  let reqFrac=null;
  if(reqs.length && c && c.list){ const m=matchReqProofs(reqs, c.list); const done=m.filter(x=>x&&x.status==='done').length; reqFrac=done/reqs.length; }
  if(['review','delivered'].includes(t.status)) return Math.round(80+(reqFrac==null?5:reqFrac*15));
  if(t.status==='draft') return 5;
  if(t.status==='queued') return 15;
  if(t.status==='plan-review') return 25;
  if(['error','conflict','aborted'].includes(t.status)) return 40;
  return Math.round(35+(reqFrac==null?10:reqFrac*40)); // rodando
}
// chips do site local: globo abre aqui · celular cria/fecha o túnel — home e cards
function pvChips(t, withLabel){
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return '';
  const pv=taskPreviewUrl(t.id); if(!pv) return '';
  const tun=(typeof tunnelUp!=='undefined')?tunnelUp[t.id]:null;
  return `<button class="btn sm" data-pvrow="${escA(pv)}" title="abrir o site local que o agente subiu — ${escA(pv)}" style="padding:3px 8px;font-size:10.5px;color:var(--accent);flex:none">${IC.globe}${withLabel?' preview':''}</button>`+
    `<button class="btn sm" data-pvmob="${escA(t.id)}" data-url="${escA(pv)}" title="${tun?('túnel aberto ('+escA(tun)+') — clique pra FECHAR o acesso do celular'):'abrir este site no seu CELULAR (túnel criptografado)'}" style="padding:3px 8px;font-size:10.5px;color:${tun?'var(--warn)':'var(--muted)'};flex:none">${IC.phone}</button>`;
}
// ---- Resumo da tarefa: tudo que já foi feito + o que falta ----
async function openTaskSummary(taskId){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  $id('sumOverlay').style.display='flex';
  $id('sumTitle').textContent=t.title;
  $id('sumBody').innerHTML='<div class="dim" style="font-size:12px">montando o resumo…</div>';
  $id('sumClose').onclick=()=>{ $id('sumOverlay').style.display='none'; };
  if(reqProofCache[t.id]===undefined) await loadReqProofs(t.id).catch(()=>{});
  if(commitsCache[t.id]===undefined) await loadCommits(t.id).catch(()=>{});
  renderTaskSummary(t);
}
function renderTaskSummary(t){
  const pct=taskPct(t);
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  const m=matchReqProofs(reqs,(reqProofCache[t.id]||{}).list);
  const doneR=m.filter(x=>x&&x.status==='done').length;
  const dels=(t.deliverables||[]);
  const d=diffOf(t.id), rev=reviewOf(t.id), c=commitsCache[t.id]||[];
  const cost=taskCost(t.id);
  const ph=taskPhase(t);
  const prN=(String(t.prUrl||'').match(/\/pull\/(\d+)/)||[])[1];
  // o que FALTA pra fechar
  const falta=[];
  reqs.forEach((r,i)=>{ if(!(m[i]&&m[i].status==='done')) falta.push('provar o requisito: '+r); });
  if(pendingOf(t.id).length) falta.unshift('responder a pergunta do agente ('+esc(pendingOf(t.id)[0].agent||t.agent)+')');
  if(!t.prUrl && !['merged','done'].includes(t.status) && t.flag!=='closed') falta.push(ph<4?'concluir a execução e trazer pra revisão':'aprovar a entrega e abrir o PR');
  if(t.prUrl && t.status!=='merged') falta.push('review do time e merge do PR #'+(prN||''));
  // últimas falas relevantes (o "diário" do que foi feito)
  const notas=eventsOf(t.id).filter(e=>['done','note'].includes(e.type)&&(e.text||'').length>30&&!/^(💬|❓|perguntou ao humano|humano respondeu)/.test(e.text||'')).slice(-5);
  const li=(arr,ic,co)=>arr.map(x=>`<div style="display:flex;gap:8px;font-size:12.5px;padding:4px 0"><span style="color:${co};flex:none">${ic}</span><span>${esc(x)}</span></div>`).join('');
  $id('sumBody').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <div style="flex:1;height:8px;border-radius:99px;background:var(--border-strong);overflow:hidden"><i style="display:block;height:100%;width:${pct}%;background:var(--good);border-radius:99px"></i></div>
      <b class="mono" style="font-size:15px">${pct}%</b>
    </div>
    <div class="dim" style="font-size:11.5px;margin-bottom:12px">fase atual: <b>${esc(PHASES[ph-1])}</b> · ${esc(t.branch||'')}${cost.usd>0?' · '+fmtUsd(cost.usd):''}</div>
    ${t.objective?`<div class="seclbl2">Objetivo</div><div style="font-size:12.5px;margin-bottom:12px">${esc(t.objective)}</div>`:''}
    <div class="seclbl2">O que já foi feito</div>
    ${reqs.length?reqs.map((r,i)=>{ const ok=m[i]&&m[i].status==='done'; return `<div style="display:flex;gap:8px;font-size:12.5px;padding:4px 0"><span style="color:${ok?'var(--good)':'var(--muted)'};flex:none">${ok?'✓':'○'}</span><span${ok?'':' style="color:var(--muted)"'}>${esc(r)}</span>${ok&&m[i].evidence&&m[i].evidence.length?`<span class="dim mono" style="font-size:10px;align-self:center">${esc(String(m[i].evidence[0]).slice(0,28))}</span>`:''}</div>`; }).join(''):''}
    ${dels.length?`<div style="margin-top:6px">${li(dels,'◆','var(--accent)')}</div>`:''}
    <div class="dim" style="font-size:11.5px;margin:8px 0 12px">${d?`${(d.files||[]).length} arquivo(s) alterado(s) · +${d.additions||0} −${d.deletions||0}`:'sem diff ainda'} · ${c.length} commit(s)${rev?' · review interno ✓':''}${t.prUrl?` · PR ${prN?'#'+prN:''} aberto`:''}</div>
    ${notas.length?`<div class="seclbl2">Diário do agente</div>${notas.map(e=>`<div style="display:flex;gap:8px;font-size:12px;padding:3px 0;color:var(--text-2)"><span class="mono dim" style="flex:none">${esc((e.agent||'').slice(0,8))}</span><span>${esc(String(e.text).slice(0,140))}</span></div>`).join('')}`:''}
    ${rev?`<div class="seclbl2" style="margin-top:10px">Como testar</div><div style="font-size:12.5px">${esc(rev.howToTest||'')}</div>`:''}
    <div class="seclbl2" style="margin-top:14px">O que falta pra finalizar</div>
    ${falta.length?li(falta,'→','var(--warn)'):'<div style="font-size:12.5px;color:var(--good)">nada — pronta pra fechar ✓</div>'}
    <div style="display:flex;gap:8px;margin-top:16px"><span style="flex:1"></span>
      ${['review','delivered'].includes(t.status)&&!t.prUrl?`<button class="btn primary sm" id="sumPr">${IC.check} aprovar e abrir PR</button>`:''}
      <button class="btn sm" id="sumOpen">abrir a tarefa</button></div>`;
  bindClick('sumOpen', ()=>{ $id('sumOverlay').style.display='none'; selected=t.id; render(); openWorkspace(t.id); });
  bindClick('sumPr', ()=>{ $id('sumOverlay').style.display='none'; prPrepOpen(t.id, lsGet('prBase:'+t.id)||'main'); });
}
// linha compacta da Central (redesign p2): dot · título · projeto · progresso · status · avatar · tempo
function flowTaskRow(t){
  const asking=pendingOf(t.id);
  const ph=taskPhase(t);
  const pct=taskPct(t);
  const done=['merged','done'].includes(t.status)||t.flag==='closed';
  const dot= asking.length||t.status==='plan-review'?'var(--warn)'
    : ['error','conflict'].includes(t.status)?'var(--crit)'
    : (ACTIVE_ST.has(t.status)||t.status==='thinking')?'var(--good)'
    : ['review','delivered'].includes(t.status)?'var(--warn)'
    : 'var(--muted)';
  const segs=[1,2,3,4,5].map(i=>`<i class="${i<=ph?((asking.length&&i===ph)?'on warn':'on'):''}"></i>`).join('');
  const ev=lastEventOf(t.id);
  const prN=(String(t.prUrl||'').match(/\/pull\/(\d+)/)||[])[1];
  const msg= asking.length ? `${esc(asking[0].agent||t.agent)} perguntou — ${esc((asking[0].prompt||'').slice(0,70))}`
    : t.status==='plan-review' ? 'plano pronto — aprove pra continuar'
    : t.status==='draft' ? 'rascunho — clique pra editar · ▶ inicia'
    : done ? (prN?`PR #${prN} · merged`:'concluída')
    : (t.prUrl&&prN) ? `PR #${prN} aguardando aprovação`
    : ['review','delivered'].includes(t.status) ? `${(diffOf(t.id)?.files||[]).length||''} arquivo(s) alterado(s), pronta pra revisar`
    : ev ? `${esc(ev.agent||t.agent)} ${GLYPH[ev.type]||''} ${esc(String(ev.text||'').slice(0,70))}`
    : 'iniciando…';
  const proj=t.proj||(state.repo||'').split('/').filter(Boolean).slice(-1)[0]||'';
  const pcol=projColor(t.repo||state.repo);
  const agoP=(ms)=>{ const s=(Date.now()-ms)/1000; if(!(s>=0)) return ''; if(s<60) return 'agora'; if(s<3600) return Math.floor(s/60)+'min'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; };
  const tm=agoP(ev?+new Date(ev.ts):(t.createdAt||t.created_at));
  const play=t.status==='draft'?`<button class="kplay" data-rowplay="${escA(t.id)}" title="iniciar">${IC.cright}</button>`:'';
  // ações rápidas direto da home: abrir PR (qualquer tarefa viva sem PR) · link do PR/issue · site local
  const readyPr=['review','delivered'].includes(t.status);
  const artOnly=['invest','design'].includes(taskType(t)); // sem PR — o "pronto" delas é arquivar
  const quick=(!done && t.status!=='draft' && !t.prUrl)
    ? (artOnly
        ? (readyPr?`<button class="btn primary sm" data-arch="${escA(t.id)}" title="conclui e tira da fila" style="padding:3px 10px;font-size:10.5px;flex:none">✓ concluir</button>`:'')
        : `<button class="btn ${readyPr?'primary ':''}sm" data-rowpr="${escA(t.id)}" title="checagens do repo → commit & push → cria o PR" style="padding:3px 10px;font-size:10.5px;flex:none">${IC.merge} abrir PR</button>`) : '';
  const pvChip=pvChips(t, true);
  return `<div class="frow${done?' done':''}" data-id="${t.id}">
    <span class="d" style="background:${dot}"></span>
    ${play}<span class="ti">${esc(t.title)}</span>
    <span class="prj"><span class="prjd" style="background:${pcol}"></span>${esc(proj)}</span>
    <span class="pctwrap" data-sum="${escA(t.id)}" title="ver o resumo do que já foi feito"><i style="width:${pct}%;background:${asking.length?'var(--warn)':'var(--good)'}"></i></span><span class="pctn mono" data-sum="${escA(t.id)}" title="ver o resumo do que já foi feito">${pct}%</span>
    <span class="msg">${msg}</span>
    ${pvChip}${quick}${linkChips(t)}
    <span class="ini2" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span>
    <span class="tm">${tm}</span>
    <button class="btn sm" data-tmenu="${escA(t.id)}" title="mudar status / encerrar" style="padding:2px 7px;font-size:11px;flex:none">⋯</button>
  </div>`;
}
// menu ⋯ da home: mudar status/flag sem abrir a tarefa
function openTaskMenu(taskId, anchor){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  $id('tmenuPop')?.remove();
  const pop=document.createElement('div');
  pop.id='tmenuPop';
  pop.style.cssText='position:fixed;z-index:9000;min-width:210px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);padding:5px';
  const item=(label,fn,danger)=>{ const b=document.createElement('button');
    b.textContent=label; b.style.cssText='display:block;width:100%;text-align:left;border:0;background:none;color:'+(danger?'var(--crit)':'var(--text)')+';font:inherit;font-size:12.5px;padding:8px 10px;border-radius:7px;cursor:pointer';
    b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none';
    b.onclick=async()=>{ pop.remove(); try{ await fn(); lastSig=''; await refresh(); }catch(e){ alert('Falhou: '+e); } };
    pop.appendChild(b); };
  const ty=taskType(t);
  const artifactOnly=['invest','design'].includes(ty); // investigação/design não têm PR pra mergear
  // CONCLUIR/ARQUIVAR no topo: é o que tira as investigações/entregas prontas da fila
  if(t.flag!=='closed') item('✓ concluir · arquiva e sai da fila', ()=>invoke('set_task_flag',{taskId,flag:'closed'}));
  if(t.status!=='draft' && !['merged','done'].includes(t.status) && t.flag!=='closed'){ const b=document.createElement('button'); b.textContent='⚙ trocar modelo · '+(typeof aiModelName==='function'?aiModelName(t.model):(t.model||'padrão')); b.style.cssText='display:block;width:100%;text-align:left;border:0;background:none;color:var(--text);font:inherit;font-size:12.5px;padding:8px 10px;border-radius:7px;cursor:pointer'; b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none'; b.onclick=(e)=>{ e.stopPropagation(); pop.remove(); openModelMenu(taskId, anchor); }; pop.appendChild(b); }
  if(t.flag==='closed') item('↩ reabrir (volta pra fila)', ()=>invoke('set_task_flag',{taskId,flag:null}));
  if(!['review','delivered'].includes(t.status) && t.status!=='merged') item('◆ marcar pronta pra review', ()=>invoke('mark_task_status',{taskId,status:'review'}));
  if(t.status!=='merged' && !artifactOnly) item('⌥ marcar como merged', ()=>invoke('mark_task_status',{taskId,status:'merged'}));
  if(['review','delivered','merged'].includes(t.status)) item('↻ voltar pra rodando', ()=>invoke('mark_task_status',{taskId,status:'running'}));
  if(t.flag!=='blocked') item('❙❙ bloquear', ()=>invoke('set_task_flag',{taskId,flag:'blocked'}));
  else item('▶ desbloquear', ()=>invoke('set_task_flag',{taskId,flag:null}));
  if(['error','aborted','conflict'].includes(t.status)){
    item('↻ tentar seguir · continua de onde parou', ()=>invoke('talk_task',{taskId, message:'A execução anterior foi interrompida (timeout de inatividade/erro). CONTINUE de onde você parou: confira git status, git diff, .cardume/PLAN.md e os requisitos em .cardume/TASK.yaml, e finalize o que falta — não recomece do zero. Se for rodar algo demorado, vá reportando progresso pra não ser encerrado por inatividade.', asReq:false, agent:null}));
    item('↻ re-rodar do zero · descarta o parcial', ()=>invoke('rerun_task',{taskId}));
  }
  item('✕ abortar agora', ()=>invoke('abort_task',{taskId}), true);
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6)+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.right-pop.offsetWidth))+'px';
  setTimeout(()=>{ const close=(e)=>{ if(!pop.contains(e.target)){ pop.remove(); document.removeEventListener('click',close); } }; document.addEventListener('click',close); },0);
}
// dropdown de status direto no chip "Review/Rodando/..." do card
function openStatusMenu(taskId, anchor){
  // tarefa do projeto atual OU de outro projeto (card agregado no board integrado).
  // cross-project: o menu abre com o dado do cache; ao aplicar, troca pro projeto
  // dono e só então grava (mark_task_status/set_task_flag operam no repo ativo).
  let t=(state.tasks||[]).find(x=>x.id===taskId), crossRepo=null;
  if(!t){ const a=(allTasksCache||[]).find(x=>x.id===taskId); if(a){ t=a; crossRepo=(a.repo&&a.repo!==state.repo)?a.repo:null; } }
  if(!t) return;
  const ensureProj=async()=>{ if(crossRepo && window.switchProject){ await window.switchProject(crossRepo); crossRepo=null; } };
  $id('stmenuPop')?.remove();
  const closed = t.flag==='closed';
  const cancelled = t.status==='cancelled';
  // estado "atual" pra marcar o ●: cancelada e encerrada vencem; review/delivered contam como review
  const cur = cancelled ? 'cancelled' : closed ? 'finished' : (['review','delivered'].includes(t.status)?'review':t.status);
  // cada opção: {key, label, col, act()} — status via mark_task_status, finalizar via flag
  const setSt=(status)=>()=>invoke('mark_task_status',{taskId,status});
  const opts=[
    { key:'running', label:'▶ Rodando',          col:'var(--good)', act:setSt('running') },
    { key:'review',  label:'◆ Pronta pra review', col:'var(--warn)', act:setSt('review') },
    { key:'merged',  label:'✓ Mergeado',          col:'var(--good)', act:setSt('merged') },
    { key:'finished',label:'★ Finalizado · sai da fila', col:'var(--accent)', act:()=>invoke('set_task_flag',{taskId,flag:'closed'}) },
    { key:'cancelled',label:'⊘ Cancelada · para e sai da fila', col:'var(--crit)', act:async()=>{ await invoke('mark_task_status',{taskId,status:'cancelled'}); await invoke('set_task_flag',{taskId,flag:'closed'}); } },
    // "Rascunho" NÃO entra: rebaixar uma task já iniciada pra draft a tornava
    // não-abrível (o clique ia pro editor) — footgun. Rascunho é só na criação.
  ];
  const pop=document.createElement('div');
  pop.id='stmenuPop';
  pop.style.cssText='position:fixed;z-index:9000;min-width:210px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);padding:5px';
  opts.forEach(o=>{ const b=document.createElement('button');
    const on=(o.key===cur);
    b.innerHTML=`<span style="color:${o.col}">${o.label}</span>${on?'<span style="margin-left:auto;opacity:.7">●</span>':''}`;
    b.style.cssText='display:flex;align-items:center;width:100%;text-align:left;border:0;background:'+(on?'var(--surface-2)':'none')+';color:var(--text);font:inherit;font-size:12.5px;padding:8px 10px;border-radius:7px;cursor:pointer';
    b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background=(on?'var(--surface-2)':'none');
    b.onclick=async()=>{ pop.remove(); if(o.key===cur) return; try{ await ensureProj(); await o.act(); if(closed && o.key!=='finished' && o.key!=='cancelled'){ await invoke('set_task_flag',{taskId,flag:null}); } lastSig=''; await refresh(); }catch(e){ alert('Falhou: '+e); } };
    pop.appendChild(b); });
  // encerrada: oferece reabrir explicitamente no rodapé
  if(closed){ const b=document.createElement('button');
    b.textContent='↩ reabrir (volta pra fila)';
    b.style.cssText='display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--border);margin-top:4px;padding:8px 10px;background:none;color:var(--text);font:inherit;font-size:12px;cursor:pointer';
    b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none';
    b.onclick=async()=>{ pop.remove(); try{ await ensureProj(); await invoke('set_task_flag',{taskId,flag:null}); lastSig=''; await refresh(); }catch(e){ alert('Falhou: '+e); } };
    pop.appendChild(b); }
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6)+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.right-pop.offsetWidth))+'px';
  setTimeout(()=>{ const close=(e)=>{ if(!pop.contains(e.target)){ pop.remove(); document.removeEventListener('click',close); } }; document.addEventListener('click',close); },0);
}
// a task JÁ foi iniciada (tem PR ou commits)? Se sim, clicar abre o workspace
// mesmo com status 'draft' — senão iria pro editor e não dava pra falar com o agente.
function taskStarted(t){ return !!(t && (t.prUrl || (commitsCache[t.id] && commitsCache[t.id].length))); }
function openOrEdit(t){ if(t.status==='draft' && !taskStarted(t)) editDraft(t); else openWorkspace(t.id); }
function renderFlow(){
  if(flowDragId) return;   // não re-renderiza no meio de um arrasto
  renderFlowHead();
  renderFlowFilters();
  const el=$id("flow");
  el.classList.toggle('gridview', flowView==='grid');
  let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); } // integrado por padrão; fallback pro repo ativo se algo falhar
  const ghost='<div class="fcard ghost" id="ghostNew"><span class="gplus">＋</span><b>Nova demanda</b><span style="font-size:12px">descreva o que precisa ser feito — o time de agentes cuida do resto</span></div>';
  // monta o HTML numa string (não escreve direto no DOM) pra poder pular o rebuild
  // quando NADA VISÍVEL mudou — senão o poll (evento de agente ativo) reconstruía a
  // lista inteira e o card sob o mouse piscava (pior em Concluídas, onde nada muda).
  let tasks=[], html='', grouped=false;
  if(!src.length){ html=ghost; }
  else {
    const vis=flowVisible(src).slice();
    const hasManual=vis.some(t=>t.sortOrder!=null);
    tasks = hasManual
      ? vis.sort((a,b)=> (a.sortOrder??1e15)-(b.sortOrder??1e15) || b.created_at-a.created_at)
      : vis.sort((a,b)=> b.created_at-a.created_at);
    if(!tasks.length){ html = flowQuery.trim()
      ? `<div class="empty">nenhuma tarefa para <b>"${esc(flowQuery.trim())}"</b> · <a class="lnk" id="flowClearSearch" style="cursor:pointer">limpar busca</a></div>`
      : '<div class="empty">nenhuma tarefa neste filtro.</div>'; }
    else {
      grouped = flowGroupBy==='day';
      const item = flowView==='grid' ? ((t,acc)=>flowTaskCard(t,acc)) : ((t)=>flowDemandCard(t));
      const byProject = flowScope==='done' && projFilter==='all' && projList().length>1;
      if(grouped){
        const g=new Map();
        for(const t of tasks){ const d=new Date(t.createdAt||t.created_at); const k=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); if(!g.has(k)) g.set(k,[]); g.get(k).push(t); }
        const keys=[...g.keys()].sort((a,b)=>b-a);
        html = keys.map(k=>`<div class="daygrp"><div class="dayh">${esc(dayLabel(k))} <span class="dayn">${g.get(k).length} tarefa(s)</span></div>${g.get(k).map(t=>item(t)).join("")}</div>`).join("");
      } else if(byProject){
        const g=new Map();
        for(const t of tasks){ const k=t.repo||state.repo||''; if(!g.has(k)) g.set(k,[]); g.get(k).push(t); }
        html = [...g.entries()].map(([k,list])=>`<div class="secgrp"><div class="sech"><span class="prjd" style="background:${projColor(k)};width:8px;height:8px;border-radius:99px;display:inline-block"></span>${esc(projShort(k))} <span class="n">${list.length}</span></div>${list.map(t=>item(t)).join("")}</div>`).join("");
      } else if(hasManual){
        html = tasks.map(t=>item(t)).join("");
      } else {
        const by={}; for(const t of tasks){ (by[flowBucket(t)] ||= []).push(t); }
        html = FLOW_SECS.map(([k,label,tone,acc])=>{
          const list=by[k]||[]; if(!list.length) return '';
          const cards=list.map(t=>item(t, acc)).join("");
          return `<div class="secgrp"><div class="sech ${tone}">${esc(label)} <span class="n">${list.length}</span></div>${cards}</div>`;
        }).join("") + ghost;
      }
    }
  }
  // planos do orquestrador entram no topo em QUALQUER ordenação/agrupamento (sem busca ativa)
  if(window.orqBoardHtml && !flowQuery.trim()) html=window.orqBoardHtml(flowScope)+html;
  // idêntico ao último render E o DOM ainda tem o conteúdo → não reconstrói (sem piscar)
  if(html===flowLastHtml && el.firstChild) return;
  el.innerHTML=html; flowLastHtml=html;
  if(window.orqWireOpeners) window.orqWireOpeners(el);
  bindClick('ghostNew', ()=>{ if(window.openTab) window.openTab('nova'); else openNewTask(); });
  bindClick('flowClearSearch', ()=>{ flowQuery=''; const a=$id('topSearch'); if(a) a.value=''; const b=$id('ffSearch'); if(b) b.value=''; lastSig=''; renderFlow(); });
  wireLinkChips(el);
  // linha → abre a tela de execução direto (fluxo do redesign)
  el.querySelectorAll('.frow,.dcard').forEach(row=>{
    row.onclick=(e)=>{ if(e.target.closest('[data-rowplay],[data-rowpr],[data-arch],[data-pvrow],[data-pvmob],[data-sum],[data-lk],[data-lkcfg],[data-tmenu],[data-dcopen],[data-orq]')) return;
      const t=src.find(x=>x.id===row.dataset.id); if(!t) return;
      if(t._cross && t.repo && t.repo!==state.repo){ switchToProjectTask(t.repo, t.id); return; }
      selected=t.id; render();
      openOrEdit(t);
    };
    row.addEventListener('contextmenu',(e)=>{ e.preventDefault(); openTaskMenu(row.dataset.id, e.target); });
  });
  el.querySelectorAll('[data-rowplay]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); startTask(b.dataset.rowplay); });
  el.querySelectorAll('[data-rowpr]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); prPrepOpen(b.dataset.rowpr, lsGet('prBase:'+b.dataset.rowpr)||'main'); });
  el.querySelectorAll('[data-resolveconf]').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); if(!await askYes('A IA vai mergear a base e resolver os conflitos nesta worktree (sem push). Você revisa o resultado e mergeia. Continuar?')) return; b.disabled=true; b.textContent='resolvendo…'; try{ await invoke('resolve_conflict',{ taskId:b.dataset.resolveconf }); lastSig=''; await refresh(); }catch(err){ alert('Falhou: '+(err&&err.message||err)); b.disabled=false; } });
  el.querySelectorAll('[data-arch]').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); try{ await invoke('set_task_flag',{taskId:b.dataset.arch,flag:'closed'}); lastSig=''; await refresh(); }catch(err){ alert('Falhou: '+err); } });
  el.querySelectorAll('[data-pvrow]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); invoke('open_url',{ url:b.dataset.pvrow }).catch(()=>{}); });
  // 📱 da home: cria o túnel pro celular (ou fecha, se já estiver aberto)
  el.querySelectorAll('[data-pvmob]').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation();
    const id=b.dataset.pvmob;
    const up=(typeof tunnelUp!=='undefined')?tunnelUp[id]:null;
    b.disabled=true;
    if(up){ b.textContent='fechando…';
      try{ await invoke('tunnel_stop',{ taskId:id }); }catch(_){ }
      if(typeof tunnelUp!=='undefined') delete tunnelUp[id];
      if(typeof autoTunneled!=='undefined') delete autoTunneled[id];
      try{ const cid=tmap()[id]; if(cid){ const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{}; await sbFetch('/rest/v1/tasks?id=eq.'+cid,{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),previewUrl:null,tunnelWanted:null,tunnelClose:null}})}); } }catch(_){ }
    } else { b.textContent='criando túnel…';
      const pub=await mobilePreview(id, b.dataset.url);
      if(pub && typeof tunnelUp!=='undefined'){ tunnelUp[id]=pub; }
    }
    lastSig=''; renderFlow();
  });
  el.querySelectorAll('[data-sum]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openTaskSummary(b.dataset.sum); });
  el.querySelectorAll('[data-dcopen]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const t=src.find(x=>x.id===b.dataset.dcopen); if(!t) return; if(t._cross && t.repo && t.repo!==state.repo){ switchToProjectTask(t.repo, t.id); return; } selected=t.id; render(); openWorkspace(t.id); });
  el.querySelectorAll('[data-tmenu]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openTaskMenu(b.dataset.tmenu, b); });
  el.querySelectorAll('[data-stmenu]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openStatusMenu(b.dataset.stmenu, b); });
  el.querySelectorAll('.fcard:not(.ghost)').forEach(card=>{
    card.onclick=(e)=>{ if(e.target.closest('.fcommit,[data-lk],[data-lkcfg],[data-pvrow],[data-pvmob],[data-sum],[data-ctog],[data-rowpr],[data-arch],[data-tmenu],[data-stmenu]')) return; openTaskById(card.dataset.id); };
    card.addEventListener('contextmenu',(e)=>{ e.preventDefault(); openTaskMenu(card.dataset.id, e.target); });
    if(grouped) return;   // arrastar só faz sentido na lista plana
    card.setAttribute('draggable','true');
    card.addEventListener('dragstart',e=>{ flowDragId=card.dataset.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
    card.addEventListener('dragend',()=>{ flowDragId=null; card.classList.remove('dragging'); });
    card.addEventListener('dragover',e=>{ if(flowDragId&&flowDragId!==card.dataset.id){ e.preventDefault(); e.dataTransfer.dropEffect='move'; } });
    card.addEventListener('drop',e=>{ e.preventDefault(); const tgt=card.dataset.id; const drag=flowDragId; flowDragId=null; if(drag&&drag!==tgt) reorderFlow(drag,tgt); });
  });
  el.querySelectorAll('.fcommit').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openCommit(b.dataset.hash); });
  el.querySelectorAll('[data-ctog]').forEach(h=>h.onclick=(e)=>{ e.stopPropagation(); const id=h.dataset.ctog; if(flowCommitsOpen.has(id)) flowCommitsOpen.delete(id); else flowCommitsOpen.add(id); lastSig=''; renderFlow(); });
  for(const t of tasks){ if(commitsCache[t.id]===undefined) loadCommits(t.id).then(()=>{ if(activeIs('flow')) renderFlow(); }); }
}
