// Starfork — 47-edicoes-agente: o agente muda a SPEC de outras tarefas e do épico quando a ideia muda
// (tools mcp__cardume__edit_task / edit_epic, src/agent-edits.ts). Aqui o app:
//  - aplica na NUVEM o que o motor não consegue (épico e cartões do time): lê a fila
//    .cardume/agent-edits/ (Rust agent_edits_pending), RE-VALIDA cada linha (mesmas regras do motor), aplica
//    pela sessão com trava otimista (updated_at) e anota o desfecho (agent_edits_done). Idempotente: o id da
//    edição fica em epics.spec.history / tasks.spec.agentEditIds;
//  - REGRA DE PRODUTO: acrescentar/reescrever vale na hora; REMOVER requisito/item do "pronto quando" (ou
//    estreitar owns/off) vira PROPOSTA com aprovar/recusar pro humano;
//  - mostra o RASTRO: evento "spec-edit"/"spec-proposal" na conversa (resumo + antes/depois sob demanda +
//    desfazer), histórico e propostas na página do épico;
//  - avisa (toast) quando um agente mudou uma tarefa ou o épico, e quando a edição foi recusada.
const AE_MAX_HIST=30;
const AE_LIM={ title:140, objective:2000, item:300, items:30, path:200, note:300, description:2000 };
const AE_FIELD_PT={ title:'título', objective:'objetivo', requirements:'requisitos', deliverables:'entregáveis', owns:'escopo (owns)', off:'áreas proibidas (off)', description:'descrição', outcome:'outcome', doneWhen:'pronto quando', epicDoneWhen:'pronto quando (cópia local)' };
// segredos: MESMA lista do motor (src/memory.ts SECRET_RES) — nunca vão pra spec
const AE_SECRET_RES=[
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH)[A-Z0-9_]*[ \t]*=[ \t]*["']?[^\s"']{8,}/m,
  /\b(api[_-]?key|secret|token|password|senha|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
];
const aeClone=o=>JSON.parse(JSON.stringify(o||{}));
const aeTxt=s=>String(s==null?'':s).replace(/\s+/g,' ').trim();
const aeNorm=s=>aeTxt(s).toLowerCase();
const aeIsUuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s||''));
const aeStrArr=v=>Array.isArray(v)&&v.every(x=>typeof x==='string');
const aeEnc=s=>encodeURIComponent(String(s==null?'':s));

// ---- validação (espelha validateTaskEdit/validateEpicEdit do motor): a fila é um arquivo, então NADA passa sem checar ----
function aeCheckTexts(pairs){
  for(const [label,v,max] of pairs){
    const vals=Array.isArray(v)?v:v===undefined?[]:[v];
    if(Array.isArray(v)&&v.length>AE_LIM.items) return label+': no máximo '+AE_LIM.items+' itens';
    for(const x of vals){ const s=aeTxt(x);
      if(s.length>max) return label+' longo demais (máx. '+max+' caracteres)';
      if(AE_SECRET_RES.some(re=>re.test(s))) return label+' parece conter um segredo — não gravo isso na spec'; }
  }
  return null;
}
// PURA: devolve a recusa (pt-BR) ou null
function aeValidate(e){
  if(!e||typeof e!=='object') return 'linha inválida na fila';
  const by=e.by||{};
  if(typeof by.agent!=='string'||!aeTxt(by.agent)) return 'edição sem autor';
  if(by.role && !['planner','builder'].includes(by.role)) return 'o papel '+by.role+' não muda spec';
  const note=aeTxt(e.note||((e.epic||e.task||{}).note)||'');
  if(!note) return 'edição sem o porquê (note)';
  if(e.kind==='epic'){
    if(!aeIsUuid(e.target)) return 'id de épico inválido';
    const o=e.epic; if(!o||typeof o!=='object') return 'edição de épico vazia';
    for(const k of ['description','outcome']) if(o[k]!==undefined&&typeof o[k]!=='string') return k+' precisa ser texto';
    for(const k of ['doneWhenAdd','doneWhenRemove','reqAdd']) if(o[k]!==undefined&&!aeStrArr(o[k])) return k+' precisa ser lista de textos';
    for(const id of (o.doneWhenRemove||[])) if(!/^D\d+$/i.test(aeTxt(id))) return 'id inválido no "pronto quando": '+id;
    if(o.description===undefined&&o.outcome===undefined&&!(o.doneWhenAdd||[]).length&&!(o.doneWhenRemove||[]).length&&!(o.reqAdd||[]).length) return 'nada a mudar';
    return aeCheckTexts([['descrição',o.description,AE_LIM.description],['outcome',o.outcome,AE_LIM.description],['pronto quando',o.doneWhenAdd,AE_LIM.item],['requisito',o.reqAdd,AE_LIM.item],['motivo',note,AE_LIM.note]]);
  }
  if(e.kind==='card'){
    if(!(aeIsUuid(e.target)||/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(e.target||'')))) return 'id de tarefa inválido';
    if(!aeIsUuid(e.epicId)) return 'edição de cartão sem épico — só irmãs do mesmo épico';
    const o=e.task; if(!o||typeof o!=='object') return 'edição de tarefa vazia';
    for(const k of ['title','objective']) if(o[k]!==undefined&&typeof o[k]!=='string') return k+' precisa ser texto';
    for(const k of ['reqAdd','reqRemove','deliverables','delivAdd','owns','off']) if(o[k]!==undefined&&!aeStrArr(o[k])) return k+' precisa ser lista de textos';
    if(o.title!==undefined&&!aeTxt(o.title)) return 'título vazio';
    if(o.objective!==undefined&&!aeTxt(o.objective)) return 'objetivo vazio';
    return aeCheckTexts([['título',o.title,AE_LIM.title],['objetivo',o.objective,AE_LIM.objective],['requisito',o.reqAdd,AE_LIM.item],['requisito',o.reqRemove,AE_LIM.item],
      ['entregável',o.deliverables,AE_LIM.item],['entregável',o.delivAdd,AE_LIM.item],['owns',o.owns,AE_LIM.path],['off',o.off,AE_LIM.path],['motivo',note,AE_LIM.note]]);
  }
  return 'tipo de edição desconhecido';
}

// ---- ids do "pronto quando": max+1 sobre a lista ORIGINAL + tudo que já passou pelo histórico (id removido não volta) ----
function aeMaxD(xs){ return (xs||[]).reduce((m,x)=>{ const k=/^D(\d+)/i.exec(typeof x==='string'?x:String((x&&x.id)||'')); return Math.max(m, k?+k[1]:0); },0); }
// PURA: mesma regra do motor (src/agent-edits.ts nextDoneId)
function aeNextDoneId(sp){
  const hist=(Array.isArray(sp.history)?sp.history:[]).flatMap(h=>(h.changes||[]).map(c=>c.item).filter(Boolean));
  return Math.max(aeMaxD(sp.doneWhen), aeMaxD(hist), +sp.doneWhenSeq||0)+1;
}
function aeNextReqId(list){ return 'R'+((list||[]).reduce((m,x)=>{ const k=/^R(\d+)$/i.exec(String((x&&x.id)||'')); return Math.max(m,k?+k[1]:0); },0)+1); }
// lista "Dn: texto" que as cópias locais (TASK.yaml) usam
function aeDoneWhenLines(sp){ return (Array.isArray(sp.doneWhen)?sp.doneWhen:[]).map((d,k)=>(d.id||('D'+(k+1)))+': '+(d.text||'')); }

