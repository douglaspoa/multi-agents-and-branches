// Starfork — 15-config-abas-onboarding
// ---------- configurações (⌘,) ----------
// fecha Configurações: como ABA fecha a aba (esconder o overlay deixava a aba ativa EM BRANCO); como modal, esconde
function cfgHide(){ const o=$id('cfgOverlay'); if(o&&o.classList.contains('astab')) closeTabOfKind('cfg'); else if(o) o.style.display='none'; }
function openCfg(){
  const body=$id('cfgBody');
  body.innerHTML=`
    <label>Teto por tarefa <span class="dim" style="text-transform:none;letter-spacing:0">(ao chegar nele a tarefa PAUSA e pergunta se continua — 0 = sem teto; dá pra mudar por tarefa ao criar)</span></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="dim">US$</span><input class="in" id="cfgCap" type="number" min="0" step="1" value="${escA(String(costCapDefault()))}" style="width:110px"><span class="dim" id="cfgCapBrl"></span></div>
    <label style="margin-top:16px">Cotação do dólar usada nas estimativas <span class="dim" style="text-transform:none;letter-spacing:0">(só pra mostrar o ≈ R$ ao lado do custo em US$)</span></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="dim">R$</span><input class="in" id="cfgBrl" type="number" min="0.5" step="0.05" value="${escA(String(usdBrlRate()))}" style="width:110px"><span class="dim">por US$ 1</span></div>
    <label style="margin-top:16px">Aviso de custo <span class="dim" style="text-transform:none;letter-spacing:0">(só notifica ao cruzar, não pausa — 0 desliga)</span></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="dim">US$</span><input class="in" id="cfgCost" type="number" min="0" step="5" value="${escA(lsGet('costWarn')||'25')}" style="width:110px"></div>
    <label style="margin-top:16px">URL base das issues <span class="dim" style="text-transform:none;letter-spacing:0">(o código FND-853 vira link: base/FND-853)</span></label>
    <input class="in" id="cfgIssueBase" placeholder="ex.: https://linear.app/sua-empresa/issue" value="${escA(lsGet('issueBase')||'')}" style="margin-top:6px">
    <label style="margin-top:16px">Tarefas em paralelo (slots)</label>
    <input class="in" id="cfgSlots" type="number" min="1" max="12" value="${escA(String(slotMax))}" style="width:110px;margin-top:6px">
    <label style="margin-top:16px">Retomar após limite de uso da IA <span class="dim" style="text-transform:none;letter-spacing:0">(quando bate o limite da conta, a tarefa espera e retoma sozinha a cada X min — 0 desliga)</span></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><input class="in" id="cfgLimitRetry" type="number" min="0" max="240" step="5" value="60" style="width:110px"><span class="dim">min</span></div>
    <div class="seclbl2" style="margin-top:20px">IA padrão <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· motor e versão de modelo pra toda demanda nova</span></div>
    <div class="aipick aipick-cfg" id="aiPickCfg" style="margin-top:8px"></div>
    <div id="raHost"></div>
    <div class="seclbl2" style="margin-top:20px">GitHub <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· a conta ativa abre os PRs e faz o push — troque ao mudar de empresa/conta</span></div>
    <div id="ghHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Navegador dos agentes</div>
    <label class="cfgck" style="display:flex;gap:9px;align-items:flex-start;margin-top:8px;text-transform:none;letter-spacing:0;font-weight:400;cursor:pointer"><input type="checkbox" id="cfgBrowserVisible" style="margin-top:3px"><span>Mostrar a janela do navegador <span class="dim">— por padrão ele roda em segundo plano (tarefas em paralelo não disputam a tela). Ligue quando precisar fazer login ou assumir a navegação; vale pras próximas execuções.</span></span></label>
    <div class="seclbl2" style="margin-top:20px">Versão <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· o app checa o canal do time no boot e a cada 6h — ou agora, aqui</span></div>
    <div id="updHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Espaço em disco <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· pasta de trabalho do Starfork deste projeto <span class="mono" style="font-size:10.5px">(.cardume/)</span> — aprendizados ficam, o resto pode ir</span></div>
    <div id="wsHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Sistema</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn sm" id="cfgEnv">${ic('pulse')}verificar ambiente</button>
      ${(canSeeDevTools()||lsGet('sb:url'))?'<button class="btn sm" id="cfgBackend" title="avançado: aponta o app pra outro servidor (dev/admin)">servidor da conta…</button>':''}
      <button class="btn sm" id="cfgTour">rever o tour</button>
    </div>
    <div class="cfgsavebar"><span class="dim" id="cfgDirty"></span><span style="flex:1"></span><button class="btn primary" id="cfgSave">salvar</button></div>`;
  // carrega o intervalo de retomada salvo (settings.json via Rust)
  invoke('read_settings').then(s=>{ try{ const o=JSON.parse(s||'{}'); const el=$id('cfgLimitRetry'); if(el && o.limitRetryMin!=null && o.limitRetryMin!=='') el.value=String(o.limitRetryMin); const bv=$id('cfgBrowserVisible'); if(bv) bv.checked=(o.browserVisible===true||o.browserVisible==='1'||o.browserVisible==='true'); }catch(_){} }).catch(()=>{});
  { const cap=$id('cfgCap'), brl=$id('cfgBrl'), out=$id('cfgCapBrl');
    const upd=()=>{ const v=Math.max(0, parseFloat(cap.value)||0), r=parseFloat(brl.value)||usdBrlRate(); out.textContent=v>0?'≈ R$ '+fmtNumBR(v*r,true):'sem teto'; };
    cap.oninput=upd; brl.oninput=upd; upd(); }
  { const mark=()=>{ const d=$id('cfgDirty'); if(d) d.textContent='alterações não salvas'; }; body.oninput=mark; body.onchange=mark; } // o usuário vê que falta salvar
  $id('cfgSave').onclick=()=>{ lsSet('costWarn', String(Math.max(0, parseFloat($id('cfgCost').value)||0)));
    lsSet('costCap', String(Math.max(0, parseFloat($id('cfgCap').value)||0)));
    { const r=parseFloat($id('cfgBrl').value); if(r>0) lsSet('usdBrl', String(r)); } lsSet('issueBase', $id('cfgIssueBase').value.trim()); setSlotMax(parseInt($id('cfgSlots').value,10)||4);
    { const lrm=Math.max(0, Math.min(240, parseInt($id('cfgLimitRetry').value,10)||0)); invoke('write_setting',{ key:'limitRetryMin', value:String(lrm) }).catch(()=>{}); }
    { const bv=$id('cfgBrowserVisible'); if(bv) invoke('write_setting',{ key:'browserVisible', value:bv.checked?'1':'0' }).catch(()=>{}); }
    lastSig=''; cfgHide(); toast('Configurações salvas','ok'); };
  $id('cfgEnv').onclick=()=>{ cfgHide(); if(window.openTab) openTab('env'); else openEnv(); };
  bindClick('cfgBackend', ()=>{ cfgHide(); cloudCfgOpen=true; if(window.openTab) openTab('conta'); else openCloud(); });
  $id('cfgTour').onclick=()=>{ cfgHide(); openOnboarding(); };
  // Route AI vive no bloco 1 (onde secretsCache/secretSet moram); monta via window
  if(window.routeAiMount) window.routeAiMount();
  if(typeof ghMount==='function') ghMount();
  if(typeof updRenderCfg==='function') updRenderCfg();
  wsMount();
  if(typeof aiPickRender==='function' && typeof AI_TARGET_CFG!=='undefined') aiPickRender(AI_TARGET_CFG);
  aiPlainWatch($id('aiPickCfg'));
  $id('cfgOverlay').style.display='flex';
}
$id('cfgBtn').onclick=openCfg;

