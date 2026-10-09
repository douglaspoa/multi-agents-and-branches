// Starfork — 60-ciclo
// O CICLO DA TAREFA (decisão da mesa de 03/10/2026): teto sempre ligado (P6) e a decisão "precisa de você" como
// SEÇÃO da aba da tarefa (nunca modal). Espelho das funções puras de src/lifecycle.ts — a paridade é conferida pelos
// fixtures de tests/fixtures/ciclo-golden/ (app/tests/ciclo.test.mjs e src/ciclo-*.test.ts).

// @ciclo-puro-inicio
const CAP_PAUSE_AT=0.8, CAP_DEFAULT_USD=5, RELEASE_MIN_WORDS=3;
function effectiveCap(taskCap, settingsCap){ const ok=v=>{ const n=Number(v); return Number.isFinite(n)&&n>0?n:0; }; return ok(taskCap)||ok(settingsCap)||CAP_DEFAULT_USD; }
function capCheck(spentUsd, capUsd){ const cap=effectiveCap(capUsd); return (Number(spentUsd)||0) >= cap*CAP_PAUSE_AT-1e-9 ? 'pausa' : 'ok'; }
function releaseCheck(usd, reason){
  const n=typeof usd==='number'?usd:Number(String(usd==null?'':usd).trim().replace(/^US\$\s*/i,'').replace(',','.'));
  if(!Number.isFinite(n) || n<=0) return { ok:false, why:'escreva quanto liberar, em dólares (ex.: 2 ou 1,50)' };
  if(n>1000) return { ok:false, why:'valor alto demais pra uma tarefa — confira (máximo US$ 1.000 por liberação)' };
  const r=String(reason==null?'':reason).replace(/\s+/g,' ').trim();
  const words=r.split(' ').filter(w=>/[\p{L}\p{N}]{2,}/u.test(w));
  if(words.length<RELEASE_MIN_WORDS) return { ok:false, why:'escreva o motivo em uma frase (pelo menos 3 palavras) — ele vai pro PR' };
  return { ok:true, usd:Math.round(n*100)/100, reason:r.slice(0,400) };
}
function parseRelease(text){
  const t=String(text==null?'':text).replace(/\s+/g,' ').trim();
  const m=t.match(/(?:US\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  if(!m) return { ok:false, why:'escreva quanto liberar e o motivo (ex.: "liberar 2 porque falta o teste de login")' };
  const FILLER=/^(liberar|libera|libere|liberando|mais|continuar|continua|seguir|com|de|us\$|usd|d[óo]lares?|reais|porque|pois|motivo:?|j[áa]|que|[—–:,;.-]+)$/i;
  const words=(t.slice(0,m.index)+' '+t.slice(m.index+m[0].length)).split(' ').filter(Boolean);
  while(words.length && FILLER.test(words[0])) words.shift();
  return releaseCheck(m[1], words.join(' '));
}
// @ciclo-puro-fim

// ---------- a decisão "precisa de você" (seção inline no topo da aba da tarefa) ----------
// O que a pessoa precisa decidir agora — null quando nada. Fonte: spec.needsYou (motor) ou spec.budgetHit (teto
// pausado no meio do turno pelo app, 53-teto-protecao).
// @ciclo-decisao-inicio
function cicloDecision(t){
  if(!t) return null;
  const sp=t.spec||{}, ny=sp.needsYou||null, hit=sp.budgetHit||null;
  if(hit && (t.status==='paused' || t.status==='needs-you' || (hit.mode==='stopped' && t.status==='review'))) return { kind:'teto', text:(ny&&ny.kind==='teto'&&ny.text)||'', hit };
  if(ny && t.status==='needs-you') return { kind:ny.kind, text:ny.text||'' };
  return null;
}
const CICLO_DEC_TITLE={ teto:'Teto de custo', rodadas:'Revisão pediu a 3ª rodada', veredito:'Revisão sem veredito legível' };
function cicloDecisionHtml(t, d, ui){
  if(!d) return '';
  ui=ui||{};
  const cap=typeof budgetOf==='function'?budgetOf(t):0, spent=typeof taskCost==='function'?taskCost(t.id).usd:0;
  const head=`<div class="cicdec-h"><span class="cicdec-dot" aria-hidden="true"></span><b>Precisa de você</b><span class="cicdec-k">${esc(CICLO_DEC_TITLE[d.kind]||'decisão')}</span></div>`;
  const text=`<p class="cicdec-t">${esc(d.text || (d.kind==='teto'&&typeof budgetPrompt==='function'&&d.hit ? budgetPrompt(t, d.hit).split('\n\n')[0] : ''))}</p>`;
  const err=`<p class="cicdec-err" id="cicErr" role="alert">${esc(ui.err||'')}</p>`;
  if(d.kind==='teto'){
    return `<section class="cicdec" id="cicDecide" aria-label="Precisa de você: teto de custo">${head}${text}
      <p class="cicdec-sub">Gasto até agora <b>${esc(fmtCost(spent,{usdOnly:true}))}</b> de <b>${esc(fmtCost(cap,{usdOnly:true}))}</b>. Liberar mais pede o valor e o motivo — o motivo vai pro PR.</p>
      <div class="cicdec-form">
        <label class="cicdec-f cicdec-usd"><span>liberar US$</span><input class="in" id="cicUsd" inputmode="decimal" autocomplete="off" value="${escA(ui.usd||'')}" placeholder="2"></label>
        <label class="cicdec-f cicdec-why"><span>motivo</span><input class="in" id="cicWhy" autocomplete="off" value="${escA(ui.why||'')}" placeholder="ex.: falta o teste de login"></label>
        <div class="cicdec-acts"><button class="btn sm cicdec-go" id="cicRelease">liberar e seguir</button><button class="btn sm" id="cicStop">parar aqui</button></div>
      </div>${err}</section>`;
  }
  // rodadas / veredito (P3): seguir sem mais revisão (com motivo), mais uma rodada (conta no teto) ou parar
  return `<section class="cicdec" id="cicDecide" aria-label="Precisa de você: ${escA(CICLO_DEC_TITLE[d.kind]||'decisão')}">${head}${text}
    <div class="cicdec-form">
      <label class="cicdec-f cicdec-why"><span>motivo (se seguir sem nova revisão)</span><input class="in" id="cicWhy" autocomplete="off" value="${escA(ui.why||'')}" placeholder="ex.: os itens que faltam ficam pra outra tarefa"></label>
      <div class="cicdec-acts"><button class="btn sm cicdec-go" id="cicGo">seguir pra prova</button><button class="btn sm" id="cicRound">mais uma rodada</button><button class="btn sm" id="cicStop">parar aqui</button></div>
    </div>${err}</section>`;
}
// @ciclo-decisao-fim
const cicUi={}; // taskId → { usd, why, err } — o que a pessoa digitou sobrevive a um repaint
function cicloFocusDecision(){ const el=$id('cicUsd')||$id('cicWhy'); const s=$id('cicDecide'); if(s){ s.scrollIntoView(scrollOpts('center')); s.classList.add('flash'); setTimeout(()=>s.classList.remove('flash'),1400); } if(el) el.focus(); }
async function cicloAct(t, kind){
  const ui=cicUi[t.id]=cicUi[t.id]||{};
  const usd=($id('cicUsd')||{}).value, why=($id('cicWhy')||{}).value;
  ui.usd=usd; ui.why=why; ui.err='';
  const btns=[...document.querySelectorAll('#cicDecide button')]; btns.forEach(b=>b.disabled=true);
  try{
    if(kind==='release') await budgetRelease(t, usd, why);
    else if(kind==='stop'){
      if(!await askYes('Parar a tarefa aqui? O trabalho fica como está, pra você revisar.')) return;
      if(typeof budgetQuiet!=='undefined') budgetQuiet.add(t.id);
      await invoke('stop_task',{ taskId:t.id });
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, needsYou:null } });
      toast('Parada — o trabalho ficou como está','ok');
    }
    else if(kind==='go' || kind==='round') await cicloReviewDecide(t, kind, why);
    delete cicUi[t.id];
    lastSig=''; await refresh();
  }catch(e){ ui.err=(typeof errShort==='function')?errShort(e):String(e&&e.message||e); const el=$id('cicErr'); if(el) el.textContent=ui.err; }
  finally{ btns.forEach(b=>{ if(b.isConnected) b.disabled=false; }); }
}
// Pinta a área do ciclo (#fwCiclo, fora do re-render do chat): só quando o conteúdo muda — os campos não perdem o foco.
function cicloPaint(t){
  const host=$id('fwCiclo'); if(!host || !t) return;
  const d=cicloDecision(t);
  const strip=(typeof cicloStripHtml==='function')?cicloStripHtml(t):'';
  const ui=cicUi[t.id]||{};
  const plan=d?'':((typeof cicloPlanHtml==='function')?cicloPlanHtml(t):'');
  cicLearnEnsure(t);
  const learn=cicloLearnHtml(t);
  const sig=t.id+'|'+strip+'|'+JSON.stringify(d)+'|'+plan+'|'+(typeof taskCost==='function'?taskCost(t.id).usd.toFixed(4):'')+'|'+learn.length+':'+Object.keys(typeof LEARN_EDIT!=='undefined'?LEARN_EDIT:{}).join(',')+':'+((cicLearn[t.id]||{}).sig||'');
  if(host.__sig===sig) return;
  const keep=document.activeElement && host.contains(document.activeElement) ? document.activeElement.id : '';
  host.__sig=sig;
  { const oc=(typeof FW_HEAD!=='undefined' && FW_HEAD.orq)||null; if(oc && host.contains(oc)) oc.remove(); } // o nó dos chips do orquestrador sobrevive ao innerHTML
  host.innerHTML=strip+(d?cicloDecisionHtml(t, d, ui):plan)+learn;
  host.hidden=!host.innerHTML;
  cicMotion(t, host);
  ['cicUsd','cicWhy'].forEach(id=>{ const el=$id(id); if(el) el.oninput=()=>{ const u=cicUi[t.id]=cicUi[t.id]||{}; u[id==='cicUsd'?'usd':'why']=el.value; }; });
  const on=(id, k)=>{ const b=$id(id); if(b) b.onclick=()=>cicloAct(t, k); };
  on('cicRelease','release'); on('cicStop','stop'); on('cicGo','go'); on('cicRound','round');
  const why=$id('cicWhy'); if(why) why.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); const b=$id('cicRelease')||$id('cicGo'); if(b) b.click(); } };
  if(typeof cicloStripWire==='function') cicloStripWire(host, t);
  if(typeof fwOrqChipsPlace==='function') fwOrqChipsPlace();
  if(learn && typeof learnWire==='function') learnWire(host, { repo:()=>state.repo, items:()=>(cicLearn[t.id]||{}).items||[], repaint:()=>{ host.__sig=''; cicloPaint(t); }, after:async()=>{ delete cicLearn[t.id]; host.__sig=''; cicloPaint(t); } });
  if(keep){ const el=$id(keep); if(el){ el.focus(); try{ el.setSelectionRange(el.value.length, el.value.length); }catch(_){ } } }
}

