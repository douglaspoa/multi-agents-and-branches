// @cor-dado-inicio — cor padrão do agente (gravada; o <input type=color> exige hex — mesma do PALETTE[0] de 33)
const AG_COLOR0='#1e9e4a';
// @cor-dado-fim
// Starfork — 61-meu-time
// "MEU TIME" (F3 da decisão da mesa de 03/10/2026): a aba Agentes & Equipes vira a página do time.
//  - cartões com rosto, "o que faz" numa frase e CONTAGENS CRUAS com o n à vista ("3 de 7 de primeira");
//    abaixo de n = 10, "ainda conhecendo esse agente"; porcentagem só com n ≥ 10 (regra única: agStatsView);
//  - ficha do agente DENTRO da aba (render próprio): cabeçalho motor · modelo · versão e 3 abas
//    Histórico / Aprendizados / Editar (ajustes avançados);
//  - equipes prontas pelo tipo de entrega (FLOW_BY_KIND) com a MESMA faixa da tarefa (stageStripHtml) e o custo médio
//    por papel; "Montar minha equipe" mostra a faixa e o aviso "revisor igual ao builder".
// O boletim sai de UMA query (comando `agent_stats`, Rust) chamada ao ABRIR a aba — sem polling, sem timer.
// F4 (P12): antes × depois de cada versão do agente, no MESMO tipo de tarefa, a partir do evento `papel` gravado no início
// de cada papel (a versão desde o aceite). Limiares por lado: < 5 "ainda medindo"; 5–9 contagens cruas; ≥ 10 % e, se algo
// piorou além da margem, "voltar pro jeito antigo?". Regra única: agBeforeAfter. A palavra da Júlia nunca aparece.

// @meutime-puro-inicio (testado em app/tests/meu-time.test.mjs — sem DOM nem estado global)
const AG_MIN_N=10;
const AG_DOES={ planner:'planeja a tarefa e lista os riscos', builder:'constrói o código', reviewer:'revisa código e documentos',
  designer:'desenha a tela antes do código', tester:'escreve e roda os testes', docs:'escreve documentos e relatórios',
  security:'procura falhas de segurança', investigator:'investiga e explica o que encontrou' };
const AG_GATE_ST=['review','delivered','done','merged','closed'];
function agReachedGate(r){ return !!r && (AG_GATE_ST.includes(r.status) || !!r.prUrl); }
function agFirstTry(r){ return agReachedGate(r) && !(+r.reworks>0) && !(+r.muda>0); }
// frase em português: tira o ponto final e põe a 1ª letra em minúscula (sem mexer em sigla: "API …" fica)
function agLow(t){ t=String(t||'').replace(/\s+/g,' ').trim().replace(/[.;:!]+$/,''); return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(t)?t.charAt(0).toLowerCase()+t.slice(1):t; }
function agUsdBr(n){ const v=Math.round((Number(n)||0)*100)/100; return 'US$ '+v.toFixed(2).replace('.',','); }
// "o que faz" numa frase: a do papel; papel desconhecido → a 1ª frase da persona
function agDoes(a){
  const k=String((a&&a.role)||'').toLowerCase();
  if(AG_DOES[k]) return AG_DOES[k];
  const p=String((a&&a.persona)||'').replace(/^você\s+/i,'').split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/,'').trim();
  return p ? p.charAt(0).toLowerCase()+p.slice(1, 90) : 'ainda sem descrição';
}
/**
 * Boletim de UM agente a partir das linhas do agent_stats (uma por tarefa em que ele trabalhou). Puro.
 * n = tarefas que chegaram ao portão; "de primeira" = chegaram sem retrabalho nem veredito "muda".
 * Abaixo de minN: contagens cruas + "ainda conhecendo esse agente"; % só com n ≥ minN. O nome não entra (a chave é o
 * agent_id — renomear não muda nada).
 */
