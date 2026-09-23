// Constellation — 14-issues-projeto
// ===== Painel de Issues do TIME, em estágios =====
//  1) CONEXÃO  — doc da API + chaves → a IA gera o CONECTOR declarativo (JSON) que o app executa
//  2) PROJETOS E REGRAS — quais projetos usam o painel; criar issue ao abrir tarefa; sync de status; observar
//  3) QUADRO   — kanban por status, quem está com a issue, mudanças/comentários, vínculo tarefa↔issue
// A config mora na nuvem (issue_trackers, uma por time) com cache local (~/.constellation/issue-tracker.json).
// VALOR de chave nunca entra aqui: o conector cita {{secret.NOME}} e o Rust (tracker_http) preenche.
let trk=null, trkView='board', trkMsg='', trkBusy='', trkDocFiles=[], trkLoadedFor=null;
let trkIssues=[], trkIssuesAt=0, trkErr='', trkQ='', trkFilter='all', trkSel=null, trkComments=null, trkMoreDone=false, trkNI=null; // trkNI: a aba "Nova issue" (conversa + rascunhos)
let trkProjects=[], trkRemote='', trkRemoteFor=null, trkTimer=null, trkSyncAt=0, trkMine={}; // trkMine: mudanças que EU fiz (não viram aviso)
let trkBg=false, trkBackoffMs=0, trkNextAt=0; // observador: chamadas em segundo plano não registram erro; falha → recuo exponencial
const TRK_RULES={ createOnTask:true, syncStatus:true, watch:true };
const TRK_KINDS={ todo:'var(--muted)', doing:'var(--info)', blocked:'var(--warn)', done:'var(--good)' };

// ---------- config: nuvem primeiro, cache local sempre ----------
function trkBlank(){ return { name:'', docs:'', connector:null, vars:{}, projects:[], allProjects:false, rules:{...TRK_RULES} }; }
function trkReady(){ return !!(trk&&trk.connector&&trk.connector.baseUrl&&trk.connector.ops&&trk.connector.ops.list); }
function trkCloudOn(){ return !!(typeof SB!=='undefined' && SB.sess() && cloudTeamId()); }
async function trkLoad(force){
  const key=trkCloudOn()?cloudTeamId():'local';
  if(trk && !force && trkLoadedFor===key) return trk;
  let cfg=null;
  if(trkCloudOn()){
    try{ const rows=await sbGet('issue_trackers?select=config&team_id=eq.'+cloudTeamId()); if(rows&&rows[0]) cfg=rows[0].config; }catch(_){ }
    if(cfg) invoke('tracker_local_set',{ config:cfg }).catch(()=>{});
  }
  if(!cfg){ try{ cfg=await invoke('tracker_local_get'); }catch(_){ cfg=null; } }
  trk=Object.assign(trkBlank(), cfg||{}); trk.rules=Object.assign({...TRK_RULES}, trk.rules||{});
  trkLoadedFor=key;
  return trk;
}
async function trkSave(){
  await invoke('tracker_local_set',{ config:trk });
  let cloud=false;
  if(trkCloudOn()){
    try{
      await sbFetch('/rest/v1/issue_trackers?on_conflict=team_id',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
        body: JSON.stringify({ team_id:cloudTeamId(), config:trk, updated_by:cloudUserId(), updated_at:new Date().toISOString() }) });
      cloud=true;
    }catch(_){ }
  }
  // o app cria a issue (determinístico) — o agente não deve criar outra por instrução antiga
  if(trkReady()) invoke('set_issue_config',{ config:{ enabled:false, instructions:'', titleTemplate:'', bodyTemplate:'', managedByPanel:true } }).catch(()=>{});
  return cloud;
}
async function trkRepoRemote(){
  const repo=(typeof state!=='undefined'&&state.repo)||'';
  if(trkRemoteFor!==repo){ try{ trkRemote=String(await invoke('repo_remote')||''); }catch(_){ trkRemote=''; } trkRemoteFor=repo; }
  return trkRemote;
}
async function trkProjectOn(){
  if(!trkReady()) return false;
  if(trk.allProjects) return true;
  const r=await trkRepoRemote(); return !!r && (trk.projects||[]).includes(r);
}

// ---------- executor do conector ----------
function trkPath(o, p){ if(!p) return o; return String(p).split('.').reduce((a,k)=>(a==null?a:a[k]), o); }
function trkUserVars(){ try{ return JSON.parse(lsGet('trk:uvars')||'{}'); }catch(_){ return {}; } }
function trkCtx(extra){
  const c=trk.connector, ctx={};
  (c.vars||[]).forEach(v=>{ ctx[v.name]=v.value||''; });
  Object.assign(ctx, trk.vars||{}, trkUserVars(), extra||{});
  return ctx;
}
// {{x}} → ctx.x; {{secret.X}} fica intacto (o Rust resolve). Chave de body/query que resolve vazia some.
function trkFill(v, ctx){
  if(typeof v==='string') return v.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,(m,k)=>ctx[k]==null?'':String(ctx[k]));
  if(Array.isArray(v)) return v.map(x=>trkFill(x,ctx));
  if(v&&typeof v==='object'){ const o={}; for(const k in v){ const r=trkFill(v[k],ctx); if(r!==''&&r!=null) o[k]=r; } return o; }
  return v;
}
// Campo que a API usa pro responsável (ex.: assignee_email): do conector, ou visto nas issues já lidas.
function trkAssignKey(){ const f=(trk.connector.fields||{}).assigneeEmail; if(f&&!String(f).includes('.')) return String(f);
  return trkIssues.some(i=>i.raw&&typeof i.raw==='object'&&('assignee_email' in i.raw))?'assignee_email':''; }
