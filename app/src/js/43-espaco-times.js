// Starfork — 43-espaco-times
// ============================================================================
// ESPAÇO TIMES (redesign aprovado): sidebar do time + Visão geral · Quadro ·
// PRs · Pessoas · Atividade. Tudo com os dados que o backend já entrega.
// ============================================================================
const TS_DOING=['running','thinking','queued','plan-review'];
function tsBuckets(){ return {
  backlog: t=>t.flag!=='closed'&&t.status==='backlog',
  doing:   t=>t.flag!=='closed'&&(TS_DOING.includes(t.status)||t.status==='error'||t.status==='conflict'),
  review:  t=>t.flag!=='closed'&&(t.status==='review'||t.status==='delivered'),
  done:    t=>t.flag==='closed'||['merged','done'].includes(t.status),
}; }
function tsOnline(uid){ const p=teamProfiles[uid]; return p&&p.last_seen_at && (Date.now()-new Date(p.last_seen_at).getTime()<180000); }
// cartão da NUVEM no formato que a regra única da Central entende (flowBucket/taskSt do 22):
// id = local_id (assim a pergunta aberta de uma tarefa SUA conta como "aguardando"), pr_url → prUrl
// (cancelada = encerrada: na Central ela sai da fila junto com o flag closed; na nuvem às vezes só o status sobe)
// R5-2: se o cartão é de uma tarefa LOCAL desta máquina, o status local vence (a nuvem atrasa e o espelho
// achata 'plan-review' em 'running') — assim o Time conta igual à Central
let tsLocalIdx={ src:null, m:{} };
function tsLocalOf(t){
  const src=(typeof state!=='undefined'&&state.tasks)||[];
  if(tsLocalIdx.src!==src){ const m={}; src.forEach(x=>{ m[x.id]=x; }); tsLocalIdx={ src, m }; }
  return (t&&t.local_id&&tsLocalIdx.m[t.local_id])||null;
}
function tsNorm(t){
  const n=Object.assign({}, t, { id:t.local_id||t.id, prUrl:t.pr_url||null, createdAt:t.created_at?+new Date(t.created_at):0, flag:(t.status==='cancelled'?'closed':t.flag) });
  const lt=tsLocalOf(t);
  if(lt){ n.status=lt.status; n.flag=lt.flag||n.flag; n.prUrl=lt.prUrl||n.prUrl; }
  return n;
}
function tsBucket(t){ return flowBucket(tsNorm(t)); }
function tsSt(t){ return taskSt(tsNorm(t)); }
// @atrap-time-inicio (testado em app/tests/atrap-fabrica.test.mjs)
// DE QUEM é o cartão: o responsável; sem responsável, quem criou. A regra ÚNICA de pessoa do Time (A10: KPI "dev ativo",
// "Agora no time", "Entregas por membro", Pessoas e o filtro por dev contavam cada um de um jeito)
function tsWho(t){ return (t&&(t.assignee||t.created_by))||''; }
// "em andamento" = MESMA etapa da Central (antes: running/thinking/queued/plan-review, e plano pra aprovar contava como rodando)
function tsRunningOf(uid){ return (teamTasks||[]).filter(t=>tsWho(t)===uid && tsBucket(t)==='andamento'); }
// revisão: ao assumir, a Central abre na Execução com a tarefa selecionada SEM zerar busca e filtros — limpa só o
// filtro que esconderia ESTA tarefa. f = filtros atuais; fn = { bucket, type, agents, inPeriod }. Devolve os nomes a limpar.
function tsClaimHiders(t, f, fn){
  if(!t) return [];
  const out=[], q=String(f.query||'').trim().toLowerCase();
  if(q && !String(t.title||'').toLowerCase().includes(q)) out.push('busca');
  if(f.status && f.status!=='all' && fn.bucket(t)!==f.status) out.push('situação');
  if(f.epic && f.epic!=='all' && ((t.epic&&t.epic.epicId)||'')!==f.epic) out.push('épico');
  if(f.type && f.type!=='all' && fn.type(t)!==f.type) out.push('tipo');
  if(f.agent && f.agent!=='all' && !(fn.agents(t)||[]).includes(f.agent)) out.push('agente');
  if(!fn.inPeriod(t)) out.push('período');
  if(f.proj && f.proj!=='all' && f.proj!==f.repo) out.push('projeto');
  return out;
}
// @atrap-time-fim
function tsClaimShow(localId){
  try{ selected=localId; }catch(_){ }
  flowScope='exec'; lsSet('flowScope','exec');
  const t=((typeof state!=='undefined'&&state.tasks)||[]).find(x=>x.id===localId);
  const h=t?tsClaimHiders(t, { query:flowQuery, status:flowStatus, epic:flowEpic, type:flowType, agent:flowAgent, proj:projFilter, repo:state.repo },
    { bucket:flowBucket, type:taskType, agents:taskAgents, inPeriod }):[];
  const set={ 'busca':()=>{ flowQuery=''; ['topSearch','ffSearch'].forEach(id=>{ const e=$id(id); if(e) e.value=''; }); }, 'situação':()=>{ flowStatus='all'; flowSetF('flowStatus','all'); },
    'épico':()=>{ flowEpic='all'; flowSetF('flowEpic','all'); }, 'tipo':()=>{ flowType='all'; flowSetF('flowType','all'); }, 'agente':()=>{ flowAgent='all'; flowSetF('flowAgent','all'); },
    'período':()=>{ flowPeriod='all'; flowSetF('flowPeriod','all'); }, 'projeto':()=>{ projFilter='all'; lsSet('projFilter','all'); } };
  h.forEach(k=>set[k]&&set[k]());
  if(window.openTab) window.openTab('flow');
  if(typeof curView==='function' && curView()!=='flow') setView('flow'); else { lastSig=''; if(typeof render==='function') render(); }
  return h;
}
// iniciais como no resto do app ("Douglas S." → DS; e-mail → só a parte antes do @)
function tsIni(n){ const w=String(n||'?').replace(/@.*/,'').split(/[\s._-]+/).filter(Boolean); return ((w.length>1?w[0][0]+w[1][0]:(w[0]||'?').slice(0,2))).toUpperCase(); }
function tsAv(uid, on){ const n=tmName(uid); return `<span class="tsav${on?' on':''}" style="background:${agentColor(n)}" title="${escA(n)}">${esc(tsIni(n))}</span>`; }
function tsPeriodTasks(){ const per=lsGet('tmPeriod')||'all'; const cut=per==='all'?0:Date.now()-parseInt(per,10)*86400e3; return (teamTasks||[]).filter(t=>!cut||new Date(t.updated_at).getTime()>=cut); }
// fase (1–5) e % de um cartão da NUVEM — mesma régua da Central
function ctPhase(t){
  if(['merged','done'].includes(t.status)) return 5;
  if(t.pr_url) return 5;
  if(['review','delivered'].includes(t.status)) return 4;
  if(['running','thinking','error','conflict'].includes(t.status)) return 3;
  if(['queued','requested'].includes(t.status)) return 2;
  return 1;
}
function ctPct(t){
  if(['merged','done'].includes(t.status)) return 100;
  if(t.pr_url) return 92;
  const rp=t.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  const frac=(list&&list.length)?list.filter(x=>x.status==='done').length/list.length:null;
  if(['review','delivered'].includes(t.status)) return Math.round(80+(frac==null?5:frac*15));
  if(['queued','requested'].includes(t.status)) return 15;
  if(t.status==='backlog') return 0; // na fila: nada feito ainda (5% sugeria progresso)
  return Math.round(35+(frac==null?10:frac*40));
}
function ctPhaseBar(t){
  const ph=ctPhase(t), p=ctPct(t);
  return `<div class="ctph"><span class="segs">${[1,2,3,4,5].map(i=>`<i class="${i<=ph?'on':''}"></i>`).join('')}</span><span class="mono pctx">${p}%</span></div>`;
}
function tsCardHtml(t, me, isAdmin){
  const proj=teamProj[t.project_id]||{};
  const sameRepo=!proj.repo_remote||remoteSame(proj.repo_remote, teamRepoIds||{ remote:teamRepoRemote });
  // projeto que não existe nesta máquina (nenhum projeto local com esse remote): aparece no Time, marcado, sem ▶
  const here=((typeof localRemoteList!=='undefined'&&localRemoteList)||[]).concat(teamRepoIds?[teamRepoIds]:[]);
  const isLocal=sameRepo||ctProjLocal(proj, here);
  // cartão de colega não se toma (0032): assumir só livre ou já meu
  const canClaim=t.status==='backlog' && (t.claim_mode==='open'||t.created_by===me) && (!t.assignee||t.assignee===me);
  const whoTx=ctWhoLabel(t, me, tmName); // "criada por Fulano" — o que é todo meu não ganha nada
  const ep=t.epic_id?(teamEpics.find(e=>e.id===t.epic_id)||{}).name:'';
  const rp=t.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  const prov=list&&list.length?`<span class="tspv"><b>${IC.ok}</b>${list.filter(x=>x.status==='done').length}/${list.length} provados</span>`:'';
  const who=tsWho(t);
  const bk=tsBucket(t), st=tsSt(t);
  const running=bk==='andamento' && t.status!=='backlog';
  const isErr=bk==='aguardando';
  const obj=mdPlain(String((t.spec||{}).objective||'').slice(0,1200)).slice(0,160); // resumo de 1 linha: sem ** / # / crases crus
  const reqs=((t.spec||{}).requirements||[]).filter(Boolean);
  const teamTag=(typeof tsOrgScope==='function'&&tsOrgScope())?`<span class="tsteamtag" title="time">${esc(tsTeamName(t.team_id)||'?')}</span>`:'';
  const epSt=(t.epic_id&&typeof epColor==='function')?` style="--epc:${epColor(t.epic_id)}"`:''; // F2: cor estável do épico
  return `<div class="tscard dcard-like${epSt?' has-ep':''}" data-ct="${escA(t.id)}"${epSt}>
    <div class="tt">${esc(mdTitle(t.title||''))}${teamTag}</div>
    ${obj?`<div class="dc-obj">${esc(obj)}</div>`:''}
    ${reqs.length?`<div class="dc-reqs">${reqs.slice(0,3).map((r,i)=>{ const p=list&&list.find(x=>reqNorm(x.req)===reqNorm(r)); const st=p?(p.status==='done'?'ok':'blk'):'na'; return `<span class="dc-req ${st}"><i>${st==='ok'?IC.ok:st==='blk'?IC.stErr:''}</i><span class="dc-rt" title="${escA(mdPlain(r))}">${esc(mdPlain(r))}</span></span>`; }).join('')}${reqs.length>3?`<span class="dc-more">+${reqs.length-3}</span>`:''}</div>`:''}
    ${ctPhaseBar(t)}
    <div class="meta">${ep?`<span class="tsepc" title="${escA('épico “'+ep+'”'+((t.spec||{}).wave?' · onda '+(t.spec||{}).wave:''))}">${IC.epic} ${esc(ep)}${(t.spec||{}).wave?' · onda '+esc(String((t.spec||{}).wave)):''}</span>`:''}${t.pr_url?`<button class="tslk" data-lk="${escA(t.pr_url)}" title="abrir o Pull Request no GitHub" style="color:var(--info)">PR ${icEm(IC.extlink)}</button>`:''}${tsIssueChip(t, proj)}${t.branch?`<span class="mono tsbr" title="${escA(t.branch)}">${esc(t.branch.split('/').pop())}</span>`:''}${(t.cost_usd>0&&tsCostOk(t, me))?`<span>${fmtUsd(+t.cost_usd)}</span>`:''}${t.claim_mode==='reserved'?'<span class="tmbadge" style="font-size:var(--fs-xs)">pra si</span>':''}${isLocal?'':`<span class="tsnolocal" title="${escA('nenhum projeto aberto nesta máquina tem o repositório '+(proj.repo_remote||'')+' — clone a pasta e adicione em Projetos pra poder assumir')}">projeto que você não tem neste computador</span>`}</div>
    ${whoTx?`<div class="tswho" title="${escA(whoTx)}">${esc(whoTx)}</div>`:''}
    <div class="foot">${t.assignee?tsAv(t.assignee, tsOnline(t.assignee)):`<span class="tsav tmfree" title="sem responsável — quem assumir aparece aqui" aria-label="sem responsável">·</span>`}${!t.assignee?'<span class="tsowner dim">sem dono</span>':t.assignee===me?'<span class="tsowner">com você</span>':(t.assignee===t.created_by?`<span class="tsowner" title="${escA('com '+tmName(t.assignee))}">${esc(tmName(t.assignee).split(/\s+/)[0])}</span>`:'')}${prov}<span style="flex:1"></span>
      ${isErr?`<span class="tstag" style="color:${stColor(st)};border:1px solid currentColor">${esc(stLabel(st))}</span>`:running?`<span class="tstag run">${esc(stLabel(st))}</span>`:ctWaiting(t)?`<span class="tstag" title="começa sozinha quando as tarefas da onda anterior forem concluídas ou mergeadas (onda = grupo de tarefas que rodam juntas)">na espera da onda anterior</span>`:''}
      ${tsActsHtml(t, me, canClaim, sameRepo, isLocal, proj)}
      ${(t.status==='backlog'&&(t.created_by===me||isAdmin))?`<button class="btn sm" data-act="del" style="padding:3px 7px;font-size:var(--fs-xs)">${IC.x}</button>`:''}
    </div></div>`;
}
// issue do cartão: o vínculo gravado (spec.issueCode/issue_url — o painel cria quando o cartão nasce) ou o código na
// branch/título; painel ligado pro projeto e cartão sem issue → selo "sem issue · criar" (tenta de novo, com o motivo)
function tsIssueChip(t, proj){
  const l=(typeof trkCardLink==='function'&&trkCardLink(t))||null;
  const c=(l&&l.code)||(((t.branch||'')+' '+(t.title||'')).match(/\b([A-Z]{2,10}-\d+)\b/)||[])[1]||'';
  const b=(lsGet('issueBase')||'').trim(), url=(l&&l.url)||(c&&b?b.replace(/\/+$/,'')+'/'+c:'');
  if(c||url) return url?`<button class="tslk" data-lk="${escA(url)}" title="abrir a issue no painel">${c?`<span class="mono">${esc(c)}</span>`:'issue'} ${icEm(IC.extlink)}</button>`:`<span class="mono" title="issue no painel">${esc(c)}</span>`;
  if(typeof trkCardMissing==='function' && trkCardMissing(t, proj)) return `<button class="tslk tsnoiss" data-act="issue" title="o painel de Issues cobre este projeto, mas este cartão ficou sem issue — clique pra criar agora">sem issue · criar</button>`;
  return '';
}
// ---- ASSUMIR / INICIAR / DEVOLVER (mesa 09/10, T3–T4) ----
// Assumir = só o MEU nome no cartão (o time inteiro vê); Iniciar = roda nesta máquina; "assumir e iniciar" é o atalho.
// Cartão de colega não se toma (0032); líder/admin trocam o responsável. Devolver = volta pra livre (nunca rodando).
// custo do cartão: só pra quem atribui (líder/owner/admin) ou pro dono dele (T8 — custo por pessoa não vira ranking)
function tsCostOk(t, me){ return (typeof entPodeVerCusto==='function'?entPodeVerCusto():tmCanAssignNow()) || tsWho(t)===me; } // a MESMA regra da aba Entregas (70)
const TS_LIVE=new Set(['running','thinking','plan-review','queued']);
function tsActsHtml(t, me, canClaim, sameRepo, isLocal, proj){
  const B=(act, label, title, cls)=>`<button class="btn sm${cls?' '+cls:''}" data-act="${act}" title="${escA(title)}" style="padding:3px 9px;font-size:var(--fs-xs)">${label}</button>`;
  const can=tmCanAssignNow(), out=[];
  const openProj=!sameRepo&&isLocal?B('openproj','abrir '+esc(proj.name||'o projeto'),'a tarefa é do projeto '+(proj.name||proj.repo_remote||'')+' — abrir ele aqui pra iniciar',''):'';
  if(t.status==='backlog'){
    if(!t.assignee && canClaim){
      out.push(B('claimonly','assumir','pôr o seu nome no cartão — o time vê que é você; nada roda ainda','primary'));
      if(sameRepo) out.push(B('claim',`${IC.play}<span class="sr-only">assumir e iniciar</span>`,'assumir e iniciar agora nesta máquina','ghost'));
      else if(openProj) out.push(openProj);
    } else if(t.assignee===me){
      out.push(sameRepo?B('claim',`${IC.play} iniciar`,'iniciar nesta máquina — a tarefa vai pra sua Execução','primary'):openProj);
      out.push(B('release','devolver','tirar o seu nome — o cartão volta a ficar livre pro time','ghost'));
    } else if(t.assignee && can) out.push(B('release','devolver','tirar o responsável — o cartão volta a ficar livre','ghost'));
    if(can) out.push(B('reassign',t.assignee?'trocar':'atribuir','escolher quem do time fica com o cartão','ghost'));
  } else if(!TS_LIVE.has(t.status) && !t.pr_url && !['review','delivered','merged','done'].includes(t.status) && t.flag!=='closed' && (t.assignee===me || (t.assignee && can))){
    out.push(B('release','devolver','o agente não está rodando — devolver o cartão pro time (volta pra fila, livre)','ghost'));
  }
  return out.join('');
}
// só o meu nome (sem rodar)
async function tsClaimOnly(ct, btn){
  if(btn){ btn.disabled=true; btn.textContent='assumindo…'; }
  try{
    if(ct.assignee && ct.assignee!==cloudUserId()) throw new Error('já está com '+tmName(ct.assignee)+' — peça pra devolver, ou ao líder do time pra trocar'); // vale mesmo com a nuvem sem a 0032
    const j=await sbRpc('claim_task',{ p_task:ct.id });
    if(!j||!j.ok) throw new Error((j&&j.error)||'não deu pra assumir');
    ct.assignee=cloudUserId(); if(typeof trkCardAssign==='function') trkCardAssign(ct, ct.assignee);
    teamTasks=null; teamPaintSig=''; lastSig=''; renderTeamBoard(); refresh().catch(()=>{});
    toast('Você assumiu “'+String(ct.title||'').slice(0,60)+'” — o time vê seu nome. Inicie quando quiser.','ok');
  }catch(e){ showErr(e, 'Não deu pra assumir'); if(btn){ btn.disabled=false; btn.textContent='assumir'; } }
}
async function tsRelease(ct, btn){
  if(!await askYes('O cartão volta pra fila do time, livre, e quem criou é avisado.', 'Devolver “'+String(ct.title||'').slice(0,60)+'”?')) return;
  if(btn){ btn.disabled=true; btn.textContent='devolvendo…'; }
  try{ await cloudAssign(ct.id, null); ct.assignee=null; teamTasks=null; teamPaintSig=''; lastSig=''; renderTeamBoard(); refresh().catch(()=>{}); toast('Devolvido — “'+String(ct.title||'').slice(0,60)+'” está livre pro time.','ok'); }
  catch(e){ showErr(e, 'Não deu pra devolver'); if(btn){ btn.disabled=false; btn.textContent='devolver'; } }
}
// promessa resolve quando a troca termina (a página do cartão redesenha DEPOIS); tirar de um colega pede confirmação
function tsReassign(ct, btn){
  return new Promise(done=>{ tmWhoPick(btn, ct.assignee||'', async uid=>{
    try{
      if((uid||null)===(ct.assignee||null)) return;
      if(ct.assignee && ct.assignee!==cloudUserId() && !await askYes(tmName(ct.assignee)+' é avisado'+(uid?' e o cartão passa pra '+tmName(uid):' e o cartão fica livre')+'. Se ele já começou nesta máquina dele, combine antes.', 'Tirar “'+String(ct.title||'').slice(0,50)+'” de '+tmName(ct.assignee)+'?')) return;
      await cloudAssign(ct.id, uid); ct.assignee=uid||null; if(uid && typeof trkCardAssign==='function') trkCardAssign(ct, uid);
      teamTasks=null; teamPaintSig=''; lastSig=''; renderTeamBoard(); refresh().catch(()=>{});
      toast(uid?'“'+String(ct.title||'').slice(0,50)+'” agora está com '+tmName(uid)+'.':'“'+String(ct.title||'').slice(0,50)+'” ficou livre.','ok');
    }catch(e){ showErr(e, 'Não deu pra trocar o responsável'); }
    finally{ done(); } }); });
}
window.tsClaimOnly=tsClaimOnly; window.tsRelease=tsRelease; window.tsReassign=tsReassign; window.tsActsHtml=tsActsHtml;
function tsK(kind){ return {created:'criou',edited:'editou',claimed:'assumiu',released:'devolveu',assigned:'atribuiu',started:'iniciou',delivered:'publicou provas em',comment:'comentou em',status:'mudou o status de'}[kind]||kind; }
function renderTeamBoard(){
  const el=$id('teamBoard'); if(!el) return;
  if(!SB.sess() || !cloudTeamId()){
    // sem conta → a tela de entrada direto; com conta e sem time → a aba Conta (antes: "abrir Time na nuvem"
    // abria um painel intermediário que só tinha outro botão pra entrar)
    const noSess=!SB.sess();
    const html=`<div class="emptyrepo" style="display:flex">`+emptyHtml({ icon:'cloud', title:'Espaço do time',
      help: noSess?'Entre na sua conta pra ver o que o time está fazendo — tarefas, PRs e quem está em quê.':'Você ainda não está num time. Crie um ou aceite um convite em Conta e time.',
      action:{ id:'tbGo', label: noSess?'Entrar ou criar conta':'Abrir Conta e time' } })+`</div>`;
    if(teamPaintSig!==html){ teamPaintSig=html; el.innerHTML=html;
      $id('tbGo').onclick=()=>{ if(noSess && typeof auShow==='function') auShow(lsGet('sb:email')?'login':'signup'); else if(window.openTab) window.openTab('conta'); else openCloud(); }; }
    return;
  }
  if(!teamTasks){
    // uma carga por vez (o refresh chama isto a cada tick); falhou: o erro fica com "tentar de novo" (e só tenta sozinho após 30 s)
    if(el.__tbLoading || (el.querySelector(':scope>.ld-err') && Date.now()-(el.__tbErrAt||0)<30000)) return;
    teamPaintSig=''; el.__tbLoading=true;
    // o "tentar de novo" passa por aqui de novo (mesma guarda de 1 carga por vez; zera a espera de 30 s)
    const retry=()=>{ el.__tbErrAt=0; teamPaintSig=''; renderTeamBoard(); };
    loadInto(el, 'kanban', ()=>teamFetch(true).then(()=>{ if(!teamTasks) throw new Error('o time não respondeu'); }), ()=>{ teamPaintSig=''; renderTeamBoard(); },
      { label:'buscando as tarefas do time', ctx:'Não consegui carregar o espaço do time', shape:{ cols:4 }, retry })
      .then(r=>{ if(r==='fail') el.__tbErrAt=Date.now(); }, ()=>{ el.__tbErrAt=Date.now(); })
      .then(()=>{ el.__tbLoading=false; }); // o ldRun tem prazo (30 s): a trava sempre solta
    return;
  }
  if(Date.now()-teamFetchedAt>10000){ teamFetch().then(()=>renderTeamBoard()).catch(()=>{}); }
  // config do painel de Issues do time ATUAL (o selo "sem issue" depende dela): carrega uma vez por time; falhou, tenta de novo em 60 s
  if(typeof trkLoad==='function' && typeof trkLoadedFor!=='undefined' && trkLoadedFor!==cloudTeamId() && Date.now()-(renderTeamBoard.__trkAt||0)>60000){ renderTeamBoard.__trkAt=Date.now();
    trkLoad().then(()=>trkRepoRemote()).then(()=>{ teamPaintSig=''; renderTeamBoard(); }).catch(()=>{}); }
  const me=cloudUserId();
  const isAdmin=cloudData && (cloudData.meRole==='owner'||cloudData.meRole==='admin');
  const B=tsBuckets();
  const epSel=lsGet('tmEpic')||'';
  const devSel=lsGet('tmDev')||'';
  const all=teamTasks;
  let vis=all;
  if(epSel && teamEpics.some(e=>e.id===epSel)) vis=vis.filter(t=>t.epic_id===epSel);
  if(devSel) vis=vis.filter(t=>tsWho(t)===devSel);
  const orgScope=tsOrgScope();
  const teamName=orgScope?'toda a organização':esc((((cloudData&&cloudData.teams)||[]).find(x=>x.id===cloudTeamId())||{}).name||'Time');
  const scopeIds=tsScopeTeamIds();
  const members=[...new Set([ ...scopeIds.flatMap(tid=>(((cloudData&&cloudData.teamMembers)||{})[tid]||[]).map(m=>m.user_id)), ...(orgScope?((cloudData&&cloudData.orgMembers)||[]).map(m=>m.user_id):[]), ...all.flatMap(t=>[t.assignee,t.created_by]).filter(Boolean) ])];
  // times de cada pessoa (no escopo da org: etiquetas nos cartões de Pessoas)
  const teamsOf=uid=>scopeIds.filter(tid=>(((cloudData&&cloudData.teamMembers)||{})[tid]||[]).some(m=>m.user_id===uid));
  const roleOf=uid=>{ for(const tid of scopeIds){ const r=(((cloudData&&cloudData.teamMembers)||{})[tid]||[]).find(m=>m.user_id===uid); if(r&&r.role==='lead') return 'lead'; } return teamsOf(uid).length?'membro':'sem time'; };
  // reviews feitos pelo time (dedup): pr_url → quem revisou
  const tsRevBy={};
  all.forEach(t=>{ if(t.pr_url && (((t.spec||{}).kind==='review')||/^review (do |de )?pr/i.test(t.title||''))) tsRevBy[t.pr_url]=tsWho(t); });
  const tsRevChip=(u)=>u?`<span class="tstag" style="color:var(--good);border:1px solid currentColor" title="review já feito por ${escA(tmName(u))} — parecer no cartão dele">✓ revisado · ${esc(tmName(u).slice(0,14))}</span>`:'';
  const prs=all.filter(t=>t.pr_url && t.status!=='merged' && (t.spec||{}).kind!=='review');
  const fgn=tmapForeign(); const unsynced=(state.tasks||[]).filter(t=>!tmap()[t.id] && !fgn.has(t.id) && t.status!=='draft').length; // cartão de outra conta não conta
  // ---------- sidebar ----------
  const NAV=[['overview','Visão geral',''],['board','Quadro',String(vis.length)],['entregas','Entregas',typeof entAbertas==='function'?String(entAbertas(all)||''):''],['prs','PRs pra revisar',prs.length?String(prs.length):''],['linha','Linha',''],['people','Pessoas',String(members.length)],['feed','Atividade','']];
  // navegação do Time = ABAS HORIZONTAIS (mesma disposição das outras telas — sem menu lateral próprio)
  const subTabs=`<div class="ftabs" style="margin-bottom:16px">`+
    NAV.map(([k,l,n])=>`<button class="ft${tmView===k?' on':''}" data-tsv="${k}">${l}${n?` <span class="n${k==='prs'&&prs.length?' hot':''}" style="font-size:var(--fs-xs);opacity:.8">${n}</span>`:''}</button>`).join('')+
    `<span class="grow"></span>${isAdmin?`<span class="tsscope" title="owner/admin: alterna entre o time escolhido em Conta e a organização inteira"><button class="${orgScope?'':'on'}" data-tscope="team">meu time</button><button class="${orgScope?'on':''}" data-tscope="org">toda a organização</button></span>`:''}<span class="dim tsnavlbl" style="font-size:var(--fs-xs);align-self:center;white-space:nowrap">${orgScope?`${nPl((cloudData.teams||[]).length,'time','times')} · ${nPl(((cloudData.orgMembers)||[]).length,'pessoa','pessoas')}`:'time '+teamName}</span></div>`;
  let side=``;
  // épicos viram CHIPS (no Quadro) — membros vivem na vista Pessoas
  // épicos: UM seletor (ativos primeiro, concluídos num grupo à parte) — a parede de chips empurrava o quadro pra baixo
  // ativo = regra única do 69 (epAtivo): épico entregue ("pronto quando" todo provado, ou todas as tarefas entregues) sai
  // dos ativos e vai pro grupo "concluídos" — mesmo número no cabeçalho, no KPI e no seletor
  const epTs=e=>all.filter(t=>t.epic_id===e.id);
  const epActive=e=>typeof epAtivo==='function'?epAtivo(e, epTs(e)):(e.status!=='done'&&e.status!=='archived');
  const epNameN={}; teamEpics.forEach(e=>{ epNameN[e.name]=(epNameN[e.name]||0)+1; });
  const epOpt=e=>{ const ts=all.filter(t=>t.epic_id===e.id); const done=ts.filter(epDelivered).length;
    const dup=epNameN[e.name]>1&&e.created_at?' · '+new Date(e.created_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}):'';
    return `<option value="${escA(e.id)}"${epSel===e.id?' selected':''}>${esc(e.name)}${dup} — ${done}/${ts.length}</option>`; };
  const epA=teamEpics.filter(epActive), epD=teamEpics.filter(e=>!epActive(e));
  const epicChips=(teamEpics.length?`<select class="sel tsepsel" id="tbEpic" aria-label="filtrar o quadro por épico"><option value="">todos os épicos</option>${epA.length?`<optgroup label="ativos (${epA.length})">${epA.map(epOpt).join('')}</optgroup>`:''}${epD.length?`<optgroup label="concluídos (${epD.length})">${epD.map(epOpt).join('')}</optgroup>`:''}</select>`
    +(epSel&&teamEpics.some(e=>e.id===epSel)?`<button class="btn sm" data-epopen="${escA(epSel)}" title="abrir a página do épico">abrir épico</button>`:''):'')+
    `<button class="btn sm quiet" id="tbEpicAdd">+ épico</button>`;
  // o cabeçalho da página (68-casca-g1 › timeHeadPaint) usa ESTAS contagens — as mesmas das abas
  window._timeSum={ n:members.length, eps:epA.length, prs:prs.length };
  if(typeof timeHeadPaint==='function') safe(timeHeadPaint);
  // ---------- main por vista ----------
  let main='';
  // T8: custo POR PESSOA só pra líder do time ou owner/admin da org; cada um sempre vê o próprio
  const veCustoDe=uid=>uid===me || (typeof entPodeVerCusto==='function'?entPodeVerCusto():isAdmin);
  const perNow=lsGet('tmPeriod')||'all';
  const perSel=`<select class="sel" id="tbPeriod" aria-label="período" style="width:120px">${[['7','últimos 7 dias'],['30','30 dias'],['90','trimestre'],['all','tudo']].map(([v,l])=>`<option value="${v}"${v===perNow?' selected':''}>${l}</option>`).join('')}</select>`;
  const devOpts=`<select class="sel" id="tbDev" aria-label="filtrar por dev" style="width:140px"><option value="">todos os devs</option>${members.map(u=>`<option value="${escA(u)}"${u===devSel?' selected':''}>${esc(tmName(u))}</option>`).join('')}</select>`;
  if(tmView==='overview'){
    const inP=tsPeriodTasks();
    // entregue = a regra ÚNICA epDelivered (mergeada/concluída/finalizada) — pronta pra revisar ainda não conta (= Quadro, épico, Linha)
    const done=inP.filter(epDelivered).length;
    // MESMA contagem da Central (flowCounts sobre os cartões normalizados)
    const fcT=flowCounts(all.map(tsNorm).filter(t=>t.flag!=='blocked'));
    const doing=all.filter(t=>tsBucket(t)==='andamento');
    const nDevs=members.filter(u=>tsRunningOf(u).length).length;
    const asking=all.filter(t=>t.assignee===me&&false); // pergunta real vem do desktop de cada dev
    const custo=inP.reduce((s,t)=>s+(+t.cost_usd||0),0);
    const activeEps=teamEpics.filter(epActive); // B2: concluído (e entregue) não é "ativo"
    const eps=activeEps.length;
    // entregas por dia (últimos 7)
    const days=[...Array(7)].map((_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(6-i)); d.setHours(0,0,0,0); return d; });
    const perDay=days.map(d=>all.filter(t=>epDelivered(t) && new Date(t.updated_at)>=d && new Date(t.updated_at)<new Date(+d+86400e3)).length);
    const mx=Math.max(1,...perDay);
    const DL=['dom','seg','ter','qua','qui','sex','sáb'];
    main=`<h1>Visão geral</h1><div class="tssub">time ${teamName}${perSel}</div>
    <div class="tskpis">
      <div class="tskpi"><div class="v">${done}</div><div class="l">entregues</div><div class="d">${inP.length} tarefas no período · pronta pra revisar ainda não conta</div></div>
      <div class="tskpi"><div class="v" style="color:var(--accent)">${doing.length}</div><div class="l">em andamento</div><div class="d">${fcT.aguardando?`${fcT.aguardando} aguardando alguém · `:''}${nPl(nDevs,'dev ativo','devs ativos')}</div></div>
      <div class="tskpi"><div class="v" style="color:var(--purple)">${eps}</div><div class="l">épicos ativos</div><div class="d">${activeEps.slice(0,2).map(e=>{const ts=all.filter(t=>t.epic_id===e.id);const dn=ts.filter(epDelivered).length;return esc(e.name.split(' ')[0].replace(/[:;,.·–—-]+$/,''))+' '+dn+'/'+ts.length;}).join(' · ')||'—'}</div></div>
      <div class="tskpi"><div class="v" style="color:${prs.length?'var(--warn)':'var(--text)'}">${prs.length}</div><div class="l">PRs pra revisar</div><div class="d">${prs.length?'mais antigo '+agoTx(prs[prs.length-1].updated_at):'em dia ✓'}</div></div>
      <div class="tskpi"><div class="v">${fmtCost(custo,{usdOnly:true})}</div><div class="l">custo no período · ≈ R$ ${fmtNumBR(custo*usdBrlRate(),true)}</div><div class="d">${done?fmtCost(custo/done,{usdOnly:true})+' por entrega':inP.length?'nenhuma entrega no período':'—'}</div></div>
    </div>
    <div class="tscols"><div>
      <div class="tspanel"><div class="tsph">Agora no time <span style="flex:1"></span><span style="color:var(--accent);font-size:var(--fs-xs)">● ao vivo</span></div>
        ${doing.length?doing.slice(0,6).map(t=>{ const who=tsWho(t); return `<div class="tslive"><span class="who">${tsAv(who,tsOnline(who))}${esc(tmName(who)).slice(0,14)}</span><span class="what" data-ct="${escA(t.id)}" style="cursor:pointer"><b>${esc(t.stage||'agente')}</b> · ${esc(t.title)}${t.last_note?' — '+esc(t.last_note.slice(0,60)):''}</span><span class="tstag run">${esc(stLabel(tsSt(t)))}</span></div>`; }).join(''):'<div class="dim" style="font-size:var(--fs-sm)">nenhuma tarefa em andamento agora</div>'}
      </div>
      <div class="tspanel"><div class="tsph">PRs esperando gente</div>
        ${prs.length?prs.slice(0,5).map(t=>`<div class="tslive"><span class="mono" style="color:var(--accent);font-size:var(--fs-xs)">${esc((t.pr_url.match(/\/pull\/(\d+)/)||[])[1]?'#'+(t.pr_url.match(/\/pull\/(\d+)/)||[])[1]:'PR')}</span><span class="what" data-ct="${escA(t.id)}" style="cursor:pointer">${esc(t.title)}</span>${tsAv(tsWho(t),false)}${tsRevChip(tsRevBy[t.pr_url])}<button class="btn sm" data-pr="${escA(t.pr_url)}" style="padding:3px 8px;font-size:var(--fs-xs)">abrir ↗</button><button class="btn ${tsRevBy[t.pr_url]?'':'primary '}sm" data-rev="${escA(t.id)}" style="padding:3px 8px;font-size:var(--fs-xs)">revisar com agente</button></div>`).join(''):'<div class="dim" style="font-size:var(--fs-sm)">nenhum PR aberto — em dia ✓</div>'}
      </div>
    </div><div>
      <div class="tspanel"><div class="tsph">Entregas por dia</div><div class="tsspark">${perDay.map((n,i)=>`<div class="c"><div class="b" style="height:${Math.round(n/mx*100)}%"></div><span class="dl">${DL[days[i].getDay()]}</span></div>`).join('')}</div></div>
      <div class="tspanel"><div class="tsph">Entregas por membro</div>
        ${(()=>{ const per={}; for(const t of inP){ const w=tsWho(t); const b=per[w]||(per[w]={d:0,r:0,u:0}); if(epDelivered(t)) b.d++; b.u+=(+t.cost_usd||0); }
          // em andamento = o MESMO tsRunningOf do KPI e de Pessoas (agora, não "no período"); quem só tem trabalho rodando também aparece
          members.forEach(u=>{ const r=tsRunningOf(u).length; if(r) (per[u]||(per[u]={d:0,r:0,u:0})).r=r; });
          const rows=Object.entries(per).sort((a,b)=>b[1].d-a[1].d);
          return rows.length?rows.map(([u,v])=>`<div class="tslive"><span class="who" title="${escA(tmName(u))}">${tsAv(u,tsOnline(u))}${esc(tmName(u).slice(0,14))}</span><span class="what">${nPl(v.d,'entregue','entregues')} · ${v.r} em andamento</span>${veCustoDe(u)?`<span class="dim tscost" style="font-size:var(--fs-xs)">${fmtUsd(v.u)}</span>`:''}</div>`).join(''):'<div class="dim" style="font-size:var(--fs-sm)">sem atividade no período</div>'; })()}
      </div>
    </div></div>`;
  } else if(tmView==='board'){
    // M1: mesmos nomes da Central/Kanban (STATUS_META) · M7: conta TUDO e só depois corta a lista em 8 (+N)
    // R3: colunas derivadas da MESMA etapa da Central (flowBucket) — erro/conflito/plano pra aprovar não se escondem
    // mais em "Em andamento"; PR aberto fica junto de "prontas" (a aba PRs detalha)
    const inB=(...ks)=>t=>ks.includes(tsBucket(t));
    // A7: mínimos que cabem nas 5 colunas a partir de ~1200 px (220+150 somavam 1074 px em 962); menor que isso, o quadro rola (CSS)
    const cols=[['Na fila',stColor('backlog'),vis.filter(inB('fila','rascunho')),0],['Aguardando alguém',stColor('asking'),vis.filter(inB('aguardando')),0],['Em andamento',stColor('running'),vis.filter(inB('andamento')),0],['Prontas / PR aberto',stColor('review'),vis.filter(inB('prontas','praberto')),0],['Concluídas',stColor('done'),vis.filter(inB('hoje','anteriores')),8]];
    main=`<h1>Quadro do time</h1><div class="tssub">${devOpts}${epicChips}${unsynced?`<button class="btn sm" id="tbBackfill">⇡ publicar ${unsynced} local${unsynced===1?'':'is'}</button>`:''}<span style="flex:1"></span><button class="btn sm" id="tbRefresh">atualizar</button></div>
    <div class="tsboard ts5" style="grid-template-columns:${cols.map(c=>c[2].length?'minmax(176px,1fr)':'minmax(130px,.5fr)').join(' ')}">${cols.map(([l,c,ts,cap])=>{ const shown=cap?ts.slice(0,cap):ts; return `<div class="tscol"><div class="tskh"><span class="dot" style="background:${c}"></span>${l}<span class="n">${ts.length}</span></div>${shown.map(t=>tsCardHtml(t,me,isAdmin)).join('')||'<div class="dim" style="font-size:var(--fs-xs);padding:6px">vazio</div>'}${ts.length>shown.length?`<div class="dim tsmore" style="font-size:var(--fs-xs);padding:6px" title="mostrando as ${shown.length} mais recentes">+${ts.length-shown.length} concluídas</div>`:''}</div>`; }).join('')}</div>`;
  } else if(tmView==='entregas'){
    // Entregas (70-time-entregas): a visão do gestor — uma lista por épico
    main=typeof entregasHtml==='function'?entregasHtml({ all, members }):'';
  } else if(tmView==='prs'){
    main=`<h1>PRs pra revisar</h1><div class="tssub">todo cartão do time com PR aberto</div>`+
      (prs.length?prs.map(t=>{ const n=(t.pr_url.match(/\/pull\/(\d+)/)||[])[1];
        return `<div class="tspanel" style="display:flex;align-items:center;gap:12px"><span class="mono" style="color:var(--accent)">${n?'#'+n:'PR'}</span><div style="flex:1;min-width:0"><b style="font-size:var(--fs-base)">${esc(t.title)}</b><div class="dim" style="font-size:var(--fs-xs)">de ${esc(tmName(tsWho(t)))} · ${esc(stLabel(tsSt(t)))} · ${agoTx(t.updated_at)}</div></div>${tsRevChip(tsRevBy[t.pr_url])}<button class="btn sm" data-pr="${escA(t.pr_url)}">abrir ↗</button><button class="btn ${tsRevBy[t.pr_url]?'':'primary '}sm" data-rev="${escA(t.id)}">revisar com agente</button></div>`; }).join('')
      :'<div class="emptyrepo" style="display:flex"><div class="big">Em dia ✓</div><div>nenhum PR do time esperando review.</div></div>');
  } else if(tmView==='linha'){
    // Linha do time (69-linha): todos os projetos, janela e saúde postas por uma pessoa
    main=typeof linhaTimeHtml==='function'?linhaTimeHtml():'';
  } else if(tmView==='people'){
    const inP=tsPeriodTasks();
    main=`<h1>Pessoas</h1><div class="tssub">${nPl(members.length,'membro','membros')}${perSel}</div><div class="tsppl">`+
      members.map(uid=>{ const p=teamProfiles[uid]||{}; const on=tsOnline(uid); const run=tsRunningOf(uid);
        const mine=inP.filter(t=>tsWho(t)===uid);
        const d=mine.filter(epDelivered).length, u=mine.reduce((s,t)=>s+(+t.cost_usd||0),0);
        const lastAct=(teamActivity||[]).find(a=>a.user_id===uid);
        const teamTags=orgScope?teamsOf(uid).map(tid=>`<span class="tsteamtag">${esc(tsTeamName(tid))}</span>`).join(''):'';
        return `<div class="tspc"><div class="hh">${tsAv(uid,on)}<div><b style="font-size:var(--fs-base)">${esc(tmName(uid))}</b><div class="dim" style="font-size:var(--fs-xs)">${roleOf(uid)} · ${on?'<span style=color:var(--accent)>online</span>':(p.last_seen_at?agoTx(p.last_seen_at):'—')}${teamTags?' · '+teamTags:''}</div></div></div>
          <div class="nums"><div><b>${d}</b><span>entregues</span></div><div><b>${run.length}</b><span>em andamento</span></div>${veCustoDe(uid)?`<div><b>${fmtCost(u,{usdOnly:true})}</b><span>custo · ≈ R$ ${fmtNumBR(u*usdBrlRate(),true)}</span></div>`:''}</div>
          <div class="now">${run.length?`agora: <b>${esc(run[0].stage||'agente')}</b> em “${esc(run[0].title.slice(0,42))}”`:(lastAct?`último: ${tsK(lastAct.kind)} ${esc(((all.find(t=>t.id===lastAct.task_id)||{}).title||'').slice(0,40))} · ${agoTx(lastAct.at)}`:'sem atividade recente')}</div>
          ${(()=>{ // tarefas da pessoa com badge de TIPO + progresso (redesign p7)
            const act=mine.filter(t=>!['merged','done'].includes(t.status)&&t.flag!=='closed').slice(0,3);
            if(!act.length) return '';
            const KIND_PT={build:'FEATURE',fix:'FIX',invest:'INVESTIGAÇÃO',design:'DESIGN',review:'REVIEW'};
            const KIND_CO={build:'var(--accent)',fix:'var(--warn)',invest:'var(--purple)',design:'var(--info)',review:'var(--good)'};
            const pctOf=s=>({backlog:5,requested:10,queued:15,running:45,thinking:45,'plan-review':30,review:80,delivered:85,error:45,conflict:45}[s]??20);
            return act.map(t=>{ const k=(t.spec||{}).kind|| ((t.branch||'').startsWith('fix/')?'fix':(t.branch||'').startsWith('invest/')?'invest':(t.branch||'').startsWith('design/')?'design':'build');
              return `<div data-ct="${escA(t.id)}" style="cursor:pointer;margin-top:7px;padding-top:7px;border-top:1px dashed var(--border)">
                <div style="display:flex;gap:7px;align-items:center;font-size:var(--fs-xs)"><span class="mono" style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.5px;color:${KIND_CO[k]||'var(--muted)'};border:1px solid currentColor;border-radius:4px;padding:1px 5px">${KIND_PT[k]||'TAREFA'}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span></div>
                <div class="tsbar" style="margin-top:5px"><i style="width:${pctOf(t.status)}%"></i></div></div>`; }).join('');
          })()}</div>`; }).join('')+`</div>`;
  } else if(tmView==='feed'){
    main=`<h1>Atividade do time</h1><div class="tssub">mais recente primeiro</div><div class="tspanel tsfeed">`+
      ((teamActivity||[]).length?(teamActivity||[]).slice(0,40).map(a=>{ const t=all.find(x=>x.id===a.task_id);
        return `<div class="fi">${tsAv(a.user_id,false)}<span class="tx"><b>${esc(tmName(a.user_id))}</b> ${tsK(a.kind)} <b data-ct="${escA(a.task_id)}" style="cursor:pointer">${esc((t||{}).title||'tarefa')}</b>${a.body?` — ${esc(a.body.slice(0,80))}`:''}</span><span class="tm">${agoTx(a.at)}</span></div>`; }).join('')
      :'<div class="dim" style="font-size:var(--fs-sm)">sem atividade ainda</div>')+`</div>`;
  }
  void side;
  const html=`<div class="tspace"><div class="tmain">${subTabs}${main}</div></div>`;
  if(teamPaintSig===html) return;
  teamPaintSig=html; el.innerHTML=html;
  // ---------- wiring ----------
  if(tmView==='linha' && typeof linhaWire==='function') linhaWire(el);
  if(tmView==='entregas' && typeof entregasWire==='function') entregasWire(el);
  el.querySelectorAll('[data-tsv]').forEach(b=>{ b.onclick=()=>{ tmView=b.dataset.tsv; lsSet('tmView',tmView); teamPaintSig=''; renderTeamBoard(); }; });
  el.querySelectorAll('[data-tscope]').forEach(b=>{ b.onclick=()=>tsSetScope(b.dataset.tscope); });
  el.querySelectorAll('[data-epopen]').forEach(b=>{ b.onclick=()=>{ const e=teamEpics.find(x=>x.id===b.dataset.epopen); if(e&&window.openEpicPage) openEpicPage(e); }; });
  { const sel=el.querySelector('#tbEpic'); if(sel) sel.onchange=()=>{ lsSet('tmEpic', sel.value); teamPaintSig=''; renderTeamBoard(); }; }
  // A12: o épico novo já nasce com "pronto quando" (opcional: vazio = fecha quando todas as tarefas forem entregues)
  { const b=el.querySelector('#tbEpicAdd'); if(b) b.onclick=async()=>{ const n=await askText('Novo épico','ex.: Filtros avançados'); if(!n) return;
    const dw=typeof epDoneWhenAsk==='function'?await epDoneWhenAsk(b):[]; if(dw==null) return;
    try{ await sbPost('epics',{ team_id:cloudTeamId(), name:n.trim(), created_by:cloudUserId(), ...(dw.length?{ spec:{ doneWhen:dw } }:{}) }); teamTasks=null; teamPaintSig=''; renderTeamBoard(); toast('Épico “'+n.trim().slice(0,50)+'” criado'+(dw.length?' com '+dw.length+' ite'+(dw.length===1?'m':'ns')+' de pronto quando':'')+'.','ok'); }catch(e){ showErr(e, 'Não consegui criar o épico'); } }; }
  { const s=el.querySelector('#tbPeriod'); if(s) s.onchange=e=>{ lsSet('tmPeriod', e.target.value); teamPaintSig=''; renderTeamBoard(); }; }
  { const s=el.querySelector('#tbDev'); if(s) s.onchange=e=>{ lsSet('tmDev', e.target.value); teamPaintSig=''; renderTeamBoard(); }; }
  { const b=el.querySelector('#tbRefresh'); if(b) b.onclick=()=>{ teamTasks=null; teamPaintSig=''; renderTeamBoard(); }; }
  { const b=el.querySelector('#tbBackfill'); if(b) b.onclick=()=>cloudBackfill(b); }
  el.querySelectorAll('[data-pr]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); openExternal(b.dataset.pr); }; });
  wireLinkChips(el);
  el.querySelectorAll('[data-rev]').forEach(b=>{ b.onclick=async(e)=>{ e.stopPropagation(); const ct=all.find(x=>x.id===b.dataset.rev); if(!ct) return; b.disabled=true; b.textContent='criando review…';
    const done=await cloudPrReviewCheck(ct.pr_url).catch(()=>null);
    if(done && !await askYes('Atenção: este PR já foi revisado '+(done.mine?'por VOCÊ':'por '+done.name)+' ('+done.when+') pelo Starfork — o parecer está no cartão dele.\n\nRodar OUTRO review mesmo assim?')){ b.disabled=false; b.textContent='revisar com agente'; return; }
    invoke('review_pr',{ prUrl: ct.pr_url, agents:null }).then(()=>{ lastSig=''; refresh(); setView('flow'); }).catch(err=>{ showErr(err, 'Falha'); b.disabled=false; b.textContent='revisar com agente'; }); }; });
  el.querySelectorAll('[data-ct]').forEach(c=>{ c.onclick=(e)=>{ if(e.target.closest('[data-act],[data-pr],[data-rev]')) return; const ct=all.find(x=>x.id===c.dataset.ct); if(ct) openCloudTaskPage(ct); }; });
  el.querySelectorAll('.tscard [data-act]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); const id=b.closest('.tscard').dataset.ct; const ct=all.find(x=>x.id===id); if(!ct) return;
    if(b.dataset.act==='claim') teamClaimStart(ct, b); else if(b.dataset.act==='claimonly') tsClaimOnly(ct, b); else if(b.dataset.act==='release') tsRelease(ct, b); else if(b.dataset.act==='reassign') tsReassign(ct, b); else if(b.dataset.act==='openproj'){ if(typeof epOpenProjectOf==='function') epOpenProjectOf(teamProj[ct.project_id]||{}); } else if(b.dataset.act==='del') teamDeleteCard(ct); else if(b.dataset.act==='issue' && typeof trkCardRetry==='function') trkCardRetry(ct, teamProj[ct.project_id]||{}, b); }; });
}

