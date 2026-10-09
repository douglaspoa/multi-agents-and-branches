// Starfork — 70-time-entregas: aba ENTREGAS do espaço Time (visão do gestor · decisão T7/T8/T9 da mesa 09/10)
// UMA lista agrupada por épico (ativos primeiro, "Sem épico" no fim) — sem gráfico nem KPI novo. Por épico: x de y
// entregues (regra única epDelivered), prontas pra revisar, travadas, pessoas e o "pronto quando" provado (linhaModelo
// do 69). Por item: título, com quem (ou "Sem dono"), situação (STATUS_META via stLabel/ctStLabel), entregáveis
// (pronto pra revisar ↗, issue, provas publicadas, requisitos "3 de 5"), última atividade e o motivo da trava.
// Custo (T8): só líder do time ou owner/admin da org vê — e só somado por épico. Membro não vê custo nesta aba.
// Dados: teamTasks/teamEpics/teamActivity/teamProfiles (teamFetch) — sem laço novo. As provas (artifacts_meta) vêm
// em LOTE quando a aba abre e ficam em cache pelo conjunto de tarefas (sem polling).

// @puro-entregas-inicio (testado em app/tests/time-entregas.test.mjs)
// fn = { bucket(t) → etapa da Central (flowBucket), delivered(t) → epDelivered, who(t) → tsWho, ativo(ep, tasks) → epAtivo }
// travada = etapa "aguardando" (erro, conflito, pergunta, plano pra aprovar) ou cartão bloqueado
function entTravada(t, fn){ return !!t && (t.flag==='blocked' || fn.bucket(t)==='aguardando'); }
// pronta pra revisar = ainda não entregue e na etapa "prontas" ou "PR aberto" da Central
function entPronta(t, fn){ return !!t && !fn.delivered(t) && !entTravada(t, fn) && ['prontas','praberto'].includes(fn.bucket(t)); }
// cancelada/encerrada sem entrega: fora da conta de "x de y"
function entFora(t, fn){ return !!t && !fn.delivered(t) && (t.status==='cancelled' || t.flag==='closed'); }
// requisitos provados: a MESMA leitura do tsCardHtml (requirements_proof.list ou a própria lista; status 'done')
function entReqs(t){
  const rp=t&&t.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  if(!list||!list.length) return null;
  return { ok:list.filter(x=>x&&x.status==='done').length, tot:list.length };
}
// motivo da trava numa frase: a última nota (1ª frase, curta) ou o rótulo da situação
function entMotivo(t, label){
  const n=String((t&&t.last_note)||'').replace(/\s+/g,' ').trim();
  if(!n) return label||'';
  const s=(n.match(/^.*?[.!?](\s|$)/)||[n])[0].trim();
  return s.length>90?s.slice(0,89).trimEnd()+'…':s;
}
// ordem dentro do grupo: o que pede o gestor primeiro (travada, pronta), depois andando, fila e entregues; recente antes
function entPeso(t, fn){
  if(entTravada(t, fn)) return 0;
  if(entPronta(t, fn)) return 1;
  if(fn.delivered(t)) return 4;
  if(entFora(t, fn)) return 5;
  return ['fila','rascunho'].includes(fn.bucket(t))?3:2;
}
// filtros: f = { who:'' | uid | '-' (sem dono), epic:'' | id | '-' (sem épico), trav:bool, pront:bool }
function entFiltra(tasks, f, fn){
  f=f||{};
  return (tasks||[]).filter(t=>{
    if(f.who==='-'){ if(t.assignee) return false; }
    else if(f.who && fn.who(t)!==f.who) return false;
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
  const pessoas=[...new Set(ts.map(fn.who).filter(Boolean))];
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
    if(itens.length) out.push({ ep:x.e, id:x.e.id, nome:x.e.name||'Épico', ativo:x.ativo, itens, ...entNums(x.ts, fn) });
  }
  // sem épico (ou épico que não veio — arquivado/sem acesso): grupo do fim
  const solto=(vis||[]).filter(t=>!t.epic_id || !seen.has(t.epic_id)).sort(ord);
  if(solto.length) out.push({ ep:null, id:'-', nome:'Sem épico', ativo:true, itens:solto, ...entNums((all||[]).filter(t=>!t.epic_id || !seen.has(t.epic_id)), fn) });
  return out;
}
// T8: custo nesta aba só pra líder de um dos times em vista ou owner/admin da org
function entVeCusto(me, teamIds, teamMembers, meRole){
  if(meRole==='owner' || meRole==='admin') return true;
  if(!me) return false;
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

const ENT_FN={ bucket:t=>tsBucket(t), delivered:t=>epDelivered(t), who:t=>tsWho(t),
  ativo:(e, ts)=>typeof epAtivo==='function'?epAtivo(e, ts):(e.status!=='done'&&e.status!=='archived') };
function entFiltros(){ return entFiltrosDe(lsGet('tmEntF'), { who:lsGet('tmDev')||'', epic:lsGet('tmEpic')||'' }); }
function entSetF(patch){ lsSet('tmEntF', JSON.stringify({ ...entFiltros(), ...patch })); teamPaintSig=''; renderTeamBoard(); }
// usado também pela Visão geral/Pessoas (43): custo por pessoa só pra quem pode ver
function entPodeVerCusto(){
  return entVeCusto(cloudUserId(), (typeof tsScopeTeamIds==='function')?tsScopeTeamIds():[cloudTeamId()],
    (cloudData&&cloudData.teamMembers)||{}, cloudData&&cloudData.meRole);
}
// número da aba: o que ainda não foi entregue (nem cancelado)
function entAbertas(all){ return (all||[]).filter(t=>!ENT_FN.delivered(t) && !entFora(t, ENT_FN)).length; }

// ---- provas publicadas: UM lote por conjunto de tarefas, quando a aba está aberta ----
let entProvas={ key:'', m:null, busy:false };
function entProvasLoad(ids){
  const key=ids.slice().sort().join(',');
  if(entProvas.key===key && (entProvas.m || entProvas.busy)) return;
  entProvas={ key, m:null, busy:true };
  const chunks=[]; for(let i=0;i<ids.length;i+=80) chunks.push(ids.slice(i, i+80));
  Promise.all(chunks.map(c=>sbGet('artifacts_meta?select=task_id,name,kind,storage_path&task_id=in.('+c.map(i=>'"'+i+'"').join(',')+')')))
    .then(rs=>{ if(entProvas.key!==key) return; entProvas={ key, m:entProvasPorTarefa([].concat(...rs)), busy:false }; if(tmView==='entregas'){ teamPaintSig=''; renderTeamBoard(); } })
    .catch(e=>{ if(entProvas.key===key) entProvas={ key, m:{}, busy:false, err:true }; console.warn('provas do time', e&&e.message||e); });
}

function entAvatares(uids){
  const max=5, v=uids.slice(0, max);
  return `<span class="en-avs" aria-label="${escA('pessoas: '+uids.map(tmName).join(', '))}">${v.map(u=>tsAv(u, false)).join('')}${uids.length>max?`<span class="en-avmore">+${uids.length-max}</span>`:''}</span>`;
}
function entProntoQuando(g){
  if(!g.ep || typeof linhaModelo!=='function') return '';
  const m=linhaModelo(g.ep, (teamTasks||[]).filter(t=>t.epic_id===g.id));
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
  const fn=ENT_FN, trav=entTravada(t, fn), done=fn.delivered(t);
  const st=t.flag==='blocked'?'blocked':tsSt(t);
  const waiting=!trav && typeof ctWaiting==='function' && ctWaiting(t);
  const label=t.flag==='blocked'?stLabel('blocked'):(typeof ctStLabel==='function'?ctStLabel(t):stLabel(st));
  const cor=waiting?'var(--muted)':stColor(st);
  // com quem: o responsável; sem responsável, "Sem dono" e quem criou em texto menor
  const quem=t.assignee
    ? `<span class="en-who">${tsAv(t.assignee, tsOnline(t.assignee))}<span class="en-wn">com ${esc(tmName(t.assignee))}</span></span>`
    : `<span class="en-who sem"><span class="en-wn"><b>Sem dono</b><small>criada por ${esc(tmName(t.created_by))}</small></span></span>`;
  const ent=[];
  if(t.pr_url) ent.push(`<button type="button" class="en-chip en-pr" data-lk="${escA(t.pr_url)}" title="abrir o PR no GitHub">${done?'ver a entrega':'pronto pra revisar'} ${icEm(IC.extlink)}</button>`);
  const lk=typeof trkCardLink==='function'?trkCardLink(t):null;
  if(lk&&(lk.code||lk.url)) ent.push(lk.url?`<button type="button" class="en-chip" data-lk="${escA(lk.url)}" title="abrir a issue no painel">${lk.code?`<span class="en-code">${esc(lk.code)}</span>`:'issue'} ${icEm(IC.extlink)}</button>`:`<span class="en-chip en-code" title="issue no painel">${esc(lk.code)}</span>`);
  const np=entProvas.m?(entProvas.m[t.id]||0):null;
  if(np) ent.push(`<button type="button" class="en-chip" data-entct="${escA(t.id)}" title="ver as provas na página da tarefa">${icEm(IC.camera)} ${nPl(np,'prova','provas')}</button>`);
  const rq=entReqs(t);
  if(rq) ent.push(`<span class="en-chip en-rq${rq.ok===rq.tot?' ok':''}" title="requisitos provados">${icEm(IC.check)} ${rq.ok} de ${rq.tot} requisitos</span>`);
  const a=(teamActivity||[]).find(x=>x.task_id===t.id);
  // o verbo do feed sem o complemento ("mudou o status de" → "mudou o status"): a linha já é a tarefa
  const atv=a?`<span class="en-agov">${esc(tmName(a.user_id).split(' ')[0])} ${esc(String(tsK(a.kind)).replace(/ (de|em)$/,''))}</span><span>${esc(agoTx(a.at))}</span>`:`<span>${esc(agoTx(t.updated_at))}</span>`;
  return `<div class="en-item${trav?' trav':''}${done?' done':''}" role="listitem">
    <div class="en-main"><button type="button" class="en-title" data-entct="${escA(t.id)}" title="abrir a tarefa">${esc(t.title||'tarefa')}</button>
      ${trav?`<div class="en-why" style="color:${stColor(st)}" title="${escA(String(t.last_note||label))}">${icEm(IC.warn)} <b>Travada:</b> ${esc(entMotivo(t, label))}</div>`:''}</div>
    ${quem}
    <span class="en-st" style="--stc:${cor}"><i aria-hidden="true"></i>${esc(label)}</span>
    <span class="en-ents">${ent.join('')}</span>
    <span class="en-ago" title="última atividade">${atv}</span>
  </div>`;
}
// a aba: ctx = { all, members } vindos do renderTeamBoard (43)
function entregasHtml(ctx){
  const all=(ctx&&ctx.all)||[], members=(ctx&&ctx.members)||[];
  const f=entFiltros();
  if(f.epic && f.epic!=='-' && !(teamEpics||[]).some(e=>e.id===f.epic)) f.epic='';
  const vis=entFiltra(all, f, ENT_FN);
  if(all.length) entProvasLoad(all.map(t=>t.id));
  const nTrav=all.filter(t=>entTravada(t, ENT_FN)).length, nPront=all.filter(t=>entPronta(t, ENT_FN)).length;
  const eps=teamEpics||[];
  const epA=eps.filter(e=>ENT_FN.ativo(e, all.filter(t=>t.epic_id===e.id))), epD=eps.filter(e=>!epA.includes(e));
  const opt=(v,l,sel)=>`<option value="${escA(v)}"${sel?' selected':''}>${esc(l)}</option>`;
  const bar=`<div class="tssub en-bar">
    <select class="sel" id="enWho" aria-label="filtrar por pessoa" style="width:150px">${opt('','todas as pessoas',!f.who)}${members.map(u=>opt(u, tmName(u), f.who===u)).join('')}${opt('-','sem dono',f.who==='-')}</select>
    <select class="sel" id="enEpic" aria-label="filtrar por épico" style="width:190px">${opt('','todos os épicos',!f.epic)}${epA.length?`<optgroup label="ativos">${epA.map(e=>opt(e.id, e.name, f.epic===e.id)).join('')}</optgroup>`:''}${epD.length?`<optgroup label="concluídos">${epD.map(e=>opt(e.id, e.name, f.epic===e.id)).join('')}</optgroup>`:''}${opt('-','sem épico',f.epic==='-')}</select>
    <button type="button" class="fchip${f.trav?' on':''}" data-entf="trav" aria-pressed="${f.trav}">só travadas <span class="n">${nTrav}</span></button>
    <button type="button" class="fchip${f.pront?' on':''}" data-entf="pront" aria-pressed="${f.pront}">só prontas pra revisar <span class="n">${nPront}</span></button>
    <span style="flex:1"></span><button type="button" class="btn sm" id="enRefresh">atualizar</button></div>`;
  let body;
  if(!all.length) body=emptyHtml({ icon:'kanban', title:'Nenhuma entrega no time ainda', help:'Quando alguém mandar uma tarefa pro time, ela aparece aqui com quem está, a situação e as provas.' });
  else if(!vis.length) body=emptyHtml({ icon:'search', title:'Nada com esses filtros', help:'Nenhuma tarefa bate com a pessoa, o épico ou a situação escolhida.', action:{ id:'enClear', label:'limpar filtros', primary:false } });
  else { const vc=entPodeVerCusto(); body=entAgrupa(all, vis, eps, ENT_FN).map(g=>entGrupoHtml(g, vc)).join(''); }
  return `<h1>Entregas</h1>${bar}<div class="en-wrap">${body}</div>`;
}
function entregasWire(el){
  const all=teamTasks||[];
  { const s=el.querySelector('#enWho'); if(s) s.onchange=()=>entSetF({ who:s.value }); }
  { const s=el.querySelector('#enEpic'); if(s) s.onchange=()=>entSetF({ epic:s.value }); }
  el.querySelectorAll('[data-entf]').forEach(b=>{ b.onclick=()=>{ const k=b.dataset.entf; entSetF({ [k]:!entFiltros()[k] }); }; });
  { const b=el.querySelector('#enClear'); if(b) b.onclick=()=>entSetF({ who:'', epic:'', trav:false, pront:false }); }
  { const b=el.querySelector('#enRefresh'); if(b) b.onclick=()=>{ entProvas={ key:'', m:null, busy:false }; teamTasks=null; teamPaintSig=''; renderTeamBoard(); }; }
  el.querySelectorAll('[data-entct]').forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); const ct=all.find(x=>x.id===b.dataset.entct); if(ct) openCloudTaskPage(ct); }; });
  el.querySelectorAll('[data-entep]').forEach(b=>{ b.onclick=()=>{ const ep=(teamEpics||[]).find(x=>x.id===b.dataset.entep); if(ep&&window.openEpicPage) openEpicPage(ep); }; });
}
window.entregasHtml=entregasHtml; window.entregasWire=entregasWire; window.entPodeVerCusto=entPodeVerCusto; window.entAbertas=entAbertas;
