// Starfork — 32-planner
// ========== Planner (chat) — monta o TASK.yaml conversando ==========
// label = o que a pessoa lê (PT, sem jargão); y = a chave no TASK.yaml (aparece só em "ver como arquivo")
const PL_MESH=[
  {k:'id',      label:'identificador',            y:'id',               src:'automático', auto:true},
  {k:'title',   label:'título',                   y:'title',            src:'você',      req:true},
  {k:'objective',label:'objetivo',                y:'objective',        src:'você',      req:true,  area:true},
  {k:'deliverables',label:'o que vai ser entregue',y:'deliverables',    src:'você',      req:true,  list:true},
  {k:'requirements',label:'requisitos (como checar que ficou pronto)',y:'requirements',src:'você', list:true},
  {k:'owns',    label:'arquivos que pode mexer',  y:'scope.owns',       src:'você',      list:true, tip:'pastas/arquivos que esta tarefa pode alterar — ex.: src/pontos/**'},
  {k:'off',     label:'arquivos proibidos',       y:'scope.off_limits', src:'outras tarefas',list:true, tip:'o que esta tarefa NÃO pode tocar — vem sozinho dos arquivos que outras tarefas em andamento já estão mexendo'},
  {k:'artifacts',label:'o que entregar junto',    y:'artifacts',        src:'você',      arts:true},
  {k:'autonomy',label:'autonomia',                y:'autonomy',         src:'padrão'},
  {k:'engine',  label:'IA',                       y:'engine',           src:'padrão'},
];
const PL_TECH=new Set(['id','owns','off','artifacts','autonomy','engine']); // vão pra "Detalhes técnicos"
let plRawOpen=false; // "Detalhes técnicos" aberto? (inclui o arquivo TASK.yaml)
// o mesmo resumo, no formato do arquivo que o agente recebe (TASK.yaml) — só pra quem quer conferir
function plYaml(){
  const q=v=>{ v=String(v==null?'':v); return /^[\w./*@-]*$/.test(v)&&v?v:JSON.stringify(v); };
  const out=[];
  PL_MESH.forEach(f=>{
    const v=f.arts?Object.entries(plFields.artifacts||{}).filter(([,on])=>on).map(([k])=>k):plVal(f.k);
    if(Array.isArray(v)) out.push(f.y+':'+(v.length?'\n'+v.map(x=>'  - '+q(x)).join('\n'):' []'));
    else out.push(f.y+': '+(f.area&&String(v||'').includes('\n')?'|\n'+String(v).split('\n').map(l=>'  '+l).join('\n'):q(v)));
  });
  return out.join('\n');
}
let plFields={}, plSid='', plMsgs=[], plChips=[], plAsking='', plDone=false, plBusy=false, plRefs=[], plPlan=null, plNoEpic=false;
let plActs=[], plStopping=false; // plActs: o que a IA está fazendo agora (uma linha por ação), vindo do evento planner-activity
let plPend=[]; // anexos importados, ainda não enviados
// R8: estado do "pensando" e do card — no topo (let declarado depois = ReferenceError se usado antes da linha)
let plAfterEdit=new Set(); // tarefas do épico com os chips de "depois de" abertos pra editar
let plBusyAt=0, plBusyTick=null;
// geração: cada conversa (plReset) e cada envio ganham um id. Resposta de uma conversa que já foi trocada
// ("+ novo" com a IA respondendo) é descartada; plInflight = envios ainda sem resposta (restaura o busy da aba)
let plGenSeq=0, plConv=0, plCurGen=0; const plInflight=new Set();
function plReset(){ plFields={deliverables:[],requirements:[],owns:[],off:[],title:'',objective:'',autonomy:'',engine:'claude',artifacts:null,kind:''}; plSid=''; plMsgs=[]; plChips=[]; plAsking='objective'; plDone=false; plRefs=[]; plPlan=null; plNoEpic=false; plAfterEdit=new Set(); plConv=++plGenSeq; plBusy=false; plStopping=false; plCurGen=0; plBusyAt=0; }
function plRenderRefs(){
  const el=$id('plRefsBar'); if(!el) return;
  el.innerHTML = plRefs.map((p,i)=>{ const n=pathBase(p); return `<span class="plref"><span class="plrefic">${refIcon(n)}</span><span class="mono">${esc(n)}</span><button class="plrefx" data-r="${i}">${IC.x}</button></span>`; }).join('');
  el.querySelectorAll('.plrefx').forEach(b=>b.onclick=()=>{ plRefs.splice(+b.dataset.r,1); plRenderRefs(); });
}
// anexos do planner: composer único; o que entra também vira ref da tarefa criada
function plWireComposer(){ chatComposer({ input:'plInput', attach:'plAttach', pend:()=>plPend, taskId:()=>null, rerender:renderPlanner, afterAdd:atts=>{ atts.forEach(a=>{ if(!plRefs.includes(a.path)) plRefs.push(a.path); }); plRenderRefs(); },
  onSend:()=>plSend($id('plInput').value), send:'plSend', stop:{ btn:'plStop', busy:()=>plBusy, fn:plStop } });
  if(plBusy) plActsPaint(); } // a dica ao vivo (tempo + ação atual) é do plActsPaint — nada de texto congelado no wire
function plVal(k){ if(k==='engine'&&plFields.engineLabel) return plFields.engineLabel; if(k==='id') return plFields.title?agSlug(plFields.title):''; const v=plFields[k]; return Array.isArray(v)?v:(v||''); }
function plHas(k){ if(k==='artifacts') return plFields.artifacts!==null && plFields.artifacts!==undefined; const v=plVal(k); return Array.isArray(v)?v.length>0:!!String(v).trim(); }
function plState(k){ if(plHas(k)) return 'ok'; if(plAsking===k) return 'ask'; return 'wait'; }
function plReady(){ return plHas('title')&&plHas('objective')&&plHas('deliverables'); }
let plSaveTimer=null;
function plDraftJson(){ let input=''; try{ const i=document.getElementById('plInput'); input=i?i.value:''; }catch(_){} return JSON.stringify({ fields:plFields, sid:plSid, refs:plRefs, msgs:plMsgs.filter(m=>m.who!=='sys').slice(-40).map(m=>m.atts?{...m, atts:attLite(m.atts)}:m), chips:plChips, asking:plAsking, plan:plPlan, noEpic:plNoEpic, input }); }
// immediate=true salva NA HORA (sem debounce) — usado quando o humano envia uma
// mensagem: o raciocínio fica no disco ANTES da IA responder, então uma queda de
// luz / fechamento no meio não perde o que você acabou de escrever.
// o rascunho (save/load/clear_draft) é UM por projeto: só a aba que o carregou (a 1ª Nova demanda aberta) grava nele
let plOwnsDraft=true;
function plClearDraft(){ if(!plOwnsDraft) return Promise.resolve(); return Promise.resolve().then(()=>invoke('clear_draft')).catch(()=>{}); }
function plAutoSave(immediate){ if(plQuiet || !plOwnsDraft) return; clearTimeout(plSaveTimer); const save=()=>{ try{ invoke('save_draft',{ json: plDraftJson() }); }catch(_){} }; if(immediate){ save(); } else { plSaveTimer=setTimeout(save,400); } }
let plOpenSeq=0, plOpenDone=0; // plStartWith espera o openPlanner (async: lê o rascunho) terminar antes de enviar
async function openPlanner(){
  const seq=++plOpenSeq;
  plReset();
  $id('plannerOverlay').style.display='flex';
  // o rascunho é um só por projeto: se OUTRA aba de Nova demanda já está aberta, ele é dela — esta começa vazia
  const otherOpen=(typeof TABS!=='undefined') && TABS.some(t=>t.kind==='planner' && t.id!==activeTab);
  plOwnsDraft=!otherOpen;
  // esqueleto do chat só enquanto o rascunho é lido (sem rascunho a ler, o estado vazio do PR B entra direto).
  // Invisível até 150 ms: leitura rápida vai direto pro estado vazio/conversa, sem piscar.
  // (plQuiet = renderPlanner não vai pintar esta aba: aí não põe esqueleto que ninguém tiraria)
  if(plOwnsDraft){ const th=$id('plThread'); if(th && !plQuiet) ldPaint(th, skeletonHtml('chat', { n:2, composer:false, label:'abrindo o rascunho' })); }
  let draft=null; if(plOwnsDraft){ try{ draft=await invoke('load_draft'); }catch(e){ console.warn('[planner] rascunho não lido', e); } }
  if(draft){ try{ const d=JSON.parse(draft);
    if(d && ((d.fields&&(d.fields.title||d.fields.objective)) || (d.msgs&&d.msgs.length))){
      plFields=Object.assign(plFields, d.fields||{}); plSid=d.sid||''; plRefs=d.refs||[]; plMsgs=(d.msgs||[]).slice(); plChips=d.chips||[]; plAsking=d.asking||''; plPlan=plPlanRestore(d.plan); plNoEpic=!!d.noEpic;
      plMsgs.forEach(m=>{ if(m && m.kind==='model' && !m.choice) m.hidden=true; }); // rascunho antigo: o "Com qual IA?" agora mora na prévia
      plMsgs.unshift({who:'sys', text:'↺ Rascunho recuperado — continue de onde parou (ou "novo" no topo pra começar do zero).'});
      try{ const inp=$id('plInput'); if(inp && d.input) inp.value=d.input; }catch(_){}
    }
  }catch(_){} }
  // conversa nova: nada no fio — o estado vazio acolhedor (plEmptyHtml) aparece no lugar; a IA é trocada na prévia
  { const txt=window.ndTakeCarry?window.ndTakeCarry():''; const inp=$id('plInput'); if(txt && inp && !inp.value.trim()) inp.value=txt; }
  { const k=window.ndTakeCarryKind?window.ndTakeCarryKind():''; if(k) plFields.kind=k; } // veio do Formulário com um tipo escolhido
  renderPlanner(); plRenderRefs();
  { const th=$id('plThread'); if(plQuiet && th && th.querySelector(':scope>.ld-sk')) ldPaint(th, ''); } // render pulado: sem esqueleto órfão
  const i=$id('plInput'); if(i){ i.focus(); try{ i.setSelectionRange(i.value.length, i.value.length); }catch(_){} }
  plOpenDone=seq;
}
// abre uma aba NOVA de "Montar conversando" com o pedido do usuário já ENVIADO como 1ª mensagem
// (tela vazia "O que você quer fazer?" e a caixa única da Nova demanda). Se o projeto tinha um rascunho
// de conversa, não mistura: o texto fica na caixa e um aviso explica. opts vai pro openTab (ex.: {replace:true}).
function plStartWith(text, opts){
  text=String(text||'').trim(); if(!window.openTab) return;
  const before=plOpenSeq;
  window.openTab('planner', opts||{});
  let n=0; const go=()=>{
    const o=$id('plannerOverlay'), t=(typeof tabById==='function')?tabById(activeTab):null;
    const ready=plOpenSeq>before && plOpenDone===plOpenSeq && o && o.style.display!=='none' && t && t.kind==='planner';
    if(!ready){ if(++n<60) setTimeout(go,100); return; }
    if(!text) return;
    if(plMsgs.some(m=>m.who==='you') || plBusy){
      const i=$id('plInput'); if(i){ if(!i.value.trim()) i.value=text; i.dispatchEvent(new Event('input')); i.focus(); }
      toast('Havia uma conversa em rascunho neste projeto — seu pedido ficou na caixa. Envie ou clique "novo" pra começar do zero.','warn');
      return;
    }
    plSend(text);
  };
  setTimeout(go,60);
}
window.plStartWith=plStartWith;
async function plNew(){
  // R8: "+ novo" apagava a conversa inteira (e o épico proposto) num clique só
  if((plMsgs.some(m=>m.who==='you') || plPlan) && !await askYes('Começar uma demanda nova do zero?\n\nA conversa e o resumo desta aba são descartados.')) return;
  if(plBusy) await plStop();
  await plClearDraft();
  plReset(); ndPopClose&&ndPopClose();
  renderPlanner(); plRenderRefs(); { const i=$id('plInput'); if(i) i.focus(); }
}
function closePlanner(){ $id('plannerOverlay').style.display='none'; if(window.closeTabOfKind) window.closeTabOfKind('planner'); }
// mostra a conversa desta aba do jeito que estava (sem recarregar rascunho nem resetar)
function plShow(){ $id('plannerOverlay').style.display='flex'; { const txt=window.ndTakeCarry?window.ndTakeCarry():''; const inp=$id('plInput'); if(txt && inp && !inp.value.trim()) inp.value=txt; } { const k=window.ndTakeCarryKind?window.ndTakeCarryKind():''; if(k) plFields.kind=k; } renderPlanner(); plRenderRefs(); const i=$id('plInput'); if(i) i.focus(); }
window.plShow=plShow;
window.TAB_STATE_planner={
  get:()=>({ _title:(plFields&&plFields.title)||'', plOwnsDraft, plFields, plSid, plMsgs, plChips, plAsking, plDone, plRefs, plPlan, plNoEpic, plPend, plConv, plBusyGen:plBusy?plCurGen:0, plBusyAt, plActs:plActs.slice() }),
  // busy volta de verdade se o envio desta aba ainda está no ar (antes: sempre false → Aprovar/criar religavam no meio da resposta)
  set:(st)=>{ plFields=st.plFields||{}; plSid=st.plSid||''; plMsgs=st.plMsgs||[]; plChips=st.plChips||[]; plAsking=st.plAsking||''; plDone=!!st.plDone; plCurGen=st.plBusyGen||0; plBusy=!!(plCurGen && plInflight.has(plCurGen)); plBusyAt=plBusy?(st.plBusyAt||Date.now()):0; plActs=plBusy?(st.plActs||[]):[]; plConv=st.plConv||(st.plConv=++plGenSeq); plRefs=st.plRefs||[]; plPlan=plPlanRestore(st.plPlan); plNoEpic=!!st.plNoEpic; plPend=st.plPend||[]; plOwnsDraft=st.plOwnsDraft!==false; plAfterEdit=new Set(); if(plBusy && !plQuiet) plBusyStart(plBusyAt); }
};
function plApplyPatch(patch){
  if(!patch||typeof patch!=='object') return;
  for(const k of ['title','objective','autonomy','engine']) if(typeof patch[k]==='string'&&patch[k].trim()) plFields[k]=patch[k].trim();
  for(const k of ['deliverables','requirements','owns','off']) if(Array.isArray(patch[k])) plFields[k]=patch[k].map(x=>String(x).trim()).filter(Boolean);
  if(Array.isArray(patch.artifacts)) plFields.artifacts={doc:patch.artifacts.includes('doc'),proof:patch.artifacts.includes('proof'),tests:patch.artifacts.includes('tests')};
}
function plIsEmpty(){ return !plMsgs.some(m=>m.who==='you') && !plPlan && !plBusy; }
// medidor legível: barra fina + o que falta dos obrigatórios (antes: "resumo: 3 de 10 itens preenchidos")
function plMeterHtml(){
  if(plIsEmpty()) return '<span class="plmeterx">comece descrevendo o que precisa ser feito</span>';
  const req=PL_MESH.filter(f=>f.req), ok=req.filter(f=>plHas(f.k)).length, pct=Math.round(ok/req.length*100);
  const miss=req.filter(f=>!plHas(f.k)).map(f=>f.label);
  return `<span class="plprog" role="progressbar" aria-valuemin="0" aria-valuemax="${req.length}" aria-valuenow="${ok}" title="${ok} de ${req.length} itens essenciais"><i style="width:${pct}%"></i></span><span class="plmeterx">${plPlan?'épico proposto — revise e aprove':miss.length?'falta: '+esc(miss.join(', ')):'pronto pra criar'}</span>`;
}
// estado vazio acolhedor: o projeto em destaque, exemplos clicáveis (inclusive não-software) e o composer em foco
const ND_EX_IC={
  fix:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M5.5 5.5h5v5.2a2.5 2.5 0 0 1-5 0z"/><path d="M6.2 5.4a1.8 1.8 0 0 1 3.6 0M3 8h2.5M10.5 8H13M3.6 12l2-1M12.4 12l-2-1M3.6 4.6l2 1M12.4 4.6l-2 1"/></svg>',
  build:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.5" y="3" width="11" height="10" rx="1.6"/><path d="M8 6v4M6 8h4"/></svg>',
  invest:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="3.8"/><path d="M10 10l3.2 3.2"/></svg>',
  docs:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h5.2L12 5.3v8.2H4z"/><path d="M6 8h4M6 10.5h4M9 2.6v2.9h2.9"/></svg>',
  design:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.5" y="3" width="11" height="10" rx="1.6"/><path d="M2.5 6h11M6 6v7"/></svg>',
  review:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/><path d="M4.5 5.5v5M11.5 10.5V7a2 2 0 0 0-2-2H7.5"/></svg>',
};
function plEmptyHtml(){
  const projs=((window.projectsList&&window.projectsList())||(typeof projList==='function'?projList().map(([path,name])=>({path,name})):[])).filter(p=>p&&p.path);
  const cur=projs.find(p=>p.path===state.repo), name=(cur&&cur.name)||projShort(state.repo||'')||'';
  const sel=projs.length>1?`<select class="nd-projsel ndproj-sel" id="plProj" title="trocar o projeto onde a demanda vai abrir">${projs.map(p=>`<option value="${escA(p.path)}"${p.path===state.repo?' selected':''}>${esc(p.name||projShort(p.path))}</option>`).join('')}</select>`
    :`<b class="ndproj-name">${esc(name||'—')}</b>`;
  const ex=ndExamples(ndProjectIsSoftware(name));
  return `<div class="ndempty">
    <div class="ndproj"><span class="ndproj-ic">${IC_FOLDER}</span><span class="ndproj-l">no projeto</span>${sel}</div>
    <h1 class="ndempty-h">O que precisa ser feito?</h1>
    <p class="ndempty-sub">Descreva do seu jeito, em português normal. A IA pergunta só o que faltar e decide se vira uma tarefa ou um épico. Nada roda antes de você aprovar.</p>
    <div class="ndexs">${ex.map((e,i)=>`<button type="button" class="ndex" data-ndex="${escA(e.text)}" title="preenche a caixa abaixo — você edita e envia"><span class="ndex-k">${ND_EX_IC[e.k]||''}${esc(ndTypeName(e.k))}</span><span class="ndex-t">${esc(e.title)}</span></button>`).join('')}</div>
  </div>`;
}
const IC_FOLDER='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/></svg>';
const IC_CARET='<svg class="ndcaret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function plWireEmpty(th){
  // o texto do exemplo vai no próprio botão (data-ndex): o que você clica é o que entra na caixa
  th.querySelectorAll('[data-ndex]').forEach(b=>b.onclick=()=>{ const i=$id('plInput'); if(!i) return;
    i.value=b.dataset.ndex; i.dispatchEvent(new Event('input')); i.focus(); try{ i.setSelectionRange(i.value.length, i.value.length); }catch(_){} });
  const ps=th.querySelector('#plProj'); if(ps) ps.onchange=async()=>{ const p=ps.value, was=state.repo;
    if(p && p!==state.repo && window.switchProject){ try{ await window.switchProject(p); }catch(e){ ps.value=was||''; showErr(e, 'Não deu pra trocar de projeto'); return; } }
    renderPlanner(); };
}
// controles pequenos dentro do composer: "Tipo: Automático ▾" + o modo (Conversar · Formulário · Dividir)
function plTypeLabel(){ return plFields.kind ? ndTypeName(plFields.kind) : 'Automático'; }
function plTypePopHtml(){
  const g=ndGuessType(plGuessText());
  return `<div class="ndpop-h">Tipo de demanda <span>opcional — a IA recebe o tipo junto com a sua mensagem</span></div>
    <button type="button" class="ndpop-opt${!plFields.kind?' on':''}" data-pltype=""><b>Automático</b><span>${g?'agora parece '+esc(ndTypeName(g).toLowerCase())+' — ':''}a IA decide pelo que você escrever</span></button>
    ${ND_TYPES.map(t=>`<button type="button" class="ndpop-opt${plFields.kind===t.k?' on':''}" data-pltype="${t.k}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`).join('')}`;
}
function plOpenTypePop(anchor){
  ndPopover(anchor, plTypePopHtml(), p=>p.querySelectorAll('[data-pltype]').forEach(b=>b.onclick=()=>{ plFields.kind=b.dataset.pltype; ndPopClose(); renderPlanner(); plAutoSave(); const i=$id('plInput'); if(i) i.focus(); }));
}
function plRenderCtl(){
  const el=$id('plCtl'); if(!el) return;
  const html=`<button type="button" class="ndchip${plFields.kind?' set':''}" id="plType" aria-haspopup="dialog" title="tipo da demanda (opcional)"><span class="ndchip-l">Tipo:</span> <b>${esc(plTypeLabel())}</b>${IC_CARET}</button>${ndMethodSeg('chat')}`;
  if(el.__html!==html){ el.innerHTML=html; el.__html=html; }
  const b=$id('plType'); if(b) b.onclick=()=>plOpenTypePop(b);
}
// texto que a IA (e o palpite de tipo) enxerga: o objetivo, senão a 1ª mensagem sua, senão o que está na caixa
function plGuessText(){ const you=plMsgs.find(m=>m.who==='you'); let inp=''; try{ inp=($id('plInput')||{}).value||''; }catch(_){} return plFields.objective||(you&&you.text)||inp||''; }
function renderPlanner(){
  if(plQuiet) return; // aplicando resposta noutra aba (plInTab): não pinta a aba que está na tela
  const empty=plIsEmpty();
  // medidor
  $id('plMeter').innerHTML=plMeterHtml();
  { const cols=document.querySelector('#plannerOverlay .plcols'); if(cols) cols.classList.toggle('plempty', empty); }
  // chat
  const th=$id('plThread');
  const ci=document.activeElement, keep=(ci&&ci.id==='plInput'), iv=$id('plInput')?$id('plInput').value:null;
  const stick=stickBottom(th);
  th.innerHTML=(empty?plEmptyHtml():'')+plMsgs.map(m=>m.kind==='model'?(m.hidden?'':plModelCardHtml(m)):(empty&&m.who==='bot'?'':chatMsgHtml(m))).join('')+(plPlanCtx.origin?'':plPlanCardHtml())+(plBusy?chatThinkHtml('<span class="pltyping"><i></i><i></i><i></i></span><div class="placts" id="plActs">'+plActsHtml()+'</div>'):''); // o "pensando" vem DEPOIS do card do épico: antes ficava escondido acima dele
  if(empty) plWireEmpty(th);
  if(!plPlanCtx.origin) plWirePlanCard(); plWireModelCard(th);
  attRenderPend('plPend', plPend, renderPlanner);
  plWireComposer(); // composer único: Enter, anexos, auto-altura, ■ parar e a dica — tudo no mesmo lugar
  plRenderCtl();
  { const i=$id('plInput'); if(i) i.placeholder=empty?'Descreva o que precisa ser feito… (/ referencia uma tarefa já feita)':'responda aqui… (/ referencia uma tarefa já feita)'; }
  // um CTA primário por tela: com plano/tarefa pronta, o "enviar" vira secundário
  { const snd=$id('plSend'); if(snd) snd.classList.toggle('primary', !(plPlan||plReady())); }
  stick(th);
  // chips
  const chipsEl=$id('plChips');
  chipsEl.innerHTML=(plChips||[]).map((c,i)=>`<button class="plchip" data-chip="${i}">${esc(c)}</button>`).join('');
  chipsEl.querySelectorAll('[data-chip]').forEach(b=>b.onclick=()=>plSend(plChips[+b.dataset.chip]));
  // Resumo progressivo: o que a pessoa lê em cima; identificador, pastas, arquivos proibidos e o TASK.yaml em "Detalhes técnicos"
  const mesh=$id('plMesh');
  const fieldHtml=f=>{ const st=plState(f.k); const v=plVal(f.k); const disp=Array.isArray(v)?v.join('\n'):v;
      const ctl = f.arts ? (()=>{ const a=plFields.artifacts||{}; const chip=(k,lbl)=>`<button class="plart${a[k]?' on':''}" data-plart="${k}">${lbl}</button>`; return `<div class="plarts">${chip('doc','doc de arquitetura')}${chip('proof','prints')}${chip('tests','testes')}</div>`; })()
        : f.auto ? (()=>{ // R5-10: o id técnico (branch/pasta) é cortado em ~24 caracteres — antes parecia título quebrado ("…-na-lo")
            const tt=String(plFields.title||''), full=tt.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
            const cut=!!(disp && full.length>String(disp).length && full.startsWith(String(disp).replace(/-$/,'')));
            return `<div class="plfv mono auto" title="${escA('identificador técnico (nome da branch e da pasta'+(cut?', encurtado':'')+')'+(tt?' — da tarefa “'+tt+'”':''))}">${esc(disp)||'—'}${cut?'…':''}</div>`; })()
        : f.list ? `<textarea class="plfv in${PL_TECH.has(f.k)?' mono':''}" data-fk="${f.k}" rows="2" placeholder="um por linha…">${esc(Array.isArray(v)?v.join('\n'):'')}</textarea>`
        : f.area ? `<textarea class="plfv in" data-fk="${f.k}" rows="2" placeholder="…">${esc(disp)}</textarea>`
        : `<input class="plfv in ${f.k==='id'?'mono':''}" data-fk="${f.k}" value="${escA(disp)}" placeholder="…">`;
      return `<div class="plfield ${st}" data-k="${f.k}"${f.tip?` title="${escA(f.tip)}"`:''}><div class="plfhead"><span class="pldot"></span><span class="plfk">${esc(f.label)}</span><span class="plfsrc">${st==='ask'?'perguntando':(st==='ok'?f.src:'falta')}</span></div>${ctl}</div>`; };
  const human=PL_MESH.filter(f=>!PL_TECH.has(f.k) && (f.req || plState(f.k)!=='wait'));
  const tech=PL_MESH.filter(f=>PL_TECH.has(f.k));
  const createPrimary=plReady() && !plPlan;
  mesh.innerHTML=`<div class="plmeshh">Resumo da demanda <span class="plmesht">vai se montando enquanto vocês conversam</span></div>`+
    human.map(fieldHtml).join('')+
    `<details class="pltech" id="plRaw"${plRawOpen?' open':''}><summary><svg class="pltech-car" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4.5l3.5 3.5L6 11.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="pltech-t">Detalhes técnicos</span><span class="pltech-d">identificador, pastas, arquivo da tarefa</span></summary>`+
      `<div class="pltech-b">${tech.map(fieldHtml).join('')}<div class="pltech-yh">o arquivo que o agente recebe <span class="mono">TASK.yaml</span></div><pre class="mono">${esc(plYaml())}</pre></div></details>`+
    `<div class="plmeshfoot">${plPlan?'':(typeof estPlannerHtml==='function'?estPlannerHtml():'')+plPreviewHtml(plPreviewFields())+`<button class="btn${createPrimary?' primary':''}" id="plCreate"${plReady()&&!plBusy?'':' disabled'}>${IC.cright} criar e rodar</button>`}<div class="dim plcreatehint">${plCreateHint()}</div></div>`; // com épico proposto, o único CTA é o "Aprovar" do card (antes o "criar e rodar" criava UMA tarefa ignorando o épico)
  mesh.querySelectorAll('[data-plart]').forEach(b=>b.onclick=()=>{ const k=b.dataset.plart; if(!plFields.artifacts) plFields.artifacts={doc:false,proof:false,tests:false}; plFields.artifacts[k]=!plFields.artifacts[k]; renderPlanner(); plAutoSave(); });
  // R8: listas do resumo crescem com o conteúdo (antes o 3º requisito ficava cortado numa caixa de 2 linhas)
  mesh.querySelectorAll('textarea.plfv').forEach(t=>{ chatGrow(t); t.addEventListener('input',()=>chatGrow(t)); });
  mesh.querySelectorAll('[data-fk]').forEach(inp=>inp.addEventListener('input',()=>{ const k=inp.dataset.fk; if(PL_MESH.find(f=>f.k===k).list) plFields[k]=inp.value.split('\n').map(s=>s.trim()).filter(Boolean); else plFields[k]=inp.value; renderPlannerMeterOnly(); plAutoSave(); if(typeof estSchedule==='function') estSchedule(); }));
  bindClick('plCreate', plCreate);
  if(!plPlan && typeof estSchedule==='function'){ estPaint(); estSchedule(); } // previsão: recalcula com debounce (cache pelo conteúdo)
  if(!plPlan) plWirePreview(mesh.querySelector('.plmeshfoot'));
  { const d=$id('plRaw'); if(d) d.ontoggle=()=>{ plRawOpen=d.open; }; }
  if(keep){ const i=$id('plInput'); if(i){ if(iv!=null) i.value=iv; i.focus(); } }
}
// ---- prévia antes do Aprovar / "criar e rodar": o que a IA escolheu, em linguagem de gente, clicável ----
// (Rafa vê e troca com um clique; Carla não vê jargão: o nome técnico só aparece no popover)
function plHumanModel(engine, model){
  const e=String(engine||'claude').toLowerCase(), m=String(model||'').toLowerCase();
  if(e==='mock') return 'simulada (sem IA)';
  if(e.startsWith('codex')) return 'Codex';
  if(e.startsWith('gateway')||e.startsWith('logcomex')) return 'a da empresa';
  if(/opus|fable/.test(m)) return 'caprichada';
  if(/haiku/.test(m)) return 'rápida';
  if(/sonnet/.test(m)) return 'equilibrada';
  return m ? 'personalizada' : 'padrão do plano';
}
function plScopeLabel(owns){
  const list=(owns||[]).map(x=>String(x).trim()).filter(Boolean); if(!list.length) return 'a IA decide';
  let dirs=0, files=0; list.forEach(g=>{ const last=g.replace(/\/+$/,'').split('/').pop()||''; if(/\/$|\*\*?$/.test(g)||!/\.[a-z0-9]+$/i.test(last)) dirs++; else files++; });
  const pl=(n,a,b)=>n+' '+(n===1?a:b); return [dirs?pl(dirs,'pasta','pastas'):'', files?pl(files,'arquivo','arquivos'):''].filter(Boolean).join(' e ');
}
function plCostHuman(lo, hi, rate){ if(!(hi>0)) return '—'; const mid=(lo+hi)/2*(rate>0?rate:5.5); return '~R$ '+Math.max(1, Math.round(mid)); }
// PURA: f = { kind, guess, engine, model, owns:[], tasks (0 = épico sem tarefa marcada), costLo, costHi, rate } → HTML.
// Descreve o que o plCreate/plCreateEpic VÃO criar (ndKindCreate: entrega, PR ou não, onde mexe). Testada em app/tests/nova-demanda.test.mjs
function plPreviewHtml(f){
  f=f||{}; const k=f.kind||f.guess||'build', auto=!f.kind;
  const tipo=(ndTypeName(k)||'Feature').toLowerCase();
  const item=(key,label,val,extra)=>`<button type="button" class="ndprev-i" data-prev="${key}" aria-haspopup="dialog">${label}: <b>${esc(val)}</b>${extra||''}</button>`;
  const cr=ndKindCreate(k), nT=f.tasks==null?1:Math.max(0, +f.tasks||0);
  const parts=[
    item('tipo','Tipo', tipo, auto?'<i>automático</i>':''),
    item('entrega','Entrega', cr.delivery),
    item('modo','Vira', nT===0?'nenhuma tarefa marcada':nT>1?'épico · '+nT+' tarefas':'1 tarefa'),
    item('ia','IA', plHumanModel(f.engine, f.model)),
    item('escopo','Mexe em', cr.owns?'só os documentos (sem código)':plScopeLabel(f.owns)),
    item('custo','Custo', plCostHuman(+f.costLo||0, +f.costHi||0, +f.rate||0)), // sempre: o teto por tarefa mora no popover
  ];
  return `<div class="ndprev" role="group" aria-label="o que a IA escolheu — clique pra trocar">${parts.join('<span class="ndprev-sep" aria-hidden="true">·</span>')}</div>`;
}
// a MESMA IA que o plCreate vai usar (motor do plano; modelo escolhido ou o padrão do usuário)
function plModelNow(){ return { eng:String(plFields.engine||'claude'), model:plFields.model||aiDefaults().model||'' }; }
// tipo que a criação usa: o escolhido no chip, senão o palpite pelo que a IA já montou (o mesmo que a prévia mostra)
function plEffKind(){ return plFields.kind || ndGuessType(plGuessText()) || 'build'; }
function plEngineNorm(e){ e=String(e||'claude').toLowerCase(); return ['claude','codex','gateway','logcomex','mock'].includes(e)?e:(e.includes('codex')?'codex':e.includes('gateway')?'gateway':'claude'); }
function plTier(model){ return String(model||'').toLowerCase().replace(/.*(opus|sonnet|haiku).*/,'$1'); }
function plPreviewFields(){
  const P=(!plPlanCtx.origin && plPlan)?plPlan:null, on=P?P.tasks.filter(t=>t.on):null;
  const { eng, model }=plModelNow();
  const n=Math.max(1, (((typeof state!=='undefined'&&state.config&&state.config.workflows)||[])[0]||{steps:[1,2,3,4]}).steps.length||4);
  const est=(!P && typeof estLast!=='undefined' && estLast && estEnabled!==false)?estLast:null; // previsão calibrada (33-previsao) vence a conta fixa
  const [lo,hi]=est?[est.total.usd*EST_LO, est.total.usd*EST_HI]:typeof roughEstimate==='function'?roughEstimate(n, plTier(model)):[0,0], tasks=on?on.length:1;
  const owns=on?[...new Set(on.flatMap(t=>String(t.owns||'').split(/[,\s]+/).map(x=>x.trim()).filter(Boolean)))]:(plFields.owns||[]);
  return { kind:plFields.kind||'', guess:ndGuessType(plGuessText()), engine:eng, model, owns, tasks, costLo:lo*Math.max(1,tasks), costHi:hi*Math.max(1,tasks), rate:typeof usdBrlRate==='function'?usdBrlRate():5.5, nAgents:n };
}
// a mensagem "Com qual IA?" agora mora escondida: o card é aberto pela prévia (IA: …), não empurrado no começo da conversa
function plModelMsg(){ let m=plMsgs.find(x=>x.kind==='model'); if(!m){ m={who:'bot', kind:'model', hidden:true}; plMsgs.push(m); } return m; }
function plWirePreview(root){
  if(!root) return;
  root.querySelectorAll('[data-prev]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.prev, f=plPreviewFields();
    if(k==='tipo'||k==='entrega'){ plOpenTypePop(b); return; }
    if(k==='modo'){ ndPopover(b, `<div class="ndpop-h">Como montar <span>troque na hora — o texto vai junto</span></div><div class="ndpop-p">${f.tasks>1?'A IA propôs um épico com '+f.tasks+' tarefas em paralelo. Desmarque tarefas no card pra enxugar.':'Vira uma tarefa só. Se for grande, a IA propõe um épico com várias tarefas.'}</div>${ndMethodSeg('chat')}`); return; }
    if(k==='ia'){
      const m=plModelMsg(), before=m.choice; // a confirmação anterior fica — só muda quando você escolhe outra
      const draw=p=>{ p.innerHTML=`<div class="ndpop-h">IA desta demanda</div>${plModelCardHtml(m, true)}<div class="ndpop-tech mono" title="nome técnico">${esc(typeof aiRunLabel==='function'?aiRunLabel(f.engine, f.model):(f.engine+' · '+(f.model||'padrão')))}</div>`;
        plWireModelCard(p, ()=>{ if(m.choice && m.choice!==before){ ndPopClose(); renderPlanner(); } else { draw(p); if(p.__place) p.__place(); } }); };
      ndPopover(b, '', draw); return; }
    if(k==='escopo'){
      const off=(plFields.off||[]);
      ndPopover(b, `<div class="ndpop-h">Onde a tarefa pode mexer</div>${f.owns.length?`<div class="ndpop-globs mono">${f.owns.map(g=>esc(g)).join('<br>')}</div>`:'<div class="ndpop-p">A IA ainda não definiu — ela escolhe as pastas conforme a conversa.</div>'}${off.length?`<div class="ndpop-h" style="margin-top:10px">Não pode mexer <span>(outras tarefas estão ali)</span></div><div class="ndpop-globs mono">${off.map(g=>esc(g)).join('<br>')}</div>`:''}<button type="button" class="btn sm" data-prevtech style="margin-top:10px">editar em Detalhes técnicos</button>`,
        p=>{ const t=p.querySelector('[data-prevtech]'); if(t) t.onclick=()=>{ ndPopClose(); plRawOpen=true; renderPlanner(); const d=$id('plRaw'); if(d) d.scrollIntoView({block:'nearest'}); }; });
      return; }
    if(k==='custo'){
      ndPopover(b, `<div class="ndpop-h">Quanto deve custar</div><div class="ndpop-p">${f.costHi>0?esc(fmtCostRange(f.costLo, f.costHi)):'sem estimativa agora'} · ${f.nAgents} agentes${f.tasks>1?' × '+f.tasks+' tarefas':''} · varia com o tamanho</div>${typeof budgetFieldHtml==='function'?budgetFieldHtml('plBudget'):''}`,
        ()=>{ if(typeof budgetFieldWire==='function') budgetFieldWire('plBudget'); });
    }
  });
}
// ---- "Com qual IA?" no começo da conversa: usa o padrão do usuário ou escolhe (e pode salvar como padrão) ----
function plModelCardHtml(m, bare){
  const d=aiDefaults(); const hasDef=!!d.model||d.eng!=='claude';
  const lbl=(e,mo)=>`${aiModelName(mo)} · ${(AI_ENGINES.find(x=>x.id===e)||{}).name||e}`;
  if(m.choice && !bare){ return `<div class="plmsg bot"><span class="plav">${IC.starfork}</span><div class="plbub plmodel done"><b>IA desta demanda:</b> ${esc(lbl(m.choice.eng,m.choice.model))}${m.choice.saved?' <span class="plmtag">salvo como padrão</span>':''} <a class="plmchg" data-plm="change">trocar</a></div></div>`; }
  const wrap=h=>bare?`<div class="plmodel plmodel-bare">${h}</div>`:`<div class="plmsg bot"><span class="plav">${IC.starfork}</span><div class="plbub plmodel">${h}</div></div>`;
  const quick=[['claude','claude-opus-5-5','Opus 5.5'],['claude','claude-sonnet-5','Sonnet 5'],['claude','claude-haiku-4-5-20251001','Haiku 4.5']];
  return wrap(`
    ${hasDef?`Com qual IA? Seu padrão é <b>${esc(lbl(d.eng,d.model))}</b>.`:`Com qual IA quer montar esta demanda? Você ainda não tem um <b>padrão</b> — escolha aqui e, se quiser, eu guardo como padrão pras próximas.`}
    <div class="plmchips">${hasDef?`<button class="plchip on" data-plm="default">✓ usar o padrão · ${esc(aiModelName(d.model))}</button>`:''}${quick.filter(([e,mo])=>!(hasDef&&e===d.eng&&mo===d.model)).map(([e,mo,n])=>`<button class="plchip" data-plm="pick" data-eng="${e}" data-model="${mo}">${esc(n)}</button>`).join('')}<button class="plchip" data-plm="more">escolher… (Codex, gateway, outro id)</button></div>
    ${m.open?`<div class="aipick aipick-pl" style="margin-top:10px"></div><div style="margin-top:8px"><button class="btn primary sm" data-plm="done">usar esta</button></div>`:''}
    <label class="plmsave"><input type="checkbox" data-plm="save"${hasDef?'':' checked'}> salvar como padrão pras próximas demandas</label>
  `);
}
function plWireModelCard(th, rerender){
  const m=plMsgs.find(x=>x.kind==='model'); if(!m) return;
  const card=th.querySelector('.plmodel'); if(!card) return;
  const rr=rerender||renderPlanner;
  const saveOn=()=>{ const c=card.querySelector('[data-plm="save"]'); return !!(c&&c.checked); };
  const choose=(eng,model)=>{ aiPickApply(eng, model); const saved=saveOn(); if(saved){ aiSaveDefaults(eng, model); } m.choice={eng,model,saved}; m.open=false; plFields.engine=eng||'claude'; plFields.model=model||''; plFields.engineLabel=`${(AI_ENGINES.find(x=>x.id===eng)||{}).name||eng} · ${aiModelName(model)}`; rr(); plAutoSave(); };
  card.querySelectorAll('[data-plm="default"]').forEach(b=>b.onclick=()=>{ const d=aiDefaults(); choose(d.eng,d.model); });
  card.querySelectorAll('[data-plm="pick"]').forEach(b=>b.onclick=()=>choose(b.dataset.eng,b.dataset.model));
  card.querySelectorAll('[data-plm="more"]').forEach(b=>b.onclick=()=>{ m.open=true; rr(); });
  card.querySelectorAll('[data-plm="done"]').forEach(b=>b.onclick=()=>{ const cur=AI_TARGET_FORM.get(); choose(cur.eng,cur.model); });
  card.querySelectorAll('[data-plm="change"]').forEach(a=>a.onclick=()=>{ m.choice=null; m.open=false; rr(); });
  if(m.open){ aiPickRender(); if(window.aiPlainWatch) aiPlainWatch(card.querySelector('.aipick-pl')); }
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
    hitl:x.hitl===true, boundaries:plStrs(x.boundaries,6),
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
function plAfterOn(x){ return (x.after||[]).filter(a=>{ const t=PLP().tasks.find(y=>y.idx===a); return t&&t.on; }); }
// a tarefa `idx` depende (direta ou transitivamente) de `target`? — evita ciclo ao ligar um chip de "depois de"
function plDependsOn(idx, target, seen){
  seen=seen||new Set(); if(seen.has(idx)) return false; seen.add(idx);
  const t=PLP().tasks.find(y=>y.idx===idx); if(!t) return false;
  return (t.after||[]).some(a=>a===target || plDependsOn(a, target, seen));
}
const plRiskLabel={ low:'risco baixo', medium:'risco médio', high:'risco alto' };
// O card do épico também serve ao DESDOBRAR (31-nova-demanda-form): quem hospeda define o render e o contexto
let plPlanRender=null, plPlanCtx={}; // ctx: { origin: tarefa de origem, originNote?, description, onDone(ep), onDiscard(), onMade?(), stay?, noStartPrompt? }
// sufixo "(Origem: …)" do objetivo das tarefas do épico; originNote (mesmo '') substitui — quem hospeda (ex.: a Mesa) já pôs a origem
function plOriginSuffix(ctx){
  if(!ctx || !ctx.origin) return '';
  return ctx.originNote!=null ? String(ctx.originNote) : `\n\n(Origem: tarefa "${ctx.origin.title}" — os artefatos dela têm o contexto completo.)`;
}
let bdPlan=null; // plano do DESDOBRAR — separado do PLP() do planner, que segue vivo (rascunho, aba, resposta da IA)
function PLP(){ return plPlanCtx.origin ? bdPlan : plPlan; } // o plano que o card está mostrando
function plPlanRerender(){ (plPlanRender||renderPlanner)(); }
function plPlanSave(){ if(!plPlanCtx.origin) plAutoSave(); } // rascunho é só do planner

// ---- preview aprovável de ÉPICO dentro do chat do planner ----
function plPlanCardHtml(bare){
  if(!PLP()) return '';
  const noTeam = !(SB.sess() && cloudTeamId());
  const dis=PLP().locked?' disabled':''; // gravando na nuvem: tudo travado
  const busyHere=!plPlanCtx.origin && plBusy; // R8: a IA pode trocar o plano na resposta — aprovar agora criava o épico velho
  let rows='', lastWave=0;
  PLP().tasks.forEach((x,i)=>{
    if(x.wave!==lastWave){ lastWave=x.wave;
      rows+=`<div class="ppwave">Onda ${x.wave} <span>${x.wave===1?'· começam já, em paralelo':'· depois da onda '+(x.wave-1)}</span></div>`; }
    const after=plAfterOn(x), others=PLP().tasks.filter(o=>o!==x && o.on);
    // tudo editável antes de aprovar: prova (verify), pré-requisitos (chips das irmãs) e risco; a onda recalcula na hora
    // div, não label: só o checkbox e o título (des)marcam a tarefa; clique entre os controles não faz nada
    rows+=`<div class="pptask"><input type="checkbox" id="pptask-${i}" data-pptask="${i}" ${x.on?'checked':''}${dis}><span style="flex:1;min-width:0">
      <span class="pptitle"><label for="pptask-${i}">${esc(x.title)}</label><select class="ppsel pprisk ${x.risk||''}" data-pprisk="${i}" title="risco"${dis}>${['','low','medium','high'].map(r=>`<option value="${r}"${(x.risk||'')===r?' selected':''}>${r?plRiskLabel[r]:'risco ?'}</option>`).join('')}</select></span>${x.objective?`<span class="ppobj">${esc(x.objective)}</span>`:''}
      <span class="ppverify">✓ prova: <input class="ppedit" data-ppverify="${i}" maxlength="240" value="${escA(x.verify||'')}" placeholder="como alguém checa que esta tarefa entregou (1 linha)"${dis}>${(x.covers&&x.covers.length)?` <span class="mono ppcov">${esc(x.covers.join(' '))}</span>`:''}</span>
      ${others.length?plAfterRowHtml(x, i, after, others, dis):''}
      ${(x.boundaries&&x.boundaries.length)?`<span class="ppafter">⊘ não muda: ${esc(x.boundaries.join(' · '))}</span>`:''}${x.hitl?`<span class="ppafter">parte precisa de uma pessoa</span>`:''}
      ${(x.requirements&&x.requirements.length)?`<span class="ppreq">${x.requirements.map(r=>'☐ '+esc(r)).join('<br>')}</span>`:''}
      ${x.owns?`<span class="ppowns mono">⛶ ${esc(x.owns)}</span>`:''}</span></div>`;
  });
  const n=PLP().tasks.filter(x=>x.on).length;
  const dw=PLP().doneWhen||[], rq=PLP().requirements||[];
  const inner=`<div class="plplan" id="plPlanCard">
    <div class="pphead">${IC.starforkEm} Épico proposto — revise e aprove</div>
    <input class="ppname" id="ppName" value="${escA(PLP().epic)}" placeholder="nome do épico"${dis}>
    <textarea class="ppedit ppout" id="ppOutcome" rows="2" placeholder="resultado: pra quem, o que muda e qual sinal mostra que funcionou"${dis}>${esc(PLP().outcome||'')}</textarea>
    ${rq.length?`<div class="ppdone ppreqs"><div class="ppdh">Requisitos <span>· o que as tarefas cobrem</span></div>${rq.map(r=>`<div><span class="mono">${esc(r.id)}</span> ${esc(r.text)}</div>`).join('')}</div>`:''}
    <div class="ppdone"><div class="ppdh">Pronto quando <span>· o épico só fecha com tudo marcado</span></div>
      ${dw.map((d,i)=>`<div class="ppdwrow"><span class="mono">D${i+1}</span><input class="ppedit" data-ppdw="${i}" value="${escA(d)}" placeholder="checagem que uma pessoa roda sem abrir tarefa"${dis}><button type="button" class="ppx" data-ppdwx="${i}" title="remover"${dis}>${IC.x}</button></div>`).join('')}
      <button type="button" class="ppadd" id="ppDwAdd"${dis}>+ checagem</button></div>
    <div class="pplist">${rows}</div>
    ${noTeam?`<div class="ppwarn">Criar um épico usa o backlog do <b>time</b> — entre na conta e escolha um time (botão Conta, no rodapé da barra lateral) pra aprovar.</div>`:''}
    <div class="ppfoot">${plPlanCtx.origin?'':plPreviewHtml(plPreviewFields())}<span class="ppfoot-sp"></span><button class="btn sm" id="ppDiscard"${PLP().locked?' disabled':''}>${plPlanCtx.origin?'cancelar':'descartar'}</button><button class="btn primary sm" id="ppApprove"${(noTeam||PLP().locked||(busyHere))?' disabled':''}${busyHere?' title="espere a IA responder — ela pode ajustar o plano"':''}>${PLP().locked?'criando…':'✓ Aprovar e criar'+(n?' · '+n+' tarefa'+(n===1?'':'s'):'')}</button></div>
  </div>`;
  return bare?inner:`<div class="plmsg bot plmsg-plan"><span class="plav">${IC.starfork}</span>${inner}</div>`; // plmsg-plan: largura toda (sem :has(), que o WebKitGTK não garante)
}
// R8: "depois de" enxuto — mostra só os pré-requisitos marcados ("começa já" sem nenhum) + "mudar"; os chips de
// todas as irmãs só aparecem ao editar (antes: toda tarefa listava todas as outras, 2 linhas de chips apagados por tarefa)
function plAfterRowHtml(x, i, after, others, dis){
  const short=t=>esc(t.length>28?t.slice(0,27)+'…':t);
  if(plAfterEdit.has(x.idx) && !dis) return `<span class="ppafter">↳ depois de: ${others.map(o=>`<button type="button" class="ppchip${after.includes(o.idx)?' on':''}" data-ppafter="${i}:${o.idx}" title="${escA(o.title)}" aria-pressed="${after.includes(o.idx)}">${short(o.title)}</button>`).join('')}<button type="button" class="ppmini" data-ppafterx="${x.idx}">ok</button></span>`;
  const on=others.filter(o=>after.includes(o.idx));
  return `<span class="ppafter">${on.length?'↳ depois de: '+on.map(o=>`<span class="ppchip on static" title="${escA(o.title)}">${short(o.title)}</span>`).join(''):'↳ começa já'}${dis?'':`<button type="button" class="ppmini" data-ppaftere="${x.idx}" title="escolher de quais tarefas esta depende">mudar</button>`}</span>`;
}
function plWirePlanCard(){
  const card=$id('plPlanCard'); if(!card || PLP().locked) return; // enquanto grava na nuvem, nada muda
  // (des)marcar recalcula as ondas: quem dependia de uma tarefa desmarcada sobe de onda
  const rewave=()=>{ plWaves(PLP().tasks); plSortWaves(PLP().tasks); plPlanRerender(); plPlanSave(); };
  card.querySelectorAll('[data-pptask]').forEach(c=>c.onchange=()=>{ PLP().tasks[+c.dataset.pptask].on=c.checked; rewave(); });
  const nm=$id('ppName'); if(nm) nm.oninput=()=>{ PLP().epic=nm.value; plPlanSave(); };
  // edição do envelope e das tarefas (texto: só atualiza o modelo; estrutura: recalcula ondas e re-renderiza)
  const oc=$id('ppOutcome'); if(oc) oc.oninput=()=>{ PLP().outcome=oc.value; plPlanSave(); };
  card.querySelectorAll('[data-ppdw]').forEach(inp=>inp.oninput=()=>{ PLP().doneWhen[+inp.dataset.ppdw]=inp.value; plPlanSave(); });
  card.querySelectorAll('[data-ppdwx]').forEach(b=>b.onclick=()=>{ PLP().doneWhen.splice(+b.dataset.ppdwx,1); plPlanRerender(); plPlanSave(); });
  { const b=$id('ppDwAdd'); if(b) b.onclick=()=>{ (PLP().doneWhen=PLP().doneWhen||[]).push(''); plPlanRerender(); plPlanSave(); const ins=document.querySelectorAll('[data-ppdw]'); if(ins.length) ins[ins.length-1].focus(); }; }
  card.querySelectorAll('[data-ppverify]').forEach(inp=>inp.oninput=()=>{ PLP().tasks[+inp.dataset.ppverify].verify=inp.value.slice(0,240); plPlanSave(); });
  card.querySelectorAll('[data-pprisk]').forEach(sel=>sel.onchange=()=>{ PLP().tasks[+sel.dataset.pprisk].risk=sel.value; plPlanRerender(); plPlanSave(); });
  card.querySelectorAll('[data-ppafter]').forEach(b=>b.onclick=()=>{
    const [i,a]=b.dataset.ppafter.split(':').map(Number); const t=PLP().tasks[i]; t.after=t.after||[];
    if(t.after.includes(a)) t.after=t.after.filter(v=>v!==a);
    else if(plDependsOn(a, t.idx)){ b.classList.add('nope'); setTimeout(()=>b.classList.remove('nope'),600); return; } // ciclo: a irmã já depende desta
    else t.after.push(a);
    rewave();
  });
  card.querySelectorAll('[data-ppaftere]').forEach(b=>b.onclick=()=>{ plAfterEdit.add(+b.dataset.ppaftere); plPlanRerender(); });
  card.querySelectorAll('[data-ppafterx]').forEach(b=>b.onclick=()=>{ plAfterEdit.delete(+b.dataset.ppafterx); plPlanRerender(); });
  const dc=$id('ppDiscard'); if(dc) dc.onclick=()=>{ if(plPlanCtx.onDiscard){ plPlanCtx.onDiscard(); return; } plPlan=null; plNoEpic=true; plAfterEdit=new Set(); plMsgs.push({who:'sys',text:'Épico descartado — seguimos como tarefa única. É só continuar respondendo.'}); renderPlanner(); plAutoSave(); };
  const ap=$id('ppApprove'); if(ap) ap.onclick=plCreateEpic;
  if(!plPlanCtx.origin) plWirePreview(card.querySelector('.ppfoot'));
}
async function plCreateEpic(){
  if(!PLP()) return;
  if(!plPlanCtx.origin && plBusy){ toast('Espere a IA responder — ela pode ajustar o plano.','warn'); return; }
  if(!(SB.sess() && cloudTeamId())){ toast('Épico usa o backlog do time — entre na conta e escolha um time primeiro.','warn',{ label:'abrir Conta', fn:ERR_ACTIONS.conta }); return; }
  plWaves(PLP().tasks); plSortWaves(PLP().tasks); // ondas finais só com o que está marcado
  const picked=PLP().tasks.filter(x=>x.on);
  if(!picked.length){ toast('Marque pelo menos uma tarefa do épico.','warn'); return; }
  const name=(PLP().epic||'').trim()||'Épico';
  PLP().locked=true; plPlanRerender(); // trava o card: nenhuma edição nem segundo clique enquanto os inserts rodam
  try{
    const proj=await cloudEnsureProject();
    // envelope do épico (0025: epics.spec) — Done when vira checklist D1..Dn, marcado depois pelo criador ou pelo agente revisor
    const spec={ description:(plPlanCtx.description||plFields.objective||'').trim()||undefined, outcome:PLP().outcome||'', requirements:PLP().requirements||[],
      doneWhen:(PLP().doneWhen||[]).map(t=>String(t).trim()).filter(Boolean).map((t,i)=>({ id:'D'+(i+1), text:t })), boundaries:PLP().boundaries||[],
      // a CONVERSA do "montar conversando" viaja com o épico: o rascunho é apagado ao criar, e sem isto o raciocínio sumia
      conversation: plPlanCtx.origin ? undefined : plMsgs.filter(m=>(m.who==='you'||m.who==='bot') && m.text).slice(-60).map(m=>({ who:m.who, text:String(m.text).slice(0,4000) })) };
    // E7 (bug #11): criação IDEMPOTENTE. Se cair no meio (rede, 3º insert), o "aprovar" de novo RETOMA:
    // o épico e as tarefas já criados ficam guardados no próprio plano (PLP()._made) e não são postados de novo
    // (antes: 2º épico + tarefas repetidas no backlog do time).
    const P=PLP(); const made=P._made=(P._made&&P._made.team===cloudTeamId())?P._made:{ team:cloudTeamId(), ep:null, rows:{} };
    const resumed=!!made.ep;
    if(resumed) toast('Retomando o épico "'+name+'" — o que já foi criado não é repetido','info');
    const ep=made.ep?[made.ep]:await sbPost('epics',{ team_id:cloudTeamId(), name, created_by:cloudUserId(), spec });
    if(!ep||!ep[0]) throw new Error('a nuvem não devolveu o épico criado');
    made.ep=ep[0]; plPlanSave(); if(plPlanCtx.onMade) await plPlanCtx.onMade(); // host (Mesa) grava o progresso a cada insert
    // a criação SEGUE a prévia (decisão de 29/09): tipo → branch/entrega e a IA escolhida valem pra TODAS as tarefas
    // (só no planner — o DESDOBRAR de outra tarefa não usa o tipo/IA desta conversa)
    const cr=plPlanCtx.origin?null:ndKindCreate(plEffKind()), ai=plPlanCtx.origin?null:plModelNow();
    const created=[], idOf={}; // idx no plano → id na nuvem: `after` das tarefas vira ids reais (picked está em ordem de onda, então o pré-requisito já existe)
    for(const x of picked){
      const key=x.idx!=null?'i'+x.idx:'t'+x.title;
      if(made.rows[key]){ const row=made.rows[key]; created.push({ row, wave:x.wave }); if(x.idx!=null) idOf[x.idx]=row.id; continue; } // já criada na tentativa anterior
      const wanted=plAfterOn(x), after=wanted.map(a=>idOf[a]).filter(Boolean);
      if(after.length<wanted.length) console.warn('épico: pré-requisito sem id na nuvem, dependência perdida', x.title, wanted);
      const rows=await sbPost('tasks',{ local_id:'card-'+Math.random().toString(36).slice(2,10), project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), claim_mode:'open', title:x.title, status:'backlog', epic_id:ep[0].id,
        spec:{ title:x.title,
          objective:(x.objective||'')+plOriginSuffix(plPlanCtx), // o contexto do épico vai no EPIC.md ao assumir
          requirements:x.requirements||[], owns:(cr&&cr.owns)||x.owns||null,
          proof:!(cr&&cr.noCode)&&!!(typeof ntPolicy!=='undefined'&&ntPolicy.proofRequired), tests:!(cr&&cr.noCode)&&!!(typeof ntPolicy!=='undefined'&&ntPolicy.testsRequired),
          ...(cr?{ engine:plEngineNorm(ai.eng), model:ai.model||null, branchType:cr.branchType, autoPr:cr.autoPr, doc:cr.doc||undefined }:{}),
          wave:x.wave,
          verify:(x.verify||'').trim()||undefined, covers:(x.covers&&x.covers.length)?x.covers:undefined, after:after.length?after:undefined, risk:x.risk||undefined,
          hitl:x.hitl||undefined, boundaries:(x.boundaries&&x.boundaries.length)?x.boundaries:undefined,
          // onda 2+: fica AGUARDANDO e começa sozinha quando os pré-requisitos mergearem (epicAutoStartTick)
          autoStart:after.length?true:undefined } });
      if(rows&&rows[0]){ created.push({ row:rows[0], wave:x.wave }); if(x.idx!=null) idOf[x.idx]=rows[0].id; made.rows[key]=rows[0]; plPlanSave(); if(plPlanCtx.onMade) await plPlanCtx.onMade(); }
    }
    // painel de issues ligado: épico vira issue pai + filhas com bloqueio (só se o conector tem pai; senão fica como hoje)
    try{ if(window.trkPublishEpic) await trkPublishEpic(ep[0], created); }catch(e){ console.warn('publicar épico', e); }
    const ctx=plPlanCtx; if(ctx.origin) bdPlan=null; else plPlan=null; plAfterEdit=new Set(); plPlanRender=null; plPlanCtx={};
    if(ctx.onDone) ctx.onDone(ep[0]); else { await plClearDraft(); closePlanner(); } // BUG-8: não fecha/zera a aba "Preencher eu mesmo" (outra demanda)
    lsSet('tmEpic', ep[0].id); teamTasks=null; teamPaintSig=''; if(!ctx.stay) setView('team'); // stay: quem hospeda (Mesa) não perde a tela
    const w1=created.filter(c=>c.wave===1);
    const nLater=created.length-w1.length;
    if(w1.length && !ctx.noStartPrompt && await askYes(`Épico "${name}" criado com ${created.length} tarefa(s).\n\nIniciar AGORA as ${w1.length} tarefa(s) da onda 1 nesta máquina?\n(escopos disjuntos — rodam em paralelo)`+(nLater?`\n\nAs outras ${nLater} ficam AGUARDANDO e começam sozinhas aqui quando as anteriores forem mergeadas.`:''))){
      for(const c of w1){ try{ await teamClaimStart(c.row, null); }catch(e){ console.error('onda1:', e); } }
    }
  }catch(e){ showErr(e, 'Falha ao criar o épico (clique em aprovar de novo: o que já foi criado não se repete)'); { const P=PLP(); if(P){ P.locked=false; plPlanRerender(); } } }
}
// atualiza só o medidor/estado sem re-render pesado (ao editar campo à mão)
function renderPlannerMeterOnly(){
  const m=$id('plMeter'); if(m) m.innerHTML=plMeterHtml();
  document.querySelectorAll('#plMesh .plfield[data-k]').forEach(el=>{ const f=PL_MESH.find(x=>x.k===el.dataset.k); if(!f)return; el.className='plfield '+plState(f.k); const src=el.querySelector('.plfsrc'); if(src){ const st=plState(f.k); src.textContent=st==='ask'?'perguntando':(st==='ok'?f.src:'falta'); } });
  const c=$id('plCreate'); if(c){ c.disabled=!plReady()||plBusy; c.classList.toggle('primary', plReady() && !plPlan); }
  { const snd=$id('plSend'); if(snd) snd.classList.toggle('primary', !(plPlan||plReady())); }
  const hint=document.querySelector('.plmeshfoot .plcreatehint'); if(hint) hint.textContent=plCreateHint();
}
// ---- o que a IA está fazendo (uma linha por ação) + parar ----
// R8: igual ao chat do projeto — há quanto tempo, quantas ações e o que está fazendo AGORA, no fio E na dica do composer.
// Passou de PL_SLOW_MS sem resposta: avisa que dá pra parar e reenviar sem perder nada (antes: "pensando" mudo por minutos).
const PL_SLOW_MS=90000;
// PURA: ms desde o envio + nº de ações + última ação → { tempo, head, hint, slow }. Testada em app/tests/r8-planner-form-orq.test.mjs
function plBusyInfo(ms, nActs, last){
  const s=Math.max(0, Math.round((+ms||0)/1000)), tempo=s<60?s+'s':Math.floor(s/60)+'min '+String(s%60).padStart(2,'0')+'s';
  const slow=(+ms||0)>=PL_SLOW_MS, acts=+nActs||0, cur=String(last||'').trim();
  const head='a IA está pensando · '+tempo+(acts?' · '+acts+(acts===1?' ação':' ações'):'');
  const hint=slow?'demorando mais que o normal ('+tempo+') · ■ parar e reenviar não perde nada'
    :(cur?cur.slice(0,70)+' · '+tempo:'pensando · '+tempo)+' · ■ parar interrompe — dá pra ir escrevendo a próxima';
  return { tempo, head, hint, slow };
}
function plActsHtml(){
  const inf=plBusyInfo(plBusyAt?Date.now()-plBusyAt:0, plActs.length, plActs[plActs.length-1]);
  const acts=plActs.slice(-6).map((l,i,a)=>`<div class="${i===a.length-1?'cur':''}">${esc(l)}</div>`).join('');
  return `<div class="plactsh">${esc(inf.head)}</div>`+(acts||'<div class="cur">lendo a conversa e o projeto…</div>')
    +(inf.slow?`<div class="plslow">Está demorando mais que o normal. Pode esperar ou tocar em <b>■ parar</b>: sua mensagem volta pra caixa.</div>`:'');
}
function plActsPaint(){
  const el=$id('plActs'); if(el){ const h=plActsHtml(); if(el.__html!==h){ el.innerHTML=h; el.__html=h; } }
  if(plBusy && !plQuiet){ const i=$id('plInput'), box=i&&i.closest('.cc'); if(box) chatHintLine(box, plBusyInfo(Date.now()-plBusyAt, plActs.length, plActs[plActs.length-1]).hint, true); }
}
function plBusyStart(at){ plBusyAt=at||Date.now(); clearInterval(plBusyTick); plBusyTick=setInterval(()=>{ if(!plBusy){ clearInterval(plBusyTick); plBusyTick=null; return; } plActsPaint(); }, 1000); }
try{ window.__TAURI__.event.listen('planner-activity', ev=>{ if(!plBusy) return; const l=String((ev&&ev.payload&&ev.payload.line)||'').trim(); if(!l) return; plActs.push(l); if(plActs.length>40) plActs.shift(); plActsPaint(); }); }catch(_){ }
async function plStop(){ if(!plBusy) return; plStopping=true; plActs.push('parando…'); plActsPaint(); try{ await invoke('ai_chat_stop'); }catch(_){ } }
// Resposta da IA volta pra ABA QUE PERGUNTOU: com 2 "Montar conversando", trocar de aba enquanto a IA pensava
// fazia a resposta cair na outra conversa (plMsgs/plSid/plAsking são globais que a troca de aba reatribui).
// plInTab carrega o estado daquela aba nos globais, roda fn sem pintar a tela (plQuiet) e devolve tudo ao lugar.
let plQuiet=false;
async function plInTab(tabId, fn){
  const api=window.TAB_STATE_planner, t=(typeof tabById==='function')?tabById(tabId):null;
  if(!api || !t || activeTab===tabId) return fn(true);
  const curSt=api.get(), busy=plBusy;
  api.set(t.state||{}); plQuiet=true;
  try{ await fn(false); }
  finally{ t.state=api.get(); api.set(curSt); plBusy=busy; plQuiet=false; }
}
// PURA: o aviso de tipo que vai na frente da mensagem. Uma vez por escolha; voltar pro "Automático" depois de
// um tipo enviado avisa a IA uma vez. → { tag, next } (next = o novo kindSent, gravado só com a resposta da IA)
function plKindTag(kind, sent){
  kind=kind||''; sent=sent||'';
  if(kind && kind!==sent){ const t=ND_TYPES.find(x=>x.k===kind)||{}; return { tag:`[tipo da demanda escolhido pelo usuário: ${t.name||kind} — ${t.desc||''}]\n\n`, next:kind }; }
  if(!kind && sent) return { tag:'[tipo: automático — ignore o tipo anterior]\n\n', next:'' };
  return { tag:'', next:sent };
}
// devolve a última mensagem sua (e os anexos) pra caixa — parou ou deu erro antes da IA responder
function plTakeBack(text, atts){
  const last=plMsgs[plMsgs.length-1]; if(!(last && last.who==='you' && last.text===text)) return false;
  plMsgs.pop(); if(atts && atts.length) plPend=atts.concat(plPend);
  const i=$id('plInput'); if(i && !i.value.trim()){ i.value=text; i.dispatchEvent(new Event('input')); }
  else if(i){ i.value=text+'\n\n'+i.value; i.dispatchEvent(new Event('input')); } // re-cresce a caixa
  return true;
}
async function plSend(text){
  if(plBusy) return; text=(text||'').trim();
  const atts=plPend.splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e extraia o contexto (spec, print do bug, etc.).';
  if(!text) return;
  const myTab=activeTab, conv=plConv, gen=++plGenSeq; plCurGen=gen; plInflight.add(gen); // a aba e a conversa que perguntaram
  const inp=$id('plInput'); if(inp) inp.value='';
  plMsgs.push({who:'you', text, atts}); plChips=[]; plBusy=true; plActs=[]; plStopping=false; plBusyStart(); chatPinBottom('plThread'); renderPlanner(); plActsPaint(); // miniatura fica na memória; o rascunho salva só o essencial
  plAutoSave(true); // PERSISTE já a sua mensagem — antes da IA responder (sobrevive a queda/fechamento)
  let r=null, err=null, kindNext;
  try{
    // "vira épico" depois de ter descartado: o usuário sobrescreve — a recusa cai e a IA pode propor de novo
    // (sem \b antes de "épico": em JS \b é só ASCII e não casa com o "é"); "não vira épico" não conta
    { const V='(vira|virar|quebra|quebrar|faz|fazer|prop[õo]e|proponha|monta|montar)';
      const pede=new RegExp('\\b'+V+'\\b[^.]{0,20}épico','i').test(text), nega=new RegExp('\\b(n[ãa]o|nem|sem)\\b[^.]{0,12}\\b'+V+'\\b','i').test(text);
      if(plNoEpic && pede && !nega) plNoEpic=false; }
    // tipo escolhido no chip "Tipo ▾" (opcional): vai junto na 1ª mensagem depois de escolher/trocar
    const kt=plKindTag(plFields.kind, plFields.kindSent); kindNext=kt.next; // kindSent só muda quando a IA RESPONDE
    const prompt = kt.tag + (plNoEpic ? ('[SISTEMA: o usuário RECUSOU dividir em épico — trate como TAREFA ÚNICA e NÃO proponha épico/plan de novo]\n\n'+text) : text) + attPromptBlock(atts) + (window.trfPromptBlock ? await trfPromptBlock(text) : '');
    r=await aiCallResumeSafe((pr,sid)=>invoke('ai_chat',{ prompt:pr, sessionId:sid||'', model:aiClaudeModel() }), plSid, prompt, plMsgs.slice(0,-1));
  }catch(e){ err=e; }
  if(!err && !r) err=new Error('a IA não respondeu'); // resposta vazia não pode travar o planner (plBusy preso = "mando e não vai")
  plInflight.delete(gen);
  await plInTab(myTab, async(here)=>{
    // a conversa foi trocada ("+ novo") enquanto a IA pensava: a resposta (ou o "Parado.") é da conversa velha — descarta
    if(plConv!==conv){ if(plCurGen===gen){ plBusy=false; plStopping=false; } return; }
    if(err){ const e=err; plBusy=false; let msg=(e&&(e.message||(typeof e==='string'?e:'')))||String(e||''); msg=msg.replace(/^\[object Object\]$/,'').trim();
      // R8: parado OU falhou → a mensagem (e os anexos) voltam pra caixa desta aba; antes o erro dizia "é só enviar de novo"
      // com a caixa vazia (tinha que redigitar) e o parar perdia os anexos. Noutra aba, a mensagem fica na conversa.
      const back=here && plTakeBack(text, atts);
      if(plStopping||/PLANNER_STOPPED/.test(msg)){ plStopping=false; // noutra aba a mensagem FICA na conversa (a caixa daquela aba não está na tela)
        plMsgs.push({who:'sys', text:back?'Parado. Sua mensagem voltou pra caixa — edite e envie de novo quando quiser.':'Parado. Sua mensagem ficou na conversa.'}); renderPlanner(); plAutoSave(true); return; }
      const tail=back?' Sua mensagem voltou pra caixa — é só enviar de novo.':' Sua mensagem ficou salva na conversa.';
      // erro conhecido (login do Claude expirado, Claude não instalado, limite de uso…) → a mensagem certa + botão;
      // só "demorou demais" quando é de fato tempo esgotado (antes "Login do Claude Code EXPIROU" caía aqui)
      { const h=humanErr(msg); if(h.id!=='generic' && h.id!=='network'){ msg=h.msg+tail; if(h.action) toast(h.msg,'err',h.action); } // a ação do catálogo (entrar, instalar…) vira o botão do aviso
        else if(/timeout|timed out|demorou|rede indispon|tempo esgotado/i.test(msg)) msg='A IA demorou demais pra responder (rede lenta?).'+tail;
        else msg=(msg?'Não deu pra falar com a IA: '+errFirstLine(msg)+'.':'Algo falhou ao falar com a IA.')+tail; }
      plMsgs.push({who:'sys', text:msg}); renderPlanner(); plAutoSave(true); return; }
    if(r&&r.recovered) plMsgs.push({who:'sys', text:'a sessão anterior foi perdida — continuei com o histórico da conversa.'});
    plFields.kindSent=kindNext;
    plSid=r.sessionId||(r&&r.recovered?'':plSid);
    let obj=null; try{ const m=(r.text||'').match(/```json\s*([\s\S]*?)```/i)||(r.text||'').match(/(\{[\s\S]*\})/); if(m) obj=JSON.parse(m[1]); }catch(_){}
    plBusy=false;
    if(obj){
      plApplyPatch(obj.patch);
      plAsking=(typeof obj.asking==='string')?obj.asking:'';
      plDone=!!obj.done;
      plChips=Array.isArray(obj.chips)?obj.chips.slice(0,4):[];
      // a IA propôs um ÉPICO (várias tarefas paralelas) → vira preview aprovável no chat
      if(!plNoEpic && obj.plan && Array.isArray(obj.plan.tasks) && obj.plan.tasks.length){ plPlan=plPlanFrom(obj.plan); plAfterEdit=new Set(); } // idx do plano novo ≠ do velho
      if(obj.say) plMsgs.push({who:'bot', text:String(obj.say)});
      // você confirmou (done) e os obrigatórios fecharam → cria automaticamente (só com a aba NA TELA:
      // criar fecha abas — não pode rodar por baixo da aba que você está usando)
      if(plDone && plReady()){
        if(here){ plMsgs.push({who:'sys', text:'Confirmado — criando a tarefa e iniciando…'}); renderPlanner(); await plCreate(); return; }
        plMsgs.push({who:'sys', text:'Confirmado — volte nesta aba e toque em "criar e rodar".'});
      }
    } else {
      plMsgs.push({who:'bot', text:r.text||'(sem resposta)'});
    }
    renderPlanner(); plAutoSave();
  }).catch(e=>{ console.error('planner: aplicar resposta', e); plBusy=false; plMsgs.push({who:'sys', text:'Algo falhou ao mostrar a resposta — envie de novo.'}); renderPlanner(); });
}
// o que falta / o que acontece — uma linha só embaixo do "criar e rodar" (e no lugar dele, com épico proposto)
function plCreateHint(){
  if(plPlan) return 'o épico proposto na conversa tem o próprio “Aprovar e criar”';
  if(plBusy) return 'espere a IA responder pra criar';
  return plReady()?'o essencial está fechado — pode criar':'falta: '+PL_MESH.filter(f=>f.req&&!plHas(f.k)).map(f=>f.label).join(', ');
}
async function plCreate(){
  if(!plReady() || plBusy) return; // R8: criar com a IA respondendo fechava a aba e a resposta caía no vazio
  const b=$id('plCreate'); const bHtml=b?b.innerHTML:''; if(b){ b.disabled=true; b.textContent='criando…'; }
  const arts=plFields.artifacts||{};
  const plReqs=[...new Set([...(plFields.requirements||[]), ...(plFields.deliverables||[])].map(x=>String(x).trim()).filter(Boolean))];
  // política do repo vale também pra quem cria conversando
  const minR=Math.max(1,+((typeof ntPolicy!=='undefined'&&ntPolicy.minRequirements)||1));
  if(plReqs.length<minR){
    plMsgs.push({who:'sys', text:`A política deste repo exige pelo menos ${minR} requisito(s) verificáveis — feche os requisitos antes de criar.`});
    renderPlanner(); return;
  }
  // a criação SEGUE a prévia (decisão de 29/09): o tipo (escolhido ou o automático) define branch e entrega, igual ao formulário
  const cr=ndKindCreate(plEffKind()), ai=plModelNow();
  const payload={ start:true, title:plFields.title, workflow:null, agents:null,
    engine:plEngineNorm(ai.eng), model:ai.model||null, approval:'auto',
    owns:cr.owns||(plFields.owns||[]).join(', ')||null, off:(plFields.off||[]).join(', ')||null,
    objective:plFields.objective||null, deliverables:[],
    // entregáveis do planner viram REQUISITOS — uma lista só, cobrada com prova
    requirements:plReqs, doc:cr.doc||(arts.doc?'ARCHITECTURE.md':null), proof:!cr.noCode&&(!!arts.proof||!!(typeof ntPolicy!=='undefined'&&ntPolicy.proofRequired)), tests:!cr.noCode&&(!!arts.tests||!!(typeof ntPolicy!=='undefined'&&ntPolicy.testsRequired)), autoPr:cr.autoPr, prBase:null,
    planApproval:/ask|review/i.test(plFields.autonomy||'')?'review':'auto',
    refs:plRefs.slice(), branchType:cr.branchType, issue:null, issueUrl: plFields.issueUrl || undefined }; // BUG-8: não lê o campo de issue do FORMULÁRIO (outra aba)
  // tarefas referenciadas com "/" em qualquer mensagem sua viram contexto da tarefa criada
  if(window.trfApply) await trfApply(payload, plMsgs.filter(m=>m.who==='you').map(m=>m.text).join('\n'));
  try{ const nid=await invoke('new_task', await trkBeforeNewTask(payload)); if(typeof budgetApply==='function') await budgetApply(nid); if(typeof estSaveFor==='function') await estSaveFor(nid); await plClearDraft(); closePlanner(); lastSig=''; // BUG-8: o formulário (outra aba) fica intacto
  await refresh(); }
  catch(e){ showErr(e, 'Falha ao criar'); const b2=$id('plCreate')||b; if(b2){ b2.disabled=false; b2.innerHTML=bHtml||(IC.cright+' criar e rodar'); } }
}
$id('plClose').onclick=closePlanner;
$id('plNew').onclick=plNew;
plWireComposer();
$id('plSend').onclick=()=>plSend($id('plInput').value);
$id('plInput').addEventListener('input',()=>plAutoSave()); // persiste o texto em digitação (sobrevive a queda antes de enviar)
$id('plannerOverlay').addEventListener('click',e=>{ if(e.target.id==='plannerOverlay') closePlanner(); });
// Esc digitando (ou com modal por cima) é do campo — antes fechava a aba no meio da frase
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$id('plannerOverlay').style.display!=='none'&&!escBusy(e)) closePlanner(); });

