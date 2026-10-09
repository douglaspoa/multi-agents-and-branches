// Starfork — 74-time-ativo: TIME ATIVO, fonte única (bug do dono 09/10: líder em 3 times via só um chip fixo
// "Time · X" e não tinha como alternar; a troca morava escondida em Ajustes › Conta e num <select> só da Central).
//   teamActiveList()  → os times que a pessoa enxerga: os dela (líder/membro) e, pra owner/admin, todos os da org
//   teamActive()      → o time ativo ({ id, name, role, n }) — o mesmo `sb:team` de sempre (cloudTeamId)
//   teamActiveSet(id) → troca: grava (lembrado POR PESSOA), limpa o que era do time velho e redesenha Time, Central
//                       (Do time/Minhas), Entregas, quadro, Issues (o painel é por time) e Nova demanda/épico — sem
//                       recarregar o app
//   teamPickHtml(o)   → o seletor (botão + menu por teclado) ou, com 1 time só, o chip simples. Nunca mostra id.
// Também mora aqui:
//   Minhas de TODOS os times (taMineFetch/caMineSrc): "Com você no time" e "Livres nos seus times" juntam os times em
//   que a pessoa está (limitação registrada no #145), com a etiqueta do time em cada linha quando ela tem mais de um.
//   Período do quadro (perAbertoOuNoPeriodo): o que está EM ABERTO aparece sempre (fila de trabalho não some pelo
//   período); concluída/cancelada só se mexeu no período. O número da aba conta o MESMO conjunto, e quando o total é
//   maior o texto diz ("4 de 129 · em aberto e concluídas nos últimos 7 dias").

// @puro-ta-inicio (testado em app/tests/time-ativo.test.mjs)
const TA_ROLE={ lead:'líder', member:'membro', admin:'admin da org' };
// cd = cloudData ({ teams, teamMembers, meRole }); me = uid. Membro comum só vê os times dele (a RLS já garante);
// owner/admin vê todos os da org — nos que não é membro, o papel é "admin da org". Os meus primeiro, depois A→Z.
function taTeamsOf(cd, me){
  if(!cd || !Array.isArray(cd.teams)) return [];
  const tm=cd.teamMembers||{}, admin=cd.meRole==='owner'||cd.meRole==='admin';
  return cd.teams.filter(t=>t && t.id).map(t=>{
    const ms=tm[t.id]||[], mine=me?ms.find(m=>m.user_id===me):null;
    return { id:t.id, name:String(t.name||'').trim()||'time sem nome', role:mine?(mine.role==='lead'?'lead':'member'):(admin?'admin':''), n:ms.length };
  }).filter(t=>t.role).sort((a,b)=>((a.role==='admin')-(b.role==='admin')) || a.name.localeCompare(b.name,'pt-BR'));
}
function taRoleLabel(role){ return TA_ROLE[role]||''; }
// "líder · 4 pessoas" (a contagem curta do menu)
function taShort(t){ return t?[taRoleLabel(t.role), t.n+' '+(t.n===1?'pessoa':'pessoas')].filter(Boolean).join(' · '):''; }
// os times em que EU estou (líder ou membro) — "Minhas" junta estes
function taMyTeamIds(cd, me){ const tm=(cd&&cd.teamMembers)||{}; return Object.keys(tm).filter(tid=>(tm[tid]||[]).some(m=>m.user_id===me)).sort(); }
// período do quadro: em aberto sempre; concluída (fn.delivered) ou fora (cancelada/encerrada, fn.fora) só se a
// modificação (fn.mod) cai no período r = { from, to } (to exclusivo)
function perAbertoOuNoPeriodo(list, r, fn){
  return (list||[]).filter(t=>{ if(!t) return false; const fim=fn.delivered(t) || (fn.fora?fn.fora(t):false); if(!fim) return true;
    const ms=fn.mod(t); return !!ms && ms>=r.from && ms<r.to; });
}
// "nos últimos 7 dias" / "hoje" / "neste mês" / "em 05/10–09/10" — o período no meio de uma frase
function perNoTx(p, label){
  const k=p&&typeof p==='object'?p.key:p;
  return ({ hoje:'hoje', ontem:'ontem', '7d':'nos últimos 7 dias', '30d':'nos últimos 30 dias', mes:'neste mês' })[k] || ('em '+String(label||'').trim());
}
// o texto da diferença entre o total e o que a tela mostra ('' quando batem)
function perContaTx(total, shown, noTx, what){
  if(!(total>shown)) return '';
  return shown+' de '+total+' · '+(what||'em aberto e concluídas')+' '+noTx;
}
// @puro-ta-fim

