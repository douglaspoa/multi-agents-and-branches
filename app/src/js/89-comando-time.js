// COMANDO · TIME, ENTREGAS E USO NO CHAT (17/11): quem está com o quê, o que foi entregue, quanto gastou,
// passar/assumir/devolver cartão — sem abrir Semana, Entregas nem Uso. Mesmas fontes das telas (semItens, usage_report, cloudAssign).
const CMD_TIME=new Set(['time','entregas','uso','passar_cartao','devolver_cartao']);
/** Período dito → { from, to, label, uso }. Puro. uso = o nome que o relatório de uso entende. */
function cmdPeriodo(txt, now){
  const s=String(txt||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(), d=new Date(now); d.setHours(0,0,0,0); const d0=d.getTime(), DIA=86400000;
  if(/ontem/.test(s)) return { from:d0-DIA, to:d0, label:'ontem', uso:'7d' };
  if(/hoje|agora/.test(s)) return { from:d0, to:d0+DIA, label:'hoje', uso:'hoje' };
  if(/\bmes\b|30 dias/.test(s)){ const m=new Date(d0); m.setDate(1); return { from:m.getTime(), to:d0+DIA, label:'este mês', uso:'mes' }; }
  if(/semana passada/.test(s)){ const seg=d0-((d.getDay()+6)%7)*DIA; return { from:seg-7*DIA, to:seg, label:'semana passada', uso:'30d' }; }
  const seg=d0-((d.getDay()+6)%7)*DIA; return { from:seg, to:d0+DIA, label:'esta semana', uso:'7d' };
}
/** Quem está com o quê. Puro. itens:[{ who, titulo, code, done, trav, esp, bucket }], nomeDe(id) → nome. → [{ who, nome, abertas, trav, esp, itens:[…] }] */
function cmdTimeResumo(itens, nomeDe, so){
  const m=new Map(); (itens||[]).filter(x=>!x.done && x.bucket!=='fila').forEach(x=>{ const k=x.who||''; if(!m.has(k)) m.set(k, []); m.get(k).push(x); });
  let out=[...m].map(([who, L])=>({ who, nome:who?nomeDe(who):'Sem dono', abertas:L.length, trav:L.filter(x=>x.trav).length, esp:L.filter(x=>x.esp).length,
    itens:L.sort((a,b)=>(b.trav?2:b.esp?1:0)-(a.trav?2:a.esp?1:0)).slice(0,5).map(x=>({ code:x.code||'', titulo:x.titulo||'', sit:x.trav?'travada':x.esp?'esperando':'andando', motivo:x.motivo||'' })) }));
  if(so){ const q=String(so).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(); out=out.filter(p=>p.nome.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().includes(q)); }
  return out.sort((a,b)=>b.trav-a.trav || b.abertas-a.abertas);
}
/** Cartão do time pelo código ou por parte do título. Puro. → item | null | { varios:[…] } */
function cmdCartaoDe(itens, alvo){
  const q=String(alvo||'').trim().toLowerCase(); if(!q) return null; const L=(itens||[]).filter(x=>x.card && !x.done), num=(q.match(/\d+/)||[])[0];
  const ex=L.filter(x=>String(x.code||'').toLowerCase()===q.replace(/\s+/g,'-')); if(ex.length===1) return ex[0];
  if(num){ const c=L.filter(x=>String(x.code||'').replace(/\D/g,'')===num); if(c.length===1) return c[0]; }
  const c=L.filter(x=>q.length>=4 && String(x.titulo||'').toLowerCase().includes(q)); return c.length===1?c[0]:c.length>1?{ varios:c.slice(0,5) }:null;
}

function cmdTimeHtml(m){
  const cab=`<div class="cmdciclo-h"><b>${esc(m.titulo||'')}</b>${m.sub?` <span class="cmdhint">${esc(m.sub)}</span>`:''}</div>`;
  const grupos=(m.grupos||[]).map(g=>`<div class="cmdtime-g"><div class="cmdtime-n"><b>${esc(g.nome)}</b> <span class="cmdhint">${esc(g.nota||'')}</span></div><ul class="cmdciclo-l">${(g.itens||[]).map(i=>`<li class="${i.sit==='travada'?'bad':''}">${i.code?`<span class="mono">${esc(i.code)}</span> `:''}${esc(String(i.titulo||'').slice(0,90))}${i.nota?` <span class="cmdhint">${esc(i.nota)}</span>`:''}</li>`).join('')}</ul></div>`).join('');
  return `<div class="cmdciclo">${cab}${m.tx?`<p>${esc(m.tx)}</p>`:''}${grupos}${m.busy?`<div class="cmdhint"><span class="pltyping"><i></i><i></i><i></i></span> ${esc(m.busy)}</div>`:''}</div>`;
}
async function cmdTimeDo(p, say){
  const temTime=()=>{ try{ return !!(SB.sess() && cloudTeamId()); }catch(_){ return false; } };
  const nome=id=>{ try{ return personName(id,{ noYou:false }); }catch(_){ return String(id||''); } };
  const ms=cmdMsgs();
  try{
    if(p.acao==='time'){ if(typeof semBuscaTime==='function'){ try{ await semBuscaTime(false); }catch(_){ } } const R=cmdTimeResumo(semItens(), nome, p.alvo||'');
      ms.push({ r:'bot', k:'time', titulo:p.alvo?'Com '+p.alvo:'O time agora', sub:temTime()?'':'só as desta máquina — sem time conectado', tx:R.length?'':'Ninguém com demanda aberta agora.',
        grupos:R.map(g=>({ nome:g.nome, nota:nPl(g.abertas,'aberta','abertas')+(g.trav?' · '+nPl(g.trav,'travada','travadas'):'')+(g.esp?' · '+g.esp+' esperando':''), itens:g.itens.map(i=>({ code:i.code, titulo:i.titulo, sit:i.sit, nota:i.sit==='andando'?'':(i.motivo||i.sit) })) })) }); return cmdPaint(true); }
    if(p.acao==='entregas'){ if(typeof semBuscaTime==='function'){ try{ await semBuscaTime(false); }catch(_){ } } const pe=cmdPeriodo((p.texto||'')+' '+(p.alvo||''), Date.now());
      const E=semItens().filter(x=>x.done).map(x=>({ x, ts:semEntregueEm(x) })).filter(o=>o.ts>=pe.from && o.ts<pe.to).sort((a,b)=>b.ts-a.ts);
      const por=new Map(); E.forEach(o=>{ const k=o.x.who||''; if(!por.has(k)) por.set(k, []); por.get(k).push(o); });
      ms.push({ r:'bot', k:'time', titulo:'Entregas — '+pe.label, sub:nPl(E.length,'entrega','entregas'), tx:E.length?'':'Nada entregue nesse período.',
        grupos:[...por].map(([w, L])=>({ nome:w?nome(w):'Sem dono', nota:String(L.length), itens:L.slice(0,8).map(o=>({ code:o.x.code||'', titulo:o.x.titulo||'', nota:new Date(o.ts).toLocaleDateString('pt-BR',{ weekday:'short', day:'numeric' }) })) })) }); return cmdPaint(true); }
    if(p.acao==='uso'){ const pe=cmdPeriodo((p.texto||'')+' '+(p.alvo||''), Date.now()), m={ r:'bot', k:'time', titulo:'Uso — '+(pe.uso==='hoje'?'hoje':pe.uso==='mes'?'este mês':pe.uso==='30d'?'últimos 30 dias':'últimos 7 dias'), busy:'somando o gasto…' }; ms.push(m); cmdPaint(true);
      const d=await (typeof invokeQuiet==='function'?invokeQuiet:invoke)('usage_report',{ period:pe.uso, project:null, since:usoSinceFor(pe.uso, Date.now()), engine:null }); const t=(d&&d.totals)||{}, f=v=>usoFmt(+v||0, true);
      m.busy=''; m.tx=(+t.usd||0)>0?'Total: '+f(t.usd)+((+t.usdEstimated||0)>0?' (parte estimada)':'')+'.':'Sem gasto registrado nesse período.';
      m.grupos=[{ nome:'Por IA', nota:'', itens:((d&&d.byEngine)||[]).slice(0,5).map(x=>({ titulo:usoEngineLabel(x.engine), nota:f(x.usd) })) }, { nome:'Tarefas que mais gastaram', nota:'', itens:((d&&d.tasks)||[]).slice().sort((a,b)=>(+((b.totals||b).usd)||0)-(+((a.totals||a).usd)||0)).slice(0,5).map(x=>({ titulo:x.title||x.taskId||'', nota:f((x.totals||x).usd) })) }].filter(g=>g.itens.length);
      return cmdPaint(true); }
    if(!temTime()) return say('Isso é do quadro do time — entre numa conta com time pra eu fazer daqui.');
    if(typeof semBuscaTime==='function'){ try{ await semBuscaTime(false); }catch(_){ } }
    const x=cmdCartaoDe(semItens(), p.alvo||(p.tarefas||[])[0]); if(!x) return say('Não achei esse cartão no quadro do time. Me diga o código.'); if(x.varios) return say('Qual deles? '+x.varios.map(v=>(v.code||'')+' '+String(v.titulo).slice(0,40)).join(' · '));
    if(p.acao==='devolver_cartao'){ const why=String(p.texto||'').trim(); if(!semMotivoOk(why)) return say('Pra devolver preciso do motivo, com pelo menos três palavras — quem pegar depois lê.');
      await cloudAssign(x.card.id, null); x.card.assignee=null; sbPost('task_activity',{ task_id:x.card.id, user_id:semMe(), kind:'comment', body:'Devolveu: '+why.slice(0,300) }).catch(()=>{}); semDepoisDeMudar();
      return say(`Devolvi “${String(x.titulo).slice(0,60)}” ao time, com o motivo. Ficou em Sem dono.`); }
    if(p.acao==='passar_cartao'){ const O=(typeof tmAssignOptsNow==='function'?tmAssignOptsNow(x.card.team_id):[]).filter(o=>o.id).map(o=>({ id:o.id, name:o.label })), w=cmdPessoaDe(O, p.texto||'eu', semMe());
      if(!w) return say('Não achei “'+(p.texto||'')+'” no time: '+O.map(o=>o.name).join(', ')+'.'); if(w.varios) return say('Qual delas? '+w.varios.map(v=>v.name).join(', ')+'.');
      if((x.card.assignee||'')===w.id) return say(`“${String(x.titulo).slice(0,60)}” já está com ${w.id===semMe()?'você':w.name}.`);
      const antes=x.card.assignee; await semPassar(x, w.id, 'comando'); if((x.card.assignee||'')!==w.id) return say('Não passei o cartão — veja o aviso do app.');
      return say(w.id===semMe()?`Você assumiu “${String(x.titulo).slice(0,60)}”. Nada roda até iniciar — diga "começa ela" quando quiser.`:`Passei “${String(x.titulo).slice(0,60)}” pra ${w.name}${antes?' (estava com '+nome(antes)+')':''}. A pessoa recebe o aviso.`); }
  }catch(e){ const u=ms[ms.length-1]; if(u && u.k==='time' && u.busy){ u.busy=''; u.tx='Não consegui ler: '+String((e&&e.message)||e).slice(0,200); cmdPaint(true); } else say('Não deu certo: '+String((e&&e.message)||e).slice(0,200)); }
}
