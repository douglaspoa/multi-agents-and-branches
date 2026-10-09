// Starfork — 31-nova-demanda-form
// ---- spec-first: campos obrigatórios por tipo + gate do Iniciar execução ----
const NT_REQUIRED={
  build:[['ntTitle','título'],['ntObj','objetivo']],
  fix:[['ntFixTitle','o que corrigir']],
  design:[['ntDzTitle','o que projetar'],['ntDzObj','contexto']],
  invest:[['ntInvTitle','o que investigar'],['ntInvObj','sintoma']],
  review:[['ntPr','link/nº do PR']],
};
let ntPolicy={ minRequirements:1, proofRequired:true, testsRequired:true, docRequired:false, costWarn:25 };
// PURA: o que falta pra começar, em linguagem de gente (antes: "2 campos obrigatórios faltando: …" / "spec pronta ✓")
function ntMissingText(labels){ labels=(labels||[]).filter(Boolean); return labels.length?'falta: '+labels.join(', '):'pronto pra começar'; }
function ntGate(){
  const req=NT_REQUIRED[ntMode]||[];
  const missing=req.filter(([id])=>{ const e=$id(id); return !e || !e.value.trim(); });
  // requisitos de entrega OBRIGATÓRIOS pela POLÍTICA do repo (.cardume/policy.json):
  // sem critério verificável o agente não tem contra o que provar
  const minR=Math.max(1, +ntPolicy.minRequirements||1);
  const nReq=ntMode==='build'?ntReq.filter(x=>x&&x.trim()).length:ntMode==='fix'?ntFixReq.filter(x=>x&&x.trim()).length:minR;
  if((ntMode==='build'||ntMode==='fix') && nReq<minR) missing.push(['ntRequirements',`pelo menos ${minR} requisito${minR>1?'s':''} (política do repo)`]);
  // estado por campo (redesign p8): borda verde = preenchido; âmbar = aguardando definição
  req.forEach(([id])=>{ const e=$id(id); if(!e) return; const ok=!!e.value.trim(); e.classList.toggle('okf',ok); e.classList.toggle('missf',!ok); });
  const btn=$id('ntCreate'); const ms=$id('ntMissing');
  if(btn) btn.disabled=missing.length>0;
  if(ms){
    ms.className=missing.length?'':'ok';
    ms.textContent=ntMissingText(missing.map(([,l])=>l));
  }
  if($id('ntRight').classList.contains('mdview')) ntMdRender();
  ntSideRender();
}
// ---- vista MARKDOWN do spec (redesign p9): mesma spec, outra representação ----
function ntMdRender(){
  const el=$id('ntMdPrev'); if(!el) return;
  const v=id=>{ const e=$id(id); return e?e.value.trim():''; };
  const pend='<em>— aguardando definição —</em>';
  const li=a=>a.filter(Boolean).map(x=>`<div>• ${esc(x)}</div>`).join('')||pend;
  let h='';
  if(ntMode==='build'){
    h=`<h2>Título</h2>${v('ntTitle')?esc(v('ntTitle')):pend}<h2>Objetivo</h2>${v('ntObj')?chatMd(v('ntObj')):pend}`+
      ((ntDel||[]).filter(Boolean).length?`<h2>Entregáveis</h2>${li(ntDel)}`:'')+
      `<h2>Requisitos / critérios de aceite</h2>${li(ntReq||[])}`;
  } else if(ntMode==='fix'){
    h=`<h2>O que corrigir</h2>${v('ntFixTitle')?esc(v('ntFixTitle')):pend}<h2>Detalhes</h2>${v('ntFixObj')?chatMd(v('ntFixObj')):pend}<h2>Critérios de aceite</h2>${li(ntFixReq||[])}`;
  } else if(ntMode==='design'){
    h=`<h2>O que projetar</h2>${v('ntDzTitle')?esc(v('ntDzTitle')):pend}<h2>Contexto e fluxo</h2>${v('ntDzObj')?chatMd(v('ntDzObj')):pend}<h2>Telas / estados</h2>${v('ntDzScreens')?esc(v('ntDzScreens')):pend}`;
  } else if(ntMode==='invest'){
    h=`<h2>O que investigar</h2>${v('ntInvTitle')?esc(v('ntInvTitle')):pend}<h2>Sintoma / pergunta</h2>${v('ntInvObj')?chatMd(v('ntInvObj')):pend}`;
  } else {
    h=`<h2>PR</h2>${v('ntPr')?esc(v('ntPr')):pend}`;
  }
  el.innerHTML=h;
}
// (F4: o "completar com IA" #ntAiFill era código morto — o botão não existia no HTML. Removido; quem quer a IA
// preenchendo usa o modo Conversar, que leva o texto e o tipo junto.)
// ---- WIZARD por etapas (Entrega/Fix): uma pergunta por vez, sem scroll ----
// cada campo aparece UMA vez: spec → requisitos → quem executa → avançado → confira
const WIZ_STEPS={
  build:[
    { n:1, show:[1,3], t:'O que você precisa?', h:'um título e o objetivo, com o contexto e os anexos que tiver — prefere que a IA pergunte? troque pra "Conversar" lá em cima', guide:true,
      ok:()=>!!($id('ntTitle').value.trim() && $id('ntObj').value.trim()), miss:'preencha título e objetivo' },
    { n:2, show:[2], t:'Como saber que ficou pronto?', h:()=>`frases que alguém consegue conferir ("o botão aparece no celular") — o agente precisa provar cada uma; mínimo ${Math.max(1,+ntPolicy.minRequirements||1)} neste projeto`, guide:true,
      ok:()=>ntReq.filter(x=>x&&x.trim()).length>=Math.max(1,+ntPolicy.minRequirements||1), miss:'adicione os requisitos mínimos' },
    { n:3, how:true, opt:true, t:'Quem executa?', h:'o time recomendado já vem marcado — a IA e o limite de gasto ficam logo abaixo', ok:()=>true },
    { n:4, show:[4], share:true, opt:true, t:'Ajustes avançados', h:'onde pode mexer, como entrega e compartilhar com o time — os padrões servem; pode pular', ok:()=>true },
    { n:5, rev:true, t:'Confira o pedido', h:'é exatamente isto que o agente recebe — provas e testes já vêm exigidos neste projeto', ok:()=>true },
  ],
  fix:[
    { n:1, show:[1,3], t:'O que corrigir?', h:'onde acontece, sintoma, como reproduzir — o print do bug vale mais que mil palavras', guide:true,
      ok:()=>!!$id('ntFixTitle').value.trim(), miss:'diga o que corrigir' },
    { n:2, show:[2], t:'Como saber que foi corrigido?', h:()=>`frases que alguém consegue conferir ("o pagamento conclui no iPhone") — mínimo ${Math.max(1,+ntPolicy.minRequirements||1)} neste projeto`, guide:true,
      ok:()=>ntFixReq.filter(x=>x&&x.trim()).length>=Math.max(1,+ntPolicy.minRequirements||1), miss:'adicione os critérios mínimos' },
    { n:3, how:true, opt:true, t:'Quem corrige?', h:'um agente só resolve a maioria — a IA e o limite de gasto ficam logo abaixo', ok:()=>true },
    { n:4, show:[4], share:true, opt:true, t:'Ajustes avançados', h:'provas da entrega e compartilhar com o time — pode pular', ok:()=>true },
    { n:5, rev:true, t:'Confira o pedido', h:'é exatamente isto que o agente recebe', ok:()=>true },
  ],
};
let wizN=1;
function wizModeOn(){ return ntMode==='build'||ntMode==='fix'; }
function wizRender(){
  const head=$id('wizHead'), foot=$id('wizFoot');
  if(!head||!foot) return;
  const on=wizModeOn();
  const seg=document.querySelector('#ntRight .seg2'); if(seg) seg.style.display=on?'none':'flex';
  document.querySelectorAll('#ntBuildFields .wstep,#ntFixFields .wstep').forEach(e=>e.style.display='');
  const md=$id('ntMdPrev');
  const contB=$id('ntBuildFields'), contF=$id('ntFixFields');
  { const c=$id('ntCreate'); if(c) c.style.display=on?'none':''; } // no wizard, quem inicia é a última etapa
  const footL=$id('wizFootL');
  { const ms=$id('ntMissing'); if(ms) ms.style.display=on?'none':''; }
  if(!on){
    // modos sem etapas (review/design/investigar): cabeçalho fixo com o tipo + o que ele faz
    head.style.display='block'; foot.style.display='none'; if(footL) footL.style.display='none';
    $id('wizProg').innerHTML='';
    $id('wizStep').textContent=ntMode==='review'?'review':ntMode==='design'?'design':'investigação';
    $id('wizT').textContent=ntMode==='review'?'Qual PR revisar?':ntMode==='design'?'O que projetar?':'O que investigar?';
    $id('wizH').textContent=($id('ntHint')||{}).textContent||'';
    { const g=$id('wizGuide'); if(g) g.style.display='none'; }
    ['ntTeamRow','ntFixTeamRow'].forEach(id=>{ const e=$id(id); if(e) e.style.display=''; });
    { const hp=$id('ntHowPane'), hf=$id('howFootRow'); if(hp) hp.style.display='none'; if(hf) hf.style.display='flex'; }
    wizShareApply(null);
    if(md&&!$id('ntRight').classList.contains('mdview')) md.style.display='none'; return; }
  const cont=ntMode==='build'?contB:contF;
  const steps=WIZ_STEPS[ntMode];
  const st=steps.find(s=>s.n===wizN)||steps[0];
  head.style.display='block'; foot.style.display='flex'; if(footL) footL.style.display='flex';
  cont.querySelectorAll('.wstep').forEach(e=>{ e.style.display=(st.show||[]).includes(+e.dataset.w)?'':'none'; });
  // equipe/motor/modelo vivem na etapa "Quem executa?" — não repetem no avançado
  ['ntTeamRow','ntFixTeamRow'].forEach(id=>{ const e=$id(id); if(e) e.style.display='none'; });
  // Time & épico só na etapa marcada (e só se a nuvem liberou — ntShareSync)
  wizShareApply(st);
  // etapa "Quem executa?": o painel do Como executar vira o corpo da etapa
  { const hp=$id('ntHowPane'), hf=$id('howFootRow'), hh=$id('howHead');
    if(st.how){ howPopulate(); aiPickRender(); hp.style.display='block'; if(hf) hf.style.display='none'; if(hh) hh.style.display='none'; cont.style.display='none'; md.style.display='none'; }
    else hp.style.display='none'; }
  if(st.rev){ ntMdRender(); md.style.display='block'; cont.style.display='none'; }
  else if(!st.how){ md.style.display='none'; cont.style.display=''; }
  // etapas CLICÁVEIS (F4): voltar é livre; avançar só passando pelas obrigatórias (a etapa que falta ganha o foco)
  $id('wizProg').innerHTML=`<nav class="g2steps" aria-label="Etapas">${steps.map(s=>`<button type="button" class="${s.n<wizN?'done':s.n===wizN?'on':''}" data-wizgo="${s.n}"${s.n===wizN?' aria-current="step"':''}><span class="c">${s.n}</span>${esc(s.t)}${s.opt?'<small>opcional</small>':''}</button>`).join('')}</nav>`;
  $id('wizProg').querySelectorAll('[data-wizgo]').forEach(b=>b.onclick=()=>{ const to=+b.dataset.wizgo; if(to===wizN) return; if(to>wizN){ const bad=steps.find(x=>x.n<to && x.n>=wizN && !x.ok()); if(bad){ wizN=bad.n; wizRender(); const m=$id('wizMiss'); if(m) m.textContent=bad.miss||'complete esta etapa'; const f=wizMissField(bad); if(f) try{ f.focus(); }catch(_){ } return; } } wizN=to; wizRender(); });
  $id('wizStep').textContent='';
  { const m=$id('ntSum'); if(m) m.textContent=`etapa ${st.n} de ${steps.length}${st.opt?' · opcional':''} · campo a campo, sem conversa`; }
  $id('wizT').textContent=st.t;
  $id('wizH').textContent=typeof st.h==='function'?st.h():st.h;
  // guia do repo: agora mora em "Padrões que valem aqui" (coluna da direita) — o <details> antigo fica escondido
  { const g=$id('wizGuide');
    if(g) g.style.display='none'; }
  const last=wizN===steps[steps.length-1].n;
  if(footL) footL.innerHTML=(wizN>1?`<button class="btn nf-ghost" id="wizBack">← voltar</button>`:'');
  foot.innerHTML=
    `<span class="dim" id="wizMiss" style="font-size:var(--fs-xs);color:var(--warn)"></span>`+
    (st.opt?`<button class="btn nf-ghost" id="wizSkip">pular</button>`:'')+
    `<button class="btn primary" id="wizNext">${last?((typeof ntShareIsTeam==='function'&&ntShareIsTeam())?'Mandar pro time':'Iniciar execução'):'próximo →'}</button>`;
  bindClick('wizBack', ()=>{ wizN=steps[Math.max(0,steps.findIndex(s=>s.n===wizN)-1)].n; wizRender(); });
  bindClick('wizSkip', ()=>{ wizN=steps[steps.findIndex(s=>s.n===wizN)+1].n; wizRender(); });
  { const b=$id('wizNext'); if(b) b.onclick=()=>{
      if(last){ wizLaunch(); return; }
      if(!st.ok()){ const m=$id('wizMiss'); if(m){ m.innerHTML=IC.warn+' '+esc(st.miss||'complete esta etapa'); clearTimeout(m.__t); m.__t=setTimeout(()=>{ if(m) m.textContent=''; },4000); }
        // R8: leva o cursor pro 1º campo que falta (antes só um aviso que sumia em 2,6 s, sem dizer onde)
        { const f=wizMissField(st);
          if(f){ try{ f.focus(); f.classList.add('missnow'); f.addEventListener('input',()=>f.classList.remove('missnow'),{once:true}); f.scrollIntoView({block:'nearest'}); }catch(_){} } }
        return; }
      wizN=steps[steps.findIndex(s=>s.n===wizN)+1].n; wizRender();
    }; }
}
// o 1º campo que falta NA ETAPA ATUAL: só as seções que ela mostra (st.show), só campos visíveis;
// obrigatório vazio, senão o 1º requisito vazio, senão o "+ item" da lista de requisitos
function wizMissField(st){
  const cont=$id(ntMode==='fix'?'ntFixFields':'ntBuildFields'); if(!cont||!st) return null;
  const secs=[...cont.querySelectorAll('.wstep')].filter(e=>(st.show||[]).includes(+e.dataset.w));
  const req=new Set((NT_REQUIRED[ntMode]||[]).map(([id])=>id));
  const vis=e=>e && e.offsetParent!==null && !e.disabled;
  for(const sec of secs){ const f=[...sec.querySelectorAll('input,textarea')].find(e=>vis(e) && req.has(e.id) && !e.value.trim()); if(f) return f; }
  for(const sec of secs){ const f=[...sec.querySelectorAll('#ntRequirements input, #ntFixReqs input')].find(e=>vis(e) && !e.value.trim()); if(f) return f; }
  for(const sec of secs){ const b=sec.querySelector('#ntReqAdd, #ntFixReqAdd'); if(vis(b)) return b; }
  return null;
}
// Time & épico: aparece numa etapa só do wizard (fora dele, quem manda é ntShareSync)
function wizShareApply(st){
  const r=$id('ntShareRow'); if(!r) return;
  const cloudOk=r.dataset.cloud==='1';
  if(wizModeOn()&&$id('ntOverlay').style.display!=='none'){
    if(!st){ const s=WIZ_STEPS[ntMode]; st=s&&(s.find(x=>x.n===wizN)||s[0]); }
    r.style.display=(st&&st.share&&cloudOk)?'block':'none';
  } else r.style.display=cloudOk?'block':'none';
}
// ---- modal de progresso da criação (estilo abertura de PR) ----
const GO_STEPS=[['spec','pedido montado'],['req','como saber que ficou pronto'],['issue','preparando uma cópia isolada do projeto'],['agent','chamando o agente']];
let goState={};
function goRender(nReq){
  const el=$id('goSteps'); if(!el) return;
  el.innerHTML=GO_STEPS.map(([k,l])=>{
    const s=goState[k]||'wait';
    const ic=s==='ok'?'✓':s==='run'?'◌':s==='err'?'✕':'·';
    const col=s==='ok'?'var(--accent)':s==='err'?'var(--warn)':s==='run'?'var(--text)':'var(--muted)';
    return `<div style="display:flex;gap:9px;align-items:center;font-size:var(--fs-sm);color:${col}"><span class="mono" style="width:14px">${ic}</span>${k==='req'?`${l} (${nReq})`:l}${s==='run'?'…':''}</div>`;
  }).join('');
}
function goShow(nReq){ goState={spec:'ok',req:'ok',issue:'run',agent:'wait'}; goRender(nReq); $id('goOverlay').style.display='flex'; ldPaint($id('goSky'), brandLoaderHtml('colocando no ar', { now:true })); }
function goHide(){ $id('goOverlay').style.display='none'; }
// última etapa do wizard: aplica as escolhas do "Quem executa?" e cria mostrando progresso
let wizLaunching=false; // duplo clique no "Iniciar execução" escondia o progresso; "voltar" seguia ativo durante a criação
async function wizLaunch(){
  if(wizLaunching || (typeof ntSubmitting!=='undefined' && ntSubmitting)) return;
  wizLaunching=true; ['wizNext','wizBack','wizSkip'].forEach(id=>{ const b=$id(id); if(b) b.disabled=true; });
  try{ return await wizLaunchInner(); }
  finally{ wizLaunching=false; ['wizNext','wizBack','wizSkip'].forEach(id=>{ const b=$id(id); if(b) b.disabled=false; }); }
}
async function wizLaunchInner(){
  ntGate();
  const pick=document.querySelector('input[name="howflow"]:checked');
  const src=$id(ntMode==='fix'?'ntFixTeam':'ntWorkflow');
  if(pick&&src) src.value=pick.value;
  { const hm=$id('howModel'), nm=$id('ntModel'); if(hm&&nm&&hm.value) nm.value=hm.value; }
  ntModels=[...document.querySelectorAll('[data-agmodel]')].filter(s=>s.value).map(s=>`${s.dataset.agmodel}=${s.value}`).join(',');
  { const hb=$id('howBudget'); if(hb) ntBudgetPending=Math.max(0, parseFloat(hb.value)||0); } // teto DESTA tarefa
  { const hs=$id('howSlots'); if(hs&&hs.value) setSlotMax(parseInt(hs.value,10)||slotMax); }
  const nReq=(ntMode==='fix'?ntFixReq:ntReq).filter(x=>x&&x.trim()).length;
  goShow(nReq);
  await submitNewTask(true);
  // sucesso fecha a página da Nova demanda; se continuar aberta, deu erro (o alert já falou)
  if($id('ntOverlay').style.display!=='none'){ goHide(); return; }
  goState.issue='ok'; goState.agent='ok'; goRender(nReq);
  setTimeout(goHide, 900);
}
{ const f=$id('ntVForm'), m=$id('ntVMd');
  if(f&&m){
    const set=md=>{ $id('ntRight').classList.toggle('mdview',md); f.classList.toggle('on',!md); m.classList.toggle('on',md); if(md) ntMdRender(); };
    f.onclick=()=>set(false); m.onclick=()=>set(true);
  } }
