// Starfork — 71-central-alcance: a Central com ALCANCE (mock aprovado pelo dono em 09/10: "Central do time").
// Seletor ao lado do título: Minhas · Do time · Org toda (esta SÓ pra owner/admin da org — e a nuvem confirma: a RLS de
// tasks/epics/projects é can_see_team = membro do time OU admin da org; membro e líder que não é admin nunca recebem
// linha de outro time, nem pedindo). Abas: Tarefas · Épicos · Entregas.
//   Minhas › Tarefas = a Central de sempre (tarefas desta máquina, fila dos épicos, Com o time) + duas seções do time:
//     "Com você no time" (no seu nome e não roda aqui) e "Livres no seu time" (Assumir).
//   Do time / Org toda › Tarefas = tudo do alcance agrupado por épico, com quem está com cada item.
//   Épicos = um épico por linha (projeto · time, x de y entregues, pessoas, pra revisar, travadas, livres).
//   Entregas = a MESMA aba do gestor do Time (70: entregasHtml) com os dados do alcance — fonte única.
// Fontes únicas reaproveitadas: dados = teamFetch/teamTasks/teamEpics/teamProj (42); regras de entregue/pronta/travada/
// grupos = epDelivered/entPronta/entTravada/entAgrupa (46/70); custo = entPodeVerCusto (70); assumir/devolver/atribuir/
// iniciar = tsClaimOnly/tsRelease/tsReassign/teamClaimStart (43, RPCs da 0032); status = tsSt/ctStLabel/stColor (STATUS_META);
// avatar = tsAv; issue = tsIssueChip/trkCardRetry. Alcance e aba ficam lembrados POR PESSOA (ca:scope:<uid>, ca:tab:<uid>).

// @ca-puro-inicio (testado em app/tests/central-alcance.test.mjs)
const CA_SCOPES=[['minhas','Minhas'],['time','Do time'],['org','Org toda']];
const CA_TABS=['tarefas','epicos','entregas'];
const CA_CHIPS=[['todas','Todas'],['comigo','Comigo'],['livres','Livres'],['revisar','Pra revisar'],['travadas','Travadas']];
function caIsAdmin(role){ return role==='owner' || role==='admin'; }
// os alcances que a pessoa pode escolher: "Org toda" só pra owner/admin da org
function caScopesFor(role){ return CA_SCOPES.filter(([k])=>k!=='org' || caIsAdmin(role)); }
// alcance salvo → válido pro papel de agora (membro com "org" salvo de outra conta/papel cai em "Do time")
function caScopeOf(saved, role){ const s=String(saved||''); if(s==='org') return caIsAdmin(role)?'org':'time'; return s==='time'?'time':'minhas'; }
function caTabOf(saved){ return CA_TABS.includes(saved)?saved:'tarefas'; }
function caFiltrosDe(raw){
  let o=null; try{ o=raw?JSON.parse(raw):null; }catch(_){ o=null; }
  o=(o&&typeof o==='object')?o:{};
  return { chip:CA_CHIPS.some(([k])=>k===o.chip)?o.chip:'todas', proj:String(o.proj||''), who:String(o.who||'') };
}
// filtro salvo que não vale mais (pessoa saiu, projeto de outro time): volta pra "todos"
function caFiltrosValidos(f, projIds, members){ return { ...f, proj:(f.proj && !(projIds||[]).includes(f.proj))?'':f.proj, who:entWhoValido(f.who, members) }; }
// fn = { bucket, delivered, flag } (as mesmas do 70 — ENT_FN)
function caLivre(t, fn){ return !!t && !t.assignee && t.status==='backlog' && !fn.delivered(t) && (fn.flag?fn.flag(t):t.flag)!=='closed'; }
// as tarefas de um alcance. x = { me, myTeams:Set (times em que EU estou), scopeTeams:Set (times do alcance) }
// Minhas = no meu nome (qualquer time) + livres dos meus times; Do time/Org toda = tudo dos times do alcance
function caDoEscopo(src, scope, x, fn){
  if(scope!=='minhas') return (src||[]).filter(t=>x.scopeTeams.has(t.team_id));
  return (src||[]).filter(t=>(x.me && t.assignee===x.me) || (x.myTeams.has(t.team_id) && caLivre(t, fn)));
}
// filtro da aba Tarefas: chip (todas/comigo/livres/revisar/travadas) + projeto + pessoa ('-' = sem dono)
function caFiltra(tasks, f, me, fn){
  f=f||{};
  return (tasks||[]).filter(t=>{
    if(f.proj && t.project_id!==f.proj) return false;
    if(f.who==='-'){ if(t.assignee) return false; } else if(f.who && t.assignee!==f.who) return false;
    switch(f.chip){
      case 'comigo': return !!me && t.assignee===me && !fn.delivered(t) && !entFora(t, fn); // = "com você" do topo
      case 'livres': return caLivre(t, fn);
      case 'revisar': return entPronta(t, fn);
      case 'travadas': return entTravada(t, fn);
      default: return true;
    }
  });
}
// números do topo (mesma régua dos chips)
function caResumo(tasks, me, fn){
  const ts=tasks||[];
  return { comigo:ts.filter(t=>me && t.assignee===me && !fn.delivered(t) && !entFora(t, fn)).length, livres:ts.filter(t=>caLivre(t, fn)).length,
    revisar:ts.filter(t=>entPronta(t, fn)).length, travadas:ts.filter(t=>entTravada(t, fn)).length };
}
// Minhas: o que está no MEU nome no time e não roda neste computador. `tasks` = o que o teamFetch trouxe (o time escolhido;
// admin em "Org toda": todos) — livre de outro time meu que não foi carregado não aparece até eu escolher aquele time (local = já tem tarefa aqui; fila = já aparece na
// fila dos épicos) — e as livres dos MEUS times. Entregue/cancelada não entra.
function caMinhas(tasks, me, myTeams, fn, isLocal, inQueue){
  const vivo=t=>!fn.delivered(t) && !entFora(t, fn);
  const comigo=(tasks||[]).filter(t=>me && t.assignee===me && vivo(t) && !isLocal(t) && !inQueue(t));
  const livres=(tasks||[]).filter(t=>caLivre(t, fn) && myTeams.has(t.team_id) && !inQueue(t));
  return { comigo, livres };
}
// as ações da linha (mock): x = { me, canAssign, local, repo:'here'|'other'|'none' } → [{ act, label, primary?, title?, off? }]
function caAcoes(t, x, fn){
  const out=[], live=['running','thinking','plan-review','queued'].includes(t.status);
  if(fn.delivered(t)) return [{ act:'entrega', label:'ver entrega', title:'abrir o que foi entregue (PR ou a página da tarefa)' }];
  if(caLivre(t, fn)){
    out.push({ act:'claim', label:'Assumir', primary:true, title:'pôr o seu nome no cartão — o time vê que é você; nada roda ainda' });
    if(x.canAssign) out.push({ act:'assign', label:'atribuir…', title:'escolher quem do time fica com o cartão' });
    return out;
  }
  if(x.me && t.assignee===x.me){
    if(t.status==='backlog'){
      if(x.repo==='here') out.push({ act:'start', label:'Iniciar', primary:true, title:'rodar nesta máquina — abre o terminal da tarefa' });
      else if(x.repo==='other') out.push({ act:'openproj', label:'abrir o projeto', primary:true, title:'a tarefa é de outro projeto deste computador — abrir ele pra iniciar' });
      else out.push({ act:'start', label:'Iniciar', primary:true, off:true, title:'o projeto desta tarefa não está neste computador — baixe a pasta e abra em Projetos' });
      out.push({ act:'release', label:'devolver', title:'tirar o seu nome — o cartão volta a ficar livre pro time' });
      return out;
    }
    if(entPronta(t, fn)) return [{ act:'review', label:'Revisar', primary:true, title:'revisar a entrega (provas, PR)' }];
    if(entTravada(t, fn)) return [{ act:'term', label:'ver o que houve', primary:true, title:'abrir a tarefa e destravar' }];
    if(live && x.local) return [{ act:'term', label:'abrir terminal', title:'abrir a tarefa rodando nesta máquina' }];
    return [{ act:'view', label:'abrir' }];
  }
  out.push({ act:'view', label:'ver', title:'abrir a página da tarefa' });
  if(x.canAssign && !live && !t.pr_url && !['review','delivered'].includes(t.status)) out.push({ act:'assign', label:'reatribuir…', title:'trocar quem está com o cartão (a pessoa é avisada)' });
  return out;
}
// linha do épico (aba Épicos): números sobre TODAS as tarefas do épico (entNums do 70) + as livres
function caEpicoLinha(ep, tasks, fn){
  const n=entNums(tasks, fn);
  return { ...n, livres:(tasks||[]).filter(t=>caLivre(t, fn)).length, projetos:[...new Set((tasks||[]).map(t=>t.project_id).filter(Boolean))] };
}
// @ca-puro-fim

