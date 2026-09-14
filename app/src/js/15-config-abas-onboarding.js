// Constellation — 15-config-abas-onboarding
// ---------- configurações (⌘,) ----------
function openCfg(){
  const body=$id('cfgBody');
  body.innerHTML=`
    <label>Limite de custo por tarefa <span class="dim" style="text-transform:none;letter-spacing:0">(notifica ao cruzar — 0 desliga)</span></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="dim">$</span><input class="in" id="cfgCost" type="number" min="0" step="5" value="${escA(lsGet('costWarn')||'25')}" style="width:110px"></div>
    <label style="margin-top:16px">URL base das issues <span class="dim" style="text-transform:none;letter-spacing:0">(o código FND-853 vira link: base/FND-853)</span></label>
    <input class="in" id="cfgIssueBase" placeholder="ex.: https://linear.app/logcomex/issue" value="${escA(lsGet('issueBase')||'')}" style="margin-top:6px">
    <label style="margin-top:16px">Tarefas em paralelo (slots)</label>
    <input class="in" id="cfgSlots" type="number" min="1" max="12" value="${escA(String(slotMax))}" style="width:110px;margin-top:6px">
    <label style="margin-top:16px">Retomar após limite de uso da IA <span class="dim" style="text-transform:none;letter-spacing:0">(quando bate o limite da conta, a tarefa espera e retoma sozinha a cada X min — 0 desliga)</span></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><input class="in" id="cfgLimitRetry" type="number" min="0" max="240" step="5" value="60" style="width:110px"><span class="dim">min</span></div>
    <div class="seclbl2" style="margin-top:20px">IA padrão <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· motor e versão de modelo pra toda demanda nova</span></div>
    <div class="aipick aipick-cfg" id="aiPickCfg" style="margin-top:8px"></div>
    <div id="raHost"></div>
    <div class="seclbl2" style="margin-top:20px">GitHub <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· a conta ativa abre os PRs e faz o push — troque ao mudar de empresa/conta</span></div>
    <div id="ghHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Sistema</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn sm" id="cfgEnv">${ic('pulse')}verificar ambiente</button>
      <button class="btn sm" id="cfgBackend">backend do time…</button>
      <button class="btn sm" id="cfgTour">rever o tour</button>
    </div>
    <div style="display:flex;margin-top:20px"><span style="flex:1"></span><button class="btn primary" id="cfgSave">salvar</button></div>`;
  // carrega o intervalo de retomada salvo (settings.json via Rust)
  invoke('read_settings').then(s=>{ try{ const o=JSON.parse(s||'{}'); const el=$id('cfgLimitRetry'); if(el && o.limitRetryMin!=null && o.limitRetryMin!=='') el.value=String(o.limitRetryMin); }catch(_){} }).catch(()=>{});
  $id('cfgSave').onclick=()=>{ lsSet('costWarn', String(Math.max(0, parseFloat($id('cfgCost').value)||0))); lsSet('issueBase', $id('cfgIssueBase').value.trim()); setSlotMax(parseInt($id('cfgSlots').value,10)||4);
    { const lrm=Math.max(0, Math.min(240, parseInt($id('cfgLimitRetry').value,10)||0)); invoke('write_setting',{ key:'limitRetryMin', value:String(lrm) }).catch(()=>{}); }
    lastSig=''; $id('cfgOverlay').style.display='none'; };
  $id('cfgEnv').onclick=()=>{ $id('cfgOverlay').style.display='none'; openEnv(); };
  $id('cfgBackend').onclick=()=>{ $id('cfgOverlay').style.display='none'; cloudCfgOpen=true; openCloud(); };
  $id('cfgTour').onclick=()=>{ $id('cfgOverlay').style.display='none'; openOnboarding(); };
  // Route AI vive no bloco 1 (onde secretsCache/secretSet moram); monta via window
  if(window.routeAiMount) window.routeAiMount();
  if(typeof ghMount==='function') ghMount();
  if(typeof aiPickRender==='function' && typeof AI_TARGET_CFG!=='undefined') aiPickRender(AI_TARGET_CFG);
  $id('cfgOverlay').style.display='flex';
}
$id('cfgBtn').onclick=openCfg;

