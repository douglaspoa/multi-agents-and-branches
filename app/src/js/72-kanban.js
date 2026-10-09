// Starfork — 72-kanban: UM quadro (kanban) pra todas as telas — pedido do dono em 09/10 ("a visão de kanban também
// precisamos ajustar pra ser bonita"). Antes eram três linguagens: o Kanban antigo da Central (colunas sem cabeçalho de
// página, cartão com crachá de agente), o Quadro do Time (cartão alto com barra de fases, borda colorida e 4 botões) e
// as Colunas do painel de Issues (cartão próprio, "—" na coluna vazia). Agora as três usam o MESMO componente:
//   kbBoardHtml(o)  → colunas (cabeçalho com ponto da situação + contador; vazio compacto; rolagem lateral só DENTRO)
//   kbCardHtml(vm)  → cartão compacto: título limpo · corrente em chips (issue · épico · PR) · quem está com ele (ou
//                     "livre") · requisitos x/y com barrinha · miniatura da prova (se já carregada) · trava · "há X"
//   kbWire(root, h) → abrir (clique/Enter), menu (⋯, botão direito, Shift+F10), ação do cartão e ARRASTAR — só pra
//                     coluna onde existe ação de verdade (kbLocalDrops/kbTeamDrops/kbIssueDrops); sem ação, sem arrasto
// Fontes únicas: situação = flowBucket/tsBucket (22/43) e STATUS_META; pessoa = personChip (08); corrente = chainOf/
// chainHtml (08); ordem = modTs (08, modificação mais recente primeiro); travada = entTravada/entMotivo (70);
// assumir/devolver/atribuir/iniciar = caAcoes/caAct (71 → tsClaimOnly/tsRelease/tsReassign/teamClaimStart do 43).
// Quadro da Central: botão ao lado da Lista, lembrado POR PESSOA (kb:central:<uid>); respeita alcance, chips e filtros.