// itens do "pronto quando" do épico ("D1: texto") — vão no TASK.yaml pra o revisor saber o que julgar
function epicDoneWhenOf(epicId){
  if(!epicId) return null;
  const e=(teamEpics||[]).find(x=>x.id===epicId); const dw=e&&e.spec&&Array.isArray(e.spec.doneWhen)?e.spec.doneWhen:[];
  const out=dw.map((d,i)=>(d.id||('D'+(i+1)))+': '+String(d.text||'').trim()).filter(x=>!/: $/.test(x));
  return out.length?out:null;
}
async function teamClaimStart(ct, btn, opts){ opts=opts||{};
  if(btn){ btn.disabled=true; btn.textContent='assumindo…'; }
  try{
    const j=await sbRpc('claim_task',{ p_task: ct.id });
    if(!j.ok) throw new Error(j.error||'não deu pra assumir');
    if(!ct.assignee && typeof trkCardAssign==='function') trkCardAssign(ct, cloudUserId()); // "assumir e iniciar": o nome vai pra issue também
    // defaults por baixo: cartão criado "enxuto" (ex.: derivado de épico) roda igual
    // ...(ct.spec) traz verify/covers/after/wave/risk/hitl quando o cartão veio de um épico; epic_id é coluna, não spec
    const payload={ workflow:null, agents:null, engine:defaultAiEngine(), approval:'auto', owns:null, off:null, objective:null, deliverables:[], requirements:[], doc:null, proof:false, tests:false, autoPr:'ask', prBase:null, planApproval:'auto', refs:[], branchType:'feat', issue:null, base:null, linkedTo:null, ...(ct.spec||{}), issue:(ct.spec&&ct.spec.issueCode)||null, issueUrl:(ct.spec&&ct.spec.issueUrl)||ct.issue_url||null, epicId: ct.epic_id||null, epicDoneWhen: epicDoneWhenOf(ct.epic_id)||(ct.spec&&ct.spec.epicDoneWhen)||null, title: ct.spec?.title||ct.title, start:true };
    // épico iniciando SOZINHO também roda no TERMINAL (terminal sempre vivo, 09/10): a pessoa abre e digita quando quiser
    if(ct.epic_id && window.epicAttachRef) await epicAttachRef(payload, ct.epic_id, ct); // EPIC.md compilado vai como referência
    const localId=await invoke('new_task', await trkBeforeNewTask(payload));
    tmapSet(localId, ct.id);
    if(+((ct.spec||{}).budgetUsd)>0) invoke('patch_task_spec',{ taskId:String(localId), patch:{ budgetUsd:+ct.spec.budgetUsd } }).catch(e=>console.error('teto do cartão', e)); // teto escolhido por quem mandou pro time
    await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'PATCH', body: JSON.stringify({ status:'running', local_id: localId }) });
    if(ct.epic_id && window.epicMarkInProgress) epicMarkInProgress(ct.epic_id); // 1ª tarefa rodando → épico em andamento
    sbPost('task_activity',{ task_id:ct.id, user_id:cloudUserId(), kind:'started', body:'' }).catch(()=>{});
    // some da fila dos épicos NA HORA (o tick da nuvem só volta em até 20 s) e aparece na MINHA Execução
    if(typeof epQueue!=='undefined' && epQueue.rows) epQueue.rows=epQueue.rows.filter(r=>r.id!==ct.id);
    teamTasks=null; lastSig=''; allTasksAt=0; await refresh();
    // A8: "assumir" LEVA pra sua Execução (a aba Central, com a tarefa selecionada) e diz o que aconteceu — antes só
    // trocava o #viewSeg escondido e a aba continuava no Time, sem retorno
    if(!opts.silent){ const cl=tsClaimShow(localId);
      toast('Você assumiu “'+String(ct.title||'a tarefa').slice(0,60)+'” — ela está na sua Execução.'+(cl.length?' Limpei '+(cl.length===1?'o filtro':'os filtros')+' de '+cl.join(', ')+' que a escondia'+(cl.length===1?'':'m')+'.':''),'ok'); }
    return localId;
  }catch(e){ if(opts.silent) throw e; showErr(e, 'Não deu pra assumir & iniciar'); if(btn){ btn.disabled=false; btn.textContent='assumir & iniciar'; } }
}
async function teamDeleteCard(ct){
  if(!await askYes('Remover "'+ct.title+'" do backlog do time?')) return false;
  try{ await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'DELETE' }); teamTasks=null; renderTeamBoard(); return true; }
  catch(e){ showErr(e, 'Falhou'); return false; }
}

