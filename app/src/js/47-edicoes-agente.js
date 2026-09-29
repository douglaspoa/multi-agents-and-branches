// Starfork — 47-edicoes-agente: o agente muda a SPEC de outras tarefas e do épico quando a ideia muda
// (tools mcp__cardume__edit_task / edit_epic, src/agent-edits.ts). Aqui o app:
//  - aplica na NUVEM o que o motor não consegue (épico e cartões do time): lê a fila
//    .cardume/agent-edits/ (Rust agent_edits_pending), aplica pela sessão, anota o desfecho (agent_edits_done).
//    Idempotente: o id da edição fica em epics.spec.history / tasks.spec.agentEdits e não aplica 2x;
//  - mostra o RASTRO: evento "spec-edit" na conversa da tarefa editada (antes → depois + desfazer) e o
//    histórico na página do épico (com desfazer pra quem pode editar o épico);
//  - avisa (toast) quando um agente mudou uma tarefa ou o épico.
const AE_MAX_HIST=30;
const AE_FIELD_PT={ title:'título', objective:'objetivo', requirements:'requisitos', deliverables:'entregáveis', owns:'escopo (owns)', off:'áreas proibidas (off)', description:'descrição', outcome:'outcome', doneWhen:'pronto quando' };
const aeClone=o=>JSON.parse(JSON.stringify(o||{}));
const aeTxt=s=>String(s==null?'':s).replace(/\s+/g,' ').trim();
const aeNorm=s=>aeTxt(s).toLowerCase();
// próximo id livre de uma lista {id:'D3'} / {id:'R2'}
function aeNextId(list, pre){ const n=(list||[]).reduce((m,x)=>{ const k=new RegExp('^'+pre+'(\\d+)$','i').exec(String((x&&x.id)||'')); return Math.max(m, k?+k[1]:0); },0); return pre+(n+1); }

// PURA: aplica uma edição PENDENTE do agente no spec do épico → { spec, outcome:'applied'|'duplicate'|'unchanged'|'refused', msg }
function aeApplyEpic(spec, entry, nowIso){
  const sp=aeClone(spec), ops=(entry&&entry.epic)||{}, by=(entry&&entry.by)||{};
  const hist=Array.isArray(sp.history)?sp.history:[];
  if(hist.some(h=>h&&h.editId===entry.id)) return { spec, outcome:'duplicate', msg:'já aplicada' };
  const changes=[], refused=[];
  for(const f of ['description','outcome']){
    if(typeof ops[f]!=='string') continue;
    const before=String(sp[f]||''); if(aeTxt(ops[f])===aeTxt(before)) continue;
    changes.push({ field:f, before, after:ops[f] }); sp[f]=ops[f];
  }
  if(Array.isArray(ops.doneWhenRemove)&&ops.doneWhenRemove.length){
    const dw=Array.isArray(sp.doneWhen)?sp.doneWhen.map(d=>({ ...d })):[];
    for(const raw of ops.doneWhenRemove){ const id=String(raw).toUpperCase();
      const i=dw.findIndex((d,k)=>String(d.id||('D'+(k+1))).toUpperCase()===id);
      if(i<0){ refused.push(id+' não existe'); continue; }
      if(dw[i].checkedBy){ refused.push(id+' já foi marcado — não sai'); continue; }
      changes.push({ field:'doneWhen', op:'remove', item:dw[i], index:i }); dw.splice(i,1);
    }
    sp.doneWhen=dw;
  }
  if(Array.isArray(ops.doneWhenAdd)&&ops.doneWhenAdd.length){
    const dw=Array.isArray(sp.doneWhen)?sp.doneWhen.map(d=>({ ...d })):[];
    for(const txt of ops.doneWhenAdd){ if(!aeTxt(txt)||dw.some(d=>aeNorm(d.text)===aeNorm(txt))) continue;
      const item={ id:aeNextId(dw,'D'), text:aeTxt(txt) }; dw.push(item); changes.push({ field:'doneWhen', op:'add', item }); }
    sp.doneWhen=dw;
  }
  if(Array.isArray(ops.reqAdd)&&ops.reqAdd.length){
    const rq=Array.isArray(sp.requirements)?sp.requirements.map(r=>({ ...r })):[];
    for(const txt of ops.reqAdd){ if(!aeTxt(txt)||rq.some(r=>aeNorm(r.text)===aeNorm(txt))) continue;
      const item={ id:aeNextId(rq,'R'), text:aeTxt(txt) }; rq.push(item); changes.push({ field:'requirements', op:'add', item }); }
    sp.requirements=rq;
  }
  if(!changes.length) return { spec, outcome:refused.length?'refused':'unchanged', msg:refused.join('; ')||'nada mudou' };
  // "pronto quando" ganhou item em aberto → um épico concluído deixa de estar pronto (quem aplica reabre o status)
  sp.history=[...hist, { editId:entry.id, at:entry.at||nowIso, by:by.agent||'agente', byTask:by.taskTitle||by.taskId||'', note:aeTxt(entry.note||ops.note||''), changes, refused }].slice(-AE_MAX_HIST);
  return { spec:sp, outcome:'applied', msg:refused.join('; ') };
}

