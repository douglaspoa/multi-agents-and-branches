// Starfork — 15-config-abas-onboarding
// ---------- configurações (⌘,) ----------
// fecha Configurações: como ABA fecha a aba (esconder o overlay deixava a aba ativa EM BRANCO); como modal, esconde
function cfgHide(){ const o=$id('cfgOverlay'); if(o&&o.classList.contains('astab')) closeTabOfKind('cfg'); else if(o) o.style.display='none'; }
// Ajustes (ex-Configurações): a página inteira mora em 67-ajustes.js (F4 · G3) — aqui só a porta de entrada da aba 'cfg'
// (cfgValidate, cfgTaskModeOf/ShouldSave, RETRO_MODELS e retroModelSelect também foram pra lá)
function openCfg(){ if(typeof ajustesRender==='function') ajustesRender(); }
$id('cfgBtn').onclick=()=>{ if(typeof ajustesOpen==='function') ajustesOpen(); else openCfg(); };

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
function fmtBytes(n){ return fmtBytes0(n).replace('.',','); } // pt-BR: vírgula decimal
function fmtBytes0(n){ n=Number(n)||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(0)+' KB'; if(n<1073741824) return (n/1048576).toFixed(n<10485760?1:0)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
// F4 (G1): o disco é do PROJETO — mora em Projeto › Espaço em disco (#projWsHost); #wsHost (Ajustes antigo) segue valendo
function wsHostEl(){ const d=$id('projDisk'), p=$id('projWsHost'); return (p && d && !d.hidden) ? p : ($id('wsHost')||p); }
async function wsMount(){
  const h=wsHostEl(); if(!h) return;
  if(!state.repo){ h.innerHTML='<div class="dim" style="font-size:var(--fs-sm)">abra um projeto pra ver o espaço usado.</div>'; return; }
  h.innerHTML='<div class="dim" style="font-size:var(--fs-sm)">medindo a pasta de trabalho do Starfork… (cópias grandes do código levam alguns segundos)</div>';
  // medir de novo com sucesso apaga o erro de uma medição anterior (antes ficava "Não consegui medir" ao lado dos números)
  try{ wsUsage=await invoke('workspace_usage'); if(/^Não consegui medir/.test(wsMsg)) wsMsg=''; }catch(e){ wsUsage=null; wsMsg=humanErr(e,'Não consegui medir o espaço').msg; }
  wsRender();
}
function wsRender(){
  const h=wsHostEl(); if(!h) return;
  if(!wsUsage){ h.innerHTML=`<div style="font-size:var(--fs-sm);color:var(--warn)">${esc(wsMsg||'sem dados')}</div>`; return; }
  const u=wsUsage, wt=u.worktrees, ar=u.artifacts;
  const trash = (wt.staleBytes||0) + (u.temp||0);
  const tot=Math.max(1, u.total||0);
  const row=(label, sub, val, note, keep)=>`<div class="wsrow"><span><b>${label}</b><br><span class="dim">${sub}</span></span><div class="wsm"><i class="${keep?'keep':''}" style="width:${Math.max(1, Math.round((val||0)/tot*100))}%"></i></div><b class="mono">${fmtBytes(val)}</b><span class="dim">${note}</span></div>`;
  const stale=(wt.items||[]).filter(i=>i.stale).sort((a,b)=>b.bytes-a.bytes).slice(0,6);
  h.innerHTML=`<div class="wsk"><div class="num"><b>${fmtBytes(u.total)}</b><span>total da pasta</span></div><div class="num"><b>${fmtBytes(trash)}</b><span>liberável agora, sem perder nada</span></div><div class="num"><b>+${fmtBytes(ar.staleBytes||0)}</b><span>se limpar entregáveis de tarefas finalizadas</span></div></div>
    <div class="pgcard wsrows">
      ${row('Aprendizados e estado', 'memória, configurações, planos, banco', u.keep, 'sempre mantidos', true)}
      ${row('Cópias de trabalho', 'uma por tarefa', wt.bytes, `${wt.staleCount} de tarefa finalizada ou órfã`)}
      ${row('Entregáveis', 'provas, prints, documentos', ar.bytes, `${ar.staleCount} de tarefa${ar.staleCount===1?'':'s'} finalizada${ar.staleCount===1?'':'s'}`)}
      ${row('Temporários', 'logs, cache, scripts descartáveis', u.temp, 'podem ir')}
      ${u.attachments?row('Anexos da conversa', 'prints e documentos que você anexou', u.attachments, 'ficam'):''}
    </div>
    ${stale.length?`<div class="pgsh3"><h3>Cópias paradas de tarefas finalizadas</h3><span>entram no “liberar”</span></div><div class="pgcard rows">${stale.map(i=>`<div class="li"><span>${esc((i.title||i.id||'').slice(0,60))}</span><span class="grow"></span><span class="dim">${esc(stLabel(i.status))} · ${fmtBytes(i.bytes)}</span></div>`).join('')}${wt.staleCount>stale.length?`<div class="li dim">… e mais ${wt.staleCount-stale.length}</div>`:''}</div>`:''}
    ${wsMsg?`<p class="pgnote" style="color:${/^✓/.test(wsMsg)?'var(--accent)':'var(--warn)'}">${esc(wsMsg)}</p>`:''}
    <div class="wsacts"><button class="btn primary sm" id="wsCleanTrash"${trash?'':' disabled'}>Liberar ${fmtBytes(trash)}</button><button class="btn sm" id="wsRefresh" title="medir de novo" aria-label="medir de novo">${ic('pulse')}</button><span class="grow"></span>
      <button class="btn sm danger" id="wsCleanArts"${ar.staleBytes?'':' disabled'}>Limpar entregáveis de tarefas finalizadas (${fmtBytes(ar.staleBytes)})…</button></div>`;
  bindClick('wsRefresh', wsMount);
  bindClick('wsCleanTrash', ()=>wsClean({ worktrees:true, temp:true, artifacts:false },
    `Liberar ${fmtBytes(trash)}?\n\nRemove ${wt.staleCount} cópia${wt.staleCount===1?'':'s'} de trabalho de tarefas mergeadas/canceladas/abortadas (ou órfãs) e os temporários (logs parados, cache, tmp).\n\nAprendizados, planos, banco e entregáveis NÃO são tocados. Tarefas em andamento, em revisão ou com erro ficam intactas.`));
  bindClick('wsCleanArts', ()=>wsClean({ worktrees:false, temp:false, artifacts:true },
    `Apagar os entregáveis de ${ar.staleCount} tarefa${ar.staleCount===1?'':'s'} finalizada${ar.staleCount===1?'':'s'} (${fmtBytes(ar.staleBytes)})?\n\nSão os prints de prova, testes e documentos gerados na pasta de trabalho do Starfork — a tela de Entregas deixa de mostrá-los. O código mergeado e os aprendizados ficam.`))
}
async function wsClean(what, question){
  if(!await askYes(question)) return;
  const h=wsHostEl(); if(h) h.innerHTML='<div class="dim" style="font-size:var(--fs-sm)">limpando…</div>';
  wsMsg='';
  try{ const r=await invoke('workspace_clean', what); wsMsg=`✓ ${fmtBytes(r.freed)} liberados (${r.removed} ${r.removed===1?'item':'itens'})`+((r.errors||[]).length?` · não deu em ${r.errors.length}: ${r.errors.slice(0,2).join('; ')}`:''); }
  catch(e){ wsMsg=humanErr(e,'Não consegui limpar').msg; }
  await wsMount();
}

/* ===== MOTOR DE ABAS (Chrome-style): as views que eram janela viram aba ===== */
// a Nova demanda usa o símbolo da marca (IC.starfork, de 10-core) — typeof: os testes carregam este arquivo sem o 10-core
const SF_TAB_IC=(typeof IC!=='undefined'&&IC.starforkG)||'';
const VIEW_META={
  projetos:{title:'Projetos',icon:'<path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>'},
  orq:{title:'Dividir',icon:'<circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M6 7.2l4.2-2.4M6 8.8l4.2 2.4"/>'},
  nova:{title:'Nova demanda',icon:SF_TAB_IC},
  planner:{title:'Nova demanda',icon:SF_TAB_IC},
  form:{title:'Formulário',icon:'<path d="M4 2.5h6L12.5 5v8.5H4z" stroke-linejoin="round"/><path d="M5.8 6.5h4.4M5.8 8.5h4.4M5.8 10.5h2.6"/>'},
  prefs:{title:'Preferências do projeto',icon:'<path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.3" fill="currentColor"/><circle cx="10.5" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="11.5" r="1.3" fill="currentColor"/>'},
  task:{title:'Tarefa',icon:'<circle cx="8" cy="8" r="5.2"/><path d="M8 5.4v3l1.9 1"/>'},
  // canvas no topo (58-canvas): abas que abrem pelo "+" e podem ir pra tela dividida
  web:{title:'Navegador',icon:'<circle cx="8" cy="8" r="5.6"/><path d="M2.6 8h10.8M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6M8 2.4C6.4 4 5.6 5.9 5.6 8s.8 4 2.4 5.6"/>'},
  device:{title:'Simulador',icon:'<rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.6"/><path d="M7 12.3h2" stroke-linecap="round"/>'},
  doc:{title:'Documento',icon:'<path d="M4 2.5h5.2L12 5.3v8.2H4z" stroke-linejoin="round"/><path d="M9 2.6v2.8h2.9M6 8h4M6 10.3h4" stroke-linecap="round"/>'},
  cttask:{title:'Entrega do time',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.2 8.2l1.6 1.6 2.4-2.8"/>'},
  skills:{title:'Skills',icon:'<rect x="2.4" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="9.1" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="2.4" y="9.1" width="4.5" height="4.5" rx="1"/><path d="M11.35 9.3v4.1M9.3 11.35h4.1"/>'},
  issues:{title:'Issues',icon:'<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2v3.4M8 10.6v.05" stroke-linecap="round"/>'},
  issuesbulk:{title:'Nova issue',icon:'<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" stroke-linecap="round"/><path d="M2.6 4.5h.05M2.6 8h.05M2.6 11.5h.05" stroke-linecap="round" stroke-width="1.8"/>'},
  cfg:{title:'Configurações',icon:'<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8"/>'},
  daily:{title:'Daily',icon:'<rect x="2.5" y="3.5" width="11" height="10" rx="1.2"/><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5"/>'},
  chat:{title:'Chat do projeto',icon:'<path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.85-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" stroke-linejoin="round"/>'},
  conta:{title:'Conta e time',icon:'<path d="M4.6 11.8a2.6 2.6 0 0 1 .3-5.18 3.4 3.4 0 0 1 6.6.7 2.3 2.3 0 0 1-.4 4.55z" stroke-linejoin="round"/>'},
  agents:{title:'Meu time',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/>'},
  epic:{title:'Épico',icon:'<path d="M8 2.6l5.2 5.4L8 13.4 2.8 8z" stroke-linejoin="round"/><path d="M5.6 8l1.7 1.7 3.1-3.4"/>'},
  memoria:{title:'Memória',icon:'<path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.3 3.4A2 2 0 0 0 4.2 12 2 2 0 0 0 8 12.6V3.6A2 2 0 0 0 6 2.8zM10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.3 3.4 2 2 0 0 1-1.5 3.8A2 2 0 0 1 8 12.6" stroke-linejoin="round"/>'},
  mesa:{title:'Mesa',icon:'<rect x="2.5" y="7.4" width="11" height="2.6" rx=".8"/><circle cx="4.6" cy="4.4" r="1.3"/><circle cx="8" cy="3.8" r="1.3"/><circle cx="11.4" cy="4.4" r="1.3"/><path d="M4.4 10v3.2M11.6 10v3.2"/>'},
  uso:{title:'Uso',icon:'<path d="M2.5 13.5h11"/><rect x="3.5" y="8" width="2.2" height="4" rx=".5"/><rect x="6.9" y="5" width="2.2" height="7" rx=".5"/><rect x="10.3" y="2.5" width="2.2" height="9.5" rx=".5"/>'},
  piloto:{title:'Piloto automático',icon:'<path d="M8 2.2l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 10.6l-3.3 1.8.7-3.7-2.7-2.6 3.7-.5z" stroke-linejoin="round"/>'},
  pilotorun:{title:'Progresso do piloto',icon:'<path d="M2.5 13.5h11"/><path d="M3.5 10.5l3-3 2.4 2 3.6-4.5" stroke-linecap="round" stroke-linejoin="round"/>'},
  // "Começar por uma ideia" (59-ideia): conversa com a mesa + pesquisa + decisão → projeto — funciona sem projeto
  ideia:{title:'Ideia',icon:'<path d="M8 1.9a4.3 4.3 0 0 0-2.6 7.7c.5.4.8.9.8 1.5v.4h3.6v-.4c0-.6.3-1.1.8-1.5A4.3 4.3 0 0 0 8 1.9z" stroke-linejoin="round"/><path d="M6.3 13.2h3.4M6.9 14.6h2.2" stroke-linecap="round"/>'},
  env:{title:'Ambiente',icon:'<path d="M8 13.5c-2.5-1.6-5-3.9-5-6.7A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5 2.2c0 2.8-2.5 5.1-5 6.7z" stroke-linejoin="round"/>'},
};
const VIEW_OVERLAY={ memoria:'memOverlay', mesa:'mesaOverlay', orq:'orqOverlay', projetos:'projetosOverlay', nova:'ndOverlay', planner:'plannerOverlay', form:'ntOverlay', skills:'skOverlay', issues:'issuesOverlay', issuesbulk:'issuesBulkOverlay', prefs:'prefsOverlay', cfg:'cfgOverlay', daily:'dailyOverlay', chat:'pcOverlay', conta:'cloudOverlay', agents:'agOverlay', env:'envOverlay', task:'fwOverlay', web:'cvSplit', device:'cvSplit', doc:'cvSplit', cttask:'ctPageOverlay', epic:'epicOverlay', uso:'usoOverlay', piloto:'pilotoOverlay', pilotorun:'pilotoRunOverlay', ideia:'ideiaOverlay' };
let tabTaskId=null, tabTaskPath=null; // tarefa aberta na aba "task"
// Views de INSTÂNCIA MÚLTIPLA: cada aba guarda o próprio estado (nova, planner, form, orq)
// e o restaura ao voltar — dá pra ter duas "Montar conversando" abertas sem uma pisar na outra.
const MULTI_KINDS=new Set(['nova','planner','form','orq','piloto','ideia']);
// views únicas que guardam trabalho em andamento na própria tela: voltar pela ABA só mostra (não reabre —
// reabrir zerava a seleção de Issues e as edições não salvas de Agentes/Configurações); o menu/openTab recarrega
// (a aba Uso fica de fora: voltar pra ela chama openUso, que só relê se os dados tiverem mais de 1 min)
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
            form:()=>{ if(fresh||!window.ntShow){ if(fresh && typeof resetNewTask==='function') resetNewTask(); window.ntOpening=openNewTask(); } else window.ntShow(); }, // aba nova = formulário LIMPO (não herda a outra aba)
            skills:()=>openSkills(), issues:()=>openIssues(), issuesbulk:()=>openIssuesBulk(), prefs:()=>openPrefs(), memoria:()=>window.openMemoria&&window.openMemoria(), mesa:()=>window.openMesa&&window.openMesa(), uso:()=>window.openUso&&window.openUso(), piloto:()=>window.openPiloto&&window.openPiloto(), pilotorun:()=>window.openPilotoRun&&window.openPilotoRun(), ideia:()=>window.openIdeia&&window.openIdeia(fresh), cfg:()=>openCfg(), daily:()=>openDaily(), chat:()=>openPc(), env:()=>openEnv(),
            conta:()=>window.openCloud&&window.openCloud(), agents:()=>window.openAgents&&window.openAgents(),
            web:()=>{ if(window.cvShowView) window.cvShowView(tab); }, device:()=>{ if(window.cvShowView) window.cvShowView(tab); }, doc:()=>{ if(window.cvShowView) window.cvShowView(tab); },
            task:()=>{ if(tabTaskId==null) return; const path=(tab&&tab.path)||null;
              // demanda que está na TELA DIVIDIDA: a divisão inteira aparece (cada painel com o seu estado)
              if(tab && window.cvInSplit && window.cvInSplit(tab.id)){ window.cvShowView(tab); return; }
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
function activateTab(id){ const mvChanged=id!==activeTab; if(id!==activeTab) saveTabState(tabById(activeTab)); activeTab=id;
  // a demanda da aba ativa vira a "selecionada" (Central/grafo) e a barra lateral repinta o destaque (railHi, 25)
  { const at=tabById(id); if(at && at.taskId) selected=at.taskId; }
  renderTabs(); showActiveView(); if(typeof renderRail==='function') renderRail();
  if(mvChanged && typeof mvViewIn==='function' && tabById(id)){ const at=tabById(id); mvViewIn(at.kind!=='flow' ? $id((typeof cvViewTarget==='function' && cvViewTarget(at)) || VIEW_OVERLAY[at.kind]) : $id('flowPane')); } // F3: a tela nova entra
  if(typeof cvOnViewChange==='function') cvOnViewChange(); } // canvas: stream/webview reavaliam (sem laço)
// openTab(kind, opts): views únicas reaproveitam a aba; views múltiplas abrem uma NOVA aba,
// salvo opts.replace (a aba ativa de "Nova demanda" vira o método escolhido, mantendo o id)
// ou opts.reuse (função que escolhe uma aba já aberta do mesmo kind).
// @puro-rotas-inicio (F4 G1 — testado em app/tests/redesign-f4-g1.test.mjs)
// telas antigas → lugar novo (mesa-ia §5): o que era aba própria agora mora numa página com sub-navegação.
// Quem chama openTab('chat'|'memoria'|'agents'|'skills'|'prefs'|'daily'|'issuesbulk'|'team') continua funcionando.
const VIEW_ROUTES={ chat:['projeto','conversa'], memoria:['projeto','memoria'], agents:['projeto','agentes'], skills:['projeto','skills'],
  prefs:['projeto','regras'], disco:['projeto','disco'], daily:['flow','resumo'], issuesbulk:['issues','nova'], team:['time',null], kbd:['atalhos',null],
  // F4 (G2): Ideia, Mesa e Piloto viraram partes da Fábrica — as listas antigas vão pra Fábrica › Sessões; "novo projeto" → Nova sessão
  // (uma mesa/ideia ESPECÍFICA continua abrindo na própria aba: 65-fabrica fabRoute decide pelo id)
  mesas:['fabrica','sessoes'], ideias:['fabrica','sessoes'], novoprojeto:['fabrica','nova'], personas:['fabrica','personas'] };
function viewRoute(kind, opts){
  const r=VIEW_ROUTES[kind]; opts=Object.assign({}, opts||{});
  if(!r) return { kind, opts };
  if(r[1] && opts.sub==null) opts.sub=r[1];
  return { kind:r[0], opts, from:kind };
}
// @puro-rotas-fim
function openTab(kind, opts){
  { const r=viewRoute(kind, opts); kind=r.kind; opts=r.opts; if(r.from && opts.from==null) opts.from=r.from; }
  if(typeof auBlocksApp==='function' && typeof auOpen==='function' && typeof SB!=='undefined' && auBlocksApp(auOpen(), SB.sess())) return; // tela de entrada aberta sem sessão: nada abre por trás (bloqueador 03)
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
  if(kind==='flow'){ if(opts.sub==='resumo' && typeof centralOpenResumo==='function') centralOpenResumo(); activateTab('flow'); return; }
  let tab=null;
  if(MULTI_KINDS.has(kind)){
    const cur=tabById(activeTab);
    if(opts.replace && cur && MULTI_KINDS.has(cur.kind) && cur.id===activeTab){ tab=cur; tab.kind=kind; tab.title=(VIEW_META[kind]||{}).title||kind; tab.state=null; tab.fresh=true; }
    else if(opts.reuse){ tab=tabsOfKind(kind).find(t=>{ try{ return opts.reuse(t); }catch(_){ return false; } })||null; }
    if(!tab){ tab={id:kind+':'+(++tabSeq), kind, title:(VIEW_META[kind]||{}).title||kind, fresh:true, state:null}; TABS.push(tab); }
  } else {
    tab=tabById(kind); if(!tab){ tab={id:kind, kind, title:(VIEW_META[kind]||{}).title||kind}; TABS.push(tab); }
    tab.loaded=false; // aberto pelo menu/atalho: recarrega a tela
    if(opts.sub!=null) tab.sub=opts.sub; // seção pedida (Projeto › Memória, Issues › Nova issue…)
    tab.from=opts.from||null; // de qual tela antiga veio (ex.: 'mesas' → Fábrica › Sessões filtrada)
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
  // Agentes & Equipes com edição não salva: o X da aba passa pelo mesmo "descartar?" do cancelar (33 cancelAgents)
  if(kind==='agents' && typeof agDirty==='function' && agDirty() && typeof cancelAgents==='function'){ cancelAgents(); return; }
  // F4: a página Projeto tem rascunho (agentes ou convenções)? pergunta antes de fechar (68-casca: g1ProjLeaveOk)
  if(kind==='projeto' && typeof g1ProjLeaveOk==='function' && !closeTab.__projOk){ g1ProjLeaveOk(null).then(ok=>{ if(!ok) return; closeTab.__projOk=true; try{ closeTab(id); }finally{ closeTab.__projOk=false; } }); return; }
  // grupo de abas (58-canvas): a aba sai do grupo junto; se o grupo estava na tela, devolve quem fica (os painéis se rearranjam)
  const grpNext=(typeof cvOnTabClosed==='function') ? cvOnTabClosed(TABS[i]) : null;
  if(kind==='task' && typeof nvOnTaskTabClose==='function') nvOnTaskTabClose(TABS[i].taskId); // Prévia: o proxy da tarefa morre com a aba
  if(kind==='task' && typeof envOnTaskTabClose==='function') envOnTaskTabClose(TABS[i].taskId); // "Subir ambiente": o site da demanda morre com a aba
  if(kind==='form' && id===activeTab && typeof ntFormTabClosed==='function') ntFormTabClosed(); // o rascunho/link desta aba não vaza pra próxima criação
  TABS.splice(i,1);
  // esconde o overlay do kind se nenhuma OUTRA aba do mesmo kind sobrou
  // (overlay compartilhado — a tela dividida serve Navegador/Simulador/Documento e as demandas divididas — só some sem ninguém usando)
  { const ov=VIEW_OVERLAY[kind]; if(!TABS.some(t=>VIEW_OVERLAY[t.kind]===ov) && !(ov==='cvSplit' && typeof cvSplitShowing==='function' && cvSplitShowing())){ const o=$id(ov); if(o){ o.classList.remove('astab'); o.style.display='none'; } } }
  // fechou uma aba de FUNDO: a ativa continua como está (showActiveView restaurava nela o estado velho
  // guardado ao sair — ex.: o "Montar conversando" ativo perdia as mensagens mais recentes)
  if(grpNext && tabById(grpNext)){ activeTab=null; activateTab(grpNext); return; } // membro fechado: o resto do grupo continua na tela (sobrou 1 → aba normal)
  if(activeTab!==id){ renderTabs(); return; }
  activeTab=(TABS[i-1]||TABS[0]).id;
  renderTabs(); showActiveView(); if(typeof cvOnViewChange==='function') cvOnViewChange();
  if(typeof MULTI_KINDS!=='undefined' && MULTI_KINDS.has((tabById(activeTab)||{}).kind)) renderTabs(); // título vivo com o estado JÁ restaurado da aba que ficou
}
// R7: reordenar abas arrastando. A aba fixa (Central) fica sempre na frente; soltar sobre outra aba põe a
// arrastada no lugar dela. Devolve true quando mudou. Pura sobre TABS (testada em app/tests/central.test.mjs).
let tabDragId=null;
// entra DEPOIS do alvo? (arrastando pra direita, ou soltando sobre uma aba fixa) — o marcador e o tabMove usam a mesma regra
function tabDropAfter(fromId, toId){
  const from=TABS.findIndex(t=>t.id===fromId), to=TABS.findIndex(t=>t.id===toId);
  return from<to || !!(TABS[to]&&TABS[to].pin);
}
function tabMove(fromId, toId){
  const from=TABS.findIndex(t=>t.id===fromId), to=TABS.findIndex(t=>t.id===toId);
  if(from<0 || to<0 || from===to || TABS[from].pin) return false;
  const after=tabDropAfter(fromId, toId);
  const [t]=TABS.splice(from,1);
  let at=TABS.findIndex(x=>x.id===toId); if(after) at++;
  // nunca antes das fixas: sem outra aba livre (a arrastada era a única), o mínimo é depois de todas as fixas
  const firstFree=TABS.findIndex(x=>!x.pin), minAt=firstFree<0?TABS.length:firstFree;
  if(at<minAt) at=minAt;
  TABS.splice(at,0,t);
  return true;
}
// fecha uma aba passando pela guarda de edição não salva (X, botão do meio, Delete). Devolve true se fechou.
async function tabCloseGuarded(id){
  const t=tabById(id); if(!t || t.pin) return false;
  if(!await tabLeaveGuard(id, true)) return false;
  closeTab(id); return true;
}
// próxima/anterior aba (⌘⇧] / ⌘⇧[ e Ctrl+Tab / Ctrl+⇧Tab), em volta
function tabStepId(dir){ const i=TABS.findIndex(t=>t.id===activeTab); if(!TABS.length) return null; return TABS[((i<0?0:i)+dir+TABS.length)%TABS.length].id; }
// fecha a aba ATIVA desse kind (ou a última aberta) — usado pelos botões "fechar" das views
function closeTabOfKind(kind){ const cur=tabById(activeTab); const t=(cur&&cur.kind===kind)?cur:tabsOfKind(kind).slice(-1)[0]; if(t) closeTab(t.id); }
window.closeTabOfKind=closeTabOfKind;
function showActiveView(){
  const t=tabById(activeTab)||TABS[0];
  // tela dividida (58-canvas): uma demanda que está nela mostra a divisão (cvSplit), não a tela da demanda sozinha
  const target=t.kind==='flow'?null:((typeof cvViewTarget==='function' && cvViewTarget(t)) || VIEW_OVERLAY[t.kind]);
  // esconde as OUTRAS telas; a do destino fica como está (esconder e mostrar a mesma = piscada)
  const tgtEl=target?$id(target):null; // F4: seção que mora DENTRO da página (Projeto › Conversa…) não é escondida
  Object.keys(VIEW_OVERLAY).forEach(k=>{ const id=VIEW_OVERLAY[k]; if(id===target) return; const o=$id(id); if(o && tgtEl && tgtEl!==o && tgtEl.contains(o)) return; if(o && o.dataset.lock!=='1'){ o.classList.remove('astab'); if(o.style.display!=='none') o.style.display='none'; } });
  if(t.kind==='flow'){ if(typeof fwHeadDock==='function') fwHeadDock(); return; } // o quadro (.body) já aparece
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
  if(typeof fwHeadDock==='function') fwHeadDock();
}
let _updBtnNode=null; // o botão "atualizar" sobrevive aos re-renders da barra de abas (ver renderTabs)
function renderTabs(){
  const bar=$id('tabBar'); if(!bar) return;
  bar.style.display='flex'; bar.setAttribute('data-tauri-drag-region','');
  // título vivo das abas múltiplas (ex.: a demanda que está sendo montada)
  for(const t of TABS){ if(t.id===activeTab && MULTI_KINDS.has(t.kind) && !t.fresh){ // aba recém-aberta: os globais ainda são da aba anterior (o título dela vazava)
 const api=tabStateApi(t.kind); try{ const st=api&&api.get&&api.get(); if(st&&st._title) t.title=String(st._title).slice(0,28); else if(st&&st._title===''){ t.title=(VIEW_META[t.kind]||{}).title||t.kind; } }catch(_){ } } }
  // numera só as abas que ainda têm o título genérico ("Montar conversando 1, 2…")
  const counts={}; TABS.forEach(t=>{ if(t.title===((VIEW_META[t.kind]||{}).title||t.kind)) counts[t.kind]=(counts[t.kind]||0)+1; });
  const seen={};
  // o botão "atualizar" mora DENTRO da barra: tira ele antes do innerHTML e devolve depois (guardado em
  // _updBtnNode — antes o 2º render destruía o botão e o aviso de versão nova nunca aparecia).
  { const u=$id('updBtn'); if(u) _updBtnNode=u; if(_updBtnNode && bar.contains(_updBtnNode)) _updBtnNode.remove(); }
  // redesenho F1: o cabeçalho da tarefa pode estar DOCADO aqui (20-workspace fwHeadDock) — sai antes do innerHTML e
  // volta no fim (mesmo nó: ids, handlers e o ResizeObserver intactos)
  { const h=bar.querySelector('.fwhead'); if(h) h.remove(); }
  bar.innerHTML=`<button class="railtgl railtgl-main" id="railToggleMain" title="Expandir a barra lateral (⌘B)" aria-label="Expandir barra lateral"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M6.2 2.8v10.4" stroke-linecap="round"/></svg></button>`+'<span class="tablist" role="tablist" aria-label="abas abertas">'+((typeof cvStripItems==='function')?cvStripItems(TABS.map(t=>t.id), (typeof SPL!=='undefined')?SPL.ids:null):TABS.map(t=>({ id:t.id }))).map(it=>{
    // tela dividida = UMA aba-grupo com um segmento por membro (58-canvas, estilo grupo de abas do Chrome)
    if(it.group) return cvGroupTabHtml(it.group);
    const t=tabById(it.id); const on=t.id===activeTab; const base=(VIEW_META[t.kind]||{}).title||t.kind; if(t.title===base) seen[t.kind]=(seen[t.kind]||0)+1;
    const title=(MULTI_KINDS.has(t.kind)&&counts[t.kind]>1&&t.title===base)?`${base} ${seen[t.kind]}`:t.title;
    // R7: aba pelo teclado (role=tab, Tab chega, Enter abre, ←/→ passa, Delete/Backspace fecha), título inteiro no
    // tooltip (o texto corta em 28) e arrastável pra reordenar (a Central fica fixa na frente). O X é só pro mouse
    // (aria-hidden: controle dentro de role=tab não é permitido) — pelo teclado fecha com Delete.
    return `<span class="tab ${on?'on':''} ${t.pin?'pin':''}" data-tk="${escA(t.id)}" role="tab" tabindex="${on?0:-1}" aria-selected="${on}" title="${escA(title)}"${t.pin?'':' draggable="true" aria-keyshortcuts="Delete"'}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">${tabIcon(t.kind)}</svg><span class="tt">${esc(title)}</span>${t.pin?'':`<span class="x" data-xk="${escA(t.id)}" aria-hidden="true" title="fechar (⌘W)">${IC.x}</span>`}</span>`;
  }).join('')+'</span>'+`<span class="tabadd" id="tabAdd" role="button" tabindex="0" aria-haspopup="menu" aria-label="abrir: nova demanda, demanda, navegador, simulador ou documento" aria-keyshortcuts="Meta+N Control+N" title="abrir — nova demanda (⌘N), outra demanda, navegador, simulador ou documento&#10;arraste uma aba pra metade da tela pra dividir (⌘\\)&#10;? ou ⌘/ abre o painel de atalhos&#10;${escA(SHORTCUTS_HELP)}">+</span><span class="tabgrow" data-tauri-drag-region></span><span class="tabtools" id="tabTools"></span><span class="tabright" id="tabRight"></span>`;
  bar.querySelectorAll('[data-tk]').forEach(el=>{
    el.onclick=async e=>{ if(e.target.closest('[data-xk]')) return; const id=el.dataset.tk; if(!await tabLeaveGuard(id, false)) return; activateTab(id); };
    // botão do meio fecha a aba (como no navegador)
    // (mousedown do meio: sem isso o Windows/Linux liga o autoscroll ou cola a seleção)
    el.addEventListener('mousedown', e=>{ if(e.button===1) e.preventDefault(); });
    el.addEventListener('auxclick', e=>{ if(e.button!==1) return; e.preventDefault(); tabCloseGuarded(el.dataset.tk); });
    // botão direito: dividir à direita/esquerda, tirar da divisão (58-canvas)
    el.addEventListener('contextmenu', e=>{ if(typeof cvTabMenu!=='function') return; e.preventDefault(); cvTabMenu(el.dataset.tk, el, e); });
    el.onkeydown=e=>{
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); el.click(); }
      else if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); tabCloseGuarded(el.dataset.tk).then(ok=>{ if(ok){ const n=bar.querySelector('.tab.on'); if(n) n.focus(); } }); }
      else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){ e.preventDefault(); const l=[...bar.querySelectorAll('[data-tk],[data-tg]')], i=l.indexOf(el); const n=l[(i+(e.key==='ArrowRight'?1:-1)+l.length)%l.length]; if(n) n.focus(); }
    };
    if(el.getAttribute('draggable')==='true'){
      el.addEventListener('dragstart', e=>{ tabDragId=el.dataset.tk; el.classList.add('dragging'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', tabDragId); }catch(_){ } if(typeof cvTabDragStart==='function') cvTabDragStart(tabDragId); });
      el.addEventListener('dragend', ()=>{ tabDragId=null; el.classList.remove('dragging'); bar.querySelectorAll('.tab.dropto,.tab.dropafter').forEach(x=>x.classList.remove('dropto','dropafter')); if(typeof cvTabDragEnd==='function') cvTabDragEnd(); });
    }
    // marca o lado certo: arrastando pra direita (ou sobre a fixa) entra DEPOIS do alvo
    el.addEventListener('dragover', e=>{ if(!tabDragId || tabDragId===el.dataset.tk) return; e.preventDefault(); const after=tabDropAfter(tabDragId, el.dataset.tk); el.classList.toggle('dropafter', after); el.classList.toggle('dropto', !after); });
    el.addEventListener('dragleave', ()=>el.classList.remove('dropto','dropafter'));
    el.addEventListener('drop', e=>{ if(!tabDragId) return; e.preventDefault(); const from=tabDragId; tabDragId=null;
      // segmento do grupo solto numa aba da barra: sai do grupo e fica ali (58-canvas)
      if(typeof cvGroupDrop==='function' && cvGroupDrop(SPL.ids, from, false)==='eject'){ if(typeof cvTabDragEnd==='function') cvTabDragEnd(); cvGroupEject(from, el.dataset.tk); return; }
      if(tabMove(from, el.dataset.tk)) renderTabs(); });
  });
  { const g=bar.querySelector('[data-tg]'); if(g && typeof cvWireGroup==='function') cvWireGroup(g, bar); }
  // E6 (bug #9): o X da aba perguntava nada e jogava fora a edição não salva do arquivo (só ⌘W e o botão fechar perguntavam)
  bar.querySelectorAll('[data-xk]').forEach(el=>el.onclick=e=>{ e.stopPropagation(); tabCloseGuarded(el.dataset.xk); });
  // "+" do topo: menu simples (Nova demanda · Abrir demanda · Navegador · Simulador · Documento) — 58-canvas; ⌘N segue direto
  const add=$id('tabAdd'); if(add){ const go=()=>{ if(typeof cvPlusMenu==='function') cvPlusMenu(add); else openTab('nova'); }; add.onclick=go; add.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } }; } // R8 a11y: o + era um span fora do Tab
  { const m=$id('railToggleMain'); if(m) m.onclick=()=>setRailCollapsed(false); }
  // o botão "atualizar" (versão nova) mora na barra de abas, à direita
  // sem #tabRight o nó continua guardado em _updBtnNode e volta no próximo render (nunca se perde)
  { const u=_updBtnNode||$id('updBtn'), slot=$id('tabRight'); if(u&&slot&&u.parentElement!==slot) slot.appendChild(u); }
  if(typeof fwHeadDock==='function') fwHeadDock(); // faixa 1 = abas + modos + ação da tarefa (ou o cabeçalho volta pro .fw)
  requestAnimationFrame(syncChromeH);
  tabsFit();
  if(typeof mvTabsPainted==='function') mvTabsPainted(bar); // F3: aba nova desliza pra dentro (só depois de um clique)
}
// R7: barra de abas lotada → modo compacto (menos respiro; o X das abas de fundo só no hover, como no navegador) e
// rola até a ativa. Recalcula no render e ao redimensionar a janela.
function tabsFit(){
  const bar=$id('tabBar'); if(!bar) return;
  // mede SEMPRE no tamanho normal e usa folga pra não ficar piscando no limite ao redimensionar:
  // entra no compacto quando transborda; só sai com 32px sobrando (o .tabgrow é o espaço livre)
  const was=bar.classList.contains('crowded'); bar.classList.remove('crowded');
  const over=bar.scrollWidth-bar.clientWidth, g=bar.querySelector('.tabgrow');
  const slack=over>1 ? -over : ((g?g.offsetWidth:0)-12);
  bar.classList.toggle('crowded', was ? slack<32 : slack<0);
  const on=bar.querySelector('.tab.on');
  if(on && bar.scrollWidth>bar.clientWidth+1) try{ on.scrollIntoView({ block:'nearest', inline:'nearest' }); }catch(_){ }
}
{ let tm=null; window.addEventListener('resize', ()=>{ clearTimeout(tm); tm=setTimeout(tabsFit, 150); }); }
$id('bdClose').onclick=()=>bdClosePlan();
$id('bdCancel').onclick=()=>bdClosePlan();
$id('bdOverlay').addEventListener('click',e=>{ if(e.target.id==='bdOverlay') bdClosePlan(); });
$id('cfgClose').onclick=cfgHide;
// Ajustes nunca fecha por clique fora (F4: nada fecha a aba; ⌘W fecha)

// Tour de 5 passos e coach marks → aba "Primeiros passos" (67-ajustes.js: primeirosPassosOpen, ppMaybeStart). F4 · G3.
function openOnboarding(){ if(typeof primeirosPassosOpen==='function') primeirosPassosOpen(); }

// ---------- atalhos ----------
// ⌘J/⌘, abrem como ABA (igual à barra lateral — antes viravam modal flutuante), ⌘W fecha a aba ativa,
// ⌘1…⌘8 vão pra aba N e ⌘9 pra última (como no navegador). A lista fica no tooltip do "+" da barra de abas.
// R8 a11y: UMA lista (tecla, o que faz) — o tooltip do "+" e o painel de atalhos (tecla ? ou ⌘/) saem daqui.
// Faltavam: ⌘B dentro da tarefa, Esc, Enter/⇧Enter no chat, ⌘Enter nos campos de demanda, ←/→ nas abas e nos prints.
// @puro-atalhos-inicio (testado em app/tests/acessibilidade.test.mjs)
// tecla = lista de teclas; 'ou' entre elas é texto (não vira tecla desenhada)
const SHORTCUTS=[
  ['Abas e navegação', [
    [['⌘N'],'nova demanda (sempre abre uma aba nova)'],
    [['⌘K'],'buscar na página aberta (Central, Issues, Skills…)'],
    [['⌘J'],'conversa do projeto'],
    [['⌘,'],'ajustes'],
    [['⌘O'],'abrir pasta de projeto'],
    [['⌘B'],'recolher/mostrar a barra lateral (numa tarefa: a lista de arquivos)'],
    [['⌘W'],'fechar a aba atual'],
    [['⌘1…⌘9'],'ir pra aba 1…8 (⌘9 = última) — com a tela dividida, ⌘1…⌘3 vão pro painel 1…3'],
    [['⌘\\'],'dividir a tela: a aba ativa + outra lado a lado (até 3)'],
    [['⌘⇧[','⌘⇧]'],'aba anterior / próxima'],
    [['Ctrl+Tab','Ctrl+⇧Tab'],'próxima / anterior aba'],
    [['←','→'],'com o foco na barra de abas: passar de aba'],
    [['Delete'],'fechar a aba em foco'],
  ]],
  ['Escrever e responder', [
    [['Enter'],'enviar a mensagem no chat'],
    [['⇧Enter'],'quebrar linha no chat'],
    [['⌘Enter'],'continuar/iniciar nos campos de nova demanda'],
    [['Esc'],'fechar menu, folha ou detalhes — nunca fecha a aba (quem fecha é ⌘W; no terminal, Esc é da IA)'],
  ]],
  ['Provas e janelas', [
    [['←','→'],'print anterior / próximo na visualização de provas'],
    [['Tab','⇧Tab'],'andar pelos botões (numa janela, o foco fica dentro dela)'],
    [['?','ou','⌘/'],'mostrar estes atalhos'],
  ]],
];
const SHORTCUT_WORDS=new Set(['ou','e']);
function shortcutsFlat(list){ return (list||[]).flatMap(g=>g[1]); }
function shortcutKeysText(keys){ return (keys||[]).join(' '); }
function shortcutsHelpText(list){ return 'Atalhos: '+shortcutsFlat(list).map(([k,d])=>shortcutKeysText(k)+' '+d).join(' · ')+' · arraste uma aba pra reordenar'; }
// @puro-atalhos-fim
const SHORTCUTS_HELP=shortcutsHelpText(SHORTCUTS);
document.addEventListener('keydown', async e=>{
  if(!(e.metaKey||e.ctrlKey) || e.altKey) return;
  const k=(e.key||'').toLowerCase();
  try{ window.__sfLastKey={ k, at:Date.now() }; if(typeof SF_PANE!=='undefined' && SF_PANE) window.parent.__sfLastKey=window.__sfLastKey; }catch(_){ } // o mesmo atalho vindo do menu do app (58-canvas: cvMenuKey) não age 2×
  // tela dividida (58-canvas): ⌘\ divide, ⌘1..3 foca o painel — dentro de um painel, o atalho vai pra janela principal
  if(typeof cvShortcut==='function' && cvShortcut(e)) return;
  if(typeof SF_PANE!=='undefined' && SF_PANE) return; // abas são da janela principal
  if(k==='j' && !e.shiftKey){ e.preventDefault(); openTab('projeto',{ sub:'conversa' }); }
  else if(k===',' && !e.shiftKey){ e.preventDefault(); if(typeof ajustesOpen==='function') ajustesOpen(); else openTab('cfg'); }
  else if(k==='b' && !e.shiftKey){ e.preventDefault(); setRailCollapsed(!railIsCol()); }
  else if(k==='w' && !e.shiftKey){ e.preventDefault(); const t=tabById((typeof cvGroupMember==='function' && cvGroupMember()) || activeTab); if(!t || t.pin) return; // grupo na tela: fecha o membro em foco
    // aba de tarefa com o editor aberto: pergunta antes de descartar o que não foi salvo (igual ao "fechar")
    if(t.kind==='task' && typeof fwLeaveEditor==='function' && !await fwLeaveEditor()) return;
    if(tabById(t.id)) closeTab(t.id); }
  // R7: ⌘1…⌘9 passa pela MESMA guarda do clique na aba — antes ia direto e jogava fora a edição não salva do arquivo
  else if(/^[1-9]$/.test(k) && !e.shiftKey){ e.preventDefault(); const i=k==='9'?TABS.length-1:(+k-1); const t=TABS[i]; if(t && t.id!==activeTab && await tabLeaveGuard(t.id, false)) activateTab(t.id); }
  // pela TECLA produzida (e.key), não pela posição física (e.code): no ABNT2 os colchetes ficam em outro lugar
  else if((e.shiftKey && ['[',']','{','}'].includes(e.key)) || (e.ctrlKey && k==='tab')){
    e.preventDefault(); const dir=(e.key==='['||e.key==='{'||(k==='tab'&&e.shiftKey))?-1:1; const id=tabStepId(dir);
    if(id && id!==activeTab && await tabLeaveGuard(id, false)) activateTab(id); }
});

function eventsOf(taskId){ return state.events.filter(e=>e.taskId===taskId); }
// tamanho da tarefa (fonte única de toda tela). Integrada com PR: o número do PR no GitHub manda (o diff local podia
// contar o avanço da main: "+132189 −3107 · 924 arquivos") — o Rust também grava o do PR no diffstat
function diffOf(taskId){ const d=state.diffs.find(x=>x.taskId===taskId); const pr=(typeof prCache!=='undefined')?prCache[taskId]:null; return diffPick(d, pr, taskId); }
function diffPick(d, pr, taskId){ if(pr && pr.exists && String(pr.state||'').toUpperCase()==='MERGED' && (+pr.changedFiles)>0) return { taskId:(d&&d.taskId)||taskId, additions:+pr.additions||0, deletions:+pr.deletions||0, files:+pr.changedFiles, src:'pr' }; return d; }
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