/* ===== MOTOR DE ABAS (Chrome-style): as views que eram janela viram aba ===== */
const VIEW_META={
  projetos:{title:'Projetos',icon:'<path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>'},
  orq:{title:'Orquestrador',icon:'<circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M6 7.2l4.2-2.4M6 8.8l4.2 2.4"/>'},
  nova:{title:'Nova demanda',icon:'<path d="M7 2.6l1 2.6 2.6 1-2.6 1L7 9.8 6 7.2 3.4 6.2 6 5.2z" stroke-linejoin="round"/>'},
  planner:{title:'Montar conversando',icon:'<path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.85-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" stroke-linejoin="round"/>'},
  form:{title:'Formulário',icon:'<path d="M4 2.5h6L12.5 5v8.5H4z" stroke-linejoin="round"/><path d="M5.8 6.5h4.4M5.8 8.5h4.4M5.8 10.5h2.6"/>'},
  prefs:{title:'Preferências',icon:'<path d="M4 2.5h6L12.5 5v8.5H4z" stroke-linejoin="round"/><path d="M5.8 6.5h4.4M5.8 8.5h4.4M5.8 10.5h2.6"/>'},
  task:{title:'Tarefa',icon:'<circle cx="8" cy="8" r="5.2"/><path d="M8 5.4v3l1.9 1"/>'},
  skills:{title:'Skills',icon:'<rect x="2.4" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="9.1" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="2.4" y="9.1" width="4.5" height="4.5" rx="1"/><path d="M11.35 9.3v4.1M9.3 11.35h4.1"/>'},
  cfg:{title:'Configurações',icon:'<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8"/>'},
  daily:{title:'Daily',icon:'<rect x="2.5" y="3.5" width="11" height="10" rx="1.2"/><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5"/>'},
  chat:{title:'Chat do projeto',icon:'<path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.85-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" stroke-linejoin="round"/>'},
  conta:{title:'Conta',icon:'<path d="M4.6 11.8a2.6 2.6 0 0 1 .3-5.18 3.4 3.4 0 0 1 6.6.7 2.3 2.3 0 0 1-.4 4.55z" stroke-linejoin="round"/>'},
  agents:{title:'Agentes',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/>'},
  env:{title:'Ambiente',icon:'<path d="M8 13.5c-2.5-1.6-5-3.9-5-6.7A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5 2.2c0 2.8-2.5 5.1-5 6.7z" stroke-linejoin="round"/>'},
};
const VIEW_OVERLAY={ orq:'orqOverlay', projetos:'projetosOverlay', nova:'ndOverlay', planner:'plannerOverlay', form:'ntOverlay', skills:'skOverlay', prefs:'prefsOverlay', cfg:'cfgOverlay', daily:'dailyOverlay', chat:'pcOverlay', conta:'cloudOverlay', agents:'agOverlay', env:'envOverlay', task:'fwOverlay' };
let tabTaskId=null, tabTaskPath=null; // tarefa aberta na aba "task"
// abridores que POPULAM+mostram cada view (os bloco-1 vêm via window)
function viewOpen(kind){
  const f={ orq:()=>window.openOrq&&window.openOrq(), projetos:()=>openProjetos(), nova:()=>openNovaStart(), planner:()=>openPlanner(), form:()=>openNewTask(), skills:()=>openSkills(), prefs:()=>openPrefs(), cfg:()=>openCfg(), daily:()=>openDaily(), chat:()=>openPc(), env:()=>openEnv(),
            conta:()=>window.openCloud&&window.openCloud(), agents:()=>window.openAgents&&window.openAgents(),
            task:()=>{ if(tabTaskId!=null) fwOpenInner(tabTaskId, tabTaskPath); } }[kind];
  if(f) f();
}
// cada aba tem um id único: 'flow', o próprio kind (views únicas) ou 'task:<id>' (uma por tarefa)
let TABS=[{id:'flow',kind:'flow',title:'Tarefas',pin:true}];
let activeTab='flow';
function tabById(id){ return TABS.find(t=>t.id===id); }
function tabIcon(kind){ if(kind==='flow') return '<rect x="2.5" y="3" width="11" height="10" rx="1.4"/><path d="M2.5 6h11"/>'; return (VIEW_META[kind]||{}).icon||''; }
function activateTab(id){ activeTab=id; renderTabs(); showActiveView(); }
function openTab(kind){ // views de instância única (nova, skills, cfg, planner, form, …)
  if(kind==='flow'){ activateTab('flow'); return; }
  if(!tabById(kind)) TABS.push({id:kind, kind, title:(VIEW_META[kind]||{}).title||kind});
  activateTab(kind);
}
window.openTab=openTab;
function closeTab(id){
  const i=TABS.findIndex(t=>t.id===id); if(i<0||TABS[i].pin) return;
  TABS.splice(i,1);
  // esconde o overlay do kind se nenhuma OUTRA aba do mesmo kind sobrou
  const kind=(id.split(':')[0]==='task')?'task':id;
  if(!TABS.some(t=>t.kind===kind)){ const o=$id(VIEW_OVERLAY[kind]); if(o){ o.classList.remove('astab'); o.style.display='none'; } }
  if(activeTab===id) activeTab=(TABS[i-1]||TABS[0]).id;
  renderTabs(); showActiveView();
}
function showActiveView(){
  const t=tabById(activeTab)||TABS[0];
  Object.keys(VIEW_OVERLAY).forEach(k=>{ const o=$id(VIEW_OVERLAY[k]); if(o && o.dataset.lock!=='1'){ o.classList.remove('astab'); if(o.style.display!=='none') o.style.display='none'; } });
  if(t.kind==='flow') return; // o quadro (.body) já aparece
  if(t.kind==='task') tabTaskId=t.taskId; // qual tarefa esta aba mostra
  viewOpen(t.kind); // popula + mostra (pode setar display='flex')
  const o=$id(VIEW_OVERLAY[t.kind]);
  if(o){ requestAnimationFrame(()=>{
    // mede a base da barra de abas AGORA (layout já assentado) e fixa o topo do overlay —
    // sem isso, uma mudança de altura do topo deixava --chrome-h defasado e o overlay
    // cobria as abas (recolhido) ou deixava o board vazar por cima (expandido).
    syncChromeH();
    o.classList.add('astab'); o.style.display='block';
  }); }
}
function renderTabs(){
  const bar=$id('tabBar'); if(!bar) return;
  bar.style.display='flex';
  bar.innerHTML=TABS.map(t=>{
    const on=t.id===activeTab;
    return `<span class="tab ${on?'on':''} ${t.pin?'pin':''}" data-tk="${escA(t.id)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">${tabIcon(t.kind)}</svg><span class="tt">${esc(t.title)}</span>${t.pin?'':`<span class="x" data-xk="${escA(t.id)}">✕</span>`}</span>`;
  }).join('')+`<span class="tabadd" id="tabAdd" title="nova demanda">+</span>`;
  bar.querySelectorAll('[data-tk]').forEach(el=>el.onclick=e=>{ if(e.target.dataset.xk) return; activateTab(el.dataset.tk); });
  bar.querySelectorAll('[data-xk]').forEach(el=>el.onclick=e=>{ e.stopPropagation(); closeTab(el.dataset.xk); });
  const add=$id('tabAdd'); if(add) add.onclick=()=>openTab('nova');
  requestAnimationFrame(syncChromeH);
}
$id('bdClose').onclick=()=>{ $id('bdOverlay').style.display='none'; };
$id('bdCancel').onclick=()=>{ $id('bdOverlay').style.display='none'; };
$id('bdCreate').onclick=()=>bdCreate();
$id('bdOverlay').addEventListener('click',e=>{ if(e.target.id==='bdOverlay') $id('bdOverlay').style.display='none'; });
$id('cfgClose').onclick=()=>{ $id('cfgOverlay').style.display='none'; };
$id('cfgOverlay').addEventListener('click',e=>{ if(e.target.id==='cfgOverlay') $id('cfgOverlay').style.display='none'; });

// ---------- onboarding de 60 segundos (primeiro boot) ----------
const OB_STEPS=[
  { t:'Bem-vindo ao Constellation', b:'Aqui, cada <b>tarefa</b> vira uma <b>branch isolada</b> do seu repo, tocada por agentes de IA — com plano, código, testes e <b>provas reais</b> (prints e saídas de verdade, nunca mock). Você acompanha tudo ao vivo e conversa com o agente como num chat.' },
  { t:'Seu time vê o essencial', b:'Entrando no time (botão no topo), suas tarefas viram <b>cartões compartilhados automaticamente</b>: título, status, custo e branch sincronizam — o <b>stream do agente fica só na sua máquina</b> e os artefatos/provas só sobem quando você publicar. O backlog do time fica na aba <b>Time</b>.' },
  { t:'Antes de começar', b:'O app depende de 4 coisas: <b>node</b>, <b>git</b>, <b>claude</b> (logado) e <b>gh</b> (autenticado). Vamos verificar agora — o que faltar vem com o comando de correção pronto pra copiar.' },
];
let obStep=0;
function openOnboarding(){ obStep=0; renderOb(); $id('obOverlay').style.display='flex'; }
function renderOb(){
  const s=OB_STEPS[obStep];
  const last=obStep===OB_STEPS.length-1;
  $id('obBody').innerHTML=`
    <div style="display:flex;gap:6px;margin-bottom:18px">${OB_STEPS.map((_,i)=>`<span style="height:4px;flex:1;border-radius:99px;background:${i<=obStep?'var(--accent)':'var(--border)'}"></span>`).join('')}</div>
    <h2 style="font-size:20px;margin:0 0 10px">${s.t}</h2>
    <p style="color:var(--text-2);font-size:14px;line-height:1.65;margin:0">${s.b}</p>
    ${last?'<div id="obEnv" style="margin-top:14px"><div class="dim" style="font-size:12px">verificando o ambiente…</div></div>':''}
    <div style="display:flex;gap:8px;margin-top:24px;align-items:center">
      <button class="btn sm" id="obSkip">pular</button><span style="flex:1"></span>
      <button class="btn primary" id="obNext">${last?'Entrar no Constellation':'continuar'}</button>
    </div>`;
  $id('obSkip').onclick=()=>{ finishOb(); };
  $id('obNext').onclick=()=>{ if(!last){ obStep++; renderOb(); } else { finishOb(); coachStart(); } };
  // check de ambiente INTEGRADO no onboarding (redesign p16): fix inline, sem bloquear a entrada
  if(last) runEnvCheck().then(()=>{
    const el=$id('obEnv'); if(!el) return;
    el.innerHTML=(envChecks||[]).map(c=>`<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
      <span style="color:${c.ok?'var(--good)':'var(--warn)'}">${c.ok?'✓':'⚠'}</span><div style="flex:1"><b>${esc(c.name)}</b> <span class="dim">${esc((c.detail||'').slice(0,80))}</span>${!c.ok&&c.fix?`<div class="mono" style="font-size:10.5px;margin-top:3px;color:var(--warn)">FIX: ${esc(c.fix)}</div>`:''}</div></div>`).join('')
      +((envChecks||[]).some(c=>!c.ok)?'<div class="dim" style="font-size:11.5px;margin-top:8px">Dá pra entrar mesmo assim — o que faltar fica com o aviso no coração 🩺 do topo.</div>':'');
  }).catch(()=>{});
}
function finishOb(){ lsSet('onboarded','1'); $id('obOverlay').style.display='none'; }
if(!lsGet('onboarded')) setTimeout(openOnboarding, 900);

// ---------- coach marks de primeira vez (redesign p17) ----------
const COACH=[
  ['newTaskBtn','Tudo começa aqui','Descreva o que precisa em 1–2 frases — o assistente monta a spec e o time de agentes executa.'],
  ['ffSearch','Busca em tudo','Ache qualquer demanda pelo título — ou use ⌘K de qualquer lugar.'],
  ['rail','Execução ao vivo','Os agentes rodando agora ficam aqui. Amarelo = um deles precisa de você.'],
];
function coachStart(){
  if(lsGet('coached')) return;
  let i=0;
  const tipEl=document.createElement('div'); tipEl.id='coachTip';
  tipEl.style.cssText='position:fixed;z-index:9999;max-width:260px;background:var(--surface);border:1px solid var(--accent);border-radius:10px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  document.body.appendChild(tipEl);
  const show=()=>{
    if(i>=COACH.length){ done(); return; }
    const [id,t,b]=COACH[i];
    const a=$id(id);
    if(!a){ i++; show(); return; }
    const r=a.getBoundingClientRect();
    tipEl.innerHTML=`<b style="font-size:13px">${esc(t)}</b><div class="dim" style="font-size:12px;line-height:1.5;margin-top:4px">${esc(b)}</div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="btn sm" id="coachSkip">pular tudo</button><span style="flex:1"></span><span class="dim" style="font-size:10.5px">${i+1}/${COACH.length}</span><button class="btn primary sm" id="coachNext">${i<COACH.length-1?'próximo':'entendi'}</button></div>`;
    const top=Math.min(window.innerHeight-160, r.bottom+10);
    const left=Math.max(10, Math.min(window.innerWidth-280, r.left));
    tipEl.style.top=top+'px'; tipEl.style.left=left+'px';
    a.style.outline='2px solid var(--accent)'; a.style.outlineOffset='3px';
    const clear=()=>{ a.style.outline=''; a.style.outlineOffset=''; };
    $id('coachNext').onclick=()=>{ clear(); i++; show(); };
    $id('coachSkip').onclick=()=>{ clear(); done(); };
  };
  const done=()=>{ lsSet('coached','1'); tipEl.remove(); };
  show();
}

// ---------- atalhos ----------
document.addEventListener('keydown', e=>{
  if(!(e.metaKey||e.ctrlKey)) return;
  const inField=/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'');
  if(e.key==='j'){ e.preventDefault(); openPc(); }
  else if(e.key===','){ e.preventDefault(); openCfg(); }
  else if(e.key==='b'){ e.preventDefault(); setRailCollapsed(!railIsCol()); }
});

