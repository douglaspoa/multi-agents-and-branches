// Starfork — 89-comando: COMANDO, o centralizador (aba, nunca modal).
// Uma conversa que responde sobre TODAS as tarefas e agentes e age por você; ao lado, o painel vivo: todos os agentes
// e, ao clicar numa tarefa, a VISÃO GERAL dela (pedido, plano da IA, decisões, caminho, arquivos) — tudo numa tela.
// Fontes únicas: taskSt/STATUS_META (estado), pendingOf/tlAskGroup (perguntas), term_history (o que a IA fez),
// tlAskPaint (a MESMA folha de pergunta do terminal), tiSend (instrução), stopTask, project_chat (pergunta livre).
// Perguntas de estado NÃO gastam IA: saem direto dos dados. Só o texto livre vai pra IA, com o estado junto.

// @comando-puro-inicio (testado em app/tests/comando.test.mjs)
const CMD_ORDEM={ asking:0, 'needs-you':0, 'plan-review':0, error:1, conflict:1, 'mudanca-pedida':1, review:2, delivered:2, 'falta-prova':2, 'para-aprovar':2, 'pr-open':3, running:4, thinking:4, integrando:4 };
function cmdNorm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
/** O que a pessoa quis: { k, id?, code?, text?, tela? }.
 *  k: status | espera | erro | fila | parar | tarefa | porque | abrir | provas | link | instruir | issue | epicos | epico | tela | ia.
 *  `tasks`: [{id, code, title}] · `epics`: [{id, name}]. A IA devolve "ACAO: <frase>" e a frase passa por aqui de novo. */
const CMD_TELAS=[['issues','issues'],['central','flow'],['entregas','entregas'],['semana','semana'],['aprovar','aprovar'],['meu trabalho','meu'],['projetos','projetos'],['nova demanda','nova']];
function cmdIntent(text, tasks, epics){
  const raw=String(text||'').trim(), s=cmdNorm(raw); if(!s) return { k:'' };
  const m=/\b([a-z]{2,10}-\d+)\b/.exec(s);
  let t=m?(tasks||[]).find(x=>cmdNorm(x.code)===m[1]):null;
  if(!t){ const hit=(tasks||[]).filter(x=>{ const ti=cmdNorm(x.title); return ti.length>=6 && s.includes(ti); }); if(hit.length===1) t=hit[0]; }
  const quer={ provas:/\b(prova|provas|print|prints|imagem|imagens|screenshot|evidencia|evidencias|foto|fotos)\b/.test(s), link:/\b(link|links|url|endereco|pull request|pr)\b/.test(s) };
  if(t){
    const ins=/^\s*[a-z]{2,10}-\d+\s*:\s*(.{3,})$/i.exec(raw); if(ins) return { k:'instruir', id:t.id, text:ins[1].trim() };
    if(quer.provas) return { k:'provas', id:t.id };
    if(quer.link) return { k:'link', id:t.id };
    if(/\b(por ?que|parou|erro|falh|travou|travad)/.test(s)) return { k:'porque', id:t.id };
    if(/\b(abr[ea]|abrir|entra|entrar|mostra|ver)\b/.test(s)) return { k:'abrir', id:t.id };
    if(/\b(par[ae]|parar|pausa|pausar|interromp)/.test(s)) return { k:'parar', id:t.id };
    return { k:'tarefa', id:t.id };
  }
  // código que não é tarefa aberta = issue do painel (começar/ver); quem chama confere se ela existe lá
  if(m) return { k:'issue', code:m[1].toUpperCase(), go:/\b(comec\w*|inici\w*|peg[ao]\w*|faz\w*|roda\w*|toca\w*|resolv\w*|bora)\b/.test(s), link:quer.link };
  const ep=(epics||[]).filter(e=>{ const n=cmdNorm(e.name); return n.length>=4 && s.includes(n); });
  if(ep.length===1){ const act=/\b(entreg\w*)\b/.test(s)?'entregar':/\b(liber\w*|proxima onda|comec\w* a onda)\b/.test(s)?'liberar':/\b(verific\w*|confer\w*)\b/.test(s)?'verificar':/\b(comec\w*|inici\w*|roda\w*|bora)\b/.test(s)?'start':'';
    return act?{ k:'epico', id:ep[0].id, act }:{ k:'epico', id:ep[0].id }; }
  if(/\bepicos?\b/.test(s)) return { k:'epicos' };
  if(/\b(pausa|pausar|para|parar|pare|interromp\w*)\b.*\b(tudo|todos|todas|agentes|rodando)\b/.test(s)) return { k:'parar' };
  if(quer.provas) return { k:'provas' };
  { const tl=/\b(abr[ea]|abrir|vai|ir|leva|mostra|tela)\b/.test(s)?CMD_TELAS.find(x=>s.includes(x[0])):null; if(tl) return { k:'tela', tela:tl[1] }; }
  if(/\b(issues?|fila|backlog|painel|proxima(s)?|o que (tem|falta|ha) (pra|para) (fazer|pegar|comecar))\b/.test(s)) return { k:'fila' };
  if(/(esperando|precisa(m)? de mim|precisando de mim|pendente|pergunt|minha vez|me esperando)/.test(s)) return { k:'espera' };
  if(/\b(erro|erros|falh\w*|travad\w*|parou|pararam|quebr\w*)\b/.test(s)) return { k:'erro' };
  if(/(como (esta|estao|anda|andam|vai|vao)|status|andamento|resumo|situacao|o que (esta|ta) (rodando|acontecendo)|agentes|tarefas abertas|tudo bem)/.test(s)) return { k:'status' };
  return { k:'ia' };
}
/** A linha "ACAO: …" que a IA devolve quando o pedido é uma ação do app ('' = respondeu em texto). */
function cmdAcaoDe(text){ const m=/^\s*ACAO:\s*(.+?)\s*$/im.exec(String(text||'')); return m?m[1]:''; }
/** Plano da IA = o último TodoWrite da sessão. → [{ st:'ok'|'now'|'', tx }] */
function cmdPlan(items){
  for(let i=(items||[]).length-1;i>=0;i--){ const it=items[i];
    if(it && it.k==='tool' && it.name==='Plano' && it.text) return String(it.text).split('\n').map(l=>{ const p=l.indexOf('\t'); const st=p<0?'':l.slice(0,p); return { st:st==='completed'?'ok':st==='in_progress'?'now':'', tx:p<0?l:l.slice(p+1) }; }).filter(x=>x.tx); }
  return [];
}
/** Decisões = cada pergunta da IA com a resposta dada. → [{ q, a, ts }] (a='' = ainda sem resposta) */
function cmdDecisions(items){
  return (items||[]).filter(it=>it && it.k==='ask' && it.text).map(it=>({ q:String(it.text), ts:it.ts||0,
    a:it.done&&!it.err?String(it.out||'').replace(/^User (has )?answered[^:]*:\s*/i,'').trim():'' }));
}
/** Arquivos que a IA mexeu (somando as edições). → [{ f, add, del }] do mais mexido pro menos */
function cmdFiles(items){
  const m=new Map();
  for(const it of (items||[])){ if(!it || it.k!=='edit' || !it.arg || it.err) continue; const r=m.get(it.arg)||{ f:it.arg, add:0, del:0, n:0 }; r.add+=it.add||0; r.del+=it.del||0; r.n++; m.set(it.arg, r); }
  return [...m.values()].sort((a,b)=>(b.add+b.del)-(a.add+a.del));
}
const CMD_VERBO={ Read:'leu', Bash:'rodou', Grep:'buscou', Glob:'buscou', WebSearch:'pesquisou', WebFetch:'abriu', Agent:'delegou', Plano:'planejou', mcp:'usou', Update:'editou', Write:'criou' };
/** O caminho, em linhas legíveis (as últimas `max`). Leituras seguidas viram uma linha só. → [{ ts, k, v, tx, err }] */
function cmdPath(items, max){
  const out=[];
  for(const it of (items||[])){ if(!it) continue;
    if(it.k==='you') out.push({ ts:it.ts, k:'you', v:'você', tx:cmdUma(it.text) });
    else if(it.k==='ask') out.push({ ts:it.ts, k:'ask', v:'perguntou', tx:cmdUma(it.text) });
    else if(it.k==='edit') out.push({ ts:it.ts, k:'edit', v:CMD_VERBO[it.name]||'editou', tx:it.arg+(it.add?' +'+it.add:'')+(it.del?' −'+it.del:''), err:!!it.err });
    else if(it.k==='tool'){
      if(it.name==='Plano'){ out.push({ ts:it.ts, k:'plan', v:'planejou', tx:it.arg }); continue; }
      const last=out[out.length-1], v=CMD_VERBO[it.name]||'usou';
      if(it.name==='Read' && last && last.k==='read'){ last.n++; last.tx=last.n+' arquivos'; continue; }
      out.push({ ts:it.ts, k:it.name==='Read'?'read':'tool', n:1, v, tx:cmdUma(it.arg)+(it.err?' — '+(cmdUma(it.out)||'falhou'):''), err:!!it.err });
    }
    else if(it.k==='sys') out.push({ ts:it.ts, k:'sys', v:'sistema', tx:cmdUma(it.text) });
  }
  return out.slice(-(max||30));
}
function cmdUma(s){ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>150?s.slice(0,149)+'…':s; }
/** A última coisa que a IA DISSE (resumo do ponto em que está). */
function cmdLastSay(items){ for(let i=(items||[]).length-1;i>=0;i--){ const it=items[i]; if(it && it.k==='say' && it.text) return String(it.text); } return ''; }
/** O último erro de ferramenta (pra "por que parou?"). */
function cmdLastErr(items){ for(let i=(items||[]).length-1;i>=0;i--){ const it=items[i]; if(it && it.err) return { name:it.name||'', arg:it.arg||'', out:it.out||'' }; } return null; }
/** O estado inteiro em texto + o catálogo de ações, pra IA responder pergunta livre OU devolver a ação certa.
 *  `rows`: [{ code, title, st, branch, q }] · `epics`: [{ name, done, total }] */