if(typeof IC!=='undefined' && !IC.cal) IC.cal='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="2.5" y="3.3" width="11" height="10" rx="1.6"/><path d="M2.5 6.6h11M5.6 2v2.4M10.4 2v2.4" stroke-linecap="round"/></svg>';

function taTabOn(k){ try{ return typeof g1TabOn==='function' && g1TabOn(k); }catch(_){ return false; } }
function taIssuesOpen(){ const o=typeof $id==='function'?$id('issuesOverlay'):null; return !!(o && o.style.display && o.style.display!=='none'); }
function teamActiveList(){ try{ return taTeamsOf(typeof cloudData!=='undefined'?cloudData:null, cloudUserId()); }catch(_){ return []; } }
function teamActive(){ const id=cloudTeamId(); return teamActiveList().find(t=>t.id===id)||null; }

// ---- trocar o time ativo ----
function teamActiveSet(tid, o){
  o=o||{};
  const t=teamActiveList().find(x=>x.id===tid);
  if(!t || tid===cloudTeamId()) return false;
  const me=cloudUserId();
  lsSet('sb:team', tid); if(me && typeof userKey==='function') lsSet(userKey('sb:team', me), tid); // lembrado por pessoa (40-conta-escopo devolve na troca de conta)
  try{ if(cloudData) cloudData.members=(cloudData.teamMembers||{})[tid]||[]; }catch(_){ }
  // o que era do time velho: dados, caches e filtros que apontam pra épico/pessoa/projeto dele
  try{ teamTasks=null; teamFetchedAt=0; teamEpics=[]; teamActivity=[]; teamPaintSig=''; window._timeSum=null; }catch(_){ }
  try{ if(typeof CA!=='undefined'){ CA.last=null; CA.tid=''; CA.err=null; CA.errAt=0; CA.open={}; } }catch(_){ }
  try{ if(typeof ctSent!=='undefined') ctSent={ rows:[], sig:'' }; }catch(_){ }
  try{ if(typeof epQueue!=='undefined' && epQueue){ epQueue.rows=[]; epQueue.at=0; } }catch(_){ }
  try{ if(typeof entProvas!=='undefined') entProvas={ key:'', m:null, arts:null, busy:false, p:null }; }catch(_){ }
  try{ lsSet('tmEpic',''); lsSet('tmDev','');
    if(typeof entFiltros==='function') lsSet('tmEntF', JSON.stringify({ ...entFiltros(), who:'', epic:'' }));
    if(typeof caFiltros==='function' && me) lsSet(userKey('ca:f', me), JSON.stringify({ ...caFiltros(), proj:'', who:'' }));
    if(typeof flowEpic!=='undefined' && flowEpic!=='all'){ flowEpic='all'; if(typeof flowSetF==='function') flowSetF('flowEpic','all'); }
    if(typeof ntWho!=='undefined') ntWho=''; if(typeof plWho!=='undefined') plWho='';
  }catch(_){ }
  // painel de Issues: a conexão é POR TIME (issue_trackers.team_id) — relê a do time novo
  try{ if(typeof trkLoad==='function'){ if(typeof trkIssues!=='undefined'){ trkIssues=[]; trkIssuesAt=0; trkSel=null; trkErr=''; if(typeof trkIdxMemo!=='undefined') trkIdxMemo=null; if(taIssuesOpen()) trkBusy='load'; }
    trkLoad(true).then(()=>{ if(cloudTeamId()!==tid) return; // duas trocas seguidas: só a última pinta
      if(taIssuesOpen() && typeof issRender==='function'){ trkBusy=''; if(trkView!=='nova' || !trkReady()) trkView=trkReady()?'board':'conn'; issRender(); if(trkView==='board' && typeof trkReload==='function') trkReload(); } }).catch(()=>{ trkBusy=''; if(taIssuesOpen() && typeof issRender==='function') issRender(); }); } }catch(_){ }
  TA.mine=null; TA.at=0;
  taRepaint();
  try{ if(typeof teamFetch==='function') teamFetch(true).then(taRepaint, ()=>taRepaint()); }catch(_){ }
  if(!o.quiet && typeof toast==='function') toast('Time ativo: '+t.name+'. Time, Central, Entregas, Issues e “Mandar pro time” agora mostram este time.','ok');
  return true;
}
// redesenha TUDO que depende do time (cada tela se protege sozinha se não estiver aberta)
function taRepaint(){
  try{ if(typeof meSync==='function') meSync(); }catch(_){ }
  try{ if(typeof cloudBtnSync==='function') cloudBtnSync(); }catch(_){ }
  try{ if(typeof timeHeadPaint==='function') timeHeadPaint(); }catch(_){ }
  try{ if(typeof renderTeamBoard==='function'){ teamPaintSig=''; renderTeamBoard(); } }catch(e){ console.warn('time ativo: Time', e); }
  try{ if(typeof caRerender==='function') caRerender(); else { lastSig=''; if(typeof renderFlow==='function') renderFlow(); } }catch(e){ console.warn('time ativo: Central', e); }
  try{ if(typeof ntShareSync==='function' && $id('ntShareRow')) ntShareSync(); }catch(_){ }
  try{ if(typeof renderPlanner==='function' && taTabOn('nova')) renderPlanner(); }catch(_){ }
  try{ if(taIssuesOpen() && typeof issRender==='function' && typeof trk!=='undefined' && trk) issRender(); }catch(_){ }
}

