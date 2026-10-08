// Starfork — 33-switcher-projetos
// ---------- switcher de projetos ----------
let projects = [];
let projErr = "";
function clearProjectCaches(){ for(const k in commitsCache) delete commitsCache[k]; }
async function loadProjects(){
  try{ projects = await invoke("list_projects", { user:(typeof cloudUserId==='function'?cloudUserId():undefined) }); }catch(e){ projects = []; }
  // "N de outras contas ocultos" da barra lateral (abrir existente traz um projeto pra conta → o número muda)
  if(typeof projScope!=='undefined'){ try{ projScope=(await invokeQuiet('projects_scope'))||projScope; }catch(_){ } }
  renderProjName();
  if(projMenuOpen()) renderProjMenu();
}
function renderProjName(){
  const active = projects.find(p=>p.active);
  const nm = active ? active.name : (state.repo ? pathBase(state.repo) : "sem projeto");
  const el=$id("projName"); if(el) el.textContent = nm;
  const dot=$id("projDot"); if(dot) dot.classList.toggle("live", connected && (state.tasks||[]).length>0);
}
function projMenuOpen(){ const m=$id("projMenu"); return m && m.style.display!=="none"; }
function openProjMenu(){ const m=$id("projMenu"); if(!m){ if(projErr) showErr(projErr, 'Não consegui abrir o projeto'); return; } renderProjMenu(); m.style.display="block"; }
function closeProjMenu(){ const m=$id("projMenu"); if(m) m.style.display="none"; }
function renderProjMenu(){ // legado: o menu suspenso saiu da sidebar (Projetos é uma aba); fica só se algum HTML antigo tiver #projMenu
  const m=$id("projMenu"); if(!m) return;
  const rows = projects.length ? projects.map(p=>`<div class="prow${p.active?' on':''}" data-path="${escA(p.path)}">
      <span class="pd"></span>
      <div class="pn"><div class="pnm">${esc(p.name)}</div><div class="pp">${esc(p.path)}</div></div>
      <button class="px" data-rm="${escA(p.path)}" title="Remover da lista">${IC.x}</button>
    </div>`).join("") : '<div class="projerr" style="color:var(--muted)">nenhum projeto ainda</div>';
  m.innerHTML = `<div class="phead">Projetos</div>${rows}${projErr?`<div class="projerr" title="${escA(projErr)}">${esc(humanErr(projErr,"Não consegui abrir o projeto").msg)}</div>`:""}<div class="psep"></div>`+
    `<div class="projadd" id="projAdd"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3.5v9M3.5 8h9" stroke-linecap="round"/></svg>Abrir projeto…</div>`+
    `<div class="projadd projmanage" id="projManage"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/></svg>Gerenciar projetos</div>`;
  m.querySelectorAll('.prow').forEach(r=>r.onclick=(e)=>{ if(e.target.closest('.px')) return; switchProject(r.dataset.path).catch(()=>{}); });
  m.querySelectorAll('.px').forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); const wasActive=b.dataset.rm===state.repo; try{ await invoke("remove_project",{path:b.dataset.rm}); }catch(_){}; if(wasActive){ selected=null; lastSig=""; clearProjectCaches(); await refresh(); } await loadProjects(); });
  $id("projAdd").onclick = pickFolder;
  bindClick("projManage", ()=>{ closeProjMenu(); if(window.openTab) window.openTab('projetos'); });
}
async function switchProject(path){
  try{
    await invoke("switch_project",{ path });
    projErr=""; closeProjMenu(); selected=null; lastSig=""; clearProjectCaches();
    await refresh(); await loadProjects();
    if(window.pilWatch) window.pilWatch().catch(()=>{}); // projeto com piloto que terminou → aviso (56-piloto)
  }catch(err){ projErr=String(err); openProjMenu(); // (sem o menu antigo, openProjMenu mostra o erro traduzido)
    // L14 (mesa-bugs-2): a falha SOBE — quem chamou não segue como se tivesse trocado (abria a página do projeto anterior)
    const e=new Error(errText(err)); e.shown=true; throw e; }
}
async function pickFolder(){
  let dir;
  try{ dir = await invoke("pick_folder"); }
  catch(e){ showErr(e, "Não consegui abrir o seletor de pastas"); return; }
  if(!dir) return; // usuário cancelou
  try{
    await invoke("open_project",{ path: dir });
    projErr=""; closeProjMenu(); selected=null; lastSig=""; clearProjectCaches();
    await refresh(); await loadProjects();
  }catch(err){ projErr=String(err); openProjMenu(); }
}
$id("newTaskBtn").onclick = ()=>ntOpenFormTab(); // aba própria (o openTab já passa pelo gitGate)
// menu "mais" do topo (redesign: topbar enxuta)
{ const mb=$id('moreBtn'), mm=$id('moreMenu');
  if(mb&&mm){
    // mesa da barra lateral (03/10): Skills, Agentes & Equipes e Daily moram aqui — o menu precisa de teclado de verdade
    const mmItems=()=>[...mm.querySelectorAll('button')].filter(b=>b.style.display!=='none');
    const mmShow=(on, kbd)=>{ mm.style.display=on?'flex':'none'; mb.setAttribute('aria-expanded', on?'true':'false');
      if(on && kbd){ const f=mmItems()[0]; if(f) f.focus(); } };
    mb.onclick=(e)=>{ e.stopPropagation(); mmShow(mm.style.display==='none', e.detail===0); };
    document.addEventListener('click',(e)=>{ if(!e.target.closest('#moreWrap')) mmShow(false); });
    mm.addEventListener('click',()=>{ setTimeout(()=>mmShow(false),80); });
    mm.addEventListener('keydown',(e)=>{
      const it=mmItems(), i=it.indexOf(document.activeElement);
      if(e.key==='Escape'){ e.preventDefault(); mmShow(false); mb.focus(); return; }
      const j=e.key==='ArrowDown'?i+1:e.key==='ArrowUp'?i-1:e.key==='Home'?0:e.key==='End'?it.length-1:null;
      if(j==null || !it.length) return;
      e.preventDefault(); it[(j+it.length)%it.length].focus();
    });
    // o aviso de ambiente (envDot) reflete no botão do menu
    setInterval(()=>{ const d=$id('envDot'), md=$id('moreDot'); if(d&&md) md.style.display=(d.style.display==='block'||(window.memLearnN||0)>0)?'block':'none'; }, 3000); // + aprendizados pra revisar (37-memoria)
  } }
