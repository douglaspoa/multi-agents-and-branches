// Constellation — 33-previsao
// ========== Previsão de tempo e tokens antes de rodar (montar conversando) ==========
// Híbrida: Haiku classifica cada item em P/M/G (ai_estimate) e o histórico REAL do repo
// (estimate_history: tokens, US$ e duração por turno) converte pontos em tempo/tokens/US$.
// Funções puras (estCalibrate/estCompute) primeiro — testadas em scripts/test-previsao.mjs.

const EST_W={ P:1, M:3, G:8 };
const EST_LO=0.7, EST_HI=1.5;           // faixa = ponto × [0,7 ; 1,5]
const EST_MIN_HIST=5;                    // menos que isso → semente
const EST_SEED={ inTok:300000, outTok:8000, min:3, usd:{ opus:0.60, sonnet:0.25, haiku:0.06, outro:0.30 } };
const EST_ROLE_SEED={ planner:0.15, builder:0.6, reviewer:0.2, tester:0.2, designer:0.2, docs:0.1 };

function estFamily(model){ const m=String(model||'').toLowerCase(); return m.includes('opus')?'opus':m.includes('sonnet')?'sonnet':m.includes('haiku')?'haiku':'outro'; }
function estSize(s){ const x=String(s||'').trim().toUpperCase(); return EST_W[x]?x:'M'; }
// pontos de uma tarefa do histórico: previsão salva, senão 3 por requisito (tudo "M")
function estHistPoints(h){ const p=Number(h&&h.points); return p>0?p:3*Math.max(1, Number(h&&h.nReq)||1); }

// history: [{taskId, model, status, nReq, points|null, usd, inTok, outTok, ms, roles:[{role,usd,inTok,outTok,ms}]}]
// → { rates:{inTok,outTok,min,usd} por ponto, n, seeded, scope:'familia'|'todas'|'semente', roleShare:{role:fração}|null }
function estCalibrate(history, model){
  const fam=estFamily(model);
  const done=(Array.isArray(history)?history:[]).filter(h=>h && (Number(h.usd)||0)>0 && /^(review|done|merged)$/.test(h.status||'')); // só tarefas terminadas calibram
  const same=done.filter(h=>estFamily(h.model)===fam);
  const set = same.length>=EST_MIN_HIST ? same : done.length>=EST_MIN_HIST ? done : null;
  const scope = set===same&&set ? 'familia' : set ? 'todas' : 'semente';
  const seed={ inTok:EST_SEED.inTok, outTok:EST_SEED.outTok, min:EST_SEED.min, usd:EST_SEED.usd[fam] };
  if(!set) return { rates:seed, n:done.length, seeded:true, timeSeeded:true, scope, roleShare:null };
  const pts=set.reduce((s,h)=>s+estHistPoints(h),0);
  const sum=k=>set.reduce((s,h)=>s+(Number(h[k])||0),0);
  // tempo: só tarefas com duração medida (as antigas não têm ms); poucas → semente de tempo
  const timed=set.filter(h=>(Number(h.ms)||0)>0);
  const tPts=timed.reduce((s,h)=>s+estHistPoints(h),0);
  const timeSeeded = !(timed.length>=EST_MIN_HIST && tPts>0);
  const min = !timeSeeded ? timed.reduce((s,h)=>s+Number(h.ms),0)/60000/tPts : seed.min;
  const rates={ inTok:sum('inTok')/pts, outTok:sum('outTok')/pts, min, usd:sum('usd')/pts };
  // fatia média observada por papel (tokens do papel / tokens da tarefa)
  const acc={}; let nr=0;
  set.forEach(h=>{ const rs=Array.isArray(h.roles)?h.roles:[]; const tot=rs.reduce((s,r)=>s+(Number(r.inTok)||0)+(Number(r.outTok)||0),0); if(!(tot>0)) return; nr++;
    rs.forEach(r=>{ const k=r.role||'builder'; acc[k]=(acc[k]||0)+((Number(r.inTok)||0)+(Number(r.outTok)||0))/tot; }); });
  const roleShare = nr ? Object.fromEntries(Object.entries(acc).map(([k,v])=>[k,v/nr])) : null;
  return { rates, n:set.length, seeded:false, timeSeeded, scope, roleShare };
}

