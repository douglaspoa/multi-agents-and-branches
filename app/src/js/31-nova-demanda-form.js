// Constellation — 31-nova-demanda-form
// ---- spec-first: campos obrigatórios por tipo + gate do Iniciar execução ----
const NT_REQUIRED={
  build:[['ntTitle','título'],['ntObj','objetivo']],
  fix:[['ntFixTitle','o que corrigir']],
  design:[['ntDzTitle','o que projetar'],['ntDzObj','contexto']],
  invest:[['ntInvTitle','o que investigar'],['ntInvObj','sintoma']],
  review:[['ntPr','link/nº do PR']],
};
let ntPolicy={ minRequirements:1, proofRequired:true, testsRequired:true, docRequired:false, costWarn:25 };
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
    ms.textContent=missing.length?`${missing.length} campo${missing.length>1?'s':''} obrigatório${missing.length>1?'s':''} faltando: ${missing.map(([,l])=>l).join(', ')}`:'spec pronta ✓';
  }
  if($id('ntRight').classList.contains('mdview')) ntMdRender();
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
// ---- completar a spec com IA (uma tacada, sem conversa) ----
async function ntAiComplete(){
  const b=$id('ntAiFill');
  // campos do modo atual (build e fix são os que têm requisitos)
  const F = ntMode==='fix' ? { t:'ntFixTitle', o:'ntFixObj' }
    : ntMode==='design' ? { t:'ntDzTitle', o:'ntDzObj' }
    : ntMode==='invest' ? { t:'ntInvTitle', o:'ntInvObj' }
    : { t:'ntTitle', o:'ntObj' };
  const tEl=$id(F.t), oEl=$id(F.o);
  const title=(tEl&&tEl.value.trim())||'', objective=(oEl&&oEl.value.trim())||'';
  if(!title && !objective){
    if(oEl){ oEl.placeholder='escreva do seu jeito o que precisa — depois toque em "completar com IA"'; oEl.focus(); }
    return;
  }
  const orig=b?b.innerHTML:''; if(b){ b.disabled=true; b.textContent='completando…'; }
  try{
    const r=await invoke('ai_spec',{ title, objective, kind:ntMode, guide:(ntPolicy&&ntPolicy.specGuide)||null });
    // preenche SÓ o que está vazio — o que você escreveu é seu
    if(tEl && !tEl.value.trim() && r.title) tEl.value=r.title;
    if(oEl && !oEl.value.trim() && r.objective) oEl.value=r.objective;
    if(ntMode==='build'){
      if(!ntDel.filter(Boolean).length && (r.deliverables||[]).length){ ntDel=r.deliverables.slice(); renderNtList('ntDeliverables',ntDel); }
      if(!ntReq.filter(Boolean).length && (r.requirements||[]).length){ ntReq=r.requirements.slice(); renderNtList('ntRequirements',ntReq); }
    } else if(ntMode==='fix'){
      if(!ntFixReq.filter(Boolean).length && (r.requirements||[]).length){ ntFixReq=r.requirements.slice(); renderNtList('ntFixReqs',ntFixReq); }
    }
    ntGate();
    // no wizard: os requisitos preenchidos moram na etapa 2 — avança pra você VER o resultado
    if(wizModeOn() && wizN===1){
      wizN=2; wizRender();
      const m=$id('wizMiss');
      if(m){ m.textContent='✦ preenchido pela IA — revise e ajuste'; m.style.color='var(--accent)'; setTimeout(()=>{ if(m){ m.textContent=''; m.style.color='var(--warn)'; } },3500); }
    }
  }catch(e){ alert('Não consegui completar:\n'+e); }
  finally{ if(b){ b.disabled=false; b.innerHTML=orig; } }
}
bindClick('ntAiFill', ntAiComplete);
// ---- WIZARD por etapas (Entrega/Fix): uma pergunta por vez, sem scroll ----
// cada campo aparece UMA vez: spec → requisitos → quem executa → avançado → confira
const WIZ_STEPS={
  build:[
    { n:1, show:[1,3], t:'O que você precisa?', h:'título + objetivo com contexto e anexos — ou "montar conversando" lá em cima, e a IA monta tudo com você', guide:true,
      ok:()=>!!($id('ntTitle').value.trim() && $id('ntObj').value.trim()), miss:'preencha título e objetivo' },
    { n:2, show:[2], t:'Requisitos de entrega', h:()=>`critérios VERIFICÁVEIS — o agente é cobrado a provar cada um; mínimo ${Math.max(1,+ntPolicy.minRequirements||1)} pela política do repo`, guide:true,
      ok:()=>ntReq.filter(x=>x&&x.trim()).length>=Math.max(1,+ntPolicy.minRequirements||1), miss:'adicione os requisitos mínimos' },
    { n:3, how:true, opt:true, t:'Quem executa?', h:'o fluxo recomendado já vem marcado — modelo e limites no "Avançado" logo abaixo', ok:()=>true },
    { n:4, show:[4], share:true, opt:true, t:'Ajustes avançados', h:'escopo, branch, PR, time & épico — os padrões servem; pode pular', ok:()=>true },
    { n:5, rev:true, t:'Confira a spec', h:'é exatamente isto que o agente recebe — provas e testes já vêm exigidos pela política', ok:()=>true },
  ],
  fix:[
    { n:1, show:[1,3], t:'O que corrigir?', h:'onde acontece, sintoma, como reproduzir — o print do bug vale mais que mil palavras', guide:true,
      ok:()=>!!$id('ntFixTitle').value.trim(), miss:'diga o que corrigir' },
    { n:2, show:[2], t:'Critérios de aceite', h:()=>`como saberemos que está corrigido — mínimo ${Math.max(1,+ntPolicy.minRequirements||1)} pela política do repo`, guide:true,
      ok:()=>ntFixReq.filter(x=>x&&x.trim()).length>=Math.max(1,+ntPolicy.minRequirements||1), miss:'adicione os critérios mínimos' },
    { n:3, how:true, opt:true, t:'Quem corrige?', h:'o builder padrão resolve a maioria — modelo e limites no "Avançado" logo abaixo', ok:()=>true },
    { n:4, show:[4], share:true, opt:true, t:'Ajustes avançados', h:'comprovações, time & épico — pode pular', ok:()=>true },
    { n:5, rev:true, t:'Confira a spec', h:'é exatamente isto que o agente recebe', ok:()=>true },
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
    const mo=$id('ntMode'); if(mo) mo.style.display='none';
    ['ntTeamRow','ntFixTeamRow'].forEach(id=>{ const e=$id(id); if(e) e.style.display=''; });
    { const hp=$id('ntHowPane'), hf=$id('howFootRow'); if(hp) hp.style.display='none'; if(hf) hf.style.display='flex'; }
    wizShareApply(null);
    if(md&&!$id('ntRight').classList.contains('mdview')) md.style.display='none'; return; }
  const cont=ntMode==='build'?contB:contF;
  const steps=WIZ_STEPS[ntMode];
  const st=steps.find(s=>s.n===wizN)||steps[0];
  head.style.display='block'; foot.style.display='flex'; if(footL) footL.style.display='flex';
  cont.querySelectorAll('.wstep').forEach(e=>{ e.style.display=(st.show||[]).includes(+e.dataset.w)?'':'none'; });
  { const mo=$id('ntMode'); if(mo) mo.style.display='none'; } // o TIPO vem da tela de início (chip no cabeçalho, "trocar" volta lá)
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
  $id('wizProg').innerHTML=steps.map(s=>`<span class="${s.n<wizN?'done':s.n===wizN?'cur':''}"></span>`).join('');
  $id('wizStep').textContent=`etapa ${st.n} de ${steps.length}${st.opt?' · opcional':''}`;
  $id('wizT').textContent=st.t;
  $id('wizH').textContent=typeof st.h==='function'?st.h():st.h;
  // guia do repo (o MESMO texto que a IA segue) nas etapas de conteúdo
  { const g=$id('wizGuide');
    if(g){ const has=st.guide && ntPolicy.specGuide;
      g.style.display=has?'block':'none';
      if(has) $id('wizGuideTx').innerHTML=mdToHtml(String(ntPolicy.specGuide)); } }
  const last=wizN===steps[steps.length-1].n;
  if(footL) footL.innerHTML=(wizN>1?`<button class="btn nf-ghost" id="wizBack">← voltar</button>`:'');
  foot.innerHTML=
    `<span class="dim" id="wizMiss" style="font-size:11.5px;color:var(--warn)"></span>`+
    (st.opt?`<button class="btn nf-ghost" id="wizSkip">pular</button>`:'')+
    `<button class="btn primary" id="wizNext">${last?'Iniciar execução':'próximo →'}</button>`;
  bindClick('wizBack', ()=>{ wizN=steps[Math.max(0,steps.findIndex(s=>s.n===wizN)-1)].n; wizRender(); });
  bindClick('wizSkip', ()=>{ wizN=steps[steps.findIndex(s=>s.n===wizN)+1].n; wizRender(); });
  { const b=$id('wizNext'); if(b) b.onclick=()=>{
      if(last){ wizLaunch(); return; }
      if(!st.ok()){ const m=$id('wizMiss'); if(m){ m.textContent='⚠ '+(st.miss||'complete esta etapa'); setTimeout(()=>{ if(m) m.textContent=''; },2600); } return; }
      wizN=steps[steps.findIndex(s=>s.n===wizN)+1].n; wizRender();
    }; }
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
const GO_STEPS=[['spec','spec montada'],['req','requisitos verificáveis'],['issue','criando a issue e a branch'],['agent','despachando o agente']];
let goState={};
function goRender(nReq){
  const el=$id('goSteps'); if(!el) return;
  el.innerHTML=GO_STEPS.map(([k,l])=>{
    const s=goState[k]||'wait';
    const ic=s==='ok'?'✓':s==='run'?'◌':s==='err'?'✕':'·';
    const col=s==='ok'?'var(--accent)':s==='err'?'var(--warn)':s==='run'?'var(--text)':'var(--muted)';
    return `<div style="display:flex;gap:9px;align-items:center;font-size:12.5px;color:${col}"><span class="mono" style="width:14px">${ic}</span>${k==='req'?`${l} (${nReq})`:l}${s==='run'?'…':''}</div>`;
  }).join('');
}
function goShow(nReq){ goState={spec:'ok',req:'ok',issue:'run',agent:'wait'}; goRender(nReq); $id('goOverlay').style.display='flex'; cosmosStart($id('goOverlay')); }
function goHide(){ $id('goOverlay').style.display='none'; }
// última etapa do wizard: aplica as escolhas do "Quem executa?" e cria mostrando progresso
async function wizLaunch(){
  ntGate();
  const pick=document.querySelector('input[name="howflow"]:checked');
  const src=$id(ntMode==='fix'?'ntFixTeam':'ntWorkflow');
  if(pick&&src) src.value=pick.value;
  { const hm=$id('howModel'), nm=$id('ntModel'); if(hm&&nm&&hm.value) nm.value=hm.value; }
  ntModels=[...document.querySelectorAll('[data-agmodel]')].filter(s=>s.value).map(s=>`${s.dataset.agmodel}=${s.value}`).join(',');
  { const hc=$id('howCost'); if(hc&&hc.value) lsSet('costWarn', String(Math.max(0, parseFloat(hc.value)||0))); }
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
    return team.length?`<span class="howchain">${team.map(a=>`<span class="fwav" style="background:${agentColor(a.name)};width:17px;height:17px;font-size:8px" title="${escA(a.name)}">${esc((a.name||'?').slice(0,1).toUpperCase())}</span>`).join('<span style="color:var(--muted);font-size:9px">→</span>')}</span>`:'';
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
    (team2.length?`<div style="display:flex;align-items:center;gap:8px;margin:12px 0 6px"><span class="mono" style="font-size:10px;letter-spacing:.08em;color:var(--muted)">FLUXOS DO TIME</span><span style="flex:1"></span><button class="btn sm" id="howManage" style="padding:2px 8px;font-size:10.5px">gerenciar</button></div>`+team2.map(optHtml).join(''):'');
  bindClick('howManage', ()=>{ closeHow(); openAgents(); });
  box.querySelectorAll('.howopt').forEach(l=>l.onclick=()=>{ box.querySelectorAll('.howopt').forEach(x=>x.classList.remove('on')); l.classList.add('on'); l.querySelector('input').checked=true; howAgentsRender(); });
  $id('howModel').value=($id('ntModel')||{}).value||'';
  howAgentsRender();
  $id('howCost').value=parseFloat(lsGet('costWarn')||'25');
  $id('howSlots').value=slotMax;
}
function closeHow(){ $id('ntRight').classList.remove('howview'); $id('ntOverlay').classList.remove('howmode'); }
$id('howClose').onclick=closeHow;
$id('howCancel').onclick=closeHow;
$id('howOverlay').addEventListener('click',e=>{ if(e.target.id==='howOverlay') closeHow(); });
// modelo POR AGENTE do fluxo escolhido (redesign p10) — vira --models no CLI
let ntModels='';
function howAgentsRender(){
  const el=$id('howAgents'); if(!el) return;
  const pick=document.querySelector('input[name="howflow"]:checked');
  const wid=pick?pick.value:'';
  const wfs=(state.config&&state.config.workflows)||[];
  const byId=Object.fromEntries(((state.config&&state.config.agents)||[]).map(a=>[a.id,a]));
  const w=wfs.find(x=>x.id===wid);
  const team=w?(w.steps||[]).map(s=>byId[s]).filter(Boolean):[];
  if(team.length<2){ el.innerHTML=''; return; }
  el.innerHTML=`<label>Modelo por agente <span class="dim" style="text-transform:none;letter-spacing:0">(sobrepõe o modelo geral)</span></label>`+
    team.map(a=>`<div style="display:flex;align-items:center;gap:9px;margin-top:7px"><span class="fwav" style="background:${agentColor(a.name)}">${esc((a.name||'?').slice(0,2).toUpperCase())}</span><span style="flex:1;font-size:12.5px">${esc(a.name)} <span class="dim">· ${esc(a.role)}</span></span><select class="sel" data-agmodel="${escA(a.name)}" style="width:165px"><option value="">modelo geral</option><option value="opus">Claude Opus</option><option value="sonnet">Claude Sonnet</option><option value="haiku">Claude Haiku</option></select></div>`).join('');
}
$id('howGo').onclick=()=>{
  const pick=document.querySelector('input[name="howflow"]:checked');
  const src=$id(ntMode==='fix'?'ntFixTeam':'ntWorkflow');
  if(pick && src) src.value=pick.value;
  const nm=$id('ntModel'); if(nm) nm.value=$id('howModel').value;
  ntModels=[...document.querySelectorAll('[data-agmodel]')].filter(s=>s.value).map(s=>`${s.dataset.agmodel}=${s.value}`).join(',');
  lsSet('costWarn', String(Math.max(0, parseFloat($id('howCost').value)||0)));
  setSlotMax(parseInt($id('howSlots').value,10)||slotMax);
  closeHow();
  submitNewTask(true);
};

// ---- cadeia de política/guia: padrão do PRODUTO < organização < repo ----
const ORG_DEFAULT_POLICY={ minRequirements:1, proofRequired:true, testsRequired:true, docRequired:false, costWarn:25 };
const DEFAULT_SPEC_TEMPLATE=`# Guia de demanda — template padrão do Constellation

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
  renderNtList("ntDeliverables", ntDel); renderNtList("ntRequirements", ntReq); renderNtList("ntFixReqs", ntFixReq); renderDzRefs(); renderFixRefs();
  ntFillProjects();
  $id("ntOverlay").style.display = "flex";
  // o assistente lateral MORREU (bugado demais) — quem completa a spec agora é
  // o botão "✨ completar com IA", em cima do que você já digitou
  { const a=$id('aiAssist'); if(a) a.style.display='none'; }
  // POLÍTICA do repo: provas/testes obrigatórios ficam LIGADOS e travados — a
  // entrega tem que sair completa, sem depender da disciplina de cada dev
  try{ ntPolicy={ ...ntPolicy, ...(await policyChain()) }; }catch(_){ }
  const lock=(id,on)=>{ const e=$id(id); if(!e) return; if(on){ e.checked=true; e.disabled=true; e.closest('label')?.setAttribute('title','obrigatório pela política do repo (.cardume/policy.json)'); } else { e.disabled=false; } };
  lock('ntArtProof', !!ntPolicy.proofRequired); lock('ntArtTests', !!ntPolicy.testsRequired); lock('ntArtDoc', !!ntPolicy.docRequired);
  lock('ntFixArtProof', !!ntPolicy.proofRequired); lock('ntFixArtTests', !!ntPolicy.testsRequired);
  wizN=1; wizRender();
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
  wfSel.onchange = updatePrev; updatePrev();
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
  const isInv=(t.branch||'').startsWith('invest/');
  try{
    let arts=[]; try{ arts = await loadArtifacts(t.id, t.status) || []; }catch(_){ arts=[]; }
    await openNewTask();
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
  }catch(e){ alert('Não consegui montar a entrega:\n'+(e&&e.message||e)); console.error('openFromDesign:', e); }
}

// ---------- desdobrar tarefa em ÉPICO (a IA propõe as sub-tarefas) ----------
let bdTask=null, bdItems=null;
async function openBreakdown(t){
  if(!SB.sess() || !cloudTeamId()){ alert('Desdobrar em épico usa o backlog do TIME — entre na sua conta e escolha um time primeiro (botão no topo).'); return; }
  bdTask=t; bdItems=null;
  $id('bdOverlay').style.display='flex';
  $id('bdName').value=t.title.replace(/^(design|por que|investigar|corrigir)[:\s—-]*/i,'').trim()||t.title;
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
    const m=raw.match(/\[[\s\S]*\]/);
    const arr=JSON.parse(m?m[0]:raw);
    bdItems=(Array.isArray(arr)?arr:[]).filter(x=>x&&x.title).map(x=>({
      title:String(x.title).slice(0,90),
      objective:String(x.objective||''),
      requirements:(Array.isArray(x.requirements)?x.requirements:[]).map(r=>String(r).trim()).filter(r=>r.length>=10).slice(0,5),
      owns:String(x.owns||'').trim(),
      wave:Math.max(1, parseInt(x.wave,10)||1),
      on:true,
    })).sort((a,b)=>a.wave-b.wave);
  }catch(e){ bdItems=[]; console.error('ai_decompose:', e); }
  renderBd();
}
function renderBd(){
  const el=$id('bdList'); if(!el) return;
  if(bdItems===null){ el.innerHTML='<div class="dim" style="padding:10px 2px">a IA está lendo a tarefa e os artefatos e propondo as sub-tarefas…</div>'; return; }
  if(!bdItems.length){ el.innerHTML='<div class="imhint" style="border-left:2px solid var(--warn)">não veio proposta — tente de novo ou crie as tarefas manualmente no backlog</div>'; return; }
  let html='', lastWave=0;
  bdItems.forEach((x,i)=>{
    if(x.wave!==lastWave){
      lastWave=x.wave;
      const n=bdItems.filter(y=>y.wave===x.wave).length;
      html+=`<div class="mono" style="font-size:10px;letter-spacing:.08em;color:${x.wave===1?'var(--accent)':'var(--muted)'};margin:${x.wave===1?'4px':'14px'} 0 2px">ONDA ${x.wave} ${x.wave===1?`· ${n>1?n+' agentes rodam EM PARALELO':'começa agora'}`:'· depois da onda '+(x.wave-1)}</div>`;
    }
    html+=`<label class="ckrow" style="align-items:flex-start"><input type="checkbox" data-bd="${i}" ${x.on?'checked':''}><span style="flex:1;min-width:0">
      <b style="font-size:13px">${esc(x.title)}</b>
      <div class="dim" style="font-size:12px;margin-top:2px">${esc(x.objective)}</div>
      ${x.requirements.length?`<div class="dim" style="font-size:11px;margin-top:4px">${x.requirements.map(r=>'☐ '+esc(r)).join('<br>')}</div>`:''}
      ${x.owns?`<div class="mono" style="font-size:10px;margin-top:4px;color:var(--accent)" title="escopo reivindicado — disjunto dos demais da onda">⛶ ${esc(x.owns)}</div>`:''}
    </span></label>`;
  });
  el.innerHTML=html;
  el.querySelectorAll('[data-bd]').forEach(c=>{ c.onchange=()=>{ bdItems[+c.dataset.bd].on=c.checked; renderBd(); }; });
  const n=bdItems.filter(x=>x.on).length;
  const btn=$id('bdCreate'); if(btn) btn.textContent=`criar épico + ${n} tarefa${n===1?'':'s'}`;
}
async function bdCreate(){
  const name=$id('bdName').value.trim(); if(!name) return;
  const picked=(bdItems||[]).filter(x=>x.on);
  if(!picked.length){ alert('Marque pelo menos uma sub-tarefa.'); return; }
  const btn=$id('bdCreate'); btn.disabled=true; btn.textContent='criando…';
  try{
    const proj=await cloudEnsureProject();
    const ep=await sbPost('epics',{ team_id:cloudTeamId(), name, created_by:cloudUserId() });
    const created=[];
    for(const x of picked){
      const rows=await sbPost('tasks',{ local_id:'card-'+Math.random().toString(36).slice(2,10), project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), claim_mode:'open', title:x.title, status:'backlog', epic_id:ep[0].id,
        spec:{ title:x.title,
          objective:x.objective+`\n\n(Onda ${x.wave} do épico "${name}" — origem: tarefa "${bdTask.title}"; os artefatos dela têm o contexto completo. NÃO toque em arquivos fora do seu escopo: outras tarefas do épico rodam em paralelo.)`,
          requirements:x.requirements||[], owns:x.owns||null,
          proof:!!(typeof ntPolicy!=='undefined'&&ntPolicy.proofRequired), tests:!!(typeof ntPolicy!=='undefined'&&ntPolicy.testsRequired),
          wave:x.wave } });
      if(rows&&rows[0]) created.push({ row:rows[0], wave:x.wave });
    }
    $id('bdOverlay').style.display='none';
    teamTasks=null; teamPaintSig=''; lsSet('tmEpic', ep[0].id); setView('team');
    // onda 1 pode começar JÁ — os escopos são disjuntos, os agentes rodam juntos
    const w1=created.filter(c=>c.wave===1);
    if(w1.length && confirm(`Iniciar AGORA as ${w1.length} tarefa${w1.length===1?'':'s'} da onda 1 nesta máquina?\n(escopos disjuntos — rodam em paralelo; as demais ondas ficam no backlog)`)){
      for(const c of w1){ try{ await teamClaimStart(c.row, null); }catch(e){ console.error('onda1:', e); } }
    }
  }catch(e){ alert('Falha ao criar o épico:\n'+(e.message||e)); btn.disabled=false; renderBd(); }
}
async function openLinkedFix(t){
  const fromInvest=(t.branch||'').startsWith('invest/');
  await openNewTask();
  setNtMode('fix');
  ntLinkedTo=t.id;
  $id('ntFixTitle').value='Corrigir: '+t.title.replace(/^por que\s*/i,'');
  $id('ntFixObj').value = fromInvest
    ? 'Correção a partir da INVESTIGAÇÃO "'+t.title+'" (id '+t.id+'). O diagnóstico completo está no anexo INVESTIGATION.md (.cardume/refs/) — siga a CAUSA RAIZ e a RECOMENDAÇÃO de lá; aplique o menor diff que resolve.'
    : 'Correção LINKADA à tarefa "'+t.title+'" (id '+t.id+', branch '+t.branch+'). Ela foi entregue mas algo não está funcionando em produção.\n\nO que está acontecendo: ';
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
  renderNtLink();
  const o=$id('ntFixObj'); o.focus(); o.setSelectionRange(o.value.length,o.value.length); o.scrollTop=o.scrollHeight;
}
function renderNtLink(){
  const el=$id('ntLinkChip'); if(!el) return;
  const t=(state.tasks||[]).find(x=>x.id===ntLinkedTo);
  el.innerHTML = ntLinkedTo ? `<span class="linkchip">${IC.clip} linkada a: <b>${esc(t?t.title:ntLinkedTo)}</b><button class="fwselx" id="ntLinkX">✕</button></span>` : '';
  const x=$id('ntLinkX'); if(x) x.onclick=()=>{ ntLinkedTo=null; renderNtLink(); };
}
function setNtMode(m){
  ntMode=m;
  wizN=1; if(typeof wizRender==='function') setTimeout(wizRender,0); // wizard reinicia ao trocar o tipo
  document.querySelectorAll("#ntMode .ntmodebtn").forEach(b=>b.classList.toggle('on', b.dataset.mode===m));
  $id("ntBuildFields").style.display = m==='build'?'':'none';
  $id("ntReviewFields").style.display = m==='review'?'':'none';
  $id("ntFixFields").style.display = m==='fix'?'':'none';
  $id("ntDesignFields").style.display = m==='design'?'':'none';
  $id("ntInvFields").style.display = m==='invest'?'':'none';
  $id("ntDraft").style.display = m==='build'?'':'none';
  $id("ntAI").style.display = m==='build'?'':'none'; // planner conversacional: monta a issue conversando (Entrega)
  $id("ntImport").style.display = m==='build'?'':'none';
  { const tn=$id('ntTypeName'); if(tn) tn.textContent=(ntDocsPreset&&m==='build')?'Documentação':((window.ND_NAME_OF_MODE||{})[m]||m); }
  $id("ntHint").textContent = m==='review'?'revisa um PR por link — sem criar branch':m==='fix'?'um builder só, sem plano nem docs — branch fix/…':m==='design'?'mockup + decisões ANTES da issue — não mexe no código do produto':m==='invest'?'causa raiz com evidências — investiga, NÃO corrige':'cada tarefa vira uma branch + worktree isolada';
  const create=$id("ntCreate");
  const tn=[...create.childNodes].reverse().find(n=>n.nodeType===3&&n.textContent.trim());
  if(tn) tn.textContent = m==='review'?' revisar PR':m==='design'?' gerar design':m==='invest'?' investigar':' Iniciar execução';
  ntGate();
  if(typeof aiPickRender==='function') aiPickRender();
}
{ const sw=$id('ntTypeSwap'); if(sw) sw.onclick=()=>{ if(window.openTab) window.openTab('nova'); }; }
// o toggle Formulário|Markdown mora na linha do eyebrow (à direita); a barra "SPEC" solta some
{ const seg=document.querySelector('#ntRight .ntviewbar .seg2'), pr=document.querySelector('#wizHead .nf-progrow'), vb=document.querySelector('#ntRight .ntviewbar');
  if(seg&&pr){ seg.style.marginLeft='auto'; pr.appendChild(seg); } if(vb) vb.style.display='none'; }
function closeNewTask(){ $id("ntOverlay").style.display="none"; if(typeof ntEditingDraft!=='undefined') ntEditingDraft=null; if(typeof closeTab==='function' && tabById('form')) closeTab('form'); }
function resetNewTask(){ ntModels=''; closeHow(); ["ntTitle","ntObj","ntOwns","ntOff","ntPr","ntFixTitle","ntFixObj","ntFixOwns","ntBase","ntIssue","ntPrBase","ntDzTitle","ntDzObj","ntDzScreens","ntInvTitle","ntInvObj","ntModel"].forEach(id=>{const e=$id(id); if(e) e.value="";}); ['ntDzMock','ntDzDoc'].forEach(id=>{ const e=$id(id); if(e) e.checked=true; }); setNtMode('build'); aiApplyDefaults(); $id("ntArtDoc").checked=false; $id("ntArtProof").checked=false; $id("ntArtTests").checked=false; $id("ntAutoPr").value="ask"; $id("ntPlan").value="auto"; $id("ntBranchType").value="feat"; $id("ntIssue").value=""; ntDel=[]; ntReq=[]; ntRefs=[]; ntFixReq=[]; ntDzRefs=[]; ntFixRefs=[]; ntInvRefs=[]; renderDzRefs(); renderFixRefs(); renderInvRefs(); renderNtList('ntFixReqs',ntFixReq); { const e=$id('ntInvRepro'); if(e) e.checked=true; } ['ntFixArtProof','ntFixArtTests','ntFixArtDoc'].forEach(id=>{ const e=$id(id); if(e) e.checked=true; }); { const e=$id('ntFixTeam'); if(e) e.value=''; } ntLinkedTo=null; renderNtLink(); renderNtList("ntDeliverables",ntDel); renderNtList("ntRequirements",ntReq); renderNtRefs(); aiSid=""; $id("aiChat").innerHTML=""; $id("aiAssist").style.display="none"; }
// ---------- assistente IA de spec ----------
let aiSid="", aiBusy=false;
function aiAppend(role, text){
  const c=$id('aiChat'); const div=document.createElement('div');
  div.className='aimsg '+role; div.innerHTML = role==='assistant'?mdToHtml(text):esc(text);
  c.appendChild(div); c.scrollTop=c.scrollHeight; return div;
}
function extractSpec(text){
  const m=text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  let raw = m?m[1]:null;
  if(!raw){ const j=text.match(/\{[\s\S]*"objective"[\s\S]*\}/); raw=j?j[0]:null; }
  if(!raw) return null;
  try{ const o=JSON.parse(raw); return (o && (o.title||o.objective))?o:null; }catch(e){ return null; }
}
async function sendAiMsg(){
  if(aiBusy) return;
  const inp=$id('aiInput'); const text=inp.value.trim(); if(!text) return;
  aiAppend('user', text); inp.value=''; aiBusy=true;
  const send=$id('aiSend'); send.disabled=true;
  const thinking=aiAppend('assistant','…'); thinking.classList.add('think');
  try{
    const r=await invoke('ai_chat',{ prompt:text, sessionId:aiSid });
    aiSid=r.sessionId||aiSid; thinking.remove();
    const spec=extractSpec(r.text||'');
    if(spec){
      aiAppend('assistant','Montei a spec com base no que você me contou:');
      const div=aiAppend('assistant','');
      div.innerHTML=`<div class="aispec"><b>${esc(spec.title||'(sem título)')}</b><div class="dim" style="margin:3px 0 8px">${esc(spec.objective||'')}</div>${(spec.deliverables||[]).length?`<div class="dim" style="font-size:11px">Entregáveis: ${esc((spec.deliverables||[]).join(' · '))}</div>`:''}<button class="btn primary sm" id="aiFill" style="margin-top:9px">preencher formulário</button></div>`;
      $id('aiFill').onclick=()=>fillFromSpec(spec);
    } else {
      aiAppend('assistant', r.text||'(sem resposta)');
    }
  }catch(e){ thinking.remove(); aiAppend('assistant','⚠ '+String(e)); }
  finally{ aiBusy=false; send.disabled=false; const i=$id('aiInput'); if(i) i.focus(); }
}
function fillFromSpec(spec){
  $id('ntTitle').value=spec.title||'';
  $id('ntObj').value=spec.objective||'';
  // entregáveis eram redundantes com requisitos — tudo vira REQUISITO (cobrado com prova)
  ntDel=[];
  const reqSet=new Set([...(spec.requirements||[]), ...(spec.deliverables||[])].map(x=>String(x).trim()).filter(Boolean));
  ntReq=[...reqSet];
  renderNtList('ntRequirements',ntReq);
  $id('ntOwns').value=(spec.owns||[]).join(', ');
  $id('ntOff').value=(spec.off||[]).join(', ');
  $id('aiAssist').style.display='none';
  $id('ntTitle').focus();
}
