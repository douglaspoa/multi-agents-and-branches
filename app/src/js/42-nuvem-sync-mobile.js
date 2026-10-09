// Starfork — 42-nuvem-sync-mobile
/* ============================================================================
   F2 — TAREFAS COMPARTILHADAS: o "cartão" da tarefa vive no time (Supabase);
   o trabalho (worktree, stream do agente) vive na máquina de quem assumiu.
   - criar: "realizar eu mesmo" (cartão reservado) × "compartilhar" (backlog)
   - backlog do time: ver spec, editar, assumir & iniciar, remover
   - sync: status/etapa/custo/branch/PR/provas do cartão, a cada 6s
   ========================================================================= */
function setView(v){ const b=document.querySelector('#viewSeg button[data-v="'+v+'"]'); if(b) b.click(); }
// tmap/feedPos: JSON do localStorage parseado UMA vez por mudança (antes: JSON.parse a cada chamada,
// inclusive dentro de .find por tarefa). Quem altera sempre grava de volta (tmapSet/feedPosSet).
// @tmap-inicio
// `key` pode ser função: as chaves da nuvem são POR USUÁRIO (40-conta-escopo: userKey) — trocar de conta troca o mapa.
function lsJsonMemo(key){
  let raw=null, at=null, obj={};
  return ()=>{ const k=typeof key==='function'?key():key; const r=lsGet(k)||'{}'; if(r!==raw || k!==at){ raw=r; at=k; try{ obj=JSON.parse(r)||{}; }catch(_){ obj={}; } } return obj; };
}
// mapa tarefa local → cartão da nuvem DA CONTA LOGADA (nunca o de outra conta: o cartão dela recusa por RLS)
const tmapKey=()=>userKey('sb:tmap', cloudUserId());
const tmap=lsJsonMemo(tmapKey);
function tmapSet(localId, cloudId){ const m={ ...tmap() }; m[localId]=cloudId; lsSet(tmapKey(), JSON.stringify(m)); }
// @tmap-fim
// ---- ticks da nuvem: UM laço por tick, sem sobreposição ----
// setInterval empilhava voltas quando a rede demorava (volta de 30s num intervalo de 7s = 4–5 voltas
// concorrentes → posts e pushes duplicados). Aqui a próxima volta só é agendada quando a atual termina;
// com a janela escondida o ritmo cai (×3, mín. 15s) — o celular continua atendido, só mais devagar.
// `ms` pode ser função (ritmo adaptativo). Volta presa > 2 min libera a trava (rede morta não congela o laço).
const TICKS={};
function tickLoop(name, fn, ms, firstMs){
  const L=TICKS[name]={ busy:false, timer:0 };
  const per=()=>{ const v=typeof ms==='function'?ms():ms; return document.hidden?Math.max(v*3,15000):v; };
  L.run=async()=>{
    if(L.busy) return; L.busy=true; clearTimeout(L.timer);
    try{ await Promise.race([ Promise.resolve().then(fn), new Promise(r=>setTimeout(r,120000)) ]); }
    catch(e){ tickErr(name,e); }
    finally{ L.busy=false; clearTimeout(L.timer); L.timer=setTimeout(L.run, per()); }
  };
  L.timer=setTimeout(L.run, firstMs==null?per():firstMs);
}
// janela voltou a aparecer: adianta as voltas (não espera o ritmo lento de fundo)
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden) return;
  let i=0; for(const k in TICKS){ const L=TICKS[k]; if(!L.busy){ clearTimeout(L.timer); L.timer=setTimeout(L.run, 300+(i++)*250); } }
});
// tarefas do PROJETO ABERTO com cartão, das mais novas pras mais antigas (state.tasks vem por created_at).
// live=true: só as que ainda recebem ação do celular (fora merged/done/aborted/rascunho/finalizada).
// Antes os ticks usavam o tmap inteiro (toda tarefa de todo projeto, pra sempre) e `ids.slice(0,40)`
// pegava as 40 MAIS ANTIGAS — intenção do celular em tarefa nova era ignorada.
const CLOUD_ENDED=new Set(['merged','done','aborted','draft']);
function cloudTaskIds(m, n, live){
  const out=[]; const ts=state.tasks||[];
  for(let i=ts.length-1; i>=0 && out.length<n; i--){ const t=ts[i];
    if(m[t.id] && (!live || (t.flag!=='closed' && !CLOUD_ENDED.has(t.status)))) out.push(t.id); }
  return out;
}
const pgIn=ids=>'('+ids.map(x=>'"'+x+'"').join(',')+')';
function agoTx(iso){ const s=(Date.now()-new Date(iso).getTime())/1000; if(!(s>=0)) return ''; if(s<60) return 'agora'; if(s<3600) return Math.floor(s/60)+'min'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
// nome PT do status = o MESMO de toda a app (00-util: STATUS_META/stLabel). Mantido como objeto porque
// outras telas leem CT_ST_PT[st] direto; agora é só um espelho do STATUS_META.
const CT_ST_PT=Object.fromEntries(Object.keys(STATUS_META).map(k=>[k, stLabel(k)]));
// backlog + autoStart + pré-requisitos = NA ESPERA (começa sozinha — 46-epico-time: epicAutoStartTick).
// "Aguardando você" é reservado pro que depende do HUMANO; tarefa esperando outra tarefa é "na espera".
// "Iniciar épico" (46) arma também cartão SEM pré-requisito: o da onda 2+ espera a onda anterior inteira (na espera);
// o da onda atual só esperava vaga de agente (armado, mas não "na espera da onda anterior").
function ctArmed(ct){ return !!(ct && ct.status==='backlog' && ((ct.spec||{}).autoStart)); }
function ctWaiting(ct){ const s=(ct&&ct.spec)||{}; return ctArmed(ct) && ((Array.isArray(s.after) && s.after.length>0) || (parseInt(s.wave,10)||1)>1); }
// @exec-inicio — de QUEM é um cartão da nuvem (regra única da Execução × Time; testado em exec-minhas.test.mjs)
// meu = atribuído a mim; sem responsável, é de quem criou. Cartão de outra pessoa (ou atribuído a outra) é do TIME:
// mora na aba Time até eu assumir (claim_task grava assignee = eu → vira meu).
// cartão MANDADO PRO TIME (spec.dispatch='team') sem responsável é do time inteiro — não cai na Execução de quem criou (T5)
function ctMineFor(ct, me){ if(!ct || !me) return false; return ct.assignee ? ct.assignee===me : (ct.created_by===me && ((ct.spec||{}).dispatch!=='team')); }
// INÍCIO AUTOMÁTICO só com dono explícito (T5): o cartão está no MEU nome. Sem responsável nunca começa sozinho
// (era a armadilha: onda de épico "criado por mim sem responsável" rodando na máquina do líder)
function ctAutoMine(ct, me){ return !!(ct && me && ct.assignee===me); }
// o projeto do cartão existe nesta máquina? (sem projeto/sem remote = não dá pra saber → não esconde)
function ctProjLocal(pj, localList){ return !pj || !pj.repo_remote || remoteLocal(pj.repo_remote, localList); }
// entra na MINHA Execução (fila dos épicos, contagens, início automático): meu E de um projeto que tenho aqui
function ctExecOk(ct, me, pj, localList){ return ctMineFor(ct, me) && ctProjLocal(pj, localList); }
// "criada por Fulano · com Beltrano" — só o que envolve OUTRA pessoa; eu não apareço (o que é todo meu não ganha nada)
function ctWhoLabel(ct, me, nameOf){
  if(!ct) return '';
  const by=ct.created_by||'', as=ct.assignee||'', out=[];
  if(by && by!==me) out.push('criada por '+nameOf(by));
  if(as && as!==by && as!==me) out.push('com '+nameOf(as));
  return out.join(' · ');
}
// NOTIFICAÇÃO do time: só o que ME envolve — nunca "PR de um colega" ou "cartão novo" de quem não tem nada comigo
// (era aviso de tarefa alheia pra todo o time; pra owner/admin no escopo "organização", de TODOS os times).
// Devolve o tipo do aviso ou null. `all` = cartões carregados (pra achar de quem é o PR revisado).
//   'assigned'    cartão novo no backlog que OUTRA pessoa atribuiu a mim
//   'pr'          abriram o PR de uma demanda que EU criei (outra pessoa executou)
//   'review-done' concluíram o review de um PR MEU, ou de um review que EU pedi
function ctNotifKind(t, me, all){
  if(!t || !me) return null;
  const actor=t.assignee||t.created_by;
  const isRev=((t.spec||{}).kind==='review')||/^review (do |de )?pr/i.test(t.title||'');
  if(isRev){
    if(!t.pr_url || actor===me) return null;
    if(t.created_by===me) return 'review-done'; // eu pedi, outra pessoa revisou
    const mine=(all||[]).some(x=>x && x.id!==t.id && x.pr_url===t.pr_url && ctMineFor(x, me));
    return mine ? 'review-done' : null;
  }
  if(t.pr_url) return (t.created_by===me && actor!==me) ? 'pr' : null;
  if(t.status==='backlog') return (t.assignee===me && t.created_by!==me) ? 'assigned' : null;
  return null;
}
// @exec-fim
// ---- RESPONSÁVEL do cartão (mesa 09/10, T2): pôr OUTRA pessoa = líder do time ou owner/admin da org; membro: livre ou ele mesmo.
// A regra vale no banco (0032: gatilho + assign_task); aqui só não se oferece o que o banco recusaria.
// @time-resp-inicio (testado em app/tests/time-integrado.test.mjs)
// pode atribuir a outra pessoa? (papel na org + papel no time atual)
function tmCanAssign(meRole, members, me){ return meRole==='owner' || meRole==='admin' || (members||[]).some(m=>m && m.user_id===me && m.role==='lead'); }
// opções do seletor: Livre · Eu · (os outros do time, só pra quem pode) — nome do perfil, senão a parte do e-mail
function tmAssignOpts(members, profiles, me, canOthers){
  const nm=u=>personLabel((profiles||{})[u]||null, {}); // fonte única (08-pessoas): nome → parte do e-mail → "pessoa sem nome"
  const out=[{ id:'', label:'Livre', hint:'quem pegar primeiro' }];
  if(canOthers || (members||[]).some(m=>m&&m.user_id===me)) out.push({ id:me, label:nm(me), hint:'eu' }); // admin da org fora do time também pode ficar com ela (0032)
  if(canOthers) (members||[]).filter(m=>m&&m.user_id&&m.user_id!==me).map(m=>({ id:m.user_id, label:nm(m.user_id), hint:m.role==='lead'?'líder':'' })).sort((a,b)=>a.label.localeCompare(b.label,'pt-BR')).forEach(o=>out.push(o));
  return out;
}
// "Rodar agora" × "Mandar pro time": com time escolhido o padrão é mandar (T1); a última escolha vale
function tmDestDefault(hasTeam, saved){ if(!hasTeam) return 'run'; return saved==='run'||saved==='team'?saved:'team'; }
// @time-resp-fim
// tid: o time do CARTÃO (Org toda na Central/Time mostra cartões de outros times); sem tid = o time escolhido
function tmTeamMembers(tid){ return (((typeof cloudData!=='undefined'&&cloudData&&cloudData.teamMembers)||{})[tid||cloudTeamId()]||[]); }
function tmProfiles(){ const o={}; const a=(typeof cloudData!=='undefined'&&cloudData&&cloudData.profileByUser)||{}; Object.keys(a).forEach(k=>{ o[k]=a[k]; }); Object.keys(teamProfiles||{}).forEach(k=>{ o[k]=Object.assign({}, o[k]||{}, teamProfiles[k]); }); return o; }
function tmCanAssignNow(tid){ return tmCanAssign(cloudData&&cloudData.meRole, tmTeamMembers(tid), cloudUserId()); }
function tmAssignOptsNow(tid){ return tmAssignOpts(tmTeamMembers(tid), tmProfiles(), cloudUserId(), tmCanAssignNow(tid)); }
function tmDest(){ return tmDestDefault(!!(SB.sess()&&cloudTeamId()), lsGet('nd:dest')); }
function tmDestSet(v){ lsSet('nd:dest', v==='run'?'run':'team'); }
// botão do responsável (avatar + nome) — abre a lista real do time num popover
function tmWhoBtnHtml(uid, attrs){
  const o=tmAssignOptsNow().find(x=>x.id===(uid||''))||{ id:'', label:'Livre' };
  const av=o.id?tsAv(o.id, tsOnline(o.id)):`<span class="tsav tmfree" aria-hidden="true">${IC.users||'·'}</span>`;
  return `<button type="button" class="tmwho" ${attrs||''} aria-haspopup="listbox" title="${escA(o.id?'responsável: '+o.label:'sem responsável — quem pegar primeiro')}">${av}<span class="tmwho-n">${esc(o.id?o.label:'Livre')}</span><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}
function tmWhoPick(anchor, cur, onPick, tid){
  const opts=tmAssignOptsNow(tid), can=tmCanAssignNow(tid);
  const html=`<div class="ndpop-h">Responsável</div>`+(can?'':`<p class="ndpop-p">Só o líder do time ou um admin põe outra pessoa. Você pode deixar livre ou ficar com ela.</p>`)+
    `<div role="listbox" aria-label="responsável">`+opts.map(o=>`<button type="button" role="option" class="ndpop-opt tmwho-opt${o.id===(cur||'')?' on':''}" aria-selected="${o.id===(cur||'')}" data-tmwho="${escA(o.id)}"><span class="tmwho-row">${o.id?tsAv(o.id, tsOnline(o.id)):`<span class="tsav tmfree" aria-hidden="true">·</span>`}<b>${esc(o.label)}</b>${o.hint?`<span class="dim">${esc(o.hint)}</span>`:''}</span></button>`).join('')+`</div>`;
  if(typeof ndPopover!=='function') return;
  ndPopover(anchor, html, p=>p.querySelectorAll('[data-tmwho]').forEach(b=>b.onclick=()=>{ ndPopClose(); onPick(b.dataset.tmwho||null); }));
}
// atribui (ou solta, uid=null) pela RPC da 0032; nuvem sem a 0032 ainda → PATCH direto (conferido)
async function cloudAssign(taskId, uid){
  try{
    const j=await sbRpc('assign_task',{ p_task:taskId, p_user:uid||null });
    if(!j || j.ok!==true) throw Object.assign(new Error((j&&j.error)||'não deu pra atribuir'), { rpc:true });
    return true;
  }catch(e){
    if(e.rpc || !/could not find the function|function .* does not exist|PGRST202/i.test(String(e&&e.message||e))) throw e;
    // nuvem sem a 0032: só o que o banco antigo já deixava sem regra de papel — eu mesmo ou soltar o meu
    if(uid && uid!==cloudUserId()) throw new Error('a nuvem do time ainda não tem a atualização 0032 — atribuir a outra pessoa fica disponível depois que o dono aplicar (Admin › Banco)');
    const res=await sbFetch('/rest/v1/tasks?id=eq.'+taskId, { method:'PATCH', headers:{ 'Prefer':'return=representation' }, body: JSON.stringify({ assignee:uid||null }) });
    if(!Array.isArray(res)||!res.length) throw new Error('sem permissão pra mudar o responsável deste cartão');
    sbPost('task_activity',{ task_id:taskId, user_id:cloudUserId(), kind:uid?'claimed':'released', body:'' }).catch(()=>{});
    return true;
  }
}
function ctStLabel(ct){ return ctWaiting(ct)?'na espera da onda anterior':stLabel(typeof tsSt==='function'?tsSt(ct):ct.status); } // R5-1: status efetivo (PR aberto/pergunta)

async function cloudEnsureProject(){
  const teamId=cloudTeamId(); if(!teamId) throw new Error('escolha um time no botão Conta (rodapé da barra lateral)');
  const ids=await repoRemoteIds(); const remote=ids.remote;
  if(!remote) throw new Error('não consegui ler o remote deste projeto');
  // forma nova OU a antiga desta máquina (alias de ssh): o projeto que já existe no time continua valendo
  const rows=await sbGet('projects?select=id,name,repo_remote&team_id=eq.'+teamId+'&'+remoteInQ('repo_remote', ids));
  const hit=remotePick(rows, ids, 'repo_remote'); if(hit) return hit;
  const name=String(remote).split('/').pop();
  const ins=await sbPost('projects',{ team_id:teamId, name, repo_remote:remote });
  return ins[0];
}
// nuvem → .cardume/issue.json local: todo mundo do time pega a última config
// de "criar issue ao abrir demanda" do projeto (espelha prefsPull)
async function issueConfigPull(){
  if(!SB.sess() || !cloudTeamId()) return;
  try{
    const proj=await cloudEnsureProject();
    const rows=await sbGet('project_issue_config?select=enabled,instructions,title_template,body_template&project_id=eq.'+proj.id);
    const r=rows&&rows[0]; if(!r) return;
    if(typeof trkReady==='function' && trkReady()) return; // o painel de issues (14) cria a issue — não religar a instrução antiga
    await invoke('set_issue_config', { config: { enabled:!!r.enabled, instructions:r.instructions||'', titleTemplate:r.title_template||'', bodyTemplate:r.body_template||'' } });
  }catch(_){ }
}
// compartilhar com o time: vira cartão no backlog — NÃO roda nesta máquina
// o cartão compartilhado NÃO leva o conselheiro de quem criou (cobraria no plano de quem assume)
function cloudSpecOf(payload){ const s=Object.assign({}, payload||{}); delete s.advisor; return s; }
// A ISSUE nasce junto (painel de Issues ligado pro projeto): o código vai no spec e no issue_url — quem assumir depois
// não cria outra. Falha do painel avisa com o motivo e NÃO impede o cartão (mesa 09/10, T6).
async function cloudShareTask(payload, opts){
  opts=opts||{};
  if(!SB.sess()) throw new Error('entre na sua conta (botão Conta, no rodapé da barra lateral)');
  const proj=await cloudEnsureProject();
  // épico: o do chamador (planner passa o dele, ou null) — só o Formulário lê o seletor #ntEpic (BUG-8: nunca o campo de outra aba)
  let spec=payload, iss=null; const epicId=opts.epicId!==undefined?opts.epicId:(typeof ntEpicVal==='function'?ntEpicVal():null);
  if(typeof trkIssueForCard==='function' && !payload.issue && !payload.issueUrl){
    const ep=epicId&&(teamEpics||[]).find(e=>e.id===epicId);
    // painel lento/caído não segura o cartão: 12 s e segue sem a issue (com o aviso)
    iss=await Promise.race([ trkIssueForCard(payload, { remote:proj.repo_remote, epicLine:ep?'Épico: '+((ep.spec&&ep.spec.issue&&ep.spec.issue.code)||ep.name):'' }),
      new Promise(r=>setTimeout(()=>r({ err:'o painel não respondeu em 12 s' }), 12000)) ]);
    if(iss&&iss.code) spec=trkSpecWithIssue(payload, iss);
  } else if(payload.issue) spec={ ...payload, issueCode:payload.issue };
  const rows=await sbPost('tasks',{ local_id:'card-'+Math.random().toString(36).slice(2,10), project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), claim_mode:'open', title:payload.title, status:'backlog', epic_id:epicId, spec:{ ...cloudSpecOf(spec), dispatch:'team' }, issue_url:(iss&&iss.url)||payload.issueUrl||null });
  if(iss&&iss.err) trkCardFailToast(payload.title, iss.err);
  // responsável DEPOIS do cartão existir (recusa do banco não derruba o cartão nem deixa issue órfã): fica livre e avisa
  const who=opts.assignee||null;
  if(who && rows&&rows[0]){
    if(typeof tmAssignOptsNow==='function' && !tmAssignOptsNow().some(o=>o.id===who)) toast('O responsável escolhido não está mais disponível no time — o cartão ficou livre.','warn');
    else try{ await cloudAssign(rows[0].id, who); rows[0].assignee=who; if(typeof trkCardAssign==='function') trkCardAssign(rows[0], who); }catch(e){ toast('O cartão foi pro time, mas ficou livre: '+(typeof cloudErrMsg==='function'?cloudErrMsg(e):String(e&&e.message||e)),'warn'); }
  }
  sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'created', body:payload.title }).catch(()=>{});
  teamTasks=null;
  return rows[0];
}
// realizar eu mesmo: roda aqui + sobe o cartão reservado (decisão: "pra si")
async function cloudPublishSelf(localId, payload){
  if(!SB.sess() || !cloudTeamId()) return;
  const proj=await cloudEnsureProject();
  const rows=await sbPost('tasks',{ local_id:localId, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:payload.title, status:'running', epic_id:(typeof ntEpicVal==='function'?ntEpicVal():null), issue_url:payload.issueUrl||null, spec:Object.assign(cloudSpecOf(payload), payload.issue?{ issueCode:payload.issue }:{}) }); // a issue vai nas DUAS pontas (o time vê a tarefa na issue)
  tmapSet(localId, rows[0].id);
  if(rows[0].epic_id && window.epicMarkInProgress) epicMarkInProgress(rows[0].epic_id); // 1ª tarefa rodando → épico em andamento
  sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'started', body:'' }).catch(()=>{});
  teamTasks=null;
}

// backfill: publica no time as tarefas locais criadas ANTES do modo time
// (ou com "não compartilhar") — como SUAS (reservadas), com o status real.
async function cloudBackfill(btn){
  if(!cloudScopeOk()) return;
  const fg=tmapForeign(); // cartão de outra conta: não é desta conta publicar
  const list=(state.tasks||[]).filter(t=>!tmap()[t.id] && !fg.has(t.id) && t.status!=='draft');
  if(!list.length) return;
  if(!await askYes('Publicar/vincular '+list.length+' tarefa(s) local(is) no time?\n\nSobem como SUAS (reservadas), com status, flag e datas reais. Cartão que já existe só é vinculado — nada é sobrescrito.')) return;
  if(btn){ btn.disabled=true; }
  let n=0;
  try{
    const proj=await cloudEnsureProject();
    for(const t of list){
      if(btn) btn.textContent=`publicando ${++n}/${list.length}…`;
      try{
        const cost=taskCost(t.id);
        await sbFetch('/rest/v1/tasks?on_conflict=project_id,local_id',{ method:'POST', headers:{ 'Prefer':'resolution=ignore-duplicates' }, body: JSON.stringify({ local_id:t.id, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:t.title, status:t.status, flag:t.flag||null, branch:t.branch||null, pr_url:t.prUrl||null, issue_url:t.issueUrl||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0, created_at:new Date(t.createdAt||t.created_at).toISOString(), spec:{ title:t.title, objective:t.objective||'', requirements:Array.isArray(t.requirements)?t.requirements:[], deliverables:Array.isArray(t.deliverables)?t.deliverables:[], kind:t.kind||'build', ...(t.issueCode?{ issueCode:t.issueCode }:{}), ...epicPubFields(t.epic) }, epic_id:cloudEpicId(t.epic&&t.epic.epicId) }) });
        const rows=await sbGet('tasks?select=id&project_id=eq.'+proj.id+'&local_id=eq.'+encodeURIComponent(t.id));
        if(rows[0]) tmapSet(t.id, rows[0].id);
      }catch(e){ console.error('backfill', t.id, e.message); }
    }
    teamTasks=null; teamPaintSig=''; renderTeamBoard();
  }finally{ if(btn){ btn.disabled=false; } }
}

// épico da NUVEM é uuid (FK em epics). Épico só local (ex.: piloto automático, "piloto-pou-virtual") sobe
// como null — antes o Postgres recusava ("invalid input syntax for type uuid") e a tarefa nunca chegava na conta.
function cloudEpicId(id){ return (typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ? id : null; }
// campos de épico que vão pro spec do cartão — sem epicChecks/epicDoneWhen (cópias estáticas; a fonte é epics.spec)
function epicPubFields(ep){ const { epicChecks, epicDoneWhen, ...rest }=(ep||{}); return rest; }
// ---- auto-publicação: tarefa local sem cartão VIRA cartão sozinha ----
// O time tem que ver o quadro real sem ninguém clicar nada (o stream do agente
// continua só nesta máquina; provas continuam opt-in). Uma por tick.
const autoPubFails={}, autoPubLast={};
async function cloudAutoPublish(){
  if(!cloudScopeOk()) return;
  // tarefa com cartão de OUTRA conta nunca é republicada com esta (era o "row-level security" do log)
  const fg=tmapForeign();
  // falha não desiste pra sempre: backoff de 2min e tenta de novo
  const t=(state.tasks||[]).find(x=>!tmap()[x.id] && !fg.has(x.id) && x.status!=='draft' && ((autoPubFails[x.id]||0)<3 || Date.now()-(autoPubLast[x.id]||0)>120000));
  if(!t) return;
  autoPubLast[t.id]=Date.now();
  try{
    const proj=await cloudEnsureProject();
    const cost=taskCost(t.id);
    await sbFetch('/rest/v1/tasks?on_conflict=project_id,local_id',{ method:'POST', headers:{ 'Prefer':'resolution=ignore-duplicates' }, body: JSON.stringify({ local_id:t.id, project_id:proj.id, team_id:cloudTeamId(), created_by:cloudUserId(), assignee:cloudUserId(), claim_mode:'reserved', title:t.title, status:t.status, flag:t.flag||null, branch:t.branch||null, pr_url:t.prUrl||null, issue_url:t.issueUrl||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0, created_at:new Date(t.createdAt||t.created_at).toISOString(), spec:{ title:t.title, objective:t.objective||'', requirements:Array.isArray(t.requirements)?t.requirements:[], deliverables:Array.isArray(t.deliverables)?t.deliverables:[], kind:t.kind||'build', ...(t.issueCode?{ issueCode:t.issueCode }:{}), ...epicPubFields(t.epic) }, epic_id:cloudEpicId(t.epic&&t.epic.epicId) }) });
    const rows=await sbGet('tasks?select=id&project_id=eq.'+proj.id+'&local_id=eq.'+encodeURIComponent(t.id));
    if(rows[0]){
      tmapSet(t.id, rows[0].id); teamTasks=null;
      sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'created', body:t.title }).catch(()=>{});
      if(ACTIVE_ST.has(t.status)) sbPost('task_activity',{ task_id:rows[0].id, user_id:cloudUserId(), kind:'started', body:'' }).catch(()=>{});
    }
  }catch(e){ autoPubFails[t.id]=(autoPubFails[t.id]||0)+1; console.error('autopub', t.id, e.message); }
}

// ---- reparo único do cursor do feed: se a nuvem está vazia pra uma tarefa
// ATIVA mas há eventos locais, o cursor foi envenenado (falhas antigas
// avançaram sem publicar) → zera pra republicar o histórico. 1x por sessão.
let feedRepaired=false;
async function cloudFeedRepair(){
  if(feedRepaired || !SB.sess() || !cloudTeamId() || !cloudScopeOk()) return;
  if(!(state.events||[]).length || !(state.tasks||[]).length) return; // snapshot ainda não chegou — NÃO marca reparado
  feedRepaired=true;
  const m=tmap(); const pos=feedPos();
  for(const lid of Object.keys(m)){
    if(!(pos[lid]>0)) continue;
    const t=(state.tasks||[]).find(x=>x.id===lid);
    if(!t || !(ACTIVE_ST.has(t.status)||['thinking','plan-review','review','delivered'].includes(t.status))) continue;
    try{
      const rows=await sbGet('task_feed?select=id&task_id=eq.'+m[lid]+'&limit=3');
      const evn=(state.events||[]).filter(e=>(e.taskId||e.task_id)===lid && FEED_KINDS.has(e.type||e.kind)).length;
      if(rows.length<3 && evn>=3){ const p={ ...feedPos() }; delete p[lid]; lsSet(feedPosKey(), JSON.stringify(p)); invoke('web_log',{line:'[feed] cursor reparado: '+lid+' ('+evn+' eventos locais, '+rows.length+' na nuvem)'}).catch(()=>{}); }
    }catch(_){ }
  }
}

// ---- túnel AUTOMÁTICO: agente anunciou 'PREVIEW: <url>' (antigo: globo + 'preview:') numa tarefa ativa →
// cria o túnel sozinho e publica no cartão (nada manual; celular já abre).
const autoTunneled={};       // último pedido atendido por tarefa
const tunnelUp={};           // túneis vivos DESTA sessão: lid → url pública
let tunnelSweepDone=false;
async function cloudAutoTunnelTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  const m=tmap(); const ids=Object.values(m); if(!ids.length) return;
  // boot: túneis morreram com o app anterior — limpa previewUrl órfão dos cartões (as 40 mapeadas mais recentes)
  if(!tunnelSweepDone){
    tunnelSweepDone=true;
    try{
      const stale=await sbGet('tasks?select=id,spec&id=in.'+pgIn(ids.slice(-40))+'&spec-%3E%3EpreviewUrl=not.is.null&limit=10');
      for(const r of stale){ await sbFetch('/rest/v1/tasks?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({spec:{...(r.spec||{}),previewUrl:null}})}).catch(()=>{}); }
    }catch(_){ }
  }
  // ABERTURA E FECHO SÃO DECISÃO DO HUMANO: só atende pedidos explícitos
  // (tunnelWanted/tunnelClose vindos do celular; no Mac o chip chama direto).
  const live=cloudTaskIds(m, 40, true); if(!live.length) return;
  try{
    const rows=await sbGet('tasks?select=id,spec&id=in.'+pgIn(live.map(l=>m[l]))+'&or=(spec-%3E%3EtunnelWanted.not.is.null,spec-%3E%3EtunnelClose.not.is.null)&limit=10');
    for(const r of rows){
      const lid=Object.keys(m).find(k=>m[k]===r.id); if(!lid) continue;
      const sp=r.spec||{};
      if(sp.tunnelClose){
        invoke('tunnel_stop',{ taskId: lid }).catch(()=>{});
        delete tunnelUp[lid]; delete autoTunneled[lid];
        await sbFetch('/rest/v1/tasks?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({spec:{...sp,previewUrl:null,tunnelClose:null,tunnelWanted:null}})}).catch(()=>{});
        continue;
      }
      if(sp.tunnelWanted){
        let pv=taskPreviewUrl(lid);
        if(!pv){
          // anúncio saiu da janela local de eventos → busca no feed da nuvem
          try{
            const notes=await sbGet('task_feed?select=text&task_id=eq.'+r.id+'&kind=eq.note&order=id.desc&limit=60');
            for(const n of notes){ const mm=(n.text||'').match(PREVIEW_RE); if(mm){ pv=mm[1]; break; } }
          }catch(_){ }
        }
        if(!pv){ invoke('web_log',{line:'[tunnel] pedido sem preview anunciado: '+lid}).catch(()=>{}); continue; }
        const key=pv+'|'+String(sp.tunnelWanted);
        if(autoTunneled[lid]===key) continue;
        autoTunneled[lid]=key;
        const pub=await mobilePreview(lid, pv, true);
        if(pub) tunnelUp[lid]=pub;
      }
    }
  }catch(_){ }
}
tickLoop('cloudAutoTunnelTick', cloudAutoTunnelTick, 9000);

// ---- sync: empurra o estado LOCAL das tarefas mapeadas pro cartão ----
const cloudSyncSigs={}, prProbed=new Set();
// ---- PONTES DE INTENÇÃO do celular (escopo mobile): o app escreve
// spec.intent={kind,...} → o Mac executa → publica spec.intentResult e limpa.
// kinds: openPr {noProofReason?} · merge · pause · resume · stop · abort · askProof · fixComment {commentId}
const intentBusy={};
const prPubAt={};
async function cloudIntentTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  const m=tmap(); const live=cloudTaskIds(m, 40, true); if(!live.length) return;
  let rows=[];
  try{ rows=await sbGet('tasks?select=id,spec,pr_url&id=in.'+pgIn(live.map(l=>m[l]))+'&spec-%3E%3Eintent=not.is.null&limit=6'); }catch(_){ return; }
  for(const r of rows){
    const lid=Object.keys(m).find(k=>m[k]===r.id); if(!lid || intentBusy[lid]) continue;
    const sp=r.spec||{}; const it=sp.intent||{}; const kind=it.kind;
    if(!kind) continue;
    intentBusy[lid]=true;
    const t=(state.tasks||[]).find(x=>x.id===lid);
    const finish=async(ok,msg,extra)=>{
      const cur=(await sbGet('tasks?select=spec&id=eq.'+r.id).catch(()=>[{}]))[0]||{};
      await sbFetch('/rest/v1/tasks?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({ ...(extra||{}), spec:{...(cur.spec||sp),intent:null,intentResult:{kind,ok,msg:String(msg||'').slice(0,300),at:new Date().toISOString()}}})}).catch(()=>{});
      delete intentBusy[lid];
      invoke('web_log',{line:'[intent] '+kind+' '+(ok?'ok':'FALHOU')+' · '+lid+(msg?' · '+String(msg).slice(0,80):'')}).catch(()=>{});
      lastSig=''; refresh().catch(()=>{});
    };
    // R8: o motivo volta pro celular em pt-BR (antes ia o erro cru do gh/git); o cru fica no log
    const fail=(e,ctx)=>{ invoke('web_log',{line:'[intent] cru: '+errText(e).slice(0,200)}).catch(()=>{}); return finish(false, humanErr(e,ctx).msg); };
    try{
      if(kind==='openPr'){
        if(!t) return finish(false,'tarefa não está neste Mac');
        // PORTÃO DE PROVA (PR #100) também pra quem aprova do celular: requisito sem prova só passa com motivo
        // (48: mobileApproveDecide) — o motivo vira o mesmo override do "aprovar sem prova…" do Mac e vai no PR
        if(typeof proofGate==='function'){
          if(typeof reqProofCache!=='undefined' && typeof loadReqProofs==='function'){ reqProofCache[lid]=undefined; await loadReqProofs(lid).catch(()=>{}); }
          const pg=proofGate(t), dec=mobileApproveDecide(pg, it.noProofReason);
          if(!dec.ok) return finish(false, dec.msg);
          if(dec.override){
            lsSet('proofOv:'+lid, JSON.stringify({ sig:proofSigOf(pg.missing), reason:dec.reason+' (pelo celular)', at:Date.now(), missing:pg.missing.map(r=>r.text) }));
            invoke('checks_override_log',{ taskId:lid, reason:'[sem prova · celular] '+dec.reason, fingerprint:'', failing:pg.missing.map(r=>'sem prova: '+r.text) }).catch(()=>{});
          }
        }
        let checks=[]; try{ checks=await invoke('repo_checks',{taskId:lid}); }catch(_){ }
        const bad=checks.filter(c=>!c.ok);
        if(bad.length) return finish(false,'checagem falhou: '+bad.map(c=>c.name).join(', ')+' — abra pelo Mac pra ver o detalhe');
        try{ await invoke('push_task',{taskId:lid}); }catch(e){ return fail(e,'Não consegui enviar o código (push)'); }
        try{ if(typeof provasAttach==='function') await provasAttach(t); }catch(_){ } // provas no PR (sem pergunta: público sem decisão fica pro Mac)
        let body; try{ body=await invoke('pr_body_ai',{taskId:lid}); }catch(_){ body=prBodyOf(t); }
        // mesma seção "## Provas"/"## Verificação" do PR aberto pelo Mac (override do celular incluso)
        try{ if(typeof chkPrBodyExtra==='function') body=String(body||'')+chkPrBodyExtra(t); }catch(_){ }
        try{ if(typeof cicloReportFor==='function') body=String(body||'')+cicloReportFor(t); }catch(_){ } // Relatório Starfork
        try{
          const url=await invoke('open_pr',{taskId:lid, base:lsGet('prBase:'+lid)||'main', title:t.title, body});
          prCache[lid]=undefined;
          return finish(true,'PR aberto',{pr_url:url});
        }catch(e){
          // gh sem acesso ao repo: a branch já subiu — devolve o link pra criar o PR no navegador
          if(/^GH_NO_ACCESS:|could not resolve to a repository/i.test(errText(e))){
            try{ const cu=await invoke('pr_compare_url',{taskId:lid, base:lsGet('prBase:'+lid)||'main'}); if(cu) return finish(false,'o gh logado não enxerga o repositório — crie o PR no navegador: '+cu); }catch(_){ }
          }
          return fail(e,'Não consegui criar o PR'); }
      }
      if(kind==='merge'){
        try{ const msg=await invoke('merge_pr',{taskId:lid, method:'squash'}); return finish(true,msg); }
        catch(e){ return fail(e,'Não consegui fazer o merge'); }
      }
      if(kind==='pause'){ try{ await invoke('pause_task',{taskId:lid}); return finish(true,'pausada'); }catch(e){ return fail(e,'Não consegui pausar'); } }
      if(kind==='resume'){
        // pausada pelo TETO não retoma por aqui (seria gastar sem decidir) — responda a pergunta do teto
        if(t && ((t.spec||{}).budgetHit)) return finish(false,'a tarefa está parada no teto de custo — responda a pergunta do teto (continuar ou parar)');
        try{ await invoke('resume_task',{taskId:lid}); return finish(true,'retomada'); }catch(e){ return fail(e,'Não consegui retomar'); }
      }
      if(kind==='stop'){
        if(typeof budgetQuiet!=='undefined') budgetQuiet.add(lid); // parar ≠ "pronta pra revisar" (sem aviso falso)
        try{ await invoke('stop_task',{taskId:lid}); return finish(true,'turno parado — a demanda volta pra você revisar'); }catch(e){ return fail(e,'Não consegui parar'); }
      }
      if(kind==='askProof'){
        if(!t) return finish(false,'tarefa não está neste Mac');
        if(typeof reqProofCache!=='undefined' && typeof loadReqProofs==='function'){ reqProofCache[lid]=undefined; await loadReqProofs(lid).catch(()=>{}); }
        const g=(typeof proofGate==='function')?proofGate(t):{ missing:[] };
        if(!g.missing.length) return finish(true,'todos os requisitos já têm prova');
        // mesma mensagem e mesmo caminho do botão "pedir a prova ao agente" do Mac (na fila se ele estiver trabalhando)
        const ok=(typeof fwSendText==='function') ? await fwSendText(lid, proofAskMsg(g.missing)) : false;
        return ok ? finish(true,'pedido enviado ao agente — '+g.missing.length+' requisito(s) sem prova') : finish(false,'não consegui mandar o pedido ao agente');
      }
      if(kind==='abort'){ try{ await invoke('abort_task',{taskId:lid}); return finish(true,'abortada'); }catch(e){ return fail(e,'Não consegui cancelar'); } }
      if(kind==='fixComment'){
        try{
          prCache[lid]=undefined; await loadPr(lid,true);
          const info=prCache[lid];
          const cmts=((info&&info.comments)||[]).filter(c=>!c.inReplyTo);
          const ci=cmts.findIndex(c=>String(c.id)===String(it.commentId));
          if(ci<0) return finish(false,'comentário não encontrado');
          // prFixOne devolve false quando não chegou ao agente (não achou o comentário, envio falhou, teto de custo aberto)
          if(!await prFixOne(lid, ci)) return finish(false,'não consegui mandar a correção pro agente');
          return finish(true,'agente acordado pra corrigir o comentário');
        }catch(e){ return fail(e,'Não consegui mandar a correção'); }
      }
      return finish(false,'intenção desconhecida: '+kind);
    }catch(e){ return fail(e); }
  }
}
// publica na nuvem o que a tela Entrega/PR do celular mostra: stat do diff,
// commits e o PR (corpo+comentários truncados) — sem isso o mobile ficaria cego
async function cloudPrStatTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  const m=tmap();
  const live=(state.tasks||[]).filter(t=>m[t.id] && t.flag!=='closed' && !['merged','done','draft'].includes(t.status)).slice(0,8);
  for(const t of live){
    const cid=m[t.id];
    const now=Date.now();
    if(now-(prPubAt[t.id]||0) < 120000) continue;
    prPubAt[t.id]=now;
    try{
      const d=diffOf(t.id)||{}; const c=commitsCache[t.id];
      const stat={ files:diffFiles(d), add:d.additions||0, del:d.deletions||0, commits:Array.isArray(c)?c.length:null };
      let prInfo=null;
      if(t.prUrl){
        try{ await loadPr(t.id); const i=prCache[t.id];
          if(i&&i.exists) prInfo={ number:i.number, state:i.state, decision:i.decision, body:(i.body||'').slice(0,3000),
            // o que trava o PR (mesa 09/10, D6.2): o gestor vê "checagem do PR falhou: lint" / "conflito com a base" no cartão
            checksFail:+i.checksFail||0, failing:(i.failingChecks||[]).slice(0,3).map(x=>String(x).slice(0,40)), mergeable:i.mergeable||null, at:new Date().toISOString(),
            comments:(i.comments||[]).filter(x=>!x.inReplyTo).slice(0,12).map(x=>({id:x.id,author:x.author,path:x.path,line:x.line,
              // o app do celular só lê "answered": manda o MESMO "resolvido" do desktop (respondido, resolvido no
              // GitHub, desatualizado ou ignorado aqui) — antes o celular mostrava em aberto o que o desktop já escondia
              answered:(typeof prCmtDone==='function'&&typeof prIgnSet==='function')?prCmtDone(x, prIgnSet(t.id)):!!(x.answered||x.resolved||x.outdated),
              resolved:!!x.resolved,outdated:!!x.outdated,isBot:x.isBot,body:(x.body||'').slice(0,400)})) };
          // merge feito FORA do app (GitHub) → marca merged aqui também
          if(i&&i.exists&&i.state==='MERGED'&&!['merged','done'].includes(t.status)){
            invoke('mark_task_status',{ taskId:t.id, status:'merged' }).then(()=>{ lastSig=''; refresh(); }).catch(()=>{});
          }
        }catch(_){ }
      }
      const rev=reviewOf(t.id);
      const review=rev?{ summary:(rev.summary||'').slice(0,600), howToTest:(rev.howToTest||'').slice(0,800) }:null;
      const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{};
      await sbFetch('/rest/v1/tasks?id=eq.'+cid,{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),stat,prInfo,review}})});
    }catch(_){ }
  }
}
tickLoop('cloudIntentTick', cloudIntentTick, 6000);
tickLoop('cloudPrStatTick', cloudPrStatTick, 30000);
async function cloudSyncTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  await cloudAutoPublish().catch(()=>{});
  const m=tmap(); const ids=Object.keys(m); if(!ids.length) return;
  // descobre o PR de UMA tarefa por tick (gh) — persiste no spec e o sync leva pro cartão
  const probe=ids.find(lid=>{ const t=(state.tasks||[]).find(x=>x.id===lid); return t && !t.prUrl && ['review','merged','error'].includes(t.status) && !prProbed.has(lid); });
  if(probe){ prProbed.add(probe); invokeQuiet('pr_status',{ taskId: probe }).catch(()=>{}); } // sondagem em 2º plano: falha não é erro
  // boot da sessão: os cartões ainda sem assinatura vêm num GET só (antes: 1 GET por tarefa)
  const bootCards={};
  { const need=cloudTaskIds(m, 400, false).filter(l=>cloudSyncSigs[l]===undefined && !(teamTasks||[]).some(c=>c.id===m[l])).map(l=>m[l]);
    for(let i=0; i<need.length; i+=50){ try{ (await sbGet('tasks?select=id,status,flag,pr_url&id=in.'+pgIn(need.slice(i,i+50)))).forEach(c=>bootCards[c.id]=c); }catch(_){ } } }
  for(const lid of ids){
    const t=(state.tasks||[]).find(x=>x.id===lid); if(!t) continue;
    // itens do "pronto quando" que o agente revisor marcou (tool check_done_when) → espelho no épico do time
    if(t.epic&&Array.isArray(t.epic.epicChecks)&&t.epic.epicChecks.length&&window.epicMirrorChecks) epicMirrorChecks(t).catch(()=>{});
    const cost=taskCost(lid);
    const body={ status:t.status, stage:t.stage||null, branch:t.branch||null, pr_url:t.prUrl||null, issue_url:t.issueUrl||null, flag:t.flag||null, cost_usd:+(cost.usd||0).toFixed(4), cost_tokens:cost.tok||0 };
    const proofs=reqProofCache[lid]; if(proofs) body.requirements_proof=proofs;
    const sig=JSON.stringify(body);
    const prev=cloudSyncSigs[lid];
    if(prev===sig) continue;
    if(prev===undefined){
      // boot da sessão: não "toca" o cartão à toa (preserva updated_at real) —
      // compara com o cartão real ANTES de cachear a assinatura (sem o quadro
      // carregado, busca só este cartão; senão tarefa rápida ficava presa).
      cloudSyncSigs[lid]=sig;
      let card=(teamTasks||[]).find(c=>c.id===m[lid]) || bootCards[m[lid]];
      if(!card){ try{ card=(await sbGet('tasks?select=status,flag,pr_url&id=eq.'+m[lid]))[0]; }catch(_){ } }
      if(!card) continue;
      const same=card.status===t.status && (card.flag||null)===(t.flag||null) && (card.pr_url||null)===(t.prUrl||null);
      if(same) continue;
    }
    try{
      await sbFetch('/rest/v1/tasks?id=eq.'+m[lid], { method:'PATCH', body: JSON.stringify(body) });
      // AÇÕES vão pra nuvem sozinhas: mudança de status/PR vira atividade no feed
      const before=prev?JSON.parse(prev):null;
      if(before && before.status!==t.status) sbPost('task_activity',{ task_id:m[lid], user_id:cloudUserId(), kind:'status', body:CT_ST_PT[t.status]||t.status }).catch(()=>{});
      // tarefa TERMINOU → túnel do preview fecha e a URL sai do cartão
      if(before && (['merged','done','aborted'].includes(t.status)||t.flag==='closed') && !(['merged','done','aborted'].includes(before.status)||before.flag==='closed')){
        invoke('tunnel_stop',{ taskId: lid }).catch(()=>{});
        delete autoTunneled[lid];
        (async()=>{ try{ const cur=(await sbGet('tasks?select=spec&id=eq.'+m[lid]))[0]||{}; if((cur.spec||{}).previewUrl){ await sbFetch('/rest/v1/tasks?id=eq.'+m[lid],{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),previewUrl:null,tunnelWanted:null}})}); } }catch(_){ } })();
      }
      if(before && !before.pr_url && t.prUrl) sbPost('task_activity',{ task_id:m[lid], user_id:cloudUserId(), kind:'delivered', body:'PR aberto' }).catch(()=>{});
      cloudSyncSigs[lid]=sig;
    }
    catch(e){ console.error('sync '+lid+':', e.message); }
  }
}
tickLoop('cloudSyncTick', cloudSyncTick, 6000);
setInterval(()=>{ railProjTick().catch(e=>tickErr('railProjTick',e)); }, 15000);
setTimeout(()=>{ railProjTick().catch(e=>tickErr('railProjTick',e)); }, 2500);

// ---- PONTE DE PERGUNTAS (mobile): pergunta aberta sobe, resposta desce ----
// O agente pergunta (ask_human) → o Mac publica no cartão; o dev responde do
// celular (PWA) → o Mac entrega a resposta ao agente (resolve_pending).
const qPushed=new Set();
// ---- push APNs REAL pros meus iPhones (app fechado): pergunta nova · entrega pronta ----
let apnsTokens=null, apnsTokensAt=0;
async function apnsNotify(title, body, extra){
  try{
    if(!SB.sess()) return;
    if(!apnsTokens || Date.now()-apnsTokensAt>300000){
      apnsTokens=(await sbGet('device_tokens?select=token&user_id=eq.'+cloudUserId()+'&platform=eq.ios&limit=5')).map(r=>r.token);
      apnsTokensAt=Date.now();
    }
    for(const tk of (apnsTokens||[])){
      invoke('apns_push',{ token:tk, title, body, category:(extra&&extra.category)||null, taskId:(extra&&extra.taskId)||null, questionId:(extra&&extra.questionId)||null })
        .then(()=>invoke('web_log',{line:'[apns] ✓ '+title.slice(0,40)}))
        .catch(e=>invoke('web_log',{line:'[apns] ✕ '+String(e).slice(0,120)}));
    }
  }catch(_){ }
}
// entrega ficou PRONTA → push (transição de status observada no snapshot local)
const pushedReady=new Set();
async function pushReadyTick(){
  if(!cloudScopeOk()) return;
  const m=tmap();
  for(const t of (state.tasks||[])){
    if(!['review','delivered'].includes(t.status) || t.flag==='closed' || pushedReady.has(t.id)) continue;
    pushedReady.add(t.id);
    if(!m[t.id]) continue;
    // só empurra transições NOVAS (tarefa que já estava pronta no boot não notifica)
    if(Date.now()-bootAt<20000) continue;
    apnsNotify('Entrega pronta pra revisar', t.title.slice(0,120), { taskId:m[t.id] });
  }
}
const bootAt=Date.now();
setInterval(()=>{ pushReadyTick().catch(e=>tickErr('pushReadyTick',e)); }, 6000);
const qNotified=new Set(); // push de pergunta: UMA vez por pergunta, mesmo que o upsert se repita
async function cloudQuestionsTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  const m=tmap(); const pendAll=state.pending||[];
  // 1) publica perguntas abertas (upsert por task+pending_id)
  for(const p of pendAll){
    const cid=m[p.taskId]; if(!cid) continue;
    const key=cid+'|'+p.id;
    if(qPushed.has(key)) continue;
    try{
      const qrows=await sbFetch('/rest/v1/questions?on_conflict=task_id,local_pending_id', { method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ task_id:cid, local_pending_id:p.id, agent:p.agent||'', prompt:(p.prompt||'').slice(0,2000), options:Array.isArray(p.options)?p.options:[], status:'open' }) });
      qPushed.add(key);
      // push REAL: responder direto da notificação, com o app fechado
      const qid=(Array.isArray(qrows)&&qrows[0]&&qrows[0].id)?String(qrows[0].id):'';
      if(!qNotified.has(key)){ qNotified.add(key); apnsNotify('Precisa de você — '+(p.agent||'agente'), String(p.prompt||'').slice(0,160), { taskId:cid, questionId:qid, category:'QUESTION' }); }
    }catch(err){
      // erro visível: sem isso a ponte falha em silêncio e ninguém fica sabendo
      if(!qPushed.has('err|'+key)){ qPushed.add('err|'+key); sbPost('task_feed',{ task_id:cid, agent:'Sistema', kind:'error', text:'Atenção: pergunta não subiu pro celular: '+String(err.message||err).slice(0,180) }).catch(()=>{}); }
    }
  }
  // 2+3) UMA consulta (antes: 2 GETs × cada tarefa do tmap a cada 7s, crescendo pra sempre): perguntas
  // abertas/respondidas das tarefas VIVAS do projeto aberto + as que têm pergunta pendente aqui
  const lids=[...new Set(cloudTaskIds(m, 80, true).concat(pendAll.map(p=>p.taskId).filter(l=>m[l])))];
  if(!lids.length) return;
  const lidOf={}; lids.forEach(l=>{ lidOf[m[l]]=l; });
  let rows=[];
  try{ rows=await sbGet('questions?select=id,task_id,local_pending_id,answer,status&task_id=in.'+pgIn(lids.map(l=>m[l]))+'&status=in.(open,answered)&order=id&limit=200'); }catch(_){ return; }
  for(const q of rows){
    const lid=lidOf[q.task_id]; if(!lid) continue;
    const isPend=pendAll.some(p=>p.taskId===lid && p.id===q.local_pending_id);
    try{
      if(q.status==='answered'){
        // resposta vinda do celular → entrega ao agente e fecha
        if(isPend){
          // id negativo = pergunta do TETO de custo (sintética, 53-teto-protecao) — não existe no banco
          // budgetAnswer agora LANÇA no erro: sem isto o PATCH abaixo era pulado e a resposta era reaplicada a cada 7s
          // (podendo repetir um "parar" pela metade). Falhou → avisa no feed e fecha mesmo assim (a pergunta do teto
          // continua aberta no desktop, onde dá pra responder de novo).
          if(+q.local_pending_id<0 && typeof budgetAnswer==='function'){
            try{ await budgetAnswer(+q.local_pending_id, q.answer||''); }
            catch(err){ sbPost('task_feed',{ task_id:q.task_id, agent:'Sistema', kind:'error', text:'A resposta do teto de custo vinda do celular não foi aplicada: '+String(err&&err.message||err).slice(0,180)+' — responda de novo no computador.' }).catch(()=>{}); }
          }
          else { try{ await invoke('resolve_pending',{ id:q.local_pending_id, answer:q.answer||'' }); }catch(_){ continue; } }
        }
        await sbFetch('/rest/v1/questions?id=eq.'+q.id, { method:'PATCH', body: JSON.stringify({ status:'closed' }) }).catch(()=>{});
        lastSig='';
      } else if(!isPend){
        // pergunta respondida NO DESKTOP (sumiu do pending local) → fecha na nuvem
        await sbFetch('/rest/v1/questions?id=eq.'+q.id, { method:'PATCH', body: JSON.stringify({ status:'closed' }) }).catch(()=>{});
      }
    }catch(_){ }
  }
}
tickLoop('cloudQuestionsTick', cloudQuestionsTick, 7000);

// ---- MOBILE AO VIVO: o celular escreve intenções, ESTE Mac executa ----
// 1) tarefa pedida do celular (status='requested', minha) → cria e RODA aqui
const remoteStartFails={};
async function cloudRemoteStartTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  const me=cloudUserId();
  const rows=await sbGet('tasks?select=*,projects(repo_remote)&status=eq.requested&assignee=eq.'+me+'&limit=3').catch(()=>[]);
  if(!rows.length) return;
  const here=await repoRemoteIds();
  for(const ct of rows){
    if((remoteStartFails[ct.id]||0)>=3) continue;
    const rr=(ct.projects||{}).repo_remote;
    if(rr && !remoteSame(rr, here)) continue; // é de outro projeto — outro Mac atende
    try{
      const sp=ct.spec||{};
      const payload={ workflow:null, agents:null, engine:sp.engine||defaultAiEngine(), model:sp.engine?(sp.model||null):defaultAiModel(), approval:'auto', owns:null, off:null,
        objective:sp.objective||ct.title, deliverables:[], requirements:Array.isArray(sp.requirements)?sp.requirements:[],
        doc:sp.doc||null, proof:!!sp.proof, tests:!!sp.tests, autoPr:sp.autoPr||'ask', prBase:null, planApproval:'auto', refs:[],
        branchType:sp.branchType||'feat', base:null, linkedTo:null,
        // tarefa de ÉPICO: os campos do cartão vão pro TASK.yaml (bloco epic)
        issue:(sp.issueCode||'').trim()||null, issueUrl:sp.issueUrl||ct.issue_url||null,
        epicId: ct.epic_id||null, epicDoneWhen:(typeof epicDoneWhenOf==='function'?epicDoneWhenOf(ct.epic_id):null), verify:sp.verify||null, covers:sp.covers||null, after:sp.after||null, wave:sp.wave||null, risk:sp.risk||null, hitl:sp.hitl||null, boundaries:sp.boundaries||null,
        title: ct.title, start:true };
      if(ct.epic_id && window.epicAttachRef) await epicAttachRef(payload, ct.epic_id, ct);
      const localId=await invoke('new_task', await trkBeforeNewTask(payload));
      tmapSet(localId, ct.id);
      await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'PATCH', body: JSON.stringify({ status:'running', local_id: localId }) });
      if(ct.epic_id && window.epicMarkInProgress) epicMarkInProgress(ct.epic_id);
      sbPost('task_activity',{ task_id:ct.id, user_id:me, kind:'started', body:'iniciada do celular' }).catch(()=>{});
      sbPost('task_feed',{ task_id:ct.id, agent:'Sistema', kind:'note', text:'▶ o Mac assumiu: criando worktree e iniciando o agente…' }).catch(()=>{});
      teamTasks=null; lastSig='';
    }catch(e){ remoteStartFails[ct.id]=(remoteStartFails[ct.id]||0)+1; console.error('remoteStart', e.message); }
  }
}
tickLoop('cloudRemoteStartTick', cloudRemoteStartTick, 6000);

// 2) feed condensado ao vivo: eventos novos das MINHAS tarefas mapeadas → task_feed
// @feedpos-inicio
const feedPosKey=()=>userKey('sb:feedpos', cloudUserId());
const feedPos=lsJsonMemo(feedPosKey);
function feedPosSet(lid, id){ const m={ ...feedPos() }; m[lid]=id; lsSet(feedPosKey(), JSON.stringify(m)); }
const FEED_KINDS=new Set(['think','note','bash','error','done','edit','write']);
// @feedpos-fim
async function cloudFeedTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  await cloudFeedRepair();
  const m=tmap(); const pos=feedPos();
  // eventos novos agrupados por tarefa numa passada só (antes: filtro dos 1200 eventos × cada tarefa do tmap)
  const byLid={};
  for(const e of (state.events||[])){
    const lid=e.taskId||e.task_id;
    if(!m[lid] || !(e.id>(pos[lid]||0)) || !FEED_KINDS.has(e.type||e.kind)) continue;
    const a=byLid[lid]||(byLid[lid]=[]); if(a.length<8) a.push(e);
  }
  for(const lid in byLid){
    const evs=byLid[lid];
    try{
      // 1 POST em lote por tarefa (antes: 1 por evento, em série) e o cursor avança logo depois:
      // a volta seguinte nunca reposta o mesmo evento (o laço não sobrepõe — tickLoop)
      await sbPost('task_feed', evs.map(e=>({ task_id:m[lid], agent:e.agent||'', kind:(e.type||e.kind), text:String(e.text||'').slice(0,300) })));
      feedPosSet(lid, evs[evs.length-1].id);
      invoke('web_log',{line:'[feed] +'+evs.length+' → '+lid}).catch(()=>{});
    }catch(err){
      // cartão apagado na nuvem (FK) ou RLS: avança o cursor pra não travar a
      // fila — um lid quebrado NUNCA pode segurar o feed dos outros.
      feedPosSet(lid, evs[evs.length-1].id);
      console.error('feed '+lid+': '+(err.message||err));
    }
  }
}
tickLoop('cloudFeedTick', cloudFeedTick, 4000);

// 3) chat do celular → entrega ao agente (fila do motor cuida do turno ocupado)
// Regras (48: mobileMsgPlan/mobileMsgRetry): teto de custo aberto SEGURA a mensagem (avisa uma vez no feed);
// falha na entrega devolve a mensagem pra fila (até 3x) e avisa no feed — antes ela era marcada entregue e sumia.
const msgDelivering=new Set(), msgFails={}, msgHeld=new Set();
async function cloudMsgTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return; // só a conta da vez, com o mapa dela
  // tarefas do projeto aberto (mais novas primeiro, até 60) — antes a URL levava TODOS os ids do tmap
  const m=tmap(); const lids=cloudTaskIds(m, 60, false); if(!lids.length) return;
  const rows=await sbGet('task_messages?select=id,task_id,body,author&delivered_at=is.null&task_id=in.'+pgIn(lids.map(l=>m[l]))+'&order=id&limit=5').catch(()=>[]);
  for(const msg of rows){
    if(msgDelivering.has(msg.id)) continue;
    const lid=Object.keys(m).find(k=>m[k]===msg.task_id); if(!lid) continue;
    const budgetOpen=(state.pending||[]).some(p=>p.taskId===lid && (p.kind==='budget'||+p.id<0));
    const plan=mobileMsgPlan(msg.body, { budgetOpen });
    if(plan.kind==='hold'){
      if(!msgHeld.has(msg.id)){ msgHeld.add(msg.id); sbPost('task_feed',{ task_id:msg.task_id, agent:'Sistema', kind:'note', text:'Mensagem do celular na fila: a tarefa está pausada no teto de custo — responda o teto (continuar ou parar) e ela segue pro agente.' }).catch(()=>{}); }
      continue;
    }
    msgDelivering.add(msg.id);
    try{
      await sbFetch('/rest/v1/task_messages?id=eq.'+msg.id, { method:'PATCH', body: JSON.stringify({ delivered_at:new Date().toISOString() }) });
      try{
        if(plan.kind==='img'){
          // FOTO do celular: baixa pra .cardume/refs e manda o agente ABRIR
          const local=await invoke('fetch_task_ref',{ taskId: lid, url:SB.url(), anon:SB.key(), token:SB.sess().access_token, path: plan.path });
          const m2=`[anexo] O humano anexou uma IMAGEM do celular em ${local} — ABRA e analise (tool Read) antes de responder.${plan.caption?`\nLegenda: ${plan.caption}`:''}`;
          await invoke('talk_task',{ taskId: lid, message: m2, asReq:false, agent:null });
          sbPost('task_feed',{ task_id:msg.task_id, agent:'Você', kind:'note', text:'Você: imagem anexada'+(plan.caption?': '+plan.caption.slice(0,200):'') }).catch(()=>{});
        } else if(plan.kind==='talk'){
          // "[req] ..." vindo do celular = adicionar como REQUISITO da tarefa (checklist)
          await invoke('talk_task',{ taskId: lid, message: plan.text, asReq:plan.asReq, agent:null });
          sbPost('task_feed',{ task_id:msg.task_id, agent:'Você', kind:'note', text:'Você: '+plan.text.slice(0,280) }).catch(()=>{});
        }
        delete msgFails[msg.id];
      }catch(e){
        msgFails[msg.id]=(msgFails[msg.id]||0)+1;
        if(mobileMsgRetry(msgFails[msg.id])==='retry'){
          // devolve pra fila: a próxima volta tenta de novo (o celular continua vendo "na fila")
          await sbFetch('/rest/v1/task_messages?id=eq.'+msg.id, { method:'PATCH', body: JSON.stringify({ delivered_at:null }) }).catch(()=>{});
        } else {
          sbPost('task_feed',{ task_id:msg.task_id, agent:'Sistema', kind:'error', text:'A mensagem do celular não chegou ao agente: '+String((e&&e.message)||e).slice(0,160)+' — mande de novo.' }).catch(()=>{});
        }
        throw e;
      }
    }catch(e){ console.error('msg', e.message||e); }
    finally{ msgDelivering.delete(msg.id); }
  }
}
tickLoop('cloudMsgTick', cloudMsgTick, 5000);

// ---- backlog do time (aba Time) ----
let teamTasks=null, teamProj={}, teamProfiles={}, teamFetchedAt=0, teamRepoRemote='', teamRepoIds=null, teamFetching=false, teamPaintSig='', teamEpics=[], teamActivity=[];
let tmView=lsGet('tmView')||'overview';
// escopo da aba Time: 'team' (o time escolhido em Conta, no rodapé da barra lateral) ou 'org' (TODOS os times — só owner/admin,
// que já enxergam tudo pela RLS; é a visão de super usuário da empresa)
let tmScope=lsGet('tmScope')||'team';
function tsIsOrgAdmin(){ return !!(cloudData && (cloudData.meRole==='owner'||cloudData.meRole==='admin')); }
function tsOrgScope(){ return tmScope==='org' && tsIsOrgAdmin() && !!(cloudData&&cloudData.teams&&cloudData.teams.length); }
function tsScopeTeamIds(){ return tsOrgScope() ? cloudData.teams.map(t=>t.id) : (cloudTeamId()?[cloudTeamId()]:[]); }
function tsTeamName(id){ return ((((cloudData&&cloudData.teams)||[]).find(x=>x.id===id))||{}).name||''; }
// o MESMO alcance da Central (71: "Do time"/"Org toda") — trocar aqui troca lá (a Central em "Minhas" fica como está)
function tsSetScope(s){ tmScope=s==='org'?'org':'team'; lsSet('tmScope',tmScope); teamTasks=null; teamPaintSig=''; if(typeof caFromTeamScope==='function') caFromTeamScope(tmScope); if(typeof renderTeamBoard==='function') renderTeamBoard(); }
// presença: marca "estou online" a cada 60s (profiles.last_seen_at)
setInterval(()=>{ if(SB.sess()) sbFetch('/rest/v1/profiles?user_id=eq.'+cloudUserId(), { method:'PATCH', body: JSON.stringify({ last_seen_at: new Date().toISOString() }) }).catch(()=>{}); }, 60000);
// versão: o build deste app (mtime do executável = buildMs do release) + sistema, pra /admin ver quem está
// desatualizado. PATCH SEPARADO da presença: banco sem a migration 0029 não pode derrubar o "online".
// Manda no boot, depois de logar e a cada 30 min (o build só muda quando o app é atualizado e reaberto).
let appVerSent='';
async function appVersionPing(){
  try{
    if(!SB.sess()) return;
    const ms=Number(await invoke('build_info'))||0; if(!ms) return;
    const os=(typeof osKind==='function')?osKind():'';
    const key=cloudUserId()+'|'+ms+'|'+os; if(key===appVerSent) return;
    await sbFetch('/rest/v1/profiles?user_id=eq.'+cloudUserId(), { method:'PATCH', body: JSON.stringify({ app_build_ms: ms, app_os: os||null, app_build_seen_at: new Date().toISOString() }) });
    appVerSent=key;
  }catch(_){ /* sem a coluna ainda / offline: tenta no próximo ciclo */ }
}
setTimeout(appVersionPing, 8000);
setInterval(()=>{ appVerSent=''; appVersionPing(); }, 30*60000);
let teamFetchP=null; // promise compartilhada: chamadas concorrentes esperam o MESMO fetch
function teamFetch(force){
  if(teamFetchP) return teamFetchP;
  if(!force && teamTasks && Date.now()-teamFetchedAt<10000) return Promise.resolve();
  teamFetchP=teamFetchRun().finally(()=>{ teamFetchP=null; });
  return teamFetchP;
}
async function teamFetchRun(){
  teamFetching=true;
  try{
    const teamId=cloudTeamId(); if(!teamId) return;
    const ids=tsScopeTeamIds(); if(!ids.length) return;
    const inq='team_id=in.('+ids.map(i=>'"'+i+'"').join(',')+')';
    const [tasks, projs, eps, acts]=await Promise.all([
      sbGet('tasks?select=*&'+inq+'&order=updated_at.desc&limit='+(ids.length>1?600:200)),
      sbGet('projects?select=id,name,repo_remote&'+inq),
      sbGet('epics?select=id,name,status,team_id,spec,created_by,created_at,updated_at&'+inq+'&status=neq.archived&order=created_at').catch(()=>sbGet('epics?select=id,name,status,team_id&'+inq+'&status=neq.archived&order=created_at')).catch(()=>[]), // fallback: nuvem sem a 0025
      sbGet('task_activity?select=id,task_id,user_id,kind,body,at&order=id.desc&limit=60').catch(()=>[]),
    ]);
    teamEpics=eps||[]; teamActivity=acts||[];
    teamProj={}; projs.forEach(p=>teamProj[p.id]=p);
    const uids=new Set(); tasks.forEach(t=>{ uids.add(t.created_by); if(t.assignee) uids.add(t.assignee); });
    (teamActivity||[]).forEach(a=>uids.add(a.user_id));
    ids.forEach(tid=>((cloudData&&cloudData.teamMembers&&cloudData.teamMembers[tid])||[]).forEach(m=>uids.add(m.user_id)));
    if(tsOrgScope()) ((cloudData&&cloudData.orgMembers)||[]).forEach(m=>uids.add(m.user_id)); // membro da org sem time também aparece
    if(uids.size){ const profs=await sbGet('profiles?select=user_id,name,email,last_seen_at&user_id=in.('+[...uids].map(u=>'"'+u+'"').join(',')+')'); teamProfiles={}; profs.forEach(p=>teamProfiles[p.user_id]=p); }
    { const ids=await repoRemoteIds(); teamRepoRemote=ids.remote; teamRepoIds=ids; }
    await localRemoteIdsList().catch(()=>[]); // cartão de projeto que não existe nesta máquina ganha o aviso (tsCardHtml)
    teamTasks=tasks; teamFetchedAt=Date.now();
  } finally { teamFetching=false; }
}
// nome de quem criou/assumiu: fonte única em 08-pessoas (personName) — "você", nome, parte do e-mail ou
// "pessoa sem nome"; nunca o id nem "alguém do time". O perfil que falta vem em lote (personFetchMissing).
function tmName(uid){ return personName(uid); }