// publicar release DE DENTRO do app (sessão logada — sem senha em env)
// modal próprio: prompt() não existe no webview do Tauri (clique morria calado)
function pubSetState(s){ // 'form' | 'prog' | done html
  $id('pubForm').style.display = s==='form'?'block':'none';
  $id('pubProg').style.display = s==='prog'?'flex':'none';
  $id('pubDone').style.display = (s!=='form'&&s!=='prog')?'block':'none';
  if(s!=='form'&&s!=='prog') $id('pubDone').innerHTML=s;
}
// A13: fechar no meio do envio NÃO cancela nem esquece — o envio segue, o resultado chega num aviso, e reabrir mostra o
// progresso (nunca o formulário de novo: era o risco de publicar 2×). Esc fecha (A15).
let pubBusy=false;
function pubOpen(){ return $id('pubOverlay').style.display!=='none'; }
function closePub(){ $id('pubOverlay').style.display='none'; }
{ const b=$id('pubRelBtn');
  if(b) b.onclick=()=>{
    if(!SB.sess() && !pubBusy){ toast('Entre na sua conta primeiro (Conta e time, no rodapé da barra lateral).','warn'); return; }
    if(!pubBusy) pubSetState('form');
    $id('pubOverlay').style.display='flex';
    (pubBusy?$id('pubClose'):$id('pubNotes')).focus();
  }; }
$id('pubClose').onclick=closePub;
$id('pubCancel').onclick=closePub;
$id('pubOverlay').addEventListener('click',e=>{ if(e.target.id==='pubOverlay') closePub(); });
$id('pubOverlay').addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closePub(); } });
$id('pubGo').onclick=async()=>{
  if(pubBusy) return; pubBusy=true;
  const notes=$id('pubNotes').value.trim()||'Melhorias e correções.';
  pubSetState('prog');
  const stats=['enviando o pacote…','publicando o aviso de versão…','quase lá…'];
  let si=0; const tick=setInterval(()=>{ si=Math.min(si+1,stats.length-1); const e=$id('pubStatus'); if(e) e.textContent=stats[si]; },4000);
  $id('pubStatus').textContent=stats[0];
  try{
    // token SEMPRE válido: sessão sem access_token (expirou/ficou pela metade) renova antes; sem conta → frase
    // humana. Antes: token undefined sumia do JSON e o Rust respondia "missing required key token".
    let s=SB.sess(); if(!s||!s.access_token){ try{ s=await sbRefresh(); }catch(_){ s=null; } }
    if(!s||!s.access_token) throw new Error('Sua sessão expirou — entre de novo na sua conta (botão Entrar, no rodapé da barra lateral) e publique outra vez.');
    const msg=await invoke('publish_release',{ url:SB.url(), anon:SB.key(), token:s.access_token, notes });
    clearInterval(tick); pubBusy=false;
    if(!pubOpen()) toast('Release publicada — '+String(msg||'').slice(0,140),'ok'); // fechou no meio: o resultado não some
    pubSetState(`<div style="display:flex;gap:10px;align-items:flex-start"><span style="color:var(--accent);font-size:20px;line-height:1">✓</span><div><b style="font-size:var(--fs-base)">Release publicada!</b><div class="dim" style="font-size:var(--fs-sm);margin-top:4px">${esc(msg)}</div></div></div><div style="display:flex;margin-top:14px"><span style="flex:1"></span><button class="btn primary" id="pubOk">fechar</button></div>`);
    bindClick('pubOk', closePub);
  }catch(e){
    clearInterval(tick); pubBusy=false;
    if(!pubOpen()) showErr(e,'Não consegui publicar a versão');
    const ph=humanErr(e,'Não consegui publicar a versão');
    // as recusas do publish_release já vêm em pt-BR com O QUE FAZER (rode package-app.sh, faça merge na main…):
    // mostra inteira — o humanErr genérico corta em 140 caracteres e some justamente a instrução
    const shown=ph.id==='generic' ? 'Não consegui publicar a versão: '+errText(e) : ph.msg;
    pubSetState(`<div style="display:flex;gap:10px;align-items:flex-start"><span style="color:var(--warn);font-size:20px;line-height:1">✕</span><div><b style="font-size:var(--fs-base)">Não deu</b><div class="dim" style="font-size:var(--fs-sm);margin-top:4px;white-space:pre-wrap" title="${escA(errText(e))}">${esc(shown)}</div></div></div><div style="display:flex;gap:8px;margin-top:14px"><span style="flex:1"></span>${ph.action?`<button class="btn primary" id="pubFix">${esc(ph.action.label)}</button>`:''}<button class="btn" id="pubBack">tentar de novo</button></div>`);
    bindClick('pubBack', ()=>pubSetState('form'));
    if(ph.action) bindClick('pubFix', ()=>{ closePub(); ph.action.fn(); });
  }
};
// busca central do topo → filtra a Central de execuções (redesign p2)
{ const ts=$id('topSearch');
  if(ts){ ts.oninput=()=>{ flowQuery=ts.value; if(!activeIs('flow')) setView('flow'); lastSig=''; renderFlow(); };
    ts.onkeydown=(e)=>{ if(e.key==='Escape'){ ts.value=''; flowQuery=''; lastSig=''; renderFlow(); ts.blur(); } }; } }
