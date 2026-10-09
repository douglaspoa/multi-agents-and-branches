// Starfork — 72-entregas-dia: ENTREGAS POR DIA (mesa 09/10 D5 · tela 4 do mock aprovado). É um MODO da aba Entregas
// (70: entregasHtml — a mesma no Time e na Central), não aba nova: "por épico | por dia", lembrado por pessoa.
// Barras dos dias do período (seg–sex; sáb/dom só se houve entrega) clicáveis; o dia escolhido lista o que foi
// INTEGRADO (PR mergeado): título, a corrente (issue · épico · PR · N provas), quem, requisitos x/y e miniaturas das
// provas publicadas; cabeçalho "N entregues · pessoas: …" e "copiar resumo do dia" (texto puro pt-BR).
// "Entregue" = CARIMBO REAL (veto da mesa: nunca updated_at): o evento task_activity kind='status' cujo body é o
// rótulo de 'merged' (stLabel, escrito pelo sync do 42) — buscado em LOTE pro período (uma query por até 80 cartões) —
// ou o finishedAt da tarefa desta máquina. Sem carimbo → fora das barras, contado em "N sem data". Concluída sem PR
// entra no dia com o selo "sem PR" e fica fora da contagem das barras.

// @puro-dia-inicio (testado em app/tests/entregas-dia.test.mjs — usa modMs/modTs/periodHas do 08-periodo)
const DIA_SEM=['dom','seg','ter','qua','qui','sex','sáb'];
function diaPad(n){ return String(n).padStart(2,'0'); }
function diaKey(ms){ const d=new Date(ms); return d.getFullYear()+'-'+diaPad(d.getMonth()+1)+'-'+diaPad(d.getDate()); }
function diaRotulo(ms){ const d=new Date(ms); return DIA_SEM[d.getDay()]+' '+diaPad(d.getDate())+'/'+diaPad(d.getMonth()+1); }
function diaFimDeSemana(ms){ const w=new Date(ms).getDay(); return w===0 || w===6; }
// eventos de status (task_activity kind='status') → { task_id: { merged:ms, done:ms } } — o carimbo MAIS RECENTE de cada
// rot = { merged:[rótulos de 'merged'], done:[rótulos de 'done'] } (o rótulo do STATUS_META e o id cru, por garantia)
function diaCarimbos(acts, rot){
  const m={}, isM=new Set(rot.merged||[]), isD=new Set(rot.done||[]);
  (acts||[]).forEach(a=>{
    if(!a || a.kind && a.kind!=='status' || !a.task_id) return;
    const b=String(a.body||'').trim(), k=isM.has(b)?'merged':isD.has(b)?'done':''; if(!k) return;
    const ms=modMs(a.at); if(!ms) return;
    const x=m[a.task_id]||(m[a.task_id]={ merged:0, done:0 }); if(ms>x[k]) x[k]=ms;
  });
  return m;
}
// a entrega de um cartão: { ts, tipo:'pr'|'sempr' } ou null (não entregue). ts=0 = sem carimbo (NUNCA updated_at).
// 'pr' = INTEGRADA (status merged) — conta nas barras; concluída/encerrada sem merge (com ou sem PR aberto) = 'sempr'
// k = { delivered(t), st(t) → status efetivo, carimbos, localTs(t) → finishedAt da tarefa desta máquina (ou 0) }
function diaEntrega(t, k){
  if(!t || !k.delivered(t)) return null;
  const st=k.st(t), c=(k.carimbos||{})[t.id]||{};
  let ts=st==='merged'?(c.merged||0):(c.done||c.merged||0);
  if(!ts && k.localTs) ts=k.localTs(t)||0;
  return { ts, tipo:st==='merged'?'pr':'sempr' };
}
// dias do período: seg–sex sempre; sáb/dom só com entrega (com = Set de diaKey que têm item). Período enorme: os
// 400 dias MAIS RECENTES (conta de trás pra frente — os de hoje nunca somem)
function diaDias(r, com){
  const out=[]; const e=new Date(r.to-1); let d=new Date(e.getFullYear(), e.getMonth(), e.getDate());
  for(let i=0; d.getTime()>=r.from-3600000 && d.getTime()<r.to && i<400; i++){
    const ms=d.getTime(); if(!diaFimDeSemana(ms) || com.has(diaKey(ms))) out.push(ms);
    d=new Date(d.getFullYear(), d.getMonth(), d.getDate()-1);
  }
  return out.reverse();
}
// itens = [{ t, ts, tipo, mod }] → { dias:[{ key, ms, rotulo, n (só com PR), sempr, itens }], semData, total, max }
// sem carimbo conta em "sem data" só se o item mexeu no período (senão toda entrega antiga sem evento contaria sempre)
function diaAgrupa(itens, r){
  const by={}; let semData=0, total=0;
  (itens||[]).forEach(x=>{
    if(!x.ts){ if(periodHas(r, x.mod)) semData++; return; }
    if(!periodHas(r, x.ts)) return;
    (by[diaKey(x.ts)]=by[diaKey(x.ts)]||[]).push(x);
  });
  const dias=diaDias(r, new Set(Object.keys(by))).map(ms=>{
    const key=diaKey(ms), it=(by[key]||[]).slice().sort((a,b)=>(b.mod||b.ts)-(a.mod||a.ts));
    const n=it.filter(x=>x.tipo==='pr').length; total+=n;
    return { key, ms, rotulo:diaRotulo(ms), n, sempr:it.length-n, itens:it };
  });
  return { dias, semData, total, max:Math.max(0, ...dias.map(d=>d.n)) };
}
// "copiar resumo do dia" — texto puro: `Entregas de sex 09/10 · 5` + `• título — pessoa — PR #93 — FND-103 — requisitos 3/3`
// o número do título = as INTEGRADAS (o mesmo da barra); concluída sem merge vai na lista marcada "sem PR"/"sem merge"
// linha(x) → { titulo, pessoa, pr:'93'|'', issue:'FND-103'|'', reqs:{ ok, tot }|null, sempr }
function diaResumo(dia, linha){
  const ls=(dia.itens||[]).map(x=>{ const l=linha(x);
    const p=[String(l.titulo||'tarefa').replace(/\s+/g,' ').trim(), l.pessoa||'Sem dono'];
    if(l.sempr) p.push(l.pr?'PR #'+l.pr+' (sem merge)':'sem PR'); else if(l.pr) p.push('PR #'+l.pr);
    if(l.issue) p.push(l.issue);
    if(l.reqs) p.push('requisitos '+l.reqs.ok+'/'+l.reqs.tot);
    return '• '+p.join(' — '); });
  const n=dia.n!=null?dia.n:ls.length;
  return 'Entregas de '+dia.rotulo+' · '+n+(ls.length?'\n'+ls.join('\n'):'');
}
// dia aberto: o escolhido (se ainda está na lista); senão o mais recente com entrega; senão o último do período
function diaEscolhe(dias, sel){
  if(sel && dias.some(d=>d.key===sel)) return sel;
  const c=dias.slice().reverse().find(d=>d.itens.length);
  return c?c.key:(dias.length?dias[dias.length-1].key:'');
}
// filtro de pessoa do modo por dia: quem ENTREGOU (responsável, senão quem criou); '-' = sem responsável
function diaFiltraQuem(list, who){
  if(!who) return list||[];
  return (list||[]).filter(t=>who==='-'?!t.assignee:(t.assignee||t.created_by)===who);
}
// @puro-dia-fim