// fração de cada papel que vai rodar: observada (se TODOS os papéis têm histórico), senão pesos-semente; normalizada → soma 1
function estRoleShares(roles, roleShare){
  const rs=[...new Set((Array.isArray(roles)&&roles.length?roles:['builder']).map(r=>String(r||'builder')))];
  const obs = roleShare && rs.every(r=>(roleShare[r]||0)>0);
  const raw=rs.map(r=>obs?roleShare[r]:(EST_ROLE_SEED[r]!=null?EST_ROLE_SEED[r]:0.2));
  const t=raw.reduce((s,x)=>s+x,0)||1;
  return rs.map((r,i)=>({ role:r, share:raw[i]/t }));
}

// sized: [{text, size, files?, why?}] · roles: ['builder', …] · calib: saída de estCalibrate
function estCompute(sized, roles, calib){
  const r=(calib&&calib.rates)||{ inTok:EST_SEED.inTok, outTok:EST_SEED.outTok, min:EST_SEED.min, usd:EST_SEED.usd.outro };
  const val=p=>{ const inTok=p*r.inTok, outTok=p*r.outTok, min=p*r.min; return { inTok, outTok, tok:inTok+outTok, usd:p*r.usd, min, minLo:min*EST_LO, minHi:min*EST_HI }; };
  const items=(Array.isArray(sized)?sized:[]).map(x=>{ const size=estSize(x&&x.size); const points=EST_W[size]; return { text:String((x&&x.text)||''), size, points, files:(x&&x.files)||0, why:(x&&x.why)||'', ...val(points) }; });
  const points=items.reduce((s,x)=>s+x.points,0);
  const total=val(points);
  const byRole=estRoleShares(roles, calib&&calib.roleShare).map(({role,share})=>({ role, share, tok:total.tok*share, usd:total.usd*share, min:total.min*share }));
  return { points, total, items, roles:byRole, n:(calib&&calib.n)||0, seeded:!!(calib&&calib.seeded), timeSeeded:!calib||calib.timeSeeded!==false, scope:(calib&&calib.scope)||'semente' };
}

// ---------------- estado + UI (só roda no app) ----------------
let estEnabled=null;                 // null = ainda não leu settings; ausente = ligado
const estAiCache=new Map();          // chave do conteúdo → [{size,files,why}]  (nunca 2 chamadas pro mesmo texto)
let estTimer=null, estKeyShown='', estKeyPending='', estLast=null, estBusy=false, estOpen=false, estAiFail=false;
let estHist=null, estHistAt=0;
const estSavedCache={}, estFetching={}; // tarefa → previsão salva (null = sem previsão)

function estSetEnabled(on){ estEnabled=!!on; clearTimeout(estTimer); estLast=null; estKeyShown=''; estKeyPending=''; estBusy=false; estPaint(); if(estEnabled) estSchedule(); }
async function estLoadEnabled(){
  if(estEnabled!==null) return estEnabled;
  try{ const o=JSON.parse((await invoke('read_settings'))||'{}'); const v=o.estimateEnabled; estEnabled=!(v===false||v==='0'||v==='false'); }catch(_){ estEnabled=true; }
  return estEnabled;
}
try{ if(typeof invoke==='function') estLoadEnabled(); }catch(_){ }

function estDraft(){
  if(typeof plFields==='undefined') return null;
  const items=[...new Set([...(plFields.requirements||[]), ...(plFields.deliverables||[])].map(x=>String(x).trim()).filter(Boolean))];
  const model=plFields.model||((typeof aiDefaults==='function'&&aiDefaults().model)||'');
  return { title:String(plFields.title||'').trim(), objective:String(plFields.objective||'').trim(), items, model, roles:['builder'] }; // planner: workflow null → 1 builder
}
function estKey(d){ return JSON.stringify([d.title, d.objective, d.items, d.model]); }
async function estHistory(){
  if(estHist && Date.now()-estHistAt<60000) return estHist;
  try{ estHist=await invoke('estimate_history'); }catch(_){ estHist=estHist||[]; }
  estHistAt=Date.now(); return estHist||[];
}