// @puro-kanban-inicio (testado em app/tests/kanban.test.mjs)
// etapa da Central (flowBucket) → coluna do quadro: concluída hoje/antes = "Concluídas"
function kbColOf(bucket, map){ const b=(bucket==='hoje'||bucket==='anteriores')?'concluidas':String(bucket||''); return (map&&map[b])||b; }
// ordem DENTRO da coluna: modificação mais recente primeiro; empate → título (estável)
function kbSort(items){ return (items||[]).slice().sort((a,b)=>((b.ts||0)-(a.ts||0)) || String(a.title||'').localeCompare(String(b.title||''),'pt-BR')); }
// cols = [{ key, label, color, cap }] · items = [{ col, ts, … }] → colunas com os itens ordenados (item de coluna que
// não existe vai pra `fallback`, se houver; senão some — nunca cria coluna sozinho)
function kbGroup(items, cols, fallback){
  const keys=new Set((cols||[]).map(c=>c.key)), by={};
  (items||[]).forEach(it=>{ const k=keys.has(it.col)?it.col:(fallback&&keys.has(fallback)?fallback:null); if(k) (by[k]=by[k]||[]).push(it); });
  return (cols||[]).map(c=>{ const list=kbSort(by[c.key]||[]); return Object.assign({}, c, { items:list, n:list.length }); });
}
// ARRASTAR: só onde a ação já existe e é permitida. Cada regra devolve { coluna: ação } (vazio = cartão não arrasta).
// tarefa desta máquina: rascunho → Em andamento = iniciar (o mesmo ▶ do cartão; concluir/bloquear moram no menu ⋯)
function kbLocalDrops(t){ return (t && t.status==='draft')?{ andamento:'start' }:{}; }
// cartão do time (regras da 0032 = as do tsActsHtml/caAcoes): x = { me, canAssign, sameRepo, bucket }
//   Na fila → Em andamento = assumir e iniciar (livre ou já meu, aberto pra mim, projeto aberto aqui)
//   (x.st = status da tarefa local quando roda aqui — rodando aqui nunca devolve)
//   qualquer coluna → Na fila = devolver (agente parado, sem PR, não entregue; meu, ou de alguém e eu atribuo) — o
//   release_task da 0032 tira o responsável E volta o status pra backlog, então o cartão cai mesmo em "Na fila"
const KB_LIVE=['running','thinking','plan-review','queued'];
function kbTeamDrops(t, x){
  x=x||{}; const out={}; if(!t) return out;
  const canClaim=t.status==='backlog' && t.flag!=='closed' && (t.claim_mode==='open' || t.created_by===x.me) && (!t.assignee || t.assignee===x.me);
  if(canClaim && x.sameRepo && x.me) out.andamento='claimstart';
  const done=['review','delivered','merged','done','cancelled'].includes(t.status) || t.flag==='closed';
  const mine=!!x.me && t.assignee===x.me, other=!!t.assignee && !!x.canAssign;
  if(x.bucket!=='fila' && t.status!=='backlog' && !KB_LIVE.includes(t.status) && !KB_LIVE.includes(x.st||'') && !t.pr_url && !done && (mine || other)) out.fila='release';
  return out;
}
// issue do painel: o conector sabe mudar status (ops.updateStatus) → qualquer coluna de status conhecida, menos a atual
function kbIssueDrops(i, statusIds, canMove){ const out={}; if(!i || !canMove) return out; (statusIds||[]).forEach(s=>{ if(s && s!==i.status && s!=='__other') out[s]='move'; }); return out; }
function kbE(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// vm = { id, title, sel, chain (html), who (html | null → "livre"), freeLabel, reqs:{ok,tot}|null, thumb:url|null, proofs:n,
//        tag (time, na visão da org), trav:'motivo'|'', travTip, ago:'há 3 min', agoTip, drops:{col:ação}, acts:[{act,label,primary,title,off}], menu,
//        attrs:' data-…' (extra do quadro dono, ex.: data-trkcode do painel), cls }
// ic = { warn, more, camera } (SVG do IC — o teste passa vazio)
function kbCardHtml(vm, ic){
  ic=ic||{}; const E=kbE, drag=!!(vm.drops && Object.keys(vm.drops).length);
  const who=vm.who || `<span class="pchip kb-free" title="ninguém está com este cartão ainda"><span class="tsav tmfree" aria-hidden="true"></span><span class="pnm">${E(vm.freeLabel||'livre')}</span></span>`;
  const rq=vm.reqs && vm.reqs.tot ? (()=>{ const p=Math.round(vm.reqs.ok/vm.reqs.tot*100);
    return `<span class="kb-req${vm.reqs.ok===vm.reqs.tot?' ok':''}" title="${E(vm.reqs.ok+' de '+vm.reqs.tot+' requisitos provados')}"><span class="kb-bar" aria-hidden="true"><i style="width:${p}%"></i></span><span class="kb-rn">${vm.reqs.ok}/${vm.reqs.tot}</span><span class="sr-only"> requisitos provados</span></span>`; })() : '';
  const shot=vm.thumb ? `<span class="kb-thumb" title="${E(vm.proofs>1?vm.proofs+' provas':'prova')}"><img src="${E(vm.thumb)}" alt="" loading="lazy">${vm.proofs>1?`<b>${vm.proofs}</b>`:''}</span>`
    : (vm.proofs ? `<span class="kb-proofs" title="provas publicadas">${ic.camera||''}${vm.proofs}<span class="sr-only"> ${vm.proofs===1?'prova':'provas'}</span></span>` : '');
  const mid=(rq||shot)?`<div class="kb-mid">${rq}<span class="kb-sp"></span>${shot}</div>`:'';
  const acts=(vm.acts||[]).map(a=>`<button type="button" class="btn sm${a.primary?' primary':' ghost'} kb-act" data-kbact="${E(a.act)}"${a.off?' disabled':''}${a.title?` title="${E(a.title)}"`:''}>${E(a.label)}</button>`).join('');
  const menu=vm.menu?`<button type="button" class="kb-menu" data-kbmenu aria-haspopup="menu" aria-label="mais ações" title="mais ações">${ic.more||'…'}</button>`:'';
  return `<article class="kb-card${vm.trav?' trav':''}${vm.sel?' sel':''}${vm.cls?' '+vm.cls:''}" data-kbid="${E(vm.id)}" tabindex="0" aria-label="${E('abrir: '+(vm.title||'sem título'))}"${drag?` draggable="true" data-kbdrops="${E(Object.keys(vm.drops).join(' '))}"`:''}${vm.attrs||''}>`+
    `<div class="kb-ct">${E(vm.title||'sem título')}${vm.tag?` <span class="kb-tag" title="time">${E(vm.tag)}</span>`:''}</div>`+
    (vm.chain?`<div class="kb-chain chain">${vm.chain}</div>`:'')+mid+
    (vm.trav?`<div class="kb-trav" title="${E(vm.travTip||vm.trav)}">${ic.warn||''}<span>${E(vm.trav)}</span></div>`:'')+
    (acts?`<div class="kb-acts">${acts}</div>`:'')+
    `<div class="kb-ft">${who}<span class="kb-sp"></span>${vm.ago?`<span class="kb-ago" title="${E(vm.agoTip||'última modificação')}">${E(vm.ago)}</span>`:''}${menu}</div></article>`;
}
// o = { id, cols (de kbGroup), card(vm)→html, body(col)→html (troca o corpo — painel de Issues), empty(col)→html,
//       more(col, shown)→html (rodapé quando a coluna corta), label (aria) }
function kbBoardHtml(o){
  const E=kbE;
  return `<div class="kb-board" data-kb="${E(o.id||'')}" role="region" aria-label="${E(o.label||'quadro')}" style="--kb-n:${(o.cols||[]).length}">`+(o.cols||[]).map(c=>{
    const shown=c.cap?c.items.slice(0,c.cap):c.items;
    const body=o.body?o.body(c, shown):shown.map(it=>o.card(it)).join('');
    return `<section class="kb-col${c.n?'':' vazia'}" data-kbcol="${E(c.key)}"${c.attrs||''} aria-label="${E(c.label+', '+c.n)}">`+
      `<header class="kb-colh"${c.tip?` title="${E(c.tip)}"`:''}><i style="background:${E(c.color||'var(--muted)')}" aria-hidden="true"></i><span class="kb-cl">${E(c.label)}</span><span class="kb-n">${c.n}</span></header>`+
      `<div class="kb-colb">${body||(o.empty?o.empty(c):`<div class="kb-empty">nada aqui</div>`)}${(o.more&&c.n>shown.length)?o.more(c, shown):''}</div></section>`;
  }).join('')+`</div>`;
}
// @puro-kanban-fim

// ---------------------------------------------------------------------------------------------------------------------
// colunas (rótulos e cores da Central: FLOW_SECS/FLOW_SEC_COLOR — STATUS_META por baixo)
function kbSecLabel(k){ const s=(typeof FLOW_SECS!=='undefined'?FLOW_SECS:[]).find(x=>x[0]===k); return s?s[1]:k; }
function kbCol(k, o){ o=o||{}; return { key:k, label:o.label||(k==='concluidas'?'Concluídas':kbSecLabel(k)), color:k==='concluidas'?stColor('done'):((typeof FLOW_SEC_COLOR!=='undefined'&&FLOW_SEC_COLOR[k])||'var(--muted)'),
  tip:(typeof FLOW_SEC_TIP!=='undefined'&&FLOW_SEC_TIP[k])||'', cap:o.cap||0 }; }
const KB_EMPTY={ rascunho:'Nenhum rascunho', fila:'Fila vazia', aguardando:'Nada esperando', andamento:'Nada rodando agora', prontas:'Nada pra revisar', praberto:'Nenhum PR aberto', concluidas:'Nada concluído ainda' };
function kbEmpty(c){ return `<div class="kb-empty">${emptyHtml({ icon:c.key==='concluidas'?'checkc':'kanban', title:KB_EMPTY[c.key]||'Nada aqui' })}</div>`; }
function kbMore(c, shown){ return `<div class="kb-more" title="${escA('mostrando as '+shown.length+' modificadas por último')}">+${c.n-shown.length} ${c.key==='concluidas'?'concluídas antes':'mais'}</div>`; }
const KB_IC=()=>({ warn:(typeof IC!=='undefined'&&IC.warn)||'', more:(typeof IC!=='undefined'&&IC.more)||'', camera:(typeof IC!=='undefined'&&IC.camera)||'' });

// ---- pessoa e "há X" ----
function kbWho(uid, o){ if(!uid) return null; o=o||{}; return personChip(uid, { short:true, on:typeof tsOnline==='function'&&tsOnline(uid) }); }
function kbAgo(ms){ return ms?{ ago:modAgoTx(ms), tip:'modificada em '+new Date(ms).toLocaleString('pt-BR',{ day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) }:{ ago:'', tip:'' }; }

// ---- tarefa desta máquina (state.tasks / boardSource) ----
function kbLocalTs(t){ const ev=typeof lastEventOf==='function'?lastEventOf(t.id):null; return modTs(taskTs(t), t.finishedAt, t.updatedAt, t.updated_at, ev&&ev.ts); }
function kbLocalReqs(t){
  const reqs=Array.isArray(t.requirements)?t.requirements.filter(Boolean):[]; if(!reqs.length) return null;
  const c=typeof reqProofCache!=='undefined'?reqProofCache[t.id]:null; // só o que JÁ foi lido (nada de leitura por cartão)
  let ok=0; if(c && c.list && typeof matchReqProofs==='function'){ ok=matchReqProofs(reqs, c.list).filter(x=>x&&x.status==='done').length; }
  return { ok, tot:reqs.length };
}
// miniatura: só se a lista de artefatos JÁ está no cache e a imagem sai direto do disco (sfart://) ou já foi lida
function kbLocalThumb(t){
  const c=typeof artifactsCache!=='undefined'?artifactsCache[t.id]:null; const imgs=((c&&c.list)||[]).filter(a=>a&&a.kind==='image');
  if(!imgs.length) return { thumb:null, n:0 };
  const nm=imgs[0].name, ok=typeof artFileUrlOk==='function'&&artFileUrlOk();
  const u=ok?artMediaUrl(t.id, nm):((typeof artThumbCache!=='undefined'&&artThumbCache[t.id+'|'+nm])||null);
  return { thumb:u, n:imgs.length };
}
function kbLocalTrav(t){
  const st=taskSt(t), b=flowBucket(t);
  if(t.flag==='blocked') return { tx:stLabel('blocked'), tip:'bloqueada — desbloqueie pelo menu ⋯' };
  if(b!=='aguardando') return null;
  const ev=lastEventOf(t.id), lbl=stLabel(st);
  if(['error','conflict'].includes(st) && ev && ev.text){ const h=typeof humanErr==='function'?humanErr(ev.text):null; return { tx:(h&&h.msg)?entMotivo({ last_note:h.msg }, lbl):entMotivo({ last_note:ev.text }, lbl), tip:ev.text }; }
  return { tx:lbl, tip:lbl };
}
function kbLocalVm(t){
  const me=(typeof cloudUserId==='function'&&cloudUserId())||'';
  const c=chainOfNow(t), ts=kbLocalTs(t), a=kbAgo(ts), th=kbLocalThumb(t), tr=kbLocalTrav(t);
  const acts=t.status==='draft'?[{ act:'start', label:'Iniciar', primary:true, title:'iniciar o rascunho agora (ou arraste pra “Em andamento”)' }]:[];
  return { id:t.id, kind:'local', col:kbColOf(flowBucket(t)), ts, title:mdTitle(t.title||''), sel:typeof selected!=='undefined'&&selected===t.id,
    chain:chainHtml(c, { omit:['task','who','st'] }), who:me?kbWho(me):`<span class="pchip kb-agent" title="rodando nesta máquina"><span class="pnm">${esc(t.agent||'agente')}</span></span>`,
    reqs:kbLocalReqs(t), thumb:th.thumb, proofs:th.n, trav:tr?tr.tx:'', travTip:tr?tr.tip:'', ago:a.ago, agoTip:a.tip, drops:kbLocalDrops(t), acts, menu:true, ref:t };
}

// ---- cartão do time (teamTasks) ----
function kbActOf(t){ const a=(typeof teamActivity!=='undefined'&&teamActivity||[]).find(x=>x.task_id===t.id); return a||null; }
// modificação do cartão: a fonte única do #149 (caModOf: updated_at, última atividade, fim/último evento da tarefa local)
function kbTeamTs(t){ if(typeof caModOf==='function') return caModOf(t); const a=kbActOf(t), l=typeof tsLocalOf==='function'?tsLocalOf(t):null; return modTs(t.updated_at, a&&a.at, l?kbLocalTs(l):0); }
function kbTeamThumb(t){
  const n=(typeof entProvas!=='undefined'&&entProvas.m)?(entProvas.m[t.id]||0):0;
  const nm=(typeof entProvas!=='undefined'&&entProvas.img)?entProvas.img[t.id]:'';
  const u=nm&&typeof artThumbCache!=='undefined'?(artThumbCache[t.id+'|'+nm]||null):null; // 45 já assinou (página do cartão aberta antes)
  return { thumb:u, n };
}
function kbTeamVm(t, x){
  x=x||{}; const fn=ENT_FN, me=x.me, proj=(typeof teamProj!=='undefined'&&teamProj[t.project_id])||{};
  const sameRepo=!proj.repo_remote || (typeof remoteSame==='function' && remoteSame(proj.repo_remote, (typeof teamRepoIds!=='undefined'&&teamRepoIds)||{ remote:(typeof teamRepoRemote!=='undefined'?teamRepoRemote:'') }));
  const canAssign=typeof caCanAssign==='function'?caCanAssign(t.team_id):false;
  const bucket=tsBucket(t), ts=kbTeamTs(t), a=kbAgo(ts), th=kbTeamThumb(t);
  // motivo da trava: a fonte única do #149 (entTravaTx = entTravada + entMotivo com contexto)
  const travTx=typeof entTravaTx==='function'?entTravaTx(t):(entTravada(t, fn)?entMotivo(t, ctStLabel(t)):'');
  const c=chainOfNow(t);
  const acts=typeof caAcoes==='function'?caAcoes(t, { me, canAssign, local:!!(typeof caLocalOf==='function'&&caLocalOf(t)), repo:typeof caRepo==='function'?caRepo(t):'here' }, fn):[];
  const prim=acts.filter(z=>z.primary && ['claim','start','openproj'].includes(z.act)).slice(0,1); // só o passo do cartão; abrir = clicar
  return { id:t.id, kind:'cloud', col:kbColOf(bucket, Object.assign({ rascunho:'fila' }, x.colMap)), ts, title:mdTitle(t.title||''),
    chain:chainHtml(c, { omit:['task','who','st','proof'] }), who:kbWho(t.assignee), reqs:entReqs(t), thumb:th.thumb, proofs:th.n,
    trav:travTx, travTip:travTx?String(t.last_note||travTx):'', ago:a.ago, agoTip:a.tip,
    drops:kbTeamDrops(t, { me, canAssign, sameRepo, bucket, st:tsNorm(t).status }), /* st: o status local vence (a nuvem atrasa) */ acts:prim, menu:true, ref:t, cls:x.org?'org':'',
    tag:(x.org||x.tag)?(typeof tsTeamName==='function'?tsTeamName(t.team_id):''):'' };
}
// menu ⋯ do cartão do time: as ações de caAcoes que não estão no cartão + abrir + remover (criador/admin, na fila)
function kbTeamMenu(ct, anchor, after){
  menuClose($id('kbMenuPop'));
  const me=cloudUserId(), fn=ENT_FN, isAdmin=cloudData&&(cloudData.meRole==='owner'||cloudData.meRole==='admin');
  const acts=caAcoes(ct, { me, canAssign:caCanAssign(ct.team_id), local:!!caLocalOf(ct), repo:caRepo(ct) }, fn);
  const pop=document.createElement('div'); pop.id='kbMenuPop'; pop.className='kb-pop';
  const item=(label, f, danger)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=label; if(danger) b.className='danger';
    b.onclick=async(e)=>{ e.stopPropagation(); menuClose(pop); try{ await f(); if(after) after(); }catch(err){ showErr(err, 'Não deu'); } }; pop.appendChild(b); };
  item('abrir o cartão', ()=>caOpen(ct));
  acts.filter(a=>!['view','review','term','entrega'].includes(a.act) && !a.off).forEach(a=>item(a.label, ()=>caAct(a.act, ct, a.act==='assign'?anchor:null))); // só o seletor de pessoa usa a âncora (as outras escreveriam “assumindo…” nela)
  if(ct.pr_url && /^https?:\/\//i.test(ct.pr_url)) item('abrir o PR no GitHub', ()=>openExternal(ct.pr_url));
  if(ct.status==='backlog' && (ct.created_by===me || isAdmin) && typeof teamDeleteCard==='function') item('remover do backlog do time…', ()=>teamDeleteCard(ct), true);
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.max(10, Math.min(window.innerHeight-pop.offsetHeight-10, r.bottom+6))+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-pop.offsetWidth-10, r.right-pop.offsetWidth))+'px';
  menuWire(pop, anchor); // role=menu/menuitem, setas, Esc devolve o foco
}