// F3 (movimento): etapa que acabou de ser FEITA enche a estação (a bolinha "assenta") e o contador do portão rola —
// só quando muda em relação à pintura anterior desta tarefa (1ª pintura, troca de tarefa e poll igual: nada)
const CIC_MV={};
function cicMotion(t, host){
  const st=[...host.querySelectorAll('.cicst')], feito={}, by={}; st.forEach((li,i)=>{ const k=li.dataset.st||String(i); feito[k]=li.classList.contains('s-feito'); by[k]=li; }); // chave = id da etapa (estável)
  const b=host.querySelector('.cicgate-tx b'), ok=b?parseInt(b.textContent,10):null;
  const prev=CIC_MV[t.id]; CIC_MV[t.id]={ feito, ok };
  if(!prev || typeof mvNewlyTrue!=='function') return;
  mvNewlyTrue(prev.feito, feito).forEach(k=>{ const av=by[k] && by[k].querySelector('.cicst-av'); mvAnim(av, [{ transform:'scale(.4)', opacity:.4 }, { transform:'scale(1.12)', opacity:1, offset:.6 }, { transform:'none' }], { duration:300 }); });
  if(mvTicked(prev.ok, ok)){ mvTick(b); mvAnim(host.querySelector('.cicgate-ring'), [{ transform:'scale(.8)' }, { transform:'scale(1.12)', offset:.6 }, { transform:'none' }], { duration:300 }); }
}