// ---------- "Com qual IA?" sem jargão (o seletor é desenhado em 29-ia-picker; aqui só a camada de texto) ----------
// alias / id fixo → "sempre o mais novo" / "versão travada" (o termo técnico fica no tooltip);
// "Mock · sem IA" → "Simulação · sem IA, pra testar" e só aparece em instalação de desenvolvimento (ou se já estiver escolhido).
const AI_PLAIN_TXT=[
  ['Alias = sempre a versão mais nova do seu plano; id fixo trava a versão.', '"Sempre o mais novo" acompanha a versão nova do seu plano; "versão travada" fica sempre na mesma.'],
  ['outro id…','outro modelo…'], ['digite o id exato','digite o nome exato do modelo'],
];
function aiPlainify(root){
  if(!root) return;
  const dev=typeof devInstall!=='undefined' && !!devInstall; // só quem roda o app do código-fonte
  root.querySelectorAll('[data-aieng="mock"]').forEach(b=>{
    const show=dev||b.classList.contains('on'); if(b.style.display!==(show?'':'none')) b.style.display=show?'':'none';
    const n=b.querySelector('.ain'), v=b.querySelector('.aiv');
    if(n&&n.textContent!=='Simulação') n.textContent='Simulação';
    if(v&&v.textContent!=='sem IA, pra testar') v.textContent='sem IA, pra testar';
    if(!b.title) b.title='simula a execução sem chamar nenhum modelo — só pra testar o fluxo do app';
  });
  root.querySelectorAll('.aimodel span').forEach(sp=>{
    const t=sp.textContent; if(!/\balias\b|id fixo/.test(t)) return;
    sp.parentNode.title=/\balias\b/.test(t)?'alias: o Claude Code usa a versão mais nova deste modelo no seu plano':'id fixo: usa exatamente esta versão, mesmo quando sair uma nova';
    sp.textContent=t.replace(/\balias\b/,'sempre o mais novo').replace(/id fixo/,'versão travada');
  });
  const w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let nd;
  while((nd=w.nextNode())){ let t=nd.nodeValue, t2=t; AI_PLAIN_TXT.forEach(([a,b])=>{ if(t2.includes(a)) t2=t2.split(a).join(b); }); if(t2!==t) nd.nodeValue=t2; }
}
// o seletor se redesenha sozinho a cada clique → reaplica no mesmo quadro (idempotente: só muda o que ainda está "cru")
function aiPlainWatch(el){
  if(!el||el.__aiPlain) return; el.__aiPlain=true;
  new MutationObserver(()=>aiPlainify(el)).observe(el,{ childList:true, subtree:true });
  aiPlainify(el);
}
window.aiPlainWatch=aiPlainWatch;
['aiPickHow','aiPickInv','aiPickDz'].forEach(id=>aiPlainWatch($id(id)));

