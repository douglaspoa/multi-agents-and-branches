// Constellation — 32-planner
// ========== Planner (chat) — monta o TASK.yaml conversando ==========
const PL_MESH=[
  {k:'id',      label:'id',              src:'auto',      auto:true},
  {k:'title',   label:'title',           src:'você',      req:true},
  {k:'objective',label:'objective',      src:'você',      req:true,  area:true},
  {k:'deliverables',label:'deliverables',src:'você',      req:true,  list:true},
  {k:'requirements',label:'requirements',src:'você',      list:true},
  {k:'owns',    label:'scope.owns',      src:'você',      list:true},
  {k:'off',     label:'scope.off_limits',src:'barramento',list:true},
  {k:'artifacts',label:'artifacts',      src:'você',      arts:true},
  {k:'autonomy',label:'autonomy',        src:'padrão'},
  {k:'engine',  label:'engine',          src:'padrão'},
];
let plFields={}, plSid='', plMsgs=[], plChips=[], plAsking='', plDone=false, plBusy=false, plRefs=[], plPlan=null, plNoEpic=false;
let plPend=[]; // anexos importados, ainda não enviados
function plReset(){ plFields={deliverables:[],requirements:[],owns:[],off:[],title:'',objective:'',autonomy:'',engine:'claude',artifacts:null}; plSid=''; plMsgs=[]; plChips=[]; plAsking='objective'; plDone=false; plRefs=[]; plPlan=null; plNoEpic=false; }
function plRenderRefs(){
  const el=$id('plRefsBar'); if(!el) return;
  el.innerHTML = plRefs.map((p,i)=>{ const n=(p||'').split('/').pop(); return `<span class="plref"><span class="plrefic">${refIcon(n)}</span><span class="mono">${esc(n)}</span><button class="plrefx" data-r="${i}">×</button></span>`; }).join('');
  el.querySelectorAll('.plrefx').forEach(b=>b.onclick=()=>{ plRefs.splice(+b.dataset.r,1); plRenderRefs(); });
}
// anexos do planner: composer único; o que entra também vira ref da tarefa criada
function plWireComposer(){ attWireComposer({ input:'plInput', attach:'plAttach', pend:()=>plPend, taskId:()=>null, rerender:renderPlanner, afterAdd:atts=>{ atts.forEach(a=>{ if(!plRefs.includes(a.path)) plRefs.push(a.path); }); plRenderRefs(); } }); }
function plVal(k){ if(k==='engine'&&plFields.engineLabel) return plFields.engineLabel; if(k==='id') return plFields.title?agSlug(plFields.title):''; const v=plFields[k]; return Array.isArray(v)?v:(v||''); }
function plHas(k){ if(k==='artifacts') return plFields.artifacts!==null && plFields.artifacts!==undefined; const v=plVal(k); return Array.isArray(v)?v.length>0:!!String(v).trim(); }
function plState(k){ if(plHas(k)) return 'ok'; if(plAsking===k) return 'ask'; return 'wait'; }
function plReady(){ return plHas('title')&&plHas('objective')&&plHas('deliverables'); }
let plSaveTimer=null;
function plDraftJson(){ let input=''; try{ const i=document.getElementById('plInput'); input=i?i.value:''; }catch(_){} return JSON.stringify({ fields:plFields, sid:plSid, refs:plRefs, msgs:plMsgs.filter(m=>m.who!=='sys').slice(-40).map(m=>m.atts?{...m, atts:attLite(m.atts)}:m), chips:plChips, asking:plAsking, plan:plPlan, noEpic:plNoEpic, input }); }
// immediate=true salva NA HORA (sem debounce) — usado quando o humano envia uma
// mensagem: o raciocínio fica no disco ANTES da IA responder, então uma queda de
// luz / fechamento no meio não perde o que você acabou de escrever.
function plAutoSave(immediate){ clearTimeout(plSaveTimer); const save=()=>{ try{ invoke('save_draft',{ json: plDraftJson() }); }catch(_){} }; if(immediate){ save(); } else { plSaveTimer=setTimeout(save,400); } }
async function openPlanner(){
  plReset();
  $id('plannerOverlay').style.display='flex';
  let draft=null; try{ draft=await invoke('load_draft'); }catch(_){}
  if(draft){ try{ const d=JSON.parse(draft);
    if(d && ((d.fields&&(d.fields.title||d.fields.objective)) || (d.msgs&&d.msgs.length))){
      plFields=Object.assign(plFields, d.fields||{}); plSid=d.sid||''; plRefs=d.refs||[]; plMsgs=(d.msgs||[]).slice(); plChips=d.chips||[]; plAsking=d.asking||''; plPlan=plPlanRestore(d.plan); plNoEpic=!!d.noEpic;
      plMsgs.unshift({who:'sys', text:'↺ Rascunho recuperado — continue de onde parou (ou "novo" no topo pra começar do zero).'});
      try{ const inp=$id('plInput'); if(inp && d.input) inp.value=d.input; }catch(_){}
    }
  }catch(_){} }
  if(!plMsgs.length){ plMsgs.push({who:'bot', text:'Bora montar conversando. Em uma ou duas frases: qual é o objetivo — o que precisa ser feito e por quê? (se for grande e tiver várias frentes, eu proponho um épico com tarefas em paralelo pra você aprovar)'}); plMsgs.push({who:'bot', kind:'model'}); }
  renderPlanner(); plRenderRefs();
  const i=$id('plInput'); if(i) i.focus();
}
async function plNew(){
  try{ await invoke('clear_draft'); }catch(_){}
  plReset(); plMsgs.push({who:'bot', text:'Novo. Qual é o objetivo — o que precisa ser feito e por quê?'}); plMsgs.push({who:'bot', kind:'model'});
  renderPlanner(); plRenderRefs();
}
function closePlanner(){ $id('plannerOverlay').style.display='none'; if(window.closeTabOfKind) window.closeTabOfKind('planner'); }
// mostra a conversa desta aba do jeito que estava (sem recarregar rascunho nem resetar)
function plShow(){ $id('plannerOverlay').style.display='flex'; renderPlanner(); plRenderRefs(); const i=$id('plInput'); if(i) i.focus(); }
window.plShow=plShow;
window.TAB_STATE_planner={
  get:()=>({ _title:(plFields&&plFields.title)||'', plFields, plSid, plMsgs, plChips, plAsking, plDone, plRefs, plPlan, plNoEpic, plPend }),
  set:(st)=>{ plFields=st.plFields||{}; plSid=st.plSid||''; plMsgs=st.plMsgs||[]; plChips=st.plChips||[]; plAsking=st.plAsking||''; plDone=!!st.plDone; plBusy=false; plRefs=st.plRefs||[]; plPlan=plPlanRestore(st.plPlan); plNoEpic=!!st.plNoEpic; plPend=st.plPend||[]; }
};
function plApplyPatch(patch){
  if(!patch||typeof patch!=='object') return;
  for(const k of ['title','objective','autonomy','engine']) if(typeof patch[k]==='string'&&patch[k].trim()) plFields[k]=patch[k].trim();
  for(const k of ['deliverables','requirements','owns','off']) if(Array.isArray(patch[k])) plFields[k]=patch[k].map(x=>String(x).trim()).filter(Boolean);
  if(Array.isArray(patch.artifacts)) plFields.artifacts={doc:patch.artifacts.includes('doc'),proof:patch.artifacts.includes('proof'),tests:patch.artifacts.includes('tests')};
}
function renderPlanner(){
  // medidor
  const okCount=PL_MESH.filter(f=>plState(f.k)==='ok').length;
  $id('plMeter').textContent=`${okCount} de ${PL_MESH.length} campos`;
  // chat
  const th=$id('plThread');
  const ci=document.activeElement, keep=(ci&&ci.id==='plInput'), iv=$id('plInput')?$id('plInput').value:null;
  th.innerHTML=plMsgs.map(m=>m.kind==='model'?plModelCardHtml(m):`<div class="plmsg ${m.who}">${m.who==='bot'?'<span class="plav">✦</span>':''}<div class="plbub">${m.who==='bot'?mdToHtml(m.text):esc(m.text)+attRowHtml(m.atts)}</div></div>`).join('')+(plBusy?'<div class="plmsg bot"><span class="plav">✦</span><div class="plbub think"><span class="pltyping"><i></i><i></i><i></i></span></div></div>':'')+plPlanCardHtml();
  plWirePlanCard(); plWireModelCard(th);
  attRenderPend('plPend', plPend, renderPlanner);
  th.scrollTop=th.scrollHeight;
  // chips
  const chipsEl=$id('plChips');
  chipsEl.innerHTML=(plChips||[]).map((c,i)=>`<button class="plchip" data-chip="${i}">${esc(c)}</button>`).join('');
  chipsEl.querySelectorAll('[data-chip]').forEach(b=>b.onclick=()=>plSend(plChips[+b.dataset.chip]));
  // mesh (9 campos)
  const mesh=$id('plMesh');
  mesh.innerHTML=`<div class="plmeshh">TASK.yaml <span class="plmesht">montando ao vivo · ${okCount}/${PL_MESH.length}</span></div>`+
    PL_MESH.map(f=>{ const st=plState(f.k); const v=plVal(f.k); const disp=Array.isArray(v)?v.join('\n'):v;
      const ctl = f.arts ? (()=>{ const a=plFields.artifacts||{}; const chip=(k,lbl)=>`<button class="plart${a[k]?' on':''}" data-plart="${k}">${lbl}</button>`; return `<div class="plarts">${chip('doc','doc de arquitetura')}${chip('proof','prints')}${chip('tests','testes')}</div>`; })()
        : f.auto ? `<div class="plfv mono auto">${esc(disp)||'—'}</div>`
        : f.list ? `<textarea class="plfv in mono" data-fk="${f.k}" rows="2" placeholder="um por linha…">${esc(Array.isArray(v)?v.join('\n'):'')}</textarea>`
        : f.area ? `<textarea class="plfv in" data-fk="${f.k}" rows="2" placeholder="…">${esc(disp)}</textarea>`
        : `<input class="plfv in ${f.k==='id'?'mono':''}" data-fk="${f.k}" value="${escA(disp)}" placeholder="…">`;
      return `<div class="plfield ${st}"><div class="plfhead"><span class="pldot"></span><span class="plfk mono">${esc(f.label)}</span><span class="plfsrc">${st==='ask'?'perguntando':(st==='ok'?f.src:'falta')}</span></div>${ctl}</div>`;
    }).join('')+
    `<div class="plmeshfoot"><button class="btn primary" id="plCreate"${plReady()?'':' disabled'}>${IC.cright} criar e rodar</button><div class="dim" style="font-size:10.5px;margin-top:6px">${plReady()?'campos obrigatórios fechados — pode criar':'faltam: '+PL_MESH.filter(f=>f.req&&!plHas(f.k)).map(f=>f.label).join(', ')}</div></div>`;
  mesh.querySelectorAll('[data-plart]').forEach(b=>b.onclick=()=>{ const k=b.dataset.plart; if(!plFields.artifacts) plFields.artifacts={doc:false,proof:false,tests:false}; plFields.artifacts[k]=!plFields.artifacts[k]; renderPlanner(); plAutoSave(); });
  mesh.querySelectorAll('[data-fk]').forEach(inp=>inp.addEventListener('input',()=>{ const k=inp.dataset.fk; if(PL_MESH.find(f=>f.k===k).list) plFields[k]=inp.value.split('\n').map(s=>s.trim()).filter(Boolean); else plFields[k]=inp.value; renderPlannerMeterOnly(); plAutoSave(); }));
  bindClick('plCreate', plCreate);
  if(keep){ const i=$id('plInput'); if(i){ if(iv!=null) i.value=iv; i.focus(); } }
}
// ---- "Com qual IA?" no começo da conversa: usa o padrão do usuário ou escolhe (e pode salvar como padrão) ----
function plModelCardHtml(m){
  const d=aiDefaults(); const hasDef=!!d.model||d.eng!=='claude';
  const lbl=(e,mo)=>`${aiModelName(mo)} · ${(AI_ENGINES.find(x=>x.id===e)||{}).name||e}`;
  if(m.choice){ return `<div class="plmsg bot"><span class="plav">✦</span><div class="plbub plmodel done"><b>IA desta demanda:</b> ${esc(lbl(m.choice.eng,m.choice.model))}${m.choice.saved?' <span class="plmtag">salvo como padrão</span>':''} <a class="plmchg" data-plm="change">trocar</a></div></div>`; }
  const quick=[['claude','claude-opus-5-5','Opus 5.5'],['claude','claude-sonnet-5','Sonnet 5'],['claude','claude-haiku-4-5-20251001','Haiku 4.5']];
  return `<div class="plmsg bot"><span class="plav">✦</span><div class="plbub plmodel">
    ${hasDef?`Com qual IA? Seu padrão é <b>${esc(lbl(d.eng,d.model))}</b>.`:`Com qual IA quer montar esta demanda? Você ainda não tem um <b>padrão</b> — escolha aqui e, se quiser, eu guardo como padrão pras próximas.`}
    <div class="plmchips">${hasDef?`<button class="plchip on" data-plm="default">✓ usar o padrão · ${esc(aiModelName(d.model))}</button>`:''}${quick.filter(([e,mo])=>!(hasDef&&e===d.eng&&mo===d.model)).map(([e,mo,n])=>`<button class="plchip" data-plm="pick" data-eng="${e}" data-model="${mo}">${esc(n)}</button>`).join('')}<button class="plchip" data-plm="more">escolher… (Codex, gateway, outro id)</button></div>
    ${m.open?`<div class="aipick aipick-pl" style="margin-top:10px"></div><div style="margin-top:8px"><button class="btn primary sm" data-plm="done">usar esta</button></div>`:''}
    <label class="plmsave"><input type="checkbox" data-plm="save"${hasDef?'':' checked'}> salvar como padrão pras próximas demandas</label>
  </div></div>`;
}
function plWireModelCard(th){
  const m=plMsgs.find(x=>x.kind==='model'); if(!m) return;
  const card=th.querySelector('.plmodel'); if(!card) return;
  const saveOn=()=>{ const c=card.querySelector('[data-plm="save"]'); return !!(c&&c.checked); };
  const choose=(eng,model)=>{ aiPickApply(eng, model); const saved=saveOn(); if(saved){ lsSet('defaultEngine',eng||'claude'); lsSet('defaultModel',model||''); } m.choice={eng,model,saved}; m.open=false; plFields.engine=eng||'claude'; plFields.model=model||''; plFields.engineLabel=`${(AI_ENGINES.find(x=>x.id===eng)||{}).name||eng} · ${aiModelName(model)}`; renderPlanner(); plAutoSave(); };
  card.querySelectorAll('[data-plm="default"]').forEach(b=>b.onclick=()=>{ const d=aiDefaults(); choose(d.eng,d.model); });
  card.querySelectorAll('[data-plm="pick"]').forEach(b=>b.onclick=()=>choose(b.dataset.eng,b.dataset.model));
  card.querySelectorAll('[data-plm="more"]').forEach(b=>b.onclick=()=>{ m.open=true; renderPlanner(); });
  card.querySelectorAll('[data-plm="done"]').forEach(b=>b.onclick=()=>{ const cur=AI_TARGET_FORM.get(); choose(cur.eng,cur.model); });
  card.querySelectorAll('[data-plm="change"]').forEach(a=>a.onclick=()=>{ m.choice=null; m.open=false; renderPlanner(); });
  if(m.open) aiPickRender();
}
// ---- plano da IA → plPlan: envelope do épico (outcome, requirements, doneWhen, boundaries) + tarefas
//      com verify/covers/after/risk. A ONDA é DERIVADA de `after` (nível topológico) — a IA não manda wave.
const plStrs=(a,n)=>(Array.isArray(a)?a:[]).map(s=>String((s&&typeof s==='object')?(s.text||s.id||''):s).trim()).filter(Boolean).slice(0,n);
function plPlanFrom(p){
  // idx = posição ORIGINAL em p.tasks (é a referência que `after` usa); tarefa sem título cai fora, mas os índices das outras não deslocam
  const all=(Array.isArray(p.tasks)?p.tasks:[]).slice(0,8);
  const tasks=all.map((x,i)=>(x&&x.title)?{ idx:i, title:String(x.title).slice(0,90), objective:String(x.objective||''),
    requirements:plStrs(x.requirements,6), owns:String(x.owns||'').trim(),
    verify:String(x.verify||'').trim().slice(0,240), covers:plStrs(x.covers,8),
    after:(Array.isArray(x.after)?x.after:[]).map(n=>parseInt(n,10)).filter(n=>Number.isInteger(n)&&n>=0&&n<all.length&&n!==i),
    risk:/^(low|medium|high)$/.test(x.risk||'')?x.risk:'',
    wave:Math.max(1, parseInt(x.wave,10)||1), on:x.on!==false }:null).filter(Boolean);
  const alive=new Set(tasks.map(t=>t.idx)); tasks.forEach(t=>{ t.after=t.after.filter(a=>alive.has(a)); });
  // plano no formato ANTIGO (wave da IA, sem after): sintetiza `after` = todas as tarefas da onda anterior, e daí em diante só `after` manda
  if(!tasks.some(t=>t.after.length) && tasks.some(t=>t.wave>1)){
    tasks.forEach(t=>{ const prev=tasks.filter(o=>o.wave<t.wave).map(o=>o.wave); if(prev.length){ const w=Math.max(...prev); t.after=tasks.filter(o=>o.wave===w).map(o=>o.idx); } });
  }
  plWaves(tasks);
  // requisitos do épico: id do modelo quando veio; senão R1..Rn numerado DEPOIS de filtrar (covers cita esses ids)
  const reqs=(Array.isArray(p.requirements)?p.requirements:[]).map(r=>(r&&typeof r==='object')?{ id:String(r.id||'').trim(), text:String(r.text||'').trim() }:{ id:'', text:String(r).trim() }).filter(r=>r.text).slice(0,12);
  reqs.forEach((r,i)=>{ if(!r.id || reqs.some((o,j)=>j<i&&o.id===r.id)) r.id='R'+(i+1); });
  return { epic:String(p.epic||plFields.title||'Épico').slice(0,80), outcome:String(p.outcome||'').trim().slice(0,300),
    requirements:reqs, doneWhen:plStrs(p.doneWhen,6), boundaries:plStrs(p.boundaries,6), tasks:plSortWaves(tasks) };
}
// onda = 1 + maior onda dos pré-requisitos MARCADOS (pré-requisito desmarcado no card não conta); sem `after`, onda 1.
// Ciclo mantém a wave da tarefa. Roda de novo a cada edição estrutural do card e ao aprovar.
function plWaves(tasks){
  const byIdx={}; tasks.forEach(t=>{ byIdx[t.idx]=t; });
  const memo={}, onStack={};
  const lvl=t=>{ if(memo[t.idx]) return memo[t.idx]; if(onStack[t.idx]) return t.wave; onStack[t.idx]=true;
    const w=1+Math.max(0, ...(t.after||[]).map(a=>(byIdx[a]&&byIdx[a].on!==false)?lvl(byIdx[a]):0)); onStack[t.idx]=false; memo[t.idx]=w; return w; };
  tasks.forEach(t=>{ t.wave=lvl(t); });
}
function plSortWaves(tasks){ return tasks.sort((a,b)=>a.wave-b.wave||(a.idx??0)-(b.idx??0)); }
// rascunho/aba restaurados: plano salvo antes do formato novo (sem idx/after) passa pelo mesmo parser
function plPlanRestore(p){ if(!p||!Array.isArray(p.tasks)) return p||null; const r=p.tasks.some(t=>t&&t.idx==null)?plPlanFrom(p):p; r.locked=false; return r; } // nunca volta travado de um rascunho
// pré-requisitos que valem de fato: marcados no card
function plAfterOn(x){ return (x.after||[]).filter(a=>{ const t=plPlan.tasks.find(y=>y.idx===a); return t&&t.on; }); }
// a tarefa `idx` depende (direta ou transitivamente) de `target`? — evita ciclo ao ligar um chip de "depois de"
function plDependsOn(idx, target, seen){
  seen=seen||new Set(); if(seen.has(idx)) return false; seen.add(idx);
  const t=plPlan.tasks.find(y=>y.idx===idx); if(!t) return false;
  return (t.after||[]).some(a=>a===target || plDependsOn(a, target, seen));
}
const plRiskLabel={ low:'risco baixo', medium:'risco médio', high:'risco alto' };