// chamado quando os campos do planner mudam: debounce de 1,5 s; conteúdo idêntico reusa o cache
function estSchedule(){
  clearTimeout(estTimer);
  if(estEnabled===false) return;
  const ready=(typeof plReady==='function')&&plReady();
  const d=ready?estDraft():null;
  if(!d||!d.items.length){ estKeyPending=''; estBusy=false; estPaint(); return; } // rascunho incompleto: sem chamada de IA
  const key=estKey(d);
  if(key===estKeyShown||key===estKeyPending) return;
  if(estAiCache.has(key)){ estRun(d, key); return; }
  estTimer=setTimeout(()=>estRun(d, key), 1500);
}
async function estRun(d, key){
  if(!(await estLoadEnabled())){ estPaint(); return; }
  estKeyPending=key; estBusy=true; estPaint();
  let sized=estAiCache.get(key), fail=false;
  if(!sized){
    try{ const r=await invoke('ai_estimate',{ title:d.title, objective:d.objective, items:d.items, model:d.model||null }); if(!Array.isArray(r)) throw new Error('resposta inválida'); sized=r; estAiCache.set(key, sized); }
    catch(_){ fail=true; sized=d.items.map(()=>({ size:'M' })); } // falha não entra no cache: tenta de novo na próxima edição
  }
  const calib=estCalibrate(await estHistory(), d.model);
  if(estKeyPending!==key) return; // chegou outra edição no meio — a mais nova vence
  const est=estCompute(d.items.map((text,i)=>Object.assign({ text }, sized[i]||{ size:'M' })), d.roles, calib);
  estLast=Object.assign(est, { model:d.model, aiFail:fail, at:Date.now() });
  estKeyShown=key; estKeyPending=''; estBusy=false; estAiFail=fail;
  estPaint();
}

function estFmtMin(m){ m=Math.max(0,m||0); return m<10?(Math.round(m*10)/10).toString().replace('.',','):String(Math.round(m)); }
function estFmtTok(n){ n=Math.round(n||0); if(n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1).replace('.',',')+'M'; return (typeof fmtTok==='function')?fmtTok(n):String(n); }
function estPlannerInner(){
  if(estEnabled===false || typeof plReady!=='function' || !plReady()) return '';
  if(!estLast) return `<div class="plesth mono">PREVISÃO <span class="dim">${estBusy?'· calculando…':'· aguardando'}</span></div>`;
  const e=estLast, t=e.total;
  const note = e.aiFail ? 'IA indisponível — tamanho médio' : e.seeded ? 'sem histórico ainda — estimativa inicial' : `calibrado com ${e.n} tarefa${e.n===1?'':'s'}`+(e.timeSeeded?' · tempo ainda pela estimativa inicial':'');
  const rows=e.items.map(x=>`<div class="plestr"><span class="plestsz">${x.size}</span><span class="plesttx" title="${escA(x.why||'')}">${esc(x.text)}</span><span>~${estFmtTok(x.tok)} tok</span><span>${estFmtMin(x.min)} min</span></div>`).join('');
  const roles=e.roles.map(r=>`<div class="plestr"><span class="plestsz">${Math.round(r.share*100)}%</span><span class="plesttx">${esc(r.role)}</span><span>~${estFmtTok(r.tok)} tok</span><span>${estFmtMin(r.min)} min</span></div>`).join('');
  return `<details class="plestd"${estOpen?' open':''}><summary class="mono"><span class="plesth">PREVISÃO${estBusy?' <span class="dim">· recalculando…</span>':''}</span>
      <span class="plestv">⏱ ${estFmtMin(t.minLo)}–${estFmtMin(t.minHi)} min · ~${estFmtTok(t.tok)} tok · ~${(typeof fmtUsd==='function'?fmtUsd(t.usd):'$'+(t.usd||0).toFixed(2))}</span></summary>
    <div class="plestb mono"><div class="plestsec">POR REQUISITO</div>${rows}<div class="plestsec">POR ETAPA</div>${roles}</div></details>
    <div class="plestn dim">${esc(note)}</div>`;
}
function estPlannerHtml(){ return `<div id="plEst" class="plest">${estPlannerInner()}</div>`; }
function estPaint(){
  const el=(typeof $id==='function')?$id('plEst'):null; if(!el) return;
  el.innerHTML=estPlannerInner(); el.style.display=el.innerHTML?'':'none';
  const d=el.querySelector('details'); if(d) d.ontoggle=()=>{ estOpen=d.open; };
}