function agStatsView(rows, minN, o){
  minN=minN==null?AG_MIN_N:minN; o=o||{};
  rows=Array.isArray(rows)?rows:[];
  const byTask=new Map(); for(const r of rows) if(r&&r.taskId!=null&&!byTask.has(r.taskId)) byTask.set(r.taskId, r);
  const list=[...byTask.values()];
  const tasks=list.length, gate=list.filter(agReachedGate), n=gate.length, first=gate.filter(agFirstTry).length;
  const totalUsd=list.reduce((s,r)=>s+(+r.usd||0),0), avgUsd=tasks?totalUsd/tasks:0;
  const reworkTasks=list.filter(r=>+r.reworks>0).length;
  const rev=list.filter(r=>+r.rounds>0), rounds=rev.reduce((s,r)=>s+(+r.rounds||0),0), returned=rev.filter(r=>+r.muda>0).length;
  const knowing=n<minN;
  const pct=knowing||!n?null:Math.round(first/n*100);
  const lembra=Math.max(0, +o.lembra||0);
  const parts=[tasks+(tasks===1?' tarefa':' tarefas')];
  if(n) parts.push(first+' de '+n+' de primeira'+(pct!=null?' ('+pct+'%)':''));
  if(rev.length) parts.push('devolveu '+returned+' de '+rev.length);
  if(tasks) parts.push('~'+agUsdBr(avgUsd)+'/tarefa');
  if(lembra) parts.push('lembra '+lembra+(lembra===1?' coisa':' coisas'));
  return { tasks, n, first, pct, totalUsd, avgUsd, reworkTasks, rounds, returned, reviewed:rev.length, lembra, knowing,
    line:parts.join(' · '), note:knowing?'ainda conhecendo esse agente':'' };
}
// diff por linha (LCS) pro histórico da persona: [{ t:'='|'-'|'+', s }]
function agLineDiff(a, b){
  const A=String(a==null?'':a).split('\n'), B=String(b==null?'':b).split('\n');
  const n=A.length, m=B.length; if(n*m>40000) return [...A.map(s=>({ t:'-', s })), ...B.map(s=>({ t:'+', s }))];
  const L=Array.from({ length:n+1 }, ()=>new Int32Array(m+1));
  for(let i=n-1;i>=0;i--) for(let j=m-1;j>=0;j--) L[i][j]=A[i]===B[j]?L[i+1][j+1]+1:Math.max(L[i+1][j], L[i][j+1]);
  const out=[]; let i=0, j=0;
  while(i<n&&j<m){ if(A[i]===B[j]){ out.push({ t:'=', s:A[i] }); i++; j++; } else if(L[i+1][j]>=L[i][j+1]) out.push({ t:'-', s:A[i++] }); else out.push({ t:'+', s:B[j++] }); }
  while(i<n) out.push({ t:'-', s:A[i++] }); while(j<m) out.push({ t:'+', s:B[j++] });
  return out;
}
// P5: o revisor no MESMO motor e modelo de quem produziu (≡ reviewerIsSame/producerIndex de src/lifecycle.ts)
const AG_SAME_REVIEWER='revisor igual ao builder — revisão menos independente';
function agEngineKey(e){ const n=String(e||'').trim().toLowerCase(); return n.startsWith('codex')?'codex':(n.startsWith('deepseek')||/^dsh\b/.test(n))?'deepseek':n.startsWith('gateway')||n.startsWith('logcomex')?'gateway':n==='mock'?'mock':'claude'; }
function agProducerIdx(roles, ri){ for(let j=ri-1;j>=0;j--) if(['builder','docs','designer'].includes(roles[j].role)) return j; return -1; }
function agSame(a, b){ return !!a && !!b && agEngineKey(a.engine)===agEngineKey(b.engine) && String(a.model||'').trim().toLowerCase()===String(b.model||'').trim().toLowerCase(); }
// papéis de uma equipe (ids de agente → papéis). diversify = o que a tarefa por TIPO faz (diversifyReviewer): no Claude o
// revisor vai pra outro modelo; equipe montada à mão roda como está (e por isso avisa).
function agTeamRoles(steps, byId, diversify){
  const roles=(steps||[]).map(id=>byId[id]).filter(Boolean).map(a=>({ agentId:a.id, name:a.name, role:a.role||'builder', engine:a.engine||'claude', model:a.model||'', color:a.color }));
  if(!diversify) return roles;
  const ri=roles.findIndex(r=>r.role==='reviewer'), pi=ri>=0?agProducerIdx(roles, ri):-1;
  if(ri<0||pi<0||!agSame(roles[pi], roles[ri]) || agEngineKey(roles[pi].engine)!=='claude') return roles;
  const m=String(roles[pi].model||'').toLowerCase();
  return roles.map((r,i)=>i===ri?Object.assign({}, r, { model:m.includes('sonnet')?'opus':'sonnet' }):r);
}
function agTeamWarnings(roles){
  const out=[];
  (roles||[]).forEach((r,i)=>{ if(r.role!=='reviewer') return; const pi=agProducerIdx(roles, i); if(pi>=0 && agSame(roles[pi], r)) out.push({ idx:i, text:AG_SAME_REVIEWER, detail:r.name+' e '+roles[pi].name+' no mesmo motor e modelo' }); });
  return out;
}
// custo médio por papel (US$/tarefa) a partir das linhas de todos os agentes: { role: { usd, n } }
function agAvgByRole(rows){
  const acc={};
  for(const r of (rows||[])){ const k=r.role||''; if(!k) continue; const a=acc[k]=acc[k]||{ usd:0, tasks:new Set() }; a.usd+=(+r.usd||0); a.tasks.add(r.taskId); }
  const out={}; for(const k of Object.keys(acc)){ const n=acc[k].tasks.size; out[k]={ usd:n?acc[k].usd/n:0, n }; }
  return out;
}
// etapas de uma equipe pra MESMA faixa da tarefa (stageStripHtml): papéis + Provar + Entregar (cadeado 2) + Retro
function agTeamStages(roles, avg, doing, labels){
  avg=avg||{}; doing=doing||{}; labels=labels||{};
  const st=(roles||[]).map((r,i)=>({ id:r.role, label:r.label||labels[r.role]||r.role, role:r.role, who:r.name, state:'espera', word:doing[r.role]||'trabalha', usd:(avg[r.role]&&avg[r.role].usd)||0, lock:r.role==='planner'?1:0, idx:i }));
  st.push({ id:'provar', label:'Provar', state:'espera', word:'prova', lock:0 }, { id:'entregar', label:'Entregar', state:'espera', word:'você aprova', lock:2 }, { id:'retro', label:'Retro', state:'espera', word:'aprende', lock:0 });
  return st;
}
// custo médio da equipe: soma das médias por papel (só papéis com histórico); n = o menor histórico entre eles
function agTeamCost(roles, avg){
  let usd=0, n=Infinity, any=false;
  for(const r of (roles||[])){ const a=avg&&avg[r.role]; if(a&&a.n){ usd+=a.usd; n=Math.min(n, a.n); any=true; } }
  return any ? { usd, n } : null;
}
// ---------------------------------------------------------------- F4 · P12: antes × depois por versão
const AG_BA_LOW=5;                              // abaixo disso em algum lado: "ainda medindo" (nenhum número de métrica)
const AG_BA_MARGIN={ pts:10, rel:0.10, abs:0.05 }; // "piorou": prova de primeira −10 pontos; médias +10% (e +0,05 no mínimo)
const AG_KINDS=['codigo','pagina','pesquisa','documento'];
const AG_KIND_LABEL={ codigo:'Código', pagina:'Página/tela', pesquisa:'Pesquisa', documento:'Documento' };
// tipo da tarefa da linha (≡ taskKindOf de 60-ciclo/lifecycle): sem tipo gravado = pelo branchType; sem nada = Código
function agKindOfRow(r){ const k=String((r&&r.kind)||''); if(AG_KINDS.includes(k)) return k; const b=String((r&&r.branchType)||'').toLowerCase(); return b==='design'?'pagina':b==='docs'?'documento':b==='invest'?'pesquisa':'codigo'; }
// versão do agente no 1º evento `papel` da tarefa: "skills ativas: a@v3, b@v1 · nyx@v4 · codex" → 4 (ilegível → null)
function agVerOf(text){
  const parts=String(text==null?'':text).split(' · ');
  if(parts.length<2 || !/^skills ativas:/.test(parts[0])) return null;
  const m=/^\S.*@v(\d+)$/.exec(parts[1].trim()); return m?+m[1]:null;
}
// a versão que valia a partir de um instante (fallback quando a versão do aceite saiu das últimas 5): a da 1ª tarefa medida depois
function agVersionAt(rows, at){
  let best=null, bt=Infinity;
  for(const r of (rows||[])){ const v=agVerOf(r&&r.papel); if(v==null||!(+r.createdAt>=+at)) continue; if(+r.createdAt<bt){ bt=+r.createdAt; best=v; } }
  return best;
}
// a versão do agente que um aprendizado criou: nota = n.v; skill = a entrada "skill" com o nome dela; senão, pela data
function agLearnVersion(kind, item, versions, rows){
  if(kind==='nota' && +item.v>0) return +item.v;
  const vs=(versions||[]).filter(x=>x && x.change==='skill' && x.what===item.name);
  if(vs.length) return +vs[vs.length-1].v;
  const at=+item.at||0; return at>0?agVersionAt(rows, at):null;
}
function agBaRows(rows){ const m=new Map(); for(const r of (rows||[])) if(r&&r.taskId!=null&&!m.has(r.taskId)) m.set(r.taskId, r); return [...m.values()].filter(r=>agReachedGate(r) && agVerOf(r.papel)!=null); }
// tipos com tarefa medida, o com mais comparação primeiro (o menor lado decide)
function agBaKinds(rows, v){
  const acc={};
  for(const r of agBaRows(rows)){ const k=agKindOfRow(r), a=acc[k]||(acc[k]={ kind:k, label:AG_KIND_LABEL[k], nb:0, na:0 }); if(v!=null && agVerOf(r.papel)<v) a.nb++; else a.na++; }
  return Object.values(acc).sort((a,b)=>(Math.min(b.nb,b.na)-Math.min(a.nb,a.na)) || ((b.nb+b.na)-(a.nb+a.na)) || AG_KINDS.indexOf(a.kind)-AG_KINDS.indexOf(b.kind));
}
function agPlural(n, um, varios){ return n+' '+(n===1?um:varios); }
function agNum(x){ return (Math.round(x*10)/10).toFixed(1).replace('.',','); }
function agRel(b, a){ if(!(b>0)) return a>0?'antes era 0':'igual'; const d=Math.round((a-b)/b*100); return d===0?'igual':(d>0?'+':'−')+Math.abs(d)+'%'; }
/**
 * Antes × depois da versão `v` (P12). Puro. rows = linhas do agent_stats DESTE agente; o = { kind, minN=10, lowN=5 }.
 * Só tarefas que chegaram ao portão, do MESMO tipo, com a versão gravada no `papel` (sem isso = não medida).
 * antes = versão < v; depois = versão ≥ v. stage: 'medindo' (algum lado < lowN) | 'cru' (< minN) | 'pct' (≥ minN nos dois).
 */