// ---- carimbos de entrega: UM lote por período + conjunto de cartões entregues (sem laço) ----
let diaSt={ key:'', rows:null, busy:false, err:false, errAt:0, p:null };
let diaSel=''; // dia aberto: memória da sessão
function diaRotulos(){ return { merged:[stLabel('merged'),'merged'], done:[stLabel('done'),'done'] }; }
function diaIso(ms){ return encodeURIComponent(new Date(ms).toISOString()); }
function diaStampsLoad(ids, r){
  const key=r.from+'|'+r.to+'|'+Math.floor((+teamFetchedAt||0)/60000)+'|'+ids.slice().sort().join(',');
  if(diaSt.key===key && (diaSt.rows || diaSt.busy || (diaSt.err && Date.now()-diaSt.errAt<30000))) return diaSt.p||Promise.resolve();
  if(!ids.length){ diaSt={ key, rows:[], busy:false, p:Promise.resolve() }; return diaSt.p; }
  const lote=(list, comData)=>{ const ch=[]; for(let i=0;i<list.length;i+=80) ch.push(list.slice(i, i+80));
    return Promise.all(ch.map(c=>entGetTudo('task_activity?select=task_id,kind,body,at&kind=eq.status'+(comData?'&at=gte.'+diaIso(r.from)+'&at=lt.'+diaIso(r.to):'')+'&task_id=in.('+c.map(i=>'"'+i+'"').join(',')+')&order=at.desc,id.desc'))).then(rs=>[].concat(...rs)); };
  // 1º lote: os eventos DO PERÍODO; 2º (só os que ficaram sem carimbo): o evento de qualquer data — quem foi integrada
  // ANTES do período e mexeu dentro dele tem data (fica fora), não vira "sem data"
  const p=lote(ids, true).then(async rows=>{
    const tem=new Set(rows.filter(x=>diaRotulos().merged.concat(diaRotulos().done).includes(String(x.body||'').trim())).map(x=>x.task_id));
    const falta=ids.filter(id=>!tem.has(id));
    return falta.length?rows.concat(await lote(falta, false)):rows; })
    .then(rows=>{ if(diaSt.key!==key) return; diaSt={ key, rows, busy:false, p:null }; entRepaint(); })
    .catch(e=>{ if(diaSt.key!==key) return; diaSt={ key, rows:null, busy:false, err:true, errAt:Date.now(), p:null }; console.warn('carimbos de entrega', e&&e.message||e); entRepaint(); });
  diaSt={ key, rows:null, busy:true, p };
  return p;
}
// tarefa desta máquina já concluída: o finishedAt dela (nunca a data de modificação)
function diaLocalTs(t){
  const l=(typeof chainCtx==='function')?chainCtx().local(t.id):null;
  return l && ['merged','done'].includes(l.status)?modMs(l.finishedAt||l.finished_at):0;
}
// os itens entregues da lista (já filtrada por pessoa/épico) com o carimbo e a modificação
function diaItensDe(list){
  const car=diaCarimbos([...(teamActivity||[]).filter(a=>a.kind==='status'), ...(diaSt.rows||[])], diaRotulos());
  const k={ carimbos:car, delivered:ENT_FN.delivered, st:t=>tsSt(t), localTs:diaLocalTs };
  return (list||[]).map(t=>{ const e=diaEntrega(t, k); return e?{ t, ts:e.ts, tipo:e.tipo, mod:modTs(ENT_FN.mod(t), e.ts) }:null; }).filter(Boolean);
}
function diaQuem(t){ return t.assignee||t.created_by||null; }
function diaLinha(x){
  const t=x.t, c=chainOfNow(t);
  return { titulo:t.title, pessoa:diaQuem(t)?personName(diaQuem(t),{ noYou:true }):'Sem dono', pr:(c&&c.pr&&c.pr.num)||'', issue:(c&&c.issue&&c.issue.code)||'', reqs:entReqs(t), sempr:x.tipo==='sempr' };
}