// PURA: aplica uma edição PENDENTE no spec do épico → { spec, status, outcome:'applied'|'proposed'|'duplicate'|'unchanged'|'refused', msg }
function aeApplyEpic(spec, entry, nowIso, status){
  const sp=aeClone(spec), ops=(entry&&entry.epic)||{}, by=(entry&&entry.by)||{};
  const hist=Array.isArray(sp.history)?sp.history:[];
  if(hist.some(h=>h&&h.editId===entry.id) || (Array.isArray(sp.proposals)&&sp.proposals.some(p=>p&&p.id===entry.id))) return { spec, status, outcome:'duplicate', msg:'já aplicada' };
  const changes=[], refused=[]; let st=status;
  for(const f of ['description','outcome']){
    if(typeof ops[f]!=='string') continue;
    const before=String(sp[f]||''); if(aeTxt(ops[f])===aeTxt(before)) continue;
    changes.push({ field:f, before, after:aeTxt(ops[f]) }); sp[f]=aeTxt(ops[f]);
  }
  if(Array.isArray(ops.doneWhenAdd)&&ops.doneWhenAdd.length){
    const dw=Array.isArray(sp.doneWhen)?sp.doneWhen.map(d=>({ ...d })):[];
    let n=aeNextDoneId(sp); // ids calculados sobre a lista ORIGINAL, antes de qualquer mudança
    for(const txt of ops.doneWhenAdd){ if(!aeTxt(txt)||dw.some(d=>aeNorm(d.text)===aeNorm(txt))) continue;
      const item={ id:'D'+(n++), text:aeTxt(txt) }; dw.push(item); changes.push({ field:'doneWhen', op:'add', item }); }
    sp.doneWhen=dw; sp.doneWhenSeq=Math.max(+sp.doneWhenSeq||0, n-1);
  }
  if(Array.isArray(ops.reqAdd)&&ops.reqAdd.length){
    const rq=Array.isArray(sp.requirements)?sp.requirements.map(r=>({ ...r })):[];
    for(const txt of ops.reqAdd){ if(!aeTxt(txt)||rq.some(r=>aeNorm(r.text)===aeNorm(txt))) continue;
      const item={ id:aeNextReqId(rq), text:aeTxt(txt) }; rq.push(item); changes.push({ field:'requirements', op:'add', item }); }
    sp.requirements=rq;
  }
  // remoção = PROPOSTA (item já marcado nem vira proposta: "proposta recusada: já marcado")
  let proposal=null;
  if(Array.isArray(ops.doneWhenRemove)&&ops.doneWhenRemove.length){
    const dw=Array.isArray(sp.doneWhen)?sp.doneWhen:[]; const ids=[];
    for(const raw of ops.doneWhenRemove){ const id=String(raw).toUpperCase(); const d=dw.find((x,k)=>String(x.id||('D'+(k+1))).toUpperCase()===id);
      if(!d){ refused.push(id+' não existe'); continue; }
      if(d.checkedBy){ refused.push('proposta recusada: '+id+' já marcado'); continue; }
      ids.push(id); }
    if(ids.length){ proposal={ id:entry.id, at:entry.at||nowIso, by:by.agent||'agente', byTask:by.taskTitle||by.taskId||'', note:aeTxt(entry.note||ops.note||''), remove:{ doneWhen:ids }, status:'open' };
      sp.proposals=[...(Array.isArray(sp.proposals)?sp.proposals:[]), proposal].slice(-AE_MAX_HIST); }
  }
  if(!changes.length && !proposal) return { spec, status, outcome:refused.length?'refused':'unchanged', msg:refused.join('; ')||'nada mudou' };
  if(changes.length){
    // ganhou critério em aberto: um épico concluído deixa de estar pronto (e o desfazer volta o status)
    if(st==='done' && (sp.doneWhen||[]).some(d=>!d.checkedBy)) st='in-progress';
    const h={ editId:entry.id, at:entry.at||nowIso, by:by.agent||'agente', byTask:by.taskTitle||by.taskId||'', note:aeTxt(entry.note||ops.note||''), changes, refused };
    if(st!==status){ h.statusBefore=status; h.statusAfter=st; }
    sp.history=[...hist, h].slice(-AE_MAX_HIST);
  }
  return { spec:sp, status:st, outcome:changes.length?'applied':'proposed', msg:[proposal?'remoção virou proposta':'', ...refused].filter(Boolean).join('; ') };
}

// PURA: quem cuida do épico decide uma proposta de remoção → { ok, spec, status, msg }
function aeDecideEpic(spec, pid, approve, who, nowIso, status){
  const sp=aeClone(spec); const props=Array.isArray(sp.proposals)?sp.proposals:[];
  const p=props.find(x=>x&&x.id===pid);
  if(!p) return { ok:false, msg:'proposta não encontrada' };
  if(p.status!=='open') return { ok:false, msg:'essa proposta já foi '+(p.status==='approved'?'aprovada':'recusada') };
  if(!approve){ p.status='rejected'; p.decided={ at:nowIso, by:who }; return { ok:true, spec:sp, status, msg:'proposta recusada' }; }
  const dw=Array.isArray(sp.doneWhen)?sp.doneWhen.map(d=>({ ...d })):[]; const changes=[], skipped=[];
  for(const id of ((p.remove||{}).doneWhen||[])){
    const i=dw.findIndex((d,k)=>String(d.id||('D'+(k+1))).toUpperCase()===String(id).toUpperCase());
    if(i<0) continue;
    if(dw[i].checkedBy){ skipped.push(id); continue; }
    changes.push({ field:'doneWhen', op:'remove', item:dw[i], index:i }); dw.splice(i,1);
  }
  if(!changes.length){ p.status='rejected'; p.decided={ at:nowIso, by:who, msg:skipped.length?'proposta recusada: '+skipped.join(', ')+' já marcado':'os itens já não existem' };
    return { ok:true, spec:sp, status, msg:p.decided.msg }; }
  sp.doneWhen=dw; sp.doneWhenSeq=Math.max(+sp.doneWhenSeq||0, aeMaxD(changes.map(c=>c.item)));
  let st=status; if(dw.length && dw.every(d=>d.checkedBy)) st='done'; // tirar o último item aberto fecha o épico (mesma regra do checklist)
  p.status='approved'; p.decided={ at:nowIso, by:who, msg:skipped.length?skipped.join(', ')+' já marcado — ficou':'' };
  const h={ editId:'p:'+p.id, at:nowIso, by:p.by, byTask:p.byTask, note:p.note, changes, approvedBy:who, refused:skipped.map(x=>x+' já marcado') };
  if(st!==status){ h.statusBefore=status; h.statusAfter=st; }
  sp.history=[...(Array.isArray(sp.history)?sp.history:[]), h].slice(-AE_MAX_HIST);
  return { ok:true, spec:sp, status:st, msg:'proposta aprovada' };
}