// ---------- espaço em disco do .cardume (raio-x + limpeza) ----------
// Regra: aprendizados/estado (MEMORY, HISTORY, RUNBOOK, SPEC, PREFS, policy,
// skills, issue, orchestrations, state.sqlite) NUNCA saem daqui. Worktrees e
// entregáveis de tarefas finalizadas + temporários (logs/why/tmp) podem ir.
let wsUsage=null, wsMsg='';
function fmtBytes(n){ n=Number(n)||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(0)+' KB'; if(n<1073741824) return (n/1048576).toFixed(n<10485760?1:0)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
async function wsMount(){
  const h=$id('wsHost'); if(!h) return;
  if(!state.repo){ h.innerHTML='<div class="dim" style="font-size:12px">abra um projeto pra ver o espaço usado.</div>'; return; }
  h.innerHTML='<div class="dim" style="font-size:12px">medindo a pasta de trabalho do Starfork… (cópias grandes do código levam alguns segundos)</div>';
  try{ wsUsage=await invoke('workspace_usage'); }catch(e){ wsUsage=null; wsMsg='Falhou medir: '+(e&&e.message||e); }
  wsRender();
}
function wsRender(){
  const h=$id('wsHost'); if(!h) return;
  if(!wsUsage){ h.innerHTML=`<div style="font-size:12px;color:var(--warn)">${esc(wsMsg||'sem dados')}</div>`; return; }
  const u=wsUsage, wt=u.worktrees, ar=u.artifacts;
  const trash = (wt.staleBytes||0) + (u.temp||0);
  const row=(label, val, hint, keep)=>`<div style="display:flex;align-items:baseline;gap:10px;padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)">
      <span style="font-size:12.5px;${keep?'':''}">${label}</span><span class="dim" style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${hint}</span><b class="mono" style="font-size:12px;${keep?'color:var(--accent)':''}">${fmtBytes(val)}</b></div>`;
  const stale=(wt.items||[]).filter(i=>i.stale).sort((a,b)=>b.bytes-a.bytes).slice(0,6);
  h.innerHTML=`<div style="display:flex;flex-direction:column;gap:6px">
      ${row('Aprendizados e estado', u.keep, 'MEMORY · HISTORY · RUNBOOK · SPEC · PREFS · política · skills · issue · planos · banco — <b>sempre mantidos</b>', true)}
      ${row('Entregáveis', ar.bytes, `${ar.count} tarefa${ar.count===1?'':'s'} · ${fmtBytes(ar.staleBytes)} em ${ar.staleCount} finalizada${ar.staleCount===1?'':'s'} (mergeadas/canceladas)`)}
      ${row('Worktrees', wt.bytes, `${wt.count} pasta${wt.count===1?'':'s'} · ${fmtBytes(wt.staleBytes)} em ${wt.staleCount} de tarefa finalizada ou órfã — só lixo`)}
      ${row('Temporários', u.temp, 'logs · cache de explicações (why) · scripts descartáveis (tmp)')}
      ${u.attachments?row('Anexos do chat', u.attachments, 'prints e documentos que você anexou nas conversas — ficam'):''}
      <div style="display:flex;align-items:center;gap:10px;padding:2px 12px 0"><span class="dim" style="font-size:11.5px">total ${fmtBytes(u.total)} · liberável agora: <b style="color:var(--text)">${fmtBytes(trash)}</b> sem perder nada${ar.staleBytes?' · +'+fmtBytes(ar.staleBytes)+' se limpar os entregáveis finalizados':''}</span></div>
      ${stale.length?`<div class="dim mono" style="font-size:10.5px;padding:0 12px;line-height:1.6">${stale.map(i=>esc((i.title||i.id||'').slice(0,48))+' · '+esc(i.status)+' · '+fmtBytes(i.bytes)).join('<br>')}${wt.staleCount>stale.length?'<br>… e mais '+(wt.staleCount-stale.length):''}</div>`:''}
      ${wsMsg?`<div style="font-size:12px;color:${/^✓/.test(wsMsg)?'var(--accent)':'var(--warn)'};padding:0 12px">${esc(wsMsg)}</div>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
        <button class="btn sm" id="wsCleanTrash"${trash?'':' disabled'}>${ic('folder')}liberar ${fmtBytes(trash)} — worktrees finalizadas + temporários</button>
        <button class="btn sm" id="wsCleanArts"${ar.staleBytes?'':' disabled'}>limpar entregáveis de tarefas finalizadas (${fmtBytes(ar.staleBytes)})</button>
        <button class="btn sm" id="wsRefresh" title="medir de novo">${ic('pulse')}</button>
      </div></div>`;
  bindClick('wsRefresh', wsMount);
  bindClick('wsCleanTrash', ()=>wsClean({ worktrees:true, temp:true, artifacts:false },
    `Liberar ${fmtBytes(trash)}?\n\nRemove ${wt.staleCount} worktree${wt.staleCount===1?'':'s'} de tarefas mergeadas/canceladas/abortadas (ou órfãs) e os temporários (logs parados, cache, tmp).\n\nAprendizados, planos, banco e entregáveis NÃO são tocados. Tarefas em andamento, em review ou com erro ficam intactas.`));
  bindClick('wsCleanArts', ()=>wsClean({ worktrees:false, temp:false, artifacts:true },
    `Apagar os entregáveis de ${ar.staleCount} tarefa${ar.staleCount===1?'':'s'} finalizada${ar.staleCount===1?'':'s'} (${fmtBytes(ar.staleBytes)})?\n\nSão os prints de prova, testes e documentos gerados na pasta de trabalho do Starfork — a tela de Entregas deixa de mostrá-los. O código mergeado e os aprendizados ficam.`));
}
async function wsClean(what, question){
  if(!await askYes(question)) return;
  const h=$id('wsHost'); if(h) h.innerHTML='<div class="dim" style="font-size:12px">limpando…</div>';
  wsMsg='';
  try{ const r=await invoke('workspace_clean', what); wsMsg=`✓ ${fmtBytes(r.freed)} liberados (${r.removed} ${r.removed===1?'item':'itens'})`+((r.errors||[]).length?` · não deu em ${r.errors.length}: ${r.errors.slice(0,2).join('; ')}`:''); }
  catch(e){ wsMsg='Falhou limpar: '+(e&&e.message||e); }
  await wsMount();
}

/* ===== MOTOR DE ABAS (Chrome-style): as views que eram janela viram aba ===== */
const VIEW_META={
  projetos:{title:'Projetos',icon:'<path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>'},
  orq:{title:'Dividir',icon:'<circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M6 7.2l4.2-2.4M6 8.8l4.2 2.4"/>'},
  nova:{title:'Nova demanda',icon:'<path d="M7 2.6l1 2.6 2.6 1-2.6 1L7 9.8 6 7.2 3.4 6.2 6 5.2z" stroke-linejoin="round"/>'},
  planner:{title:'Nova demanda',icon:'<path d="M12.8 8.4c0 2.4-2.2 4.3-4.9 4.3-.6 0-1.2-.1-1.8-.3L3.2 13.4l.8-2.2A4.1 4.1 0 0 1 3 8.4" stroke-linejoin="round"/><path d="M10.4 2.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" stroke-linejoin="round"/>'},
  form:{title:'Formulário',icon:'<path d="M4 2.5h6L12.5 5v8.5H4z" stroke-linejoin="round"/><path d="M5.8 6.5h4.4M5.8 8.5h4.4M5.8 10.5h2.6"/>'},
  prefs:{title:'Preferências do projeto',icon:'<path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.3" fill="currentColor"/><circle cx="10.5" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="11.5" r="1.3" fill="currentColor"/>'},
  task:{title:'Tarefa',icon:'<circle cx="8" cy="8" r="5.2"/><path d="M8 5.4v3l1.9 1"/>'},
  cttask:{title:'Entrega do time',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.2 8.2l1.6 1.6 2.4-2.8"/>'},
  skills:{title:'Skills',icon:'<rect x="2.4" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="9.1" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="2.4" y="9.1" width="4.5" height="4.5" rx="1"/><path d="M11.35 9.3v4.1M9.3 11.35h4.1"/>'},
  issues:{title:'Issues',icon:'<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2v3.4M8 10.6v.05" stroke-linecap="round"/>'},
  issuesbulk:{title:'Nova issue',icon:'<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" stroke-linecap="round"/><path d="M2.6 4.5h.05M2.6 8h.05M2.6 11.5h.05" stroke-linecap="round" stroke-width="1.8"/>'},
  cfg:{title:'Configurações',icon:'<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8"/>'},
  daily:{title:'Daily',icon:'<rect x="2.5" y="3.5" width="11" height="10" rx="1.2"/><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5"/>'},
  chat:{title:'Chat do projeto',icon:'<path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.85-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" stroke-linejoin="round"/>'},
  conta:{title:'Conta e time',icon:'<path d="M4.6 11.8a2.6 2.6 0 0 1 .3-5.18 3.4 3.4 0 0 1 6.6.7 2.3 2.3 0 0 1-.4 4.55z" stroke-linejoin="round"/>'},
  agents:{title:'Agentes & Equipes',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/>'},
  epic:{title:'Épico',icon:'<path d="M8 2.6l5.2 5.4L8 13.4 2.8 8z" stroke-linejoin="round"/><path d="M5.6 8l1.7 1.7 3.1-3.4"/>'},
  memoria:{title:'Memória',icon:'<path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.3 3.4A2 2 0 0 0 4.2 12 2 2 0 0 0 8 12.6V3.6A2 2 0 0 0 6 2.8zM10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.3 3.4 2 2 0 0 1-1.5 3.8A2 2 0 0 1 8 12.6" stroke-linejoin="round"/>'},
  mesa:{title:'Mesa',icon:'<rect x="2.5" y="7.4" width="11" height="2.6" rx=".8"/><circle cx="4.6" cy="4.4" r="1.3"/><circle cx="8" cy="3.8" r="1.3"/><circle cx="11.4" cy="4.4" r="1.3"/><path d="M4.4 10v3.2M11.6 10v3.2"/>'},
  env:{title:'Ambiente',icon:'<path d="M8 13.5c-2.5-1.6-5-3.9-5-6.7A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5 2.2c0 2.8-2.5 5.1-5 6.7z" stroke-linejoin="round"/>'},
};
const VIEW_OVERLAY={ memoria:'memOverlay', mesa:'mesaOverlay', orq:'orqOverlay', projetos:'projetosOverlay', nova:'ndOverlay', planner:'plannerOverlay', form:'ntOverlay', skills:'skOverlay', issues:'issuesOverlay', issuesbulk:'issuesBulkOverlay', prefs:'prefsOverlay', cfg:'cfgOverlay', daily:'dailyOverlay', chat:'pcOverlay', conta:'cloudOverlay', agents:'agOverlay', env:'envOverlay', task:'fwOverlay', cttask:'ctPageOverlay', epic:'epicOverlay' };
let tabTaskId=null, tabTaskPath=null; // tarefa aberta na aba "task"
// Views de INSTÂNCIA MÚLTIPLA: cada aba guarda o próprio estado (nova, planner, form, orq)
// e o restaura ao voltar — dá pra ter duas "Montar conversando" abertas sem uma pisar na outra.
const MULTI_KINDS=new Set(['nova','planner','form','orq']);
// views únicas que guardam trabalho em andamento na própria tela: voltar pela ABA só mostra (não reabre —
// reabrir zerava a seleção de Issues e as edições não salvas de Agentes/Configurações); o menu/openTab recarrega
const KEEP_ON_SWITCH=new Set(['memoria','mesa','issues','issuesbulk','agents','cfg','skills','projetos','prefs','conta','env','daily']);
let tabSeq=0;
function tabStateApi(kind){ return window['TAB_STATE_'+kind]||null; }
function saveTabState(tab){ if(!tab||!MULTI_KINDS.has(tab.kind)) return; const api=tabStateApi(tab.kind); if(!api||!api.get) return; try{ tab.state=api.get(); if(tab.state&&tab.state._title) tab.title=String(tab.state._title).slice(0,28); }catch(e){ console.error('saveTabState',e); } }
function loadTabState(tab){ if(!tab||!MULTI_KINDS.has(tab.kind)||!tab.state) return; const api=tabStateApi(tab.kind); if(!api||!api.set) return; try{ api.set(tab.state); }catch(e){ console.error('loadTabState',e); } }
// abridores que POPULAM+mostram cada view (os bloco-1 vêm via window)
function viewOpen(kind, tab){
  const fresh=!!(tab&&tab.fresh); if(tab) tab.fresh=false;
  const f={ orq:()=>{ if(fresh&&window.orqFresh) window.orqFresh(); window.openOrq&&window.openOrq(); },
            projetos:()=>openProjetos(), nova:()=>openNovaStart(),
            planner:()=>{ if(fresh||!window.plShow) openPlanner(); else window.plShow(); },
            form:()=>{ if(fresh||!window.ntShow) openNewTask(); else window.ntShow(); },
            skills:()=>openSkills(), issues:()=>openIssues(), issuesbulk:()=>openIssuesBulk(), prefs:()=>openPrefs(), memoria:()=>window.openMemoria&&window.openMemoria(), mesa:()=>window.openMesa&&window.openMesa(), cfg:()=>openCfg(), daily:()=>openDaily(), chat:()=>openPc(), env:()=>openEnv(),
            conta:()=>window.openCloud&&window.openCloud(), agents:()=>window.openAgents&&window.openAgents(),
            task:()=>{ if(tabTaskId==null) return; const path=(tab&&tab.path)||null;
              // aba de tarefa de OUTRO projeto (você trocou de projeto depois de abrir): volta pro projeto dela antes
              if(tab && tab.repo && state.repo && tab.repo!==state.repo && window.switchProject){
                const tr=tab.repo, id=tab.id, tid=tabTaskId;
                window.switchProject(tr).then(()=>{ if(activeTab===id && state.repo===tr) fwOpenInner(tid, path); });
                return; }
              fwOpenInner(tabTaskId, path); },
            cttask:()=>{ if(window.ctPageOpenInner) window.ctPageOpenInner(tab); },
            epic:()=>{ if(window.epicPageOpenInner) window.epicPageOpenInner(tab); } }[kind];
  if(f) f();
}
// cada aba tem um id único: 'flow', o próprio kind (views únicas), 'task:<id>' (uma por tarefa)
// ou '<kind>:<n>' (views de instância múltipla)
let TABS=[{id:'flow',kind:'flow',title:'Central',pin:true}];
let activeTab='flow';
function tabById(id){ return TABS.find(t=>t.id===id); }
// fecha uma tela: como ABA fecha a aba (esconder o overlay deixava a aba ativa EM BRANCO); como modal, esconde
function ovHide(o){
  if(typeof o==='string') o=$id(o); if(!o) return;
  const kind=Object.keys(VIEW_OVERLAY).find(k=>VIEW_OVERLAY[k]===o.id);
  if(kind && o.classList.contains('astab')){ closeTabOfKind(kind); return; }
  o.style.display='none';
}
window.ovHide=ovHide;
// mostra um overlay DEPOIS de um await sem quebrar o modo aba: como aba fica 'block' (o 'flex' inline vencia o
// .astab e a tela virava modal); se o usuário já saiu da aba dela enquanto carregava, não aparece por cima de outra
function ovShow(o){
  if(typeof o==='string') o=$id(o); if(!o) return;
  if(o.classList.contains('astab')){ o.style.display='block'; return; }
  const kind=Object.keys(VIEW_OVERLAY).find(k=>VIEW_OVERLAY[k]===o.id), cur=tabById(activeTab);
  if(kind && tabsOfKind(kind).length && cur && cur.kind!==kind) return;
  o.style.display='flex';
}
function tabsOfKind(kind){ return TABS.filter(t=>t.kind===kind); }
function tabIcon(kind){ if(kind==='flow') return '<rect x="2.5" y="3" width="11" height="10" rx="1.4"/><path d="M2.5 6h11"/>'; return (VIEW_META[kind]||{}).icon||''; }
function activateTab(id){ if(id!==activeTab) saveTabState(tabById(activeTab)); activeTab=id; renderTabs(); showActiveView(); }
// openTab(kind, opts): views únicas reaproveitam a aba; views múltiplas abrem uma NOVA aba,
// salvo opts.replace (a aba ativa de "Nova demanda" vira o método escolhido, mantendo o id)
// ou opts.reuse (função que escolhe uma aba já aberta do mesmo kind).
function openTab(kind, opts){
  opts=opts||{};
  // criar demanda/plano exige um projeto aberto: sem projeto, leva pra Projetos em vez de abrir um formulário sem destino
  if(['nova','form','planner','orq'].includes(kind) && typeof state!=='undefined' && !state.repo){
    // "Começar sem portões": a tela inicial já cria o projeto a partir do pedido — leva pra lá, não pra Projetos
    if($id('emWhat')){ toast('Diga aqui o que você quer fazer — o projeto é criado junto.','warn'); openTab('flow'); setTimeout(()=>{ const t=$id('emWhat'); if(t) t.focus(); },60); return; }
    toast('Abra ou crie um projeto primeiro — a demanda roda dentro dele.','warn');
    openTab('projetos'); return; }
  // criar demanda/plano exige branch: pasta sem git passa pelo "criar repositório" antes
  if(['nova','form','planner','orq'].includes(kind) && typeof repoHasGit==='function' && !repoHasGit()){ gitGate().then(ok=>{ if(ok) openTab(kind, opts); }); return; }
  // repaginada B: "Nova demanda" (botão, +, n, ghostNew, trocar tipo) abre DIRETO no planner vazio — uma tela só.
  // A tela antiga de 2 passos fica atrás de lsGet('nd:legacy')==='1' por uma versão.
  if(kind==='nova' && !(window.ndLegacy && window.ndLegacy())) kind='planner';
  if(kind==='flow'){ activateTab('flow'); return; }
  let tab=null;
  if(MULTI_KINDS.has(kind)){
    const cur=tabById(activeTab);
    if(opts.replace && cur && MULTI_KINDS.has(cur.kind) && cur.id===activeTab){ tab=cur; tab.kind=kind; tab.title=(VIEW_META[kind]||{}).title||kind; tab.state=null; tab.fresh=true; }
    else if(opts.reuse){ tab=tabsOfKind(kind).find(t=>{ try{ return opts.reuse(t); }catch(_){ return false; } })||null; }
    if(!tab){ tab={id:kind+':'+(++tabSeq), kind, title:(VIEW_META[kind]||{}).title||kind, fresh:true, state:null}; TABS.push(tab); }
  } else {
    tab=tabById(kind); if(!tab){ tab={id:kind, kind, title:(VIEW_META[kind]||{}).title||kind}; TABS.push(tab); }
    tab.loaded=false; // aberto pelo menu/atalho: recarrega a tela
  }
  activateTab(tab.id);
}
window.openTab=openTab;
// E6 (bug #9): edição de arquivo aberta na aba de uma tarefa — fechar ESSA aba, ou ir pra aba de OUTRA tarefa
// (fwOpenInner zera o editor), pergunta antes de descartar. Trocar pra quadro/config mantém a edição (volta intacta).
async function tabLeaveGuard(targetId, closing){
  if(typeof fwEditing==='undefined' || !fwEditing || typeof fwLeaveEditor!=='function' || typeof fwTask==='undefined' || !fwTask) return true;
  const tg=tabById(targetId); if(!tg) return true;
  const losing = closing ? (tg.kind==='task' && tg.taskId===fwTask) : (tg.kind==='task' && tg.taskId!==fwTask);
  return losing ? await fwLeaveEditor() : true;
}
function closeTab(id){
  const i=TABS.findIndex(t=>t.id===id); if(i<0||TABS[i].pin) return;
  const kind=TABS[i].kind;
  TABS.splice(i,1);
  // esconde o overlay do kind se nenhuma OUTRA aba do mesmo kind sobrou
  if(!TABS.some(t=>t.kind===kind)){ const o=$id(VIEW_OVERLAY[kind]); if(o){ o.classList.remove('astab'); o.style.display='none'; } }
  // fechou uma aba de FUNDO: a ativa continua como está (showActiveView restaurava nela o estado velho
  // guardado ao sair — ex.: o "Montar conversando" ativo perdia as mensagens mais recentes)
  if(activeTab!==id){ renderTabs(); return; }
  activeTab=(TABS[i-1]||TABS[0]).id;
  renderTabs(); showActiveView();
}
// R7: reordenar abas arrastando. A aba fixa (Central) fica sempre na frente; soltar sobre outra aba põe a
// arrastada no lugar dela. Devolve true quando mudou. Pura sobre TABS (testada em app/tests/central.test.mjs).
let tabDragId=null;
function tabMove(fromId, toId){
  const from=TABS.findIndex(t=>t.id===fromId), to=TABS.findIndex(t=>t.id===toId);
  if(from<0 || to<0 || from===to || TABS[from].pin) return false;
  const [t]=TABS.splice(from,1);
  let at=TABS.findIndex(x=>x.id===toId); if(from<to) at++;       // soltar à direita de onde estava: entra depois do alvo
  const firstFree=TABS.findIndex(x=>!x.pin); if(firstFree>=0 && at<firstFree) at=firstFree; // nunca antes das fixas
  TABS.splice(Math.max(0,at),0,t);
  return true;
}
// próxima/anterior aba (⌘⇧] / ⌘⇧[ e Ctrl+Tab / Ctrl+⇧Tab), em volta
function tabStepId(dir){ const i=TABS.findIndex(t=>t.id===activeTab); if(!TABS.length) return null; return TABS[((i<0?0:i)+dir+TABS.length)%TABS.length].id; }
// fecha a aba ATIVA desse kind (ou a última aberta) — usado pelos botões "fechar" das views
function closeTabOfKind(kind){ const cur=tabById(activeTab); const t=(cur&&cur.kind===kind)?cur:tabsOfKind(kind).slice(-1)[0]; if(t) closeTab(t.id); }
window.closeTabOfKind=closeTabOfKind;
function showActiveView(){
  const t=tabById(activeTab)||TABS[0];
  const target=t.kind==='flow'?null:VIEW_OVERLAY[t.kind];
  // esconde as OUTRAS telas; a do destino fica como está (esconder e mostrar a mesma = piscada)
  Object.keys(VIEW_OVERLAY).forEach(k=>{ const id=VIEW_OVERLAY[k]; if(id===target) return; const o=$id(id); if(o && o.dataset.lock!=='1'){ o.classList.remove('astab'); if(o.style.display!=='none') o.style.display='none'; } });
  if(t.kind==='flow') return; // o quadro (.body) já aparece
  if(t.kind==='task') tabTaskId=t.taskId; // qual tarefa esta aba mostra
  loadTabState(t);      // devolve o estado guardado desta aba (views múltiplas)
  const kindWas=t.kind;
  if(!(KEEP_ON_SWITCH.has(t.kind) && t.loaded)){ if(typeof perfTabOpen==='function') perfTabOpen(t.kind); viewOpen(t.kind, t); t.loaded=true; }
  // o abridor trocou a aba por dentro (aba 'nova' antiga → planner, via openTab replace): a chamada interna já mostrou a tela certa
  if(activeTab!==t.id || t.kind!==kindWas){ const o0=$id(VIEW_OVERLAY[kindWas]); if(o0 && VIEW_OVERLAY[kindWas]!==VIEW_OVERLAY[t.kind]){ o0.classList.remove('astab'); o0.style.display='none'; } return; }  // popula + mostra (os abridores setam display='flex' = layout de MODAL)
  const o=$id(target);
  // vira ABA no MESMO quadro: antes era num requestAnimationFrame e a tela pintava 1 quadro como
  // modal (flex, sem .astab) a cada troca de aba — a "piscada"
  if(o){ syncChromeH(); o.classList.add('astab'); o.style.display='block'; requestAnimationFrame(syncChromeH); }
}
function renderTabs(){
  const bar=$id('tabBar'); if(!bar) return;
  bar.style.display='flex'; bar.setAttribute('data-tauri-drag-region','');
  // título vivo das abas múltiplas (ex.: a demanda que está sendo montada)
  for(const t of TABS){ if(t.id===activeTab && MULTI_KINDS.has(t.kind)){ const api=tabStateApi(t.kind); try{ const st=api&&api.get&&api.get(); if(st&&st._title) t.title=String(st._title).slice(0,28); else if(st&&st._title===''){ t.title=(VIEW_META[t.kind]||{}).title||t.kind; } }catch(_){ } } }
  // numera só as abas que ainda têm o título genérico ("Montar conversando 1, 2…")
  const counts={}; TABS.forEach(t=>{ if(t.title===((VIEW_META[t.kind]||{}).title||t.kind)) counts[t.kind]=(counts[t.kind]||0)+1; });
  const seen={};
  bar.innerHTML=`<button class="railtgl railtgl-main" id="railToggleMain" title="Expandir a barra lateral (⌘B)" aria-label="Expandir barra lateral"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M6.2 2.8v10.4" stroke-linecap="round"/></svg></button>`+TABS.map(t=>{
    const on=t.id===activeTab; const base=(VIEW_META[t.kind]||{}).title||t.kind; if(t.title===base) seen[t.kind]=(seen[t.kind]||0)+1;
    const title=(MULTI_KINDS.has(t.kind)&&counts[t.kind]>1&&t.title===base)?`${base} ${seen[t.kind]}`:t.title;
    // R7: aba pelo teclado (role=tab, Tab chega, Enter abre, ←/→ passa), título inteiro no tooltip (o texto corta em 28)
    // e arrastável pra reordenar (a Central fica fixa na frente)
    return `<span class="tab ${on?'on':''} ${t.pin?'pin':''}" data-tk="${escA(t.id)}" role="tab" tabindex="${on?0:-1}" aria-selected="${on}" title="${escA(title)}"${t.pin?'':' draggable="true"'}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">${tabIcon(t.kind)}</svg><span class="tt">${esc(title)}</span>${t.pin?'':`<span class="x" data-xk="${escA(t.id)}" role="button" aria-label="fechar a aba ${escA(title)}" title="fechar (⌘W)">${IC.x}</span>`}</span>`;
  }).join('')+`<span class="tabadd" id="tabAdd" title="nova demanda — sempre abre uma aba nova (⌘N)&#10;${escA(SHORTCUTS_HELP)}">+</span><span class="tabgrow" data-tauri-drag-region></span><span class="tabright" id="tabRight"></span>`;
  bar.setAttribute('role','tablist');
  bar.querySelectorAll('[data-tk]').forEach(el=>{
    el.onclick=async e=>{ if(e.target.closest('[data-xk]')) return; const id=el.dataset.tk; if(!await tabLeaveGuard(id, false)) return; activateTab(id); };
    // botão do meio fecha a aba (como no navegador)
    el.addEventListener('auxclick', async e=>{ if(e.button!==1) return; e.preventDefault(); const id=el.dataset.tk; const t=tabById(id); if(!t||t.pin) return; if(!await tabLeaveGuard(id, true)) return; closeTab(id); });
    el.onkeydown=e=>{
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); el.click(); }
      else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){ e.preventDefault(); const l=[...bar.querySelectorAll('[data-tk]')], i=l.indexOf(el); const n=l[(i+(e.key==='ArrowRight'?1:-1)+l.length)%l.length]; if(n) n.focus(); }
    };
    if(el.getAttribute('draggable')==='true'){
      el.addEventListener('dragstart', e=>{ tabDragId=el.dataset.tk; el.classList.add('dragging'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', tabDragId); }catch(_){ } });
      el.addEventListener('dragend', ()=>{ tabDragId=null; el.classList.remove('dragging'); bar.querySelectorAll('.tab.dropto').forEach(x=>x.classList.remove('dropto')); });
    }
    el.addEventListener('dragover', e=>{ if(!tabDragId || tabDragId===el.dataset.tk) return; e.preventDefault(); el.classList.add('dropto'); });
    el.addEventListener('dragleave', ()=>el.classList.remove('dropto'));
    el.addEventListener('drop', e=>{ if(!tabDragId) return; e.preventDefault(); const from=tabDragId; tabDragId=null; if(tabMove(from, el.dataset.tk)) renderTabs(); });
  });
  // E6 (bug #9): o X da aba perguntava nada e jogava fora a edição não salva do arquivo (só ⌘W e o botão fechar perguntavam)
  bar.querySelectorAll('[data-xk]').forEach(el=>el.onclick=async e=>{ e.stopPropagation(); const id=el.dataset.xk; if(!await tabLeaveGuard(id, true)) return; closeTab(id); });
  const add=$id('tabAdd'); if(add) add.onclick=()=>openTab('nova');
  { const m=$id('railToggleMain'); if(m) m.onclick=()=>setRailCollapsed(false); }
  // o botão "atualizar" (versão nova) mora na barra de abas, à direita
  { const u=$id('updBtn'), slot=$id('tabRight'); if(u&&slot&&u.parentElement!==slot) slot.appendChild(u); }
  requestAnimationFrame(syncChromeH);
  tabsFit();
}
// R7: barra de abas lotada → modo compacto (menos respiro; o X das abas de fundo só no hover, como no navegador) e
// rola até a ativa. Recalcula no render e ao redimensionar a janela.
function tabsFit(){
  const bar=$id('tabBar'); if(!bar) return;
  bar.classList.remove('crowded');
  if(bar.scrollWidth>bar.clientWidth+1) bar.classList.add('crowded');
  const on=bar.querySelector('.tab.on');
  if(on && bar.scrollWidth>bar.clientWidth+1) try{ on.scrollIntoView({ block:'nearest', inline:'nearest' }); }catch(_){ }
}
{ let tm=null; window.addEventListener('resize', ()=>{ clearTimeout(tm); tm=setTimeout(tabsFit, 150); }); }
$id('bdClose').onclick=()=>bdClosePlan();
$id('bdCancel').onclick=()=>bdClosePlan();
$id('bdOverlay').addEventListener('click',e=>{ if(e.target.id==='bdOverlay') bdClosePlan(); });
$id('cfgClose').onclick=cfgHide;
$id('cfgOverlay').addEventListener('click',e=>{ if(e.target.id==='cfgOverlay') cfgHide(); });

