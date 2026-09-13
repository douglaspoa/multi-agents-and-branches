// Constellation — 26-sidebar-projetos
// ---- sidebar por PROJETO (redesign p2): sessões de TODOS os repos salvos ----
let projOv=null, projOvAt=0;
async function railProjTick(){
  if(!connected) return;
  if(projOv && Date.now()-projOvAt<60000) return;
  try{ projOv=await invoke('projects_overview'); projOvAt=Date.now(); renderRailProj(); }catch(_){ }
}
function renderRailProj(){ safe(renderRail); } // a visão por projeto agora É a sidebar

function renderFeed(){
  const el = $id("feed");
  const evs = state.events.slice(-200);
  if(evs.length===0){ el.innerHTML = '<div class="empty">aguardando eventos…</div>'; return; }
  el.innerHTML = evs.map(e=>{
    const g = GLYPH[e.type]||"·";
    const gc = GCOLOR[e.type]||"var(--muted)";
    return `<div class="fl">
      <span class="ts">${fmtTime(e.ts)}</span>
      <span class="ag" style="color:var(--text-2)">${esc(e.agent)}</span>
      <span class="gl" style="color:${gc}">${g}</span>
      <span class="tx">${esc(e.text)}</span>
    </div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

// Stepper vertical das etapas da tarefa — mostra "em que pé está".
function stageStepper(t){
  const roles=t.roles||[];
  if(!roles.length) return "";
  const finished=(t.status==='review'||t.status==='merged'||t.status==='done');
  let curIdx=roles.findIndex(r=>r.role===t.stage); if(curIdx<0) curIdx=0;
  const ev=lastEventOf(t.id);
  const steps=roles.map((r,i)=>{
    let cls;
    if(finished || i<curIdx) cls='done';
    else if(i===curIdx) cls=(t.status==='error'?'err':(ACTIVE_ST.has(t.status)?'cur':'wait'));
    else cls='wait';
    const mark = cls==='done'?IC.check : cls==='err'?'!' : cls==='cur'?'<span class="spin"></span>' : (i+1);
    const sub = (cls==='cur' && ev) ? `<div class="sact">${esc((GLYPH[ev.type]||'·')+' '+ev.text)}</div>` : '';
    const view = r.role==='planner'?'<span class="sview">ver plano ›</span>' : r.role==='designer'?'<span class="sview">ver design ›</span>' : '';
    return `<div class="step ${cls}" data-role="${escA(r.role)}" data-name="${escA(r.name)}"><span class="smark">${mark}</span><div class="stx"><span class="srole">${ROLE_PT[r.role]||r.role}${view}</span><span class="sname">${esc(r.name)}</span>${sub}</div></div>`;
  }).join("");
  return `<div class="seclbl" style="margin-top:13px">Etapas</div><div class="stepper">${steps}</div>`;
}
// motor REAL exibido: o do papel da etapa atual (o campo t.engine é só fallback
// e pode ficar "mock" quando a tarefa foi criada por workflow sem --engine).
function effEngine(t){ const rs=t.roles||[]; const cur=rs.find(r=>r.role===t.stage); return (cur&&cur.engine)||(rs[0]&&rs[0].engine)||t.engine||'mock'; }
let sideTab='etapas';
document.addEventListener('click', e=>{ if(stMenuOpen && !e.target.closest('.stwrap')){ stMenuOpen=false; try{ renderSide(); }catch(_){} } });
function fmtDur(ms){ ms=Math.max(0,ms); const s=Math.floor(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60); if(m<60) return m+' min'; const h=Math.floor(m/60); return h+'h'+String(m%60).padStart(2,'0'); }
// MODO DESIGN (estilo Claude Design): diagnóstico → perguntas com opções
// concretas → iterações curtas com preview ao vivo → aprovação do humano.
const DESIGN_PROMPT = 'MODO DESIGN — refine o VISUAL desta entrega comigo, agindo como um designer sênior de produto:\n'
  +'1) Suba o ambiente (siga o .cardume/RUNBOOK.md) e ANUNCIE "🌐 preview: <url da tela em questão>" pra eu acompanhar ao vivo (também vejo do celular).\n'
  +'2) Faça um DIAGNÓSTICO visual objetivo da tela atual: hierarquia, espaçamento, tipografia, cores, estados vazios, consistência com o design system JÁ EXISTENTE no projeto (procure tokens/tema/componentes antes de inventar). Liste os 3 piores problemas em ordem.\n'
  +'3) ANTES de mexer, pergunte via mcp__cardume__ask_human O QUE PRIORIZAR — sempre com OPÇÕES CONCRETAS e mutuamente exclusivas (ex.: "mais denso ou mais respiro?", "seguir a paleta da tela X ou propor nova?", "manter esse layout e polir, ou redesenhar o bloco?"). NUNCA pergunta genérica tipo "o que você quer mudar?". Se referência visual ajudar, peça um print/link.\n'
  +'4) Aplique em ITERAÇÕES CURTAS: UM ajuste por vez, re-anuncie o preview depois de cada um e pergunte via ask_human "melhorou? sigo pro próximo?" com opções (aprovar / ajustar isso / voltar atrás).\n'
  +'5) Só finalize quando eu disser explicitamente que o design está bom. Ao final, resuma o que mudou e atualize os artefatos de prova (screenshot antes/depois).';

// SKILLS DO CHAT: digite "/" e escolha — cada uma é um prompt lapidado.
const CHAT_SKILLS=[
  { id:'design',     label:'design', desc:'refinar o visual comigo — diagnóstico, opções e iterações com preview', prompt:()=>DESIGN_PROMPT },
  { id:'preview',    label:'preview', desc:'subir o ambiente e me dar o link ao vivo', prompt:()=>'Suba o ambiente local desta branch AGORA (siga o .cardume/RUNBOOK.md) e ANUNCIE "🌐 preview: <url da tela desta tarefa>". Mantenha rodando e re-anuncie se trocar de página.' },
  { id:'requisitos', label:'requisitos', desc:'verificar cada requisito e gerar as provas', prompt:()=>'Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json. Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar.' },
  { id:'testes',     label:'testes', desc:'rodar a suíte real e anexar a saída', prompt:()=>'Rode os testes REAIS na suíte do projeto pra esta branch (comandos do .cardume/RUNBOOK.md). Salve .cardume/artifacts/tests.md com os comandos e a SAÍDA literal. Falhou algo? Investigue a causa e corrija antes de me responder.' },
  { id:'provas',     label:'provas', desc:'provar na UI real com screenshots', prompt:()=>'Prove que a entrega funciona NA UI REAL: suba o ambiente (RUNBOOK), execute o fluxo desta tarefa de ponta a ponta e capture screenshots reais em .cardume/artifacts/ (antes/depois quando fizer sentido). Anuncie o 🌐 preview enquanto estiver de pé.' },
  { id:'resumo',     label:'resumo', desc:'estado atual em 1 minuto de leitura', prompt:()=>'Me dê um resumo executivo do estado ATUAL desta tarefa: o que já foi feito (com os arquivos), o que falta, riscos/decisões em aberto. NÃO execute nada novo — só leia e resuma.' },
  { id:'seguranca',  label:'segurança', desc:'auditar riscos no diff da branch', prompt:()=>'Audite o diff desta branch (contra a base) com olhar de segurança: injeção, authz/escopo de tenant, segredos expostos, dados sensíveis em log. Liste os achados por severidade com arquivo:linha e a correção proposta. NÃO corrija ainda — me apresente primeiro via ask_human.' },
];

// URL de preview mais recente que o agente anunciou ('🌐 preview: http://…')
function taskPreviewUrl(taskId){
  const evs=state.events||[];
  for(let i=evs.length-1;i>=0;i--){
    const e=evs[i]; if((e.taskId||e.task_id)!==taskId) continue;
    const m=(e.text||'').match(/🌐 preview:\s*(https?:\/\/[^\s'"”)]+)/);
    if(m) return m[1];
  }
  return null;
}
// túnel criptografado → publica no cartão da nuvem → o app do celular mostra o botão
async function mobilePreview(taskId, url, silent){
  try{
    // tunnel_start já faz o health-check (DNS + conector) e só retorna URL viva
    let pub=await invoke('tunnel_start',{ taskId, url });
    // o túnel é da ORIGEM — devolve o caminho/subpágina anunciados na URL pública
    try{ const u=new URL(url); pub=pub.replace(/\/$/,'')+u.pathname+u.search; }catch(_){ }
    const cid=tmap()[taskId];
    if(cid && SB.sess()){
      try{
        const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{};
        await sbFetch('/rest/v1/tasks?id=eq.'+cid, { method:'PATCH', body: JSON.stringify({ spec: { ...(cur.spec||{}), previewUrl: pub, tunnelWanted: null } }) });
        sbPost('task_feed',{ task_id:cid, agent:'Sistema', kind:'note', text:'📱 preview no celular: '+pub }).catch(()=>{});
      }catch(_){ }
    }
    return pub;
  }catch(e){ if(!silent) alert('Túnel falhou:\n'+(e.message||e)); return null; }
}
function renderSide(){
  const el = $id("side");
  const t = state.tasks.find(x=>x.id===selected);
  if(!t){ el.innerHTML = '<div class="empty">selecione uma tarefa</div>'; return; }
  // preserva foco/caret de inputs do painel entre re-renders (pra digitar sem perder)
  const ae=document.activeElement, aeId=(ae&&el.contains(ae)&&ae.id)?ae.id:null, aeVal=aeId?ae.value:null, aeCaret=(aeId&&ae.selectionStart!=null)?ae.selectionStart:null;
  // preserva a posição do scroll do corpo (senão o poll de 1s joga tudo pro topo)
  const sbPrev=el.querySelector('.sidebody'), sbTop=sbPrev?sbPrev.scrollTop:0;
  const col = STATUS_COLOR[t.status]||"var(--muted)";
  const claims = claimsOf(t.id);
  const d = diffOf(t.id);
  const evs = eventsOf(t.id);
  const rev = reviewOf(t.id);
  const tc = taskCost(t.id);
  const fc = fileCache[t.id], files = fc?fc.list:[];
  const t0 = evs.length?evs[0].ts:t.created_at;
  const t1 = ACTIVE_ST.has(t.status)?Date.now():(evs.length?evs[evs.length-1].ts:Date.now());
  const dur = fmtDur(t1-t0);
  const tot = d ? (d.additions+d.deletions)||1 : 1;

  // ---- conteúdo SÓ da aba ativa ----
  // Antes montávamos as 4 abas a cada render; as abas Diff/Briefing disparam
  // loads de rede/subprocesso (pr_status via gh, task_files, commits, artifacts),
  // então TROCAR de tarefa disparava tudo isso mesmo na aba Etapas → lentidão.
  // Agora só a aba ativa é construída (e só ela dispara seus loads).
  const TABS=[['etapas','Etapas'],['stream','Stream'],['entregas','Entregas'],['pr','PR'],['briefing','Briefing']];
  let content;
  if(sideTab==='stream'){
    content = `<div class="log stream">${evs.length?evs.map(e=>`<div class="ln"><span class="ts">${fmtTime(e.ts)}</span><span style="color:${GCOLOR[e.type]||'var(--muted)'}">${GLYPH[e.type]||'·'}</span><span>${esc(e.text)}</span></div>`).join(""):'<span class="dim">sem eventos ainda…</span>'}${ACTIVE_ST.has(t.status)?'<div class="ln livecursor"><span class="ts"></span><span style="color:var(--good)">▸</span><span class="blink">▍</span></div>':''}</div>`;
  } else if(sideTab==='entregas'){
    const dels=Array.isArray(t.deliverables)?t.deliverables.filter(Boolean):[];
    content = `
    ${reqsBlock(t)}
    ${dels.length?`<div class="seclbl">Entregáveis <span class="n">${dels.length}</span></div>${dels.map(d=>`<div class="critrow2 na"><span class="reqst na">·</span><div class="crt">${esc(d)}</div></div>`).join('')}`:''}
    ${artifactsBlock(t)}
    ${cloudProofsBlock(t)}
    ${deliverBlock(t)}`;
  } else if(sideTab==='pr'){
    content = prBlock(t, true);
  } else if(sideTab==='briefing'){
    const claimHtml = claims.length ? claims.map(c=>{const y=c.yieldedTo;return `<div class="claim${y?" y":""}"><span>${esc(c.path)}</span><span class="m">${y?("cedeu → "+esc(y)):esc(c.mode)}</span></div>`;}).join("") : '<div class="dim" style="font-size:11.5px">nenhuma reivindicação</div>';
    const reqs = Array.isArray(t.requirements)?t.requirements:[];
    const orig=t.linkedTo?(state.tasks||[]).find(x=>x.id===t.linkedTo):null;
  const fixes=(state.tasks||[]).filter(x=>x.linkedTo===t.id);
  const linksHtml=(orig||fixes.length)?`<div class="seclbl">Ligações</div><div class="linkrows">${orig?`<button class="linkrow" data-linksel="${escA(orig.id)}">${IC.clip} corrige → <b>${esc(orig.title)}</b><span class="dim" style="margin-left:auto;font-size:10px">${esc(orig.status)}</span></button>`:''}${fixes.map(f=>`<button class="linkrow" data-linksel="${escA(f.id)}">${IC.clip} correção ← <b>${esc(f.title)}</b><span class="dim" style="margin-left:auto;font-size:10px">${esc(f.status)}</span></button>`).join('')}</div>`:'';
  const reviewPrHtml = (t.kind==='review' && t.prUrl) ? `<div class="seclbl">Pull Request revisado</div><div class="prreview"><span class="prnum">${esc(t.branch)}</span><button class="btn sm" id="revPrOpen">${IC.ext||'↗'} abrir PR</button></div>` : '';
    content = `
    <div class="card"><div class="t">${esc(t.title)}</div><div class="o">${esc(t.objective)}</div></div>
    ${linksHtml}
    ${reviewPrHtml}
    ${refsBlock(t)}
    ${prBlock(t)}
    ${costBlock(t.id)}
    ${commitsBlock(t.id)}
    <div class="seclbl">Arquivos reivindicados <span class="n">${claims.length}</span></div>${claimHtml}`;
  } else {
    content = `
    ${t.kind!=='review'?`<button class="btn sm wide wsopen" id="openWs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M2.5 3.5h11c.3 0 .5.2.5.5v8c0 .3-.2.5-.5.5h-11c-.3 0-.5-.2-.5-.5V4c0-.3.2-.5.5-.5z"/><path d="M6 3.5v9M9.2 6.8l1.6 1.2-1.6 1.2" stroke-linecap="round" stroke-linejoin="round"/></svg> Abrir no editor — arquivos · código · chat</button>`:''}
    ${(()=>{const pv=taskPreviewUrl(t.id); if(!pv) return ''; const up=tunnelUp[t.id];
      return `<div style="display:flex;gap:6px;margin-top:6px"><button class="btn sm" id="pvOpen" data-url="${escA(pv)}" title="${escA(pv)}" style="flex:1;color:var(--accent)">${IC.globe} abrir preview — ${esc(pv.replace(/^https?:\/\//,'').slice(0,34))}</button>`+
        (up?`<button class="btn sm" id="pvMobileOff" title="fecha o túnel agora (${escA(up)})" style="color:var(--warn)">${IC.phone} fechar acesso</button>`
           :`<button class="btn sm" id="pvMobile" data-url="${escA(pv)}" title="cria um túnel criptografado (URL https aleatória) pra abrir este preview no seu celular">${IC.phone} celular</button>`)+`</div>`;})()}
    ${activityBlock(t)}
    ${stageStepper(t)}
    ${questionBlock(t.id)}
    ${t.status==='plan-review' ? `<div class="instrbox" style="border-color:var(--warn);background:color-mix(in srgb,var(--warn) 8%,var(--surface-2))"><div class="ilbl" style="color:var(--warn)">${IC.check} Plano pronto — revise e aprove</div><div class="ihint">Clique em <b>ver plano</b> na etapa acima pra revisar/editar. Quando estiver bom:</div><div class="irow" style="margin-top:8px"><button class="btn primary sm" data-act="approveplan">${IC.cright} Aprovar plano e continuar</button></div></div>`:''}
    ${((ACTIVE_ST.has(t.status)||['review','error','aborted','conflict'].includes(t.status)) && (t.roles||[]).some(r=>r.engine==='claude')) ? `<div class="instrbox"><div class="ilbl">${IC.ai} Conversar com o agente</div><div class="ihint">${ACTIVE_ST.has(t.status)?'Ele está trabalhando — abra o chat pra acompanhar, <b>parar</b> e dar outra instrução.':'Abra o chat pra pedir ajustes — ele <b>retoma a mesma sessão</b> (lembra o que fez).'}</div><div class="irow"><button class="btn primary sm" id="openChatBtn">${IC.ai} abrir chat com ${esc(t.agent)}${ACTIVE_ST.has(t.status)?' (ao vivo)':''}</button></div>${['review','error','aborted','conflict'].includes(t.status)?`<div class="dim" style="font-size:10.5px;margin-top:6px">Refazer do zero pelo time todo? <a class="lnk" id="rwFull">pedir ajuste completo (planeja → coda → revisa → docs)</a></div>`:''}</div>`:''}`;
  }

  // rodapé: ações conforme o estado. Para tarefas VIVAS, pausar/abortar de
  // verdade (encerram o processo do agente) em vez do antigo "cancelar" que só
  // apagava a linha e deixava o processo rodando fantasma.
  // Rodapé: UMA barra alinhada — utilidades discretas à esquerda,
  // destrutiva + ação primária à direita.
  const flagBtns = t.flag==='blocked' ? `<button class="btn sm ghost" data-flag="">${IC.refresh} desbloquear</button>`
    : t.flag==='closed' ? `<button class="btn sm ghost" data-flag="">${IC.refresh} reabrir</button>`
    : `<button class="btn sm ghost" data-flag="blocked">${IC.pause} bloquear</button>${t.status!=='draft'?`<button class="btn sm ghost" data-flag="closed">${IC.checkc} encerrar</button>`:''}`;
  const footInner = (()=>{
    if(t.status==='paused') return `<div class="footcol"><button class="btn primary sm wide" data-act="resume">${IC.cright} retomar</button><div class="acts foot1">${flagBtns}<span class="grow"></span><button class="btn danger sm ghost" data-act="abort">${IC.xs} abortar</button></div></div>`;
    if(ACTIVE_ST.has(t.status)) return `<div class="acts foot1"><button class="btn sm ghost" data-act="pause">${IC.pause} pausar</button>${flagBtns}<span class="grow"></span><button class="btn danger sm ghost" data-act="abort">${IC.xs} abortar</button></div>`;
    const merge=(t.status==='review'&&t.kind!=='review')?`<button class="btn primary sm wide" data-act="merge">${IC.merge} merge na ${esc(t.base)}</button>`:'';
    const start=t.status==='draft'?`<button class="btn primary sm wide" data-act="start">${IC.cright} iniciar</button>`:'';
    const rmlbl=(t.kind==='review'&&t.status==='review')?'concluir'
      :(t.status==='review'||t.status==='draft'||t.status==='aborted'||t.status==='error')?'descartar':'cancelar';
    const wsPush=(t.kind!=='review'&&t.status==='review')?`<button class="btn sm ghost" data-act="wspush" title="abre o editor (arquivos · código · chat) com o botão de commit & push">⇡ revisar &amp; push</button>`:'';
    const rerun=(t.kind!=='review'&&['review','error','aborted','conflict','merged'].includes(t.status))?`<button class="btn sm ghost" data-act="rerun">${IC.refresh} re-rodar</button>`:'';
    const linkfix=(t.kind!=='review'&&['review','merged','error','aborted','conflict'].includes(t.status))?`<button class="btn sm ghost" data-act="linkfix" title="algo quebrou em produção? abre uma correção linkada a esta tarefa">${IC.clip} correção</button>`:'';
    const isDz=(t.branch||'').startsWith('design/'), isInv=(t.branch||'').startsWith('invest/');
    const linkdz=((isDz||isInv)&&['review','merged','error','aborted'].includes(t.status))?`<button class="btn primary sm wide" data-act="linkdz" title="cria a tarefa de Entrega linkada, com os artefatos (${isDz?'mockup + DESIGN.md':'INVESTIGATION.md + evidências'}) anexados como referência obrigatória">${IC.cright} ${isDz?'criar entrega deste design':'criar entrega desta investigação'}</button>`:'';
    const breakdown=(t.kind!=='review'&&['review','merged'].includes(t.status))?`<button class="btn sm ghost" data-act="breakdown" title="a IA lê esta tarefa e os artefatos e propõe sub-tarefas — vira um ÉPICO com cartões no backlog do time">◆ desdobrar em épico</button>`:'';
    const merged=t.status==='merged'?`<span class="mergedtag">${IC.check} merged na ${esc(t.base)}</span>`:'';
    const primary=merge||start;
    return `<div class="footcol">${merged?`<div class="acts">${merged}</div>`:''}${linkdz}${primary}<div class="acts foot1">${wsPush}${breakdown}${rerun}${linkfix}${flagBtns}<span class="grow"></span>${t.status!=='merged'?`<button class="btn danger sm ghost" data-act="rm">${rmlbl}</button>`:''}</div></div>`;
  })();

  el.innerHTML = `<div class="det">
    ${errBanner(t)}
    <div class="sidehead">
      <h2>${esc(t.agent)}</h2>
      <div class="sub"><span id="brnText">${esc(t.branch)}</span>${t.status!=='merged'?` <button class="brnedit" data-act="renbranch" title="renomear branch">${IC.pencil}</button>`:''} · ${esc(effEngine(t))}${t.model?(" · "+esc(t.model)):""}</div>
      ${(t.prUrl||issueCodeOf(t))?`<div style="display:flex;gap:6px;margin-top:7px">${linkChips(t)}</div>`:''}
      <span class="stwrap"><button class="pill stpill" id="stPill" style="color:${col};background:color-mix(in srgb,${col} 15%,transparent)">${esc(t.status)}${t.flag?' · '+(t.flag==='blocked'?'bloqueada':'encerrada'):''} <span class="stchev">▾</span></button>${stMenuOpen?`<div class="stmenu">${statusMenuItems(t).map((it,i)=>`<button class="stitem${it.danger?' danger':''}" data-sti="${i}">${it.l}</button>`).join('')}</div>`:''}</span>
    </div>
    <div class="sidestats"><div class="ss"><span class="ssv">${dur}</span><span class="ssl">tempo</span></div><div class="ss"><span class="ssv">${tc.usd?fmtUsd(tc.usd):'—'}</span><span class="ssl">custo</span></div><div class="ss"><span class="ssv">${files.length||(d?d.files:0)||0}</span><span class="ssl">arquivos</span></div></div>
    <div class="sidetabs">${TABS.map(([k,l])=>`<button class="sidetab${sideTab===k?' on':''}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="sidebody">${content}</div>
    <div class="sidefoot">${footInner}</div>
  </div>`;
  el.querySelectorAll('.sidetab').forEach(b=>b.onclick=()=>{ sideTab=b.dataset.tab; renderSide(); });
  el.querySelectorAll('[data-act="merge"]').forEach(b=>b.onclick=()=>mergeTask(t.id));
  el.querySelectorAll('[data-act="start"]').forEach(b=>b.onclick=()=>startTask(t.id));
  el.querySelectorAll('[data-act="approveplan"]').forEach(b=>b.onclick=()=>startTask(t.id));
  el.querySelectorAll('[data-act="renbranch"]').forEach(b=>b.onclick=()=>startRenameBranch(t));
  el.querySelectorAll('[data-act="pause"]').forEach(b=>b.onclick=()=>pauseTask(t.id));
  el.querySelectorAll('[data-act="resume"]').forEach(b=>b.onclick=()=>resumeTask(t.id));
  el.querySelectorAll('[data-act="abort"]').forEach(b=>b.onclick=()=>abortTask(t.id));
  el.querySelectorAll('[data-act="rm"]').forEach(b=>b.onclick=()=>removeTask(t.id));
  el.querySelectorAll('[data-flag]').forEach(b=>b.onclick=()=>setFlag(t.id, b.dataset.flag));
  { const p=el.querySelector('#stPill'); if(p) p.onclick=(e)=>{ e.stopPropagation(); stMenuOpen=!stMenuOpen; renderSide(); }; }
  el.querySelectorAll('.stitem').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const it=statusMenuItems(t)[+b.dataset.sti]; stMenuOpen=false; renderSide(); if(it) it.a(); });
  el.querySelectorAll('[data-act="rerun"]').forEach(b=>b.onclick=()=>rerunTask(t.id));
  el.querySelectorAll('[data-act="linkfix"]').forEach(b=>b.onclick=()=>openLinkedFix(t));
  el.querySelectorAll('[data-act="linkdz"]').forEach(b=>b.onclick=()=>openFromDesign(t));
  el.querySelectorAll('[data-act="wspush"]').forEach(b=>b.onclick=()=>openWorkspace(t.id));
  wireLinkChips(el);
  el.querySelectorAll('[data-act="breakdown"]').forEach(b=>b.onclick=()=>openBreakdown(t));
  { const b=el.querySelector('#openWs'); if(b) b.onclick=()=>openWorkspace(t.id); }
  { const b=el.querySelector('#pvOpen'); if(b) b.onclick=()=>invoke('open_url',{ url:b.dataset.url }).catch(()=>{}); }
  { const b=el.querySelector('#pvMobile'); if(b) b.onclick=async()=>{ b.disabled=true; b.textContent='criando túnel…';
      const pub=await mobilePreview(t.id, b.dataset.url);
      if(pub){ tunnelUp[t.id]=pub; }
      renderSide(); }; }
  { const b=el.querySelector('#pvMobileOff'); if(b) b.onclick=async()=>{ b.disabled=true; b.textContent='fechando…';
      try{ await invoke('tunnel_stop',{ taskId: t.id }); }catch(_){ }
      delete tunnelUp[t.id]; delete autoTunneled[t.id];
      try{ const cid=tmap()[t.id]; if(cid){ const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{}; await sbFetch('/rest/v1/tasks?id=eq.'+cid,{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),previewUrl:null,tunnelWanted:null,tunnelClose:null}})}); } }catch(_){ }
      renderSide(); }; }
  el.querySelectorAll('[data-deliver]').forEach(b=>b.onclick=()=>deliverArtifact(t.id, b.dataset.deliver));
  el.querySelectorAll('[data-linksel]').forEach(b=>b.onclick=()=>{ selected=b.dataset.linksel; lastSig=''; render(); });
  { const b=el.querySelector('#pubProofs'); if(b){ const cid=(typeof tmap==='function')?tmap()[t.id]:null; if(cid && typeof cloudPubList==='function') cloudPubList(cid).then(()=>{ if(selected===t.id && sideTab==='entregas'){ lastSig=''; } }); b.onclick=()=>cloudPublishProofs(t, b); } }
  { const b=el.querySelector('#brReqCheck'); if(b) b.onclick=()=>{ b.disabled=true; b.textContent='verificando…'; talkTask(t.id, 'Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json (o campo req deve ser o TEXTO EXATO do requisito). Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar.'); }; }
  el.querySelectorAll('.fcommit').forEach(b=>b.onclick=()=>openCommit(b.dataset.hash));
  el.querySelectorAll('[data-art]').forEach(b=>b.onclick=()=>openArtifact(t.id, b.dataset.art));
  el.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>openWorkspace(t.id, b.dataset.file));
  el.querySelectorAll('[data-refopen]').forEach(b=>b.onclick=()=>openRef(t.id, b.dataset.refopen));
  { const b=el.querySelector('#revPrOpen'); if(b) b.onclick=()=>{ if(t.prUrl) openExternal(t.prUrl); }; }
  { const b=el.querySelector('#prOpen'); if(b) b.onclick=()=>openPr(t); }
  { const b=el.querySelector('#prLink'); if(b) b.onclick=()=>{ const u=(prCache[t.id]||{}).url; if(u) openExternal(u); }; }
  { const b=el.querySelector('#prCopy'); if(b) b.onclick=()=>{ const u=(prCache[t.id]||{}).url; if(u) copyLink(u,b); }; }
  { const b=el.querySelector('#prRefresh'); if(b) b.onclick=async()=>{ await loadPr(t.id,true); renderSide(); }; }
  { const b=el.querySelector('#prRework'); if(b) b.onclick=()=>reworkFromPr(t.id); }
  { const b=el.querySelector('#prMerge'); if(b) b.onclick=()=>mergePr(t.id); }
  el.querySelectorAll('[data-prfix]').forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent='enviando…'; try{ await prFixOne(t.id, +b.dataset.prfix); }finally{ renderSide(); } });
  el.querySelectorAll('[data-prign]').forEach(b=>b.onclick=()=>{ prIgnAdd(t.id, b.dataset.prign); renderSide(); });
  const iSend=el.querySelector('#instrSend'); if(iSend) iSend.onclick=()=>sendInstruction(t.id);
  const iInput=el.querySelector('#instrInput'); if(iInput) iInput.addEventListener('keydown',e=>{ if(e.key==='Enter') sendInstruction(t.id); });
  { const b=el.querySelector('#openChatBtn'); if(b) b.onclick=()=>openChat(t.id); }
  { const a=el.querySelector('#rwFull'); if(a) a.onclick=()=>{ const txt=prompt('Ajuste completo (passa pelo time inteiro — planeja → coda → revisa → docs):'); if(txt&&txt.trim()){ invoke('rework_task',{taskId:t.id, text:txt.trim()}).then(()=>{ lastSig=''; refresh(); }).catch(e=>alert('Falha:\n'+e)); } }; }
  // clicar numa etapa: planner/designer abrem o doc produzido (ver/editar);
  // as demais miram o "pedir ajuste" naquela etapa.
  const stageDoc={ planner:'.cardume/PLAN.md', designer:'.cardume/DESIGN.md' };
  el.querySelectorAll('.step').forEach(s=>s.onclick=()=>{
    const role=s.dataset.role;
    // plano/design abrem no workspace estilo Cursor (markdown editável + chat)
    if(stageDoc[role]){ openWorkspace(t.id, stageDoc[role]); return; }
    if(['review','error','aborted','conflict'].includes(t.status)){ openChat(t.id); const _pf='Sobre a etapa '+(ROLE_PT[role]||role)+' ('+s.dataset.name+'): '; setTimeout(()=>{ const ci=$id('fwInput'); if(ci){ ci.value=_pf; ci.focus(); } },300); }
  });
  wireQuestion(el);
  // restaura foco/caret do input que estava sendo digitado
  if(aeId){ const n=el.querySelector('#'+aeId); if(n){ try{ n.focus(); if(aeVal!=null && 'value' in n) n.value=aeVal; if(aeCaret!=null && n.setSelectionRange) n.setSelectionRange(aeCaret,aeCaret); }catch(e){} } }
  // restaura o scroll do corpo (menos na aba Stream, que segue o fim ao vivo)
  { const nsb=el.querySelector('.sidebody'); if(nsb && sideTab!=='stream' && sbTop>0) nsb.scrollTop=sbTop; }
  // stream rola pro fim (ao vivo)
  if(sideTab==='stream'){ const s=el.querySelector('.stream'); if(s) s.scrollTop=s.scrollHeight; }
}

