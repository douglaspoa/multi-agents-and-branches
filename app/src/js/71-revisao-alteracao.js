// REVISÃO: "Pedir alteração" + "Chamar outro agente…" (mesa 09/10, _bmad-output/revisao-alteracao/mesa.md).
// UMA caixa (painel no topo da tarefa, nunca modal) aberta do cabeçalho, da Revisão por requisito, do PR, da Central e
// do Time — todos chamam rqOpen(). Pedir alteração = 1 turno na MESMA sessão (fwSendText → talk_task, que no modo
// terminal cai no terminal vivo); "refazer com o time" é opção explícita (rework_task). Chamar outro agente = ETAPA
// EXTRA (invoke extra_stage → src/orchestrator.ts runExtraStage / terminal: term-msg --kind stage).
// O núcleo puro espelha src/revisao-alteracao.ts (fixtures tests/fixtures/revisao-alteracao-golden/ nos dois lados).

// @rq-puro-inicio
const RQ_KINDS=[
  { kind:'design', role:'designer', agentId:'aria', name:'Aria', label:'design', line:'melhora a UI/UX: hierarquia, espaçamento, estados, acessibilidade — com prints de antes e depois',
    persona:'Você cuida de UX/UI, hierarquia visual e acessibilidade.', aliases:['design','designer','ux','ui','ui/ux'] },
  { kind:'revisor', role:'reviewer', agentId:'nyx', name:'Nyx', label:'revisão', line:'revisa de novo: correção, casos de borda e clareza — corrige o que achar',
    persona:'Você revisa correção, segurança, casos de borda e clareza. Aponta o que falta.', aliases:['revisor','reviewer','code-review'] },
  { kind:'qa', role:'tester', agentId:'cobalt', name:'Cobalt', label:'testes', line:'escreve e roda os testes que faltam: caminho principal e casos de borda',
    persona:'Você escreve e roda testes; cobre caminho principal e casos de borda.', aliases:['qa','teste','testes','tester','tests'] },
  { kind:'seguranca', role:'security', agentId:'sentinela', name:'Sentinela', label:'segurança', line:'procura falhas de segurança (entrada, segredos, permissões) e corrige',
    persona:'Você revisa segurança: validação de entrada, segredos no código, permissões, injeção e dependências. Corrige o que for seguro corrigir e explica o resto.', aliases:['seguranca','security','sec'] },
  { kind:'performance', role:'performance', agentId:'pulso', name:'Pulso', label:'performance', line:'acha o que deixa lento (renders, consultas, laços) e otimiza sem mudar o comportamento',
    persona:'Você otimiza desempenho sem mudar comportamento: mede antes, corta trabalho repetido, renders e consultas desnecessárias.', aliases:['performance','perf','desempenho'] },
  { kind:'docs', role:'docs', agentId:'lumen', name:'Lumen', label:'documentação', line:'atualiza a documentação e o README com o que a tarefa mudou',
    persona:'Você escreve documentação concisa com exemplos de uso.', aliases:['docs','doc','documentacao','documentação','readme'] },
];
function rqFold(s){ return String(s==null?'':s).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function rqExtraAgents(catalog){
  const cat=Array.isArray(catalog)?catalog:[];
  return RQ_KINDS.map(k=>{
    const a=cat.find(x=>x&&x.id===k.agentId)||cat.find(x=>x&&rqFold(x.role)===k.role);
    return a ? { id:a.id, name:a.name||k.name, role:k.role, kind:k.kind, line:k.line, persona:String(a.persona||k.persona), engine:a.engine, model:a.model }
      : { id:k.agentId, name:k.name, role:k.role, kind:k.kind, line:k.line, persona:k.persona };
  });
}
function rqResolveAgent(catalog, query){
  const q=rqFold(query); if(!q) return null;
  const list=rqExtraAgents(catalog);
  return list.find(a=>rqFold(a.id)===q||rqFold(a.name)===q)
    || list.find(a=>RQ_KINDS.find(k=>k.kind===a.kind).aliases.some(x=>rqFold(x)===q)) || null;
}
function rqExtraLabel(kind){ const k=RQ_KINDS.find(x=>x.kind===kind); return k?k.label:kind; }
function rqIsUiPath(p){
  const s=String(p==null?'':p).toLowerCase();
  if(/\.(css|scss|sass|less|styl|html?|svg|png|jpe?g|gif|webp|ico|jsx|tsx|vue|svelte|astro|mdx?)$/.test(s)) return true;
  return /(^|\/)(\.cardume|styles?|css|components?|ui|views?|pages?|screens?|layouts?|templates?|assets|public|static|theme|i18n|locales?|frontend|client|web)\//.test(s);
}
function rqOutsideUi(files){ return (files||[]).filter(f=>!rqIsUiPath(f)); }
/** ≡ changeRequestText (src/revisao-alteracao.ts): a mensagem ÚNICA de um pedido de alteração. */
function rqChangeText(r){
  r=r||{}; const text=String(r.text==null?'':r.text).trim(); if(!text) return '';
  const reqs=(r.reqs||[]).filter(x=>x&&String(x.text==null?'':x.text).trim());
  const att=(r.attachments||[]).map(x=>String(x==null?'':x).trim()).filter(Boolean);
  const L=['PEDIDO DE ALTERAÇÃO (revisão humana): '+text];
  if(reqs.length) L.push('Requisitos afetados: '+reqs.map(x=>`R${x.i+1} “${String(x.text).trim().slice(0,140)}”`).join('; ')+' — atualize a prova deles no requirements.json.');
  if(att.length) L.push('Anexos (leia antes de mexer): '+att.join(', '));
  L.push('Continue nesta mesma branch, sem recomeçar: faça só o que foi pedido e diga em uma linha o que mudou.');
  return L.join('\n');
}
/** ≡ changeGate: dá pra pedir alteração / chamar agente agora? */
function rqChangeGate(t){
  const s=String((t&&t.status)||'');
  if((t&&t.busy) || ['running','thinking','queued'].includes(s)) return { ok:false, why:'o agente está trabalhando nesta tarefa — espere o turno acabar' };
  if(s==='plan-review') return { ok:false, why:'o plano ainda espera a sua aprovação' };
  if(['draft','cancelled'].includes(s)) return { ok:false, why:'a tarefa ainda não rodou' };
  return { ok:true, why:'' };
}
/** ≡ extraCapGate: a etapa extra só começa abaixo de 80% do teto. */
function rqCapGate(spentUsd, capUsd){
  const cap=+capUsd>0?+capUsd:5, spent=+spentUsd||0;
  if(spent>=cap*0.8-1e-9){ const brl=n=>'US$ '+(Math.round(n*100)/100).toFixed(2).replace('.',',');
    return { ok:false, why:`a tarefa já usou ${brl(spent)} de ${brl(cap)} (${Math.round(spent/cap*100)}% do teto) — libere mais teto antes de chamar outro agente` }; }
  return { ok:true, why:'' };
}
/** ≡ extraReportLines: as linhas do Relatório Starfork ("Passou pelo agente de design (Aria): …"). */
function rqExtraReportLines(extras){
  const mdc=s=>String(s==null?'':s).replace(/\|/g,'\\|').replace(/\s+/g,' ').trim();
  return (extras||[]).filter(s=>s.status!=='rodando').map(s=>{
    const n=(s.files||[]).length;
    const tail=s.status==='falhou'?'não terminou':`${n} ${n===1?'arquivo':'arquivos'}`;
    const out=(s.outsideUi&&s.outsideUi.length)?` (${s.outsideUi.length} fora de tela: ${s.outsideUi.slice(0,3).map(f=>'`'+mdc(f)+'`').join(', ')})`:'';
    return `**Passou pelo agente de ${rqExtraLabel(s.kind)} (${mdc(s.name)}):** ${s.summary?mdc(s.summary)+' — ':''}${tail}${out}`;
  });
}
/** A tarefa está "pronta pra revisar" (onde as duas ações aparecem). */
function rqCanAsk(t){ return !!t && ['review','delivered'].includes(t.status) && !t._cross; }
/** HTML do painel (puro: tudo entra por `d`). d: { id, mode, text, note, reqs:[{i,text,on}], agents, agent, team, gate, cap:{ok,why,spent,capUsd}, sending, pendN } */
function rqPanelHtml(d){
  const usd=n=>'US$ '+(Math.round((+n||0)*100)/100).toFixed(2).replace('.',',');
  const tab=(m,l)=>`<button type="button" role="tab" class="rqp-tab${d.mode===m?' on':''}" aria-selected="${d.mode===m}" data-rqmode="${m}">${l}</button>`;
  const head=`<div class="rqp-head"><div class="rqp-tabs" role="tablist" aria-label="o que fazer com a entrega">${tab('alt','Pedir alteração')}${tab('agente','Chamar outro agente')}</div><span class="rqp-sp"></span><button type="button" class="btn sm ghost rqp-x" data-rqclose aria-label="fechar o painel">fechar</button></div>`;
  const block=!d.gate.ok?`<p class="rqp-warn" role="status">${esc(d.gate.why)}</p>`:'';
  if(d.mode==='agente'){
    const ag=d.agents.find(a=>a.id===d.agent)||null;
    const cards=d.agents.map(a=>`<button type="button" role="radio" class="rqp-ag${a.id===d.agent?' on':''}" aria-checked="${a.id===d.agent}" data-rqag="${escA(a.id)}"><span class="rqp-agn"><b>${esc(a.name)}</b><span class="rqp-agk">${esc(rqExtraLabel(a.kind))}</span></span><small>${esc(a.line)}</small></button>`).join('');
    const capTx=`Gasto até agora ${usd(d.cap.spent)} de ${usd(d.cap.capUsd)} (teto da tarefa)`;
    const why=!d.gate.ok?'':!d.cap.ok?`<p class="rqp-warn" role="status">${esc(d.cap.why)}</p>`:'';
    const dis=(!d.gate.ok||!d.cap.ok||!ag||d.sending)?' disabled':'';
    return `${head}<div class="rqp-body"><p class="rqp-lead">Quem passa pela entrega antes de você aprovar? Roda nesta mesma branch, entra como etapa na faixa e volta pra revisão com o que mudou destacado.</p>${block}
      <div class="rqp-ags" role="radiogroup" aria-label="agentes do time">${cards}</div>
      <label class="rqp-lbl" for="rqNote">O que ${ag?esc(ag.name):'o agente'} deve olhar? <small>(opcional)</small></label>
      <textarea id="rqNote" class="in" rows="2" data-rqin="note" placeholder="${ag&&ag.kind==='design'?'ex.: a tela de horários está apertada no celular':'ex.: foque no fluxo de pagamento'}">${esc(d.note||'')}</textarea>
      ${why}<div class="rqp-foot"><span class="rqp-how">${esc(capTx)}</span><button type="button" class="btn primary" id="rqRun"${dis}>${d.sending?'chamando…':ag?'Chamar '+esc(ag.name):'Escolha um agente'}</button></div></div>`;
  }
  const reqs=d.reqs.length?`<fieldset class="rqp-reqs"><legend>Requisitos afetados <small>(opcional — o aceite deles é desfeito)</small></legend>${d.reqs.map(r=>`<label class="rqp-req"><input type="checkbox" data-rqreq="${r.i}"${r.on?' checked':''}><span>R${r.i+1} ${esc(r.text)}</span></label>`).join('')}</fieldset>`:'';
  const dis=(!d.gate.ok||d.sending)?' disabled':'';
  return `${head}<div class="rqp-body">${block}
    <label class="rqp-lbl" for="rqTx">O que mudar?</label>
    <textarea id="rqTx" class="in" rows="3" data-rqin="text" placeholder="ex.: o botão some no celular; deixa o título menor e alinhado à esquerda">${esc(d.text||'')}</textarea>
    <div class="rqp-att"><button type="button" class="btn sm" id="rqAttach">anexar print ou arquivo</button><button type="button" class="btn sm ghost" data-rqmira title="abre a Prévia: marque o elemento na tela (mira) e mande pro agente">marcar na tela</button><span class="rqp-hint">⌘V cola um print</span><div class="attrow" id="rqPend"></div></div>
    ${reqs}
    <label class="rqp-team"><input type="checkbox" data-rqteam${d.team?' checked':''}><span>refazer com o time inteiro <small>— planeja, constrói e revisa de novo; mais caro e demorado</small></span></label>
    <div class="rqp-foot"><span class="rqp-how">${d.team?'O time inteiro roda de novo nesta branch.':'Vai pro agente desta tarefa — 1 turno, na mesma sessão e branch.'} <span class="kbd">⌘↵</span></span><button type="button" class="btn primary" id="rqSend"${dis}>${d.sending?'mandando…':'Mandar pro agente'}</button></div></div>`;
}
// @rq-puro-fim

// ---------------------------------------------------------------- estado
// RQ: taskId → estado do painel (open, mode, text, note, reqs, atts, team, agent, sending)
const RQ={};
let rqCatalog=null, rqCatalogBusy=false;
function rqOf(id){
  if(!RQ[id]){ let draft=''; try{ draft=lsGet('rqDraft:'+id)||''; }catch(_){ }
    RQ[id]={ open:false, mode:'alt', text:draft, note:'', reqs:[], atts:[], team:false, agent:'', sending:false }; }
  return RQ[id];
}
function rqSaveDraft(id){ try{ const u=RQ[id]; if(u&&u.text) lsSet('rqDraft:'+id, u.text); else localStorage.removeItem('rqDraft:'+id); }catch(_){ } }
function rqAgents(){
  const cat=(rqCatalog||(state.config&&state.config.agents)||[]);
  if(!rqCatalog && !rqCatalogBusy && typeof invoke==='function'){ rqCatalogBusy=true;
    invoke('config').then(c=>{ rqCatalog=(c&&c.agents)||[]; const t=(typeof fwTaskObj==='function')&&fwTaskObj(); if(t) rqPaint(t, true); }).catch(()=>{ /* tenta de novo na próxima pintura */ }).finally(()=>{ rqCatalogBusy=false; }); }
  return rqExtraAgents(cat);
}
/** O cartão do Time (nuvem) → a tarefa LOCAL dele (se esta máquina tem). */
function rqLocalOfCloud(cloudId){
  try{ const m=(typeof tmap==='function')?tmap():{}; for(const lid in m) if(m[lid]===cloudId){ const t=(state.tasks||[]).find(x=>x.id===lid); if(t) return t; } }catch(_){ }
  return null;
}

/** Abre a caixa (de qualquer lugar). o: { mode:'alt'|'agente', reqs:[i], agent } */
function rqOpen(taskId, o){
  o=o||{};
  const t=(state.tasks||[]).find(x=>x.id===taskId);
  if(!t){ if(typeof crossRun==='function') crossRun(taskId, ()=>rqOpen(taskId, o)); return; }
  if(!rqCanAsk(t)){ toast('pedir alteração e chamar outro agente valem pra tarefa pronta pra revisar','warn'); return; }
  const u=rqOf(taskId); u.open=true; u.mode=o.mode==='agente'?'agente':'alt';
  if(Array.isArray(o.reqs)) u.reqs=[...new Set(o.reqs.concat(u.reqs))];
  if(o.agent) u.agent=o.agent;
  const modes=(typeof fwModesList==='function')?fwModesList(t).map(x=>x[0]):[];
  const mode=modes.includes('revisao')?'revisao':'entrega';
  if(mode==='revisao' && typeof rvViewM!=='undefined') rvViewM[taskId]='req';
  const same=typeof fwTask!=='undefined' && fwTask===taskId && $id('fwOverlay') && $id('fwOverlay').style.display!=='none';
  if(!same) openWorkspace(taskId);
  const tab=(typeof tabById==='function')?tabById('task:'+taskId):null; if(tab) tab.mode=mode;
  fwMode=mode; if(typeof fwRememberTab==='function') fwRememberTab();
  renderWorkspace();
  setTimeout(()=>{ const h=$id('fwRq'); if(h){ h.__sig=''; rqPaint(t, true); h.scrollIntoView&&h.scrollIntoView({ block:'nearest' }); const el=$id(u.mode==='agente'?'rqNote':'rqTx'); if(el&&u.mode!=='agente') el.focus(); else { const b=h.querySelector('[data-rqag][aria-checked="true"]')||h.querySelector('[data-rqag]'); if(b) b.focus(); } } }, 40);
}
function rqClose(taskId){ const u=RQ[taskId]; if(u){ u.open=false; } const t=(state.tasks||[]).find(x=>x.id===taskId); if(t) rqPaint(t, true); }

/** Pinta o painel no slot #fwRq (fora do re-render das colunas: o tick do poll não apaga o rascunho nem o foco). */
function rqPaint(t, force){
  const host=$id('fwRq'); if(!host) return;
  const u=t&&RQ[t.id];
  if(!t || !u || !u.open || (typeof fwTask!=='undefined' && fwTask!==t.id)){ if(!host.hidden){ host.hidden=true; host.innerHTML=''; host.__sig=''; } return; }
  const reqs=(Array.isArray(t.requirements)?t.requirements:[]).map((text,i)=>({ i, text, on:u.reqs.includes(i) }));
  const agents=rqAgents();
  if(u.mode==='agente' && !u.agent){ const d=agents.find(a=>a.kind==='design'); if(d) u.agent=d.id; }
  const spent=(typeof taskCost==='function')?taskCost(t.id).usd:0, capUsd=(typeof budgetOf==='function')?budgetOf(t):5;
  const cg=rqCapGate(spent, capUsd);
  const d={ id:t.id, mode:u.mode, text:u.text, note:u.note, reqs, agents, agent:u.agent, team:u.team, gate:rqChangeGate(t), cap:{ ok:cg.ok, why:cg.why, spent, capUsd }, sending:u.sending };
  const sig=JSON.stringify([d.mode, reqs.map(r=>r.on), agents.map(a=>a.id+a.name), d.agent, d.team, d.gate, cg.ok, Math.round(spent*100), capUsd, d.sending, u.atts.length]);
  if(!force && host.__sig===sig) return;
  const ae=document.activeElement, focusId=ae&&host.contains(ae)?ae.id:'', caret=focusId&&ae.selectionStart!=null?ae.selectionStart:null;
  host.__sig=sig; host.hidden=false;
  host.innerHTML=`<div class="rqp" role="region" aria-label="${u.mode==='agente'?'Chamar outro agente':'Pedir alteração'}">${rqPanelHtml(d)}</div>`;
  rqWire(host, t);
  if(focusId){ const el=$id(focusId); if(el){ el.focus(); if(caret!=null&&el.setSelectionRange){ try{ el.setSelectionRange(caret, caret); }catch(_){ } } } }
}
function rqWire(host, t){
  const u=rqOf(t.id);
  host.oninput=(e)=>{ const k=e.target.dataset&&e.target.dataset.rqin; if(k==='text'){ u.text=e.target.value; rqSaveDraft(t.id); } else if(k==='note') u.note=e.target.value; };
  host.onchange=(e)=>{ const x=e.target;
    if(x.dataset.rqreq!=null){ const i=+x.dataset.rqreq; u.reqs=x.checked?[...new Set(u.reqs.concat(i))]:u.reqs.filter(j=>j!==i); rqPaint(t); }
    else if(x.dataset.rqteam!=null){ u.team=x.checked; rqPaint(t, true); } };
  host.onkeydown=(e)=>{ if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); if(u.mode==='agente') rqRun(t); else rqSend(t); }
    else if(e.key==='Escape'){ e.stopPropagation(); rqClose(t.id); } };
  host.onclick=(e)=>{ const b=e.target.closest('button'); if(!b) return; const d=b.dataset;
    if(d.rqmode){ u.mode=d.rqmode; rqPaint(t, true); return; }
    if(d.rqclose!=null){ rqClose(t.id); return; }
    if(d.rqag){ u.agent=d.rqag; rqPaint(t, true); return; }
    if(d.rqmira!=null){ fwMode='previa'; if(typeof fwRememberTab==='function') fwRememberTab(); renderWorkspace(); toast('Ligue a mira (⌖) na Prévia, marque o elemento e mande — vai pro mesmo agente.','info'); return; }
    if(b.id==='rqSend') rqSend(t); else if(b.id==='rqRun') rqRun(t); };
  if(typeof attWireComposer==='function') attWireComposer({ input:'rqTx', attach:'rqAttach', pend:()=>u.atts, taskId:()=>t.id, rerender:()=>rqPaint(t, true) });
  if(typeof attRenderPend==='function') attRenderPend('rqPend', u.atts, ()=>rqPaint(t, true));
}