const CA_FN=(typeof ENT_FN!=='undefined')?ENT_FN:{ bucket:t=>tsBucket(t), delivered:t=>epDelivered(t), flag:t=>tsNorm(t).flag, ativo:(e)=>e.status!=='done'&&e.status!=='archived' };
const CA={ last:null, open:{}, uid:'', errAt:0 };
const caMe=()=>(typeof cloudUserId==='function'?cloudUserId():'')||'';
const caRole=()=>(typeof cloudData!=='undefined'&&cloudData&&cloudData.meRole)||'member';
// só existe alcance com conta e time (sem nuvem a Central é a de sempre — tarefas locais)
function caOn(){ try{ return !!(SB.sess() && cloudTeamId() && typeof cloudData!=='undefined' && cloudData && (cloudData.teams||[]).length); }catch(_){ return false; } }
function caScope(){
  const s=caScopeOf(lsGet(userKey('ca:scope', caMe())), caRole());
  return s;
}
// o alcance da Central e o "meu time / toda a organização" do espaço Time são o MESMO dado (teamFetch): só troca se
// estiver diferente (trocar zera o teamTasks e busca de novo)
function caSyncTeamScope(s){ if(s!=='minhas' && typeof tmScope!=='undefined' && (s==='org')!==(tmScope==='org') && typeof tsSetScope==='function') tsSetScope(s==='org'?'org':'team'); }
function caTab(){ return caTabOf(lsGet(userKey('ca:tab', caMe()))); }
function caFiltros(){ return caFiltrosDe(lsGet(userKey('ca:f', caMe()))); }
function caSetF(p){ lsSet(userKey('ca:f', caMe()), JSON.stringify({ ...caFiltros(), ...p })); caRerender(); }
function caSetScope(s){
  s=caScopeOf(s, caRole()); lsSet(userKey('ca:scope', caMe()), s);
  caSyncTeamScope(s);
  caRerender();
}
function caSetTab(t){ lsSet(userKey('ca:tab', caMe()), caTabOf(t)); caRerender(); }
// o "meu time / toda a organização" do espaço Time mexe aqui também (Minhas fica como está)
function caFromTeamScope(s){ if(!caOn()) return; if(caScope()!=='minhas') lsSet(userKey('ca:scope', caMe()), s==='org'?'org':'time'); }
function caRerender(){ try{ lastSig=''; if(typeof renderFlow==='function') renderFlow(); }catch(e){ console.warn('central', e); } }
// a Central da vez é a nossa (alcance do time ou aba que não é Tarefas)?
function caOwns(){ return caOn() && (caScope()!=='minhas' || caTab()!=='tarefas'); }

