// COMANDO · ISSUES NO CHAT (17/11): ver, mover, atribuir, comentar, criar e mandar pro time sem abrir o painel.
// Usa as MESMAS funções do painel (trkMove, trkAssign, trkCreateIssue, trkCall, cloudShareTask).
const CMD_ISSUES=new Set(['issue','mover_issue','atribuir_issue','comentar_issue','criar_issue','mandar_time']);
const CMD_ST_SIN={ todo:['a fazer','afazer','backlog','pendente','aberta','todo','para fazer','fila'], doing:['em andamento','andamento','fazendo','em progresso','progresso','doing','em desenvolvimento','desenvolvimento'],
  review:['em revisao','revisao','review','em review','code review'], done:['feito','feita','pronta','pronto','concluida','concluido','done','fechada','entregue','finalizada'], blocked:['bloqueada','bloqueado','travada','impedida','blocked'] };
const cmdIsN=x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9@. ]+/g,' ').replace(/\s+/g,' ').trim();
/** Status do painel a partir do que a pessoa disse. Puro. statuses:[{ id, label, kind }] → status | null */
function cmdStatusDe(statuses, txt){
  const L=statuses||[], q=cmdIsN(txt).replace(/^(pra|para|como|em|no|na)\s+/,''); if(!q) return null;
  const nome=L.find(s=>cmdIsN(s.label)===q || cmdIsN(s.id)===q) || L.find(s=>q.length>=3 && (cmdIsN(s.label).includes(q) || q.includes(cmdIsN(s.label)))); if(nome) return nome;
  const kind=Object.keys(CMD_ST_SIN).find(k=>CMD_ST_SIN[k].some(w=>q===w || q.includes(w))); if(!kind) return null;
  const rev=s=>/review|revis/.test(cmdIsN(s.label)+' '+cmdIsN(s.id));
  if(kind==='review') return L.find(s=>s.kind==='review') || L.find(rev) || null;
  return L.find(s=>s.kind===kind && !rev(s)) || L.find(s=>s.kind===kind) || null;
}
/** Pessoa a partir do que foi dito ("eu", nome, parte do e-mail). Puro. pessoas:[{ id, name }], eu = id de quem está logado → { id, name } | null | { varios:[…] } */
function cmdPessoaDe(pessoas, txt, eu){
  const q=cmdIsN(txt).replace(/^(pra|para|pro|com|a|o)\s+/,''); if(!q) return null; const L=pessoas||[];
  if(/^(eu|mim|me|minha|meu|comigo)$/.test(q)) return eu?(L.find(p=>p.id===eu)||{ id:eu, name:'você' }):null;
  const ex=L.filter(p=>cmdIsN(p.name)===q || cmdIsN(p.id)===q); if(ex.length===1) return ex[0];
  const pa=L.filter(p=>cmdIsN(p.name).split(' ').includes(q) || cmdIsN(p.name).includes(q) || cmdIsN(p.id).split('@')[0].includes(q)); if(pa.length===1) return pa[0];
  return pa.length>1?{ varios:pa.slice(0,5) }:null;
}
/** Descrição de uma issue nova com os requisitos no formato que o painel lê de volta. Puro. */
function cmdIssueDesc(texto, requisitos){ const r=(requisitos||[]).map(x=>String(x||'').trim()).filter(Boolean); return String(texto||'').trim()+(r.length?'\n\nRequisitos:\n'+r.map(x=>'- '+x).join('\n'):''); }

function cmdIssueAcha(alvo){ const q=String(alvo||'').trim(); if(!q) return null; let i=cmdIssue(q.toUpperCase().replace(/\s+/g,'-')); if(i) return i;
  const L=(typeof trkIssues!=='undefined'&&trkIssues)||[], num=(q.match(/\d+/)||[])[0];
  if(num){ const c=L.filter(x=>String(x.code).replace(/\D/g,'')===num); if(c.length===1) return c[0]; }
  const R=cmdBusca(q, L.map(x=>({ tipo:'issue', code:x.code, title:x.title||'', text:String(x.description||'').slice(0,1200) })), 5), d=cmdBuscaDecide(R); if(!d) return null;
  if(d.um) return cmdIssue(d.um.code); return { varios:d.varios.map(v=>cmdIssue(v.code)).filter(Boolean) }; }