// ---------- P9: os aprendizados que a retro DESTA tarefa propôs, em frase, logo abaixo da faixa ----------
// Lidos quando aparece um evento novo da retro (nada de polling: o snapshot que já chega diz se mudou).
const cicLearn={}; // taskId → { sig, items }
function cicLearnEnsure(t){
  const evs=(typeof eventsOf==='function'?eventsOf(t.id):[]);
  let r=null; for(let i=evs.length-1;i>=0;i--){ if(evs[i].type==='retro'){ r=evs[i]; break; } }
  if(!r) return;
  const sig=String(r.id), c=cicLearn[t.id];
  if(c && c.sig===sig) return;
  cicLearn[t.id]={ sig, items:c?c.items:[] };
  const repo=state.repo;
  invoke('learn_pending',{ repo }).then(l=>{
    if(!cicLearn[t.id] || cicLearn[t.id].sig!==sig || state.repo!==repo) return;
    cicLearn[t.id].items=(l||[]).filter(x=>x.taskId===t.id);
    const h=$id('fwCiclo'); if(h) h.__sig=''; if(typeof fwTask!=='undefined' && fwTask===t.id) cicloPaint(t);
  }).catch(()=>{});
}
function cicloLearnHtml(t){
  const it=((cicLearn[t.id]||{}).items)||[]; if(!it.length || typeof memLearnCard!=='function') return '';
  return `<section class="ciclearn" aria-label="Aprendizados desta tarefa"><p class="ciclearn-h"><b>A retro desta tarefa propôs ${it.length===1?'1 coisa':it.length+' coisas'} pra lembrar</b> — nada entra sem o seu sim, e dá pra voltar depois.</p>`+
    `<div class="memlgrid">${it.map(x=>memLearnCard(x, { editing:(typeof LEARN_EDIT!=='undefined'?LEARN_EDIT:{})[x.id] })).join('')}</div></section>`;
}

// =====================================================================================================================
// F2 — o processo de ponta a ponta: FLOW_BY_KIND (P2), a faixa de etapas (P1), as rodadas de revisão (P3),
// os dois cadeados e o Relatório Starfork no PR. Funções puras ≡ src/lifecycle.ts (fixtures ciclo-golden).
// @ciclo-fluxo-inicio
const CIC_PLANO={ id:'plano', label:'Plano', role:'planner', agentId:'vega', lock:1 };
const CIC_DESIGN={ id:'design', label:'Design', role:'designer', agentId:'aria' };
const CIC_CONSTRUIR={ id:'construir', label:'Construir', role:'builder', agentId:'iris' };
const CIC_ESCREVER={ id:'escrever', label:'Escrever', role:'docs', agentId:'lumen' };
const CIC_REV_COD={ id:'revisar', label:'Revisar', role:'reviewer', agentId:'nyx', lens:'codigo' };
const CIC_REV_DOC={ id:'revisar', label:'Conferir', role:'reviewer', agentId:'nyx', lens:'documento' };
const CIC_PROVAR={ id:'provar', label:'Provar' }, CIC_ENTREGAR={ id:'entregar', label:'Entregar', lock:2 }, CIC_RETRO={ id:'retro', label:'Retro' };
const FLOW_BY_KIND={
  codigo:[CIC_PLANO, Object.assign({}, CIC_DESIGN, { optional:true }), CIC_CONSTRUIR, CIC_REV_COD, CIC_PROVAR, CIC_ENTREGAR, CIC_RETRO],
  pagina:[CIC_PLANO, CIC_DESIGN, CIC_CONSTRUIR, CIC_REV_COD, CIC_PROVAR, CIC_ENTREGAR, CIC_RETRO],
  pesquisa:[CIC_PLANO, CIC_ESCREVER, CIC_REV_DOC, CIC_PROVAR, CIC_ENTREGAR, CIC_RETRO],
  documento:[CIC_PLANO, CIC_ESCREVER, CIC_REV_DOC, CIC_PROVAR, CIC_ENTREGAR, CIC_RETRO],
};
const KIND_LABEL={ codigo:'Código', pagina:'Página/tela', pesquisa:'Pesquisa', documento:'Documento' };
const KIND_TEAM={ codigo:'Feature com revisão', pagina:'Página simples', pesquisa:'Pesquisa conferida', documento:'Relatório conferido' };
const TASK_KINDS=['codigo','pagina','pesquisa','documento'];
const MAX_REVIEW_ROUNDS=2;
function taskKindOf(spec){
  const k=String((spec&&spec.taskKind)||'');
  if(TASK_KINDS.includes(k)) return k;
  const b=String((spec&&spec.branchType)||'').toLowerCase();
  return b==='design'?'pagina':b==='docs'?'documento':b==='invest'?'pesquisa':'codigo';
}
// etapas com agente do tipo (o que o intake mostra: "3 etapas")
function kindAgentStages(kind, withDesign){ return (FLOW_BY_KIND[kind]||FLOW_BY_KIND.codigo).filter(s=>s.role && (!s.optional||withDesign)); }
// @ciclo-fluxo-fim

