// Starfork — 86-pr-real: o estado REAL do PR de cada tarefa em revisão (28/10, dono: "aprovei, abri o PR e já fiz merge no
// GitHub e ela continua em Precisa de mim pedindo Aprovar — esse check nunca funcionou direito").
// Causa: sem spec.prUrl ninguém procurava o PR (o Aprovar só consultava tarefa COM link; a sondagem da nuvem rodava 1× por
// sessão e só com time), a consulta ia com a conta ATIVA do gh (repo de org de outra conta → "Could not resolve to a
// Repository", engolido) e não havia plano B sem o gh. Agora: pr_sync_task (Rust, pr_real.rs) acha o PR pela branch com a
// conta ligada ao projeto (descobre sozinho, sem `gh auth switch`), grava o link, integra a tarefa pelo caminho único quando
// o PR foi MERGED (ou o git mostra o conteúdo na base) e devolve o motivo quando não deu pra conferir.
// Quando confere: ao abrir o app, ao focar a janela, ao abrir Meu trabalho / Central / Para aprovar, depois das ações de PR
// e a cada 60 s só as tarefas em revisão/PR aberto que já venceram (3 min; 5 min depois de erro) — async, 4 por volta.
// Fontes únicas: integrar = mergePrRun (21) via aprovarTarefa (80); encerrar = encerrarTarefa (80); onda do épico e aviso =
// apDepoisDoMerge (80); "marcar integrada" = mark_task_status merged (o mesmo caminho do menu ⋯).

// @prr-puro-inicio (puro — testado em app/tests/pr-real.test.mjs)
const PRR_ESPERA={ vivo:3*60000, erro:5*60000, foco:30000 };
const PRR_ST=['review','delivered','conflict','needs-you'];
/** Esta tarefa merece conferência do PR? (em revisão/PR aberto; nunca rascunho, rodando ou encerrada) */
function prrCandidata(t){
  if(!t || t.status==='draft' || t.flag==='closed' || ['merged','done','cancelled'].includes(t.status)) return false;
  return PRR_ST.includes(t.status) || !!t.prUrl;
}
/** Já é hora de conferir de novo? r = último resultado { at, state, errKind }. */
function prrDevida(r, now, force){
  if(!r || !r.at) return true;
  if(force) return now-r.at>=PRR_ESPERA.foco; // foco/aba: no máximo a cada 30 s (abrir e fechar abas não martela o gh)
  return now-r.at>=((r.state==='UNKNOWN'||r.errKind)?PRR_ESPERA.erro:PRR_ESPERA.vivo);
}
/** O que as telas fazem com o resultado (PrSync do Rust) → { kind:'merged'|'closed'|'open'|'none'|'unknown', pr, via, aviso } */
function prrDecide(r){
  if(!r) return { kind:'none', pr:0 };
  const st=String(r.state||'').toUpperCase(), pr=+r.number||0;
  if(st==='MERGED') return { kind:'merged', pr, via:r.source==='git'?'git':'gh', why:String(r.reason||'') };
  if(st==='CLOSED') return { kind:'closed', pr };
  if(st==='OPEN') return { kind:'open', pr };
  if(st==='UNKNOWN') return { kind:'unknown', pr, aviso:'não consegui conferir o PR no GitHub ('+(String(r.reason||'').trim()||'motivo desconhecido')+')' };
  return { kind:'none', pr:0 };
}
/** A frase do "Precisa de mim" pra um PR que não pede mais "Aprovar" (tt = título já em HTML). null = segue o fluxo normal. */
function prrFrase(d, tt){
  if(!d) return null;
  if(d.kind==='closed') return `O PR${d.pr?' #'+d.pr:''} de ${tt} foi <b>fechado sem integrar</b>.`;
  if(d.kind==='open') return `PR${d.pr?' #'+d.pr:''} de ${tt} aberto — falta integrar.`;
  return null;
}
// @prr-puro-fim

