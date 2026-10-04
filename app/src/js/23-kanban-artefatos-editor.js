// Starfork — 23-kanban-artefatos-editor
// ---------- Kanban ----------
// colunas = as MESMAS etapas da Central (22: flowBucket/FLOW_SECS) — mesma tarefa, mesma coluna, mesmo número.
// Antes o Kanban tinha classificação própria (pausada/conflito em "Em andamento", PR aberto em "Prontas").
const KCOLS=[['rascunho','Rascunhos'],['fila','Na fila'],['aguardando','Aguardando você'],['andamento','Em andamento'],['prontas','Prontas pra revisar'],['praberto','PR aberto'],['concluidas','Concluídas']];
const KDONE_CAP=30; // Concluídas: mostra as mais recentes (conta todas)
function kanbanCol(t){
  const b=flowBucket(t);
  return (b==='hoje'||b==='anteriores')?'concluidas':b; // F4: a fila tem coluna própria (antes caía em andamento)
}
function kCard(t){
  const roles=t.roles||[]; const curIdx=roles.findIndex(r=>r.role===t.stage);
  const crew=roles.map((r,i)=>`<span class="kav${r.role===t.stage?' cur':''}" style="background:${agentColor(r.name)};${(curIdx>=0&&i>curIdx)?'opacity:.4':''}" title="${escA(r.name+(r.role===t.stage?' — na vez agora':''))}">${agentBadge(r.name)}</span>`).join('');
  const ev=lastEventOf(t.id);
  const amber = t.status==='plan-review'||t.status==='needs-you'||pendingOf(t.id).length||t.status==='aborted';
  const note = pendingOf(t.id).length?'perguntou — responda'
    : t.status==='plan-review'?'plano pronto · aprove pra continuar'
    : t.status==='conflict'?'conflito de merge — resolva'
    : (t.prUrl && t.status!=='merged' && t.flag!=='closed' && ['review','delivered','running','thinking','queued','paused'].includes(t.status))?'PR aberto · aguardando revisão/merge'
    : ['review','delivered'].includes(t.status)?'pronta pra revisar · aprovar ou pedir ajuste'
    : t.status==='error'?'erro — veja o log'
    : t.status==='aborted'?'interrompida — descarte ou refaça'
    : t.status==='paused'?'pausada — retome quando quiser'
    : ACTIVE_ST.has(t.status)?(ev?ev.text:(t.agent+' trabalhando')):'';
  return `<div class="kcard${t.id===selected?' sel':''}${pendingOf(t.id).length?' asking':''}" draggable="true" tabindex="0" data-id="${t.id}">
    <div class="kctop">${t.status==='draft'?((!t.repo||t.repo===state.repo)?`<button class="kplay" data-kplay="${t.id}" title="iniciar">${IC.cright}</button>`:`<button class="kplay" disabled title="rascunho de outro projeto — abra ${escA(projShort(t.repo))} para iniciar">${IC.cright}</button>`):''}<b class="ktitle">${esc(t.title)}</b></div>
    ${typeof epTaskBadge==='function'&&t.epic?`<div class="kepic">${epTaskBadge(t)}</div>`:''}
    <div class="kcrew">${crew}</div>
    ${note?`<div class="knote${amber?' amber':''}">${esc(note.length>64?note.slice(0,63)+'…':note)}</div>`:''}
  </div>`;
}
let kDragId=null;
function renderKanban(){
  const el=$id('kanban');
  const byCol={}; KCOLS.forEach(([k])=>byCol[k]=[]);
  // mesma fonte da Central (boardSource: projeto filtrado ou todos) e mesma regra de bloqueadas
  let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); }
  for(const t of src.filter(t=>t.flag!=='blocked'||flowShowBlocked)) (byCol[kanbanCol(t)]||byCol.andamento).push(t);
  byCol.concluidas.sort((a,b)=>taskDoneTs(b)-taskDoneTs(a)); // F4: pela data de CONCLUSÃO (taskDoneTs, 22)
  if(kDragId) return; // arrastando: reconstruir destruía o card no meio do arrasto (o drop nunca vinha)
  const html = KCOLS.map(([k,label])=>{ const list=byCol[k]; const shown=k==='concluidas'?list.slice(0,KDONE_CAP):list;
    return `<div class="kcol" data-col="${k}"><div class="kcolh" title="${escA(FLOW_SEC_TIP[k]||label)}"><span class="kcl">${label}</span><span class="kn">${list.length}</span></div><div class="kcolbody">${shown.map(kCard).join('')||'<div class="kempty">—</div>'}${list.length>shown.length?`<div class="kempty">+${list.length-shown.length} mais antigas</div>`:''}</div></div>`; }).join('');
  if(el.__html===html && el.firstChild) return; // nada visível mudou: sem piscar, sem perder clique
  el.__html=html; el.innerHTML=html;
  el.querySelectorAll('.kcard').forEach(card=>{
    card.onclick=(e)=>{ if(e.target.closest('.kplay')) return;
      const eb=e.target.closest('[data-epbadge]'); if(eb){ e.stopPropagation(); if(typeof epOpenById==='function') epOpenById(eb.dataset.epbadge); return; } // R5-7
      openTaskById(card.dataset.id); };
    // R7: cartão pelo teclado — Tab chega, Enter/Espaço abre, a tecla de menu (ou Shift+F10) abre o ⋯
    card.onkeydown=(e)=>{ if(e.target!==card) return;
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openTaskById(card.dataset.id); }
      else if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){ e.preventDefault(); openTaskMenu(card.dataset.id, card); } };
    card.addEventListener('contextmenu',(e)=>{ e.preventDefault(); openTaskMenu(card.dataset.id, card); });
    card.addEventListener('dragstart',e=>{ kDragId=card.dataset.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
    card.addEventListener('dragend',()=>{ kDragId=null; card.classList.remove('dragging'); el.querySelectorAll('.kcol').forEach(c=>c.classList.remove('over')); });
  });
  el.querySelectorAll('.kcol').forEach(col=>{
    col.addEventListener('dragover',e=>{ if(kDragId){ e.preventDefault(); col.classList.add('over'); } });
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',e=>{ e.preventDefault(); col.classList.remove('over'); const id=kDragId; kDragId=null; if(id) kanbanDrop(id, col.dataset.col).catch(err=>{ renderKanban(); showErr(err, 'Não deu pra mover'); }); });
  });
  el.querySelectorAll('[data-kplay]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); startTask(b.dataset.kplay); });
}
// R7: soltar numa coluna que não aceita a mudança explicava nada (o cartão só voltava); concluir uma tarefa com o
// agente trabalhando fechava sem perguntar; e o erro ao concluir era engolido. Agora: aviso do que dá pra fazer,
// askYes antes de tirar da fila algo que ainda está rodando e showErr no erro.
async function kanbanDrop(id, col){
  const t=(state.tasks||[]).find(x=>x.id===id);
  if(!t){ renderKanban(); toast('Essa tarefa é de outro projeto — abra ela (clique no cartão) para mudar de etapa.','warn'); return; }
  if(kanbanCol(t)===col) return;
  if(col==='andamento' && t.status==='draft'){ if(t.repo && t.repo!==state.repo){ renderKanban(); toast('Esse rascunho é de outro projeto — abra '+projShort(t.repo)+' para iniciar.','warn'); return; } startTask(id); return; }
  if(col==='concluidas'){
    // qualquer estado não final (rodando, pausada, plano pra aprovar, perguntando, erro/conflito…) pergunta antes
    const vivo=!['draft','review','delivered','merged','done','cancelled'].includes(t.status)||!!t.busy||pendingOf(id).length>0;
    if(vivo && !await askYes('“'+t.title+'” ainda está em andamento. Concluir tira a tarefa da fila (o trabalho feito fica salvo na branch). Concluir mesmo assim?')){ renderKanban(); return; }
    try{ await invoke('set_task_flag',{ taskId:id, flag:'closed' }); lastSig=''; await refresh(); toast('concluída — saiu da fila','ok'); }
    catch(e){ renderKanban(); showErr(e, 'Não deu pra concluir'); }
    return;
  }
  renderKanban(); // transição não suportada → volta o card, explicando o que dá pra fazer
  toast(t.status==='draft'
    ? 'Rascunho: arraste para “Em andamento” para iniciar, ou para “Concluídas” para tirar da fila.'
    : 'As etapas mudam sozinhas conforme o agente trabalha. Pelo Kanban dá para iniciar um rascunho (arraste para “Em andamento”) ou concluir (arraste para “Concluídas”).','info');
}
async function reorderFlow(dragId, targetId){
  const el=$id("flow");
  const ids=[...el.querySelectorAll('.fcard')].map(c=>c.dataset.id);
  const from=ids.indexOf(dragId), to=ids.indexOf(targetId);
  if(from<0||to<0) return;
  ids.splice(to,0, ids.splice(from,1)[0]);
  try{ await invoke("reorder_tasks",{ ids }); lastSig=""; await refresh(); }
  catch(e){ lastSig=""; renderFlow(); showErr(e, 'Não deu pra reordenar'); } // R7: antes o erro ia só pro console e a ordem voltava sem explicação
}