// ---- issue do painel (14) ----
function kbIssueVm(i, o){
  o=o||{};
  // ligação issue ↔ tarefa: o índice do 14 (trkEntriesFor/trkRowOf — tarefa desta máquina OU cartão de alguém do time)
  const r=o.row||trkRowOf(i, trkEntriesFor(i.code), { me:(typeof cloudUserId==='function'&&cloudUserId())||'' });
  const t=r.local||r.card||null;
  const p=trkPerson(i.assignee, i.assigneeEmail);
  const panelWho=p?(p.mail?personChip(p.mail, { short:true }):`<span class="pchip${p.unnamed?' kb-unnamed':''}" title="${escA(p.tip)}"><span class="tsav" style="background:var(--muted)" aria-hidden="true">${esc(p.ini)}</span><span class="pnm">${esc(p.label)}</span></span>`):null;
  // quem está com ela: com tarefa ligada, quem está com a TAREFA (personChip; ninguém = "livre"); sem tarefa, o responsável no painel
  const who=r.linked?(r.who?kbWho(r.who):null):panelWho;
  const bits=[];
  if(i.epicCode && !o.inGroup) bits.push(`<span class="chn chn-epic" title="${escA('filha do épico '+i.epicCode)}"><i aria-hidden="true"></i><b>${esc(i.epicCode)}</b></span>`);
  if(t){ const st=trkRowSt(r), c=chainOfNow(t);
    bits.push(chainHtml(Object.assign({}, c, { issue:null }), { omit:['who','proof'], arrows:false }).replace('class="chn chn-task"', `class="chn chn-task" style="--chc:${stColor(st)}"`).replace(/title="abrir a tarefa"/, `title="${escA('tarefa ligada · '+stLabel(st))}"`)); }
  const un=trkUnseen()[i.code], ts=r.mod||modTs(i.updatedAt, i.createdAt), a=kbAgo(ts);
  const blocked=((trkStatus(i.status)||{}).kind==='blocked');
  const travTx=r.card&&typeof entTravaTx==='function'?entTravaTx(r.card):'';
  const nProofs=r.card&&typeof trkProofs!=='undefined'?(trkProofs.m[r.card.id]||0):0; // o lote do 14 (nunca por cartão)
  return { id:i.code, kind:'issue', col:i.status, ts, title:i.title, sel:trkSel===i.code,
    chain:`<span class="chn kb-code" title="código no painel"><b>${esc(i.code)}</b></span>`+bits.join('')+(i.commentCount?`<span class="kb-cc" title="${escA(i.commentCount+' comentário(s)')}">${IC.chat} ${esc(String(i.commentCount))}</span>`:'')+(un?`<span class="trk-new">${esc(un)}</span>`:'')+(i.priority!=null&&i.priority!==''?`<span class="trk-pri">${esc(String(i.priority))}</span>`:''),
    who, freeLabel:r.linked?'livre':'sem responsável', reqs:r.card&&typeof entReqs==='function'?entReqs(r.card):null, thumb:null, proofs:nProofs,
    trav:travTx||(blocked?'bloqueada no painel':''), ago:a.ago, agoTip:a.tip,
    drops:o.drops||{}, acts:[], menu:false, cls:'kb-issue'+(un?' kb-unseen':''), ref:i,
    attrs:` data-trkcode="${escA(i.code)}" role="button"` };
}
function kbIssueCard(i, o){ return kbCardHtml(kbIssueVm(i, o), KB_IC()); }

