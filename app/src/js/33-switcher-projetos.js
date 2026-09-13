// Constellation — 33-switcher-projetos
// ---------- switcher de projetos ----------
let projects = [];
let projErr = "";
function clearProjectCaches(){ for(const k in commitsCache) delete commitsCache[k]; }
async function loadProjects(){
  try{ projects = await invoke("list_projects"); }catch(e){ projects = []; }
  renderProjName();
  if(projMenuOpen()) renderProjMenu();
}
function renderProjName(){
  const active = projects.find(p=>p.active);
  const nm = active ? active.name : (state.repo ? state.repo.split("/").filter(Boolean).slice(-1)[0] : "sem projeto");
  const el=$id("projName"); if(el) el.textContent = nm;
  const dot=$id("projDot"); if(dot) dot.classList.toggle("live", connected && (state.tasks||[]).length>0);
}
function projMenuOpen(){ const m=$id("projMenu"); return m && m.style.display!=="none"; }
function openProjMenu(){ renderProjMenu(); $id("projMenu").style.display="block"; }
function closeProjMenu(){ const m=$id("projMenu"); if(m) m.style.display="none"; }
function toggleProjMenu(){ projMenuOpen()?closeProjMenu():openProjMenu(); }
function renderProjMenu(){
  const m=$id("projMenu"); if(!m) return;
  const rows = projects.length ? projects.map(p=>`<div class="prow${p.active?' on':''}" data-path="${escA(p.path)}">
      <span class="pd"></span>
      <div class="pn"><div class="pnm">${esc(p.name)}</div><div class="pp">${esc(p.path)}</div></div>
      <button class="px" data-rm="${escA(p.path)}" title="Remover da lista">✕</button>
    </div>`).join("") : '<div class="projerr" style="color:var(--muted)">nenhum projeto ainda</div>';
  m.innerHTML = `<div class="phead">Projetos</div>${rows}${projErr?`<div class="projerr">${esc(projErr)}</div>`:""}<div class="psep"></div>`+
    `<div class="projadd" id="projAdd"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3.5v9M3.5 8h9" stroke-linecap="round"/></svg>Abrir projeto…</div>`+
    `<div class="projadd projmanage" id="projManage"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/></svg>Gerenciar projetos</div>`;
  m.querySelectorAll('.prow').forEach(r=>r.onclick=(e)=>{ if(e.target.closest('.px')) return; switchProject(r.dataset.path); });
  m.querySelectorAll('.px').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); try{ await invoke("remove_project",{path:b.dataset.rm}); }catch(_){}; await loadProjects(); });
  $id("projAdd").onclick = pickFolder;
  bindClick("projManage", ()=>{ closeProjMenu(); if(window.openTab) window.openTab('projetos'); });
}
async function switchProject(path){
  try{
    await invoke("switch_project",{ path });
    projErr=""; closeProjMenu(); selected=null; lastSig=""; clearProjectCaches();
    await refresh(); await loadProjects();
  }catch(err){ projErr=String(err); openProjMenu(); }
}
async function pickFolder(){
  let dir;
  try{ dir = await invoke("pick_folder"); }
  catch(e){ console.error("pick_folder", e); return; }
  if(!dir) return; // usuário cancelou
  try{
    await invoke("open_project",{ path: dir });
    projErr=""; closeProjMenu(); selected=null; lastSig=""; clearProjectCaches();
    await refresh(); await loadProjects();
  }catch(err){ projErr=String(err); openProjMenu(); }
}
$id("newTaskBtn").onclick = openNewTask;
// menu "mais" do topo (redesign: topbar enxuta)
{ const mb=$id('moreBtn'), mm=$id('moreMenu');
  if(mb&&mm){
    mb.onclick=(e)=>{ e.stopPropagation(); mm.style.display=mm.style.display==='none'?'flex':'none'; };
    document.addEventListener('click',(e)=>{ if(!e.target.closest('#moreWrap')) mm.style.display='none'; });
    mm.addEventListener('click',()=>{ setTimeout(()=>{ mm.style.display='none'; },80); });
    // o aviso de ambiente (envDot) reflete no botão do menu
    setInterval(()=>{ const d=$id('envDot'), md=$id('moreDot'); if(d&&md) md.style.display=d.style.display; }, 3000);
  } }