function agBeforeAfter(rows, v, o){
  o=o||{}; const minN=o.minN==null?AG_MIN_N:o.minN, lowN=o.lowN==null?AG_BA_LOW:o.lowN;
  const kind=AG_KINDS.includes(o.kind)?o.kind:'codigo';
  const side=()=>({ n:0, first:0, rounds:0, rework:0, usd:0, fcN:0, fcPrev:0, fcReal:0, fcErr:0 });
  const B=side(), A=side();
  if(v!=null) for(const r of agBaRows(rows)){
    if(agKindOfRow(r)!==kind) continue;
    const s=agVerOf(r.papel)<v?B:A;
    s.n++; if(agFirstTry(r)) s.first++;
    s.rounds+=+(r.trounds!=null?r.trounds:r.rounds)||0; s.rework+=+r.reworks||0; s.usd+=+r.usd||0;
    const p=+r.prevUsd, real=+r.tusd;
    if(p>0 && real>0){ s.fcN++; s.fcPrev+=p; s.fcReal+=real; s.fcErr+=Math.abs(real-p)/p; }
  }
  const nb=B.n, na=A.n, k=Math.min(nb, na);
  const base={ v, kind, kindLabel:AG_KIND_LABEL[kind], nb, na, k, minN, metrics:[], worse:[], offerBack:false };
  if(v==null || nb<lowN || na<lowN) return Object.assign(base, { stage:'medindo', text:'ainda medindo ('+k+' de '+minN+')' });
  const tk=n=>agPlural(n, 'tarefa', 'tarefas');
  if(nb<minN || na<minN){
    const raw=(s)=>({
      first:s.first+' de '+s.n,
      rounds:agPlural(s.rounds, 'rodada', 'rodadas')+' em '+tk(s.n),
      rework:agPlural(s.rework, 'retrabalho', 'retrabalhos')+' em '+tk(s.n),
      usd:agUsdBr(s.usd)+' em '+tk(s.n),
      fc:s.fcN?'previsto '+agUsdBr(s.fcPrev)+' · real '+agUsdBr(s.fcReal)+' ('+tk(s.fcN)+')':'sem previsão salva' });
    const rb=raw(B), ra=raw(A);
    base.metrics=[['first','prova de primeira'],['rounds','rodadas de revisão'],['rework','retrabalho'],['usd','custo dele'],['fc','previsto × real']].map(([key,label])=>({ key, label, before:rb[key], after:ra[key], change:'', worse:false }));
    return Object.assign(base, { stage:'cru', text:'lado a lado, sem conclusão: '+tk(nb)+' antes e '+tk(na)+' depois — a comparação só vale com '+minN+' de cada lado' });
  }
  const pct=s=>Math.round(s.first/s.n*100);
  const worseAvg=(b,a)=>a>b+Math.max(b*AG_BA_MARGIN.rel, AG_BA_MARGIN.abs);
  const m=[];
  const pb=pct(B), pa=pct(A), dp=pa-pb;
  m.push({ key:'first', label:'prova de primeira', before:pb+'% ('+B.first+' de '+B.n+')', after:pa+'% ('+A.first+' de '+A.n+')', change:dp===0?'igual':(dp>0?'+':'−')+Math.abs(dp)+' pontos', worse:pb-pa>=AG_BA_MARGIN.pts });
  const avg=(key, label, fb, fa, fmt)=>m.push({ key, label, before:fmt(fb), after:fmt(fa), change:agRel(fb, fa), worse:worseAvg(fb, fa) });
  avg('rounds', 'rodadas de revisão', B.rounds/B.n, A.rounds/A.n, x=>agNum(x)+' por tarefa');
  avg('rework', 'retrabalho', B.rework/B.n, A.rework/A.n, x=>agNum(x)+' por tarefa');
  avg('usd', 'custo dele', B.usd/B.n, A.usd/A.n, x=>agUsdBr(x)+' por tarefa');
  if(B.fcN>=minN && A.fcN>=minN){
    const eb=B.fcErr/B.fcN, ea=A.fcErr/A.fcN;
    m.push({ key:'fc', label:'erro da previsão', before:'erra '+Math.round(eb*100)+'% em média', after:'erra '+Math.round(ea*100)+'% em média', change:agRel(eb, ea), worse:worseAvg(eb, ea) });
  } else m.push({ key:'fc', label:'erro da previsão', before:B.fcN+' com previsão', after:A.fcN+' com previsão', change:'poucas previsões pra comparar', worse:false });
  base.metrics=m; base.worse=m.filter(x=>x.worse).map(x=>x.label); base.offerBack=base.worse.length>0;
  return Object.assign(base, { stage:'pct', text:base.offerBack?'parece ter atrapalhado ('+base.worse.join(', ')+') — voltar pro jeito antigo?':'antes × depois com '+tk(nb)+' e '+tk(na)+': nada pesou além da margem' });
}
// @meutime-puro-fim

// ---------------------------------------------------------------- estado da página (contido aqui)
const AGS={ rows:null, lembra:{}, ms:0, repo:'', err:'' };   // boletim de todos (uma chamada ao abrir a aba)
const AGF={ id:null, tab:'historico', card:null, pend:[], err:'', kind:null }; // a ficha aberta (kind = tipo da comparação antes/depois)
function agVisible(){ const o=$id('agOverlay'); return !!(o && o.style.display!=='none'); }
async function agStatsLoad(){
  const repo=state.repo||''; AGS.repo=repo; AGS.err='';
  try{ const r=await invoke('agent_stats',{ repo, agentId:null })||{}; if(AGS.repo!==repo) return; AGS.rows=r.rows||[]; AGS.lembra=r.lembra||{}; AGS.ms=+r.ms||0; }
  catch(e){ AGS.rows=[]; AGS.err=(typeof errShort==='function')?errShort(e):String(e&&e.message||e); }
}
function agRowsOf(id){ return (AGS.rows||[]).filter(r=>r.agentId===id); }
function agViewOf(a){ return agStatsView(agRowsOf(a.id), AG_MIN_N, { lembra:AGS.lembra[a.id]||0 }); }
function agRunLabel(a){ return (typeof aiRunLabel==='function')?aiRunLabel(a.engine||'claude', a.model||''):[a.engine||'claude', a.model||'padrão'].join(' · '); }

