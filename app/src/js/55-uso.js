/* ===== PÁGINA "USO": quanto cada parte do Starfork gasta (spec-aba-uso + redesenho F4 · G3) =====
   Lê o livro-razão local (~/.constellation/usage/usage.sqlite) pelo Rust: `usage_report(period, project?, since?, engine?)`
   (totais, por origem, por IA, por projeto e tarefas — com o histórico da tabela `cost` sem duplicar; testes de conexão
   à parte) e `usage_task_detail(taskId, project?)` (por etapa/agente e por rodada). Nada é varrido aqui no front.
   F4: filtros período · projeto · IA; total "US$ X (≈ R$ Y)" (fmtUsdBr — US$ é a verdade); selos técnicos (informado ×
   estimado, tokens, cache) só em "ver detalhes"; a tarefa abre NA PRÓPRIA LINHA; "Limites do plano" = o mesmo número do
   medidor da lateral. Em plano de assinatura o valor é o equivalente em API, não cobrança. Aba, não modal. */

// @uso-puro-inicio
const USO_SOURCES={
  'tarefa':'Tarefas', 'nova-tarefa':'Nova demanda (conversa e formulário)', 'personas':'Fábrica · personas (ex-Mesa)',
  'chat-projeto':'Conversa do projeto', 'chat-issues':'Nova issue', 'orquestrador':'Etapas (várias tarefas)',
  'retro':'Revisão e aprendizados', 'previsao':'Previsão', 'titulo-branch':'Títulos e nomes de branch',
  'commit-pr':'Commit e PR', 'relatorios':'Resumo do período', 'teste':'Testes de conexão', 'autopilot':'Construir sozinho · ex-piloto automático', 'ideia':'Fábrica de apps e features · ex-Ideia', 'fabrica':'Fábrica de apps e features', 'outros':'Outros',
};
const USO_ENGINES={ claude:'Claude Code', codex:'Codex', deepseek:'DeepSeek', gateway:'IA da sua empresa' };
const USO_PERIODS=[['hoje','Hoje'],['7d','7 dias'],['30d','30 dias']];
const USO_SUB_NOTE='Em plano de assinatura (Claude Max, ChatGPT) o valor é o equivalente em API — não é cobrança.';
// voltar pra aba depois disto relê o relatório (a aba guarda o estado entre trocas)
const USO_STALE_MS=60000;
function usoSourceLabel(s){ return USO_SOURCES[s]||USO_SOURCES.outros; }
function usoEngineLabel(e){ return USO_ENGINES[e]||String(e||'outro'); }
function usoPeriodTxt(p){ return p==='hoje'?'hoje':p==='30d'?'em 30 dias':'em 7 dias'; }
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
// dinheiro: total/cabeçalho com o ≈ R$ (fmtUsdBr, D13); célula de tabela/barra só US$
function usoFmt(v, cell){ v=+v||0; return (typeof fmtUsdBr==='function')?fmtUsdBr(v, cell?{usdOnly:true}:undefined):fmtCost(v, cell?{usdOnly:true}:undefined); }
function usoMoney(a){ return esc(usoFmt(+((a&&a.usd)||0))); }
function usoCell(a){ return esc(usoFmt(+((a&&a.usd)||0), true)); }
function usoUsd(v){ return esc(usoFmt(v)); }
// barras horizontais (largura = parte do maior valor); a linha técnica só aparece com "ver detalhes"
function usoBars(list, labelOf, cls){
  if(!list||!list.length) return '<div class="dim uso-none">nada neste período</div>';
  const max=Math.max(...list.map(x=>+x.usd||0), 1e-9);
  return '<div class="uso-bars'+(cls?' '+cls:'')+'">'+list.map(x=>{
    const pct=Math.max(2, Math.round((+x.usd||0)/max*100));
    const lbl=labelOf(x);
    return `<div class="uso-bar" role="group" aria-label="${escA(lbl+': '+usoFmt(+x.usd||0, true))}">`
      +`<span class="uso-name" title="${escA(lbl)}">${esc(lbl)}</span>`
      +`<span class="uso-track"><i class="uso-fill${/^(fabrica|ideia|personas)$/.test(x.source||'')?' hi':''}" style="width:${(+x.usd||0)>0?pct:0}%"></i></span><span class="uso-val">${usoCell(x)}</span>`
      +`<span class="uso-sub uso-tech dim">${x.calls} chamada${x.calls===1?'':'s'} · ${usoTok(x.inTok)} entrada${+x.cachedTok>0?` (${usoTok(x.cachedTok)} do cache)`:''} · ${usoTok(x.outTok)} saída ${usoKindTag(x)}</span></div>`;
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
function usoEngineSel(cur){
  return `<select class="uso-proj" data-uso-engine aria-label="IA"><option value="">todas as IAs</option>${Object.keys(USO_ENGINES).map(k=>`<option value="${k}"${k===cur?' selected':''}>${esc(USO_ENGINES[k])}</option>`).join('')}</select>`;
}
// cabeçalho padrão da página (pageHead, G1) com o total "US$ X (≈ R$ Y)"
function usoHead(t, st){
  const sum=t&&t.calls?`<span class="pgh-sumv">· <b>${usoMoney(t)}</b> ${esc(usoPeriodTxt(st.period||'7d'))}</span>`:'';
  const right='<button type="button" class="btn sm quiet" data-uso-reload title="ler de novo">atualizar</button>';
  return (typeof pageHead==='function')?pageHead({ title:'Uso', scope:'computador', sum, sub:'Quanto cada parte do Starfork gastou com IA. '+USO_SUB_NOTE, right })
    :`<header class="pghead"><div class="pgh-t"><h1 class="pgh-title">Uso</h1>${sum}<span class="pgh-sp"></span>${right}</div><p class="pgh-sub">${esc(USO_SUB_NOTE)}</p></header>`;
}
// estado vazio / erro / relatório
function usoHtml(d, st){
  st=st||{};
  const bar=`<div class="uso-top">${usoPeriodSeg(st.period||'7d')}${usoProjectSel(st.projects||[], st.project||'')}${usoEngineSel(st.engine||'')}<span style="flex:1"></span>`
    +`<button type="button" class="ajlink" data-uso-tech aria-pressed="${!!st.tech}">${st.tech?'esconder detalhes':'ver detalhes (tokens, cache, informado × estimado)'}</button></div>`;
  const t=(d&&d.totals)||{};
  const head=usoHead(t, st)+bar;
  if(st.err) return head+`<div class="ld-empty ld-err" role="alert"><b>${esc(st.err)}</b><div class="ld-do"><span>O que fazer</span><ol><li>Feche outra janela do Starfork, se houver.</li><li>Tente de novo.</li></ol></div><div class="ld-acts"><button type="button" class="btn sm" data-uso-reload>tentar de novo</button></div></div>`;
  if(!d) return head+((typeof skeletonHtml==='function')?skeletonHtml('cards',{ n:4, inline:true, label:'carregando o uso' }):'<div class="dim uso-none">carregando…</div>');
  const tests=d.tests||{};
  const testsLine=(+tests.calls>0)?`<p class="uso-note dim">Testes de conexão (fora do total): ${usoUsd(tests.usd)} em ${tests.calls} chamada${tests.calls===1?'':'s'}.</p>`:'';
  if(!t.calls) return head+`<div class="ld-empty uso-empty"><b>Nenhum uso de IA registrado ${st.period==='hoje'?'hoje':'neste período'}</b>`
    +`<p>Cada chamada de IA do Starfork (tarefas, planner, personas, chats, revisão, títulos, commits, resumos) entra aqui com tokens e custo. `
    +`Tarefas de antes deste registro aparecem pelo histórico de custo delas.</p></div>`+testsLine;
  const tasks=(d.tasks||[]);
  const total=Math.max(+d.tasksTotal||0, tasks.length);
  const kpis=`<div class="uso-kpis">`
    +`<div class="uso-kpi big"><span class="k">gasto ${esc(usoPeriodTxt(st.period||'7d'))}</span><b class="v">${usoMoney(t)}</b><span class="s">cotação R$ ${esc(fmtNumBR(usdBrlRate(),true))} (Ajustes › Custo e limites)</span><span class="uso-tech">${usoKindTag(t)}</span></div>`
    +`<div class="uso-kpi"><span class="k">tarefas</span><b class="v">${total}</b><span class="s">com gasto no período</span></div>`
    +`<div class="uso-kpi"><span class="k">chamadas de IA</span><b class="v">${t.calls}</b><span class="s">tarefas, Fábrica, conversas…</span></div>`
    +`<div class="uso-kpi"><span class="k">tokens</span><b class="v">${usoTok((+t.inTok||0)+(+t.outTok||0))}</b><span class="s">entrada + saída</span></div></div>`
    +`<div class="uso-tech uso-split"><span>informado <b>${usoUsd(t.usdReported)}</b></span><span>estimado por tokens <b>${usoUsd(t.usdEstimated)}</b></span>${+t.cachedTok>0?`<span>${usoTok(t.cachedTok)} do cache</span>`:''}</div>`+testsLine;
  const more=total>tasks.length?`<p class="uso-note dim">mostrando ${tasks.length} de ${total} tarefas (as que mais gastaram)</p>`:'';
  const open=st.open||'';
  const tlist=tasks.length?`<table class="uso-tab uso-ttab"><thead><tr><th>Tarefa</th><th>Projeto</th><th>Trabalho</th><th class="num">Gasto</th></tr></thead><tbody>`+tasks.map(x=>{ const on=open===x.taskId;
      return `<tr class="uso-trw${on?' open':''}"><td><button type="button" class="uso-task" data-uso-task="${escA(x.taskId)}" data-uso-tproj="${escA(x.project||'')}" aria-expanded="${on}" title="ver por etapa e rodada">${esc(x.title||x.taskId)}</button></td><td class="dim">${esc(x.projectName||'')}${x.legacy?' · histórico':''}</td>`
        +`<td class="dim">${x.calls} turno${x.calls===1?'':'s'} · ${usoTok((+x.inTok||0)+(+x.outTok||0))} tokens · ${usoDur(x.ms)}</td><td class="num">${usoCell(x)} <span class="uso-tech">${usoKindTag(x)}</span></td></tr>`
        +(on?`<tr class="uso-xrow"><td colspan="4" id="usoDet">${st.detailErr?`<div class="ld-empty ld-err" role="alert"><b>${esc(st.detailErr)}</b></div>`:(st.detail?usoDetailHtml(st.detail):'<div class="dim uso-none">carregando o detalhe…</div>')}</td></tr>`:''); }).join('')+'</tbody></table>'+more
    :'<div class="dim uso-none">nenhuma tarefa gastou neste período</div>';
  // detalhe de uma tarefa que não está na lista cortada (ex.: aberta por usoOpenTask de outro lugar): logo acima da tabela
  const loose=open && !tasks.some(x=>x.taskId===open) ? `<div class="uso-loose">${st.detailErr?`<div class="ld-empty ld-err" role="alert"><b>${esc(st.detailErr)}</b></div>`:(st.detail?usoDetailHtml(st.detail):'<div class="dim uso-none">carregando o detalhe…</div>')}</div>` : '';
  return head+kpis
    +`<div class="uso-grid"><section class="uso-card"><h3>Por origem <span class="dim">o que no Starfork gastou</span></h3>${usoBars(d.bySource, x=>usoSourceLabel(x.source))}</section>`
    +`<div class="uso-col"><section class="uso-card"><h3>Por IA</h3>${usoBars(d.byEngine, x=>usoEngineLabel(x.engine), 'uso-small')}</section>`
    +`<section class="uso-card"><h3>Por projeto</h3>${usoBars(d.byProject, x=>x.name||'sem projeto', 'uso-small')}</section>`
    +`<section class="uso-card"><h3>Limites do plano <span class="dim">mesmo número do medidor da lateral</span></h3>${usoLimitsHtml(st.limits)}</section></div></div>`
    +`<section class="uso-card"><h3>Tarefas, da que mais gastou <span class="dim">clique pra ver por etapa e rodada</span></h3>${loose}${tlist}</section>`;
}
// limites do plano: as linhas do medidor (pmRows, 28) — sem leitura ainda, diz isso
function usoLimitsHtml(rows){
  const L=(rows||[]).filter(r=>r.bars&&r.bars.length);
  if(!L.length) return '<div class="dim uso-none">o medidor ainda não leu os limites (ative a % do Claude em Ajustes › IA e modelos)</div>';
  return L.map(r=>`<div class="uso-lim"><b>${esc(r.name)}</b>${r.bars.map(b=>`<div class="uso-limr"><span>${esc(b.label)}</span><span class="uso-track"><i class="uso-fill lv-${esc(b.level)}" style="width:${b.pct}%"></i></span><span class="num">${Math.round(b.pct)}%</span></div>`).join('')}</div>`).join('')
    +(L[0].sub?`<p class="uso-note dim">${esc(L[0].sub)}</p>`:'');
}
// detalhe de UMA tarefa (abre na própria linha): por etapa/agente e por rodada
function usoDetailHtml(d){
  if(!d) return '';
  const roles=(d.byRole||[]).map(r=>`<tr><td>${esc(r.role)}</td><td>${esc((r.engines||[]).map(usoEngineLabel).join(', '))}</td><td class="num">${r.calls}</td>`
    +`<td class="num">${usoTok(r.inTok)}</td><td class="num">${usoTok(r.outTok)}</td><td class="num">${usoDur(r.ms)}</td><td class="num">${usoCell(r)} ${usoKindTag(r)}</td></tr>`).join('');
  const rounds=(d.rounds||[]).map((r,i)=>`<tr${r.ok===false?' class="uso-fail"':''}><td class="num">${i+1}</td><td>${esc(usoWhen(r.at))}</td><td>${esc(r.role||'agente')}</td>`
    +`<td>${esc(usoEngineLabel(r.engine))}${r.model?` <span class="dim">${esc(r.model)}</span>`:''}</td><td class="num">${usoTok(r.inTok)}</td><td class="num">${usoTok(r.outTok)}</td>`
    +`<td class="num">${usoDur(r.ms)}</td><td class="num">${esc(usoFmt(r.usd, true))}${r.estimated?' <span class="uso-tag uso-estimado" title="'+escA(USO_KIND_TIP.estimado)+'">estimado</span>':''}${r.legacy?' <span class="dim">· histórico</span>':''}</td></tr>`).join('');
  return `<div class="uso-det"><div class="uso-dethead"><b>${esc(d.title||d.taskId)}</b><span class="dim">${usoMoney(d.totals)}</span>${usoKindTag(d.totals)}<span style="flex:1"></span><button type="button" class="btn sm quiet" data-uso-back>fechar</button></div>`
    +`<div class="uso-detg"><section><h4>Por etapa / agente</h4>${roles?`<table class="uso-tab"><thead><tr><th>agente</th><th>IA</th><th class="num">turnos</th><th class="num">entrada</th><th class="num">saída</th><th class="num">tempo</th><th class="num">custo</th></tr></thead><tbody>${roles}</tbody></table>`:'<div class="dim uso-none">sem turnos registrados</div>'}</section>`
    +`<section><h4>Rodadas</h4>${rounds?`<table class="uso-tab"><thead><tr><th class="num">#</th><th>quando</th><th>agente</th><th>IA</th><th class="num">entrada</th><th class="num">saída</th><th class="num">tempo</th><th class="num">custo</th></tr></thead><tbody>${rounds}</tbody></table>`:'<div class="dim uso-none">sem rodadas</div>'}</section></div></div>`;
}
// @uso-puro-fim

const USO_PERIOD_KEY='usoPeriod';
const USO={ period:(typeof lsGet==='function'&&lsGet(USO_PERIOD_KEY))||'7d', project:'', engine:'', tech:false, data:null, err:'', projects:[], detail:null, detailErr:'', seq:0, at:0 };
function usoBody(){ return document.getElementById('usoBody'); }
function usoLimits(){ try{ return (typeof pmRows==='function' && typeof pmData!=='undefined' && pmData)?pmRows(pmData, Date.now()):[]; }catch(_){ return []; } }
function usoRender(){
  const el=usoBody(); if(!el) return;
  if(el.classList) el.classList.toggle('showtech', !!USO.tech);
  el.innerHTML=usoHtml(USO.data, { period:USO.period, project:USO.project, engine:USO.engine, tech:USO.tech, err:USO.err, projects:USO.projects,
    open:USO.detail?USO.detail.taskId:'', detail:USO.detail&&USO.detail.data, detailErr:USO.detailErr, limits:usoLimits() });
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
  try{ d=await usoCall()('usage_report', { period:USO.period, project:USO.project||null, since:usoSinceFor(USO.period, Date.now()), engine:USO.engine||null }); }
  catch(e){ err=usoErrText(e); }
  if(seq!==USO.seq) return; // chegou uma resposta velha
  USO.data=err?null:(d||null); USO.err=err; USO.at=Date.now();
  if(d && Array.isArray(d.projects)) USO.projects=d.projects; // todos os projetos conhecidos, não só os que gastaram
  usoRender();
}
async function usoOpenTask(taskId, project){
  if(USO.detail && USO.detail.taskId===taskId){ USO.detail=null; USO.detailErr=''; usoRender(); return; } // 2º clique fecha a linha
  USO.detail={ taskId, project, data:null }; USO.detailErr=''; usoRender();
  const mine=()=>USO.detail && USO.detail.taskId===taskId; // o usuário pode ter fechado/aberto outra tarefa
  try{ const d=await usoCall()('usage_task_detail', { taskId, project:project||null }); if(!mine()) return; USO.detail.data=d; }
  catch(e){ if(!mine()) return; USO.detailErr=usoErrText(e); }
  usoRender();
}
function usoWire(){
  const el=usoBody(); if(!el || el.__usoWired) return;
  el.__usoWired=true;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest&&ev.target.closest('[data-uso-period],[data-uso-reload],[data-uso-task],[data-uso-back],[data-uso-tech]'); if(!b) return;
    if(b.dataset.usoPeriod){ USO.period=b.dataset.usoPeriod; if(typeof lsSet==='function') lsSet(USO_PERIOD_KEY, USO.period); USO.data=null; USO.detail=null; usoRender(); usoLoad(); }
    else if(b.hasAttribute('data-uso-reload')){ usoLoad(); }
    else if(b.dataset.usoTask){ usoOpenTask(b.dataset.usoTask, b.dataset.usoTproj||''); }
    else if(b.hasAttribute('data-uso-back')){ USO.detail=null; USO.detailErr=''; usoRender(); }
    else if(b.hasAttribute('data-uso-tech')){ USO.tech=!USO.tech; usoRender(); }
  });
  el.addEventListener('change', ev=>{
    const s=ev.target.closest&&ev.target.closest('[data-uso-project],[data-uso-engine]'); if(!s) return;
    if(s.hasAttribute('data-uso-engine')) USO.engine=s.value||''; else USO.project=s.value||'';
    USO.data=null; USO.detail=null; usoRender(); usoLoad();
  });
}
// abrir/voltar pra aba: com dados de menos de 1 min só mostra (mantém a linha aberta); mais velhos → relê
async function openUso(){
  const ov=document.getElementById('usoOverlay'); if(!ov) return;
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  usoWire();
  if(USO.data && Date.now()-USO.at < USO_STALE_MS){ usoRender(); return; }
  usoRender();
  await usoLoad();
}
window.openUso=openUso;
// medidor da lateral e menu do avatar abrem a página
function usoOpenTab(){ const mm=document.getElementById('moreMenu'); if(mm) mm.style.display='none'; if(window.openTab) window.openTab('uso'); else openUso(); }
window.usoOpenTab=usoOpenTab;
if(typeof bindClick==='function'){
  bindClick('usoBtn', usoOpenTab);
  bindClick('usoClose', ()=>{ if(typeof ovHide==='function') ovHide('usoOverlay'); });
}