function eventsOf(taskId){ return state.events.filter(e=>e.taskId===taskId); }
function claimsOf(taskId){ return state.claims.filter(c=>c.taskId===taskId); }
function diffOf(taskId){ return state.diffs.find(d=>d.taskId===taskId); }
function reviewOf(taskId){ return (state.reviews||[]).find(r=>r.taskId===taskId); }
function refsBlock(t){
  const rs=Array.isArray(t.refs)?t.refs:[];
  if(!rs.length) return '';
  return `<div class="seclbl">Referências <span class="n">${rs.length}</span></div><div class="artlist">`+
    rs.map(n=>`<button class="artitem" data-refopen="${escA(n)}"><span class="artic">${(/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(n)?IC.image:IC.doc)}</span><span class="artnm mono">${esc(n)}</span><span class="artkb dim">abrir</span></button>`).join('')+`</div>`;
}
async function openRef(taskId, name){
  let c;
  try{ c=await invoke('read_ref',{ taskId, name }); }
  catch(e){ alert('Falha ao abrir a referência:\n'+e); return; }
  const body = c.kind==='image' ? `<img class="artimg" src="${c.dataUrl}" alt="${escA(name)}">`
    : c.kind==='pdf' ? `<iframe class="pdfview" src="${c.dataUrl}" title="${escA(name)}"></iframe>`
    : c.kind==='doc' ? `<div class="mdview">${mdToHtml(c.text||'')}</div>`
    : `<pre class="artpre">${esc(c.text||'')}</pre>`;
  $id('artIcon').innerHTML = c.kind==='image'?IC.image:IC.doc;
  $id('artTitle').textContent=name;
  $id('artBody').innerHTML=body;
  $id('artOverlay').style.display='flex';
}
function costsOf(taskId){ return (state.costs||[]).filter(c=>c.taskId===taskId); }
function taskCost(taskId){ const cs=costsOf(taskId); return { usd: cs.reduce((s,c)=>s+(c.usd||0),0), tok: cs.reduce((s,c)=>s+(c.inTok||0)+(c.outTok||0),0) }; }
function fmtUsd(u){ return u>0&&u<0.01 ? '$'+u.toFixed(4) : '$'+(u||0).toFixed(2); }
function fmtTok(n){ n=n||0; return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(n); }