// publicar release DE DENTRO do app (sessão logada — sem senha em env)
// modal próprio: prompt() não existe no webview do Tauri (clique morria calado)
function pubSetState(s){ // 'form' | 'prog' | done html
  $id('pubForm').style.display = s==='form'?'block':'none';
  $id('pubProg').style.display = s==='prog'?'flex':'none';
  $id('pubDone').style.display = (s!=='form'&&s!=='prog')?'block':'none';
  if(s!=='form'&&s!=='prog') $id('pubDone').innerHTML=s;
}
function closePub(){ $id('pubOverlay').style.display='none'; }
{ const b=$id('pubRelBtn');
  if(b) b.onclick=()=>{
    if(!SB.sess()){ alert('Entre na sua conta primeiro (botão do topo).'); return; }
    pubSetState('form');
    $id('pubOverlay').style.display='flex';
    $id('pubNotes').focus();
  }; }
$id('pubClose').onclick=closePub;
$id('pubCancel').onclick=closePub;
$id('pubOverlay').addEventListener('click',e=>{ if(e.target.id==='pubOverlay') closePub(); });
$id('pubGo').onclick=async()=>{
  const notes=$id('pubNotes').value.trim()||'Melhorias e correções.';
  pubSetState('prog');
  const stats=['enviando o pacote…','publicando o aviso de versão…','quase lá…'];
  let si=0; const tick=setInterval(()=>{ si=Math.min(si+1,stats.length-1); const e=$id('pubStatus'); if(e) e.textContent=stats[si]; },4000);
  $id('pubStatus').textContent=stats[0];
  try{
    const msg=await invoke('publish_release',{ url:SB.url(), anon:SB.key(), token:SB.sess().access_token, notes });
    clearInterval(tick);
    pubSetState(`<div style="display:flex;gap:10px;align-items:flex-start"><span style="color:var(--accent);font-size:20px;line-height:1">✓</span><div><b style="font-size:13px">Release publicada!</b><div class="dim" style="font-size:12px;margin-top:4px">${esc(msg)}</div></div></div><div style="display:flex;margin-top:14px"><span style="flex:1"></span><button class="btn primary" id="pubOk">fechar</button></div>`);
    bindClick('pubOk', closePub);
  }catch(e){
    clearInterval(tick);
    pubSetState(`<div style="display:flex;gap:10px;align-items:flex-start"><span style="color:var(--warn);font-size:20px;line-height:1">✕</span><div><b style="font-size:13px">Não deu</b><div class="dim" style="font-size:12px;margin-top:4px">${esc(String(e))}</div></div></div><div style="display:flex;gap:8px;margin-top:14px"><span style="flex:1"></span><button class="btn" id="pubBack">tentar de novo</button></div>`);
    bindClick('pubBack', ()=>pubSetState('form'));
  }
};
// busca central do topo → filtra a Central de execuções (redesign p2)
{ const ts=$id('topSearch');
  if(ts){ ts.oninput=()=>{ flowQuery=ts.value; if(!activeIs('flow')) setView('flow'); lastSig=''; renderFlow(); };
    ts.onkeydown=(e)=>{ if(e.key==='Escape'){ ts.value=''; flowQuery=''; lastSig=''; renderFlow(); ts.blur(); } }; } }