const PRR={ r:{}, busy:{}, soon:0, aba:'' };
function prrDe(id){ return PRR.r[id]||null; }
function prrVis(id){ return prrDecide(prrDe(id)); }
function prrRepinta(){
  try{ if(typeof apRefresh==='function') apRefresh(); }catch(_){ }
  try{ if(typeof semRepintar==='function') semRepintar(); }catch(_){ }
}
/** Confere o PR de UMA tarefa agora. o.force fura o recuo da descoberta de conta. → o resultado (PrSync) */
async function prrConferir(taskId, o){
  o=o||{};
  if(PRR.busy[taskId]) return PRR.busy[taskId];
  const t0=((typeof state!=='undefined'&&state.tasks)||[]).find(x=>x.id===taskId); if(!t0) return null;
  const aberta=!(typeof taskEncerrada==='function'?taskEncerrada(t0):['merged','done','cancelled'].includes(t0.status)), tinhaPr=!!t0.prUrl;
  PRR.busy[taskId]=(async()=>{
    let r;
    try{ r=await invokeQuiet('pr_sync_task',{ taskId, base:(typeof conflitoBase==='function'?conflitoBase(t0):null), force:!!o.force }); }
    catch(e){ r={ state:'UNKNOWN', source:'none', errKind:'other', reason:(typeof humanErr==='function'?humanErr(e, 'erro ao conferir').msg:String(e&&e.message||e)) }; }
    r=Object.assign({}, r||{}, { at:Date.now() });
    PRR.r[taskId]=r;
    const d=prrDecide(r);
    // o estado da tarefa mudou no banco (integrada, link do PR gravado — ou desfeito por ser de outra branch): recarrega
    if((d.kind==='merged' && aberta) || (r.url && !tinhaPr) || (tinhaPr && !r.url && r.source==='gh')){
      if(typeof prCache!=='undefined') prCache[taskId]=undefined;
      try{ lastSig=''; if(typeof refresh==='function') await refresh(); }catch(_){ }
      const t1=((typeof state!=='undefined'&&state.tasks)||[]).find(x=>x.id===taskId);
      if(d.kind==='merged' && aberta && t1 && t1.status==='merged' && typeof apDepoisDoMerge==='function') apDepoisDoMerge(taskId, d.pr||'');
    }
    prrRepinta();
    return r;
  })();
  try{ return await PRR.busy[taskId]; } finally{ delete PRR.busy[taskId]; }
}
window.prrConferir=prrConferir;
/** Uma volta: as tarefas candidatas que venceram (as do "Precisa de mim" primeiro), até 4 por vez, uma de cada vez. */
async function prrTick(motivo){
  if(typeof state==='undefined' || !state.repo) return;
  const now=Date.now(), force=!!motivo && motivo!=='tick';
  const L=(state.tasks||[]).filter(prrCandidata).filter(t=>!PRR.busy[t.id] && prrDevida(PRR.r[t.id], now, force))
    .sort((a,b)=>(+b.finishedAt||+b.createdAt||0)-(+a.finishedAt||+a.createdAt||0));
  for(const t of L.slice(0,4)) await prrConferir(t.id).catch(()=>{});
}
function prrSoon(motivo){ clearTimeout(PRR.soon); PRR.soon=setTimeout(()=>{ prrTick(motivo||'acao').catch(()=>{}); }, 400); }
window.prrSoon=prrSoon;
if(typeof tickLoop==='function') tickLoop('prrTick', ()=>prrTick('tick'), 60000, 3000, { local:true }); // abrir o app: 3 s depois
window.addEventListener('focus', ()=>prrSoon('foco'));
// abrir Meu trabalho / Central / Para aprovar confere na hora (só as vencidas há 30 s+)
setInterval(()=>{
  let k=''; try{ const tb=(typeof tabById==='function'&&typeof activeTab!=='undefined')?tabById(activeTab):null; k=(tb&&tb.kind)||(typeof activeTab!=='undefined'?String(activeTab):''); }catch(_){ k=''; }
  if(k===PRR.aba) return; PRR.aba=k;
  if(['meu','flow','aprovar'].includes(k)) prrSoon('aba');
}, 1500);