// cartão da grade (o editor antigo foi pra aba Editar da ficha)
function agCardHtml(a, i){
  const v=AGS.rows?agViewOf(a):null;
  const stats=v?`<span class="agc-s">${esc(v.line)}</span>${v.note?`<span class="agc-k">${esc(v.note)}</span>`:''}`:`<span class="agc-s ld">lendo o que ${esc(a.name||'ele')} já fez…</span>`;
  return `<li class="agcard"><button class="agcard-b" data-open="${i}" data-agtile="${i}" draggable="true" title="${escA(agRunLabel(a)+' · arraste pra dentro de uma equipe')}">
    <span class="av" style="background:${escA(a.color||AG_COLOR0)}">${avatarInner(a)}</span>
    <span class="agc-tx"><span class="agc-n">${esc(a.name||'—')}<span class="agc-r">${esc(roleLabel(a.role))}</span></span>
    <span class="agc-d">${esc(agDoes(a))}</span>${stats}</span></button></li>`;
}

// ---------------------------------------------------------------- a ficha
function agFichaOpen(id, tab){
  if(AGF.id!==id) AGF.kind=null;
  AGF.id=id; AGF.tab=tab||'historico'; AGF.card=null; AGF.pend=null; AGF.err='';
  agShowFicha(true); agFichaRender(); agFichaLoad();
}
function agShowFicha(on){
  const h=$id('agHome'), f=$id('agFicha'); if(h) h.hidden=!!on; if(f) f.hidden=!on;
  if(!on){ AGF.id=null; const t=$id('agTitle'); if(t) t.textContent='Meu time'; }
}
async function agFichaLoad(){
  const id=AGF.id, repo=state.repo||''; if(!id) return;
  try{
    // o curador não segura a ficha: pinta quando chegar (1×/dia; o resto do dia é só um arquivo)
    if(typeof curLoad==='function') curLoad(repo).then(()=>{ if(AGF.id===id && AGF.tab==='aprendizados' && agVisible()) agFichaRender(); }).catch(()=>{});
    // F5: amostras guardadas (P15) e o que o time compartilhou (P17) — lidos UMA vez ao abrir, sem segurar a ficha
    const later=()=>{ if(AGF.id===id && AGF.tab==='aprendizados' && agVisible()) agFichaRender(); };
    if(typeof sampleLoad==='function') sampleLoad(repo, id).then(later).catch(()=>{});
    if(typeof orgTeamLoad==='function') orgTeamLoad(id).then(later).catch(()=>{});
    const [card, pend]=await Promise.all([ invoke('agent_card',{ repo, agentId:id }), invoke('learn_pending',{ repo }).catch(()=>[]) ]);
    if(AGF.id!==id) return;
    AGF.card=card||{}; AGF.pend=(pend||[]).filter(p=>String(p.agente||'')===id);
  }catch(e){ if(AGF.id!==id) return; AGF.err=(typeof errShort==='function')?errShort(e):String(e&&e.message||e); AGF.card={}; AGF.pend=[]; }
  agFichaRender();
}
function agFichaAgent(){ const i=cfgEdit.agents.findIndex(a=>a.id===AGF.id); return { a:cfgEdit.agents[i], i }; }
function agFichaRender(){
  const host=$id('agFicha'); if(!host || !AGF.id) return;
  const { a, i }=agFichaAgent();
  if(!a){ agShowFicha(false); return; }
  const t=$id('agTitle'); if(t) t.textContent='Meu time';
  const v=AGS.rows?agViewOf(a):null;
  const ver=AGF.card&&AGF.card.versions?AGF.card.versions.current:null;
  const learnN=((AGF.card&&AGF.card.learnings&&AGF.card.learnings.notes)||[]).filter(n=>!n.forgottenAt).length+((AGF.card&&AGF.card.learnings&&AGF.card.learnings.skills)||[]).length;
  const pendN=(AGF.pend||[]).length;
  const warn=agFichaWarn(a);
  const TABS=[['historico','Histórico'],['aprendizados','Aprendizados'+(learnN||pendN?` (${learnN}${pendN?` + ${pendN} pra decidir`:''})`:'')],['editar','Editar (avançado)']];
  host.innerHTML=`<div class="agf">
    <button class="lnk agf-back" id="agfBack">${IC.chevL||'←'} Meu time</button>
    <header class="agf-h"><span class="av big" style="background:${escA(a.color||AG_COLOR0)}">${avatarInner(a)}</span>
      <div class="agf-ht"><h2 class="agf-n">${esc(a.name||'—')}</h2><p class="agf-d">${esc(agDoes(a))}</p>
      <p class="agf-meta"><span>${esc(agRunLabel(a))}</span>${ver!=null?`<span class="agf-v" title="cada mudança aceita por você vira uma versão (guardamos as últimas 5)">v${ver}</span>`:''}</p></div></header>
    ${v?`<p class="agf-s">${esc(v.line)}</p>${v.note?`<p class="agf-k">${esc(v.note)} — os números só viram porcentagem a partir de ${AG_MIN_N} tarefas no portão.</p>`:''}`:''}
    ${warn?`<p class="agwarn" role="note">${esc(warn)}</p>`:''}
    <div class="agf-tabs" role="tablist" aria-label="Ficha de ${escA(a.name||'')}">${TABS.map(([k,l])=>`<button role="tab" class="agf-tab" id="agft-${k}" data-agftab="${k}" aria-selected="${AGF.tab===k}" aria-controls="agfPanel" tabindex="${AGF.tab===k?0:-1}">${esc(l)}</button>`).join('')}</div>
    <div class="agf-panel" id="agfPanel" role="tabpanel" aria-labelledby="agft-${AGF.tab}">${AGF.err?`<p class="agf-err">${esc(AGF.err)}</p>`:''}${AGF.tab==='historico'?agHistHtml(a):AGF.tab==='aprendizados'?agLearnTabHtml(a):agEditTabHtml(a, i)}</div>
  </div>`;
  agFichaWire(host, a, i);
}
// P5: o aviso aparece na ficha do revisor quando alguma equipe dele o põe no mesmo motor/modelo de quem produz
function agFichaWarn(a){
  if(a.role!=='reviewer') return '';
  const byId=Object.fromEntries(cfgEdit.agents.map(x=>[x.id,x]));
  for(const w of cfgEdit.workflows){ if(!(w.steps||[]).includes(a.id)) continue; const ws=agTeamWarnings(agTeamRoles(w.steps, byId, false)); if(ws.length) return ws[0].text+' — '+ws[0].detail+' na equipe "'+(w.name||'equipe')+'". Troque o motor ou o modelo em Editar.'; }
  return '';
}
function agHistHtml(a){
  if(!AGS.rows) return '<p class="dim">lendo o histórico…</p>';
  const rows=agRowsOf(a.id);
  if(!rows.length) return `<p class="agf-empty">${esc(a.name||'Esse agente')} ainda não trabalhou em nenhuma tarefa deste projeto. As tarefas aparecem aqui assim que ele rodar numa.</p>`;
  const facts=r=>{ const f=[];
    if(agFirstTry(r)) f.push('de primeira');
    else if(!agReachedGate(r)) f.push('ainda não chegou ao portão');
    if(+r.muda>0) f.push('voltou '+r.muda+'× da revisão');
    if(+r.reworks>0) f.push(r.reworks+(+r.reworks===1?' retrabalho':' retrabalhos'));
    if(+r.rounds>0) f.push(r.rounds+(+r.rounds===1?' rodada de revisão':' rodadas de revisão'));
    return f.join(' · '); };
  return `<ol class="agf-hist">${rows.slice(0,60).map(r=>`<li class="agf-hr"><button class="lnk agf-ht" data-agtask="${escA(r.taskId)}" title="abrir a tarefa">${esc(r.title||r.taskId)}</button>
    <span class="agf-hst">${typeof stBadge==='function'?stBadge(r.prUrl&&!['merged','done','closed'].includes(r.status)?'pr-open':r.status):esc(r.status)}</span>
    <span class="agf-hf">${esc(facts(r))}</span><span class="agf-hc">${esc(agUsdBr(r.usd))}</span></li>`).join('')}</ol>${rows.length>60?`<p class="dim">mostrando as 60 mais recentes de ${rows.length}</p>`:''}`;
}
function agLearnTabHtml(a){
  if(!AGF.card) return '<p class="dim">lendo o que ele lembra…</p>';
  const L=AGF.card.learnings||{}, notes=(L.notes||[]), skills=(L.skills||[]);
  // P12: "isso ajudou?" = o antes/depois da versão que o aceite criou (a mesma conta da seção "Antes e depois")
  const versions=(AGF.card.versions&&AGF.card.versions.versions)||[];
  const ver=(k, key, at)=>agLearnVersion(k, k==='nota'?(notes.find(n=>n.id===key)||{ at }):{ name:key, at }, versions, agRowsOf(a.id));
  const pend=(AGF.pend||[]);
  const pendH=pend.length?`<section class="agf-sec"><h3 class="agf-h3">Pra você decidir</h3><div class="memlgrid">${pend.map(it=>memLearnCard(it, { editing:LEARN_EDIT[it.id] })).join('')}</div></section>`:'';
  const act=notes.filter(n=>!n.forgottenAt), gone=notes.filter(n=>n.forgottenAt);
  const item=(k, key, sent, verTx, at, det)=>`<li class="agf-li"><p class="agf-ls">${esc(sent)}</p>
    <div class="agf-la"><span class="agf-lv" title="cada aceite vira uma versão — dá pra voltar">${esc(verTx)}</span>
    <button class="btn sm" data-agback="${escA(k)}" data-key="${escA(key)}">voltar pro jeito antigo</button>
    <button class="btn sm" data-agforget="${escA(k)}" data-key="${escA(key)}">esquecer</button>
    ${typeof orgShareBtn==='function'?orgShareBtn(k, key):''}
    </div>${agBaBlock(a, ver(k, key, at), 'isso ajudou? ', { back:{ k, key } })}
    <details class="agf-det"><summary>ver detalhes</summary>${det}</details></li>`;
  const art=(MEM_ART[a.id]||'');
  const who=(art?art+' ':'')+(a.name||'');
  const lis=[
    ...act.map(n=>item('nota', n.id, who+' lembra: '+agLow(n.title)+'.', 'desde a v'+(n.v||1), n.at, `<pre class="memlbody">${esc(n.body||'')}</pre><p class="dim">nota guardada da tarefa ${esc(n.taskId||'')}</p>`)),
    ...skills.map(s=>{ const h=s.history||{}; const vs=(h.versions||[]); const last=vs[vs.length-1]||{};
      return item('skill', s.name, who+' lembra um jeito de fazer: '+String(s.name).replace(/-/g,' ')+'.', 'skill v'+(h.current||1), last.at||0,
        `<p><b>skill ${esc(s.name)}</b> · v${esc(h.current||1)}</p>${s.description?`<p>${esc(s.description)}</p>`:''}<pre class="memlbody">${esc(s.body||'')}</pre>${vs.length?`<ul class="agf-vs">${vs.map(x=>`<li>v${esc(x.v)} · ${esc(x.action)}${x.reason?' — '+esc(x.reason):''}</li>`).join('')}</ul>`:''}`); }),
  ];
  const remembered=lis.length?`<section class="agf-sec"><h3 class="agf-h3">O que ${esc(a.name||'ele')} lembra</h3><ul class="agf-list">${lis.join('')}</ul></section>`
    :`<p class="agf-empty">${esc(a.name||'Esse agente')} ainda não lembra de nada. Quando a retro de uma tarefa propuser algo pra ${esc(a.name||'esse agente')}, aparece aqui pra você aceitar ou descartar — nada entra sem o seu sim.</p>`;
  // esquecidas/arquivadas (notas) + skills arquivadas dele: nada foi apagado, "restaurar" volta igual (F4 · P13)
  const me=typeof curKey==='function'?curKey(a.id):a.id;
  const arqSk=(typeof CUR!=='undefined'&&CUR.archived||[]).filter(x=>x.kind==='skill'&&x.owner===me);
  // esquecida 2× (mesmo id) = uma linha, a última; reaceita (id ativo) não aparece
  const goneU=[...new Map(gone.filter(n=>!act.some(x=>x.id===n.id)).map(n=>[n.id, n])).values()];
  const goneN=goneU.length+arqSk.length;
  const forgotten=goneN?`<details class="agf-det"><summary>esquecidas (${goneN})</summary><ul class="agf-gone">${goneU.map(n=>`<li>${esc(n.title)}${n.forgetReason?` — <span class="dim">${esc(n.forgetReason)}</span>`:''} <button class="btn sm" data-currestore="nota" data-key="${escA(n.id)}" data-owner="${escA(a.id)}">restaurar</button></li>`).join('')}${arqSk.map(x=>`<li>um jeito de fazer: ${esc(String(x.key).replace(/-/g,' '))}${x.reason?` — <span class="dim">${esc(x.reason)}</span>`:''} <button class="btn sm" data-currestore="skill" data-key="${escA(x.key)}" data-owner="${escA(a.id)}">restaurar</button></li>`).join('')}</ul></details>`:'';
  const cur=typeof curHtml==='function'?curHtml(a.id, { name:a.name }):'';
  // F5: P15 (só revisor) e P17 (itens do time, só com nuvem paga) — cada um some sozinho quando não vale
  const smp=typeof sampleSectionHtml==='function'?sampleSectionHtml(a):'';
  const team=typeof orgTeamLearnHtml==='function'?orgTeamLearnHtml(a):'';
  return agBaSection(a)+smp+cur+pendH+remembered+team+forgotten;
}
// ---------------------------------------------------------------- P12: antes × depois na ficha
// o tipo de tarefa da comparação: o escolhido, ou o que tem mais comparação; nunca "todos misturados"
function agBaKind(a){
  const rows=agRowsOf(a.id), cur=AGF.card&&AGF.card.versions?AGF.card.versions.current:null;
  const ks=agBaKinds(rows, cur);
  if(AGF.kind && AG_KINDS.includes(AGF.kind)) return { kind:AGF.kind, kinds:ks };
  return { kind:(ks[0]&&ks[0].kind)||'codigo', kinds:ks };
}
// bloco "isso ajudou?" / versão: a frase sempre à vista; a tabela (só com n ≥ 5 por lado) dentro do details
function agBaBlock(a, v, lead, o){
  o=o||{};
  const ba=agBeforeAfter(agRowsOf(a.id), v, { kind:agBaKind(a).kind });
  const cur=AGF.card&&AGF.card.versions?+AGF.card.versions.current:null;
  const later=v!=null&&cur>v?` · o "depois" inclui ${cur-v===1?'a v'+cur:'as v'+(v+1)+' a v'+cur}`:'';
  const sides=`<span class="agba-n">antes ${ba.nb} · depois ${ba.na} · ${esc(ba.kindLabel)}${esc(later)}</span>`;
  const table=ba.metrics.length?`<table class="agba"><thead><tr><th scope="col">${esc(ba.kindLabel)}</th><th scope="col">antes da v${esc(v)}</th><th scope="col">da v${esc(v)} em diante</th>${ba.stage==='pct'?'<th scope="col">diferença</th>':''}</tr></thead><tbody>${ba.metrics.map(m=>`<tr${m.worse?' class="isw"':''}><th scope="row">${esc(m.label)}</th><td>${esc(m.before)}</td><td>${esc(m.after)}</td>${ba.stage==='pct'?`<td>${esc(m.change)}${m.worse?' <span class="agba-w">pesou</span>':''}</td>`:''}</tr>`).join('')}</tbody></table>`
    :`<p class="dim agba-why">A comparação aparece com ${AG_BA_LOW} tarefas de cada lado, e só vira conclusão com ${AG_MIN_N}. Conta só tarefa de ${esc(ba.kindLabel)} que chegou ao portão.</p>`;
  let back='';
  if(ba.offerBack){
    if(o.back) back=`<button class="btn sm primary" data-agback="${escA(o.back.k)}" data-key="${escA(o.back.key)}">voltar pro jeito antigo</button>`;
    else if(o.revert) back=`<button class="btn sm primary" data-agrevert="1">voltar pro jeito antigo</button>`;
    else if(['persona','modelo','motor'].includes(o.change)) back=`<span class="dim">pra voltar, use Editar (avançado) › Versões — "restaurar esta persona" ou trocar o ${esc(o.change==='persona'?'texto':o.change)} de volta.</span>`;
    else back=`<span class="dim">volte pelo item em "O que ${esc(a.name||'ele')} lembra", logo abaixo.</span>`;
  }
  return `<details class="agf-ba${ba.offerBack?' isw':''}"><summary>${esc(lead||'')}<span class="agba-t">${esc(ba.text)}</span></summary>${sides}${table}${back?`<div class="agba-back">${back}</div>`:''}</details>`;
}
function agBaSection(a){
  const vs=((AGF.card&&AGF.card.versions&&AGF.card.versions.versions)||[]).filter(x=>+x.v>=2).slice().reverse();
  const cur=AGF.card&&AGF.card.versions?AGF.card.versions.current:null;
  const { kind, kinds }=agBaKind(a);
  const chips=kinds.length>1||(kinds.length===1&&kinds[0].kind!==kind)?`<div class="agba-kinds" role="radiogroup" aria-label="Tipo de tarefa da comparação">${kinds.map(k=>`<button type="button" role="radio" class="agba-k${k.kind===kind?' on':''}" aria-checked="${k.kind===kind}" data-agbakind="${escA(k.kind)}">${esc(k.label)} <span class="dim">${k.nb+k.na}</span></button>`).join('')}</div>`:'';
  const body=vs.length?`<ul class="agba-vers">${vs.map(x=>`<li><span class="agf-lv">v${esc(x.v)}</span> <span class="agba-what">${esc(x.what||x.change)}</span>${agBaBlock(a, +x.v, '', { revert:x.v===cur&&['persona','modelo','motor'].includes(x.change), change:x.change })}</li>`).join('')}</ul>`
    :`<p class="agf-empty">${esc(a.name||'Esse agente')} ainda está na primeira versão. Cada coisa que você aceitar pra ele vira uma versão, e aqui aparece o antes e o depois dela.</p>`;
  return `<section class="agf-sec agba-sec"><h3 class="agf-h3">Antes e depois de cada versão</h3><p class="dim agba-lead">Mesmo tipo de tarefa dos dois lados. Abaixo de ${AG_BA_LOW} tarefas por lado, ainda medindo; até ${AG_MIN_N - 1}, só os números crus; a partir de ${AG_MIN_N}, a comparação.</p>${chips}${body}</section>`;
}
function agEditTabHtml(a, i){
  const engs=(typeof AI_ENGINES!=='undefined'?AI_ENGINES:[{ id:'claude', name:'Claude', models:[] }]).filter(e=>e.id!=='mock'||a.engine==='mock'||(typeof devInstall!=='undefined'&&devInstall));
  const ek=agEngineKey(a.engine);
  if(!engs.some(e=>e.id===ek)) engs.push({ id:ek, name:a.engine||ek, models:[] }); // motor fora da lista: aparece como está, nunca "vira Claude" no select
  const eng=engs.find(e=>e.id===ek)||engs[0];
  const models=(eng&&eng.models)||[];
  const modelOpts=(models.some(m=>m.id===(a.model||''))?models:[...models, { id:a.model||'', name:a.model||'padrão' }]).map(m=>`<option value="${escA(m.id)}"${(a.model||'')===m.id?' selected':''}>${esc(m.name)}</option>`).join('');
  const vers=((AGF.card&&AGF.card.versions&&AGF.card.versions.versions)||[]).slice().reverse();
  const cur=AGF.card&&AGF.card.versions?AGF.card.versions.current:null;
  const verH=vers.length?`<ol class="agf-vers">${vers.map(x=>{
      const d=x.persona!=null&&x.before!=null?agLineDiff(x.before, x.persona):null;
      const canBack=x.v===cur && ['persona','modelo','motor'].includes(x.change);
      return `<li><span class="agf-lv">v${esc(x.v)}</span> ${esc(x.what||x.change)} <span class="dim">· ${esc(new Date(+x.at||0).toLocaleDateString('pt-BR'))}</span>
        ${canBack?`<button class="btn sm" data-agrevert="1">voltar pro jeito antigo</button>`:''}
        ${x.persona!=null&&x.v!==cur?`<button class="btn sm" data-agrestore="${escA(x.v)}">restaurar esta persona</button>`:''}
        ${d?`<details class="agf-det"><summary>ver a diferença</summary><pre class="agf-diff">${d.map(l=>`<span class="d${l.t==='+'?'a':l.t==='-'?'r':'c'}">${esc((l.t==='='?'  ':l.t+' ')+l.s)}</span>`).join('\n')}</pre></details>`:''}</li>`; }).join('')}</ol>`
    :'<p class="dim">Ainda na v1 — cada mudança que você salvar aqui (persona, motor, modelo) vira uma versão, e dá pra voltar.</p>';
  return `<div class="ageditor agf-edit">
    <div class="two">
      <div><label for="agfName">Nome</label><input class="in" id="agfName" data-i="${i}" data-k="name" value="${escA(a.name||'')}"></div>
      <div><label for="agfRole">Papel</label><input class="in" id="agfRole" list="catList" data-i="${i}" data-k="role" value="${escA(a.role||'')}" placeholder="ex.: reviewer, designer…"></div>
    </div>
    <div class="two">
      <div><label for="agfEngine">Motor</label><select class="sel" id="agfEngine" data-i="${i}" data-k="engine">${engs.map(e=>`<option value="${escA(e.id)}"${e.id===ek?' selected':''}>${esc(e.name)}</option>`).join('')}</select></div>
      <div><label for="agfModel">Modelo</label><select class="sel" id="agfModel" data-i="${i}" data-k="model">${modelOpts}</select></div>
    </div>
    <p class="dim agf-hint">Motor e modelo valem pra este agente em todas as equipes. Salvar cria uma versão nova dele — dá pra voltar com 1 clique.</p>
    <label for="agfPersona" style="display:block;margin-top:10px">Persona (as instruções dele)</label>
    <textarea class="agpersona" id="agfPersona" data-i="${i}" data-k="persona" placeholder="o que este agente faz e como pensa">${esc(a.persona||'')}</textarea>
    <div class="pickrow"><span class="lbl3">Cor</span>${PALETTE.map(c=>`<button class="colorsw${(a.color||'').toLowerCase()===c?' on':''}" style="background:${c}" data-color="${i}" data-c="${c}" aria-label="cor ${c}"></button>`).join("")}<input class="swatch" type="color" value="${escA(a.color||AG_COLOR0)}" data-i="${i}" data-k="color" title="cor personalizada"></div>
    <div class="pickrow"><span class="lbl3">Avatar</span><button class="glyph ini${!a.avatar?' on':''}" data-glyph="${i}" data-g="">Aa</button>${GLYPHS.map(gp=>`<button class="glyph${a.avatar===gp?' on':''}" data-glyph="${i}" data-g="${escA(gp)}">${gp}</button>`).join("")}</div>
    <datalist id="catList">${allCats().map(c=>`<option value="${escA(c)}"></option>`).join("")}</datalist>
    <section class="agf-sec"><h3 class="agf-h3">Versões</h3>${verH}</section>
    <div class="agf-danger"><button class="btn sm" data-del="${i}">${IC.trash} remover este agente</button></div>
  </div>`;
}
function agFichaWire(host, a, i){
  const back=host.querySelector('#agfBack'); if(back) back.onclick=()=>{ agShowFicha(false); renderAg(); renderTeams(); renderWf(); const b=document.querySelector(`[data-open="${i}"]`); if(b) b.focus(); };
  const tabs=[...host.querySelectorAll('[data-agftab]')];
  tabs.forEach((b,k)=>{ b.onclick=()=>{ AGF.tab=b.dataset.agftab; agFichaRender(); const n=$id('agft-'+AGF.tab); if(n) n.focus(); };
    b.onkeydown=e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return; e.preventDefault(); const n=tabs[(k+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length]; n.click(); }; });
  host.querySelectorAll('[data-agtask]').forEach(b=>b.onclick=()=>{ if(typeof openWorkspace==='function') openWorkspace(b.dataset.agtask); });
  // aprendizados: os 4 botões do cartão (mesmo caminho da Memória) + voltar/esquecer do que ele já lembra
  const repo=state.repo||'';
  // persona aceita/desfeita (F5) muda o cardume.config.json: o catálogo em edição é relido — senão um "salvar" depois
  // gravaria a persona velha por cima
  const ctx={ repo:()=>repo, items:()=>AGF.pend||[], repaint:agFichaRender, after:async(_r, res)=>{ if(res && res.kind==='persona' && !agDirty()) await agReloadCatalog(); await Promise.all([agFichaLoad(), agStatsLoad()]); } };
  if(typeof learnWire==='function') learnWire(host, ctx);
  host.querySelectorAll('[data-agback]').forEach(b=>b.onclick=async()=>{
    if(b.dataset.agback==='skill'){ await memLearnRevert(repo, b.dataset.key, 'voltou pela ficha do agente', ctx); }
    else await learnForget(repo, a.id, 'nota', b.dataset.key, 'voltou pela ficha do agente', ctx, 'voltar');
  });
  host.querySelectorAll('[data-agbakind]').forEach(b=>b.onclick=()=>{ AGF.kind=b.dataset.agbakind; agFichaRender(); const n=host.querySelector(`[data-agbakind="${b.dataset.agbakind}"]`); if(n&&n.focus) n.focus(); });
  if(typeof curWire==='function') curWire(host, { repo:()=>repo, after:async()=>{ await Promise.all([agFichaLoad(), agStatsLoad()]); } });
  if(typeof orgTeamWire==='function') orgTeamWire(host, a, async(reload)=>{ if(reload) await agFichaLoad(); else agFichaRender(); });
  if(typeof sampleWire==='function') sampleWire(host, a, agFichaRender);
  host.querySelectorAll('[data-agforget]').forEach(b=>b.onclick=async()=>{
    if(!await askYes((a.name||'O agente')+' vai esquecer isso nas próximas tarefas.\n\nNada é apagado: fica no histórico, e dá pra recuperar.')) return;
    await learnForget(repo, a.id, b.dataset.agforget, b.dataset.key, 'esquecido pela ficha', ctx);
  });
  // editar: mexe no catálogo em edição (cfgEdit) — "salvar" no rodapé grava e cria a versão
  host.querySelectorAll('.agf-edit [data-k]').forEach(inp=>{
    const h=()=>{ const ag=cfgEdit.agents[+inp.dataset.i]; if(!ag) return; const k=inp.dataset.k;
      if(k==='model' && !inp.value) delete ag.model; else ag[k]=inp.value;
      if(k==='engine'){ delete ag.model; agFichaRender(); } else if(k==='color'||k==='model') agFichaRender(); agSaveHint(); };
    inp.addEventListener(inp.tagName==='SELECT'?'change':'input', h); if(inp.type==='color') inp.addEventListener('change', h);
  });
  host.querySelectorAll('[data-color]').forEach(s=>s.onclick=e=>{ e.preventDefault(); cfgEdit.agents[+s.dataset.color].color=s.dataset.c; agFichaRender(); agSaveHint(); });
  host.querySelectorAll('[data-glyph]').forEach(b=>b.onclick=e=>{ e.preventDefault(); cfgEdit.agents[+b.dataset.glyph].avatar=b.dataset.g; agFichaRender(); agSaveHint(); });
  host.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{ const ag=cfgEdit.agents[+b.dataset.del]; if(!ag) return;
    const inTeams=cfgEdit.workflows.filter(w=>(w.steps||[]).includes(ag.id)).map(w=>w.name||'equipe');
    if(!await askYes('Remover '+(ag.name||'este agente')+'?'+(inTeams.length?'\n\nEle sai também de '+(inTeams.length===1?'da equipe "'+inTeams[0]+'"':inTeams.length+' equipes ('+inTeams.join(', ')+')')+'.':'')+'\n\nSó vale depois de salvar.')) return;
    cfgEdit.agents.splice(+b.dataset.del,1); if(ag.id) wfDropAgent(cfgEdit.workflows, ag.id); agShowFicha(false); renderAg(); renderTeams(); renderWf(); agSaveHint(); });
  const rv=host.querySelector('[data-agrevert]'); if(rv) rv.onclick=async()=>{
    if(agDirty()){ toast('Salve ou descarte as mudanças antes de voltar uma versão.','warn'); return; }
    try{ await invoke('agent_revert',{ agentId:a.id, reason:'voltou pela ficha' }); toast('Voltou pro jeito antigo — virou uma versão nova, dá pra desfazer.','ok'); await agReloadCatalog(); }
    catch(e){ showErr(e, 'Não consegui voltar'); } };
  host.querySelectorAll('[data-agrestore]').forEach(b=>b.onclick=async()=>{
    if(agDirty()){ toast('Salve ou descarte as mudanças antes de restaurar uma persona.','warn'); return; }
    try{ await invoke('agent_restore_persona',{ repo:state.repo||'', agentId:a.id, v:+b.dataset.agrestore }); toast('Persona restaurada — virou uma versão nova.','ok'); await agReloadCatalog(); }
    catch(e){ showErr(e, 'Não consegui restaurar'); } });
}
// o rodapé diz quando há mudança por salvar (o salvar é que cria a versão)
function agSaveHint(){ const h=$id('agDirtyHint'); if(h) h.textContent=agDirty()?'mudanças não salvas — salvar cria uma versão nova de cada agente alterado':'salvo nas configurações deste projeto'; }
// relê o catálogo do disco (depois de voltar/restaurar uma versão pelo Rust) sem fechar a ficha
async function agReloadCatalog(){
  try{ const cfg=await invoke('config')||{}; cfgEdit=JSON.parse(JSON.stringify({ agents:cfg.agents||[], workflows:cfg.workflows||[] })); agBase=JSON.stringify(cfgEdit); state.config=JSON.parse(agBase); }
  catch(e){ showErr(e, 'Não consegui reler os agentes'); }
  await agFichaLoad(); agSaveHint();
}

