// Starfork — 70-time-entregas: aba ENTREGAS do espaço Time (visão do gestor · decisão T7/T8/T9 da mesa 09/10)
// UMA lista agrupada por épico (ativos primeiro, "Sem épico" no fim) — sem gráfico nem KPI novo. Por épico: x de y
// entregues (regra única epDelivered), prontas pra revisar, travadas, pessoas e o "pronto quando" provado (linhaModelo
// do 69). Por item: título, com quem (ou "Sem dono"), situação (STATUS_META via stLabel/ctStLabel), entregáveis
// (pronto pra revisar ↗, issue, provas publicadas, requisitos "3 de 5"), última atividade e o motivo da trava.
// Custo (T8): só líder do time ou owner/admin da org vê — e só somado por épico. Membro não vê custo nesta aba.
// Dados: teamTasks/teamEpics/teamActivity/teamProfiles (teamFetch) — sem laço novo. As provas (artifacts_meta) vêm
// em LOTE quando a aba abre e ficam em cache pelo conjunto de tarefas (sem polling).

// @puro-entregas-inicio (testado em app/tests/time-entregas.test.mjs)
// fn = { bucket(t) → etapa da Central (flowBucket), delivered(t) → epDelivered, ativo(ep, tasks) → epAtivo,
//        flag(t) → flag efetivo (tsNorm: o da tarefa local vence, como no Quadro) }
function entFlag(t, fn){ return fn.flag?fn.flag(t):(t&&t.flag); }
// travada = etapa "aguardando" (erro, conflito, pergunta, plano pra aprovar), cartão bloqueado ou PR aberto que não anda
// (checagem do GitHub falhou / conflito com a base — fn.prTrava, quando a tela sabe; entregue nunca é travada)
function entTravada(t, fn){ return !!t && (entFlag(t, fn)==='blocked' || fn.bucket(t)==='aguardando' || (!!fn.prTrava && !fn.delivered(t) && !entFora(t, fn) && !!fn.prTrava(t))); }
// pronta pra revisar = ainda não entregue e na etapa "prontas" ou "PR aberto" da Central
function entPronta(t, fn){ return !!t && !fn.delivered(t) && !entTravada(t, fn) && ['prontas','praberto'].includes(fn.bucket(t)); }
// cancelada/encerrada sem entrega: fora da conta de "x de y"
function entFora(t, fn){ return !!t && !fn.delivered(t) && (t.status==='cancelled' || entFlag(t, fn)==='closed'); }
// requisitos provados: a MESMA leitura do tsCardHtml (requirements_proof.list ou a própria lista; status 'done')
function entReqs(t){
  const rp=t&&t.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  if(!list||!list.length) return null;
  return { ok:list.filter(x=>x&&x.status==='done').length, tot:list.length };
}
// MOTIVO DA TRAVA numa frase curta — A fonte única (mesa 09/10, D6.2): Central (tarefas e épicos), quadro do Time, aba
// Entregas e a página do cartão do colega mostram ESTE texto (via entTravaTx). Sem `c` (contexto) é a regra antiga:
// a 1ª frase da última nota ou o rótulo da situação. c = entTravaCtx(t) = { st (status efetivo: tsSt), flag,
// pergunta (1ª pergunta aberta), needsYou {kind,text}, loop {what,text}, pr (entPrTrava), intent (falha do celular) }
const ENT_NY={ teto:'teto de custo atingido', rodadas:'revisão pediu a 3ª rodada', veredito:'revisão sem veredito legível', plano:'plano pra aprovar' };
function entCurto(s, max){ s=String(s||'').replace(/\s+/g,' ').trim(); max=max||90; return s.length>max?s.slice(0,max-1).trimEnd()+'…':s; }
function entNota(t){ const n=String((t&&t.last_note)||'').replace(/\s+/g,' ').trim(); return n?entCurto((n.match(/^.*?[.!?](\s|$)/)||[n])[0].trim()):''; }
// PR que não anda: o que o GitHub diz (pr_status local ou o resumo que a máquina de quem fez publica no cartão)
function entPrTrava(pr){
  if(!pr || typeof pr!=='object') return null;
  const st=String(pr.state||'').toUpperCase(); if(st==='MERGED' || st==='CLOSED') return null;
  if(pr.at && Date.now()-Date.parse(pr.at)>86400000) return null; // retrato de mais de 1 dia (quem fez ficou offline): não afirma trava
  const conflito=pr.mergeable==='CONFLICTING';
  const nomes=(Array.isArray(pr.failing)?pr.failing:Array.isArray(pr.failingChecks)?pr.failingChecks:[]).map(String).filter(Boolean);
  const n=+pr.checksFail||nomes.length||0;
  return (conflito || n) ? { conflito, n, nomes:nomes.slice(0,3) } : null;
}
function entMotivo(t, label, c){
  const nota=entNota(t);
  if(!c) return nota||label||'';
  const st=String(c.st||'');
  if(c.pergunta) return entCurto('pergunta pendente: '+c.pergunta);
  if(st==='plan-review') return 'plano pra aprovar';
  if(c.flag==='blocked' || st==='blocked') return nota?entCurto('bloqueada: '+nota):'bloqueada'; // bloqueio manual vence o resto
  if(c.loop) return entCurto('repetindo o mesmo erro'+((c.loop.what||c.loop.text)?': '+(c.loop.what||c.loop.text):''));
  if(st==='needs-you') return entCurto((c.needsYou&&(ENT_NY[c.needsYou.kind]||c.needsYou.text))||'precisa de uma decisão');
  if(st==='conflict' || (c.pr&&c.pr.conflito)) return 'conflito com a base';
  if(c.pr && c.pr.n) return entCurto('checagem do PR falhou'+(c.pr.nomes.length?': '+c.pr.nomes.join(', '):''));
  if(c.intent) return entCurto(c.intent);
  if(st==='error') return nota?entCurto('erro: '+nota):'parou com erro';
  if(st==='aborted') return nota?entCurto('interrompida: '+nota):'interrompida';
  return nota||label||'';
}
// ordem dentro do grupo: o que pede o gestor primeiro (travada, pronta), depois andando, fila e entregues; recente antes
function entPeso(t, fn){
  if(entTravada(t, fn)) return 0;
  if(entPronta(t, fn)) return 1;
  if(fn.delivered(t)) return 4;
  if(entFora(t, fn)) return 5;
  return ['fila','rascunho'].includes(fn.bucket(t))?3:2;
}
// filtros: pessoa = o RESPONSÁVEL (sem responsável só aparece em "sem dono")
// f = { who:'' | uid | '-' (sem dono), epic:'' | id | '-' (sem épico), trav:bool, pront:bool }
function entFiltra(tasks, f, fn){
  f=f||{};
  return (tasks||[]).filter(t=>{
    if(f.who==='-'){ if(t.assignee) return false; }
    else if(f.who && t.assignee!==f.who) return false;
    if(f.epic==='-'){ if(t.epic_id) return false; }
    else if(f.epic && t.epic_id!==f.epic) return false;
    if(f.trav && f.pront) return entTravada(t, fn) || entPronta(t, fn);
    if(f.trav && !entTravada(t, fn)) return false;
    if(f.pront && !entPronta(t, fn)) return false;
    return true;
  });
}
// números do épico sobre TODAS as tarefas dele (a verdade do épico, não a fatia filtrada)
function entNums(tasks, fn){
  const ts=(tasks||[]).filter(t=>!entFora(t, fn));
  const pessoas=[...new Set(ts.map(t=>t.assignee).filter(Boolean))]; // só responsáveis
  return { ent:ts.filter(fn.delivered).length, tot:ts.length, prontas:ts.filter(t=>entPronta(t, fn)).length,
    travadas:ts.filter(t=>entTravada(t, fn)).length, pessoas, custo:(tasks||[]).reduce((s,t)=>s+(+t.cost_usd||0),0) };
}
// grupos: épicos ATIVOS primeiro (na ordem em que foram criados), depois os concluídos, "Sem épico" no fim.
// Só entra grupo com item visível (vis = a lista já filtrada); os números vêm de all.
function entAgrupa(all, vis, epics, fn){
  const out=[], seen=new Set();
  const byEp=id=>(all||[]).filter(t=>t.epic_id===id);
  const ord=(a,b)=>entPeso(a, fn)-entPeso(b, fn) || String(b.updated_at||'').localeCompare(String(a.updated_at||''));
  const eps=(epics||[]).map(e=>({ e, ts:byEp(e.id) })).map(x=>({ ...x, ativo:fn.ativo(x.e, x.ts) }));
  for(const x of [...eps.filter(y=>y.ativo), ...eps.filter(y=>!y.ativo)]){
    seen.add(x.e.id);
    const itens=(vis||[]).filter(t=>t.epic_id===x.e.id).sort(ord);
    if(itens.length) out.push({ ep:x.e, id:x.e.id, nome:x.e.name||'Épico', ativo:x.ativo, itens, tasks:x.ts, ...entNums(x.ts, fn) });
  }
  // sem épico (ou épico que não veio — arquivado/sem acesso): grupo do fim
  const solto=(vis||[]).filter(t=>!t.epic_id || !seen.has(t.epic_id)).sort(ord);
  if(solto.length) out.push({ ep:null, id:'-', nome:'Sem épico', ativo:true, itens:solto, tasks:[], ...entNums((all||[]).filter(t=>!t.epic_id || !seen.has(t.epic_id)), fn) });
  return out;
}
// pessoa salva no filtro que não está mais na lista → volta pra "todas" ('-' = sem dono continua valendo)
function entWhoValido(who, members){ return (!who || who==='-' || (members||[]).includes(who))?(who||''):''; }
// T8: custo só pra líder de um dos times em vista ou owner/admin da org. Owner/admin vale mesmo com os times ainda
// carregando; sem saber nada (sem usuário e sem papel) → não vê
function entVeCusto(me, teamIds, teamMembers, meRole){
  if(meRole==='owner' || meRole==='admin') return true;
  if(!me || !teamMembers) return false;
  return (teamIds||[]).some(tid=>((teamMembers||{})[tid]||[]).some(m=>m.user_id===me && m.role==='lead'));
}
// provas publicadas por tarefa (linhas de artifacts_meta) → { task_id: n }
function entProvasPorTarefa(rows){ const m={}; (rows||[]).forEach(r=>{ if(r&&r.task_id) m[r.task_id]=(m[r.task_id]||0)+1; }); return m; }
// filtros gravados (JSON) → forma segura
function entFiltrosDe(raw, fallback){
  let o=null; try{ o=raw?JSON.parse(raw):null; }catch(_){ o=null; }
  const b=(o&&typeof o==='object')?o:(fallback||{});
  return { who:String(b.who||''), epic:String(b.epic||''), trav:!!b.trav, pront:!!b.pront };
}
// @puro-entregas-fim