// ---------------------------------------------------------------------------------------------------------------------
// QUADRO DA CENTRAL — botão ao lado da Lista, lembrado POR PESSOA
function kbCentralKey(){ return userKey('kb:central', (typeof cloudUserId==='function'&&cloudUserId())||''); }
function kbCentralOn(){ try{ return lsGet(kbCentralKey())==='1'; }catch(_){ return false; } }
function kbCentralSet(on){ lsSet(kbCentralKey(), on?'1':'0'); try{ lastSig=''; if(typeof renderFlow==='function') renderFlow(); }catch(_){ } }
// o quadro vale na Execução ("Em aberto") e na aba Tarefas do alcance; Concluídas/"por dia" continuam lista
function kbCentralNow(team){ return kbCentralOn() && (team || (flowScope!=='done' && flowGroupBy!=='day')); }
const KB_CENTRAL_COLS=['rascunho','fila','aguardando','andamento','prontas','praberto'];
const KB_TEAM_COLS=['fila','aguardando','andamento','prontas','praberto','concluidas'];
// botões Lista | Quadro (a barra da Central e a do alcance usam o mesmo par)
function kbToggleHtml(team){
  const on=kbCentralNow(team);
  return `<span class="kb-tog" role="group" aria-label="ver como"><button type="button" class="fvic${on?'':' on'}" data-kbview="list" title="Lista — ordenável, uma ação por linha" aria-label="ver em lista" aria-pressed="${!on}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h10" stroke-linecap="round"/></svg></button>`+
    `<button type="button" class="fvic${on?' on':''}" data-kbview="board" title="Quadro — colunas por situação" aria-label="ver em quadro" aria-pressed="${on}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3" width="3.4" height="10" rx="1"/><rect x="6.9" y="3" width="3.4" height="6.5" rx="1"/><rect x="11.3" y="3" width="3.4" height="8.4" rx="1"/></svg></button></span>`;
}
function kbToggleWire(root){ (root||document).querySelectorAll('[data-kbview]').forEach(b=>b.onclick=()=>{ const on=b.dataset.kbview==='board'; if(!on && typeof flowView!=='undefined' && flowView!=='table'){ flowView='table'; lsSet('flowView','table'); } kbCentralSet(on); }); }
// Minhas: tarefas desta máquina (já filtradas pela Central) + do time "com você" e "livres" (as mesmas seções da lista)
function kbCentralMinhasHtml(tasks){
  const vms=(tasks||[]).map(kbLocalVm);
  const mSrc=typeof caMineSrc==='function'?caMineSrc():caSrc();
  if(typeof caOn==='function' && caOn() && caScope()==='minhas' && mSrc){
    const q=String(flowQuery||'').trim().toLowerCase(), fe=flowEpic;
    const m=caMinhas(mSrc, caMe(), caMyTeams(), CA_FN, t=>!!caLocalOf(t), caInQueue), multi=typeof taMultiTeam==='function'&&taMultiTeam();
    const ok=t=>(!q||String(t.title||'').toLowerCase().includes(q)) && (fe==='all'||t.epic_id===fe) && (flowStatus==='all'||kbColOf(tsBucket(t), { concluidas:'prontas', rascunho:'fila' })===flowStatus);
    m.comigo.concat(m.livres).filter(ok).forEach(t=>vms.push(kbTeamVm(t, { me:caMe(), colMap:{ concluidas:'prontas' }, tag:multi })));
  }
  const cols=kbGroup(vms, KB_CENTRAL_COLS.map(k=>kbCol(k)));
  return { n:cols.reduce((a,c)=>a+c.n, 0), html:kbBoardHtml({ id:'central', label:'quadro da Central', cols, card:vm=>kbCardHtml(vm, KB_IC()), empty:kbEmpty, more:kbMore }), vms };
}
// Do time / Org toda: o alcance + os chips/projeto/pessoa da barra do 71
function kbCentralTeamHtml(list, scope){
  const org=scope==='org', me=caMe();
  const vms=(list||[]).map(t=>kbTeamVm(t, { me, org }));
  return { n:vms.length, html:kbBoardHtml({ id:'central-'+scope, label:'quadro do alcance', cols:kbGroup(vms, KB_TEAM_COLS.map(k=>kbCol(k, { label:k==='aguardando'?'Aguardando alguém':'', cap:k==='concluidas'?12:0 }))), card:vm=>kbCardHtml(vm, KB_IC()), empty:kbEmpty, more:kbMore }), vms };
}
// Quadro do Time (43, tmView==='board')
function kbTeamBoardHtml(list){
  const me=cloudUserId(), org=typeof tsOrgScope==='function'&&tsOrgScope();
  { const all=(typeof teamTasks!=='undefined'&&teamTasks)||list; if(all.length && typeof entProvasLoad==='function') entProvasLoad(all.map(t=>t.id)); } // um lote por conjunto (o mesmo da aba Entregas)
  const vms=list.map(t=>kbTeamVm(t, { me, org }));
  return { html:kbBoardHtml({ id:'time', label:'quadro do time', cols:kbGroup(vms, KB_TEAM_COLS.map(k=>kbCol(k, { label:k==='aguardando'?'Aguardando alguém':'', cap:k==='concluidas'?12:0 }))), card:vm=>kbCardHtml(vm, KB_IC()), empty:kbEmpty, more:kbMore }), vms };
}