/** Executa UMA ação de issue. p: passo do plano; say: fala curta. */
async function cmdIssuesDo(p, say){
  if(!cmdTrkOn()){ say('O painel de issues ainda não está conectado neste projeto. Conecte em Issues uma vez e eu passo a fazer tudo daqui.'); return; }
  await cmdIssuesEnsure(); const sts=((typeof trk!=='undefined'&&trk.connector)||{}).statuses||[];
  const erro=e=>(typeof trkErrText==='function'?trkErrText(e):String((e&&e.message)||e)).slice(0,220);
  try{
    if(p.acao==='criar_issue'){ const tit=String(p.titulo||'').trim()||cmdUma(String(p.texto||'').split(/[.\n]/)[0]).slice(0,90); if(tit.length<4) return say('Diga em uma frase o que a issue deve pedir.');
      let extra; if(p.alvo){ const eu=trkCtx().email, w=cmdPessoaDe(trkPeopleList(), p.alvo, eu); if(w && !w.varios) extra={ assignee:w.id }; }
      const i=await trkCreateIssue(tit, cmdIssueDesc(p.texto, p.requisitos), '', extra); try{ if(typeof issRender==='function') issRender(); }catch(_){ }
      cmdMsgs().push({ r:'bot', k:'issok', code:i.code||'', titulo:tit, url:i.url||'', tx:'Issue criada'+(extra?' e atribuída':'')+'.' }); return cmdPaint(true); }
    const i=cmdIssueAcha(p.alvo||(p.tarefas||[])[0]); if(!i) return say('Procurei “'+(p.alvo||(p.tarefas||[])[0]||'')+'” no título e na descrição das '+((typeof trkIssues!=='undefined'&&trkIssues)||[]).length+' issues do painel e nada combinou. Me dê outra pista (uma palavra do título, o número, quem está com ela).');
    if(i.varios){ cmdMsgs().push({ r:'bot', k:'issqual', acao:p.acao, texto:p.texto||'', itens:i.varios.map(x=>({ code:x.code, title:x.title||'' })) }); return cmdPaint(true); }
    if(p.acao==='issue'){ cmdMsgs().push({ r:'bot', k:'issdet', code:i.code }); return cmdPaint(true); }
    if(p.acao==='mover_issue'){ const s=cmdStatusDe(sts, p.texto); if(!s) return say('Não achei o status “'+(p.texto||'')+'”. Os do painel são: '+sts.map(x=>x.label||x.id).join(', ')+'.');
      if(i.status===s.id) return say(`A ${i.code} já está em ${s.label||s.id}.`); await trkMove(i.code, s.id);
      if(i.status!==s.id) return say(`Não consegui mover a ${i.code}: ${(typeof trkErr!=='undefined'&&trkErr)||'o painel recusou'}.`); return say(`Movi a ${i.code} pra ${s.label||s.id}.`); }
    if(p.acao==='atribuir_issue'){ const eu=trkCtx().email, w=cmdPessoaDe(trkPeopleList(), p.texto, eu);
      if(!w) return say('Não achei “'+(p.texto||'')+'” entre as pessoas do painel: '+trkPeopleList().map(x=>x.name).slice(0,12).join(', ')+'.');
      if(w.varios) return say('Tem mais de uma pessoa com esse nome: '+w.varios.map(x=>x.name).join(', ')+'. Qual delas?');
      const antes=i.assignee; await trkAssign(i.code, w.id); if(typeof trkErr!=='undefined' && /^Não troquei/.test(trkErr||'')) return say(trkErr+'.'); return say(`A ${i.code} agora está com ${w.name}${antes&&antes!==i.assignee?' (antes: '+trkPretty(antes)+')':''}.`); }
    if(p.acao==='comentar_issue'){ const t=String(p.texto||'').trim(); if(!t) return say('Diga o texto do comentário.'); if(!trkOp('addComment')) return say('O conector deste painel não tem a operação de comentar.');
      const vars=trkCommentVars(trkOp('addComment'), t, ((trk.connector||{}).vars||[]).map(v=>v.name)); await trkCall('addComment', Object.assign({ code:i.code, id:i.id }, vars)); return say(`Comentei na ${i.code}.`); }
    if(p.acao==='mandar_time'){ if(typeof SB==='undefined' || !SB.sess() || !cloudTeamId()) return say('Pra mandar pro time você precisa estar numa conta com time.');
      const sp=trkIssueSpec(i), d=aiDefaults(), cr=ndKindCreate(sp.bug?'fix':'build'), pol=(typeof ntPolicy!=='undefined'&&ntPolicy)||{};
      let who=null, nome=''; if(p.texto){ const O=(typeof tmAssignOptsNow==='function'?tmAssignOptsNow():[]).filter(o=>o.id).map(o=>({ id:o.id, name:o.label })), w=cmdPessoaDe(O, p.texto, cloudUserId());
        if(!w) return say('Não achei “'+p.texto+'” no time: '+O.map(o=>o.name).join(', ')+'.'); if(w.varios) return say('Qual delas? '+w.varios.map(x=>x.name).join(', ')+'.'); who=w.id; nome=w.name; }
      const payload={ start:false, title:String(sp.title||i.code).slice(0,90), workflow:null, agents:null, engine:defaultAiEngine(), model:d.model||null, advisor:d.advisor, approval:'auto', owns:cr.owns||null, off:null, objective:sp.objective||sp.title,
        deliverables:sp.goal?[sp.goal]:[], requirements:[...new Set(sp.reqs)], doc:cr.doc||null, proof:true, tests:!!pol.testsRequired, autoPr:cr.autoPr, prBase:null, planApproval:'auto', refs:[], branchType:cr.branchType, issue:i.code, issueUrl:i.url||undefined };
      await cloudShareTask(payload, { assignee:who, epicId:null }); return say(`Mandei a ${i.code} pro quadro do time${nome?', com '+nome+' como responsável':', livre pra quem assumir'}.`); }
  }catch(e){ say('Não deu certo: '+erro(e)); }
}
function cmdIssDetHtml(m){ const i=cmdIssue(m.code); if(!i) return `<p>Não achei mais a <b>${esc(m.code)}</b> no painel.</p>`;
  const sts=((typeof trk!=='undefined'&&trk.connector)||{}).statuses||[], s=sts.find(x=>x.id===i.status), t=cmdIssueTask(i.code), sp=trkIssueSpec(i), who=i.assignee?trkPretty(i.assignee):'sem responsável';
  const desc=String(sp.objective||'').trim().slice(0,700);
  return `<div class="cmdciclo"><div class="cmdciclo-h"><b>${esc(i.title||i.code)}</b> <span class="mono cmdhint">${esc(i.code)}</span></div><p>${esc((s&&(s.label||s.id))||i.status||'—')} · ${esc(who)}${t?' · já é tarefa aberta':' · ainda não virou tarefa'}</p>${desc?`<p class="cmdhint" style="white-space:pre-wrap">${esc(desc)}</p>`:''}${(sp.reqs||[]).length?`<ul class="cmdciclo-l">${sp.reqs.slice(0,10).map(r=>`<li>· ${esc(r)}</li>`).join('')}</ul>`:''}
    <div class="cmdacts">${t?`<button type="button" class="btn sm primary" data-cmdchip="${escA('como está a '+i.code+'?')}">Ver a tarefa</button>`:`<button type="button" class="btn sm primary" data-cmdchip="${escA('começa a '+i.code)}">Começar agora</button>`}<button type="button" class="btn sm quiet" data-cmdpre="${escA('move a '+i.code+' pra ')}">Mover…</button><button type="button" class="btn sm quiet" data-cmdpre="${escA('atribui a '+i.code+' pra ')}">Atribuir…</button><button type="button" class="btn sm quiet" data-cmdpre="${escA('comenta na '+i.code+': ')}">Comentar…</button>${i.url?`<button type="button" class="btn sm quiet" data-cmdlk="${escA(i.url)}">Abrir no painel ↗</button>`:''}</div></div>`; }