$id("ntClose").onclick = closeNewTask;
$id("ntCancel").onclick = closeNewTask;
$id("ntCreate").onclick = ()=>{
  ntGate(); if($id('ntCreate').disabled) return;
  // build & fix: o wizard já colheu o "Quem executa?" — cria direto com progresso
  if(ntMode==='build'||ntMode==='fix') wizLaunch(); else submitNewTask(true);
};
$id('ntOverlay').addEventListener('input', ntGate);
$id("ntDraft").onclick = ()=>submitNewTask(false);
document.querySelectorAll("#ntMode .ntmodebtn").forEach(b=>b.onclick=()=>setNtMode(b.dataset.mode));
$id("ntAI").onclick = openPlanner;
$id("aiSend").onclick = sendAiMsg;
$id("aiInput").addEventListener("keydown", e=>{ if(e.key==="Enter") sendAiMsg(); });
$id("projBtn").onclick = (e)=>{ e.stopPropagation(); toggleProjMenu(); };
document.addEventListener("click", e=>{ if(!e.target.closest(".projsw")) closeProjMenu(); });
$id("emAbrir").onclick = pickFolder;
$id("ntImport").onclick = importTaskMd;
$id("ntRefAdd").onclick = pickRefs;
$id("ntDzRefAdd").onclick = ()=>pickRefsInto(ntDzRefs, renderDzRefs);
$id("ntFixRefAdd").onclick = ()=>pickRefsInto(ntFixRefs, renderFixRefs);
$id("ntInvRefAdd").onclick = ()=>pickRefsInto(ntInvRefs, renderInvRefs);
$id("ntReqAdd").onclick = ()=>{ ntReq.push(""); renderNtList("ntRequirements",ntReq); };
// ✨ título por IA a partir da descrição (data-aititle="inputDoTitulo:inputDaDescricao")
document.querySelectorAll('[data-aititle]').forEach(b=>{
  b.onclick=async(e)=>{
    e.preventDefault();
    const [dst,src]=b.dataset.aititle.split(':');
    const text=($id(src)||{}).value||'';
    if(!text.trim()){ const s=$id(src); if(s){ s.focus(); s.placeholder='escreva a descrição primeiro — o título sai dela'; } return; }
    const orig=b.innerHTML; b.disabled=true; b.textContent='gerando…';
    try{ const t=await invoke('ai_title',{ text }); const d=$id(dst); if(d){ d.value=t; d.focus(); } }
    catch(err){ alert('Não deu pra gerar o título:\n'+err); }
    finally{ b.disabled=false; b.innerHTML=orig; }
  };
});
$id("ntOverlay").addEventListener("click", e=>{ if(e.target.id==="ntOverlay") closeNewTask(); });
$id("artClose").onclick = closeArtifact;
$id("artOverlay").addEventListener("click", e=>{ if(e.target.id==="artOverlay") closeArtifact(); });
$id("cmClose").onclick = closeCommit;
$id("cmOverlay").addEventListener("click", e=>{ if(e.target.id==="cmOverlay") closeCommit(); });
document.addEventListener("keydown", e=>{
  if(e.key==="Escape"){ closeNewTask(); closeAgents(); closeCommit(); closeArtifact(); return; }
  if((e.metaKey||e.ctrlKey) && !e.shiftKey){
    const k=e.key.toLowerCase();
    if(k==="n"){ e.preventDefault(); if(connected){ if(window.openTab) window.openTab('nova'); else openNewTask(); } }
    else if(k==="o"){ e.preventDefault(); pickFolder(); }
  }
});