// PURA: desfaz uma mudança do histórico do épico, SÓ se o campo ainda está como a mudança deixou
function aeUndoEpic(spec, editId, who, nowIso){
  const sp=aeClone(spec); const hist=Array.isArray(sp.history)?sp.history:[];
  const h=hist.find(x=>x&&x.editId===editId);
  if(!h) return { ok:false, msg:'mudança não encontrada no histórico' };
  if(h.undone) return { ok:false, msg:'essa mudança já foi desfeita' };
  for(const c of [...(h.changes||[])].reverse()){
    if(c.field==='description'||c.field==='outcome'){
      if(aeTxt(sp[c.field])!==aeTxt(c.after)) return { ok:false, msg:'a '+AE_FIELD_PT[c.field]+' mudou de novo depois — ajuste à mão' };
      sp[c.field]=c.before;
    } else if(c.field==='doneWhen'||c.field==='requirements'){
      const list=Array.isArray(sp[c.field])?sp[c.field].map(x=>({ ...x })):[];
      const i=list.findIndex(x=>String(x.id)===String(c.item&&c.item.id));
      if(c.op==='add'){ if(i>=0){ if(list[i].checkedBy) return { ok:false, msg:c.item.id+' já foi marcado — não dá pra desfazer' }; list.splice(i,1); } }
      else if(c.op==='remove'){ if(i>=0) return { ok:false, msg:c.item.id+' já voltou pro épico' }; list.splice(Math.min(c.index|0, list.length), 0, c.item); }
      sp[c.field]=list;
    }
  }
  h.undone={ at:nowIso, by:who||'você' };
  return { ok:true, spec:sp };
}