// ---- o seletor (chip quando há 1 time só) ----
// o = { ctx:'time'|'central'|'nova'|'plan' (onde mora — o foco volta pro mesmo lugar), prefix:true (mostra "Time · ") }
function teamPickHtml(o){
  o=o||{}; const L=teamActiveList(), cur=teamActive(); if(!cur) return '';
  const lbl=(o.prefix===false?'':'Time · ')+cur.name;
  if(L.length<2) return `<span class="pgh-scope tapick-one" title="${escA('o time desta página — '+taShort(cur))}">${IC.team||''}${esc(lbl)}</span>`;
  return `<button type="button" class="pgh-scope tapick" data-tapick="${escA(o.ctx||'')}" aria-haspopup="menu" aria-expanded="false" aria-label="${escA('time ativo: '+cur.name+' — trocar de time')}" title="trocar o time ativo — vale pro Time, Central, Entregas, Issues e Mandar pro time">${IC.team||''}<span class="tapick-n">${esc(lbl)}</span><span class="tapick-ch" aria-hidden="true">${IC.chevD||''}</span></button>`;
}
function teamPickOpen(anchor){
  const old=$id('taMenu'); if(old){ const was=old.__anchor===anchor; menuClose(old); if(was) return; }
  const L=teamActiveList(), cur=cloudTeamId(), ctx=anchor.dataset.tapick||'';
  const pop=document.createElement('div'); pop.id='taMenu'; pop.className='kb-pop ta-pop'; pop.__anchor=anchor;
  pop.setAttribute('aria-label','time ativo');
  pop.innerHTML=`<div class="ta-h" aria-hidden="true">Time ativo</div>`+L.map(t=>`<button type="button" role="menuitemradio" aria-checked="${t.id===cur}" class="ta-it${t.id===cur?' on':''}" data-taid="${escA(t.id)}"><span class="ta-ck" aria-hidden="true">${t.id===cur?(IC.check||''):''}</span><span class="ta-tx"><span class="ta-nm">${esc(t.name)}</span><span class="ta-meta">${esc(taShort(t))}</span></span></button>`).join('')
    +`<div class="ta-foot">vale pro Time, Central, Entregas, Issues e “Mandar pro time”</div>`;
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.max(10, Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6))+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.left))+'px';
  menuWire(pop, anchor);
  anchor.setAttribute('aria-expanded','true');
  const close0=pop.__close; pop.__close=()=>{ close0(); anchor.setAttribute('aria-expanded','false'); };
  { const on=pop.querySelector('.ta-it.on'); if(on) on.focus({ preventScroll:true }); }
  pop.querySelectorAll('[data-taid]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); const id=b.dataset.taid; menuClose(pop);
    taRefocusArm(ctx); if(id!==cloudTeamId()) teamActiveSet(id); taRefocus(); }; });
}
// o foco volta pro seletor depois da troca — e continua nele enquanto as telas redesenham (a busca do time novo chega
// depois e troca o cabeçalho de novo); para assim que a pessoa foca outra coisa ou em 4 s
let taFocusObs=null;
function taRefocusArm(ctx){
  TA.refocus={ ctx, until:Date.now()+4000 };
  if(typeof MutationObserver==='undefined') return;
  if(!taFocusObs) taFocusObs=new MutationObserver(()=>taRefocus());
  taFocusObs.observe(document.body, { childList:true, subtree:true });
  setTimeout(()=>{ if(TA.refocus && Date.now()>=TA.refocus.until){ TA.refocus=null; taFocusObs.disconnect(); } }, 4100);
}
function taRefocus(){
  const r=TA.refocus; if(!r) return;
  const a=document.activeElement, stop=()=>{ TA.refocus=null; if(taFocusObs) taFocusObs.disconnect(); };
  if(Date.now()>r.until) return stop();
  if(a && a!==document.body && !(a.closest && a.closest('[data-tapick],#taMenu'))) return stop(); // a pessoa já foi pra outro lugar
  const n=document.querySelector(`[data-tapick="${CSS.escape(r.ctx)}"]`);
  if(n && n.offsetParent && a!==n) n.focus({ preventScroll:true });
}
document.addEventListener('click', e=>{ const b=e.target.closest && e.target.closest('[data-tapick]'); if(!b) return; e.preventDefault(); e.stopPropagation(); teamPickOpen(b); });
document.addEventListener('keydown', e=>{ const b=e.target.closest && e.target.closest('[data-tapick]'); if(!b || e.key!=='ArrowDown') return; e.preventDefault(); if(!$id('taMenu')) teamPickOpen(b); });