const ENT_FN={ bucket:t=>tsBucket(t), delivered:t=>epDelivered(t), flag:t=>tsNorm(t).flag,
  ativo:(e, ts)=>typeof epAtivo==='function'?epAtivo(e, ts):(e.status!=='done'&&e.status!=='archived'),
  prTrava:t=>!!entPrTrava(entPrOf(t)) || !!entIntentFalhou(t) };
// o pedido do celular (abrir PR / merge) falhou e o PR ainda não existe → o cartão parou ali (motivo = a mensagem)
function entIntentFalhou(t){
  const ir=((t&&t.spec)||{}).intentResult;
  if(!ir || ir.ok!==false || !ir.msg || !['openPr','merge'].includes(ir.kind)) return '';
  if(t.status==='cancelled' || (ir.at && Date.now()-Date.parse(ir.at)>86400000)) return ''; // cancelada / pedido de mais de 1 dia
  const lp=entLocal(t);
  if(ir.kind==='openPr' && (t.pr_url || (lp&&lp.prUrl))) return ''; // o PR saiu depois (pelo Mac): o pedido velho não trava
  if(ir.kind==='merge' && epDelivered(t)) return '';
  return (ir.kind==='merge'?'merge falhou: ':'não abriu o PR: ')+String(ir.msg);
}
// o PR do cartão: o da tarefa LOCAL (pr_status desta máquina) vence; senão o resumo que a máquina de quem fez publicou
// a tarefa desta máquina do cartão (local_id ou o mapa da conta — a MESMA busca da Central, caLocalOf)
function entLocal(t){ try{ return (typeof caLocalOf==='function'?caLocalOf(t):(typeof tsLocalOf==='function'?tsLocalOf(t):null))||null; }catch(_){ return null; } }
function entPrOf(t){
  const l=t?entLocal(t):null;
  if(!t || !(t.pr_url || (l&&l.prUrl))) return null;
  const pc=(l && typeof prCache!=='undefined' && prCache[l.id]) || null;
  return (pc && pc.exists) ? pc : (((t.spec||{}).prInfo)||null);
}
// contexto da trava (o que a tela sabe agora — nada de busca nova): status efetivo, pergunta aberta (só da tarefa desta
// máquina), decisão do ciclo, detector de loop, PR e o pedido do celular que falhou (abrir PR/merge)
function entTravaCtx(t){
  if(!t) return {};
  const l=entLocal(t), src=l||t, sp=src.spec||{};
  const pend=(l && typeof pendingOf==='function')?pendingOf(l.id):[];
  const intent=entIntentFalhou(t);
  return { st:typeof tsSt==='function'?tsSt(t):t.status, flag:ENT_FN.flag(t), pergunta:pend.length?String(pend[0].prompt||'responder o agente'):'',
    needsYou:sp.needsYou||null, loop:(l && typeof taskLoop==='function')?taskLoop(l):null, pr:entPrTrava(entPrOf(t)), intent };
}
// o texto que TODA tela mostra pra um cartão travado ('' quando não está travado)
function entTravaTx(t){ if(!entTravada(t, ENT_FN)) return ''; return entMotivo(t, stLabel(tsSt(t)), entTravaCtx(t)); }
function entFiltros(){ return entFiltrosDe(lsGet('tmEntF'), { who:lsGet('tmDev')||'', epic:lsGet('tmEpic')||'' }); }
// a mesma aba mora no Time e na Central (71): quem pintou por último redesenha (entOnChange)
let entOnChange=null;
function entSetF(patch){ lsSet('tmEntF', JSON.stringify({ ...entFiltros(), ...patch })); entRepaint(); }
function entRepaint(){ teamPaintSig=''; if(entOnChange) entOnChange(); else renderTeamBoard(); }
// A regra ÚNICA de custo dos outros (aba Entregas, Visão geral, Pessoas e cartão do Quadro — 43 tsCostOk)
function entPodeVerCusto(){
  const cd=(typeof cloudData!=='undefined'&&cloudData)||null;
  return entVeCusto(cloudUserId(), cd?((typeof tsScopeTeamIds==='function')?tsScopeTeamIds():[cloudTeamId()]):[],
    cd&&cd.teamMembers, cd&&cd.meRole);
}
// número da aba: o que ainda não foi entregue (nem cancelado)
function entAbertas(all){ return (all||[]).filter(t=>!ENT_FN.delivered(t) && !entFora(t, ENT_FN)).length; }