// PURA: desfaz uma mudança do histórico do épico, SÓ se o campo ainda está como a mudança deixou → { ok, spec, status }
function aeUndoEpic(spec, editId, who, nowIso, status){
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
  let st=status;
  if(h.statusAfter && status===h.statusAfter) st=h.statusBefore; // volta o status que a mudança trocou
  else { const dw=sp.doneWhen||[]; if(st==='done' && dw.some(d=>!d.checkedBy)) st='in-progress'; }
  h.undone={ at:nowIso, by:who||'você' };
  return { ok:true, spec:sp, status:st };
}

// guardas do cartão da nuvem: mesmo ÉPICO (null não vale) e mesmo PROJETO; fechado não muda
function aeCardGuard(card, entry, ctx){
  if(!card) return 'cartão não existe mais';
  if(!card.epic_id || card.epic_id!==entry.epicId) return 'o cartão não é do mesmo épico';
  if(ctx&&ctx.projectId && card.project_id && card.project_id!==ctx.projectId) return 'o cartão é de outro projeto';
  if(['merged','done'].includes(card.status)) return 'a tarefa "'+card.title+'" já foi concluída/mergeada — a spec não muda mais';
  return null;
}
const aeAsList=v=>Array.isArray(v)?v.map(aeTxt).filter(Boolean):String(v||'').split(/[,\n]+/).map(x=>x.trim()).filter(Boolean);
// PURA: aplica uma edição pendente no CARTÃO da nuvem → { outcome, spec, title, changes, proposal, cloudOnly, msg }
function aeApplyCard(card, entry, nowIso, ctx){
  const g=aeCardGuard(card, entry, ctx); if(g) return { outcome:card?'refused':'gone', msg:g };
  const sp=aeClone(card.spec), ops=(entry&&entry.task)||{}, by=(entry&&entry.by)||{};
  if((sp.agentEditIds||[]).includes(entry.id)) return { outcome:'duplicate', msg:'já aplicada' };
  const changes=[]; let title=card.title;
  const setStr=(f,v)=>{ if(typeof v!=='string'||!aeTxt(v)) return; const before=String(f==='title'?(sp.title||card.title||''):(sp[f]||'')); if(aeTxt(v)===aeTxt(before)) return; changes.push({ field:f, before, after:aeTxt(v) }); sp[f]=aeTxt(v); if(f==='title') title=aeTxt(v); };
  setStr('title', ops.title); setStr('objective', ops.objective);
  const setList=(f,before,after,put)=>{ if(JSON.stringify(before)===JSON.stringify(after)) return; changes.push({ field:f, before, after }); put(after); };
  const reqs=Array.isArray(sp.requirements)?[...sp.requirements]:[];
  if((ops.reqAdd||[]).length){ const next=[...reqs]; ops.reqAdd.map(aeTxt).filter(Boolean).forEach(r=>{ if(!next.some(x=>aeNorm(x)===aeNorm(r))) next.push(r); }); setList('requirements', reqs, next, x=>{ sp.requirements=x; }); }
  if(Array.isArray(ops.deliverables)||(ops.delivAdd||[]).length){
    const before=Array.isArray(sp.deliverables)?[...sp.deliverables]:[]; const next=Array.isArray(ops.deliverables)?ops.deliverables.map(aeTxt).filter(Boolean):[...before];
    (ops.delivAdd||[]).map(aeTxt).filter(Boolean).forEach(d=>{ if(!next.some(x=>aeNorm(x)===aeNorm(d))) next.push(d); });
    setList('deliverables', before, next, x=>{ sp.deliverables=x; });
  }
  // remoções → proposta; o cartão guarda owns/off como TEXTO ("src/a/**, src/b")
  const remove={};
  const rr=reqs.filter(r=>(ops.reqRemove||[]).some(x=>aeNorm(x)===aeNorm(r))); if(rr.length) remove.requirements=rr;
  for(const f of ['owns','off']) if(Array.isArray(ops[f])){ const cur=aeAsList(sp[f]), want=ops[f].map(aeTxt).filter(Boolean);
    const add=want.filter(x=>!cur.includes(x)), out=cur.filter(x=>!want.includes(x));
    if(add.length) setList(f, cur, [...cur,...add], x=>{ sp[f]=x.join(', ')||null; });
    if(out.length) remove[f]=out; }
  const hasRm=Object.keys(remove).length>0;
  if(!changes.length && !hasRm) return { outcome:'unchanged', msg:'nada mudou' };
  const note=aeTxt(ops.note||entry.note||'');
  if(changes.length) sp.agentEdits=[...(Array.isArray(sp.agentEdits)?sp.agentEdits:[]), { id:entry.id, at:entry.at||nowIso, by:by.agent||'agente', byTask:by.taskId||'', byTitle:by.taskTitle||'', changes, note, delivered:'card' }].slice(-10);
  let proposal=null;
  if(hasRm){ proposal={ id:entry.id, at:entry.at||nowIso, by:by.agent||'agente', byTask:by.taskId||'', byTitle:by.taskTitle||'', remove, note, status:'open' };
    sp.agentProposals=[...(Array.isArray(sp.agentProposals)?sp.agentProposals:[]), proposal].slice(-20); }
  sp.agentEditIds=[...(sp.agentEditIds||[]), entry.id].slice(-300); // idempotência: separado do rastro cortado
  const cloudOnly=card.status!=='backlog'; // já está com alguém, noutra máquina: só o card muda
  return { outcome:changes.length?'applied':'proposed', spec:sp, title, changes, proposal, cloudOnly,
    msg:cloudOnly?'aplicado só no card da nuvem; o agente daquela máquina não recebeu':(hasRm?'remoção virou proposta':'') };
}
// PURA: decide proposta num cartão → { ok, spec, msg }
function aeDecideCard(card, pid, approve, who, nowIso){
  const sp=aeClone(card&&card.spec); const p=(sp.agentProposals||[]).find(x=>x&&x.id===pid);
  if(!p) return { ok:false, msg:'proposta não encontrada' };
  if(p.status!=='open') return { ok:false, msg:'essa proposta já foi decidida' };
  if(!approve||['merged','done'].includes(card.status)){ p.status='rejected'; p.decided={ at:nowIso, by:who }; return { ok:true, spec:sp, msg:'proposta recusada' }; }
  const changes=[]; const rm=p.remove||{};
  const reqs=Array.isArray(sp.requirements)?[...sp.requirements]:[]; const nr=reqs.filter(r=>!(rm.requirements||[]).some(x=>aeNorm(x)===aeNorm(r)));
  if(nr.length!==reqs.length){ changes.push({ field:'requirements', before:reqs, after:nr }); sp.requirements=nr; }
  for(const f of ['owns','off']){ const cur=aeAsList(sp[f]), after=cur.filter(x=>!(rm[f]||[]).includes(x)); if(after.length!==cur.length){ changes.push({ field:f, before:cur, after }); sp[f]=after.join(', ')||null; } }
  p.status=changes.length?'approved':'rejected'; p.decided={ at:nowIso, by:who, msg:changes.length?'':'os itens já não existem' };
  if(changes.length) sp.agentEdits=[...(sp.agentEdits||[]), { id:'p:'+p.id, at:nowIso, by:p.by, byTask:p.byTask, byTitle:p.byTitle, changes, note:p.note, delivered:'card', approvedBy:who }].slice(-10);
  return { ok:true, spec:sp, msg:changes.length?'proposta aprovada':'os itens já não existem' };
}
// PURA: desfaz uma edição de agente num cartão → { ok, spec, title, msg }
function aeUndoCard(card, editId, who, nowIso){
  const sp=aeClone(card&&card.spec); const r=(sp.agentEdits||[]).find(x=>x&&x.id===editId);
  if(!r) return { ok:false, msg:'edição não encontrada' };
  if(r.undone) return { ok:false, msg:'essa edição já foi desfeita' };
  if(['merged','done'].includes(card.status)) return { ok:false, msg:'a tarefa já foi concluída' };
  let title=card.title;
  const cur=f=>f==='owns'||f==='off'?aeAsList(sp[f]):f==='title'?String(sp.title||card.title||''):f==='objective'?String(sp.objective||''):[...(sp[f]||[])];
  const moved=(r.changes||[]).filter(c=>JSON.stringify(cur(c.field))!==JSON.stringify(c.after));
  if(moved.length) return { ok:false, msg:moved.map(c=>AE_FIELD_PT[c.field]||c.field).join(', ')+' mudou de novo depois — ajuste à mão' };
  for(const c of r.changes||[]){ if(c.field==='owns'||c.field==='off') sp[c.field]=(c.before||[]).join(', ')||null; else sp[c.field]=c.before; if(c.field==='title') title=c.before; }
  r.undone={ at:nowIso, by:who||'você' };
  return { ok:true, spec:sp, title };
}