// ---- detalhe/edição do cartão ----
function openCloudTask(ct){
  $id('ctOverlay').style.display='flex';
  $id('ctHead').textContent=ct.title;
  const me=cloudUserId();
  const canEdit=ct.status==='backlog' && (ct.created_by===me || (cloudData&&(cloudData.meRole==='owner'||cloudData.meRole==='admin')));
  const sp=ct.spec||{};
  const reqs=(sp.requirements||[]);
  const body=$id('ctBody');
  body.innerHTML=`
    ${(ct.pr_url||ct.issue_url||((ct.branch||'').match(/\b[A-Z]{2,10}-\d+\b/)))?`<div style="display:flex;gap:8px;margin-bottom:10px">${linkChips({prUrl:ct.pr_url, issueUrl:ct.issue_url, branch:ct.branch, title:ct.title})}</div>`:''}
    <div class="imhint">criada por <b>${esc(tmName(ct.created_by))}</b> · ${esc(ctStLabel(ct))}${ct.assignee?' · com <b>'+esc(tmName(ct.assignee))+'</b>':''}${ct.claim_mode==='reserved'?' · <b>reservada pra si</b>':''}</div>
    <label style="margin-top:10px">Título</label><input class="in" id="ctTitle" value="${escA(ct.title)}" ${canEdit?'':'disabled'}>
    <label style="margin-top:12px">Objetivo</label><textarea class="in ta" id="ctObj" data-mdprev rows="4" ${canEdit?'':'disabled'}>${esc(sp.objective||'')}</textarea>
    <label style="margin-top:12px">Requisitos <span class="dim" style="text-transform:none;letter-spacing:0">(um por linha — o agente é cobrado por cada um)</span></label>
    <textarea class="in ta" id="ctReqs" data-mdprev="list" rows="${Math.max(3,reqs.length+1)}" ${canEdit?'':'disabled'}>${esc(reqs.join('\n'))}</textarea>
    ${(sp.deliverables||[]).length?`<label style="margin-top:12px">Entregáveis</label><div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px">${(sp.deliverables||[]).map(d=>`<div style="display:flex;gap:8px;font-size:var(--fs-sm);padding:3px 0"><span style="color:var(--accent)">◆</span><span>${mdInline(d)}</span></div>`).join('')}</div>`:''}
    <label style="margin-top:12px">Épico</label>
    <select class="sel" id="ctEpic" style="width:100%"><option value="">— sem épico —</option>${teamEpics.map(e=>`<option value="${escA(e.id)}"${ct.epic_id===e.id?' selected':''}>${esc(e.name)}</option>`).join('')}</select>
    <div id="ctReqProof"></div>
    <div id="ctProofs"></div>
    <div id="ctAct" class="dim" style="font-size:var(--fs-xs);margin-top:12px">${skeletonHtml('lista',{ n:3, compact:true, inline:true, label:'carregando a atividade' })}</div>
    <div style="display:flex;gap:8px;margin-top:14px"><span style="flex:1"></span>${canEdit?'<button class="btn primary" id="ctSave">salvar alterações</button>':''}</div>`;
  if(typeof mdPrevSync==='function') mdPrevSync(body); // objetivo/requisitos formatados; "editar" volta pro campo (o markdown salvo não muda)
  // requisitos com prova (sincronizados do requirements.json do dev)
  { const rp=ct.requirements_proof; const el=$id('ctReqProof');
    if(el && rp && Array.isArray(rp.list||rp) ){
      const list=Array.isArray(rp.list)?rp.list:rp;
      if(list.length) el.innerHTML=`<div class="seclbl2" style="margin-top:14px">Requisitos provados <span class="n">${list.filter(x=>x.status==='done').length}/${list.length}</span></div>`+
        list.map(x=>`<div style="display:flex;gap:8px;font-size:var(--fs-sm);padding:5px 2px;border-bottom:1px dashed var(--border)"><span style="color:${x.status==='done'?'var(--good)':'var(--warn)'}">${x.status==='done'?'✓':'○'}</span><span style="flex:1">${esc(x.req||'')}${ctVideoNote(x)}</span></div>`).join('');
    }
  }
  // galeria de provas publicadas (o que o dev ESCOLHEU subir)
  sbGet('artifacts_meta?select=name,kind,size,storage_path&task_id=eq.'+ct.id+'&order=created_at.desc').then(async arts=>{
    const el=$id('ctProofs'); if(!el || !arts.length) return;
    const imgs=arts.filter(a=>a.kind==='image').slice(0,8), docs=arts.filter(a=>a.kind!=='image');
    let html=`<div class="seclbl2" style="margin-top:14px">Provas publicadas <span class="n">${arts.length}</span></div>`;
    if(imgs.length){
      const urls=await Promise.all(imgs.map(a=>cloudSignedUrl(a.storage_path).catch(()=>null)));
      html+=`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px">`+
        imgs.map((a,i)=>urls[i]?`<img src="${escA(urls[i])}" title="${escA(a.name)}" data-proof="${escA(a.storage_path)}" style="width:100%;aspect-ratio:4/3;object-fit:cover;border:1px solid var(--border);border-radius:6px;cursor:zoom-in">`:'').join('')+`</div>`;
    }
    if(docs.length) html+=`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">`+docs.map(a=>`<button class="btn sm mono" data-proof="${escA(a.storage_path)}">${esc(a.name)}</button>`).join('')+`</div>`;
    el.innerHTML=html;
    el.querySelectorAll('[data-proof]').forEach(b=>{ b.onclick=async()=>{ try{ openExternal(await cloudSignedUrl(b.dataset.proof)); }catch(e){ showErr(e, 'Falha ao abrir'); } }; });
  }).catch(()=>{});
  sbGet('task_activity?select=user_id,kind,body,at&task_id=eq.'+ct.id+'&order=id.desc&limit=8').then(rows=>{
    const K={created:'criou',edited:'editou',claimed:'assumiu',released:'devolveu',assigned:'atribuiu',started:'iniciou',delivered:'entregou',comment:'comentou',status:'status'};
    const d=$id('ctAct'); if(d) d.innerHTML = rows.length? rows.map(a=>`${esc(tmName(a.user_id))} <b>${K[a.kind]||a.kind}</b> · ${agoTx(a.at)}`).join('<br>') : 'sem atividade ainda';
  }).catch(()=>{});
  { const b=$id('ctSave'); if(b) b.onclick=async()=>{
      b.disabled=true; b.textContent='salvando…';
      try{
        const title=$id('ctTitle').value.trim()||ct.title;
        const spec={ ...sp, title, objective:$id('ctObj').value.trim(), requirements:$id('ctReqs').value.split('\n').map(x=>x.trim()).filter(Boolean) };
        await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'PATCH', body: JSON.stringify({ title, spec }) });
        sbPost('task_activity',{ task_id:ct.id, user_id:cloudUserId(), kind:'edited', body:'' }).catch(()=>{});
        teamTasks=null; $id('ctOverlay').style.display='none'; renderTeamBoard();
        if(typeof ctpTask!=='undefined'&&ctpTask&&ctpTask.id===ct.id){ ctPageLoad(ct.id, true).then(()=>ctPageRender()); }
      }catch(e){ showErr(e, 'Falhou'); b.disabled=false; b.textContent='salvar alterações'; }
    }; }
  wireLinkChips(body);
  { const s=$id('ctEpic'); if(s) s.onchange=async()=>{
      try{ await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'PATCH', body: JSON.stringify({ epic_id: s.value||null }) }); teamTasks=null; teamPaintSig=''; renderTeamBoard(); }
      catch(e){ showErr(e, 'Falhou'); }
    }; }
}
$id('ctClose').onclick=()=>{ $id('ctOverlay').style.display='none'; };
$id('ctOverlay').addEventListener('click',e=>{ if(e.target.id==='ctOverlay') $id('ctOverlay').style.display='none'; });