// ---- preview aprovável de ÉPICO dentro do chat do planner ----
function plPlanCardHtml(){
  if(!plPlan) return '';
  const noTeam = !(SB.sess() && cloudTeamId());
  const dis=plPlan.locked?' disabled':''; // gravando na nuvem: tudo travado
  let rows='', lastWave=0;
  plPlan.tasks.forEach((x,i)=>{
    if(x.wave!==lastWave){ lastWave=x.wave;
      rows+=`<div class="ppwave">ONDA ${x.wave} <span>${x.wave===1?'· começam já, em paralelo':'· depois da onda '+(x.wave-1)}</span></div>`; }
    const after=plAfterOn(x), others=plPlan.tasks.filter(o=>o!==x && o.on);
    // tudo editável antes de aprovar: prova (verify), pré-requisitos (chips das irmãs) e risco; a onda recalcula na hora
    // div, não label: só o checkbox e o título (des)marcam a tarefa; clique entre os controles não faz nada
    rows+=`<div class="pptask"><input type="checkbox" id="pptask-${i}" data-pptask="${i}" ${x.on?'checked':''}${dis}><span style="flex:1;min-width:0">
      <span class="pptitle"><label for="pptask-${i}">${esc(x.title)}</label><select class="ppsel pprisk ${x.risk||''}" data-pprisk="${i}" title="risco"${dis}>${['','low','medium','high'].map(r=>`<option value="${r}"${(x.risk||'')===r?' selected':''}>${r?plRiskLabel[r]:'risco ?'}</option>`).join('')}</select></span>${x.objective?`<span class="ppobj">${esc(x.objective)}</span>`:''}
      <span class="ppverify">✓ prova: <input class="ppedit" data-ppverify="${i}" maxlength="240" value="${escA(x.verify||'')}" placeholder="como alguém checa que esta tarefa entregou (1 linha)"${dis}>${(x.covers&&x.covers.length)?` <span class="mono ppcov">${esc(x.covers.join(' '))}</span>`:''}</span>
      ${others.length?`<span class="ppafter">↳ depois de: ${others.map(o=>`<button type="button" class="ppchip${after.includes(o.idx)?' on':''}" data-ppafter="${i}:${o.idx}" title="${escA(o.title)}"${dis}>${esc(o.title.length>28?o.title.slice(0,27)+'…':o.title)}</button>`).join('')}</span>`:''}
      ${(x.requirements&&x.requirements.length)?`<span class="ppreq">${x.requirements.map(r=>'☐ '+esc(r)).join('<br>')}</span>`:''}
      ${x.owns?`<span class="ppowns mono">⛶ ${esc(x.owns)}</span>`:''}</span></div>`;
  });
  const n=plPlan.tasks.filter(x=>x.on).length;
  const dw=plPlan.doneWhen||[], rq=plPlan.requirements||[];
  return `<div class="plmsg bot"><span class="plav">◆</span><div class="plplan" id="plPlanCard">
    <div class="pphead">◆ Épico proposto — revise e aprove</div>
    <input class="ppname" id="ppName" value="${escA(plPlan.epic)}" placeholder="nome do épico"${dis}>
    <textarea class="ppedit ppout" id="ppOutcome" rows="2" placeholder="resultado: pra quem, o que muda e qual sinal mostra que funcionou"${dis}>${esc(plPlan.outcome||'')}</textarea>
    ${rq.length?`<div class="ppdone ppreqs"><div class="ppdh">REQUISITOS <span>· o que as tarefas cobrem</span></div>${rq.map(r=>`<div><span class="mono">${esc(r.id)}</span> ${esc(r.text)}</div>`).join('')}</div>`:''}
    <div class="ppdone"><div class="ppdh">PRONTO QUANDO <span>· o épico só fecha com tudo marcado</span></div>
      ${dw.map((d,i)=>`<div class="ppdwrow"><span class="mono">D${i+1}</span><input class="ppedit" data-ppdw="${i}" value="${escA(d)}" placeholder="checagem que uma pessoa roda sem abrir tarefa"${dis}><button type="button" class="ppx" data-ppdwx="${i}" title="remover"${dis}>✕</button></div>`).join('')}
      <button type="button" class="ppadd" id="ppDwAdd"${dis}>+ checagem</button></div>
    <div class="pplist">${rows}</div>
    ${noTeam?`<div class="ppwarn">Criar um épico usa o backlog do <b>time</b> — entre na conta e escolha um time no topo pra aprovar.</div>`:''}
    <div class="ppfoot"><button class="btn sm" id="ppDiscard"${plPlan.locked?' disabled':''}>descartar</button><button class="btn primary sm" id="ppApprove"${(noTeam||plPlan.locked)?' disabled':''}>${plPlan.locked?'criando…':'✓ Aprovar e criar'+(n?' · '+n+' tarefa'+(n===1?'':'s'):'')}</button></div>
  </div></div>`;
}
function plWirePlanCard(){
  const card=$id('plPlanCard'); if(!card || plPlan.locked) return; // enquanto grava na nuvem, nada muda
  // (des)marcar recalcula as ondas: quem dependia de uma tarefa desmarcada sobe de onda
  const rewave=()=>{ plWaves(plPlan.tasks); plSortWaves(plPlan.tasks); renderPlanner(); plAutoSave(); };
  card.querySelectorAll('[data-pptask]').forEach(c=>c.onchange=()=>{ plPlan.tasks[+c.dataset.pptask].on=c.checked; rewave(); });
  const nm=$id('ppName'); if(nm) nm.oninput=()=>{ plPlan.epic=nm.value; plAutoSave(); };
  // edição do envelope e das tarefas (texto: só atualiza o modelo; estrutura: recalcula ondas e re-renderiza)
  const oc=$id('ppOutcome'); if(oc) oc.oninput=()=>{ plPlan.outcome=oc.value; plAutoSave(); };
  card.querySelectorAll('[data-ppdw]').forEach(inp=>inp.oninput=()=>{ plPlan.doneWhen[+inp.dataset.ppdw]=inp.value; plAutoSave(); });
  card.querySelectorAll('[data-ppdwx]').forEach(b=>b.onclick=()=>{ plPlan.doneWhen.splice(+b.dataset.ppdwx,1); renderPlanner(); plAutoSave(); });
  { const b=$id('ppDwAdd'); if(b) b.onclick=()=>{ (plPlan.doneWhen=plPlan.doneWhen||[]).push(''); renderPlanner(); plAutoSave(); const ins=document.querySelectorAll('[data-ppdw]'); if(ins.length) ins[ins.length-1].focus(); }; }
  card.querySelectorAll('[data-ppverify]').forEach(inp=>inp.oninput=()=>{ plPlan.tasks[+inp.dataset.ppverify].verify=inp.value.slice(0,240); plAutoSave(); });
  card.querySelectorAll('[data-pprisk]').forEach(sel=>sel.onchange=()=>{ plPlan.tasks[+sel.dataset.pprisk].risk=sel.value; renderPlanner(); plAutoSave(); });
  card.querySelectorAll('[data-ppafter]').forEach(b=>b.onclick=()=>{
    const [i,a]=b.dataset.ppafter.split(':').map(Number); const t=plPlan.tasks[i]; t.after=t.after||[];
    if(t.after.includes(a)) t.after=t.after.filter(v=>v!==a);
    else if(plDependsOn(a, t.idx)){ b.classList.add('nope'); setTimeout(()=>b.classList.remove('nope'),600); return; } // ciclo: a irmã já depende desta
    else t.after.push(a);
    rewave();
  });
  const dc=$id('ppDiscard'); if(dc) dc.onclick=()=>{ plPlan=null; plNoEpic=true; plMsgs.push({who:'sys',text:'Épico descartado — seguimos como tarefa única. É só continuar respondendo.'}); renderPlanner(); plAutoSave(); };
  const ap=$id('ppApprove'); if(ap) ap.onclick=plCreateEpic;
}
async function plCreateEpic(){
  if(!plPlan) return;
  if(!(SB.sess() && cloudTeamId())){ alert('Épico usa o backlog do time — entre na conta e escolha um time primeiro (botão no topo).'); return; }
  plWaves(plPlan.tasks); plSortWaves(plPlan.tasks); // ondas finais só com o que está marcado
  const picked=plPlan.tasks.filter(x=>x.on);
  if(!picked.length){ alert('Marque pelo menos uma tarefa do épico.'); return; }
  const name=(plPlan.epic||'').trim()||'Épico';
  plPlan.locked=true; renderPlanner(); // trava o card: nenhuma edição nem segundo clique enquanto os inserts rodam
  try{
    const proj=await cloudEnsureProject();
    // envelope do épico (0025: epics.spec) — Done when vira checklist D1..Dn, marcado depois pelo criador ou pelo agente revisor
    const spec={ description:(plFields.objective||'').trim()||undefined, outcome:plPlan.outcome||'', requirements:plPlan.requirements||[],
      doneWhen:(plPlan.doneWhen||[]).map(t=>String(t).trim()).filter(Boolean).map((t,i)=>({ id:'D'+(i+1), text:t })), boundaries:plPlan.boundaries||[] };
    const ep=await sbPost('epics',{ team_id:cloudTeamId(), name, created_by:cloudUserId(), spec });
    const created=[], idOf={}; // idx no plano → id na nuvem: `after` das tarefas vira ids reais (picked está em ordem de onda, então o pré-requisito já existe)
    for(const x of picked){
      const wanted=plAfterOn(x), after=wanted.map(a=>idOf[a]).filter(Boolean);
      if(after.length<wanted.length) console.warn('épico: pré-requisito sem id na nuvem, dependência perdida', x.title, wanted);
      const rows=await sbPost('tasks',{ local_id:'card-'+Math.random().toString(36).slice(2,10), project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), claim_mode:'open', title:x.title, status:'backlog', epic_id:ep[0].id,
        spec:{ title:x.title,
          objective:(x.objective||'')+`\n\n(Onda ${x.wave} do épico "${name}". NÃO toque em arquivos fora do seu escopo: outras tarefas do épico rodam em paralelo.)`,
          requirements:x.requirements||[], owns:x.owns||null,
          proof:!!(typeof ntPolicy!=='undefined'&&ntPolicy.proofRequired), tests:!!(typeof ntPolicy!=='undefined'&&ntPolicy.testsRequired),
          wave:x.wave,
          verify:(x.verify||'').trim()||undefined, covers:(x.covers&&x.covers.length)?x.covers:undefined, after:after.length?after:undefined, risk:x.risk||undefined } });
      if(rows&&rows[0]){ created.push({ row:rows[0], wave:x.wave }); if(x.idx!=null) idOf[x.idx]=rows[0].id; }
    }
    plPlan=null;
    try{ await invoke('clear_draft'); }catch(_){}
    closePlanner(); closeNewTask();
    lsSet('tmEpic', ep[0].id); teamTasks=null; teamPaintSig=''; setView('team');
    const w1=created.filter(c=>c.wave===1);
    if(w1.length && confirm(`Épico "${name}" criado com ${created.length} tarefa(s).\n\nIniciar AGORA as ${w1.length} tarefa(s) da onda 1 nesta máquina?\n(escopos disjuntos — rodam em paralelo; as demais ondas ficam no backlog)`)){
      for(const c of w1){ try{ await teamClaimStart(c.row, null); }catch(e){ console.error('onda1:', e); } }
    }
  }catch(e){ alert('Falha ao criar o épico:\n'+(e.message||e)); if(plPlan){ plPlan.locked=false; renderPlanner(); } }
}
// atualiza só o medidor/estado sem re-render pesado (ao editar campo à mão)
function renderPlannerMeterOnly(){
  const okCount=PL_MESH.filter(f=>plState(f.k)==='ok').length;
  const m=$id('plMeter'); if(m) m.textContent=`${okCount} de ${PL_MESH.length} campos`;
  document.querySelectorAll('#plMesh .plfield').forEach((el,i)=>{ const f=PL_MESH[i]; if(!f)return; el.className='plfield '+plState(f.k); const src=el.querySelector('.plfsrc'); if(src){ const st=plState(f.k); src.textContent=st==='ask'?'perguntando':(st==='ok'?f.src:'falta'); } });
  const c=$id('plCreate'); if(c) c.disabled=!plReady();
  const hint=document.querySelector('.plmeshfoot .dim'); if(hint) hint.textContent=plReady()?'campos obrigatórios fechados — pode criar':'faltam: '+PL_MESH.filter(f=>f.req&&!plHas(f.k)).map(f=>f.label).join(', ');
}
async function plSend(text){
  if(plBusy) return; text=(text||'').trim();
  const atts=plPend.splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e extraia o contexto (spec, print do bug, etc.).';
  if(!text) return;
  const inp=$id('plInput'); if(inp) inp.value='';
  plMsgs.push({who:'you', text, atts}); plChips=[]; plBusy=true; renderPlanner(); // miniatura fica na memória; o rascunho salva só o essencial
  plAutoSave(true); // PERSISTE já a sua mensagem — antes da IA responder (sobrevive a queda/fechamento)
  try{
    // "vira épico" depois de ter descartado: o usuário sobrescreve — a recusa cai e a IA pode propor de novo
    // (sem \b antes de "épico": em JS \b é só ASCII e não casa com o "é"); "não vira épico" não conta
    { const V='(vira|virar|quebra|quebrar|faz|fazer|prop[õo]e|proponha|monta|montar)';
      const pede=new RegExp('\\b'+V+'\\b[^.]{0,20}épico','i').test(text), nega=new RegExp('\\b(n[ãa]o|nem|sem)\\b[^.]{0,12}\\b'+V+'\\b','i').test(text);
      if(plNoEpic && pede && !nega) plNoEpic=false; }
    const prompt = (plNoEpic ? ('[SISTEMA: o usuário RECUSOU dividir em épico — trate como TAREFA ÚNICA e NÃO proponha épico/plan de novo]\n\n'+text) : text) + attPromptBlock(atts);
    const r=await aiCallResumeSafe((pr,sid)=>invoke('ai_chat',{ prompt:pr, sessionId:sid||'' }), plSid, prompt, plMsgs.slice(0,-1));
    if(r&&r.recovered) plMsgs.push({who:'sys', text:'a sessão anterior foi perdida — continuei com o histórico da conversa.'});
    plSid=r.sessionId||(r&&r.recovered?'':plSid);
    let obj=null; try{ const m=(r.text||'').match(/```json\s*([\s\S]*?)```/i)||(r.text||'').match(/(\{[\s\S]*\})/); if(m) obj=JSON.parse(m[1]); }catch(_){}
    plBusy=false;
    if(obj){
      plApplyPatch(obj.patch);
      plAsking=(typeof obj.asking==='string')?obj.asking:'';
      plDone=!!obj.done;
      plChips=Array.isArray(obj.chips)?obj.chips.slice(0,4):[];
      // a IA propôs um ÉPICO (várias tarefas paralelas) → vira preview aprovável no chat
      if(!plNoEpic && obj.plan && Array.isArray(obj.plan.tasks) && obj.plan.tasks.length) plPlan=plPlanFrom(obj.plan);
      if(obj.say) plMsgs.push({who:'bot', text:String(obj.say)});
      // você confirmou (done) e os obrigatórios fecharam → cria automaticamente
      if(plDone && plReady()){
        plMsgs.push({who:'sys', text:'Confirmado — criando a tarefa e iniciando…'});
        renderPlanner();
        await plCreate();
        return;
      }
    } else {
      plMsgs.push({who:'bot', text:r.text||'(sem resposta)'});
    }
  }catch(e){ plBusy=false; let msg=(e&&(e.message||(typeof e==='string'?e:'')))||String(e||''); msg=msg.replace(/^\[object Object\]$/,'').trim(); if(/expirou|timeout|rede indispon/i.test(msg)) msg='a IA demorou demais pra responder (rede lenta?). Sua mensagem foi salva — é só enviar de novo.'; plMsgs.push({who:'sys', text:'⚠ '+(msg||'algo falhou ao falar com a IA — tente enviar de novo (sua mensagem foi salva).')}); plAutoSave(true); }
  renderPlanner(); plAutoSave();
}
async function plCreate(){
  if(!plReady()) return;
  const b=$id('plCreate'); if(b){ b.disabled=true; b.textContent='criando…'; }
  const arts=plFields.artifacts||{};
  const plReqs=[...new Set([...(plFields.requirements||[]), ...(plFields.deliverables||[])].map(x=>String(x).trim()).filter(Boolean))];
  // política do repo vale também pra quem cria conversando
  const minR=Math.max(1,+((typeof ntPolicy!=='undefined'&&ntPolicy.minRequirements)||1));
  if(plReqs.length<minR){
    plMsgs.push({who:'sys', text:`⚠ A política deste repo exige pelo menos ${minR} requisito(s) verificáveis — feche os requisitos antes de criar.`});
    renderPlanner(); if(b){ b.disabled=false; b.textContent='criar e rodar'; }
    return;
  }
  const payload={ start:true, title:plFields.title, workflow:null, agents:null,
    engine:(function(){ const e=String(plFields.engine||'claude').toLowerCase(); return ['claude','codex','gateway','logcomex','mock'].includes(e)?e:(e.includes('codex')?'codex':e.includes('gateway')?'gateway':'claude'); })(), model:(plFields.model||aiDefaults().model||null), approval:'auto',
    owns:(plFields.owns||[]).join(', ')||null, off:(plFields.off||[]).join(', ')||null,
    objective:plFields.objective||null, deliverables:[],
    // entregáveis do planner viram REQUISITOS — uma lista só, cobrada com prova
    requirements:plReqs, doc:arts.doc?'ARCHITECTURE.md':null, proof:!!arts.proof||!!(typeof ntPolicy!=='undefined'&&ntPolicy.proofRequired), tests:!!arts.tests||!!(typeof ntPolicy!=='undefined'&&ntPolicy.testsRequired), autoPr:'ask', prBase:null,
    planApproval:/ask|review/i.test(plFields.autonomy||'')?'review':'auto',
    refs:plRefs.slice(), branchType:'feat', issue:null, issueUrl: (($id('ntIssueUrl')||{}).value||'').trim() || undefined };
  try{ await invoke('new_task', await trkBeforeNewTask(payload)); try{ await invoke('clear_draft'); }catch(_){} closePlanner(); closeNewTask(); resetNewTask(); lastSig=''; await refresh(); }
  catch(e){ alert('Falha ao criar:\n'+e); if(b){ b.disabled=false; b.textContent='criar e rodar'; } }
}
$id('plClose').onclick=closePlanner;
$id('plNew').onclick=plNew;
plWireComposer();
$id('plSend').onclick=()=>plSend($id('plInput').value);
$id('plInput').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); plSend($id('plInput').value); } });
$id('plInput').addEventListener('input',()=>plAutoSave()); // persiste o texto em digitação (sobrevive a queda antes de enviar)
$id('plannerOverlay').addEventListener('click',e=>{ if(e.target.id==='plannerOverlay') closePlanner(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$id('plannerOverlay').style.display!=='none') closePlanner(); });