// ---------------------------------------------------------------------------------------------------------------------
// fiação: um ouvinte por quadro (delegado); h = { vms, open(vm, el), menu(vm, anchor), act(vm, act, btn), drop(vm, col, act) }
let kbDragId=null;
function kbWire(root, h){
  if(!root) return; root.__kbh=h;
  if(root.__kbw) return; root.__kbw=true;
  const vmOf=el=>{ const id=el&&el.dataset.kbid; return ((root.__kbh||{}).vms||[]).find(v=>String(v.id)===id)||null; };
  root.addEventListener('click', e=>{
    const H=root.__kbh||{}, card=e.target.closest('.kb-card'); if(!card) return; const vm=vmOf(card); if(!vm) return;
    const a=e.target.closest('[data-kbact]'); if(a){ e.stopPropagation(); if(!a.disabled && H.act) H.act(vm, a.dataset.kbact, a); return; }
    const m=e.target.closest('[data-kbmenu]'); if(m){ e.stopPropagation(); if(H.menu) H.menu(vm, m); return; }
    if(e.target.closest('button,a,select,input')) return;
    if(H.open) H.open(vm, card);
  });
  root.addEventListener('keydown', e=>{
    const card=e.target.closest&&e.target.closest('.kb-card'); if(!card || e.target!==card) return; const H=root.__kbh||{}, vm=vmOf(card); if(!vm) return;
    if(e.key==='Enter'||e.key===' '){ e.preventDefault(); if(H.open) H.open(vm, card); }
    else if((e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')) && H.menu && vm.menu){ e.preventDefault(); H.menu(vm, card); }
    else if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key)){ // setas andam entre cartões (coluna e vizinhas)
      const col=card.closest('.kb-col'), cards=[...col.querySelectorAll('.kb-card')], i=cards.indexOf(card); let nx=null;
      if(e.key==='ArrowDown') nx=cards[i+1]; else if(e.key==='ArrowUp') nx=cards[i-1];
      else { let c=col; do{ c=e.key==='ArrowRight'?c.nextElementSibling:c.previousElementSibling; }while(c && !c.querySelector('.kb-card')); nx=c?c.querySelectorAll('.kb-card')[Math.min(i, c.querySelectorAll('.kb-card').length-1)]:null; }
      if(nx){ e.preventDefault(); nx.focus(); nx.scrollIntoView({ block:'nearest', inline:'nearest' }); }
    }
  });
  root.addEventListener('contextmenu', e=>{ const card=e.target.closest('.kb-card'); const H=root.__kbh||{}; if(!card||!H.menu) return; const vm=vmOf(card); if(!vm||!vm.menu) return; e.preventDefault(); H.menu(vm, card); });
  // arrastar: só cartão com destino permitido; as colunas que aceitam acendem, as outras apagam
  root.addEventListener('dragstart', e=>{ const card=e.target.closest&&e.target.closest('.kb-card[draggable="true"]'); if(!card) return;
    kbDragId=card.dataset.kbid; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; try{ e.dataTransfer.setData('text/plain', kbDragId); }catch(_){ }
    const ok=new Set(String(card.dataset.kbdrops||'').split(' ').filter(Boolean));
    root.querySelectorAll('.kb-col').forEach(c=>c.classList.add(ok.has(c.dataset.kbcol)?'kb-ok':'kb-no')); root.classList.add('dragging'); });
  // fim do arrasto: o redesenho pulado durante ele volta (kbRepaintActive)
  const end=()=>{ const was=!!kbDragId; kbDragId=null; if(was) setTimeout(kbRepaintActive, 0); root.classList.remove('dragging'); root.querySelectorAll('.kb-col').forEach(c=>c.classList.remove('kb-ok','kb-no','over')); root.querySelectorAll('.kb-card.dragging').forEach(c=>c.classList.remove('dragging')); };
  root.addEventListener('dragend', end);
  root.addEventListener('dragleave', e=>{ const c=e.target.closest&&e.target.closest('.kb-col'); if(c && !c.contains(e.relatedTarget)) c.classList.remove('over'); });
  if(!kbWire.__doc){ kbWire.__doc=true; document.addEventListener('dragend', ()=>{ kbDragId=null; }, true); document.addEventListener('drop', ()=>{ setTimeout(()=>{ kbDragId=null; }, 0); }, true); }
  root.addEventListener('dragover', e=>{ const col=e.target.closest&&e.target.closest('.kb-col.kb-ok'); if(!col||!kbDragId) return; e.preventDefault(); e.dataTransfer.dropEffect='move'; root.querySelectorAll('.kb-col.over').forEach(c=>{ if(c!==col) c.classList.remove('over'); }); col.classList.add('over'); });
  root.addEventListener('drop', e=>{ const col=e.target.closest&&e.target.closest('.kb-col'); const id=kbDragId; const H=root.__kbh||{}; end(); if(!col||!id) return; e.preventDefault();
    const vm=((H.vms)||[]).find(v=>String(v.id)===id); const act=vm&&vm.drops&&vm.drops[col.dataset.kbcol];
    if(vm && act && H.drop) Promise.resolve(H.drop(vm, col.dataset.kbcol, act)).catch(err=>showErr(err, 'Não deu pra mover')); });
}