// ---------------------------------------------------------------- ações
async function rqSend(t){
  const u=rqOf(t.id); if(u.sending) return; const g=rqChangeGate(t); if(!g.ok){ toast(g.why,'warn'); return; }
  const all=Array.isArray(t.requirements)?t.requirements:[];
  const text=rqChangeText({ text:u.text, reqs:u.reqs.filter(i=>i<all.length).map(i=>({ i, text:all[i] })), from:'app' });
  if(!text){ const el=$id('rqTx'); if(el) el.focus(); toast('escreva o que mudar','warn'); return; }
  const full=text+((typeof attPromptBlock==='function')?attPromptBlock(u.atts):'');
  if(u.team && !await askYes('O time inteiro roda de novo nesta branch (planeja, constrói e revisa) — custa mais que um ajuste.', 'Refazer com o time inteiro?')) return;
  u.sending=true; rqPaint(t, true);
  const sent=u.text; let ok=false;
  try{
    if(u.team){ await invoke('rework_task',{ taskId:t.id, text:full }); ok=true; lastSig=''; refresh().catch(()=>{}); }
    else ok=await fwSendText(t.id, full);
  }catch(e){ showErr(e, 'Não deu pra mandar o pedido'); }
  u.sending=false;
  if(ok){
    // requisito marcado = o aceite dele não vale mais (o agente vai mexer nele)
    try{ const st=(typeof rvSt!=='undefined')?rvSt[t.id]:null;
      if(st&&st.acc){ let ch=false; for(const i of u.reqs){ const k=rvNorm(all[i]); if(st.acc[k]){ delete st.acc[k]; ch=true; } } if(ch) await rvStSave(t.id); } }catch(_){ }
    const cur=rqOf(t.id); RQ[t.id]={ ...cur, open:cur.text!==sent, text:cur.text===sent?'':cur.text, reqs:[], atts:[], team:false }; rqSaveDraft(t.id); // digitou durante o envio: fica
    Object.assign(u, RQ[t.id]);
    toast(u.team?'o time inteiro voltou a trabalhar nesta branch':'pedido enviado — o agente volta a trabalhar nesta mesma branch','ok');
  }
  rqPaint(t, true);
}
async function rqRun(t){
  const u=rqOf(t.id); if(u.sending) return; const ag=rqAgents().find(a=>a.id===u.agent); if(!ag){ toast('escolha um agente','warn'); return; }
  const g=rqChangeGate(t); if(!g.ok){ toast(g.why,'warn'); return; }
  const cg=rqCapGate(taskCost(t.id).usd, budgetOf(t)); if(!cg.ok){ toast(cg.why,'warn'); return; }
  u.sending=true; rqPaint(t, true);
  try{ await invoke('extra_stage',{ taskId:t.id, agent:ag.id, note:String(u.note||'').trim()||null });
    u.open=false; u.note='';
    toast(`chamando ${ag.name} (${rqExtraLabel(ag.kind)}) — entra na faixa como etapa e volta pra revisão com o que mudou destacado; se algo impedir, o motivo aparece na conversa`,'ok');
    lastSig=''; refresh().catch(()=>{});
  }catch(e){ showErr(e, 'Não deu pra chamar o agente'); }
  u.sending=false; rqPaint(t, true);
}