function cmdSnapshot(rows, proj, epics){
  const L=(rows||[]).map(r=>`- ${r.code?r.code+' ':''}"${r.title}" — ${r.st}${r.branch?' · branch '+r.branch:''}${r.q?' · pergunta aberta: '+cmdUma(r.q):''}`);
  const E=(epics||[]).map(e=>`- épico "${e.name}" — ${e.done} de ${e.total} tarefas entregues`);
  return `[ESTADO DO STARFORK AGORA${proj?' · projeto '+proj:''}]\n${L.length?L.join('\n'):'(nenhuma tarefa aberta)'}${E.length?'\n'+E.join('\n'):''}\n[FIM DO ESTADO]\n`
    +`Você é o Comando do Starfork. Se o pedido da pessoa for uma AÇÃO do app, responda SOMENTE com uma linha "ACAO: <frase>" usando uma destas frases (troque o que está entre <>):\n`
    +`status · esperando · erro · fila de issues · epicos · epico <nome> · comecar epico <nome> · liberar onda epico <nome> · verificar epico <nome> · entregar epico <nome> · tarefa <código> · por que <código> parou · provas <código> · link <código> · abrir <código> · parar <código> · parar tudo rodando · comecar <código da issue> · <código>: <instrução pra IA da tarefa> · abrir tela <issues|central|entregas|semana|aprovar|meu trabalho|projetos|nova demanda>\n`
    +`Se for uma pergunta (sobre o código ou sobre as tarefas), responda em português, curto e direto, citando as tarefas pelo código. Nunca invente código de tarefa.`;
}
// @comando-puro-fim

const CMD={ msgs:{}, sel:'', hist:{}, busy:false, stopping:false, starting:'', spoken:0, logHtml:'', sideHtml:'', mounted:false };
function cmdRepo(){ return (typeof state!=='undefined'&&state.repo)||''; }
function cmdMsgs(){ const k=cmdRepo(); return CMD.msgs[k]||(CMD.msgs[k]=[]); }
function cmdTasks(){ let l=[]; try{ l=flowLiveTasks(); }catch(_){ l=((typeof state!=='undefined'&&state.tasks)||[]).filter(t=>!taskEncerrada(t)); }
  return l.slice().sort((a,b)=>{ const oa=CMD_ORDEM[taskSt(a)]??5, ob=CMD_ORDEM[taskSt(b)]??5; return oa-ob || (b.updatedAt||0)-(a.updatedAt||0); }); }
function cmdCode(t){ return t.issueCode||(typeof issueCodeOf==='function'&&issueCodeOf(t))||''; }
function cmdTask(id){ return ((typeof state!=='undefined'&&state.tasks)||[]).find(t=>t.id===id)||null; }
function cmdAsk(t){ try{ return tlAskGroup(pendingOf(t.id)); }catch(_){ return null; } }
function cmdAskTitle(t){ const g=cmdAsk(t); if(!g||!g.rows||!g.rows.length) return ''; const p=g.rows[0], m=(p.meta&&typeof p.meta==='object')?p.meta:{};
  let ti=''; try{ ti=tlAskSplit(p.prompt||p.question||'', m.header, m.question).title; }catch(_){ ti=String(p.prompt||''); } return (g.rows.length>1?g.rows.length+' perguntas · ':'')+ti; }
function cmdIsRun(t){ return ['running','thinking','integrando'].includes(taskSt(t)); }
function cmdIsBad(t){ const s=taskSt(t); return stIsBad(s)||s==='mudanca-pedida'; }
function cmdIsAsk(t){ return ['asking','needs-you','plan-review'].includes(taskSt(t)); }

// ---------- issues do painel: ver a fila e COMEÇAR daqui (mesma criação da Nova demanda, com os padrões da pessoa) ----------
function cmdTrkOn(){ try{ return typeof trkReady==='function' && trkReady(); }catch(_){ return false; } }
async function cmdIssuesEnsure(){
  if(typeof trkLoad!=='function') return false;
  try{ if(!cmdTrkOn()) await trkLoad(); if(!cmdTrkOn()) return false;
    if(!trkIssues.length || Date.now()-trkIssuesAt>120000){ await trkFetchIssues(); trkIdxMemo=null; } return true; }
  catch(e){ console.warn('comando issues', e); return cmdTrkOn(); }
}
function cmdIssue(code){ try{ return (trkIssues||[]).find(i=>String(i.code).toLowerCase()===String(code).toLowerCase())||null; }catch(_){ return null; } }
function cmdIssueTask(code){ try{ return trkTasksFor(code).find(t=>!taskEncerrada(t))||null; }catch(_){ return null; } }
// issues que ainda não viraram tarefa e não estão concluídas no painel
function cmdFila(){ try{ const sts=(trk.connector||{}).statuses||[]; return trkTriFila(trkRowsNow()).map(r=>r.i).filter(i=>trkKindOfStatus(sts, i.status)!=='done'); }catch(_){ return []; } }
function cmdIssueCard(i){ const busy=CMD.starting===i.code;
  return `<div class="cmdiss"><div class="cmdiss-h"><span class="cmdcode">${esc(i.code)}</span><b>${esc(i.title)}</b></div><div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmdstart="${escA(i.code)}"${CMD.starting?' disabled':''}>${busy?'começando…':'Começar agora'}</button><button type="button" class="btn sm quiet" data-cmdform="${escA(i.code)}">Ajustar antes</button></div></div>`; }