/* ---------- editor Agentes & Equipes ---------- */
let cfgEdit = { agents:[], workflows:[] };
function escA(s){ return esc(s).replace(/"/g,"&quot;"); }
function agSlug(s){ return (String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24))||"item"; }
function uniqueId(base){ let id=base, n=2; while(cfgEdit.agents.some(a=>a.id===id)){ id=base+"-"+n; n++; } return id; }
async function openAgents(){
  let cfg; try{ cfg = await invoke("config"); }catch(e){ cfg={agents:[],workflows:[]}; }
  cfgEdit = JSON.parse(JSON.stringify({ agents:cfg.agents||[], workflows:cfg.workflows||[] }));
  agOpen = -1;
  renderAg(); renderWf();
  $id("agOverlay").style.display="flex";
}
function closeAgents(){ const o=$id("agOverlay"); if(o) o.style.display="none"; }
const ROLES=["planner","builder","reviewer","designer","tester","docs","security"];
const PALETTE=["#1e9e4a","#e6b53c","#0a72e0","#a05cff","#e5484d","#12a3a3","#e07b39","#ec4899"];
const GLYPHS=["🦊","🦉","🐙","🐢","🦋","🐝","🦁","🐬","🧠","⚡","🛠️","🔍","🎨","🧪","📝","🛡️"];
let agOpen=-1;
function avatarInner(a){ return a.avatar ? esc(a.avatar) : esc((a.name||"?").trim().slice(0,2).toUpperCase()); }
function allCats(){ const s=new Set(ROLES); cfgEdit.agents.forEach(a=>{ if(a.role) s.add(a.role); }); return [...s]; }
function addAgent(){ cfgEdit.agents.push({id:uniqueId("agente"),name:"Novo agente",role:"builder",engine:"claude",persona:"",color:"#1e9e4a",avatar:""}); agOpen=cfgEdit.agents.length-1; renderAg(); renderWf(); }
function agEditor(i){
  const a=cfgEdit.agents[i];
  return `<div class="ageditor">
    <div class="aged-top">
      <div class="av" style="background:${escA(a.color||'#1e9e4a')}">${avatarInner(a)}</div>
      <input class="in" data-i="${i}" data-k="name" value="${escA(a.name||'')}" placeholder="Nome do agente" style="flex:1;font-weight:700;font-size:14px">
      <button class="iconbtn" data-del="${i}" title="remover agente">${IC.trash}</button>
    </div>
    <div class="two">
      <div><label>Categoria</label><input class="in" list="catList" data-i="${i}" data-k="role" value="${escA(a.role||'')}" placeholder="ex.: designer, backend…"></div>
      <div><label>Motor</label><select class="sel" data-i="${i}" data-k="engine" style="width:100%"><option value="claude"${a.engine!=='mock'?' selected':''}>Claude</option><option value="mock"${a.engine==='mock'?' selected':''}>Mock</option></select></div>
    </div>
    <label style="display:block;margin-top:10px">Persona (instrução)</label>
    <textarea class="agpersona" data-i="${i}" data-k="persona" placeholder="o que este agente faz e como pensa">${esc(a.persona||'')}</textarea>
    <div class="pickrow"><span class="lbl3">Cor</span>${PALETTE.map(c=>`<button class="colorsw${(a.color||'').toLowerCase()===c?' on':''}" style="background:${c}" data-color="${i}" data-c="${c}"></button>`).join("")}<input class="swatch" type="color" value="${escA(a.color||'#1e9e4a')}" data-i="${i}" data-k="color" title="cor personalizada"></div>
    <div class="pickrow"><span class="lbl3">Avatar</span><button class="glyph ini${!a.avatar?' on':''}" data-glyph="${i}" data-g="">Aa</button>${GLYPHS.map(gp=>`<button class="glyph${a.avatar===gp?' on':''}" data-glyph="${i}" data-g="${escA(gp)}">${gp}</button>`).join("")}</div>
    <datalist id="catList">${allCats().map(c=>`<option value="${escA(c)}"></option>`).join("")}</datalist>
  </div>`;
}
function renderAg(){
  const el=$id("agList");
  const tiles = cfgEdit.agents.map((a,i)=>`<button class="agtile${i===agOpen?' sel':''}" data-open="${i}" data-agtile="${i}" draggable="true" title="arraste pra dentro de uma equipe →">
    <span class="av" style="background:${escA(a.color||'#1e9e4a')}">${avatarInner(a)}</span>
    <span class="tn">${esc(a.name||'—')}</span><span class="tc">${esc(a.role||'')}</span>
  </button>`).join("");
  const add = `<button class="agtile new" data-add><span class="plus">+</span><span class="tc">novo agente</span></button>`;
  el.innerHTML = `<div class="aggrid">${tiles}${add}</div>${agOpen>=0&&cfgEdit.agents[agOpen]?agEditor(agOpen):''}`;
  el.querySelectorAll("[data-open]").forEach(t=>t.onclick=()=>{ const i=+t.dataset.open; agOpen=(agOpen===i?-1:i); renderAg(); });
  // tiles arrastáveis → soltar dentro de uma equipe insere uma etapa
  el.querySelectorAll("[data-agtile]").forEach(t=>{
    t.addEventListener("dragstart",e=>{ const a=cfgEdit.agents[+t.dataset.agtile]; if(a&&!a.id) a.id=uniqueId(agSlug(a.name||'agente')); agDrag={type:'agent', agentId:a?a.id:null}; t.classList.add('dragging'); e.dataTransfer.effectAllowed='copy'; });
    t.addEventListener("dragend",()=>{ agDrag=null; t.classList.remove('dragging'); document.querySelectorAll('.wfrow,.stepchip').forEach(x=>x.classList.remove('over','insbefore')); });
  });
  const addBtn=el.querySelector("[data-add]"); if(addBtn) addBtn.onclick=addAgent;
  el.querySelectorAll(".ageditor [data-k]").forEach(inp=>{
    const h=()=>{ cfgEdit.agents[+inp.dataset.i][inp.dataset.k]=inp.value; if(inp.dataset.k==='color') renderAg(); };
    inp.addEventListener("input",h); inp.addEventListener("change",h);
  });
  el.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ cfgEdit.agents.splice(+b.dataset.del,1); agOpen=-1; renderAg(); renderWf(); });
  el.querySelectorAll("[data-color]").forEach(s=>s.onclick=(e)=>{ e.preventDefault(); cfgEdit.agents[+s.dataset.color].color=s.dataset.c; renderAg(); });
  el.querySelectorAll("[data-glyph]").forEach(b=>b.onclick=(e)=>{ e.preventDefault(); cfgEdit.agents[+b.dataset.glyph].avatar=b.dataset.g; renderAg(); });
}
let agDrag=null; // {type:'agent'|'step', agentId, fromWi, fromSi}
function wfInsert(wi, agentId, idx){
  const w=cfgEdit.workflows[wi]; if(!w) return; (w.steps ||= []);
  if(idx==null||idx<0||idx>w.steps.length) idx=w.steps.length;
  w.steps.splice(idx,0,agentId); renderWf();
}
function wfMoveStep(fromWi, fromSi, toWi, idx){
  const fw=cfgEdit.workflows[fromWi]; if(!fw) return; const sid=fw.steps.splice(fromSi,1)[0];
  const tw=cfgEdit.workflows[toWi]; (tw.steps ||= []);
  if(fromWi===toWi && idx>fromSi) idx--;
  if(idx==null||idx<0||idx>tw.steps.length) idx=tw.steps.length;
  tw.steps.splice(idx,0,sid); renderWf();
}
function renderWf(){
  const el=$id("wfList");
  const byId=Object.fromEntries(cfgEdit.agents.map(a=>[a.id,a]));
  el.innerHTML = cfgEdit.workflows.map((w,i)=>`<div class="wfrow" data-drop="${i}">
    <div class="wftop"><span class="wfgrip" title="equipe">⠿</span><input class="wfname" value="${escA(w.name||'')}" data-wi="${i}" data-wk="name" placeholder="Nome do workflow"><span class="wfcount">${(w.steps||[]).length} etapa${(w.steps||[]).length===1?'':'s'}</span><button class="btn sm" data-wshare="${i}" title="publica esta equipe (e seus agentes) no catálogo da org — o time aplica com 1 clique" style="padding:2px 8px;font-size:10px">⇡ compartilhar com o time</button><button class="iconbtn" data-wdel="${i}" title="remover equipe">${IC.trash}</button></div>
    <div class="steps" data-steps="${i}">${(w.steps||[]).map((sid,si)=>`<span class="stepchip" draggable="true" data-wi="${i}" data-si="${si}"><span class="sgrip">⠿</span><span class="snum">${si+1}</span><span class="cdot" style="background:${(byId[sid]&&byId[sid].color)||'var(--muted)'}"></span><b>${esc(byId[sid]?byId[sid].name:sid)}</b><button class="rm" data-wi="${i}" data-rm="${si}" title="tirar">${IC.xs}</button></span>`).join("")||'<span class="stepempty">arraste um agente do grid pra cá →</span>'}</div>
  </div>`).join("") || '<div class="dim" style="font-size:12px;padding:6px 0">nenhuma equipe — clique "+ nova equipe"</div>';
  el.querySelectorAll("[data-wk]").forEach(inp=>inp.addEventListener("input",()=>{ cfgEdit.workflows[+inp.dataset.wi][inp.dataset.wk]=inp.value; }));
  el.querySelectorAll("[data-wdel]").forEach(b=>b.onclick=()=>{ cfgEdit.workflows.splice(+b.dataset.wdel,1); renderWf(); });
  // compartilhar UMA equipe com o time (redesign p18) — publica o workflow + os agentes dele
  el.querySelectorAll("[data-wshare]").forEach(b=>b.onclick=async()=>{
    const w=cfgEdit.workflows[+b.dataset.wshare]; if(!w) return;
    const orgId=cloudData&&cloudData.org&&cloudData.org.id;
    if(!SB.sess()||!orgId){ alert('Entre na sua conta e numa organização primeiro (botão do topo).'); return; }
    b.disabled=true; const o=b.textContent; b.textContent='publicando…';
    try{
      if(!w.id) w.id=agSlug(w.name);
      const byId2=Object.fromEntries(cfgEdit.agents.map(a=>[a.id,a]));
      for(const sid of (w.steps||[])){ const a=byId2[sid]; if(!a) continue; if(!a.id) a.id=uniqueId(agSlug(a.name));
        await sbFetch('/rest/v1/org_agents?on_conflict=org_id,id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ org_id:orgId, id:a.id, name:a.name, role:a.role||'builder', engine:a.engine||'claude', model:a.model||null, color:a.color||null, persona:a.persona||'' }) }); }
      await sbFetch('/rest/v1/org_workflows?on_conflict=org_id,id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ org_id:orgId, id:w.id, name:w.name, steps:w.steps||[] }) });
      b.textContent='✓ no catálogo do time';
      setTimeout(()=>{ b.disabled=false; b.textContent=o; }, 3000);
    }catch(e){ alert('Falhou: '+(e.message||e)); b.disabled=false; b.textContent=o; }
  });
  el.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{ cfgEdit.workflows[+b.dataset.wi].steps.splice(+b.dataset.rm,1); renderWf(); });
  // chips arrastáveis (reordenar etapas, inclusive entre equipes)
  el.querySelectorAll(".stepchip").forEach(chip=>{
    chip.addEventListener("dragstart",e=>{ agDrag={type:'step', fromWi:+chip.dataset.wi, fromSi:+chip.dataset.si}; chip.classList.add("dragging"); e.dataTransfer.effectAllowed='move'; e.stopPropagation(); });
    chip.addEventListener("dragend",()=>{ agDrag=null; el.querySelectorAll('.wfrow,.stepchip').forEach(x=>x.classList.remove('over','insbefore')); chip.classList.remove('dragging'); });
    chip.addEventListener("dragover",e=>{ if(!agDrag)return; e.preventDefault(); e.stopPropagation(); chip.classList.add('insbefore'); });
    chip.addEventListener("dragleave",()=>chip.classList.remove('insbefore'));
    chip.addEventListener("drop",e=>{ if(!agDrag)return; e.preventDefault(); e.stopPropagation(); const toWi=+chip.dataset.wi, idx=+chip.dataset.si; const d=agDrag; agDrag=null; if(d.type==='agent') wfInsert(toWi,d.agentId,idx); else wfMoveStep(d.fromWi,d.fromSi,toWi,idx); });
  });
  // a equipe inteira é drop zone (insere no fim)
  el.querySelectorAll(".wfrow").forEach(row=>{
    row.addEventListener("dragover",e=>{ if(!agDrag)return; e.preventDefault(); row.classList.add('over'); });
    row.addEventListener("dragleave",e=>{ if(!row.contains(e.relatedTarget)) row.classList.remove('over'); });
    row.addEventListener("drop",e=>{ if(!agDrag)return; e.preventDefault(); const toWi=+row.dataset.drop; const d=agDrag; agDrag=null; row.classList.remove('over'); if(d.type==='agent') wfInsert(toWi,d.agentId,null); else wfMoveStep(d.fromWi,d.fromSi,toWi,null); });
  });
}
function parseAgentMd(filename, content){
  let fm={}, body=content;
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if(m){
    m[1].split("\n").forEach(line=>{ const i=line.indexOf(":"); if(i>0){ const k=line.slice(0,i).trim().toLowerCase(); const v=line.slice(i+1).trim().replace(/^["']|["']$/g,""); fm[k]=v; } });
    body = m[2].trim();
  }
  const name = fm.name || filename;
  const persona = (fm.description ? fm.description.trim()+(body?" ":"") : "") + body;
  return { id: uniqueId(agSlug(name)), name, role: fm.role || fm.category || "builder", engine: (fm.engine==="mock"?"mock":"claude"), model: fm.model||undefined, color: fm.color || "#1e9e4a", avatar: fm.avatar || "", persona: persona.trim() };
}
async function importAgents(){
  let files;
  try{ files = await invoke("import_agent_files"); }catch(e){ alert("Falha ao importar:\n"+e); return; }
  if(!files || !files.length) return;
  for(const f of files) cfgEdit.agents.push(parseAgentMd(f.filename, f.content));
  renderAg(); renderWf();
}
async function saveConfig(){
  cfgEdit.agents.forEach(a=>{ if(!a.id) a.id=uniqueId(agSlug(a.name)); });
  cfgEdit.workflows.forEach(w=>{ if(!w.id) w.id=agSlug(w.name); if(!w.steps) w.steps=[]; });
  const btn=$id("agSave"); btn.disabled=true; btn.textContent="salvando…";
  try{ await invoke("save_config",{config:cfgEdit}); closeAgents(); }
  catch(e){ alert("Falha ao salvar catálogo:\n"+e); }
  finally{ btn.disabled=false; btn.textContent="salvar catálogo"; }
}
$id("agentsBtn").onclick = openAgents;
$id("agClose").onclick = closeAgents;
$id("agCancel").onclick = closeAgents;
$id("agSave").onclick = saveConfig;
$id("agAdd").onclick = addAgent;
$id("agImport").onclick = importAgents;
$id("wfAdd").onclick = ()=>{ cfgEdit.workflows.push({ id:"", name:"Novo workflow", steps:[] }); renderWf(); };
$id("agOverlay").addEventListener("click", e=>{ if(e.target.id==="agOverlay") closeAgents(); });

// rede de segurança global: um erro solto (ex.: invoke que rejeitou sem catch,
// rede caída) não deve deixar a UI num estado quebrado — só loga.
window.addEventListener("error", e=>{ console.error("erro global:", e.error||e.message); });
window.addEventListener("unhandledrejection", e=>{ console.error("promise sem catch:", e.reason); e.preventDefault(); });

// boot: se CARDUME_REPO foi setado, snapshot já traz dados; senão espera "conectar".
initNotifs();
refresh().then(loadProjects).catch(e=>console.error("boot:", e));
// poll blindado: uma volta que falhe não derruba o ciclo
setInterval(()=>{ refresh().catch(e=>console.error("refresh:", e)); }, 1000);