function renderBus(){
  const yields = state.claims.filter(c=>c.yieldedTo);
  const totalClaims = state.claims.length;
  const el = $id("busSummary");
  if(state.tasks.length===0){ el.innerHTML = '<span class="dim">—</span>'; return; }
  const parts = [`${state.tasks.length} agentes · ${totalClaims} reivindicações`];
  const totUsd=(state.costs||[]).reduce((s,c)=>s+(c.usd||0),0);
  const totTok=(state.costs||[]).reduce((s,c)=>s+(c.inTok||0)+(c.outTok||0),0);
  if(totUsd||totTok) parts.push(`<span style="color:var(--accent);font-weight:600">Σ ${fmtUsd(totUsd)} · ${fmtTok(totTok)} tok</span>`);
  // cessões: dedup (o mesmo arquivo pode ceder N vezes) + só o basename + cap
  const seen=new Set(); const uniq=[];
  for(const c of yields){ const k=c.agent+'|'+c.path+'|'+c.yieldedTo; if(!seen.has(k)){ seen.add(k); uniq.push(c); } }
  for(const c of uniq.slice(0,2)) parts.push(`<span class="warn">⚠ ${esc(c.agent)} cedeu ${esc((c.path||'').split('/').pop())} → ${esc(c.yieldedTo)}</span>`);
  if(uniq.length>2) parts.push(`<span class="warn">+${uniq.length-2} cessões</span>`);
  el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

$id("connectBtn").onclick = ()=>{
  const v = $id("repoInput").value.trim();
  if(v) connect(v);
};
$id("repoInput").addEventListener("keydown", e=>{ if(e.key==="Enter") $id("connectBtn").click(); });

$id("viewSeg").querySelectorAll("button").forEach(b=>b.onclick=()=>{
  const v=b.dataset.v;
  $id("viewSeg").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b));
  $id("chint").textContent = v==="flow"?"quem fez o quê · commits por tarefa":v==="kanban"?"arraste entre colunas · play no card":v==="graph"?"branches · agentes nas pontas":v==="team"?"backlog compartilhado do time · assumir & iniciar":"eventos ao vivo de todos os agentes";
  if(v==="flow") loadAllCommits();
  if(v==="graph"){ refresh(); return; }   // busca o grafo (git log) só ao abrir a aba
  render();
  lastSig = snapSig();   // marca o estado já renderizado (evita render duplicado no próximo tick)
});

let ntDel=[], ntReq=[], ntRefs=[], ntFixReq=[], ntDzRefs=[], ntFixRefs=[], ntInvRefs=[];