function cmdIssQualHtml(m){ const frase=c=>({ issue:'o que diz a '+c+'?', mover_issue:'move a '+c+' pra '+(m.texto||''), atribuir_issue:'atribui a '+c+' pra '+(m.texto||''), comentar_issue:'comenta na '+c+': '+(m.texto||''), mandar_time:'manda a '+c+' pro time'+(m.texto?' com '+m.texto:'') })[m.acao]||('o que diz a '+c+'?');
  return `<div class="cmdciclo"><div class="cmdciclo-h"><b>Qual destas?</b></div><div class="cmdisss">${(m.itens||[]).map(i=>`<button type="button" class="btn sm quiet" style="justify-content:flex-start;text-align:left" data-cmdchip="${escA(frase(i.code))}"><span class="mono">${esc(i.code)}</span>&nbsp; ${esc(String(i.title).slice(0,80))}</button>`).join('')}</div></div>`; }
function cmdIssOkHtml(m){ return `<div class="cmdciclo"><div class="cmdciclo-h"><b>${esc(m.titulo||'')}</b>${m.code?` <span class="mono cmdhint">${esc(m.code)}</span>`:''}</div><p>${esc(m.tx||'')}</p><div class="cmdacts">${m.code?`<button type="button" class="btn sm primary" data-cmdchip="${escA('começa a '+m.code)}">Começar agora</button><button type="button" class="btn sm quiet" data-cmdpre="${escA('manda a '+m.code+' pro time com ')}">Mandar pro time…</button>`:''}${m.url?`<button type="button" class="btn sm quiet" data-cmdlk="${escA(m.url)}">Abrir no painel ↗</button>`:''}</div></div>`; }