async function cmdStartIssue(code){
  const i=cmdIssue(code); if(!i){ toast('Não achei a '+code+' no painel de issues','warn'); return; }
  if(CMD.starting) return;
  const ja=cmdIssueTask(code); if(ja){ CMD.sel=ja.id; cmdHistLoad(ja.id); return cmdPaint(); }
  const sp=trkIssueSpec(i), reqs=[...new Set(sp.reqs)], pol=(typeof ntPolicy!=='undefined'&&ntPolicy)||{};
  // a política do time pede requisitos e a issue não tem: completa no formulário (já preenchido), não cria pela metade
  if(reqs.length<(+pol.minRequirements||0)){ cmdMsgs().push({ r:'bot', k:'txt', text:`A ${i.code} tem menos requisitos do que o time exige. Abri o formulário já preenchido pra você completar.` }); cmdPaint(true); return trkIssueToTask(i, 'run'); }
  CMD.starting=i.code; cmdPaint();
  try{
    const d=aiDefaults(), cr=ndKindCreate(sp.bug?'fix':'build');
    const payload={ start:true, title:String(sp.title||i.code).slice(0,90), workflow:null, agents:null, engine:defaultAiEngine(), model:d.model||null, advisor:d.advisor, approval:'auto',
      owns:cr.owns||null, off:null, objective:sp.objective||sp.title, deliverables:sp.goal?[sp.goal]:[], requirements:reqs, doc:cr.doc||null,
      proof:true, tests:!!pol.testsRequired, autoPr:cr.autoPr, prBase:null, planApproval:'auto', refs:[], branchType:cr.branchType, issue:i.code, issueUrl:i.url||undefined };
    const nid=await invoke('new_task', await trkBeforeNewTask(payload, { ask:true }));
    if(typeof budgetApply==='function') await budgetApply(nid);
    try{ lastSig=''; }catch(_){ } await refresh(); trkIdxMemo=null;
    CMD.sel=nid; cmdMsgs().push({ r:'bot', k:'txt', text:`Comecei a ${i.code}. A IA já está trabalhando; a tarefa está aberta ao lado.` });
  }catch(e){ if(!(e&&e.shown)) showErr(e, 'Não consegui começar a '+i.code); cmdMsgs().push({ r:'sys', text:'a '+i.code+' não foi iniciada' }); }
  CMD.starting=''; cmdPaint(true);
}

// ---------- épicos, links e provas ----------
function cmdAllTasks(){ return ((typeof state!=='undefined'&&state.tasks)||[]); }
function cmdEpics(){ const out=[], seen=new Set();
  try{ ((typeof teamEpics!=='undefined'&&teamEpics)||[]).forEach(e=>{ if(e && e.id && e.status!=='archived' && !seen.has(e.id)){ seen.add(e.id); out.push({ id:e.id, name:e.name||'Épico', status:e.status||'open' }); } }); }catch(_){ }
  cmdAllTasks().forEach(t=>{ const id=t.epic&&t.epic.epicId; if(id && !seen.has(id)){ seen.add(id); out.push({ id, name:(typeof epNameOf==='function'&&epNameOf(id))||'Épico', status:'open' }); } });
  return out; }
// as tarefas do épico: a MESMA lista da fila dos épicos (nuvem + local); sem nuvem, só as locais
function cmdEpicItems(eid){
  try{ if(typeof epqEpicTasks==='function'){ const l=epqEpicTasks(eid); if(l.length) return l; } }catch(_){ }
  return cmdAllTasks().filter(t=>t.epic&&t.epic.epicId===eid).map(t=>({ title:mdTitle(t.title||''), st:taskSt(t), b:['merged','done'].includes(t.status)?'ok':'run', wave:Math.max(1, parseInt(t.epic.wave,10)||1), local:t.id, code:cmdCode(t) })); }
function cmdEpicStat(eid){ const l=cmdEpicItems(eid); return { total:l.length, done:l.filter(x=>x.b==='ok').length, ask:l.filter(x=>x.b==='ask').length, run:l.filter(x=>x.b==='run').length, bad:l.filter(x=>x.b==='bad').length, rev:l.filter(x=>x.b==='rev'||x.b==='pr').length, l }; }
function cmdEpicCard(e){ const c=cmdEpicStat(e.id), p=[]; if(c.ask) p.push(nPl(c.ask,'espera você','esperam você')); if(c.bad) p.push(c.bad+' com erro'); if(c.run) p.push(c.run+' rodando'); if(c.rev) p.push(c.rev+' pra revisar');
  return `<div class="cmdiss"><div class="cmdiss-h"><b>${esc(e.name)}</b><span class="cmdhint">${e.status==='done'?'entregue':c.total?`${c.done} de ${c.total} entregues`:'sem tarefas ainda'}${p.length?' · '+esc(p.join(', ')):''}</span></div><div class="cmdiss-a"><button type="button" class="btn sm" data-cmdepic="${escA(e.id)}">Ver as tarefas</button><button type="button" class="btn sm quiet" data-cmdepopen="${escA(e.id)}">Abrir o épico</button></div></div>`; }
function cmdEpicHtml(eid){ const e=cmdEpics().find(x=>x.id===eid); if(!e) return '<p>Não achei esse épico.</p>';
  const c=cmdEpicStat(eid), row=x=>{ const t=x.local?cmdTask(x.local):null; if(t) return cmdRow(t);
    return `<div class="cmdrow off"><span class="cmddot" style="background:${stColor(x.st)}"></span><span class="cmdcode">${esc(x.code||'')}</span><span class="cmdtt">${esc(x.title)}<small>${x.who&&typeof personName==='function'?'com '+esc(personName(x.who,{ noYou:true })):'no time — não está nesta máquina'}</small></span><span class="cmdst" style="color:${stColor(x.st)}">${esc(stShort(x.st))}</span></div>`; };
  const ondas=[...new Set(c.l.map(x=>x.wave||1))].sort((a,b)=>a-b);
  return `<p><b>${esc(e.name)}</b>: ${c.total?`${c.done} de ${nPl(c.total,'tarefa entregue','tarefas entregues')}`:'ainda sem tarefas'}.</p>`
    +ondas.map(w=>`${ondas.length>1?`<span class="cmdeye">Onda ${w}</span>`:''}<div class="cmdrows">${c.l.filter(x=>(x.wave||1)===w).map(row).join('')}</div>`).join('')
    +cmdEpicAgoraHtml(eid); }
