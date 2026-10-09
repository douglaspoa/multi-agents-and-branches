// Starfork — 22-quadro-fluxo
// ----- filtros do Fluxo (status · período · agente · busca) -----
// filtros persistem entre sessões (a busca não): status = uma das seções da Central (FLOW_SECS) ou 'epicos'
let flowStatus = lsGet('flowStatus')||'all';   // all | aguardando | andamento | prontas | praberto | rascunho | epicos
let flowEpic = lsGet('flowEpic')||'all';       // all | id do épico (nuvem)
let projFilter = lsGet('projFilter')||'all'; // 'all' (integrado) | caminho de um projeto
let allTasksCache = [];   // tarefas de TODOS os projetos (list_all_tasks), pro board integrado
let allTasksSig = '';
let allTasksAt = 0;       // throttle: list_all_tasks abre o sqlite de CADA projeto (I/O)
let allTasksOk = false;   // o cache já foi lido ao menos uma vez (vazio de verdade ≠ ainda não leu)
function projShort(p){ return pathBase(p); } // E10: aceita C:\… também
// lista [caminho, nome] dos projetos conhecidos (ativo + os do cache multi-projeto)
function projList(){ const m=new Map(); if(state.repo) m.set(state.repo, projShort(state.repo)); (allTasksCache||[]).forEach(t=>{ if(t.repo) m.set(t.repo, t.proj||projShort(t.repo)); }); return [...m.entries()]; }
function projColor(p){ // cor estável por projeto (hash → hue)
  let h=0; const s=String(p||''); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0;
  return `var(--chart-${h%8+1})`; // série do tema (o hsl fixo lia mal no claro)
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
  try{ const r=await invoke('list_all_tasks'); allTasksOk=true; const sig=r.map(t=>[t.id,t.status,t.sortOrder??'',t.flag||'',t.prUrl||'',t.stage||''].join(':')).join(','); /* flag/PR/etapa também mudam as contagens */ if(sig!==allTasksSig){ allTasksSig=sig; allTasksCache=r;
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
  sel.onchange=async()=>{ const p=sel.value; if(p && p!==state.repo && window.switchProject){ try{ await window.switchProject(p); }catch(_){ sel.value=state.repo||''; } } };
}
// clicar numa tarefa de OUTRO projeto → troca pra ele e abre a tarefa
async function switchToProjectTask(repo, id){
  try{ if(window.switchProject) await window.switchProject(repo); }catch(_){ return; } // L14: não abre a tarefa no projeto errado
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
// E5 (bug #7): ação num cartão de OUTRO projeto (filtro "Todos os projetos", o padrão). As ações (abrir PR,
// menu ⋯, concluir) leem state.tasks e gravam no banco do projeto ATIVO — antes não faziam nada, ou gravavam
// no projeto errado. Agora troca pro projeto dono (avisando) e só então roda.
async function crossRun(id, fn){
  let src; try{ src=boardSource(); }catch(_){ src=[]; }
  const t=src.find(x=>x.id===id);
  if(t && t._cross && t.repo && t.repo!==state.repo){
    toast('abrindo o projeto '+(t.proj||projShort(t.repo))+'…','info');
    if(window.switchProject){ try{ await window.switchProject(t.repo); }catch(_){ return; } } // L14: a troca já avisou do erro
    if(state.repo!==t.repo || !(state.tasks||[]).some(x=>x.id===id)){ toast('Não consegui abrir o projeto '+(t.proj||projShort(t.repo))+' — abra ele na barra lateral e tente de novo.','warn'); return; }
    selected=id; lastSig=''; render();
  } else if(!(state.tasks||[]).some(x=>x.id===id)) return;
  return fn();
}
let flowPeriod = lsGet('flowPeriod')||'all';   // all | today | week | month
let flowAgent  = lsGet('flowAgent')||'all';    // 'all' | nome do agente
let flowType   = lsGet('flowType')||'all';     // all | build | design | invest | fix | review
function flowSetF(k, v){ lsSet(k, v); }
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
// R7: quando a tarefa foi criada, em ms. O snapshot do projeto aberto manda `createdAt` (a struct Task do Rust é
// camelCase); o agregado de outro projeto (normAgg) e a nuvem mandam `created_at` (número ou ISO). Antes o quadro
// lia só `created_at`: nas tarefas do projeto aberto era undefined → "Hoje/Últimos 7 dias" escondiam TODAS e a
// ordem "mais recentes primeiro" (Central, Grafo, Concluídas) não ordenava nada. Segundos viram ms.
// É A fonte única de "quando foi criada" (53-teto-protecao: taskCreatedMs delega pra cá).
function taskTs(t){
  const ms=v=>{ const n=typeof v==='number'?v:Date.parse(v||''); return n>0?(n<1e12?n*1000:n):0; };
  return t ? (ms(t.createdAt)||ms(t.created_at)) : 0;
}
// data de CONCLUSÃO (último evento da tarefa — `finishedAt` vem do snapshot/list_all_tasks; nuvem: updated_at);
// sem nenhuma, cai na de criação (nunca 0 pra tarefa que existe)
function taskDoneTs(t){
  const ms=v=>{ const n=typeof v==='number'?v:Date.parse(v||''); return n>0?(n<1e12?n*1000:n):0; };
  return t ? (ms(t.finishedAt)||ms(t.finished_at)||ms(t.updated_at)||taskTs(t)) : 0;
}
function inPeriod(t){
  if(flowPeriod==='all') return true;
  const now=Date.now(), d=new Date(), ts=taskEncerrada(t)?taskDoneTs(t):taskTs(t); // concluída: pela data de conclusão
  if(flowPeriod==='today'){ return ts >= new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); }
  if(flowPeriod==='week'){ return ts >= now-7*864e5; }
  if(flowPeriod==='month'){ return ts >= now-30*864e5; }
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
const TYPE_COLOR={ feat:'var(--accent)', fix:'var(--crit)', docs:'var(--info)', chore:'var(--muted)', refactor:'var(--warn)', perf:'var(--chart-7)', design:'var(--chart-6)', invest:'var(--warn)', review:'var(--info)' };
const TYPE_ORDER=['feat','fix','docs','refactor','perf','chore','design','invest','review'];
// código da issue (FND-853) direto da branch; link usa a base configurada nas configurações
function issueCodeOf(t){ const m=((t.branch||'')+' '+(t.title||'')).match(/\b([A-Z]{2,10}-\d+)\b/); return m?m[1]:null; }
function issueUrlOf(t){ const c=issueCodeOf(t); const b=(lsGet('issueBase')||'').trim(); return (c&&b)?(b.replace(/\/+$/,'')+'/'+c):null; }
function linkChips(t, small){
  const cls=small?'btn sm':'btn sm';
  let h='';
  // R8: ↗ virou IC.extlink; o código da issue (LOJ-14) é dado técnico → mono; o rótulo genérico "issue" não
  const ext=icEm(IC.extlink);
  if(t.prUrl) h+=`<button class="${cls} lkchip" data-lk="${escA(t.prUrl)}" title="abrir o Pull Request no GitHub" style="color:var(--info)">PR ${ext}</button>`;
  const iu=t.issueUrl||issueUrlOf(t), ic=issueCodeOf(t);
  if(iu) h+=`<button class="${cls} lkchip" data-lk="${escA(iu)}" title="abrir a issue">${ic?`<span class="mono">${esc(ic)}</span>`:'issue'} ${ext}</button>`;
  else if(ic) h+=`<button class="${cls} lkchip mono" data-lkcfg="1" title="configure a URL base das issues nas configurações pra este código virar link" style="color:var(--muted)">${esc(ic)}</button>`;
  return h;
}
function wireLinkChips(root){
  root.querySelectorAll('[data-lk]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); openExternal(b.dataset.lk); }; });
  root.querySelectorAll('[data-lkcfg]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); openCfg(); }; });
}
let flowScope=(lsGet('flowScope')==='done')?'done':'exec';   // exec (Em andamento) | done (Concluídas)
let centralDoneSub=(lsGet('centralDone')==='res')?'res':'ent'; // Concluídas › Entregas | Resumo do período (ex-Daily, D20)
let ffAdvOpen=false;                        // filtros avançados recolhidos por padrão
let flowLastHtml=null;                      // último HTML do flow — pula rebuild idêntico (evita piscar no hover)
// Execução = o que está vivo (rascunho, rodando, review, PR aberto); Concluídas = mergeadas/encerradas.
// Uma tarefa ENCERRADA (flag closed) mora em Concluídas mesmo que o status seja review/erro.
function flowScopeOk(t){
  return flowScope==='done' ? taskEncerrada(t) : (notHidden(t) && !taskEncerrada(t)); // F4: cancelada = encerrada (Concluídas)
}
function flowVisible(tasks){
  return tasks.filter(t=>
    flowScopeOk(t) &&
    // chips de status = as MESMAS seções da lista (flowBucket); em Concluídas não há chips, então não filtra
    (flowScope==='done'||flowStatus==='all'||flowBucket(t)===flowStatus) &&
    flowOtherFiltersOk(t)
  );
}
// todos os filtros MENOS o de status (épico, tipo, período, agente, busca): os chips contam por aqui — C1 (mesa-bugs-2):
// com a busca "cores" a lista tinha 1 linha e os chips seguiam "Todas 3 · Em andamento 2"
// skip='type': o select de Tipo conta cada opção com todos os filtros MENOS o próprio tipo (senão escolher um tipo sumia com os outros)
function flowOtherFiltersOk(t, skip){
  const q=flowQuery.trim().toLowerCase();
  return (flowEpic==='all'||((t.epic&&t.epic.epicId)||'')===flowEpic) &&
    (skip==='type'||flowType==='all'||taskType(t)===flowType) &&
    inPeriod(t) &&
    (flowAgent==='all'||taskAgents(t).includes(flowAgent)) &&
    (!q || (t.title||'').toLowerCase().includes(q));
}
function renderFlowFilters(){
  const el=$id('flowFilters'); if(!el) return;
  // preserva foco/caret da busca (o poll pode re-renderizar durante digitação)
  const ae=document.activeElement, wasSearch=ae&&ae.id==='ffSearch', caret=wasSearch?ae.selectionStart:0;
  // os chips contam SÓ o que a aba atual (Execução/Concluídas) mostra — senão "Review 29" aparece
  // com a lista vazia porque as 29 estão encerradas (moram em Concluídas)
  let srcAll; try{ srcAll=boardSource(); }catch(_){ srcAll=(state.tasks||[]); }
  const byPeriod=srcAll.filter(t=>flowScopeOk(t)&&flowOtherFiltersOk(t)); // C1: os chips contam o que a lista mostraria (só o status muda)
  const epqN=(typeof epQueueCount==='function')?epQueueCount():0;
  const fcP=flowCounts(byPeriod); // a MESMA contagem do cabeçalho/barra de status/Kanban
  const count=g=> g==='all'?byPeriod.length:g==='epicos'?epqN:(fcP[g]||0);
  // chips = as seções da Central (mesmo nome, mesma cor) + a fila dos épicos quando existe
  if(flowStatus!=='all' && !FLOW_EXEC_KEYS.includes(flowStatus) && flowStatus!=='epicos') flowStatus='all'; // valor antigo (draft/active/…) salvo
  const ST=[['all','Todas',null]].concat(FLOW_SECS.filter(([k])=>FLOW_EXEC_KEYS.includes(k)).map(([k,label])=>[k,label,FLOW_SEC_COLOR[k]||null]))
    .concat([['epicos','Na fila dos épicos','var(--accent)']])
    .filter(([k])=>k==='all'||k===flowStatus||count(k)>0);
  let stChips=ST.map(([k,label,col])=>`<button class="fchip${flowStatus===k?' on':''}" data-st="${k}"${FLOW_SEC_TIP[k]?` title="${escA(FLOW_SEC_TIP[k])}"`:''}>${col?`<span class="dot" style="background:${col}"></span>`:''}${label}<span class="n">${count(k)}</span></button>`).join('');
  // bloqueadas: escondidas por padrão em Execução (toggle); encerradas moram em Concluídas
  const nBlocked=flowScope==='done'?0:srcAll.filter(t=>t.flag==='blocked'&&inPeriod(t)&&!(t.flag==='closed'||['merged','done'].includes(t.status))).length;
  if(nBlocked) stChips+=`<button class="fchip flagchip${flowShowBlocked?' on':''}" data-flag="blocked" title="mostrar/ocultar bloqueadas">${IC.pause} Bloqueadas<span class="n">${nBlocked}</span></button>`;
  flowShowClosed=false;
  const PE=[['all','Todo período'],['today','Hoje'],['week','Últimos 7 dias'],['month','Últimos 30 dias']];
  const peOpts=PE.map(([k,label])=>`<option value="${k}"${flowPeriod===k?' selected':''}>${label}</option>`).join('');
  const agents=[...new Set((state.tasks||[]).flatMap(taskAgents))].sort((a,b)=>a.localeCompare(b));
  if(flowAgent!=='all' && agents.length && !agents.includes(flowAgent)) flowAgent='all'; // lista vazia = ainda carregando: não perde o filtro salvo
  const agOpts=['all',...agents].map(a=>`<option value="${escA(a)}"${flowAgent===a?' selected':''}>${a==='all'?'Todos os agentes':esc(a)}</option>`).join('');
  const byNoType=srcAll.filter(t=>flowScopeOk(t)&&flowOtherFiltersOk(t,'type'));
  const tyCount=k=>byNoType.filter(t=>taskType(t)===k).length;
  if(flowType!=='all' && !TYPE_ORDER.includes(flowType)){ flowType='all'; flowSetF('flowType','all'); } // valor antigo (build…) que nenhuma tarefa usa
  // tipo salvo que hoje tem 0 tarefas continua na lista (senão o select mostrava "Todos" e a lista vinha vazia sem explicação)
  const tyOpts=[['all','Todos os tipos']].concat(TYPE_ORDER.filter(k=>tyCount(k)>0||k===flowType).map(k=>[k, (TYPE_PT[k]||k)+' ('+tyCount(k)+')']))
    .map(([k,l])=>`<option value="${k}"${flowType===k?' selected':''}>${l}</option>`).join('');
  // abas da Central: Execução (o que está vivo) · Concluídas (portfólio) · Time (espaço próprio)
  if(flowScope!=='done') flowScope='exec';
  // F4 (mesa D2): Em andamento · Concluídas — "Time" virou página própria (lateral, só com organização)
  const nExec=srcAll.filter(t=>notHidden(t)&&!taskEncerrada(t)).length, nDone=srcAll.filter(taskEncerrada).length;
  // C2 (mesa-bugs-2): a aba é "Em aberto" (tudo que está vivo, como na lateral); "Em andamento" é SÓ a etapa (chip/seção)
  const TABS=[['exec','Em aberto',nExec],['done','Concluídas',nDone]];
  // Execução = SÓ o que é meu (tarefas locais + cartões que assumi). Backlog do time de outra pessoa / sem dono /
  // de projeto que não tenho aqui mora no Time — o número na aba avisa e o clique abre direto o Quadro do time
  const nTeamQ=(typeof epQueueTeamCount==='function')?epQueueTeamCount():0;
  // ordem manual (arrastar na grade) vale DENTRO de cada seção; "restaurar" volta pra mais recentes primeiro —
  // fica como link discreto junto dos controles de vista (antes era um botão no meio dos chips de status)
  const manualOn=flowScope!=='done' && flowViewEff()!=='table' && lsGet('flowManual')!=='0' && srcAll.some(t=>t.sortOrder!=null); // a tabela não usa a ordem manual (ordena pela coluna)
  const resetBtn=manualOn?`<button class="fvlink" id="flowResetOrder" title="você reordenou arrastando — volta pra ordem automática (mais recentes primeiro em cada seção)">↺ restaurar ordem</button>`:'';
  const tabsHtml=`<div class="ftabs">`+
    TABS.map(([k,l,n])=>`<button class="ft${flowScope===k?' on':''}" role="tab" aria-selected="${flowScope===k}" data-ftab="${k}">${l}<span class="n">${n}</span></button>`).join('')+
    `<span class="grow"></span>`+resetBtn+
    `<button class="fvic${ffAdvOpen?' on':''}" id="ffMore" title="filtros avançados" aria-label="filtros avançados" aria-expanded="${ffAdvOpen?'true':'false'}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4.5h11M4.5 8h7M6.8 11.5h2.4" stroke-linecap="round"/></svg></button>`+
    `<span class="fvsep"></span>`+
    (flowScope==='done'?'':`<button class="fvic${flowViewEff()==='table'?' on':''}" data-fv="table" title="${flowTableOk()?'Lista — ordenável, uma ação por linha':'Lista só sem agrupar por dia — aqui aparecem os cartões'}" aria-label="ver em lista" aria-pressed="${flowViewEff()==='table'}"${flowTableOk()?'':' disabled'}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h10" stroke-linecap="round"/></svg></button>`+
    `<button class="fvic" data-view="kanban" title="Kanban" aria-label="ver no Kanban"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3" width="3.4" height="10" rx="1"/><rect x="6.9" y="3" width="3.4" height="6.5" rx="1"/><rect x="11.3" y="3" width="3.4" height="8.4" rx="1"/></svg></button>`)+
    `</div>`;
  // PROJETO e ÉPICO viram dois selects compactos (antes eram 2 linhas de chips acima dos chips de status).
  // Mesmas chaves persistidas (projFilter / flowEpic).
  const pl=projList();
  const projSel = pl.length>1 ? `<select class="sel ffsel" id="ffProj" title="filtrar por projeto">`+
    `<option value="all"${projFilter==='all'?' selected':''}>Todos os projetos</option>`+
    pl.map(([path,name])=>`<option value="${escA(path)}"${projFilter===path?' selected':''}>${esc(name)}</option>`).join('')+
    (projFilter!=='all'&&!pl.some(([p])=>p===projFilter)?`<option value="${escA(projFilter)}" selected>${esc(projShort(projFilter))}</option>`:'')+
    `</select>` : '';
  const epIds=[...new Set(srcAll.filter(flowScopeOk).map(t=>(t.epic&&t.epic.epicId)||'')
    .concat(flowScope==='done'?[]:((typeof epQueueMine==='function')?epQueueMine():[]).map(r=>r.epic_id)).filter(Boolean))];
  if(flowEpic!=='all' && !epIds.includes(flowEpic)) epIds.push(flowEpic); // o escolhido fica na lista (pra poder limpar)
  const epName=id=>(typeof epNameOf==='function'&&epNameOf(id))||'épico';
  const epicSel = epIds.length ? `<select class="sel ffsel" id="ffEpic" title="filtrar por épico">`+
    `<option value="all"${flowEpic==='all'?' selected':''}>Todos os épicos</option>`+
    epIds.map(id=>`<option value="${escA(id)}"${flowEpic===id?' selected':''}>◆ ${esc(epName(id).slice(0,32))}</option>`).join('')+
    `</select>` : '';
  // filtro salvo que esconde tarefa sem controle à vista (período/agente moram no painel avançado fechado,
  // tipo/épico/status podem ter vindo de outra sessão): sempre mostra "filtros ativos · limpar"
  const PE_PT=Object.fromEntries(PE);
  const act=[];
  if(flowScope!=='done' && flowStatus!=='all') act.push(flowStatus==='epicos'?'fila dos épicos':((FLOW_SECS.find(([k])=>k===flowStatus)||[])[1]||flowStatus));
  if(flowPeriod!=='all') act.push(PE_PT[flowPeriod]||flowPeriod);
  if(flowAgent!=='all') act.push('agente '+flowAgent);
  if(flowType!=='all') act.push(TYPE_PT[flowType]||flowType);
  if(flowEpic!=='all') act.push('◆ '+epName(flowEpic).slice(0,24));
  // projeto salvo que não existe mais (removido/renomeado) → volta pra todos; senão entra no aviso de filtro ativo
  if(projFilter!=='all' && !pl.some(([p])=>p===projFilter)){ projFilter='all'; lsSet('projFilter','all'); }
  if(projFilter!=='all') act.push('projeto '+projShort(projFilter));
  const activeChip = act.length ? `<span class="ffactive" title="alguns filtros estão escondendo tarefas">filtros ativos: ${esc(act.join(' · '))} <button class="fvlink" id="ffClearAll">limpar</button></span>` : '';
  // SEMPRE visível: status + busca + projeto/épico/tipo (selects compactos)
  const isDone=flowScope==='done';
  const filterRow=`<div class="ffrow" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">`+
    (isDone?`<div class="seg2 cdseg" role="tablist" aria-label="Concluídas"><button role="tab" class="${centralDoneSub==='ent'?'on':''}" aria-selected="${centralDoneSub==='ent'}" data-cdsub="ent">Entregas</button><button role="tab" class="${centralDoneSub==='res'?'on':''}" aria-selected="${centralDoneSub==='res'}" data-cdsub="res" title="um dia do projeto aberto — o que os agentes fizeram (troque o dia no seletor)">Resumo do dia</button></div>`+(centralDoneSub==='res'?'':`<select class="sel" id="ffPeriod2">${peOpts}</select><button class="btn sm" id="flowPeriodRep" title="a IA escreve um relatório com todas as entregas concluídas deste filtro">${ic('doc')}relatório do período</button>`):`<div class="ffchips">${stChips}</div>`)+
    `<span style="flex:1"></span>`+
    // busca por nome SEMPRE visível (antes ficava escondida nos filtros avançados)
    `<div class="ffsearchwrap"><svg class="ffic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4L14 14" stroke-linecap="round"/></svg>`+
    `<input class="ffsearch" id="ffSearch" type="text" placeholder="buscar tarefa pelo nome…" value="${escA(flowQuery)}"></div>`+
    projSel+epicSel+
    `<select class="sel ffsel" id="ffType" title="filtrar por tipo (feature/fix/docs/investigação…)">${tyOpts}</select></div>`+
    (activeChip?`<div class="ffactrow">${activeChip}</div>`:'');
  // AVANÇADO (toggle): período, agente, agrupar
  const advHtml=`<div class="ffadv" style="display:${ffAdvOpen?'flex':'none'};flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">`+
    `<select class="sel" id="ffPeriod">${peOpts}</select>`+
    `<select class="sel" id="ffAgent">${agOpts}</select>`+
    `<select class="sel" id="ffGroup"><option value="none"${flowGroupBy==='none'?' selected':''}>Sem agrupar</option><option value="day"${flowGroupBy==='day'?' selected':''}>Por dia</option></select></div>`;
  const resumo=isDone && centralDoneSub==='res';
  { const h=resumo ? tabsHtml.replace(/<button class="fvic[^"]*" id="ffMore"[\s\S]*?<\/button>/,'')+`<div class="ffrow" style="display:flex;gap:8px;align-items:center;margin-bottom:10px">${filterRow.match(/<div class="seg2 cdseg"[\s\S]*?<\/div>/)[0]}</div>` : tabsHtml + filterRow + advHtml;
    if(el.__html===h && el.firstChild) return; el.__html=h; el.innerHTML=h; } // sem mudança: mantém DOM/handlers (e o foco da busca)
  el.querySelectorAll('[data-cdsub]').forEach(b=>b.onclick=()=>{ centralDoneSub=b.dataset.cdsub; lsSet('centralDone', centralDoneSub); lastSig=''; renderFlow(); });
  if(resumo){ el.querySelectorAll('[data-ftab]').forEach(b=>b.onclick=()=>{ flowScope=b.dataset.ftab; lsSet('flowScope',flowScope); lastSig=''; renderFlow(); }); return; }
  { const s=$id('ffProj'); if(s) s.onchange=(e)=>{ projFilter=e.target.value; lsSet('projFilter',projFilter); lastSig=''; renderFlow(); }; }
  { const s=$id('ffEpic'); if(s) s.onchange=(e)=>{ flowEpic=e.target.value; flowSetF('flowEpic',flowEpic); lastSig=''; renderFlow(); }; }
  bindClick('ffClearAll', flowClearFilters);
  bindClick('flowResetOrder', ()=>{ lsSet('flowManual','0'); lastSig=''; renderFlow(); });
  el.querySelectorAll('[data-ftab]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.ftab;
    flowScope=k; lsSet('flowScope',k); lastSig=''; renderFlow();
  });
  el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  el.querySelectorAll('[data-fv]').forEach(b=>b.onclick=()=>{ flowView=b.dataset.fv; lsSet('flowView',flowView); if(curView()!=='flow') setView('flow'); lastSig=''; renderFlow(); });
  { const b=el.querySelector('#ffMore'); if(b) b.onclick=()=>{ ffAdvOpen=!ffAdvOpen; lastSig=''; renderFlow(); }; }
  el.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{ flowStatus=b.dataset.st; flowSetF('flowStatus',flowStatus); lastSig=''; renderFlow(); });
  el.querySelectorAll('[data-flag]').forEach(b=>b.onclick=()=>{ if(b.dataset.flag==='blocked') flowShowBlocked=!flowShowBlocked; else flowShowClosed=!flowShowClosed; lastSig=''; renderFlow(); });
  { const t=$id('ffType'); if(!t) return; } // (Resumo do período não tem os filtros)
  $id('ffType').onchange=(e)=>{ flowType=e.target.value; flowSetF('flowType',flowType); lastSig=''; renderFlow(); };
  $id('ffPeriod').onchange=(e)=>{ flowPeriod=e.target.value; flowSetF('flowPeriod',flowPeriod); lastSig=''; renderFlow(); };
  { const p2=$id('ffPeriod2'); if(p2) p2.onchange=(e)=>{ flowPeriod=e.target.value; flowSetF('flowPeriod',flowPeriod); lastSig=''; renderFlow(); }; }
  bindClick('flowPeriodRep', periodReport);
  $id('ffAgent').onchange=(e)=>{ flowAgent=e.target.value; flowSetF('flowAgent',flowAgent); lastSig=''; renderFlow(); };
  $id('ffGroup').onchange=(e)=>{ flowGroupBy=e.target.value; lastSig=''; renderFlow(); };
  const s=$id('ffSearch');
  s.oninput=(e)=>{ flowQuery=e.target.value; lastSig=''; renderFlow(); };
  if(wasSearch){ s.focus(); try{ s.setSelectionRange(caret,caret); }catch(e){} }
}
// limpa TODOS os filtros da Central (menos a busca) — o "limpar" do aviso de filtros ativos e o do estado vazio
function flowClearFilters(){
  flowStatus='all'; flowPeriod='all'; flowAgent='all'; flowType='all'; flowEpic='all'; projFilter='all'; lsSet('projFilter','all');
  ['flowStatus','flowPeriod','flowAgent','flowType','flowEpic'].forEach(k=>flowSetF(k,'all'));
  lastSig=''; renderFlow();
}
// R7: atalhos que pulam pra Central numa visão exata (contagem da barra de status, "+N na Central" da barra
// lateral): zeram busca e os OUTROS filtros salvos — senão a lista mostrava menos que o N clicado.
// o = { status, proj } (proj: caminho do projeto ou 'all')
function flowJump(o){
  o=o||{};
  flowQuery=''; { const a=$id('topSearch'); if(a) a.value=''; const b=$id('ffSearch'); if(b) b.value=''; }
  flowScope='exec'; lsSet('flowScope','exec');
  flowStatus=o.status||'all'; flowPeriod='all'; flowAgent='all'; flowType='all'; flowEpic='all';
  ['flowPeriod','flowAgent','flowType','flowEpic'].forEach(k=>flowSetF(k,'all')); flowSetF('flowStatus', flowStatus);
  projFilter=o.proj||'all'; lsSet('projFilter', projFilter);
  if(window.openTab) window.openTab('flow');
  if(curView()!=='flow') setView('flow'); else { lastSig=''; render(); }
}
// R7: o vazio da lista da Central diz POR QUE está vazia e dá a saída (limpar busca, limpar filtros, nova demanda)
function flowEmptyHtml(){
  const q=flowQuery.trim();
  // em Concluídas os chips de status não filtram (flowVisible ignora flowStatus lá) — não conta como filtro
  const anyF=(flowScope!=='done'&&flowStatus!=='all')||flowType!=='all'||flowPeriod!=='all'||flowAgent!=='all'||flowEpic!=='all'||projFilter!=='all';
  if(q && anyF) return emptyHtml({ icon:'search', title:'Nenhuma tarefa com “'+q+'” nestes filtros', help:'A busca e os filtros escolhidos, juntos, escondem todas as tarefas.', action:{ id:'flowClearAll', label:'limpar tudo', primary:false } });
  if(q) return emptyHtml({ icon:'search', title:'Nenhuma tarefa com “'+q+'” no nome', help:'Confira a grafia ou busque por outra palavra do título.', action:{ id:'flowClearSearch', label:'limpar busca', primary:false } });
  if(anyF) return emptyHtml({ icon:'search', title:'Nenhuma tarefa neste filtro', help:'Os filtros escolhidos estão escondendo as tarefas.', action:{ id:'flowClearFilters', label:'limpar filtros', primary:false } });
  if(flowScope==='done') return emptyHtml({ icon:'checkc', title:'Nada concluído ainda', help:'Quando você concluir ou mergear uma entrega, ela aparece aqui com as provas e os documentos.' });
  return emptyHtml({ icon:'spark', title:'Nada em aberto', help:'Descreva o que precisa ser feito e os agentes cuidam do resto.', action:{ id:'flowEmptyNew', label:'Nova demanda' } });
}
// barra de navegação NOVA nas demais vistas (Kanban/Grafo/Atividade/Time) —
// mesma linguagem da home; o seg2 antigo não aparece mais em lugar nenhum
function renderNavTabs(v){
  const el=$id('navTabs'); if(!el) return;
  if(el.dataset.sig===('nav:'+v)) return; el.dataset.sig='nav:'+v;
  el.innerHTML=`<div class="ftabs">
    <button class="ft${v==='kanban'?' on':''}" data-nv-scope="exec">Em aberto</button>
    <button class="ft" data-nv-scope="done">Concluídas</button>
    <span class="grow"></span>
    <button class="fvic${v==='flow'?' on':''}" data-nv-view="flow" title="Fluxo (lista)" aria-label="ver em lista" aria-pressed="${v==='flow'}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h10" stroke-linecap="round"/></svg></button>
    <button class="fvic${v==='kanban'?' on':''}" data-nv-view="kanban" title="Kanban" aria-label="ver no Kanban" aria-pressed="${v==='kanban'}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3" width="3.4" height="10" rx="1"/><rect x="6.9" y="3" width="3.4" height="6.5" rx="1"/><rect x="11.3" y="3" width="3.4" height="8.4" rx="1"/></svg></button>
  </div>`;
  el.querySelectorAll('[data-nv-scope]').forEach(b=>b.onclick=()=>{ flowScope=b.dataset.nvScope; lsSet('flowScope',flowScope); lastSig=''; setView('flow'); });
  el.querySelectorAll('[data-nv-view]').forEach(b=>b.onclick=()=>{ if(b.dataset.nvView!==v) setView(b.dataset.nvView); });
}
let flowDragId=null;
// Central de execuções: bucket de cada tarefa (ordem = urgência pro humano)
// É A regra única de "em que etapa está" — Central, chips, cabeçalho, barra de status, Kanban,
// barra lateral e Time contam por aqui (flowCounts). Não crie outra classificação numa tela.
// F4 (inventário 01): "concluída hoje" pela DATA DE CONCLUSÃO (taskDoneTs), não a de criação; `cancelled` é encerrada
// (vai pra Concluídas, nunca "Em andamento"); aguardando você = taskAguardaVoce (00-util, regra única D14).
function flowBucket(t){
  if(t.status==='draft') return 'rascunho';
  if(taskEncerrada(t)) {
    const d=new Date(taskDoneTs(t)); const today=new Date();
    return (d.toDateString()===today.toDateString())?'hoje':'anteriores';
  }
  if(taskAguardaVoce(t)) return 'aguardando';
  if(t.prUrl && t.status!=='merged') return 'praberto';
  if(['review','delivered'].includes(t.status)) return 'prontas';
  if(['backlog','requested'].includes(t.status)) return 'fila'; // só cartões da nuvem (Time) — local não tem backlog
  return 'andamento'; // running/thinking/queued/paused
}
// status EFETIVO pra exibir (selo/etiqueta): pergunta aberta vence o status cru ('running' com pergunta = aguardando você),
// PR aberto vira 'pr-open' (mesma etapa da Central). Use com stBadge/stLabel/stColor/stShort.
function taskSt(t){
  if(!t) return '';
  if(pendingOf(t.id).length) return 'asking';
  if(t.flag==='closed' && !['merged','done','cancelled'].includes(t.status)) return 'closed';
  if(flowBucket(t)==='praberto') return 'pr-open';
  return t.status;
}
function stShort(st){ const m=STATUS_META[st]; return (m&&m.short)||stLabel(st); }
// plural PT simples: nPl(0,'arquivo') → "0 arquivos", nPl(1,'arquivo') → "1 arquivo", nPl(2,'PR','PRs')
function nPl(n, sing, plur){ n=+n||0; return n+' '+(n===1?sing:(plur||sing+'s')); }
// tarefas VIVAS do board (mesma regra de visibilidade da lista de Execução: sem encerradas; bloqueadas só com o toggle)
function flowLiveTasks(src){
  if(!src){ try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); } }
  return (src||[]).filter(t=>notHidden(t) && !taskEncerrada(t));
}
// @proj-vivas-inicio — L11 (mesa-bugs-2): UMA régua de "demanda viva" por projeto pra lateral, Projetos e página Projeto
// (antes a lateral contava os OUTROS projetos pelo projects_overview: até 8, sem rascunho/pausada — e a Central por outra
// lista). Viva = não encerrada e não bloqueada, sem depender do botão "Bloqueadas" da Central. Outro projeto = o MESMO
// list_all_tasks da Central (allTasksCache); classificação por etapa = flowCounts/flowBucket.
function projLiveTasks(tasks){ return (tasks||[]).filter(t=>t && t.flag!=='blocked' && !taskEncerrada(t)); }
function projTasksOf(path){ if(path===state.repo) return state.tasks||[]; return (allTasksCache||[]).filter(t=>t.repo===path).map(normAgg); }
// @proj-vivas-fim
// A CONTAGEM ÚNICA: quantas tarefas em cada etapa (chaves = FLOW_SECS + 'fila'). `rodando` = subconjunto de
// andamento que está de fato executando agora (running/thinking) — só pra detalhe/tooltip.
function flowCounts(tasks){
  const c={ aguardando:0, andamento:0, prontas:0, praberto:0, rascunho:0, fila:0, hoje:0, anteriores:0, canceladas:0, rodando:0, total:0 };
  for(const t of (tasks||[])){ const b=flowBucket(t); c.total++;
    if((b==='hoje'||b==='anteriores') && t.status==='cancelled'){ c.canceladas++; continue; } // em Concluídas, mas não é entrega
    c[b]=(c[b]||0)+1; if(b==='andamento' && ['running','thinking'].includes(t.status)) c.rodando++; }
  return c;
}
const FLOW_SECS=[
  ['aguardando','Aguardando você','warn','acc-warn'],
  ['andamento','Em andamento','','acc-good'],
  ['prontas','Prontas pra revisar','',''],
  ['praberto','PR aberto','','acc-info'],
  ['rascunho','Rascunhos','',''],
  ['fila','Na fila','',''], // F4 (inventário 01): a fila (cartões do time assumidos/no backlog) aparece — antes era só contada
  ['hoje','Concluídas hoje','',''],
  ['anteriores','Anteriores','',''],
];
// B6: uma linha explicando cada seção (tooltip do cabeçalho e do chip) — pra quem não conhece o jargão
const FLOW_SEC_TIP={
  aguardando:'Aguardando você: o agente parou e precisa de uma decisão SUA (pergunta, plano pra aprovar, erro ou conflito).',
  andamento:'Em andamento: agentes trabalhando agora — você não precisa fazer nada.',
  prontas:'Prontas pra revisar: o agente terminou — confira e abra o PR (ou conclua).',
  praberto:'PR aberto: esperando revisão/merge no GitHub.',
  rascunho:'Rascunhos: ainda não começaram — ▶ inicia.',
  fila:'Na fila: cartões do time no backlog (ou pedidos) que ainda não começaram — assuma pra trazer pra cá.',
  hoje:'Concluídas hoje: mergeadas ou concluídas por você.',
  anteriores:'Concluídas antes de hoje.',
  epativos:'Épicos em andamento: épicos cujas tarefas já começaram todas — o resumo mostra quantas foram entregues, a onda atual e um ponto por tarefa (clique pra abrir).',
  epicos:'Na fila dos épicos: tarefas de épicos do time que ainda não começaram, agrupadas por épico e por onda. Onda = grupo de tarefas que rodam juntas; a próxima começa quando esta termina.',
};
const FLOW_SEC_COLOR={ aguardando:'var(--st-ask)', andamento:'var(--st-run)', prontas:'var(--st-review)', praberto:'var(--info)', rascunho:'var(--muted)', fila:'var(--muted)' };
const FLOW_EXEC_KEYS=['aguardando','andamento','prontas','praberto','rascunho','fila'];
// seção recolhida (B4): estado por seção no localStorage; `def` = padrão quando o usuário nunca mexeu
function flowSecCollapsed(k, def){ const v=lsGet('sec:col:'+k); return v==null?!!def:v==='1'; }
// R8: seta e ícone (opcional, ex.: IC.epic) em SVG; antes ▾/▸ e "◆ " colado no rótulo
function flowSecHead(k, label, n, tone, collapsed, icon){
  return `<div class="sech ${tone||''}" data-sectog="${escA(k)}" role="button" tabindex="0" aria-expanded="${collapsed?'false':'true'}" title="${escA((FLOW_SEC_TIP[k]||label)+' · clique pra '+(collapsed?'expandir':'recolher'))}"><span class="secchev">${collapsed?IC.chevR:IC.chevD}</span>${icon?`<span class="secic">${icon}</span>`:''}${esc(label)} <span class="n">${n}</span></div>`;
}
// ---- Concluídas: grupo POR PROJETO que recolhe + paginação (12 por vez) ----
// Com centenas de entregas a aba montava todos os cartões e cada um pedia artefatos/provas. Agora só os cartões
// VISÍVEIS existem (e só eles carregam): grupo recolhido = zero cartões; aberto = as 12 mais recentes + "mostrar mais".
// Cada projeto começa ABERTO; recolher fica salvo por projeto (concl:col:<caminho>) só neste computador.
const FLOW_DONE_PAGE=12;
const flowDoneShow={};   // quantos cartões cada grupo mostra nesta sessão (chave = projeto/seção)
function flowDoneCollapsed(k){ try{ return lsGet('concl:col:'+k)==='1'; }catch(_){ return false; } }
function flowDoneSetCollapsed(k, col){ try{ lsSet('concl:col:'+k, col?'1':'0'); }catch(_){ } }
function flowDoneDomId(k){ let h=0; const s=String(k); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return 'cg'+(h>>>0).toString(36); }
// os N primeiros (a lista já vem na ordem da Central) + botões "mostrar mais (N restantes)" / "recolher"
function flowDoneN(k, total){ return Math.min(total, Math.max(FLOW_DONE_PAGE, flowDoneShow[k]||FLOW_DONE_PAGE)); }
function flowDoneMoreHtml(k, total, n){
  const rest=total-n;
  const more=rest>0?`<button class="btn sm ghost" data-donemore="${escA(k)}">mostrar mais (${rest} restante${rest===1?'':'s'})</button>`:'';
  const less=n>FLOW_DONE_PAGE?`<button class="btn sm ghost" data-doneless="${escA(k)}">mostrar menos</button>`:'';
  return (more||less)?`<div class="cgmore">${more}${less}</div>`:'';
}
function flowDonePageHtml(k, list, item){
  const n=flowDoneN(k, list.length);
  return list.slice(0, n).map(t=>item(t)).join('')+flowDoneMoreHtml(k, list.length, n);
}
// grupo de um projeto: cabeçalho é um <button> (Tab/Enter/Espaço) com aria-expanded/aria-controls; recolhido = sem cartões
function flowDoneGroupHtml(k, label, color, list, item){
  const col=flowDoneCollapsed(k), id=flowDoneDomId(k);
  const head=`<button type="button" class="sech cgtog" data-donetog="${escA(k)}" aria-expanded="${col?'false':'true'}" aria-controls="${id}" title="${escA(label+' · '+(col?'mostrar as entregas':'recolher'))}"><span class="secchev">${col?IC.chevR:IC.chevD}</span><span class="prjd" style="background:${color}"></span>${esc(label)} <span class="n">${list.length}</span></button>`;
  return `<div class="secgrp cgrp${col?' collapsed':''}" data-sec="${escA('concl:'+k)}">${head}<div class="cgbody" id="${id}"${col?' hidden':''}>${col?'':flowDonePageHtml(k, list, item)}</div></div>`;
}
// table | list (cartões) | grid (redesign p1/p2). Redesenho F1: a Central abre em TABELA (66-central-tabela) — uma vez
// pra quem estava na lista (ou nunca escolheu); quem escolheu a grade continua nela. Depois vale a escolha de cada um
// F4 (D22): a grade saiu — quem estava nela vai pra lista (tabela); a escolha antiga fica guardada em flowView:f4 (nada se perde)
let flowView=(()=>{ const v0=lsGet('flowView'); if(v0==='grid'){ lsSet('flowView:f4', v0); lsSet('flowView','table'); } const v=lsGet('flowView'); if(lsGet('flowViewF1')!=='1'){ lsSet('flowViewF1','1'); if(!v || v==='list'){ lsSet('flowView','table'); return 'table'; } } return v||'table'; })();
// a tabela é da Execução sem agrupar por dia (Concluídas agrupa por projeto; "por dia" agrupa por data): lá ela fica
// indisponível no seletor (com o porquê no tooltip) e o que aparece são os cartões — o seletor não mente
function flowTableOk(){ return flowScope!=='done' && flowGroupBy!=='day'; }
function flowViewEff(){ return (flowView==='table' && !flowTableOk())?'list':flowView; }
// F4 (D25): cabeçalho no padrão de página — "Central" + selo de escopo + a contagem ÚNICA (aguardando você à parte de
// prontas pra revisar — D14) + o chip de coordenação; Concluídas: entregas e PRs do filtro
function centralSumHtml(fc){
  const bits=[`<b>${fc.aguardando}</b> aguardando você`, `<b>${fc.rodando}</b> rodando`];
  if(fc.andamento-fc.rodando>0) bits.push(`<b>${fc.andamento-fc.rodando}</b> em andamento`);
  bits.push(`<b>${fc.prontas}</b> ${fc.prontas===1?'pronta':'prontas'} pra revisar`);
  if(fc.praberto) bits.push(`<b>${fc.praberto}</b> ${fc.praberto===1?'PR aberto':'PRs abertos'}`);
  if(fc.fila) bits.push(`<b>${fc.fila}</b> na fila`);
  return bits.join(' · ');
}
function renderFlowHead(){
  const el=$id('flowHead'); if(!el) return;
  // só troca o DOM se mudou: reescrever a cada render piscava e zerava o #coordChip (preenchido a cada 2s)
  const put=h=>{ if(el.__html===h && el.firstChild) return; el.__html=h; el.innerHTML=h; };
  const fc=flowCounts(projLiveTasks(boardSource())); // régua única (projLiveTasks): não depende do botão Bloqueadas
  let sum;
  if(flowScope==='done'){
    let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); }
    const all=flowVisible(src), canc=all.filter(t=>t.status==='cancelled').length, done=all.filter(t=>t.status!=='cancelled'); const prs=done.filter(t=>t.prUrl).length;
    // cancelada mora em Concluídas, mas NÃO é entrega (contada à parte)
    sum=`<b>${done.length}</b> ${done.length===1?'entrega':'entregas'}${prs?` · <b>${prs}</b> ${prs===1?'PR':'PRs'}`:''}${canc?` · ${canc} ${canc===1?'cancelada':'canceladas'}`:''}`;
  } else sum=centralSumHtml(fc);
  const scope=(typeof projList==='function' && projList().length>1 && projFilter==='all')?'todos os projetos':(projFilter!=='all'?projShort(projFilter):pathBase(state.repo||''));
  put(pageHead({ title:'Central', scope:'computador', scopeLabel:scope, sum, right:'<span id="coordChip" class="coordchip"></span>' }));
}
// % de conclusão da tarefa: fase + requisitos PROVADOS puxam a barra
function taskPct(t){
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return 100;
  if(t.prUrl) return 92;
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  const c=reqProofCache[t.id];
  if(reqs.length && c===undefined){ loadReqProofs(t.id).then(flowRerenderSoon); }
  let reqFrac=null;
  if(reqs.length && c && c.list){ const m=matchReqProofs(reqs, c.list); const done=m.filter(x=>x&&x.status==='done').length; reqFrac=done/reqs.length; }
  if(['review','delivered'].includes(t.status)) return Math.round(80+(reqFrac==null?5:reqFrac*15));
  if(t.status==='draft') return 5;
  if(t.status==='queued') return 15;
  if(t.status==='plan-review') return 25;
  if(t.status==='needs-you') return 50;
  if(['error','conflict','aborted'].includes(t.status)) return 40;
  return Math.round(35+(reqFrac==null?10:reqFrac*40)); // rodando
}
// chips do site local: globo abre aqui · celular cria/fecha o túnel — home e cards
function pvChips(t, withLabel){
  if(t.flag==='closed'||['merged','done'].includes(t.status)) return '';
  const pv=taskPreviewUrl(t.id); if(!pv) return '';
  const tun=(typeof tunnelUp!=='undefined')?tunnelUp[t.id]:null;
  return `<button class="btn sm" data-pvrow="${escA(pv)}" title="abrir o site local que o agente subiu — ${escA(pv)}" style="padding:3px 8px;font-size:var(--fs-xs);color:var(--accent);flex:none">${IC.globe}${withLabel?' preview':''}</button>`+
    `<button class="btn sm" data-pvmob="${escA(t.id)}" data-url="${escA(pv)}" title="${tun?('túnel aberto ('+escA(tun)+') — clique pra FECHAR o acesso do celular'):'abrir este site no seu CELULAR (túnel criptografado)'}" style="padding:3px 8px;font-size:var(--fs-xs);color:${tun?'var(--warn)':'var(--muted)'};flex:none">${IC.phone}</button>`;
}
// ---- Resumo da tarefa: tudo que já foi feito + o que falta ----
async function openTaskSummary(taskId){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  $id('sumOverlay').style.display='flex';
  $id('sumTitle').textContent=t.title;
  $id('sumBody').innerHTML='<div class="dim" style="font-size:var(--fs-sm)">montando o resumo…</div>';
  $id('sumClose').onclick=()=>{ $id('sumOverlay').style.display='none'; };
  if(reqProofCache[t.id]===undefined) await loadReqProofs(t.id).catch(()=>{});
  if(commitsCache[t.id]===undefined) await loadCommits(t.id).catch(()=>{});
  renderTaskSummary(t);
}
function renderTaskSummary(t){
  const pct=taskPct(t);
  // E11b: mesma regra da linha e do workspace — investigação/design (ou entrega só de documentos) não abrem PR
  const sumArtOnly=['invest','design'].includes(taskType(t)) || (typeof entregaNonCode==='function' && entregaNonCode(t));
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
  const notas=eventsOf(t.id).filter(e=>['done','note'].includes(e.type)&&(e.text||'').length>30&&!/^(Você:|perguntou ao humano|humano respondeu)/.test(e.text||'')).slice(-5);
  const li=(arr,ic,co)=>arr.map(x=>`<div style="display:flex;gap:8px;font-size:var(--fs-sm);padding:4px 0"><span style="color:${co};flex:none">${ic}</span><span>${esc(x)}</span></div>`).join('');
  $id('sumBody').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <div style="flex:1;height:8px;border-radius:99px;background:var(--border-strong);overflow:hidden"><i style="display:block;height:100%;width:${pct}%;background:var(--good);border-radius:99px"></i></div>
      <b style="font-size:15px;font-variant-numeric:tabular-nums">${pct}%</b>
    </div>
    <div class="dim" style="font-size:var(--fs-xs);margin-bottom:12px">fase atual: <b>${esc(PHASES[ph-1])}</b> · ${esc(t.branch||'')}${cost.usd>0?' · '+fmtCost(cost.usd):''}</div>
    ${t.objective?`<div class="seclbl2">Objetivo</div><div style="font-size:var(--fs-sm);margin-bottom:12px">${esc(t.objective)}</div>`:''}
    <div class="seclbl2">O que já foi feito</div>
    ${reqs.length?reqs.map((r,i)=>{ const ok=m[i]&&m[i].status==='done'; return `<div style="display:flex;gap:8px;font-size:var(--fs-sm);padding:4px 0"><span style="color:${ok?'var(--good)':'var(--muted)'};flex:none">${ok?IC.ok:IC.stQueue}</span><span${ok?'':' style="color:var(--muted)"'}>${esc(r)}</span>${ok&&m[i].evidence&&m[i].evidence.length?`<span class="dim mono" style="font-size:var(--fs-xs);align-self:center">${esc(String(m[i].evidence[0]).slice(0,28))}</span>`:''}</div>`; }).join(''):''}
    ${dels.length?`<div style="margin-top:6px">${li(dels,icEm(IC.doc),'var(--info)')}</div>`:''}
    <div class="dim" style="font-size:var(--fs-xs);margin:8px 0 12px">${d?`${nPl(diffFiles(d),'arquivo alterado','arquivos alterados')} · +${d.additions||0} −${d.deletions||0}`:'sem diff ainda'} · ${esc(commitsLabel(t))}${rev?' · revisão interna '+IC.ok:''}${t.prUrl?` · PR ${prN?'#'+prN:''} aberto`:''}</div>
    ${notas.length?`<div class="seclbl2">Diário do agente</div>${notas.map(e=>`<div style="display:flex;gap:8px;font-size:var(--fs-sm);padding:3px 0;color:var(--text-2)"><span class="dim" style="flex:none;font-weight:600">${esc((e.agent||'').slice(0,8))}</span><span>${esc(String(e.text).slice(0,140))}</span></div>`).join('')}`:''}
    ${rev?`<div class="seclbl2" style="margin-top:10px">Como testar</div><div style="font-size:var(--fs-sm)">${esc(rev.howToTest||'')}</div>`:''}
    <div class="seclbl2" style="margin-top:14px">O que falta pra finalizar</div>
    ${falta.length?li(falta,IC.chevR,'var(--warn)'):'<div style="font-size:var(--fs-sm);color:var(--good)">nada — pronta pra fechar '+IC.ok+'</div>'}
    <div style="display:flex;gap:8px;margin-top:16px"><span style="flex:1"></span>
      ${['review','delivered'].includes(t.status)&&!t.prUrl&&t.flag!=='closed'?(sumArtOnly
        ?`<button class="btn primary sm" id="sumArch" title="investigação/design não abrem PR — o fim é salvar os entregáveis e concluir">${IC.check} concluir</button>`
        :`<button class="btn primary sm" id="sumPr">${IC.check} aprovar e abrir PR</button>`):''}
      <button class="btn sm" id="sumOpen">abrir a tarefa</button></div>`;
  bindClick('sumOpen', ()=>{ $id('sumOverlay').style.display='none'; selected=t.id; render(); openWorkspace(t.id); });
  bindClick('sumPr', ()=>{ $id('sumOverlay').style.display='none'; approveGate(t); });
  // E11b: investigação/design → o "concluir" leva pra Entrega (salvar entregáveis na pasta), igual ao cabeçalho da tarefa
  bindClick('sumArch', ()=>{ $id('sumOverlay').style.display='none'; selected=t.id; render(); openWorkspace(t.id); setTimeout(()=>{ try{ fwMode='entrega'; renderWorkspace(); }catch(_){ } }, 50); });
}
// R8: oferecer "integrada (merge feito)"? Só quando dá pra SABER que a tarefa tem código: tem PR, ou o diff dela já
// está no snapshot e não é entrega só de documentos. Investigação/design nunca; diff ainda desconhecido (outro projeto,
// snapshot chegando) = escondido. Já integrada = mantém (é o estado atual, o ✓ do menu aponta pra ela).
function taskOffersMerge(t){
  if(!t) return false;
  if(t.status==='merged') return true;
  if(['invest','design'].includes(taskType(t))) return false;
  if(t.prUrl) return true;
  if(!diffOf(t.id)) return false;
  return !(typeof entregaNonCode==='function' && entregaNonCode(t));
}
// R8: opção do menu de status que corresponde ao estado atual (onde vai o ✓) — todo status cai numa opção
// (antes só review/merged/running batiam; asking, erro, pausada, PR aberto… ficavam sem marca)
function stMenuCur(t){
  if(t.status==='cancelled') return 'cancelled';
  if(t.flag==='closed' || t.status==='done') return 'finished';
  if(t.status==='merged') return 'merged';
  if(t.status==='draft') return '';
  const b=flowBucket(t);
  return (b==='prontas'||b==='praberto') ? 'review' : 'running';
}
// menu ⋯ da home: mudar status/flag sem abrir a tarefa
function openTaskMenu(taskId, anchor){
  const t=(state.tasks||[]).find(x=>x.id===taskId);
  // E5 (bug #7): cartão de OUTRO projeto ("Todos os projetos") — antes o ⋯ não fazia nada. Troca pro projeto
  // dono e reabre o menu lá (as ações gravam no banco do projeto ATIVO). O retângulo é guardado antes: o
  // re-render da troca tira o botão original do DOM.
  if(!t){ const r=anchor&&anchor.getBoundingClientRect?anchor.getBoundingClientRect():null;
    crossRun(taskId, ()=>openTaskMenu(taskId, r?{ getBoundingClientRect:()=>r }:anchor)); return; }
  menuClose($id('tmenuPop'));
  const pop=document.createElement('div');
  pop.id='tmenuPop';
  pop.style.cssText='position:fixed;z-index:9000;min-width:210px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:var(--shadow-pop);padding:5px';
  // R8: ícone SVG (IC) + rótulo; antes o glifo ia colado no texto (✓ ◆ ⌥ ❙❙ ▶ ↻ ✕)
  // o slot .mnic existe SEMPRE (vazio quando o item não tem ícone) — senão o rótulo sai desalinhado dos outros.
  // o.stay: o item abre outro menu (trocar modelo) — fecha este e não recarrega o quadro
  const item=(label,fn,danger,icon,o)=>{ const b=document.createElement('button'); o=o||{};
    b.innerHTML='<span class="mnic">'+(icon||'')+'</span>'; b.appendChild(document.createTextNode(label)); if(o.title) b.title=o.title;
    b.style.cssText='display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:'+(danger?'var(--crit)':'var(--text)')+';font:inherit;font-size:var(--fs-sm);padding:8px 10px;border-radius:7px;cursor:pointer';
    b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none';
    b.onclick=async(e)=>{ if(o.stay){ e.stopPropagation(); menuClose(pop); fn(); return; }
      menuClose(pop); try{ await fn(); lastSig=''; await refresh(); }catch(e){ showErr(e, 'Não deu pra mudar a tarefa'); } };
    pop.appendChild(b); };
  const ty=taskType(t);
    // CONCLUIR/ARQUIVAR no topo: é o que tira as investigações/entregas prontas da fila
  if(t.flag!=='closed') item('concluir · sai da fila', ()=>invoke('set_task_flag',{taskId,flag:'closed'}), false, IC.stDone);
  if(t.status!=='draft' && !['merged','done'].includes(t.status) && t.flag!=='closed') item('trocar modelo · '+modelFriendly(t.model), ()=>openModelMenu(taskId, anchor), false, '', { stay:true, title:t.model||'' });
  if(t.flag==='closed') item('reabrir (volta pra fila)', ()=>invoke('set_task_flag',{taskId,flag:null}));
  if(!['review','delivered'].includes(t.status) && t.status!=='merged') item('marcar pronta pra revisar', ()=>invoke('mark_task_status',{taskId,status:'review'}), false, stIcon('review'));
  if(t.status!=='merged' && taskOffersMerge(t)) item('marcar como integrada (merge feito)', ()=>invoke('mark_task_status',{taskId,status:'merged'}), false, icEm(IC.merge));
  // E9 (bug #19): "em andamento" sem processo deixava um card "rodando" fantasma — agora o agente volta a trabalhar (pergunta antes)
  if(['review','delivered'].includes(t.status)) item('voltar pra em andamento · o agente continua', ()=>taskBackToRunning(taskId), false, IC.retry);
  if(t.flag!=='blocked') item('bloquear', ()=>invoke('set_task_flag',{taskId,flag:'blocked'}), false, stIcon('blocked'));
  else item('desbloquear', ()=>invoke('set_task_flag',{taskId,flag:null}), false, IC.unlock);
  if(['error','aborted','conflict'].includes(t.status)){
    item('tentar seguir · continua de onde parou', ()=>invoke('talk_task',{taskId, message:'A execução anterior foi interrompida (timeout de inatividade/erro). CONTINUE de onde você parou: confira git status, git diff, .cardume/PLAN.md e os requisitos em .cardume/TASK.yaml, e finalize o que falta — não recomece do zero. Se for rodar algo demorado, vá reportando progresso pra não ser encerrado por inatividade.', asReq:false, agent:null}), false, IC.retry);
    item('refazer do zero · descarta o parcial', ()=>rerunTask(taskId), false, IC.reset); // E3: com a confirmação do rerunTask
  }
  // E3 (bug #4): abortar só faz sentido com o agente vivo (antes aparecia até em mergeada e trocava 'merged' por 'aborted');
  // e passa pelo abortTask(), que confirma antes
  if(ACTIVE_ST.has(t.status)||t.status==='paused'||t.status==='plan-review'||t.status==='asking'||t.busy) item('interromper agora', ()=>abortTask(taskId), true, stIcon('aborted'));
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6)+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.right-pop.offsetWidth))+'px';
  menuWire(pop, anchor);
}
// R7: menus ⋯ e de status pelo teclado — foco no 1º item, ↑/↓ navega, Esc fecha e devolve o foco a quem abriu,
// Tab sai. O clique fora fecha e o ouvinte do documento sai junto (antes ficava pendurado até o próximo clique).
function menuWire(pop, anchor){
  const items=()=>[...pop.querySelectorAll('button')];
  // quem recebe o foco de volta: o botão/cartão que abriu (no botão direito o alvo é um <span> dentro do cartão)
  const back=(anchor && anchor.closest) ? anchor.closest('[tabindex],button') : null;
  let off=null;
  pop.__close=()=>{ pop.remove(); if(off){ off(); off=null; } };
  pop.setAttribute('role','menu');
  items().forEach(b=>{ if(!b.getAttribute('role')) b.setAttribute('role','menuitem'); b.tabIndex=-1; });
  pop.addEventListener('keydown',e=>{
    const l=items(), i=l.indexOf(document.activeElement);
    if(e.key==='Escape'||e.key==='Tab'){ e.preventDefault(); e.stopPropagation(); pop.__close(); if(back) back.focus(); }
    else if(e.key==='ArrowDown'){ e.preventDefault(); (l[(i+1)%l.length]||l[0]).focus(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); (l[(i-1+l.length)%l.length]||l[0]).focus(); }
  });
  const first=items()[0]; if(first) first.focus({ preventScroll:true });
  setTimeout(()=>{ if(!pop.isConnected) return; const onDoc=(e)=>{ if(!pop.contains(e.target)) pop.__close(); }; document.addEventListener('click',onDoc); off=()=>document.removeEventListener('click',onDoc); },0);
}
// fecha o menu E solta o ouvinte do documento (os itens chamam isto, não pop.remove())
function menuClose(pop){ if(pop && pop.__close) pop.__close(); else if(pop) pop.remove(); }
// dropdown de status direto no chip "Review/Rodando/..." do card
function openStatusMenu(taskId, anchor){
  // tarefa do projeto atual OU de outro projeto (card agregado no board integrado).
  // cross-project: o menu abre com o dado do cache; ao aplicar, troca pro projeto
  // dono e só então grava (mark_task_status/set_task_flag operam no repo ativo).
  let t=(state.tasks||[]).find(x=>x.id===taskId), crossRepo=null;
  if(!t){ const a=(allTasksCache||[]).find(x=>x.id===taskId); if(a){ t=a; crossRepo=(a.repo&&a.repo!==state.repo)?a.repo:null; } }
  if(!t) return;
  const ensureProj=async()=>{ if(crossRepo && window.switchProject){ await window.switchProject(crossRepo); crossRepo=null; } };
  menuClose($id('stmenuPop'));
  const closed = t.flag==='closed';
  const cancelled = t.status==='cancelled';
  // estado "atual" (o ✓): cancelada e encerrada vencem; o resto cai na opção pela etapa (stMenuCur)
  const cur = stMenuCur(t);
  // cada opção: {key, label, col, act()} — status via mark_task_status, finalizar via flag
  const setSt=(status)=>()=>invoke('mark_task_status',{taskId,status});
  const opts=[
    // nomes = STATUS_META (stLabel/stColor); fechar = "concluir" em toda a app
    // E9: "em andamento" chama o agente de novo (pergunta antes); marcar só o status deixava um card "rodando" sem processo
    { key:'running', ic:stIcon('running'), label:'Em andamento',        col:stColor('running'), act:async()=>{ if(!await taskBackToRunning(taskId)) throw null; } },
    { key:'review',  ic:stIcon('review'), label:'Pronta pra revisar',  col:stColor('review'),  act:setSt('review') },
    { key:'merged',  ic:stIcon('merged'), label:'Integrada (merge feito)',            col:stColor('merged'),  act:setSt('merged') },
    { key:'finished',ic:stIcon('done'), label:'Concluir · sai da fila', col:stColor('done'), act:()=>invoke('set_task_flag',{taskId,flag:'closed'}) },
    { key:'cancelled',ic:stIcon('cancelled'), label:'Cancelar · para e sai da fila', col:'var(--crit)', act:async()=>{ await invoke('mark_task_status',{taskId,status:'cancelled'}); await invoke('set_task_flag',{taskId,flag:'closed'}); } },
    // "Rascunho" NÃO entra: rebaixar uma task já iniciada pra draft a tornava
    // não-abrível (o clique ia pro editor) — footgun. Rascunho é só na criação.
  ];
  // R8: tarefa sem código (investigação/design/só documentos) não tem merge — a opção "Integrada" some (Carla: sem sigla de git por padrão)
  if(!taskOffersMerge(t)){ const i=opts.findIndex(o=>o.key==='merged'); if(i>=0) opts.splice(i,1); }
  const pop=document.createElement('div');
  pop.id='stmenuPop';
  pop.style.cssText='position:fixed;z-index:9000;min-width:210px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:var(--shadow-pop);padding:5px';
  opts.forEach(o=>{ const b=document.createElement('button');
    const on=(o.key===cur);
    b.setAttribute('role','menuitemradio'); b.setAttribute('aria-checked', on?'true':'false');
    b.innerHTML=`<span class="mnic" style="color:${o.col}">${o.ic}</span><span>${o.label}</span>${on?`<span style="margin-left:auto;opacity:.7">${IC.ok}</span>`:''}`;
    b.style.cssText='display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:'+(on?'var(--surface-2)':'none')+';color:var(--text);font:inherit;font-size:var(--fs-sm);padding:8px 10px;border-radius:7px;cursor:pointer';
    b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background=(on?'var(--surface-2)':'none');
    b.onclick=async()=>{ menuClose(pop); if(o.key===cur) return; try{ await ensureProj(); await o.act(); if(closed && o.key!=='finished' && o.key!=='cancelled'){ await invoke('set_task_flag',{taskId,flag:null}); } lastSig=''; await refresh(); }catch(e){ if(e!==null) showErr(e, 'Não deu pra mudar o status'); } };
    pop.appendChild(b); });
  // encerrada: oferece reabrir explicitamente no rodapé
  if(closed){ const b=document.createElement('button');
    b.textContent='reabrir (volta pra fila)';
    b.style.cssText='display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--border);margin-top:4px;padding:8px 10px;background:none;color:var(--text);font:inherit;font-size:var(--fs-sm);cursor:pointer';
    b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none';
    b.onclick=async()=>{ menuClose(pop); try{ await ensureProj(); await invoke('set_task_flag',{taskId,flag:null}); lastSig=''; await refresh(); }catch(e){ showErr(e, 'Falhou'); } };
    pop.appendChild(b); }
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6)+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.right-pop.offsetWidth))+'px';
  menuWire(pop, anchor);
}
// a task JÁ foi iniciada (tem PR ou commits)? Se sim, clicar abre o workspace
// mesmo com status 'draft' — senão iria pro editor e não dava pra falar com o agente.
// R3: épico cujas tarefas JÁ começaram todas (fila da nuvem vazia) sumia da Central — o epBoardHtml (46) só monta
// grupo pra épico com cartão na fila. Aqui: um cabeçalho por épico com tarefa local viva e sem cartão na fila,
// reaproveitando o resumo do 46 (epqSummaryHtml: x/y entregues · onda · rodando/em PR… + um ponto por tarefa).
// Entra DENTRO da seção da fila quando ela existe; senão numa seção própria "◆ Épicos em andamento".
function flowEpicGroupsHtml(src, epHtml){
  if(flowScope==='done' || typeof epqSummaryHtml!=='function' || typeof epColor!=='function') return epHtml;
  if(flowStatus!=='all' && flowStatus!=='epicos') return epHtml; // outro chip de status: a fila também sai
  const inQueue=new Set(((typeof epQueueList==='function')?epQueueList(false):[]).map(ct=>ct.epic_id));
  const q=flowQuery.trim().toLowerCase();
  const nameOf=eid=>(typeof epNameOf==='function'&&epNameOf(eid))||'épico';
  const by=new Map();
  for(const t of flowLiveTasks(src)){
    const eid=t.epic&&t.epic.epicId; if(!eid || t._cross || inQueue.has(eid)) continue; // resumo do 46 lê o projeto aberto
    if(flowEpic!=='all' && eid!==flowEpic) continue;
    if(!by.has(eid)) by.set(eid,[]); by.get(eid).push(t);
  }
  if(q) [...by.keys()].forEach(eid=>{ if(!(nameOf(eid).toLowerCase().includes(q) || by.get(eid).some(t=>(t.title||'').toLowerCase().includes(q)))) by.delete(eid); });
  if(!by.size) return epHtml;
  const groups=[...by.keys()].map(eid=>`<div class="epqep" style="--epc:${epColor(eid)}"><div class="epqh" style="cursor:default" title="tarefas deste épico nesta máquina — cada ponto abre uma">`+
    `<span class="secchev">${IC.epic}</span><span class="tsepc epqname">${esc(nameOf(eid))}</span><span class="epqsum">${epqSummaryHtml(eid, 0)}</span><span style="flex:1"></span>${typeof epStartBtnHtml==='function'?epStartBtnHtml(eid, { primary:true }):''}`+
    `<button class="btn sm ghost" data-epqopen="${escA(eid)}" title="abrir a página do épico (checklist, requisitos e todas as tarefas)">abrir</button></div></div>`).join('');
  if(epHtml){
    if(/class="secgrp epqgrp collapsed"/.test(epHtml)) return epHtml; // seção recolhida: nada de corpo
    return epHtml.replace(/<\/div>\s*$/, groups+'</div>');
  }
  const col=flowSecCollapsed('epativos', false);
  return `<div class="secgrp epqgrp${col?' collapsed':''}" data-sec="epativos">${flowSecHead('epativos','Épicos em andamento', by.size, '', col, IC.epic)}${col?'':groups}</div>`;
}
function taskStarted(t){ return !!(t && (t.prUrl || (commitsCache[t.id] && commitsCache[t.id].length))); }
function openOrEdit(t){ if(t.status==='draft' && !taskStarted(t)) editDraft(t); else openWorkspace(t.id); }
function renderFlow(){
  if(flowDragId) return;   // não re-renderiza no meio de um arrasto
  renderFlowHead();
  renderFlowFilters();
  const el=$id("flow");
  // F4 (D20): Concluídas › Resumo do período = o antigo Daily (commits e marcos por tarefa + relatório) no lugar da lista
  { const rs=$id('flowResumo'), on=flowScope==='done' && centralDoneSub==='res';
    if(rs){ rs.hidden=!on; el.hidden=on; if(on){ if(typeof centralResumoMount==='function') centralResumoMount(rs); return; } } }
  el.classList.toggle('gridview', flowView==='grid');
  let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); } // integrado por padrão; fallback pro repo ativo se algo falhar
  const ghost='<div class="fcard ghost" id="ghostNew"><span class="gplus">＋</span><b>Nova demanda</b><span style="font-size:var(--fs-sm)">descreva o que precisa ser feito — o time de agentes cuida do resto</span></div>';
  // monta o HTML numa string (não escreve direto no DOM) pra poder pular o rebuild
  // quando NADA VISÍVEL mudou — senão o poll (evento de agente ativo) reconstruía a
  // lista inteira e o card sob o mouse piscava (pior em Concluídas, onde nada muda).
  let tasks=[], html='', grouped=false; const rendered=[]; let ctTbl=null; // ctTbl: o pedaço da tabela (66), pra ela mexer no lugar
  // fila dos épicos (46): respeita busca/status/tipo/agente/épico lá dentro; entra DEPOIS de
  // "Aguardando você" e "Em andamento" (recolhida por padrão se há algo esperando você)
  const nWaitYou=flowScope==='done'?0:src.filter(t=>flowScopeOk(t)&&flowBucket(t)==='aguardando').length;
  const epHtml=flowEpicGroupsHtml(src, window.epBoardHtml?window.epBoardHtml(flowScope, { waitingYou:nWaitYou }):'')+(window.ctSentHtml?window.ctSentHtml(flowScope):''); // + "Com o time" (46)
  if(!src.length){ html=epHtml+ghost; }
  else {
    const vis=flowVisible(src).slice();
    // ordem manual (arrastar) vale DENTRO de cada seção — antes um único arrasto virava a Central numa lista
    // plana pra sempre. Sem sortOrder (tarefa nova) fica no topo da seção; "restaurar ordem" desliga.
    const manual=lsGet('flowManual')!=='0' && vis.some(t=>t.sortOrder!=null);
    const so=t=>t.sortOrder==null?-1:t.sortOrder;
    // Concluídas: mais recente pela DATA DE CONCLUSÃO (inventário 01 — antes era a de criação)
    const tsOf = flowScope==='done' ? taskDoneTs : taskTs;
    tasks = manual && flowScope!=='done'
      ? vis.sort((a,b)=> so(a)-so(b) || taskTs(b)-taskTs(a))
      : vis.sort((a,b)=> tsOf(b)-tsOf(a));
    // R7: vazio com saída. Antes: "nenhuma tarefa neste filtro." sem botão — e, com a fila dos épicos na tela,
    // nem isso (os épicos apareciam sozinhos e parecia que o filtro tinha falhado)
    if(!tasks.length){ html = (flowStatus==='epicos' && epHtml) ? epHtml : flowEmptyHtml()+epHtml; }
    else {
      grouped = flowGroupBy==='day';
      const item0 = flowView==='grid' ? ((t,acc)=>flowTaskCard(t,acc)) : ((t)=>flowDemandCard(t));
      const item = (t,acc)=>{ rendered.push(t); return item0(t,acc); }; // anota o que foi de fato desenhado (só esses carregam)
      const isDone = flowScope==='done';
      // Concluídas: sempre por projeto (mesmo com um só) — cada projeto recolhe sozinho e pagina de 12 em 12
      const byProject = isDone;
      if(grouped){
        const g=new Map();
        // Concluídas por dia: pagina a lista inteira (12 por vez) antes de agrupar
        const dayN = isDone ? flowDoneN('dia', tasks.length) : tasks.length;
        for(const t of tasks.slice(0, dayN)){ const d=new Date(isDone?taskDoneTs(t):taskTs(t)); const k=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); if(!g.has(k)) g.set(k,[]); g.get(k).push(t); }
        const keys=[...g.keys()].sort((a,b)=>b-a);
        html = keys.map(k=>`<div class="daygrp"><div class="dayh">${esc(dayLabel(k))} <span class="dayn">${nPl(g.get(k).length,'tarefa')}</span></div>${g.get(k).map(t=>item(t)).join("")}</div>`).join("")
          + (isDone ? flowDoneMoreHtml('dia', tasks.length, dayN) : '') + epHtml;
      } else if(byProject){
        const g=new Map();
        for(const t of tasks){ const k=t.repo||state.repo||''; if(!g.has(k)) g.set(k,[]); g.get(k).push(t); }
        // um grupo por projeto: abre por padrão, recolhe por projeto, 12 cartões por vez
        html = [...g.entries()].map(([k,list])=>flowDoneGroupHtml(k, projShort(k), projColor(k), list, item)).join("");
      } else if(flowViewEff()==='table' && typeof ctHtml==='function'){
        // redesenho F1: tabela ordenável (a fila dos épicos continua em cima, como nas seções)
        tasks.forEach(t=>rendered.push(t));
        ctTbl = ctHtml(tasks); html = epHtml + ctTbl;
      } else {
        const by={}; for(const t of tasks){ (by[flowBucket(t)] ||= []).push(t); }
        html = FLOW_SECS.map(([k,label,tone,acc])=>{
          // a fila dos épicos entra logo antes de "Prontas pra revisar" (= depois de Aguardando você/Em andamento)
          const pre = k==='prontas' ? epHtml : '';
          const list=by[k]||[]; if(!list.length) return pre;
          const col=flowSecCollapsed(k, false);
          const cards=col?'':list.map(t=>item(t, acc)).join(""); // recolhida: nem monta os cartões
          return pre+`<div class="secgrp${col?' collapsed':''}" data-sec="${escA(k)}">${flowSecHead(k, label, list.length, tone, col)}${cards}</div>`;
        }).join("") + ghost;
      }
    }
  }
  // planos do orquestrador entram no topo em QUALQUER ordenação/agrupamento (sem busca ativa)
  if(window.orqBoardHtml && !flowQuery.trim()) html=window.orqBoardHtml(flowScope)+html;
  if(typeof CT!=='undefined') CT.last=ctTbl!=null?{ pre:html.slice(0, html.length-ctTbl.length) }:null;
  // idêntico ao último render E o DOM ainda tem o conteúdo → não reconstrói (sem piscar)
  if(html===flowLastHtml && el.firstChild) return;
  el.innerHTML=html; flowLastHtml=html;
  if(window.orqWireOpeners) window.orqWireOpeners(el);
  if(window.epWireBoard) window.epWireBoard(el);
  // B4: cabeçalho de seção recolhe/expande (estado salvo por seção; vale pra fila dos épicos também)
  el.querySelectorAll('[data-sectog]').forEach(h=>{
    h.onclick=(e)=>{ e.stopPropagation(); const k=h.dataset.sectog; const was=h.getAttribute('aria-expanded')==='false'; lsSet('sec:col:'+k, was?'0':'1'); lastSig=''; renderFlow(); };
    h.onkeydown=(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); h.onclick(e); } };
  });
  // Concluídas: recolher/abrir grupo do projeto, mostrar mais 12, voltar às 12 — devolve o foco ao mesmo controle
  const refocus=(sel)=>{ const b=el.querySelector(sel); if(b) b.focus(); };
  el.querySelectorAll('[data-donetog]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const k=b.dataset.donetog; flowDoneSetCollapsed(k, b.getAttribute('aria-expanded')==='true'); lastSig=''; renderFlow(); refocus(`[data-donetog="${CSS.escape(k)}"]`); });
  el.querySelectorAll('[data-donemore]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const k=b.dataset.donemore; flowDoneShow[k]=Math.max(FLOW_DONE_PAGE, flowDoneShow[k]||FLOW_DONE_PAGE)+FLOW_DONE_PAGE; lastSig=''; renderFlow(); refocus(`[data-donemore="${CSS.escape(k)}"]`); });
  el.querySelectorAll('[data-doneless]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const k=b.dataset.doneless; delete flowDoneShow[k]; lastSig=''; renderFlow(); const h=el.querySelector(`[data-donetog="${CSS.escape(k)}"]`)||el.querySelector(`[data-donemore="${CSS.escape(k)}"]`); if(h){ h.focus(); h.scrollIntoView({block:'nearest'}); } });
  bindClick('ghostNew', ()=>{ if(window.openTab) window.openTab('nova'); else openNewTask(); });
  bindClick('flowClearFilters', flowClearFilters);
  bindClick('flowClearAll', ()=>{ flowQuery=''; const a=$id('topSearch'); if(a) a.value=''; const b=$id('ffSearch'); if(b) b.value=''; flowClearFilters(); });
  bindClick('flowEmptyNew', ()=>{ if(window.openTab) window.openTab('nova'); else openNewTask(); });
  bindClick('flowClearSearch', ()=>{ flowQuery=''; const a=$id('topSearch'); if(a) a.value=''; const b=$id('ffSearch'); if(b) b.value=''; lastSig=''; renderFlow(); });
  if(typeof ctWire==='function' && el.querySelector('.cttable')) ctWire(el, src); // 66-central-tabela: ordenar, abrir a linha, teclado
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
  // R7: cartões pelo teclado — Tab chega neles, Enter/Espaço abre, a tecla de menu (ou Shift+F10) abre o ⋯
  el.querySelectorAll('.frow,.dcard,.fcard').forEach(r=>{
    if(!r.hasAttribute('tabindex')) r.tabIndex=0;
    // focável e clicável → leitor de tela anuncia como botão, com nome curto (o cartão inteiro como nome era um parágrafo)
    if(!r.hasAttribute('role')){ r.setAttribute('role','button');
      const tt=r.querySelector('.dc-title,.ti,.ftitle,b'); if(tt && !r.hasAttribute('aria-label')) r.setAttribute('aria-label', (r.id==='ghostNew'?'':'abrir a demanda: ')+tt.textContent.trim()); }
    r.onkeydown=(e)=>{ if(e.target!==r) return;
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); r.click(); }
      else if(r.dataset.id && (e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10'))){ e.preventDefault(); openTaskMenu(r.dataset.id, r); } };
  });
  el.querySelectorAll('[data-rowplay]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.rowplay; crossRun(id, ()=>startTask(id)); }); // L13: rascunho de outro projeto troca pro dono antes
  // aprovar pelo card passa pelo MESMO portão do cabeçalho (prova → verificação → PR) — antes pulava direto pro PR
  const taskOfId=(id)=>(state.tasks||[]).find(x=>x.id===id);
  el.querySelectorAll('[data-rowpr]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.rowpr; crossRun(id, ()=>approveGate(taskOfId(id))); });
  el.querySelectorAll('[data-rowproof]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.rowproof; crossRun(id, ()=>proofAsk(taskOfId(id), b)); });
  el.querySelectorAll('[data-rownoproof]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.rownoproof; crossRun(id, ()=>approveNoProof(taskOfId(id))); });
  el.querySelectorAll('[data-resolveconf]').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); if(!await askYes('A IA vai mergear a base e resolver os conflitos nesta worktree (sem push). Você revisa o resultado e mergeia. Continuar?')) return; b.disabled=true; b.textContent='resolvendo…'; try{ await invoke('resolve_conflict',{ taskId:b.dataset.resolveconf }); lastSig=''; await refresh(); }catch(err){ showErr(err, 'Falhou'); b.disabled=false; } });
  // "✓ concluir" grava a flag no banco do projeto DONO da tarefa (crossRun troca antes, se for de outro projeto)
  el.querySelectorAll('[data-arch]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.arch; crossRun(id, async()=>{ try{ await invoke('set_task_flag',{taskId:id,flag:'closed'}); lastSig=''; await refresh(); toast('concluída — saiu da fila','ok'); }catch(err){ showErr(err, 'Não deu pra concluir'); } }); });
  el.querySelectorAll('[data-pvrow]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); invoke('open_url',{ url:b.dataset.pvrow }).catch(()=>{}); });
  // botão do celular da home: cria o túnel pro celular (ou fecha, se já estiver aberto)
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
  el.querySelectorAll('[data-sum]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.sum; crossRun(id, ()=>openTaskSummary(id)); });
  el.querySelectorAll('[data-dcopen]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const t=src.find(x=>x.id===b.dataset.dcopen); if(!t) return; if(t._cross && t.repo && t.repo!==state.repo){ switchToProjectTask(t.repo, t.id); return; } const go=()=>{ selected=t.id; render(); openOrEdit(t); }; const src0=b.closest('tr[data-ctrow],.fcard,.dcard'); const ti=src0&&src0.querySelector('.cttx,.ftitle,.dc-title');
    if(typeof mvOpen==='function') mvOpen(ti, go); else go(); }); // rascunho abre o editor (igual ao Enter da linha da tabela); F3: o título voa até a aba
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
    card.addEventListener('drop',e=>{ e.preventDefault(); const tgt=card.dataset.id; const drag=flowDragId; flowDragId=null; if(drag&&drag!==tgt){ lsSet('flowManual','1'); reorderFlow(drag,tgt); } });
  });
  el.querySelectorAll('.fcommit').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openCommit(b.dataset.hash); });
  el.querySelectorAll('[data-ctog]').forEach(h=>h.onclick=(e)=>{ e.stopPropagation(); const id=h.dataset.ctog; if(flowCommitsOpen.has(id)) flowCommitsOpen.delete(id); else flowCommitsOpen.add(id); lastSig=''; renderFlow(); });
  // resultado chega depois: só marca sujo — o refresh redesenha respeitando a trava de clique (uiHoldUntil)
  // Concluídas: só os cartões desenhados buscam commits (grupo recolhido / páginas seguintes não custam nada)
  for(const t of (flowScope==='done'?rendered:tasks)){ if(commitsNeedLoad(t.id) && !commitsLoading[t.id]){ const before=JSON.stringify(commitsCache[t.id]||null); loadCommits(t.id).then(c=>{ if(JSON.stringify(c||null)!==before) lastSig=''; }); } }
}