// ---------- a faixa (P1): pura, testada em app/tests/ciclo.test.mjs ----------
// x = { costs:[{role,agent,usd}], proof:'none'|'loading'|'proven'|'unproven'|'override', retro:'texto do evento retro'|null,
//       working:bool, spent, cap }
// @ciclo-faixa-inicio
const CIC_DOING={ planner:'planejando', designer:'desenhando', builder:'construindo', docs:'escrevendo', reviewer:'revisando', tester:'testando', investigator:'investigando' };
const CIC_ROLE_LABEL={ planner:'Plano', designer:'Design', builder:'Construir', docs:'Escrever', reviewer:'Revisar', tester:'Testar', investigator:'Investigar', security:'Segurança' };
function taskStages(t, x){
  x=x||{};
  const sp=t.spec||{}, roles=Array.isArray(t.roles)?t.roles:[];
  const kind=taskKindOf({ taskKind:sp.taskKind, branchType:t.branchType||sp.branchType });
  const flow=FLOW_BY_KIND[kind];
  const legacy=!sp.taskKind;
  const ny=t.status==='needs-you'?(sp.needsYou||null):null;
  const fin=!!t.prUrl || ['merged','done','closed'].includes(t.status) || t.flag==='closed';
  const ready=['review','delivered'].includes(t.status);
  const extras=Array.isArray(sp.extraStages)?sp.extraStages:[];
  // etapa extra rodando ("Chamar outro agente…"): o time da tarefa já terminou — só a extra está "agora"
  const afterRoles=ready||fin||extras.some(s=>s.status==='rodando');
  const rounds=Array.isArray(sp.reviewRounds)?sp.reviewRounds:[];
  let cur=roles.findIndex(r=>r.role===t.stage); if(cur<0) cur=0;
  // parada ENTRE etapas (teto): a próxima é a que espera; rodadas/veredito: a decisão é sobre a revisão
  let stuck=-1;
  if(ny && Number.isInteger(ny.roleIdx)) stuck=ny.kind==='teto'?ny.roleIdx:Math.max(0, ny.roleIdx-1);
  else if(t.status==='needs-you' || (sp.budgetHit && t.status==='paused')) stuck=cur;
  const usdOf=r=>(x.costs||[]).filter(c=>c.role===r.role && (!c.agent || c.agent===r.name)).reduce((s,c)=>s+(+c.usd||0),0);
  const out=roles.map((r,i)=>{
    const def=flow.find(s=>s.role===r.role)||{ id:r.role, label:CIC_ROLE_LABEL[r.role]||r.role };
    let state, word;
    if(stuck>=0 && i===stuck){ state=ny&&ny.kind==='teto'?'sua-vez':'precisa'; word=ny&&ny.kind==='teto'?'teto':'precisa de você'; }
    else if(afterRoles || i<cur || (stuck>=0 && i<stuck)){ state='feito'; word='pronto'; }
    else if(i===cur && stuck<0){
      if(t.status==='plan-review' && r.role==='planner'){ state='feito'; word='pronto'; }
      else if(['error','aborted'].includes(t.status)){ state='precisa'; word='parou'; }
      else if(t.status==='paused'){ state='espera'; word='pausada'; }
      else if(['draft','queued'].includes(t.status) && !x.working){ state='espera'; word='na fila'; }
      else { const n=rounds.length+1; state='agora'; word=r.role==='reviewer'?((def.lens==='documento'?'conferindo':'revisando')+(n<=MAX_REVIEW_ROUNDS?` ${n}/${MAX_REVIEW_ROUNDS}`:' (rodada extra)')):(CIC_DOING[r.role]||'trabalhando'); }
    }
    else { state='espera'; word='depois'; }
    // Cadeado 1: no plano. Fica sempre visível (tarefa antiga só quando pedia aprovação do plano)
    const lock=(def.lock===1 && (!legacy || sp.planApproval==='review'))?1:0;
    const st={ id:def.id, label:def.label, role:r.role, who:r.name, state, word, usd:usdOf(r), lock, idx:i };
    if(lock && t.status==='plan-review' && r.role==='planner'){ st.state='sua-vez'; st.word='sua vez'; }
    if(r.role==='reviewer' && rounds.length && state==='feito'){ const last=rounds[rounds.length-1]; st.word=last.verdict==='aprova'?'aprovou':last.verdict==='muda'?'pediu mudança':'sem veredito'; }
    return st;
  });
  // etapas EXTRAS da revisão (≡ flowWithExtras do src/revisao-alteracao.ts): depois de Revisar, antes de Provar
  if(extras.length){
    let at=out.map(s=>s.role).lastIndexOf('reviewer'); if(at<0) at=out.length-1;
    const LBL={ design:'Design', revisor:'Revisão', qa:'Testes', seguranca:'Segurança', performance:'Performance', docs:'Docs' };
    const ex=extras.map(s=>{ const n=(s.files||[]).length;
      return { id:s.id, label:'+ '+(LBL[s.kind]||s.kind), role:s.role, who:s.name, extra:true, lock:0, usd:+s.usd||0,
        state:s.status==='rodando'?'agora':s.status==='falhou'?'precisa':'feito',
        word:s.status==='rodando'?(CIC_DOING[s.role]||'trabalhando'):s.status==='falhou'?'parou':(n+(n===1?' arquivo':' arquivos')) }; });
    out.splice(at+1, 0, ...ex);
  }
  // etapas do app (sem agente): prova, portão (Cadeado 2) e retro
  const pv=x.proof||'none';
  out.push(fin ? { id:'provar', label:'Provar', state:'feito', word:'provado', lock:0 }
    : !ready ? { id:'provar', label:'Provar', state:'espera', word:'depois', lock:0 }
    : pv==='proven' ? { id:'provar', label:'Provar', state:'feito', word:'provado', lock:0 }
    : pv==='override' ? { id:'provar', label:'Provar', state:'feito', word:'sem prova, com motivo', lock:0 }
    : pv==='unproven' ? { id:'provar', label:'Provar', state:'precisa', word:'falta prova', lock:0 }
    : pv==='loading' ? { id:'provar', label:'Provar', state:'agora', word:'conferindo', lock:0 }
    : { id:'provar', label:'Provar', state:'feito', word:'sem requisitos', lock:0 });
  out.push(fin ? { id:'entregar', label:'Entregar', state:'feito', word:'entregue', lock:2 }
    : ready ? { id:'entregar', label:'Entregar', state:'sua-vez', word:'sua vez', lock:2 }
    : { id:'entregar', label:'Entregar', state:'espera', word:'depois', lock:2 });
  if(!legacy || x.retro){
    const rt=String(x.retro||'');
    out.push(rt ? { id:'retro', label:'Retro', state:'feito', word:/pulada|não respondeu/.test(rt)?'pulada':'pronto', lock:0 }
      : { id:'retro', label:'Retro', state:'espera', word:'depois', lock:0 });
  }
  return out;
}
function stagesSummary(stages, x){
  x=x||{};
  const now=stages.find(s=>s.state==='precisa'||s.state==='sua-vez') || stages.find(s=>s.state==='agora');
  const next=stages.find(s=>s.state==='espera');
  let nowTx='';
  if(now){
    if(now.state==='sua-vez') nowTx=now.lock===1?'Sua vez: aprovar o plano':now.lock===2?'Sua vez: aprovar a entrega':now.word==='teto'?'Precisa de você: o teto':'Sua vez';
    else if(now.state==='precisa') nowTx=now.id==='provar'?'Falta prova':now.word==='parou'?((now.who||now.label)+' parou'):'Precisa de você';
    else nowTx=now.who?`Agora: ${now.who} está ${now.word}`:`Agora: ${now.word}`;
  } else if(stages.length && stages.every(s=>s.state==='feito')) nowTx='Tudo pronto';
  const at=now||next||stages[stages.length-1];
  return { now:nowTx, next:next?('Depois: '+next.label+(next.who?' ('+next.who+')':'')):'', spent:+x.spent||0, cap:+x.cap||0, n:stages.length, pos:Math.max(1, stages.indexOf(at)+1), label:at?at.label:'' };
}
const CIC_LOCK='<svg class="cicst-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke-linecap="round"/></svg>';
const CIC_CHECK='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3.5 8.4l2.9 2.8 6-6.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function stageStripHtml(stages, sum, o){
  o=o||{};
  const usd=v=>typeof fmtCost==='function'?fmtCost(v,{usdOnly:true}):'US$ '+(+v).toFixed(2).replace('.',',');
  const items=stages.map((s,i)=>{
    const face=s.who?`<span class="cicst-av" aria-hidden="true" style="background:${o.color?o.color(s.who):'var(--surface-3)'}">${s.state==='feito'?CIC_CHECK:esc(String(s.who).slice(0,1).toUpperCase())}</span>`
      :`<span class="cicst-av app" aria-hidden="true">${s.state==='feito'?CIC_CHECK:s.lock?CIC_LOCK:''}</span>`;
    const cost=s.usd>0?`<span class="cicst-c">${esc(usd(s.usd))}</span>`:'';
    const lock=s.lock?`<span class="cicst-k" title="${s.lock===1?'Cadeado 1: você aprova o plano':'Cadeado 2: você aprova a entrega (portão)'}">${CIC_LOCK}<span class="sr-only">cadeado ${s.lock}</span></span>`:'';
    const cur=(s.state==='agora'||s.state==='precisa'||s.state==='sua-vez');
    return `<li class="cicst s-${s.state}${o.open===i?' open':''}" data-st="${escA(String(s.id||s.role||i))}"><button class="cicst-b" data-cicst="${i}"${cur?' aria-current="step"':''} aria-expanded="${o.open===i?'true':'false'}" title="${escA(s.label+(s.who?' · '+s.who:'')+': '+s.word)}">${face}<span class="cicst-tx"><span class="cicst-l">${esc(s.label)}${lock}</span><span class="cicst-w">${esc(s.word)}</span></span>${cost}</button></li>`;
  }).join('<li class="cicst-sep" aria-hidden="true"></li>');
  const capTx=sum.cap>0?` de ${esc(usd(sum.cap))}`:'';
  // o.foot: rodapé próprio (a prévia da equipe em "Meu time" mostra o custo médio, não o "gasto até agora")
  const foot=o.foot!=null?`<div class="cicst-sum"><span class="cicst-cost">${o.foot}</span></div>`
    // redesenho F1: UMA faixa — etapas · portão · adiados · gasto. "Agora/Depois" ficam pro leitor de tela e pro tooltip
    // (a palavra de cada etapa já diz); estreito vira "etapa n de N · Rótulo"
    :`<div class="cicst-sum" title="${escA([sum.now, sum.next].filter(Boolean).join(' · '))}">${o.gate||''}<span class="cicst-now">${esc(sum.now)}</span>${sum.next?`<span class="cicst-next">${esc(sum.next)}</span>`:''}<span class="cicst-pos">etapa ${sum.pos} de ${sum.n}</span>${sum.label?`<span class="cicst-posl"> · ${esc(sum.label)}</span>`:''}<span class="cicst-cost">gasto <b>${esc(usd(sum.spent))}</b>${capTx}</span></div>`;
  return `<div class="cicstrip" role="group" aria-label="${escA(o.label||'Etapas da tarefa')}">`+(o.pill||'')+
    `<ol class="cicst-list">${items}</ol>`+foot+
  `</div>`;
}
// portão + adiados na MESMA faixa das etapas (redesenho F1, protótipo aprovado): o anel é estático (sem animação — F3).
// g = { st:'none'|'loading'|'proven'|'unproven'|'override', ok, n, adiados } — os números saem de reqRows/proofGate
// (fonte única). Adiado é tracejado, nunca riscado (mesa: riscado parece "removido").
function cicGateHtml(g){
  if(!g || g.st==='none' || !(+g.n>0 || +g.adiados>0)) return '';
  const n=Math.max(0, +g.n||0), ok=g.st==='loading'?0:Math.max(0, Math.min(n, +g.ok||0)), ad=Math.max(0, +g.adiados||0);
  const tone=g.st==='proven'?'ok':g.st==='override'?'ov':g.st==='loading'?'ld':'no';
  const tip=g.st==='proven'?'Portão de provas liberado: todos os requisitos têm prova'
    :g.st==='override'?'Portão liberado sem prova, com o motivo registrado no PR'
    :g.st==='loading'?'Conferindo as provas dos requisitos'
    :'Portão de provas ligado: aprovar exige a prova de cada requisito (ou um motivo)';
  const C=2*Math.PI*6.5, fill=(n?ok/n*C:(g.st==='loading'?0:C)).toFixed(2);
  const ring=`<svg class="cicgate-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" class="bg"/><circle cx="8" cy="8" r="6.5" class="fg" stroke-dasharray="${fill} ${C.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
  const tx=g.st==='loading'?'conferindo as provas…':n?`<b>${ok} de ${n}</b><span class="cicgate-w"> exigidos com prova</span>`:'<span class="cicgate-w">nenhum exigido</span>';
  const adTx=ad?`<span class="cicgate-ad" title="${escA(ad===1?'1 requisito adiado com motivo — o motivo aparece no painel de requisitos':ad+' requisitos adiados com motivo — os motivos aparecem no painel de requisitos')}">${ad===1?'1 adiado':ad+' adiados'}</span>`:'';
  return `<span class="cicgate g-${tone}" title="${escA(tip)}">${ring}<span class="cicgate-tx">${tx}</span></span>${adTx}`;
}
// @ciclo-faixa-fim

// ---------- Relatório Starfork (≡ starforkReport do motor; fixture ciclo-golden/relatorio.json) ----------
// @ciclo-relatorio-inicio
const CIC_ROLE_PT={ planner:'plano', builder:'construção', reviewer:'revisão', designer:'design', docs:'escrita', tester:'testes', retro:'retro', investigator:'investigação' };
function cicUsdBr(n){ const v=Math.round((Number(n)||0)*100)/100; return 'US$ '+v.toFixed(2).replace('.',','); }
function cicloReport(d){
  const md=s=>String(s==null?'':s).replace(/\|/g,'\\|').replace(/\s+/g,' ').trim();
  const tag=r=>`${r.agentId||r.name}@v${r.version} · ${[r.engine, r.model].filter(Boolean).join(' · ')}`;
  const L=['## Relatório Starfork',''];
  if(d.requirements.length){
    L.push('**Requisitos × provas**','','| Requisito | Prova |','|---|---|');
    const lk=d.proofs||{};
    const code=e=>'`'+md(e)+'`';
    // com prova publicada (branch starfork-provas): miniatura clicável / link do vídeo + nome como legenda
    const cell=(r,i)=>r.status!=='provado'?r.status
      : !r.evidence.some(e=>lk[e])?`provado — ${r.evidence.map(code).join(', ')||'evidência no disco'}`
      : 'provado<br>'+r.evidence.map(e=>!lk[e]?code(e):lk[e].kind==='img'?`![R${i+1}](${lk[e].url})<br>${code(e)}`:`[▶ ${md(e)}](${lk[e].url})`).join('<br>');
    d.requirements.forEach((r,i)=>L.push(`| ${md(r.text)} | ${cell(r,i)} |`));
    L.push('');
    if(Object.keys(lk).length) L.push('*Provas no branch `starfork-provas` deste repositório (fora do código do PR) — clique na miniatura pra ver no tamanho real.*','');
  }
  if(d.proofNote) L.push(`*${md(d.proofNote)}*`,'');
  if(d.noProofReason) L.push(`**Aprovado sem prova**${d.noProofBy?` por ${md(d.noProofBy)}`:''}: ${md(d.noProofReason)}`,'');
  if(d.reviewOverride) L.push(`**Seguiu sem nova revisão:** ${md(d.reviewOverride)}`,'');
  if(d.rounds.length) L.push(`**Revisão:** ${d.rounds.map(r=>`rodada ${r.round} (${md(r.reviewer)}) — ${r.verdict==='aprova'?'aprova':r.verdict==='muda'?`muda (${r.items.length})`:'ilegível'}`).join(' · ')}`,'');
  for(const x of (d.extraLines||[])) L.push(x,'');
  if(d.runs.length) L.push(`**Versões:** ${d.runs.map(r=>`${CIC_ROLE_PT[r.role]||r.role} \`${tag(r)}\``).join(' · ')}`,'');
  if(d.orgPolicy&&d.orgPolicy.length) L.push(`**Política da organização:** ${d.orgPolicy.map(md).join(' · ')}`,'');
  return L.join('\n').trimEnd()+'\n';
}
// @ciclo-relatorio-fim
// o relatório desta tarefa a partir do que a tela já tem (provas, motivo do "sem prova", custo, spec)
function cicloReportFor(t){
  try{
    const sp=t.spec||{};
    const rows=(typeof reqRows==='function')?reqRows(t):[];
    const ov=(typeof proofOvGet==='function')?proofOvGet(t.id):null;
    const byRole={}; for(const c of (typeof costsOf==='function'?costsOf(t.id):[])){ const k=(c.role||'')+'|'+c.agent; (byRole[k]=byRole[k]||{ role:c.role||'', name:c.agent, usd:0 }).usd+=(+c.usd||0); }
    const who=(typeof cloudUser==='function'&&cloudUser()&&cloudUser().name)||'';
    const pv=(typeof provasOf==='function')?provasOf(t.id):null; // provas no PR (60-provas-pr): links do branch starfork-provas
    return '\n\n'+cicloReport({
      requirements:rows.map(r=>({ text:r.text, status:r.st==='ok'&&r.evidence.length?'provado':'sem prova', evidence:r.st==='ok'?r.evidence:[] })),
      noProofReason:ov&&ov.reason||'', noProofBy:ov&&ov.reason?who:'', reviewOverride:(sp.reviewOverride&&sp.reviewOverride.reason)||'',
      costByRole:Object.values(byRole), totalUsd:taskCost(t.id).usd, capUsd:(sp.autopilot && !(+sp.budgetUsd>0))?0:budgetOf(t),
      releases:Array.isArray(sp.budgetReleases)?sp.budgetReleases:[], rounds:Array.isArray(sp.reviewRounds)?sp.reviewRounds:[], runs:Array.isArray(sp.roleRuns)?sp.roleRuns:[],
      orgPolicy:sp.orgPolicy&&Array.isArray(sp.orgPolicy.rules)?sp.orgPolicy.rules:undefined,
      extraLines:(typeof rqExtraReportLines==='function'&&Array.isArray(sp.extraStages))?rqExtraReportLines(sp.extraStages):undefined,
      proofs:pv&&pv.links&&Object.keys(pv.links).length?pv.links:undefined, proofNote:(pv&&pv.note)||undefined,
    });
  }catch(e){ console.error('relatório starfork', e); return ''; }
}

// ---------- a faixa na aba da tarefa ----------
const cicOpen={}; // taskId → índice da etapa aberta (o que ela entregou)
function cicloStripX(t){
  const pg=(typeof proofGate==='function')?proofGate(t):{ st:'none' };
  const retro=[...(typeof eventsOf==='function'?eventsOf(t.id):[])].reverse().find(e=>e.type==='retro');
  const rows=(typeof reqRows==='function' && pg.st!=='none')?reqRows(t):[];
  const adiados=(typeof reqIsAdiado==='function')?rows.filter(reqIsAdiado).length:0;
  const n=rows.length-adiados; // EXIGIDOS: adiado com motivo conta como resolvido (proofMissingOf já não pede)
  return { costs:(typeof costsOf==='function'?costsOf(t.id):[]).map(c=>({ role:c.role, agent:c.agent, usd:c.usd })), proof:pg.st, retro:retro?retro.text:null,
    working:(typeof fwIsWorking==='function')?fwIsWorking(t):false, spent:taskCost(t.id).usd, cap:budgetOf(t),
    gate:{ st:pg.st, n, ok:pg.st==='loading'?0:n-(pg.missing||[]).length, adiados } }; // portão = proofGate (o mesmo do painel e da Entrega); lendo = anel vazio
}
function cicloStripHtml(t){
  if(!t || t.kind==='review' || !(t.roles||[]).length) return '';
  const x=cicloStripX(t), st=taskStages(t, x), sum=stagesSummary(st, x);
  const open=cicOpen[t.id];
  // faixa 2 do cabeçalho (redesenho F1): selo do estado + etapas + portão/adiados + gasto, numa linha só
  // com o cabeçalho docado na barra de abas, o que ele mostrava vem pra cá: épico (clique abre), chips do orquestrador
  // (#cicOrq, o nó é movido por fwOrqChipsPlace) e a branch (texto curto em faixa larga; sempre no tooltip do selo)
  const br=t.branch?'branch: '+t.branch+(t.agent?' · '+t.agent:''):'';
  const ep=(typeof epTaskBadge==='function')?epTaskBadge(t):'';
  const pill=((typeof phasesHtml==='function')?`<span class="cicst-pill"${br?` title="${escA(br)}"`:''}>${phasesHtml(t)}</span>`:'')+
    (ep?`<span class="cicst-epic">${ep}</span>`:'')+(t.orchestration?'<span class="cicst-orq" id="cicOrq"></span>':'')+
    (t.branch?`<span class="cicst-br mono" title="${escA(br)}">${esc(t.branch)}</span>`:'')+
    ((typeof enStampEntregue==='function')?enStampEntregue(t):''); // integrada: o carimbo "entregue" (27-entregas)
  return stageStripHtml(st, sum, { open, color:(typeof agentColor==='function')?agentColor:null, gate:cicGateHtml(x.gate), pill })+(open!=null&&st[open]?cicloStageDetail(t, st[open]):'')
    +((typeof budgetNoticeHtml==='function')?budgetNoticeHtml(t):''); // F4: teto de custo atingido → "Aviso do Starfork" logo abaixo das etapas (G3)
}
// o que a etapa entregou, em linguagem normal; o log fica em "ver detalhes"
function cicloStageDetail(t, s){
  const evs=(typeof eventsOf==='function'?eventsOf(t.id):[]);
  const mine=s.who?evs.filter(e=>e.agent===s.who):[];
  const sp=t.spec||{};
  let body='';
  if(s.role==='reviewer'){
    const rs=Array.isArray(sp.reviewRounds)?sp.reviewRounds:[];
    body=rs.length?rs.map(r=>`<p><b>Rodada ${r.round}:</b> ${r.verdict==='aprova'?'aprovou':r.verdict==='muda'?'pediu mudanças':'não deu veredito legível'}</p>${r.items&&r.items.length?'<ul>'+r.items.map(i=>`<li>${esc(i)}</li>`).join('')+'</ul>':''}`).join(''):'<p class="dim">ainda sem veredito</p>';
  } else if(s.extra){
    // etapa extra ("Chamar outro agente…"): o resumo dela + os arquivos que mudou (os fora de tela em destaque)
    const x=(Array.isArray(sp.extraStages)?sp.extraStages:[]).find(e=>e.id===s.id)||{};
    const out=Array.isArray(x.outsideUi)?x.outsideUi:[];
    body=`<p>${esc(x.summary||(x.status==='rodando'?'trabalhando nesta mesma branch…':x.status==='falhou'?'não terminou — veja o log':'terminou sem resumo'))}</p>`
      +((x.files||[]).length?'<ul>'+x.files.slice(0,12).map(f=>`<li class="mono">${esc(f)}${out.includes(f)?' — <b>fora de tela</b>':''}</li>`).join('')+'</ul>':'')
      +(x.note?`<p class="dim">Você pediu: ${esc(x.note)}</p>`:'');
  } else if(s.id==='provar'){
    const rows=(typeof reqRows==='function')?reqRows(t):[];
    body=rows.length?'<ul>'+rows.map(r=>`<li>${esc(r.text)} — <b>${r.st==='ok'&&r.evidence.length?'provado':'falta prova'}</b></li>`).join('')+'</ul>':'<p class="dim">esta tarefa não tem requisitos com prova</p>';
  } else if(s.id==='entregar'){
    body=`<p>${s.state==='sua-vez'?'Cadeado 2: confira a Prévia e o que foi provado, e aprove a entrega (sem prova, só com motivo — ele vai pro PR).':s.state==='feito'?'Entregue.':'Abre quando a prova terminar.'}</p>`+(s.state==='sua-vez'?'<button class="btn sm" id="cicGate">aprovar a entrega</button>':'');
  } else if(s.id==='retro'){
    const r=[...evs].reverse().find(e=>e.type==='retro'); body=`<p>${esc(r?r.text:'a retro roda quando a tarefa termina, dentro do teto')}</p>`;
  } else {
    const done=[...mine].reverse().find(e=>e.type==='done'||(e.type==='note'&&e.text&&!/^custo do turno/.test(e.text)));
    body=`<p>${esc(done?done.text:'ainda não entregou nada')}</p>`;
  }
  const log=mine.filter(e=>['papel','bastao','veredito','error'].includes(e.type)||e.type==='done').slice(-6);
  const det=log.length?`<details class="cicst-det"><summary>ver detalhes</summary><ul class="mono">${log.map(e=>`<li>${esc(String(e.text||'').slice(0,300))}</li>`).join('')}</ul></details>`:'';
  return `<div class="cicst-panel" role="region" aria-label="${escA(s.label+': o que entregou')}"><div class="cicst-ph"><b>${esc(s.label)}</b>${s.who?` · ${esc(s.who)}`:''} — ${esc(s.word)}</div>${body}${det}</div>`;
}
function cicloStripWire(host, t){
  if(typeof budgetNoticeWire==='function') budgetNoticeWire(host);
  host.querySelectorAll('[data-cicst]').forEach(b=>{
    b.onclick=()=>{ const i=+b.dataset.cicst; cicOpen[t.id]=cicOpen[t.id]===i?undefined:i; host.__sig=''; cicloPaint(t); const nb=host.querySelector(`[data-cicst="${i}"]`); if(nb) nb.focus(); };
    // ←/→ entre as etapas (padrão de 54-acessibilidade: setas movem o foco, Enter abre)
    b.onkeydown=e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return; e.preventDefault(); const all=[...host.querySelectorAll('[data-cicst]')]; const i=all.indexOf(b); const n=all[(i+(e.key==='ArrowRight'?1:-1)+all.length)%all.length]; if(n) n.focus(); };
  });
  const g=host.querySelector('#cicGate'); if(g) g.onclick=()=>{ if(typeof approveGate==='function') approveGate(t); };
  host.querySelectorAll('.cicst-epic [data-epbadge]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); if(typeof epOpenById==='function') epOpenById(b.dataset.epbadge); });
  const pa=host.querySelector('#cicPlanAsk'); if(pa) pa.onclick=()=>{ const i=(typeof fwInputShow==='function')?fwInputShow():$id('fwInput'); if(i){ i.focus(); i.placeholder='o que ajustar no plano?'; } };
}

// ---------- rodadas (P3): a decisão quando a revisão não fecha ----------
async function cicloReviewDecide(t, kind, why){
  if(kind==='go'){
    const r=releaseCheck(1, why); // reaproveita a régua do motivo (≥ 3 palavras)
    if(!r.ok) throw new Error('pra seguir sem nova revisão, escreva o motivo em uma frase — ele vai pro PR');
    await invoke('patch_task_spec',{ taskId:t.id, patch:{ needsYou:null, reviewOverride:{ reason:r.reason, at:Date.now(), kind:((t.spec||{}).needsYou||{}).kind||'' } } });
    await invoke('start_task',{ taskId:t.id });
    toast('Seguindo pra prova — o motivo vai pro PR','ok');
  } else {
    await invoke('patch_task_spec',{ taskId:t.id, patch:{ needsYou:null, reviewExtra:true } });
    await invoke('start_task',{ taskId:t.id });
    toast('Mais uma rodada: volta pro builder com o que a revisão pediu (conta no teto)','ok');
  }
}

// ---------- Cadeado 1: o plano pra aprovar, com o roteiro e o preço ----------
const cicPlan={}; // taskId → texto do PLAN.md (lido uma vez quando o plano pede aprovação)
function cicloPlanHtml(t){
  if(t.status!=='plan-review') return '';
  const p=cicPlan[t.id];
  if(p===undefined){ cicPlan[t.id]=null; invoke('read_file',{ taskId:t.id, path:'.cardume/PLAN.md' }).then(r=>{ cicPlan[t.id]=String((r&&r.content)||''); const h=$id('fwCiclo'); if(h) h.__sig=''; if(typeof fwTask!=='undefined'&&fwTask===t.id) cicloPaint(t); }).catch(()=>{ cicPlan[t.id]=''; }); }
  const roles=(t.roles||[]).filter(r=>r.role!=='planner');
  const model=(roles[0]&&roles[0].model)||t.model||'';
  const [lo,hi]=(typeof roughEstimate==='function')?roughEstimate(Math.max(1, roles.length), /opus|sonnet|haiku/.exec(String(model))?.[0]||''):[0,0];
  const spent=taskCost(t.id).usd, cap=budgetOf(t);
  const plan=p?`<pre class="cicplan-tx">${esc(p.slice(0,1800))}${p.length>1800?'\n…':''}</pre>`:p===null?'<p class="dim">lendo o plano…</p>':'<p class="dim">o plano está na conversa (o agente não gravou o .cardume/PLAN.md)</p>';
  return `<section class="cicdec cicplan" id="cicDecide" aria-label="Cadeado 1: aprovar o plano"><div class="cicdec-h">${CIC_LOCK}<b>Cadeado 1 · aprovar o plano</b><span class="cicdec-k">antes de gastar com a construção</span></div>
    ${plan}
    <p class="cicdec-sub">As próximas etapas (${roles.map(r=>esc(r.name)).join(' → ')}) devem custar <b>${esc(typeof fmtCostRange==='function'?fmtCostRange(lo,hi):cicUsdBr(lo)+'–'+cicUsdBr(hi))}</b>. Gasto até agora ${esc(cicUsdBr(spent))} de ${esc(cicUsdBr(cap))} de teto.</p>
    <div class="cicdec-acts"><button class="btn sm" id="cicPlanAsk">pedir ajuste no plano</button><span class="dim cicdec-hint">aprovar está no topo (“aprovar plano”)</span></div></section>`;
}

// ---------- intake (Nova demanda): o TIPO de entrega e a estimativa + teto à vista (P2 + P6) ----------
let ntKind='codigo', ntKindBudgetOpen=false, ntTeamTouched=false;
function ntKindCardHtml(){
  const st=kindAgentStages(ntKind);
  const model=(($id('ntModel')||{}).value)||'';
  const [lo,hi]=(typeof roughEstimate==='function')?roughEstimate(st.length, model):[0,0];
  const cap=(typeof ntBudgetPending!=='undefined'&&ntBudgetPending>0)?ntBudgetPending:costCapDefault();
  return `<div class="ntkind" role="radiogroup" aria-label="Tipo de entrega">${TASK_KINDS.map(k=>`<button type="button" role="radio" class="ntkind-b${k===ntKind?' on':''}" aria-checked="${k===ntKind}" data-ntkind="${k}">${esc(KIND_LABEL[k])}</button>`).join('')}</div>
    <div class="ntkind-card"><span class="ntkind-team">${esc(KIND_TEAM[ntKind])}: ${st.map(s=>esc(s.label)).join(' → ')}</span>
    <span class="ntkind-est"><b>${st.length} etapas</b> · ${esc(typeof fmtCostRange==='function'?fmtCostRange(lo,hi):'')} · teto ${esc(cicUsdBr(cap))} <button type="button" class="lnk" id="ntKindCap" aria-expanded="${ntKindBudgetOpen}">mudar</button></span>
    <span class="dim ntkind-locks">você aprova duas vezes: o plano e a entrega</span>
    ${ntKindBudgetOpen&&typeof budgetFieldHtml==='function'?`<div class="ntkind-cap">${budgetFieldHtml('ntKindBudget')}</div>`:''}</div>`;
}
function ntKindPaint(){
  const host=$id('ntKindHost'); if(!host) return;
  host.innerHTML=ntKindCardHtml();
  { const nm=$id('ntModel'); if(nm && !nm.__cicK){ nm.__cicK=1; nm.addEventListener('change', ()=>ntKindPaint()); } } // modelo muda a faixa de preço
  host.querySelectorAll('[data-ntkind]').forEach(b=>b.onclick=()=>{ ntKind=b.dataset.ntkind; ntKindPaint(); });
  host.querySelectorAll('[data-ntkind]').forEach(b=>b.onkeydown=e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return; e.preventDefault(); const i=TASK_KINDS.indexOf(ntKind); ntKind=TASK_KINDS[(i+(e.key==='ArrowRight'?1:-1)+4)%4]; ntKindPaint(); const n=host.querySelector('[data-ntkind="'+ntKind+'"]'); if(n) n.focus(); });
  const c=$id('ntKindCap'); if(c) c.onclick=()=>{ ntKindBudgetOpen=!ntKindBudgetOpen; ntKindPaint(); };
  if(ntKindBudgetOpen && typeof budgetFieldWire==='function'){ budgetFieldWire('ntKindBudget'); const f=$id('ntKindBudget'); if(f) f.addEventListener('change', ()=>ntKindPaint()); }
}
function ntKindReset(){ ntKind='codigo'; ntKindBudgetOpen=false; ntTeamTouched=false; ntKindPaint(); }
// o que vai no payload do new_task (modo Entrega): tipo + teto; a equipe vem do tipo se a pessoa não escolheu outra
function ntKindPayload(payload){
  payload.taskKind=ntKind;
  payload.budgetUsd=(typeof ntBudgetPending!=='undefined'&&ntBudgetPending>0)?ntBudgetPending:costCapDefault();
  if(!ntTeamTouched) payload.workflow=null;
  return payload;
}