// PURA: aplica uma edição pendente no CARTÃO da nuvem (irmã no backlog do time) → { outcome, spec, title, changes, msg }
function aeApplyCard(card, entry, nowIso){
  if(!card) return { outcome:'gone', msg:'cartão não existe mais' };
  if(['merged','done'].includes(card.status)) return { outcome:'refused', msg:'a tarefa "'+card.title+'" já foi concluída/mergeada — a spec não muda mais' };
  if(entry.epicId && card.epic_id && card.epic_id!==entry.epicId) return { outcome:'refused', msg:'o cartão é de outro épico' };
  const sp=aeClone(card.spec), ops=(entry&&entry.task)||{}, by=(entry&&entry.by)||{};
  const edits=Array.isArray(sp.agentEdits)?sp.agentEdits:[];
  if(edits.some(e=>e&&e.id===entry.id)) return { outcome:'duplicate', msg:'já aplicada' };
  const changes=[]; let title=card.title;
  const setStr=(f,v)=>{ if(typeof v!=='string'||!aeTxt(v)) return; const before=String(f==='title'?(sp.title||card.title||''):(sp[f]||'')); if(aeTxt(v)===aeTxt(before)) return; changes.push({ field:f, before, after:aeTxt(v) }); sp[f]=aeTxt(v); if(f==='title') title=aeTxt(v); };
  setStr('title', ops.title); setStr('objective', ops.objective);
  const setList=(f,before,after,put)=>{ if(JSON.stringify(before)===JSON.stringify(after)) return; changes.push({ field:f, before, after }); put(after); };
  if((ops.reqAdd&&ops.reqAdd.length)||(ops.reqRemove&&ops.reqRemove.length)){
    const before=Array.isArray(sp.requirements)?[...sp.requirements]:[]; const drop=new Set((ops.reqRemove||[]).map(n=>(+n)-1));
    const kept=before.filter((_,k)=>!drop.has(k)); (ops.reqAdd||[]).map(aeTxt).filter(Boolean).forEach(r=>{ if(!kept.some(x=>aeNorm(x)===aeNorm(r))) kept.push(r); });
    setList('requirements', before, kept, x=>{ sp.requirements=x; });
  }
  if(Array.isArray(ops.deliverables)||(ops.delivAdd&&ops.delivAdd.length)){
    const before=Array.isArray(sp.deliverables)?[...sp.deliverables]:[]; const next=Array.isArray(ops.deliverables)?ops.deliverables.map(aeTxt).filter(Boolean):[...before];
    (ops.delivAdd||[]).map(aeTxt).filter(Boolean).forEach(d=>{ if(!next.some(x=>aeNorm(x)===aeNorm(d))) next.push(d); });
    setList('deliverables', before, next, x=>{ sp.deliverables=x; });
  }
  // cartão guarda owns/off como TEXTO ("src/a/**, src/b") — o planner/new_task leem assim
  const asList=v=>Array.isArray(v)?v:String(v||'').split(/[,\n]+/).map(x=>x.trim()).filter(Boolean);
  for(const f of ['owns','off']) if(Array.isArray(ops[f])){ const before=asList(sp[f]), after=ops[f].map(aeTxt).filter(Boolean); setList(f, before, after, x=>{ sp[f]=x.join(', ')||null; }); }
  if(!changes.length) return { outcome:'unchanged', msg:'nada mudou' };
  sp.agentEdits=[...edits, { id:entry.id, at:entry.at||nowIso, by:by.agent||'agente', byTask:by.taskId||'', byTitle:by.taskTitle||'', changes, note:aeTxt(ops.note||entry.note||''), delivered:'card' }].slice(-10);
  return { outcome:'applied', spec:sp, title, changes };
}

// ---- rastro na conversa da tarefa (evento type "spec-edit") ----
const AE_ID_RE=/\s*·\s*edição ([0-9a-f-]{36})\s*$/i;
function aeAgo(at){ const x=agoTx(at); return !x?'':x==='agora'?'agora':'há '+x; }
function aeFmtVal(v){ return Array.isArray(v)?(v.length?v.join(' · '):'(vazio)'):(String(v||'')||'(vazio)'); }
// PURA (com esc/escA/IC injetados): o card do evento — frase + antes/depois + desfazer
function aeEventHtml(t, e){
  const tx=String((e&&e.text)||''); const m=tx.match(AE_ID_RE); const id=m?m[1]:'';
  const rec=id?(((t&&t.spec&&t.spec.agentEdits)||[]).find(r=>r&&r.id===id)):null;
  const closed=t&&['merged','done'].includes(t.status);
  const rows=rec?(rec.changes||[]).map(c=>`<div class="ae-ch"><span class="ae-f">${esc(AE_FIELD_PT[c.field]||c.field)}</span><span class="ae-b" title="antes">${esc(aeFmtVal(c.before))}</span><span class="ae-arr">→</span><span class="ae-a" title="depois">${esc(aeFmtVal(c.after))}</span></div>`).join(''):'';
  const act=!rec?'':rec.undone?`<span class="ae-undone">desfeita${rec.undone.by?' por '+esc(rec.undone.by):''}</span>`
    :closed?'':`<button class="btn sm ghost" data-aeundo="${escA(id)}" data-aetask="${escA(t.id)}" title="volta a spec como estava antes desta edição">desfazer</button>`;
  return `<div class="ae-ev" role="note"><div class="ae-h"><span class="ae-ic">${IC.pencil||''}</span><span class="ae-tag">atualizado por agente</span><span class="ae-tx">${esc(tx.replace(AE_ID_RE,''))}</span></div>${rows?`<div class="ae-rows">${rows}</div>`:''}${act?`<div class="ae-act">${act}</div>`:''}</div>`;
}

