// Starfork — 60-terminal-layout
// ===== MODO TERMINAL · LAYOUT A (aprovado pelo dono em 03/10 — mock "Tela do terminal · layout A") =====
// A tela da tarefa em modo terminal: o terminal de verdade no centro (60-terminal.js), o compositor de sempre embaixo
// (anexos, mira/prévia, IA, "vira requisito", Enter fila · ⌘Enter interrompe) e, à direita, o painel "Requisitos e
// provas" com o portão — recolhível (⇥) numa faixa fina com as bolinhas por requisito e "N/M com prova", lembrado por
// tarefa. Pane estreito (canvas com 2–3 tarefas) → a faixa vem sozinha; clicar nela abre o painel por cima.
// Quando o agente PERGUNTA (AskUserQuestion do Claude Code pelo hook — src/terminal.ts — ou ask_human do MCP), sobe
// uma FOLHA por cima do terminal, como no Claude: várias perguntas em abas, ↑↓ ou 1–N escolhem, "outra resposta",
// ←→ trocam de pergunta, Enter envia, "pular". A resposta vai pro `pending` (resolve_pending) e o hook devolve ao
// Claude Code como resposta do usuário. Única exceção aprovada a "aba, não modal": ancorada ao terminal, não à janela.
// Fontes únicas: reqRows/proofGate/proofGateLine/proofAsk/approveGate/approveNoProof (21/27), taskSt/stMeta, enThumbHtml.

