// Starfork — 66-central-tabela
// ===== CENTRAL EM TABELA (redesenho F1 — protótipo aprovado 04/10; mesa: estrutura da direção C + rota da direção B) =====
// Execução vira uma tabela densa e ORDENÁVEL (clique no cabeçalho), com o PERCURSO de etapas por linha (bolinha cheia =
// feita, anel = agora, tracejada = precisa de você), UMA ação clara por linha (Responder · Revisar · Ver PR · Iniciar ·
// Abrir) e a linha EXPANSÍVEL com a frase do portão ("12 de 14 requisitos com prova. Faltam 2 pra liberar a entrega.") e
// os atalhos (Abrir tarefa ↵ · Revisar PR #n · Pedir as N provas). Os cartões/grade/Kanban de antes continuam no
// seletor de vista (mesa: "com a alternância que já existe"). Fontes únicas: flowBucket/taskSt/stShort/stColor (22/00),
// taskStages/stagesSummary/cicloStripX (60-ciclo), reqRows/proofGate (27/21), railBadgeHtml/projColor (25/22).
// Sem polling novo: pinta no render da Central (que já compara o HTML antes de trocar o DOM); as provas carregam como
// nos cartões (loadReqProofs uma vez por tarefa).

// @ct-puro-inicio (puro: só esc/escA — testado em app/tests/redesign-f1.test.mjs)
const CT_COLS=[
  ['title','Demanda'], ['proj','Projeto'], ['ia','IA'], ['etapa','Etapa'], ['provas','Provas'], ['pr','PR'], ['situacao','Situação'], ['upd','Atualizado'],
];
const CT_SORTABLE=new Set(['title','proj','ia','etapa','provas','situacao','upd']);
// ordem: key ∈ CT_SORTABLE, dir 'asc'|'desc'. Empate → mais recente primeiro (estável).
function ctSort(rows, key, dir){
  const k=CT_SORTABLE.has(key)?key:'upd', d=dir==='asc'?1:-1;
  const val=(r)=>k==='title'?String(r.title||'').toLowerCase()
    :k==='proj'?String(r.proj||'').toLowerCase()
    :k==='ia'?String(r.ia||'').toLowerCase()
    :k==='etapa'?(r.n?r.pos/r.n:-1)
    :k==='provas'?(r.nreq?r.ok/r.nreq:-1)
    :k==='situacao'?-(+r.rank||0) // asc = quem precisa de você primeiro
    :(+r.ts||0);
  return (rows||[]).map((r,i)=>({ r, i })).sort((a,b)=>{
    const x=val(a.r), y=val(b.r);
    const c=typeof x==='string'?x.localeCompare(y,'pt-BR'):(x-y);
    return c*d || (+b.r.ts||0)-(+a.r.ts||0) || a.i-b.i;
  }).map(x=>x.r);
}
// próximo estado ao clicar num cabeçalho: mesma coluna inverte; coluna nova começa no sentido "natural" dela
function ctNextSort(cur, key){
  if(!CT_SORTABLE.has(key)) return cur;
  if(cur && cur.key===key) return { key, dir:cur.dir==='asc'?'desc':'asc' };
  return { key, dir:['title','proj','ia','situacao'].includes(key)?'asc':'desc' };
}
// percurso de etapas (direção B, sem o "main"): uma bolinha por etapa; stages = [{ label, state }]
function ctRouteHtml(stages, pos, n, label){
  if(!stages || !stages.length) return '<span class="ctroute none">—</span>';
  const cls={ feito:'f', agora:'a', precisa:'p', 'sua-vez':'p', espera:'e' };
  const dots=stages.map((s,i)=>`${i?'<i class="ctln" aria-hidden="true"></i>':''}<i class="ctdot ${cls[s.state]||'e'}" title="${escA(s.label+': '+(s.word||s.state))}"></i>`).join('');
  return `<span class="ctroute" role="img" aria-label="${escA('etapa '+pos+' de '+n+(label?': '+label:''))}"><span class="ctdots" aria-hidden="true">${dots}</span><span class="ctrl"><b>${esc(label||'')}</b> · ${pos} de ${n}</span></span>`;
}
// a ação da linha: o que a pessoa faz AGORA com esta demanda. → { label, act:'open'|'play'|'pr', primary }
function ctAction(r){
  if(r.blocked) return { label:'Ver motivo', act:'open', primary:false };
  if(r.status==='draft') return { label:'Iniciar', act:'play', primary:true };
  if(r.asking) return { label:'Responder', act:'open', primary:true };
  if(r.status==='plan-review') return { label:'Aprovar plano', act:'open', primary:true };
  if(r.status==='conflict') return { label:'Resolver', act:'open', primary:true };
  if(['error','aborted'].includes(r.status)) return { label:'Ver o que houve', act:'open', primary:true };
  if(r.status==='needs-you') return { label:'Decidir', act:'open', primary:true };
  if(r.bucket==='praberto' && r.prUrl) return { label:'Ver PR', act:'pr', primary:false };
  if(r.bucket==='prontas') return { label:'Revisar', act:'open', primary:true };
  return { label:'Abrir', act:'open', primary:false };
}
// a frase da linha aberta (direção A): responde "posso entregar?" em português. nreq = EXIGIDOS (adiado com motivo
// conta como resolvido — mesma régua do portão, proofMissingOf); gateSt 'override' = liberado sem prova, com motivo
function ctSentence(r){
  if(r.cross && r.nreq>0) return 'Provas no outro projeto — abra a tarefa pra ver.';
  if(r.nreq>0 && r.loaded){
    const miss=r.nreq-r.ok;
    let s=`<b>${r.ok} de ${r.nreq} exigidos com prova.</b>`;
    if(r.ad) s+=` ${r.ad===1?'1 adiado':r.ad+' adiados'} com motivo.`;
    s+=r.gateSt==='override'?' Liberado sem prova, com motivo.':miss>0?` Faltam ${miss} pra liberar a entrega.`:' Pode entregar.';
    return s;
  }
  if(r.nreq>0) return 'conferindo as provas…';
  if(r.ad) return `${r.ad===1?'1 requisito adiado':r.ad+' requisitos adiados'} com motivo — nenhum exigido.`;
  return esc(r.now||'Esta demanda não tem requisitos com prova.');
}
function ctActBtn(r, a, cls){
  const c=`btn sm${a.primary?' primary':''}${cls?' '+cls:''}`;
  if(a.act==='play') return `<button type="button" class="${c}" data-rowplay="${escA(r.id)}">${esc(a.label)}</button>`;
  if(a.act==='pr') return `<button type="button" class="${c}" data-lk="${escA(r.prUrl)}" title="abrir o PR no GitHub">${esc(a.label)}</button>`;
  return `<button type="button" class="${c}" data-dcopen="${escA(r.id)}">${esc(a.label)}</button>`;
}
function ctTheadHtml(sort){
  return CT_COLS.map(([k,l])=>{
    if(!CT_SORTABLE.has(k)) return `<th class="ct-${k}" scope="col">${esc(l)}</th>`;
    const on=sort.key===k; const ar=on?(sort.dir==='asc'?'ascending':'descending'):'none';
    return `<th class="ct-${k}" scope="col" aria-sort="${ar}"><button type="button" class="ctsort${on?' on':''}" data-ctsort="${k}" title="${escA('ordenar por '+l.toLowerCase())}">${esc(l)}<span class="ctar" aria-hidden="true">${on?(sort.dir==='asc'?'▲':'▼'):'↕'}</span></button></th>`;
  }).join('')+'<th class="ct-act" scope="col"><span class="sr-only">ação</span></th>';
}
// a linha: foco no <tr> (Enter abre), nome = título + situação; abrir/recolher é o botão ▸ (aria-expanded nele)
function ctRowHtml(r, op){
  const a=ctAction(r);
  const prov=r.cross&&r.nreq?'<span class="ctdim" title="as provas moram no outro projeto — abra a tarefa">—</span>'
    :r.nreq?`<b>${r.loaded?r.ok:'…'}</b>/${r.nreq}${r.ad?` <span class="ctad" title="${escA(r.ad===1?'1 adiado com motivo':r.ad+' adiados com motivo')}">+${r.ad} adiado${r.ad===1?'':'s'}</span>`:''}`
    :r.ad?`<span class="ctad">${r.ad} adiado${r.ad===1?'':'s'}</span>`:'<span class="ctdim">—</span>';
  return `<tr class="ctrow${op?' open':''}${r.needsYou?' needs':''}" data-ctrow="${escA(r.id)}" tabindex="0" aria-label="${escA(r.title+' — '+(r.stLabel||''))}" title="${escA(r.title)}">`+
    `<td class="ct-title"><div class="ctti"><button type="button" class="ctchev" data-cttog="${escA(r.id)}" aria-label="${escA('resumo de '+r.title)}" aria-expanded="${op}">${op?'▾':'▸'}</button><span class="ctt"><span class="cttx">${esc(r.title)}</span>${r.code?`<span class="ctcode mono">${esc(r.code)}</span>`:''}</span></div></td>`+
    `<td class="ct-proj">${r.badge||''}<span class="ctpn">${esc(r.proj||'')}</span></td>`+
    `<td class="ct-ia">${esc(r.ia||'—')}</td>`+
    `<td class="ct-etapa">${ctRouteHtml(r.stages, r.pos, r.n, r.label)}</td>`+
    `<td class="ct-provas">${prov}</td>`+
    `<td class="ct-pr">${r.pr?`<button type="button" class="ctlink" data-lk="${escA(r.prUrl)}" title="abrir o PR no GitHub">#${esc(r.pr)}</button>`:'<span class="ctdim">—</span>'}</td>`+
    `<td class="ct-situacao"><span class="ctst" style="--stc:${escA(r.stColor||'var(--muted)')}"><i aria-hidden="true"></i>${esc(r.stLabel||'')}</span></td>`+
    `<td class="ct-upd">${esc(r.ago||'')}</td>`+
    `<td class="ct-act"><span class="ctacts">${ctActBtn(r, a)}${ctMoreBtn(r)}</span></td></tr>`;
}
// ⋯ da linha: abre o MESMO menu dos cartões (22: openTaskMenu — concluir, marcar pronta, integrada, bloquear…).
// O ícone vem de IC (10-core); fora do app (teste) cai no texto.
function ctMoreBtn(r){
  const ic=(typeof IC!=='undefined'&&IC.more)||'⋯';
  return `<button type="button" class="btn sm ghost ctmore" data-tmenu="${escA(r.id)}" aria-haspopup="menu" aria-label="mais ações" title="mais ações — concluir, mudar status">${ic}</button>`;
}
function ctExpHtml(r){
  const acts=[`<button type="button" class="btn sm primary" data-dcopen="${escA(r.id)}">Abrir tarefa <span class="kbd" aria-hidden="true">↵</span></button>`];
  if(r.pr) acts.push(`<button type="button" class="btn sm" data-lk="${escA(r.prUrl)}">Revisar PR #${esc(r.pr)}</button>`);
  const miss=r.nreq-r.ok;
  if(typeof rqCanAsk==='function' ? rqCanAsk({ status:r.status, _cross:r.cross }) : ['review','delivered'].includes(r.status)) acts.push(`<button type="button" class="btn sm" data-rqopen="${escA(r.id)}">Pedir alteração</button>`); // 71: a mesma caixa da tarefa
  if(r.canAskProof && r.loaded && miss>0) acts.push(`<button type="button" class="btn sm" data-rowproof="${escA(r.id)}">Pedir ${miss===1?'a prova que falta':'as '+miss+' provas'}</button>`);
  const ring=r.nreq&&r.loaded&&!r.cross?`<span class="ctring" aria-hidden="true">${r.ok}</span>`:'';
  // F4: aviso do teto de custo (G3, 53-teto-protecao budgetNoticeHtml — já escapado lá) dentro da linha aberta
  return `<tr class="ctexp" data-ctexp="${escA(r.id)}"><td colspan="${CT_COLS.length+1}"><div class="ctexpb">${ring}<p class="ctsent">${ctSentence(r)}</p><span class="sp"></span>${acts.join('')}</div>${r.budget||''}</td></tr>`;
}
// o: { sort:{key,dir}, open:Set|[] ids abertas }
function ctTableHtml(rows, o){
  o=o||{}; const sort=o.sort||{ key:'upd', dir:'desc' };
  const isOpen=(id)=>o.open?(typeof o.open.has==='function'?o.open.has(id):o.open.includes(id)):false;
  const body=ctSort(rows, sort.key, sort.dir).map(r=>{ const op=isOpen(r.id); return ctRowHtml(r, op)+(op?ctExpHtml(r):''); }).join('');
  return `<div class="ctwrap"><table class="cttable" aria-label="demandas em execução"><thead><tr>${ctTheadHtml(sort)}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// @ct-puro-fim

// ---------------------------------------------------------------- estado + dados da linha
// rows: id → dados da última pintura (abrir/ordenar mexem NO LUGAR, sem refazer a Central); last: o que a Central
// pintou da última vez (pra devolver o HTML equivalente ao flowLastHtml e o próximo render não reconstruir à toa)
const CT={ open:new Set(), rows:new Map(), last:null, clickT:0, sort:(()=>{ try{ const v=JSON.parse(lsGet('ctSort')||'null'); if(v && CT_SORTABLE.has(v.key)) return v; }catch(_){ } return { key:'upd', dir:'desc' }; })() };
const CT_NEEDS_ST=new Set(typeof AGUARDA_ST!=='undefined'?AGUARDA_ST:['plan-review','needs-you','error','conflict','aborted']); // a MESMA lista do "aguardando você" (00-util) — antes faltava 'aborted'
function ctRow(t){
  // rascunho armado pelo "Iniciar épico" (46: epAutoLocalHas) = na espera — começa sozinho; "Iniciar" continua pra começar já
  const st=(t.status==='draft' && typeof epAutoLocalHas==='function' && epAutoLocalHas(t.id))?'waiting':taskSt(t), b=flowBucket(t);
  let stages=[], sum=null;
  if((t.roles||[]).length && typeof taskStages==='function' && typeof cicloStripX==='function'){ try{ const x=cicloStripX(t); stages=taskStages(t, x); sum=stagesSummary(stages, x); }catch(_){ stages=[]; } }
  const cross=!!t._cross; // tarefa de OUTRO projeto (agregada): as provas moram lá — estado final, nunca "carregando"
  const loaded=!cross && reqProofCache[t.id]!==undefined;
  if(!loaded && !cross && Array.isArray(t.requirements) && t.requirements.length) loadReqProofs(t.id).then(flowRerenderSoon).catch(()=>{});
  const rows=(typeof reqRows==='function')?reqRows(t):[];
  const g=(typeof proofGate==='function')?proofGate(t):{ st:'none', missing:[] };
  const ad=(typeof reqIsAdiado==='function')?rows.filter(reqIsAdiado).length:0;
  const nreq=rows.length-ad; // exigidos (régua do portão)
  const ok=loaded?Math.max(0, nreq-(g.missing||[]).length):0;
  const path=t.repo||state.repo||''; const proj=t.proj||pathBase(path);
  const ev=(typeof lastEventOf==='function')?lastEventOf(t.id):null;
  const ts=ev?+new Date(ev.ts):taskTs(t);
  const ia=(typeof aiRunLabel==='function')?String(aiRunLabel(t.engine, '')).replace(/ · padrão da assinatura$/,''):(t.engine||'');
  const asking=pendingOf(t.id).length>0;
  return { id:t.id, title:(typeof mdTitle==='function'?mdTitle(t.title||''):(t.title||'')), // só exibição
    code:(typeof issueCodeOf==='function'&&issueCodeOf(t))||'', proj, badge:(typeof railBadgeHtml==='function')?railBadgeHtml(proj, (typeof projColor==='function')?projColor(path):''):'',
    ia:t.orchestration?'Orquestrador':ia, stages:stages.map(s=>({ label:s.label, state:s.state, word:s.word })), pos:sum?sum.pos:0, n:stages.length, label:sum?sum.label:'', now:sum?sum.now:'',
    nreq, ok, ad, loaded, cross, gateSt:g.st, canAskProof:!cross && ['review','delivered'].includes(t.status) && g.st==='unproven' && !t.prUrl,
    pr:(typeof prNumOf==='function')?prNumOf(t):'', prUrl:t.prUrl||'', status:t.status, blocked:t.flag==='blocked', asking,
    needsYou:asking || CT_NEEDS_ST.has(t.status), // a barra de "precisa de você" — rascunho e "Revisar" não ganham
    budget:(typeof budgetNoticeHtml==='function' && !cross)?budgetNoticeHtml(t):'',
    bucket:b, st, stLabel:stShort(st), stColor:stColor(st), rank:(typeof railRank==='function')?(6-railRank(st)):0, ts, ago:(typeof agoShort==='function')?agoShort(ts):'' };
}
/** HTML da tabela pras tarefas visíveis (renderFlow chama na Execução quando a vista é "tabela"). */
function ctHtml(tasks){ const rows=(tasks||[]).map(ctRow); CT.rows=new Map(rows.map(r=>[r.id, r])); return ctTableHtml(rows, { sort:CT.sort, open:CT.open }); }
// depois de mexer NO LUGAR: o HTML que a Central pintaria agora (mesmas partes) vira o flowLastHtml — o próximo
// render só reconstrói se algo de verdade mudou
function ctSyncLast(){ const L=CT.last; if(!L) return; flowLastHtml=L.pre+ctTableHtml([...CT.rows.values()], { sort:CT.sort, open:CT.open })+(L.post||''); }
/** Depois do innerHTML da Central: ordenar, abrir/recolher a linha, teclado — tudo no lugar (sem renderFlow). Os botões
 *  de ação reaproveitam os data-* que a Central liga; linha recém-inserida cai na delegação daqui. */
function ctWire(el, src){
  const table=el.querySelector('.cttable'); if(!table) return;
  if(typeof budgetNoticeWire==='function') budgetNoticeWire(table); // aviso do teto nas linhas abertas
  const taskOf=(id)=>(src||[]).find(x=>x.id===id)||(state.tasks||[]).find(x=>x.id===id);
  const open=(id)=>{ const t=taskOf(id); if(!t) return;
    if(t._cross && t.repo && t.repo!==state.repo){ switchToProjectTask(t.repo, t.id); return; }
    const go=()=>{ selected=t.id; if(typeof openOrEdit==='function') openOrEdit(t); else openWorkspace(t.id); };
    // F3: aberto por clique, o título da linha voa até a aba (View Transition; sem ela, o voo WAAPI do renderTabs)
    if(typeof mvOpen==='function') mvOpen(table.querySelector(`tr[data-ctrow="${CSS.escape(id)}"] .cttx`), go); else go(); };
  const toggle=(id)=>{
    const tr=table.querySelector(`tr[data-ctrow="${CSS.escape(id)}"]`), r=CT.rows.get(id); if(!tr || !r) return;
    const op=!CT.open.has(id); if(op) CT.open.add(id); else CT.open.delete(id);
    const nx=tr.nextElementSibling; if(nx && nx.classList.contains('ctexp')) nx.remove();
    if(op){ tr.insertAdjacentHTML('afterend', ctExpHtml(r)); const ex=tr.nextElementSibling; if(ex && typeof budgetNoticeWire==='function') budgetNoticeWire(ex); if(ex && ex.classList.contains('ctexp') && typeof mvExpand==='function' && mvUser()) mvExpand(ex.querySelector('.ctexpb')); } // F3: a linha abre crescendo
    tr.classList.toggle('open', op);
    const ch=tr.querySelector('[data-cttog]'); if(ch){ ch.setAttribute('aria-expanded', String(op)); ch.textContent=op?'▾':'▸'; }
    ctSyncLast();
  };
  const sortBy=(k)=>{
    CT.sort=ctNextSort(CT.sort, k); lsSet('ctSort', JSON.stringify(CT.sort));
    const tb=table.tBodies[0]; const groups=new Map();
    tb.querySelectorAll('tr[data-ctrow]').forEach(tr=>{ const g=[tr]; const nx=tr.nextElementSibling; if(nx && nx.classList.contains('ctexp')) g.push(nx); groups.set(tr.dataset.ctrow, g); });
    // F3: as linhas reordenam com FLIP (cada uma desliza do lugar velho pro novo; reduzir movimento = corte)
    const reorder=()=>{ for(const r of ctSort([...CT.rows.values()], CT.sort.key, CT.sort.dir)){ const g=groups.get(r.id); if(g) g.forEach(x=>tb.appendChild(x)); } };
    if(typeof flip==='function') flip(tb, reorder, { sel:'tr' }); else reorder();
    table.querySelectorAll('th[aria-sort]').forEach(th=>{ const b=th.querySelector('[data-ctsort]'); const on=b && b.dataset.ctsort===CT.sort.key;
      th.setAttribute('aria-sort', on?(CT.sort.dir==='asc'?'ascending':'descending'):'none'); if(b){ b.classList.toggle('on', !!on); const a=b.querySelector('.ctar'); if(a) a.textContent=on?(CT.sort.dir==='asc'?'▲':'▼'):'↕'; } });
    ctSyncLast();
  };
  table.onclick=(e)=>{
    const s=e.target.closest('[data-ctsort]'); if(s){ e.stopPropagation(); sortBy(s.dataset.ctsort); return; }
    const c=e.target.closest('[data-cttog]'); if(c){ e.stopPropagation(); toggle(c.dataset.cttog); return; }
    // botões das linhas recém-inseridas (sem o onclick que a Central ligou no render): mesma ação
    const b=e.target.closest('[data-dcopen],[data-rowproof],[data-rowplay],[data-lk],[data-tmenu]');
    if(b){ e.stopPropagation();
      if(b.dataset.dcopen) open(b.dataset.dcopen);
      else if(b.dataset.rowplay){ const id=b.dataset.rowplay; crossRun(id, ()=>startTask(id)); } // L13 (mesa-bugs-2): "Iniciar" de outro projeto troca pro dono antes (antes agia no projeto ativo)
      else if(b.dataset.lk) openExternal(b.dataset.lk);
      else if(b.dataset.tmenu) openTaskMenu(b.dataset.tmenu, b); // ⋯ da linha: o menu único dos cartões (nunca abre a linha)
      else if(b.dataset.rowproof){ const id=b.dataset.rowproof; crossRun(id, ()=>proofAsk(taskOf(id), b)); }
      return; }
    const tr=e.target.closest('tr[data-ctrow]'); if(!tr || e.target.closest('button,a,input,select')) return;
    // clique simples abre/recolhe; duplo clique abre a tarefa (o clique espera um instante pra não piscar)
    clearTimeout(CT.clickT); const id=tr.dataset.ctrow; CT.clickT=setTimeout(()=>toggle(id), 220);
  };
  table.ondblclick=(e)=>{ const tr=e.target.closest('tr[data-ctrow]'); if(!tr || e.target.closest('button')) return; clearTimeout(CT.clickT); open(tr.dataset.ctrow); };
  table.onkeydown=(e)=>{ const tr=e.target.closest('tr[data-ctrow]'); if(!tr || e.target!==tr) return;
    if(e.key==='Enter'){ e.preventDefault(); open(tr.dataset.ctrow); }
    else if(e.key===' '){ e.preventDefault(); toggle(tr.dataset.ctrow); }
    else if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); const all=[...table.querySelectorAll('tr[data-ctrow]')]; const n=all[all.indexOf(tr)+(e.key==='ArrowDown'?1:-1)]; if(n) n.focus(); }
    else if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){ e.preventDefault(); openTaskMenu(tr.dataset.ctrow, tr); } };
  table.oncontextmenu=(e)=>{ const tr=e.target.closest('tr[data-ctrow]'); if(!tr) return; e.preventDefault(); openTaskMenu(tr.dataset.ctrow, e.target); };
}