// o "agora" do épico: a MESMA frase e a MESMA ação da aba do épico (81-epico-aba: epaModelOf), lidas da nuvem na hora
const CMDE={};
const CMD_EPACT={ start:'Começar o épico', liberar:'Liberar a onda', verificar:'Rodar a verificação final', entregar:'Entregar o épico' };
async function cmdEpicLoad(eid){
  try{ if(typeof epicPageLoad!=='function' || typeof epaModelOf!=='function') return null;
    const c=await epicPageLoad(eid), ep=c.ep||((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===eid); if(!ep) return null;
    const locOnly=(typeof epStartItems==='function'?epStartItems(eid):[]).filter(x=>x.kind==='local' && !(c.tasks||[]).some(ct=>ct.local_id===x.id || ((typeof tmap==='function')&&tmap()[x.id]===ct.id)))
      .map(x=>({ ...x.t, _local:x.id, spec:{ wave:x.wave, verify:(x.t.epic||{}).verify, covers:(x.t.epic||{}).covers } }));
    const tasks=(c.tasks||[]).concat(locOnly);
    return (CMDE[eid]={ ep, c, tasks, R:epaModelOf(ep, c, tasks) }); }
  catch(e){ console.warn('comando épico', e); return null; }
}
function cmdEpicAgoraHtml(eid){ const L=CMDE[eid]; if(!L) return '<p class="cmdhint">lendo o épico…</p>';
  const a=L.R.m.agora||{}, act=a.act&&CMD_EPACT[a.act.k]?a.act:null;
  return `<div class="cmdagora"><b>Agora:</b> ${esc(a.s||'')}${a.m?`<small>${esc(a.m)}</small>`:''}</div>`
    +`<div class="cmdiss-a">${act?`<button type="button" class="btn sm primary" data-cmdepact="${escA(act.k)}" data-id="${escA(eid)}"${act.wave?` data-wave="${act.wave}"`:''}>${esc(act.label||CMD_EPACT[act.k])}</button>`:''}<button type="button" class="btn sm${act?' quiet':''}" data-cmdepopen="${escA(eid)}">Abrir o épico</button></div>`; }
/** Executa a ação DO MOMENTO do épico (só a que a aba dele ofereceria agora), com confirmação. */
async function cmdEpicAct(eid, k, wave){
  const L=await cmdEpicLoad(eid), ms=cmdMsgs(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); };
  if(!L) return say('Não consegui ler esse épico agora.');
  const a=L.R.m.agora||{}, act=a.act||null, nome=L.ep.name||'épico';
  if(!act || act.k!==k) return say(`Agora não dá pra ${String(CMD_EPACT[k]||k).toLowerCase()} em “${nome}”. ${a.s||''}`);
  const w=+wave||act.wave||1;
  if(!await askYes(`${act.label||CMD_EPACT[k]} — “${nome}”?\n\n${a.s||''}${k==='entregar'?'\n\nFecha o épico, gera o relatório e avisa quem pediu.':k==='start'?'\n\nAs tarefas da primeira onda começam a rodar.':''}`, CMD_EPACT[k])){ ms.push({ r:'sys', text:'cancelado — o épico ficou como estava' }); return cmdPaint(true); }
  try{ EPA.last=L; EPA.eid=eid;
    if(k==='start') await epaStart(L.ep, null); else if(k==='liberar') await epaRelease(L.ep, w); else if(k==='verificar') await epFinalRun(eid, { manual:true }); else if(k==='entregar') await epEntregar(L.ep, null);
  }catch(e){ showErr(e, 'Não consegui '+String(CMD_EPACT[k]||k).toLowerCase()); }
  try{ lastSig=''; }catch(_){ } try{ await refresh(); }catch(_){ }
  await cmdEpicLoad(eid); ms.push({ r:'bot', k:'epico', id:eid }); cmdPaint(true);
}
function cmdLinks(t){ const code=cmdCode(t), iss=code?cmdIssue(code):null; const out=[];
  const iu=t.issueUrl||(iss&&iss.url)||''; if(iu) out.push(['Issue'+(code?' '+code:''), iu]);
  if(t.prUrl) out.push(['Pull request', t.prUrl]);
  if(t.branch) out.push(['Branch', t.branch, true]);
  return out; }
function cmdLinkRow(l){ return `<div class="cmdlk"><span class="cmdlk-l">${esc(l[0])}</span><span class="cmdlk-v mono">${esc(l[1])}</span>${l[2]?'':`<button type="button" class="btn sm quiet" data-cmdlk="${escA(l[1])}">abrir ↗</button>`}<button type="button" class="btn sm quiet" data-cmdcopy="${escA(l[1])}">copiar</button></div>`; }
function cmdLinksHtml(l){ return l.length?`<div class="cmdlks">${l.map(cmdLinkRow).join('')}</div>`:''; }

// ---------- peças ----------
function cmdRow(t){ const st=taskSt(t), q=cmdIsAsk(t)?cmdAskTitle(t):'';
  return `<button type="button" class="cmdrow${CMD.sel===t.id?' on':''}" data-cmdsel="${escA(t.id)}"><span class="cmddot" style="background:${stColor(st)}"></span><span class="cmdcode">${esc(cmdCode(t))}</span><span class="cmdtt">${esc(mdTitle(t.title||''))}${q?`<small>${esc(q)}</small>`:''}</span><span class="cmdst" style="color:${stColor(st)}">${esc(stShort(st))}</span></button>`; }
function cmdRows(l){ return l.length?`<div class="cmdrows">${l.map(cmdRow).join('')}</div>`:''; }
function cmdCounts(l){ const n=f=>l.filter(f).length; return { all:l.length, ask:n(cmdIsAsk), bad:n(cmdIsBad), run:n(cmdIsRun), rev:n(t=>(CMD_ORDEM[taskSt(t)]??5)===2), pr:n(t=>taskSt(t)==='pr-open') }; }
function cmdResumo(c){ if(!c.all) return 'Nenhuma tarefa aberta neste projeto.';
  const p=[]; if(c.ask) p.push(`<b>${nPl(c.ask,'espera','esperam')} você</b>`); if(c.bad) p.push(`<b>${nPl(c.bad,'parou','pararam')} com erro</b>`); if(c.run) p.push(nPl(c.run,'rodando','rodando')); if(c.rev) p.push(nPl(c.rev,'pronta pra revisar','prontas pra revisar')); if(c.pr) p.push(nPl(c.pr,'com PR aberto','com PR aberto'));
  return `${nPl(c.all,'tarefa aberta','tarefas abertas')}${p.length?': '+p.join(', '):''}.`; }