// ---------- onboarding de 60 segundos (primeiro boot) ----------
// Ordem do 1º uso: login (gate obrigatório do 44-onboarding) → ESTE tour → abrir/criar projeto.
// Antes o tour abria em 900ms e o gate de login (3,2s) cobria ele no meio. Agora ele só começa com
// sessão aberta e a tela de entrada fechada: obMaybeStart() é chamado pelo auHide/loginGateSync.
const OB_STEPS=[
  { t:'Bem-vindo ao Starfork', b:'Aqui, cada <b>tarefa</b> roda numa <b>cópia isolada do seu código</b> (uma branch só dela), tocada por agentes de IA — com plano, código, testes e <b>provas reais</b> (prints e saídas de verdade, nunca mock). Você acompanha tudo ao vivo e conversa com o agente como num chat.' },
  { t:'Seu time vê o essencial', b:'Com a conta num time (<b>Conta e time</b>, no rodapé da barra lateral), suas tarefas viram <b>cartões compartilhados automaticamente</b>: título, status, custo e branch sincronizam — a <b>conversa do agente fica só na sua máquina</b> e as provas só sobem quando você publicar. O backlog do time fica na visão <b>Time</b> da Central.' },
  { t:'Antes de começar', b:'O app depende de 4 coisas: <b>node</b>, <b>git</b>, <b>claude</b> (logado) e <b>gh</b> (autenticado). Vamos verificar agora — o que faltar vem com o comando de correção pronto pra copiar.', env:true },
  { t:'Escolha o projeto', b:'Os agentes trabalham dentro de um projeto (uma pasta com git). Abra uma pasta que você já tem ou crie um projeto novo do zero — dá pra ter vários e trocar a qualquer hora em <b>Projetos</b>.', proj:true },
];
let obStep=0;
function openOnboarding(){ obStep=0; renderOb(); $id('obOverlay').style.display='flex'; }
// só no 1º uso, com sessão aberta e sem a tela de entrada/planos por cima
function obMaybeStart(){
  if(lsGet('onboarded')) return;
  const ob=$id('obOverlay'); if(ob && ob.style.display==='flex') return;
  if(typeof SB==='undefined' || !SB.sess()) return;
  if(typeof auOpen==='function' && auOpen()) return;
  openOnboarding();
}
window.obMaybeStart=obMaybeStart;
function renderOb(){
  const s=OB_STEPS[obStep];
  const last=obStep===OB_STEPS.length-1;
  const hasRepo=!!(state&&state.repo);
  $id('obBody').innerHTML=`
    <div style="display:flex;gap:6px;margin-bottom:18px">${OB_STEPS.map((_,i)=>`<span style="height:4px;flex:1;border-radius:99px;background:${i<=obStep?'var(--accent)':'var(--border)'}"></span>`).join('')}</div>
    <h2 style="font-size:20px;margin:0 0 10px">${s.t}</h2>
    <p style="color:var(--text-2);font-size:14px;line-height:1.65;margin:0">${s.b}</p>
    ${s.env?'<div id="obEnv" style="margin-top:14px"><div class="dim" style="font-size:12px">verificando o ambiente…</div></div>':''}
    ${s.proj?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">${hasRepo?`<span class="dim" style="font-size:12.5px;align-self:center">✓ projeto aberto: <b style="color:var(--text)">${esc(pathBase(state.repo))}</b></span>`:''}<button class="btn${hasRepo?'':' primary'}" id="obOpenDir">${ic('folder')}Abrir pasta</button><button class="btn" id="obNewProj">+ Criar projeto novo</button></div>`:''}
    <div style="display:flex;gap:8px;margin-top:24px;align-items:center">
      <button class="btn sm" id="obSkip">pular</button><span style="flex:1"></span>
      <button class="btn primary" id="obNext">${last?(hasRepo?'Começar':'depois'):'continuar'}</button>
    </div>`;
  $id('obSkip').onclick=()=>{ finishOb(); };
  $id('obNext').onclick=()=>{ if(!last){ obStep++; renderOb(); } else { finishOb(); coachStart(); } };
  bindClick('obOpenDir', async()=>{ if(window.pickFolder) await window.pickFolder(); if(state&&state.repo){ finishOb(); coachStart(); } else renderOb(); });
  bindClick('obNewProj', ()=>{ finishOb(); if(window.openNewProject) window.openNewProject(); });
  // check de ambiente INTEGRADO no onboarding (redesign p16): fix inline com botão de copiar, sem bloquear a entrada
  if(s.env) runEnvCheck().then(()=>{
    const el=$id('obEnv'); if(!el) return;
    el.innerHTML=(envChecks||[]).map(c=>`<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
      <span style="color:${c.ok?'var(--good)':'var(--warn)'}">${c.ok?IC.ok:IC.warn}</span><div style="flex:1;min-width:0"><b>${esc(c.name)}</b> <span class="dim">${esc((c.detail||'').slice(0,80))}</span>${!c.ok&&c.fix?`<div style="display:flex;gap:8px;align-items:center;margin-top:5px"><span class="dim" style="font-size:11px">rode no Terminal:</span><code class="mono" style="font-size:10.5px;color:var(--warn);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escA(c.fix)}">${esc(c.fix)}</code><button class="btn sm" data-envfix="${escA(c.fix)}">copiar</button></div>`:''}</div></div>`).join('')
      +((envChecks||[]).some(c=>!c.ok)?'<div class="dim" style="font-size:11.5px;margin-top:8px">Dá pra seguir mesmo assim — o que faltar fica com um aviso em <b>Mais › Ambiente</b>, no rodapé da barra lateral.</div>':'');
    el.querySelectorAll('[data-envfix]').forEach(b=>{ b.onclick=()=>{ try{ navigator.clipboard.writeText(b.dataset.envfix); b.textContent='copiado ✓'; }catch(_){ } }; });
  }).catch(()=>{});
}
function finishOb(){ lsSet('onboarded','1'); $id('obOverlay').style.display='none'; }
// rede de segurança: sessão que já existia no boot (o gate nem abre) → começa depois do gate checar (3,2s)
setTimeout(obMaybeStart, 3800);

// ---------- coach marks de primeira vez (redesign p17) ----------
const COACH=[
  ['newTaskBtn','Tudo começa aqui','Descreva o que precisa em 1–2 frases — o assistente monta a spec e o time de agentes executa.'],
  ['ffSearch','Busca em tudo','Ache qualquer demanda pelo título — ou use ⌘K de qualquer lugar.'],
  ['rail','Execução ao vivo','Os agentes rodando agora ficam aqui. Amarelo = um deles está aguardando você.'],
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
// ⌘J/⌘, abrem como ABA (igual à barra lateral — antes viravam modal flutuante), ⌘W fecha a aba ativa,
// ⌘1…⌘8 vão pra aba N e ⌘9 pra última (como no navegador). A lista fica no tooltip do "+" da barra de abas.
const SHORTCUTS_HELP='Atalhos: ⌘N nova demanda · ⌘K buscar · ⌘J chat do projeto · ⌘, configurações · ⌘O abrir pasta · ⌘B barra lateral · ⌘W fechar aba · ⌘1…⌘9 ir pra aba · ⌘⇧[ ⌘⇧] aba anterior/próxima · arraste uma aba pra reordenar';
document.addEventListener('keydown', async e=>{
  if(!(e.metaKey||e.ctrlKey) || e.altKey) return;
  const k=(e.key||'').toLowerCase();
  if(k==='j' && !e.shiftKey){ e.preventDefault(); openTab('chat'); }
  else if(k===',' && !e.shiftKey){ e.preventDefault(); openTab('cfg'); }
  else if(k==='b' && !e.shiftKey){ e.preventDefault(); setRailCollapsed(!railIsCol()); }
  else if(k==='w' && !e.shiftKey){ e.preventDefault(); const t=tabById(activeTab); if(!t || t.pin) return;
    // aba de tarefa com o editor aberto: pergunta antes de descartar o que não foi salvo (igual ao "fechar")
    if(t.kind==='task' && typeof fwLeaveEditor==='function' && !await fwLeaveEditor()) return;
    if(tabById(t.id)) closeTab(t.id); }
  // R7: ⌘1…⌘9 passa pela MESMA guarda do clique na aba — antes ia direto e jogava fora a edição não salva do arquivo
  else if(/^[1-9]$/.test(k) && !e.shiftKey){ e.preventDefault(); const i=k==='9'?TABS.length-1:(+k-1); const t=TABS[i]; if(t && t.id!==activeTab && await tabLeaveGuard(t.id, false)) activateTab(t.id); }
  else if((e.shiftKey && (e.code==='BracketRight'||e.code==='BracketLeft')) || (e.ctrlKey && k==='tab')){
    e.preventDefault(); const dir=(e.code==='BracketLeft'||(k==='tab'&&e.shiftKey))?-1:1; const id=tabStepId(dir);
    if(id && id!==activeTab && await tabLeaveGuard(id, false)) activateTab(id); }
});

function eventsOf(taskId){ return state.events.filter(e=>e.taskId===taskId); }
function diffOf(taskId){ return state.diffs.find(d=>d.taskId===taskId); }
function reviewOf(taskId){ return (state.reviews||[]).find(r=>r.taskId===taskId); }
async function openRef(taskId, name){
  let c;
  try{ c=await invoke('read_ref',{ taskId, name }); }
  catch(e){ showErr(e, 'Falha ao abrir a referência'); return; }
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
// formato compacto (KPIs, listas): mesma régua do fmtCost ("US$ 1,25") — antes "$1.25" convivia com "US$ 1,25 (≈ R$ …)"
function fmtUsd(u){ return fmtCost(u,{usdOnly:true}); }
function fmtTok(n){ n=Number(n)||0; const u=(d,s)=>{ const v=n/d; return (v>=100?v.toFixed(0):v>=10?v.toFixed(1).replace(/\.0$/,''):v.toFixed(1).replace(/\.0$/,''))+s; };
  return n>=1e9?u(1e9,'B'):n>=1e6?u(1e6,'M'):n>=1000?u(1e3,'k'):String(n); }