// @tl-puro-inicio (puro: só esc/escA — testado em app/tests/terminal-layout.test.mjs)
const TL_NARROW=760; // largura da coluna do terminal abaixo da qual o painel vira faixa sozinho
const TL_IN_TERMINAL='(responder no terminal)'; // = AUQ_IN_TERMINAL (src/terminal.ts): o hook solta e o picker do CLI aparece no TTY
const TL_SKIP_HUMAN='(sem resposta — siga com a melhor suposição e registre-a em .cardume/artifacts/ASSUMPTIONS.md)';
const TL_IC={
  fold:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6"/><path d="M10 2.8v10.4M5 6.2 6.8 8 5 9.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  unfold:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6"/><path d="M10 2.8v10.4M6.8 6.2 5 8l1.8 1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// estado visual de cada requisito: ok (com prova) · no (bloqueado/sem prova) · go (rodando, ainda sem prova) · '' (não começou)
function tlReqView(rows, working){
  return (rows||[]).map(r=>{
    const ev=Array.isArray(r.evidence)?r.evidence:[];
    if(r.st==='ok' && ev.length) return { text:r.text, ck:'ok', sub:'prova: '+ev.slice(0,2).map(e=>String(e).split('/').pop()).join(' · ')+(ev.length>2?' +'+(ev.length-2):''), ev };
    if(r.st==='ok') return { text:r.text, ck:'no', sub:'feito, mas sem arquivo de prova', ev };
    // requirements.json marca "pending" como não-feito (blk): rodando e sem motivo = ainda em andamento
    if(r.st==='blk' && working && !r.note) return { text:r.text, ck:'go', sub:'em andamento', ev };
    if(r.st==='blk') return { text:r.text, ck:'no', sub:'sem prova'+(r.note?' · "'+String(r.note).slice(0,120)+'"':''), ev };
    return { text:r.text, ck:working?'go':'', sub:working?'em andamento':'ainda sem prova', ev };
  });
}
function tlCount(view){ return (view||[]).filter(v=>v.ck==='ok').length; }
// a faixa fina (painel recolhido ou pane estreito)
function tlRailHtml(view, o){
  o=o||{}; const n=tlCount(view), m=(view||[]).length;
  const label=m?`${n}/${m} com prova`:'sem requisitos';
  return `<aside class="tlrail${o.forced?' forced':''}" data-tl="unfold" role="button" tabindex="0" aria-label="${escA('abrir requisitos e provas — '+label)}" title="abrir requisitos e provas">`+
    `<span class="tltog" aria-hidden="true">${TL_IC.unfold}</span>`+
    `<span class="tldots" aria-hidden="true">${(view||[]).slice(0,12).map(v=>`<i class="${v.ck}"></i>`).join('')}</span>`+
    `<span class="tlnum">${esc(label)}</span></aside>`;
}
// o painel inteiro: requisitos (com miniaturas das provas) + o portão
// o: { view, gate:{st,missing}, gateHtml, phase:'working'|'review'|'pr'|'idle', thumbs:(ev)=>html, overlay, loading,
//      subHtml:(v,i)=>html (linha de baixo do requisito com os nomes das provas virando link), extra:html (Entregáveis) }
function tlPanelHtml(o){
  const view=o.view||[]; const n=tlCount(view), m=view.length;
  const items=!m
    ? `<div class="tlempty"><b>Sem requisitos ainda</b><span>Marque <b>vira requisito</b> no compositor pra transformar um pedido em requisito com prova.</span></div>`
    : view.map((v,i)=>`<div class="tlreq"><span class="tlck ${v.ck}" aria-label="${escA(v.ck==='ok'?'com prova':v.ck==='no'?'sem prova':v.ck==='go'?'em andamento':'não começou')}"></span><span class="tlrt"><span class="tlrtx">${esc(v.text)}</span><small>${o.subHtml?o.subHtml(v, i):esc(v.sub)}</small>${v.ck==='ok'&&o.thumbs?o.thumbs(v.ev, i):''}</span></div>`).join('');
  const pct=m?Math.round(n/m*100):0;
  let acts='';
  if(m){
    if(o.loading) acts='<span class="tlgh">conferindo as provas…</span>';
    else if(o.phase==='pr') acts='<button type="button" class="btn sm" data-tl="pr">ver o PR</button>';
    else if(o.phase==='review') acts=(o.gate&&o.gate.st==='unproven')
      ? `<button type="button" class="btn sm primary" data-tl="askproof">pedir a prova ao agente</button><button type="button" class="btn sm" data-tl="noproof" title="exige um motivo — vai na descrição do PR e fica registrado">aprovar sem prova…</button>`
      : `<button type="button" class="btn sm primary" data-tl="approve">aprovar e abrir PR</button>`;
    else if(o.phase==='closed') acts='';
    else acts='<span class="tlgh">aprovar exige a prova de cada requisito ou um motivo</span>';
  }
  const gate=m?`<div class="tlgate"><div class="tlgr"><b>Portão de provas</b><span>${n}/${m} com prova</span></div><div class="tlbar" role="progressbar" aria-valuemin="0" aria-valuemax="${m}" aria-valuenow="${n}" aria-label="requisitos com prova"><i style="transform:scaleX(${(pct/100).toFixed(3)})"></i></div>${acts}</div>`:'';
  return `<aside class="tlpanel${o.overlay?' overlay':''}" aria-label="Requisitos e provas"><div class="tlph"><span>Requisitos e provas</span><button type="button" class="tltog" data-tl="fold" title="${o.overlay?'fechar':'recolher (fica uma faixa com o progresso)'}" aria-label="${o.overlay?'fechar requisitos e provas':'recolher requisitos e provas'}">${TL_IC.fold}</button></div><div class="tlpb">${items}${gate}${o.extra||''}</div></aside>`;
}

// ---- pergunta do agente ----
// pendências abertas da tarefa → o GRUPO da folha: AskUserQuestion (meta.group, várias perguntas) ou ask_human (1)
function tlAskGroup(pend){
  const qs=(pend||[]).filter(p=>p && (p.kind==='question'||!p.kind) && !(+p.id<0));
  if(!qs.length) return null;
  const meta=(p)=>(p.meta && typeof p.meta==='object')?p.meta:null;
  const first=qs[0], m0=meta(first);
  const key=m0&&m0.group?'g:'+m0.group:'p:'+first.id;
  const mine=m0&&m0.group?qs.filter(p=>{ const m=meta(p); return m&&m.group===m0.group; }):[first];
  if(m0 && m0.n>mine.length) return null; // grupo ainda chegando (o snapshot pegou no meio): espera ele inteiro
  const rows=mine
    .slice().sort((a,b)=>((meta(a)||{}).idx|0)-((meta(b)||{}).idx|0))
    .map(p=>{ const m=meta(p)||{}; const opts=Array.isArray(p.options)?p.options.map(String):[];
      return { id:p.id, ck:p.id+'|'+(p.createdAt||''), prompt:String(p.prompt||''), header:String(m.header||''), options:opts, desc:opts.map((_,i)=>String((m.desc||[])[i]||'')), multi:!!m.multi }; });
  return { key, auq:!!(m0&&m0.src==='auq'), agent:first.agent||'', rows };
}
function tlAskNew(g){ return { sent:{}, q:0, sel:g.rows.map(r=>r.options.length?(r.multi?[]:[0]):[]), other:g.rows.map(()=> ''), skip:g.rows.map(()=>false), sending:false, min:false }; }
// a resposta de cada pergunta (texto que vai pro pending): outra resposta > opções escolhidas; pulada = ''
function tlAskAnswers(g, st){
  return g.rows.map((r,i)=>{
    if(st.skip[i]) return g.auq?'':TL_SKIP_HUMAN;
    const o=String(st.other[i]||'').trim(); if(o) return o;
    const s=(st.sel[i]||[]).filter(k=>k>=0 && k<r.options.length).sort((a,b)=>a-b);
    if(s.length) return s.map(k=>r.options[k]).join(', ');
    return g.auq?'':TL_SKIP_HUMAN;
  });
}
// teclado da folha (puro): devolve o estado novo e a ação ('send' | 'close' | null). inInput = foco no "outra resposta"
function tlAskKey(g, st, key, inInput){
  const s={ ...st, sel:st.sel.map(x=>x.slice()), other:st.other.slice(), skip:st.skip.slice() };
  const r=g.rows[s.q]; const n=r?r.options.length:0; const last=s.q>=g.rows.length-1;
  if(key==='Escape') return { st:s, act:'close' };
  if(key==='Enter'){ if(last) return { st:s, act:'send' }; s.q++; s.cursor=null; return { st:s, act:null }; }
  if(inInput) return { st:s, act:null, pass:true };
  const cur=(s.sel[s.q]||[]); const at=s.cursor!=null?s.cursor:(cur.length?cur[cur.length-1]:-1);
  const pick=(k)=>{ if(!n) return; s.other[s.q]=''; s.skip[s.q]=false; if(r.multi){ const i=cur.indexOf(k); s.sel[s.q]=i>=0?cur.filter(x=>x!==k):cur.concat(k); } else s.sel[s.q]=[k]; };
  if(key==='ArrowDown'){ if(n){ s.other[s.q]=''; s.skip[s.q]=false; s.sel[s.q]=r.multi?cur:[(at+1+n)%n]; s.cursor=(at+1+n)%n; } return { st:s, act:null }; }
  if(key==='ArrowUp'){ if(n){ s.other[s.q]=''; s.skip[s.q]=false; s.sel[s.q]=r.multi?cur:[(at-1+n)%n]; s.cursor=(at-1+n)%n; } return { st:s, act:null }; }
  if(key===' ' && r && r.multi){ const k=s.cursor!=null?s.cursor:0; pick(k); return { st:s, act:null }; }
  if(/^[1-9]$/.test(key) && +key<=n){ pick(+key-1); s.cursor=+key-1; return { st:s, act:null }; }
  if(key==='ArrowRight'){ if(!last){ s.q++; s.cursor=null; } return { st:s, act:null }; }
  if(key==='ArrowLeft'){ if(s.q>0){ s.q--; s.cursor=null; } return { st:s, act:null }; }
  return { st:s, act:null, pass:true };
}
function tlSheetHtml(g, st){
  const r=g.rows[st.q]||g.rows[0]; const many=g.rows.length>1; const last=st.q>=g.rows.length-1;
  const done=(i)=>st.skip[i] || String(st.other[i]||'').trim() || (st.sel[i]||[]).length;
  const tabs=many?`<span class="tlqtabs" role="tablist" aria-label="perguntas">${g.rows.map((x,i)=>`<button type="button" role="tab" class="tlqt${i===st.q?' on':done(i)&&i!==st.q?' done':''}" data-tlq="${i}" aria-selected="${i===st.q}">${i+1}. ${esc(x.header||x.prompt.slice(0,28))}</button>`).join('')}</span>`:'';
  const cur=st.sel[st.q]||[]; const other=String(st.other[st.q]||'');
  const opts=r.options.map((o,i)=>{ const on=!other && cur.includes(i);
    return `<button type="button" class="tlopt${on?' sel':''}${st.cursor===i?' cur':''}" data-tlopt="${i}" role="${r.multi?'checkbox':'radio'}" aria-checked="${on}"><span class="k">${i+1}</span><span class="tlot"><b>${esc(o)}</b>${r.desc[i]?`<small>${esc(r.desc[i])}</small>`:''}</span></button>`; }).join('');
  const n=r.options.length;
  return `<div class="tlsheet${st.sending?' sending':''}" role="dialog" aria-modal="false" aria-label="${escA('pergunta do agente'+(g.agent?' '+g.agent:''))}" tabindex="-1">`+
    `<div class="tlsh"><span class="tlshk">${esc(g.agent||'O agente')} pergunta</span>${tabs}<span class="sp"></span><button type="button" class="tlmin" data-tl="askmin" title="esconder a pergunta (Esc) — ela continua esperando você" aria-label="esconder a pergunta">${TL_IC.fold}</button></div>`+
    `<div class="tlq" id="tlQ">${esc(r.prompt)}${r.multi?' <span class="tlmulti">escolha uma ou mais</span>':''}</div>`+
    (n?`<div class="tlopts" role="${r.multi?'group':'radiogroup'}" aria-labelledby="tlQ">${opts}</div>`:'')+
    `<div class="tlother"><input class="in" data-tl="other" placeholder="${n?'outra resposta…':'sua resposta…'}" aria-label="${n?'outra resposta':'sua resposta'}" value="${escA(other)}"></div>`+
    `<div class="tlsf"><span class="tlkeys">${n?`<span class="kbd">↑↓</span> escolher <span class="kbd">1–${Math.min(9,n)}</span> atalho `:''}${many?'<span class="kbd">←→</span> pergunta ':''}<span class="kbd">Enter</span> ${last?'envia':'próxima'}</span>`+
    `<span class="sp"></span>${g.auq?'<button type="button" class="lnk" data-tl="askterm" title="o Claude mostra a pergunta no próprio terminal">responder no terminal</button>':''}<button type="button" class="btn sm" data-tl="askskip">pular</button><button type="button" class="btn sm primary" data-tl="asknext"${st.sending?' disabled':''}>${st.sending?'enviando…':last?(many?'enviar respostas':'enviar'):'próxima'}</button></div></div>`;
}
// @tl-puro-fim

// ---------------------------------------------------------------- estado por tarefa
const TL={ ask:{}, sheets:{}, peek:{}, ro:null, roFor:'', narrow:{}, budSending:{} }; // ask: chave do grupo → estado da folha
function tlFolded(taskId){ return lsGet('tlFold:'+taskId)==='1'; }
function tlSetFolded(taskId, on){ lsSet('tlFold:'+taskId, on?'1':'0'); }
function tlPhase(t){
  if(t.prUrl) return 'pr';
  if(['merged','aborted','cancelled','done','closed'].includes(t.status) || t.flag==='closed') return 'closed';
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !pendingOf(t.id).length;
  if(working) return 'working';
  return ['review','delivered'].includes(t.status)?'review':'idle';
}
function tlThumbs(t){
  const arts=(artifactsCache[t.id]&&artifactsCache[t.id].list)||null;
  return (ev)=>{
    const imgs=[]; for(const e of ev||[]){ const n=(arts&&typeof enEvResolve==='function')?enEvResolve(t.id, e, arts):String(e).split('/').pop(); if(n && /\.(png|jpe?g|gif|webp)$/i.test(n) && !imgs.includes(n)) imgs.push(n); }
    if(!imgs.length || typeof enThumbHtml!=='function') return '';
    return `<span class="tlthumbs">${imgs.slice(0,3).map((n,i)=>`<button type="button" class="tlth" data-tllb="${escA(JSON.stringify([imgs,i]))}" title="${escA('ver a prova: '+n)}">${enThumbHtml(t.id, n, 'prova: '+n)}</button>`).join('')}</span>`;
  };
}
function tlSideHtml(t){
  const rows=(typeof reqRows==='function')?reqRows(t):[];
  if(rows.length && reqProofCache[t.id]===undefined && typeof fwReqProofsEnsure==='function') fwReqProofsEnsure(t.id);
  const phase=tlPhase(t);
  const view=tlReqView(rows, phase==='working' || (pendingOf(t.id).length>0 && (ACTIVE_ST.has(t.status)||t.busy))); // perguntando = ainda em andamento
  const narrow=!!TL.narrow[t.id];
  const folded=narrow || tlFolded(t.id);
  if(folded && !(narrow && TL.peek[t.id])) return tlRailHtml(view, { forced:narrow });
  const gate=(typeof proofGate==='function')?proofGate(t):{ st:'none', missing:[] };
  return (narrow?tlRailHtml(view, { forced:true }):'')+tlPanelHtml({ view, gate, phase, thumbs:tlThumbs(t), overlay:narrow, loading:gate.st==='loading',
    subHtml:(typeof tiProofSubHtml==='function')?(v)=>tiProofSubHtml(t, v):null, extra:(typeof tiDelivHtml==='function')?tiDelivHtml(t):'' }); // 64-terminal-integrado: provas e entregáveis viram link
}
function tlBarHtml(t){
  const st=taskSt(t), m=stMeta(st);
  const ai=(typeof aiRunLabel==='function')?aiRunLabel(t.engine, t.model):(t.engine||'claude');
  const q=+t.queued||0;
  const ts=TERM[t.id]; const live=!!(ts && ts.mode==='live' && ts.alive);
  const gone=!live && typeof termWtGone==='function' && termWtGone(t.id);
  const comp=typeof tiCompOn!=='function' || tiCompOn(t); // compositor escondido (terminal integrado): digita-se no próprio terminal
  const hint=!comp ? (live ? 'digite direto no terminal' : gone ? 'digite pra perguntar sobre o que foi feito' : (typeof termHeadless==='function' && termHeadless(t)) ? 'rodando em segundo plano · as sugestões e os botões entram na fila' : 'digite no terminal pra retomar a sessão')
    : live ? 'Enter no compositor entra na fila · ⌘Enter interrompe'
    : gone ? 'Enter no compositor retoma a conversa da tarefa integrada' : (typeof termHeadless==='function' && termHeadless(t)) ? 'Enter entra na fila · ⌘Enter interrompe e retoma no terminal'
    : (ts && ts.hinfo && ts.hinfo.resumes===false) ? 'Enter manda no modo automático' : 'Enter no compositor retoma a sessão no terminal';
  const note=tlSysNote(t);
  return `<span class="tldot" style="--c:${m.c}" aria-hidden="true"></span><span class="tlai">${esc(ai)}</span><span class="tlst" style="color:${m.c}">${esc(m.pt)}</span>`+
    (note?`<span class="tlnote" title="${escA(note)}">${esc(note)}</span>`:'')+'<span class="sp"></span>'+
    `${q?`<span class="tlq1" title="mensagens esperando o terminal terminar o turno">${q} na fila</span>`:''}${hint?`<span class="tlhint">${esc(hint)}</span>`:''}`;
}
// a última nota do Starfork (PR aberto, fila, requisito, sessão retomada…) — no vivo ela não entra no TTY: fica na barra
function tlSysNote(t){
  const evs=(typeof termEvents==='function')?termEvents(t.id):[];
  for(let i=evs.length-1, n=0;i>=0 && n<60;i--, n++){ const e=evs[i]; const tx=String(e.text||'');
    if(e.agent!=='Sistema' && !/^(PR aberto|PR NÃO aberto|requisito adicionado:|falha ao finalizar)/i.test(tx)) continue;
    if(!(e.type==='note'||e.type==='status') || /^terminal: /.test(tx)) continue;
    const ts=(typeof thTs==='function')?thTs(e):0; if(ts && Date.now()-ts>15*60000) return '';
    return (typeof thSysText==='function'?thSysText(tx):tx).replace(/\s+/g,' ').trim(); }
  return '';
}
// teto de custo aberto: a pergunta não é do agente (não vai pra folha) — cartão em cima do compositor, com as opções
function tlBudgetHtml(t){
  const p=pendingOf(t.id).find(x=>typeof fwIsBudgetAsk==='function' && fwIsBudgetAsk(x)); if(!p) return '';
  const opts=Array.isArray(p.options)?p.options:[];
  return `<div class="tlbudget" role="group" aria-label="teto de custo"><div class="tlbudq"><b>Teto de custo</b> · ${esc(p.prompt||'o agente parou no teto — decida como seguir')}</div>`+
    (opts.length?`<div class="tlbudo">${opts.map(o=>`<button type="button" class="btn sm" data-tlbud="${escA(o)}"${TL.budSending[t.id]?' disabled':''}>${esc(o)}</button>`).join('')}</div>`:'')+
    `<div class="tlbudh">ou escreva o valor e o motivo no compositor — o agente fica parado até você decidir</div></div>`;
}
/** O HTML da coluna da tarefa em modo terminal (renderWorkspace chama; o composer vem pronto de lá). */
function tlChatHtml(t, composer){
  return `<div class="tlwrap" data-tlwrap="${escA(t.id)}"><div class="tlcol${typeof tiCompOn==='function'&&!tiCompOn(t)?' ti-nocomp':''}"><div class="tltermbar" id="tlBar">${tlBarHtml(t)}</div>${termSlotHtml(t)}<div id="tlBudget">${tlBudgetHtml(t)}</div>${typeof tiDockHtml==='function'?tiDockHtml(t):''}${composer}</div><div class="tlside" id="tlSide">${tlSideHtml(t)}</div></div>`;
}
/** Depois do innerHTML: liga o painel, mede a largura e põe a folha (se houver pergunta). */
function tlWire(t, grab){
  const wrap=document.querySelector(`[data-tlwrap="${CSS.escape(t.id)}"]`); if(!wrap) return;
  const side=$id('tlSide'); if(side){ side.__html=side.innerHTML; side.onclick=(e)=>tlSideClick(t.id, e); side.onkeydown=(e)=>{ if((e.key==='Enter'||e.key===' ') && e.target.closest('[data-tl="unfold"]')){ e.preventDefault(); tlSideAct(t.id, 'unfold'); } }; }
  { const bud=$id('tlBudget'); if(bud) bud.onclick=async(e)=>{ const b=e.target.closest('[data-tlbud]'); if(!b) return; const p=pendingOf(t.id).find(x=>fwIsBudgetAsk(x)); if(!p) return;
      if(TL.budSending[t.id]) return; TL.budSending[t.id]=1; b.disabled=true; // o poll repinta o cartão: a trava é da tarefa, não do botão
      try{ await resolvePending(p.id, b.dataset.tlbud); lastSig=''; refresh().catch(()=>{}); }catch(err){ showErr(err, 'Não consegui enviar a resposta'); }
      finally{ delete TL.budSending[t.id]; const bd=$id('tlBudget'); if(bd){ bd.__html=''; } } }; }
  tlWatchWidth(t.id, wrap);
  tlAskPaint(t, false, grab);
  if(typeof tiWire==='function') tiWire(t); // terminal integrado: dock (sugestões, anexar, botões → comando)
}
function tlSideClick(taskId, e){
  if(typeof tiSideClick==='function' && tiSideClick(taskId, e)) return; // prova/entregável → aba Documento ou app padrão
  const lb=e.target.closest('[data-tllb]'); if(lb){ try{ const [names, i]=JSON.parse(lb.dataset.tllb); if(typeof lbOpen==='function') lbOpen(taskId, names, i); }catch(_){ } return; }
  const b=e.target.closest('[data-tl]'); if(!b) return; tlSideAct(taskId, b.dataset.tl, b);
}
async function tlSideAct(taskId, k, btn){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  if(k==='fold'){ if(TL.narrow[taskId]) TL.peek[taskId]=false; else tlSetFolded(taskId, true); tlSidePaint(t, true); return; }
  if(k==='unfold'){ if(TL.narrow[taskId]) TL.peek[taskId]=!TL.peek[taskId]; else tlSetFolded(taskId, false); tlSidePaint(t, true); const tg=document.querySelector('#tlSide [data-tl="fold"]'); if(tg) tg.focus(); return; }
  if(k==='askproof'){ if(typeof proofAsk==='function') await proofAsk(t, btn); return; }
  if(k==='noproof'){ if(typeof approveNoProof==='function') await approveNoProof(t); return; }
  if(k==='approve'){ if(typeof approveGate==='function') await approveGate(t); return; }
  if(k==='pr'){ if(typeof fwSetMode==='function') fwSetMode('pr'); }
}
function tlSidePaint(t, force){
  const side=$id('tlSide'); if(!side || !side.isConnected) return;
  const h=tlSideHtml(t); if(!force && side.__html===h) return;
  side.__html=h; side.innerHTML=h;
}
// largura da coluna: abaixo de TL_NARROW o painel vira faixa (canvas com 2–3 tarefas, janela estreita)
function tlWatchWidth(taskId, wrap){
  const apply=()=>{ const w=wrap.getBoundingClientRect().width; if(!w) return;
    { const h=TL.sheets[taskId], col=wrap.querySelector('.tlcol'); if(h && col && h.parentNode===col) tlSheetPlace(col, h); } const n=w<TL_NARROW; if(!!TL.narrow[taskId]!==n){ TL.narrow[taskId]=n; if(!n) TL.peek[taskId]=false; const t=(state.tasks||[]).find(x=>x.id===taskId); if(t) tlSidePaint(t, true); } };
  if(TL.ro) TL.ro.disconnect();
  TL.ro=new ResizeObserver(()=>{ clearTimeout(TL.rt); TL.rt=setTimeout(apply, 80); });
  TL.ro.observe(wrap); TL.roFor=taskId;
  apply();
}
/** Poll (fwLiveUpdate): repinta só o que mudou — barra, painel e folha. */
function tlLivePaint(t){
  if(!termViewOf(t)) return;
  const bud=$id('tlBudget'); if(bud){ const h=tlBudgetHtml(t); if(bud.__html!==h){ bud.__html=h; bud.innerHTML=h; } }
  const bar=$id('tlBar'); if(bar){ const h=tlBarHtml(t); if(bar.__html!==h){ bar.__html=h; bar.innerHTML=h; } }
  tlSidePaint(t);
  tlAskPaint(t);
  if(typeof tiLivePaint==='function') tiLivePaint(t);
}

// ---------------------------------------------------------------- folha de pergunta
function tlAskOf(t){ const g=tlAskGroup(pendingOf(t.id)); if(!g) return null; let st=TL.ask[g.key]; if(!st || st.sel.length!==g.rows.length) st=TL.ask[g.key]=tlAskNew(g); return { g, st }; }
function tlSheetEl(taskId){ let el=TL.sheets[taskId]; if(!el){ el=document.createElement('div'); el.className='tlsheethost'; TL.sheets[taskId]=el; tlSheetWire(taskId, el); } return el; }
/** Antes de o renderWorkspace refazer a coluna: onde estava o foco da folha (o host sai do DOM e perde o foco). */
function tlSheetFocusGrab(taskId){ const el=TL.sheets[taskId]; const ae=document.activeElement; if(!el || !ae || !el.contains(ae)) return null; return { other:ae.matches('[data-tl="other"]'), caret:ae.selectionStart!=null?ae.selectionStart:null }; }
function tlAskPaint(t, focus, grab){
  const slot=document.querySelector(`[data-tlwrap="${CSS.escape(t.id)}"] .tlcol`);
  const a=tlAskOf(t);
  const host=TL.sheets[t.id];
  // o "pergunta aberta" do agente sem folha (escondida) → pílula pra reabrir
  if(!a || !slot){ if(host){ host.remove(); host.__html=''; } return; }
  const el=tlSheetEl(t.id);
  const hadFocus=!!grab || el.contains(document.activeElement); const inOther=grab?grab.other:(hadFocus && document.activeElement.matches('[data-tl="other"]'));
  const caret=grab?grab.caret:(inOther?document.activeElement.selectionStart:null);
  const fresh=el.parentNode!==slot;
  if(fresh) slot.appendChild(el);
  tlSheetPlace(slot, el);
  const html=a.st.min ? `<button type="button" class="tlpill" data-tl="askmax"><span class="tldot" style="--c:var(--st-ask)"></span>${esc(a.g.agent||'O agente')} está esperando sua resposta · <b>responder</b></button>` : tlSheetHtml(a.g, a.st);
  if(el.__html!==html){ el.__html=html; el.innerHTML=html; }
  el.classList.toggle('min', !!a.st.min);
  // foco: quem estava na folha continua nela; pergunta NOVA só pega o foco se você não estava digitando noutro lugar
  const ae=document.activeElement; const idle=!ae || ae===document.body || (TERM[t.id] && TERM[t.id].host.contains(ae));
  if(hadFocus || focus || (fresh && idle && !a.st.min)) tlAskFocus(el, inOther, caret);
}
// a folha sobe do topo do compositor; sem espaço (pane pequeno do canvas) ela cobre o compositor também
function tlSheetPlace(col, el){
  const comp=col.querySelector(':scope > .fwinput'), dock=col.querySelector(':scope > .tidock'); const ch=(comp?comp.offsetHeight:0)+(dock?dock.offsetHeight:0); const H=col.clientHeight; // compositor escondido = 0
  const room=H-ch; const tight=room<320;
  el.style.bottom=(tight?8:ch+12)+'px';
  el.classList.toggle('tight', H<300 || room<200);
}
function tlAskFocus(el, inOther, caret){
  requestAnimationFrame(()=>{
    if(inOther){ const i=el.querySelector('[data-tl="other"]'); if(i){ i.focus({ preventScroll:true }); if(caret!=null) try{ i.setSelectionRange(caret, caret); }catch(_){ } return; } }
    const b=el.querySelector('.tlopt.cur')||el.querySelector('.tlopt.sel')||el.querySelector('.tlopt')||el.querySelector('[data-tl="other"]')||el.querySelector('.tlpill');
    if(b) b.focus({ preventScroll:true });
  });
}
function tlSheetWire(taskId, el){
  const cur=()=>{ const t=(state.tasks||[]).find(x=>x.id===taskId); return t?Object.assign({ t }, tlAskOf(t)||{}):null; };
  const repaint=(focus)=>{ const c=cur(); if(c&&c.t) tlAskPaint(c.t, focus); };
  el.addEventListener('click', (e)=>{
    const c=cur(); if(!c || !c.g) return; const { g, st }=c;
    const q=e.target.closest('[data-tlq]'); if(q){ st.q=+q.dataset.tlq; repaint(true); return; }
    const o=e.target.closest('[data-tlopt]'); if(o){ const k=+o.dataset.tlopt; const r=g.rows[st.q]; st.other[st.q]=''; st.skip[st.q]=false; st.cursor=k;
      if(r.multi){ const s=st.sel[st.q]; const i=s.indexOf(k); if(i>=0) s.splice(i,1); else s.push(k); } else st.sel[st.q]=[k]; repaint(true); return; }
    const b=e.target.closest('[data-tl]'); if(!b) return;
    const k=b.dataset.tl;
    if(k==='askmin'){ st.min=true; repaint(); tlFocusTerm(taskId); return; }
    if(k==='askmax'){ st.min=false; repaint(true); return; }
    if(k==='askskip'){ st.skip[st.q]=true; st.other[st.q]=''; if(st.q<g.rows.length-1){ st.q++; repaint(true); } else tlAskSend(taskId); return; }
    if(k==='asknext'){ if(st.q<g.rows.length-1){ st.q++; repaint(true); } else tlAskSend(taskId); return; }
    if(k==='askterm'){ tlAskSend(taskId, true); return; }
  });
  el.addEventListener('input', (e)=>{ const i=e.target.closest('[data-tl="other"]'); if(!i) return; const c=cur(); if(!c||!c.g) return; c.st.other[c.st.q]=i.value; if(i.value) c.st.skip[c.st.q]=false;
    el.querySelectorAll('.tlopt').forEach(b=>{ const on=!i.value && c.st.sel[c.st.q].includes(+b.dataset.tlopt); b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); }); });
  el.addEventListener('keydown', (e)=>{
    const c=cur(); if(!c || !c.g || c.st.min) return;
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    const inInput=!!e.target.closest('[data-tl="other"]');
    // Enter num botão (pular, responder no terminal…) é o clique dele
    if(e.key==='Enter' && e.target.closest('button[data-tl]')) return;
    { const fo=e.target.closest('[data-tlopt]'); if(fo) c.st.cursor=+fo.dataset.tlopt; } // Espaço/setas partem da opção com foco
    const r=tlAskKey(c.g, c.st, e.key, inInput);
    if(r.pass) return;
    e.preventDefault(); e.stopPropagation();
    Object.assign(c.st, r.st);
    if(r.act==='close'){ c.st.min=true; repaint(); tlFocusTerm(taskId); return; }
    if(r.act==='send'){ tlAskSend(taskId); return; }
    repaint(true);
  });
}
function tlFocusTerm(taskId){ const s=TERM[taskId]; if(s && s.term) try{ s.term.focus(); }catch(_){ } }
/** Grava as respostas (uma por pergunta). AskUserQuestion: o hook espera TODAS e devolve ao Claude Code de uma vez. */
async function tlAskSend(taskId, inTerminal){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  const a=tlAskOf(t); if(!a || a.st.sending) return;
  const answers=inTerminal ? a.g.rows.map(()=>TL_IN_TERMINAL) : tlAskAnswers(a.g, a.st);
  a.st.sending=true; tlAskPaint(t);
  try{
    // uma por pergunta; se cair no meio, a nova tentativa manda só as que faltam (o estado da folha fica)
    for(let i=0;i<a.g.rows.length;i++){ const r=a.g.rows[i]; if(a.st.sent[r.id]) continue; if(typeof fwAskSent!=='undefined') fwAskSent[r.ck]=answers[i]; await invoke('resolve_pending', { id:r.id, answer:answers[i] }); a.st.sent[r.id]=1; }
    // some na hora (o snapshot confirma depois): o terminal volta a ser o que você vê
    state.pending=(state.pending||[]).filter(p=>!a.g.rows.some(r=>r.id===p.id));
    delete TL.ask[a.g.key];
    tlAskPaint(t); tlFocusTerm(taskId);
    toast(inTerminal?'responda no terminal — o Claude mostra a pergunta lá':'respostas enviadas — o agente continua', 'ok');
    lastSig=''; refresh().catch(()=>{});
  }catch(e){ a.st.sending=false; tlAskPaint(t, true); showErr(e, 'Não consegui enviar a resposta'); }
}
/** Compositor com pergunta aberta: o texto vira "outra resposta" da pergunta da vez (e envia se for a última). */
function tlAskFromComposer(t, text){
  const a=tlAskOf(t); if(!a) return false;
  a.st.other[a.st.q]=text; a.st.skip[a.st.q]=false; a.st.min=false;
  if(a.st.q<a.g.rows.length-1){ a.st.q++; tlAskPaint(t, true); toast('anotei como resposta — falta '+(a.g.rows.length-a.st.q===1?'1 pergunta':(a.g.rows.length-a.st.q)+' perguntas'),'info'); }
  else tlAskSend(t.id);
  return true;
}

