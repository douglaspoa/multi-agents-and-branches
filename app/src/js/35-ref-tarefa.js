// Constellation — 35-ref-tarefa
// ---- "/" referencia uma tarefa JÁ FEITA ao abrir uma nova ----
// Digitou "/" (no começo ou depois de espaço) numa descrição da Nova demanda ou no
// "montar conversando": abre o seletor com as últimas tarefas feitas (mais recentes
// primeiro), busca por nome e escolha de projeto. A escolhida entra no texto como
// [tarefa #id: título]; ao criar, o token vira contexto pro agente (branch, PR,
// objetivo, resumo da entrega) e os docs da entrega vão como anexo (.cardume/refs/).
const TRF_FIELDS=['ntObj','ntFixObj','ntDzObj','ntInvObj','plInput'];
const TRF_TOKEN=/\[tarefa #([^\s:\]]+):[^\]]*\]/g;
let trfCache=null, trfAt=0, trfLoading=null;
const trfPicked={}; // id → tarefa escolhida (a fonte mais confiável na hora de expandir)
let trfPop=null; // { ta, at, proj, q, sel, items }
async function trfLoad(force){
  if(!force && trfCache && Date.now()-trfAt<15000) return trfCache;
  if(trfLoading) return trfLoading;
  trfLoading=invoke('list_done_tasks').then(r=>{ trfCache=Array.isArray(r)?r:[]; trfAt=Date.now(); return trfCache; })
    .catch(()=>trfCache||[]).finally(()=>{ trfLoading=null; });
  return trfLoading;
}
function trfStatusTx(t){ return t.status==='merged'?'mergeada':t.status==='done'?'concluída':t.flag==='closed'?'finalizada':t.status==='review'?'entregue · em review':t.status; }
function trfAgo(ms){ if(!ms) return ''; const s=(Date.now()-ms)/1000; if(s<3600) return Math.max(1,Math.floor(s/60))+'min'; if(s<86400) return Math.floor(s/3600)+'h'; if(s<86400*30) return Math.floor(s/86400)+'d'; return new Date(ms).toLocaleDateString('pt-BR',{ day:'2-digit', month:'short' }); }
function trfNorm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function trfFiltered(){
  const p=trfPop; if(!p) return [];
  const q=trfNorm(p.q).split(/\s+/).filter(Boolean);
  return (trfCache||[]).filter(t=>(p.proj==='*'||t.repo===p.proj) && q.every(w=>trfNorm(t.title+' '+t.branch+' '+t.id).includes(w))).slice(0,60);
}
function trfProjects(){
  const m=new Map(); if(state.repo) m.set(state.repo, projShort(state.repo));
  (trfCache||[]).forEach(t=>{ if(!m.has(t.repo)) m.set(t.repo, t.proj||projShort(t.repo)); });
  return [...m.entries()];
}
function trfOpen(ta, at){
  trfClose();
  const el=document.createElement('div'); el.className='trfpop'; el.id='trfPop';
  document.body.appendChild(el);
  trfPop={ ta, at, el, proj:(lsGet('trf:all')==='1'||!state.repo)?'*':state.repo, q:'', sel:0 };
  trfRender(true);
  trfPlace();
  trfLoad().then(()=>{ if(!trfPop) return; if(trfPop.proj!=='*' && !trfProjects().some(([p])=>p===trfPop.proj)) trfPop.proj='*'; trfRender(); });
}
function trfPlace(){
  const p=trfPop; if(!p) return;
  const r=p.ta.getBoundingClientRect(), h=p.el.offsetHeight||340, w=Math.min(520, window.innerWidth-24);
  p.el.style.width=w+'px';
  p.el.style.left=Math.max(12, Math.min(r.left, window.innerWidth-w-12))+'px';
  const below=r.bottom+6, fitsBelow=below+h<window.innerHeight-8;
  p.el.style.top=(fitsBelow?below:Math.max(8, r.top-h-6))+'px';
}
function trfClose(back){
  if(!trfPop) return;
  const { el, ta }=trfPop; trfPop=null; el.remove();
  if(back && ta){ ta.focus(); }
}
function trfRender(first){
  const p=trfPop; if(!p) return;
  const items=p.items=trfFiltered();
  if(p.sel>=items.length) p.sel=Math.max(0,items.length-1);
  const projs=trfProjects();
  const loading=!trfCache;
  const list=loading?'<div class="trfempty">carregando tarefas feitas…</div>'
    : !items.length?`<div class="trfempty">${p.q?'nenhuma tarefa feita com “'+esc(p.q)+'”':'nenhuma tarefa feita '+(p.proj==='*'?'ainda':'neste projeto')}${p.proj!=='*'?' — <button class="btn sm" data-trfall>ver todos os projetos</button>':''}</div>`
    : items.map((t,i)=>`<div class="trfit${i===p.sel?' on':''}" data-trfi="${i}"><div class="trft">${esc(t.title)}</div><div class="trfm">${p.proj==='*'?`<span class="trfproj">${esc(t.proj)}</span>`:''}<span class="trfst ${t.status==='review'?'rv':''}">${esc(trfStatusTx(t))}</span><span>${esc(trfAgo(t.finishedAt))}</span>${t.branch?`<span class="mono">${esc(t.branch)}</span>`:''}</div></div>`).join('');
  if(first){
    p.el.innerHTML=`<div class="trfhead"><span class="trfslash mono">/</span><input class="in" id="trfQ" placeholder="buscar tarefa feita…" autocomplete="off" spellcheck="false"><select class="sel" id="trfProj" title="projeto"></select></div><div class="trflist" id="trfList"></div><div class="trffoot dim">↑↓ navegar · enter referenciar · esc fechar</div>`;
    const q=$id('trfQ');
    q.oninput=()=>{ p.q=q.value; p.sel=0; trfRender(); };
    q.onkeydown=trfKey;
    $id('trfProj').onchange=e=>{ p.proj=e.target.value; lsSet('trf:all',p.proj==='*'?'1':'0'); p.sel=0; trfRender(); q.focus(); };
    setTimeout(()=>q.focus(),0);
  }
  const ps=$id('trfProj');
  ps.innerHTML=`<option value="*">Todos os projetos</option>`+projs.map(([path,name])=>`<option value="${escA(path)}">${esc(name)}${path===state.repo?' (atual)':''}</option>`).join('');
  ps.value=p.proj;
  const L=$id('trfList'); L.innerHTML=list;
  L.querySelectorAll('[data-trfi]').forEach(d=>{ d.onmousedown=e=>{ e.preventDefault(); trfPick(items[+d.dataset.trfi]); }; d.onmousemove=()=>{ if(p.sel!==+d.dataset.trfi){ p.sel=+d.dataset.trfi; L.querySelectorAll('.trfit').forEach((x,j)=>x.classList.toggle('on',j===p.sel)); } }; });
  L.querySelectorAll('[data-trfall]').forEach(b=>b.onmousedown=e=>{ e.preventDefault(); p.proj='*'; lsSet('trf:all','1'); trfRender(); $id('trfQ').focus(); });
  const on=L.querySelector('.trfit.on'); if(on) on.scrollIntoView({ block:'nearest' });
}
function trfKey(e){
  const p=trfPop; if(!p) return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); const n=p.items.length; if(!n) return; p.sel=(p.sel+(e.key==='ArrowDown'?1:-1)+n)%n; trfRender(); }
  else if(e.key==='Enter'){ e.preventDefault(); e.stopPropagation(); if(p.items[p.sel]) trfPick(p.items[p.sel]); }
  else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); trfClose(true); } // o "/" fica no texto
  else if(e.key==='Backspace' && !p.q){ // apagar com a busca vazia desfaz o "/" e volta pro texto
    e.preventDefault(); const { ta, at }=p; trfClose(true);
    if(ta.value[at]==='/'){ ta.value=ta.value.slice(0,at)+ta.value.slice(at+1); ta.setSelectionRange(at,at); ta.dispatchEvent(new Event('input',{ bubbles:true })); }
  }
}
function trfPick(t){
  const p=trfPop; if(!p||!t) return;
  const { ta, at }=p; trfClose();
  trfPicked[t.id]=t;
  const tok=`[tarefa #${t.id}: ${String(t.title).replace(/[\[\]]/g,'').trim()}] `;
  const v=ta.value, hasSlash=v[at]==='/';
  ta.value=v.slice(0,at)+tok+v.slice(at+(hasSlash?1:0));
  const c=at+tok.length; ta.focus(); ta.setSelectionRange(c,c);
  ta.dispatchEvent(new Event('input',{ bubbles:true })); // gate/rascunho/estado da aba enxergam a mudança
}
function trfWire(id){
  const ta=$id(id); if(!ta || ta.dataset.trf) return; ta.dataset.trf='1';
  ta.addEventListener('input',e=>{
    if(trfPop || e.inputType!=='insertText' || e.data!=='/') return;
    const at=ta.selectionStart-1, prev=at>0?ta.value[at-1]:'';
    if(ta.value[at]==='/' && (!prev || /\s/.test(prev))) trfOpen(ta, at);
  });
}
document.addEventListener('mousedown',e=>{ if(trfPop && !trfPop.el.contains(e.target)) trfClose(); });
window.addEventListener('resize',()=>trfPlace());
document.addEventListener('scroll',()=>{ if(trfPop) trfPlace(); }, true);
TRF_FIELDS.forEach(trfWire);
// ---- expansão: tokens do texto → tarefas (a escolhida na sessão; senão pelo cache) ----
async function trfResolve(text){
  const ids=[...new Set([...String(text||'').matchAll(TRF_TOKEN)].map(m=>m[1]))];
  if(!ids.length) return [];
  if(ids.some(id=>!trfPicked[id])) await trfLoad();
  return ids.map(id=>trfPicked[id]||(trfCache||[]).find(t=>t.id===id)).filter(Boolean);
}
function trfBlock(tasks){
  if(!tasks.length) return '';
  return '\n\n[TAREFAS DE REFERÊNCIA — já feitas; use como contexto e ponto de partida, não refaça o que já existe]\n'+tasks.map(t=>{
    const docs=(t.docs||[]).map(d=>d.split('/').pop());
    return `- #${t.id} "${t.title}" — projeto ${t.proj}${t.repo!==state.repo?' (OUTRO repo: '+t.repo+')':''} · ${trfStatusTx(t)} · branch ${t.branch||'—'}${t.prUrl?' · PR '+t.prUrl:''}\n`+
      (t.objective?`  Objetivo: ${String(t.objective).replace(/\s*\n\s*/g,' ').slice(0,700)}\n`:'')+
      (t.summary?`  O que foi entregue: ${String(t.summary).replace(/\s*\n\s*/g,' ')}\n`:'')+
      (docs.length?`  Docs da entrega anexados em .cardume/refs/ (${docs.join(', ')}).\n`:'')+
      (t.repo===state.repo&&t.branch?`  Pra ver o código: git log/diff da branch ${t.branch} (ou do merge dela).\n`:'');
  }).join('')+'[/TAREFAS DE REFERÊNCIA]';
}
// chamado ao criar (formulário, rascunho e planner): acrescenta o bloco ao objetivo e os docs aos anexos
async function trfApply(payload, extraText){
  try{
    if(/\[TAREFAS DE REFERÊNCIA/.test(payload.objective||'')) return payload; // já expandido
    const tasks=await trfResolve((payload.objective||'')+'\n'+(extraText||''));
    if(!tasks.length) return payload;
    payload.objective=((payload.objective||payload.title||'')+trfBlock(tasks)).trim();
    const refs=payload.refs=Array.isArray(payload.refs)?payload.refs:[];
    tasks.forEach(t=>(t.docs||[]).forEach(d=>{ if(!refs.includes(d)) refs.push(d); }));
  }catch(e){ console.warn('ref tarefa:', e); } // referência é contexto extra — nunca impede a criação
  return payload;
}
window.trfApply=trfApply;
window.trfPromptBlock=async text=>trfBlock(await trfResolve(text));