// ---- rastro na conversa da tarefa (eventos "spec-edit" / "spec-proposal") ----
const AE_ID_RE=/\s*·\s*edição ([0-9a-f-]{36})\s*$/i;
const AE_PROP_RE=/\s*·\s*proposta ([0-9a-f-]{36})\s*$/i;
function aeAgo(at){ const x=agoTx(at); return !x?'':x==='agora'?'agora':'há '+x; }
function aeFmtVal(v){ return Array.isArray(v)?(v.length?v.join(' · '):'(vazio)'):(String(v||'')||'(vazio)'); }
function aeRowsHtml(changes){ return (changes||[]).map(c=>`<div class="ae-ch"><span class="ae-f">${esc(AE_FIELD_PT[c.field]||c.field)}</span><span class="ae-b" title="antes">${esc(aeFmtVal(c.before))}</span><span class="ae-arr" aria-hidden="true">→</span><span class="ae-a" title="depois">${esc(aeFmtVal(c.after))}</span></div>`).join(''); }
const aeFieldsTx=fs=>(fs||[]).map(f=>AE_FIELD_PT[f]||f).join(', ');
// PURA (com esc/escA/IC injetados): card do evento — frase + antes/depois (sob demanda) + desfazer
function aeEventHtml(t, e){
  const tx=String((e&&e.text)||'');
  if(e&&e.type==='spec-proposal') return aeProposalHtml(t, e);
  const m=tx.match(AE_ID_RE); const id=m?m[1]:'';
  const rec=id?(((t&&t.spec&&t.spec.agentEdits)||[]).find(r=>r&&r.id===id)):null;
  const closed=t&&['merged','done'].includes(t.status);
  const full=rec&&rec.changes; // teste/legado: rastro completo já no objeto
  const det=!rec?'':full?`<div class="ae-rows">${aeRowsHtml(rec.changes)}</div>`
    :`<details class="ae-det"><summary data-aefull="${escA(id)}" data-aetask="${escA(t.id)}">ver antes → depois (${esc(aeFieldsTx(rec.fields))})</summary><div class="ae-rows" data-aefullbox="${escA(id)}"></div></details>`;
  const fieldsTx=aeFieldsTx(rec&&(rec.fields||(rec.changes||[]).map(c=>c.field)));
  const act=!rec?'':rec.undone?`<span class="ae-undone">desfeita${rec.undone.by?' por '+esc(rec.undone.by):''}</span>`
    :closed?'':`<button class="btn sm ghost" data-aeundo="${escA(id)}" data-aetask="${escA(t.id)}" aria-label="${escA('desfazer a edição de '+(fieldsTx||'spec')+' feita por '+(rec.by||'agente'))}" title="volta a spec como estava antes desta edição">desfazer</button>`;
  return `<div class="ae-ev" role="note"><div class="ae-h"><span class="ae-ic">${IC.pencil||''}</span><span class="ae-tag">atualizado por agente</span><span class="ae-tx">${esc(tx.replace(AE_ID_RE,''))}</span></div>${det}${act?`<div class="ae-act">${act}</div>`:''}</div>`;
}
function aeRemoveTx(rm){ rm=rm||{}; return [...(rm.requirements||[]).map(x=>'requisito "'+x+'"'), ...(rm.doneWhen||[]).map(x=>'pronto quando '+x), ...(rm.owns||[]).map(x=>'owns '+x), ...(rm.off||[]).map(x=>'off '+x)].join('; '); }
// card da PROPOSTA de remoção: "o agente propõe remover: … — motivo: …" com aprovar/recusar
function aeProposalCard(p, attrs, can){
  const st=p.status==='approved'?'aprovada':p.status==='rejected'?'recusada':'';
  const who=esc(p.by||'agente')+(p.byTitle||p.byTask?' (tarefa '+esc(p.byTitle||p.byTask)+')':'');
  const act=st?`<span class="ae-undone">proposta ${st}${p.decided&&p.decided.by?' por '+esc(p.decided.by):''}${p.decided&&p.decided.msg?' — '+esc(p.decided.msg):''}</span>`
    :can?`<button class="btn sm" ${attrs} data-aeok="1" aria-label="${escA('aprovar a remoção proposta por '+(p.by||'agente'))}">aprovar</button><button class="btn sm ghost" ${attrs} data-aeok="0" aria-label="${escA('recusar a remoção proposta por '+(p.by||'agente'))}">recusar</button>`
    :'<span class="ae-undone">esperando quem cuida decidir</span>';
  return `<div class="ae-ev ae-prop${st?' undone':''}" role="note"><div class="ae-h"><span class="ae-ic">${IC.warn||''}</span><span class="ae-tag">proposta de agente</span><span class="ae-tx">${who} propõe remover: ${esc(aeRemoveTx(p.remove))}${p.note?' — motivo: '+esc(p.note):''}</span></div><div class="ae-act">${act}</div></div>`;
}
function aeProposalHtml(t, e){
  const tx=String((e&&e.text)||''); const m=tx.match(AE_PROP_RE); const id=m?m[1]:'';
  const p=id?(((t&&t.spec&&t.spec.agentProposals)||[]).find(x=>x&&x.id===id)):null;
  if(!p) return `<div class="ae-ev ae-prop" role="note"><div class="ae-h"><span class="ae-ic">${IC.warn||''}</span><span class="ae-tag">proposta de agente</span><span class="ae-tx">${esc(tx.replace(AE_PROP_RE,''))}</span></div></div>`;
  const closed=t&&['merged','done'].includes(t.status);
  return aeProposalCard(p, `data-aeprop="${escA(id)}" data-aetask="${escA(t.id)}"`, !closed);
}

