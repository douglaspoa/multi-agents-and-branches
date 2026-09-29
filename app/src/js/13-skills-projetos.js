// Starfork — 13-skills-projetos
// ===== Skills: biblioteca (adicionar) + habilitar por projeto =====
let skAddOpen=false, skAddMode='git', skGitFound=null, skList=[], skQuery='';
async function openSkills(){
  const mm=$id('moreMenu'); if(mm) mm.style.display='none';
  const body=$id('skBody');
  $id('skOverlay').style.display='flex';
  // pinta os cartões-esqueleto na hora; erro vira "tentar de novo" (antes: texto cru e nenhuma saída)
  await loadInto(body, 'cards', ()=>invoke('list_skills'), (l)=>{ skList=l||[]; skRender(); },
    { label:'buscando as skills', ctx:'Não consegui listar as skills', shape:{ wrap:'sk-screen', head:true, n:9 } });
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
    b=`<label>Nome</label><input class="in mono" id="skNewName" placeholder="ex.: revisar-pr-do-time" style="font-size:12px">
      <label>Quando usar <span class="dim" style="font-weight:400">(o gatilho — a IA lê isso pra saber quando disparar)</span></label>
      <textarea class="in" id="skNewDesc" rows="2" placeholder="Use SEMPRE que for revisar um PR nos repos X… dispara mesmo sem pedir"></textarea>
      <label>Instruções</label><textarea class="in" id="skNewBody" rows="5" placeholder="o passo a passo / regras da skill (markdown)"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="skDoCreate">salvar na biblioteca</button><button class="btn" id="skAddCancel">cancelar</button></div>`;
  } else if(skAddMode==='importar'){
    b=`<label>Cole o conteúdo do SKILL.md <span class="dim" style="font-weight:400">(o nome vem do cabeçalho do arquivo, o bloco entre as linhas ---)</span></label>
      <textarea class="in mono" id="skImpMd" rows="8" style="font-size:11.5px" placeholder="---\nname: minha-skill\ndescription: quando usar…\n---\n\n# Instruções\n…"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="skDoImport">importar</button><button class="btn" id="skAddCancel">cancelar</button></div>`;
  } else {
    b=`<label>O que a skill deve fazer? <span class="dim" style="font-weight:400">(a IA monta a skill conversando com você)</span></label>
      <textarea class="in" id="skAiIdea" rows="2" placeholder="ex.: padronizar como eu abro PR — título, descrição e checklist"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="skAiGo">${ic('spark')}montar com IA</button><button class="btn" id="skAddCancel">cancelar</button></div>
      <div class="dim" style="font-size:11px;margin-top:8px;line-height:1.5">Abre o <b>Montar conversando</b> com o pedido pronto. Quando a tarefa terminar, a skill aparece aqui na biblioteca.</div>`;
  }
  return `<div class="addpanel"><div class="addtabs">${tab('git','Do Git')}${tab('criar','Criar do zero')}${tab('importar','Importar SKILL.md')}${tab('ia',IC.starforkEm+' Com IA')}</div>${b}<div class="dim" style="font-size:11px;margin-top:10px">vai pra ~/.claude/skills/</div></div>`;
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
    : q ? emptyHtml({ icon:'search', title:'Nenhuma skill com “'+skQuery.trim()+'”', help:'A busca olha o nome e o gatilho (quando usar) de cada skill.', action:{ id:'skClearQ', label:'limpar busca', primary:false } })
    : skAddOpen ? '' : emptyHtml({ icon:'stack', title:'Nenhuma skill na biblioteca', help:'Traga de um repositório Git, de um SKILL.md ou crie uma do zero.', action:{ id:'skEmptyAdd', label:'+ adicionar skill' } });
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
  { const b=body.querySelector('#skClearQ'); if(b) b.onclick=()=>{ skQuery=''; skRender(); const n=body.querySelector('#skQ'); if(n) n.focus(); }; }
  { const b=body.querySelector('#skEmptyAdd'); if(b) b.onclick=()=>{ skAddOpen=true; skGitFound=null; skRender(); }; }
  { const b=body.querySelector('#skToggleAll'); if(b) b.onclick=()=>skSetAll(!allOn); }
  { const b=body.querySelector('#skAddCancel'); if(b) b.onclick=()=>{ skAddOpen=false; skGitFound=null; skRender(); }; }
  body.querySelectorAll('[data-skmode]').forEach(el=>el.onclick=()=>{ skAddMode=el.dataset.skmode; skGitFound=null; skRender(); });
  { const b=body.querySelector('#skGitDetect'); if(b) b.onclick=skGitDetect; }
  { const b=body.querySelector('#skGitImport'); if(b) b.onclick=skGitImport; }
  { const b=body.querySelector('#skDoCreate'); if(b) b.onclick=skDoCreate; }
  { const b=body.querySelector('#skDoImport'); if(b) b.onclick=skDoImport; }
  { const b=body.querySelector('#skAiGo'); if(b) b.onclick=skAiCreate; }
}
// Com IA: abre o "Montar conversando" com o pedido da skill já escrito na caixa (openPlanner é async —
// carrega o rascunho —, então espera a caixa aparecer e só preenche se ela estiver vazia)
function skAiCreate(){
  const idea=(($id('skAiIdea')||{}).value||'').trim();
  const text='Crie uma skill do Claude Code (SKILL.md em ~/.claude/skills/, use o skill-creator) que '+(idea||'…');
  skAddOpen=false;
  if(!window.openTab) return;
  window.openTab('planner');
  let n=0; const fill=()=>{ const i=$id('plInput'), o=$id('plannerOverlay');
    if(i && o && o.style.display!=='none' && n>3){ if(!i.value.trim()){ i.value=text; i.dispatchEvent(new Event('input')); } else toast('Já tinha um rascunho na conversa — o pedido da skill não foi colado por cima.','warn'); i.focus(); return; }
    if(++n<20) setTimeout(fill, 150); };
  setTimeout(fill, 150);
}
// "Criar projeto novo" (tela vazia, onboarding): abre a aba Projetos já com o formulário de projeto novo aberto
function openNewProject(){ projNewOpen=true; projNewMsg=''; if(window.openTab) window.openTab('projetos'); else openProjetos(); setTimeout(()=>{ const i=$id('pnName'); if(i) i.focus(); }, 400); }
window.openNewProject=openNewProject;
// @puro-skills-inicio (testado em app/tests/skills.test.mjs)
// foto do "ligada?" POR NOME: se a lista for recarregada/reordenada no meio, a volta não troca uma skill pela outra
function skSnapshot(list){ const m={}; (list||[]).forEach(s=>{ if(s&&s.name!=null) m[s.name]=!!s.active; }); return m; }
function skRestore(list, snap){ (list||[]).forEach(s=>{ if(s && Object.prototype.hasOwnProperty.call(snap||{}, s.name)) s.active=snap[s.name]; }); return list; }
// @puro-skills-fim
async function skSetAll(on){
  const before=skSnapshot(skList); // falhou salvar: volta como estava (antes a tela mostrava tudo ligado sem ter salvo)
  (skList||[]).forEach(s=>s.active=on);
  const active=on?(skList||[]).map(x=>({name:x.name,description:x.description||''})):[];
  try{ await invoke('set_active_skills',{ skills: active }); }
  catch(e){ skRestore(skList, before); showErr(e, on?'Não consegui ligar as skills':'Não consegui desligar as skills'); }
  skRender();
}
async function skToggle(name, on){
  const s=(skList||[]).find(x=>x.name===name); if(s) s.active=on;
  const active=(skList||[]).filter(x=>x.active).map(x=>({ name:x.name, description:x.description||'' }));
  try{ await invoke('set_active_skills',{ skills: active }); }catch(e){ showErr(e, 'Falhou salvar as skills'); if(s) s.active=!on; }
  skRender();
}
function skGitVals(){ return { url:($id('skGitUrl')||{}).value||'', branch:($id('skGitBranch')||{}).value||'', subpath:($id('skGitSub')||{}).value||'' }; }
async function skGitDetect(){
  const {url,branch,subpath}=skGitVals(); if(!url.trim()){ toast('Cole a URL do repositório.','warn'); ($id('skGitUrl')||{focus(){}}).focus(); return; }
  const b=$id('skGitDetect'); if(b){ b.disabled=true; b.textContent='clonando…'; }
  try{ const r=await invoke('git_skills',{ url:url.trim(), branch:branch.trim()||null, subpath:subpath.trim()||null, picks:null }); skGitFound=r.found||[]; skRender(); }
  catch(e){ showErr(e, 'Falhou'); if(b){ b.disabled=false; b.textContent='detectar skills'; } }
}
async function skGitImport(){
  const {url,branch,subpath}=skGitVals();
  const picks=[...document.querySelectorAll('[data-gk]:checked')].map(c=>c.dataset.gk);
  if(!picks.length){ toast('Marque ao menos uma skill.','warn'); return; }
  const b=$id('skGitImport'); if(b){ b.disabled=true; b.textContent='importando…'; }
  try{ await invoke('git_skills',{ url:url.trim(), branch:branch.trim()||null, subpath:subpath.trim()||null, picks }); skAddOpen=false; skGitFound=null; await openSkills();
    toast(picks.length===1?'Skill '+picks[0]+' importada — ligue ela no projeto pelo interruptor.':picks.length+' skills importadas — ligue as que quiser neste projeto.','ok'); }
  catch(e){ showErr(e, 'Falhou importar'); if(b){ b.disabled=false; b.textContent='importar selecionadas'; } }
}
async function skDoCreate(){
  const name=($id('skNewName')||{}).value||'', desc=($id('skNewDesc')||{}).value||'', bodyv=($id('skNewBody')||{}).value||'';
  if(!name.trim()||!desc.trim()){ toast('Preencha nome e "quando usar".','warn'); return; }
  try{ await invoke('create_skill',{ name:name.trim(), description:desc.trim(), body:bodyv }); skAddOpen=false; await openSkills(); toast('Skill criada na biblioteca','ok'); }
  catch(e){ showErr(e, 'Falhou criar'); }
}
async function skDoImport(){
  const md=($id('skImpMd')||{}).value||'';
  if(!md.trim()){ toast('Cole o conteúdo do SKILL.md.','warn'); return; }
  try{ await invoke('import_skill_md',{ content:md }); skAddOpen=false; await openSkills(); toast('Skill importada na biblioteca — ligue ela no projeto pelo interruptor.','ok'); }
  catch(e){ showErr(e, 'Falhou importar'); }
}
bindClick('skillsBtn', openSkills);
bindClick('skClose', ()=>{ ovHide('skOverlay'); });
$id('skOverlay').addEventListener('click',e=>{ if(e.target.id==='skOverlay') ovHide('skOverlay'); });
// ===== Hub de Projetos =====
async function openProjetos(){
  const body=$id('projetosBody');
  $id('projetosOverlay').style.display='flex';
  await loadInto(body, 'cards', ()=>invoke('projects_overview'), (ov)=>projetosRender(ov||[]),
    { label:'buscando os projetos', ctx:'Não consegui ler os projetos', shape:{ wrap:'appscreen', head:true, n:4 } });
}
function projetosRender(ov){
  const body=$id('projetosBody'); if(!body) return;
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const n=(ov||[]).length;
  const head=`<div class="as-head"><div><h1 class="as-h1">Projetos</h1><p class="as-sub">Tudo aparece junto no quadro — aqui você gerencia cada repositório.</p></div><div class="as-actions"><span class="as-note">${n} projeto${n===1?'':'s'}</span><button class="as-btn" id="projAddBtn2">abrir existente…</button><button class="as-btn primary" id="projNewBtn">+ novo projeto</button></div></div>`;
  const cards=(ov||[]).map(p=>{
    const col=projColor(p.path);
    // MESMA contagem e vocabulário do quadro (flowCounts em 22-quadro-fluxo); sem o cache de tarefas, cai no resumo do backend
    const mine=p.path===state.repo ? (state.tasks||[]) : (typeof allTasksCache!=='undefined'?allTasksCache:[]).filter(t=>t.repo===p.path).map(t=>typeof normAgg==='function'?normAgg(t):t);
    const fc=(typeof flowCounts==='function' && mine.length) ? flowCounts(typeof flowLiveTasks==='function'?flowLiveTasks(mine):mine) : null;
    const nAnd=fc?fc.andamento:(p.active||0), nRev=fc?fc.prontas:(p.review||0), nAsk=fc?fc.aguardando:0;
    const bits=[];
    if(nAsk) bits.push(`<b style="color:var(--st-ask,var(--warn))">${nAsk} aguardando você</b>`);
    const nPr=fc?fc.praberto:0; // R5-1: mesmos rótulos da Central (FLOW_SECS): "pronta(s) pra revisar" e "PR aberto"
    if(nRev) bits.push(`<b style="color:var(--st-review,var(--warn))">${nRev} ${nRev===1?'pronta':'prontas'} pra revisar</b>`);
    if(nPr) bits.push(`<b style="color:var(--info)">${nPl(nPr,'PR aberto','PRs abertos')}</b>`);
    bits.push(nAnd?`<b style="color:var(--accent)">${nAnd} em andamento</b>`:'<span class="dim">nada em andamento</span>');
    return `<div class="projcard2 as-card">
      <div class="pc2name"><span class="pc2d" style="background:${col}"></span>${esc(p.name)}${p.path===state.repo?' <span class="as-badge" style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)">aberto</span>':''}</div>
      <div class="pc2meta">${bits.join(' · ')}</div>
      <div class="pc2path mono">${esc(p.path)}</div>
      ${p.path===state.repo&&typeof repoHasRemote==='function'&&!repoHasRemote()?`<div class="pc2pub"><span class="dim">${(typeof repoHasGit!=='function'||repoHasGit())?'só no seu computador — o time e os PRs precisam dele no GitHub':'pasta sem git — publicar cria o repositório e envia pro GitHub'}</span><button class="btn sm primary" data-pjpub="${escA(p.path)}">${(typeof IC!=='undefined'&&IC.push)||''}publicar no GitHub</button></div>`:''}
      <div class="pc2acts"><button class="btn sm" data-pjopen="${escA(p.path)}">ver tarefas</button><button class="btn sm" data-pjsk="${escA(p.path)}">skills</button><button class="btn sm" data-pjfx="${escA(p.path)}" title="abrir a pasta do projeto">${(typeof osKind!=='function'||osKind()==='mac')?'Finder':'abrir pasta'}</button><span style="flex:1"></span><button class="btn sm ghost danger" data-pjrm="${escA(p.path)}" title="tira da lista do Starfork — não apaga nenhum arquivo">remover</button></div>
    </div>`;
  }).join('');
  const list=n ? `<div class="as-sect">repositórios</div><div class="projgrid2">${cards}</div>`
    : projNewOpen ? '' : emptyHtml({ icon:'folder', title:'Nenhum projeto ainda', help:'Crie um projeto novo ou abra uma pasta que já existe nesta máquina.', action:{ id:'projEmptyNew', label:'+ novo projeto' } });
  body.innerHTML=`<div class="appscreen">${head}${projNewOpen?projNewHtml():''}${list}</div>`;
  { const b=body.querySelector('#projEmptyNew'); if(b) b.onclick=()=>{ const nb=body.querySelector('#projNewBtn'); if(nb) nb.click(); }; }
  { const b=body.querySelector('#projAddBtn2'); if(b) b.onclick=()=>{ if(window.pickFolder) window.pickFolder(); }; }
  { const b=body.querySelector('#projNewBtn'); if(b) b.onclick=()=>{ projNewOpen=!projNewOpen; projetosRender(ov); if(projNewOpen){ projNewWire(ov); const i=$id('pnName'); if(i) i.focus(); } }; }
  if(projNewOpen) projNewWire(ov);
  body.querySelectorAll('[data-pjopen]').forEach(b=>b.onclick=async()=>{ const p=b.dataset.pjopen; projFilter=p; lsSet('projFilter',p); if(p!==state.repo && window.switchProject) await window.switchProject(p); if(window.openTab) window.openTab('flow'); });
  body.querySelectorAll('[data-pjsk]').forEach(b=>b.onclick=async()=>{ const p=b.dataset.pjsk; if(p!==state.repo && window.switchProject) await window.switchProject(p); if(window.openTab) window.openTab('skills'); });
  // BUG-15: open_url só aceita http(s) — o Finder abre pela reveal_project (e o erro aparece, não some calado)
  body.querySelectorAll('[data-pjfx]').forEach(b=>b.onclick=()=>invoke('reveal_project',{path:b.dataset.pjfx}).catch(e=>showErr(e, 'Não deu pra abrir a pasta')));
  // BUG-20: remover o projeto ATIVO fecha ele (o Rust passa pro próximo da lista ou pro estado vazio) — recarrega tudo
  // E4 na aba Projetos: o projeto aberto sem GitHub ganha o "publicar" aqui mesmo (antes só aparecia na hora do PR)
  body.querySelectorAll('[data-pjpub]').forEach(b=>b.onclick=async()=>{
    if(b.dataset.pjpub!==state.repo){ openProjetos(); return; } // o projeto aberto mudou desde o desenho: publicar agora iria pro projeto errado
    if(typeof publishGithub!=='function') return;
    b.disabled=true; let ok=false;
    try{ ok=await publishGithub(); }catch(e){ showErr(e, 'Não consegui publicar no GitHub'); }
    if(ok) openProjetos(); else b.disabled=false; });
  body.querySelectorAll('[data-pjrm]').forEach(b=>b.onclick=async()=>{ const p=b.dataset.pjrm, wasActive=(p===state.repo); if(!await askYes('Remover '+projShort(p)+' da lista? (não apaga arquivos)')) return;
    try{ await invoke('remove_project',{path:p}); }catch(e){ showErr(e, 'Não consegui remover o projeto da lista'); return; } // antes o erro sumia calado e a lista recarregava como se tivesse removido
    if(wasActive){ selected=null; lastSig=''; if(typeof clearProjectCaches==='function') clearProjectCaches(); await refresh(); }
    if(window.loadProjects) await window.loadProjects(); openProjetos(); });
}
// ---- novo projeto do zero: pasta + git init + (opcional) repositório no GitHub ----
let projNewOpen=false, projNew={ name:'', parent:lsGet('projParent')||'', github:false, ghTouched:false, private:true, owner:'' }, ghOwnersCache=null, projNewBusy=false, projNewMsg='', projNewGhFail=''; // projNewGhFail: pasta criada cujo GitHub falhou (BUG-10)
function projNewHtml(){
  const owners=ghOwnersCache||[];
  const ownerSel=owners.length?`<select class="in" id="pnOwner" style="width:auto;min-width:160px">${owners.map(o=>`<option value="${escA(o)}"${(projNew.owner||owners[0])===o?' selected':''}>${esc(o)}</option>`).join('')}</select>`:`<span class="dim" style="font-size:12px">${ghOwnersCache===null?'lendo contas do gh…':'gh sem login — adicione uma conta em Configurações → GitHub'}</span>`;
  return `<div class="as-card" id="projNewCard" style="margin-bottom:18px">
    <div class="seclbl2" style="margin:0 0 12px">novo projeto <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· cria a pasta, já pronta pros agentes trabalharem — e, se quiser, guarda uma cópia no GitHub</span></div>
    <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:12px">
      <label style="display:block"><span class="dim" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase">nome</span><input class="in" id="pnName" placeholder="ex.: painel-financeiro" value="${escA(projNew.name)}" style="margin-top:5px"></label>
      <label style="display:block"><span class="dim" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase">pasta onde vai morar</span><div style="display:flex;gap:8px;margin-top:5px"><input class="in mono" id="pnParent" readonly placeholder="escolha uma pasta (ex.: ~/Documents/GitHub)" value="${escA(projNew.parent)}" style="flex:1;font-size:12px"><button class="btn sm" id="pnPick">escolher…</button></div></label>
    </div>
    <label class="pn-opt" style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px"><input type="checkbox" id="pnGh"${projNew.github?' checked':''}> guardar também no GitHub <span class="dim" style="font-size:12px">(cópia na nuvem — e o time consegue revisar e aprovar as mudanças)</span></label>
    ${(ghOwnersCache&&!ghOwnersCache.length)?`<div class="dim" id="pnGhHint" style="font-size:12px;margin:6px 0 0 24px">GitHub não conectado — o projeto fica só no seu computador (dá pra publicar depois, aqui mesmo em Projetos). <a id="pnGhEnv" style="cursor:pointer;text-decoration:underline">conectar o GitHub</a></div>`:''}
    <div id="pnGhOpts" style="display:${projNew.github?'flex':'none'};gap:14px;align-items:center;flex-wrap:wrap;margin:10px 0 0 24px">
      <span class="dim" style="font-size:12px">dono:</span>${ownerSel}
      <label class="pn-opt" style="font-size:12.5px;display:flex;gap:5px;align-items:center"><input type="radio" name="pnVis" value="private"${projNew.private?' checked':''}> privado <span class="dim">(só quem você convidar)</span></label>
      <label class="pn-opt" style="font-size:12.5px;display:flex;gap:5px;align-items:center"><input type="radio" name="pnVis" value="public"${projNew.private?'':' checked'}> público</label>
      <a class="dim" id="pnGhCfg" style="font-size:12px;cursor:pointer;text-decoration:underline">outra conta do GitHub?</a>
    </div>
    ${projNewMsg?`<div style="margin-top:12px;font-size:12.5px;color:var(--warn);white-space:pre-wrap">${esc(projNewMsg)}</div>`:''}
    ${projNewGhFail?`<div style="margin-top:10px"><button class="as-btn" id="pnOpenLocal">abrir mesmo assim, sem GitHub</button></div>`:''}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="as-btn" id="pnCancel">cancelar</button><button class="as-btn primary" id="pnCreate"${projNewBusy?' disabled':''}>${projNewBusy?'criando…':'criar projeto'}</button></div>
  </div>`;
}
function projNewWire(ov){
  // E11c: "criar no GitHub" só vem marcado quando o gh está logado (antes vinha marcado sempre e o create falhava)
  const ghSettle=(o)=>{ ghOwnersCache=o||[]; if(!projNew.ghTouched) projNew.github=ghOwnersCache.length>0; if(projNewOpen){ projetosRender(ov); projNewWire(ov); } };
  if(ghOwnersCache===null){ invoke('gh_owners').then(ghSettle).catch(()=>ghSettle([])); }
  bindClick('pnGhEnv', ()=>{ if(window.openTab) window.openTab('env'); });
  const nm=$id('pnName'); if(nm) nm.oninput=()=>{ projNew.name=nm.value; };
  bindClick('pnPick', async()=>{ try{ const d=await invoke('pick_folder'); if(d){ projNew.parent=d; lsSet('projParent',d); $id('pnParent').value=d; } }catch(_){} });
  const gh=$id('pnGh'); if(gh) gh.onchange=()=>{ projNew.github=gh.checked; projNew.ghTouched=true; $id('pnGhOpts').style.display=gh.checked?'flex':'none'; };
  const ow=$id('pnOwner'); if(ow) ow.onchange=()=>{ projNew.owner=ow.value; };
  document.querySelectorAll('input[name=pnVis]').forEach(r=>r.onchange=()=>{ projNew.private=r.value==='private'; });
  bindClick('pnGhCfg', ()=>{ if(window.openTab) window.openTab('cfg'); });
  bindClick('pnCancel', ()=>{ projNewOpen=false; projNewMsg=''; projNewGhFail=''; projetosRender(ov); });
  bindClick('pnOpenLocal', async()=>{ const path=projNewGhFail; if(!path) return;
    try{ await invoke('open_project',{ path }); projNewGhFail=''; projNewMsg=''; projNewOpen=false; projNew.name='';
      selected=null; lastSig=''; if(typeof clearProjectCaches==='function') clearProjectCaches();
      await refresh(); if(window.loadProjects) await window.loadProjects(); await openProjetos();
      toast('Projeto aberto só no seu computador. Dá pra ligar o GitHub depois.','ok');
    }catch(e){ projNewMsg=humanErr(e,'Não deu pra abrir').msg; projetosRender(ov); projNewWire(ov); } });
  bindClick('pnCreate', async()=>{
    projNew.name=($id('pnName')||{}).value||projNew.name;
    if(!projNew.name.trim()){ projNewMsg='dê um nome ao projeto.'; projetosRender(ov); projNewWire(ov); return; }
    if(!projNew.parent){ projNewMsg='escolha a pasta onde o projeto vai morar.'; projetosRender(ov); projNewWire(ov); return; }
    const owner=($id('pnOwner')||{}).value||projNew.owner||'';
    projNewBusy=true; projNewMsg=''; projNewGhFail=''; projetosRender(ov); projNewWire(ov);
    try{
      const path=await invoke('create_project',{ parent:projNew.parent, name:projNew.name.trim(), github:!!projNew.github, private:!!projNew.private, owner });
      projNewBusy=false; projNewOpen=false; projNew.name='';
      selected=null; lastSig=''; if(typeof clearProjectCaches==='function') clearProjectCaches();
      await refresh(); if(window.loadProjects) await window.loadProjects();
      await openProjetos();
      toast('Projeto criado em '+path,'ok');
    }catch(e){ projNewBusy=false; const m=String((e&&e.message)||e||'');
      const gf=m.match(/^GH_FAIL::(.+?)::([\s\S]*)$/); // pasta+git criados, só o GitHub falhou: oferece abrir local
      if(gf){ projNewGhFail=gf[1]; projNewMsg=gf[2]; } else projNewMsg='Falhou: '+m;
      projetosRender(ov); projNewWire(ov); }
  });
}
bindClick('projetosClose', ()=>{ ovHide('projetosOverlay'); });
$id('projetosOverlay').addEventListener('click',e=>{ if(e.target.id==='projetosOverlay') ovHide('projetosOverlay'); });