// Operação EFETIVA: a do conector; se ele foi gerado antes da API aceitar responsável, infere
// (assign = mesma rota do updateStatus, sem status; create ganha o campo do responsável).
function trkOp(name){
  const ops=trk.connector.ops||{}, op=ops[name], key=trkAssignKey();
  if(name==='assign' && !op && key && ops.updateStatus){ const u=ops.updateStatus, body={};
    Object.entries(u.body||{}).forEach(([k,v])=>{ if(!/\{\{\s*(status|reason)\s*\}\}/.test(JSON.stringify(v))) body[k]=v; }); body[key]='{{assignee}}';
    return { method:u.method, path:u.path, query:u.query, headers:u.headers, body, resultPath:u.resultPath||(ops.create||{}).resultPath, inferred:true }; }
  if(name==='create' && op && key && !JSON.stringify(op.body||{}).includes('{{assignee}}')) return Object.assign({}, op, { body:Object.assign({}, op.body||{}, { [key]:'{{assignee}}' }) });
  return op||null;
}
function trkMe(){ return String(trkCtx().email||'').trim(); }
async function trkCall(opName, extra){
  const c=trk.connector, op=trkOp(opName);
  if(!op) throw new Error('este painel não tem a operação "'+opName+'"');
  const ctx=trkCtx(extra);
  let url=String(c.baseUrl||'').replace(/\/+$/,'')+trkFill(op.path||'',ctx);
  const q=trkFill(op.query||{},ctx), qs=Object.keys(q).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(q[k])).join('&');
  if(qs) url+=(url.includes('?')?'&':'?')+qs;
  const method=(op.method||'GET').toUpperCase();
  const headers=Object.assign({}, c.headers||{}, op.headers||{});
  let body=null;
  if(op.body && method!=='GET'){ body=JSON.stringify(trkFill(op.body,ctx)); if(!Object.keys(headers).some(h=>h.toLowerCase()==='content-type')) headers['Content-Type']='application/json'; }
  const r=await (trkBg?invokeQuiet:invoke)('tracker_http',{ method, url, headers, body });
  let data=null; try{ data=JSON.parse(r.body); }catch(_){ data=r.body; }
  if(r.status<200||r.status>=300) throw new Error('HTTP '+r.status+' — '+String(typeof data==='string'?data:JSON.stringify(data)).slice(0,240));
  return data;
}
function trkErrText(e){
  const s=String(e&&e.message||e), m=s.match(/SECRET_(UNBOUND|MISSING):([A-Z0-9_]+)/);
  if(m) return m[1]==='MISSING' ? 'Falta a chave '+m[2]+' nesta máquina — adicione em Conexão.' : 'A chave '+m[2]+' ainda não foi liberada pra este servidor nesta máquina — confirme em Conexão.';
  return s;
}
function trkNorm(raw){
  const c=trk.connector, f=c.fields||{}, g=k=>f[k]?trkPath(raw,f[k]):undefined;
  // conector gerado antes da API expor o nome: cai nos nomes de campo mais comuns
  const alt=(k,...keys)=>{ const v=g(k); if(v!=null&&v!=='') return v; for(const x of keys){ if(raw&&raw[x]!=null&&raw[x]!=='') return raw[x]; } return undefined; };
  const code=String(g('code')||g('id')||'');
  let url=g('url')||''; if(!url && c.urlTemplate) url=trkFill(c.urlTemplate,{ code, id:g('id')||'' });
  const aId=g('assignee'), aName=alt('assigneeName','assignee_name','assigneeName'), aEmail=alt('assigneeEmail','assignee_email','assigneeEmail');
  return { raw, id:g('id')||code, code, title:String(g('title')||'(sem título)'), description:String(g('description')||''), status:String(g('status')||''),
    assignee:aName||aEmail||aId, assigneeId:aId, assigneeEmail:aEmail?String(aEmail):'', createdBy:alt('createdBy','created_by_name','created_by_email'),
    priority:g('priority'), tags:Array.isArray(g('tags'))?g('tags'):[], createdAt:g('createdAt')||'', updatedAt:g('updatedAt')||g('createdAt')||'', url:/^https?:\/\//i.test(url)?url:'', commentCount:g('commentCount') };
}
async function trkFetchIssues(){
  const op=trk.connector.ops.list, size=op.pageSize||100, MAXP=8;
  const page=async(i)=>{ const d=await trkCall('list',{ limit:size, offset:i*size, page:i+1 }); return { d, items:trkPath(d,op.itemsPath)||(Array.isArray(d)?d:[]) }; };
  const first=await page(0); let items=first.items.slice();
  const total=op.totalPath?+trkPath(first.d,op.totalPath)||0:0;
  if(total>size){
    const n=Math.min(MAXP, Math.ceil(total/size));
    const rest=await Promise.all(Array.from({length:n-1},(_,i)=>page(i+1).catch(()=>({items:[]}))));
    rest.forEach(r=>{ items=items.concat(r.items); });
  } else if(!op.totalPath){
    for(let i=1;i<MAXP && items.length===i*size;i++){ const r=await page(i).catch(()=>({items:[]})); if(!r.items.length) break; items=items.concat(r.items); }
  }
  const seen=new Set();
  trkIssues=items.map(trkNorm).filter(x=>x.code&&!seen.has(x.code)&&seen.add(x.code)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  trkIssuesAt=Date.now(); trkErr='';
  trkDetectChanges();
  return trkIssues;
}
function trkStatus(id){ return (trk.connector.statuses||[]).find(s=>s.id===id); }
function trkStatusOfKind(kind){ return (trk.connector.statuses||[]).find(s=>s.kind===kind); }

// ---------- observar: o que mudou desde a última vez que EU vi ----------
function trkSeen(){ try{ return JSON.parse(lsGet('trk:seen')||'null'); }catch(_){ return null; } }
function trkUnseen(){ try{ return JSON.parse(lsGet('trk:unseen')||'{}'); }catch(_){ return {}; } }
function trkSig(i){ return [i.updatedAt,i.status,i.commentCount==null?'':i.commentCount].join('|'); }
function trkDetectChanges(){
  const seen=trkSeen(), next={}, un=trkUnseen();
  trkIssues.forEach(i=>{
    next[i.code]=trkSig(i);
    if(!seen) return; // primeira carga: só semeia, sem alarde
    const old=seen[i.code]; if(old===next[i.code]) return;
    if(trkMine[i.code]===i.status){ delete trkMine[i.code]; return; }
    const [ou,os,oc]=String(old||'').split('|');
    const what=!old?'nova issue':(oc!==''&&String(i.commentCount)!==oc)?'novo comentário':(os!==i.status)?'status → '+((trkStatus(i.status)||{}).label||i.status):'atualizada';
    un[i.code]=what;
    if(trkTasksFor(i.code).length) pushNotif(i.code+' — '+what, i.title, trkTasksFor(i.code)[0].id);
  });
  lsSet('trk:seen', JSON.stringify(next)); lsSet('trk:unseen', JSON.stringify(un));
  trkBadge();
}
function trkMarkSeen(code){ const un=trkUnseen(); if(un[code]){ delete un[code]; lsSet('trk:unseen', JSON.stringify(un)); trkBadge(); } }
function trkBadge(){
  const b=$id('issuesBtn'); if(!b) return;
  const n=Object.keys(trkUnseen()).length; let d=b.querySelector('.trk-dot');
  if(n&&!d){ d=document.createElement('span'); d.className='trk-dot'; b.appendChild(d); }
  if(d){ d.textContent=n>9?'9+':String(n); d.style.display=n?'':'none'; }
}

// ---------- vínculo tarefa ↔ issue ----------
function trkLinks(){ try{ return JSON.parse(lsGet('trk:links')||'{}'); }catch(_){ return {}; } }
function trkTaskCode(t){ const l=trkLinks()[t.id]; if(l) return l; const c=(typeof issueCodeOf==='function')?issueCodeOf(t):null; if(c) return c;
  const u=t.issueUrl||''; const hit=u&&trkIssues.find(i=>i.url===u||u.endsWith('/'+i.code)); return hit?hit.code:null; }
function trkTasksFor(code){ return ((typeof state!=='undefined'&&state.tasks)||[]).filter(t=>trkTaskCode(t)===code); }
function trkTaskKind(t){ const s=t.status; if(s==='done'||s==='merged') return 'done'; if(['draft','queued','cancelled'].includes(s)) return null; return 'doing'; }
// tarefa andou → issue anda junto (nunca reabre issue concluída; só mexe se a issue existe no painel)
async function trkSyncTasks(){
  if(Date.now()-trkSyncAt<30000) return; trkSyncAt=Date.now();
  try{
    await trkLoad(); if(!trkReady()||!trk.rules.syncStatus||!trk.connector.ops.updateStatus||!(await trkProjectOn())) return;
    const tasks=(state.tasks||[]).filter(t=>trkTaskCode(t)&&trkTaskKind(t)); if(!tasks.length) return;
    if(Date.now()-trkIssuesAt>120000) await trkFetchIssues();
    for(const t of tasks){
      const i=trkIssues.find(x=>x.code===trkTaskCode(t)); if(!i) continue;
      const cur=(trkStatus(i.status)||{}).kind, want=trkTaskKind(t);
      if(cur===want||cur==='done'||(cur==='blocked'&&want==='doing')) continue;
      const to=trkStatusOfKind(want); if(!to) continue;
      await trkCall('updateStatus',{ code:i.code, id:i.id, status:to.id }); i.status=to.id; trkMine[i.code]=to.id;
    }
  }catch(_){ }
}
// TODA criação de tarefa passa aqui: regra ligada + projeto conectado + sem issue → cria e vincula
async function trkBeforeNewTask(payload){
  try{
    if(!payload||payload.issue||payload.issueUrl||payload.branchType==='integration') return payload;
    await trkLoad(); if(!trkReady()||!trk.rules.createOnTask||!trk.connector.ops.create||!(await trkProjectOn())) return payload;
    const reqs=(payload.requirements||[]).filter(Boolean);
    const description=[payload.objective||'', reqs.length?'Requisitos:\n'+reqs.map(r=>'- '+r).join('\n'):''].filter(Boolean).join('\n\n');
    const i=await trkCreateIssue(payload.title, description, (payload.deliverables||[]).join('; '));
    if(i&&i.code){ payload.issue=i.code; if(i.url) payload.issueUrl=i.url; }
  }catch(e){ trkToast('Não criei a issue no painel: '+trkErrText(e)); }
  return payload;
}
async function trkCreateIssue(title, description, goal, extra){
  const op=trkOp('create'), d=await trkCall('create',Object.assign({ title, description, goal:goal||'' }, extra||{}));
  const raw=trkPath(d,op.resultPath)||d, i=trkNorm(raw);
  if(extra&&extra.assignee){ trkLearnPerson(extra.assignee, i.assigneeId); if(!i.assigneeEmail&&extra.assignee.includes('@')) i.assigneeEmail=extra.assignee; if(i.assignee===i.assigneeId) i.assignee=extra.assignee; }
  if(i.code){ trkIssues.unshift(i); const s=trkSeen()||{}; s[i.code]=trkSig(i); lsSet('trk:seen',JSON.stringify(s)); }
  return i;
}
// ---------- ÉPICO no tracker (CAP-8): pai + filhas com bloqueio, genérico pro conector cadastrado ----------
// Suporte a pai = {{parent}} no body do create OU op addChild. Sem isso o aprovar não publica (as tarefas
// seguem ganhando issue ao serem assumidas, como sempre).
function trkCreateBodyHas(ph){ const op=trkOp('create')||{}; return JSON.stringify({ p:op.path||'', q:op.query||{}, b:op.body||{}, h:op.headers||{} }).includes('{{'+ph+'}}'); } // placeholder vale em path/query/body
function trkParentSupport(){ return trkReady() && !!trk.connector.ops.create && (trkCreateBodyHas('parent') || !!trk.connector.ops.addChild); }
function trkTypePick(re){ return ((trk.connector||{}).types||[]).find(t=>re.test(String(t)))||''; }
function trkEpicType(){ return trkTypePick(/epic|épico|initiative|iniciativa/i); } // reconhece pelo NOME do tipo; sem match, vai sem tipo
function trkStoryType(){ const t=trkTypePick(/^(story|task|tarefa|issue|história|historia)$/i)||trkTypePick(/story|task|tarefa/i); return t&&t!==trkEpicType()?t:''; }
// Publica o épico aprovado no card: 1 pai + N filhas em ordem de onda, com pai e bloqueio (ou "Bloqueada por" no corpo).
// `created`: [{ row (linha de tasks na nuvem, com spec.after em ids da nuvem), wave }]. Grava os links na nuvem.
async function trkPublishEpic(ep, created){
  try{
    await trkLoad();
    if(!trkReady()||!trk.rules.createOnTask||!(await trkProjectOn())||!trkParentSupport()) return null;
    const sp=(ep&&ep.spec)||{};
    const li=(arr,f)=>(Array.isArray(arr)&&arr.length)?arr.map(f).join('\n'):'';
    const desc=[ sp.outcome||'', li(sp.requirements,r=>'- '+(r.id||'R?')+': '+(r.text||''))&&('Requisitos:\n'+li(sp.requirements,r=>'- '+(r.id||'R?')+': '+(r.text||''))),
      li(sp.doneWhen,d=>'- [ ] '+(d.id||'D?')+': '+(d.text||''))&&('Pronto quando:\n'+li(sp.doneWhen,d=>'- [ ] '+(d.id||'D?')+': '+(d.text||''))),
      li(sp.boundaries,b=>'- '+b)&&('Não muda:\n'+li(sp.boundaries,b=>'- '+b)) ].filter(Boolean).join('\n\n');
    const parent=await trkCreateIssue(ep.name, desc, sp.outcome||'', { type:trkEpicType() });
    if(!parent||!parent.code){ trkToast('O painel não devolveu o código da issue-mãe — as filhas não foram publicadas'); return null; }
    const inCreateParent=trkCreateBodyHas('parent'), inCreateBlock=trkCreateBodyHas('blockedBy'), opBlock=!!trk.connector.ops.addBlockedBy, opChild=!!trk.connector.ops.addChild;
    const codeOf={}, idOf={}, out=[];
    for(const c of created){
      const row=c.row||{}, s=row.spec||{};
      const blockers=(Array.isArray(s.after)?s.after:[]).map(a=>codeOf[a]).filter(Boolean);
      const body=[ s.objective||'', s.verify?'Prova: '+s.verify:'', (Array.isArray(s.covers)&&s.covers.length)?'Cobre: '+s.covers.join(', '):'',
        (Array.isArray(s.requirements)&&s.requirements.length)?'Requisitos:\n'+s.requirements.map(r=>'- '+r).join('\n'):'',
        (!inCreateBlock&&!opBlock&&blockers.length)?'Bloqueada por: '+blockers.join(', '):'', 'Épico: '+parent.code ].filter(Boolean).join('\n\n');
      let i=null;
      try{ i=await trkCreateIssue(row.title, body, s.verify||'', { type:trkStoryType(), parent:parent.code, parentId:parent.id||'', blockedBy:inCreateBlock?blockers.join(','):'' }); }
      catch(e){ console.warn('filha não criada', row.title, e); continue; }
      if(!i||!i.code) continue;
      codeOf[row.id]=i.code; idOf[row.id]=i.id||'';
      if(!inCreateParent && opChild){ try{ await trkCall('addChild',{ parent:parent.code, parentId:parent.id||'', child:i.code, childId:i.id||'' }); }catch(e){ console.warn('addChild', e); } }
      if(opBlock && !inCreateBlock){ for(const a of (Array.isArray(s.after)?s.after:[])){ if(!codeOf[a]) continue; try{ await trkCall('addBlockedBy',{ code:i.code, id:i.id||'', blocker:codeOf[a], blockerId:idOf[a]||'' }); }catch(e){ console.warn('addBlockedBy', e); } } }
      out.push({ rowId:row.id, spec:s, code:i.code, url:i.url||'' });
    }
    // links na nuvem (sem clique): épico e tarefas — assumir a tarefa depois NÃO cria outra issue
    try{ await sbFetch('/rest/v1/epics?id=eq.'+ep.id,{ method:'PATCH', body: JSON.stringify({ spec:{ ...sp, issue:{ code:parent.code, url:parent.url||'' } }, updated_at:new Date().toISOString() }) }); }catch(e){ console.warn('link do épico', e); }
    for(const o of out){
      const spec={ ...o.spec, issueCode:o.code, issueUrl:o.url||undefined };
      const c=created.find(x=>x.row&&x.row.id===o.rowId); if(c){ c.row.issue_url=o.url||null; c.row.spec=spec; } // a onda 1 pode ser assumida logo em seguida: a linha em memória já leva o link (senão nasceria uma 2ª issue)
      try{ await sbFetch('/rest/v1/tasks?id=eq.'+o.rowId,{ method:'PATCH', body: JSON.stringify({ issue_url:o.url||null, spec }) }); }catch(e){ console.warn('link da tarefa', e); }
    }
    trkToast('Épico publicado no painel: '+parent.code+' + '+out.length+' filha'+(out.length===1?'':'s'));
    return parent;
  }catch(e){ trkToast('Não publiquei o épico no painel: '+trkErrText(e)); return null; }
}
window.trkPublishEpic=trkPublishEpic;
function trkToast(msg){
  let el=$id('trkToast'); if(!el){ el=document.createElement('div'); el.id='trkToast'; el.className='trk-toast'; document.body.appendChild(el); }
  el.textContent=msg; el.style.display='block'; clearTimeout(el._t); el._t=setTimeout(()=>{ el.style.display='none'; },5200);
}

// ---------- tela ----------
async function openIssues(){
  const mm=$id('moreMenu'); if(mm) mm.style.display='none';
  $id('issuesOverlay').style.display='flex';
  $id('issuesBody').innerHTML=cosmosHtml('carregando…');
  trkMsg=''; trkSel=null;
  await trkLoad(true);
  trkView=trkReady()?'board':'conn';
  issRender();
  if(trkView==='board') trkReload();
  trkLoadProjects();
}
async function trkLoadProjects(){
  const cur=await trkRepoRemote(); let list=[];
  const add=(name,remote,src)=>{ if(remote && !list.some(p=>p.remote===remote)) list.push({ name:name||remote.split('/').pop(), remote, src }); };
  if(cur) add('', cur, 'aberto');
  if(trkCloudOn()){ try{ await cloudEnsureProject(); (await sbGet('projects?select=name,repo_remote&team_id=eq.'+cloudTeamId()+'&order=name')).forEach(p=>add(p.name,p.repo_remote,'time')); }catch(_){ } }
  // todos os projetos desta máquina (não só o aberto)
  try{ const locals=await invoke('list_projects')||[]; for(const p of locals){ try{ add(p.name, await invoke('repo_remote_of',{ path:p.path }), 'local'); }catch(_){ } } }catch(_){ }
  // os que já estavam conectados (por outra pessoa do time, ou adicionados à mão)
  ((trk&&trk.projects)||[]).forEach(r=>add('', r, 'manual'));
  trkProjects=list; if(trkView==='rules') issRender();
}
async function trkReload(){
  trkBusy='load'; issRender();
  try{ await trkFetchIssues(); }catch(e){ trkErr=trkErrText(e); }
  trkBusy=''; issRender();
}
const trkSw=(id,on,label,sub)=>`<div class="trk-row"><label class="sw"><input type="checkbox" id="${id}"${on?' checked':''}><span class="tr"><span class="kn"></span></span></label><div><div class="trk-rt">${label}</div>${sub?`<div class="trk-rs">${sub}</div>`:''}</div></div>`;
function issRender(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const body=$id('issuesBody'); if(!body||!trk) return;
  // estado das chaves desta máquina (pro aviso no quadro): carrega uma vez e re-renderiza
  if(trkSecretNames().length && !Object.keys(trkSecretSt).length){ trkSecretsRefresh().then(()=>{ if(Object.keys(trkSecretSt).length) issRender(); }); }
  const ready=trkReady();
  const step=(k,n,l,dis)=>`<button class="trk-step${trkView===k?' on':''}" data-trkview="${k}"${dis?' disabled':''}><i>${n}</i>${l}</button>`;
  const shared=trkCloudOn()?'Compartilhado com o time.':'<span style="color:var(--warn)">Sem nuvem — vale só nesta máquina.</span>';
  body.innerHTML=`<div class="sk-screen trk">
    <div class="sk-head"><div><h1 class="sk-h1">Issues${trk.name?' <span class="trk-name">· '+esc(trk.name)+'</span>':''}</h1>
      <p class="sk-sub">Conecte o painel de issues do time, escolha os projetos e acompanhe tudo num quadro — a tarefa e a issue andam juntas. ${shared}</p></div>
      <div class="trk-steps">${step('conn',1,'Conexão')}${step('rules',2,'Projetos e regras',!ready)}${step('board',3,'Quadro',!ready)}</div></div>
    ${trkMsg?`<div class="imhint trk-msg" style="border-left:2px solid ${trkMsg.startsWith('✓')?'var(--good)':'var(--warn)'}">${esc(trkMsg)}</div>`:''}
    <div id="trkView">${trkView==='conn'?trkConnHtml():trkView==='rules'?trkRulesHtml():trkBoardHtml()}</div>
  </div>`;
  body.querySelectorAll('[data-trkview]').forEach(b=>b.onclick=()=>{ trkKeepForm(); trkView=b.dataset.trkview; trkMsg=''; trkSel=null; issRender(); if(trkView==='board'&&!trkIssues.length) trkReload(); });
  (trkView==='conn'?trkConnWire:trkView==='rules'?trkRulesWire:trkBoardWire)(body);
}

// ----- estágio 1: conexão -----
let trkSecretSt={}, trkJsonOpen=false, trkTest='';
function trkConnHtml(){
  const c=trk.connector;
  const ops=c?[...new Set(Object.keys(c.ops||{}).concat('assign'))].map(k=>{ const o=trkOp(k); const nm={list:'listar',create:'criar',updateStatus:'mudar status',assign:'trocar responsável',comments:'ler comentários',addComment:'comentar'}[k]||k;
    return `<span class="trk-op${o?'':' off'}">${o?'✓':'—'} ${nm}${o?` <em>${esc((o.method||'GET')+' '+(o.path||''))}</em>`:''}</span>`; }).join(''):'';
  const secrets=c?(c.secrets||[]).map(s=>{ const st=trkSecretSt[s.name]||{}, host=trkHost(), ok=st.present&&st.host===host;
    return `<div class="trk-key"><span class="mono">${esc(s.name)}</span><span class="trk-rs" style="flex:1">${ok?'<b style="color:var(--good)">✓ pronta nesta máquina</b>':st.present?'já está no seu cofre — falta liberar pra <span class="mono">'+esc(host)+'</span>':esc(s.hint||'cole a chave — fica só na sua conta, nunca no painel compartilhado')}</span>
      ${st.present&&!ok?`<button class="btn sm" data-trkbind="${escA(s.name)}">liberar</button>`:''}<button class="btn sm" data-trkkey="${escA(s.name)}">${st.present?'trocar':'colar chave'}</button></div>`; }).join(''):'';
  const uv=trkUserVars();
  const vars=c?(c.vars||[]).map(v=>`<label class="trk-f">${esc(v.label||v.name)} ${v.perUser?'<span class="dim">· só você</span>':'<span class="dim">· do time</span>'}<input class="in" data-trkvar="${escA(v.name)}" data-peruser="${v.perUser?1:0}" value="${escA(v.perUser?(uv[v.name]||''):((trk.vars||{})[v.name]??v.value??''))}"></label>`).join(''):'';
  return `<div class="trk-card"><div class="trk-ct">1 · Documentação da API</div>
      <p class="trk-rs">Cole a doc do painel e/ou anexe os PDFs/Markdown (pode ser mais de um — eles se somam). A IA lê e monta a conexão: endpoints, campos, status e quais chaves precisa. Funciona com qualquer tracker que tenha API HTTP.</p>
      <label class="trk-f">Nome do painel<input class="in" id="trkName" value="${escA(trk.name||'')}" placeholder="ex.: Demands · Foundation"></label>
      <label class="trk-f">Documentação<textarea class="in mono" id="trkDocs" rows="7" style="font-size:11.5px" placeholder="cole aqui a documentação da API (endpoints, autenticação, campos, status)…">${esc(trk.docs||'')}</textarea></label>
      <div class="trk-bar"><button class="btn" id="trkPick">${ic('doc')}anexar arquivo${trkDocFiles.length?'s':''}</button>${trkDocFiles.map((f,k)=>`<span class="trk-op">${esc(f.split('/').pop())} <a data-trkunpick="${k}" style="cursor:pointer;opacity:.6">✕</a></span>`).join('')}<span style="flex:1"></span>
        <button class="btn primary" id="trkBuild"${trkBusy==='build'?' disabled':''}>${trkBusy==='build'?'lendo a doc…':(c?'✦ gerar de novo':'✦ gerar conexão')}</button></div></div>
    ${c?`<div class="trk-card"><div class="trk-ct">2 · Chaves e dados da conexão <span class="mono dim" style="font-weight:400">${esc(c.baseUrl||'')}</span></div>
      ${secrets||'<p class="trk-rs">Este painel não pede chave.</p>'}
      ${vars?`<div class="trk-grid2" style="margin-top:12px">${vars}</div>`:''}</div>
    <div class="trk-card"><div class="trk-ct">3 · O que o Constellation consegue fazer neste painel</div>
      <div class="trk-ops">${ops}</div>
      <div class="trk-ops" style="margin-top:10px">${(c.statuses||[]).map(s=>`<span class="trk-st"><i style="background:${TRK_KINDS[s.kind]||'var(--muted)'}"></i>${esc(s.label||s.id)}</span>`).join('<span class="dim">→</span>')}</div>
      ${c.notes?`<p class="trk-rs" style="margin-top:10px">${esc(c.notes)}</p>`:''}
      <div class="trk-bar" style="margin-top:12px"><button class="btn sm" id="trkJsonT">${trkJsonOpen?'fechar':'editar'} conector (JSON)</button><span style="flex:1"></span>${trkTest?`<span class="trk-rs" style="color:${trkTest.startsWith('✓')?'var(--good)':'var(--warn)'}">${esc(trkTest)}</span>`:''}<button class="btn" id="trkTestBtn"${trkBusy==='test'?' disabled':''}>${trkBusy==='test'?'testando…':'testar conexão'}</button></div>
      ${trkJsonOpen?`<textarea class="in mono" id="trkJson" rows="14" style="font-size:11px;margin-top:10px">${esc(JSON.stringify(c,null,2))}</textarea>`:''}</div>
    <div class="trk-bar"><span style="flex:1"></span><button class="btn primary" id="trkConnSave">salvar e continuar →</button></div>`:''}`;
}
function trkHost(){ try{ return new URL(trk.connector.baseUrl).hostname.toLowerCase(); }catch(_){ return ''; } }
// as chaves que o conector cita estão NESTA máquina e liberadas pro host dele?
function trkSecretNames(){ return ((trk&&trk.connector||{}).secrets||[]).map(s=>s.name); }
function trkSecretsMissing(){ const h=trkHost(); return trkSecretNames().filter(n=>{ const st=trkSecretSt[n]; return !(st&&st.present&&st.host===h); }); }
function trkSecretsHint(){ const m=trkSecretsMissing(); if(!m.length) return '';
  return `<div class="imhint" style="border-left:2px solid var(--warn)">A chave <b>${esc(m.join(', '))}</b> não está nesta máquina (ou não foi liberada pra <b>${esc(trkHost())}</b>). O painel é do time, mas cada máquina guarda a própria chave — vá em <a class="lnk" data-trkview="conn">Conexão</a>.</div>`; }
async function trkSecretsRefresh(){
  const names=((trk.connector||{}).secrets||[]).map(s=>s.name); if(!names.length){ trkSecretSt={}; return; }
  try{ trkSecretSt=await invoke('tracker_secret_status',{ names }); }catch(_){ trkSecretSt={}; }
}
function trkKeepForm(){
  const v=id=>{ const e=$id(id); return e?e.value:null; };
  if(v('trkName')!==null) trk.name=v('trkName').trim();
  if(v('trkDocs')!==null) trk.docs=v('trkDocs');
  if(trkJsonOpen && v('trkJson')!==null){ try{ trk.connector=JSON.parse(v('trkJson')); }catch(_){ trkMsg='JSON do conector inválido — mantive o anterior.'; } }
  const uv=trkUserVars(); let touched=false;
  document.querySelectorAll('[data-trkvar]').forEach(i=>{ touched=true; if(i.dataset.peruser==='1') uv[i.dataset.trkvar]=i.value.trim(); else { trk.vars=trk.vars||{}; trk.vars[i.dataset.trkvar]=i.value.trim(); } });
  if(touched) lsSet('trk:uvars', JSON.stringify(uv));
}
async function trkSecretSave(name, value){
  if(trkCloudOn()) await secretSet(name, value);
  else { const cur=String(await invoke('read_llm_env').catch(()=>'')||'').split('\n').filter(l=>l.trim()&&!l.startsWith(name+'=')); cur.push(name+'='+value); await invoke('write_llm_env',{ content:cur.join('\n')+'\n' }); }
}
function trkConnWire(body){
  const on=(id,fn)=>{ const b=body.querySelector('#'+id); if(b) b.onclick=fn; };
  if(trk.connector && !Object.keys(trkSecretSt).length && (trk.connector.secrets||[]).length) trkSecretsRefresh().then(()=>{ if(trkView==='conn'&&Object.keys(trkSecretSt).length) issRender(); });
  on('trkPick', async()=>{ trkKeepForm(); try{ const f=await invoke('pick_ref_files'); (f||[]).forEach(x=>{ if(!trkDocFiles.includes(x)) trkDocFiles.push(x); }); }catch(_){ } issRender(); });
  body.querySelectorAll('[data-trkunpick]').forEach(a=>a.onclick=()=>{ trkKeepForm(); trkDocFiles.splice(+a.dataset.trkunpick,1); issRender(); });
  on('trkBuild', async()=>{
    trkKeepForm(); trkBusy='build'; trkMsg=''; issRender();
    try{
      const out=await invoke('tracker_ai_build',{ docs:trk.docs||'', files:trkDocFiles });
      const m=String(out).match(/\{[\s\S]*\}/); const c=JSON.parse(m?m[0]:out);
      if(!c.baseUrl||!c.ops||!c.ops.list) throw new Error('a doc não deixou claro como LISTAR as issues — complete a documentação e gere de novo');
      trk.connector=c; if(!trk.name&&c.name) trk.name=c.name; trkSecretSt={}; trkTest='';
      trkMsg='✓ conexão montada — confira as chaves e teste.';
    }catch(e){ trkMsg='Não consegui montar a conexão: '+(e&&e.message||e); }
    trkBusy=''; await trkSecretsRefresh(); issRender();
  });
  body.querySelectorAll('[data-trkkey]').forEach(b=>b.onclick=async()=>{
    trkKeepForm(); const n=b.dataset.trkkey; const v=await askText('Chave '+n+' — fica só na sua conta','cole a chave'); if(!v) return;
    try{ await trkSecretSave(n, v.trim()); await invoke('tracker_bind_secret',{ name:n, host:trkHost() }); trkMsg='✓ chave '+n+' guardada e liberada só pra '+trkHost(); }catch(e){ trkMsg='Falhou guardar a chave: '+(e&&e.message||e); }
    await trkSecretsRefresh(); issRender();
  });
  body.querySelectorAll('[data-trkbind]').forEach(b=>b.onclick=async()=>{
    trkKeepForm(); const n=b.dataset.trkbind, h=trkHost();
    if(!confirm('Liberar a sua chave '+n+' para ser enviada a '+h+'?\n\nSó confirme se este é o servidor oficial do painel.')) return;
    await invoke('tracker_bind_secret',{ name:n, host:h }); await trkSecretsRefresh(); issRender();
  });
  on('trkJsonT', ()=>{ trkKeepForm(); trkJsonOpen=!trkJsonOpen; issRender(); });
  on('trkTestBtn', async()=>{
    trkKeepForm(); trkBusy='test'; trkTest=''; issRender();
    try{ const l=await trkFetchIssues(); trkTest='✓ conectado — '+l.length+' issues lidas'; }catch(e){ trkTest=trkErrText(e); }
    trkBusy=''; issRender();
  });
  on('trkConnSave', async()=>{
    trkKeepForm(); const cloud=await trkSave();
    trkMsg='✓ conexão salva'+(cloud?' pro time':' (só nesta máquina)'); trkView='rules'; issRender();
  });
}

// ----- estágio 2: projetos e regras -----
function trkRulesHtml(){
  const r=trk.rules, ops=trk.connector.ops;
  const projs=trkProjects.length?trkProjects.map(p=>`<div class="trk-row"><label class="sw"><input type="checkbox" data-trkproj="${escA(p.remote)}"${(trk.allProjects||(trk.projects||[]).includes(p.remote))?' checked':''}${trk.allProjects?' disabled':''}><span class="tr"><span class="kn"></span></span></label><div><div class="trk-rt">${esc(p.name)}${p.remote===trkRemote?' <span class="tmbadge" style="font-size:9px">projeto aberto</span>':p.src==='manual'?' <span class="dim" style="font-size:10px">adicionado à mão</span>':''}</div><div class="trk-rs mono">${esc(p.remote)}</div></div></div>`).join(''):'<p class="trk-rs">carregando projetos…</p>';
  return `<div class="trk-grid2">
    <div class="trk-card"><div class="trk-ct">Projetos conectados a este painel</div>
      ${trkSw('trkAll',trk.allProjects,'Todos os projetos do time','inclui os que forem criados depois')}
      <div class="trk-sep"></div>${projs}
      <div class="trk-bar"><button class="btn sm" id="trkAddProj">+ adicionar outro projeto</button><span class="trk-rs">pelo remote do git — ex.: github.com/org/repo</span></div></div>
    <div class="trk-card"><div class="trk-ct">Regras</div>
      ${trkSw('trkRCreate',r.createOnTask&&!!ops.create,'Criar uma issue sempre que uma tarefa for aberta',ops.create?'a tarefa já nasce vinculada — o código da issue entra no nome da branch':'a doc deste painel não tem endpoint de criação')}
      ${trkSw('trkRSync',r.syncStatus&&!!ops.updateStatus,'Mover a issue conforme a tarefa anda',ops.updateStatus?`tarefa começou → ${esc((trkStatusOfKind('doing')||{}).label||'em andamento')} · tarefa concluída → ${esc((trkStatusOfKind('done')||{}).label||'concluída')}`:'a doc deste painel não tem endpoint de status')}
      ${trkSw('trkRWatch',r.watch,'Observar as issues',ops.comments?'avisa quando chegar comentário, mudar status ou responsável':'avisa quando mudar status ou a issue for atualizada (este painel não expõe comentários pela API)')}
    </div></div>
    <div class="trk-bar"><span style="flex:1"></span><button class="btn primary" id="trkRulesSave">salvar e abrir o quadro →</button></div>`;
}
function trkRulesWire(body){
  const all=body.querySelector('#trkAll'); if(all) all.onchange=()=>{ trkRulesKeep(body); issRender(); };
  { const a=body.querySelector('#trkAddProj'); if(a) a.onclick=async()=>{
      trkRulesKeep(body);
      const v=await askText('Remote do projeto','github.com/org/repo'); if(!v) return;
      const r=v.trim().replace(/^(https?:\/\/|ssh:\/\/git@|git@)/,'').replace(/^([^\/:]+):/,'$1/').replace(/\.git$/,'').replace(/\/+$/,'');
      if(!r.includes('/')){ trkMsg='Remote inválido — use o formato github.com/org/repo.'; issRender(); return; }
      if(!trkProjects.some(p=>p.remote===r)) trkProjects.push({ name:r.split('/').pop(), remote:r, src:'manual' });
      if(!(trk.projects||[]).includes(r)) trk.projects=(trk.projects||[]).concat(r);
      trkMsg=''; issRender();
    }; }
  const b=body.querySelector('#trkRulesSave'); if(b) b.onclick=async()=>{
    trkRulesKeep(body); const cloud=await trkSave();
    trkMsg='✓ regras salvas'+(cloud?' pro time':' (só nesta máquina)'); trkView='board'; issRender(); trkReload(); trkWatchStart();
  };
}
function trkRulesKeep(body){
  const ck=id=>!!(body.querySelector('#'+id)||{}).checked;
  trk.allProjects=ck('trkAll');
  if(!trk.allProjects){ const shown=new Set(trkProjects.map(p=>p.remote)); const keep=(trk.projects||[]).filter(r=>!shown.has(r));
    trk.projects=keep.concat([...body.querySelectorAll('[data-trkproj]')].filter(c=>c.checked&&!c.disabled).map(c=>c.dataset.trkproj)); }
  trk.rules={ createOnTask:ck('trkRCreate'), syncStatus:ck('trkRSync'), watch:ck('trkRWatch') };
}

// ----- estágio 3: quadro -----
function trkPretty(v){ return String(v).split('@')[0].replace(/[._]+/g,' '); }
function trkPerson(v){
  if(v==null||v==='') return null;
  if(typeof v==='object') v=v.name||v.full_name||v.login||v.email||v.id||'';
  v=String(v); const known=(trk.people||{})[v]; const uuid=!known && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);
  const nm=known?trkPretty(known):(uuid?v.slice(0,4):trkPretty(v));
  const ini=uuid?'#':nm.split(/[\s._-]+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
  return { label:uuid?'id '+nm:nm, ini, full:known||v, unnamed:uuid };
}
// pessoas conhecidas (pro chat sugerir e pra escolher responsável): mapa do time + quem já aparece nas issues.
// `id` é o que vai pra API: o e-mail quando conhecido (assigneeFormat=email), senão o próprio valor.
function trkPeopleList(){ const m=new Map(); const put=(id,name)=>{ if(id&&!m.has(id)) m.set(id,name); };
  Object.entries(trk.people||{}).forEach(([id,n])=>put(String(n).includes('@')?n:id, trkPretty(n)));
  trkIssues.forEach(i=>{ const p=trkPerson(i.assignee); if(p&&!p.unnamed) put(i.assigneeEmail||p.full,p.label); });
  { const me=(trk&&trkReady())?trkCtx().email:''; if(me) put(me, trkPretty(me)); }
  return [...m].map(([id,name])=>({ id, name })); }
// a API devolve só o id do responsável: quando EU mando um e-mail e volta um id, aprendo o par (vale pro time)
let trkPeopleDirty=false;
function trkLearnPerson(sent, got){ if(!sent||got==null||typeof got==='object') return; got=String(got); if(got===sent||(trk.people||{})[got]===sent) return;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(got)) return; trk.people=Object.assign({}, trk.people||{}, { [got]:sent }); trkPeopleDirty=true; }
async function trkPeopleFlush(){ if(!trkPeopleDirty) return; trkPeopleDirty=false; try{ await trkSave(); }catch(_){ } }
async function trkAssign(code, who){
  const i=trkIssues.find(x=>x.code===code); if(!i) return;
  try{ const d=await trkCall('assign',{ code:i.code, id:i.id, assignee:who }); const raw=trkPath(d,(trkOp('assign')||{}).resultPath||(trk.connector.ops.create||{}).resultPath)||d;
    const nn=trkNorm(raw); trkLearnPerson(who, nn.assigneeId); i.assigneeId=nn.assigneeId||i.assigneeId; i.assigneeEmail=nn.assigneeEmail||(who.includes('@')?who:''); i.assignee=(nn.assignee&&nn.assignee!==nn.assigneeId)?nn.assignee:who; trkMine[i.code]=i.status; await trkPeopleFlush(); trkErr=''; }
  catch(e){ trkErr='Não troquei o responsável de '+code+': '+trkErrText(e); }
  issRender();
}
function trkAgo(iso){ const t=Date.parse(iso); if(!t) return ''; const m=Math.round((Date.now()-t)/60000); return m<1?'agora':m<60?m+'min':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'; }
function trkCardHtml(i){
  const p=trkPerson(i.assignee), tasks=trkTasksFor(i.code), un=trkUnseen()[i.code];
  return `<div class="trk-issue${un?' unseen':''}${trkSel===i.code?' sel':''}" draggable="true" data-trkcode="${escA(i.code)}">
    <div class="trk-ih"><span class="mono trk-code">${esc(i.code)}</span>${i.priority!=null&&i.priority!==''?`<span class="trk-pri">${esc(String(i.priority))}</span>`:''}<span style="flex:1"></span>${un?`<span class="trk-new">${esc(un)}</span>`:''}</div>
    <div class="trk-it">${esc(i.title)}</div>
    <div class="trk-if">${p?`<span class="trk-av" title="${escA(p.full)}">${esc(p.ini)}</span><span>${esc(p.label)}</span>`:'<span class="dim">sem responsável</span>'}<span style="flex:1"></span>${i.commentCount?`<span title="comentários">💬 ${esc(String(i.commentCount))}</span>`:''}${tasks.length?`<span class="trk-task" title="tarefa vinculada">⎇ ${esc(tasks[0].status||'tarefa')}</span>`:''}<span class="dim">${trkAgo(i.updatedAt)}</span></div>
  </div>`;
}
function trkBoardHtml(){
  const c=trk.connector, q=trkQ.trim().toLowerCase(), un=trkUnseen();
  let list=trkIssues;
  if(q) list=list.filter(i=>(i.code+' '+i.title+' '+((trkPerson(i.assignee)||{}).full||'')+' '+i.assigneeEmail).toLowerCase().includes(q));
  if(trkFilter==='linked') list=list.filter(i=>trkTasksFor(i.code).length);
  if(trkFilter==='unseen') list=list.filter(i=>un[i.code]);
  const known=new Set((c.statuses||[]).map(s=>s.id));
  const cols=(c.statuses||[]).concat(list.some(i=>!known.has(i.status))?[{ id:'__other', label:'Outros', kind:'todo' }]:[]);
  const chip=(k,l,n)=>`<button class="trk-chip${trkFilter===k?' on':''}" data-trkfilter="${k}">${l}${n!=null?` <em>${n}</em>`:''}</button>`;
  const colsHtml=cols.map(s=>{
    const items=list.filter(i=>s.id==='__other'?!known.has(i.status):i.status===s.id);
    const cap=(s.kind==='done'&&!trkMoreDone)?25:400, shown=items.slice(0,cap);
    return `<div class="trk-col" data-trkcol="${escA(s.id)}"><div class="trk-colh"><i style="background:${TRK_KINDS[s.kind]||'var(--muted)'}"></i>${esc(s.label||s.id)}<em>${items.length}</em></div>
      <div class="trk-colb">${shown.map(trkCardHtml).join('')||'<div class="trk-empty">—</div>'}${items.length>shown.length?`<button class="trk-more" id="trkMoreDone">mostrar mais ${items.length-shown.length}</button>`:''}</div></div>`; }).join('');
  return `${trkSecretsHint()}<div class="trk-tools">
      <div class="sk-search"><span class="sk-sd"></span><input id="trkQ" value="${escA(trkQ)}" placeholder="buscar por código, título ou pessoa"></div>
      ${chip('all','todas',trkIssues.length)}${chip('linked','com tarefa')}${chip('unseen','mudaram',Object.keys(un).length)}
      <span style="flex:1"></span><span class="trk-rs">${trkBusy==='load'?'atualizando…':trkIssuesAt?'atualizado '+trkAgo(new Date(trkIssuesAt).toISOString()):''}</span>
      <button class="btn" id="trkRefresh">atualizar</button>${c.ops.create?'<button class="sk-add" id="trkNewBtn">+ nova issue</button>':''}</div>
    ${trkErr?`<div class="imhint" style="border-left:2px solid var(--crit)">${esc(trkErr)}</div>`:''}
    <div class="trk-boardwrap"><div class="trk-board" style="grid-template-columns:repeat(${cols.length},minmax(240px,1fr))">${colsHtml}</div>${trkSel?trkDetailHtml():''}</div>`;
}
// JSON de IA, tolerante: cerca ```json (até o ÚLTIMO ``` — a fala pode ter cercas dentro), ou do 1º { ao último };
// e conserta quebra de linha/tab crus dentro de strings.
function trkParseJson(text){
  text=String(text||''); const cands=[]; let m;
  if((m=text.match(/```json\s*([\s\S]*)```/i))) cands.push(m[1]);
  if((m=text.match(/```json\s*([\s\S]*?)```/i))) cands.push(m[1]);
  const a=text.indexOf('{'), b=text.lastIndexOf('}'); if(a>=0&&b>a) cands.push(text.slice(a,b+1));
  const fix=t=>{ let out='', inS=false, esc=false; for(const ch of t){ if(inS){ if(esc){ esc=false; out+=ch; continue; } if(ch==='\\'){ esc=true; out+=ch; continue; } if(ch==='"'){ inS=false; out+=ch; continue; }
      out+=ch==='\n'?'\\n':ch==='\r'?'':ch==='\t'?'\\t':ch; } else { if(ch==='"') inS=true; out+=ch; } } return out; };
  for(const c of cands){ for(const t of [c, fix(c)]){ try{ const o=JSON.parse(t.trim()); if(o&&typeof o==='object') return o; }catch(_){ } } }
  return null;
}
// ----- ABA "Nova issue": mesmo padrão do "Montar conversando" -----
// Chat à esquerda (a IA PESQUISA o projeto escolhido pra fechar as arestas), rascunhos das issues à
// direita (uma ou várias) pra revisar — título, descrição, requisitos, responsável. Nada é criado sem confirmar.
function trkNIBlank(){ return { project:null, projects:[], sid:'', msgs:[], chips:[], items:[], epic:null, busy:false, running:false, pendingText:'', stop:false, prog:'', redirect:'', notes:[], pend:[] }; } // epic: {title, outcome, doneWhen[]} quando a IA agrupou a lista num épico // pend: anexos importados, ainda não enviados
function trkNIOpen(){ openTab('issuesbulk'); }
async function openIssuesBulk(){
  $id('issuesBulkOverlay').style.display='flex';
  await trkLoad();
  if(!trkNI){ trkNI=trkNIBlank(); await trkNIProjects(); trkNIAskProject(true); }
  trkNIRender();
}
// projetos DESTA máquina (a pesquisa precisa da pasta) — conectados ao painel primeiro
async function trkNIProjects(){
  const out=[]; try{ const locals=await invoke('list_projects')||[];
    for(const p of locals){ let remote=''; try{ remote=await invoke('repo_remote_of',{ path:p.path }); }catch(_){ }
      out.push({ name:p.name, path:p.path, remote, active:!!p.active, on:!!(trk.allProjects||(trk.projects||[]).includes(remote)) }); } }catch(_){ }
  trkNI.projects=out.sort((a,b)=>(b.on-a.on)||(b.active-a.active));
}
function trkNIAskProject(first){
  const n=trkNI, on=n.projects.filter(p=>p.on), cur=on.find(p=>p.active);
  if(on.length===1){ n.project=on[0]; n.msgs.push({ who:'bot', text:`Vou criar no projeto **${on[0].name}** (o único conectado ao painel). Me diga a issue — ou cole uma **lista**, uma por linha — que eu pesquiso o código pra fechar as arestas antes de criar.` }); n.chips=[]; return; }
  if(!n.projects.length){ n.msgs.push({ who:'sys', text:'Nenhum projeto local encontrado — abra o projeto no Constellation primeiro (preciso da pasta pra pesquisar o código).' }); return; }
  n.msgs.push({ who:'bot', text:(first?'Bora montar as issues conversando. ':'')+`**Em qual projeto** essas issues vão ser criadas?${cur?` O aberto agora é **${cur.name}**.`:''} Eu pesquiso o código dele pra fechar as arestas de cada uma.`+(on.length?'':' _(nenhum projeto local está conectado ao painel ainda — escolha um e eu sigo mesmo assim)_') });
  n.chips=(on.length?on:n.projects).slice(0,6).map(p=>'projeto: '+p.name);
}
function trkNIPickProject(name){
  const n=trkNI, q=String(name||'').toLowerCase().replace(/^projeto:\s*/,'').trim(); if(!q) return null;
  return n.projects.find(p=>p.name.toLowerCase()===q) || n.projects.find(p=>q.includes(p.name.toLowerCase())) || null;
}
function trkNIContext(){
  return JSON.stringify({ painel:trk.name||'', projeto:trkNI.project?{ name:trkNI.project.name, remote:trkNI.project.remote }:null,
    statuses:(trk.connector.statuses||[]).map(s=>s.id), priorities:trk.connector.priorities||[], types:trk.connector.types||[], assigneeFormat:trk.connector.assigneeFormat||'', people:trkPeopleList().slice(0,40),
    epicSupport:trkParentSupport(),
    existing:trkIssues.filter(i=>(trkStatus(i.status)||{}).kind!=='done').slice(0,60).map(i=>i.code+' '+i.title) });
}
async function trkNISend(text, silent){
  const n=trkNI; if(n.running) return; text=String(text||'').trim();
  const atts=(n.busy||silent)?[]:n.pend.splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e extraia o contexto (spec, print do bug, etc.) pra montar a issue.';
  if(!text) return;
  const inp=$id('trkNIInput'); if(inp) inp.value='';
  if(n.busy){ // no meio da pesquisa: interrompe e segue JÁ com a info nova (muda o rumo sem perder o pedido)
    n.msgs.push({ who:'you', text }); n.redirect=n.redirect?n.redirect+'\n'+text:text; n.prog='recebi — interrompendo pra seguir com isso…'; trkNIRender();
    try{ await invoke('issue_chat_stop'); }catch(_){ } return; }
  if(!silent) n.msgs.push({ who:'you', text, atts }); n.chips=[];
  // sem projeto definido: tenta achar no texto; senão PERGUNTA (e guarda o pedido pra não perder)
  if(!n.project){
    const p=trkNIPickProject(text);
    if(!p){ if(!/^projeto:/i.test(text)) n.pendingText=n.pendingText?n.pendingText+'\n'+text:text; trkNIAskProject(false); trkNIRender(); return; }
    n.project=p; const only=/^projeto:/i.test(text)||text.toLowerCase()===p.name.toLowerCase();
    n.msgs.push({ who:'sys', text:'projeto: '+p.name+(p.on?'':' · ainda não conectado ao painel (conecte em Issues → Projetos e regras pra tarefa e issue andarem juntas)') });
    if(only && !n.pendingText){ n.msgs.push({ who:'bot', text:'Fechado. Qual é a issue? Pode ser uma frase — ou uma **lista**, uma por linha.' }); trkNIRender(); return; }
    text=only?n.pendingText:((n.pendingText?n.pendingText+'\n':'')+text); n.pendingText='';
  }
  n.busy=true; n.stop=false; n.prog=''; n.redirect=''; n.notes=[]; trkNIRender();
  const call0=async(prompt)=>{
    const r=await aiCallResumeSafe((pr,sid)=>invoke('issue_chat',{ prompt:pr, sessionId:sid||'', repo:n.project.path, model:lsGet('defaultModel')||null, context:trkNIContext() }), n.sid, prompt, n.msgs.slice(0,-1));
    n.sid=r.sessionId||(r&&r.recovered?'':n.sid);
    let obj=trkParseJson(r.text);
    if(!obj && /"say"|"issues"/.test(r.text||'') && !n.stop){ // veio JSON quebrado: pede UMA vez pra reenviar limpo (mesma sessão, sem pesquisar de novo)
      const r2=await invoke('issue_chat',{ prompt:'[SISTEMA: sua última resposta NÃO era um JSON válido (provável: bloco ``` dentro de uma string, aspas sem escape ou quebra de linha crua). Reenvie EXATAMENTE o mesmo conteúdo como UM bloco ```json válido — dentro das strings use \\n para quebra de linha, escape as aspas, e NUNCA use cercas ``` (use `crase simples`). Não pesquise de novo.]', sessionId:n.sid||'', repo:n.project.path, model:lsGet('defaultModel')||null, context:trkNIContext() });
      n.sid=r2.sessionId||n.sid; obj=trkParseJson(r2.text); if(obj) return { obj, text:r2.text };
    }
    // nunca despeja JSON cru no chat: se der pra salvar o "say", mostra só ele
    let text=r.text||''; if(!obj){ const m=text.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/); if(m){ try{ text=JSON.parse('"'+m[1]+'"'); }catch(_){ text=m[1]; } text+='\n\n_(a resposta veio num formato que não consegui ler por inteiro — os cartões podem não ter atualizado; peça "reenvie" se faltar algo)_'; } }
    return { obj, text };
  };
  // interrompido com info nova → refaz a MESMA chamada com a info na frente (o turno morto não entrou na sessão)
  const call=async(prompt)=>{ for(;;){
    const pre=n.notes.length?'[INFO NOVA DO DEV, chegou no meio da pesquisa — vale daqui pra frente e pode MUDAR O RUMO (se mudar algo já montado, avise no say):\n- '+n.notes.join('\n- ')+']\n\n':'';
    try{ const r=await call0(pre+prompt); n.notes=[]; return r; }
    catch(e){ if(n.redirect && !n.stop){ n.notes.push(n.redirect); n.redirect=''; n.prog=n.prog.replace(/^recebi.*$/,''); trkNIRender(); continue; } throw e; } } };
  const toItems=list=>(Array.isArray(list)?list:[]).filter(x=>x&&x.title).slice(0,40).map(x=>({ title:String(x.title).slice(0,120), description:String(x.description||''), reqs:(Array.isArray(x.requirements)?x.requirements:[]).map(v=>String(v).trim()).filter(Boolean),
    goal:String(x.goal||''), assignee:String(x.assignee||''), priority:String(x.priority||''), type:String(x.type||''), open:(Array.isArray(x.open)?x.open:[]).map(String).filter(Boolean), skip:!!x.skip, state:'', code:'', err:'' }));
  let rest=text;
  try{
    trkNIKeep();
    const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
    if(!n.items.length && lines.length>6 && !atts.length){
      // lista grande: pesquisa em LOTES de 5 — os cartões vão aparecendo e dá pra PARAR no meio sem perder o que já veio
      const lots=[]; for(let k=0;k<lines.length;k+=5) lots.push(lines.slice(k,k+5));
      for(let k=0;k<lots.length && !n.stop;k++){
        rest=lots.slice(k).flat().join('\n'); // se parar aqui, só o que FALTA volta pra caixa
        n.prog=`lote ${k+1} de ${lots.length} · ${n.items.length} de ${lines.length} issues prontas`; trkNIRender();
        const { obj, text:raw }=await call(`[LOTE ${k+1}/${lots.length}] Monte as issues destas linhas (a lista inteira tem ${lines.length}; responda só este lote):\n`+lots[k].join('\n'));
        if(obj){ n.items=n.items.concat(toItems(obj.issues)); trkNIEpicFrom(obj); if(obj.say) n.msgs.push({ who:'bot', text:String(obj.say) }); n.chips=Array.isArray(obj.chips)?obj.chips.slice(0,4).map(String):[]; }
        else n.msgs.push({ who:'bot', text:raw||'(sem resposta)' });
      }
    } else {
      const edited=n.items.length?'\n\n[RASCUNHOS ATUAIS (o dev pode ter editado à mão — respeite):\n'+JSON.stringify(n.items.filter(i=>i.state!=='ok').map(i=>({ title:i.title, description:i.description, requirements:i.reqs, assignee:i.assignee, priority:i.priority, type:i.type })))+']':'';
      const { obj, text:raw }=await call(text+edited+attPromptBlock(atts));
      if(obj){
        if(Array.isArray(obj.issues)&&obj.issues.length) n.items=n.items.filter(i=>i.state==='ok').concat(toItems(obj.issues));
        trkNIEpicFrom(obj);
        n.chips=Array.isArray(obj.chips)?obj.chips.slice(0,4).map(String):[];
        if(obj.say) n.msgs.push({ who:'bot', text:String(obj.say) });
        if(obj.done && trkNIReady()){ n.busy=false; n.prog=''; n.msgs.push({ who:'sys', text:'Confirmado — criando…' }); trkNIRender(); await trkNICreate(); return; }
      } else n.msgs.push({ who:'bot', text:raw||'(sem resposta)' });
    }
  }catch(e){
    const msg=String(e&&e.message||e);
    if(n.stop||/ISSUE_CHAT_STOPPED/.test(msg)){ n.msgs.push({ who:'sys', text:'Parado.'+(n.items.length?' O que já tinha sido montado ficou aí do lado.':'')+(rest!==text?' As linhas que faltavam voltaram pra caixa':' Seu texto voltou pra caixa')+' — edite e envie de novo quando quiser.' }); trkNIRender(); const i=$id('trkNIInput'); if(i&&!i.value) i.value=rest; n.busy=false; n.prog=''; n.redirect=''; trkNIRender(); return; }
    else n.msgs.push({ who:'sys', text:'Falhou: '+msg.slice(0,300) });
  }
  // a info chegou no instante em que a resposta terminava: não se perde — vira a próxima mensagem
  const late=n.stop?'':n.redirect; n.redirect=''; n.busy=false; n.prog=''; trkNIRender();
  if(late) return trkNISend(late, true);
}
async function trkNIStop(){ const n=trkNI; if(!n||!n.busy) return; n.stop=true; try{ await invoke('issue_chat_stop'); }catch(_){ } }
function trkNITodo(){ return trkNI.items.filter(i=>i.state!=='ok'&&!i.skip&&i.title.trim()); }
// `epic` da resposta: objeto com title → agrupa; null explícito → desagrupa; ausente → mantém o que já tinha
function trkNIEpicFrom(obj){ const n=trkNI; if(!obj||!('epic' in obj)) return; const e=obj.epic;
  n.epic=(e&&typeof e==='object'&&e.title)?{ title:String(e.title).slice(0,90), outcome:String(e.outcome||'').slice(0,300), doneWhen:(Array.isArray(e.doneWhen)?e.doneWhen:[]).map(String).filter(Boolean).slice(0,6) }:null; }
function trkNIEpicOff(){ if(trkNI){ trkNI.epic=null; trkNI.msgs.push({ who:'sys', text:'Sem épico — as issues saem soltas.' }); trkNIRender(); } }
window.trkNIEpicOff=trkNIEpicOff;
function trkNIReady(){ return !!trkNI.project && trkNITodo().length>0; }
function trkNIKeep(){
  const o=$id('issuesBulkBody'); if(!o||!trkNI) return;
  o.querySelectorAll('[data-ni]').forEach(row=>{ const it=trkNI.items[+row.dataset.ni]; if(!it||it.state==='ok') return;
    const g=c=>{ const e=row.querySelector(c); return e?e.value:null; };
    if(g('.nt')!==null) it.title=g('.nt').trim(); if(g('.nd')!==null) it.description=g('.nd').trim();
    if(g('.nr')!==null) it.reqs=g('.nr').split('\n').map(x=>x.replace(/^\s*[-*•]\s*/,'').trim()).filter(Boolean);
    if(g('.na')!==null) it.assignee=g('.na').trim(); if(g('.np')!==null) it.priority=g('.np'); if(g('.ny')!==null) it.type=g('.ny'); });
}
function trkNIRender(){
  const o=$id('issuesBulkBody'), n=trkNI; if(!o||!n) return;
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  if(!trkReady()||!trk.connector.ops.create){ o.innerHTML='<div class="sk-screen trk"><h1 class="sk-h1">Nova issue</h1><p class="sk-sub">Conecte o painel primeiro, em Issues → Conexão'+(trkReady()?' (a doc deste painel não tem endpoint de criação)':'')+'.</p></div>'; return; }
  const keep=document.activeElement&&document.activeElement.id==='trkNIInput', iv=$id('trkNIInput')?$id('trkNIInput').value:'';
  const todo=trkNITodo(), made=n.items.filter(i=>i.state==='ok').length, openQ=todo.reduce((a,i)=>a+i.open.length,0);
  const canAssign=JSON.stringify((trkOp('create')||{}).body||{}).includes('{{assignee}}');
  const me=trkCtx().email||'';
  const cb=JSON.stringify(trk.connector.ops.create.body||{}), sel=(cls,vals,cur,ph,lock)=>`<select class="plfv in ${cls}"${lock?' disabled':''}><option value="">${ph}</option>${vals.map(v=>`<option${v===cur?' selected':''}>${esc(v)}</option>`).join('')}</select>`;
  const people=trkPeopleList();
  const thread=n.msgs.map(m=>`<div class="plmsg ${m.who}">${m.who==='bot'?'<span class="plav">✦</span>':''}<div class="plbub">${m.who==='bot'?mdToHtml(m.text):esc(m.text)+attRowHtml(m.atts)}</div></div>`).join('')
    +(n.busy?`<div class="plmsg bot"><span class="plav">✦</span><div class="plbub think">pesquisando em ${esc(n.project?n.project.name:'…')} pra fechar as arestas…${n.prog?'<br><span style="font-size:11.5px">'+esc(n.prog)+'</span>':''}</div></div>`:'');
  const cards=n.items.map((it,k)=>{
    const lock=n.running||it.state==='ok', st=it.state==='ok'?'ok':(it.open.length||it.state==='fail')?'ask':it.skip?'wait':'ok';
    const who=trkPerson(it.assignee);
    const tag=it.state==='ok'?`✓ ${esc(it.code)}`:it.state==='run'?'criando…':it.state==='fail'?'falhou':it.skip?'pulada':it.open.length?it.open.length+' em aberto':'pronta';
    return `<div class="plfield ${st} trk-ni" data-ni="${k}"><div class="plfhead"><span class="pldot"></span><span class="plfk mono">issue ${k+1}</span><span class="plfsrc">${tag}</span><span style="flex:1"></span>${lock?'':`<button class="trk-nix" data-niskip="${k}" title="${it.skip?'voltar a criar esta':'não criar esta'}">${it.skip?'↺':'✕'}</button>`}</div>
      <input class="plfv in nt" value="${escA(it.title)}" placeholder="título"${lock?' disabled':''}>
      <textarea class="plfv in nd" rows="3" placeholder="descrição — o problema, onde no código, a abordagem"${lock?' disabled':''}>${esc(it.description)}</textarea>
      <textarea class="plfv in mono nr" rows="3" placeholder="requisitos — um por linha"${lock?' disabled':''}>${esc(it.reqs.join('\n'))}</textarea>
      ${(cb.includes('{{type}}')&&(trk.connector.types||[]).length)||(cb.includes('{{priority}}')&&(trk.connector.priorities||[]).length)?`<div class="trk-niwho">${cb.includes('{{type}}')&&(trk.connector.types||[]).length?sel('ny',trk.connector.types,it.type,'tipo',lock):''}${cb.includes('{{priority}}')&&(trk.connector.priorities||[]).length?sel('np',trk.connector.priorities,it.priority,'prioridade',lock):''}</div>`:''}
      <div class="trk-niwho"><span class="trk-rs">Responsável</span>${who?`<span class="trk-av">${esc(who.ini)}</span>`:''}${canAssign
        ?`<input class="plfv in na" list="trkNIPeople" value="${escA(it.assignee)}" placeholder="${trk.connector.assigneeFormat==='email'||trkAssignKey()?'e-mail do responsável (opcional)':'sem responsável'}"${lock?' disabled':''}>${me&&!lock&&it.assignee!==me?`<button class="btn sm" data-nime="${k}" style="padding:3px 8px;font-size:11px">eu</button>`:''}`
        :`<span class="trk-rt" style="font-size:12px">${who?esc(who.label):'<span class="dim">sem responsável</span>'}</span>${it.assignee?'<span class="trk-rs">· vai anotado na descrição (este painel não define responsável na criação)</span>':''}`}</div>
      ${it.open.length?`<div class="trk-niopen">${it.open.map(q=>`<div>? ${esc(q)}</div>`).join('')}</div>`:''}${it.err?`<div class="trk-rs" style="color:var(--warn)">${esc(it.err)}</div>`:''}</div>`; }).join('');
  o.innerHTML=`<div class="plhead"><div class="plheadl"><span class="plheadic">✦</span><div class="plheadt"><b>Nova issue — montar conversando</b><span class="fwsub">${esc(trk.name||'painel')} · ${n.project?'projeto '+esc(n.project.name):'projeto ainda não escolhido'}${me?' · criando como '+esc(me):''}</span></div></div>
      <div class="plheadr">${n.projects.length>1?`<select class="in" id="trkNIProj" style="width:auto;font-size:12px"${n.running?' disabled':''}><option value="">escolher projeto…</option>${n.projects.map((p,k)=>`<option value="${k}"${n.project===p?' selected':''}>${esc(p.name)}${p.on?'':' (não conectado)'}</option>`).join('')}</select>`:''}<button class="btn sm ghost" id="trkNINew" title="encerra esta conversa e começa outra do zero (as issues já criadas continuam no painel)">＋ nova conversa</button><button class="btn sm" id="trkNIClose">voltar pro quadro</button></div></div>
    <div class="plcols"><div class="plchatcol"><div class="plthread" id="trkNIThread">${thread}</div>
        <div class="plchips">${n.chips.map((c,k)=>`<button class="plchip" data-nichip="${k}">${esc(c)}</button>`).join('')}</div>
        <div class="attrow attpend" id="trkNIPend" style="display:none"></div>
        <div class="plinput"><button class="btn sm" id="trkNIAttach" title="anexar print/PDF/doc (⌘V cola um print)"${n.running?' disabled':''}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" style="width:14px;height:14px"><path d="M9.5 3.5L5 8a2 2 0 0 0 2.8 2.8l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 6.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><textarea class="in plta" id="trkNIInput" rows="2" placeholder="${n.busy?'quer mudar o rumo ou acrescentar uma info? escreva e envie — eu interrompo e sigo com isso':n.project?'descreva a issue — ou cole uma lista, uma por linha · ⌘V cola um print · enter envia, shift+enter quebra linha':'diga o projeto (ou escolha acima)…'}"${n.running?' disabled':''}></textarea>${n.busy?`<button class="btn trk-stop" id="trkNIStop">■ parar</button>`:''}<button class="btn primary" id="trkNISend"${n.running?' disabled':''}>${n.busy?'redirecionar':'enviar'}</button></div></div>
      <div class="plmesh"><div class="plmeshh">issues <span class="plmesht">${n.items.length?`${todo.length} pra criar${made?' · '+made+' criadas':''}${openQ?' · '+openQ+' perguntas em aberto':''}`:'aparecem aqui conforme a conversa'}</span></div>${n.epic?`<div class="trk-niepic"><span class="mono" style="color:var(--accent)">◆ ÉPICO</span> <b>${esc(n.epic.title)}</b>${n.epic.outcome?` <span class="dim">· ${esc(n.epic.outcome)}</span>`:''}${trkParentSupport()?'':' <span class="dim">· este painel não tem issue-mãe: o épico vai citado no corpo</span>'}${n.running?'':` <button class="trk-nix" onclick="trkNIEpicOff()" title="não agrupar">✕</button>`}</div>`:''}
        ${cards||'<div class="trk-rs" style="padding:8px 2px">Mande uma issue ou uma lista. Eu pesquiso o projeto, preencho descrição e requisitos e pergunto só o que o código não responde.</div>'}
        <datalist id="trkNIPeople">${people.map(p=>`<option value="${escA(p.id)}">${esc(p.name)}</option>`).join('')}</datalist>
        <div class="plmeshfoot">${(!todo.length&&made&&!n.running&&!n.busy)
          ?`<div class="trk-nidone">✓ ${made} issue${made===1?'':'s'} criada${made===1?'':'s'} nesta conversa</div><button class="btn primary" id="trkNIEnd">encerrar e começar outra conversa</button><button class="btn" id="trkNIBoard" style="margin-top:6px">ver no quadro</button><div class="dim" style="font-size:10.5px;margin-top:6px">ou continue aqui — mande mais issues que eu sigo no mesmo contexto</div>`
          :`<button class="btn primary" id="trkNICreate"${trkNIReady()&&!n.busy&&!n.running?'':' disabled'}>${n.running?'criando…':'confirmar e criar '+(todo.length||'')+(todo.length===1?' issue':' issues')}</button>
          <div class="dim" style="font-size:10.5px;margin-top:6px">${!n.project?'falta escolher o projeto':!todo.length?'nenhuma issue montada ainda':openQ?'ainda há perguntas em aberto — pode criar assim mesmo ou responder no chat':'revisado? é só confirmar'}${made&&todo.length?' · '+made+' já criadas ficam como estão':''}</div>`}</div></div></div>`;
  const on=(id,fn)=>{ const e=o.querySelector('#'+id); if(e) e.onclick=fn; };
  { const th=$id('trkNIThread'); if(th) th.scrollTop=th.scrollHeight; }
  { const i=$id('trkNIInput'); if(i){ i.value=iv; if(keep) i.focus(); i.onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); trkNISend(i.value); } }; } }
  on('trkNISend',()=>trkNISend($id('trkNIInput').value)); on('trkNIStop',trkNIStop);
  attRenderPend('trkNIPend', n.pend, trkNIRender);
  attWireComposer({ input:'trkNIInput', attach:'trkNIAttach', pend:()=>n.pend, taskId:()=>null, rerender:trkNIRender });
  o.querySelectorAll('[data-nichip]').forEach(b=>b.onclick=()=>trkNISend(n.chips[+b.dataset.nichip]));
  o.querySelectorAll('[data-nime]').forEach(b=>b.onclick=()=>{ trkNIKeep(); n.items[+b.dataset.nime].assignee=trkMe(); trkNIRender(); });
  o.querySelectorAll('[data-niskip]').forEach(b=>b.onclick=()=>{ trkNIKeep(); const it=n.items[+b.dataset.niskip]; it.skip=!it.skip; trkNIRender(); });
  o.querySelectorAll('[data-ni] .in').forEach(e=>e.onchange=()=>{ trkNIKeep(); });
  { const s=o.querySelector('#trkNIProj'); if(s) s.onchange=()=>{ trkNIKeep(); const p=n.projects[+s.value]; if(!p||p===n.project) return; n.project=p; n.sid=''; n.chips=[];
      n.msgs.push({ who:'sys', text:'projeto: '+p.name+' — a pesquisa recomeça neste repo' }); if(n.pendingText){ const t=n.pendingText; n.pendingText=''; trkNIRender(); trkNISend(t); return; } trkNIRender(); }; }
  const endConv=async()=>{ if(n.running) return; trkNIKeep();
    const left=trkNITodo().length; if(left && !confirm('Há '+left+' issue'+(left===1?'':'s')+' montada'+(left===1?'':'s')+' que ainda NÃO foram criadas. Encerrar mesmo assim?')) return;
    if(n.busy){ n.stop=true; try{ await invoke('issue_chat_stop'); }catch(_){ } }
    const keep=n.project; trkNI=trkNIBlank(); await trkNIProjects();
    const p=keep&&trkNI.projects.find(x=>x.path===keep.path);
    if(p){ trkNI.project=p; trkNI.msgs.push({ who:'bot', text:`Conversa nova, ainda no projeto **${p.name}** (troque ali em cima se for outro). Qual é a próxima issue — ou a próxima lista?` }); }
    else trkNIAskProject(true);
    trkNIRender(); const i=$id('trkNIInput'); if(i) i.focus(); };
  on('trkNINew',endConv); on('trkNIEnd',endConv); on('trkNIBoard',()=>{ closeTabOfKind('issuesbulk'); openTab('issues'); });
  on('trkNIClose',()=>{ closeTabOfKind('issuesbulk'); openTab('issues'); });
  on('trkNICreate',trkNICreate);
}
async function trkNICreate(){
  const n=trkNI; if(n.running) return; trkNIKeep(); if(!trkNIReady()) return;
  const canAssign=JSON.stringify((trkOp('create')||{}).body||{}).includes('{{assignee}}');
  n.running=true; trkNIRender();
  // épico agrupado pela IA: issue-mãe primeiro (quando o painel tem pai); as filhas nascem vinculadas
  let parent=null; const withParent=!!(n.epic&&trkParentSupport());
  if(n.epic&&!n.epicCode){
    try{
      const d=[n.epic.outcome||'', n.epic.doneWhen.length?'Pronto quando:\n'+n.epic.doneWhen.map((t,i)=>'- [ ] D'+(i+1)+': '+t).join('\n'):'', 'Projeto: '+n.project.name].filter(Boolean).join('\n\n');
      if(withParent){ parent=await trkCreateIssue(n.epic.title, d, n.epic.outcome||'', { type:trkEpicType() }); if(parent&&parent.code) n.epicCode=parent.code; }
    }catch(e){ n.msgs.push({ who:'sys', text:'Não criei a issue-mãe do épico: '+trkErrText(e)+' — as filhas saem soltas.' }); }
  }
  if(!parent&&n.epicCode) parent=trkIssues.find(i=>i.code===n.epicCode)||{ code:n.epicCode };
  const inCreateParent=trkCreateBodyHas('parent'), opChild=!!trk.connector.ops.addChild;
  for(const it of n.items){ // em série: preserva a ordem dos códigos e não estoura rate limit
    if(it.state==='ok'||it.skip||!it.title.trim()) continue;
    it.state='run'; it.err=''; trkNIRender();
    try{
      const description=[it.description, it.reqs.length?'Requisitos:\n'+it.reqs.map(r=>'- '+r).join('\n'):'', 'Projeto: '+n.project.name+(n.project.remote?' ('+n.project.remote+')':''),
        (it.assignee&&!canAssign)?'Responsável: '+((trkPerson(it.assignee)||{}).label||it.assignee):'',
        n.epic?('Épico: '+(parent&&parent.code?parent.code+' — ':'')+n.epic.title):''].filter(Boolean).join('\n\n');
      const i=await trkCreateIssue(it.title, description, it.goal, { assignee:it.assignee||'', priority:it.priority||'', type:it.type||(withParent?trkStoryType():''), parent:(withParent&&parent)?parent.code:'', parentId:(withParent&&parent)?(parent.id||''):'' });
      if(withParent&&parent&&i&&i.code&&!inCreateParent&&opChild){ try{ await trkCall('addChild',{ parent:parent.code, parentId:parent.id||'', child:i.code, childId:i.id||'' }); }catch(e){ console.warn('addChild', e); } }
      if(!i.code) throw new Error('o painel não devolveu o código da issue'); it.code=i.code; it.state='ok'; it.open=[];
    }catch(e){ it.state='fail'; it.err=trkErrText(e); }
    trkNIRender();
  }
  n.running=false; n.chips=[]; await trkPeopleFlush();
  const ok=n.items.filter(i=>i.state==='ok'), fail=n.items.filter(i=>i.state==='fail');
  n.msgs.push({ who:'bot', text:`Criei **${ok.length}** issue${ok.length===1?'':'s'}: ${ok.map(i=>'`'+i.code+'`').join(', ')||'—'}.${fail.length?` **${fail.length} falharam** — o erro está no cartão; ajuste e clique em confirmar de novo (só elas são reenviadas).`:' Pode mandar mais aqui, ou **encerrar e começar outra conversa** ali do lado.'}` });
  trkNIRender();
}
// Issue → tarefa JÁ PREENCHIDA: a descrição que o painel gera é "objetivo + Requisitos: - … + Projeto/Responsável";
// desmonta isso de volta (requisitos viram requisitos, metadados somem) e pula direto pra "Quem executa?".
function trkIssueSpec(i){
  const lines=String(i.description||'').replace(/\r/g,'').split('\n'); const obj=[], reqs=[]; let inReq=false;
  for(const raw of lines){ const l=raw.trim();
    if(/^requisitos:?$/i.test(l)){ inReq=true; continue; }
    if(/^(projeto|respons[aá]vel):/i.test(l)){ inReq=false; continue; } // metadados que o próprio painel anotou
    if(inReq){ if(!l){ inReq=false; continue; } reqs.push(l.replace(/^[-*•]\s*/,'')); continue; }
    obj.push(raw); }
  const r=i.raw||{}, goal=String(r.final_goal||r.goal||'').trim();
  return { title:i.title, objective:obj.join('\n').trim(), reqs:reqs.filter(Boolean), goal, bug:/bug/i.test(String(r.activity_type||r.type||'')) };
}
async function trkIssueToTask(i){
  const sp=trkIssueSpec(i);
  // listas ANTES de abrir (o formulário as renderiza ao abrir); campos de texto depois
  ntReq=[...new Set(sp.reqs)]; ntDel=sp.goal?[sp.goal]:[];
  // tudo que a issue já responde vem preenchido — cai em "Quem executa?"; sem requisitos suficientes pela política, para na etapa deles
  window.ntPresetStep=()=>ntReq.length>=Math.max(1,+((typeof ntPolicy!=='undefined'&&ntPolicy.minRequirements)||1))?3:2;
  if(window.openTab) window.openTab('form'); else await openNewTask();
  setNtMode('build');
  $id('ntTitle').value=sp.title.slice(0,90); $id('ntObj').value=sp.objective||sp.title;
  $id('ntIssue').value=i.code; { const u=$id('ntIssueUrl'); if(u) u.value=i.url||''; }
  { const b=$id('ntBranchType'); if(b&&sp.bug) b.value='fix'; }
  renderNtList('ntRequirements',ntReq); renderNtList('ntDeliverables',ntDel);
  { const e=$id('ntArtProof'); if(e) e.checked=true; }
}
function trkDetailHtml(){
  const i=trkIssues.find(x=>x.code===trkSel); if(!i) return '';
  const c=trk.connector, p=trkPerson(i.assignee), tasks=trkTasksFor(i.code);
  const free=((typeof state!=='undefined'&&state.tasks)||[]).filter(t=>!trkTaskCode(t));
  const comm=!c.ops.comments?`<p class="trk-rs">Este painel não expõe comentários pela API — observo status e atualizações.</p>`
    :trkComments===null?'<p class="trk-rs">carregando comentários…</p>'
    :(trkComments.map(m=>`<div class="trk-cm"><b>${esc(m.author||'—')}</b> <span class="dim">${trkAgo(m.createdAt)}</span><div>${esc(m.text||'')}</div></div>`).join('')||'<p class="trk-rs">nenhum comentário</p>')
     +(c.ops.addComment?`<div class="trk-bar" style="margin-top:8px"><input class="in" id="trkCmIn" placeholder="comentar…"><button class="btn" id="trkCmSend">enviar</button></div>`:'');
  return `<aside class="trk-detail"><div class="trk-ih"><span class="mono trk-code">${esc(i.code)}</span><span style="flex:1"></span>${i.url?`<button class="btn sm" data-lk="${escA(i.url)}">abrir ↗</button>`:''}<button class="x" id="trkDClose">✕</button></div>
    <h2 class="trk-dt">${esc(i.title)}</h2>
    <div class="trk-grid2" style="gap:10px"><label class="trk-f">Status<select class="in" id="trkDStatus"${c.ops.updateStatus?'':' disabled'}>${(c.statuses||[]).map(s=>`<option value="${escA(s.id)}"${s.id===i.status?' selected':''}>${esc(s.label||s.id)}</option>`).join('')}</select></label>
      <div class="trk-f">Com quem está${trkOp('assign')?`<div class="trk-bar" style="margin-top:6px"><input class="in" id="trkDWho" list="trkDPeople" value="${escA(i.assigneeEmail||(p&&!p.unnamed?p.full:''))}" placeholder="${c.assigneeFormat==='email'?'e-mail do responsável':'responsável'}"><button class="btn sm" id="trkDWhoSave">ok</button>${trkMe()&&i.assigneeEmail!==trkMe()?'<button class="btn sm primary" id="trkDMine" title="me colocar como responsável">ficar comigo</button>':''}<datalist id="trkDPeople">${trkPeopleList().map(x=>`<option value="${escA(x.id)}">${esc(x.name)}</option>`).join('')}</datalist></div>`:''}<div class="trk-if" style="margin-top:9px">${p?`<span class="trk-av">${esc(p.ini)}</span><span title="${escA(p.full)}">${esc(p.label)}</span>${p.unnamed?`<button class="btn sm" id="trkNamePerson" data-pid="${escA(p.full)}" style="padding:2px 7px;font-size:10.5px">dar nome</button>`:''}`:'<span class="dim">sem responsável</span>'}</div></div></div>
    ${i.tags.length?`<div class="trk-ops">${i.tags.map(t=>`<span class="trk-op">${esc(String(t))}</span>`).join('')}</div>`:''}
    ${i.description?`<div class="trk-desc">${esc(i.description)}</div>`:''}
    <div class="trk-ct" style="margin-top:16px">Tarefa no Constellation</div>
    ${tasks.map(t=>`<div class="trk-key"><span class="trk-task">⎇ ${esc(t.status||'')}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title||t.id)}</span><button class="btn sm" data-trkopen="${escA(t.id)}">abrir</button></div>`).join('')}
    <div class="trk-bar" style="margin-top:8px"><button class="btn primary" id="trkMkTask">criar tarefa desta issue</button>${free.length?`<select class="in" id="trkLinkSel" style="flex:1"><option value="">vincular a uma tarefa existente…</option>${free.map(t=>`<option value="${escA(t.id)}">${esc((t.title||t.id).slice(0,60))}</option>`).join('')}</select>`:''}</div>
    <div class="trk-ct" style="margin-top:16px">Comentários</div>${comm}
    <div class="trk-rs" style="margin-top:14px">${i.createdBy?'aberta por '+esc((trkPerson(i.createdBy)||{}).label||'')+' · ':''}criada ${trkAgo(i.createdAt)} · atualizada ${trkAgo(i.updatedAt)}</div></aside>`;
}
async function trkMove(code, statusId){
  const i=trkIssues.find(x=>x.code===code); if(!i||i.status===statusId||statusId==='__other') return;
  let reason='';
  if((trkStatus(statusId)||{}).kind==='blocked' && JSON.stringify(trk.connector.ops.updateStatus.body||{}).includes('{{reason}}')){ reason=await askText('Por que '+code+' está bloqueada?','motivo do bloqueio (opcional)')||''; }
  const old=i.status; i.status=statusId; issRender();
  try{ await trkCall('updateStatus',{ code:i.code, id:i.id, status:statusId, reason }); trkMine[i.code]=statusId; }
  catch(e){ i.status=old; trkErr='Não movi '+code+': '+trkErrText(e); issRender(); }
}
async function trkSelect(code){
  trkSel=code; trkComments=null; trkMarkSeen(code); issRender();
  const c=trk.connector, i=trkIssues.find(x=>x.code===code);
  if(c.ops.comments&&i){
    try{ const d=await trkCall('comments',{ code:i.code, id:i.id }); const f=c.ops.comments.fields||{};
      trkComments=(trkPath(d,c.ops.comments.itemsPath)||(Array.isArray(d)?d:[])).map(m=>({ author:(trkPerson(trkPath(m,f.author||'author'))||{}).label, text:trkPath(m,f.text||'text'), createdAt:trkPath(m,f.createdAt||'created_at') })); }
    catch(_){ trkComments=[]; }
    if(trkSel===code) issRender();
  }
}
function trkBoardWire(body){
  const on=(id,fn)=>{ const b=body.querySelector('#'+id); if(b) b.onclick=fn; };
  { const qi=body.querySelector('#trkQ'); if(qi) qi.oninput=()=>{ trkQ=qi.value; issRender(); const n=$id('trkQ'); if(n){ n.focus(); const v=n.value; n.value=''; n.value=v; } }; }
  body.querySelectorAll('[data-trkfilter]').forEach(b=>b.onclick=()=>{ trkFilter=b.dataset.trkfilter; issRender(); });
  on('trkRefresh', trkReload); on('trkMoreDone', ()=>{ trkMoreDone=true; issRender(); });
  on('trkNewBtn', trkNIOpen);
  body.querySelectorAll('[data-trkcode]').forEach(el=>{
    el.onclick=()=>trkSelect(el.dataset.trkcode);
    el.ondragstart=e=>{ e.dataTransfer.setData('text/plain', el.dataset.trkcode); e.dataTransfer.effectAllowed='move'; };
  });
  if(trk.connector.ops.updateStatus) body.querySelectorAll('[data-trkcol]').forEach(col=>{
    col.ondragover=e=>{ e.preventDefault(); col.classList.add('over'); };
    col.ondragleave=()=>col.classList.remove('over');
    col.ondrop=e=>{ e.preventDefault(); col.classList.remove('over'); trkMove(e.dataTransfer.getData('text/plain'), col.dataset.trkcol); };
  });
  on('trkDClose', ()=>{ trkSel=null; issRender(); });
  on('trkDMine', ()=>trkAssign(trkSel, trkMe()));
  on('trkDWhoSave', ()=>{ const v=($id('trkDWho').value||'').trim(); if(v) trkAssign(trkSel, v); });
  on('trkNamePerson', async()=>{ const id=body.querySelector('#trkNamePerson').dataset.pid; const n=await askText('Quem é '+id.slice(0,8)+'…? (vale pro time)','nome da pessoa'); if(!n) return;
    trk.people=Object.assign({}, trk.people||{}, { [id]:n.trim() }); await trkSave(); issRender(); });
  { const s=body.querySelector('#trkDStatus'); if(s) s.onchange=()=>trkMove(trkSel, s.value); }
  body.querySelectorAll('[data-trkopen]').forEach(b=>b.onclick=()=>openWorkspace(b.dataset.trkopen));
  body.querySelectorAll('.trk-detail [data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  { const s=body.querySelector('#trkLinkSel'); if(s) s.onchange=()=>{ if(!s.value) return; const l=trkLinks(); l[s.value]=trkSel; lsSet('trk:links',JSON.stringify(l)); issRender(); trkSyncAt=0; trkSyncTasks(); }; }
  on('trkMkTask', async()=>{ const i=trkIssues.find(x=>x.code===trkSel); if(i) trkIssueToTask(i); });
  on('trkCmSend', async()=>{ const t=($id('trkCmIn').value||'').trim(), i=trkIssues.find(x=>x.code===trkSel); if(!t||!i) return;
    try{ await trkCall('addComment',{ code:i.code, id:i.id, text:t }); }catch(e){ trkErr='Não comentei: '+trkErrText(e); } trkSelect(i.code); });
}

// ---------- observador em segundo plano (sem clique) ----------
function trkWatchStart(){
  if(trkTimer) return;
  trkTimer=setInterval(async()=>{
    if(Date.now()<trkNextAt) return; // em recuo depois de uma falha (rede/VPN/servidor lento)
    trkBg=true;
    try{
      await trkLoad(); if(!trkReady()||!trk.rules.watch||!(await trkProjectOn())) return;
      // chave ausente ou não liberada nesta máquina: não adianta bater no servidor (era 1 erro a cada 2 min por usuário)
      if(trkSecretNames().length){ await trkSecretsRefresh(); if(trkSecretsMissing().length) return; }
      await trkFetchIssues(); trkBackoffMs=0;
      if($id('issuesOverlay').style.display!=='none' && trkView==='board' && document.activeElement.id!=='trkQ' && document.activeElement.id!=='trkCmIn') issRender();
    }catch(_){
      trkBackoffMs=Math.min(Math.max(trkBackoffMs*2, 4*60000), 30*60000); // 4 → 8 → 16 → 30 min
      trkNextAt=Date.now()+trkBackoffMs;
    }
    finally{ trkBg=false; }
  }, 120000);
}
setTimeout(()=>{ trkLoad().then(()=>{ trkBadge(); if(trkReady()) trkWatchStart(); }).catch(()=>{}); }, 6000);
bindClick('issuesClose', ()=>{ $id('issuesOverlay').style.display='none'; });
$id('issuesOverlay').addEventListener('click',e=>{ if(e.target.id==='issuesOverlay') $id('issuesOverlay').style.display='none'; });