// aplica o destino Time (local/self/team) a QUALQUER modo de criação;
// devolve true quando virou cartão do time (não roda nesta máquina)
async function ntApplyShare(payload){
  if(window.trfApply) await trfApply(payload); // "/" tarefa de referência → contexto + docs anexados
  const share=($id("ntShareRow").style.display!=='none')?$id("ntShare").value:'local';
  if(share==='team'){ await cloudShareTask(payload); return true; }
  const localId=await invoke('new_task', await trkBeforeNewTask(payload));
  if(typeof budgetApply==='function') await budgetApply(localId); // teto escolhido no "Como executar?"
  if(share==='self') cloudPublishSelf(localId, payload).catch(e=>console.error('sync self:', e));
  return false;
}
// Este PR já foi revisado por alguém do time via Starfork? (dedup de review)
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
// BUG-18: duplo clique criava 2 tarefas (o overlapCheck tem await antes de desativar o botão) — uma submissão por vez
let ntSubmitting=false;
async function submitNewTask(start=true){ if(ntSubmitting) return; ntSubmitting=true; try{ return await submitNewTaskInner(start); } finally{ ntSubmitting=false; } }
async function submitNewTaskInner(start=true){
  if(ntMode==='review'){
    const pr = $id("ntPr").value.trim();
    if(!pr){ $id("ntPr").focus(); return; }
    const agents = $id("ntReviewer").value || null;
    const btn=$id("ntCreate"); const orig=btn.innerHTML; btn.disabled=true; btn.textContent="revisando…";
    const done=await cloudPrReviewCheck(pr).catch(()=>null);
    if(done && !await askYes('Atenção: este PR já foi revisado '+(done.mine?'por VOCÊ':'por '+done.name)+' ('+done.when+') pelo Starfork — o parecer está no cartão dele na aba Time.\n\nRodar OUTRO review mesmo assim?')){ btn.innerHTML=orig; btn.disabled=false; return; }
    try{ await invoke("review_pr", { prUrl: pr, agents }); closeNewTask(); resetNewTask(); lastSig=""; await refresh(); }
    catch(e){ showErr(e, 'Falha ao iniciar o review'); }
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
    catch(e){ showErr(e, 'Falha ao criar o fix'); }
    finally{ btn.innerHTML=orig; btn.disabled=false; }
    return;
  }
  if(ntMode==='design'){
    const dt=$id("ntDzTitle").value.trim();
    if(!dt){ $id("ntDzTitle").focus(); return; }
    const what=$id("ntDzObj").value.trim();
    const screens=$id("ntDzScreens").value.trim();
    const mock=$id("ntDzMock").checked, docCk=$id("ntDzDoc").checked;
    if(!mock && !docCk){ toast('Escolha pelo menos um entregável (mockup ou DESIGN.md).','warn'); return; }
    let n=0;
    const objective =
      `TAREFA DE DESIGN — projete ANTES de existir código. PROIBIDO implementar ou alterar arquivos do produto; você só escreve em .cardume/artifacts/.\n\n`+
      `${what||dt}\n\n`+(screens?`Telas/estados a cobrir: ${screens}\n\n`:'')+
      (ntDzRefs.length?`ANEXOS em .cardume/refs/ (${ntDzRefs.map(pathBase).join(', ')}): são os prints/referências de ONDE e DO QUE se trata — ABRA e analise cada um ANTES de desenhar; o mockup deve conversar com o que aparece neles.\n\n`:'')+
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
    catch(e){ showErr(e, 'Falha ao criar o design'); }
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
      (ntInvRefs.length?`ANEXOS em .cardume/refs/ (${ntInvRefs.map(pathBase).join(', ')}): mostram ONDE o problema aparece — ABRA e analise cada um antes de começar.\n\n`:'')+
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
    catch(e){ showErr(e, 'Falha ao criar a investigação'); }
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
        if(!await askYes(`Sobreposição de escopo com tarefa(s) ativa(s):\n\n${areas}${extra}\n\nDuas tarefas na mesma área tendem a dar conflito no merge.\nIniciar mesmo assim?  (Cancelar pra dividir o escopo ou rodar uma de cada vez.)`)){
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
      if(window.trfApply) await trfApply(payload);
      await invoke('new_task', await trkBeforeNewTask(payload));
      if(ntEditingDraft){ invoke('remove_task',{taskId:ntEditingDraft}).catch(()=>{}); ntEditingDraft=null; }
      closeNewTask(); resetNewTask(); lastSig=""; await refresh();
    }
  }
  catch(e){ showErr(e, 'Falha ao criar tarefa'); }
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
  let files; try{ files = await invoke("import_agent_files"); }catch(e){ showErr(e, 'Falha ao importar'); return; }
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
