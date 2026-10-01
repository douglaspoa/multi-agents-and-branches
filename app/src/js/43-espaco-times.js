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
// "em andamento" = MESMA etapa da Central (antes: running/thinking/queued/plan-review, e plano pra aprovar contava como rodando)
function tsRunningOf(uid){ return (teamTasks||[]).filter(t=>t.assignee===uid && tsBucket(t)==='andamento'); }
function tsAv(uid, on){ const n=tmName(uid); return `<span class="tsav${on?' on':''}" style="background:${agentColor(n)}" title="${escA(n)}">${esc(n.slice(0,2).toUpperCase())}</span>`; }
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
  if(t.status==='backlog') return 5;
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
  const canClaim=t.status==='backlog' && (t.claim_mode==='open'||t.created_by===me);
  const whoTx=ctWhoLabel(t, me, tmName); // "criada por Fulano" — o que é todo meu não ganha nada
  const ep=t.epic_id?(teamEpics.find(e=>e.id===t.epic_id)||{}).name:'';
  const rp=t.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  const prov=list&&list.length?`<span class="tspv"><b>${IC.ok}</b>${list.filter(x=>x.status==='done').length}/${list.length} provados</span>`:'';
  const who=t.assignee||t.created_by;
  const bk=tsBucket(t), st=tsSt(t);
  const running=bk==='andamento' && t.status!=='backlog';
  const isErr=bk==='aguardando';
  const obj=((t.spec||{}).objective||'').replace(/\s+/g,' ').slice(0,160);
  const reqs=((t.spec||{}).requirements||[]).filter(Boolean);
  const teamTag=(typeof tsOrgScope==='function'&&tsOrgScope())?`<span class="tsteamtag" title="time">${esc(tsTeamName(t.team_id)||'?')}</span>`:'';
  const epSt=(t.epic_id&&typeof epColor==='function')?` style="--epc:${epColor(t.epic_id)}"`:''; // F2: cor estável do épico
  return `<div class="tscard dcard-like${epSt?' has-ep':''}" data-ct="${escA(t.id)}"${epSt}>
    <div class="tt">${esc(t.title)}${teamTag}</div>
    ${obj?`<div class="dc-obj">${esc(obj)}</div>`:''}
    ${reqs.length?`<div class="dc-reqs">${reqs.slice(0,3).map((r,i)=>{ const p=list&&list.find(x=>reqNorm(x.req)===reqNorm(r)); const st=p?(p.status==='done'?'ok':'blk'):'na'; return `<span class="dc-req ${st}"><i>${st==='ok'?IC.ok:st==='blk'?IC.stErr:''}</i>${esc(r)}</span>`; }).join('')}${reqs.length>3?`<span class="dc-more">+${reqs.length-3}</span>`:''}</div>`:''}
    ${ctPhaseBar(t)}
    <div class="meta">${ep?`<span class="tsepc" title="${escA('épico “'+ep+'”'+((t.spec||{}).wave?' · onda '+(t.spec||{}).wave:''))}">${IC.epic} ${esc(ep)}${(t.spec||{}).wave?' · onda '+esc(String((t.spec||{}).wave)):''}</span>`:''}${t.pr_url?`<button class="tslk" data-lk="${escA(t.pr_url)}" title="abrir o Pull Request no GitHub" style="color:var(--info)">PR ${icEm(IC.extlink)}</button>`:''}${(()=>{const c=((t.branch||'')+' '+(t.title||'')).match(/\b([A-Z]{2,10}-\d+)\b/);const b=(lsGet('issueBase')||'').trim();return c?(b?`<button class="tslk" data-lk="${escA(b.replace(/\/+$/,'')+'/'+c[1])}" title="abrir a issue"><span class="mono">${esc(c[1])}</span> ${icEm(IC.extlink)}</button>`:`<span class="mono">${esc(c[1])}</span>`):''})()}${t.branch?`<span class="mono">${esc(t.branch.split('/').pop().slice(0,18))}</span>`:''}${t.cost_usd>0?`<span>${fmtUsd(+t.cost_usd)}</span>`:''}${t.claim_mode==='reserved'?'<span class="tmbadge" style="font-size:9px">pra si</span>':''}${isLocal?'':`<span class="tsnolocal" title="${escA('nenhum projeto aberto nesta máquina tem o repositório '+(proj.repo_remote||'')+' — clone a pasta e adicione em Projetos pra poder assumir')}">projeto que você não tem neste computador</span>`}</div>
    ${whoTx?`<div class="tswho" title="${escA(whoTx)}">${esc(whoTx)}</div>`:''}
    <div class="foot">${tsAv(who, tsOnline(who))}${prov}<span style="flex:1"></span>
      ${isErr?`<span class="tstag" style="color:${stColor(st)};border:1px solid currentColor">${esc(stLabel(st))}</span>`:running?`<span class="tstag run">${esc(stLabel(st))}</span>`:ctWaiting(t)?`<span class="tstag" title="começa sozinha quando as tarefas da onda anterior forem concluídas ou mergeadas (onda = grupo de tarefas que rodam juntas)">na espera da onda anterior</span>`:''}
      ${canClaim?(sameRepo?`<button class="btn primary sm" data-act="claim" title="assumir e iniciar nesta máquina — a tarefa passa pra sua Execução" style="padding:3px 9px;font-size:10.5px">${IC.play} assumir</button>`:isLocal?`<button class="btn sm" data-act="openproj" title="${escA('a tarefa é do projeto '+(proj.name||proj.repo_remote||'')+' — abrir ele aqui pra assumir')}" style="padding:3px 9px;font-size:10.5px">abrir ${esc(proj.name||'o projeto')}</button>`:''):''}
      ${(t.status==='backlog'&&(t.created_by===me||isAdmin))?`<button class="btn sm" data-act="del" style="padding:3px 7px;font-size:10.5px">${IC.x}</button>`:''}
    </div></div>`;
}
function tsK(kind){ return {created:'criou',edited:'editou',claimed:'assumiu',released:'liberou',started:'iniciou',delivered:'publicou provas em',comment:'comentou em',status:'mudou o status de'}[kind]||kind; }
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
  const me=cloudUserId();
  const isAdmin=cloudData && (cloudData.meRole==='owner'||cloudData.meRole==='admin');
  const B=tsBuckets();
  const epSel=lsGet('tmEpic')||'';
  const devSel=lsGet('tmDev')||'';
  const all=teamTasks;
  let vis=all;
  if(epSel && teamEpics.some(e=>e.id===epSel)) vis=vis.filter(t=>t.epic_id===epSel);
  if(devSel) vis=vis.filter(t=>(t.assignee||t.created_by)===devSel);
  const orgScope=tsOrgScope();
  const teamName=orgScope?'toda a organização':esc((((cloudData&&cloudData.teams)||[]).find(x=>x.id===cloudTeamId())||{}).name||'Time');
  const scopeIds=tsScopeTeamIds();
  const members=[...new Set([ ...scopeIds.flatMap(tid=>(((cloudData&&cloudData.teamMembers)||{})[tid]||[]).map(m=>m.user_id)), ...(orgScope?((cloudData&&cloudData.orgMembers)||[]).map(m=>m.user_id):[]), ...all.flatMap(t=>[t.assignee,t.created_by]).filter(Boolean) ])];
  // times de cada pessoa (no escopo da org: etiquetas nos cartões de Pessoas)
  const teamsOf=uid=>scopeIds.filter(tid=>(((cloudData&&cloudData.teamMembers)||{})[tid]||[]).some(m=>m.user_id===uid));
  const roleOf=uid=>{ for(const tid of scopeIds){ const r=(((cloudData&&cloudData.teamMembers)||{})[tid]||[]).find(m=>m.user_id===uid); if(r&&r.role==='lead') return 'lead'; } return teamsOf(uid).length?'membro':'sem time'; };
  // reviews feitos pelo time (dedup): pr_url → quem revisou
  const tsRevBy={};
  all.forEach(t=>{ if(t.pr_url && (((t.spec||{}).kind==='review')||/^review (do |de )?pr/i.test(t.title||''))) tsRevBy[t.pr_url]=t.assignee||t.created_by; });
  const tsRevChip=(u)=>u?`<span class="tstag" style="color:var(--good);border:1px solid currentColor" title="review já feito por ${escA(tmName(u))} — parecer no cartão dele">✓ revisado · ${esc(tmName(u).slice(0,14))}</span>`:'';
  const prs=all.filter(t=>t.pr_url && t.status!=='merged' && (t.spec||{}).kind!=='review');
  const unsynced=(state.tasks||[]).filter(t=>!tmap()[t.id] && t.status!=='draft').length;
  // ---------- sidebar ----------
  const NAV=[['overview','Visão geral',''],['board','Quadro',String(vis.length)],['prs','PRs pra revisar',prs.length?String(prs.length):''],['people','Pessoas',String(members.length)],['feed','Atividade','']];
  // navegação do Time = ABAS HORIZONTAIS (mesma disposição das outras telas — sem menu lateral próprio)
  const subTabs=`<div class="ftabs" style="margin-bottom:16px">`+
    NAV.map(([k,l,n])=>`<button class="ft${tmView===k?' on':''}" data-tsv="${k}">${l}${n?` <span class="n${k==='prs'&&prs.length?' hot':''}" style="font-size:10px;opacity:.8">${n}</span>`:''}</button>`).join('')+
    `<span class="grow"></span>${isAdmin?`<span class="tsscope" title="owner/admin: alterna entre o time escolhido em Conta e a organização inteira"><button class="${orgScope?'':'on'}" data-tscope="team">meu time</button><button class="${orgScope?'on':''}" data-tscope="org">toda a organização</button></span>`:''}<span class="dim mono tsnavlbl" style="font-size:10.5px;align-self:center;white-space:nowrap">${orgScope?`${(cloudData.teams||[]).length} times · ${((cloudData.orgMembers)||[]).length} pessoas`:'time '+teamName}</span></div>`;
  let side=``;
  // épicos viram CHIPS (no Quadro) — membros vivem na vista Pessoas
  const epicChips=(teamEpics.length?teamEpics.map(e=>{ const ts=all.filter(t=>t.epic_id===e.id); const done=ts.filter(epDelivered).length;
    const dw=Array.isArray((e.spec||{}).doneWhen)?e.spec.doneWhen:[]; const dwOk=dw.filter(d=>d&&d.checkedBy).length;
    return `<span class="fchipgrp"><button class="fchip${epSel===e.id?' on':''}" data-epsel="${escA(e.id)}" title="filtrar o quadro por este épico" style="--epc:${typeof epColor==='function'?epColor(e.id):'var(--accent)'}"><span class="pfd" style="background:var(--epc)"></span>◆ ${esc(e.name)}<span class="n" title="${done} de ${ts.length} tarefas entregues (mergeadas ou concluídas)">${done}/${ts.length}</span>${dw.length?`<span class="n" title="pronto quando">${IC.ok} ${dwOk}/${dw.length}</span>`:''}</button><button class="fchip fchip-open" data-epopen="${escA(e.id)}" title="abrir a página do épico">⤢</button></span>`; }).join(''):'')+
    `<button class="fchip" id="tbEpicAdd">+ épico</button>`;
  // ---------- main por vista ----------
  let main='';
  const perNow=lsGet('tmPeriod')||'all';
  const perSel=`<select class="sel" id="tbPeriod" aria-label="período" style="width:120px">${[['7','últimos 7 dias'],['30','30 dias'],['90','trimestre'],['all','tudo']].map(([v,l])=>`<option value="${v}"${v===perNow?' selected':''}>${l}</option>`).join('')}</select>`;
  const devOpts=`<select class="sel" id="tbDev" aria-label="filtrar por dev" style="width:140px"><option value="">todos os devs</option>${members.map(u=>`<option value="${escA(u)}"${u===devSel?' selected':''}>${esc(tmName(u))}</option>`).join('')}</select>`;
  if(tmView==='overview'){
    const inP=tsPeriodTasks();
    const done=inP.filter(B.done).length+inP.filter(B.review).length;
    // MESMA contagem da Central (flowCounts sobre os cartões normalizados)
    const fcT=flowCounts(all.map(tsNorm).filter(t=>t.flag!=='blocked'));
    const doing=all.filter(t=>tsBucket(t)==='andamento');
    const nDevs=members.filter(u=>tsRunningOf(u).length).length;
    const asking=all.filter(t=>t.assignee===me&&false); // pergunta real vem do desktop de cada dev
    const custo=inP.reduce((s,t)=>s+(+t.cost_usd||0),0);
    const activeEps=teamEpics.filter(e=>e.status!=='done'&&e.status!=='archived'); // B2: concluído não é "ativo"
    const eps=activeEps.length;
    // entregas por dia (últimos 7)
    const days=[...Array(7)].map((_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(6-i)); d.setHours(0,0,0,0); return d; });
    const perDay=days.map(d=>all.filter(t=>(B.done(t)||B.review(t)) && new Date(t.updated_at)>=d && new Date(t.updated_at)<new Date(+d+86400e3)).length);
    const mx=Math.max(1,...perDay);
    const DL=['dom','seg','ter','qua','qui','sex','sáb'];
    main=`<h1>Visão geral</h1><div class="tssub">time ${teamName} · ${perSel}</div>
    <div class="tskpis">
      <div class="tskpi"><div class="v">${done}</div><div class="l">entregas</div><div class="d">${inP.length} tarefas no período</div></div>
      <div class="tskpi"><div class="v" style="color:var(--accent)">${doing.length}</div><div class="l">em andamento</div><div class="d">${fcT.aguardando?`${fcT.aguardando} aguardando alguém · `:''}${nPl(nDevs,'dev ativo','devs ativos')}</div></div>
      <div class="tskpi"><div class="v" style="color:#c678dd">${eps}</div><div class="l">épicos ativos</div><div class="d">${activeEps.slice(0,2).map(e=>{const ts=all.filter(t=>t.epic_id===e.id);const dn=ts.filter(epDelivered).length;return esc(e.name.split(' ')[0])+' '+dn+'/'+ts.length;}).join(' · ')||'—'}</div></div>
      <div class="tskpi"><div class="v" style="color:${prs.length?'var(--warn)':'var(--text)'}">${prs.length}</div><div class="l">PRs pra revisar</div><div class="d">${prs.length?'mais antigo '+agoTx(prs[prs.length-1].updated_at):'em dia ✓'}</div></div>
      <div class="tskpi"><div class="v">${fmtCost(custo,{usdOnly:true})}</div><div class="l">custo no período · ≈ R$ ${fmtNumBR(custo*usdBrlRate(),true)}</div><div class="d">${inP.length?fmtCost(custo/Math.max(1,done||1))+' por entrega':'—'}</div></div>
    </div>
    <div class="tscols"><div>
      <div class="tspanel"><div class="tsph">Agora no time <span style="flex:1"></span><span style="color:var(--accent);font-size:10px">● ao vivo</span></div>
        ${doing.length?doing.slice(0,6).map(t=>{ const who=t.assignee||t.created_by; return `<div class="tslive"><span class="who">${tsAv(who,tsOnline(who))}${esc(tmName(who)).slice(0,14)}</span><span class="what" data-ct="${escA(t.id)}" style="cursor:pointer"><b>${esc(t.stage||'agente')}</b> · ${esc(t.title)}${t.last_note?' — '+esc(t.last_note.slice(0,60)):''}</span><span class="tstag run">${esc(stLabel(tsSt(t)))}</span></div>`; }).join(''):'<div class="dim" style="font-size:12px">nenhuma tarefa em andamento agora</div>'}
      </div>
      <div class="tspanel"><div class="tsph">PRs esperando gente</div>
        ${prs.length?prs.slice(0,5).map(t=>`<div class="tslive"><span class="mono" style="color:var(--accent);font-size:11px">${esc((t.pr_url.match(/\/pull\/(\d+)/)||[])[1]?'#'+(t.pr_url.match(/\/pull\/(\d+)/)||[])[1]:'PR')}</span><span class="what" data-ct="${escA(t.id)}" style="cursor:pointer">${esc(t.title)}</span>${tsAv(t.assignee||t.created_by,false)}${tsRevChip(tsRevBy[t.pr_url])}<button class="btn sm" data-pr="${escA(t.pr_url)}" style="padding:3px 8px;font-size:10.5px">abrir ↗</button><button class="btn ${tsRevBy[t.pr_url]?'':'primary '}sm" data-rev="${escA(t.id)}" style="padding:3px 8px;font-size:10.5px">revisar com agente</button></div>`).join(''):'<div class="dim" style="font-size:12px">nenhum PR aberto — em dia ✓</div>'}
      </div>
    </div><div>
      <div class="tspanel"><div class="tsph">Entregas por dia</div><div class="tsspark">${perDay.map((n,i)=>`<div class="c"><div class="b" style="height:${Math.round(n/mx*100)}%"></div><span class="dl">${DL[days[i].getDay()]}</span></div>`).join('')}</div></div>
      <div class="tspanel"><div class="tsph">Entregas por membro</div>
        ${(()=>{ const per={}; for(const t of inP){ const w=t.assignee||t.created_by; const b=per[w]||(per[w]={d:0,r:0,u:0}); if(B.done(t)||B.review(t)) b.d++; else if(tsBucket(t)==='andamento') b.r++; b.u+=(+t.cost_usd||0); }
          const rows=Object.entries(per).sort((a,b)=>b[1].d-a[1].d);
          return rows.length?rows.map(([u,v])=>`<div class="tslive"><span class="who" title="${escA(tmName(u))}">${tsAv(u,tsOnline(u))}${esc(tmName(u).slice(0,14))}</span><span class="what">${nPl(v.d,'entrega')} · ${v.r} em andamento</span><span class="dim tscost" style="font-size:11px">${fmtUsd(v.u)}</span></div>`).join(''):'<div class="dim" style="font-size:12px">sem atividade no período</div>'; })()}
      </div>
    </div></div>`;
  } else if(tmView==='board'){
    // M1: mesmos nomes da Central/Kanban (STATUS_META) · M7: conta TUDO e só depois corta a lista em 8 (+N)
    // R3: colunas derivadas da MESMA etapa da Central (flowBucket) — erro/conflito/plano pra aprovar não se escondem
    // mais em "Em andamento"; PR aberto fica junto de "prontas" (a aba PRs detalha)
    const inB=(...ks)=>t=>ks.includes(tsBucket(t));
    const cols=[['Na fila',stColor('backlog'),vis.filter(inB('fila','rascunho')),0],['Aguardando alguém',stColor('asking'),vis.filter(inB('aguardando')),0],['Em andamento',stColor('running'),vis.filter(inB('andamento')),0],['Prontas / PR aberto',stColor('review'),vis.filter(inB('prontas','praberto')),0],['Concluídas',stColor('done'),vis.filter(inB('hoje','anteriores')),8]];
    main=`<h1>Quadro do time</h1><div class="tssub">${devOpts}${epicChips}${unsynced?`<button class="btn sm" id="tbBackfill">⇡ publicar ${unsynced} local${unsynced===1?'':'is'}</button>`:''}<span style="flex:1"></span><button class="btn sm" id="tbRefresh">atualizar</button></div>
    <div class="tsboard ts5">${cols.map(([l,c,ts,cap])=>{ const shown=cap?ts.slice(0,cap):ts; return `<div class="tscol"><div class="tskh"><span class="dot" style="background:${c}"></span>${l}<span class="n">${ts.length}</span></div>${shown.map(t=>tsCardHtml(t,me,isAdmin)).join('')||'<div class="dim" style="font-size:11px;padding:6px">vazio</div>'}${ts.length>shown.length?`<div class="dim tsmore" style="font-size:11px;padding:6px" title="mostrando as ${shown.length} mais recentes">+${ts.length-shown.length} concluídas</div>`:''}</div>`; }).join('')}</div>`;
  } else if(tmView==='prs'){
    main=`<h1>PRs pra revisar</h1><div class="tssub">todo cartão do time com PR aberto</div>`+
      (prs.length?prs.map(t=>{ const n=(t.pr_url.match(/\/pull\/(\d+)/)||[])[1];
        return `<div class="tspanel" style="display:flex;align-items:center;gap:12px"><span class="mono" style="color:var(--accent)">${n?'#'+n:'PR'}</span><div style="flex:1;min-width:0"><b style="font-size:13px">${esc(t.title)}</b><div class="dim" style="font-size:11px">de ${esc(tmName(t.assignee||t.created_by))} · ${esc(stLabel(tsSt(t)))} · ${agoTx(t.updated_at)}</div></div>${tsRevChip(tsRevBy[t.pr_url])}<button class="btn sm" data-pr="${escA(t.pr_url)}">abrir ↗</button><button class="btn ${tsRevBy[t.pr_url]?'':'primary '}sm" data-rev="${escA(t.id)}">revisar com agente</button></div>`; }).join('')
      :'<div class="emptyrepo" style="display:flex"><div class="big">Em dia ✓</div><div>nenhum PR do time esperando review.</div></div>');
  } else if(tmView==='people'){
    const inP=tsPeriodTasks();
    main=`<h1>Pessoas</h1><div class="tssub">${members.length} membros · ${perSel}</div><div class="tsppl">`+
      members.map(uid=>{ const p=teamProfiles[uid]||{}; const on=tsOnline(uid); const run=tsRunningOf(uid);
        const mine=inP.filter(t=>(t.assignee||t.created_by)===uid);
        const d=mine.filter(t=>B.done(t)||B.review(t)).length, u=mine.reduce((s,t)=>s+(+t.cost_usd||0),0);
        const lastAct=(teamActivity||[]).find(a=>a.user_id===uid);
        const teamTags=orgScope?teamsOf(uid).map(tid=>`<span class="tsteamtag">${esc(tsTeamName(tid))}</span>`).join(''):'';
        return `<div class="tspc"><div class="hh">${tsAv(uid,on)}<div><b style="font-size:13.5px">${esc(tmName(uid))}</b><div class="dim" style="font-size:10.5px">${roleOf(uid)} · ${on?'<span style=color:var(--accent)>online</span>':(p.last_seen_at?agoTx(p.last_seen_at):'—')}${teamTags?' · '+teamTags:''}</div></div></div>
          <div class="nums"><div><b>${d}</b><span>entregas</span></div><div><b>${run.length}</b><span>em andamento</span></div><div><b>${fmtCost(u,{usdOnly:true})}</b><span>custo · ≈ R$ ${fmtNumBR(u*usdBrlRate(),true)}</span></div></div>
          <div class="now">${run.length?`agora: <b>${esc(run[0].stage||'agente')}</b> em “${esc(run[0].title.slice(0,42))}”`:(lastAct?`último: ${tsK(lastAct.kind)} ${esc(((all.find(t=>t.id===lastAct.task_id)||{}).title||'').slice(0,40))} · ${agoTx(lastAct.at)}`:'sem atividade recente')}</div>
          ${(()=>{ // tarefas da pessoa com badge de TIPO + progresso (redesign p7)
            const act=mine.filter(t=>!['merged','done'].includes(t.status)&&t.flag!=='closed').slice(0,3);
            if(!act.length) return '';
            const KIND_PT={build:'FEATURE',fix:'FIX',invest:'INVESTIGAÇÃO',design:'DESIGN',review:'REVIEW'};
            const KIND_CO={build:'var(--accent)',fix:'var(--warn)',invest:'#c678dd',design:'var(--info)',review:'var(--good)'};
            const pctOf=s=>({backlog:5,requested:10,queued:15,running:45,thinking:45,'plan-review':30,review:80,delivered:85,error:45,conflict:45}[s]??20);
            return act.map(t=>{ const k=(t.spec||{}).kind|| ((t.branch||'').startsWith('fix/')?'fix':(t.branch||'').startsWith('invest/')?'invest':(t.branch||'').startsWith('design/')?'design':'build');
              return `<div data-ct="${escA(t.id)}" style="cursor:pointer;margin-top:7px;padding-top:7px;border-top:1px dashed var(--border)">
                <div style="display:flex;gap:7px;align-items:center;font-size:11.5px"><span class="mono" style="font-size:9px;font-weight:700;letter-spacing:.5px;color:${KIND_CO[k]||'var(--muted)'};border:1px solid currentColor;border-radius:4px;padding:1px 5px">${KIND_PT[k]||'TAREFA'}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span></div>
                <div class="tsbar" style="margin-top:5px"><i style="width:${pctOf(t.status)}%"></i></div></div>`; }).join('');
          })()}</div>`; }).join('')+`</div>`;
  } else if(tmView==='feed'){
    main=`<h1>Atividade do time</h1><div class="tssub">mais recente primeiro</div><div class="tspanel tsfeed">`+
      ((teamActivity||[]).length?(teamActivity||[]).slice(0,40).map(a=>{ const t=all.find(x=>x.id===a.task_id);
        return `<div class="fi">${tsAv(a.user_id,false)}<span class="tx"><b>${esc(tmName(a.user_id))}</b> ${tsK(a.kind)} <b data-ct="${escA(a.task_id)}" style="cursor:pointer">${esc((t||{}).title||'tarefa')}</b>${a.body?` — ${esc(a.body.slice(0,80))}`:''}</span><span class="tm">${agoTx(a.at)}</span></div>`; }).join('')
      :'<div class="dim" style="font-size:12px">sem atividade ainda</div>')+`</div>`;
  }
  void side;
  const html=`<div class="tspace"><div class="tmain">${subTabs}${main}</div></div>`;
  if(teamPaintSig===html) return;
  teamPaintSig=html; el.innerHTML=html;
  // ---------- wiring ----------
  el.querySelectorAll('[data-tsv]').forEach(b=>{ b.onclick=()=>{ tmView=b.dataset.tsv; lsSet('tmView',tmView); teamPaintSig=''; renderTeamBoard(); }; });
  el.querySelectorAll('[data-tscope]').forEach(b=>{ b.onclick=()=>tsSetScope(b.dataset.tscope); });
  el.querySelectorAll('[data-epopen]').forEach(b=>{ b.onclick=()=>{ const e=teamEpics.find(x=>x.id===b.dataset.epopen); if(e&&window.openEpicPage) openEpicPage(e); }; });
  el.querySelectorAll('[data-epsel]').forEach(b=>{ b.onclick=()=>{ lsSet('tmEpic', lsGet('tmEpic')===b.dataset.epsel?'':b.dataset.epsel); if(tmView!=='board'){ tmView='board'; lsSet('tmView','board'); } teamPaintSig=''; renderTeamBoard(); }; });
  { const b=el.querySelector('#tbEpicAdd'); if(b) b.onclick=async()=>{ const n=await askText('Novo épico','ex.: Filtros avançados'); if(!n) return; try{ await sbPost('epics',{ team_id:cloudTeamId(), name:n.trim(), created_by:cloudUserId() }); teamTasks=null; teamPaintSig=''; renderTeamBoard(); }catch(e){ showErr(e, 'Falhou'); } }; }
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
    if(b.dataset.act==='claim') teamClaimStart(ct, b); else if(b.dataset.act==='openproj'){ if(typeof epOpenProjectOf==='function') epOpenProjectOf(teamProj[ct.project_id]||{}); } else if(b.dataset.act==='del') teamDeleteCard(ct); }; });
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
    // defaults por baixo: cartão criado "enxuto" (ex.: derivado de épico) roda igual
    // ...(ct.spec) traz verify/covers/after/wave/risk/hitl quando o cartão veio de um épico; epic_id é coluna, não spec
    const payload={ workflow:null, agents:null, engine:'claude', approval:'auto', owns:null, off:null, objective:null, deliverables:[], requirements:[], doc:null, proof:false, tests:false, autoPr:'ask', prBase:null, planApproval:'auto', refs:[], branchType:'feat', issue:null, base:null, linkedTo:null, ...(ct.spec||{}), issue:(ct.spec&&ct.spec.issueCode)||null, issueUrl:(ct.spec&&ct.spec.issueUrl)||ct.issue_url||null, epicId: ct.epic_id||null, epicDoneWhen: epicDoneWhenOf(ct.epic_id)||(ct.spec&&ct.spec.epicDoneWhen)||null, title: ct.spec?.title||ct.title, start:true };
    if(ct.epic_id && window.epicAttachRef) await epicAttachRef(payload, ct.epic_id, ct); // EPIC.md compilado vai como referência
    const localId=await invoke('new_task', await trkBeforeNewTask(payload));
    tmapSet(localId, ct.id);
    await sbFetch('/rest/v1/tasks?id=eq.'+ct.id, { method:'PATCH', body: JSON.stringify({ status:'running', local_id: localId }) });
    if(ct.epic_id && window.epicMarkInProgress) epicMarkInProgress(ct.epic_id); // 1ª tarefa rodando → épico em andamento
    sbPost('task_activity',{ task_id:ct.id, user_id:cloudUserId(), kind:'started', body:'' }).catch(()=>{});
    // some da fila dos épicos NA HORA (o tick da nuvem só volta em até 20 s) e aparece na MINHA Execução
    if(typeof epQueue!=='undefined' && epQueue.rows) epQueue.rows=epQueue.rows.filter(r=>r.id!==ct.id);
    teamTasks=null; lastSig=''; allTasksAt=0; await refresh();
    if(!opts.silent){ flowScope='exec'; lsSet('flowScope','exec'); setView('flow'); }
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
    <label style="margin-top:12px">Objetivo</label><textarea class="in ta" id="ctObj" rows="4" ${canEdit?'':'disabled'}>${esc(sp.objective||'')}</textarea>
    <label style="margin-top:12px">Requisitos <span class="dim" style="text-transform:none;letter-spacing:0">(um por linha — o agente é cobrado por cada um)</span></label>
    <textarea class="in ta" id="ctReqs" rows="${Math.max(3,reqs.length+1)}" ${canEdit?'':'disabled'}>${esc(reqs.join('\n'))}</textarea>
    ${(sp.deliverables||[]).length?`<label style="margin-top:12px">Entregáveis</label><div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px">${(sp.deliverables||[]).map(d=>`<div style="display:flex;gap:8px;font-size:12.5px;padding:3px 0"><span style="color:var(--accent)">◆</span><span>${esc(d)}</span></div>`).join('')}</div>`:''}
    <label style="margin-top:12px">Épico</label>
    <select class="sel" id="ctEpic" style="width:100%"><option value="">— sem épico —</option>${teamEpics.map(e=>`<option value="${escA(e.id)}"${ct.epic_id===e.id?' selected':''}>${esc(e.name)}</option>`).join('')}</select>
    <div id="ctReqProof"></div>
    <div id="ctProofs"></div>
    <div id="ctAct" class="dim" style="font-size:11px;margin-top:12px">${skeletonHtml('lista',{ n:3, compact:true, inline:true, label:'carregando a atividade' })}</div>
    <div style="display:flex;gap:8px;margin-top:14px"><span style="flex:1"></span>${canEdit?'<button class="btn primary" id="ctSave">salvar alterações</button>':''}</div>`;
  // requisitos com prova (sincronizados do requirements.json do dev)
  { const rp=ct.requirements_proof; const el=$id('ctReqProof');
    if(el && rp && Array.isArray(rp.list||rp) ){
      const list=Array.isArray(rp.list)?rp.list:rp;
      if(list.length) el.innerHTML=`<div class="seclbl2" style="margin-top:14px">Requisitos provados <span class="n">${list.filter(x=>x.status==='done').length}/${list.length}</span></div>`+
        list.map(x=>`<div style="display:flex;gap:8px;font-size:12.5px;padding:5px 2px;border-bottom:1px dashed var(--border)"><span style="color:${x.status==='done'?'var(--good)':'var(--warn)'}">${x.status==='done'?'✓':'○'}</span><span style="flex:1">${esc(x.req||'')}</span></div>`).join('');
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
    const K={created:'criou',edited:'editou',claimed:'assumiu',released:'liberou',started:'iniciou',delivered:'entregou',comment:'comentou',status:'status'};
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
function ntEpicVal(){ const s=$id('ntEpic'); const v=s?s.value:''; return (v&&v!=='__new__')?v:null; }
$id('newTaskBtn').addEventListener('click', ()=>{ ntShareSync(); });

/* ---- F3: notificações do time — SÓ o que me envolve (regra única: ctNotifKind, 42 @exec) ----
   Poll leve a cada 30s; "já visto" persiste em localStorage pra não re-notificar. O "visto" é marcado pra
   TODO cartão (mesmo os que não notificam): um cartão alheio que depois vira meu não dispara aviso atrasado. */
function seenSet(k){ try{ return new Set(JSON.parse(lsGet(k)||'[]')); }catch(_){ return new Set(); } }
function seenAdd(k,id){ const s=seenSet(k); s.add(id); lsSet(k, JSON.stringify([...s].slice(-500))); }
let teamNotifReady=false;
async function teamNotifTick(){
  if(!SB.sess() || !cloudTeamId()) return;
  await teamFetch(); if(!teamTasks) return;
  const me=cloudUserId(), prs=seenSet('sb:seenpr'), cards=seenSet('sb:seencard'), revs=seenSet('sb:seenrev');
  for(const t of teamTasks){
    const isRev=((t.spec||{}).kind==='review')||/^review (do |de )?pr/i.test(t.title||'');
    const kind=teamNotifReady ? ctNotifKind(t, me, teamTasks) : null; // 1ª carga só semeia o "visto"
    const who=tmName(t.assignee||t.created_by);
    if(isRev){
      if(t.pr_url && !revs.has(t.id)){ seenAdd('sb:seenrev', t.id); if(kind==='review-done') pushNotif('Seu PR foi revisado ✓ — '+who, t.title+' · o parecer está no cartão', 'view:team'); }
      continue; // cartão de review não é "PR aberto" nem "tarefa nova"
    }
    if(t.pr_url && !prs.has(t.id)){ seenAdd('sb:seenpr', t.id); if(kind==='pr') pushNotif('PR aberto na demanda que você criou ↗', who+': '+t.title, 'view:team'); }
    if(t.status==='backlog' && !cards.has(t.id)){ seenAdd('sb:seencard', t.id); if(kind==='assigned') pushNotif('Nova tarefa pra você', tmName(t.created_by)+' atribuiu: '+t.title, 'view:team'); }
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
async function cloudPublishProofs(t, btn){
  const cid=tmap()[t.id]; if(!cid){ toast('Esta tarefa não está sincronizada com o time.','warn'); return; }
  const arts=await loadArtifacts(t.id, t.status)||[];
  if(!arts.length){ toast('Sem artefatos ainda — peça as provas/entregáveis primeiro.','warn'); return; }
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
        +(wfs.length?`<div class="dim" style="font-size:11px;margin-top:6px">equipes: ${wfs.map(w=>esc(w.name)+' ('+(w.steps||[]).length+')').join(' · ')}</div>`:'')
      : 'nenhum agente publicado ainda — use “enviar os deste projeto”';
    { const b=$id('sbCatPull'); if(b) b.onclick=async()=>{
        b.disabled=true; b.textContent='aplicando…';
        try{
          const local=await invoke('config');
          const byId=o=>Object.fromEntries((o||[]).map(x=>[x.id,x]));
          const la=$id(local.agents), lw=$id(local.workflows);
          for(const a of ags){ const full=await sbGet('org_agents?select=*&org_id=eq.'+orgId+'&id=eq.'+encodeURIComponent(a.id)); const f=full[0]; la[f.id]={ id:f.id, name:f.name, role:f.role, engine:f.engine||'claude', model:f.model||undefined, color:f.color||undefined, persona:f.persona||'' }; }
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
window.openCloud = openCloud;
window.openAgents = openAgents;
window.switchProject = switchProject;
window.pickFolder = pickFolder;
try{ if(window.ndInjectFonts) window.ndInjectFonts(); }catch(_){}
if(typeof projects!=='undefined') window.projectsList = ()=>projects;
[['newTaskBtn','nova'],['projetosBtn','projetos'],['skillsBtn','skills'],['issuesBtn','issues'],['cfgBtn','cfg'],['dailyBtn','daily'],['pcBtn','chat'],['envBtn','env'],['cloudBtn','conta'],['agentsBtn','agents']].forEach(([id,kind])=>{
  const b=$id(id); if(b) b.onclick=(e)=>{ if(e&&e.preventDefault)e.preventDefault(); window.openTab(kind); };
});
if(window.openTab) window.openTab('flow');