// ---- Como executar? — fluxo/modelo/limites antes de iniciar (build & fix) ----
// howPopulate monta as opções; openHow (legado, fora do wizard) também ativa a visão
function openHow(){ howPopulate();
  $id('ntRight').classList.add('howview');
  $id('ntOverlay').classList.add('howmode');
}
function howPopulate(){
  const src=$id(ntMode==='fix'?'ntFixTeam':'ntWorkflow');
  const opts=[...(src?src.options:[])].map(o=>({v:o.value,l:o.textContent})).filter(o=>o.v);
  // corrente de avatares do fluxo (redesign p10)
  const wfs=(state.config&&state.config.workflows)||[];
  const byId=Object.fromEntries(((state.config&&state.config.agents)||[]).map(a=>[a.id,a]));
  const chainOf=(wid)=>{
    const w=wfs.find(x=>x.id===wid); if(!w) return '';
    const team=(w.steps||[]).map(s=>byId[s]).filter(Boolean);
    return team.length?`<span class="howchain">${team.map(a=>`<span class="fwav" aria-hidden="true" style="background:${agentColor(a.name)};width:17px;height:17px;font-size:var(--fs-ini)" title="${escA(a.name)}">${esc((a.name||'?').slice(0,1).toUpperCase())}</span>`).join('<span style="color:var(--muted);font-size:var(--fs-xs)">→</span>')}</span>`:'';
  };
  const items=[
    { v:'', t:'Entrega simples', d:'só o builder, direto ao ponto — sem revisão adicional', rec:false, chain:'' },
    ...opts.map((o,i)=>({ v:o.v, t:o.l, d:i===0?'planeja, implementa, testa e revisa antes de te trazer pra review':'fluxo do catálogo do time', rec:i===0, chain:chainOf(o.v), team:i>0 })),
  ];
  const cur=src?src.value:'';
  const box=$id('howOpts');
  const optHtml=(it)=>`<label class="howopt${(cur?it.v===cur:it.rec)?' on':''}"><input type="radio" name="howflow" value="${escA(it.v)}" ${(cur?it.v===cur:it.rec)?'checked':''}><span><span class="ht">${esc(it.t)}</span>${it.chain?`<div style="margin:4px 0 2px;display:flex;align-items:center;gap:4px">${it.chain}</div>`:''}<div class="hd">${esc(it.d)}</div></span>${it.rec?'<span class="rec">RECOMENDADO</span>':''}</label>`;
  const main2=items.filter(it=>!it.team), team2=items.filter(it=>it.team);
  box.innerHTML=main2.map(optHtml).join('')+
    (team2.length?`<div style="display:flex;align-items:center;gap:8px;margin:12px 0 6px"><span class="mono" style="font-size:var(--fs-xs);letter-spacing:.08em;color:var(--muted)">FLUXOS DO TIME</span><span style="flex:1"></span><button class="btn sm" id="howManage" style="padding:2px 8px;font-size:var(--fs-xs)">gerenciar</button></div>`+team2.map(optHtml).join(''):'');
  bindClick('howManage', ()=>{ closeHow(); openAgents(); });
  box.querySelectorAll('.howopt').forEach(l=>l.onclick=()=>{ box.querySelectorAll('.howopt').forEach(x=>x.classList.remove('on')); l.classList.add('on'); l.querySelector('input').checked=true; howAgentsRender(); });
  setSelValue($id('howModel'), ($id('ntModel')||{}).value||''); // id completo (ex.: claude-opus-5-5) não some
  $id('howModel').onchange=howEstimateUpdate;
  howAgentsRender();
  { const hb=$id('howBudgetHost'); if(hb){ ntBudgetPending=null; hb.innerHTML=budgetFieldHtml('howBudget'); budgetFieldWire('howBudget'); } }
  $id('howSlots').value=slotMax;
}
function closeHow(){ $id('ntRight').classList.remove('howview'); $id('ntOverlay').classList.remove('howmode'); }
$id('howCancel').onclick=closeHow;
// modelo POR AGENTE do fluxo escolhido (redesign p10) — vira --models no CLI
let ntModels='';
// estimativa GROSSA de custo pré-run: nº de agentes × faixa por modelo. Dá noção
// de ordem de grandeza — o custo real depende do tamanho da tarefa.
function howEstimateUpdate(){
  const el=$id('howEstimate'); if(!el) return;
  const pick=document.querySelector('input[name="howflow"]:checked');
  const wid=pick?pick.value:'';
  const wfs=(state.config&&state.config.workflows)||[];
  const w=wfs.find(x=>x.id===wid);
  const n=w?((w.steps||[]).length||1):1;
  const model=(($id('howModel')||{}).value)||'';
  const [lo,hi]=roughEstimate(n, model);
  el.innerHTML=`Estimativa grosseira: <b style="color:var(--text-2)">${esc(fmtCostRange(lo,hi))}</b> · ${n} agente(s)${model?` · ${esc(model)}`:''} <span class="dim">(varia com o tamanho da tarefa)</span>`;
}
function howAgentsRender(){
  howEstimateUpdate();
  const el=$id('howAgents'); if(!el) return;
  const pick=document.querySelector('input[name="howflow"]:checked');
  const wid=pick?pick.value:'';
  const wfs=(state.config&&state.config.workflows)||[];
  const byId=Object.fromEntries(((state.config&&state.config.agents)||[]).map(a=>[a.id,a]));
  const w=wfs.find(x=>x.id===wid);
  const team=w?(w.steps||[]).map(s=>byId[s]).filter(Boolean):[];
  // L7 (mesa-bugs-2): as opções seguem a IA escolhida (antes só Claude, mesmo com Codex); motor sem lista = sem a escolha
  const opts=ntAgentModelOpts(($id('ntEngine')||{}).value);
  if(team.length<2 || !opts.length){ el.innerHTML=''; return; }
  el.innerHTML=`<label>Modelo por agente <span class="dim" style="text-transform:none;letter-spacing:0">(sobrepõe o modelo geral)</span></label>`+
    team.map(a=>`<div style="display:flex;align-items:center;gap:9px;margin-top:7px"><span class="fwav" aria-hidden="true" style="background:${agentColor(a.name)}">${agentBadge(a.name)}</span><span style="flex:1;font-size:var(--fs-sm)">${esc(a.name)} <span class="dim">· ${esc(a.role)}</span></span><select class="sel" data-agmodel="${escA(a.name)}" style="width:165px" aria-label="${escA('modelo de '+a.name)}"><option value="">modelo geral</option>${opts.map(([v,l])=>`<option value="${escA(v)}">${esc(l)}</option>`).join('')}</select></div>`).join('');
}
// @puro-agmodel-inicio — opções do "Modelo por agente" pelo motor: Claude = os 3 apelidos; outro motor = a lista dele (sem o "padrão")
function ntAgentModelOpts(engine){
  const k=(typeof aiEngineOf==='function')?aiEngineOf(engine||'claude'):'claude';
  if(k==='claude') return [['opus','Claude Opus'],['sonnet','Claude Sonnet'],['haiku','Claude Haiku']];
  const e=(typeof AI_ENGINES!=='undefined'?AI_ENGINES:[]).find(x=>x.id===k);
  return ((e&&e.models)||[]).filter(m=>m&&m.id).map(m=>[m.id, m.name||m.id]);
}
// @puro-agmodel-fim
$id('howGo').onclick=()=>{
  const pick=document.querySelector('input[name="howflow"]:checked');
  const src=$id(ntMode==='fix'?'ntFixTeam':'ntWorkflow');
  if(pick && src){ src.value=pick.value; if(typeof ntTeamTouched!=='undefined') ntTeamTouched=true; }
  const nm=$id('ntModel'); if(nm) nm.value=$id('howModel').value;
  ntModels=[...document.querySelectorAll('[data-agmodel]')].filter(s=>s.value).map(s=>`${s.dataset.agmodel}=${s.value}`).join(',');
  { const hb=$id('howBudget'); if(hb) ntBudgetPending=Math.max(0, parseFloat(hb.value)||0); } // teto DESTA tarefa
  setSlotMax(parseInt($id('howSlots').value,10)||slotMax);
  closeHow();
  submitNewTask(true);
};