// ---- miniaturas das provas: as linhas já vieram no lote do 70 (entProvas.arts); URLs assinadas em LOTE ----
const diaUrl={}; // storage_path → { u, at }
let diaThumbsP=null; // o lote em voo (o relatório espera por ele)
function diaImgs(tid){ return ((entProvas.arts||{})[tid]||[]).filter(a=>a.kind==='image'||/\.(png|jpe?g|gif|webp)$/i.test(a.name||'')); }
function diaThumbsLoad(paths){
  const now=Date.now(), need=[...new Set(paths)].filter(p=>{ const c=diaUrl[p]; return !c || (now-c.at>50*60000); }).slice(0, 100);
  if(!need.length) return diaThumbsP||Promise.resolve();
  need.forEach(p=>{ diaUrl[p]={ u:(diaUrl[p]&&diaUrl[p].u)||'', at:now, busy:true }; });
  const pr=diaThumbsP=sbFetch('/storage/v1/object/sign/artifacts', { method:'POST', body:JSON.stringify({ expiresIn:3600, paths:need }) })
    .then(rows=>{ (Array.isArray(rows)?rows:[]).forEach(r=>{ const u=r&&(r.signedURL||r.signedUrl); if(r&&r.path) diaUrl[r.path]={ u:u&&!r.error?SB.url()+'/storage/v1'+u:'', at:Date.now() }; });
      need.forEach(p=>{ if(diaUrl[p].busy) diaUrl[p]={ u:'', at:Date.now() }; }); entRepaint(); })
    .catch(e=>{ need.forEach(p=>{ diaUrl[p]={ u:'', at:Date.now() }; }); console.warn('miniaturas das provas', e&&e.message||e); })
    .finally(()=>{ if(diaThumbsP===pr) diaThumbsP=null; });
  return pr;
}
function diaThumbsHtml(t){
  const im=diaImgs(t.id).slice(0, 3); if(!im.length) return '';
  return `<span class="ed-th">${im.map(a=>{ const u=(diaUrl[a.storage_path]||{}).u; artThumbSet(t.id, a, u);
    return `<button type="button" class="ed-tb" data-entct="${escA(t.id)}" title="${escA('prova: '+a.name)}">${u?`<img src="${escA(u)}" alt="" loading="lazy">`:`<span class="ed-ph">${icEm(IC.image)}</span>`}</button>`; }).join('')}</span>`;
}
function artThumbSet(tid, a, u){ try{ if(u && typeof artThumbCache!=='undefined') artThumbCache[tid+'|'+a.name]=u; }catch(_){ } }