// mostra o seletor "Time" na criação de tarefa só quando logado + time escolhido
// e preenche o seletor de ÉPICO (com a opção de criar um novo na hora)
async function ntShareSync(){
  const r=$id('ntShareRow'); if(!r) return;
  const on=!!(SB.sess()&&cloudTeamId());
  r.dataset.cloud=on?'1':'0';
  if(typeof wizShareApply==='function') wizShareApply(null); else r.style.display=on?'block':'none';
  if(!on) return;
  try{ if(!teamEpics.length) teamEpics=await sbGet('epics?select=id,name,status,spec,created_by,created_at,updated_at&team_id=eq.'+cloudTeamId()+'&status=neq.archived&order=created_at').catch(()=>sbGet('epics?select=id,name,status&team_id=eq.'+cloudTeamId()+'&status=neq.archived&order=created_at')); }catch(_){ }
  ntShareDefault(); ntWhoPaint();
  const sel=$id('ntEpic'); if(!sel) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">— sem épico —</option>'
    + teamEpics.map(e=>`<option value="${escA(e.id)}">◆ ${esc(e.name)}</option>`).join('')
    + '<option value="__new__">＋ criar novo épico…</option>';
  if([...sel.options].some(o=>o.value===cur)) sel.value=cur;
  sel.onchange=async()=>{
    if(sel.value!=='__new__') return;
    sel.value='';
    const n=await askText('Novo épico','ex.: Filtros avançados');
    if(!n) return;
    try{ const rows=await sbPost('epics',{ team_id:cloudTeamId(), name:n, created_by:cloudUserId() }); teamEpics.push(rows[0]); await ntShareSync(); sel.value=rows[0].id; }
    catch(e){ showErr(e, 'Falhou'); }
  };
}
// "Ao criar" (mesa 09/10, T1): o padrão segue a última escolha (tmDest) — mandar pro time quando há time
let ntWho='', ntShareTouched=false;
function ntShareIsTeam(){ const r=$id('ntShareRow'), s=$id('ntShare'); return !!(r && r.dataset.cloud==='1' && s && s.value==='team'); }
function ntShareDefault(){ const s=$id('ntShare'); if(!s || ntShareTouched) return; const sv=lsGet('nd:share'); s.value=tmDest()==='run'?(sv==='local'?'local':'self'):'team';
  if(!s.__wired){ s.__wired=1; s.addEventListener('change',()=>{ ntShareTouched=true; tmDestSet(s.value==='team'?'team':'run'); lsSet('nd:share', s.value); ntWhoPaint(); ntCreateLabel(); }); } ntCreateLabel(); }