const fileCache={}; // taskId -> {status, at, list}
async function loadTaskFiles(taskId, status){
  const c=fileCache[taskId];
  // tarefas ativas: revalida a cada ~2.5s (o diff da worktree muda ao vivo)
  const fresh = c && c.status===status && (!ACTIVE_ST.has(status) || (Date.now()-c.at < 2500));
  if(fresh) return c.list;
  try{ fileCache[taskId]={status, at:Date.now(), list: await invoke("task_files",{ taskId })}; }
  catch(e){ fileCache[taskId]={status, at:Date.now(), list:[]}; }
  return fileCache[taskId].list;
}
function activityBlock(t){
  if(!ACTIVE_ST.has(t.status)) return '';
  const evs=eventsOf(t.id); if(!evs.length) return '';
  const t0=evs[0].ts||t.created_at;
  const ms=Math.max(0, Date.now()-t0); const mins=Math.floor(ms/60000);
  const elapsed = mins<1 ? Math.floor(ms/1000)+'s' : mins+' min';
  const cnt=(ty)=>evs.filter(e=>e.type===ty).length;
  const edits=cnt('edit')+cnt('write'), reads=cnt('read'), cmds=cnt('bash');
  const fc=fileCache[t.id], files=fc?fc.list:[];
  const add=files.reduce((s,f)=>s+(f.add||0),0), del=files.reduce((s,f)=>s+(f.del||0),0);
  const diffLine = files.length ? `<span class="pchip live"><span style="color:var(--good)">+${add}</span> <span style="color:var(--crit)">−${del}</span> · ${files.length} arq</span>` : '';
  // O QUÊ ele está fazendo: a própria narração do agente (último "pensamento")
  // + as últimas ações concretas — não só quem/contadores.
  const lastThink=[...evs].reverse().find(e=>e.type==='think'&&(e.text||'').trim());
  const narr=lastThink?`<div class="nowsay"><span class="nsav" style="background:${agentColor(lastThink.agent)}">${esc((lastThink.agent||'?').slice(0,2).toUpperCase())}</span><div class="nowsaytx clamp4">${esc(lastThink.text)}</div></div>`:'';
  const feed=evs.filter(e=>['bash','edit','write','read'].includes(e.type)).slice(-4)
    .map(e=>`<div class="nowact"><span style="color:${GCOLOR[e.type]||'var(--muted)'}">${GLYPH[e.type]||'·'}</span><span class="mono">${esc(e.text||'')}</span></div>`).join('');
  return `<div class="progbox">
    <div class="progh"><span class="pulse" style="--pc:var(--good)"></span>Trabalhando há <b>${elapsed}</b></div>
    ${narr}
    ${feed?`<div class="nowfeed">${feed}</div>`:''}
    <div class="progchips"><span class="pchip">${edits} edições</span><span class="pchip">${reads} leituras</span><span class="pchip">${cmds} comandos</span>${diffLine}</div>
  </div>`;
}
function filesListHtml(files){
  if(!files.length) return '<div class="seclbl">Arquivos alterados</div><div class="dim" style="font-size:11.5px">nenhum arquivo alterado ainda</div>';
  return `<div class="seclbl">Arquivos alterados <span class="n">${files.length}</span></div>`+
    `<div class="fileshint">Clique num arquivo pra <b>abrir, editar</b> e <b>falar com o agente linha a linha</b>.</div><div class="artlist">`+
    files.map(f=>`<button class="artitem fileitem" data-file="${escA(f.path)}"><span class="artic">${IC.doc}</span><span class="artnm mono">${esc(f.path)}</span><span class="artkb"><span style="color:var(--good)">+${f.add}</span> <span style="color:var(--crit)">−${f.del}</span></span><span class="fileopen">abrir ›</span></button>`).join('')+`</div>`;
}