// ---- dados: os do teamFetch (mesmo alcance do espaço Time). Mantém a última foto pra não piscar o esqueleto a cada ação.
function caEnsure(){
  if(!caOn()) return;
  if(CA.uid!==caMe()){ CA.uid=caMe(); CA.last=null; CA.err=null; CA.errAt=0; CA.open={}; } // outra conta: nada da anterior
  caSyncTeamScope(caScope());
  if(typeof teamTasks!=='undefined' && teamTasks && CA.tid===cloudTeamId()) CA.last={ tasks:teamTasks, at:teamFetchedAt };
  const stale=!teamTasks || Date.now()-(+teamFetchedAt||0)>20000 || CA.tid!==cloudTeamId();
  if(!stale || CA.busy || (CA.err && Date.now()-CA.errAt<30000)) return; // erro: tenta de novo em 30 s (ou no "tentar de novo")
  if(teamFetching){ if(typeof teamFetchP!=='undefined' && teamFetchP && !CA.waiting){ CA.waiting=true; teamFetchP.finally(()=>{ CA.waiting=false; caRerender(); }); } return; }
  const tid=cloudTeamId(); CA.busy=true;
  if(CA.tid!==tid){ teamTasks=null; CA.last=null; }
  teamFetch(!teamTasks).then(()=>{ CA.busy=false; CA.err=null; CA.tid=tid;
      if(cloudTeamId()!==tid){ teamTasks=null; CA.tid=''; } // trocou de time no meio: a resposta é do time velho
      else if(teamTasks) CA.last={ tasks:teamTasks, at:teamFetchedAt };
      caRerender(); },
    e=>{ CA.busy=false; CA.err=e; CA.errAt=Date.now(); caRerender(); });
}
// tarefas do alcance (Minhas usa os times em que EU estou; o resto, os times do teamFetch)
function caMyTeams(){
  const me=caMe(), tm=(cloudData&&cloudData.teamMembers)||{};
  const s=new Set(Object.keys(tm).filter(tid=>(tm[tid]||[]).some(m=>m.user_id===me)));
  if(cloudTeamId()) s.add(cloudTeamId());
  return s;
}
function caScopeTeams(scope){ return scope==='org'?new Set(((cloudData&&cloudData.teams)||[]).map(t=>t.id)):(scope==='minhas'?caMyTeams():new Set([cloudTeamId()])); }
function caSrc(){ return (CA.tid===cloudTeamId() && (teamTasks||(CA.last&&CA.last.tasks)))||null; }
function caTasks(scope){ return caDoEscopo(caSrc()||[], scope, { me:caMe(), myTeams:caMyTeams(), scopeTeams:caScopeTeams(scope) }, CA_FN); }
function caMembers(scope){
  const tm=(cloudData&&cloudData.teamMembers)||{}, ids=[...caScopeTeams(scope)];
  return [...new Set(ids.flatMap(tid=>(tm[tid]||[]).map(m=>m.user_id)).concat(caTasks(scope).map(t=>t.assignee).filter(Boolean)))];
}
function caEpics(scope){ const ok=caScopeTeams(scope); return ((typeof teamEpics!=='undefined'&&teamEpics)||[]).filter(e=>ok.has(e.team_id)); }
function caCanAssign(teamId){ const tm=((cloudData&&cloudData.teamMembers)||{})[teamId]||[]; return typeof tmCanAssign==='function' && tmCanAssign(caRole(), tm, caMe()); }
// o projeto do cartão neste computador: 'here' (é o aberto), 'other' (existe aqui, outro projeto), 'none'
function caRepo(t){
  const proj=teamProj[t.project_id]||{};
  if(!proj.repo_remote || (typeof remoteSame==='function' && remoteSame(proj.repo_remote, teamRepoIds||{ remote:teamRepoRemote }))) return 'here';
  const here=((typeof localRemoteList!=='undefined'&&localRemoteList)||[]).concat(teamRepoIds?[teamRepoIds]:[]);
  return (typeof ctProjLocal==='function' && ctProjLocal(proj, here))?'other':'none';
}
function caLocalOf(t){ const l=typeof tsLocalOf==='function'?tsLocalOf(t):null; if(l) return l; const m=typeof tmap==='function'?tmap():{}; const id=Object.keys(m).find(k=>m[k]===t.id); return id?(state.tasks||[]).find(x=>x.id===id)||null:null; }
function caInQueue(t){ return typeof epQueueMine==='function' && epQueueMine().some(r=>r.id===t.id); }