// ---- página do épico: propostas, histórico, cartões mexidos por agentes, pendências esperando permissão ----
const aeWaiting={}; // epicId → { n, msg } — edições que esperam quem pode editar o épico
function aeEpicHistHtml(sp, can, tasks, epicId){
  const hist=(Array.isArray(sp&&sp.history)?sp.history:[]).slice(-8).reverse();
  const props=(Array.isArray(sp&&sp.proposals)?sp.proposals:[]).filter(p=>p&&p.status==='open');
  const cards=(tasks||[]).flatMap(ct=>{ const s=ct.spec||{};
    return [...(s.agentProposals||[]).filter(p=>p.status==='open').map(p=>({ ct, p })), ...(s.agentEdits||[]).slice(-2).map(r=>({ ct, r }))]; });
  const w=epicId&&aeWaiting[epicId];
  if(!hist.length && !props.length && !cards.length && !w) return '';
  const line=c=>c.op? `${c.op==='add'?'+':'−'} <span class="mono">${esc((c.item&&c.item.id)||'')}</span> ${esc((c.item&&c.item.text)||'')}`
    : `<span class="ae-b">${esc(aeFmtVal(c.before))}</span> <span class="ae-arr" aria-hidden="true">→</span> <span class="ae-a">${esc(aeFmtVal(c.after))}</span>`;
  const undoBtn=(attr, h, what)=>`<button class="btn sm ghost" ${attr} aria-label="${escA('desfazer '+what+' feita por '+(h.by||'agente'))}">desfazer</button>`;
  return `<div class="seclbl2" style="margin-top:14px">Mudanças no épico <span class="dim">· a ideia muda conforme se programa — quem mudou, o quê e por quê</span></div>`+
    (w?`<div class="ae-ev ae-prop" role="status"><div class="ae-h"><span class="ae-ic">${IC.clock||''}</span><span class="ae-tx">${w.n} mudança(s) de agente esperando: ${esc(w.msg)}</span></div></div>`:'')+
    props.map(p=>aeProposalCard({ ...p, byTitle:p.byTask }, `data-epprop="${escA(p.id)}"`, can)).join('')+
    hist.map(h=>`<div class="ae-ev${h.undone?' undone':''}"><div class="ae-h"><span class="ae-ic">${IC.pencil||''}</span><span class="ae-tag">${esc(h.by||'agente')}${h.byTask?' · tarefa '+esc(h.byTask):''}${h.approvedBy?' · aprovado por '+esc(h.approvedBy):''}</span><span class="dim">${h.at?esc(aeAgo(h.at)):''}</span></div>
      <div class="ae-rows">${(h.changes||[]).map(c=>`<div class="ae-ch"><span class="ae-f">${esc(AE_FIELD_PT[c.field]||c.field)}</span><span>${line(c)}</span></div>`).join('')}${h.statusAfter?`<div class="ae-ch"><span class="ae-f">status</span><span>${esc(h.statusBefore||'')} → ${esc(h.statusAfter)}</span></div>`:''}</div>
      ${h.note?`<div class="ae-note">motivo: ${esc(h.note)}</div>`:''}${(h.refused||[]).length?`<div class="ae-note">não aplicado: ${esc(h.refused.join('; '))}</div>`:''}
      <div class="ae-act">${h.undone?`<span class="ae-undone">desfeita${h.undone.by?' por '+esc(h.undone.by):''}</span>`:can?undoBtn(`data-epundo="${escA(h.editId)}"`, h, 'a mudança de '+aeFieldsTx((h.changes||[]).map(c=>c.field))):''}</div></div>`).join('')+
    cards.map(({ ct, p, r })=>p?aeProposalCard(p, `data-cardprop="${escA(p.id)}" data-card="${escA(ct.id)}"`, can).replace('proposta de agente','proposta · '+esc(ct.title))
      :`<div class="ae-ev${r.undone?' undone':''}"><div class="ae-h"><span class="ae-ic">${IC.pencil||''}</span><span class="ae-tag">${esc(ct.title)}</span><span class="ae-tx">${esc(r.by||'agente')} mudou ${esc(aeFieldsTx((r.changes||[]).map(c=>c.field)))}${r.note?' — motivo: '+esc(r.note):''}</span></div><div class="ae-rows">${aeRowsHtml(r.changes)}</div>
        <div class="ae-act">${r.undone?'<span class="ae-undone">desfeita</span>':can&&!['merged','done'].includes(ct.status)?undoBtn(`data-cardundo="${escA(r.id)}" data-card="${escA(ct.id)}"`, r, 'a edição da tarefa '+ct.title):''}</div></div>`).join('');
}
// selo "atualizado por agente" no cabeçalho do épico (última mudança de agente nas últimas 24h, não desfeita)
function aeEpicBadge(sp){
  const h=(Array.isArray(sp&&sp.history)?sp.history:[]).filter(x=>x&&!x.undone).slice(-1)[0];
  if(!h||!h.at||Date.now()-new Date(h.at).getTime()>86400000) return '';
  return `<span class="ae-badge" title="${escA((h.by||'agente')+(h.note?' — '+h.note:''))}">${IC.pencil||''} atualizado por agente · ${esc(aeAgo(h.at))}</span>`;
}