// ---- cadeia de política/guia: padrão do PRODUTO < organização < repo ----
const ORG_DEFAULT_POLICY={ minRequirements:1, proofRequired:true, testsRequired:true, docRequired:false, costWarn:25 };
const DEFAULT_SPEC_TEMPLATE=`# Guia de demanda — template padrão do Starfork

Sua organização pode sobrescrever este guia (Conta → Padrões da organização);
um repo pode refinar com .cardume/SPEC.md. A IA e o wizard seguem este texto.

## Toda demanda precisa responder
1. ONDE a mudança aparece (tela/rota/módulo — caminho real).
2. COMO saberemos que está pronta (critérios que alguém marca ✓/✗ testando).
3. O que fica FORA do escopo (evita o agente inventar trabalho).

## Requisitos padrão (inclua sempre que se aplicarem)
- "Estados vazio, carregando e erro tratados nas telas novas."
- "Suíte de testes do repo passa, com a saída anexada como prova."
- "Prova real na UI/ambiente (print) — nunca mock."

## Proibições
- Requisito vago ("funcionar bem", "melhorar a UX") — sempre verificável.
- Duplicar entregável como requisito.
- Mais de uma exigência num requisito só (quebre em dois).`;
let orgDefCache=null, orgDefAt=0;
async function orgDefaultsGet(){
  const orgId=cloudData&&cloudData.org&&cloudData.org.id;
  if(!orgId||!SB.sess()) return {};
  if(orgDefCache && Date.now()-orgDefAt<10*60*1000) return orgDefCache;
  try{ const rows=await sbGet('orgs?select=policy,spec_template&id=eq.'+orgId); orgDefCache=rows[0]||{}; orgDefAt=Date.now(); }
  catch(_){ orgDefCache=orgDefCache||{}; }
  return orgDefCache;
}
async function policyChain(){
  let r={}; try{ r=await invoke('read_policy'); }catch(_){ }
  const og=await orgDefaultsGet();
  const pol={ ...ORG_DEFAULT_POLICY, ...((og&&og.policy)||{}), ...((r&&r.repoPolicy)||{}) };
  pol.specGuide=(r&&r.repoGuide) || (og&&og.spec_template) || DEFAULT_SPEC_TEMPLATE;
  pol.guideFrom=(r&&r.repoGuide)?'repo':(og&&og.spec_template)?'org':'padrao';
  return pol;
}
async function openNewTask(){
  // página na hora — o catálogo (config) chega logo atrás e preenche os selects
  closeHow(); // garante que não reabre na etapa "Como executar?"
  // o TIPO vem da tela de início ("Que tipo de demanda é essa?") — aqui só se aplica
  if(window.ntPresetType){
    const t=window.ntPresetType; window.ntPresetType=null;
    ntMode=(window.ND_TO_MODE||{})[t]||'build';
    ntDocsPreset=(t==='docs');
  }
  setNtMode(ntMode);
  { const bt=$id('ntBranchType'); if(bt && ntDocsPreset) bt.value='docs'; }
  if(typeof ntKindPaint==='function'){ if(ntDocsPreset) ntKind='documento'; ntKindPaint(); } // tipo de entrega + estimativa + teto
  // o que veio do "Conversar" (seletor de modo): texto → título + objetivo; entregas/requisitos que a conversa já montou
  // entram nas listas. Nada que já está preenchido é apagado.
  { const c=window.ndTakeCarryAll?window.ndTakeCarryAll():{}; if(c.text){
      const F={ build:['ntTitle','ntObj'], fix:['ntFixTitle','ntFixObj'], design:['ntDzTitle','ntDzObj'], invest:['ntInvTitle','ntInvObj'] }[ntMode];
      const sp=ndSplitCarry(c.text, c.title);
      if(F){ const t=$id(F[0]), o=$id(F[1]); if(t && !t.value.trim()) t.value=sp.title; if(o && !o.value.trim()) o.value=sp.objective; }
      else if(ntMode==='review'){ const pr=$id('ntPr'); const u=c.text.match(/https?:\/\/\S+/); if(pr && u && !pr.value.trim()) pr.value=u[0]; }
      if(ntMode==='build'){ if(!ntDel.filter(Boolean).length && (c.deliverables||[]).length) ntDel=c.deliverables.slice(); if(!ntReq.filter(Boolean).length && (c.requirements||[]).length) ntReq=c.requirements.slice(); renderNtList("ntDeliverables", ntDel); renderNtList("ntRequirements", ntReq); }
      else if(ntMode==='fix' && !ntFixReq.filter(Boolean).length && (c.requirements||[]).length){ ntFixReq=c.requirements.slice(); renderNtList("ntFixReqs", ntFixReq); } } }
  renderNtList("ntDeliverables", ntDel); renderNtList("ntRequirements", ntReq); renderNtList("ntFixReqs", ntFixReq); renderDzRefs(); renderFixRefs();
  ntFillProjects();
  $id("ntOverlay").style.display = "flex";
  // POLÍTICA do repo: provas/testes obrigatórios ficam LIGADOS e travados — a
  // entrega tem que sair completa, sem depender da disciplina de cada dev
  try{ ntPolicy={ ...ntPolicy, ...(await policyChain()) }; }catch(_){ }
  const lock=(id,on)=>{ const e=$id(id); if(!e) return; if(on){ e.checked=true; e.disabled=true; e.closest('label')?.setAttribute('title','obrigatório pela política do repo (.cardume/policy.json)'); } else { e.disabled=false; } };
  lock('ntArtProof', !!ntPolicy.proofRequired); lock('ntArtTests', !!ntPolicy.testsRequired); lock('ntArtDoc', !!ntPolicy.docRequired);
  lock('ntFixArtProof', !!ntPolicy.proofRequired); lock('ntFixArtTests', !!ntPolicy.testsRequired);
  // quem abre com a spec já pronta (ex.: tarefa a partir de uma issue) escolhe em que etapa cair
  wizN=(typeof window.ntPresetStep==='function')?(window.ntPresetStep()||1):1; window.ntPresetStep=null; wizRender();
  ntGate();
  (ntMode==='review'?$id("ntPr"):ntMode==='design'?$id("ntDzTitle"):ntMode==='fix'?$id("ntFixTitle"):ntMode==='invest'?$id("ntInvTitle"):$id("ntTitle")).focus();
  try{ state.config = await invoke("config"); }catch(e){ state.config = {workflows:[],agents:[]}; }
  const wfSel = $id("ntWorkflow");
  const wfs = (state.config && state.config.workflows) || [];
  const byId = Object.fromEntries(((state.config&&state.config.agents)||[]).map(a=>[a.id,a]));
  wfSel.innerHTML = wfs.length
    ? wfs.map(w=>`<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("")
    : `<option value="">(sem catálogo — 1 builder)</option>`;
  const updatePrev = ()=>{
    const w = wfs.find(x=>x.id===wfSel.value);
    $id("ntWfPrev").textContent = w
      ? "equipe: " + w.steps.map(s=>(byId[s]?byId[s].name+" ("+byId[s].role+")":s)).join("  →  ")
      : "1 agente builder";
  };
  wfSel.onchange = ()=>{ if(typeof ntTeamTouched!=='undefined') ntTeamTouched=true; updatePrev(); }; updatePrev(); // escolheu a equipe à mão: o tipo não troca
  // revisores: agentes do catálogo (papel reviewer primeiro) + padrão
  const ags = (state.config&&state.config.agents)||[];
  const revFirst = [...ags].sort((a,b)=>((b.role==='reviewer')?1:0)-((a.role==='reviewer')?1:0));
  $id("ntReviewer").innerHTML = `<option value="">Revisor padrão (Claude)</option>`+
    revFirst.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.role||'agente')}</option>`).join("");
  $id("ntFixTeam").innerHTML = `<option value="">Builder padrão (1 agente)</option>`+
    (wfs.length?`<optgroup label="Equipes">${wfs.map(w=>`<option value="wf:${esc(w.id)}">${esc(w.name)}</option>`).join("")}</optgroup>`:"")+
    (ags.length?`<optgroup label="Agentes">${ags.map(a=>`<option value="ag:${esc(a.id)}">${esc(a.name)} · ${esc(a.role||'agente')}</option>`).join("")}</optgroup>`:"");
  // designer: agentes com papel designer primeiro (ex.: Aria)
  const dzFirst=[...ags].sort((a,b)=>((b.role==='designer')?1:0)-((a.role==='designer')?1:0));
  const dzDefault=ags.find(a=>a.role==='designer');
  // investigador: reviewer/tester primeiro (perfil de caçar causa raiz)
  const invFirst=[...ags].sort((a,b)=>((b.role==='reviewer'||b.role==='tester')?1:0)-((a.role==='reviewer'||a.role==='tester')?1:0));
  $id("ntInvAgent").innerHTML =
    `<option value="" selected>Investigador padrão (Claude)</option>`+
    invFirst.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.role||'agente')}</option>`).join("");
  $id("ntDzAgent").innerHTML =
    dzFirst.map(a=>`<option value="${esc(a.id)}"${dzDefault&&a.id===dzDefault.id?' selected':''}>${esc(a.name)} · ${esc(a.role||'agente')}</option>`).join("")
    + `<option value=""${dzDefault?'':' selected'}>Designer padrão (Claude)</option>`;
  { const b=$id("ntFixReqAdd"); if(b) b.onclick=()=>{ ntFixReq.push(""); renderNtList("ntFixReqs", ntFixReq); }; }
}
let ntMode='build';
let ntDocsPreset=false; // tipo "Documentação" da tela de início = entrega em branch docs/…
let ntLinkedTo=null; // id da tarefa de origem quando esta é uma correção linkada
// design aprovado → cria a tarefa de ENTREGA linkada, com os artefatos do
// design (mockup/DESIGN.md) anexados como referência obrigatória.
async function openFromDesign(t){
  if(ntPaneDelegate('openFromDesign', t)) return;
  const isInv=(t.branch||'').startsWith('invest/');
  try{
    let arts=[]; try{ arts = await loadArtifacts(t.id, t.status) || []; }catch(_){ arts=[]; }
    if(!await ntOpenFormTab()) return; // aba própria (antes: modal sem aba)
    setNtMode('build');
    ntLinkedTo=t.id; renderNtLink();
    $id('ntTitle').value = t.title.replace(/^(design|por que|investigar)[:\s—-]*/i,'').trim() || t.title;
    $id('ntObj').value = isInv
      ? `Implementar a solução apontada pela investigação "${t.title}". O anexo INVESTIGATION.md (.cardume/refs/) é a REFERÊNCIA OBRIGATÓRIA: siga a CAUSA RAIZ e a RECOMENDAÇÃO documentadas; as evidências anexas mostram o comportamento atual. Divergiu da recomendação? Pergunte antes.`
      : `Implementar o design aprovado na tarefa "${t.title}". Os anexos em .cardume/refs/ (mockup.html e DESIGN.md) são a REFERÊNCIA OBRIGATÓRIA: siga fielmente as telas, os estados (vazio/carregando/erro) e as decisões documentadas. Divergiu do mockup? Pergunte antes.`;
    ntRefs = (arts||[]).filter(a=>/\.(html|md|png|jpe?g|webp|txt|log)$/i.test(a.name)).map(a=>state.repo+'/.cardume/artifacts/'+t.id+'/'+a.name);
    renderNtRefs();
    $id('ntArtProof').checked=true;
    $id('ntArtTests').checked=true;
    ntMarkBase();
    if(typeof renderTabs==='function') renderTabs(); // título da aba = a entrega
  }catch(e){ showErr(e, 'Não consegui montar a entrega'); console.error('openFromDesign:', e); }
}

// ---------- desdobrar tarefa em ÉPICO (a IA propõe as sub-tarefas) ----------
let bdTask=null, bdItems=null, bdRun=0; // bdRun: só a resposta da IA da ÚLTIMA abertura vale // bdItems: null = IA lendo · [] = sem proposta · 'plan' = card do épico (plPlan) na tela
// Desdobrar = o MESMO card do planner (envelope + tarefas com verify/after/risk), hospedado no overlay do desdobrar.
async function openBreakdown(t){
  if(!SB.sess() || !cloudTeamId()){ toast('Desdobrar em épico usa o backlog do TIME — entre na sua conta e escolha um time primeiro.','warn',{ label:'abrir Conta', fn:ERR_ACTIONS.conta }); return; }
  bdTask=t; bdItems=null; const run=++bdRun;
  $id('bdOverlay').style.display='flex';
  renderBd();
  // contexto: objetivo + docs da tarefa (INVESTIGATION/DESIGN/ARCHITECTURE)
  let ctx = 'TAREFA DE ORIGEM: '+t.title+'\nOBJETIVO: '+(t.objective||'')+'\n';
  try{
    const arts=await loadArtifacts(t.id, t.status)||[];
    for(const a of arts.filter(x=>/\.md$/i.test(x.name)).slice(0,3)){
      try{ const c=await invoke('read_artifact',{ taskId:t.id, name:a.name }); ctx+='\n=== '+a.name+' ===\n'+(c.text||'').slice(0,2500)+'\n'; }catch(_){ }
    }
  }catch(_){ }
  try{
    const raw=await invoke('ai_decompose',{ text: ctx, guide:(typeof ntPolicy!=='undefined'&&ntPolicy.specGuide)||null });
    let obj=null;
    try{ const m=raw.match(/\{[\s\S]*\}/); obj=JSON.parse(m?m[0]:raw); }catch(_){ obj=null; }
    if(!obj||!Array.isArray(obj.tasks)){ // formato antigo: array de tarefas com wave → plPlanFrom sintetiza o after
      let arr=[]; try{ const m2=raw.match(/\[[\s\S]*\]/); arr=JSON.parse(m2?m2[0]:'[]'); }catch(_){ arr=[]; }
      obj={ epic:'', tasks:Array.isArray(arr)?arr:[] };
    }
    if(bdTask!==t || run!==bdRun) return; // o usuário fechou/abriu outro (ou o mesmo de novo) enquanto a IA pensava
    if(!obj.epic) obj.epic=t.title.replace(/^(design|por que|investigar|corrigir)[:\s—-]*/i,'').trim()||t.title;
    const plan=plPlanFrom(obj);
    if(!plan.tasks.length){ bdItems=[]; renderBd(); return; }
    bdPlan=plan; plPlanRender=renderBd;
    plPlanCtx={ origin:t, description:('Desdobrado da tarefa "'+t.title+'". '+(t.objective||'')).trim().slice(0,600),
      onDone:()=>{ bdItems=null; bdTask=null; $id('bdOverlay').style.display='none'; },
      onDiscard:()=>bdClosePlan() };
    bdItems='plan';
  }catch(e){ bdItems=[]; console.error('ai_decompose:', e); }
  renderBd();
}
// fechar o desdobrar solta o card (senão o plano apareceria no planner, que compartilha plPlan)
function bdClosePlan(){
  bdPlan=null; if(plPlanCtx&&plPlanCtx.origin){ plPlanRender=null; plPlanCtx={}; }
  bdItems=null; bdTask=null; bdRun++;
  const o=$id('bdOverlay'); if(o) o.style.display='none';
}
function renderBd(){
  const el=$id('bdList'); if(!el) return;
  if(bdItems===null){ el.innerHTML='<div class="dim" style="padding:10px 2px">a IA está lendo a tarefa e os artefatos e propondo o épico…</div>'; return; }
  if(bdItems==='plan' && bdPlan){ el.innerHTML=plPlanCardHtml(true); plWirePlanCard(); return; }
  el.innerHTML='<div class="imhint" style="border-left:2px solid var(--warn)">não veio proposta — tente de novo ou crie as tarefas manualmente no backlog</div>';
}
async function openLinkedFix(t){
  if(ntPaneDelegate('openLinkedFix', t)) return;
  const fromInvest=(t.branch||'').startsWith('invest/');
  if(!await ntOpenFormTab()) return; // aba própria (antes: modal sem aba que fechava a aba de outro Formulário)
  setNtMode('fix');
  ntLinkedTo=t.id;
  $id('ntFixTitle').value='Corrigir: '+t.title.replace(/^por que\s*/i,'');
  $id('ntFixObj').value = fromInvest
    ? 'Correção a partir da investigação "'+t.title+'". O diagnóstico completo está no anexo INVESTIGATION.md (.cardume/refs/) — siga a CAUSA RAIZ e a RECOMENDAÇÃO de lá; aplique o menor diff que resolve.'
    : 'Correção da tarefa "'+t.title+'". Ela foi entregue, mas algo não está funcionando.\n\nO que está acontecendo: ';
  if(fromInvest){
    // anexa o diagnóstico (INVESTIGATION.md e evidências) como referência do fix
    try{ const arts=await loadArtifacts(t.id, t.status)||[]; ntFixRefs=arts.filter(a=>/\.(md|png|jpe?g|txt|log)$/i.test(a.name)).map(a=>state.repo+'/.cardume/artifacts/'+t.id+'/'+a.name); renderFixRefs(); }catch(_){ }
  }
  ntFixReq=[
    'O problema relatado não acontece mais (reproduzir o cenário original e validar)',
    'Prova real na UI/ambiente (print) + teste cobrindo a regressão',
  ];
  renderNtList('ntFixReqs', ntFixReq);
  ['ntFixArtProof','ntFixArtTests','ntFixArtDoc'].forEach(id=>{ const e=$id(id); if(e) e.checked=true; });
  renderNtLink(); ntMarkBase(); if(typeof renderTabs==='function') renderTabs(); // título da aba = a correção
  const o=$id('ntFixObj'); o.focus(); o.setSelectionRange(o.value.length,o.value.length); o.scrollTop=o.scrollHeight;
}
function renderNtLink(){
  const el=$id('ntLinkChip'); if(!el) return;
  const t=(state.tasks||[]).find(x=>x.id===ntLinkedTo);
  el.innerHTML = ntLinkedTo ? `<span class="linkchip">${IC.clip} linkada a: <b>${esc(t?t.title:ntLinkedTo)}</b><button class="fwselx" id="ntLinkX">${IC.x}</button></span>` : '';
  const x=$id('ntLinkX'); if(x) x.onclick=()=>{ ntLinkedTo=null; renderNtLink(); };
}
function setNtMode(m){
  ntMode=m;
  wizN=1; if(typeof wizRender==='function') setTimeout(wizRender,0); // wizard reinicia ao trocar o tipo
  $id("ntBuildFields").style.display = m==='build'?'':'none';
  $id("ntReviewFields").style.display = m==='review'?'':'none';
  $id("ntFixFields").style.display = m==='fix'?'':'none';
  $id("ntDesignFields").style.display = m==='design'?'':'none';
  $id("ntInvFields").style.display = m==='invest'?'':'none';
  $id("ntDraft").style.display = m==='build'?'':'none';
  { const ai=$id("ntAI"); if(ai){ ai.style.display=''; ai.disabled=false; ai.title='a IA pergunta só o essencial e monta a demanda — o tipo e o texto vão junto'; } } // R8: repaginada B — Conversar vale pra todo tipo (o chip "Tipo" do planner leva o tipo)
  $id("ntImport").style.display = m==='build'?'':'none';
  { const tn=$id('ntTypeName'); if(tn) tn.textContent=(ntDocsPreset&&m==='build')?'Documentação':((window.ND_NAME_OF_MODE||{})[m]||m); }
  $id("ntHint").textContent = m==='review'?'cole o link do PR (pedido de mudança) — a IA revisa e escreve um parecer, sem mexer no código':m==='fix'?'um agente só, direto na correção — você revisa antes de entrar no projeto':m==='design'?'mockup e decisões antes de programar — não mexe no produto':m==='invest'?'acha a causa com evidências — investiga, não corrige':'roda numa cópia isolada do projeto — nada muda no principal até você aprovar';
  const create=$id("ntCreate");
  const tn=[...create.childNodes].reverse().find(n=>n.nodeType===3&&n.textContent.trim());
  if(tn) tn.textContent = m==='review'?' revisar PR':m==='design'?' gerar design':m==='invest'?' investigar':' Iniciar execução';
  ntTypeTabsPaint();
  { const sm=$id('ntSum'); if(sm && !wizModeOn()) sm.textContent='página única · '+({ review:'busca o diff do PR e devolve um parecer', design:'não mexe no código — entrega mock e decisões', invest:'só investiga — entrega a causa' }[m]||'campo a campo, sem conversa'); }
  ntGate();
  if(typeof aiPickRender==='function') aiPickRender();
}
if(typeof VIEW_META!=='undefined' && VIEW_META.form) VIEW_META.form.title='Nova demanda'; // a aba do Formulário é a Nova demanda (2º modo)
// F4: os tipos viram ABAS (Documentação = Feature com entrega "Documento"); some o chip + "trocar"
function ntTypeTabsPaint(){ document.querySelectorAll('#ntTypeTabs [data-nttype]').forEach(b=>{ const t=b.dataset.nttype, on=t==='docs'?(ntDocsPreset&&ntMode==='build'):(t===ntMode && !(t==='build'&&ntDocsPreset)); b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex=on?0:-1; }); }
// Documentação = Feature com a entrega "Documento" (branch docs/), como na tela de tipos antiga
function ntPickType(t){ const docs=t==='docs'; if(docs===ntDocsPreset && (docs?ntMode==='build':t===ntMode)) return; ntDocsPreset=docs; setNtMode(docs?'build':t);
  { const bt=$id('ntBranchType'); if(bt) bt.value=docs?'docs':(bt.value==='docs'?'feat':bt.value); } if(typeof ntKindPaint==='function'){ if(docs) ntKind='documento'; else if(typeof ntKind!=='undefined' && ntKind==='documento') ntKind='codigo'; ntKindPaint(); } ntTypeTabsPaint(); }
document.querySelectorAll('#ntTypeTabs [data-nttype]').forEach(b=>b.onclick=()=>ntPickType(b.dataset.nttype));
{ const tt=$id('ntTypeTabs'); if(tt) tt.onkeydown=e=>{ if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight') return; e.preventDefault(); const bs=[...tt.querySelectorAll('[data-nttype]')], i=Math.max(0, bs.findIndex(x=>x.classList.contains('on'))), n=bs[(i+(e.key==='ArrowRight'?1:bs.length-1))%bs.length]; ntPickType(n.dataset.nttype); n.focus(); }; }
// ⋯ do cabeçalho: importar .md · recomeçar do zero (folha ancorada confirma)
bindClick('ntMore', ev=>{ const a=ev.currentTarget; if(typeof g2SheetMenu!=='function') return;
  g2SheetMenu(a, [ ntMode==='build'?{ label:'Importar .md', hint:'frontmatter + Objetivo / Entregáveis / Requisitos', fn:()=>importTaskMd() }:null,
    { label:'Recomeçar do zero', hint:'apaga o que está preenchido nesta aba', danger:true, fn:()=>g2SheetConfirm(a, { title:'Recomeçar do zero?', sub:'os campos desta aba são limpos', ok:'Recomeçar', danger:true, onOk:()=>{ const ed=(typeof ntEditingDraft!=='undefined')?ntEditingDraft:null; resetNewTask(); if(ed) ntEditingDraft=ed; wizN=1; wizRender(); ntGate(); } }) } ]); });
// coluna da direita: "Pedido até aqui" + "Padrões que valem aqui" (só leitura)
function ntSideRender(){
  const mb=document.querySelector('#ntOverlay .mbody'); if(!mb) return;
  let el=$id('ntSide'); if(!el){ el=document.createElement('aside'); el.id='ntSide'; el.className='nt-side'; mb.appendChild(el); mb.classList.add('nt-g2');
    const col=document.createElement('div'); col.id='wizStepsCol'; const wp=$id('wizProg'); if(wp) col.appendChild(wp); mb.insertBefore(col, mb.firstChild); }
  mb.classList.toggle('nt-steps-on', wizModeOn());
  const v=id=>{ const e=$id(id); return e?String(e.value||'').trim():''; };
  const F={ build:['ntTitle','ntObj'], fix:['ntFixTitle','ntFixObj'], design:['ntDzTitle','ntDzObj'], invest:['ntInvTitle','ntInvObj'], review:['ntPr','ntPr'] }[ntMode]||['ntTitle','ntObj'];
  const min=Math.max(1,+ntPolicy.minRequirements||1), nReq=(ntMode==='build'?ntReq:ntMode==='fix'?ntFixReq:[]).filter(x=>x&&x.trim()).length;
  const wait='<span class="wait">— aguardando definição —</span>', cut=(t,n)=>t.length>n?t.slice(0,n-1)+'…':t;
  const pick=document.querySelector('input[name="howflow"]:checked'), whoEl=pick&&pick.closest('label'), who=whoEl?((whoEl.querySelector('.ht')||{}).textContent||''):'';
  const html=`<div class="g2k">Pedido até aqui</div><div class="g2mdprev"><h4>${v(F[0])?esc(cut(v(F[0]),80)):wait}</h4>`+
    (ntMode==='review'?'':`<h5>${ntMode==='invest'?'Sintoma':'Objetivo'}</h5><span>${v(F[1])?esc(cut(v(F[1]),180)):wait}</span>`)+
    ((ntMode==='build'||ntMode==='fix')?`<h5>Requisitos</h5><span>${nReq} — a política pede ${min}${nReq>=min?' ✓':''}</span>`:'')+
    `<h5>Quem executa</h5><span class="${who?'':'wait'}">${who?esc(who):'recomendação do projeto'}</span></div>`+
    (typeof ndPadroesHtml==='function'?ndPadroesHtml(ntPolicy, 'ntStd', ND_STD_OPEN.ntStd!==false):'');
  if(el.__html!==html){ el.innerHTML=html; el.__html=html; }
}
// "trocar" o tipo: um popover aqui mesmo (repaginada B — não existe mais a tela de tipos; com nd:legacy volta pra ela)
{ const sw=$id('ntTypeSwap'); if(sw) sw.onclick=()=>{
  if((window.ndLegacy&&window.ndLegacy()) || !window.ndPopover){ if(window.openTab) window.openTab('nova'); return; }
  const cur=(ntDocsPreset&&ntMode==='build')?'docs':ntMode;
  ndPopover(sw, `<div class="ndpop-h">Tipo de demanda</div>${ND_TYPES.map(t=>`<button type="button" class="ndpop-opt${t.k===cur?' on':''}" data-ntswap="${t.k}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`).join('')}`,
    p=>p.querySelectorAll('[data-ntswap]').forEach(b=>b.onclick=()=>{ const k=b.dataset.ntswap; ntDocsPreset=(k==='docs'); setNtMode((window.ND_TO_MODE||{})[k]||'build'); { const bt=$id('ntBranchType'); if(bt && ntDocsPreset) bt.value='docs'; } ndPopClose(); }));
}; }
// o toggle Formulário|Markdown mora na linha do eyebrow (à direita); a barra "SPEC" solta some
{ const seg=document.querySelector('#ntRight .ntviewbar .seg2'), pr=document.querySelector('#wizHead .nf-progrow'), vb=document.querySelector('#ntRight .ntviewbar');
  if(seg&&pr){ seg.style.marginLeft='auto'; pr.appendChild(seg); } if(vb) vb.style.display='none'; }
// a aba ATIVA do Formulário foi fechada: o rascunho em edição e o link dela não valem pra próxima criação
function ntFormTabClosed(){ if(typeof ntEditingDraft!=='undefined') ntEditingDraft=null; ntLinkedTo=null; }
// fecha SÓ a aba do próprio formulário (tabId, ou a ativa se for Formulário) — nunca a aba de outro Formulário
function closeNewTask(tabId){
  if(typeof tabId!=='string') tabId=undefined; // handler ligado direto (onclick=closeNewTask) passa o evento
  const has=typeof tabById==='function', cur=has?tabById(activeTab):null;
  const t=has?(tabId?tabById(tabId):(cur&&cur.kind==='form'?cur:null)):null;
  if(t && t.kind==='form'){ closeTab(t.id); return; }
  if(tabId) return; // a aba dele já foi fechada: nada mais a fazer (não mexe na tela de outra aba)
  $id("ntOverlay").style.display="none"; ntFormTabClosed();
}
// dentro de um PAINEL do canvas (iframe sem barra de abas) o Formulário abre como aba da JANELA PRINCIPAL
function ntPaneDelegate(fn, t){
  if(typeof SF_PANE==='undefined' || !SF_PANE) return false;
  try{ const P=window.parent; if(!P || P===window || typeof P[fn]!=='function') return false;
    const pt=((P.state&&P.state.tasks)||[]).find(x=>x.id===(t&&t.id))||t; P[fn](pt); return true; }catch(_){ return false; }
}
// abre o Formulário SEMPRE como aba própria e LIMPA (correção linkada, entrega do design, botão Nova tarefa, chat).
// Devolve false se não abriu (sem projeto/git: o openTab já avisou) — quem chama não preenche nada.
async function ntOpenFormTab(){
  if(!window.openTab){ resetNewTask(); await openNewTask(); return true; }
  const before=activeTab; window.ntOpening=null; window.openTab('form');
  const t=(typeof tabById==='function')?tabById(activeTab):null;
  if(!(t && t.kind==='form' && t.id!==before)) return false; // recusou (a aba ativa é de OUTRO Formulário): não preenche nada
  try{ await window.ntOpening; }catch(_){ }
  if(activeTab!==t.id) return false; // trocou de aba enquanto abria: não preenche a aba errada
  return true;
}
// A4 (mesa-bugs-2): fechar (⌘W, X, Delete, botão do meio) uma aba de Nova demanda com trabalho que SE PERDE pergunta antes.
// Conversar: a aba dona do rascunho do projeto não pergunta (reabrir recupera); as outras perdem a conversa ao fechar.
// Formulário: não tem rascunho em disco — conta o que MUDOU desde que a aba foi montada (ntBaseSig): rascunho aberto pra
// editar, correção linkada ou entrega do design pré-preenchidas e fechadas sem mexer não perguntam.
// @puro-ndwork-inicio
const ND_FORM_TEXT=['ntTitle','ntObj','ntFixTitle','ntFixObj','ntDzTitle','ntDzObj','ntDzScreens','ntInvTitle','ntInvObj','ntPr'];
// assinatura do trabalho da aba (texto + listas); '' = nada preenchido
function ntWorkSig(st){
  if(!st) return '';
  const f=st.fields||{}, txt=ND_FORM_TEXT.map(id=>String((f[id]&&f[id].v)||'').trim());
  const lists=['ntDel','ntReq','ntFixReq'].map(k=>(st[k]||[]).map(x=>String(x||'').trim()).filter(Boolean).join('\u0001'));
  const refs=['ntRefs','ntFixRefs','ntDzRefs','ntInvRefs'].map(k=>(st[k]||[]).join('\u0001'));
  const all=txt.concat(lists, refs); return all.some(Boolean) ? all.join('\u0002') : '';
}
function ndTabLoses(kind, st){
  if(!st) return '';
  if(kind==='planner'){
    const talk=(st.plMsgs||[]).some(m=>m&&m.who==='you') || !!st.plPlan;
    return (talk && st.plOwnsDraft===false) ? 'a conversa desta aba' : '';
  }
  if(kind==='form'){
    const sig=ntWorkSig(st);
    return (sig && sig!==(st.ntBaseSig||'')) ? 'o que você preencheu no formulário' : ''; // igual ao que a aba abriu (rascunho/pré-preenchido) = nada a perder
  }
  return '';
}
// @puro-ndwork-fim
let ntBaseSig=''; // o que a aba tinha ao ser montada (rascunho/correção/entrega pré-preenchidos); vazio = formulário limpo
function ntMarkBase(){ try{ ntBaseSig=ntWorkSig(window.TAB_STATE_form.get()); }catch(_){ ntBaseSig=''; } }
// fechar PELO USUÁRIO (botão fechar/cancelar do formulário): a mesma guarda do X da aba. Depois de criar: closeNewTask direto.
function ntUserClose(){ const t=(typeof tabById==='function')?tabById(activeTab):null; if(t && t.kind==='form' && typeof tabCloseGuarded==='function') return tabCloseGuarded(t.id); closeNewTask(); }
window.ntUserClose=ntUserClose;
async function ndTabCloseOk(tab){
  if(!tab || (tab.kind!=='planner' && tab.kind!=='form')) return true;
  let st=tab.state; if(tab.id===activeTab){ const api=window['TAB_STATE_'+tab.kind]; try{ st=api&&api.get?api.get():st; }catch(_){ } }
  const what=ndTabLoses(tab.kind, st); if(!what) return true;
  return await askYes('Fechar e descartar '+what+'?\n\nNada disso fica salvo depois de fechar.', 'Fechar a aba');
}
window.ndTabCloseOk=ndTabCloseOk;
function ntShow(){ const w=wizN; setNtMode(ntMode); wizN=w; $id("ntOverlay").style.display="flex"; } // A5: voltar pra aba não reinicia o wizard (setNtMode zera a etapa)
window.ntShow=ntShow;
// estado por aba: todos os campos do formulário + listas em memória
window.TAB_STATE_form={
  get:()=>{ const fields={}; document.querySelectorAll('#ntOverlay input[id],#ntOverlay select[id],#ntOverlay textarea[id]').forEach(e=>{ fields[e.id]=(e.type==='checkbox'||e.type==='radio')?{c:e.checked}:{v:e.value}; });
    const ti=($id('ntTitle')||{}).value||($id('ntFixTitle')||{}).value||($id('ntDzTitle')||{}).value||($id('ntInvTitle')||{}).value||'';
    return { _title:ti, fields, ntMode, wizN, ntBaseSig, ntModels, ntDocsPreset, ntLinkedTo, ntDel:ntDel.slice(), ntReq:ntReq.slice(), ntRefs:ntRefs.slice(), ntFixReq:ntFixReq.slice(), ntDzRefs:ntDzRefs.slice(), ntFixRefs:ntFixRefs.slice(), ntInvRefs:ntInvRefs.slice(), ntEditingDraft:(typeof ntEditingDraft!=='undefined')?ntEditingDraft:null }; },
  set:(st)=>{ Object.entries(st.fields||{}).forEach(([id,f])=>{ const e=$id(id); if(!e) return; if('c' in f) e.checked=!!f.c; else e.value=f.v; });
    ntMode=st.ntMode||'build'; wizN=+st.wizN||1; ntBaseSig=st.ntBaseSig||''; ntModels=st.ntModels||''; ntDocsPreset=!!st.ntDocsPreset; ntLinkedTo=st.ntLinkedTo||null; ntDel=st.ntDel||[]; ntReq=st.ntReq||[]; ntRefs=st.ntRefs||[]; ntFixReq=st.ntFixReq||[]; ntDzRefs=st.ntDzRefs||[]; ntFixRefs=st.ntFixRefs||[]; ntInvRefs=st.ntInvRefs||[]; if(typeof ntEditingDraft!=='undefined') ntEditingDraft=st.ntEditingDraft||null;
    renderNtList("ntDeliverables",ntDel); renderNtList("ntRequirements",ntReq); renderNtList('ntFixReqs',ntFixReq); renderDzRefs(); renderFixRefs(); renderInvRefs(); renderNtRefs(); renderNtLink(); }
};
function resetNewTask(){ ntModels=''; ntBaseSig=''; closeHow(); ["ntTitle","ntObj","ntOwns","ntOff","ntPr","ntFixTitle","ntFixObj","ntFixOwns","ntBase","ntIssue","ntPrBase","ntDzTitle","ntDzObj","ntDzScreens","ntInvTitle","ntInvObj","ntModel"].forEach(id=>{const e=$id(id); if(e) e.value="";}); ['ntDzMock','ntDzDoc'].forEach(id=>{ const e=$id(id); if(e) e.checked=true; }); setNtMode('build'); aiApplyDefaults(); $id("ntArtDoc").checked=false; $id("ntArtProof").checked=false; $id("ntArtTests").checked=false; { const e=$id('ntLight'); if(e) e.checked=false; } $id("ntAutoPr").value="ask"; $id("ntPlan").value="auto"; $id("ntBranchType").value="feat"; $id("ntIssue").value=""; ntDel=[]; ntReq=[]; ntRefs=[]; ntFixReq=[]; ntDzRefs=[]; ntFixRefs=[]; ntInvRefs=[]; renderDzRefs(); renderFixRefs(); renderInvRefs(); renderNtList('ntFixReqs',ntFixReq); { const e=$id('ntInvRepro'); if(e) e.checked=true; } ['ntFixArtProof','ntFixArtTests','ntFixArtDoc'].forEach(id=>{ const e=$id(id); if(e) e.checked=true; }); { const e=$id('ntFixTeam'); if(e) e.value=''; } ntLinkedTo=null; if(typeof ntEditingDraft!=='undefined') ntEditingDraft=null; renderNtLink(); renderNtList("ntDeliverables",ntDel); renderNtList("ntRequirements",ntReq); renderNtRefs(); if(typeof ntKindReset==='function') ntKindReset(); }
// objetivo / detalhes / contexto / sintoma: colar (⌘V) um print ou arrastar um arquivo pro texto vira ANEXO da
// demanda (mesma lista do botão "anexar") — igual ao composer dos chats; texto colado continua texto
[['ntObj',()=>ntRefs,renderNtRefs],['ntFixObj',()=>ntFixRefs,renderFixRefs],['ntDzObj',()=>ntDzRefs,renderDzRefs],['ntInvObj',()=>ntInvRefs,renderInvRefs]].forEach(([id,arr,render])=>attWireRefField(id,arr,render));
