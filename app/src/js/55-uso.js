/* ===== ABA "USO": quanto cada parte do Starfork gasta (spec-aba-uso) =====
   Lê o livro-razão local (~/.constellation/usage/usage.sqlite) pelo Rust: `usage_report(period, project?, since?)`
   (totais, por origem, por IA, por projeto e tarefas — com o histórico da tabela `cost` sem duplicar; testes de conexão
   à parte) e `usage_task_detail(taskId, project?)` (por etapa/agente e por rodada). Nada é varrido aqui no front.
   Custo: "informado" (o Claude diz quanto custou) × "estimado por tokens" (Codex/DeepSeek/gateway, tabela única
   src/usage-prices.json). Em plano de assinatura o valor é o equivalente em API, não cobrança. Aba, não modal. */

// @uso-puro-inicio
const USO_SOURCES={
  'tarefa':'Tarefas', 'nova-tarefa':'Nova tarefa (planner e spec com IA)', 'personas':'Personas (mesa)',
  'chat-projeto':'Chat do projeto', 'chat-issues':'Chat de issues', 'orquestrador':'Orquestrador',
  'retro':'Retro e aprendizados', 'previsao':'Previsão', 'titulo-branch':'Título e nome de branch',
  'commit-pr':'Commit e PR', 'relatorios':'Relatórios', 'teste':'Testes de conexão', 'autopilot':'Piloto automático', 'outros':'Outros',
};
const USO_ENGINES={ claude:'Claude Code', codex:'Codex', deepseek:'DeepSeek', gateway:'Gateway' };
const USO_PERIODS=[['hoje','hoje'],['7d','7 dias'],['30d','30 dias']];
const USO_SUB_NOTE='Em plano de assinatura (Claude Max, ChatGPT) o valor é o equivalente em API — não é cobrança.';
// voltar pra aba depois disto relê o relatório (a aba guarda o estado entre trocas)
const USO_STALE_MS=60000;
function usoSourceLabel(s){ return USO_SOURCES[s]||USO_SOURCES.outros; }
function usoEngineLabel(e){ return USO_ENGINES[e]||String(e||'outro'); }
// meia-noite local de hoje (o Rust não sabe o fuso): "hoje" começa aqui
function usoSinceFor(period, now){ if(period!=='hoje') return null; const d=new Date(now); d.setHours(0,0,0,0); return d.getTime(); }
// rótulo do custo: tudo informado, tudo estimado ou misto
function usoCostKind(a){
  const usd=+((a&&a.usd)||0), est=+((a&&a.usdEstimated)||0);
  if(usd<=0) return '';
  if(est<=0) return 'informado';
  if(est>=usd-1e-9) return 'estimado';
  return 'misto';
}
const USO_KIND_TXT={ informado:'custo informado', estimado:'estimado por tokens', misto:'parte estimada por tokens' };
const USO_KIND_TIP={
  informado:'Custo informado pelo próprio Claude Code.',
  estimado:'Codex, DeepSeek e gateway não informam preço: estimado pelos tokens (entrada, cache e saída) × tabela de preço do Starfork.',
  misto:'Soma de custo informado (Claude) com custo estimado por tokens (outros motores).',
};
function usoKindTag(a){ const k=usoCostKind(a); return k?`<span class="uso-tag uso-${k}" title="${escA(USO_KIND_TIP[k])}">${esc(USO_KIND_TXT[k])}</span>`:''; }
function usoTok(n){ n=+n||0; if(n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1).replace('.',',')+' mi'; if(n>=1e3) return (n/1e3).toFixed(n>=1e4?0:1).replace('.',',')+' mil'; return String(n); }
function usoDur(ms){ ms=+ms||0; if(ms<1000) return ms?ms+' ms':'—'; const s=Math.round(ms/1000); if(s<60) return s+' s'; const m=Math.round(s/60); return m<60?m+' min':Math.floor(m/60)+'h'+String(m%60).padStart(2,'0'); }
function usoWhen(at){ const d=new Date(+at||0); const p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}/${p(d.getMonth()+1)} ${p(d.getHours())}:${p(d.getMinutes())}`; }
// UM formato de dinheiro na aba toda (US$ com o equivalente em R$)
function usoMoney(a){ return esc(fmtCost(+((a&&a.usd)||0))); }
function usoUsd(v){ return esc(fmtCost(+v||0)); }
// barras horizontais (largura = parte do maior valor)
function usoBars(list, labelOf, cls){
  if(!list||!list.length) return '<div class="dim uso-none">nada neste período</div>';
  const max=Math.max(...list.map(x=>+x.usd||0), 1e-9);
  return '<div class="uso-bars'+(cls?' '+cls:'')+'">'+list.map(x=>{
    const pct=Math.max(2, Math.round((+x.usd||0)/max*100));
    const lbl=labelOf(x);
    return `<div class="uso-bar" role="group" aria-label="${escA(lbl+': '+fmtCost(+x.usd||0))}">`
      +`<div class="uso-bl"><span class="uso-name">${esc(lbl)}</span><span class="uso-val">${usoMoney(x)}</span></div>`
      +`<div class="uso-track"><div class="uso-fill uso-f-${usoCostKind(x)||'zero'}" style="width:${(+x.usd||0)>0?pct:0}%"></div></div>`
      +`<div class="uso-sub dim">${x.calls} chamada${x.calls===1?'':'s'} · ${usoTok(x.inTok)} entrada${+x.cachedTok>0?` (${usoTok(x.cachedTok)} do cache)`:''} · ${usoTok(x.outTok)} saída ${usoKindTag(x)}</div></div>`;
  }).join('')+'</div>';
}
// período: botões simples com aria-pressed (sem radiogroup — Tab normal entre eles)
function usoPeriodSeg(cur){
  return '<div class="uso-seg" role="group" aria-label="Período">'+USO_PERIODS.map(([v,l])=>
    `<button type="button" aria-pressed="${cur===v}" class="${cur===v?'on':''}" data-uso-period="${v}">${l}</button>`).join('')+'</div>';
}
function usoProjectSel(projects, cur){
  const opts=['<option value="">todos os projetos</option>'].concat((projects||[]).filter(p=>p.project).map(p=>
    `<option value="${escA(p.project)}"${p.project===cur?' selected':''}>${esc(p.name||p.project)}</option>`));
  return `<select class="uso-proj" data-uso-project aria-label="Projeto">${opts.join('')}</select>`;
}
// estado vazio / erro / relatório
function usoHtml(d, st){
  st=st||{};
  const head=`<div class="uso-top">${usoPeriodSeg(st.period||'7d')}${usoProjectSel(st.projects||[], st.project||'')}<span style="flex:1"></span>`
    +`<button type="button" class="btn sm" data-uso-reload title="ler de novo">atualizar</button></div>`;
  if(st.err) return head+`<div class="ld-empty ld-err" role="alert"><b>${esc(st.err)}</b><div class="ld-acts"><button type="button" class="btn sm" data-uso-reload>tentar de novo</button></div></div>`;
  if(!d) return head+'<div class="dim uso-none">carregando…</div>';
  const t=d.totals||{}, tests=d.tests||{};
  const testsLine=(+tests.calls>0)?`<p class="uso-note dim">Testes de conexão (fora do total): ${usoUsd(tests.usd)} em ${tests.calls} chamada${tests.calls===1?'':'s'}.</p>`:'';
  if(!t.calls) return head+`<div class="ld-empty uso-empty"><b>Nenhum uso de IA registrado ${st.period==='hoje'?'hoje':'neste período'}</b>`
    +`<p>Cada chamada de IA do Starfork (tarefas, planner, personas, chats, retro, títulos, commits, relatórios) entra aqui com tokens e custo. `
    +`Tarefas de antes deste registro aparecem pelo histórico de custo delas.</p></div>`+testsLine;
  const tot=`<div class="uso-tot">`
    +`<div class="uso-big"><span class="dim">gasto ${st.period==='hoje'?'hoje':st.period==='30d'?'em 30 dias':'em 7 dias'}</span><b>${usoMoney(t)}</b>${usoKindTag(t)}</div>`
    +`<div class="uso-kpi"><span class="dim">informado</span><b>${usoUsd(t.usdReported)}</b></div>`
    +`<div class="uso-kpi"><span class="dim">estimado por tokens</span><b>${usoUsd(t.usdEstimated)}</b></div>`
    +`<div class="uso-kpi"><span class="dim">chamadas</span><b>${t.calls}</b></div>`
    +`<div class="uso-kpi"><span class="dim">tokens</span><b>${usoTok((+t.inTok||0)+(+t.outTok||0))}</b></div></div>`
    +`<p class="uso-note dim">${esc(USO_SUB_NOTE)}</p>`+testsLine;
  const tasks=(d.tasks||[]);
  const total=Math.max(+d.tasksTotal||0, tasks.length);
  const more=total>tasks.length?`<p class="uso-note dim">mostrando ${tasks.length} de ${total} tarefas (as que mais gastaram)</p>`:'';
  const tlist=tasks.length?'<div class="uso-tasks" role="list">'+tasks.map(x=>
      `<div role="listitem"><button type="button" class="uso-task" data-uso-task="${escA(x.taskId)}" data-uso-tproj="${escA(x.project||'')}" title="ver o detalhe por etapa e rodada">`
      +`<span class="uso-tt">${esc(x.title||x.taskId)}</span><span class="uso-tp dim">${esc(x.projectName||'')}${x.legacy?' · histórico':''}</span>`
      +`<span class="uso-tv">${usoMoney(x)}</span><span class="uso-tm dim">${x.calls} turno${x.calls===1?'':'s'} · ${usoTok((+x.inTok||0)+(+x.outTok||0))} tokens · ${usoDur(x.ms)}</span>${usoKindTag(x)}</button></div>`).join('')+'</div>'+more
    :'<div class="dim uso-none">nenhuma tarefa gastou neste período</div>';
  return head+tot
    +`<div class="uso-grid"><section class="uso-card"><h3>Por origem</h3>${usoBars(d.bySource, x=>usoSourceLabel(x.source))}</section>`
    +`<section class="uso-card"><h3>Por IA</h3>${usoBars(d.byEngine, x=>usoEngineLabel(x.engine), 'uso-small')}`
    +`<h3>Por projeto</h3>${usoBars(d.byProject, x=>x.name||'sem projeto', 'uso-small')}</section></div>`
    +`<section class="uso-card"><h3>Tarefas <span class="dim">(ordenadas por gasto)</span></h3>${tlist}</section>`;
}
// detalhe de UMA tarefa: por etapa/agente e por rodada
function usoDetailHtml(d){
  if(!d) return '';
  const roles=(d.byRole||[]).map(r=>`<tr><td>${esc(r.role)}</td><td>${esc((r.engines||[]).map(usoEngineLabel).join(', '))}</td><td class="num">${r.calls}</td>`
    +`<td class="num">${usoTok(r.inTok)}</td><td class="num">${usoTok(r.outTok)}</td><td class="num">${usoDur(r.ms)}</td><td class="num">${usoMoney(r)} ${usoKindTag(r)}</td></tr>`).join('');
  const rounds=(d.rounds||[]).map((r,i)=>`<tr${r.ok===false?' class="uso-fail"':''}><td class="num">${i+1}</td><td>${esc(usoWhen(r.at))}</td><td>${esc(r.role||'agente')}</td>`
    +`<td>${esc(usoEngineLabel(r.engine))}${r.model?` <span class="dim">${esc(r.model)}</span>`:''}</td><td class="num">${usoTok(r.inTok)}</td><td class="num">${usoTok(r.outTok)}</td>`
    +`<td class="num">${usoDur(r.ms)}</td><td class="num">${usoUsd(r.usd)}${r.estimated?' <span class="uso-tag uso-estimado" title="'+escA(USO_KIND_TIP.estimado)+'">estimado</span>':''}${r.legacy?' <span class="dim">· histórico</span>':''}</td></tr>`).join('');
  return `<div class="uso-det"><div class="uso-dethead"><button type="button" class="btn sm" data-uso-back>← voltar</button><b>${esc(d.title||d.taskId)}</b>`
    +`<span class="dim">${usoMoney(d.totals)}</span>${usoKindTag(d.totals)}</div>`
    +`<section class="uso-card"><h3>Por etapa / agente</h3>${roles?`<table class="uso-tab"><thead><tr><th>agente</th><th>IA</th><th class="num">turnos</th><th class="num">entrada</th><th class="num">saída</th><th class="num">tempo</th><th class="num">custo</th></tr></thead><tbody>${roles}</tbody></table>`:'<div class="dim uso-none">sem turnos registrados</div>'}</section>`
    +`<section class="uso-card"><h3>Rodadas</h3>${rounds?`<table class="uso-tab"><thead><tr><th class="num">#</th><th>quando</th><th>agente</th><th>IA</th><th class="num">entrada</th><th class="num">saída</th><th class="num">tempo</th><th class="num">custo</th></tr></thead><tbody>${rounds}</tbody></table>`:'<div class="dim uso-none">sem rodadas</div>'}</section>`
    +`<p class="uso-note dim">${esc(USO_SUB_NOTE)}</p></div>`;
}
// @uso-puro-fim

const USO_PERIOD_KEY='usoPeriod';
const USO={ period:(typeof lsGet==='function'&&lsGet(USO_PERIOD_KEY))||'7d', project:'', data:null, err:'', projects:[], detail:null, detailErr:'', seq:0, at:0 };
function usoBody(){ return document.getElementById('usoBody'); }
function usoRender(){
  const el=usoBody(); if(!el) return;
  if(USO.detail){
    el.innerHTML=USO.detailErr
      ? `<div class="uso-det"><div class="uso-dethead"><button type="button" class="btn sm" data-uso-back>← voltar</button></div><div class="ld-empty ld-err" role="alert"><b>${esc(USO.detailErr)}</b></div></div>`
      : (USO.detail.data?usoDetailHtml(USO.detail.data):'<div class="dim uso-none">carregando o detalhe…</div>');
    return;
  }
  el.innerHTML=usoHtml(USO.data, USO);
}
function usoErrText(e){
  if(typeof humanErr==='function'){ try{ const h=humanErr(e, 'Não consegui ler o uso'); if(h&&h.msg) return h.msg; }catch(_){ } }
  return String((e&&e.message)||e||'Não consegui ler o uso');
}
function usoCall(){ return typeof invokeQuiet==='function'?invokeQuiet:invoke; }
// leitura do relatório: só a resposta da ÚLTIMA leitura pedida vale (trocar de período no meio não mistura)
async function usoLoad(){
  const seq=++USO.seq;
  USO.err='';
  let d=null, err='';
  try{ d=await usoCall()('usage_report', { period:USO.period, project:USO.project||null, since:usoSinceFor(USO.period, Date.now()) }); }
  catch(e){ err=usoErrText(e); }
  if(seq!==USO.seq) return; // chegou uma resposta velha
  USO.data=err?null:(d||null); USO.err=err; USO.at=Date.now();
  if(d && Array.isArray(d.projects)) USO.projects=d.projects; // todos os projetos conhecidos, não só os que gastaram
  usoRender();
}
async function usoOpenTask(taskId, project){
  USO.detail={ taskId, project, data:null }; USO.detailErr=''; usoRender();
  const mine=()=>USO.detail && USO.detail.taskId===taskId; // o usuário pode ter voltado/aberto outra tarefa
  try{ const d=await usoCall()('usage_task_detail', { taskId, project:project||null }); if(!mine()) return; USO.detail.data=d; }
  catch(e){ if(!mine()) return; USO.detailErr=usoErrText(e); }
  usoRender();
}
function usoWire(){
  const el=usoBody(); if(!el || el.__usoWired) return;
  el.__usoWired=true;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest&&ev.target.closest('[data-uso-period],[data-uso-reload],[data-uso-task],[data-uso-back]'); if(!b) return;
    if(b.dataset.usoPeriod){ USO.period=b.dataset.usoPeriod; if(typeof lsSet==='function') lsSet(USO_PERIOD_KEY, USO.period); USO.data=null; usoRender(); usoLoad(); }
    else if(b.hasAttribute('data-uso-reload')){ usoLoad(); }
    else if(b.dataset.usoTask){ usoOpenTask(b.dataset.usoTask, b.dataset.usoTproj||''); }
    else if(b.hasAttribute('data-uso-back')){ USO.detail=null; USO.detailErr=''; usoRender(); }
  });
  el.addEventListener('change', ev=>{
    const s=ev.target.closest&&ev.target.closest('[data-uso-project]'); if(!s) return;
    USO.project=s.value||''; USO.data=null; usoRender(); usoLoad();
  });
}
// abrir/voltar pra aba: com dados de menos de 1 min só mostra (mantém o detalhe aberto); mais velhos → relê
async function openUso(){
  const ov=document.getElementById('usoOverlay'); if(!ov) return;
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  usoWire();
  if(USO.data && Date.now()-USO.at < USO_STALE_MS){ usoRender(); return; }
  usoRender();
  await usoLoad();
}
window.openUso=openUso;
// "ver uso detalhado" (medidor do plano) e o item do menu "Mais"
function usoOpenTab(){ const mm=document.getElementById('moreMenu'); if(mm) mm.style.display='none'; if(window.openTab) window.openTab('uso'); else openUso(); }
window.usoOpenTab=usoOpenTab;
if(typeof bindClick==='function'){
  bindClick('usoBtn', usoOpenTab);
  bindClick('usoClose', ()=>{ if(typeof ovHide==='function') ovHide('usoOverlay'); });
}