// ---------- respostas (montadas dos dados na hora de pintar: a lista da conversa acompanha o estado) ----------
function cmdBotHtml(m){
  const L=cmdTasks();
  if(m.k==='status') return `<p>${cmdResumo(cmdCounts(L))}</p>${cmdRows(L)}${L.length?'<p class="cmdhint">Clique numa tarefa pra ver ela inteira ao lado.</p>':''}`;
  if(m.k==='espera'){ const l=L.filter(cmdIsAsk); return l.length?`<p>${nPl(l.length,'tarefa parada esperando','tarefas paradas esperando')} você. Clique pra responder ao lado, sem abrir a tarefa.</p>${cmdRows(l)}`:'<p>Nada esperando por você agora.</p>'; }
  if(m.k==='erro'){ const l=L.filter(cmdIsBad); return l.length?`<p>${nPl(l.length,'tarefa parou','tarefas pararam')} com erro. Clique pra ver o que aconteceu.</p>${cmdRows(l)}`:'<p>Nenhuma tarefa parada com erro.</p>'; }
  if(m.k==='tarefa'||m.k==='porque'){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está mais aberta.</p>';
    const h=CMD.hist[t.id], it=(h&&h.items)||[], st=taskSt(t), say=cmdLastSay(it), er=cmdLastErr(it), q=cmdAskTitle(t), pl=cmdPlan(it), now=pl.find(x=>x.st==='now'), fs=cmdFiles(it);
    const partes=[`<p><b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b> está <b style="color:${stColor(st)}">${esc(stLabel(st))}</b>.${q?' Pergunta aberta: '+esc(q):''}</p>`];
    if(!h) partes.push('<p class="cmdhint">lendo o que a IA fez…</p>');
    else {
      if(m.k==='porque' && er) partes.push(`<p>O último erro foi em <span class="mono">${esc(er.name)} ${esc(cmdUma(er.arg))}</span>${er.out?': '+esc(er.out):''}.</p>`);
      else if(m.k==='porque' && !er && !q) partes.push('<p>Não achei erro de ferramenta na sessão; veja o caminho ao lado.</p>');
      if(now) partes.push(`<p>No plano, está em: <b>${esc(now.tx)}</b> (${pl.filter(x=>x.st==='ok').length} de ${pl.length} feitos).</p>`);
      if(fs.length) partes.push(`<p>${nPl(fs.length,'arquivo mexido','arquivos mexidos')}.</p>`);
      if(say) partes.push(`<div class="cmdquote">${mdToHtml(say.length>600?say.slice(0,600)+'…':say)}</div>`);
    }
    return partes.join('')+cmdRows([t]); }
  if(m.k==='issue'){ const t=cmdIssueTask(m.code); if(t) return `<p><b>${esc(m.code)}</b> já é uma tarefa aberta.</p>${cmdRows([t])}`;
    const i=cmdIssue(m.code); if(!i) return `<p>Não achei a <b>${esc(m.code)}</b> nas tarefas nem no painel de issues.</p>`;
    return `<p>A <b>${esc(m.code)}</b> está no painel e ainda não virou tarefa. Começo com a sua IA padrão, numa branch nova?</p>${cmdIssueCard(i)}`; }
  if(m.k==='fila'){ if(!cmdTrkOn()) return `<p>O painel de issues ainda não está conectado neste projeto.</p><div><button type="button" class="btn sm" data-cmdgo="issues">Conectar em Issues</button></div>`;
    const f=cmdFila(); return f.length?`<p>${nPl(f.length,'issue do painel ainda não virou tarefa','issues do painel ainda não viraram tarefa')}.${f.length>8?' As 8 mais recentes:':''}</p><div class="cmdisss">${f.slice(0,8).map(cmdIssueCard).join('')}</div>`:'<p>Nenhuma issue do painel esperando pra começar.</p>'; }
  if(m.k==='epicos'){ const E=cmdEpics(); return E.length?`<p>${nPl(E.length,'épico','épicos')} neste espaço.</p><div class="cmdisss">${E.map(cmdEpicCard).join('')}</div>`:'<p>Nenhum épico aberto. Um épico nasce em Nova demanda › Montar com IA, ou no quadro do time.</p>'; }
  if(m.k==='epico') return cmdEpicHtml(m.id);
  if(m.k==='link'){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>'; const l=cmdLinks(t);
    return l.length?`<p>Links da <b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b>:</p>${cmdLinksHtml(l)}`:'<p>Essa tarefa ainda não tem issue ligada nem PR aberto.</p>'; }
  if(m.k==='isslink'){ const i=cmdIssue(m.code); return i&&i.url?`<p>Link da <b>${esc(m.code)}</b>:</p>${cmdLinksHtml([['Issue '+m.code, i.url]])}`:`<p>O painel não devolveu um link pra <b>${esc(m.code)}</b>.</p>`; }
  if(m.k==='provas'){ if(m.id){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>';
      return typeof proofPanel==='function'?`<p>Provas da <b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b>. Clique num print pra ampliar.</p><div class="cmdproof">${proofPanel(t.id, 'compact')}</div>`:'<p>O painel de provas não está disponível.</p>'; }
    let f=[]; try{ f=apFila(); }catch(_){ } return f.length?`<p>${nPl(f.length,'tarefa terminou','tarefas terminaram')} com provas pra ver. Clique numa e peça "provas", ou abra Para aprovar.</p>${cmdRows(f)}<div class="cmdiss-a"><button type="button" class="btn sm" data-cmdgo="aprovar">Abrir Para aprovar</button></div>`:'<p>Nenhuma tarefa com provas esperando agora.</p>'; }
  if(m.k==='md') return mdToHtml(m.text||'');
  return `<p>${esc(m.text||'')}</p>`;
}
function cmdLogHtml(){
  const ms=cmdMsgs(), c=cmdCounts(cmdTasks());
  const oi=`<div class="cmdmsg bot"><span class="cmdav">${IC.starfork||''}</span><div class="cmdbub"><p>${c.all?cmdResumo(c):'Nenhuma tarefa aberta neste projeto ainda.'} Pergunte qualquer coisa ou mande fazer.</p></div></div>`;
  return oi+ms.map(m=>m.r==='you'?`<div class="cmdmsg you"><div class="cmdbub">${esc(m.text)}</div></div>`
    :m.r==='sys'?`<div class="cmdmsg sys">${esc(m.text)}</div>`
    :`<div class="cmdmsg bot"><span class="cmdav">${IC.starfork||''}</span><div class="cmdbub">${cmdBotHtml(m)}</div></div>`).join('')
    +(CMD.busy?`<div class="cmdmsg bot"><span class="cmdav">${IC.starfork||''}</span><div class="cmdbub"><span class="pltyping"><i></i><i></i><i></i></span> <span class="cmdhint">lendo o projeto…</span></div></div>`:'');
}

