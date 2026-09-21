// Constellation — 14-issues-projeto
// ===== Issues: "criar issue ao abrir demanda", por projeto e compartilhado com o time =====
// Espelha 13-skills-projetos: overlay + config. A config mora no .cardume/issue.json
// local (get_issue_config/set_issue_config) e, quando há nuvem, na tabela
// project_issue_config (o time inteiro lê/escreve — RLS cuida do acesso).
let issCfg={ enabled:false, instructions:'', titleTemplate:'', bodyTemplate:'' }, issProj=null, issBusy=false, issMsg='';
async function openIssues(){
  const mm=$id('moreMenu'); if(mm) mm.style.display='none';
  const body=$id('issuesBody');
  $id('issuesOverlay').style.display='flex';
  body.innerHTML=cosmosHtml('carregando…');
  issProj=null; issMsg='';
  // nuvem primeiro (o time compartilha); cai pro local se offline/sem tabela
  let cfg=null;
  try{
    issProj=await cloudEnsureProject();
    const rows=await sbGet('project_issue_config?select=enabled,instructions,title_template,body_template&project_id=eq.'+issProj.id);
    if(rows&&rows[0]) cfg={ enabled:!!rows[0].enabled, instructions:rows[0].instructions||'', titleTemplate:rows[0].title_template||'', bodyTemplate:rows[0].body_template||'' };
  }catch(_){ issProj=null; }
  if(!cfg){ try{ cfg=await invoke('get_issue_config'); }catch(_){ cfg=null; } }
  issCfg={ enabled:!!(cfg&&cfg.enabled), instructions:(cfg&&cfg.instructions)||'', titleTemplate:(cfg&&cfg.titleTemplate)||'', bodyTemplate:(cfg&&cfg.bodyTemplate)||'' };
  issRender();
}
function issRender(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const body=$id('issuesBody'); if(!body) return;
  const c=issCfg;
  body.innerHTML=`<div class="sk-screen">
    <div class="sk-head">
      <div><h1 class="sk-h1">Issues</h1><p class="sk-sub">Ligado, o agente abre uma issue no tracker deste projeto quando a demanda começa — ou usa o link que você colar. ${issProj?'Vale pro time inteiro.':'<span style="color:var(--warn)">Sem nuvem — vale só nesta máquina.</span>'}</p></div>
    </div>
    <label class="sw" style="display:flex;align-items:center;gap:10px;margin:6px 0 16px;font-size:13.5px"><input type="checkbox" id="issEnabled"${c.enabled?' checked':''}><span class="tr"><span class="kn"></span></span>Criar issue ao abrir demanda</label>
    <label>Instruções <span class="dim" style="font-weight:400">— como criar a issue no tracker deste projeto</span></label>
    <textarea class="in mono" id="issInstr" rows="6" style="font-size:11.5px" placeholder="ex.: gh issue create -R org/repo -t &quot;...&quot; -b &quot;...&quot;, curl pro Jira, chamar um MCP…">${esc(c.instructions||'')}</textarea>
    <div style="display:flex;gap:8px;margin-top:12px">
      <label style="flex:1">Template do título <span class="dim" style="font-weight:400">(opcional)</span><input class="in" id="issTitleTpl" value="${escA(c.titleTemplate||'')}" placeholder="ex.: [demanda] {title}" style="margin-top:5px"></label>
      <label style="flex:1">Template do corpo <span class="dim" style="font-weight:400">(opcional)</span><input class="in" id="issBodyTpl" value="${escA(c.bodyTemplate||'')}" placeholder="ex.: {objective}" style="margin-top:5px"></label>
    </div>
    ${issMsg?`<div class="imhint" style="border-left:2px solid ${issMsg.startsWith('✓')?'var(--good)':'var(--warn)'};margin-top:14px">${esc(issMsg)}</div>`:''}
    <div style="display:flex;gap:8px;margin-top:16px"><span style="flex:1"></span><button class="btn primary" id="issSave"${issBusy?' disabled':''}>${issBusy?'salvando…':'salvar'}</button></div>
  </div>`;
  { const b=body.querySelector('#issSave'); if(b) b.onclick=issSave; }
}
async function issSave(){
  const cfg={
    enabled: !!($id('issEnabled')||{}).checked,
    instructions: (($id('issInstr')||{}).value||'').trim(),
    titleTemplate: (($id('issTitleTpl')||{}).value||'').trim(),
    bodyTemplate: (($id('issBodyTpl')||{}).value||'').trim(),
  };
  issCfg=cfg; issBusy=true; issMsg=''; issRender();
  // espelha SEMPRE no local — nunca depende da nuvem pra salvar
  try{ await invoke('set_issue_config', { config: cfg }); }
  catch(e){ issBusy=false; issMsg='Falhou salvar local: '+(e&&e.message||e); issRender(); return; }
  // sobe pro time quando houver nuvem (tabela ausente/offline nunca bloqueia)
  try{
    if(!issProj && SB.sess() && cloudTeamId()) issProj=await cloudEnsureProject();
    if(issProj){
      await sbFetch('/rest/v1/project_issue_config?on_conflict=project_id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
        body: JSON.stringify({ project_id:issProj.id, enabled:cfg.enabled, instructions:cfg.instructions, title_template:cfg.titleTemplate, body_template:cfg.bodyTemplate, updated_by:cloudUserId(), updated_at:new Date().toISOString() }) });
    }
  }catch(_){ }
  issBusy=false; issMsg='✓ salvo'+(issProj?' pro time':' (só nesta máquina)'); issRender();
}
bindClick('issuesClose', ()=>{ $id('issuesOverlay').style.display='none'; });
$id('issuesOverlay').addEventListener('click',e=>{ if(e.target.id==='issuesOverlay') $id('issuesOverlay').style.display='none'; });