// ---- Minhas: as tarefas de TODOS os meus times ----
const TA={ mine:null, at:0, busy:false, err:null, key:'', proj:{}, eps:[] };
function taMineTeams(){ try{ return taMyTeamIds(cloudData, cloudUserId()); }catch(_){ return []; } }
function taMineStale(){ TA.at=0; }
function taMineFetch(force){
  const ids=taMineTeams(); if(ids.length<2 || !SB.sess()) return; // 1 time: o teamFetch já traz tudo
  const key=cloudUserId()+'|'+ids.join(',');
  if(TA.key!==key){ TA.mine=null; TA.at=0; TA.key=key; }
  if(TA.busy || (!force && Date.now()-TA.at<20000)) return;
  TA.busy=true;
  const inq='team_id=in.('+ids.map(i=>'"'+i+'"').join(',')+')';
  Promise.all([ sbGet('tasks?select=*&'+inq+'&order=updated_at.desc&limit=600'), sbGet('projects?select=id,name,repo_remote,team_id&'+inq).catch(()=>[]),
    sbGet('epics?select=id,name,status,team_id&'+inq+'&status=neq.archived').catch(()=>[]) ])
    .then(([ts, ps, es])=>{ if(TA.key!==key) return; TA.mine=ts||[]; TA.proj={}; (ps||[]).forEach(p=>{ TA.proj[p.id]=p; if(typeof teamProj!=='undefined' && !teamProj[p.id]) teamProj[p.id]=p; });
      TA.eps=es||[]; TA.err=null; TA.at=Date.now();
      if(typeof personEnsure==='function') personEnsure([...new Set(TA.mine.flatMap(t=>[t.assignee, t.created_by]).filter(Boolean))]).catch(()=>{});
      if(typeof caRerender==='function') caRerender(); })
    .catch(e=>{ TA.err=e; TA.at=Date.now(); })
    .finally(()=>{ TA.busy=false; });
}
// os projetos dos meus outros times entram no teamProj (o teamFetch zera e recompõe só o do time ativo)
function taMineProj(){ return TA.proj||{}; }
// tarefas pra "Minhas": as do teamFetch (mais frescas pro time ativo) + as dos outros times meus.
// Memo pela foto (base + TA.mine): a Central chama isto várias vezes por pintura (cabeçalho, seções, uma vez por linha
// no "Com o time") — junta uma vez só
let taMineMemo={ base:null, mine:null, out:null };
function taMerge(base, mine){ const seen=new Set((base||[]).map(t=>t.id)); return (base||[]).concat((mine||[]).filter(t=>!seen.has(t.id))); }
function caMineSrc(){
  const base=(typeof caSrc==='function'?caSrc():null);
  if(taMineTeams().length<2) return base;
  taMineFetch();
  if(!TA.mine) return base;
  if(taMineMemo.base!==base || taMineMemo.mine!==TA.mine) taMineMemo={ base, mine:TA.mine, out:taMerge(base, TA.mine) };
  return taMineMemo.out;
}
// a busca dos outros times falhou: a Minhas diz que a lista pode estar incompleta (nunca some calada)
function taMineErr(){ return !!(TA.err && taMineTeams().length>1); }
function taMultiTeam(){ return taMineTeams().length>1; }
function taEpicName(id){ const e=((typeof teamEpics!=='undefined'&&teamEpics)||[]).concat(TA.eps||[]).find(x=>x.id===id); return e?e.name:''; }

window.teamActiveList=teamActiveList; window.teamActive=teamActive; window.teamActiveSet=teamActiveSet; window.teamPickHtml=teamPickHtml;
window.teamPickOpen=teamPickOpen; window.caMineSrc=caMineSrc; window.taMultiTeam=taMultiTeam; window.taMineStale=taMineStale; window.taMineErr=taMineErr; window.perAbertoOuNoPeriodo=perAbertoOuNoPeriodo;
