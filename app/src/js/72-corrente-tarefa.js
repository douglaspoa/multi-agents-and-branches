// Starfork — 72-corrente-tarefa: a CORRENTE no cabeçalho de toda tarefa + LINHA DO TEMPO unificada (mesa 09/10, D4).
// Cabeçalho (tarefa desta máquina e página da tarefa do colega):
//   linha 1 — veio de [issue] [épico] · com [pessoa] · vai pra [PR] [situação]
//   linha 2 — requisitos x de y provados · criada por [pessoa] · no painel: "FND-103 está “Em revisão” — atualizado pelo Starfork há 2 min"
// Linha do tempo: o que coordena e prova a tarefa, de três fontes, cada evento dizendo a sua: Starfork (esta máquina),
// time (task_activity da nuvem: criou, mandou, atribuiu, assumiu, devolveu, iniciou, PR aberto, status) e painel (o que o
// Starfork mudou no tracker). NÃO inventa histórico do tracker (veto da mesa). Mostra 8 e "ver tudo".
// Chips: chainHtml/personChip (08) — os mesmos do painel de Issues e das Entregas.

// @puro-tcorrente-inicio (testado em app/tests/corrente-tarefa.test.mjs)
// a = linha de task_activity · nm(uid) → nome (personName) · stMerged = rótulo de 'merged' (STATUS_META)
function tcActText(a, nm){
  const w0=nm(a.user_id), who=w0==='você'?'Você':w0, b=String(a.body||'').trim(); // começo de frase
  switch(a.kind){
    case 'created': return { text:who+' criou o cartão', src:'time' };
    case 'assigned': return { text:b?who+' atribuiu pra '+nm(b):who+' atribuiu o responsável', src:'time' };
    case 'claimed': return { text:who+' assumiu', src:'time' };
    case 'released': return { text:who+' devolveu'+(b?' — '+b.slice(0,120):'')+' · ficou livre', src:'time' };
    case 'started': return { text:who+' iniciou'+(b?' ('+b.slice(0,60)+')':''), src:'time' };
    case 'delivered': return { text:/PR aberto/i.test(b)?who+' abriu o PR':who+' publicou provas', src:'time' };
    case 'edited': return { text:who+' editou o cartão'+(b?' — '+b.slice(0,100):''), src:'time' };
    case 'comment': return { text:who+' comentou'+(b?': '+b.slice(0,140):''), src:'time' };
    case 'status': return / no painel$/.test(b)?{ text:b.replace(/ no painel$/,'')+' no painel (pelo Starfork)', src:'painel' }:{ text:b?who+' — ficou “'+b+'”':who+' mudou a situação', src:'time' };
    default: return { text:who+' registrou um evento', src:'time' };
  }
}
// o = { act:[task_activity], local:{ createdAt, finishedAt, status }, me, sync:{ code, label, at }, nm }
// → eventos em ordem cronológica (o mais antigo primeiro, como no mock), sem repetir o que a nuvem já registrou
function tcTimeline(o){
  const ms=v=>{ const n=typeof v==='number'?v:Date.parse(v||''); return n>0?(n<1e12?n*1000:n):0; };
  const out=[], nm=o.nm||(u=>String(u||'')), act=o.act||[];
  act.forEach(a=>{ const at=ms(a.at); if(!at) return; const x=tcActText(a, nm); out.push({ at, text:x.text, src:x.src }); });
  const L=o.local;
  if(L){
    if(!act.some(a=>a.kind==='created') && ms(L.createdAt)) out.push({ at:ms(L.createdAt), text:'tarefa criada nesta máquina', src:'starfork' });
    if(ms(L.finishedAt) && ['merged','done'].includes(L.status) && !act.some(a=>a.kind==='status' && !/ no painel$/.test(String(a.body||'')) && ms(a.at)>=ms(L.finishedAt)-60000))
      out.push({ at:ms(L.finishedAt), text:L.status==='merged'?'integrada (PR mergeado)':'concluída', src:'starfork' });
  }
  if(o.sync && ms(o.sync.at) && !act.some(a=>a.kind==='status' && String(a.body||'').startsWith(o.sync.code+' →') && Math.abs(ms(a.at)-ms(o.sync.at))<120000))
    out.push({ at:ms(o.sync.at), text:o.sync.code+' → “'+o.sync.label+'” no painel (pelo Starfork)', src:'painel' });
  return out.sort((a,b)=>a.at-b.at);
}
// requisitos provados: lista de requisitos + provas (mesma leitura do resto do app: status 'done')
function tcReqs(reqs, proofs){
  const R=(reqs||[]).filter(Boolean); if(!R.length) return null;
  const ok=(proofs||[]).filter(p=>p&&p.status==='done').length;
  return { ok:Math.min(ok, R.length), tot:R.length };
}
// "no painel": o status que o tracker MOSTRA agora (+ se foi o Starfork que pôs) ou o motivo de não ter posto
// i = issue lida do painel · lb = rótulo do status · log = trkSyncLog[code] · err = trkSyncErr[code] · ago(ms) → "há X"
function tcPainelText(code, i, lb, log, err, ago){
  if(!code || !i) return null;
  if(err){ const why=String(err.why||'o painel recusou'); return { warn:true, tip:why, text:code+' não foi pra “'+(err.label||'?')+'”: '+(why.length>60?why.slice(0,58)+'…':why) }; }
  return { warn:false, tip:'', text:code+' está “'+lb+'”'+(log&&log.to===i.status?' — atualizado pelo Starfork '+ago(log.at):'') };
}
// as 8 MAIS RECENTES (em ordem) + "ver tudo (N)"; key separa a tarefa local da página do colega
function tcTimelineHtmlOf(ev, all, key, E, fmt){
  if(!ev.length) return '<div class="en-empty">sem eventos registrados ainda</div>';
  const N=8, show=all?ev:ev.slice(-N);
  return `<ol class="tc-tl">${show.map(e=>`<li class="src-${e.src}"><time datetime="${E(new Date(e.at).toISOString())}">${E(fmt(e.at))}</time><i aria-hidden="true"></i><span>${E(e.text)}</span><small>${E(({ starfork:'Starfork', time:'time', painel:'painel' })[e.src]||e.src)}</small></li>`).join('')}</ol>`
    +(ev.length>N?`<button class="btn sm ghost" data-tcall="${E(key)}" aria-expanded="${all?'true':'false'}">${all?'ver só as 8 mais recentes':'ver tudo ('+ev.length+')'}</button>`:'');
}
// @puro-tcorrente-fim