function pendingOf(taskId){ return (state.pending||[]).filter(p=>p.taskId===taskId); }

// ---------- artefatos da tarefa ----------
const artifactsCache = {}; // taskId -> { status, list }
// Leitura EM VOO é reaproveitada: o quadro re-renderiza a cada ~1s e, com muitas provas (app mobile com
// 80+ prints/vídeos), cada render disparava outro list/read antes do anterior voltar → centenas de chamadas
// empilhadas travavam o app inteiro (até a aba Conta ficava "buscando a conta…"). Uma chamada por vez.
const artInflight = {}; // taskId|status -> Promise
// FILA: no boot a Central pede artefatos/provas de TODA tarefa concluída de todos os projetos (~250 chamadas
// juntas) — o runtime do Tauri entupia e cada resposta redesenhava o quadro inteiro (CPU 100%). Máx. 3 por vez.
const artQ={ running:0, wait:[] };
function artQueued(fn){
  return new Promise((res, rej)=>{
    const go=()=>{ artQ.running++; Promise.resolve().then(fn).then(res, rej).finally(()=>{ artQ.running--; const n=artQ.wait.shift(); if(n) n(); }); };
    if(artQ.running<3) go(); else artQ.wait.push(go);
  });
}
// vários carregamentos terminando juntos → UM redesenho do quadro (antes: um por resposta)
let flowRerenderT=0;
function flowRerenderSoon(){
  if(flowRerenderT) return;
  flowRerenderT=setTimeout(()=>{ flowRerenderT=0; if(typeof activeIs==='function' && activeIs('flow')){ lastSig=''; safe(renderFlow); } }, 250);
}
async function loadArtifacts(taskId, status){
  const c = artifactsCache[taskId];
  if(c && c.status===status) return c.list;
  const k=taskId+'|'+status;
  if(artInflight[k]) return artInflight[k];
  return (artInflight[k] = (async()=>{
    reqProofCache[taskId]=undefined; // status mudou → reavalia as provas
    try{ artifactsCache[taskId] = { status, list: await artQueued(()=>invoke("list_artifacts",{ taskId })) }; }
    catch(e){ artifactsCache[taskId] = { status, list: [] }; }
    return artifactsCache[taskId].list;
  })().finally(()=>{ delete artInflight[k]; }));
}
// ---------- provas por requisito (requirements.json gerado pelo agente) ----------
const reqProofCache={}; // taskId -> {list:[...]|null}
const reqInflight={}; // taskId -> Promise (mesma razão do artInflight)
function loadReqProofs(taskId){
  if(reqInflight[taskId]) return reqInflight[taskId];
  return (reqInflight[taskId]=loadReqProofs1(taskId).finally(()=>{ delete reqInflight[taskId]; }));
}
async function loadReqProofs1(taskId){
  try{ const c=await artQueued(()=>invokeQuiet('read_artifact',{ taskId, name:'requirements.json' })); /* opcional: tarefa sem requisitos não tem o arquivo (não é erro) */ const arr=JSON.parse(c.text||'[]'); reqProofCache[taskId]={list:Array.isArray(arr)?arr:null}; }
  catch(_){ reqProofCache[taskId]={list:null}; }
}
function reqNorm(x){ return String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
// casa cada requirement do spec com o item do requirements.json:
// exato normalizado → mesmo tamanho? por índice → contains (nas duas direções)
function matchReqProofs(reqs, list){
  if(!Array.isArray(list)) return reqs.map(()=>null);
  const byNorm={}; list.forEach(r=>{ byNorm[reqNorm(r.req)]=r; });
  return reqs.map((r,i)=>{
    const n=reqNorm(r);
    if(byNorm[n]) return byNorm[n];
    if(list.length===reqs.length && list[i]) return list[i];
    return list.find(x=>{ const m=reqNorm(x.req); return m&&(m.includes(n)||n.includes(m)); })||null;
  });
}
function artCategory(name){
  const n=name.toLowerCase();
  if(n.startsWith('proof')||n.startsWith('mobile-')||n.includes('screenshot')||n.includes('print')||/\.(mp4|m4v|mov|webm)$/.test(n)) return 'Provas';
  if(n.startsWith('test')||n.includes('spec')) return 'Testes';
  if(n.endsWith('.md')||n.endsWith('.txt')||n.startsWith('architecture')) return 'Docs';
  return 'Outros';
}
function artDate(ms){ if(!ms) return ''; const d=new Date(ms); const today=new Date(); const same=d.toDateString()===today.toDateString(); return (same?'hoje ':d.getDate().toString().padStart(2,'0')+'/'+(d.getMonth()+1).toString().padStart(2,'0')+' ')+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); }
function artItemHtml(x){
  const vm=(x.name||'').match(/-v(\d+)(\.[a-z0-9]+)?$/i);
  const ver=vm?`<span class="artver">v${vm[1]}</span>`:'';
  return `<button class="artitem" data-art="${escA(x.name)}"><span class="artic">${x.kind==='image'?IC.image:x.kind==='video'?IC.play:IC.doc}</span><span class="artnm">${esc(x.name)}${ver}</span><span class="artdate">${artDate(x.created)}</span><span class="artkb">${x.size<1024?x.size+' B':(x.size/1024).toFixed(x.size<10240?1:0)+' KB'}</span></button>`;
}
function artListHtml(a){
  a=(a||[]).filter(x=>x.name!=='requirements.json'); // meta: vira as provas por requisito
  if(!a.length) return '';
  // agrupa por categoria (Docs/Testes/Provas/Outros); dentro, mais recentes primeiro
  const cats=['Provas','Testes','Docs','Outros'];
  const by={}; for(const x of a){ const c=artCategory(x.name); (by[c]||(by[c]=[])).push(x); }
  let html=`<div class="seclbl">Artefatos <span class="n">${a.length}</span></div><div class="artlist">`;
  for(const c of cats){ if(!by[c]||!by[c].length) continue; html+=`<div class="artcat">${c} · ${by[c].length}</div>`+by[c].map(artItemHtml).join(''); }
  return html+`</div>`;
}
async function openArtifact(taskId, name){
  let c;
  try{ c = await invoke("read_artifact",{ taskId, name }); }
  catch(e){ showErr(e, 'Falha ao abrir o artefato'); return; }
  const isHtml=/\.html?$/i.test(name);
  const isPdf=c.kind==='pdf';
  const modal=document.querySelector('#artOverlay .modal'); if(modal) modal.classList.toggle('pdfmode', isPdf);
  const extBtn = isHtml ? `<div style="display:flex;margin-bottom:10px"><button class="btn primary sm" id="artExt">${IC.extlink||'↗'} abrir no navegador</button><span class="dim" style="margin-left:10px;font-size:var(--fs-xs);align-self:center">mockup navegável — abre com as telas clicáveis</span></div>` : '';
  const body = c.kind==='video'
    ? `<div class="pvvideo">${artVideoHtml(taskId, name, 'artvid')}</div>`
    : c.kind==='image'
    ? `<img class="artimg" src="${c.dataUrl}" alt="${escA(name)}">`
    : isPdf
      ? `<iframe class="pdfview" src="${c.dataUrl}#zoom=page-width" title="${escA(name)}"></iframe>`
    : c.kind==='doc'
      ? `<div class="mdview">${mdToHtml(c.text||'')}</div>`
      : c.dataUrl
        ? `<div class="dim" style="padding:20px;text-align:center">arquivo binário — <a href="${c.dataUrl}" download="${escA(name)}" style="color:var(--accent)">baixar ${esc(name)}</a></div>`
        : `<pre class="artpre">${esc(c.text||'')}</pre>`;
  $id("artIcon").innerHTML = c.kind==='image'?IC.image:c.kind==='pdf'?(IC.doc):IC.doc;
  $id("artTitle").textContent = name;
  $id("artBody").innerHTML = extBtn + body;
  // cabeçalho: abrir no Preview (PDF) + enviar pro Slack (qualquer artefato)
  { const h=document.querySelector('#artOverlay .mhead'); ['artOpenExt','artSlack','artFinder','artMdPdf'].forEach(id=>{ const o=$id(id); if(o) o.remove(); });
    if(h){ const x=h.querySelector('#artClose');
      const fd=document.createElement('button'); fd.id='artFinder'; fd.className='btn sm'; fd.style.marginRight='8px'; fd.innerHTML=ic('folder')+'Finder';
      fd.title='revelar o arquivo no Finder'; fd.onclick=()=>invoke('reveal_artifact',{ taskId, name }).catch(e=>showErr(e, 'Falha ao revelar'));
      h.insertBefore(fd, x);
      const sl=document.createElement('button'); sl.id='artSlack'; sl.className='btn sm'; sl.style.marginRight='8px'; sl.innerHTML=ic('send')+'Slack';
      sl.title='enviar este arquivo pra um canal do Slack'; sl.onclick=()=>sendArtifactSlack(taskId, name);
      h.insertBefore(sl, x);
      if(/\.(md|markdown)$/i.test(name)){ const pb=document.createElement('button'); pb.id='artMdPdf'; pb.className='btn sm'; pb.style.marginRight='8px'; pb.innerHTML=ic('doc')+'exportar PDF'; pb.title='gera um PDF formatado deste documento'; pb.onclick=()=>mdArtifactPdf(taskId, name, pb); h.insertBefore(pb, x); }
      if(isPdf){ const bx=document.createElement('button'); bx.id='artOpenExt'; bx.className='btn sm'; bx.style.marginRight='8px'; bx.textContent='↗ abrir no Preview'; bx.onclick=()=>invoke('open_artifact',{ taskId, name }).catch(e=>showErr(e, 'Falha')); h.insertBefore(bx, x); } } }
  bindClick('artExt', ()=>{ invoke('open_artifact',{ taskId, name }).catch(e=>showErr(e, 'Falha ao abrir')); });
  $id("artOverlay").style.display = "flex";
}
function closeArtifact(){ $id("artOverlay").style.display="none"; $id("artBody").innerHTML=""; /* tira o <video> do DOM: para o som */ const m=document.querySelector('#artOverlay .modal'); if(m) m.classList.remove('pdfmode'); ['artOpenExt','artSlack','artMdPdf'].forEach(id=>{ const e=$id(id); if(e) e.remove(); }); }
// envia um artefato pro Slack (bot token no cofre da conta; canal salvo local)
async function sendArtifactSlack(taskId, name){
  try{
    // lê o token direto do cofre (llm.env) — não depende do cache do outro bloco
    let env=''; try{ env=await invoke('read_llm_env'); }catch(_){}
    if(!/(^|\n)\s*SLACK_BOT_TOKEN\s*=\s*\S/.test(env||'')){
      // R8: alert() no Tauri não é confiável (igual ao confirm) — o passo a passo vai num toast com o atalho pra Conta
      toast('Pra enviar ao Slack, guarde antes a chave SLACK_BOT_TOKEN (token xoxb- do bot, com files:write e chat:write) em Conta › Chaves de modelo, e convide o bot no canal (/invite @seu-bot).','warn',
        { label:'abrir Conta', fn:()=>{ if(window.openTab) window.openTab('conta'); } }); return;
    }
    let ch=lsGet('slackChannel')||'';
    const inp=await askText('Canal do Slack','ID do canal (ex.: C0123ABCD) — no Slack: clique no canal → Ver detalhes → ID no rodapé', ch);
    if(inp===null||!inp.trim()) return;
    ch=inp.trim(); lsSet('slackChannel', ch);
    const comment=await askText('Comentário (opcional)','ex.: segue o documento de arquitetura', '');
    if(comment===null) return;
    const msg=await invoke('slack_send_artifact',{ taskId, name, channel:ch, comment });
    toast(msg,'ok');
  }catch(e){ showErr(e, 'Falhou o envio pro Slack'); }
}
// ---- editor de código reutilizável: mono + números de linha + Tab + prévia MD ----
function mountEditor(ta, opts){
  opts=opts||{};
  if(!ta || ta.dataset.ce==='1') return ta;   // já montado
  ta.dataset.ce='1';
  const wrap=document.createElement('div'); wrap.className='ceditor';
  const tabs=document.createElement('div'); tabs.className='cetabs';
  tabs.innerHTML=`<button data-cev="edit" class="on">${ic('edit')}Editar</button>${opts.markdown!==false?'<button data-cev="prev">'+ic('eye')+'Prévia</button>':''}<span class="cehint">${opts.markdown!==false?'markdown · ':''}Tab indenta</span>`;
  const cew=document.createElement('div'); cew.className='cewrap';
  const gut=document.createElement('div'); gut.className='cegutter';
  const prev=document.createElement('div'); prev.className='cepreview mdview'; prev.hidden=true;
  ta.parentNode.insertBefore(wrap, ta);
  wrap.appendChild(tabs); wrap.appendChild(cew); cew.appendChild(gut); cew.appendChild(ta); cew.appendChild(prev);
  ta.classList.add('cearea'); ta.setAttribute('data-tab-indent',''); ta.style.height=''; ta.setAttribute('spellcheck','false'); ta.setAttribute('wrap','off');
  const syncGutter=()=>{ const n=(ta.value.match(/\n/g)||[]).length+1; let s=''; for(let i=1;i<=n;i++) s+=i+'\n'; gut.textContent=s; gut.scrollTop=ta.scrollTop; };
  ta.addEventListener('input', syncGutter);
  ta.addEventListener('scroll', ()=>{ gut.scrollTop=ta.scrollTop; });
  ta.addEventListener('keydown', (e)=>{
    if(e.key==='Tab'){ e.preventDefault();
      const s=ta.selectionStart, en=ta.selectionEnd, v=ta.value;
      if(e.shiftKey){ // dedent: tira até 2 espaços no começo da linha
        const ls=v.lastIndexOf('\n',s-1)+1;
        const rm=v.slice(ls,ls+2)==='  '?2:(v[ls]===' '?1:0);
        if(rm){ ta.value=v.slice(0,ls)+v.slice(ls+rm); ta.selectionStart=ta.selectionEnd=Math.max(ls,s-rm); }
      } else { ta.value=v.slice(0,s)+'  '+v.slice(en); ta.selectionStart=ta.selectionEnd=s+2; }
      syncGutter();
    }
  });
  tabs.querySelectorAll('[data-cev]').forEach(b=>b.onclick=()=>{
    const prevMode=b.dataset.cev==='prev';
    tabs.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    if(prevMode){ prev.innerHTML=mdToHtml(ta.value||'*(vazio)*'); prev.hidden=false; ta.style.display='none'; gut.style.display='none'; }
    else { prev.hidden=true; ta.style.display=''; gut.style.display=''; ta.focus(); }
  });
  syncGutter();
  return ta;
}
// define o valor de um editor montado e volta pro modo Editar com gutter sincronizado
function editorSet(ta, val){
  if(!ta) return; ta.value=val||'';
  const wrap=ta.closest('.ceditor');
  if(wrap){ const edit=wrap.querySelector('[data-cev="edit"]'); if(edit) edit.click(); }
  ta.dispatchEvent(new Event('input'));
}
// mini-renderer de Markdown (headings, listas, code, bold/italic, links, hr, tabelas)
// SEGURANÇA (BUG-1): o texto vem de fora (comentário de PR, saída do agente, artefato) e o app roda com
// csp:null + withGlobalTauri — escapa TUDO (inclusive aspas) e só aceita link http(s)/mailto. O link não
// usa target=_blank (o WKWebView ignora): leva data-exthref e o clique delegado abaixo abre fora (BUG-12).
function mdSafeHref(u){ const raw=String(u||'').replace(/&amp;/g,'&').trim(); return /^(https?:\/\/|mailto:)/i.test(raw)?raw:''; }
// HTML do GitHub dentro do markdown (comentários de bot, corpo de PR): tira comentários <!-- -->, vira
// <a href> em link markdown, <img alt> no texto alternativo, <br> em quebra, e remove o resto das tags
function ghHtmlClean(md){
  return String(md==null?'':md)
    .replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(m,h,l)=>{ const t=l.replace(/<[^>]+>/g,'').trim(); return t?'['+t+']('+h+')':''; })
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi,(m,a)=>a||'')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/?(details|summary|div|p|span|sub|sup|b|i|strong|em|table|thead|tbody|tr|td|th|img|picture|source|h[1-6])\b[^>]*>/gi,'')
    .replace(/\n{3,}/g,'\n\n').trim();
}
function mdToHtml(md){
  md=ghHtmlClean(md);
  const e=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const link=(m,label,url)=>{ const h=mdSafeHref(url); return h?`<a href="${e(h)}" data-exthref="${e(h)}" rel="noreferrer">${label}</a>`:label; };
  const inline=s=>e(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g,'$1<em>$2</em>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,link);
  const lines=String(md).replace(/\r\n/g,'\n').split('\n');
  let html='', inCode=false, code=[], list=null, para=[];
  const fp=()=>{ if(para.length){ html+='<p>'+inline(para.join(' '))+'</p>'; para=[]; } };
  const fl=()=>{ if(list){ html+='</'+list+'>'; list=null; } };
  const isRow=l=>/^\s*\|.*\|\s*$/.test(l), isSep=l=>/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells=l=>l.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.trim().startsWith('```')){ if(inCode){ html+='<pre class="mdcode"><code>'+e(code.join('\n'))+'</code></pre>'; code=[]; inCode=false; } else { fp(); fl(); inCode=true; } continue; }
    if(inCode){ code.push(line); continue; }
    if(isRow(line) && i+1<lines.length && isSep(lines[i+1])){ // tabela GFM
      fp(); fl(); const head=cells(line); i++;
      const body=[]; while(i+1<lines.length && isRow(lines[i+1])){ i++; body.push(cells(lines[i])); }
      html+='<div class="mdtablew"><table class="mdtable"><thead><tr>'+head.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+body.map(r=>'<tr>'+r.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
      continue;
    }
    const h=line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ fp(); fl(); const lv=h[1].length; html+='<h'+lv+'>'+inline(h[2])+'</h'+lv+'>'; continue; }
    if(/^\s*[-*+]\s+/.test(line)){ fp(); if(list!=='ul'){ fl(); html+='<ul>'; list='ul'; } html+='<li>'+inline(line.replace(/^\s*[-*+]\s+/,''))+'</li>'; continue; }
    if(/^\s*\d+[.)]\s+/.test(line)){ fp(); if(list!=='ol'){ fl(); html+='<ol>'; list='ol'; } html+='<li>'+inline(line.replace(/^\s*\d+[.)]\s+/,''))+'</li>'; continue; }
    if(/^\s*(---|\*\*\*|___)\s*$/.test(line)){ fp(); fl(); html+='<hr>'; continue; }
    if(line.trim()===''){ fp(); fl(); continue; }
    para.push(line.trim());
  }
  fp(); fl(); if(inCode&&code.length) html+='<pre class="mdcode"><code>'+e(code.join('\n'))+'</code></pre>';
  return html;
}
// BUG-12: links do Markdown renderizado (e qualquer <a target=_blank> http) abrem no navegador do sistema
document.addEventListener('click', ev=>{
  const a=ev.target&&ev.target.closest&&ev.target.closest('a[data-exthref],a[target="_blank"][href^="http"]'); if(!a) return;
  const href=a.getAttribute('data-exthref')||a.getAttribute('href')||''; if(!/^(https?:\/\/|mailto:)/i.test(href)) return;
  ev.preventDefault(); if(/^mailto:/i.test(href)) return; // o open_url só abre http/https
  if(typeof openExternal==='function') openExternal(href);
});
// ---- PRÉVIA REAL de um entregável (Entrega): imagem · PDF · Markdown · CSV/TSV em tabela · HTML · texto ----
const PV_MAX_ROWS=200;
// CSV/TSV → linhas (aspas, "" escapado, quebra de linha dentro de aspas). Separador: tab, ; ou , (o mais frequente na 1ª linha)
function csvParse(text, sep){
  const s=String(text||'').replace(/^﻿/,'');
  if(!sep){ const first=s.split('\n')[0]||''; const cnt=c=>first.split(c).length-1; sep=['\t',';',','].reduce((b,c)=>cnt(c)>cnt(b)?c:b, ','); }
  const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(q){ if(ch==='"'){ if(s[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=ch; continue; }
    if(ch==='"' && cell===''){ q=true; continue; }
    if(ch===sep){ row.push(cell); cell=''; continue; }
    if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&s[i+1]==='\n') i++; row.push(cell); rows.push(row); row=[]; cell=''; continue; }
    cell+=ch;
  }
  if(cell!==''||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>!(r.length===1&&r[0]===''));
}
function csvTableHtml(text, name){
  const rows=csvParse(text, /\.tsv$/i.test(name||'')?'\t':null);
  if(!rows.length) return '<div class="en-empty">planilha vazia</div>';
  const head=rows[0], body=rows.slice(1, PV_MAX_ROWS+1);
  const more=rows.length-1-body.length;
  return `<div class="pvtable-w"><table class="pvtable"><thead><tr><th class="rn">#</th>${head.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r,i)=>`<tr><td class="rn">${i+1}</td>${head.map((_,j)=>`<td>${esc(r[j]==null?'':r[j])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`+
    `<div class="pvnote">${rows.length-1} linha${rows.length-1===1?'':'s'} · ${head.length} coluna${head.length===1?'':'s'}${more>0?` · mostrando as primeiras ${PV_MAX_ROWS} — abra no app padrão pra ver tudo`:''}</div>`;
}
function pvKind(name){ const n=String(name||'').toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg)$/.test(n)?'image' : /\.(mp4|m4v|mov|webm)$/.test(n)?'video' : /\.pdf$/.test(n)?'pdf' : /\.(md|markdown)$/.test(n)?'md' : /\.(csv|tsv)$/.test(n)?'csv'
    : /\.html?$/.test(n)?'html' : /\.(txt|log|json|ya?ml|xml|js|ts|py|sql|sh|toml|ini)$/.test(n)?'text' : 'other'; }
// VÍDEO das provas (mobile): toca DIRETO do disco pelo protocolo sfart:// (lib.rs → media_proto.rs) — nada de
// base64; o WebKit pede em pedaços (Range), então um mp4 grande não trava a UI. Escopo: só as pastas de artefatos.
// nome citado pelo agente → nome do artefato (MESMA regra do Rust artifact_norm_name): "./x.png",
// ".cardume/artifacts/<tarefa>/x.png" e caminho ABSOLUTO da worktree/repo (".../.cardume/artifacts/x.png") → "x.png"
function artRelName(taskId, name){
  let n=String(name||'').trim();
  const k=n.lastIndexOf('.cardume/artifacts/'); if(k>=0) n=n.slice(k+19);
  n=n.replace(/^(\.\/)+/,'');
  if(taskId && n.startsWith(taskId+'/')) n=n.slice(String(taskId).length+1);
  return n;
}
function artMediaUrl(taskId, name){
  const rel=String(taskId||'')+'/'+artRelName(taskId, name);
  const cv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.convertFileSrc;
  return cv ? cv(rel, 'sfart') : 'sfart://localhost/'+encodeURIComponent(rel);
}
function artVideoHtml(taskId, name, cls){
  // data-sfthumb: arquivo sumiu (404 no sfart://) → 27-entregas troca por "arquivo da prova não encontrado"
  return `<video class="${cls||'pvvid'}" controls preload="metadata" playsinline src="${escA(artMediaUrl(taskId, name))}" data-sfthumb="${escA(taskId+'|'+name)}" aria-label="${escA('vídeo: '+name)}"></video>`;
}
// conteúdo já lido (read_artifact) → HTML da prévia
function artPreviewHtml(name, c, taskId){
  const k=pvKind(name);
  if(k==='video' && taskId) return `<div class="pvvideo">${artVideoHtml(taskId, name)}</div>`; // não precisa ler o arquivo
  if(!c) return skeletonHtml('lista',{ n:6, compact:true, inline:true, label:'carregando a prévia' });
  // erro em texto de gente (humanErr: catálogo de erros) — arquivo que sumiu diz isso, não a mensagem crua
  if(c.err) return /não encontrado|not found|No such file/i.test(String(c.err))
    ? `<div class="en-empty">arquivo não encontrado — ainda não foi gerado ou já foi removido</div>`
    : `<div class="en-empty" style="color:var(--warn)">${esc(typeof humanErr==='function'?humanErr(c.err,'Não consegui ler o arquivo').msg:'não consegui ler o arquivo: '+c.err)}</div>`;
  if(k==='image' && c.dataUrl) return `<div class="pvimg"><img src="${c.dataUrl}" alt="${escA(name)}"></div>`;
  if(k==='pdf' && c.dataUrl) return `<iframe class="pvpdf" src="${c.dataUrl}#zoom=page-width" title="${escA(name)}"></iframe>`;
  const tx=c.text==null?null:String(c.text);
  if(tx==null) return `<div class="en-empty">este formato não tem prévia aqui — use <b>abrir no app padrão</b></div>`;
  const big=tx.length>400000; const t=big?tx.slice(0,400000):tx;
  if(k==='md') return `<div class="mdview pvmd">${mdToHtml(t)}</div>`;
  if(k==='csv') return csvTableHtml(t, name);
  if(k==='html') return `<iframe class="pvhtml" sandbox="" srcdoc="${escA(t)}" title="${escA(name)}"></iframe>`; // sandbox vazio: sem script
  return `<pre class="artpre pvtext">${esc(t)}</pre>${big?'<div class="pvnote">arquivo grande — mostrando o começo</div>':''}`;
}
// BUG-23: Markdown → PDF (mesmo gerador do daily/relatório)
async function mdArtifactPdf(taskId, name, btn){
  const o=btn?btn.innerHTML:''; if(btn){ btn.disabled=true; btn.textContent='gerando PDF…'; }
  try{ const c=await invoke('read_artifact',{ taskId, name }); const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(c.text||'', new Date().toLocaleDateString('pt-BR')), name:(taskId+'-'+name).replace(/\.(md|markdown)$/i,'').replace(/[\/\\]/g,'-') });
    toast('PDF salvo'+(p?' em '+p:''),'ok'); }
  catch(e){ showErr(e, 'Falhou o PDF'); }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=o; } }
}

async function sendRework(taskId, inputEl, prefix){
  if(!inputEl) return;
  const v=(inputEl.value||'').trim(); if(!v) return;
  inputEl.disabled=true;
  try{
    await invoke("rework_task",{ taskId, text:(prefix||'')+v });
    inputEl.value=""; closeCommit(); lastSig=""; await refresh();
  }catch(e){ showErr(e, 'Falha ao pedir ajuste'); }
  finally{ if(inputEl){ inputEl.disabled=false; } }
}
async function resolvePending(id, answer){
  if(+id<0 && typeof budgetAnswer==='function') return budgetAnswer(+id, answer); // pergunta do teto de custo (sintética)
  // E2 (bug #2): o erro SOBE — quem chamou (fwSendMsg) devolve o texto digitado ao campo e mostra o erro.
  // Antes era engolido aqui: o input já tinha sido limpo e a resposta sumia sem aviso.
  await invoke("resolve_pending", { id, answer });
  refresh().catch(()=>{}); // sem await: quem respondeu não espera o snapshot (podia levar até 8s)
}
/** Bloco compacto no painel: preview da pergunta + botão que abre o MODAL. */