function ntWhoPaint(){ const row=$id('ntWhoRow'), slot=$id('ntWhoSlot'); if(!row||!slot) return; const on=ntShareIsTeam(); row.style.display=on?'flex':'none'; if(!on) return;
  slot.innerHTML=tmWhoBtnHtml(ntWho,'id="ntWhoBtn"'); const b=$id('ntWhoBtn'); if(b) b.onclick=()=>tmWhoPick(b, ntWho, uid=>{ ntWho=uid||''; ntWhoPaint(); }); }
// o botão de criar diz o que vai acontecer (fora do wizard: #ntCreate; no wizard, a última etapa relê ao pintar)
function ntCreateLabel(){ const c=$id('ntCreate'); if(c && !c.disabled){ const svg=c.querySelector('svg'); c.textContent=ntShareIsTeam()?'Mandar pro time':'Iniciar execução'; if(svg) c.prepend(svg); }
  const w=$id('wizNext'); if(w && /Iniciar execução|Mandar pro time/.test(w.textContent)) w.textContent=ntShareIsTeam()?'Mandar pro time':'Iniciar execução'; }
function ntEpicVal(){ const s=$id('ntEpic'); const v=s?s.value:''; return (v&&v!=='__new__')?v:null; }
$id('newTaskBtn').addEventListener('click', ()=>{ ntShareSync(); });