// handlers comuns: tarefa desta máquina e cartão do time (Central e Time)
function kbHandlers(vms, after){
  return { vms,
    open(vm){ if(vm.kind==='local'){ const t=vm.ref; if(t._cross && t.repo && t.repo!==state.repo){ switchToProjectTask(t.repo, t.id); return; } selected=t.id; render(); openOrEdit(t); }
      else caOpen(vm.ref); },
    menu(vm, anchor){ if(vm.kind==='local') openTaskMenu(vm.id, anchor); else { const l=caLocalOf(vm.ref); if(l) openTaskMenu(l.id, anchor); else kbTeamMenu(vm.ref, anchor, after); } },
    act(vm, act, btn){ if(vm.kind==='local'){ if(act==='start') crossRun(vm.id, ()=>startTask(vm.id)); return; }
      return Promise.resolve(caAct(act, vm.ref, btn)).then(()=>{ if(after) after(); }).catch(err=>showErr(err, 'Não deu')); },
    async drop(vm, col, act){
      if(vm.kind==='local'){ if(act==='start') return crossRun(vm.id, ()=>startTask(vm.id)); return; }
      const ct=vm.ref;
      if(act==='claimstart'){ await teamClaimStart(ct); teamFetchedAt=0; if(after) after(); return; }
      if(act==='release'){ await tsRelease(ct); teamFetchedAt=0; if(after) after(); return; }
    } };
}
function kbWireCentral(el, vms){ const b=el&&el.querySelector('.kb-board'); if(b) kbWire(b, kbHandlers(vms, ()=>{ lastSig=''; if(typeof caRerender==='function') caRerender(); })); }
function kbWireTeam(el, vms){ const b=el&&el.querySelector('.kb-board'); if(b) kbWire(b, kbHandlers(vms, ()=>{ teamPaintSig=''; renderTeamBoard(); })); }
function kbRepaintActive(){ try{ if(typeof activeIs==='function' && activeIs('team')){ teamPaintSig=''; renderTeamBoard(); } else { lastSig=''; if(typeof renderFlow==='function') renderFlow(); } }catch(_){ } }
// as provas do lote chegaram (70): redesenha o quadro aberto (Central ou Time) — sem laço novo
function kbProvasDone(){ try{ if(typeof activeIs==='function' && activeIs('team') && typeof tmView!=='undefined' && tmView==='board'){ teamPaintSig=''; renderTeamBoard(); } else if(typeof activeIs==='function' && activeIs('flow') && kbCentralOn()){ lastSig=''; if(typeof renderFlow==='function') renderFlow(); } }catch(_){ } }
window.kbCentralOn=kbCentralOn; window.kbCentralSet=kbCentralSet; window.kbCentralNow=kbCentralNow; window.kbToggleHtml=kbToggleHtml; window.kbToggleWire=kbToggleWire;
window.kbCentralMinhasHtml=kbCentralMinhasHtml; window.kbCentralTeamHtml=kbCentralTeamHtml; window.kbTeamBoardHtml=kbTeamBoardHtml;
window.kbWireCentral=kbWireCentral; window.kbWireTeam=kbWireTeam; window.kbIssueCard=kbIssueCard; window.kbProvasDone=kbProvasDone;