// aplica o destino Time (local/self/team) a QUALQUER modo de criação;
// devolve true quando virou cartão do time (não roda nesta máquina)
async function ntApplyShare(payload){
  const share=($id("ntShareRow").style.display!=='none')?$id("ntShare").value:'local';
  if(share==='team'){ await cloudShareTask(payload); return true; }
  const localId=await invoke('new_task', await trkBeforeNewTask(payload));
  if(share==='self') cloudPublishSelf(localId, payload).catch(e=>console.error('sync self:', e));
  return false;
}
// Este PR já foi revisado por alguém do time via Constellation? (dedup de review)
async function cloudPrReviewCheck(prUrl){
  if(!SB.sess()||!cloudTeamId()||!prUrl) return null;
  try{
    const rows=await sbGet('tasks?select=id,title,created_by,assignee,updated_at,spec&team_id=eq.'+cloudTeamId()+'&pr_url=eq.'+encodeURIComponent(prUrl)+'&order=updated_at.desc&limit=10');
    const r=(rows||[]).find(t=>((t.spec||{}).kind==='review')||/^review (do |de )?pr/i.test(t.title||''));
    if(!r) return null;
    const who=r.assignee||r.created_by;
    const p=teamProfiles[who];
    return { name:(p&&(p.name||p.email))||String(who).slice(0,8), when:agoTx(r.updated_at), mine:who===cloudUserId() };
  }catch(_){ return null; }
}
async function submitNewTask(start=true){
  if(ntMode==='review'){
    const pr = $id("ntPr").value.trim();
    if(!pr){ $id("ntPr").focus(); return; }
    const agents = $id("ntReviewer").value || null;
    const btn=$id("ntCreate"); const orig=btn.innerHTML; btn.disabled=true; btn.textContent="revisando…";
    const done=await cloudPrReviewCheck(pr).catch(()=>null);
    if(done && !confirm('⚠ Este PR já foi revisado '+(done.mine?'por VOCÊ':'por '+done.name)+' ('+done.when+') pelo Constellation — o parecer está no cartão dele na aba Time.\n\nRodar OUTRO review mesmo assim?')){ btn.innerHTML=orig; btn.disabled=false; return; }
    try{ await invoke("review_pr", { prUrl: pr, agents }); closeNewTask(); resetNewTask(); lastSig=""; await refresh(); }
    catch(e){ alert("Falha ao iniciar o review:\n"+e); }
    finally{ btn.innerHTML=orig; btn.disabled=false; }
    return;
  }
  if(ntMode==='fix'){
    const ft=$id("ntFixTitle").value.trim();
    if(!ft){ $id("ntFixTitle").focus(); return; }
    const btn=$id("ntCreate"); const orig=btn.innerHTML; btn.disabled=true; btn.textContent="corrigindo…";
    // builder só (agents=null → 1 builder), sem plano/docs, branch fix/
    const team=$id('ntFixTeam').value;
    const payload={ start:true, title:ft, workflow:team.startsWith('wf:')?team.slice(3):null, agents:team.startsWith('ag:')?team.slice(3):null, engine:$id("ntEngine").value||'claude', model:($id("ntModel")||{}).value||null, approval:'auto', owns:$id("ntFixOwns").value.trim()||null, off:null, objective:$id("ntFixObj").value.trim()||ft, deliverables:[], requirements:ntFixReq.map(x=>x.trim()).filter(Boolean), doc:$id('ntFixArtDoc').checked?'FIX.md':null, proof:$id("ntFixArtProof").checked || !!ntPolicy.proofRequired, tests:$id("ntFixArtTests").checked || !!ntPolicy.testsRequired, planApproval:'auto', refs:ntFixRefs.slice(), branchType:'fix', issue:null, issueUrl: (($id('ntIssueUrl')||{}).value||'').trim() || undefined, linkedTo: ntLinkedTo };
    try{ const t=await ntApplyShare(payload); closeNewTask(); resetNewTask(); lastSig=""; if(t) setView('team'); else await refresh(); }
    catch(e){ alert("Falha ao criar o fix:\n"+e); }
    finally{ btn.innerHTML=orig; btn.disabled=false; }
    return;
  }
  if(ntMode==='design'){
    const dt=$id("ntDzTitle").value.trim();
    if(!dt){ $id("ntDzTitle").focus(); return; }
    const what=$id("ntDzObj").value.trim();
    const screens=$id("ntDzScreens").value.trim();
    const mock=$id("ntDzMock").checked, docCk=$id("ntDzDoc").checked;
    if(!mock && !docCk){ alert('Escolha pelo menos um entregável (mockup ou DESIGN.md).'); return; }
    let n=0;
    const objective =
      `TAREFA DE DESIGN — projete ANTES de existir código. PROIBIDO implementar ou alterar arquivos do produto; você só escreve em .cardume/artifacts/.\n\n`+
      `${what||dt}\n\n`+(screens?`Telas/estados a cobrir: ${screens}\n\n`:'')+
      (ntDzRefs.length?`ANEXOS em .cardume/refs/ (${ntDzRefs.map(p=>p.split('/').pop()).join(', ')}): são os prints/referências de ONDE e DO QUE se trata — ABRA e analise cada um ANTES de desenhar; o mockup deve conversar com o que aparece neles.\n\n`:'')+
      `Explore o codebase pra entender a identidade visual do produto (cores, tipografia, espaçamento, componentes) e siga-a. Entregue em .cardume/artifacts/:\n`+
      (mock?`${++n}) mockup.html — mockup NAVEGÁVEL num arquivo só (HTML+CSS+JS inline, SEM libs externas): todas as telas/estados pedidos com navegação clicável entre elas, dados de exemplo realistas do domínio.\n`:'')+
      (docCk?`${++n}) DESIGN.md — as decisões de UX/UI: fluxo, hierarquia, estados (vazio/carregando/erro), acessibilidade, e o PORQUÊ de cada escolha. Termine com "Perguntas em aberto" se houver.\n`:'');
    const requirements=[
      ...(mock?['mockup.html navegável em .cardume/artifacts cobrindo todas as telas/estados pedidos, num arquivo só e sem libs externas']:[]),
      ...(docCk?['DESIGN.md com fluxo, hierarquia e estados (vazio/carregando/erro) e o porquê das decisões']:[]),
    ];
    const btn=$id("ntCreate"); const orig=btn.innerHTML; btn.disabled=true; btn.textContent="gerando design…";
    const payload={ start:true, title:dt, workflow:null, agents:$id('ntDzAgent').value||null, engine:$id("ntEngine").value||'claude', model:($id("ntModel")||{}).value||null, approval:'auto', owns:'.cardume/', off:null, objective, deliverables:[], requirements, doc:docCk?'DESIGN.md':null, proof:false, tests:false, autoPr:'no', planApproval:'auto', refs:ntDzRefs.slice(), branchType:'design', issue:null, issueUrl: (($id('ntIssueUrl')||{}).value||'').trim() || undefined, base:null, linkedTo: ntLinkedTo };
    try{ const t=await ntApplyShare(payload); closeNewTask(); resetNewTask(); lastSig=""; if(t) setView('team'); else await refresh(); }
    catch(e){ alert("Falha ao criar o design:\n"+e); }
    finally{ btn.innerHTML=orig; btn.disabled=false; }
    return;
  }
  if(ntMode==='invest'){
    const it=$id("ntInvTitle").value.trim();
    if(!it){ $id("ntInvTitle").focus(); return; }
    const what=$id("ntInvObj").value.trim();
    const repro=$id("ntInvRepro").checked;
    const objective =
      `TAREFA DE INVESTIGAÇÃO — descobrir a CAUSA RAIZ, não corrigir. PROIBIDO alterar arquivos do produto; você só escreve em .cardume/artifacts/ (scripts de reprodução são bem-vindos ALI).\n\n`+
      `${what||it}\n\n`+
      (ntInvRefs.length?`ANEXOS em .cardume/refs/ (${ntInvRefs.map(p=>p.split('/').pop()).join(', ')}): mostram ONDE o problema aparece — ABRA e analise cada um antes de começar.\n\n`:'')+
      `MÉTODO: 1) ${repro?'REPRODUZA o problema de verdade no ambiente real (as envs existem — sem mock); ':''}2) rastreie a causa pelo código/logs/telemetria com EVIDÊNCIAS (trechos, saídas, queries); 3) descarte hipóteses com fatos, não com achismo. Travou em algo (env, acesso, dado)? PERGUNTE via ask_human — não conclua sem evidência.\n\n`+
      `Entregue em .cardume/artifacts/:\n`+
      `1) INVESTIGATION.md — sintoma; ${repro?'reprodução passo a passo com a SAÍDA REAL; ':''}CAUSA RAIZ apontando arquivo:linha; evidências; hipóteses descartadas e por quê; RECOMENDAÇÃO de correção (o menor diff que resolve).\n`+
      (repro?`2) as provas da reprodução (saídas/prints) referenciadas no doc.\n`:'');
    const requirements=[
      ...(repro?['problema reproduzido no ambiente real com evidência anexada (saída/print) — sem mock']:[]),
      'INVESTIGATION.md com causa raiz (arquivo:linha), evidências, hipóteses descartadas e recomendação de correção',
    ];
    const btn=$id("ntCreate"); const orig=btn.innerHTML; btn.disabled=true; btn.textContent="investigando…";
    const payload={ start:true, title:it, workflow:null, agents:$id('ntInvAgent').value||null, engine:$id("ntEngine").value||'claude', model:($id("ntModel")||{}).value||null, approval:'auto', owns:'.cardume/', off:null, objective, deliverables:[], requirements, doc:'INVESTIGATION.md', proof:false, tests:false, autoPr:'no', planApproval:'auto', refs:ntInvRefs.slice(), branchType:'invest', issue:null, issueUrl: (($id('ntIssueUrl')||{}).value||'').trim() || undefined, base:null, linkedTo: ntLinkedTo };
    try{ const t=await ntApplyShare(payload); closeNewTask(); resetNewTask(); lastSig=""; if(t) setView('team'); else await refresh(); }
    catch(e){ alert("Falha ao criar a investigação:\n"+e); }
    finally{ btn.innerHTML=orig; btn.disabled=false; }
    return;
  }
  const title = $id("ntTitle").value.trim();
  if(!title){ $id("ntTitle").focus(); return; }
  const payload = {
    start,
    title,
    workflow: $id("ntWorkflow").value || null,
    agents: null,
    engine: $id("ntEngine").value,
    model: ($id("ntModel")||{}).value || null,
    models: ntModels || null,
    approval: $id("ntApprove").value,
    owns: $id("ntOwns").value.trim() || null,
    off: $id("ntOff").value.trim() || null,
    objective: $id("ntObj").value.trim() || null,
    deliverables: ntDel.map(x=>x.trim()).filter(Boolean),
    requirements: ntReq.map(x=>x.trim()).filter(Boolean),
    doc: $id("ntArtDoc").checked ? "ARCHITECTURE.md" : null,
    proof: $id("ntArtProof").checked || !!ntPolicy.proofRequired,
    tests: $id("ntArtTests").checked || !!ntPolicy.testsRequired,
    autoPr: $id("ntAutoPr").value,
    prBase: $id("ntPrBase").value.trim() || null,
    planApproval: $id("ntPlan").value,
    refs: ntRefs.slice(),
    branchType: $id("ntBranchType").value,
    issue: $id("ntIssue").value.trim() || null,
    issueUrl: ($id("ntIssueUrl").value||'').trim() || undefined,
    base: $id("ntBase").value.trim() || null,
    linkedTo: ntLinkedTo,
    light: (($id("ntLight")||{}).checked) || false,
  };
  // Detecção proativa de sobreposição de escopo (fosso): avisa ANTES de rodar,
  // não no merge. Só ao iniciar de fato e com escopo declarado. Nunca bloqueia por erro.
  if(start && payload.owns && window.Coordenacao){
    try{
      const ov = await Coordenacao.overlapCheck(payload.owns);
      if(ov && ov.length){
        const areas=[...new Set(ov.map(o=>`${o.theirs} — ${o.agent}`))].slice(0,4).map(s=>'  • '+s).join('\n');
        const extra=ov.length>4?`\n  • …e mais ${ov.length-4}`:'';
        if(!confirm(`⚠ Sobreposição de escopo com tarefa(s) ativa(s):\n\n${areas}${extra}\n\nDuas tarefas na mesma área tendem a dar conflito no merge.\nIniciar mesmo assim?  (Cancelar pra dividir o escopo ou rodar uma de cada vez.)`)){
          return;
        }
      }
    }catch(_){ /* checagem é best-effort — nunca impede a criação */ }
  }
  const btn = $id(start?"ntCreate":"ntDraft"); const orig=btn.innerHTML; btn.disabled=true; btn.textContent=start?"iniciando…":"salvando…";
  $id("ntCreate").disabled=true; $id("ntDraft").disabled=true;
  try{
    if(start){
      const t=await ntApplyShare(payload);
      if(ntEditingDraft){ invoke('remove_task',{taskId:ntEditingDraft}).catch(()=>{}); ntEditingDraft=null; }
      closeNewTask(); resetNewTask(); lastSig="";
      if(t) setView('team'); else await refresh();
    } else {
      await invoke('new_task', await trkBeforeNewTask(payload));
      if(ntEditingDraft){ invoke('remove_task',{taskId:ntEditingDraft}).catch(()=>{}); ntEditingDraft=null; }
      closeNewTask(); resetNewTask(); lastSig=""; await refresh();
    }
  }
  catch(e){ alert("Falha ao criar tarefa:\n"+e); }
  finally{ btn.innerHTML=orig; $id("ntCreate").disabled=false; $id("ntDraft").disabled=false; }
}
function parseTaskMd(content, filename){
  let fm={}, body=content;
  const m=content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if(m){ m[1].split("\n").forEach(line=>{ const i=line.indexOf(":"); if(i>0){ const k=line.slice(0,i).trim().toLowerCase(); const v=line.slice(i+1).trim().replace(/^["']|["']$/g,""); fm[k]=v; } }); body=m[2]; }
  const sec=(name)=>{ const re=new RegExp("(?:^|\\n)#{1,6}\\s*"+name+"[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)","i"); const mm=body.match(re); return mm?mm[1].trim():""; };
  const listOf=(txt)=> txt.split("\n").map(l=>l.trim()).filter(l=>/^[-*+]\s+/.test(l)||/^\d+[.)]\s+/.test(l)).map(l=>l.replace(/^[-*+]\s+/,"").replace(/^\d+[.)]\s+/,"").trim());
  const csv=(s)=> s? s.split(",").map(x=>x.trim()).filter(Boolean):[];
  const objetivo = sec("objetivo")||sec("objective")||sec("resumo")||sec("summary")||(fm.objective||"");
  return {
    title: fm.title || filename,
    objective: objetivo.replace(/^[-*+]\s+/gm,"").trim(),
    deliverables: listOf(sec("entreg")||sec("deliverables")),
    requirements: listOf(sec("requisit")||sec("requirements")||sec("crit")||sec("aceite")||sec("acceptance")),
    owns: csv(fm.owns), off: csv(fm.off||fm.off_limits),
    workflow: fm.workflow||"", engine: fm.engine||"", approval: fm.approval||""
  };
}
async function importTaskMd(){
  let files; try{ files = await invoke("import_agent_files"); }catch(e){ alert("Falha ao importar:\n"+e); return; }
  if(!files || !files.length) return;
  const t = parseTaskMd(files[0].content, files[0].filename);
  $id("ntTitle").value = t.title||"";
  $id("ntObj").value = t.objective||"";
  $id("ntOwns").value = (t.owns||[]).join(", ");
  $id("ntOff").value = (t.off||[]).join(", ");
  ntDel = t.deliverables||[]; ntReq = t.requirements||[];
  renderNtList("ntDeliverables",ntDel); renderNtList("ntRequirements",ntReq);
  const wf=$id("ntWorkflow"); if(t.workflow && [...wf.options].some(o=>o.value===t.workflow)){ wf.value=t.workflow; wf.dispatchEvent(new Event("change")); }
  if(t.engine){ const en=$id("ntEngine"); if([...en.options].some(o=>o.value===t.engine)) en.value=t.engine; }
  if(t.approval){ const ap=$id("ntApprove"); if([...ap.options].some(o=>o.value===t.approval)) ap.value=t.approval; }
}