// grava a previsão EXIBIDA junto da tarefa recém-criada (best-effort: nunca impede criar)
async function estSaveFor(taskId){
  if(!taskId || estEnabled===false || !estLast) return;
  const d=estDraft(); if(!d || estKey(d)!==estKeyShown){ estLast=null; estKeyShown=''; return; } // rascunho mudou depois do cálculo: não grava previsão velha
  const e=estLast;
  const json={ v:1, at:Date.now(), model:e.model||'', points:e.points, n:e.n, seeded:e.seeded, aiFail:!!e.aiFail,
    total:e.total, items:e.items.map(x=>({ text:x.text, size:x.size, points:x.points, tok:x.tok, min:x.min, usd:x.usd })),
    roles:e.roles };
  try{ await invoke('save_estimate',{ taskId:String(taskId), json:JSON.stringify(json) }); estSavedCache[taskId]=json; }catch(err){ console.warn('previsão não salva', err); }
  estLast=null; estKeyShown='';
}

// chip "previsto × real" na barra da tarefa (sem previsão salva → sem chip)
function estChipInner(t, e){
  if(!e||!e.total) return '';
  const cs=(typeof costsOf==='function')?costsOf(t.id):[];
  const realMs=cs.reduce((s,c)=>s+(c.ms||0),0);
  const realTok=cs.reduce((s,c)=>s+(c.inTok||0)+(c.outTok||0),0);
  const real=(realMs>0?`real ${estFmtMin(realMs/60000)} min`:'real — min')+` · ${estFmtTok(realTok)} tok`;
  const byRole={}; cs.forEach(c=>{ const k=c.role||'builder'; const o=byRole[k]||(byRole[k]={ tok:0, usd:0, ms:0 }); o.tok+=(c.inTok||0)+(c.outTok||0); o.usd+=c.usd||0; o.ms+=c.ms||0; });
  const names=[...new Set([...(e.roles||[]).map(r=>r.role), ...Object.keys(byRole)])];
  const tip=['previsto × real'].concat(names.map(n=>{ const p=(e.roles||[]).find(r=>r.role===n)||{ tok:0, usd:0, min:0 }; const r=byRole[n]||{ tok:0, usd:0, ms:0 };
    return `${n}: ${estFmtTok(p.tok)} tok ${(typeof fmtUsd==='function'?fmtUsd(p.usd):'$'+(p.usd||0).toFixed(2))} ${estFmtMin(p.min)} min × ${estFmtTok(r.tok)} tok ${(typeof fmtUsd==='function'?fmtUsd(r.usd):'$'+(r.usd||0).toFixed(2))} ${estFmtMin(r.ms/60000)} min`; })).join('\n');
  return `<span class="mono dim" style="font-size:11px" title="${escA(tip)}">prev ${estFmtMin(e.total.minLo)}–${estFmtMin(e.total.minHi)} min · ~${estFmtTok(e.total.tok||0)} tok · ${real}</span>`;
}
function estChipHtml(t){
  if(!t) return '';
  const e=estSavedCache[t.id];
  if(e===undefined && !estFetching[t.id]){
    estFetching[t.id]=true;
    invoke('get_estimate',{ taskId:t.id }).then(s=>{ let v=null; try{ v=s?JSON.parse(s):null; }catch(_){ }
      estSavedCache[t.id]=v; const el=$id('fwEst'); if(el&&el.dataset.t===t.id) el.innerHTML=estChipInner(t, v); })
      .catch(()=>{ estSavedCache[t.id]=null; }).finally(()=>{ delete estFetching[t.id]; });
  }
  return `<span id="fwEst" data-t="${escA(t.id)}">${estChipInner(t, e)}</span>`;
}