$id("ntClose").onclick = ()=>ntUserClose(); // o usuário fechando: mesma guarda do X da aba (formulário preenchido pergunta)
$id("ntCancel").onclick = ()=>ntUserClose();
$id("ntCreate").onclick = ()=>{
  ntGate(); if($id('ntCreate').disabled) return;
  // build & fix: o wizard já colheu o "Quem executa?" — cria direto com progresso
  if(ntMode==='build'||ntMode==='fix') wizLaunch(); else submitNewTask(true);
};
$id('ntOverlay').addEventListener('input', ntGate);
$id("ntDraft").onclick = ()=>submitNewTask(false);
document.querySelectorAll("#ntMode .ntmodebtn").forEach(b=>b.onclick=()=>setNtMode(b.dataset.mode));
$id("ntAI").onclick = ()=>{ { const k=(ntDocsPreset&&ntMode==='build')?'docs':ntMode; if(k!=='build' && typeof ndCarryKind!=='undefined') ndCarryKind=k; } { const o=$id(({ build:"ntObj", fix:"ntFixObj", design:"ntDzObj", invest:"ntInvObj", review:"ntPr" })[ntMode]||"ntObj"); if(o && o.value.trim() && typeof ndCarryText!=="undefined") ndCarryText=o.value.trim(); } if(window.openTab) window.openTab("planner",{replace:true}); else openPlanner(); }; // mesma aba vira o planner (BUG-8: o planner não fecha mais o formulário)
$id("emAbrir").onclick = pickFolder;
bindClick("emNovo", ()=>openNewProject());
$id("ntImport").onclick = importTaskMd;
$id("ntRefAdd").onclick = pickRefs;
$id("ntDzRefAdd").onclick = ()=>pickRefsInto(ntDzRefs, renderDzRefs);
$id("ntFixRefAdd").onclick = ()=>pickRefsInto(ntFixRefs, renderFixRefs);
$id("ntInvRefAdd").onclick = ()=>pickRefsInto(ntInvRefs, renderInvRefs);
$id("ntReqAdd").onclick = ()=>{ ntReq.push(""); renderNtList("ntRequirements",ntReq); };
// título por IA a partir da descrição (data-aititle="inputDoTitulo:inputDaDescricao")
document.querySelectorAll('[data-aititle]').forEach(b=>{
  b.onclick=async(e)=>{
    e.preventDefault();
    const [dst,src]=b.dataset.aititle.split(':');
    const text=($id(src)||{}).value||'';
    if(!text.trim()){ const s=$id(src); if(s){ s.focus(); s.placeholder='escreva a descrição primeiro — o título sai dela'; } return; }
    const orig=b.innerHTML; b.disabled=true; b.textContent='gerando…';
    try{ const t=await invoke('ai_title',{ text }); const d=$id(dst); if(d){ d.value=t; d.focus(); } }
    catch(err){ showErr(err, 'Não deu pra gerar o título'); }
    finally{ b.disabled=false; b.innerHTML=orig; }
  };
});
$id("ntOverlay").addEventListener("click", e=>{ if(e.target.id==="ntOverlay") closeNewTask(); });
$id("artClose").onclick = closeArtifact;
$id("artOverlay").addEventListener("click", e=>{ if(e.target.id==="artOverlay") closeArtifact(); });
$id("cmClose").onclick = closeCommit;
$id("cmOverlay").addEventListener("click", e=>{ if(e.target.id==="cmOverlay") closeCommit(); });
document.addEventListener("keydown", e=>{
  if(e.key==="Escape"){
    // um modal por vez (o de cima primeiro)
    if($id('artOverlay').style.display!=='none'){ closeArtifact(); return; }
    if($id('cmOverlay').style.display!=='none'){ closeCommit(); return; }
    // antes fechava SEMPRE o formulário e os Agentes: com outra aba ativa, matava o formulário de fundo
    // (rascunho perdido) e deixava a aba Agentes em branco. Agora só o que é MODAL (não aba) fecha aqui.
    const nt=$id('ntOverlay'), ag=$id('agOverlay');
    if(nt && nt.style.display!=='none' && !nt.classList.contains('astab') && !escBusy(e)){ closeNewTask(); return; }
    if(ag && ag.style.display!=='none' && !ag.classList.contains('astab') && !escBusy(e)){ cancelAgents(); return; } // pergunta se há mudança não salva
    return; }
  if((e.metaKey||e.ctrlKey) && !e.shiftKey){
    const k=e.key.toLowerCase();
    if(k==="n"){ e.preventDefault(); if(connected){ if(window.openTab) window.openTab('nova'); else openNewTask(); } }
    else if(k==="o"){ e.preventDefault(); pickFolder(); }
  }
});