// ---------------------------------------------------------------- painel baixo (canvas em grade/empilhado)
// O compositor vira UMA linha (anexo · campo · ⋯ · enviar): o seletor de IA e o "vira requisito" continuam sendo os
// MESMOS controles (escondidos pelo CSS) — este menu só os aciona, nada de segundo estado.
function tlCompMoreOpen(t, anchor){
  const old=$id('fwCompPop'); if(old){ old.remove(); anchor.setAttribute('aria-expanded','false'); return; }
  const pill=$id('fwModel'), req=$id('fwAsReq');
  const pop=document.createElement('div'); pop.id='fwCompPop'; pop.className='fwmenu'; pop.setAttribute('role','menu');
  pop.innerHTML=(pill?`<button class="fwmi" role="menuitem" data-cm="ia"><span>IA desta tarefa</span><span class="fwmh">${esc((pill.textContent||'').trim())}</span></button>`:'')+
    (req?`<button class="fwmi" role="menuitemcheckbox" aria-checked="${req.checked}" data-cm="req"><span>${req.checked?'✓ ':''}vira requisito</span><span class="fwmh">a mensagem entra como requisito com prova</span></button>`:'');
  document.body.appendChild(pop); anchor.setAttribute('aria-expanded','true');
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.max(8, r.top-pop.offsetHeight-6)+'px'; pop.style.left=Math.max(8, Math.min(window.innerWidth-pop.offsetWidth-8, r.right-pop.offsetWidth))+'px';
  const close=(back)=>{ pop.remove(); anchor.setAttribute('aria-expanded','false'); document.removeEventListener('mousedown', out, true); if(back) try{ anchor.focus(); }catch(_){ } };
  const out=e=>{ if(!pop.contains(e.target) && !anchor.contains(e.target)) close(false); };
  setTimeout(()=>document.addEventListener('mousedown', out, true), 0);
  pop.onclick=(e)=>{ const b=e.target.closest('[data-cm]'); if(!b) return; close(false);
    if(b.dataset.cm==='ia' && typeof openModelMenu==='function') openModelMenu(t.id, anchor); // ancora no ⋯ (a pílula está escondida)
    if(b.dataset.cm==='req' && req){ req.checked=!req.checked; req.dispatchEvent(new Event('change')); anchor.classList.toggle('on', req.checked); const i=$id('fwInput'); if(i) i.focus(); } };
  if(typeof a11yMenu==='function') a11yMenu(pop, anchor, close); else { const b=pop.querySelector('button'); if(b) b.focus(); }
}