// ---- provas publicadas: UM lote por conjunto de tarefas, quando a aba está aberta ----
let entProvas={ key:'', m:null, busy:false };
// chave = tarefas + minuto do último teamFetch (o "atualizar"/refresh do time relê as contagens); erro → tenta de novo em 30 s
function entProvasLoad(ids){
  const key=Math.floor((+teamFetchedAt||0)/60000)+'|'+ids.slice().sort().join(',');
  if(entProvas.key===key && (entProvas.m || entProvas.busy || (entProvas.err && Date.now()-entProvas.errAt<30000))) return;
  entProvas={ key, m:null, busy:true };
  const chunks=[]; for(let i=0;i<ids.length;i+=80) chunks.push(ids.slice(i, i+80));
  Promise.all(chunks.map(c=>sbGet('artifacts_meta?select=task_id,name,kind&task_id=in.('+c.map(i=>'"'+i+'"').join(',')+')')))
    .then(rs=>{ if(entProvas.key!==key) return; const rows=[].concat(...rs);
      // img: a 1ª imagem de cada tarefa (o quadro do 72 mostra a miniatura quando a página do cartão já assinou a URL)
      const img={}; rows.forEach(r=>{ if(r && r.task_id && !img[r.task_id] && (r.kind==='image' || /\.(png|jpe?g|gif|webp)$/i.test(r.name||''))) img[r.task_id]=r.name; });
      entProvas={ key, m:entProvasPorTarefa(rows), img, busy:false }; if(entOnChange || tmView==='entregas') entRepaint(); if(typeof kbProvasDone==='function') kbProvasDone(); })
    .catch(e=>{ if(entProvas.key!==key) return; entProvas={ key, m:entProvas.m, busy:false, err:true, errAt:Date.now() }; console.warn('provas do time', e&&e.message||e);
      if(entOnChange || tmView==='entregas') entRepaint(); });
}