// ---------- painel: todos os agentes → visão geral da tarefa ----------
function cmdHora(ts){ if(!ts) return ''; const d=new Date(ts); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function cmdSec(t, body, extra){ return `<section class="cmdsec"><h3>${esc(t)}${extra||''}</h3>${body}</section>`; }
function cmdFleetHtml(){ const L=cmdTasks(), c=cmdCounts(L), proj=pathBase(cmdRepo());
  const n=(v,l,cor)=>`<span class="cmdn"><b${cor&&v?` style="color:${cor}"`:''}>${v}</b>${l}</span>`;
  return `<div class="cmdside-h"><span class="cmdeye">Agora${proj?' · '+esc(proj):''}</span><h2>Todos os agentes</h2><div class="cmdns">${n(c.run,'rodando','var(--st-run)')}${n(c.ask,'esperando você','var(--st-ask)')}${n(c.bad,'com erro','var(--st-err)')}${n(c.rev+c.pr,'pra revisar','var(--st-review)')}</div></div>`
    +(L.length?cmdRows(L):emptyHtml({ icon:'inbox', title:'Nenhuma tarefa aberta', help:'Crie uma demanda ou puxe uma issue do painel.' }))
    +`<div class="cmdside-f"><button type="button" class="btn sm" data-cmdgo="nova">${semIc('plus')}Nova demanda</button><button type="button" class="btn sm quiet" data-cmdgo="issues">Issues</button><button type="button" class="btn sm quiet" data-cmdgo="central">Central</button></div>`; }
function cmdTaskHtml(t){
  const st=taskSt(t), h=CMD.hist[t.id], it=(h&&h.items)||[], ask=cmdAsk(t);
  const obj=String(t.objective||'').split('[PLANO DO ORQUESTRADOR')[0].trim();
  const reqs=(Array.isArray(t.requirements)?t.requirements:[]).map(r=>typeof r==='string'?{ text:r }:r).filter(r=>r&&(r.text||r.title));
  const ck=(ok,now,tx,sub)=>`<div class="cmdck${ok?' ok':now?' now':''}"><i>${ok?'✓':''}</i><span>${esc(tx)}${sub?`<small>${esc(sub)}</small>`:''}</span></div>`;
  const pl=cmdPlan(it), dec=cmdDecisions(it), fs=cmdFiles(it), path=cmdPath(it, 30);
  const carregando='<p class="cmdmuted">lendo a sessão…</p>';
  return `<button type="button" class="cmdback" data-cmdsel="">${semIc('arrowR','rev')}todos os agentes</button>
    <div class="cmdside-h"><div class="cmdpills">${cmdCode(t)?`<span class="cmdpill mono">${esc(cmdCode(t))}</span>`:''}${stBadge(st)}${t.branch?`<span class="cmdpill mono" title="branch">${esc(t.branch)}</span>`:''}</div><h2>${esc(mdTitle(t.title||''))}</h2>
      <div class="cmdacts"><button type="button" class="btn sm primary" data-cmdopen="${escA(t.id)}">Abrir a tarefa ${semIc('arrowR')}</button>${cmdIsRun(t)?`<button type="button" class="btn sm" data-cmdstop="${escA(t.id)}">Parar</button>`:''}<button type="button" class="btn sm quiet" data-cmddo="provas" data-id="${escA(t.id)}">Provas</button>${cmdLinks(t).filter(l=>!l[2]).map(l=>`<button type="button" class="btn sm quiet" data-cmdlk="${escA(l[1])}">${esc(l[0])} ↗</button>`).join('')}</div></div>
    ${ask?cmdSec('Precisa de você', `<div class="cmdask" data-tlinline="${escA(t.id)}"></div>`):''}
    ${cmdSec('Pedido', (obj?`<div class="cmdobj">${mdToHtml(obj.length>900?obj.slice(0,900)+'…':obj)}</div>`:'<p class="cmdmuted">Esta tarefa não tem descrição além do título.</p>')
      +(reqs.length?`<div class="cmdcks">${reqs.map(r=>ck(r.status==='done', false, r.text||r.title, r.status==='done'?'':'sem prova ainda')).join('')}</div>`:''))}
    ${cmdSec('Plano da IA', !h?carregando:pl.length?`<div class="cmdcks">${pl.map(p=>ck(p.st==='ok', p.st==='now', p.tx, p.st==='now'?'agora':'')).join('')}</div>`:'<p class="cmdmuted">A IA não declarou um plano nesta sessão.</p>', pl.length?`<span>${pl.filter(p=>p.st==='ok').length} de ${pl.length}</span>`:'')}
    ${cmdSec('Decisões', !h?carregando:dec.length?dec.map(d=>`<div class="cmddec${d.a?'':' open'}"><span>${esc(d.q)}</span><small>${d.a?'você respondeu: '+esc(d.a):'esperando sua resposta'}</small></div>`).join(''):'<p class="cmdmuted">A IA não perguntou nada até aqui.</p>')}
    ${cmdSec('Caminho', !h?carregando:path.length?`<div class="cmdtl">${path.map(p=>`<div class="k-${p.k}${p.err?' err':''}"><time>${cmdHora(p.ts)}</time><em>${esc(p.v)}</em><span>${esc(p.tx)}</span></div>`).join('')}</div>`:'<p class="cmdmuted">Nada registrado nesta sessão ainda.</p>', it.length>path.length?'<span>últimos passos</span>':'')}
    ${cmdSec('Arquivos mexidos', !h?carregando:fs.length?`<div class="cmdfiles">${fs.slice(0,14).map(f=>`<span class="f">${esc(f.f)}</span><span class="a">+${f.add}</span><span class="d">−${f.del}</span>`).join('')}</div>`:'<p class="cmdmuted">Nenhum arquivo mudou ainda.</p>', fs.length?`<span>${fs.length}</span>`:'')}
    <form class="cmdinst" data-cmdinst="${escA(t.id)}"><input class="in" id="cmdInst" placeholder="Diga à IA o que mudar nesta tarefa" autocomplete="off" aria-label="instrução para esta tarefa"><button class="btn primary sm">enviar</button></form>`;
}
function cmdSideHtml(){ const t=CMD.sel?cmdTask(CMD.sel):null; if(CMD.sel && !t) CMD.sel=''; return t?cmdTaskHtml(t):cmdFleetHtml(); }

// ---------- histórico da sessão (o MESMO term_history do terminal; incremental) ----------
function cmdHistLoad(id){ const h=CMD.hist[id]; if(h && h.busy) return; const at=h&&h.at||0; if(h && Date.now()-at<4000) return;
  const cur=h||(CMD.hist[id]={ items:null, stamp:'' }); cur.busy=true;
  invokeQuiet('term_history',{ taskId:id, since:(cur.items&&cur.stamp)||null }).then(r=>{ cur.busy=false; cur.at=Date.now();
    if(r && !r.unchanged){ cur.items=Array.isArray(r.items)?r.items:[]; cur.stamp=r.stamp||''; } else if(!cur.items) cur.items=[];
    CMD.hist[id]=cur; cmdPaint(); }).catch(()=>{ cur.busy=false; cur.at=Date.now(); if(!cur.items) cur.items=[]; cmdPaint(); }); }
// a "visão" só conta como carregada depois da 1ª leitura
function cmdHistReady(id){ const h=CMD.hist[id]; return !!(h && h.items); }

// ---------- voz: conversa falada (você fala, eu respondo em voz alta e volto a ouvir) ----------
// Ouvir = reconhecimento de fala do sistema (quando o WebView oferece); falar = speechSynthesis. Sem reconhecimento,
// o modo ainda LÊ as respostas e a pessoa dita pelo ditado do macOS.
const CMDV={ on:false, rec:null, live:false, speaking:false };
const CMD_MIC='<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2"/></svg>';
function cmdVoiceApi(){ return window.SpeechRecognition||window.webkitSpeechRecognition||null; }
function cmdVoicePaint(){ const b=$id('cmdMic'); if(!b) return; b.classList.toggle('on', CMDV.on); b.setAttribute('aria-pressed', String(CMDV.on));
  b.innerHTML=CMD_MIC+(CMDV.on?`<span>${CMDV.speaking?'falando…':CMDV.live?'ouvindo…':'voz ligada'}</span>`:''); b.title=CMDV.on?'Desligar a conversa por voz':'Conversar por voz: você fala, eu respondo em voz alta'; }
function cmdVoiceListen(on){
  const R=cmdVoiceApi(); if(!R) return;
  if(!on){ CMDV.live=false; try{ if(CMDV.rec) CMDV.rec.abort(); }catch(_){ } CMDV.rec=null; return cmdVoicePaint(); }
  if(CMDV.live || !CMDV.on || CMDV.speaking || CMD.busy) return;
  const r=new R(); r.lang='pt-BR'; r.interimResults=true; r.continuous=false; r.maxAlternatives=1;
  r.onresult=(e)=>{ let fin='', mid=''; for(let k=e.resultIndex;k<e.results.length;k++){ const x=e.results[k]; if(x.isFinal) fin+=x[0].transcript; else mid+=x[0].transcript; }
    const q=$id('cmdQ'); if(q) q.value=(fin||mid).trim(); if(fin.trim()){ if(q) q.value=''; cmdSay(fin.trim()); } };
  r.onerror=(e)=>{ CMDV.live=false; const k=String(e&&e.error||'');
    if(k==='not-allowed'||k==='service-not-allowed'||k==='audio-capture'){ CMDV.on=false; toast('O macOS não liberou o microfone pro Starfork. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone e Reconhecimento de Fala.','warn'); } cmdVoicePaint(); };
  r.onend=()=>{ CMDV.live=false; if(CMDV.rec===r) CMDV.rec=null; cmdVoicePaint(); if(CMDV.on && !CMDV.speaking && !CMD.busy) setTimeout(()=>cmdVoiceListen(true), 300); };
  CMDV.rec=r; try{ r.start(); CMDV.live=true; }catch(_){ CMDV.rec=null; } cmdVoicePaint();
}
function cmdSpeak(text){
  text=String(text||'').replace(/\s+/g,' ').trim(); if(!CMDV.on) return;
  if(!text || !window.speechSynthesis){ cmdVoiceListen(true); return; }
  try{ speechSynthesis.cancel(); cmdVoiceListen(false);
    const u=new SpeechSynthesisUtterance(text.length>500?text.slice(0,500):text); u.lang='pt-BR'; u.rate=1.05;
    const v=speechSynthesis.getVoices().find(x=>/^pt[-_]BR/i.test(x.lang)); if(v) u.voice=v;
    CMDV.speaking=true; const fim=()=>{ if(!CMDV.speaking) return; CMDV.speaking=false; cmdVoicePaint(); if(CMDV.on) cmdVoiceListen(true); };
    u.onend=fim; u.onerror=fim; speechSynthesis.speak(u); cmdVoicePaint();
  }catch(_){ CMDV.speaking=false; cmdVoiceListen(true); }
}
function cmdVoiceToggle(){
  CMDV.on=!CMDV.on;
  if(!CMDV.on){ CMDV.speaking=false; cmdVoiceListen(false); try{ speechSynthesis.cancel(); }catch(_){ } return cmdVoicePaint(); }
  CMD.spoken=cmdMsgs().length; // só fala o que vier a partir de agora
  if(cmdVoiceApi()) cmdVoiceListen(true);
  else toast('Vou ler as respostas em voz alta. Pra falar, use o ditado do macOS neste campo (tecla do microfone, ou Fn duas vezes).','info');
  cmdVoicePaint();
}
// a fala de uma resposta = os parágrafos dela (listas e botões ficam na tela)
function cmdSpeakNew(log){
  const ms=cmdMsgs(); if(!CMDV.on || CMD.busy || ms.length<=CMD.spoken) return; const m=ms[ms.length-1]; CMD.spoken=ms.length; if(!m || m.r!=='bot'){ if(m && m.r==='sys') cmdVoiceListen(true); return; }
  const bubs=log.querySelectorAll('.cmdmsg.bot .cmdbub'), bub=bubs[bubs.length-1]; if(!bub) return;
  const ps=[...bub.querySelectorAll(':scope > p:not(.cmdhint), :scope > .cmdquote')].map(n=>n.textContent).join(' ');
  cmdSpeak(ps||bub.textContent);
}

// ---------- página ----------
const CMD_CHIPS=['Como estão os agentes?','O que está me esperando?','Alguma tarefa parou?','O que tem na fila de issues?','Como estão os épicos?'];
function cmdMount(){
  const pg=$id('comandoPage'); if(!pg || CMD.mounted) return; CMD.mounted=true;
  pg.innerHTML=`<div class="cmdpg"><section class="cmdchat" aria-label="Comando">
      <div class="cmdlog" id="cmdLog" aria-live="polite"></div>
      <div class="cmdcomp"><div class="cmdchips">${CMD_CHIPS.map(c=>`<button type="button" class="cmdchip" data-cmdchip="${escA(c)}">${esc(c)}</button>`).join('')}</div>
        <form class="cmdbar" id="cmdForm"><input class="in" id="cmdQ" placeholder="Pergunte ou mande fazer — ex.: como estão os agentes?" autocomplete="off" spellcheck="false" aria-label="comando"><button type="button" class="btn sm cmdmic" id="cmdMic" aria-pressed="false"></button><button type="button" class="btn sm" id="cmdStop" style="display:none">${IC.stop||''} parar</button><button class="btn primary sm" id="cmdSend">enviar</button></form></div>
    </section><aside class="cmdside" id="cmdSide" aria-label="painel dos agentes"></aside></div>`;
  $id('cmdForm').addEventListener('submit', e=>{ e.preventDefault(); const q=$id('cmdQ'); const v=q.value; q.value=''; cmdSay(v); });
  $id('cmdStop').onclick=()=>{ if(!CMD.busy) return; CMD.stopping=true; invoke('project_chat_stop').catch(()=>{}); };
  $id('cmdMic').onclick=cmdVoiceToggle; cmdVoicePaint();
  pg.addEventListener('click', cmdClick);
  pg.addEventListener('submit', e=>{ const f=e.target.closest&&e.target.closest('[data-cmdinst]'); if(!f) return; e.preventDefault(); const i=f.querySelector('input'), v=i.value.trim(); if(!v) return;
    const id=f.dataset.cmdinst; i.value=''; Promise.resolve(typeof tiSend==='function'?tiSend(id, v):false).then(ok=>{ if(ok!==false){ toast('instrução enviada — a IA continua','ok'); const h=CMD.hist[id]; if(h) h.at=0; cmdHistLoad(id); } else i.value=v; }).catch(e2=>{ i.value=v; showErr(e2,'Não consegui enviar a instrução'); }); });
}
function cmdClick(e){
  const b=e.target.closest('[data-cmdsel],[data-cmdchip],[data-cmdopen],[data-cmdstop],[data-cmdgo],[data-cmdstart],[data-cmdform],[data-cmdlk],[data-cmdcopy],[data-cmdepic],[data-cmdepopen],[data-cmddo],[data-cmdepact]'); if(!b) return;
  if(b.dataset.cmdepact) return cmdEpicAct(b.dataset.id, b.dataset.cmdepact, b.dataset.wave);
  if(b.dataset.cmdlk) return openExternal(b.dataset.cmdlk);
  if(b.dataset.cmdcopy){ try{ navigator.clipboard.writeText(b.dataset.cmdcopy); toast('copiado','ok'); }catch(_){ toast('não consegui copiar','warn'); } return; }
  if(b.dataset.cmdepic) return cmdDo({ k:'epico', id:b.dataset.cmdepic });
  if(b.dataset.cmdepopen) return (typeof epOpenById==='function')?epOpenById(b.dataset.cmdepopen):undefined;
  if(b.dataset.cmddo) return cmdDo({ k:b.dataset.cmddo, id:b.dataset.id||'' });
  if(b.dataset.cmdstart) return cmdStartIssue(b.dataset.cmdstart);
  if(b.dataset.cmdform){ const i=cmdIssue(b.dataset.cmdform); return i?trkIssueToTask(i, 'run'):undefined; }
  if(b.dataset.cmdchip!==undefined) return cmdSay(b.dataset.cmdchip);
  if(b.dataset.cmdsel!==undefined){ CMD.sel=b.dataset.cmdsel; if(CMD.sel) cmdHistLoad(CMD.sel); cmdPaint(); const s=$id('cmdSide'); if(s) s.scrollTop=0; return; }
  if(b.dataset.cmdopen) return openTaskById(b.dataset.cmdopen);
  if(b.dataset.cmdstop) return cmdStopTasks([b.dataset.cmdstop]);
  if(b.dataset.cmdgo){ const k=b.dataset.cmdgo; return cmdTela(k==='central'?'flow':k); }
}
async function cmdStopTasks(ids){
  const ts=ids.map(cmdTask).filter(Boolean); if(!ts.length) return false;
  if(!await askYes(`Parar ${nPl(ts.length,'agente','agentes')}?\n\n${ts.map(t=>'• '+(cmdCode(t)?cmdCode(t)+' ':'')+mdTitle(t.title||'')).join('\n')}\n\nO que já foi feito fica salvo na branch. Dá pra retomar depois.`, 'Parar')) return false;
  for(const t of ts){ try{ await stopTask(t.id); }catch(_){ } }
  cmdMsgs().push({ r:'bot', k:'txt', text:`Parei ${nPl(ts.length,'agente','agentes')}. O trabalho feito está salvo na branch de cada tarefa.` }); cmdPaint(true); return true;
}
function cmdTela(k){ if(k==='flow'||k==='aprovar') return openTab(k); return (typeof semIr==='function' && ['meu','semana','entregas','issues','projetos','nova'].includes(k))?semIr(k):openTab(k); }
function cmdResolve(text){ const all=cmdTasks().concat(cmdAllTasks().filter(taskEncerrada)); // abertas primeiro; as entregues ainda respondem por provas e links
  return cmdIntent(text, all.map(t=>({ id:t.id, code:cmdCode(t), title:mdTitle(t.title||'') })), cmdEpics()); }
/** Executa UMA ação (vinda da frase da pessoa, de um botão ou da linha "ACAO:" da IA). true = tratou. */
async function cmdDo(it){
  const ms=cmdMsgs(), L=cmdTasks(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); return true; };
  switch(it.k){
    case 'status': case 'espera': case 'erro': case 'epicos': ms.push({ r:'bot', k:it.k }); cmdPaint(true); return true;
    case 'epico': if(it.act){ cmdPaint(true); await cmdEpicAct(it.id, it.act); return true; }
      ms.push({ r:'bot', k:'epico', id:it.id }); cmdPaint(true); cmdEpicLoad(it.id).then(()=>cmdPaint()); return true;
    case 'tarefa': case 'porque': CMD.sel=it.id; cmdHistLoad(it.id); ms.push({ r:'bot', k:it.k, id:it.id }); cmdPaint(true); return true;
    case 'link': ms.push({ r:'bot', k:'link', id:it.id }); cmdPaint(true); return true;
    case 'provas': { const t=it.id?cmdTask(it.id):null; if(t){ CMD.sel=t.id; cmdHistLoad(t.id); try{ apEnsure(t); }catch(_){ } } ms.push({ r:'bot', k:'provas', id:it.id||'' }); cmdPaint(true); return true; }
    case 'abrir': say('Abrindo a tarefa.'); openTaskById(it.id); return true;
    case 'tela': say('Abrindo.'); cmdTela(it.tela); return true;
    case 'instruir': { const t=cmdTask(it.id); if(!t) return say('Essa tarefa não está nesta máquina.');
      let ok=false; try{ ok=(await tiSend(it.id, it.text))!==false; }catch(e){ showErr(e, 'Não consegui enviar a instrução'); }
      if(ok){ CMD.sel=it.id; const h=CMD.hist[it.id]; if(h) h.at=0; cmdHistLoad(it.id); }
      return say(ok?`Mandei pra IA da ${cmdCode(t)||'tarefa'}: “${it.text}”.`:'A instrução não foi enviada.'); }
    case 'parar': { const alvo=it.id?[it.id]:L.filter(cmdIsRun).map(t=>t.id);
      if(!alvo.length || (it.id && !cmdIsRun(cmdTask(it.id)))) return say(it.id?'Essa tarefa não está rodando agora.':'Nenhum agente rodando agora.');
      if(!await cmdStopTasks(alvo)){ ms.push({ r:'sys', text:'cancelado — nada foi parado' }); cmdPaint(true); } return true; }
    case 'fila': case 'issue': { cmdPaint(true); await cmdIssuesEnsure();
      // "EAN-13", "UTF-8"… parecem código mas não são issue: sem pedido de começar e sem achar no painel, é pergunta livre
      if(it.k==='issue' && !it.go && !cmdIssue(it.code) && !cmdIssueTask(it.code)) return false;
      ms.push(it.k==='fila'?{ r:'bot', k:'fila' }:(it.link && cmdIssue(it.code) && !cmdIssueTask(it.code))?{ r:'bot', k:'isslink', code:it.code }:{ r:'bot', k:'issue', code:it.code }); cmdPaint(true); return true; }
  }
  return false;
}
async function cmdSay(text){
  text=String(text||'').trim(); if(!text) return; if(CMD.busy){ toast('espere a resposta — ou pare','warn'); return; }
  const ms=cmdMsgs(), L=cmdTasks(); ms.push({ r:'you', text }); cmdPaint(true);
  const it=cmdResolve(text);
  if(it.k!=='ia' && await cmdDo(it)) return;
  // pergunta livre: a IA do chat do projeto (lê o código de verdade), com o estado junto. Se o pedido era uma ação
  // dita de outro jeito, ela devolve "ACAO: …" e o app executa (as que mexem em algo pedem confirmação como sempre).
  if(typeof pcBusy!=='undefined' && pcBusy){ ms.push({ r:'sys', text:'o Chat do projeto está respondendo outra pergunta — espere terminar' }); return cmdPaint(true); }
  CMD.busy=true; CMD.stopping=false; cmdPaint(true);
  const repo=cmdRepo(), sidKey='cmdsid:'+repo, out=CMD.msgs[repo]||ms;
  const snap=cmdSnapshot(L.map(t=>({ code:cmdCode(t), title:mdTitle(t.title||''), st:stLabel(taskSt(t)), branch:t.branch||'', q:cmdIsAsk(t)?cmdAskTitle(t):'' })), pathBase(repo),
    cmdEpics().map(e=>{ const c=cmdEpicStat(e.id); return { name:e.name, done:c.done, total:c.total }; }));
  let acao='';
  try{
    const hist=ms.slice(0,-1).filter(m=>m.r==='you'||m.k==='md').map(m=>({ role:m.r==='you'?'user':'assistant', text:m.text||'' }));
    const r=await aiCallResumeSafe((pr,sid)=>invoke('project_chat',{ prompt:pr, sessionId:sid||'', model:aiClaudeModel() }), lsGet(sidKey)||'', snap+'\n\n'+text, hist);
    aiKeepSid(r, s=>lsSet(sidKey, s));
    const tx=(r&&r.text)||''; acao=cmdAcaoDe(tx);
    if(!acao) out.push({ r:'bot', k:'md', text:tx||'(sem resposta)' });
  }catch(e){ const msg=String((e&&e.message)||e||'');
    if(CMD.stopping||/PROJECT_CHAT_STOPPED/.test(msg)) out.push({ r:'sys', text:'parado' });
    else { const h=humanErr(msg); out.push({ r:'sys', text:'Não consegui responder: '+(h&&h.msg?h.msg:msg.slice(0,240)) }); if(h&&h.action) showErr(e); } }
  CMD.busy=false; CMD.stopping=false;
  if(acao){ const it2=cmdResolve(acao); if(it2.k==='ia' || !it2.k || !(await cmdDo(it2))) out.push({ r:'bot', k:'txt', text:'Entendi o pedido como “'+acao+'”, mas não achei como fazer isso daqui.' }); }
  cmdPaint(true);
}
function cmdPaint(down){
  const pg=$id('comandoPage'); if(!pg) return; cmdMount();
  const log=$id('cmdLog'), side=$id('cmdSide'); if(!log||!side) return;
  let a='', b='';
  try{ a=cmdLogHtml(); b=cmdSideHtml(); }catch(e){ console.error('comando', e); b=emptyHtml({ icon:'alert', title:'Não consegui montar esta tela', help:String(e&&e.message||e) }); }
  if(CMD.logHtml!==a){ const fim=down || log.scrollHeight-log.scrollTop-log.clientHeight<60; CMD.logHtml=a; log.innerHTML=a; if(fim) log.scrollTop=log.scrollHeight; cmdSpeakNew(log); }
  if(CMD.sideHtml!==b){ const i=$id('cmdInst'), keep=i?{ v:i.value, f:document.activeElement===i, a:i.selectionStart }:null, sc=side.scrollTop;
    CMD.sideHtml=b; side.innerHTML=b; side.scrollTop=sc;
    const n=$id('cmdInst'); if(n && keep){ n.value=keep.v; if(keep.f){ try{ n.focus({ preventScroll:true }); n.setSelectionRange(keep.a, keep.a); }catch(_){ } } } }
  const st=$id('cmdStop'), sd=$id('cmdSend'); if(st) st.style.display=CMD.busy?'':'none'; if(sd) sd.disabled=CMD.busy;
  // a pergunta aberta da tarefa selecionada: a MESMA folha do terminal, encaixada no painel
  const slot=side.querySelector('[data-tlinline]'); if(slot && typeof tlAskPaint==='function'){ const t=cmdTask(slot.dataset.tlinline); if(t) try{ tlAskPaint(t); }catch(e){ console.warn('comando ask', e); } }
}
function cmdOpen(){ cmdMount(); CMD.logHtml=''; CMD.sideHtml=''; cmdPaint(true); if(typeof ovShow==='function') ovShow('comandoOverlay'); if(CMD.sel) cmdHistLoad(CMD.sel); setTimeout(()=>{ const q=$id('cmdQ'); if(q) q.focus(); }, 60); }
function cmdAtiva(){ const t=(typeof tabById==='function')?tabById(activeTab):null; return !!(t && t.kind==='comando'); }