function diaItemHtml(x){
  const t=x.t, who=diaQuem(t), rq=entReqs(t), np=entProvas.m?(entProvas.m[t.id]||0):0;
  const c=chainOfNow(t, { proofs:()=>np||null });
  const meta=[rq?`requisitos ${rq.ok}/${rq.tot}`:'', np?nPl(np,'prova','provas'):''].filter(Boolean).join(' · ');
  return `<div class="ed-item" role="listitem">
    <div class="ed-main"><button type="button" class="en-title" data-entct="${escA(t.id)}" title="abrir a entrega">${esc(t.title||'tarefa')}</button>
      <div class="chain">${x.tipo==='sempr'?`<span class="ed-sempr" title="concluída sem merge — fora da contagem das barras">${t.pr_url?'sem merge':'sem PR'}</span>`:''}${chainHtml(c, { omit:['task'], arrows:false })}</div></div>
    <div class="ed-who">${who?personChip(who):'<span class="en-none">Sem dono</span>'}${meta?`<small>${esc(meta)}</small>`:''}</div>
    ${diaThumbsHtml(t)}
  </div>`;
}
// o corpo do modo "por dia" (a barra de filtros é a do 70)
function diaHtml(list, r){
  const ent=list.filter(ENT_FN.delivered);
  diaStampsLoad(ent.map(t=>t.id), r);
  if(!diaSt.rows && diaSt.busy) return skeletonHtml('lista',{ n:4, label:'carregando as entregas do período' });
  const itens=diaItensDe(list), g=diaAgrupa(itens, r);
  const note=diaSt.err?'<div class="en-note" role="status">não consegui ler as datas de entrega agora — tento de novo</div>':'';
  if(!g.dias.length) return note+emptyHtml({ icon:'kanban', title:'Nenhum dia no período', help:'Escolha outro período.' });
  diaSel=diaEscolhe(g.dias, diaSel);
  const dia=g.dias.find(d=>d.key===diaSel)||g.dias[g.dias.length-1];
  diaThumbsLoad([].concat(...dia.itens.map(x=>diaImgs(x.t.id).slice(0,3).map(a=>a.storage_path))));
  const pess=[...new Set(g.dias.flatMap(d=>d.itens.filter(x=>x.tipo==='pr').map(x=>diaQuem(x.t))).filter(Boolean))];
  const semPr=g.dias.reduce((s,d)=>s+d.sempr,0);
  const head=`<div class="ed-sum"><span><b>${g.total}</b> ${g.total===1?'entrega integrada':'entregas integradas'} · ${esc(periodLabel(entPer()).toLowerCase())}</span>${pess.length?`<span>${nPl(pess.length,'pessoa','pessoas')}</span>`:''}${semPr?`<span class="dim" title="concluídas sem merge (sem PR ou com o PR não integrado): aparecem no dia, fora da contagem das barras">${nPl(semPr,'concluída sem PR','concluídas sem PR')}</span>`:''}${g.semData?`<span class="dim" title="entregues que mexeram no período mas não têm carimbo de entrega (evento de status ou conclusão nesta máquina) — fora das barras">${g.semData} sem data</span>`:''}</div>`;
  const H=56;
  const bars=`<div class="ed-week${g.dias.length>12?' dense':''}" role="group" aria-label="entregas por dia">${g.dias.map(d=>{ const h=g.max?Math.round(d.n/g.max*(H-6))+6:6, on=d.key===dia.key;
    return `<button type="button" class="ed-bar${on?' on':''}${d.n?'':' zero'}" data-edday="${escA(d.key)}" aria-pressed="${on}" title="${escA(d.rotulo+' · '+nPl(d.n,'entrega','entregas')+(d.sempr?' · '+d.sempr+' sem PR':''))}"><span class="ed-n">${d.n||''}</span><i style="height:${h}px"></i><span class="ed-lb">${esc(d.rotulo.slice(0,3))}<b>${esc(d.rotulo.slice(4,6))}</b></span></button>`; }).join('')}</div>`;
  const dp=[...new Set(dia.itens.filter(x=>x.tipo==='pr').map(x=>diaQuem(x.t)).filter(Boolean))];
  const day=`<section class="ed-day" aria-label="${escA('entregas de '+dia.rotulo)}"><header class="ed-dh"><h3>${esc(dia.rotulo)}</h3><span><b>${dia.n}</b> ${dia.n===1?'entregue':'entregues'}${dia.sempr?` · ${dia.sempr} sem PR`:''}</span>${dp.length?`<span class="ed-pp">pessoas: ${esc(dp.map(u=>personShort(u,{ noYou:true })).join(', '))}</span>`:''}<span class="grow"></span>${dia.itens.length?`<button type="button" class="btn sm" data-edcopy="${escA(dia.key)}">copiar resumo do dia</button>`:''}</header>
    <div class="ed-list" role="list">${dia.itens.length?dia.itens.map(diaItemHtml).join(''):'<div class="ed-empty">nada entregue neste dia</div>'}</div></section>`;
  return note+head+bars+day;
}
function diaWire(el, list){
  el.querySelectorAll('[data-edday]').forEach(b=>{ b.onclick=()=>{ diaSel=b.dataset.edday; entRepaint(); }; });
  el.querySelectorAll('[data-edcopy]').forEach(b=>{ b.onclick=async()=>{
    try{
      const itens=diaItensDe(list), g=diaAgrupa(itens, periodRange(entPer())), d=g.dias.find(x=>x.key===b.dataset.edcopy); if(!d) return;
      await personEnsure(d.itens.map(x=>diaQuem(x.t)).filter(Boolean));
      await cloudCopy(diaResumo(d, diaLinha), b);
    }catch(e){ showErr(e, 'Não consegui copiar o resumo'); } }; });
}
window.diaHtml=diaHtml; window.diaWire=diaWire;