/* ---------- editor Agentes & Equipes ---------- */
let cfgEdit = { agents:[], workflows:[] };
function escA(s){ return esc(s).replace(/"/g,"&quot;"); }
// @puro-agentes-inicio (testado em app/tests/agentes.test.mjs — sem DOM nem estado global)
// @cor-dado-inicio — cor padrão GRAVADA no agente novo (dado do usuário; o <input type=color> exige hex)
const AG_COLOR_PADRAO='#1e9e4a';
// @cor-dado-fim
function agSlug(s){ return (String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24))||"item"; }
// cabeçalho do .md de subagente (bloco entre ---): aceita CRLF (arquivo salvo no Windows), BOM, cabeçalho vazio
// (---\n---) e valor em bloco do YAML (description: > / |, com as linhas indentadas seguintes) — antes o regex só
// casava com \n e o arquivo inteiro virava persona, com o nome do arquivo no lugar do nome do agente
function agFrontmatter(content){
  const txt=String(content||'').replace(/^﻿/,'').replace(/\r\n?/g,'\n');
  const m=txt.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/);
  if(!m) return { fm:{}, body:txt.trim() };
  const fm={}, lines=(m[1]||'').split('\n');
  for(let n=0;n<lines.length;n++){
    const line=lines[n]; if(/^\s/.test(line)||!line.trim()) continue; // continuação solta (já tratada abaixo)
    const i=line.indexOf(':'); if(i<=0) continue;
    const k=line.slice(0,i).trim().toLowerCase(); let v=line.slice(i+1).trim();
    const block=v.match(/^([>|])[+-]?$/), more=[];
    while(n+1<lines.length && (/^\s+\S/.test(lines[n+1]) || (!lines[n+1].trim() && block))){ n++; more.push(lines[n].trim()); }
    while(more.length && !more[more.length-1]) more.pop();
    if(block) v=block[1]==='|' ? more.join('\n') : more.join(' ').replace(/\s+/g,' ').trim(); // | mantém as quebras; > junta
    else if(more.length) v=(v+' '+more.join(' ')).trim(); // valor simples quebrado em várias linhas
    fm[k]=v.replace(/^["']|["']$/g,'');
  }
  return { fm, body:m[2].trim() };
}
// .md de subagente → agente (sem id; quem chama dá o id único). Sem nome no cabeçalho: nome do arquivo sem .md
function agFromMd(filename, content){
  const { fm, body }=agFrontmatter(content);
  const name=fm.name || String(filename||'agente').replace(/\.md$/i,'') || 'agente';
  const persona=((fm.description ? fm.description.trim()+(body?' ':'') : '')+body).trim();
  return { name, role: fm.role || fm.category || 'builder', engine: (fm.engine==='mock'?'mock':'claude'), model: fm.model||undefined, color: fm.color || AG_COLOR_PADRAO, avatar: fm.avatar || '', persona };
}
// id de equipe ÚNICO sem NUNCA renomear um id existente: 1º reserva todos os ids que já existem, depois dá id
// só às equipes sem id (duas "Nova equipe" viravam nova-equipe e a 2ª sobrescrevia a 1ª). Devolve se mudou algo.
function wfEnsureIds(workflows){
  const used=new Set((workflows||[]).map(w=>w&&w.id).filter(Boolean)); let changed=false;
  (workflows||[]).forEach(w=>{ if(!w||w.id) return;
    const base=agSlug(w.name||'equipe'); let id=base, n=2; while(used.has(id)){ id=base+'-'+n; n++; } w.id=id; used.add(id); changed=true; });
  return changed;
}
// agente removido sai de TODAS as equipes (antes a etapa ficava órfã, mostrando o id cru); devolve quantas equipes mudaram
function wfDropAgent(workflows, agentId){
  let n=0; (workflows||[]).forEach(w=>{ const before=(w.steps||[]).length; w.steps=(w.steps||[]).filter(s=>s!==agentId); if(w.steps.length!==before) n++; });
  return n;
}
// @puro-agentes-fim
let agBase=''; // catálogo como veio do disco: cancelar com mudança não salva pergunta antes de descartar
function agDirty(){ return !!agBase && JSON.stringify(cfgEdit)!==agBase; }
function uniqueId(base){ let id=base, n=2; while(cfgEdit.agents.some(a=>a.id===id)){ id=base+"-"+n; n++; } return id; }
async function openAgents(){
  ovShow('agOverlay'); // a aba abre NA HORA (antes só aparecia depois do await) — com os agentes e equipes em esqueleto
  // enquanto o catálogo não chega (ou se a leitura falhar), nada de salvar/adicionar/importar em cima de um cfgEdit
  // velho (de outro projeto) ou vazio — isso apagava o catálogo
  cfgEdit = { agents:[], workflows:[] }; agBase=''; agLock(true);
  agShowFicha(false);
  AGS.rows=null; agStatsLoad().then(()=>{ if(agVisible()){ renderAg(); renderTeams(); renderWf(); if(AGF.id) agFichaRender(); } }); // boletim: UMA query, só ao abrir a aba
  { const w=$id('wfList'); if(w) ldPaint(w, skeletonHtml('lista', { n:2 })); }
  await loadInto($id('agList'), 'cards', ()=>invoke("config").catch(e=>{ const w=$id('wfList'); if(w) ldPaint(w, ''); throw e; }), (cfg)=>{
    cfg=cfg||{};
    cfgEdit = JSON.parse(JSON.stringify({ agents:cfg.agents||[], workflows:cfg.workflows||[] }));
    agBase = JSON.stringify(cfgEdit);
    renderAg(); renderTeams(); renderWf(); agLock(false); agSaveHint();
    if(typeof agTopSync==='function') agTopSync();
    if(typeof orgPolRender==='function') orgPolRender(); // F5 · P14: avisos da política (o formulário mora em Ajustes › Regras da organização)
    if(typeof agOrgCatRender==='function') agOrgCatRender(); // D18: catálogo da organização (enviar/aplicar) mora em Equipes › Do time
  }, { label:'lendo os agentes do projeto', ctx:'Não consegui ler os agentes', shape:{ n:6 } });
}
function agLock(on){ ['agSave','agAdd','wfAdd','agImport'].forEach(id=>{ const b=$id(id); if(b) b.disabled=!!on; }); }
function closeAgents(){ ovHide("agOverlay"); } // aba: fecha a aba (não deixa em branco)
async function cancelAgents(){ if(agDirty() && !await askYes('Descartar as mudanças nos agentes e equipes?\n\nNada foi salvo ainda.')) return; agBase=''; closeAgents(); }
const ROLES=["planner","builder","reviewer","designer","tester","docs","security"];
// @cor-dado-inicio — cor GRAVADA no agente (dado do usuário, vai pro .md/nuvem; o <input type=color> exige hex)
const PALETTE=["#1e9e4a","#e6b53c","#0a72e0","#a05cff","#e5484d","#12a3a3","#e07b39","#ec4899"];
// @cor-dado-fim
const GLYPHS=["🦊","🦉","🐙","🐢","🦋","🐝","🦁","🐬","🧠","⚡","🛠️","🔍","🎨","🧪","📝","🛡️"];
function avatarInner(a){ return a.avatar ? esc(a.avatar) : esc((a.name||"?").trim().slice(0,2).toUpperCase()); }
function allCats(){ const s=new Set(ROLES); cfgEdit.agents.forEach(a=>{ if(a.role) s.add(a.role); }); return [...s]; }
function addAgent(){ const id=uniqueId("agente"); cfgEdit.agents.push({id,name:"Novo agente",role:"builder",engine:"claude",persona:"",color:PALETTE[0],avatar:""}); agFichaOpen(id, 'editar'); agSaveHint(); }
// papel do agente em PT (o id técnico em inglês fica no tooltip)
const AG_ROLE_PT={ planner:'Planejador', builder:'Construtor', reviewer:'Revisor', docs:'Documentador', tester:'Testador', investigator:'Investigador', designer:'Designer', coder:'Construtor' };
function roleLabel(r){ const k=String(r||'').toLowerCase(); return AG_ROLE_PT[k]||r||''; }
// "Meu time" (61-meu-time): a grade de cartões; clicar abre a ficha DENTRO da aba; arrastar pra uma equipe insere etapa
function renderAg(){
  const el=$id("agList"); if(!el) return;
  const add = `<li class="agcard"><button class="agcard-b new" data-add><span class="plus" aria-hidden="true">+</span><span class="agc-tx"><span class="agc-n">novo agente</span><span class="agc-d">papel, motor, modelo e persona</span></span></button></li>`;
  el.innerHTML = `<ul class="aggrid2" aria-label="Agentes do time">${cfgEdit.agents.map(agCardHtml).join("")}${add}</ul>`;
  el.querySelectorAll("[data-open]").forEach(t=>t.onclick=()=>{ const a=cfgEdit.agents[+t.dataset.open]; if(!a) return; if(!a.id) a.id=uniqueId(agSlug(a.name||'agente')); agFichaOpen(a.id); });
  // cartões arrastáveis → soltar dentro de uma equipe insere uma etapa
  el.querySelectorAll("[data-agtile]").forEach(t=>{
    t.addEventListener("dragstart",e=>{ const a=cfgEdit.agents[+t.dataset.agtile]; if(a&&!a.id) a.id=uniqueId(agSlug(a.name||'agente')); agDrag={type:'agent', agentId:a?a.id:null}; t.classList.add('dragging'); e.dataTransfer.effectAllowed='copy'; });
    t.addEventListener("dragend",()=>{ agDrag=null; t.classList.remove('dragging'); document.querySelectorAll('.wfrow,.stepchip').forEach(x=>x.classList.remove('over','insbefore')); });
  });
  const addBtn=el.querySelector("[data-add]"); if(addBtn) addBtn.onclick=addAgent;
  agGridKeys(el);
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
    <div class="wftop"><span class="wfgrip" title="equipe">⠿</span><input class="wfname" value="${escA(w.name||'')}" data-wi="${i}" data-wk="name" placeholder="Nome da equipe (ex.: planejar → construir → revisar)"><span class="wfcount">${(w.steps||[]).length} etapa${(w.steps||[]).length===1?'':'s'}</span><button class="btn sm" data-wshare="${i}"${typeof orgCanShareTeams==='function'&&orgCanShareTeams()?'':' hidden'} title="publica esta equipe (e seus agentes) no catálogo da org — o time aplica com 1 clique" style="padding:2px 8px;font-size:var(--fs-xs)">⇡ compartilhar com o time</button><button class="iconbtn" data-wdel="${i}" title="remover equipe">${IC.trash}</button></div>
    <div class="steps" data-steps="${i}">${(w.steps||[]).map((sid,si)=>`<span class="stepchip" draggable="true" data-wi="${i}" data-si="${si}"><span class="sgrip">⠿</span><span class="snum">${si+1}</span><span class="cdot" style="background:${(byId[sid]&&byId[sid].color)||'var(--muted)'}"></span>${byId[sid]?`<b>${esc(byId[sid].name)}</b>`:`<b class="stepgone" title="${escA('o agente '+sid+' não existe mais no catálogo — tire esta etapa')}">agente removido</b>`}<button class="rm" data-wi="${i}" data-rm="${si}" title="tirar">${IC.xs}</button></span>`).join("")||'<span class="stepempty">arraste um agente pra cá, ou escolha ao lado →</span>'}${cfgEdit.agents.length?`<select class="sel wfaddsel" data-wadd="${i}" aria-label="adicionar etapa nesta equipe"><option value="">+ etapa…</option>${cfgEdit.agents.map(a=>`<option value="${escA(a.id||'')}">${esc(a.name||a.id||'agente')}</option>`).join('')}</select>`:''}</div>
    ${(()=>{ const roles=agTeamRoles(w.steps||[], byId, false); if(!roles.length) return ''; return `<div class="wfstrip">${agStripFor(roles)}</div>`+(typeof orgPolCovers==='function'&&orgPolCovers()?[]:agTeamWarnings(roles)).map(x=>`<p class="agwarn" role="note">${esc(x.text)} (${esc(x.detail)})</p>`).join('')+(typeof orgPolIssuesHtml==='function'?orgPolIssuesHtml(roles):''); })()}
  </div>`).join("") || '<div class="dim" style="font-size:var(--fs-sm);padding:6px 0">nenhuma equipe — clique "+ nova equipe"</div>';
  el.querySelectorAll("[data-wk]").forEach(inp=>inp.addEventListener("input",()=>{ cfgEdit.workflows[+inp.dataset.wi][inp.dataset.wk]=inp.value; }));
  el.querySelectorAll("[data-wdel]").forEach(b=>b.onclick=async()=>{ const w=cfgEdit.workflows[+b.dataset.wdel]; if(!w) return; // F4: remover equipe confirma (agente já confirmava)
    if(!await askYes('Remover a equipe "'+(w.name||'equipe')+'"?\n\nOs agentes continuam. Só vale depois de salvar.')) return; cfgEdit.workflows.splice(+b.dataset.wdel,1); renderWf(); agSaveHint(); });
  // compartilhar UMA equipe com o time (redesign p18) — publica o workflow + os agentes dele
  el.querySelectorAll("[data-wshare]").forEach(b=>b.onclick=async()=>{
    const w=cfgEdit.workflows[+b.dataset.wshare]; if(!w) return;
    const orgId=cloudData&&cloudData.org&&cloudData.org.id;
    if(!SB.sess()||!orgId){ toast('Entre na sua conta e numa organização primeiro (Conta e time, no rodapé da barra lateral).','warn'); return; }
    // F5 · P14/P17: a equipe passa pela política da organização antes de ir pro catálogo do time
    { const byId0=Object.fromEntries(cfgEdit.agents.map(a=>[a.id,a])); const bad=typeof orgTeamShareBlock==='function'?orgTeamShareBlock(agTeamRoles(w.steps||[], byId0, false)):'';
      if(bad){ toast('Não publiquei: '+bad+'.','warn'); return; } }
    b.disabled=true; const o=b.textContent; b.textContent='publicando…';
    try{
      wfEnsureIds(cfgEdit.workflows); // id único (duas equipes com o mesmo nome não se sobrescrevem no catálogo do time)
      const byId2=Object.fromEntries(cfgEdit.agents.map(a=>[a.id,a]));
      for(const sid of (w.steps||[])){ const a=byId2[sid]; if(!a) continue; if(!a.id) a.id=uniqueId(agSlug(a.name));
        await sbFetch('/rest/v1/org_agents?on_conflict=org_id,id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ org_id:orgId, id:a.id, name:a.name, role:a.role||'builder', engine:a.engine||'claude', model:a.model||null, color:a.color||null, persona:a.persona||'' }) }); }
      await sbFetch('/rest/v1/org_workflows?on_conflict=org_id,id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ org_id:orgId, id:w.id, name:w.name, steps:w.steps||[] }) });
      b.textContent='✓ no catálogo do time';
      setTimeout(()=>{ b.disabled=false; b.textContent=o; }, 3000);
    }catch(e){ showErr(e, 'Falhou'); b.disabled=false; b.textContent=o; }
  });
  // adicionar etapa sem arrastar (teclado, trackpad difícil): o select no fim da equipe
  el.querySelectorAll("[data-wadd]").forEach(sel=>sel.onchange=()=>{ const wi=+sel.dataset.wadd; let id=sel.value; if(!id&&sel.selectedIndex>0){ const a=cfgEdit.agents[sel.selectedIndex-1]; if(a){ a.id=uniqueId(agSlug(a.name||'agente')); id=a.id; } } if(id) wfInsert(wi, id, null); });
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
  const a=agFromMd(filename, content); return Object.assign({ id: uniqueId(agSlug(a.name)) }, a);
}
async function importAgents(){
  let files;
  try{ files = await invoke("import_agent_files"); }catch(e){ showErr(e, 'Falha ao importar'); return; }
  if(!files || !files.length) return;
  for(const f of files) cfgEdit.agents.push(parseAgentMd(f.filename, f.content));
  renderAg(); renderWf();
}
async function saveConfig(){
  cfgEdit.agents.forEach(a=>{ if(!a.id) a.id=uniqueId(agSlug(a.name)); });
  wfEnsureIds(cfgEdit.workflows); cfgEdit.workflows.forEach(w=>{ if(!w.steps) w.steps=[]; });
  const btn=$id("agSave"); btn.disabled=true; btn.textContent="salvando…";
  try{
    await invoke("save_config",{config:cfgEdit}); state.config=JSON.parse(JSON.stringify(cfgEdit)); lastSig='';
    // na ficha: fica nela (a versão nova aparece no cabeçalho); na grade: fecha a aba como antes
    if(AGF.id){ agBase=JSON.stringify(cfgEdit); await agFichaLoad(); agSaveHint(); toast('Salvo — cada agente alterado ganhou uma versão nova','ok'); }
    else { agBase=JSON.stringify(cfgEdit); agSaveHint(); toast('Agentes e equipes salvos','ok'); } // F4: salvar NUNCA fecha a aba
  }
  catch(e){ showErr(e, 'Falha ao salvar catálogo'); }
  finally{ btn.disabled=false; btn.textContent="salvar"; }
}
$id("agentsBtn").onclick = openAgents;
$id("agClose").onclick = cancelAgents;
$id("agCancel").onclick = cancelAgents;
$id("agSave").onclick = saveConfig;
$id("agAdd").onclick = addAgent;
$id("agImport").onclick = importAgents;
$id("wfAdd").onclick = ()=>{ cfgEdit.workflows.push({ id:"", name:"Nova equipe", steps:[] }); renderWf(); };
$id("agOverlay").addEventListener("click", e=>{ if(e.target.id==="agOverlay") cancelAgents(); });

// rede de segurança global: o registro de erro solto/promise sem catch fica no 52-erros (app_errors) e no
// 10-core (web_log) — aqui só evita o aviso padrão do WebView pra rejeição sem catch (o console.error
// que havia aqui duplicava o mesmo erro nos dois registros).
window.addEventListener("unhandledrejection", e=>{ e.preventDefault(); });

// boot: se CARDUME_REPO foi setado, snapshot já traz dados; senão espera "conectar".
// painel da tela dividida (58-canvas): só a demanda dele — sem notificações, projetos nem a tela inicial
if(typeof SF_PANE!=='undefined' && SF_PANE) document.addEventListener('DOMContentLoaded', ()=>{ if(window.sfPaneBoot) window.sfPaneBoot(); });
else {
initNotifs();
refresh().then(loadProjects).then(restoreMainView).then(()=>{ if(window.cvRestoreSplit) window.cvRestoreSplit(); }).catch(e=>console.error("boot:", e));
}
// poll blindado: uma volta que falhe não derruba o ciclo
// um refresh por vez (o tick de 1s empilhava vários em paralelo), mas a trava NUNCA fica presa: se um refresh
// não voltar em 6s (IPC perdido, SQLite ocupado), o próximo tick segue — antes a tela parava de atualizar pra sempre
// Carimbo antes do snapshot: `snapshot_stamp` (Rust, só stat do state.sqlite/-wal) é quase grátis; o snapshot
// inteiro (~0,5 MB de JSON serializado, cruzando IPC e parseado aqui) só vem quando o banco mudou, quando
// alguém pediu redesenho (lastSig mexido fora daqui), logo após um clique (render segurado pelo uiHold) ou
// a cada 3s (pid vivo, cache multi-projeto — o que não mora no banco). Janela escondida: 1 volta a cada 4s
// e snapshot completo no máx. a cada 12s. Sem o comando (build antigo / harness) = sempre snapshot.
let refreshBusyAt=0, stampBusyAt=0, pollAt=0, snapStamp=null, snapFullAt=0, snapSigMark=null;
setInterval(async()=>{
  const now=Date.now();
  if(refreshBusyAt && now-refreshBusyAt<6000) return;
  if(stampBusyAt && now-stampBusyAt<6000) return;
  const hidden=document.hidden;
  if(hidden && now-pollAt<4000) return;
  pollAt=now;
  let stamp=null;
  stampBusyAt=now; try{ stamp=await invoke("snapshot_stamp"); }catch(_){ stamp=null; } finally{ stampBusyAt=0; }
  if(stamp && stamp===snapStamp && lastSig===snapSigMark && Date.now()-snapFullAt<(hidden?12000:3000) && Date.now()-uiHoldUntil>1500){
    if(typeof loadAllTasks==='function') loadAllTasks(); // cache multi-projeto segue no ritmo dele (throttle de 4s próprio)
    return;
  }
  const my=refreshBusyAt=Date.now(); const before=state;
  refresh().then(()=>{ if(state!==before){ snapStamp=stamp; snapFullAt=Date.now(); snapSigMark=lastSig; } })
    .catch(e=>console.error("refresh:", e)).finally(()=>{ if(refreshBusyAt===my) refreshBusyAt=0; });
}, 1000);

// ===== F4 (G1, D15/D18): Projeto › Agentes — abas Agentes · Equipes; "Do time" = catálogo da organização =====
let agTop=lsGet('agTop')==='eq'?'eq':'ag';
function agTopSync(){
  const ag=$id('agPanelAg'), eq=$id('agPanelEq'); if(!ag||!eq) return;
  ag.hidden=agTop!=='ag'; eq.hidden=agTop!=='eq';
  [['agTabAg','ag'],['agTabEq','eq']].forEach(([id,k])=>{ const b=$id(id); if(b){ b.classList.toggle('on', agTop===k); b.setAttribute('aria-selected', agTop===k); b.tabIndex=agTop===k?0:-1; } });
  const na=$id('agTabAgN'), ne=$id('agTabEqN');
  if(na) na.textContent=String((cfgEdit&&cfgEdit.agents||[]).length||'');
  if(ne){ const prontas=($id('agTeams')?$id('agTeams').querySelectorAll('.agteam').length:0); ne.textContent=String((prontas+(cfgEdit&&cfgEdit.workflows||[]).length)||''); } // o que a aba Equipes MOSTRA (prontas + minhas)
}
document.querySelectorAll('[data-agtop]').forEach(b=>{ b.onclick=()=>{ agTop=b.dataset.agtop; lsSet('agTop', agTop); agShowFicha(false); agTopSync(); };
  b.onkeydown=e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return; e.preventDefault(); agTop=agTop==='ag'?'eq':'ag'; lsSet('agTop',agTop); agTopSync(); const n=$id(agTop==='ag'?'agTabAg':'agTabEq'); if(n) n.focus(); }; });
bindClick('agEqModo', ()=>{ if(typeof ajustesOpen==='function') ajustesOpen('modo'); else if(window.openTab) window.openTab('cfg'); });
// catálogo da org (antes em Conta › "Agentes & equipes da organização"): só com sessão + organização
function agOrgCatRender(){
  const el=$id('agOrgCat'); if(!el) return;
  const org=(typeof cloudData!=='undefined' && cloudData && cloudData.org)||null;
  if(!(typeof SB!=='undefined' && SB.sess() && org)){ el.innerHTML=''; return; }
  const isAdmin=cloudData.meRole==='owner'||cloudData.meRole==='admin';
  el.innerHTML=`<div class="pgsh3"><h3>Do time</h3><span>catálogo da organização ${esc(org.name||'')}</span><span class="grow"></span>${isAdmin?'<button class="btn sm" id="sbCatPush">enviar os deste projeto</button>':''}<button class="btn sm primary" id="sbCatPull">aplicar neste projeto</button></div><div id="sbCat" class="pgnote">lendo o catálogo…</div>`;
  if(typeof cloudCatalog==='function') cloudCatalog(org.id, isAdmin);
}