// ---------------------------------------------------------------- ações (Precisa de mim, painel, menu ⋯)
/** "Já integrei / colar link do PR": com link → grava e confere; sem link → marca integrada (o mesmo do menu ⋯). */
async function prrJaIntegrei(taskId, anchor){
  const t=((typeof state!=='undefined'&&state.tasks)||[]).find(x=>x.id===taskId); if(!t) return false;
  const r=typeof sheetAsk==='function'
    ? await sheetAsk({ title:'Já integrou esta tarefa?', text:'Cole o link do PR que você abriu (ou integrou) no GitHub e eu confiro agora. Sem link, ela fica marcada como integrada.', field:{ placeholder:'https://github.com/dono/repo/pull/12' }, allowEmpty:true, ok:'Conferir', anchor:anchor||null })
    : (await askYes('Marcar esta tarefa como integrada (merge feito no GitHub)?', 'Já integrei') ? '' : null);
  if(r==null || r===false) return false;
  const link=String(r||'').trim();
  if(link){
    try{ await invoke('pr_link_task',{ taskId, url:link }); }
    catch(e){ showErr(e, 'Esse link não serve'); return false; }
    const res=await prrConferir(taskId, { force:true }); const d=prrDecide(res);
    if(d.kind==='merged') return true; // apDepoisDoMerge já avisou
    if(d.kind==='open') toast(`PR #${d.pr||'?'} ligado à tarefa — ainda aberto: falta integrar.`, 'info');
    else if(d.kind==='closed') toast(`PR #${d.pr||'?'} ligado — está fechado sem integrar.`, 'warn');
    else if(d.kind==='unknown') toast('Link gravado, mas '+d.aviso+'.', 'warn');
    lastSig=''; if(typeof refresh==='function') await refresh().catch(()=>{});
    return true;
  }
  if(!await askYes('Marcar como integrada sem conferir no GitHub? Ela sai de "Precisa de mim" e conta em Entregas.', 'Marcar como integrada')) return false;
  try{ await invoke('mark_task_status',{ taskId, status:'merged' }); }
  catch(e){ showErr(e, 'Não consegui marcar como integrada'); return false; }
  lastSig=''; if(typeof refresh==='function') await refresh().catch(()=>{});
  if(typeof apDepoisDoMerge==='function') apDepoisDoMerge(taskId, ''); else toast('Marcada como integrada.', 'ok');
  prrRepinta();
  return true;
}
window.prrJaIntegrei=prrJaIntegrei;
async function prrReabrir(taskId){
  try{ const m=await invoke('reopen_pr',{ taskId }); toast(m||'PR reaberto', 'ok'); }
  catch(e){ showErr(e, 'Não consegui reabrir o PR'); return false; }
  if(typeof prCache!=='undefined') prCache[taskId]=undefined;
  await prrConferir(taskId, { force:true });
  return true;
}
window.prrReabrir=prrReabrir;
/** Conferir de novo (botão do aviso): fura o recuo da descoberta de conta. */
async function prrDeNovo(taskId){
  const r=await prrConferir(taskId, { force:true }); const d=prrDecide(r);
  if(d.kind==='unknown') toast(d.aviso.charAt(0).toUpperCase()+d.aviso.slice(1)+'.', 'warn');
  else if(d.kind==='none') toast('Conferido: ainda não há PR desta branch no GitHub.', 'info');
  else if(d.kind==='open') toast(`Conferido: PR #${d.pr} aberto — falta integrar.`, 'info');
  else if(d.kind==='closed') toast(`Conferido: PR #${d.pr} fechado sem integrar.`, 'warn');
  return r;
}
window.prrDeNovo=prrDeNovo;
/** Linha discreta "não consegui conferir…" com as duas saídas (painel de provas e aba da tarefa). '' quando não há aviso. */
function prrAvisoHtml(taskId){
  const d=prrVis(taskId); if(d.kind!=='unknown') return '';
  return `<div class="prr-aviso" role="status">${typeof apIc==='function'?apIc('alert'):''}<span>${esc(d.aviso.charAt(0).toUpperCase()+d.aviso.slice(1))}.</span>`
    +`<button type="button" class="lnk" data-prr="denovo" data-id="${escA(taskId)}">Conferir de novo</button>`
    +`<button type="button" class="lnk" data-prr="ja" data-id="${escA(taskId)}">Já integrei</button></div>`;
}
window.prrAvisoHtml=prrAvisoHtml;
document.addEventListener('click', e=>{
  const b=e.target.closest && e.target.closest('[data-prr]'); if(!b) return;
  e.preventDefault(); e.stopPropagation();
  const id=b.dataset.id, k=b.dataset.prr;
  if(k==='denovo'){ b.disabled=true; b.textContent='conferindo…'; prrDeNovo(id).finally(()=>prrRepinta()); }
  else if(k==='ja') prrJaIntegrei(id, b);
});
/** "Precisa de mim" (76): PR fechado sem integrar → frase própria com Reabrir / Encerrar. null = não é o caso. */
function prrEventoFechado(x, meta){
  const t=x&&x.local; if(!t || !prrCandidata(t)) return null;
  const d=prrVis(t.id); if(d.kind!=='closed') return null;
  const tt=`<span class="tt">${esc(typeof mdTitle==='function'?mdTitle(t.title||''):String(t.title||''))}</span>`;
  return { ms:x.mod, av:'ia', s:prrFrase(d, tt), m:meta, tid:t.id,
    a:[{ l:'Reabrir o PR', pri:true, act:()=>prrReabrir(t.id) },
       { l:'Encerrar…', act:(b)=>typeof encerrarTarefa==='function'?encerrarTarefa(t.id, { anchor:b }):null },
       { l:'Já integrei', q:true, act:(b)=>prrJaIntegrei(t.id, b) }] };
}
window.prrEventoFechado=prrEventoFechado;