// ---- escrita na nuvem com trava otimista (updated_at): outro membro/agente mexeu no meio → relê e refaz ----
async function aeGuardedPatch(table, id, fetchRow, build){
  for(let i=0;i<3;i++){
    const row=await fetchRow(); if(!row) return { outcome:'gone', msg:'registro não existe mais' };
    const b=build(row); if(!b||!b.body) return b;
    const q='/rest/v1/'+table+'?id=eq.'+aeEnc(id)+(row.updated_at?'&updated_at=eq.'+aeEnc(row.updated_at):'');
    const res=await sbFetch(q,{ method:'PATCH', headers:{ 'Prefer':'return=representation' }, body:JSON.stringify(b.body) });
    if(Array.isArray(res)&&res.length) return b;
  }
  throw new Error('conflito: o registro mudou enquanto eu aplicava — tento de novo depois');
}
function aeCanEditEpic(ep){ // mesma regra da página do épico (quem criou, ou owner/admin do time)
  const me=typeof cloudUserId==='function'?cloudUserId():''; if(!me||!ep) return false;
  return ep.created_by===me || (typeof cloudData!=='undefined'&&!!cloudData&&(cloudData.meRole==='owner'||cloudData.meRole==='admin'));
}
const aeEpicRow=id=>async()=>((await sbGet('epics?select=id,name,spec,status,created_by,updated_at&id=eq.'+aeEnc(id)))||[])[0]||null;
const aeCardRow=id=>async()=>((await sbGet('tasks?select=*&id=eq.'+aeEnc(id)))||[])[0]||null;
function aeRefreshTeam(epicId){
  try{ teamTasks=null; if(typeof teamPaintSig!=='undefined') teamPaintSig=''; if(typeof renderTeamBoard==='function') renderTeamBoard(); }catch(_){ }
  if(epicId && typeof epTab!=='undefined' && epTab && epTab.id===epicId && typeof epicPageLoad==='function') epicPageLoad(epicId).then(()=>{ if(epTab&&epTab.id===epicId) epicPageRender(); }).catch(()=>{});
}
// cópias locais (TASK.yaml) do "pronto quando" seguem a lista oficial
function aeSyncLocal(epicId, sp){ return invokeQuiet('epic_sync_cli',{ epicId, doneWhen:aeDoneWhenLines(sp), seq:+sp.doneWhenSeq||aeMaxD(sp.doneWhen) }).catch(e=>console.warn('sincronizar pronto quando local', e&&e.message||e)); }
function aeMe(){ return (typeof tmName==='function'&&typeof cloudUserId==='function'&&cloudUserId())?tmName(cloudUserId()):'você'; }

// ---- aplicador da fila (.cardume/agent-edits) ----
// desfecho: applied | proposed | cloud-only | unchanged | duplicate | refused | gone; { wait } = fica na fila (sem permissão)
async function aeApplyOne(e){
  const now=new Date().toISOString(), by=(e.by||{});
  const bad=aeValidate(e); if(bad) return { outcome:'refused', msg:bad };
  if(e.kind==='epic'){
    const first=await aeEpicRow(e.target)();
    if(!first) return { outcome:'gone', msg:'épico não existe (ou é de outro time)' };
    if(!aeCanEditEpic(first)) return { wait:true, msg:'precisa de quem criou o épico (ou de um admin) com o app aberto' };
    let name=first.name;
    const r=await aeGuardedPatch('epics', e.target, aeEpicRow(e.target), f=>{ name=f.name;
      const x=aeApplyEpic(f.spec||{}, e, now, f.status);
      if(x.outcome!=='applied'&&x.outcome!=='proposed') return x;
      const body={ spec:x.spec, updated_at:now }; if(x.status!==f.status) body.status=x.status;
      return { ...x, body }; });
    if(r.body){
      if((e.epic.doneWhenAdd||[]).length) await aeSyncLocal(e.target, r.spec);
      aeRefreshTeam(e.target);
      toast((by.agent||'Um agente')+(r.outcome==='proposed'?' propôs mudança no':' atualizou o')+' épico "'+(name||'')+'"'+(e.note?' — '+e.note:''),'info');
    }
    return { outcome:r.outcome, msg:r.msg||'' };
  }
  // cartão: por id da nuvem, ou pelo local_id (irmã iniciada em outra máquina) no MESMO projeto e épico
  const proj=await cloudEnsureProject(); const ctx={ projectId:proj&&proj.id };
  const q=aeIsUuid(e.target)?'tasks?select=*&id=eq.'+aeEnc(e.target)
    :'tasks?select=*&local_id=eq.'+aeEnc(e.target)+'&project_id=eq.'+aeEnc(ctx.projectId)+'&epic_id=eq.'+aeEnc(e.epicId);
  const card=((await sbGet(q))||[])[0]||null;
  const g=aeCardGuard(card, e, ctx); if(g) return { outcome:card?'refused':'gone', msg:g };
  // a irmã roda NESTA máquina: edita a tarefa local (spec + TASK.yaml + recado pro próximo turno) pelo motor
  const m=typeof tmap==='function'?tmap():{};
  const lid=(state.tasks||[]).some(t=>t.id===card.local_id)?card.local_id:Object.keys(m).find(k=>m[k]===card.id&&(state.tasks||[]).some(t=>t.id===k));
  if(lid){
    let res; try{ res=JSON.parse(await invoke('task_edit_cli',{ taskId:lid, patch:JSON.stringify(e.task||{}), editId:e.id, byAgent:by.agent||'agente', byTask:by.taskId||null })); }
    catch(err){ return { outcome:'refused', msg:String(err&&err.message||err) }; } // o motor recusou (mergeada, formato, papel…)
    return { outcome:res.mode==='unchanged'?'unchanged':res.mode==='proposed'?'proposed':'applied', msg:res.message||'' };
  }
  const r=await aeGuardedPatch('tasks', card.id, aeCardRow(card.id), c=>{
    const x=aeApplyCard(c, e, now, ctx);
    if(x.outcome!=='applied'&&x.outcome!=='proposed') return x;
    return { ...x, body:{ spec:x.spec, title:x.title } }; });
  if(!r.body) return { outcome:r.outcome, msg:r.msg||'' };
  const trail=(by.agent||'agente')+(by.taskTitle?' (tarefa '+by.taskTitle+')':'')+(r.outcome==='proposed'?' propõe remover: '+aeRemoveTx(r.proposal&&r.proposal.remove):' atualizou esta tarefa: '+aeFieldsTx((r.changes||[]).map(c=>c.field)))+' — motivo: '+aeTxt(e.task.note||e.note||'');
  sbPost('task_feed',{ task_id:card.id, agent:by.agent||'agente', kind:'note', text:trail.slice(0,500) }).catch(()=>{});
  aeRefreshTeam(card.epic_id);
  toast((by.agent||'Um agente')+' atualizou a tarefa "'+r.title+'" do time'+(r.cloudOnly?' — só no card da nuvem; o agente daquela máquina não recebeu':''), r.cloudOnly?'warn':'info');
  return { outcome:r.cloudOnly?'cloud-only':r.outcome, msg:r.msg||'' };
}
// falha PERMANENTE (não adianta tentar de novo) × transitória (rede, conflito)
function aeIsPermanent(err){ return /\b(erro|http|status)\s*:?\s*(400|403|404|409|422)\b|row-level security|permission denied|22P02|PGRST|não tem permissão|inválid/i.test(String(err&&err.message||err||'')); }
const aeRetry={}; // id → { n, next }
let aeBusy=false, aeSeenEv=-1, aeRepo=null; const aeWaitToast=new Set();
async function aeNotifyRefused(e, msg){
  const by=e.by||{};
  toast('Edição de '+(by.agent||'agente')+' recusada: '+msg,'warn');
  const t=by.taskId&&(state.tasks||[]).find(x=>x.id===by.taskId);
  if(t && (t.busy || (typeof ACTIVE_ST!=='undefined'&&ACTIVE_ST.has(t.status)))) // o agente fica sabendo no próximo turno
    invokeQuiet('add_instruction',{ taskId:t.id, text:'Sua edição de spec ('+(e.kind==='epic'?'épico':'tarefa '+e.target)+') foi RECUSADA: '+msg+'. Não tente de novo do mesmo jeito; se for essencial, pergunte ao humano via ask_human.' }).catch(()=>{});
}
async function aeTick(){
  if(aeBusy) return;
  aeBusy=true;
  try{
    if(state.repo!==aeRepo){ aeRepo=state.repo; aeSeenEv=-1; } // outro projeto: não reaproveita o cursor (ids de outro banco)
    if(!(state.tasks||[]).length) return;
    // toast das edições/propostas LOCAIS novas (o evento já está na conversa da tarefa editada)
    const evs=(state.events||[]).filter(x=>['spec-edit','spec-proposal'].includes(x.type||x.kind));
    const maxId=evs.reduce((m,x)=>Math.max(m,+x.id||0),0);
    if(aeSeenEv>=0) evs.filter(x=>+x.id>aeSeenEv).slice(-3).forEach(x=>{ const t=(state.tasks||[]).find(y=>y.id===(x.taskId||x.task_id));
      toast(String(x.text||'').replace(AE_ID_RE,'').replace(AE_PROP_RE,'').slice(0,160), 'info', t?{ label:'abrir', fn:()=>openTaskById(t.id) }:undefined); });
    aeSeenEv=Math.max(aeSeenEv, maxId);
    if(!SB.sess() || !cloudTeamId()) return; // sem sessão: a fila espera (nada se perde)
    const pend=await invokeQuiet('agent_edits_pending').catch(()=>[]);
    const waiting={};
    for(const e of (pend||[])){ // mais antigas primeiro (ordem do arquivo); em espera/backoff não travam as outras
      const rt=aeRetry[e.id]; if(rt && Date.now()<rt.next) continue;
      let r;
      try{ r=await aeApplyOne(e); }
      catch(err){
        if(aeIsPermanent(err)) r={ outcome:'refused', msg:(typeof cloudErrMsg==='function'?cloudErrMsg(err):String(err&&err.message||err)) };
        else { const n=((rt&&rt.n)||0)+1;
          if(n>=8) r={ outcome:'refused', msg:'desisti depois de '+n+' tentativas: '+String(err&&err.message||err) };
          else { aeRetry[e.id]={ n, next:Date.now()+Math.min(600000, 15000*2**n) }; console.warn('edição do agente não aplicada (tento de novo)', e.id, err&&err.message||err); continue; } }
      }
      if(r.wait){ const k=e.target; waiting[k]={ n:((waiting[k]||{}).n||0)+1, msg:r.msg };
        if(!aeWaitToast.has(e.id)){ aeWaitToast.add(e.id); toast('Mudança de '+((e.by||{}).agent||'agente')+' no épico esperando: '+r.msg,'info'); }
        continue; }
      delete aeRetry[e.id];
      await invokeQuiet('agent_edits_done',{ id:e.id, outcome:r.outcome, msg:r.msg||'' }).catch(()=>{});
      if(r.outcome==='refused') await aeNotifyRefused(e, r.msg||'');
      if(['applied','proposed','cloud-only'].includes(r.outcome) && e.epicId) aeCtxRefresh([e.epicId], true).catch(()=>{}); // irmãs/épico mudaram: o contexto do motor acompanha
    }
    Object.keys(aeWaiting).forEach(k=>{ if(!waiting[k]) delete aeWaiting[k]; }); Object.assign(aeWaiting, waiting);
  }finally{ aeBusy=false; }
}
tickLoop('agentEdits', aeTick, 10000, 4000);