/* ---- F3: notificações do time — SÓ o que me envolve (regra única: ctNotifKind, 42 @exec) ----
   Poll leve a cada 30s; "já visto" persiste em localStorage pra não re-notificar. O "visto" é marcado pra
   TODO cartão (mesmo os que não notificam): um cartão alheio que depois vira meu não dispara aviso atrasado. */
// "já visto" é POR CONTA (userKey): a conta que entra não herda nem apaga os avisos da outra
function seenSet(k){ try{ return new Set(JSON.parse(lsGet(userKey(k, cloudUserId()))||'[]')); }catch(_){ return new Set(); } }
function seenAdd(k,id){ const s=seenSet(k); s.add(id); lsSet(userKey(k, cloudUserId()), JSON.stringify([...s].slice(-500))); }
let teamNotifReady=false;
// @time-notif-inicio (testado em app/tests/time-integrado.test.mjs)
// atividade → aviso pra MIM (ou null): alguém assumiu/devolveu/passou a demanda que eu criei; alguém me atribuiu um cartão
function ctOwnerNotif(a, t, me, nameOf){
  nameOf=nameOf||(typeof tmName==='function'?tmName:(u=>u));
  if(!a || !me || a.user_id===me) return null; // o que EU fiz não me avisa
  const title=t&&t.title?'“'+String(t.title).slice(0,70)+'”':'um cartão do time', who=nameOf(a.user_id);
  if(a.kind==='assigned' && a.body===me) return { title:'Nova tarefa pra você', body:who+' passou '+title+' pra você' };
  if(!t || t.created_by!==me) return null;
  if(a.kind==='claimed') return { title:who+' assumiu a sua demanda', body:title+' — o time vê o nome dele no cartão' };
  if(a.kind==='released') return { title:who+' devolveu a sua demanda', body:title+' está livre na fila do time'+(a.body?' — '+String(a.body).slice(0,120):'') };
  if(a.kind==='assigned' && a.body) return { title:'Sua demanda mudou de mãos', body:who+' passou '+title+' pra '+nameOf(a.body) };
  return null; // status (começou/rodando) não avisa: aparece na Central e no Time (mesa 09/10, veto da Júlia)
}
// @time-notif-fim
async function teamNotifTick(){
  if(!SB.sess() || !cloudTeamId() || !cloudScopeOk()) return;
  await teamFetch(); if(!teamTasks) return;
  const me=cloudUserId(), prs=seenSet('sb:seenpr'), cards=seenSet('sb:seencard'), revs=seenSet('sb:seenrev');
  for(const t of teamTasks){
    const isRev=((t.spec||{}).kind==='review')||/^review (do |de )?pr/i.test(t.title||'');
    const kind=teamNotifReady ? ctNotifKind(t, me, teamTasks) : null; // 1ª carga só semeia o "visto"
    const who=tmName(tsWho(t));
    if(isRev){
      if(t.pr_url && !revs.has(t.id)){ seenAdd('sb:seenrev', t.id); if(kind==='review-done') pushNotif('Seu PR foi revisado ✓ — '+who, t.title+' · o parecer está no cartão', 'view:team'); }
      continue; // cartão de review não é "PR aberto" nem "tarefa nova"
    }
    if(t.pr_url && !prs.has(t.id)){ seenAdd('sb:seenpr', t.id); if(kind==='pr') pushNotif('PR aberto na demanda que você criou ↗', who+': '+t.title, 'view:team'); }
    if(t.status==='backlog' && !cards.has(t.id)){ seenAdd('sb:seencard', t.id); if(kind==='assigned') told.add(t.id); if(kind==='assigned') pushNotif('Nova tarefa pra você', tmName(t.created_by)+' atribuiu: '+t.title, 'view:team'); }
  }
  // MUDOU DE DONO (mesa 09/10, T3/T4 · aviso só quando muda de dono): pela atividade do cartão — quem assumiu/devolveu
  // a demanda que EU criei, e quem atribuiu um cartão a MIM. A 1ª carga só semeia o "visto".
  const acts=seenSet('sb:seenact'), told=new Set(); // cartão que já avisei NESTA volta (o "Nova tarefa pra você" do cartão) não avisa de novo pela atividade
  for(const a of (teamActivity||[]).slice().reverse()){
    const key=String(a.id||(a.task_id+':'+a.at)); if(acts.has(key)) continue; seenAdd('sb:seenact', key);
    if(!teamNotifReady) continue;
    if(a.kind==='assigned' && told.has(a.task_id)) continue;
    const t=teamTasks.find(x=>x.id===a.task_id); const k=ctOwnerNotif(a, t, me);
    if(k) pushNotif(k.title, k.body, 'view:team');
  }
  teamNotifReady=true;
  if(activeIs('team')) renderTeamBoard();
}
tickLoop('teamNotifTick', teamNotifTick, 30000, 4000); // 42: sem sobreposição, mais lento com a janela escondida