/** Issue sem os requisitos que o time exige: a IA tira os critérios da descrição e o cartão de confirmação mostra a tarefa inteira. */
async function cmdIssueCompleta(i, min){
  const sp=trkIssueSpec(i), ms=cmdMsgs(), aviso={ r:'bot', k:'txt', text:`A ${i.code} tem ${(sp.reqs||[]).length} de ${min} requisitos que o time exige. Estou tirando os critérios da descrição…` }; ms.push(aviso); cmdPaint(true);
  let reqs=[...new Set(sp.reqs||[])];
  try{ const raw=await invoke('comando_plan',{ system:'Você escreve critérios de pronto verificáveis para tarefas de software. Responda SOMENTE com JSON.',
      prompt:`ISSUE ${i.code}: ${sp.title||i.title||''}\n\nDESCRIÇÃO:\n${String(sp.objective||i.description||'').slice(0,6000)}\n\nREQUISITOS QUE JÁ EXISTEM:\n${reqs.map(r=>'- '+r).join('\n')||'(nenhum)'}\n\nEscreva de ${Math.max(3,min)} a 8 critérios VERIFICÁVEIS de pronto (comportamento observável), mantendo os que já existem e sem inventar escopo que a descrição não pede.\nResponda: {"requisitos":["...","..."]}` });
    const t=String(raw||''), a=t.indexOf('{'), b=t.lastIndexOf('}'); const o=a>=0&&b>a?JSON.parse(t.slice(a,b+1)):null; const R=((o&&o.requisitos)||[]).map(x=>String(x||'').replace(/\s+/g,' ').trim()).filter(x=>x.length>3).slice(0,12); if(R.length) reqs=R;
  }catch(_){ }
  if(reqs.length<min){ aviso.text=`A ${i.code} tem menos requisitos do que o time exige (${min}) e não consegui tirar da descrição. Me diga como conferir que ficou pronto e eu crio.`; return cmdPaint(true); }
  aviso.text=`A ${i.code} não tinha os ${min} requisitos que o time exige — tirei estes da descrição. Confira antes de começar.`;
  ms.push({ r:'bot', k:'plano', plan:{ fala:'', duvida:'', pedido:'começar '+i.code, refs:[], passos:[{ acao:'criar_demanda', tarefas:[], alvos:[], faltam:[], alvo:'', titulo:String(sp.title||i.code).slice(0,90), texto:String(sp.objective||sp.title||'').trim(), requisitos:reqs, issue:i.code, issueUrl:i.url||'', bug:!!sp.bug, entrega:sp.goal||'' }] } }); cmdPaint(true);
}