// ---------------------------------------------------------------- o que a etapa extra mudou (Revisão)
const rqFilesOpen={}; // stageId → lista aberta
/** Faixa no topo da Revisão: "Passou por Aria (design)" + arquivos (os fora de tela em vermelho) + prints antes/depois. */
function rqExtraBandHtml(t){
  const ex=(((t&&t.spec)||{}).extraStages)||[]; if(!ex.length) return '';
  const arts=(typeof entregaArts==='function')?entregaArts(t):[];
  const more=ex.length>3?`<p class="rqx-more dim">+ ${nPl(ex.length-3,'etapa anterior','etapas anteriores')} — veja na faixa de etapas</p>`:'';
  return `<div class="rqx-list">${ex.slice(-3).reverse().map(s=>{
    const n=(s.files||[]).length, out=new Set(s.outsideUi||[]);
    const st=s.status==='rodando'?'<span class="rvtag info">trabalhando…</span>':s.status==='falhou'?'<span class="rvtag wn">não terminou</span>':`<span class="rvtag">${nPl(n,'arquivo')}</span>`;
    const warn=out.size?`<span class="rvtag bad" title="${escA([...out].join('\n'))}">${nPl(out.size,'arquivo')} fora de tela</span>`:'';
    const open=!!rqFilesOpen[s.id];
    const files=open&&n?`<ul class="rqx-files">${s.files.map(f=>`<li class="${out.has(f)?'out':''}"><button type="button" class="lnk mono" data-rqfile="${escA(f)}" data-rqtask="${escA(t.id)}">${esc(f)}</button>${out.has(f)?'<span class="rqx-outtag">fora de tela — confira se é lógica</span>':''}</li>`).join('')}</ul>`:'';
    const shots=s.kind==='design'?['antes','depois'].map(w=>{ const a=arts.find(x=>new RegExp('^design-'+w+'[-_.]','i').test(x.name)); if(!a) return ''; const th=(typeof artThumb==='function')?artThumb(t.id, a.name):null; return `<figure class="rqx-shot"><button type="button" class="rvshot" data-rqart="${escA(a.name)}" data-rqtask="${escA(t.id)}" aria-label="${escA('abrir o print '+w)}">${th?`<img src="${escA(th)}" alt="">`:`<span class="rvshot-ph">${IC.image}</span>`}</button><figcaption>${w}</figcaption></figure>`; }).join(''):'';
    return `<div class="rqx${s.status==='rodando'?' run':''}"><div class="rqx-row"><b>${s.status==='rodando'?`${esc(s.name)} (${esc(rqExtraLabel(s.kind))}) está passando pela tarefa`:`Passou por ${esc(s.name)} (${esc(rqExtraLabel(s.kind))})`}</b>${st}${warn}${s.summary?`<span class="rqx-sum">${esc(s.summary)}</span>`:''}<span class="rvsp"></span>${n?`<button type="button" class="btn sm" data-rqfiles="${escA(s.id)}" data-rqtask="${escA(t.id)}" aria-expanded="${open}">${open?'esconder':'ver o que mudou'}</button>`:''}</div>${shots?`<div class="rqx-shots">${shots}</div>`:''}${files}</div>`;
  }).join('')}${more}</div>`;
}

// ---------------------------------------------------------------- um clique em qualquer lugar (Central, Time, PR, Revisão)
document.addEventListener('click', (e)=>{
  const b=e.target.closest&&e.target.closest('[data-rqopen],[data-rqcall],[data-rqfiles],[data-rqfile],[data-rqart]'); if(!b) return;
  const d=b.dataset;
  if(d.rqopen){ e.stopPropagation(); rqOpen(d.rqopen, { reqs:d.rqreqs!=null&&d.rqreqs!==''?String(d.rqreqs).split(',').map(Number):undefined }); return; }
  if(d.rqcall){ e.stopPropagation(); rqOpen(d.rqcall, { mode:'agente' }); return; }
  if(d.rqfiles){ rqFilesOpen[d.rqfiles]=!rqFilesOpen[d.rqfiles]; if(typeof rvRerender==='function') rvRerender(d.rqtask); return; }
  if(d.rqfile){ openWorkspace(d.rqtask, d.rqfile); return; }
  if(d.rqart && typeof openArtifact==='function'){ openArtifact(d.rqtask, d.rqart); }
}, true);
