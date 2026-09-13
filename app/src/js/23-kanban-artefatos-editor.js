// Constellation — 23-kanban-artefatos-editor
// ---------- Kanban ----------
const KCOLS=[['rascunho','Rascunho'],['rodando','Rodando'],['precisa','Precisa de você'],['review','Em review'],['mergeada','Mergeada'],['encerrada','Encerradas']];
function kanbanCol(t){
  if(t.flag==='closed') return 'encerrada';
  if(t.status==='draft') return 'rascunho';
  if(t.status==='merged') return 'mergeada';
  if(t.status==='plan-review' || pendingOf(t.id).length || t.status==='error' || t.status==='aborted') return 'precisa';
  if(t.status==='review') return 'review';
  return 'rodando'; // running/thinking/queued/paused
}
function kCard(t){
  const roles=t.roles||[]; const curIdx=roles.findIndex(r=>r.role===t.stage);
  const crew=roles.map((r,i)=>`<span class="kav" style="background:${r.role===t.stage?'var(--accent)':agentColor(r.name)};${(curIdx>=0&&i>curIdx)?'opacity:.4':''}" title="${escA(r.name)}">${esc((r.name||'?').slice(0,2).toUpperCase())}</span>`).join('');
  const ev=lastEventOf(t.id);
  const amber = t.status==='plan-review'||pendingOf(t.id).length||t.status==='aborted';
  const note = t.status==='plan-review'?'plano pronto · aprove pra continuar'
    : pendingOf(t.id).length?'perguntou — responda'
    : t.status==='review'?'review pronto · aprovar ou pedir ajuste'
    : t.status==='error'?'erro — veja o log'
    : t.status==='aborted'?'abortada — descarte ou refaça'
    : t.status==='paused'?'pausada — retome quando quiser'
    : ACTIVE_ST.has(t.status)?(ev?((GLYPH[ev.type]||'·')+' '+ev.text):(t.agent+' trabalhando')):'';
  return `<div class="kcard${t.id===selected?' sel':''}${pendingOf(t.id).length?' asking':''}" draggable="true" data-id="${t.id}">
    <div class="kctop">${t.status==='draft'?`<button class="kplay" data-kplay="${t.id}" title="iniciar">${IC.cright}</button>`:''}<b class="ktitle">${esc(t.title)}</b></div>
    <div class="kcrew">${crew}</div>
    ${note?`<div class="knote${amber?' amber':''}">${esc(note.length>64?note.slice(0,63)+'…':note)}</div>`:''}
  </div>`;
}
let kDragId=null;
function renderKanban(){
  const el=$id('kanban');
  const byCol={}; KCOLS.forEach(([k])=>byCol[k]=[]);
  for(const t of (state.tasks||[]).filter(t=>t.flag!=='blocked'||flowShowBlocked)) (byCol[kanbanCol(t)]||byCol.rodando).push(t);
  el.innerHTML = KCOLS.map(([k,label])=>`<div class="kcol" data-col="${k}"><div class="kcolh">${label} <span class="kn">${byCol[k].length}</span></div><div class="kcolbody">${byCol[k].map(kCard).join('')||'<div class="kempty">—</div>'}</div></div>`).join('');
  el.querySelectorAll('.kcard').forEach(card=>{
    card.onclick=(e)=>{ if(e.target.closest('.kplay')) return; openTaskById(card.dataset.id); };
    card.addEventListener('dragstart',e=>{ kDragId=card.dataset.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
    card.addEventListener('dragend',()=>{ kDragId=null; card.classList.remove('dragging'); el.querySelectorAll('.kcol').forEach(c=>c.classList.remove('over')); });
  });
  el.querySelectorAll('.kcol').forEach(col=>{
    col.addEventListener('dragover',e=>{ if(kDragId){ e.preventDefault(); col.classList.add('over'); } });
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',e=>{ e.preventDefault(); col.classList.remove('over'); const id=kDragId; kDragId=null; if(id) kanbanDrop(id, col.dataset.col); });
  });
  el.querySelectorAll('[data-kplay]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); startTask(b.dataset.kplay); });
}
function kanbanDrop(id, col){
  const t=(state.tasks||[]).find(x=>x.id===id); if(!t) return;
  if(kanbanCol(t)===col) return;
  if(col==='rodando' && t.status==='draft') startTask(id);
  else if(col==='mergeada' && t.status==='review') mergeTask(id);
  else if(col==='encerrada'){ invoke('set_task_flag',{ taskId:id, flag:'closed' }).then(()=>{ lastSig=''; refresh(); }).catch(()=>renderKanban()); }
  else renderKanban(); // transição não suportada → volta o card
}
async function reorderFlow(dragId, targetId){
  const el=$id("flow");
  const ids=[...el.querySelectorAll('.fcard')].map(c=>c.dataset.id);
  const from=ids.indexOf(dragId), to=ids.indexOf(targetId);
  if(from<0||to<0) return;
  ids.splice(to,0, ids.splice(from,1)[0]);
  try{ await invoke("reorder_tasks",{ ids }); lastSig=""; await refresh(); }
  catch(e){ console.error("reorder_tasks", e); }
}
function commitsBlock(taskId){
  const c=commitsCache[taskId];
  if(c===undefined){ loadCommits(taskId).then(()=>{ if(selected===taskId) renderSide(); }); return '<div class="seclbl">Commits</div><div class="dim" style="font-size:12px">…</div>'; }
  if(!c.length) return '';
  const ag=((state.tasks||[]).find(x=>x.id===taskId)||{}).agent||'';
  return `<div class="seclbl">Commits <span class="n">${c.length}</span></div><div class="sidecommits">${c.map(x=>commitChip(x,ag)).join("")}</div>`;
}
function errBanner(t){
  if(t.status!=='error' && t.status!=='conflict') return '';
  const e = eventsOf(t.id).filter(x=>x.type==='error').slice(-1)[0];
  return `<div class="errbox">${esc(e?e.text:(t.status==='conflict'?'conflito de merge — resolva manualmente':'erro no agente'))}</div>`;
}

function pendingOf(taskId){ return (state.pending||[]).filter(p=>p.taskId===taskId); }

// ---------- artefatos da tarefa ----------
const artifactsCache = {}; // taskId -> { status, list }
async function loadArtifacts(taskId, status){
  const c = artifactsCache[taskId];
  if(c && c.status===status) return c.list;
  reqProofCache[taskId]=undefined; // status mudou → reavalia as provas
  try{ artifactsCache[taskId] = { status, list: await invoke("list_artifacts",{ taskId }) }; }
  catch(e){ artifactsCache[taskId] = { status, list: [] }; }
  return artifactsCache[taskId].list;
}
// ---------- provas por requisito (requirements.json gerado pelo agente) ----------
const reqProofCache={}; // taskId -> {list:[...]|null}
async function loadReqProofs(taskId){
  try{ const c=await invoke('read_artifact',{ taskId, name:'requirements.json' }); const arr=JSON.parse(c.text||'[]'); reqProofCache[taskId]={list:Array.isArray(arr)?arr:null}; }
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
function reqsBlock(t){
  const reqs=Array.isArray(t.requirements)?t.requirements:[]; if(!reqs.length) return '';
  const c=reqProofCache[t.id];
  if(c===undefined){ loadReqProofs(t.id).then(()=>{ if(selected===t.id) renderSide(); }); }
  const matched=matchReqProofs(reqs, c&&c.list);
  const rows=reqs.map((r,ri)=>{
    const m=matched[ri];
    const st=m?(m.status==='done'?'ok':'blk'):'na';
    const icon= st==='ok'?`<span class="reqst ok">${IC.check}</span>` : st==='blk'?'<span class="reqst blk">!</span>' : '<span class="reqst na">·</span>';
    const ev=(m&&Array.isArray(m.evidence)&&m.evidence.length)?`<span class="reqev">${m.evidence.map(e=>`<button class="reqevb mono" data-art="${escA(e)}">${esc(e)}</button>`).join('')}</span>`:'';
    const note=(m&&m.note&&st==='blk')?`<div class="reqnote">${esc(m.note)}</div>`:'';
    return `<div class="critrow2 ${st}">${icon}<div class="crt"><div>${esc(r)} ${ev}</div>${note}</div></div>`;
  }).join('');
  const canCheck=(!c||c.list===null)&&['review','error','aborted'].includes(t.status)&&(t.roles||[]).some(r=>r.engine==='claude');
  const hint=(c&&c.list===null)?(canCheck?'<button class="btn sm" id="brReqCheck" style="margin-top:6px">verificar requisitos agora (gera as provas)</button>':'<div class="dim" style="font-size:10.5px;margin-top:4px">provas por requisito aparecem quando o agente gera o requirements.json</div>'):'';
  return `<div class="seclbl">Critérios de aceite <span class="n">${reqs.length}</span></div>${rows}${hint}`;
}
function artCategory(name){
  const n=name.toLowerCase();
  if(n.startsWith('proof')||n.includes('screenshot')||n.includes('print')) return 'Provas';
  if(n.startsWith('test')||n.includes('spec')) return 'Testes';
  if(n.endsWith('.md')||n.endsWith('.txt')||n.startsWith('architecture')) return 'Docs';
  return 'Outros';
}
function artDate(ms){ if(!ms) return ''; const d=new Date(ms); const today=new Date(); const same=d.toDateString()===today.toDateString(); return (same?'hoje ':d.getDate().toString().padStart(2,'0')+'/'+(d.getMonth()+1).toString().padStart(2,'0')+' ')+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); }
function artItemHtml(x){
  const vm=(x.name||'').match(/-v(\d+)(\.[a-z0-9]+)?$/i);
  const ver=vm?`<span class="artver">v${vm[1]}</span>`:'';
  return `<button class="artitem" data-art="${escA(x.name)}"><span class="artic">${x.kind==='image'?IC.image:IC.doc}</span><span class="artnm">${esc(x.name)}${ver}</span><span class="artdate">${artDate(x.created)}</span><span class="artkb">${x.size<1024?x.size+' B':(x.size/1024).toFixed(x.size<10240?1:0)+' KB'}</span></button>`;
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
function artifactsBlock(t){
  const c = artifactsCache[t.id];
  if(!c || c.status!==t.status){ loadArtifacts(t.id, t.status).then(()=>{ if(selected===t.id) renderSide(); }); return c ? artListHtml(c.list) : ''; }
  return artListHtml(c.list);
}
async function openArtifact(taskId, name){
  let c;
  try{ c = await invoke("read_artifact",{ taskId, name }); }
  catch(e){ alert("Falha ao abrir o artefato:\n"+e); return; }
  const isHtml=/\.html?$/i.test(name);
  const isPdf=c.kind==='pdf';
  const modal=document.querySelector('#artOverlay .modal'); if(modal) modal.classList.toggle('pdfmode', isPdf);
  const extBtn = isHtml ? `<div style="display:flex;margin-bottom:10px"><button class="btn primary sm" id="artExt">${IC.extlink||'↗'} abrir no navegador</button><span class="dim" style="margin-left:10px;font-size:11px;align-self:center">mockup navegável — abre com as telas clicáveis</span></div>` : '';
  const body = c.kind==='image'
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
  { const h=document.querySelector('#artOverlay .mhead'); ['artOpenExt','artSlack','artFinder'].forEach(id=>{ const o=$id(id); if(o) o.remove(); });
    if(h){ const x=h.querySelector('#artClose');
      const fd=document.createElement('button'); fd.id='artFinder'; fd.className='btn sm'; fd.style.marginRight='8px'; fd.innerHTML=ic('folder')+'Finder';
      fd.title='revelar o arquivo no Finder'; fd.onclick=()=>invoke('reveal_artifact',{ taskId, name }).catch(e=>alert('Falha ao revelar:\n'+e));
      h.insertBefore(fd, x);
      const sl=document.createElement('button'); sl.id='artSlack'; sl.className='btn sm'; sl.style.marginRight='8px'; sl.innerHTML=ic('send')+'Slack';
      sl.title='enviar este arquivo pra um canal do Slack'; sl.onclick=()=>sendArtifactSlack(taskId, name);
      h.insertBefore(sl, x);
      if(isPdf){ const bx=document.createElement('button'); bx.id='artOpenExt'; bx.className='btn sm'; bx.style.marginRight='8px'; bx.textContent='↗ abrir no Preview'; bx.onclick=()=>invoke('open_artifact',{ taskId, name }).catch(e=>alert('Falha:\n'+e)); h.insertBefore(bx, x); } } }
  bindClick('artExt', ()=>{ invoke('open_artifact',{ taskId, name }).catch(e=>alert('Falha ao abrir:\n'+e)); });
  $id("artOverlay").style.display = "flex";
}
function closeArtifact(){ $id("artOverlay").style.display="none"; $id("artBody").innerHTML=""; const m=document.querySelector('#artOverlay .modal'); if(m) m.classList.remove('pdfmode'); ['artOpenExt','artSlack'].forEach(id=>{ const e=$id(id); if(e) e.remove(); }); }
// envia um artefato pro Slack (bot token no cofre da conta; canal salvo local)
async function sendArtifactSlack(taskId, name){
  try{
    // lê o token direto do cofre (llm.env) — não depende do cache do outro bloco
    let env=''; try{ env=await invoke('read_llm_env'); }catch(_){}
    if(!/(^|\n)\s*SLACK_BOT_TOKEN\s*=\s*\S/.test(env||'')){
      alert('Configure primeiro o bot do Slack:\n\n1) Conta (botão da nuvem) → Chaves de modelo → + adicionar chave\n2) Nome: SLACK_BOT_TOKEN · Valor: o token do bot (xoxb-…) com os escopos files:write e chat:write\n3) No Slack, convide o bot no canal (/invite @seu-bot)\n\nDepois volte aqui e envie.'); return;
    }
    let ch=lsGet('slackChannel')||'';
    const inp=await askText('Canal do Slack','ID do canal (ex.: C0123ABCD) — no Slack: clique no canal → Ver detalhes → ID no rodapé', ch);
    if(inp===null||!inp.trim()) return;
    ch=inp.trim(); lsSet('slackChannel', ch);
    const comment=await askText('Comentário (opcional)','ex.: segue o documento de arquitetura', '');
    if(comment===null) return;
    const msg=await invoke('slack_send_artifact',{ taskId, name, channel:ch, comment });
    alert('✔ '+msg);
  }catch(e){ alert('Falhou o envio pro Slack:\n'+(e&&e.message||e)); }
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
  ta.classList.add('cearea'); ta.style.height=''; ta.setAttribute('spellcheck','false'); ta.setAttribute('wrap','off');
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
// mini-renderer de Markdown (headings, listas, code, bold/italic, links, hr)
function mdToHtml(md){
  const e=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const inline=s=>e(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g,'$1<em>$2</em>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines=String(md).replace(/\r\n/g,'\n').split('\n');
  let html='', inCode=false, code=[], list=null, para=[];
  const fp=()=>{ if(para.length){ html+='<p>'+inline(para.join(' '))+'</p>'; para=[]; } };
  const fl=()=>{ if(list){ html+='</'+list+'>'; list=null; } };
  for(const line of lines){
    if(line.trim().startsWith('```')){ if(inCode){ html+='<pre class="mdcode"><code>'+e(code.join('\n'))+'</code></pre>'; code=[]; inCode=false; } else { fp(); fl(); inCode=true; } continue; }
    if(inCode){ code.push(line); continue; }
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

async function sendRework(taskId, inputEl, prefix){
  if(!inputEl) return;
  const v=(inputEl.value||'').trim(); if(!v) return;
  inputEl.disabled=true;
  try{
    await invoke("rework_task",{ taskId, text:(prefix||'')+v });
    inputEl.value=""; closeCommit(); lastSig=""; await refresh();
  }catch(e){ alert("Falha ao pedir ajuste:\n"+e); }
  finally{ if(inputEl){ inputEl.disabled=false; } }
}
async function sendInstruction(taskId){
  const inp=$id('instrInput'); if(!inp) return;
  const text=inp.value.trim(); if(!text) return;
  inp.disabled=true;
  try{ await invoke("add_instruction",{ taskId, text }); inp.value=""; lastSig=""; await refresh(); }
  catch(e){ alert("Falha ao enviar instrução:\n"+e); }
  finally{ const i2=$id('instrInput'); if(i2){ i2.disabled=false; i2.focus(); } }
}
async function resolvePending(id, answer){
  try{ await invoke("resolve_pending", { id, answer }); await refresh(); }
  catch(e){ console.error("resolve_pending", e); }
}
/** Bloco compacto no painel: preview da pergunta + botão que abre o MODAL. */
function questionBlock(taskId){
  const ps = pendingOf(taskId);
  if(ps.length===0) return "";
  return ps.map(p=>`<div class="qbox"><div class="qh">${IC.q} ${esc(p.agent)} está esperando você</div><div class="qq clamp3">${esc(p.prompt)}</div><div class="qc"><button class="btn primary sm" data-askopen="${p.id}">${IC.q} Responder ›</button></div></div>`).join("");
}
function wireQuestion(root){
  root.querySelectorAll("[data-askopen]").forEach(b=>b.onclick=()=>openAsk(+b.dataset.askopen));
}