// ---- pedaços de HTML ----
function caWho(t){
  const me=caMe();
  if(!t.assignee) return `<span class="ca-who free"><span class="tsav tmfree" aria-hidden="true"></span><span class="ca-wn">livre</span></span>`;
  return `<span class="ca-who" title="${escA('com '+tmName(t.assignee))}">${tsAv(t.assignee, tsOnline(t.assignee))}<span class="ca-wn">${esc(personShort(t.assignee,{ noYou:true }))}</span>${t.assignee===me?'<span class="ca-you">você</span>':''}</span>`;
}
function caSt(t){
  const fn=CA_FN, blk=entFlag(t, fn)==='blocked', done=fn.delivered(t);
  const sk=blk?'blocked':(done?tsSt(t):(t.pr_url?'pr-open':tsSt(t)));
  let label=blk?stLabel('blocked'):ctStLabel(t);
  const run=['running','thinking'].includes(tsNorm(t).status);
  if(run && t.assignee) label+=' por '+personShort(t.assignee);
  return `<span class="ca-st" style="--stc:${stColor(sk)}"><i aria-hidden="true"></i><span>${esc(label)}</span></span>`;
}
function caProjBadge(pid){ const p=teamProj[pid]||{}; const n=p.name||'projeto'; return `<span class="ca-proj"><i style="background:${projColor('cloud:'+(p.repo_remote||n))}" aria-hidden="true"></i>${esc(n)}</span>`; }
function caBtns(t){
  const acts=caAcoes(t, { me:caMe(), canAssign:caCanAssign(t.team_id), local:!!caLocalOf(t), repo:caRepo(t) }, CA_FN);
  const b=acts.map(a=>`<button type="button" class="btn sm${a.primary?' primary':' ghost'}" data-caact="${a.act}" data-ct="${escA(t.id)}"${a.off?' disabled':''}${a.title?` title="${escA(a.title)}"`:''}>${esc(a.label)}</button>`).join('');
  return `<span class="ca-acts">${b}<button type="button" class="btn sm ghost ca-more" data-camenu="${escA(t.id)}" aria-haspopup="menu" aria-label="mais ações" title="mais ações">${(typeof IC!=='undefined'&&IC.more)||''}</button></span>`;
}
function caIssue(t){
  const h=(typeof tsIssueChip==='function')?tsIssueChip(t, teamProj[t.project_id]||{}):'';
  if(!h) return '<span class="ca-dim">—</span>';
  return h.replace(/data-lk=/g,'data-calk=').replace(/data-act="issue"/g,`data-caact="issue" data-ct="${escA(t.id)}"`);
}
// cabeçalho ORDENÁVEL (08-periodo: sortGet/sortToggle — padrão = modificação mais recente; a coluna clicada vale só com
// a Central aberta). screen = 'central:tarefas' | 'central:epicos'
function caTh(screen, col, label, cls){
  const s=sortGet(screen), on=s.col===col, ar=on?(s.dir==='asc'?'ascending':'descending'):'none';
  return `<th scope="col" class="${cls}" aria-sort="${ar}"><button type="button" class="ca-sort${on?' on':''}${on&&s.dir==='asc'?' asc':''}" data-casort="${escA(screen+'|'+col)}" title="${escA(col==='mod'?'ordenar pela modificação mais recente':'ordenar por '+label.toLowerCase())}">${esc(label)}<span class="ca-sar" aria-hidden="true">${(typeof IC!=='undefined'&&IC.chevD)||''}</span></button></th>`;
}
// "atualizado há X" embaixo da situação/andamento: só aparece quando a coluna Atualizado some (tela estreita — CSS 99-gestao)
function caModSub(md){ return md?`<span class="ca-mod">atualizado ${esc(modAgoTx(md))}</span>`:''; }
// valor de cada coluna pra ordenar (texto em pt-BR, número quando é número)
function caSortVal(t, col){
  switch(col){
    case 'dem': return String(t.title||'').toLowerCase();
    case 'com': return t.assignee?personName(t.assignee,{ noYou:true }).toLowerCase():'\uffff'; // livre por último no A→Z
    case 'st': return entFlag(t, CA_FN)==='blocked'?stLabel('blocked'):ctStLabel(t);
    case 'req': { const r=entReqs(t); return r?r.ok/r.tot:-1; }
    default: return caModOf(t);
  }
}
// tabela de tarefas (um grupo). o = { cost, sub:'epic' (mostra o épico embaixo do título), team (mostra o time) }
function caTableHtml(list, o){
  o=o||{};
  if(!list.length) return `<div class="ca-none">nada aqui com esse filtro</div>`;
  const SC='central:tarefas';
  list=sortRows(list, caModOf, sortGet(SC), caSortVal);
  const rq=t=>{ const r=entReqs(t); return r?`<span class="ca-num${r.ok===r.tot?' ok':''}">${r.ok}/${r.tot}</span>`:'<span class="ca-dim">—</span>'; };
  const sub=t=>{ const bits=[caProjBadge(t.project_id)];
    if(o.sub==='epic' && t.epic_id){ const e=((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(x=>x.id===t.epic_id); if(e) bits.push(`<span class="ca-epn">${(typeof IC!=='undefined'&&IC.epic)||''}${esc(e.name)}</span>`); }
    if(o.team) bits.push(`<span class="ca-dim">${esc(tsTeamName(t.team_id))}</span>`);
    { const m=entTravaTx(t); if(m) bits.push(`<span class="ca-why" title="${escA('travada: '+m)}">${(typeof IC!=='undefined'&&IC.warn)||''}<span>${esc(m)}</span></span>`); } // motivo da trava (70, fonte única)
    return bits.join('<span class="ca-sep" aria-hidden="true">·</span>'); };
  return `<table class="ca-tbl"><thead><tr>${caTh(SC,'dem','Demanda','c-dem')}${caTh(SC,'com','Com','c-com')}${caTh(SC,'st','Situação','c-st')}${caTh(SC,'req','Requisitos','c-req')}<th scope="col" class="c-iss">Issue</th>${o.cost?'<th scope="col" class="c-cus">Custo</th>':''}${caTh(SC,'mod','Atualizado','c-atv')}<th scope="col" class="c-act"><span class="sr-only">ações</span></th></tr></thead><tbody>`+
    list.map(t=>`<tr data-carow="${escA(t.id)}"${entTravada(t, CA_FN)?' class="trav"':''}><td class="c-dem"><button type="button" class="ca-title" data-caopen="${escA(t.id)}" title="${escA('abrir “'+(t.title||'')+'”')}">${esc(t.title||'tarefa')}</button><div class="ca-sub">${sub(t)}</div></td>`+
      `<td class="c-com">${caWho(t)}</td><td class="c-st">${caSt(t)}${caModSub(caModOf(t))}</td><td class="c-req">${rq(t)}</td><td class="c-iss">${caIssue(t)}</td>`+
      (o.cost?`<td class="c-cus">${+t.cost_usd>0?esc(fmtUsd(+t.cost_usd)):'<span class="ca-dim">—</span>'}</td>`:'')+
      `<td class="c-atv">${(()=>{ const md=caModOf(t); return md?`<time datetime="${escA(new Date(md).toISOString())}" title="${escA(new Date(md).toLocaleString('pt-BR'))}">${esc(modAgoTx(md))}</time>`:'<span class="ca-dim">—</span>'; })()}</td><td class="c-act">${caBtns(t)}</td></tr>`).join('')+`</tbody></table>`;
}
function caAvs(uids, livre){
  const v=uids.slice(0,5);
  return `<span class="ca-faces" role="img" aria-label="${escA(uids.length?'pessoas: '+uids.map(tmName).join(', '):'ninguém ainda')}">${v.map(u=>tsAv(u, false)).join('')}${uids.length>5?`<span class="ca-more-n">+${uids.length-5}</span>`:''}${livre?'<span class="tsav tmfree" title="tem tarefa livre"></span>':''}</span>`;
}
function caBar(ok, tot){ const p=tot?Math.round(ok/tot*100):0; return `<span class="ca-bar" role="img" aria-label="${escA(ok+' de '+tot+' entregues')}"><i style="width:${p}%"></i></span>`; }
// Do time / Org toda › Tarefas: grupos por épico (entAgrupa do 70)
function caTarefasHtml(scope){
  const all=caTasks(scope), me=caMe();
  const f=caFiltrosValidos(caFiltros(), all.map(t=>t.project_id), caMembers(scope));
  const vis=caFiltra(all, f, me, CA_FN);
  if(!all.length) return emptyHtml({ icon:'kanban', title:'O time ainda não tem tarefas', help:'Quando alguém mandar uma demanda pro time, ela aparece aqui com quem está com ela.', action:{ id:'caNova', label:'Nova demanda' } });
  if(!vis.length) return emptyHtml({ icon:'search', title:'Nada aqui com esse filtro', help:'Nenhuma tarefa do alcance bate com o filtro, o projeto ou a pessoa escolhida.', action:{ id:'caClear', label:'limpar filtros', primary:false } });
  const cost=entPodeVerCusto(), org=scope==='org';
  // grupos também pela modificação: o épico com a tarefa mexida por último sobe (ativos antes dos concluídos)
  const gs=entAgrupa(all, vis, caEpics(scope), CA_FN).map(g=>({ g, md:modTs(g.itens.map(caModOf)) }))
    .sort((a,b)=>((a.g.id==='-')-(b.g.id==='-')) || (b.g.ativo-a.g.ativo) || (b.md-a.md)).map(x=>x.g); // "Sem épico" sempre no fim (entAgrupa)
  return gs.map(g=>{
    const k=g.id, open=CA.open[k]!=null?CA.open[k]:(lsGet(userKey('ca:ep:'+k, caMe()))!=null?lsGet(userKey('ca:ep:'+k, caMe()))==='1':g.ativo);
    const projs=[...new Set(g.tasks.concat(g.itens).map(t=>t.project_id).filter(Boolean))];
    const head=g.ep
      ? `<div class="ca-eph"><button type="button" class="ca-tog" data-catog="${escA(k)}" aria-expanded="${open}" title="${open?'recolher':'mostrar'} as tarefas deste épico"><span class="ca-chev" aria-hidden="true">${open?IC.chevD:IC.chevR}</span><span class="ca-epic" style="color:${epColor(k)}">${IC.epic}</span><span class="ca-epname">${esc(g.nome)}</span></button>`+
        `<span class="ca-epm">${projs.map(caProjBadge).join('')}<span class="ca-dim">time ${esc(tsTeamName(g.ep.team_id)||'')}</span><span class="ca-num"><b>${g.ent}</b>/${g.tot} entregues</span>${caBar(g.ent, g.tot)}${caAvs(g.pessoas, g.tasks.some(t=>caLivre(t, CA_FN)))}</span>`+
        `<span class="grow"></span><button type="button" class="btn sm" data-caep="${escA(k)}">abrir épico</button></div>`
      : `<div class="ca-eph solto"><button type="button" class="ca-tog" data-catog="${escA(k)}" aria-expanded="${open}"><span class="ca-chev" aria-hidden="true">${open?IC.chevD:IC.chevR}</span><span class="ca-epname">Sem épico</span></button><span class="ca-epm"><span class="ca-dim">${nPl(g.itens.length,'tarefa','tarefas')}</span></span></div>`;
    return `<section class="ca-grp" aria-label="${escA(g.nome)}">${head}${open?caTableHtml(g.itens, { cost, team:org }):''}</section>`;
  }).join('');
}
// Do time / Org toda › Tarefas em QUADRO (72-kanban): o mesmo alcance e os mesmos chips/projeto/pessoa da lista
function caQuadroHtml(scope, got){
  const all=caTasks(scope), me=caMe();
  const f=caFiltrosValidos(caFiltros(), all.map(t=>t.project_id), caMembers(scope));
  const vis=caFiltra(all, f, me, CA_FN);
  if(!all.length) return emptyHtml({ icon:'kanban', title:'O time ainda não tem tarefas', help:'Quando alguém mandar uma demanda pro time, ela aparece aqui com quem está com ela.', action:{ id:'caNova', label:'Nova demanda' } });
  if(!vis.length) return emptyHtml({ icon:'search', title:'Nada aqui com esse filtro', help:'Nenhuma tarefa do alcance bate com o filtro, o projeto ou a pessoa escolhida.', action:{ id:'caClear', label:'limpar filtros', primary:false } });
  if(typeof entProvasLoad==='function') entProvasLoad(((typeof teamTasks!=='undefined'&&teamTasks)||all).map(t=>t.id)); // provas: um lote pelo conjunto (o mesmo da aba Entregas)
  const kb=kbCentralTeamHtml(vis, scope); got(kb.vms);
  return kb.html;
}
function caEpicosHtml(scope){
  if(scope==='minhas') scope='time'; // os épicos são do time (Minhas não tem épico "meu")
  const eps=caEpics(scope), all=caTasks(scope), org=scope==='org';
  if(!eps.length) return emptyHtml({ icon:'epic', title:'Nenhum épico ainda', help:'Um épico junta várias tarefas de uma entrega maior. Crie um pela Nova demanda ou pelo Time.' });
  const fn=CA_FN, SC='central:epicos';
  const base=eps.map(e=>({ e, ts:all.filter(t=>t.epic_id===e.id) })).map(x=>({ ...x, n:caEpicoLinha(x.e, x.ts, fn), ativo:fn.ativo(x.e, x.ts), md:caEpModOf(x.e, x.ts) }));
  // ordem: modificação mais recente (o épico ou a tarefa dele mexida por último); coluna clicada vale com a tela aberta
  const val=(r, c)=>c==='dem'?String(r.e.name||'').toLowerCase():c==='and'?(r.n.tot?r.n.ent/r.n.tot:-1):c==='rev'?r.n.prontas:c==='trv'?r.n.travadas:c==='liv'?r.n.livres:r.md;
  const so=sortGet(SC), rows=sortRows(base, r=>r.md, so, val);
  if(so.col==='mod') rows.sort((a,b)=>b.ativo-a.ativo); // padrão: ativos antes dos concluídos (como os grupos de Tarefas), cada parte por modificação (sort estável)
  // a 1ª travada do épico com o motivo (fonte única 70) — o gestor vê O QUE trava sem abrir
  const trv=ts=>{ const t=sortRows(ts.filter(x=>entTravada(x, fn)), caModOf)[0]; if(!t) return ''; const m=entTravaTx(t);
    return `<span class="ca-why" title="${escA('“'+(t.title||'')+'” — '+m)}">${(typeof IC!=='undefined'&&IC.warn)||''}<span>${esc(mdTitle(t.title||'tarefa'))}: ${esc(m)}</span></span>`; };
  return `<table class="ca-tbl ca-eps"><thead><tr>${caTh(SC,'dem','Épico','c-dem')}<th scope="col" class="c-pj">Projeto · time</th>${caTh(SC,'and','Andamento','c-and')}<th scope="col" class="c-ppl">Pessoas</th>${caTh(SC,'rev','Pra revisar','c-n')}${caTh(SC,'trv','Travadas','c-n')}${caTh(SC,'liv','Livres','c-n c-liv')}${caTh(SC,'mod','Atualizado','c-atv')}<th scope="col" class="c-act"><span class="sr-only">abrir</span></th></tr></thead><tbody>`+
    rows.map(({ e, n, ativo, ts, md })=>`<tr${ativo?'':' class="fechado"'}><td class="c-dem"><button type="button" class="ca-title" data-caep="${escA(e.id)}"><span class="ca-epic" style="color:${epColor(e.id)}">${IC.epic}</span>${esc(e.name||'Épico')}</button>${(()=>{ const b=[]; if(!ativo) b.push('<span class="ca-dim">concluído</span>'); const w=trv(ts); if(w) b.push(w); return b.length?`<div class="ca-sub">${b.join('<span class="ca-sep" aria-hidden="true">·</span>')}</div>`:''; })()}</td>`+
      `<td class="c-pj">${n.projetos.length?n.projetos.map(caProjBadge).join(''):'<span class="ca-dim">sem tarefa</span>'}<div class="ca-sub"><span class="ca-dim">time ${esc(tsTeamName(e.team_id)||'')}</span></div></td>`+
      `<td class="c-and"><span class="ca-num"><b>${n.ent}</b>/${n.tot}</span>${caBar(n.ent, n.tot)}${caModSub(md)}</td><td class="c-ppl">${caAvs(n.pessoas, false)}</td>`+
      `<td class="c-n"><span class="ca-num"${n.prontas?` style="color:${stColor('review')}"`:''}>${n.prontas}</span></td><td class="c-n"><span class="ca-num${n.travadas?' crit':''}">${n.travadas}</span></td><td class="c-n c-liv"><span class="ca-num">${n.livres}</span></td>`+
      `<td class="c-atv">${md?`<time datetime="${escA(new Date(md).toISOString())}" title="${escA(new Date(md).toLocaleString('pt-BR'))}">${esc(modAgoTx(md))}</time>`:'<span class="ca-dim">—</span>'}</td>`+
      `<td class="c-act"><button type="button" class="btn sm" data-caep="${escA(e.id)}">abrir</button></td></tr>`).join('')+
    `</tbody></table><p class="ca-foot">${org?'Épicos de todos os times da organização.':'Épicos do time '+esc(tsTeamName(cloudTeamId())||'')+'.'+(caIsAdmin(caRole())?' “Org toda” mostra os outros times.':'')}</p>`;
}
// Minhas › Tarefas: as duas seções do time no fim da Central de sempre
function caMinhasHtml(scopeFlow){
  if(scopeFlow==='done' || !caOn() || caScope()!=='minhas' || caTab()!=='tarefas') return '';
  caEnsure();
  const src=caSrc();
  if(!src) return CA.err?`<div class="ca-sec ca-errline" role="status">${IC.warn||''}<span>Não consegui ler as tarefas do time agora — tento de novo em instantes.</span><button type="button" class="btn sm ghost" data-caact="retry">tentar de novo</button></div>`:'';
  // a busca e o épico da Central valem aqui também (como no "Com o time")
  const q=String((typeof flowQuery!=='undefined'&&flowQuery)||'').trim().toLowerCase(), fe=(typeof flowEpic!=='undefined')?flowEpic:'all';
  const m=caMinhas(src, caMe(), caMyTeams(), CA_FN, t=>!!caLocalOf(t), caInQueue);
  const qf=l=>l.filter(t=>(!q||String(t.title||'').toLowerCase().includes(q)) && (fe==='all'||t.epic_id===fe));
  const comigo=qf(m.comigo), livres=qf(m.livres), cost=entPodeVerCusto();
  const sec=(k, title, help, list)=>{ if(!list.length) return ''; const col=flowSecCollapsed(k, false);
    return `<div class="secgrp ca-sec${col?' collapsed':''}" data-sec="${k}">${flowSecHead(k, title, list.length, '', col, IC.users||'')}${col?'':`<div class="ca-help">${esc(help)}</div>`+caTableHtml(list, { cost, sub:'epic' })}</div>`; };
  return sec('cacomigo','Com você no time','no seu nome e ainda não roda neste computador — inicie aqui ou devolva pro time', comigo)+
    sec('calivres','Livres no seu time','ninguém assumiu ainda · assumir põe o seu nome pra todo o time e avisa quem criou', livres);
}
window.caMinhasHtml=caMinhasHtml;
// o "Com o time" (46) só esconde uma livre quando ela de fato aparece em "Livres no seu time" (dado carregado, do meu time,
// fora da fila dos épicos) — senão ela sumiria das duas seções
function caFreeShown(t){ const src=caSrc(); if(!src || !t) return false; const x=src.find(y=>y.id===t.id); return !!x && caLivre(x, CA_FN) && caMyTeams().has(x.team_id) && !caInQueue(x); }
window.caFreeShown=caFreeShown;

// ---- cabeçalho: título + alcance + resumo + abas (22: renderFlowHead chama) ----
function caHead(o){
  if(!caOn()) return null;
  const scope=caScope(), tab=caTab(), me=caMe(), role=caRole();
  const seg=`<span class="ca-scope" role="radiogroup" aria-label="alcance da Central">${caScopesFor(role).map(([k,l])=>`<button type="button" role="radio" aria-checked="${scope===k}" tabindex="${scope===k?0:-1}" class="${scope===k?'on':''}" data-cascope="${k}" title="${escA(k==='minhas'?'o que está com você ou rodando neste computador, e as livres do seu time':k==='time'?'tudo do time escolhido, com quem está com cada item':'todos os times e projetos da organização (só admin)')}">${l}</button>`).join('')}</span>`;
  const teams=(cloudData.teams||[]);
  const teamSel=scope==='time' && teams.length>1 ? `<select class="sel ca-teamsel" id="caTeam" aria-label="time">${teams.map(t=>`<option value="${escA(t.id)}"${t.id===cloudTeamId()?' selected':''}>${esc(t.name)}</option>`).join('')}</select>` : '';
  const tasks=caTasks(scope==='minhas'?'time':scope);
  let sum=o&&o.sum||'';
  if(!(scope==='minhas' && tab==='tarefas') && caSrc()){
    const r=caResumo(scope==='minhas'?caTasks('minhas'):tasks, me, CA_FN);
    sum=`<b>${r.comigo}</b> com você · <b>${r.livres}</b> ${r.livres===1?'livre':'livres'} · <b>${r.revisar}</b> pra revisar · <b>${r.travadas}</b> ${r.travadas===1?'travada':'travadas'}`;
  }
  // Minhas: as abertas desta máquina (a mesma conta da aba "Em aberto") + as duas seções do time
  let nT;
  if(scope==='minhas'){ let src=[]; try{ src=boardSource(); }catch(_){ src=state.tasks||[]; }
    const src2=caSrc()||[], m=caMinhas(src2, me, caMyTeams(), CA_FN, t=>!!caLocalOf(t), caInQueue);
    nT=src.filter(t=>notHidden(t) && !taskEncerrada(t)).length+m.comigo.length+m.livres.length; }
  else nT=caFiltra(tasks, { chip:'todas' }, me, CA_FN).length;
  const nE=caEpics(scope==='minhas'?'time':scope).length;
  const nEnt=typeof entAbertas==='function'?entAbertas(scope==='minhas'?caTasks('minhas'):tasks):null;
  const tabs=pageTabs('central', [['tarefas','Tarefas',nT],['epicos','Épicos',caSrc()?nE:null],['entregas','Entregas',caSrc()?nEnt:null]], tab);
  const local=scope==='minhas' && tab==='tarefas'; // Minhas › Tarefas continua dizendo de qual computador/projeto é
  return pageHead({ title:'Central', sum, ...(local?{ scope:'computador', scopeLabel:o&&o.scopeLabel }:{}), right:'<span id="coordChip" class="coordchip"></span>', tabs }).replace('<span class="pgh-sp">', seg+teamSel+'<span class="pgh-sp">');
}
function caWireHead(el){
  if(el.__caw) return; el.__caw=true;
  el.addEventListener('click', e=>{
    const s=e.target.closest('[data-cascope]'); if(s){ caSetScope(s.dataset.cascope); return; }
    const t=e.target.closest('[data-pgtab^="central:"]'); if(t){ caSetTab(t.dataset.pgtab.split(':')[1]); }
  });
  el.addEventListener('keydown', e=>{ // setas trocam de aba/alcance (padrão de tablist/radiogroup)
    const b=e.target.closest('[data-pgtab^="central:"],[data-cascope]'); if(!b || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
    const sib=[...b.parentElement.querySelectorAll('button')], i=sib.indexOf(b), n=sib[(i+(e.key==='ArrowRight'?1:-1)+sib.length)%sib.length];
    if(n){ e.preventDefault(); n.click(); setTimeout(()=>{ const q=n.dataset.cascope?`[data-cascope="${n.dataset.cascope}"]`:`[data-pgtab="${n.dataset.pgtab}"]`; const x=el.querySelector(q); if(x) x.focus(); }, 0); }
  });
  el.addEventListener('change', e=>{ if(e.target.id!=='caTeam') return; const tid=e.target.value;
    lsSet('sb:team', tid); if(cloudData) cloudData.members=(cloudData.teamMembers||{})[tid]||[];
    teamTasks=null; CA.last=null; teamPaintSig=''; if(typeof ctSent!=='undefined') ctSent.sig=''; caRerender(); });
}
window.caHead=caHead; window.caWireHead=caWireHead;

// ---- filtros (22: renderFlowFilters chama; true = a barra é nossa) ----
function caFiltersOwn(el){
  if(!caOwns()){ return false; }
  const scope=caScope(), tab=caTab();
  let h='';
  if(tab==='tarefas'){
    const all=caTasks(scope), me=caMe(), f=caFiltrosValidos(caFiltros(), all.map(t=>t.project_id), caMembers(scope));
    const base=caFiltra(all, { proj:f.proj, who:f.who }, me, CA_FN);
    const n=k=>caFiltra(base, { chip:k }, me, CA_FN).length;
    const projs=[...new Set(all.map(t=>t.project_id).filter(Boolean))].map(id=>teamProj[id]).filter(Boolean).sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt-BR'));
    const ppl=caMembers(scope).sort((a,b)=>tmName(a).localeCompare(tmName(b),'pt-BR'));
    const opt=(v,l,s)=>`<option value="${escA(v)}"${s?' selected':''}>${esc(l)}</option>`;
    h=`<div class="ca-filters"><div class="ffchips" role="group" aria-label="mostrar">${CA_CHIPS.map(([k,l])=>`<button type="button" class="fchip${f.chip===k?' on':''}" aria-pressed="${f.chip===k}" data-cachip="${k}">${l}<span class="n">${n(k)}</span></button>`).join('')}</div><span class="grow"></span>`+
      `<select class="sel ffsel" id="caProj" aria-label="filtrar por projeto">${opt('','Todos os projetos',!f.proj)}${projs.map(p=>opt(p.id, p.name, f.proj===p.id)).join('')}</select>`+
      `<select class="sel ffsel" id="caWhoSel" aria-label="filtrar por pessoa">${opt('','Todas as pessoas',!f.who)}${ppl.map(u=>opt(u, personName(u,{ you:'suffix' }), f.who===u)).join('')}${opt('-','Sem dono',f.who==='-')}</select>`+
      `<button type="button" class="btn sm ghost ca-refresh" id="caRefresh" title="buscar de novo na nuvem" aria-label="atualizar">${(typeof IC!=='undefined'&&(IC.refresh||IC.retry))||'atualizar'}</button>${typeof kbToggleHtml==='function'?kbToggleHtml(true):''}</div>`;
  }
  if(el.__html===h && (el.firstChild || !h)) return true;
  el.__html=h; el.innerHTML=h;
  el.querySelectorAll('[data-cachip]').forEach(b=>b.onclick=()=>caSetF({ chip:b.dataset.cachip }));
  { const s=el.querySelector('#caProj'); if(s) s.onchange=()=>caSetF({ proj:s.value }); }
  { const s=el.querySelector('#caWhoSel'); if(s) s.onchange=()=>caSetF({ who:s.value }); }
  { const b=el.querySelector('#caRefresh'); if(b) b.onclick=()=>{ teamTasks=null; teamFetchedAt=0; caRerender(); }; }
  if(typeof kbToggleWire==='function') kbToggleWire(el);
  return true;
}
window.caFiltersOwn=caFiltersOwn;

// ---- corpo (22: renderFlow chama; true = a lista é nossa) ----
function caBodyOwn(el){
  if(!caOwns()) return false;
  if(typeof kbDragId!=='undefined' && kbDragId) return true; // arrastando um cartão do quadro: não reconstrói
  { const rs=$id('flowResumo'); if(rs) rs.hidden=true; el.hidden=false; el.classList.remove('gridview'); }
  caEnsure();
  const scope=caScope(), tab=caTab();
  let html, kbVms=null;
  const have=caSrc();
  if(!have && CA.err) html=(typeof errorHtml==='function')?errorHtml(CA.err, 'caRetry', 'Não consegui carregar as tarefas do time'):emptyHtml({ icon:'warn', title:'Não consegui carregar as tarefas do time', action:{ id:'caRetry', label:'tentar de novo' } });
  else if(!have) html=skeletonHtml('tabela', { cols:6, n:6, label:'buscando as tarefas do time' });
  else if(tab==='epicos') html=caEpicosHtml(scope);
  else if(tab==='entregas') html=`<div class="ca-ent">${entregasHtml({ all:scope==='minhas'?caTasks('minhas'):caTasks(scope), members:caMembers(scope), noTitle:true })}</div>`;
  else if(typeof kbCentralNow==='function' && kbCentralNow(true)) html=caQuadroHtml(scope, kb=>{ kbVms=kb; });
  else html=caTarefasHtml(scope);
  html=`<div class="ca-wrap" data-scope="${scope}">${html}</div>`;
  if(html===flowLastHtml && el.firstChild){ if(kbVms) kbWireCentral(el, kbVms); return true; }
  el.innerHTML=html; flowLastHtml=html; if(typeof CT!=='undefined') CT.last=null;
  if(kbVms) kbWireCentral(el, kbVms);
  if(tab==='entregas' && typeof entregasWire==='function') entregasWire(el, caRerender);
  bindClick('caClear', ()=>caSetF({ chip:'todas', proj:'', who:'' }));
  bindClick('caNova', ()=>{ if(window.openTab) window.openTab('nova'); });
  bindClick('caRetry', ()=>caAct('retry'));
  return true;
}
window.caBodyOwn=caBodyOwn;

// ---- ações das linhas (delegadas: valem na Central do time e nas seções da Minhas) ----
function caTaskById(id){ return (caSrc()||[]).find(t=>t.id===id); }
function caOpen(ct){ const l=caLocalOf(ct); if(l){ selected=l.id; if(typeof openOrEdit==='function') openOrEdit(l); else openWorkspace(l.id); return; } openCloudTaskPage(ct); }
async function caAct(act, ct, b){
  const done=()=>{ teamFetchedAt=0; caRerender(); };
  switch(act){
    case 'claim': await tsClaimOnly(ct, b); return done();
    case 'assign': await tsReassign(ct, b); return done();
    case 'release': await tsRelease(ct, b); return done();
    case 'start': await teamClaimStart(ct, b); return done();
    case 'openproj': if(typeof epOpenProjectOf==='function') await epOpenProjectOf(teamProj[ct.project_id]||{}); return;
    case 'review': case 'term': case 'view': return caOpen(ct);
    case 'entrega': if(ct.pr_url && /^https?:\/\//i.test(ct.pr_url)) openExternal(ct.pr_url); else openCloudTaskPage(ct); return;
    case 'retry': CA.err=null; CA.errAt=0; teamTasks=null; caRerender(); return;
    case 'issue': if(typeof trkCardRetry==='function'){ await trkCardRetry(ct, teamProj[ct.project_id]||{}, b); done(); } return;
  }
}
document.addEventListener('click', e=>{
  const t=e.target; if(!t.closest || !t.closest('.ca-wrap,.ca-sec')) return;
  const so=t.closest('[data-casort]'); if(so){ const k=String(so.dataset.casort), [sc, col]=k.split('|'), q=`[data-casort="${CSS.escape(k)}"]`, i=[...document.querySelectorAll(q)].indexOf(so);
    sortToggle(sc, col); caRerender(); const b=document.querySelectorAll(q)[Math.max(0, i)]; if(b) b.focus(); return; } // o foco fica no MESMO cabeçalho (teclado)
  const a=t.closest('[data-caact]'); if(a){ if(a.disabled) return; if(a.dataset.caact==='retry'){ caAct('retry'); return; } const ct=caTaskById(a.dataset.ct); if(ct) caAct(a.dataset.caact, ct, a).catch(err=>showErr(err, 'Não deu')); return; }
  const m=t.closest('[data-camenu]'); if(m){ const ct=caTaskById(m.dataset.camenu); if(!ct) return; const l=caLocalOf(ct); if(l) openTaskMenu(l.id, m); else if(typeof epqMenu==='function') epqMenu(ct, m); return; }
  const o=t.closest('[data-caopen]'); if(o){ const ct=caTaskById(o.dataset.caopen); if(ct) caOpen(ct); return; }
  const k=t.closest('[data-calk]'); if(k){ const u=k.dataset.calk||''; if(/^https?:\/\//i.test(u)) openExternal(u); return; }
  const g=t.closest('[data-catog]'); if(g){ const id=g.dataset.catog, op=g.getAttribute('aria-expanded')!=='true'; CA.open[id]=op; lsSet(userKey('ca:ep:'+id, caMe()), op?'1':'0'); caRerender(); return; }
  const ep=t.closest('[data-caep]'); if(ep){ if(typeof epOpenById==='function') epOpenById(ep.dataset.caep); }
});