// ---- CONTEXTO VIVO DO ÉPICO pro motor (.cardume/epic-context/<epicId>.json, src/epic-context.ts) ----
// O motor não fala com a nuvem e as irmãs quase sempre só existem lá: o app grava, pra cada épico que tem tarefa
// neste repo, o épico + as irmãs (ids da nuvem e locais, títulos, status, requisitos). O motor regenera o EPIC.md
// a cada turno e resolve o alvo do edit_task por id OU título. Motor pediu (refresh-request) → atende em segundos.
// PURA: o JSON do contexto (só cartões do MESMO projeto)
function aeEpicContextJson(ep, cards, localIds, projectId, nowIso, ownerName){
  const sp=(ep&&ep.spec)||{}; const here=new Set(localIds||[]);
  const own=typeof ownerName==='function'?ownerName:()=>null;
  return {
    epicId:ep.id, title:ep.name||'', description:sp.description||'', outcome:sp.outcome||'',
    requirements:(Array.isArray(sp.requirements)?sp.requirements:[]).map(r=>({ id:String(r.id||''), text:String(r.text||'') })),
    doneWhen:(Array.isArray(sp.doneWhen)?sp.doneWhen:[]).map((d,k)=>({ id:String(d.id||('D'+(k+1))), text:String(d.text||''), checked:!!d.checkedBy })),
    siblings:(cards||[]).filter(c=>c && c.epic_id===ep.id && (!projectId || c.project_id===projectId)).map(c=>{
      const lid=c.local_id&&!String(c.local_id).startsWith('card-')?String(c.local_id):null;
      return { cloudId:c.id, localId:lid, title:(c.spec&&c.spec.title)||c.title||'', status:c.status||'', requirements:Array.isArray((c.spec||{}).requirements)?c.spec.requirements.map(String):[],
        owner:c.assignee?own(c.assignee):null, machineLocal:!!(lid&&here.has(lid)) }; }),
    updatedAt:nowIso, projectId:projectId||null,
  };
}
const aeCtxAt={}; let aeCtxBusy=false;
function aeLocalEpicIds(){ return [...new Set((state.tasks||[]).map(t=>t.epic&&t.epic.epicId).filter(Boolean))]; }
async function aeCtxRefresh(epicIds, force){
  if(!SB.sess() || !cloudTeamId()) return 0;
  const mine=new Set(aeLocalEpicIds()); // só épicos com tarefa NESTE repo (mesmo projeto)
  const ids=[...new Set(epicIds||[])].filter(id=>aeIsUuid(id)&&mine.has(id)&&(force||Date.now()-(aeCtxAt[id]||0)>30000));
  if(!ids.length) return 0;
  const proj=await cloudEnsureProject().catch(()=>null); const pid=proj&&proj.id;
  const localIds=(state.tasks||[]).map(t=>t.id); let n=0;
  for(const id of ids){
    try{
      const [ep, cards]=await Promise.all([
        sbGet('epics?select=id,name,spec,status&id=eq.'+aeEnc(id)).then(r=>(r||[])[0]||null),
        sbGet('tasks?select=id,local_id,title,status,assignee,spec,project_id,epic_id&epic_id=eq.'+aeEnc(id)+'&order=created_at').then(r=>r||[]),
      ]);
      if(!ep) continue;
      const json=aeEpicContextJson(ep, cards, localIds, pid, new Date().toISOString(), typeof tmName==='function'?tmName:null);
      await invokeQuiet('write_epic_context',{ epicId:id, json:JSON.stringify(json) });
      aeCtxAt[id]=Date.now(); n++;
    }catch(e){ console.warn('contexto do épico não gravado', id, e&&e.message||e); }
  }
  return n;
}
// a cada 3s: o motor pediu contexto fresco? (a cada ~60s, todos os épicos locais — throttle de 30s por épico)
let aeCtxLast=0;
async function aeCtxTick(){
  if(aeCtxBusy || !SB.sess() || !cloudTeamId()) return;
  aeCtxBusy=true;
  try{
    const req=await invokeQuiet('epic_context_requests').catch(()=>[]);
    if(Array.isArray(req)&&req.length) await aeCtxRefresh(req, true);
    if(Date.now()-aeCtxLast>60000){ aeCtxLast=Date.now(); await aeCtxRefresh(aeLocalEpicIds(), false); }
  }finally{ aeCtxBusy=false; }
}
tickLoop('epicContext', aeCtxTick, 3000, 2500);