// atividade do cartão de uma tarefa DESTA máquina: um lote por abertura (e de novo quando o time recarrega) — nunca por render
const tcActCache={};
function tcActLoad(cid){
  if(!cid) return null;
  if(!(typeof SB!=='undefined'&&SB.sess())) return []; // sem conta: só os eventos desta máquina (nunca "carregando" pra sempre)
  const c=tcActCache[cid], stamp=Math.floor(Date.now()/120000)+':'+Math.floor((+((typeof teamFetchedAt!=='undefined'&&teamFetchedAt)||0))/60000);
  if(c && (c.busy || c.stamp===stamp)) return c.rows;
  tcActCache[cid]={ rows:c?c.rows:null, busy:true, stamp };
  sbGet('task_activity?select=user_id,kind,body,at&task_id=eq.'+encodeURIComponent(cid)+'&order=id.asc&limit=120').then(rows=>{
    tcActCache[cid]={ rows:rows||[], busy:false, stamp }; tcRepaint();
  }).catch(()=>{ tcActCache[cid]={ rows:c&&c.rows?c.rows:[], busy:false, stamp }; tcRepaint(); });
  return c?c.rows:null;
}
function tcRepaint(){ try{ if(typeof fwTask!=='undefined' && fwTask && typeof fwMode!=='undefined' && fwMode==='entrega' && typeof renderWorkspace==='function' && typeof fwVisible==='function' && fwVisible()) renderWorkspace(); }catch(_){ } }
// o que o painel diz da issue agora (status lido do tracker) + o que o Starfork mudou lá
function tcPainelHtml(code){
  if(!code || typeof trkIssues==='undefined') return '';
  const i=(trkIssues||[]).find(x=>x.code===code); if(!i) return '';
  const st=(typeof trkStatus==='function'&&trkStatus(i.status))||null;
  const r=tcPainelText(code, i, st?(st.label||st.id):String(i.status||''), (typeof trkSyncLog==='function'?trkSyncLog():{})[code], (typeof trkSyncErr!=='undefined'&&trkSyncErr[code])||null, modAgoTx);
  return r?`<span class="tc-pn${r.warn?' warn':''}"${r.tip?` title="${escA(r.tip)}"`:''}>${esc(r.text)}</span>`:'';
}
// x = tarefa local OU cartão; o = { card, act, proofs, reqs }
function tcHeaderHtml(x, o){
  o=o||{}; if(!x) return '';
  const c=chainOfNow(x, o.proofs!=null?{ proofs:()=>o.proofs }:{});
  if(!c) return '';
  const me=(typeof cloudUserId==='function'&&cloudUserId())||'', card=o.card||(chainIsCard(x)?x:null);
  const stk=chainIsCard(x)?(typeof tsSt==='function'?tsSt(x):x.status):taskSt(x);
  const who=c.who?personChip(c.who,{ short:true }):card?`<span class="pchip free"><span class="tsav tmfree" aria-hidden="true">·</span><span class="pnm">livre</span></span>`:'<span class="pchip"><span class="pnm">você (nesta máquina)</span></span>';
  const veio=chainHtml(c,{ omit:['task','pr','proof'], arrows:false });
  const vai=chainHtml(c,{ omit:['issue','epic','task'], arrows:false, st:{ label:stLabel(stk), color:stColor(stk) } }); // PR · provas · situação
  const rq=o.reqs, by=c.createdBy||(card?null:me);
  const painel=c.issue&&c.issue.code?tcPainelHtml(c.issue.code):'';
  return `<div class="tchain" role="group" aria-label="de onde veio e pra onde vai">
    <div class="tc-l"><span class="tc-lbl">veio de</span>${veio||'<span class="dim">pedido direto (sem issue nem épico)</span>'}<span class="tc-lbl">com</span>${who}<span class="tc-lbl">vai pra</span>${c.pr?'':'<span class="dim">ainda sem PR</span>'}${vai}</div>
    <div class="tc-l tc-s">${rq?`<span class="tc-lbl">requisitos</span><span class="tc-v${rq.ok===rq.tot?' ok':''}">${rq.ok} de ${rq.tot} provados</span>`:''}${by?`<span class="tc-lbl">criada por</span>${personChip(by,{ short:true })}`:''}${painel?`<span class="tc-lbl">no painel</span>${painel}`:''}</div>
  </div>`;
}
function tcFmt(ms){ const d=new Date(ms), y=d.getFullYear()!==new Date().getFullYear(); return d.toLocaleString('pt-BR', Object.assign({ day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }, y?{ year:'numeric' }:{})); }
const tcAllOpen=new Set(); // "ver tudo" por tela+tarefa (l:<id> local · c:<id> colega)
function tcTimelineHtml(ev, key){ return tcTimelineHtmlOf(ev, tcAllOpen.has(key), key, s=>escA(String(s)), tcFmt); }
// ---- tarefa desta máquina: cabeçalho (#fwChain) com assinatura (não redesenha à toa) ----
let tcSig='';
// withAct: só a linha do tempo busca a atividade (o cabeçalho não dispara rede)
function tcLocalCtx(t, withAct){
  const cid=((typeof tmap==='function'?tmap():{})||{})[t.id]||'';
  const card=cid?(((typeof teamTasks!=='undefined'&&teamTasks)||[]).find(c=>c.id===cid)||null):null;
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  const rp=(typeof reqProofCache!=='undefined'&&reqProofCache[t.id]);
  if(reqs.length && rp===undefined && typeof fwReqProofsEnsure==='function') fwReqProofsEnsure(t.id); // as provas chegam e repintam
  const m=rp&&rp.list&&typeof matchReqProofs==='function'?matchReqProofs(reqs, rp.list):null;
  return { cid, card, act:withAct&&cid?tcActLoad(cid):[], reqs:rp===undefined?null:tcReqs(reqs, m||[]) };
}
function tcSyncOf(code){ const s=code&&typeof trkSyncLog==='function'?trkSyncLog()[code]:null; return s?{ code, label:s.label, at:s.at }:null; }
function tcEventsLocal(t, ctx){
  const code=(chainOfNow(t).issue||{}).code||'';
  return tcTimeline({ act:ctx.act||[], local:{ createdAt:t.createdAt, finishedAt:t.finishedAt, status:t.status }, sync:tcSyncOf(code), nm:u=>personName(u) });
}
function tcPaint(t){
  const host=$id('fwChain'); if(!host) return;
  if(!t){ host.hidden=true; tcSig=''; return; }
  const ctx=tcLocalCtx(t, false), html=tcHeaderHtml(t, { card:ctx.card, reqs:ctx.reqs });
  host.hidden=!html;
  if(html===tcSig) return; tcSig=html; host.innerHTML=html;
}
// seção "Linha do tempo" da Entrega (27): a unificada; as Etapas (stageStepper) continuam embaixo
function tcLocalTimelineSec(t){
  const ctx=tcLocalCtx(t, true);
  return `<section class="en-sec tc-sec" style="margin-top:6px"><div class="seclbl2">Linha do tempo <span class="dim">· Starfork, time e painel</span></div>${ctx.cid&&ctx.act==null?skeletonHtml('lista',{ n:3, compact:true, inline:true, label:'carregando a atividade do time' }):tcTimelineHtml(tcEventsLocal(t, ctx), 'l:'+t.id)}</section>`;
}
// página do colega (45): a MESMA linha do tempo (time + o que o Starfork mudou no painel)
function tcCardTimelineHtml(ct, act){ const code=(chainOfNow(ct).issue||{}).code||''; return tcTimelineHtml(tcTimeline({ act:act||[], sync:tcSyncOf(code), nm:u=>personName(u) }), 'c:'+ct.id); }
document.addEventListener('click', e=>{ const b=e.target&&e.target.closest&&e.target.closest('[data-tcall]'); if(!b) return; const k=b.dataset.tcall;
  if(tcAllOpen.has(k)) tcAllOpen.delete(k); else tcAllOpen.add(k);
  try{ if(k.startsWith('l:') && typeof renderWorkspace==='function') renderWorkspace(); else if(typeof ctPageRender==='function') ctPageRender(); }catch(_){ } });
window.tcHeaderHtml=tcHeaderHtml; window.tcPaint=tcPaint; window.tcTimeline=tcTimeline; window.tcTimelineHtml=tcTimelineHtml; window.tcLocalTimelineSec=tcLocalTimelineSec; window.tcCardTimelineHtml=tcCardTimelineHtml;
