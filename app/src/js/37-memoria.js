/* ===== MEMÓRIA DO PROJETO — o cérebro (notas .md ligadas por [[links]], compatível com Obsidian) =====
   Aba "memoria": lista + busca, nota renderizada com [[links]] clicáveis e backlinks, editor, nova nota,
   grafo, mover entre time/local e "abrir no Obsidian". Os arquivos moram em <repo>/.cardume/memoria/
   (local) e .cardume/memoria/time/ (espelho do cérebro do TIME, tabela brain_notes — sync mais-recente-vence).
   Rust: app/src-tauri/src/memoria.rs · motor: src/memory.ts. */

// @puro-inicio — funções sem DOM (testadas em app/tests/memoria.test.mjs)
const MEM_TYPES=['decisão','regra','gotcha','contexto','pessoa','glossário'];
function memFold(s){ return String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(); }
function memSlug(s){ const o=memFold(s).replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60).replace(/-+$/,''); return o||'nota'; }
function memYaml(s){ const t=String(s==null?'':s).replace(/\s+/g,' ').trim(); return (/^[\wÀ-ſ][\wÀ-ſ .,()/·-]*$/.test(t) && !/:\s|\s#/.test(t))?t:JSON.stringify(t); }
// mesmo formato do src/memory.ts (serializeNote): frontmatter + corpo
function memSerialize(n){
  const tags=(n.tags||[]).map(memYaml).join(', ');
  return '---\ntitle: '+memYaml(n.title)+'\ntype: '+(n.type||'contexto')+'\ntags: ['+tags+']\nupdated: '+(n.updated||'')+'\nby: '+memYaml(n.by||'')+'\norigem: '+(n.origem==='agente'?'agente':'pessoa')+'\n---\n'+String(n.body||'').trim()+'\n';
}
function memToday(d){ d=d||new Date(); const p=x=>String(x).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
// resolve um alvo de [[link]] numa nota (mesmo escopo primeiro; aceita slug, título ou nome do arquivo)
function memResolve(notes, target, scope){
  const s=memSlug(target), f=memFold(String(target).trim());
  const hit=n=>n.slug===s || memSlug(n.slug)===s || memFold(n.title)===f;
  return notes.find(n=>hit(n)&&n.scope===scope) || notes.find(hit) || null;
}
// [[links]] do HTML já renderizado (mdToHtml escapou tudo) → links internos; quebrado → "criar esta nota"
function memLinkify(html, notes, scope){
  return String(html).replace(/\[\[([^\]|#\n<]+)(?:#[^\]|\n<]*)?(?:\|([^\]\n<]+))?\]\]/g,(m,target,alias)=>{
    const label=(alias||target).trim();
    const raw=target.replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    const n=memResolve(notes, raw, scope);
    const q=v=>String(v).replace(/"/g,'&quot;');
    if(n) return '<a class="memlink" data-mscope="'+q(n.scope)+'" data-mslug="'+q(n.slug)+'">'+label+'</a>';
    return '<a class="memlink broken" data-mcreate="'+q(target.trim())+'" title="criar esta nota">'+label+'</a>';
  });
}
function memBacklinks(notes, note){
  if(!note) return [];
  return notes.filter(n=>n!==note && (n.links||[]).some(l=>{ const r=memResolve(notes,l,n.scope); return r && r.slug===note.slug && r.scope===note.scope; }));
}
function memFilter(notes, q, type){
  const t=memFold(q||'').split(/\s+/).filter(Boolean);
  return notes.filter(n=>{
    if(type && n.type!==type) return false;
    if(!t.length) return true;
    const hay=memFold([n.title,n.slug,(n.tags||[]).join(' '),n.summary||'',n.body||''].join(' '));
    return t.every(w=>hay.includes(w));
  });
}
// layout por força simples (repulsão + mola nas arestas + gravidade pro centro), determinístico
function memForceLayout(nodes, edges, w, h, iters){
  iters=iters||260; const N=nodes.length; if(!N) return [];
  const pos=nodes.map((n,i)=>{ const a=i*2.399963, r=Math.sqrt(i+.5)/Math.sqrt(N)*Math.min(w,h)*.42; return { x:w/2+Math.cos(a)*r, y:h/2+Math.sin(a)*r }; });
  const idx={}; nodes.forEach((n,i)=>{ idx[n.id]=i; });
  const E=edges.map(e=>[idx[e.from],idx[e.to]]).filter(e=>e[0]!=null&&e[1]!=null&&e[0]!==e[1]);
  const k=Math.sqrt(w*h/Math.max(N,1))*.55;
  for(let it=0; it<iters; it++){
    const t=(1-it/iters)*k*.35+.5; const d=pos.map(()=>({x:0,y:0}));
    for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){
      let dx=pos[i].x-pos[j].x, dy=pos[i].y-pos[j].y; let dist=Math.hypot(dx,dy)||.01; const f=k*k/dist;
      dx/=dist; dy/=dist; d[i].x+=dx*f; d[i].y+=dy*f; d[j].x-=dx*f; d[j].y-=dy*f; }
    for(const [a,b] of E){ let dx=pos[a].x-pos[b].x, dy=pos[a].y-pos[b].y; const dist=Math.hypot(dx,dy)||.01; const f=dist*dist/k; dx/=dist; dy/=dist; d[a].x-=dx*f; d[a].y-=dy*f; d[b].x+=dx*f; d[b].y+=dy*f; }
    for(let i=0;i<N;i++){ d[i].x+=(w/2-pos[i].x)*.02*k; d[i].y+=(h/2-pos[i].y)*.02*k;
      const l=Math.hypot(d[i].x,d[i].y)||1; pos[i].x+=d[i].x/l*Math.min(l,t); pos[i].y+=d[i].y/l*Math.min(l,t);
      pos[i].x=Math.max(20,Math.min(w-20,pos[i].x)); pos[i].y=Math.max(20,Math.min(h-20,pos[i].y)); }
  }
  return pos;
}
// @puro-fim

const MEM_COLORS={ 'decisão':'var(--info)', regra:'var(--accent)', gotcha:'var(--warn)', contexto:'var(--muted)', pessoa:'var(--purple)', 'glossário':'var(--cyan)' };
const MEM_HEX={ 'decisão':'#5b9df9', regra:'#3fd68a', gotcha:'#f0b449', contexto:'#8b959b', pessoa:'#b47ce0', 'glossário':'#4fc4c9' };
const MEM_IC={
  brain:'<path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.3 3.4A2 2 0 0 0 4.2 12 2 2 0 0 0 8 12.6V3.6A2 2 0 0 0 6 2.8zM10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.3 3.4 2 2 0 0 1-1.5 3.8A2 2 0 0 1 8 12.6" stroke-linejoin="round"/>',
  plus:'<path d="M8 3.5v9M3.5 8h9"/>',
  graph:'<circle cx="4" cy="11.5" r="1.7"/><circle cx="12" cy="11" r="1.7"/><circle cx="8" cy="4" r="1.7"/><path d="M5 10l2.2-4.4M11 9.6L8.9 5.5M5.7 11.4h4.6"/>',
  list:'<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><path d="M2.6 4.5h.05M2.6 8h.05M2.6 11.5h.05" stroke-width="1.8"/>',
  ext:'<path d="M9 3h4v4M13 3L7.5 8.5"/><path d="M11.5 9.5v3.2H3.3V4.5h3.2"/>',
  edit:'<path d="M10.6 2.9l2.5 2.5-7.3 7.3H3.3v-2.5z" stroke-linejoin="round"/>',
  move:'<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>',
  trash:'<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.8 4.5l.6 8.5h5.2l.6-8.5"/>',
  sync:'<path d="M12.8 6.5A5 5 0 0 0 3.6 5M3.2 9.5a5 5 0 0 0 9.2 1.5"/><path d="M3.4 2.6V5h2.4M12.6 13.4V11h-2.4"/>',
};
function memIc(n,sz){ sz=sz||13; return '<svg viewBox="0 0 16 16" width="'+sz+'" height="'+sz+'" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true">'+(MEM_IC[n]||'')+'</svg>'; }
function memEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const MEM={ notes:[], mode:'local', explicit:false, root:'', hasTeam:false, sel:null, q:'', type:'', view:'lista', edit:null, repo:'', syncing:false, syncMsg:'' };
function memSeenKey(){ return 'memSeen:'+(state.repo||''); }
function memSeen(){ try{ return JSON.parse(lsGet(memSeenKey())||'{}')||{}; }catch(_){ return {}; } }
function memIsNew(n){ return n.origem==='agente' && (memSeen()[n.scope+':'+n.slug]||0) < n.mtimeMs; }
function memMarkSeen(n){ if(!n) return; const s=memSeen(); s[n.scope+':'+n.slug]=n.mtimeMs; lsSet(memSeenKey(), JSON.stringify(s)); }
function memWho(){
  try{ const p=cloudData&&cloudData.profileByUser&&cloudData.profileByUser[cloudUserId()]; if(p&&(p.name||p.email)) return p.name||p.email; }catch(_){ }
  return 'você (nesta máquina)';
}
function memSelNote(){ return MEM.sel ? MEM.notes.find(n=>n.scope===MEM.sel.scope && n.slug===MEM.sel.slug)||null : null; }

async function memLoad(){
  const r=await invoke('memory_list',{ withBody:true });
  MEM.notes=(r&&r.notes)||[]; MEM.mode=r.mode||'local'; MEM.explicit=!!r.explicitMode; MEM.root=r.root||''; MEM.repo=state.repo||'';
}
async function memTeamAvailable(){ try{ return !!(SB.configured() && SB.sess() && cloudData && cloudData.org && await prefsKey()); }catch(_){ return false; } }

async function openMemoria(){
  const ov=$id('memOverlay'); if(!ov) return;
  if(!state.repo){ toast('Abra um projeto primeiro.','warn'); return; }
  if(MEM.repo && MEM.repo!==state.repo){ MEM.sel=null; MEM.edit=null; MEM.q=''; MEM.type=''; }
  ovShow(ov);
  const body=$id('memBody'); if(body && !MEM.notes.length) body.innerHTML='<div class="dim" style="padding:24px">carregando a memória…</div>';
  try{ await memLoad(); }catch(e){ if(body) body.innerHTML='<div class="memempty">Não consegui ler a memória: '+memEsc(e&&e.message||e)+'</div>'; return; }
  MEM.hasTeam=await memTeamAvailable();
  memRender();
  if(MEM.hasTeam) memTeamSync().then(ch=>{ if(ch && $id('memOverlay').style.display!=='none' && !MEM.edit) memLoad().then(memRender).catch(()=>{}); });
}
window.openMemoria=openMemoria;

function memModeSeg(id){
  const opts=[['time','Time','sincroniza com o time (padrão quando o projeto está num time)'],['local','Local','só nesta máquina; os agentes ainda leem o time'],['so-local','Só local','os agentes ignoram o cérebro do time']];
  return '<div class="memseg" id="'+id+'" role="radiogroup" aria-label="Onde salvar as memórias novas">'+opts.map(([v,l,t])=>{
    const dis=v==='time' && !MEM.hasTeam;
    return '<button role="radio" aria-checked="'+(MEM.mode===v)+'" class="'+(MEM.mode===v?'on':'')+'" data-mmode="'+v+'" title="'+memEsc(dis?'entre num time (Conta e time) num projeto com git remote pra usar o cérebro do time':t)+'"'+(dis?' disabled':'')+'>'+l+'</button>'; }).join('')+'</div>';
}
async function memSetMode(mode){
  try{ await invoke('memory_set_mode',{ mode }); MEM.mode=mode; MEM.explicit=true;
    toast(mode==='time'?'Memórias novas vão pro cérebro do time.':mode==='local'?'Memórias novas ficam só nesta máquina.':'Modo só local: os agentes ignoram o cérebro do time.','ok');
  }catch(e){ showErr(e,'Não consegui trocar o modo'); }
}
function memWireMode(root){ if(!root) return; root.querySelectorAll('[data-mmode]').forEach(b=>b.onclick=async()=>{ await memSetMode(b.dataset.mmode); memRender(); memPrefsRender(); }); }

function memRender(){
  const body=$id('memBody'); if(!body) return;
  const list=memFilter(MEM.notes, MEM.q, MEM.type);
  const nNew=MEM.notes.filter(memIsNew).length;
  const sel=memSelNote();
  body.innerHTML=
    '<div class="memwrap">'+
    '<div class="memtop">'+
      '<div class="memtitle">'+memIc('brain',22)+'<div><h1>Memória do projeto</h1><div class="dim memsub">'+memEsc(pathBase(state.repo))+' · '+MEM.notes.length+' nota'+(MEM.notes.length===1?'':'s')+(nNew?' · <span class="memnewtxt">'+nNew+' nova'+(nNew===1?'':'s')+'</span>':'')+(MEM.syncMsg?' · '+memEsc(MEM.syncMsg):'')+'</div></div></div>'+
      '<div class="memctl">'+
        '<span class="memlbl">salvar memórias novas em</span>'+memModeSeg('memMode')+
        '<div class="memseg" role="tablist"><button class="'+(MEM.view==='lista'?'on':'')+'" data-mview="lista" aria-label="Lista">'+memIc('list')+'Lista</button><button class="'+(MEM.view==='grafo'?'on':'')+'" data-mview="grafo" aria-label="Grafo">'+memIc('graph')+'Grafo</button></div>'+
        '<button class="btn" id="memObs" title="Abre a pasta .cardume/memoria como cofre do Obsidian (links e grafo funcionam lá também)">'+memIc('ext')+'Abrir no Obsidian</button>'+
        (MEM.hasTeam?'<button class="btn" id="memSync" title="Sincronizar o cérebro do time agora">'+memIc('sync')+'</button>':'')+
        '<button class="btn primary" id="memNew">'+memIc('plus')+'Nova nota</button>'+
      '</div>'+
    '</div>'+
    '<div class="memgrid'+(MEM.view==='grafo'?' isgraph':'')+'">'+
      '<aside class="memside">'+
        '<input class="in" id="memQ" placeholder="buscar nas notas…" value="'+memEsc(MEM.q)+'" spellcheck="false" aria-label="Buscar nas notas">'+
        '<div class="memchips">'+['',...MEM_TYPES].map(t=>'<button class="memchip'+(MEM.type===t?' on':'')+'" data-mtype="'+t+'">'+(t?'<i style="background:'+MEM_COLORS[t]+'"></i>'+t:'todas')+'</button>').join('')+'</div>'+
        '<div class="memlist" id="memList">'+(list.length?list.map(n=>memRow(n,sel)).join(''):'<div class="memempty">'+(MEM.notes.length?'Nada bate com a busca.':'Ainda sem memória. Os agentes gravam aqui o que aprendem (correções no chat, decisões e armadilhas do fim das tarefas) — ou crie uma nota.')+'</div>')+'</div>'+
      '</aside>'+
      '<section class="memmain" id="memMain">'+(MEM.view==='grafo'?'<div class="memgraph"><canvas id="memCanvas"></canvas><div class="memlegend">'+MEM_TYPES.map(t=>'<span><i style="background:'+MEM_COLORS[t]+'"></i>'+t+'</span>').join('')+'<span><i class="ghost"></i>link quebrado</span></div></div>':memMainHtml(sel))+'</section>'+
    '</div></div>';
  memWire(body);
  if(MEM.view==='grafo') memDrawGraph();
}
function memRow(n, sel){
  const on=sel && sel.slug===n.slug && sel.scope===n.scope;
  return '<button class="memrow'+(on?' on':'')+'" data-mscope="'+memEsc(n.scope)+'" data-mslug="'+memEsc(n.slug)+'">'+
    '<span class="memrt"><i class="memdot" style="background:'+(MEM_COLORS[n.type]||'var(--muted)')+'"></i><b>'+memEsc(n.title)+'</b>'+(memIsNew(n)?'<span class="membadge new">nova</span>':'')+'</span>'+
    '<span class="memrm"><span class="membadge '+(n.scope==='time'?'time':'local')+'">'+n.scope+'</span>'+memEsc(n.type)+(n.updated?' · '+memEsc(n.updated):'')+'</span>'+
    (n.summary?'<span class="memrs">'+memEsc(n.summary)+'</span>':'')+'</button>';
}
function memMainHtml(n){
  if(MEM.edit) return memEditorHtml();
  if(!n) return '<div class="memempty big">'+memIc('brain',28)+'<p>Escolha uma nota à esquerda.</p><p class="dim">Cada nota é um arquivo .md com frontmatter, ligada às outras por <code>[[links]]</code>. Os agentes de tarefa, o planner, o chat do projeto e o orquestrador recebem o índice e as notas relevantes a cada conversa.</p></div>';
  const back=memBacklinks(MEM.notes, n);
  const html=memLinkify(mdToHtml(n.body||'*(vazia)*'), MEM.notes, n.scope);
  const other=n.scope==='time'?'local':'time';
  const canMove=other==='local' || MEM.hasTeam;
  return '<article class="memnote">'+
    '<div class="memnh"><h2>'+memEsc(n.title)+'</h2>'+
      '<div class="memacts"><button class="btn" id="memEdit">'+memIc('edit')+'Editar</button>'+
      (canMove?'<button class="btn" id="memMove" title="Mover pro cérebro '+(other==='time'?'do time (sincroniza com todos)':'local (só nesta máquina)')+'">'+memIc('move')+'Mover pro '+(other==='time'?'time':'local')+'</button>':'')+
      '<button class="btn" id="memDel" aria-label="Apagar nota" title="Apagar nota">'+memIc('trash')+'</button></div></div>'+
    '<div class="memmeta"><span class="membadge type" style="--c:'+(MEM_COLORS[n.type]||'var(--muted)')+'">'+memEsc(n.type)+'</span><span class="membadge '+(n.scope==='time'?'time':'local')+'">'+n.scope+'</span>'+(memIsNew(n)?'<span class="membadge new">nova</span>':'')+
      (n.tags||[]).map(t=>'<span class="memtag">#'+memEsc(t)+'</span>').join('')+
      '<span class="dim">'+(n.by?'por '+memEsc(n.by):'')+(n.updated?' · '+memEsc(n.updated):'')+'</span></div>'+
    '<div class="mdview memmd">'+html+'</div>'+
    '<div class="memback"><div class="memlbl">citada por</div>'+(back.length?back.map(b=>'<a class="memlink" data-mscope="'+memEsc(b.scope)+'" data-mslug="'+memEsc(b.slug)+'">'+memEsc(b.title)+'</a>').join(''):'<span class="dim">nenhuma nota liga pra esta ainda</span>')+'</div>'+
    '<div class="dim memfile">'+memEsc((n.scope==='time'?'.cardume/memoria/time/':'.cardume/memoria/')+n.slug+'.md')+'</div>'+
  '</article>';
}
function memEditorHtml(){
  const e=MEM.edit;
  return '<div class="memedit">'+
    '<div class="memnh"><h2>'+(e.slug?'Editar nota':'Nova nota')+'</h2><span class="dim">'+(e.scope==='time'?'cérebro do time':'cérebro local')+'</span></div>'+
    '<label class="memf"><span>Título</span><input class="in" id="meTitle" value="'+memEsc(e.title)+'" placeholder="ex.: Usar pnpm, nunca npm"></label>'+
    '<div class="memfrow"><label class="memf"><span>Tipo</span><select class="in" id="meType">'+MEM_TYPES.map(t=>'<option'+(t===e.type?' selected':'')+'>'+t+'</option>').join('')+'</select></label>'+
    '<label class="memf" style="flex:1"><span>Tags</span><input class="in" id="meTags" value="'+memEsc((e.tags||[]).join(', '))+'" placeholder="ferramentas, ci"></label></div>'+
    '<label class="memf"><span>Conteúdo · use [[nome-da-nota]] pra ligar notas</span><textarea class="in ta mono" id="meBody" rows="14">'+memEsc(e.body)+'</textarea></label>'+
    '<div class="memfoot"><span class="dim" id="meMsg"></span><span style="flex:1"></span><button class="btn" id="meCancel">cancelar</button><button class="btn primary" id="meSave">salvar</button></div>'+
  '</div>';
}
function memWire(body){
  memWireMode(body.querySelector('#memMode'));
  body.querySelectorAll('[data-mview]').forEach(b=>b.onclick=()=>{ MEM.view=b.dataset.mview; memRender(); });
  body.querySelectorAll('[data-mtype]').forEach(b=>b.onclick=()=>{ MEM.type=b.dataset.mtype; memRender(); });
  const q=body.querySelector('#memQ'); if(q){ q.oninput=()=>{ MEM.q=q.value; const l=$id('memList'); const sel=memSelNote(); const f=memFilter(MEM.notes,MEM.q,MEM.type); if(l){ l.innerHTML=f.length?f.map(n=>memRow(n,sel)).join(''):'<div class="memempty">Nada bate com a busca.</div>'; memWireLinks(l); } }; }
  memWireLinks(body);
  bindClick('memNew', ()=>memStartEdit(null));
  bindClick('memObs', async()=>{ try{ const how=await invoke('memory_open_obsidian'); if(how==='pasta') toast('Obsidian não encontrado — abri a pasta. No Obsidian: "Abrir pasta como cofre" → .cardume/memoria','warn'); }catch(e){ showErr(e,'Não consegui abrir no Obsidian'); } });
  bindClick('memSync', async()=>{ MEM.syncMsg='sincronizando…'; memRender(); const ok=await memTeamSync(); MEM.syncMsg=ok?'sincronizado':'não sincronizou'; await memLoad().catch(()=>{}); memRender(); });
  bindClick('memEdit', ()=>memStartEdit(memSelNote()));
  bindClick('memMove', memMoveSel);
  bindClick('memDel', memDeleteSel);
  if(MEM.edit){
    const ta=$id('meBody'); if(ta && typeof mountEditor==='function') mountEditor(ta,{ markdown:true });
    bindClick('meCancel', ()=>{ MEM.edit=null; memRender(); });
    bindClick('meSave', memSaveEdit);
    const t=$id('meTitle'); if(t && !MEM.edit.slug) setTimeout(()=>t.focus(),30);
  }
}
function memWireLinks(root){
  root.querySelectorAll('[data-mslug]').forEach(a=>a.onclick=(ev)=>{ ev.preventDefault(); memOpenNote(a.dataset.mscope, a.dataset.mslug); });
  root.querySelectorAll('[data-mcreate]').forEach(a=>a.onclick=(ev)=>{ ev.preventDefault(); const t=a.dataset.mcreate; memStartEdit(null, { title:t.replace(/[-_]+/g,' ').replace(/^./,c=>c.toUpperCase()), slug:memSlug(t) }); });
}
function memOpenNote(scope, slug){
  MEM.edit=null; // o editor aberto é descartado ao trocar de nota (mesmo padrão das outras abas)
  MEM.sel={ scope, slug }; MEM.view='lista';
  const n=memSelNote(); if(n) memMarkSeen(n);
  memRender();
  const r=document.querySelector('.memrow.on'); if(r && r.scrollIntoView) r.scrollIntoView({ block:'nearest' });
}

async function memStartEdit(n, preset){
  if(n){
    let content=null;
    try{ const r=await invoke('memory_read',{ scope:n.scope, slug:n.slug }); content=r; }catch(e){ showErr(e,'Não consegui abrir a nota'); return; }
    MEM.edit={ slug:n.slug, scope:n.scope, title:n.title, type:n.type, tags:n.tags||[], body:n.body||'', mtime:content.mtimeMs||n.mtimeMs, origem:n.origem };
  } else {
    const scope=MEM.mode==='time' && MEM.hasTeam ? 'time' : 'local';
    MEM.edit={ slug:null, newSlug:(preset&&preset.slug)||null, scope, title:(preset&&preset.title)||'', type:'contexto', tags:[], body:'', mtime:0 };
  }
  MEM.view='lista'; memRender();
}
async function memSaveEdit(){
  const e=MEM.edit; if(!e) return;
  const title=($id('meTitle').value||'').trim(), body=$id('meBody').value||'';
  if(!title){ $id('meMsg').textContent='dê um título pra nota'; $id('meTitle').focus(); return; }
  if(!body.trim()){ $id('meMsg').textContent='a nota está vazia'; return; }
  const note={ title, type:$id('meType').value, tags:$id('meTags').value.split(/[,\s]+/).map(t=>t.replace(/^#/,'').trim()).filter(Boolean), updated:memToday(), by:memWho(), origem:'pessoa', body };
  const b=$id('meSave'); b.disabled=true; b.textContent='salvando…';
  try{
    const r=await invoke('memory_write',{ scope:e.scope, slug:e.slug||e.newSlug||null, content:memSerialize(note), expectMtime:e.mtime||null });
    if(r.conflict) toast('Um agente atualizou esta nota enquanto você editava — a sua versão (a mais recente) foi salva.','warn');
    else toast('Nota salva · os agentes veem na próxima leitura.','ok');
    MEM.edit=null; MEM.sel={ scope:r.scope, slug:r.slug };
    await memLoad(); const n=memSelNote(); if(n) memMarkSeen(n);
    memRender();
    if(r.scope==='time') memTeamSync();
  }catch(err){ showErr(err,'Não consegui salvar a nota'); b.disabled=false; b.textContent='salvar'; }
}
async function memMoveSel(){
  const n=memSelNote(); if(!n) return;
  const to=n.scope==='time'?'local':'time';
  if(to==='local' && !await askYes('A nota sai do cérebro do time (some pros colegas) e fica só nesta máquina. Mover?','Mover pro local')) return;
  try{ const r=await invoke('memory_move',{ slug:n.slug, from:n.scope, to }); MEM.sel={ scope:r.scope, slug:r.slug }; await memLoad(); memRender(); toast(to==='time'?'Nota agora é do time.':'Nota agora é só local.','ok'); memTeamSync(); }
  catch(e){ showErr(e,'Não consegui mover a nota'); }
}
async function memDeleteSel(){
  const n=memSelNote(); if(!n) return;
  if(!await askYes('Apagar "'+n.title+'"? '+(n.scope==='time'?'Ela some do cérebro do time pra todos.':'Não dá pra desfazer.'),'Apagar nota')) return;
  try{ await invoke('memory_delete',{ scope:n.scope, slug:n.slug }); MEM.sel=null; await memLoad(); memRender(); if(n.scope==='time') memTeamSync(); }
  catch(e){ showErr(e,'Não consegui apagar a nota'); }
}

// ---- grafo (canvas com pan/zoom; clique abre a nota; nó fantasma = link quebrado → criar) ----
let memG=null;
function memDrawGraph(){
  const cv=$id('memCanvas'); if(!cv) return;
  const box=cv.parentElement.getBoundingClientRect(); const W=Math.max(300,box.width), H=Math.max(300,box.height);
  const dpr=window.devicePixelRatio||1; cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px';
  const notes=MEM.notes; const nodes=notes.map(n=>({ id:n.scope+':'+n.slug, n }));
  const edges=[], ghosts={};
  for(const n of notes) for(const l of (n.links||[])){ const r=memResolve(notes,l,n.scope); if(r) edges.push({ from:n.scope+':'+n.slug, to:r.scope+':'+r.slug }); else { const gid='?:'+l; if(!ghosts[gid]){ ghosts[gid]={ id:gid, ghost:l }; nodes.push(ghosts[gid]); } edges.push({ from:n.scope+':'+n.slug, to:gid }); } }
  const pos=memForceLayout(nodes, edges, W, H);
  const deg={}; edges.forEach(e=>{ deg[e.from]=(deg[e.from]||0)+1; deg[e.to]=(deg[e.to]||0)+1; });
  memG={ nodes, edges, pos, deg, W, H, dpr, tx:0, ty:0, k:1, hover:-1 };
  memPaint(); memWireCanvas(cv);
}
function memPaint(){
  const g=memG, cv=$id('memCanvas'); if(!g||!cv) return; const c=cv.getContext('2d');
  c.setTransform(g.dpr,0,0,g.dpr,0,0); c.clearRect(0,0,g.W,g.H);
  c.translate(g.tx,g.ty); c.scale(g.k,g.k);
  const idx={}; g.nodes.forEach((n,i)=>{ idx[n.id]=i; });
  const sel=MEM.sel?MEM.sel.scope+':'+MEM.sel.slug:'';
  c.lineWidth=1/g.k;
  for(const e of g.edges){ const a=g.pos[idx[e.from]], b=g.pos[idx[e.to]]; if(!a||!b) continue;
    const hot=g.hover>=0 && (idx[e.from]===g.hover||idx[e.to]===g.hover);
    c.strokeStyle=hot?'rgba(63,214,138,.7)':'rgba(255,255,255,.14)'; c.setLineDash(g.nodes[idx[e.to]].ghost?[3,3]:[]);
    c.beginPath(); c.moveTo(a.x,a.y); c.lineTo(b.x,b.y); c.stroke(); }
  c.setLineDash([]);
  g.nodes.forEach((nd,i)=>{ const p=g.pos[i]; const r=4+Math.min(8,Math.sqrt(g.deg[nd.id]||0)*2.2);
    c.beginPath(); c.arc(p.x,p.y,r,0,Math.PI*2);
    if(nd.ghost){ c.strokeStyle='rgba(139,149,155,.7)'; c.stroke(); }
    else { c.fillStyle=MEM_HEX[nd.n.type]||'#8b959b'; c.fill(); if(nd.id===sel||i===g.hover){ c.strokeStyle='#e9edef'; c.lineWidth=2/g.k; c.stroke(); c.lineWidth=1/g.k; } }
    if(g.k>.6 || i===g.hover){ c.fillStyle=nd.ghost?'rgba(139,149,155,.8)':'rgba(233,237,239,.88)'; c.font=(11/Math.max(g.k,.8))+'px -apple-system,system-ui,sans-serif'; c.textAlign='center';
      const label=nd.ghost?('+ '+nd.ghost):nd.n.title; c.fillText(label.length>34?label.slice(0,33)+'…':label, p.x, p.y+r+12/Math.max(g.k,.8)); }
  });
}
function memHit(ev){
  const g=memG, cv=$id('memCanvas'); if(!g||!cv) return -1; const b=cv.getBoundingClientRect();
  const x=(ev.clientX-b.left-g.tx)/g.k, y=(ev.clientY-b.top-g.ty)/g.k;
  let best=-1, bd=14/g.k; g.pos.forEach((p,i)=>{ const d=Math.hypot(p.x-x,p.y-y); if(d<bd){ bd=d; best=i; } }); return best;
}
function memWireCanvas(cv){
  let drag=null, moved=false;
  cv.onmousedown=ev=>{ drag={ x:ev.clientX, y:ev.clientY, tx:memG.tx, ty:memG.ty }; moved=false; };
  cv.onmousemove=ev=>{ if(drag){ const dx=ev.clientX-drag.x, dy=ev.clientY-drag.y; if(Math.abs(dx)+Math.abs(dy)>3) moved=true; memG.tx=drag.tx+dx; memG.ty=drag.ty+dy; memPaint(); return; }
    const h=memHit(ev); if(h!==memG.hover){ memG.hover=h; cv.style.cursor=h>=0?'pointer':'grab'; memPaint(); } };
  cv.onmouseup=ev=>{ const was=drag; drag=null; if(!was||moved) return; const i=memHit(ev); if(i<0) return; const nd=memG.nodes[i];
    if(nd.ghost) memStartEdit(null,{ title:nd.ghost.replace(/-/g,' ').replace(/^./,c=>c.toUpperCase()), slug:nd.ghost });
    else memOpenNote(nd.n.scope, nd.n.slug); };
  cv.onmouseleave=()=>{ drag=null; if(memG.hover>=0){ memG.hover=-1; memPaint(); } };
  cv.onwheel=ev=>{ ev.preventDefault(); const b=cv.getBoundingClientRect(); const mx=ev.clientX-b.left, my=ev.clientY-b.top;
    const k2=Math.max(.3,Math.min(3,memG.k*(ev.deltaY<0?1.1:1/1.1))); memG.tx=mx-(mx-memG.tx)*k2/memG.k; memG.ty=my-(my-memG.ty)*k2/memG.k; memG.k=k2; memPaint(); };
}

// ---- cérebro do TIME: .cardume/memoria/time/ ⇄ brain_notes (mais recente vence; apagar propaga) ----
let memSyncBusy=false;
async function memTeamSync(){
  if(memSyncBusy) return false; memSyncBusy=true;
  let changed=false;
  try{
    if(!(SB.configured() && SB.sess() && cloudData && cloudData.org)) return false;
    const k=await prefsKey(); if(!k) return false;
    const info=await invoke('memory_list',{ withBody:true });
    const local={}; (info.notes||[]).filter(n=>n.scope==='time').forEach(n=>{ local[n.slug]=n; });
    const q='org_id=eq.'+k.orgId+'&repo=eq.'+encodeURIComponent(k.repo);
    const rows=await sbGet('brain_notes?select=slug,title,type,tags,body,by,origem,updated_at&'+q) || [];
    const knownKey='memKnown:'+k.orgId+':'+k.repo;
    let known; try{ known=new Set(JSON.parse(lsGet(knownKey)||'[]')); }catch(_){ known=new Set(); }
    const now=new Set();
    const push=n=>sbFetch('/rest/v1/brain_notes?on_conflict=org_id,repo,slug',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
      body:JSON.stringify({ org_id:k.orgId, repo:k.repo, slug:n.slug, title:n.title, type:n.type, tags:n.tags||[], body:n.body||'', by:n.by||'', origem:n.origem||'pessoa', updated_by:cloudUserId(), updated_at:new Date(n.mtimeMs||Date.now()).toISOString() }) });
    const pull=r=>invoke('memory_write',{ scope:'time', slug:r.slug, content:memSerialize({ title:r.title, type:r.type, tags:r.tags||[], updated:String(r.updated_at||'').slice(0,10), by:r.by, origem:r.origem, body:r.body }), setMtimeMs:Date.parse(r.updated_at)||null });
    const cloud={};
    for(const r of rows){ cloud[r.slug]=r;
      const l=local[r.slug];
      if(!l){
        if(known.has(r.slug)){ await sbFetch('/rest/v1/brain_notes?'+q+'&slug=eq.'+encodeURIComponent(r.slug),{ method:'DELETE' }); changed=true; continue; } // apagada aqui
        await pull(r); changed=true; now.add(r.slug); continue;
      }
      const t=Date.parse(r.updated_at)||0;
      if(t>l.mtimeMs+2000){ await pull(r); changed=true; }
      else if(l.mtimeMs>t+2000){ await push(l); }
      now.add(r.slug);
    }
    for(const slug of Object.keys(local)){
      if(cloud[slug]) continue;
      if(known.has(slug)){ await invoke('memory_delete',{ scope:'time', slug }).catch(()=>{}); changed=true; continue; } // apagada por um colega
      await push(local[slug]); now.add(slug);
    }
    lsSet(knownKey, JSON.stringify([...now]));
    // D1: projeto num time → as memórias novas vão pro time por padrão (até a pessoa escolher outra coisa)
    if(!info.explicitMode && info.mode!=='time'){ await invoke('memory_set_mode',{ mode:'time' }).catch(()=>{}); changed=true; }
    return changed;
  }catch(e){ console.warn('memTeamSync', e); return false; }
  finally{ memSyncBusy=false; }
}
window.memTeamSync=memTeamSync;
setTimeout(()=>{ memTeamSync().catch(()=>{}); }, 20000);
setInterval(()=>{ memTeamSync().catch(()=>{}); }, 10*60*1000);

// ---- Preferências do projeto: o mesmo seletor "onde salvar as memórias novas" ----
async function memPrefsRender(){
  const h=$id('prefsMemHost'); if(!h) return;
  if(!state.repo){ h.innerHTML=''; return; }
  try{ const r=await invoke('memory_list',{}); MEM.mode=r.mode||'local'; MEM.explicit=!!r.explicitMode; MEM.hasTeam=await memTeamAvailable();
    h.innerHTML='<div class="memprefs"><div class="seclbl2">Memória do projeto</div><div class="dim" style="font-size:12px;margin:4px 0 8px">Onde as memórias novas (dos agentes e as suas) são salvas. Os agentes leem o cérebro local e o do time juntos — menos no modo "só local". '+(r.notes||[]).length+' nota(s) hoje · <a href="#" id="prefsMemOpen">abrir a Memória</a></div>'+memModeSeg('prefsMemMode')+'</div>';
    memWireMode(h.querySelector('#prefsMemMode'));
    const a=h.querySelector('#prefsMemOpen'); if(a) a.onclick=ev=>{ ev.preventDefault(); if(window.openTab) window.openTab('memoria'); else openMemoria(); };
  }catch(_){ h.innerHTML=''; }
}
window.memPrefsRender=memPrefsRender;

bindClick('memBtn', ()=>{ if(window.openTab) window.openTab('memoria'); else openMemoria(); });
{ const ov=$id('memOverlay'); if(ov) ov.addEventListener('click',e=>{ if(e.target.id==='memOverlay') ovHide('memOverlay'); }); }
bindClick('memClose', ()=>ovHide('memOverlay'));
window.addEventListener('resize', ()=>{ if(MEM.view==='grafo' && $id('memCanvas') && $id('memOverlay').style.display!=='none') memDrawGraph(); });