// ---- ações do humano (desfazer / aprovar / recusar) ----
async function aeEpicUndo(ep, editId){
  if(!await askYes('Desfazer esta mudança no épico?\n\nO campo volta como estava antes — só se ninguém mexeu nele depois.')) return;
  await aeEpicWrite(ep.id, f=>aeUndoEpic(f.spec||{}, editId, aeMe(), new Date().toISOString(), f.status), 'Mudança desfeita', 'Não consegui desfazer a mudança');
}
async function aeEpicDecide(ep, pid, approve){
  if(!await askYes(approve?'Aprovar a remoção proposta pelo agente?\n\nO item sai do "pronto quando" do épico.':'Recusar a proposta do agente?\n\nO item continua valendo.')) return;
  await aeEpicWrite(ep.id, f=>aeDecideEpic(f.spec||{}, pid, approve, aeMe(), new Date().toISOString(), f.status), approve?'Proposta aprovada':'Proposta recusada', 'Não consegui registrar a decisão');
}
async function aeEpicWrite(epicId, fn, okMsg, errMsg){
  try{
    let msg='';
    const r=await aeGuardedPatch('epics', epicId, aeEpicRow(epicId), f=>{ const x=fn(f); if(!x.ok){ msg=x.msg; return { outcome:'refused' }; }
      const body={ spec:x.spec, updated_at:new Date().toISOString() }; if(x.status&&x.status!==f.status) body.status=x.status; return { ...x, body }; });
    if(!r.body){ toast(msg||'Nada a fazer','warn'); return; }
    await aeSyncLocal(epicId, r.spec); // desfazer/aprovar também muda as cópias locais do "pronto quando"
    aeRefreshTeam(epicId); toast(okMsg,'ok');
  }catch(e){ showErr(e, errMsg); }
}
async function aeCardWrite(cardId, fn, okMsg, errMsg){
  try{
    let msg='';
    const r=await aeGuardedPatch('tasks', cardId, aeCardRow(cardId), c=>{ const x=fn(c); if(!x.ok){ msg=x.msg; return { outcome:'refused' }; } return { ...x, body:{ spec:x.spec, ...(x.title?{ title:x.title }:{}) } }; });
    if(!r.body){ toast(msg||'Nada a fazer','warn'); return; }
    aeRefreshTeam(typeof epTab!=='undefined'&&epTab?epTab.id:null); toast(okMsg,'ok');
  }catch(e){ showErr(e, errMsg); }
}
window.aeEpicUndo=aeEpicUndo;
document.addEventListener('click', async ev=>{
  const el=ev.target&&ev.target.closest&&ev.target.closest('[data-aeundo],[data-aeprop],[data-epprop],[data-cardprop],[data-cardundo],summary[data-aefull]'); if(!el) return;
  const d=el.dataset;
  if(d.aefull){ // antes → depois completo, sob demanda (o snapshot só traz o resumo)
    const box=document.querySelector('[data-aefullbox="'+CSS.escape(d.aefull)+'"]'); if(!box||box.dataset.loaded) return;
    box.dataset.loaded='1'; box.textContent='carregando…';
    try{ const rec=await invoke('task_agent_edit',{ taskId:d.aetask, editId:d.aefull }); box.innerHTML=aeRowsHtml(rec&&rec.changes); }
    catch(e){ box.dataset.loaded=''; box.textContent=(typeof humanErr==='function')?humanErr(e,'Não consegui carregar').msg:String(e&&e.message||e); }
    return;
  }
  ev.preventDefault(); ev.stopPropagation();
  if(d.aeundo){ // tarefa LOCAL: o motor restaura spec + TASK.yaml; o recado ainda não entregue é cancelado
    if(!await askYes('Desfazer a edição que o agente fez nesta tarefa?\n\nA spec volta como estava (só os campos que ninguém mudou depois).')) return;
    el.disabled=true;
    try{ const r=JSON.parse(await invoke('task_edit_cli',{ taskId:d.aetask, undo:d.aeundo })); toast(r.message||'Edição desfeita','ok'); lastSig=''; await refresh(); }
    catch(e){ el.disabled=false; showErr(e, 'Não consegui desfazer'); }
    return;
  }
  const ok=d.aeok==='1';
  if(d.aeprop){ // proposta numa tarefa LOCAL
    if(!await askYes(ok?'Aprovar a remoção proposta pelo agente?':'Recusar a proposta do agente? Os itens continuam valendo.')) return;
    el.disabled=true;
    try{ const r=JSON.parse(await invoke('task_edit_cli',ok?{ taskId:d.aetask, approve:d.aeprop }:{ taskId:d.aetask, reject:d.aeprop })); toast(r.message||'Feito','ok'); lastSig=''; await refresh(); }
    catch(e){ el.disabled=false; showErr(e, 'Não consegui registrar a decisão'); }
    return;
  }
  const ep=(typeof epTab!=='undefined')?epTab:null;
  if(d.epprop && ep) return aeEpicDecide(ep, d.epprop, ok);
  if(d.cardprop){ if(!await askYes(ok?'Aprovar a remoção proposta pelo agente nesta tarefa do time?':'Recusar a proposta do agente?')) return;
    return aeCardWrite(d.card, c=>aeDecideCard(c, d.cardprop, ok, aeMe(), new Date().toISOString()), ok?'Proposta aprovada':'Proposta recusada', 'Não consegui registrar a decisão'); }
  if(d.cardundo){ if(!await askYes('Desfazer a edição do agente nesta tarefa do time?')) return;
    return aeCardWrite(d.card, c=>aeUndoCard(c, d.cardundo, aeMe(), new Date().toISOString()), 'Edição desfeita', 'Não consegui desfazer'); }
}, true);