function entAvatares(uids){
  const max=5, v=uids.slice(0, max);
  return `<span class="en-avs" role="group" aria-label="${escA('pessoas: '+uids.map(tmName).join(', '))}">${v.map(u=>tsAv(u, false)).join('')}${uids.length>max?`<span class="en-avmore">+${uids.length-max}</span>`:''}</span>`;
}
function entProntoQuando(g){
  if(!g.ep || typeof linhaModelo!=='function') return '';
  const m=linhaModelo(g.ep, g.tasks||[]);
  if(!m.porDw) return '';
  const dw=((g.ep.spec||{}).doneWhen||[]).filter(Boolean);
  const tip=dw.map(d=>(d.checkedBy?'✓ ':'○ ')+(d.text||'')).join('\n');
  return `<span class="en-dw${m.ok===m.tot?' ok':''}" title="${escA('pronto quando\n'+tip)}">${icEm(IC.check)} pronto quando: ${esc(m.rotulo)}</span>`;
}
function entGrupoHtml(g, veCusto){
  const nomeBtn=g.ep?`<button type="button" class="en-gname" data-entep="${escA(g.id)}" title="abrir a página do épico">${esc(g.nome)}</button>`:`<span class="en-gname solto">${esc(g.nome)}</span>`;
  const bits=[`<span class="en-gn"><b>${g.ent}</b> de ${g.tot} entregues</span>`];
  if(g.prontas) bits.push(`<span class="en-gn" style="color:${stColor('review')}">${nPl(g.prontas,'pronta pra revisar','prontas pra revisar')}</span>`);
  if(g.travadas) bits.push(`<span class="en-gn en-trav">${nPl(g.travadas,'travada','travadas')}</span>`);
  const custo=veCusto&&g.custo>0?`<span class="en-gcost" title="custo somado das tarefas deste grupo — visível só pra líder do time e admin">${esc(fmtCost(g.custo,{usdOnly:true}))}</span>`:'';
  return `<section class="en-grp${g.ativo?'':' fechado'}" aria-label="${escA(g.nome)}">
    <header class="en-gh">${g.ep?`<span class="en-gic" style="color:${typeof epColor==='function'?epColor(g.id):'var(--purple)'}">${IC.epic}</span>`:''}${nomeBtn}${g.ativo?'':'<span class="en-gdone">concluído</span>'}
      <span class="en-gnums">${bits.join('<i aria-hidden="true">·</i>')}</span><span class="grow"></span>${entProntoQuando(g)}${custo}${entAvatares(g.pessoas)}</header>
    <div class="en-list" role="list">${g.itens.map(entItemHtml).join('')}</div></section>`;
}
function entItemHtml(t){
  const fn=ENT_FN, trav=entTravada(t, fn), done=fn.delivered(t), blk=entFlag(t, fn)==='blocked';
  const st=blk?'blocked':tsSt(t);
  const waiting=!trav && typeof ctWaiting==='function' && ctWaiting(t);
  const label=blk?stLabel('blocked'):(typeof ctStLabel==='function'?ctStLabel(t):stLabel(st));
  const cor=waiting?'var(--muted)':stColor(st);
  // com quem: o responsável; sem responsável, "Sem dono" e quem criou em texto menor
  const quem=t.assignee
    ? `<span class="en-who">${tsAv(t.assignee, tsOnline(t.assignee))}<span class="en-wn">com ${esc(tmName(t.assignee))}</span></span>`
    : `<span class="en-who sem"><span class="en-wn"><b>Sem dono</b><small>criada por ${esc(tmName(t.created_by))}</small></span></span>`;
  const ent=[];
  if(t.pr_url) ent.push(`<button type="button" class="en-chip en-pr" data-enlk="${escA(t.pr_url)}" title="abrir o PR no GitHub">${done?'ver a entrega':trav?'ver o PR':'pronto pra revisar'} ${icEm(IC.extlink)}</button>`);
  const lk=typeof trkCardLink==='function'?trkCardLink(t):null;
  if(lk&&(lk.code||lk.url)) ent.push(lk.url?`<button type="button" class="en-chip" data-enlk="${escA(lk.url)}" title="abrir a issue no painel">${lk.code?`<span class="en-code">${esc(lk.code)}</span>`:'issue'} ${icEm(IC.extlink)}</button>`:`<span class="en-chip en-code" title="issue no painel">${esc(lk.code)}</span>`);
  // a tarefa deste cartão roda NESTA máquina e está pronta pra revisar → "pedir alteração" abre a mesma caixa (71)
  const loc=typeof rqLocalOfCloud==='function'?rqLocalOfCloud(t.id):null;
  if(loc && typeof rqCanAsk==='function' && rqCanAsk(loc)) ent.push(`<button type="button" class="en-chip" data-rqopen="${escA(loc.id)}" title="o agente da tarefa continua na mesma branch">pedir alteração</button>`);
  const np=entProvas.m?(entProvas.m[t.id]||0):null;
  if(np) ent.push(`<button type="button" class="en-chip" data-entct="${escA(t.id)}" title="ver as provas na página da tarefa">${icEm(IC.camera)} ${nPl(np,'prova','provas')}</button>`);
  const rq=entReqs(t);
  if(rq) ent.push(`<span class="en-chip en-rq${rq.ok===rq.tot?' ok':''}" title="requisitos provados">${icEm(IC.check)} ${rq.ok} de ${rq.tot} requisitos</span>`);
  const a=(teamActivity||[]).find(x=>x.task_id===t.id);
  // o verbo do feed sem o complemento ("mudou o status de" → "mudou o status"): a linha já é a tarefa
  const atv=a?`<span class="en-agov">${esc(personShort(a.user_id))} ${esc(String(tsK(a.kind)).replace(/ (de|em)$/,''))}</span><span>${esc(agoTx(a.at))}</span>`:`<span>${esc(agoTx(t.updated_at))}</span>`;
  return `<div class="en-item${trav?' trav':''}${done?' done':''}" role="listitem">
    <div class="en-main"><button type="button" class="en-title" data-entct="${escA(t.id)}" title="abrir a tarefa">${esc(t.title||'tarefa')}</button>
      ${trav?(()=>{ const why=entTravaTx(t)||label; return `<div class="en-why" style="color:${stColor('error')}" title="${escA(why)}">${icEm(IC.warn)} <span class="en-tx"><b>Travada:</b> ${esc(why)}</span></div>`; })():''}</div>
    ${quem}
    <span class="en-st" style="--stc:${cor}"><i aria-hidden="true"></i><span class="en-tx">${esc(label)}</span></span>
    <span class="en-ents">${ent.join('')}</span>
    <span class="en-ago" title="última atividade">${atv}</span>
  </div>`;
}
// a aba: ctx = { all, members, noTitle } vindos do renderTeamBoard (43) ou da Central (71, sem o título — a página já tem)
function entregasHtml(ctx){
  const all=(ctx&&ctx.all)||[], members=(ctx&&ctx.members)||[];
  const f=entFiltros();
  if(f.epic && f.epic!=='-' && !(teamEpics||[]).some(e=>e.id===f.epic)) f.epic='';
  f.who=entWhoValido(f.who, members);
  const vis=entFiltra(all, f, ENT_FN);
  if(all.length) entProvasLoad(all.map(t=>t.id));
  // contagens dos chips = com a pessoa e o épico escolhidos
  const base=entFiltra(all, { who:f.who, epic:f.epic }, ENT_FN);
  const nTrav=base.filter(t=>entTravada(t, ENT_FN)).length, nPront=base.filter(t=>entPronta(t, ENT_FN)).length;
  const eps=teamEpics||[];
  const epA=eps.filter(e=>ENT_FN.ativo(e, all.filter(t=>t.epic_id===e.id))), epD=eps.filter(e=>!epA.includes(e));
  const opt=(v,l,sel)=>`<option value="${escA(v)}"${sel?' selected':''}>${esc(l)}</option>`;
  const bar=`<div class="tssub en-bar">
    <select class="sel" id="enWho" aria-label="filtrar por pessoa" style="width:150px">${opt('','todas as pessoas',!f.who)}${members.map(u=>opt(u, personName(u,{ you:'suffix' }), f.who===u)).join('')}${opt('-','sem dono',f.who==='-')}</select>
    <select class="sel" id="enEpic" aria-label="filtrar por épico" style="width:190px">${opt('','todos os épicos',!f.epic)}${epA.length?`<optgroup label="ativos">${epA.map(e=>opt(e.id, e.name, f.epic===e.id)).join('')}</optgroup>`:''}${epD.length?`<optgroup label="concluídos">${epD.map(e=>opt(e.id, e.name, f.epic===e.id)).join('')}</optgroup>`:''}${opt('-','sem épico',f.epic==='-')}</select>
    <button type="button" class="fchip${f.trav?' on':''}" data-entf="trav" aria-pressed="${f.trav}">só travadas <span class="n">${nTrav}</span></button>
    <button type="button" class="fchip${f.pront?' on':''}" data-entf="pront" aria-pressed="${f.pront}">só prontas pra revisar <span class="n">${nPront}</span></button>
    <span style="flex:1"></span><button type="button" class="btn sm" id="enRefresh">atualizar</button></div>`;
  let body;
  if(!all.length) body=emptyHtml({ icon:'kanban', title:'Nenhuma entrega no time ainda', help:'Quando alguém mandar uma tarefa pro time, ela aparece aqui com quem está, a situação e as provas.' });
  else if(!vis.length) body=emptyHtml({ icon:'search', title:'Nada com esses filtros', help:'Nenhuma tarefa bate com a pessoa, o épico ou a situação escolhida.', action:{ id:'enClear', label:'limpar filtros', primary:false } });
  else { const vc=entPodeVerCusto(); body=entAgrupa(all, vis, eps, ENT_FN).map(g=>entGrupoHtml(g, vc)).join(''); }
  const note=entProvas.err&&entProvas.key&&all.length?'<div class="en-note" role="status">não consegui ler as provas agora — tento de novo</div>':'';
  return `${ctx&&ctx.noTitle?'':'<h1>Entregas</h1>'}${bar}${note}<div class="en-wrap">${body}</div>`;
}
// onChange: quem redesenha depois de mexer num filtro (padrão: o espaço Time)
function entregasWire(el, onChange){
  entOnChange=onChange||null;
  const all=teamTasks||[];
  { const s=el.querySelector('#enWho'); if(s) s.onchange=()=>entSetF({ who:s.value }); }
  { const s=el.querySelector('#enEpic'); if(s) s.onchange=()=>entSetF({ epic:s.value }); }
  el.querySelectorAll('[data-entf]').forEach(b=>{ b.onclick=()=>{ const k=b.dataset.entf; entSetF({ [k]:!entFiltros()[k] }); }; });
  { const b=el.querySelector('#enClear'); if(b) b.onclick=()=>entSetF({ who:'', epic:'', trav:false, pront:false }); }
  { const b=el.querySelector('#enRefresh'); if(b) b.onclick=()=>{ entProvas={ key:'', m:null, busy:false }; teamTasks=null; teamFetchedAt=0; entRepaint(); }; }
  // PR e issue (data-enlk: o wireLinkChips do 43 não sobrescreve): só abre http(s)
  el.querySelectorAll('[data-enlk]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); const u=b.dataset.enlk||''; if(/^https?:\/\//i.test(u)) openExternal(u); }; });
  el.querySelectorAll('[data-entct]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); const ct=all.find(x=>x.id===b.dataset.entct); if(ct) openCloudTaskPage(ct); }; });
  el.querySelectorAll('[data-entep]').forEach(b=>{ b.onclick=()=>{ const ep=(teamEpics||[]).find(x=>x.id===b.dataset.entep); if(ep&&window.openEpicPage) openEpicPage(ep); }; });
}
window.entregasHtml=entregasHtml; window.entregasWire=entregasWire; window.entPodeVerCusto=entPodeVerCusto; window.entAbertas=entAbertas;