// ---------- registro: aba, lateral, atalho ⌘J, repintura a cada refresh ----------
if(typeof VIEW_META!=='undefined'){ VIEW_META.comando={ title:'Comando', icon:(typeof SEM_IC!=='undefined'&&SEM_IC.spark)||'' }; VIEW_OVERLAY.comando='comandoOverlay'; }
if(typeof viewOpen==='function' && !viewOpen.__cmd){ const vo=viewOpen; viewOpen=function(kind){ if(kind==='comando') return cmdOpen(); return vo.apply(this, arguments); }; viewOpen.__cmd=true; }
if(typeof SEM_NAV!=='undefined') SEM_NAV.comando='comandoBtn';
bindClick('comandoBtn', ()=>openTab('comando'));
if(typeof render==='function' && !render.__cmd){ const r0=render; render=function(){ const out=r0.apply(this, arguments); try{ if(cmdAtiva()){ if(CMD.sel) cmdHistLoad(CMD.sel); cmdPaint(); } else if(CMDV.on) cmdVoiceToggle(); }catch(e){ console.warn('comando render', e); } return out; }; render.__cmd=true; }
document.addEventListener('keydown', e=>{ if((e.metaKey||e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase()==='j'){ e.preventDefault(); openTab('comando'); } });
window.cmdOpen=cmdOpen;