/* ---- provas pro time: o DEV escolhe publicar (decisão Q2) ---- */
const cloudPubCache={}; // cloudTaskId -> [{name,size}]
async function cloudPubList(cid, force){
  if(cloudPubCache[cid]!==undefined && !force) return cloudPubCache[cid];
  try{ cloudPubCache[cid]=await sbGet('artifacts_meta?select=id,name,kind,size,storage_path&task_id=eq.'+cid+'&order=created_at.desc'); }
  catch(_){ cloudPubCache[cid]=[]; }
  return cloudPubCache[cid];
}
// requisito provado com VÍDEO: o vídeo não sobe pra nuvem (só prints/documentos) — o time sabe onde ele está
function ctVideoNote(x){ const ev=Array.isArray(x&&x.evidence)?x.evidence:[]; return ev.some(e=>/\.(mp4|m4v|mov|webm)$/i.test(String(e)))?' <span class="dim" style="font-size:var(--fs-xs)">· vídeo fica na máquina de quem fez</span>':''; }
async function cloudPublishProofs(t, btn){
  const cid=tmap()[t.id]; if(!cid){ toast('Esta tarefa não está sincronizada com o time.','warn'); return; }
  const all=await loadArtifacts(t.id, t.status)||[];
  // vídeo NÃO sobe (nada de base64 de vídeo inteiro no front): fica no computador e toca pela Entrega
  const arts=all.filter(a=>a.kind!=='video' && !/\.(mp4|m4v|mov|webm)$/i.test(a.name||''));
  if(!arts.length){ toast(all.length?'Só há vídeos — eles ficam no seu computador (veja na Entrega).':'Sem artefatos ainda — peça as provas/entregáveis primeiro.','warn'); return; }
  if(all.length>arts.length) toast(`${all.length-arts.length} vídeo(s) ficam só no seu computador — o time vê os prints e documentos`);
  if(btn){ btn.disabled=true; }
  let sent=0;
  try{
    for(const a of arts){
      if(btn) btn.textContent=`enviando ${sent+1}/${arts.length}…`;
      const raw=await invoke('read_artifact_raw',{ taskId:t.id, name:a.name });
      const bin=Uint8Array.from(atob(raw.b64), c=>c.charCodeAt(0));
      const path=cid+'/'+a.name;
      const s=SB.sess();
      const r=await fetch(SB.url()+'/storage/v1/object/artifacts/'+path, { method:'POST', headers:{ 'apikey':SB.key(), 'Authorization':'Bearer '+s.access_token, 'Content-Type':raw.mime, 'x-upsert':'true' }, body: bin });
      if(!r.ok){ const tx=await r.text(); throw new Error(a.name+': '+tx.slice(0,160)); }
      await sbFetch('/rest/v1/artifacts_meta?task_id=eq.'+cid+'&name=eq.'+encodeURIComponent(a.name), { method:'DELETE' }).catch(()=>{});
      await sbPost('artifacts_meta',{ task_id:cid, uploaded_by:cloudUserId(), name:a.name, kind:/\.(png|jpe?g|webp|gif)$/i.test(a.name)?'image':/\.(md|html?)$/i.test(a.name)?'doc':'file', size:raw.size||0, storage_path:path });
      sent++;
    }
    sbPost('task_activity',{ task_id:cid, user_id:cloudUserId(), kind:'delivered', body:sent+' artefato(s) publicados' }).catch(()=>{});
    await cloudPubList(cid, true);
    if(!btn) toast(sent+' artefato(s) publicados no time','ok');
    if(btn){ btn.textContent='✓ '+sent+' publicados'; setTimeout(()=>{ btn.disabled=false; btn.innerHTML=window.ic('cloud')+'publicar provas pro time'; }, 3500); }
    lastSig='';
  }catch(e){ showErr(e, 'Falha ao publicar'); if(btn){ btn.disabled=false; btn.innerHTML=window.ic('cloud')+'publicar provas pro time'; } }
}
async function cloudSignedUrl(path){
  const j=await sbFetch('/storage/v1/object/sign/artifacts/'+path, { method:'POST', body: JSON.stringify({ expiresIn: 3600 }) });
  return SB.url()+'/storage/v1'+(j.signedURL||j.signedUrl||'');
}