// ---- histórico na página do épico ----
function aeEpicHistHtml(sp, can){
  const hist=(Array.isArray(sp&&sp.history)?sp.history:[]).slice(-8).reverse(); if(!hist.length) return '';
  const line=c=>c.op? `${c.op==='add'?'+':'−'} <span class="mono">${esc((c.item&&c.item.id)||'')}</span> ${esc((c.item&&c.item.text)||'')}`
    : `<span class="ae-b">${esc(aeFmtVal(c.before))}</span> <span class="ae-arr">→</span> <span class="ae-a">${esc(aeFmtVal(c.after))}</span>`;
  return `<div class="seclbl2" style="margin-top:14px">Mudanças no épico <span class="dim">· a ideia muda conforme se programa — quem mudou, o quê e por quê</span></div>`+
    hist.map(h=>`<div class="ae-ev${h.undone?' undone':''}"><div class="ae-h"><span class="ae-ic">${IC.pencil||''}</span><span class="ae-tag">${esc(h.by||'agente')}${h.byTask?' · tarefa '+esc(h.byTask):''}</span><span class="dim">${h.at?esc(aeAgo(h.at)):''}</span></div>
      <div class="ae-rows">${(h.changes||[]).map(c=>`<div class="ae-ch"><span class="ae-f">${esc(AE_FIELD_PT[c.field]||c.field)}</span><span>${line(c)}</span></div>`).join('')}</div>
      ${h.note?`<div class="ae-note">motivo: ${esc(h.note)}</div>`:''}${(h.refused||[]).length?`<div class="ae-note">não aplicado: ${esc(h.refused.join('; '))}</div>`:''}
      <div class="ae-act">${h.undone?`<span class="ae-undone">desfeita${h.undone.by?' por '+esc(h.undone.by):''}</span>`:can?`<button class="btn sm ghost" data-epundo="${escA(h.editId)}">desfazer</button>`:''}</div></div>`).join('');
}
// selo "atualizado por agente" no cabeçalho do épico (última mudança de agente nas últimas 24h, não desfeita)
function aeEpicBadge(sp){
  const h=(Array.isArray(sp&&sp.history)?sp.history:[]).filter(x=>x&&!x.undone).slice(-1)[0];
  if(!h||!h.at||Date.now()-new Date(h.at).getTime()>86400000) return '';
  return `<span class="ae-badge" title="${escA((h.by||'agente')+(h.note?' — '+h.note:''))}">${IC.pencil||''} atualizado por agente · ${esc(aeAgo(h.at))}</span>`;
}

async function aeEpicUndo(ep, editId){
  if(!await askYes('Desfazer esta mudança no épico?\n\nO campo volta como estava antes — só se ninguém mexeu nele depois.')) return;
  try{
    const f=(await sbGet('epics?select=id,spec,status&id=eq.'+ep.id))[0]; if(!f) throw new Error('o épico não existe mais');
    const r=aeUndoEpic(f.spec||{}, editId, (typeof tmName==='function'&&cloudUserId())?tmName(cloudUserId()):'você', new Date().toISOString());
    if(!r.ok){ toast(r.msg,'warn'); return; }
    await epicPatch({ ...ep, ...f }, { spec:r.spec });
    toast('Mudança desfeita','ok');
  }catch(e){ showErr(e, 'Não consegui desfazer a mudança'); }
}
window.aeEpicUndo=aeEpicUndo;

// desfazer na conversa da tarefa LOCAL (o motor restaura spec + TASK.yaml; rodando, o agente recebe no próximo turno)
document.addEventListener('click', async ev=>{
  const b=ev.target&&ev.target.closest&&ev.target.closest('[data-aeundo]'); if(!b) return;
  ev.preventDefault(); ev.stopPropagation();
  if(!await askYes('Desfazer a edição que o agente fez nesta tarefa?\n\nA spec volta como estava (só os campos que ninguém mudou depois).')) return;
  b.disabled=true;
  try{ const msg=await invoke('task_edit_cli',{ taskId:b.dataset.aetask, undo:b.dataset.aeundo }); toast(msg||'Edição desfeita','ok'); lastSig=''; await refresh(); }
  catch(e){ b.disabled=false; showErr(e, 'Não consegui desfazer'); }
}, true);