// ---------------------------------------------------------------- equipes prontas (FLOW_BY_KIND) e montar a minha
const AG_READY_KINDS=['codigo','pagina','documento'];
function agReadyRoles(kind){
  const byId=Object.fromEntries(cfgEdit.agents.map(a=>[a.id,a]));
  const steps=[];
  for(const st of kindAgentStages(kind, false)){ const a=byId[st.agentId]||cfgEdit.agents.find(x=>x.role===st.role); if(a&&a.id) steps.push(a.id); }
  return agTeamRoles(steps, byId, true).map(r=>Object.assign(r, { label:(FLOW_BY_KIND[kind].find(s=>s.role===r.role)||{}).label||r.role }));
}
function agStripFor(roles){
  const avg=agAvgByRole(AGS.rows||[]);
  const st=agTeamStages(roles, avg, typeof CIC_DOING!=='undefined'?CIC_DOING:{}, typeof CIC_ROLE_LABEL!=='undefined'?CIC_ROLE_LABEL:{});
  const cost=agTeamCost(roles, avg);
  const foot=cost?`custo médio <b>~${esc(agUsdBr(cost.usd))}</b>/tarefa <span class="dim">(n=${cost.n})</span>`:'<span class="dim">ainda sem custo medido</span>';
  return stageStripHtml(st, { now:'', next:'', spent:0, cap:0, n:st.length, pos:1 }, { color:id=>{ const a=roles.find(r=>r.name===id); return a&&a.color||'var(--surface-3)'; }, foot, label:'Etapas da equipe' });
}
function renderTeams(){
  const el=$id('agTeams'); if(!el) return;
  el.innerHTML=AG_READY_KINDS.map(k=>{ const roles=agReadyRoles(k); const ws=agTeamWarnings(roles);
    return `<article class="agteam"><header class="agteam-h"><b>${esc(KIND_TEAM[k])}</b><span class="dim">${esc(KIND_LABEL[k])} · ${esc(roles.map(r=>r.name).join(' → '))}</span></header>
      ${roles.length?agStripFor(roles):'<p class="dim">faltam agentes no catálogo pra esta equipe</p>'}
      ${(typeof orgPolCovers==='function'&&orgPolCovers()?[]:ws).map(w=>`<p class="agwarn" role="note">${esc(w.text)} (${esc(w.detail)})</p>`).join('')}${typeof orgPolIssuesHtml==='function'?orgPolIssuesHtml(roles):''}</article>`; }).join('');
  el.querySelectorAll('[data-cicst]').forEach(b=>{ b.tabIndex=-1; b.setAttribute('aria-disabled','true'); });
}
// teclado na grade: setas movem o foco entre os cartões (padrão de 54-acessibilidade), Enter abre a ficha
function agGridKeys(el){
  const bs=[...el.querySelectorAll('.agcard-b')];
  bs.forEach((b,k)=>b.onkeydown=e=>{
    const cols=Math.max(1, Math.round(el.querySelector('.aggrid2').clientWidth/Math.max(1,b.offsetWidth)));
    const d={ ArrowRight:1, ArrowLeft:-1, ArrowDown:cols, ArrowUp:-cols }[e.key]; if(!d) return;
    e.preventDefault(); const n=bs[Math.min(bs.length-1, Math.max(0, k+d))]; if(n) n.focus(); });
}