/* ---- catálogo da org: agentes/workflows compartilhados entre os devs ---- */
async function cloudCatalog(orgId, isAdmin){
  const el=$id('sbCat'); if(!el) return;
  try{
    const [ags, wfs]=await Promise.all([
      sbGet('org_agents?select=id,name,role,color&org_id=eq.'+orgId+'&order=name'),
      sbGet('org_workflows?select=id,name,steps&org_id=eq.'+orgId+'&order=name'),
    ]);
    el.innerHTML = (ags.length||wfs.length)
      ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:2px 0">${ags.map(a=>`<span class="tmbadge" style="color:${escA(a.color||'var(--text-2)')};border-color:${escA(a.color||'var(--border)')}">${esc(a.name)} · ${esc(a.role)}</span>`).join('')}</div>`
        +(wfs.length?`<div class="dim" style="font-size:var(--fs-xs);margin-top:6px">equipes: ${wfs.map(w=>esc(w.name)+' ('+(w.steps||[]).length+')').join(' · ')}</div>`:'')
      : 'nenhum agente publicado ainda — use “enviar os deste projeto”';
    { const b=$id('sbCatPull'); if(b) b.onclick=async()=>{
        b.disabled=true; b.textContent='aplicando…';
        try{
          const local=await invoke('config');
          const byId=o=>Object.fromEntries((o||[]).map(x=>[x.id,x]));
          const la=byId(local.agents), lw=byId(local.workflows); // inventário 21: era $id (getElementById → null) e sempre falhava
          for(const a of ags){ const full=await sbGet('org_agents?select=*&org_id=eq.'+orgId+'&id=eq.'+encodeURIComponent(a.id)); const f=full[0]; if(!f) continue; la[f.id]={ id:f.id, name:f.name, role:f.role, engine:f.engine||'claude', model:f.model||undefined, color:f.color||undefined, persona:f.persona||'' }; }
          for(const w of wfs){ lw[w.id]={ id:w.id, name:w.name, steps:w.steps||[] }; }
          await invoke('save_config',{ config:{ agents:Object.values(la), workflows:Object.values(lw) } });
          b.textContent='✓ aplicado no projeto';
        }catch(e){ showErr(e, 'Falhou'); b.disabled=false; b.textContent='aplicar neste projeto'; }
      }; }
    { const b=$id('sbCatPush'); if(b) b.onclick=async()=>{
        b.disabled=true; b.textContent='enviando…';
        try{
          const local=await invoke('config');
          for(const a of (local.agents||[])){ if(!a.id) continue; await sbFetch('/rest/v1/org_agents?on_conflict=org_id,id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ org_id:orgId, id:a.id, name:a.name, role:a.role||'builder', engine:a.engine||'claude', model:a.model||null, color:a.color||null, persona:a.persona||'' }) }); }
          for(const w of (local.workflows||[])){ if(!w.id) continue; await sbFetch('/rest/v1/org_workflows?on_conflict=org_id,id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ org_id:orgId, id:w.id, name:w.name, steps:w.steps||[] }) }); }
          b.textContent='✓ publicado pra org';
          cloudCatalog(orgId, isAdmin);
        }catch(e){ showErr(e, 'Falhou'); b.disabled=false; b.textContent='enviar os deste projeto'; }
      }; }
  }catch(e){ el.textContent=humanErr(e,'Não consegui carregar').msg; }
}

/* ---- F4 (fatia): visão da organização pra owner/admin + chave de licença ---- */
async function cloudOrgView(){
  // RLS: admin enxerga as tasks de todos os times da org — agrega por time
  const [tasks, teams]=await Promise.all([
    sbGet('tasks?select=team_id,status,cost_usd&limit=1000'),
    sbGet('teams?select=id,name&order=name'),
  ]);
  const by={};
  for(const t of tasks){ const b=by[t.team_id]||(by[t.team_id]={n:0,run:0,done:0,usd:0}); b.n++; if(['review','delivered','done','merged'].includes(t.status)) b.done++; else if(t.status!=='backlog') b.run++; b.usd+=(+t.cost_usd||0); }
  return teams.map(tm=>({ name:tm.name, ...(by[tm.id]||{n:0,run:0,done:0,usd:0}) }));
}

/* ===== ABAS: expõe openers do bloco 1 e re-aponta os botões pra abrir como aba ===== */
window.openCloud = ()=>{ if(typeof ajustesOpen==='function') ajustesOpen('perfil'); else openCloud(); };
window.openAgents = openAgents;
window.switchProject = switchProject;
window.pickFolder = pickFolder;
try{ if(window.ndInjectFonts) window.ndInjectFonts(); }catch(_){}
if(typeof projects!=='undefined') window.projectsList = ()=>projects;
[['newTaskBtn','nova'],['projetosBtn','projetos'],['skillsBtn','skills'],['issuesBtn','issues'],['cfgBtn','cfg'],['dailyBtn','daily'],['pcBtn','chat'],['envBtn','env'],['cloudBtn','conta'],['agentsBtn','agents']].forEach(([id,kind])=>{
  const b=$id(id); if(b) b.onclick=(e)=>{ if(e&&e.preventDefault)e.preventDefault(); window.openTab(kind); };
});
if(window.openTab) window.openTab('flow');