// ---- aplicador da fila (.cardume/agent-edits) ----
let aeBusy=false, aeSeenEv=-1;
const aeIsUuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s||''));
async function aeApplyOne(e){
  const now=new Date().toISOString(), by=(e.by||{});
  if(e.kind==='epic'){
    const f=(await sbGet('epics?select=id,name,spec,status&id=eq.'+e.target))[0];
    if(!f) return { outcome:'gone', msg:'épico não existe (ou é de outro time)' };
    const r=aeApplyEpic(f.spec||{}, e, now);
    if(r.outcome!=='applied') return r;
    const body={ spec:r.spec, updated_at:now };
    const dw=Array.isArray(r.spec.doneWhen)?r.spec.doneWhen:[];
    if(f.status==='done' && dw.some(d=>!d.checkedBy)) body.status='in-progress'; // ganhou critério em aberto: não está mais pronto
    await sbFetch('/rest/v1/epics?id=eq.'+f.id,{ method:'PATCH', body:JSON.stringify(body) });
    if(typeof epTab!=='undefined'&&epTab&&epTab.id===f.id){ await epicPageLoad(f.id); epicPageRender(); }
    toast((by.agent||'Um agente')+' atualizou o épico "'+(f.name||'')+'"'+(e.note?' — '+e.note:''),'info');
    return r;
  }
  // cartão: por id da nuvem, ou pelo local_id (irmã iniciada em outra máquina) dentro do mesmo épico
  const q=aeIsUuid(e.target)?'tasks?select=*&id=eq.'+e.target:'tasks?select=*&local_id=eq.'+encodeURIComponent(e.target)+(e.epicId?'&epic_id=eq.'+e.epicId:'');
  const card=((await sbGet(q))||[])[0];
  // a irmã começou NESTA máquina depois que o EPIC.md foi montado: edita a tarefa local (spec + TASK.yaml + fila do agente)
  const lid=card&&((state.tasks||[]).some(t=>t.id===card.local_id)?card.local_id:Object.keys(tmap()).find(k=>tmap()[k]===card.id));
  if(lid && (state.tasks||[]).some(t=>t.id===lid)){
    const msg=await invoke('task_edit_cli',{ taskId:lid, patch:JSON.stringify(e.task||{}), byAgent:by.agent||'agente', byTask:by.taskId||null });
    return { outcome:'applied', msg };
  }
  const r=aeApplyCard(card, e, now);
  if(r.outcome!=='applied') return r;
  await sbFetch('/rest/v1/tasks?id=eq.'+card.id,{ method:'PATCH', body:JSON.stringify({ spec:r.spec, title:r.title }) });
  teamTasks=null; if(typeof teamPaintSig!=='undefined') teamPaintSig='';
  toast((by.agent||'Um agente')+' atualizou a tarefa "'+r.title+'" do time','info');
  return r;
}
async function aeTick(){
  if(aeBusy || !(state.tasks||[]).length) return;
  aeBusy=true;
  try{
    // toast das edições LOCAIS novas (o evento já está na conversa da tarefa editada)
    const evs=(state.events||[]).filter(x=>(x.type||x.kind)==='spec-edit');
    const maxId=evs.reduce((m,x)=>Math.max(m,+x.id||0),0);
    if(aeSeenEv>=0) evs.filter(x=>+x.id>aeSeenEv).slice(-3).forEach(x=>{ const t=(state.tasks||[]).find(y=>y.id===(x.taskId||x.task_id));
      toast(String(x.text||'').replace(AE_ID_RE,'').slice(0,160), 'info', t?{ label:'abrir', fn:()=>openTaskById(t.id) }:undefined); });
    aeSeenEv=Math.max(aeSeenEv, maxId);
    if(!SB.sess() || !cloudTeamId()) return; // sem sessão: a fila espera (nada se perde)
    const pend=await invokeQuiet('agent_edits_pending').catch(()=>[]);
    for(const e of (pend||[]).slice(0,10)){
      let r;
      try{ r=await aeApplyOne(e); }
      catch(err){ console.warn('edição do agente não aplicada (tenta de novo)', e.id, err&&err.message||err); continue; }
      await invokeQuiet('agent_edits_done',{ id:e.id, outcome:r.outcome, msg:r.msg||'' }).catch(()=>{});
      if(r.outcome==='refused') toast('Edição de '+((e.by||{}).agent||'agente')+' recusada: '+r.msg,'warn');
    }
  }finally{ aeBusy=false; }
}
tickLoop('agentEdits', aeTick, 10000, 4000);
