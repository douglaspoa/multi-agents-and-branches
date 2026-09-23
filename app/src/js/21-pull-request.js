// Constellation — 21-pull-request
// ---------- Pull Request (GitHub) ----------
const prCache={}; let branchList=null;
async function loadBranches(){ if(branchList) return branchList; try{ branchList=await invoke("list_branches"); }catch(e){ branchList=["main"]; } return branchList; }
async function loadPr(taskId, force){
  if(prCache[taskId]!==undefined && !force) return prCache[taskId];
  if(prCache[taskId]===undefined) prCache[taskId]=null; // loading
  try{ prCache[taskId]=await invoke("pr_status",{ taskId }); }catch(e){ prCache[taskId]={exists:false,error:String(e)}; }
  return prCache[taskId];
}
function prBlock(t, full){
  if(t.kind==='review'){
    // tarefa do tipo "revisar PR": a aba PR mostra o PR revisado
    return full && t.prUrl ? `<div class="seclbl">Pull Request revisado</div><div class="prreview"><span class="prnum">${esc(t.branch)}</span><button class="btn sm" id="revPrOpen">${IC.extlink} abrir PR</button></div>` : '';
  }
  if(!full && !(t.status==='review'||t.status==='error')) return '';
  const info=prCache[t.id];
  // na aba PR, com a task ainda rodando: se o PR JÁ EXISTE (aberto manualmente
  // ou pelo agente), mostra ele de verdade — só cai no aviso se não existir.
  if(full && !(t.status==='review'||t.status==='error'||t.status==='merged'||t.status==='conflict')){
    if(info===undefined){ loadBranches(); loadPr(t.id).then(()=>{ if(selected===t.id) renderSide(); }); return '<div class="seclbl">Pull Request</div><div class="dim" style="font-size:12px;padding:2px">verificando no GitHub…</div>'; }
    if(!info || !info.exists){
      const mode=t.autoPr||'ask';
      const modeTx = mode==='auto'?'vai <b>abrir o PR sozinho</b> ao concluir — só se não houver requisito pendente':mode==='no'?'<b>não</b> vai abrir PR automaticamente':'vai <b>te perguntar</b> quando ficar pronta';
      return `<div class="seclbl">Pull Request</div><div class="prbox"><div class="ihint">Nenhum PR aberto ainda — a tarefa está em andamento e ${modeTx}.</div><div class="prrow" style="margin-top:8px"><button class="btn sm" id="prRefresh">verificar de novo</button></div></div>`;
    }
  }
  if(info===undefined){ loadBranches(); loadPr(t.id).then(()=>{ if(selected===t.id) renderSide(); }); return '<div class="seclbl">Pull Request</div><div class="dim" style="font-size:12px;padding:2px">verificando no GitHub…</div>'; }
  if(info===null){ return '<div class="seclbl">Pull Request</div><div class="dim" style="font-size:12px;padding:2px">verificando no GitHub…</div>'; }
  if(!info.exists){
    const opts=(branchList||['main']).map(b=>`<option value="${escA(b)}"${b==='main'?' selected':''}>${esc(b)}</option>`).join('');
    return `<div class="seclbl">Pull Request</div><div class="prbox">
      <div class="prrow"><span class="prlbl">base</span><select class="sel" id="prBase">${opts}</select><button class="btn primary sm" id="prOpen">${IC.merge} Abrir PR</button></div>
      <div class="ihint" style="margin-top:7px">Faz push da branch <b>${esc(t.branch)}</b> e abre o PR na base escolhida.</div>
    </div>`;
  }
  const dec=info.decision||'';
  const decBadge = dec==='APPROVED'?'<span class="prbadge ok">✓ aprovado</span>' : dec==='CHANGES_REQUESTED'?'<span class="prbadge chg">mudanças pedidas</span>' : dec==='REVIEW_REQUIRED'?'<span class="prbadge">aguardando review</span>' : '<span class="prbadge">sem review</span>';
  const all=info.comments||[];
  // threads: respostas não viram card próprio; o comentário-raiz respondido ganha ✔
  const ign=prIgnSet(t.id);
  const cKey=c=>String(c.id ?? ((c.author||'')+':'+(c.body||'').slice(0,40)));
  const cmts=all.filter(c=>!c.inReplyTo);
  const openCmts=cmts.filter(c=>!c.answered && !ign.has(cKey(c)));
  const cmHtml = cmts.length ? cmts.map((c,ci)=>{ const done=c.answered, skip=!done&&ign.has(cKey(c));
    return `<div class="prcmt${c.isBot?' bot':''}${done?' ok':''}"><div class="prcmt-h"><span class="prau">${esc(c.author)}${c.isBot?' <span class="botag">bot</span>':''}</span>${c.path?`<span class="prloc mono">${esc(c.path)}${c.line?':'+c.line:''}</span>`:'<span class="prloc">conversa</span>'}${done?'<span class="prbadge ok">✔ respondido</span>':skip?'<span class="prbadge">ignorado</span>':''}</div><div class="prcmt-b"${(done||skip)?' style="opacity:.55"':''}>${esc((c.body||'').slice(0,500))}</div>${(!done&&!skip)?`<div class="prcmt-acts"><button class="btn primary sm" data-prfix="${ci}" style="padding:3px 9px;font-size:10.5px">${IC.ai} aplicar correção</button><button class="btn sm" data-prign="${escA(cKey(c))}" style="padding:3px 9px;font-size:10.5px" title="marcar como não-aplicável — some da fila">ignorar</button></div>`:''}</div>`; }).join('') : '<div class="dim" style="font-size:12px;padding:4px 2px">sem comentários ainda</div>';
  const descHtml = (info.body||'').trim()?`<details${cmts.length?'':' open'}><summary class="dim" style="cursor:pointer;font-size:11.5px;margin-top:8px">descrição do PR — o quê · entregáveis · como testar</summary><div class="prdesc">${chatMd(info.body)}</div></details>`:'';
  return `<div class="seclbl">Pull Request <span class="n">#${info.number}</span></div><div class="prbox">
    <div class="prrow"><button class="prlink mono" id="prLink" title="${escA(info.url)}">${IC.extlink} #${info.number} · ${esc((info.state||'').toLowerCase())}</button>${decBadge}<span class="grow"></span><button class="btn sm" id="prCopy" title="copiar link">copiar</button><button class="btn sm" id="prRefresh">atualizar</button></div>
    ${descHtml}
    <div class="prcmts" style="margin-top:8px">${cmHtml}</div>
    <div class="prrow" style="margin-top:10px">${openCmts.length?`<button class="btn primary sm" id="prRework">${IC.ai} corrigir ${openCmts.length} comentário${openCmts.length===1?'':'s'} em aberto</button>`:cmts.length?`<span class="dim" style="font-size:11.5px">✔ todos os comentários tratados</span>`:''}<span class="grow"></span><button class="btn sm" id="prMerge">${IC.merge} merge PR</button></div>
  </div>`;
}
function prIgnSet(taskId){ try{ return new Set(JSON.parse(lsGet('prIgn:'+taskId)||'[]')); }catch(_){ return new Set(); } }
function prIgnAdd(taskId,key){ const s=prIgnSet(taskId); s.add(key); lsSet('prIgn:'+taskId, JSON.stringify([...s])); }
// aplicar correção de UM comentário: manda pro agente com o contexto e cobra resposta no thread
async function prFixOne(taskId, ci){
  const info=prCache[taskId]; if(!info) return;
  const cmts=(info.comments||[]).filter(c=>!c.inReplyTo); const c=cmts[ci]; if(!c) return;
  const loc=c.path?`${c.path}${c.line?':'+c.line:''}`:'(conversa do PR)';
  const idTx=c.id?` [comment_id=${c.id}]`:'';
  const msg=`Aplique a correção pedida NESTE comentário do PR #${info.number}${idTx} — ${loc}, de ${c.author}:\n"""\n${(c.body||'').slice(0,1200)}\n"""\nDepois: commit + push, e responda o thread`+(c.id?` via gh api (repos/{owner}/{repo}/pulls/${info.number}/comments/${c.id}/replies) dizendo o que mudou.`:` com um comentário no PR dizendo o que mudou.`);
  await fwSendText(taskId, msg);
}
function prBodyOf(t){
  const rev=reviewOf(t.id);
  return `## O quê\n${t.objective||t.title}\n\n`+
    ((t.deliverables||[]).length?`## Entregáveis\n${(t.deliverables||[]).map(d=>'- '+d).join('\n')}\n\n`:'')+
    (rev?`## Resumo\n${(rev.summary||'').slice(0,400)}\n\n## Como testar\n${(rev.howToTest||'').slice(0,600)}\n\n`:'')+
    `_Aberto pelo Constellation._`;
}
// ---- "Preparando o PR" (redesign p13): checagens reais → push → criar ----
function prPrepOpen(taskId, base){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  const ov=$id('prepOverlay'); ov.style.display='flex';
  $id('prepBody').innerHTML=`
    <div class="dim" style="font-size:12.5px;margin-bottom:6px">Rodando as checagens do repo antes de abrir</div>
    <div class="prepstep" id="prep1"><span class="ps run">◌</span><div style="flex:1"><b>Checagens do repo</b><div class="dim psd" id="prep1d" style="font-size:11.5px">rodando lint/testes na worktree…</div></div></div>
    <div class="prepstep" id="prep2"><span class="ps">·</span><div style="flex:1"><b>Commit &amp; push</b><div class="dim psd" id="prep2d" style="font-size:11.5px">aguardando</div></div></div>
    <div class="prepstep" id="prep3"><span class="ps">·</span><div style="flex:1"><b>Abrir o PR</b><div class="dim psd" id="prep3d" style="font-size:11.5px">base <b>${esc(base||'main')}</b></div></div></div>
    <div class="dim" style="font-size:11px;text-align:center;margin-top:12px">isso leva alguns segundos — pode continuar em outra aba</div>
    <div style="display:flex;gap:8px;margin-top:12px"><span style="flex:1"></span><button class="btn" id="prepCancelB">fechar</button><button class="btn primary" id="prepForce" style="display:none">abrir mesmo assim</button></div>`;
  const close=()=>{ ov.style.display='none'; };
  $id('prepClose').onclick=close;
  $id('prepCancelB').onclick=close;
  prPrepRun(t, base||'main');
}
function prepMark(n, st, txt){ // st: run|ok|fail|skip
  const s=document.querySelector('#prep'+n+' .ps'); if(!s) return;
  s.className='ps '+st; s.textContent= st==='ok'?'✓' : st==='fail'?'✕' : st==='run'?'◌' : '·';
  if(txt!=null){ const d=$id('prep'+n+'d'); if(d) d.innerHTML=txt; }
}
async function prPrepRun(t, base){
  // 1. checagens (lint/test do package.json da worktree, quando existem)
  let checks=[];
  try{ checks=await invoke('repo_checks',{ taskId:t.id }); }catch(_){ }
  const bad=checks.filter(c=>!c.ok);
  if(!checks.length) prepMark(1,'ok','sem lint/testes configurados no repo — seguindo');
  else if(!bad.length) prepMark(1,'ok', checks.map(c=>c.name+' ✓').join(' · '));
  else {
    prepMark(1,'fail', bad.map(c=>`<b>${esc(c.name)} falhou</b><div class="mono" style="white-space:pre-wrap;font-size:10.5px;margin-top:4px;color:var(--crit)">${esc(c.detail.slice(0,400))}</div>`).join(''));
    const f=$id('prepForce');
    if(f){ f.style.display=''; f.onclick=()=>{ f.style.display='none'; prPrepFinish(t, base); }; }
    return; // decisão do humano: corrigir antes ou abrir mesmo assim
  }
  await prPrepFinish(t, base);
}
// reconhece falha de REDE (DNS/conexão) — dá mensagem clara em vez do erro cru do git
function prNetHint(e){
  const s=String(e||'');
  if(/could not resolve host|couldn'?t resolve|failed to connect|could not read from remote|connection timed out|connection refused|network is unreachable|temporary failure in name resolution|unable to access/i.test(s))
    return 'Sem conexão com o GitHub agora — cheque a internet/VPN e tente de novo. O commit local já foi feito; o botão só re-envia.';
  return null;
}
// mostra/atualiza um botão "tentar de novo" no rodapé do modal
function prShowRetry(fn){
  let b=$id('prepRetry');
  if(!b){ const foot=document.querySelector('#prepBody > div:last-child'); const cancel=$id('prepCancelB');
    b=document.createElement('button'); b.id='prepRetry'; b.className='btn primary'; if(foot&&cancel) foot.insertBefore(b, cancel.nextSibling); else if(foot) foot.appendChild(b); }
  b.textContent='↻ tentar de novo'; b.style.display=''; b.onclick=()=>{ b.style.display='none'; fn(); };
}
function prHideRetry(){ const b=$id('prepRetry'); if(b) b.style.display='none'; }
async function prPrepFinish(t, base){
  prHideRetry();
  prepMark(2,'run','commitando e enviando a branch…');
  try{ const msg=await invoke('push_task',{ taskId:t.id }); prepMark(2,'ok', esc(msg)); }
  catch(e){ const h=prNetHint(e);
    prepMark(2,'fail', (h?`<b>${esc(h)}</b><div class="mono" style="font-size:10px;margin-top:4px;color:var(--muted);white-space:pre-wrap">${esc(String(e).slice(0,240))}</div>`:esc(String(e))));
    prShowRetry(()=>prPrepFinish(t, base)); return; }
  prepMark(3,'run','escrevendo a descrição do PR (o quê · o que foi feito · como testar)…');
  let prBody;
  try{ prBody=await invoke('pr_body_ai',{ taskId:t.id }); }
  catch(_){ prBody=prBodyOf(t); }
  prepMark(3,'run','criando o PR no GitHub…');
  try{
    const url=await invoke('open_pr',{ taskId:t.id, base, title:t.title, body: prBody });
    prepMark(3,'ok', url?`<button class="btn sm" onclick="openExternal('${escA(url)}')" style="margin-top:4px">${esc(url.replace('https://',''))} ↗</button>`:'PR aberto');
    prHideRetry();
    prCache[t.id]=undefined; await loadPr(t.id,true); lastSig=''; renderSide();
    if(typeof renderWorkspace==='function'&&fwTask===t.id){ fwMode='pr'; renderWorkspace(); }
  }catch(e){ const s=String(e); const h=prNetHint(e);
    // gh sem acesso/SSO ao repo (comum em quem não é membro da org ou sem SSO): o
    // push funcionou, então dá pra criar o PR no NAVEGADOR (a sessão do dev tem acesso).
    const ghAccess=/could not resolve to a repository|graphql|sso|not authorized|não enxerga/i.test(s);
    prepMark(3,'fail', (h?`<b>${esc(h)}</b><div class="mono" style="font-size:10px;margin-top:4px;color:var(--muted);white-space:pre-wrap">${esc(s.slice(0,240))}</div>`:esc(s)));
    if(ghAccess && !h){
      try{ const cu=await invoke('pr_compare_url',{ taskId:t.id, base }); const d=$id('prep3d');
        if(d&&cu){ d.insertAdjacentHTML('beforeend', `<div style="margin-top:8px"><button class="btn primary sm" data-prweb="${escA(cu)}" title="a branch já foi enviada — abre a página do GitHub pra criar o PR, onde a SUA conta tem acesso à org">criar o PR no navegador ↗</button></div>`);
          const wb=d.querySelector('[data-prweb]'); if(wb) wb.onclick=()=>invoke('open_url',{url:wb.dataset.prweb}).catch(()=>{}); }
      }catch(_){ prShowRetry(()=>prPrepFinish(t, base)); }
    } else {
      // a branch já foi enviada — re-tentar só a criação do PR (ex.: falha de rede)
      prShowRetry(()=>prPrepFinish(t, base));
    }
  }
}
async function openPr(t){
  const base=($id('prBase')||{}).value||'main';
  prPrepOpen(t.id, base);
}
async function reworkFromPr(taskId){
  const btn=$id('prRework');
  if(btn){ btn.disabled=true; btn.textContent='enviando…'; }
  try{
    await invoke('rework_from_pr',{ taskId });
    if(btn){ btn.textContent='✓ enviado ao agente'; }
    prCache[taskId]=undefined; lastSig=''; await refresh();
  }
  catch(e){ alert('Falha ao mandar revisar:\n'+e); if(btn){ btn.disabled=false; btn.textContent='mandar o agente revisar'; } }
}
async function mergePr(taskId){
  if(!confirm('Mergear o PR no GitHub (squash + apaga a branch remota)?')) return;
  try{ await invoke('merge_pr',{ taskId, method:'squash' }); prCache[taskId]=undefined; lastSig=''; await refresh(); }
  catch(e){ alert('Merge do PR falhou:\n'+e); }
}
function costBlock(taskId){
  const cs=costsOf(taskId); if(!cs.length) return '';
  const tc=taskCost(taskId);
  const byAgent={};
  for(const c of cs){ const k=c.agent||'?'; (byAgent[k]||(byAgent[k]={usd:0,tok:0}));  byAgent[k].usd+=c.usd||0; byAgent[k].tok+=(c.inTok||0)+(c.outTok||0); }
  return `<div class="seclbl">Custo <span class="n">${fmtUsd(tc.usd)} · ${fmtTok(tc.tok)} tok</span></div><div class="costlist">`+
    Object.entries(byAgent).map(([a,v])=>`<div class="costrow"><span class="cav" style="background:${agentColor(a)}">${agentBadge(a)}</span><span class="cnm">${esc(a)}</span><span class="ctok">${fmtTok(v.tok)} tok</span><span class="cusd">${fmtUsd(v.usd)}</span></div>`).join('')+
    `</div>`;
}
const ROLE_PT = { planner:"plano", builder:"build", reviewer:"review" };

let __selPersisted='';
function render(){
  if(selected && selected!==__selPersisted && state.repo){ __selPersisted=selected; lsSet('sel:'+state.repo, selected); }
  const noRepo = !state.repo;
  const chead=document.querySelector(".chead"); if(chead) chead.style.display = noRepo?"none":"flex";
  $id("emptyRepo").style.display = noRepo ? "flex":"none";
  if(noRepo){
    $id("graphPane").style.display="none";
    $id("feedPane").style.display="none";
    $id("rail").innerHTML='';
    $id("side").innerHTML='';
    $id("busSummary").innerHTML='<span class="dim">—</span>';
    return;
  }
  const v = (((document.querySelector('#viewSeg button.on')||{}).dataset)||{}).v || "flow";
  document.querySelector(".body").classList.toggle("teamfull", v==="team");
  // padrão NOVO em todas as vistas: sem menu antigo, sem painel lateral; a barra
  // de abas (Tudo/Minhas/Do time/Concluídas + ícones) é a mesma em toda página
  document.querySelector(".body").classList.toggle("flowmode", ["flow","kanban","graph","feed"].includes(v));
  if(chead && !noRepo){
    chead.style.display = v==="flow" ? "none" : "flex";
    if(v!=="flow") renderNavTabs(v);
  }
  $id("flowPane").style.display = v==="flow"?"block":"none";
  $id("kanbanPane").style.display = v==="kanban"?"block":"none";
  $id("graphPane").style.display = v==="graph"?"block":"none";
  $id("feedPane").style.display = v==="feed"?"block":"none";
  $id("teamPane").style.display = v==="team"?"block":"none";
  // cada painel isolado: um erro num deles não derruba os outros nem o poll
  safe(renderRail); safe(renderSide); safe(renderBus);
  // só renderiza o painel central ativo (os outros ficam ocultos)
  if(v==="graph") safe(renderGraph);
  else if(v==="feed") safe(renderFeed);
  else if(v==="kanban") safe(renderKanban);
  else if(v==="team") safe(renderTeamBoard);
  else safe(renderFlow);
}
// executa um render defensivamente — loga o erro em vez de propagar/travar a UI
function safe(fn){ try{ fn(); }catch(e){ console.error("render "+(fn.name||"?")+":", e); } }
function activeIs(x){ return ((((document.querySelector('#viewSeg button.on')||{}).dataset)||{}).v)===x; }
const commitsCache={};
async function loadCommits(taskId, force){
  if(commitsCache[taskId]!==undefined && !force) return commitsCache[taskId];
  try{ commitsCache[taskId]=await invoke("task_commits",{taskId}); }catch(e){ commitsCache[taskId]=[]; }
  return commitsCache[taskId];
}
async function loadAllCommits(){ for(const t of (state.tasks||[])) await loadCommits(t.id); render(); }
function commitChip(x, agent){
  const av = agent ? `<span class="cav" style="background:${agentColor(agent)}" title="${escA(agent)}">${agentBadge(agent)}</span>` : '';
  return `<button class="fcommit" data-hash="${escA(x.hash)}" title="${escA((agent?agent+' · ':'')+x.subject)}">${av}<span class="chash mono">${esc((x.hash||'').slice(0,7))}</span><span class="csub">${esc(x.subject||'')}</span></button>`;
}
const FLOW_PAL=["#3fd68a","#5b9df9","#b47ce0","#f0b449","#f2685c","#4fc4c9","#e07ab4","#7c8792"];
// Busca o agente no catálogo do projeto (config) POR NOME — é como as tarefas
// referenciam o agente (só o nome fica gravado). Dá acesso a cor + avatar escolhidos no editor.
function agentCat(name){ try{ return ((state.config&&state.config.agents)||[]).find(a=>String(a.name||'').toLowerCase()===String(name||'').toLowerCase())||null; }catch(_){ return null; } }
function agentColor(name){ const a=agentCat(name); if(a&&a.color) return a.color; let h=0; const s=String(name||""); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return FLOW_PAL[h%FLOW_PAL.length]; }
// Conteúdo do badge do agente: o AVATAR (emoji) escolhido no editor, ou as iniciais.
function agentBadge(name){ const a=agentCat(name); return a&&a.avatar ? a.avatar : esc(String(name||'?').trim().slice(0,2).toUpperCase()); }
function flowTaskCard(t, acc){
  const col=STATUS_COLOR[t.status]||"var(--muted)";
  const accCls=acc?(' '+acc):'';
  const roles=t.roles||[];
  const pipe = roles.map(r=>`<span class="fstep${r.role===t.stage?' cur':''}"><span class="fav" style="background:${r.role===t.stage?'var(--accent)':agentColor(r.name)}">${agentBadge(r.name)}</span><span class="fnm">${esc(r.name)}</span><span class="frole">${esc(r.role)}</span></span>`).join('<span class="farrow">→</span>');
  const d=diffOf(t.id), rev=reviewOf(t.id), c=commitsCache[t.id];
  const cchips = c===undefined ? '<span class="dim" style="font-size:11px">carregando…</span>'
    : c.length ? c.slice(0,8).map(x=>commitChip(x,t.agent)).join("")+(c.length>8?`<span class="dim" style="font-size:11px;padding:3px 6px">+${c.length-8}</span>`:"")
    : (t.status==='merged'?'<span class="dim" style="font-size:11px">mergeado na '+esc(t.base)+'</span>':'<span class="dim" style="font-size:11px">nenhum commit ainda</span>');
  const live = ACTIVE_ST.has(t.status) && !pendingOf(t.id).length ? (()=>{ const ev=lastEventOf(t.id); return `<div class="flive"><span class="pulse" style="--pc:${col}"></span><span class="lx">${esc(ev?((GLYPH[ev.type]||'·')+' '+ev.text):'iniciando…')}</span></div>`; })() : '';
  const flagBadge = t.flag==='blocked'?`<span class="flagbadge blk">${IC.pause} bloqueada</span>`:t.status==='cancelled'?`<span class="flagbadge cls">⊘ cancelada</span>`:t.flag==='closed'?`<span class="flagbadge cls">${IC.checkc} encerrada</span>`:'';
  const asking = pendingOf(t.id).length>0;
  return `<div class="fcard${accCls}${t.id===selected?' sel':''}${t.flag?' flagged':''}${asking?' asking':''}" data-id="${t.id}">
    <div class="fhead"><span class="sd" style="background:${asking?'var(--warn)':col}"></span><b>${esc(t.title)}</b>${t.linkedTo?`<span class="linkbadge" title="correção linkada a outra tarefa">${IC.clip}</span>`:''}${flagBadge}${asking?`<span class="askingbadge">✋ esperando você</span>`:''}<span class="fstatus stdrop" data-stmenu="${t.id}" style="color:${asking?'var(--warn)':(t.status==='cancelled'?'var(--crit)':t.flag==='closed'?'var(--accent)':col)}" title="mudar status da demanda">${asking?'esperando você':(t.status==='cancelled'?'cancelada':t.flag==='closed'?'finalizado':esc(t.status))}<span class="stcaret">▼</span></span></div>
    ${(()=>{const p=taskPct(t);return `<div class="cardpct" data-sum="${escA(t.id)}" title="ver o resumo do que já foi feito"><div class="bar"><i style="width:${p}%;background:${asking?'var(--warn)':'var(--good)'}"></i></div><span class="mono">${p}%</span></div>`;})()}
    <div class="fpipe">${pipe}</div>${live}
    <div class="fmeta"><span class="prj"><span class="prjd" style="background:${projColor(t.repo||state.repo)}"></span>${esc(t.proj||projShort(t.repo||state.repo))}</span>${(()=>{const ty=taskType(t);const c=TYPE_COLOR[ty]||'var(--muted)';return `<span class="typetag" style="color:${c};border-color:color-mix(in srgb,${c} 45%,transparent)">${TYPE_PT[ty]}</span>`;})()}${linkChips(t)}${pvChips(t)}${t.status==='conflict'?`<button class="btn primary sm" data-resolveconf="${escA(t.id)}" title="a IA mergeia a base e resolve os conflitos na worktree" style="padding:3px 9px;font-size:10.5px">⚡ resolver conflito</button>`:''}${(!['merged','done'].includes(t.status)&&t.flag!=='closed'&&t.status!=='draft'&&!t.prUrl)?`<button class="btn ${['review','delivered'].includes(t.status)?'primary ':''}sm" data-rowpr="${escA(t.id)}" title="checagens do repo → commit & push → cria o PR" style="padding:3px 9px;font-size:10.5px">${IC.merge} abrir PR</button>`:''}<span>${(t.deliverables||[]).length} entregável(is)</span><span>${d?`+${d.additions} −${d.deletions}`:'sem diff'}</span>${rev?'<span class="frev">✓ review</span>':''}<span>${c!==undefined?c.length:'…'} commit(s)</span>${(()=>{const tc=taskCost(t.id);return (tc.usd||tc.tok)?`<span class="fcost">${fmtUsd(tc.usd)} · ${fmtTok(tc.tok)} tok</span>`:'';})()}</div>
    <div class="fclabel fctog" data-ctog="${t.id}"><span class="fcchev">${flowCommitsOpen.has(t.id)?'▾':'▸'}</span>Commits <span class="dim">· ${c!==undefined?c.length:'…'}${flowCommitsOpen.has(t.id)?' · clique num commit para ver o diff':''}</span></div>
    ${flowCommitsOpen.has(t.id)?`<div class="fcommits">${cchips}</div>`:''}
  </div>`;
}
const flowCommitsOpen=new Set(); // cards com a lista de commits expandida
