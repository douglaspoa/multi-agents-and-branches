// Constellation — 13-skills-projetos
// ===== Skills: biblioteca (adicionar) + habilitar por projeto =====
let skAddOpen=false, skAddMode='git', skGitFound=null, skList=[], skQuery='';
async function openSkills(){
  const mm=$id('moreMenu'); if(mm) mm.style.display='none';
  const body=$id('skBody');
  $id('skOverlay').style.display='flex';
  body.innerHTML='<div class="dim" style="padding:20px">carregando skills…</div>';
  try{ skList=await invoke('list_skills'); }catch(e){ body.innerHTML='<div class="imhint" style="border-left:2px solid var(--crit)">Falhou listar skills: '+esc(String(e&&e.message||e))+'</div>'; return; }
  skRender();
}
function skAddPanelHtml(){
  const tab=(m,l)=>`<span class="at ${skAddMode===m?'on':''}" data-skmode="${m}">${l}</span>`;
  let b='';
  if(skAddMode==='git'){
    const found = skGitFound ? (skGitFound.length
        ? `<div class="found"><div class="foundh">✓ ${skGitFound.length} skill(s) no repo — escolha</div>${skGitFound.map((s,i)=>`<label class="foundit"><input type="checkbox" data-gk="${escA(s.name)}" checked><b>${esc(s.name)}</b><span class="dim">${esc(String(s.description||'').slice(0,90))}</span></label>`).join('')}</div>`
        : `<div class="rawarn" style="margin-top:10px">Nenhum SKILL.md achado nesse repo/subpasta.</div>`) : '';
    b=`<label>URL do repositório Git <span class="dim" style="font-weight:400">(muita skill vem como repo)</span></label>
      <input class="in mono" id="skGitUrl" placeholder="https://github.com/org/repo.git" style="font-size:12px">
      <div style="display:flex;gap:8px;margin-top:8px"><input class="in mono" id="skGitBranch" placeholder="branch (opcional)" style="font-size:11.5px;flex:1"><input class="in mono" id="skGitSub" placeholder="subpasta (opcional)" style="font-size:11.5px;flex:1"></div>
      ${found}
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center">${skGitFound&&skGitFound.length?`<button class="btn primary" id="skGitImport">importar selecionadas</button>`:`<button class="btn primary" id="skGitDetect">detectar skills</button>`}<button class="btn" id="skAddCancel">cancelar</button></div>`;
  } else if(skAddMode==='criar'){
    b=`<label>Nome</label><input class="in mono" id="skNewName" placeholder="ex.: revisar-pr-logcomex" style="font-size:12px">
      <label>Quando usar <span class="dim" style="font-weight:400">(o gatilho — a IA lê isso pra saber quando disparar)</span></label>
      <textarea class="in" id="skNewDesc" rows="2" placeholder="Use SEMPRE que for revisar um PR nos repos X… dispara mesmo sem pedir"></textarea>
      <label>Instruções</label><textarea class="in" id="skNewBody" rows="5" placeholder="o passo a passo / regras da skill (markdown)"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="skDoCreate">salvar na biblioteca</button><button class="btn" id="skAddCancel">cancelar</button></div>`;
  } else if(skAddMode==='importar'){
    b=`<label>Cole o conteúdo do SKILL.md <span class="dim" style="font-weight:400">(o nome sai do frontmatter)</span></label>
      <textarea class="in mono" id="skImpMd" rows="8" style="font-size:11.5px" placeholder="---\nname: minha-skill\ndescription: quando usar…\n---\n\n# Instruções\n…"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="skDoImport">importar</button><button class="btn" id="skAddCancel">cancelar</button></div>`;
  } else {
    b=`<div class="dim" style="line-height:1.6;padding:2px 0 6px">Pra criar com IA, abra uma <b>Nova demanda</b> pedindo a skill-creator (ex.: "crie uma skill que padroniza como abro PR"), ou use o <span class="mono">skill-creator</span> no Claude Code. Depois ela aparece aqui na biblioteca.</div>
      <div style="margin-top:4px"><button class="btn" id="skAddCancel">fechar</button></div>`;
  }
  return `<div class="addpanel"><div class="addtabs">${tab('git','Do Git')}${tab('criar','Criar do zero')}${tab('importar','Importar SKILL.md')}${tab('ia','✦ Com IA')}</div>${b}<div class="dim" style="font-size:11px;margin-top:10px">vai pra ~/.claude/skills/</div></div>`;
}
function skRender(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const body=$id('skBody'); if(!body) return;
  const all=skList||[];
  const q=(skQuery||'').trim().toLowerCase();
  const list=q?all.filter(s=>((s.name||'')+' '+(s.description||'')).toLowerCase().includes(q)):all;
  const nOn=all.filter(s=>s.active).length, allOn=all.length&&nOn===all.length;
  const bar=all.length?Math.round(nOn/all.length*100):0;
  const sw=(nm,on)=>`<label class="sw"><input type="checkbox" data-sk="${escA(nm)}"${on?' checked':''}><span class="tr"><span class="kn"></span></span></label>`;
  const cards=list.length
    ? list.map(s=>`<div class="skc${s.active?' on':''}"><div class="skc-h"><span class="skc-name">${esc(s.name)}</span><span class="skc-scope">${esc(s.source||'')}</span><span style="flex:1"></span>${sw(s.name,s.active)}</div><div class="skc-d">${esc(String(s.description||'(sem descrição)').slice(0,220))}${(s.description||'').length>220?'…':''}</div></div>`).join('')
    : `<div class="dim" style="padding:20px 2px">${q?'nada encontrado pra <b>'+esc(skQuery)+'</b>':'Biblioteca vazia — use <b>+ adicionar skill</b> (do Git, SKILL.md ou criar).'}</div>`;
  body.innerHTML=`<div class="sk-screen">
    <div class="sk-head">
      <div><h1 class="sk-h1">Skills</h1><p class="sk-sub">Skills ligadas viram instrução para os agentes deste projeto — entram sozinhas quando o gatilho bate.</p></div>
      <div class="sk-actions">
        <div class="sk-search"><span class="sk-sd"></span><input id="skQ" value="${escA(skQuery)}" placeholder="filtrar por nome ou gatilho"></div>
        <button class="sk-add" id="skAddBtn">+ adicionar skill</button>
      </div>
    </div>
    <div class="sk-stats"><span class="sk-mono">${all.length} na biblioteca</span><span class="sk-mono on">${nOn} ativas neste projeto</span><span class="sk-progress"><i style="width:${bar}%"></i></span><button class="sk-toggleall" id="skToggleAll">${allOn?'desligar todas':'ligar todas'}</button></div>
    ${skAddOpen?skAddPanelHtml():''}
    <div class="sk-grid">${cards}</div>
  </div>`;
  { const qi=body.querySelector('#skQ'); if(qi){ qi.oninput=()=>{ skQuery=qi.value; skRender(); const n=body.querySelector('#skQ'); if(n){ n.focus(); const v=n.value; n.value=''; n.value=v; } }; } }
  body.querySelectorAll('[data-sk]').forEach(cb=>cb.onchange=()=>skToggle(cb.dataset.sk, cb.checked));
  { const b=body.querySelector('#skAddBtn'); if(b) b.onclick=()=>{ skAddOpen=!skAddOpen; skGitFound=null; skRender(); }; }
  { const b=body.querySelector('#skToggleAll'); if(b) b.onclick=()=>skSetAll(!allOn); }
  { const b=body.querySelector('#skAddCancel'); if(b) b.onclick=()=>{ skAddOpen=false; skGitFound=null; skRender(); }; }
  body.querySelectorAll('[data-skmode]').forEach(el=>el.onclick=()=>{ skAddMode=el.dataset.skmode; skGitFound=null; skRender(); });
  { const b=body.querySelector('#skGitDetect'); if(b) b.onclick=skGitDetect; }
  { const b=body.querySelector('#skGitImport'); if(b) b.onclick=skGitImport; }
  { const b=body.querySelector('#skDoCreate'); if(b) b.onclick=skDoCreate; }
  { const b=body.querySelector('#skDoImport'); if(b) b.onclick=skDoImport; }
}
async function skSetAll(on){
  (skList||[]).forEach(s=>s.active=on);
  const active=on?(skList||[]).map(x=>({name:x.name,description:x.description||''})):[];
  try{ await invoke('set_active_skills',{ skills: active }); }catch(e){ alert('Falhou: '+(e&&e.message||e)); }
  skRender();
}
async function skToggle(name, on){
  const s=(skList||[]).find(x=>x.name===name); if(s) s.active=on;
  const active=(skList||[]).filter(x=>x.active).map(x=>({ name:x.name, description:x.description||'' }));
  try{ await invoke('set_active_skills',{ skills: active }); }catch(e){ alert('Falhou salvar as skills: '+(e&&e.message||e)); if(s) s.active=!on; }
  skRender();
}
function skGitVals(){ return { url:($id('skGitUrl')||{}).value||'', branch:($id('skGitBranch')||{}).value||'', subpath:($id('skGitSub')||{}).value||'' }; }
async function skGitDetect(){
  const {url,branch,subpath}=skGitVals(); if(!url.trim()){ alert('Cole a URL do repositório.'); return; }
  const b=$id('skGitDetect'); if(b){ b.disabled=true; b.textContent='clonando…'; }
  try{ const r=await invoke('git_skills',{ url:url.trim(), branch:branch.trim()||null, subpath:subpath.trim()||null, picks:null }); skGitFound=r.found||[]; skRender(); }
  catch(e){ alert('Falhou: '+(e&&e.message||e)); if(b){ b.disabled=false; b.textContent='detectar skills'; } }
}
async function skGitImport(){
  const {url,branch,subpath}=skGitVals();
  const picks=[...document.querySelectorAll('[data-gk]:checked')].map(c=>c.dataset.gk);
  if(!picks.length){ alert('Marque ao menos uma skill.'); return; }
  const b=$id('skGitImport'); if(b){ b.disabled=true; b.textContent='importando…'; }
  try{ await invoke('git_skills',{ url:url.trim(), branch:branch.trim()||null, subpath:subpath.trim()||null, picks }); skAddOpen=false; skGitFound=null; await openSkills(); }
  catch(e){ alert('Falhou importar: '+(e&&e.message||e)); if(b){ b.disabled=false; b.textContent='importar selecionadas'; } }
}
async function skDoCreate(){
  const name=($id('skNewName')||{}).value||'', desc=($id('skNewDesc')||{}).value||'', bodyv=($id('skNewBody')||{}).value||'';
  if(!name.trim()||!desc.trim()){ alert('Preencha nome e "quando usar".'); return; }
  try{ await invoke('create_skill',{ name:name.trim(), description:desc.trim(), body:bodyv }); skAddOpen=false; await openSkills(); }
  catch(e){ alert('Falhou criar: '+(e&&e.message||e)); }
}
async function skDoImport(){
  const md=($id('skImpMd')||{}).value||'';
  if(!md.trim()){ alert('Cole o conteúdo do SKILL.md.'); return; }
  try{ await invoke('import_skill_md',{ content:md }); skAddOpen=false; await openSkills(); }
  catch(e){ alert('Falhou importar: '+(e&&e.message||e)); }
}
bindClick('skillsBtn', openSkills);
bindClick('skClose', ()=>{ $id('skOverlay').style.display='none'; });
$id('skOverlay').addEventListener('click',e=>{ if(e.target.id==='skOverlay') $id('skOverlay').style.display='none'; });
// ===== Hub de Projetos =====
async function openProjetos(){
  const body=$id('projetosBody');
  $id('projetosOverlay').style.display='flex';
  body.innerHTML='<div class="dim" style="padding:20px">carregando…</div>';
  let ov=[]; try{ ov=await invoke('projects_overview'); }catch(_){}
  projetosRender(ov);
}
function projetosRender(ov){
  const body=$id('projetosBody'); if(!body) return;
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const n=(ov||[]).length;
  const head=`<div class="as-head"><div><h1 class="as-h1">Projetos</h1><p class="as-sub">Tudo aparece junto no quadro — aqui você gerencia cada repositório.</p></div><div class="as-actions"><span class="as-note">${n} projeto${n===1?'':'s'}</span><button class="as-btn primary" id="projAddBtn2">+ adicionar projeto</button></div></div>`;
  const cards=(ov||[]).map(p=>{
    const col=projColor(p.path);
    const run=p.active?`<b style="color:var(--accent)">${p.active} rodando</b>`:'<span class="dim">nada rodando</span>';
    return `<div class="projcard2 as-card">
      <div class="pc2name"><span class="pc2d" style="background:${col}"></span>${esc(p.name)}${p.path===state.repo?' <span class="as-badge" style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)">aberto</span>':''}</div>
      <div class="pc2meta">${p.review?`<b style="color:var(--warn)">${p.review} em review</b> · `:''}${run}</div>
      <div class="pc2path mono">${esc(p.path)}</div>
      <div class="pc2acts"><button class="btn sm" data-pjopen="${escA(p.path)}">ver tarefas</button><button class="btn sm" data-pjsk="${escA(p.path)}">skills</button><button class="btn sm" data-pjfx="${escA(p.path)}">Finder</button><button class="btn sm" data-pjrm="${escA(p.path)}">remover</button></div>
    </div>`;
  }).join('') || '<div class="as-card" style="color:rgba(255,255,255,.45);font-size:13.5px">Nenhum projeto ainda. Use "+ adicionar projeto".</div>';
  body.innerHTML=`<div class="appscreen">${head}<div class="as-sect">repositórios</div><div class="projgrid2">${cards}</div></div>`;
  { const b=body.querySelector('#projAddBtn2'); if(b) b.onclick=()=>{ if(window.pickFolder) window.pickFolder(); }; }
  body.querySelectorAll('[data-pjopen]').forEach(b=>b.onclick=async()=>{ const p=b.dataset.pjopen; projFilter=p; lsSet('projFilter',p); if(p!==state.repo && window.switchProject) await window.switchProject(p); if(window.openTab) window.openTab('flow'); });
  body.querySelectorAll('[data-pjsk]').forEach(b=>b.onclick=async()=>{ const p=b.dataset.pjsk; if(p!==state.repo && window.switchProject) await window.switchProject(p); if(window.openTab) window.openTab('skills'); });
  body.querySelectorAll('[data-pjfx]').forEach(b=>b.onclick=()=>invoke('open_url',{url:'file://'+b.dataset.pjfx}).catch(()=>{}));
  body.querySelectorAll('[data-pjrm]').forEach(b=>b.onclick=async()=>{ if(!confirm('Remover '+projShort(b.dataset.pjrm)+' da lista? (não apaga arquivos)')) return; try{ await invoke('remove_project',{path:b.dataset.pjrm}); }catch(_){}; openProjetos(); });
}
bindClick('projetosClose', ()=>{ $id('projetosOverlay').style.display='none'; });
$id('projetosOverlay').addEventListener('click',e=>{ if(e.target.id==='projetosOverlay') $id('projetosOverlay').style.display='none'; });
